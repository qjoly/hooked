use std::collections::HashMap;

use rune::TextEdit;
use rune_kit::diff::{Annotation, DiffState, FileDiff, LineRange, LineRef, Side};
use serde_json::{Value, json};

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
    pub asking: bool,
    pub anchors: Vec<(String, String)>,
    pub threads: Vec<Value>,
    pub draft: Option<(LineRange, TextEdit)>,
    pub replies: HashMap<String, TextEdit>,
    pub editing: Option<(String, TextEdit)>,
    pub threads_open: bool,
    pub delete_armed: Option<String>,

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
            asking: false,
            anchors: Vec::new(),
            threads: Vec::new(),
            draft: None,
            replies: HashMap::new(),
            editing: None,
            threads_open: false,
            delete_armed: None,
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

/// One diff per op, with the `(file, opIndex)` anchor the web lens files review threads under.
pub fn file_diffs(
    changes: &[Change],
    root: Option<&str>,
    key: &str,
) -> (Vec<FileDiff>, Vec<(String, String)>) {
    let (mut out, mut anchors) = (Vec::new(), Vec::new());
    for c in changes {
        let path = relative(&c.file, root);
        let n = c.ops.len();
        for (i, op) in c.ops.iter().enumerate() {
            let old = op.get("old").and_then(|v| v.as_str()).unwrap_or("");
            let new = op
                .get("new")
                .or_else(|| op.get("content"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let label = if n > 1 {
                format!("{path} · edit {}/{n}", i + 1)
            } else {
                path.clone()
            };
            out.push(FileDiff::from_texts(label, old, new));
            anchors.push((c.file.clone(), format!("{key}:{i}")));
        }
    }
    (out, anchors)
}

/// What a reviewed tick signs off: the file's diff as shown, so a later edit clears it.
pub fn fingerprint(f: &FileDiff) -> String {
    let mut h: u32 = 0x811c_9dc5;
    let mut len = 0usize;
    for l in f.hunks.iter().flat_map(|h| &h.lines) {
        for b in [l.kind as u8].iter().chain(l.text.as_bytes()).chain(b"\0") {
            h ^= u32::from(*b);
            h = h.wrapping_mul(0x0100_0193);
            len += 1;
        }
    }
    format!("{h:x}-{len:x}")
}

const REVIEWED_PER_FILE: usize = 12;

pub struct ReviewBrief {
    pub file: String,
    pub anchor: String,
    pub text: String,
}

fn brief_list(threads: &[ReviewBrief]) -> String {
    threads
        .iter()
        .map(|t| {
            let first: String = t
                .text
                .lines()
                .next()
                .unwrap_or("")
                .chars()
                .take(160)
                .collect();
            format!("- {} ({}): {first}", t.file, t.anchor)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The web's `reviewRequestPrompt`, word for word, so Claude gets the same brief from either client.
pub fn review_request_prompt(
    session: &str,
    scope: &str,
    files: &[String],
    open: &[ReviewBrief],
    dismissed: &[ReviewBrief],
) -> String {
    let api = format!("{}/api/review", api::base());
    let list = files
        .iter()
        .map(|f| format!("- {f}"))
        .collect::<Vec<_>>()
        .join("\n");
    let lines = "1-based lines of the file as it is on disk now, i.e. the new side of the diff";
    let mut out = format!(
        "Review {scope}. Files under review:\n{list}\n\n\
         Look for real problems — bugs, wrong behaviour, unhandled cases, risky changes — and for \
         simplifications worth making. Check each finding against the code before reporting it; skip \
         style nits. Do NOT change any code: this is a review, fixes come once I answer in the threads.\n\n\
         Report EACH finding as its own inline thread with the hooked MCP tool \
         mcp__hooked__add_review_comment (id: \"{session}\", file: absolute path, line / end_line: \
         {lines}; text: what is wrong, why it matters and the fix you suggest, in Markdown). If that MCP \
         tool is unavailable, POST each finding to the local hooked API instead: curl -sS -X POST {api} \
         -H 'content-type: application/json' -d '{{\"id\":\"{session}\",\"action\":\"claude-comment\",\
         \"file\":\"<path>\",\"start\":<line>,\"end\":<end_line>,\"text\":\"<finding>\"}}'. \
         Keep your chat answer to a one-line summary (how many threads you opened) — the findings \
         belong in the threads."
    );
    if !open.is_empty() {
        out.push_str("\n\nThese threads are already open, do not raise them again:\n");
        out.push_str(&brief_list(open));
    }
    if !dismissed.is_empty() {
        out.push_str("\n\nThese were dismissed by the reviewer, do not raise them again:\n");
        out.push_str(&brief_list(dismissed));
    }
    out
}

impl Hooked {
    pub fn review_key_base(&self) -> &'static str {
        match self.lens_data.review_source {
            ReviewSource::Claude => "full",
            ReviewSource::Tree => "vcs:wt",
        }
    }

    pub fn review_with_claude(&mut self) {
        let Some(d) = self.detail.as_ref() else {
            return;
        };
        let id = d.session.id.clone();
        let base = self.review_key_base();
        let scope_key = format!("{base}:*");
        let mut files: Vec<String> = Vec::new();
        for (f, _) in &self.lens_data.anchors {
            if !files.contains(f) {
                files.push(f.clone());
            }
        }
        if files.is_empty() {
            return;
        }
        let in_key = |op: &str| op == base || op.starts_with(&format!("{base}:"));
        let brief = |t: &Value| {
            let side = if t["side"] == "old" { "−L" } else { "+L" };
            let (a, b) = (
                t["start"].as_u64().unwrap_or(0),
                t["end"].as_u64().unwrap_or(0),
            );
            ReviewBrief {
                file: t["file"].as_str().unwrap_or("").to_string(),
                anchor: if a == b || b == 0 {
                    format!("{side}{a}")
                } else {
                    format!("{side}{a}–{b}")
                },
                text: t["messages"][0]["text"].as_str().unwrap_or("").to_string(),
            }
        };
        let here: Vec<&Value> = self
            .lens_data
            .threads
            .iter()
            .filter(|t| in_key(t["opIndex"].as_str().unwrap_or("")))
            .collect();
        let open: Vec<ReviewBrief> = here
            .iter()
            .filter(|t| t["status"] != "archived")
            .map(|t| brief(t))
            .collect();
        let dismissed: Vec<ReviewBrief> = here
            .iter()
            .filter(|t| t["status"] == "archived")
            .map(|t| brief(t))
            .collect();
        let scope = match self.lens_data.review_source {
            ReviewSource::Claude => "your changes",
            ReviewSource::Tree => "the uncommitted changes in the working tree",
        };
        let prompt = review_request_prompt(&id, scope, &files, &open, &dismissed);
        self.lens_data.asking = true;
        spawn(
            move || {
                api::post(
                    "/api/review",
                    json!({ "id": id, "action": "start", "scope": scope_key }),
                )
            },
            move |s, r, _| {
                s.lens_data.asking = false;
                match r {
                    Ok(_) => {
                        s.send_prompt(prompt);
                        s.flash(
                            "✓ Claude is reviewing: its findings land here as threads",
                            false,
                        );
                    }
                    Err(e) => s.flash(format!("✗ Review: {e}"), true),
                }
            },
        );
    }

    fn review_key(&self, file: usize) -> Option<(String, String)> {
        let f = self.lens_data.diff.files().get(file)?;
        let id = self.selected.as_deref()?;
        Some((format!("{id}|{}", f.path()), fingerprint(f)))
    }

    pub fn is_reviewed(&self, file: usize) -> bool {
        self.review_key(file)
            .is_some_and(|(k, fp)| self.reviewed.get(&k).is_some_and(|v| v.contains(&fp)))
    }

    pub fn reviewed_count(&self) -> usize {
        (0..self.lens_data.diff.files().len())
            .filter(|&i| self.is_reviewed(i))
            .count()
    }

    /// Ticking a file moves on to the next one still to review, as the web lens does.
    pub fn toggle_reviewed(&mut self, file: usize, tx: Option<&mut rune::Tx>) {
        let Some((key, fp)) = self.review_key(file) else {
            return;
        };
        let seen = self.reviewed.entry(key.clone()).or_default();
        let marking = !seen.contains(&fp);
        if marking {
            seen.push(fp);
            let n = seen.len();
            if n > REVIEWED_PER_FILE {
                seen.drain(..n - REVIEWED_PER_FILE);
            }
        } else {
            seen.retain(|h| *h != fp);
            if seen.is_empty() {
                self.reviewed.remove(&key);
            }
        }
        let all = self.reviewed.clone();
        self.save_pref("reviewed", &all);
        if marking && let Some(tx) = tx {
            let n = self.lens_data.diff.files().len();
            if let Some(next) = (1..n)
                .map(|d| (file + d) % n)
                .find(|&i| !self.is_reviewed(i))
            {
                self.lens_data.diff.scroll_to_file(next, tx);
            }
        }
    }

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
                        let (files, anchors) = file_diffs(&d.changes, project.as_deref(), "full");
                        self.lens_data.diff_count = d.changes.len();
                        self.lens_data.diff.set_files(files);
                        self.lens_data.anchors = anchors;
                        self.lens_data.diff_sig = Some(sig);
                        self.load_threads();
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
                                        let (files, anchors) =
                                            file_diffs(&changes, project.as_deref(), "vcs:wt");
                                        s.lens_data.diff.set_files(files);
                                        s.lens_data.anchors = anchors;
                                        s.load_threads();
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

    pub fn load_threads(&mut self) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        spawn(
            move || api::get(&format!("/api/review?id={id}")),
            |s, r, _| {
                if let Ok(v) = r {
                    s.lens_data.threads = v["threads"].as_array().cloned().unwrap_or_default();
                    s.annotate();
                }
            },
        );
    }

    /// Puts each thread, and the comment being written, under the diff line it points at.
    pub fn annotate(&mut self) {
        let ld = &mut self.lens_data;
        let mut notes = Vec::new();
        for t in &ld.threads {
            let (file, key) = (
                t["file"].as_str().unwrap_or(""),
                t["opIndex"].as_str().unwrap_or(""),
            );
            let scoped = key.strip_suffix(":*");
            let Some(i) = ld.anchors.iter().position(|(f, k)| {
                f == file
                    && match scoped {
                        Some(base) => k.starts_with(&format!("{base}:")),
                        None => k == key,
                    }
            }) else {
                continue;
            };
            let side = if t["side"].as_str() == Some("old") {
                Side::Old
            } else {
                Side::New
            };
            let line = t["end"].as_u64().or(t["start"].as_u64()).unwrap_or(1) as u32;
            notes.push(Annotation::new(
                i,
                LineRef::new(side, line),
                t["id"].as_str().unwrap_or(""),
            ));
        }
        if let Some((range, _)) = ld.draft.as_ref() {
            let end = if range.end.line >= range.start.line {
                range.end
            } else {
                range.start
            };
            notes.push(Annotation::new(range.file, end, "draft"));
        }
        ld.diff.set_annotations(notes);
    }

    pub fn start_comment(&mut self, range: LineRange) {
        let mut edit = TextEdit::new("");
        edit.focused = true;
        self.lens_data.draft = Some((range, edit));
        self.annotate();
    }

    pub fn cancel_comment(&mut self) {
        self.lens_data.draft = None;
        self.annotate();
    }

    pub fn save_comment(&mut self) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        let Some((range, edit)) = self.lens_data.draft.take() else {
            return;
        };
        let text = edit.text.trim().to_string();
        let Some((file, key)) = self.lens_data.anchors.get(range.file).cloned() else {
            return;
        };
        if text.is_empty() {
            self.annotate();
            return;
        }
        let (a, b) = (
            range.start.line.min(range.end.line),
            range.start.line.max(range.end.line),
        );
        let side = range.end.side;
        let snippet: Vec<String> = self
            .lens_data
            .diff
            .files()
            .get(range.file)
            .map(|f| {
                f.hunks
                    .iter()
                    .flat_map(|h| h.lines.iter())
                    .filter(|l| l.number(side).is_some_and(|n| n >= a && n <= b))
                    .map(|l| l.text.clone())
                    .collect()
            })
            .unwrap_or_default();
        let thread = json!({
            "file": file,
            "name": file.rsplit('/').next().unwrap_or(&file),
            "opIndex": key,
            "side": if side == Side::Old { "old" } else { "new" },
            "start": a,
            "end": b,
            "snippet": snippet.join("\n"),
            "text": text,
        });
        self.review_op(json!({ "id": id, "action": "comment", "thread": thread }));
    }

    fn review_op(&mut self, body: Value) {
        self.annotate();
        spawn(
            move || api::post("/api/review", body),
            |s, r, _| {
                if let Err(e) = r {
                    s.flash(format!("✗ Review: {e}"), true);
                }
                s.load_threads();
            },
        );
    }

    pub fn reply_thread(&mut self, tid: String) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        let text = self
            .lens_data
            .replies
            .remove(&tid)
            .map(|e| e.text.trim().to_string())
            .unwrap_or_default();
        if !text.is_empty() {
            self.review_op(json!({ "id": id, "action": "reply", "threadId": tid, "text": text, "author": "user" }));
        }
    }

    pub fn archive_thread(&mut self, tid: String, archived: bool) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        self.review_op(
            json!({ "id": id, "action": "archive", "threadId": tid, "archived": archived }),
        );
    }

    pub fn delete_thread(&mut self, tid: String) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        self.review_op(json!({ "id": id, "action": "delete", "threadId": tid }));
    }

    pub fn pending_threads(&self) -> Vec<&Value> {
        self.lens_data
            .threads
            .iter()
            .filter(|t| t["sent"].as_bool() != Some(true) && t["status"] != "archived")
            .collect()
    }

    pub fn start_edit_thread(&mut self, tid: String) {
        let text = self
            .lens_data
            .threads
            .iter()
            .find(|t| t["id"].as_str() == Some(tid.as_str()))
            .and_then(|t| t["messages"][0]["text"].as_str())
            .unwrap_or("")
            .to_string();
        let mut e = TextEdit::new(text);
        e.focused = true;
        self.lens_data.editing = Some((tid, e));
    }

    pub fn save_edit_thread(&mut self) {
        let (Some((tid, edit)), Some(id)) = (self.lens_data.editing.take(), self.selected.clone())
        else {
            return;
        };
        let text = edit.text.trim().to_string();
        if text.is_empty() {
            return;
        }
        self.review_op(json!({ "id": id, "action": "edit", "threadId": tid, "text": text }));
    }

    pub fn jump_to_thread(&mut self, tid: &str, tx: &mut rune::Tx) {
        let Some(t) = self
            .lens_data
            .threads
            .iter()
            .find(|t| t["id"].as_str() == Some(tid))
        else {
            return;
        };
        let file = t["file"].as_str().unwrap_or("");
        let key = t["opIndex"].as_str().unwrap_or("");
        let scoped = key.strip_suffix(":*");
        let Some(i) = self.lens_data.anchors.iter().position(|(f, k)| {
            f == file
                && match scoped {
                    Some(base) => k.starts_with(&format!("{base}:")),
                    None => k == key,
                }
        }) else {
            self.flash("That thread belongs to another diff source", true);
            return;
        };
        let side = if t["side"] == "old" {
            Side::Old
        } else {
            Side::New
        };
        let line = t["start"].as_u64().unwrap_or(1) as u32;
        self.lens_data
            .diff
            .scroll_to_line(i, LineRef::new(side, line), tx);
    }

    /// Sends the unsent comments as one prompt, in the shape the web lens uses.
    pub fn send_review(&mut self) {
        let Some(d) = self.detail.as_ref() else {
            return;
        };
        let id = d.session.id.clone();
        let pending: Vec<Value> = self.pending_threads().into_iter().cloned().collect();
        if pending.is_empty() {
            return;
        }
        let scope = if self.lens_data.review_source == ReviewSource::Tree {
            "the uncommitted changes in the working tree"
        } else {
            "your changes"
        };
        let items: Vec<String> = pending
            .iter()
            .enumerate()
            .map(|(n, t)| {
                let (a, b) = (
                    t["start"].as_u64().unwrap_or(1),
                    t["end"].as_u64().unwrap_or(1),
                );
                let p = if t["side"].as_str() == Some("old") {
                    "−L"
                } else {
                    "+L"
                };
                let anchor = if a == b {
                    format!("{p}{b}")
                } else {
                    format!("{p}{a}–{b}")
                };
                let body = t["messages"][0]["text"]
                    .as_str()
                    .unwrap_or("")
                    .replace('\n', "\n   > ");
                let snip: Vec<String> = t["snippet"]
                    .as_str()
                    .unwrap_or("")
                    .lines()
                    .map(|l| format!("   | {l}"))
                    .collect();
                format!(
                    "{}) {} ({anchor}) [thread_id: {}]\n   > {body}\n   Relevant code:\n{}",
                    n + 1,
                    t["file"].as_str().unwrap_or(""),
                    t["id"].as_str().unwrap_or(""),
                    snip.join("\n")
                )
            })
            .collect();
        let api_url = format!("{}/api/review", api::base());
        let prompt = format!(
            "I reviewed {scope} and left the following inline comments. Address each one, then, for each: \
             Reply in the thread with the hooked MCP tool mcp__hooked__reply_review_comment (id: \"{id}\", thread_id above). \
             Do NOT close the thread — closing is the reviewer's call, and there is no tool for it. If that MCP tool is \
             unavailable, POST the same reply to the local hooked API instead: curl -sS -X POST {api_url} -H 'content-type: application/json' \
             -d '{{\"id\":\"{id}\",\"action\":\"reply\",\"threadId\":\"<thread_id>\",\"text\":\"<your reply>\",\"author\":\"claude\"}}'. \
             Keep your chat answer to a one-line summary — the details belong in the thread.\n\n{}",
            items.join("\n\n")
        );
        let ids: Vec<String> = pending
            .iter()
            .filter_map(|t| t["id"].as_str().map(str::to_string))
            .collect();
        let live = d.session.live;
        let effort = d.session.effort.clone();
        spawn(
            move || {
                if live {
                    api::reply(&id, &prompt)
                } else {
                    api::resume(&id, &prompt, effort.as_deref())
                }?;
                api::post(
                    "/api/review",
                    json!({ "id": id, "action": "sent", "ids": ids }),
                )
                .map(|_| ())
            },
            |s, r, _| {
                match r {
                    Ok(()) => {
                        s.flash("✓ Comments sent to Claude", false);
                        s.lens = Lens::Converse;
                    }
                    Err(e) => s.flash(format!("✗ Send: {e}"), true),
                }
                s.load_threads();
                s.refresh_detail();
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
        let (files, anchors) = file_diffs(&[c], Some("/repo"), "full");
        assert_eq!(
            anchors[1],
            ("/repo/src/a.rs".to_string(), "full:1".to_string())
        );
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path(), "src/a.rs · edit 1/2");
        assert_eq!(files[0].additions(), 1);
        assert_eq!(files[0].deletions(), 1);
    }
}

#[cfg(test)]
mod prompt_tests {
    use super::*;

    #[test]
    fn review_prompt_matches_the_web_brief() {
        let p = review_request_prompt(
            "abc",
            "your changes",
            &["/r/a.rs".to_string()],
            &[ReviewBrief {
                file: "/r/a.rs".into(),
                anchor: "+L3".into(),
                text: "off by one\nmore".into(),
            }],
            &[],
        );
        assert!(p.starts_with(
            "Review your changes. Files under review:\n- /r/a.rs\n\nLook for real problems"
        ));
        assert!(p.contains("mcp__hooked__add_review_comment (id: \"abc\", file: absolute path"));
        assert!(
            p.contains("-d '{\"id\":\"abc\",\"action\":\"claude-comment\",\"file\":\"<path>\"")
        );
        assert!(p.ends_with("do not raise them again:\n- /r/a.rs (+L3): off by one"));
    }
}
