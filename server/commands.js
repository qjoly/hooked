/*
 * Auto-complétion des commandes « / » du composer. Quatre sources fusionnées :
 *   1. custom   — fichiers .claude/commands/**.md (projet + global ~/.claude/commands),
 *                 namespacés par sous-dossier (frontend/x.md → /frontend:x).
 *   2. built-in — liste curée codée en dur ici (descriptions EN fiables, toujours dispo).
 *   3. built-in extraites du binaire claude-code (JS embarqué) : on lit les déclarations
 *      `type:"local",name:"…"` du bundle pour récupérer les commandes même non curées.
 *   4. built-in — the driven session's own list (`Query.supportedCommands()`), the only source
 *                 that names the skills BUNDLED in the binary.
 * La liste curée prime pour la description ; les deux dernières complètent la couverture.
 */
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { createRequire } from 'node:module';
import { HOME, HOOKED_DIR, SDK_COMMANDS_FILE } from './config.js';
import { fuzzyScore } from './files.js';

// ---------- 2. liste curée (built-in) ----------
// Short English descriptions. Also serves as a fallback if extraction fails.
const CURATED = [
  ['clear', 'Clear conversation history and free up context'],
  ['compact', 'Summarize the conversation to free up context'],
  ['context', 'Visualize current context usage'],
  ['config', 'Open settings'],
  ['model', 'Change the session model'],
  ['effort', 'Change reasoning effort'],
  ['cost', 'Show session cost and usage'],
  ['usage', 'Show plan usage and limits'],
  ['resume', 'Resume a previous conversation'],
  ['init', 'Generate a CLAUDE.md file for the project'],
  ['review', 'Review a pull request'],
  ['pr-comments', 'Get comments from a pull request'],
  ['agents', 'Manage subagents'],
  ['mcp', 'Manage MCP servers'],
  ['hooks', 'Edit hooks'],
  ['memory', 'Edit memory files (CLAUDE.md)'],
  ['permissions', 'Manage tool permissions'],
  ['status', 'Show session and account status'],
  ['doctor', 'Diagnose the Claude Code installation'],
  ['add-dir', 'Add a working directory'],
  ['output-style', 'Change the output style'],
  ['terminal-setup', 'Configure the terminal for Claude Code'],
  ['vim', 'Enable vim editing mode'],
  ['theme', 'Change the theme'],
  ['export', 'Export the conversation'],
  ['bug', 'Report a bug to Anthropic'],
  ['feedback', 'Send feedback'],
  ['release-notes', 'Show release notes'],
  ['install-github-app', 'Install the GitHub app'],
  ['login', 'Sign in to your account'],
  ['logout', 'Sign out'],
  ['upgrade', 'Upgrade your plan'],
  ['privacy-settings', 'Privacy settings'],
  ['help', 'Show help and available commands'],
  ['exit', 'Exit Claude Code'],
  // Skills bundled in the binary. They are neither on disk nor greppable in a structured form, so
  // a running session is the only source that names them — and the palette is asked long before
  // one exists (the « New session » screen). Curated here so they are offered from the first
  // keystroke; a live session still refreshes the set.
  ['code-review', 'Review the current diff for bugs and cleanups'],
  ['simplify', 'Clean up the changed code (reuse, simplification, efficiency)'],
  ['security-review', 'Security review of the pending changes'],
  ['loop', 'Run a prompt or slash command on a recurring interval'],
  ['schedule', 'Create and manage scheduled cloud agents'],
  ['run', 'Launch the project app to see a change working'],
];

// noms clairement internes/cachés à exclure de l'extraction
const INTERNAL = new Set(['daemon', 'heapdump', 'bridge-kick', 'init-verifiers',
  'reload-plugins', 'reload-skills', 'remote-env', 'remote-control', 'tui', 'radio',
  'pro-trial-expired', 'rate-limit-options', 'autocompact', 'toggle-memory']);

// ---------- 3. extraction depuis le binaire claude ----------
let _binCache = null;       // { path, mtime } résolution du binaire
let _extractCache = null;   // { path, mtime, list } commandes extraites

// Locate the claude binary. We cache the stable PATH entry / symlink (`_binCache`) — which survives
// version upgrades — but re-derive the REAL target FRESH on every call, so an out-of-band upgrade
// (the symlink now points at a new versioned path, e.g. a brew-cask bump) is reflected immediately
// instead of pinning a now-deleted versioned path. Re-resolve if the cached entry has vanished
// (uninstall / relocation).
/*
 * PATH lookup done in JS rather than by asking a shell.
 *
 * `command -v` is a POSIX shell builtin: on Windows execSync runs through cmd, which has no
 * equivalent, so the lookup always failed. Doing it here removes the shell entirely and lets the
 * Windows side honour PATHEXT — the binary is `claude.exe` there, and probing for an
 * extensionless `claude` finds nothing.
 */
function whichBin(name) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.trim()).filter(Boolean)
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch (_) { /* next candidate */ }
    }
  }
  return null;
}

// Usual install locations, probed when PATH does not carry claude — under systemd or launchd the
// service PATH is minimal (no Homebrew, no npm-global) and a real install would be missed.
// Platform is a parameter so the Windows list can be asserted from any OS.
function claudeCandidates(platform = process.platform) {
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
    const roaming = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    return [
      path.join(HOME, '.local', 'bin', 'claude.exe'),
      path.join(local, 'Programs', 'claude', 'claude.exe'),
      path.join(roaming, 'npm', 'claude.cmd'),
      path.join(HOME, '.claude', 'local', 'claude.exe'),
    ];
  }
  return [
    '/home/linuxbrew/.linuxbrew/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
    path.join(HOME, '.local/bin/claude'), path.join(HOME, '.claude/local/claude'),
    path.join(HOME, '.npm-global/bin/claude'), '/usr/bin/claude',
  ];
}

function resolveClaudeBin() {
  if (_binCache && !fs.existsSync(_binCache)) _binCache = null;   // cached entry gone → re-resolve
  if (_binCache === null) {
    let found = whichBin('claude');
    if (!found) {
      for (const c of claudeCandidates()) {
        try { fs.accessSync(c, fs.constants.X_OK); found = c; break; } catch (_) { /* next candidate */ }
      }
    }
    _binCache = found;   // the stable symlink / PATH entry (NOT the versioned real path)
  }
  if (!_binCache) return null;
  // Follow symlinks to the real binary FRESH (native .exe bundle or cli.js) so a version bump behind
  // the symlink is reflected on the very next call. realpathSync replaces `readlink -f`, which is
  // another POSIX-only tool.
  try { return fs.realpathSync(_binCache) || _binCache; } catch (_) { return _binCache; }
}

/*
 * The CLI that DRIVEN sessions actually execute — distinct from resolveClaudeBin(), the INSTALLED
 * one. The Agent SDK spawns its own vendored binary (@anthropic-ai/claude-agent-sdk-<platform>-
 * <arch>), not the PATH install, and the two drift: a brew cask several releases behind the SDK
 * left claude-fable-5-1 out of the model selector while every session could already run it.
 * Anything answering "what can a driven session do" (capabilities' models/efforts, extracted
 * builtins) must scrape THIS binary; installation concerns (claudeUpdate.js upgrade command,
 * mcp.js subprocesses) stay on resolveClaudeBin().
 *
 * Resolution mirrors the SDK's own order: HOOKED_CLAUDE_BIN (agent.js passes it verbatim as
 * pathToClaudeCodeExecutable) → vendored platform package → PATH install as a last resort (platform
 * package absent, e.g. an unsupported musl variant). No caching needed: callers already cache by
 * the returned path's mtime, and require.resolve is cheap next to the greps that follow.
 */
function resolveDrivenClaudeBin() {
  const override = process.env.HOOKED_CLAUDE_BIN;
  if (override) {
    try { fs.accessSync(override, fs.constants.X_OK); return override; } catch (_) { /* unusable override → ignore */ }
  }
  try {
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const bin = createRequire(import.meta.url)
      .resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${exe}`);
    fs.accessSync(bin, fs.constants.X_OK);
    return bin;
  } catch (_) { /* platform package absent → fall back to the installed CLI */ }
  return resolveClaudeBin();
}

// Scanne le bundle pour les déclarations `type:"local|local-jsx|prompt",name:"…"[,description:"…"]`.
// grep -a traite le binaire comme du texte ; sortie minuscule → parse en JS. Mise en cache (mtime).
function extractBuiltins() {
  const bin = resolveDrivenClaudeBin();   // builtins offered to DRIVEN sessions → their binary
  if (!bin) return [];
  let st;
  try { st = fs.statSync(bin); } catch (_) { return []; }
  const mtime = st.mtimeMs;
  if (_extractCache && _extractCache.path === bin && _extractCache.mtime === mtime) return _extractCache.list;
  let out = '';
  try {
    out = cp.execFileSync('grep', [
      '-aoE', 'type:"(local|local-jsx|prompt)",name:"[a-z][a-z0-9:_-]*"(,description:"[^"]{1,160}")?', bin,
    ], { encoding: 'utf8', maxBuffer: 8 << 20 });
  } catch (e) {
    // grep renvoie 1 si aucune correspondance ; sinon on récupère ce qui a été lu
    out = (e && e.stdout) ? String(e.stdout) : '';
  }
  const seen = new Map();
  const re = /name:"([a-z][a-z0-9:_-]*)"(?:,description:"([^"]*)")?/;
  for (const line of out.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const name = m[1];
    if (name.includes('__') || INTERNAL.has(name)) continue;
    if (!seen.has(name)) seen.set(name, m[2] || '');
  }
  const list = [...seen].map(([name, description]) => ({ name, description }));
  _extractCache = { path: bin, mtime, list };
  return list;
}

// ---------- built-in fusionnées (curée prioritaire pour la description) ----------
function builtinCommands() {
  const byName = new Map();
  for (const [name, description] of CURATED) byName.set(name, { name, description, group: 'builtin' });
  for (const { name, description } of extractBuiltins()) {
    if (byName.has(name)) continue;                 // curée prime
    byName.set(name, { name, description, group: 'builtin' });
  }
  return [...byName.values()];
}

// ---------- 1. commandes custom : .claude/commands, skills, plugins installés ----------
function listMd(root, prefix = '', acc = [], depth = 0) {
  if (depth > 6) return acc;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return acc; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) listMd(full, prefix + e.name + ':', acc, depth + 1);
    else if (e.isFile() && e.name.endsWith('.md')) acc.push({ file: full, name: prefix + e.name.slice(0, -3) });
  }
  return acc;
}
// frontmatter `name:`/`description:` sinon 1re ligne non vide du corps comme description.
function parseFrontmatter(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  let name = null, description = '', body = raw;
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end >= 0) {
      const fm = raw.slice(3, end);
      const dm = fm.match(/(^|\n)\s*description\s*:\s*(.+)/i);
      if (dm) description = dm[2].trim().replace(/^["']|["']$/g, '');
      const nm = fm.match(/(^|\n)\s*name\s*:\s*(.+)/i);
      if (nm) name = nm[2].trim().replace(/^["']|["']$/g, '');
      body = raw.slice(end + 4);
    }
  }
  if (!description) for (const line of body.split('\n')) { const t = line.trim(); if (t) { description = t.replace(/^#+\s*/, ''); break; } }
  return { name, description: description.slice(0, 160) };
}
// .claude/commands/**.md — namespacés par sous-dossier (frontend/x.md → frontend:x).
function commandsDir(root, source) {
  return listMd(root).map(({ file, name }) => ({ name, description: (parseFrontmatter(file) || {}).description || '', group: 'custom', source }));
}
// skills — dossier `<nom>/SKILL.md` ou fichier `<nom>.md`. Nom = frontmatter `name` sinon basename.
function skillsDir(root, source) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const e of entries) {
    let file = null, base = e.name;
    if (e.isDirectory()) { const sk = path.join(root, e.name, 'SKILL.md'); if (fs.existsSync(sk)) file = sk; }
    else if (e.isFile() && e.name.endsWith('.md')) { file = path.join(root, e.name); base = e.name.slice(0, -3); }
    if (!file) continue;
    const fm = parseFrontmatter(file) || {};
    out.push({ name: fm.name || base, description: fm.description || '', group: 'custom', source });
  }
  return out;
}
// commandes des plugins installés (installed_plugins.json → <installPath>/commands/**.md).
function pluginCommandsList() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')); } catch (_) { return []; }
  const out = [];
  for (const [key, arr] of Object.entries((cfg && cfg.plugins) || {})) {
    const plugin = key.split('@')[0];
    for (const inst of arr || []) {
      for (const { file, name } of listMd(path.join(inst.installPath || '', 'commands'))) {
        out.push({ name, description: (parseFrontmatter(file) || {}).description || '', group: 'custom', source: plugin });
      }
    }
  }
  return out;
}
const _customCache = new Map(); // cwd -> { at, list }
function customCommands(cwd) {
  const key = cwd || '';
  const c = _customCache.get(key);
  const now = Date.now();
  if (c && now - c.at < 10000) return c.list;
  const byName = new Map();
  const add = (arr) => { for (const cmd of arr) byName.set(cmd.name, cmd); };
  // priorité croissante (dernier écrit gagne) : plugins < skills < commands global < commands projet
  add(pluginCommandsList());
  add(skillsDir(path.join(HOME, '.claude', 'skills'), 'skill'));
  if (cwd) add(skillsDir(path.join(cwd, '.claude', 'skills'), 'skill'));
  add(commandsDir(path.join(HOME, '.claude', 'commands'), 'global'));
  if (cwd) add(commandsDir(path.join(cwd, '.claude', 'commands'), 'projet'));
  const list = [...byName.values()];
  _customCache.set(key, { at: now, list });
  return list;
}

// ---------- 4. commands the driven session declares (Agent SDK) ----------
/*
 * The skills BUNDLED in the binary (/code-review, /simplify, /security-review, /loop…) escape the
 * three sources above: they exist nowhere on disk, and the bundle registers them under a minified
 * identifier (`go({name:tM,…})`) — no `type:"local"`, no literal name, so the grep of (3) cannot
 * see them either. Only a running session can name them, through `Query.supportedCommands()` (see
 * agentSupportedCommands in agent.js).
 *
 * Merged as built-ins and only as a COMPLEMENT: the SDK list leaves out the purely TUI commands
 * (/vim, /theme…), which must stay in the palette.
 */
function sdkCommands(sdk) {
  const out = [];
  for (const c of sdk || []) {
    const name = c && c.name;
    if (typeof name !== 'string' || !name || name.includes('__') || INTERNAL.has(name)) continue;
    out.push({ name, description: String(c.description || '').slice(0, 160), group: 'builtin' });
  }
  return out;
}

/*
 * Persisted so the palette keeps offering the bundled skills when NO session is driven — the
 * « New session » screen, and the first keystrokes after a restart, would otherwise lose them until
 * a session happens to be running.
 *
 * What the session's own directory contributes is stripped before writing: `supportedCommands()`
 * also names that project's .claude/commands and skills, and replaying those in another project
 * would offer commands that do not exist there. What remains comes from the binary, hence holds
 * everywhere.
 */
function rememberSdkCommands(sdk, sdkCwd) {
  const list = sdkCommands(sdk);
  if (!list.length) return [];
  const local = new Set(customCommands(sdkCwd).map((c) => c.name));
  const portable = list.filter((c) => !local.has(c.name));
  try {
    fs.mkdirSync(HOOKED_DIR, { recursive: true });
    fs.writeFileSync(SDK_COMMANDS_FILE, JSON.stringify({ ts: new Date().toISOString(), commands: portable }));
  } catch (_) { /* cache best-effort : la palette marche sans, en moins complet */ }
  _sdkFileCache = { mtime: null, list: portable };
  return portable;
}

let _sdkFileCache = null;   // { mtime, list }
function persistedSdkCommands() {
  let mtime;
  try { mtime = fs.statSync(SDK_COMMANDS_FILE).mtimeMs; } catch (_) { return []; }
  if (_sdkFileCache && _sdkFileCache.mtime === mtime) return _sdkFileCache.list;
  let list = [];
  try {
    const raw = JSON.parse(fs.readFileSync(SDK_COMMANDS_FILE, 'utf8'));
    list = sdkCommands(raw && raw.commands);
  } catch (_) { list = []; }
  _sdkFileCache = { mtime, list };
  return list;
}

// ---------- API ----------
// First occurrence wins: custom > curated/extracted > SDK. PURE (tested without the binary).
function mergeCommands(custom, builtin) {
  const byName = new Map();
  for (const c of [...custom, ...builtin]) if (!byName.has(c.name)) byName.set(c.name, c);
  return [...byName.values()];
}
function slashCommands(cwd, sdk) {
  return mergeCommands(customCommands(cwd), [...builtinCommands(), ...sdkCommands(sdk)]);
}
// filtre + classement flou sur le nom. q sans le « / ». Custom avant built-in à égalité.
function matchCommands(list, q, limit = 30) {
  q = (q || '').toLowerCase().trim();
  if (!q) {
    return list.slice().sort((a, b) =>
      (a.group === b.group ? 0 : a.group === 'custom' ? -1 : 1) || a.name.localeCompare(b.name)
    ).slice(0, limit);
  }
  const scored = [];
  for (const c of list) {
    const s = fuzzyScore(c.name, q);
    if (s == null) continue;
    scored.push([c, s + (c.group === 'custom' ? -0.5 : 0)]); // léger biais custom
  }
  scored.sort((a, b) => a[1] - b[1] || a[0].name.length - b[0].name.length);
  return scored.slice(0, limit).map((x) => x[0]);
}

export { CURATED, rememberSdkCommands, persistedSdkCommands, resolveClaudeBin, resolveDrivenClaudeBin, claudeCandidates, extractBuiltins, builtinCommands, customCommands, sdkCommands, mergeCommands, slashCommands, matchCommands };
