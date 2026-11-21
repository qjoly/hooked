//! Occurrence echo in the Review lens, as the web's `DiffView`: selecting a bit of the diff
//! paints every occurrence of it in the diff (select "pro" and the "pro" in "professional"
//! lights up too). rune-kit's diff view takes no background for a range of a line, so the
//! occurrences change colour instead: the diff's syntax highlighter is swapped for one that
//! paints them in the accent over the usual colours, and swapped back when the selection
//! clears.
use std::ops::Range;

use rune::{Color, SelectionChange, TextSelection};
use rune_kit::syntax::{Highlight, Highlighter, Paint};

use crate::app::Hooked;

/// Past this many hits in one chunk of the diff, the rest stays plain (a one-letter needle in a
/// huge file).
const MAX_HITS: usize = 500;

/// What a selection echoes: one line of text, not blank, long enough to mean something.
pub fn needle(sel: &TextSelection) -> Option<String> {
    let t = sel.text();
    let n = t.chars().count();
    ((2..=200).contains(&n) && !t.trim().is_empty() && !t.contains(['\n', '\r']))
        .then(|| t.to_string())
}

/// `syntax` with every occurrence of `needle` in `code` painted `color`: the syntax ranges are
/// cut around the hits, so each byte keeps one paint.
pub fn paint(syntax: &[Highlight], code: &str, needle: &str, color: Color) -> Vec<Highlight> {
    if needle.is_empty() {
        return syntax.to_vec();
    }
    let hits: Vec<Range<usize>> = code
        .match_indices(needle)
        .take(MAX_HITS)
        .map(|(i, m)| i..i + m.len())
        .collect();
    if hits.is_empty() {
        return syntax.to_vec();
    }
    let mut out: Vec<Highlight> = Vec::with_capacity(syntax.len() + hits.len() * 2);
    for (r, p) in syntax {
        let mut start = r.start;
        let first = hits.partition_point(|h| h.end <= r.start);
        for h in hits[first..].iter().take_while(|h| h.start < r.end) {
            if h.start > start {
                out.push((start..h.start, *p));
            }
            start = start.max(h.end);
        }
        if start < r.end {
            out.push((start..r.end, *p));
        }
    }
    out.extend(hits.into_iter().map(|h| (h, Paint::Color(color))));
    out.sort_by_key(|(r, _)| r.start);
    out
}

/// The built-in highlighter with `needle`'s occurrences on top.
fn highlighter(needle: String, color: Color) -> Highlighter {
    let key = (
        needle.clone(),
        [color.r, color.g, color.b, color.a].map(f32::to_bits),
    );
    Highlighter::new(move |lang, code| {
        paint(&rune_kit::syntax::builtin(lang, code), code, &needle, color)
    })
    .key(key)
}

impl Hooked {
    /// The selection inside the Review diff changed: echo it once it settles (a drag repaints
    /// on release, not on every frame), and clear the echo with it.
    pub fn diff_selection_changed(&mut self, change: &SelectionChange) {
        if change.dragging() {
            return;
        }
        let want = change.selection().and_then(needle);
        if want == self.lens_data.echo {
            return;
        }
        let h = match &want {
            Some(n) => highlighter(
                n.clone(),
                crate::theme::kit(self.theme_dark.get()).c.text_accent,
            ),
            None => Highlighter::builtin(),
        };
        self.lens_data.diff.set_highlighter(h);
        self.lens_data.echo = want;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune_kit::syntax::Syntax;

    const HIT: Color = Color {
        r: 1.0,
        g: 0.0,
        b: 0.0,
        a: 1.0,
    };

    fn ranges(v: &[Highlight]) -> Vec<(Range<usize>, bool)> {
        v.iter()
            .map(|(r, p)| (r.clone(), *p == Paint::Color(HIT)))
            .collect()
    }

    #[test]
    fn every_occurrence_takes_the_colour_inside_words_too() {
        let code = "let pro = professional(pro);";
        let out = paint(&[], code, "pro", HIT);
        assert_eq!(ranges(&out), [(4..7, true), (10..13, true), (23..26, true)]);
    }

    #[test]
    fn syntax_colours_are_cut_around_the_hits() {
        // "card_width" as one Function token, the hit in its middle
        let code = "card_width(x)";
        let syntax = vec![(0..10, Paint::Kind(Syntax::Function))];
        let out = paint(&syntax, code, "_wi", HIT);
        assert_eq!(ranges(&out), [(0..4, false), (4..7, true), (7..10, false)]);
    }

    #[test]
    fn nothing_found_leaves_the_syntax_alone() {
        let syntax = vec![(0..3, Paint::Kind(Syntax::Keyword))];
        assert_eq!(paint(&syntax, "let x", "zzz", HIT), syntax);
        assert_eq!(paint(&syntax, "let x", "", HIT), syntax);
    }
}
