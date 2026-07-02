/*
 * Réglages persistants de hooked (à distinguer des prefs par-navigateur en localStorage :
 * thème, prefs terminal…). Stockés côté serveur dans un unique JSON (settings.json de
 * HOOKED_DIR) → partagés entre tous les navigateurs ET lisibles par le back (ex. la commande
 * shell initiale d'un nouveau pane terminal, exécutée par tmux côté serveur).
 *
 * Volontairement minimal : une liste blanche de clés connues avec valeurs par défaut. On
 * ajoutera des réglages au fil des besoins — chaque nouvelle clé se déclare dans DEFAULTS +
 * sa validation dans sanitize().
 */
import fs from 'node:fs';
import path from 'node:path';
import { HOOKED_DIR } from './config.js';

const SETTINGS_FILE = path.join(HOOKED_DIR, 'settings.json');

// Sous-onglets du détail de session, dans l'ordre d'affichage par défaut. Le 1er onglet
// *disponible* de cette liste est celui ouvert à l'arrivée sur une session. Sert de source
// de vérité pour valider `subtabOrder` (toute clé inconnue est ignorée, toute clé manquante
// est ré-ajoutée à la fin → l'ordre reste toujours complet).
const SUBTAB_KEYS = ['chat', 'changes', 'todos', 'subagents', 'background', 'terminal'];

// Éléments de la barre de statut de session (en-tête du détail). Chaque clé est un booléen
// (true = affiché). Toute clé absente du fichier de config est traitée comme true (forward-compatible).
const STATUS_BAR_KEYS = [
  'branch',         // branche git
  'stateBadge',     // badge d'état (working / waiting / ended…)
  'permissionMode', // contrôle du mode de permission (Normal / Auto-edits / Plan)
  'modelEffort',    // contrôle modèle + effort
  'cost',           // coût (session + sous-agents)
  'prompts',        // nombre de prompts
  'tokens',         // compteurs de tokens (output + cache)
  'model',          // nom du modèle (affiché quand la session est terminée)
  'usage5h',        // indicateur d'utilisation 5 h
  'prLinks',        // liens PR
  'focusBtn',       // bouton Focus (menu ⋯)
];

const DEFAULTS = {
  subtabOrder: [...SUBTAB_KEYS],
  // Commande lancée automatiquement à l'ouverture d'un nouveau pane terminal (bouton « ＋ »).
  // Vide = shell nu. Ex. « source .venv/bin/activate », « tmux clock-mode »…
  initialShellCommand: '',
  // Synchro git du dépôt du serveur (cf. server/gitOps.js) : boucle de fond fetch + pull --ff-only.
  autoGitSync: false,
  // Après un pull qui change package-lock.json : redémarrer le service (→ run-dev.sh relance npm ci).
  gitAutoRestartOnLock: false,
  // Afficher la bannière « redémarrage nécessaire / effectué » dans l'UI (indépendant de l'auto-restart).
  gitRestartNotice: true,
  // Visibilité des éléments de la barre de statut (en-tête du détail de session). Tout à true par défaut.
  statusBar: Object.fromEntries(STATUS_BAR_KEYS.map((k) => [k, true])),
};

// Ramène un objet arbitraire (fichier ou payload client) à des valeurs sûres et complètes.
function sanitize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  // subtabOrder : garder les clés connues dans l'ordre fourni (sans doublon), puis compléter.
  let order = Array.isArray(o.subtabOrder) ? o.subtabOrder.filter((k) => SUBTAB_KEYS.includes(k)) : [];
  order = [...new Set(order)];
  for (const k of SUBTAB_KEYS) if (!order.includes(k)) order.push(k);
  // initialShellCommand : chaîne, bornée (anti-abus ; jamais interpolée dans un shell — tapée
  // au clavier via send-keys -l par showInPane).
  const cmd = typeof o.initialShellCommand === 'string' ? o.initialShellCommand.slice(0, 500) : '';
  // statusBar : objet key→boolean. Toute clé absente (config antérieure) = true par défaut.
  const rawSb = o.statusBar && typeof o.statusBar === 'object' ? o.statusBar : {};
  const statusBar = Object.fromEntries(STATUS_BAR_KEYS.map((k) => [k, rawSb[k] !== false]));
  return {
    subtabOrder: order,
    initialShellCommand: cmd,
    autoGitSync: !!o.autoGitSync,
    gitAutoRestartOnLock: !!o.gitAutoRestartOnLock,
    // Défaut à true : une config antérieure à cette clé ne doit pas la forcer à false.
    gitRestartNotice: o.gitRestartNotice === undefined ? true : !!o.gitRestartNotice,
    statusBar,
  };
}

// Lit les réglages (défauts si le fichier est absent/illisible). Pas de cache : lecture directe
// à chaque appel — le fichier est minuscule et rarement lu (au chargement de page + création de pane).
function readSettings() {
  try {
    return sanitize(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
  } catch (_) {
    return { ...DEFAULTS };
  }
}

// Fusionne un patch partiel avec les réglages courants, valide, écrit, renvoie le résultat complet.
function writeSettings(patch) {
  const merged = sanitize({ ...readSettings(), ...(patch && typeof patch === 'object' ? patch : {}) });
  try {
    fs.mkdirSync(HOOKED_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2) + '\n');
  } catch (e) {
    throw new Error('settings.json write failed: ' + (e.message || e));
  }
  return merged;
}

export { SETTINGS_FILE, SUBTAB_KEYS, STATUS_BAR_KEYS, DEFAULTS as SETTINGS_DEFAULTS, readSettings, writeSettings };
