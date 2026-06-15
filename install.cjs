#!/usr/bin/env node
'use strict';
/*
 * Branche hooked sur tous les hooks Claude Code dans ~/.claude/settings.json.
 * Idempotent (ne duplique pas), préserve les hooks existants (ex: slack-notify),
 * et fait une sauvegarde avant d'écrire.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_CMD = `node ${path.join(__dirname, 'hook.cjs')}`;
const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Notification', 'Stop', 'SubagentStop', 'SessionEnd', 'PreCompact',
];

let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
catch (_) { console.log('  settings.json introuvable ou vide → création.'); }

settings.hooks = settings.hooks || {};
let added = 0;

for (const ev of EVENTS) {
  const arr = (settings.hooks[ev] = settings.hooks[ev] || []);
  const already = arr.some((g) => (g.hooks || []).some((h) => h.command === HOOK_CMD));
  if (already) continue;
  arr.push({ hooks: [{ type: 'command', command: HOOK_CMD }] });
  added++;
}

if (added > 0) {
  try { fs.copyFileSync(SETTINGS, SETTINGS + '.hooked.bak'); } catch (_) {}
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  console.log(`  ✅ hooked branché sur ${added} évènement(s). Sauvegarde: settings.json.hooked.bak`);
} else {
  console.log('  ✅ Déjà branché sur tous les évènements, rien à faire.');
}
console.log('  ↻ Redémarre tes sessions Claude Code pour activer les hooks.');
console.log('  ▶ Lance le dashboard : npm run dev (dev) ou npm run build puis npm start (prod).');
