/*
 * Configuration & chemins. Les dossiers de données sont surchargeables par env
 * (utile pour les tests : on pointe sur des fixtures). Par défaut : ~/.claude.
 *   HOOKED_PROJECTS_DIR  → transcripts (défaut ~/.claude/projects)
 *   HOOKED_DATA_DIR      → events.jsonl / launches.jsonl (défaut ~/.claude/hooked)
 *   HOOKED_PORT          → port HTTP (défaut 4123)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const PROJECTS_DIR = process.env.HOOKED_PROJECTS_DIR || path.join(HOME, '.claude', 'projects');
const HOOKED_DIR = process.env.HOOKED_DATA_DIR || path.join(HOME, '.claude', 'hooked');
const EVENTS_FILE = path.join(HOOKED_DIR, 'events.jsonl');
// config (modèle/effort) des sessions lancées par hooked, indexée par nom de session tmux
const LAUNCHES_FILE = path.join(HOOKED_DIR, 'launches.jsonl');
// résolution persistée session_id (claude) → modèle/effort : permet de garder l'effort
// affiché même après la mort du pane tmux (la résolution live pane→nom n'est plus possible).
const SESSION_LAUNCH_FILE = path.join(HOOKED_DIR, 'session-launch.jsonl');
// panes tmux « show » ouverts par un agent (via MCP show_in_pane) pour une session : un agent
// lance une commande dans un nouveau pane/fenêtre du tmux de la session, qu'on mémorise ici
// pour le mirroir lecture seule de l'UI (onglet Terminal). Indexé par session_id.
const SHOWN_PANES_FILE = path.join(HOOKED_DIR, 'panes.jsonl');
// snapshots de la statusline Claude Code (déposés par statusline-command.sh) : un fichier
// JSON par session, contenant les *vraies* infos du compte (effort, rate limits, contexte).
const STATUS_DIR = path.join(HOOKED_DIR, 'status');
const ROOT = path.join(import.meta.dirname, '..');
// Le front Svelte est buildé dans dist/ (npm run build) — seule source servie.
const PUBLIC_DIR = path.join(ROOT, 'dist');
const PORT = parseInt(process.env.HOOKED_PORT || '4123', 10);

// Argument `--model` accepté : alias de famille (`opus`) ou version explicite (`opus-4-7`).
// Regex stricte (anti-injection) : la valeur est interpolée dans une commande shell par
// launchSession et tapée dans `/model <name>` par setModelEffort. La *liste* des modèles/efforts
// proposés n'est plus figée ici : elle est dérivée du binaire claude (cf. server/capabilities.js).
const MODEL_ARG_RE = /^(claude-)?(opus|sonnet|haiku|fable)(-\d+(-\d+)?)?$/;
const isValidModelArg = (m) => typeof m === 'string' && MODEL_ARG_RE.test(m);

// Modes de permission Claude Code proposés au sélecteur (liste blanche des cibles).
// Le changement se fait en boucle fermée (cf. tmux.setMode) : on lit le mode affiché dans
// le footer du TUI et on envoie des Maj+Tab jusqu'à atteindre la cible — l'ordre du cycle
// réel (default → acceptEdits → plan → auto → …) n'a donc pas à être encodé ici.
const PERMISSION_MODES = ['default', 'auto', 'plan'];

// Modes valides pour `claude --permission-mode <mode>` au LANCEMENT d'une session (≠ cycle
// live ci-dessus, qui passe par des Maj+Tab). Liste blanche stricte : garde anti-injection
// shell ET garde-fou contre une valeur inconnue. Source : `claude --help`.
const LAUNCH_PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions', 'dontAsk'];

// Défauts modèle/effort/mode lus depuis la config Claude Code de l'utilisateur (~/.claude), à
// chaque appel (pas de cache) : si l'utilisateur change son défaut dans Claude Code, le
// sélecteur « Nouvelle session » de hooked le reflète sans redémarrage. settings.local.json
// surcharge settings.json (même ordre de priorité que Claude Code). Clés lues : `model`,
// `effortLevel` et `permissions.defaultMode`. On valide contre les listes blanches ; tout
// inconnu retombe sur opus/high/default.
function readClaudeDefaults() {
  let model = null, effort = null, mode = null;
  for (const f of ['settings.json', 'settings.local.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', f), 'utf8'));
      if (j && typeof j.model === 'string') model = j.model;
      if (j && typeof j.effortLevel === 'string') effort = j.effortLevel;
      if (j && j.permissions && typeof j.permissions.defaultMode === 'string') mode = j.permissions.defaultMode;
    } catch (_) { }
  }
  // Si Claude Code stocke l'ID complet (`claude-opus-4-7`), on retire le préfixe pour obtenir
  // une valeur acceptée par `--model`. Inconnu → fallback opus.
  const normalized = typeof model === 'string' ? model.toLowerCase() : '';
  return {
    model: isValidModelArg(normalized) ? normalized : 'opus',
    // effort : valeur libre de la config utilisateur (validée par charset, pas contre une liste
    // figée) ; le vrai contrôle contre les efforts dispos se fait au lancement (cf. isValidEffort).
    effort: (typeof effort === 'string' && /^[a-z]+$/.test(effort)) ? effort : 'high',
    mode: LAUNCH_PERMISSION_MODES.includes(mode) ? mode : 'default',
  };
}

export { HOME, PROJECTS_DIR, HOOKED_DIR, EVENTS_FILE, LAUNCHES_FILE, SESSION_LAUNCH_FILE, SHOWN_PANES_FILE, STATUS_DIR, ROOT, PUBLIC_DIR, PORT, PERMISSION_MODES, LAUNCH_PERMISSION_MODES, isValidModelArg, readClaudeDefaults };
