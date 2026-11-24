//! The switch as pure decisions: which steps run in which order, and what a failure has to undo.
//! `runner.rs` performs them.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Step {
    Fetch,
    Checkout,
    Build,
    WaitTurns,
    Swap,
    Verify,
}

impl Step {
    pub fn label(self) -> &'static str {
        match self {
            Step::Fetch => "Fetch",
            Step::Checkout => "Switch branch",
            Step::Build => "Build",
            Step::WaitTurns => "Wait for turns",
            Step::Swap => "Swap and restart",
            Step::Verify => "Verify",
        }
    }
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
