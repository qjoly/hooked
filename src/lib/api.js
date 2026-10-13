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
// Full-text hits across every transcript (SQLite FTS, server-side). Results carry a snippet with
// <mark> tags around the match, ranked by bm25.
export const searchTranscripts = (q, limit = 50) =>
  jget(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`);
export const getStats = (range) => jget('/api/stats?range=' + encodeURIComponent(range));
// Diff du working tree (git/jj) du projet de la session, dépôts imbriqués compris.
// { vcs:'git'|'jj'|null, root, changes, truncated, repos:[{ kind, root, label, primary, changes }] }.
export const getVcsDiff = (id) => jget('/api/session/vcs-diff?id=' + encodeURIComponent(id));
// Branches locales (git) / bookmarks (jj) d'un dépôt du projet — sélecteur de la lentille Branch.
// { vcs, root, branches:[{ name, current }], default, repos:[{ kind, root, label, primary }] }.
export const getVcsBranches = (id, root = null) =>
  jget('/api/session/vcs-branches?id=' + encodeURIComponent(id) + (root ? '&root=' + encodeURIComponent(root) : ''));
// Diff d'une branche vs une base (merge-base → tête, façon « Files changed » d'une PR), ou des
// seuls commits `range` ({ from, to }, deux commits de la branche, bornes comprises).
// { vcs, root, branch, base, mergeBase, merged, commits, range, changes } — `commits` liste
// toujours la branche entière, `range` la sélection retenue par le serveur (null = tout).
export const getVcsBranchDiff = (id, branch, base = null, root = null, range = null) =>
  jget(`/api/session/vcs-branch?id=${encodeURIComponent(id)}&branch=${encodeURIComponent(branch)}`
    + (base ? '&base=' + encodeURIComponent(base) : '') + (root ? '&root=' + encodeURIComponent(root) : '')
    + (range ? `&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : ''));
// Blame d'un fichier à une révision (vide = arbre de travail) — l'auteur de la ligne survolée
// dans un diff. { supported, root, rev, commits:[{ rev, author, mail, time, summary,
// uncommitted }], lines:[{ c, t } | null] } (`c` = index dans `commits`, `t` = texte de la ligne).
export const getVcsBlame = (id, file, rev = '') =>
  jget(`/api/session/vcs-blame?id=${encodeURIComponent(id)}&file=${encodeURIComponent(file)}`
    + (rev ? '&rev=' + encodeURIComponent(rev) : ''));
// Déclaration(s) probables d'un symbole, cherchées dans le dépôt du projet (git grep +
// partition heuristique) — le « go to definition » de la review. `file` = le fichier d'où part
// le clic (localité + imports), `rev` = '' pour l'arbre de travail.
// { supported, root, symbol, approximate, timedOut, origin, jump, declarations, references,
//   referenceCount } ; `jump` non nul = une unique déclaration nette, on peut y aller direct.
export const getSymbolDefs = (id, symbol, file, rev = '') =>
  jget(`/api/session/symbol?id=${encodeURIComponent(id)}&symbol=${encodeURIComponent(symbol)}`
    + `&file=${encodeURIComponent(file)}` + (rev ? '&rev=' + encodeURIComponent(rev) : ''));
// Tranche de lignes d'un fichier du projet à une révision, pour afficher une définition qui
// n'est pas dans la review. { supported, root, rel, lang, from, to, total, truncated, lines }.
export const getSource = (id, file, rev = '', from = 0, to = 0) =>
  jget(`/api/session/source?id=${encodeURIComponent(id)}&file=${encodeURIComponent(file)}`
    + (rev ? '&rev=' + encodeURIComponent(rev) : '') + (from ? `&from=${from}&to=${to}` : ''));
// Threads de revue ancrés dans la diff (Ship / Branch) : conversation par commentaire, partagée
// entre navigateurs et avec Claude (qui y répond via l'outil MCP reply_review_comment).
export const getReviewThreads = (id) => jget('/api/review?id=' + encodeURIComponent(id));
export const postReviewComment = (id, thread) => jpost('/api/review', { id, action: 'comment', thread });
export const editReviewThread = (id, threadId, text) => jpost('/api/review', { id, action: 'edit', threadId, text });
export const deleteReviewThread = (id, threadId) => jpost('/api/review', { id, action: 'delete', threadId });
export const replyReviewThread = (id, threadId, text) => jpost('/api/review', { id, action: 'reply', threadId, text });
export const archiveReviewThread = (id, threadId, archived = true) => jpost('/api/review', { id, action: 'archive', threadId, archived });
export const markReviewSent = (id, ids) => jpost('/api/review', { id, action: 'sent', ids });
export const startClaudeReview = (id, scope, rev) => jpost('/api/review', { id, action: 'start', scope, rev });
// Texte COMPLET d'un message user coupé dans la conversation (bulle marquée `truncated`),
// chargé quand on déplie la bulle. `uuid` = le forkUuid du message. { text }.
export const getMessageText = (id, uuid, agent = null) =>
  jget(`/api/session/message?id=${encodeURIComponent(id)}&uuid=${encodeURIComponent(uuid)}`
    + (agent ? '&agent=' + encodeURIComponent(agent) : ''));
// Diff COMPLET (sans plafond) d'un fichier changé, chargé à la demande (lentille Ship) quand
// l'entrée capée était marquée `truncated`. { change: {...} }.
export const getFileChangeFull = (id, path) =>
  jget(`/api/session/file-changes?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`);
// Usage « /usage » : rate limits du compte (5 h / 7 j) + contexte/effort de la session courante + budget 5 h.
export const getUsage = () => jget('/api/usage');
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
// Gestion de la fenêtre 5 h (Settings → 5-hour window) : plan du jour + décision courante du
// planificateur ; le POST déclenche le ping tout de suite (bouton « Ping now »).
export const getWarmup = () => jget('/api/warmup');
export const runWarmup = () => jpost('/api/warmup', {});

// Per-project status of the remote-control daemons (Settings → Remote control).
export const getRemoteControl = () => jget('/api/remote-control');
// Étiquettes de session persistées côté serveur (tags.json, partagées entre navigateurs).
export const getTags = () => jget('/api/tags');
export const saveTags = (id, tags) => jpost('/api/tags', { id, tags });
export const replaceTags = (map) => jpost('/api/tags', { replace: map });
// Per-session Deck metadata (session-meta.json server-side, shared across browsers):
// archived flag + snooze deadline. saveSessionMeta merge-patches one session.
export const getSessionMeta = () => jget('/api/session-meta');
export const saveSessionMeta = (id, patch) => jpost('/api/session-meta', { id, ...patch });
// Session groups: op = 'join' ({ target }) | 'leave' | 'mother' | 'rename' ({ name }).
export const groupOp = (op, id, extra = {}) => jpost('/api/session-meta', { op, id, ...extra });
// Daily digests: an AI-written recap of a day's sessions. GET (no date) → history index + latest
// date; getDigest(date) → one digest (or { status:'absent' }); generateDigest → kick off (async)
// generation, poll getDigest until status is done/partial/error.
export const getMemory = () => jget('/api/memory');
// MCP servers of a project (health-checked list, scope, diagnostics) + the OAuth actions.
// `cwd` selects the project: project- and local-scope servers are per-directory.
export const getMcpServers = (cwd) => jget('/api/mcp?cwd=' + encodeURIComponent(cwd || ''));
export const mcpAction = (body) => jpost('/api/mcp', body);

// Signed-in Claude account (top bar avatar/menu) + the `claude auth login`/`logout` actions.
export const getAccount = () => jget('/api/account');
export const accountAction = (body) => jpost('/api/account', body);

export const getDigests = () => jget('/api/digest');
export const getDigest = (date) => jget('/api/digest?date=' + encodeURIComponent(date));
export const generateDigest = (date, force) => jpost('/api/digest', { date, force: !!force });

// Force a live-state resync: drops the volatile per-session bits derived from the SDK stream and
// rebuilds the list now instead of waiting for the poll. Returns state counts.
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
// URL to display a screenshot produced during a session. Served only if it appears as an image
// read or written by that session or one of its sub-agents — see /api/screenshot.
export const screenshotUrl = (session, p) =>
  '/api/screenshot?session=' + encodeURIComponent(session || '') + '&path=' + encodeURIComponent(p || '');
export const interrupt = (id) => jpost('/api/interrupt', { id });
export const setMode = (id, mode) => jpost('/api/mode', { id, mode });
// `force` confirms a model switch the server held because the prompt cache was still warm.
export const setModelEffort = (id, model, effort, force = false) => jpost('/api/model', { id, model, effort, force });
export const launch = (payload) => jpost('/api/launch', payload);
// Ouvre le sélecteur de dossier natif de l'OS (macOS) ; renvoie { dir } ou { canceled }.
export const pickFolder = (start) => jpost('/api/pick-folder', start ? { start } : {});
// Fork d'une session à partir d'un message (uuid de la bulle) : crée une branche
// indépendante (copie du préfixe du transcript) et la reprend dans une nouvelle session.
export const fork = (payload) => jpost('/api/fork', payload);
export const kill = (id) => jpost('/api/kill', { id });
// Met une session à la corbeille : déplace le transcript dans <projet>/bin/ (récupérable),
// la retire du dashboard. ≠ kill (qui termine le process de la session). Voir /api/delete.
export const deleteSession = (id) => jpost('/api/delete', { id });
// Corbeille : liste des sessions supprimées + restauration.
export const getTrash = () => jget('/api/trash');
export const restoreSession = (id) => jpost('/api/restore', { id });
// Auto-approbation des permissions d'outil pour une session : les demandes cessent d'être posées,
// les questions et les plans continuent d'arriver (cf. /api/auto-approve).
export const setAutoApprove = (id, on) => jpost('/api/auto-approve', { id, on });
export const openInEditor = (id) => jpost('/api/open-editor', { id });
export const openInGhostty = (id) => jpost('/api/open-ghostty', { id });

// ── Terminaux shell (PTY réels, cf. server/terminal.js) ────────────────────────────────────────
// Un terminal n'est PAS lié à une session Claude : il tourne dans le dossier d'un projet et lui
// survit. `sessionId` ne sert qu'à l'étiqueter pour le regrouper dans l'UI.
export const listTerminals = (sessionId) => jget('/api/terminal' + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''));
export const openTerminal = (cwd, sessionId, cols, rows) => jpost('/api/terminal', { cwd, sessionId, cols, rows });
export const sendTerminalInput = (id, data) => jpost('/api/terminal/input', { id, data });
export const resizeTerminal = (id, cols, rows) => jpost('/api/terminal/resize', { id, cols, rows });
export const killTerminal = (id) => jpost('/api/terminal/kill', { id });

// Flux SSE PAR SESSION : avancement d'un tour au fil de l'eau (texte en cours, raisonnement, outil,
// état). Renvoie une fonction de fermeture. `onSnap` reçoit `{ live, state, busy, activity, text,
// thinking, tool, ended }` ; `live:false` = session non pilotée, rien ne viendra.
export function connectSessionStream(id, onSnap) {
  const es = new EventSource('/api/session/stream?id=' + encodeURIComponent(id));
  es.onmessage = (e) => { try { onSnap(JSON.parse(e.data)); } catch (_) {} };
  return () => es.close();
}

// Flux SSE : appelle onTick() à chaque « tick » poussé par le serveur.
export function connectSSE({ onTick, onOpen, onError }) {
  const es = new EventSource('/api/stream');
  es.onopen = () => onOpen && onOpen();
  es.onerror = () => onError && onError();
  es.onmessage = () => onTick && onTick();
  return es;
}
