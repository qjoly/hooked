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
  // Subagent Bash calls fire PreToolUse but NOT PostToolUse (observed) → their pre snapshots stay
  // orphaned. At turn boundaries nothing is in flight: sweep them (net diff vs current state).
  if (rec.event === 'Stop' || rec.event === 'UserPromptSubmit') { try { sweepOrphanPre(j); } catch (_) {} }
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
  // `gone` distingue, parmi les fichiers sales non épinglés, ceux ABSENTS du worktree (suppression
  // trackée) de ceux trop gros pour être épinglés (→ irrésolubles, jamais mal rapportés).
  const gone = dirty.filter((p) => { try { return !fs.statSync(path.join(root, p)).isFile(); } catch (_) { return true; } });
  fs.mkdirSync(PRE_DIR, { recursive: true });
  // Stale snapshots (denied command → PostToolUse never fired) are reaped after 1 h.
  try {
    for (const f of fs.readdirSync(PRE_DIR)) {
      const fp = path.join(PRE_DIR, f);
      try { if (Date.now() - fs.statSync(fp).mtimeMs > 3600 * 1000) fs.unlinkSync(fp); } catch (_) {}
    }
  } catch (_) {}
  fs.writeFileSync(preFileFor(j), JSON.stringify({ root, head, dirty, gone, blobs: pinBlobs(root, dirty) }));
}

// ── Vues d'état ──────────────────────────────────────────────────────────────────────────────────
// L'état d'un chemin, vu d'un instant donné : SHA de blob, null (absent), ou undefined
// (irrésoluble : fichier trop gros, ou snapshot ancien sans `gone` → on saute, jamais de faux diff).

// Vue depuis un snapshot pre : sale+épinglé → blob ; sale+absent (gone) → null ; sale non épinglé
// → undefined ; propre → son blob à HEAD au moment du snapshot (absent de HEAD = null : inexistant).
function snapView(snap, paths) {
  const dirty = new Set(snap.dirty || []);
  const gone = new Set(snap.gone || []);
  const atHead = headBlobs(snap.root, snap.head, paths.filter((p) => !dirty.has(p)));
  const view = {};
  for (const p of paths) {
    if (!dirty.has(p)) { view[p] = atHead[p] !== undefined ? atHead[p] : null; continue; }
    const pinned = snap.blobs && Object.prototype.hasOwnProperty.call(snap.blobs, p) ? snap.blobs[p] : undefined;
    view[p] = pinned !== undefined ? pinned : (gone.has(p) ? null : undefined);
  }
  return view;
}

// Vue de l'état ACTUEL du worktree : épinglage à la volée ; absent → null ; trop gros → undefined.
function liveView(root, paths) {
  const pinned = pinBlobs(root, paths);
  const view = {};
  for (const p of paths) {
    if (pinned[p] !== undefined) { view[p] = pinned[p]; continue; }
    let exists = false;
    try { exists = fs.statSync(path.join(root, p)).isFile(); } catch (_) {}
    view[p] = exists ? undefined : null;
  }
  return view;
}

// Émet les chemins dont l'état diffère entre deux vues dans bash-changes/<session_id>.jsonl.
function emitDiff(root, sessionId, candidates, oldView, newView) {
  const ts = new Date().toISOString();
  const lines = [];
  for (const p of candidates) {
    const oldBlob = oldView[p], newBlob = newView[p];
    if (oldBlob === undefined || newBlob === undefined) continue; // un côté irrésoluble → on saute
    if (oldBlob === newBlob) continue; // même blob (ou absent des deux côtés) → pas touché
    lines.push(JSON.stringify({ ts, root, file: path.join(root, p), old: oldBlob, new: newBlob }));
  }
  if (!lines.length) return;
  fs.mkdirSync(BASH_DIR, { recursive: true });
  const safe = String(sessionId).replace(/[^\w.-]/g, '_');
  fs.appendFileSync(path.join(BASH_DIR, safe + '.jsonl'), lines.join('\n') + '\n');
}

// Diffe un snapshot pre contre l'état ACTUEL du repo (cas nominal Pre→Post d'une commande).
function diffSince(snap, sessionId) {
  if (!snap || !snap.root || !sessionId) return;
  const candidates = [...new Set([...(snap.dirty || []), ...dirtyPaths(snap.root)])];
  if (!candidates.length) return;
  emitDiff(snap.root, sessionId, candidates, snapView(snap, candidates), liveView(snap.root, candidates));
}

// Lit ET supprime les snapshots orphelins d'une session (optionnellement : seulement ceux plus
// anciens qu'un mtime donné, et en excluant un fichier précis). Renvoie [{snap, m}].
function takeOrphans(sessionId, olderThan, exceptFile) {
  const prefix = String(sessionId).replace(/[^\w.-]/g, '_') + '-';
  let names = [];
  try { names = fs.readdirSync(PRE_DIR).filter((n) => n.startsWith(prefix)); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    const fp = path.join(PRE_DIR, n);
    if (exceptFile && fp === exceptFile) continue;
    let snap = null, m = Infinity;
    try { m = fs.statSync(fp).mtimeMs; snap = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) {}
    if (olderThan !== null && m >= olderThan) continue;
    try { fs.unlinkSync(fp); } catch (_) {}
    if (snap && snap.root) out.push({ snap, m });
  }
  return out;
}

// Chaîne des snapshots orphelins, par repo et du plus ancien au plus récent : diff snapᵢ → snapᵢ₊₁,
// puis dernier → état terminal (le snapshot `terminal` du repo s'il est fourni, sinon le worktree
// actuel). Restitue un delta par fenêtre sans jamais recouvrir une paire pre/post déjà consommée.
function chainOrphans(sessionId, orphans, terminalByRoot) {
  const byRoot = new Map();
  for (const s of orphans) {
    if (!byRoot.has(s.snap.root)) byRoot.set(s.snap.root, []);
    byRoot.get(s.snap.root).push(s);
  }
  for (const [root, list] of byRoot) {
    list.sort((a, b) => a.m - b.m);
    const terminal = terminalByRoot ? terminalByRoot.get(root) || null : null;
    for (let i = 0; i < list.length; i++) {
      const a = list[i].snap;
      const b = i + 1 < list.length ? list[i + 1].snap : terminal;
      try {
        const candidates = [...new Set([...(a.dirty || []), ...(b ? (b.dirty || []) : dirtyPaths(root))])];
        if (!candidates.length) continue;
        emitDiff(root, sessionId, candidates, snapView(a, candidates),
          b ? snapView(b, candidates) : liveView(root, candidates));
      } catch (_) {}
    }
  }
}

// Les Bash des SOUS-AGENTS n'émettent qu'un PreToolUse (pas de PostToolUse) → leurs snapshots
// restent orphelins et leurs modifs seraient perdues. Deux points de résorption :
//   1. bashPost : avant de diffuser sa propre paire, chaque post consomme les orphelins PLUS
//      ANCIENS que son snapshot pre, chaînés jusqu'à CE snapshot → aucun orphelin ne recouvre
//      jamais une paire consommée (pas de doublons), et les deltas restent datés dans le bon tour.
//   2. sweepOrphanPre (Stop / prompt suivant, plus rien en vol) : chaîne le reliquat jusqu'à
//      l'état courant du worktree.
function bashPost(j) {
  const pf = preFileFor(j);
  let snap, myM = null;
  try { myM = fs.statSync(pf).mtimeMs; snap = JSON.parse(fs.readFileSync(pf, 'utf8')); } catch (_) { return; }
  try { fs.unlinkSync(pf); } catch (_) {}
  if (!snap || !snap.root || !j.session_id) return;
  const older = takeOrphans(j.session_id, myM, pf);
  if (older.length) chainOrphans(j.session_id, older, new Map([[snap.root, snap]]));
  diffSince(snap, j.session_id);
}

function sweepOrphanPre(j) {
  if (!j.session_id) return;
  const orphans = takeOrphans(j.session_id, null, null);
  if (orphans.length) chainOrphans(j.session_id, orphans, null);
}
