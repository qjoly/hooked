/*
 * Auto-tag sessions from their content: one headless Haiku call per session, once, after its first
 * turn. Suggestions are merged into tags.json (never removing a tag), so manual edits always win.
 * Same loop shape as prReviewTags.js (settings toggle, idempotent through globalThis).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOKED_DIR } from './config.js';
import { scanSessions } from './transcript.js';
import { readTags, setTags } from './tags.js';
import { runClaude } from './mcp.js';
import { modelJson } from './claudeJson.js';
import { DIGEST_PROMPT_PREFIX } from './digests.js';
import { PR_REVIEW_TAGS } from './prReviewTags.js';

const TICK_INTERVAL = 60_000;
const CALL_TIMEOUT_MS = 90_000;
// First activation must not tag the whole backlog, only what is still being worked on.
const MAX_AGE_MS = 24 * 3600_000;
const MAX_SUGGESTED = 3;
const DONE_FILE = path.join(HOOKED_DIR, 'auto-tagged.json');

// Status tags owned by other loops: they describe a PR state, not what the session is about.
const NOT_VOCABULARY = new Set([...PR_REVIEW_TAGS, 'incognito']);

function readDone() {
  try { return JSON.parse(fs.readFileSync(DONE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function markDone(id) {
  const map = readDone();
  map[id] = Date.now();
  fs.mkdirSync(HOOKED_DIR, { recursive: true });
  fs.writeFileSync(DONE_FILE, JSON.stringify(map, null, 2) + '\n');
}

// Existing tags ranked by usage, so the model reuses the user's words instead of inventing synonyms.
function vocabulary(tagMap) {
  const count = new Map();
  for (const list of Object.values(tagMap)) for (const t of list) if (!NOT_VOCABULARY.has(t)) count.set(t, (count.get(t) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([t]) => t);
}

const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');

function buildPrompt(s, vocab) {
  return `You tag coding-assistant sessions for a dashboard. Reply with JSON only: {"tags": ["..."]}.
Rules:
- 1 to ${MAX_SUGGESTED} tags, lowercase, kebab-case, at most 24 characters each.
- Describe the kind of work (bug, feature, refactor, docs, review, infra, debug...) and the main topic.
- Strongly prefer reusing an existing tag over creating a synonym.
- Never use the project or repository name as a tag.
Existing tags: ${vocab.length ? vocab.join(', ') : '(none yet)'}

Session:
- project: ${s.projectName || ''}
- git branch: ${s.gitBranch || ''}
- title: ${clip(s.title, 200)}
- first prompt: ${clip(s.firstPrompt, 1500)}
- latest prompt: ${clip(s.lastPrompt, 500)}
- latest reply: ${clip(s.lastReply, 500)}`;
}

function parseSuggestion(stdout) {
  const obj = modelJson(stdout);
  const raw = obj && Array.isArray(obj.tags) ? obj.tags : [];
  const out = raw
    .filter((t) => typeof t === 'string')
    .map((t) => t.trim().replace(/^#+/, '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 24))
    .filter((t) => t && !NOT_VOCABULARY.has(t));
  return [...new Set(out)].slice(0, MAX_SUGGESTED);
}

// The call must leave no trace: no transcript (it would show up as a session), no hooks (it would
// show up in events.jsonl), no tools, and a neutral cwd so no project CLAUDE.md gets loaded.
async function suggestTags(s, tagMap = readTags()) {
  const args = [
    '-p', buildPrompt(s, vocabulary(tagMap)),
    '--model', 'haiku', '--output-format', 'json',
    '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--disable-slash-commands',
    '--settings', JSON.stringify({ disableAllHooks: true }),
  ];
  const { ok, stdout, out } = await runClaude(args, os.tmpdir(), CALL_TIMEOUT_MS);
  const tags = parseSuggestion(stdout);
  if (!tags.length && !ok) throw new Error('claude -p failed: ' + out.slice(0, 300));
  return tags;
}

// Tags one session (merge, never remove) and marks it done. Returns the full tag map.
async function autoTagSession(id) {
  const s = scanSessions().find((x) => x.id === id);
  if (!s) throw new Error('session not found');
  markDone(id); // claimed before the call: a second hooked process or a failure must not retry in a loop
  const suggested = await suggestTags(s);
  const current = readTags()[id] || [];
  const merged = [...new Set([...current, ...suggested])];
  return merged.length === current.length ? readTags() : setTags(id, merged);
}

const isOwnRun = (s) => typeof s.firstPrompt === 'string' && s.firstPrompt.startsWith(DIGEST_PROMPT_PREFIX);

async function autoTagTick() {
  const h = handle();
  if (h.running) return;
  h.running = true;
  try {
    const done = readDone();
    const since = Date.now() - MAX_AGE_MS;
    const todo = scanSessions().filter((s) => !done[s.id] && s.assistantTurns > 0 && !isOwnRun(s)
      && s.lastTs && Date.parse(s.lastTs) >= since);
    for (const s of todo) {
      try { await autoTagSession(s.id); } catch (e) { console.warn(`[hooked] auto-tags: ${s.id}: ${e.message || e}`); }
    }
  } finally {
    h.running = false;
  }
}

function handle() {
  if (!globalThis.__hookedAutoTags) globalThis.__hookedAutoTags = { timer: null, running: false };
  return globalThis.__hookedAutoTags;
}
function applyAutoTagSetting(settings) {
  const h = handle();
  if (settings && settings.autoTags) {
    if (h.timer) return;
    const run = () => { autoTagTick().catch((e) => console.warn('[hooked] auto-tags tick error:', e.message || e)); };
    run();
    h.timer = setInterval(run, TICK_INTERVAL);
    if (h.timer.unref) h.timer.unref();
  } else if (h.timer) {
    clearInterval(h.timer);
    h.timer = null;
  }
}

export { buildPrompt, parseSuggestion, vocabulary, autoTagSession, applyAutoTagSetting };
