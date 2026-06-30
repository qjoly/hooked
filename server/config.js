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
// snapshots de la statusline Claude Code (déposés par statusline-command.sh) : un fichier
// JSON par session, contenant les *vraies* infos du compte (effort, rate limits, contexte).
const STATUS_DIR = path.join(HOOKED_DIR, 'status');
const ROOT = path.join(import.meta.dirname, '..');
// Le front Svelte est buildé dans dist/ (npm run build) — seule source servie.
const PUBLIC_DIR = path.join(ROOT, 'dist');
const PORT = parseInt(process.env.HOOKED_PORT || '4123', 10);
// budget de référence ($) pour la fenêtre de session de 5 h → sert de dénominateur à la
// barre de progression « limite de session ». Le plafond réel d'abonnement n'étant pas
// exposé par Anthropic (et variant selon le plan), on l'estime via le coût et on le rend
// configurable. HOOKED_SESSION_BUDGET pour l'ajuster à son plan.
const SESSION_BUDGET = parseFloat(process.env.HOOKED_SESSION_BUDGET || '40') || 40;
const SESSION_HOURS = 5;

const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
// Argument `--model` accepté : alias de famille (`opus`) ou version explicite (`opus-4-7`).
// Regex stricte (anti-injection) : la valeur est interpolée dans une commande shell par
// launchSession et tapée dans `/model <name>` par setModelEffort.
const MODEL_ARG_RE = /^(opus|sonnet|haiku|fable)(-\d{1,2}(-\d{1,2})?)?$/;
const isValidModelArg = (m) => typeof m === 'string' && MODEL_ARG_RE.test(m);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Modes de permission Claude Code proposés au sélecteur (liste blanche des cibles).
// Le changement se fait en boucle fermée (cf. tmux.setMode) : on lit le mode affiché dans
// le footer du TUI et on envoie des Maj+Tab jusqu'à atteindre la cible — l'ordre du cycle
// réel (default → acceptEdits → plan → auto → …) n'a donc pas à être encodé ici.
const PERMISSION_MODES = ['default', 'auto', 'plan'];

// Modes valides pour `claude --permission-mode <mode>` au LANCEMENT d'une session (≠ cycle
// live ci-dessus, qui passe par des Maj+Tab). Liste blanche stricte : garde anti-injection
// shell ET garde-fou contre une valeur inconnue. Source : `claude --help`.
const LAUNCH_PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions', 'dontAsk'];

// Défauts modèle/effort lus depuis la config Claude Code de l'utilisateur (~/.claude), à
// chaque appel (pas de cache) : si l'utilisateur change son défaut dans Claude Code, le
// sélecteur « Nouvelle session » de hooked le reflète sans redémarrage. settings.local.json
// surcharge settings.json (même ordre de priorité que Claude Code). Clés lues : `model` et
// `effortLevel`. On valide contre les listes blanches ; tout inconnu retombe sur opus/high.
function readClaudeDefaults() {
  let model = null, effort = null;
  for (const f of ['settings.json', 'settings.local.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', f), 'utf8'));
      if (j && typeof j.model === 'string') model = j.model;
      if (j && typeof j.effortLevel === 'string') effort = j.effortLevel;
    } catch (_) {}
  }
  // Si Claude Code stocke l'ID complet (`claude-opus-4-7`), on retire le préfixe pour obtenir
  // une valeur acceptée par `--model`. Inconnu → fallback opus.
  const normalized = typeof model === 'string' ? model.replace(/^claude-/, '').toLowerCase() : '';
  return {
    model: isValidModelArg(normalized) ? normalized : 'opus',
    effort: EFFORTS.includes(effort) ? effort : 'high',
  };
}

export { HOME, PROJECTS_DIR, HOOKED_DIR, EVENTS_FILE, LAUNCHES_FILE, SESSION_LAUNCH_FILE, STATUS_DIR, PUBLIC_DIR, PORT, SESSION_BUDGET, SESSION_HOURS, MODELS, EFFORTS, PERMISSION_MODES, LAUNCH_PERMISSION_MODES, isValidModelArg, readClaudeDefaults };
