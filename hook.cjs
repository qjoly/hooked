#!/usr/bin/env node
'use strict';
/*
 * hooked — capteur d'évènements de hooks Claude Code.
 *
 * Branché sur TOUS les hooks (SessionStart, UserPromptSubmit, PreToolUse,
 * PostToolUse, Notification, Stop, SubagentStop, SessionEnd, PreCompact).
 * Lit le JSON du hook sur stdin et append une ligne compacte dans
 * ~/.claude/hooked/events.jsonl. Ne bloque jamais Claude : ne sort rien,
 * exit 0 quoi qu'il arrive.
 *
 * Capture aussi les modifications de fichiers faites PAR LES COMMANDES BASH (invisible dans le
 * transcript, donc dans la lentille Ship) : au PreToolUse(Bash) on snapshotte l'état sale du repo
 * git (fichiers + contenus épinglés en blobs via `git hash-object -w`, content-addressed, sans
 * ref) ; au PostToolUse(Bash) on re-liste, on ne garde que les fichiers dont le blob a réellement
 * changé, et on append {file, old, new} (des SHAs de blobs, pas du contenu) dans
 * ~/.claude/hooked/bash-changes/<session_id>.jsonl. Le serveur (server/changes.js) résout les
 * blobs via `git cat-file` et fusionne ces ops dans le Ship. NB : les blobs non référencés sont
 * élagués par `git gc` après le délai de grâce (~2 semaines) — le serveur ignore alors l'op.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const DIR = process.env.HOOKED_DATA_DIR || path.join(os.homedir(), '.claude', 'hooked');
const FILE = path.join(DIR, 'events.jsonl');
const BASH_DIR = path.join(DIR, 'bash-changes'); // one .jsonl per session
const PRE_DIR = path.join(DIR, 'bash-pre');      // pre-command snapshots, deleted at PostToolUse

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => { try { handle(raw); } catch (_) {} process.exit(0); });
process.stdin.on('error', () => process.exit(0));
// Filet de sécurité : si pas de stdin, on sort quand même.
setTimeout(() => { try { handle(raw); } catch (_) {} process.exit(0); }, 2500);

function handle(input) {
  let j = {};
  try { j = JSON.parse(input); } catch (_) {}
  const rec = {
    ts: new Date().toISOString(),
    event: j.hook_event_name || process.argv[2] || 'unknown',
    session_id: j.session_id || null,
    cwd: j.cwd || null,
    transcript: j.transcript_path || null,
    tool: j.tool_name || null,
    // mode de permission courant (default / acceptEdits / plan / bypassPermissions) : présent
    // sur tous les payloads de hooks → seule source pour savoir dans quel mode tourne la session
    // (le transcript ne le porte pas). Sert au dashboard pour afficher/changer le mode.
    mode: j.permission_mode || null,
    // input d'AskUserQuestion : capturé au PreToolUse car le tool_use n'est écrit dans
    // le transcript qu'une fois la question répondue → c'est la seule source de la
    // question tant qu'elle est *en attente*. (questions : [{question, header, options, multiSelect}])
    ask: (j.tool_name === 'AskUserQuestion' && j.tool_input && Array.isArray(j.tool_input.questions))
      ? j.tool_input.questions
      : null,
    // plan proposé via ExitPlanMode : capturé au PreToolUse (le tool_use n'entre dans le transcript
    // qu'une fois le plan approuvé/rejeté) → seule source pour l'afficher tant qu'il est en attente.
    plan: (j.tool_name === 'ExitPlanMode' && j.tool_input && typeof j.tool_input.plan === 'string')
      ? j.tool_input.plan.slice(0, 20000)
      : null,
    message: typeof j.message === 'string' ? j.message.slice(0, 500) : null,
    // prompt utilisateur (UserPromptSubmit) : sert de titre à la session tant que le
    // transcript n'est pas encore écrit (sinon la session s'affiche sans nom au lancement).
    prompt: typeof j.prompt === 'string' ? j.prompt.slice(0, 200) : null,
    // pane tmux de la session (hérité de l'env du process Claude) → permet de
    // renvoyer une réponse dans la session interactive via `tmux send-keys`.
    tmux_pane: process.env.TMUX_PANE || null,
  };
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {}
  try { fs.appendFileSync(FILE, JSON.stringify(rec) + '\n'); } catch (_) {}
  // Bash file-change capture — after the event append (never jeopardize it), each step guarded.
  if (rec.tool === 'Bash') {
    if (rec.event === 'PreToolUse') { try { bashPre(j); } catch (_) {} }
    if (rec.event === 'PostToolUse') { try { bashPost(j); } catch (_) {} }
  }
}

// ── Bash file-change capture ─────────────────────────────────────────────────────────────────────

const GIT_TIMEOUT = 3000;
const MAX_PINNED = 200;                 // dirty files pinned per snapshot
const MAX_FILE_SIZE = 2 * 1024 * 1024;  // beyond: skipped (never misreported as add/delete)
const SHA_RE = /^[0-9a-f]{40,64}$/;

function git(root, args, input) {
  return cp.execFileSync('git', ['-C', root, ...args], {
    timeout: GIT_TIMEOUT, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
    input: input !== undefined ? input : '',
  });
}

// Repo-root-relative paths of everything dirty (staged, unstaged, untracked). `-z` = NUL-separated
// AND unquoted paths; rename/copy entries carry an extra NUL-separated origin path to skip.
function dirtyPaths(root) {
  const toks = git(root, ['status', '--porcelain', '-z', '-uall']).split('\0');
  const paths = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t || t.length < 4) continue;
    paths.push(t.slice(3));
    const code = t[0] === ' ' ? t[1] : t[0];
    if (code === 'R' || code === 'C') i++;
  }
  return paths;
}

// Pin the current content of existing regular files into the git object store (content-addressed,
// no ref → invisible to the repo). Returns {relPath: blobSha}; missing/oversized files are absent.
function pinBlobs(root, paths) {
  const usable = paths.filter((p) => {
    try { const st = fs.statSync(path.join(root, p)); return st.isFile() && st.size <= MAX_FILE_SIZE; }
    catch (_) { return false; }
  }).slice(0, MAX_PINNED);
  if (!usable.length) return {};
  const hashes = git(root, ['hash-object', '-w', '--stdin-paths'], usable.join('\n') + '\n').trim().split('\n');
  const map = {};
  usable.forEach((p, i) => { if (SHA_RE.test(hashes[i] || '')) map[p] = hashes[i]; });
  return map;
}

// Blob SHAs of the given paths at `head` (only those that exist there — an added file is absent).
function headBlobs(root, head, paths) {
  if (!head || !paths.length) return {};
  const map = {};
  const out = git(root, ['ls-tree', '-z', head, '--', ...paths.slice(0, MAX_PINNED)]);
  for (const line of out.split('\0')) {
    const m = line.match(/^\d+ blob ([0-9a-f]+)\t([\s\S]+)$/);
    if (m) map[m[2]] = m[1];
  }
  return map;
}

// Snapshot key: PreToolUse and PostToolUse of the same call share tool_use_id (fallback 'last' —
// parallel Bash calls without an id may collide, acceptable degradation).
function preFileFor(j) {
  const key = (j.session_id || 'nosession') + '-' + (j.tool_use_id || 'last');
  return path.join(PRE_DIR, key.replace(/[^\w.-]/g, '_') + '.json');
}

function bashPre(j) {
  if (!j.cwd) return;
  let root = null;
  try { root = git(j.cwd, ['rev-parse', '--show-toplevel']).trim() || null; } catch (_) {}
  if (!root) return;
  let head = null;
  try { head = git(root, ['rev-parse', 'HEAD']).trim(); } catch (_) {} // empty repo → null
  const dirty = dirtyPaths(root);
  fs.mkdirSync(PRE_DIR, { recursive: true });
  // Stale snapshots (denied command → PostToolUse never fired) are reaped after 1 h.
  try {
    for (const f of fs.readdirSync(PRE_DIR)) {
      const fp = path.join(PRE_DIR, f);
      try { if (Date.now() - fs.statSync(fp).mtimeMs > 3600 * 1000) fs.unlinkSync(fp); } catch (_) {}
    }
  } catch (_) {}
  fs.writeFileSync(preFileFor(j), JSON.stringify({ root, head, dirty, blobs: pinBlobs(root, dirty) }));
}

function bashPost(j) {
  const pf = preFileFor(j);
  let snap;
  try { snap = JSON.parse(fs.readFileSync(pf, 'utf8')); } catch (_) { return; }
  try { fs.unlinkSync(pf); } catch (_) {}
  if (!snap || !snap.root || !j.session_id) return;
  const root = snap.root;
  const preDirty = new Set(snap.dirty || []);
  const candidates = [...new Set([...(snap.dirty || []), ...dirtyPaths(root)])];
  if (!candidates.length) return;
  const newBlobs = pinBlobs(root, candidates);
  // Old content of files that were CLEAN pre-command = their blob at the pre-command HEAD.
  const atHead = headBlobs(root, snap.head, candidates.filter((p) => !preDirty.has(p)));
  const ts = new Date().toISOString();
  const lines = [];
  for (const p of candidates) {
    const abs = path.join(root, p);
    let existsNow = false;
    try { existsNow = fs.statSync(abs).isFile(); } catch (_) {}
    if (existsNow && newBlobs[p] === undefined) continue; // unpinnable (oversized) → skip, don't misreport
    const oldBlob = preDirty.has(p) ? (snap.blobs && snap.blobs[p]) || null : atHead[p] || null;
    const newBlob = existsNow ? newBlobs[p] : null;
    if (oldBlob === newBlob) continue; // same blob (or both absent) → untouched by this command
    lines.push(JSON.stringify({ ts, root, file: abs, old: oldBlob, new: newBlob }));
  }
  if (!lines.length) return;
  fs.mkdirSync(BASH_DIR, { recursive: true });
  const safe = String(j.session_id).replace(/[^\w.-]/g, '_');
  fs.appendFileSync(path.join(BASH_DIR, safe + '.jsonl'), lines.join('\n') + '\n');
}
