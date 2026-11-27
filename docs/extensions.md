# Extensions

An extension is a feature of hooked that lives in a folder of its own and can be switched off as a
whole in Settings → Extensions. Switched off, it is gone from the navigation (web, desktop,
Android), its background work stops, its API answers 404 `extension_off`, and new sessions no
longer get its agent tools.

An extension following the full contract is **loaded at runtime**: installing, updating or removing
one needs no rebuild and no restart, so no driven session is cut.

| Extension | Folder | Kind | What it brings |
|---|---|---|---|
| Cron | `extensions/cron` | full contract | Scheduled sessions: a prompt launched on a five-field cron schedule |
| GitHub | `extensions/github` | legacy | The GitHub page (notifications, your PRs, reviews), PR watches that wake a session, PR review tags |
| incident.io | `extensions/incidents` | legacy | Incidents from the incident.io desktop app: lists, detail, "Investigate in a session" |
| Flows | `extensions/flows` | legacy | Pipelines of driven sessions, walked like a CI pipeline |

Everything else (sessions, providers, the dock, Review, digest…) is the core. Each extension's
README holds its own rules and traps.

## Where they live

| Root | What | Wins on a duplicate id |
|---|---|---|
| `<checkout>/extensions/<id>/` | bundled, versioned with hooked | yes |
| `$HOOKED_EXTENSIONS_DIR/<id>/` (default `~/.claude/hooked/extensions/<id>/`) | installed by the launcher | no, listed as rejected |

Folders starting with `.` or ending in `.next` / `.prev` are ignored (the launcher's staging).

| Data | Where |
|---|---|
| On/off switch | `settings.json` → `extensions` (`{ id: bool }`, missing = the manifest's `default`) |
| Declarative settings | `~/.claude/hooked/extension-settings/<id>.json` |
| Extension data | `ctx.dataDir` = `~/.claude/hooked/extension-data/<id>/` |
| Loaded copies and compiled pages | `~/.claude/hooked/extension-cache/<id>/` |

## The contract (`api: 1`)

```text
<id>/
  extension.json     id (= folder), label, version, api, description, icon, default,
                     page { key, order, tint }, desktop { view },
                     contributes { settings: [...], sessionMenu: [...] }, legacy (bundled only)
  README.md          rules and traps of the extension
  server/index.js    export default { start(ctx), stop(), applySettings(values), available(), on: { … } }
  api.js             export default (ctx) => ({ '<rest>': { GET?, POST?, … } })   → /api/<id>/<rest>
  ui/Page.svelte     the web page, compiled at runtime (props: { rest })
  lib/               pure code shared by server and page
  tools.cjs          module.exports = (h) => ({ tools: [{ name, description, inputSchema, run }] })
  test/              vitest files (vitest picks up extensions/*/test/**/*.test.mjs)
```

- **Imports.** Server code, `api.js` and `tools.cjs` import only `node:*` built-ins and files of the
  folder. The page imports only `svelte`, `svelte/*`, `@hooked/ext/ui` and files of the folder.
  Everything from the core comes through `ctx` (`server/ext/context.js`) on the server, through
  `@hooked/ext/ui` (`src/lib/ext/ui.js`) in the page, through `h` in `tools.cjs`. A folder that breaks
  a rule is rejected with its error, never loaded.
- **`api`** is the version of this contract. An extension whose `api` differs from hooked's
  `EXTENSION_API` is rejected. Adding to the contract keeps the number; renaming, removing or
  changing a signature bumps it and fixes the bundled extensions in the same PR.
  `test/extensionPages.test.mjs` pins the names of `ctx`, `@hooked/ext/ui` and the shared runtime.
- **`page.key`** must not be a core page (`src/lib/nav.js`, plus `settings`, `session`, `new`,
  `api`, `_ext`…) nor the page of an extension already loaded. Tool names follow the same rule: a
  tool named like a core tool or another extension's gets the extension rejected. `order` places the tab among the core pages (Sessions 10, Stats 20, Digest 30, Memory
  40, Skills 70, Prompts 100), `tint` colours it when active.
- **`stop()` undoes `start()`.** The registry drops routes and listeners itself; timers, watchers and
  child processes are the extension's job. A hot update runs the new version right after.
- **Core events** (`on`): `session:start`, `turn:end`, `session:end`, `session:archived`,
  `settings:changed`. Called later, never awaited, with ids only; a listener that throws only logs.
  Session events cover sessions driven by hooked. On a non-Claude engine, `session:end` comes from a
  kill or restart by hooked, not from the agent exiting on its own.
- **Declarative settings** (`contributes.settings`: `bool`, `number`, `string`, `select`, `list`):
  validated against the schema, stored in their own file, handed to `applySettings(values)`, and
  rendered by Settings → Extensions on the web and the desktop. No UI code in the extension.
- **Session menu actions** (`contributes.sessionMenu`, `when`: `any`, `driven` or `live`): a click
  posts `{ sessionId }` to `/api/<id>/<post>`; the answer may carry `flash`, `error` or `open`
  (`{ session }` or `{ page, rest }`).
- **Desktop page** (`desktop.view`): `GET /api/<id>/<view>?path=` returns a view tree that the app
  renders natively (`desktop/src/extview.rs`). Nodes: `column` (`refresh`), `row`, `section`,
  `text`, `badge`, `empty`, `list`, `form` (fields `text`, `textarea`, `number`, `bool`, `select`,
  optional `preview` route), `button`. Actions: `{ post, body, confirm }`, `{ view }`,
  `{ open: { session } }`, `{ open: { url } }`. A `post` answers `{ flash, error, errors, view }`
  (`view`: the path to show next). An unknown node renders as a notice.

## Legacy extensions

GitHub, incident.io and Flows predate the contract. They are marked `"legacy": true` (allowed for
bundled extensions only) and keep their former shape until each moves to the full contract:

- they import the core through `#server/*` and `#lib/*` and are compiled into the service build:
  `server/extensions.js` imports their `server/index.js` through a lazy `import.meta.glob`, so
  changing one needs a deploy (`extensions` is in `BUILD_INPUTS` of `deploy-if-stale`);
- their lifecycle keeps the module shape: `start({ service, settings })`, and `applySettings` gets
  hooked's settings whenever they change;
- their routes stay in `src/routes` as one-line shims, which win over the catch-all routes:

  ```js
  // src/routes/api/flows/+server.js
  export { GET, POST } from '#extensions/flows/api.js';
  ```

  ```svelte
  <!-- src/routes/flows/+page.svelte -->
  <ExtensionGate id="flows"><Flows /></ExtensionGate>
  ```

  Their handlers go through `gated(id, handler)` (`src/lib/server/extensions.js`), which answers like
  the dispatcher while the extension is off;
- their desktop pages are native code in `desktop/src`, gated by `extension_on`;
- `tools.cjs` may export `{ tools }` instead of a factory, and requires `../../mcp/http.cjs`.

One core file reads a legacy extension: `server/autoTags.js` keeps GitHub's review tags
(`extensions/github/lib/reviewTags.js`) out of its vocabulary.

## How it runs (`server/extensions.js`)

- **Load** = scan both roots, validate, hash the folder, copy it to
  `extension-cache/<id>/<hash>/src`, and `import()` from there. The copy gives every version new
  module URLs: Node never unloads an ES module, and an import with `?v=` would refresh only the entry
  file, not its relative imports. A version loaded again in the same process (uninstalled, then
  reinstalled) gets a fresh copy, so it does not inherit its first instance's state.
- **Reload** = `POST /api/extensions/reload { id }`: loads the new version (page compiled) before
  stopping the old one. Boot loads every folder, legacy ones first; `npm run live` watches both roots
  and reloads the extension whose folder changed (legacy ones excepted: Vite reloads their code).
- **Switch** = `POST /api/extensions { id, enabled }`, which writes `settings.extensions[id]`. A
  settings file from before extensions is migrated on read (`modules` → `extensions`), and
  `settings.modules` stays as a read-only mirror for Android, as does `GET /api/modules` (an alias
  of `GET /api/extensions`). Both go away with the Android PR.
- **Dispatcher** = `src/routes/api/[ext]/[...rest]/+server.js`: 404 `extension_off` while the
  extension is off, 404 / 405 for an unknown route or method, 500 for a handler that throws.
- **Page compiler** (`server/extensionPages.js`): `vite.build()` in a child process with
  `configFile: false` and an inline (empty) PostCSS config: no Vite or PostCSS config is read, from
  the extension or above it. Pages are compiled in runes mode (`$props`, `$state`), with Svelte
  `css: 'injected'`, and every `svelte*` / `@hooked/ext/ui` import
  redirected to `globalThis.__hookedExt`, which `src/lib/ext/runtime.js` fills in the browser the
  first time an extension page opens. One Svelte instance, so the page shares the dashboard's
  reactivity (`data` is the filtered view: incognito applies). Output in
  `extension-cache/<id>/<key>/page.js`, served by `/_ext/…`; the key covers the folder hash, the
  Svelte version and `api`, so a restart compiles nothing. The catch-all route
  `src/routes/[page]/[...rest]` renders it inside `ExtensionGate`.
- **`GET /api/extensions`** lists `extensions` (with `source`, `legacy`, `origin` from the
  launcher's `.origin.json`, `enabled`, `available`, `active`, `tools`, `errors`), `rejected`
  (folders that failed a check) and `pending` (disk and memory disagree). The web, the desktop app
  and the launcher read it; it is pushed again on the `extensionsChanged` SSE event.

## Agent tools and the prompt cache

`HOOKED_EXTENSION_TOOLS` lists the `tools.cjs` of every active extension, decided when a session is
launched or resumed: a switch, an install or an update applies to new sessions (and to a session
after its restart). The order is **per engine**, each engine's historical one, so the prompt prefix
of sessions does not move:

- the MCP server (Claude, ACP) serves them after the core tools, **sorted by id**;
- hooked's pi package registers them as `hooked_<name>`, after its own, in **navigation order**
  (`page.order`, then id), the order its former per-module packages loaded in.

`test/extensionTools.test.mjs` pins both lists, names, descriptions and schemas, byte for byte,
against fixtures captured before the move. A server registered by hand (no
`HOOKED_EXTENSION_TOOLS`) serves every extension on disk, by id.

## Installing, updating, removing

Installed extensions come from git, through the launcher (EXTENSIONS section): **Add from git…**
(URL, ref, path in the repo) or **Add from catalog…** (`extensions/catalog.json` in the hooked repo
by default; the `catalog` setting of `~/.claude/hooked/launcher.json` points to another repo).
The launcher stages the folder as `<id>.next` with an `.origin.json` (repo, ref, path, commit),
shows the source and commit for confirmation, moves it in place, calls
`POST /api/extensions/reload`, checks `GET /api/extensions`, and puts the previous folder back on
any failure. It never restarts the service. Uninstalling keeps the extension's data and settings
files.

## Adding a bundled extension

1. Create `extensions/<id>/` with `extension.json` (`id` = folder name, `api: 1`) and `README.md`.
2. Then whatever it contributes: `server/index.js`, `api.js`, `ui/Page.svelte`, `tools.cjs`,
   `test/`. Nothing else to register: the navigation, the palette, Settings → Extensions, the
   desktop app (declarative view, settings, session menu), the MCP server and pi find it.
3. Android lists pages natively: an extension page it should show needs native code there, until
   Android renders declarative views.

To stop using an extension without touching the code, switch it off in Settings → Extensions.
