use rune::{Color, Cursor, El, ScrollSpec, col, el, row, text};
use rune_kit::diff::{Annotation, DiffMode, DiffView};
use rune_kit::{
    Button, ButtonVariant, ControlSize, Kit, SegmentedControl, Spinner, TextArea,
    TextInput,
};

use super::{glyph, section_title};
use crate::api::{Detail, McpServer, TraceSpan};
use crate::app::Hooked;
use crate::lenses::ReviewSource;
use crate::{fmt, icons};

fn bar(k: &Kit, key: &str) -> El {
    row()
        .key(key.to_string())
        .w_full()
        .h(44.0)
        .px(16.0)
        .gap(10.0)
        .center_y()
        .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_weak)
}

fn empty(k: &Kit, key: &str, msg: &str) -> El {
    col()
        .key(key.to_string())
        .w_full()
        .grow(1.0)
        .center()
        .child(text(msg.to_string()).font(k.ty.body).color(k.c.text_faint))
}

pub fn review(s: &Hooked, d: &Detail, k: &Kit) -> El {
    let ld = &s.lens_data;
    let src = match ld.review_source {
        ReviewSource::Claude => 0,
        ReviewSource::Tree => 1,
    };
    let split = ld.diff.mode() == DiffMode::Split;
    let mut top = bar(k, "review-bar")
        .child(
            SegmentedControl::new(
                &[
                    format!("Claude's edits · {}", d.changes.len()),
                    "Working tree".to_string(),
                ],
                Some(src),
            )
            .label("Diff source")
            .fit()
            .on_pick(|s: &mut Hooked, i, _| {
                s.set_review_source(if i == 0 {
                    ReviewSource::Claude
                } else {
                    ReviewSource::Tree
                })
            })
            .build(k)
            .key("review-source"),
        )
        .child(
            text(format!(
                "{} file{} · {} hunks",
                ld.diff_count,
                if ld.diff_count == 1 { "" } else { "s" },
                ld.diff.files().iter().map(|f| f.hunks.len()).sum::<usize>()
            ))
            .font(k.ty.text_small)
            .color(k.c.text_faint),
        )
        .child(el().grow(1.0));
    if ld.diff_loading {
        top = top.child(Spinner::new().build(k));
    }
    let pending = s.pending_threads().len();
    if pending > 0 {
        top = top.child(
            Button::new(format!(
                "Send {pending} comment{} to Claude",
                if pending == 1 { "" } else { "s" }
            ))
            .icon(&icons::ARROW_UP)
            .variant(ButtonVariant::Contrast)
            .control_size(ControlSize::Regular)
            .on_press(|s: &mut Hooked| s.send_review())
            .build(k)
            .key("review-send"),
        );
    }
    top = top
        .child(
            text("+ on a line comments · j/k hunks · [/] files")
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        )
        .child(
            SegmentedControl::new(&["Unified", "Split"], Some(usize::from(split)))
                .label("Diff layout")
                .fit()
                .on_pick(|s: &mut Hooked, i, _| {
                    s.lens_data.diff.set_mode(if i == 1 {
                        DiffMode::Split
                    } else {
                        DiffMode::Unified
                    })
                })
                .build(k)
                .key("review-mode"),
        );
    let body = if ld.diff.files().is_empty() {
        let msg = if ld.diff_loading {
            "Reading the working tree…"
        } else if ld.review_source == ReviewSource::Tree {
            "The working tree is clean."
        } else {
            "No file changes in this session yet."
        };
        empty(k, "review-empty", msg)
    } else {
        col()
            .key("review-diff")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .child(
                DiffView::new(
                    |s: &Hooked| &s.lens_data.diff,
                    |s: &mut Hooked| &mut s.lens_data.diff,
                )
                .key("diff")
                .annotation({
                    let k = k.clone();
                    move |s: &Hooked, a: &Annotation| annotation(s, a, &k)
                })
                .on_comment(|s: &mut Hooked, range, _| s.start_comment(range))
                .build(s, k),
            )
    };
    col().key("review").w_full().h_full().child(top).child(body)
}

fn mcp_dot(k: &Kit, state: &str) -> Color {
    match state {
        "connected" => k.c.success.icon,
        "needs-auth" | "needs_auth" | "auth" => k.c.warning.icon,
        "failed" | "error" => k.c.danger.icon,
        _ => k.c.icon_faint,
    }
}

fn mcp_row(s: &Hooked, x: &McpServer, k: &Kit) -> El {
    let open = s.lens_data.mcp_open.as_deref() == Some(x.name.as_str());
    let (n1, n2, n3) = (x.name.clone(), x.name.clone(), x.name.clone());
    let mut actions = row().gap(6.0).center_y().child(
        Button::new(if open { "Hide" } else { "Details" })
            .variant(ButtonVariant::GhostMuted)
            .control_size(ControlSize::Small)
            .on_press(move |s: &mut Hooked| s.mcp_toggle_detail(n1.clone()))
            .build(k)
            .key(format!("mcp-det-{}", x.name)),
    );
    if x.authable {
        actions = actions
            .child(
                Button::new("Re-authenticate")
                    .variant(if x.state == "connected" {
                        ButtonVariant::GhostMuted
                    } else {
                        ButtonVariant::Contrast
                    })
                    .control_size(ControlSize::Small)
                    .on_press(move |s: &mut Hooked| s.mcp_reauth(n2.clone()))
                    .build(k)
                    .key(format!("mcp-auth-{}", x.name)),
            )
            .child(
                Button::new("Log out")
                    .variant(ButtonVariant::GhostMuted)
                    .control_size(ControlSize::Small)
                    .on_press(move |s: &mut Hooked| s.mcp_logout(n3.clone()))
                    .build(k)
                    .key(format!("mcp-out-{}", x.name)),
            );
    }
    let mut card = col()
        .key(format!("mcp-{}", x.name))
        .w_full()
        .padding(10.0)
        .gap(6.0)
        .radius(k.radius.md)
        .fill(k.c.layer_01)
        .border(1.0, k.c.border_weak)
        .child(
            row()
                .w_full()
                .gap(10.0)
                .center_y()
                .child(el().size(8.0, 8.0).radius(4.0).fill(mcp_dot(k, &x.state)))
                .child(
                    text(x.name.clone())
                        .font(k.ty.ui_medium)
                        .color(k.c.text_base),
                )
                .child(
                    text(format!(
                        "{} · {}",
                        x.transport.clone().unwrap_or_default(),
                        x.target.clone().unwrap_or_default()
                    ))
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_faint)
                    .truncate()
                    .grow(1.0)
                    .shrink(),
                )
                .child(
                    text(x.status.clone().unwrap_or_else(|| x.state.clone()))
                        .font(k.ty.text_small)
                        .color(k.c.text_muted),
                )
                .child(actions),
        );
    if open {
        let raw = s
            .lens_data
            .mcp_detail
            .get(&x.name)
            .cloned()
            .unwrap_or_else(|| "Loading…".into());
        card = card.child(
            text(raw)
                .font(k.ty.mono)
                .color(k.c.text_muted)
                .wrap_anywhere()
                .selectable(true),
        );
    }
    card
}

fn mcp_login(s: &Hooked, k: &Kit) -> El {
    let Some(l) = s.lens_data.mcp_login.as_ref() else {
        return el();
    };
    let mut c = col()
        .key("mcp-login")
        .w_full()
        .padding(14.0)
        .gap(10.0)
        .radius(k.radius.lg)
        .fill(k.c.surface_raised)
        .border(1.0, k.c.info.border)
        .child(
            row()
                .gap(8.0)
                .center_y()
                .child(
                    text(format!("Signing in to {}", l.name))
                        .font(k.ty.ui_medium)
                        .color(k.c.text_base),
                )
                .child(el().grow(1.0))
                .child(if l.done {
                    el()
                } else {
                    Spinner::new().build(k)
                }),
        );
    if let Some(url) = l.url.clone() {
        c = c.child(
            row()
                .gap(8.0)
                .center_y()
                .child(
                    Button::new("Open the sign-in page")
                        .icon(&icons::LINK)
                        .variant(ButtonVariant::Contrast)
                        .on_press_tx({
                            let url = url.clone();
                            move |_: &mut Hooked, tx| {
                                let _ = tx.open_url(&url);
                            }
                        })
                        .build(k)
                        .key("mcp-login-open"),
                )
                .child(
                    text(url)
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint)
                        .truncate()
                        .shrink(),
                ),
        );
    }
    if l.done {
        let msg = if l.out_of_band {
            "Finish the approval on claude.ai; the connector picks it up next time Claude Code starts."
        } else if l.exit_code == Some(0) {
            "Signed in."
        } else {
            "The login ended without success; see the output below."
        };
        c = c.child(text(msg).font(k.ty.ui).color(k.c.text_muted).wrap());
    } else if l.needs_paste {
        c = c.child(
            TextInput::new(&s.lens_data.mcp_redirect)
                .placeholder("Paste the redirect URL from the browser…")
                .width(None)
                .on_edit(|s: &mut Hooked| &mut s.lens_data.mcp_redirect)
                .on_submit(|s: &mut Hooked, _| s.mcp_send_redirect())
                .build(k)
                .key("mcp-redirect"),
        );
    }
    if !l.output.trim().is_empty() {
        c = c.child(
            col()
                .w_full()
                .max_h(160.0)
                .scroll(ScrollSpec { stick_bottom: true })
                .child(
                    text(l.output.trim().to_string())
                        .font(k.ty.mono)
                        .color(k.c.text_faint)
                        .wrap_anywhere(),
                ),
        );
    }
    c.child(
        row().justify_end().child(
            Button::new(if l.done { "Close" } else { "Cancel" })
                .variant(ButtonVariant::Outline)
                .on_press(|s: &mut Hooked| s.mcp_cancel_login())
                .build(k)
                .key("mcp-login-cancel"),
        ),
    )
}

pub fn mcp(s: &Hooked, d: &Detail, k: &Kit) -> El {
    let ld = &s.lens_data;
    let project = d.session.project.clone().unwrap_or_default();
    let mut top = bar(k, "mcp-bar")
        .child(glyph(&icons::PLUG, 14.0, k.c.icon_muted))
        .child(
            text(format!("MCP servers · {project}"))
                .font(k.ty.ui_medium)
                .color(k.c.text_base)
                .truncate()
                .shrink(),
        )
        .child(el().grow(1.0));
    if ld.mcp_loading {
        top = top
            .child(
                text("health-checking…")
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_faint),
            )
            .child(Spinner::new().build(k));
    }
    top = top.child(
        Button::new("Refresh")
            .icon(&icons::RESTART)
            .variant(ButtonVariant::GhostMuted)
            .control_size(ControlSize::Small)
            .disabled(ld.mcp_loading)
            .on_press(|s: &mut Hooked| s.load_mcp(false))
            .build(k)
            .key("mcp-refresh"),
    );
    let mut list = col()
        .key("mcp-list")
        .w_full()
        .max_w(1000.0)
        .self_center()
        .padding(16.0)
        .gap(8.0);
    if let Some(n) = ld.mcp_notice.as_ref() {
        list = list.child(text(n.clone()).font(k.ty.ui).color(k.c.text_muted));
    }
    list = list.child(mcp_login(s, k));
    let mut scope = None;
    for x in &ld.mcp {
        if scope.as_ref() != Some(&x.scope_label) {
            scope = Some(x.scope_label.clone());
            list = list.child(
                row().pt(8.0).child(section_title(
                    k,
                    &x.scope_label
                        .clone()
                        .unwrap_or_else(|| "Other".into())
                        .to_uppercase(),
                )),
            );
        }
        list = list.child(mcp_row(s, x, k));
    }
    if ld.mcp.is_empty() && !ld.mcp_loading {
        list = list.child(
            text("No MCP servers for this project.")
                .font(k.ty.body)
                .color(k.c.text_faint),
        );
    }
    col().key("mcp").w_full().h_full().child(top).child(
        col()
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .child(list),
    )
}

fn dur(ms: f64) -> String {
    if ms < 1000.0 {
        format!("{ms:.0}ms")
    } else if ms < 60_000.0 {
        format!("{:.1}s", ms / 1000.0)
    } else {
        format!(
            "{}m{}s",
            (ms / 60_000.0) as i64,
            ((ms % 60_000.0) / 1000.0) as i64
        )
    }
}

fn span_row(s: &Hooked, sp: &TraceSpan, t0: f64, total: f64, k: &Kit) -> El {
    let end = sp.end.unwrap_or(s.now as f64);
    let off = ((sp.start - t0) / total).clamp(0.0, 1.0) as f32;
    let len = (((end - sp.start) / total) as f32)
        .max(0.004)
        .min((1.0 - off).max(0.0));
    let open = s.lens_data.trace_open.as_deref() == Some(sp.id.as_str());
    let color = if sp.error {
        k.c.danger.icon
    } else if sp.end.is_none() {
        k.c.info.icon
    } else {
        k.c.icon_muted
    };
    let id = sp.id.clone();
    let head = k
        .interactive(
            row()
                .key(format!("span-{}", sp.id))
                .role("button")
                .expanded(open)
                .w_full()
                .h(26.0)
                .px(6.0)
                .gap(10.0)
                .center_y()
                .radius(k.radius.sm)
                .cursor(Cursor::Pointer)
                .child(
                    text(sp.name.clone())
                        .font(k.ty.text_small_medium)
                        .color(k.c.text_muted)
                        .w(110.0)
                        .truncate(),
                )
                .child(
                    text(sp.detail.clone().unwrap_or_default())
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint)
                        .truncate()
                        .w(280.0),
                )
                .child(
                    row()
                        .grow(1.0)
                        .h(8.0)
                        .radius(2.0)
                        .fill(k.c.layer_02)
                        .child(el().w_frac(off).h(8.0))
                        .child(el().w_frac(len).h(8.0).radius(2.0).fill(color)),
                )
                .child(
                    text(dur(end - sp.start))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint)
                        .w(56.0),
                ),
        )
        .on_press(move |s: &mut Hooked| s.trace_toggle(id.clone()));
    let mut c = col().key(format!("spanc-{}", sp.id)).w_full().child(head);
    if open {
        let (input, result) = s
            .lens_data
            .trace_tool
            .get(&sp.id)
            .cloned()
            .unwrap_or(("Loading…".into(), String::new()));
        let block = |label: &str, body: String| {
            col()
                .w_full()
                .gap(4.0)
                .px(12.0)
                .pb(8.0)
                .child(
                    text(label.to_string())
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.text_faint),
                )
                .child(
                    text(clip(&body, 40))
                        .font(k.ty.mono)
                        .color(k.c.text_muted)
                        .wrap_anywhere()
                        .selectable(true),
                )
        };
        c = c.child(block("Input", input));
        if !result.is_empty() {
            c = c.child(block("Result", result));
        }
    }
    c
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

pub fn trace(s: &Hooked, k: &Kit) -> El {
    let ld = &s.lens_data;
    let spans: usize = ld.trace.iter().map(|t| t.spans.len()).sum();
    let mut top = bar(k, "trace-bar")
        .child(glyph(&icons::ACTIVITY, 14.0, k.c.icon_muted))
        .child(
            text(format!("{} turns · {spans} tool calls", ld.trace.len()))
                .font(k.ty.ui_medium)
                .color(k.c.text_base),
        )
        .child(el().grow(1.0));
    if ld.trace_loading {
        top = top.child(Spinner::new().build(k));
    }
    let mut list = col().key("trace-list").w_full().padding(16.0).gap(16.0);
    for (ti, t) in ld.trace.iter().enumerate().rev() {
        let end = t.end.unwrap_or(s.now as f64);
        let total = (end - t.start).max(1.0);
        let mut turn = col().key(format!("turn-{ti}")).w_full().gap(2.0).child(
            row()
                .w_full()
                .gap(10.0)
                .pb(4.0)
                .center_y()
                .child(
                    text(format!("Turn {}", ti + 1))
                        .font(k.ty.text_small_medium)
                        .color(k.c.text_base),
                )
                .child(
                    text(fmt::first_line(t.prompt.as_deref().unwrap_or(""), 120))
                        .font(k.ty.text_small)
                        .color(k.c.text_muted)
                        .truncate()
                        .grow(1.0)
                        .shrink(),
                )
                .child(
                    text(format!("{} · {} calls", dur(total), t.spans.len()))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                ),
        );
        for sp in &t.spans {
            turn = turn.child(span_row(s, sp, t.start, total, k));
        }
        list = list.child(turn);
    }
    if ld.trace.is_empty() && !ld.trace_loading {
        list = list.child(
            text("No tool calls yet.")
                .font(k.ty.body)
                .color(k.c.text_faint),
        );
    }
    col().key("trace").w_full().h_full().child(top).child(
        col()
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .child(list),
    )
}

fn annotation(s: &Hooked, a: &Annotation, k: &Kit) -> El {
    let shell = |key: String| {
        col()
            .key(key)
            .w_full()
            .max_w(720.0)
            .mx(12.0)
            .my(6.0)
            .padding(12.0)
            .gap(8.0)
            .radius(k.radius.md)
            .fill(k.c.surface_raised)
            .border(1.0, k.c.border_base)
    };
    if a.id == "draft" {
        let Some((_, edit)) = s.lens_data.draft.as_ref() else {
            return el();
        };
        return shell("draft".into())
            .child(
                TextArea::new(edit)
                    .placeholder("Comment on these lines… (⌘Enter saves)")
                    .width(None)
                    .auto_grow(2, 10)
                    .on_edit(|s: &mut Hooked| &mut s.lens_data.draft.as_mut().expect("draft").1)
                    .on_key(|s: &mut Hooked, ev: &rune::KeyEvent, _| match ev.key {
                        rune::Key::Enter if ev.mods.cmd => {
                            s.save_comment();
                            true
                        }
                        rune::Key::Escape => {
                            s.cancel_comment();
                            true
                        }
                        _ => false,
                    })
                    .build(k)
                    .key("draft-field"),
            )
            .child(
                row()
                    .gap(8.0)
                    .justify_end()
                    .child(
                        Button::new("Cancel")
                            .variant(ButtonVariant::GhostMuted)
                            .control_size(ControlSize::Small)
                            .on_press(|s: &mut Hooked| s.cancel_comment())
                            .build(k)
                            .key("draft-cancel"),
                    )
                    .child(
                        Button::new("Comment")
                            .variant(ButtonVariant::Contrast)
                            .control_size(ControlSize::Small)
                            .on_press(|s: &mut Hooked| s.save_comment())
                            .build(k)
                            .key("draft-save"),
                    ),
            );
    }
    let Some(t) = s
        .lens_data
        .threads
        .iter()
        .find(|t| t["id"].as_str() == Some(a.id.as_str()))
    else {
        return el();
    };
    let tid = a.id.clone();
    let sent = t["sent"].as_bool() == Some(true);
    let archived = t["status"].as_str() == Some("archived");
    let status = if archived {
        ("archived", k.c.text_faint)
    } else if sent {
        ("sent", k.c.info.fg)
    } else {
        ("pending · not sent yet", k.c.warning.fg)
    };
    let (t1, t2, t3) = (tid.clone(), tid.clone(), tid.clone());
    let mut c = shell(format!("thread-{tid}")).child(
        row()
            .w_full()
            .gap(8.0)
            .center_y()
            .child(text(status.0).font(k.ty.text_xsmall_medium).color(status.1))
            .child(el().grow(1.0))
            .child(
                Button::new(if archived { "Reopen" } else { "Archive" })
                    .variant(ButtonVariant::GhostMuted)
                    .control_size(ControlSize::Small)
                    .on_press(move |s: &mut Hooked| s.archive_thread(t1.clone(), !archived))
                    .build(k)
                    .key(format!("th-arch-{tid}")),
            )
            .child(
                Button::new("Delete")
                    .variant(ButtonVariant::GhostMuted)
                    .control_size(ControlSize::Small)
                    .on_press(move |s: &mut Hooked| s.delete_thread(t2.clone()))
                    .build(k)
                    .key(format!("th-del-{tid}")),
            ),
    );
    if archived {
        return c;
    }
    for (i, m) in t["messages"].as_array().into_iter().flatten().enumerate() {
        let claude = m["author"].as_str() == Some("claude");
        c = c.child(
            col()
                .key(format!("th-{tid}-{i}"))
                .w_full()
                .gap(2.0)
                .child(
                    text(if claude { "Claude" } else { "You" })
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.text_faint),
                )
                .child(super::md(m["text"].as_str().unwrap_or("").to_string()).build(k)),
        );
    }
    if sent {
        let empty = rune::TextEdit::new("");
        let edit = s.lens_data.replies.get(&tid).unwrap_or(&empty);
        c = c.child(
            TextInput::new(edit)
                .placeholder("Reply…")
                .width(None)
                .on_edit(move |s: &mut Hooked| {
                    s.lens_data
                        .replies
                        .entry(t3.clone())
                        .or_insert_with(|| rune::TextEdit::new(""))
                })
                .on_submit({
                    let tid = tid.clone();
                    move |s: &mut Hooked, _| s.reply_thread(tid.clone())
                })
                .build(k)
                .key(format!("th-reply-{tid}")),
        );
    }
    c
}
