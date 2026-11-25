# Flows module

A flow is a graph of stages, each one a driven session, walked like a CI pipeline (the `/flows`
page draws it). The built-in "feature" template: pilot → build → review ‖ test & challenge → decide,
with the decider looping back to build. Templates live in `flow-templates.json`, runs in
`flow-runs.json`; a run keeps a snapshot of its flow. `lib/flows.js` is the pure model shared by
the engine and the page (and ported by the desktop app's `desktop/src/flows.rs`).

- **hooked drives the transitions, not a session.** A 3 s tick reads the registry. A stage reports
  with the agent tool `flow_report` (summary, plus `done`/`loop`/`escalate` for the decider) and is
  done once it has reported AND its turn has ended. No report at turn end: one nudge, then `stalled`.
  Loops are capped (`maxLoops`), then the run waits on the user.
- **One shared worktree per run**, one writer stage. Stage sessions join one group and are reused
  across loops (`deliverReply`, or a resume without `model`), so each keeps its context and cache.
- **Token choices are deliberate:** per-stage model/effort in the template (opus for pilot and
  decider, sonnet for the rest), dense reports (~300 words), loop messages only carry the reports
  re-run in that pass (`run.rerun`), and sibling stages start 10 s apart so the second one reads the
  system/tools prefix the first one cached.
- **Ownership:** the service adopts every running run at boot (`start({ service })` →
  `startFlowEngine({ adopt: true })`, 3 min grace for resumed sessions, then one automatic resume).
  A bare `npm run live` only drives the runs it started (the engine starts lazily on an op).
  Switching the module off stops the engine; runs keep their state and go on once it is back on.
- **Agent tools** (`tools.cjs`): `flow_report` (needs the launch key hooked gives the sessions it
  drives), `list_flows`, `start_flow`.
