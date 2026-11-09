use rune::{Color, Cursor, El, col, el, memo, rich, row, text};
use rune_kit::{IconButton, IconButtonVariant, Kit};

use super::glyph;
use crate::app::Hooked;
use crate::ghostty::CursorShape;
use crate::icons;
use crate::terminal::Term;

fn screen(k: &Kit, t: &Term) -> El {
    let vt = &t.vt;
    let (cw, ch) = vt.cell;
    let fg = crate::ghostty::color(crate::ghostty::FG);
    let mut lines = col().key(format!("term-lines-{}", t.id)).w_full().gap(0.0);
    for (i, line) in vt.lines.iter().enumerate() {
        let (text, spans) = (line.text.clone(), line.spans.clone());
        let mono = k.ty.mono;
        lines = lines.child(memo(format!("tl-{}-{i}", t.id), line.version, move || {
            rich(text, spans).font(mono).color(fg).single_line().h(ch)
        }));
    }
    if let Some(c) = vt.cursor.filter(|_| !t.exited) {
        let (x, y) = (f32::from(c.x) * cw, f32::from(c.y) * ch);
        let mark = match c.shape {
            CursorShape::Block => el().size(cw, ch).fill(c.color.alpha(0.55)),
            CursorShape::Hollow => el().size(cw, ch).border(1.0, c.color),
            CursorShape::Bar => el().size(2.0, ch).fill(c.color),
            CursorShape::Underline => el().size(cw, 2.0).fill(c.color).mt(ch - 2.0),
        };
        lines = lines.child(el().key("term-cursor").absolute(x, y).child(mark));
    }
    lines
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
        Some(t) => screen(k, t),
        None => el(),
    };
    let term = col()
        .key("term-screen")
        .role("textbox")
        .label("Terminal")
        .focusable(true)
        .w_full()
        .h(420.0)
        .padding(8.0)
        .fill(
            p.terms
                .get(p.active)
                .map_or(Color::BLACK, |t| t.vt.background),
        )
        .cursor(Cursor::Text)
        .on_key(|s: &mut Hooked, ev: &rune::KeyEvent, tx: &mut rune::Tx| {
            if ev.mods.cmd {
                return false;
            }
            s.term_key(ev, tx.physical_key())
        })
        .on_wheel(|s: &mut Hooked, e: rune::WheelEvent, _| {
            s.term_wheel(e.dy, e.x, e.y);
            true
        })
        .on_layout({
            let cell = rune::text::measure("M", &[], k.ty.mono, None);
            move |s: &mut Hooked, r: [f32; 4]| s.fit_terms(r[2], r[3], (cell.0.max(1.0), 18.0))
        })
        .on_paste_content(|s: &mut Hooked, c: &rune::ClipboardContent, _| {
            s.term_paste(c.text());
        })
        .child(body);
    col().key("term-panel").w_full().child(bar).child(term)
}
