/*
 * Réglages persistants de hooked (à distinguer des prefs par-navigateur en localStorage :
 * thème, largeurs de panneaux…). Stockés côté serveur dans un unique JSON (settings.json de
 * HOOKED_DIR) → partagés entre tous les navigateurs ET lisibles par le back.
 *
 * Volontairement minimal : une liste blanche de clés connues avec valeurs par défaut. On
 * ajoutera des réglages au fil des besoins — chaque nouvelle clé se déclare dans DEFAULTS +
 * sa validation dans sanitize().
 */
import fs from 'node:fs';
import path from 'node:path';
import { HOOKED_DIR, LAUNCH_PERMISSION_MODES, isValidModelArg } from './config.js';
import { EDITOR_KEYS, DEFAULT_EDITOR } from '../src/lib/editors.js';
import { DEFAULT_HIDDEN_MODELS, isHideableModel } from '../src/lib/models.js';

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
  // Synchro git du dépôt du serveur (cf. server/gitOps.js) : boucle de fond fetch + pull --ff-only.
  autoGitSync: false,
  // Boucle de fond (cf. server/prReviewTags.js) : tague une session `pr-approved` /
  // `pr-changes-requested` quand la review GitHub de sa PR la plus récente tombe. Lecture seule
  // (gh pr view), défaut activé.
  autoPrReviewTag: true,
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
  // Projets pour lesquels le serveur hooked maintient un démon `claude remote-control` (mode serveur :
  // le projet devient un ENVIRONNEMENT lançable depuis l'app Claude). Liste de chemins absolus ; le serveur
  // réconcilie les process démons à cette liste (cf. server/remoteControl.js). [] = aucun.
  remoteControlProjects: [],
  // Projets épinglés en favori (cwd absolus) : remontés en tête du sélecteur de la Nouvelle session.
  // Même forme que remoteControlProjects (liste de chemins absolus, dédupée/bornée). [] = aucun.
  favoriteProjects: [],
  // Digest quotidien (onglet Digest / server/digests.js). auto : génère le digest de la veille
  // chaque jour à `hour` (heure locale) ; model : modèle passé à `claude -p` ('' = hérite du défaut
  // Claude Code). Remplace les anciennes variables d'env HOOKED_DIGEST_*.
  digest: { auto: true, hour: 7, model: '' },
  // Visibilité des éléments de la barre de statut (en-tête du détail de session). Tout à true par
  // défaut sauf prLinks / issueLinks (false : les onglets dédiés PR/Issues sont le lieu principal ;
  // chips masqués par défaut).
  statusBar: Object.fromEntries(STATUS_BAR_KEYS.map((k) => [k, !STATUS_BAR_HIDDEN_DEFAULT.has(k)])),
  // Nombre max de chips PR / issue affichés dans la barre de statut (0 = tous). Le surplus est
  // résumé par un « +N » ; les onglets dédiés restent exhaustifs.
  statusBarLinkLimit: 0,
  // Source de diff sur laquelle s'ouvre la lentille Ship : 'claude' (diff reconstruit du
  // transcript, filtrable par prompt) ou 'vcs' (git/jj : working tree + commits). Le bouton
  // de bascule dans l'onglet permet toujours de changer ponctuellement.
  shipDefaultView: 'claude',
  // Éditeur de code préféré : clé du registre src/lib/editors.js ('vscode', 'zed'…). Sert aux
  // liens « open in editor » de la lentille Ship (côté client) et à l'ouverture du dossier projet
  // par le serveur (CLI de l'éditeur).
  editor: DEFAULT_EDITOR,
  // Page d'accueil (espace ouvert à froid au chargement) : 'deck' ou une clé de nav.
  defaultPage: 'deck',
  // Onglets de navigation visibles à côté du Deck (paramétrable). Sous-ensemble de NAV_PAGES.
  navTabs: ['sessions', 'search', 'stats', 'digest', 'memory'],
  // Versions de modèle masquées des sélecteurs (liste noire, cf. src/lib/models.js). Défaut : les
  // vieilles générations. [] = tout afficher. Purement cosmétique : un modèle masqué reste valide
  // au lancement, et le modèle courant d'une session reste toujours affiché.
  hiddenModels: [...DEFAULT_HIDDEN_MODELS],
};

const NAV_PAGES = ['sessions', 'search', 'stats', 'digest', 'memory'];
const DEFAULT_PAGES = ['deck', ...NAV_PAGES];

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
  // statusBar : objet key→boolean. Toute clé absente = true par défaut, sauf prLinks / issueLinks
  // (false : les onglets dédiés sont le lieu principal ; chips masqués pour éviter le double affichage).
  const rawSb = o.statusBar && typeof o.statusBar === 'object' ? o.statusBar : {};
  const statusBar = Object.fromEntries(STATUS_BAR_KEYS.map((k) => {
    if (rawSb[k] !== undefined) return [k, rawSb[k] !== false];
    return [k, !STATUS_BAR_HIDDEN_DEFAULT.has(k)]; // absent → défaut (prLinks/issueLinks → false)
  }));
  // statusBarLinkLimit : entier 0-50 (0 = pas de limite). Toute valeur hors bornes retombe sur 0.
  const linkLimit = Number.isInteger(o.statusBarLinkLimit) && o.statusBarLinkLimit >= 0 && o.statusBarLinkLimit <= 50
    ? o.statusBarLinkLimit
    : 0;
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
  // remoteControlProjects : liste de chemins absolus, dédupée et bornée (anti-abus : chaque démon
  // spawn un process claude). L'existence du dossier n'est PAS vérifiée ici (le disque peut varier) —
  // reconcileRemoteControl saute au lancement un chemin qui n'est plus un dossier.
  const rcProjects = Array.isArray(o.remoteControlProjects)
    ? [...new Set(o.remoteControlProjects.filter((p) => typeof p === 'string' && p.startsWith('/')).map((p) => p.slice(0, 4096)))].slice(0, 32)
    : [];
  // favoriteProjects : même traitement que remoteControlProjects (chemins absolus, dédupés, bornés).
  const favProjects = Array.isArray(o.favoriteProjects)
    ? [...new Set(o.favoriteProjects.filter((p) => typeof p === 'string' && p.startsWith('/')).map((p) => p.slice(0, 4096)))].slice(0, 64)
    : [];
  // digest : auto (bool, défaut true), hour (entier 0-23, défaut 7), model ('' = hérite, sinon
  // validé contre --model comme au lancement — jamais interpolé brut dans un shell sans ce filtre).
  const rawDg = o.digest && typeof o.digest === 'object' ? o.digest : {};
  const digest = {
    auto: rawDg.auto === undefined ? true : !!rawDg.auto,
    hour: Number.isInteger(rawDg.hour) && rawDg.hour >= 0 && rawDg.hour <= 23 ? rawDg.hour : 7,
    model: typeof rawDg.model === 'string' && isValidModelArg(rawDg.model) ? rawDg.model : '',
  };
  // hiddenModels : liste de versions concrètes (jamais un alias de famille), dédupée et bornée.
  // ABSENT ≠ VIDE : un settings.json antérieur à cette clé doit hériter du défaut (sinon la
  // fonctionnalité ne s'appliquerait à personne), tandis qu'un `[]` explicite signifie bien
  // « tout afficher » et doit être respecté.
  const hiddenModels = o.hiddenModels === undefined
    ? [...DEFAULT_HIDDEN_MODELS]
    : (Array.isArray(o.hiddenModels) ? [...new Set(o.hiddenModels.filter(isHideableModel))].slice(0, 64) : []);
  return {
    subtabOrder: order,
    statusBarOrder: sbOrder,
    subtabHidden: hidden,
    autoGitSync: !!o.autoGitSync,
    autoPrReviewTag: o.autoPrReviewTag === undefined ? true : !!o.autoPrReviewTag,
    gitAutoRestartOnLock: !!o.gitAutoRestartOnLock,
    // Défaut à true : une config antérieure à cette clé ne doit pas la forcer à false.
    gitRestartNotice: o.gitRestartNotice === undefined ? true : !!o.gitRestartNotice,
    statusBar,
    statusBarLinkLimit: linkLimit,
    defaultModel,
    defaultEffort,
    defaultMode,
    quickLaunchProject,
    remoteControlProjects: rcProjects,
    favoriteProjects: favProjects,
    digest,
    shipDefaultView: o.shipDefaultView === 'vcs' ? 'vcs' : 'claude',
    editor: EDITOR_KEYS.includes(o.editor) ? o.editor : DEFAULT_EDITOR,
    defaultPage: DEFAULT_PAGES.includes(o.defaultPage) ? o.defaultPage : 'deck',
    hiddenModels,
    navTabs: Array.isArray(o.navTabs)
      ? NAV_PAGES.filter((k) => o.navTabs.includes(k)) // keep known keys, canonical order
      : [...NAV_PAGES],
  };
}

// Lit les réglages (défauts si le fichier est absent/illisible). Pas de cache : lecture directe
// à chaque appel — le fichier est minuscule et rarement lu (au chargement de page).
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
