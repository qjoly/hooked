const LS_KEY = 'hooked.shortcuts';

export const SHORTCUT_DEFS = [
  { id: 'command-palette', label: 'Omnibar', section: 'Navigation', defaultKeys: { mod: true, key: 'p' } },
  { id: 'commands-only', label: 'Omnibar (commands only)', section: 'Navigation', defaultKeys: { mod: true, shift: true, key: 'p' } },
  { id: 'new-session', label: 'New session', section: 'Navigation', defaultKeys: { mod: true, key: 'n' } },
  { id: 'settings', label: 'Settings', section: 'Navigation', defaultKeys: { mod: true, key: ',' } },
  { id: 'go-sessions', label: 'Go to Deck', section: 'Navigation', defaultKeys: { alt: true, key: '1' } },
  { id: 'go-board', label: 'Go to Sessions', section: 'Navigation', defaultKeys: { alt: true, key: '2' } },
  { id: 'go-stats', label: 'Go to Stats', section: 'Navigation', defaultKeys: { alt: true, key: '4' } },
  { id: 'go-digest', label: 'Go to Digest', section: 'Navigation', defaultKeys: { alt: true, key: '5' } },
  { id: 'go-memory', label: 'Go to Memory', section: 'Navigation', defaultKeys: { alt: true, key: '6' } },
  { id: 'toggle-sidebar', label: 'Toggle session sidebar', section: 'Actions', defaultKeys: { mod: true, key: 'b' } },
  // Session-scoped: SessionDetail's own window listener handles these two (the global layout
  // handler skips them). They came back with the PTY terminal panel — `2` toggles it too, but as a
  // bare key it is dead while the composer or the terminal itself has focus.
  { id: 'open-terminal', label: 'Toggle terminal panel', section: 'Actions', defaultKeys: { mod: true, key: 'j' } },
  { id: 'new-terminal', label: 'New terminal', section: 'Actions', defaultKeys: { mod: true, shift: true, key: 'j' } },
  { id: 'toggle-dock', label: 'Toggle context panel (tasks / changes / agents)', section: 'Actions', defaultKeys: { mod: true, shift: true, key: 'd' } },
  { id: 'split-session', label: 'Split with the most recent session', section: 'Actions', defaultKeys: { mod: true, shift: true, key: 's' } },
  { id: 'focus-mode', label: 'Toggle focus mode', section: 'Actions', defaultKeys: { mod: true, shift: true, key: 'f' } },
  { id: 'theme-cycle', label: 'Cycle theme', section: 'Actions', defaultKeys: { mod: true, shift: true, key: 't' } },
  // Lens-scoped: only the Ship / Branch review surfaces listen for it, hence a bare key.
  { id: 'review-file', label: 'Mark the current file reviewed', section: 'Review', defaultKeys: { key: 'v' } },
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

// The key an event names. `e.key` is the typed character — on Mac, ⌥+digit yields a composed one
// (`¡`, `™`…), so a binding on '1' never matched. Only then fall back to the physical key from
// `e.code` (`Digit1` → '1', `KeyA` → 'a'): when `e.key` already is a letter or digit it wins, or a
// non-QWERTY layout would match the physical key instead of the character actually typed.
export function eventKey(e) {
  const k = String(e.key || '');
  if (/^[a-z0-9]$/i.test(k)) return k.toLowerCase();
  const m = /^(?:Digit|Key)([A-Z0-9])$/.exec(e.code || '');
  return m ? m[1].toLowerCase() : k;
}

export function matchesEvent(keys, e) {
  if (!keys) return false;
  const mod = e.metaKey || e.ctrlKey;
  if (!!keys.mod !== mod) return false;
  if (!!keys.shift !== e.shiftKey) return false;
  if (!!keys.alt !== e.altKey) return false;
  return eventKey(e).toLowerCase() === keys.key.toLowerCase();
}

export function matchShortcut(e) {
  for (const def of SHORTCUT_DEFS) {
    const keys = overrides[def.id] || def.defaultKeys;
    if (matchesEvent(keys, e)) return def.id;
  }
  return null;
}

// Exporté : le « go to definition » en a besoin pour choisir SA touche modificatrice — ⌃-clic
// sous macOS est un clic droit, donc c'est ⌘ là-bas et ⌃ ailleurs (cf. src/lib/peek.svelte.js).
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

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
  const k = eventKey(e);
  const keys = { key: k.length === 1 ? k.toLowerCase() : k };
  if (e.metaKey || e.ctrlKey) keys.mod = true;
  if (e.shiftKey) keys.shift = true;
  if (e.altKey) keys.alt = true;
  return keys;
}

export function shortcutForCommand(commandId) {
  const map = {
    'nav:deck': 'go-sessions',
    'nav:sessions': 'go-board',
    'nav:new': 'new-session',
    'nav:stats': 'go-stats',
    'nav:digest': 'go-digest',
    'nav:memory': 'go-memory',
    'nav:settings': 'settings',
    'act:focus': 'focus-mode',
  };
  const sid = map[commandId];
  if (!sid) return null;
  return getBinding(sid);
}
