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
export const getFiles = (id, q, cwd) => jget(`/api/files?id=${encodeURIComponent(id || '')}&q=${encodeURIComponent(q)}${cwd ? '&cwd=' + encodeURIComponent(cwd) : ''}`);
export const getCommands = (id, q, cwd) => jget(`/api/commands?id=${encodeURIComponent(id || '')}&q=${encodeURIComponent(q)}${cwd ? '&cwd=' + encodeURIComponent(cwd) : ''}`);
export const getAgent = (session, agent) => jget(`/api/agent?session=${encodeURIComponent(session)}&agent=${encodeURIComponent(agent)}`);
// Défauts modèle/effort lus depuis ~/.claude (config Claude Code de l'utilisateur).
export const getDefaults = () => jget('/api/defaults');

export const reply = (id, text) => jpost('/api/reply', { id, text });
// Réponse à un AskUserQuestion : on transmet les indices sélectionnés par question
// ([{ multi, indices }]) ; le serveur pilote le TUI au clavier plutôt que de taper les labels.
export const replyQuestion = (id, selections) => jpost('/api/reply', { id, selections });
export const uploadImage = (dataUrl) => jpost('/api/upload-image', { dataUrl });
export const interrupt = (id) => jpost('/api/interrupt', { id });
export const setMode = (id, mode) => jpost('/api/mode', { id, mode });
export const setModelEffort = (id, model, effort) => jpost('/api/model', { id, model, effort });
export const launch = (payload) => jpost('/api/launch', payload);
export const kill = (id) => jpost('/api/kill', { id });
export const openInVscode = (id) => jpost('/api/open-vscode', { id });
export const openInGhostty = (id) => jpost('/api/open-ghostty', { id });
// Ouvre un pane/fenêtre tmux dans la session et y lance une commande (mirroir onglet Terminal).
export const showInPane = (id, command, target) => jpost('/api/pane', { id, command, target });
// Capture l'écran courant d'un pane tmux pour le mirroir read-only.
export const capturePane = (pane) => jget('/api/pane/capture?pane=' + encodeURIComponent(pane));
// Saisie clavier interactive vers un pane (xterm.onData → tmux send-keys).
export const sendPaneInput = (pane, data) => jpost('/api/pane/input', { pane, data });

// Flux SSE : appelle onTick() à chaque « tick » poussé par le serveur.
export function connectSSE({ onTick, onOpen, onError }) {
  const es = new EventSource('/api/stream');
  es.onopen = () => onOpen && onOpen();
  es.onerror = () => onError && onError();
  es.onmessage = () => onTick && onTick();
  return es;
}
