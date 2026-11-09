use std::collections::HashMap;

use rune::{KeyEvent, Shortcut, Tx};
use rune_kit::ShortcutRecorderState;

use crate::app::{Hooked, Page};

/// The web's `SHORTCUT_DEFS`: id, label, default chord.
pub const ACTIONS: [(&str, &str, &str); 18] = [
    ("command-palette", "Omnibar", "mod+p"),
    ("commands-only", "Omnibar (commands only)", "mod+shift+p"),
    ("new-session", "New session", "mod+n"),
    ("settings", "Settings", "mod+comma"),
    ("go-sessions", "Go to Deck", "alt+1"),
    ("go-board", "Go to Sessions", "alt+2"),
    ("go-stats", "Go to Stats", "alt+4"),
    ("go-digest", "Go to Digest", "alt+5"),
    ("go-memory", "Go to Memory", "alt+6"),
    ("go-github", "Go to GitHub", "alt+7"),
    ("toggle-sidebar", "Toggle session sidebar", "mod+b"),
    ("open-terminal", "Toggle terminal panel", "mod+j"),
    ("new-terminal", "New terminal", "mod+shift+j"),
    ("toggle-dock", "Toggle context panel", "mod+shift+d"),
    (
        "split-session",
        "Split with the most recent session",
        "mod+shift+s",
    ),
    ("focus-mode", "Toggle focus mode", "mod+shift+f"),
    ("theme-cycle", "Cycle theme", "mod+shift+t"),
    ("review-file", "Mark the current file reviewed", "v"),
];

pub fn default_of(id: &str) -> Option<Shortcut> {
    ACTIONS
        .iter()
        .find(|a| a.0 == id)
        .and_then(|a| a.2.parse().ok())
}

pub fn load(saved: &HashMap<String, String>) -> HashMap<&'static str, ShortcutRecorderState> {
    ACTIONS
        .iter()
        .map(|(id, _, _)| {
            let sc = saved
                .get(*id)
                .and_then(|s| s.parse().ok())
                .or_else(|| default_of(id));
            (*id, ShortcutRecorderState::new(sc))
        })
        .collect()
}

fn matches(sc: &Shortcut, ev: &KeyEvent, tx: &Tx) -> bool {
    let (want, m) = (sc.modifiers(), ev.mods);
    want.shift == m.shift
        && want.alt == m.alt
        && want.cmd == m.cmd
        && want.ctrl == m.ctrl
        && tx.physical_key() == Some(sc.physical_key())
}

impl Hooked {
    pub fn shortcut_hit(&self, ev: &KeyEvent, tx: &Tx) -> Option<&'static str> {
        ACTIONS.iter().map(|a| a.0).find(|id| {
            self.shortcuts
                .get(id)
                .and_then(|r| r.shortcut())
                .is_some_and(|sc| matches(sc, ev, tx))
        })
    }

    /// Runs `id`; false when it doesn't apply here, so the key goes on to the focused field.
    pub fn run_shortcut(&mut self, id: &str, tx: &mut Tx) -> bool {
        let session = self.page == Page::Session;
        match id {
            "command-palette" => {
                if self.palette_open {
                    self.palette_open = false;
                } else {
                    self.open_palette("");
                }
            }
            "commands-only" => self.open_palette(">"),
            "new-session" => self.go_new(None),
            "settings" => self.go(Page::Settings),
            "go-sessions" => self.go_deck(),
            "go-board" => self.open_sessions(),
            "go-stats" => self.go(Page::Stats),
            "go-digest" => self.go(Page::Digest),
            "go-memory" => self.go(Page::Memory),
            "go-github" => self.go(Page::GitHub),
            "toggle-sidebar" => self.toggle_sidebar(),
            "open-terminal" if session => self.toggle_terms(),
            "new-terminal" if session => {
                self.term.open = true;
                self.new_term();
            }
            "toggle-dock" => self.toggle_dock(),
            "split-session" => self.toggle_split(),
            "focus-mode" => self.focus = !self.focus,
            "theme-cycle" => self.cycle_theme(),
            "review-file" if session && self.lens == crate::app::Lens::Review => {
                let i = self.lens_data.diff.visible_file();
                self.toggle_reviewed(i, Some(tx));
            }
            _ => return false,
        }
        true
    }

    pub fn set_shortcut(&mut self, id: &'static str, sc: Option<&Shortcut>) {
        let saved: HashMap<String, String> = self
            .shortcuts
            .iter()
            .filter_map(|(k, r)| {
                let cur = r.shortcut().map(ToString::to_string);
                let default = default_of(k).map(|d| d.to_string());
                let value = if *k == id {
                    sc.map(ToString::to_string)
                } else {
                    cur
                };
                (value != default).then(|| (k.to_string(), value.unwrap_or_default()))
            })
            .collect();
        self.save_pref("shortcuts", &saved);
    }

    pub fn reset_shortcut(&mut self, id: &'static str) {
        self.shortcuts
            .insert(id, ShortcutRecorderState::new(default_of(id)));
        self.set_shortcut(id, default_of(id).as_ref());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_default_parses() {
        for (id, _, chord) in ACTIONS {
            assert!(chord.parse::<Shortcut>().is_ok(), "{id}: {chord}");
        }
    }
}
