/*
 * Canal d'entrée PERSISTANT vers tmux (tier 2, saisie interactive). Au lieu de spawn un
 * `tmux send-keys` par frappe (~34 ms de création de process client tmux — mesuré, c'est LE coût
 * dominant de la latence de saisie), on garde UN process `tmux -C` (control mode) vivant et on lui
 * écrit les commandes `send-keys` sur stdin : ~0,002 ms par frappe, aucun spawn.
 *
 * Le client control mode est attaché à une SESSION tmux dédiée et cachée (`__hooked_input`), créée
 * en `new-session -A` (attach-or-create, idempotent au redémarrage). Les `send-keys -t %NN` visent
 * n'importe quel pane du MÊME serveur tmux (socket par défaut, comme tout le reste du back) — la
 * session cachée ne sert qu'à tenir le client control mode en vie ; sa taille n'affecte pas les
 * fenêtres des vraies sessions (elle n'y est pas attachée). On ignore complètement le flux stdout
 * de control mode (notifications %…) : la sortie des panes passe déjà par pipe-pane (cf. paneStream).
 */
import { spawn } from 'node:child_process';

// Survit au hot-reload (Vite SSR/HMR) : un seul canal pour tout le process.
const g = globalThis;
const state = (g.__hookedInputCtl ??= { proc: null });

const HIDDEN_SESSION = '__hooked_input';

// Démarre (ou récupère) le process control mode. stdout/stderr → 'ignore' : control mode écrit des
// notifications en continu ; sans lecteur, un pipe se remplirait et bloquerait tmux → on l'envoie
// à /dev/null. `-A` : réutilise la session cachée si elle existe déjà (redémarrage serveur).
function ensureProc() {
  if (state.proc && !state.proc.killed) return state.proc;
  let proc;
  try {
    proc = spawn('tmux', ['-C', 'new-session', '-A', '-s', HIDDEN_SESSION, '-x', '80', '-y', '24'], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  } catch (_) { state.proc = null; return null; }
  proc.on('exit', () => { if (state.proc === proc) state.proc = null; });
  proc.on('error', () => { if (state.proc === proc) state.proc = null; });
  if (proc.stdin) proc.stdin.on('error', () => { if (state.proc === proc) state.proc = null; });
  if (proc.unref) proc.unref(); // ne pas retenir le process serveur en vie pour ce canal
  state.proc = proc;
  return proc;
}

// Envoie une frappe (déjà découpée en paires hex) à `pane` via le canal persistant. Renvoie true
// si la commande a été mise en file (ordre préservé : un seul pipe, lu ligne par ligne par tmux),
// false si le canal est indisponible → l'appelant retombe sur un spawn `send-keys` ponctuel.
function sendKeysHex(pane, hex) {
  if (!/^%\d+$/.test(pane || '')) return false;
  if (!Array.isArray(hex) || !hex.length) return false;
  const proc = ensureProc();
  if (!proc || !proc.stdin || !proc.stdin.writable) return false;
  // Une frappe = une ligne send-keys (comme un spawn) → mêmes sémantiques que l'ancien chemin,
  // dont l'Échap isolé que le client envoie déjà seul (désambiguïsation TUI, cf. Terminal.svelte).
  const line = 'send-keys -t ' + pane + ' -H ' + hex.join(' ') + '\n';
  try { proc.stdin.write(line); return true; } catch (_) { return false; }
}

export { sendKeysHex };
