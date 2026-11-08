use std::collections::HashMap;

use rune::TextEdit;
use rune_kit::diff::{DiffState, FileDiff};
use serde_json::json;

use crate::api::{self, Change, McpLogin, McpServer, TraceTurn};
use crate::app::{Hooked, Lens, Page, spawn};
use crate::fmt;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum ReviewSource {
    Claude,
    Tree,
}

pub struct LensData {
    pub review_source: ReviewSource,
    pub diff: DiffState,
    pub diff_sig: Option<String>,
    pub diff_loading: bool,
    pub diff_count: usize,

    pub mcp_cwd: Option<String>,
    pub mcp: Vec<McpServer>,
    pub mcp_loading: bool,
    pub mcp_open: Option<String>,
    pub mcp_detail: HashMap<String, String>,
    pub mcp_login: Option<McpLogin>,
    pub mcp_login_polled: i64,
    pub mcp_redirect: TextEdit,
    pub mcp_notice: Option<String>,

    pub trace_sig: Option<String>,
    pub trace: Vec<TraceTurn>,
    pub trace_loading: bool,
    pub trace_open: Option<String>,
    pub trace_tool: HashMap<String, (String, String)>,
}

impl Default for LensData {
    fn default() -> Self {
        LensData {
            review_source: ReviewSource::Claude,
            diff: DiffState::new(Vec::new()),
            diff_sig: None,
            diff_loading: false,
            diff_count: 0,
            mcp_cwd: None,
            mcp: Vec::new(),
            mcp_loading: false,
            mcp_open: None,
            mcp_detail: HashMap::new(),
            mcp_login: None,
            mcp_login_polled: 0,
            mcp_redirect: TextEdit::new(""),
            mcp_notice: None,
            trace_sig: None,
            trace: Vec::new(),
            trace_loading: false,
            trace_open: None,
            trace_tool: HashMap::new(),
        }
    }
}

fn relative(path: &str, root: Option<&str>) -> String {
    root.and_then(|r| path.strip_prefix(r))
        .map(|p| p.trim_start_matches('/').to_string())
        .unwrap_or_else(|| path.to_string())
}

pub fn file_diffs(changes: &[Change], root: Option<&str>) -> Vec<FileDiff> {
    let mut out = Vec::new();
    for c in changes {
        let path = relative(&c.file, root);
        let n = c.ops.len();
        for (i, op) in c.ops.iter().enumerate() {
            let old = op.get("old").and_then(|v| v.as_str()).unwrap_or("");
            let new = op.get("new").and_then(|v| v.as_str()).unwrap_or("");
            let label = if n > 1 {
                format!("{path} · edit {}/{n}", i + 1)
            } else {
                path.clone()
            };
            out.push(FileDiff::from_texts(label, old, new));
        }
    }
    out
}

impl Hooked {
    /// Starts whatever the open lens is missing; true when state changed synchronously.
    pub fn ensure_lens(&mut self) -> bool {
        if self.page != Page::Session {
            return false;
        }
        let Some(d) = self.detail.as_ref() else {
            return false;
        };
        let id = d.session.id.clone();
        let activity = d.session.last_activity.clone().unwrap_or_default();
        let project = d.session.project.clone();
        match self.lens {
            Lens::Converse => false,
            Lens::Review => {
                let ld = &self.lens_data;
                let sig = match ld.review_source {
                    ReviewSource::Claude => format!("{id}|claude|{}|{activity}", d.changes.len()),
                    ReviewSource::Tree => format!("{id}|tree|{activity}"),
                };
                if ld.diff_sig.as_deref() == Some(sig.as_str()) || ld.diff_loading {
                    return false;
                }
                match ld.review_source {
                    ReviewSource::Claude => {
                        let files = file_diffs(&d.changes, project.as_deref());
                        self.lens_data.diff_count = d.changes.len();
                        self.lens_data.diff.set_files(files);
                        self.lens_data.diff_sig = Some(sig);
                        true
                    }
                    ReviewSource::Tree => {
                        self.lens_data.diff_loading = true;
                        spawn(
                            move || api::vcs_changes(&id),
                            move |s, r, _| {
                                s.lens_data.diff_loading = false;
                                s.lens_data.diff_sig = Some(sig);
                                match r {
                                    Ok(changes) => {
                                        s.lens_data.diff_count = changes.len();
                                        let files = file_diffs(&changes, project.as_deref());
                                        s.lens_data.diff.set_files(files);
                                    }
                                    Err(e) => s.flash(format!("✗ Working tree: {e}"), true),
                                }
                            },
                        );
                        true
                    }
                }
            }
            Lens::Mcp => {
                let Some(cwd) = project else { return false };
                let mut changed = false;
                if self.lens_data.mcp_cwd.as_deref() != Some(cwd.as_str())
                    && !self.lens_data.mcp_loading
                {
                    self.lens_data.mcp_cwd = Some(cwd.clone());
                    self.lens_data.mcp.clear();
                    self.lens_data.mcp_detail.clear();
                    self.load_mcp(true);
                    changed = true;
                }
                let now = fmt::now_ms();
                let polling = self
                    .lens_data
                    .mcp_login
                    .as_ref()
                    .is_some_and(|l| !l.done && l.id.is_some());
                if polling && now - self.lens_data.mcp_login_polled > 1500 {
                    self.lens_data.mcp_login_polled = now;
                    let lid = self
                        .lens_data
                        .mcp_login
                        .as_ref()
                        .and_then(|l| l.id.clone())
                        .unwrap_or_default();
                    spawn(
                        move || api::mcp_login(json!({ "action": "login-status", "id": lid })),
                        |s, r, _| {
                            if let Ok(l) = r {
                                let done = l.done;
                                s.lens_data.mcp_login = Some(l);
                                if done {
                                    s.load_mcp(false);
                                }
                            }
                        },
                    );
                }
                changed
            }
            Lens::Trace => {
                let sig = format!("{id}|{activity}");
                if self.lens_data.trace_sig.as_deref() == Some(sig.as_str())
                    || self.lens_data.trace_loading
                {
                    return false;
                }
                self.lens_data.trace_loading = true;
                spawn(
                    move || api::trace(&id),
                    move |s, r, _| {
                        s.lens_data.trace_loading = false;
                        s.lens_data.trace_sig = Some(sig);
                        match r {
                            Ok(t) => s.lens_data.trace = t,
                            Err(e) => s.flash(format!("✗ Trace: {e}"), true),
                        }
                    },
                );
                true
            }
        }
    }

    /// The cached list answers at once; the full one health-checks every server, which takes seconds.
    pub fn load_mcp(&mut self, cached_first: bool) {
        let Some(cwd) = self.lens_data.mcp_cwd.clone() else {
            return;
        };
        self.lens_data.mcp_loading = true;
        spawn(
            move || {
                let quick = if cached_first {
                    api::mcp_list(&cwd, true).ok()
                } else {
                    None
                };
                (quick, cwd)
            },
            |s, (quick, cwd), _| {
                if let Some(list) = quick.filter(|l| !l.is_empty()) {
                    s.lens_data.mcp = list;
                }
                spawn(
                    move || api::mcp_list(&cwd, false),
                    |s, r, _| {
                        s.lens_data.mcp_loading = false;
                        match r {
                            Ok(list) => s.lens_data.mcp = list,
                            Err(e) => {
                                s.lens_data.mcp_notice =
                                    Some(format!("Could not list MCP servers: {e}"))
                            }
                        }
                    },
                );
            },
        );
    }

    pub fn set_review_source(&mut self, src: ReviewSource) {
        if self.lens_data.review_source != src {
            self.lens_data.review_source = src;
            self.lens_data.diff_sig = None;
            self.lens_data.diff.set_files(Vec::new());
        }
    }

    pub fn mcp_toggle_detail(&mut self, name: String) {
        if self.lens_data.mcp_open.as_deref() == Some(name.as_str()) {
            self.lens_data.mcp_open = None;
            return;
        }
        self.lens_data.mcp_open = Some(name.clone());
        if self.lens_data.mcp_detail.contains_key(&name) {
            return;
        }
        let cwd = self.lens_data.mcp_cwd.clone().unwrap_or_default();
        spawn(
            {
                let name = name.clone();
                move || api::mcp_action(json!({ "action": "get", "cwd": cwd, "name": name }))
            },
            move |s, r, _| {
                let raw = match r {
                    Ok(v) => v["raw"].as_str().unwrap_or("").to_string(),
                    Err(e) => format!("✗ {e}"),
                };
                s.lens_data.mcp_detail.insert(name, raw);
            },
        );
    }

    pub fn mcp_logout(&mut self, name: String) {
        let cwd = self.lens_data.mcp_cwd.clone().unwrap_or_default();
        spawn(
            {
                let name = name.clone();
                move || api::mcp_action(json!({ "action": "logout", "cwd": cwd, "name": name }))
            },
            move |s, r, _| {
                s.lens_data.mcp_notice = Some(match r {
                    Ok(_) => format!("Cleared credentials for {name}."),
                    Err(e) => format!("Logout failed for {name}: {e}"),
                });
                s.load_mcp(false);
            },
        );
    }

    pub fn mcp_reauth(&mut self, name: String) {
        let cwd = self.lens_data.mcp_cwd.clone().unwrap_or_default();
        self.lens_data.mcp_notice = None;
        self.lens_data.mcp_redirect = TextEdit::new("");
        self.lens_data.mcp_login = Some(McpLogin {
            name: name.clone(),
            ..Default::default()
        });
        spawn(
            move || api::mcp_login(json!({ "action": "login", "cwd": cwd, "name": name })),
            |s, r, _| match r {
                Ok(l) => {
                    s.lens_data.mcp_login = Some(l);
                    s.lens_data.mcp_login_polled = fmt::now_ms();
                }
                Err(e) => {
                    s.lens_data.mcp_login = None;
                    s.lens_data.mcp_notice = Some(format!("Could not start the login: {e}"));
                }
            },
        );
    }

    pub fn mcp_send_redirect(&mut self) {
        let text = self.lens_data.mcp_redirect.text.trim().to_string();
        let Some(lid) = self.lens_data.mcp_login.as_ref().and_then(|l| l.id.clone()) else {
            return;
        };
        if text.is_empty() {
            return;
        }
        self.lens_data.mcp_redirect = TextEdit::new("");
        spawn(
            move || api::mcp_login(json!({ "action": "login-input", "id": lid, "text": text })),
            |s, r, _| {
                if let Ok(l) = r {
                    s.lens_data.mcp_login = Some(l);
                }
            },
        );
    }

    pub fn mcp_cancel_login(&mut self) {
        let lid = self.lens_data.mcp_login.take().and_then(|l| l.id);
        if let Some(lid) = lid {
            spawn(
                move || api::mcp_action(json!({ "action": "login-cancel", "id": lid })),
                |s, _, _| s.load_mcp(false),
            );
        }
    }

    pub fn trace_toggle(&mut self, tool: String) {
        if self.lens_data.trace_open.as_deref() == Some(tool.as_str()) {
            self.lens_data.trace_open = None;
            return;
        }
        self.lens_data.trace_open = Some(tool.clone());
        if self.lens_data.trace_tool.contains_key(&tool) {
            return;
        }
        let Some(id) = self.selected.clone() else {
            return;
        };
        spawn(
            {
                let tool = tool.clone();
                move || api::trace_tool(&id, &tool)
            },
            move |s, r, _| {
                let v = r.unwrap_or_else(|e| (String::new(), format!("✗ {e}")));
                s.lens_data.trace_tool.insert(tool, v);
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_become_one_diff_per_op_with_relative_paths() {
        let c: Change = serde_json::from_value(json!({
            "file": "/repo/src/a.rs",
            "ops": [{ "old": "a\n", "new": "b\n" }, { "old": "", "new": "c\n" }]
        }))
        .unwrap();
        let files = file_diffs(&[c], Some("/repo"));
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path(), "src/a.rs · edit 1/2");
        assert_eq!(files[0].additions(), 1);
        assert_eq!(files[0].deletions(), 1);
    }
}
