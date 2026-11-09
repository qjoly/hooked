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

#[derive(Default)]
pub struct TermPanel {
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
                    h.update(move |s, _| s.term_output(&id, &bytes));
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

    /// Fits the shells to the panel: Ghostty's grid at once, the PTY over the API.
    pub fn fit_terms(&mut self, w: f32, h: f32, cell: (f32, f32)) {
        self.term.cell = cell;
        let cols = ((w - 16.0) / cell.0).floor().clamp(20.0, 400.0) as u16;
        let rows = ((h - 16.0) / cell.1).floor().clamp(5.0, 200.0) as u16;
        if self.term.size == Some((cols, rows)) {
            return;
        }
        self.term.size = Some((cols, rows));
        for t in self.term.terms.iter_mut() {
            t.vt.resize(cols, rows, cell);
            if t.exited {
                continue;
            }
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
        }
    }
}
