# hooked desktop, native (Rune)

An experiment: the dashboard rebuilt as a native app with [Rune](https://github.com/anomalyco/rune),
a GPU-rendered Rust UI framework, instead of the Tauri webview in `desktop/`. It ships its own UI and
talks to the hooked service on `localhost:4123` (`HOOKED_URL` overrides it) through the same HTTP API
and event streams the web dashboard and the iOS app use.

```sh
mise run desktop-rune-dev   # run from source with live editing
mise run desktop-rune-run   # run from source once, no live editing
mise run desktop-rune       # build, install "/Applications/hooked (Rune).app" and relaunch it
```

Ghostty's terminal core (`libghostty-vt`) is built from source with Zig; the mise tasks pull Zig
0.17.1 along with Rust.

`desktop-rune-dev` goes through Rune's live-editing tool (`scripts/rune-dev` in the pinned rune
checkout, driving `dx serve --hot-patch`): saving a file whose edits stay inside function bodies
patches the running app in place, state and window included; any other edit (a struct, a
signature, `Cargo.toml`) rebuilds and relaunches it. It needs the Dioxus CLI once:
`cargo install dioxus-cli --version 0.7.10 --locked`. The first run builds everything again under
the `rune-hot` profile, in its own target directory.

The installed app has its own bundle id (`dev.qjoly.hooked-rune`), so it sits next to the Tauri app.

## What is there

The layout follows the web dashboard; the look is the web's colour schemes as rune-kit themes
(`src/theme.rs`): Coffee (the default), Indigo, Legacy, Datadog, Gruvbox and Claude, each in light
and dark, with rounded or square corners, picked in Settings or the palette.

- **Top bar**: Deck, Sessions, Stats, Digest, Memory, Cron and GitHub, the palette (⌘K / ⌘P;
  ⌘⇧P or a leading `>` for commands only) with sessions, about 35 commands and full-text search
  over transcripts, 5H / 7D / Fable gauges, trash (restore deleted sessions), notifications,
  theme, settings (⌘,), `+ Session`, and a connection dot.
- **Shortcuts**: ⌥1 Deck, ⌥2 Sessions, ⌥4–7 Stats / Digest / Memory / GitHub, ⌘J terminal,
  ⌘⇧J new terminal, ⌘⇧D context panel, ⌘⇧F focus mode, ⌘⇧T theme, ⌘⇧S split, ⌘B sidebar.
- **Sidebar**: sessions by status (Waiting, Working, Idle; Snoozed and Archived at the bottom,
  opening upward), by project (collapsible sections with a `+` each) or flat; last-24h filter, a
  repo and tag filter, cache countdown or age per row (wake time when snoozed), hover actions
  (group, tags, pin, incognito, snooze, split, archive), resizable, folds to a rail (⌘B).
- **Session**: title, repo · branch, state, context gauge, prompt-cache badge, Resume, Archive,
  split, context panel, and a ⋯ menu (model, effort, permission mode, auto-approve, cost, open in
  editor or web, copy resume command, expand tool calls, restart, trash).
  - **Converse (1)**: a full-width chat, your messages in accent bubbles on the right and
    Claude's on the left, with markdown, Mermaid diagrams and collapsible tool calls,
    Edit / Write calls as inline diffs, pasted images, files sent with SendUserFile and
    `show_image` cards, `show_video` / `show_audio` clips played in place (play, seek, sound,
    before and after side by side, the system player as a fallback), `!!command` as a live terminal you can type into, the full text of long
    messages on demand, live streaming text, working
    indicator, question / permission / plan cards, composer (Enter sends, Shift+Enter new line,
    Esc interrupts, paste or drop images, `@` file and `/` command completion, a draft kept per
    session) with the follow-up suggestion.
  - **Review (3)**: Claude's edits, the worktree since it forked from its base, the working tree or
    a branch as a diff, unified or split, j/k between hunks and [ / ] between files; + on a line
    opens a comment thread, and the pending ones go to Claude in one message. Threads are shared
    with the web lens.
  - **MCP (4)**: the project's servers with their health, details, re-authenticate, log out.
  - **Trace (5)**: each turn's tool calls as a timed waterfall, input and output on click.
  - **Terminal (2)**: the session's shells over hooked's PTYs, one tab each, sized to the panel,
    emulated by Ghostty's VT core: its colours and styles, cursor shapes, window title, query
    replies, key encoding (application cursor keys, the kitty keyboard protocol with repeats and releases), bracketed paste,
    scrollback on the wheel, every underline style, overline and strikethrough, OSC 8 and plain
    links (⌘-click), a blinking cursor, emoji and CJK kept to their two cells, kitty
    graphics images (PNG and raw pixels, cropped, above or below the text), a light palette in the light theme, ⌘+ / ⌘- / ⌘0 zoom, font family and size in Settings,
    focus reports, mouse clicks, drags and wheel for programs that track the mouse,
    drag to select (past an edge it scrolls the scrollback; Shift selects inside programs that
    track the mouse) and ⌘C to copy, middle-click pastes the selection, programs can set the
    clipboard (OSC 52) and hear the middle and right buttons and bare pointer motion, and input-method composition (dead keys, CJK, emoji picker).
  - **Terminal beside the conversation**: the panel's button (or the palette) moves the
    terminal from below the conversation to a resizable column beside it, and back.
  - **Split (⌘⇧S)**: the most recent other session beside the current one, with its own reply box.
- **Context panel**: tasks, changes, agents, sub-sessions, linked PRs and issues; Details opens
  the full panel (summary, checks with Fix in this thread, comments, timeline, per-file diff),
  which the GitHub page also opens beside its list (⌘-click opens GitHub instead).
- **Pages**: Deck (awaiting you, answered, snoozed or followed up in place; the fleet by repo
  as cards or a table, with its wheel (hover names a session, click opens it), a state filter
  from the legend, search, and archived groups folded at the bottom),
  New session, Stats, Digest (generate and
  regenerate), Memory, Cron (create, edit, pause, run, delete), GitHub, Skills, Settings (theme,
  color scheme, corners, notifications, default page, new-session defaults, digest, auto-compact,
  tags, git sync, with a table of contents in place of the session list).
- **Organizing**: drag a session (sidebar row or fleet card) onto another to group them, or onto
  a fleet repo header to take it out of its group; tags on rows and in the header, groups under their
  lead session with a tab strip (switch, make lead, leave, rename, new session in the group),
  incognito mode for screen sharing, Fork from any message with model, effort, mode and a first
  message, cost breakdown, copy as Markdown, focus mode, and up to four split panes.
- **Review**: go to definition (⌘-click a line number to pick one of its names, or double-click
  a name then F12): the declaration opens in a card under the line, with candidates when it is
  ambiguous, more lines on demand and Esc to close; a files rail with reviewed ticks (v), a prompt filter, Review with Claude, a
  comments panel (edit, archive, restore, jump), blame for the clicked line, rendered Markdown with added and removed blocks tinted,
  and the full diff of a truncated change.
- **Outside the window**: a menu bar item with the waiting count and sessions; closing the window
  keeps the app running; ⌘⇧H (`HOOKED_QUICK_SHORTCUT` overrides it) opens a quick-reply panel on
  the sessions waiting on you; system notifications when one starts waiting (bundled app only).

## Not done yet

- Dictation (not planned), the companion (decorative).
- Review: blame shows for the clicked line, not on hover, and go to definition starts from a
  line number or a selected name rather than a ⌘-click on the word (rune-kit's diff view
  reports neither the hovered line nor the clicked word).

## Terminal: what is still missing

- Rendering: sixel images (Ghostty's VT core has no sixel decoder).
- A terminal in its own window: rune gives each window its own app state, so it would need a
  second copy of the terminal's input handling; the side layout covers the use.

## Checking it headless

Rune renders any app without a window, which is how the layout was checked:

```sh
cargo run -- --snap /tmp/deck.png --size 1440x900
cargo run -- --snap /tmp/session.png --size 1440x900 -- --session <id>
cargo run -- --snap /tmp/new.png --size 1440x900 -- --new
cargo run -- --snap /tmp/review.png --size 1440x900 -- --session <id> --lens review   # mcp, trace
cargo run -- --snap /tmp/stats.png --size 1440x900 -- --page stats   # digest, memory, cron, github, settings
cargo run -- --snap /tmp/split.png --size 1600x900 -- --session <id> --split
cargo run -- --snap /tmp/panel.png --size 1440x900 -- --panel panels/progress   # a show_panel Luau script, with its state.json (add --panel-minimized for the pill)
cargo run -- --window quick --snap /tmp/quick.png --size 760x500
cargo run -- --snap /tmp/sidebar.png --size 1440x900 -- --session <id> --open-section archived   # any section
cargo run -- --snap /tmp/menus.png --size 1440x900 -- --session <id> --snooze-menu   # --sort-menu, --filter-menu
cargo run -- --snap /tmp/filter.png --size 1440x900 -- --session <id> --picker filter-repo   # filter-tag
```

With these flags the app loads the data synchronously before the first frame, so the PNG shows it.
