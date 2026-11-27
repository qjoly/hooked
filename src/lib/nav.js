import { MODULES, moduleOfPage, moduleOn } from '#modules/index.js';

// Navigation spaces shown next to the Deck in the top bar. The user picks which appear via
// settings.navTabs (a list of keys); the rest go to the top bar's More menu and the omnibar. `Deck` is always
// present and isn't in this list. Keys double as the `defaultPage` values (+ 'deck').
// `tint` colors the icon + underline of the ACTIVE tab only. Tokens only, so light/dark/legacy
// schemes all resolve for free.
// The core's pages; the modules bring their own (modules/<id>/manifest.js: page, label, icon,
// tint, order), merged in by `order`.
const CORE_TABS = [
  { key: 'sessions', label: 'Sessions', icon: 'sessions', href: '/sessions', tint: 'var(--info)', order: 10 },
  { key: 'stats',    label: 'Stats',    icon: 'stats', href: '/stats', tint: 'var(--success)', order: 20 },
  { key: 'digest',   label: 'Digest',   icon: 'digest', href: '/digest', tint: 'var(--warn)', order: 30 },
  { key: 'memory',   label: 'Memory',   icon: 'memory', href: '/memory', tint: 'var(--background)', order: 40 },
  { key: 'skills',   label: 'Skills',   icon: 'zap', href: '/skills', tint: 'var(--accent)', order: 70 },
  { key: 'prompts',  label: 'Prompts',  icon: 'note', href: '/prompts', tint: 'var(--info)', order: 100 },
];
export const NAV_TABS = [
  ...CORE_TABS,
  ...MODULES.map((m) => ({ key: m.page, label: m.label, icon: m.icon, href: '/' + m.page, tint: m.tint || 'var(--accent)', order: m.order ?? 1000, module: m.id })),
].sort((a, b) => a.order - b.order);
export const NAV_KEYS = NAV_TABS.map((t) => t.key);
// The tabs with the extensions' pages merged in (`extTabs` from src/lib/extensions.svelte.js),
// known only at runtime.
export function navTabsWith(extTabs = []) {
  return [...NAV_TABS, ...extTabs.filter((t) => !NAV_KEYS.includes(t.key))].sort((a, b) => a.order - b.order);
}
// A page shows unless it belongs to a module or an extension that is switched off (Settings →
// Modules) or cannot work on this machine (`avail`, from GET /api/modules; `extensions`, from
// GET /api/extensions).
export function pageAvailable(key, settings, avail = {}, extensions = []) {
  const ext = extensions.find((e) => e.page?.key === key);
  if (ext) return ext.enabled && ext.available !== false;
  const m = moduleOfPage(key);
  return !m || (moduleOn(settings, m) && avail[m] !== false);
}
// href for a page key (used by the logo / default-page redirect). 'deck' → '/'.
export function pageHref(key, extTabs = []) {
  const t = navTabsWith(extTabs).find((x) => x.key === key);
  return t ? t.href : '/';
}
