/*
 * Opérations git sur le dépôt DANS LEQUEL tourne le serveur hooked lui-même (pas un projet de
 * session). Sert la page Réglages : voir la branche courante, lister les branches (locales +
 * distantes), checkout, et une boucle de fond optionnelle fetch + pull --ff-only (jamais
 * destructive). Racine du dépôt résolue AU RUNTIME depuis l'emplacement du serveur (ROOT), jamais
 * codée en dur.
 *
 * Sécurité : toutes les commandes passent par execFile('git', [argv…]) — JAMAIS d'interpolation
 * shell (cf. server/tmux.js). Les noms de branche fournis par le client sont validés contre une
 * liste blanche stricte (BRANCH_RE, dans l'esprit de MODEL_ARG_RE de config.js) avant tout usage.
 *
 * Toutes les fonctions acceptent une racine explicite (défaut resolveGitRoot()) → testables
 * contre un dépôt jetable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT, HOOKED_DIR } from './config.js';

// Intervalle de la boucle fetch/ff-pull (ms). Surchargée par env pour ajuster à son réseau.
const SYNC_INTERVAL = parseInt(process.env.HOOKED_GIT_SYNC_INTERVAL || '180000', 10) || 180000;
// Commande de redémarrage du service (best-effort) : défaut systemd user, surchargée par
// HOOKED_RESTART_CMD (variable d'ADMIN, pas d'entrée web → passée à `sh -c` sans risque d'injection).
const RESTART_CMD_ENV = process.env.HOOKED_RESTART_CMD || '';
const DEFAULT_RESTART_ARGV = ['systemctl', ['--user', 'restart', 'hooked-dev']];
// Timeout par commande git (ms). fetch/pull touchent le réseau → généreux.
const GIT_TIMEOUT = 60000;

// Nom de branche accepté : liste blanche stricte. Refuse les noms option-like (`-x`), la
// traversée (`..`), les caractères de contrôle. Assez permissif pour `feat/live-state-plans`.
const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!\/)[\w.\-/]{1,200}$/;
function isValidBranchName(name) {
  return typeof name === 'string'
    && BRANCH_RE.test(name)
    && !name.endsWith('/')
    && !name.endsWith('.lock');
}

// Fichier d'état persistant de la synchro git (survit à un redémarrage du service, contrairement à
// l'état mémoire) : sert la bannière « redémarrage nécessaire / effectué » de l'UI.
const SYNC_STATE_FILE = () => path.join(HOOKED_DIR, 'git-sync-state.json');
const SYNC_STATE_DEFAULTS = { restartNeeded: false, note: '', lastPullAt: 0, lastRestartAt: 0 };
function readGitSyncState() {
  try {
    const j = JSON.parse(fs.readFileSync(SYNC_STATE_FILE(), 'utf8'));
    return { ...SYNC_STATE_DEFAULTS, ...(j && typeof j === 'object' ? j : {}) };
  } catch (_) {
    return { ...SYNC_STATE_DEFAULTS };
  }
}
function setGitSyncState(patch) {
  const merged = { ...readGitSyncState(), ...(patch && typeof patch === 'object' ? patch : {}) };
  try {
    fs.mkdirSync(HOOKED_DIR, { recursive: true });
    fs.writeFileSync(SYNC_STATE_FILE(), JSON.stringify(merged, null, 2) + '\n');
  } catch (_) { /* best-effort */ }
  return merged;
}
function dismissRestartNotice() {
  return setGitSyncState({ restartNeeded: false, note: '' });
}

// Exécute une commande git dans `root`, promesse { code, stdout, stderr }. Ne rejette jamais sur un
// code de sortie non nul (git renvoie 1 pour « rien à faire ») — l'appelant décide. execFile → pas
// de shell, args en tableau.
function git(root, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, ...args], { timeout: GIT_TIMEOUT, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
        failed: !!err,
      });
    });
  });
}

// Racine canonique du dépôt du serveur, résolue depuis ROOT via `rev-parse --show-toplevel`
// (gère un ROOT en sous-dossier / les worktrees git). Cachée (module + globalThis pour survivre au
// ré-exécution HMR de Vite). Renvoie null si ROOT n'est pas dans un dépôt git.
let _rootCache; // undefined = non résolu, null = pas de dépôt, string = racine
async function resolveGitRoot() {
  if (_rootCache !== undefined) return _rootCache;
  const r = await git(ROOT, ['rev-parse', '--show-toplevel']);
  _rootCache = r.failed ? null : r.stdout.trim() || null;
  return _rootCache;
}

// État de la branche courante : { root, current, detached, dirty, upstream, ahead, behind }.
async function getGitStatus(root) {
  if (root === undefined) root = await resolveGitRoot();
  if (!root) return { root: null, error: 'not a git repository' };
  const cur = await git(root, ['branch', '--show-current']);
  const current = cur.stdout.trim();
  const detached = current === '';
  const st = await git(root, ['status', '--porcelain']);
  const dirty = st.stdout.trim() !== '';
  const up = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstream = up.failed ? null : up.stdout.trim();
  let ahead = 0, behind = 0;
  if (upstream) {
    // left = commits côté upstream absents en local (behind), right = commits locaux (ahead).
    const c = await git(root, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
    if (!c.failed) {
      const m = c.stdout.trim().split(/\s+/);
      behind = parseInt(m[0], 10) || 0;
      ahead = parseInt(m[1], 10) || 0;
    }
  }
  return { root, current, detached, dirty, upstream, ahead, behind };
}

// Liste des branches sélectionnables : locales (refs/heads) + distantes uniques (refs/remotes, hors
// origin/HEAD, dédupliquées des locales), avec marquage des branches verrouillées dans un autre
// worktree git (non checkout-ables). [{ name, current, remote, locked, worktreePath }].
async function listGitBranches(root) {
  if (root === undefined) root = await resolveGitRoot();
  if (!root) return [];
  const currentRes = await git(root, ['branch', '--show-current']);
  const current = currentRes.stdout.trim();

  // Branches verrouillées dans un autre worktree → { branchShort: worktreePath }.
  const locked = new Map();
  const wt = await git(root, ['worktree', 'list', '--porcelain']);
  if (!wt.failed) {
    let curPath = '';
    for (const line of wt.stdout.split('\n')) {
      if (line.startsWith('worktree ')) curPath = line.slice('worktree '.length).trim();
      else if (line.startsWith('branch ')) {
        const short = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
        if (short && short !== current) locked.set(short, curPath);
      }
    }
  }

  const out = [];
  const seen = new Set();
  const locals = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  for (const name of locals.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    seen.add(name);
    out.push({ name, current: name === current, remote: false, locked: locked.has(name), worktreePath: locked.get(name) || null });
  }
  const remotes = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
  for (const ref of remotes.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (/\/HEAD$/.test(ref)) continue;               // origin/HEAD → ignoré
    const short = ref.replace(/^[^/]+\//, '');        // origin/foo → foo
    if (seen.has(short)) continue;                     // déjà une locale du même nom
    seen.add(short);
    out.push({ name: short, current: false, remote: true, ref, locked: false, worktreePath: null });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Checkout d'une branche. strategy ∈ 'block' (défaut) | 'stash' | 'force'.
//  - block : refuse si l'arbre est sale → { ok:false, dirty:true } (signal UI pour les boutons override).
//  - stash : `git stash push -u` puis checkout, stash CONSERVÉ (récupérable).
//  - force : `git checkout -f` → jette les modifs locales (demandé explicitement).
// Un checkout d'une branche distante-only crée automatiquement une branche de suivi (DWIM).
async function checkoutGitBranch(branch, strategy = 'block', root) {
  if (root === undefined) root = await resolveGitRoot();
  if (!root) return { ok: false, error: 'not a git repository' };
  if (!isValidBranchName(branch)) return { ok: false, error: 'invalid branch name' };
  if (!['block', 'stash', 'force'].includes(strategy)) strategy = 'block';

  const status = await getGitStatus(root);
  if (status.current === branch) return { ok: true, status, note: 'already on branch' };

  // Verrou worktree : refus clair (git le refuserait de toute façon).
  const branches = await listGitBranches(root);
  const locked = branches.find((b) => b.name === branch && b.locked);
  if (locked) return { ok: false, error: `branch '${branch}' is checked out in another worktree (${locked.worktreePath})` };

  let stashRef = null;
  if (status.dirty && strategy === 'block') {
    return { ok: false, dirty: true, error: 'working tree has uncommitted changes' };
  }
  if (status.dirty && strategy === 'stash') {
    const s = await git(root, ['stash', 'push', '-u', '-m', `hooked: before checkout ${branch}`]);
    if (s.failed) return { ok: false, error: 'git stash failed: ' + (s.stderr.trim() || s.stdout.trim()) };
    const list = await git(root, ['stash', 'list']);
    stashRef = (list.stdout.split('\n')[0] || '').split(':')[0] || 'stash@{0}';
  }

  const args = strategy === 'force' ? ['checkout', '-f', branch] : ['checkout', branch];
  const co = await git(root, args);
  if (co.failed) return { ok: false, error: 'git checkout failed: ' + (co.stderr.trim() || co.stdout.trim()), stashRef };

  const fresh = await getGitStatus(root);
  return { ok: true, status: fresh, stashRef };
}

// ─── Boucle de fond fetch + pull --ff-only ──────────────────────────────────────────────────────

// Hash SHA du contenu de package-lock.json à un commit donné (ou null). Sert à détecter un
// changement de dépendances après un pull → auto-restart / notice.
async function lockChangedBetween(root, oldRef, newRef) {
  const d = await git(root, ['diff', '--name-only', oldRef, newRef]);
  if (d.failed) return false;
  return d.stdout.split('\n').map((s) => s.trim()).includes('package-lock.json');
}

// Redémarrage best-effort du service (log clair). Utilisé après un pull qui change package-lock.json
// quand gitAutoRestartOnLock est activé → run-dev.sh relancera `npm ci` au boot.
function triggerRestart() {
  const done = (err) => {
    if (err) console.warn('[hooked] git-sync: restart command failed:', err.message || err);
    else console.log('[hooked] git-sync: restart command issued.');
  };
  try {
    if (RESTART_CMD_ENV) execFile('sh', ['-c', RESTART_CMD_ENV], { timeout: 15000 }, done);
    else execFile(DEFAULT_RESTART_ARGV[0], DEFAULT_RESTART_ARGV[1], { timeout: 15000 }, done);
  } catch (e) { done(e); }
}

// Une itération de la boucle : fetch, puis pull --ff-only UNIQUEMENT si l'arbre est propre ET la
// branche est en retard sur un upstream fast-forwardable (behind>0 && ahead==0). Jamais destructif.
// `settings` porte gitAutoRestartOnLock / gitRestartNotice. Ne jette jamais.
async function gitSyncTick(settings, root) {
  try {
    if (root === undefined) root = await resolveGitRoot();
    if (!root) return { skipped: 'no-repo' };
    await git(root, ['fetch', '--prune']);
    const status = await getGitStatus(root);
    if (status.dirty) return { skipped: 'dirty' };          // fetch only, jamais pull
    if (!status.upstream) return { skipped: 'no-upstream' };
    if (!(status.behind > 0 && status.ahead === 0)) return { skipped: 'not-ff' };

    const before = await git(root, ['rev-parse', 'HEAD']);
    const pull = await git(root, ['pull', '--ff-only']);
    if (pull.failed) return { skipped: 'pull-failed', error: pull.stderr.trim() };
    const after = await git(root, ['rev-parse', 'HEAD']);
    setGitSyncState({ lastPullAt: Date.now() });

    const lockChanged = await lockChangedBetween(root, before.stdout.trim(), after.stdout.trim());
    if (lockChanged) {
      const s = settings || {};
      if (s.gitAutoRestartOnLock) {
        setGitSyncState({ restartNeeded: false, note: 'auto-restarted for dependency update', lastRestartAt: Date.now() });
        console.log('[hooked] git-sync: package-lock.json changed → triggering restart.');
        triggerRestart();
      } else if (s.gitRestartNotice) {
        setGitSyncState({ restartNeeded: true, note: 'package-lock.json changed — restart to install deps' });
        console.log('[hooked] git-sync: package-lock.json changed → restart needed (notice set).');
      } else {
        console.log('[hooked] git-sync: package-lock.json changed (no auto-restart, no notice).');
      }
    }
    return { pulled: true, lockChanged };
  } catch (e) {
    console.warn('[hooked] git-sync tick error:', e && e.message ? e.message : e);
    return { error: String(e) };
  }
}

// Singleton de la boucle, gardé sur globalThis pour survivre au ré-exécution HMR de Vite (évite les
// timers dupliqués). Porte le timer et le dernier `settings` connu (rafraîchi à chaque toggle).
function syncHandle() {
  if (!globalThis.__hookedGitSync) globalThis.__hookedGitSync = { timer: null, settings: null };
  return globalThis.__hookedGitSync;
}
function startGitSync(settings) {
  const h = syncHandle();
  h.settings = settings || h.settings;
  if (h.timer) return;
  console.log(`[hooked] git-sync: starting (every ${Math.round(SYNC_INTERVAL / 1000)}s).`);
  const run = () => { gitSyncTick(syncHandle().settings); };
  run();                                   // 1er passage immédiat
  h.timer = setInterval(run, SYNC_INTERVAL);
  if (h.timer.unref) h.timer.unref();      // ne bloque pas la sortie du process
}
function stopGitSync() {
  const h = syncHandle();
  if (h.timer) { clearInterval(h.timer); h.timer = null; console.log('[hooked] git-sync: stopped.'); }
}
// Idempotent : (dé)marre la boucle selon settings.autoGitSync ; met à jour les settings du tick.
function applyGitSyncSetting(settings) {
  const h = syncHandle();
  h.settings = settings || h.settings;
  if (settings && settings.autoGitSync) startGitSync(settings);
  else stopGitSync();
}

export {
  isValidBranchName,
  resolveGitRoot,
  getGitStatus,
  listGitBranches,
  checkoutGitBranch,
  gitSyncTick,
  startGitSync,
  stopGitSync,
  applyGitSyncSetting,
  readGitSyncState,
  setGitSyncState,
  dismissRestartNotice,
};
