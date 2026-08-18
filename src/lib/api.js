// Petite couche d'accès à l'API JSON + flux SSE. Mêmes endpoints que l'ancien front.

async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok && d.ok, status: r.status, data: d };
}

export const getSessions = async () => (await jget('/api/sessions')).sessions;
export const getSession = (id) => jget('/api/session?id=' + encodeURIComponent(id));
export const getStats = (range) => jget('/api/stats?range=' + encodeURIComponent(range));
// Diff du working tree (git/jj) du projet de la session, dépôts imbriqués compris.
// { vcs:'git'|'jj'|null, root, changes, truncated, repos:[{ kind, root, label, primary, changes }] }.
export const getVcsDiff = (id) => jget('/api/session/vcs-diff?id=' + encodeURIComponent(id));
// Usage « /usage » : rate limits du compte (5 h / 7 j) + contexte/effort de la session courante + budget 5 h.
export const getUsage = () => jget('/api/usage');
// Jobs de fond encore actifs, toutes sessions confondues (carte Overview). { jobs, count }.
export const getBackground = () => jget('/api/background');
// Flux SSE du log (.output) d'un job de fond, résolu côté serveur depuis (session, taskId).
// `onSeed(b64)` = queue initiale, `onData(b64)` = octets ajoutés, `onUnavailable()` = pas de log.
// Renvoie l'EventSource (appeler .close() pour arrêter).
export function connectBackgroundLog({ id, taskId, onSeed, onData, onUnavailable }) {
  const es = new EventSource(`/api/background/stream?id=${encodeURIComponent(id)}&taskId=${encodeURIComponent(taskId)}`);
  es.addEventListener('seed', (e) => onSeed && onSeed(e.data));
  es.addEventListener('data', (e) => onData && onData(e.data));
  es.addEventListener('unavailable', () => onUnavailable && onUnavailable());
  return es;
}
export const getFiles = (id, q, cwd) => jget(`/api/files?id=${encodeURIComponent(id || '')}&q=${encodeURIComponent(q)}${cwd ? '&cwd=' + encodeURIComponent(cwd) : ''}`);

// ── Éditeur IDE (Monaco) ─────────────────────────────────────────────────────────────────────
// base64 (contenu UTF-8) → string. atob rend une chaîne d'octets ; on repasse par TextDecoder
// pour décoder correctement l'UTF-8 (accents, emoji…).
function decodeB64Utf8(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
// Lit un fichier du projet de la session. Renvoie le body JSON tel quel (ok:true|false) — pas
// d'exception sur 400 (binaire / trop gros / hors projet portent un `error` explicite).
export async function getProjectFile(id, path) {
  const r = await fetch(`/api/project-file?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`);
  return r.json().catch(() => ({ ok: false, error: 'bad response' }));
}
// Auto-save d'un fichier projet. { ok, mtimeMs } | { ok:false, error }.
export const saveProjectFile = (id, path, content) => jpost('/api/project-file', { id, path, content });
// Liste plate de tous les fichiers du projet (tree-view IDE). { ok, files:[relpaths] }.
export const getProjectTree = (id) => jget(`/api/project-tree?id=${encodeURIComponent(id)}`);
// Flux SSE du contenu live d'un fichier : `onChange({ content, mtimeMs })` à chaque écriture
// disque (dont celles de Claude). `onUnavailable()` si le fichier n'est pas éditable. Renvoie
// l'EventSource (appeler .close()).
export function connectProjectFile({ id, path, onChange, onUnavailable }) {
  const es = new EventSource(`/api/project-file/stream?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`);
  es.addEventListener('change', (e) => {
    try { onChange && onChange(JSON.parse(decodeB64Utf8(e.data))); } catch (_) {}
  });
  es.addEventListener('unavailable', () => onUnavailable && onUnavailable());
  return es;
}
export const getCommands = (id, q, cwd) => jget(`/api/commands?id=${encodeURIComponent(id || '')}&q=${encodeURIComponent(q)}${cwd ? '&cwd=' + encodeURIComponent(cwd) : ''}`);
export const getAgent = (session, agent) => jget(`/api/agent?session=${encodeURIComponent(session)}&agent=${encodeURIComponent(agent)}`);
// Défauts modèle/effort lus depuis ~/.claude (config Claude Code de l'utilisateur).
export const getDefaults = () => jget('/api/defaults');
// Modèles (groupés) & efforts DISPONIBLES, dérivés du binaire claude par le serveur (aucune liste
// figée) — cf. server/capabilities.js. Mémoïsé : une seule requête par chargement de page, partagée
// entre toutes les instances du sélecteur. Reset en cas d'échec pour permettre un nouvel essai.
let _capsPromise = null;
export const getCapabilities = () => (_capsPromise ||= jget('/api/capabilities').catch((e) => { _capsPromise = null; throw e; }));
// Réglages persistants de hooked (settings.json côté serveur, partagés entre navigateurs).
export const getSettings = () => jget('/api/settings');
export const saveSettings = (patch) => jpost('/api/settings', patch);

// Per-project status of the remote-control daemons (Settings → Remote control).
export const getRemoteControl = () => jget('/api/remote-control');
// Étiquettes de session persistées côté serveur (tags.json, partagées entre navigateurs).
export const getTags = () => jget('/api/tags');
export const saveTags = (id, tags) => jpost('/api/tags', { id, tags });
export const replaceTags = (map) => jpost('/api/tags', { replace: map });
// Daily digests: an AI-written recap of a day's sessions. GET (no date) → history index + latest
// date; getDigest(date) → one digest (or { status:'absent' }); generateDigest → kick off (async)
// generation, poll getDigest until status is done/partial/error.
export const getMemory = () => jget('/api/memory');

export const getDigests = () => jget('/api/digest');
export const getDigest = (date) => jget('/api/digest?date=' + encodeURIComponent(date));
export const generateDigest = (date, force) => jpost('/api/digest', { date, force: !!force });

// Force a live-state resync: re-reads every session's tmux pane at cold (drops the caches) to fix a
// stale status (e.g. a session stuck on "working" after its tmux was closed). Returns state counts.
export const resync = () => jpost('/api/resync', {});

// Git du dépôt du serveur hooked lui-même (page Réglages) : état + branches + synchro.
export const getGit = () => jget('/api/git');
// Checkout d'une branche. strategy ∈ block (défaut) | stash | force. block + arbre sale → réponse
// { ok:false, dirty:true } (l'UI propose alors les boutons stash/force).
export const checkoutBranch = (branch, strategy) => jpost('/api/git', { action: 'checkout', branch, strategy });
// Efface la bannière « redémarrage nécessaire ».
export const dismissRestartNotice = () => jpost('/api/git', { action: 'dismiss-restart' });

// Version claude-code installée + méthode d'installation (garde sudo) + sessions live qui tournent
// une version plus ancienne (page Réglages). GET → { install, installed, outdated }.
export const getClaudeVersion = () => jget('/api/claude');
// Déclenche l'upgrade de claude. Ne lance jamais sudo : si le préfixe n'est pas inscriptible,
// renvoie { ok:false, needsSudo, warning, cmd } sans rien exécuter.
export const upgradeClaude = () => jpost('/api/claude', { action: 'upgrade' });
// Redémarre une session (kill + `claude --resume <id>`) pour qu'elle reparte sur la version installée.
export const restartClaudeSession = (id) => jpost('/api/claude', { action: 'restart', id });

export const reply = (id, text) => jpost('/api/reply', { id, text });
// Réponse à un AskUserQuestion : on transmet les indices sélectionnés par question
// ([{ multi, indices }]) ; le serveur pilote le TUI au clavier plutôt que de taper les labels.
// `note` (optionnel) : annotations libres envoyées en message de suivi après la sélection cochée.
export const replyQuestion = (id, selections, note) => jpost('/api/reply', { id, selections, note });
// Act on a live ExitPlanMode plan: action ∈ approve | approve-auto | keep | keep-feedback.
// `feedback` (bundled review comments) is required for keep-feedback. Drives the TUI approval menu.
export const planAction = (id, action, feedback) => jpost('/api/plan', { id, action, feedback });
export const uploadImage = (dataUrl) => jpost('/api/upload-image', { dataUrl });
// URL to display an attached image (served from hooked's images dir) by its absolute path.
export const imageUrl = (p) => '/api/image?path=' + encodeURIComponent(p);
// URL to display/download a file delivered by SendUserFile. Served only if it appears in the
// session's (or sub-agent's) transcript SendUserFile calls — see /api/user-file.
export const userFileUrl = (session, agent, p) =>
  '/api/user-file?session=' + encodeURIComponent(session || '') +
  (agent ? '&agent=' + encodeURIComponent(agent) : '') +
  '&path=' + encodeURIComponent(p || '');
export const interrupt = (id) => jpost('/api/interrupt', { id });
export const setMode = (id, mode) => jpost('/api/mode', { id, mode });
export const setModelEffort = (id, model, effort) => jpost('/api/model', { id, model, effort });
export const launch = (payload) => jpost('/api/launch', payload);
// Ouvre le sélecteur de dossier natif de l'OS (macOS) ; renvoie { dir } ou { canceled }.
export const pickFolder = (start) => jpost('/api/pick-folder', start ? { start } : {});
// Fork d'une session à partir d'un message (uuid de la bulle) : crée une branche
// indépendante (copie du préfixe du transcript) et la reprend dans une session tmux.
export const fork = (payload) => jpost('/api/fork', payload);
export const kill = (id) => jpost('/api/kill', { id });
// Met une session à la corbeille : déplace le transcript dans <projet>/bin/ (récupérable),
// la retire du dashboard. ≠ kill (qui ferme le pane tmux). Voir /api/delete.
export const deleteSession = (id) => jpost('/api/delete', { id });
// Corbeille : liste des sessions supprimées + restauration.
export const getTrash = () => jget('/api/trash');
export const restoreSession = (id) => jpost('/api/restore', { id });
export const openInVscode = (id) => jpost('/api/open-vscode', { id });
export const openInGhostty = (id) => jpost('/api/open-ghostty', { id });
// Ouvre un pane/fenêtre tmux dans la session et y lance une commande (mirroir onglet Terminal).
// Sans `command`, ouvre un pane shell vide (bouton « + Pane »).
export const showInPane = (id, command, target) => jpost('/api/pane', { id, command, target });
// Ferme un pane « show » (tue le pane tmux).
export const killPane = (pane) => jpost('/api/pane/kill', { pane });
// Saisie clavier interactive vers un pane (xterm.onData → tmux send-keys).
export const sendPaneInput = (pane, data) => jpost('/api/pane/input', { pane, data });
// Redimensionne la fenêtre tmux du pane pour remplir la vue web (ou restaure l'auto via {auto}).
export const resizePane = (pane, cols, rows) => jpost('/api/pane/resize', { pane, cols, rows });
export const autosizePane = (pane) => jpost('/api/pane/resize', { pane, auto: true });

// Flux SSE : appelle onTick() à chaque « tick » poussé par le serveur.
export function connectSSE({ onTick, onOpen, onError }) {
  const es = new EventSource('/api/stream');
  es.onopen = () => onOpen && onOpen();
  es.onerror = () => onError && onError();
  es.onmessage = () => onTick && onTick();
  return es;
}
