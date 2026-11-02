// Injected into every page the window loads.
(() => {
  // A link to another site has to leave the app: the window has no back button
  // and no address bar. Stripping the target turns it into an ordinary
  // navigation, which the app catches and hands to the browser. Capture phase,
  // so the attribute is gone before the link is followed.
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[target="_blank"]');
    if (a) a.removeAttribute('target');
  }, true);
})();
