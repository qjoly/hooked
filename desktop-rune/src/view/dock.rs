use rune::{Cursor, El, ScrollSpec, col, el, row, text};
use rune_kit::Kit;

use super::{glyph, section_title};
use crate::api::Detail;
use crate::app::{Hooked, Lens};
use crate::icons;

pub fn has_content(d: &Detail) -> bool {
    !d.todos.is_empty()
        || !d.changes.is_empty()
        || !d.subagents.is_empty()
        || !d.sub_sessions.is_empty()
}

fn card(k: &Kit, key: &str, i: &'static rune::Icon, title: &str, count: String) -> El {
    col()
        .key(key.to_string())
        .w_full()
        .padding(10.0)
        .gap(6.0)
        .radius(k.radius.md)
        .fill(k.c.layer_01)
        .border(1.0, k.c.border_weak)
        .child(
            row()
                .w_full()
                .gap(6.0)
                .center_y()
                .child(glyph(i, 13.0, k.c.icon_muted))
                .child(
                    text(title.to_string())
                        .font(k.ty.ui_medium)
                        .color(k.c.text_base),
                )
                .child(el().grow(1.0))
                .child(text(count).font(k.ty.text_xsmall).color(k.c.text_faint)),
        )
}

fn item(
    k: &Kit,
    mark: &'static rune::Icon,
    mark_color: rune::Color,
    label: String,
    strong: bool,
) -> El {
    row()
        .w_full()
        .gap(6.0)
        .child(glyph(mark, 12.0, mark_color))
        .child(
            text(label)
                .font(k.ty.text_small)
                .color(if strong {
                    k.c.text_base
                } else {
                    k.c.text_muted
                })
                .wrap()
                .grow(1.0)
                .min_w(0.0),
        )
}

pub fn view(s: &Hooked, d: &Detail, k: &Kit) -> El {
    if !s.dock_open || s.lens != Lens::Converse || !has_content(d) {
        return el();
    }
    let mut cards = col().key("dock-cards").w_full().padding(10.0).gap(10.0);
    if !d.todos.is_empty() {
        let done = d.todos.iter().filter(|t| t.status == "completed").count();
        let pct = done as f32 / d.todos.len() as f32;
        let mut c = card(
            k,
            "dock-todos",
            &icons::TASKS,
            "Tasks",
            format!("{done}/{}", d.todos.len()),
        )
        .child(
            el().w_full()
                .h(3.0)
                .radius(1.5)
                .fill(k.c.layer_03)
                .child(el().w_frac(pct).h(3.0).radius(1.5).fill(k.c.success.icon)),
        );
        for t in &d.todos {
            let (mark, color, strong) = match t.status.as_str() {
                "completed" => (&icons::CIRCLE_CHECK, k.c.success.icon, false),
                "in_progress" => (&icons::CIRCLE_DOT, k.c.info.icon, true),
                _ => (&icons::CIRCLE, k.c.icon_faint, false),
            };
            let label = if t.status == "in_progress" {
                t.active_form.clone().unwrap_or_else(|| t.content.clone())
            } else {
                t.content.clone()
            };
            c = c.child(item(k, mark, color, label, strong));
        }
        cards = cards.child(c);
    }
    if !d.changes.is_empty() {
        let n = d.changes.len();
        let mut c = card(
            k,
            "dock-changes",
            &icons::DIFF,
            "Changes",
            format!("{n} file{}", if n == 1 { "" } else { "s" }),
        );
        for ch in d.changes.iter().take(8) {
            c = c.child(
                row()
                    .w_full()
                    .gap(6.0)
                    .help(ch.file.clone())
                    .child(
                        text(ch.label())
                            .font(k.ty.text_small)
                            .color(k.c.text_muted)
                            .truncate()
                            .grow(1.0)
                            .min_w(0.0),
                    )
                    .child(
                        text(if ch.ops.len() > 1 {
                            format!("{} edits", ch.ops.len())
                        } else {
                            String::new()
                        })
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                    ),
            );
        }
        c = c.child(
            k.interactive(
                row()
                    .key("dock-open-review")
                    .role("button")
                    .h(24.0)
                    .px(6.0)
                    .center_y()
                    .radius(k.radius.sm)
                    .cursor(Cursor::Pointer)
                    .child(
                        text("Open Review →")
                            .font(k.ty.text_small_medium)
                            .color(k.c.text_accent),
                    ),
            )
            .on_press(|s: &mut Hooked| s.lens = Lens::Review),
        );
        cards = cards.child(c);
    }
    if !d.subagents.is_empty() {
        let mut c = card(
            k,
            "dock-agents",
            &icons::BOT,
            "Agents",
            d.subagents.len().to_string(),
        );
        for a in d.subagents.iter().take(6) {
            let label = match &a.description {
                Some(dsc) => format!(
                    "{} · {dsc}",
                    a.kind.clone().unwrap_or_else(|| "agent".into())
                ),
                None => a.kind.clone().unwrap_or_else(|| "agent".into()),
            };
            c = c.child(item(k, &icons::BOT, k.c.icon_faint, label, false));
        }
        cards = cards.child(c);
    }
    if !d.sub_sessions.is_empty() {
        let mut c = card(
            k,
            "dock-subs",
            &icons::LINK,
            "Sub-sessions",
            d.sub_sessions.len().to_string(),
        );
        for sub in &d.sub_sessions {
            let id = sub.id.clone();
            let label = sub
                .label
                .clone()
                .filter(|l| !l.is_empty())
                .or_else(|| s.session(&sub.id).map(|x| x.display_title()))
                .unwrap_or_else(|| sub.id.clone());
            c = c.child(
                k.interactive(
                    row()
                        .key(format!("sub-{}", sub.id))
                        .role("link")
                        .w_full()
                        .py(2.0)
                        .px(4.0)
                        .radius(k.radius.sm)
                        .cursor(Cursor::Pointer)
                        .child(
                            text(label)
                                .font(k.ty.text_small)
                                .color(k.c.text_accent)
                                .truncate(),
                        ),
                )
                .on_press(move |s: &mut Hooked| s.open_session(&id)),
            );
        }
        cards = cards.child(c);
    }
    col()
        .key("dock")
        .w(290.0)
        .h_full()
        .fill(k.c.bg_deep)
        .border_sides([0.0, 0.0, 0.0, 1.0], k.c.border_weak)
        .child(
            row()
                .w_full()
                .px(14.0)
                .pt(12.0)
                .child(section_title(k, "SESSION CONTEXT")),
        )
        .child(
            col()
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(cards),
        )
}
