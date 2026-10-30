// Injected into every page the window loads. It gives the dashboard back the
// two browser behaviours WKWebView does not provide on its own.
(() => {
  // Resolved on each use: this script runs before the app has installed its
  // API, so a value captured now would always be empty.
  const notifier = () => window.__TAURI__ && window.__TAURI__.notification;
  const clicks = new Map();

  // Settings live per browser, so the switch flipped in a tab never reaches
  // this window. An app that counts what waits on you starts with them on; an
  // explicit choice made here is left alone.
  try {
    const settings = JSON.parse(localStorage.getItem('hooked.ui') || '{}');
    if (settings.notify === undefined) {
      settings.notify = true;
      localStorage.setItem('hooked.ui', JSON.stringify(settings));
    }
  } catch (_) {}

  // No Web Notification API here, so the dashboard would silently stop
  // notifying. This forwards to the system instead; what to notify, and when,
  // stays decided by the dashboard.
  function installNotifications(api) {
    class NativeNotification {
      static permission = 'granted';
      static requestPermission() { return Promise.resolve('granted'); }

      constructor(title, opts = {}) {
        // The tag is the only session reference the caller gives us, so it
        // doubles as the key for the click handler.
        this.tag = opts.tag || '';
        try {
          api.sendNotification({ title, body: opts.body, extra: { tag: this.tag } });
        } catch (_) {}
      }

      set onclick(fn) { if (this.tag) clicks.set(this.tag, fn); }
      get onclick() { return clicks.get(this.tag) || null; }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }

    Object.defineProperty(window, 'Notification', { value: NativeNotification, configurable: true });

    // ponytail: best effort — if clicks are never delivered, notifications
    // just stop being clickable. Nothing else breaks.
    try {
      api.onAction((n) => {
        const fn = n && n.extra && clicks.get(n.extra.tag);
        if (fn) fn();
      });
    } catch (_) {}
  }

  // Without this the system drops every banner and the dashboard is left with
  // its badge and sound: the page calling itself "granted" is not the app being
  // allowed to notify.
  async function authorise(api) {
    try {
      if (await api.isPermissionGranted()) return true;
      return (await api.requestPermission()) === 'granted';
    } catch (e) {
      report('permission call failed: ' + e);
      return false;
    }
  }

  function report(msg) {
    try {
      window.__TAURI__.core.invoke('page_log', { msg });
    } catch (_) {}
  }

  // The dashboard keeps its own fallback as long as the API is missing, so the
  // replacement only happens once there is something to forward to.
  (function whenReady(tries = 0) {
    const api = notifier();
    if (api) {
      // Installing without authorisation would silence the dashboard's own
      // fallback in exchange for banners that never appear.
      authorise(api).then((ok) => {
        if (ok) installNotifications(api);
        else report('notifications refused by the system');
      });
    } else if (tries < 40) {
      setTimeout(() => whenReady(tries + 1), 250);
    } else {
      report('no tauri api on this page');
    }
  })();

  // A link to another site has to leave the app: the window has no back button
  // and no address bar. Stripping the target turns it into an ordinary
  // navigation, which the app catches and hands to the browser. Capture phase,
  // so the attribute is gone before the link is followed.
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[target="_blank"]');
    if (a) a.removeAttribute('target');
  }, true);
})();
