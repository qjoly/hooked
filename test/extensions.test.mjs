/*
 * The extension registry at runtime (server/extensions.js): the fixture `hello` (no page) is
 * installed from a local git repo into a temporary HOOKED_EXTENSIONS_DIR, loaded into a running
 * registry, updated and removed, with no restart. Also the manifest / import checks, the route
 * dispatcher and the declarative settings.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-ext-'));
const DATA = path.join(TMP, 'data');
const INSTALLED = path.join(TMP, 'installed');
const BUNDLED = path.join(TMP, 'bundled');
const REPO = path.join(TMP, 'repo');
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'extensions', 'hello');
process.env.HOOKED_DATA_DIR = DATA;
process.env.HOOKED_EXTENSIONS_DIR = INSTALLED;
process.env.HOOKED_BUNDLED_EXTENSIONS_DIR = BUNDLED;
for (const d of [DATA, INSTALLED, BUNDLED]) fs.mkdirSync(d, { recursive: true });

const ext = await import('../server/extensions.js');
const { emitExtensionEvent } = await import('../server/extensionEvents.js');
const { writeSettings, readSettings } = await import('../server/settings.js');
const probe = () => globalThis[Symbol.for('hooked.test.hello')] || {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...args) => execFileSync('git', args, { cwd: REPO, stdio: 'pipe' }).toString().trim();
const call = (id, rest, method = 'GET', body) => ext.dispatchExtensionRoute(id, rest, new Request(`http://x/api/${id}/${rest}`, { method, body: body && JSON.stringify(body) }));

// What the launcher's Fetch + Place steps do: clone the ref, copy the extension next to the live one, swap.
function installFromGit(id) {
  const clone = path.join(TMP, 'clone-' + Date.now());
  execFileSync('git', ['clone', '--quiet', '--depth', '1', 'file://' + REPO, clone]);
  const next = path.join(INSTALLED, id + '.next');
  fs.cpSync(clone, next, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
  fs.writeFileSync(path.join(next, '.origin.json'), JSON.stringify({ repo: REPO, ref: 'main', path: '.', commit: git('rev-parse', 'HEAD') }));
  const live = path.join(INSTALLED, id);
  if (fs.existsSync(live)) fs.renameSync(live, live + '.prev');
  fs.renameSync(next, live);
  fs.rmSync(live + '.prev', { recursive: true, force: true });
}

beforeAll(async () => {
  fs.cpSync(FIXTURE, REPO, { recursive: true });
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: REPO });
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'hello v1');
  await ext.bootExtensions({ service: true });
});
afterAll(async () => {
  fs.rmSync(path.join(INSTALLED, 'hello'), { recursive: true, force: true });
  await ext.reloadExtension('hello');
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('installing, updating and removing an extension without a restart', () => {
  it('starts empty, and lists a folder placed by hand as pending', async () => {
    expect(ext.listExtensions().extensions).toEqual([]);
    fs.mkdirSync(path.join(INSTALLED, 'hello'));
    fs.writeFileSync(path.join(INSTALLED, 'hello', 'extension.json'), '{}');
    expect(ext.listExtensions().pending).toEqual([expect.objectContaining({ id: 'hello', state: 'on disk, not loaded yet' })]);
    fs.rmSync(path.join(INSTALLED, 'hello'), { recursive: true });
  });

  it('installs from git and registers every contribution', async () => {
    installFromGit('hello');
    expect(await ext.reloadExtension('hello')).toEqual({ id: 'hello', state: 'loaded' });
    const [hello] = ext.listExtensions().extensions;
    expect(hello).toMatchObject({
      id: 'hello', source: 'installed', active: true, errors: [], tools: ['hello_count'], page: null,
      sessionMenu: [expect.objectContaining({ id: 'say-hello', post: 'say-hello' })],
      settings: [expect.objectContaining({ key: 'loud', type: 'bool' }), expect.objectContaining({ key: 'name', type: 'string' })],
      origin: expect.objectContaining({ commit: expect.stringMatching(/^[0-9a-f]{40}$/) }),
    });
    expect(ext.extensionToolFiles()).toEqual([{ id: 'hello', order: 1000, file: expect.stringContaining(path.join('extension-cache', 'hello')) }]);

    emitExtensionEvent('turn:end', { sessionId: 's1' });
    emitExtensionEvent('turn:end', { sessionId: 's1' });
    await sleep(10);
    expect(await (await call('hello', 'count')).json()).toMatchObject({ turns: 2, version: 1 });

    expect(await (await call('hello', 'say-hello', 'POST')).json()).toEqual({ flash: 'Hello, world!' });
    expect(ext.saveExtensionSettings('hello', { loud: 'yes' })).toEqual({ errors: { loud: 'must be true or false' } });
    expect(ext.saveExtensionSettings('hello', { loud: true, name: 'hooked', bogus: 1 })).toEqual({ values: { loud: true, name: 'hooked' } });
    expect(fs.statSync(path.join(DATA, 'extension-settings', 'hello.json')).mode & 0o777).toBe(0o600);
    expect(await (await call('hello', 'say-hello', 'POST')).json()).toEqual({ flash: 'HELLO, HOOKED!' });

    await sleep(80);
    expect(probe()[1]).toBeGreaterThan(0);
  });

  it('an update stops the old instance (its timer included) and starts the new one', async () => {
    const stateFile = path.join(REPO, 'server', 'state.js');
    fs.writeFileSync(stateFile, fs.readFileSync(stateFile, 'utf8').replace('VERSION = 1', 'VERSION = 2'));
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-am', 'hello v2');
    installFromGit('hello');
    expect(ext.listExtensions().pending).toEqual([expect.objectContaining({ id: 'hello', state: 'changed on disk, not reloaded yet' })]);

    expect(await ext.reloadExtension('hello')).toEqual({ id: 'hello', state: 'loaded' });
    const v1 = probe()[1];
    await sleep(80);
    expect(probe()[1]).toBe(v1);
    expect(probe()[2]).toBeGreaterThan(0);
    // The relative import changed too: the whole module graph is the new version's.
    expect(await (await call('hello', 'count')).json()).toMatchObject({ turns: 0, version: 2 });
    expect(await ext.reloadExtension('hello')).toEqual({ id: 'hello', state: 'unchanged' });
  });

  it('switching off gates the routes and stops the lifecycle, switching on starts it again', async () => {
    ext.applyExtensionSettings(writeSettings({ extensions: { hello: false } }));
    expect(readSettings().modules.hello).toBe(false); // mirrored for Android
    const r = await call('hello', 'count');
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ code: 'extension_off' });
    const v2 = probe()[2];
    await sleep(60);
    expect(probe()[2]).toBe(v2);
    ext.applyExtensionSettings(writeSettings({ modules: { hello: true } }));
    expect(ext.listExtensions().extensions[0]).toMatchObject({ enabled: true, active: true });
    expect((await call('hello', 'count')).status).toBe(200);
  });

  it('uninstalling removes everything it registered and keeps its settings file', async () => {
    fs.rmSync(path.join(INSTALLED, 'hello'), { recursive: true });
    expect(await ext.reloadExtension('hello')).toEqual({ id: 'hello', state: 'removed' });
    const v2 = probe()[2];
    await sleep(60);
    expect(probe()[2]).toBe(v2);
    expect(ext.listExtensions().extensions).toEqual([]);
    expect(await call('hello', 'count')).toBeNull();
    expect(ext.extensionToolFiles()).toEqual([]);
    expect(fs.existsSync(path.join(DATA, 'extension-settings', 'hello.json'))).toBe(true);
  });

  it('reinstalling the same version starts from a fresh module state', async () => {
    installFromGit('hello');
    await ext.reloadExtension('hello');
    emitExtensionEvent('turn:end', { sessionId: 's1' });
    await sleep(10);
    expect(await (await call('hello', 'count')).json()).toMatchObject({ turns: 1, version: 2 });
    fs.rmSync(path.join(INSTALLED, 'hello'), { recursive: true });
    await ext.reloadExtension('hello');
    installFromGit('hello');
    expect(await ext.reloadExtension('hello')).toEqual({ id: 'hello', state: 'loaded' });
    expect(await (await call('hello', 'count')).json()).toMatchObject({ turns: 0, version: 2 });
    fs.rmSync(path.join(INSTALLED, 'hello'), { recursive: true });
    await ext.reloadExtension('hello');
  });
});

describe('what the registry refuses', () => {
  const place = (id, files) => {
    const dir = path.join(INSTALLED, id);
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content));
    }
    return dir;
  };
  const manifest = (id, extra = {}) => ({ id, label: id, api: 1, ...extra });
  const rejection = (id) => ext.listExtensions().rejected.find((r) => r.id === id)?.error;

  it.each([
    ['bad-api', { 'extension.json': manifest('bad-api', { api: 2 }) }, 'api 2, hooked offers 1'],
    ['bad-page', { 'extension.json': manifest('bad-page', { page: { key: 'settings' } }) }, 'is a core page'],
    ['bad-id', { 'extension.json': manifest('other') }, 'differs from its folder'],
    ['bad-import', { 'extension.json': manifest('bad-import'), 'server/index.js': "import x from '#server/agent.js';" }, 'import not allowed (#server/agent.js)'],
    ['bad-escape', { 'extension.json': manifest('bad-escape'), 'api.js': "import x from '../../secret.js';" }, 'leaves the extension folder'],
    ['bad-npm', { 'extension.json': manifest('bad-npm'), 'tools.cjs': "require('lodash')" }, 'import not allowed (lodash)'],
    ['bad-page-import', { 'extension.json': manifest('bad-page-import'), 'ui/Page.svelte': "<script>import x from '#lib/state.svelte.js';</script>" }, 'import not allowed'],
  ])('%s', async (id, files, error) => {
    place(id, files);
    expect(await ext.reloadExtension(id)).toEqual({ id, state: 'rejected' });
    expect(rejection(id)).toContain(error);
    fs.rmSync(path.join(INSTALLED, id), { recursive: true });
    await ext.reloadExtension(id);
    expect(rejection(id)).toBeUndefined();
  });

  it('a lifecycle that throws is reported, and the others keep running', async () => {
    place('boom', { 'extension.json': manifest('boom'), 'server/index.js': 'export default { start() { throw new Error("kaboom"); } };' });
    await ext.reloadExtension('boom');
    expect(ext.listExtensions().extensions.find((e) => e.id === 'boom')).toMatchObject({ active: false, errors: ['start: kaboom'] });
    fs.rmSync(path.join(INSTALLED, 'boom'), { recursive: true });
    await ext.reloadExtension('boom');
  });

  it('a handler that throws answers 500, an unknown route 404, a missing method 405', async () => {
    place('routes', { 'extension.json': manifest('routes'), 'api.js': 'export default () => ({ a: { GET() { throw new Error("nope"); } } });' });
    await ext.reloadExtension('routes');
    expect((await call('routes', 'a')).status).toBe(500);
    expect((await call('routes', 'b')).status).toBe(404);
    expect((await call('routes', 'a', 'POST')).status).toBe(405);
    fs.rmSync(path.join(INSTALLED, 'routes'), { recursive: true });
    await ext.reloadExtension('routes');
  });

  it('a bundled extension wins over an installed one with the same id', async () => {
    fs.mkdirSync(path.join(BUNDLED, 'twin'), { recursive: true });
    fs.writeFileSync(path.join(BUNDLED, 'twin', 'extension.json'), JSON.stringify(manifest('twin')));
    place('twin', { 'extension.json': manifest('twin') });
    await ext.reloadExtension('twin');
    expect(ext.listExtensions().extensions.find((e) => e.id === 'twin')).toMatchObject({ source: 'bundled' });
    expect(rejection('twin')).toContain('duplicate id');
    fs.rmSync(path.join(BUNDLED, 'twin'), { recursive: true });
    fs.rmSync(path.join(INSTALLED, 'twin'), { recursive: true });
    await ext.reloadExtension('twin');
  });
});

describe('settings migration', () => {
  it('a settings file from before extensions keeps its switches, and Android still reads modules', async () => {
    const { SETTINGS_FILE } = await import('../server/settings.js');
    const before = fs.readFileSync(SETTINGS_FILE, 'utf8');
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ modules: { github: false, cron: true, 'Bad Id': false } }));
    expect(readSettings()).toMatchObject({ extensions: { github: false, cron: true }, modules: { github: false, cron: true } });
    expect(readSettings().extensions).not.toHaveProperty('Bad Id');
    // The dashboard writes `extensions`, which wins over a stale `modules` in the same patch.
    expect(writeSettings({ modules: { github: false }, extensions: { github: true } }).extensions.github).toBe(true);
    fs.writeFileSync(SETTINGS_FILE, before);
  });
});
