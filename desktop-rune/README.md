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
  (collapsible sections with a `+` each), cache countdown or age per row, hover actions (group, tags, pin, incognito, split, archive),
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
  lead session with a tab strip (switch, make lead, leave, rename, new session in the group),
  incognito mode for screen sharing, Fork from any message with model, effort, mode and a first
  message, cost breakdown, copy as Markdown, focus mode, and up to four split panes.
- **Review**: a files rail with reviewed ticks (v), a prompt filter, Review with Claude, a
  comments panel (edit, archive, restore, jump), blame for the clicked line, rendered Markdown,
  and the full diff of a truncated change.
- **Outside the window**: a menu bar item with the waiting count and sessions; closing the window
  keeps the app running; ⌘⇧H (`HOOKED_QUICK_SHORTCUT` overrides it) opens a quick-reply panel on
  the sessions waiting on you; system notifications when one starts waiting (bundled app only).

## Not done yet

- Dictation (not planned), the companion (decorative).
- Dragging a session onto another to group it: the group tabs and the ⋯ menu do it instead.
- Review: the branch scope (a branch against its base, a range of its commits) and
  go-to-definition. Blame shows for the clicked line, not on hover. Markdown renders beside
  its diff without the per-block tint.
- Conversation: the Grafana query window; video and audio open in the system player.
- Deck: the fleet grouped by repo with search and filters.
- GitHub: the full pull-request panel (summary, timeline, code); the context panel shows the
  PR's state and checks, which open the Actions run window.

## Terminal: what is still missing

- Selection: selecting into the scrollback, Shift to select inside mouse-tracking programs
  (Rune reports no modifiers during a drag), OSC 52 clipboard, right- and middle-click.
- Mouse: only the left button reaches programs; no motion without a button held.
- Rendering: cursor blink, strikethrough / overline / curly and coloured underlines, clickable
  links (OSC 8 and plain URLs), images (kitty graphics, sixel), a light palette, exact widths
  for emoji drawn from fallback fonts, font and size settings, zoom.
- Behaviour: search in the scrollback, focus reporting, key releases and repeats for
  the full kitty keyboard protocol, batching redraws under heavy output.
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
