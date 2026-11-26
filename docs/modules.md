# Modules

A module is a feature of hooked that lives in a folder of its own and can be switched off as a
whole in Settings → Modules. Switched off, it is gone from the navigation (web, desktop, Android),
its background work stops, its API answers 404, and new sessions no longer get its agent tools.

| Module | Folder | What it brings |
|---|---|---|
| GitHub | `modules/github` | The GitHub page (notifications, your PRs, reviews), PR watches that wake a session, PR review tags |
| incident.io | `modules/incidents` | Incidents from the incident.io desktop app: lists, detail, "Investigate in a session" |
| Cron | `modules/cron` | Scheduled sessions: a prompt launched on a five-field cron schedule |
| Flows | `modules/flows` | Pipelines of driven sessions, walked like a CI pipeline |

Everything else (sessions, providers, the dock, Review, digest…) is the core.

## Layout

```text
modules/
  index.js              finds the modules: every folder with a manifest.js (pure, UI and server)
  <id>/
    manifest.js         { id, label, icon, page, order, tint, description }
    README.md           how the module works, its traps
    server/             server code; index.js exports its lifecycle (below)
    lib/                pure code shared by the server and the page
    ui/                 Svelte components, and ui/api.js (the page's fetch helpers)
    api.js              the API handlers, wrapped in gated(id, …)
    tools.cjs           agent tools: { tools: [{ name, description, inputSchema, run }] }
    pi/                 a pi package registering tools.cjs as native tools
    test/               tests (vitest picks up modules/*/test/**/*.test.mjs)
```

SvelteKit only serves routes from `src/routes`, so a module's routes stay there as one-line shims:

```js
// src/routes/api/cron/+server.js
export { GET, POST } from '#modules/cron/api.js';
```

```svelte
<!-- src/routes/cron/+page.svelte -->
<ModuleGate id="cron"><Cron /></ModuleGate>
```

Modules are found by their folder (`import.meta.glob` in `modules/index.js` for the manifests,
in `server/modules.js` for the lifecycles), and the navigation is built from the manifests: the
top bar tab, the palette's "Go to …", the settings' page lists (`src/lib/nav.js`, `NAV_PAGES` in
`server/settings.js`). `order` places the tab among the core pages (Sessions 10, Stats 20, Digest
30, Memory 40, Skills 70, Prompts 100), `tint` colours it when active.

Aliases: `#modules/*` → `modules/*`, `#server/*` → `server/*` (package.json `imports`). Module code
reaches the core through `#server/…` and `#lib/…`; the core does not import a module, with one
exception kept pure: `server/autoTags.js` reads `modules/github/lib/reviewTags.js`.

## The switch

- `settings.modules` is `{ id: boolean }`; a module the settings do not name is on
  (`modules/index.js`: `moduleOn`, `sanitizeModules`). The web settings page, the desktop app and
  Android read the same key.
- `GET /api/modules` lists the modules with `enabled` and `available`. `available` comes from the
  module's own `available()` hook: incident.io needs its desktop app on the machine hooked runs on,
  and its page is hidden elsewhere, as in the desktop app.
- API routes go through `gated(id, handler)` (`src/lib/server/modules.js`): 404 with a message
  while the module is off.
- Pages go through `ModuleGate` (web), `page_on()` (desktop) and `moduleOn()` (Android): a visit to
  a switched-off page says so instead of failing.

## Lifecycle (`server/modules.js`)

Each `modules/<id>/server/index.js` exports, all optional:

```js
export default {
  start({ service, settings }) {}, // the module was switched on, or hooked booted with it on
  stop() {},                       // it was switched off: clear timers, kill child processes
  applySettings(settings) {},      // a settings change while it is on
  available() { return true; },    // can it work on this machine?
};
```

`bootModules({ service })` runs from `src/hooks.server.js` in every process; `service` is true for
the installed service only (same rule as the rest of the boot: `!dev || HOOKED_MODE`). Work that
launches sessions (the Cron scheduler, the Flows engine) only starts when `service` is true, so a
bare `npm run live` never fires a task. `POST /api/settings` calls `applyModuleSettings`, which
starts, stops or re-applies without a restart. The registry is pinned on globalThis, like the
loops themselves, so a Vite reload does not start a second copy.

## Agent tools

A module's tools live in `tools.cjs` (CommonJS: the MCP server is plain Node), built on
`mcp/http.cjs` (`httpRequest`, `resultFrom`).

- **Claude and ACP sessions** get them from the MCP server (`mcp/server.cjs`): hooked passes
  `HOOKED_MODULES=<ids on>` when it spawns the server, which only serves those modules' tools. A
  server registered by hand (no `HOOKED_MODULES`) serves every module's.
- **pi sessions** get them from the module's pi package (`modules/<id>/pi`): `server/piAgent.js`
  adds `-e modules/<id>/pi` for each module that is on (`modulePiPackages()`), next to hooked's own
  package. The tools register as `hooked_<name>`, which the hooked package's permission gate allows.

Both are read at launch: a switch applies to new sessions (and to a session after its restart).

## Adding a module

1. Create `modules/<id>/` with at least `manifest.js` (its `id` is the folder name, `page` a key no
   core page uses), `server/index.js` (`export default {}` is enough) and `README.md`.
2. Add the two route files: `src/routes/<page>/+page.svelte` (the page in `<ModuleGate id>`) and,
   if it has an API, `src/routes/api/<…>/+server.js` re-exporting `modules/<id>/api.js`.
3. Then whatever it needs: server code, `api.js` with `gated(id, …)`, a page in `ui/`, agent tools
   in `tools.cjs` with a pi package in `pi/` (copy another module's two files), tests in `test/`.
4. The desktop app (`page_module` in `desktop/src/app.rs`, `MODULES` in its settings) and Android
   (`moduleOn` where its pages are listed), if they get the page: native code, by hand.

Nothing else to register: the navigation, the palette, the settings, the Modules card, the MCP
server and pi find it. `test/modules.test.mjs` names no module; it checks that every folder with a
manifest has its page shim, its API shim, a lifecycle and a README.

## Removing a module

Delete `modules/<id>/` and its route files in `src/routes`. A route file left behind breaks the
build (its import is gone). Then the native apps' pages, if any. One core file reads a module:
`server/autoTags.js` keeps the GitHub module's review tags (`modules/github/lib/reviewTags.js`) out
of its vocabulary, so removing GitHub means dropping that line too.

To stop using a module without touching the code, switch it off in Settings → Modules.
