'use strict';
/*
 * État courant de la TodoList d'une session. Claude réécrit la liste entière à
 * chaque appel de l'outil TodoWrite → le DERNIER appel fait foi. Chaque tâche :
 * { content, status (pending|in_progress|completed), activeForm }.
 *
 * Lecture cachée par mtime (comme transcript.js) : /api/sessions appelle ceci pour
 * chaque session à chaque poll, on évite donc de relire les transcripts inchangés.
 */
const fs = require('fs');
const { statSafe } = require('./util');

const cache = new Map(); // path -> { key, val }

function computeLatest(fp) {
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return null; }
  let latest = null; // { ts, todos }
  for (const line of data.split('\n')) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.type !== 'assistant' || !j.message || !Array.isArray(j.message.content)) continue;
    for (const b of j.message.content) {
      if (b && b.type === 'tool_use' && b.name === 'TodoWrite' && b.input && Array.isArray(b.input.todos)) {
        latest = {
          ts: j.timestamp || null,
          todos: b.input.todos.map((t) => ({
            content: String((t && t.content) || ''),
            status: (t && (t.status === 'completed' || t.status === 'in_progress')) ? t.status : 'pending',
            activeForm: String((t && t.activeForm) || ''),
          })),
        };
      }
    }
  }
  return latest;
}

// dernier état de TodoList du transcript (ou null si l'outil n'a jamais servi).
function latestTodos(fp) {
  const st = statSafe(fp);
  const key = st ? st.mtimeMs + ':' + st.size : null;
  if (key) { const c = cache.get(fp); if (c && c.key === key) return c.val; }
  const val = computeLatest(fp);
  if (key) cache.set(fp, { key, val });
  return val;
}

// résumé compact pour la liste/sidebar : compteurs + libellé de la tâche en cours.
function todoSummary(latest) {
  if (!latest || !latest.todos || !latest.todos.length) return null;
  const todos = latest.todos;
  const inProgress = todos.find((t) => t.status === 'in_progress');
  return {
    total: todos.length,
    done: todos.filter((t) => t.status === 'completed').length,
    current: inProgress ? (inProgress.activeForm || inProgress.content) : null,
  };
}

module.exports = { latestTodos, todoSummary };
