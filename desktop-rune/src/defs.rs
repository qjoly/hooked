//! Go to definition in the Review lens, as the web's `DefPeek`: the definition opens as a card
//! under the clicked line, never elsewhere. The repo is asked through hooked's
//! `/api/session/symbol` (git grep plus a ranking by locality and imports) and the lines come
//! from `/api/session/source`.
use rune_kit::diff::{LineRange, Side};
use serde_json::Value;

use crate::{api, app::Hooked};

pub const PAD: u64 = 12;
pub const STEP: u64 = 20;

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
    pub path: String,
    pub rev: String,
    pub choices: Vec<String>,
    pub symbol: Option<String>,
    pub state: DefState,
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
        d.state = DefState::Choose;
        d.symbol = None;
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
}
