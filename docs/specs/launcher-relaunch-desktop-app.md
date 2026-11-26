---
title: Launcher updates the desktop app after a switch
---

Start date: 26/11/2026
Project Lead: Côme Chaslerie

## Context

`hooked-launcher` (`desktop/launcher/`) switches the hooked service to a branch: fetch, checkout,
build beside the running service, wait for running turns, swap and restart the service, verify. It
never touches the desktop app (Rune, `/Applications/hooked.app`, bundle id `dev.qjoly.hooked-rune`).

After a switch, the desktop app reconnects on its own, but it keeps running the binary it was
started with:

- if the branch changes `desktop/`, the app does not run the branch's code, so a desktop branch
  cannot be tested through the launcher;
- even when `desktop/` is unchanged, the app reads `/api/capabilities` (models, efforts) once at
  launch and does not see what the branch's back end adds.

Today the only way to get the branch's app is to run `mise run desktop` by hand after the switch.

## Goals / Requirements

1. After a successful switch, the launcher rebuilds the desktop app from the branch, installs it in
   `/Applications/hooked.app` and relaunches it if it was running.
2. The app is installed only after the new service answers, so the new app reads the new back
   end's capabilities when it starts.
3. A desktop app failure never rolls back the service and never blocks the switch. The previous
   app stays installed, and is reopened if it was running. The launcher shows a warning with the
   log.
4. An app that was not running is updated but not opened.
5. No desktop step when it cannot apply: not on macOS, or app not installed.
6. One build/install recipe, shared by `mise run desktop` and the launcher, so the ad hoc
   `codesign` (which carries the Local Network permission) cannot drift between them.

## Current state of the system being modified (in case of an update)

**Launcher** (`desktop/launcher/src/`):

- `flow::order(install_deps) -> [Step; 6]`: `Fetch, Checkout, Build, WaitTurns, Swap, Verify`,
  with `WaitTurns` before `Build` when the lockfile changed.
- `runner::switch` runs the steps and reports events. On any error it undoes what was done, then
  reports `Event::Undone`. On success it reports `Event::Switched`.
- `Event::Order` re-orders the steps once `Checkout` knows whether `npm ci` is due.
  `State::start` (`main.rs`) builds the initial step list from `flow::order(false)`.
- `deploy/npm-deps.sh` is embedded in the binary (`sys::NPM_DEPS`) and run with `bash -s` in the
  branch's checkout, so branches older than the script still get it.
- Every command goes through `sys::run`, with the login shell's environment, so `mise`, `cargo`
  and `zig` are found when the launcher is opened from the Finder.
- View (`view.rs`): one line per step, a success callout « hooked now runs <branch>. » shown once
  the run is switched, a failure block with the rollback state, the log tail and « Copy log ».

**Desktop app recipe** (`mise.toml`, task `desktop`, run in `desktop/` with rust + zig):
`cargo build --release` → assemble `target/hooked.app` → `codesign --force --sign -` →
`mise run deploy-if-stale` (non fatal) → quit `dev.qjoly.hooked` and `dev.qjoly.hooked-rune` →
`sleep 1` → `rm -rf /Applications/hooked.app "/Applications/hooked (Rune).app"` → `ditto` →
`open`, always.

Known defect: if the old app takes more than 1 s to quit, `open` brings the old process back
instead of launching the new binary, silently.

**Build costs**: `cargo build --release` with nothing changed: 0.4 s. After a change in
`desktop/src` or `desktop/ui`: about 30 s. After a Rune bump in `Cargo.lock`, or with an empty
`target/`: several minutes (Zig builds `libghostty-vt`).

## What are the success criteria?

- Switching to a branch that changes `desktop/` with the app running: at the end of the run,
  `/Applications/hooked.app` holds the branch's build, the app runs that build, and the launcher
  shows « hooked now runs <branch>. » with every step done.
- Same switch with the app closed: the app is updated in `/Applications` and stays closed.
- Switching to a branch whose app does not compile: the service runs the branch, the previous app
  is still installed (and running if it was), the launcher shows the success callout plus a
  warning with the error, and « Copy log » copies the cargo output.
- A failed `Verify` rolls back as today and the app is untouched.
- No app installed: no desktop step.
- A branch without the Rune app (from before `9821f28`): warning « this branch has no Rune desktop
  app », the service still runs the branch.
- `mise run desktop` behaves as before (redeploy if stale, build, install, open), now through the
  shared script, and always launches the new binary.
- `cargo test -p hooked-launcher` passes, with the tests listed below.

## Proposed changes - Specifications

### 1. Shared script `desktop/scripts/install-app`

Bash (`#!/usr/bin/env bash`, `set -euo pipefail`), committed as executable (`100755`). Runs in
`desktop/`: it first checks that `Cargo.toml` names the `hooked-rune` package, else exits with
« this branch has no Rune desktop app ». It expects `cargo` (and Zig through it) from the caller:
the mise task's `tools`, or `mise x` in the launcher.

Usage: `install-app [--open]`.

- Without `--open`: the app is reopened only if it was running.
- With `--open`: the app is always opened (the `mise run desktop` behaviour).

Steps:

1. Remove `/Applications/.hooked.next` and `/Applications/.hooked.prev` left by an earlier run.
2. `cargo build --release`.
3. Assemble `target/hooked.app` from scratch: `Contents/MacOS/hooked-rune`,
   `Contents/Info.plist`, `Contents/Resources/icon.icns`.
4. `codesign --force --sign - target/hooked.app`, with the comment on the Local Network permission
   (moved from `mise.toml`).
5. Copy the bundle next to its destination: `ditto target/hooked.app /Applications/.hooked.next`.
   The names do not end in `.app`, so they are never seen as apps. Until here, nothing installed or
   running has been touched: any failure leaves the previous app as it was.
6. Record whether the app runs, by bundle id, with
   `running() { [ "$(osascript -e "application id \"$1\" is running" 2>/dev/null)" = true ]; }`.
   An error counts as « not running » (`osascript` fails on an unknown id). A `desktop-run` /
   `desktop-dev` process started from source is neither detected nor quit.
7. Quit the app: `osascript -e 'with timeout of 5 seconds' -e 'quit app id
   "dev.qjoly.hooked-rune"' -e 'end timeout' 2>/dev/null || true`. The old Tauri app
   (`dev.qjoly.hooked`) gets today's `quit … || true`, with no wait.
8. Wait until `dev.qjoly.hooked-rune` is gone: check every 200 ms, at most 10 s.
9. Swap with two renames: `hooked.app` → `.hooked.prev`, then `.hooked.next` → `hooked.app`. If
   the second one fails, `.hooked.prev` is put back.
10. Open `/Applications/hooked.app` if `--open`, or if the app was running at step 6, **whether the
    swap worked or not**.
11. Remove `.hooked.prev`, `.hooked.next` and `/Applications/hooked (Rune).app` (best effort), then
    exit with an error if the wait or the swap failed.

From the quit to the reopen, nothing may stop the script early and nothing is printed: a launcher
closed meanwhile would kill a script that writes to it. Sketch:

```bash
swap() {   # called inside an `if`: set -e does not stop it
  if [ -e "$DEST" ]; then mv "$DEST" "$PREV" 2>/dev/null || return 1; fi
  mv "$NEXT" "$DEST" 2>/dev/null && return 0
  [ -e "$PREV" ] && mv "$PREV" "$DEST" 2>/dev/null
  return 1
}
# … quit …
ok=false
if wait_quit && swap; then ok=true; fi
if [ "$open" = true ] || [ "$was_running" = true ]; then open "$DEST" 2>/dev/null || true; fi
rm -rf "$PREV" "$NEXT" "/Applications/hooked (Rune).app" 2>/dev/null || true
$ok || { echo "the desktop app was not replaced (did not quit within 10 s, or /Applications refused the change)" >&2; exit 1; }
```

Accepted gaps, as with today's `rm -rf` + `ditto`: the script killed between the two renames, or
the launcher closed between the quit and the reopen (the app may end up installed but closed).

Constraints:

- The whole body sits in a function called on the last line (`main "$@"`), so bash reads the
  entire script before running anything. The launcher feeds it on stdin (`bash -s`); without that,
  a command reading stdin would swallow the rest of the script.
- Nothing that touches the service (no `deploy-if-stale`): the launcher owns the service.
- macOS only, like the `desktop` task today.

### 2. `mise run desktop`

The task keeps its directory and tools, and becomes:

```bash
set -e
mise run deploy-if-stale || echo "⚠ back end not redeployed, the app may call a stale service" >&2
scripts/install-app --open
```

`deploy-if-stale` now runs before the app build instead of between build and install. What
matters is kept: the service is current before the old app quits and the new one starts. If the
deploy restarts hooked and stops the session running the task, a rerun finds the back end current
and only builds and installs the app. The comment explaining why the deploy comes first moves with
it.

### 3. Launcher: the `UpdateApp` step

**Flow (`flow.rs`)**

- New `Step::UpdateApp`, label « Update the desktop app ».
- `order(install_deps) -> [Step; 6]`, the undo plan and their tests are unchanged: the app step is
  not part of the reversible steps and has nothing to undo.

**Effects (`sys.rs`)**

- `pub const INSTALL_APP: &str = include_str!("../../scripts/install-app");`, documented like
  `NPM_DEPS`: the launcher's copy runs, so a branch older than the script still gets the app
  installed.
- `pub fn desktop_app_installed() -> bool`: `cfg!(target_os = "macos")` and
  `/Applications/hooked.app` exists. This is the only platform guard.

**Runner (`runner.rs`)**

- `switch(repo, branch, app, ctl, report)`: `app` comes from `desktop_app_installed()` and does
  not change during the run.
- New `Event::AppFailed { error: String, log: String }`. `Event::Order` is unchanged.
- The loop over the six steps is unchanged. `UpdateApp` runs **after** the loop, so an app failure
  cannot reach the undo path:

  ```rust
  if app {
      report(Event::Start(Step::UpdateApp));
      let mut log = String::new();
      match update_app(repo, &mut log) {
          Ok(()) => report(Event::Done(Step::UpdateApp)),
          Err(error) => report(Event::AppFailed { error, log }),
      }
  }
  report(Event::Switched);
  ```

- `update_app` runs `sys::run(log, repo/desktop, ["mise", "x", "--", "bash", "-s"], [],
  Some(INSTALL_APP))`. `mise x` in `desktop/` picks the branch's `desktop/mise.toml` (rust, zig).
- `Event::Switched` comes after `UpdateApp`, so the run is finished (and « Back to branches »
  shows) only once the app step is over.

**State (`main.rs`)**

- The event handling moves into a pure `Run::apply(&mut self, ev)`. `State::apply` calls it and
  keeps the `refresh()`.
- `State::start` computes `let app = sys::desktop_app_installed();`, adds `(UpdateApp, Pending)`
  after the six steps when `app` is true, and passes `app` to `runner::switch`.
- `Event::Order` rebuilds the six steps and keeps `UpdateApp` last if it was there.
- `Run` gets `app_failure: Option<AppFailure { error, log }>`. `Event::AppFailed` marks
  `UpdateApp` as failed and sets `app_failure`. `Run::finished()` is unchanged: an app failure is
  not a `failure`.

### 4. View (`view.rs`)

- « Update the desktop app » is the last step line when the step is in the run, with the usual
  pending / spinner / done / failed marks.
- The success callout « hooked now runs <branch>. » shows as soon as `Verify` is done, instead of
  waiting for the end of the run. « Back to branches » still waits for the end.
- After an app failure, a warning callout below it: « The desktop app was not updated: <error>.
  The previous version is still installed. », with the same log tail as a failure.
- « Copy log » shows when `app_failure` is set and copies its log (no rollback section).

### 5. Guards and failure handling (summary)

| Situation | Behaviour |
|---|---|
| Not macOS | No `UpdateApp` step |
| `/Applications/hooked.app` absent | No `UpdateApp` step (no Rust/Zig toolchain or 5 GB build imposed) |
| Only `/Applications/hooked (Rune).app` installed | No `UpdateApp` step, on purpose (old name; `mise run desktop` migrates it) |
| Branch without the Rune app | Warning « this branch has no Rune desktop app » |
| Any step up to `Verify` fails | Today's rollback; the app step never ran, the app is untouched |
| `cargo build`, `codesign` or the staging copy fails | Warning; previous app untouched and still running if it was |
| App does not quit within 10 s | Warning; previous app stays installed, and is reopened if it was running |
| `/Applications` refuses the swap | Warning; previous app put back and reopened if it was running |
| `mise x` fails (toolchain install, `desktop/mise.toml` not trusted) | Warning with mise's output |
| App was running | Quit, replaced, reopened |
| App was closed | Replaced, left closed |
| Another cargo build holds `desktop/target` | cargo waits for its lock; the step takes longer |

## How will it be monitored?

No telemetry: a local tool. The launcher's view is the monitoring: the step's status, the warning
callout, and « Copy log » with the script's full output.

## What are the risks?

- **Cold builds are long.** The first switch after a Rune bump, or with an empty `desktop/target`,
  adds several minutes after `Verify`. The service already runs the branch during that time, so
  nothing is unavailable; the launcher shows the spinner.
- **The launcher's embedded recipe wins over the branch's.** A branch that changes `install-app`
  is installed with the launcher's copy until `mise run launcher` is rerun from a checkout that has
  the change. Same trade-off as `NPM_DEPS`, accepted for the same reason (old branches keep
  working).
- **UI state is lost on every switch.** The app is relaunched even when `desktop/` did not change:
  drafts are saved, but scroll, open menus and split panes are lost. The service restart already
  cuts terminals and streams, so the extra cost is small. If it bothers, skip the relaunch when
  cargo reports `hooked-rune` as `fresh`.
- **macOS App Management.** Opened from the Finder, the launcher is the process that changes
  `/Applications`, and macOS may ask for permission or refuse. A refusal leaves the previous app in
  place and reopened, with a warning. Checked by hand (see below); documented in the README only if
  a dialog shows.
- **`mise run desktop` order change.** The deploy now runs before the app build. A failing app
  build after a deploy leaves the service redeployed, which `deploy-if-stale` would have done
  anyway.
- **Script fed on stdin.** Covered by the `main "$@"` wrapper (section 1).

## Proposed Tasks

- `desktop/scripts/install-app` (executable): build, bundle, codesign, staging copy, quit with
  wait, swap, reopen.
- `mise.toml`: `desktop` task runs `deploy-if-stale` then `scripts/install-app --open`.
- `flow.rs`: `Step::UpdateApp` and its label.
- `sys.rs`: `INSTALL_APP`, `desktop_app_installed()`.
- `runner.rs`: `app` parameter, `Event::AppFailed`, `UpdateApp` after the loop, `Switched` after
  it.
- `main.rs`: pure `Run::apply`, `Run.app_failure`, `start` and `Order` handling.
- `view.rs`: step line, success callout once `Verify` is done, warning callout, log tail,
  « Copy log » for the app failure.
- Tests (`cargo test -p hooked-launcher`):
  - the existing `flow` tests, unchanged;
  - `bash -n` on `INSTALL_APP` fed through stdin, and `INSTALL_APP` ends with the `main "$@"`
    call;
  - `Run::apply`: `Start(UpdateApp)` → `AppFailed` → `Switched` gives a finished run with no
    `failure`, an `app_failure`, and `UpdateApp` failed;
  - `Run::apply`: `Order(order(true))` keeps `UpdateApp` last.
- Manual check on macOS, from a launcher installed with `mise run launcher`:
  - switch to a branch that changes `desktop/`, app open, then app closed;
  - switch to a branch whose app does not build;
  - switch to `main` with no desktop change (fast build, app relaunched);
  - first run with the launcher opened from the Finder: note any macOS dialog;
  - `mise run desktop` with the app open, then closed.
- Docs:
  - `description` of the `desktop` and `launcher` tasks (the launcher also updates the desktop
    app);
  - `mise run desktop` bullet in `AGENTS.md` (when the back end is current, it only builds and
    installs the app);
  - one sentence in `desktop/README.md`: after a switch, the launcher rebuilds and reinstalls the
    app, and reopens it only if it was running.

- Communicate about the change --> PR description
- Deploy changes on existing clusters --> n/a (local tool; `mise run launcher` and
  `mise run desktop` once merged)
