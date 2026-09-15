/*
 * Terminaux shell — des PTY réels, pilotés depuis le navigateur.
 *
 * C'est la réimplémentation de l'onglet Terminal perdu avec tmux, mais réduite à ce qu'on lui
 * demandait vraiment : lancer des commandes. Il ne mirroire PLUS la session Claude — celle-ci vit
 * dans le processus hooked via l'Agent SDK et son fil passe par la conversation, il n'y a plus
 * d'écran à recopier. Un terminal ici est donc un shell ordinaire, ouvert sur le dossier d'un
 * projet, sans aucun lien avec une session Claude (`sessionId` ne sert qu'à l'étiqueter dans l'UI).
 *
 * Pourquoi un PTY et pas un simple `spawn` : sans terminal de contrôle, `isatty()` est faux, les
 * outils désactivent la couleur, `cd` ne persiste pas d'une commande à l'autre et tout ce qui
 * repeint l'écran (vim, htop, less) est hors de portée. node-pty alloue un vrai TTY — c'est ce que
 * tmux fournissait gratuitement avant.
 *
 * SÉCURITÉ : ce module expose un shell arbitraire derrière du HTTP. C'était déjà le cas de l'onglet
 * tmux (`send-keys` acceptait n'importe quelle frappe), et hooked écoute sur 127.0.0.1 par défaut —
 * exposer le dashboard sur le réseau (`HOST=0.0.0.0`) expose donc aussi ces shells. Aucun garde-fou
 * supplémentaire ici serait honnête : un utilisateur qui peut lancer des sessions Claude peut déjà
 * tout faire sur la machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loginEnv, err400 } from './agent.js';

// Registre épinglé sur globalThis, même raison que celui des sessions (server/agent.js) : la
// ré-exécution de module de Vite en `npm run live` repartirait d'un registre vide et laisserait des
// PTY orphelins, invisibles et impossibles à tuer depuis l'UI.
const REGISTRY = Symbol.for('hooked.terminals');
/** @type {Map<string, any>} */
const terms = globalThis[REGISTRY] || (globalThis[REGISTRY] = new Map());

// Tampon de reprise. Un terminal survit au rechargement de la page (il vit dans le processus
// hooked), donc un client qui se (re)connecte doit retrouver l'écran tel qu'il était — sinon on
// « rouvre » un shell vide alors que la commande tourne toujours. On garde les derniers octets
// BRUTS, séquences ANSI comprises : xterm les rejoue et reconstitue l'écran exact.
const SCROLLBACK_BYTES = 256 * 1024;
const MAX_TERMINALS = 8;          // garde-fou : un PTY = un process, on ne les laisse pas proliférer
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

// node-pty est une dépendance NATIVE : sur une plateforme sans prebuild, ou si le `spawn-helper`
// n'est pas exécutable (cf. scripts/fix-node-pty.cjs), l'import échoue. On le charge donc
// paresseusement et on renvoie une erreur parlante plutôt que de faire tomber tout le serveur au
// démarrage pour une fonctionnalité annexe.
let ptyMod = null;
async function loadPty() {
  if (ptyMod) return ptyMod;
  try {
    ptyMod = await import('node-pty');
    return ptyMod;
  } catch (e) {
    throw new Error('node-pty unavailable (native build): ' + ((e && e.message) || e));
  }
}

function statDir(p) {
  try { const s = fs.statSync(p); return s.isDirectory() ? s : null; } catch (_) { return null; }
}

// ── Abonnés (SSE) ────────────────────────────────────────────────────────────────────────────────
// Un terminal peut avoir plusieurs spectateurs (deux onglets, une vue splittée) : chacun reçoit le
// même flux. Contrairement au flux d'une session, on ne coalesce PAS — un terminal doit rendre la
// frappe au caractère, une fenêtre de regroupement se verrait immédiatement à la saisie.
function emit(t, chunk) {
  for (const cb of [...t.subs]) { try { cb(chunk); } catch (_) { t.subs.delete(cb); } }
}

function subscribeTerminal(id, cb) {
  const t = terms.get(id);
  if (!t || typeof cb !== 'function') return () => {};
  t.subs.add(cb);
  return () => t.subs.delete(cb);
}

// Forme sérialisable d'un terminal (jamais l'objet pty ni les abonnés).
function describe(t) {
  return {
    id: t.id, cwd: t.cwd, sessionId: t.sessionId || null, shell: t.shell,
    cols: t.cols, rows: t.rows, startedAt: t.startedAt,
    exited: !!t.exited, exitCode: t.exitCode ?? null,
  };
}

function listTerminals(sessionId) {
  const out = [];
  for (const t of terms.values()) {
    if (sessionId && t.sessionId !== sessionId) continue;
    out.push(describe(t));
  }
  return out.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

function getTerminal(id) {
  const t = id ? terms.get(id) : null;
  return t || null;
}

// Écran courant, pour amorcer un client qui se connecte en cours de route.
function terminalScrollback(id) {
  const t = getTerminal(id);
  return t ? t.buffer : '';
}

// ── Choix du shell ───────────────────────────────────────────────────────────────────────────────

/*
 * Which shell to open, per platform.
 *
 * `$SHELL || '/bin/zsh'` is right on macOS and Linux and wrong on Windows, where the variable is
 * usually unset: the POSIX fallback reached node-pty and came back as a bare `File not found:`,
 * with nothing pointing at the path as the cause. And when Windows DOES set it, it comes from Git
 * Bash and may be an MSYS path (`/usr/bin/bash`) that CreateProcess cannot resolve.
 *
 * So on Windows the variable is honoured only when it names a file that actually exists — someone
 * who set it to Git Bash gets Git Bash — and otherwise a real Windows shell is looked up.
 */
const WINDOWS_SHELLS = ['pwsh.exe', 'powershell.exe'];

function findOnPath(exe, env = process.env) {
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, exe);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch (_) { /* next entry */ }
  }
  return null;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

// Platform and env are parameters so the choice can be exercised from any OS in tests.
function defaultShell(platform = process.platform, env = process.env) {
  const fromEnv = env.SHELL;
  if (platform !== 'win32') return fromEnv || '/bin/zsh';
  if (fromEnv && isFile(fromEnv)) return fromEnv;
  for (const exe of WINDOWS_SHELLS) {
    const found = findOnPath(exe, env);
    if (found) return found;
  }
  return env.COMSPEC || 'cmd.exe';
}

/*
 * `-l -i` sources the user's profile, which is what the old `tmux new-session` gave us for free.
 * Keyed on the shell rather than the platform: Git Bash on Windows still wants them, while cmd
 * would treat them as a command to run and PowerShell as a malformed argument. PowerShell loads
 * the user's profile by itself, so only its banner is worth suppressing.
 */
function shellArgs(shell) {
  // win32.basename splits on both / and \ — the host-flavored path.basename would leave a
  // backslash path whole on POSIX, so the Windows behaviour could not be asserted from macOS.
  const name = path.win32.basename(String(shell)).toLowerCase();
  if (/^(bash|zsh|sh|fish|ksh)(\.exe)?$/.test(name)) return ['-l', '-i'];
  if (/^(pwsh|powershell)(\.exe)?$/.test(name)) return ['-NoLogo'];
  return [];
}

// ── Cycle de vie ─────────────────────────────────────────────────────────────────────────────────

// Ouvre un shell de LOGIN interactif dans `cwd`. `-l -i` pour que le profil de l'utilisateur soit
// sourcé, comme le faisait l'ancien `tmux new-session` — sans ça un terminal ouvert depuis un hooked
// lancé par launchd n'aurait ni les alias ni le PATH de l'utilisateur. On passe en plus l'env résolu
// par loginEnv() (partagé avec les sessions) : le shell le re-calculerait, mais les variables sont
// alors disponibles dès le premier prompt, avant même que le profil ait fini de se charger.
function openTerminal({ cwd, sessionId, cols, rows } = {}, cb) {
  const dir = typeof cwd === 'string' ? cwd : null;
  if (!dir) return cb(err400('cwd required'));
  if (!statDir(dir)) return cb(err400('invalid cwd: ' + dir));
  if (terms.size >= MAX_TERMINALS) return cb(err400(`too many open terminals (max ${MAX_TERMINALS}) — close one first`));

  const c = Number.isInteger(cols) && cols > 0 && cols <= 500 ? cols : DEFAULT_COLS;
  const r = Number.isInteger(rows) && rows > 0 && rows <= 300 ? rows : DEFAULT_ROWS;
  const shell = defaultShell();

  loadPty().then((pty) => loginEnv().then((env) => {
    const id = 'term_' + crypto.randomBytes(6).toString('hex');
    let child;
    try {
      child = pty.spawn(shell, shellArgs(shell), {
        name: 'xterm-256color',   // ce que xterm.js sait rendre côté navigateur
        cols: c, rows: r, cwd: dir,
        env: { ...process.env, ...env, TERM: 'xterm-256color' },
      });
    } catch (e) {
      return cb(new Error('failed to open a terminal: ' + ((e && e.message) || e)));
    }
    const t = {
      id, cwd: dir, sessionId: sessionId || null, shell,
      cols: c, rows: r, startedAt: new Date().toISOString(),
      pty: child, subs: new Set(), buffer: '', exited: false, exitCode: null,
    };
    terms.set(id, t);
    child.onData((chunk) => {
      const s = String(chunk);
      t.buffer = (t.buffer + s).slice(-SCROLLBACK_BYTES);
      emit(t, s);
    });
    child.onExit(({ exitCode }) => {
      t.exited = true;
      t.exitCode = typeof exitCode === 'number' ? exitCode : null;
      // On laisse l'entrée dans le registre : le client doit pouvoir lire l'écran final (le message
      // d'erreur de la dernière commande, typiquement) avant de fermer l'onglet lui-même.
      emit(t, `\r\n\x1b[2m[process exited${t.exitCode != null ? ' \u2014 code ' + t.exitCode : ''}]\x1b[0m\r\n`);
    });
    cb(null, describe(t));
  })).catch((e) => cb(new Error((e && e.message) || String(e))));
}

// Frappes du navigateur → PTY. Volontairement opaque : on transmet les octets tels quels (Ctrl-C,
// flèches, Échap…), c'est le shell et l'application qui les interprètent, pas nous.
function writeTerminal(id, data, cb) {
  const t = getTerminal(id);
  if (!t) return cb(err400('unknown terminal'));
  if (t.exited) return cb(err400('this terminal has exited'));
  if (typeof data !== 'string') return cb(err400('data must be a string'));
  try { t.pty.write(data); } catch (e) { return cb(new Error('write failed: ' + ((e && e.message) || e))); }
  cb(null, { id });
}

// Redimensionne le PTY pour qu'il colle à la place dispo côté web. Sans ça, le shell croit à une
// largeur figée et tout ce qui met en colonnes (`ls`, `git log --graph`, un TUI) est mal coupé.
function resizeTerminal(id, cols, rows, cb) {
  const t = getTerminal(id);
  if (!t) return cb(err400('unknown terminal'));
  if (t.exited) return cb(null, describe(t));
  const c = Number.isInteger(cols) && cols > 0 && cols <= 500 ? cols : t.cols;
  const r = Number.isInteger(rows) && rows > 0 && rows <= 300 ? rows : t.rows;
  if (c === t.cols && r === t.rows) return cb(null, describe(t));
  try { t.pty.resize(c, r); } catch (e) { return cb(new Error('resize failed: ' + ((e && e.message) || e))); }
  t.cols = c; t.rows = r;
  cb(null, describe(t));
}

// Ferme le terminal et le retire du registre. SIGHUP plutôt que SIGKILL : c'est le signal qu'un
// shell reçoit quand son terminal disparaît, donc il nettoie ses jobs comme il le ferait à la
// fermeture d'une fenêtre.
function killTerminal(id, cb) {
  const t = getTerminal(id);
  if (!t) return cb(err400('unknown terminal'));
  try { if (!t.exited) t.pty.kill('SIGHUP'); } catch (_) {}
  for (const cb2 of [...t.subs]) { try { cb2(null); } catch (_) {} } // null = fin de flux
  t.subs.clear();
  terms.delete(id);
  cb(null, { id });
}

// Ferme tous les terminaux d'une session (à sa fin) ou tous, sans distinction.
function closeTerminalsFor(sessionId) {
  let n = 0;
  for (const t of [...terms.values()]) {
    if (sessionId && t.sessionId !== sessionId) continue;
    killTerminal(t.id, () => {});
    n++;
  }
  return n;
}

export {
  openTerminal, writeTerminal, resizeTerminal, killTerminal, closeTerminalsFor,
  subscribeTerminal, listTerminals, getTerminal, terminalScrollback,
  defaultShell, shellArgs,
  MAX_TERMINALS,
};
