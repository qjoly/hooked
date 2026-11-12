use rune::{Color, Cursor, El, Icon, Key, Tx, col, el, row, text};
use rune_kit::{Kit, TextInput};

use super::{Shadows, dot, glyph};
use crate::app::{Hooked, Lens, Page, Theme};
use crate::theme::{ColorScheme, Corners};
use crate::{fmt, icons};

const CITATIONS_SHOWN: usize = 5;

pub struct Cmd {
    pub label: String,
    pub section: &'static str,
    pub icon: &'static Icon,
    pub keys: &'static str,
    pub run: fn(&mut Hooked, &mut Tx),
}

pub enum Hit {
    Session(String),
    Cmd(Cmd),
    Citation { id: String, snippet: String },
    MoreCitations(usize),
}

fn cmd(
    section: &'static str,
    icon: &'static Icon,
    label: impl Into<String>,
    keys: &'static str,
    run: fn(&mut Hooked, &mut Tx),
) -> Cmd {
    Cmd {
        label: label.into(),
        section,
        icon,
        keys,
        run,
    }
}

pub fn commands(s: &Hooked) -> Vec<Cmd> {
    let nav = "Navigation";
    let mut out = vec![
        cmd(nav, &icons::DECK, "Go to Deck", "⌥1", |s, _| s.go_deck()),
        cmd(nav, &icons::LIST, "Go to Sessions", "⌥2", |s, _| {
            s.open_sessions()
        }),
        cmd(nav, &icons::PLUS, "New session", "⌘N", |s, _| {
            s.go_new(None)
        }),
        cmd(nav, &icons::CHART, "Go to Stats", "⌥4", |s, _| {
            s.go(Page::Stats)
        }),
        cmd(nav, &icons::BOOK, "Go to Digest", "⌥5", |s, _| {
            s.go(Page::Digest)
        }),
        cmd(nav, &icons::BRAIN, "Go to Memory", "⌥6", |s, _| {
            s.go(Page::Memory)
        }),
        cmd(nav, &icons::GITHUB, "Go to GitHub", "⌥7", |s, _| {
            s.go(Page::GitHub)
        }),
        cmd(nav, &icons::ZAP, "Go to Skills", "", |s, _| {
            s.go(Page::Skills)
        }),
        cmd(nav, &icons::CLOCK, "Go to Cron", "", |s, _| {
            s.go(Page::Cron)
        }),
        cmd(nav, &icons::BOOK, "Go to Prompts", "", |s, _| {
            s.go(Page::Prompts)
        }),
        cmd(nav, &icons::GEAR, "Go to Settings", "⌘,", |s, _| {
            s.go(Page::Settings)
        }),
        cmd("Appearance", &icons::SUN, "Theme: Light", "", |s, _| {
            s.set_theme(Theme::Light)
        }),
        cmd("Appearance", &icons::MOON, "Theme: Dark", "", |s, _| {
            s.set_theme(Theme::Dark)
        }),
        cmd(
            "Appearance",
            &icons::MONITOR,
            "Theme: System",
            "",
            |s, _| s.set_theme(Theme::System),
        ),
        cmd(
            "Appearance",
            &icons::SUN,
            "Cycle theme",
            "⌘⇧T",
            |s, _| s.cycle_theme(),
        ),
        cmd("Appearance", &icons::CIRCLE, "Color scheme: Coffee", "", |s, _| {
            s.set_scheme(ColorScheme::Coffee)
        }),
        cmd("Appearance", &icons::CIRCLE, "Color scheme: Indigo", "", |s, _| {
            s.set_scheme(ColorScheme::Indigo)
        }),
        cmd("Appearance", &icons::CIRCLE, "Color scheme: Legacy", "", |s, _| {
            s.set_scheme(ColorScheme::Legacy)
        }),
        cmd("Appearance", &icons::CIRCLE, "Color scheme: Datadog", "", |s, _| {
            s.set_scheme(ColorScheme::Datadog)
        }),
        cmd("Appearance", &icons::CIRCLE, "Color scheme: Gruvbox", "", |s, _| {
            s.set_scheme(ColorScheme::Gruvbox)
        }),
        cmd("Appearance", &icons::CIRCLE, "Color scheme: Claude", "", |s, _| {
            s.set_scheme(ColorScheme::Claude)
        }),
        cmd("Appearance", &icons::CIRCLE, "Corners: Rounded", "", |s, _| {
            s.set_corners(Corners::Round)
        }),
        cmd("Appearance", &icons::CIRCLE, "Corners: Square", "", |s, _| {
            s.set_corners(Corners::Sharp)
        }),
    ];
    #[cfg(feature = "knobs")]
    out.push(cmd(
        "Appearance",
        &icons::SLIDERS,
        if s.knobs.open {
            "Close the knobs panel"
        } else {
            "Open the knobs panel (tune layout and motion)"
        },
        "⌘⇧K",
        |s, tx| {
            s.knobs.toggle();
            tx.motion(s.knobs.slide());
        },
    ));
    let act = "Actions";
    out.extend([
        cmd(
            act,
            &icons::SIDEBAR,
            if s.focus {
                "Exit focus mode"
            } else {
                "Enter focus mode"
            },
            "⌘⇧F",
            |s, _| s.focus = !s.focus,
        ),
        cmd(
            act,
            &icons::SIDEBAR,
            "Toggle the sidebar",
            "⌘B",
            |s, _| s.toggle_sidebar(),
        ),
        cmd(
            act,
            &icons::PANEL_RIGHT,
            "Toggle the context panel",
            "⌘⇧D",
            |s, _| s.toggle_dock(),
        ),
        cmd(
            act,
            if s.incognito {
                &icons::EYE
            } else {
                &icons::EYE_OFF
            },
            if s.incognito {
                "Leave incognito mode"
            } else {
                "Enter incognito mode (hide every other session)"
            },
            "",
            |s, _| s.toggle_incognito_mode(),
        ),
        cmd(
            act,
            if s.notify {
                &icons::BELL_OFF
            } else {
                &icons::BELL
            },
            if s.notify {
                "Disable notifications"
            } else {
                "Enable notifications"
            },
            "",
            |s, _| {
                s.notify = !s.notify;
                let n = s.notify;
                s.save_pref("notify", &n);
            },
        ),
        cmd(act, &icons::TRASH, "Open trash", "", |s, _| s.open_trash()),
        cmd(
            act,
            &icons::TOOL,
            if s.all_tools_open {
                "Tool details: collapse all"
            } else {
                "Tool details: expand all"
            },
            "",
            |s, _| s.all_tools_open = !s.all_tools_open,
        ),
        cmd(
            act,
            &icons::DIFF,
            if s.lens_data.diff.mode() == rune_kit::diff::DiffMode::Split {
                "Diff: switch to unified"
            } else {
                "Diff: switch to split"
            },
            "",
            |s, _| {
                let next = if s.lens_data.diff.mode() == rune_kit::diff::DiffMode::Split {
                    rune_kit::diff::DiffMode::Unified
                } else {
                    rune_kit::diff::DiffMode::Split
                };
                s.lens_data.diff.set_mode(next);
            },
        ),
        cmd(
            act,
            &icons::RESTART,
            "Force resync all sessions",
            "",
            |s, _| s.resync_states(),
        ),
    ]);
    let Some(x) = s
        .selected
        .as_deref()
        .and_then(|id| s.session(id))
        .filter(|_| s.page == Page::Session)
    else {
        return out;
    };
    let cur = "Current session";
    out.extend([
        cmd(cur, &icons::CONVERSE, "Lens: Converse", "1", |s, _| {
            s.lens = Lens::Converse
        }),
        cmd(
            cur,
            &icons::TERMINAL,
            "Toggle the terminal",
            "⌘J",
            |s, _| s.toggle_terms(),
        ),
        cmd(
            cur,
            &icons::PANEL_RIGHT,
            "Terminal beside or below the conversation",
            "",
            |s, _| s.toggle_term_side(),
        ),
        cmd(cur, &icons::TERMINAL, "New terminal", "⌘⇧J", |s, _| {
            s.term.open = true;
            s.new_term();
        }),
        cmd(cur, &icons::SHIP, "Lens: Review", "3", |s, _| {
            s.lens = Lens::Review
        }),
        cmd(cur, &icons::PLUG, "Lens: MCP", "4", |s, _| {
            s.lens = Lens::Mcp
        }),
        cmd(cur, &icons::ACTIVITY, "Lens: Trace", "5", |s, _| {
            s.lens = Lens::Trace
        }),
        cmd(
            cur,
            &icons::SPLIT,
            "Split with the most recent session",
            "⌘⇧S",
            |s, _| s.toggle_split(),
        ),
        cmd(
            cur,
            &icons::COPY,
            format!("Copy project path: {}", x.project_label()),
            "",
            |s, tx| {
                if let Some(cwd) = s
                    .selected
                    .as_deref()
                    .and_then(|id| s.session(id))
                    .and_then(|x| x.project.clone())
                {
                    tx.copy(&cwd);
                    s.flash("✓ Path copied", false);
                }
            },
        ),
        cmd(
            cur,
            &icons::CODE,
            "Open the project in the editor",
            "",
            |s, _| s.open_editor(),
        ),
        cmd(cur, &icons::TERMINAL, "Open in Ghostty", "", |s, _| {
            s.open_ghostty()
        }),
    ]);
    if x.state == "working" {
        out.push(cmd(
            cur,
            &icons::STOP,
            "Interrupt the session",
            "Esc",
            |s, _| s.interrupt(),
        ));
    }
    let archived = s.is_archived(x);
    out.push(cmd(
        cur,
        if archived {
            &icons::UNARCHIVE
        } else {
            &icons::ARCHIVE
        },
        if archived {
            "Unarchive the session"
        } else {
            "Archive the session"
        },
        "",
        |s, _| {
            if let Some(id) = s.selected.clone() {
                s.toggle_archive(&id);
            }
        },
    ));
    out
}

pub fn hits(s: &Hooked) -> Vec<Hit> {
    let raw = s.palette_query.text.trim();
    let only_commands = raw.starts_with('>');
    let q = raw.trim_start_matches('>').trim().to_lowercase();
    let mut out = Vec::new();
    let matches = |label: &str| {
        q.split_whitespace()
            .all(|w| label.to_lowercase().contains(w))
    };
    let cmds = commands(s);
    if only_commands {
        out.extend(
            cmds.into_iter()
                .filter(|c| matches(&format!("{} {}", c.label, c.section)))
                .map(Hit::Cmd),
        );
        return out;
    }
    if q.is_empty() {
        out.extend(
            cmds.into_iter()
                .filter(|c| c.label == "New session")
                .map(Hit::Cmd),
        );
    } else {
        out.extend(cmds.into_iter().filter(|c| matches(&c.label)).map(Hit::Cmd));
    }
    let mut sessions = 0;
    for x in s.sessions.iter().filter(|x| s.visible(x)) {
        let hay = format!(
            "{} {} {}",
            s.title_of(x),
            x.project_label(),
            x.last_prompt.clone().unwrap_or_default()
        );
        if q.is_empty() || matches(&hay) {
            out.push(Hit::Session(x.id.clone()));
            sessions += 1;
        }
        if sessions >= 40 {
            break;
        }
    }
    if !q.is_empty() && s.palette_cites_for == raw {
        let pool: Vec<&serde_json::Value> = s
            .palette_cites
            .iter()
            .filter(|h| {
                !s.incognito
                    || h["sessionId"]
                        .as_str()
                        .is_some_and(|id| s.session(id).is_some())
            })
            .collect();
        let shown = if s.palette_all_cites {
            pool.len()
        } else {
            CITATIONS_SHOWN.min(pool.len())
        };
        for h in &pool[..shown] {
            out.push(Hit::Citation {
                id: h["sessionId"].as_str().unwrap_or("").to_string(),
                snippet: h["snippet"].as_str().unwrap_or("").to_string(),
            });
        }
        if pool.len() > shown {
            out.push(Hit::MoreCitations(pool.len() - shown));
        }
    }
    out
}

pub fn run(s: &mut Hooked, index: usize, tx: &mut Tx) {
    let mut list = hits(s);
    if index >= list.len() {
        return;
    }
    let h = list.swap_remove(index);
    if let Hit::MoreCitations(_) = h {
        s.palette_all_cites = true;
        return;
    }
    s.palette_open = false;
    match h {
        Hit::Session(id) | Hit::Citation { id, .. } => s.open_session(&id),
        Hit::Cmd(c) => (c.run)(s, tx),
        Hit::MoreCitations(_) => {}
    }
}

/// The keys a command's default hint names, as the user has bound them now (Settings → shortcuts).
fn live_keys(s: &Hooked, hint: &str) -> String {
    let id = match hint {
        "⌥1" => "go-sessions",
        "⌥2" => "go-board",
        "⌥4" => "go-stats",
        "⌥5" => "go-digest",
        "⌥6" => "go-memory",
        "⌥7" => "go-github",
        "⌘N" => "new-session",
        "⌘," => "settings",
        "⌘⇧T" => "theme-cycle",
        "⌘⇧F" => "focus-mode",
        "⌘B" => "toggle-sidebar",
        "⌘⇧D" => "toggle-dock",
        "⌘J" => "open-terminal",
        "⌘⇧J" => "new-terminal",
        "⌘⇧S" => "split-session",
        _ => return hint.to_string(),
    };
    match s.shortcuts.get(id).and_then(|r| r.shortcut()) {
        Some(sc) => sc.keycaps().concat(),
        None => String::new(),
    }
}

fn snippet_line(s: &str) -> String {
    let flat = s.replace("<mark>", "").replace("</mark>", "");
    fmt::first_line(&flat.split_whitespace().collect::<Vec<_>>().join(" "), 140)
}

fn row_for(s: &Hooked, k: &Kit, h: &Hit) -> (El, String, String) {
    let muted = k.c.icon_muted;
    match h {
        Hit::Session(id) => {
            let x = s.session(id);
            (
                dot(k, x.map_or("idle", |x| x.state.as_str()), 7.0),
                x.map(|x| s.title_of(x)).unwrap_or_default(),
                x.map(|x| {
                    format!(
                        "{} · {}",
                        x.project_label(),
                        fmt::ago_short(x.last_activity.as_deref(), s.now)
                    )
                })
                .unwrap_or_default(),
            )
        }
        Hit::Cmd(c) => (
            glyph(c.icon, 13.0, muted),
            c.label.clone(),
            if c.keys.is_empty() {
                c.section.to_string()
            } else {
                live_keys(s, c.keys)
            },
        ),
        Hit::Citation { id, snippet } => (
            glyph(&icons::SEARCH, 13.0, muted),
            snippet_line(snippet),
            s.session(id)
                .map(|x| s.title_of(x))
                .unwrap_or_else(|| id.chars().take(8).collect()),
        ),
        Hit::MoreCitations(n) => (
            glyph(&icons::CHEVRON_DOWN, 13.0, muted),
            format!("Show {n} more"),
            "Citations".to_string(),
        ),
    }
}

pub fn view(s: &Hooked, k: &Kit) -> El {
    let list = hits(s);
    let sel = s.palette_index.min(list.len().saturating_sub(1));
    let start = sel.saturating_sub(11);
    let raw = s.palette_query.text.trim();
    let searching = s.palette_cites_for != raw && !raw.is_empty() && !raw.starts_with('>');
    let rows = list.iter().enumerate().skip(start).take(12).map(|(i, h)| {
        let (lead, label, detail) = row_for(s, k, h);
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
                    text(label)
                        .font(k.ty.ui)
                        .color(k.c.text_base)
                        .truncate()
                        .grow(1.0)
                        .min_w(0.0),
                )
                .child(
                    text(detail)
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint)
                        .truncate()
                        .max_w(220.0),
                ),
        )
        .on_press_tx(move |s: &mut Hooked, tx| run(s, i, tx))
    });
    let footer = text(if searching {
        "Searching transcripts…"
    } else {
        "↑↓ to move · Enter to run · start with > for commands only"
    })
    .font(k.ty.text_xsmall)
    .color(k.c.text_faint);
    let panel = col()
        .key("palette")
        .w(620.0)
        .max_h(560.0)
        .padding(8.0)
        .gap(6.0)
        .radius(k.radius.lg)
        .fill(k.c.bg_base)
        .border(1.0, k.c.border_base)
        .box_shadows(&k.elevation.overlay)
        .child(
            TextInput::new(&s.palette_query)
                .placeholder("Search sessions and transcripts, > for commands…")
                .leading_icon(&icons::SEARCH)
                .large()
                .width(None)
                .on_edit(|s: &mut Hooked| &mut s.palette_query)
                .on_change(|s: &mut Hooked, _| s.palette_changed())
                .on_key(|s: &mut Hooked, ev: &rune::KeyEvent, tx| match ev.key {
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
                        run(s, i, tx);
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
        .child(col().key("palette-list").w_full().gap(2.0).children(rows))
        .child(row().px(8.0).pt(2.0).child(footer));
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
