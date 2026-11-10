use rune::{Color, Cursor, El, Span, col, el, memo, rich, row, text};
use rune_kit::{IconButton, IconButtonVariant, Kit};

use super::glyph;
use crate::app::Hooked;
use crate::ghostty::{CursorShape, Line};
use crate::icons;
use crate::terminal::Term;

/// The line's text and spans with `marks` (column range, ink) recoloured; marks win over the
/// cells' own colours, and pad the line with spaces when they reach past its end.
fn painted(line: &Line, marks: &[(u16, u16, Color)]) -> (String, Vec<Span>) {
    let mut text = line.text.clone();
    let mut spans = line.spans.clone();
    for &(c0, c1, ink) in marks {
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
        kept.push(Span::new(a, b).color(ink));
        kept.sort_by_key(|s| s.start);
        spans = kept;
    }
    (text, spans)
}

fn screen(s: &Hooked, k: &Kit, t: &Term, panel: bool) -> El {
    let vt = &t.vt;
    let (cw, ch) = vt.cell;
    let fg = vt.foreground;
    let cols = vt.size().0;
    let top = vt.viewport_top();
    let has_focus = match s.term_focus.as_ref() {
        Some(crate::terminal::TermFocus::Panel) => panel,
        Some(crate::terminal::TermFocus::Pty(id)) => !panel && *id == t.id,
        None => false,
    };
    let cursor = vt
        .cursor
        .filter(|c| !t.exited && (!c.blinking || !has_focus || crate::terminal::blink_on()));
    let mono = {
        let mut f = k.ty.mono;
        f.size = s.term_font();
        f.line_height = crate::terminal::line_height(f.size);
        f
    };
    let selection = k.selection();
    let mut lines = col().key(format!("term-lines-{}", t.id)).w_full().gap(0.0);
    for (i, line) in vt.lines.iter().enumerate() {
        let row = i as u16;
        let mut marks: Vec<(u16, u16, Option<Color>, Color)> = Vec::new();
        let owner = s
            .term
            .sel_owner
            .clone()
            .unwrap_or(crate::terminal::TermFocus::Panel);
        let mine = match owner {
            crate::terminal::TermFocus::Panel => panel,
            crate::terminal::TermFocus::Pty(ref id) => !panel && *id == t.id,
        };
        let sel = s.term.sel.filter(|_| mine);
        let screen_row = top + u64::from(row);
        if let Some((a, b)) = sel.and_then(|sel| sel.row_range(screen_row, cols)) {
            marks.push((a, b, None, selection));
        }
        let needle = s
            .term
            .search
            .as_ref()
            .filter(|_| panel)
            .map(|(e, _)| e.text.clone())
            .unwrap_or_default();
        for (a, b) in crate::ghostty::matches(line, &needle) {
            marks.push((a, b, None, k.c.warning.icon.alpha(0.45)));
        }
        let cur = cursor.filter(|c| c.y == row && (!panel || s.term.preedit.is_empty()));
        if let Some(c) = cur {
            match c.shape {
                CursorShape::Block => marks.push((c.x, c.x + 1, Some(vt.background), c.color)),
                _ => marks.push((c.x, c.x + 1, None, c.color.alpha(0.35))),
            }
        }
        let version = (
            line.version,
            needle.clone(),
            sel.and_then(|sel| sel.row_range(screen_row, cols)),
            cur.map(|c| (c.x, c.shape == CursorShape::Block)),
            k.dark,
            (cw * 100.0) as i32,
            (ch * 100.0) as i32,
        );
        let inked: Vec<(u16, u16, Color)> = marks
            .iter()
            .filter_map(|&(a, b, ink, _)| Some((a, b, ink?)))
            .collect();
        let mut built = if inked.is_empty() {
            (line.text.clone(), line.spans.clone())
        } else {
            painted(line, &inked)
        };
        for (a, b, _) in crate::ghostty::links(line) {
            let (x, y) = line.byte_range(a, b);
            built
                .1
                .push(Span::new(x, y.min(built.0.len())).underline(fg.alpha(0.6)));
        }
        let fills: Vec<(u16, u16, Color)> = line
            .bgs
            .iter()
            .copied()
            .chain(marks.iter().map(|&(a, b, _, c)| (a, b, c)))
            .collect();
        let strikes: Vec<(usize, usize, Option<Color>)> = line
            .decos
            .iter()
            .filter(|d| d.kind == crate::ghostty::DecoKind::Strike)
            .map(|d| {
                let (x, y) = line.byte_range(d.a, d.b);
                (x, y.min(built.0.len()), Some(d.color))
            })
            .filter(|(x, y, _)| x < y)
            .collect();
        let mut rules: Vec<(f32, f32, f32, f32, Color)> = Vec::new();
        for d in &line.decos {
            rules.extend(deco_rects(d, cw, ch));
        }
        for &(a, b) in &line.links {
            rules.extend(deco_rects(
                &crate::ghostty::Deco {
                    a,
                    b,
                    kind: crate::ghostty::DecoKind::Dotted,
                    color: fg.alpha(0.5),
                },
                cw,
                ch,
            ));
        }
        lines = lines.child(memo(format!("tl-{}-{i}", t.id), version, move || {
            let mut r = el().w_full().h(ch);
            for (a, b, c) in fills {
                r = r.child(
                    el().absolute(f32::from(a) * cw, 0.0)
                        .size(f32::from(b - a) * cw, ch)
                        .fill(c),
                );
            }
            for (x, y, w, h, c) in rules {
                r = r.child(el().absolute(x, y).size(w, h).fill(c));
            }
            r.child(
                rich(built.0, built.1)
                    .font(mono)
                    .color(fg)
                    .single_line()
                    .strikes(strikes)
                    .h(ch),
            )
        }));
    }
    let caret_here = if panel {
        !matches!(s.term_focus, Some(crate::terminal::TermFocus::Pty(_)))
    } else {
        has_focus
    };
    if let Some(c) = cursor.filter(|_| caret_here) {
        let (x, y) = (f32::from(c.x) * cw, f32::from(c.y) * ch);
        let mut caret = row().key("term-caret").absolute(x, y).h(ch).ime_cursor();
        if !s.term.preedit.is_empty() {
            caret = caret.fill(vt.background).child(
                rich(
                    s.term.preedit.clone(),
                    vec![Span::new(0, s.term.preedit.len()).color(fg)],
                )
                .font(mono)
                .single_line(),
            );
            caret = caret.border_sides([0.0, 0.0, 1.0, 0.0], fg);
        } else {
            caret = caret.w(1.0);
        }
        lines = lines.child(caret);
    }
    if !panel {
        return lines;
    }
    lines.child(
        text("MMMMMMMMMM")
            .key("term-measure")
            .font(mono)
            .single_line()
            .absolute(0.0, 0.0)
            .opacity(0.0)
            .on_layout(|s: &mut Hooked, r: [f32; 4]| s.set_cell((r[2] / 10.0).max(1.0))),
    )
}

/// Rectangles for an underline, overline or dotted link mark across columns `a..b`.
fn deco_rects(d: &crate::ghostty::Deco, cw: f32, ch: f32) -> Vec<(f32, f32, f32, f32, Color)> {
    use crate::ghostty::DecoKind;
    let (x0, x1) = (f32::from(d.a) * cw, f32::from(d.b) * cw);
    let base = ch - 3.0;
    let c = d.color;
    let dashes = |on: f32, off: f32, y: f32| {
        let mut v = Vec::new();
        let mut x = x0;
        while x < x1 {
            v.push((x, y, on.min(x1 - x), 1.0, c));
            x += on + off;
        }
        v
    };
    match d.kind {
        DecoKind::Strike => Vec::new(),
        DecoKind::Single => vec![(x0, base, x1 - x0, 1.0, c)],
        DecoKind::Double => vec![
            (x0, base - 1.0, x1 - x0, 1.0, c),
            (x0, base + 1.0, x1 - x0, 1.0, c),
        ],
        DecoKind::Over => vec![(x0, 0.0, x1 - x0, 1.0, c)],
        DecoKind::Dotted => dashes(1.0, 1.0, base),
        DecoKind::Dashed => dashes(3.0, 2.0, base),
        DecoKind::Curly => {
            let mut v = Vec::new();
            let mut x = x0;
            let mut up = true;
            while x < x1 {
                v.push((
                    x,
                    if up { base - 1.0 } else { base + 1.0 },
                    2.0f32.min(x1 - x),
                    1.0,
                    c,
                ));
                x += 2.0;
                up = !up;
            }
            v
        }
    }
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
                    .on_press(move |s: &mut Hooked| s.pick_term(i)),
                )
                .child(if t.exited {
                    IconButton::new(&icons::RESTART)
                        .variant(IconButtonVariant::GhostMuted)
                        .control_size(rune_kit::ControlSize::Small)
                        .label("Restart this shell")
                        .help("Restart this shell")
                        .on_press(move |s: &mut Hooked| s.restart_term(i))
                        .build(k)
                } else {
                    el()
                })
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
        .child(match p.search.as_ref() {
            Some((edit, (n, sel))) => row()
                .gap(6.0)
                .center_y()
                .child(
                    rune_kit::TextInput::new(edit)
                        .placeholder("Search the scrollback…")
                        .width(Some(220.0))
                        .on_edit(|s: &mut Hooked| &mut s.term.search.as_mut().expect("search").0)
                        .on_change(|s: &mut Hooked, _| s.term_search_changed())
                        .on_key(|s: &mut Hooked, ev: &rune::KeyEvent, _| match ev.key {
                            rune::Key::Enter => {
                                s.term_search_step(!ev.mods.shift);
                                true
                            }
                            rune::Key::Escape => {
                                s.close_term_search();
                                true
                            }
                            _ => false,
                        })
                        .build(k)
                        .key("term-search"),
                )
                .child(
                    text(match (n, sel) {
                        (0, _) if edit.text.is_empty() => String::new(),
                        (0, _) => "no match".to_string(),
                        (n, Some(i)) => format!("{}/{n}", i + 1),
                        (n, None) => n.to_string(),
                    })
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_faint),
                )
                .child(
                    IconButton::new(&icons::CLOSE)
                        .variant(IconButtonVariant::GhostMuted)
                        .control_size(rune_kit::ControlSize::Small)
                        .label("Close the search")
                        .on_press(|s: &mut Hooked| s.close_term_search())
                        .build(k),
                ),
            None => row()
                .gap(6.0)
                .center_y()
                .child(
                    text("⌘F searches · ⌘-click opens links · ⌘V pastes")
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                )
                .child(
                    IconButton::new(&icons::SEARCH)
                        .variant(IconButtonVariant::GhostMuted)
                        .control_size(rune_kit::ControlSize::Small)
                        .label("Search the scrollback")
                        .help("Search the scrollback (⌘F)")
                        .on_press(|s: &mut Hooked| s.open_term_search())
                        .build(k),
                ),
        })
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
        Some(t) => screen(s, k, t, true),
        None => el(),
    };
    let bell = crate::fmt::now_ms() - p.bell_at < 250;
    let scroll = p.terms.get(p.active).and_then(|t| t.vt.scroll_position());
    let term = col()
        .key("term-screen")
        .instant_changes()
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
        .border(
            1.0,
            if bell {
                k.c.warning.border
            } else {
                Color::TRANSPARENT
            },
        )
        .on_key(|s: &mut Hooked, ev: &rune::KeyEvent, tx: &mut rune::Tx| {
            s.set_term_focus(Some(crate::terminal::TermFocus::Panel));
            s.term_claimed = false;
            if ev.is_command('c') {
                if let Some(text) = s.selection_text() {
                    tx.copy(text);
                    s.term.sel = None;
                    return true;
                }
                return false;
            }
            if ev.is_command('f') {
                s.open_term_search();
                return true;
            }
            if ev.is_command('=') || ev.is_command('+') {
                s.zoom_term(1);
                return true;
            }
            if ev.is_command('-') {
                s.zoom_term(-1);
                return true;
            }
            if ev.is_command('0') {
                s.zoom_term(0);
                return true;
            }
            if ev.mods.cmd {
                tx.instant();
                return s.term_cmd_key(&ev.key);
            }
            tx.instant();
            s.term_key(ev, tx.physical_key())
        })
        .on_drag(|s: &mut Hooked, d: &mut rune::Drag, tx: &mut rune::Tx| {
            tx.instant();
            if d.phase == rune::Phase::Down {
                s.set_term_focus(Some(crate::terminal::TermFocus::Panel));
                s.term_claimed = false;
                s.term.shift_drag = tx.mods().shift;
            }
            if d.phase == rune::Phase::Down
                && tx.button() == rune::PointerButton::Primary
                && tx.mods().cmd
                && s.term_open_link(d.x, d.y, tx)
            {
                return;
            }
            let shift = s.term.shift_drag;
            s.term_drag(crate::terminal::TermFocus::Panel, d, tx.button(), shift)
        })
        .pointer_buttons([rune::PointerButton::Middle])
        .on_secondary_press_local(|s: &mut Hooked, p: rune::PointerEvent, tx: &mut rune::Tx| {
            tx.instant();
            s.term_right_click(&crate::terminal::TermFocus::Panel, p.x, p.y);
        })
        .on_pointer_move_local(|s: &mut Hooked, p: rune::PointerEvent, _| {
            s.term_hover(&crate::terminal::TermFocus::Panel, p.x, p.y)
        })
        .on_wheel(|s: &mut Hooked, e: rune::WheelEvent, tx: &mut rune::Tx| {
            tx.instant();
            s.term_wheel(e.dy, e.x, e.y);
            true
        })
        .on_layout(|s: &mut Hooked, r: [f32; 4]| s.fit_terms(r[2], r[3]))
        .on_drop_files(|s: &mut Hooked, files: &[std::path::PathBuf], _| s.term_drop(files))
        .child(body)
        .child(match scroll {
            Some((offset, len, total)) => {
                let h = (p.screen.1 - 16.0).max(10.0);
                let top = h * offset as f32 / total as f32;
                let size = (h * len as f32 / total as f32).max(12.0);
                let below = total.saturating_sub(offset + len);
                let mut layer = el().absolute(0.0, 0.0).w_full().h_full().child(
                    el().absolute(p.screen.0 - 6.0, 8.0 + top)
                        .size(3.0, size)
                        .radius(1.5)
                        .fill(
                            p.terms
                                .get(p.active)
                                .map_or(Color::WHITE, |t| t.vt.foreground)
                                .alpha(0.35),
                        ),
                );
                if below > 0 {
                    layer = layer.child(
                        row()
                            .absolute((p.screen.0 - 150.0).max(0.0), (p.screen.1 - 30.0).max(0.0))
                            .h(22.0)
                            .px(8.0)
                            .center_y()
                            .radius(11.0)
                            .fill(k.c.bg_base.alpha(0.9))
                            .child(
                                text(format!("↓ {below} lines below"))
                                    .font(k.ty.text_xsmall)
                                    .color(k.c.text_muted),
                            ),
                    );
                }
                layer
            }
            None => el(),
        });
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

pub fn pty_block(s: &Hooked, k: &Kit, f: &crate::terminal::PtyFence) -> El {
    let live = s.ptys.terms.iter().find(|t| t.id == f.id);
    let dead = live.is_none() && s.ptys.dead.contains(&f.id);
    let short_cwd = match f.cwd.strip_prefix("/Users/") {
        Some(rest) => rest
            .find('/')
            .map_or("~".to_string(), |i| format!("~{}", &rest[i..])),
        None => f.cwd.clone(),
    };
    let mono_bold = {
        let mut m = k.ty.mono;
        m.weight = 600.0;
        m
    };
    let mut head = row()
        .w_full()
        .h(30.0)
        .pl(10.0)
        .pr(6.0)
        .gap(7.0)
        .center_y()
        .fill(k.c.layer_02)
        .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_weak)
        .child(glyph(&icons::TERMINAL, 12.0, k.c.icon_muted))
        .child(text("$").font(mono_bold).color(k.c.text_accent))
        .child(
            text(f.command.clone())
                .font(mono_bold)
                .color(k.c.text_base)
                .truncate()
                .grow(1.0)
                .min_w(0.0),
        );
    if !short_cwd.is_empty() {
        head = head.child(
            text(short_cwd)
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint)
                .truncate()
                .max_w(220.0)
                .help(f.cwd.clone()),
        );
    }
    let tag = |label: &str, fg: Color, bg: Color| {
        row().h(18.0).px(5.0).center_y().radius(4.0).fill(bg).child(
            text(label.to_string())
                .font(k.ty.text_xsmall_medium)
                .color(fg),
        )
    };
    let mut c = col()
        .key(format!("pty-{}", f.id))
        .w_full()
        .radius(k.radius.md)
        .clip_rounded(k.radius.md)
        .border(
            1.0,
            if live.is_some() {
                k.c.text_accent.alpha(0.55)
            } else {
                k.c.border_weak
            },
        );
    match live {
        Some(t) => {
            let id = f.id.clone();
            head = head
                .child(if t.exited {
                    tag("exited", k.c.text_muted, k.c.layer_01)
                } else {
                    tag("interactive", k.c.success.fg, k.c.success.bg)
                })
                .child(
                    IconButton::new(&icons::CLOSE)
                        .variant(IconButtonVariant::GhostMuted)
                        .control_size(rune_kit::ControlSize::Small)
                        .label("Close this terminal")
                        .on_press(move |s: &mut Hooked| s.close_pty(id.clone()))
                        .build(k),
                );
            let (ka, kb, kd) = (f.id.clone(), f.id.clone(), f.id.clone());
            let me = crate::terminal::TermFocus::Pty(f.id.clone());
            let (m1, m2, m3) = (me.clone(), me.clone(), me.clone());
            let screen_el = col()
                .key(format!("pty-screen-{}", f.id))
                .instant_changes()
                .role("textbox")
                .label("Interactive terminal")
                .focusable(true)
                .w_full()
                .h(f32::from(crate::terminal::PTY_ROWS) * t.vt.cell.1 + 2.0 * crate::terminal::PAD)
                .padding(crate::terminal::PAD)
                .clip_rounded(0.0)
                .fill(t.vt.background)
                .cursor(Cursor::Text)
                .on_key(
                    move |s: &mut Hooked, ev: &rune::KeyEvent, tx: &mut rune::Tx| {
                        tx.instant();
                        s.set_term_focus(Some(crate::terminal::TermFocus::Pty(ka.clone())));
                        if ev.is_command('c') {
                            if let Some(text) = s.selection_text() {
                                tx.copy(text);
                                s.term.sel = None;
                                return true;
                            }
                            return false;
                        }
                        s.pty_key(&ka, ev, tx.physical_key())
                    },
                )
                .on_wheel(
                    move |s: &mut Hooked, e: rune::WheelEvent, tx: &mut rune::Tx| {
                        tx.instant();
                        s.pty_wheel(&kb, e.dy, e.x, e.y);
                        true
                    },
                )
                .on_drag(
                    move |s: &mut Hooked, d: &mut rune::Drag, tx: &mut rune::Tx| {
                        tx.instant();
                        if d.phase == rune::Phase::Down {
                            s.set_term_focus(Some(m1.clone()));
                            s.term.shift_drag = tx.mods().shift;
                        }
                        let shift = s.term.shift_drag;
                        s.term_drag(m1.clone(), d, tx.button(), shift)
                    },
                )
                .pointer_buttons([rune::PointerButton::Middle])
                .on_secondary_press_local(
                    move |s: &mut Hooked, p: rune::PointerEvent, tx: &mut rune::Tx| {
                        tx.instant();
                        s.term_right_click(&m2, p.x, p.y);
                    },
                )
                .on_pointer_move_local(move |s: &mut Hooked, p: rune::PointerEvent, _| {
                    s.term_hover(&m3, p.x, p.y)
                })
                .on_layout(move |s: &mut Hooked, r: [f32; 4]| s.pty_fit(&kd, r[2]))
                .child(screen(s, k, t, false));
            c = c.child(head).child(screen_el);
        }
        None => {
            head = head.child(if dead {
                tag("closed", k.c.text_muted, k.c.layer_01)
            } else {
                tag("…", k.c.text_muted, k.c.layer_01)
            });
            c = c.child(head);
            if dead {
                c = c.child(
                    row().w_full().px(10.0).py(7.0).child(
                        text("this terminal is gone: hooked restarted since, or it was closed")
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_faint),
                    ),
                );
            }
        }
    }
    c
}
