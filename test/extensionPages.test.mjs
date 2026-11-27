/*
 * The runtime page compiler (server/extensionPages.js) and the facades extensions see: Cron's page
 * compiles into a module that imports nothing but the shared runtime, a forbidden import fails the
 * compile, and the names of `ctx`, `@hooked/ext/ui` and the shared runtime are pinned (removing one
 * is an EXTENSION_API bump).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-ext-pages-'));
process.env.HOOKED_DATA_DIR = TMP;
const ROOT = path.join(import.meta.dirname, '..');
const { compileExtensionPage, SHARED_RUNTIME, UI_EXPORTS, extensionPageFile } = await import('../server/extensionPages.js');
const { buildContext, EXTENSION_API } = await import('../server/ext/context.js');

describe('page compiler', () => {
  it('compiles Cron\'s page under 5 s into a module that only reads the shared runtime, then reuses it', async () => {
    // The service's environment never changes during a compile: sessions spawned meanwhile inherit it.
    const seen = new Set();
    const watch = setInterval(() => seen.add(process.env.NODE_ENV), 2);
    const first = await compileExtensionPage({ id: 'cron', hash: 'test', srcDir: path.join(ROOT, 'extensions', 'cron') });
    clearInterval(watch);
    expect([...seen]).toEqual([process.env.NODE_ENV]);
    expect(first.cached).toBe(false);
    expect(first.ms).toBeLessThan(5000);
    const out = fs.readFileSync(extensionPageFile(first.url.slice('/_ext/'.length)), 'utf8');
    expect(out).not.toMatch(/\bimport\s*[\w{*][^;]*?from\s*['"]/);
    expect(out).not.toMatch(/\bimport\s*\(/);
    expect(out).toContain('globalThis.__hookedExt');
    expect(out).toContain('.cr-list'); // styles ship inside the module
    expect(await compileExtensionPage({ id: 'cron', hash: 'test', srcDir: path.join(ROOT, 'extensions', 'cron') })).toMatchObject({ url: first.url, cached: true });
  }, 30000);

  it('a bare import outside the shared runtime fails the compile', async () => {
    const dir = path.join(TMP, 'bad');
    fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ui', 'Page.svelte'), "<script>import { data } from '#lib/state.svelte.js';</script>{data}");
    await expect(compileExtensionPage({ id: 'bad', hash: 'x', srcDir: dir })).rejects.toThrow(/not allowed in an extension page: #lib\/state\.svelte\.js/);
  }, 30000);

  it('serves only compiled page paths', () => {
    expect(extensionPageFile('cron/0123456789abcdef/page.js')).toBe(path.join(TMP, 'extension-cache', 'cron', '0123456789abcdef', 'page.js'));
    expect(extensionPageFile('../settings.json')).toBeNull();
    expect(extensionPageFile('cron/0123456789abcdef/../../x')).toBeNull();
  });
});

describe('facades (EXTENSION_API ' + 1 + ')', () => {
  it('ctx', () => {
    expect(EXTENSION_API).toBe(1);
    expect(Object.keys(buildContext({ id: 'x', service: false, settings: () => ({}) })).sort()).toEqual([
      'LAUNCH_PERMISSION_MODES', 'agentAlive', 'agentBusy', 'agentPendingAsk', 'api', 'dataDir', 'deliverReply',
      'err400', 'fail', 'hookedDir', 'hookedSettings', 'id', 'json', 'killSession', 'launchSession', 'log', 'ok',
      'readJson', 'readTags', 'service', 'setTags', 'settings', 'toPromise',
    ]);
  });

  it('@hooked/ext/ui exports what the compiler declares', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'ext', 'ui.js'), 'utf8');
    const exported = [...src.matchAll(/export \{([^}]+)\}/g)].flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()));
    expect(exported.sort()).toEqual([...UI_EXPORTS].sort());
  });

  it('the shared runtime fills every module the compiler redirects', () => {
    expect(SHARED_RUNTIME).toEqual([
      'svelte', 'svelte/internal/client', 'svelte/internal/disclose-version', 'svelte/store', 'svelte/reactivity',
      'svelte/transition', 'svelte/animate', 'svelte/easing', 'svelte/motion', 'svelte/events', 'svelte/attachments',
      '@hooked/ext/ui',
    ]);
    const src = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'ext', 'runtime.js'), 'utf8');
    const keys = [...src.slice(src.indexOf('globalThis.__hookedExt')).matchAll(/^\s+'?([@\w/-]+)'?(?::|,)/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual([...SHARED_RUNTIME].sort());
  });

  it('the registry names survive the server barrel', async () => {
    const core = await import('../src/lib/server/core.js');
    for (const n of ['bootExtensions', 'reloadExtension', 'applyExtensionSettings', 'listExtensions', 'extensionAvailability', 'extensionEnabled', 'enabledExtensionIds', 'emitExtensionEvent', 'dispatchExtensionRoute', 'sessionToolFiles', 'extensionLabel', 'getExtensionSettings', 'saveExtensionSettings']) {
      expect(typeof core[n], n).toBe('function');
    }
  });
});
