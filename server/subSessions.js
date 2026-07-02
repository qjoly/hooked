/*
 * Sessions "sœurs" que CETTE conversation a créées ou référencées, rendues en cartes vivantes
 * dans le sous-onglet « Sub-sessions » du détail. Deux sources :
 *   - REFERENCED : un lien profond markdown `[label](/session/<id>)` apparaît dans le texte
 *     d'un message (assistant ou utilisateur). Même forme que les <SessionCard> inline.
 *   - CREATED    : un `tool_use` `mcp__hooked__start_session` dont le `tool_result` apparié
 *     (par tool_use_id) contient un lien `/session/<id>` (l'id de la session tout juste lancée ;
 *     cf. mcp/server.cjs → /api/launch qui renvoie le `link`).
 * Union dédupliquée par id, dans l'ordre de PREMIÈRE apparition ; l'id de la session courante
 * est toujours exclu (une conversation ne se liste jamais elle-même).
 */
import fs from 'node:fs';
import { toolResultText } from './util.js';

// `[label](/session/<id>)` — 1 = label, 2 = id (ni /, ?, #, ) ni espace dans l'id).
const MD_SESSION_LINK = /\[([^\]]*)\]\(\/session\/([^/?#)\s]+)\)/g;
// `/session/<id>` nu dans un tool_result (ex. `"link":"/session/<id>"`) — 1 = id.
const RAW_SESSION_LINK = /\/session\/([^/?#"'\s\\)]+)/;

// dé-échappe l'id (le lien est émis via encodeURIComponent) ; no-op sur un uuid classique.
function decodeId(raw) {
  try { return decodeURIComponent(raw); } catch (_) { return raw; }
}

function buildSubSessions(fp, selfId) {
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return []; }
  const lines = data.split('\n');
  // passe 1 : index des résultats d'outils par tool_use_id (texte concaténé, comme la conversation).
  const results = new Map();
  for (const line of lines) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.type === 'user' && j.message && Array.isArray(j.message.content)) {
      for (const b of j.message.content) {
        if (b && b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, toolResultText(b.content));
      }
    }
  }
  const out = [];
  const seen = new Set();
  const add = (rawId, label, source) => {
    if (!rawId) return;
    const id = decodeId(rawId);
    if (!id || id === selfId || seen.has(id)) return; // jamais la session courante ni un doublon
    seen.add(id);
    out.push({ id, label: (label || '').trim(), source });
  };
  const scanText = (text) => {
    for (const m of String(text).matchAll(MD_SESSION_LINK)) add(m[2], m[1], 'referenced');
  };
  for (const line of lines) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.isSidechain) continue; // le transcript principal seulement (cf. buildConversation)
    if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      for (const b of j.message.content) {
        if (b.type === 'text' && b.text) {
          scanText(b.text);
        } else if (b.type === 'tool_use' && b.name === 'mcp__hooked__start_session' && b.id) {
          const res = results.get(b.id);
          const m = res ? RAW_SESSION_LINK.exec(res) : null; // 1er /session/<id> du résultat = session créée
          if (m) add(m[1], '', 'created');
        }
      }
    } else if (j.type === 'user' && j.message) {
      const c = j.message.content;
      if (typeof c === 'string') scanText(c);
      else if (Array.isArray(c)) for (const b of c) if (b && b.type === 'text' && b.text) scanText(b.text);
    }
  }
  return out;
}

export { buildSubSessions };
