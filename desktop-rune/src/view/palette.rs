use rune::{Color, Cursor, El, Key, col, el, row, text};
use rune_kit::{Kit, TextInput};

use super::{Shadows, dot, glyph};
use crate::app::{Hooked, Page};
use crate::{fmt, icons};

pub enum Hit {
    Session(String),
    Go(Page),
    New,
    Deck,
    Theme,
    Sidebar,
}

pub fn hits(s: &Hooked) -> Vec<(Hit, String, String)> {
    let q = s.palette_query.text.trim().to_lowercase();
    let mut out = Vec::new();
    let commands = [
        (Hit::New, "New session", "⌘N"),
        (Hit::Deck, "Go to the Deck", "⌘1"),
        (Hit::Sidebar, "Toggle the sidebar", "⌘B"),
        (Hit::Theme, "Cycle theme", ""),
    ];
    for (h, label, keys) in commands {
        if q.is_empty() || label.to_lowercase().contains(&q) {
            out.push((h, label.to_string(), keys.to_string()));
        }
    }
    for (p, label, keys) in [
        (Page::Stats, "Go to Stats", ""),
        (Page::Digest, "Go to the daily digest", ""),
        (Page::Memory, "Go to Memory", ""),
        (Page::Cron, "Go to scheduled tasks", ""),
        (Page::Settings, "Open Settings", "⌘,"),
    ] {
        if !q.is_empty() && label.to_lowercase().contains(&q) {
            out.push((Hit::Go(p), label.to_string(), keys.to_string()));
        }
    }
    for x in &s.sessions {
        let hay = format!(
            "{} {} {}",
            x.display_title(),
            x.project_label(),
            x.last_prompt.clone().unwrap_or_default()
        )
        .to_lowercase();
        if q.is_empty() || q.split_whitespace().all(|w| hay.contains(w)) {
            out.push((
                Hit::Session(x.id.clone()),
                x.display_title(),
                format!(
                    "{} · {}",
                    x.project_label(),
                    fmt::ago_short(x.last_activity.as_deref(), s.now)
                ),
            ));
        }
        if out.len() > 60 {
            break;
        }
    }
    out
}

pub fn run(s: &mut Hooked, index: usize) {
    let mut list = hits(s);
    if index >= list.len() {
        return;
    }
    let (h, _, _) = list.swap_remove(index);
    s.palette_open = false;
    match h {
        Hit::Session(id) => s.open_session(&id),
        Hit::Go(p) => s.go(p),
        Hit::New => s.go_new(None),
        Hit::Deck => s.page = Page::Deck,
        Hit::Theme => s.cycle_theme(),
        Hit::Sidebar => s.sidebar_open = !s.sidebar_open,
    }
}

pub fn view(s: &Hooked, k: &Kit) -> El {
    let list = hits(s);
    let sel = s.palette_index.min(list.len().saturating_sub(1));
    let rows = list
        .iter()
        .enumerate()
        .take(14)
        .map(|(i, (h, label, detail))| {
            let lead = match h {
                Hit::Session(id) => dot(k, s.session(id).map_or("idle", |x| x.state.as_str()), 7.0),
                Hit::Go(_) => glyph(&icons::ARROW_RIGHT, 13.0, k.c.icon_muted),
                Hit::New => glyph(&icons::PLUS, 13.0, k.c.icon_muted),
                Hit::Deck => glyph(&icons::DECK, 13.0, k.c.icon_muted),
                Hit::Theme => glyph(&icons::SUN, 13.0, k.c.icon_muted),
                Hit::Sidebar => glyph(&icons::SIDEBAR, 13.0, k.c.icon_muted),
            };
            k.interactive(
                row()
                    .key(format!("pal-{i}"))
                    .role("option")
                    .checked(i == sel)
                    .w_full()
                    .h(34.0)
                    .px(12.0)
                    .gap(10.0)
                    .center_y()
                    .radius(k.radius.md)
                    .cursor(Cursor::Pointer)
                    .fill(if i == sel {
                        k.c.layer_02
                    } else {
                        Color::TRANSPARENT
                    })
                    .child(row().w(14.0).center().child(lead))
                    .child(
                        text(label.clone())
                            .font(k.ty.ui)
                            .color(k.c.text_base)
                            .truncate()
                            .grow(1.0)
                            .min_w(0.0),
                    )
                    .child(
                        text(detail.clone())
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_faint),
                    ),
            )
            .on_press(move |s: &mut Hooked| run(s, i))
        });
    let panel = col()
        .key("palette")
        .w(620.0)
        .max_h(520.0)
        .padding(8.0)
        .gap(6.0)
        .radius(k.radius.lg)
        .fill(k.c.surface_float)
        .border(1.0, k.c.border_base)
        .box_shadows(&k.elevation.overlay)
        .child(
            TextInput::new(&s.palette_query)
                .placeholder("Search sessions, launch, command…")
                .leading_icon(&icons::SEARCH)
                .large()
                .width(None)
                .on_edit(|s: &mut Hooked| &mut s.palette_query)
                .on_change(|s: &mut Hooked, _| s.palette_index = 0)
                .on_key(|s: &mut Hooked, ev: &rune::KeyEvent, _| match ev.key {
                    Key::Down => {
                        s.palette_index += 1;
                        true
                    }
                    Key::Up => {
                        s.palette_index = s.palette_index.saturating_sub(1);
                        true
                    }
                    Key::Enter => {
                        let i = s.palette_index;
                        run(s, i);
                        true
                    }
                    Key::Escape => {
                        s.palette_open = false;
                        true
                    }
                    _ => false,
                })
                .build(k)
                .key("palette-input"),
        )
        .child(col().key("palette-list").w_full().gap(2.0).children(rows));
    el().key("palette-scrim")
        .absolute(0.0, 0.0)
        .w_full()
        .h_full()
        .fill(k.c.scrim)
        .items_center()
        .pt(90.0)
        .modal(true, |s: &mut Hooked| s.palette_open = false)
        .child(col().items_center().w_full().child(panel))
}
