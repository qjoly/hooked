// Navigation spaces shown next to the Deck in the top bar. The user picks which appear via
// settings.navTabs (a list of keys); the rest stay reachable through the omnibar. `Deck` is always
// present and isn't in this list. Keys double as the `defaultPage` values (+ 'deck').
export const NAV_TABS = [
  { key: 'sessions', label: 'Sessions', icon: '🗂', href: '/sessions' },
  { key: 'search',   label: 'Search',   icon: '🔍', href: '/search' },
  { key: 'stats',    label: 'Stats',    icon: '📊', href: '/stats' },
  { key: 'digest',   label: 'Digest',   icon: '📖', href: '/digest' },
  { key: 'memory',   label: 'Memory',   icon: '🧠', href: '/memory' },
];
export const NAV_KEYS = NAV_TABS.map((t) => t.key);
// href for a page key (used by the logo / default-page redirect). 'deck' → '/'.
export function pageHref(key) {
  const t = NAV_TABS.find((x) => x.key === key);
  return t ? t.href : '/';
}
