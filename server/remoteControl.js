/*
 * Remote-control daemons. hooked can keep a persistent `claude remote-control` server (the
 * subcommand, NOT the `--remote-control` flag) alive per configured project. Server mode accepts
 * multiple concurrent sessions in the directory → the project shows up as a launchable ENVIRONMENT
 * in the Claude app (claude.ai/code / mobile), not just a single continue-only session. Each daemon
 * runs in a DETACHED tmux session (same mechanism as launchSession) named `hooked-rc-<...>`, so it
 * survives a hooked restart, is inspectable via tmux, and self-heals: the shell wrapper relaunches
 * `claude` if it exits (auth expiry, disconnect…).
 *
 * The project list lives in settings.json (`remoteControlProjects`). We reconcile the running tmux
 * sessions to that list on boot (prod, src/hooks.server.js) and on every settings write
 * (applyRemoteControlSetting, mirrored on applyGitSyncSetting): create daemons for newly-added
 * projects, kill daemons for removed ones. There is no periodic poll — the shell wrapper covers
 * crash recovery; boot reconcile covers a machine reboot.
 *
 * These daemon sessions are hidden from the dashboard (they are infrastructure, not sessions you
 * drive from hooked): buildSessions filters out any session whose tmux name has the RC prefix, and
 * records its claude session id here (rc-sessions.json) so it stays hidden after the pane dies.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { HOOKED_DIR } from './config.js';

const RC_PREFIX = 'hooked-rc-';
// Persistent set of claude session ids observed running inside an RC tmux session → keeps them
// hidden from the sidebar even after the daemon's pane dies (the transcript lingers on disk).
const RC_SESSIONS_FILE = path.join(HOOKED_DIR, 'rc-sessions.json');

const isRcTmuxName = (name) => typeof name === 'string' && name.startsWith(RC_PREFIX);

// Short, stable discriminator from the absolute path → two projects with the same basename don't
// collide (neither in the tmux name nor in the app-visible remote-control name).
function projectHash(cwd) {
  return crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 8);
}

// Sanitized basename, safe to interpolate into the shell command below (charset restricted).
function projectBase(cwd) {
  return path.basename(cwd).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 24) || 'project';
}

// Deterministic tmux session name for a project's daemon.
function rcTmuxName(cwd) {
  return `${RC_PREFIX}${projectBase(cwd)}-${projectHash(cwd)}`;
}

// Name shown in the Claude app for this remote-control session (readable + unique).
function rcAppName(cwd) {
  return `${projectBase(cwd)}_${projectHash(cwd)}`;
}

function statSafe(p) {
  try { return fs.statSync(p); } catch (_) { return null; }
}

// Configured projects that still point at a real directory, mapped to their names. A path that no
// longer exists is skipped (logged once) rather than spawning a daemon that would instantly die.
function desiredProjects(settings) {
  const list = Array.isArray(settings?.remoteControlProjects) ? settings.remoteControlProjects : [];
  const out = [];
  for (const cwd of list) {
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) continue;
    const st = statSafe(cwd);
    if (!st || !st.isDirectory()) {
      console.log(`[hooked] remote-control: skipping missing project ${cwd}`);
      continue;
    }
    out.push({ cwd, tmux: rcTmuxName(cwd), app: rcAppName(cwd) });
  }
  return out;
}

// Names of the currently-running RC tmux sessions (prefix-filtered).
function listRcSessions(cb) {
  execFile('tmux', ['list-sessions', '-F', '#{session_name}'], { timeout: 2000 }, (err, out) => {
    // No server / no sessions → tmux exits non-zero; treat as "none running", not a hard error.
    const names = (err ? '' : out).split('\n').map((s) => s.trim()).filter(isRcTmuxName);
    cb(new Set(names));
  });
}

// Launch one daemon in a detached tmux session. Same login-interactive-shell rationale as
// launchSession (a systemd/launchd hooked starts with a minimal PATH and wouldn't find `claude`).
// The `while true` wrapper relaunches claude if it exits, so the tmux session is a real supervisor;
// killing the tmux session (on removal) tears the loop down with it.
function spawnDaemon({ cwd, tmux, app }, cb = () => {}) {
  const shell = process.env.SHELL || '/bin/zsh';
  const inner = `while true; do claude remote-control --name ${app}; sleep 5; done`;
  const shellCmd = `${shell} -l -i -c '${inner}'`;
  const cols = parseInt(process.env.HOOKED_TMUX_COLS || '', 10) || 120;
  const rows = parseInt(process.env.HOOKED_TMUX_ROWS || '', 10) || 64;
  execFile('tmux', ['new-session', '-d', '-x', String(cols), '-y', String(rows), '-s', tmux, '-c', cwd, shellCmd], (e) => {
    if (e) console.log(`[hooked] remote-control: failed to start daemon for ${cwd}: ${e.message || e}`);
    else console.log(`[hooked] remote-control: started daemon for ${cwd} (${tmux})`);
    cb(e || null);
  });
}

function killDaemon(tmux, cb = () => {}) {
  execFile('tmux', ['kill-session', '-t', tmux], (e) => {
    if (!e) console.log(`[hooked] remote-control: stopped daemon ${tmux}`);
    cb(e || null);
  });
}

// Reconcile the running RC tmux sessions to the configured project list: start what's missing, kill
// what's no longer wanted. Idempotent and best-effort (each spawn/kill is independent).
function reconcileRemoteControl(settings, cb = () => {}) {
  const desired = desiredProjects(settings);
  const wanted = new Set(desired.map((d) => d.tmux));
  listRcSessions((running) => {
    const toKill = [...running].filter((n) => !wanted.has(n));
    const toStart = desired.filter((d) => !running.has(d.tmux));
    let pending = toKill.length + toStart.length;
    if (!pending) return cb(null, { started: 0, stopped: 0 });
    const done = () => { if (--pending === 0) cb(null, { started: toStart.length, stopped: toKill.length }); };
    for (const n of toKill) killDaemon(n, done);
    for (const d of toStart) spawnDaemon(d, done);
  });
}

// Idempotent settings hook (called from the /api/settings endpoint on GET+POST, mirroring
// applyGitSyncSetting): reconcile daemons to the freshly-read/written settings.
function applyRemoteControlSetting(settings) {
  reconcileRemoteControl(settings);
}

// Boot entry point (prod only, src/hooks.server.js): reconcile once against the persisted settings.
function startRemoteControl(settings) {
  const STARTED = Symbol.for('hooked.remoteControl.started');
  if (globalThis[STARTED]) return; // idempotent across HMR / repeated imports
  globalThis[STARTED] = true;
  reconcileRemoteControl(settings);
}

// Per-project daemon status for the settings UI: is the tmux session up?
function remoteControlStatus(settings, cb) {
  const desired = desiredProjects(settings);
  const configured = Array.isArray(settings?.remoteControlProjects) ? settings.remoteControlProjects : [];
  listRcSessions((running) => {
    cb(configured.map((cwd) => {
      const found = desired.find((d) => d.cwd === cwd);
      return {
        project: cwd,
        name: found ? found.app : null,
        exists: !!found,                              // false → path no longer a directory
        running: found ? running.has(found.tmux) : false,
      };
    }));
  });
}

// ── Hiding RC daemon sessions from the dashboard ─────────────────────────────────────────────────
function readRcSessionIds() {
  try { return new Set(JSON.parse(fs.readFileSync(RC_SESSIONS_FILE, 'utf8'))); }
  catch (_) { return new Set(); }
}

// Snapshot of hidden session ids for a single buildSessions pass (read once, not per session).
function rcSessionIdSet() {
  return readRcSessionIds();
}

// Record a claude session id as belonging to an RC daemon (idempotent persist) — so it stays hidden
// once its pane dies and the live tmux-name check can no longer classify it.
function markRcSession(id) {
  if (!id) return;
  const set = readRcSessionIds();
  if (set.has(id)) return;
  set.add(id);
  try {
    fs.mkdirSync(HOOKED_DIR, { recursive: true });
    fs.writeFileSync(RC_SESSIONS_FILE, JSON.stringify([...set]) + '\n');
  } catch (_) {}
}

export {
  RC_PREFIX,
  isRcTmuxName,
  rcTmuxName,
  rcAppName,
  reconcileRemoteControl,
  applyRemoteControlSetting,
  startRemoteControl,
  remoteControlStatus,
  rcSessionIdSet,
  markRcSession,
};
