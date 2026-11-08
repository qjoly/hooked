mod deck;
mod dock;
mod lenses;
mod new_session;
mod pages;
mod palette;
mod session;
mod split;
mod terminal;

use std::collections::BTreeMap;

use rune::{Color, Cursor, Cx, El, Icon, Phase, col, el, icon, row, text};
use rune_kit::shell::{RowStatus, Sidebar, SidebarRow, SidebarSection};
use rune_kit::{Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant, Kit};

use crate::api::Session;
use crate::app::{Hooked, Page, Theme};
use crate::{fmt, icons};

pub const SIDEBAR_W: f32 = 300.0;

pub fn kit(s: &Hooked, cx: &Cx<Hooked>) -> Kit {
    Kit::neutral(s.dark(cx.system_dark()))
}

pub fn state_color(k: &Kit, state: &str) -> Color {
    match state {
        "working" => k.c.info.icon,
        "waiting" => k.c.warning.icon,
        "attention" => k.c.danger.icon,
        "background" => k.c.success.icon,
        _ => k.c.icon_faint,
    }
}

pub fn dot(k: &Kit, state: &str, size: f32) -> El {
    el().size(size, size)
        .radius(size / 2.0)
        .fill(state_color(k, state))
}

pub fn glyph(i: &'static Icon, size: f32, c: Color) -> El {
    icon(i, size).color(c)
}

pub fn small_icon_button(i: &'static Icon, help: &str, on: bool) -> IconButton {
    IconButton::new(i)
        .variant(if on {
            IconButtonVariant::Neutral
        } else {
            IconButtonVariant::GhostMuted
        })
        .control_size(ControlSize::Small)
        .label(help.to_string())
        .help(help.to_string())
        .expanded(on)
}

pub fn view(s: &Hooked, cx: &mut Cx<Hooked>) -> El {
    let k = kit(s, cx);
    let mut layer = Vec::new();
    let main = match s.page {
        Page::Deck => deck::view(s, &k),
        Page::Session => session::view(s, &k, &mut layer),
        Page::New => new_session::view(s, &k, &mut layer),
        Page::Stats => pages::stats(s, &k),
        Page::Digest => pages::digest(s, &k),
        Page::Memory => pages::memory(s, &k),
        Page::Cron => pages::cron(s, &k),
        Page::GitHub => pages::github(s, &k),
        Page::Settings => pages::settings(s, &k, &mut layer),
    };
    let mut body = row().key("body").w_full().grow(1.0).min_h(0.0);
    body = if s.sidebar_open {
        body.child(sidebar(s, &k))
    } else {
        body.child(rail(s, &k))
    };
    body = body.child(
        col()
            .key("main")
            .grow(1.0)
            .h_full()
            .min_w(0.0)
            .fill(k.c.bg_base)
            .child(main),
    );
    if s.page == Page::Session {
        if let Some(p) = s.split.as_ref() {
            body = body.child(split::view(s, p, &k));
        } else if let Some(d) = s.detail.as_ref() {
            body = body.child(dock::view(s, d, &k));
        }
    }
    let base = col()
        .key("window")
        .on_paste_content(|s: &mut Hooked, c: &rune::ClipboardContent, _| {
            if let Some(img) = c.image() {
                let n = s.attach_seq + 1;
                s.attach(format!("pasted-{n}.png"), "image/png", img.png().to_vec());
            }
        })
        .on_drop_files(|s: &mut Hooked, files: &[std::path::PathBuf], _| s.attach_files(files))
        .w_full()
        .h_full()
        .fill(k.c.bg_deep)
        .child(topbar(s, &k, cx.titlebar_inset(), &mut layer))
        .child(body);
    if s.palette_open {
        layer.push(palette::view(s, &k));
    }
    rune_kit::root(base, layer)
}

fn flash(k: &Kit, msg: &str, error: bool) -> El {
    let c = if error { &k.c.danger } else { &k.c.success };
    row()
        .key("flash")
        .h(26.0)
        .px(10.0)
        .center_y()
        .radius(k.radius.md)
        .fill(c.bg)
        .border(1.0, c.border)
        .max_w(420.0)
        .child(
            text(msg.to_string())
                .font(k.ty.text_small_medium)
                .color(c.fg)
                .truncate(),
        )
}

pub trait Shadows {
    fn box_shadows(self, all: &[rune::Shadow]) -> Self;
}

impl Shadows for El {
    fn box_shadows(self, all: &[rune::Shadow]) -> El {
        all.iter().fold(self, |e, sh| e.box_shadow(*sh))
    }
}

fn topbar(s: &Hooked, k: &Kit, inset: f32, _layer: &mut Vec<El>) -> El {
    let decisions = s.waiting().len();
    let space = |key: &'static str,
                 label: &'static str,
                 i: &'static Icon,
                 on: bool,
                 badge: Option<usize>| {
        let mut r = row()
            .key(key)
            .role("tab")
            .label(label)
            .checked(on)
            .h(28.0)
            .px(10.0)
            .gap(6.0)
            .center_y()
            .radius(k.radius.md)
            .cursor(Cursor::Pointer)
            .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
            .child(glyph(
                i,
                14.0,
                if on { k.c.icon_base } else { k.c.icon_muted },
            ))
            .child(text(label).font(k.ty.ui_medium).color(if on {
                k.c.text_base
            } else {
                k.c.text_muted
            }));
        if let Some(n) = badge.filter(|n| *n > 0) {
            r = r.child(
                row()
                    .h(16.0)
                    .min_w(16.0)
                    .px(5.0)
                    .center()
                    .radius(8.0)
                    .fill(k.c.warning.icon)
                    .child(
                        text(n.to_string())
                            .font(k.ty.text_xsmall_medium)
                            .color(k.c.white),
                    ),
            );
        }
        k.interactive(r)
    };
    let deck = space(
        "tb-deck",
        "Deck",
        &icons::DECK,
        s.page == Page::Deck,
        Some(decisions),
    )
    .on_press(|s: &mut Hooked| s.go_deck());
    let sessions = space(
        "tb-sessions",
        "Sessions",
        &icons::LIST,
        s.page == Page::Session,
        None,
    )
    .on_press(|s: &mut Hooked| {
        if let Some(id) = s
            .selected
            .clone()
            .or_else(|| s.sessions.first().map(|x| x.id.clone()))
        {
            s.open_session(&id);
        }
    });
    let omni = k
        .interactive(
            row()
                .key("tb-omni")
                .role("button")
                .label("Search, launch, command")
                .h(30.0)
                .grow(1.0)
                .shrink()
                .max_w(380.0)
                .px(10.0)
                .gap(8.0)
                .center_y()
                .radius(k.radius.md)
                .fill(k.c.layer_01)
                .border(1.0, k.c.border_weak)
                .cursor(Cursor::Pointer)
                .child(glyph(&icons::SEARCH, 14.0, k.c.icon_muted))
                .child(
                    text("Search, launch, command…")
                        .font(k.ty.ui)
                        .color(k.c.text_faint)
                        .truncate()
                        .grow(1.0)
                        .shrink(),
                )
                .child(
                    text("⌘K")
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.text_faint),
                ),
        )
        .on_press(|s: &mut Hooked| {
            s.palette_open = true;
            s.palette_query = rune::TextEdit::new("");
            s.palette_query.focused = true;
            s.palette_index = 0;
        });
    let gauges = row()
        .key("tb-gauges")
        .gap(10.0)
        .center_y()
        .help("Account rate limits")
        .children(s.gauges.iter().map(|g| gauge(k, &g.label, g.pct)));
    let theme_icon = match s.theme {
        Theme::Light => &icons::SUN,
        Theme::Dark => &icons::MOON,
        Theme::System => &icons::MONITOR,
    };
    let theme_label = match s.theme {
        Theme::Light => "Theme: light",
        Theme::Dark => "Theme: dark",
        Theme::System => "Theme: system",
    };
    let actions = row()
        .key("tb-actions")
        .gap(2.0)
        .center_y()
        .child(
            IconButton::new(if s.notify {
                &icons::BELL
            } else {
                &icons::BELL_OFF
            })
            .variant(IconButtonVariant::GhostMuted)
            .label(if s.notify {
                "Notifications: on"
            } else {
                "Notifications: off"
            })
            .help(if s.notify {
                "Notifications: on"
            } else {
                "Notifications: off"
            })
            .on_press(|s: &mut Hooked| {
                s.notify = !s.notify;
                let n = s.notify;
                s.save_pref("notify", &n);
            })
            .build(k)
            .key("tb-notify"),
        )
        .child(
            IconButton::new(theme_icon)
                .variant(IconButtonVariant::GhostMuted)
                .label(theme_label)
                .help(theme_label)
                .on_press(|s: &mut Hooked| s.cycle_theme())
                .build(k)
                .key("tb-theme"),
        )
        .child(
            IconButton::new(&icons::GEAR)
                .variant(if s.page == Page::Settings {
                    IconButtonVariant::Neutral
                } else {
                    IconButtonVariant::GhostMuted
                })
                .label("Settings")
                .help("Settings (⌘,)")
                .on_press(|s: &mut Hooked| s.go(Page::Settings))
                .build(k)
                .key("tb-settings"),
        );
    let new = Button::new("Session")
        .icon(&icons::PLUS)
        .variant(ButtonVariant::Contrast)
        .control_size(ControlSize::Regular)
        .shortcut("⌘N")
        .on_press(|s: &mut Hooked| s.go_new(None))
        .build(k)
        .key("tb-new");
    let live = el()
        .key("tb-live")
        .size(8.0, 8.0)
        .radius(4.0)
        .fill(if s.connected {
            k.c.success.icon
        } else {
            k.c.danger.icon
        })
        .help(if s.connected {
            "Connected to hooked"
        } else {
            "hooked is unreachable on localhost:4123"
        });
    row()
        .key("topbar")
        .w_full()
        .h(52.0)
        .pl(inset.max(12.0) + 4.0)
        .pr(12.0)
        .gap(12.0)
        .center_y()
        .window_drag()
        .fill(k.c.bg_deep)
        .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_weak)
        .child(
            row()
                .key("tb-logo")
                .gap(6.0)
                .center_y()
                .help("hooked")
                .child(glyph(&icons::CIRCLE_DOT, 16.0, k.c.text_base)),
        )
        .child(
            row()
                .key("tb-spaces")
                .gap(2.0)
                .center_y()
                .child(deck)
                .child(sessions)
                .child(
                    space(
                        "tb-stats",
                        "Stats",
                        &icons::CHART,
                        s.page == Page::Stats,
                        None,
                    )
                    .on_press(|s: &mut Hooked| s.go(Page::Stats)),
                )
                .child(
                    space(
                        "tb-digest",
                        "Digest",
                        &icons::BOOK,
                        s.page == Page::Digest,
                        None,
                    )
                    .on_press(|s: &mut Hooked| s.go(Page::Digest)),
                )
                .child(
                    space(
                        "tb-memory",
                        "Memory",
                        &icons::BRAIN,
                        s.page == Page::Memory,
                        None,
                    )
                    .on_press(|s: &mut Hooked| s.go(Page::Memory)),
                )
                .child(
                    space("tb-cron", "Cron", &icons::TIMER, s.page == Page::Cron, None)
                        .on_press(|s: &mut Hooked| s.go(Page::Cron)),
                )
                .child(
                    space(
                        "tb-github",
                        "GitHub",
                        &icons::GITHUB,
                        s.page == Page::GitHub,
                        None,
                    )
                    .on_press(|s: &mut Hooked| s.go(Page::GitHub)),
                ),
        )
        .child(
            row()
                .key("tb-center")
                .grow(1.0)
                .shrink()
                .justify_center()
                .child(omni),
        )
        .child(
            s.flash
                .as_ref()
                .map_or_else(el, |f| flash(k, &f.text, f.error)),
        )
        .child(gauges)
        .child(actions)
        .child(new)
        .child(live)
}

fn gauge(k: &Kit, label: &str, pct: Option<f64>) -> El {
    let p = pct.unwrap_or(0.0).clamp(0.0, 100.0) as f32;
    let fill = if p >= 90.0 {
        k.c.danger.icon
    } else if p >= 75.0 {
        k.c.warning.icon
    } else {
        k.c.icon_muted
    };
    col()
        .w(64.0)
        .gap(3.0)
        .child(
            row()
                .w_full()
                .gap(4.0)
                .justify_between()
                .child(
                    text(label.to_string())
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.text_faint),
                )
                .child(
                    text(pct.map_or("—".into(), |p| format!("{p:.0}%")))
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.text_muted),
                ),
        )
        .child(
            el().w_full()
                .h(3.0)
                .radius(1.5)
                .fill(k.c.layer_03)
                .child(el().w(64.0 * p / 100.0).h(3.0).radius(1.5).fill(fill)),
        )
}

fn status(k: &Kit, s: &Session) -> Option<RowStatus> {
    match s.state.as_str() {
        "working" => Some(RowStatus::Busy),
        "attention" | "waiting" => Some(RowStatus::Attention),
        _ if s.has_question || s.has_plan => Some(RowStatus::Attention),
        "background" => Some(RowStatus::Other(dot(k, "background", 7.0))),
        _ => Some(RowStatus::Other(dot(k, &s.state, 6.0))),
    }
}

fn session_row(s: &Hooked, x: &Session, k: &Kit) -> El {
    let id = x.id.clone();
    let mut detail = fmt::ago_short(x.last_activity.as_deref(), s.now);
    if let Some(left) = x
        .cache
        .as_ref()
        .and_then(|c| fmt::cache_left(c.last_request_at.as_deref(), c.ttl.as_deref(), s.now))
    {
        detail = format!("⚡{}", fmt::span(left, ""));
    }
    let archived = s.meta.get(&x.id).is_some_and(|m| m.archived);
    let mut r = SidebarRow::new(x.display_title())
        .height(44.0)
        .subtitle(match &x.git_branch {
            Some(b) if !b.is_empty() => format!("{} · {b}", x.project_label()),
            _ => x.project_label(),
        })
        .detail(detail)
        .selected(s.page == Page::Session && s.selected.as_deref() == Some(x.id.as_str()))
        .on_select({
            let id = id.clone();
            move |s: &mut Hooked, _| s.open_session(&id)
        })
        .on_close({
            let id = id.clone();
            move |s: &mut Hooked, _| s.toggle_archive(&id)
        });
    if !archived && let Some(st) = status(k, x) {
        r = r.status(st);
    }
    r.build(k).key(format!("row-{}", x.id)).help(if archived {
        "Click × to unarchive"
    } else {
        "Hover the dot: × archives"
    })
}

fn sidebar(s: &Hooked, k: &Kit) -> El {
    let (active, archived): (Vec<&Session>, Vec<&Session>) =
        s.sessions.iter().partition(|x| !s.is_archived(x));
    let mut shown = if s.show_archived {
        archived.clone()
    } else {
        active.clone()
    };
    if s.hide_old && !s.show_archived {
        shown.retain(|x| {
            x.needs_you()
                || x.state == "working"
                || fmt::age_ms(x.last_activity.as_deref(), s.now).is_none_or(|a| a < 86_400_000)
        });
    }
    let tab = |key: &'static str, label: &'static str, n: usize, on: bool| {
        k.interactive(
            row()
                .key(key)
                .role("tab")
                .checked(on)
                .h(26.0)
                .px(8.0)
                .gap(6.0)
                .center_y()
                .radius(k.radius.sm)
                .cursor(Cursor::Pointer)
                .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
                .child(text(label).font(k.ty.ui_medium).color(if on {
                    k.c.text_base
                } else {
                    k.c.text_muted
                }))
                .child(
                    text(n.to_string())
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                ),
        )
    };
    let head = row()
        .key("ssb-head")
        .w_full()
        .gap(2.0)
        .center_y()
        .child(
            tab("ssb-active", "Sessions", active.len(), !s.show_archived)
                .on_press(|s: &mut Hooked| s.show_archived = false),
        )
        .child(
            tab("ssb-archived", "Archived", archived.len(), s.show_archived)
                .on_press(|s: &mut Hooked| s.show_archived = true),
        )
        .child(el().grow(1.0))
        .child(
            small_icon_button(&icons::CLOCK, "Show only the last 24h", s.hide_old)
                .on_press(|s: &mut Hooked| {
                    s.hide_old = !s.hide_old;
                    let v = s.hide_old;
                    s.save_pref("hideOld", &v);
                })
                .build(k)
                .key("ssb-old"),
        )
        .child(
            small_icon_button(
                if s.group_by_project {
                    &icons::FOLDER
                } else {
                    &icons::LIST
                },
                "Group by project on/off",
                false,
            )
            .on_press(|s: &mut Hooked| {
                s.group_by_project = !s.group_by_project;
                let v = s.group_by_project;
                s.save_pref("groupByProject", &v);
            })
            .build(k)
            .key("ssb-group"),
        )
        .child(
            small_icon_button(&icons::ARROW_LEFT, "Collapse sidebar (⌘B)", false)
                .on_press(|s: &mut Hooked| {
                    s.sidebar_open = false;
                    s.save_pref("sidebarOpen", &false);
                })
                .build(k)
                .key("ssb-collapse"),
        );
    let mut sb = Sidebar::new()
        .label("Sessions")
        .inset(8.0)
        .header_padding(10.0, 6.0)
        .row_gap(2.0)
        .header(head);
    if shown.is_empty() {
        sb = sb.child(
            text(if s.show_archived {
                "No archived sessions."
            } else {
                "No sessions."
            })
            .font(k.ty.ui)
            .color(k.c.text_faint)
            .key("ssb-empty"),
        );
    } else if s.group_by_project {
        let mut groups: BTreeMap<String, Vec<&Session>> = BTreeMap::new();
        let mut order = Vec::new();
        for x in &shown {
            let g = x.project_label();
            if !groups.contains_key(&g) {
                order.push(g.clone());
            }
            groups.entry(g).or_default().push(x);
        }
        for g in order {
            let rows = &groups[&g];
            let collapsed = s.collapsed.contains(&g);
            let project = rows[0].project.clone();
            let toggle = g.clone();
            let plus = IconButton::new(&icons::PLUS)
                .variant(IconButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .label(format!("New session in {g}"))
                .help("New session in this project")
                .on_press(move |s: &mut Hooked| s.go_new(project.clone()))
                .build(k)
                .key(format!("plus-{g}"));
            sb = sb.section(
                SidebarSection::new(g.clone())
                    .key(format!("grp-{g}"))
                    .count(rows.len())
                    .collapsed(collapsed)
                    .action(plus)
                    .on_toggle(move |s: &mut Hooked, _| {
                        if !s.collapsed.remove(&toggle) {
                            s.collapsed.insert(toggle.clone());
                        }
                    })
                    .rows(rows.iter().map(|x| session_row(s, x, k))),
            );
        }
    } else {
        for x in &shown {
            sb = sb.child(session_row(s, x, k));
        }
    }
    let handle = el()
        .key("ssb-resize")
        .w(6.0)
        .h_full()
        .cursor(Cursor::ResizeColumn)
        .on_drag(|s: &mut Hooked, d: &mut rune::Drag, _| {
            if d.phase == Phase::Down {
                d.data = s.sidebar_w;
            }
            s.sidebar_w = (d.data + d.dx).clamp(220.0, 560.0);
            if d.phase == Phase::Up {
                let w = s.sidebar_w;
                s.save_pref("sidebarW", &w);
            }
        });
    row()
        .key("sidebar-wrap")
        .w(s.sidebar_w)
        .h_full()
        .fill(k.c.bg_deep)
        .border_sides([0.0, 1.0, 0.0, 0.0], k.c.border_weak)
        .child(
            col()
                .key("sidebar-col")
                .grow(1.0)
                .h_full()
                .min_w(0.0)
                .child(sb.build(k)),
        )
        .child(handle)
}

fn rail(s: &Hooked, k: &Kit) -> El {
    let tiles = s
        .sessions
        .iter()
        .filter(|x| !s.is_archived(x))
        .take(30)
        .map(|x| {
            let id = x.id.clone();
            let cur = s.selected.as_deref() == Some(x.id.as_str());
            let abbrev: String = x
                .display_title()
                .chars()
                .filter(|c| c.is_alphanumeric())
                .take(2)
                .collect::<String>()
                .to_uppercase();
            k.interactive(
                col()
                    .key(format!("tile-{}", x.id))
                    .role("button")
                    .label(x.display_title())
                    .w(36.0)
                    .h(36.0)
                    .center()
                    .gap(3.0)
                    .radius(k.radius.md)
                    .cursor(Cursor::Pointer)
                    .fill(if cur {
                        k.c.layer_02
                    } else {
                        Color::TRANSPARENT
                    })
                    .help(x.display_title())
                    .child(
                        text(abbrev)
                            .font(k.ty.text_xsmall_medium)
                            .color(k.c.text_muted),
                    )
                    .child(dot(k, &x.state, 5.0)),
            )
            .on_press(move |s: &mut Hooked| s.open_session(&id))
        });
    col()
        .key("rail")
        .w(48.0)
        .h_full()
        .py(8.0)
        .gap(4.0)
        .items_center()
        .fill(k.c.bg_deep)
        .border_sides([0.0, 1.0, 0.0, 0.0], k.c.border_weak)
        .child(
            IconButton::new(&icons::ARROW_RIGHT)
                .variant(IconButtonVariant::GhostMuted)
                .label("Expand sidebar (⌘B)")
                .help("Expand sidebar (⌘B)")
                .on_press(|s: &mut Hooked| {
                    s.sidebar_open = true;
                    s.save_pref("sidebarOpen", &true);
                })
                .build(k)
                .key("rail-expand"),
        )
        .child(
            col()
                .key("rail-tiles")
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .items_center()
                .gap(4.0)
                .scroll(rune::ScrollSpec {
                    stick_bottom: false,
                })
                .children(tiles),
        )
}

pub fn pill(k: &Kit, label: impl Into<String>, fg: Color, bg: Color) -> El {
    row()
        .h(20.0)
        .px(8.0)
        .gap(5.0)
        .center_y()
        .radius(10.0)
        .fill(bg)
        .child(text(label.into()).font(k.ty.text_xsmall_medium).color(fg))
}

pub fn section_title(k: &Kit, label: &str) -> El {
    text(label.to_string())
        .font(k.ty.text_xsmall_medium)
        .color(k.c.text_faint)
}
