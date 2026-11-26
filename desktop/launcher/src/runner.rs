//! Runs a switch on its own thread, step by step, and undoes it on failure (`flow::undo_plan`).

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::branches::{self, Branch, Running};
use crate::flow::{self, BuildOut, Changes, Step, Undo};
use crate::sys::{self, NPM_DEPS};

/// Vite config for branches whose vite.config.js predates HOOKED_BUILD_OUT (see the file).
const WRAPPED_CONFIG: &str = include_str!("build-out.vite.config.mjs");

#[derive(Default)]
pub struct Control {
    pub restart_anyway: AtomicBool,
    pub cancel: AtomicBool,
}

pub enum Event {
    Order([Step; 6]),
    Start(Step),
    Done(Step),
    Busy(usize),
    Failed { step: Step, error: String, log: String },
    /// Ok: the checkout and the service are as they were. Err: what is left to fix by hand.
    Undone(Result<(), String>, String),
    Switched,
}

/// Where the checkout stood before the run, to come back to it.
struct Start {
    branch: Option<String>,
    commit: String,
}

pub fn switch(repo: &Path, branch: &str, ctl: &Control, report: &dyn Fn(Event)) {
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
            Step::Verify => verify(),
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
