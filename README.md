# 🪝 hooked

> [!NOTE]
> hooked is an initiative of its four maintainers:
> [@briangtn](https://github.com/briangtn),
> [@NahisWayard](https://github.com/NahisWayard),
> [@comeChaslerie](https://github.com/comeChaslerie) and
> [@GitBluub](https://github.com/GitBluub).

A **local** dashboard to follow your Claude Code sessions in real time, and keep an eye on your usage (tokens, estimated cost, projects).

- 🔒 **100% local**: nothing leaves your machine.
- 🪶 **Zero-dependency back-end logic**: the `server/*` modules and `hook.cjs` only use the Node standard library (dependencies are only there to *build*/*serve* the front end).
- ⚡ **Real time**: session state updates on its own (SSE).
- 🧩 **SvelteKit**: Svelte 5 front end + API endpoints in a single process (Vite in dev, adapter-node in prod). The back end is split into tested modules (Vitest).

---

## Why?

When you juggle several Claude Code sessions, you quickly lose track: which one is waiting for an answer? Which one is still working? How much did it cost you today?

**hooked** puts all of that on a single page: you see at a glance the sessions that need you, and you can even **reply to Claude straight from the browser**.

---

## Requirements

- **[mise](https://mise.jdx.dev)**: tool manager + task runner. It installs **the right Node version on its own** (Node ≥ 24, required for `node:sqlite`) and drives every project task
- **Claude Code** installed and used on your machine
- Nothing else: sessions are driven through Anthropic's **Agent SDK** (`@anthropic-ai/claude-agent-sdk`), installed with the project dependencies

### 1. Install mise

```bash
# macOS (Homebrew)
brew install mise

# or any OS (official script)
curl https://mise.run | sh
```

Then activate mise in your shell (once):

```bash
# zsh
echo 'eval "$(mise activate zsh)"' >> ~/.zshrc && exec zsh

# bash
echo 'eval "$(mise activate bash)"' >> ~/.bashrc && exec bash
```

> [!TIP]
> Other installation methods (apt, dnf, Windows…): [mise docs](https://mise.jdx.dev/getting-started.html).

### 🪟 What about Windows?

hooked reads `~/.claude` and drives `claude` processes: the tested path is **WSL2**.

```powershell
wsl --install -d Ubuntu
```

Then **everything happens inside WSL**: install **Claude Code** and **mise** in Ubuntu and follow the
steps above as is. Two things to watch:

- **Claude Code must run inside WSL** (not on the Windows side): hooks write to the Linux
  `~/.claude`, which is where hooked reads everything.
- The dashboard started in WSL is reachable from your Windows browser at
  **http://localhost:4123** (WSL2 forwards localhost automatically).

> [!NOTE]
> The `mise run service-install` service (launchd) is macOS-only. Under WSL, run
> `mise run start` by hand or through systemd (enabled by default in recent WSL versions).

---

## Installation

```bash
git clone git@github.com:qjoly/hooked.git
cd hooked

mise trust        # allow the project's mise.toml (env + tasks)
mise run setup    # install Node 24 + deps, build the front end, wire up the Claude Code hooks
mise run start    # start the dashboard
```

Then open **http://localhost:4123**.

`mise run setup` does everything in one pass: `npm install` (devDeps only), production build,
then wiring hooked into the Claude Code hooks (`~/.claude/settings.json`, **with an automatic
backup** `settings.json.hooked.bak`).

> ⚠️ After `setup`, **restart your Claude Code sessions** to activate the hooks.
> Sessions that are already open stay visible (through their transcripts), but their live
> state only shows up from the next event onwards.

> [!TIP]
> **macOS**: `mise run service-install` installs hooked as a **launchd service**:
> starts at login, auto-restarts, logs in `~/Library/Logs/hooked/`.
> (`service-status`, `service-logs`, `service-restart`, `service-uninstall` also exist.)

<details>
<summary><strong>Without mise (npm directly)</strong></summary>

You need **Node.js ≥ 24** already installed.

```bash
npm install       # dependencies (SvelteKit + tooling), devDeps only
npm run setup     # wire hooked into the Claude Code hooks (with automatic backup)
npm run build     # production build (adapter-node) → build/
node build        # start the dashboard on http://localhost:3000 (set PORT to change it)
```

</details>

---

## Features

### 🗂️ Sessions view

All your sessions (running + past), grouped by state to handle multitasking:

| State | Meaning |
|------|---------------|
| 🔴 **Action required** | Claude is asking for a permission |
| 🟡 **Waiting for you** | Claude is done, your turn |
| 🔵 **Claude is working** | active session (with the current tool, e.g. `Bash`) |
| 🕘 **Recent** | paused / ended / past |

Also:

- **Search** + **filters** by status (chips with counters) and by project.
- **Current task in the sidebar**: if Claude uses `TodoWrite`, the *in progress* item and the progress (`done/total`) show up right on the session card.
- **One-click answer from the sidebar**: when Claude asks a single-choice question (`AskUserQuestion`), the options appear as buttons on the card. One click sends the answer without opening the detail view.
- **Session detail**, in sub-tabs:
  - **💬 Conversation**: the rebuilt chat, with the composer to reply (sessions driven by hooked).
  - **📝 Files**: the files changed by Claude (`Write` / `Edit` / `MultiEdit` / `NotebookEdit`) with an **expandable diff** (red/green).
  - **✅ Tasks**: the session's todo list (`TodoWrite`) with a progress bar.
  - **🤖 Subagents**: the `Agent` / `Task` calls made during the session.
  - **🪝 Activity**: the raw hook timeline.
- **GitHub PR links**: pull request URLs mentioned in the session are detected and shown as clickable chips.

### 💬 Reply to Claude from the UI *(sessions driven by hooked)*

For the sessions hooked drives, a composer shows up at the bottom of the conversation:

- Send a message straight into the session, through the Agent SDK's **streaming input queue**.
- It is **your session / your subscription** that carries on → **no extra token usage**, no `claude -p`.
- `Enter` sends, `Shift+Enter` inserts a line break.
- `Esc` **interrupts Claude** and reloads the last prompt so you can edit it (like in the CLI).
- Type `@` to **autocomplete** a project file (↑/↓ to navigate, Enter/Tab to insert).
- **Paste an image** (Cmd/Ctrl+V): it is saved locally and its path is attached to the message. Claude Code reads it like a drag-and-drop in the TUI. A thumbnail shows in the composer (× to remove it).
- **Queue**: as in the CLI, messages sent while Claude is working are queued and marked `⏳ queued` until they show up in the transcript.
- **Stopped session**: if it is no longer alive, sending a message **relaunches `claude --resume`** automatically in its original folder.
- **Interactive questions** (`AskUserQuestion`): the question and its suggested answers are shown in a card, and you can pick one or more answers.
- **Tool permission requests**: when Claude wants to run a tool that needs your approval, the request lands in the **same card** with *Allow once* / *Allow always* / *Deny*, approvable from the browser, no terminal needed.

### 🔀 Change Claude's mode *(sessions driven by hooked)*

For a **live** session, the chat header shows the **current permission mode** and a selector to change it:

- **● Normal**: Claude asks for permission before every sensitive action.
- **⚡ Auto**: Claude approves actions automatically, without confirmation (full auto).
- **⏸ Plan**: plan mode, Claude thinks and proposes without changing anything.

The **current mode** is published by the session itself (Agent SDK): a reliable, real-time source, unlike hooks (delayed) or the statusline (which does not carry the mode). Other modes (**⏵⏵ Auto-edits**, **⛔ Bypass**…) are recognized and displayed even though the selector does not offer them.

The change is **a control request** (`setPermissionMode`): one call, one confirmation.

### ▶️ Launch / resume / stop

- **＋ New session**: pick a project, the **model** (Opus / Sonnet / Haiku / Fable), the **effort** (low → max) and an optional first message.
- **▶ Resume**: relaunches a past session (`--resume`) in its original folder.
- **⏹ Stop**: ends the session's Claude Code process.

> Sessions run **inside the hooked process**, through the Agent SDK, under your subscription (**zero token usage**, no `claude -p`). The flip side: **restarting hooked ends the running sessions**. Their transcript stays on disk, and `▶ Resume` picks up where they left off.

### 📊 Stats & usage view

Estimated cost, tokens, sessions, turns, prompts, with charts by **day / model / project / tool** and **1d / 7d / 30d / all** ranges.

---

## Development

```bash
mise run dev       # front end (HMR) + API + SSE in a single Vite process, on :5173
mise run test      # characterization tests (Vitest), the back end's regression safety net
mise run build     # production build (adapter-node) → build/
mise run start     # start the production server (node build) on :4123
mise run deploy    # rebuild + restart the launchd service (if installed)
mise tasks         # list every available task
```

(npm equivalents: `npm run dev`, `npm test`, `npm run build`, `npm start`.)

### Architecture

```
src/routes/            SvelteKit: pages (URL routing) + API endpoints
  ├─ +layout.svelte    header / tabs / live state (SSE) / modal
  ├─ (sessions)/       / (overview), /session/[id], /new, with sidebar
  ├─ stats/            /stats
  └─ api/*/+server.js  JSON endpoints + /api/stream (SSE)
src/lib/
  ├─ components/       Svelte 5 components
  ├─ server/           bridge to the back end (core.js) + SSE singleton (live.js)
  └─ {api,format,state.svelte}.js  API access, helpers, shared state
server/                back-end logic (ESM), stdlib + the Agent SDK, in testable modules
  ├─ pricing.js        prices + cost computation
  ├─ transcript.js     transcript parsing (+ mtime cache, scan, subagents)
  ├─ conversation.js   chat reconstruction
  ├─ changes.js        file diffs
  ├─ subagents.js      Agent/Task calls
  ├─ files.js          listing + fuzzy matching (@-completion)
  ├─ events.js         live events (hook)
  ├─ live.js           live state of a session
  ├─ agent.js          Agent SDK driver: registry, launch / reply / interrupt / mode
  └─ stats.js          sessions, stats, detail
hook.cjs               event sensor (wired into the hooks)
test/                  synthetic fixtures + differential tests (old vs new)
```

On synthetic fixtures, the tests compare the output of the old `server.js`
(frozen in `test/reference/`) with the output of the new modules: any difference is a regression.

## How it works

1. **`hook.cjs`** is wired into **every** Claude Code hook. On each event (prompt, tool call, end of turn, notification…), it writes a line to `~/.claude/hooked/events.jsonl`. That is the source of the **live state**.
2. **The SvelteKit endpoints** (`src/routes/api/*`) also read your **transcripts** (`~/.claude/projects/*/*.jsonl`) for history, tokens, cost and titles. They serve the UI + the JSON API, and push updates over **SSE** (`/api/stream`, real time).

---

## Configuration

| Setting | How |
|---------|---------|
| **Change the port** | `PORT=5000 mise run start` (prod) or `npm run dev -- --port 5000` (dev) |
| **Expose on the LAN** | `HOST=0.0.0.0 mise run start`. By default hooked only listens locally (127.0.0.1) |
| **Adjust prices** | edit the `PRICING` object in `server/pricing.js` (USD / million tokens) |
| **Start at boot** | `mise run service-install` (macOS, launchd service: login + auto-restart) |
| **Session budget (fallback)** | `HOOKED_SESSION_BUDGET=60 mise run start`. Used to estimate the % of the 5 h window **only** when the statusline tap is not set up |

### ⏳ Real rate limits (5 h / 7 d): statusline tap

Claude Code passes your **statusline** a JSON payload holding the account's **real** rate limits
(`rate_limits.five_hour` / `seven_day`). hooked shows them as a progress bar in the chat header
if you "tap" your statusline: paste the content of **`statusline-tap.sh`** at the top of your
statusline script (right after `input=$(cat)`). It drops one snapshot per session into
`~/.claude/hooked/status/`. Without this tap, hooked falls back to a **cost-based estimate**
(see `HOOKED_SESSION_BUDGET`).

---

## Uninstall

Remove the `node .../hook.js` lines from `~/.claude/settings.json` (a `settings.json.hooked.bak` backup was created by `setup`). Your other existing hooks are preserved.

---

## Privacy

Nothing leaves your machine. `events.jsonl` only stores **metadata** (event, session, cwd, tool name), **not the content** of your messages.
