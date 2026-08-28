/*
 * Configuration & chemins. Les dossiers de données sont surchargeables par env
 * (utile pour les tests : on pointe sur des fixtures). Par défaut : ~/.claude.
 *   HOOKED_PROJECTS_DIR  → transcripts (défaut ~/.claude/projects)
 *   HOOKED_DATA_DIR      → events.jsonl / launches.jsonl (défaut ~/.claude/hooked)
 *   HOOKED_PORT          → port HTTP (défaut 4123)
 *   HOOKED_CLAUDE_JSON   → config globale Claude Code (défaut ~/.claude.json)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const PROJECTS_DIR = process.env.HOOKED_PROJECTS_DIR || path.join(HOME, '.claude', 'projects');
const HOOKED_DIR = process.env.HOOKED_DATA_DIR || path.join(HOME, '.claude', 'hooked');
const EVENTS_FILE = path.join(HOOKED_DIR, 'events.jsonl');
// journal des lancements faits par hooked (cwd, modèle, effort, worktree), pour l'historique.
const LAUNCHES_FILE = path.join(HOOKED_DIR, 'launches.jsonl');
// résolution persistée session_id (claude) → modèle/effort : garde l'effort et le modèle affichés
// même après la fin de la session (le registre en mémoire, lui, ne survit pas au processus).
const SESSION_LAUNCH_FILE = path.join(HOOKED_DIR, 'session-launch.jsonl');
// snapshots de la statusline Claude Code (déposés par statusline-command.sh) : un fichier
// JSON par session, contenant les *vraies* infos du compte (effort, rate limits, contexte).
const STATUS_DIR = path.join(HOOKED_DIR, 'status');
// Claude Code's global config (~/.claude.json). Carries `cachedUsageUtilization`, the account
// quota cache the CLI refreshes: the only local source for *model-scoped* buckets (e.g. the
// weekly Fable limit), which the statusline payload does not expose (5h / 7d only).
const CLAUDE_JSON = process.env.HOOKED_CLAUDE_JSON
  || path.join(process.env.CLAUDE_CONFIG_DIR || HOME, '.claude.json');
const ROOT = path.join(import.meta.dirname, '..');
// Le front Svelte est buildé dans dist/ (npm run build) — seule source servie.
const PUBLIC_DIR = path.join(ROOT, 'dist');
const PORT = parseInt(process.env.HOOKED_PORT || '4123', 10);

// Argument `--model` accepté : alias de famille (`opus`) ou version explicite (`opus-4-7`).
// Regex stricte : garde-fou contre une valeur inconnue passée à l'Agent SDK (`model` / `setModel`).
// La *liste* des modèles/efforts proposés n'est plus figée ici : elle est dérivée du binaire claude
// (cf. server/capabilities.js).
const MODEL_ARG_RE = /^(claude-)?(opus|sonnet|haiku|fable)(-\d+(-\d+)?)?$/;
const isValidModelArg = (m) => typeof m === 'string' && MODEL_ARG_RE.test(m);

// Modes de permission Claude Code proposés au sélecteur (liste blanche des cibles). Le changement
// est une requête de contrôle de l'Agent SDK (cf. agent.setMode → Query.setPermissionMode) : plus
// besoin de cycler au clavier ni de relire le footer du TUI pour vérifier qu'on est arrivé.
const PERMISSION_MODES = ['default', 'auto', 'plan'];

// Modes valides au LANCEMENT d'une session (option `permissionMode` de l'Agent SDK) — sur-ensemble
// du cycle live ci-dessus. Liste blanche stricte : garde-fou contre une valeur inconnue.
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

export { HOME, PROJECTS_DIR, HOOKED_DIR, EVENTS_FILE, LAUNCHES_FILE, SESSION_LAUNCH_FILE, STATUS_DIR, CLAUDE_JSON, ROOT, PUBLIC_DIR, PORT, PERMISSION_MODES, LAUNCH_PERMISSION_MODES, isValidModelArg, readClaudeDefaults };
