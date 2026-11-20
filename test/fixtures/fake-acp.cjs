#!/usr/bin/env node
'use strict';
/*
 * Faux serveur ACP pour les tests de server/vibeAgent.js : parle JSON-RPC 2.0
 * newline-delimited sur stdio comme `vibe-acp`, selon un scénario fixe :
 *   initialize → OK ; session/new → session_id "fake-sess-1" ;
 *   session/prompt → notification tool_call, requête session/request_permission,
 *   attend la réponse du client, notification agent_message_chunk, réponse stop_reason.
 * Tout ce que le client envoie est loggé (une ligne JSON par message) dans $FAKE_ACP_LOG.
 */
const fs = require('fs');
const LOG = process.env.FAKE_ACP_LOG || null;
const log = (o) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); };

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) handle(line);
  }
});

const send = (o) => { log({ dir: 'out', ...o }); process.stdout.write(JSON.stringify(o) + '\n'); };

function handle(line) {
  let m;
  try { m = JSON.parse(line); } catch (_) { return; }
  log({ dir: 'in', ...m });
  if (m.id === undefined || m.method === undefined) return; // réponse à une de nos requêtes
  const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return reply({ protocol_version: 1, agent_capabilities: {}, auth_methods: [] });
    case 'session/new':
      return reply({ sessionId: 'fake-sess-1', modes: { currentModeId: 'ask', availableModes: [{ id: 'ask' }] }, configOptions: [] });
    case 'session/load':
      return reply({ modes: {}, config_options: [] });
    case 'session/set_config_option':
    case 'session/set_mode':
    case 'session/cancel':
    case 'session/close':
      return reply({});
    case 'session/prompt': {
      const sid = m.params.sessionId || m.params.session_id;
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'file_system.bash', status: 'in_progress' } } });
      // requête entrante : approbation d'outil
      send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: { sessionId: sid, toolCall: { toolCallId: 'tc1', title: 'file_system.bash' }, options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ] } });
      // la réponse à id=900 arrivera dans un prochain handle() → on retarde la fin du tour
      pendingPrompt = m.id;
      return;
    }
    default:
      return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown method' } });
  }
}

let pendingPrompt = null;
// Surveille la réponse à notre requête request_permission (id 900) : quand elle arrive,
// on envoie le chunk final puis on clôt le prompt.
const origHandle = handle;
process.stdin.on('data', () => {}); // no-op, le buffer est déjà traité au-dessus

// Intercepte les réponses (messages avec id mais sans method) dans le flux :
// on reparse chaque ligne brute aussi pour attraper la réponse 900.
let rawBuf = '';
process.stdin.on('data', (d) => {
  rawBuf += d;
  let nl;
  while ((nl = rawBuf.indexOf('\n')) >= 0) {
    const line = rawBuf.slice(0, nl);
    rawBuf = rawBuf.slice(nl + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch (_) { continue; }
    if (m.id === 900 && m.result && pendingPrompt != null) {
      const sid = 'fake-sess-1';
      const pid = pendingPrompt;
      pendingPrompt = null;
      log({ dir: 'out', note: 'permission answered', result: m.result });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', chunk: { type: 'text', text: 'done!' } } } });
      send({ jsonrpc: '2.0', id: pid, result: { stop_reason: 'end_turn' } });
    }
  }
});
