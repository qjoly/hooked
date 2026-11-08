use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine;
use rune::Key;
use serde_json::{Value, json};

use crate::api;
use crate::app::{HANDLE, Hooked, spawn};

pub const COLS: u16 = 120;
pub const ROWS: u16 = 28;

pub struct Term {
    pub id: String,
    pub parser: vt100::Parser,
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
    pub open: bool,
    pub terms: Vec<Term>,
    pub active: usize,
    pub busy: bool,
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
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(payload) {
                    let id = id.clone();
                    h.update(move |s, _| {
                        if let Some(t) = s.term.terms.iter_mut().find(|t| t.id == id) {
                            t.parser.process(&bytes);
                        }
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

fn attach(id: String, exited: bool) -> Term {
    let alive = Arc::new(AtomicBool::new(true));
    if !exited {
        follow(id.clone(), alive.clone());
    }
    Term {
        id,
        parser: vt100::Parser::new(ROWS, COLS, 2000),
        exited,
        alive,
    }
}

/// The bytes a key sends to a shell, as xterm encodes them.
pub fn encode(ev: &rune::KeyEvent) -> Option<Vec<u8>> {
    let seq = |s: &str| Some(s.as_bytes().to_vec());
    match &ev.key {
        Key::Enter => seq("\r"),
        Key::Backspace => seq("\x7f"),
        Key::Tab => seq(if ev.mods.shift { "\x1b[Z" } else { "\t" }),
        Key::Escape => seq("\x1b"),
        Key::Up => seq("\x1b[A"),
        Key::Down => seq("\x1b[B"),
        Key::Right => seq("\x1b[C"),
        Key::Left => seq("\x1b[D"),
        Key::Home => seq("\x1b[H"),
        Key::End => seq("\x1b[F"),
        Key::Delete => seq("\x1b[3~"),
        Key::PageUp => seq("\x1b[5~"),
        Key::PageDown => seq("\x1b[6~"),
        Key::Text(t) if ev.mods.ctrl && !ev.mods.cmd => {
            let c = t.chars().next()?.to_ascii_lowercase();
            if c.is_ascii_lowercase() || "@[\\]^_".contains(c) {
                Some(vec![(c as u8) & 0x1f])
            } else {
                None
            }
        }
        Key::Text(t) if ev.mods.alt => Some([b"\x1b".as_slice(), t.as_bytes()].concat()),
        Key::Text(t) => Some(t.as_bytes().to_vec()),
        _ => None,
    }
}

impl Hooked {
    /// Headless renders: attach the session's first shell and replay its scrollback in place.
    pub fn preload_terms(&mut self) {
        let Some(sid) = self.selected.clone() else {
            return;
        };
        let list = api::get(&format!("/api/terminal?sessionId={}", urlencode(&sid))).ok();
        let Some(id) = list.and_then(|v| {
            v["terminals"].as_array()?.first()?["id"]
                .as_str()
                .map(str::to_string)
        }) else {
            return;
        };
        let mut parser = vt100::Parser::new(ROWS, COLS, 2000);
        let _ = api::follow(
            &format!("/api/terminal/stream?id={}", urlencode(&id)),
            |payload| {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(payload) {
                    parser.process(&bytes);
                }
                false
            },
        );
        self.term.terms.push(Term {
            id,
            parser,
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
                let list: Vec<Value> = r
                    .ok()
                    .and_then(|v| v["terminals"].as_array().cloned())
                    .unwrap_or_default();
                s.term.terms = list
                    .iter()
                    .filter(|t| t["inline"].as_bool() != Some(true))
                    .filter_map(|t| {
                        t["id"]
                            .as_str()
                            .map(|id| attach(id.to_string(), t["exited"].as_bool() == Some(true)))
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
        spawn(
            move || {
                api::post(
                    "/api/terminal",
                    json!({ "cwd": cwd, "sessionId": id, "cols": COLS, "rows": ROWS }),
                )
            },
            |s, r, _| {
                s.term.busy = false;
                match r.map(|v| v["id"].as_str().map(str::to_string)) {
                    Ok(Some(id)) => {
                        s.term.terms.push(attach(id, false));
                        s.term.active = s.term.terms.len() - 1;
                        s.term.open = true;
                    }
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

    pub fn term_input(&mut self, bytes: Vec<u8>) {
        let Some(t) = self.term.terms.get(self.term.active) else {
            return;
        };
        if t.exited {
            return;
        }
        let id = t.id.clone();
        let data = String::from_utf8_lossy(&bytes).into_owned();
        spawn(
            move || api::post("/api/terminal/input", json!({ "id": id, "data": data })),
            |_, _, _| {},
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{KeyEvent, Mods};

    fn ev(key: Key, ctrl: bool) -> KeyEvent {
        KeyEvent {
            key,
            mods: Mods {
                ctrl,
                ..Default::default()
            },
        }
    }

    #[test]
    fn keys_encode_as_xterm_does() {
        assert_eq!(encode(&ev(Key::Enter, false)), Some(b"\r".to_vec()));
        assert_eq!(encode(&ev(Key::Up, false)), Some(b"\x1b[A".to_vec()));
        assert_eq!(encode(&ev(Key::Text("c".into()), true)), Some(vec![3]));
        assert_eq!(
            encode(&ev(Key::Text("é".into()), false)),
            Some("é".as_bytes().to_vec())
        );
    }
}
