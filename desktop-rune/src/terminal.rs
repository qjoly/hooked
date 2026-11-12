use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine;
use serde_json::{Value, json};

use crate::api;
use crate::app::Hooked;
use crate::ghostty::Vt;
use rune::AppHandle;

pub const COLS: u16 = 120;
pub const ROWS: u16 = 28;

pub struct Term {
    pub id: String,
    pub vt: Vt,
    pub exited: bool,
    alive: Arc<AtomicBool>,
}

impl Drop for Term {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
    }
}

crate::knobs::knobs! {
    "Screen" at "term-screen" under "Terminal";
    TERM_PAD = 8.0, 0.0..=32.0, "Padding around the cells", step 1.0;
}

pub fn pad() -> f32 {
    crate::knobs::get(&TERM_PAD)
}

thread_local! {
    static BLINK_RESET: std::cell::Cell<i64> = const { std::cell::Cell::new(0) };
}

/// Whether a blinking cursor shows now: on for the first half of each period after the last key.
pub fn blink_on() -> bool {
    let since = crate::fmt::now_ms() - BLINK_RESET.with(std::cell::Cell::get);
    (since / BLINK_MS) % 2 == 0
}

/// Milliseconds until the cursor next blinks.
pub fn blink_due() -> u64 {
    let since = crate::fmt::now_ms() - BLINK_RESET.with(std::cell::Cell::get);
    (BLINK_MS - since.rem_euclid(BLINK_MS)).max(1) as u64
}

/// A selection in viewport cells, from where the drag started to where it is.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub struct Sel {
    pub anchor: (u16, u64),
    pub head: (u16, u64),
}

impl Sel {
    pub fn ordered(&self) -> ((u16, u64), (u16, u64)) {
        let key = |p: (u16, u64)| (p.1, p.0);
        if key(self.anchor) <= key(self.head) {
            (self.anchor, self.head)
        } else {
            (self.head, self.anchor)
        }
    }

    /// The columns `a..b` of screen row `row` the selection covers, as a reading-order range.
    pub fn row_range(&self, row: u64, cols: u16) -> Option<(u16, u16)> {
        let ((c0, r0), (c1, r1)) = self.ordered();
        if row < r0 || row > r1 {
            return None;
        }
        let a = if row == r0 { c0 } else { 0 };
        let b = if row == r1 { c1 + 1 } else { cols };
        (b > a).then_some((a, b))
    }
}

#[derive(Default)]
pub struct TermPanel {
    /// Panel height in points; None until the user drags it (a third of the window then).
    pub height: Option<f32>,
    /// Beside the conversation instead of below it, `side_w` points wide.
    pub side: bool,
    pub side_w: f32,
    /// Font size in points; 0 until loaded (the kit's mono size then).
    pub font: f32,
    /// A font family by name (a CSS list works), the kit's mono family when empty.
    pub family: rune::TextEdit,
    pub family_name: Option<&'static str>,
    pub screen: (f32, f32),
    /// The size the PTYs still have to be told about, and when (debounced like the web's fit).
    pub pending: Option<((u16, u16), i64)>,
    pub sel: Option<Sel>,
    pub preedit: String,
    pub size: Option<(u16, u16)>,
    pub cell: (f32, f32),
    pub open: bool,
    pub terms: Vec<Term>,
    pub active: usize,
    pub busy: bool,
    pub bell_at: i64,
    pub search: Option<(rune::TextEdit, (usize, Option<usize>))>,
    pub shift_drag: bool,
    pub motion_cell: Option<(u16, u16)>,
    /// The terminal the selection belongs to: the panel or an inline `!!` one.
    pub sel_owner: Option<TermFocus>,
    /// Rune images for kitty graphics, by terminal and pixel key, so frames don't re-hash pixels.
    pub image_cache: std::cell::RefCell<HashMap<(String, crate::ghostty::ImageKey), rune::Image>>,
}

fn decode(payload: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()
}

fn follow(id: String, alive: Arc<AtomicBool>, h: Option<AppHandle<Hooked>>) {
    let Some(h) = h else {
        return;
    };
    std::thread::spawn(move || {
        let path = format!("/api/terminal/stream?id={}", urlencode(&id));
        while alive.load(Ordering::SeqCst) {
            let pending: Arc<std::sync::Mutex<Vec<u8>>> = Arc::default();
            let queued = Arc::new(AtomicBool::new(false));
            let r = api::follow(&path, |payload| {
                if !alive.load(Ordering::SeqCst) {
                    return false;
                }
                let Some(bytes) = decode(payload) else {
                    return true;
                };
                pending.lock().map(|mut p| p.extend_from_slice(&bytes)).ok();
                if !queued.swap(true, Ordering::SeqCst) {
                    let (id, pending, queued) = (id.clone(), pending.clone(), queued.clone());
                    h.update(move |s, tx| {
                        queued.store(false, Ordering::SeqCst);
                        let bytes = pending
                            .lock()
                            .map(|mut p| std::mem::take(&mut *p))
                            .unwrap_or_default();
                        tx.instant();
                        if let Some(text) = s.term_output(&id, &bytes) {
                            tx.copy(text);
                        }
                    });
                }
                true
            });
            if r.is_ok() {
                let (id, alive) = (id.clone(), alive.clone());
                // Leaving and reopening the session attaches a fresh Term with the same id while
                // this thread is still blocked on the old stream; it only notices it was dropped
                // on the next output, and must not mark its successor exited.
                h.update(move |s, _| {
                    if let Some(t) = s.term_mut(&id).filter(|t| Arc::ptr_eq(&t.alive, &alive)) {
                        t.exited = true;
                    }
                });
                return;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn attach(
    h: Option<AppHandle<Hooked>>,
    id: String,
    exited: bool,
    (cols, rows): (u16, u16),
    cell: (f32, f32),
) -> Option<Term> {
    let mut vt = Vt::new(cols, rows)?;
    vt.resize(cols, rows, cell);
    let alive = Arc::new(AtomicBool::new(true));
    if !exited {
        follow(id.clone(), alive.clone(), h);
    }
    Some(Term {
        id,
        vt,
        exited,
        alive,
    })
}

fn post_input(id: String, bytes: &[u8]) {
    BLINK_RESET.with(|c| c.set(crate::fmt::now_ms()));
    let data = String::from_utf8_lossy(bytes).into_owned();
    std::thread::spawn(move || api::post("/api/terminal/input", json!({ "id": id, "data": data })));
}

impl Hooked {
    fn term_cell(&self) -> (f32, f32) {
        if self.term.cell.0 > 0.0 {
            self.term.cell
        } else {
            (7.2, 18.0)
        }
    }

    /// Shell output lands in its terminal; whatever the terminal answers goes back to that shell.
    /// Returns what the program put on the clipboard (OSC 52), for the caller to copy.
    pub fn term_output(&mut self, id: &str, bytes: &[u8]) -> Option<String> {
        let t = self.term_mut(id)?;
        let reply = t.vt.write(bytes);
        let clip = t.vt.take_clipboard();
        if !reply.is_empty() && !t.exited {
            post_input(id.to_string(), &reply);
        }
        if t.vt.take_bells() > 0 {
            self.term.bell_at = crate::fmt::now_ms();
        }
        clip
    }

    /// Headless renders: attach the session's first shell and replay its scrollback in place.
    pub fn preload_terms(&mut self) {
        let Some(sid) = self.selected.clone() else {
            return;
        };
        let args = rune::extra_args();
        let wanted = args
            .iter()
            .position(|a| a == "--term")
            .and_then(|i| args.get(i + 1))
            .filter(|a| !a.starts_with("--"))
            .cloned();
        let list = api::get(&format!("/api/terminal?sessionId={}", urlencode(&sid))).ok();
        let Some(id) = wanted.or_else(|| {
            list.and_then(|v| {
                v["terminals"].as_array()?.first()?["id"]
                    .as_str()
                    .map(str::to_string)
            })
        }) else {
            return;
        };
        let Some(mut vt) = Vt::new(COLS, ROWS) else {
            return;
        };
        let _ = api::follow(
            &format!("/api/terminal/stream?id={}", urlencode(&id)),
            |payload| {
                if let Some(bytes) = decode(payload) {
                    vt.write(&bytes);
                }
                false
            },
        );
        self.term.terms.push(Term {
            id,
            vt,
            exited: false,
            alive: Arc::new(AtomicBool::new(false)),
        });
        self.term.open = true;
        if let Some(needle) = args
            .iter()
            .position(|a| a == "--term-search")
            .and_then(|i| args.get(i + 1))
        {
            self.open_term_search();
            if let Some((e, _)) = self.term.search.as_mut() {
                *e = rune::TextEdit::new(needle.clone());
            }
            self.term_search_changed();
        }
    }

    /// Headless renders: a `!!` block on the open conversation, its screen replayed in place.
    pub fn preload_pty(&mut self, id: &str, command: &str) {
        let fence = format!("```pty id={id} cwd=/tmp\n$ {command}\n```");
        let Ok(m) = serde_json::from_value(json!({ "role": "user", "text": fence })) else {
            return;
        };
        if let Some(d) = self.detail.as_mut() {
            d.messages.push(m);
            self.ptys.seen = (d.session.id.clone(), d.messages.len());
        }
        let Some(mut vt) = Vt::new(100, PTY_ROWS) else {
            return;
        };
        let _ = api::follow(
            &format!("/api/terminal/stream?id={}", urlencode(id)),
            |payload| {
                if let Some(bytes) = decode(payload) {
                    vt.write(&bytes);
                }
                false
            },
        );
        self.ptys.terms.push(Term {
            id: id.to_string(),
            vt,
            exited: false,
            alive: Arc::new(AtomicBool::new(false)),
        });
    }

    pub fn load_terms(&mut self) {
        self.term.terms.clear();
        self.term.active = 0;
        let Some(sid) = self.selected.clone() else {
            return;
        };
        self.spawn(
            move || api::get(&format!("/api/terminal?sessionId={}", urlencode(&sid))),
            |s, r, _| {
                let (size, cell) = (s.term.size.unwrap_or((COLS, ROWS)), s.term_cell());
                let list: Vec<Value> = r
                    .ok()
                    .and_then(|v| v["terminals"].as_array().cloned())
                    .unwrap_or_default();
                s.term.terms = list
                    .iter()
                    .filter(|t| t["inline"].as_bool() != Some(true))
                    .filter_map(|t| {
                        attach(
                            s.handle.clone(),
                            t["id"].as_str()?.to_string(),
                            t["exited"].as_bool() == Some(true),
                            size,
                            cell,
                        )
                    })
                    .collect();
                if s.term.terms.is_empty() {
                    s.term.open = false;
                }
            },
        );
    }

    pub fn new_term(&mut self) {
        let Some(d) = self.detail.as_ref() else {
            return;
        };
        let (Some(cwd), id) = (d.session.project.clone(), d.session.id.clone()) else {
            return;
        };
        if self.term.busy {
            return;
        }
        self.term.busy = true;
        let (size, cell) = (self.term.size.unwrap_or((COLS, ROWS)), self.term_cell());
        self.spawn(
            move || {
                api::post(
                    "/api/terminal",
                    json!({ "cwd": cwd, "sessionId": id, "cols": size.0, "rows": size.1 }),
                )
            },
            move |s, r, _| {
                s.term.busy = false;
                match r.map(|v| v["id"].as_str().map(str::to_string)) {
                    Ok(Some(id)) => match attach(s.handle.clone(), id, false, size, cell) {
                        Some(t) => {
                            s.term.terms.push(t);
                            s.term.active = s.term.terms.len() - 1;
                            s.term.open = true;
                            s.claim_term();
                        }
                        None => s.flash("✗ Could not start the terminal emulator", true),
                    },
                    Ok(None) => s.flash("✗ The shell did not start", true),
                    Err(e) => s.flash(format!("✗ Terminal: {e}"), true),
                }
            },
        );
    }

    pub fn toggle_terms(&mut self) {
        if self.term.terms.is_empty() {
            self.new_term();
        } else {
            self.term.open = !self.term.open;
            if self.term.open {
                self.claim_term();
            } else {
                self.term_claimed = false;
            }
        }
    }

    /// Hands the keyboard to the panel's shell when it opens or a tab is picked: rune focuses
    /// only text fields from code, so the window routes keys to it until something else has focus.
    pub fn toggle_term_side(&mut self) {
        self.term.side = !self.term.side;
        let side = self.term.side;
        self.save_pref("termSide", &side);
        if self.term.terms.is_empty() {
            self.new_term();
        } else {
            self.term.open = true;
            self.claim_term();
        }
    }

    pub fn term_side_width(&self) -> f32 {
        let w = if self.term.side_w > 0.0 {
            self.term.side_w
        } else {
            560.0
        };
        w.clamp(320.0, (self.window_w * 0.6).max(320.0))
    }

    pub fn claim_term(&mut self) {
        self.set_term_focus(Some(TermFocus::Panel));
        self.term_claimed = true;
        self.composer.focused = false;
    }

    pub fn pick_term(&mut self, i: usize) {
        self.term.active = i;
        self.claim_term();
    }

    pub fn close_term(&mut self, i: usize) {
        if i >= self.term.terms.len() {
            return;
        }
        let t = self.term.terms.remove(i);
        self.term.active = self
            .term
            .active
            .min(self.term.terms.len().saturating_sub(1));
        if self.term.terms.is_empty() {
            self.term.open = false;
        }
        let id = t.id.clone();
        drop(t);
        self.spawn(
            move || api::post("/api/terminal/kill", json!({ "id": id })),
            |_, _, _| {},
        );
    }

    /// Fits the shells to the panel, as the web's fit addon does: the grid only changes when the
    /// cell count does, Ghostty follows at once and the PTYs 150 ms after the last change.
    pub fn fit_terms(&mut self, w: f32, h: f32) {
        self.term.screen = (w, h);
        let cell = self.term_cell();
        let cols = ((w - 2.0 * pad()) / cell.0).floor().clamp(20.0, 500.0) as u16;
        let rows = ((h - 2.0 * pad()) / cell.1).floor().clamp(3.0, 300.0) as u16;
        if self.term.size == Some((cols, rows)) {
            return;
        }
        self.term.size = Some((cols, rows));
        for t in self.term.terms.iter_mut() {
            t.vt.resize(cols, rows, cell);
        }
        self.term.pending = Some(((cols, rows), crate::fmt::now_ms() + 150));
    }

    /// Sends a settled panel size to every live PTY; called from `poll`.
    pub fn flush_term_size(&mut self, now: i64) -> Option<std::time::Duration> {
        let ((cols, rows), due) = self.term.pending?;
        if now < due {
            return Some(std::time::Duration::from_millis((due - now) as u64));
        }
        self.term.pending = None;
        for t in self.term.terms.iter().filter(|t| !t.exited) {
            let id = t.id.clone();
            self.spawn(
                move || {
                    api::post(
                        "/api/terminal/resize",
                        json!({ "id": id, "cols": cols, "rows": rows }),
                    )
                },
                |_, _, _| {},
            );
        }
        None
    }

    pub fn set_cell(&mut self, cw: f32) {
        if (self.term.cell.0 - cw).abs() < 0.01 {
            return;
        }
        self.term.cell = (cw, line_height(self.term_font()));
        self.term.size = None;
        let (w, h) = self.term.screen;
        if w > 0.0 {
            self.fit_terms(w, h);
        }
    }

    pub fn term_key(
        &mut self,
        ev: &rune::KeyEvent,
        physical: Option<rune::PhysicalKeyCode>,
        repeat: bool,
    ) -> bool {
        let Some(t) = self.term.terms.get_mut(self.term.active) else {
            return false;
        };
        let action = if repeat {
            libghostty_vt::key::Action::Repeat
        } else {
            libghostty_vt::key::Action::Press
        };
        let Some(bytes) = t.vt.encode_key_action(ev, physical, action) else {
            return false;
        };
        if !t.exited {
            t.vt.scroll_to_bottom();
            post_input(t.id.clone(), &bytes);
        }
        true
    }

    /// A key release, for programs that asked to hear them (kitty keyboard protocol).
    pub fn term_key_up(
        &mut self,
        f: &TermFocus,
        ev: &rune::KeyEvent,
        physical: Option<rune::PhysicalKeyCode>,
    ) -> bool {
        let Some(t) = self.target_mut(f).filter(|t| !t.exited) else {
            return false;
        };
        match t
            .vt
            .encode_key_action(ev, physical, libghostty_vt::key::Action::Release)
        {
            Some(bytes) => {
                post_input(t.id.clone(), &bytes);
                true
            }
            None => false,
        }
    }

    /// What a Mac terminal sends for ⌘←, ⌘→ and ⌘⌫: start of line, end of line, kill line.
    pub fn term_cmd_key(&mut self, key: &rune::Key) -> bool {
        let bytes: &[u8] = match key {
            rune::Key::Left => b"\x01",
            rune::Key::Right => b"\x05",
            rune::Key::Backspace => b"\x15",
            _ => return false,
        };
        let Some(t) = self
            .term
            .terms
            .get_mut(self.term.active)
            .filter(|t| !t.exited)
        else {
            return false;
        };
        t.vt.scroll_to_bottom();
        post_input(t.id.clone(), bytes);
        true
    }

    pub fn term_drop(&mut self, files: &[std::path::PathBuf]) {
        let quoted: Vec<String> = files
            .iter()
            .map(|p| {
                let s = p.to_string_lossy();
                if s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "/._-+@:".contains(c))
                {
                    s.into_owned()
                } else {
                    format!("'{}'", s.replace('\'', "'\\''"))
                }
            })
            .collect();
        self.term_paste(&format!("{} ", quoted.join(" ")));
    }

    pub fn open_term_search(&mut self) {
        let mut e = rune::TextEdit::new("");
        e.focused = true;
        self.term.search = Some((e, (0, None)));
    }

    pub fn close_term_search(&mut self) {
        self.term.search = None;
        if let Some(t) = self.term.terms.get_mut(self.term.active) {
            t.vt.end_search();
            t.vt.scroll_to_bottom();
        }
    }

    pub fn term_search_changed(&mut self) {
        let Some(needle) = self.term.search.as_ref().map(|(e, _)| e.text.clone()) else {
            return;
        };
        if let Some(t) = self.term.terms.get_mut(self.term.active) {
            let found = t.vt.search(&needle);
            if let Some((_, f)) = self.term.search.as_mut() {
                *f = found;
            }
        }
    }

    pub fn term_search_step(&mut self, older: bool) {
        if let Some(t) = self.term.terms.get_mut(self.term.active) {
            let found = t.vt.search_step(older);
            if let Some((_, f)) = self.term.search.as_mut() {
                *f = found;
            }
        }
    }

    /// ⌘-click on a URL opens it; true when the press landed on one.
    pub fn term_open_link(&mut self, x: f32, y: f32, tx: &mut rune::Tx) -> bool {
        let (col, row) = self.cell_at(&TermFocus::Panel, x, y);
        if let Some(url) = self
            .term
            .terms
            .get(self.term.active)
            .and_then(|t| t.vt.hyperlink_at(col, row))
        {
            let _ = tx.open_url(&url);
            return true;
        }
        let Some(line) = self
            .term
            .terms
            .get(self.term.active)
            .and_then(|t| t.vt.lines.get(usize::from(row)))
        else {
            return false;
        };
        match crate::ghostty::links(line)
            .into_iter()
            .find(|(a, b, _)| (*a..*b).contains(&col))
        {
            Some((_, _, url)) => {
                let _ = tx.open_url(&url);
                true
            }
            None => false,
        }
    }

    pub fn restart_term(&mut self, i: usize) {
        self.close_term(i);
        self.new_term();
    }

    pub fn term_paste(&mut self, text: &str) {
        let Some(t) = self.term.terms.get_mut(self.term.active) else {
            return;
        };
        if t.exited || text.is_empty() {
            return;
        }
        let bytes = t.vt.encode_paste(text);
        t.vt.scroll_to_bottom();
        post_input(t.id.clone(), &bytes);
    }

    fn target(&self, f: &TermFocus) -> Option<&Term> {
        match f {
            TermFocus::Panel => self.term.terms.get(self.term.active),
            TermFocus::Pty(id) => self.ptys.terms.iter().find(|t| t.id == *id),
        }
    }

    fn target_mut(&mut self, f: &TermFocus) -> Option<&mut Term> {
        match f {
            TermFocus::Panel => self.term.terms.get_mut(self.term.active),
            TermFocus::Pty(id) => self.ptys.terms.iter_mut().find(|t| t.id == *id),
        }
    }

    fn cell_at(&self, f: &TermFocus, x: f32, y: f32) -> (u16, u16) {
        let (cw, ch) = self.term_cell();
        let (cols, rows) = self.target(f).map_or((COLS, ROWS), |t| t.vt.size());
        let col = ((x - pad()) / cw)
            .floor()
            .clamp(0.0, f32::from(cols.saturating_sub(1))) as u16;
        let row = ((y - pad()) / ch)
            .floor()
            .clamp(0.0, f32::from(rows.saturating_sub(1))) as u16;
        (col, row)
    }

    /// A press, drag and release on the screen: forwarded to a program that tracks the mouse
    /// (Shift bypasses it, as in Ghostty), otherwise a text selection, which scrolls the
    /// scrollback when dragged past the top or bottom edge. The middle button pastes the
    /// selection when no program takes it.
    pub fn term_drag(
        &mut self,
        f: TermFocus,
        d: &rune::Drag,
        button: rune::PointerButton,
        shift: bool,
    ) {
        use libghostty_vt::mouse::{Action, Button};
        let (col, vrow) = self.cell_at(&f, d.x, d.y);
        let (_, ch) = self.term_cell();
        if d.phase == rune::Phase::Down && button == rune::PointerButton::Primary {
            self.term.sel_owner = Some(f.clone());
        }
        let has_sel = self.term.sel.is_some();
        let Some(t) = self.target_mut(&f) else {
            return;
        };
        let rows = t.vt.size().1;
        let tracking = t.vt.mouse_tracking() && !t.exited;
        let action = match d.phase {
            rune::Phase::Down => Action::Press,
            rune::Phase::Move => Action::Motion,
            rune::Phase::Up => Action::Release,
        };
        if button == rune::PointerButton::Middle {
            if tracking {
                if let Some(bytes) = t.vt.encode_mouse(
                    action,
                    Some(Button::Middle),
                    d.x - pad(),
                    d.y - pad(),
                    shift,
                ) {
                    post_input(t.id.clone(), &bytes);
                }
            } else if d.phase == rune::Phase::Down
                && let Some(text) = self.selection_text()
            {
                match &f {
                    TermFocus::Panel => self.term_paste(&text),
                    TermFocus::Pty(id) => self.pty_paste(id, &text),
                }
            }
            return;
        }
        if !shift && tracking {
            if let Some(bytes) =
                t.vt.encode_mouse(action, Some(Button::Left), d.x - pad(), d.y - pad(), false)
            {
                post_input(t.id.clone(), &bytes);
            }
            self.term.sel = None;
            return;
        }
        if d.phase == rune::Phase::Move && has_sel {
            if d.y < pad() {
                t.vt.scroll(-1);
            } else if d.y > pad() + f32::from(rows) * ch {
                t.vt.scroll(1);
            }
        }
        let top = t.vt.viewport_top();
        let cols = t.vt.size().0;
        let line = t.vt.lines.get(usize::from(vrow)).cloned();
        let cell = (col, top + u64::from(vrow));
        match d.phase {
            rune::Phase::Down if d.clicks >= 3 => {
                self.term.sel = Some(Sel {
                    anchor: (0, cell.1),
                    head: (cols.saturating_sub(1), cell.1),
                });
            }
            rune::Phase::Down if d.clicks == 2 => {
                let Some(line) = line else {
                    return;
                };
                let word = |c: u16| {
                    line.slice(c, c + 1)
                        .chars()
                        .next()
                        .is_some_and(|ch| !ch.is_whitespace() && !"\"'`()[]{}<>|;,".contains(ch))
                };
                if !word(col) {
                    self.term.sel = None;
                    return;
                }
                let (mut a, mut b) = (col, col);
                while a > 0 && word(a - 1) {
                    a -= 1;
                }
                while b + 1 < cols && word(b + 1) {
                    b += 1;
                }
                self.term.sel = Some(Sel {
                    anchor: (a, cell.1),
                    head: (b, cell.1),
                });
            }
            rune::Phase::Down => {
                self.term.sel = Some(Sel {
                    anchor: cell,
                    head: cell,
                })
            }
            rune::Phase::Move if d.clicks <= 1 => {
                if let Some(sel) = self.term.sel.as_mut() {
                    sel.head = cell;
                }
            }
            rune::Phase::Move => {}
            rune::Phase::Up => {
                if d.clicks <= 1 && self.term.sel.is_some_and(|s| s.anchor == s.head) {
                    self.term.sel = None;
                }
            }
        }
    }

    /// The right button goes to a program that tracks the mouse, as a press and a release.
    pub fn term_right_click(&mut self, f: &TermFocus, x: f32, y: f32) {
        use libghostty_vt::mouse::{Action, Button};
        let Some(t) = self.target(f).filter(|t| !t.exited) else {
            return;
        };
        for action in [Action::Press, Action::Release] {
            if let Some(bytes) =
                t.vt.encode_mouse(action, Some(Button::Right), x - pad(), y - pad(), false)
            {
                post_input(t.id.clone(), &bytes);
            }
        }
    }

    /// Pointer motion with no button held, for programs that asked for every motion (1003).
    pub fn term_hover(&mut self, f: &TermFocus, x: f32, y: f32) {
        use libghostty_vt::mouse::Action;
        let cell = self.cell_at(f, x, y);
        if self.term.motion_cell == Some(cell) {
            return;
        }
        self.term.motion_cell = Some(cell);
        let Some(t) = self.target(f).filter(|t| !t.exited) else {
            return;
        };
        if let Some(bytes) =
            t.vt.encode_mouse(Action::Motion, None, x - pad(), y - pad(), false)
        {
            post_input(t.id.clone(), &bytes);
        }
    }

    pub fn selection_text(&self) -> Option<String> {
        let sel = self.term.sel?;
        let t = self.target(self.term.sel_owner.as_ref().unwrap_or(&TermFocus::Panel))?;
        let (a, b) = sel.ordered();
        t.vt.text_between(a, b).filter(|t| !t.is_empty())
    }

    /// Input-method text for the focused terminal: the composition is drawn at the cursor,
    /// the committed text goes to the shell.
    pub fn term_ime(&mut self, f: &TermFocus, ime: &rune::Ime) {
        match ime {
            rune::Ime::Preedit(text, _) => self.term.preedit = text.clone(),
            rune::Ime::Commit(text) => {
                self.term.preedit.clear();
                if let Some(t) = self.target_mut(f)
                    && !t.exited
                {
                    t.vt.scroll_to_bottom();
                    post_input(t.id.clone(), text.as_bytes());
                }
            }
            _ => {}
        }
    }

    pub fn term_wheel(&mut self, dy: f32, x: f32, y: f32) {
        let Some(t) = self.term.terms.get_mut(self.term.active) else {
            return;
        };
        let lines = (dy / t.vt.cell.1).round() as isize;
        if lines == 0 {
            return;
        }
        if t.vt.mouse_tracking() {
            let mut out = Vec::new();
            for _ in 0..lines.unsigned_abs().min(10) {
                if let Some(b) = t.vt.encode_wheel(lines > 0, x, y) {
                    out.extend(b);
                }
            }
            if !out.is_empty() && !t.exited {
                post_input(t.id.clone(), &out);
            }
        } else {
            t.vt.scroll(-lines);
            self.term.sel = None;
        }
    }
}

pub const PTY_ROWS: u16 = 18;
pub const FONT: f32 = 12.0;
pub const BLINK_MS: i64 = 530;

pub fn line_height(font: f32) -> f32 {
    (font * 1.5).round()
}

/// Which terminal holds the keyboard. Rune reports focus only to key handlers, while input-method
/// events and pastes reach the app without it, so presses and keys on a terminal record it here.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum TermFocus {
    Panel,
    Pty(String),
}

pub fn is_term_key(key: &str) -> bool {
    key == "term-screen" || key.starts_with("pty-screen-")
}

#[derive(Default)]
pub struct Ptys {
    pub terms: Vec<Term>,
    pub dead: std::collections::HashSet<String>,
    pub checking: bool,
    pub seen: (String, usize),
}

pub struct PtyFence {
    pub id: String,
    pub cwd: String,
    pub command: String,
}

/// The fence `!!command` leaves in the transcript (`formatInteractiveCommand` in server/agent.js).
pub fn pty_fence(text: &str) -> Option<PtyFence> {
    let mut lines = text.trim().lines();
    let info = lines.next()?.strip_prefix("```pty")?;
    let (mut id, mut cwd) = (String::new(), String::new());
    if let Some(i) = info.find(" id=") {
        id = info[i + 4..].split_whitespace().next()?.to_string();
    }
    if let Some(i) = info.find(" cwd=") {
        cwd = info[i + 5..].to_string();
    }
    let first = lines.next().unwrap_or("");
    let command = first.strip_prefix("$ ").unwrap_or(first).to_string();
    (!id.is_empty()).then_some(PtyFence { id, cwd, command })
}

impl Hooked {
    pub fn term_mut(&mut self, id: &str) -> Option<&mut Term> {
        self.term
            .terms
            .iter_mut()
            .chain(self.ptys.terms.iter_mut())
            .find(|t| t.id == id)
    }

    /// Attaches the live `!!` terminals the open conversation shows; called from `poll`.
    pub fn sync_ptys(&mut self) {
        let Some(d) = self.detail.as_ref() else {
            return;
        };
        let key = (d.session.id.clone(), d.messages.len());
        if self.ptys.checking || self.ptys.seen == key {
            return;
        }
        let wanted: Vec<String> = d
            .messages
            .iter()
            .filter(|m| m.role == "user")
            .filter_map(|m| pty_fence(&m.text))
            .map(|f| f.id)
            .filter(|id| {
                !self.ptys.dead.contains(id) && !self.ptys.terms.iter().any(|t| t.id == *id)
            })
            .collect();
        self.ptys.seen = key.clone();
        if wanted.is_empty() {
            return;
        }
        self.ptys.checking = true;
        let sid = key.0;
        self.spawn(
            move || api::get(&format!("/api/terminal?sessionId={}", urlencode(&sid))),
            move |s, r, _| {
                s.ptys.checking = false;
                let Ok(v) = r else {
                    s.ptys.seen = Default::default();
                    return;
                };
                let list = v["terminals"].as_array().cloned().unwrap_or_default();
                let cell = s.term_cell();
                for id in wanted {
                    let live = list.iter().any(|t| {
                        t["id"].as_str() == Some(id.as_str()) && t["exited"].as_bool() != Some(true)
                    });
                    match live
                        .then(|| attach(s.handle.clone(), id.clone(), false, (100, PTY_ROWS), cell))
                        .flatten()
                    {
                        Some(t) => s.ptys.terms.push(t),
                        None => {
                            s.ptys.dead.insert(id);
                        }
                    }
                }
            },
        );
    }

    pub fn pty_key(
        &mut self,
        id: &str,
        ev: &rune::KeyEvent,
        physical: Option<rune::PhysicalKeyCode>,
        repeat: bool,
    ) -> bool {
        let Some(t) = self.ptys.terms.iter_mut().find(|t| t.id == id) else {
            return false;
        };
        let bytes = if ev.mods.cmd {
            match ev.key {
                rune::Key::Left => b"\x01".to_vec(),
                rune::Key::Right => b"\x05".to_vec(),
                rune::Key::Backspace => b"\x15".to_vec(),
                _ => return false,
            }
        } else {
            let action = if repeat {
                libghostty_vt::key::Action::Repeat
            } else {
                libghostty_vt::key::Action::Press
            };
            let Some(b) = t.vt.encode_key_action(ev, physical, action) else {
                return false;
            };
            b
        };
        if !t.exited {
            t.vt.scroll_to_bottom();
            post_input(t.id.clone(), &bytes);
        }
        true
    }

    pub fn term_font(&self) -> f32 {
        if self.term.font > 0.0 {
            self.term.font
        } else {
            FONT
        }
    }

    pub fn zoom_term(&mut self, step: i32) {
        let f = if step == 0 {
            FONT
        } else {
            (self.term_font() + step as f32).clamp(8.0, 28.0)
        };
        self.term.font = f;
        self.save_pref("termFont", &f);
        self.term.cell = (0.0, line_height(f));
    }

    /// Applies the family typed in Settings; rune keeps family names for the whole run.
    pub fn apply_term_family(&mut self) {
        let name = self.term.family.text.trim().to_string();
        self.save_pref("termFontFamily", &name);
        if self.term.family_name.unwrap_or("") == name {
            return;
        }
        self.term.family_name = (!name.is_empty()).then(|| &*Box::leak(name.into_boxed_str()));
        self.term.cell = (0.0, line_height(self.term_font()));
    }

    pub fn term_style(&self, base: rune::TextStyle) -> rune::TextStyle {
        let mut f = base;
        f.size = self.term_font();
        f.line_height = line_height(f.size);
        if let Some(name) = self.term.family_name {
            f.family = rune::Family::Named(name);
        }
        f
    }

    pub fn set_term_focus(&mut self, next: Option<TermFocus>) {
        if self.term_focus == next {
            return;
        }
        let prev = std::mem::replace(&mut self.term_focus, next.clone());
        if let Some(p) = prev {
            self.report_focus(&p, false);
        }
        if let Some(n) = next {
            self.report_focus(&n, true);
        }
    }

    /// The window gaining or losing focus reaches the shell that holds the keyboard.
    pub fn window_focus(&mut self, gained: bool) {
        if let Some(f) = self.term_focus.clone() {
            self.report_focus(&f, gained);
        }
    }

    fn report_focus(&mut self, f: &TermFocus, gained: bool) {
        let t = match f {
            TermFocus::Panel => self.term.terms.get(self.term.active),
            TermFocus::Pty(id) => self.ptys.terms.iter().find(|t| t.id == *id),
        };
        if let Some(t) = t.filter(|t| !t.exited)
            && let Some(bytes) = t.vt.focus_report(gained)
        {
            post_input(t.id.clone(), &bytes);
        }
    }

    pub fn term_cursor_blinks(&self) -> bool {
        let t = match self.term_focus.as_ref() {
            Some(TermFocus::Panel) => self.term.terms.get(self.term.active),
            Some(TermFocus::Pty(id)) => self.ptys.terms.iter().find(|t| t.id == *id),
            None => None,
        };
        t.and_then(|t| t.vt.cursor).is_some_and(|c| c.blinking)
    }

    pub fn sync_term_theme(&mut self) {
        let dark = self.theme_dark.get();
        for t in self.term.terms.iter_mut().chain(self.ptys.terms.iter_mut()) {
            t.vt.set_dark(dark);
        }
    }

    pub fn focused_paste(&mut self, text: &str) -> bool {
        match self.term_focus.clone() {
            Some(TermFocus::Panel) => self.term_paste(text),
            Some(TermFocus::Pty(id)) => self.pty_paste(&id, text),
            None => return false,
        }
        true
    }

    pub fn focused_ime(&mut self, ime: &rune::Ime) -> bool {
        let Some(f) = self.term_focus.clone() else {
            return false;
        };
        self.term_ime(&f, ime);
        true
    }

    pub fn pty_paste(&mut self, id: &str, text: &str) {
        let Some(t) = self.ptys.terms.iter_mut().find(|t| t.id == id && !t.exited) else {
            return;
        };
        let bytes = t.vt.encode_paste(text);
        t.vt.scroll_to_bottom();
        post_input(t.id.clone(), &bytes);
    }

    pub fn pty_wheel(&mut self, id: &str, dy: f32, x: f32, y: f32) {
        let Some(t) = self.ptys.terms.iter_mut().find(|t| t.id == id) else {
            return;
        };
        let lines = (dy / t.vt.cell.1).round() as isize;
        if lines == 0 {
            return;
        }
        if t.vt.mouse_tracking() {
            let out: Vec<u8> = (0..lines.unsigned_abs().min(10))
                .filter_map(|_| t.vt.encode_wheel(lines > 0, x, y))
                .flatten()
                .collect();
            if !out.is_empty() && !t.exited {
                post_input(t.id.clone(), &out);
            }
        } else {
            t.vt.scroll(-lines);
        }
    }

    pub fn pty_fit(&mut self, id: &str, w: f32) {
        let cell = self.term_cell();
        let cols = ((w - 2.0 * pad()) / cell.0).floor().clamp(20.0, 500.0) as u16;
        let Some(t) = self.ptys.terms.iter_mut().find(|t| t.id == id) else {
            return;
        };
        if t.vt.size() == (cols, PTY_ROWS) && t.vt.cell == cell {
            return;
        }
        t.vt.resize(cols, PTY_ROWS, cell);
        if t.exited {
            return;
        }
        let id = id.to_string();
        self.spawn(
            move || {
                api::post(
                    "/api/terminal/resize",
                    json!({ "id": id, "cols": cols, "rows": PTY_ROWS }),
                )
            },
            |_, _, _| {},
        );
    }

    pub fn close_pty(&mut self, id: String) {
        self.ptys.terms.retain(|t| t.id != id);
        self.ptys.dead.insert(id.clone());
        self.spawn(
            move || api::post("/api/terminal/kill", json!({ "id": id })),
            |_, _, _| {},
        );
    }
}

#[cfg(test)]
mod pty_tests {
    use super::*;

    #[test]
    fn reads_the_interactive_fence() {
        let f =
            pty_fence("```pty id=t-12 cwd=/Users/me/my repo\n$ claude mcp login x\n```").unwrap();
        assert_eq!(f.id, "t-12");
        assert_eq!(f.cwd, "/Users/me/my repo");
        assert_eq!(f.command, "claude mcp login x");
        assert!(pty_fence("```console exit=0\n$ ls\n```").is_none());
    }
}
