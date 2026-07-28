/*
 * Daily digests: an AI-written recap of what happened across all Claude Code sessions on a given
 * local-timezone day. Deterministic aggregation (sessions touched, prompts, tools, PR/issue links,
 * pending questions) is built from the transcripts; a headless `claude -p` pass then writes the
 * prose summary / highlights / per-session accomplished+pending. The deterministic data is the
 * source of truth for links and pending items — the LLM only enriches it, so a bad/empty model
 * response still leaves a usable digest.
 *
 * Persistence mirrors tags.js/settings.js: one JSON file per day under HOOKED_DIR/digests/.
 * Generation is async: POST writes a `running` marker, the UI polls GET until `done`/`error`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOOKED_DIR, isValidModelArg } from './config.js';
import { scanSessions } from './transcript.js';
import { buildConversation } from './conversation.js';
import { readTags } from './tags.js';
import { readSettings } from './settings.js';

const DIGESTS_DIR = path.join(HOOKED_DIR, 'digests');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SESSIONS = 60;        // cap sessions fed to the model (busy days) — noted in the digest
const MAX_PROMPTS_PER_SESSION = 12;
const PROMPT_CHARS = 600;       // truncate each prompt fed to the model
const RUNNING_STALE_MS = 15 * 60 * 1000; // a running marker older than this is treated as dead
const GEN_TIMEOUT_MS = 5 * 60 * 1000;

const isValidDate = (d) => typeof d === 'string' && DATE_RE.test(d);

// Our own `claude -p` digest runs get recorded as sessions like any other. Skip them so a digest
// doesn't summarize itself — matched by the fixed prefix of buildPrompt's instruction.
const DIGEST_PROMPT_PREFIX = 'You are writing a concise daily engineering digest';

// Local-timezone day string (YYYY-MM-DD). Digest days follow the user's wall clock, not UTC —
// transcript `byDay` slices ISO timestamps to UTC dates, so we recompute from Date locally.
function localDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function tsToLocalDay(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : localDay(d);
}
function yesterdayLocal() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDay(d);
}

function digestPath(date) { return path.join(DIGESTS_DIR, `${date}.json`); }

function readDigest(date) {
  if (!isValidDate(date)) return null;
  try {
    return JSON.parse(fs.readFileSync(digestPath(date), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeDigest(date, obj) {
  if (!isValidDate(date)) throw new Error('invalid digest date');
  try {
    fs.mkdirSync(DIGESTS_DIR, { recursive: true });
    fs.writeFileSync(digestPath(date), JSON.stringify(obj, null, 2) + '\n');
  } catch (e) {
    throw new Error('digest write failed: ' + (e.message || e));
  }
  return obj;
}

// Lightweight index of stored digests, newest first (for the history list).
function listDigests() {
  let files;
  try { files = fs.readdirSync(DIGESTS_DIR); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
    if (!m) continue;
    const d = readDigest(m[1]);
    if (!d) continue;
    out.push({
      date: m[1],
      status: d.status || 'done',
      generatedAt: d.generatedAt || null,
      totals: d.totals || null,
    });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  return out;
}

// Deterministic per-session view of a single local day. A session is considered active on `date`
// if its [startTs,lastTs] range overlaps the day (cheap pre-filter) AND it has at least one
// message that day. Returns the array of session records (source of truth for links/pending).
function collectSessionsForDay(date) {
  const tags = readTags();
  const out = [];
  for (const s of scanSessions()) {
    const sd = tsToLocalDay(s.startTs);
    const ld = tsToLocalDay(s.lastTs);
    if (sd && ld && (date < sd || date > ld)) continue; // day outside the session's span
    const msgs = buildConversation(s.file);
    const prompts = [];
    const dayTools = {};
    let assistantTurns = 0;
    for (const m of msgs) {
      if (tsToLocalDay(m.ts) !== date) continue;
      if (m.role === 'user' && !m.auto && m.text) {
        if (prompts.length < MAX_PROMPTS_PER_SESSION) prompts.push(m.text.slice(0, PROMPT_CHARS));
      } else if (m.role === 'assistant') {
        assistantTurns++;
        for (const t of m.tools || []) dayTools[t.name] = (dayTools[t.name] || 0) + 1;
      }
    }
    if (!prompts.length && !assistantTurns) continue; // no activity this day
    if (prompts[0]?.startsWith(DIGEST_PROMPT_PREFIX)) continue; // ponytail: our own digest run, not real work
    out.push({
      id: s.id,
      title: s.title,
      project: s.project,
      projectName: s.projectName,
      gitBranch: s.gitBranch,
      model: s.model,
      link: `/session/${s.id}`,
      prompts,
      tools: dayTools,
      assistantTurns,
      cost: (s.byDay && s.byDay[date] && s.byDay[date].cost) || 0,
      dayTurns: (s.byDay && s.byDay[date] && s.byDay[date].turns) || assistantTurns,
      prLinks: s.prLinks || [],
      issueLinks: s.issueLinks || [],
      pendingQuestion: s.pendingQuestion
        ? (s.pendingQuestion.questions || []).map((q) => q.question || q.header).filter(Boolean)
        : [],
      tags: tags[s.id] || [],
      // filled by the LLM pass:
      accomplished: '',
      pending: '',
    });
  }
  // Busiest first, then cap.
  out.sort((a, b) => (b.assistantTurns + b.prompts.length) - (a.assistantTurns + a.prompts.length));
  return out;
}

// Deterministic "still pending" items across the day's sessions (open questions).
function pendingItems(sessions) {
  const out = [];
  for (const s of sessions) {
    for (const q of s.pendingQuestion) {
      out.push({ id: s.id, title: s.title, link: s.link, kind: 'question', text: q });
    }
  }
  return out;
}

function totalsOf(sessions) {
  return {
    sessions: sessions.length,
    cost: sessions.reduce((a, s) => a + (s.cost || 0), 0),
    turns: sessions.reduce((a, s) => a + (s.dayTurns || 0), 0),
    prompts: sessions.reduce((a, s) => a + s.prompts.length, 0),
  };
}

// Markdown brief handed to the model. Compact but complete enough to summarize a day.
function buildBrief(date, sessions, truncated) {
  const lines = [`# Claude Code activity for ${date}`, ''];
  if (truncated) lines.push(`_(showing the ${sessions.length} busiest sessions of the day)_`, '');
  sessions.forEach((s, i) => {
    lines.push(`## [${i + 1}] ${s.title || '(untitled)'}  — id: ${s.id}`);
    lines.push(`- project: ${s.projectName || s.project || '?'}${s.gitBranch ? ` (branch ${s.gitBranch})` : ''}`);
    const toolStr = Object.entries(s.tools).map(([k, v]) => `${k}×${v}`).join(', ');
    if (toolStr) lines.push(`- tools: ${toolStr}`);
    if (s.prLinks.length) lines.push(`- PRs: ${s.prLinks.join(', ')}`);
    if (s.issueLinks.length) lines.push(`- issues: ${s.issueLinks.join(', ')}`);
    if (s.pendingQuestion.length) lines.push(`- OPEN QUESTION: ${s.pendingQuestion.join(' | ')}`);
    if (s.prompts.length) {
      lines.push('- prompts:');
      for (const p of s.prompts) lines.push(`  > ${p.replace(/\n+/g, ' ')}`);
    }
    lines.push('');
  });
  return lines.join('\n');
}

function buildPrompt(date, sessions, truncated) {
  const brief = buildBrief(date, sessions, truncated);
  return `${DIGEST_PROMPT_PREFIX} for ${date}, summarizing the work done across the Claude Code sessions below. Each session has a numeric label [N] and an id.

${brief}

Respond with ONLY a JSON object (no markdown fence, no prose around it) of this exact shape:
{
  "summary": "2-5 sentence markdown recap of the day's work overall",
  "highlights": ["short bullet of a notable accomplishment", "..."],
  "perSession": [ { "id": "<session id>", "accomplished": "1-2 sentences on what this session did", "pending": "what is left to do / blocked, or empty string" } ],
  "blockers": ["anything explicitly blocked or awaiting a decision, or omit if none"]
}
Keep it factual and grounded in the briefs above. Prefer specifics (file/feature/PR names) over generic phrasing. Include a perSession entry for every session id.`;
}

// Extract a JSON object from `claude -p --output-format json` output. The envelope wraps the model
// text in `.result`; the model text may itself be fenced. A login-shell preamble (zoxide/p10k/nvm)
// can prepend noise to stdout, so extract the object by braces rather than JSON.parse-ing the whole
// stream — then unwrap `.result` if we landed on the envelope. Robust to leading/trailing noise.
function objFromBraces(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { return null; }
}
function parseModelJson(stdout) {
  let obj = objFromBraces(stdout);
  if (obj && typeof obj.result === 'string') obj = objFromBraces(obj.result); // unwrap envelope → model text
  return obj;
}

// Run `claude -p` headless, feeding the prompt on stdin. Wrapped in a login+interactive shell for
// PATH parity with launchSession (brew/asdf/nvm publish PATH in login files) so a hooked started
// from launchd/systemd/cron still finds `claude`. Returns a promise of parsed model JSON (or null).
function runClaude(prompt) {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    const model = readSettings().digest?.model;
    const modelFlag = model && isValidModelArg(model) ? ` --model ${model}` : '';
    const cmd = `claude -p --output-format json${modelFlag}`;
    const child = spawn(shell, ['-l', '-i', '-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish({ error: 'claude -p timed out' }); }, GEN_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); finish({ error: 'claude -p failed to start: ' + (e.message || e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseModelJson(out);
      if (parsed) return finish({ parsed });
      finish({ error: `claude -p produced no parseable output (exit ${code})${err ? ': ' + err.slice(0, 300) : ''}` });
    });
    try { child.stdin.write(prompt); child.stdin.end(); } catch (_) {}
  });
}

// Merge the LLM enrichment onto the deterministic sessions (matched by id).
function mergeLlm(sessions, llm) {
  const byId = new Map((llm.perSession || []).map((p) => [p.id, p]));
  for (const s of sessions) {
    const p = byId.get(s.id);
    if (p) { s.accomplished = String(p.accomplished || ''); s.pending = String(p.pending || ''); }
  }
}

// Whether a digest for `date` is currently being generated (fresh running marker).
function isRunning(date) {
  const d = readDigest(date);
  if (!d || d.status !== 'running') return false;
  const started = Date.parse(d.startedAt || 0);
  return !isNaN(started) && (Date.now() - started) < RUNNING_STALE_MS;
}

// Kick off (async) generation of the digest for `date`. Writes a `running` marker synchronously and
// returns it; the actual work (aggregation + claude -p) runs in the background and rewrites the file
// with status `done` or `error`. `force` re-generates even if a digest already exists.
function startGeneration(date, { force = false } = {}) {
  if (!isValidDate(date)) throw new Error('invalid digest date');
  if (isRunning(date)) return readDigest(date);
  const existing = readDigest(date);
  if (existing && existing.status === 'done' && !force) return existing;

  const marker = { date, status: 'running', startedAt: new Date().toISOString() };
  writeDigest(date, marker);
  generate(date).catch((e) => {
    try { writeDigest(date, { date, status: 'error', error: String(e && e.message || e), generatedAt: new Date().toISOString() }); } catch (_) {}
  });
  return marker;
}

// The background work. Separated so tests can drive it directly (with claude -p stubbed via
// HOOKED_DIGEST_STUB — see below) and so startGeneration stays fire-and-forget.
async function generate(date) {
  const all = collectSessionsForDay(date);
  const truncated = all.length > MAX_SESSIONS;
  const sessions = all.slice(0, MAX_SESSIONS);

  const base = {
    date,
    status: 'done',
    generatedAt: new Date().toISOString(),
    summary: '',
    highlights: [],
    blockers: [],
    truncated,
    totals: totalsOf(sessions),
  };

  if (!sessions.length) {
    return writeDigest(date, { ...base, summary: '_No Claude Code activity recorded on this day._', sessions: [], pending: [] });
  }

  const stub = process.env.HOOKED_DIGEST_STUB; // test hook: JSON string returned instead of calling claude
  const res = stub ? { parsed: JSON.parse(stub) } : await runClaude(buildPrompt(date, sessions, truncated));

  if (res.parsed) {
    mergeLlm(sessions, res.parsed);
    return writeDigest(date, {
      ...base,
      summary: String(res.parsed.summary || ''),
      highlights: Array.isArray(res.parsed.highlights) ? res.parsed.highlights.map(String) : [],
      blockers: Array.isArray(res.parsed.blockers) ? res.parsed.blockers.map(String) : [],
      sessions,
      pending: pendingItems(sessions),
    });
  }

  // Model failed: keep the deterministic digest, flag the AI error (still fully usable).
  return writeDigest(date, {
    ...base,
    status: 'partial',
    aiError: res.error || 'unknown claude -p error',
    summary: '',
    sessions,
    pending: pendingItems(sessions),
  });
}

export {
  DIGESTS_DIR,
  isValidDate,
  yesterdayLocal,
  readDigest,
  writeDigest,
  listDigests,
  collectSessionsForDay,
  buildBrief,
  buildPrompt,
  parseModelJson,
  startGeneration,
  generate as generateDigest,
  isRunning,
};
