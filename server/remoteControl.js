/*
 * Remote-control daemons. hooked can keep a persistent `claude remote-control` server (the
 * subcommand, NOT the `--remote-control` flag) alive per configured project. Server mode accepts
 * multiple concurrent sessions in the directory → the project shows up as a launchable ENVIRONMENT
 * in the Claude app (claude.ai/code / mobile), not just a single continue-only session.
 *
 * Each daemon runs as a DETACHED child process, supervised by a small `while true` shell wrapper so
 * it relaunches `claude` if it exits (auth expiry, disconnect…). Detached + `unref`ed means it
 * outlives the hooked process: a hooked restart does not tear the daemons down, and the PID file
 * (rc-daemons.json) lets the next boot recognize the ones already running instead of doubling them.
 *
 * Before the move off tmux these daemons lived in detached tmux sessions named `hooked-rc-<...>`,
 * which acted as both supervisor and registry. A plain detached process + PID file covers the same
 * two jobs without requiring tmux to be installed at all.
 *
 * The project list lives in settings.json (`remoteControlProjects`). We reconcile the running
 * daemons to that list on boot (prod, src/hooks.server.js) and on every settings write
 * (applyRemoteControlSetting, mirrored on applyGitSyncSetting): start daemons for newly-added
 * projects, kill daemons for removed ones. There is no periodic poll — the shell wrapper covers
 * crash recovery; boot reconcile covers a machine reboot.
 *
 * These daemon sessions are hidden from the dashboard (they are infrastructure, not sessions you
 * drive from hooked): the daemons run with HOOKED_RC=1 in their environment, hook.cjs copies that
 * onto every event it writes, and buildSessions filters out any session id carrying the flag.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { HOOKED_DIR } from './config.js';

// PID des démons en cours, indexés par clé de projet → { pid, cwd, app, startedAt }.
const RC_DAEMONS_FILE = path.join(HOOKED_DIR, 'rc-daemons.json');

// Short, stable discriminator from the absolute path → two projects with the same basename don't
// collide (neither in the daemon key nor in the app-visible remote-control name).
function projectHash(cwd) {
  return crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 8);
}

// Sanitized basename, safe to interpolate into the shell command below (charset restricted).
function projectBase(cwd) {
  return path.basename(cwd).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 24) || 'project';
}

// Clé déterministe d'un projet → sert d'index dans le fichier de PID.
function rcKey(cwd) {
  return `${projectBase(cwd)}-${projectHash(cwd)}`;
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
    out.push({ cwd, key: rcKey(cwd), app: rcAppName(cwd) });
  }
  return out;
}

// ── Registre de PID ──────────────────────────────────────────────────────────────────────────────
function readDaemons() {
  try {
    const j = JSON.parse(fs.readFileSync(RC_DAEMONS_FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (_) { return {}; }
}

function writeDaemons(map) {
  try {
    fs.mkdirSync(HOOKED_DIR, { recursive: true });
    fs.writeFileSync(RC_DAEMONS_FILE, JSON.stringify(map, null, 2) + '\n');
  } catch (_) {}
}

// Le process existe-t-il encore ? `kill(pid, 0)` ne tue rien, il teste seulement l'existence.
// EPERM = il tourne mais nous n'avons pas le droit de le signaler → il tourne quand même.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

// Démons du registre encore vivants, PID morts purgés au passage (self-healing du fichier).
function runningDaemons() {
  const map = readDaemons();
  const alive = {};
  let changed = false;
  for (const [key, d] of Object.entries(map)) {
    if (d && pidAlive(d.pid)) alive[key] = d;
    else changed = true;
  }
  if (changed) writeDaemons(alive);
  return alive;
}

// ── Cycle de vie d'un démon ──────────────────────────────────────────────────────────────────────
// Lancé dans un shell de LOGIN interactif (`-l -i -c`) : c'est là que les package managers (brew,
// asdf, nvm…) publient leur PATH, donc un hooked démarré avec un PATH minimal (launchd, systemd)
// retrouve quand même `claude`. Le `while true` relance claude s'il sort. `detached: true` + un
// nouveau groupe de process → le démon survit à l'arrêt de hooked ; `stdio: 'ignore'` + `unref()`
// pour ne rien retenir de l'event loop.
function spawnDaemon({ cwd, key, app }, cb = () => {}) {
  const shell = process.env.SHELL || '/bin/zsh';
  const inner = `while true; do claude remote-control --name ${app}; sleep 5; done`;
  let child;
  try {
    child = spawn(shell, ['-l', '-i', '-c', inner], {
      cwd,
      detached: true,
      stdio: 'ignore',
      // HOOKED_RC : recopié par hook.cjs sur chaque évènement → masque ces sessions du dashboard.
      env: { ...process.env, HOOKED_RC: '1' },
    });
    child.unref();
  } catch (e) {
    console.log(`[hooked] remote-control: failed to start daemon for ${cwd}: ${e.message || e}`);
    return cb(e);
  }
  const map = readDaemons();
  map[key] = { pid: child.pid, cwd, app, startedAt: new Date().toISOString() };
  writeDaemons(map);
  console.log(`[hooked] remote-control: started daemon for ${cwd} (pid ${child.pid})`);
  cb(null);
}

// Tue le groupe de process du démon (`-pid`), pas seulement le shell : sans ça, le `claude` que le
// wrapper a lancé survivrait à son parent. `detached: true` au spawn est ce qui rend le groupe
// adressable de cette façon.
function killDaemon(key, cb = () => {}) {
  const map = readDaemons();
  const d = map[key];
  if (d && Number.isInteger(d.pid)) {
    try { process.kill(-d.pid, 'SIGTERM'); }
    catch (_) { try { process.kill(d.pid, 'SIGTERM'); } catch (__) {} }
    console.log(`[hooked] remote-control: stopped daemon ${key} (pid ${d.pid})`);
  }
  delete map[key];
  writeDaemons(map);
  cb(null);
}

// Reconcile the running daemons to the configured project list: start what's missing, kill what's no
// longer wanted. Idempotent and best-effort (each spawn/kill is independent).
function reconcileRemoteControl(settings, cb = () => {}) {
  const desired = desiredProjects(settings);
  const wanted = new Set(desired.map((d) => d.key));
  const running = runningDaemons();
  const toKill = Object.keys(running).filter((k) => !wanted.has(k));
  const toStart = desired.filter((d) => !running[d.key]);
  for (const k of toKill) killDaemon(k);
  for (const d of toStart) spawnDaemon(d);
  cb(null, { started: toStart.length, stopped: toKill.length });
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

// Per-project daemon status for the settings UI: is the daemon process up?
function remoteControlStatus(settings, cb) {
  const desired = desiredProjects(settings);
  const configured = Array.isArray(settings?.remoteControlProjects) ? settings.remoteControlProjects : [];
  const running = runningDaemons();
  cb(configured.map((cwd) => {
    const found = desired.find((d) => d.cwd === cwd);
    return {
      project: cwd,
      name: found ? found.app : null,
      exists: !!found,                              // false → path no longer a directory
      running: found ? !!running[found.key] : false,
      pid: found && running[found.key] ? running[found.key].pid : null,
    };
  }));
}

export {
  rcKey,
  rcAppName,
  reconcileRemoteControl,
  applyRemoteControlSetting,
  startRemoteControl,
  remoteControlStatus,
  runningDaemons,
  pidAlive,
};
