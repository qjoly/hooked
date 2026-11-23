/*
 * hooked's pi package (pi-package/, docs/pi-package.md): the extension that runs inside a driven pi
 * session, and the driver side that turns its dialogs into dashboard cards (server/piHooked.js).
 * The extension is loaded against a stand-in of pi's extension API: what is pinned here is the
 * protocol between the two halves, which a real pi only carries.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-pipkg-'));
process.env.HOOKED_DATA_DIR = path.join(TMP, 'data');
const MCP_SERVER = path.join(import.meta.dirname, '..', 'mcp', 'server.cjs');
const EXT = path.join(import.meta.dirname, '..', 'pi-package', 'extensions', 'hooked.js');

let ext;
let piHooked;
beforeAll(async () => {
  ext = await import(EXT);
  piHooked = await import('../server/piHooked.js');
});
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

// What the extension needs of pi's ExtensionAPI, recorded.
function fakePi() {
  const pi = {
    tools: new Map(), handlers: {}, commands: new Map(), sent: [],
    registerTool(t) { pi.tools.set(t.name, t); },
    on(ev, fn) { (pi.handlers[ev] ||= []).push(fn); },
    registerCommand(name, opts) { pi.commands.set(name, opts); },
    sendMessage(msg, opts) { pi.sent.push({ msg, opts }); },
    emit(ev, event, ctx) { return Promise.all((pi.handlers[ev] || []).map((fn) => fn(event, ctx))).then((r) => r.find((x) => x !== undefined)); },
  };
  return pi;
}

// A ctx whose input dialog answers from a queue, and records every title it was shown.
function fakeCtx(answers = []) {
  const ctx = {
    titles: [], statuses: [],
    ui: {
      input: async (title) => { ctx.titles.push(title); return answers.length ? answers.shift() : undefined; },
      select: async (title, options) => { ctx.titles.push(title); return answers.length ? answers.shift() : options[0]; },
      setStatus: (key, text) => { ctx.statuses.push([key, text]); },
    },
  };
  return ctx;
}

function load(env = {}) {
  const keys = ['HOOKED_DRIVEN', 'HOOKED_MCP_SERVER', 'HOOKED_PERMISSION_MODE', 'HOOKED_AUTO_APPROVE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { HOOKED_DRIVEN: '1', HOOKED_MCP_SERVER: MCP_SERVER, HOOKED_PERMISSION_MODE: 'default', HOOKED_AUTO_APPROVE: '0', ...env });
  const pi = fakePi();
  try { ext.default(pi); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  return pi;
}

describe('pi package: pure helpers', () => {
  it('permissionDecision follows hooked\'s modes', () => {
    const d = (toolName, mode, autoApprove = false, always = new Set()) => ext.permissionDecision({ toolName, mode, autoApprove, alwaysAllowed: always });
    expect(d('read', 'default')).toBe('allow');
    expect(d('hooked_list_sessions', 'default')).toBe('allow');
    expect(d('AskUserQuestion', 'plan')).toBe('allow');
    expect(d('bash', 'default')).toBe('ask');
    expect(d('bash', 'default', true)).toBe('allow');
    expect(d('bash', 'default', false, new Set(['bash']))).toBe('allow');
    expect(d('edit', 'acceptEdits')).toBe('allow');
    expect(d('bash', 'acceptEdits')).toBe('ask');
    expect(d('edit', 'plan', true)).toBe('block-plan'); // auto-approve never lifts plan mode
    expect(d('bash', 'plan', true)).toBe('ask');
    expect(d('bash', 'bypassPermissions')).toBe('allow');
    expect(d('write', 'auto')).toBe('allow');
  });

  it('formatAnswers reads like Claude Code\'s tool result', () => {
    const text = ext.formatAnswers([{ question: 'Which db?' }, { question: 'Tests?' }], { 'Which db?': 'Postgres', 'Tests?': 'Yes, Later' });
    expect(text).toBe('User has answered your questions: "Which db?"="Postgres", "Tests?"="Yes, Later". You can now continue with the user\'s answers in mind.');
  });

  it('quotasFromHeaders turns the unified headers into statusline windows', () => {
    expect(ext.quotasFromHeaders({
      'anthropic-ratelimit-unified-5h-utilization': '0.42', 'anthropic-ratelimit-unified-5h-reset': '1790000000',
      'anthropic-ratelimit-unified-7d-utilization': '0.635',
    })).toEqual({ five_hour: { used_percentage: 42, resets_at: 1790000000 }, seven_day: { used_percentage: 63.5, resets_at: null } });
    expect(ext.quotasFromHeaders({ 'content-type': 'application/json' })).toBeNull();
    expect(ext.quotasFromHeaders(undefined)).toBeNull();
  });
});

describe('pi package: the extension', () => {
  it('registers hooked\'s MCP tools as native pi tools, plus AskUserQuestion and ExitPlanMode', async () => {
    const { TOOLS, INSTRUCTIONS } = await import(MCP_SERVER);
    const pi = load();
    for (const t of TOOLS) expect(pi.tools.has('hooked_' + t.name)).toBe(true);
    expect(pi.tools.has('AskUserQuestion')).toBe(true);
    expect(pi.tools.has('ExitPlanMode')).toBe(true);
    expect([...pi.commands.keys()].sort()).toEqual(['hooked-auto-approve', 'hooked-mode']);
    // hooked's instructions: one constant section, so the prompt never changes between turns
    const event = { systemPromptOptions: { sections: {} } };
    await pi.emit('before_agent_start', event, fakeCtx());
    expect(event.systemPromptOptions.sections.hooked).toBe(INSTRUCTIONS);
  });

  it('asks the dashboard before a tool runs, and remembers "allow always"', async () => {
    const pi = load();
    const ctx = fakeCtx(['{"choice":"deny","message":"not now"}', '{"choice":"allow-always"}']);
    const denied = await pi.emit('tool_call', { toolName: 'bash', input: { command: 'rm -rf build' } }, ctx);
    expect(denied).toEqual({ block: true, reason: 'not now' });
    expect(ctx.titles[0]).toBe('[hooked:permission] {"toolName":"bash","input":{"command":"rm -rf build"}}');
    expect(await pi.emit('tool_call', { toolName: 'bash', input: { command: 'ls' } }, ctx)).toBeUndefined();
    expect(await pi.emit('tool_call', { toolName: 'bash', input: { command: 'pwd' } }, ctx)).toBeUndefined();
    expect(ctx.titles.length).toBe(2); // the third call did not ask
    // a dismissed card is a denial
    expect(await pi.emit('tool_call', { toolName: 'write', input: {} }, fakeCtx())).toMatchObject({ block: true });
  });

  it('auto-approve and the mode follow hooked\'s commands', async () => {
    const pi = load();
    const ctx = fakeCtx();
    await pi.commands.get('hooked-auto-approve').handler('on', ctx);
    expect(await pi.emit('tool_call', { toolName: 'bash', input: {} }, ctx)).toBeUndefined();
    await pi.commands.get('hooked-mode').handler('plan', ctx);
    expect(await pi.emit('tool_call', { toolName: 'edit', input: {} }, ctx)).toMatchObject({ block: true });
    expect(pi.sent.at(-1)).toMatchObject({ msg: { customType: 'hooked-mode', display: false }, opts: { deliverAs: 'nextTurn' } });
    expect(pi.sent.at(-1).msg.content).toContain('Plan mode is on');
    await pi.commands.get('hooked-mode').handler('bogus', ctx); // ignored
    expect(await pi.emit('tool_call', { toolName: 'edit', input: {} }, ctx)).toMatchObject({ block: true });
  });

  it('an approved plan leaves plan mode', async () => {
    const pi = load({ HOOKED_PERMISSION_MODE: 'plan' });
    const plan = pi.tools.get('ExitPlanMode');
    const keep = await plan.execute('t1', { plan: '# Plan' }, null, null, fakeCtx(['{"action":"keep","feedback":"split step 2"}']));
    expect(keep.content[0].text).toBe('The user wants you to keep planning: split step 2');
    const ctx = fakeCtx(['{"action":"approve"}']);
    const ok = await plan.execute('t2', { plan: '# Plan' }, null, null, ctx);
    expect(ctx.titles[0]).toBe('[hooked:plan] {"plan":"# Plan"}');
    expect(ok.content[0].text).toContain('permission mode: acceptEdits');
    expect(await pi.emit('tool_call', { toolName: 'edit', input: {} }, fakeCtx())).toBeUndefined();
  });

  it('AskUserQuestion goes through one question card', async () => {
    const pi = load();
    const questions = [{ question: 'Which db?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }];
    const ctx = fakeCtx(['{"answers":{"Which db?":"SQLite"}}']);
    const res = await pi.tools.get('AskUserQuestion').execute('t1', { questions }, null, null, ctx);
    expect(ctx.titles[0]).toBe('[hooked:question] ' + JSON.stringify({ questions }));
    expect(res.content[0].text).toContain('"Which db?"="SQLite"');
    const none = await pi.tools.get('AskUserQuestion').execute('t2', { questions }, null, null, fakeCtx());
    expect(none.isError).toBe(true);
  });

  it('outside hooked: no gate, plain dialogs', async () => {
    const pi = load({ HOOKED_DRIVEN: '0' });
    expect(await pi.emit('tool_call', { toolName: 'bash', input: {} }, fakeCtx())).toBeUndefined();
    const questions = [{ question: 'Which db?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }];
    const res = await pi.tools.get('AskUserQuestion').execute('t1', { questions }, null, null, fakeCtx(['SQLite']));
    expect(res.details).toEqual({ answers: { 'Which db?': 'SQLite' } });
  });

  it('relays the bridge\'s quota headers as a status', async () => {
    const pi = load();
    const ctx = fakeCtx();
    await pi.emit('after_provider_response', { status: 200, headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.1' } }, ctx);
    await pi.emit('after_provider_response', { status: 200, headers: {} }, ctx);
    expect(ctx.statuses).toEqual([['hooked-ratelimit', JSON.stringify({ five_hour: { used_percentage: 10, resets_at: null }, seven_day: null })]]);
  });
});

describe('pi package: the driver side (piHooked)', () => {
  const entry = () => ({ id: 'sess-pkg', busy: true, sdkState: 'running', pendingAsk: null, emits: 0, _emit() { this.emits++; } });

  it('parses the card titles', () => {
    expect(piHooked.parseHookedTitle('[hooked:plan] {"plan":"x"}')).toEqual({ kind: 'plan', payload: { plan: 'x' } });
    expect(piHooked.parseHookedTitle('[hooked:plan] {broken')).toBeNull();
    expect(piHooked.parseHookedTitle('Name your branch')).toBeNull();
  });

  it('a permission dialog becomes the permission card, its answer goes back as JSON', () => {
    const st = entry();
    const out = [];
    const rec = { type: 'extension_ui_request', id: 'u1', method: 'input', title: '[hooked:permission] {"toolName":"bash","input":{"command":"ls"}}' };
    expect(piHooked.handleUiRequest(st, rec, (o) => out.push(o))).toBe(true);
    expect(st.pendingAsk).toMatchObject({ kind: 'permission', id: 'pi:u1', toolName: 'bash', input: { command: 'ls' } });
    expect(st.sdkState).toBe('requires_action');
    expect(st.busy).toBe(false);
    st.pendingAsk.resolve({ behavior: 'allow', allowAlways: true });
    expect(out).toEqual([{ type: 'extension_ui_response', id: 'u1', value: '{"choice":"allow-always"}' }]);
    expect(st.pendingAsk).toBeNull();
    expect(st.sdkState).toBe('running');

    piHooked.handleUiRequest(st, { ...rec, id: 'u2' }, (o) => out.push(o));
    st.pendingAsk.resolve({ behavior: 'deny', message: 'no' });
    expect(out.at(-1)).toEqual({ type: 'extension_ui_response', id: 'u2', value: '{"choice":"deny","message":"no"}' });
  });

  it('question and plan cards keep the shapes the UI renders', () => {
    const st = entry();
    const out = [];
    const questions = [{ question: 'Which db?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }];
    piHooked.handleUiRequest(st, { id: 'q1', method: 'input', title: '[hooked:question] ' + JSON.stringify({ questions }) }, (o) => out.push(o));
    expect(st.pendingAsk).toMatchObject({ kind: 'question', questions });
    st.pendingAsk.resolve({ behavior: 'allow', answers: { 'Which db?': 'Postgres' } });
    expect(JSON.parse(out.at(-1).value)).toEqual({ answers: { 'Which db?': 'Postgres' } });

    piHooked.handleUiRequest(st, { id: 'p1', method: 'input', title: '[hooked:plan] {"plan":"# Do it"}' }, (o) => out.push(o));
    expect(st.pendingAsk).toMatchObject({ kind: 'plan', plan: '# Do it' });
    st.pendingAsk.resolve({ behavior: 'deny', action: 'keep', feedback: 'smaller' });
    expect(JSON.parse(out.at(-1).value)).toEqual({ action: 'keep', feedback: 'smaller' });

    // an interrupt resolves with a bare deny: the extension sees a dismissed dialog
    piHooked.handleUiRequest(st, { id: 'p2', method: 'input', title: '[hooked:plan] {"plan":"x"}' }, (o) => out.push(o));
    st.pendingAsk.resolve({ behavior: 'deny', message: 'Interrupted from the hooked dashboard.' });
    expect(out.at(-1)).toEqual({ type: 'extension_ui_response', id: 'p2', cancelled: true });
  });

  it('another extension\'s confirm / select becomes a one-question card; free text dialogs are cancelled', () => {
    const st = entry();
    const out = [];
    piHooked.handleUiRequest(st, { id: 'c1', method: 'confirm', title: 'Delete?', message: '3 files' }, (o) => out.push(o));
    const q = st.pendingAsk.questions[0];
    expect(q.question).toBe('Delete? — 3 files');
    expect(q.options.map((o) => o.label)).toEqual(['Yes', 'No']);
    st.pendingAsk.resolve({ behavior: 'allow', answers: { [q.question]: 'No' } });
    expect(out.at(-1)).toEqual({ type: 'extension_ui_response', id: 'c1', confirmed: false });

    piHooked.handleUiRequest(st, { id: 's1', method: 'select', title: 'Pick', options: ['a', 'b'] }, (o) => out.push(o));
    st.pendingAsk.resolve({ behavior: 'allow', answers: { Pick: 'b' } });
    expect(out.at(-1)).toEqual({ type: 'extension_ui_response', id: 's1', value: 'b' });

    expect(piHooked.handleUiRequest(st, { id: 'i1', method: 'input', title: 'Branch name?' }, (o) => out.push(o))).toBe(false);
    expect(out.at(-1)).toEqual({ type: 'extension_ui_response', id: 'i1', cancelled: true });
    expect(st.pendingAsk).toBeNull();
  });

  it('the quota status lands in the statusline snapshot', () => {
    const st = entry();
    const rl = { five_hour: { used_percentage: 12, resets_at: 1790000000 }, seven_day: null };
    piHooked.handleUiRequest(st, { id: 'x', method: 'setStatus', statusKey: 'hooked-ratelimit', statusText: JSON.stringify(rl) }, () => {});
    const snap = JSON.parse(fs.readFileSync(path.join(process.env.HOOKED_DATA_DIR, 'status', 'sess-pkg.json'), 'utf8'));
    expect(snap.rate_limits).toEqual(rl);
  });

  it('the package env carries hooked\'s MCP context and the session controls', () => {
    const env = piHooked.hookedPackageEnv({ permissionMode: 'plan', autoApprove: false }, { args: ['/x/mcp/server.cjs'], env: { HOOKED_PORT: '4123', HOOKED_LAUNCH_KEY: 'k1' } });
    expect(env).toEqual({ HOOKED_DRIVEN: '1', HOOKED_PORT: '4123', HOOKED_LAUNCH_KEY: 'k1', HOOKED_MCP_SERVER: '/x/mcp/server.cjs', HOOKED_PERMISSION_MODE: 'plan', HOOKED_AUTO_APPROVE: '0' });
    expect(piHooked.hookedPackageEnabled({ hookedPackage: false })).toBe(false);
    expect(piHooked.hookedPackageEnabled({})).toBe(true);
  });
});

describe('pi catalog of a provider with its own extensions', () => {
  it('lists models with the provider\'s -e extensions loaded, in a catalog of its own', async () => {
    const { piCatalogFor } = await import('../server/piAgent.js');
    const bin = path.join(TMP, 'fake-pi');
    // prints a model row per extension it was given, so the test sees what --list-models received
    fs.writeFileSync(bin, [
      '#!/bin/sh',
      'echo "provider       model     context  max-out  thinking  images"',
      'echo "mistral        devstral  256K     32K      no        no"',
      'if [ "$2" = "-e" ]; then echo "claude-bridge  opus      1M       64K      yes       yes"; fi',
    ].join('\n'));
    fs.chmodSync(bin, 0o755);
    const plain = await piCatalogFor({ id: 'pi', engine: 'pi', command: bin });
    const bridged = await piCatalogFor({ id: 'cb', engine: 'pi', command: bin, args: ['--verbose', '-e', 'npm:pi-claude-bridge@0.13.0'] });
    expect(plain.map((m) => m.ref)).toEqual(['mistral/devstral']);
    expect(bridged.map((m) => m.ref)).toEqual(['mistral/devstral', 'claude-bridge/opus']);
  });
});

describe('Claude model names on a pi provider', () => {
  it('drops Claude Code\'s context suffix, keeps aliases for pi to resolve', async () => {
    const { qualifyModel } = await import('../server/piAgent.js');
    expect(qualifyModel('opus[1m]', null)).toBe('opus');
    expect(qualifyModel('claude-bridge/claude-opus-5-5[1m]', null)).toBe('claude-bridge/claude-opus-5-5');
    expect(qualifyModel('sonnet', { modelProvider: 'claude-bridge' })).toBe('claude-bridge/sonnet');
    expect(qualifyModel('mistral/devstral-latest', { modelProvider: 'x' })).toBe('mistral/devstral-latest');
    expect(qualifyModel('', null)).toBeNull();
    expect(qualifyModel('[1m]', null)).toBeNull();
  });
});
