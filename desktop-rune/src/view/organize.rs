use rune::{Color, Cursor, El, Key, col, el, row, text};
use rune_kit::{Button, ButtonVariant, Kit, TextInput};

use super::{Shadows, dot};
use crate::app::Hooked;
use crate::organize::{Picker, parse_tags};

fn modal(k: &Kit, key: &str, title: &str, body: El) -> El {
    let panel = col()
        .key(format!("{key}-panel"))
        .w(520.0)
        .padding(16.0)
        .gap(12.0)
        .radius(k.radius.lg)
        .fill(k.c.bg_base)
        .border(1.0, k.c.border_base)
        .box_shadows(&k.elevation.overlay)
        .child(
            text(title.to_string())
                .font(k.ty.ui_medium)
                .color(k.c.text_base),
        )
        .child(body);
    el().key(key.to_string())
        .absolute(0.0, 0.0)
        .w_full()
        .h_full()
        .fill(k.c.scrim)
        .items_center()
        .pt(120.0)
        .modal(true, |s: &mut Hooked| s.picker = None)
        .child(col().items_center().w_full().child(panel))
}

pub fn view(s: &Hooked, k: &Kit) -> El {
    match s.picker.as_ref() {
        None => el(),
        Some(Picker::Tags { id, edit }) => {
            let current = parse_tags(&edit.text);
            let title = s.session(id).map(|x| x.display_title()).unwrap_or_default();
            let suggestions = row()
                .key("tag-suggest")
                .w_full()
                .gap(6.0)
                .flex_wrap()
                .children(s.known_tags().into_iter().map(|(t, _)| {
                    let on = current.contains(&t);
                    let tag = t.clone();
                    k.interactive(
                        row()
                            .key(format!("ts-{t}"))
                            .role("checkbox")
                            .checked(on)
                            .h(24.0)
                            .px(9.0)
                            .center_y()
                            .radius(12.0)
                            .cursor(Cursor::Pointer)
                            .fill(if on { k.c.layer_03 } else { Color::TRANSPARENT })
                            .border(
                                1.0,
                                if on {
                                    k.c.border_strong
                                } else {
                                    k.c.border_weak
                                },
                            )
                            .child(
                                text(format!("#{t}"))
                                    .font(k.ty.text_small)
                                    .color(crate::theme::tag_color(k.dark, &t)),
                            ),
                    )
                    .on_press(move |s: &mut Hooked| s.toggle_tag_in_editor(&tag))
                }));
            let body = col()
                .w_full()
                .gap(10.0)
                .child(
                    text(title)
                        .font(k.ty.text_small)
                        .color(k.c.text_faint)
                        .truncate(),
                )
                .child(
                    TextInput::new(edit)
                        .placeholder("Tags, separated by spaces or commas")
                        .width(None)
                        .on_edit(|s: &mut Hooked| match s.picker.as_mut() {
                            Some(Picker::Tags { edit, .. }) => edit,
                            _ => unreachable!("tag editor closed while editing"),
                        })
                        .on_submit(|s: &mut Hooked, _| s.save_tags())
                        .build(k)
                        .key("tag-input"),
                )
                .child(suggestions)
                .child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .justify_end()
                        .child(
                            Button::new("Cancel")
                                .variant(ButtonVariant::GhostMuted)
                                .on_press(|s: &mut Hooked| s.picker = None)
                                .build(k)
                                .key("tag-cancel"),
                        )
                        .child(
                            Button::new("Save")
                                .variant(ButtonVariant::Contrast)
                                .on_press(|s: &mut Hooked| s.save_tags())
                                .build(k)
                                .key("tag-save"),
                        ),
                );
            modal(k, "tags-modal", "Edit tags", body)
        }
        Some(Picker::Group { id, query }) => {
            let q = query.text.trim().to_lowercase();
            let me = id.clone();
            let mut seen = std::collections::HashSet::new();
            let targets: Vec<_> = s
                .sessions
                .iter()
                .filter(|x| x.id != me && s.visible(x) && !s.is_archived(x))
                .map(|x| s.group_of(&x.id).and_then(|m| s.session(m)).unwrap_or(x))
                .filter(|x| x.id != me && seen.insert(x.id.clone()))
                .filter(|x| {
                    q.is_empty()
                        || format!("{} {}", s.group_label(x), x.project_label())
                            .to_lowercase()
                            .contains(&q)
                })
                .take(12)
                .collect();
            let list =
                col()
                    .key("group-targets")
                    .w_full()
                    .gap(2.0)
                    .children(targets.into_iter().map(|x| {
                        let (sid, target) = (me.clone(), x.id.clone());
                        let members = s.group_members(&x.id).len();
                        k.interactive(
                            row()
                                .key(format!("gt-{}", x.id))
                                .role("option")
                                .w_full()
                                .h(34.0)
                                .px(10.0)
                                .gap(8.0)
                                .center_y()
                                .radius(k.radius.md)
                                .cursor(Cursor::Pointer)
                                .child(dot(k, &x.state, 7.0))
                                .child(
                                    text(s.group_label(x))
                                        .font(k.ty.ui)
                                        .color(k.c.text_base)
                                        .truncate()
                                        .grow(1.0)
                                        .shrink(),
                                )
                                .child(
                                    text(if members > 1 {
                                        format!("group of {members}")
                                    } else {
                                        x.project_label()
                                    })
                                    .font(k.ty.text_xsmall)
                                    .color(k.c.text_faint),
                                ),
                        )
                        .on_press(move |s: &mut Hooked| {
                            s.group_op("join", sid.clone(), serde_json::json!({ "target": target }))
                        })
                    }));
            let body = col()
                .w_full()
                .gap(10.0)
                .child(
                    TextInput::new(query)
                        .placeholder("Join the group of…")
                        .width(None)
                        .on_edit(|s: &mut Hooked| match s.picker.as_mut() {
                            Some(Picker::Group { query, .. }) => query,
                            _ => unreachable!("group picker closed while editing"),
                        })
                        .on_key(|s: &mut Hooked, ev: &rune::KeyEvent, _| {
                            if ev.key == Key::Escape {
                                s.picker = None;
                                return true;
                            }
                            false
                        })
                        .build(k)
                        .key("group-query"),
                )
                .child(list);
            modal(k, "group-modal", "Move to group", body)
        }
        Some(Picker::RenameGroup { edit, .. }) => {
            let body = col()
                .w_full()
                .gap(10.0)
                .child(
                    TextInput::new(edit)
                        .placeholder("Group name (empty restores the lead session's title)")
                        .width(None)
                        .on_edit(|s: &mut Hooked| match s.picker.as_mut() {
                            Some(Picker::RenameGroup { edit, .. }) => edit,
                            _ => unreachable!("rename closed while editing"),
                        })
                        .on_submit(|s: &mut Hooked, _| s.save_group_name())
                        .build(k)
                        .key("group-name"),
                )
                .child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .justify_end()
                        .child(
                            Button::new("Cancel")
                                .variant(ButtonVariant::GhostMuted)
                                .on_press(|s: &mut Hooked| s.picker = None)
                                .build(k)
                                .key("gn-cancel"),
                        )
                        .child(
                            Button::new("Rename")
                                .variant(ButtonVariant::Contrast)
                                .on_press(|s: &mut Hooked| s.save_group_name())
                                .build(k)
                                .key("gn-save"),
                        ),
                );
            modal(k, "rename-modal", "Rename the group", body)
        }
    }
}
