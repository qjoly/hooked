#!/usr/bin/env node
'use strict';
/*
 * Fake Agent Client Protocol agent for the `acp` engine tests (server/engines/acp.js). Speaks
 * newline-delimited JSON-RPC 2.0 on stdio, with a fixed scenario per session/prompt:
 *   thought chunk → text chunk → plan → tool_call → session/request_permission (waits for the
 *   client's answer) → tool_call_update with a diff → text chunk → available_commands_update →
 *   prompt result { stopReason: 'end_turn' }.
 * A prompt containing "slow" waits for a session/cancel and then ends with stopReason 'cancelled'.
 * Every message received is logged (one JSON line each) to $FAKE_ACP_LOG.
 */
const fs = require('fs');
const LOG = process.env.FAKE_ACP_LOG || null;
const log = (o) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); };
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });

let nextSession = 1;
let nextReq = 900;
const waiting = new Map(); // request id we sent -> resolver
let slowPrompt = null;     // { id, sessionId } of a prompt waiting for a cancel

const CONFIG = [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fast', options: [{ value: 'fast', name: 'Fast' }, { value: 'smart', name: 'Smart' }] },
  { id: 'thought', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
];
const MODES = { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'yolo', name: 'Bypass permissions' }, { id: 'plan', name: 'Plan' }] };

function request(method, params) {
  const id = nextReq++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

async function runPrompt(m) {
  const sid = m.params.sessionId;
  const text = (m.params.prompt || []).map((b) => b.text || '').join('');
  if (text.includes('slow')) { slowPrompt = { id: m.id, sessionId: sid }; return; }
  update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Let me think.' } });
  update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
  update(sid, { sessionUpdate: 'plan', entries: [{ content: 'Write the file', priority: 'high', status: 'in_progress' }, { content: 'Report', priority: 'low', status: 'pending' }] });
  update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write foo.txt', kind: 'edit', status: 'pending', rawInput: { path: 'foo.txt', content: 'hi' } });
  const answer = await request('session/request_permission', {
    sessionId: sid,
    toolCall: { toolCallId: 't1', title: 'Write foo.txt', kind: 'edit', rawInput: { path: 'foo.txt', content: 'hi' } },
    options: [
      { optionId: 'ok-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'ok-always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
  });
  log({ note: 'permission', answer });
  const allowed = answer && answer.outcome && answer.outcome.optionId && answer.outcome.optionId !== 'no';
  update(sid, {
    sessionUpdate: 'tool_call_update', toolCallId: 't1', status: allowed ? 'completed' : 'failed',
    content: allowed ? [{ type: 'diff', path: '/tmp/acp-fake/foo.txt', oldText: null, newText: 'hi' }] : [{ type: 'content', content: { type: 'text', text: 'rejected' } }],
  });
  update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? 'world' : 'skipped' } });
  update(sid, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review the changes' }] });
  update(sid, { sessionUpdate: 'session_info_update', title: 'Fake session title' });
  send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
}

function handle(m) {
  log({ dir: 'in', ...m });
  if (m.id !== undefined && m.method === undefined) {
    const r = waiting.get(m.id);
    if (r) { waiting.delete(m.id); r(m.result); }
    return;
  }
  const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'fake-agent', version: '0.1' }, authMethods: [] });
    case 'session/new':
      return reply({ sessionId: 'acp-sess-' + nextSession++, modes: MODES, configOptions: CONFIG });
    case 'session/load':
      update(m.params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed prompt' } });
      update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed answer' } });
      return reply({ modes: MODES, configOptions: CONFIG });
    case 'session/set_mode':
      return reply({});
    case 'session/set_config_option': {
      const opt = CONFIG.find((o) => o.id === m.params.configId);
      if (opt) opt.currentValue = m.params.value;
      return reply({ configOptions: CONFIG });
    }
    case 'session/prompt':
      runPrompt(m);
      return;
    case 'session/cancel':
      if (slowPrompt) {
        send({ jsonrpc: '2.0', id: slowPrompt.id, result: { stopReason: 'cancelled' } });
        slowPrompt = null;
      }
      return;
    default:
      if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown method ' + m.method } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)); } catch (_) { /* malformed line */ }
  }
});
process.stdin.on('end', () => process.exit(0));
