use rune::{Color, Cursor, El, ScrollSpec, col, el, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit};
use serde_json::Value;

use super::{Shadows, dot, glyph, section_title};
use crate::app::Hooked;
use crate::ghrun::{MAX_LINES, RunWin};
use crate::{fmt, icons};

pub fn state_of(status: &str) -> &'static str {
    match status {
        "failed" | "cancelled" => "attention",
        "pending" => "background",
        "passed" => "working",
        _ => "idle",
    }
}

fn duration(v: &Value) -> String {
    let (Some(a), Some(b)) = (
        v["startedAt"].as_str().and_then(fmt::parse_ts),
        v["completedAt"].as_str().and_then(fmt::parse_ts),
    ) else {
        return String::new();
    };
    fmt::span(b - a, "")
}

pub fn view(s: &Hooked, w: &RunWin, k: &Kit) -> El {
    let run = w.run.as_ref();
    let title = run
        .map(|r| {
            format!(
                "{} · {}",
                r["workflow"].as_str().unwrap_or(""),
                r["title"].as_str().unwrap_or("")
            )
        })
        .unwrap_or_else(|| "GitHub Actions run".into());
    let url = run
        .and_then(|r| r["url"].as_str())
        .unwrap_or(&w.url)
        .to_string();
    let head = row()
        .w_full()
        .h(40.0)
        .px(12.0)
        .gap(8.0)
        .center_y()
        .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_weak)
        .child(dot(
            k,
            state_of(run.and_then(|r| r["status"].as_str()).unwrap_or("")),
            8.0,
        ))
        .child(
            text(title)
                .font(k.ty.ui_medium)
                .color(k.c.text_base)
                .truncate()
                .grow(1.0)
                .min_w(0.0),
        )
        .child(
            Button::new("GitHub")
                .icon(&icons::GITHUB)
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .on_press_tx(move |_: &mut Hooked, tx| {
                    let _ = tx.open_url(&url);
                })
                .build(k),
        )
        .child(
            Button::new("Close")
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .on_press(|s: &mut Hooked| s.run_win = None)
                .build(k),
        );
    let mut body = col().w_full().grow(1.0).min_h(0.0);
    if let Some(e) = w.err.as_ref() {
        body = body.child(
            text(e.clone())
                .font(k.ty.text_small)
                .color(k.c.danger.fg)
                .wrap()
                .padding(12.0),
        );
    }
    if let Some(r) = run {
        let meta = format!(
            "{} · {} · attempt {} · {} ago",
            r["branch"].as_str().unwrap_or(""),
            r["event"].as_str().unwrap_or(""),
            r["attempt"].as_u64().unwrap_or(1),
            fmt::ago_short(r["updatedAt"].as_str(), s.now)
        );
        body = body.child(
            text(meta)
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint)
                .px(12.0)
                .py(6.0),
        );
        let current = w.job().and_then(|j| j["id"].as_str()).map(str::to_string);
        let mut jobs = col().w(220.0).h_full().gap(1.0).px(6.0);
        for j in r["jobs"].as_array().into_iter().flatten() {
            let id = j["id"].as_str().unwrap_or("").to_string();
            let on = current.as_deref() == Some(id.as_str());
            jobs = jobs.child(
                k.interactive(
                    row()
                        .key(format!("rj-{id}"))
                        .role("tab")
                        .checked(on)
                        .w_full()
                        .h(28.0)
                        .px(8.0)
                        .gap(6.0)
                        .center_y()
                        .radius(k.radius.sm)
                        .cursor(Cursor::Pointer)
                        .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
                        .child(dot(k, state_of(j["status"].as_str().unwrap_or("")), 7.0))
                        .child(
                            text(j["name"].as_str().unwrap_or("").to_string())
                                .font(k.ty.text_small)
                                .color(k.c.text_base)
                                .truncate()
                                .grow(1.0)
                                .min_w(0.0),
                        )
                        .child(
                            text(duration(j))
                                .font(k.ty.text_xsmall)
                                .color(k.c.text_faint),
                        ),
                )
                .on_press(move |s: &mut Hooked| s.pick_run_job(id.clone())),
            );
        }
        let mut detail = col().grow(1.0).min_w(0.0).h_full().gap(6.0).pr(10.0);
        if let Some(j) = w.job() {
            let mut steps = col().w_full().gap(2.0);
            for st in j["steps"].as_array().into_iter().flatten() {
                steps = steps.child(
                    row()
                        .w_full()
                        .gap(6.0)
                        .center_y()
                        .child(dot(k, state_of(st["status"].as_str().unwrap_or("")), 6.0))
                        .child(
                            text(st["name"].as_str().unwrap_or("").to_string())
                                .font(k.ty.text_small)
                                .color(k.c.text_muted)
                                .truncate()
                                .grow(1.0)
                                .min_w(0.0),
                        )
                        .child(
                            text(duration(st))
                                .font(k.ty.text_xsmall)
                                .color(k.c.text_faint),
                        ),
                );
            }
            detail = detail.child(section_title(k, "STEPS")).child(steps);
            let id = j["id"].as_str().unwrap_or("");
            let log = w.log.as_ref().filter(|(lid, _)| lid == id).map(|(_, l)| l);
            let log_el = match log {
                None => text("Loading the log…")
                    .font(k.ty.text_small)
                    .color(k.c.text_faint),
                Some(Ok(None)) => text("No log until the job finishes.")
                    .font(k.ty.text_small)
                    .color(k.c.text_faint),
                Some(Err(e)) => text(e.clone()).font(k.ty.text_small).color(k.c.danger.fg),
                Some(Ok(Some(t))) => {
                    let lines: Vec<&str> = t.lines().collect();
                    let tail = &lines[lines.len().saturating_sub(MAX_LINES)..];
                    let mut c = col().w_full();
                    for l in tail {
                        let error = l.contains("##[error]");
                        c = c.child(
                            text(l.to_string())
                                .font(k.ty.mono)
                                .color(if error { k.c.danger.fg } else { k.c.text_muted })
                                .wrap_anywhere()
                                .selectable(true),
                        );
                    }
                    c
                }
            };
            detail = detail.child(section_title(k, "LOG")).child(
                col()
                    .w_full()
                    .grow(1.0)
                    .min_h(0.0)
                    .padding(8.0)
                    .radius(k.radius.sm)
                    .fill(k.c.layer_02)
                    .scroll(ScrollSpec { stick_bottom: true })
                    .child(log_el),
            );
        }
        body = body.child(
            row()
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .gap(8.0)
                .pb(10.0)
                .child(jobs)
                .child(detail),
        );
    } else if w.err.is_none() {
        body = body.child(
            row()
                .padding(12.0)
                .gap(6.0)
                .child(glyph(&icons::CLOCK, 12.0, k.c.icon_faint))
                .child(
                    text("Loading the run…")
                        .font(k.ty.text_small)
                        .color(k.c.text_faint),
                ),
        );
    }
    el().key("run-win-layer")
        .absolute(0.0, 0.0)
        .w_full()
        .h_full()
        .items_end()
        .justify_end()
        .padding(16.0)
        .child(
            col()
                .key("run-win")
                .w(760.0)
                .h((s.window_h * 0.7).max(320.0))
                .radius(k.radius.lg)
                .fill(k.c.bg_base)
                .border(1.0, k.c.border_base)
                .box_shadows(&k.elevation.overlay)
                .child(head)
                .child(body),
        )
}
