# hooked desktop

A native window on the hooked service running at `localhost:4123`, plus a menu
bar icon. It ships no dashboard of its own: `ui/index.html` only waits for the
service to answer, then redirects to it. Updating the dashboard is still
`mise run deploy`; the app itself never needs rebuilding.

## What the native layer adds

- **System notifications.** WKWebView has no Web Notification API, so
  `shim.js` replaces `window.Notification` with one that forwards to the system.
  What gets notified, and when, is still decided by the dashboard.
- **A menu bar icon** showing how many sessions are waiting on you. It follows
  the same event stream the dashboard uses, so it stays right even when the
  window is closed.
- **Closing hides the window** rather than quitting. Quit from the menu bar.

## Build

mise pulls the Rust toolchain and the Tauri CLI for these two tasks only, so
building the dashboard still needs nothing but Node. From the repo root:

```sh
mise run desktop-icons   # once
mise run desktop
```

That builds, replaces `/Applications/hooked.app` and relaunches it. There is
only ever one installed copy, and the menu bar tooltip says how old the running
build is.

## When notifications stay silent

`HOOKED_TEST_NOTIFY=1` fires one banner from the app itself at startup, without
going through the page. A banner means the system allows it and the problem is
in the dashboard; nothing at all means macOS is blocking the app, under System
Settings → Notifications.

## Not done yet

- No dock badge: the menu bar count covers it.
- No `.dmg`: add `"dmg"` back to the bundle targets to distribute the app.
- The port is fixed at 4123, in `ui/index.html` and `src/main.rs`.
