use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::{api, app::Hooked};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum GhSlot {
    Page,
    Dock,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Fix {
    Sending,
    Sent,
    Failed,
}

pub struct GhView {
    pub url: String,
    pub session: Option<String>,
    pub tab: usize,
    pub files: HashSet<String>,
    pub comments: HashSet<String>,
    pub bots: bool,
    pub fixed: HashMap<String, Fix>,
}

impl GhView {
    fn new(url: String, session: Option<String>) -> Self {
        Self {
            url,
            session,
            tab: 0,
            files: HashSet::new(),
            comments: HashSet::new(),
            bots: false,
            fixed: HashMap::new(),
        }
    }
}

pub fn check_rank(status: &str) -> u8 {
    match status {
        "failed" => 0,
        "cancelled" => 1,
        "pending" => 2,
        _ => 9,
    }
}

pub fn fix_prompt(name: &str, check_url: &str, pr_url: &str) -> String {
    let logs = if check_url.is_empty() {
        String::new()
    } else {
        format!(" (logs: {check_url})")
    };
    format!("The CI check \"{name}\" fails on {pr_url}{logs}. Investigate why and fix it.")
}

pub enum PatchLine<'a> {
    Meta(&'a str),
    Hunk(&'a str),
    Add(&'a str),
    Del(&'a str),
    Ctx(&'a str),
}

pub fn patch_lines(patch: &str) -> Vec<PatchLine<'_>> {
    let mut in_hunk = false;
    patch
        .lines()
        .map(|l| {
            if l.starts_with("@@") {
                in_hunk = true;
                PatchLine::Hunk(l)
            } else if l.starts_with("diff --git ") {
                in_hunk = false;
                PatchLine::Meta(l)
            } else if !in_hunk {
                PatchLine::Meta(l)
            } else if let Some(r) = l.strip_prefix('+') {
                PatchLine::Add(r)
            } else if let Some(r) = l.strip_prefix('-') {
                PatchLine::Del(r)
            } else {
                PatchLine::Ctx(l.strip_prefix(' ').unwrap_or(l))
            }
        })
        .collect()
}

impl Hooked {
    pub fn gh_view(&self, slot: GhSlot) -> Option<&GhView> {
        match slot {
            GhSlot::Page => self.gh_page_view.as_ref(),
            GhSlot::Dock => self
                .gh_dock_view
                .as_ref()
                .filter(|v| v.session.is_some() && v.session == self.selected),
        }
    }

    pub fn gh_view_mut(&mut self, slot: GhSlot) -> Option<&mut GhView> {
        match slot {
            GhSlot::Page => self.gh_page_view.as_mut(),
            GhSlot::Dock => self.gh_dock_view.as_mut(),
        }
    }

    pub fn peek_gh(&mut self, url: String) {
        if self.gh_page_view.as_ref().is_some_and(|v| v.url == url) {
            self.gh_page_view = None;
            return;
        }
        self.load_gh_detail(&url, false);
        self.gh_page_view = Some(GhView::new(url, None));
    }

    pub fn open_gh_full(&mut self, url: String) {
        self.load_gh_detail(&url, false);
        self.gh_dock_view = Some(GhView::new(url, self.selected.clone()));
    }

    pub fn close_gh_full(&mut self) {
        self.gh_dock_view = None;
    }

    pub fn load_gh_detail(&mut self, url: &str, refresh: bool) {
        if refresh {
            self.gh_details.remove(url);
            self.gh_diffs.remove(url);
        }
        if self.gh_details.contains_key(url) || !self.gh_loading.insert(url.to_string()) {
            return;
        }
        let url = url.to_string();
        self.spawn(
            {
                let url = url.clone();
                move || api::get(&format!("/api/github/detail?url={}", api::enc(&url)))
            },
            move |s, r, _| {
                s.gh_loading.remove(&url);
                let r = r.and_then(|v| match v["error"].as_str() {
                    Some(e) => Err(e.to_string()),
                    None => Ok(v),
                });
                if let Ok(v) = &r
                    && let Some(checks) = v["checks"].as_array()
                {
                    s.gh_checks.insert(url.clone(), checks.clone());
                }
                s.gh_details.insert(url.clone(), r);
                let wants_diff = [GhSlot::Page, GhSlot::Dock]
                    .into_iter()
                    .any(|slot| s.gh_view(slot).is_some_and(|v| v.url == url && v.tab == 2));
                if wants_diff {
                    s.load_gh_diff(&url);
                }
            },
        );
    }

    pub fn load_gh_diff(&mut self, url: &str) {
        let key = format!("diff:{url}");
        if self.gh_diffs.contains_key(url) || !self.gh_loading.insert(key.clone()) {
            return;
        }
        let url = url.to_string();
        self.spawn(
            {
                let url = url.clone();
                move || api::get(&format!("/api/github/diff?url={}", api::enc(&url)))
            },
            move |s, r, _| {
                s.gh_loading.remove(&key);
                let r = r.and_then(|v| match v["error"].as_str() {
                    Some(e) => Err(e.to_string()),
                    None => Ok(v["files"].clone()),
                });
                s.gh_diffs.insert(url, r);
            },
        );
    }

    pub fn gh_tab(&mut self, slot: GhSlot, tab: usize) {
        let Some(v) = self.gh_view_mut(slot) else {
            return;
        };
        v.tab = tab;
        let url = v.url.clone();
        let is_pr = matches!(self.gh_details.get(&url), Some(Ok(d)) if d["kind"] == "pr");
        if tab == 2 && is_pr {
            self.load_gh_diff(&url);
        }
    }

    pub fn gh_refresh(&mut self, slot: GhSlot) {
        let Some(v) = self.gh_view(slot) else {
            return;
        };
        let (url, tab) = (v.url.clone(), v.tab);
        self.load_gh_detail(&url, true);
        if tab == 2 {
            self.load_gh_diff(&url);
        }
    }

    pub fn gh_toggle(&mut self, slot: GhSlot, what: GhToggle, key: String) {
        let Some(v) = self.gh_view_mut(slot) else {
            return;
        };
        let set = match what {
            GhToggle::File => &mut v.files,
            GhToggle::Comment => &mut v.comments,
            GhToggle::Bots => {
                v.bots = !v.bots;
                return;
            }
        };
        if !set.remove(&key) {
            set.insert(key);
        }
    }

    pub fn fix_check(&mut self, slot: GhSlot, name: String, check_url: String) {
        let Some(v) = self.gh_view_mut(slot) else {
            return;
        };
        let Some(session) = v.session.clone() else {
            return;
        };
        let text = fix_prompt(&name, &check_url, &v.url);
        v.fixed.insert(name.clone(), Fix::Sending);
        self.spawn(
            move || api::reply(&session, &text),
            move |s, r, _| {
                if let Some(v) = s.gh_view_mut(slot) {
                    v.fixed
                        .insert(name, if r.is_ok() { Fix::Sent } else { Fix::Failed });
                }
            },
        );
    }
}

#[derive(Clone, Copy)]
pub enum GhToggle {
    File,
    Comment,
    Bots,
}

pub fn detail_kind(d: &Value) -> &str {
    d["kind"].as_str().unwrap_or("pr")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_a_patch_into_typed_lines() {
        let p =
            "diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new";
        let kinds: Vec<&str> = patch_lines(p)
            .iter()
            .map(|l| match l {
                PatchLine::Meta(_) => "m",
                PatchLine::Hunk(_) => "h",
                PatchLine::Add(_) => "+",
                PatchLine::Del(_) => "-",
                PatchLine::Ctx(_) => " ",
            })
            .collect();
        assert_eq!(kinds, ["m", "m", "m", "m", "h", " ", "-", "+"]);
    }

    #[test]
    fn fix_prompt_matches_the_web() {
        assert_eq!(
            fix_prompt("lint", "https://ci/1", "https://github.com/o/r/pull/2"),
            "The CI check \"lint\" fails on https://github.com/o/r/pull/2 (logs: https://ci/1). Investigate why and fix it."
        );
    }
}
