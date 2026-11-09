use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine;
use serde_json::{Value, json};

use crate::api;
use crate::app::{HANDLE, Hooked, spawn};
use crate::ghostty::Vt;

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

pub const PAD: f32 = 8.0;

/// A selection in viewport cells, from where the drag started to where it is.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub struct Sel {
    pub anchor: (u16, u16),
    pub head: (u16, u16),
}

impl Sel {
    fn ordered(&self) -> ((u16, u16), (u16, u16)) {
        let key = |p: (u16, u16)| (p.1, p.0);
        if key(self.anchor) <= key(self.head) {
            (self.anchor, self.head)
        } else {
            (self.head, self.anchor)
        }
    }

    /// The columns `a..b` of `row` the selection covers, as a reading-order range.
    pub fn row_range(&self, row: u16, cols: u16) -> Option<(u16, u16)> {
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
}

fn decode(payload: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()
}

fn follow(id: String, alive: Arc<AtomicBool>) {
    let Some(h) = HANDLE.get().cloned() else {
        return;
    };
    std::thread::spawn(move || {
        let path = format!("/api/terminal/stream?id={}", urlencode(&id));
        while alive.load(Ordering::SeqCst) {
            let r = api::follow(&path, |payload| {
                if !alive.load(Ordering::SeqCst) {
                    return false;
                }
                if let Some(bytes) = decode(payload) {
                    let id = id.clone();
                    h.update(move |s, tx| {
                        tx.instant();
                        s.term_output(&id, &bytes)
                    });
                }
                true
            });
            if r.is_ok() {
                let id = id.clone();
                h.update(move |s, _| {
                    if let Some(t) = s.term.terms.iter_mut().find(|t| t.id == id) {
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

fn attach(id: String, exited: bool, (cols, rows): (u16, u16), cell: (f32, f32)) -> Option<Term> {
    let mut vt = Vt::new(cols, rows)?;
    vt.cell = cell;
    let alive = Arc::new(AtomicBool::new(true));
    if !exited {
        follow(id.clone(), alive.clone());
    }
    Some(Term {
        id,
        vt,
        exited,
        alive,
    })
}

fn post_input(id: String, bytes: &[u8]) {
    let data = String::from_utf8_lossy(bytes).into_owned();
    spawn(
        move || api::post("/api/terminal/input", json!({ "id": id, "data": data })),
        |_, _, _| {},
    );
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
    pub fn term_output(&mut self, id: &str, bytes: &[u8]) {
        let Some(t) = self.term.terms.iter_mut().find(|t| t.id == id) else {
            return;
        };
        let reply = t.vt.write(bytes);
        if !reply.is_empty() && !t.exited {
            post_input(id.to_string(), &reply);
        }
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
    }

    pub fn load_terms(&mut self) {
        self.term.terms.clear();
        self.term.active = 0;
        let Some(sid) = self.selected.clone() else {
            return;
        };
        spawn(
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
        spawn(
            move || {
                api::post(
                    "/api/terminal",
                    json!({ "cwd": cwd, "sessionId": id, "cols": size.0, "rows": size.1 }),
                )
            },
            move |s, r, _| {
                s.term.busy = false;
                match r.map(|v| v["id"].as_str().map(str::to_string)) {
                    Ok(Some(id)) => match attach(id, false, size, cell) {
                        Some(t) => {
                            s.term.terms.push(t);
                            s.term.active = s.term.terms.len() - 1;
                            s.term.open = true;
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
        }
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
        spawn(
            move || api::post("/api/terminal/kill", json!({ "id": id })),
            |_, _, _| {},
        );
    }

    /// Fits the shells to the panel, as the web's fit addon does: the grid only changes when the
    /// cell count does, Ghostty follows at once and the PTYs 150 ms after the last change.
    pub fn fit_terms(&mut self, w: f32, h: f32) {
        self.term.screen = (w, h);
        let cell = self.term_cell();
        let cols = ((w - 2.0 * PAD) / cell.0).floor().clamp(20.0, 500.0) as u16;
        let rows = ((h - 2.0 * PAD) / cell.1).floor().clamp(3.0, 300.0) as u16;
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
            spawn(
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
        self.term.cell = (cw, 18.0);
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
    ) -> bool {
        let Some(t) = self.term.terms.get_mut(self.term.active) else {
            return false;
        };
        let Some(bytes) = t.vt.encode_key(ev, physical) else {
            return false;
        };
        if !t.exited {
            t.vt.scroll_to_bottom();
            post_input(t.id.clone(), &bytes);
        }
        true
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

    fn cell_at(&self, x: f32, y: f32) -> (u16, u16) {
        let (cw, ch) = self.term_cell();
        let (cols, rows) = self
            .term
            .terms
            .get(self.term.active)
            .map_or((COLS, ROWS), |t| t.vt.size());
        let col = ((x - PAD) / cw)
            .floor()
            .clamp(0.0, f32::from(cols.saturating_sub(1))) as u16;
        let row = ((y - PAD) / ch)
            .floor()
            .clamp(0.0, f32::from(rows.saturating_sub(1))) as u16;
        (col, row)
    }

    /// A press, drag and release on the screen: forwarded to a program that tracks the mouse
    /// (Shift bypasses it, as in Ghostty), otherwise a text selection.
    pub fn term_drag(&mut self, d: &rune::Drag, shift: bool) {
        use libghostty_vt::mouse::{Action, Button};
        let cell = self.cell_at(d.x, d.y);
        let Some(t) = self.term.terms.get(self.term.active) else {
            return;
        };
        if !shift && t.vt.mouse_tracking() && !t.exited {
            let (action, button) = match d.phase {
                rune::Phase::Down => (Action::Press, Some(Button::Left)),
                rune::Phase::Move => (Action::Motion, Some(Button::Left)),
                rune::Phase::Up => (Action::Release, Some(Button::Left)),
            };
            if let Some(bytes) =
                t.vt.encode_mouse(action, button, d.x - PAD, d.y - PAD, false)
            {
                post_input(t.id.clone(), &bytes);
            }
            self.term.sel = None;
            return;
        }
        match d.phase {
            rune::Phase::Down if d.clicks >= 3 => {
                let cols = t.vt.size().0;
                self.term.sel = Some(Sel {
                    anchor: (0, cell.1),
                    head: (cols.saturating_sub(1), cell.1),
                });
            }
            rune::Phase::Down if d.clicks == 2 => {
                let Some(line) = t.vt.lines.get(usize::from(cell.1)) else {
                    return;
                };
                let cols = t.vt.size().0;
                let word = |c: u16| {
                    line.slice(c, c + 1)
                        .chars()
                        .next()
                        .is_some_and(|ch| !ch.is_whitespace() && !"\"'`()[]{}<>|;,".contains(ch))
                };
                if !word(cell.0) {
                    self.term.sel = None;
                    return;
                }
                let (mut a, mut b) = (cell.0, cell.0);
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

    pub fn selection_text(&self) -> Option<String> {
        let sel = self.term.sel?;
        let t = self.term.terms.get(self.term.active)?;
        let cols = t.vt.size().0;
        let rows: Vec<String> =
            t.vt.lines
                .iter()
                .enumerate()
                .filter_map(|(i, l)| {
                    sel.row_range(i as u16, cols)
                        .map(|(a, b)| l.slice(a, b).trim_end().to_string())
                })
                .collect();
        (!rows.is_empty()).then(|| rows.join("\n"))
    }

    /// Input-method text for the focused terminal: the composition is drawn at the cursor,
    /// the committed text goes to the shell.
    pub fn term_ime(&mut self, ime: &rune::Ime) {
        match ime {
            rune::Ime::Preedit(text, _) => self.term.preedit = text.clone(),
            rune::Ime::Commit(text) => {
                self.term.preedit.clear();
                if let Some(t) = self.term.terms.get_mut(self.term.active)
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
