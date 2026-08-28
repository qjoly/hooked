/*
 * Détection des jobs/veilleurs de FOND encore actifs dans le transcript d'une session.
 *
 * Quand un agent arme un job de fond (Bash `run_in_background`, un `Monitor` en boucle, un
 * `ScheduleWakeup`, ou un sous-agent lancé en fond via `Agent`/`Task`) son tour se termine → le hook
 * Stop tire → hooked marque la session `waiting`.
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
 *   - Sous-agent en fond : tool_use Agent/Task avec input.run_in_background !== false. Le tool_result
 *     renvoie AUSSITÔT « Async agent launched successfully … agentId: <id> ». Un sous-agent SYNCHRONE
 *     (run_in_background:false, ou ancien Task) n'a pas cet ack → on l'écarte (cf. RE_AGENT_LAUNCH).
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
import { incrementalReader } from './incremental.js';

const RE_BASH_ID = /running in background with ID:\s*(\S+?)[.\s]/i;
const RE_MONITOR_ID = /Monitor started \(task\s+(\S+?)[,)]/i;
// timeout propre du Monitor, porté par son tool_result (« Monitor started (task X, timeout 600000ms) »).
// Le harnais termine le Monitor à son timeout → startTs + timeoutMs = borne DURE (non heuristique) du
// « encore en cours » (cf. jobStatus → 'expired'). Vérifié réel : 25/27 sur a8ff7279, 3/3 sur 358f0e33.
const RE_MONITOR_TIMEOUT = /Monitor started \([^)]*\btimeout\s+(\d+)ms/i;
// chemin du fichier de sortie d'un Bash run_in_background (« Output is being written to: <path>.output »).
const RE_OUTPUT = /Output is being written to:\s*(\S+?\.output)\b/i;
// ack d'armement d'un sous-agent lancé en FOND (« Async agent launched successfully … agentId: <id> ») :
// seul cet ack distingue un vrai lancement en fond d'un sous-agent synchrone (dont le tool_result est
// le rapport final). L'agentId sert de <task-id> dans la <task-notification> de complétion.
const RE_AGENT_LAUNCH = /Async agent launched successfully/i;
const RE_AGENT_ID = /agentId:\s*(\S+)/i;
const RE_NOTE_TOOLUSE = /<tool-use-id>\s*(\S+?)\s*<\/tool-use-id>/i;
const RE_NOTE_TASK = /<task-id>\s*(\S+?)\s*<\/task-id>/i;
const RE_NOTE_STATUS = /<status>\s*([\w-]+)\s*<\/status>/i;
const RE_EXIT_CODE = /exit code\s+(-?\d+)/i;
const RE_EXIT_RC = /EXIT rc=(-?\d+)/i;

// Borne haute de repli pour un Monitor NON persistant dont on n'a pas pu lire le timeout déclaré
// dans le tool_result (timeoutMs null — invocation ancienne/atypique, ex. schéma `timeout_seconds`).
// Le tool Monitor plafonne timeout_ms à 1h : au-delà, un monitor qui n'a jamais émis de notif
// terminale (event perdu, restart du harnais) ne peut pas légitimement être encore actif. Cf. jobStatus.
const MONITOR_MAX_TIMEOUT_MS = 3600000;

// statuts terminaux d'une <task-notification> (tout le reste = encore en cours : running/pending/…).
const TERMINAL = new Set(['completed', 'complete', 'done', 'exited', 'failed', 'error', 'errored', 'killed', 'stopped', 'cancelled', 'canceled', 'timeout', 'timedout', 'timed_out', 'interrupted']);

// Sous-catégories terminales de TERMINAL, pour bucketer job.doneReason en un statut lisible (jobStatus).
const DONE_COMPLETED = new Set(['completed', 'complete', 'done', 'exited']);
const DONE_FAILED = new Set(['failed', 'error', 'errored', 'killed', 'timeout', 'timedout', 'timed_out', 'interrupted']);
const DONE_STOPPED = new Set(['stopped', 'cancelled', 'canceled']);

// Statut PUR d'un job de fond → exactement une valeur. C'est la « meilleure traque » du plan : au lieu
// de « pas de notif ⇒ encore en cours », on croise TROIS signaux fiables — notification terminale du
// transcript (job.done + doneReason), timeout propre du Monitor (borne dure → 'expired'), et vivacité
// de la SESSION (morte → 'orphaned'). SEUL 'running' compte comme actif (badge 🌀, liste sidebar,
// état 'background'). `alive` = la session tourne encore ; `now` = Date.now() (injecté pour les tests).
function jobStatus(job, alive, now) {
  if (job.done) {
    const r = String(job.doneReason || '').toLowerCase();
    if (r === 'fired') return 'fired';                 // ScheduleWakeup déclenché
    if (DONE_FAILED.has(r)) return 'failed';
    if (DONE_STOPPED.has(r)) return 'stopped';
    return 'completed';                                // completed/exited/done + repli terminal inconnu
  }
  // pas encore terminé : la session est-elle morte ? (process de fond mort avec elle)
  if (!alive) return 'orphaned';
  // Monitor au-delà de son timeout → le harnais l'a terminé, la notif ne viendra pas. Si on n'a pas
  // pu lire de timeout déclaré (timeoutMs null), on retombe sur le max 1h du tool Monitor, pour qu'un
  // monitor sans notif terminale ne reste pas 'running' à vie. Les monitors persistants n'ont pas de
  // borne temporelle (clos uniquement par une notif de fin ou une session morte → 'orphaned').
  if (job.kind === 'monitor' && !job.persistent && job.startTs) {
    const tmo = job.timeoutMs || MONITOR_MAX_TIMEOUT_MS;
    if (Date.parse(job.startTs) + tmo < now) return 'expired';
  }
  return 'running';
}

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

// ScheduleWakeup : le harnais ne garde qu'UN wakeup en attente par session — chaque nouvel appel
// REMPLACE le précédent. On ne suit donc que le dernier, repéré par sa POSITION (idx). Il est encore
// en attente SEULEMENT si rien n'a « repris » après lui (le déclenchement produit une ligne d'activité
// à un index supérieur). Modèle positionnel → robuste au promptSource variable (sdk/system) et au
// contenu réécrit à la volée, contrairement à un appariement de texte. Ces index sont append-only
// (ils ne font que croître) → l'état est réutilisable en parse incrémental (cf. server/incremental.js).
function newAcc() {
  return {
    jobsByToolUse: new Map(), // tool_use_id (armement) -> job (bash | monitor)
    jobsByTask: new Map(),    // task-id (résolu depuis le tool_result) -> job
    wakeup: null,             // dernier ScheduleWakeup { kind:'wakeup', …, idx }
    lastResumeIdx: -1,        // dernier index d'une activité de reprise (notif, tool non-wakeup, prompt)
    idx: -1,                  // index de ligne courant (non-vides uniquement)
  };
}

function foldLine(acc, line) {
  if (!line) return;
  acc.idx++;
  let j;
  try { j = JSON.parse(line); } catch (_) { return; }
  const ts = j.timestamp || null;
  const { jobsByToolUse, jobsByTask } = acc;

  // A) task-notification (tous porteurs) : complétion d'un Bash bg / Monitor. Idempotent (une
  //    même notif peut arriver en double sur plusieurs porteurs → on ne clôt qu'une fois). C'est
  //    aussi une reprise (ré-invocation) → bump lastResumeIdx.
  const note = taskNotification(j);
  if (note) {
    acc.lastResumeIdx = acc.idx;
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
    return; // une notif n'est jamais un armement ni un tool_result exploitable
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
        jobsByToolUse.set(b.id, { kind: 'monitor', toolUseId: b.id, taskId: null, command: String(inp.command || '').slice(0, 2000), description: String(inp.description || ''), startTs: ts, done: false, doneReason: null, doneAt: null, exitCode: null, outputPath: null, timeoutMs: null, persistent: inp.persistent === true });
      } else if (b.name === 'ScheduleWakeup') {
        const prompt = String(inp.prompt || '').slice(0, 2000);
        acc.wakeup = { kind: 'wakeup', toolUseId: b.id || null, taskId: null, command: prompt, prompt, description: String(inp.reason || '').slice(0, 500), startTs: ts, done: false, doneReason: null, doneAt: null, exitCode: null, outputPath: null, idx: acc.idx };
      } else if ((b.name === 'Agent' || b.name === 'Task') && inp.run_in_background !== false && b.id) {
        // confirmed=false : armé optimiste (un Task ancien/synchrone a run_in_background absent) ; on ne
        // le tient pour un vrai job de fond qu'une fois l'ack de lancement lu (cf. C), sinon on l'écarte.
        jobsByToolUse.set(b.id, { kind: 'subagent', toolUseId: b.id, taskId: null, command: '', description: String(inp.description || inp.subagent_type || '').slice(0, 500), startTs: ts, done: false, doneReason: null, doneAt: null, exitCode: null, outputPath: null, confirmed: false });
      } else if (b.name === 'TaskStop' && inp.task_id) {
        const job = jobsByTask.get(inp.task_id);
        if (job && !job.done) { job.done = true; job.doneReason = 'stopped'; job.doneAt = ts; }
      }
    }
    // un tour qui fait un vrai travail (autre chose que planifier un wakeup) = reprise
    if (hasNonWakeupTool) acc.lastResumeIdx = acc.idx;
  }

  // C) tool_result user : le task-id des Bash bg / Monitor n'apparaît QUE dans le résultat →
  //    on le résout pour permettre la corrélation par task-id (repli si <tool-use-id> absent).
  if (j.type === 'user' && j.message && Array.isArray(j.message.content)) {
    for (const b of j.message.content) {
      if (!b || b.type !== 'tool_result' || !b.tool_use_id) continue;
      const job = jobsByToolUse.get(b.tool_use_id);
      if (!job || job.taskId) continue;
      const txt = textOfContent(b.content);
      if (job.kind === 'subagent') {
        if (RE_AGENT_LAUNCH.test(txt)) {
          job.confirmed = true;
          const am = txt.match(RE_AGENT_ID) || (j.toolUseResult && j.toolUseResult.agentId ? [null, j.toolUseResult.agentId] : null);
          if (am && am[1]) { job.taskId = am[1]; jobsByTask.set(am[1], job); }
        } else {
          jobsByToolUse.delete(b.tool_use_id); // tool_result = rapport final → sous-agent synchrone, pas un job de fond
        }
        continue;
      }
      const m = job.kind === 'bash' ? txt.match(RE_BASH_ID) : txt.match(RE_MONITOR_ID);
      if (m) { job.taskId = m[1]; jobsByTask.set(m[1], job); }
      // timeout propre du Monitor (borne dure du « encore en cours ») : lu dans le même tool_result.
      if (job.kind === 'monitor' && job.timeoutMs == null) {
        const tm = txt.match(RE_MONITOR_TIMEOUT);
        if (tm) job.timeoutMs = Number(tm[1]);
      }
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
    if (!isToolResult) acc.lastResumeIdx = acc.idx;
  }
}

function finalize(acc) {
  const { wakeup } = acc;
  // le wakeup n'est en attente que si RIEN n'a repris après lui (sinon il a été déclenché/remplacé).
  // Idempotent : lastResumeIdx ne fait que croître et un nouveau wakeup repart avec done=false, donc
  // rappeler finalize après un fold incrémental donne le même verdict qu'un parse complet.
  if (wakeup && acc.lastResumeIdx > wakeup.idx) { wakeup.done = true; wakeup.doneReason = 'fired'; }
  const jobs = [...acc.jobsByToolUse.values(), ...(wakeup ? [wakeup] : [])];
  // un sous-agent armé mais non confirmé (ack de lancement pas encore lu, ou Task synchrone) n'est
  // pas un job de fond actif — sinon un sous-agent synchrone paraîtrait « running » entre son
  // tool_use et son tool_result.
  const active = jobs.filter((x) => !x.done && !(x.kind === 'subagent' && !x.confirmed));
  return { jobs, active };
}

// cycle de vie complet des jobs de fond du transcript, caché et INCRÉMENTAL (append-only → on ne
// replie que les octets ajoutés à chaque poll). fp falsy / illisible → aucun job.
const buildBackgroundJobs = incrementalReader({ init: newAcc, fold: foldLine, finalize, empty: { jobs: [], active: [] } });

// jobs de fond ENCORE ACTIFS uniquement (forme légère pour la sidebar). [] si le fichier est absent.
function activeBackgroundJobs(fp) {
  return buildBackgroundJobs(fp).active;
}

export { buildBackgroundJobs, activeBackgroundJobs, jobStatus };
