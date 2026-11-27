use std::time::{SystemTime, UNIX_EPOCH};

/// `Mon 3 Dec 09:00`, in local time.
pub fn stamp(ms: i64) -> String {
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let t = ms.div_euclid(1000) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&t, &mut tm) };
    format!(
        "{} {} {} {:02}:{:02}",
        DAYS[tm.tm_wday.clamp(0, 6) as usize],
        tm.tm_mday,
        MONTHS[tm.tm_mon.clamp(0, 11) as usize],
        tm.tm_hour,
        tm.tm_min
    )
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn parse_ts(ts: &str) -> Option<i64> {
    let b = ts.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |r: std::ops::Range<usize>| ts.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let ms = if b.get(19) == Some(&b'.') {
        let digits: String = ts[20..]
            .chars()
            .take_while(char::is_ascii_digit)
            .take(3)
            .collect();
        format!("{digits:0<3}").parse::<i64>().unwrap_or(0)
    } else {
        0
    };
    let days = days_from_civil(y, mo, d);
    Some(((days * 24 + h) * 60 + mi) * 60_000 + s * 1000 + ms)
}

/// `YYYY-MM-DD` moved by `delta` days.
pub fn shift_date(date: &str, delta: i64) -> Option<String> {
    let num = |r: std::ops::Range<usize>| date.get(r)?.parse::<i64>().ok();
    if date.len() != 10 {
        return None;
    }
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let z = days_from_civil(y, m, d) + delta + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    Some(format!("{year:04}-{month:02}-{day:02}"))
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn span(ms: i64, sep: &str) -> String {
    let s = ms.max(0) / 1000;
    if s < 60 {
        format!("{s}s")
    } else if s < 3600 {
        format!("{}{sep}min", s / 60)
    } else if s < 86_400 {
        format!("{}{sep}h", s / 3600)
    } else {
        format!("{}{sep}d", s / 86_400)
    }
}

pub fn ago_short(ts: Option<&str>, now: i64) -> String {
    match ts.and_then(parse_ts) {
        None => "—".into(),
        Some(t) if now - t < 10_000 => "now".into(),
        Some(t) => span(now - t, ""),
    }
}

pub fn age_ms(ts: Option<&str>, now: i64) -> Option<i64> {
    ts.and_then(parse_ts).map(|t| now - t)
}

pub fn cost(c: Option<f64>) -> String {
    let c = c.unwrap_or(0.0);
    if c >= 100.0 {
        format!("${c:.0}")
    } else {
        format!("${c:.2}")
    }
}

pub fn short_model(m: &str) -> String {
    m.strip_prefix("claude-").unwrap_or(m).to_string()
}

/// Label of a model in a provider's picker. The catalogue gives a display `label` and the
/// `alias` sent to the server (`provider/id` for pi): the alias is only worth repeating when it
/// says more than the label (not when it is the label, or the label behind a provider prefix).
pub fn model_choice_label(label: Option<&str>, alias: &str) -> String {
    match label.filter(|l| !l.is_empty()) {
        None => alias.to_string(),
        Some(l) if l == alias || alias.strip_suffix(l).is_some_and(|p| p.ends_with('/')) => l.to_string(),
        Some(l) => format!("{l} · {alias}"),
    }
}

/// Display name of the agent behind a session's provider ('claude' by default): the provider's
/// label from the server's settings (cf. api::provider_info).
pub fn agent_label(provider: Option<&str>) -> String {
    crate::api::provider_info(provider).label
}

/// state_label provider-aware : seul « working » nomme l'agent.
pub fn state_label_for(state: &str, provider: Option<&str>) -> String {
    if state == "working" {
        return format!("{} is working", agent_label(provider));
    }
    state_label(state).to_string()
}

pub fn state_label(state: &str) -> &'static str {
    match state {
        "working" => "Claude is working",
        "waiting" => "Waiting for you",
        "attention" => "Action required",
        "background" => "Running in background",
        "idle" => "Paused",
        "ended" => "Ended",
        "past" => "Past",
        _ => "Unknown",
    }
}

pub const LIVE_MODES: [&str; 3] = ["default", "auto", "plan"];
pub const LAUNCH_MODES: [&str; 5] = [
    "default",
    "acceptEdits",
    "auto",
    "plan",
    "bypassPermissions",
];

pub fn mode_label(m: &str) -> &'static str {
    match m {
        "default" => "Normal",
        "acceptEdits" => "Accept edits",
        "auto" => "Auto",
        "plan" => "Plan",
        "bypassPermissions" => "Bypass",
        "dontAsk" => "Don't ask",
        _ => "Normal",
    }
}

const COLD_MS: i64 = 24 * 3600 * 1000;

/// An ended session leaves the active list only once nothing has happened for a day.
pub fn finished_and_cold(state: &str, seen: Option<&str>, now: i64) -> bool {
    if state != "ended" && state != "past" {
        return false;
    }
    match seen.and_then(parse_ts) {
        None => true,
        Some(t) => now - t > COLD_MS,
    }
}

pub fn cache_left(last_request_at: Option<&str>, ttl: Option<&str>, now: i64) -> Option<i64> {
    let t = last_request_at.and_then(parse_ts)?;
    let ttl_ms = match ttl.unwrap_or("5m") {
        "1h" => 3_600_000,
        _ => 300_000,
    };
    let left = t + ttl_ms - now;
    (left > 0).then_some(left)
}

pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' {
            match it.peek() {
                Some('[') => {
                    it.next();
                    for c in it.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    it.next();
                    while let Some(c) = it.next() {
                        if c == '\u{7}' || (c == '\u{1b}' && it.peek() == Some(&'\\')) {
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else if c == '\r' {
            if it.peek() != Some(&'\n') {
                out.push('\n');
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Output read while it is being written, as a terminal shows it: a progress bar repaints its
/// line after a bare `\r`, so only what follows the last one is kept. A `\r` with nothing after
/// it changes nothing: it is either a CRLF line end or a repaint that has not arrived yet, and
/// blanking the line until then would make it flicker.
pub fn live_log_text(raw: &str) -> String {
    raw.split('\n')
        .map(|line| {
            let line = line.trim_end_matches('\r');
            line.rsplit('\r').next().unwrap_or(line)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Drops the start of `s` so it holds at most `max` bytes, cutting on a character boundary.
pub fn keep_tail(s: &mut String, max: usize) {
    if s.len() > max {
        let mut cut = s.len() - max;
        while !s.is_char_boundary(cut) {
            cut += 1;
        }
        s.drain(..cut);
    }
}

/// The last `n` lines of `s`.
pub fn last_lines(s: &str, n: usize) -> String {
    let tail: Vec<&str> = s.lines().rev().take(n).collect();
    tail.into_iter().rev().collect::<Vec<_>>().join("\n")
}

pub fn first_line(s: &str, max: usize) -> String {
    let line = s
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    if line.chars().count() > max {
        let cut: String = line.chars().take(max).collect();
        format!("{cut}…")
    } else {
        line.to_string()
    }
}

fn unlink(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        let Some(close) = after.find("](") else {
            break;
        };
        let Some(end) = after[close + 2..].find(')') else {
            break;
        };
        out.push_str(&rest[..open]);
        out.push_str(&after[..close]);
        rest = &after[close + 2 + end + 1..];
    }
    out.push_str(rest);
    out
}

pub fn plain(s: &str, max: usize) -> String {
    let s = &unlink(s);
    let flat: String = s
        .lines()
        .map(|l| {
            l.trim()
                .trim_start_matches('#')
                .trim_start_matches('>')
                .trim()
        })
        .filter(|l| !l.is_empty() && !l.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')))
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned: String = flat
        .replace("**", "")
        .replace('`', "")
        .replace(" | ", " · ")
        .replace('|', "");
    first_line(&cleaned, max)
}

/// "repo #12" for a GitHub link, "repo !12" for a GitLab merge request, as the web's `prLabel`.
pub fn link_label(url: &str) -> String {
    let segs: Vec<&str> = url.split('/').collect();
    if let Some(i) = segs.iter().position(|s| s.ends_with("github.com"))
        && let (Some(repo), Some(kind), Some(n)) =
            (segs.get(i + 2), segs.get(i + 3), segs.get(i + 4))
        && matches!(*kind, "pull" | "issues")
    {
        return format!("{repo} #{n}");
    }
    if let Some(i) = segs.iter().position(|s| *s == "-")
        && i > 0
        && let (Some(kind), Some(n)) = (segs.get(i + 1), segs.get(i + 2))
    {
        let sigil = match *kind {
            "merge_requests" => "!",
            "issues" | "work_items" => "#",
            _ => return url.to_string(),
        };
        return format!("{} {sigil}{n}", segs[i - 1]);
    }
    url.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_choice_label_drops_a_redundant_alias() {
        assert_eq!(model_choice_label(Some("devstral-latest"), "mistral/devstral-latest"), "devstral-latest");
        assert_eq!(model_choice_label(Some("smart"), "smart"), "smart");
        assert_eq!(model_choice_label(Some("Mistral Large"), "mistral/mistral-large-latest"), "Mistral Large · mistral/mistral-large-latest");
        assert_eq!(model_choice_label(None, "x/y"), "x/y");
        assert_eq!(model_choice_label(Some("y"), "x/zy"), "y · x/zy");
    }

    #[test]
    fn logs_lose_their_escapes() {
        assert_eq!(
            strip_ansi("\u{1b}[1;32mok\u{1b}[0m 50%\r80%\r\n\u{1b}]0;title\u{7}done"),
            "ok 50%\n80%\ndone"
        );
    }

    #[test]
    fn a_live_log_keeps_the_last_repaint_of_a_line() {
        assert_eq!(live_log_text("line 1\nline 2\n"), "line 1\nline 2\n");
        assert_eq!(live_log_text("a\r\nb\r\n"), "a\nb\n");
        assert_eq!(
            live_log_text("start\n 10%\r 50%\r100%\ndone\n"),
            "start\n100%\ndone\n"
        );
        // A chunk often ends right on the `\r`, before the repaint.
        assert_eq!(live_log_text("downloading 40%\r"), "downloading 40%");
        assert_eq!(live_log_text(""), "");
    }

    #[test]
    fn a_tail_is_cut_on_a_character_boundary() {
        let mut s = "aé€b".to_string();
        keep_tail(&mut s, 4);
        assert_eq!(s, "€b");
        let mut short = "ok".to_string();
        keep_tail(&mut short, 4);
        assert_eq!(short, "ok");
        assert_eq!(last_lines("1\n2\n3\n", 2), "2\n3");
        assert_eq!(last_lines("", 2), "");
    }

    #[test]
    fn dates_shift_across_months() {
        assert_eq!(shift_date("2026-03-01", -1).as_deref(), Some("2026-02-28"));
        assert_eq!(shift_date("2024-12-31", 1).as_deref(), Some("2025-01-01"));
        assert_eq!(shift_date("nope", 1), None);
    }

    #[test]
    fn plain_keeps_link_text() {
        assert_eq!(
            plain(
                "pushed to [#2178](https://github.com/x/y/pull/2178). Done [a]",
                200
            ),
            "pushed to #2178. Done [a]"
        );
    }

    #[test]
    fn links_name_their_repo() {
        assert_eq!(
            link_label("https://github.com/acme/Infra.Charts/pull/123"),
            "Infra.Charts #123"
        );
        assert_eq!(
            link_label("https://github.com/qjoly/hooked/issues/7"),
            "hooked #7"
        );
        assert_eq!(
            link_label("https://gitlab.com/grp/sub/proj/-/merge_requests/4"),
            "proj !4"
        );
        assert_eq!(link_label("https://example.com/x"), "https://example.com/x");
    }

    #[test]
    fn parses_iso_timestamps() {
        assert_eq!(parse_ts("1970-01-01T00:00:01.500Z"), Some(1500));
        assert_eq!(
            parse_ts("2026-11-08T10:35:08.569Z"),
            Some(1_794_134_108_569)
        );
        assert_eq!(parse_ts("nope"), None);
    }

    #[test]
    fn plain_strips_markdown() {
        assert_eq!(
            plain("## Title\n**bold** and `code`\n|---|---|", 80),
            "Title bold and code"
        );
    }

    #[test]
    fn spans_use_the_coarsest_unit() {
        assert_eq!(span(5_000, ""), "5s");
        assert_eq!(span(125_000, " "), "2 min");
        assert_eq!(span(7_200_000, ""), "2h");
        assert_eq!(span(3 * 86_400_000, ""), "3d");
    }

    #[test]
    fn ended_sessions_go_cold_after_a_day() {
        let now = parse_ts("2026-11-08T12:00:00Z").unwrap();
        assert!(!finished_and_cold(
            "ended",
            Some("2026-11-08T00:00:00Z"),
            now
        ));
        assert!(finished_and_cold(
            "ended",
            Some("2026-11-06T00:00:00Z"),
            now
        ));
        assert!(!finished_and_cold(
            "idle",
            Some("2026-11-01T00:00:00Z"),
            now
        ));
    }

    #[test]
    fn cache_left_counts_down_from_the_ttl() {
        let now = parse_ts("2026-11-08T12:10:00Z").unwrap();
        assert_eq!(
            cache_left(Some("2026-11-08T12:00:00Z"), Some("1h"), now),
            Some(50 * 60_000)
        );
        assert_eq!(
            cache_left(Some("2026-11-08T12:00:00Z"), Some("5m"), now),
            None
        );
    }
}
