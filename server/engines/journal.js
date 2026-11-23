/*
 * Session journal kept by hooked itself, for engines whose agent stores nothing hooked can read
 * (ACP agents, external engine modules). The driver writes what it sees on the wire; this module
 * reads it back in the shapes the dashboard already uses (summary, conversation, trace, todos,
 * context), so such a provider gets the session list, the conversation view, the Trace lens,
 * search and the trash without writing any parser of its own.
 *
 * Layout: <root>/<providerId>/<sessionId>.jsonl — append-only, one JSON record per line:
 *   {t:'session', v:1, id, provider, engine, cwd, ts, title?, model?, agent?}   (first line)
 *   {t:'user', ts, id, text}
 *   {t:'text', ts, text}                    assistant prose (one record per flushed segment)
 *   {t:'thinking', ts, text}
 *   {t:'tool', ts, id, name, title?, kind?, input?, status}
 *   {t:'tool_update', ts, id, status?, output?, error?, input?, title?, diffs?}
 *   {t:'todos', ts, todos:[{content, status, priority?}]}
 *   {t:'usage', ts, input?, output?, cacheRead?, cacheWrite?, cost?, contextTokens?, contextWindow?}
 *   {t:'meta', ts, title?, model?, mode?, effort?}
 *   {t:'turn_end', ts, stopReason?}
 *   {t:'error', ts, message}
 * A trashed session is renamed `<id>.jsonl.trashed` and leaves the scan.
 */
import fs from 'node:fs';
import path from 'node:path';
import { HOOKED_DIR } from '../config.js';
import { blankSummary } from '../transcript.js';
import { readdirSafe, statSafe, cleanPrompt, truncTitle, toolDetail, toolInputText, toolDiffOps } from '../util.js';
import { costForUsage } from '../pricing.js';

const ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const ISSUE_URL_RE = /https:\/\/(?:github\.com\/[\w.-]+\/[\w.-]+\/issues|[\w.-]+\/[\w./-]+?\/-\/(?:issues|work_items))\/\d+/g;

function journalRoot() {
  return process.env.HOOKED_AGENT_SESSIONS_DIR || path.join(HOOKED_DIR, 'agent-sessions');
}

// Session ids come from agents: keep them path-safe (they name a file).
const safeId = (id) => (typeof id === 'string' && ID_RE.test(id) && !id.includes('..') ? id : null);

function journalFile(providerId, sessionId, root = journalRoot()) {
  const sid = safeId(sessionId);
  if (!sid || !/^[a-z][a-z0-9-]{0,31}$/.test(providerId || '')) return null;
  return path.join(root, providerId, sid.replace(/:/g, '_') + '.jsonl');
}

// ── Writer ───────────────────────────────────────────────────────────────────────────────────────
// Text and thinking arrive as deltas: they are buffered and written as one record per segment
// (flushed at a tool call, a turn end, a user message, or when the buffer grows large), so a
// journal holds readable records rather than one line per token.
class JournalWriter {
  constructor(file, header) {
    this.file = file;
    this.buf = { text: '', thinking: '' };
    this.paused = false; // true while an agent replays history (ACP session/load): nothing recorded
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!statSafe(file)) this._append({ t: 'session', v: 1, ts: new Date().toISOString(), ...header });
  }

  _append(rec) {
    if (this.paused) return;
    try { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch (_) { /* best effort */ }
  }

  _flush(kind) {
    for (const k of kind ? [kind] : ['thinking', 'text']) {
      const v = this.buf[k];
      if (v && v.trim()) this._append({ t: k, ts: new Date().toISOString(), text: v });
      this.buf[k] = '';
    }
  }

  user(text, id = null) {
    this.flush();
    this._append({ t: 'user', ts: new Date().toISOString(), id: id || 'u' + Date.now().toString(36), text: String(text || '') });
  }
  text(delta) { if (this.paused) return; this.buf.text += delta; if (this.buf.text.length > 16000) this._flush('text'); }
  thinking(delta) { if (this.paused) return; this.buf.thinking += delta; if (this.buf.thinking.length > 16000) this._flush('thinking'); }
  tool(rec) { this.flush(); this._append({ t: 'tool', ts: new Date().toISOString(), status: 'running', ...rec }); }
  toolUpdate(rec) { this._append({ t: 'tool_update', ts: new Date().toISOString(), ...rec }); }
  todos(list) { this._append({ t: 'todos', ts: new Date().toISOString(), todos: list }); }
  usage(u) { this._append({ t: 'usage', ts: new Date().toISOString(), ...u }); }
  meta(m) { this._append({ t: 'meta', ts: new Date().toISOString(), ...m }); }
  turnEnd(stopReason = null) { this.flush(); this._append({ t: 'turn_end', ts: new Date().toISOString(), stopReason }); }
  error(message) { this.flush(); this._append({ t: 'error', ts: new Date().toISOString(), message: String(message || '') }); }
  flush() { this._flush(); }
}

function openJournal(providerId, sessionId, header = {}, root = journalRoot()) {
  const file = journalFile(providerId, sessionId, root);
  if (!file) return null;
  return new JournalWriter(file, { id: sessionId, provider: providerId, ...header });
}

// ── Reader (memoised on mtime:size) ──────────────────────────────────────────────────────────────
const cache = new Map();

function readJournal(file) {
  const st = statSafe(file);
  if (!st || !st.isFile()) return null;
  const key = st.mtimeMs + ':' + st.size;
  const c = cache.get(file);
  if (c && c.key === key) return c;
  let header = null;
  const records = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch (_) { continue; }
      if (!header && r.t === 'session') { header = r; continue; }
      if (r && r.t) records.push(r);
    }
  } catch (_) { return null; }
  if (!header) return null;
  const out = { key, file, header, records };
  cache.set(file, out);
  return out;
}

// Tool records merged with their updates, by id.
function mergedTools(records) {
  const byId = new Map();
  for (const r of records) {
    if (r.t === 'tool' && r.id) byId.set(r.id, { ...r });
    else if (r.t === 'tool_update' && r.id) {
      const cur = byId.get(r.id) || { t: 'tool', id: r.id, name: r.title || 'tool', ts: r.ts };
      for (const k of ['status', 'output', 'error', 'input', 'title', 'diffs', 'name']) if (r[k] !== undefined) cur[k] = r[k];
      cur.endTs = r.ts;
      byId.set(r.id, cur);
    }
  }
  return byId;
}

function toolDiff(tool) {
  const diffs = Array.isArray(tool.diffs) ? tool.diffs.filter((d) => d && d.path) : [];
  if (diffs.length) {
    const d0 = diffs[0];
    if (diffs.length === 1 && (d0.oldText == null || d0.oldText === '')) {
      return toolDiffOps('Write', { file_path: d0.path, content: d0.newText || '' });
    }
    return toolDiffOps('MultiEdit', {
      file_path: d0.path,
      edits: diffs.filter((d) => d.path === d0.path).map((d) => ({ old_string: d.oldText || '', new_string: d.newText || '' })),
    });
  }
  return null;
}

const statusOf = (s) => (s === 'completed' || s === 'done' ? 'done' : (s === 'failed' || s === 'error' ? 'error' : 'running'));

// Summary in the scan shape (blankSummary), `provider` from the header (or the folder name).
function summarize(read, fallbackProvider = null) {
  const { header, records, file } = read;
  const s = blankSummary(header.id || path.basename(file).replace(/\.jsonl$/, ''), file);
  s.provider = header.provider || fallbackProvider;
  s.engine = header.engine || null;
  s.dir = path.dirname(file);
  if (header.cwd) { s.project = header.cwd; s.projectName = path.basename(header.cwd); }
  s.startTs = header.ts || null;
  let lastTs = s.startTs;
  let title = header.title || null;
  let model = header.model || null;
  const prRaw = [];
  const issueRaw = [];
  for (const r of records) {
    if (r.ts && (!lastTs || r.ts > lastTs)) lastTs = r.ts;
    if (r.t === 'user') {
      const t = cleanPrompt(String(r.text || ''));
      if (t) { s.userPrompts++; if (!s.firstPrompt) s.firstPrompt = t; s.lastPrompt = t; }
      for (const m of String(r.text || '').matchAll(PR_URL_RE)) prRaw.push(m[0]);
      for (const m of String(r.text || '').matchAll(ISSUE_URL_RE)) issueRaw.push(m[0]);
    } else if (r.t === 'text') {
      const t = cleanPrompt(String(r.text || ''));
      if (t) s.lastReply = t;
      for (const m of String(r.text || '').matchAll(PR_URL_RE)) prRaw.push(m[0]);
      for (const m of String(r.text || '').matchAll(ISSUE_URL_RE)) issueRaw.push(m[0]);
    } else if (r.t === 'turn_end') {
      s.assistantTurns++;
    } else if (r.t === 'tool') {
      const name = String(r.name || 'tool');
      s.tools[name] = (s.tools[name] || 0) + 1;
    } else if (r.t === 'meta') {
      if (r.title) title = r.title;
      if (r.model) model = r.model;
    } else if (r.t === 'usage') {
      const ua = {
        input_tokens: r.input || 0, output_tokens: r.output || 0,
        cache_creation_input_tokens: r.cacheWrite || 0, cache_read_input_tokens: r.cacheRead || 0,
      };
      const k = costForUsage(ua, model || '');
      const total = typeof r.cost === 'number' ? r.cost : (r.input || r.output ? k.total : 0);
      s.usage.input += k.inp; s.usage.output += k.out; s.usage.cacheCreate += k.cc; s.usage.cacheRead += k.cr;
      s.cost += total;
      const day = String(r.ts || '').slice(0, 10) || 'unknown';
      const d = (s.byDay[day] = s.byDay[day] || { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, turns: 0 });
      d.input += k.inp; d.output += k.out; d.cacheCreate += k.cc; d.cacheRead += k.cr; d.cost += total; d.turns++;
      const ctx = r.contextTokens || (r.input || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0);
      if (ctx) s.lastUsage = { ts: r.ts || null, contextTokens: ctx, ttl: null, contextWindow: r.contextWindow || null };
    }
  }
  s.lastTs = lastTs || s.startTs;
  s.model = model;
  s.title = title || truncTitle(s.firstPrompt, 80) || '(untitled)';
  s.prLinks = [...new Set(prRaw.reverse())].slice(0, 12);
  s.issueLinks = [...new Set(issueRaw.reverse())].slice(0, 12);
  return s;
}

// Every journaled session of the given providers (all providers when `ids` is null).
function scanJournal(ids = null, root = journalRoot()) {
  const out = [];
  for (const dir of readdirSafe(root)) {
    if (ids && !ids.includes(dir)) continue;
    const sub = path.join(root, dir);
    if (!statSafe(sub)?.isDirectory()) continue;
    for (const f of readdirSafe(sub)) {
      if (!f.endsWith('.jsonl')) continue;
      const read = readJournal(path.join(sub, f));
      if (!read) continue;
      try { out.push(summarize(read, dir)); } catch (_) { /* unreadable: skipped */ }
    }
  }
  out.sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')));
  return out;
}

// Conversation, same message shape as conversationOf / buildPiConversation.
function journalConversation(file) {
  const read = readJournal(file);
  if (!read) return [];
  const tools = mergedTools(read.records);
  const msgs = [];
  let cur = null;
  const assistant = (ts) => {
    if (!cur) {
      cur = { role: 'assistant', ts, text: '', tools: [], parts: [] };
      msgs.push(cur);
    }
    return cur;
  };
  for (const r of read.records) {
    if (r.t === 'user') {
      cur = null;
      const text = String(r.text || '');
      if (!text.trim()) continue;
      msgs.push({ role: 'user', ts: r.ts, text: text.slice(0, 200000), tools: [], parts: [{ type: 'text', text }], forkUuid: r.id || undefined });
    } else if (r.t === 'text' && r.text) {
      const a = assistant(r.ts);
      a.text += (a.text ? '\n' : '') + r.text;
      a.parts.push({ type: 'text', text: r.text });
    } else if (r.t === 'thinking' && r.text && r.text.trim()) {
      const a = assistant(r.ts);
      a.thinking = (a.thinking ? a.thinking + '\n' : '') + r.text;
      a.parts.push({ type: 'thinking', text: r.text.trim() });
    } else if (r.t === 'tool') {
      const m = tools.get(r.id) || r;
      const input = m.input && typeof m.input === 'object' ? m.input : {};
      const tool = {
        id: m.id || null,
        name: m.name || 'tool',
        detail: m.title || toolDetail(input),
        inputText: toolInputText(input),
        result: m.output != null ? String(m.output).slice(0, 4000) : null,
        output: m.output != null ? String(m.output).slice(0, 4000) : null,
        status: statusOf(m.status),
        input,
        diff: toolDiff(m) || undefined,
      };
      const a = assistant(r.ts);
      a.tools.push(tool);
      a.parts.push({ type: 'tool', tool, diff: tool.diff, result: tool.result });
    } else if (r.t === 'error') {
      const a = assistant(r.ts);
      a.parts.push({ type: 'text', text: '⚠ ' + r.message });
      a.text += (a.text ? '\n' : '') + '⚠ ' + r.message;
    } else if (r.t === 'turn_end') {
      cur = null;
    }
  }
  return msgs.filter((m) => m.role === 'user' || m.text || m.tools.length || m.thinking);
}

function journalTrace(file) {
  const read = readJournal(file);
  if (!read) return { turns: [] };
  const tools = mergedTools(read.records);
  const ms = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : 0; };
  const turns = [];
  let cur = null;
  for (const r of read.records) {
    if (r.t === 'user') {
      cur = { prompt: String(r.text || '').replace(/\s+/g, ' ').slice(0, 160), start: ms(r.ts), end: null, spans: [] };
      turns.push(cur);
    } else if (r.t === 'tool' && cur) {
      const m = tools.get(r.id) || r;
      cur.spans.push({ id: r.id, name: m.name || 'tool', detail: m.title || toolDetail(m.input), start: ms(r.ts), end: m.endTs ? ms(m.endTs) : null, error: statusOf(m.status) === 'error' });
      cur.end = ms(m.endTs || r.ts);
    } else if (cur && (r.t === 'text' || r.t === 'turn_end')) {
      cur.end = ms(r.ts);
    }
  }
  return { turns };
}

function journalToolDetail(file, toolId) {
  const read = readJournal(file);
  if (!read) return null;
  const m = mergedTools(read.records).get(toolId);
  if (!m) return null;
  return { input: toolInputText(m.input || {}), result: m.output != null ? String(m.output) : null, error: statusOf(m.status) === 'error' };
}

function journalMessageText(file, id) {
  const read = readJournal(file);
  if (!read) return null;
  const r = read.records.find((x) => x.t === 'user' && x.id === id);
  return r ? String(r.text || '') : null;
}

// Latest todo list ({ todos, ts }, the shape of todos.js latestTodos), or null.
function journalTodos(file) {
  const read = readJournal(file);
  if (!read) return null;
  for (let i = read.records.length - 1; i >= 0; i--) {
    const r = read.records[i];
    if (r.t !== 'todos' || !Array.isArray(r.todos)) continue;
    return {
      ts: r.ts,
      todos: r.todos.map((t) => ({
        content: String(t.content || ''),
        status: t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending',
        activeForm: String(t.content || ''),
      })),
    };
  }
  return null;
}

// Context gauge from the last usage record that carried a window.
function journalContext(s) {
  const u = s && s.lastUsage;
  if (!u || !u.contextTokens || !u.contextWindow) return null;
  return { pct: Math.min(100, (u.contextTokens / u.contextWindow) * 100), size: u.contextTokens, contextWindow: u.contextWindow };
}

// Paths the session's tools touched (allowlist of /api/user-file).
function journalToolPaths(file) {
  const read = readJournal(file);
  if (!read) return [];
  const cwd = read.header.cwd || '';
  const out = new Set();
  for (const m of mergedTools(read.records).values()) {
    const p = m.input && (m.input.path || m.input.file_path);
    if (typeof p === 'string' && p) out.add(path.isAbsolute(p) ? p : path.resolve(cwd, p));
    for (const d of Array.isArray(m.diffs) ? m.diffs : []) if (d && typeof d.path === 'string') out.add(path.isAbsolute(d.path) ? d.path : path.resolve(cwd, d.path));
  }
  return [...out];
}

// Trash: rename to .trashed (out of the scan), and back.
function journalSetArchived(file, archived) {
  try {
    if (archived) {
      if (!file.endsWith('.jsonl')) return false;
      fs.renameSync(file, file + '.trashed');
    } else {
      if (!file.endsWith('.trashed')) return false;
      fs.renameSync(file, file.slice(0, -'.trashed'.length));
    }
    cache.delete(file);
    return true;
  } catch (_) { return false; }
}

// A trashed journal by session id (for restore), or null.
function findTrashedJournal(id, root = journalRoot()) {
  const sid = safeId(id);
  if (!sid) return null;
  const name = sid.replace(/:/g, '_') + '.jsonl.trashed';
  for (const dir of readdirSafe(root)) {
    const f = path.join(root, dir, name);
    if (statSafe(f)) return f;
  }
  return null;
}

export {
  journalRoot, journalFile, openJournal, readJournal, scanJournal, summarize as summarizeJournal,
  journalConversation, journalTrace, journalToolDetail, journalMessageText, journalTodos,
  journalContext, journalToolPaths, journalSetArchived, findTrashedJournal, JournalWriter,
};
