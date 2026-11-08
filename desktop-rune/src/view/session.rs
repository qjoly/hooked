use std::hash::{Hash, Hasher};

use rune::{Color, Cursor, El, Key, ScrollSpec, col, el, memo, row, text};
use rune_kit::{
    Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant, Kit, Markdown, Menu,
    MenuItem, Spinner, TextArea, TextInput,
};

use super::{Shadows, dot, glyph, pill, state_color};
use crate::api::{Detail, Message, Part, PendingPlan, PendingQuestion, Tool};
use crate::app::{Hooked, Lens, Popup};
use crate::{fmt, icons};

pub fn view(s: &Hooked, k: &Kit, layer: &mut Vec<El>) -> El {
    let Some(d) = s.detail.as_ref() else {
        let msg = if s.detail_loading || s.selected.is_some() {
            "Loading…"
        } else {
            "Pick a session in the sidebar."
        };
        return col()
            .key("detail-empty")
            .w_full()
            .h_full()
            .center()
            .child(text(msg).font(k.ty.body).color(k.c.text_faint));
    };
    let body = match s.lens {
        Lens::Converse => converse(s, d, k),
        Lens::Review => super::lenses::review(s, d, k),
        Lens::Mcp => super::lenses::mcp(s, d, k),
        Lens::Trace => super::lenses::trace(s, k),
    };
    col()
        .key("detail")
        .w_full()
        .h_full()
        .child(head(s, d, k, layer))
        .child(lenses(s, d, k))
        .child(
            col()
                .key("lens-body")
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .child(body),
        )
}

fn head(s: &Hooked, d: &Detail, k: &Kit, layer: &mut Vec<El>) -> El {
    let x = &d.session;
    let state_txt = if x.state == "working" {
        format!(
            "{}…",
            x.activity.clone().unwrap_or_else(|| "Working".into())
        )
    } else {
        fmt::state_label(&x.state).to_string()
    };
    let sc = state_color(k, &x.state);
    let mut meta = row().gap(5.0).center_y().child(
        text(x.project_label())
            .font(k.ty.ui)
            .color(k.c.text_muted)
            .truncate(),
    );
    if let Some(b) = x.git_branch.as_ref().filter(|b| !b.is_empty()) {
        meta = meta
            .child(text("·").font(k.ty.ui).color(k.c.text_faint))
            .child(glyph(&icons::GIT_BRANCH, 12.0, k.c.icon_faint))
            .child(text(b.clone()).font(k.ty.ui).color(k.c.text_muted));
    }
    let left = row()
        .key("head-left")
        .grow(1.0)
        .shrink()
        .gap(10.0)
        .center_y()
        .child(
            IconButton::new(&icons::ARROW_LEFT)
                .variant(IconButtonVariant::GhostMuted)
                .label("Back to the Deck")
                .help("Back to the Deck")
                .on_press(|s: &mut Hooked| s.go_deck())
                .build(k)
                .key("pane-back"),
        )
        .child(
            text(x.display_title())
                .font(k.ty.body_medium)
                .color(k.c.text_base)
                .truncate()
                .shrink()
                .key("sess-name"),
        )
        .child(meta.shrink().key("head-meta"))
        .child(
            row()
                .key("state-badge")
                .shrink()
                .h(22.0)
                .px(8.0)
                .gap(6.0)
                .center_y()
                .radius(11.0)
                .fill(k.c.layer_02)
                .child(el().size(7.0, 7.0).radius(3.5).fill(sc))
                .child(
                    text(state_txt)
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.text_muted)
                        .truncate(),
                ),
        );
    let mut line = row().key("head-right").gap(10.0).center_y();
    if let Some(pct) = d.context.as_ref().and_then(|c| c.pct) {
        let p = pct.clamp(0.0, 100.0) as f32;
        let fill = if p >= 90.0 {
            k.c.danger.icon
        } else if p >= 75.0 {
            k.c.warning.icon
        } else {
            k.c.icon_muted
        };
        line = line.child(
            row()
                .key("ctx-gauge")
                .gap(6.0)
                .center_y()
                .help("Context window fill")
                .child(
                    text("CTX")
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.text_faint),
                )
                .child(
                    el().w(48.0)
                        .h(4.0)
                        .radius(2.0)
                        .fill(k.c.layer_03)
                        .child(el().w(48.0 * p / 100.0).h(4.0).radius(2.0).fill(fill)),
                )
                .child(
                    text(format!("{pct:.0}%"))
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.text_muted),
                ),
        );
    }
    if let Some(c) = x.cache.as_ref() {
        let left = fmt::cache_left(c.last_request_at.as_deref(), c.ttl.as_deref(), s.now);
        let (label, color) = match left {
            Some(ms) => (format!("⚡ warm {}", fmt::span(ms, " ")), k.c.success.fg),
            None => ("cold cache".to_string(), k.c.text_faint),
        };
        line = line.child(
            text(label)
                .font(k.ty.text_xsmall_medium)
                .color(color)
                .help("Prompt cache: replying while warm re-reads the conversation at the cached rate")
                .key("cache-badge"),
        );
    }
    if !x.live {
        line = line.child(
            Button::new("Resume")
                .icon(&icons::PLAY)
                .variant(ButtonVariant::Neutral)
                .control_size(ControlSize::Regular)
                .help("Re-run claude --resume, driven by hooked")
                .on_press(|s: &mut Hooked| s.resume())
                .build(k)
                .key("resume-btn"),
        );
    }
    let archived = s.meta.get(&x.id).is_some_and(|m| m.archived);
    let aid = x.id.clone();
    line = line.child(
        IconButton::new(if archived {
            &icons::UNARCHIVE
        } else {
            &icons::ARCHIVE
        })
        .variant(IconButtonVariant::GhostMuted)
        .label(if archived { "Restore" } else { "Archive" })
        .help(if archived {
            "Restore this session to the live fleet"
        } else if x.live {
            "Archive: stop the running session and move it to Archived"
        } else {
            "Archive: move this session to Archived"
        })
        .on_press(move |s: &mut Hooked| s.toggle_archive(&aid))
        .build(k)
        .key("archive-btn"),
    );
    line = line.child(
        IconButton::new(if s.dock_open {
            &icons::PANEL_RIGHT
        } else {
            &icons::SIDEBAR
        })
        .variant(IconButtonVariant::GhostMuted)
        .label("Toggle the context panel")
        .help("Context panel")
        .expanded(s.dock_open)
        .on_press(|s: &mut Hooked| {
            s.dock_open = !s.dock_open;
            let v = s.dock_open;
            s.save_pref("dockOpen", &v);
        })
        .build(k)
        .key("dock-toggle"),
    );
    let right = line.child(more_menu(s, d, k, layer));
    row()
        .key("head-line")
        .w_full()
        .h(44.0)
        .px(14.0)
        .gap(12.0)
        .center_y()
        .child(left)
        .child(right)
}

fn more_menu(s: &Hooked, d: &Detail, k: &Kit, layer: &mut Vec<El>) -> El {
    let x = &d.session;
    let open = s.popup == Some(Popup::More);
    let trigger = IconButton::new(&icons::MORE)
        .variant(IconButtonVariant::GhostMuted)
        .label("More actions")
        .help("More actions")
        .expanded(open)
        .on_press(|s: &mut Hooked| {
            s.popup = if s.popup == Some(Popup::More) {
                None
            } else {
                Some(Popup::More)
            }
        })
        .build(k)
        .key("hdr-more");
    let mode = d
        .permission_mode
        .clone()
        .unwrap_or_else(|| "default".into());
    let mut m = Menu::new("hdr-menu")
        .trigger(trigger)
        .open(open)
        .min_width(280.0)
        .on_close(|s: &mut Hooked| s.popup = None);
    if x.live {
        let current = x.model.clone().unwrap_or_default();
        let models: Vec<_> = s
            .caps
            .models
            .iter()
            .map(|(id, label)| {
                let id = id.clone();
                MenuItem::new(label.clone())
                    .checked(current.contains(id.trim_start_matches("claude-")))
                    .on_select(move |s: &mut Hooked| {
                        let effort = s.detail.as_ref().and_then(|d| d.session.effort.clone());
                        let force = s
                            .held_switch
                            .as_ref()
                            .is_some_and(|(m, _)| m.as_deref() == Some(id.as_str()));
                        s.held_switch = None;
                        s.set_model(Some(id.clone()), effort, force);
                    })
            })
            .collect();
        let effort_now = x.effort.clone().unwrap_or_default();
        let efforts: Vec<_> = s
            .caps
            .efforts
            .iter()
            .map(|e| {
                let e = e.clone();
                MenuItem::new(e.clone())
                    .checked(effort_now == e)
                    .on_select(move |s: &mut Hooked| s.set_model(None, Some(e.clone()), false))
            })
            .map(rune_kit::MenuEntry::item)
            .collect();
        m = m
            .group_label(format!("Model · {}", fmt::short_model(&current)))
            .item(
                MenuItem::new("Model")
                    .badge(fmt::short_model(&current))
                    .submenu(
                        models.into_iter().map(rune_kit::MenuEntry::item).collect(),
                        s.popup == Some(Popup::Model),
                    )
                    .on_select(|s: &mut Hooked| s.popup = Some(Popup::Model)),
            )
            .item(
                MenuItem::new("Effort")
                    .badge(effort_now.clone())
                    .submenu(efforts, s.popup == Some(Popup::Effort))
                    .on_select(|s: &mut Hooked| s.popup = Some(Popup::Effort)),
            )
            .separator()
            .group_label("Permission mode");
        for md in fmt::LIVE_MODES {
            m = m.item(
                MenuItem::new(fmt::mode_label(md))
                    .checked(mode == md)
                    .on_select(move |s: &mut Hooked| s.set_mode(md)),
            );
        }
        m = m
            .item(
                MenuItem::new(format!(
                    "Auto-approve · {}",
                    if d.auto_approve { "on" } else { "off" }
                ))
                .checked(d.auto_approve)
                .description("Allow tool permission requests without asking")
                .on_select(|s: &mut Hooked| s.toggle_auto_approve()),
            )
            .separator();
    }
    let resume_cmd = format!(
        "cd {} && claude --resume {}",
        x.project.clone().unwrap_or_default(),
        x.id
    );
    let link = format!("{}/session/{}", crate::api::base(), x.id);
    m.item(MenuItem::new(format!("Cost · {}", fmt::cost(x.cost))).disabled(true))
        .separator()
        .item(
            MenuItem::new("Open in editor")
                .icon(&icons::CODE)
                .on_select(|s: &mut Hooked| s.open_editor()),
        )
        .item(
            MenuItem::new("Open in the web dashboard")
                .icon(&icons::LINK)
                .on_select_tx(move |s: &mut Hooked, tx| {
                    s.popup = None;
                    let _ = tx.open_url(&link);
                }),
        )
        .item(
            MenuItem::new("Copy resume command")
                .icon(&icons::COPY)
                .on_select_tx(move |s: &mut Hooked, tx| {
                    s.popup = None;
                    tx.copy(&resume_cmd);
                    s.flash("✓ Copied", false);
                }),
        )
        .item(
            MenuItem::new(if s.all_tools_open {
                "Collapse tool calls"
            } else {
                "Expand tool calls"
            })
            .icon(&icons::TOOL)
            .on_select(|s: &mut Hooked| {
                s.all_tools_open = !s.all_tools_open;
                s.popup = None;
            }),
        )
        .separator()
        .item(
            MenuItem::new("Restart Claude")
                .icon(&icons::RESTART)
                .description("Stop the process and resume it from its transcript")
                .on_select(|s: &mut Hooked| s.restart()),
        )
        .item(
            MenuItem::new("Move to trash")
                .icon(&icons::TRASH)
                .danger(true)
                .on_select(|s: &mut Hooked| s.delete()),
        )
        .build(k, layer)
}

fn lenses(s: &Hooked, d: &Detail, k: &Kit) -> El {
    let tab = |key: &'static str,
               i: &'static rune::Icon,
               label: &'static str,
               kbd: &'static str,
               count: usize,
               lens: Lens| {
        let on = s.lens == lens;
        let mut r = row()
            .key(key)
            .role("tab")
            .label(label)
            .checked(on)
            .h(32.0)
            .px(10.0)
            .gap(6.0)
            .center_y()
            .cursor(Cursor::Pointer)
            .border_sides(
                [0.0, 0.0, 2.0, 0.0],
                if on {
                    k.c.text_base
                } else {
                    Color::TRANSPARENT
                },
            )
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
        if count > 0 {
            r = r.child(
                text(count.to_string())
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_faint),
            );
        }
        let key_cap = row()
            .h(16.0)
            .px(4.0)
            .center()
            .radius(3.0)
            .border(1.0, k.c.border_weak)
            .child(text(kbd).font(k.ty.text_xsmall).color(k.c.text_faint));
        r.child(key_cap)
            .help(format!("{label} — key {kbd}"))
            .on_press(move |s: &mut Hooked| s.lens = lens)
    };
    row()
        .key("lenses")
        .w_full()
        .px(14.0)
        .gap(4.0)
        .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_weak)
        .child(tab(
            "lens-chat",
            &icons::CONVERSE,
            "Converse",
            "1",
            d.messages.len(),
            Lens::Converse,
        ))
        .child(tab(
            "lens-review",
            &icons::SHIP,
            "Review",
            "3",
            d.changes.len(),
            Lens::Review,
        ))
        .child(tab("lens-mcp", &icons::PLUG, "MCP", "4", 0, Lens::Mcp))
        .child(tab(
            "lens-trace",
            &icons::ACTIVITY,
            "Trace",
            "5",
            0,
            Lens::Trace,
        ))
}

fn hash_of(v: impl Hash) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    v.hash(&mut h);
    h.finish()
}

fn converse(s: &Hooked, d: &Detail, k: &Kit) -> El {
    let n = d.messages.len();
    let start = n.saturating_sub(s.visible);
    let mut chat = col()
        .key("chat")
        .w_full()
        .max_w(920.0)
        .self_center()
        .px(20.0)
        .py(16.0)
        .gap(14.0);
    if start > 0 {
        chat = chat.child(
            Button::new(format!("Show earlier messages · {start} hidden"))
                .icon(&icons::ARROW_UP)
                .variant(ButtonVariant::GhostMuted)
                .on_press(|s: &mut Hooked| s.show_earlier())
                .build(k)
                .key("show-earlier"),
        );
    }
    if n == 0 && s.queued.is_empty() {
        chat = chat.child(
            text("Empty conversation.")
                .font(k.ty.body)
                .color(k.c.text_faint)
                .key("chat-empty"),
        );
    }
    for (i, m) in d.messages.iter().enumerate().skip(start) {
        let open_ids: Vec<String> = m
            .render_parts()
            .into_iter()
            .filter_map(|p| if let Part::Tool(t) = p { t.id } else { None })
            .filter(|id| s.tools_open.contains(id))
            .collect();
        let version = hash_of((
            &m.text,
            m.tools.len(),
            m.ts.as_deref(),
            k.dark,
            s.all_tools_open,
            open_ids,
        ));
        chat = chat.child(memo(format!("msg-{}-{i}", d.session.id), version, || {
            bubble(s, m, k, i)
        }));
    }
    for (i, q) in s.queued.iter().enumerate() {
        chat = chat.child(
            col()
                .key(format!("queued-{i}"))
                .w_full()
                .gap(6.0)
                .padding(12.0)
                .radius(k.radius.lg)
                .fill(k.c.layer_01)
                .border(1.0, k.c.border_weak)
                .child(who(k, true, "queued"))
                .child(text(q.clone()).font(k.ty.body).color(k.c.text_muted).wrap()),
        );
    }
    if let Some(lead) = d.pending_lead_in.as_ref().filter(|t| !t.trim().is_empty()) {
        chat = chat.child(
            col()
                .key("leadin")
                .w_full()
                .gap(6.0)
                .child(who(k, false, "live stream"))
                .child(Markdown::new(lead.clone()).streaming(true).build(k)),
        );
    } else if let Some(l) = s
        .live
        .as_ref()
        .filter(|l| !l.text.is_empty() || !l.thinking.is_empty())
    {
        let mut b = col()
            .key("streaming")
            .w_full()
            .gap(6.0)
            .child(who(k, false, "live"));
        if !l.thinking.is_empty() {
            b = b.child(
                text(fmt::first_line(&l.thinking, 400))
                    .font(k.ty.text_small)
                    .color(k.c.text_faint)
                    .wrap(),
            );
        }
        if !l.text.is_empty() {
            b = b.child(Markdown::new(l.text.clone()).streaming(true).build(k));
        }
        chat = chat.child(b);
    }
    let busy = d.session.state == "working" || s.live.as_ref().is_some_and(|l| l.busy);
    if busy {
        let verb = s
            .live
            .as_ref()
            .and_then(|l| l.tool.clone())
            .or_else(|| d.session.activity.clone())
            .unwrap_or_else(|| "Working".into());
        let elapsed = s.working_since.map(|t| {
            let sec = ((s.now - t) / 1000).max(0);
            if sec < 60 {
                format!("{sec}s")
            } else {
                format!("{}m{}s", sec / 60, sec % 60)
            }
        });
        let mut w = row()
            .key("working-live")
            .gap(8.0)
            .center_y()
            .child(Spinner::new().build(k))
            .child(
                text(format!("{verb}…"))
                    .font(k.ty.ui_medium)
                    .color(k.c.text_muted),
            );
        if let Some(e) = elapsed {
            w = w.child(text(format!("· {e}")).font(k.ty.ui).color(k.c.text_faint));
        }
        chat = chat.child(w);
    }
    let scroller = col()
        .key("transcript")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .scroll(ScrollSpec { stick_bottom: true })
        .scroll_edge_fade(12.0)
        .child(chat);
    let mut out = col().key("converse").w_full().h_full().child(scroller);
    if let Some(q) = d.pending_question.as_ref() {
        out = out.child(question(s, q, k));
    }
    if let Some(p) = d.pending_plan.as_ref() {
        out = out.child(plan(s, p, k));
    }
    if d.session.live {
        out = out.child(composer(s, d, k, busy));
    } else {
        out = out.child(
            row()
                .key("resume-bar")
                .w_full()
                .px(20.0)
                .py(12.0)
                .gap(10.0)
                .center_y()
                .border_sides([1.0, 0.0, 0.0, 0.0], k.c.border_weak)
                .child(text("This session is not running. Send a message to resume it, or press Resume.").font(k.ty.ui).color(k.c.text_muted).grow(1.0))
                .child(composer_field(s, k, "Message to resume with…"))
                .child(send_button(s, k)),
        );
    }
    out
}

fn who(k: &Kit, user: bool, extra: &str) -> El {
    let mut r = row()
        .gap(6.0)
        .center_y()
        .child(glyph(
            if user { &icons::USER } else { &icons::BOT },
            13.0,
            k.c.icon_muted,
        ))
        .child(
            text(if user { "You" } else { "Claude" })
                .font(k.ty.text_small_medium)
                .color(k.c.text_muted),
        );
    if !extra.is_empty() {
        r = r.child(
            text(extra.to_string())
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        );
    }
    r
}

fn bubble(s: &Hooked, m: &Message, k: &Kit, i: usize) -> El {
    let user = m.role == "user";
    if m.role == "system" {
        return row()
            .key(format!("sys-{i}"))
            .w_full()
            .justify_center()
            .child(
                text(fmt::first_line(&m.text, 160))
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_faint),
            );
    }
    let ts =
        m.ts.as_deref()
            .map(|t| fmt::ago_short(Some(t), s.now))
            .unwrap_or_default();
    let mut b = col()
        .key(format!("bubble-{i}"))
        .w_full()
        .gap(8.0)
        .child(who(k, user, if m.auto { "auto" } else { &ts }));
    for (pi, p) in m.render_parts().into_iter().enumerate() {
        b = b.child(match p {
            Part::Text(t) if user => text(t)
                .font(k.ty.body)
                .color(k.c.text_base)
                .wrap()
                .selectable(true)
                .key(format!("t-{i}-{pi}")),
            Part::Text(t) => Markdown::new(t)
                .selectable(true)
                .build(k)
                .key(format!("md-{i}-{pi}")),
            Part::Tool(t) => tool_chip(s, &t, k, format!("tool-{i}-{pi}")),
        });
    }
    if user {
        b = b
            .padding(12.0)
            .radius(k.radius.lg)
            .fill(k.c.layer_01)
            .border(1.0, k.c.border_weak);
    }
    b
}

fn tool_chip(s: &Hooked, t: &Tool, k: &Kit, key: String) -> El {
    let id = t.id.clone().unwrap_or_else(|| key.clone());
    let open = s.all_tools_open || s.tools_open.contains(&id);
    let detail = t.detail.clone().unwrap_or_default();
    let head = k
        .interactive(
            row()
                .key(format!("{key}-head"))
                .role("button")
                .label(format!("{} {}", t.name, detail))
                .expanded(open)
                .w_full()
                .h(28.0)
                .px(8.0)
                .gap(8.0)
                .center_y()
                .radius(k.radius.sm)
                .cursor(Cursor::Pointer)
                .child(glyph(&icons::TOOL, 12.0, k.c.icon_faint))
                .child(
                    text(t.name.clone())
                        .font(k.ty.text_small_medium)
                        .color(k.c.text_muted),
                )
                .child(
                    text(detail)
                        .font(k.ty.mono)
                        .color(k.c.text_faint)
                        .truncate()
                        .grow(1.0)
                        .min_w(0.0),
                ),
        )
        .on_press(move |s: &mut Hooked| {
            if !s.tools_open.remove(&id) {
                s.tools_open.insert(id.clone());
            }
        });
    let mut chip = col()
        .key(key.clone())
        .w_full()
        .radius(k.radius.md)
        .border(1.0, k.c.border_weak)
        .fill(k.c.layer_01)
        .child(head);
    if open {
        let mono = |label: &str, body: String| {
            col()
                .w_full()
                .gap(4.0)
                .px(10.0)
                .pb(8.0)
                .child(
                    text(label.to_string())
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.text_faint),
                )
                .child(
                    text(clip(&body, 60))
                        .font(k.ty.mono)
                        .color(k.c.text_muted)
                        .wrap_anywhere()
                        .selectable(true),
                )
        };
        if let Some(input) = t.input_text.clone() {
            chip = chip.child(mono("Input", input));
        }
        if let Some(r) = t.result_text() {
            chip = chip.child(mono("Result", r));
        }
    }
    chip
}

fn clip(s: &str, max_lines: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    if lines.len() <= max_lines {
        return s.to_string();
    }
    format!(
        "{}\n… {} more lines",
        lines[..max_lines].join("\n"),
        lines.len() - max_lines
    )
}

fn card(k: &Kit, key: &str, accent: Color) -> El {
    col()
        .key(key.to_string())
        .w_full()
        .max_w(920.0)
        .self_center()
        .mx(20.0)
        .mb(10.0)
        .padding(14.0)
        .gap(10.0)
        .radius(k.radius.lg)
        .fill(k.c.surface_raised)
        .border(1.0, accent)
        .box_shadows(&k.elevation.raised)
}

fn question(s: &Hooked, q: &PendingQuestion, k: &Kit) -> El {
    if q.is_permission() {
        let ask = q
            .questions
            .first()
            .map(|x| x.question.clone())
            .unwrap_or_default();
        let tool = q.tool_name.clone().unwrap_or_else(|| "a tool".into());
        return card(k, "permission", k.c.warning.border)
            .child(
                row()
                    .gap(8.0)
                    .center_y()
                    .child(dot(k, "waiting", 8.0))
                    .child(
                        text(format!("Permission · {tool}"))
                            .font(k.ty.ui_medium)
                            .color(k.c.text_base),
                    ),
            )
            .child(
                text(ask)
                    .font(k.ty.mono)
                    .color(k.c.text_muted)
                    .wrap_anywhere(),
            )
            .child(
                row()
                    .gap(8.0)
                    .child(
                        Button::new("Allow once")
                            .variant(ButtonVariant::Contrast)
                            .on_press(|s: &mut Hooked| s.answer_permission(0))
                            .build(k)
                            .key("perm-once"),
                    )
                    .child(
                        Button::new("Allow always")
                            .variant(ButtonVariant::Neutral)
                            .on_press(|s: &mut Hooked| s.answer_permission(1))
                            .build(k)
                            .key("perm-always"),
                    )
                    .child(
                        Button::new("Deny")
                            .variant(ButtonVariant::Danger)
                            .on_press(|s: &mut Hooked| s.answer_permission(2))
                            .build(k)
                            .key("perm-deny"),
                    ),
            );
    }
    let mut c = card(k, "question", k.c.warning.border).child(
        row()
            .gap(8.0)
            .center_y()
            .child(dot(k, "waiting", 8.0))
            .child(
                text("Claude is asking")
                    .font(k.ty.ui_medium)
                    .color(k.c.text_base),
            ),
    );
    for (qi, qq) in q.questions.iter().enumerate() {
        let mut block = col().key(format!("q-{qi}")).w_full().gap(6.0);
        if let Some(h) = qq.header.as_ref() {
            block = block.child(pill(k, h.clone(), k.c.text_muted, k.c.layer_02));
        }
        block = block.child(
            text(qq.question.clone())
                .font(k.ty.body_medium)
                .color(k.c.text_base)
                .wrap(),
        );
        for (oi, o) in qq.options.iter().enumerate() {
            let on = s.q_sel.get(qi).is_some_and(|set| set.contains(&oi));
            let mut opt = col().gap(2.0).child(
                text(o.label.clone())
                    .font(k.ty.ui_medium)
                    .color(k.c.text_base),
            );
            if let Some(dsc) = o.description.as_ref() {
                opt = opt.child(
                    text(dsc.clone())
                        .font(k.ty.text_small)
                        .color(k.c.text_muted)
                        .wrap(),
                );
            }
            block = block.child(
                k.interactive(
                    row()
                        .key(format!("q-{qi}-{oi}"))
                        .role(if qq.multi_select { "checkbox" } else { "radio" })
                        .checked(on)
                        .w_full()
                        .padding(10.0)
                        .gap(10.0)
                        .radius(k.radius.md)
                        .cursor(Cursor::Pointer)
                        .border(
                            1.0,
                            if on {
                                k.c.border_focus
                            } else {
                                k.c.border_weak
                            },
                        )
                        .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
                        .child(glyph(
                            if on {
                                &icons::CIRCLE_CHECK
                            } else {
                                &icons::CIRCLE
                            },
                            16.0,
                            if on { k.c.icon_base } else { k.c.icon_faint },
                        ))
                        .child(opt.grow(1.0).min_w(0.0)),
                )
                .on_press(move |s: &mut Hooked| s.pick_option(qi, oi)),
            );
        }
        c = c.child(block);
    }
    c.child(
        TextInput::new(&s.q_other)
            .placeholder("Other: type your own answer…")
            .width(None)
            .on_edit(|s: &mut Hooked| &mut s.q_other)
            .on_submit(|s: &mut Hooked, _| s.answer())
            .build(k)
            .key("q-other"),
    )
    .child(
        row().justify_end().child(
            Button::new("Answer")
                .variant(ButtonVariant::Contrast)
                .on_press(|s: &mut Hooked| s.answer())
                .build(k)
                .key("q-answer"),
        ),
    )
}

fn plan(s: &Hooked, p: &PendingPlan, k: &Kit) -> El {
    card(k, "plan", k.c.info.border)
        .child(
            row()
                .gap(8.0)
                .center_y()
                .child(dot(k, "working", 8.0))
                .child(
                    text("Plan ready for review")
                        .font(k.ty.ui_medium)
                        .color(k.c.text_base),
                ),
        )
        .child(
            col()
                .key("plan-body")
                .w_full()
                .max_h(320.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(Markdown::new(p.plan.clone()).build(k)),
        )
        .child(
            TextInput::new(&s.plan_feedback)
                .placeholder("Feedback (sent when you keep planning)…")
                .width(None)
                .on_edit(|s: &mut Hooked| &mut s.plan_feedback)
                .build(k)
                .key("plan-feedback"),
        )
        .child(
            row()
                .gap(8.0)
                .justify_end()
                .child(
                    Button::new("Keep planning")
                        .variant(ButtonVariant::Outline)
                        .on_press(|s: &mut Hooked| s.plan_action("reject"))
                        .build(k)
                        .key("plan-reject"),
                )
                .child(
                    Button::new("Approve · accept edits")
                        .variant(ButtonVariant::Neutral)
                        .on_press(|s: &mut Hooked| s.plan_action("acceptEdits"))
                        .build(k)
                        .key("plan-accept"),
                )
                .child(
                    Button::new("Approve · auto")
                        .variant(ButtonVariant::Contrast)
                        .on_press(|s: &mut Hooked| s.plan_action("auto"))
                        .build(k)
                        .key("plan-auto"),
                ),
        )
}

fn composer_field(s: &Hooked, k: &Kit, placeholder: &str) -> El {
    TextArea::new(&s.composer)
        .placeholder(placeholder.to_string())
        .auto_grow(1, 10)
        .width(None)
        .on_edit(|s: &mut Hooked| &mut s.composer)
        .on_key(|s: &mut Hooked, ev: &rune::KeyEvent, _| match ev.key {
            Key::Enter if !ev.mods.shift && !ev.mods.alt => {
                s.send();
                true
            }
            Key::Escape => {
                let busy = s
                    .detail
                    .as_ref()
                    .is_some_and(|d| d.session.state == "working")
                    || s.live.as_ref().is_some_and(|l| l.busy);
                if busy {
                    s.interrupt();
                    return true;
                }
                false
            }
            _ => false,
        })
        .build(k)
        .key("composer-field")
        .grow(1.0)
        .min_w(0.0)
}

fn send_button(s: &Hooked, k: &Kit) -> El {
    IconButton::new(&icons::ARROW_UP)
        .variant(IconButtonVariant::Contrast)
        .label("Send")
        .help("Send (Enter) · Shift+Enter for a new line")
        .disabled(s.sending || (s.composer.text.trim().is_empty() && s.attachments.is_empty()))
        .on_press(|s: &mut Hooked| s.send())
        .build(k)
        .key("composer-send")
}

fn composer(s: &Hooked, d: &Detail, k: &Kit, busy: bool) -> El {
    let mut c = col()
        .key("composer")
        .w_full()
        .max_w(920.0)
        .self_center()
        .px(20.0)
        .pb(14.0)
        .pt(6.0)
        .gap(8.0);
    let follow = d.followup_suggestion.clone().filter(|f| {
        !f.is_empty()
            && d.pending_question.is_none()
            && d.pending_plan.is_none()
            && s.queued.is_empty()
    });
    if let Some(f) = follow {
        let use_it = f.clone();
        c = c.child(
            k.interactive(
                row()
                    .key("followup")
                    .role("button")
                    .w_full()
                    .px(10.0)
                    .py(6.0)
                    .gap(8.0)
                    .center_y()
                    .radius(k.radius.md)
                    .border(1.0, k.c.border_weak)
                    .cursor(Cursor::Pointer)
                    .child(glyph(&icons::ZAP, 12.0, k.c.icon_muted))
                    .child(
                        text(fmt::first_line(&f, 200))
                            .font(k.ty.ui)
                            .color(k.c.text_muted)
                            .truncate()
                            .grow(1.0)
                            .min_w(0.0),
                    )
                    .child(
                        text("Tab ↹ to use")
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_faint),
                    ),
            )
            .help("Suggested follow-up: click to put it in the box")
            .on_press(move |s: &mut Hooked| s.use_followup(use_it.clone())),
        );
    }
    if !s.attachments.is_empty() {
        c = c.child(
            row()
                .key("attachments")
                .w_full()
                .gap(6.0)
                .flex_wrap()
                .children(s.attachments.iter().map(|a| {
                    let id = a.id;
                    let (status, color) = match (&a.path, a.failed) {
                        (_, true) => ("failed", k.c.danger.fg),
                        (Some(_), _) => ("ready", k.c.success.fg),
                        (None, _) => ("uploading…", k.c.text_faint),
                    };
                    row()
                        .key(format!("att-{id}"))
                        .h(26.0)
                        .pl(8.0)
                        .pr(2.0)
                        .gap(6.0)
                        .center_y()
                        .radius(k.radius.md)
                        .fill(k.c.layer_02)
                        .child(glyph(&icons::IMAGE, 12.0, k.c.icon_muted))
                        .child(
                            text(a.name.clone())
                                .font(k.ty.text_small)
                                .color(k.c.text_base),
                        )
                        .child(text(status).font(k.ty.text_xsmall).color(color))
                        .child(
                            IconButton::new(&icons::CLOSE)
                                .variant(IconButtonVariant::GhostMuted)
                                .control_size(ControlSize::Small)
                                .label("Remove")
                                .on_press(move |s: &mut Hooked| {
                                    s.attachments.retain(|x| x.id != id)
                                })
                                .build(k),
                        )
                })),
        );
    }
    let mut bar = row().w_full().gap(8.0).items_end().child(composer_field(
        s,
        k,
        if busy {
            "Queue a message… (Esc interrupts)"
        } else {
            "Reply to Claude…"
        },
    ));
    if busy {
        bar = bar.child(
            IconButton::new(&icons::STOP)
                .variant(IconButtonVariant::Neutral)
                .label("Interrupt")
                .help("Interrupt (Esc)")
                .on_press(|s: &mut Hooked| s.interrupt())
                .build(k)
                .key("composer-stop"),
        );
    }
    bar = bar.child(send_button(s, k));
    let mode = d
        .permission_mode
        .clone()
        .unwrap_or_else(|| "default".into());
    let model = d
        .session
        .model
        .clone()
        .map(|m| fmt::short_model(&m))
        .unwrap_or_default();
    let effort = d.session.effort.clone().unwrap_or_default();
    let hint = row()
        .key("composer-hint")
        .w_full()
        .gap(10.0)
        .center_y()
        .child(
            text(format!("Mode: {}", fmt::mode_label(&mode)))
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        )
        .child(
            text(format!("{model} · {effort}"))
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        )
        .child(el().grow(1.0))
        .child(
            text("Enter to send · Shift+Enter new line")
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        );
    c.child(bar).child(hint)
}
