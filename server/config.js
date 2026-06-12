'use strict';
/*
 * Configuration & chemins. Les dossiers de données sont surchargeables par env
 * (utile pour les tests : on pointe sur des fixtures). Par défaut : ~/.claude.
 *   HOOKED_PROJECTS_DIR  → transcripts (défaut ~/.claude/projects)
 *   HOOKED_DATA_DIR      → events.jsonl / launches.jsonl (défaut ~/.claude/hooked)
 *   HOOKED_PORT          → port HTTP (défaut 4123)
 */
const path = require('path');
const os = require('os');

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
const ROOT = path.join(__dirname, '..');
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
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

module.exports = { HOME, PROJECTS_DIR, HOOKED_DIR, EVENTS_FILE, LAUNCHES_FILE, SESSION_LAUNCH_FILE, STATUS_DIR, PUBLIC_DIR, PORT, SESSION_BUDGET, SESSION_HOURS, MODELS, EFFORTS };
