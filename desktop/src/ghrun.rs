use serde_json::Value;

use crate::api;
use crate::app::Hooked;
use crate::fmt;

const POLL_MS: i64 = 5000;
pub const MAX_LINES: usize = 3000;

pub struct RunWin {
    pub url: String,
    pub run: Option<Value>,
    pub err: Option<String>,
    pub job: Option<String>,
    pub log: Option<(String, Result<Option<String>, String>)>,
    pub loading: bool,
    pub polled: i64,
}

/// `https://github.com/o/r/actions/runs/1[/job/2]` → the job id (empty for a bare run).
pub fn parse_run_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://github.com/")?;
    let parts: Vec<&str> = rest
        .split(['?', '#'])
        .next()?
        .trim_end_matches('/')
        .split('/')
        .collect();
    match parts.as_slice() {
        [_, _, "actions", "runs", run] if run.chars().all(|c| c.is_ascii_digit()) => {
            Some(String::new())
        }
        [_, _, "actions", "runs", run, "job", job]
            if run.chars().all(|c| c.is_ascii_digit())
                && job.chars().all(|c| c.is_ascii_digit()) =>
        {
            Some(job.to_string())
        }
        _ => None,
    }
}

impl RunWin {
    pub fn job(&self) -> Option<&Value> {
        let jobs = self.run.as_ref()?["jobs"].as_array()?;
        let by = |st: &str| jobs.iter().find(|j| j["status"] == st);
        self.job
            .as_ref()
            .and_then(|id| jobs.iter().find(|j| j["id"].as_str() == Some(id.as_str())))
            .or_else(|| by("failed"))
            .or_else(|| by("pending"))
            .or_else(|| jobs.first())
    }
}

impl Hooked {
    pub fn open_run(&mut self, url: String) {
        let job = parse_run_url(&url).filter(|j| !j.is_empty());
        self.run_win = Some(RunWin {
            url,
            run: None,
            err: None,
            job,
            log: None,
            loading: false,
            polled: 0,
        });
        self.load_run();
    }

    pub fn pick_run_job(&mut self, id: String) {
        if let Some(w) = self.run_win.as_mut() {
            w.job = Some(id);
        }
        self.load_run_log();
    }

    fn load_run(&mut self) {
        let Some(w) = self.run_win.as_mut() else {
            return;
        };
        if w.loading {
            return;
        }
        w.loading = true;
        w.polled = fmt::now_ms();
        let url = w.url.clone();
        self.spawn(
            {
                let url = url.clone();
                move || api::get(&format!("/api/github/run?url={}", api::enc(&url)))
            },
            move |s, r, _| {
                let Some(w) = s.run_win.as_mut().filter(|w| w.url == url) else {
                    return;
                };
                w.loading = false;
                match r {
                    Ok(v) if v.get("error").is_none() => {
                        w.run = Some(v);
                        w.err = None;
                    }
                    Ok(v) => w.err = v["error"].as_str().map(str::to_string),
                    Err(e) => w.err = Some(e),
                }
                s.load_run_log();
            },
        );
    }

    fn load_run_log(&mut self) {
        let Some(w) = self.run_win.as_mut() else {
            return;
        };
        let Some(job) = w.job().cloned() else {
            return;
        };
        let id = job["id"].as_str().unwrap_or("").to_string();
        if w.log
            .as_ref()
            .is_some_and(|(j, l)| *j == id && !matches!(l, Ok(None)))
        {
            return;
        }
        if job["status"] == "pending" {
            w.log = Some((id, Ok(None)));
            return;
        }
        let job_url = job["url"].as_str().unwrap_or("").to_string();
        self.spawn(
            move || api::get(&format!("/api/github/run/log?url={}", api::enc(&job_url))),
            move |s, r, _| {
                let Some(w) = s.run_win.as_mut() else {
                    return;
                };
                let log = match r {
                    Ok(v) if v.get("error").is_some() => {
                        Err(v["error"].as_str().unwrap_or("").to_string())
                    }
                    Ok(v) => Ok(v["log"].as_str().map(str::to_string)),
                    Err(e) => Err(e),
                };
                w.log = Some((id, log));
            },
        );
    }

    /// Called from `poll`: refreshes a run still going.
    pub fn poll_run(&mut self, now: i64) {
        let due = self.run_win.as_ref().is_some_and(|w| {
            !w.loading
                && now - w.polled > POLL_MS
                && w.run.as_ref().is_none_or(|r| r["status"] == "pending")
        });
        if due {
            self.load_run();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_urls() {
        assert_eq!(
            parse_run_url("https://github.com/o/r/actions/runs/12/job/34"),
            Some("34".into())
        );
        assert_eq!(
            parse_run_url("https://github.com/o/r/actions/runs/12"),
            Some(String::new())
        );
        assert_eq!(parse_run_url("https://github.com/o/r/pull/12"), None);
    }
}
