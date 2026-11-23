#!/usr/bin/env node
/*
 * Brings Claude Code's user-level instructions, skills and MCP servers to pi (`mise run pi-migrate`).
 *
 * Claude through pi-claude-bridge runs Claude Code with its own context files excluded: pi owns the
 * context, so ~/.claude/CLAUDE.md and ~/.claude/skills do not reach the model unless pi has them.
 * The same goes for every other model pi runs.
 *
 *  - CLAUDE.md is copied into <agentDir>/AGENTS.md between two markers. The text outside the
 *    markers is pi-only content and stays as it is. Run the task again after an edit of CLAUDE.md:
 *    it replaces the block.
 *  - The skills folder is added to the `skills` list of <agentDir>/settings.json. pi reads the
 *    folder itself, so a new or changed skill needs no new run. So are the skills of the enabled
 *    plugins (installed_plugins.json + enabledPlugins): their folder carries the plugin version, so
 *    a run after a plugin update swaps the old folder for the new one. Plugins synced by an
 *    organization are left out: their skills rely on claude.ai connectors pi does not have.
 *  - The user-scope MCP servers of Claude Code (`mcpServers` in ~/.claude.json) are copied into
 *    <agentDir>/mcp.json: the entry format is the same. A server pi already defines is kept. Each
 *    copy is recorded in <agentDir>/pi-migrate.json, so a later run follows Claude's changes
 *    (update, removal) while a copy edited in pi is left alone. Not copied: `hooked` (hooked's pi
 *    package serves its tools), SSE servers (pi does not support SSE). OAuth sign-ins do not carry
 *    over: an HTTP server without an Authorization header needs `pi mcp login <name>` once.
 *
 * The first change to each file keeps a copy of it (`<file>.pre-pi-migrate.bak`).
 *
 * Paths: CLAUDE_CONFIG_DIR (default ~/.claude), PI_CODING_AGENT_DIR (default ~/.pi/agent).
 * Flags: --dry-run (show the changes, write nothing), --no-instructions, --no-skills, --no-mcp.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BEGIN = '<!-- BEGIN pi-migrate: ~/.claude/CLAUDE.md (mise run pi-migrate replaces this block) -->';
const END = '<!-- END pi-migrate -->';
const BACKUP_SUFFIX = '.pre-pi-migrate.bak';

const expandHome = (p) => String(p || '').replace(/^~(?=\/|$)/, os.homedir());
const tildify = (p) => (p === os.homedir() || p.startsWith(os.homedir() + path.sep) ? '~' + p.slice(os.homedir().length) : p);

// AGENTS.md text with `source` in the managed block: replaced in place when the markers exist,
// else put first, before the pi-only content.
function upsertBlock(target, source) {
  const block = `${BEGIN}\n${String(source).trim()}\n${END}`;
  const text = String(target || '');
  const b = text.indexOf(BEGIN);
  const e = b >= 0 ? text.indexOf(END, b) : -1;
  if (b >= 0 && e >= 0) return text.slice(0, b) + block + text.slice(e + END.length);
  const rest = text.trim();
  return rest ? `${block}\n\n${rest}\n` : `${block}\n`;
}

// The text outside the managed block.
function outsideBlock(text) {
  const t = String(text || '');
  const b = t.indexOf(BEGIN);
  const e = b >= 0 ? t.indexOf(END, b) : -1;
  return b >= 0 && e >= 0 ? t.slice(0, b) + t.slice(e + END.length) : t;
}

const headings = (text) => String(text || '').split('\n')
  .map((l) => /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(l))
  .filter(Boolean)
  .map((m) => m[1].replace(/\s+/g, ' ').trim().toLowerCase()); // \s covers no-break spaces too

// Headings of the pi-only content that CLAUDE.md also has: most likely a copy made by hand before
// this task existed, now loaded twice.
function duplicateHeadings(target, source) {
  const fromSource = new Set(headings(source));
  return [...new Set(headings(outsideBlock(target)).filter((h) => fromSource.has(h)))];
}

// Skills folders of the enabled user-scope plugins, and the plugins left out (with why).
function pluginSkillDirs(claudeDir) {
  const dirs = [];
  const skipped = [];
  let installed = {};
  let enabled = {};
  try { installed = JSON.parse(readOr(path.join(claudeDir, 'plugins', 'installed_plugins.json'), '{}')).plugins || {}; } catch (_) {}
  try { enabled = JSON.parse(readOr(path.join(claudeDir, 'settings.json'), '{}')).enabledPlugins || {}; } catch (_) {}
  for (const [name, entries] of Object.entries(installed)) {
    const list = Array.isArray(entries) ? entries : [entries];
    const e = list.find((x) => x && (x.scope === 'user' || !x.scope));
    const dir = e && e.installPath ? path.join(e.installPath, 'skills') : null;
    if (!dir || !fs.existsSync(dir)) continue;
    if (enabled[name] !== true) { skipped.push({ name, why: 'not enabled' }); continue; }
    dirs.push({ name, dir });
  }
  const synced = path.join(claudeDir, 'plugins', 'synced');
  for (const bucket of fs.existsSync(synced) ? fs.readdirSync(synced) : []) {
    let names = [];
    try { names = fs.readdirSync(path.join(synced, bucket)); } catch (_) {}
    for (const name of names) {
      if (fs.existsSync(path.join(synced, bucket, name, 'skills'))) skipped.push({ name, why: "synced by the organization, relies on claude.ai connectors" });
    }
  }
  return { dirs, skipped };
}

const sameDir = (a, b) => path.resolve(expandHome(String(a).replace(/^\+/, ''))) === path.resolve(expandHome(b));

// pi's `skills` list with every wanted folder, without the folders a previous run added for a
// plugin and that are no longer wanted (an older plugin version).
//   list: pi's current list; wanted: folders to have; managedBefore: plugin folders added before
// → { list, added, removed }
function syncSkills(list, wanted, managedBefore) {
  const cur = Array.isArray(list) ? list : [];
  const removed = (managedBefore || []).filter((old) => !wanted.some((w) => sameDir(old, w)) && cur.some((x) => typeof x === 'string' && sameDir(x, old)));
  const kept = cur.filter((x) => !(typeof x === 'string' && removed.some((r) => sameDir(x, r))));
  const added = wanted.filter((w) => !kept.some((x) => typeof x === 'string' && sameDir(x, w)));
  return { list: [...kept, ...added.map((w) => tildify(path.resolve(expandHome(w))))], added, removed };
}

function writeAtomic(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

const SKIP_MCP = new Set(['hooked']);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Claude Code's user-scope MCP servers: ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json.
function claudeJsonPath(claudeDir) {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.join(claudeDir, '.claude.json')
    : path.join(path.dirname(claudeDir), '.claude.json');
}

// pi's mcp.json servers after the copy of Claude's ones.
//   claude:   Claude's `mcpServers`
//   pi:       pi's `mcpServers`
//   recorded: the copies of the previous run ({ name: entry })
// → { servers, recorded, changes: [{ name, action, why? }] }
function mergeMcp(claude, pi, recorded) {
  const servers = { ...(pi || {}) };
  const rec = {};
  const changes = [];
  const prev = recorded || {};
  for (const [name, entry] of Object.entries(claude || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (SKIP_MCP.has(name)) { changes.push({ name, action: 'skipped', why: "served by hooked's pi package" }); continue; }
    if (entry.type === 'sse') { changes.push({ name, action: 'skipped', why: 'SSE transport, not supported by pi' }); continue; }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) { changes.push({ name, action: 'skipped', why: 'name pi does not accept' }); continue; }
    const copy = JSON.parse(JSON.stringify(entry));
    if (!(name in servers)) {
      servers[name] = copy; rec[name] = copy;
      changes.push({ name, action: 'added', login: needsLogin(copy) });
    } else if (prev[name] && sameJson(servers[name], prev[name])) {
      // our own copy, untouched in pi: follow Claude
      servers[name] = copy; rec[name] = copy;
      changes.push({ name, action: sameJson(copy, prev[name]) ? 'unchanged' : 'updated' });
    } else {
      changes.push({ name, action: 'kept', why: prev[name] ? 'edited in pi' : 'pi already has a server of that name' });
    }
  }
  // copies of servers Claude no longer has: removed, unless edited in pi
  for (const [name, entry] of Object.entries(prev)) {
    if (name in (claude || {})) continue;
    if (name in servers && sameJson(servers[name], entry)) { delete servers[name]; changes.push({ name, action: 'removed' }); }
  }
  return { servers, recorded: rec, changes };
}

// An HTTP server with no Authorization header signs in through OAuth, per client.
function needsLogin(entry) {
  const http = entry.url || entry.type === 'http' || entry.type === 'streamable-http';
  const h = entry.headers || {};
  return !!http && !Object.keys(h).some((k) => k.toLowerCase() === 'authorization');
}

function backupOnce(file) {
  const bak = file + BACKUP_SUFFIX;
  if (fs.existsSync(file) && !fs.existsSync(bak)) { fs.copyFileSync(file, bak); return bak; }
  return null;
}

function readOr(file, fallback) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return fallback; }
}

function migrate({
  claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'),
  dryRun = false,
  instructions = true,
  skills = true,
  mcp = true,
  claudeJson = null,
} = {}) {
  claudeDir = expandHome(claudeDir);
  agentDir = expandHome(agentDir);
  const report = { claudeDir, agentDir, dryRun };
  // What earlier runs added (MCP copies, plugin skill folders), so a run can follow Claude's
  // changes without touching what was edited in pi.
  const stateFile = path.join(agentDir, 'pi-migrate.json');
  let state = {};
  try { state = JSON.parse(readOr(stateFile, '{}')) || {}; } catch (_) { state = {}; }
  const stateBefore = JSON.stringify(state);

  if (instructions) {
    const src = path.join(claudeDir, 'CLAUDE.md');
    const dst = path.join(agentDir, 'AGENTS.md');
    const source = readOr(src, null);
    if (source == null || !source.trim()) {
      report.instructions = { status: 'no-source', src };
    } else {
      const before = readOr(dst, '');
      const after = upsertBlock(before, source);
      const status = after === before ? 'unchanged' : (before.includes(BEGIN) ? 'updated' : 'added');
      let backup = null;
      if (status !== 'unchanged' && !dryRun) { backup = backupOnce(dst); writeAtomic(dst, after); }
      report.instructions = { status, src, dst, backup, duplicates: duplicateHeadings(after, source) };
    }
  }

  if (skills) {
    const dir = path.join(claudeDir, 'skills');
    const file = path.join(agentDir, 'settings.json');
    const plugins = pluginSkillDirs(claudeDir);
    const hasDir = fs.existsSync(dir);
    if (!hasDir && !plugins.dirs.length) {
      report.skills = { status: 'no-source', dir, plugins: [], skipped: plugins.skipped };
    } else {
      let settings = {};
      const raw = readOr(file, null);
      if (raw != null) {
        try { settings = JSON.parse(raw); } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
      }
      const wanted = [...(hasDir ? [dir] : []), ...plugins.dirs.map((p) => p.dir)];
      const { list, added, removed } = syncSkills(settings.skills, wanted, state.pluginSkills);
      const changed = added.length > 0 || removed.length > 0;
      let backup = null;
      if (changed && !dryRun) { backup = backupOnce(file); writeAtomic(file, JSON.stringify({ ...settings, skills: list }, null, 2) + '\n'); }
      state.pluginSkills = plugins.dirs.map((p) => tildify(p.dir));
      report.skills = {
        status: hasDir ? (added.some((a) => sameDir(a, dir)) ? 'added' : 'present') : 'no-source',
        dir, file, backup,
        entries: hasDir ? fs.readdirSync(dir).filter((n) => !n.startsWith('.')).length : 0,
        plugins: plugins.dirs.map((p) => ({ name: p.name, dir: p.dir, action: added.some((a) => sameDir(a, p.dir)) ? 'added' : 'present' })),
        removed,
        skipped: plugins.skipped,
      };
    }
  }

  if (mcp) {
    const src = claudeJson ? expandHome(claudeJson) : claudeJsonPath(claudeDir);
    const file = path.join(agentDir, 'mcp.json');
    const raw = readOr(src, null);
    if (raw == null) {
      report.mcp = { status: 'no-source', src };
    } else {
      let claude;
      try { claude = JSON.parse(raw).mcpServers || {}; } catch (e) { throw new Error(`${src} is not valid JSON: ${e.message}`); }
      let piCfg = {};
      const piRaw = readOr(file, null);
      if (piRaw != null) {
        try { piCfg = JSON.parse(piRaw); } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
      }
      const { servers, recorded, changes } = mergeMcp(claude, piCfg.mcpServers, state.mcpServers);
      const changed = !sameJson(servers, piCfg.mcpServers || {});
      let backup = null;
      if (changed && !dryRun) { backup = backupOnce(file); writeAtomic(file, JSON.stringify({ ...piCfg, mcpServers: servers }, null, 2) + '\n', 0o600); }
      state.mcpServers = recorded;
      report.mcp = { status: changed ? 'changed' : 'unchanged', src, file, backup, changes };
    }
  }
  if (!dryRun && JSON.stringify(state) !== stateBefore) writeAtomic(stateFile, JSON.stringify(state, null, 2) + '\n', 0o600);
  return report;
}

function print(r) {
  const tag = r.dryRun ? ' (dry run, nothing written)' : '';
  console.log(`Claude: ${tildify(r.claudeDir)}  ->  pi: ${tildify(r.agentDir)}${tag}`);
  const i = r.instructions;
  if (i) {
    if (i.status === 'no-source') console.log(`- Instructions: ${tildify(i.src)} not found, skipped.`);
    else {
      const what = { added: 'added to', updated: 'updated in', unchanged: 'already up to date in' }[i.status];
      console.log(`- Instructions: CLAUDE.md ${what} ${tildify(i.dst)}.`);
      if (i.backup) console.log(`  Copy of the previous file: ${tildify(i.backup)}`);
      if (i.duplicates.length) {
        console.log(`  Warning: the pi-only part of AGENTS.md repeats these CLAUDE.md sections: ${i.duplicates.join(', ')}.`);
        console.log('  If they are old copies, remove them from AGENTS.md (outside the pi-migrate block).');
      }
    }
  }
  const s = r.skills;
  if (s) {
    if (s.status === 'no-source') console.log(`- Skills: ${tildify(s.dir)} not found, skipped.`);
    else console.log(`- Skills: ${tildify(s.dir)} (${s.entries} entries) ${s.status === 'added' ? 'added to' : 'already in'} the skills list of ${tildify(s.file)}.`);
    for (const p of s.plugins || []) console.log(`  plugin ${p.name}: ${p.action === 'added' ? 'skills added' : 'skills already listed'} (${tildify(p.dir)})`);
    for (const d of s.removed || []) console.log(`  removed an older plugin folder: ${tildify(path.resolve(expandHome(d)))}`);
    for (const k of s.skipped || []) console.log(`  plugin ${k.name}: left out (${k.why})`);
    if (s.backup) console.log(`  Copy of the previous file: ${tildify(s.backup)}`);
  }
  const m = r.mcp;
  if (m) {
    if (m.status === 'no-source') console.log(`- MCP servers: ${tildify(m.src)} not found, skipped.`);
    else if (!m.changes.length) console.log(`- MCP servers: Claude Code has no user-scope server in ${tildify(m.src)}.`);
    else {
      console.log(`- MCP servers (${tildify(m.src)} -> ${tildify(m.file)}):`);
      for (const c of m.changes) console.log(`  ${c.name}: ${c.action}${c.why ? ` (${c.why})` : ''}`);
      if (m.backup) console.log(`  Copy of the previous file: ${tildify(m.backup)}`);
      const login = m.changes.filter((c) => c.login).map((c) => c.name);
      if (login.length) console.log(`  Sign in once (OAuth does not carry over from Claude Code): ${login.map((n) => `pi mcp login ${n}`).join(', ')}`);
    }
  }
  if (!r.dryRun) console.log('Running pi sessions load the change on their next start (or /reload).');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter((a) => !['--dry-run', '--no-instructions', '--no-skills', '--no-mcp'].includes(a));
  if (unknown.length) {
    console.error(`Unknown option: ${unknown.join(' ')}\nUsage: mise run pi-migrate [-- --dry-run] [--no-instructions] [--no-skills] [--no-mcp]`);
    process.exit(2);
  }
  try {
    print(migrate({ dryRun: args.has('--dry-run'), instructions: !args.has('--no-instructions'), skills: !args.has('--no-skills'), mcp: !args.has('--no-mcp') }));
  } catch (e) {
    console.error(`pi-migrate: ${e.message}`);
    process.exit(1);
  }
}

export { migrate, upsertBlock, outsideBlock, duplicateHeadings, syncSkills, pluginSkillDirs, mergeMcp, needsLogin, BEGIN, END };
