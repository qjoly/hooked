//! The Review lens's rendered Markdown, as the web's `mdDiff.js`: both versions cut into the
//! blocks a reader sees (a top-level list into its items), the block lists diffed, and each
//! block kept as its own markdown, with the source lines it was cut from so a click on a block
//! finds its lines in the diff, and a click on a line finds its block.
use std::ops::RangeInclusive;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use rune_kit::diff::{FileDiff, LineRange, Side};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Ctx,
    Add,
    Del,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Block {
    pub key: String,
    pub text: String,
    /// The source lines it was cut from, 1-based.
    pub lines: RangeInclusive<u32>,
}

/// A block of the rendered diff, with the source lines it was cut from on each side it is on:
/// both for an unchanged block, the new side for an added one, the old side for a removed one.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Piece {
    pub kind: Kind,
    pub text: String,
    pub old: Option<RangeInclusive<u32>>,
    pub new: Option<RangeInclusive<u32>>,
}

impl Piece {
    pub fn lines(&self, side: Side) -> Option<&RangeInclusive<u32>> {
        match side {
            Side::Old => self.old.as_ref(),
            Side::New => self.new.as_ref(),
        }
    }

    /// The lines a click on it selects in the diff: on the new side, unless it was removed.
    pub fn source(&self) -> Option<(Side, RangeInclusive<u32>)> {
        let new = self.new.clone().map(|r| (Side::New, r));
        new.or_else(|| self.old.clone().map(|r| (Side::Old, r)))
    }
}

pub fn is_markdown(path: &str) -> bool {
    let p = path.split(" · ").next().unwrap_or(path).to_lowercase();
    p.ends_with(".md") || p.ends_with(".markdown") || p.ends_with(".mdx")
}

fn front_matter(src: &str) -> Option<(usize, &str)> {
    let rest = src.strip_prefix("---")?;
    let first = rest.find('\n')?;
    if !rest[..first].trim().is_empty() {
        return None;
    }
    let body = &rest[first + 1..];
    let mut at = 0;
    for line in body.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Some((
                3 + first + 1 + at + line.len(),
                &body[..at.saturating_sub(1)],
            ));
        }
        at += line.len();
    }
    None
}

pub fn blocks(src: &str) -> Vec<Block> {
    let src = src.replace("\r\n", "\n");
    let breaks: Vec<usize> = src.match_indices('\n').map(|(i, _)| i).collect();
    let line_of = |at: usize| breaks.partition_point(|&b| b < at) as u32 + 1;
    // The lines of `piece`, found at byte `at` of the source.
    let lines_of =
        |at: usize, piece: &str| line_of(at)..=line_of(at + piece.len().saturating_sub(1));
    let mut out = Vec::new();
    let mut body = src.as_str();
    if let Some((end, yaml)) = front_matter(body) {
        let key = body[..end].trim_end().to_string();
        out.push(Block {
            lines: lines_of(0, &key),
            key,
            text: format!("```yaml\n{yaml}\n```"),
        });
        body = &body[end..];
    }
    let base = src.len() - body.len();
    let mut depth = 0usize;
    let mut ordinal: Option<u64> = None;
    let mut list_depth = 0usize;
    for (ev, range) in Parser::new_ext(body, Options::all()).into_offset_iter() {
        match ev {
            Event::Start(tag) => {
                let piece = body[range.clone()].trim_end().to_string();
                let lines = lines_of(base + range.start, &piece);
                match (&tag, depth) {
                    (Tag::List(start), 0) => {
                        ordinal = *start;
                        list_depth = 1;
                    }
                    (Tag::Item, 1) if list_depth == 1 => {
                        let text = match ordinal.as_mut() {
                            Some(n) => {
                                let t = renumber(&piece, *n);
                                *n += 1;
                                t
                            }
                            None => piece.clone(),
                        };
                        out.push(Block {
                            key: piece,
                            text,
                            lines,
                        });
                    }
                    (_, 0) => out.push(Block {
                        key: piece.clone(),
                        text: piece,
                        lines,
                    }),
                    _ => {}
                }
                depth += 1;
            }
            Event::End(end) => {
                depth = depth.saturating_sub(1);
                if depth == 0 && matches!(end, TagEnd::List(_)) {
                    list_depth = 0;
                }
            }
            Event::Rule | Event::Html(_) | Event::Text(_) if depth == 0 => {
                let piece = body[range.clone()].trim_end().to_string();
                if !piece.is_empty() {
                    out.push(Block {
                        lines: lines_of(base + range.start, &piece),
                        key: piece.clone(),
                        text: piece,
                    });
                }
            }
            _ => {}
        }
    }
    out
}

fn renumber(item: &str, n: u64) -> String {
    let lead = item.len() - item.trim_start().len();
    let digits = item[lead..]
        .chars()
        .take_while(char::is_ascii_digit)
        .count();
    if digits == 0 {
        return item.to_string();
    }
    format!("{}{n}{}", &item[..lead], &item[lead + digits..])
}

/// The new version's blocks in order, each removed block just before what replaced it.
pub fn block_diff(old: &str, new: &str) -> Vec<Piece> {
    let (a, b) = (blocks(old), blocks(new));
    let (n, m) = (a.len(), b.len());
    let mut lcs = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i].key == b[j].key {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut out = Vec::new();
    while i < n || j < m {
        if i < n && j < m && a[i].key == b[j].key {
            out.push(Piece {
                kind: Kind::Ctx,
                text: b[j].text.clone(),
                old: Some(a[i].lines.clone()),
                new: Some(b[j].lines.clone()),
            });
            i += 1;
            j += 1;
        } else if i < n && (j == m || lcs[i + 1][j] >= lcs[i][j + 1]) {
            out.push(Piece {
                kind: Kind::Del,
                text: a[i].text.clone(),
                old: Some(a[i].lines.clone()),
                new: None,
            });
            i += 1;
        } else {
            out.push(Piece {
                kind: Kind::Add,
                text: b[j].text.clone(),
                old: None,
                new: Some(b[j].lines.clone()),
            });
            j += 1;
        }
    }
    out
}

/// `f`'s rendered diff: its two texts, else the lines its hunks hold.
pub fn file_pieces(f: &FileDiff) -> Vec<Piece> {
    let side_text = |side: Side| {
        f.text(side).map(str::to_string).unwrap_or_else(|| {
            f.hunks
                .iter()
                .flat_map(|h| &h.lines)
                .filter(|l| l.number(side).is_some())
                .map(|l| l.text.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
    };
    block_diff(&side_text(Side::Old), &side_text(Side::New))
}

/// The piece that shows line `line` of `side`: the last one starting at or before it, so a
/// blank line between two blocks goes with the block above.
pub fn piece_at(pieces: &[Piece], side: Side, line: u32) -> Option<usize> {
    pieces
        .iter()
        .rposition(|p| p.lines(side).is_some_and(|r| *r.start() <= line))
}

/// The pieces a line selection of the diff spans.
pub fn covered(pieces: &[Piece], sel: LineRange) -> Option<RangeInclusive<usize>> {
    let a = piece_at(pieces, sel.start.side, sel.start.line)?;
    let b = piece_at(pieces, sel.end.side, sel.end.line)?;
    Some(a.min(b)..=a.max(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune_kit::diff::LineRef;

    #[test]
    fn list_items_are_their_own_blocks() {
        let b = blocks("# T\n\n- a\n- b\n\n1. x\n2. y\n\npara\n");
        let keys: Vec<&str> = b.iter().map(|b| b.text.as_str()).collect();
        assert_eq!(keys, ["# T", "- a", "- b", "1. x", "2. y", "para"]);
    }

    #[test]
    fn a_changed_bullet_alone_is_marked() {
        let d = block_diff("# T\n\n- a\n- b\n", "# T\n\n- a\n- c\n");
        let kinds: Vec<(Kind, &str)> = d.iter().map(|p| (p.kind, p.text.as_str())).collect();
        assert_eq!(
            kinds,
            [
                (Kind::Ctx, "# T"),
                (Kind::Ctx, "- a"),
                (Kind::Del, "- b"),
                (Kind::Add, "- c"),
            ]
        );
    }

    #[test]
    fn front_matter_renders_as_yaml() {
        let b = blocks("---\ntitle: x\n---\n# H\n");
        assert_eq!(b[0].text, "```yaml\ntitle: x\n```");
        assert_eq!(b[1].text, "# H");
    }

    #[test]
    fn blocks_keep_their_source_lines() {
        let b = blocks("---\ntitle: x\n---\n# T\n\n- a\n- b\n  more\n\npara\nnext\n");
        let lines: Vec<_> = b.iter().map(|b| b.lines.clone()).collect();
        assert_eq!(lines, [1..=3, 4..=4, 6..=6, 7..=8, 10..=11]);
    }

    #[test]
    fn pieces_carry_the_lines_of_each_side_they_are_on() {
        let d = block_diff("# T\n\nold\n", "# T\n\nintro\n\nnew\n");
        let sides: Vec<_> = d.iter().map(|p| (p.old.clone(), p.new.clone())).collect();
        assert_eq!(
            sides,
            [
                (Some(1..=1), Some(1..=1)),
                (Some(3..=3), None),
                (None, Some(3..=3)),
                (None, Some(5..=5)),
            ]
        );
        assert_eq!(d[1].source(), Some((Side::Old, 3..=3)));
        assert_eq!(d[0].source(), Some((Side::New, 1..=1)));
    }

    #[test]
    fn a_line_finds_the_block_it_belongs_to() {
        let d = block_diff("\n# T\n\nold\n", "\n# T\n\npara\nline\n\nnew\n");
        // Inside a block, on its last line, on the blank line after it, and before any block.
        assert_eq!(piece_at(&d, Side::New, 2), Some(0));
        assert_eq!(piece_at(&d, Side::New, 5), Some(2));
        assert_eq!(piece_at(&d, Side::New, 6), Some(2));
        assert_eq!(piece_at(&d, Side::New, 7), Some(3));
        assert_eq!(piece_at(&d, Side::New, 1), None);
        // The old side skips what was added and finds what was removed.
        assert_eq!(piece_at(&d, Side::Old, 4), Some(1));
        assert_eq!(piece_at(&d, Side::Old, 9), Some(1));
    }

    #[test]
    fn a_selection_lights_up_the_blocks_it_spans() {
        let d = block_diff("# T\n\na\n\nb\n", "# T\n\na\n\nb\n");
        let sel = |a: u32, b: u32| LineRange {
            file: 0,
            start: LineRef::new(Side::New, a),
            end: LineRef::new(Side::New, b),
        };
        assert_eq!(covered(&d, sel(3, 3)), Some(1..=1));
        assert_eq!(covered(&d, sel(5, 1)), Some(0..=2));
    }
}
