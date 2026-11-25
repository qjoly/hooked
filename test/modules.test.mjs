/*
 * hooked's modules (modules/index.js, server/moduleState.js, server/modules.js): what makes a
 * folder a module, the settings switch, the tools each session gets, and the loops that follow the
 * switch. Nothing here names a module: a module added or removed needs no change in this file.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { MODULES, MODULE_IDS, moduleOn, moduleOfPage, sanitizeModules } from '../modules/index.js';
import { NAV_TABS, NAV_KEYS } from '../src/lib/nav.js';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'modules');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-modules-'));
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

// The folders that hold a module, read from disk rather than from the code under test.
const FOLDERS = fs.readdirSync(DIR).filter((d) => fs.existsSync(path.join(DIR, d, 'manifest.js'))).sort();
const withTools = MODULE_IDS.filter((id) => fs.existsSync(path.join(DIR, id, 'tools.cjs')));
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));

describe('module list', () => {
  it('every folder with a manifest is a module, named after its folder', () => {
    expect(FOLDERS.length).toBeGreaterThan(0);
    expect([...MODULE_IDS].sort()).toEqual(FOLDERS);
    for (const m of MODULES) {
      expect(m).toMatchObject({ id: expect.any(String), label: expect.any(String), icon: expect.any(String), page: expect.any(String), description: expect.any(String), order: expect.any(Number) });
      expect(exists('modules', m.id, 'manifest.js')).toBe(true);
      expect(moduleOfPage(m.page)).toBe(m.id);
    }
    expect(moduleOfPage('sessions')).toBeNull();
    expect(MODULES.map((m) => m.order)).toEqual([...MODULES.map((m) => m.order)].sort((a, b) => a - b));
  });

  it('every module has its page, its API shim, a server lifecycle and a README', () => {
    for (const m of MODULES) {
      expect(exists('src', 'routes', m.page, '+page.svelte'), `src/routes/${m.page}/+page.svelte`).toBe(true);
      expect(fs.readFileSync(path.join(ROOT, 'src', 'routes', m.page, '+page.svelte'), 'utf8')).toContain(`<ModuleGate id="${m.id}">`);
      expect(exists('modules', m.id, 'server', 'index.js'), `modules/${m.id}/server/index.js`).toBe(true);
      expect(exists('modules', m.id, 'README.md'), `modules/${m.id}/README.md`).toBe(true);
      if (exists('modules', m.id, 'api.js')) {
        const shims = fs.readdirSync(path.join(ROOT, 'src', 'routes', 'api'), { recursive: true })
          .filter((f) => f.endsWith('+server.js'))
          .filter((f) => fs.readFileSync(path.join(ROOT, 'src', 'routes', 'api', f), 'utf8').includes(`#modules/${m.id}/api.js`));
        expect(shims.length, `an API route re-exporting modules/${m.id}/api.js`).toBeGreaterThan(0);
      }
    }
  });

  it('the navigation and the settings take every module page, in order', () => {
    for (const m of MODULES) {
      const tab = NAV_TABS.find((t) => t.key === m.page);
      expect(tab).toMatchObject({ label: m.label, icon: m.icon, href: '/' + m.page, module: m.id });
    }
    expect(NAV_TABS.map((t) => t.order)).toEqual([...NAV_TABS.map((t) => t.order)].sort((a, b) => a - b));
    expect(new Set(NAV_KEYS).size).toBe(NAV_KEYS.length); // no module takes a core page's key
  });

  it('a module is on unless switched off, and the settings keep one boolean per module', () => {
    const [a, b] = MODULE_IDS;
    expect(moduleOn({}, a)).toBe(true);
    expect(moduleOn({ modules: { [a]: false } }, a)).toBe(false);
    if (b) expect(moduleOn({ modules: { [a]: false } }, b)).toBe(true);
    const all = Object.fromEntries(MODULE_IDS.map((id) => [id, true]));
    expect(sanitizeModules(null)).toEqual(all);
    expect(sanitizeModules({ [a]: false, ...(b ? { [b]: 'no' } : {}), bogus: false })).toEqual({ ...all, [a]: false });
  });
});

describe('module tools', () => {
  it('the MCP server serves the tools of the modules it is told are on, never a core tool twice', () => {
    const mcp = require('../mcp/server.cjs');
    const all = mcp.moduleTools(undefined).map((t) => t.name);
    for (const n of all) expect(mcp.TOOLS.some((t) => t.name === n)).toBe(false);
    expect(new Set(all).size).toBe(all.length);
    expect(mcp.moduleTools('').length).toBe(0);
    for (const id of withTools) {
      const own = require(path.join(DIR, id, 'tools.cjs')).tools.map((t) => t.name);
      expect(mcp.moduleTools(id).map((t) => t.name)).toEqual(own);
      const others = MODULE_IDS.filter((x) => x !== id).join(',');
      expect(mcp.moduleTools(others).some((t) => own.includes(t.name))).toBe(false);
    }
  });

  it('each module with tools ships a pi package that registers them as hooked_* tools', async () => {
    for (const id of withTools) {
      const pkg = JSON.parse(fs.readFileSync(path.join(DIR, id, 'pi', 'package.json'), 'utf8'));
      expect(pkg.keywords).toContain('pi-package');
      const registered = [];
      const { default: ext } = await import(path.join(DIR, id, 'pi', pkg.pi.extensions[0]));
      ext({ registerTool: (t) => registered.push(t.name) });
      expect(registered).toEqual(require(path.join(DIR, id, 'tools.cjs')).tools.map((t) => 'hooked_' + t.name));
    }
  });

  it('pi sessions get the pi packages of the modules that are on', async () => {
    const { modulePiPackages, enabledModuleIds } = await import('../server/moduleState.js');
    const pkgs = modulePiPackages({ modules: {} });
    for (const id of withTools) {
      expect(pkgs).toContain(path.join(DIR, id, 'pi'));
      expect(modulePiPackages({ modules: { [id]: false } })).not.toContain(path.join(DIR, id, 'pi'));
    }
    const [a] = MODULE_IDS;
    expect(enabledModuleIds({ modules: { [a]: false } })).toEqual(MODULE_IDS.filter((x) => x !== a));
  });
});

describe('module lifecycle', () => {
  it('starts a module that is on, stops it when switched off, and hands it the settings otherwise', async () => {
    vi.resetModules();
    process.env.HOOKED_DATA_DIR = TMP;
    const [a, ...rest] = MODULE_IDS;
    const calls = [];
    vi.doMock(`../modules/${a}/server/index.js`, () => ({ default: {
      start: (ctx) => calls.push(['start', ctx.service]),
      stop: () => calls.push(['stop']),
      applySettings: () => calls.push(['apply']),
    } }));
    // the other modules' loops stay off during the test
    for (const id of rest) vi.doMock(`../modules/${id}/server/index.js`, () => ({ default: {} }));
    delete globalThis[Symbol.for('hooked.modules')];
    const { bootModules, applyModuleSettings, moduleAvailability } = await import('../server/modules.js');
    bootModules({ service: true });
    applyModuleSettings({ modules: { [a]: true } });
    applyModuleSettings({ modules: { [a]: false } });
    applyModuleSettings({ modules: { [a]: false } });
    applyModuleSettings({ modules: {} });
    expect(calls).toEqual([['start', true], ['apply'], ['stop'], ['start', true]]);
    // every module is known to the registry, by its folder
    expect(Object.keys(moduleAvailability()).sort()).toEqual(FOLDERS);
    for (const id of MODULE_IDS) vi.doUnmock(`../modules/${id}/server/index.js`);
    delete globalThis[Symbol.for('hooked.modules')];
  });
});
