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
                                    .color(s.tag_color(k.dark, &t)),
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
        Some(Picker::Trash { items, busy }) => trash(s, k, items.as_deref(), busy.as_deref()),
        Some(Picker::Fork {
            model,
            effort,
            mode,
            prompt,
            ..
        }) => fork(s, k, model.as_deref(), effort.as_deref(), mode, prompt),
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

fn trash(s: &Hooked, k: &Kit, items: Option<&[serde_json::Value]>, busy: Option<&str>) -> El {
    let sub = match items {
        None => "Loading…".to_string(),
        Some([]) => "Empty. Deleted sessions land here and stay recoverable.".to_string(),
        Some(l) => format!(
            "{} session{}: the transcript is kept in bin/, restorable anytime.",
            l.len(),
            if l.len() == 1 { "" } else { "s" }
        ),
    };
    let mut list = col()
        .key("trash-list")
        .w_full()
        .gap(2.0)
        .max_h(420.0)
        .scroll(rune::ScrollSpec {
            stick_bottom: false,
        });
    for it in items.unwrap_or_default() {
        let id = it["id"].as_str().unwrap_or("").to_string();
        let title = ["title", "firstPrompt"]
            .iter()
            .filter_map(|f| it[*f].as_str())
            .find(|t| !t.is_empty() && *t != "(sans titre)")
            .unwrap_or("(untitled)")
            .to_string();
        let mut meta = format!(
            "{} · deleted {} ago",
            it["projectName"].as_str().unwrap_or("?"),
            crate::fmt::ago_short(it["trashedAt"].as_str(), s.now)
        );
        if let Some(c) = it["cost"].as_f64().filter(|c| *c > 0.0) {
            meta.push_str(&format!(" · {}", crate::fmt::cost(Some(c))));
        }
        let on = busy == Some(id.as_str());
        list = list.child(
            row()
                .key(format!("trash-{id}"))
                .w_full()
                .py(6.0)
                .gap(10.0)
                .center_y()
                .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_weak)
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(2.0)
                        .child(text(title).font(k.ty.ui).color(k.c.text_base).truncate())
                        .child(text(meta).font(k.ty.text_xsmall).color(k.c.text_faint)),
                )
                .child(
                    Button::new(if on { "Restoring…" } else { "Restore" })
                        .variant(ButtonVariant::Outline)
                        .disabled(busy.is_some())
                        .on_press(move |s: &mut Hooked| s.restore(id.clone()))
                        .build(k),
                ),
        );
    }
    let body = col()
        .w_full()
        .gap(10.0)
        .child(text(sub).font(k.ty.text_small).color(k.c.text_muted))
        .child(list);
    modal(k, "trash-modal", "Trash", body)
}

fn set_fork(s: &mut Hooked, f: impl FnOnce(&mut Option<String>, &mut Option<String>, &mut String)) {
    if let Some(Picker::Fork {
        model,
        effort,
        mode,
        ..
    }) = s.picker.as_mut()
    {
        f(model, effort, mode);
    }
}

fn fork(
    s: &Hooked,
    k: &Kit,
    model: Option<&str>,
    effort: Option<&str>,
    mode: &str,
    prompt: &rune::TextEdit,
) -> El {
    use super::settings::{chip, chips};
    let models = s
        .visible_models()
        .into_iter()
        .map(|(id, label)| {
            let on = model == Some(id.as_str());
            chip(k, format!("fm-{id}"), label, on, move |s| {
                let id = id.clone();
                set_fork(s, |m, _, _| *m = Some(id));
            })
        })
        .collect();
    let efforts = s
        .caps
        .efforts
        .iter()
        .map(|e| {
            let e = e.clone();
            chip(
                k,
                format!("fe-{e}"),
                e.clone(),
                effort == Some(e.as_str()),
                move |s| {
                    let e = e.clone();
                    set_fork(s, |_, ef, _| *ef = Some(e));
                },
            )
        })
        .collect();
    let modes = crate::fmt::LAUNCH_MODES
        .iter()
        .map(|&m| {
            chip(
                k,
                format!("fmode-{m}"),
                crate::fmt::mode_label(m).into(),
                mode == m,
                move |s| set_fork(s, |_, _, md| *md = m.to_string()),
            )
        })
        .collect();
    let line = |label: &str, body: El| {
        col()
            .w_full()
            .gap(6.0)
            .child(super::section_title(k, label))
            .child(body)
    };
    let body = col()
        .w_full()
        .gap(12.0)
        .child(line("MODEL", chips(models)))
        .child(line("EFFORT", chips(efforts)))
        .child(line("MODE", chips(modes)))
        .child(
            rune_kit::TextArea::new(prompt)
                .placeholder("New direction from this point… (leave empty to just open the branch)")
                .width(None)
                .auto_grow(3, 8)
                .on_edit(|s: &mut Hooked| match s.picker.as_mut() {
                    Some(Picker::Fork { prompt, .. }) => prompt,
                    _ => unreachable!("fork closed while editing"),
                })
                .build(k)
                .key("fork-prompt"),
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
                        .build(k),
                )
                .child(
                    Button::new("Fork")
                        .variant(ButtonVariant::Contrast)
                        .on_press(|s: &mut Hooked| s.fork_with_options())
                        .build(k)
                        .key("fork-go"),
                ),
        );
    modal(k, "fork-modal", "Fork from this message", body)
}
