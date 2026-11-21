#!/usr/bin/env node
'use strict';
/*
 * hooked — capteur d'évènements Mistral Vibe (provider "vibe", cf. docs/port-vibe.md).
 *
 * Branché via ~/.vibe/hooks.toml (voir scripts/hooks-vibe.toml) sur les hooks Vibe :
 * session_start, pre_agent, pre_llm, post_llm, pre_tool, post_tool, post_agent,
 * notification, session_end. Lit le JSON du hook sur stdin et append une ligne
 * NORMALISÉE (mêmes noms d'évènements que hook.cjs côté Claude) dans
 * $HOOKED_VIBE_DATA_DIR/events.jsonl (défaut ~/.vibe/hooked/events.jsonl).
 * Le serveur lit ce fichier exactement comme events.jsonl de Claude (cf. server/events.js),
 * donc live.js / le Deck / les états de session marchent sans modification.
 *
 * Ne bloque jamais Vibe : ne sort rien, exit 0 quoi qu'il arrive.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const VIBE_HOME = process.env.VIBE_HOME || path.join(os.homedir(), '.vibe');
const DIR = process.env.HOOKED_VIBE_DATA_DIR || path.join(VIBE_HOME, 'hooked');
const FILE = path.join(DIR, 'events.jsonl');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => { try { handle(raw); } catch (_) {} process.exit(0); });
process.stdin.on('error', () => process.exit(0));
// Filet de sécurité : si pas de stdin, on sort quand même.
setTimeout(() => { try { handle(raw); } catch (_) {} process.exit(0); }, 2500);

// agent Vibe → mode de permission hooked (affiché/changé depuis le dashboard).
const MODE_BY_AGENT = {
  ask: 'default',
  'accept-edits': 'acceptEdits',
  'auto-approve': 'bypassPermissions',
  'smart-approve': 'auto',
};
// noms d'outils Vibe → noms d'outils Claude reconnus par server/live.js.
const TOOL_RENAME = { ask_user_question: 'AskUserQuestion', exit_plan_mode: 'ExitPlanMode' };

function shortTool(name) {
  if (!name) return null;
  const last = String(name).split('.').pop();
  return TOOL_RENAME[last] || last;
}

function handle(input) {
  let j = {};
  try { j = JSON.parse(input); } catch (_) {}
  const ev = j.hook_event_name || 'unknown';
  const rec = {
    ts: new Date().toISOString(),
    event: ev,
    session_id: j.session_id || null,
    cwd: j.cwd || null,
    transcript: j.transcript_path || null,
    provider: 'vibe',
    mode: MODE_BY_AGENT[j.agent_name] || null,
    model: j.model || null,
  };
  switch (ev) {
    case 'session_start':
      rec.event = 'SessionStart';
      break;
    case 'pre_agent':
      rec.event = 'UserPromptSubmit';
      rec.prompt = typeof j.prompt === 'string' ? j.prompt : null;
      break;
    case 'pre_tool':
      rec.event = 'PreToolUse';
      rec.tool = shortTool(j.tool_name);
      rec.tool_input = j.tool_input || null;
      // AskUserQuestion : capturé au pre_tool car le tool n'est journalisé qu'une fois répondu.
      if (rec.tool === 'AskUserQuestion' && j.tool_input && Array.isArray(j.tool_input.questions)) {
        rec.ask = j.tool_input.questions;
      }
      if (rec.tool === 'ExitPlanMode' && j.tool_input && typeof j.tool_input.plan === 'string') {
        rec.plan = j.tool_input.plan;
      }
      break;
    case 'post_tool':
      rec.event = 'PostToolUse';
      rec.tool = shortTool(j.tool_name);
      break;
    case 'post_agent':
      rec.event = 'Stop'; // fin de tour : la session attend l'utilisateur
      break;
    case 'notification': {
      const nt = j.notification_type || '';
      if (nt === 'approval_requested') {
        // live.js rend « attention » sur /permission|approve|allow|autoris/i
        rec.event = 'Notification';
        rec.message = 'permission: ' + (j.tool_name || j.message || 'tool call');
        rec.tool = shortTool(j.tool_name);
      } else if (nt === 'question_asked') {
        rec.event = 'Notification';
        rec.message = 'question: ' + (j.message || '');
      } else if (nt === 'turn_completed') {
        rec.event = 'Stop';
      } else if (nt === 'turn_failed') {
        rec.event = 'Stop';
        rec.message = j.message || 'turn failed';
      } else {
        rec.event = 'Notification';
        rec.message = j.message || nt;
      }
      break;
    }
    case 'session_end':
      rec.event = 'SessionEnd';
      break;
    case 'pre_llm':
    case 'post_llm':
      // évènement neutre pour l'état live (working), mais porteur du modèle et de l'usage.
      rec.event = 'VibeLLM';
      if (j.usage) rec.usage = j.usage;
      if (typeof j.response_text === 'string') rec.message = j.response_text;
      break;
    default:
      break; // event tel quel (live.js a un default « working/idle »)
  }
  if (process.env.HOOKED_RC) rec.rc = true; // démons remote-control : masqués de la sidebar
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(rec) + '\n');
  } catch (_) {}
}
