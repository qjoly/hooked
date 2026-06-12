#!/usr/bin/env node
'use strict';
/*
 * hooked — capteur d'évènements de hooks Claude Code.
 *
 * Branché sur TOUS les hooks (SessionStart, UserPromptSubmit, PreToolUse,
 * PostToolUse, Notification, Stop, SubagentStop, SessionEnd, PreCompact).
 * Lit le JSON du hook sur stdin et append une ligne compacte dans
 * ~/.claude/hooked/events.jsonl. Ne bloque jamais Claude : ne sort rien,
 * exit 0 quoi qu'il arrive.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.claude', 'hooked');
const FILE = path.join(DIR, 'events.jsonl');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => { try { handle(raw); } catch (_) {} process.exit(0); });
process.stdin.on('error', () => process.exit(0));
// Filet de sécurité : si pas de stdin, on sort quand même.
setTimeout(() => { try { handle(raw); } catch (_) {} process.exit(0); }, 2500);

function handle(input) {
  let j = {};
  try { j = JSON.parse(input); } catch (_) {}
  const rec = {
    ts: new Date().toISOString(),
    event: j.hook_event_name || process.argv[2] || 'unknown',
    session_id: j.session_id || null,
    cwd: j.cwd || null,
    transcript: j.transcript_path || null,
    tool: j.tool_name || null,
    // mode de permission courant (default / acceptEdits / plan / bypassPermissions) : présent
    // sur tous les payloads de hooks → seule source pour savoir dans quel mode tourne la session
    // (le transcript ne le porte pas). Sert au dashboard pour afficher/changer le mode.
    mode: j.permission_mode || null,
    // input d'AskUserQuestion : capturé au PreToolUse car le tool_use n'est écrit dans
    // le transcript qu'une fois la question répondue → c'est la seule source de la
    // question tant qu'elle est *en attente*. (questions : [{question, header, options, multiSelect}])
    ask: (j.tool_name === 'AskUserQuestion' && j.tool_input && Array.isArray(j.tool_input.questions))
      ? j.tool_input.questions
      : null,
    message: typeof j.message === 'string' ? j.message.slice(0, 500) : null,
    // pane tmux de la session (hérité de l'env du process Claude) → permet de
    // renvoyer une réponse dans la session interactive via `tmux send-keys`.
    tmux_pane: process.env.TMUX_PANE || null,
  };
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {}
  try { fs.appendFileSync(FILE, JSON.stringify(rec) + '\n'); } catch (_) {}
}
