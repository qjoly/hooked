# hooked desktop, native (Rune)

An experiment: the dashboard rebuilt as a native app with [Rune](https://github.com/anomalyco/rune),
a GPU-rendered Rust UI framework, instead of the Tauri webview in `desktop/`. It ships its own UI and
talks to the hooked service on `localhost:4123` (`HOOKED_URL` overrides it) through the same HTTP API
and event streams the web dashboard and the iOS app use.

```sh
mise run desktop-rune-dev   # run from source
mise run desktop-rune       # build, install "/Applications/hooked (Rune).app" and relaunch it
```

Ghostty's terminal core (`libghostty-vt`) is built from source with Zig; the mise tasks pull Zig
0.17.1 along with Rust, so there is nothing to install by hand.

The installed app has its own bundle id (`dev.qjoly.hooked-rune`), so it sits next to the Tauri app.

## What is there

The layout follows the web dashboard; the look is hooked's datadog scheme as a rune-kit theme
(`src/theme.rs`): flat cool surfaces held apart by borders, 3 pt corners, a violet accent, and
session states coloured by how much they need you.

- **Top bar**: Deck, Sessions, Stats, Digest, Memory, Cron and GitHub, the palette (⌘K / ⌘P;
  ⌘⇧P or a leading `>` for commands only) with sessions, about 35 commands and full-text search
  over transcripts, 5H / 7D / Fable gauges, trash (restore deleted sessions), notifications,
  theme, settings (⌘,), `+ Session`, and a connection dot.
- **Shortcuts**: ⌥1 Deck, ⌥2 Sessions, ⌥4–7 Stats / Digest / Memory / GitHub, ⌘J terminal,
  ⌘⇧J new terminal, ⌘⇧D context panel, ⌘⇧F focus mode, ⌘⇧T theme, ⌘⇧S split, ⌘B sidebar.
- **Sidebar**: Sessions / Archived tabs with counts, last-24h filter, group by project
  (collapsible sections with a `+` each), cache countdown or age per row, × on hover to archive,
  resizable, folds to a rail (⌘B).
- **Session**: title, repo · branch, state, context gauge, prompt-cache badge, Resume, Archive,
  split, context panel, and a ⋯ menu (model, effort, permission mode, auto-approve, cost, open in
  editor or web, copy resume command, expand tool calls, restart, trash).
  - **Converse (1)**: transcript with markdown, Mermaid diagrams and collapsible tool calls,
    Edit / Write calls as inline diffs, pasted images, files sent with SendUserFile and
    `show_image` cards, the full text of long messages on demand, live streaming text, working
    indicator, question / permission / plan cards, composer (Enter sends, Shift+Enter new line,
    Esc interrupts, paste or drop images, `@` file and `/` command completion, a draft kept per
    session) with the follow-up suggestion.
  - **Review (3)**: Claude's edits or the working tree as a diff, unified or split, j/k between
    hunks and [ / ] between files; + on a line opens a comment thread, and the pending ones go to
    Claude in one message. Threads are shared with the web lens.
  - **MCP (4)**: the project's servers with their health, details, re-authenticate, log out.
  - **Trace (5)**: each turn's tool calls as a timed waterfall, input and output on click.
  - **Terminal (2)**: the session's shells over hooked's PTYs, one tab each, sized to the panel,
    emulated by Ghostty's VT core: its colours and styles, cursor shapes, window title, query
    replies, key encoding (application cursor keys, kitty keyboard protocol), bracketed paste,
    scrollback on the wheel, mouse clicks, drags and wheel for programs that track the mouse,
    drag to select and ⌘C to copy, and input-method composition (dead keys, CJK, emoji picker).
  - **Split (⌘⇧S)**: the most recent other session beside the current one, with its own reply box.
- **Context panel**: tasks, changes, agents, sub-sessions.
- **Pages**: Deck (awaiting you, answered, snoozed or followed up in place / working / recent),
  New session, Stats, Digest (generate and
  regenerate), Memory, Cron (create, edit, pause, run, delete), GitHub, Skills, Settings (theme,
  notifications, new-session defaults, digest, auto-compact, tags, git sync).
- **Organizing**: tags on rows and in the header, a tag filter in the sidebar, groups under their
  lead session (move, leave, rename, archive together), incognito mode for screen sharing, and
  Fork on any of your messages.
- **Outside the window**: a menu bar item with the waiting count and sessions; closing the window
  keeps the app running; ⌘⇧H (`HOOKED_QUICK_SHORTCUT` overrides it) opens a quick-reply panel on
  the sessions waiting on you; system notifications when one starts waiting (bundled app only).

## Not done yet

- Dictation (not planned).
- Dragging a session onto another to group it: the ⋯ menu's "Move to group…" does it instead.
- Settings has the main switches; the rest links to the web dashboard.
- Conversation: Fork from Claude's messages and with options, subagent transcripts, live
  background-job logs, video and audio cards, an in-app image viewer, copy / run buttons on code
  blocks, selecting a passage of a plan to comment on it, the GitHub Actions and Grafana windows.
- Review: branch scope, per-prompt filter, files rail with reviewed ticks, "Review with Claude",
  editing and listing threads, blame, go-to-definition, rendered Markdown diffs.
- Organizing: the group tab strip, more than one split pane, the cost breakdown, copying the
  conversation as Markdown.
- Deck: the fleet grouped by repo with search and filters, plans approved in place.
- Pages: Prompts, the account window, GitHub's reviews column and full PR detail, search on
  Memory and Skills, Cron run history, Digest date picker, the Usage block on Stats, the
  shortcut editor.

## Terminal: what is still missing

- Selection: double- and triple-click (word, line), selecting into the scrollback, Shift to
  select inside mouse-tracking programs (Rune reports no modifiers during a drag), OSC 52
  clipboard, right- and middle-click.
- Mouse: only the left button reaches programs; no motion without a button held.
- Rendering: cursor blink, strikethrough / overline / curly and coloured underlines, clickable
  links (OSC 8 and plain URLs), images (kitty graphics, sixel), a light palette, exact widths
  for emoji drawn from fallback fonts, a scrollback indicator, font and size settings, zoom.
- Behaviour: search in the scrollback, the bell, focus reporting, key releases and repeats for
  the full kitty keyboard protocol, Cmd+arrow / Cmd+Backspace, dropping a file to type its path,
  restarting an exited shell, batching redraws under heavy output.
- hooked: `!!command` output inline in the conversation, terminals in their own window or split.

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
