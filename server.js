#!/usr/bin/env node
'use strict';
/*
 * hooked — serveur du dashboard local.
 *   - parse les transcripts ~/.claude/projects/<proj>/<session>.jsonl (cache par mtime)
 *   - lit l'état live des sessions depuis ~/.claude/hooked/events.jsonl (écrit par hook.js)
 *   - expose une petite API JSON + des fichiers statiques + un flux SSE temps réel
 *
 * Zéro dépendance (stdlib Node uniquement).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const { execFile, execFileSync } = require('child_process');

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const HOOKED_DIR = path.join(HOME, '.claude', 'hooked');
const EVENTS_FILE = path.join(HOOKED_DIR, 'events.jsonl');
// config (modèle/effort) des sessions lancées par hooked, indexée par nom de session tmux
const LAUNCHES_FILE = path.join(HOOKED_DIR, 'launches.jsonl');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = parseInt(process.env.HOOKED_PORT || '4123', 10);

// Tarifs estimatifs (USD / million de tokens). Éditables.
// cache write ≈ 1.25x input, cache read ≈ 0.1x input.
const PRICING = {
  fable: { in: 10, out: 50 },          // Fable 5 / Mythos 5
  opus: { in: 5, out: 25 },            // Opus 4.5 / 4.6 / 4.7 / 4.8
  opusLegacy: { in: 15, out: 75 },     // Opus 4 / 4.1 (deprecated)
  sonnet: { in: 3, out: 15 },          // Sonnet 4 / 4.5 / 4.6
  haiku: { in: 1, out: 5 },            // Haiku 4.5
  haikuLegacy: { in: 0.8, out: 4 },    // Haiku 3.5 (retired)
};
function priceFor(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('fable') || m.includes('mythos')) return PRICING.fable;
  if (m.includes('opus')) {
    // Opus 4.0 (e.g. opus-4-20250514) and 4.1 are the legacy $15/$75 tier; 4.5+ are $5/$25.
    if (/opus-4-1\b/.test(m) || /opus-4-20\d{6}/.test(m)) return PRICING.opusLegacy;
    return PRICING.opus;
  }
  if (m.includes('haiku')) {
    if (m.includes('-3-')) return PRICING.haikuLegacy; // Haiku 3.x (e.g. claude-3-5-haiku)
    return PRICING.haiku;
  }
  if (m.includes('sonnet')) return PRICING.sonnet;
  return PRICING.opus;
}

// ---------- utils fs ----------
const readdirSafe = (p) => { try { return fs.readdirSync(p); } catch (_) { return []; } };
const statSafe = (p) => { try { return fs.statSync(p); } catch (_) { return null; } };

// ---------- parsing transcripts (avec cache mtime) ----------
const parseCache = new Map(); // path -> { key, summary }

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

function parseTranscript(fp, sessionId) {
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return null; }
  const s = {
    id: sessionId,
    file: fp,
    project: null,
    projectName: null,
    gitBranch: null,
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
        const inp = u.input_tokens || 0;
        const out = u.output_tokens || 0;
        const cc = u.cache_creation_input_tokens || 0;
        const cr = u.cache_read_input_tokens || 0;
        s.usage.input += inp; s.usage.output += out; s.usage.cacheCreate += cc; s.usage.cacheRead += cr;
        const p = priceFor(msg.model);
        const cIn = inp * p.in / 1e6, cOut = out * p.out / 1e6, cCc = cc * p.in * 1.25 / 1e6, cCr = cr * p.in * 0.1 / 1e6;
        const cost = cIn + cOut + cCc + cCr;
        s.cost += cost;
        s.costBreak.input += cIn; s.costBreak.output += cOut; s.costBreak.cacheCreate += cCc; s.costBreak.cacheRead += cCr;
        const day = (j.timestamp || '').slice(0, 10) || 'inconnu';
        const d = (s.byDay[day] = s.byDay[day] || { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, turns: 0 });
        d.input += inp; d.output += out; d.cacheCreate += cc; d.cacheRead += cr; d.cost += cost; d.turns++;
      }
    }
  }
  // liens de PR GitHub mentionnés dans la session (texte assistant, sortie d'outils,
  // résultats `gh pr …`…). On scanne le fichier brut : robuste et peu coûteux.
  // Dernier d'abord (le plus récent en bas du transcript), dédupliqué.
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

// reconstruit la conversation (style chat) : 1 bulle user / 1 bulle assistant par tour,
// en fusionnant l'activité assistant entre deux prompts.
function buildConversation(fp) {
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return []; }
  const msgs = [];
  for (const line of data.split('\n')) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.isSidechain) continue;
    if (j.type === 'user' && j.message) {
      const c = j.message.content;
      if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) continue;
      const text = chatText(c);
      if (text) msgs.push({ role: 'user', ts: j.timestamp, text: text.slice(0, 8000), tools: [] });
    } else if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      let text = '';
      const tools = [];
      for (const b of j.message.content) {
        if (b.type === 'text' && b.text) text += (text ? '\n' : '') + b.text;
        else if (b.type === 'tool_use') tools.push({ name: b.name, detail: toolDetail(b.input) });
      }
      text = text.trim();
      if (!text && !tools.length) continue;
      const prev = msgs[msgs.length - 1];
      if (prev && prev.role === 'assistant') { // fusion du même tour
        if (text && prev.text !== text && !prev.text.endsWith(text)) prev.text += (prev.text ? '\n' : '') + text;
        for (const t of tools) if (!prev.tools.some((x) => x.name === t.name && x.detail === t.detail)) prev.tools.push(t);
        if (j.timestamp) prev.ts = j.timestamp;
      } else {
        msgs.push({ role: 'assistant', ts: j.timestamp, text: text.slice(0, 8000), tools });
      }
    }
  }
  return msgs;
}

// reconstruit la liste des modifications de fichiers (Edit / Write / MultiEdit / NotebookEdit)
// faites par Claude au fil de la session, regroupées par fichier (dernier touché d'abord).
function buildFileChanges(fp) {
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return []; }
  const byFile = new Map(); // path -> { file, name, ops: [...], count, lastTs }
  for (const line of data.split('\n')) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.type !== 'assistant' || !j.message || !Array.isArray(j.message.content)) continue;
    const ts = j.timestamp || null;
    for (const b of j.message.content) {
      if (!b || b.type !== 'tool_use' || !b.input) continue;
      const inp = b.input;
      const file = inp.file_path || inp.path || inp.notebook_path;
      if (!file) continue;
      const ops = [];
      if (b.name === 'Write') {
        ops.push({ kind: 'write', content: String(inp.content || '').slice(0, 6000) });
      } else if (b.name === 'Edit') {
        ops.push({ kind: 'edit', old: String(inp.old_string || '').slice(0, 3000), new: String(inp.new_string || '').slice(0, 3000), all: !!inp.replace_all });
      } else if (b.name === 'MultiEdit' && Array.isArray(inp.edits)) {
        for (const e of inp.edits) ops.push({ kind: 'edit', old: String(e.old_string || '').slice(0, 3000), new: String(e.new_string || '').slice(0, 3000), all: !!e.replace_all });
      } else if (b.name === 'NotebookEdit') {
        ops.push({ kind: 'notebook', new: String(inp.new_source || '').slice(0, 3000) });
      } else {
        continue;
      }
      const entry = byFile.get(file) || { file, name: path.basename(file), tool: b.name, ops: [], count: 0, lastTs: ts };
      for (const o of ops) entry.ops.push({ ...o, ts });
      entry.count += ops.length;
      entry.lastTs = ts || entry.lastTs;
      byFile.set(file, entry);
    }
  }
  // cap dur sur le nombre d'opérations affichées par fichier (sessions très longues)
  const out = [...byFile.values()].map((e) => ({ ...e, ops: e.ops.slice(-40) }));
  out.sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')));
  return out;
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

function scanSessions() {
  const out = [];
  for (const proj of readdirSafe(PROJECTS_DIR)) {
    const pdir = path.join(PROJECTS_DIR, proj);
    const st = statSafe(pdir);
    if (!st || !st.isDirectory()) continue;
    for (const f of readdirSafe(pdir)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(pdir, f);
      const sum = getSummary(fp, f.replace(/\.jsonl$/, ''));
      if (sum) out.push(sum);
    }
  }
  return out;
}

// ---------- listing des fichiers d'un projet (pour l'auto-complétion @) ----------
const FILE_IGNORE = new Set(['node_modules', '.git', '.jj', '.hg', '.svn', 'dist', 'build', 'out',
  '.next', '.nuxt', '.cache', 'coverage', 'vendor', '.venv', 'venv', '__pycache__',
  'target', '.idea', '.gradle', '.terraform', 'tmp', '.DS_Store']);
function listFilesUnder(root, max = 5000) {
  const out = [];
  const stack = [root];
  let scanned = 0;
  while (stack.length && out.length < max) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (++scanned > 80000) break;
      if (FILE_IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) continue; // dossiers cachés ignorés (sauf besoin explicite)
        stack.push(full);
      } else if (e.isFile()) {
        out.push(path.relative(root, full));
        if (out.length >= max) break;
      }
    }
  }
  return out;
}
// cache temporel par dossier racine (le listing complet est trop coûteux à chaque frappe)
const filesCache = new Map(); // root -> { at, list }
function projectFiles(root) {
  const c = filesCache.get(root);
  const now = Date.now();
  if (c && now - c.at < 10000) return c.list;
  const list = listFilesUnder(root);
  filesCache.set(root, { at: now, list });
  return list;
}
// score de correspondance « floue » (sous-séquence façon fzf) : chaque caractère de la
// requête doit apparaître dans l'ordre dans la cible. Renvoie un score (plus bas = meilleur)
// ou null si pas de correspondance. Bonus pour caractères consécutifs et débuts de segment.
function fuzzyScore(target, q) {
  const s = target.toLowerCase();
  let si = 0, score = 0, prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = s.indexOf(q[qi], si);
    if (idx < 0) return null;
    score += idx - si;                                  // pénalité d'écart
    if (idx === prev + 1) score -= 1.5;                 // bonus contigu
    if (idx === 0 || '/._- '.includes(s[idx - 1])) score -= 2; // bonus début de segment
    prev = idx;
    si = idx + 1;
  }
  return score;
}
// filtre + classement par pertinence (floue). Le match sur le nom de fichier prime sur
// le match sur le chemin ; léger biais vers les chemins courts. Tolère donc les frappes
// approximatives, abréviations et caractères non contigus (ex. « srvjs » → server.js).
function matchFiles(list, q, limit = 40) {
  q = (q || '').toLowerCase().trim();
  if (!q) return list.slice(0, limit);
  const scored = [];
  for (const f of list) {
    const base = f.slice(f.lastIndexOf('/') + 1);
    const sb = fuzzyScore(base, q);
    const sf = fuzzyScore(f, q);
    if (sb == null && sf == null) continue;
    let score = sb != null ? sb : sf + 12;              // match basename prioritaire
    score += f.length * 0.01;                           // biais chemins courts
    scored.push([f, score]);
  }
  scored.sort((a, b) => a[1] - b[1] || a[0].length - b[0].length);
  return scored.slice(0, limit).map((x) => x[0]);
}

// ---------- évènements live (hooks) ----------
let eventsCache = { key: null, list: [] };
function readEvents() {
  const st = statSafe(EVENTS_FILE);
  if (!st) return [];
  const key = st.mtimeMs + ':' + st.size;
  if (eventsCache.key === key) return eventsCache.list;
  let data;
  try { data = fs.readFileSync(EVENTS_FILE, 'utf8'); } catch (_) { return eventsCache.list; }
  const lines = data.split('\n').filter(Boolean);
  const list = [];
  for (const l of lines.slice(-8000)) {
    try { list.push(JSON.parse(l)); } catch (_) {}
  }
  eventsCache = { key, list };
  return list;
}

function lastEventBySession() {
  const ev = readEvents();
  const map = new Map();
  for (const e of ev) {
    if (!e.session_id) continue;
    map.set(e.session_id, e);
  }
  return map;
}

// dernier pane tmux connu pour une session (parcourt les évènements à rebours,
// car tous n'ont pas forcément `tmux_pane` — seuls ceux émis sous tmux).
function paneForSession(id) {
  const ev = readEvents();
  for (let i = ev.length - 1; i >= 0; i--) {
    if (ev[i].session_id === id && ev[i].tmux_pane) return ev[i].tmux_pane;
  }
  return null;
}

// Question AskUserQuestion *en attente* pour une session, reconstruite depuis les
// évènements live (hook.js). Indispensable car le tool_use n'est écrit dans le transcript
// qu'une fois la question répondue : tant qu'elle est en attente, l'évènement PreToolUse
// est la seule source. On considère la question résolue dès qu'un PostToolUse du même outil,
// un Stop ou une fin de session survient ensuite.
function liveQuestionForSession(id) {
  const ev = readEvents();
  let pending = null;
  for (const e of ev) {
    if (e.session_id !== id) continue;
    if (e.event === 'PreToolUse' && e.tool === 'AskUserQuestion' && Array.isArray(e.ask) && e.ask.length) {
      pending = { id: 'live:' + e.ts, questions: e.ask };
    } else if ((e.event === 'PostToolUse' && e.tool === 'AskUserQuestion') || e.event === 'Stop' || e.event === 'SubagentStop' || e.event === 'SessionEnd' || e.event === 'UserPromptSubmit') {
      pending = null;
    }
  }
  return pending;
}

// config de lancement (modèle/effort) par nom de session tmux ; dernier write gagne.
let launchCache = { key: null, map: new Map() };
function launchConfigByTmux() {
  const st = statSafe(LAUNCHES_FILE);
  if (!st) return launchCache.map;
  const key = st.mtimeMs + ':' + st.size;
  if (launchCache.key === key) return launchCache.map;
  const map = new Map();
  let data = '';
  try { data = fs.readFileSync(LAUNCHES_FILE, 'utf8'); } catch (_) { return launchCache.map; }
  for (const line of data.split('\n')) {
    if (!line) continue;
    try { const j = JSON.parse(line); if (j.tmux) map.set(j.tmux, { model: j.model || null, effort: j.effort || null }); } catch (_) {}
  }
  launchCache = { key, map };
  return map;
}

// map pane tmux (%NN) → nom de session tmux, rafraîchie au plus toutes les 3 s.
let paneNameCache = { at: 0, map: new Map() };
function paneTmuxNames() {
  const now = Date.now();
  if (now - paneNameCache.at < 3000) return paneNameCache.map;
  const map = new Map();
  try {
    const out = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{session_name}'], { encoding: 'utf8', timeout: 1500 });
    for (const line of out.split('\n')) {
      const sp = line.indexOf(' ');
      if (sp > 0) map.set(line.slice(0, sp), line.slice(sp + 1).trim());
    }
  } catch (_) { /* tmux absent ou aucun serveur : pas grave */ }
  paneNameCache = { at: now, map };
  return map;
}

// effort/modèle explicitement choisis au lancement pour une session live (sinon null).
function launchInfoForPane(pane) {
  if (!pane) return null;
  const name = paneTmuxNames().get(pane);
  if (!name) return null;
  return launchConfigByTmux().get(name) || null;
}

function liveStateFor(ev) {
  if (!ev) return null;
  const ageMin = (Date.now() - Date.parse(ev.ts)) / 60000;
  const msg = ev.message || '';
  switch (ev.event) {
    case 'SessionEnd': return { state: 'ended', tool: null };
    case 'Stop':
    case 'SubagentStop':
      return { state: 'waiting', tool: null };
    case 'Notification':
      if (/permission|approve|allow|autoris/i.test(msg)) return { state: 'attention', tool: null };
      return { state: 'waiting', tool: null };
    case 'PreToolUse':
    case 'PostToolUse':
      return { state: ageMin > 5 ? 'idle' : 'working', tool: ev.tool || null };
    case 'UserPromptSubmit':
    case 'SessionStart':
    case 'PreCompact':
      return { state: ageMin > 5 ? 'idle' : 'working', tool: null };
    default:
      return { state: ageMin > 30 ? 'idle' : 'working', tool: ev.tool || null };
  }
}

function buildSessions() {
  const sessions = scanSessions();
  const last = lastEventBySession();
  const now = Date.now();
  for (const s of sessions) {
    const ev = last.get(s.id);
    s.tmuxPane = (ev && ev.tmux_pane) || paneForSession(s.id);
    const live = liveStateFor(ev);
    if (live) {
      s.state = live.state;
      s.currentTool = live.tool;
      s.liveTs = ev.ts;
    } else {
      const ageMin = s.lastTs ? (now - Date.parse(s.lastTs)) / 60000 : Infinity;
      s.state = ageMin < 3 ? 'working' : 'past';
      s.currentTool = null;
      s.liveTs = null;
    }
    s.lastActivity = s.liveTs && (!s.lastTs || s.liveTs > s.lastTs) ? s.liveTs : s.lastTs;
    // effort (et modèle explicite) connus seulement pour les sessions lancées par hooked
    const li = s.tmuxPane ? launchInfoForPane(s.tmuxPane) : null;
    s.effort = li ? li.effort : null;
    if (li && li.model && !s.model) s.model = li.model;
    // question en attente : transcript (rare, déjà répondue en pratique) OU live (cas réel)
    s.liveQuestion = liveQuestionForSession(s.id);
  }
  // tri : plus récente activité d'abord
  sessions.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  // on n'expose pas byDay/pendingQuestion en entier dans la liste (lourd) — juste un flag.
  return sessions.map(({ byDay, file, pendingQuestion, liveQuestion, ...rest }) => ({ ...rest, hasQuestion: !!(pendingQuestion || liveQuestion) }));
}

function buildStats(rangeDays) {
  const sessions = scanSessions();
  const cutoff = rangeDays ? Date.now() - rangeDays * 86400000 : 0;
  const totals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, turns: 0, sessions: 0, prompts: 0 };
  const byDay = {};
  const byModel = {};
  const byProject = {};
  const byTool = {};
  for (const s of sessions) {
    const inRange = !cutoff || (s.lastTs && Date.parse(s.lastTs) >= cutoff);
    if (!inRange) continue;
    totals.sessions++;
    totals.prompts += s.userPrompts;
    for (const [day, d] of Object.entries(s.byDay)) {
      if (cutoff && Date.parse(day) < cutoff - 86400000) continue;
      const t = (byDay[day] = byDay[day] || { cost: 0, output: 0, input: 0, cacheRead: 0, turns: 0 });
      t.cost += d.cost; t.output += d.output; t.input += d.input; t.cacheRead += d.cacheRead; t.turns += d.turns;
      totals.input += d.input; totals.output += d.output; totals.cacheCreate += d.cacheCreate;
      totals.cacheRead += d.cacheRead; totals.cost += d.cost; totals.turns += d.turns;
    }
    if (s.model) {
      const m = (byModel[s.model] = byModel[s.model] || { cost: 0, turns: 0 });
      m.cost += s.cost; m.turns += s.assistantTurns;
    }
    const pn = s.projectName || 'inconnu';
    const pr = (byProject[pn] = byProject[pn] || { cost: 0, sessions: 0, output: 0 });
    pr.cost += s.cost; pr.sessions++; pr.output += s.usage.output;
    for (const [tool, n] of Object.entries(s.tools)) byTool[tool] = (byTool[tool] || 0) + n;
  }
  return { totals, byDay, byModel, byProject, byTool };
}

function sessionDetail(id) {
  const sessions = scanSessions();
  const s = sessions.find((x) => x.id === id);
  if (!s) return null;
  const ev = readEvents().filter((e) => e.session_id === id).slice(-60);
  const last = ev.length ? liveStateFor(ev[ev.length - 1]) : null;
  const messages = buildConversation(s.file);
  const changes = buildFileChanges(s.file);
  const pane = paneForSession(id);
  const li = pane ? launchInfoForPane(pane) : null;
  const tmuxName = pane ? paneTmuxNames().get(pane) : null;
  const tmuxAttach = tmuxName ? `tmux attach -t ${tmuxName}` : null;
  // pendingQuestion live (hook) prioritaire : c'est la question réellement en attente ;
  // le transcript ne la contient qu'une fois répondue. Fallback sur le transcript sinon.
  const pendingQuestion = liveQuestionForSession(id) || s.pendingQuestion || null;
  return { ...s, pendingQuestion, state: last ? last.state : (s.state || 'past'), currentTool: last ? last.tool : null, tmuxPane: pane, tmuxAttach, effort: li ? li.effort : null, model: (li && li.model && !s.model) ? li.model : s.model, events: ev, messages, changes };
}

// ---------- SSE ----------
const sseClients = new Set();
function broadcast() {
  for (const res of sseClients) {
    try { res.write('data: tick\n\n'); } catch (_) {}
  }
}
// pousse à chaque écriture d'évènement de hook (débounce) + heartbeat régulier
let debounce = null;
try {
  fs.mkdirSync(HOOKED_DIR, { recursive: true });
  fs.watch(HOOKED_DIR, () => {
    clearTimeout(debounce);
    debounce = setTimeout(broadcast, 250);
  });
} catch (_) {}
setInterval(broadcast, 4000).unref();

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
function sendJSON(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, cb) {
  let raw = '';
  let tooBig = false;
  req.on('data', (d) => {
    raw += d;
    if (raw.length > 1e6) { tooBig = true; req.destroy(); } // garde-fou 1 Mo
  });
  req.on('end', () => {
    if (tooBig) return cb(new Error('body too large'));
    try { cb(null, raw ? JSON.parse(raw) : {}); } catch (e) { cb(e); }
  });
  req.on('error', cb);
}

// Renvoie le message dans la session interactive via tmux : on « tape » le texte
// dans le pane puis on valide avec Entrée. C'est la session/abonnement en cours,
// donc aucune conso token supplémentaire (pas de `claude -p`).
function deliverReply(pane, text, cb) {
  if (!/^%\d+$/.test(pane || '')) return cb(new Error('pane invalide'));
  execFile('tmux', ['send-keys', '-t', pane, '-l', '--', text], (err) => {
    if (err) return cb(err);
    // petit délai pour laisser le TUI ingérer le collage avant de valider
    setTimeout(() => execFile('tmux', ['send-keys', '-t', pane, 'Enter'], (e2) => cb(e2 || null)), 120);
  });
}

// Lance `claude` (ou `claude --resume <id>`) dans une NOUVELLE session tmux détachée.
// Même principe que deliverReply : c'est `claude` interactif sous ton abonnement
// (aucune conso token, pas de `claude -p`). On crée la session tmux puis on « tape »
// la commande dans le shell interactif → PATH/profil chargés comme si tu la tapais.
function err400(msg) { const e = new Error(msg); e.code = 400; return e; }
const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
function launchSession({ resumeId, cwd, prompt, model, effort }, cb) {
  let dir = cwd && typeof cwd === 'string' ? cwd : null;
  let id = null;
  if (resumeId) {
    if (!/^[A-Za-z0-9._-]+$/.test(resumeId)) return cb(err400('id de session invalide'));
    const sess = scanSessions().find((s) => s.id === resumeId);
    if (!sess) return cb(err400('session introuvable'));
    dir = dir || sess.project; // on reprend dans le dossier d'origine de la session
    id = resumeId;
  }
  if (!dir) return cb(err400('dossier (cwd) requis'));
  const st = statSafe(dir);
  if (!st || !st.isDirectory()) return cb(err400('cwd invalide : ' + dir));

  // model/effort : on les valide contre une liste blanche (sécurise l'injection shell
  // ET rejette les valeurs inconnues). id est alphanum ; dir passe via -c (jamais « tapé »).
  if (model && !MODELS.includes(model)) return cb(err400('modèle inconnu : ' + model));
  if (effort && !EFFORTS.includes(effort)) return cb(err400('effort inconnu : ' + effort));
  let flags = '';
  if (model) flags += ` --model ${model}`;
  if (effort) flags += ` --effort ${effort}`;
  const claudeCmd = `claude${id ? ` --resume ${id}` : ''}${flags}`;
  const base = path.basename(dir).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 24) || 'session';
  const name = `hooked-${base}-${Date.now().toString(36).slice(-5)}`;

  // On lance `claude` comme commande du shell de login interactif (-ic) : pas de course
  // avec le démarrage du shell, et le PATH du profil (nvm…) est chargé comme si tu tapais
  // la commande toi-même. `exec $SHELL` garde le pane vivant après la sortie de claude.
  const shell = process.env.SHELL || '/bin/zsh';
  const shellCmd = `${shell} -ic '${claudeCmd}; exec ${shell}'`;

  execFile('tmux', ['new-session', '-d', '-s', name, '-c', dir, shellCmd], (e1) => {
    if (e1) return cb(new Error('tmux new-session a échoué : ' + (e1.message || e1)));
    // mémorise modèle/effort choisis pour pouvoir les afficher sur la session live
    // (indexé par nom de session tmux ; le pane → nom est résolu côté buildSessions).
    try {
      fs.appendFileSync(LAUNCHES_FILE, JSON.stringify({ ts: new Date().toISOString(), tmux: name, cwd: dir, model: model || null, effort: effort || null }) + '\n');
    } catch (_) {}
    // 1er prompt optionnel : best-effort, après un délai pour laisser le TUI claude démarrer.
    const seed = prompt && typeof prompt === 'string' ? prompt.trim() : '';
    if (seed) {
      setTimeout(() => execFile('tmux', ['send-keys', '-t', name, '-l', '--', seed], () => {
        setTimeout(() => execFile('tmux', ['send-keys', '-t', name, 'Enter'], () => {}), 250);
      }), 3500);
    }
    cb(null, { tmux: name, attach: `tmux attach -t ${name}`, cwd: dir, resume: id });
  });
}

// Stoppe la session : on tue le pane tmux où tourne claude (`tmux kill-pane`).
// Pour une session lancée par hooked (1 seul pane), ça détruit toute la session tmux.
function killSession(id, cb) {
  const pane = paneForSession(id);
  if (!pane) return cb(err400('pane tmux inconnu pour cette session (lancée hors tmux ?)'));
  if (!/^%\d+$/.test(pane)) return cb(err400('pane invalide'));
  execFile('tmux', ['kill-pane', '-t', pane], (e) => {
    if (e) return cb(new Error('tmux kill-pane a échoué : ' + (e.message || e)));
    cb(null, { pane });
  });
}

function serveStatic(res, p) {
  const fp = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p);
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname;
  try {
    if (req.method === 'POST' && p === '/api/reply') {
      return readBody(req, (err, body) => {
        if (err) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'requête invalide' })); }
        const id = body && body.id;
        const text = body && typeof body.text === 'string' ? body.text.trim() : '';
        if (!id || !text) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'id et text requis' })); }
        const pane = paneForSession(id);
        if (!pane) { res.writeHead(409); return res.end(JSON.stringify({ ok: false, error: 'pane tmux inconnu pour cette session (lancée hors tmux, ou avant ce hook ?)' })); }
        deliverReply(pane, text, (e2) => {
          if (e2) { res.writeHead(502); return res.end(JSON.stringify({ ok: false, error: 'échec tmux send-keys : ' + (e2.message || e2) })); }
          sendJSON(res, { ok: true, pane });
        });
      });
    }
    if (req.method === 'POST' && p === '/api/launch') {
      return readBody(req, (err, body) => {
        if (err) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'requête invalide' })); }
        launchSession(body || {}, (e, info) => {
          if (e) { res.writeHead(e.code === 400 ? 400 : 502); return res.end(JSON.stringify({ ok: false, error: e.message || String(e) })); }
          sendJSON(res, { ok: true, ...info });
        });
      });
    }
    if (req.method === 'POST' && p === '/api/kill') {
      return readBody(req, (err, body) => {
        if (err) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'requête invalide' })); }
        const id = body && body.id;
        if (!id) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'id requis' })); }
        killSession(id, (e, info) => {
          if (e) { res.writeHead(e.code === 400 ? 400 : 502); return res.end(JSON.stringify({ ok: false, error: e.message || String(e) })); }
          sendJSON(res, { ok: true, ...info });
        });
      });
    }
    if (p === '/api/sessions') return sendJSON(res, { sessions: buildSessions(), now: new Date().toISOString() });
    if (p === '/api/stats') {
      const range = u.query.range;
      const days = range === 'all' ? 0 : parseInt(range || '7', 10);
      return sendJSON(res, buildStats(days));
    }
    if (p === '/api/files') {
      // auto-complétion @ : fichiers du projet de la session (cwd dérivé de la session,
      // jamais d'un chemin arbitraire fourni par le client → pas de listing hors projet).
      const sess = scanSessions().find((x) => x.id === u.query.id);
      if (!sess || !sess.project) return sendJSON(res, { files: [] });
      const files = matchFiles(projectFiles(sess.project), u.query.q || '');
      return sendJSON(res, { files });
    }
    if (p === '/api/session') {
      const d = sessionDetail(u.query.id);
      if (!d) { res.writeHead(404); return res.end('{}'); }
      return sendJSON(res, d);
    }
    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    return serveStatic(res, p);
  } catch (e) {
    res.writeHead(500); res.end(String(e && e.message || e));
  }
});

server.listen(PORT, () => {
  console.log(`\n  🪝  hooked — dashboard sur http://localhost:${PORT}\n`);
  console.log(`  Sessions scannées dans ${PROJECTS_DIR}`);
  console.log(`  Évènements live depuis ${EVENTS_FILE}\n`);
});
