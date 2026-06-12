'use strict';
/*
 * Parsing des transcripts (avec cache mtime) + scan des sessions de premier niveau
 * et localisation des transcripts de sous-agents.
 */
const fs = require('fs');
const path = require('path');
const { PROJECTS_DIR } = require('./config');
const { readdirSafe, statSafe, textOf, cleanPrompt } = require('./util');
const { costForUsage } = require('./pricing');

const parseCache = new Map(); // path -> { key, summary }

function parseTranscript(fp, sessionId) {
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return null; }
  const s = {
    id: sessionId,
    file: fp,
    project: null,
    projectName: null,
    gitBranch: null,
    agentId: null,           // présent => ce transcript est un sub-agent (fichier agent-*.jsonl)
    sessionIdInternal: null, // sessionId interne : pour un sub-agent, c'est l'id de la session parente
    model: null,
    title: null,
    firstPrompt: null,
    lastPrompt: null,
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
  };
  const seenMsg = new Set();
  const modelCount = {};
  // questions interactives (AskUserQuestion) : on retient chaque tool_use dans l'ordre,
  // et l'ensemble des tool_use_id déjà répondus (tool_result). À la fin, la dernière
  // question sans réponse = la question en attente à afficher dans l'UI.
  const asked = [];          // [{ id, questions }]
  const answered = new Set(); // tool_use_id ayant reçu un tool_result
  const lines = data.split('\n');
  for (const line of lines) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.cwd && !s.project) { s.project = j.cwd; s.projectName = path.basename(j.cwd); }
    if (j.gitBranch) s.gitBranch = j.gitBranch;
    if (j.sessionId && !s.sessionIdInternal) s.sessionIdInternal = j.sessionId;
    if (j.agentId && !s.agentId) s.agentId = j.agentId;
    if (j.timestamp) {
      if (!s.startTs || j.timestamp < s.startTs) s.startTs = j.timestamp;
      if (!s.lastTs || j.timestamp > s.lastTs) s.lastTs = j.timestamp;
    }
    if (j.type === 'ai-title' && j.aiTitle) s.title = j.aiTitle;

    if (j.type === 'user' && j.message) {
      const c = j.message.content;
      // marque les tool_result : leur tool_use_id correspond à un AskUserQuestion répondu
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b && b.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id);
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
        }
      }
    }

    if (j.type === 'assistant' && j.message) {
      const msg = j.message;
      const mid = msg.id || (j.timestamp + ':' + (msg.usage ? msg.usage.output_tokens : ''));
      if (msg.model) modelCount[msg.model] = (modelCount[msg.model] || 0) + 1;
      // outils
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b && b.type === 'tool_use' && b.name) {
            s.tools[b.name] = (s.tools[b.name] || 0) + 1;
            if (b.name === 'AskUserQuestion' && b.id && b.input && Array.isArray(b.input.questions)) {
              asked.push({ id: b.id, questions: b.input.questions });
            }
          }
        }
      }
      // usage (dédupliqué par id de message pour éviter le double comptage)
      if (msg.usage && !seenMsg.has(mid)) {
        seenMsg.add(mid);
        s.assistantTurns++;
        const u = msg.usage;
        const k = costForUsage(u, msg.model);
        s.usage.input += k.inp; s.usage.output += k.out; s.usage.cacheCreate += k.cc; s.usage.cacheRead += k.cr;
        s.cost += k.total;
        s.costBreak.input += k.cIn; s.costBreak.output += k.cOut; s.costBreak.cacheCreate += k.cCc; s.costBreak.cacheRead += k.cCr;
        const day = (j.timestamp || '').slice(0, 10) || 'inconnu';
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
      const day = (j.timestamp || '').slice(0, 10) || 'inconnu';
      const d = (s.byDay[day] = s.byDay[day] || { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, turns: 0 });
      d.input += k.inp; d.output += k.out; d.cacheCreate += k.cc; d.cacheRead += k.cr; d.cost += k.total;
    }
  }
  // liens de PR GitHub mentionnés dans la session. Dernier d'abord, dédupliqué.
  const prMatches = data.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) || [];
  s.prLinks = [...new Set(prMatches.reverse())].slice(0, 12);
  // modèle dominant
  s.model = Object.keys(modelCount).sort((a, b) => modelCount[b] - modelCount[a])[0] || null;
  if (!s.title) s.title = (s.firstPrompt || '').slice(0, 80) || '(sans titre)';
  // dernière question AskUserQuestion sans réponse = question en attente
  for (let i = asked.length - 1; i >= 0; i--) {
    if (!answered.has(asked[i].id)) { s.pendingQuestion = asked[i]; break; }
  }
  return s;
}

function getSummary(fp, sessionId) {
  const st = statSafe(fp);
  if (!st) return null;
  const key = st.mtimeMs + ':' + st.size;
  const cached = parseCache.get(fp);
  if (cached && cached.key === key) return cached.summary;
  const summary = parseTranscript(fp, sessionId);
  if (summary) parseCache.set(fp, { key, summary });
  return summary;
}

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

module.exports = { parseTranscript, getSummary, scanSessions, agentTranscriptPath };
