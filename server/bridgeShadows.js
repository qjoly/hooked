/*
 * Claude Code transcripts written by pi-claude-bridge ("shadow" sessions).
 *
 * The bridge runs Claude Code as the MODEL of a pi session: every turn of a bridged pi session is a
 * turn of a Claude Code session the bridge resumes in ~/.claude/projects. The conversation belongs
 * to the pi session (hooked lists it on the pi side), so listing the shadow too would show every
 * bridged session twice, once of them as a Claude session nobody can drive.
 *
 * Two signals, either one is enough:
 *  - the bridge's state files, `<agentDir>/claude-bridge/sessions/s-*.json`, name the current
 *    shadow of each pi session (`ccSessionId`). The bridge mints a fresh transcript whenever pi's
 *    history diverges (a fork, a compaction, a branch) and the state then forgets the old one, so
 *    every id seen there is remembered in `bridge-shadows.json`;
 *  - the bridge starts Claude Code with no built-in tool, only pi's, served by its own MCP server
 *    `custom-tools`: a transcript whose tool calls are all `mcp__custom-tools__*` is a shadow even
 *    when no state file names it any more.
 *
 * Its hooks are dropped at the source instead (hook.cjs exits on PI_CODING_AGENT).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOKED_DIR, PI_AGENT_DIR } from './config.js';
import { readSettings } from './settings.js';

const BRIDGE_TOOL_PREFIX = 'mcp__custom-tools__';
const MEMORY_FILE = () => path.join(HOOKED_DIR, 'bridge-shadows.json');
const MEMORY_CAP = 5000;

const REG = globalThis[Symbol.for('hooked.bridgeShadows')] ||= {
  dirs: new Map(),   // state dir -> { mtimeMs, ids }
  memory: null,      // Set of every shadow id seen in a state file
};

// Every pi agent dir hooked knows of: the default one and each pi provider's `agentDir`.
function agentDirs() {
  const dirs = new Set([PI_AGENT_DIR]);
  let providers = {};
  try { providers = readSettings().providers || {}; } catch (_) {}
  for (const p of Object.values(providers)) {
    if (p && typeof p === 'object' && typeof p.agentDir === 'string' && p.agentDir) {
      dirs.add(p.agentDir.replace(/^~(?=\/|$)/, os.homedir()));
    }
  }
  return [...dirs];
}

// ccSessionId of every state file in one agent dir, re-read only when the directory changed (the
// bridge saves through a rename, which bumps the directory's mtime).
function idsIn(agentDir) {
  const dir = path.join(agentDir, 'claude-bridge', 'sessions');
  let st;
  try { st = fs.statSync(dir); } catch (_) { REG.dirs.delete(dir); return []; }
  const cached = REG.dirs.get(dir);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.ids;
  const ids = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) {}
  for (const f of names) {
    if (!/^s-[0-9a-f]+\.json$/.test(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j && typeof j.ccSessionId === 'string' && j.ccSessionId) ids.push(j.ccSessionId);
    } catch (_) { /* being written, or not the bridge's: skipped */ }
  }
  REG.dirs.set(dir, { mtimeMs: st.mtimeMs, ids });
  return ids;
}

function memory() {
  if (REG.memory) return REG.memory;
  let list = [];
  try { list = JSON.parse(fs.readFileSync(MEMORY_FILE(), 'utf8')).ids || []; } catch (_) {}
  REG.memory = new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
  return REG.memory;
}

function remember(ids) {
  const mem = memory();
  let added = false;
  for (const id of ids) if (!mem.has(id)) { mem.add(id); added = true; }
  if (!added) return;
  const list = [...mem].slice(-MEMORY_CAP);
  REG.memory = new Set(list);
  try {
    fs.mkdirSync(HOOKED_DIR, { recursive: true });
    const tmp = MEMORY_FILE() + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ids: list }));
    fs.renameSync(tmp, MEMORY_FILE());
  } catch (_) { /* best effort: the in-memory set still filters this run */ }
}

// Ids of every shadow session the bridge's state files name, now or before.
function bridgeShadowIds(dirs = agentDirs()) {
  const now = [];
  for (const d of dirs) now.push(...idsIn(d));
  remember(now);
  return memory();
}

// A transcript whose every tool call went to the bridge's MCP server. A session with no tool call
// yet is not decided here (the state file covers it).
function usesOnlyBridgeTools(tools) {
  const names = Object.keys(tools || {});
  return names.length > 0 && names.every((n) => n.startsWith(BRIDGE_TOOL_PREFIX));
}

function isBridgeShadow(s, ids) {
  return !!s && ((ids && ids.has(s.id)) || usesOnlyBridgeTools(s.tools));
}

// `list` without the shadows.
function withoutBridgeShadows(list, dirs) {
  const ids = bridgeShadowIds(dirs);
  return list.filter((s) => !isBridgeShadow(s, ids));
}

export { bridgeShadowIds, isBridgeShadow, usesOnlyBridgeTools, withoutBridgeShadows, BRIDGE_TOOL_PREFIX };
