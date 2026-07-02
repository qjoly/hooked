/*
 * Détection des jobs/veilleurs de FOND encore actifs dans le transcript d'une session.
 *
 * Quand un agent arme un job de fond (Bash `run_in_background`, un `Monitor` en boucle, ou un
 * `ScheduleWakeup`) son tour se termine → le hook Stop tire → hooked marque la session `waiting`.
 * Mais l'utilisateur n'est PAS le bloquant : un job tourne encore et ré-invoquera l'agent plus tard.
 * On reconstruit le CYCLE DE VIE de chaque job depuis le transcript (même esprit que la détection
 * AskUserQuestion « posé vs répondu » de transcript.js) pour distinguer « encore actif » de
 * « terminé/consommé ». Lecture cachée par mtime (comme todos.js / transcript.js) : buildSessions
 * appelle ceci pour chaque session à chaque poll → on évite de relire un transcript inchangé.
 *
 * Signaux (observés sur de vrais transcripts) :
 *   - Bash run_in_background : tool_use Bash + input.run_in_background === true. Le tool_result
 *     renvoie AUSSITÔT « Command running in background with ID: <id>. … ».
 *   - Monitor : tool_use Monitor. tool_result « Monitor started (task <id>, … ».
 *   - ScheduleWakeup : tool_use ScheduleWakeup + input.prompt. tool_result « Next wakeup
 *     scheduled for … ». DÉCLENCHÉ (consommé) : une ligne user injectée promptSource:"sdk" +
 *     isMeta dont message.content == le prompt planifié.
 *
 * COMPLÉTION d'un Bash bg / Monitor : une `<task-notification>` livrée de façon REDONDANTE et
 * INCOHÉRENTE selon TROIS porteurs (une même complétion n'apparaît pas forcément dans les trois) :
 *   1. `{ type:"queue-operation", content:"<task-notification>…" }`
 *   2. `{ type:"user", promptSource:"system", message.content:"<task-notification>…" }`
 *   3. `{ type:"attachment", attachment:{ type:"queued_command", prompt:"<task-notification>…" } }`
 * La notif porte `<tool-use-id>` (= l'id du tool_use d'armement → corrélation FIABLE), `<task-id>`,
 * `<status>` (completed/failed/…) et `<summary>`. On clôt le job dès qu'un statut terminal arrive
 * (repli : « completed (exit code N) » / « EXIT rc=N » dans le résumé, pour l'ancien format sans
 * <status>). Un TaskStop {task_id} clôt aussi (arrêt explicite).
 */
import fs from 'node:fs';
import { statSafe } from './util.js';

const cache = new Map(); // path -> { key, val }

const RE_BASH_ID = /running in background with ID:\s*(\S+?)[.\s]/i;
const RE_MONITOR_ID = /Monitor started \(task\s+(\S+?)[,)]/i;
// chemin du fichier de sortie d'un Bash run_in_background (« Output is being written to: <path>.output »).
const RE_OUTPUT = /Output is being written to:\s*(\S+?\.output)\b/i;
const RE_NOTE_TOOLUSE = /<tool-use-id>\s*(\S+?)\s*<\/tool-use-id>/i;
const RE_NOTE_TASK = /<task-id>\s*(\S+?)\s*<\/task-id>/i;
const RE_NOTE_STATUS = /<status>\s*([\w-]+)\s*<\/status>/i;
const RE_EXIT_CODE = /exit code\s+(-?\d+)/i;
const RE_EXIT_RC = /EXIT rc=(-?\d+)/i;

// statuts terminaux d'une <task-notification> (tout le reste = encore en cours : running/pending/…).
const TERMINAL = new Set(['completed', 'complete', 'done', 'exited', 'failed', 'error', 'errored', 'killed', 'stopped', 'cancelled', 'canceled', 'timeout', 'timedout', 'timed_out', 'interrupted']);

// texte d'un `content` de tool_result / message : string, ou tableau de blocs { type:'text' }.
function textOfContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('\n');
  return '';
}

// extrait la chaîne <task-notification>…</task-notification> quel que soit son porteur, sinon null.
function taskNotification(j) {
  if (j.type === 'queue-operation' && typeof j.content === 'string' && j.content.includes('<task-notification>')) return j.content;
  if (j.type === 'attachment' && j.attachment && j.attachment.type === 'queued_command' && typeof j.attachment.prompt === 'string') return j.attachment.prompt;
  if (j.type === 'user' && j.message && typeof j.message.content === 'string' && j.message.content.includes('<task-notification>')) return j.message.content;
  return null;
}

function compute(fp) {
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return { jobs: [], active: [] }; }

  const jobsByToolUse = new Map(); // tool_use_id (armement) -> job (bash | monitor)
  const jobsByTask = new Map();    // task-id (résolu depuis le tool_result) -> job
  // ScheduleWakeup : le harnais ne garde qu'UN wakeup en attente par session — chaque nouvel appel
  // REMPLACE le précédent. On ne suit donc que le dernier, repéré par sa position. Il est encore en
  // attente SEULEMENT si rien n'a « repris » après lui (le déclenchement produit une ligne d'activité
  // à un index supérieur). Modèle positionnel → robuste au promptSource variable (sdk/system) et au
  // contenu réécrit à la volée, contrairement à un appariement de texte.
  let wakeup = null;       // dernier ScheduleWakeup { kind:'wakeup', …, idx }
  let lastResumeIdx = -1;  // dernier index d'une activité de reprise (notif, tool non-wakeup, prompt)
  let idx = -1;

  for (const line of data.split('\n')) {
    if (!line) continue;
    idx++;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    const ts = j.timestamp || null;

    // A) task-notification (tous porteurs) : complétion d'un Bash bg / Monitor. Idempotent (une
    //    même notif peut arriver en double sur plusieurs porteurs → on ne clôt qu'une fois). C'est
    //    aussi une reprise (ré-invocation) → bump lastResumeIdx.
    const note = taskNotification(j);
    if (note) {
      lastResumeIdx = idx;
      const tu = (note.match(RE_NOTE_TOOLUSE) || [])[1];
      const tid = (note.match(RE_NOTE_TASK) || [])[1];
      const status = (note.match(RE_NOTE_STATUS) || [])[1];
      const job = (tu && jobsByToolUse.get(tu)) || (tid && jobsByTask.get(tid)) || null;
      const terminalStatus = status && TERMINAL.has(status.toLowerCase());
      const bashCompleted = /completed \(exit code/i.test(note); // repli ancien format (sans <status>)
      const monitorExited = RE_EXIT_RC.test(note);
      if (job && !job.done && (terminalStatus || (job.kind === 'bash' && bashCompleted) || (job.kind === 'monitor' && monitorExited))) {
        job.done = true;
        job.doneReason = terminalStatus ? status.toLowerCase() : (job.kind === 'monitor' ? 'exited' : 'completed');
        job.doneAt = ts;
        const ec = note.match(RE_EXIT_RC) || note.match(RE_EXIT_CODE);
        if (ec) job.exitCode = Number(ec[1]);
      }
      continue; // une notif n'est jamais un armement ni un tool_result exploitable
    }

    // B) tool_use assistant : armement (Bash bg / Monitor / ScheduleWakeup) + arrêt explicite (TaskStop).
    if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      let hasNonWakeupTool = false;
      for (const b of j.message.content) {
        if (!b || b.type !== 'tool_use') continue;
        if (b.name !== 'ScheduleWakeup') hasNonWakeupTool = true;
        const inp = b.input || {};
        if (b.name === 'Bash' && inp.run_in_background === true && b.id) {
          jobsByToolUse.set(b.id, { kind: 'bash', toolUseId: b.id, taskId: null, command: String(inp.command || '').slice(0, 2000), description: String(inp.description || ''), startTs: ts, done: false, doneReason: null, doneAt: null, exitCode: null, outputPath: null });
        } else if (b.name === 'Monitor' && b.id) {
          jobsByToolUse.set(b.id, { kind: 'monitor', toolUseId: b.id, taskId: null, command: String(inp.command || '').slice(0, 2000), description: String(inp.description || ''), startTs: ts, done: false, doneReason: null, doneAt: null, exitCode: null, outputPath: null });
        } else if (b.name === 'ScheduleWakeup') {
          const prompt = String(inp.prompt || '').slice(0, 2000);
          wakeup = { kind: 'wakeup', toolUseId: b.id || null, taskId: null, command: prompt, prompt, description: String(inp.reason || '').slice(0, 500), startTs: ts, done: false, doneReason: null, doneAt: null, exitCode: null, outputPath: null, idx };
        } else if (b.name === 'TaskStop' && inp.task_id) {
          const job = jobsByTask.get(inp.task_id);
          if (job && !job.done) { job.done = true; job.doneReason = 'stopped'; job.doneAt = ts; }
        }
      }
      // un tour qui fait un vrai travail (autre chose que planifier un wakeup) = reprise
      if (hasNonWakeupTool) lastResumeIdx = idx;
    }

    // C) tool_result user : le task-id des Bash bg / Monitor n'apparaît QUE dans le résultat →
    //    on le résout pour permettre la corrélation par task-id (repli si <tool-use-id> absent).
    if (j.type === 'user' && j.message && Array.isArray(j.message.content)) {
      for (const b of j.message.content) {
        if (!b || b.type !== 'tool_result' || !b.tool_use_id) continue;
        const job = jobsByToolUse.get(b.tool_use_id);
        if (!job || job.taskId) continue;
        const txt = textOfContent(b.content);
        const m = job.kind === 'bash' ? txt.match(RE_BASH_ID) : txt.match(RE_MONITOR_ID);
        if (m) { job.taskId = m[1]; jobsByTask.set(m[1], job); }
        // fichier de sortie du Bash bg (pour le tail live) : seulement si la forme attendue
        // (…/tasks/<id>.output) — garde-fou contre un chemin exotique injecté dans le transcript.
        const om = txt.match(RE_OUTPUT);
        if (om && om[1].includes('/tasks/')) job.outputPath = om[1];
      }
    }

    // D) prompt / ligne user injectée (hors tool_result et hors task-notification déjà traitée) =
    //    reprise : déclenchement d'un wakeup (sdk/system) ou message humain → bump lastResumeIdx.
    if (j.type === 'user' && j.message) {
      const c = j.message.content;
      const isToolResult = Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
      if (!isToolResult) lastResumeIdx = idx;
    }
  }

  // le wakeup n'est en attente que si RIEN n'a repris après lui (sinon il a été déclenché/remplacé).
  if (wakeup && lastResumeIdx > wakeup.idx) { wakeup.done = true; wakeup.doneReason = 'fired'; }

  const jobs = [...jobsByToolUse.values(), ...(wakeup ? [wakeup] : [])];
  const active = jobs.filter((x) => !x.done);
  return { jobs, active };
}

// cycle de vie complet des jobs de fond du transcript (caché par mtime). fp falsy → aucun job.
function buildBackgroundJobs(fp) {
  const st = fp ? statSafe(fp) : null;
  const key = st ? st.mtimeMs + ':' + st.size : null;
  if (key) { const c = cache.get(fp); if (c && c.key === key) return c.val; }
  const val = fp ? compute(fp) : { jobs: [], active: [] };
  if (key) cache.set(fp, { key, val });
  return val;
}

// jobs de fond ENCORE ACTIFS uniquement (forme légère pour la sidebar). [] si le fichier est absent.
function activeBackgroundJobs(fp) {
  return buildBackgroundJobs(fp).active;
}

export { buildBackgroundJobs, activeBackgroundJobs };
