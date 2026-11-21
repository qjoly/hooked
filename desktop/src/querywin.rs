use serde_json::{Value, json};

use crate::api;
use crate::app::Hooked;
use crate::fmt;

pub const REFRESH: [(u64, &str); 5] = [
    (0, "Off"),
    (10, "10s"),
    (30, "30s"),
    (60, "1m"),
    (300, "5m"),
];

#[derive(Default)]
pub struct QueryWin {
    pub spec: Option<Value>,
    pub data: Option<Value>,
    pub err: Option<String>,
    pub login: bool,
    pub loading: bool,
    pub updated: Option<i64>,
    pub refresh: u64,
    pub ran: i64,
    pub login_polled: i64,
}

/// Claude's absolute range becomes a range of the same length ending now, so a refresh slides it.
pub fn live_spec(tool: &str, input: &Value) -> Value {
    let mut s = input.clone();
    s["tool"] = json!(tool);
    let (a, b) = (
        input["start"].as_str().and_then(fmt::parse_ts),
        input["end"].as_str().and_then(fmt::parse_ts),
    );
    if let (Some(a), Some(b)) = (a, b)
        && b > a
        && let Some(o) = s.as_object_mut()
    {
        o.insert("range".into(), json!(format!("{}s", (b - a) / 1000)));
        o.remove("start");
        o.remove("end");
    }
    s
}

/// ```promql datasource=mimir-prod range=6h step=5m refresh=30 (same syntax as the web's `fenceQuery`).
pub fn fence_query(info: &str, code: &str) -> Option<Value> {
    let mut words = info.split_whitespace();
    let tool = match words.next()?.to_lowercase().as_str() {
        "promql" => "prometheus",
        "logql" => "loki",
        _ => return None,
    };
    let meta: std::collections::HashMap<&str, &str> = words
        .filter_map(|w| w.split_once('=').filter(|(k, _)| !k.is_empty()))
        .collect();
    let datasource = meta.get("datasource").or_else(|| meta.get("ds"))?;
    let query = code.trim();
    if datasource.is_empty() || query.is_empty() {
        return None;
    }
    let mut spec = json!({
        "tool": tool,
        "datasource": datasource,
        "query": query,
        "range": meta.get("range").copied().unwrap_or("1h"),
        "refresh": meta.get("refresh").and_then(|r| r.parse::<u64>().ok()).unwrap_or(30),
    });
    if let Some(step) = meta.get("step") {
        spec["step"] = json!(step);
    }
    if let Some(limit) = meta.get("limit").and_then(|l| l.parse::<u64>().ok()) {
        spec["limit"] = json!(limit);
    }
    Some(spec)
}

/// rune-kit hands a code frame only the info string's first word, so the options come from the
/// fence in the source whose body is `code`.
pub fn fence_info(markdown: &str, code: &str) -> Option<String> {
    use pulldown_cmark::{CodeBlockKind, Event, Parser, Tag, TagEnd};
    let mut cur: Option<(String, String)> = None;
    for ev in Parser::new(markdown) {
        match ev {
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) => {
                cur = Some((info.to_string(), String::new()));
            }
            Event::Text(t) => {
                if let Some((_, body)) = cur.as_mut() {
                    body.push_str(&t);
                }
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some((info, body)) = cur.take()
                    && body.trim() == code.trim()
                {
                    return Some(info);
                }
            }
            _ => {}
        }
    }
    None
}

pub fn is_query_tool(name: &str) -> bool {
    name.ends_with("__grafana_query_prometheus")
        || name.ends_with("__grafana_query_loki")
        || name == "mcp__hooked__show_query"
}

impl Hooked {
    /// The result of a query Claude ran, then live re-runs through mcp-gateway.
    pub fn open_query_result(&mut self, session: String, tool_id: String) {
        self.query_win = Some(QueryWin {
            refresh: 30,
            ..Default::default()
        });
        self.spawn(
            move || {
                api::get(&format!(
                    "/api/query-result?session={}&agent=&id={}",
                    api::enc(&session),
                    api::enc(&tool_id)
                ))
            },
            |s, r, _| {
                let Some(w) = s.query_win.as_mut() else {
                    return;
                };
                match r {
                    Ok(v) if v.get("error").is_none() => {
                        let tool = v["tool"].as_str().unwrap_or("").to_string();
                        w.spec = Some(live_spec(&tool, &v["input"]));
                        if v["data"].is_null() {
                            w.refresh = v["input"]["refresh"].as_u64().unwrap_or(30);
                            s.run_query();
                        } else {
                            w.data = Some(v["data"].clone());
                        }
                    }
                    Ok(v) => w.err = v["error"].as_str().map(str::to_string),
                    Err(e) => w.err = Some(e),
                }
            },
        );
    }

    pub fn open_query_spec(&mut self, spec: Value) {
        let refresh = spec["refresh"].as_u64().unwrap_or(30);
        self.query_win = Some(QueryWin {
            spec: Some(spec),
            refresh,
            ..Default::default()
        });
        self.run_query();
    }

    pub fn run_query(&mut self) {
        let Some(w) = self.query_win.as_mut() else {
            return;
        };
        let Some(spec) = w.spec.clone() else { return };
        if w.loading {
            return;
        }
        w.loading = true;
        w.ran = fmt::now_ms();
        self.spawn(
            move || api::post_any("/api/grafana/query", spec),
            |s, r, _| {
                let Some(w) = s.query_win.as_mut() else {
                    return;
                };
                w.loading = false;
                match r {
                    Ok(v) if v["login"] == true => {
                        w.login = true;
                        w.err = None;
                    }
                    Ok(v) if v.get("error").is_some() => {
                        w.err = v["error"].as_str().map(str::to_string);
                    }
                    Ok(v) => {
                        w.login = false;
                        w.err = None;
                        w.data = Some(v["data"].clone());
                        w.updated = Some(fmt::now_ms());
                    }
                    Err(e) => w.err = Some(e),
                }
            },
        );
    }

    pub fn query_login(&mut self) {
        self.spawn(
            || api::get("/api/grafana/login?proto=http"),
            |s, r, tx| match r.ok().and_then(|v| v["url"].as_str().map(str::to_string)) {
                Some(url) => {
                    let _ = tx.open_url(&url);
                    if let Some(w) = s.query_win.as_mut() {
                        w.login = true;
                        w.login_polled = fmt::now_ms();
                    }
                }
                None => s.flash("✗ Could not start the mcp-gateway sign-in", true),
            },
        );
    }

    /// Called from `poll`: auto refresh, and waiting for a sign-in to land.
    pub fn poll_query(&mut self, now: i64) {
        let Some(w) = self.query_win.as_ref() else {
            return;
        };
        if w.login && w.login_polled > 0 {
            if now - w.login_polled > 2000 {
                if let Some(w) = self.query_win.as_mut() {
                    w.login_polled = now;
                }
                self.spawn(
                    || api::get("/api/grafana/status"),
                    |s, r, _| {
                        if r.is_ok_and(|v| v["connected"] == true)
                            && let Some(w) = s.query_win.as_mut()
                        {
                            w.login = false;
                            s.run_query();
                        }
                    },
                );
            }
            return;
        }
        if !w.login && w.refresh > 0 && !w.loading && now - w.ran > (w.refresh * 1000) as i64 {
            self.run_query();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_ranges_become_sliding() {
        let s = live_spec(
            "prometheus",
            &json!({"query": "up", "start": "2026-11-10T10:00:00Z", "end": "2026-11-10T11:00:00Z"}),
        );
        assert_eq!(s["range"], "3600s");
        assert!(s.get("start").is_none());
        assert_eq!(s["tool"], "prometheus");
        assert!(is_query_tool("mcp__mcp-gateway__grafana_query_loki"));
    }

    #[test]
    fn query_fences_carry_their_options() {
        let md = "Look:\n\n```promql datasource=mimir-prod range=6h step=5m refresh=10\nsum(rate(x[5m]))\n```\n\n```promql\nup\n```\n";
        let info = fence_info(md, "sum(rate(x[5m]))\n").unwrap();
        let spec = fence_query(&info, "sum(rate(x[5m]))\n").unwrap();
        assert_eq!(spec["tool"], "prometheus");
        assert_eq!(spec["datasource"], "mimir-prod");
        assert_eq!(spec["query"], "sum(rate(x[5m]))");
        assert_eq!(spec["range"], "6h");
        assert_eq!(spec["step"], "5m");
        assert_eq!(spec["refresh"], 10);
        assert!(fence_query(&fence_info(md, "up").unwrap(), "up").is_none());
        let loki = fence_query("LogQL ds=loki-prod", "{app=\"x\"}").unwrap();
        assert_eq!(loki["tool"], "loki");
        assert_eq!(loki["range"], "1h");
        assert_eq!(loki["refresh"], 30);
        assert!(fence_query("sql datasource=x", "select 1").is_none());
    }
}
