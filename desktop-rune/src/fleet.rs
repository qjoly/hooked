use std::collections::HashSet;
use std::f32::consts::PI;

use rune::TextEdit;

use crate::api::Session;
use crate::app::Hooked;
use crate::theme;

pub const FAMILIES: [(&str, &str, bool); 6] = [
    ("attention", "Action required", true),
    ("waiting", "Waiting for you", true),
    ("working", "Working", false),
    ("background", "Background", false),
    ("idle", "Paused", false),
    ("ended", "Ended", false),
];

pub const WHEEL: f32 = 172.0;
pub const GROUP_CAP: usize = 8;
pub const KIDS_CAP: usize = 3;

pub fn family(x: &Session) -> usize {
    if x.has_question || x.has_plan || x.state == "attention" {
        0
    } else if x.state == "working" {
        2
    } else if x.state == "background" {
        3
    } else if x.state == "waiting" {
        1
    } else if x.state == "ended" {
        5
    } else {
        4
    }
}

pub fn is_live(x: &Session) -> bool {
    matches!(
        x.state.as_str(),
        "working" | "background" | "waiting" | "attention"
    )
}

pub fn hues(dark: bool) -> [rune::Color; 6] {
    let s = theme::scheme(dark);
    [
        s.danger.0,
        s.warn.0,
        s.success.0,
        s.info.0,
        s.idle,
        s.border2,
    ]
}

fn hex(c: rune::Color) -> String {
    c.hex().chars().take(7).collect()
}

pub struct Segment {
    pub id: String,
    pub family: usize,
    pub start: f32,
    pub end: f32,
    pub quiet: bool,
}

impl Segment {
    fn pulled(&self) -> bool {
        FAMILIES[self.family].2 && !self.quiet
    }
}

/// Clockwise from 12 o'clock, by family then most recent first.
pub fn segments(list: &[(&Session, bool)]) -> Vec<Segment> {
    let mut v: Vec<(&Session, bool, usize)> =
        list.iter().map(|(s, q)| (*s, *q, family(s))).collect();
    v.sort_by(|a, b| {
        a.2.cmp(&b.2)
            .then_with(|| b.0.last_activity.cmp(&a.0.last_activity))
    });
    let n = v.len().max(1) as f32;
    v.into_iter()
        .enumerate()
        .map(|(i, (s, quiet, family))| Segment {
            id: s.id.clone(),
            family,
            start: i as f32 / n,
            end: (i + 1) as f32 / n,
            quiet,
        })
        .collect()
}

pub fn counts(segs: &[Segment]) -> [usize; 6] {
    let mut c = [0; 6];
    for g in segs {
        c[g.family] += 1;
    }
    c
}

fn arc(r: f32, a: f32, b: f32, gap: f32, color: &str, width: f32, opacity: f32) -> String {
    let circ = 2.0 * PI * r;
    let gap = gap * circ / 1000.0;
    format!(
        r#"<circle cx="100" cy="100" r="{r}" fill="none" transform="rotate(-90 100 100)" stroke="{color}" stroke-width="{width}" stroke-opacity="{opacity}" stroke-dasharray="{:.2} {:.2}" stroke-dashoffset="{:.2}"/>"#,
        ((b - a) * circ - gap).max(0.5),
        circ,
        -(a * circ + gap / 2.0),
    )
}

/// The web's `FleetWheel`: an inner ring with one arc per family, an outer ring with one segment
/// per session inside its family's arc, the ones that need you pulled out of the ring.
pub fn wheel_svg(segs: &[Segment], filter: Option<usize>, hot: Option<&str>, dark: bool) -> String {
    let hue = hues(dark).map(hex);
    let total = segs.len();
    let gap = if total > 1 {
        (250.0 / total as f32).min(7.0)
    } else {
        0.0
    };
    let dim = |f: usize| filter.is_some_and(|x| x != f);
    let mut out = String::from(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">"#);
    if total == 0 {
        out.push_str(&format!(
            r#"<circle cx="100" cy="100" r="80" fill="none" stroke="{}" stroke-width="14" stroke-dasharray="4 6"/>"#,
            hue[5]
        ));
    }
    for (f, h) in hue.iter().enumerate() {
        let members: Vec<&Segment> = segs.iter().filter(|g| g.family == f).collect();
        if let (Some(a), Some(b)) = (members.first(), members.last()) {
            let op = if dim(f) { 0.14 } else { 0.55 };
            out.push_str(&arc(60.0, a.start, b.end, gap, h, 9.0, op));
        }
    }
    for g in segs {
        let r = if g.pulled() { 85.0 } else { 79.0 };
        let is_hot = hot == Some(g.id.as_str());
        let op = if dim(g.family) {
            0.14
        } else if g.quiet {
            0.4
        } else {
            1.0
        };
        out.push_str(&arc(
            r,
            g.start,
            g.end,
            gap,
            &hue[g.family],
            if is_hot { 19.0 } else { 14.0 },
            op,
        ));
    }
    out.push_str("</svg>");
    out
}

/// The segment under a point of a wheel drawn `size` points wide.
pub fn segment_at(segs: &[Segment], x: f32, y: f32, size: f32) -> Option<usize> {
    let k = 200.0 / size;
    let (dx, dy) = (x * k - 100.0, y * k - 100.0);
    let r = (dx * dx + dy * dy).sqrt();
    if !(70.0..=94.0).contains(&r) {
        return None;
    }
    let t = (dx.atan2(-dy) / (2.0 * PI)).rem_euclid(1.0);
    segs.iter().position(|g| t >= g.start && t < g.end)
}

pub struct Fleet {
    pub q: TextEdit,
    pub state: Option<usize>,
    pub grid: bool,
    pub expanded: HashSet<String>,
    pub kids: HashSet<String>,
    pub archived_open: bool,
    pub hover: Option<String>,
}

impl Fleet {
    pub fn new(grid: bool) -> Self {
        Self {
            q: TextEdit::new(""),
            state: None,
            grid,
            expanded: HashSet::new(),
            kids: HashSet::new(),
            archived_open: false,
            hover: None,
        }
    }
}

pub fn repo_key(x: &Session) -> String {
    x.repo
        .clone()
        .or_else(|| x.project_name.clone())
        .unwrap_or_else(|| "—".into())
}

impl Hooked {
    pub fn fleet_matches(&self, x: &Session) -> bool {
        if self.fleet.state.is_some_and(|f| f != family(x)) {
            return false;
        }
        let q = self.fleet.q.text.trim().to_lowercase();
        if q.is_empty() {
            return true;
        }
        let hay = format!(
            "{} {} {} {} {} {}",
            x.repo.as_deref().unwrap_or(""),
            x.project_name.as_deref().unwrap_or(""),
            self.title_of(x),
            x.last_prompt.as_deref().unwrap_or(""),
            x.git_branch.as_deref().unwrap_or(""),
            self.session_tags(&x.id).join(" ")
        )
        .to_lowercase();
        hay.contains(&q)
    }

    pub fn set_fleet_grid(&mut self, grid: bool) {
        self.fleet.grid = grid;
        self.save_pref("deckView", &if grid { "grid" } else { "list" });
    }

    pub fn toggle_fleet_state(&mut self, f: usize) {
        self.fleet.state = if self.fleet.state == Some(f) {
            None
        } else {
            Some(f)
        };
    }

    pub fn clear_fleet_filter(&mut self) {
        self.fleet.state = None;
        self.fleet.q = TextEdit::new("");
    }

    pub fn is_group_archived(&self, mother: &str) -> bool {
        self.group_members(mother).iter().all(|id| {
            self.sessions
                .iter()
                .find(|s| s.id == *id)
                .is_none_or(|s| self.is_archived(s))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(id: &str, family: usize, start: f32, end: f32) -> Segment {
        Segment {
            id: id.into(),
            family,
            start,
            end,
            quiet: false,
        }
    }

    #[test]
    fn finds_the_segment_under_the_pointer() {
        let segs = [seg("a", 0, 0.0, 0.25), seg("b", 2, 0.25, 1.0)];
        assert_eq!(segment_at(&segs, 100.0, 18.0, 200.0), Some(0));
        assert_eq!(segment_at(&segs, 182.0, 100.0, 200.0), Some(1));
        assert_eq!(segment_at(&segs, 100.0, 100.0, 200.0), None);
    }

    #[test]
    fn the_wheel_has_one_family_arc_and_one_segment_each() {
        let segs = [seg("a", 0, 0.0, 0.5), seg("b", 0, 0.5, 1.0)];
        let s = wheel_svg(&segs, None, None, true);
        assert_eq!(s.matches("<circle").count(), 3);
        assert!(s.contains(r#"r="85""#));
    }
}
