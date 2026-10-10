# CLAUDE.md for hooked

hooked is a local dashboard for Claude Code sessions. The front end is SvelteKit / Svelte 5. The back end is plain Node stdlib (`server/*` + `hook.cjs`), with a single runtime dependency for driving sessions: Anthropic's Agent SDK (`@anthropic-ai/claude-agent-sdk`). The MCP server (`mcp/server.cjs`) is a thin client that proxies the local HTTP API.

## Contributing

- **Never push to `main`.** All code lands through a pull request, so the history stays a real changelog.
- Write all code in English: identifiers, comments, commit messages.
- A PR body is a plain list of the features added, nothing else. One line per user-visible
  change. Leave out implementation details (helper names, files touched, state shapes, test
  counts): reviews go feature by feature, and the diff already shows how.

## Dev workflow (a recurring source of confusion)

- **Restarting hooked means `mise run deploy`, never a manual kill.** Driven sessions live inside
  the hooked process, so any restart also kills the Claude session that runs the command. That is
  unavoidable and expected. `mise run deploy` is the only clean path: it rebuilds, restarts the
  service (`launchctl kickstart -k` / systemd `restart`), and on boot `resumeDrivenSessions()`
  brings back the sessions from the last snapshot. A session that was mid-turn gets an automatic
  "Continue" and picks up where the restart cut it off. Killing the process any other way
  (`pkill node`, killing port 4123, `launchctl unload`...) kills the session with no rebuild, no
  restart and no resume. Claude ends up killing itself for nothing.

- `npm run live` (Vite, `:4123`, `--strictPort`) is the live workflow to prefer. It gives front-end HMR and server reloads. The SvelteKit dev server runs the `/api/*` endpoints (`+server.js`) in-process, and Vite re-executes changed `server/*` / `$lib/server/*` modules on the next request, so a back-end change takes effect with no rebuild or restart. It uses the same port as prod (4123); `strictPort` fails loudly if `node build` still holds the port, instead of drifting to 4124.
- `npm run dev` (Vite, `:5173`) is the same as `live`, on Vite's default port.
- `npm start` (`node build`, prod, usually `:4123` through `PORT`) does not reload. After any change, run `mise run deploy` (build plus service restart, see the first bullet). **Never run `npm run build` on its own, not even "just to check it compiles":** it rewrites `build/` under the running service and kills hooked. To check without deploying, run `npm test`. The restart is needed because:
  - the server bundle is loaded into memory at startup;
  - the served HTML points to asset hashes fixed at build time;
  - `static/` is served by sirv, which lists the folder at startup. A file added later (a font, say) returns 404 until the next restart.
- hooked is a SPA. Moving between sessions is client-side routing, so the tab keeps the old JS. Loading new code takes a full browser reload (Cmd+Shift+R), not an in-app click.
- Before concluding that something doesn't work, make sure you are testing the latest build (restarted `node build` process plus a hard reload), especially in Gecko/Firefox.

## Driving sessions (`server/agent.js`)

Claude Code sessions run inside the hooked process, through the Agent SDK's `query()` in streaming input/output mode. `server/agent.js` keeps a `session_id → live entry` registry and exposes all the controls: launch, reply, interrupt, mode, model/effort, kill/restart, and answers to questions, plans and permissions.

- **The registry is pinned on `globalThis`** (`Symbol.for('hooked.agent.registry')`). Otherwise
  Vite re-executing the module after a back-end change in `npm run live` would start from an empty
  registry and lose the running sessions. They live in this process, not in a detached tmux.
- **A running turn does not survive a hooked restart, but the session does.** The process dies
  with hooked (the accepted cost of hooked owning the process). A snapshot of the driven set is
  kept up to date in `driven-sessions.json` and replayed at startup: `resumeDrivenSessions()`
  relaunches each entry with `--resume`, one after the other. A session that was waiting comes
  back with no prompt, so it uses no turn. A session killed mid-turn (`busy` in the last snapshot)
  gets an automatic "Continue", because the restart stole its turn (`HOOKED_NO_CONTINUE=1` turns
  off that prompt but keeps the resume). Safeguards: at most 6 sessions per boot, and nothing wakes
  up if the snapshot is more than 12 h old. A hooked that has been off for a week should not spawn
  six CLIs at login. `HOOKED_NO_RESUME=1` turns the mechanism off. The snapshot is written by
  polling (every 10 s), not on each mutation of `live`: six places mutate the registry, and missing
  one would leave a wrong file. The Resume button covers everything else.
- **"Ended" is not "archived".** A restart kills the subprocesses, which fires `SessionEnd` and
  marks them `ended`. `isSessionArchived()` used to treat that as archived, so the session left
  the active list and had to be fished out of the Archived tab. An ended session now counts as
  archived only once it is cold (24 h without activity, see `isFinishedAndCold` in `format.js`).
  Explicit archiving still moves it right away.
- **Global hooks keep running.** `settingSources` stays at its default (all sources), so
  `~/.claude/settings.json`, and through it `hook.cjs` and `events.jsonl`, runs for SDK sessions the
  same way as for a session opened by hand. **Do not pass `settingSources: []`:** it would cut off
  pending questions and plans, todos, background jobs and the statusline in one go. Checked end to
  end: a session launched through the SDK does write `SessionStart` / `UserPromptSubmit` / `Stop`
  to `events.jsonl`.
- **Two layers deliberately overlap for state.** The registry is authoritative for a driven
  session: the `canUseTool` promise is the wait itself, so the two cannot drift apart. Hook events
  remain the fallback, and the only source for a session opened outside hooked. That session stays
  visible and up to date; it just can't be driven.
- **`canUseTool` blocks Claude** until the promise resolves. There are three cases, and only one
  can be pending at a time:
  - `AskUserQuestion` returns `{behavior:'allow', updatedInput:{…, answers}}` (`answers` maps
    question text to label, comma-separated for multi-select);
  - `ExitPlanMode` returns `allow` (plus `setPermissionMode` to `acceptEdits`/`auto`) to approve,
    or `deny` with the feedback as the message to reject;
  - any other tool is a permission request. The UI shows it as a 3-option AskUserQuestion
    (`Allow once` / `Allow always` / `Deny`), so the existing `Question` component renders it with
    no extra front-end code, and tools can be approved from the web (this used to need the
    Terminal tab, so tmux). **The option order is a contract** with the dispatch in
    `answerPendingSelection` (index 0/1/2).
- **Always release a pending wait before killing or interrupting.** A `canUseTool` promise left
  pending blocks the subprocess on exit. `readLoop` (in its `finally`), `interruptSession` and
  `killSession` all resolve it.
- **The user's profile environment has to be injected by hand.** The old driver started `claude`
  through `$SHELL -l -i -c …`, so `~/.zprofile` / `~/.zshrc` were sourced. The SDK spawns the CLI
  with hooked's environment, which under launchd is a PATH frozen when the service was installed.
  Measured: 26 PATH entries lost (`~/.krew/bin`, `~/.nix-profile/bin`, `~/go/bin`, `~/.local/bin`,
  `/sbin`, `/usr/sbin`...) along with real variables (`GITHUB_TOKEN`, `NIX_SSL_CERT_FILE`,
  `K9S_CONFIG_DIR`...). The result was `kubectl` without its OIDC auth plugin and `gh` without a
  token. `loginEnv()` therefore resolves the login shell's environment once (about 1.8 s, async,
  cached on `globalThis`, warmed up at import) and passes it to the SDK as `env`. The merge order
  is `{...process.env, ...profile}`, so the profile wins, as before. Variables that belong to the
  resolving shell (`PWD`, `SHLVL`, `TMUX*`, `__MISE_*`) are filtered out, since injecting them
  would be wrong.
  > Keep in mind: if a profile exported `ANTHROPIC_API_KEY`, every session would switch to API
  > billing instead of the subscription. That was already true with tmux, and it is still a trap.
- **`bypassPermissions` skips `canUseTool` for ordinary tools**, but not for `AskUserQuestion` /
  `ExitPlanMode`. Checked live in both `auto` and `bypassPermissions`: both deliver the question
  to the callback. In bypass mode you lose the permission card, which is the point of the mode,
  but you keep questions and plans. The SDK prints a warning on every launch in this mode. It is
  noise, not a bug.
- **No statusline runs for a driven session**, because the statusline is rendered by the TUI. The
  `statusline-tap.sh` tap has nothing to drop for these sessions, so everything that only exists
  there (context fill, freshly rendered 5 h / 7 d rate limits) stayed frozen on the last terminal
  opened by hand. `server/agent-status.js` queries the `Query` instead (`getContextUsage()` plus
  `usage_EXPERIMENTAL_…()`, the latter looked up by prefix because its name will change once it is
  stable) and writes to `STATUS_DIR` in the statusline format. One format, two producers, with
  `status.js` / `stats.js` / the UI unchanged. It refreshes at the end of each turn, throttled to
  every 15 s during a turn, best effort. On the reading side, between a snapshot and the
  `/api/oauth/usage` poll, the fresher one wins: a three-day-old file must not freeze the gauges.

- The first prompt is sent right away. The SDK buffers input until the CLI is ready, so there is nothing to wait for or detect.

- **The prompt cache lives on the server, not in the process.** It is keyed on the exact bytes of
  the prefix (tools, then system, then messages) and lives for 1 h after the start of the last
  request (the CLI's automatic TTL on a subscription within plan limits; 5 min in overage or with
  an API key). Each read refreshes it for free. A CLI that is alive but idle keeps nothing warm,
  and a `--resume` finds the cache again if the rebuilt prefix is identical. Measured over 45 days
  of transcripts: 93% hits for pauses up to 55 min, 2% past 1 h, and a third of the misses could
  have been avoided. One cause was hooked passing the snapshot's `model` on every resume, which
  overwrote the choice made during the session (opus ↔ fable on every deploy, 300k+ tokens
  re-cached each time). Hence:
  - on resume, never pass `model` (the CLI restores the transcript's model; `--model` overrides
    it), and pass the same `effort` explicitly (the CLI does not restore it, see
    claude-code#66005). This is `resumeLaunchArgs()`, pure and tested; the snapshot stores the
    effective effort;
  - the cache model lives in `src/lib/promptCache.js` (pure, shared by server and UI). The
    registry timestamps each request (`isRequestStart`) and keeps `lastUsage` from the `result`
    (equal to the CLI's `context_tokens`, checked live). On resume, the clock is seeded from the
    transcript;
  - **Auto-compact** (hooked setting `autoCompact`, off by default, threshold `minContextK` =
    100k) sends `/compact` about 5 min before expiry (at 55 min with the 1 h TTL) to every driven
    session that is waiting for a reply. Compacting while the cache is warm reads the conversation
    at the cache-read price and leaves a summary, so coming back 2 h or a day later re-caches the
    summary instead of the whole thread. Checked live: a `/compact` pushed into the SDK input is a
    separate turn, closed by a `result` (`turns: 0`) with no assistant message, and it does read
    the cached prefix. It never runs on a cold cache, never during a question (`canUseTool` blocks
    the turn), and never below the threshold (a cold re-cache is cheap there, and compacting would
    lose the thread for nothing). It doesn't repeat: `compact_boundary` resets the clock and size
    to unknown, so the session only becomes eligible again after a real turn. Compaction loses
    information, which is why it is opt-in. In the conversation, a compaction shows as a single
    system line, and neither the summary (`isCompactSummary`) nor the echo of a bare `/compact` is
    shown as a "You" bubble;
  - **switching models mid-session throws the cache away** (caches are per model). The SDK hook
    `PreModelSwitch` refuses a `setModel` that hooked requested while `prompt_cache_warm` is true,
    and `/api/model` answers `{ held, cacheImpact }` with the CLI's numbers; the UI asks for
    confirmation and resends with `force`. Checked live: the hook decides before `setModel()`
    resolves.

## Session groups (`server/sessionMeta.js`, `GroupTabs.svelte`)

Every session belongs to exactly one group. A session on its own is an implicit one-member group
(nothing stored, rendered exactly as before). The panels (sidebar, Deck fleet) list groups, through
`groupUnits()` in `state.svelte.js`.

- **A group is identified by its parent session.** Storage is in `session-meta.json`: each child
  carries `groupOf: <parent>` (plus `groupAt`, which orders the children), and the parent carries
  the optional `groupName`. Groups are one level deep: chains are flattened and cycles dropped on
  read.
- **Automatic MCP link.** The CLI exposes no session id to its MCP servers, so hooked injects
  `HOOKED_LAUNCH_KEY` (the registry entry's `launchKey`) into the env of the `mcp/server.cjs`
  proxy. `start_session` sends it back as `parentKey`, and `launchSession` puts the new session in
  the caller's group. This only works when the caller is driven by hooked; a session opened by
  hand has no key.
- **Archiving the parent archives the whole group.** A child is archived on its own and stays in
  its group.

## Incognito mode (`ui.incognito`, `incognito` flag in `session-meta.json`)

This is for screen sharing. While the mode is on, the dashboard shows only the sessions marked
incognito. The mode itself is local to the browser (localStorage), since it is a display state.
The flag lives on the server (`session-meta.json`), so the set of sessions survives a reload and
follows you from one browser to another.

- **The server sets the flag at launch**; the front end never guesses it. `launchSession` marks the
  new session if the dashboard asked for `incognito`, or if its parent is incognito (MCP
  `start_session` / `groupWith`), and `forkSession` copies it from the original session. Without
  that inheritance, a sub-session created in the middle of a demo would vanish from the screen the
  moment it was born.
- **There is one filtering point: `data.sessions`** (`state.svelte.js`). The raw server list lives
  in `raw`, and `data.sessions` is the filtered view. Every panel (sidebar, Deck, splits, group
  picker, palette) reads it, so none of them has its own filter. `loadSessions`, on the other hand,
  compares freshness on `raw`: in incognito the view is empty until `ui.meta` comes back, and
  relying on it would stop the resync from ever firing.
- **Filtering the lists is not enough.** A session pane renders its conversation by id. The
  `hidden()` guard in `session/[id]/+page.svelte` hides the pane instead of redirecting; being
  declarative, there is nothing to undo, and it fixes itself once `ui.meta` arrives. Two other
  leaks get the same treatment. Notifications: `checkNotifications` receives the visible list,
  because a system popup with the title of a hidden session is exactly what the mode prevents.
  Full-text search: it runs on the server and ignores the mode, so `CommandPalette` drops hits from
  hidden sessions.
- **Tags are filtered separately.** `allTags()` / `tagUsage()` read `ui.tags`, not
  `data.sessions`. Without a guard, the filter bar, the modal's suggestions and the settings tag
  manager would name hidden sessions. Toggling the mode also clears `ui.tagFilters` (transient
  state): an active filter on a tag that just disappeared from the bar would empty the sidebar with
  nothing to explain why.
- **Out of scope:** Stats and Digest, which aggregate every session without going through
  `data.sessions`.

## What the move away from tmux removed

These were removed because they were tmux-specific and have no equivalent: the Terminal tab (an xterm mirror of a pane), the MCP tool `show_in_pane`, `Copy attach` / `tmux attach`, the tmux sidebar (`tmux/`), and driving a session started outside hooked (that relied on `send-keys`). The remote-control daemons are kept. They are now detached processes supervised through a PID file (`rc-daemons.json`) and recognized in the dashboard through `HOOKED_RC=1`, which `hook.cjs` copies into an `rc` flag.

These no longer need to exist and must not come back: parsing the spinner, the mode footer or the ghost text; comparing screen captures to guess "still writing vs done"; ink anti-coalescing delays between keystrokes; accepting the trust dialog; clearing the re-injected prompt after an Escape; confirming the "the conversation will be re-read" dialog after `/model`; and all the concurrent capture warm-up (`warmPaneCaptures`), which only existed because `capture-pane` was synchronous and blocked the event loop.

## MCP lens (`server/mcp.js`, `Mcp.svelte`)

`/mcp` used to be a CLI TUI screen. Now that sessions live in the hooked process through the Agent
SDK, there is no interactive terminal to open it in, so a server that fell back to *Needs
authentication* could not be fixed from hooked. The workspace's MCP lens (key `4`, next to
Converse / Review) replaces it. It is built on the non-interactive subcommands
`claude mcp list|get|login|logout`.

- **It is a session lens, not a nav page.** MCP scopes are per directory, so the lens uses the open
  session's `project`. The project picker (and the `Browse…` button) of the old `/mcp` page no
  longer has a reason to exist. `SessionDetail` swaps the `id` prop without remounting, so
  `Mcp.svelte` refetches from an `$effect` that tracks `project`.
- **We parse the text output of `claude mcp list`** rather than reading config files. It is the
  only source that health-checks every server and also sees claude.ai connectors (they live on the
  account, not on disk). There is no JSON mode, so the format is the contract, pinned by
  `test/mcp.test.mjs` on verbatim captures (`test/fixtures/mcp/`). The scope is inferred from disk
  (`~/.claude.json` + `.mcp.json`): that is free, whereas `claude mcp get` would cost one
  health-checked spawn per server.
- **`claude mcp login` runs under a real PTY** (node-pty), not `spawn`. It prints the URL as OSC-8
  hyperlinks and, for a regular OAuth server, waits on stdin for the redirect URL to be pasted
  back. The PTY keeps that process alive between the two HTTP calls, so logins live in a registry
  pinned on `globalThis` (same reason as sessions and terminals).
- **`--no-browser` is always passed.** The browser has to open on the machine that is viewing the
  dashboard, not the one running it. The URL is shown as a link; when both machines are the same,
  the OAuth callback lands on localhost and the CLI finishes on its own.
- **A claude.ai connector leaves the flow right after printing the URL.** Approval then happens on
  the website, so "the process exited" does not mean "you are authenticated" there. That is what
  the `outOfBand` flag in the snapshot is for, along with the separate message on the page.
- `stripCliAnsi` is not `agent.js`'s `stripAnsi` (which only removes CSI sequences). Without
  removing OSC-8 too, the URL shows up twice on the line. The names must stay distinct:
  `server/index.js` re-exports with `export *`, and an ambiguous name silently disappears from the
  barrel.

## Workflows (`Workflow` tool): two sources, never both at once

The dock's "Workflows" card (see `server/workflows.js`) rebuilds what the CLI's `/workflows` shows.
The trap that shapes everything:

- **`<proj>/<session>/workflows/<runId>.json` is only written at the end** of the run (or when it
  is killed), in one go, never during. It holds `workflowProgress[]`, the TUI's exact model
  (labels, `phaseTitle`, states, tokens, tool calls, previews). When it exists, it is
  authoritative.
- **During the run**, the only files are `<session>/subagents/workflows/<runId>/journal.jsonl`
  (`{type:"started"|"result", key, agentId}`) and one `agent-<id>.jsonl` per started agent.
  Neither the `label`s nor the agent-to-phase mapping exist on disk while the run is going (the CLI
  keeps them in memory), so don't guess them. We show the phases declared in the script's `meta`,
  and tell agents apart by the first prompt line that is unique to them (the shared preamble is
  stripped).
- The TUI's token counter is the peak context of a single request
  (`input + cache_read + cache_creation`), not cumulative usage. Summing usages overestimates it by
  a factor of about 30.
- A run's paths are derived from the session transcript, never from the absolute paths recorded in
  `toolUseResult`. A data source is not a trust source, and a relocated tree stays readable.
- The launch (`toolUseResult.status === "async_launched"`) and the completion
  (`<task-notification>`, with the same three redundant carriers as `server/background.js`) both
  live in the main transcript.

## Svelte 5

- Reactivity trap: `if (term && x) …` short-circuits when `term` is null (it is created asynchronously), so the prop `x` is never read and therefore never tracked as a dependency. A change to `x` then does not re-run the effect. Read tracked dependencies before the guards.

## Tests

- `npm test` (Vitest) runs characterization tests on fixtures (`test/fixtures/…`, overridden through `HOOKED_DATA_DIR` / `HOOKED_PROJECTS_DIR`). It is the back end's regression safety net.
- Deriving state from the SDK stream is pure and tested without launching a session: `applyMessage(st, msg)` (`test/agentState.test.mjs`) and `refineWithAgent(state, alive, sdkState)` (`test/refineState.test.mjs`).
- For a real end-to-end driving test, call `launchSession` / `deliverReply` / `killSession` from `server/agent.js` with `HOOKED_DATA_DIR` pointing at a tmpdir and a throwaway project. It uses a real turn, so keep it out of `npm test`.
