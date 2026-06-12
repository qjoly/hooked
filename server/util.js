'use strict';
/* Utilitaires fs + extraction de texte depuis les contenus de messages/outils. */
const fs = require('fs');

const readdirSafe = (p) => { try { return fs.readdirSync(p); } catch (_) { return []; } };
const statSafe = (p) => { try { return fs.statSync(p); } catch (_) { return null; } };

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  }
  return '';
}
function cleanPrompt(t) {
  if (!t) return '';
  t = String(t);
  if (/^<local-command-caveat/.test(t)) return '';
  const cmd = t.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd) return cmd[1].trim();
  t = t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

// extrait un texte lisible d'un contenu de message (chat)
function chatText(content) {
  if (typeof content === 'string') {
    let t = content;
    if (/^<local-command-caveat/.test(t) || /<local-command-stdout>/.test(t)) return '';
    const cmd = t.match(/<command-name>([^<]+)<\/command-name>/);
    if (cmd) {
      const args = t.match(/<command-args>([^<]*)<\/command-args>/);
      return (cmd[1] + (args && args[1] ? ' ' + args[1] : '')).trim();
    }
    return t.replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim();
  }
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n').trim();
  }
  return '';
}
function toolDetail(input) {
  if (!input || typeof input !== 'object') return '';
  const f = input.command || input.file_path || input.path || input.pattern || input.query || input.url || input.description || input.prompt;
  return f ? String(f).replace(/\s+/g, ' ').slice(0, 140) : '';
}

// texte lisible d'un tool_result (contenu string, ou tableau de blocs text/image).
function toolResultText(content) {
  if (typeof content === 'string') return content.slice(0, 4000);
  if (Array.isArray(content)) {
    const t = content.map((b) => {
      if (!b) return '';
      if (b.type === 'text') return b.text || '';
      if (b.type === 'image') return '[image]';
      return '';
    }).filter(Boolean).join('\n');
    return t.slice(0, 4000);
  }
  return '';
}
// input d'un tool_use, en JSON indenté tronqué. Les très gros champs (ex. contenu d'un
// Write, déjà visible dans l'onglet Fichiers) sont coupés pour garder un payload léger.
function toolInputText(input) {
  if (input == null || typeof input !== 'object') return '';
  try {
    return JSON.stringify(input, (k, v) => (typeof v === 'string' && v.length > 1500 ? v.slice(0, 1500) + '\n… (tronqué)' : v), 2).slice(0, 4000);
  } catch (_) { return ''; }
}

module.exports = { readdirSafe, statSafe, textOf, cleanPrompt, chatText, toolDetail, toolResultText, toolInputText };
