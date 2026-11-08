use rune::{Color, Cursor, El, Span, col, el, rich, row, text};
use rune_kit::{IconButton, IconButtonVariant, Kit};

use super::glyph;
use crate::app::Hooked;
use crate::icons;
use crate::terminal::{COLS, Term, encode};

const ANSI: [(u8, u8, u8); 16] = [
    (0x1e, 0x1e, 0x1e),
    (0xe0, 0x6c, 0x75),
    (0x98, 0xc3, 0x79),
    (0xe5, 0xc0, 0x7b),
    (0x61, 0xaf, 0xef),
    (0xc6, 0x78, 0xdd),
    (0x56, 0xb6, 0xc2),
    (0xab, 0xb2, 0xbf),
    (0x5c, 0x63, 0x70),
    (0xf0, 0x7c, 0x85),
    (0xa8, 0xd3, 0x89),
    (0xf5, 0xd0, 0x8b),
    (0x71, 0xbf, 0xff),
    (0xd6, 0x88, 0xed),
    (0x66, 0xc6, 0xd2),
    (0xff, 0xff, 0xff),
];

fn rgb(r: u8, g: u8, b: u8) -> Color {
    rune::color::hex(&format!("#{r:02x}{g:02x}{b:02x}")).unwrap_or(Color::WHITE)
}

fn color(c: vt100::Color) -> Option<Color> {
    match c {
        vt100::Color::Default => None,
        vt100::Color::Idx(i) if i < 16 => {
            let (r, g, b) = ANSI[i as usize];
            Some(rgb(r, g, b))
        }
        vt100::Color::Idx(i) if i >= 232 => {
            let v = 8 + (i - 232) * 10;
            Some(rgb(v, v, v))
        }
        vt100::Color::Idx(i) => {
            let i = i - 16;
            let step = |n: u8| if n == 0 { 0 } else { 55 + n * 40 };
            Some(rgb(step(i / 36), step((i / 6) % 6), step(i % 6)))
        }
        vt100::Color::Rgb(r, g, b) => Some(rgb(r, g, b)),
    }
}

fn screen(k: &Kit, t: &Term) -> El {
    let sc = t.parser.screen();
    let (rows, cols) = sc.size();
    let (cr, cc) = sc.cursor_position();
    let show_cursor = !sc.hide_cursor() && !t.exited;
    let fg_default = rgb(0xd4, 0xd4, 0xd4);
    let bg_default = rgb(0x14, 0x14, 0x16);
    let mut lines = col().key(format!("term-lines-{}", t.id)).w_full().gap(0.0);
    for r in 0..rows {
        let mut line = String::with_capacity(cols as usize);
        let mut spans = Vec::new();
        for c in 0..cols {
            let Some(cell) = sc.cell(r, c) else { continue };
            if cell.is_wide_continuation() {
                continue;
            }
            let start = line.len();
            let s = cell.contents();
            line.push_str(if s.is_empty() { " " } else { &s });
            let end = line.len();
            let (mut fg, mut bg) = (color(cell.fgcolor()), color(cell.bgcolor()));
            if cell.inverse() {
                (fg, bg) = (
                    Some(bg.unwrap_or(bg_default)),
                    Some(fg.unwrap_or(fg_default)),
                );
            }
            if show_cursor && r == cr && c == cc {
                (fg, bg) = (Some(bg_default), Some(fg_default));
            }
            if fg.is_some() || bg.is_some() || cell.bold() {
                let mut sp = Span::new(start, end);
                if let Some(f) = fg {
                    sp = sp.color(f);
                }
                if let Some(b) = bg {
                    sp.bg = Some(b);
                }
                if cell.bold() {
                    sp = sp.bold();
                }
                spans.push(sp);
            }
        }
        lines = lines.child(
            rich(line, spans)
                .font(k.ty.mono)
                .color(fg_default)
                .single_line(),
        );
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
            let short: String =
                t.id.chars()
                    .rev()
                    .take(4)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
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
        .fill(rgb(0x14, 0x14, 0x16))
        .cursor(Cursor::Text)
        .scroll_x()
        .on_key(|s: &mut Hooked, ev: &rune::KeyEvent, _| {
            if ev.mods.cmd {
                return false;
            }
            match encode(ev) {
                Some(bytes) => {
                    s.term_input(bytes);
                    true
                }
                None => false,
            }
        })
        .on_paste_content(|s: &mut Hooked, c: &rune::ClipboardContent, _| {
            if !c.text().is_empty() {
                s.term_input(c.text().as_bytes().to_vec());
            }
        })
        .child(body.min_w(COLS as f32 * 7.6));
    col().key("term-panel").w_full().child(bar).child(term)
}
