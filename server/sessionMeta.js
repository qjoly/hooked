/*
 * Per-session Deck metadata persisted server-side (session-meta.json in HOOKED_DIR), shared
 * across browsers — the data model behind the redesign's decision queue (PR #74). Previously
 * this state lived per-browser in localStorage ('hooked.ui'.archived + 'hooked.snooze').
 * Shape: { [sessionId]: { archived?: true, snoozeUntil?: epochMs } }. The server always
 * re-normalizes: expired snoozes are pruned, empty entries dropped — the file only keeps
 * meaningful facts, and this layer is the source of truth.
 */
import fs from 'node:fs';
import path from 'node:path';
import { HOOKED_DIR } from './config.js';

const SESSION_META_FILE = path.join(HOOKED_DIR, 'session-meta.json');
// A snooze can't be pushed further than this (anti-abuse bound on client payloads).
const MAX_SNOOZE_MS = 30 * 24 * 3600_000; // 30 days

// Normalizes one session's metadata. Returns null when nothing meaningful remains
// (not archived, snooze absent/expired) so the entry gets dropped from the file.
function cleanEntry(raw, now) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  if (o.archived === true) out.archived = true;
  const until = Number(o.snoozeUntil);
  if (Number.isFinite(until) && until > now) out.snoozeUntil = Math.min(until, now + MAX_SNOOZE_MS);
  return Object.keys(out).length ? out : null;
}

// Brings an arbitrary map (file or client payload) back to a safe, minimal
// { [sessionId]: { archived?, snoozeUntil? } } — expired/empty entries removed.
function sanitize(raw, now = Date.now()) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [id, entry] of Object.entries(o)) {
    if (typeof id !== 'string' || !id) continue;
    const clean = cleanEntry(entry, now);
    if (clean) out[id] = clean;
  }
  return out;
}

// Reads the full map (empty when the file is absent/unreadable). No cache: the file is
// small and rarely read (page load + occasional edits), same trade-off as tags.json.
function readSessionMeta() {
  try {
    return sanitize(JSON.parse(fs.readFileSync(SESSION_META_FILE, 'utf8')));
  } catch (_) {
    return {};
  }
}

// Writes the full map (validated), returns what was persisted.
function writeSessionMeta(map) {
  const clean = sanitize(map);
  try {
    fs.mkdirSync(HOOKED_DIR, { recursive: true });
    fs.writeFileSync(SESSION_META_FILE, JSON.stringify(clean, null, 2) + '\n');
  } catch (e) {
    throw new Error('session-meta.json write failed: ' + (e.message || e));
  }
  return clean;
}

// Merges a patch ({ archived?, snoozeUntil? }) into one session's entry; returns the full
// updated map. `archived: false`/`snoozeUntil: null` clear the corresponding fact; an entry
// with nothing left is removed.
function setSessionMeta(id, patch) {
  if (typeof id !== 'string' || !id) throw new Error('invalid session id');
  const p = patch && typeof patch === 'object' ? patch : {};
  const map = readSessionMeta();
  const merged = { ...map[id] };
  if ('archived' in p) {
    if (p.archived === true) merged.archived = true;
    else delete merged.archived;
  }
  if ('snoozeUntil' in p) {
    if (p.snoozeUntil == null) delete merged.snoozeUntil;
    else merged.snoozeUntil = p.snoozeUntil;
  }
  const clean = cleanEntry(merged, Date.now());
  if (clean) map[id] = clean;
  else delete map[id];
  return writeSessionMeta(map);
}

export { SESSION_META_FILE, readSessionMeta, writeSessionMeta, setSessionMeta };
