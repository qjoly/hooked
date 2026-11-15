# hooked for Android tablets

A native Jetpack Compose client for hooked, ported from `desktop-rune`: same design system (six
colour schemes, light/dark, round or square corners, Inter and JetBrains Mono, Lucide icons) and
the same screens. It talks to the hooked service over the HTTP API and event streams the web
dashboard uses.

## What is there

- **Shell**: rune's top bar (tabs, search palette ⌘K, 5H / 7D / Fable gauges, incognito, account,
  trash, theme), the sidebar (by status, flat or by project; pins, renames, tags, snooze, groups,
  drag and drop to group) and the Deck (decisions, quick reply, fleet wheel, cards or table).
- **Session**: header with CTX gauge and prompt-cache state, group tabs, the Converse, Review, MCP
  and Trace lenses, the context dock (tasks, changes, agents, sub-sessions, background jobs, PRs
  with checks and diffs, screenshots, workflows), split panes and a real terminal drawer.
- **Pages**: Stats, Digest, Memory, Cron, GitHub, Skills, Prompts, Settings and New session.
- **Grafana query window**, opened from a query tool or `show_query`.
- **Background notifications**: a foreground service follows `/api/stream` and notifies when a
  session starts waiting on you. On by default, off in Settings.
- **Pairing**: host, port and HTTPS, or `hooked://connect?host=192.168.1.20&port=4123` (add
  `&https=1` behind TLS).

Hover-only controls of rune are always visible or behind a long press.

## Build

Needs the Android SDK (`ANDROID_HOME`); mise pulls Java for this task only. From the repo root:

```sh
mise run android
```

That builds a release APK signed with the debug key, installs it on the device adb sees (USB, or
`adb connect <ip>:<port>` for wireless debugging) and starts it. Unit tests:
`cd android && ./gradlew test`.

The terminal uses Termux's `terminal-emulator` (Apache-2.0, from JitPack) for parsing; drawing is
in Compose.

## Pair

The tablet has to reach the machine (same LAN, WireGuard or Tailscale), and hooked has to listen on
it: `HOST=0.0.0.0` when installing the service. Plain HTTP is allowed on purpose, as on iOS.
