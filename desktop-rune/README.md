# hooked desktop, native (Rune)

An experiment: the dashboard rebuilt as a native app with [Rune](https://github.com/anomalyco/rune),
a GPU-rendered Rust UI framework, instead of the Tauri webview in `desktop/`. It ships its own UI and
talks to the hooked service on `localhost:4123` (`HOOKED_URL` overrides it) through the same HTTP API
and event streams the web dashboard and the iOS app use.

```sh
mise run desktop-rune-dev   # run from source
mise run desktop-rune       # build, install "/Applications/hooked (Rune).app" and relaunch it
```

The installed app has its own bundle id (`dev.qjoly.hooked-rune`), so it sits next to the Tauri app.

## What is there

The layout follows the web dashboard; the look is Rune's neutral kit theme.

- **Top bar**: Deck / Sessions spaces (badge = decisions waiting), search-launch-command palette
  (⌘K / ⌘P), 5H / 7D / Fable rate-limit gauges, notifications and theme toggles, `+ Session`, a
  connection dot.
- **Sidebar**: Sessions / Archived tabs with counts, last-24h filter, group by project (collapsible
  sections with a `+` per project), cache countdown or age per row, × on hover to archive, resizable,
  collapses to a rail (⌘B).
- **Session**: back, title, repo · branch, state badge, context gauge, prompt-cache badge, Resume,
  Archive, context-panel toggle, and a ⋯ menu (model, effort, permission mode, auto-approve, cost,
  open in editor / web, copy resume command, expand tool calls, restart, trash).
  Lenses: Converse (1), Review (3), MCP (4), Trace (5).
- **Converse**: transcript with markdown and collapsible tool calls, live streaming text, working
  indicator with elapsed time, question, permission and plan cards, composer (Enter sends,
  Shift+Enter new line, Esc interrupts) with the follow-up suggestion.
- **Context panel**: tasks, changes (opens Review), agents, sub-sessions.
- **Deck**: awaiting you / working / recent cards. **New session**: project, prompt, model, effort,
  permission mode.
- **Menu bar** item with the waiting count and the waiting sessions; closing the window keeps the app
  running; ⌘⇧H brings it back on the oldest waiting session; system notifications when a session
  starts waiting on you (bundled app only).

## Not done yet

- MCP and Trace lenses link to the web dashboard; Review shows Claude's edits as plain -/+ blocks,
  without the working-tree diff or comment threads.
- No Stats, Digest, Memory, GitHub, Cron, Settings, split view, terminals, image attachments,
  dictation or quick-reply window.

## Checking it headless

Rune renders any app without a window, which is how the layout was checked:

```sh
cargo run -- --snap /tmp/deck.png --size 1440x900
cargo run -- --snap /tmp/session.png --size 1440x900 -- --session <id>
cargo run -- --snap /tmp/new.png --size 1440x900 -- --new
```
