/*
 * `acp` engine (server/engines/acp.js) end to end against a fake ACP agent
 * (test/fixtures/acp/fake-agent.cjs): launch with model / effort / mode, the permission card,
 * the journal hooked keeps (conversation, todos, trace, title), cancel, kill and resume through
 * session/load (whose replay must not be journaled twice). No network, no real agent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-acp-'));
process.env.HOOKED_AGENT_SESSIONS_DIR = path.join(TMP, 'journals');
const AGENT = path.join(import.meta.dirname, 'fixtures', 'acp', 'fake-agent.cjs');
const LOG = path.join(TMP, 'agent.log');
const CWD = path.join(TMP, 'project');
fs.mkdirSync(CWD, { recursive: true });

let acpEngine, journal;
beforeAll(async () => {
  ({ acpEngine } = await import('../server/engines/acp.js'));
  journal = await import('../server/engines/journal.js');
});
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

const PROVIDER = {
  id: 'fake', engine: 'acp', label: 'Fake agent', command: process.execPath, args: [AGENT],
  env: { FAKE_ACP_LOG: LOG },
};

function newSt() {
  return {
    id: null, provider: 'fake', engine: 'acp', providerConfig: PROVIDER, cwd: CWD,
    autoApprove: false, busy: false, sdkState: 'idle', pendingAsk: null, stream: null, permissionMode: 'default',
  };
}

function start(st, opts = {}) {
  return new Promise((resolve, reject) => {
    acpEngine.driver.start(st, { env: process.env, ...opts }, {
      setLive() {}, persistLaunch() {}, emit() {},
      done: (s) => resolve(s || st),
      failStartup: () => reject(new Error(st.error || 'start failed')),
      hookedMcp: () => ({ command: 'node', args: ['/x/mcp/server.cjs'], env: { HOOKED_PORT: '4123', HOOKED_LAUNCH_KEY: 'launch:test' } }),
    });
  });
}

async function until(fn, ms = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not reached in time');
}

const received = () => fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.dir === 'in');

describe('acp engine', () => {
  let st;
  let sessionId;

  it('starts a session, applies model / effort / mode and hands hooked\'s MCP server over', async () => {
    st = newSt();
    await start(st, { prompt: 'do it', model: 'smart', effort: 'high', permissionMode: 'bypassPermissions' });
    sessionId = st.id;
    expect(sessionId).toMatch(/^acp-sess-/);
    const msgs = received();
    const init = msgs.find((m) => m.method === 'initialize');
    expect(init.params.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    const neu = msgs.find((m) => m.method === 'session/new');
    expect(neu.params.cwd).toBe(CWD);
    expect(neu.params.mcpServers).toEqual([{
      name: 'hooked', command: 'node', args: ['/x/mcp/server.cjs'],
      env: [{ name: 'HOOKED_PORT', value: '4123' }, { name: 'HOOKED_LAUNCH_KEY', value: 'launch:test' }],
    }]);
    const sets = msgs.filter((m) => m.method === 'session/set_config_option').map((m) => [m.params.configId, m.params.value]);
    expect(sets).toEqual([['model', 'smart'], ['thought', 'high']]);
    // hooked's bypassPermissions → the agent mode named "Bypass permissions"
    expect(msgs.find((m) => m.method === 'session/set_mode').params.modeId).toBe('yolo');
    expect(st.model).toBe('smart');
    expect(st.permissionMode).toBe('bypassPermissions');
  });

  it('surfaces the permission request as the 3-option card and answers with the agent\'s option id', async () => {
    await until(() => st.pendingAsk && st.pendingAsk.kind === 'permission');
    expect(st.pendingAsk.toolName).toBe('Write foo.txt');
    expect(st.sdkState).toBe('requires_action');
    st.pendingAsk.resolve({ behavior: 'allow', allowAlways: true });
    await until(() => !st.acpTurn && !st.busy);
    const answered = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.note === 'permission');
    expect(answered.answer).toEqual({ outcome: { outcome: 'selected', optionId: 'ok-always' } });
    expect(st.liveCommands).toEqual([{ name: 'review', description: 'Review the changes', argumentHint: '' }]);
  });

  it('journals the turn: conversation, todos, trace and the agent\'s title', () => {
    const [s] = journal.scanJournal(['fake']);
    expect(s.id).toBe(sessionId);
    expect(s.provider).toBe('fake');
    expect(s.project).toBe(CWD);
    expect(s.title).toBe('Fake session title');
    expect(s.userPrompts).toBe(1);
    expect(s.model).toBe('smart');
    const conv = journal.journalConversation(s.file);
    expect(conv.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(conv[0].text).toBe('do it');
    const a = conv[1];
    // Prose is split around the tool call, in wire order (like the pi and Claude views).
    expect(a.parts.map((x) => x.type)).toEqual(['thinking', 'text', 'tool', 'text']);
    expect(a.parts.filter((x) => x.type === 'text').map((x) => x.text)).toEqual(['Hello ', 'world']);
    expect(a.thinking).toBe('Let me think.');
    expect(a.tools).toHaveLength(1);
    expect(a.tools[0]).toMatchObject({ id: 't1', name: 'edit', detail: 'Write foo.txt', status: 'done' });
    expect(a.tools[0].diff).toBeTruthy();
    expect(journal.journalTodos(s.file).todos.map((t) => [t.content, t.status])).toEqual([['Write the file', 'in_progress'], ['Report', 'pending']]);
    const trace = journal.journalTrace(s.file);
    expect(trace.turns).toHaveLength(1);
    expect(trace.turns[0].spans.map((x) => x.id)).toEqual(['t1']);
    expect(journal.journalToolPaths(s.file)).toContain('/tmp/acp-fake/foo.txt');
  });

  it('learns the launch options from the live session', async () => {
    const o = await acpEngine.options(PROVIDER);
    expect(o.models.map((m) => m.name)).toEqual(['fast', 'smart']);
    expect(o.thinkingLevels).toEqual(['low', 'high']);
    const modes = Object.fromEntries(o.modes.map((m) => [m.id, m.label]));
    expect(modes.default).toBe('default (ask)');
    expect(modes.plan).toBe('plan (plan)');
    expect(modes.bypassPermissions).toBe('bypassPermissions (yolo)');
    expect(modes.acceptEdits).toBeUndefined();
  });

  it('cancels a running turn through the session/cancel notification', async () => {
    const p = acpEngine.driver.prompt(st, 'slow please');
    await until(() => st.acpTurn);
    await acpEngine.driver.cancel(st);
    const res = await p;
    expect(res.stopReason).toBe('cancelled');
    expect(st.busy).toBe(false);
    expect(received().some((m) => m.method === 'session/cancel' && m.id === undefined)).toBe(true);
  });

  it('resumes through session/load without journaling the replay twice', async () => {
    acpEngine.driver.kill(st);
    expect(st.ended).toBe(true);
    const before = journal.journalConversation(journal.scanJournal(['fake'])[0].file).length;
    const st2 = newSt();
    await start(st2, { resumeId: sessionId });
    expect(st2.id).toBe(sessionId);
    expect(received().some((m) => m.method === 'session/load' && m.params.sessionId === sessionId)).toBe(true);
    const after = journal.journalConversation(journal.scanJournal(['fake'])[0].file).length;
    expect(after).toBe(before);
    acpEngine.driver.kill(st2);
  });

  it('archives and restores a journal through the trash rename', () => {
    const [s] = journal.scanJournal(['fake']);
    expect(acpEngine.setArchived(s, true)).toBe(true);
    expect(journal.scanJournal(['fake'])).toHaveLength(0);
    const trashed = journal.findTrashedJournal(s.id);
    expect(trashed).toBe(s.file + '.trashed');
    expect(journal.journalSetArchived(trashed, false)).toBe(true);
    expect(journal.scanJournal(['fake'])).toHaveLength(1);
  });
});
