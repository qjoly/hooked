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
const ROOT = path.join(__dirname, '..');
// Le front Svelte est buildé dans dist/ (npm run build) — seule source servie.
const PUBLIC_DIR = path.join(ROOT, 'dist');
const PORT = parseInt(process.env.HOOKED_PORT || '4123', 10);

const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

module.exports = { HOME, PROJECTS_DIR, HOOKED_DIR, EVENTS_FILE, LAUNCHES_FILE, PUBLIC_DIR, PORT, MODELS, EFFORTS };
