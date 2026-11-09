use rune::{Color, Cursor, El, Span, col, el, memo, rich, row, text};
use rune_kit::{IconButton, IconButtonVariant, Kit};

use super::glyph;
use crate::app::Hooked;
use crate::ghostty::{CursorShape, Line};
use crate::icons;
use crate::terminal::Term;

/// The line's text and spans with `marks` (column range, ink, fill) painted over them; marks
/// win over the cells' own colours, and pad the line with spaces when they reach past its end.
fn painted(line: &Line, marks: &[(u16, u16, Option<Color>, Color)]) -> (String, Vec<Span>) {
    let mut text = line.text.clone();
    let mut spans = line.spans.clone();
    for &(c0, c1, ink, fill) in marks {
        let (a, b) = line.byte_range(c0, c1);
        if text.len() < b {
            text.push_str(&" ".repeat(b - text.len()));
        }
        let (a32, b32) = (a as u32, b as u32);
        let mut kept = Vec::with_capacity(spans.len() + 2);
        for sp in spans {
            if sp.end <= a32 || sp.start >= b32 {
                kept.push(sp);
                continue;
            }
            if sp.start < a32 {
                let mut left = sp.clone();
                left.end = a32;
                kept.push(left);
            }
            if sp.end > b32 {
                let mut right = sp.clone();
                right.start = b32;
                kept.push(right);
            }
        }
        let mut m = Span::new(a, b);
        if let Some(c) = ink {
            m = m.color(c);
        }
        m.bg = Some(fill);
        kept.push(m);
        kept.sort_by_key(|s| s.start);
        spans = kept;
    }
    (text, spans)
}

fn screen(s: &Hooked, k: &Kit, t: &Term) -> El {
    let vt = &t.vt;
    let (cw, ch) = vt.cell;
    let fg = crate::ghostty::color(crate::ghostty::FG);
    let cols = vt.size().0;
    let cursor = vt.cursor.filter(|_| !t.exited);
    let selection = k.selection();
    let mut lines = col().key(format!("term-lines-{}", t.id)).w_full().gap(0.0);
    for (i, line) in vt.lines.iter().enumerate() {
        let row = i as u16;
        let mut marks: Vec<(u16, u16, Option<Color>, Color)> = Vec::new();
        if let Some((a, b)) = s.term.sel.and_then(|sel| sel.row_range(row, cols)) {
            marks.push((a, b, None, selection));
        }
        let cur = cursor.filter(|c| c.y == row && s.term.preedit.is_empty());
        if let Some(c) = cur {
            match c.shape {
                CursorShape::Block => marks.push((c.x, c.x + 1, Some(vt.background), c.color)),
                _ => marks.push((c.x, c.x + 1, None, c.color.alpha(0.35))),
            }
        }
        let version = (
            line.version,
            s.term.sel.and_then(|sel| sel.row_range(row, cols)),
            cur.map(|c| c.x),
            k.dark,
        );
        let mono = k.ty.mono;
        let built = if marks.is_empty() {
            (line.text.clone(), line.spans.clone())
        } else {
            painted(line, &marks)
        };
        lines = lines.child(memo(format!("tl-{}-{i}", t.id), version, move || {
            rich(built.0, built.1)
                .font(mono)
                .color(fg)
                .single_line()
                .h(ch)
        }));
    }
    if let Some(c) = cursor {
        let (x, y) = (f32::from(c.x) * cw, f32::from(c.y) * ch);
        let mut caret = row().key("term-caret").absolute(x, y).h(ch).ime_cursor();
        if !s.term.preedit.is_empty() {
            caret = caret.fill(vt.background).child(
                rich(
                    s.term.preedit.clone(),
                    vec![Span::new(0, s.term.preedit.len()).color(fg)],
                )
                .font(k.ty.mono)
                .single_line(),
            );
            caret = caret.border_sides([0.0, 0.0, 1.0, 0.0], fg);
        } else {
            caret = caret.w(1.0);
        }
        lines = lines.child(caret);
    }
    lines.child(
        text("MMMMMMMMMM")
            .key("term-measure")
            .font(k.ty.mono)
            .single_line()
            .absolute(0.0, 0.0)
            .opacity(0.0)
            .on_layout(|s: &mut Hooked, r: [f32; 4]| s.set_cell((r[2] / 10.0).max(1.0))),
    )
}

pub fn panel(s: &Hooked, k: &Kit) -> El {
    let p = &s.term;
    if !p.open || p.terms.is_empty() {
        let info = if p.terms.is_empty() {
            "open a shell in this project".to_string()
        } else {
            format!("{} open", p.terms.len())
        };
        return k
            .interactive(
                row()
                    .key("term-drawer")
                    .role("button")
                    .w_full()
                    .h(28.0)
                    .px(14.0)
                    .gap(8.0)
                    .center_y()
                    .cursor(Cursor::Pointer)
                    .border_sides([1.0, 0.0, 0.0, 0.0], k.c.border_weak)
                    .child(glyph(&icons::TERMINAL, 13.0, k.c.icon_muted))
                    .child(
                        text("Terminal")
                            .font(k.ty.text_small_medium)
                            .color(k.c.text_muted),
                    )
                    .child(text(info).font(k.ty.text_xsmall).color(k.c.text_faint))
                    .child(el().grow(1.0))
                    .child(
                        text(if p.busy {
                            "opening…"
                        } else {
                            "open · key 2 ↑"
                        })
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                    ),
            )
            .on_press(|s: &mut Hooked| s.toggle_terms());
    }
    let tabs = row()
        .key("term-tabs")
        .gap(4.0)
        .center_y()
        .children(p.terms.iter().enumerate().map(|(i, t)| {
            let on = i == p.active;
            let id_tail: String =
                t.id.chars()
                    .rev()
                    .take(4)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
            let short = if t.vt.title.trim().is_empty() {
                id_tail
            } else {
                crate::fmt::first_line(&t.vt.title, 40)
            };
            row()
                .key(format!("term-tab-{}", t.id))
                .h(24.0)
                .pl(8.0)
                .gap(4.0)
                .center_y()
                .radius(k.radius.sm)
                .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
                .child(
                    k.interactive(
                        row()
                            .role("tab")
                            .checked(on)
                            .gap(5.0)
                            .center_y()
                            .cursor(Cursor::Pointer)
                            .child(glyph(&icons::TERMINAL, 12.0, k.c.icon_muted))
                            .child(
                                text(if t.exited {
                                    format!("{short} · exited")
                                } else {
                                    short
                                })
                                .font(k.ty.text_small)
                                .color(if on {
                                    k.c.text_base
                                } else {
                                    k.c.text_muted
                                }),
                            ),
                    )
                    .on_press(move |s: &mut Hooked| s.term.active = i),
                )
                .child(
                    IconButton::new(&icons::CLOSE)
                        .variant(IconButtonVariant::GhostMuted)
                        .control_size(rune_kit::ControlSize::Small)
                        .label("Close this terminal")
                        .on_press(move |s: &mut Hooked| s.close_term(i))
                        .build(k),
                )
        }));
    let bar = row()
        .key("term-bar")
        .w_full()
        .h(32.0)
        .px(10.0)
        .gap(6.0)
        .center_y()
        .border_sides([1.0, 0.0, 1.0, 0.0], k.c.border_weak)
        .child(tabs)
        .child(
            IconButton::new(&icons::PLUS)
                .variant(IconButtonVariant::GhostMuted)
                .control_size(rune_kit::ControlSize::Small)
                .label("New shell in this project")
                .help("New shell in this project")
                .disabled(p.busy)
                .on_press(|s: &mut Hooked| s.new_term())
                .build(k)
                .key("term-new"),
        )
        .child(el().grow(1.0))
        .child(
            text("click to type · ⌘V pastes")
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        )
        .child(
            IconButton::new(&icons::CHEVRON_DOWN)
                .variant(IconButtonVariant::GhostMuted)
                .control_size(rune_kit::ControlSize::Small)
                .label("Hide the terminal panel")
                .help("Hide the terminal panel (key 2)")
                .on_press(|s: &mut Hooked| s.term.open = false)
                .build(k)
                .key("term-hide"),
        );
    let body = match p.terms.get(p.active) {
        Some(t) => screen(s, k, t),
        None => el(),
    };
    let term = col()
        .key("term-screen")
        .role("textbox")
        .label("Terminal")
        .focusable(true)
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .padding(8.0)
        .fill(
            p.terms
                .get(p.active)
                .map_or(Color::BLACK, |t| t.vt.background),
        )
        .cursor(Cursor::Text)
        .on_key(|s: &mut Hooked, ev: &rune::KeyEvent, tx: &mut rune::Tx| {
            if ev.is_command('c') {
                if let Some(text) = s.selection_text() {
                    tx.copy(text);
                    s.term.sel = None;
                    return true;
                }
                return false;
            }
            if ev.mods.cmd {
                return false;
            }
            s.term_key(ev, tx.physical_key())
        })
        .on_drag(|s: &mut Hooked, d: &mut rune::Drag, _| s.term_drag(d, false))
        .on_wheel(|s: &mut Hooked, e: rune::WheelEvent, _| {
            s.term_wheel(e.dy, e.x, e.y);
            true
        })
        .on_layout(|s: &mut Hooked, r: [f32; 4]| s.fit_terms(r[2], r[3]))
        .on_paste_content(|s: &mut Hooked, c: &rune::ClipboardContent, _| {
            s.term_paste(c.text());
        })
        .child(body);
    let grip = el()
        .key("term-resize")
        .w_full()
        .h(6.0)
        .cursor(Cursor::ResizeRow)
        .help("Drag to resize")
        .on_drag(|s: &mut Hooked, d: &mut rune::Drag, _| {
            if d.phase == rune::Phase::Down {
                d.data = s.term.height.unwrap_or(s.term.screen.1 + 38.0);
            }
            let h = (d.data - d.dy).clamp(120.0, s.window_h * 0.8);
            s.term.height = Some(h);
            if d.phase == rune::Phase::Up {
                s.save_pref("termHeight", &h);
            }
        });
    let height = s
        .term
        .height
        .unwrap_or(s.window_h / 3.0)
        .clamp(120.0, (s.window_h * 0.8).max(120.0));
    col()
        .key("term-panel")
        .w_full()
        .h(height)
        .child(grip)
        .child(bar)
        .child(term)
}
