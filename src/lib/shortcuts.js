const LS_KEY = 'hooked.shortcuts';

export const SHORTCUT_DEFS = [
  { id: 'command-palette', label: 'Command palette', section: 'Navigation', defaultKeys: { mod: true, key: 'p' } },
  { id: 'commands-only', label: 'Commands only', section: 'Navigation', defaultKeys: { mod: true, shift: true, key: 'p' } },
  { id: 'new-session', label: 'New session', section: 'Navigation', defaultKeys: { mod: true, key: 'n' } },
  { id: 'search', label: 'Search', section: 'Navigation', defaultKeys: { mod: true, key: 'k' } },
  { id: 'settings', label: 'Settings', section: 'Navigation', defaultKeys: { mod: true, key: ',' } },
  { id: 'go-sessions', label: 'Go to Sessions', section: 'Navigation', defaultKeys: { alt: true, key: '1' } },
  { id: 'go-board', label: 'Go to Board', section: 'Navigation', defaultKeys: { alt: true, key: '2' } },
  { id: 'go-search', label: 'Go to Search', section: 'Navigation', defaultKeys: { alt: true, key: '3' } },
  { id: 'go-stats', label: 'Go to Stats', section: 'Navigation', defaultKeys: { alt: true, key: '4' } },
  { id: 'go-digest', label: 'Go to Digest', section: 'Navigation', defaultKeys: { alt: true, key: '5' } },
  { id: 'go-memory', label: 'Go to Memory', section: 'Navigation', defaultKeys: { alt: true, key: '6' } },
  { id: 'go-split', label: 'Go to Split view', section: 'Navigation', defaultKeys: { alt: true, key: '7' } },
  { id: 'focus-mode', label: 'Toggle focus mode', section: 'Actions', defaultKeys: { mod: true, shift: true, key: 'f' } },
  { id: 'theme-cycle', label: 'Cycle theme', section: 'Actions', defaultKeys: { mod: true, shift: true, key: 't' } },
];

function loadOverrides() {
  if (typeof localStorage === 'undefined') return {};
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch { return {}; }
}

function saveOverrides(o) {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch {}
}

let overrides = loadOverrides();

export function getBinding(id) {
  const def = SHORTCUT_DEFS.find(d => d.id === id);
  if (!def) return null;
  return overrides[id] || def.defaultKeys;
}

export function getAllBindings() {
  return SHORTCUT_DEFS.map(d => ({
    ...d,
    keys: overrides[d.id] || d.defaultKeys,
    isCustom: !!overrides[d.id],
  }));
}

export function setBinding(id, keys) {
  overrides = { ...overrides, [id]: keys };
  saveOverrides(overrides);
}

export function resetBinding(id) {
  const next = { ...overrides };
  delete next[id];
  overrides = next;
  saveOverrides(next);
}

export function resetAll() {
  overrides = {};
  saveOverrides({});
}

export function matchesEvent(keys, e) {
  if (!keys) return false;
  const mod = e.metaKey || e.ctrlKey;
  if (!!keys.mod !== mod) return false;
  if (!!keys.shift !== e.shiftKey) return false;
  if (!!keys.alt !== e.altKey) return false;
  return e.key.toLowerCase() === keys.key.toLowerCase();
}

export function matchShortcut(e) {
  for (const def of SHORTCUT_DEFS) {
    const keys = overrides[def.id] || def.defaultKeys;
    if (matchesEvent(keys, e)) return def.id;
  }
  return null;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

export function formatKeys(keys) {
  if (!keys) return '';
  const parts = [];
  if (keys.mod) parts.push(isMac ? '⌘' : 'Ctrl');
  if (keys.shift) parts.push(isMac ? '⇧' : 'Shift');
  if (keys.alt) parts.push(isMac ? '⌥' : 'Alt');
  const k = keys.key;
  const LABELS = {
    ',': ',', '.': '.', '/': '/', ' ': 'Space',
    arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
    enter: '↵', escape: 'Esc', backspace: '⌫', delete: 'Del', tab: 'Tab',
  };
  parts.push(LABELS[k.toLowerCase()] || k.toUpperCase());
  return parts.join(isMac ? '' : '+');
}

export function keysFromEvent(e) {
  if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return null;
  const keys = { key: e.key.length === 1 ? e.key.toLowerCase() : e.key };
  if (e.metaKey || e.ctrlKey) keys.mod = true;
  if (e.shiftKey) keys.shift = true;
  if (e.altKey) keys.alt = true;
  return keys;
}

export function shortcutForCommand(commandId) {
  const map = {
    'nav:board': 'go-board',
    'nav:sessions': 'go-sessions',
    'nav:new': 'new-session',
    'nav:search': 'go-search',
    'nav:split': 'go-split',
    'nav:settings': 'settings',
    'act:focus': 'focus-mode',
  };
  const sid = map[commandId];
  if (!sid) return null;
  return getBinding(sid);
}
