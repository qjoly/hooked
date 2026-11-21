//! Go to definition in the Review lens, as the web's `DefPeek`: the definition opens as a card
//! under the clicked line, never elsewhere. The repo is asked through hooked's
//! `/api/session/symbol` (git grep plus a ranking by locality and imports) and the lines come
//! from `/api/session/source`.
//!
//! rune-kit's diff view reports no clicked word, so the name comes from the text selection: a
//! ⌘-double-click selects it and opens its definition, and the selected text's element path says
//! which line it is on (see [`diff_line_of`]). The same gesture inside the card follows a name
//! of the definition shown, with a way back.
use rune::TextSelection;
use rune_kit::diff::{FileDiff, LineKind, LineRange, LineRef, Side};
use serde_json::Value;

use crate::{api, app::Hooked};

pub const PAD: u64 = 12;
pub const STEP: u64 = 20;
/// How many definitions deep the card follows names before it stops.
const MAX_DEPTH: usize = 8;

const KEYWORDS: &[&str] = &[
    "as",
    "async",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "crate",
    "def",
    "default",
    "do",
    "dyn",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "fn",
    "for",
    "from",
    "func",
    "function",
    "if",
    "impl",
    "import",
    "in",
    "interface",
    "let",
    "loop",
    "match",
    "mod",
    "mut",
    "new",
    "nil",
    "None",
    "null",
    "pub",
    "return",
    "self",
    "Self",
    "Some",
    "static",
    "struct",
    "super",
    "switch",
    "this",
    "throw",
    "trait",
    "true",
    "try",
    "type",
    "typeof",
    "undefined",
    "use",
    "var",
    "where",
    "while",
    "with",
    "yield",
    "Ok",
    "Err",
];

pub enum DefState {
    Choose,
    Loading,
    Note(String),
    List {
        items: Vec<Value>,
        refs_only: bool,
    },
    Source {
        target: Value,
        from: u64,
        to: u64,
        data: Option<Value>,
        err: Option<String>,
    },
}

pub struct DefPeek {
    pub file: usize,
    pub side: Side,
    pub line: u32,
    /// The file a name is looked up from: the diff's, then the definition's the card followed.
    pub path: String,
    pub rev: String,
    pub choices: Vec<String>,
    pub symbol: Option<String>,
    pub state: DefState,
    /// The definitions the card came through, the last one first to go back to.
    pub trail: Vec<Hop>,
}

/// A definition the card showed before following one of its names.
pub struct Hop {
    pub path: String,
    pub symbol: Option<String>,
    pub target: Value,
}

/// A row of rune-kit's diff from its element key (`DiffState::key_of`): the file and the line
/// number its key carries, with `c` for an unchanged line (its old number), `o` a removed one
/// (or a removed and added pair in split mode) and `n` an added one.
fn row_key(seg: &str) -> Option<(usize, char, u32)> {
    let (f, rest) = seg.strip_prefix("df")?.split_once('.')?;
    let kind = rest
        .chars()
        .next()
        .filter(|c| matches!(c, 'c' | 'o' | 'n'))?;
    let n = &rest[1..];
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    (digits(f) && digits(n)).then_some((f.parse().ok()?, kind, n.parse().ok()?))
}

/// The line holding a selected text of the Review diff, from the text's element path: its row's
/// key and, in split mode, the half it is in. `None` outside the code of a line (a comment
/// thread, the definition card).
pub fn diff_line_of(files: &[FileDiff], path: &str) -> Option<(usize, Side, u32)> {
    let segs: Vec<&str> = path.split('/').collect();
    let at = segs.iter().position(|s| row_key(s).is_some())?;
    let (f, kind, n) = row_key(segs[at])?;
    let after = &segs[at + 1..];
    if !after.contains(&"code") || after.iter().any(|s| *s == "notes" || s.starts_with("a.")) {
        return None;
    }
    let half = after.iter().find_map(|s| match *s {
        "old" => Some(Side::Old),
        "new" => Some(Side::New),
        _ => None,
    });
    let file = files.get(f)?;
    let line = match (kind, half) {
        ('n', _) => (Side::New, n),
        ('o', Some(Side::New)) => (Side::New, paired_addition(file, n)?),
        ('o', _) => (Side::Old, n),
        ('c', Some(Side::Old)) => (Side::Old, n),
        _ => (Side::New, unchanged_new(file, n)),
    };
    Some((f, line.0, line.1))
}

/// The added line split mode draws beside removed line `old`: the k-th removed line of a run
/// pairs with the k-th added line that follows it.
fn paired_addition(file: &FileDiff, old: u32) -> Option<u32> {
    file.hunks.iter().find_map(|h| {
        let l = &h.lines;
        let i = l
            .iter()
            .position(|x| x.kind == LineKind::Removed && x.old == Some(old))?;
        let start = l[..i]
            .iter()
            .rposition(|x| x.kind != LineKind::Removed)
            .map_or(0, |p| p + 1);
        let adds = l[i..]
            .iter()
            .position(|x| x.kind != LineKind::Removed)
            .map_or(l.len(), |p| i + p);
        l.get(adds + (i - start))
            .filter(|x| x.kind == LineKind::Added)
            .and_then(|x| x.new)
    })
}

/// The new number of unchanged line `old`: read off its hunk, else shifted by what the hunks
/// above it added and removed.
fn unchanged_new(file: &FileDiff, old: u32) -> u32 {
    if let Some(n) = file
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .find(|l| l.kind == LineKind::Context && l.old == Some(old))
        .and_then(|l| l.new)
    {
        return n;
    }
    // A hunk's numbers start at the line before it when it holds none of that side.
    let end = |start: u32, count: u32| if count == 0 { start + 1 } else { start + count };
    file.hunks
        .iter()
        .take_while(|h| end(h.old_start, h.old_count) <= old)
        .last()
        .map_or(old, |h| {
            let shift =
                i64::from(end(h.new_start, h.new_count)) - i64::from(end(h.old_start, h.old_count));
            (i64::from(old) + shift).max(1) as u32
        })
}

pub fn is_ident(s: &str) -> bool {
    let mut c = s.chars();
    c.next()
        .is_some_and(|f| f.is_alphabetic() || f == '_' || f == '$')
        && c.all(|ch| ch.is_alphanumeric() || ch == '_' || ch == '$')
}

/// The identifiers a line mentions, in order, keywords and one-letter names left out.
pub fn identifiers(line: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_str: Option<char> = None;
    let flush = |cur: &mut String, out: &mut Vec<String>| {
        if cur.chars().count() > 1
            && is_ident(cur)
            && !KEYWORDS.contains(&cur.as_str())
            && !out.contains(cur)
        {
            out.push(cur.clone());
        }
        cur.clear();
    };
    for ch in line.chars() {
        if let Some(q) = in_str {
            if ch == q {
                in_str = None;
            }
            continue;
        }
        if ch == '"' || ch == '\'' || ch == '`' {
            flush(&mut cur, &mut out);
            in_str = Some(ch);
        } else if ch.is_alphanumeric() || ch == '_' || ch == '$' {
            if cur.is_empty() && ch.is_ascii_digit() {
                continue;
            }
            cur.push(ch);
        } else {
            flush(&mut cur, &mut out);
        }
    }
    flush(&mut cur, &mut out);
    out
}

impl Hooked {
    fn diff_line_text(&self, file: usize, side: Side, line: u32) -> Option<String> {
        let f = self.lens_data.diff.files().get(file)?;
        f.hunks
            .iter()
            .flat_map(|h| &h.lines)
            .find(|l| match side {
                Side::New => l.new == Some(line),
                Side::Old => l.old == Some(line),
            })
            .map(|l| l.text.clone())
    }

    fn def_target_path(&self, file: usize, side: Side) -> Option<(String, String)> {
        if let Some(found) = self.blame_rev(file, side) {
            return Some(found);
        }
        let (path, _) = self.lens_data.anchors.get(file)?;
        let path = match self.lens_data.branch_root.as_deref() {
            Some(root) if !path.starts_with('/') => {
                format!("{}/{path}", root.trim_end_matches('/'))
            }
            _ => path.clone(),
        };
        Some((path, String::new()))
    }

    /// ⌘-click on a diff line: straight to `word` when one is selected, else a card asking which
    /// of the line's names to look up.
    pub fn def_click(&mut self, sel: LineRange, word: Option<String>) {
        let (file, side, line) = (sel.file, sel.start.side, sel.start.line);
        let Some((path, rev)) = self.def_target_path(file, side) else {
            return;
        };
        let choices = self
            .diff_line_text(file, side, line)
            .map(|t| identifiers(&t))
            .unwrap_or_default();
        let word = word.filter(|w| is_ident(w));
        self.lens_data.def = Some(DefPeek {
            file,
            side,
            line,
            path,
            rev,
            choices,
            symbol: None,
            state: DefState::Choose,
            trail: Vec::new(),
        });
        if let Some(w) = word {
            self.def_lookup(w);
        } else if self
            .lens_data
            .def
            .as_ref()
            .is_some_and(|d| d.choices.len() == 1)
        {
            let only = self.lens_data.def.as_ref().unwrap().choices[0].clone();
            self.def_lookup(only);
        }
        self.annotate();
    }

    /// A name selected in the diff or in the card (⌘-double-click, F12): its definition opens
    /// under the line it was selected on, or the card follows it from the definition it shows.
    /// False when the selection is no single name, or not in either.
    pub fn def_from_selection(&mut self, sel: &TextSelection) -> bool {
        let word = sel.text().trim();
        let Some(piece) = sel.texts().iter().find(|t| t.is_selected()) else {
            return false;
        };
        if !is_ident(word) {
            return false;
        }
        if piece.path().split('/').any(|s| s == "a.def") {
            return self.def_dive(word.to_string());
        }
        let Some((file, side, line)) = diff_line_of(self.lens_data.diff.files(), piece.path())
        else {
            return false;
        };
        // Opening the card moves the selected text under a new parent, which is heard as a
        // new selection: the card already open on it stays as it is.
        let open = self.lens_data.def.as_ref().is_some_and(|d| {
            (d.file, d.side, d.line) == (file, side, line)
                && d.trail.is_empty()
                && d.symbol.as_deref() == Some(word)
        });
        if open {
            return true;
        }
        self.def_click(
            LineRange::line(file, LineRef::new(side, line)),
            Some(word.to_string()),
        );
        true
    }

    /// F12 on a name selected in the code: its line is the last clicked one when it holds the
    /// name, else the visible file's first diff line that does.
    pub fn def_selected(&mut self, word: &str) {
        if !is_ident(word) {
            return;
        }
        let holds = |t: &str| identifiers(t).iter().any(|w| w == word);
        let clicked = self.lens_data.blame_at.filter(|&(f, side, line)| {
            self.diff_line_text(f, side, line)
                .is_some_and(|t| holds(&t))
        });
        let found = clicked.or_else(|| {
            let f = self.lens_data.diff.visible_file();
            self.lens_data
                .diff
                .files()
                .get(f)?
                .hunks
                .iter()
                .flat_map(|h| &h.lines)
                .find_map(|l| {
                    let (side, n) = match (l.new, l.old) {
                        (Some(n), _) => (Side::New, n),
                        (None, Some(n)) => (Side::Old, n),
                        _ => return None,
                    };
                    holds(&l.text).then_some((f, side, n))
                })
        });
        let Some((file, side, line)) = found else {
            return;
        };
        let at = rune_kit::diff::LineRef::new(side, line);
        self.def_click(
            LineRange {
                file,
                start: at,
                end: at,
            },
            Some(word.to_string()),
        );
    }

    pub fn def_lookup(&mut self, symbol: String) {
        let (Some(id), Some(d)) = (self.selected.clone(), self.lens_data.def.as_mut()) else {
            return;
        };
        d.symbol = Some(symbol.clone());
        d.state = DefState::Loading;
        let (path, rev) = (d.path.clone(), d.rev.clone());
        let at = (d.file, d.side, d.line);
        self.spawn(
            move || {
                api::get(&format!(
                    "/api/session/symbol?id={}&symbol={}&file={}&rev={}",
                    api::enc(&id),
                    api::enc(&symbol),
                    api::enc(&path),
                    api::enc(&rev)
                ))
            },
            move |s, r, _| {
                let Some(d) = s
                    .lens_data
                    .def
                    .as_mut()
                    .filter(|d| (d.file, d.side, d.line) == at)
                else {
                    return;
                };
                let word = d.symbol.clone().unwrap_or_default();
                d.state = match r {
                    Err(e) => DefState::Note(format!("Lookup failed: {e}")),
                    Ok(v) if v["supported"] != true => DefState::Note(if v["timedOut"] == true {
                        "Lookup timed out.".into()
                    } else {
                        "No repository to search.".into()
                    }),
                    Ok(v) if v["origin"].is_object() => DefState::Note(format!(
                        "{word} comes from {}, not in this repo.",
                        v["origin"]["specifier"].as_str().unwrap_or("a dependency")
                    )),
                    Ok(v) if v["jump"].is_object() => source_state(v["jump"].clone()),
                    Ok(v) => {
                        let decls = v["declarations"].as_array().cloned().unwrap_or_default();
                        let refs = v["references"].as_array().cloned().unwrap_or_default();
                        if decls.len() == 1 {
                            source_state(decls[0].clone())
                        } else if !decls.is_empty() {
                            DefState::List {
                                items: decls,
                                refs_only: false,
                            }
                        } else if !refs.is_empty() {
                            DefState::List {
                                items: refs,
                                refs_only: true,
                            }
                        } else {
                            DefState::Note(format!("No declaration of {word} found."))
                        }
                    }
                };
                s.def_load_source();
            },
        );
    }

    pub fn def_pick(&mut self, target: Value) {
        if let Some(d) = self.lens_data.def.as_mut() {
            d.state = source_state(target);
        }
        self.def_load_source();
    }

    pub fn def_back(&mut self) {
        let Some(d) = self.lens_data.def.as_mut() else {
            return;
        };
        if let Some(first) = d.trail.drain(..).next() {
            d.path = first.path;
        }
        d.state = DefState::Choose;
        d.symbol = None;
    }

    /// Follows `word` from the definition the card shows, looked up from that definition's
    /// file. False when the card shows no definition or has gone deep enough.
    fn def_dive(&mut self, word: String) -> bool {
        let Some(d) = self.lens_data.def.as_mut() else {
            return false;
        };
        let DefState::Source { target, .. } = &d.state else {
            return false;
        };
        let Some(file) = target["file"].as_str().filter(|f| !f.is_empty()) else {
            return false;
        };
        if d.trail.len() >= MAX_DEPTH || d.symbol.as_deref() == Some(word.as_str()) {
            return false;
        }
        let hop = Hop {
            path: std::mem::replace(&mut d.path, file.to_string()),
            symbol: d.symbol.clone(),
            target: target.clone(),
        };
        d.trail.push(hop);
        self.def_lookup(word);
        true
    }

    /// Back to the definition the card showed before following a name.
    pub fn def_up(&mut self) {
        let Some(d) = self.lens_data.def.as_mut() else {
            return;
        };
        let Some(hop) = d.trail.pop() else {
            return;
        };
        d.path = hop.path;
        d.symbol = hop.symbol;
        d.state = source_state(hop.target);
        self.def_load_source();
    }

    pub fn def_expand(&mut self, up: bool) {
        let Some(DefState::Source { from, to, data, .. }) =
            self.lens_data.def.as_mut().map(|d| &mut d.state)
        else {
            return;
        };
        let total = data
            .as_ref()
            .and_then(|v| v["total"].as_u64())
            .unwrap_or(u64::MAX);
        if up {
            *from = from.saturating_sub(STEP).max(1);
        } else {
            *to = (*to + STEP).min(total);
        }
        self.def_load_source();
    }

    fn def_load_source(&mut self) {
        let (Some(id), Some(d)) = (self.selected.clone(), self.lens_data.def.as_ref()) else {
            return;
        };
        let DefState::Source {
            target, from, to, ..
        } = &d.state
        else {
            return;
        };
        let file = target["file"].as_str().unwrap_or("").to_string();
        let (rev, from, to) = (d.rev.clone(), *from, *to);
        let at = (d.file, d.side, d.line);
        self.spawn(
            move || {
                api::get(&format!(
                    "/api/session/source?id={}&file={}&rev={}&from={from}&to={to}",
                    api::enc(&id),
                    api::enc(&file),
                    api::enc(&rev)
                ))
            },
            move |s, r, _| {
                let Some(DefState::Source { data, err, .. }) = s
                    .lens_data
                    .def
                    .as_mut()
                    .filter(|d| (d.file, d.side, d.line) == at)
                    .map(|d| &mut d.state)
                else {
                    return;
                };
                match r {
                    Ok(v) if v["supported"] == true => {
                        *data = Some(v);
                        *err = None;
                    }
                    Ok(_) => *err = Some("This file is not readable from here.".into()),
                    Err(e) => *err = Some(format!("Could not load the file: {e}")),
                }
            },
        );
    }

    pub fn close_def(&mut self) {
        if self.lens_data.def.take().is_some() {
            self.annotate();
        }
    }
}

fn source_state(target: Value) -> DefState {
    let line = target["line"].as_u64().unwrap_or(1);
    DefState::Source {
        target,
        from: line.saturating_sub(PAD).max(1),
        to: line + PAD,
        data: None,
        err: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_names_its_identifiers_once_without_keywords_or_strings() {
        assert_eq!(
            identifiers(r#"    let card_w = card_width(width, "not_this", x2);"#),
            ["card_w", "card_width", "width", "x2"]
        );
        assert_eq!(
            identifiers("pub fn view(s: &Hooked) -> El {"),
            ["view", "Hooked", "El"]
        );
        assert!(is_ident("launchSession") && !is_ident("a b") && !is_ident("9x"));
    }

    const PATCH: &str = "diff --git a/a.rs b/a.rs
--- a/a.rs
+++ b/a.rs
@@ -1,4 +1,5 @@
 fn one() {}
-fn two() {}
-fn three() {}
+fn deux() {}
+fn trois() {}
+fn quatre() {}
 fn four() {}
@@ -20,2 +21,2 @@
 fn twenty() {}
-fn x() {}
+fn y() {}
";

    #[test]
    fn a_selected_text_names_its_line_from_its_row_key() {
        let files = rune_kit::diff::parse(PATCH);
        let at = |p: &str| diff_line_of(&files, &format!("review/diff/scroll/rows/{p}"));
        // unified: added and removed lines, a row with annotations under it
        assert_eq!(at("df0.n3/code/text"), Some((0, Side::New, 3)));
        assert_eq!(at("df0.o2/code/text"), Some((0, Side::Old, 2)));
        assert_eq!(at("df0.n3/line/code/text"), Some((0, Side::New, 3)));
        // unchanged lines go by their new number, in a hunk or between two
        assert_eq!(at("df0.c4/code/text"), Some((0, Side::New, 5)));
        assert_eq!(at("df0.c10/code/text"), Some((0, Side::New, 11)));
        assert_eq!(at("df0.c25/code/text"), Some((0, Side::New, 26)));
        // split: a pair's halves, an unchanged line's old half
        assert_eq!(at("df0.o2/old/code/text"), Some((0, Side::Old, 2)));
        assert_eq!(at("df0.o2/new/code/text"), Some((0, Side::New, 2)));
        assert_eq!(at("df0.o3/new/code/text"), Some((0, Side::New, 3)));
        assert_eq!(at("df0.c10/old/code/text"), Some((0, Side::Old, 10)));
        // not the code of a line
        assert_eq!(at("df0.n3/notes/new/a.def/x/text"), None);
        assert_eq!(at("df0.g1/text"), None);
        assert_eq!(at("df0.note/text"), None);
        assert_eq!(at("df1.n3/code/text"), None);
    }

    mod headless {
        use super::super::diff_line_of;
        use super::PATCH;
        use rune::{Cx, El, Env, Runtime, col};
        use rune_kit::Kit;
        use rune_kit::diff::{DiffMode, DiffState, DiffView, Side, parse};

        struct App {
            diff: DiffState,
            heard: Vec<Option<(usize, Side, u32)>>,
        }

        /// The Review lens's arrangement: the diff inside an element that hears its selection.
        fn view(s: &App, _: &mut Cx<App>) -> El {
            let k = Kit::neutral(true);
            col()
                .w_full()
                .h_full()
                .on_selection_change(|s: &mut App, change, _| {
                    if change.dragging() {
                        return;
                    }
                    let at = change.selection().and_then(|sel| {
                        let t = sel.texts().iter().find(|t| t.is_selected())?;
                        diff_line_of(s.diff.files(), t.path())
                    });
                    s.heard.push(at);
                })
                .child(DiffView::new(|s: &App| &s.diff, |s: &mut App| &mut s.diff).build(s, &k))
        }

        fn double_click(rt: &mut Runtime<App>, end: &str) {
            let e = rt
                .elements()
                .into_iter()
                .find(|e| e.path.ends_with(end) && !e.exiting)
                .unwrap_or_else(|| panic!("no {end}"));
            let (x, y) = (e.rect[0] + 4.0, e.rect[1] + e.rect[3] / 2.0);
            // Hovering a line's code makes its side the selectable one, as the pointer does on
            // its way to a removed line.
            rt.pointer_move(x, y);
            rt.frame(1.0 / 60.0);
            for _ in 0..2 {
                rt.pointer_down(x, y);
                rt.pointer_up(x, y);
                rt.frame(1.0 / 60.0);
            }
            rt.frame(1.0 / 60.0);
        }

        fn runtime(mode: DiffMode) -> Runtime<App> {
            let mut diff = DiffState::new(parse(PATCH));
            diff.set_mode(mode);
            let app = App {
                diff,
                heard: Vec::new(),
            };
            let mut rt = Runtime::new(app, view, (900.0, 600.0), Env::new(true, 2.0));
            for _ in 0..10 {
                rt.frame(1.0 / 60.0);
            }
            rt
        }

        #[test]
        fn a_double_clicked_word_is_heard_on_its_line() {
            let mut rt = runtime(DiffMode::Unified);
            double_click(&mut rt, "/df0.n3/code/text");
            assert_eq!(rt.state.heard.last(), Some(&Some((0, Side::New, 3))));
            double_click(&mut rt, "/df0.o2/code/text");
            assert_eq!(rt.state.heard.last(), Some(&Some((0, Side::Old, 2))));

            let mut rt = runtime(DiffMode::Split);
            double_click(&mut rt, "/df0.o3/new/code/text");
            assert_eq!(rt.state.heard.last(), Some(&Some((0, Side::New, 3))));
            double_click(&mut rt, "/df0.c4/old/code/text");
            assert_eq!(rt.state.heard.last(), Some(&Some((0, Side::Old, 4))));
        }
    }
}
