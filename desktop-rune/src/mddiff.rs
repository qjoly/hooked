//! The Review lens's rendered Markdown, as the web's `mdDiff.js`: both versions cut into the
//! blocks a reader sees (a top-level list into its items), the block lists diffed, and each
//! block kept as its own markdown.
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

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
    let mut out = Vec::new();
    let mut body = src.as_str();
    if let Some((end, yaml)) = front_matter(body) {
        out.push(Block {
            key: body[..end].trim_end().to_string(),
            text: format!("```yaml\n{yaml}\n```"),
        });
        body = &body[end..];
    }
    let mut depth = 0usize;
    let mut ordinal: Option<u64> = None;
    let mut list_depth = 0usize;
    for (ev, range) in Parser::new_ext(body, Options::all()).into_offset_iter() {
        match ev {
            Event::Start(tag) => {
                let piece = body[range.clone()].trim_end().to_string();
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
                        out.push(Block { key: piece, text });
                    }
                    (_, 0) => out.push(Block {
                        key: piece.clone(),
                        text: piece,
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
                let piece = body[range].trim_end().to_string();
                if !piece.is_empty() {
                    out.push(Block {
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
pub fn block_diff(old: &str, new: &str) -> Vec<(Kind, String)> {
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
            out.push((Kind::Ctx, b[j].text.clone()));
            i += 1;
            j += 1;
        } else if i < n && (j == m || lcs[i + 1][j] >= lcs[i][j + 1]) {
            out.push((Kind::Del, a[i].text.clone()));
            i += 1;
        } else {
            out.push((Kind::Add, b[j].text.clone()));
            j += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_items_are_their_own_blocks() {
        let b = blocks("# T\n\n- a\n- b\n\n1. x\n2. y\n\npara\n");
        let keys: Vec<&str> = b.iter().map(|b| b.text.as_str()).collect();
        assert_eq!(keys, ["# T", "- a", "- b", "1. x", "2. y", "para"]);
    }

    #[test]
    fn a_changed_bullet_alone_is_marked() {
        let d = block_diff("# T\n\n- a\n- b\n", "# T\n\n- a\n- c\n");
        assert_eq!(
            d,
            [
                (Kind::Ctx, "# T".into()),
                (Kind::Ctx, "- a".into()),
                (Kind::Del, "- b".into()),
                (Kind::Add, "- c".into()),
            ]
        );
    }

    #[test]
    fn front_matter_renders_as_yaml() {
        let b = blocks("---\ntitle: x\n---\n# H\n");
        assert_eq!(b[0].text, "```yaml\ntitle: x\n```");
        assert_eq!(b[1].text, "# H");
    }
}
