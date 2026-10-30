// Navigation spaces shown next to the Deck in the top bar. The user picks which appear via
// settings.navTabs (a list of keys); the rest go to the top bar's More menu and the omnibar. `Deck` is always
// present and isn't in this list. Keys double as the `defaultPage` values (+ 'deck').
// `tint` colors the icon + underline of the ACTIVE tab only. Tokens only, so light/dark/legacy
// schemes all resolve for free.
export const NAV_TABS = [
  { key: 'sessions', label: 'Sessions', icon: 'sessions', href: '/sessions', tint: 'var(--info)' },
  { key: 'stats',    label: 'Stats',    icon: 'stats', href: '/stats', tint: 'var(--success)' },
  { key: 'digest',   label: 'Digest',   icon: 'digest', href: '/digest', tint: 'var(--warn)' },
  { key: 'memory',   label: 'Memory',   icon: 'memory', href: '/memory', tint: 'var(--background)' },
  { key: 'github',   label: 'GitHub',   icon: 'pr', href: '/github', tint: 'var(--danger)' },
  { key: 'skills',   label: 'Skills',   icon: 'zap', href: '/skills', tint: 'var(--accent)' },
];
export const NAV_KEYS = NAV_TABS.map((t) => t.key);
// href for a page key (used by the logo / default-page redirect). 'deck' → '/'.
export function pageHref(key) {
  const t = NAV_TABS.find((x) => x.key === key);
  return t ? t.href : '/';
}
