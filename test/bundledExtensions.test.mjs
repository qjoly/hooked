/*
 * The extensions bundled with hooked (extensions/*): what makes a folder valid, the shims a legacy
 * extension still needs, the tools the MCP server serves, the registry's handling of legacy
 * lifecycles, and the settings migration from `modules`. Nothing here names an extension except
 * Cron, the pilot of the full contract: one added or removed needs no change in this file.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { NAV_KEYS } from '../src/lib/nav.js';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'extensions');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-bundled-'));
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

const FOLDERS = fs.readdirSync(DIR).filter((d) => fs.existsSync(path.join(DIR, d, 'extension.json'))).sort();
const MANIFESTS = FOLDERS.map((id) => JSON.parse(fs.readFileSync(path.join(DIR, id, 'extension.json'), 'utf8')));
const LEGACY = MANIFESTS.filter((m) => m.legacy);
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));
const apiShims = (id) => fs.readdirSync(path.join(ROOT, 'src', 'routes', 'api'), { recursive: true })
  .filter((f) => f.endsWith('+server.js'))
  .filter((f) => fs.readFileSync(path.join(ROOT, 'src', 'routes', 'api', f), 'utf8').includes(`#extensions/${id}/api.js`));

describe('bundled extensions', () => {
  it('every folder holds a manifest named after it, and a README', () => {
    expect(FOLDERS.length).toBeGreaterThan(1);
    expect(exists('modules')).toBe(false);
    for (const m of MANIFESTS) {
      expect(m).toMatchObject({ label: expect.any(String), icon: expect.any(String), description: expect.any(String), api: 1 });
      expect(FOLDERS).toContain(m.id);
      expect(exists('extensions', m.id, 'README.md'), `extensions/${m.id}/README.md`).toBe(true);
      if (m.page) expect(NAV_KEYS).not.toContain(m.page.key);
    }
    expect(new Set(MANIFESTS.filter((m) => m.page).map((m) => m.page.key)).size).toBe(MANIFESTS.filter((m) => m.page).length);
  });

  it('a legacy extension keeps its page shim behind ExtensionGate, its API shims and a lifecycle', () => {
    expect(LEGACY.length).toBeGreaterThan(0);
    for (const m of LEGACY) {
      const page = path.join('src', 'routes', m.page.key, '+page.svelte');
      expect(fs.readFileSync(path.join(ROOT, page), 'utf8'), page).toContain(`<ExtensionGate id="${m.id}">`);
      expect(exists('extensions', m.id, 'server', 'index.js')).toBe(true);
      if (exists('extensions', m.id, 'api.js')) expect(apiShims(m.id).length, `an API route re-exporting extensions/${m.id}/api.js`).toBeGreaterThan(0);
    }
  });

  it('Cron follows the full contract: not legacy, no shim', () => {
    const cron = MANIFESTS.find((m) => m.id === 'cron');
    expect(cron.legacy).toBeUndefined();
    expect(exists('src', 'routes', 'cron')).toBe(false);
    expect(apiShims('cron')).toEqual([]);
  });
});

describe('extension tools', () => {
  it('the MCP server serves the tools of the files it is told, in order, never a core tool twice', () => {
    const mcp = require('../mcp/server.cjs');
    const files = FOLDERS.map((id) => path.join(DIR, id, 'tools.cjs')).filter((f) => fs.existsSync(f));
    const all = mcp.extensionTools(files.join(',')).map((t) => t.name);
    for (const n of all) expect(mcp.TOOLS.some((t) => t.name === n)).toBe(false);
    expect(new Set(all).size).toBe(all.length);
    expect(mcp.extensionTools('').length).toBe(0);
    const names = (file) => mcp.extensionTools(file).map((t) => t.name);
    const reversed = [...files].reverse();
    expect(mcp.extensionTools(reversed.join(',')).map((t) => t.name)).toEqual(reversed.flatMap(names));
  });

  it('a server started by hand serves every bundled extension, by id', () => {
    const { toolFilesOnDisk } = require('../mcp/extensionTools.cjs');
    const files = toolFilesOnDisk(ROOT, path.join(TMP, 'none'));
    expect(files.map((f) => path.basename(path.dirname(f)))).toEqual(FOLDERS.filter((id) => exists('extensions', id, 'tools.cjs')));
  });
});

describe('legacy lifecycle in the registry', () => {
  it('starts a legacy extension that is on, hands it the settings, stops it when switched off', async () => {
    vi.resetModules();
    process.env.HOOKED_DATA_DIR = TMP;
    process.env.HOOKED_EXTENSIONS_DIR = path.join(TMP, 'installed');
    delete process.env.HOOKED_BUNDLED_EXTENSIONS_DIR;
    const [a, ...rest] = LEGACY.map((m) => m.id);
    const calls = [];
    vi.doMock(`../extensions/${a}/server/index.js`, () => ({ default: {
      start: (arg) => calls.push(['start', arg.service, typeof arg.settings]),
      stop: () => calls.push(['stop']),
      applySettings: () => calls.push(['apply']),
    } }));
    // the other legacy extensions' loops stay off during the test
    for (const id of rest) vi.doMock(`../extensions/${id}/server/index.js`, () => ({ default: {} }));
    delete globalThis[Symbol.for('hooked.extensions')];
    const ext = await import('../server/extensions.js');
    await ext.bootExtensions({ service: true });
    ext.applyExtensionSettings({ extensions: { [a]: true } });
    ext.applyExtensionSettings({ extensions: { [a]: false } });
    ext.applyExtensionSettings({ extensions: { [a]: false } });
    ext.applyExtensionSettings({ extensions: {} });
    expect(calls).toEqual([['start', true, 'object'], ['apply'], ['stop'], ['start', true, 'object']]);

    const listed = ext.listExtensions({ extensions: {} });
    expect(listed.rejected).toEqual([]);
    expect(listed.extensions.map((e) => e.id)).toEqual(FOLDERS);
    for (const id of LEGACY.map((m) => m.id)) {
      expect(listed.extensions.find((e) => e.id === id)).toMatchObject({ legacy: true, source: 'bundled', pageModule: null });
    }
    expect(listed.extensions.find((e) => e.id === 'cron')).toMatchObject({ legacy: false });

    for (const id of LEGACY.map((m) => m.id)) vi.doUnmock(`../extensions/${id}/server/index.js`);
  }, 30000);

  it('a legacy API answers extension_off while its extension is off', async () => {
    const { writeSettings } = await import('../server/settings.js');
    const { gated } = await import('../src/lib/server/extensions.js');
    const [a] = LEGACY.map((m) => m.id);
    const handler = gated(a, () => new Response('on'));
    writeSettings({ extensions: { [a]: false } });
    const off = await handler({});
    expect(off.status).toBe(404);
    expect(await off.json()).toMatchObject({ code: 'extension_off' });
    writeSettings({ extensions: { [a]: true } });
    expect(await (await handler({})).text()).toBe('on');
  });

  it('an installed folder cannot claim to be legacy', async () => {
    vi.resetModules();
    const installed = path.join(TMP, 'installed2');
    fs.mkdirSync(path.join(installed, 'sneaky'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'sneaky', 'extension.json'), JSON.stringify({ id: 'sneaky', label: 'S', api: 1, legacy: true }));
    process.env.HOOKED_EXTENSIONS_DIR = installed;
    process.env.HOOKED_BUNDLED_EXTENSIONS_DIR = path.join(TMP, 'no-bundled');
    delete globalThis[Symbol.for('hooked.extensions')];
    const ext = await import('../server/extensions.js');
    await ext.reloadExtension('sneaky');
    expect(ext.listExtensions().rejected).toEqual([expect.objectContaining({ id: 'sneaky', error: expect.stringContaining('legacy') })]);
    delete globalThis[Symbol.for('hooked.extensions')];
    delete process.env.HOOKED_BUNDLED_EXTENSIONS_DIR;
  });
});
