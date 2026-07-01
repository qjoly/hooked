/*
 * Current theme type ('dark' | 'light') exposed reactively (module-level $state rune,
 * allowed in a .svelte.js file).
 *
 * Mirrors the CSS logic in app.css: light is the default, dark kicks in via
 * `prefers-color-scheme: dark` UNLESS overridden by `data-theme="light"`, or via an explicit
 * `data-theme="dark"` on <html>. Used to drive the theme of Pierre diffs, which render in a
 * shadow DOM (the app's `data-theme` does not cascade in → it must be passed explicitly to
 * FileDiff.setThemeType()).
 */
function computeThemeType() {
  if (typeof document === 'undefined') return 'light';
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return 'dark';
  if (attr === 'light') return 'light';
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

let current = $state(computeThemeType());

if (typeof document !== 'undefined') {
  const sync = () => { current = computeThemeType(); };
  new MutationObserver(sync).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sync); } catch (_) {}
}

/** Current theme type, tracked reactively. */
export function themeType() {
  return current;
}
