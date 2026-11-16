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

/// What a branch diff says about its pair, beside the changes.
#[derive(Clone, Debug, Default, serde::Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct BranchInfo {
    /// `git` or `jj`.
    pub vcs: Option<String>,
    /// Where the branch forked from its base.
    pub merge_base: Option<String>,
    /// The branch is already in its base: the diff, when there is one, was recovered from the
    /// merge commit.
    pub merged: bool,
    /// The commits the diff is narrowed to, when some are picked.
    pub range: Option<BranchSlice>,
}

/// A contiguous slice of a branch's commits: the diff runs from `parent` to `to`.
#[derive(Clone, Debug, Default, serde::Deserialize, PartialEq)]
#[serde(default)]
pub struct BranchSlice {
    pub from: String,
    pub to: String,
    pub parent: String,
}

impl BranchInfo {
    /// The revision a side of the branch diff comes from, for blame and definitions: the fork
    /// point (else the base branch) to the branch head, or the ends of the reviewed commits.
    /// None under jj, whose revisions git cannot read.
    pub fn rev<'a>(
        &'a self,
        side: Side,
        branch: Option<&'a str>,
        base: Option<&'a str>,
    ) -> Option<&'a str> {
        if self.vcs.as_deref() == Some("jj") {
            return None;
        }
        let rev = match (side, self.range.as_ref()) {
            (Side::Old, Some(r)) => r.parent.as_str(),
            (Side::New, Some(r)) => r.to.as_str(),
            (Side::Old, None) => self.merge_base.as_deref().or(base)?,
            (Side::New, None) => branch?,
        };
        (!rev.is_empty()).then_some(rev)
    }
}

pub struct LensData {
    pub review_source: ReviewSource,
    pub diff: DiffState,
    pub diff_sig: Option<String>,
    pub diff_loading: bool,
    /// Why the last load failed; shown in place of the diff when there is none on screen.
    pub diff_error: Option<String>,
    /// The working-tree diff found no repository under the session's directory.
    pub no_vcs: bool,
    /// The working-tree diff hit the file limit, so some files are not listed.
    pub tree_truncated: bool,
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
    pub branch_info: BranchInfo,
    pub branch_open: bool,
    pub turns_open: bool,
    pub anchors: Vec<(String, String)>,
    pub threads: Vec<Value>,
    /// Where each live thread shows in the diff on screen, by thread id.
    pub placed: HashMap<String, Placed>,
    /// The thread to reveal once the scope it was written on is back on screen.
    pub jump: Option<String>,
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
            diff_error: None,
            no_vcs: false,
            tree_truncated: false,
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
            branch_info: BranchInfo::default(),
            branch_open: false,
            turns_open: false,
            anchors: Vec::new(),
            threads: Vec::new(),
            placed: HashMap::new(),
            jump: None,
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

/// Where a review thread shows in the diff on screen.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placed {
    pub file: usize,
    pub side: Side,
    pub start: u32,
    pub end: u32,
    /// Its code changed or is gone, so no line can be trusted: the thread shows at the head of
    /// the file instead of under a wrong line.
    pub outdated: bool,
}

impl Placed {
    pub fn label(&self) -> String {
        range_label(self.side == Side::Old, self.start.into(), self.end.into())
    }
}

/// The lines of a side as threads number them, without the `\r` of a CRLF file.
fn side_lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect()
}

/// The web's `reanchor`: a thread's anchor is trusted only while the snippet it was written on
/// is still there. A snippet found once elsewhere takes its thread along; one that is gone, or
/// found several times, makes the thread outdated. Returns `(start, end, outdated)`.
pub fn reanchor(start: u32, end: u32, snippet: &str, lines: &[&str]) -> (u32, u32, bool) {
    if snippet.is_empty() {
        return (start, end, false);
    }
    let snip = side_lines(snippet);
    let n = snip.len();
    let matches_at = |i: usize| i + n <= lines.len() && lines[i..i + n] == snip[..];
    if start >= 1 && matches_at(start as usize - 1) {
        return (start, start - 1 + n as u32, false);
    }
    let mut hits = (0..lines.len().saturating_sub(n - 1)).filter(|&i| matches_at(i));
    match (hits.next(), hits.next()) {
        (Some(i), None) => (i as u32 + 1, (i + n) as u32, false),
        _ => (start, end, true),
    }
}

/// The section of the diff a thread belongs to and its lines there, re-anchored on its snippet.
/// A thread Claude opened is keyed to the whole scope (`…:*`): it goes to the section of its
/// file whose new side holds its snippet, else to the first.
pub fn place_thread(t: &Value, anchors: &[(String, String)], files: &[FileDiff]) -> Option<Placed> {
    let (file, key) = (t["file"].as_str()?, t["opIndex"].as_str()?);
    let scoped = key.strip_suffix(":*");
    let snippet = t["snippet"].as_str().unwrap_or("");
    let mut sections = anchors
        .iter()
        .enumerate()
        .filter(|(_, (f, k))| {
            f == file
                && match scoped {
                    Some(base) => k.starts_with(&format!("{base}:")),
                    None => k == key,
                }
        })
        .map(|(i, _)| i);
    let first = sections.next()?;
    let holds = |i: &usize| {
        files
            .get(*i)
            .and_then(|f| f.text(Side::New))
            .is_some_and(|text| text.contains(snippet))
    };
    let i = if scoped.is_some() && !snippet.is_empty() && !holds(&first) {
        sections.find(holds).unwrap_or(first)
    } else {
        first
    };
    let side = if t["side"] == "old" {
        Side::Old
    } else {
        Side::New
    };
    let start = t["start"].as_u64().unwrap_or(1) as u32;
    let end = t["end"].as_u64().map_or(start, |e| e as u32);
    let (start, end, outdated) = match files.get(i)?.text(side) {
        Some(text) => reanchor(start, end, snippet, &side_lines(text)),
        None => (start, end, false),
    };
    Some(Placed {
        file: i,
        side,
        start,
        end,
        outdated,
    })
}

/// Lines `a..=b` of a side of `f`: the snippet a new thread is anchored on. Read from the whole
/// text, so lines shown by opening a folded range count too.
pub fn snippet_of(f: &FileDiff, side: Side, a: u32, b: u32) -> String {
    let Some(text) = f.text(side) else {
        return f
            .hunks
            .iter()
            .flat_map(|h| h.lines.iter())
            .filter(|l| l.number(side).is_some_and(|n| n >= a && n <= b))
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
    };
    let lines = side_lines(text);
    let from = (a.saturating_sub(1) as usize).min(lines.len());
    let to = (b.max(a) as usize).min(lines.len());
    lines[from..to].join("\n")
}

/// What the lens says in place of a diff: that it is loading, why it could not be read, or why
/// there is nothing to show.
pub fn empty_message(ld: &LensData) -> String {
    const NO_VCS: &str = "This project is not in a git or jj repository.";
    const BRANCHES: &str = "Loading the branches…";
    let branch = ld.review_source == ReviewSource::Branch;
    if ld.diff_loading {
        return match ld.review_source {
            ReviewSource::Branch => "Loading the branch diff…",
            ReviewSource::Worktree => "Loading the worktree diff…",
            _ => "Loading the working-tree diff…",
        }
        .into();
    }
    if branch && ld.branches_loading {
        return BRANCHES.into();
    }
    if let Some(e) = &ld.diff_error {
        return e.clone();
    }
    match ld.review_source {
        ReviewSource::Branch => match ld.branches.as_ref() {
            None => BRANCHES,
            Some(v) if v["vcs"].is_null() => NO_VCS,
            Some(v) if v["branches"].as_array().is_none_or(Vec::is_empty) => {
                "No local branches in this repository."
            }
            Some(_) => {
                let (b, base) = (
                    ld.branch.as_deref().unwrap_or_default(),
                    ld.base.as_deref().unwrap_or_default(),
                );
                return if b == base {
                    "The branch and the base are the same: pick another base to compare against."
                        .into()
                } else if !ld.picked.is_empty() {
                    format!(
                        "The selected {} no file: pick another slice of {b}.",
                        if ld.picked.len() == 1 {
                            "commit changes"
                        } else {
                            "commits change"
                        }
                    )
                } else if ld.branch_info.merged {
                    format!(
                        "Branch {b} is already merged into {base} (squash or fast-forward: no historical diff to recover)."
                    )
                } else {
                    format!(
                        "No difference between {b} and {base}: the branch has no commits of its own yet."
                    )
                };
            }
        },
        ReviewSource::Tree if ld.no_vcs => NO_VCS,
        ReviewSource::Tree => "No uncommitted changes in the working tree.",
        ReviewSource::Worktree => match ld.worktree.as_ref() {
            None => "Loading the worktree diff…",
            Some(w) if w.base.is_none() => "No base recorded for this worktree.",
            Some(w) if w.merge_base.is_none() => {
                "No common history with the base to compare against."
            }
            Some(_) => "Nothing changed since this worktree forked from its base.",
        },
        ReviewSource::Claude => "No file changes in this session yet.",
    }
    .into()
}

const GONE_FROM_DIFF: &str = "That comment's file is no longer in this diff";
pub const UNREACHABLE: &str = "Written on a diff no scope can show any more: archive or delete it";

/// The scope a thread was written on. Its `opIndex` is the key of a diff section, so it also
/// records which scope (and prompt filter, or branch pair and commit slice) produced it:
/// `full:<j>`, `sel:<turns>[:<j>]`, `vcs:wt:<j>`, `wtb:<base>:<j>`,
/// `br:<repo>:<base>:<branch>[:@from..to]:<j>`, with `*` for `<j>` on a thread Claude opened.
#[derive(Clone, Debug, PartialEq)]
pub enum ThreadContext {
    Claude {
        turns: Vec<usize>,
    },
    Tree,
    Worktree,
    Branch {
        root: String,
        base: String,
        branch: String,
        range: Option<(String, String)>,
    },
}

/// The web's `threadContext`. `None` for a key no scope produces any more.
pub fn thread_context(op: &str) -> Option<ThreadContext> {
    if let Some(rest) = op.strip_prefix("br:") {
        // Read from the right: a repo path may hold a colon, a branch name may not, and the
        // commit slice is known by the '@' no branch name can carry.
        let mut parts: Vec<&str> = rest.split(':').collect();
        let section = parts.pop()?;
        if section != "*" && (section.is_empty() || !section.bytes().all(|b| b.is_ascii_digit())) {
            return None;
        }
        let range = match parts.last().and_then(|p| p.strip_prefix('@')) {
            Some(slice) => {
                parts.pop();
                let (from, to) = slice.split_once("..")?;
                if from.is_empty() || to.is_empty() {
                    return None;
                }
                Some((from.to_string(), to.to_string()))
            }
            None => None,
        };
        let (branch, base) = (parts.pop()?, parts.pop()?);
        let root = parts.join(":");
        if root.is_empty() || base.is_empty() || branch.is_empty() {
            return None;
        }
        return Some(ThreadContext::Branch {
            root,
            base: base.to_string(),
            branch: branch.to_string(),
            range,
        });
    }
    if op == "vcs:wt" || op.starts_with("vcs:wt:") {
        return Some(ThreadContext::Tree);
    }
    if op.starts_with("wtb:") {
        return Some(ThreadContext::Worktree);
    }
    if op.starts_with("full:") {
        return Some(ThreadContext::Claude { turns: Vec::new() });
    }
    let turns = op.strip_prefix("sel:")?.split(':').next()?;
    Some(ThreadContext::Claude {
        turns: turns.split(',').filter_map(|t| t.parse().ok()).collect(),
    })
}

/// The first line a file's diff shows, where its outdated threads go.
fn head_line(f: &FileDiff) -> Option<LineRef> {
    let l = f.hunks.first()?.lines.first()?;
    match (l.new, l.old) {
        (Some(n), _) => Some(LineRef::new(Side::New, n)),
        (None, Some(n)) => Some(LineRef::new(Side::Old, n)),
        (None, None) => None,
    }
}

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

/// A line range as both lenses label it: `+L12`, `−L3–7`.
fn range_label(old: bool, a: u64, b: u64) -> String {
    let side = if old { "−L" } else { "+L" };
    if a == b || b == 0 {
        format!("{side}{a}")
    } else {
        format!("{side}{a}–{b}")
    }
}

/// Where a thread was anchored when it was written.
pub fn anchor_label(t: &Value) -> String {
    range_label(
        t["side"] == "old",
        t["start"].as_u64().unwrap_or(0),
        t["end"].as_u64().unwrap_or(0),
    )
}

/// The web's `threadInstructions`, word for word: how Claude answers in a review thread.
pub fn thread_instructions(session: &str) -> String {
    let api = format!("{}/api/review", api::base());
    format!(
        "Reply in the thread with the hooked MCP tool mcp__hooked__reply_review_comment \
         (id: \"{session}\", thread_id above). Do NOT close the thread — closing is the reviewer's \
         call, and there is no tool for it. If that MCP tool is unavailable, POST the same reply to \
         the local hooked API instead: curl -sS -X POST {api} -H 'content-type: application/json' \
         -d '{{\"id\":\"{session}\",\"action\":\"reply\",\"threadId\":\"<thread_id>\",\"text\":\"<your reply>\",\"author\":\"claude\"}}'. \
         Keep your chat answer to a one-line summary — the details belong in the thread."
    )
}

/// What the session is told when the reviewer answers in a thread, as the web lens words it.
pub fn follow_up_prompt(session: &str, thread: &Value, text: &str) -> String {
    format!(
        "Follow-up on review thread {} — {} ({}):\n> {}\n{}",
        thread["id"].as_str().unwrap_or(""),
        thread["file"].as_str().unwrap_or(""),
        anchor_label(thread),
        text.replace('\n', "\n> "),
        thread_instructions(session)
    )
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
    /// Until the commit list is in (a comment's scope being restored), the picks are trusted as
    /// given, so the first fetch is already the narrowed one.
    pub fn branch_range(&self) -> Option<(String, String)> {
        let ld = &self.lens_data;
        if ld.commits.is_empty() {
            return Some((ld.picked.first()?.clone(), ld.picked.last()?.clone()));
        }
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
                // Claude reads the new side with `git show <rev>:<path>`, which a jj revision
                // is not: there it reviews the file on disk.
                let git = ld.branch_info.vcs.as_deref() != Some("jj");
                match self.branch_range() {
                    Some((from, to)) => (
                        format!(
                            "commits `{}`…`{}` of branch `{b}` (based on `{base}`)",
                            &from[..from.len().min(7)],
                            &to[..to.len().min(7)]
                        ),
                        git.then_some(to),
                    ),
                    None => (
                        format!("the full diff of branch `{b}` against `{base}`"),
                        git.then_some(b),
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
                if let Err(e) = &r {
                    s.load_failed("the branches", e);
                }
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
        self.lens_data.branch_info = BranchInfo::default();
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
                        let ld = &mut s.lens_data;
                        ld.diff_error = None;
                        ld.branch_info = serde_json::from_value(v.clone()).unwrap_or_default();
                        // The list is the branch's, whatever slice was asked for: every answer
                        // refreshes it, and a pick the branch no longer has (rewritten since)
                        // is dropped.
                        if let Some(c) = v["commits"].as_array() {
                            ld.commits = c.clone();
                            ld.picked.retain(|p| {
                                c.iter().any(|x| x["rev"].as_str() == Some(p.as_str()))
                            });
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
                    Err(e) => s.load_failed("the branch diff", &e),
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
        let ld = &self.lens_data;
        let (path, key) = ld.anchors.get(file)?;
        let rev = match (ld.review_source, side) {
            (ReviewSource::Tree, Side::Old) => "HEAD",
            (ReviewSource::Tree | ReviewSource::Worktree, Side::New) => "",
            (ReviewSource::Worktree, Side::Old) => ld.worktree.as_ref()?.merge_base.as_deref()?,
            (ReviewSource::Branch, side) => {
                ld.branch_info
                    .rev(side, ld.branch.as_deref(), ld.base.as_deref())?
            }
            (ReviewSource::Claude, Side::Old) => return None,
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
        let brief = |t: &Value| ReviewBrief {
            file: t["file"].as_str().unwrap_or("").to_string(),
            anchor: anchor_label(t),
            text: t["messages"][0]["text"].as_str().unwrap_or("").to_string(),
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
                                    Ok(found) => {
                                        let ld = &mut s.lens_data;
                                        ld.diff_error = None;
                                        ld.no_vcs = found.repos.is_empty();
                                        ld.tree_truncated = found.truncated;
                                        ld.diff_count =
                                            found.repos.iter().map(|r| r.changes.len()).sum();
                                        let tree = tree_diffs(&found.repos, project.as_deref());
                                        ld.diff.set_files(tree.files);
                                        ld.anchors = tree.anchors;
                                        ld.file_repos = tree.repos;
                                        s.annotate();
                                        s.load_threads();
                                    }
                                    Err(e) => s.load_failed("the working-tree diff", &e),
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
                                        s.lens_data.diff_error = None;
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
                                    Err(e) => s.load_failed("the worktree diff", &e),
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
    /// Archived threads are out of the diff: they live in the comments panel, restorable.
    pub fn annotate(&mut self) {
        let ld = &mut self.lens_data;
        let mut notes = Vec::new();
        ld.placed.clear();
        for t in ld.threads.iter().filter(|t| t["status"] != "archived") {
            let files = ld.diff.files();
            let Some(p) = place_thread(t, &ld.anchors, files) else {
                continue;
            };
            let at = if p.outdated {
                head_line(&files[p.file])
            } else {
                Some(LineRef::new(p.side, p.end))
            };
            let (Some(at), Some(id)) = (at, t["id"].as_str()) else {
                continue;
            };
            notes.push(Annotation::new(p.file, at, id));
            ld.placed.insert(id.to_string(), p);
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
        let snippet = self
            .lens_data
            .diff
            .files()
            .get(range.file)
            .map(|f| snippet_of(f, side, a, b))
            .unwrap_or_default();
        let thread = json!({
            "file": file,
            "name": file.rsplit('/').next().unwrap_or(&file),
            "opIndex": key,
            "side": if side == Side::Old { "old" } else { "new" },
            "start": a,
            "end": b,
            "snippet": snippet,
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

    /// A reply is stored in its thread, then goes to the session at once with the thread's id,
    /// so Claude answers back into the same thread.
    pub fn reply_thread(&mut self, tid: String) {
        let Some(d) = self.detail.as_ref() else {
            return;
        };
        let (id, live, effort) = (
            d.session.id.clone(),
            d.session.live,
            d.session.effort.clone(),
        );
        let text = self
            .lens_data
            .replies
            .remove(&tid)
            .map(|e| e.text.trim().to_string())
            .unwrap_or_default();
        if text.is_empty() {
            return;
        }
        let prompt = self
            .lens_data
            .threads
            .iter()
            .find(|t| t["id"].as_str() == Some(tid.as_str()))
            .map(|t| follow_up_prompt(&id, t, &text));
        self.spawn(
            move || {
                api::post(
                    "/api/review",
                    json!({ "id": id, "action": "reply", "threadId": tid, "text": text, "author": "user" }),
                )?;
                match prompt {
                    Some(p) if live => api::reply(&id, &p),
                    Some(p) => api::resume(&id, &p, effort.as_deref()),
                    None => Ok(()),
                }
            },
            |s, r, _| {
                if let Err(e) = r {
                    s.flash(format!("✗ Reply: {e}"), true);
                }
                s.load_threads();
                s.refresh_detail();
            },
        );
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

    /// Scrolls to a thread of the diff on screen; false when it is not in it.
    fn reveal_thread(&mut self, tid: &str, tx: &mut rune::Tx) -> bool {
        let ld = &mut self.lens_data;
        let Some(p) = ld.placed.get(tid).copied() else {
            return false;
        };
        let at = if p.outdated {
            ld.diff.files().get(p.file).and_then(head_line)
        } else {
            Some(LineRef::new(p.side, p.start))
        };
        if let Some(at) = at {
            ld.diff.scroll_to_line(p.file, at, tx);
        }
        true
    }

    /// A click on a row of the comments panel. A thread written on another scope (or prompt
    /// filter, or branch pair) is reached by putting that scope back first; `resolve_jump`
    /// scrolls to it once its diff is on screen.
    pub fn jump_to_thread(&mut self, tid: &str, tx: &mut rune::Tx) {
        if self.reveal_thread(tid, tx) {
            return;
        }
        let Some(op) = self
            .lens_data
            .threads
            .iter()
            .find(|t| t["id"].as_str() == Some(tid))
            .and_then(|t| t["opIndex"].as_str())
            .map(str::to_string)
        else {
            return;
        };
        let base = self.review_key_base();
        if op == base || op.starts_with(&format!("{base}:")) {
            self.flash(GONE_FROM_DIFF, true);
            return;
        }
        if thread_context(&op).is_some_and(|ctx| self.restore_context(ctx)) {
            self.lens_data.jump = Some(tid.to_string());
        } else {
            self.flash(UNREACHABLE, true);
        }
    }

    /// Puts back the scope a thread was written on; false when this session cannot show it.
    fn restore_context(&mut self, ctx: ThreadContext) -> bool {
        let Some(d) = self.detail.as_ref() else {
            return false;
        };
        let id = d.session.id.clone();
        let in_worktree = d.session.worktree_of.is_some();
        match ctx {
            ThreadContext::Claude { turns } => {
                self.set_review_source(ReviewSource::Claude);
                self.lens_data.turns = turns.into_iter().collect();
            }
            ThreadContext::Tree => self.set_review_source(ReviewSource::Tree),
            ThreadContext::Worktree if in_worktree => {
                self.set_review_source(ReviewSource::Worktree)
            }
            ThreadContext::Worktree => return false,
            ThreadContext::Branch {
                root,
                base,
                branch,
                range,
            } => {
                self.set_review_source(ReviewSource::Branch);
                let ld = &mut self.lens_data;
                // The branch list is per repo: another repo, or a scope never opened, reads it.
                let list =
                    ld.branches.is_none() || ld.branch_root.as_deref() != Some(root.as_str());
                ld.branch_root = Some(root.clone());
                ld.branch = Some(branch);
                ld.base = Some(base);
                ld.picked = match range {
                    Some((from, to)) if from == to => vec![from],
                    Some((from, to)) => vec![from, to],
                    None => Vec::new(),
                };
                ld.commits.clear();
                if list {
                    self.load_branches(id, Some(root));
                }
            }
        }
        self.lens_data.diff_sig = None;
        true
    }

    /// Run on every poll: reveals the thread a jump is waiting on once its scope's diff is in.
    pub fn resolve_jump(&mut self, tx: &mut rune::Tx) -> bool {
        let ld = &mut self.lens_data;
        if ld.jump.is_none() {
            return false;
        }
        if self.page != Page::Session || self.lens != Lens::Review {
            ld.jump = None;
            return false;
        }
        if ld.diff_loading || ld.branches_loading || ld.diff_sig.is_none() {
            return false;
        }
        let tid = ld.jump.take().unwrap_or_default();
        if !self.reveal_thread(&tid, tx) {
            self.flash(GONE_FROM_DIFF, true);
        }
        true
    }

    /// Sends the unsent comments as one prompt, in the shape the web lens uses. The lens stays
    /// open: Claude's answers land in the threads on screen.
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
                let anchor = anchor_label(t);
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
        let prompt = format!(
            "I reviewed {scope} and left the following inline comments. Address each one, then, for each: {}\n\n{}",
            thread_instructions(&id),
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
                    Ok(()) => s.flash("✓ Comments sent to Claude", false),
                    Err(e) => s.flash(format!("✗ Send: {e}"), true),
                }
                s.load_threads();
                s.refresh_detail();
            },
        );
    }

    /// Reads the diff on screen again. The working tree, the worktree and the branches are
    /// snapshots that only follow the session: an edit by hand or a commit from a terminal
    /// leaves them stale.
    pub fn reload_review(&mut self) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        let ld = &mut self.lens_data;
        ld.diff_sig = None;
        ld.diff_error = None;
        if ld.review_source == ReviewSource::Branch && !ld.branches_loading {
            let root = ld.branch_root.clone();
            self.load_branches(id, root);
        }
    }

    /// A diff (or the branch list) could not be read. With nothing on screen the lens says so
    /// in place of the diff; a diff already there stays, the failure is only flashed.
    fn load_failed(&mut self, what: &str, e: &str) {
        let msg = format!("Could not load {what}: {e}");
        if !self.lens_data.diff.files().is_empty() {
            self.flash(format!("✗ {msg}"), true);
        }
        self.lens_data.diff_error = Some(msg);
        self.lens_data.jump = None;
    }

    pub fn set_review_source(&mut self, src: ReviewSource) {
        if self.lens_data.review_source != src {
            let ld = &mut self.lens_data;
            ld.review_source = src;
            ld.diff_sig = None;
            ld.diff_error = None;
            ld.no_vcs = false;
            ld.tree_truncated = false;
            ld.diff.set_files(Vec::new());
            ld.file_repos.clear();
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
    fn a_thread_follows_its_snippet_or_turns_outdated() {
        let lines = ["a", "b", "c", "b", "d"];
        // still where it was written
        assert_eq!(reanchor(3, 3, "c", &lines), (3, 3, false));
        // moved: found once elsewhere, a two-line snippet keeps its length
        assert_eq!(reanchor(1, 2, "c\nb", &lines), (3, 4, false));
        // gone, or found several times: no line can be trusted
        assert_eq!(reanchor(1, 1, "zz", &lines), (1, 1, true));
        assert_eq!(reanchor(5, 5, "b", &lines), (5, 5, true));
        // no snippet to check against: the stored anchor stands
        assert_eq!(reanchor(9, 9, "", &lines), (9, 9, false));
        // a snippet longer than the side
        assert_eq!(reanchor(1, 1, "a\nb\nc\nb\nd\ne", &lines), (1, 1, true));
    }

    #[test]
    fn threads_are_placed_on_the_section_and_lines_they_belong_to() {
        let anchors = vec![
            ("/r/a.rs".to_string(), "full:0".to_string()),
            ("/r/a.rs".to_string(), "full:1".to_string()),
            ("/r/b.rs".to_string(), "full:0".to_string()),
        ];
        let files = vec![
            FileDiff::from_texts("a.rs · edit 1/2", "one\n", "one\ntwo\n"),
            FileDiff::from_texts("a.rs · edit 2/2", "x\r\ny\r\n", "x\r\nnew\r\ny\r\n"),
            FileDiff::from_texts("b.rs", "", "b\n"),
        ];
        let thread = |key: &str, start: u32, snippet: &str| json!({ "file": "/r/a.rs", "opIndex": key, "side": "new", "start": start, "end": start, "snippet": snippet });
        let at =
            |t: &Value| place_thread(t, &anchors, &files).map(|p| (p.file, p.start, p.outdated));
        // its own section, and the line its code moved to (a CRLF file reads the same)
        assert_eq!(at(&thread("full:1", 2, "y")), Some((1, 3, false)));
        // a thread Claude opened goes to the section whose new side holds its code
        assert_eq!(at(&thread("full:*", 2, "new")), Some((1, 2, false)));
        assert_eq!(at(&thread("full:*", 2, "two")), Some((0, 2, false)));
        // code that is gone
        assert_eq!(at(&thread("full:0", 1, "gone")), Some((0, 1, true)));
        // another scope's thread is not in this diff
        assert_eq!(at(&thread("vcs:wt:0", 1, "one")), None);
        assert_eq!(snippet_of(&files[1], Side::New, 2, 3), "new\ny");
        assert_eq!(head_line(&files[2]), Some(LineRef::new(Side::New, 1)));
    }

    #[test]
    fn an_empty_diff_says_why() {
        let mut ld = LensData {
            review_source: ReviewSource::Tree,
            ..Default::default()
        };
        assert_eq!(
            empty_message(&ld),
            "No uncommitted changes in the working tree."
        );
        ld.no_vcs = true;
        assert_eq!(
            empty_message(&ld),
            "This project is not in a git or jj repository."
        );
        // a failed load is not a clean tree, and a load in flight comes first
        ld.diff_error = Some("Could not load the working-tree diff: timeout".into());
        assert_eq!(
            empty_message(&ld),
            "Could not load the working-tree diff: timeout"
        );
        ld.diff_loading = true;
        assert_eq!(empty_message(&ld), "Loading the working-tree diff…");

        let mut ld = LensData {
            review_source: ReviewSource::Branch,
            ..Default::default()
        };
        assert_eq!(empty_message(&ld), "Loading the branches…");
        ld.branches = Some(json!({ "vcs": null, "branches": [] }));
        assert_eq!(
            empty_message(&ld),
            "This project is not in a git or jj repository."
        );
        ld.branches = Some(json!({ "vcs": "git", "branches": [] }));
        assert_eq!(empty_message(&ld), "No local branches in this repository.");

        ld.branches = Some(json!({ "vcs": "git", "branches": [{ "name": "main" }] }));
        (ld.branch, ld.base) = (Some("feat/a".into()), Some("main".into()));
        assert_eq!(
            empty_message(&ld),
            "No difference between feat/a and main: the branch has no commits of its own yet."
        );
        ld.branch_info = serde_json::from_value(json!({
            "vcs": "git", "mergeBase": null, "merged": true, "range": null, "changes": []
        }))
        .unwrap();
        assert!(empty_message(&ld).starts_with("Branch feat/a is already merged into main"));
        ld.picked = vec!["abc".into()];
        assert_eq!(
            empty_message(&ld),
            "The selected commit changes no file: pick another slice of feat/a."
        );
        ld.base = Some("feat/a".into());
        assert!(empty_message(&ld).starts_with("The branch and the base are the same"));
    }

    #[test]
    fn a_branch_diff_names_the_revision_of_each_side() {
        let info = |v: Value| serde_json::from_value::<BranchInfo>(v).unwrap();
        let (branch, base) = (Some("feat/a"), Some("main"));
        // the whole branch: fork point → branch head
        let whole = info(json!({ "vcs": "git", "mergeBase": "f0", "range": null }));
        assert_eq!(whole.rev(Side::Old, branch, base), Some("f0"));
        assert_eq!(whole.rev(Side::New, branch, base), Some("feat/a"));
        // histories with nothing in common: the base branch itself
        let unrelated = info(json!({ "vcs": "git", "mergeBase": null }));
        assert_eq!(unrelated.rev(Side::Old, branch, base), Some("main"));
        // some commits: the parent of the oldest → the newest
        let slice = info(json!({
            "vcs": "git", "mergeBase": "f0", "range": { "from": "c1", "to": "c3", "parent": "c0" }
        }));
        assert_eq!(slice.rev(Side::Old, branch, base), Some("c0"));
        assert_eq!(slice.rev(Side::New, branch, base), Some("c3"));
        // a jj revision is not one git can blame
        let jj = info(json!({ "vcs": "jj", "mergeBase": null }));
        assert_eq!(jj.rev(Side::New, branch, base), None);
    }

    #[test]
    fn a_thread_key_names_the_scope_it_was_written_on() {
        use ThreadContext::*;
        let claude = |turns: &[usize]| {
            Some(Claude {
                turns: turns.to_vec(),
            })
        };
        assert_eq!(thread_context("full:2"), claude(&[]));
        assert_eq!(thread_context("full:*"), claude(&[]));
        assert_eq!(thread_context("sel:10,2"), claude(&[10, 2]));
        assert_eq!(thread_context("sel:3:1"), claude(&[3]));
        assert_eq!(thread_context("vcs:wt:0"), Some(Tree));
        assert_eq!(thread_context("wtb:origin/main:4"), Some(Worktree));
        // read from the right: the repo path may hold a colon
        assert_eq!(
            thread_context("br:/r:x/repo:main:feat/a:0"),
            Some(Branch {
                root: "/r:x/repo".into(),
                base: "main".into(),
                branch: "feat/a".into(),
                range: None,
            })
        );
        assert_eq!(
            thread_context("br:/repo:main:feat/a:@abc..def:*"),
            Some(Branch {
                root: "/repo".into(),
                base: "main".into(),
                branch: "feat/a".into(),
                range: Some(("abc".into(), "def".into())),
            })
        );
        // the retired per-commit view, and keys cut short
        assert_eq!(thread_context("vcs:/repo:abc123:0"), None);
        assert_eq!(thread_context("br:/repo:main:feat/a"), None);
        assert_eq!(thread_context("br:main:feat/a:0"), None);
        assert_eq!(thread_context("br:/repo:main:feat/a:@abc:0"), None);
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

    #[test]
    fn a_thread_reply_tells_claude_where_to_answer() {
        let t = json!({ "id": "t9", "file": "/r/a.rs", "side": "old", "start": 3, "end": 5 });
        let p = follow_up_prompt("abc", &t, "why?\nreally");
        assert!(p.starts_with(
            "Follow-up on review thread t9 — /r/a.rs (−L3–5):\n> why?\n> really\nReply in the thread"
        ));
        assert!(p.contains("mcp__hooked__reply_review_comment (id: \"abc\", thread_id above)"));
        assert!(
            p.contains("-d '{\"id\":\"abc\",\"action\":\"reply\",\"threadId\":\"<thread_id>\"")
        );
        assert!(p.ends_with("the details belong in the thread."));
        assert_eq!(
            anchor_label(&json!({ "side": "new", "start": 7, "end": 7 })),
            "+L7"
        );
    }
}
