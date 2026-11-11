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
}
