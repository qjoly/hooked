use std::collections::HashMap;

use rune::TextEdit;
use rune_kit::diff::{Annotation, DiffState, FileDiff, LineRange, LineRef, Side};
use serde_json::{Value, json};

use crate::api::{self, Change, ChangeTurn, McpLogin, McpServer, TraceTurn};
use crate::app::{Hooked, Lens, Page};
use crate::fmt;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum ReviewSource {
    Claude,
    Worktree,
    Tree,
    Branch,
}

pub struct LensData {
    pub review_source: ReviewSource,
    pub diff: DiffState,
    pub diff_sig: Option<String>,
    pub diff_loading: bool,
    pub diff_count: usize,
    pub asking: bool,
    pub turns: std::collections::BTreeSet<usize>,
    pub full: HashMap<String, Option<Change>>,
    pub blame: HashMap<(String, String), Option<Value>>,
    pub blame_at: Option<(usize, Side, u32)>,
    pub def: Option<crate::defs::DefPeek>,
    pub rendered: bool,
    pub branches: Option<Value>,
    pub branches_loading: bool,
    pub branch: Option<String>,
    pub base: Option<String>,
    pub branch_root: Option<String>,
    /// The repos the Branch scope can pick from, when the session's directory holds several.
    pub repos: Vec<api::Repo>,
    /// Parallel to the diff's files in the Working tree scope; see `TreeDiffs::repos`.
    pub file_repos: Vec<String>,
    pub worktree: Option<api::BaseDiff>,
    pub commits: Vec<Value>,
    pub picked: Vec<String>,
    pub branch_open: bool,
    pub turns_open: bool,
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
            turns: Default::default(),
            full: HashMap::new(),
            blame: HashMap::new(),
            blame_at: None,
            def: None,
            rendered: false,
            branches: None,
            branches_loading: false,
            branch: None,
            base: None,
            branch_root: None,
            repos: Vec::new(),
            file_repos: Vec::new(),
            worktree: None,
            commits: Vec::new(),
            picked: Vec::new(),
            branch_open: false,
            turns_open: false,
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

pub fn apply_op(text: &str, o: &Value) -> String {
    let s = |k: &str| o[k].as_str().unwrap_or("");
    match o["kind"].as_str() {
        Some("write") => s("content").to_string(),
        Some("notebook") => text.to_string(),
        _ => {
            let (old, new) = (s("old"), s("new"));
            if old.is_empty() {
                return if text.is_empty() {
                    new.to_string()
                } else {
                    text.to_string()
                };
            }
            if o["all"].as_bool() == Some(true) {
                text.replace(old, new)
            } else {
                text.replacen(old, new, 1)
            }
        }
    }
}

/// The prompt an op belongs to: the last one sent before it.
pub fn op_turn(turns: &[ChangeTurn], o: &Value) -> usize {
    let ts = o["ts"].as_str().unwrap_or("");
    let mut idx = turns.first().map_or(0, |t| t.turn);
    for t in turns {
        if t.ts.as_str() <= ts {
            idx = t.turn;
        } else {
            break;
        }
    }
    idx
}

/// The web keys a filtered section as `sel:` plus the turns sorted the way JavaScript sorts
/// numbers by default, as strings; threads left there must land on the same key here.
pub fn turns_key(selected: &std::collections::BTreeSet<usize>) -> String {
    let mut t: Vec<String> = selected.iter().map(usize::to_string).collect();
    t.sort();
    format!("sel:{}", t.join(","))
}

/// Claude's edits restricted to the selected prompts: one section replayed from the original
/// when the server could rebuild it, else each selected op on its own.
pub fn filtered_diffs(
    changes: &[Change],
    turns: &[ChangeTurn],
    selected: &std::collections::BTreeSet<usize>,
    root: Option<&str>,
) -> (Vec<FileDiff>, Vec<(String, String)>) {
    let key = turns_key(selected);
    let (mut out, mut anchors) = (Vec::new(), Vec::new());
    for c in changes {
        let path = relative(&c.file, root);
        let picked: Vec<usize> = c
            .raw_ops
            .iter()
            .enumerate()
            .filter(|(_, o)| selected.contains(&op_turn(turns, o)))
            .map(|(j, _)| j)
            .collect();
        let (Some(&first), Some(&last)) = (picked.first(), picked.last()) else {
            continue;
        };
        if let Some(orig) = c.original.as_ref() {
            let mut text = orig.clone();
            let (mut before, mut after) = (String::new(), String::new());
            for (j, o) in c.raw_ops.iter().enumerate() {
                if j == first {
                    before = text.clone();
                }
                text = apply_op(&text, o);
                if j == last {
                    after = text.clone();
                }
            }
            out.push(FileDiff::from_texts(path.clone(), &before, &after));
            anchors.push((c.file.clone(), key.clone()));
        } else {
            for j in picked {
                let o = &c.raw_ops[j];
                let old = o["old"].as_str().unwrap_or("");
                let new = o["new"].as_str().or(o["content"].as_str()).unwrap_or("");
                out.push(FileDiff::from_texts(
                    format!("{path} · edit {}", j + 1),
                    old,
                    new,
                ));
                anchors.push((c.file.clone(), format!("{key}:{j}")));
            }
        }
    }
    (out, anchors)
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

pub struct TreeDiffs {
    pub files: Vec<FileDiff>,
    pub anchors: Vec<(String, String)>,
    /// The repo of each file, for the rail's headers; empty when there is only one repo.
    pub repos: Vec<String>,
}

/// The uncommitted changes of every detected repo, one repo after the other, as the web lens
/// flattens them.
pub fn tree_diffs(repos: &[api::Repo], root: Option<&str>) -> TreeDiffs {
    let several = repos.len() > 1;
    let mut out = TreeDiffs {
        files: Vec::new(),
        anchors: Vec::new(),
        repos: Vec::new(),
    };
    for r in repos {
        let (files, anchors) = file_diffs(&r.changes, root, "vcs:wt");
        if several {
            out.repos
                .extend(std::iter::repeat_n(r.name().to_string(), files.len()));
        }
        out.files.extend(files);
        out.anchors.extend(anchors);
    }
    out
}

/// The web's `'wtb:' + wtd.base`, so threads land on the same sections from either client.
fn worktree_key(wt: Option<&api::BaseDiff>) -> String {
    format!(
        "wtb:{}",
        wt.and_then(|w| w.base.as_deref()).unwrap_or_default()
    )
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
    rev: Option<&str>,
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
    let lines = match rev {
        Some(r) => format!(
            "1-based lines of the file at revision {r} (git show {r}:<path>), i.e. the new side of the diff"
        ),
        None => "1-based lines of the file as it is on disk now, i.e. the new side of the diff"
            .to_string(),
    };
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
    pub fn review_key_base(&self) -> String {
        match self.lens_data.review_source {
            ReviewSource::Claude if self.lens_data.turns.is_empty() => "full".into(),
            ReviewSource::Claude => turns_key(&self.lens_data.turns),
            ReviewSource::Worktree => worktree_key(self.lens_data.worktree.as_ref()),
            ReviewSource::Tree => "vcs:wt".into(),
            ReviewSource::Branch => format!("br:{}", self.branch_key().unwrap_or_default()),
        }
    }

    /// The picked commits as the range the server diffs, oldest first (`commits` is newest first).
    pub fn branch_range(&self) -> Option<(String, String)> {
        let ld = &self.lens_data;
        let at: Vec<usize> = ld
            .picked
            .iter()
            .filter_map(|r| {
                ld.commits
                    .iter()
                    .position(|c| c["rev"].as_str() == Some(r.as_str()))
            })
            .collect();
        let (lo, hi) = (*at.iter().min()?, *at.iter().max()?);
        Some((
            ld.commits[hi]["rev"].as_str()?.to_string(),
            ld.commits[lo]["rev"].as_str()?.to_string(),
        ))
    }

    /// The web's `diffKey`: `root:base:branch`, plus `:@from..to` for a commit range.
    pub fn branch_key(&self) -> Option<String> {
        let ld = &self.lens_data;
        let pair = format!(
            "{}:{}:{}",
            ld.branch_root.as_deref()?,
            ld.base.as_deref()?,
            ld.branch.as_deref()?
        );
        Some(match self.branch_range() {
            Some((from, to)) => format!("{pair}:@{from}..{to}"),
            None => pair,
        })
    }

    /// What "Review" names in prompts, and the revision the new side's lines come from.
    pub fn review_scope(&self) -> (String, Option<String>) {
        let ld = &self.lens_data;
        match ld.review_source {
            ReviewSource::Branch => {
                let (b, base) = (
                    ld.branch.clone().unwrap_or_default(),
                    ld.base.clone().unwrap_or_default(),
                );
                match self.branch_range() {
                    Some((from, to)) => (
                        format!(
                            "commits `{}`…`{}` of branch `{b}` (based on `{base}`)",
                            &from[..from.len().min(7)],
                            &to[..to.len().min(7)]
                        ),
                        Some(to),
                    ),
                    None => (
                        format!("the full diff of branch `{b}` against `{base}`"),
                        Some(b),
                    ),
                }
            }
            ReviewSource::Worktree => (
                format!(
                    "everything this worktree changed since it forked from `{}` (commits and uncommitted edits)",
                    ld.worktree
                        .as_ref()
                        .and_then(|w| w.base.as_deref())
                        .unwrap_or_default()
                ),
                None,
            ),
            ReviewSource::Tree => ("the uncommitted changes in the working tree".into(), None),
            ReviewSource::Claude if !ld.turns.is_empty() => {
                let labels: Vec<String> = ld.turns.iter().map(|t| format!("P{}", t + 1)).collect();
                (
                    format!(
                        "your changes for prompt{} {}",
                        if labels.len() > 1 { "s" } else { "" },
                        labels.join(", ")
                    ),
                    None,
                )
            }
            ReviewSource::Claude => ("your changes".into(), None),
        }
    }

    /// `root` picks one of the detected repos; none means the server's default, the primary one.
    fn load_branches(&mut self, id: String, root: Option<String>) {
        self.lens_data.branches_loading = true;
        self.spawn(
            move || {
                let mut path = format!("/api/session/vcs-branches?id={}", api::enc(&id));
                if let Some(root) = &root {
                    path.push_str(&format!("&root={}", api::enc(root)));
                }
                api::get(&path)
            },
            |s, r, _| {
                let ld = &mut s.lens_data;
                ld.branches_loading = false;
                let v = r.unwrap_or_default();
                let names: Vec<String> = v["branches"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|b| b["name"].as_str().map(str::to_string))
                    .collect();
                let current = v["branches"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|b| b["current"] == true)
                    .and_then(|b| b["name"].as_str())
                    .map(str::to_string);
                let default = v["default"].as_str().map(str::to_string);
                if ld.branch.as_ref().is_none_or(|b| !names.contains(b)) {
                    ld.branch = current
                        .or_else(|| default.clone())
                        .or(names.first().cloned());
                }
                if ld.base.as_ref().is_none_or(|b| !names.contains(b)) {
                    ld.base = default;
                }
                ld.branch_root = v["root"].as_str().map(str::to_string);
                ld.repos = serde_json::from_value(v["repos"].clone()).unwrap_or_default();
                ld.branches = Some(v);
            },
        );
    }

    /// Branches are listed per repo, so the pair under review starts over in the new one.
    pub fn select_repo(&mut self, root: String) {
        let ld = &mut self.lens_data;
        if ld.branch_root.as_deref() == Some(root.as_str()) {
            return;
        }
        ld.branch_root = Some(root);
        ld.branches = None;
        ld.branch = None;
        ld.base = None;
        ld.picked.clear();
        ld.commits.clear();
        ld.diff_sig = None;
        ld.diff.set_files(Vec::new());
    }

    fn load_branch_diff(&mut self, id: String, sig: String) {
        let ld = &self.lens_data;
        let (Some(branch), Some(base), Some(root)) =
            (ld.branch.clone(), ld.base.clone(), ld.branch_root.clone())
        else {
            return;
        };
        let range = self.branch_range();
        let key = self.branch_key().unwrap_or_default();
        self.lens_data.diff_loading = true;
        self.spawn(
            move || {
                let mut path = format!(
                    "/api/session/vcs-branch?id={}&branch={}&base={}&root={}",
                    api::enc(&id),
                    api::enc(&branch),
                    api::enc(&base),
                    api::enc(&root)
                );
                if let Some((from, to)) = &range {
                    path.push_str(&format!("&from={}&to={}", api::enc(from), api::enc(to)));
                }
                api::get(&path)
            },
            move |s, r, _| {
                s.lens_data.diff_loading = false;
                s.lens_data.diff_sig = Some(sig);
                match r {
                    Ok(v) => {
                        if s.lens_data.picked.is_empty()
                            && let Some(c) = v["commits"].as_array()
                        {
                            s.lens_data.commits = c.clone();
                        }
                        let changes: Vec<Change> =
                            serde_json::from_value(v["changes"].clone()).unwrap_or_default();
                        s.lens_data.diff_count = changes.len();
                        let root = v["root"].as_str().map(str::to_string);
                        let (files, anchors) =
                            file_diffs(&changes, root.as_deref(), &format!("br:{key}"));
                        s.lens_data.diff.set_files(files);
                        s.lens_data.anchors = anchors;
                        s.annotate();
                        s.load_threads();
                    }
                    Err(e) => s.flash(format!("✗ Branch: {e}"), true),
                }
            },
        );
    }

    pub fn pick_commit(&mut self, rev: Option<String>) {
        let ld = &mut self.lens_data;
        match rev {
            None => ld.picked.clear(),
            Some(r) => {
                if let Some(i) = ld.picked.iter().position(|p| *p == r) {
                    ld.picked.remove(i);
                } else {
                    ld.picked.push(r);
                }
            }
        }
    }

    pub fn set_branch(&mut self, branch: Option<String>, base: Option<String>) {
        let ld = &mut self.lens_data;
        if branch.is_some() {
            ld.branch = branch;
        }
        if base.is_some() {
            ld.base = base;
        }
        ld.picked.clear();
        ld.commits.clear();
    }

    pub fn truncated_at(&self, file: usize) -> Option<String> {
        if self.lens_data.review_source != ReviewSource::Claude {
            return None;
        }
        let (path, _) = self.lens_data.anchors.get(file)?;
        let change = self
            .detail
            .as_ref()?
            .changes
            .iter()
            .find(|c| c.file == *path)?;
        (change.truncated && !matches!(self.lens_data.full.get(path), Some(Some(_))))
            .then(|| path.clone())
    }

    pub fn load_full_change(&mut self, path: String) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        if self.lens_data.full.contains_key(&path) {
            return;
        }
        self.lens_data.full.insert(path.clone(), None);
        self.spawn(
            {
                let path = path.clone();
                move || {
                    api::get(&format!(
                        "/api/session/file-changes?id={}&path={}",
                        api::enc(&id),
                        api::enc(&path)
                    ))
                }
            },
            move |s, r, _| {
                let change = r
                    .ok()
                    .and_then(|v| serde_json::from_value::<Change>(v["change"].clone()).ok());
                match change {
                    Some(c) => {
                        s.lens_data.full.insert(path, Some(c));
                    }
                    None => {
                        s.lens_data.full.remove(&path);
                        s.flash("✗ Could not load the full diff", true);
                    }
                }
            },
        );
    }

    /// Which revision a side of diff `file` comes from, when its line numbers are the file's.
    pub(crate) fn blame_rev(&self, file: usize, side: Side) -> Option<(String, String)> {
        let (path, key) = self.lens_data.anchors.get(file)?;
        let rev = match (self.lens_data.review_source, side) {
            (ReviewSource::Tree, Side::Old) => "HEAD",
            (ReviewSource::Tree | ReviewSource::Worktree, Side::New) => "",
            (ReviewSource::Worktree, Side::Old) => {
                self.lens_data.worktree.as_ref()?.merge_base.as_deref()?
            }
            (ReviewSource::Claude, Side::Old) | (ReviewSource::Branch, _) => return None,
            (ReviewSource::Claude, Side::New) => {
                let j: usize = key.strip_prefix("full:")?.parse().ok()?;
                let c = self
                    .detail
                    .as_ref()?
                    .changes
                    .iter()
                    .find(|c| c.file == *path)?;
                (c.ops.get(j)?["kind"] == "write").then_some("")?
            }
        };
        Some((path.clone(), rev.to_string()))
    }

    /// A click on a block of the rendered Markdown: select its source lines in the diff and
    /// scroll to them, as a click on their numbers would.
    pub fn show_md_source(
        &mut self,
        file: usize,
        side: Side,
        lines: std::ops::RangeInclusive<u32>,
        tx: &mut rune::Tx,
    ) {
        let start = LineRef::new(side, *lines.start());
        let sel = LineRange {
            file,
            start,
            end: LineRef::new(side, *lines.end()),
        };
        self.lens_data.diff.set_selection(Some(sel));
        self.lens_data.diff.scroll_to_line(file, start, tx);
        self.blame_line(Some(sel));
    }

    /// A click on a line number of the diff: when the rendered Markdown shows that file, centre
    /// the block the line belongs to.
    pub fn reveal_md_block(&self, sel: Option<LineRange>, tx: &mut rune::Tx) {
        let ld = &self.lens_data;
        let Some(sel) = sel.filter(|sel| ld.rendered && sel.file == ld.diff.visible_file()) else {
            return;
        };
        let Some(f) = ld
            .diff
            .files()
            .get(sel.file)
            .filter(|f| crate::mddiff::is_markdown(f.path()))
        else {
            return;
        };
        let pieces = crate::mddiff::file_pieces(f);
        if let Some(i) = crate::mddiff::piece_at(&pieces, sel.start.side, sel.start.line) {
            tx.scroll_center_in("review-rendered", format!("mdd-{i}"));
        }
    }

    pub fn blame_line(&mut self, sel: Option<LineRange>) {
        let Some(r) = sel else {
            self.lens_data.blame_at = None;
            return;
        };
        self.lens_data.blame_at = Some((r.file, r.start.side, r.start.line));
        let Some(key) = self.blame_rev(r.file, r.start.side) else {
            return;
        };
        let Some(id) = self.selected.clone() else {
            return;
        };
        if self.lens_data.blame.contains_key(&key) {
            return;
        }
        self.lens_data.blame.insert(key.clone(), None);
        let (file, rev) = key.clone();
        self.spawn(
            move || {
                api::get(&format!(
                    "/api/session/vcs-blame?id={}&file={}&rev={}",
                    api::enc(&id),
                    api::enc(&file),
                    api::enc(&rev)
                ))
            },
            move |s, r, _| {
                s.lens_data.blame.insert(key, r.ok());
            },
        );
    }

    /// The blame line for the clicked diff line: `None` while nothing applies, else the text.
    pub fn blame_text(&self) -> Option<String> {
        let (file, side, line) = self.lens_data.blame_at?;
        let Some(key) = self.blame_rev(file, side) else {
            return Some(format!(
                "L{line}: no blame here, these line numbers are not the file's"
            ));
        };
        let Some(Some(b)) = self.lens_data.blame.get(&key) else {
            return Some(format!("L{line}: reading git blame…"));
        };
        if b["supported"] != true {
            return Some(format!("L{line}: not in a git repository"));
        }
        let entry = &b["lines"][(line as usize).saturating_sub(1)];
        let shown = self.lens_data.diff.files().get(file).and_then(|f| {
            f.hunks
                .iter()
                .flat_map(|h| &h.lines)
                .find(|l| l.number(side) == Some(line))
                .map(|l| l.text.clone())
        });
        if entry.is_null() || shown.is_some_and(|t| entry["t"].as_str() != Some(t.as_str())) {
            return Some(format!("L{line}: not committed yet"));
        }
        let c = &b["commits"][entry["c"].as_u64().unwrap_or(0) as usize];
        if c["uncommitted"] == true {
            return Some(format!("L{line}: not committed yet"));
        }
        let when = c["time"]
            .as_i64()
            .map(|t| fmt::span(fmt::now_ms() - t * 1000, "") + " ago")
            .unwrap_or_default();
        Some(format!(
            "L{line} · {} · {} · {when} · {}",
            c["rev"].as_str().unwrap_or(""),
            c["author"].as_str().unwrap_or(""),
            c["summary"].as_str().unwrap_or("")
        ))
    }

    pub fn toggle_turn(&mut self, turn: Option<usize>) {
        let t = &mut self.lens_data.turns;
        match turn {
            None => t.clear(),
            Some(n) => {
                if !t.remove(&n) {
                    t.insert(n);
                }
            }
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
        let (scope, rev) = self.review_scope();
        let prompt = review_request_prompt(&id, &scope, rev.as_deref(), &files, &open, &dismissed);
        self.lens_data.asking = true;
        self.spawn(
            move || {
                api::post(
                    "/api/review",
                    json!({ "id": id, "action": "start", "scope": scope_key, "rev": rev }),
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
        if self.lens == Lens::Review
            && self.lens_data.review_source == ReviewSource::Worktree
            && self
                .detail
                .as_ref()
                .is_some_and(|d| d.session.worktree_of.is_none())
        {
            self.set_review_source(ReviewSource::Claude);
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
                    ReviewSource::Claude => {
                        format!(
                            "{id}|claude|{}|{activity}|{:?}|{}",
                            d.changes.len(),
                            ld.turns,
                            ld.full.values().filter(|c| c.is_some()).count()
                        )
                    }
                    ReviewSource::Worktree => format!("{id}|worktree|{activity}"),
                    ReviewSource::Tree => format!("{id}|tree|{activity}"),
                    ReviewSource::Branch => match self.branch_key() {
                        Some(key) => format!("{id}|branch|{key}|{activity}"),
                        None => {
                            if ld.branches.is_none() && !ld.branches_loading {
                                let root = ld.branch_root.clone();
                                self.load_branches(id, root);
                                return true;
                            }
                            return false;
                        }
                    },
                };
                if ld.diff_sig.as_deref() == Some(sig.as_str()) || ld.diff_loading {
                    return false;
                }
                match ld.review_source {
                    ReviewSource::Claude => {
                        let changes: Vec<Change> = d
                            .changes
                            .iter()
                            .map(|c| match ld.full.get(&c.file) {
                                Some(Some(full)) => full.clone(),
                                _ => c.clone(),
                            })
                            .collect();
                        let (files, anchors) = if ld.turns.is_empty() {
                            file_diffs(&changes, project.as_deref(), "full")
                        } else {
                            filtered_diffs(&changes, &d.change_turns, &ld.turns, project.as_deref())
                        };
                        self.lens_data.diff_count = d.changes.len();
                        self.lens_data.diff.set_files(files);
                        self.lens_data.anchors = anchors;
                        self.annotate();
                        self.lens_data.diff_sig = Some(sig);
                        self.load_threads();
                        true
                    }
                    ReviewSource::Branch => {
                        self.load_branch_diff(id, sig);
                        true
                    }
                    ReviewSource::Tree => {
                        self.lens_data.diff_loading = true;
                        self.spawn(
                            move || api::vcs_changes(&id),
                            move |s, r, _| {
                                s.lens_data.diff_loading = false;
                                s.lens_data.diff_sig = Some(sig);
                                match r {
                                    Ok(repos) => {
                                        s.lens_data.diff_count =
                                            repos.iter().map(|r| r.changes.len()).sum();
                                        let tree = tree_diffs(&repos, project.as_deref());
                                        s.lens_data.diff.set_files(tree.files);
                                        s.lens_data.anchors = tree.anchors;
                                        s.lens_data.file_repos = tree.repos;
                                        s.annotate();
                                        s.load_threads();
                                    }
                                    Err(e) => s.flash(format!("✗ Working tree: {e}"), true),
                                }
                            },
                        );
                        true
                    }
                    ReviewSource::Worktree => {
                        self.lens_data.diff_loading = true;
                        self.spawn(
                            move || api::vcs_base_diff(&id),
                            move |s, r, _| {
                                s.lens_data.diff_loading = false;
                                s.lens_data.diff_sig = Some(sig);
                                match r {
                                    Ok(wt) => {
                                        s.lens_data.diff_count = wt.changes.len();
                                        let (files, anchors) = file_diffs(
                                            &wt.changes,
                                            wt.root.as_deref(),
                                            &worktree_key(Some(&wt)),
                                        );
                                        s.lens_data.worktree = Some(wt);
                                        s.lens_data.diff.set_files(files);
                                        s.lens_data.anchors = anchors;
                                        s.annotate();
                                        s.load_threads();
                                    }
                                    Err(e) => s.flash(format!("✗ Worktree: {e}"), true),
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
                    self.spawn(
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
                self.spawn(
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
        self.spawn(
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
                s.spawn(
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
        self.spawn(
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
        if let Some(d) = ld.def.as_ref() {
            notes.push(Annotation::new(d.file, LineRef::new(d.side, d.line), "def"));
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
        self.spawn(
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
        let (scope, _) = self.review_scope();
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
        self.spawn(
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
            self.lens_data.file_repos.clear();
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
        self.spawn(
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
        self.spawn(
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
        self.spawn(
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
        self.spawn(
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
            self.spawn(
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
        self.spawn(
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

    fn repo(root: &str, label: &str, files: &[&str]) -> api::Repo {
        serde_json::from_value(json!({
            "root": root,
            "label": label,
            "changes": files.iter().map(|f| json!({ "file": f, "ops": [{ "old": "", "new": "x\n" }] })).collect::<Vec<_>>(),
        }))
        .unwrap()
    }

    #[test]
    fn working_tree_spans_every_repo_and_names_them_when_several() {
        let repos = [
            repo("/ws/api", "api", &["/ws/api/a.rs"]),
            repo("/ws/empty", "empty", &[]),
            repo("/ws/web", "web", &["/ws/web/b.ts", "/ws/web/c.ts"]),
        ];
        let tree = tree_diffs(&repos, Some("/ws"));
        let paths: Vec<&str> = tree.files.iter().map(|f| f.path()).collect();
        assert_eq!(paths, ["api/a.rs", "web/b.ts", "web/c.ts"]);
        assert_eq!(tree.repos, ["api", "web", "web"]);
        assert_eq!(
            tree.anchors[1],
            ("/ws/web/b.ts".to_string(), "vcs:wt:0".to_string())
        );
    }

    #[test]
    fn working_tree_of_a_single_repo_has_no_repo_headers() {
        let tree = tree_diffs(&[repo("/r", "", &["/r/a.rs"])], Some("/r"));
        assert_eq!(tree.files.len(), 1);
        assert!(tree.repos.is_empty());
    }

    #[test]
    fn primary_repo_is_named_after_its_folder() {
        assert_eq!(repo("/ws/hooked", "", &[]).name(), "hooked");
        assert_eq!(repo("/ws/hooked/sub", "sub", &[]).name(), "sub");
    }
}

#[cfg(test)]
mod prompt_tests {
    use super::*;

    #[test]
    fn prompt_filter_replays_from_the_original() {
        let turns = vec![
            ChangeTurn {
                turn: 0,
                ts: "a".into(),
                prompt: "one".into(),
            },
            ChangeTurn {
                turn: 1,
                ts: "c".into(),
                prompt: "two".into(),
            },
        ];
        let change = Change {
            file: "/r/x".into(),
            raw_ops: vec![
                json!({"kind": "edit", "old": "1", "new": "2", "ts": "b"}),
                json!({"kind": "edit", "old": "2", "new": "3", "ts": "d"}),
            ],
            original: Some("v1\n".replace('v', "")),
            ..Default::default()
        };
        let sel: std::collections::BTreeSet<usize> = [1].into();
        let (files, anchors) = filtered_diffs(&[change], &turns, &sel, Some("/r"));
        assert_eq!(anchors, [("/r/x".to_string(), "sel:1".to_string())]);
        assert_eq!(files[0].additions(), 1);
        assert_eq!(
            apply_op("aXa", &json!({"old": "a", "new": "b", "all": true})),
            "bXb"
        );
        let ten: std::collections::BTreeSet<usize> = [2, 10].into();
        assert_eq!(turns_key(&ten), "sel:10,2");
    }

    #[test]
    fn review_prompt_matches_the_web_brief() {
        let p = review_request_prompt(
            "abc",
            "your changes",
            None,
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
