mod deck;
mod dock;
mod fleet;
mod ghdetail;
mod incidents;
pub(crate) mod ghrun;
mod lenses;
mod new_session;
mod organize;
mod pages;
mod palette;
mod panel;
mod querywin;
mod session;
mod settings;
mod split;
mod terminal;

use std::collections::BTreeMap;

use rune::{Color, Cursor, Cx, El, Icon, Phase, col, el, row, text};
use rune_kit::shell::{Sidebar, SidebarSection};
use rune_kit::{
    Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant, Kit, Menu, MenuItem,
};

pub use hooked_ui::widgets::{glyph, pill, section_title};
use hooked_ui::widgets::{
    connection_dot, list_row, list_row_lines, list_row_subtitle, list_row_title,
};

use crate::api::Session;
use crate::app::{Hooked, Page, Popup, Theme};
use crate::coderun::CodeRun;
use crate::sections::{Section, clock, group_face, section_of, snooze_presets, wake_label};
use crate::{fmt, icons};

pub const SIDEBAR_W: f32 = 300.0;

pub const DOCK_W: f32 = 300.0;
pub const RENDERED_W: f32 = 460.0;
/// The Review lens's files rail and comments panel, until they are resized.
pub const REVIEW_FILES_W: f32 = 240.0;
pub const REVIEW_THREADS_W: f32 = 300.0;
pub const SHOTS_FOLDED: usize = 4;
pub const SHOTS_OPEN: usize = 60;

pub fn kit(s: &Hooked, cx: &Cx<Hooked>) -> Kit {
    let dark = s.dark(cx.system_dark());
    s.theme_dark.set(dark);
    crate::theme::kit(dark)
}

pub fn state_color(k: &Kit, state: &str) -> Color {
    crate::theme::state_color(k.dark, state)
}

pub fn dot(k: &Kit, state: &str, size: f32) -> El {
    el().size(size, size)
        .radius(if crate::theme::sharp() { 0.0 } else { size / 2.0 })
        .fill(state_color(k, state))
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
    #[cfg(feature = "knobs")]
    crate::knobs::sync(&s.knobs);
    let k = kit(s, cx);
    s.drop_live.borrow_mut().clear();
    let mut layer = Vec::new();
    let main = match s.page {
        p if !s.page_on(p) => pages::module_off(&k, p),
        Page::Deck => deck::view(s, &k),
        Page::Session => session::view(s, &k, &mut layer),
        Page::New => new_session::view(s, &k, &mut layer),
        Page::Stats => pages::stats(s, &k),
        Page::Digest => pages::digest(s, &k),
        Page::Memory => pages::memory(s, &k),
        Page::Cron => pages::cron(s, &k),
        Page::Flows => pages::flows(s, &k),
        Page::GitHub => pages::github(s, &k, &mut layer),
        Page::Incidents => incidents::view(s, &k),
        Page::Skills => pages::skills(s, &k),
        Page::Settings => settings::view(s, &k),
        Page::Prompts => pages::prompts(s, &k),
    };
    let mut body = row().key("body").w_full().grow(1.0).min_h(0.0);
    body = if s.focus {
        body
    } else if s.page == Page::Settings {
        body.child(settings::toc(s, &k))
    } else if s.sidebar_open {
        body.child(sidebar(s, &k, &mut layer))
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
    if s.page == Page::Session && !s.focus {
        if !s.splits.is_empty() {
            for p in &s.splits {
                body = body.child(split::view(s, p, &k));
            }
        } else if let Some(d) = s.detail.as_ref() {
            body = body.child(dock::view(s, d, &k, &mut layer));
        }
    }
    let mut base = col()
        .key("window")
        .on_layout(|s: &mut Hooked, r: [f32; 4]| {
            if (s.window_h - r[3]).abs() > 0.5 {
                s.window_h = r[3];
            }
            if (s.window_w - r[2]).abs() > 0.5 {
                s.window_w = r[2];
            }
        })
        .on_drop_files(|s: &mut Hooked, files: &[std::path::PathBuf], _| s.attach_files(files))
        .w_full()
        .h_full()
        .fill(k.c.bg_deep)
        .child(topbar(s, &k, cx.titlebar_inset(), &mut layer))
        .child(body);
    if let Some(spring) = crate::theme::layout_spring() {
        base = base.token_motion(spring);
    }
    if let Some(w) = s.run_win.as_ref() {
        layer.push(ghrun::view(s, w, &k));
    }
    if let Some(w) = s.query_win.as_ref() {
        layer.push(querywin::view(s, w, &k));
    }
    if let Some(w) = s.panel_win.as_ref() {
        layer.push(panel::view(s, w, &k, cx));
    }
    if let Some(d) = s.dnd.as_ref() {
        layer.push(drag_ghost(s, &k, d));
    }
    if s.palette_open {
        layer.push(palette::view(s, &k));
    }
    if s.picker.is_some() {
        layer.push(organize::view(s, &k));
    }
    layer.extend(incidents::modal(s, &k));
    rune_kit::root(crate::knobs::side(base, s, k.dark), layer)
        .on_window_focus(|s: &mut Hooked, gained: bool, _| s.window_focus(gained))
        .on_paste_content(
            |s: &mut Hooked, c: &rune::ClipboardContent, tx: &mut rune::Tx| {
                if !c.text().is_empty() && s.focused_paste(c.text()) {
                    tx.instant();
                    return;
                }
                if let Some(img) = c.image() {
                    let n = s.attach_seq + 1;
                    s.attach(format!("pasted-{n}.png"), "image/png", img.png().to_vec());
                }
            },
        )
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

/// The pages the top bar can show next to Deck and Sessions: (settings key, element key, label,
/// icon, page), in tab order.
const NAV_PAGES: [(&str, &str, &str, &Icon, Page); 9] = [
    ("stats", "tb-stats", "Stats", &icons::CHART, Page::Stats),
    ("digest", "tb-digest", "Digest", &icons::BOOK, Page::Digest),
    ("memory", "tb-memory", "Memory", &icons::BRAIN, Page::Memory),
    ("cron", "tb-cron", "Cron", &icons::TIMER, Page::Cron),
    ("flows", "tb-flows", "Flows", &icons::WORKFLOW, Page::Flows),
    ("github", "tb-github", "GitHub", &icons::GITHUB, Page::GitHub),
    ("incidents", "tb-incidents", "Incidents", &icons::SIREN, Page::Incidents),
    ("skills", "tb-skills", "Skills", &icons::SPARKLE, Page::Skills),
    ("prompts", "tb-prompts", "Prompts", &icons::BOOK, Page::Prompts),
];

fn topbar(s: &Hooked, k: &Kit, inset: f32, layer: &mut Vec<El>) -> El {
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
    let deck = space("tb-deck", "Deck", &icons::DECK, s.page == Page::Deck, None)
        .on_press(|s: &mut Hooked| s.go_deck());
    let sessions = space(
        "tb-sessions",
        "Sessions",
        &icons::LIST,
        s.page == Page::Session,
        None,
    )
    .on_press(|s: &mut Hooked| {
        s.open_sessions();
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
                    text(crate::fmt::keys("⌘K"))
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.text_faint),
                ),
        )
        .on_press(|s: &mut Hooked| {
            s.open_palette("");
        });
    // Usage en entête, provider-aware : un seul groupe à la fois, même design qu'avant. Vue
    // claude = rate limits du compte (5H/7D/FABLE, masqués sans binaire claude) ; vue pi = usage
    // agrégé des sessions pi (coût + tokens du jour, cf. buildPiUsage serveur). Un clic sur le
    // bloc alterne quand les deux fournisseurs sont configurés (s.usage_view, persisté).
    // One view per non-Claude provider with usage (s.provider_usage); a click cycles them
    // (s.usage_views / toggle_usage_view).
    let view = s.current_usage_view();
    let pi_g = match &view {
        Some(crate::api::UsageView::Provider(id)) => s.provider_usage.iter().find(|u| &u.provider == id),
        _ => None,
    };
    let both = s.usage_views().len() > 1;
    let mut gauges = if let Some(p) = pi_g {
        row()
            .key("tb-gauges")
            .center_y()
            .child(usage_pi(s, k, p, 64.0))
    } else if s.providers.claude_account() {
        row()
            .key("tb-gauges")
            .gap(10.0)
            .center_y()
            .children(s.gauges.iter().map(|g| gauge(k, &g.label, g.pct, 64.0)))
    } else {
        el()
    };
    if both {
        gauges = gauges
            .help(match pi_g {
                Some(p) => format!(
                    "{} session usage — click to switch",
                    p.label.clone().unwrap_or_else(|| s.providers.info(&p.provider).label)
                ),
                None => "Account rate limits — click to switch to the next provider".to_string(),
            })
            .cursor(Cursor::Pointer)
            .on_press(|s: &mut Hooked| s.toggle_usage_view());
    }
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
    let mut actions = row()
        .key("tb-actions")
        .gap(2.0)
        .center_y()
        .child(if s.incognito {
            Button::new("Incognito")
                .icon(&icons::EYE_OFF)
                .variant(ButtonVariant::Warning)
                .control_size(ControlSize::Small)
                .help("Incognito: only sessions started in this mode are shown. Click to show everything again.")
                .on_press(|s: &mut Hooked| s.toggle_incognito_mode())
                .build(k)
                .key("tb-incognito")
        } else {
            IconButton::new(&icons::EYE)
                .variant(IconButtonVariant::GhostMuted)
                .label("Incognito mode")
                .help("Incognito: show only the sessions you start from now on (screen sharing)")
                .on_press(|s: &mut Hooked| s.toggle_incognito_mode())
                .build(k)
                .key("tb-incognito")
        })
        .child(
            IconButton::new(&icons::TRASH)
                .variant(IconButtonVariant::GhostMuted)
                .label("Trash")
                .help("Trash: deleted sessions, recoverable")
                .on_press(|s: &mut Hooked| s.open_trash())
                .build(k)
                .key("tb-trash"),
        )
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
                .help(crate::fmt::keys("Settings (⌘,)"))
                .on_press(|s: &mut Hooked| s.go(Page::Settings))
                .build(k)
                .key("tb-settings"),
        );
    // Account / quotas = the Claude OAuth account: hidden when nothing uses it.
    if s.providers.claude_account() {
        actions = actions.child(
            IconButton::new(&icons::USER)
                .variant(IconButtonVariant::GhostMuted)
                .label("Claude account")
                .help("Claude account: who is signed in, switch, sign out")
                .on_press(|s: &mut Hooked| s.open_account())
                .build(k)
                .key("tb-account"),
        );
    }
    let new = Button::new("Session")
        .icon(&icons::PLUS)
        .variant(ButtonVariant::Contrast)
        .control_size(ControlSize::Regular)
        .shortcut(crate::fmt::keys("⌘N"))
        .on_press(|s: &mut Hooked| s.go_new(None))
        .build(k)
        .key("tb-new");
    let live = connection_dot(
        k,
        s.connected,
        &if s.connected {
            "Connected to hooked".to_string()
        } else {
            format!("hooked is unreachable on {}", crate::api::base_label())
        },
    );
    // Pages picked in Settings → navigation are tabs; the others (and Incidents, once the
    // incident.io app is there) sit in a "More" menu, as on the web. The open page always shows
    // as a tab, so you can see where you are.
    let (shown, hidden): (Vec<_>, Vec<_>) = NAV_PAGES
        .iter()
        .copied()
        .filter(|t| t.4 != Page::Incidents || s.incidents_on() || s.page == Page::Incidents)
        // A module switched off in Settings → Modules takes its page away.
        .filter(|t| s.page_on(t.4) || s.page == t.4)
        // Memory = ~/.claude (Claude only): no tab, not even in More, without the claude provider.
        .filter(|t| t.4 != Page::Memory || s.providers.claude_account())
        .partition(|t| s.nav_tab(t.0) || s.page == t.4);
    let more = (!hidden.is_empty()).then(|| {
        let open = s.popup == Some(Popup::Nav);
        // Open incidents still show when their tab is tucked away.
        let pending = hidden
            .iter()
            .any(|t| t.4 == Page::Incidents)
            .then(|| s.inc.mine_open())
            .filter(|n| *n > 0);
        let mut trigger = row()
            .key("tb-more")
            .role("button")
            .label("More pages")
            .h(28.0)
            .px(10.0)
            .gap(6.0)
            .center_y()
            .radius(k.radius.md)
            .cursor(Cursor::Pointer)
            .fill(if open { k.c.layer_02 } else { Color::TRANSPARENT })
            .child(text("More").font(k.ty.ui_medium).color(k.c.text_muted))
            .child(glyph(&icons::CHEVRON_DOWN, 12.0, k.c.icon_muted));
        if let Some(n) = pending {
            trigger = trigger.child(
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
        let trigger = k.interactive(trigger).on_press(|s: &mut Hooked| {
            s.popup = if s.popup == Some(Popup::Nav) {
                None
            } else {
                Some(Popup::Nav)
            }
        });
        let mut menu = Menu::new("tb-more-menu")
            .trigger(trigger)
            .open(open)
            .min_width(200.0)
            .on_close(|s: &mut Hooked| s.popup = None);
        for (_, _, label, icon, page) in hidden {
            let mut item = MenuItem::new(label)
                .icon(icon)
                .on_select(move |s: &mut Hooked| s.go(page));
            if page == Page::Incidents
                && let Some(n) = pending
            {
                item = item.badge(n.to_string());
            }
            menu = menu.item(item);
        }
        menu.build(k, layer)
    });
    hooked_ui::widgets::topbar(k, inset)
        .child(
            row()
                .key("tb-logo")
                .gap(6.0)
                .center_y()
                .help("hooked")
                .child(match s.logo.as_ref() {
                    Some((_, imgs)) => hooked_ui::logo::mark(imgs, k.dark),
                    None => glyph(&icons::CIRCLE_DOT, 16.0, k.c.text_base),
                }),
        )
        .child(
            row()
                .key("tb-spaces")
                .gap(2.0)
                .center_y()
                .child(deck)
                .children(s.nav_tab("sessions").then_some(sessions))
                .children(shown.into_iter().map(|(_, key, label, icon, page)| {
                    let badge = (page == Page::Incidents).then(|| s.inc.mine_open());
                    space(key, label, icon, s.page == page, badge)
                        .on_press(move |s: &mut Hooked| s.go(page))
                }))
                .children(more),
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
        .child(if s.window_w >= 1150.0 { gauges } else { el() })
        .child(actions)
        .child(new)
        .child(live)
}

fn gauge(k: &Kit, label: &str, pct: Option<f64>, w: f32) -> El {
    let p = pct.unwrap_or(0.0).clamp(0.0, 100.0) as f32;
    let fill = if p >= 90.0 {
        k.c.danger.icon
    } else if p >= 75.0 {
        k.c.warning.icon
    } else {
        k.c.icon_muted
    };
    col()
        .w(w)
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
                .child(el().w(w * p / 100.0).h(3.0).radius(1.5).fill(fill)),
        )
}

/// Header usage block of a non-Claude provider, in place of Claude's rate limits: the day's cost
/// as the main value, the day's tokens below. No gauge — no account limit is known for those
/// providers. The freshest session (model, context) stays in the tooltip.
fn usage_pi(s: &Hooked, k: &Kit, p: &crate::api::PiUsage, w: f32) -> El {
    let name = p.label.clone().unwrap_or_else(|| s.providers.info(&p.provider).label);
    let mut help = format!(
        "{name} — usage today: {} · {} tokens",
        crate::fmt::cost(p.today_cost),
        human_tokens(p.today_tokens.unwrap_or(0.0))
    );
    help += &format!(
        "\ntotal: {} · {} sessions",
        crate::fmt::cost(p.cost),
        p.sessions.unwrap_or(1.0)
    );
    help += &format!(
        "\nlatest: {}",
        p.title
            .as_deref()
            .filter(|t| !t.is_empty())
            .unwrap_or(&p.session_id)
    );
    if let Some(m) = &p.model {
        help += &format!(" · {m}");
    }
    if let Some(ctx) = &p.context {
        if let (Some(sz), Some(win)) = (ctx.size, ctx.context_window) {
            help += &format!(" · ctx {} / {}", human_tokens(sz), human_tokens(win));
        }
    }
    if p.live {
        help.push_str(" · live");
    } else {
        help.push_str(&format!(
            " · last activity {}",
            crate::fmt::ago_short(p.at.as_deref(), s.now)
        ));
    }
    col()
        .w(w)
        .gap(3.0)
        .help(help)
        .child(
            row()
                .w_full()
                .gap(4.0)
                .justify_between()
                .child(
                    text(s.providers.info(&p.provider).short.to_uppercase())
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.text_faint),
                )
                .child(
                    text(crate::fmt::cost(p.today_cost))
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.text_muted),
                ),
        )
        .child(
            text(format!("{} tok today", human_tokens(p.today_tokens.unwrap_or(0.0))))
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        )
}

fn human_tokens(n: f64) -> String {
    if n >= 1e6 {
        format!("{:.0}M", n / 1e6)
    } else if n >= 1e3 {
        format!("{:.0}k", n / 1e3)
    } else {
        format!("{n:.0}")
    }
}

fn unit_rows(s: &Hooked, u: &crate::organize::Unit<'_>, k: &Kit, layer: &mut Vec<El>) -> Vec<El> {
    let members: Vec<&Session> = std::iter::once(u.mother)
        .chain(u.children.iter().copied())
        .collect();
    let mut out = vec![session_row(
        s,
        u.mother,
        k,
        0,
        (members.len() > 1).then_some(members.as_slice()),
        layer,
    )];
    if !s.folded_groups.contains(&u.mother.id) {
        for c in &u.children {
            out.push(session_row(s, c, k, 1, None, layer));
        }
    }
    out
}

/// `slot` is the `s.snooze_menu` value that opens this menu: the session id for a sidebar row,
/// something else for another trigger of the same session, so only one of them opens.
pub(super) fn snooze_menu(
    s: &Hooked,
    session: &str,
    slot: &str,
    k: &Kit,
    layer: &mut Vec<El>,
    trigger: El,
) -> El {
    let mut m = Menu::new(format!("snooze-{slot}"))
        .trigger(trigger)
        .open(s.snooze_menu.as_deref() == Some(slot))
        .min_width(200.0)
        .on_close(|s: &mut Hooked| s.snooze_menu = None);
    if let Some(w) = s.snoozed_until(session) {
        let id = session.to_string();
        m = m
            .item(
                MenuItem::new("Wake now")
                    .icon(&icons::BELL)
                    .description(format!("Snoozed until {}", wake_label(w, s.now)))
                    .on_select(move |s: &mut Hooked| {
                        s.snooze_menu = None;
                        s.wake(&id);
                    }),
            )
            .separator();
    }
    for (label, until) in snooze_presets(s.now) {
        let id = session.to_string();
        m = m.item(
            MenuItem::new(label)
                .shortcut(clock(until))
                .on_select(move |s: &mut Hooked| {
                    s.snooze_menu = None;
                    s.snooze_until(vec![id.clone()], until);
                }),
        );
    }
    m.build(k, layer)
}

fn session_row(
    s: &Hooked,
    x: &Session,
    k: &Kit,
    depth: u8,
    group: Option<&[&Session]>,
    layer: &mut Vec<El>,
) -> El {
    let id = x.id.clone();
    let wake = s.snoozed_until(&x.id);
    let mut detail = fmt::ago_short(x.last_activity.as_deref(), s.now);
    let window = s.setting("sidebarCache")["windowMin"]
        .as_i64()
        .unwrap_or(15);
    if let Some(left) = x
        .cache
        .as_ref()
        .and_then(|c| fmt::cache_left(c.last_request_at.as_deref(), c.ttl.as_deref(), s.now))
        .filter(|left| window == 0 || *left <= window * 60_000)
    {
        detail = if s.setting("sidebarCache")["display"].as_str() == Some("replace") {
            format!("⚡{}", fmt::span(left, ""))
        } else {
            format!("⚡{} · {detail}", fmt::span(left, ""))
        };
    }
    let archived = s.meta.get(&x.id).is_some_and(|m| m.archived);
    let mut subtitle = match &x.git_branch {
        Some(b) if !b.is_empty() => format!("{} · {b}", x.project_label()),
        _ => x.project_label(),
    };
    if !s.incognito && s.meta.get(&x.id).is_some_and(|m| m.incognito) {
        subtitle.push_str("  · incognito");
    }
    let label = if group.is_some()
        && s.meta
            .get(&x.id)
            .and_then(|m| m.group_name.as_ref())
            .is_some()
    {
        s.group_label(x)
    } else {
        s.title_of(x)
    };
    let selected = s.page == Page::Session && s.selected.as_deref() == Some(x.id.as_str());
    let renaming = s.renaming.as_ref().filter(|(rid, _)| *rid == x.id);
    let title: El = match renaming {
        Some((_, edit)) => rune_kit::TextInput::new(edit)
            .width(None)
            .on_edit(|s: &mut Hooked| &mut s.renaming.as_mut().expect("renaming").1)
            .on_submit(|s: &mut Hooked, _| s.commit_rename())
            .on_key(|s: &mut Hooked, ev: &rune::KeyEvent, _| {
                if ev.key == rune::Key::Escape {
                    s.renaming = None;
                    return true;
                }
                false
            })
            .build(k)
            .key("rename")
            .grow(1.0)
            .min_w(0.0),
        None => list_row_title(k, label),
    };
    let mut line1 = row().grow(1.0).min_w(0.0).gap(6.0).center_y();
    if s.is_pinned(&x.id) {
        line1 = line1.child(glyph(&icons::PIN, 12.0, k.c.icon_muted));
    }
    line1 = line1.child(title);
    // Badge provider (cc/pi) à côté du titre — la sidebar est LA liste des sessions.
    if let Some(b) = fleet::prov_badge(s, k, x) {
        line1 = line1.child(b);
    }
    let folded = s.folded_groups.contains(&x.id);
    if let Some(members) = group {
        let n = members.len();
        let badge = if folded {
            format!("+{}", n - 1)
        } else {
            n.to_string()
        };
        line1 = line1.child(pill(k, badge, k.c.text_muted, k.c.layer_02));
    }
    if let Some(w) = wake {
        detail = wake_label(w, s.now);
    }
    // A folded group's mark stands for the children it hides.
    let face = match group {
        Some(members) if folded => group_face(members),
        _ => x,
    };
    let mark: El = if archived {
        el()
    } else if wake.is_some() {
        glyph(&icons::SNOOZE, 12.0, k.c.icon_muted)
    } else if face.state == "working" {
        rune_kit::Spinner::new().build(k).size(12.0, 12.0)
    } else if face.needs_you() {
        dot(k, "waiting", 7.0)
    } else {
        dot(k, &face.state, 6.0)
    };
    let resting = row()
        .gap(8.0)
        .center_y()
        .group_opacity(1.0, 0.0)
        .child(text(detail).font(k.ty.text_xsmall).color(k.c.text_faint))
        .child(row().w(14.0).center().child(mark));
    let act = |icon: &'static rune::Icon, label: &str, on: bool, f: Box<dyn Fn(&mut Hooked)>| {
        IconButton::new(icon)
            .variant(if on {
                IconButtonVariant::Ghost
            } else {
                IconButtonVariant::GhostMuted
            })
            .control_size(rune_kit::ControlSize::Small)
            .label(label.to_string())
            .help(label.to_string())
            .on_press(move |s: &mut Hooked| f(s))
            .build(k)
            .focusable(false)
    };
    let incog = s.meta.get(&x.id).is_some_and(|m| m.incognito);
    let pinned = s.is_pinned(&x.id);
    let (g, t, p, i, sp, ar, sz) = (
        id.clone(),
        id.clone(),
        id.clone(),
        id.clone(),
        id.clone(),
        id.clone(),
        id.clone(),
    );
    let mut actions = row()
        .gap(0.0)
        .center_y()
        .padding(2.0)
        .radius(k.radius.sm)
        .fill(k.c.layer_02)
        .group_opacity(0.0, 1.0)
        .child(act(
            &icons::LIST,
            "Move to group…",
            false,
            Box::new(move |s| s.open_group_picker(g.clone())),
        ))
        .child(act(
            &icons::TAG,
            "Edit tags",
            false,
            Box::new(move |s| s.open_tags(t.clone())),
        ))
        .child(act(
            &icons::PIN,
            if pinned { "Unpin" } else { "Pin" },
            pinned,
            Box::new(move |s| s.toggle_pin(&p)),
        ))
        .child(act(
            if incog { &icons::EYE_OFF } else { &icons::EYE },
            if incog {
                "Remove from incognito"
            } else {
                "Mark incognito: keep it visible in incognito mode"
            },
            incog,
            Box::new(move |s| s.toggle_incognito(&i)),
        ));
    if !archived {
        let trigger = act(
            &icons::SNOOZE,
            if wake.is_some() {
                "Change or end the snooze"
            } else {
                "Snooze…"
            },
            wake.is_some(),
            Box::new(move |s| {
                s.snooze_menu = if s.snooze_menu.as_deref() == Some(sz.as_str()) {
                    None
                } else {
                    Some(sz.clone())
                }
            }),
        );
        actions = actions.child(snooze_menu(s, &x.id, &x.id, k, layer, trigger));
    }
    if !archived && s.page == Page::Session && !selected && !s.splits.iter().any(|p| p.id == x.id) {
        actions = actions.child(act(
            &icons::SPLIT,
            "Split beside the current session",
            false,
            Box::new(move |s| s.open_split(sp.clone())),
        ));
    }
    actions = actions.child(act(
        if archived {
            &icons::UNARCHIVE
        } else {
            &icons::ARCHIVE
        },
        if archived { "Unarchive" } else { "Archive" },
        false,
        Box::new(move |s| s.toggle_archive(&ar)),
    ));
    let trailing = resting;
    let tags = s.session_tags(&x.id);
    let mut body = list_row_lines(
        row()
            .w_full()
            .gap(8.0)
            .center_y()
            .child(line1)
            .child(trailing),
        list_row_subtitle(k, subtitle),
    );
    if x.remote.is_some() || !tags.is_empty() {
        // A remote session's instance badge leads the line: it is there even without a tag.
        body = body.child(
            row()
                .w_full()
                .pt(4.0)
                .gap(4.0)
                .flex_wrap()
                .children(x.remote.iter().map(|r| remote_badge(k, r)))
                .children(tags.iter().map(|t| tag_pill(s, k, t))),
        );
    }
    let menu_id = id.clone();
    let (open, rename) = (id.clone(), id.clone());
    let mut r = list_row(k, depth)
        .key(format!("row-{}", x.id))
        .role("button")
        .checked(selected)
        .label(s.title_of(x))
        .focusable(true)
        .focus_selected(selected)
        .opacity(if archived || wake.is_some() { 0.7 } else { 1.0 })
        .child(body)
        .child(actions.pin(None, Some(4.0), Some(6.0), None));
    if selected {
        r = r.fill(k.c.pressed);
    }
    if x.remote.is_some() {
        r = r
            .fill(remote_wash(k, selected))
            .border_sides([0.0, 0.0, 0.0, 3.0], crate::theme::remote_color(k.dark));
    }
    let drag = id.clone();
    let r = s.drop_target(k, format!("sb:{}", x.id), r);
    k.interactive(r)
        .on_press(move |s: &mut Hooked| s.open_session(&open))
        .on_drag(move |s: &mut Hooked, d: &mut rune::Drag, _| s.drag_session(&drag, d))
        .on_double_press(move |s: &mut Hooked| s.start_rename(&rename))
        .help(if archived {
            "Hover for actions · right-click for more"
        } else {
            "Hover for actions · double-click renames · right-click for more"
        })
        .on_secondary_press(move |s: &mut Hooked, p, _| s.row_menu = Some((menu_id.clone(), p)))
}

fn drag_ghost(s: &Hooked, k: &Kit, d: &crate::dnd::Dnd) -> El {
    let hint = match &d.over {
        Some(crate::dnd::Drop::Session(t)) => {
            let lead = s.group_of(t).unwrap_or(t);
            let name = s
                .sessions
                .iter()
                .find(|x| x.id == lead)
                .map(|x| s.group_label(x))
                .unwrap_or_default();
            format!("Group with {name}")
        }
        Some(crate::dnd::Drop::Detach) => "Take out of its group".to_string(),
        None => "Drop on a session to group them".to_string(),
    };
    col()
        .key("drag-ghost")
        .absolute(d.at.0 + 14.0, d.at.1 + 10.0)
        .max_w(320.0)
        .px(10.0)
        .py(6.0)
        .gap(2.0)
        .radius(k.radius.md)
        .fill(k.c.surface_raised)
        .border(
            1.0,
            if d.over.is_some() {
                k.c.text_accent
            } else {
                k.c.border_strong
            },
        )
        .box_shadows(&k.elevation.overlay)
        .child(
            text(d.label.clone())
                .font(k.ty.text_small_medium)
                .color(k.c.text_base)
                .truncate(),
        )
        .child(
            text(hint)
                .font(k.ty.text_xsmall)
                .color(if d.over.is_some() {
                    k.c.text_accent
                } else {
                    k.c.text_faint
                })
                .truncate(),
        )
}

fn section_body(
    s: &Hooked,
    sec: Section,
    units: &[crate::organize::Unit<'_>],
    k: &Kit,
    layer: &mut Vec<El>,
) -> Vec<El> {
    let cur = units.iter().position(|u| {
        std::iter::once(u.mother)
            .chain(u.children.iter().copied())
            .any(|x| s.selected.as_deref() == Some(x.id.as_str()))
    });
    let mut out = Vec::new();
    if s.section_collapsed(sec) {
        if let Some(i) = cur {
            out.extend(unit_rows(s, &units[i], k, layer));
        }
        return out;
    }
    let open = s.open_sections.contains(sec.label());
    let take = match sec.window() {
        Some(w) if !open => w.max(cur.map_or(0, |i| i + 1)),
        _ => units.len(),
    };
    for u in units.iter().take(take) {
        out.extend(unit_rows(s, u, k, layer));
    }
    if sec.window().is_some_and(|w| units.len() > w) && (open || take < units.len()) {
        let label = if open {
            "Show less".to_string()
        } else {
            format!("{} more", units.len() - take)
        };
        out.push(
            Button::new(label)
                .icon(if open {
                    &icons::CHEVRON_DOWN
                } else {
                    &icons::PLUS
                })
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut Hooked| {
                    if !s.open_sections.remove(sec.label()) {
                        s.open_sections.insert(sec.label());
                    }
                })
                .build(k)
                .key(format!("more-{}", sec.label())),
        );
    }
    out
}

fn section_dock(
    s: &Hooked,
    sec: Section,
    units: &[crate::organize::Unit<'_>],
    k: &Kit,
    layer: &mut Vec<El>,
) -> El {
    let folded = s.section_collapsed(sec);
    let body = section_body(s, sec, units, k, layer);
    let head = k
        .interactive(
            row()
                .key("dock-head")
                .w_full()
                .h(28.0)
                .px(8.0)
                .gap(4.0)
                .center_y()
                .radius(k.radius.md)
                .cursor(Cursor::Pointer)
                .child(
                    text(sec.label())
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.text_muted),
                )
                .child(
                    text(units.len().to_string())
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.text_faint),
                )
                .child(el().grow(1.0))
                .child(glyph(
                    if folded {
                        &icons::CHEVRON_UP
                    } else {
                        &icons::CHEVRON_DOWN
                    },
                    12.0,
                    k.c.icon_faint,
                )),
        )
        .role("button")
        .label(sec.label())
        .expanded(!folded)
        .on_press(move |s: &mut Hooked| s.toggle_section(sec));
    let mut dock = col()
        .key(format!("dock-{}", sec.label()))
        .w_full()
        .gap(2.0)
        .pt(4.0)
        .border_sides([1.0, 0.0, 0.0, 0.0], k.c.border_weak);
    if !body.is_empty() {
        dock = dock.child(
            col()
                .key("dock-list")
                .w_full()
                .max_h(s.window_h * 0.35)
                .gap(2.0)
                .scroll(rune::ScrollSpec {
                    stick_bottom: false,
                })
                .children(body),
        );
    }
    dock.child(head)
}

fn sidebar(s: &Hooked, k: &Kit, layer: &mut Vec<El>) -> El {
    let (active, archived): (Vec<&Session>, Vec<&Session>) = s
        .sessions
        .iter()
        .filter(|x| s.visible(x))
        .partition(|x| !s.is_archived(x));
    let by_status = s.by_status();
    let recent = |x: &&Session| {
        x.needs_you()
            || x.state == "working"
            || s.selected.as_deref() == Some(x.id.as_str())
            || fmt::age_ms(x.last_activity.as_deref(), s.now).is_none_or(|a| a < 86_400_000)
    };
    let tagged = |x: &&Session| {
        s.tag_filter
            .iter()
            .all(|t| s.session_tags(&x.id).contains(t))
            && (s.repo_filter.is_empty() || s.repo_filter.contains(&x.project_label()))
    };
    let mut live = active.clone();
    if s.hide_old {
        live.retain(recent);
    }
    live.retain(tagged);
    let mut gone = archived.clone();
    gone.retain(tagged);
    let sections = if by_status {
        s.status_sections(&s.sorted(live.clone()), &s.sorted(gone.clone()))
    } else {
        Vec::new()
    };
    let live_units: usize = sections
        .iter()
        .filter(|(x, _)| !x.docked())
        .map(|(_, u)| u.len())
        .sum();
    let mut shown = s.sorted(if s.show_archived { gone } else { live });
    const WINDOW: usize = 40;
    let total = shown.len();
    if !s.older_open && total > WINDOW {
        let keep = |x: &&Session| {
            s.is_pinned(&x.id)
                || x.needs_you()
                || x.state == "working"
                || s.selected.as_deref() == Some(x.id.as_str())
        };
        let mut kept = 0;
        shown.retain(|x| {
            kept += 1;
            kept <= WINDOW || keep(x)
        });
    }
    let hidden_older = total - shown.len();
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
    let mut head = row().key("ssb-head").w_full().gap(2.0).center_y();
    head = if by_status {
        head.child(tab("ssb-active", "Sessions", live_units, true))
    } else {
        head.child(
            tab("ssb-active", "Sessions", active.len(), !s.show_archived)
                .on_press(|s: &mut Hooked| s.show_archived = false),
        )
        .child(
            tab("ssb-archived", "Archived", archived.len(), s.show_archived)
                .on_press(|s: &mut Hooked| s.show_archived = true),
        )
    };
    let head = head.child(el().grow(1.0)).child(
        small_icon_button(&icons::CLOCK, "Show only the last 24h", s.hide_old)
            .on_press(|s: &mut Hooked| {
                s.hide_old = !s.hide_old;
                let v = s.hide_old;
                s.save_pref("hideOld", &v);
            })
            .build(k)
            .key("ssb-old"),
    );
    let collapse = small_icon_button(&icons::ARROW_LEFT, &crate::fmt::keys("Collapse sidebar (⌘B)"), false)
        .on_press(|s: &mut Hooked| {
            s.sidebar_open = false;
            s.save_pref("sidebarOpen", &false);
        })
        .build(k)
        .key("ssb-collapse");
    let picked = s.tag_filter.len() + s.repo_filter.len() + if s.provider_filter.is_some() { 1 } else { 0 };
    let filter_btn = small_icon_button(
        &icons::FILTER,
        &if picked > 0 {
            format!("Filter by tag or repo ({picked} on)")
        } else {
            "Filter by tag or repo".to_string()
        },
        picked > 0,
    )
    .on_press(|s: &mut Hooked| {
        s.popup = if s.popup == Some(Popup::Filter) {
            None
        } else {
            Some(Popup::Filter)
        }
    })
    .build(k)
    .key("ssb-filter");
    let mut filter_menu = Menu::new("ssb-filter-menu")
        .trigger(filter_btn)
        .open(s.popup == Some(Popup::Filter))
        .min_width(220.0)
        .on_close(|s: &mut Hooked| s.popup = None);
    let summary = |list: &[String], tag: bool, noun: &str| match list {
        [] => "Any".to_string(),
        [one] if tag => format!("#{one}"),
        [one] => one.clone(),
        _ => format!("{} {noun}", list.len()),
    };
    // Le filtre Provider n'a de sens que quand les DEUX providers sont installés.
    if s.providers.both() {
        filter_menu = filter_menu.item(
            MenuItem::new("Provider")
                .description(match s.provider_filter.as_deref() {
                    None => "Any".to_string(),
                    Some(id) => s.providers.info(id).label,
                })
                .on_select(|s: &mut Hooked| s.cycle_provider_filter()),
        );
    }
    filter_menu = filter_menu
        .item(
            MenuItem::new("Repo")
                .description(summary(&s.repo_filter, false, "repos"))
                .on_select(|s: &mut Hooked| s.open_filter_picker(true)),
        )
        .item(
            MenuItem::new("Tags")
                .description(summary(&s.tag_filter, true, "tags"))
                .on_select(|s: &mut Hooked| s.open_filter_picker(false)),
        );
    if picked > 0 {
        filter_menu = filter_menu.separator().item(
            MenuItem::new("Clear filters")
                .icon(&icons::CLOSE)
                .on_select(|s: &mut Hooked| {
                    s.tag_filter.clear();
                    s.repo_filter.clear();
                    s.provider_filter = None;
                }),
        );
    }
    let sort_open = s.popup == Some(Popup::Sort);
    let sort_btn = small_icon_button(&icons::SORT, "Group and sort", s.sort_mode != "dynamic")
        .on_press(|s: &mut Hooked| {
            s.popup = if s.popup == Some(Popup::Sort) {
                None
            } else {
                Some(Popup::Sort)
            }
        })
        .build(k)
        .key("ssb-sort");
    let mut sort_menu = Menu::new("ssb-sort-menu")
        .trigger(sort_btn)
        .open(sort_open)
        .min_width(240.0)
        .on_close(|s: &mut Hooked| s.popup = None)
        .group_label("Group");
    for (key, label, hint) in [
        (
            "status",
            "By status",
            "Waiting, working, idle, snoozed, archived",
        ),
        ("project", "By project", "One folder per repository"),
        ("flat", "Flat", "A single list"),
    ] {
        sort_menu = sort_menu.item(
            MenuItem::new(label)
                .description(hint)
                .checked(s.layout == key)
                .on_select(move |s: &mut Hooked| {
                    s.layout = key.to_string();
                    s.popup = None;
                    s.save_pref("sidebarLayout", &key);
                }),
        );
    }
    sort_menu = sort_menu.separator().group_label("Sort");
    for (key, label, hint) in [
        ("dynamic", "Dynamic", "Awaiting you first, then most recent"),
        ("alpha", "Alphabetical", "Projects and sessions A→Z"),
        (
            "alpha-project",
            "Alphabetical (projects only)",
            "Project headers A→Z, sessions by activity",
        ),
    ] {
        if key == "alpha-project" && s.layout != "project" {
            continue;
        }
        sort_menu = sort_menu.item(
            MenuItem::new(label)
                .description(hint)
                .checked(s.sort_mode == key)
                .on_select(move |s: &mut Hooked| {
                    s.sort_mode = key.to_string();
                    s.popup = None;
                    s.save_pref("sortMode", &key);
                }),
        );
    }
    let head = head
        .child(filter_menu.build(k, layer))
        .child(sort_menu.build(k, layer))
        .child(collapse);
    let mut sb = Sidebar::new()
        .label("Sessions")
        .inset(8.0)
        .header_padding(10.0, 6.0)
        .row_gap(2.0)
        .header(head);
    if by_status {
        for (sec, units) in sections.iter().filter(|(x, _)| !x.docked()) {
            let sec = *sec;
            let folded = s.section_collapsed(sec);
            let body = section_body(s, sec, units, k, layer);
            let (rows, after) = if folded {
                (Vec::new(), body)
            } else {
                (body, Vec::new())
            };
            sb = sb.section(
                SidebarSection::new(sec.label())
                    .key(format!("sec-{}", sec.label()))
                    .count(units.len())
                    .collapsed(folded)
                    .on_toggle(move |s: &mut Hooked, _| s.toggle_section(sec))
                    .rows(rows),
            );
            for r in after {
                sb = sb.child(r);
            }
        }
        if !sections.iter().any(|(x, _)| !x.docked()) {
            sb = sb.child(
                text("No sessions.")
                    .font(k.ty.ui)
                    .color(k.c.text_faint)
                    .key("ssb-empty"),
            );
        }
        for (sec, units) in sections.iter().filter(|(x, _)| x.docked()) {
            sb = sb.footer(section_dock(s, *sec, units, k, layer));
        }
    } else if shown.is_empty() {
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
    } else if s.layout == "project" {
        let mut groups: BTreeMap<String, Vec<&Session>> = BTreeMap::new();
        let mut order = Vec::new();
        for x in &shown {
            let g = x.project_label();
            if !groups.contains_key(&g) {
                order.push(g.clone());
            }
            groups.entry(g).or_default().push(x);
        }
        if s.sort_mode != "dynamic" {
            order.sort_by_key(|g| g.to_lowercase());
        }
        for g in order {
            let rows = &groups[&g];
            let collapsed = s.collapsed.contains(&g);
            // A remote project's folder is on the other machine: its + opens an empty form.
            let project = rows[0].project.clone().filter(|_| rows[0].remote.is_none());
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
                    .rows({
                        let mut out = Vec::new();
                        for u in s.units(rows) {
                            out.extend(unit_rows(s, &u, k, layer));
                        }
                        out
                    }),
            );
        }
    } else {
        for u in s.units(&shown) {
            for r in unit_rows(s, &u, k, layer) {
                sb = sb.child(r);
            }
        }
    }
    if !by_status && (hidden_older > 0 || s.older_open && total > WINDOW) {
        let label = if s.older_open {
            "Show less".to_string()
        } else {
            format!(
                "{hidden_older} older session{}",
                if hidden_older == 1 { "" } else { "s" }
            )
        };
        sb = sb.child(
            Button::new(label)
                .icon(if s.older_open {
                    &icons::CHEVRON_DOWN
                } else {
                    &icons::PLUS
                })
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .on_press(|s: &mut Hooked| s.older_open = !s.older_open)
                .build(k)
                .key("ssb-older"),
        );
    }
    let menu_anchor = row_menu(s, k, layer);
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
                .child(sb.build(k))
                .child(menu_anchor),
        )
        .child(handle)
}

/// The right-click menu of a sidebar row, at the click.
fn row_menu(s: &Hooked, k: &Kit, layer: &mut Vec<El>) -> El {
    let Some((id, point)) = s.row_menu.clone() else {
        return el();
    };
    let Some(x) = s.session(&id) else { return el() };
    let grouped = s.group_of(&id).is_some();
    let leads = !grouped && s.group_members(&id).len() > 1;
    let archived = s.meta.get(&id).is_some_and(|m| m.archived);
    let incognito = s.meta.get(&id).is_some_and(|m| m.incognito);
    let pinned = s.is_pinned(&id);
    let i = |f: fn(&mut Hooked, &str)| {
        let id = id.clone();
        move |s: &mut Hooked| {
            s.row_menu = None;
            f(s, &id)
        }
    };
    let mut m = rune_kit::context_menu("ssb-row-menu", el().key("ssb-row-anchor"), Some(point))
        .min_width(220.0)
        .on_close(|s: &mut Hooked| s.row_menu = None)
        .item(MenuItem::new("Open").on_select(i(|s, id| s.open_session(id))))
        .item(
            MenuItem::new("Open in split")
                .icon(&icons::SPLIT)
                .on_select(i(|s, id| s.open_split(id.to_string()))),
        )
        .separator()
        .item(MenuItem::new("Rename…").on_select(i(|s, id| s.start_rename(id))))
        .item(
            MenuItem::new(if pinned { "Unpin" } else { "Pin to the top" })
                .icon(&icons::PIN)
                .checked(pinned)
                .on_select(i(|s, id| s.toggle_pin(id))),
        )
        .item(
            MenuItem::new("Edit tags…")
                .icon(&icons::TAG)
                .on_select(i(|s, id| s.open_tags(id.to_string()))),
        )
        .item(
            MenuItem::new(if s.snoozed_until(&id).is_some() {
                "Change the snooze…"
            } else {
                "Snooze…"
            })
            .icon(&icons::SNOOZE)
            .disabled(archived)
            .on_select(i(|s, id| s.snooze_menu = Some(id.to_string()))),
        )
        .item(
            MenuItem::new("Move to group…")
                .on_select(i(|s, id| s.open_group_picker(id.to_string()))),
        );
    if grouped {
        m = m.item(MenuItem::new("Leave the group").on_select(i(|s, id| {
            s.group_op("leave", id.to_string(), serde_json::json!({}))
        })));
    }
    if leads {
        let folded = s.folded_groups.contains(&id);
        m = m
            .item(
                MenuItem::new(if folded {
                    "Unfold the group"
                } else {
                    "Fold the group"
                })
                .on_select(i(|s, id| s.toggle_group_fold(id))),
            )
            .item(
                MenuItem::new("Rename the group…")
                    .on_select(i(|s, id| s.open_rename_group(id.to_string()))),
            );
    }
    m = m
        .item(
            MenuItem::new(if incognito {
                "Remove from incognito"
            } else {
                "Mark incognito"
            })
            .icon(if incognito {
                &icons::EYE
            } else {
                &icons::EYE_OFF
            })
            .on_select(i(|s, id| s.toggle_incognito(id))),
        )
        .separator()
        .item(
            MenuItem::new(if archived {
                "Unarchive"
            } else if x.live {
                "Stop and archive"
            } else {
                "Archive"
            })
            .icon(if archived {
                &icons::UNARCHIVE
            } else {
                &icons::ARCHIVE
            })
            .on_select(i(|s, id| s.toggle_archive(id))),
        );
    m.build(k, layer)
}

fn rail(s: &Hooked, k: &Kit) -> El {
    let mut listed: Vec<&Session> = s
        .sessions
        .iter()
        .filter(|x| !s.is_archived(x) && s.visible(x))
        .collect();
    if s.by_status() {
        let rank = |x: &&Session| {
            let sec = section_of(
                &[*x],
                |y| s.is_archived(y),
                |y| s.snoozed_until(&y.id).is_some(),
            );
            Section::ALL.iter().position(|z| *z == sec)
        };
        listed.sort_by_key(rank);
    }
    let tiles = listed.into_iter().take(30).map(|x| {
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
                .label(crate::fmt::keys("Expand sidebar (⌘B)"))
                .help(crate::fmt::keys("Expand sidebar (⌘B)"))
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

/// Markdown whose links open (see `app::open_link`).
pub fn md(src: impl Into<String>) -> rune_kit::Markdown {
    rune_kit::Markdown::new(src).on_link_tx(crate::app::open_link)
}

pub(super) fn floating(s: &Hooked, k: &Kit, key: &'static str, head: El, body: El) -> El {
    floating_sized(s, k, key, 760.0, (s.window_h * 0.7).max(320.0), None, head, body)
}

pub(super) fn floating_sized(
    s: &Hooked,
    k: &Kit,
    key: &'static str,
    w: f32,
    h: f32,
    frame: Option<Color>,
    head: El,
    body: El,
) -> El {
    const MARGIN: f32 = 16.0;
    let (w, h) = (w.min(s.window_w), h.min(s.window_h));
    let clamp = move |s: &Hooked, [r, b]: [f32; 2]| {
        [
            r.clamp(0.0, (s.window_w - w).max(0.0)),
            b.clamp(0.0, (s.window_h - h).max(0.0)),
        ]
    };
    let [right, bottom] = clamp(s, s.float_at.get(key).copied().unwrap_or([MARGIN; 2]));
    let head = head
        .cursor(Cursor::Move)
        .on_drag(move |s: &mut Hooked, d: &mut rune::Drag, _| {
            if d.phase == Phase::Down {
                s.float_grab = clamp(s, s.float_at.get(key).copied().unwrap_or([MARGIN; 2]));
            }
            let [r, b] = s.float_grab;
            let at = if d.cancelled() {
                s.float_grab
            } else {
                clamp(s, [r - d.dx, b - d.dy])
            };
            s.float_at.insert(key, at);
        });
    el().key(format!("{key}-layer"))
        .absolute(0.0, 0.0)
        .w_full()
        .h_full()
        .child(
            col()
                .key(key)
                .pin(None, None, Some(right), Some(bottom))
                .w(w)
                .h(h)
                .radius(k.radius.lg)
                .fill(k.c.bg_base)
                .border(frame.map_or(1.0, |_| 2.0), frame.unwrap_or(k.c.border_base))
                .box_shadows(&k.elevation.overlay)
                .child(head)
                .child(body),
        )
}

/// A dimmed full-window layer holding `content`, centred `top` points down. `content` is the
/// modal, not the scrim: Rune dismisses on a press outside the modal, so a full-window modal
/// would take every press and only Escape could close it.
pub(super) fn modal_scrim<S: 'static>(
    k: &Kit,
    key: &str,
    top: f32,
    content: El,
    dismiss: impl Fn(&mut S) + 'static,
) -> El {
    el().key(key.to_string())
        .absolute(0.0, 0.0)
        .w_full()
        .h_full()
        .fill(k.c.scrim)
        .items_center()
        .pt(top)
        .child(
            col()
                .items_center()
                .w_full()
                .child(content.modal(true, dismiss)),
        )
}

/// A command's output, following its end as it grows (a background job's, a Run's).
pub fn log_pane(k: &Kit, body: String, max_h: f32) -> El {
    col()
        .w_full()
        .max_h(max_h)
        .padding(8.0)
        .radius(k.radius.sm)
        .fill(k.c.layer_02)
        .scroll(rune::ScrollSpec { stick_bottom: true })
        .child(
            text(body)
                .font(k.ty.mono)
                .color(k.c.text_muted)
                .wrap_anywhere()
                .selectable(true),
        )
}

/// Markdown whose code blocks carry Copy, and Run for shell blocks of a session. `runs` are that
/// session's Runs by command (`Hooked::code_runs_in`): a block that ran shows its output under it.
pub fn md_code(
    src: impl Into<String>,
    k: &Kit,
    session: Option<String>,
    runs: BTreeMap<String, CodeRun>,
) -> rune_kit::Markdown {
    let k = k.clone();
    let src: String = src.into();
    let doc: std::rc::Rc<str> = src.as_str().into();
    md(src).code_frame(move |card, c| {
        let code = c.source.to_string();
        let lang = c.language.unwrap_or("").to_string();
        let query = matches!(lang.to_lowercase().as_str(), "promql" | "logql") && !c.open;
        let shell = matches!(
            lang.to_lowercase().as_str(),
            "sh" | "bash" | "shell" | "zsh"
        );
        let ran = runs.get(code.trim()).filter(|_| shell && !c.open).cloned();
        let mut bar = row()
            .w_full()
            .gap(4.0)
            .center_y()
            .child(
                text(lang.clone())
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_faint),
            )
            .child(el().grow(1.0));
        if let Some(id) = session
            .clone()
            .filter(|_| shell && !code.trim().is_empty() && !c.open)
        {
            let run = code.clone();
            let (label, icon) = match &ran {
                None => ("Run", &icons::TERMINAL),
                Some(r) if r.busy => ("Running…", &icons::TERMINAL),
                Some(r) if r.error.is_some() => ("Failed", &icons::CIRCLE_X),
                Some(_) => ("Ran", &icons::CIRCLE_CHECK),
            };
            let help = ran
                .as_ref()
                .and_then(|r| r.error.clone())
                .unwrap_or_else(|| {
                    "Run in the session folder; the agent gets the output and continues".into()
                });
            bar = bar.child(
                Button::new(label)
                    .icon(icon)
                    .variant(ButtonVariant::GhostMuted)
                    .control_size(ControlSize::Small)
                    .help(help)
                    .disabled(ran.as_ref().is_some_and(|r| r.busy))
                    .on_press(move |s: &mut Hooked| s.run_code(id.clone(), run.clone()))
                    .build(&k),
            );
        }
        if query {
            let spec = crate::querywin::fence_info(&doc, &code)
                .and_then(|info| crate::querywin::fence_query(&info, &code));
            bar = bar.child(
                Button::new("View")
                    .icon(&icons::CHART)
                    .variant(ButtonVariant::GhostMuted)
                    .control_size(ControlSize::Small)
                    .help(if spec.is_some() {
                        "Open a live chart of this query"
                    } else {
                        "Add datasource=… after the language to view it"
                    })
                    .disabled(spec.is_none())
                    .on_press(move |s: &mut Hooked| {
                        if let Some(spec) = spec.clone() {
                            s.open_query_spec(spec);
                        }
                    })
                    .build(&k),
            );
        }
        bar = bar.child(
            Button::new("Copy")
                .icon(&icons::COPY)
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .on_press_tx(move |s: &mut Hooked, tx| {
                    tx.copy(&code);
                    s.flash("✓ Copied", false);
                })
                .build(&k),
        );
        let frame = col()
            .key(format!("code-{}", c.index))
            .w_full()
            .gap(2.0)
            .child(bar)
            .child(card);
        match ran.filter(|r| r.pane) {
            Some(r) => {
                let body = match (r.shown.is_empty(), r.busy) {
                    (false, _) => r.shown,
                    (true, true) => "waiting for output…".into(),
                    (true, false) => "no output".into(),
                };
                // About eight lines, scrolling past that.
                frame.child(log_pane(&k, body, 8.0 * k.ty.mono.line_height + 16.0))
            }
            None => frame,
        }
    })
}

pub fn tag_font(k: &Kit) -> rune::TextStyle {
    let mut f = k.ty.text_xsmall_medium;
    f.size = 10.5;
    f.weight = 650.0;
    f.line_height = 17.0;
    f
}

pub fn tag_pill(s: &Hooked, k: &Kit, name: &str) -> El {
    let c = s.tag_color(k.dark, name);
    row()
        .h(17.0)
        .px(7.0)
        .center_y()
        .radius(8.5)
        .fill(c.alpha(0.14))
        .child(text(format!("#{name}")).font(tag_font(k)).color(c))
}

/// The mark of a session that runs on another hooked instance (`crate::remote`). One look
/// everywhere a session is listed or opened: a filled, square-cornered, uppercase label in the
/// remote hue, which no tag (soft round pill), state (dot) or project uses.
pub fn remote_badge(k: &Kit, r: &crate::remote::Instance) -> El {
    let ink = crate::theme::remote_ink(k.dark);
    let mut f = tag_font(k);
    f.weight = 700.0;
    row()
        .h(17.0)
        .px(6.0)
        .gap(4.0)
        .center_y()
        .radius(if crate::theme::sharp() { 0.0 } else { 4.0 })
        .fill(crate::theme::remote_color(k.dark))
        .help(format!("Remote session: runs on the hooked instance “{}” ({})", r.name, r.url))
        .child(glyph(&icons::GLOBE, 10.0, ink))
        .child(text(r.name.to_uppercase()).font(f).color(ink))
}

/// The wash behind a remote session's row, card or header; stronger when it is the selected one.
pub fn remote_wash(k: &Kit, strong: bool) -> Color {
    crate::theme::remote_color(k.dark).alpha(if strong { 0.22 } else { 0.08 })
}

/// The narrowest a right-hand column (the dock, the Review lens's rendered Markdown) gets.
pub const COLUMN_MIN_W: f32 = 240.0;

/// `w` clamped between [`COLUMN_MIN_W`] and 60% of the window, as [`column_grip`] keeps it.
pub fn column_width(s: &Hooked, w: f32) -> f32 {
    w.clamp(COLUMN_MIN_W, (s.window_w * 0.6).max(COLUMN_MIN_W))
}

/// The grip on a right-hand column's left edge: dragging it left widens the column, Escape puts
/// the width back, and the release saves it.
pub fn column_grip(
    key: &str,
    get: fn(&Hooked) -> f32,
    set: fn(&mut Hooked, f32),
    save: fn(&mut Hooked, f32),
) -> El {
    el().key(key.to_string())
        .w(6.0)
        .h_full()
        .cursor(Cursor::ResizeColumn)
        .help("Drag to resize")
        .on_drag(move |s: &mut Hooked, d: &mut rune::Drag, _| {
            if d.phase == Phase::Down {
                d.data = get(s);
            }
            if d.cancelled() {
                set(s, d.data);
                return;
            }
            let w = column_width(s, d.data - d.dx);
            set(s, w);
            if d.phase == Phase::Up {
                save(s, w);
            }
        })
}

#[cfg(test)]
mod tests {
    use rune::runtime::Runtime;
    use rune::{Cx, El, Env, col, el};

    struct Open(bool);

    fn view(s: &Open, _: &mut Cx<Open>) -> El {
        let k = crate::theme::kit(false);
        let panel = el().key("panel").size(200.0, 100.0);
        col().w_full().h_full().children(
            s.0.then(|| super::modal_scrim(&k, "modal", 60.0, panel, |s: &mut Open| s.0 = false)),
        )
    }

    fn press(rt: &mut Runtime<Open>, (x, y): (f32, f32)) {
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);
    }

    #[test]
    fn a_press_on_the_scrim_closes_the_modal_and_one_on_its_panel_does_not() {
        let mut rt = Runtime::new(Open(true), view, (800.0, 600.0), Env::new(false, 1.0));
        rt.frame(0.0);
        let inside = rt.find("panel").expect("the panel is drawn");
        press(&mut rt, inside);
        assert!(rt.state.0, "a press on the panel keeps it open");
        press(&mut rt, (10.0, 590.0));
        assert!(!rt.state.0, "a press on the scrim closes it");
    }
}
