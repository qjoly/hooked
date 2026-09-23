/*
 * Per-session Deck metadata persisted server-side (session-meta.json in HOOKED_DIR), shared
 * across browsers — the data model behind the redesign's decision queue (PR #74). Previously
 * this state lived per-browser in localStorage ('hooked.ui'.archived + 'hooked.snooze').
 * Shape: { [sessionId]: { archived?: true, snoozeUntil?: epochMs, groupOf?: id, groupAt?: epochMs,
 * groupName?: string } }. The server always re-normalizes: expired snoozes are pruned, empty
 * entries dropped — the file only keeps meaningful facts, and this layer is the source of truth.
 *
 * Session groups: every session belongs to exactly one group. A lone session is an IMPLICIT
 * one-member group (nothing stored). A group is identified by its MOTHER session: each child
 * carries `groupOf: <motherId>` (+ `groupAt`, its join time, which orders the children), and the
 * mother may carry a custom `groupName`. One level only — `groupOf` always points at a session
 * that is not itself a child (chains are flattened on read, cycles dropped).
 */
import fs from 'node:fs';
import path from 'node:path';
import { HOOKED_DIR } from './config.js';

const SESSION_META_FILE = path.join(HOOKED_DIR, 'session-meta.json');
// A snooze can't be pushed further than this (anti-abuse bound on client payloads).
const MAX_SNOOZE_MS = 30 * 24 * 3600_000; // 30 days
const MAX_GROUP_NAME = 120;

// Normalizes one session's metadata. Returns null when nothing meaningful remains
// (not archived, snooze absent/expired) so the entry gets dropped from the file.
function cleanEntry(raw, now) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  if (o.archived === true) out.archived = true;
  const until = Number(o.snoozeUntil);
  if (Number.isFinite(until) && until > now) out.snoozeUntil = Math.min(until, now + MAX_SNOOZE_MS);
  if (typeof o.groupOf === 'string' && o.groupOf) {
    out.groupOf = o.groupOf;
    const at = Number(o.groupAt);
    out.groupAt = Number.isFinite(at) ? at : 0;
  }
  if (typeof o.groupName === 'string' && o.groupName.trim()) out.groupName = o.groupName.trim().slice(0, MAX_GROUP_NAME);
  return Object.keys(out).length ? out : null;
}

// Follows `groupOf` up to the mother. Returns null on a cycle.
function rootOf(map, id) {
  const seen = new Set();
  let cur = id;
  while (map[cur] && map[cur].groupOf) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    cur = map[cur].groupOf;
  }
  return cur;
}

// Flattens chains (a child of a child joins the top mother) and drops self-links / cycles.
function flattenGroups(map) {
  const roots = {};
  for (const id of Object.keys(map)) if (map[id].groupOf) roots[id] = rootOf(map, id);
  for (const [id, root] of Object.entries(roots)) {
    const e = map[id];
    if (!root || root === id) { delete e.groupOf; delete e.groupAt; }
    else e.groupOf = root;
    if (!Object.keys(e).length) delete map[id];
  }
  return map;
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
  return flattenGroups(out);
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

// ─── Session groups ───────────────────────────────────────────────────────────────────────────
// Each operation reads the map, rewrites the affected entries and persists the whole (sanitized)
// map, which it returns — same contract as setSessionMeta.

const entryOf = (map, id) => (map[id] = map[id] || {});
const childrenOf = (map, motherId) => Object.keys(map)
  .filter((k) => map[k].groupOf === motherId)
  .sort((a, b) => (map[a].groupAt || 0) - (map[b].groupAt || 0));
const checkId = (id) => { if (typeof id !== 'string' || !id) throw new Error('invalid session id'); };

// Mother of `id`'s group (`id` itself for a mother or a lone session).
function groupMotherOf(id, map = readSessionMeta()) {
  return rootOf(map, id) || id;
}

// Puts `id` in the group of `targetId` (whose mother stays the mother). When `id` is itself a
// mother, its whole group follows: dragging a group onto another merges them.
function joinGroup(id, targetId) {
  checkId(id); checkId(targetId);
  const map = readSessionMeta();
  const mother = rootOf(map, targetId) || targetId;
  const self = rootOf(map, id) || id;
  if (self === mother && (id === mother || map[id]?.groupOf === mother)) return map;
  const moving = [id, ...(self === id ? childrenOf(map, id) : [])];
  const now = Date.now();
  moving.forEach((m, i) => {
    const e = entryOf(map, m);
    e.groupOf = mother;
    e.groupAt = now + i;
    delete e.groupName;
  });
  return writeSessionMeta(map);
}

// Takes `id` out of its group (it becomes a lone session). When `id` is the mother, the oldest
// child is promoted and inherits the group name.
function leaveGroup(id) {
  checkId(id);
  const map = readSessionMeta();
  const e = map[id];
  if (e && e.groupOf) {
    delete e.groupOf; delete e.groupAt;
    return writeSessionMeta(map);
  }
  const kids = childrenOf(map, id);
  if (!kids.length) return map;
  const [heir, ...rest] = kids;
  const h = entryOf(map, heir);
  delete h.groupOf; delete h.groupAt;
  if (e && e.groupName) { h.groupName = e.groupName; delete e.groupName; }
  for (const k of rest) map[k].groupOf = heir;
  return writeSessionMeta(map);
}

// Makes `id` the mother of its group; the former mother becomes the first child.
function setGroupMother(id) {
  checkId(id);
  const map = readSessionMeta();
  const old = map[id] && map[id].groupOf;
  if (!old) return map;
  const kids = childrenOf(map, old);
  const first = Math.min(...kids.map((k) => map[k].groupAt || 0));
  const e = map[id];
  delete e.groupOf; delete e.groupAt;
  const o = entryOf(map, old);
  if (o.groupName) { e.groupName = o.groupName; delete o.groupName; }
  o.groupOf = id;
  o.groupAt = first - 1;
  for (const k of kids) if (k !== id) map[k].groupOf = id;
  return writeSessionMeta(map);
}

// Renames `id`'s group (stored on its mother); an empty name restores the default.
function renameGroup(id, name) {
  checkId(id);
  const map = readSessionMeta();
  const mother = rootOf(map, id) || id;
  const e = entryOf(map, mother);
  if (typeof name === 'string' && name.trim()) e.groupName = name;
  else delete e.groupName;
  return writeSessionMeta(map);
}

export {
  SESSION_META_FILE, readSessionMeta, writeSessionMeta, setSessionMeta,
  groupMotherOf, joinGroup, leaveGroup, setGroupMother, renameGroup,
};
