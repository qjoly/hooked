# hooked desktop

The dashboard as a native app, built with [Rune](https://github.com/anomalyco/rune), a GPU-rendered
Rust UI framework, with no webview and no Svelte build behind it. It ships its own UI and talks to
the hooked service on `localhost:4123` (`HOOKED_URL` overrides it) through the same HTTP API and
event streams the web dashboard, the iOS app and the Android app use.

```sh
mise run desktop-dev   # run from source with live editing
mise run desktop-run   # run from source once, no live editing
mise run desktop       # build, install /Applications/hooked.app and relaunch it
mise run desktop-windows   # cross-compile a Windows .exe, from macOS or Linux
```

`mise run desktop` also redeploys the hooked service (`mise run deploy-if-stale`) when its build
lags behind the checkout, so the new app never starts against a back end that lacks its endpoints.
That restart cuts the turn of every driven session, the one running the task included.

The launcher (`launcher/`) runs the same recipe (`scripts/install-app`) after it switches the
service to a branch: it rebuilds and reinstalls the app from that branch, and reopens it only if it
was running.

`pr-gate/` is the window a session must get through before it opens a pull request. `mise run
pr-gate` builds it into `~/.claude/hooked/bin/pr-gate`; while that binary exists and the
`prGate` setting is on, the hooked MCP server tells every session to call it before `gh pr
create`. Its requests queue in `~/Library/Application Support/pr-gate`: one window serves every
session and quits once the queue is empty.

Ghostty's terminal core (`libghostty-vt`) is built from source with Zig; the mise tasks pull Zig
0.17.1 along with Rust.

`desktop-windows` targets `x86_64-pc-windows-gnu` through `cargo-zigbuild`, Zig standing in for the
MinGW toolchain. The `.exe` is all there is to copy: no installer. On Windows the hooked service runs
in WSL2 (see the main README), and the app reaches it on `localhost:4123` as the browser does.

`desktop-dev` goes through Rune's live-editing tool (`scripts/rune-dev` in the pinned rune
checkout, driving `dx serve --hot-patch`): saving a file whose edits stay inside function bodies
patches the running app in place, state and window included; any other edit (a struct, a
signature, `Cargo.toml`) rebuilds and relaunches it. It needs the Dioxus CLI once:
`cargo install dioxus-cli --version 0.7.10 --locked`. The first run builds everything again under
the `rune-hot` profile, in its own target directory.

The bundle id stays `dev.qjoly.hooked-rune`: changing it would change the Application Support
folder and cost the app its preferences and its local-network permission.

## What is there

The layout follows the web dashboard; the look is the web's colour schemes as rune-kit themes
(`ui/src/theme.rs`): Coffee (the default), Indigo, Legacy, Datadog, Gruvbox and Claude, each in light
and dark, with rounded or square corners, picked in Settings or the palette.

The theme, the icons, the knobs and the pieces of the window both native apps draw (top bar,
connection dot, list rows, step marks) live in the `hooked-ui` crate (`ui/`), which the launcher
(`launcher/`) shares: it reads the look picked here, so the two always match.

- **Top bar**: Deck, Sessions, Stats, Digest, Memory, Cron, GitHub and Incidents (when the
  incident.io desktop app is installed), the palette (⌘K / ⌘P;
  ⌘⇧P or a leading `>` for commands only) with sessions, about 35 commands and full-text search
  over transcripts, 5H / 7D / Fable gauges, trash (restore deleted sessions), notifications,
  theme, settings (⌘,), `+ Session`, and a connection dot.
- **Shortcuts**: ⌥1 Deck, ⌥2 Sessions, ⌥4–8 Stats / Digest / Memory / GitHub / Incidents, ⌘J terminal,
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
    a branch as a diff, unified or split (unified in a narrow pane), compact or with its context,
    reloaded on demand, j/k between hunks and [ / ] between files; + on a line opens a comment
    thread, the pending ones go to Claude in one message and a reply in a thread goes to it at
    once. Threads are shared with the web lens, follow their code when it moves and say when it is
    gone. Each session comes back to the scope, prompts, branch pair and commits it was left on.
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
  worktrees (folder, branch naming, cleanup, auto-pull of main checkouts), tags, git sync, with a
  table of contents in place of the session list).
- **Incidents** (⌥8): incident.io through the desktop app's own binary, which is why the tab
  only exists where that app is installed and signed in (Settings → *incident.io* says which,
  and can turn the tab off; it is also hidden in incognito mode). Open, Mine, Post-incident,
  Closed and Merged lists with their counts, a text filter, severity chips and a chip per
  team you belong to (it narrows every list but Mine to that team and its sub-teams, and is
  remembered); the tab's badge counts the open incidents you take part in. A click previews an incident beside the list
  (summary, roles, participants, alerts, latest updates, AI investigation, fields), ⌘-click
  opens it in incident.io. From the preview: join the channel or the call, pin it as "my
  incident" for the desktop app, take a role, hand it to a new Claude session with a read-only
  brief. Tick several incidents to merge them into the one to keep (the one already being
  worked by default, or any reference you type), with what responders will see spelled out
  before the call and an Undo after it; open incidents whose names look alike are offered as a
  merge to review; merged incidents can be unmerged, one or several at a time. Each action
  needs its tool on the server and a connection that may write, else it is not shown.
- **Organizing**: drag a session (sidebar row or fleet card) onto another to group them, or onto
  a fleet repo header to take it out of its group; tags on rows and in the header, groups under their
  lead session (move, leave and rename from the session menu),
  incognito mode for screen sharing, Fork from any message with model, effort, mode and a first
  message, cost breakdown, copy as Markdown, focus mode, and up to four split panes.
- **Review**: selecting text in the diff paints its other occurrences in the accent; go to
  definition (⌘-double-click a name, or select it then F12, or ⌘-click a line number to pick one
  of its names): the declaration opens in a card under the line, with candidates when it is
  ambiguous, more lines on demand and Esc to close, and a ⌘-double-click on a name inside the card
  follows it, with a button back; a resizable files rail with reviewed ticks (v) that fold the file,
  binary files and who changed a file (a command, a subagent), a prompt filter, a branch picker
  (repo, branch and base with a filter, commits), Review with Claude, a resizable
  comments panel (edit, archive, restore, and a jump that brings back the scope a comment was
  written on), blame for the clicked line in every scope, rendered Markdown with added and removed blocks tinted (a
  resizable column: a click on a block selects its lines in the diff, a click on a line number
  scrolls to its block),
  and the full diff of a truncated change.
- **Outside the window**: a menu bar item with the waiting count and sessions; closing the window
  keeps the app running; ⌘⇧H (`HOOKED_QUICK_SHORTCUT` overrides it) opens a quick-reply panel on
  the sessions waiting on you; system notifications when one starts waiting (bundled app only).
- **Back to the latest message**: an arrow at the bottom right of the conversation, there only
  while it is scrolled away from its end.
- **Remote instances** (Settings → Feature flags, off by default, `src/remote.rs`): the sessions
  of other hooked services listed next to the local ones. A feature of this app alone: the
  switch and the instance list (name + URL, four at most) live in its prefs, and the hooked
  service knows nothing about it. A remote session carries a blue rail, a wash and a badge with
  its instance's name in the sidebar, the Deck, the fleet and its own header, is filed under
  `repo @ instance`, and says so in its notification. The app talks to each instance directly: a
  request that names a remote session (`id`, `session`, `sessionId`, `resumeId`) goes to the
  instance that owns it, so the conversation, the live stream, replies, questions, plans, tags,
  archive and Review work as they do locally. What belongs to a machine stays local and is not
  offered for a remote session: a new session, the shell panel, the MCP lens, open in editor. A
  group cannot span two instances. hooked has no authentication, so only add an instance
  reached over a trusted network. Full-text search, Stats and Digest stay local.

## Not done yet

- Dictation (not planned), the companion (decorative).
- Review: blame shows for the clicked line, not on hover, and go to definition takes a
  ⌘-double-click rather than a ⌘-click on the word, with no underline under the pointer
  (rune-kit's diff view reports neither the hovered line nor the clicked word, so the name comes
  from the text selection). Occurrences of the selection change colour rather than getting a
  background: the view takes no background for part of a line, so they go through the syntax
  highlighter.
- Windows: the build has not been run on a Windows machine yet. Labels still read ⌘, the session
  paths the service reports are WSL's (open in editor), and the incident.io binary is looked up
  at its macOS paths only.

## Terminal: what is still missing

- Rendering: sixel images (Ghostty's VT core has no sixel decoder).
- A terminal in its own window: rune gives each window its own app state, so it would need a
  second copy of the terminal's input handling; the side layout covers the use.

## Performance diagnostics

Off by default. Settings → *Performance diagnostics*, or `HOOKED_PERF=1` (`=0` forces it off),
records each frame's update and encode time, the bytes the UI thread allocated, input-to-encode
latency and the process footprint with [`rune-perf`](https://github.com/anomalyco/rune/tree/main/crates/rune-perf):
a bounded, local folder (`~/Library/Application Support/dev.qjoly.hooked-rune/perf`, `perf-headless`
for scripted runs, or `HOOKED_PERF_DIR`). `perf.json` is a snapshot of the last 60 s rewritten
every 2 s; `perf.log` and `perf-incident-NN.json` keep long and stalled frames.
`HOOKED_PERF_PORT=N` also serves procwatch's snapshot (per-thread CPU, live heap) on
`127.0.0.1:N`.

```sh
cargo build --release --features frame-profile   # adds per-phase CPU (view, commit, layout, paint)
HOOKED_PERF_SELF=<your session id> scripts/perf/run --runs 3   # idle-deck conv-scroll review-scroll terminal-busy sidebar-many
```

`scripts/perf/run` replays each scenario headless and prints frame time, thread CPU (with
`frame-profile`), view rebuilds, allocations and memory. Wall times follow machine load; compare
the CPU columns.

## Tuning layout and motion (⌘⇧K)

`desktop-dev` and `desktop-run` build with the `knobs` feature, which adds
[rune-knobs](https://github.com/anomalyco/rune/tree/main/crates/rune-knobs)' side panel: ⌘⇧K
(or *Open the knobs panel* in the palette) opens it, and it tunes sidebar rows, the conversation's spacing and bubbles, the theme's radii,
font sizes and springs, and the terminal's padding while the app runs. `cargo build --release`
(so `mise run desktop`) leaves it out, and every knob reads its default.

Each component declares its knobs beside the code that reads them, with `knobs!` (`ui/src/knobs.rs`),
which registers the group through `rune-register`. A knob is named after its constant, so a
group's Copy gives lines like `BUBBLE_PAD = 10` that replace the matching `BUBBLE_PAD = 12.0`
line as is: paste them over the declaration to make them the new defaults.

`--knobs` opens the panel at launch, `--knobs <group>` on one group (for `--snap`):

```sh
cargo run --features knobs -- --snap /tmp/knobs.png --size 1440x900 -- --session <id> --knobs Bubble
```

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
cargo run -- --snap /tmp/menus.png --size 1440x900 -- --session <id> --snooze-menu   # --sort-menu, --filter-menu, --more-menu, --model-menu, --effort-menu
cargo run -- --snap /tmp/filter.png --size 1440x900 -- --session <id> --picker filter-repo   # filter-tag
HOOKED_INCIDENT_BIN=scripts/fake-incident cargo run -- --snap /tmp/inc.png --size 1440x900 -- --page incidents --incident INC-409   # --scope merged, --team, --merge
```

`scripts/fake-incident` stands in for the incident.io binary (`HOOKED_INCIDENT_BIN`; empty turns
the page off): the same MCP tools over made-up incidents kept in memory, so a merge and its undo
can be exercised without touching a real incident. `cargo test` runs them against it.

With these flags the app loads the data synchronously before the first frame, so the PNG shows it.
