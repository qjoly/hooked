//! Background GitHub watch: a native notification for a new pull request in a watched repository,
//! and for activity on the viewer's own pull requests (a review, checks that settle). It reads the
//! same endpoints as the GitHub page, so a poll also keeps that page fresh.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde_json::{Value, json};

use crate::api;
use crate::app::Hooked;

/// The pace of the background look. The server caches the overview for 90 s and a repository's
/// list for 60 s, so a tighter pace would only read the same answer twice.
const POLL_MS: i64 = 2 * 60_000;

#[derive(Default)]
pub struct GhWatch {
    /// Repositories (`owner/name`) whose new pull requests notify.
    pub repos: BTreeSet<String>,
    pub checked_at: i64,
    pub busy: bool,
    /// Pull request URLs already seen, per watched repository. A repository's first read only
    /// seeds it: what was open before the watch started is not news.
    seen: HashMap<String, HashSet<String>>,
    /// The viewer's pull requests as last seen; `None` until the first read.
    mine: Option<HashMap<String, Snap>>,
}

impl GhWatch {
    pub fn new(repos: Vec<String>) -> GhWatch {
        GhWatch {
            repos: repos.into_iter().collect(),
            ..GhWatch::default()
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snap {
    reviews: BTreeSet<String>,
    checks: String,
}

#[derive(Debug, PartialEq)]
pub struct News {
    pub key: String,
    pub title: String,
    pub body: String,
    pub url: String,
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}

fn snap(pr: &Value) -> Snap {
    Snap {
        reviews: pr["reviews"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|r| format!("{}|{}|{}", s(r, "author"), s(r, "state"), s(r, "at")))
            .collect(),
        checks: s(pr, "checks").to_string(),
    }
}

fn review_verb(state: &str) -> &'static str {
    match state {
        "APPROVED" => "approved",
        "CHANGES_REQUESTED" => "requested changes on",
        "DISMISSED" => "dismissed a review on",
        _ => "reviewed",
    }
}

/// New pull requests of one watched repository, and the URLs to remember. The viewer's own are
/// remembered but not announced.
pub fn new_prs(
    seen: Option<&HashSet<String>>,
    prs: &[Value],
    viewer: &str,
) -> (Vec<News>, HashSet<String>) {
    let now: HashSet<String> = prs.iter().map(|p| s(p, "url").to_string()).collect();
    let Some(seen) = seen else {
        return (Vec::new(), now);
    };
    let news = prs
        .iter()
        .filter(|p| !seen.contains(s(p, "url")) && s(p, "author") != viewer)
        .map(|p| News {
            key: format!("pr-{}", s(p, "url")),
            title: format!(
                "New PR in {}",
                s(p, "repo").rsplit('/').next().unwrap_or("")
            ),
            body: format!(
                "#{} {} · {}",
                p["number"].as_i64().unwrap_or(0),
                s(p, "title"),
                s(p, "author")
            ),
            url: s(p, "url").to_string(),
        })
        .collect();
    (news, now)
}

/// What changed on the viewer's pull requests since the last look: reviews from someone else,
/// and checks that settled (passed or failed). A PR seen for the first time is not news.
pub fn my_pr_news(
    prev: Option<&HashMap<String, Snap>>,
    mine: &[Value],
) -> (Vec<News>, HashMap<String, Snap>) {
    let now: HashMap<String, Snap> = mine
        .iter()
        .map(|p| (s(p, "url").to_string(), snap(p)))
        .collect();
    let Some(prev) = prev else {
        return (Vec::new(), now);
    };
    let mut out = Vec::new();
    for pr in mine {
        let url = s(pr, "url");
        let Some(old) = prev.get(url) else { continue };
        let head = format!("#{} {}", pr["number"].as_i64().unwrap_or(0), s(pr, "title"));
        for r in pr["reviews"].as_array().into_iter().flatten() {
            let key = format!("{}|{}|{}", s(r, "author"), s(r, "state"), s(r, "at"));
            if old.reviews.contains(&key) || s(r, "author") == s(pr, "author") {
                continue;
            }
            out.push(News {
                key: format!("rv-{url}-{key}"),
                title: format!("{} {} your PR", s(r, "author"), review_verb(s(r, "state"))),
                body: head.clone(),
                url: url.to_string(),
            });
        }
        let checks = s(pr, "checks");
        if checks != old.checks {
            let verdict = match checks {
                "SUCCESS" => Some("Checks passed"),
                "FAILURE" | "ERROR" => Some("Checks failed"),
                _ => None,
            };
            if let Some(v) = verdict {
                out.push(News {
                    key: format!("ck-{url}-{checks}"),
                    title: v.to_string(),
                    body: head.clone(),
                    url: url.to_string(),
                });
            }
        }
    }
    (out, now)
}

type Polled = (Option<Value>, Vec<(String, Result<Value, String>)>);

impl Hooked {
    pub fn gh_watched(&self, repo: &str) -> bool {
        self.ghw.repos.contains(repo)
    }

    pub fn toggle_gh_watch(&mut self, repo: String) {
        if !self.ghw.repos.remove(&repo) {
            self.ghw.repos.insert(repo.clone());
            self.flash(format!("🔔 New PRs in {repo} will notify"), false);
        } else {
            self.ghw.seen.remove(&repo);
        }
        let list: Vec<String> = self.ghw.repos.iter().cloned().collect();
        self.save_pref("ghWatched", &list);
        // Seed the new repository now, so its first PR after the toggle is news.
        self.ghw.checked_at = 0;
    }

    /// Runs with the app, page open or not.
    pub fn poll_gh_watch(&mut self, now: i64) {
        if self.handle.is_none() || self.ghw.busy || now - self.ghw.checked_at < POLL_MS {
            return;
        }
        self.ghw.busy = true;
        self.ghw.checked_at = now;
        let repos: Vec<String> = self.ghw.repos.iter().cloned().collect();
        self.spawn(
            move || -> Polled {
                // A stale answer starts a refresh on the server; wait for it, nobody is watching.
                let ov = api::get("/api/github").ok().and_then(|v| {
                    if v["stale"].as_bool() == Some(true) {
                        api::get("/api/github?refresh=1").ok()
                    } else {
                        Some(v)
                    }
                });
                let lists = repos
                    .into_iter()
                    .map(|r| {
                        let got = api::get(&format!("/api/github/repo?repo={}", enc(&r)));
                        (r, got)
                    })
                    .collect();
                (ov, lists)
            },
            |s, (ov, lists), _| {
                s.ghw.busy = false;
                s.apply_gh_watch(ov, lists);
            },
        );
    }

    fn apply_gh_watch(&mut self, ov: Option<Value>, lists: Vec<(String, Result<Value, String>)>) {
        let mut news = Vec::new();
        let viewer = ov
            .as_ref()
            .map(|v| s(v, "viewer").to_string())
            .unwrap_or_default();
        if let Some(v) = &ov {
            let mine = v["mine"].as_array().cloned().unwrap_or_default();
            let (n, snap) = my_pr_news(self.ghw.mine.as_ref(), &mine);
            news.extend(n);
            self.ghw.mine = Some(snap);
            if self.pages.github.is_some() {
                self.pages.github = Some(v.clone());
            }
        }
        for (repo, got) in lists {
            let Ok(v) = got else { continue };
            if !self.ghw.repos.contains(&repo) {
                continue; // unwatched while the read was out
            }
            let prs = v["prs"].as_array().cloned().unwrap_or_default();
            let (n, seen) = new_prs(self.ghw.seen.get(&repo), &prs, &viewer);
            news.extend(n);
            self.ghw.seen.insert(repo.clone(), seen);
            if self.pages.gh_repo.as_deref() == Some(repo.as_str()) {
                self.pages.gh_repo_prs =
                    Some(json!({ "repo": repo, "total": v["total"], "prs": prs }));
            }
        }
        if !self.notify {
            return;
        }
        for n in news {
            crate::tray::notify_link(&n.key, &n.title, &n.body, "gh", &n.url);
        }
    }
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(url: &str, author: &str) -> Value {
        json!({ "url": url, "author": author, "repo": "o/r", "number": 1, "title": "t", "reviews": [], "checks": "" })
    }

    #[test]
    fn a_repo_first_read_seeds_then_new_prs_notify() {
        let (n, seen) = new_prs(None, &[pr("a", "bob")], "me");
        assert!(n.is_empty());
        let (n, _) = new_prs(
            Some(&seen),
            &[pr("a", "bob"), pr("b", "eve"), pr("c", "me")],
            "me",
        );
        assert_eq!(n.iter().map(|x| x.url.as_str()).collect::<Vec<_>>(), ["b"]);
    }

    #[test]
    fn my_prs_notify_on_reviews_and_settled_checks() {
        let mut p = pr("a", "me");
        p["checks"] = json!("PENDING");
        let (n, snap) = my_pr_news(None, std::slice::from_ref(&p));
        assert!(n.is_empty());
        p["checks"] = json!("FAILURE");
        p["reviews"] = json!([
            { "author": "bob", "state": "APPROVED", "at": "t1" },
            { "author": "me", "state": "COMMENTED", "at": "t2" },
        ]);
        let (n, snap2) = my_pr_news(Some(&snap), std::slice::from_ref(&p));
        let titles: Vec<&str> = n.iter().map(|x| x.title.as_str()).collect();
        assert_eq!(titles, ["bob approved your PR", "Checks failed"]);
        let (n, _) = my_pr_news(Some(&snap2), &[p]);
        assert!(n.is_empty());
    }
}
