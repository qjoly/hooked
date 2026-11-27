//! The branch switch and the extension flow as pure decisions: which steps run in which order, what
//! a failure has to undo, what counts as success. `runner.rs` performs them.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Step {
    Fetch,
    Checkout,
    Build,
    WaitTurns,
    Swap,
    /// Extension flow: the staged folder takes the live one's place.
    Place,
    /// Extension flow: the service loads what is on disk now.
    Reload,
    Verify,
    /// After the switch, outside `order` and the undo plan: it has nothing to undo, and its failure
    /// leaves the service on the branch.
    UpdateApp,
}

impl Step {
    pub fn label(self) -> &'static str {
        match self {
            Step::Fetch => "Fetch",
            Step::Checkout => "Switch branch",
            Step::Build => "Build",
            Step::WaitTurns => "Wait for turns",
            Step::Swap => "Swap and restart",
            Step::Place => "Place",
            Step::Reload => "Reload in hooked",
            Step::Verify => "Verify",
            Step::UpdateApp => "Update the desktop app",
        }
    }
}

/// The extension flow's steps: no build, no restart, no wait for turns (the service reloads one
/// extension in place). An uninstall has nothing to fetch.
pub fn extension_order(uninstall: bool) -> Vec<Step> {
    let steps = [Step::Fetch, Step::Place, Step::Reload, Step::Verify];
    steps.into_iter().filter(|s| !(uninstall && *s == Step::Fetch)).collect()
}

/// `npm ci` empties node_modules under the running service, so when the lockfile changed the wait
/// for running turns moves before the build (which installs first): from the install on, the
/// service should go down as soon as possible.
pub fn order(install_deps: bool) -> [Step; 6] {
    use Step::*;
    if install_deps {
        [Fetch, Checkout, WaitTurns, Build, Swap, Verify]
    } else {
        [Fetch, Checkout, Build, WaitTurns, Swap, Verify]
    }
}

/// Whether `git worktree list --porcelain` shows `branch` checked out somewhere. Git refuses to check
/// out a branch another worktree holds.
pub fn checked_out(worktrees: &str, branch: &str) -> bool {
    let line = format!("branch refs/heads/{branch}");
    worktrees.lines().any(|l| l == line)
}

/// Where the build's output folder is set, so it lands in `build-next/` and not over the running
/// service's `build/`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BuildOut {
    /// The branch's vite.config.js reads HOOKED_BUILD_OUT: its own `npm run build` does it.
    Env,
    /// An older branch: Vite runs with the launcher's config, which loads the branch's and swaps
    /// the adapter for one writing to HOOKED_BUILD_OUT (`build-out.vite.config.mjs`).
    WrappedConfig,
}

pub fn build_out(vite_config: &str) -> BuildOut {
    if vite_config.contains("HOOKED_BUILD_OUT") {
        BuildOut::Env
    } else {
        BuildOut::WrappedConfig
    }
}

/// What the run has changed so far. Each flag is set just before the change it names, so a change
/// that failed halfway is still undone (every undo is safe to run on an unchanged tree).
#[derive(Clone, Copy, Default, Debug)]
pub struct Changes {
    pub checkout: bool,
    pub deps: bool,
    pub build_next: bool,
    /// `build/` → `build-prev/`.
    pub old_build_moved: bool,
    /// `build-next/` → `build/`.
    pub new_build_moved: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Undo {
    RemoveBuildNext,
    DiscardNewBuild,
    RestorePrevBuild,
    RestoreCheckout,
    /// After `RestoreCheckout`: the lockfile is the old one again.
    ReinstallDeps,
    RestartService,
}

/// The undo steps for a failed run, in order. The checkout must not be left on the new branch:
/// deploy/service-run.sh rebuilds at boot whenever HEAD differs from the build's commit stamp.
pub fn undo_plan(c: Changes) -> Vec<Undo> {
    let mut plan = Vec::new();
    if c.new_build_moved {
        plan.push(Undo::DiscardNewBuild);
    } else if c.build_next {
        plan.push(Undo::RemoveBuildNext);
    }
    if c.old_build_moved {
        plan.push(Undo::RestorePrevBuild);
    }
    if c.checkout {
        plan.push(Undo::RestoreCheckout);
    }
    if c.deps {
        plan.push(Undo::ReinstallDeps);
    }
    if c.old_build_moved || c.new_build_moved {
        plan.push(Undo::RestartService);
    }
    plan
}

/// What the extension flow has changed under `$HOOKED_EXTENSIONS_DIR`. Same rule as `Changes`: each
/// flag is set just before its change.
#[derive(Clone, Copy, Default, Debug)]
pub struct ExtChanges {
    /// `<id>.next` written.
    pub staged: bool,
    /// `<id>` → `<id>.prev`.
    pub old_moved: bool,
    /// `<id>.next` → `<id>`.
    pub new_moved: bool,
    /// The service was asked to load the new folder.
    pub reloaded: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExtUndo {
    RemoveNext,
    DiscardNew,
    RestorePrev,
    /// Last: the service loads the previous folder again (or drops the extension it never had).
    Reload,
}

/// Data and settings files (`extension-data/`, `extension-settings/`) are never in it: they live
/// outside the extension's folder.
pub fn ext_undo_plan(c: ExtChanges) -> Vec<ExtUndo> {
    let mut plan = Vec::new();
    if c.new_moved {
        plan.push(ExtUndo::DiscardNew);
    } else if c.staged {
        plan.push(ExtUndo::RemoveNext);
    }
    if c.old_moved {
        plan.push(ExtUndo::RestorePrev);
    }
    if c.reloaded {
        plan.push(ExtUndo::Reload);
    }
    plan
}

/// The service's rule for an id (`EXTENSION_ID` in src/lib/extensions.js): it is also a folder name
/// under `$HOOKED_EXTENSIONS_DIR`, so nothing else may reach the file system.
pub fn valid_extension_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && (2..=32).contains(&id.len())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The Fetch checks on a cloned manifest; returns its id. `expected`: the id a catalog entry or an
/// update targets. `bundled`: whether the checkout ships an extension with that id, which would win
/// over the installed one and leave it rejected.
pub fn check_manifest(
    m: &serde_json::Value,
    expected: Option<&str>,
    api: u64,
    bundled: impl Fn(&str) -> bool,
) -> Result<String, String> {
    let id = m["id"].as_str().ok_or("extension.json has no id")?;
    if !valid_extension_id(id) {
        return Err(format!("invalid id \"{id}\""));
    }
    if let Some(want) = expected.filter(|w| *w != id) {
        return Err(format!("the manifest's id is \"{id}\", expected \"{want}\""));
    }
    if m["api"].as_u64() != Some(api) {
        return Err(format!("api {}, hooked offers {api}", m["api"]));
    }
    if bundled(id) {
        return Err(format!("hooked already ships an extension \"{id}\""));
    }
    Ok(id.to_string())
}

/// Whether `GET /api/extensions` shows the flow's result: the installed extension loaded with no
/// error (active, unless off or unavailable), or gone after an uninstall.
pub fn verify_listing(v: &serde_json::Value, id: &str, present: bool) -> Result<(), String> {
    let installed = v["extensions"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|e| e["id"] == id && e["source"] == "installed");
    let rejected = v["rejected"].as_array().into_iter().flatten().find(|r| r["id"] == id && r["source"] == "installed");
    match (present, installed) {
        (false, None) => Ok(()),
        (false, Some(_)) => Err(format!("hooked still runs {id}")),
        (true, None) => Err(match rejected {
            Some(r) => format!("hooked rejected {id}: {}", r["error"].as_str().unwrap_or("no reason given")),
            None => format!("hooked did not load {id}"),
        }),
        (true, Some(e)) => {
            let errors: Vec<&str> = e["errors"].as_array().into_iter().flatten().filter_map(|x| x.as_str()).collect();
            if !errors.is_empty() {
                return Err(errors.join("; "));
            }
            if e["enabled"] == true && e["available"] != false && e["active"] != true {
                return Err(format!("{id} is on but did not start"));
            }
            Ok(())
        }
    }
}

/// After a branch switch: the extensions the new branch's service refuses, to flag them (nothing is
/// undone for them).
pub fn rejected_notes(v: &serde_json::Value) -> Vec<String> {
    v["rejected"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| format!("Extension {} rejected: {}", r["id"].as_str().unwrap_or("?"), r["error"].as_str().unwrap_or("?")))
        .collect()
}

/// Sessions of `/api/sessions` whose turn is running in the service: a driven session (`live`)
/// whose state is `working`. A session waiting on a question does not count: its turn is blocked
/// on you, and the resume after the restart sends it "Continue".
pub fn busy_sessions(list: &serde_json::Value) -> usize {
    list["sessions"].as_array().map_or(0, |sessions| {
        sessions
            .iter()
            .filter(|s| s["live"] == true && s["state"] == "working")
            .count()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn waits_after_the_build_when_the_lockfile_is_unchanged() {
        assert_eq!(
            order(false),
            [Step::Fetch, Step::Checkout, Step::Build, Step::WaitTurns, Step::Swap, Step::Verify]
        );
    }

    #[test]
    fn waits_before_installing_when_the_lockfile_changed() {
        let steps = order(true);
        let at = |s| steps.iter().position(|x| *x == s).unwrap();
        assert!(at(Step::WaitTurns) < at(Step::Build));
        assert_eq!(at(Step::Build) + 1, at(Step::Swap));
    }

    #[test]
    fn a_branch_that_reads_the_env_builds_with_its_own_script() {
        let config = "adapter({ out: process.env.HOOKED_BUILD_OUT || 'build' })";
        assert_eq!(build_out(config), BuildOut::Env);
    }

    #[test]
    fn an_older_branch_builds_through_the_wrapped_config() {
        assert_eq!(build_out("sveltekit({ adapter: adapter() })"), BuildOut::WrappedConfig);
        // No vite.config.js at all: the wrapper fails on its own, before writing anything.
        assert_eq!(build_out(""), BuildOut::WrappedConfig);
    }

    #[test]
    fn finds_a_branch_held_by_a_worktree() {
        let list = "worktree /repo\nHEAD 1\nbranch refs/heads/main\n\n\
                    worktree /wt/x\nHEAD 2\nbranch refs/heads/feat/x\n\n\
                    worktree /wt/y\nHEAD 3\ndetached\n";
        assert!(checked_out(list, "feat/x"));
        assert!(!checked_out(list, "feat"));
        assert!(!checked_out(list, "feat/y"));
    }

    #[test]
    fn a_failed_fetch_undoes_nothing() {
        assert!(undo_plan(Changes::default()).is_empty());
    }

    #[test]
    fn a_failed_checkout_restores_the_checkout() {
        let c = Changes { checkout: true, ..Changes::default() };
        assert_eq!(undo_plan(c), [Undo::RestoreCheckout]);
    }

    #[test]
    fn a_failed_build_keeps_the_service_running() {
        let c = Changes { checkout: true, build_next: true, ..Changes::default() };
        assert_eq!(undo_plan(c), [Undo::RemoveBuildNext, Undo::RestoreCheckout]);
    }

    #[test]
    fn a_failed_build_after_an_install_reinstalls_the_old_lockfile() {
        let c = Changes { checkout: true, deps: true, build_next: true, ..Changes::default() };
        assert_eq!(
            undo_plan(c),
            [Undo::RemoveBuildNext, Undo::RestoreCheckout, Undo::ReinstallDeps]
        );
    }

    #[test]
    fn a_failed_verify_puts_the_old_build_back_and_restarts() {
        let c = Changes {
            checkout: true,
            deps: true,
            build_next: true,
            old_build_moved: true,
            new_build_moved: true,
        };
        assert_eq!(
            undo_plan(c),
            [
                Undo::DiscardNewBuild,
                Undo::RestorePrevBuild,
                Undo::RestoreCheckout,
                Undo::ReinstallDeps,
                Undo::RestartService,
            ]
        );
    }

    #[test]
    fn a_swap_cut_halfway_still_restores_the_old_build() {
        let c = Changes { checkout: true, build_next: true, old_build_moved: true, ..Changes::default() };
        assert_eq!(
            undo_plan(c),
            [
                Undo::RemoveBuildNext,
                Undo::RestorePrevBuild,
                Undo::RestoreCheckout,
                Undo::RestartService,
            ]
        );
    }

    #[test]
    fn an_uninstall_has_no_fetch() {
        assert_eq!(extension_order(false), [Step::Fetch, Step::Place, Step::Reload, Step::Verify]);
        assert_eq!(extension_order(true), [Step::Place, Step::Reload, Step::Verify]);
    }

    #[test]
    fn a_failed_fetch_removes_only_what_it_staged() {
        assert!(ext_undo_plan(ExtChanges::default()).is_empty());
        let c = ExtChanges { staged: true, ..ExtChanges::default() };
        assert_eq!(ext_undo_plan(c), [ExtUndo::RemoveNext]);
    }

    #[test]
    fn a_place_cut_halfway_puts_the_old_folder_back_without_a_reload() {
        let c = ExtChanges { staged: true, old_moved: true, ..ExtChanges::default() };
        assert_eq!(ext_undo_plan(c), [ExtUndo::RemoveNext, ExtUndo::RestorePrev]);
    }

    #[test]
    fn a_failed_verify_puts_the_old_folder_back_and_reloads_it() {
        let c = ExtChanges { staged: true, old_moved: true, new_moved: true, reloaded: true };
        assert_eq!(ext_undo_plan(c), [ExtUndo::DiscardNew, ExtUndo::RestorePrev, ExtUndo::Reload]);
    }

    #[test]
    fn a_failed_uninstall_puts_the_folder_back_and_reloads_it() {
        let c = ExtChanges { old_moved: true, reloaded: true, ..ExtChanges::default() };
        assert_eq!(ext_undo_plan(c), [ExtUndo::RestorePrev, ExtUndo::Reload]);
    }

    #[test]
    fn extension_ids_follow_the_service_rule() {
        assert!(valid_extension_id("hello"));
        assert!(valid_extension_id("a1-b"));
        for bad in ["", "a", "Hello", "1abc", "../x", "a/b", "hello.next", &"a".repeat(33)] {
            assert!(!valid_extension_id(bad), "{bad}");
        }
    }

    #[test]
    fn checks_a_cloned_manifest() {
        let hello = json!({ "id": "hello", "api": 1 });
        let none = |_: &str| false;
        assert_eq!(check_manifest(&hello, Some("hello"), 1, none), Ok("hello".into()));
        assert_eq!(check_manifest(&hello, None, 1, none), Ok("hello".into()));
        assert!(check_manifest(&hello, Some("other"), 1, none).unwrap_err().contains("expected \"other\""));
        assert_eq!(check_manifest(&hello, None, 2, none), Err("api 1, hooked offers 2".into()));
        assert!(check_manifest(&hello, None, 1, |id| id == "hello").unwrap_err().contains("already ships"));
        assert!(check_manifest(&json!({ "id": "../x", "api": 1 }), None, 1, none).is_err());
        assert!(check_manifest(&json!({ "api": 1 }), None, 1, none).is_err());
    }

    #[test]
    fn verifies_an_install_against_the_listing() {
        let listing = |e: serde_json::Value| json!({ "extensions": [e], "rejected": [] });
        let ok = json!({ "id": "hello", "source": "installed", "enabled": true, "available": true, "active": true, "errors": [] });
        assert_eq!(verify_listing(&listing(ok.clone()), "hello", true), Ok(()));
        let off = json!({ "id": "hello", "source": "installed", "enabled": false, "active": false, "errors": [] });
        assert_eq!(verify_listing(&listing(off), "hello", true), Ok(()));
        let broken = json!({ "id": "hello", "source": "installed", "enabled": true, "active": false, "errors": ["start: boom"] });
        assert_eq!(verify_listing(&listing(broken), "hello", true), Err("start: boom".into()));
        let idle = json!({ "id": "hello", "source": "installed", "enabled": true, "available": true, "active": false, "errors": [] });
        assert!(verify_listing(&listing(idle), "hello", true).is_err());
        let rejected = json!({ "extensions": [], "rejected": [{ "id": "hello", "source": "installed", "error": "api 2, hooked offers 1" }] });
        assert_eq!(verify_listing(&rejected, "hello", true), Err("hooked rejected hello: api 2, hooked offers 1".into()));
        assert_eq!(verify_listing(&json!({}), "hello", true), Err("hooked did not load hello".into()));
    }

    #[test]
    fn verifies_an_uninstall_against_the_listing() {
        let bundled = json!({ "extensions": [{ "id": "hello", "source": "bundled" }] });
        assert_eq!(verify_listing(&bundled, "hello", false), Ok(()));
        let installed = json!({ "extensions": [{ "id": "hello", "source": "installed" }] });
        assert!(verify_listing(&installed, "hello", false).is_err());
    }

    #[test]
    fn notes_the_extensions_a_branch_rejects() {
        let v = json!({ "rejected": [{ "id": "cron", "error": "api 2, hooked offers 1" }] });
        assert_eq!(rejected_notes(&v), ["Extension cron rejected: api 2, hooked offers 1"]);
        assert!(rejected_notes(&json!({})).is_empty());
    }

    #[test]
    fn counts_only_driven_sessions_mid_turn() {
        let list = json!({ "sessions": [
            { "live": true, "state": "working" },
            { "live": true, "state": "waiting" },
            { "live": true, "state": "attention" },
            { "live": false, "state": "working" },
        ]});
        assert_eq!(busy_sessions(&list), 1);
        assert_eq!(busy_sessions(&json!({})), 0);
    }
}
