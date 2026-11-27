# Extensions

An extension is a feature of hooked that lives in a folder of its own and is **loaded at runtime**:
installing, updating or removing one needs no rebuild and no restart, so no driven session is cut.
Cron is the first one (`extensions/cron`). Flows, GitHub and incident.io are still
[modules](modules.md), compiled into the build.

> Status: proof of concept. The contract below is what the POC implements; the launcher, the
> catalog and the rename of modules to extensions come later.

## Where they live

| Root | What | Wins on a duplicate id |
|---|---|---|
| `<checkout>/extensions/<id>/` | bundled, versioned with hooked | yes |
| `$HOOKED_EXTENSIONS_DIR/<id>/` (default `~/.claude/hooked/extensions/<id>/`) | installed | no, listed as rejected |

Folders starting with `.` or ending in `.next` / `.prev` are ignored (the launcher's staging).

## The contract (`api: 1`)

```text
<id>/
  extension.json     id (= folder), label, version, api, description, icon, default,
                     page { key, order, tint }, desktop { view },
                     contributes { settings: [...], sessionMenu: [...] }
  server/index.js    export default { start(ctx), stop(), applySettings(values), available(), on: { … } }
  api.js             export default (ctx) => ({ '<rest>': { GET?, POST?, … } })   → /api/<id>/<rest>
  ui/Page.svelte     the web page, compiled at runtime (props: { rest })
  lib/               pure code shared by server and page
  tools.cjs          module.exports = (h) => ({ tools: [{ name, description, inputSchema, run }] })
  test/              vitest files
```

- **Imports.** Server code, `api.js` and `tools.cjs` import only `node:*` built-ins and files of the
  folder. The page imports only `svelte`, `svelte/*`, `@hooked/ext/ui` and files of the folder.
  Everything from the core comes through `ctx` (`server/ext/context.js`) on the server, through
  `@hooked/ext/ui` (`src/lib/ext/ui.js`) in the page, through `h` in `tools.cjs`. A folder that breaks
  a rule is rejected with its error, never loaded.
- **`stop()` undoes `start()`.** The registry drops routes and listeners itself; timers, watchers and
  child processes are the extension's job. A hot update runs the new version right after.
- **Core events** (`on`): `session:start`, `turn:end`, `session:end`, `session:archived`,
  `settings:changed`. Called later, never awaited, with ids only.
- **Declarative settings** (`contributes.settings`: `bool`, `number`, `string`, `select`, `list`):
  values in `~/.claude/hooked/extension-settings/<id>.json`, rendered by Settings → Modules.
- **Session menu actions** (`contributes.sessionMenu`): a click posts `{ sessionId }` to
  `/api/<id>/<post>`; the answer may carry `flash`, `error` or `open`.
- **Desktop page** (`desktop.view`): `GET /api/<id>/<view>?path=` returns a view tree that the app
  renders natively (`desktop/src/extview.rs`). Nodes: `column` (`refresh`), `row`, `section`,
  `text`, `badge`, `empty`, `list`, `form` (fields `text`, `textarea`, `number`, `bool`, `select`,
  optional `preview` route), `button`. Actions: `{ post, body, confirm }`, `{ view }`,
  `{ open: { session } }`, `{ open: { url } }`. A `post` answers `{ flash, error, errors, view }`
  (`view`: the path to show next). An unknown node renders as a notice.

## How it runs (`server/extensions.js`)

- **Load** = scan, validate, hash the folder, copy it to `extension-cache/<id>/<hash>/src`, and
  `import()` from there. The copy gives every version new module URLs: Node never unloads an ES
  module, and an import with `?v=` would refresh only the entry file, not its relative imports.
- **Reload** = `POST /api/extensions/reload { id }`: loads the new version (page compiled) before
  stopping the old one. Boot reloads every folder; `npm run live` watches both roots.
- **Switch** = `settings.extensions[id]` (mirrored into `settings.modules` for Android),
  `POST /api/extensions { id, enabled }`. Off: routes answer 404 `extension_off`, lifecycle stopped,
  page and menu entries hidden, tools dropped from new sessions.
- **Page compiler** (`server/extensionPages.js`): `vite.build()` with `configFile: false`, Svelte
  `css: 'injected'`, and every `svelte*` / `@hooked/ext/ui` import redirected to
  `globalThis.__hookedExt`, which `src/lib/ext/runtime.js` fills in the browser the first time an
  extension page opens. One Svelte instance, so the page shares the dashboard's reactivity (`data`
  is the filtered view: incognito applies). Output in `extension-cache/<id>/<key>/page.js`, served
  by `/_ext/…`; the key covers the folder hash, the Svelte version and `api`, so a restart
  compiles nothing.
- **Tools**: `HOOKED_EXTENSION_TOOLS` lists the `tools.cjs` of every module and extension that is
  on, decided at launch. The MCP server gets them by id, the pi package in navigation order: each
  engine's historical order, so the prompt prefix does not move (`test/extensionTools.test.mjs`).
