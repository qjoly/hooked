use std::collections::HashSet;
use std::time::{Duration, Instant};

use rune::tok::{Family, TextStyle};
use rune::{App, AppSpec, Chrome, Cx, El, Key, KeyEvent, TextEdit, Tx, WindowOptions, col, el, row, text};
use rune_kit::{Button, ButtonVariant, Kit, TextArea, TextInput};

use crate::spool::{self, Input, Output};

const TITLE: &str = "PR approvals";
const SIZE: (f32, f32) = (480.0, 600.0);
const IDLE_QUIT: Duration = Duration::from_millis(1500);
const SCAN_EVERY: Duration = Duration::from_millis(300);
const PAD: f32 = 14.0;
const GAP: f32 = 6.0;
const HEADER_H: f32 = 28.0;

struct Item {
    id: String,
    input: Input,
    title: TextEdit,
    body: TextEdit,
}

impl Item {
    fn new(id: String, input: Input) -> Item {
        let title = TextEdit::new(input.title.as_deref().unwrap_or(""));
        let body = TextEdit::new(input.body.as_deref().unwrap_or(""));
        Item { id, input, title, body }
    }
}

struct Gate {
    items: Vec<Item>,
    sel: usize,
    empty_since: Option<Instant>,
    scratch: TextEdit,
}

impl Gate {
    fn current_mut(&mut self) -> Option<&mut Item> {
        self.items.get_mut(self.sel)
    }

    fn title_edit(&mut self) -> &mut TextEdit {
        match self.items.get_mut(self.sel) {
            Some(it) => &mut it.title,
            None => &mut self.scratch,
        }
    }

    fn body_edit(&mut self) -> &mut TextEdit {
        match self.items.get_mut(self.sel) {
            Some(it) => &mut it.body,
            None => &mut self.scratch,
        }
    }

    fn step(&mut self, delta: isize) {
        let n = self.items.len() as isize;
        if n > 0 {
            self.sel = (self.sel as isize + delta).rem_euclid(n) as usize;
        }
    }

    fn decide(&mut self, decision: &str, tx: &mut Tx) {
        let Some(it) = self.current_mut() else { return };
        let out = Output { decision: decision.into(), title: it.title.text.clone(), body: it.body.text.clone() };
        spool::answer(&it.id, &out);
        self.items.remove(self.sel);
        self.sel = self.sel.min(self.items.len().saturating_sub(1));
        if self.items.is_empty() {
            self.empty_since = Some(Instant::now());
            tx.wake_after(IDLE_QUIT);
        }
    }

    fn abort_all(&mut self) {
        for it in self.items.drain(..) {
            let out = Output { decision: "aborted".into(), title: it.title.text.clone(), body: it.body.text.clone() };
            spool::answer(&it.id, &out);
        }
    }
}

fn init() -> Gate {
    Gate { items: Vec::new(), sel: 0, empty_since: Some(Instant::now()), scratch: TextEdit::new("") }
}

fn sample(s: &mut Gate) {
    let mk = |n: u32, repo: &str, head: &str| {
        Item::new(
            format!("sample-{n}"),
            Input {
                repo: Some(repo.into()),
                head: Some(head.into()),
                base: Some("main".into()),
                title: Some(format!("feat(charts): bump mimir to 2.17 ({n})")),
                body: Some("- Bump mimir chart to 2.17\n- Drop the ingester PDB override, upstream fixed it\n\nCloses #1234".into()),
                context: Some("worktree ~/Lucca/worktrees/mimir-bump, session 3 of 5 running in parallel".into()),
                workdir: Some("/Users/you/Lucca/worktrees/mimir-bump".into()),
                session: Some("0b5c2f1e-7d1a-4c55-9a7e-1f2d3c4b5a69".into()),
                ..Input::default()
            },
        )
    };
    s.items = vec![mk(1, "LuccaSA/Infra.Charts", "feat/mimir-2.17"), mk(2, "LuccaSA/Platform.Apps.Gitops", "fix/argocd-sync-wave")];
    s.empty_since = None;
}

fn mono(style: TextStyle) -> TextStyle {
    TextStyle { family: Family::SystemMono, ..style }
}

fn meta_line(k: &Kit, label: &str, value: &str) -> El {
    row()
        .gap(8.0)
        .child(text(label.to_owned()).font(k.ty.small_medium).color(k.c.text_faint).w(56.0))
        .child(text(value.to_owned()).font(mono(k.ty.small)).color(k.c.text_muted).truncate().grow(1.0).shrink())
}

fn header(s: &Gate, k: &Kit, lights: f32) -> El {
    let mut bar = row().key("header").window_drag().w_full().h(HEADER_H).pl((lights - PAD + 14.0).max(0.0)).center_y().gap(8.0).child(text(TITLE).font(k.ty.ui_medium).color(k.c.text_base).grow(1.0));
    if s.items.len() > 1 {
        bar = bar
            .child(Button::new("‹").variant(ButtonVariant::Ghost).help("Previous (⌘[)").on_press(|s: &mut Gate| s.step(-1)).build(k))
            .child(text(format!("{} of {}", s.sel + 1, s.items.len())).font(k.ty.small).color(k.c.text_muted))
            .child(Button::new("›").variant(ButtonVariant::Ghost).help("Next (⌘])").on_press(|s: &mut Gate| s.step(1)).build(k));
    }
    bar
}

fn card(it: &Item, k: &Kit) -> El {
    let i = &it.input;
    let mut c = col()
        .w_full()
        .gap(4.0)
        .padding(10.0)
        .radius(k.radius.md)
        .fill(k.c.layer_01)
        .border(1.0, k.c.border_muted)
        .child(text(i.repo.clone().unwrap_or_else(|| "?".into())).font(mono(k.ty.ui_medium)).color(k.c.text_base))
        .child(meta_line(k, "branch", &format!("{}  →  {}", i.head.as_deref().unwrap_or("?"), i.base.as_deref().unwrap_or("main"))));
    if let Some(w) = &i.workdir {
        c = c.child(meta_line(k, "workdir", w));
    }
    if let Some(sess) = &i.session {
        c = c.child(meta_line(k, "session", sess));
    }
    if let Some(ctx) = i.context.as_deref().filter(|c| !c.is_empty()) {
        c = c.child(text(ctx.to_owned()).wrap().w_full().font(k.ty.small).color(k.c.text_base).selectable(true).selection_color(k.selection()).pt(4.0));
    }
    c
}

fn label(k: &Kit, s: &str) -> El {
    text(s.to_owned()).font(k.ty.small_medium).color(k.c.text_faint)
}

fn detail(it: &Item, k: &Kit, cx: &mut Cx<Gate>) -> El {
    let mut mono_kit = k.clone();
    mono_kit.ty.ui = mono(k.ty.ui);
    let window_h = cx.layout_with("gate-root", |r| r[3].round());
    let slot_top = cx.layout_with("desc-slot", |r| r[1].round());
    let actions_h = cx.layout_with("actions", |r| r[3].round());
    let slot = match (window_h, slot_top, actions_h) {
        (Some(h), Some(top), Some(a)) => Some(h - PAD - a - GAP - top),
        _ => None,
    };
    let title = TextInput::new(&it.title)
        .placeholder("PR title")
        .label("PR title")
        .width(None)
        .on_edit(Gate::title_edit)
        .build(k)
        .key(format!("title-{}", it.id));
    let body = TextArea::new(&it.body)
        .placeholder("Description")
        .label("PR description")
        .width(None)
        .rows(if slot.is_some() { 400 } else { 6 })
        .max_height(slot.unwrap_or(400.0).max(80.0))
        .on_edit(Gate::body_edit)
        .on_submit(|s: &mut Gate, tx: &mut Tx| s.decide("open", tx))
        .build(&mono_kit)
        .key(format!("body-{}", it.id));
    let actions = row()
        .key("actions")
        .w_full()
        .gap(8.0)
        .center_y()
        .child(Button::new("Deny").variant(ButtonVariant::Danger).on_press_tx(|s: &mut Gate, tx: &mut Tx| s.decide("denied", tx)).build(k).key("deny"))
        .child(el().grow(1.0))
        .child(Button::new("Draft").shortcut("⌘D").on_press_tx(|s: &mut Gate, tx: &mut Tx| s.decide("draft", tx)).build(k).key("draft"))
        .child(Button::new("Open PR").variant(ButtonVariant::Submit).shortcut("⌘↩").on_press_tx(|s: &mut Gate, tx: &mut Tx| s.decide("open", tx)).build(k).key("open"));
    col()
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .gap(GAP)
        .child(card(it, k))
        .child(label(k, "Title").pt(6.0))
        .child(title)
        .child(label(k, "Description").pt(6.0))
        .child(col().key("desc-slot").w_full().grow(1.0).shrink().min_h(80.0).child(body))
        .child(actions.pt(6.0))
}

fn empty(k: &Kit) -> El {
    col().w_full().grow(1.0).center().child(text("No PRs pending").font(k.ty.ui).color(k.c.text_muted))
}

fn view(s: &Gate, cx: &mut Cx<Gate>) -> El {
    let k = Kit::neutral(cx.system_dark());
    let content = match s.items.get(s.sel) {
        Some(it) => detail(it, &k, cx),
        None => empty(&k),
    };
    let base = col().key("gate-root").w_full().h_full().padding(PAD).gap(10.0).fill(k.c.bg_base).child(header(s, &k, cx.titlebar_inset())).child(content);
    rune_kit::root(base, Vec::new())
}

fn on_key(s: &mut Gate, ev: &KeyEvent, tx: &mut Tx) -> bool {
    match ev.key {
        Key::Enter if ev.mods.cmd => s.decide("open", tx),
        Key::Command('d') => s.decide("draft", tx),
        Key::Command('[') => s.step(-1),
        Key::Command(']') => s.step(1),
        _ => return false,
    }
    true
}

fn poll(s: &mut Gate, _clock: f64, tx: &mut Tx) -> bool {
    if !s.items.is_empty() {
        s.empty_since = None;
        return false;
    }
    let since = *s.empty_since.get_or_insert_with(Instant::now);
    match IDLE_QUIT.checked_sub(since.elapsed()) {
        Some(left) if !left.is_zero() => tx.wake_after(left),
        _ => tx.quit(),
    }
    false
}

fn on_close(s: &mut Gate, tx: &mut Tx) {
    s.abort_all();
    tx.quit();
}

fn take_lock() -> bool {
    let path = spool::spool_dir().join("daemon.lock");
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()) else { return false };
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_CREAT | libc::O_RDWR, 0o644) };
    fd >= 0 && unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) } == 0
}

pub fn run(preview: bool) -> ! {
    let rune_args: Vec<String> = std::env::args().skip(1).filter(|a| a != "--daemon" && a != "--preview").collect();
    if !preview {
        let _ = std::fs::create_dir_all(spool::queue_dir());
        if !take_lock() {
            std::process::exit(0);
        }
        let _ = std::fs::write(spool::spool_dir().join("daemon.pid"), std::process::id().to_string());
    }

    let spec = AppSpec::<Gate> {
        scenes: &[("sample", sample)],
        on_key: Some(on_key),
        poll: if preview { None } else { Some(poll) },
        min_size: Some((400.0, 460.0)),
        ..AppSpec::new(TITLE, SIZE, init, view)
    };
    let initial: Vec<(String, Input)> = if preview { Vec::new() } else { spool::pending() };
    let mut known: HashSet<String> = initial.iter().map(|(id, _)| id.clone()).collect();
    let app = App::new(spec)
        .init(move || {
            let mut s = init();
            s.items = initial.into_iter().map(|(id, input)| Item::new(id, input)).collect();
            s
        })
        .args(rune_args)
        .on_close(on_close)
        .chrome(Chrome { traffic_lights: Some((PAD, PAD + (HEADER_H - Chrome::TRAFFIC_LIGHT) / 2.0)), ..Chrome::DEFAULT })
        .window_options(WindowOptions { always_on_top: true, min_size: Some((400.0, 460.0)), ..Default::default() });

    if !preview {
        let handle = app.handle();
        std::thread::spawn(move || {
            loop {
                let fresh: Vec<(String, Input)> = spool::pending().into_iter().filter(|(id, _)| known.insert(id.clone())).collect();
                if !fresh.is_empty() {
                    handle.update(move |s: &mut Gate, _| {
                        s.items.extend(fresh.into_iter().map(|(id, input)| Item::new(id, input)));
                        s.empty_since = None;
                    });
                    handle.open();
                }
                std::thread::sleep(SCAN_EVERY);
            }
        });
    }

    app.run();
    std::process::exit(0)
}
