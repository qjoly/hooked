use std::cell::RefCell;
use std::collections::HashMap;

use rune::{Player, PlayerState};

use crate::app::Hooked;

/// The players of the open conversation, by file path: clones share one player, so the view
/// gets the same clip back every frame and dropping the map stops them all.
#[derive(Default)]
pub struct Players(RefCell<HashMap<String, Player>>);

impl Players {
    pub fn get(&self, path: &str, audio: bool) -> Player {
        self.0
            .borrow_mut()
            .entry(path.to_string())
            .or_insert_with(|| {
                if audio {
                    Player::audio(path)
                } else {
                    Player::file(path)
                }
            })
            .clone()
    }

    fn find(&self, path: &str) -> Option<Player> {
        self.0.borrow().get(path).cloned()
    }

    /// What a frame of the clip at `path` shows, for memoised views to notice a change.
    pub fn look(&self, path: &str) -> Option<Look> {
        let p = self.find(path)?;
        Some((
            p.is_playing(),
            (p.time() * 4.0) as u64,
            p.duration().map(|d| (d * 4.0) as u64),
            p.muted(),
            p.natural_size(),
            failed(&p).is_some(),
        ))
    }

    pub fn any_playing(&self) -> bool {
        self.0.borrow().values().any(Player::is_playing)
    }

    pub fn clear(&self) {
        self.0.borrow_mut().clear();
    }
}

/// Playing, time and duration in quarter seconds, muted, natural size, failed.
pub type Look = (bool, u64, Option<u64>, bool, Option<(u32, u32)>, bool);

pub fn clock(seconds: f64) -> String {
    let s = seconds.max(0.0) as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

pub fn failed(p: &Player) -> Option<String> {
    match p.state() {
        PlayerState::Failed(e) => Some(e),
        _ => None,
    }
}

impl Hooked {
    pub fn toggle_play(&mut self, path: &str) {
        let Some(p) = self.players.find(path) else {
            return;
        };
        if p.is_playing() {
            p.pause();
        } else {
            p.play();
        }
    }

    pub fn seek_media(&mut self, path: &str, frac: f32) {
        if let Some(p) = self.players.find(path)
            && let Some(d) = p.duration()
        {
            p.seek(d * f64::from(frac.clamp(0.0, 1.0)));
        }
    }

    pub fn toggle_mute(&mut self, path: &str) {
        if let Some(p) = self.players.find(path) {
            p.set_muted(!p.muted());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clock_reads_minutes_and_seconds() {
        assert_eq!(clock(0.0), "0:00");
        assert_eq!(clock(75.4), "1:15");
        assert_eq!(clock(-3.0), "0:00");
    }
}
