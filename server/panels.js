import { agentAlive, deliverReply } from './agent.js';

export const PANEL_LIMITS = Object.freeze({ files: 16, sourceBytes: 64 * 1024, stateBytes: 32 * 1024, sendBytes: 4 * 1024, sendGapMs: 2000 });

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PATH_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.luau$/;

const REG = Symbol.for('hooked.panels.registry');
const registry = () => (globalThis[REG] ||= new Map());
const keyOf = (session, id) => `${session || ''}\0${id}`;

const bytes = (s) => Buffer.byteLength(s, 'utf8');

function filesOf(input) {
  if (input.source != null && input.files != null) return { error: 'pass either `source` or `files`, not both' };
  if (input.source != null) {
    if (typeof input.source !== 'string' || !input.source.trim()) return { error: '`source` must be non-empty Luau code' };
    return { files: { 'init.luau': input.source } };
  }
  if (input.files == null) return { files: null };
  if (typeof input.files !== 'object' || Array.isArray(input.files)) return { error: '`files` must map relative paths to Luau source' };
  const entries = Object.entries(input.files);
  if (entries.length > PANEL_LIMITS.files) return { error: `at most ${PANEL_LIMITS.files} files` };
  for (const [p, src] of entries) {
    if (!PATH_RE.test(p)) return { error: `${p}: paths are relative, made of [A-Za-z0-9_-] segments, and end in .luau` };
    if (typeof src !== 'string') return { error: `${p}: source must be a string` };
  }
  if (!('init.luau' in input.files)) return { error: '`files` needs an init.luau entry' };
  return { files: { ...input.files } };
}

/** Pure: validates a show_panel call and merges it onto the panel it updates, if any. */
export function normalizePanel(input, prev) {
  if (!input || typeof input !== 'object') return { error: 'invalid panel' };
  const id = input.id == null ? 'panel' : input.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) return { error: '`id` must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}' };
  const f = filesOf(input);
  if (f.error) return f;
  const files = f.files || prev?.files;
  if (!files) return { error: `no panel "${id}" yet: pass its \`source\` (or \`files\`)` };
  const total = Object.values(files).reduce((n, s) => n + bytes(s), 0);
  if (total > PANEL_LIMITS.sourceBytes) return { error: `Luau source is ${total} bytes, the limit is ${PANEL_LIMITS.sourceBytes}` };
  let state = prev?.state ?? null;
  if (input.state !== undefined) {
    const json = JSON.stringify(input.state);
    if (json === undefined) return { error: '`state` must be JSON' };
    if (bytes(json) > PANEL_LIMITS.stateBytes) return { error: `state is ${bytes(json)} bytes, the limit is ${PANEL_LIMITS.stateBytes}` };
    state = input.state;
  }
  if (input.title != null && typeof input.title !== 'string') return { error: '`title` must be a string' };
  const title = (input.title ?? prev?.title ?? id).slice(0, 120);
  const sourceChanged = !prev || (f.files && JSON.stringify(f.files) !== JSON.stringify(prev.files));
  return {
    panel: {
      id,
      title,
      files,
      state,
      rev: (prev?.rev || 0) + 1,
      sourceRev: (prev?.sourceRev || 0) + (sourceChanged ? 1 : 0),
    },
  };
}

export function showPanel(session, input) {
  const reg = registry();
  const id = input?.id ?? 'panel';
  const prev = reg.get(keyOf(session, id));
  const r = normalizePanel(input, prev);
  if (r.error) return r;
  const panel = { ...r.panel, session: session || null, updatedAt: Date.now(), lastSend: prev?.lastSend || 0, lastError: null };
  reg.set(keyOf(session, panel.id), panel);
  return { panel, previousError: prev?.lastError || null };
}

/** A script error the desktop app saw: kept for the next show_panel result, since Claude never sees the window. */
export function reportPanelError(session, id, rev, message) {
  const panel = registry().get(keyOf(session, id));
  if (!panel) return false;
  if (typeof message !== 'string' || !message.trim()) return false;
  panel.lastError = { rev: Number.isInteger(rev) ? rev : panel.rev, message: message.trim().slice(0, 1000) };
  return true;
}

export function closePanel(session, id) {
  return registry().delete(keyOf(session, id));
}

export function listPanels() {
  return [...registry().values()];
}

/** What a click on a panel's send button tells the session, worded so it reads as a click, not as typed text. */
export function panelMessage(panel, label, value) {
  const sent = value == null ? '' : ` It sent: ${JSON.stringify(value)}`;
  return `[hooked panel] The user clicked the button "${label}" in panel "${panel.id}", which you drew with show_panel.${sent}`;
}

/** A click on a `ui.sendButton` the desktop app drew: delivered to the owning session. */
export function sendFromPanel(session, id, click, now = Date.now()) {
  const panel = registry().get(keyOf(session, id));
  if (!panel) return Promise.resolve({ code: 404, error: `no panel "${id}" for this session` });
  if (!panel.session || !agentAlive(panel.session)) return Promise.resolve({ code: 409, error: 'the panel\'s session is not driven by hooked' });
  const label = typeof click?.label === 'string' ? click.label.trim().slice(0, 80) : '';
  if (!label) return Promise.resolve({ code: 400, error: 'a click carries its button label' });
  const text = panelMessage(panel, label, click.value);
  if (bytes(text) > PANEL_LIMITS.sendBytes) return Promise.resolve({ code: 413, error: `message over ${PANEL_LIMITS.sendBytes} bytes` });
  if (now - panel.lastSend < PANEL_LIMITS.sendGapMs) return Promise.resolve({ code: 429, error: 'the panel sends too fast' });
  panel.lastSend = now;
  return new Promise((resolve) => {
    deliverReply(panel.session, text, (err, info) => resolve(err ? { code: 502, error: err.message || String(err) } : { ok: true, info }));
  });
}
