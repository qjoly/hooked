//! The web's `src/lib/cron.js`, so the schedule preview agrees with the server's scheduler:
//! five fields in local time, Vixie day-of-month / day-of-week OR rule.

use std::collections::BTreeSet;

pub struct Cron {
    minute: BTreeSet<i32>,
    hour: BTreeSet<i32>,
    dom: BTreeSet<i32>,
    month: BTreeSet<i32>,
    dow: BTreeSet<i32>,
    dom_any: bool,
    dow_any: bool,
}

const FIELDS: [(&str, i32, i32); 5] = [
    ("minute", 0, 59),
    ("hour", 0, 23),
    ("day of month", 1, 31),
    ("month", 1, 12),
    ("day of week", 0, 7),
];

fn alias(s: &str) -> &str {
    match s {
        "@hourly" => "0 * * * *",
        "@daily" | "@midnight" => "0 0 * * *",
        "@weekly" => "0 0 * * 0",
        "@monthly" => "0 0 1 * *",
        "@yearly" | "@annually" => "0 0 1 1 *",
        other => other,
    }
}

fn field(src: &str, (name, min, max): (&str, i32, i32)) -> Result<BTreeSet<i32>, String> {
    let mut out = BTreeSet::new();
    for part in src.split(',') {
        let bad = || format!("invalid {name}: \"{part}\"");
        let (range, step) = match part.split_once('/') {
            Some((r, s)) => (r, Some(s.parse::<i32>().map_err(|_| bad())?)),
            None => (part, None),
        };
        let (lo, hi) = if range == "*" {
            (min, max)
        } else {
            match range.split_once('-') {
                Some((a, b)) => (a.parse().map_err(|_| bad())?, b.parse().map_err(|_| bad())?),
                None => {
                    let v: i32 = range.parse().map_err(|_| bad())?;
                    (v, if step.is_some() { max } else { v })
                }
            }
        };
        let step = step.unwrap_or(1);
        if lo < min || hi > max || lo > hi || step < 1 {
            return Err(format!("{name} out of range: \"{part}\""));
        }
        out.extend((lo..=hi).step_by(step as usize));
    }
    Ok(out)
}

pub fn parse(expr: &str) -> Result<Cron, String> {
    let src = expr.trim().to_lowercase();
    let parts: Vec<&str> = alias(&src).split_whitespace().collect();
    if parts.len() != 5 {
        return Err("expected 5 fields: minute hour day-of-month month day-of-week".into());
    }
    let mut f = Vec::new();
    for (p, spec) in parts.iter().zip(FIELDS) {
        f.push(field(p, spec)?);
    }
    let mut dow = f.pop().unwrap_or_default();
    if dow.remove(&7) {
        dow.insert(0);
    }
    let month = f.pop().unwrap_or_default();
    let dom = f.pop().unwrap_or_default();
    let hour = f.pop().unwrap_or_default();
    let minute = f.pop().unwrap_or_default();
    Ok(Cron {
        minute,
        hour,
        dom,
        month,
        dow,
        dom_any: parts[2] == "*",
        dow_any: parts[4] == "*",
    })
}

fn local(secs: i64) -> libc::tm {
    let t = secs as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&t, &mut tm) };
    tm
}

fn normalize(tm: &mut libc::tm) -> i64 {
    tm.tm_isdst = -1;
    unsafe { libc::mktime(tm) as i64 }
}

impl Cron {
    fn day_matches(&self, tm: &libc::tm) -> bool {
        let dom = self.dom.contains(&tm.tm_mday);
        let dow = self.dow.contains(&tm.tm_wday);
        if self.dom_any || self.dow_any {
            dom && dow
        } else {
            dom || dow
        }
    }

    /// The first matching minute after `from_ms`, as JavaScript's `nextRun` walks it.
    pub fn next(&self, from_ms: i64) -> Option<i64> {
        let mut tm = local(from_ms.div_euclid(1000));
        tm.tm_sec = 0;
        tm.tm_min += 1;
        let mut t = normalize(&mut tm);
        let limit = t + 5 * 366 * 86_400;
        while t < limit {
            if !self.month.contains(&(tm.tm_mon + 1)) {
                tm.tm_mon += 1;
                tm.tm_mday = 1;
                tm.tm_hour = 0;
                tm.tm_min = 0;
            } else if !self.day_matches(&tm) {
                tm.tm_mday += 1;
                tm.tm_hour = 0;
                tm.tm_min = 0;
            } else if !self.hour.contains(&tm.tm_hour) {
                tm.tm_hour += 1;
                tm.tm_min = 0;
            } else if !self.minute.contains(&tm.tm_min) {
                tm.tm_min += 1;
            } else {
                return Some(t * 1000);
            }
            t = normalize(&mut tm);
        }
        None
    }
}

pub fn next_runs(expr: &str, count: usize, from_ms: i64) -> Result<Vec<i64>, String> {
    let c = parse(expr)?;
    let mut out = Vec::new();
    let mut t = from_ms;
    while out.len() < count {
        let Some(n) = c.next(t) else { break };
        out.push(n);
        t = n;
    }
    Ok(out)
}

/// "Tue 10 Nov 17:00", in local time.
pub fn stamp(ms: i64) -> String {
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let tm = local(ms.div_euclid(1000));
    format!(
        "{} {} {} {:02}:{:02}",
        DAYS[tm.tm_wday.clamp(0, 6) as usize],
        tm.tm_mday,
        MONTHS[tm.tm_mon.clamp(0, 11) as usize],
        tm.tm_hour,
        tm.tm_min
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedules_parse_like_the_web() {
        assert!(parse("0 17 * * 1-5").is_ok());
        assert!(parse("@daily").is_ok());
        assert!(parse("*/15 * * * *").is_ok());
        assert_eq!(
            parse("61 * * * *").err().unwrap(),
            "minute out of range: \"61\""
        );
        assert!(parse("* * *").is_err());
    }

    #[test]
    fn next_runs_land_on_the_schedule() {
        let runs = next_runs("30 9 * * *", 2, 0).unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[1] - runs[0], 86_400_000);
        let tm = local(runs[0] / 1000);
        assert_eq!((tm.tm_hour, tm.tm_min), (9, 30));
    }
}
