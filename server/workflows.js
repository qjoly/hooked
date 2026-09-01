/*
 * Runs de WORKFLOW (outil `Workflow`) d'une session : phases, agents, progression — l'équivalent
 * dashboard du `/workflows` de la CLI.
 *
 * Un workflow est toujours lancé EN FOND : le tool_result revient aussitôt et porte les ancres
 * (cf. toolUseResult, status "async_launched") :
 *   { runId, workflowName, summary, transcriptDir, scriptPath, taskId }
 * La complétion arrive plus tard sous forme de `<task-notification>` (même triple porteur
 * redondant que les jobs de fond — cf. server/background.js), corrélée par <tool-use-id>.
 *
 * DEUX SOURCES SUR DISQUE, et c'est toute la subtilité :
 *
 *   1. L'ENREGISTREMENT FINAL `<proj>/<session>/workflows/<runId>.json`, écrit d'un bloc à la
 *      fin du run (ou au kill) — JAMAIS pendant. Il contient `workflowProgress[]`, qui est
 *      exactement le modèle rendu par le TUI : un `workflow_phase` par phase et un
 *      `workflow_agent` par agent (label, phaseIndex, état, modèle, tokens, tool calls, durée,
 *      aperçus du prompt et du résultat). Quand il existe, il fait autorité et on ne lit rien
 *      d'autre : un seul petit JSON, caché par mtime.
 *
 *   2. PENDANT LE RUN, le dossier `<proj>/<session>/subagents/workflows/<runId>/` :
 *        - `journal.jsonl` : une ligne `{type:"started"|"result", key, agentId}` par agent,
 *          écrite au fil de l'eau (c'est le cache de reprise `resumeFromRunId`) ;
 *        - `agent-<id>.jsonl` : le transcript complet de chaque agent démarré.
 *      On en tire les agents réellement lancés et leurs stats live, via un lecteur incrémental
 *      caché (cf. readAgent) → on ne replie que les octets ajoutés depuis le poll précédent.
 *
 * CE QUE LE LIVE NE PEUT PAS DONNER : les `label` d'agents et l'attribution agent→phase
 * n'existent nulle part sur disque tant que le run tourne (la CLI les tient en mémoire et ne les
 * sérialise qu'avec l'enregistrement final). On affiche donc, pendant le run, la liste des phases
 * telle que déclarée dans le `meta` du script + les agents démarrés avec un libellé dérivé de
 * leur prompt ; le découpage phase→agents complet apparaît à la fin. Mieux vaut ce manque assumé
 * qu'une attribution devinée.
 */
import fs from 'node:fs';
import path from 'node:path';
import { statSafe, toolDetail } from './util.js';
import { incrementalReader } from './incremental.js';
import { costForUsage } from './pricing.js';

// ancre de lancement : seul le tool_result d'un `Workflow` porte ce status.
const LAUNCH_STATUS = 'async_launched';
// une <task-notification> de complétion (même forme que pour les jobs de fond).
const RE_NOTE_TOOLUSE = /<tool-use-id>\s*(\S+?)\s*<\/tool-use-id>/i;
const RE_NOTE_TASK = /<task-id>\s*(\S+?)\s*<\/task-id>/i;
const RE_NOTE_STATUS = /<status>\s*([\w-]+)\s*<\/status>/i;
// statuts terminaux : tout le reste (progress…) laisse le run « en cours ».
const TERMINAL = new Set(['completed', 'failed', 'killed', 'cancelled', 'error', 'timeout']);

const PREVIEW = 400;       // aperçus (prompt / résultat) — le détail complet est dans le drill-in
const MAX_RUNS = 20;       // bornage du payload : les runs les plus récents

// ————————————————————————————————————————————————————————————————————————
// meta du script : les PHASES déclarées (seule chose que le live ne trouve pas ailleurs)
// ————————————————————————————————————————————————————————————————————————

// Repère la fin du tableau qui commence à `open` en sautant les chaînes (', ", `) et les
// commentaires : un `]` DANS une chaîne (`detail: 'top-N [capped]'`) ne doit pas clore le
// tableau. Retourne l'index du `]` fermant, ou -1.
function endOfArray(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {          // chaîne : on saute jusqu'au délimiteur
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i < 0) return -1; i++; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// `{ title: '…', detail: '…' }` — 2 = title, 4 = detail (optionnel). Les valeurs sont des
// littéraux de chaîne simples (le contrat de `meta` interdit toute interpolation).
const PHASE_ENTRY = /\{[^{}]*?\btitle\s*:\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1(?:[^{}]*?\bdetail\s*:\s*(['"`])((?:\\.|(?!\3)[\s\S])*?)\3)?[^{}]*?\}/g;

const unescape = (s) => s.replace(/\\(['"`\\nt])/g, (_, c) => ({ n: '\n', t: '\t' }[c] || c));

// Phases déclarées dans `export const meta = { …, phases: [ … ] }`. On ne fait AUCUNE évaluation
// du script (pas de vm : ce serait exécuter du code arbitraire dans le process du dashboard) —
// juste un scan de chaînes borné au tableau `phases`.
function parseScriptPhases(src) {
  if (typeof src !== 'string') return [];
  const meta = src.indexOf('export const meta');
  if (meta < 0) return [];
  const key = src.indexOf('phases', meta);
  if (key < 0) return [];
  const open = src.indexOf('[', key);
  if (open < 0) return [];
  const close = endOfArray(src, open);
  if (close < 0) return [];
  const out = [];
  for (const m of src.slice(open, close + 1).matchAll(PHASE_ENTRY)) {
    out.push({ index: out.length + 1, title: unescape(m[2]), detail: m[4] ? unescape(m[4]) : null });
  }
  return out;
}

// ————————————————————————————————————————————————————————————————————————
// lectures disque (cachées par mtime : sessionDetail est appelé à chaque poll)
// ————————————————————————————————————————————————————————————————————————

const jsonCache = new Map(); // path → { key, value }

// Lit un petit JSON, caché par mtime:size. Une fois le run terminé son enregistrement ne bouge
// plus → un seul parse pour toute la vie du process.
function readJsonCached(fp) {
  const st = statSafe(fp);
  if (!st || !st.isFile()) { jsonCache.delete(fp); return null; }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = jsonCache.get(fp);
  if (hit && hit.key === key) return hit.value;
  let value = null;
  try { value = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { value = null; }
  jsonCache.set(fp, { key, value });
  return value;
}

// Le journal du run, replié incrémentalement : agents démarrés (ordre de lancement) et ceux qui
// ont rendu leur résultat. C'est un .jsonl append-only, exactement le cas d'usage du lecteur.
const readJournal = incrementalReader({
  init: () => ({ order: [], started: new Set(), done: new Set() }),
  fold: (acc, line) => {
    if (!line) return;
    let j;
    try { j = JSON.parse(line); } catch (_) { return; }
    const id = j && j.agentId;
    if (!id) return;
    if (!acc.started.has(id)) { acc.started.add(id); acc.order.push(id); }
    if (j.type === 'result') acc.done.add(id);
  },
  finalize: (acc) => acc,
  empty: null,
});

// Transcript d'UN agent de workflow, replié incrémentalement. On ne réutilise pas getSummary :
// il agrège l'usage CUMULÉ (somme des cache_read de tous les tours), alors que le compteur affiché
// par le TUI — et enregistré dans workflowProgress.tokens — est le CONTEXTE DE POINTE d'une
// requête (input + cache_read + cache_creation), c'est-à-dire ce que l'agent « tient » en tête.
// Mesuré sur un run réel : contexte de pointe = valeur enregistrée à ±25 tokens près, là où la
// somme des usages la dépasse d'un facteur ~30. On y ajoute ce que seul le live peut montrer :
// le dernier outil appelé.
const readAgent = incrementalReader({
  init: () => ({
    model: null, peakContext: 0, output: 0, toolCalls: 0, cost: 0,
    firstPrompt: null, startTs: null, lastTs: null, lastTool: null, lastToolDetail: '',
    seenMsg: new Set(),   // dedup usage par id de message (une ligne peut etre reecrite)
  }),
  fold: (acc, line) => {
    if (!line) return;
    let j;
    try { j = JSON.parse(line); } catch (_) { return; }
    if (j.timestamp) { if (!acc.startTs) acc.startTs = j.timestamp; acc.lastTs = j.timestamp; }
    const msg = j.message;
    if (j.type === 'user' && msg && acc.firstPrompt === null) {
      const c = msg.content;
      const txt = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n') : '';
      if (txt.trim()) acc.firstPrompt = txt;
    }
    if (j.type !== 'assistant' || !msg) return;
    if (msg.model) acc.model = msg.model;
    const u = msg.usage;
    if (u && !(msg.id && acc.seenMsg.has(msg.id))) {
      if (msg.id) acc.seenMsg.add(msg.id);
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (ctx > acc.peakContext) acc.peakContext = ctx;
      acc.output += u.output_tokens || 0;
      acc.cost += costForUsage(u, msg.model).total;
    }
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (!b || b.type !== 'tool_use') continue;
      acc.toolCalls++;
      acc.lastTool = b.name || null;
      acc.lastToolDetail = toolDetail(b.input);
    }
  },
  finalize: (acc) => acc,
  empty: null,
});

// Les chemins d'un run se DÉDUISENT du transcript de la session (`<proj>/<session>.jsonl`), on ne
// suit pas ceux enregistrés dans le tool_result : le transcript est une source de données, pas une
// source de confiance (pas de lecture hors du dossier projets), et une arborescence relogée — un
// HOOKED_PROJECTS_DIR de test, un ~/.claude déplacé — reste résolue.
//   dossier du run  : <proj>/<session>/subagents/workflows/<runId>/
//   enregistrement  : <proj>/<session>/workflows/<runId>.json
//   script          : <proj>/<session>/workflows/scripts/<nom>-<runId>.js
const RUN_ID_RE = /^wf_[A-Za-z0-9_-]+$/;
function runPaths(fp, runId, scriptName) {
  if (!RUN_ID_RE.test(runId || '')) return null;
  const base = fp.replace(/\.jsonl$/, '');   // <proj>/<session>
  // le nom du script vient du tool_result : on n'en garde que le basename (jamais un chemin).
  const script = (typeof scriptName === 'string' && /^[\w.-]+\.js$/.test(path.basename(scriptName)))
    ? path.join(base, 'workflows', 'scripts', path.basename(scriptName)) : null;
  return {
    dir: path.join(base, 'subagents', 'workflows', runId),
    record: path.join(base, 'workflows', `${runId}.json`),
    script,
  };
}

// ————————————————————————————————————————————————————————————————————————
// hydratation d'un run
// ————————————————————————————————————————————————————————————————————————

const shortModel = (m) => (m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '') || null;
const clip = (s, n = PREVIEW) => {
  const t = typeof s === 'string' ? s : (s == null ? '' : JSON.stringify(s));
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// Enregistrement final → agents + phases. `workflowProgress` porte déjà tout ce que le TUI rend,
// on ne fait que le transposer (aucune lecture de transcript d'agent : c'est figé et complet).
function fromRecord(rec) {
  const progress = Array.isArray(rec.workflowProgress) ? rec.workflowProgress : [];
  const agents = progress
    .filter((p) => p && p.type === 'workflow_agent')
    .map((p) => ({
      index: p.index || 0,
      label: p.label || `agent ${p.index || '?'}`,
      phaseIndex: p.phaseIndex || null,
      phaseTitle: p.phaseTitle || null,
      agentId: p.agentId || null,
      model: shortModel(p.model) || shortModel(rec.defaultModel),
      state: p.state || 'done',
      tokens: p.tokens || 0,
      toolCalls: p.toolCalls || 0,
      durationMs: p.durationMs || null,
      startedAt: p.startedAt || null,
      lastTool: p.lastToolName || null,
      lastToolDetail: clip(p.lastToolSummary, 140),
      hint: null,
      promptPreview: clip(p.promptPreview),
      resultPreview: clip(p.resultPreview),
    }));
  // phases déclarées dans meta ; on complète avec celles que seuls les agents mentionnent
  // (un agent peut porter un `phase:` explicite absent de meta.phases — cf. opts.phase).
  const phases = (Array.isArray(rec.phases) ? rec.phases : [])
    .map((p, i) => ({ index: i + 1, title: p.title || `Phase ${i + 1}`, detail: p.detail || null }));
  for (const a of agents) {
    if (!a.phaseTitle || phases.some((p) => p.title === a.phaseTitle)) continue;
    phases.push({ index: phases.length + 1, title: a.phaseTitle, detail: null });
  }
  return { agents, phases };
}

// Run EN COURS → on reconstruit depuis le dossier d'exécution. Chaque agent démarré a son
// transcript ; readAgent en tire modèle / contexte de pointe / coût / tool calls / horodatages
// sans relire le fichier entier à chaque poll.
function fromRunDir(dir, scriptSrc) {
  const journal = readJournal(path.join(dir, 'journal.jsonl'));
  const ids = journal ? journal.order : [];
  const read = ids.map((agentId) => readAgent(path.join(dir, `agent-${agentId}.jsonl`), agentId));
  const hints = distinguishingLines(read.map((a) => a && a.firstPrompt));
  const agents = read.map((a, i) => {
    const agentId = ids[i];
    const start = (a && a.startTs) ? Date.parse(a.startTs) : null;
    return {
      index: i + 1,
      // pas de label sur disque tant que le run tourne (cf. en-tête) : le rang de lancement, avec
      // la consigne qui distingue cet agent des autres en indice.
      label: `agent ${i + 1}`,
      hint: hints[i],
      phaseIndex: null, phaseTitle: null,   // attribution phase→agent absente du live (cf. en-tête)
      agentId,
      model: shortModel(a && a.model),
      state: journal.done.has(agentId) ? 'done' : 'running',
      tokens: a ? a.peakContext : 0,
      toolCalls: a ? a.toolCalls : 0,
      durationMs: (start && a.lastTs) ? Date.parse(a.lastTs) - start : null,
      startedAt: start,
      lastTool: a ? a.lastTool : null,
      lastToolDetail: a ? a.lastToolDetail : '',
      promptPreview: clip(a && a.firstPrompt),
      resultPreview: '',                    // le résultat structuré n'est écrit qu'à la fin
      cost: a ? a.cost : 0,
    };
  });
  return { agents, phases: parseScriptPhases(scriptSrc) };
}

// Première ligne « parlante » d'un texte (les prompts de workflow s'ouvrent souvent sur un saut
// de ligne), tronquée pour tenir sur une ligne d'interface.
function firstLine(lines) {
  const l = lines.find((x) => x.trim().length > 2);
  return l ? clip(l.trim(), 70) : null;
}

// Ce qui DISTINGUE chaque agent, faute de label en live : les agents d'une même phase reçoivent
// presque toujours le même préambule (contexte du dépôt, règles, format de sortie) suivi de leur
// consigne propre. On retire donc le plus long préfixe de lignes COMMUN à tous les prompts du run
// et on garde la première ligne parlante de ce qui reste — « LENS: Svelte 5 reactivity… » plutôt
// que « Repository: /home/… », identique pour les quatre. Un seul agent (ou des prompts
// identiques) → pas de préfixe à retirer, on prend la première ligne telle quelle.
function distinguishingLines(prompts) {
  const lines = prompts.map((p) => String(p || '').split('\n'));
  let k = 0;
  if (lines.length > 1) {
    while (lines.every((l) => k < l.length && l[k] === lines[0][k])) k++;
  }
  return lines.map((l) => firstLine(l.slice(k)) || firstLine(l));
}

// ————————————————————————————————————————————————————————————————————————
// scan du transcript : lancements + complétions
// ————————————————————————————————————————————————————————————————————————

// Replie le transcript principal pour y trouver les lancements de Workflow et leurs notifications
// de complétion. Incrémental/caché : appelé pour la session ouverte à chaque poll.
const scanLaunches = incrementalReader({
  init: () => ({ runs: [], byToolUse: new Map(), byTask: new Map(), pending: new Set() }),
  fold: (acc, line) => {
    if (!line) return;
    let j;
    try { j = JSON.parse(line); } catch (_) { return; }
    if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      for (const b of j.message.content) {
        if (b && b.type === 'tool_use' && b.name === 'Workflow' && b.id) acc.pending.add(b.id);
      }
      return;
    }
    if (j.type === 'user' && j.message && Array.isArray(j.message.content)) {
      const tur = j.toolUseResult;
      for (const b of j.message.content) {
        if (!b || b.type !== 'tool_result' || !acc.pending.has(b.tool_use_id)) continue;
        acc.pending.delete(b.tool_use_id);
        // seul un lancement asynchrone ouvre un run ; une invocation refusée/en erreur n'en a pas.
        if (!tur || tur.status !== LAUNCH_STATUS || !tur.runId || acc.byToolUse.has(b.tool_use_id)) continue;
        const run = {
          runId: tur.runId,
          taskId: tur.taskId || null,
          toolUseId: b.tool_use_id,
          name: tur.workflowName || tur.runId,
          summary: tur.summary || '',
          transcriptDir: tur.transcriptDir || null,
          scriptPath: tur.scriptPath || null,
          launchedAt: j.timestamp || null,
          noteStatus: null,
        };
        acc.runs.push(run);
        acc.byToolUse.set(b.tool_use_id, run);
        if (run.taskId) acc.byTask.set(run.taskId, run);
      }
      // une <task-notification> peut aussi arriver par un message user `promptSource:"system"`.
      noteFrom(acc, textOfContent(j.message.content));
      return;
    }
    // les deux autres porteurs de la notification (cf. server/background.js).
    if (j.type === 'queue-operation' && typeof j.content === 'string') noteFrom(acc, j.content);
    else if (j.type === 'attachment' && j.attachment && typeof j.attachment.prompt === 'string') noteFrom(acc, j.attachment.prompt);
  },
  finalize: (acc) => acc,
  empty: null,
});

// texte brut d'un `message.content` (string, ou blocs {type:'text'}) — pour y chercher une notif.
function textOfContent(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (b && b.type === 'text' ? b.text || '' : '')).join('\n');
}

// Applique une <task-notification> au run qu'elle concerne (corrélation par tool-use-id, à
// défaut par task-id). Seul un statut TERMINAL clôt le run.
function noteFrom(acc, text) {
  if (!text || text.indexOf('<task-notification>') < 0) return;
  const st = RE_NOTE_STATUS.exec(text);
  if (!st || !TERMINAL.has(st[1].toLowerCase())) return;
  const tu = RE_NOTE_TOOLUSE.exec(text);
  const tk = RE_NOTE_TASK.exec(text);
  const run = (tu && acc.byToolUse.get(tu[1])) || (tk && acc.byTask.get(tk[1])) || null;
  if (run) run.noteStatus = st[1].toLowerCase();
}

// ————————————————————————————————————————————————————————————————————————
// API
// ————————————————————————————————————————————————————————————————————————

/**
 * Runs de workflow de la session, le plus récent d'abord.
 * @param {string} fp   transcript principal de la session
 * @param {string} id   session_id (pour localiser l'enregistrement final)
 */
function buildWorkflows(fp, id) {
  const scanned = scanLaunches(fp);
  if (!scanned || !scanned.runs.length) return [];
  const now = Date.now();
  const out = [];
  for (const run of scanned.runs.slice(-MAX_RUNS)) {
    const paths = runPaths(fp, run.runId, run.scriptPath);
    if (!paths) continue;                       // runId inattendu → on n'invente pas de chemin
    const rec = readJsonCached(paths.record);

    let agents, phases, status, startedAt, durationMs, totalTokens, totalToolCalls, model, logs;
    if (rec) {
      ({ agents, phases } = fromRecord(rec));
      status = rec.status || run.noteStatus || 'completed';
      startedAt = rec.startTime || (run.launchedAt ? Date.parse(run.launchedAt) : null);
      durationMs = rec.durationMs || null;
      totalTokens = rec.totalTokens || 0;
      totalToolCalls = rec.totalToolCalls || 0;
      model = shortModel(rec.defaultModel);
      logs = Array.isArray(rec.logs) ? rec.logs.slice(-20) : [];
    } else {
      const src = paths.script ? safeRead(paths.script) : null;
      ({ agents, phases } = fromRunDir(paths.dir, src));
      // pas d'enregistrement final : le run tourne encore, sauf si une notif terminale est déjà
      // passée (record pas encore écrit, ou run tué sans écriture).
      status = run.noteStatus || 'running';
      startedAt = run.launchedAt ? Date.parse(run.launchedAt) : null;
      durationMs = startedAt ? now - startedAt : null;
      totalTokens = agents.reduce((a, x) => a + (x.tokens || 0), 0);
      totalToolCalls = agents.reduce((a, x) => a + (x.toolCalls || 0), 0);
      model = agents.map((a) => a.model).find(Boolean) || null;
      logs = [];
    }

    // rattache chaque agent à sa phase (par titre : le seul lien porté par workflowProgress).
    const byTitle = new Map(phases.map((p) => [p.title, { ...p, agents: [] }]));
    const loose = [];
    for (const a of agents) {
      const p = a.phaseTitle ? byTitle.get(a.phaseTitle) : null;
      (p ? p.agents : loose).push(a);
    }
    const running = agents.filter((a) => a.state === 'running').length;
    const done = agents.filter((a) => a.state === 'done').length;
    out.push({
      runId: run.runId, taskId: run.taskId, toolUseId: run.toolUseId,
      name: run.name, summary: run.summary,
      status, live: !rec,
      startedAt, durationMs, totalTokens, totalToolCalls, model,
      agentCount: agents.length, runningCount: running, doneCount: done,
      cost: agents.reduce((a, x) => a + (x.cost || 0), 0) || null,
      phases: [...byTitle.values()],
      // agents hors phase connue : tout le live, et les runs sans meta.phases.
      unphased: loose,
      agents, logs,
      scriptPath: run.scriptPath, transcriptDir: run.transcriptDir,
    });
  }
  out.reverse(); // le plus récent d'abord
  return out;
}

function safeRead(fp) {
  try { return fs.readFileSync(fp, 'utf8'); } catch (_) { return null; }
}

export { buildWorkflows, parseScriptPhases };
