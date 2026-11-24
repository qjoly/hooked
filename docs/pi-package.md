# hooked's pi package

`pi-package/` is a pi package: the part of hooked that runs **inside** every pi session hooked
drives. It brings to pi what Claude Code gives hooked natively, so a pi session gets the same cards
and controls in the dashboard as a Claude session.

| Feature | Claude Code | pi with the package |
|---|---|---|
| hooked's tools (start_session, groups, review comments, PR watch, show_image…) | MCP server `hooked` | native tools `hooked_*`, same definitions (`mcp/server.cjs`) |
| Questions | `AskUserQuestion` | `AskUserQuestion`, same schema |
| Plan mode | `ExitPlanMode` + permission mode | `ExitPlanMode` + the package's mode |
| Todo list in the dock | `TodoWrite` / `TaskCreate` | `TodoWrite`, same schema, read back from the pi session file |
| Subagents | `Agent` | `Agent`: a separate `pi --mode json -p` on the current model (below) |
| Workflows | `Workflow` | `Workflow`: the same script API (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, schemas), each agent a subagent as above; no resume, no worktree isolation |
| Web pages | `WebFetch` | `WebFetch`, same parameters: the page as text (no small-model summary), asks in the normal mode |
| Web search | `WebSearch` | `WebSearch`, same parameters: one headless, traceless `claude -p` on Haiku with only WebSearch (the user's Claude login), asks in the normal mode |
| Background commands | `Bash run_in_background`, `BashOutput`, `KillShell` | `BashBackground`, `BashOutput`, `KillShell`; the end of a command wakes the agent with a `<task-notification>`, and the dock lists the jobs |
| Permission cards | `canUseTool` | `tool_call` gate |
| Modes, auto-approve | SDK `setPermissionMode` | `/hooked-mode`, `/hooked-auto-approve` commands |
| 5h / 7d quotas | statusline / `usage_…()` | `after_provider_response` headers (pi-claude-bridge) |

## How it is loaded

`server/piAgent.js` adds `-e <checkout>/pi-package` to every pi it launches, and passes:

| Variable | Meaning |
|---|---|
| `HOOKED_DRIVEN=1` | the session is driven by hooked: dialogs become cards, the gate is on |
| `HOOKED_MCP_SERVER` | path of `mcp/server.cjs`, where the tool definitions come from |
| `HOOKED_PORT`, `HOOKED_LAUNCH_KEY`, … | hooked's MCP context, so `start_session` joins the caller's group |
| `HOOKED_PERMISSION_MODE`, `HOOKED_AUTO_APPROVE` | the session controls at launch |

It also passes `--exclude-tools 'mcp__hooked__*'`: a `hooked` server in pi's `mcp.json` would
declare the same tools a second time, without the session's launch key.

A provider opts out with `"hookedPackage": false`: its sessions then run as before (no cards,
auto-approved tools, `auto` mode only). The checkout is found next to the server
(`HOOKED_PI_PACKAGE` overrides it).

Outside hooked (pi opened in a terminal with the package installed), the tools fall back to pi's
own select dialogs and the permission gate is off.

## Subagents

`Agent` (`pi-package/extensions/agent.js`) runs one task in a separate pi process on the current
model and returns its final answer. The child loads the same `-e` extensions as the parent, so a
bridged Claude model works there too, but not hooked's package (no hooked tools, no nested
`Agent`). A subagent has no UI to show a permission card, so its tools follow the parent's mode:

| Parent | Subagent tools |
|---|---|
| Normal or plan mode, or `subagent_type` Explore / Plan | `read`, `grep`, `find`, `ls` |
| `acceptEdits` | the same, plus `edit` and `write` |
| Bypass, auto, or auto-approve on | pi's default tools |

Its usage is in the tool result's `details`; the session summary adds it to the cost (`subagents`,
`subagentCost`), as for Claude Code's subagents. The subagent's pi session lives in a temporary
folder removed after the run, so it stays out of the session list. Through pi-claude-bridge it is
still a real session: the bridge records its Claude Code shadow, which hooked then hides.

## Workflows

`Workflow` (`pi-package/extensions/workflow.js`) runs a Claude Code workflow script: it begins with
`export const meta = {...}` and uses `agent(prompt, { label, phase, schema, model, effort,
agentType })`, `parallel()`, `pipeline()`, `phase()`, `log()` and `args`. Every `agent()` is a
subagent as above, at most 4 at a time and 100 per run. With `schema`, the subagent answers with one
JSON object, checked against the schema (one retry with the problem), and `agent()` returns the
object; a failed agent returns `null`. A `model` without a provider takes the session's
(`sonnet` → `claude-bridge/sonnet`). Not supported: resume, `isolation: 'worktree'` (logged, the
agent runs in the session directory), `workflow()` nesting. The script runs in its own V8 context
with no Node.js API handed to it, which is not a sandbox: the tool asks in the normal mode. The
tool result carries the summed usage and the agent count, which the session summary adds.

## The protocol

In RPC mode, pi turns every `ctx.ui` dialog into an `extension_ui_request` record on stdout and
waits for an `extension_ui_response` on stdin. A dialog hooked must render as one of its cards is
an `input` dialog whose title carries a marker and a JSON payload; the answer is a JSON string.

| Title | Card | Answer (`value`) |
|---|---|---|
| `[hooked:permission] {"toolName","input"}` | permission (Allow once / Allow always / Deny) | `{"choice":"allow"\|"allow-always"\|"deny","message"?}` |
| `[hooked:question] {"questions":[…]}` | question | `{"answers":{"<question>":"<label>"}}` |
| `[hooked:plan] {"plan":"…"}` | plan | `{"action":"approve"\|"approve-auto"\|"keep"\|"keep-feedback","feedback"?}` |

A dismissed card (interrupt, kill) answers `{"cancelled":true}`: the tool reports that the user
did not answer, the gate blocks the call.

`select` / `confirm` dialogs of **other** extensions become a one-question card too, best effort.
Free-text dialogs of other extensions are cancelled (no card for them yet).

`setStatus("hooked-ratelimit", <json>)` carries the account quotas: hooked writes them to
`STATUS_DIR/<session>.json` in the statusline shape, where the header gauges read them.

The driver side is `server/piHooked.js`. The pending card is the same `pendingAsk` as on the Claude
path, so `Question.svelte`, `Plan.svelte` and the desktop app render it with no change.

## Prompt cache

The package never changes the system prompt between turns: hooked's instructions are one constant
section, and mode changes are messages delivered with the next turn (`deliverAs: "nextTurn"`).
A changed prompt costs a cache miss on every provider, and through pi-claude-bridge a full
re-import of the conversation into a fresh Claude Code session.

## Claude through pi-claude-bridge

To write another bridge, see the checklist in [adding-a-provider.md](adding-a-provider.md#bridge-checklist).

[pi-claude-bridge](https://www.npmjs.com/package/pi-claude-bridge) registers Claude Code as a pi
model provider (`claude-bridge/*`): pi drives the conversation, and each turn runs through the
Agent SDK on the user's own Claude login. The **Claude through pi-claude-bridge** template in
Settings → Providers sets it up for one provider only:

```json
"claude-bridge": {
  "engine": "pi",
  "label": "Claude (pi)",
  "models": ["claude-bridge/*"],
  "args": ["-e", "npm:pi-claude-bridge@0.13.0"]
}
```

`capabilities: { account: true }` says the provider runs on the Claude account, so the header keeps
the 5h / 7d gauges and the Claude spaces even when the `claude` provider is off.
`-e npm:…@<version>` loads the bridge for this provider's sessions (pi caches it, and a pinned
version is never re-checked). The model picker lists the bridge's models because the catalogue
runs `pi --list-models` with the provider's `-e` extensions.

What hooked does about the bridge:

- **Shadow sessions are hidden.** Each bridged pi session is the model side of a Claude Code
  session the bridge resumes in `~/.claude/projects`. `server/bridgeShadows.js` drops them from the
  Claude list: the bridge's state files (`<agentDir>/claude-bridge/sessions/*.json`, every id seen
  is remembered in `bridge-shadows.json`), or a transcript whose tool calls all went to the
  bridge's MCP server (`mcp__custom-tools__*`).
- **Their hooks are ignored.** pi sets `PI_CODING_AGENT=true` on its process, so the bridge's
  Claude Code child carries it, and `hook.cjs` exits on it. hooked strips the variable from the
  sessions it drives, so a hooked started from a pi shell does not silence its own Claude sessions.
- **Quotas.** The bridge rebuilds Anthropic's `anthropic-ratelimit-unified-*` headers from Claude
  Code's `rate_limit_event`; the package forwards them to the 5h / 7d gauges.

The bridge runs Claude Code with no built-in tools: Claude calls pi's tools, so the permission
gate, the questions and the plan mode above apply unchanged.

The bridge also excludes Claude Code's own context files: pi owns the context, so the model sees
pi's `AGENTS.md` and pi's skills, not `~/.claude/CLAUDE.md` and `~/.claude/skills`. `mise run
pi-migrate` copies the global `CLAUDE.md` into a managed block of `~/.pi/agent/AGENTS.md` (the rest
of the file stays pi-only), adds `~/.claude/skills` to the `skills` list of pi's settings, where
pi reads it live, adds the skills of the enabled plugins the same way (a run after a plugin update
swaps the versioned folder; plugins synced by an organization are left out, since their skills rely
on claude.ai connectors; `--with-synced-plugins` adds them anyway), and copies Claude Code's
user-scope MCP servers (`~/.claude.json`) into `~/.pi/agent/mcp.json`. The claude.ai connectors
connected in Claude Code (`claude mcp list`) join them when pi can reach them: the task probes each
one. A server that publishes no OAuth metadata and lists its tools without a token is copied as is.
A server whose authorization server lets a new client register (dynamic registration or a client
ID metadata document) is copied, to sign in once with `pi mcp login`. Left out: Anthropic's own
services, and servers whose authorization server only takes pre-registered clients (Google's
connectors list their tools to anyone but want a token for every call). A run where `claude mcp
list` fails keeps the earlier copies.

Two options widen that:

- **Your own Google client.** Google's authorization server only takes registered clients. Create
  an OAuth client of type *Desktop app* in a Google Cloud project (with the APIs of the connectors
  you want enabled), then run the task with its id and secret in the environment. The Google
  connectors are then copied with an `oauth` block naming that client, to sign in once each:

  ```bash
  PI_MIGRATE_GOOGLE_CLIENT_ID=… PI_MIGRATE_GOOGLE_CLIENT_SECRET=… mise run pi-migrate
  ```

- **`--with-unconnected`** also takes the connectors you have not connected in Claude Code, when
  pi can sign in to them on its own (Notion, Linear, Figma… at the time of writing). Each one then
  needs `pi mcp login <name>`, and pi reports the missing sign-ins at startup until you do it. Run it again after a change on the Claude side: the block is replaced, and
the MCP copies follow Claude unless they were edited in pi (`~/.pi/agent/pi-migrate.json` records
them). OAuth sign-ins do not carry over: the task names the `pi mcp login <name>` to run once.
`-- --dry-run` shows the changes.
