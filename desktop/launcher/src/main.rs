//! hooked-launcher: lists hooked's branches, builds one beside the running service and switches
//! the service to it. A separate app so a restart of hooked does not take it down.

mod branches;
mod flow;
mod runner;
mod sys;
mod view;

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use hooked_ui::logo;
use hooked_ui::theme::{Look, PREFS_ID, Theme};
use hooked_ui::widgets;
use rune::prefs::Prefs;
use rune::{AppHandle, AppSpec, Image, ImageCache, Tx};

use crate::branches::Row;
use crate::flow::Step;
use crate::runner::{Control, Event};

static HANDLE: OnceLock<AppHandle<State>> = OnceLock::new();

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Pending,
    Running,
    Done,
    Failed,
}

#[derive(Debug, PartialEq)]
pub enum Rollback {
    Running,
    /// Ok: the checkout and the service are as they were. Err: what is left to fix by hand.
    Done(Result<(), String>),
    /// The run failed before changing anything.
    NotNeeded,
}

pub struct Failure {
    pub step: Step,
    pub error: String,
    pub log: String,
    pub rollback: Rollback,
    pub undo_log: String,
}

pub struct AppFailure {
    pub error: String,
    pub log: String,
}

pub struct Run {
    pub branch: String,
    pub steps: Vec<(Step, Status)>,
    /// Sessions mid-turn, while waiting for them.
    pub busy: Option<usize>,
    pub failure: Option<Failure>,
    /// The desktop app was not updated. Not a `failure`: the service runs the branch.
    pub app_failure: Option<AppFailure>,
    pub switched: bool,
    pub control: Arc<Control>,
}

fn plan(order: [Step; 6], app: bool) -> Vec<(Step, Status)> {
    order.into_iter().chain(app.then_some(Step::UpdateApp)).map(|s| (s, Status::Pending)).collect()
}

impl Run {
    fn new(branch: String, app: bool, control: Arc<Control>) -> Self {
        Run {
            branch,
            steps: plan(flow::order(false), app),
            busy: None,
            failure: None,
            app_failure: None,
            switched: false,
            control,
        }
    }

    pub fn finished(&self) -> bool {
        self.switched || self.failure.as_ref().is_some_and(|f| f.rollback != Rollback::Running)
    }

    /// The service runs the branch, while the desktop app may still be updating.
    pub fn verified(&self) -> bool {
        self.status(Step::Verify) == Some(Status::Done)
    }

    fn status(&self, step: Step) -> Option<Status> {
        self.steps.iter().find(|(s, _)| *s == step).map(|x| x.1)
    }

    fn apply(&mut self, ev: Event) {
        match ev {
            Event::Order(order) => {
                let app = self.status(Step::UpdateApp).is_some();
                let steps = plan(order, app)
                    .into_iter()
                    .map(|(s, pending)| (s, self.status(s).unwrap_or(pending)))
                    .collect();
                self.steps = steps;
            }
            Event::Start(step) => self.set(step, Status::Running),
            Event::Done(step) => {
                self.set(step, Status::Done);
                if step == Step::WaitTurns {
                    self.busy = None;
                }
            }
            Event::Busy(n) => self.busy = Some(n),
            Event::Failed { step, error, log, rollback } => {
                self.set(step, Status::Failed);
                self.busy = None;
                let rollback = if rollback { Rollback::Running } else { Rollback::NotNeeded };
                self.failure = Some(Failure { step, error, log, rollback, undo_log: String::new() });
            }
            Event::Undone(result, undo_log) => {
                if let Some(f) = self.failure.as_mut() {
                    f.rollback = Rollback::Done(result);
                    f.undo_log = undo_log;
                }
            }
            Event::AppFailed { error, log } => {
                self.set(Step::UpdateApp, Status::Failed);
                self.app_failure = Some(AppFailure { error, log });
            }
            Event::Switched => self.switched = true,
        }
    }

    fn set(&mut self, step: Step, status: Status) {
        if let Some(s) = self.steps.iter_mut().find(|(s, _)| *s == step) {
            s.1 = status;
        }
    }
}

pub struct State {
    pub repo: PathBuf,
    pub rows: Vec<Row>,
    pub loading: bool,
    pub list_error: Option<String>,
    pub stale: Option<String>,
    pub reachable: Option<bool>,
    pub run: Option<Run>,
    /// The desktop app's appearance setting; its scheme and corners live in `hooked_ui::theme`.
    pub theme: Theme,
    pub logo: Option<[Image; 2]>,
    images: Option<ImageCache>,
    minute: i64,
}

impl State {
    fn new() -> Self {
        State {
            repo: sys::repo(),
            rows: Vec::new(),
            loading: false,
            list_error: None,
            stale: None,
            reachable: None,
            run: None,
            theme: Theme::System,
            logo: None,
            images: None,
            minute: 0,
        }
    }

    /// Wears the desktop app's look, read again on each refresh so a change made there shows here.
    fn load_look(&mut self) {
        self.theme = Look::load(&Prefs::open(PREFS_ID)).theme;
        if let Some(cache) = &self.images {
            // The launcher tracks no session: the wheel's plain ring.
            self.logo = Some(logo::render(cache, [0; 6]));
        }
    }

    pub fn refresh(&mut self) {
        if self.loading {
            return;
        }
        self.load_look();
        self.loading = true;
        let repo = self.repo.clone();
        background(move || {
            let r = runner::list(&repo);
            update(move |s| {
                s.loading = false;
                match r {
                    Ok(listing) => {
                        s.rows = listing.rows;
                        s.stale = listing.stale;
                        s.list_error = None;
                    }
                    Err(e) => s.list_error = Some(e),
                }
            });
        });
    }

    pub fn start(&mut self, branch: String) {
        if self.run.as_ref().is_some_and(|r| !r.finished()) {
            return;
        }
        let control = Arc::new(Control::default());
        // Read once: the run's step list and the runner agree on it until the end.
        let app = sys::desktop_app_installed();
        self.run = Some(Run::new(branch.clone(), app, control.clone()));
        let repo = self.repo.clone();
        background(move || {
            runner::switch(&repo, &branch, app, &control, &|ev| update(move |s| s.apply(ev)));
        });
    }

    fn apply(&mut self, ev: Event) {
        let Some(run) = self.run.as_mut() else { return };
        run.apply(ev);
        if run.finished() {
            self.refresh();
        }
    }

    pub fn close_run(&mut self) {
        if self.run.as_ref().is_some_and(Run::finished) {
            self.run = None;
        }
    }
}

fn background(work: impl FnOnce() + Send + 'static) {
    let _ = std::thread::Builder::new().name("launcher-task".into()).spawn(work);
}

fn update(f: impl FnOnce(&mut State) + Send + 'static) {
    if let Some(h) = HANDLE.get() {
        h.update(move |s, _| f(s));
    }
}

/// The service dot: polled every few seconds, an update only when it changes.
fn watch_service() {
    background(|| {
        let mut last = None;
        loop {
            let up = sys::get_json("/api/capabilities", Duration::from_secs(3)).is_ok();
            if last != Some(up) {
                last = Some(up);
                update(move |s| s.reachable = Some(up));
            }
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

fn setup(s: &mut State, waker: rune::Waker) {
    s.images = Some(ImageCache::new(waker));
    s.refresh();
    watch_service();
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// Relative dates ("3 min ago") age without any event: redraw once a minute.
fn poll(s: &mut State, _: f64, tx: &mut Tx) -> bool {
    tx.wake_after(Duration::from_secs(60));
    let minute = now() / 60;
    let changed = minute != s.minute;
    s.minute = minute;
    changed
}

fn main() {
    let spec = AppSpec {
        setup: Some(setup),
        poll: Some(poll),
        min_size: Some((520.0, 360.0)),
        families: widgets::FAMILIES,
        ..AppSpec::new("hooked launcher", (640.0, 600.0), State::new, view::view)
    };
    let app = rune::App::new(spec).standard_menus().chrome(widgets::chrome());
    let _ = HANDLE.set(app.handle());
    app.run();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_with_app() -> Run {
        Run::new("feat/x".into(), true, Arc::new(Control::default()))
    }

    #[test]
    fn an_app_failure_finishes_the_run_without_failing_the_switch() {
        let mut run = run_with_app();
        for step in flow::order(false) {
            run.apply(Event::Start(step));
            run.apply(Event::Done(step));
        }
        assert!(run.verified());
        run.apply(Event::Start(Step::UpdateApp));
        assert!(!run.finished());
        run.apply(Event::AppFailed { error: "cargo failed".into(), log: "error[E0308]".into() });
        run.apply(Event::Switched);
        assert!(run.finished());
        assert!(run.failure.is_none());
        assert_eq!(run.app_failure.as_ref().map(|f| f.error.as_str()), Some("cargo failed"));
        assert_eq!(run.status(Step::UpdateApp), Some(Status::Failed));
    }

    #[test]
    fn a_new_order_keeps_the_app_step_last() {
        let mut run = run_with_app();
        run.apply(Event::Done(Step::Fetch));
        run.apply(Event::Order(flow::order(true)));
        assert_eq!(run.steps.last(), Some(&(Step::UpdateApp, Status::Pending)));
        assert_eq!(run.steps.len(), 7);
        assert_eq!(run.status(Step::Fetch), Some(Status::Done));
    }

    /// Drives a run with the events `runner::switch` reports.
    fn switch_in(repo: &std::path::Path) -> Run {
        let control = Arc::new(Control::default());
        let run = std::cell::RefCell::new(Run::new("feat/x".into(), false, control.clone()));
        runner::switch(repo, "feat/x", false, &control, &|ev| run.borrow_mut().apply(ev));
        run.into_inner()
    }

    #[test]
    fn a_failure_before_any_change_finishes_the_run_with_nothing_rolled_back() {
        // Not a git checkout: reading where the checkout stands fails before the first step.
        let dir = std::env::temp_dir().join(format!("hooked-launcher-no-repo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let run = switch_in(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(run.finished());
        let f = run.failure.as_ref().expect("the run failed");
        assert_eq!(f.step, Step::Fetch);
        assert_eq!(f.rollback, Rollback::NotNeeded);
        assert_eq!(run.status(Step::Fetch), Some(Status::Failed));
    }

    #[test]
    fn a_failed_fetch_finishes_the_run_with_nothing_rolled_back() {
        // A checkout with one commit and no `origin`: the fetch fails, before any change.
        let dir = std::env::temp_dir().join(format!("hooked-launcher-no-origin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
                .args(args)
                .current_dir(&dir)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?}");
        };
        git(&["init", "-q"]);
        git(&["commit", "-q", "--allow-empty", "-m", "start"]);
        let run = switch_in(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(run.finished());
        let f = run.failure.as_ref().expect("the run failed");
        assert_eq!(f.step, Step::Fetch);
        assert_eq!(f.rollback, Rollback::NotNeeded);
    }

    #[test]
    fn a_failure_with_changes_waits_for_the_rollback() {
        let mut run = run_with_app();
        run.apply(Event::Start(Step::Fetch));
        run.apply(Event::Done(Step::Fetch));
        run.apply(Event::Start(Step::Checkout));
        run.apply(Event::Failed { step: Step::Checkout, error: "conflict".into(), log: String::new(), rollback: true });
        assert!(!run.finished());
        assert_eq!(run.failure.as_ref().map(|f| &f.rollback), Some(&Rollback::Running));
        run.apply(Event::Undone(Ok(()), "git checkout main\n".into()));
        assert!(run.finished());
        assert_eq!(run.failure.as_ref().map(|f| &f.rollback), Some(&Rollback::Done(Ok(()))));
    }

    #[test]
    fn a_failure_with_nothing_to_undo_finishes_at_once() {
        let mut run = run_with_app();
        run.apply(Event::Start(Step::Fetch));
        run.apply(Event::Failed { step: Step::Fetch, error: "offline".into(), log: String::new(), rollback: false });
        assert!(run.finished());
        assert_eq!(run.failure.as_ref().map(|f| &f.rollback), Some(&Rollback::NotNeeded));
    }

    #[test]
    fn no_app_step_when_the_app_is_not_installed() {
        let mut run = Run::new("feat/x".into(), false, Arc::new(Control::default()));
        run.apply(Event::Order(flow::order(true)));
        assert_eq!(run.status(Step::UpdateApp), None);
    }
}
