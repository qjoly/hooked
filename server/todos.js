/*
 * État courant de la liste de tâches d'une session. Deux systèmes coexistent selon
 * la version de Claude Code :
 *   - ANCIEN (< 2.1.x) : outil `TodoWrite`. Claude réécrit la liste entière à chaque
 *     appel → le DERNIER appel fait foi.
 *   - NOUVEAU (≥ 2.1.x) : outils `TaskCreate` / `TaskUpdate`. La liste se construit de
 *     façon incrémentale. `TaskCreate {subject, description, activeForm}` ajoute une
 *     tâche (id séquentiel 1-based, cf. « Task #N created »). `TaskUpdate {taskId,
 *     status}` change son statut (pending|in_progress|completed|deleted).
 *
 * On normalise les deux vers la même forme { content, status, activeForm } pour que le
 * front (Todos.svelte + résumé sidebar) reste inchangé. Une session n'utilise qu'un seul
 * système ; si on voit le moindre évènement Task*, il prime sur TodoWrite.
 *
 * Lecture cachée par mtime (comme transcript.js) : /api/sessions appelle ceci pour
 * chaque session à chaque poll, on évite donc de relire les transcripts inchangés.
 */
import { incrementalReader } from './incremental.js';

// pending par défaut ; seuls completed/in_progress sont retenus tels quels.
function normStatus(s) {
  return (s === 'completed' || s === 'in_progress') ? s : 'pending';
}

// Accumulateur résumant l'état des tâches. Append-only → réutilisable en parse incrémental
// (cf. server/incremental.js) : la Map de tâches, le compteur d'id et le dernier TodoWrite
// persistent entre polls, on ne replie que les lignes ajoutées.
function newAcc() {
  return {
    todoLatest: null,   // ancien système : { ts, todos } du dernier TodoWrite
    tasks: new Map(),   // nouveau système : id -> { content, status, activeForm }
    taskCounter: 0,     // id séquentiel attribué à chaque TaskCreate (1-based)
    taskTs: null,       // timestamp du dernier évènement Task*
    sawTask: false,
  };
}

function foldLine(acc, line) {
  if (!line) return;
  let j;
  try { j = JSON.parse(line); } catch (_) { return; }
  if (j.type !== 'assistant' || !j.message || !Array.isArray(j.message.content)) return;
  const ts = j.timestamp || null;
  for (const b of j.message.content) {
    if (!b || b.type !== 'tool_use' || !b.input) continue;

    if (b.name === 'TodoWrite' && Array.isArray(b.input.todos)) {
      acc.todoLatest = {
        ts,
        todos: b.input.todos.map((t) => ({
          content: String((t && t.content) || ''),
          status: normStatus(t && t.status),
          activeForm: String((t && t.activeForm) || ''),
        })),
      };
    } else if (b.name === 'TaskCreate') {
      const id = ++acc.taskCounter;
      acc.tasks.set(id, {
        content: String(b.input.subject || ''),
        status: 'pending',
        activeForm: String(b.input.activeForm || ''),
        description: String(b.input.description || ''),
      });
      acc.sawTask = true;
      acc.taskTs = ts;
    } else if (b.name === 'TaskUpdate') {
      acc.sawTask = true;
      acc.taskTs = ts;
      const id = Number(b.input.taskId);
      if (!Number.isFinite(id) || !acc.tasks.has(id)) continue;
      if (b.input.status === 'deleted') { acc.tasks.delete(id); continue; }
      const cur = acc.tasks.get(id);
      if (b.input.status) cur.status = normStatus(b.input.status);
      if (b.input.subject) cur.content = String(b.input.subject);
      if (b.input.activeForm) cur.activeForm = String(b.input.activeForm);
      if (b.input.description) cur.description = String(b.input.description);
    }
  }
}

function finalize(acc) {
  if (acc.sawTask) return { ts: acc.taskTs, todos: [...acc.tasks.values()] };
  return acc.todoLatest;
}

// dernier état de la liste de tâches du transcript (ou null si aucun outil n'a servi), caché et
// incrémental (append-only → on ne replie que les octets ajoutés à chaque poll).
const latestTodos = incrementalReader({ init: newAcc, fold: foldLine, finalize, empty: null });

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

export { latestTodos, todoSummary };
