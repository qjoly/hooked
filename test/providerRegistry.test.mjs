/*
 * Provider registry (server/providers.js) with a real settings file: built-ins and custom
 * providers, enable modes, launch refusals, attribution of pi sessions by model, external engine
 * modules, and a session of an external provider driven end to end through agent.js.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-registry-'));
process.env.HOOKED_DATA_DIR = path.join(TMP, 'data');
process.env.HOOKED_AGENT_SESSIONS_DIR = path.join(TMP, 'journals');
process.env.HOOKED_PROVIDERS_DIR = path.join(import.meta.dirname, 'fixtures', 'providers');
process.env.HOOKED_PI_SESSIONS_DIR = path.join(TMP, 'pi-sessions');
process.env.HOOKED_NO_RESUME = '1';
fs.mkdirSync(process.env.HOOKED_DATA_DIR, { recursive: true });
fs.cpSync(path.join(import.meta.dirname, 'fixtures', 'pi-sessions'), process.env.HOOKED_PI_SESSIONS_DIR, { recursive: true });
const CWD = path.join(TMP, 'project');
fs.mkdirSync(CWD, { recursive: true });

let reg, settings, agent, sessions;
beforeAll(async () => {
  reg = await import('../server/providers.js');
  settings = await import('../server/settings.js');
  agent = await import('../server/agent.js');
  sessions = await import('../server/sessions.js');
});
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (err, info) => (err ? reject(err) : resolve(info))));

describe('provider registry', () => {
  it('keeps the historical shape for the built-ins and adds custom providers', () => {
    settings.writeSettings({
      providers: {
        claude: 'off',
        pi: { enabled: 'on', label: 'Pi (all)' },
        mistral: { engine: 'pi', label: 'Mistral', short: 'mi', color: '#fa520f', models: ['mistral/*'], enabled: 'on' },
        bare: { engine: 'pi', label: 'Bare pi', models: ['openai/*'], hookedPackage: false, enabled: 'on' },
        nope: { label: 'no engine' },
      },
      defaultProvider: 'mistral',
    });
    const s = settings.readSettings();
    expect(s.providers.claude).toBe('off');
    expect(s.providers.pi).toEqual({ enabled: 'on', label: 'Pi (all)' });
    expect(s.providers.mistral.engine).toBe('pi');
    expect(s.providers.nope).toBeUndefined(); // a custom entry needs an engine
    expect(s.defaultProvider).toBe('mistral');
    const enabled = reg.configuredProviders();
    expect(enabled).toMatchObject({ claude: false, pi: true, mistral: true, bare: true });
    const list = reg.providerList();
    expect(list.map((p) => p.id)).toEqual(['claude', 'pi', 'mistral', 'bare']);
    const mi = list.find((p) => p.id === 'mistral');
    expect(mi).toMatchObject({ engine: 'pi', label: 'Mistral', short: 'mi', color: '#fa520f', mcpKind: 'pi', models: ['mistral/*'] });
    // hooked's pi package brings the cards; a provider that opts out of it has none
    expect(mi.capabilities).toMatchObject({ plan: true, questions: true, permissions: true, todos: true, trace: true });
    expect(list.find((p) => p.id === 'bare').capabilities).toMatchObject({ plan: false, questions: false, permissions: false, todos: false, trace: true });
  });

  it('refuses a launch on an unknown, disabled or engine-less provider with a clear reason', () => {
    expect(reg.providerLaunchError('ghost')).toMatch(/unknown provider/);
    expect(reg.providerLaunchError('claude')).toMatch(/disabled in the hooked settings/);
  });

  it('attributes pi sessions to the provider whose model patterns match', () => {
    const all = sessions.scanAllSessions();
    const pi = all.find((s) => s.id === 'sess-pi-1');
    expect(pi.engine).toBe('pi');
    expect(pi.modelRef).toBe('mistral/mistral-medium-3.5');
    expect(pi.provider).toBe('mistral');
    settings.writeSettings({ providers: { ...settings.readSettings().providers, mistral: { engine: 'pi', models: ['anthropic/*'], enabled: 'on' } } });
    expect(sessions.scanAllSessions().find((s) => s.id === 'sess-pi-1').provider).toBe('pi'); // back to the catch-all
  });

  it('loads external engine modules and reports them', async () => {
    await reg.loadExternalEngines();
    expect(reg.getEngine('echo')).toBeTruthy();
    const st = reg.externalEngineStatus();
    expect(st.errors).toEqual([]);
    expect(st.files.map((f) => f.engine)).toContain('echo');
    // a module cannot take a built-in engine id
    expect(() => reg.registerEngine({ id: 'pi' })).toThrow(/reserved/);
  });

  it('drives a session of an external provider end to end through agent.js', async () => {
    settings.writeSettings({
      providers: { ...settings.readSettings().providers, parrot: { engine: 'echo', label: 'Parrot', options: { prefix: 'squawk: ' } } },
    });
    expect(reg.configuredProviders().parrot).toBe(true);
    const info = await call(agent.launchSession, { cwd: CWD, prompt: 'hello', provider: 'parrot' });
    expect(info.sessionId).toMatch(/^echo-/);
    await call(agent.deliverReply, info.sessionId, 'again');
    const s = sessions.findSessionAny(info.sessionId);
    expect(s).toMatchObject({ provider: 'parrot', engine: 'echo', project: CWD, userPrompts: 2 });
    const conv = reg.engineForSession(s).conversation(s);
    expect(conv.map((m) => m.text)).toEqual(['hello', 'squawk: hello', 'again', 'squawk: again']);
    await call(agent.killSession, info.sessionId);
  }, 60_000);
});
