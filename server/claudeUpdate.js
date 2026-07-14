/*
 * Keeping claude-code up to date across the tmux sessions hooked tracks.
 *
 * A `claude` process keeps running the exact code it started with: upgrading the installed binary
 * does NOT touch already-running sessions — they keep the old version until restarted. This module
 * exposes, for Settings:
 *   1. the INSTALLED version (`claude --version`) — our reference for "latest available";
 *   2. how claude is installed (npm-global / homebrew / native / unknown), the matching upgrade
 *      command, and whether the install prefix is user-writable → sudo guard (we NEVER run sudo);
 *   3. the live sessions RUNNING an older version than installed (exact, from each transcript's
 *      newest `version` field — cf. server/transcript.js) → candidates for restart + resume.
 *
 * Node stdlib only. Restart/reconnect itself lives in server/tmux.js (restartSession).
 */
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { HOME } from './config.js';
import { resolveClaudeBin } from './commands.js';
import { buildSessions } from './stats.js';

// ---------- semver ----------
// Parse the leading `x.y.z` of a version string (tolerates a trailing suffix like " (Claude Code)").
function parseSemver(str) {
  const m = String(str || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
// -1 if a < b, 0 if equal, 1 if a > b. Unparseable → 0 (treated as "same", i.e. not outdated).
function cmpSemver(a, b) {
  const pa = parseSemver(a), pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1; }
  return 0;
}

// ---------- installed version ----------
let _verCache = null; // { path, mtime, version }
function installedVersion() {
  const bin = resolveClaudeBin();
  if (!bin) return null;
  let st;
  try { st = fs.statSync(bin); } catch (_) { return null; }
  const mtime = st.mtimeMs;
  if (_verCache && _verCache.path === bin && _verCache.mtime === mtime) return _verCache.version;
  let version = null;
  try {
    const out = cp.execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
    const p = parseSemver(out);
    version = p ? p.join('.') : null;
  } catch (_) { /* binary refused --version */ }
  _verCache = { path: bin, mtime, version };
  return version;
}
function invalidateVersionCache() { _verCache = null; }

// ---------- install method + sudo guard ----------
function dirWritable(d) {
  try { fs.accessSync(d, fs.constants.W_OK); return true; } catch (_) { return false; }
}

// Resolve both the PATH entry (`command -v claude`, the symlink an upgrade rewrites) and the real
// target (`readlink -f`). resolveClaudeBin() already gives the real path; we recover the symlink here.
function resolvePaths() {
  const real = resolveClaudeBin();
  if (!real) return { bin: null, real: null };
  let bin = real;
  try {
    const which = cp.execSync('command -v claude', { encoding: 'utf8' }).trim();
    if (which) bin = which;
  } catch (_) { /* not on PATH — fall back to real */ }
  return { bin, real };
}

// Classify the install method from the resolved binary path and return the matching upgrade command
// plus a writability-based sudo guard. `upgrade` is a full shell command string (run via a login
// shell so brew/npm are on PATH — same trick as launchSession); null when we don't know how to
// upgrade automatically. `needsSudo` = the install prefix is not user-writable → we warn instead.
function detectInstall() {
  const { bin, real } = resolvePaths();
  if (!bin || !real) {
    return { bin: null, real: null, method: 'absent', writable: false, needsSudo: false, upgrade: null,
      note: 'claude not found on PATH' };
  }
  const low = real.toLowerCase();
  let method = 'unknown', upgrade = null, label = 'unknown';
  if (/\/caskroom\//.test(low)) {
    method = 'brew'; label = 'brew (cask)'; upgrade = 'brew upgrade --cask claude-code';
  } else if (/\/cellar\/|\/linuxbrew\/|\/homebrew\/|\/opt\/homebrew\//.test(low)) {
    method = 'brew'; label = 'brew'; upgrade = 'brew upgrade claude-code';
  } else if (/\/node_modules\//.test(low)) {
    method = 'npm'; label = 'npm (global)'; upgrade = 'npm i -g @anthropic-ai/claude-code@latest';
  } else if (real.startsWith(path.join(HOME, '.local') + path.sep) || real.startsWith(path.join(HOME, '.claude', 'local') + path.sep)) {
    method = 'native'; label = 'native installer'; upgrade = 'claude update';
  }
  // Writable when BOTH the PATH symlink's dir and the real binary's dir accept writes for our uid.
  // An upgrade rewrites the symlink (bin) and drops new files next to the real binary (real).
  const writable = dirWritable(path.dirname(bin)) && dirWritable(path.dirname(real));
  const needsSudo = !writable;
  return { bin, real, method, label, writable, needsSudo, upgrade };
}

// ---------- outdated live sessions ----------
// Live sessions (tmuxAlive) whose running claude version (transcript's newest `version`) is older
// than the installed binary. These are the ones a restart + resume would move onto the new version.
function outdatedSessions() {
  const installed = installedVersion();
  if (!installed) return [];
  const rows = [];
  for (const s of buildSessions()) {
    if (!s.tmuxAlive || !s.version) continue;
    if (cmpSemver(s.version, installed) < 0) {
      rows.push({
        id: s.id,
        projectName: s.projectName,
        version: s.version,
        installed,
        tmuxPane: s.tmuxPane,
        state: s.state,
        model: s.model || null,
        effort: s.effort || null,
      });
    }
  }
  return rows;
}

// ---------- aggregate for the API ----------
function claudeVersionInfo() {
  return {
    install: detectInstall(),
    installed: installedVersion(),
    outdated: outdatedSessions(),
  };
}

// ---------- run the upgrade (user-triggered) ----------
// NEVER runs sudo. If the install prefix is not user-writable (or we can't map an upgrade command),
// returns { ok:false, needsSudo, warning, cmd } WITHOUT running anything — the UI surfaces the
// manual command. Otherwise runs the command in a login shell (so brew/npm resolve) and returns the
// (freshly re-read) installed version.
function runUpgrade(cb) {
  const install = detectInstall();
  if (install.method === 'absent') return cb(null, { ok: false, warning: 'claude not found on PATH', cmd: null });
  if (!install.upgrade) {
    return cb(null, { ok: false, warning: `Unknown install method (${install.real}) — upgrade claude manually.`, cmd: null });
  }
  if (install.needsSudo) {
    return cb(null, {
      ok: false, needsSudo: true, cmd: install.upgrade,
      warning: `Upgrade needs elevated permissions (install prefix not writable). Run \`${install.upgrade}\` in a terminal.`,
    });
  }
  // Login+interactive shell: same PATH-recovery trick as launchSession. The command is a fixed
  // constant (no user input) → safe to pass as a shell string.
  const shell = process.env.SHELL || '/bin/zsh';
  cp.execFile(shell, ['-l', '-i', '-c', install.upgrade], { timeout: 180000, encoding: 'utf8', maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
    const output = ((stdout || '') + (stderr || '')).trim().slice(-4000);
    invalidateVersionCache();
    if (err) return cb(null, { ok: false, warning: 'upgrade failed: ' + (err.message || err), cmd: install.upgrade, output });
    cb(null, { ok: true, installed: installedVersion(), cmd: install.upgrade, output });
  });
}

export { parseSemver, cmpSemver, installedVersion, invalidateVersionCache, detectInstall, outdatedSessions, claudeVersionInfo, runUpgrade };
