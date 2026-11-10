use std::hash::{Hash, Hasher};

use rune::{Color, Cursor, El, Key, ScrollSpec, col, el, memo, row, text};
use rune_kit::{
    Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant, Kit, Menu, MenuItem,
    Spinner, TextArea, TextInput,
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
        .child(group_tabs(s, &d.session.id, k))
        .child(lenses(s, d, k))
        .child(
            col()
                .key("lens-body")
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .child(body),
        )
        .child(super::terminal::panel(s, k))
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
            text(s.title_of(x))
                .font(k.ty.body_medium)
                .color(k.c.text_base)
                .truncate()
                .shrink()
                .min_w(60.0)
                .key("sess-name"),
        )
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
    let mut sub_line = row()
        .key("head-sub")
        .w_full()
        .h(24.0)
        .pl(54.0)
        .pr(14.0)
        .gap(12.0)
        .center_y()
        .child(meta.shrink().min_w(0.0).clip_rounded(0.0).key("head-meta"))
        .child(head_tags(s, &x.id, k).shrink().min_w(0.0).clip_rounded(0.0))
        .child(el().grow(1.0));
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
        sub_line = sub_line.child(
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
        sub_line = sub_line.child(
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
        IconButton::new(&icons::SPLIT)
            .variant(if !s.splits.is_empty() {
                IconButtonVariant::Neutral
            } else {
                IconButtonVariant::GhostMuted
            })
            .label("Split view")
            .help(if !s.splits.is_empty() {
                "Close the split (⌘⇧S)"
            } else {
                "Split with the most recent session (⌘⇧S)"
            })
            .expanded(!s.splits.is_empty())
            .on_press(|s: &mut Hooked| s.toggle_split())
            .build(k)
            .key("split-btn"),
    );
    line = line
        .child(
            IconButton::new(if s.dock_open {
                &icons::PANEL_RIGHT
            } else {
                &icons::SIDEBAR
            })
            .variant(IconButtonVariant::GhostMuted)
            .label("Toggle the context panel")
            .help("Context panel")
            .expanded(s.dock_open)
            .on_press(|s: &mut Hooked| s.toggle_dock())
            .build(k)
            .key("dock-toggle"),
        )
        .child(
            IconButton::new(if s.focus {
                &icons::SIDEBAR
            } else {
                &icons::MONITOR
            })
            .variant(if s.focus {
                IconButtonVariant::Ghost
            } else {
                IconButtonVariant::GhostMuted
            })
            .label("Focus mode")
            .help(if s.focus {
                "Exit focus mode (⌘⇧F or Esc)"
            } else {
                "Focus mode: the conversation alone (⌘⇧F)"
            })
            .expanded(s.focus)
            .on_press(|s: &mut Hooked| s.focus = !s.focus)
            .build(k)
            .key("focus-toggle"),
        );
    let right = line.child(more_menu(s, d, k, layer));
    col()
        .key("head")
        .w_full()
        .pb(4.0)
        .child(
            row()
                .key("head-line")
                .w_full()
                .h(40.0)
                .px(14.0)
                .gap(12.0)
                .center_y()
                .child(left)
                .child(right),
        )
        .child(sub_line)
}

fn head_tags(s: &Hooked, id: &str, k: &Kit) -> El {
    let tags = s.session_tags(id);
    if tags.is_empty() {
        return el();
    }
    let id = id.to_string();
    k.interactive(
        row()
            .key("head-tags")
            .role("button")
            .gap(4.0)
            .center_y()
            .cursor(Cursor::Pointer)
            .help("Edit tags")
            .children(tags.iter().map(|t| super::tag_pill(s, k, t))),
    )
    .on_press(move |s: &mut Hooked| s.open_tags(id.clone()))
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
            .visible_models()
            .into_iter()
            .map(|(id, label)| {
                MenuItem::new(label)
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
        if s.menu_shows("modelEffort") {
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
                .separator();
        }
        if s.menu_shows("permissionMode") {
            m = m.group_label("Permission mode");
            for md in fmt::LIVE_MODES {
                m = m.item(
                    MenuItem::new(fmt::mode_label(md))
                        .checked(mode == md)
                        .on_select(move |s: &mut Hooked| s.set_mode(md)),
                );
            }
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
    m.item(
        MenuItem::new("Copy as Markdown")
            .icon(&icons::COPY)
            .description("The whole conversation, tool calls included")
            .on_select_tx(|s: &mut Hooked, tx: &mut rune::Tx| {
                s.popup = None;
                if let Some(d) = s.detail.as_ref() {
                    tx.copy(crate::export::conversation(d));
                    s.flash("✓ Conversation copied as Markdown", false);
                }
            }),
    )
    .item(
        MenuItem::new(format!("Cost · {}", fmt::cost(x.cost)))
            .description("Where the money went: input, output, cache")
            .on_select(|s: &mut Hooked| {
                s.popup = None;
                s.picker = Some(crate::organize::Picker::Cost);
            }),
    )
    .separator()
    .item({
        let id = x.id.clone();
        MenuItem::new("Edit tags…")
            .icon(&icons::TAG)
            .on_select(move |s: &mut Hooked| s.open_tags(id.clone()))
    })
    .item({
        let id = x.id.clone();
        MenuItem::new("Move to group…")
            .icon(&icons::LIST)
            .on_select(move |s: &mut Hooked| s.open_group_picker(id.clone()))
    })
    .item({
        let id = x.id.clone();
        let grouped = s.group_of(&x.id).is_some();
        let leads = !grouped && s.group_members(&x.id).len() > 1;
        if grouped {
            MenuItem::new("Leave the group").on_select(move |s: &mut Hooked| {
                s.group_op("leave", id.clone(), serde_json::json!({}))
            })
        } else if leads {
            MenuItem::new("Rename the group…")
                .on_select(move |s: &mut Hooked| s.open_rename_group(id.clone()))
        } else {
            MenuItem::new("Not in a group").disabled(true)
        }
    })
    .item({
        let id = x.id.clone();
        let on = s.meta.get(&x.id).is_some_and(|m| m.incognito);
        MenuItem::new(if on {
            "Remove from incognito"
        } else {
            "Mark incognito"
        })
        .icon(if on { &icons::EYE } else { &icons::EYE_OFF })
        .description("Incognito sessions stay visible in incognito mode")
        .on_select(move |s: &mut Hooked| {
            s.popup = None;
            s.toggle_incognito(&id)
        })
    })
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
                    k.c.text_accent
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

pub(super) fn hash_of(v: impl Hash) -> u64 {
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
        let version = bubble_version(s, m, k);
        chat = chat.child(memo(format!("msg-{}-{i}", d.session.id), version, || {
            bubble(s, &d.session.id, m, k, i)
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
                .child(super::md(lead.clone()).streaming(true).build(k)),
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
            b = b.child(super::md(l.text.clone()).streaming(true).build(k));
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
        if s.ac.is_some() {
            out = out.child(row().w_full().px(20.0).child(autocomplete(s, k)));
        }
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

pub(super) fn bubble_version(s: &Hooked, m: &Message, k: &Kit) -> u64 {
    let open_ids: Vec<String> = m
        .render_parts()
        .into_iter()
        .filter_map(|p| if let Part::Tool(t) = p { t.id } else { None })
        .filter(|id| s.tools_open.contains(id))
        .collect();
    let pictures: Vec<bool> = message_media(m)
        .iter()
        .map(|p| {
            s.media
                .get(p)
                .and_then(Option::as_ref)
                .is_some_and(rune::Image::is_ready)
        })
        .collect();
    let full = m
        .fork_uuid
        .as_ref()
        .and_then(|u| s.full_texts.get(u))
        .map(Option::is_some);
    hash_of((
        &m.text,
        full,
        pictures,
        m.tools.len(),
        m.ts.as_deref(),
        k.dark,
        s.all_tools_open,
        open_ids,
    ))
}

pub(super) fn bubble(s: &Hooked, session: &str, m: &Message, k: &Kit, i: usize) -> El {
    let user = m.role == "user";
    if m.role == "system" {
        return row().w_full().justify_center().child(
            text(fmt::first_line(&m.text, 160))
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        );
    }
    let ts =
        m.ts.as_deref()
            .map(|t| fmt::ago_short(Some(t), s.now))
            .unwrap_or_default();
    let mut head = row()
        .w_full()
        .center_y()
        .child(who(k, user, if m.auto { "auto" } else { &ts }));
    if let Some(uuid) = m.fork_uuid.clone() {
        let opts = uuid.clone();
        head = head
            .child(el().grow(1.0))
            .child(
                Button::new("Fork")
                    .icon(&icons::FORK)
                    .variant(ButtonVariant::GhostFaint)
                    .control_size(ControlSize::Small)
                    .help("Fork here without a message: an independent branch waiting for you")
                    .on_press(move |s: &mut Hooked| s.fork_at(uuid.clone()))
                    .build(k),
            )
            .child(
                IconButton::new(&icons::CHEVRON_DOWN)
                    .variant(IconButtonVariant::GhostMuted)
                    .control_size(ControlSize::Small)
                    .label("Fork options")
                    .help("Fork options (model, effort, mode, a first message)")
                    .on_press(move |s: &mut Hooked| s.fork_options(opts.clone()))
                    .build(k),
            );
    }
    let mut b = col().w_full().gap(8.0).child(head);
    let full = m
        .fork_uuid
        .as_ref()
        .and_then(|u| s.full_texts.get(u))
        .cloned();
    for (pi, p) in m.render_parts().into_iter().enumerate() {
        let p = match (p, &full) {
            (Part::Text(_), Some(Some(t))) if user => Part::Text(t.clone()),
            (p, _) => p,
        };
        b = b.child(match p {
            Part::Text(t) if user => {
                let (images, rest) = crate::api::split_message_images(&t);
                let mut c = col().w_full().gap(8.0).key(format!("t-{i}-{pi}"));
                if !images.is_empty() {
                    c = c.child(
                        row()
                            .gap(8.0)
                            .flex_wrap()
                            .children(images.iter().map(|p| picture(s, k, p, 220.0, 160.0))),
                    );
                }
                if !rest.is_empty() {
                    c = c.child(
                        text(rest)
                            .font(k.ty.body)
                            .color(k.c.text_base)
                            .wrap()
                            .selectable(true),
                    );
                }
                c
            }
            Part::Text(t) => super::md_code(t, k, Some(session.to_string()))
                .selectable(true)
                .build(k)
                .key(format!("md-{i}-{pi}")),
            Part::Tool(t) => tool_chip(s, session, &t, k, format!("tool-{i}-{pi}")),
        });
    }
    if user
        && m.truncated
        && !matches!(full, Some(Some(_)))
        && let Some(uuid) = m.fork_uuid.clone()
    {
        let session = session.to_string();
        b = b.child(
            Button::new(if full.is_some() {
                "Loading…"
            } else {
                "Show the full message"
            })
            .icon(&icons::CHEVRON_DOWN)
            .variant(ButtonVariant::GhostMuted)
            .control_size(ControlSize::Small)
            .on_press(move |s: &mut Hooked| s.load_full_text(session.clone(), uuid.clone()))
            .build(k),
        );
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

fn group_tabs(s: &Hooked, id: &str, k: &Kit) -> El {
    let mother = s.group_of(id).unwrap_or(id).to_string();
    let members: Vec<String> = s
        .group_members(&mother)
        .into_iter()
        .filter(|m| s.session(m).is_some())
        .collect();
    if members.len() < 2 {
        return el();
    }
    let name = s
        .session(&mother)
        .map(|m| s.group_label(m))
        .unwrap_or_default();
    let rename = mother.clone();
    let strip = row()
        .key("group-tabs")
        .w_full()
        .h(34.0)
        .px(16.0)
        .gap(4.0)
        .center_y()
        .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_weak)
        .child(
            k.interactive(
                row()
                    .role("button")
                    .gap(5.0)
                    .pr(8.0)
                    .center_y()
                    .cursor(Cursor::Pointer)
                    .help("Session group: click to rename")
                    .child(glyph(&icons::LIST, 12.0, k.c.icon_muted))
                    .child(
                        text(name)
                            .font(k.ty.text_small_medium)
                            .color(k.c.text_muted),
                    ),
            )
            .on_press(move |s: &mut Hooked| s.open_rename_group(rename.clone())),
        );
    let mut tabs = row().gap(4.0).center_y();
    for m in members {
        let Some(x) = s.session(&m) else { continue };
        let on = m == id;
        let lead = m == mother;
        let (open, make, leave) = (m.clone(), m.clone(), m.clone());
        let mut tab = row()
            .key(format!("gt-{m}"))
            .h(26.0)
            .pl(8.0)
            .pr(4.0)
            .gap(5.0)
            .center_y()
            .max_w(240.0)
            .radius(k.radius.sm)
            .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
            .child(
                k.interactive(
                    row()
                        .role("tab")
                        .checked(on)
                        .gap(5.0)
                        .center_y()
                        .min_w(0.0)
                        .cursor(Cursor::Pointer)
                        .help(s.title_of(x))
                        .child(dot(k, &x.state, 7.0))
                        .child(if lead {
                            glyph(&icons::STAR, 11.0, k.c.icon_accent)
                        } else {
                            el()
                        })
                        .child(
                            text(s.title_of(x))
                                .font(k.ty.text_small)
                                .color(if on { k.c.text_base } else { k.c.text_muted })
                                .truncate()
                                .min_w(0.0),
                        ),
                )
                .on_press(move |s: &mut Hooked| s.open_session(&open)),
            );
        if !lead {
            tab = tab.child(
                IconButton::new(&icons::STAR)
                    .variant(IconButtonVariant::GhostMuted)
                    .control_size(ControlSize::Small)
                    .label("Make it the lead session")
                    .help("Make it the lead session")
                    .on_press(move |s: &mut Hooked| {
                        s.group_op("mother", make.clone(), serde_json::json!({}))
                    })
                    .build(k),
            );
        }
        tab = tab.child(
            IconButton::new(&icons::CLOSE)
                .variant(IconButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .label("Remove from the group")
                .help("Remove from the group")
                .on_press(move |s: &mut Hooked| {
                    s.group_op("leave", leave.clone(), serde_json::json!({}))
                })
                .build(k),
        );
        tabs = tabs.child(tab);
    }
    strip
        .child(row().grow(1.0).min_w(0.0).scroll_x().child(tabs))
        .child(
            IconButton::new(&icons::PLUS)
                .variant(IconButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .label("New session in this group")
                .help("New session in this group")
                .on_press(move |s: &mut Hooked| s.go_new_in_group(mother.clone()))
                .build(k),
        )
}

fn message_media(m: &Message) -> Vec<String> {
    let mut out = if m.role == "user" {
        crate::api::split_message_images(&m.text).0
    } else {
        Vec::new()
    };
    for p in m.render_parts() {
        if let Part::Tool(t) = p {
            out.extend(crate::api::tool_media(&t));
        }
    }
    out
}

fn file_name(p: &str) -> String {
    p.rsplit('/').next().unwrap_or(p).to_string()
}

pub(super) fn picture(s: &Hooked, k: &Kit, path: &str, max_w: f32, max_h: f32) -> El {
    let img = s.media.get(path).and_then(Option::as_ref);
    let fitted = img.and_then(|i| i.size()).map(|[w, h]| {
        let (w, h) = (w.max(1) as f32 / 2.0, h.max(1) as f32 / 2.0);
        let scale = (max_w / w).min(max_h / h).min(1.0);
        (w * scale, h * scale)
    });
    let name = file_name(path);
    let tile = match (img, fitted) {
        (Some(img), Some((w, h))) => el().size(w, h).pixels(img.pixels()),
        _ => col()
            .size(max_w.min(180.0), max_h.min(110.0))
            .gap(6.0)
            .center()
            .fill(k.c.layer_02)
            .child(glyph(&icons::IMAGE, 18.0, k.c.icon_faint))
            .child(
                text(if img.is_none() && s.media.contains_key(path) {
                    "loading…".to_string()
                } else {
                    name.clone()
                })
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint)
                .truncate(),
            ),
    };
    k.interactive(
        tile.key(format!("pic-{path}"))
            .role("link")
            .label(name.clone())
            .help(format!("{name} · click to enlarge"))
            .radius(k.radius.md)
            .clip_rounded(k.radius.md)
            .border(1.0, k.c.border_weak)
            .cursor(Cursor::Pointer),
    )
    .on_press({
        let path = path.to_string();
        move |s: &mut Hooked| s.open_image(vec![path.clone()], 0)
    })
}

fn sent_files(s: &Hooked, k: &Kit, send: &serde_json::Value) -> El {
    let mut c = col().w_full().gap(6.0).px(10.0).pb(10.0);
    if let Some(cap) = send["caption"].as_str().filter(|c| !c.is_empty()) {
        c = c.child(
            text(cap.to_string())
                .font(k.ty.text_small)
                .color(k.c.text_muted)
                .wrap(),
        );
    }
    let files = send["files"].as_array().cloned().unwrap_or_default();
    let mut pics = row().gap(8.0).flex_wrap();
    let mut others = row().gap(6.0).flex_wrap();
    for f in &files {
        let Some(p) = f["path"].as_str() else {
            continue;
        };
        if f["kind"] == "image" {
            pics = pics.child(picture(s, k, p, 320.0, 220.0));
        } else {
            let url = format!("file://{p}");
            others = others.child(
                k.interactive(
                    row()
                        .key(format!("file-{p}"))
                        .role("link")
                        .h(24.0)
                        .px(8.0)
                        .gap(5.0)
                        .center_y()
                        .radius(k.radius.sm)
                        .border(1.0, k.c.border_weak)
                        .cursor(Cursor::Pointer)
                        .help(p.to_string())
                        .child(glyph(&icons::LINK, 12.0, k.c.icon_muted))
                        .child(
                            text(file_name(p))
                                .font(k.ty.text_small)
                                .color(k.c.text_base),
                        ),
                )
                .on_press_tx(move |_: &mut Hooked, tx| {
                    let _ = tx.open_url(&url);
                }),
            );
        }
    }
    c.child(pics).child(others)
}

fn show_work(s: &Hooked, k: &Kit, show: &serde_json::Value) -> El {
    let str_of = |key: &str| show[key].as_str().unwrap_or("").to_string();
    let title = Some(str_of("title"))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| str_of("name"));
    let mut head = row()
        .w_full()
        .gap(6.0)
        .center_y()
        .child(glyph(&icons::IMAGE, 13.0, k.c.icon_muted))
        .child(
            text(title)
                .font(k.ty.text_small_medium)
                .color(k.c.text_base)
                .truncate()
                .grow(1.0)
                .min_w(0.0),
        );
    let page = str_of("url");
    if !page.is_empty() {
        head = head.child(
            Button::new("Open page")
                .icon(&icons::LINK)
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .on_press_tx(move |_: &mut Hooked, tx| {
                    let _ = tx.open_url(&page);
                })
                .build(k),
        );
    }
    let mut c = col().w_full().gap(8.0).px(10.0).pb(10.0).child(head);
    let path = str_of("path");
    let before = str_of("compare");
    let timed = show["kind"] != "image";
    if timed {
        let play = |label: String, p: &str| {
            let url = format!("file://{p}");
            Button::new(label)
                .icon(&icons::PLAY)
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .help("Opens in the system player")
                .on_press_tx(move |_: &mut Hooked, tx| {
                    let _ = tx.open_url(&url);
                })
                .build(k)
        };
        let mut r = row().gap(8.0).child(play(
            if before.is_empty() {
                format!("Play {}", file_name(&path))
            } else {
                "Play after".to_string()
            },
            &path,
        ));
        if !before.is_empty() {
            r = r.child(play("Play before".into(), &before));
        }
        c = c.child(r);
    }
    let figure = |label: &str, p: &str, w: f32| {
        col()
            .gap(4.0)
            .child(
                text(label.to_string())
                    .font(k.ty.text_xsmall_medium)
                    .color(k.c.text_faint),
            )
            .child(picture(s, k, p, w, 360.0))
    };
    c = c.child(if timed {
        el()
    } else if before.is_empty() {
        picture(s, k, &path, 640.0, 420.0)
    } else {
        row()
            .gap(10.0)
            .child(figure("Before", &before, 320.0))
            .child(figure("After", &path, 320.0))
    });
    let at = |v: &serde_json::Value| {
        v["at"]
            .as_f64()
            .filter(|_| timed)
            .map(|t| format!("{}:{:02} ", t as u64 / 60, t as u64 % 60))
            .unwrap_or_default()
    };
    for ch in show["changes"].as_array().into_iter().flatten() {
        let mut line = text(format!(
            "• {}{}",
            at(ch),
            ch["title"].as_str().unwrap_or("")
        ))
        .font(k.ty.text_small_medium)
        .color(k.c.text_base)
        .wrap();
        if let Some(detail) = ch["detail"].as_str().filter(|d| !d.is_empty()) {
            line = text(format!(
                "• {}{} — {detail}",
                at(ch),
                ch["title"].as_str().unwrap_or("")
            ))
            .font(k.ty.text_small)
            .color(k.c.text_base)
            .wrap();
        }
        c = c.child(line);
    }
    let checks: Vec<&serde_json::Value> = show["checks"].as_array().into_iter().flatten().collect();
    if !checks.is_empty() {
        c = c.child(
            row()
                .gap(6.0)
                .flex_wrap()
                .children(checks.into_iter().map(|ch| {
                    let ok = ch["ok"].as_bool().unwrap_or(false);
                    let (fg, bg) = if ok {
                        (k.c.success.fg, k.c.success.bg)
                    } else {
                        (k.c.danger.fg, k.c.danger.bg)
                    };
                    pill(
                        k,
                        format!(
                            "{} {}",
                            if ok { "✓" } else { "✗" },
                            ch["name"].as_str().unwrap_or("")
                        ),
                        fg,
                        bg,
                    )
                })),
        );
    }
    c
}

const BIG_DIFF: usize = 12;

fn diff_lines(diff: &serde_json::Value) -> usize {
    let n = |v: &serde_json::Value| v.as_str().map_or(0, |s| s.lines().count().max(1));
    diff["ops"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|o| n(&o["old"]).max(n(&o["new"])).max(n(&o["content"])))
        .sum()
}

fn diff_cell(k: &Kit, line: Option<&rune_kit::diff::Line>) -> El {
    use rune_kit::diff::LineKind;
    let Some(l) = line else {
        return row().w_frac(0.5).min_w(0.0).fill(k.c.layer_02);
    };
    let (sign, fill, ink) = match l.kind {
        LineKind::Added => ("+", k.c.success.bg, k.c.success.fg),
        LineKind::Removed => ("-", k.c.danger.bg, k.c.danger.fg),
        _ => (" ", Color::TRANSPARENT, k.c.text_faint),
    };
    row()
        .w_frac(0.5)
        .min_w(0.0)
        .px(6.0)
        .gap(6.0)
        .fill(fill)
        .child(text(sign).font(k.ty.mono).color(ink).w(10.0))
        .child(
            text(if l.text.is_empty() {
                " ".to_string()
            } else {
                l.text.clone()
            })
            .font(k.ty.mono)
            .color(if l.kind == LineKind::Context {
                k.c.text_muted
            } else {
                k.c.text_base
            })
            .wrap_anywhere()
            .grow(1.0)
            .min_w(0.0)
            .selectable(true),
        )
}

/// Side by side: context on both sides, a run of removed lines paired with the added run after it.
fn split_rows(k: &Kit, lines: &[rune_kit::diff::Line]) -> Vec<El> {
    use rune_kit::diff::LineKind;
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].kind == LineKind::Context {
            out.push(
                row()
                    .w_full()
                    .child(diff_cell(k, Some(&lines[i])))
                    .child(diff_cell(k, Some(&lines[i]))),
            );
            i += 1;
            continue;
        }
        let start = i;
        while i < lines.len() && lines[i].kind == LineKind::Removed {
            i += 1;
        }
        let removed = &lines[start..i];
        let mid = i;
        while i < lines.len() && lines[i].kind == LineKind::Added {
            i += 1;
        }
        let added = &lines[mid..i];
        for j in 0..removed.len().max(added.len()) {
            out.push(
                row()
                    .w_full()
                    .child(diff_cell(k, removed.get(j)))
                    .child(diff_cell(k, added.get(j))),
            );
        }
    }
    out
}

fn inline_diff(k: &Kit, diff: &serde_json::Value, split: bool) -> El {
    use rune_kit::diff::{FileDiff, LineKind};
    let name = diff["name"].as_str().unwrap_or("").to_string();
    let mut c = col().w_full().gap(6.0).px(10.0).pb(10.0);
    for op in diff["ops"].as_array().into_iter().flatten() {
        if op["all"].as_bool() == Some(true) {
            c = c.child(
                text("replace all occurrences")
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_faint),
            );
        }
        let old = if op["kind"] == "notebook" {
            ""
        } else {
            op["old"].as_str().unwrap_or("")
        };
        let new = if op["kind"] == "write" {
            op["content"].as_str().unwrap_or("")
        } else {
            op["new"].as_str().unwrap_or("")
        };
        let fd = FileDiff::from_texts_with_context(name.clone(), old, new, 3);
        let mut block = col()
            .w_full()
            .radius(k.radius.sm)
            .border(1.0, k.c.border_weak)
            .clip_rounded(k.radius.sm);
        let mut shown = 0;
        for (hi, h) in fd.hunks.iter().enumerate() {
            if hi > 0 {
                block = block.child(el().w_full().h(1.0).fill(k.c.border_weak));
            }
            if split && !old.is_empty() {
                let lines = &h.lines[..h.lines.len().min(400usize.saturating_sub(shown))];
                shown += lines.len();
                block = block.children(split_rows(k, lines));
                continue;
            }
            for l in &h.lines {
                if shown >= 400 {
                    break;
                }
                shown += 1;
                let (sign, fill, ink) = match l.kind {
                    LineKind::Added => ("+", k.c.success.bg, k.c.success.fg),
                    LineKind::Removed => ("-", k.c.danger.bg, k.c.danger.fg),
                    _ => (" ", Color::TRANSPARENT, k.c.text_faint),
                };
                block = block.child(
                    row()
                        .w_full()
                        .px(6.0)
                        .gap(6.0)
                        .fill(fill)
                        .child(text(sign).font(k.ty.mono).color(ink).w(10.0))
                        .child(
                            text(if l.text.is_empty() {
                                " ".to_string()
                            } else {
                                l.text.clone()
                            })
                            .font(k.ty.mono)
                            .color(if l.kind == LineKind::Context {
                                k.c.text_muted
                            } else {
                                k.c.text_base
                            })
                            .wrap_anywhere()
                            .grow(1.0)
                            .min_w(0.0)
                            .selectable(true),
                        ),
                );
            }
        }
        c = c.child(block);
    }
    c
}

fn tool_chip(s: &Hooked, session: &str, t: &Tool, k: &Kit, key: String) -> El {
    let id = t.id.clone().unwrap_or_else(|| key.clone());
    let open = s.all_tools_open || s.tools_open.contains(&id);
    let detail = t.detail.clone().unwrap_or_default();
    let changed = t.diff.as_ref().map(diff_lines);
    let big = changed.is_some_and(|n| n > BIG_DIFF);
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
                )
                .child(
                    text(if big {
                        format!("{} lines", changed.unwrap_or(0))
                    } else {
                        String::new()
                    })
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_faint),
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
    if crate::querywin::is_query_tool(&t.name)
        && let Some(tid) = t.id.clone().filter(|_| t.result.is_some())
    {
        let session = session.to_string();
        chip = chip.child(
            row().px(8.0).pb(6.0).child(
                Button::new("View the result")
                    .icon(&icons::CHART)
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Small)
                    .help("Draw the result, then re-run it live through mcp-gateway")
                    .on_press(move |s: &mut Hooked| {
                        s.open_query_result(session.clone(), tid.clone())
                    })
                    .build(k),
            ),
        );
    }
    if let Some(diff) = t.diff.as_ref() {
        if !big || open {
            chip = chip.child(inline_diff(
                k,
                diff,
                s.lens_data.diff.mode() == rune_kit::diff::DiffMode::Split,
            ));
        }
    } else if open {
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
    if let Some(send) = t.send.as_ref() {
        chip = chip.child(sent_files(s, k, send));
    }
    if let Some(show) = t.show.as_ref() {
        chip = chip.child(show_work(s, k, show));
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

fn plan_comments(s: &Hooked, k: &Kit) -> El {
    let quote = |q: &str| {
        row()
            .w_full()
            .pl(8.0)
            .border_sides([0.0, 0.0, 0.0, 2.0], k.c.border_strong)
            .child(
                text(q.to_string())
                    .font(k.ty.text_small)
                    .color(k.c.text_muted)
                    .wrap()
                    .max_lines(4),
            )
    };
    let mut c = col().w_full().gap(8.0);
    for (i, (q, note)) in s.plan_comments.iter().enumerate() {
        c = c.child(
            row()
                .key(format!("pc-{i}"))
                .w_full()
                .gap(8.0)
                .items_start()
                .child(
                    col().grow(1.0).min_w(0.0).gap(4.0).child(quote(q)).child(
                        text(note.clone())
                            .font(k.ty.text_small)
                            .color(k.c.text_base)
                            .wrap(),
                    ),
                )
                .child(
                    Button::new("Remove")
                        .variant(ButtonVariant::GhostFaint)
                        .control_size(ControlSize::Small)
                        .on_press(move |s: &mut Hooked| {
                            if i < s.plan_comments.len() {
                                s.plan_comments.remove(i);
                            }
                        })
                        .build(k),
                ),
        );
    }
    let mut actions = row().w_full().gap(8.0).center_y();
    if let Some(q) = s.plan_quote.as_ref() {
        c = c.child(quote(q));
        actions = actions
            .child(
                Button::new("Add the comment")
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Small)
                    .on_press(|s: &mut Hooked| {
                        let note = s.plan_feedback.text.trim().to_string();
                        if let (Some(q), false) = (s.plan_quote.take(), note.is_empty()) {
                            s.plan_comments.push((q, note));
                            s.plan_feedback = rune::TextEdit::new("");
                        }
                    })
                    .build(k),
            )
            .child(
                Button::new("Drop the quote")
                    .variant(ButtonVariant::GhostMuted)
                    .control_size(ControlSize::Small)
                    .on_press(|s: &mut Hooked| s.plan_quote = None)
                    .build(k),
            );
    } else {
        actions = actions.child(
            Button::new("Comment on the selection")
                .icon(&icons::CONVERSE)
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .help("Select a passage of the plan first")
                .on_press_tx(|s: &mut Hooked, tx| {
                    match tx.text_selection().map(|t| t.text().trim().to_string()) {
                        Some(q) if !q.is_empty() => {
                            s.plan_quote = Some(q);
                            s.plan_feedback.focused = true;
                        }
                        _ => s.flash("Select a passage of the plan first", true),
                    }
                })
                .build(k),
        );
    }
    if !s.plan_comments.is_empty() {
        actions = actions.child(el().grow(1.0)).child(
            text(format!(
                "{} comment{} go out with Keep planning",
                s.plan_comments.len(),
                if s.plan_comments.len() == 1 { "" } else { "s" }
            ))
            .font(k.ty.text_xsmall)
            .color(k.c.text_faint),
        );
    }
    c.child(actions)
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
                .child(super::md(p.plan.clone()).selectable(true).build(k)),
        )
        .child(plan_comments(s, k))
        .child(
            TextInput::new(&s.plan_feedback)
                .placeholder(if s.plan_quote.is_some() {
                    "Your comment on the quoted passage…"
                } else {
                    "Feedback (sent when you keep planning)…"
                })
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
        .on_change(|s: &mut Hooked, _| s.composer_changed())
        .on_key(|s: &mut Hooked, ev: &rune::KeyEvent, _| match ev.key {
            Key::Down if s.ac.is_some() => {
                s.ac_move(1);
                true
            }
            Key::Up if s.ac.is_some() => {
                s.ac_move(-1);
                true
            }
            Key::Tab | Key::Enter if s.ac.is_some() => {
                s.ac_accept(None);
                true
            }
            Key::Escape if s.ac.is_some() => {
                s.ac = None;
                true
            }
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

fn autocomplete(s: &Hooked, k: &Kit) -> El {
    let Some(ac) = s.ac.as_ref() else {
        return el();
    };
    let start = ac.sel.saturating_sub(7);
    let rows = ac
        .items
        .iter()
        .enumerate()
        .skip(start)
        .take(8)
        .map(|(i, it)| {
            let on = i == ac.sel;
            k.interactive(
                row()
                    .key(format!("ac-{i}"))
                    .role("option")
                    .checked(on)
                    .w_full()
                    .h(30.0)
                    .px(10.0)
                    .gap(10.0)
                    .center_y()
                    .radius(k.radius.sm)
                    .cursor(Cursor::Pointer)
                    .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
                    .child(
                        text(it.label.clone())
                            .font(k.ty.text_small_medium)
                            .color(k.c.text_base),
                    )
                    .child(
                        text(it.sub.clone())
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_faint)
                            .truncate()
                            .grow(1.0)
                            .min_w(0.0),
                    )
                    .child(
                        text(it.badge.clone())
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_faint),
                    ),
            )
            .on_press(move |s: &mut Hooked| s.ac_accept(Some(i)))
        });
    col()
        .key("composer-ac")
        .w_full()
        .padding(4.0)
        .gap(1.0)
        .radius(k.radius.md)
        .fill(k.c.bg_base)
        .border(1.0, k.c.border_base)
        .children(rows)
        .child(
            text("↑↓ to choose · Tab or Enter to insert · Esc to close")
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint)
                .px(10.0)
                .py(4.0),
        )
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
    if s.ac.is_some() {
        c = c.child(autocomplete(s, k));
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
