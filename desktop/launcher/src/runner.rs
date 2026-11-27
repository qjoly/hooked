//! Runs a branch switch or an extension flow on its own thread, step by step, and undoes it on
//! failure (`flow::undo_plan`, `flow::ext_undo_plan`).

use std::fs;
use std::path::{Component, Path};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::branches::{self, Branch, Running};
use crate::extensions::{self, ORIGIN, Service, Source};
use crate::flow::{self, BuildOut, Changes, ExtChanges, ExtUndo, Step, Undo};
use crate::sys::{self, INSTALL_APP, NPM_DEPS};

/// Vite config for branches whose vite.config.js predates HOOKED_BUILD_OUT (see the file).
const WRAPPED_CONFIG: &str = include_str!("build-out.vite.config.mjs");

#[derive(Default)]
pub struct Control {
    pub restart_anyway: AtomicBool,
    pub cancel: AtomicBool,
    /// The extension flow's confirmation was accepted.
    pub confirm: AtomicBool,
}

pub enum Event {
    Order([Step; 6]),
    Start(Step),
    Done(Step),
    Busy(usize),
    Failed { step: Step, error: String, log: String },
    /// Ok: the checkout and the service are as they were. Err: what is left to fix by hand.
    Undone(Result<(), String>, String),
    /// The service runs the branch; only the desktop app was not updated.
    AppFailed { error: String, log: String },
    /// The run is over: the service runs the branch, and the desktop app step, if any, has ended.
    Switched,
    /// The extension flow waits for `Control::confirm` or `Control::cancel`. `id`: the extension, known
    /// once fetched; `text` names the source.
    Confirm { id: String, text: String },
    /// Declined at the confirmation: what was staged is gone, nothing else was touched.
    Cancelled,
    /// Worth telling, not a failure (a rejected extension after a switch, a skipped reload).
    Note(String),
}

/// Where the checkout stood before the run, to come back to it.
struct Start {
    branch: Option<String>,
    commit: String,
}

/// `app`: whether the desktop app is updated once the service runs the branch.
pub fn switch(repo: &Path, branch: &str, app: bool, ctl: &Control, report: &dyn Fn(Event)) {
    let start = match read_start(repo) {
        Ok(s) => s,
        Err(error) => {
            return report(Event::Failed { step: Step::Fetch, error, log: String::new() });
        }
    };
    let mut changes = Changes::default();
    let mut install_deps = false;
    let mut order = flow::order(install_deps);
    // Indexed: the order changes once the checkout says whether the lockfile changed, and both
    // orders start with the same two steps.
    let mut i = 0;
    while i < order.len() {
        let step = order[i];
        report(Event::Start(step));
        let mut log = String::new();
        let r = match step {
            Step::Fetch => sys::git(&mut log, repo, &["fetch", "--prune", "origin"]).map(drop),
            Step::Checkout => checkout(repo, branch, &mut changes, &mut log)
                .map(|()| install_deps = deps_due(repo, &mut log)),
            Step::Build => build(repo, install_deps, &mut changes, &mut log),
            Step::WaitTurns => wait_turns(ctl, report),
            Step::Swap => swap(repo, &mut changes, &mut log),
            Step::Verify => verify().map(|()| note_rejected(report)),
            Step::Place | Step::Reload | Step::UpdateApp => unreachable!("not part of flow::order"),
        };
        if let Err(error) = r {
            report(Event::Failed { step, error, log });
            let (result, undo_log) = undo(repo, &start, changes);
            report(Event::Undone(result, undo_log));
            return;
        }
        report(Event::Done(step));
        if step == Step::Checkout && install_deps {
            order = flow::order(install_deps);
            report(Event::Order(order));
        }
        i += 1;
    }
    // After the loop, so an app failure cannot reach the undo path, and after Verify, so the new app
    // reads the new back end's capabilities when it starts.
    if app {
        report(Event::Start(Step::UpdateApp));
        let mut log = String::new();
        match update_app(repo, &mut log) {
            Ok(()) => report(Event::Done(Step::UpdateApp)),
            Err(error) => report(Event::AppFailed { error, log }),
        }
    }
    report(Event::Switched);
}

fn read_start(repo: &Path) -> Result<Start, String> {
    Ok(Start {
        branch: sys::query(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .ok()
            .map(|b| b.trim().to_string()),
        commit: sys::query(repo, &["rev-parse", "HEAD"])?.trim().to_string(),
    })
}

fn checkout(repo: &Path, branch: &str, changes: &mut Changes, log: &mut String) -> Result<(), String> {
    let dirty = sys::query(repo, &["status", "--porcelain", "--untracked-files=no"])?;
    if !dirty.trim().is_empty() {
        let files: Vec<&str> = dirty.lines().take(5).collect();
        return Err(format!(
            "Local changes in {}; commit or stash them first:\n{}",
            repo.display(),
            files.join("\n")
        ));
    }
    changes.checkout = true;
    let local = format!("refs/heads/{branch}");
    let remote = format!("origin/{branch}");
    let here = sys::query(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]).unwrap_or_default();
    if here.trim() != branch && flow::checked_out(&sys::query(repo, &["worktree", "list", "--porcelain"])?, branch) {
        // Held by a worktree: the service runs the pushed tip, detached. Sharing the branch
        // (`--ignore-other-worktrees`) would let the fast-forward move the HEAD of that worktree
        // under its files.
        return sys::git(log, repo, &["checkout", "--detach", &remote]).map(drop);
    }
    if sys::query(repo, &["rev-parse", "--verify", "--quiet", &local]).is_ok() {
        sys::git(log, repo, &["checkout", branch])?;
    } else {
        sys::git(log, repo, &["checkout", "-b", branch, "--track", &remote])?;
    }
    // `git pull --ff-only` without a second fetch, and whatever upstream the local branch has.
    sys::git(log, repo, &["merge", "--ff-only", &remote]).map(drop)
}

fn deps_due(repo: &Path, log: &mut String) -> bool {
    // Exit 1 means "install due". Any other failure also lands on `npm ci`, whose error says more
    // than a guess here would.
    sys::run(log, repo, &["bash", "-s", "--", "--check"], &[], Some(NPM_DEPS)).is_err()
}

fn build(repo: &Path, install_deps: bool, changes: &mut Changes, log: &mut String) -> Result<(), String> {
    if install_deps {
        changes.deps = true;
        sys::run(log, repo, &["mise", "x", "--", "bash", "-s"], &[], Some(NPM_DEPS))?;
    }
    let next = repo.join("build-next");
    changes.build_next = true;
    remove_dir(&next)?;
    let env = [("HOOKED_BUILD_OUT", "build-next")];
    let config = fs::read_to_string(repo.join("vite.config.js")).unwrap_or_default();
    match flow::build_out(&config) {
        BuildOut::Env => {
            sys::run(log, repo, &["mise", "x", "--", "npm", "run", "build"], &env, None)?;
        }
        BuildOut::WrappedConfig => {
            // Written after the install, which empties node_modules. Living there, it resolves
            // the branch's own packages, and git ignores it.
            let dir = repo.join("node_modules/.hooked-launcher");
            let wrapper = dir.join("vite.config.mjs");
            fs::create_dir_all(&dir)
                .and_then(|()| fs::write(&wrapper, WRAPPED_CONFIG))
                .map_err(|e| format!("{}: {e}", wrapper.display()))?;
            log.push_str("vite.config.js predates HOOKED_BUILD_OUT: building through the launcher's config\n");
            let wrapper = wrapper.to_string_lossy();
            sys::run(
                log,
                repo,
                &["mise", "x", "--", "node_modules/.bin/vite", "build", "--config", &wrapper, "--configLoader", "native"],
                &env,
                None,
            )?;
        }
    }
    if !next.join("index.js").is_file() {
        return Err("The build left no build-next/index.js".into());
    }
    // The stamp deploy/service-run.sh compares with HEAD: without it, the restart would build again.
    let head = sys::query(repo, &["rev-parse", "HEAD"])?;
    fs::write(next.join(".hooked-src-commit"), head).map_err(|e| e.to_string())
}

fn wait_turns(ctl: &Control, report: &dyn Fn(Event)) -> Result<(), String> {
    loop {
        // An unreachable service has no turn to wait for.
        let busy = sys::get_json("/api/sessions", Duration::from_secs(10))
            .map_or(0, |list| flow::busy_sessions(&list));
        report(Event::Busy(busy));
        if busy == 0 || ctl.restart_anyway.load(Ordering::Relaxed) {
            return Ok(());
        }
        for _ in 0..10 {
            if ctl.cancel.load(Ordering::Relaxed) {
                return Err("Cancelled".into());
            }
            if ctl.restart_anyway.load(Ordering::Relaxed) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

fn swap(repo: &Path, changes: &mut Changes, log: &mut String) -> Result<(), String> {
    let (build, prev, next) = (repo.join("build"), repo.join("build-prev"), repo.join("build-next"));
    remove_dir(&prev)?;
    if build.exists() {
        changes.old_build_moved = true;
        rename(log, &build, &prev)?;
    }
    changes.new_build_moved = true;
    rename(log, &next, &build)?;
    sys::restart_service(log, repo)
}

fn verify() -> Result<(), String> {
    if sys::wait_reachable(Duration::from_secs(60)) {
        Ok(())
    } else {
        Err(format!("hooked did not answer on {} within 60 s", sys::base_url()))
    }
}

/// The branch may reject installed extensions (another `api`): flagged, never undone, since the
/// switch itself worked.
fn note_rejected(report: &dyn Fn(Event)) {
    if let Ok(v) = sys::get_json("/api/extensions", Duration::from_secs(5)) {
        for note in flow::rejected_notes(&v) {
            report(Event::Note(note));
        }
    }
}

fn update_app(repo: &Path, log: &mut String) -> Result<(), String> {
    let desktop = repo.join("desktop");
    // Branches older than any desktop/ folder; the script says the same for those whose desktop/ is
    // not the Rune app.
    if !desktop.is_dir() {
        return Err("this branch has no Rune desktop app".into());
    }
    // `mise x` in desktop/ brings the branch's own toolchain (desktop/mise.toml: Rust, Zig).
    sys::run(log, &desktop, &["mise", "x", "--", "bash", "-s"], &[], Some(INSTALL_APP))
        .map(drop)
        // The output's last line (cargo's error, the script's own message) says more than the
        // exit status; mise's generic trailer after a failed install is skipped.
        .map_err(|e| {
            log.lines()
                .rev()
                .find(|l| !l.trim().is_empty() && !l.starts_with("mise ERROR Version") && !l.starts_with("mise ERROR Run with"))
                .map_or(e, str::to_string)
        })
}

fn undo(repo: &Path, start: &Start, changes: Changes) -> (Result<(), String>, String) {
    let mut log = String::new();
    let mut failed = Vec::new();
    let (build, prev, next) = (repo.join("build"), repo.join("build-prev"), repo.join("build-next"));
    for step in flow::undo_plan(changes) {
        let r = match step {
            Undo::RemoveBuildNext => remove_dir(&next),
            Undo::DiscardNewBuild => remove_dir(&build),
            Undo::RestorePrevBuild => rename(&mut log, &prev, &build),
            Undo::RestoreCheckout => restore_checkout(repo, start, &mut log),
            Undo::ReinstallDeps => {
                sys::run(&mut log, repo, &["mise", "x", "--", "bash", "-s"], &[], Some(NPM_DEPS)).map(drop)
            }
            Undo::RestartService => sys::restart_service(&mut log, repo).and_then(|()| {
                if sys::wait_reachable(Duration::from_secs(60)) {
                    Ok(())
                } else {
                    Err("hooked did not come back after the rollback".into())
                }
            }),
        };
        if let Err(e) = r {
            log.push_str(&format!("✗ {step:?}: {e}\n"));
            failed.push(format!("{step:?}: {e}"));
        }
    }
    let result = if failed.is_empty() { Ok(()) } else { Err(failed.join("\n")) };
    (result, log)
}

fn restore_checkout(repo: &Path, start: &Start, log: &mut String) -> Result<(), String> {
    match &start.branch {
        Some(b) => sys::git(log, repo, &["checkout", b])?,
        None => sys::git(log, repo, &["checkout", "--detach", &start.commit])?,
    };
    // The start branch itself moved when it was the one switched to (the fast-forward).
    let head = sys::query(repo, &["rev-parse", "HEAD"])?;
    if head.trim() != start.commit {
        sys::git(log, repo, &["reset", "--keep", &start.commit])?;
    }
    Ok(())
}

fn remove_dir(dir: &Path) -> Result<(), String> {
    match fs::remove_dir_all(dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{}: {e}", dir.display())),
        _ => Ok(()),
    }
}

fn rename(log: &mut String, from: &Path, to: &Path) -> Result<(), String> {
    log.push_str(&format!("mv {} {}\n", from.display(), to.display()));
    fs::rename(from, to).map_err(|e| format!("{} → {}: {e}", from.display(), to.display()))
}

pub enum ExtChange {
    /// Install, or update when `<id>` is already there. `id`: the id a catalog entry or an update
    /// targets; a bare git source learns it from the manifest.
    Install { source: Source, id: Option<String> },
    Uninstall(String),
}

enum ExtOutcome {
    Done,
    Cancelled,
}

struct StepFailure {
    step: Step,
    error: String,
    log: String,
}

/// Installs, updates or uninstalls one extension under `root` (`$HOOKED_EXTENSIONS_DIR`). It never
/// builds, restarts the service or waits for turns: the service reloads that extension in place.
/// `app`: whether the desktop app is installed; it is updated only for a Rust desktop page.
pub fn apply_extension(
    repo: &Path,
    root: &Path,
    change: &ExtChange,
    app: bool,
    ctl: &Control,
    svc: &dyn Service,
    report: &dyn Fn(Event),
) {
    let mut changes = ExtChanges::default();
    let mut id = match change {
        ExtChange::Install { id, .. } => id.clone().unwrap_or_default(),
        ExtChange::Uninstall(id) => id.clone(),
    };
    let r = extension_steps(repo, root, change, app, ctl, svc, &mut id, &mut changes, report);
    match r {
        Ok(ExtOutcome::Done) => report(Event::Switched),
        Ok(ExtOutcome::Cancelled) => {
            let _ = undo_extension(root, &id, changes, svc);
            report(Event::Cancelled);
        }
        Err(StepFailure { step, error, log }) => {
            report(Event::Failed { step, error, log });
            let (result, undo_log) = undo_extension(root, &id, changes, svc);
            report(Event::Undone(result, undo_log));
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn extension_steps(
    repo: &Path,
    root: &Path,
    change: &ExtChange,
    app: bool,
    ctl: &Control,
    svc: &dyn Service,
    id: &mut String,
    changes: &mut ExtChanges,
    report: &dyn Fn(Event),
) -> Result<ExtOutcome, StepFailure> {
    let step = |step: Step, f: &mut dyn FnMut(&mut String) -> Result<(), String>| {
        report(Event::Start(step));
        let mut log = String::new();
        match f(&mut log) {
            Ok(()) => {
                report(Event::Done(step));
                Ok(())
            }
            Err(error) => Err(StepFailure { step, error, log }),
        }
    };
    // Read once: an unreachable service is not asked to reload, and Verify reads the disk instead.
    let listing = svc.listing().ok();
    let uninstall = matches!(change, ExtChange::Uninstall(_));
    let live = |id: &str| root.join(id);
    let previous = |id: &str| extensions::read_json(&live(id).join(ORIGIN));
    let mut rust_after = false;
    let confirmation = match change {
        ExtChange::Install { source, id: expected } => {
            let mut staged = None;
            step(Step::Fetch, &mut |log| {
                let api = listing
                    .as_ref()
                    .and_then(|v| v["api"].as_u64())
                    .or_else(|| extensions::api_from_checkout(repo))
                    .ok_or("cannot tell which extension api hooked offers")?;
                staged = Some(fetch(repo, root, source, expected.as_deref(), api, changes, log)?);
                Ok(())
            })?;
            let staged = staged.expect("set by a successful fetch");
            *id = staged.id;
            rust_after = staged.rust;
            let mut msg = format!(
                "This extension's code runs inside hooked and the desktop app with your rights. Source: {}@{}",
                source.repo, staged.commit
            );
            if let Some(old) = previous(id) {
                msg.push_str(&format!("\nReplaces {id} at {}.", old["commit"].as_str().unwrap_or("an unknown commit")));
            }
            msg
        }
        ExtChange::Uninstall(_) => {
            let source = previous(id).map_or("unknown".into(), |o| {
                format!("{}@{}", o["repo"].as_str().unwrap_or("?"), o["commit"].as_str().unwrap_or("?"))
            });
            format!("Uninstall {id}? Its data and settings files are kept. Source: {source}")
        }
    };
    report(Event::Confirm { id: id.clone(), text: confirmation });
    if !wait_confirm(ctl) {
        return Ok(ExtOutcome::Cancelled);
    }
    let id = id.as_str();
    let rust_before = rust_page(&live(id));
    step(Step::Place, &mut |log| place(root, id, uninstall, changes, log))?;
    step(Step::Reload, &mut |log| {
        if listing.is_none() {
            report(Event::Note(format!("hooked is unreachable: it loads {id} at its next start.")));
            return Ok(());
        }
        changes.reloaded = true;
        log.push_str(&format!("POST /api/extensions/reload {{ id: {id} }}\n"));
        svc.reload(id).map(drop)
    })?;
    step(Step::Verify, &mut |_| match &listing {
        Some(_) => svc.listing().and_then(|v| flow::verify_listing(&v, id, !uninstall)),
        None => verify_on_disk(&live(id), id, !uninstall),
    })?;
    // Past Verify nothing is undone: the previous folder is only a backup now.
    let prev = root.join(format!("{id}.prev"));
    if let Err(e) = remove_dir(&prev) {
        report(Event::Note(format!("Could not remove {}: {e}", prev.display())));
    }
    if app && (rust_before || rust_after) {
        report(Event::Start(Step::UpdateApp));
        let mut log = String::new();
        match update_app(repo, &mut log) {
            Ok(()) => report(Event::Done(Step::UpdateApp)),
            Err(error) => report(Event::AppFailed { error, log }),
        }
    }
    Ok(ExtOutcome::Done)
}

fn wait_confirm(ctl: &Control) -> bool {
    loop {
        if ctl.cancel.load(Ordering::Relaxed) {
            return false;
        }
        if ctl.confirm.load(Ordering::Relaxed) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn rust_page(dir: &Path) -> bool {
    extensions::read_json(&dir.join("extension.json")).is_some_and(|m| m["desktop"]["rust"] == true)
}

struct Staged {
    id: String,
    commit: String,
    rust: bool,
}

/// Clones the source into a temporary folder, checks its manifest, and stages the extension as
/// `<id>.next` with its `.origin.json`. Only `<id>.next` is written under `root`.
fn fetch(
    repo: &Path,
    root: &Path,
    source: &Source,
    expected: Option<&str>,
    api: u64,
    changes: &mut ExtChanges,
    log: &mut String,
) -> Result<Staged, String> {
    // The path is joined to the clone: it must stay inside it.
    if !Path::new(&source.path).components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(format!("the path \"{}\" leaves the repository", source.path));
    }
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let clone = std::env::temp_dir().join(format!("hooked-ext-fetch-{}-{nanos}", std::process::id()));
    let r = (|| {
        let target = clone.to_string_lossy();
        let branch = format!("--branch={}", source.r#ref);
        sys::git(log, &std::env::temp_dir(), &["clone", "--depth", "1", &branch, "--", &source.repo, &target])?;
        let commit = sys::git(log, &clone, &["rev-parse", "HEAD"])?.trim().to_string();
        let dir = clone.join(&source.path);
        let manifest = extensions::read_json(&dir.join("extension.json"))
            .ok_or_else(|| format!("no readable extension.json in {}@{}:{}", source.repo, source.r#ref, source.path))?;
        let id = flow::check_manifest(&manifest, expected, api, |id| repo.join("extensions").join(id).is_dir())?;
        let next = root.join(format!("{id}.next"));
        remove_dir(&next)?;
        changes.staged = true;
        copy_dir(&dir, &next)?;
        let origin = source.origin_json(&commit, crate::now());
        fs::write(next.join(ORIGIN), origin.to_string()).map_err(|e| format!("{}: {e}", next.join(ORIGIN).display()))?;
        log.push_str(&format!("staged {} at {commit}\n", next.display()));
        Ok(Staged { id, commit, rust: manifest["desktop"]["rust"] == true })
    })();
    let _ = fs::remove_dir_all(&clone);
    r
}

/// The extension's files, without the clone's `.git`. A symlink is refused: it could point
/// anywhere on this machine.
fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("{}: {e}", to.display()))?;
    for entry in fs::read_dir(from).map_err(|e| format!("{}: {e}", from.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if entry.file_name() == ".git" {
            continue;
        } else if kind.is_symlink() {
            return Err(format!("{} is a symlink", src.display()));
        } else if kind.is_dir() {
            copy_dir(&src, &dst)?;
        } else {
            fs::copy(&src, &dst).map_err(|e| format!("{}: {e}", src.display()))?;
        }
    }
    Ok(())
}

/// `<id>` → `<id>.prev`, then `<id>.next` → `<id>` (an uninstall stops after the first move).
fn place(root: &Path, id: &str, uninstall: bool, changes: &mut ExtChanges, log: &mut String) -> Result<(), String> {
    let (live, prev, next) = ext_dirs(root, id);
    remove_dir(&prev)?;
    if live.exists() {
        changes.old_moved = true;
        rename(log, &live, &prev)?;
    } else if uninstall {
        return Err(format!("{id} is not installed in {}", root.display()));
    }
    if !uninstall {
        changes.new_moved = true;
        rename(log, &next, &live)?;
    }
    Ok(())
}

/// Without a service: the folder is there with the right manifest, or gone.
fn verify_on_disk(live: &Path, id: &str, present: bool) -> Result<(), String> {
    let manifest = extensions::read_json(&live.join("extension.json"));
    match (present, manifest) {
        (true, Some(m)) if m["id"] == id => Ok(()),
        (true, _) => Err(format!("no extension.json for {id} in {}", live.display())),
        (false, None) if !live.exists() => Ok(()),
        (false, _) => Err(format!("{} is still there", live.display())),
    }
}

fn ext_dirs(root: &Path, id: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    (root.join(id), root.join(format!("{id}.prev")), root.join(format!("{id}.next")))
}

fn undo_extension(root: &Path, id: &str, changes: ExtChanges, svc: &dyn Service) -> (Result<(), String>, String) {
    let mut log = String::new();
    let mut failed = Vec::new();
    let (live, prev, next) = ext_dirs(root, id);
    for step in flow::ext_undo_plan(changes) {
        let r = match step {
            ExtUndo::RemoveNext => remove_dir(&next),
            ExtUndo::DiscardNew => remove_dir(&live),
            ExtUndo::RestorePrev => rename(&mut log, &prev, &live),
            ExtUndo::Reload => svc.reload(id).map(drop),
        };
        if let Err(e) = r {
            log.push_str(&format!("✗ {step:?}: {e}\n"));
            failed.push(format!("{step:?}: {e}"));
        }
    }
    let result = if failed.is_empty() { Ok(()) } else { Err(failed.join("\n")) };
    (result, log)
}

pub struct Listing {
    pub rows: Vec<branches::Row>,
    /// The fetch failed: the rows are the refs from the last fetch that worked.
    pub stale: Option<String>,
}

/// The list's data: `origin` refs after a fetch, the unmerged ones, and what runs.
pub fn list(repo: &Path) -> Result<Listing, String> {
    let stale = sys::query(repo, &["fetch", "--prune", "origin"]).err();
    let format = format!("--format={}", branches::REF_FORMAT);
    let all: Vec<Branch> = branches::parse_refs(&sys::query(repo, &["for-each-ref", &format, "refs/remotes/origin"])?);
    let main = format!("origin/{}", branches::MAIN);
    let unmerged: Vec<String> = sys::query(
        repo,
        &["for-each-ref", "--no-merged", &main, "--format=%(refname:lstrip=3)", "refs/remotes/origin"],
    )?
    .lines()
    .map(str::to_string)
    .collect();
    let running = Running {
        branch: sys::query(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .ok()
            .map(|b| b.trim().to_string()),
        commit: fs::read_to_string(repo.join("build/.hooked-src-commit"))
            .ok()
            .map(|c| c.trim().to_string()),
    };
    let behind = |commit: &str, tip: &str| {
        sys::query(repo, &["merge-base", "--is-ancestor", commit, tip]).is_ok()
    };
    Ok(Listing { rows: branches::rows(all, &unmerged, &running, behind), stale })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::path::PathBuf;

    use serde_json::{Value, json};

    /// A service that loads what the folder holds: an extension whose manifest says `"broken": true`
    /// fails to start, as a real one throwing in `start()` would.
    struct FakeService {
        root: PathBuf,
        up: bool,
        api: u64,
        reload_fails: bool,
        reloads: RefCell<Vec<String>>,
    }

    impl FakeService {
        fn new(root: &Path) -> Self {
            FakeService { root: root.into(), up: true, api: 1, reload_fails: false, reloads: RefCell::default() }
        }
    }

    impl Service for FakeService {
        fn listing(&self) -> Result<Value, String> {
            if !self.up {
                return Err("connection refused".into());
            }
            let m = extensions::read_json(&self.root.join("hello/extension.json"));
            let exts: Vec<Value> = m
                .into_iter()
                .map(|m| {
                    let broken = m["broken"] == true;
                    json!({ "id": m["id"], "source": "installed", "enabled": true, "available": true,
                            "active": !broken, "errors": if broken { json!(["start: boom"]) } else { json!([]) } })
                })
                .collect();
            Ok(json!({ "api": self.api, "extensions": exts, "rejected": [] }))
        }

        fn reload(&self, id: &str) -> Result<Value, String> {
            self.reloads.borrow_mut().push(id.into());
            if self.reload_fails { Err("http status: 400".into()) } else { self.listing() }
        }
    }

    struct Bed {
        tmp: PathBuf,
        root: PathBuf,
        /// The service's checkout: the real one, for `EXTENSION_API` and the bundled ids.
        checkout: PathBuf,
    }

    impl Bed {
        fn new(name: &str) -> Self {
            let tmp = std::env::temp_dir().join(format!("launcher-flow-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&tmp);
            fs::create_dir_all(&tmp).unwrap();
            Bed { root: tmp.join("installed"), tmp, checkout: Path::new(env!("CARGO_MANIFEST_DIR")).join("../..") }
        }

        /// A git repo holding the `hello` fixture, its manifest patched with `extra`.
        fn repo(&self, name: &str, extra: Value) -> Source {
            let dir = self.tmp.join(name);
            copy_dir(&self.checkout.join("test/fixtures/extensions/hello"), &dir).unwrap();
            let mut m = extensions::read_json(&dir.join("extension.json")).unwrap();
            for (k, v) in extra.as_object().unwrap() {
                m[k] = v.clone();
            }
            fs::write(dir.join("extension.json"), m.to_string()).unwrap();
            let mut log = String::new();
            for args in [
                &["init", "--quiet", "-b", "main"][..],
                &["add", "."],
                &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "hello"],
            ] {
                sys::git(&mut log, &dir, args).unwrap();
            }
            Source { repo: dir.to_string_lossy().into(), r#ref: "main".into(), path: ".".into() }
        }

        fn run(&self, change: &ExtChange, svc: &FakeService, answer: Option<bool>) -> Vec<String> {
            let ctl = Control::default();
            match answer {
                Some(true) => ctl.confirm.store(true, Ordering::Relaxed),
                Some(false) => ctl.cancel.store(true, Ordering::Relaxed),
                None => {}
            }
            let events = RefCell::new(Vec::new());
            apply_extension(&self.checkout, &self.root, change, false, &ctl, svc, &|ev| {
                events.borrow_mut().push(match ev {
                    Event::Failed { step, error, .. } => format!("failed {step:?}: {error}"),
                    Event::Undone(r, _) => format!("undone {}", r.is_ok()),
                    Event::Done(step) => format!("done {step:?}"),
                    Event::Confirm { .. } => "confirm".into(),
                    Event::Cancelled => "cancelled".into(),
                    Event::Note(n) => format!("note {n}"),
                    Event::Switched => "finished".into(),
                    _ => String::new(),
                });
            });
            events.into_inner().into_iter().filter(|e| !e.is_empty()).collect()
        }

        /// The folders under the installed root, sorted.
        fn folders(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(&self.root)
                .map(|d| d.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect())
                .unwrap_or_default();
            names.sort();
            names
        }

        fn installed_version(&self) -> Option<String> {
            extensions::read_json(&self.root.join("hello/extension.json")).and_then(|m| m["version"].as_str().map(str::to_string))
        }

        fn install(&self, source: &Source, svc: &FakeService) -> Vec<String> {
            self.run(&ExtChange::Install { source: source.clone(), id: Some("hello".into()) }, svc, Some(true))
        }
    }

    impl Drop for Bed {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.tmp);
        }
    }

    #[test]
    fn installs_an_extension_from_git_with_its_origin() {
        let bed = Bed::new("install");
        let source = bed.repo("v1", json!({}));
        let svc = FakeService::new(&bed.root);
        let events = bed.install(&source, &svc);
        assert_eq!(events, ["done Fetch", "confirm", "done Place", "done Reload", "done Verify", "finished"]);
        assert_eq!(bed.folders(), ["hello"]);
        let origin = extensions::read_json(&bed.root.join("hello").join(ORIGIN)).unwrap();
        assert_eq!((origin["repo"].as_str(), origin["ref"].as_str(), origin["path"].as_str()), (Some(source.repo.as_str()), Some("main"), Some(".")));
        assert_eq!(origin["commit"].as_str().map(str::len), Some(40));
        assert!(!bed.root.join("hello/.git").exists());
        assert_eq!(*svc.reloads.borrow(), ["hello"]);
    }

    #[test]
    fn a_failed_fetch_touches_nothing() {
        let bed = Bed::new("fetch");
        let v1 = bed.repo("v1", json!({}));
        let svc = FakeService::new(&bed.root);
        bed.install(&v1, &svc);
        let v2 = bed.repo("v2", json!({ "version": "2.0.0", "api": 2 }));
        let events = bed.install(&v2, &svc);
        assert_eq!(events, ["failed Fetch: api 2, hooked offers 1", "undone true"]);
        assert_eq!(bed.folders(), ["hello"]);
        assert_eq!(bed.installed_version().as_deref(), Some("1.0.0"));
        assert_eq!(*svc.reloads.borrow(), ["hello"]);
    }

    #[test]
    fn a_fetch_refuses_an_id_hooked_ships() {
        let bed = Bed::new("bundled");
        let source = bed.repo("v1", json!({}));
        fs::create_dir_all(bed.tmp.join("checkout/extensions/hello")).unwrap();
        let ctl = Control::default();
        let failed = RefCell::new(None);
        let svc = FakeService::new(&bed.root);
        let change = ExtChange::Install { source, id: None };
        apply_extension(&bed.tmp.join("checkout"), &bed.root, &change, false, &ctl, &svc, &|ev| {
            if let Event::Failed { error, .. } = ev {
                *failed.borrow_mut() = Some(error);
            }
        });
        assert_eq!(failed.into_inner().as_deref(), Some("hooked already ships an extension \"hello\""));
        assert!(bed.folders().is_empty());
    }

    #[test]
    fn declining_the_confirmation_drops_what_was_staged() {
        let bed = Bed::new("cancel");
        let source = bed.repo("v1", json!({}));
        let svc = FakeService::new(&bed.root);
        let events = bed.run(&ExtChange::Install { source, id: None }, &svc, Some(false));
        assert_eq!(events, ["done Fetch", "confirm", "cancelled"]);
        assert!(bed.folders().is_empty());
        assert!(svc.reloads.borrow().is_empty());
    }

    #[test]
    fn a_failed_verify_puts_the_previous_version_back_and_reloads_it() {
        let bed = Bed::new("verify");
        let svc = FakeService::new(&bed.root);
        bed.install(&bed.repo("v1", json!({})), &svc);
        let events = bed.install(&bed.repo("v2", json!({ "version": "2.0.0", "broken": true })), &svc);
        assert_eq!(&events[events.len() - 2..], ["failed Verify: start: boom", "undone true"]);
        assert_eq!(bed.folders(), ["hello"]);
        assert_eq!(bed.installed_version().as_deref(), Some("1.0.0"));
        assert_eq!(*svc.reloads.borrow(), ["hello", "hello", "hello"]);
    }

    #[test]
    fn a_failed_reload_puts_the_previous_version_back() {
        let bed = Bed::new("reload");
        let mut svc = FakeService::new(&bed.root);
        bed.install(&bed.repo("v1", json!({})), &svc);
        svc.reload_fails = true;
        let events = bed.install(&bed.repo("v2", json!({ "version": "2.0.0" })), &svc);
        // The rollback's own reload fails too here, and says so.
        assert_eq!(&events[events.len() - 2..], ["failed Reload: http status: 400", "undone false"]);
        assert_eq!(bed.folders(), ["hello"]);
        assert_eq!(bed.installed_version().as_deref(), Some("1.0.0"));
    }

    #[test]
    fn a_place_cut_halfway_is_put_back() {
        let bed = Bed::new("place");
        let svc = FakeService::new(&bed.root);
        bed.install(&bed.repo("v1", json!({})), &svc);
        // As Place leaves it when the second rename fails: the live folder moved aside, the new one
        // still staged.
        fs::rename(bed.root.join("hello"), bed.root.join("hello.prev")).unwrap();
        fs::create_dir_all(bed.root.join("hello.next")).unwrap();
        let changes = ExtChanges { staged: true, old_moved: true, ..ExtChanges::default() };
        let (result, _) = undo_extension(&bed.root, "hello", changes, &svc);
        assert_eq!(result, Ok(()));
        assert_eq!(bed.folders(), ["hello"]);
        assert_eq!(bed.installed_version().as_deref(), Some("1.0.0"));
    }

    #[test]
    fn uninstalls_and_keeps_nothing_behind() {
        let bed = Bed::new("uninstall");
        let svc = FakeService::new(&bed.root);
        bed.install(&bed.repo("v1", json!({})), &svc);
        let events = bed.run(&ExtChange::Uninstall("hello".into()), &svc, Some(true));
        assert_eq!(events, ["confirm", "done Place", "done Reload", "done Verify", "finished"]);
        assert!(bed.folders().is_empty());
    }

    #[test]
    fn without_a_service_the_flow_skips_the_reload_and_checks_the_disk() {
        let bed = Bed::new("offline");
        let mut svc = FakeService::new(&bed.root);
        svc.up = false;
        let events = bed.install(&bed.repo("v1", json!({})), &svc);
        assert_eq!(
            events,
            ["done Fetch", "confirm", "done Place", "note hooked is unreachable: it loads hello at its next start.", "done Reload", "done Verify", "finished"]
        );
        assert_eq!(bed.folders(), ["hello"]);
        assert!(svc.reloads.borrow().is_empty());
    }

    #[test]
    fn refuses_a_path_that_leaves_the_repository() {
        let bed = Bed::new("path");
        let mut source = bed.repo("v1", json!({}));
        source.path = "../v1".into();
        let events = bed.install(&source, &FakeService::new(&bed.root));
        assert_eq!(events, ["failed Fetch: the path \"../v1\" leaves the repository", "undone true"]);
    }
}

/// Against a test service, never the real one:
/// `HOOKED_URL=http://127.0.0.1:4124 HOOKED_EXTENSIONS_DIR=<its dir> cargo test -p hooked-launcher -- --ignored`.
#[cfg(test)]
mod live {
    use super::*;
    use std::path::PathBuf;

    #[test]
    #[ignore = "needs a test hooked service (HOOKED_URL, HOOKED_EXTENSIONS_DIR)"]
    fn installs_updates_and_uninstalls_hello_in_a_running_service() {
        let url = sys::base_url();
        assert!(!url.contains(":4123"), "never against the real service: {url}");
        let root = PathBuf::from(std::env::var("HOOKED_EXTENSIONS_DIR").expect("the test service's HOOKED_EXTENSIONS_DIR"));
        let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let repo = std::env::temp_dir().join(format!("launcher-live-hello-{}", std::process::id()));
        let _ = fs::remove_dir_all(&repo);
        copy_dir(&checkout.join("test/fixtures/extensions/hello"), &repo).unwrap();
        let mut log = String::new();
        let commit = |log: &mut String, msg: &str| {
            sys::git(log, &repo, &["add", "."]).unwrap();
            sys::git(log, &repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", msg]).unwrap();
        };
        sys::git(&mut log, &repo, &["init", "--quiet", "-b", "main"]).unwrap();
        commit(&mut log, "hello v1");
        let source = Source { repo: format!("file://{}", repo.display()), r#ref: "main".into(), path: ".".into() };
        let run = |change: &ExtChange| {
            let ctl = Control::default();
            ctl.confirm.store(true, Ordering::Relaxed);
            let outcome = std::cell::RefCell::new(None);
            apply_extension(&checkout, &root, change, false, &ctl, &extensions::Http, &|ev| match ev {
                Event::Failed { step, error, log } => *outcome.borrow_mut() = Some(Err(format!("{step:?}: {error}\n{log}"))),
                Event::Switched => *outcome.borrow_mut() = Some(Ok(())),
                _ => {}
            });
            outcome.into_inner().expect("the flow ended")
        };
        let hello = |v: &serde_json::Value| v["extensions"].as_array().unwrap().iter().find(|e| e["id"] == "hello").cloned();

        run(&ExtChange::Install { source: source.clone(), id: Some("hello".into()) }).unwrap();
        let listed = hello(&extensions::Http.listing().unwrap()).expect("hello is loaded");
        assert_eq!(listed["source"], "installed");
        assert_eq!(listed["origin"]["commit"].as_str().map(str::len), Some(40));

        let manifest = repo.join("extension.json");
        let text = fs::read_to_string(&manifest).unwrap().replace("\"1.0.0\"", "\"1.1.0\"");
        fs::write(&manifest, text).unwrap();
        commit(&mut log, "hello v1.1");
        run(&ExtChange::Install { source, id: Some("hello".into()) }).unwrap();
        assert_eq!(hello(&extensions::Http.listing().unwrap()).unwrap()["version"], "1.1.0");

        run(&ExtChange::Uninstall("hello".into())).unwrap();
        assert!(hello(&extensions::Http.listing().unwrap()).is_none());
        let _ = fs::remove_dir_all(&repo);
    }
}
