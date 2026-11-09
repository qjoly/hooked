use std::time::{SystemTime, UNIX_EPOCH};

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
            link_label("https://github.com/LuccaSA/Infra.Charts/pull/123"),
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
