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

#[derive(Clone, Copy, PartialEq, Eq)]
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

pub struct Run {
    pub branch: String,
    pub steps: Vec<(Step, Status)>,
    /// Sessions mid-turn, while waiting for them.
    pub busy: Option<usize>,
    pub failure: Option<Failure>,
    pub switched: bool,
    pub control: Arc<Control>,
}

impl Run {
    pub fn finished(&self) -> bool {
        self.switched || self.failure.as_ref().is_some_and(|f| f.undone.is_some())
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
        self.run = Some(Run {
            branch: branch.clone(),
            steps: flow::order(false).into_iter().map(|s| (s, Status::Pending)).collect(),
            busy: None,
            failure: None,
            switched: false,
            control: control.clone(),
        });
        let repo = self.repo.clone();
        background(move || {
            runner::switch(&repo, &branch, &control, &|ev| update(move |s| s.apply(ev)));
        });
    }

    fn apply(&mut self, ev: Event) {
        let Some(run) = self.run.as_mut() else { return };
        match ev {
            Event::Order(order) => {
                let status = |step| run.steps.iter().find(|(s, _)| *s == step).map_or(Status::Pending, |x| x.1);
                run.steps = order.into_iter().map(|s| (s, status(s))).collect();
            }
            Event::Start(step) => run.set(step, Status::Running),
            Event::Done(step) => {
                run.set(step, Status::Done);
                if step == Step::WaitTurns {
                    run.busy = None;
                }
            }
            Event::Busy(n) => run.busy = Some(n),
            Event::Failed { step, error, log } => {
                run.set(step, Status::Failed);
                run.busy = None;
                run.failure = Some(Failure { step, error, log, undone: None, undo_log: String::new() });
            }
            Event::Undone(result, undo_log) => {
                if let Some(f) = run.failure.as_mut() {
                    f.undone = Some(result);
                    f.undo_log = undo_log;
                }
            }
            Event::Switched => run.switched = true,
        }
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
