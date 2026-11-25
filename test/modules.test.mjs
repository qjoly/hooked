/*
 * hooked's modules (modules/index.js, server/moduleState.js, server/modules.js): the settings
 * switch, the tools each session gets, and the loops that follow the switch.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { MODULES, MODULE_IDS, moduleOn, moduleOfPage, sanitizeModules } from '../modules/index.js';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-modules-'));
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

describe('module list', () => {
  it('every module has a manifest with a page, and an id that names its folder', () => {
    expect(MODULE_IDS.sort()).toEqual(['cron', 'flows', 'github', 'incidents']);
    for (const m of MODULES) {
      expect(m).toMatchObject({ id: expect.any(String), label: expect.any(String), page: expect.any(String), description: expect.any(String) });
      expect(fs.existsSync(path.join(ROOT, 'modules', m.id, 'manifest.js'))).toBe(true);
      expect(moduleOfPage(m.page)).toBe(m.id);
    }
    expect(moduleOfPage('sessions')).toBeNull();
  });

  it('a module is on unless switched off, and the settings keep one boolean per module', () => {
    expect(moduleOn({}, 'cron')).toBe(true);
    expect(moduleOn({ modules: { cron: false } }, 'cron')).toBe(false);
    expect(moduleOn({ modules: { cron: false } }, 'flows')).toBe(true);
    expect(sanitizeModules({ cron: false, flows: 'no', bogus: false })).toEqual({ cron: false, flows: true, github: true, incidents: true });
    expect(sanitizeModules(null)).toEqual({ cron: true, flows: true, github: true, incidents: true });
  });
});

describe('module tools', () => {
  it('the MCP server serves the tools of the modules it is told are on, and pi packages carry the same', () => {
    const mcp = require('../mcp/server.cjs');
    const all = mcp.moduleTools(undefined).map((t) => t.name);
    expect(all).toEqual(expect.arrayContaining(['list_cron_tasks', 'save_cron_task', 'delete_cron_task', 'run_cron_task']));
    // core tools stay out of the module lists, and module tools out of the core list
    for (const n of all) expect(mcp.TOOLS.some((t) => t.name === n)).toBe(false);
    expect(mcp.moduleTools('flows,github').some((t) => t.name === 'list_cron_tasks')).toBe(false);
    expect(mcp.moduleTools('').length).toBe(0);
    // each module with tools ships a pi package declaring an extension
    for (const id of MODULE_IDS) {
      if (!fs.existsSync(path.join(ROOT, 'modules', id, 'tools.cjs'))) continue;
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'modules', id, 'pi', 'package.json'), 'utf8'));
      expect(pkg.keywords).toContain('pi-package');
      expect(fs.existsSync(path.join(ROOT, 'modules', id, 'pi', pkg.pi.extensions[0]))).toBe(true);
    }
  });

  it('a module pi package registers its tools as hooked_* tools', async () => {
    const registered = [];
    const { default: ext } = await import('../modules/cron/pi/extension.js');
    ext({ registerTool: (t) => registered.push(t.name) });
    expect(registered).toEqual(['hooked_list_cron_tasks', 'hooked_save_cron_task', 'hooked_delete_cron_task', 'hooked_run_cron_task']);
  });

  it('pi sessions get the pi packages of the modules that are on', async () => {
    const { modulePiPackages, enabledModuleIds } = await import('../server/moduleState.js');
    const on = modulePiPackages({ modules: {} });
    expect(on).toContain(path.join(ROOT, 'modules', 'cron', 'pi'));
    expect(modulePiPackages({ modules: { cron: false } })).not.toContain(path.join(ROOT, 'modules', 'cron', 'pi'));
    expect(enabledModuleIds({ modules: { cron: false, github: false } }).sort()).toEqual(['flows', 'incidents']);
  });
});

describe('module lifecycle', () => {
  it('starts a module that is on, stops it when switched off, and hands it the settings otherwise', async () => {
    vi.resetModules();
    process.env.HOOKED_DATA_DIR = TMP;
    const calls = [];
    vi.doMock('../modules/cron/server/index.js', () => ({ default: {
      start: (ctx) => calls.push(['start', ctx.service]),
      stop: () => calls.push(['stop']),
      applySettings: () => calls.push(['apply']),
    } }));
    // the other modules' loops stay off during the test
    for (const id of ['flows', 'github', 'incidents']) {
      vi.doMock(`../modules/${id}/server/index.js`, () => ({ default: {} }));
    }
    delete globalThis[Symbol.for('hooked.modules')];
    const { bootModules, applyModuleSettings } = await import('../server/modules.js');
    bootModules({ service: true });
    applyModuleSettings({ modules: { cron: true } });
    applyModuleSettings({ modules: { cron: false } });
    applyModuleSettings({ modules: { cron: false } });
    applyModuleSettings({ modules: {} });
    expect(calls).toEqual([['start', true], ['apply'], ['stop'], ['start', true]]);
    for (const id of ['cron', 'flows', 'github', 'incidents']) vi.doUnmock(`../modules/${id}/server/index.js`);
    delete globalThis[Symbol.for('hooked.modules')];
  });
});
