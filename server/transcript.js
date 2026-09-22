/*
 * Parsing des transcripts (avec cache mtime) + scan des sessions de premier niveau
 * et localisation des transcripts de sous-agents.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from './config.js';
import { readdirSafe, statSafe, textOf, cleanPrompt, truncTitle } from './util.js';
import { costForUsage } from './pricing.js';
import { incrementalReader } from './incremental.js';

// Squelette d'un résumé de session, avec toutes les valeurs par défaut. Factorisé pour
// que les sessions « synthétiques » (issues des hooks, avant écriture du transcript) aient
// exactement la même forme que celles parsées d'un transcript — cf. blankSummary().
function blankSummary(sessionId, fp) {
  return {
    id: sessionId,
    file: fp,
    project: null,
    projectName: null,
    gitBranch: null,
    agentId: null,           // présent => ce transcript est un sub-agent (fichier agent-*.jsonl)
    sessionIdInternal: null, // sessionId interne : pour un sub-agent, c'est l'id de la session parente
    version: null,           // version claude-code de la DERNIÈRE ligne écrite = version que tourne le process
    model: null,
    title: null,
    firstPrompt: null,
    lastPrompt: null,
    lastReply: null,   // dernier message TEXTE de l'assistant (pour l'aperçu conversation du Deck)
    startTs: null,
    lastTs: null,
    userPrompts: 0,
    assistantTurns: 0,
    tools: {},
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    cost: 0,
    costBreak: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    byDay: {},
    pendingQuestion: null,
    subagents: 0,       // nombre de sous-agents (appels Agent/Task) terminés dans cette session
    subagentCost: 0,    // part du coût attribuable aux sous-agents (toolUseResult.usage)
    prLinks: [],
    issueLinks: [],
  };
}

const ISSUE_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/g;

// Accumulateur d'un parse : le résumé en cours + l'état transitoire nécessaire pour
// REPRENDRE le parse sur des octets ajoutés (parse incrémental, cf. getSummary). Les
// transcripts .jsonl étant append-only, on garde ces accumulateurs entre deux polls et on
// ne replie QUE les lignes nouvelles au lieu de tout relire — O(octets ajoutés) au lieu de
// O(taille du fichier). seenMsg (dédup usage par id de message), modelCount (modèle dominant),
// asked/answered (question en attente) et prRaw/issueRaw (liens GitHub) DOIVENT persister,
// sinon un fold suivant recompterait ou perdrait de l'état.
function newAcc(sessionId, fp) {
  return {
    s: blankSummary(sessionId, fp),
    seenMsg: new Set(),  // ids de message déjà comptés (anti double-comptage usage)
    modelCount: {},      // modèle -> occurrences (pour le modèle dominant)
    asked: [],           // [{ id, questions }] AskUserQuestion dans l'ordre
    answered: new Set(), // tool_use_id ayant reçu un tool_result
    resolved: new Set(), // AskUserQuestion résolues SANS tool_result : répondre en tapant (au lieu
                         // de choisir une option) abandonne l'outil → Claude Code n'émet pas de
                         // tool_result. Tout prompt humain postérieur résout les questions déjà
                         // posées, sinon la carte resterait « en attente » à vie (cf. finalize).
    prRaw: [],           // matches d'URL de PR dans l'ordre du fichier (dédup/reverse au finalize)
    issueRaw: [],        // idem pour les issues
    aiTitle: null,       // dernier ai-title vu (prioritaire sur le fallback firstPrompt)
  };
}

// Replie UNE ligne de transcript dans l'accumulateur. Même logique par ligne que l'ancien
// parseTranscript ; extraite pour être partagée entre parse complet et parse incrémental.
function foldLine(acc, line) {
  if (!line) return;
  const s = acc.s;
  let j;
  try { j = JSON.parse(line); } catch (_) { return; }
  // PR de la session : lignes `pr-link` écrites par Claude Code quand il crée ou manipule une PR.
  // Source autoritaire — la regex sur la ligne brute qu'elle remplace ramassait TOUTE URL de PR
  // citée dans le transcript (contenu de skill injecté, résultat de recherche web, corps de PR
  // rédigé par Claude), d'où des `cli/cli#…` épinglés dans la sidebar.
  if (j.type === 'pr-link' && j.prUrl) acc.prRaw.push(j.prUrl);
  // Issues : pas d'équivalent journalisé → regex, mais jamais sur une ligne `isMeta` (skills,
  // CLAUDE.md et system-reminders injectés dans le contexte : du contenu cité, pas la session).
  if (!j.isMeta) { const ism = line.match(ISSUE_RE); if (ism) for (const x of ism) acc.issueRaw.push(x); }
  if (j.cwd && !s.project) { s.project = j.cwd; s.projectName = path.basename(j.cwd); }
  if (j.gitBranch) s.gitBranch = j.gitBranch;
  if (j.sessionId && !s.sessionIdInternal) s.sessionIdInternal = j.sessionId;
  if (j.agentId && !s.agentId) s.agentId = j.agentId;
  // version claude-code stampée à chaque ligne : on garde la DERNIÈRE vue (= version du process
  // qui a écrit le message le plus récent → la version que la session tourne réellement).
  if (j.version) s.version = j.version;
  if (j.timestamp) {
    if (!s.startTs || j.timestamp < s.startTs) s.startTs = j.timestamp;
    if (!s.lastTs || j.timestamp > s.lastTs) s.lastTs = j.timestamp;
  }
  if (j.type === 'ai-title' && j.aiTitle) acc.aiTitle = j.aiTitle;

  if (j.type === 'user' && j.message) {
    const c = j.message.content;
    // marque les tool_result : leur tool_use_id correspond à un AskUserQuestion répondu
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && b.type === 'tool_result' && b.tool_use_id) acc.answered.add(b.tool_use_id);
      }
    }
  }
  if (j.type === 'user' && j.message && !j.isSidechain) {
    const c = j.message.content;
    // ignore les tool_result (réponses d'outils, pas des prompts humains)
    const isToolResult = Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
    if (!isToolResult) {
      const t = cleanPrompt(textOf(c));
      if (t) {
        s.userPrompts++;
        if (!s.firstPrompt) s.firstPrompt = t;
        s.lastPrompt = t;
        // Un prompt humain qui suit une AskUserQuestion la résout : soit l'utilisateur a répondu en
        // texte libre (l'outil est alors abandonné, aucun tool_result), soit il est passé à autre
        // chose — dans les deux cas la question n'est plus « en attente ». Toute question déjà dans
        // acc.asked à cet instant est, par construction, antérieure à ce prompt → résolue.
        for (const a of acc.asked) acc.resolved.add(a.id);
      }
    }
  }

  if (j.type === 'assistant' && j.message) {
    const msg = j.message;
    const mid = msg.id || (j.timestamp + ':' + (msg.usage ? msg.usage.output_tokens : ''));
    if (msg.model) acc.modelCount[msg.model] = (acc.modelCount[msg.model] || 0) + 1;
    // dernier texte assistant (une réponse peut n'être que des tool_use → on ne garde QUE
    // les tours qui portent du texte, sinon l'aperçu resterait vide pendant que Claude bosse).
    const replyText = cleanPrompt(textOf(msg.content));
    if (replyText) s.lastReply = replyText;
    // outils
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b && b.type === 'tool_use' && b.name) {
          s.tools[b.name] = (s.tools[b.name] || 0) + 1;
          if (b.name === 'AskUserQuestion' && b.id && b.input && Array.isArray(b.input.questions)) {
            acc.asked.push({ id: b.id, questions: b.input.questions });
          }
        }
      }
    }
    // usage (dédupliqué par id de message pour éviter le double comptage)
    if (msg.usage && !acc.seenMsg.has(mid)) {
      acc.seenMsg.add(mid);
      s.assistantTurns++;
      const u = msg.usage;
      const k = costForUsage(u, msg.model);
      s.usage.input += k.inp; s.usage.output += k.out; s.usage.cacheCreate += k.cc; s.usage.cacheRead += k.cr;
      s.cost += k.total;
      s.costBreak.input += k.cIn; s.costBreak.output += k.cOut; s.costBreak.cacheCreate += k.cCc; s.costBreak.cacheRead += k.cCr;
      const day = (j.timestamp || '').slice(0, 10) || 'unknown';
      const d = (s.byDay[day] = s.byDay[day] || { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, turns: 0 });
      d.input += k.inp; d.output += k.out; d.cacheCreate += k.cc; d.cacheRead += k.cr; d.cost += k.total; d.turns++;
    }
  }

  // Coût des sous-agents : Claude Code journalise leur conso réelle dans toolUseResult.usage
  // (sur la ligne tool_result du parent), avec le modèle réel dans resolvedModel.
  // Ces tokens ne sont PAS comptés ailleurs (les lignes user ne portent pas d'usage) → on les ajoute.
  if (j.toolUseResult && j.toolUseResult.usage && (j.toolUseResult.agentType || j.toolUseResult.agentId)) {
    const r = j.toolUseResult;
    const k = costForUsage(r.usage, r.resolvedModel);
    s.usage.input += k.inp; s.usage.output += k.out; s.usage.cacheCreate += k.cc; s.usage.cacheRead += k.cr;
    s.cost += k.total; s.subagents++; s.subagentCost += k.total;
    s.costBreak.input += k.cIn; s.costBreak.output += k.cOut; s.costBreak.cacheCreate += k.cCc; s.costBreak.cacheRead += k.cCr;
    const day = (j.timestamp || '').slice(0, 10) || 'unknown';
    const d = (s.byDay[day] = s.byDay[day] || { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, turns: 0 });
    d.input += k.inp; d.output += k.out; d.cacheCreate += k.cc; d.cacheRead += k.cr; d.cost += k.total;
  }
}

// Champs DÉRIVÉS de l'accumulateur (à recalculer à chaque lecture — idempotent, car ils
// dépendent de l'état complet accumulé, pas du dernier fold). Sûr à rappeler après un fold
// incrémental comme après un parse complet.
function finalize(acc) {
  const s = acc.s;
  // liens de PR/issue GitHub, dernier d'abord, dédupliqué (slice() pour ne pas muter prRaw persistant).
  s.prLinks = [...new Set(acc.prRaw.slice().reverse())].slice(0, 12);
  s.issueLinks = [...new Set(acc.issueRaw.slice().reverse())].slice(0, 12);
  // modèle dominant (tri stable → départage identique au parse en une passe)
  s.model = Object.keys(acc.modelCount).sort((a, b) => acc.modelCount[b] - acc.modelCount[a])[0] || null;
  // Le titre de Claude Code (`ai-title`) est déjà une phrase complète : jamais tronqué. Le repli sur
  // le premier prompt, lui, est une COUPE → ellipse pour que ça ne s'arrête pas en plein mot.
  s.title = acc.aiTitle != null ? acc.aiTitle : (truncTitle(s.firstPrompt, 80) || '(sans titre)');
  // dernière question AskUserQuestion ni répondue (tool_result) ni résolue (prompt postérieur) =
  // question en attente. Sans `resolved`, une question à laquelle on répond en TAPANT resterait
  // « en attente » à vie (l'outil abandonné n'émet aucun tool_result).
  s.pendingQuestion = null;
  for (let i = acc.asked.length - 1; i >= 0; i--) {
    const id = acc.asked[i].id;
    if (!acc.answered.has(id) && !acc.resolved.has(id)) { s.pendingQuestion = acc.asked[i]; break; }
  }
  return s;
}

// Parse complet exposé (utilisé par les tests différentiels) : replie TOUTES les lignes du
// fichier, y compris une éventuelle dernière ligne partielle (comportement historique figé).
function parseTranscript(fp, sessionId) {
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return null; }
  const acc = newAcc(sessionId, fp);
  for (const line of data.split('\n')) foldLine(acc, line);
  return finalize(acc);
}

// Résumé caché et INCRÉMENTAL : sur une session active (transcript qui grandit) on ne replie que
// les octets ajoutés au lieu de relire tout le fichier à chaque poll (cf. server/incremental.js).
// finalize retourne acc.s (l'objet résumé, stable entre polls — buildSessions y ajoute son état
// live, réécrit à chaque tick).
const getSummary = incrementalReader({
  init: (fp, sessionId) => newAcc(sessionId, fp),
  fold: foldLine,
  finalize,
  empty: null,
});

// scanne les sessions de premier niveau. Les sous-agents (agent-*.jsonl) ne sont PAS scannés
// ici : leur coût est déjà replié dans le parent via toolUseResult.usage (cf. parseTranscript).
function scanSessions(projectsDir = PROJECTS_DIR) {
  const out = [];
  for (const proj of readdirSafe(projectsDir)) {
    const pdir = path.join(projectsDir, proj);
    const st = statSafe(pdir);
    if (!st || !st.isDirectory()) continue;
    for (const f of readdirSafe(pdir)) {
      if (!f.endsWith('.jsonl')) continue;
      const sum = getSummary(path.join(pdir, f), f.replace(/\.jsonl$/, ''));
      if (sum && !sum.agentId) out.push(sum); // sous-agents à plat exclus
    }
  }
  return out;
}

// Candidats `agent-*.jsonl` rangés sous les dossiers d'exécution de WORKFLOW d'une session
// (`<session>/subagents/workflows/<runId>/`) : les agents d'un workflow n'habitent pas le
// `subagents/` plat, mais le drill-in doit les trouver comme les autres. Cf. server/workflows.js.
function workflowRunDirs(sessionDir, fname) {
  const root = path.join(sessionDir, 'subagents', 'workflows');
  return readdirSafe(root).map((d) => path.join(root, d, fname));
}

// localise le transcript d'un sous-agent à partir de l'agentId (issu de toolUseResult.agentId).
function agentTranscriptPath(sessionId, agentId, projectsDir = PROJECTS_DIR) {
  if (!/^[A-Za-z0-9_-]+$/.test(agentId || '') || !/^[A-Za-z0-9._-]+$/.test(sessionId || '')) return null;
  const fname = `agent-${agentId}.jsonl`;
  for (const proj of readdirSafe(projectsDir)) {
    const pdir = path.join(projectsDir, proj);
    const cands = [
      path.join(pdir, sessionId, 'subagents', fname), // format récent (niché sous la session)
      path.join(pdir, 'subagents', fname),
      path.join(pdir, fname),                          // legacy à plat
      // agents d'un run de WORKFLOW : rangés sous le dossier du run, un niveau plus bas
      // (`<session>/subagents/workflows/<runId>/agent-*.jsonl`) — même drill-in pour eux.
      ...workflowRunDirs(path.join(pdir, sessionId), fname),
    ];
    for (const cand of cands) {
      const st = statSafe(cand);
      if (!st || !st.isFile()) continue;
      const sum = getSummary(cand, `agent-${agentId}`);
      if (sum && sum.sessionIdInternal === sessionId) return cand;
    }
  }
  return null;
}

export { parseTranscript, getSummary, scanSessions, agentTranscriptPath, blankSummary };
