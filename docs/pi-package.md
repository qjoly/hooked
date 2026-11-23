# hooked's pi package

`pi-package/` is a pi package: the part of hooked that runs **inside** every pi session hooked
drives. It brings to pi what Claude Code gives hooked natively, so a pi session gets the same cards
and controls in the dashboard as a Claude session.

| Feature | Claude Code | pi with the package |
|---|---|---|
| hooked's tools (start_session, groups, review comments, PR watch, show_image…) | MCP server `hooked` | native tools `hooked_*`, same definitions (`mcp/server.cjs`) |
| Questions | `AskUserQuestion` | `AskUserQuestion`, same schema |
| Plan mode | `ExitPlanMode` + permission mode | `ExitPlanMode` + the package's mode |
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
