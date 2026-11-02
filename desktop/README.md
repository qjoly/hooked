# hooked desktop

A native window on the hooked service running at `localhost:4123`, plus a menu
bar icon. It ships no dashboard of its own: `ui/index.html` only waits for the
service to answer, then redirects to it. Updating the dashboard is still
`mise run deploy`; the app itself never needs rebuilding.

## What the native layer adds

- **A notice in the top-right corner** when a session starts waiting on you.
  It is drawn by the app, not by macOS Notification Center, and never takes
  the keyboard focus. Clicking it opens the session. There are no system
  banners.
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

## Checking the notice

`HOOKED_TEST_TOAST=1` shows a test notice 3 s after startup. The menu bar's
"Show a test notice" does the same while the app is running.

## Not done yet

- No dock badge: the menu bar count covers it.
- No `.dmg`: add `"dmg"` back to the bundle targets to distribute the app.
- The port is fixed at 4123, in `ui/index.html` and `src/main.rs`.
