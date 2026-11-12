# hooked for Android tablets

A native client for hooked, built for a tablet: Jetpack Compose and Material 3, in the dashboard's
Coffee look (palette and fonts). It talks to the hooked service over the same HTTP API and event
streams as the web dashboard, the iOS app and `desktop-rune`.

## What is there

- **Navigation rail**: new session, Deck (with the count of sessions waiting on you), Sessions,
  the 5H / 7D / Fable usage gauges, and Settings.
- **Deck**: *Your move* lists the sessions waiting on you. Permissions and questions are answered
  right on the card; a finished turn gets an inline reply. Each card can also be opened, snoozed
  for an hour or archived. *The fleet* shows a ring of every state, then the sessions grouped by
  project.
- **Sessions**: list and conversation side by side (one pane at a time below 840 dp). The list
  groups by state or by project, with search and pull to refresh; group members sit under their
  lead.
- **Conversation**: Markdown, collapsible tool calls, Edit / Write calls as inline diffs, the turn
  in progress live, and the question, permission or plan card above the composer. The header shows
  repo · branch, mode, model, effort, the state, the prompt cache countdown and the related
  sessions. Resume, interrupt, mode, model (with the warm-cache warning), effort, auto-approve,
  archive and kill are all here.
- **Composer**: photos from the picker, the follow-up suggestion, and Enter to send on a keyboard
  cover (Shift+Enter for a new line).
- **Background notifications**: a foreground service follows `/api/stream`. An ongoing
  notification counts the sessions waiting on you, and a session that starts waiting gets a popup
  that opens it. On by default, off in Settings.
- **Pairing**: host, port and HTTPS, tested before saving, or a link that fills everything in
  (the same one the iOS app takes): `hooked://connect?host=192.168.1.20&port=4123` (add
  `&https=1` behind TLS).

## Build

Needs the Android SDK (Android Studio, or the command-line tools with `ANDROID_HOME` set); mise
pulls Java for this task only. From the repo root:

```sh
mise run android
```

That builds a release APK signed with the debug key, installs it on the device adb sees (USB, or
`adb connect <ip>:<port>` for wireless debugging) and starts it. With no device, it prints the APK
path. Unit tests: `cd android && ./gradlew test`.

The fonts in `res/font` are the dashboard's (`static/fonts`), converted from woff2 to TTF.

## Pair

The tablet has to reach the machine (same LAN, WireGuard or Tailscale), and hooked has to listen on
it: `HOST=0.0.0.0` when installing the service. Plain HTTP is allowed on purpose, as on iOS.

## Not done yet

- The Review, MCP and Trace lenses, the terminal, Stats, Digest, Memory, Cron and GitHub pages.
- Groups and tags can be read but not edited.
- The service re-reads the session list at most every 10 s while the stream ticks.
