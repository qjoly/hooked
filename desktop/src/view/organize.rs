use rune::{Color, Cursor, El, Key, col, el, row, text};
use rune_kit::{Button, ButtonVariant, Kit, TextInput};

use super::{Shadows, dot, modal_scrim};
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
    modal_scrim(k, key, 120.0, panel, |s: &mut Hooked| s.picker = None)
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
        Some(Picker::Filter { repos, query }) => filter_picker(s, k, *repos, query),
        Some(Picker::Trash { items, busy }) => trash(s, k, items.as_deref(), busy.as_deref()),
        Some(Picker::Image { paths, index }) => image(s, k, paths, *index),
        Some(Picker::Cost) => cost(s, k),
        Some(Picker::Account(a)) => account(s, k, a),
        Some(Picker::Move(w)) => move_modal(s, k, w),
        Some(Picker::Agent {
            title, messages, ..
        }) => agent(s, k, title, messages.as_deref()),
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

fn filter_picker(s: &Hooked, k: &Kit, repos: bool, query: &rune::TextEdit) -> El {
    let picked = if repos { &s.repo_filter } else { &s.tag_filter };
    let options = s.filter_options(repos, &query.text);
    let list = col()
        .key("filter-options")
        .w_full()
        .max_h(360.0)
        .gap(2.0)
        .scroll(rune::ScrollSpec {
            stick_bottom: false,
        })
        .children(options.into_iter().map(|(value, n)| {
            let on = picked.contains(&value);
            let label = if repos {
                value.clone()
            } else {
                format!("#{value}")
            };
            let color = if repos {
                k.c.text_base
            } else {
                s.tag_color(k.dark, &value)
            };
            let v = value.clone();
            k.interactive(
                row()
                    .key(format!("fo-{value}"))
                    .role("option")
                    .checked(on)
                    .w_full()
                    .h(32.0)
                    .px(10.0)
                    .gap(8.0)
                    .center_y()
                    .radius(k.radius.md)
                    .cursor(Cursor::Pointer)
                    .child(super::glyph(
                        if on {
                            &crate::icons::CIRCLE_CHECK
                        } else {
                            &crate::icons::CIRCLE
                        },
                        14.0,
                        if on { k.c.text_accent } else { k.c.icon_faint },
                    ))
                    .child(
                        text(label)
                            .font(k.ty.ui)
                            .color(color)
                            .truncate()
                            .grow(1.0)
                            .shrink(),
                    )
                    .child(
                        text(n.to_string())
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_faint),
                    ),
            )
            .on_press(move |s: &mut Hooked| s.toggle_filter(repos, v.clone()))
        }));
    let body = col()
        .w_full()
        .gap(10.0)
        .child(
            TextInput::new(query)
                .placeholder(if repos {
                    "Search repos… (Enter picks the first)"
                } else {
                    "Search tags… (Enter picks the first)"
                })
                .width(None)
                .on_edit(|s: &mut Hooked| match s.picker.as_mut() {
                    Some(Picker::Filter { query, .. }) => query,
                    _ => unreachable!("filter picker closed while editing"),
                })
                .on_submit(move |s: &mut Hooked, _| {
                    let q = match s.picker.as_ref() {
                        Some(Picker::Filter { query, .. }) => query.text.clone(),
                        _ => return,
                    };
                    if let Some((first, _)) = s.filter_options(repos, &q).into_iter().next() {
                        s.toggle_filter(repos, first);
                    }
                })
                .on_key(|s: &mut Hooked, ev: &rune::KeyEvent, _| {
                    if ev.key == Key::Escape {
                        s.picker = None;
                        return true;
                    }
                    false
                })
                .build(k)
                .key("filter-query"),
        )
        .child(list)
        .child(
            row().w_full().justify_end().child(
                Button::new("Done")
                    .variant(ButtonVariant::Contrast)
                    .on_press(|s: &mut Hooked| s.picker = None)
                    .build(k)
                    .key("filter-done"),
            ),
        );
    modal(
        k,
        "filter-modal",
        if repos {
            "Filter by repo · any of"
        } else {
            "Filter by tag · all of"
        },
        body,
    )
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
    // The fork runs on its session's profile: a server's own models, and no effort levels.
    let profile = s
        .detail
        .as_ref()
        .filter(|d| d.session.remote.is_none())
        .and_then(|d| d.session.profile.as_ref())
        .map(|p| p.id.clone());
    let on_server = s.is_server(profile.as_deref());
    let models = s
        .models_for(profile.as_deref())
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
        .children((!on_server).then(|| line("EFFORT", chips(efforts))))
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

fn agent(s: &Hooked, k: &Kit, title: &str, messages: Option<&[crate::api::Message]>) -> El {
    let session = s.selected.clone().unwrap_or_default();
    let mut list = col().w_full().gap(12.0).padding(16.0);
    match messages {
        None => {
            list = list.child(
                text("Loading the transcript…")
                    .font(k.ty.body)
                    .color(k.c.text_faint),
            )
        }
        Some([]) => {
            list = list.child(
                text("This agent left no transcript.")
                    .font(k.ty.body)
                    .color(k.c.text_faint),
            )
        }
        Some(ms) => {
            for (i, m) in ms.iter().enumerate() {
                list = list.child(super::session::bubble(s, &session, m, k, 10_000 + i));
            }
        }
    }
    let panel = col()
        .key("agent-panel")
        .w(860.0)
        .h(s.window_h * 0.8)
        .radius(k.radius.lg)
        .fill(k.c.bg_base)
        .border(1.0, k.c.border_base)
        .box_shadows(&k.elevation.overlay)
        .child(
            row()
                .w_full()
                .h(44.0)
                .px(16.0)
                .gap(8.0)
                .center_y()
                .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_weak)
                .child(
                    text(title.to_string())
                        .font(k.ty.ui_medium)
                        .color(k.c.text_base)
                        .truncate()
                        .grow(1.0)
                        .min_w(0.0),
                )
                .child(
                    Button::new("Close")
                        .variant(ButtonVariant::GhostMuted)
                        .on_press(|s: &mut Hooked| s.picker = None)
                        .build(k),
                ),
        )
        .child(
            col()
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .scroll(rune::ScrollSpec {
                    stick_bottom: false,
                })
                .child(list),
        );
    modal_scrim(k, "agent-modal", 60.0, panel, |s: &mut Hooked| {
        s.picker = None
    })
}

fn image(s: &Hooked, k: &Kit, paths: &[String], index: usize) -> El {
    let Some(path) = paths.get(index) else {
        return el();
    };
    let img = s.media.get(path).and_then(Option::as_ref);
    let (max_w, max_h) = (1280.0_f32, (s.window_h - 140.0).max(200.0));
    let pic = match img.and_then(|i| i.size().map(|sz| (i, sz))) {
        Some((i, [w, h])) => {
            let (w, h) = (w.max(1) as f32 / 2.0, h.max(1) as f32 / 2.0);
            let scale = (max_w / w).min(max_h / h).min(2.0);
            el().size(w * scale, h * scale).pixels(i.pixels())
        }
        None => text("Loading…").font(k.ty.body).color(k.c.text_faint),
    };
    let name = path.rsplit('/').next().unwrap_or(path).to_string();
    let url = format!("file://{path}");
    let bar = row()
        .gap(10.0)
        .center_y()
        .padding(8.0)
        .radius(k.radius.md)
        .fill(k.c.bg_base)
        .child(text(name).font(k.ty.ui_medium).color(k.c.text_base))
        .child(
            text(if paths.len() > 1 {
                format!("{} / {} · ← →", index + 1, paths.len())
            } else {
                String::new()
            })
            .font(k.ty.text_xsmall)
            .color(k.c.text_faint),
        )
        .child(
            Button::new("Open in Preview")
                .variant(ButtonVariant::GhostMuted)
                .on_press_tx(move |_: &mut Hooked, tx| {
                    let _ = tx.open_url(&url);
                })
                .build(k),
        )
        .child(
            Button::new("Close")
                .variant(ButtonVariant::GhostMuted)
                .on_press(|s: &mut Hooked| s.picker = None)
                .build(k),
        );
    let viewer = col()
        .items_center()
        .gap(10.0)
        .child(bar)
        .child(pic.radius(k.radius.md).clip_rounded(k.radius.md));
    modal_scrim(k, "image-modal", 30.0, viewer, |s: &mut Hooked| {
        s.picker = None
    })
}

fn tokens(n: f64) -> String {
    if n >= 1e6 {
        format!("{:.1}M", n / 1e6)
    } else if n >= 1e3 {
        format!("{:.0}k", n / 1e3)
    } else {
        format!("{n:.0}")
    }
}

fn cost(s: &Hooked, k: &Kit) -> El {
    let Some(d) = s.detail.as_ref() else {
        return el();
    };
    let cb = d.cost_break.clone().unwrap_or_default();
    let usage = d.usage.clone().unwrap_or_default();
    let parts = [
        ("Input", "input", k.c.info.fg),
        ("Output", "output", k.c.success.fg),
        ("Cache write", "cacheCreate", k.c.warning.fg),
        ("Cache read", "cacheRead", k.c.danger.fg),
    ];
    let total: f64 = parts
        .iter()
        .map(|(_, key, _)| cb[*key].as_f64().unwrap_or(0.0))
        .sum::<f64>()
        .max(1e-9);
    let mut body = col().w_full().gap(10.0);
    for (label, key, color) in parts {
        let c = cb[key].as_f64().unwrap_or(0.0);
        let share = (c / total) as f32;
        body = body.child(
            col()
                .w_full()
                .gap(4.0)
                .child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .child(
                            text(label)
                                .font(k.ty.text_small_medium)
                                .color(k.c.text_base),
                        )
                        .child(
                            text(format!(
                                "{} tokens",
                                tokens(usage[key].as_f64().unwrap_or(0.0))
                            ))
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_faint),
                        )
                        .child(el().grow(1.0))
                        .child(
                            text(format!(
                                "{} · {:.0}%",
                                crate::fmt::cost(Some(c)),
                                share * 100.0
                            ))
                            .font(k.ty.text_small)
                            .color(k.c.text_muted),
                        ),
                )
                .child(
                    el().w_full()
                        .h(6.0)
                        .radius(3.0)
                        .fill(k.c.layer_02)
                        .child(el().w_frac(share).h(6.0).radius(3.0).fill(color)),
                ),
        );
    }
    let mut foot = format!("Total {}", crate::fmt::cost(d.session.cost));
    if let Some(sub) = d.subagent_cost.filter(|c| *c > 0.0) {
        foot.push_str(&format!(" · subagents {}", crate::fmt::cost(Some(sub))));
    }
    body = body
        .child(text(foot).font(k.ty.ui_medium).color(k.c.text_base))
        .child(
            text("Rates: Fable 10/50, Opus 5/25, Sonnet 3/15, Haiku 1/5 $/Mtok; cache write ×1.25, read ×0.1.")
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint)
                .wrap(),
        );
    modal(k, "cost-modal", "Cost of this session", body)
}

/// The accounts window: one card per Claude account (the main one first), the servers, and the
/// forms that add either.
fn account(s: &Hooked, k: &Kit, a: &crate::account::AccountWin) -> El {
    use crate::app::Hooked as H;
    // The account new sessions start on, when it still has a card.
    let default_key = s
        .default_profile_id()
        .filter(|d| a.cards.iter().any(|c| &c.key == d))
        .unwrap_or_default();
    let mut body = col().key("acc-body").w_full().gap(12.0);
    if let Some(n) = a.notice.as_ref() {
        body = body.child(
            text(n.clone())
                .font(k.ty.text_small)
                .color(k.c.text_muted)
                .wrap()
                .key("acc-notice"),
        );
    }
    if !a.loaded {
        body = body.child(text("Loading…").font(k.ty.text_small).color(k.c.text_faint));
    }
    for c in &a.cards {
        body = body.child(account_card(k, a, c, c.key == default_key));
    }
    if !a.servers.is_empty() {
        body = body.child(super::section_title(k, "SERVERS"));
        for p in &a.servers {
            body = body.child(server_card(k, a, p));
        }
    }
    body = body
        .child(super::section_title(k, "ADD"))
        .child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(
                    TextInput::new(&a.new_name)
                        .placeholder("A Claude account: name it, then sign it in")
                        .width(None)
                        .on_edit(|s: &mut H| match s.picker.as_mut() {
                            Some(Picker::Account(a)) => &mut a.new_name,
                            _ => unreachable!("account closed while editing"),
                        })
                        .on_submit(|s: &mut H, _| s.account_add())
                        .build(k)
                        .grow(1.0)
                        .key("acc-new-name"),
                )
                .child(
                    Button::new("Add account")
                        .variant(ButtonVariant::Outline)
                        .disabled(a.busy || a.login.is_some() || a.new_name.text.trim().is_empty())
                        .on_press(|s: &mut H| s.account_add())
                        .build(k)
                        .key("acc-add"),
                ),
        );
    body = match a.server.as_ref() {
        Some(f) => body.child(server_form(k, f)),
        None => body.child(
            row().child(
                Button::new("Add a server (LM Studio…)")
                    .variant(ButtonVariant::Outline)
                    .on_press(|s: &mut H| s.server_form_open())
                    .build(k)
                    .key("acc-add-server"),
            ),
        ),
    };
    let scroll = col()
        .key("acc-scroll")
        .w_full()
        .max_h(560.0)
        .scroll(rune::ScrollSpec { stick_bottom: false })
        .child(body);
    modal(k, "account-modal", "Accounts", scroll)
}

fn plan_of(info: &serde_json::Value) -> Option<String> {
    let t = info["subscriptionType"].as_str().filter(|t| !t.is_empty())?;
    let mut c = t.chars();
    Some(c.next()?.to_uppercase().chain(c).collect())
}

fn account_card(
    k: &Kit,
    a: &crate::account::AccountWin,
    c: &crate::account::AccountCard,
    is_default: bool,
) -> El {
    use crate::app::Hooked as H;
    let info = c.info.clone().unwrap_or_default();
    let logged_in = info["loggedIn"] == true;
    let signed_out = info["loggedIn"] == false;
    let key = c.key.clone();
    let signing = a.login_key.as_deref() == Some(key.as_str()) && a.login.is_some();

    let mut title = row()
        .gap(6.0)
        .center_y()
        .child(text(c.label.clone()).font(k.ty.ui_medium).color(k.c.text_base));
    if is_default {
        title = title.child(
            text("Default")
                .font(k.ty.text_xsmall_medium)
                .color(k.c.text_accent)
                .help("New sessions start on this account"),
        );
    }
    if let Some(plan) = plan_of(&info) {
        title = title.child(text(plan).font(k.ty.text_xsmall_medium).color(k.c.text_faint));
    }
    let mut who = col().gap(2.0).child(title);
    if logged_in {
        let mut line = info["email"].as_str().unwrap_or("").to_string();
        if let Some(org) = info["organizationName"].as_str().filter(|o| !o.is_empty()) {
            line.push_str(&format!(" · {org}"));
        }
        who = who.child(text(line).font(k.ty.text_small).color(k.c.text_muted));
        if let Some(l) = c.usage.as_ref().and_then(crate::account::limits_of) {
            who = who.child(
                text(l)
                    .font(k.ty.text_small)
                    .color(k.c.text_muted)
                    .help("Rate limits of this account"),
            );
        }
    } else if signed_out {
        who = who.child(text("Not signed in").font(k.ty.text_small).color(k.c.warning.fg));
    }
    if c.key.is_empty() {
        who = who.child(
            text("Claude Code's own login on this machine")
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        );
    }

    let mut card = col()
        .key(format!("acc-{}", if key.is_empty() { "main" } else { &key }))
        .w_full()
        .gap(8.0)
        .padding(12.0)
        .radius(k.radius.lg)
        .fill(k.c.layer_01)
        .border(1.0, if is_default { k.c.border_base } else { k.c.border_weak })
        .child(who);

    // Actions: the same ones as the web account menu, as buttons.
    let btn = |label: &str, id: &str, variant: ButtonVariant, f: Box<dyn Fn(&mut H) + 'static>| {
        Button::new(label)
            .variant(variant)
            .disabled(a.busy)
            .on_press(move |s: &mut H| f(s))
            .build(k)
            .key(format!("acc-{id}-{}", if key.is_empty() { "main" } else { &key }))
    };
    let mut acts = row().gap(6.0).flex_wrap();
    if signed_out && !signing {
        let kk = key.clone();
        acts = acts.child(btn(
            "Sign in",
            "signin",
            ButtonVariant::Contrast,
            Box::new(move |s| s.account_login(&kk, "claudeai")),
        ));
    }
    if !is_default {
        let kk = key.clone();
        acts = acts.child(btn(
            "Use for new sessions",
            "default",
            ButtonVariant::Outline,
            Box::new(move |s| s.account_use_default(&kk)),
        ));
    }
    if logged_in && !signing {
        let kk = key.clone();
        acts = acts.child(btn(
            "Sign in again",
            "again",
            ButtonVariant::GhostMuted,
            Box::new(move |s| s.account_login(&kk, "claudeai")),
        ));
    }
    if !signing {
        let kk = key.clone();
        acts = acts.child(btn(
            "Console (API billing)",
            "console",
            ButtonVariant::GhostMuted,
            Box::new(move |s| s.account_login(&kk, "console")),
        ));
    }
    if logged_in {
        let kk = key.clone();
        acts = acts.child(btn(
            "Sign out…",
            "signout",
            ButtonVariant::GhostMuted,
            Box::new(move |s| {
                if let Some(Picker::Account(a)) = s.picker.as_mut() {
                    a.confirm = Some(("logout", kk.clone()));
                }
            }),
        ));
    }
    if !c.key.is_empty() {
        let kk = key.clone();
        acts = acts.child(btn(
            "Remove…",
            "remove",
            ButtonVariant::GhostMuted,
            Box::new(move |s| {
                if let Some(Picker::Account(a)) = s.picker.as_mut() {
                    a.confirm = Some(("remove", kk.clone()));
                }
            }),
        ));
    }
    card = card.child(acts);

    if let Some((_, e)) = a.card_error.as_ref().filter(|(ek, _)| *ek == key) {
        card = card.child(text(e.clone()).font(k.ty.text_small).color(k.c.danger.fg).wrap());
    }
    if let Some((kind, _)) = a.confirm.as_ref().filter(|(_, ck)| *ck == key) {
        let (msg, go): (String, Box<dyn Fn(&mut H)>) = if *kind == "logout" {
            let kk = key.clone();
            (
                if key.is_empty() {
                    "Sign out of the main account? Every Claude Code session on this machine that is not on another account loses its login.".into()
                } else {
                    format!("Sign out of “{}”?", c.label)
                },
                Box::new(move |s| s.account_logout(&kk)),
            )
        } else {
            let kk = key.clone();
            (
                format!("Remove “{}”? It is signed out and leaves this list. Its folder stays on disk.", c.label),
                Box::new(move |s| s.account_remove(&kk)),
            )
        };
        card = card.child(confirm_row(k, msg, if *kind == "logout" { "Sign out" } else { "Remove" }, go));
    }
    if signing {
        card = card.child(login_flow(k, a));
    }
    card
}

fn confirm_row(k: &Kit, msg: String, verb: &str, go: Box<dyn Fn(&mut Hooked) + 'static>) -> El {
    use crate::app::Hooked as H;
    col()
        .gap(6.0)
        .child(text(msg).font(k.ty.text_small).color(k.c.text_base).wrap())
        .child(
            row()
                .gap(8.0)
                .child(
                    Button::new(verb.to_string())
                        .variant(ButtonVariant::Danger)
                        .on_press(move |s: &mut H| go(s))
                        .build(k)
                        .key("acc-confirm"),
                )
                .child(
                    Button::new("Cancel")
                        .variant(ButtonVariant::GhostMuted)
                        .on_press(|s: &mut H| {
                            if let Some(Picker::Account(a)) = s.picker.as_mut() {
                                a.confirm = None;
                            }
                        })
                        .build(k)
                        .key("acc-confirm-cancel"),
                ),
        )
}

fn server_card(k: &Kit, a: &crate::account::AccountWin, p: &crate::profiles::Profile) -> El {
    use crate::app::Hooked as H;
    let id = p.id.clone();
    let n = p.models.len();
    let meta = match n {
        0 => "Models: asked of the server".to_string(),
        1 => "1 model".to_string(),
        n => format!("{n} models"),
    };
    let mut card = col()
        .key(format!("acc-srv-{id}"))
        .w_full()
        .gap(8.0)
        .padding(12.0)
        .radius(k.radius.lg)
        .fill(k.c.layer_01)
        .border(1.0, k.c.border_weak)
        .child(
            row()
                .gap(8.0)
                .center_y()
                .child(
                    col()
                        .grow(1.0)
                        .gap(2.0)
                        .child(text(p.name()).font(k.ty.ui_medium).color(k.c.text_base))
                        .child(text(meta).font(k.ty.text_small).color(k.c.text_muted)),
                )
                .child({
                    let (key, id) = (format!("acc-srv-remove-{id}"), id.clone());
                    Button::new("Remove…")
                        .variant(ButtonVariant::GhostMuted)
                        .disabled(a.busy)
                        .on_press(move |s: &mut H| {
                            if let Some(Picker::Account(a)) = s.picker.as_mut() {
                                a.confirm = Some(("remove", id.clone()));
                            }
                        })
                        .build(k)
                        .key(key)
                }),
        );
    if let Some((_, e)) = a.card_error.as_ref().filter(|(ek, _)| *ek == id) {
        card = card.child(text(e.clone()).font(k.ty.text_small).color(k.c.danger.fg).wrap());
    }
    if a.confirm.as_ref().is_some_and(|(_, ck)| *ck == id) {
        let kk = id.clone();
        card = card.child(confirm_row(
            k,
            format!("Remove “{}”? Sessions that ran on it can no longer be resumed there.", p.name()),
            "Remove",
            Box::new(move |s| s.account_remove(&kk)),
        ));
    }
    card
}

fn server_form(k: &Kit, f: &crate::account::ServerForm) -> El {
    use super::settings::{chip, chips};
    use crate::account::Probe;
    use crate::app::Hooked as H;
    let field = |edit: &rune::TextEdit, hint: &str, key: &'static str, secure: bool, pick: fn(&mut crate::account::ServerForm) -> &mut rune::TextEdit| {
        let mut t = TextInput::new(edit)
            .placeholder(hint)
            .width(None)
            .on_edit(move |s: &mut H| match s.picker.as_mut() {
                Some(Picker::Account(a)) => match a.server.as_mut() {
                    Some(f) => pick(f),
                    None => unreachable!("server form closed while editing"),
                },
                _ => unreachable!("account closed while editing"),
            });
        if secure {
            t = t.secure();
        }
        t.build(k).key(key)
    };
    let mut c = col()
        .key("acc-server-form")
        .w_full()
        .gap(8.0)
        .padding(12.0)
        .radius(k.radius.lg)
        .fill(k.c.layer_01)
        .border(1.0, k.c.border_base)
        .child(super::section_title(k, "NEW SERVER"))
        .child(field(&f.name, "Name (LM Studio)", "srv-name", false, |f| &mut f.name))
        .child(field(&f.url, "Address (http://127.0.0.1:1234)", "srv-url", false, |f| &mut f.url))
        .child(field(&f.token, "Token (optional)", "srv-token", true, |f| &mut f.token))
        .child(field(&f.ctx, "Context window the server loads models at (optional)", "srv-ctx", false, |f| &mut f.ctx))
        .child(
            row().child(
                Button::new("Test the address")
                    .variant(ButtonVariant::Outline)
                    .disabled(f.url.text.trim().is_empty() || matches!(f.probe, Some(Probe::Loading)))
                    .on_press(|s: &mut H| s.server_test())
                    .build(k)
                    .key("srv-test"),
            ),
        );
    match &f.probe {
        Some(Probe::Loading) => {
            c = c.child(text("Asking the server…").font(k.ty.text_small).color(k.c.text_faint));
        }
        Some(Probe::Done { models, error }) => {
            if let Some(e) = error {
                c = c.child(text(e.clone()).font(k.ty.text_small).color(k.c.danger.fg).wrap());
            }
            if !models.is_empty() {
                c = c
                    .child(
                        text("Models to offer:")
                            .font(k.ty.text_small)
                            .color(k.c.text_muted),
                    )
                    .child(chips(
                        models
                            .iter()
                            .map(|m| {
                                let id = m.id.clone();
                                chip(k, format!("srv-m-{id}"), m.label.clone(), f.kept.contains(&id), move |s| {
                                    if let Some(Picker::Account(a)) = s.picker.as_mut()
                                        && let Some(f) = a.server.as_mut()
                                        && !f.kept.remove(&id)
                                    {
                                        f.kept.insert(id.clone());
                                    }
                                })
                            })
                            .collect(),
                    ));
            }
        }
        None => {}
    }
    c.child(
        row()
            .gap(8.0)
            .justify_end()
            .child(
                Button::new("Cancel")
                    .variant(ButtonVariant::GhostMuted)
                    .on_press(|s: &mut H| {
                        if let Some(Picker::Account(a)) = s.picker.as_mut() {
                            a.server = None;
                        }
                    })
                    .build(k)
                    .key("srv-cancel"),
            )
            .child(
                Button::new("Add server")
                    .variant(ButtonVariant::Contrast)
                    .disabled(f.saving || f.name.text.trim().is_empty() || f.url.text.trim().is_empty())
                    .on_press(|s: &mut H| s.server_add())
                    .build(k)
                    .key("srv-add"),
            ),
    )
}

/// The sign-in in flight, inside the card it is on.
fn login_flow(k: &Kit, a: &crate::account::AccountWin) -> El {
    use crate::app::Hooked as H;
    let Some(l) = a.login.as_ref() else { return el() };
    let mut flow = col().w_full().gap(8.0);
    if l["starting"] == true {
        flow = flow.child(
            text("Starting the login flow…")
                .font(k.ty.text_small)
                .color(k.c.text_faint),
        );
    } else if l["done"] == true {
        flow = flow.child(
            text(if l["exitCode"] == 0 {
                "Signed in."
            } else {
                "The login flow ended before completing."
            })
            .font(k.ty.text_small)
            .color(k.c.text_muted),
        );
    } else if let Some(url) = l["url"].as_str().map(str::to_string) {
        let (open, copy) = (url.clone(), url.clone());
        flow = flow
            .child(
                text("Open this page to approve the sign-in:")
                    .font(k.ty.text_small)
                    .color(k.c.text_muted),
            )
            .child(
                text(url)
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_accent)
                    .wrap_anywhere()
                    .selectable(true),
            )
            .child(
                row()
                    .gap(8.0)
                    .child(
                        Button::new("Open")
                            .variant(ButtonVariant::Outline)
                            .on_press_tx(move |_: &mut H, tx| {
                                let _ = tx.open_url(&open);
                            })
                            .build(k),
                    )
                    .child(
                        Button::new("Copy")
                            .variant(ButtonVariant::GhostMuted)
                            .on_press_tx(move |_: &mut H, tx| tx.copy(&copy))
                            .build(k),
                    ),
            );
        if l["needsPaste"] == true {
            flow = flow.child(
                TextInput::new(&a.redirect)
                    .placeholder("Paste the code or redirect URL…")
                    .width(None)
                    .on_edit(|s: &mut H| match s.picker.as_mut() {
                        Some(Picker::Account(a)) => &mut a.redirect,
                        _ => unreachable!("account closed while editing"),
                    })
                    .on_submit(|s: &mut H, _| s.account_send_redirect())
                    .build(k)
                    .key("account-redirect"),
            );
        } else {
            flow = flow.child(
                text("Waiting for authorization…")
                    .font(k.ty.text_small)
                    .color(k.c.text_faint),
            );
        }
    } else {
        flow = flow.child(text("Starting…").font(k.ty.text_small).color(k.c.text_faint));
    }
    if l["done"] != true {
        flow = flow.child(
            Button::new("Cancel")
                .variant(ButtonVariant::GhostMuted)
                .on_press(|s: &mut H| s.account_cancel_login())
                .build(k),
        );
    }
    flow
}

/// Moves a session to another account or server: stops it and resumes it from its conversation.
fn move_modal(s: &Hooked, k: &Kit, w: &crate::profiles::MoveWin) -> El {
    use super::settings::{chip, chips};
    use crate::app::Hooked as H;
    let line = |label: &str, body: El| {
        col()
            .w_full()
            .gap(6.0)
            .child(super::section_title(k, label))
            .child(body)
    };
    let mut body = col().w_full().gap(12.0).child(
        text(format!(
            "Stops “{}” and resumes it from its conversation on another account or server. Its history, tags and group stay. {}",
            w.title,
            if w.working {
                "A turn is in progress and will be lost."
            } else {
                "A turn in progress would be lost."
            }
        ))
        .font(k.ty.text_small)
        .color(k.c.text_muted)
        .wrap(),
    );
    let choices = s.move_choices(w);
    if choices.is_empty() {
        body = body.child(
            text("There is nowhere else to move it yet. Add an account or a server from the account window.")
                .font(k.ty.text_small)
                .color(k.c.text_faint)
                .wrap(),
        );
    } else {
        body = body.child(line(
            "MOVE TO",
            chips(
                choices
                    .iter()
                    .map(|p| {
                        let id = p.id.clone();
                        let label = if p.compatible() {
                            format!("{} (server)", p.name())
                        } else {
                            p.name()
                        };
                        let on = w.target.as_deref() == Some(p.id.as_str());
                        chip(k, format!("mv-{id}"), label, on, move |s: &mut H| s.move_pick(&id))
                    })
                    .collect(),
            ),
        ));
    }
    let target = w.target.as_deref();
    let to_server = s.is_server(target);
    if s.move_needs_model(w) {
        let models = s.models_for(target);
        body = body
            .child(line(
                "MODEL",
                chips(
                    models
                        .into_iter()
                        .map(|(id, label)| {
                            let on = w.model.as_deref() == Some(id.as_str());
                            chip(k, format!("mvm-{id}"), label, on, move |s: &mut H| {
                                if let Some(Picker::Move(w)) = s.picker.as_mut() {
                                    w.model = Some(id.clone());
                                }
                            })
                        })
                        .collect(),
                ),
            ))
            .child(
                text(if to_server {
                    "The session's model only exists on its current side, so pick one of this server's."
                } else {
                    "The session ran on a server: pick the Claude model it continues with."
                })
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint)
                .wrap(),
            );
    }
    if target.is_some() && !to_server {
        body = body.child(line(
            "EFFORT",
            chips(
                s.caps
                    .efforts
                    .iter()
                    .map(|e| {
                        let e = e.clone();
                        let on = w.effort.as_deref() == Some(e.as_str());
                        chip(k, format!("mve-{e}"), e.clone(), on, move |s: &mut H| {
                            if let Some(Picker::Move(w)) = s.picker.as_mut() {
                                w.effort = Some(e.clone());
                            }
                        })
                    })
                    .collect(),
            ),
        ));
    }
    if to_server {
        body = body.child(
            text("It then runs through this server: no account limits and no prompt cache.")
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint)
                .wrap(),
        );
    }
    if let Some(e) = w.error.as_ref() {
        body = body.child(text(e.clone()).font(k.ty.text_small).color(k.c.danger.fg).wrap());
    }
    body = body.child(
        row()
            .w_full()
            .gap(8.0)
            .justify_end()
            .child(
                Button::new("Cancel")
                    .variant(ButtonVariant::GhostMuted)
                    .on_press(|s: &mut H| s.picker = None)
                    .build(k)
                    .key("mv-cancel"),
            )
            .child(
                Button::new(if w.busy { "Moving…" } else { "Move" })
                    .variant(ButtonVariant::Contrast)
                    .disabled(w.busy || w.target.is_none())
                    .on_press(|s: &mut H| s.move_go())
                    .build(k)
                    .key("mv-go"),
            ),
    );
    modal(k, "move-modal", "Move to another account", body)
}
