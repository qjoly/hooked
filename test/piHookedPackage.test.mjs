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
    entries: [],
    appendEntry(type, data) { pi.entries.push({ type, data }); },
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

describe('todo list of pi sessions', () => {
  it('the package\'s TodoWrite needs no permission and returns the list', async () => {
    const pi = load();
    const tool = pi.tools.get('TodoWrite');
    expect(tool).toBeTruthy();
    const todos = [{ content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' }, { content: 'Ship', status: 'pending', activeForm: 'Shipping' }];
    const res = await tool.execute('t1', { todos }, null, null, fakeCtx());
    expect(res.details).toEqual({ todos });
    expect(res.content[0].text).toContain('0/2 completed');
    expect(await pi.emit('tool_call', { toolName: 'TodoWrite', input: { todos } }, fakeCtx())).toBeUndefined();
  });

  it('the dock reads the last TodoWrite of the active branch', async () => {
    const { latestPiTodos } = await import('../server/pi.js');
    const file = path.join(TMP, 'todos-session.jsonl');
    const call = (id, parentId, todos) => ({ type: 'message', id, parentId, timestamp: `2026-11-23T10:00:0${id.slice(1)}.000Z`, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c' + id, name: 'TodoWrite', arguments: { todos } }] } });
    const lines = [
      { type: 'session', version: 3, id: 'sess-todos', timestamp: '2026-11-23T10:00:00.000Z', cwd: '/tmp/x' },
      call('e1', null, [{ content: 'A', status: 'in_progress', activeForm: 'Doing A' }]),
      call('e2', 'e1', [{ content: 'A', status: 'completed', activeForm: 'Doing A' }, { content: 'B', status: 'bogus' }]),
      call('e3', 'e1', [{ content: 'abandoned branch', status: 'pending', activeForm: '' }]),
      { type: 'message', id: 'e4', parentId: 'e2', timestamp: '2026-11-23T10:00:05.000Z', message: { role: 'user', content: [{ type: 'text', text: 'go on' }] } },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(latestPiTodos(file)).toEqual({
      ts: '2026-11-23T10:00:02.000Z',
      todos: [{ content: 'A', status: 'completed', activeForm: 'Doing A' }, { content: 'B', status: 'pending', activeForm: '' }],
    });
    expect(latestPiTodos(path.join(TMP, 'missing.jsonl'))).toBeNull();
  });
});

describe('subagents (Agent tool of the pi package)', () => {
  const AGENT = path.join(import.meta.dirname, '..', 'pi-package', 'extensions', 'agent.js');

  it('bounds the subagent\'s tools by the parent\'s mode', async () => {
    const { subagentTools } = await import(AGENT);
    const read = ['read', 'grep', 'find', 'ls'];
    expect(subagentTools({ mode: 'default', autoApprove: false })).toEqual(read);
    expect(subagentTools({ mode: 'plan', autoApprove: true })).toEqual(read);
    expect(subagentTools({ mode: 'default', autoApprove: true, subagentType: 'Explore' })).toEqual(read);
    expect(subagentTools({ mode: 'acceptEdits', autoApprove: false })).toEqual([...read, 'edit', 'write']);
    expect(subagentTools({ mode: 'default', autoApprove: true })).toBeNull();
    expect(subagentTools({ mode: 'bypassPermissions', autoApprove: false })).toBeNull();
  });

  it('passes the parent\'s extensions on, without hooked\'s package', async () => {
    const { inheritedExtensions } = await import(AGENT);
    const pkg = path.join(import.meta.dirname, '..', 'pi-package');
    expect(inheritedExtensions(['node', 'pi', '--mode', 'rpc', '-e', 'npm:pi-claude-bridge@0.13.0', '-e', pkg, '--extension', '/x/y.ts', '-e'], pkg))
      .toEqual(['-e', 'npm:pi-claude-bridge@0.13.0', '-e', '/x/y.ts']);
  });

  it('reads the final answer and sums the usage', async () => {
    const { finalText, totalUsage } = await import(AGENT);
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'toolCall', name: 'ls' }], usage: { input: 10, output: 2, cacheRead: 5, cost: { total: 0.01 } } },
      { role: 'toolResult', content: [{ type: 'text', text: 'a b' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'two' }, { type: 'text', text: '2' }], usage: { input: 12, output: 1, cost: { total: 0.02 } } },
    ];
    expect(finalText(msgs)).toBe('2');
    expect(totalUsage(msgs)).toEqual({ input: 22, output: 3, cacheRead: 5, cacheWrite: 0, cost: 0.03, turns: 2 });
    expect(finalText([])).toBe('');
  });

  it('is registered, and runs without a permission card', async () => {
    const pi = load();
    expect(pi.tools.get('Agent').parameters.required).toEqual(['description', 'prompt']);
    expect(await pi.emit('tool_call', { toolName: 'Agent', input: { description: 'x', prompt: 'y' } }, fakeCtx())).toBeUndefined();
  });
});

describe('subagent usage in the pi session summary', () => {
  it('adds the Agent tool\'s usage, priced by hooked when pi says 0 (subscription models)', async () => {
    const { scanPiSessions } = await import('../server/pi.js');
    const dir = path.join(TMP, 'pi-sessions-agent', '--tmp-x--');
    fs.mkdirSync(dir, { recursive: true });
    const result = (id, parentId, model, cost) => ({
      type: 'message', id, parentId, timestamp: '2026-11-23T10:00:02.000Z',
      message: { role: 'toolResult', toolCallId: 'c' + id, toolName: 'Agent', content: [{ type: 'text', text: '2' }], isError: false,
        details: { model, usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost, turns: 1 } } },
    });
    const lines = [
      { type: 'session', version: 3, id: 'sess-agent', timestamp: '2026-11-23T10:00:00.000Z', cwd: '/tmp/x' },
      { type: 'message', id: 'e1', parentId: null, timestamp: '2026-11-23T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'count' }] } },
      result('e2', 'e1', 'mistral/mistral-large-latest', 0.004),
      result('e3', 'e2', 'claude-bridge/claude-haiku-5-5', 0),
    ];
    fs.writeFileSync(path.join(dir, '2026-11-23T10-00-00-000Z_sess-agent.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const s = scanPiSessions(path.join(TMP, 'pi-sessions-agent')).find((x) => x.id === 'sess-agent');
    expect(s.subagents).toBe(2);
    expect(s.subagentCost).toBeGreaterThan(0.004); // pi's price for the first, hooked's for the bridged one
    expect(s.usage.input).toBe(2000);
    expect(s.cost).toBeCloseTo(s.subagentCost, 10);
  });
});

describe('WebFetch of the pi package', () => {
  const WF = path.join(import.meta.dirname, '..', 'pi-package', 'extensions', 'webfetch.js');

  it('turns HTML into readable text', async () => {
    const { htmlToText } = await import(WF);
    const html = `<!doctype html><html><head><title>Docs &amp; more</title><style>p{color:red}</style></head>
      <body><script>alert(1)</script><h1>Intro</h1><p>Hello&nbsp;<b>world</b> &#233;t&eacute; &#x2713;</p>
      <ul><li>one</li><li><a href="/two">two</a></li></ul><!-- hidden --><table><tr><td>a</td><td>b</td></tr></table></body></html>`;
    const text = htmlToText(html);
    expect(text.startsWith('Docs & more\n\n# Intro')).toBe(true);
    expect(text).toContain('Hello world');
    expect(text).toContain('- two (/two)');
    expect(text).toContain('| a | b');
    expect(text).not.toMatch(/alert|color:red|hidden|<\w/);
  });

  it('fetches a page, asks for permission in the normal mode, and reports HTTP errors', async () => {
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      if (req.url === '/missing') { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('nope'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><title>T</title><body><p>Body text</p></body></html>');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const pi = load();
      const tool = pi.tools.get('WebFetch');
      const ok = await tool.execute('w1', { url: base + '/', prompt: 'the body' }, null, null, fakeCtx());
      expect(ok.content[0].text).toContain('HTTP 200, text/html');
      expect(ok.content[0].text).toContain('Looking for: the body');
      expect(ok.content[0].text).toContain('T\n\nBody text');
      const missing = await tool.execute('w2', { url: base + '/missing' }, null, null, fakeCtx());
      expect(missing.isError).toBe(true);
      const bad = await tool.execute('w3', { url: 'file:///etc/passwd' }, null, null, fakeCtx());
      expect(bad.content[0].text).toMatch(/unsupported protocol/);
      // not a safe tool: the gate asks in the normal mode
      const ctx = fakeCtx(['{"choice":"deny"}']);
      expect(await pi.emit('tool_call', { toolName: 'WebFetch', input: { url: base } }, ctx)).toMatchObject({ block: true });
      expect(ctx.titles[0]).toMatch(/^\[hooked:permission\] \{"toolName":"WebFetch"/);
    } finally { server.close(); }
  });
});

describe('background commands of the pi package', () => {
  const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timeout'); };

  it('runs a command in the background, notifies its end, and returns its output once', async () => {
    const pi = load();
    const ctx = { ...fakeCtx(), cwd: TMP };
    const r = await pi.tools.get('BashBackground').execute('b1', { command: 'echo one; sleep 0.2; echo two; exit 3', description: 'demo' }, null, null, ctx);
    const id = r.details.shellId;
    expect(r.content[0].text).toContain(`ID: ${id}`);
    const sent = await until(() => pi.sent.find((x) => x.msg.customType === 'hooked-task'));
    expect(sent.opts).toEqual({ deliverAs: 'followUp', triggerTurn: true });
    expect(sent.msg.details).toMatchObject({ shellId: id, status: 'failed', exitCode: 3 });
    expect(sent.msg.content).toContain('<status>failed</status>');
    expect(sent.msg.content).toContain('Background command "demo" failed with exit code 3');
    const out = await pi.tools.get('BashOutput').execute('o1', { bash_id: id }, null, null, ctx);
    expect(out.content[0].text).toBe('<status>failed (exit code 3)</status>\n<output>\none\ntwo\n</output>');
    const again = await pi.tools.get('BashOutput').execute('o2', { bash_id: id }, null, null, ctx);
    expect(again.content[0].text).toContain('(no new output)');
  });

  it('stops a command and its children, without a notification; the session end stops the rest', async () => {
    const pi = load();
    const ctx = { ...fakeCtx(), cwd: TMP };
    const a = (await pi.tools.get('BashBackground').execute('b1', { command: 'sleep 30 & wait' }, null, null, ctx)).details.shellId;
    const b = (await pi.tools.get('BashBackground').execute('b2', { command: 'sleep 30' }, null, null, ctx)).details.shellId;
    const k = await pi.tools.get('KillShell').execute('k1', { shell_id: a }, null, null, ctx);
    expect(k.content[0].text).toBe(`Stopped ${a}.`);
    await pi.emit('session_shutdown', { reason: 'quit' }, ctx);
    expect(pi.entries).toEqual([{ type: 'hooked-task', data: { shellId: b, status: 'killed', reason: 'session ended' } }]);
    await new Promise((r) => setTimeout(r, 300));
    expect(pi.sent.filter((x) => x.msg.customType === 'hooked-task')).toEqual([]);
    const st = await pi.tools.get('BashOutput').execute('o', { bash_id: b }, null, null, ctx);
    expect(st.content[0].text).toContain('<status>killed</status>');
    // reading and stopping never ask; starting asks like bash
    expect(await pi.emit('tool_call', { toolName: 'BashOutput', input: {} }, fakeCtx())).toBeUndefined();
    expect(await pi.emit('tool_call', { toolName: 'BashBackground', input: {} }, fakeCtx())).toMatchObject({ block: true });
  });

  it('the dock reads the jobs back from the session file', async () => {
    const { piBackgroundJobs } = await import('../server/pi.js');
    const file = path.join(TMP, 'bg-session.jsonl');
    const call = (id, parentId, name, args) => ({ type: 'message', id, parentId, timestamp: `2026-11-23T10:00:0${id.slice(1)}.000Z`, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c' + id, name, arguments: args }] } });
    const result = (id, parentId, callId, shellId) => ({ type: 'message', id, parentId, timestamp: `2026-11-23T10:00:0${id.slice(1)}.000Z`, message: { role: 'toolResult', toolCallId: callId, toolName: 'BashBackground', content: [{ type: 'text', text: `Command running in background with ID: ${shellId}.` }], details: { shellId }, isError: false } });
    const lines = [
      { type: 'session', version: 3, id: 'sess-bg', timestamp: '2026-11-23T10:00:00.000Z', cwd: '/tmp/x' },
      call('e1', null, 'BashBackground', { command: 'npm run dev', description: 'dev server' }),
      result('e2', 'e1', 'ce1', 'bg-1'),
      call('e3', 'e2', 'BashBackground', { command: 'npm test' }),
      result('e4', 'e3', 'ce3', 'bg-2'),
      { type: 'custom_message', id: 'e5', parentId: 'e4', timestamp: '2026-11-23T10:00:05.000Z', customType: 'hooked-task', content: '<task-notification>…', details: { shellId: 'bg-2', status: 'completed', exitCode: 0 } },
      call('e6', 'e5', 'BashBackground', { command: 'tail -f log' }),
      result('e7', 'e6', 'ce6', 'bg-3'),
      call('e8', 'e7', 'KillShell', { shell_id: 'bg-3' }),
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const { jobs, active } = piBackgroundJobs(file);
    expect(jobs.map((j) => [j.taskId, j.done, j.doneReason])).toEqual([['bg-1', false, null], ['bg-2', true, 'completed'], ['bg-3', true, 'stopped']]);
    expect(active.map((j) => j.description)).toEqual(['dev server']);
    expect(jobs[1].exitCode).toBe(0);
  });
});

describe('WebSearch of the pi package', () => {
  const WS = path.join(import.meta.dirname, '..', 'pi-package', 'extensions', 'websearch.js');

  it('asks a headless, traceless claude -p limited to WebSearch', async () => {
    const { searchPrompt, headlessArgs, resultText } = await import(WS);
    const p = searchPrompt({ query: ' pi releases ', allowed_domains: ['github.com', 'bad domain;rm'], blocked_domains: ['spam.example'] });
    expect(p).toContain('search the web for: pi releases');
    expect(p).toContain('Only keep results from these domains: github.com.');
    expect(p).toContain('Leave out results from these domains: spam.example.');
    const args = headlessArgs('Q');
    expect(args).toEqual(expect.arrayContaining(['--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']));
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', 'WebSearch']);
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ disableAllHooks: true });
    expect(resultText('{"type":"result","is_error":false,"result":" - [A](https://a) "}')).toBe('- [A](https://a)');
    expect(resultText('{"is_error":true,"result":"x"}')).toBeNull();
    expect(resultText('not json')).toBeNull();
  });

  it('returns the results of the call, reports a failure, and asks in the normal mode', async () => {
    const bin = path.join(TMP, 'fake-claude');
    const argsLog = path.join(TMP, 'fake-claude.args');
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsLog}'\ncase "$2" in *FAILME*) echo boom >&2; exit 2;; esac\necho '{"type":"result","is_error":false,"result":"1. [Pi](https://pi.dev)"}'\n`);
    fs.chmodSync(bin, 0o755);
    const saved = process.env.HOOKED_CLAUDE_BIN;
    process.env.HOOKED_CLAUDE_BIN = bin;
    try {
      const pi = load();
      const tool = pi.tools.get('WebSearch');
      const ok = await tool.execute('s1', { query: 'pi coding agent' }, null, null, fakeCtx());
      expect(ok.isError).toBeUndefined();
      expect(ok.content[0].text).toBe('Web search results for "pi coding agent":\n\n1. [Pi](https://pi.dev)');
      expect(fs.readFileSync(argsLog, 'utf8').split('\n')[0]).toBe('-p');
      expect((await tool.execute('s2', { query: 'x' }, null, null, fakeCtx())).isError).toBe(true); // too short
      const failed = await tool.execute('s3', { query: 'FAILME now' }, null, null, fakeCtx());
      expect(failed).toMatchObject({ isError: true });
      expect(failed.content[0].text).toBe('WebSearch failed: boom');
      const ctx = fakeCtx(['{"choice":"deny"}']);
      expect(await pi.emit('tool_call', { toolName: 'WebSearch', input: { query: 'q' } }, ctx)).toMatchObject({ block: true });
    } finally {
      if (saved === undefined) delete process.env.HOOKED_CLAUDE_BIN; else process.env.HOOKED_CLAUDE_BIN = saved;
    }
  });
});

describe('Workflow of the pi package', () => {
  const WF = path.join(import.meta.dirname, '..', 'pi-package', 'extensions', 'workflow.js');
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 };

  it('prepares the script and reads structured answers', async () => {
    const { prepareScript, parseObject, schemaProblem } = await import(WF);
    expect(() => prepareScript('const x = 1')).toThrow(/export const meta/);
    expect(prepareScript("export const meta = { name: 'a' }\nexport const N = 2\nreturn N")).toBe("const meta = globalThis.__meta = { name: 'a' }\nconst N = 2\nreturn N");
    expect(parseObject('Here:\n```json\n{"ok": true}\n```')).toEqual({ ok: true });
    expect(parseObject('{"a": {"b": 1}}')).toEqual({ a: { b: 1 } });
    expect(() => parseObject('no json')).toThrow();
    const S = { type: 'object', properties: { n: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } }, kind: { enum: ['bug', 'nit'] } }, required: ['n'] };
    expect(schemaProblem(S, { n: 2, tags: ['a'], kind: 'bug' })).toBeNull();
    expect(schemaProblem(S, { tags: [] })).toBe('$.n is missing');
    expect(schemaProblem(S, { n: 1.5 })).toBe('$.n should be integer');
    expect(schemaProblem(S, { n: 1, tags: [3] })).toBe('$.tags[0] should be string');
    expect(schemaProblem(S, { n: 1, kind: 'x' })).toMatch(/one of/);
  });

  it('runs agents through parallel, pipeline and schemas, with a capped concurrency', async () => {
    const { runWorkflow } = await import(WF);
    let live = 0; let peak = 0;
    const calls = [];
    const run = async ({ prompt }) => {
      calls.push(prompt);
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 20));
      live--;
      if (prompt.startsWith('FAIL')) return { text: '', usage, error: 'boom' };
      if (prompt.includes('JSON Schema')) {
        // first answer in prose, the retry in JSON
        return prompt.includes('previously') || prompt.includes('rejected') ? { text: '{"n": 7}', usage } : { text: 'about seven', usage };
      }
      return { text: `done: ${prompt.split('\n')[0]}`, usage };
    };
    const script = `export const meta = { name: 'demo', description: 'test', phases: [{ title: 'Fan' }] }
phase('Fan')
const names = await parallel(args.files.map((f) => () => agent('read ' + f, { label: f })))
const staged = await pipeline(['a', 'b'], (x) => x.toUpperCase(), (x, orig, i) => agent('stage ' + x + ' ' + orig + ' ' + i))
const failed = await agent('FAIL please')
const counted = await agent('count things', { schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } })
log('all done')
return { names, staged, failed, counted }`;
    const { result, state, meta } = await runWorkflow({ script, args: { files: ['x', 'y', 'z', 'w', 'v', 'u'] }, run });
    expect(meta).toEqual({ name: 'demo', description: 'test', phases: [{ title: 'Fan' }] });
    expect(result.names).toEqual(['done: read x', 'done: read y', 'done: read z', 'done: read w', 'done: read v', 'done: read u']);
    expect(result.staged).toEqual(['done: stage A a 0', 'done: stage B b 1']);
    expect(result.failed).toBeNull();
    expect(result.counted).toEqual({ n: 7 });
    expect(peak).toBeLessThanOrEqual(4);
    expect(state.agents.length).toBe(10);
    expect(state.agents.filter((a) => a.status === 'failed').length).toBe(1);
    expect(state.agents[0]).toMatchObject({ label: 'x', phase: 'Fan', status: 'done' });
    expect(state.logs).toEqual(['all done']);
    expect(state.usage.cost).toBeCloseTo(0.11, 10); // 11 runs: 10 agents, one schema retry
  });

  it('is a tool that asks in the normal mode, and reports script errors', async () => {
    const pi = load();
    expect(pi.tools.has('Workflow')).toBe(true);
    expect(await pi.emit('tool_call', { toolName: 'Workflow', input: { script: '' } }, fakeCtx())).toMatchObject({ block: true });
    const bad = await pi.tools.get('Workflow').execute('w1', { script: 'const x = 1' }, null, null, fakeCtx());
    expect(bad).toMatchObject({ isError: true });
    expect(bad.content[0].text).toMatch(/export const meta/);
  });

  it('counts a workflow\'s agents and usage in the session summary', async () => {
    const { scanPiSessions } = await import('../server/pi.js');
    const dir = path.join(TMP, 'pi-sessions-wf', '--tmp-y--');
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      { type: 'session', version: 3, id: 'sess-wf', timestamp: '2026-11-23T10:00:00.000Z', cwd: '/tmp/y' },
      { type: 'message', id: 'e1', parentId: null, timestamp: '2026-11-23T10:00:01.000Z', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'Workflow', content: [{ type: 'text', text: 'ok' }], isError: false, details: { agentCount: 3, model: 'mistral/mistral-large-latest', usage: { input: 300, output: 30, cacheRead: 0, cacheWrite: 0, cost: 0.03, turns: 3 } } } },
    ];
    fs.writeFileSync(path.join(dir, '2026-11-23T10-00-00-000Z_sess-wf.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const s = scanPiSessions(path.join(TMP, 'pi-sessions-wf')).find((x) => x.id === 'sess-wf');
    expect(s.subagents).toBe(3);
    expect(s.subagentCost).toBeCloseTo(0.03, 10);
  });
});

describe('TodoWrite and AskUserQuestion in the conversation', () => {
  it('toolTodos normalises a TodoWrite list, whole, and ignores other tools', async () => {
    const { toolTodos } = await import('../server/util.js');
    const long = Array.from({ length: 30 }, (_, i) => ({ content: 'step ' + i + ' ' + 'x'.repeat(150), status: i < 2 ? 'completed' : i === 2 ? 'in_progress' : 'odd', activeForm: 'doing ' + i }));
    const out = toolTodos('TodoWrite', { todos: long });
    expect(out).toHaveLength(30); // the whole list, where toolInputText stops at 4000 characters
    expect(out[0]).toEqual({ content: long[0].content, status: 'completed', activeForm: 'doing 0' });
    expect(out[2].status).toBe('in_progress');
    expect(out[3].status).toBe('pending');
    expect(toolTodos('bash', { todos: [] })).toBeNull();
    expect(toolTodos('TodoWrite', { todos: 'nope' })).toBeNull();
  });

  it('the pi conversation carries the checklist and the question on the tool parts', async () => {
    const { buildPiConversation } = await import('../server/pi.js');
    const file = path.join(TMP, 'conv-session.jsonl');
    const todos = [{ content: 'Write the test', status: 'in_progress', activeForm: 'Writing the test' }, { content: 'Ship', status: 'pending', activeForm: 'Shipping' }];
    const questions = [{ question: 'Which db?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }];
    const lines = [
      { type: 'session', version: 3, id: 'sess-conv', timestamp: '2026-11-24T10:00:00.000Z', cwd: '/tmp/x' },
      { type: 'message', id: 'e1', parentId: null, timestamp: '2026-11-24T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
      { type: 'message', id: 'e2', parentId: 'e1', timestamp: '2026-11-24T10:00:02.000Z', message: { role: 'assistant', content: [
        { type: 'toolCall', id: 'c1', name: 'TodoWrite', arguments: { todos } },
        { type: 'toolCall', id: 'c2', name: 'AskUserQuestion', arguments: { questions } },
        { type: 'toolCall', id: 'c3', name: 'bash', arguments: { command: 'ls' } },
      ] } },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const msgs = buildPiConversation(file);
    const parts = msgs.flatMap((m) => m.parts || []).filter((p) => p.type === 'tool');
    expect(parts.map((p) => p.tool.name)).toEqual(['TodoWrite', 'AskUserQuestion', 'bash']);
    expect(parts[0].todos).toEqual(todos);
    expect(parts[1].ask).toEqual(questions);
    expect(parts[2].todos).toBeNull();
    expect(parts[2].ask).toBeNull();
  });
});

describe('TodoWrite in a Claude Code transcript', () => {
  it('the Claude conversation carries the same checklist', async () => {
    const { buildConversation } = await import('../server/conversation.js');
    const file = path.join(TMP, 'claude-conv.jsonl');
    const todos = [{ content: 'Run tests', status: 'completed', activeForm: 'Running tests' }];
    const lines = [
      { type: 'user', uuid: 'u1', timestamp: '2026-11-24T10:00:00.000Z', cwd: '/tmp/x', message: { role: 'user', content: 'go' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-11-24T10:00:01.000Z', cwd: '/tmp/x', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos } }] } },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const parts = buildConversation(file).flatMap((m) => m.parts || []).filter((p) => p.type === 'tool');
    expect(parts[0].todos).toEqual(todos);
  });
});
