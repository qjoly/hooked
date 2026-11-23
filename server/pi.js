/*
 * Provider pi (CLI agent de earendil-works) — scan et parse des sessions pi, cf. docs/port-pi.md.
 *
 * Source : ~/.pi/agent/sessions/--<cwd encodé>--/<timestamp>_<sessionId>.jsonl (JSONL, arbre
 * id/parentId, v3). Ligne 0 = header {type:"session",version,id,timestamp,cwd,parentSession?} ;
 * entrées : model_change, thinking_level_change, message (system/user/assistant/toolResult),
 * session_info (name), usage, compaction, branch_summary, label, custom.
 *
 * Même shape de retour que le scan Claude (blankSummary + provider:'pi') pour que stats.js et le
 * front n'aient qu'une branche provider à gérer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PI_SESSIONS_DIR } from './config.js';
import { blankSummary } from './transcript.js';
import { readdirSafe, statSafe, textOf, cleanPrompt, truncTitle, toolDetail, toolInputText, toolDiffOps, toolResultText } from './util.js';
import { costForUsage } from './pricing.js';
import { anyCachedModel } from './piCatalog.js';

const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const ISSUE_URL_RE = /https:\/\/(?:github\.com\/[\w.-]+\/[\w.-]+\/issues|[\w.-]+\/[\w./-]+?\/-\/(?:issues|work_items))\/\d+/g;

// Context windows: pi's catalog when it was listed in this process (server/piCatalog.js, any
// provider), else rough fallbacks by model family for the CTX gauge.
const CTX_WINDOW = [
  [/large/, 1_000_000],
  [/glm/, 1_000_000],
  [/devstral/, 262_144],
  [/medium/, 262_144],
  [/small|ministral|magistral/, 131_072],
  [/codestral|pixtral/, 256_000],
];
const DEFAULT_CTX_WINDOW = 262_144;
function contextWindowFor(model, modelProvider = null) {
  const ref = modelProvider && model && !String(model).includes('/') ? `${modelProvider}/${model}` : model;
  const hit = anyCachedModel(ref);
  if (hit && hit.contextWindow) return hit.contextWindow;
  for (const [re, w] of CTX_WINDOW) if (re.test(String(model || ''))) return w;
  return DEFAULT_CTX_WINDOW;
}

// pi's own cost of a message ({ cost: { input, output, cacheRead, cacheWrite, total } }) in the
// costForUsage shape, or null when pi did not price it.
function piCost(u) {
  const c = u && u.cost;
  if (!c || typeof c !== 'object' || typeof c.total !== 'number' || !(c.total > 0)) return null;
  return {
    inp: u.input || 0, out: u.output || 0, cc: u.cacheWrite || 0, cr: u.cacheRead || 0,
    cIn: c.input || 0, cOut: c.output || 0, cCc: c.cacheWrite || 0, cCr: c.cacheRead || 0, total: c.total,
  };
}

// usage pi {input, output, cacheRead, cacheWrite, totalTokens, cost} → shape Anthropic de costForUsage
function piUsageToAnthropic(u) {
  return {
    input_tokens: u.input || 0,
    output_tokens: u.output || 0,
    cache_creation_input_tokens: u.cacheWrite || 0,
    cache_read_input_tokens: u.cacheRead || 0,
  };
}

// Nom court d'un tool pi pour le compteur s.tools : mcp__serveur__tool → mcp:serveur, sinon le nom.
function piShortTool(name) {
  const n = String(name || '');
  const m = n.match(/^mcp__([^_]+)__/);
  return m ? 'mcp:' + m[1] : n;
}

// ── Lecture mémoïsée d'un fichier de session ───────────────────────────────────────────────────
const piCache = new Map(); // file -> { key, header, entries, summary }

function piRead(file) {
  const st = statSafe(file);
  if (!st || !st.isFile()) return null;
  const key = st.mtimeMs + ':' + st.size;
  const c = piCache.get(file);
  if (c && c.key === key) return c;
  let header = null;
  const entries = [];
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch (_) { continue; }
      if (!header && e.type === 'session') { header = e; continue; }
      if (e.type) entries.push(e);
    }
  } catch (_) { return null; }
  if (!header) return null;
  const out = { key, file, header, entries, summary: null };
  piCache.set(file, out);
  return out;
}

// Branche active de l'arbre : le leaf est la DERNIRE entrée du fichier (append-only) ; on remonte
// via parentId. Renvoie les entrées de la branche, dans l'ordre du fichier.
function activeBranch(entries) {
  if (!entries.length) return [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  let leaf = entries[entries.length - 1];
  const onBranch = new Set();
  for (let cur = leaf; cur; cur = cur.parentId ? byId.get(cur.parentId) : null) onBranch.add(cur.id);
  return entries.filter((e) => onBranch.has(e.id));
}

// ── Résumé (blankSummary + provider:'pi') ───────────────────────────────────────────────────────
const branchCache = new Map(); // project -> { at, branch }
function gitBranchOf(project) {
  if (!project) return null;
  const now = Date.now();
  const c = branchCache.get(project);
  if (c && now - c.at < 30_000) return c.branch;
  let branch = null;
  try {
    const head = fs.readFileSync(path.join(project, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    branch = m ? m[1] : (head.match(/^[0-9a-f]{40}$/) ? head.slice(0, 7) : null);
  } catch (_) {}
  branchCache.set(project, { at: now, branch });
  return branch;
}

function finalizePi(read) {
  const { header, entries, file } = read;
  const s = blankSummary(header.id || path.basename(file).replace(/\.jsonl$/, ''), file);
  s.provider = 'pi';
  s.dir = path.dirname(file); // compat : plusieurs appels utilisaient s.dir
  const branch = activeBranch(entries);
  const cwd = header.cwd || null;
  if (cwd) { s.project = cwd; s.projectName = path.basename(cwd); }
  s.gitBranch = gitBranchOf(cwd);
  if (header.timestamp) s.startTs = header.timestamp;
  if (header.parentSession) {
    const m = String(header.parentSession).match(/_([^_]+)\.jsonl$/);
    if (m) s.forkedFrom = m[1];
  }

  let model = null;
  let modelProvider = null;
  let sessionName = null;
  const prRaw = [];
  const issueRaw = [];
  let lastTs = s.startTs;

  for (const e of branch) {
    if (e.timestamp) {
      if (!s.startTs || e.timestamp < s.startTs) s.startTs = e.timestamp;
      if (!lastTs || e.timestamp > lastTs) lastTs = e.timestamp;
    }
    if (e.type === 'model_change') { model = e.modelId || model; modelProvider = e.provider || modelProvider; }
    else if (e.type === 'session_info' && e.name) sessionName = e.name;
    else if (e.type === 'message' && e.message) {
      const m = e.message;
      const ts = m.timestamp ? new Date(m.timestamp).toISOString() : e.timestamp;
      if (e.type === 'message' && m.role === 'user') {
        const raw = textOf(m.content);
        const t = cleanPrompt(raw);
        if (t) { s.userPrompts++; if (!s.firstPrompt) s.firstPrompt = t; s.lastPrompt = t; }
        for (const mm of raw.matchAll(PR_URL_RE)) prRaw.push(mm[0]);
        for (const mm of raw.matchAll(ISSUE_URL_RE)) issueRaw.push(mm[0]);
      } else if (m.role === 'assistant') {
        if (m.model) { model = m.model; modelProvider = m.provider || modelProvider; }
        const raw = textOf(m.content);
        const t = cleanPrompt(raw);
        if (t) s.lastReply = t;
        s.assistantTurns++;
        if (Array.isArray(m.content)) {
          for (const b of m.content) if (b && b.type === 'toolCall' && b.name) {
            const name = piShortTool(b.name);
            s.tools[name] = (s.tools[name] || 0) + 1;
          }
        }
        for (const mm of raw.matchAll(PR_URL_RE)) prRaw.push(mm[0]);
        for (const mm of raw.matchAll(ISSUE_URL_RE)) issueRaw.push(mm[0]);
        // usage + coût + byDay
        const u = m.usage;
        if (u && (u.totalTokens || u.input || u.output)) {
          const ua = piUsageToAnthropic(u);
          // pi prices every message from its own catalog (the provider's real rates): prefer that
          // over hooked's family table, which only knows Anthropic and a Mistral average.
          const k = piCost(u) || costForUsage(ua, (m.provider || modelProvider) === 'mistral' ? 'mistral' : (m.model || model || ''));
          s.usage.input += k.inp; s.usage.output += k.out; s.usage.cacheCreate += k.cc; s.usage.cacheRead += k.cr;
          s.cost += k.total;
          s.costBreak.input += k.cIn; s.costBreak.output += k.cOut; s.costBreak.cacheCreate += k.cCc; s.costBreak.cacheRead += k.cCr;
          const day = (ts || '').slice(0, 10) || 'unknown';
          const d = (s.byDay[day] = s.byDay[day] || { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, turns: 0 });
          d.input += k.inp; d.output += k.out; d.cacheCreate += k.cc; d.cacheRead += k.cr; d.cost += k.total; d.turns++;
          const contextTokens = u.totalTokens || ((u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0));
          if (contextTokens) s.lastUsage = { ts: ts || s.lastTs || null, contextTokens, ttl: null };
        }
      } else if (m.role === 'toolResult' && m.toolName === 'Agent' && m.details && m.details.usage) {
        // A subagent of hooked's pi package (pi-package/extensions/agent.js): its usage is in the
        // tool result only, as Claude Code's subagents are in toolUseResult.usage.
        // Priced like the session's own messages: pi's figure when it has one, else hooked's table
        // (pi reports 0 for a subscription model such as pi-claude-bridge's).
        const u = m.details.usage;
        const sub = String(m.details.model || '');
        const k = Number(u.cost) > 0
          ? { inp: u.input || 0, out: u.output || 0, cc: u.cacheWrite || 0, cr: u.cacheRead || 0, cIn: 0, cOut: 0, cCc: 0, cCr: 0, total: Number(u.cost) }
          : costForUsage(piUsageToAnthropic(u), sub.startsWith('mistral/') ? 'mistral' : sub.slice(sub.indexOf('/') + 1));
        s.subagents++;
        s.subagentCost += k.total;
        s.cost += k.total;
        s.usage.input += k.inp; s.usage.output += k.out; s.usage.cacheRead += k.cr; s.usage.cacheCreate += k.cc;
        s.costBreak.input += k.cIn; s.costBreak.output += k.cOut; s.costBreak.cacheCreate += k.cCc; s.costBreak.cacheRead += k.cCr;
        const day = (ts || '').slice(0, 10) || 'unknown';
        const d = (s.byDay[day] = s.byDay[day] || { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, turns: 0 });
        d.input += k.inp; d.output += k.out; d.cacheCreate += k.cc; d.cacheRead += k.cr; d.cost += k.total;
      }
    }
  }
  s.lastTs = lastTs || s.startTs || null;
  s.model = model || null;
  s.modelProvider = modelProvider || null;
  // `provider/id`: what a provider's `models` patterns are matched against (cf. providerConfig.js).
  s.modelRef = model ? (modelProvider ? `${modelProvider}/${model}` : model) : null;
  s.prLinks = [...new Set(prRaw.slice().reverse())].slice(0, 12);
  s.issueLinks = [...new Set(issueRaw.slice().reverse())].slice(0, 12);
  s.title = sessionName || truncTitle(s.firstPrompt, 80) || '(sans titre)';
  read.summary = s;
  return s;
}

// ── Scan de toutes les sessions pi ──────────────────────────────────────────────────────────────
function scanPiSessions(sessionsDir = PI_SESSIONS_DIR) {
  const out = [];
  for (const sub of readdirSafe(sessionsDir)) {
    const subDir = path.join(sessionsDir, sub);
    if (!statSafe(subDir)?.isDirectory()) continue;
    for (const f of readdirSafe(subDir)) {
      if (!f.endsWith('.jsonl')) continue; // .trashed = corbeille (cf. piSetArchived)
      const file = path.join(subDir, f);
      const read = piRead(file);
      if (!read) continue;
      try { out.push(finalizePi(read)); } catch (_) {}
    }
  }
  out.sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')));
  return out;
}

function getPiSession(id, sessionsDir = PI_SESSIONS_DIR) {
  return scanPiSessions(sessionsDir).find((x) => x.id === id) || null;
}

// Chemin du fichier .jsonl d'une session pi par id (scan rapide, sans résumé).
function findPiFile(sessionsDir, id) {
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) return null;
  for (const sub of readdirSafe(sessionsDir)) {
    const subDir = path.join(sessionsDir, sub);
    if (!statSafe(subDir)?.isDirectory()) continue;
    for (const f of readdirSafe(subDir)) {
      if (!f.endsWith('.jsonl')) continue;
      if (f.includes('_' + id + '.jsonl')) return path.join(subDir, f);
    }
  }
  return null;
}

// ── Conversation (shape identique à conversationOf côté Claude) ─────────────────────────────────
// pi tool name → toolDiffOps : write {path,content} → Write ; edit {path,edits:[{oldText,newText}]} → MultiEdit.
function piToolDiff(name, args) {
  if (!args || typeof args !== 'object') return null;
  if (name === 'write') return toolDiffOps('Write', { file_path: args.path, content: args.content });
  if (name === 'edit' && Array.isArray(args.edits)) {
    return toolDiffOps('MultiEdit', {
      file_path: args.path,
      edits: args.edits.map((e) => ({ old_string: e.oldText, new_string: e.newText })),
    });
  }
  return null;
}

function buildPiConversation(file) {
  const read = piRead(file);
  if (!read) return [];
  const branch = activeBranch(read.entries);
  const msgs = [];
  const toolByCallId = new Map(); // toolCallId -> tool object (dans la dernière bulle assistant)
  const partByCallId = new Map(); // toolCallId -> part (pour poser le result sans reference circulaire)
  for (const e of branch) {
    if (e.type !== 'message' || !e.message) continue;
    const m = e.message;
    const ts = m.timestamp ? new Date(m.timestamp).toISOString() : e.timestamp;
    if (m.role === 'user') {
      const text = textOf(m.content);
      if (!text.trim()) continue;
      msgs.push({ role: 'user', ts, text: text.slice(0, 200000), tools: [], parts: text.trim() ? [{ type: 'text', text }] : [], forkUuid: e.id });
      continue;
    }
    if (m.role === 'toolResult') {
      const tool = toolByCallId.get(m.toolCallId);
      const part = partByCallId.get(m.toolCallId);
      const result = toolResultText(m.content);
      if (tool) {
        tool.result = result;
        tool.output = result;
        tool.status = m.isError ? 'error' : 'done';
      }
      if (part) part.result = result;
      continue;
    }
    if (m.role !== 'assistant') continue; // system ignoré
    let text = '';
    let thinking = '';
    const tools = [];
    const parts = [];
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && b.text) {
          text += (text ? '\n' : '') + b.text;
          parts.push({ type: 'text', text: b.text });
        } else if (b.type === 'thinking' && b.thinking && b.thinking.trim()) {
          // Kept as an ordered part so every turn's reasoning stays in the conversation,
          // not only the live stream's (which is reset at each turn).
          thinking += (thinking ? '\n' : '') + b.thinking;
          parts.push({ type: 'thinking', text: b.thinking.trim() });
        } else if (b.type === 'toolCall') {
          const tool = {
            id: b.id || null,
            name: b.name,
            detail: toolDetail(b.arguments),
            inputText: toolInputText(b.arguments),
            result: null,
            status: 'running',
            input: b.arguments,
            output: null,
            diff: piToolDiff(b.name, b.arguments) || undefined,
          };
          tools.push(tool);
          const part = { type: 'tool', tool, diff: tool.diff };
          parts.push(part);
          if (b.id) { toolByCallId.set(b.id, tool); partByCallId.set(b.id, part); }
        }
      }
    }
    text = text.trim();
    if (!text && !tools.length && !thinking) continue;
    msgs.push({
      role: 'assistant',
      ts,
      text,
      thinking: thinking || undefined,
      tools,
      parts,
      forkUuid: e.id,
      model: m.model || undefined,
      usage: m.usage || undefined,
      stopReason: m.stopReason || undefined,
    });
  }
  return msgs;
}

// ── Corbeille : renommer .jsonl ↔ .jsonl.trashed (pi ne lit que les .jsonl) ──────────────────
function piSetArchived(file, archived) {
  try {
    if (archived) {
      if (!file.endsWith('.jsonl')) return false;
      fs.renameSync(file, file + '.trashed');
    } else {
      if (!file.endsWith('.trashed')) return false;
      fs.renameSync(file, file.slice(0, -('.trashed'.length)));
    }
    piCache.delete(file);
    return true;
  } catch (_) { return false; }
}

// ── Accessoires détail (subagents/screenshots : pi n'en a pas nativement) ──────────────────────
// Todos: the TodoWrite tool of hooked's pi package (Claude Code's schema, the whole list on every
// call), so the last call on the active branch is the list. Same shape as server/todos.js.
function latestPiTodos(file) {
  const read = file ? piRead(file) : null;
  if (!read) return null;
  let latest = null;
  for (const e of activeBranch(read.entries)) {
    const m = e.type === 'message' ? e.message : null;
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b || b.type !== 'toolCall' || b.name !== 'TodoWrite' || !Array.isArray(b.arguments?.todos)) continue;
      latest = {
        ts: e.timestamp || null,
        todos: b.arguments.todos.map((t) => ({
          content: String((t && t.content) || ''),
          status: t && (t.status === 'completed' || t.status === 'in_progress') ? t.status : 'pending',
          activeForm: String((t && t.activeForm) || ''),
        })),
      };
    }
  }
  return latest;
}
function piSubagents() { return []; }

// Background commands of hooked's pi package (pi-package/extensions/background.js), in the shape of
// server/background.js: started by BashBackground (its result carries the id), ended by a
// `hooked-task` entry (completion message, or the stop written at session shutdown) or KillShell.
function piBackgroundJobs(file) {
  const read = file ? piRead(file) : null;
  if (!read) return { jobs: [], active: [] };
  const byCall = new Map();
  const byShell = new Map();
  const end = (shellId, reason, ts, exitCode = null) => {
    const j = byShell.get(shellId);
    if (j && !j.done) { j.done = true; j.doneReason = reason; j.doneAt = ts || null; j.exitCode = exitCode; }
  };
  for (const e of activeBranch(read.entries)) {
    const ts = e.timestamp || null;
    if ((e.type === 'custom_message' || e.type === 'custom') && e.customType === 'hooked-task') {
      const d = e.details || e.data || {};
      if (d.shellId) end(d.shellId, d.status || 'completed', ts, d.exitCode ?? null);
      continue;
    }
    const m = e.type === 'message' ? e.message : null;
    if (!m) continue;
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || b.type !== 'toolCall') continue;
        if (b.name === 'BashBackground' && b.id) {
          byCall.set(b.id, { kind: 'bash', toolUseId: b.id, taskId: null, command: String(b.arguments?.command || '').slice(0, 2000), description: String(b.arguments?.description || ''), startTs: ts, done: false, doneReason: null, doneAt: null, exitCode: null, outputPath: null });
        } else if (b.name === 'KillShell' && b.arguments?.shell_id) {
          end(String(b.arguments.shell_id), 'stopped', ts);
        }
      }
    } else if (m.role === 'toolResult' && m.toolName === 'BashBackground') {
      const j = byCall.get(m.toolCallId);
      if (!j) continue;
      const id = m.details?.shellId || (/ID: (bg-\d+)/.exec(textOf(m.content)) || [])[1];
      if (id && !m.isError) { j.taskId = id; byShell.set(id, j); } else { j.done = true; j.doneReason = 'failed'; j.doneAt = ts; }
    }
  }
  const jobs = [...byCall.values()];
  return { jobs, active: jobs.filter((j) => !j.done) };
}
function piSubSessions() { return []; }
function piScreenshots() { return []; }

// Chemins de fichiers mentionnés par les tools (read/edit/write) — allowlist /api/user-file.
function piToolPaths(file) {
  const read = piRead(file);
  if (!read) return [];
  const out = new Set();
  for (const e of activeBranch(read.entries)) {
    if (e.type !== 'message' || e.message?.role !== 'assistant' || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) {
      if (b && b.type === 'toolCall' && ['read', 'edit', 'write'].includes(b.name) && b.arguments?.path) {
        out.add(path.isAbsolute(b.arguments.path) ? b.arguments.path : path.resolve(read.header.cwd || '', b.arguments.path));
      }
    }
  }
  return [...out];
}

// Jauge de contexte (scan, sans driver) : dernier usage + fenêtre du modèle.
function piContext(s) {
  const u = s.lastUsage;
  if (!u || !u.contextTokens) return null;
  const size = u.contextTokens;
  const win = contextWindowFor(s.model, s.modelProvider);
  return { pct: Math.min(100, (size / win) * 100), size, contextWindow: win };
}

// Trace (vue turns/spans) depuis les entrées de la branche active. Les timestamps sont en epoch ms
// (number) comme buildTrace côté Claude : le desktop (TraceSpan.start: f64) et le web font de
// l'arithmétique dessus. pi stocke ceux des messages en ms (number) et ceux des entrées en ISO.
const tsMs = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : null;
};

function buildPiTrace(file) {
  const read = piRead(file);
  if (!read) return { turns: [] };
  const branch = activeBranch(read.entries);
  const turns = [];
  let cur = null;
  for (const e of branch) {
    if (e.type !== 'message' || !e.message) continue;
    const m = e.message;
    const ts = tsMs(m.timestamp) ?? tsMs(e.timestamp) ?? 0;
    if (m.role === 'user') {
      cur = { prompt: textOf(m.content).replace(/\s+/g, ' ').slice(0, 160), start: ts, end: null, spans: [] };
      turns.push(cur);
    } else if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && b.type === 'toolCall') {
          if (cur) cur.spans.push({ id: b.id, name: b.name, detail: toolDetail(b.arguments), start: ts, end: null, error: false });
        }
      }
      if (cur) cur.end = ts;
    } else if (m.role === 'toolResult' && cur) {
      const span = cur.spans.find((x) => x.id === m.toolCallId);
      if (span) { span.end = ts; span.error = !!m.isError; }
    }
  }
  return { turns };
}

// Détail d'un tool (input/result) pour /api/session/message et le dock.
function piToolDetail(file, toolCallId) {
  const read = piRead(file);
  if (!read) return null;
  for (const e of activeBranch(read.entries)) {
    if (e.type !== 'message' || !e.message) continue;
    const m = e.message;
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const b = m.content.find((x) => x && x.type === 'toolCall' && x.id === toolCallId);
      if (b) {
        let result = null; let error = false;
        for (const e2 of activeBranch(read.entries)) {
          if (e2.type === 'message' && e2.message?.role === 'toolResult' && e2.message.toolCallId === toolCallId) {
            result = toolResultText(e2.message.content); error = !!e2.message.isError;
          }
        }
        // input en texte (comme readToolDetail côté Claude) : le lens Trace l'affiche en <pre>.
        return { input: toolInputText(b.arguments), result, error };
      }
    }
  }
  return null;
}

function piToolOutput(file, toolCallId) {
  const d = piToolDetail(file, toolCallId);
  return d ? d.result : null;
}

function piMessageText(file, entryId) {
  const read = piRead(file);
  if (!read) return null;
  const e = read.entries.find((x) => x.id === entryId);
  if (!e || e.type !== 'message') return null;
  return textOf(e.message?.content);
}

export {
  scanPiSessions, getPiSession, buildPiConversation, piRead, piSetArchived,
  latestPiTodos, piSubagents, piBackgroundJobs, piSubSessions, piScreenshots, piToolPaths,
  piContext, buildPiTrace, piToolDetail, piToolOutput, piShortTool, piUsageToAnthropic,
  piMessageText, contextWindowFor, activeBranch, finalizePi, findPiFile,
};
