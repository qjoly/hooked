//! hooked-launcher: lists hooked's branches, builds one beside the running service and switches
//! the service to it; installs, updates and removes extensions. A separate app so a restart of
//! hooked does not take it down.

mod branches;
mod catalog;
mod extensions;
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
use rune::{AppHandle, AppSpec, Image, ImageCache, TextEdit, Tx};

use crate::branches::Row;
use crate::catalog::Entry;
use crate::extensions::{Ext, Source};
use crate::flow::Step;
use crate::runner::{Control, Event, ExtChange};

static HANDLE: OnceLock<AppHandle<State>> = OnceLock::new();

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Pending,
    Running,
    Done,
    Failed,
}

pub struct Failure {
    pub step: Step,
    pub error: String,
    pub log: String,
    /// None while the rollback runs.
    pub undone: Option<Result<(), String>>,
    pub undo_log: String,
}

pub struct AppFailure {
    pub error: String,
    pub log: String,
}

/// What a run does, for its wording.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Switch,
    Install,
    Update,
    Uninstall,
}

pub struct Run {
    pub kind: Kind,
    /// The branch, or the extension (its id, or the git URL until the fetch reads the id).
    pub name: String,
    pub steps: Vec<(Step, Status)>,
    /// Sessions mid-turn, while waiting for them.
    pub busy: Option<usize>,
    pub failure: Option<Failure>,
    /// The desktop app was not updated. Not a `failure`: the service runs the branch.
    pub app_failure: Option<AppFailure>,
    pub switched: bool,
    /// The extension flow waits for the user to accept this text.
    pub confirm: Option<String>,
    /// Declined at the confirmation.
    pub cancelled: bool,
    pub notes: Vec<String>,
    pub control: Arc<Control>,
}

fn plan(order: [Step; 6], app: bool) -> Vec<(Step, Status)> {
    order.into_iter().chain(app.then_some(Step::UpdateApp)).map(|s| (s, Status::Pending)).collect()
}

impl Run {
    fn new(branch: String, app: bool, control: Arc<Control>) -> Self {
        Self::with_steps(Kind::Switch, branch, plan(flow::order(false), app), control)
    }

    /// The desktop app step is not planned: it joins only for a Rust desktop page, which the fetch
    /// tells.
    fn extension(kind: Kind, name: String, control: Arc<Control>) -> Self {
        let steps = flow::extension_order(kind == Kind::Uninstall).into_iter().map(|s| (s, Status::Pending)).collect();
        Self::with_steps(kind, name, steps, control)
    }

    fn with_steps(kind: Kind, name: String, steps: Vec<(Step, Status)>, control: Arc<Control>) -> Self {
        Run {
            kind,
            name,
            steps,
            busy: None,
            failure: None,
            app_failure: None,
            switched: false,
            confirm: None,
            cancelled: false,
            notes: Vec::new(),
            control,
        }
    }

    pub fn finished(&self) -> bool {
        self.switched || self.cancelled || self.failure.as_ref().is_some_and(|f| f.undone.is_some())
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
            Event::Start(step) => {
                if self.status(step).is_none() {
                    self.steps.push((step, Status::Pending));
                }
                self.confirm = None;
                self.set(step, Status::Running)
            }
            Event::Done(step) => {
                self.set(step, Status::Done);
                if step == Step::WaitTurns {
                    self.busy = None;
                }
            }
            Event::Busy(n) => self.busy = Some(n),
            Event::Failed { step, error, log } => {
                self.set(step, Status::Failed);
                self.busy = None;
                self.failure = Some(Failure { step, error, log, undone: None, undo_log: String::new() });
            }
            Event::Undone(result, undo_log) => {
                if let Some(f) = self.failure.as_mut() {
                    f.undone = Some(result);
                    f.undo_log = undo_log;
                }
            }
            Event::AppFailed { error, log } => {
                self.set(Step::UpdateApp, Status::Failed);
                self.app_failure = Some(AppFailure { error, log });
            }
            Event::Switched => self.switched = true,
            Event::Confirm { id, text } => {
                self.name = id;
                self.confirm = Some(text);
            }
            Event::Cancelled => {
                self.confirm = None;
                self.cancelled = true;
            }
            Event::Note(note) => self.notes.push(note),
        }
    }

    fn set(&mut self, step: Step, status: Status) {
        if let Some(s) = self.steps.iter_mut().find(|(s, _)| *s == step) {
            s.1 = status;
        }
    }
}

/// "Add from git…": where to fetch an extension from.
pub struct GitForm {
    pub repo: TextEdit,
    pub r#ref: TextEdit,
    pub path: TextEdit,
}

impl Default for GitForm {
    fn default() -> Self {
        GitForm { repo: TextEdit::new(""), r#ref: TextEdit::new("main"), path: TextEdit::new(".") }
    }
}

impl GitForm {
    /// Blank fields fall back to the defaults; None without a URL.
    pub fn source(&self) -> Option<Source> {
        let or = |t: &TextEdit, default: &str| Some(t.text.trim()).filter(|v| !v.is_empty()).unwrap_or(default).to_string();
        let repo = self.repo.text.trim();
        (!repo.is_empty()).then(|| Source { repo: repo.to_string(), r#ref: or(&self.r#ref, "main"), path: or(&self.path, ".") })
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
    pub exts: Vec<Ext>,
    /// The extensions came from the service, so their switches work.
    pub exts_live: bool,
    /// The extension whose switch is being applied.
    pub ext_busy: Option<String>,
    pub ext_error: Option<String>,
    /// The extension contract hooked offers, to flag incompatible catalog entries.
    pub ext_api: Option<u64>,
    /// "Add from catalog…": None while closed, then loading (`Some(None)`) or loaded.
    pub catalog: Option<Option<Result<Vec<Entry>, String>>>,
    /// "Add from git…": the form, while open.
    pub git_form: Option<GitForm>,
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
            exts: Vec::new(),
            exts_live: false,
            ext_busy: None,
            ext_error: None,
            ext_api: None,
            catalog: None,
            git_form: None,
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
        self.refresh_extensions();
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

    pub fn refresh_extensions(&mut self) {
        let repo = self.repo.clone();
        background(move || {
            let listing = extensions::list(&repo);
            update(move |s| {
                s.exts = listing.exts;
                s.exts_live = listing.live;
                s.ext_api = listing.api;
            });
        });
    }

    pub fn set_extension(&mut self, id: String, enabled: bool) {
        if self.ext_busy.is_some() || !self.exts_live {
            return;
        }
        self.ext_busy = Some(id.clone());
        self.ext_error = None;
        background(move || {
            let r = extensions::set_enabled(&id, enabled);
            update(move |s| {
                s.ext_busy = None;
                match r {
                    Ok(exts) => s.exts = exts,
                    Err(e) => {
                        s.ext_error = Some(format!("Could not switch {id}: {e}"));
                        s.refresh_extensions();
                    }
                }
            });
        });
    }

    pub fn toggle_catalog(&mut self) {
        if self.catalog.take().is_some() {
            return;
        }
        self.catalog = Some(None);
        let repo = self.repo.clone();
        background(move || {
            let r = catalog::load(&repo);
            update(move |s| {
                if s.catalog.is_some() {
                    s.catalog = Some(Some(r));
                }
            });
        });
    }

    pub fn toggle_git_form(&mut self) {
        self.git_form = match self.git_form {
            Some(_) => None,
            None => Some(GitForm::default()),
        };
    }

    pub fn install_from_git(&mut self) {
        let Some(source) = self.git_form.as_ref().and_then(GitForm::source) else { return };
        let name = source.repo.clone();
        self.start_extension(Kind::Install, name, ExtChange::Install { source, id: None });
    }

    pub fn install(&mut self, entry: &Entry) {
        let kind = if self.installed(&entry.id) { Kind::Update } else { Kind::Install };
        let change = ExtChange::Install { source: entry.source.clone(), id: Some(entry.id.clone()) };
        self.start_extension(kind, entry.id.clone(), change);
    }

    /// Fetches the source recorded at install time again; the confirmation shows the new commit.
    pub fn update_extension(&mut self, ext: &Ext) {
        let Some(source) = ext.from.clone() else { return };
        self.start_extension(Kind::Update, ext.id.clone(), ExtChange::Install { source, id: Some(ext.id.clone()) });
    }

    pub fn uninstall(&mut self, id: String) {
        self.start_extension(Kind::Uninstall, id.clone(), ExtChange::Uninstall(id));
    }

    pub fn installed(&self, id: &str) -> bool {
        self.exts.iter().any(|e| e.id == id && e.source == "installed")
    }

    fn start_extension(&mut self, kind: Kind, name: String, change: ExtChange) {
        if self.run.as_ref().is_some_and(|r| !r.finished()) {
            return;
        }
        let control = Arc::new(Control::default());
        let app = sys::desktop_app_installed();
        self.run = Some(Run::extension(kind, name, control.clone()));
        self.catalog = None;
        self.git_form = None;
        let repo = self.repo.clone();
        background(move || {
            let root = extensions::installed_root();
            let report = |ev| update(move |s: &mut State| s.apply(ev));
            runner::apply_extension(&repo, &root, &change, app, &control, &extensions::Http, &report);
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
                // The service came back or went away: the extension list changes source.
                update(move |s| {
                    s.reachable = Some(up);
                    s.refresh_extensions();
                });
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

    #[test]
    fn an_extension_run_takes_its_name_at_the_confirmation_and_ends_when_declined() {
        let mut run = Run::extension(Kind::Install, "https://x/h.git".into(), Arc::new(Control::default()));
        run.apply(Event::Done(Step::Fetch));
        run.apply(Event::Confirm { id: "hello".into(), text: "Source: x@abc".into() });
        assert_eq!((run.name.as_str(), run.confirm.as_deref()), ("hello", Some("Source: x@abc")));
        assert!(!run.finished());
        run.apply(Event::Cancelled);
        assert!(run.finished() && run.confirm.is_none());
        assert!(!run.verified());
    }

    #[test]
    fn the_app_step_joins_an_extension_run_when_it_starts() {
        let mut run = Run::extension(Kind::Update, "hello".into(), Arc::new(Control::default()));
        assert_eq!(run.status(Step::UpdateApp), None);
        run.apply(Event::Confirm { id: "hello".into(), text: String::new() });
        run.apply(Event::Start(Step::Place));
        assert!(run.confirm.is_none());
        run.apply(Event::Start(Step::UpdateApp));
        assert_eq!(run.steps.last(), Some(&(Step::UpdateApp, Status::Running)));
    }

    #[test]
    fn an_uninstall_run_has_no_fetch() {
        let run = Run::extension(Kind::Uninstall, "hello".into(), Arc::new(Control::default()));
        assert_eq!(run.status(Step::Fetch), None);
        assert_eq!(run.steps.len(), 3);
    }

    #[test]
    fn the_git_form_falls_back_to_the_defaults() {
        let mut form = GitForm::default();
        assert_eq!(form.source(), None);
        form.repo = TextEdit::new(" https://x/h.git ");
        form.r#ref = TextEdit::new("");
        form.path = TextEdit::new(" ext/h ");
        assert_eq!(
            form.source(),
            Some(Source { repo: "https://x/h.git".into(), r#ref: "main".into(), path: "ext/h".into() })
        );
    }

    #[test]
    fn no_app_step_when_the_app_is_not_installed() {
        let mut run = Run::new("feat/x".into(), false, Arc::new(Control::default()));
        run.apply(Event::Order(flow::order(true)));
        assert_eq!(run.status(Step::UpdateApp), None);
    }
}
