use rune::{Key, ScrollSpec, col, el, memo, row, text};
use rune_kit::{IconButton, IconButtonVariant, Kit, TextArea};

use super::session::{bubble, hash_of};
use super::{dot, glyph};
use crate::app::{Hooked, SplitPane};
use crate::{fmt, icons};

pub fn view(s: &Hooked, p: &SplitPane, k: &Kit) -> rune::El {
    let title = p
        .detail
        .as_ref()
        .map(|d| d.session.display_title())
        .unwrap_or_else(|| "Loading…".into());
    let state = p
        .detail
        .as_ref()
        .map(|d| d.session.state.clone())
        .unwrap_or_default();
    let head = row()
        .key("split-head")
        .w_full()
        .h(44.0)
        .px(12.0)
        .gap(8.0)
        .center_y()
        .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_weak)
        .child(dot(k, &state, 7.0))
        .child(
            text(title)
                .font(k.ty.ui_medium)
                .color(k.c.text_base)
                .truncate()
                .grow(1.0)
                .shrink(),
        )
        .child(
            text(fmt::state_label(&state))
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        )
        .child(
            IconButton::new(&icons::SWAP)
                .variant(IconButtonVariant::GhostMuted)
                .label("Make this the main pane")
                .help("Make this the main pane")
                .on_press(|s: &mut Hooked| s.swap_split())
                .build(k)
                .key("split-swap"),
        )
        .child(
            IconButton::new(&icons::CLOSE)
                .variant(IconButtonVariant::GhostMuted)
                .label("Close the split")
                .help("Close the split (⌘⇧S)")
                .on_press(|s: &mut Hooked| s.split = None)
                .build(k)
                .key("split-close"),
        );
    let mut chat = col().key("split-chat").w_full().px(16.0).py(12.0).gap(12.0);
    if let Some(d) = p.detail.as_ref() {
        let start = d.messages.len().saturating_sub(30);
        for (i, m) in d.messages.iter().enumerate().skip(start) {
            let version = hash_of((
                &m.text,
                m.tools.len(),
                m.ts.as_deref(),
                k.dark,
                s.all_tools_open,
            ));
            chat = chat.child(memo(format!("split-{}-{i}", d.session.id), version, || {
                bubble(s, m, k, i)
            }));
        }
        if let Some(q) = d
            .pending_question
            .as_ref()
            .and_then(|q| q.questions.first())
        {
            chat = chat.child(
                row()
                    .key("split-q")
                    .w_full()
                    .padding(10.0)
                    .gap(8.0)
                    .radius(k.radius.md)
                    .border(1.0, k.c.warning.border)
                    .child(glyph(&icons::ARROW_RIGHT, 12.0, k.c.warning.icon))
                    .child(
                        text(format!("Waiting on you: {}", q.question))
                            .font(k.ty.text_small)
                            .color(k.c.text_muted)
                            .wrap()
                            .grow(1.0)
                            .shrink(),
                    ),
            );
        }
    }
    let composer = row()
        .key("split-composer")
        .w_full()
        .padding(10.0)
        .gap(6.0)
        .items_end()
        .border_sides([1.0, 0.0, 0.0, 0.0], k.c.border_weak)
        .child(
            TextArea::new(&p.composer)
                .placeholder("Reply here…")
                .width(None)
                .auto_grow(1, 6)
                .on_edit(|s: &mut Hooked| &mut s.split.as_mut().expect("split pane").composer)
                .on_key(|s: &mut Hooked, ev: &rune::KeyEvent, _| {
                    if ev.key == Key::Enter && !ev.mods.shift {
                        s.send_split();
                        return true;
                    }
                    false
                })
                .build(k)
                .key("split-field")
                .grow(1.0)
                .shrink(),
        )
        .child(
            IconButton::new(&icons::ARROW_UP)
                .variant(IconButtonVariant::Contrast)
                .label("Send")
                .disabled(p.sending || p.composer.text.trim().is_empty())
                .on_press(|s: &mut Hooked| s.send_split())
                .build(k)
                .key("split-send"),
        );
    col()
        .key("split")
        .w_frac(0.42)
        .h_full()
        .fill(k.c.bg_base)
        .border_sides([0.0, 0.0, 0.0, 1.0], k.c.border_weak)
        .child(head)
        .child(
            col()
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec { stick_bottom: true })
                .child(chat),
        )
        .child(composer)
        .child(el())
}
