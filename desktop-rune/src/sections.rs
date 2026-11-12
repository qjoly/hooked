use crate::api::{self, Session};
use crate::app::Hooked;
use crate::fmt;
use crate::organize::Unit;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Section {
    Waiting,
    Working,
    Idle,
    Snoozed,
    Archived,
}

impl Section {
    pub const ALL: [Section; 5] = [
        Section::Waiting,
        Section::Working,
        Section::Idle,
        Section::Snoozed,
        Section::Archived,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Section::Waiting => "Waiting",
            Section::Working => "Working",
            Section::Idle => "Idle",
            Section::Snoozed => "Snoozed",
            Section::Archived => "Archived",
        }
    }

    pub fn folded_by_default(self) -> bool {
        self != Section::Waiting
    }

    pub fn docked(self) -> bool {
        matches!(self, Section::Snoozed | Section::Archived)
    }

    pub fn window(self) -> Option<usize> {
        match self {
            Section::Idle => Some(15),
            Section::Archived => Some(25),
            _ => None,
        }
    }
}

pub fn section_of(
    members: &[&Session],
    archived: impl Fn(&Session) -> bool,
    snoozed: impl Fn(&Session) -> bool,
) -> Section {
    if members.iter().all(|s| archived(s)) {
        return Section::Archived;
    }
    let awake: Vec<&Session> = members
        .iter()
        .copied()
        .filter(|s| !archived(s) && !snoozed(s))
        .collect();
    if awake.is_empty() {
        Section::Snoozed
    } else if awake.iter().any(|s| s.needs_you()) {
        Section::Waiting
    } else if awake
        .iter()
        .any(|s| s.state == "working" || s.state == "background")
    {
        Section::Working
    } else {
        Section::Idle
    }
}

fn local(ms: i64) -> libc::tm {
    let t = (ms / 1000) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&t, &mut tm) };
    tm
}

fn at(base: i64, days: i32, hour: i32) -> i64 {
    let mut tm = local(base);
    tm.tm_mday += days;
    tm.tm_hour = hour;
    tm.tm_min = 0;
    tm.tm_sec = 0;
    tm.tm_isdst = -1;
    unsafe { libc::mktime(&mut tm) as i64 * 1000 }
}

pub fn snooze_presets(now: i64) -> Vec<(&'static str, i64)> {
    let to_monday = match (8 - local(now).tm_wday) % 7 {
        0 => 7,
        d => d,
    };
    let mut out = vec![
        ("1 hour", now + 3_600_000),
        ("3 hours", now + 3 * 3_600_000),
    ];
    let evening = at(now, 0, 18);
    if evening - now > 3 * 3_600_000 {
        out.push(("This evening", evening));
    }
    out.push(("Tomorrow", at(now, 1, 9)));
    if to_monday > 1 {
        out.push(("Monday", at(now, to_monday, 9)));
    }
    out
}

pub fn clock(ms: i64) -> String {
    let tm = local(ms);
    format!("{}:{:02}", tm.tm_hour, tm.tm_min)
}

pub fn wake_label(until: i64, now: i64) -> String {
    const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let days = ((at(until, 0, 0) - at(now, 0, 0)) as f64 / 86_400_000.0).round() as i64;
    let tm = local(until);
    match days {
        ..=0 => clock(until),
        1 => format!("tmrw {}", clock(until)),
        2..=6 => format!("{} {}", WEEKDAYS[tm.tm_wday as usize], clock(until)),
        _ => format!("{}/{}", tm.tm_mday, tm.tm_mon + 1),
    }
}

impl Hooked {
    pub fn snoozed_until(&self, id: &str) -> Option<i64> {
        self.meta
            .get(id)
            .and_then(|m| m.snooze_until)
            .map(|t| t as i64)
            .filter(|t| *t > self.now)
    }

    pub fn by_status(&self) -> bool {
        self.layout == "status"
    }

    pub fn status_sections<'a>(
        &self,
        live: &[&'a Session],
        archived: &[&'a Session],
    ) -> Vec<(Section, Vec<Unit<'a>>)> {
        let mut buckets: Vec<(Section, Vec<Unit<'a>>)> =
            Section::ALL.iter().map(|x| (*x, Vec::new())).collect();
        let mut push = |sec: Section, u: Unit<'a>| {
            if let Some((_, v)) = buckets.iter_mut().find(|(x, _)| *x == sec) {
                v.push(u);
            }
        };
        for u in self.units(live) {
            let members: Vec<&Session> = std::iter::once(u.mother)
                .chain(u.children.iter().copied())
                .collect();
            let sec = section_of(
                &members,
                |x| self.is_archived(x),
                |x| self.snoozed_until(&x.id).is_some(),
            );
            push(sec, u);
        }
        for u in self.units(archived) {
            push(Section::Archived, u);
        }
        let wake = |u: &Unit| {
            std::iter::once(u.mother)
                .chain(u.children.iter().copied())
                .filter_map(|x| self.snoozed_until(&x.id))
                .min()
                .unwrap_or(i64::MAX)
        };
        if let Some((_, v)) = buckets.iter_mut().find(|(x, _)| *x == Section::Snoozed) {
            v.sort_by_key(|u| wake(u));
        }
        buckets.retain(|(_, v)| !v.is_empty());
        buckets
    }

    pub fn section_collapsed(&self, sec: Section) -> bool {
        sec.folded_by_default() != self.flipped_sections.contains(sec.label())
    }

    pub fn toggle_section(&mut self, sec: Section) {
        if !self.flipped_sections.remove(sec.label()) {
            self.flipped_sections.insert(sec.label());
        }
    }

    pub fn snooze_until(&mut self, ids: Vec<String>, until: i64) {
        for id in &ids {
            self.meta.entry(id.clone()).or_default().snooze_until = Some(until as f64);
        }
        self.now = fmt::now_ms();
        let label = wake_label(until, self.now);
        self.spawn(
            move || {
                ids.iter().try_for_each(|id| {
                    api::patch_meta(id, serde_json::json!({ "snoozeUntil": until }))
                })
            },
            move |s, r, _| match r {
                Ok(()) => s.flash(format!("✓ Snoozed until {label}"), false),
                Err(e) => s.flash(format!("✗ Snooze: {e}"), true),
            },
        );
    }

    pub fn wake(&mut self, id: &str) {
        if self.snoozed_until(id).is_none() {
            return;
        }
        if let Some(m) = self.meta.get_mut(id) {
            m.snooze_until = None;
        }
        let id = id.to_string();
        self.spawn(
            move || api::patch_meta(&id, serde_json::json!({ "snoozeUntil": null })),
            |s, r, _| {
                if let Err(e) = r {
                    s.flash(format!("✗ Wake: {e}"), true);
                }
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(id: &str, state: &str) -> Session {
        Session {
            id: id.into(),
            state: state.into(),
            ..Default::default()
        }
    }

    fn sec(members: &[&Session], archived: &[&str], snoozed: &[&str]) -> Section {
        section_of(
            members,
            |x| archived.contains(&x.id.as_str()),
            |x| snoozed.contains(&x.id.as_str()),
        )
    }

    fn local_ms(y: i32, mo: i32, d: i32, h: i32, mi: i32) -> i64 {
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        tm.tm_year = y - 1900;
        tm.tm_mon = mo - 1;
        tm.tm_mday = d;
        tm.tm_hour = h;
        tm.tm_min = mi;
        tm.tm_isdst = -1;
        unsafe { libc::mktime(&mut tm) as i64 * 1000 }
    }

    #[test]
    fn a_lone_session_goes_by_its_state() {
        let q = Session {
            has_question: true,
            ..s("q", "idle")
        };
        assert_eq!(sec(&[&s("a", "attention")], &[], &[]), Section::Waiting);
        assert_eq!(sec(&[&s("a", "waiting")], &[], &[]), Section::Waiting);
        assert_eq!(sec(&[&q], &[], &[]), Section::Waiting);
        assert_eq!(sec(&[&s("a", "working")], &[], &[]), Section::Working);
        assert_eq!(sec(&[&s("a", "background")], &[], &[]), Section::Working);
        assert_eq!(sec(&[&s("a", "idle")], &[], &[]), Section::Idle);
        assert_eq!(sec(&[&s("a", "ended")], &[], &[]), Section::Idle);
    }

    #[test]
    fn archive_beats_snooze_and_snooze_beats_a_decision() {
        let a = s("a", "attention");
        assert_eq!(sec(&[&a], &["a"], &["a"]), Section::Archived);
        assert_eq!(sec(&[&a], &[], &["a"]), Section::Snoozed);
    }

    #[test]
    fn a_group_follows_its_most_pressing_awake_member() {
        let (m, c1, c2) = (s("m", "idle"), s("c1", "working"), s("c2", "waiting"));
        let g = [&m, &c1, &c2];
        assert_eq!(sec(&g, &[], &[]), Section::Waiting);
        assert_eq!(sec(&g, &[], &["c2"]), Section::Working);
        assert_eq!(sec(&g, &["c1", "c2"], &[]), Section::Idle);
        assert_eq!(sec(&g, &["c1"], &["m", "c2"]), Section::Snoozed);
    }

    #[test]
    fn presets_on_a_wednesday_morning() {
        let now = local_ms(2026, 11, 11, 10, 0);
        let p = snooze_presets(now);
        let labels: Vec<_> = p.iter().map(|x| x.0).collect();
        assert_eq!(
            labels,
            ["1 hour", "3 hours", "This evening", "Tomorrow", "Monday"]
        );
        assert_eq!(p[2].1, local_ms(2026, 11, 11, 18, 0));
        assert_eq!(p[3].1, local_ms(2026, 11, 12, 9, 0));
        assert_eq!(p[4].1, local_ms(2026, 11, 16, 9, 0));
    }

    #[test]
    fn presets_drop_a_close_evening_and_a_monday_that_is_tomorrow() {
        let sunday = local_ms(2026, 11, 15, 16, 0);
        let labels: Vec<_> = snooze_presets(sunday).iter().map(|x| x.0).collect();
        assert_eq!(labels, ["1 hour", "3 hours", "Tomorrow"]);
        let monday = local_ms(2026, 11, 16, 8, 0);
        let next = snooze_presets(monday).into_iter().find(|x| x.0 == "Monday");
        assert_eq!(next.map(|x| x.1), Some(local_ms(2026, 11, 23, 9, 0)));
    }

    #[test]
    fn wake_labels_read_as_clock_tomorrow_weekday_then_date() {
        let now = local_ms(2026, 11, 11, 10, 0);
        assert_eq!(wake_label(local_ms(2026, 11, 11, 14, 5), now), "14:05");
        assert_eq!(wake_label(local_ms(2026, 11, 12, 9, 0), now), "tmrw 9:00");
        assert_eq!(wake_label(local_ms(2026, 11, 16, 9, 0), now), "Mon 9:00");
        assert_eq!(wake_label(local_ms(2026, 11, 25, 9, 0), now), "25/11");
    }
}
