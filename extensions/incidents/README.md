# incident.io extension

Incidents from the incident.io desktop app. hooked talks to its binary, which only speaks MCP over
stdio (`incident mcp`): `server/client.js` is the Node twin of the desktop app's
`desktop/src/incmcp.rs`.

- **One process, one call at a time**, pinned on globalThis and started by the first read. A write
  is never sent twice: a call that failed half-way is reported, not retried. A dead process is
  replaced before a request goes out, never after. Switching the extension off kills it.
- **The binary decides availability**: `HOOKED_INCIDENT_BIN`, else `~/.incidentio/incident`, else
  the app bundle. Without it the extension is not available (`available()`), and the page is hidden,
  as in the desktop app. `HOOKED_INCIDENT_BIN=` (empty) turns it off; the desktop app's fake server
  (`desktop/scripts/fake-incident`) stands in for tests.
- **The web page is read only**: the lists by scope (`lib/incidents.js`: Open, Mine, Post-incident,
  Closed, Merged), an incident in detail (summary, roles, AI investigation, updates, alerts), and
  "Investigate in a session", which opens the new-session page with a read-only prompt filled in.
  The writes (merge, unmerge, pin, roles) are in the desktop app.
- No agent tools: sessions use the incident.io MCP server directly (Claude Code's own config, or
  pi's `mcp.json` through `mise run pi-migrate`).
- API: `GET /api/incidents` (status), `?scope=<key>&after=<cursor>` (a list page), `?id=<id>`.
