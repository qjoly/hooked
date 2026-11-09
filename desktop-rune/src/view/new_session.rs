use rune::{Color, Cursor, El, ScrollSpec, col, el, row, text};
use rune_kit::{
    Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant, Kit, Switch, TextArea,
    TextInput,
};

use super::settings::{chip, chips};
use super::{glyph, section_title};
use crate::app::Hooked;
use crate::{fmt, icons};

fn controls(s: &Hooked, k: &Kit) -> El {
    let models = std::iter::once(chip(
        k,
        "nm-default".into(),
        "Default".into(),
        s.new_model.is_none(),
        |s| s.new_model = None,
    ))
    .chain(s.visible_models().into_iter().map(|(id, label)| {
        let on = s.new_model.as_deref() == Some(id.as_str());
        chip(k, format!("nm-{id}"), label, on, move |s| {
            s.new_model = Some(id.clone())
        })
    }))
    .collect();
    let efforts = std::iter::once(chip(
        k,
        "ne-default".into(),
        "Default".into(),
        s.new_effort.is_none(),
        |s| s.new_effort = None,
    ))
    .chain(s.caps.efforts.iter().map(|e| {
        let e = e.clone();
        chip(
            k,
            format!("ne-{e}"),
            e.clone(),
            s.new_effort.as_deref() == Some(e.as_str()),
            move |s| s.new_effort = Some(e.clone()),
        )
    }))
    .collect();
    let modes = fmt::LAUNCH_MODES
        .iter()
        .map(|&m| {
            chip(
                k,
                format!("nmode-{m}"),
                fmt::mode_label(m).into(),
                s.new_mode == m,
                move |s| s.new_mode = m.to_string(),
            )
        })
        .collect();
    let line = |label: &str, body: El| {
        row()
            .w_full()
            .gap(12.0)
            .items_start()
            .child(row().w(80.0).pt(4.0).child(section_title(k, label)))
            .child(body.grow(1.0).shrink())
    };
    col()
        .key("new-controls")
        .w_full()
        .gap(10.0)
        .child(line("MODEL", chips(models)))
        .child(line("EFFORT", chips(efforts)))
        .child(line("MODE", chips(modes)))
        .child(line(
            "OPTIONS",
            chips(vec![
                chip(
                    k,
                    "nw-worktree".into(),
                    "Git worktree".into(),
                    s.new_worktree,
                    |s| s.new_worktree = !s.new_worktree,
                ),
                chip(
                    k,
                    "nw-ephemeral".into(),
                    "Ephemeral".into(),
                    s.new_ephemeral,
                    |s| s.new_ephemeral = !s.new_ephemeral,
                ),
            ]),
        ))
}

fn projects(s: &Hooked, k: &Kit) -> El {
    let q = s.new_search.text.trim().to_lowercase();
    let current = s.new_project.text.trim().to_string();
    let hits: Vec<(String, bool)> = s
        .launch_projects()
        .into_iter()
        .filter(|(p, _)| q.is_empty() || p.to_lowercase().contains(&q))
        .take(14)
        .collect();
    let mut list = col().key("new-projects").w_full().gap(2.0);
    for (path, fav) in hits {
        let on = !s.new_custom && current == path;
        let name = path.rsplit('/').next().unwrap_or(&path).to_string();
        let hue = crate::theme::folder_color(k.dark, &path);
        let (pick, star) = (path.clone(), path.clone());
        list = list.child(
            k.interactive(
                row()
                    .key(format!("proj-{path}"))
                    .role("option")
                    .checked(on)
                    .w_full()
                    .px(10.0)
                    .py(6.0)
                    .gap(10.0)
                    .center_y()
                    .radius(k.radius.md)
                    .cursor(Cursor::Pointer)
                    .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
                    .border(
                        1.0,
                        if on {
                            k.c.border_focus
                        } else {
                            Color::TRANSPARENT
                        },
                    )
                    .child(
                        row()
                            .size(26.0, 26.0)
                            .center()
                            .radius(k.radius.sm)
                            .fill(hue.alpha(0.14))
                            .child(glyph(&icons::FOLDER, 14.0, hue)),
                    )
                    .child(
                        col()
                            .grow(1.0)
                            .shrink()
                            .gap(1.0)
                            .child(text(name).font(k.ty.ui_medium).color(k.c.text_base))
                            .child(
                                text(path.clone())
                                    .font(k.ty.text_xsmall)
                                    .color(k.c.text_faint)
                                    .truncate(),
                            ),
                    )
                    .child(
                        IconButton::new(&icons::STAR)
                            .variant(if fav {
                                IconButtonVariant::Neutral
                            } else {
                                IconButtonVariant::GhostMuted
                            })
                            .control_size(ControlSize::Small)
                            .label(if fav {
                                "Remove from favorites"
                            } else {
                                "Add to favorites"
                            })
                            .help(if fav {
                                "Remove from favorites"
                            } else {
                                "Add to favorites"
                            })
                            .on_press(move |s: &mut Hooked| {
                                s.toggle_in_list("favoriteProjects", &star)
                            })
                            .build(k),
                    ),
            )
            .on_press(move |s: &mut Hooked| {
                s.new_custom = false;
                s.new_project = rune::TextEdit::new(pick.clone());
            }),
        );
    }
    list = list.child(
        k.interactive(
            row()
                .key("proj-custom")
                .role("option")
                .checked(s.new_custom)
                .w_full()
                .px(10.0)
                .py(6.0)
                .gap(10.0)
                .center_y()
                .radius(k.radius.md)
                .cursor(Cursor::Pointer)
                .fill(if s.new_custom {
                    k.c.layer_02
                } else {
                    Color::TRANSPARENT
                })
                .border(
                    1.0,
                    if s.new_custom {
                        k.c.border_focus
                    } else {
                        Color::TRANSPARENT
                    },
                )
                .child(
                    row()
                        .size(26.0, 26.0)
                        .center()
                        .radius(k.radius.sm)
                        .fill(k.c.layer_02)
                        .child(glyph(&icons::PLUS, 14.0, k.c.icon_muted)),
                )
                .child(
                    text("Other folder…")
                        .font(k.ty.ui_medium)
                        .color(k.c.text_base),
                ),
        )
        .on_press(|s: &mut Hooked| {
            s.new_custom = true;
            s.new_project.focused = true;
        }),
    );
    if s.new_custom {
        list = list.child(
            row()
                .key("proj-custom-row")
                .w_full()
                .gap(8.0)
                .pt(4.0)
                .child(
                    TextInput::new(&s.new_project)
                        .placeholder("/path/to/the/project")
                        .leading_icon(&icons::FOLDER)
                        .width(None)
                        .on_edit(|s: &mut Hooked| &mut s.new_project)
                        .build(k)
                        .key("new-project")
                        .grow(1.0)
                        .shrink(),
                )
                .child(
                    Button::new("Browse…")
                        .variant(ButtonVariant::Outline)
                        .on_press(|s: &mut Hooked| s.pick_folder())
                        .build(k)
                        .key("new-browse"),
                ),
        );
    }
    list
}

pub fn view(s: &Hooked, k: &Kit, _layer: &mut Vec<El>) -> El {
    let project = s.new_project.text.trim();
    let summary = if project.is_empty() {
        "Pick a project".to_string()
    } else {
        format!("in {project}")
    };
    let header = row()
        .key("new-head")
        .w_full()
        .gap(10.0)
        .center_y()
        .child(
            IconButton::new(&icons::ARROW_LEFT)
                .variant(IconButtonVariant::GhostMuted)
                .label("Back")
                .on_press(|s: &mut Hooked| s.go_deck())
                .build(k)
                .key("new-back"),
        )
        .child(
            col()
                .gap(2.0)
                .child(
                    text("New session")
                        .font(k.ty.body_medium)
                        .color(k.c.text_base),
                )
                .child(
                    text(match s.new_group.as_deref().and_then(|g| s.session(g)) {
                        Some(m) => format!("Joins the group {}", s.group_label(m)),
                        None => "Launches a Claude Code session driven by hooked.".to_string(),
                    })
                    .font(k.ty.text_small)
                    .color(k.c.text_faint),
                ),
        );
    let prompt = TextArea::new(&s.new_prompt)
        .placeholder("What should Claude do? (⌘Enter to launch)")
        .auto_grow(4, 16)
        .width(None)
        .on_edit(|s: &mut Hooked| &mut s.new_prompt)
        .on_key(|s: &mut Hooked, ev: &rune::KeyEvent, _| {
            if ev.key == rune::Key::Enter && ev.mods.cmd {
                s.launch();
                return true;
            }
            false
        })
        .build(k)
        .key("new-prompt");
    let launch_row = row()
        .key("new-actions")
        .w_full()
        .gap(10.0)
        .center_y()
        .child(
            text(summary)
                .font(k.ty.text_small)
                .color(k.c.text_faint)
                .truncate()
                .grow(1.0)
                .shrink(),
        )
        .child(
            Button::new("Cancel")
                .variant(ButtonVariant::GhostMuted)
                .on_press(|s: &mut Hooked| s.go_deck())
                .build(k)
                .key("new-cancel"),
        )
        .child(
            Button::new(if s.sending { "Launching…" } else { "Launch" })
                .icon(&icons::PLAY)
                .variant(ButtonVariant::Contrast)
                .shortcut("⌘↵")
                .disabled(s.sending || project.is_empty())
                .on_press(|s: &mut Hooked| s.launch())
                .build(k)
                .key("new-launch"),
        );
    let project_head = row()
        .w_full()
        .gap(10.0)
        .center_y()
        .child(section_title(k, "PROJECT"))
        .child(el().grow(1.0))
        .child(
            text("Collapse worktrees")
                .font(k.ty.text_small)
                .color(k.c.text_muted),
        )
        .child(
            Switch::new(s.collapse_worktrees)
                .hide_label()
                .label("Collapse worktrees")
                .on_toggle(|s: &mut Hooked| {
                    s.collapse_worktrees = !s.collapse_worktrees;
                    let v = s.collapse_worktrees;
                    s.save_pref("collapseWorktrees", &v);
                })
                .build(k)
                .key("new-collapse"),
        );
    let search = TextInput::new(&s.new_search)
        .placeholder("Search a project…")
        .leading_icon(&icons::SEARCH)
        .width(None)
        .on_edit(|s: &mut Hooked| &mut s.new_search)
        .build(k)
        .key("new-search");
    let form = col()
        .key("new-form")
        .w_full()
        .max_w(820.0)
        .self_center()
        .padding(28.0)
        .gap(18.0)
        .child(header)
        .child(prompt)
        .child(prompt_pills(s, k))
        .child(controls(s, k))
        .child(launch_row)
        .child(
            col()
                .w_full()
                .gap(8.0)
                .child(project_head)
                .child(search)
                .child(projects(s, k)),
        );
    col()
        .key("new-page")
        .w_full()
        .h_full()
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(form)
}

fn prompt_pills(s: &Hooked, k: &Kit) -> El {
    let list = s.prompts();
    let mut r = row()
        .key("new-prompts")
        .w_full()
        .gap(6.0)
        .flex_wrap()
        .center_y();
    if list.is_empty() {
        return r;
    }
    r = r.child(section_title(k, "PROMPTS"));
    for (i, (name, text)) in list.into_iter().enumerate() {
        r = r.child(chip(k, format!("np-{i}"), name, false, move |s| {
            let cur = s.new_prompt.text.trim_end().to_string();
            let next = if cur.is_empty() {
                text.clone()
            } else {
                format!("{cur}\n\n{text}")
            };
            let end = next.len();
            s.new_prompt.replace_text(next);
            s.new_prompt.set_caret(end);
            s.new_prompt.focused = true;
        }));
    }
    r.child(
        Button::new("Manage")
            .variant(ButtonVariant::GhostMuted)
            .control_size(ControlSize::Small)
            .on_press(|s: &mut Hooked| s.go(crate::app::Page::Prompts))
            .build(k),
    )
}
