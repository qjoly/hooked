use rune::{Color, Cursor, El, ScrollSpec, col, el, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit};
use serde_json::Value;

use super::{dot, glyph, pill, section_title};
use crate::api::Detail;
use crate::app::{Hooked, Lens};
use crate::sections::wake_label;
use crate::{fmt, icons};

fn has_content(d: &Detail) -> bool {
    !d.todos.is_empty()
        || !d.changes.is_empty()
        || !d.subagents.is_empty()
        || !d.sub_sessions.is_empty()
        || !d.workflows.is_empty()
        || !d.bg_jobs.is_empty()
        || !d.pr_links.is_empty()
        || !d.issue_links.is_empty()
        || !d.screenshots.is_empty()
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}

fn num_of(v: &Value, key: &str) -> f64 {
    v[key]
        .as_f64()
        .or_else(|| v[key].as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0.0)
}

/// A card whose header toggles it open: `count` sits on the right, then the chevron.
fn card(
    s: &Hooked,
    k: &Kit,
    key: &'static str,
    i: &'static rune::Icon,
    title: &str,
    count: String,
) -> (El, bool) {
    let open = s.dock_cards.contains(key);
    let head = k
        .interactive(
            row()
                .key(format!("{key}-head"))
                .role("button")
                .expanded(open)
                .w_full()
                .gap(6.0)
                .center_y()
                .radius(k.radius.sm)
                .cursor(Cursor::Pointer)
                .child(glyph(i, 13.0, k.c.icon_muted))
                .child(
                    text(title.to_string())
                        .font(k.ty.ui_medium)
                        .color(k.c.text_base),
                )
                .child(el().grow(1.0))
                .child(text(count).font(k.ty.text_xsmall).color(k.c.text_faint))
                .child(glyph(
                    if open {
                        &icons::CHEVRON_DOWN
                    } else {
                        &icons::ARROW_RIGHT
                    },
                    11.0,
                    k.c.icon_faint,
                )),
        )
        .on_press(move |s: &mut Hooked| s.toggle_card(key));
    let c = col()
        .key(key.to_string())
        .w_full()
        .padding(10.0)
        .gap(6.0)
        .radius(k.radius.md)
        .fill(k.c.layer_01)
        .border(1.0, k.c.border_weak)
        .child(head);
    (c, open)
}

fn item(k: &Kit, mark: &'static rune::Icon, mark_color: Color, label: String, strong: bool) -> El {
    row()
        .w_full()
        .gap(6.0)
        .child(glyph(mark, 12.0, mark_color))
        .child(
            text(label)
                .font(k.ty.text_small)
                .color(if strong {
                    k.c.text_base
                } else {
                    k.c.text_muted
                })
                .wrap()
                .grow(1.0)
                .min_w(0.0),
        )
}

fn tasks(s: &Hooked, d: &Detail, k: &Kit) -> El {
    let done = d.todos.iter().filter(|t| t.status == "completed").count();
    let pct = done as f32 / d.todos.len() as f32;
    let (mut c, open) = card(
        s,
        k,
        "dock-todos",
        &icons::TASKS,
        "Tasks",
        format!("{done}/{}", d.todos.len()),
    );
    c = c.child(
        el().w_full()
            .h(3.0)
            .radius(1.5)
            .fill(k.c.layer_03)
            .child(el().w_frac(pct).h(3.0).radius(1.5).fill(k.c.success.icon)),
    );
    let shown: Vec<_> = if open {
        d.todos.iter().collect()
    } else {
        d.todos
            .iter()
            .filter(|t| t.status == "in_progress")
            .chain(d.todos.iter().filter(|t| t.status == "pending").take(3))
            .collect()
    };
    for t in shown {
        let (mark, color, strong) = match t.status.as_str() {
            "completed" => (&icons::CIRCLE_CHECK, k.c.success.icon, false),
            "in_progress" => (&icons::CIRCLE_DOT, k.c.info.icon, true),
            _ => (&icons::CIRCLE, k.c.icon_faint, false),
        };
        let label = if t.status == "in_progress" {
            t.active_form.clone().unwrap_or_else(|| t.content.clone())
        } else {
            t.content.clone()
        };
        c = c.child(item(k, mark, color, label, strong));
    }
    c
}

fn changes(s: &Hooked, d: &Detail, k: &Kit) -> El {
    let n = d.changes.len();
    let (mut c, open) = card(
        s,
        k,
        "dock-changes",
        &icons::DIFF,
        "Changes",
        format!("{n} file{}", if n == 1 { "" } else { "s" }),
    );
    for ch in d.changes.iter().take(if open { 200 } else { 6 }) {
        c = c.child(
            row()
                .w_full()
                .gap(6.0)
                .help(ch.file.clone())
                .child(
                    text(ch.label())
                        .font(k.ty.text_small)
                        .color(k.c.text_muted)
                        .truncate()
                        .grow(1.0)
                        .min_w(0.0),
                )
                .child(
                    text(if ch.ops.len() > 1 {
                        format!("{} edits", ch.ops.len())
                    } else {
                        String::new()
                    })
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_faint),
                ),
        );
    }
    c.child(
        k.interactive(
            row()
                .key("dock-open-review")
                .role("button")
                .h(24.0)
                .px(6.0)
                .center_y()
                .radius(k.radius.sm)
                .cursor(Cursor::Pointer)
                .child(
                    text(if n > 6 && !open {
                        format!("+{} more · open Review →", n - 6)
                    } else {
                        "Open Review →".into()
                    })
                    .font(k.ty.text_small_medium)
                    .color(k.c.text_accent),
                ),
        )
        .on_press(|s: &mut Hooked| s.lens = Lens::Review),
    )
}

fn workflows(s: &Hooked, d: &Detail, k: &Kit) -> El {
    let running = d
        .workflows
        .iter()
        .filter(|w| str_of(w, "status") == "running")
        .count();
    let count = if running > 0 {
        format!("{running} running")
    } else {
        d.workflows.len().to_string()
    };
    let (mut c, _) = card(s, k, "dock-workflows", &icons::ACTIVITY, "Workflows", count);
    for w in &d.workflows {
        let state = match str_of(w, "status") {
            "running" => "working",
            "failed" | "error" | "killed" => "attention",
            "completed" | "done" => "ended",
            _ => "idle",
        };
        c = c.child(
            row()
                .w_full()
                .gap(6.0)
                .center_y()
                .child(dot(k, state, 7.0))
                .child(
                    text(str_of(w, "name").to_string())
                        .font(k.ty.mono)
                        .color(k.c.text_muted)
                        .truncate()
                        .grow(1.0)
                        .min_w(0.0),
                )
                .child(
                    text(format!(
                        "{:.0}/{:.0}",
                        num_of(w, "doneCount"),
                        num_of(w, "agentCount")
                    ))
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_faint),
                ),
        );
    }
    c
}

fn agents(s: &Hooked, d: &Detail, k: &Kit) -> El {
    let cost: f64 = d.subagents.iter().map(|a| num_of(a, "cost")).sum();
    let (mut c, open) = card(
        s,
        k,
        "dock-agents",
        &icons::BOT,
        "Agents",
        format!("{} · {}", d.subagents.len(), fmt::cost(Some(cost))),
    );
    for a in d.subagents.iter().take(if open { 100 } else { 3 }) {
        let id = str_of(a, "id").to_string();
        let kind = Some(str_of(a, "type"))
            .filter(|t| !t.is_empty())
            .unwrap_or("agent");
        let label = match str_of(a, "description") {
            "" => kind.to_string(),
            dsc => format!("{kind} · {dsc}"),
        };
        if !open {
            c = c.child(item(k, &icons::BOT, k.c.icon_faint, label, false));
            continue;
        }
        let expanded = s.dock_agent.as_deref() == Some(id.as_str());
        let meta = format!(
            "{} · {} tokens · {:.0}s · {}",
            fmt::short_model(str_of(a, "model")),
            num_of(a, "totalTokens") as u64,
            num_of(a, "durationMs") / 1000.0,
            fmt::cost(Some(num_of(a, "cost")))
        );
        let toggle = id.clone();
        let mut b = col()
            .key(format!("agent-{id}"))
            .w_full()
            .gap(4.0)
            .py(4.0)
            .border_sides([1.0, 0.0, 0.0, 0.0], k.c.border_weak)
            .child(
                k.interactive(
                    col()
                        .role("button")
                        .expanded(expanded)
                        .w_full()
                        .gap(2.0)
                        .cursor(Cursor::Pointer)
                        .child(
                            text(label.clone())
                                .font(k.ty.text_small_medium)
                                .color(k.c.text_base)
                                .wrap(),
                        )
                        .child(text(meta).font(k.ty.text_xsmall).color(k.c.text_faint)),
                )
                .on_press(move |s: &mut Hooked| {
                    s.dock_agent = if s.dock_agent.as_deref() == Some(toggle.as_str()) {
                        None
                    } else {
                        Some(toggle.clone())
                    }
                }),
            );
        if expanded {
            b = b
                .child(section_title(k, "PROMPT"))
                .child(
                    text(fmt::first_line(str_of(a, "prompt"), 2000))
                        .font(k.ty.text_small)
                        .color(k.c.text_muted)
                        .wrap(),
                )
                .child(section_title(k, "REPORT"))
                .child(super::md(str_of(a, "result").to_string()).build(k));
            if let Some(agent) = a["agentId"].as_str().map(str::to_string) {
                let title = label.clone();
                b = b.child(
                    Button::new("Transcript")
                        .icon(&icons::CONVERSE)
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Small)
                        .help("Everything this agent did, message by message")
                        .on_press(move |s: &mut Hooked| s.open_agent(agent.clone(), title.clone()))
                        .build(k),
                );
            }
        }
        c = c.child(b);
    }
    c
}

fn sub_sessions(s: &Hooked, d: &Detail, k: &Kit) -> El {
    let (mut c, _) = card(
        s,
        k,
        "dock-subs",
        &icons::LINK,
        "Sub-sessions",
        d.sub_sessions.len().to_string(),
    );
    for sub in &d.sub_sessions {
        let id = sub.id.clone();
        let known = s.session(&sub.id);
        let label = sub
            .label
            .clone()
            .filter(|l| !l.is_empty())
            .or_else(|| known.map(|x| s.title_of(x)))
            .unwrap_or_else(|| sub.id.clone());
        let state = known.map_or("idle", |x| x.state.as_str());
        c = c.child(
            k.interactive(
                row()
                    .key(format!("sub-{}", sub.id))
                    .role("link")
                    .w_full()
                    .py(2.0)
                    .px(4.0)
                    .gap(6.0)
                    .center_y()
                    .radius(k.radius.sm)
                    .cursor(Cursor::Pointer)
                    .child(dot(k, state, 7.0))
                    .child(
                        text(label)
                            .font(k.ty.text_small)
                            .color(k.c.text_accent)
                            .truncate()
                            .grow(1.0)
                            .min_w(0.0),
                    ),
            )
            .on_press(move |s: &mut Hooked| s.open_session(&id)),
        );
    }
    c
}

fn jobs(s: &Hooked, d: &Detail, k: &Kit) -> El {
    let running = d
        .bg_jobs
        .iter()
        .filter(|j| j["done"].as_bool() != Some(true))
        .count();
    let (mut c, open) = card(
        s,
        k,
        "dock-jobs",
        &icons::TERMINAL,
        "Background",
        format!("{running} running · {}", d.bg_jobs.len()),
    );
    let mut list: Vec<&Value> = d.bg_jobs.iter().collect();
    list.sort_by_key(|j| j["done"].as_bool() == Some(true));
    for j in list.into_iter().take(if open { 100 } else { 3 }) {
        let done = j["done"].as_bool() == Some(true);
        let failed = done && j["exitCode"].as_i64().is_some_and(|c| c != 0);
        let state = if !done {
            "working"
        } else if failed {
            "attention"
        } else {
            "ended"
        };
        let label = Some(str_of(j, "description"))
            .filter(|x| !x.is_empty())
            .unwrap_or(str_of(j, "label"))
            .to_string();
        let status = if done {
            j["exitCode"].as_i64().map_or_else(
                || str_of(j, "doneReason").to_string(),
                |c| format!("exit {c}"),
            )
        } else {
            "running".into()
        };
        let output = str_of(j, "outputPath").to_string();
        let task = str_of(j, "taskId").to_string();
        let showing = s.job_log.as_ref().filter(|(t, _)| *t == task);
        let mut r = row()
            .key(format!("job-{}", str_of(j, "taskId")))
            .w_full()
            .gap(6.0)
            .center_y()
            .help(str_of(j, "command").to_string())
            .child(dot(k, state, 7.0))
            .child(
                text(label)
                    .font(k.ty.text_small)
                    .color(k.c.text_muted)
                    .truncate()
                    .grow(1.0)
                    .min_w(0.0),
            )
            .child(text(status).font(k.ty.text_xsmall).color(k.c.text_faint));
        if !task.is_empty() {
            let t = task.clone();
            r = k
                .interactive(r.role("button").cursor(Cursor::Pointer))
                .on_press(move |s: &mut Hooked| s.toggle_job_log(t.clone()));
        }
        c = c.child(r);
        if let Some((_, log)) = showing {
            let tail: Vec<&str> = log.lines().rev().take(200).collect();
            let body = if tail.is_empty() {
                "waiting for output…".to_string()
            } else {
                tail.into_iter().rev().collect::<Vec<_>>().join("\n")
            };
            let mut block = col()
                .key(format!("job-log-{task}"))
                .w_full()
                .gap(6.0)
                .child(
                    col()
                        .w_full()
                        .max_h(260.0)
                        .padding(8.0)
                        .radius(k.radius.sm)
                        .fill(k.c.layer_02)
                        .scroll(ScrollSpec { stick_bottom: true })
                        .child(
                            text(body)
                                .font(k.ty.mono)
                                .color(k.c.text_muted)
                                .wrap_anywhere()
                                .selectable(true),
                        ),
                );
            if !output.is_empty() {
                block = block.child(
                    Button::new("Open the file")
                        .variant(ButtonVariant::GhostMuted)
                        .control_size(ControlSize::Small)
                        .on_press_tx(move |_: &mut Hooked, tx| {
                            let _ = tx.open_url(&format!("file://{output}"));
                        })
                        .build(k),
                );
            }
            c = c.child(block);
        }
    }
    c
}

fn links(s: &Hooked, d: &Detail, k: &Kit) -> El {
    let all: Vec<&String> = d.pr_links.iter().chain(d.issue_links.iter()).collect();
    let mut c = col()
        .key("dock-links")
        .w_full()
        .padding(10.0)
        .gap(6.0)
        .radius(k.radius.md)
        .fill(k.c.layer_01)
        .border(1.0, k.c.border_weak)
        .child(
            row()
                .w_full()
                .gap(6.0)
                .center_y()
                .child(glyph(&icons::GITHUB, 13.0, k.c.icon_muted))
                .child(text("Links").font(k.ty.ui_medium).color(k.c.text_base))
                .child(el().grow(1.0))
                .child(
                    text(all.len().to_string())
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                ),
        );
    let pills = row()
        .w_full()
        .gap(6.0)
        .flex_wrap()
        .children(all.iter().map(|l| {
            let pr = l.contains("/pull/") || l.contains("/merge_requests/");
            let label = crate::fmt::link_label(l);
            let on = s.gh_open.as_deref() == Some(l.as_str());
            let url = (*l).clone();
            k.interactive(
                row()
                    .key(format!("gh-{l}"))
                    .role("button")
                    .checked(on)
                    .h(22.0)
                    .px(8.0)
                    .gap(5.0)
                    .center_y()
                    .radius(k.radius.sm)
                    .cursor(Cursor::Pointer)
                    .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
                    .border(
                        1.0,
                        if on {
                            k.c.border_focus
                        } else {
                            k.c.border_weak
                        },
                    )
                    .help((*l).clone())
                    .child(glyph(
                        if pr {
                            &icons::PULL_REQUEST
                        } else {
                            &icons::CIRCLE_DOT
                        },
                        12.0,
                        k.c.icon_muted,
                    ))
                    .child(
                        text(label)
                            .font(k.ty.text_small_medium)
                            .color(k.c.text_base),
                    ),
            )
            .on_press(move |s: &mut Hooked| s.open_gh(url.clone()))
        }));
    c = c.child(pills);
    if let Some(url) = s.gh_open.clone().filter(|u| all.iter().any(|l| **l == *u)) {
        let mut detail = col()
            .key("gh-detail")
            .w_full()
            .gap(6.0)
            .pt(4.0)
            .border_sides([1.0, 0.0, 0.0, 0.0], k.c.border_weak);
        match s.gh.get(&url) {
            None => {
                detail = detail.child(text("Loading…").font(k.ty.text_small).color(k.c.text_faint))
            }
            Some(v) if v.get("error").is_some() => {
                detail = detail.child(
                    text(str_of(v, "error").to_string())
                        .font(k.ty.text_small)
                        .color(k.c.danger.fg)
                        .wrap(),
                )
            }
            Some(v) => {
                let state = str_of(v, "state");
                let (fg, bg) = match state {
                    "MERGED" => (k.c.info.fg, k.c.info.bg),
                    "CLOSED" => (k.c.danger.fg, k.c.danger.bg),
                    _ => (k.c.success.fg, k.c.success.bg),
                };
                let mut tags =
                    row()
                        .gap(6.0)
                        .flex_wrap()
                        .child(pill(k, state.to_lowercase(), fg, bg));
                match str_of(v, "reviewDecision") {
                    "APPROVED" => {
                        tags = tags.child(pill(k, "approved", k.c.success.fg, k.c.success.bg))
                    }
                    "CHANGES_REQUESTED" => {
                        tags =
                            tags.child(pill(k, "changes requested", k.c.danger.fg, k.c.danger.bg))
                    }
                    "REVIEW_REQUIRED" => {
                        tags = tags.child(pill(k, "review required", k.c.text_muted, k.c.layer_02))
                    }
                    _ => {}
                }
                detail = detail
                    .child(
                        text(str_of(v, "title").to_string())
                            .font(k.ty.text_small_medium)
                            .color(k.c.text_base)
                            .wrap(),
                    )
                    .child(tags)
                    .child(
                        text(format!("by {}", str_of(v, "author")))
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_faint),
                    );
            }
        }
        if let Some(checks) = s.gh_checks.get(&url).filter(|c| !c.is_empty()) {
            let rank = |st: &str| match st {
                "failed" | "cancelled" => 0,
                "pending" => 1,
                _ => 2,
            };
            let mut list: Vec<&Value> = checks.iter().collect();
            list.sort_by_key(|c| rank(str_of(c, "status")));
            let failing = list
                .iter()
                .filter(|c| rank(str_of(c, "status")) == 0)
                .count();
            let running = list
                .iter()
                .filter(|c| str_of(c, "status") == "pending")
                .count();
            detail = detail.child(
                text(if failing > 0 {
                    format!("{failing} of {} checks failing", list.len())
                } else if running > 0 {
                    format!("{running} of {} checks running", list.len())
                } else {
                    "All checks passed".to_string()
                })
                .font(k.ty.text_xsmall_medium)
                .color(if failing > 0 {
                    k.c.danger.fg
                } else {
                    k.c.text_muted
                }),
            );
            for (i, c) in list.into_iter().enumerate() {
                let link = str_of(c, "url").to_string();
                detail = detail.child(
                    k.interactive(
                        row()
                            .key(format!("check-{i}"))
                            .role("link")
                            .w_full()
                            .gap(6.0)
                            .center_y()
                            .cursor(Cursor::Pointer)
                            .help(str_of(c, "workflow").to_string())
                            .child(dot(k, super::ghrun::state_of(str_of(c, "status")), 7.0))
                            .child(
                                text(str_of(c, "name").to_string())
                                    .font(k.ty.text_small)
                                    .color(k.c.text_muted)
                                    .truncate()
                                    .grow(1.0)
                                    .min_w(0.0),
                            ),
                    )
                    .on_press_tx(move |s: &mut Hooked, tx| crate::app::open_link(s, &link, tx)),
                );
            }
        }
        let open_url = url.clone();
        let full_url = url.clone();
        detail = detail.child(
            row()
                .gap(4.0)
                .flex_wrap()
                .child(
                    Button::new("Details")
                        .icon(&icons::PANEL_RIGHT)
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Small)
                        .on_press(move |s: &mut Hooked| s.open_gh_full(full_url.clone()))
                        .build(k),
                )
                .child(
                    Button::new("Open on GitHub")
                        .icon(&icons::LINK)
                        .variant(ButtonVariant::GhostMuted)
                        .control_size(ControlSize::Small)
                        .on_press_tx(move |_: &mut Hooked, tx| {
                            let _ = tx.open_url(&open_url);
                        })
                        .build(k),
                ),
        );
        c = c.child(detail);
    }
    c
}

fn screenshots(s: &Hooked, d: &Detail, k: &Kit) -> El {
    let (c, open) = card(
        s,
        k,
        "dock-shots",
        &icons::IMAGE,
        "Screenshots",
        d.screenshots.len().to_string(),
    );
    let mut shots: Vec<&Value> = d.screenshots.iter().collect();
    shots.sort_by(|a, b| str_of(b, "ts").cmp(str_of(a, "ts")));
    let all: Vec<String> = shots
        .iter()
        .map(|x| str_of(x, "path").to_string())
        .collect();
    let grid = row().w_full().gap(6.0).flex_wrap().children(
        shots
            .into_iter()
            .take(if open { 60 } else { 4 })
            .enumerate()
            .map(|(i, shot)| {
                let path = str_of(shot, "path").to_string();
                let all = all.clone();
                let mut tile = el()
                    .key(format!("shot-{path}"))
                    .size(122.0, 76.0)
                    .radius(k.radius.sm)
                    .fill(k.c.layer_02)
                    .border(1.0, k.c.border_weak)
                    .help(str_of(shot, "name").to_string());
                if let Some(Some(img)) = s.media.get(&path) {
                    tile = tile.pixels(img.pixels());
                }
                k.interactive(tile.role("link").cursor(Cursor::Pointer))
                    .on_press(move |s: &mut Hooked| s.open_image(all.clone(), i))
            }),
    );
    c.child(grid)
}

fn action(
    k: &Kit,
    key: &str,
    icon: &'static rune::Icon,
    label: String,
    help: &str,
    on: bool,
    danger: bool,
    f: impl Fn(&mut Hooked) + 'static,
) -> El {
    let (fill, border, fg) = if on {
        (k.c.layer_03, k.c.border_strong, k.c.text_base)
    } else {
        (k.c.layer_01, k.c.border_weak, k.c.text_muted)
    };
    let tile = col()
        .key(format!("dock-act-{key}"))
        .role("button")
        .label(label.clone())
        .help(help.to_string())
        .checked(on)
        .grow(1.0)
        .min_w(0.0)
        .h(56.0)
        .gap(5.0)
        .center()
        .radius(k.radius.md)
        .fill(fill)
        .border(1.0, border)
        .cursor(Cursor::Pointer)
        .child(glyph(icon, 17.0, if danger { k.c.danger.icon } else { fg }))
        .child(
            text(label)
                .font(k.ty.text_xsmall_medium)
                .color(if danger { k.c.danger.fg } else { fg })
                .truncate(),
        );
    k.interactive(tile).on_press(f)
}

fn actions(s: &Hooked, d: &Detail, k: &Kit, layer: &mut Vec<El>) -> El {
    let id = d.session.id.clone();
    let pinned = s.is_pinned(&id);
    let incog = s.meta.get(&id).is_some_and(|m| m.incognito);
    let archived = s.meta.get(&id).is_some_and(|m| m.archived);
    let wake = s.snoozed_until(&id);
    let slot = format!("dock:{id}");
    let (g, t, p, i, a, sz) = (
        id.clone(),
        id.clone(),
        id.clone(),
        id.clone(),
        id.clone(),
        slot.clone(),
    );
    let group = action(
        k,
        "group",
        &icons::LIST,
        "Group".into(),
        "Move to group…",
        false,
        false,
        move |s| s.open_group_picker(g.clone()),
    );
    let tags = action(
        k,
        "tags",
        &icons::TAG,
        "Tags".into(),
        "Edit tags",
        false,
        false,
        move |s| s.open_tags(t.clone()),
    );
    let pin = action(
        k,
        "pin",
        &icons::PIN,
        if pinned { "Pinned" } else { "Pin" }.into(),
        if pinned {
            "Unpin"
        } else {
            "Pin to the top of the sidebar"
        },
        pinned,
        false,
        move |s| s.toggle_pin(&p),
    );
    let incognito = action(
        k,
        "incognito",
        if incog { &icons::EYE_OFF } else { &icons::EYE },
        "Incognito".into(),
        if incog {
            "Remove from incognito: hidden while incognito mode is on"
        } else {
            "Mark incognito: keep it visible in incognito mode"
        },
        incog,
        false,
        move |s| s.toggle_incognito(&i),
    );
    let archive = action(
        k,
        "archive",
        if archived {
            &icons::UNARCHIVE
        } else {
            &icons::ARCHIVE
        },
        if archived { "Unarchive" } else { "Archive" }.into(),
        if archived {
            "Restore this session to the live fleet"
        } else {
            "Stop the session and move it to Archived"
        },
        false,
        !archived,
        move |s| s.toggle_archive(&a),
    );
    let mut second = row().w_full().gap(6.0).child(incognito);
    if !archived {
        let trigger = action(
            k,
            "snooze",
            &icons::SNOOZE,
            wake.map_or_else(|| "Snooze".to_string(), |w| wake_label(w, s.now)),
            if wake.is_some() {
                "Change or end the snooze"
            } else {
                "Snooze…"
            },
            wake.is_some(),
            false,
            move |s| {
                s.snooze_menu = if s.snooze_menu.as_deref() == Some(sz.as_str()) {
                    None
                } else {
                    Some(sz.clone())
                }
            },
        );
        let menu = super::snooze_menu(s, &id, &slot, k, layer, trigger);
        second = second.child(menu.grow(1.0).min_w(0.0));
    }
    col()
        .key("dock-actions")
        .w_full()
        .padding(10.0)
        .gap(6.0)
        .border_sides([1.0, 0.0, 0.0, 0.0], k.c.border_weak)
        .child(row().w_full().gap(6.0).child(group).child(tags).child(pin))
        .child(second.child(archive))
}

pub fn view(s: &Hooked, d: &Detail, k: &Kit, layer: &mut Vec<El>) -> El {
    let with_actions = s.feature("dockActions");
    if !s.dock_open || s.lens != Lens::Converse || !(with_actions || has_content(d)) {
        return el();
    }
    let actions = if with_actions {
        actions(s, d, k, layer)
    } else {
        el()
    };
    if let Some(v) = s.gh_view(crate::ghdetail::GhSlot::Dock) {
        return gh_full(s, d, k, &v.url, actions);
    }
    let mut cards = col().key("dock-cards").w_full().padding(10.0).gap(10.0);
    if !d.todos.is_empty() {
        cards = cards.child(tasks(s, d, k));
    }
    if !d.changes.is_empty() {
        cards = cards.child(changes(s, d, k));
    }
    if !d.workflows.is_empty() {
        cards = cards.child(workflows(s, d, k));
    }
    if !d.subagents.is_empty() {
        cards = cards.child(agents(s, d, k));
    }
    if !d.sub_sessions.is_empty() {
        cards = cards.child(sub_sessions(s, d, k));
    }
    if !d.bg_jobs.is_empty() {
        cards = cards.child(jobs(s, d, k));
    }
    if !d.pr_links.is_empty() || !d.issue_links.is_empty() {
        cards = cards.child(links(s, d, k));
    }
    if !d.screenshots.is_empty() {
        cards = cards.child(screenshots(s, d, k));
    }
    resizable(
        k,
        s.dock_w.min((s.window_w * 0.6).max(240.0)),
        |s| s.dock_w,
        |s, w| s.dock_w = w,
        |s, w| s.save_pref("dockW", &w),
        col()
            .key("dock")
            .grow(1.0)
            .min_w(0.0)
            .h_full()
            .child(
                row()
                    .w_full()
                    .px(14.0)
                    .pt(12.0)
                    .child(section_title(k, "SESSION CONTEXT")),
            )
            .child(
                col()
                    .w_full()
                    .grow(1.0)
                    .min_h(0.0)
                    .scroll(ScrollSpec {
                        stick_bottom: false,
                    })
                    .child(cards),
            )
            .child(actions),
    )
}

fn gh_width(s: &Hooked) -> f32 {
    s.dock_gh_w
        .unwrap_or_else(|| (s.window_w * 0.42).clamp(420.0, 720.0))
}

fn resizable(
    k: &Kit,
    width: f32,
    get: fn(&Hooked) -> f32,
    set: fn(&mut Hooked, f32),
    save: fn(&mut Hooked, f32),
    content: El,
) -> El {
    let grip = el()
        .key("dock-resize")
        .w(6.0)
        .h_full()
        .cursor(Cursor::ResizeColumn)
        .help("Drag to resize")
        .on_drag(move |s: &mut Hooked, d: &mut rune::Drag, _| {
            if d.phase == rune::Phase::Down {
                d.data = get(s);
            }
            if d.cancelled() {
                set(s, d.data);
                return;
            }
            let w = (d.data - d.dx).clamp(240.0, (s.window_w * 0.6).max(240.0));
            set(s, w);
            if d.phase == rune::Phase::Up {
                save(s, w);
            }
        });
    row()
        .key("dock-wrap")
        .w(width)
        .h_full()
        .fill(k.c.bg_deep)
        .border_sides([0.0, 0.0, 0.0, 1.0], k.c.border_weak)
        .child(grip)
        .child(content)
}

fn gh_full(s: &Hooked, d: &Detail, k: &Kit, open: &str, actions: El) -> El {
    let mut nav = row()
        .key("ghnav")
        .w_full()
        .px(8.0)
        .py(6.0)
        .gap(4.0)
        .center_y()
        .flex_wrap()
        .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_weak)
        .child(
            rune_kit::IconButton::new(&icons::ARROW_LEFT)
                .label("Back to the session context")
                .control_size(ControlSize::Small)
                .on_press(|s: &mut Hooked| s.close_gh_full())
                .build(k),
        );
    for l in d.pr_links.iter().chain(d.issue_links.iter()) {
        let on = l == open;
        let pr = l.contains("/pull/");
        let url = l.clone();
        nav = nav.child(
            k.interactive(
                row()
                    .key(format!("ghtab-{l}"))
                    .role("tab")
                    .checked(on)
                    .h(24.0)
                    .px(8.0)
                    .gap(4.0)
                    .center_y()
                    .radius(k.radius.sm)
                    .cursor(Cursor::Pointer)
                    .help(l.clone())
                    .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
                    .child(glyph(
                        if pr {
                            &icons::PULL_REQUEST
                        } else {
                            &icons::CIRCLE_DOT
                        },
                        12.0,
                        k.c.icon_muted,
                    ))
                    .child(
                        text(format!("#{}", l.rsplit('/').next().unwrap_or("")))
                            .font(k.ty.text_small_medium)
                            .color(if on { k.c.text_base } else { k.c.text_muted }),
                    ),
            )
            .on_press(move |s: &mut Hooked| s.open_gh_full(url.clone())),
        );
    }
    resizable(
        k,
        gh_width(s).min((s.window_w * 0.6).max(240.0)),
        gh_width,
        |s, w| s.dock_gh_w = Some(w),
        |s, w| s.save_pref("dockGhW", &w),
        col()
            .key("dock")
            .grow(1.0)
            .min_w(0.0)
            .h_full()
            .child(nav)
            .child(super::ghdetail::panel(
                s,
                k,
                crate::ghdetail::GhSlot::Dock,
                el(),
            ))
            .child(actions),
    )
}
