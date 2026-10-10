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

// Optional controls of the session header's ⋯ menu. Each key is a boolean (true = shown); a key
// missing from the file is treated as true (forward-compatible).
const STATUS_BAR_KEYS = [
  'permissionMode', // permission-mode chips + auto-approve
  'modelEffort',    // model + effort control
  'focusBtn',       // Focus button
];

const DEFAULTS = {
  // Locale (BCP-47) used by the composer's voice dictation (Web Speech API). E.g. fr-FR, en-US.
  speechLang: 'fr-FR',
  // Voice dictation on/off (composer mic button, Web Speech API). Default true: a settings.json
  // predating this key must not silently disable it for everyone.
  speechEnabled: true,
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
  // Visibility of the session header's optional ⋯ menu controls (all shown by default).
  statusBar: Object.fromEntries(STATUS_BAR_KEYS.map((k) => [k, true])),
  // Éditeur de code préféré : clé du registre src/lib/editors.js ('vscode', 'zed'…). Sert aux
  // liens « open in editor » de la lentille Ship (côté client) et à l'ouverture du dossier projet
  // par le serveur (CLI de l'éditeur).
  editor: DEFAULT_EDITOR,
  // Page d'accueil (espace ouvert à froid au chargement) : 'deck' ou une clé de nav.
  defaultPage: 'deck',
  // Onglets de navigation visibles à côté du Deck (paramétrable). Sous-ensemble de NAV_PAGES.
  navTabs: ['sessions', 'stats', 'digest', 'memory', 'github'],
  // Versions de modèle masquées des sélecteurs (liste noire, cf. src/lib/models.js). Défaut : les
  // vieilles générations. [] = tout afficher. Purement cosmétique : un modèle masqué reste valide
  // au lancement, et le modèle courant d'une session reste toujours affiché.
  hiddenModels: [...DEFAULT_HIDDEN_MODELS],
  // 5-hour window management (cf. server/warmup.js). Claude's usage window is anchored to your
  // first message and lasts 5h, so the day's first prompt decides where every later boundary
  // falls. `workHours` is the only thing worth setting: in 'auto' mode the anchor is derived from
  // it (the split that maximises the smallest window's share of work). 'fixed' pins `at` instead.
  // Off by default — it spawns a `claude -p` ping on a timer.
  warmup: {
    enabled: false,
    mode: 'auto',
    at: '06:00',
    days: [1, 2, 3, 4, 5], // getDay(): 0 = Sunday
    workHours: [['09:00', '12:00'], ['14:00', '18:00']],
    model: 'haiku',
    skipIfWeeklyOver: 90, // % of the 7-day budget above which opening more 5h windows is a trap
  },
  // Auto-compact (cf. server/agent.js → shouldAutoCompact): /compact a driven session left waiting
  // for the user just before its prompt cache expires. Off by default — a compaction is lossy.
  // `minContextK`: only sessions whose context is at least this many thousand tokens; below it a
  // cold resume is cheap anyway, and compacting would lose the thread for nothing.
  autoCompact: { enabled: false, minContextK: 100 },
  // Prompt-cache countdown on the session sidebar rows. `display`: 'badge' = beside the elapsed
  // time, 'replace' = in its place. `windowMin`: shown only in the cache's last N minutes, 0 = always.
  sidebarCache: { display: 'badge', windowMin: 15 },
};

const NAV_PAGES = ['sessions', 'stats', 'digest', 'memory', 'github'];
const DEFAULT_PAGES = ['deck', ...NAV_PAGES];

// Ramène un objet arbitraire (fichier ou payload client) à des valeurs sûres et complètes.
function sanitize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  // statusBar : objet key→boolean ; toute clé absente vaut true (forward-compatible).
  const rawSb = o.statusBar && typeof o.statusBar === 'object' ? o.statusBar : {};
  const statusBar = Object.fromEntries(STATUS_BAR_KEYS.map((k) => [k, rawSb[k] !== false]));
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
  // speechLang: BCP-47 locale (lang or lang-REGION…). Anything else falls back to the default.
  const speechLang =
    typeof o.speechLang === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(o.speechLang)
      ? o.speechLang
      : 'fr-FR';
  // hiddenModels : liste de versions concrètes (jamais un alias de famille), dédupée et bornée.
  // ABSENT ≠ VIDE : un settings.json antérieur à cette clé doit hériter du défaut (sinon la
  // fonctionnalité ne s'appliquerait à personne), tandis qu'un `[]` explicite signifie bien
  // « tout afficher » et doit être respecté.
  const hiddenModels = o.hiddenModels === undefined
    ? [...DEFAULT_HIDDEN_MODELS]
    : (Array.isArray(o.hiddenModels) ? [...new Set(o.hiddenModels.filter(isHideableModel))].slice(0, 64) : []);
  // warmup : cf. server/warmup.js. workHours = paires ["HH:MM","HH:MM"] (comparaison de chaînes
  // valide car zero-paddées). `model` est interpolé dans une commande shell → même filtre que
  // digest.model, jamais de valeur brute.
  const rawWu = o.warmup && typeof o.warmup === 'object' ? o.warmup : {};
  const isHm = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  const slots = (Array.isArray(rawWu.workHours) ? rawWu.workHours : [])
    .filter((s) => Array.isArray(s) && isHm(s[0]) && isHm(s[1]) && s[0] < s[1])
    .map((s) => [s[0], s[1]])
    .slice(0, 6);
  const warmup = {
    enabled: !!rawWu.enabled,
    mode: rawWu.mode === 'fixed' ? 'fixed' : 'auto',
    at: isHm(rawWu.at) ? rawWu.at : DEFAULTS.warmup.at,
    days: Array.isArray(rawWu.days)
      ? [...new Set(rawWu.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : [...DEFAULTS.warmup.days],
    workHours: slots.length ? slots : DEFAULTS.warmup.workHours.map((s) => [...s]),
    model: typeof rawWu.model === 'string' && isValidModelArg(rawWu.model) ? rawWu.model : DEFAULTS.warmup.model,
    skipIfWeeklyOver: Number.isInteger(rawWu.skipIfWeeklyOver) && rawWu.skipIfWeeklyOver >= 0 && rawWu.skipIfWeeklyOver <= 100
      ? rawWu.skipIfWeeklyOver
      : DEFAULTS.warmup.skipIfWeeklyOver,
  };
  const rawAc = o.autoCompact && typeof o.autoCompact === 'object' ? o.autoCompact : {};
  const autoCompact = {
    enabled: !!rawAc.enabled,
    minContextK: Number.isInteger(rawAc.minContextK) && rawAc.minContextK >= 0 && rawAc.minContextK <= 1000
      ? rawAc.minContextK
      : DEFAULTS.autoCompact.minContextK,
  };
  const rawSc = o.sidebarCache && typeof o.sidebarCache === 'object' ? o.sidebarCache : {};
  const sidebarCache = {
    display: rawSc.display === 'replace' ? 'replace' : 'badge',
    windowMin: Number.isInteger(rawSc.windowMin) && rawSc.windowMin >= 0 && rawSc.windowMin <= 60
      ? rawSc.windowMin
      : DEFAULTS.sidebarCache.windowMin,
  };
  return {
    autoGitSync: !!o.autoGitSync,
    autoPrReviewTag: o.autoPrReviewTag === undefined ? true : !!o.autoPrReviewTag,
    gitAutoRestartOnLock: !!o.gitAutoRestartOnLock,
    // Défaut à true : une config antérieure à cette clé ne doit pas la forcer à false.
    gitRestartNotice: o.gitRestartNotice === undefined ? true : !!o.gitRestartNotice,
    statusBar,
    defaultModel,
    defaultEffort,
    defaultMode,
    quickLaunchProject,
    remoteControlProjects: rcProjects,
    favoriteProjects: favProjects,
    digest,
    warmup,
    autoCompact,
    sidebarCache,
    speechLang,
    speechEnabled: o.speechEnabled === undefined ? true : !!o.speechEnabled,
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

export { SETTINGS_FILE, DEFAULTS as SETTINGS_DEFAULTS, readSettings, writeSettings };
