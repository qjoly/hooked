//! Dragging a session onto another to group them, as the web's `dragSession` / `dropSession`.
//! Rune drags only out to other apps, so the rows drag themselves: drop targets report their
//! window rects as they lay out, and the drag hit-tests them.
use std::collections::HashMap;

use serde_json::json;

use crate::app::Hooked;

pub const THRESHOLD: f32 = 4.0;

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Drop {
    Session(String),
    Detach,
}

pub struct Dnd {
    pub id: String,
    pub label: String,
    pub at: (f32, f32),
    pub over: Option<Drop>,
}

/// Rect keys: `sb:<id>` / `fl:<id>` for a session row or card, `repo:<name>` for a fleet repo
/// header. The innermost (smallest) rect under the point wins.
pub fn hit(rects: &HashMap<String, [f32; 4]>, x: f32, y: f32, from: &str) -> Option<Drop> {
    rects
        .iter()
        .filter(|(_, r)| x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3])
        .min_by(|a, b| (a.1[2] * a.1[3]).total_cmp(&(b.1[2] * b.1[3])))
        .and_then(|(k, _)| {
            if k.starts_with("repo:") {
                return Some(Drop::Detach);
            }
            let id = k.strip_prefix("sb:").or_else(|| k.strip_prefix("fl:"))?;
            (id != from).then(|| Drop::Session(id.to_string()))
        })
}

impl Hooked {
    pub fn note_drop_rect(&mut self, key: String, r: [f32; 4]) {
        self.drop_rects.insert(key, r);
    }

    fn lead_of(&self, id: &str) -> String {
        self.group_of(id).unwrap_or(id).to_string()
    }

    /// Whether dropping `drop` would change anything for the dragged session.
    pub fn drop_allowed(&self, id: &str, drop: &Drop) -> bool {
        match drop {
            Drop::Session(t) => self.lead_of(t) != self.lead_of(id),
            Drop::Detach => self.group_of(id).is_some(),
        }
    }

    pub fn drag_session(&mut self, id: &str, d: &rune::Drag) {
        match d.phase {
            rune::Phase::Down => self.dnd = None,
            rune::Phase::Move => {
                if self.dnd.is_none() && d.dx.hypot(d.dy) < THRESHOLD {
                    return;
                }
                let [x, y] = d.window_point();
                let live = self.drop_live.borrow();
                let rects: HashMap<String, [f32; 4]> = self
                    .drop_rects
                    .iter()
                    .filter(|(k, _)| live.contains(*k))
                    .map(|(k, r)| (k.clone(), *r))
                    .collect();
                drop(live);
                let over = hit(&rects, x, y, id).filter(|t| self.drop_allowed(id, t));
                let label = self
                    .sessions
                    .iter()
                    .find(|s| s.id == id)
                    .map(|s| self.title_of(s))
                    .unwrap_or_default();
                self.dnd = Some(Dnd {
                    id: id.to_string(),
                    label,
                    at: (x, y),
                    over,
                });
            }
            rune::Phase::Up => {
                let Some(dnd) = self.dnd.take() else {
                    return;
                };
                if d.cancelled() {
                    return;
                }
                match dnd.over {
                    Some(Drop::Session(t)) => {
                        let target = self.lead_of(&t);
                        self.group_op("join", dnd.id, json!({ "target": target }));
                    }
                    Some(Drop::Detach) => self.group_op("leave", dnd.id, json!({})),
                    None => {}
                }
            }
        }
    }

    /// `e` as a drop target under `key`, highlighted while a drag hovers it.
    pub fn drop_target(&self, k: &rune_kit::Kit, key: String, e: rune::El) -> rune::El {
        self.drop_live.borrow_mut().insert(key.clone());
        let hot = self.drop_hot(&key);
        let e = e.on_layout_tx(move |s: &mut Hooked, r, tx| {
            s.note_drop_rect(key.clone(), r);
            tx.live_only();
        });
        if hot {
            e.fill(k.c.text_accent.alpha(0.12))
                .border(1.0, k.c.text_accent)
        } else {
            e
        }
    }

    pub fn drop_hot(&self, key: &str) -> bool {
        let Some(over) = self.dnd.as_ref().and_then(|d| d.over.as_ref()) else {
            return false;
        };
        match over {
            Drop::Session(id) => {
                key.strip_prefix("sb:").or_else(|| key.strip_prefix("fl:")) == Some(id)
            }
            Drop::Detach => key.starts_with("repo:"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_innermost_rect_under_the_pointer_wins() {
        let mut r = HashMap::new();
        r.insert("sb:a".to_string(), [0.0, 0.0, 300.0, 40.0]);
        r.insert("sb:b".to_string(), [0.0, 40.0, 300.0, 40.0]);
        r.insert("repo:hooked".to_string(), [400.0, 0.0, 600.0, 30.0]);
        assert_eq!(hit(&r, 10.0, 50.0, "a"), Some(Drop::Session("b".into())));
        assert_eq!(hit(&r, 10.0, 10.0, "a"), None);
        assert_eq!(hit(&r, 500.0, 10.0, "a"), Some(Drop::Detach));
        assert_eq!(hit(&r, 350.0, 10.0, "a"), None);
    }
}
