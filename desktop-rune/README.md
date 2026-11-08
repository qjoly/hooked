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

- **Top bar**: Deck, Sessions, Stats, Digest, Memory, Cron and GitHub, the
  search-launch-command palette (⌘K / ⌘P), 5H / 7D / Fable gauges, notifications, theme,
  settings (⌘,), `+ Session`, and a connection dot.
- **Sidebar**: Sessions / Archived tabs with counts, last-24h filter, group by project
  (collapsible sections with a `+` each), cache countdown or age per row, × on hover to archive,
  resizable, folds to a rail (⌘B).
- **Session**: title, repo · branch, state, context gauge, prompt-cache badge, Resume, Archive,
  split, context panel, and a ⋯ menu (model, effort, permission mode, auto-approve, cost, open in
  editor or web, copy resume command, expand tool calls, restart, trash).
  - **Converse (1)**: transcript with markdown and collapsible tool calls, live streaming text,
    working indicator, question / permission / plan cards, composer (Enter sends, Shift+Enter
    new line, Esc interrupts, paste or drop images) with the follow-up suggestion.
  - **Review (3)**: Claude's edits or the working tree as a diff, unified or split, j/k between
    hunks and [ / ] between files.
  - **MCP (4)**: the project's servers with their health, details, re-authenticate, log out.
  - **Trace (5)**: each turn's tool calls as a timed waterfall, input and output on click.
  - **Terminal (2)**: the session's shells over hooked's PTYs, one tab each.
  - **Split (⌘⇧S)**: the most recent other session beside the current one, with its own reply box.
- **Context panel**: tasks, changes, agents, sub-sessions.
- **Pages**: Deck (awaiting you / working / recent), New session, Stats, Digest (generate and
  regenerate), Memory, Cron (create, edit, pause, run, delete), GitHub, Settings (theme,
  notifications, new-session defaults, digest, auto-compact, tags, git sync).
- **Outside the window**: a menu bar item with the waiting count and sessions; closing the window
  keeps the app running; ⌘⇧H (`HOOKED_QUICK_SHORTCUT` overrides it) opens a quick-reply panel on
  the sessions waiting on you; system notifications when one starts waiting (bundled app only).

## Not done yet

- Dictation, review comment threads, the Skills page, tags editing, session groups and
  drag-and-drop between them, incognito mode, fork.
- Terminals open at 120×28 and don't follow the panel's size.
- Settings has the main switches; the rest links to the web dashboard.

## Checking it headless

Rune renders any app without a window, which is how the layout was checked:

```sh
cargo run -- --snap /tmp/deck.png --size 1440x900
cargo run -- --snap /tmp/session.png --size 1440x900 -- --session <id>
cargo run -- --snap /tmp/new.png --size 1440x900 -- --new
cargo run -- --snap /tmp/review.png --size 1440x900 -- --session <id> --lens review   # mcp, trace
cargo run -- --snap /tmp/stats.png --size 1440x900 -- --page stats   # digest, memory, cron, github, settings
cargo run -- --snap /tmp/split.png --size 1600x900 -- --session <id> --split
cargo run -- --window quick --snap /tmp/quick.png --size 760x500
```

With these flags the app loads the data synchronously before the first frame, so the PNG shows it.
