use rune::{Color, Cursor, El, col, el, row, text};
use rune_kit::{Kit, TextInput};

use super::{dot, glyph, section_title, small_icon_button, state_color, tag_font};
use crate::api::Session;
use crate::app::Hooked;
use crate::fleet::{
    FAMILIES, GROUP_CAP, KIDS_CAP, WHEEL, is_live, repo_key, segment_at, segments, wheel_svg,
};
use crate::organize::Unit;
use crate::{fmt, icons};

const CARD_MIN: f32 = 210.0;
const CARD_GAP: f32 = 8.0;

/// The web's `repeat(auto-fill, minmax(210px, 1fr))`: as many columns as fit, sharing the width.
fn card_width(width: f32) -> f32 {
    let cols = ((width + CARD_GAP) / (CARD_MIN + CARD_GAP))
        .floor()
        .max(1.0);
    ((width - CARD_GAP * (cols - 1.0)) / cols).floor()
}

fn unit_live(u: &Unit) -> bool {
    is_live(u.mother) || u.children.iter().any(|c| is_live(c))
}

fn unit_last(u: &Unit) -> String {
    std::iter::once(u.mother)
        .chain(u.children.iter().copied())
        .filter_map(|x| x.last_activity.clone())
        .max()
        .unwrap_or_default()
}

fn snippet(x: &Session) -> Option<(&'static str, String)> {
    if x.state == "working"
        && let Some(a) = x.activity.as_deref().filter(|a| !a.is_empty())
    {
        return Some(("working", format!("{a}…")));
    }
    if let Some(t) = x.todo.as_ref().filter(|t| t.total > 0)
        && let Some(cur) = t.current.as_deref()
    {
        return Some(("background", format!("{cur} ({}/{})", t.done, t.total)));
    }
    None
}

pub fn view(s: &Hooked, k: &Kit, decisions: usize, width: f32) -> El {
    let card_w = card_width(width);
    let mut live: Vec<&Session> = s
        .sessions
        .iter()
        .filter(|x| s.visible(x) && !s.is_archived(x))
        .collect();
    let wheel_list: Vec<(&Session, bool)> = live.iter().map(|x| (*x, s.snoozed(&x.id))).collect();
    let active = live
        .iter()
        .filter(|x| matches!(x.state.as_str(), "working" | "background"))
        .count();
    live.retain(|x| s.fleet_matches(x));
    live.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
    let mut groups: Vec<(String, Vec<Unit>)> = Vec::new();
    for u in s.units(&live) {
        let key = repo_key(u.mother);
        match groups.iter_mut().find(|g| g.0 == key) {
            Some(g) => g.1.push(u),
            None => groups.push((key, vec![u])),
        }
    }
    for g in &mut groups {
        g.1.sort_by(|a, b| {
            unit_live(b)
                .cmp(&unit_live(a))
                .then_with(|| unit_last(b).cmp(&unit_last(a)))
        });
    }
    groups.sort_by_cached_key(|g| {
        std::cmp::Reverse(g.1.iter().map(unit_last).max().unwrap_or_default())
    });
    let total: usize = groups.iter().map(|g| g.1.len()).sum();

    let mut archived: Vec<&Session> = s
        .sessions
        .iter()
        .filter(|x| s.visible(x) && s.is_archived(x) && s.fleet_matches(x))
        .collect();
    archived.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
    let archived: Vec<Unit> = s
        .units(&archived)
        .into_iter()
        .filter(|u| s.is_group_archived(&u.mother.id))
        .collect();

    let grid = s.fleet.grid;
    let head = row()
        .key("fleet-head")
        .w_full()
        .gap(10.0)
        .center_y()
        .child(section_title(k, "THE FLEET"))
        .child(
            text(format!(
                "{total} group{} · {active} active",
                if total == 1 { "" } else { "s" }
            ))
            .font(k.ty.text_xsmall)
            .color(k.c.text_faint),
        )
        .child(el().grow(1.0))
        .child(
            TextInput::new(&s.fleet.q)
                .placeholder("Filter…")
                .width(Some(200.0))
                .on_edit(|s: &mut Hooked| &mut s.fleet.q)
                .build(k)
                .key("fleet-q"),
        )
        .child(
            small_icon_button(&icons::LIST, "List", !grid)
                .on_press(|s: &mut Hooked| s.set_fleet_grid(false))
                .build(k),
        )
        .child(
            small_icon_button(&icons::DECK, "Grid", grid)
                .on_press(|s: &mut Hooked| s.set_fleet_grid(true))
                .build(k),
        );

    let mut c = col()
        .key("fleet")
        .w_full()
        .gap(14.0)
        .child(head)
        .child(wheel_card(s, k, &wheel_list, decisions));
    if groups.is_empty() {
        let filtered = !s.fleet.q.text.trim().is_empty() || s.fleet.state.is_some();
        let mut e = col().w_full().py(24.0).gap(6.0).center().child(
            text(if !filtered {
                "No sessions yet.".to_string()
            } else if s.fleet.q.text.trim().is_empty() {
                "No session in this state.".to_string()
            } else {
                format!("Nothing matches “{}”.", s.fleet.q.text.trim())
            })
            .font(k.ty.body)
            .color(k.c.text_muted),
        );
        if filtered {
            e = e.child(
                k.interactive(
                    row()
                        .role("button")
                        .px(6.0)
                        .radius(k.radius.sm)
                        .cursor(Cursor::Pointer)
                        .child(
                            text("Clear the filter")
                                .font(k.ty.text_small_medium)
                                .color(k.c.text_accent),
                        ),
                )
                .on_press(|s: &mut Hooked| s.clear_fleet_filter()),
            );
        }
        c = c.child(e);
    }
    for (repo, units) in &groups {
        let expanded = s.fleet.expanded.contains(repo);
        let cap = GROUP_CAP.max(units.iter().filter(|u| unit_live(u)).count());
        let shown = if expanded {
            units.len()
        } else {
            units.len().min(cap)
        };
        let project = units[0].mother.project.clone();
        let mut g = col()
            .key(format!("repo-{repo}"))
            .w_full()
            .gap(6.0)
            .child(
                row()
                    .w_full()
                    .gap(6.0)
                    .center_y()
                    .hover_group()
                    .child(text(repo.clone()).font(k.ty.ui_medium).color(k.c.text_base))
                    .child(
                        text(units.len().to_string())
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_faint),
                    )
                    .child(
                        small_icon_button(&icons::PLUS, "New session in this project", false)
                            .on_press(move |s: &mut Hooked| s.go_new(project.clone()))
                            .build(k)
                            .group_opacity(0.0, 1.0),
                    ),
            )
            .child(units_block(s, k, &units[..shown], grid, card_w));
        if shown < units.len() {
            let n = units.len() - shown;
            let key = repo.clone();
            g = g.child(
                k.interactive(
                    row()
                        .key(format!("more-{repo}"))
                        .role("button")
                        .w_full()
                        .h(30.0)
                        .center()
                        .gap(6.0)
                        .radius(k.radius.md)
                        .cursor(Cursor::Pointer)
                        .border(1.0, k.c.border_weak)
                        .child(glyph(&icons::PLUS, 12.0, k.c.icon_faint))
                        .child(
                            text(format!("{n} older group{}", if n > 1 { "s" } else { "" }))
                                .font(k.ty.text_xsmall_medium)
                                .color(k.c.text_muted),
                        ),
                )
                .on_press(move |s: &mut Hooked| {
                    s.fleet.expanded.insert(key.clone());
                }),
            );
        }
        c = c.child(g);
    }
    if !archived.is_empty() {
        let open = s.fleet.archived_open;
        let mut g = col().key("fleet-archived").w_full().gap(6.0).child(
            k.interactive(
                row()
                    .role("button")
                    .h(28.0)
                    .px(4.0)
                    .gap(6.0)
                    .center_y()
                    .radius(k.radius.sm)
                    .cursor(Cursor::Pointer)
                    .child(glyph(
                        if open {
                            &icons::CHEVRON_DOWN
                        } else {
                            &icons::ARROW_RIGHT
                        },
                        12.0,
                        k.c.icon_faint,
                    ))
                    .child(glyph(&icons::ARCHIVE, 13.0, k.c.icon_muted))
                    .child(text("Archived").font(k.ty.ui_medium).color(k.c.text_muted))
                    .child(
                        text(archived.len().to_string())
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_faint),
                    ),
            )
            .on_press(|s: &mut Hooked| s.fleet.archived_open = !s.fleet.archived_open),
        );
        if open {
            g = g.child(units_block(s, k, &archived, grid, card_w));
        }
        c = c.child(g);
    }
    c
}

fn wheel_card(s: &Hooked, k: &Kit, list: &[(&Session, bool)], decisions: usize) -> El {
    let segs = segments(list);
    let counts = crate::fleet::counts(&segs);
    let svg = wheel_svg(&segs, s.fleet.state, s.fleet.hover.as_deref(), k.dark);
    let img = s
        .images
        .as_ref()
        .map(|c| c.svg(svg.into_bytes(), WHEEL, 2.0));
    let ids: Vec<String> = segs.iter().map(|g| g.id.clone()).collect();
    let hovered = s
        .fleet
        .hover
        .as_deref()
        .and_then(|id| s.sessions.iter().find(|x| x.id == id));
    let centre = match hovered {
        Some(x) => col()
            .w(WHEEL * 0.46)
            .gap(2.0)
            .center()
            .child(
                text(s.title_of(x))
                    .font(k.ty.text_small_medium)
                    .color(k.c.text_base)
                    .truncate(),
            )
            .child(
                text(fmt::state_label(&x.state))
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_faint),
            ),
        None => col()
            .center()
            .child(
                text(decisions.to_string())
                    .font({
                        let mut f = k.ty.ui_medium;
                        f.size = 40.0;
                        f.weight = 750.0;
                        f.line_height = 42.0;
                        f
                    })
                    .color(k.c.text_base),
            )
            .child(
                text(if decisions == 1 {
                    "decision"
                } else {
                    "decisions"
                })
                .font(k.ty.text_xsmall_medium)
                .color(k.c.text_faint),
            ),
    };
    let segs_hit = std::rc::Rc::new(segs);
    let hit = segs_hit.clone();
    let mut dial = el()
        .key("wheel")
        .size(WHEEL, WHEEL)
        .cursor(if s.fleet.hover.is_some() {
            Cursor::Pointer
        } else {
            Cursor::Default
        })
        .on_pointer_move_local(move |s: &mut Hooked, p, _| {
            let id = segment_at(&hit, p.x, p.y, WHEEL).map(|i| hit[i].id.clone());
            if s.fleet.hover != id {
                s.fleet.hover = id;
            }
        })
        .on_hover_change(|s: &mut Hooked, on, _| {
            if !on {
                s.fleet.hover = None;
            }
        })
        .on_press(move |s: &mut Hooked| {
            if let Some(id) = s.fleet.hover.clone().filter(|id| ids.contains(id)) {
                s.open_session(&id);
            }
        })
        .child(
            row()
                .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .center()
                .child(centre),
        );
    if let Some(img) = img {
        dial = dial.pixels(img.pixels());
    }
    let mut legend = col().grow(1.0).min_w(0.0).max_w(520.0).gap(2.0);
    for pair in FAMILIES.iter().enumerate().collect::<Vec<_>>().chunks(2) {
        let mut r = row().w_full().gap(10.0);
        for (i, (key, label, _)) in pair.iter().copied() {
            let on = s.fleet.state == Some(i);
            let n = counts[i];
            r = r.child(
                k.interactive(
                    row()
                        .key(format!("fam-{key}"))
                        .role("checkbox")
                        .checked(on)
                        .w_frac(0.5)
                        .h(32.0)
                        .px(8.0)
                        .gap(8.0)
                        .center_y()
                        .radius(k.radius.md)
                        .cursor(Cursor::Pointer)
                        .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
                        .border(
                            1.0,
                            if on {
                                k.c.border_strong
                            } else {
                                Color::TRANSPARENT
                            },
                        )
                        .child(dot(k, key, 9.0))
                        .child(
                            text(label.to_string())
                                .font(k.ty.ui)
                                .color(if n == 0 {
                                    k.c.text_faint
                                } else {
                                    k.c.text_base
                                })
                                .truncate()
                                .grow(1.0)
                                .min_w(0.0),
                        )
                        .child(
                            text(n.to_string())
                                .font(if n == 0 { k.ty.ui } else { k.ty.ui_medium })
                                .color(if n == 0 {
                                    k.c.text_faint
                                } else {
                                    k.c.text_base
                                }),
                        ),
                )
                .help(format!("Show only “{label}”"))
                .on_press(move |s: &mut Hooked| s.toggle_fleet_state(i)),
            );
        }
        legend = legend.child(r);
    }
    row()
        .key("wheel-card")
        .w_full()
        .padding(16.0)
        .gap(22.0)
        .center_y()
        .radius(k.radius.lg)
        .fill(k.c.layer_01)
        .border(1.0, k.c.border_weak)
        .child(dial)
        .child(legend)
}

fn units_block(s: &Hooked, k: &Kit, units: &[Unit], grid: bool, card_w: f32) -> El {
    if grid {
        return row()
            .w_full()
            .gap(8.0)
            .flex_wrap()
            .items_start()
            .children(units.iter().map(|u| card(s, k, u, card_w)));
    }
    let head = row()
        .w_full()
        .h(20.0)
        .gap(10.0)
        .center_y()
        .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_strong)
        .child(el().w(3.0))
        .child(caption(k, "SESSION").grow(2.0).min_w(0.0).w(0.0))
        .child(caption(k, "BRANCH").grow(1.0).min_w(0.0).w(0.0))
        .child(caption(k, "STATUS").w(130.0))
        .child(row().w(56.0).child(el().grow(1.0)).child(caption(k, "AGE")))
        .child(el().w(24.0));
    col()
        .w_full()
        .child(head)
        .children(units.iter().enumerate().map(|(i, u)| table_row(s, k, u, i)))
}

fn caption(k: &Kit, label: &str) -> El {
    let mut f = k.ty.mono;
    f.size = 10.5;
    f.weight = 700.0;
    text(label.to_string()).font(f).color(k.c.text_faint)
}

fn table_row(s: &Hooked, k: &Kit, u: &Unit, i: usize) -> El {
    let x = u.mother;
    let id = x.id.clone();
    let dim = !unit_live(u);
    let title = if u.children.is_empty() {
        s.title_of(x)
    } else {
        s.group_label(x)
    };
    let mut f = k.ty.mono;
    f.size = 11.0;
    let mut line = row()
        .w_full()
        .min_h(24.0)
        .gap(10.0)
        .center_y()
        .child(el().w(3.0).h(24.0).fill(state_color(k, &x.state)))
        .child(
            text(title)
                .font(k.ty.text_small_medium)
                .color(if dim { k.c.text_muted } else { k.c.text_base })
                .truncate()
                .grow(2.0)
                .min_w(0.0)
                .w(0.0),
        )
        .child(
            text(x.git_branch.clone().unwrap_or_default())
                .font(f)
                .color(k.c.text_faint)
                .truncate()
                .grow(1.0)
                .min_w(0.0)
                .w(0.0),
        )
        .child(
            text(fmt::state_label(&x.state))
                .font(f)
                .color(k.c.text_faint)
                .truncate()
                .w(130.0),
        )
        .child(
            row().w(56.0).child(el().grow(1.0)).child(
                text(fmt::ago_short(x.last_activity.as_deref(), s.now))
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_faint),
            ),
        );
    line = line.child(archive_action(s, k, x).w(24.0));
    let mut c = col()
        .key(format!("frow-{}", x.id))
        .w_full()
        .hover_group()
        .fill(if i % 2 == 1 {
            k.c.layer_01
        } else {
            Color::TRANSPARENT
        })
        .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_weak)
        .child(line);
    if !u.children.is_empty() {
        c = c.child(col().w_full().pl(13.0).pb(4.0).child(kids(s, k, u)));
    }
    k.interactive(c.role("button").cursor(Cursor::Pointer))
        .on_press(move |s: &mut Hooked| s.open_session(&id))
}

fn archive_action(s: &Hooked, k: &Kit, x: &Session) -> El {
    let explicit = s.meta.get(&x.id).is_some_and(|m| m.archived);
    let ended = matches!(x.state.as_str(), "ended" | "past");
    if !explicit && ended {
        return el();
    }
    let id = x.id.clone();
    small_icon_button(
        if explicit {
            &icons::UNARCHIVE
        } else {
            &icons::ARCHIVE
        },
        if explicit { "Unarchive" } else { "Archive" },
        false,
    )
    .on_press(move |s: &mut Hooked| s.toggle_archive(&id))
    .build(k)
    .focusable(false)
    .group_opacity(0.0, 1.0)
}

fn kids(s: &Hooked, k: &Kit, u: &Unit) -> El {
    let mut list: Vec<&Session> = u.children.iter().copied().filter(|c| is_live(c)).collect();
    list.extend(u.children.iter().copied().filter(|c| !is_live(c)));
    let open = s.fleet.kids.contains(&u.mother.id);
    let (shown, hidden) = if open || list.len() <= KIDS_CAP + 1 {
        (&list[..], &list[..0])
    } else {
        list.split_at(KIDS_CAP)
    };
    let mut c = col()
        .w_full()
        .pl(8.0)
        .border_sides([0.0, 0.0, 0.0, 1.0], k.c.border_weak);
    for x in shown {
        let id = x.id.clone();
        let mut r = row()
            .key(format!("kid-{}", x.id))
            .role("button")
            .w_full()
            .h(22.0)
            .px(4.0)
            .gap(6.0)
            .center_y()
            .radius(k.radius.sm)
            .cursor(Cursor::Pointer)
            .child(dot(k, &x.state, 6.0))
            .child(
                text(s.title_of(x))
                    .font(k.ty.text_xsmall_medium)
                    .color(k.c.text_base)
                    .truncate()
                    .shrink()
                    .min_w(0.0),
            );
        if let Some((_, t)) = snippet(x) {
            r = r.child(
                text(t)
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_faint)
                    .truncate()
                    .grow(1.0)
                    .min_w(0.0),
            );
        } else {
            r = r.child(el().grow(1.0));
        }
        r = r.child(
            text(fmt::ago_short(x.last_activity.as_deref(), s.now))
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        );
        c = c.child(
            k.interactive(r)
                .on_press(move |s: &mut Hooked| s.open_session(&id)),
        );
    }
    if !hidden.is_empty() {
        let mother = u.mother.id.clone();
        let mut r = row()
            .key(format!("kids-more-{mother}"))
            .role("button")
            .h(22.0)
            .px(4.0)
            .gap(4.0)
            .center_y()
            .radius(k.radius.sm)
            .cursor(Cursor::Pointer)
            .help(format!(
                "Show the {} other sessions of this group",
                hidden.len()
            ))
            .child(
                text(format!("+{}", hidden.len()))
                    .font(k.ty.text_xsmall_medium)
                    .color(k.c.text_muted),
            );
        for x in hidden {
            r = r.child(dot(k, &x.state, 6.0));
        }
        c = c.child(k.interactive(r).on_press(move |s: &mut Hooked| {
            s.fleet.kids.insert(mother.clone());
        }));
    }
    c
}

fn card(s: &Hooked, k: &Kit, u: &Unit, w: f32) -> El {
    let x = u.mother;
    let id = x.id.clone();
    let dim = !unit_live(u);
    let grouped = !u.children.is_empty();
    let mut head = row()
        .w_full()
        .gap(7.0)
        .center_y()
        .child(dot(k, &x.state, 8.0))
        .child(
            text(if grouped {
                s.group_label(x)
            } else {
                s.title_of(x)
            })
            .font(k.ty.ui_medium)
            .color(k.c.text_base)
            .truncate()
            .grow(1.0)
            .min_w(0.0),
        );
    if grouped {
        head = head.child(glyph(&icons::LIST, 11.0, k.c.icon_faint)).child(
            text((u.children.len() + 1).to_string())
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        );
    }
    head = head.child(
        text(fmt::ago_short(x.last_activity.as_deref(), s.now))
            .font(k.ty.text_xsmall)
            .color(k.c.text_faint),
    );
    let mut c = col()
        .key(format!("fcard-{}", x.id))
        .role("button")
        .label(s.title_of(x))
        .w(w)
        .padding(12.0)
        .gap(6.0)
        .radius(k.radius.lg)
        .fill(k.c.layer_01)
        .border(1.0, k.c.border_weak)
        .cursor(Cursor::Pointer)
        .hover_group()
        .opacity(if dim { 0.75 } else { 1.0 })
        .child(head);
    if let Some((state, t)) = snippet(x) {
        c = c.child(
            row()
                .w_full()
                .gap(6.0)
                .center_y()
                .child(dot(k, state, 6.0))
                .child(
                    text(t)
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_muted)
                        .truncate()
                        .grow(1.0)
                        .min_w(0.0),
                ),
        );
    }
    for (who, msg) in [
        ("me", x.last_prompt.as_deref()),
        ("ai", x.last_reply.as_deref()),
    ] {
        let Some(m) = msg.filter(|m| !m.trim().is_empty()) else {
            continue;
        };
        let me = who == "me";
        c = c.child(
            row()
                .w_full()
                .px(8.0)
                .py(4.0)
                .radius(k.radius.md)
                .fill(if me { k.c.layer_02 } else { Color::TRANSPARENT })
                .border(
                    1.0,
                    if me {
                        Color::TRANSPARENT
                    } else {
                        k.c.border_weak
                    },
                )
                .child(
                    text(fmt::plain(m, 140))
                        .font(k.ty.text_xsmall)
                        .color(if me { k.c.text_base } else { k.c.text_muted })
                        .wrap()
                        .max_lines(2)
                        .grow(1.0)
                        .min_w(0.0),
                ),
        );
    }
    if grouped {
        c = c.child(kids(s, k, u));
    }
    let tags = s.session_tags(&x.id);
    if !tags.is_empty() {
        c = c.child(
            row()
                .w_full()
                .gap(4.0)
                .flex_wrap()
                .children(tags.iter().map(|t| {
                    let col = s.tag_color(k.dark, t);
                    row()
                        .h(17.0)
                        .px(6.0)
                        .center_y()
                        .radius(k.radius.sm)
                        .fill(col.alpha(0.13))
                        .child(text(format!("# {t}")).font(tag_font(k)).color(col))
                })),
        );
    }
    c = c.child(archive_action(s, k, x).pin(None, Some(6.0), Some(6.0), None));
    k.interactive(c)
        .on_press(move |s: &mut Hooked| s.open_session(&id))
}
