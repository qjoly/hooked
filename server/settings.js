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
import { HOOKED_DIR, LAUNCH_PERMISSION_MODES } from './config.js';

const SETTINGS_FILE = path.join(HOOKED_DIR, 'settings.json');

// Sous-onglets du détail de session, dans l'ordre d'affichage par défaut. Le 1er onglet
// *disponible* de cette liste est celui ouvert à l'arrivée sur une session. Sert de source
// de vérité pour valider `subtabOrder` (toute clé inconnue est ignorée, toute clé manquante
// est ré-ajoutée à la fin → l'ordre reste toujours complet).
const SUBTAB_KEYS = ['chat', 'changes', 'todos', 'subagents', 'subsessions', 'background', 'terminal', 'pr', 'issues'];

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
  'issueLinks',     // liens d'issue GitHub
  'focusBtn',       // bouton Focus (menu ⋯)
];

// Éléments de la barre de statut masqués par défaut (leur onglet dédié est le lieu principal).
const STATUS_BAR_HIDDEN_DEFAULT = new Set(['prLinks', 'issueLinks']);

const DEFAULTS = {
  subtabOrder: [...SUBTAB_KEYS],
  // Ordre d'affichage des éléments de la barre de statut (analogue à subtabOrder ; réorganisable
  // via les flèches ▲/▼ des réglages). Défaut : l'ordre de déclaration de STATUS_BAR_KEYS.
  statusBarOrder: [...STATUS_BAR_KEYS],
  // Sous-onglets masqués manuellement (bouton œil dans les réglages). Sous-ensemble de SUBTAB_KEYS ;
  // 'chat' n'est jamais masquable (vue principale). Défaut : aucun masqué. Distinct de l'auto-masquage
  // d'un onglet vide (géré côté client selon le contenu de la session).
  subtabHidden: [],
  // Commande lancée automatiquement à l'ouverture d'un nouveau pane terminal (bouton « ＋ »).
  // Vide = shell nu. Ex. « source .venv/bin/activate », « tmux clock-mode »…
  initialShellCommand: '',
  // Synchro git du dépôt du serveur (cf. server/gitOps.js) : boucle de fond fetch + pull --ff-only.
  autoGitSync: false,
  // Après un pull qui change package-lock.json : redémarrer le service (→ run-dev.sh relance npm ci).
  gitAutoRestartOnLock: false,
  // Afficher la bannière « redémarrage nécessaire / effectué » dans l'UI (indépendant de l'auto-restart).
  gitRestartNotice: true,
  // Défauts pré-sélectionnés au lancement/à la reprise d'une session (formulaires Nouvelle session
  // et Resume). Chaîne vide = « hériter » : on retombe sur la config Claude Code de l'utilisateur
  // (~/.claude, cf. readClaudeDefaults) puis sur le défaut du sélecteur. defaultMode '' = hériter ;
  // 'default' = mode Normal explicite (aucun flag). Validés à l'écriture ; le lancement re-valide.
  defaultModel: '',
  defaultEffort: '',
  defaultMode: '',
  // Projet par défaut (cwd absolu) utilisé quand une session est lancée sans cwd — p.ex. depuis
  // un raccourci macOS (Quick Action) qui POST /api/launch avec seulement un prompt. '' = aucun ;
  // launchSession exige alors un cwd explicite comme avant.
  quickLaunchProject: '',
  // Visibilité des éléments de la barre de statut (en-tête du détail de session). Tout à true par
  // défaut sauf prLinks / issueLinks (false : les onglets dédiés PR/Issues sont le lieu principal ;
  // chips masqués par défaut).
  statusBar: Object.fromEntries(STATUS_BAR_KEYS.map((k) => [k, !STATUS_BAR_HIDDEN_DEFAULT.has(k)])),
};

// Ramène un objet arbitraire (fichier ou payload client) à des valeurs sûres et complètes.
function sanitize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  // subtabOrder : garder les clés connues dans l'ordre fourni (sans doublon), puis compléter.
  let order = Array.isArray(o.subtabOrder) ? o.subtabOrder.filter((k) => SUBTAB_KEYS.includes(k)) : [];
  order = [...new Set(order)];
  for (const k of SUBTAB_KEYS) if (!order.includes(k)) order.push(k);
  // statusBarOrder : même traitement que subtabOrder (garder connues dans l'ordre, dédupe, compléter).
  let sbOrder = Array.isArray(o.statusBarOrder) ? o.statusBarOrder.filter((k) => STATUS_BAR_KEYS.includes(k)) : [];
  sbOrder = [...new Set(sbOrder)];
  for (const k of STATUS_BAR_KEYS) if (!sbOrder.includes(k)) sbOrder.push(k);
  // subtabHidden : sous-ensemble des clés connues, jamais 'chat' (vue principale, toujours visible).
  let hidden = Array.isArray(o.subtabHidden) ? o.subtabHidden.filter((k) => SUBTAB_KEYS.includes(k) && k !== 'chat') : [];
  hidden = [...new Set(hidden)];
  // initialShellCommand : chaîne, bornée (anti-abus ; jamais interpolée dans un shell — tapée
  // au clavier via send-keys -l par showInPane).
  const cmd = typeof o.initialShellCommand === 'string' ? o.initialShellCommand.slice(0, 500) : '';
  // statusBar : objet key→boolean. Toute clé absente = true par défaut, sauf prLinks / issueLinks
  // (false : les onglets dédiés sont le lieu principal ; chips masqués pour éviter le double affichage).
  const rawSb = o.statusBar && typeof o.statusBar === 'object' ? o.statusBar : {};
  const statusBar = Object.fromEntries(STATUS_BAR_KEYS.map((k) => {
    if (rawSb[k] !== undefined) return [k, rawSb[k] !== false];
    return [k, !STATUS_BAR_HIDDEN_DEFAULT.has(k)]; // absent → défaut (prLinks/issueLinks → false)
  }));
  // Défauts de session : '' (hériter) autorisé. Modèle → charset de --model ; effort → alpha ;
  // mode → liste blanche du lancement. Tout inconnu retombe sur '' (hériter).
  const defaultModel = typeof o.defaultModel === 'string' && /^[a-z0-9-]{1,60}$/i.test(o.defaultModel) ? o.defaultModel : '';
  const defaultEffort = typeof o.defaultEffort === 'string' && /^[a-z]{1,20}$/.test(o.defaultEffort) ? o.defaultEffort : '';
  const defaultMode = LAUNCH_PERMISSION_MODES.includes(o.defaultMode) ? o.defaultMode : '';
  // quickLaunchProject : chemin absolu ou '' (aucun). L'existence du dossier n'est PAS vérifiée ici
  // (le disque peut varier dans le temps) — launchSession valide le dossier au lancement.
  const quickLaunchProject =
    typeof o.quickLaunchProject === 'string' && o.quickLaunchProject.startsWith('/')
      ? o.quickLaunchProject.slice(0, 4096)
      : '';
  return {
    subtabOrder: order,
    statusBarOrder: sbOrder,
    subtabHidden: hidden,
    initialShellCommand: cmd,
    autoGitSync: !!o.autoGitSync,
    gitAutoRestartOnLock: !!o.gitAutoRestartOnLock,
    // Défaut à true : une config antérieure à cette clé ne doit pas la forcer à false.
    gitRestartNotice: o.gitRestartNotice === undefined ? true : !!o.gitRestartNotice,
    statusBar,
    defaultModel,
    defaultEffort,
    defaultMode,
    quickLaunchProject,
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
