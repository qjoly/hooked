use hooked_ui::widgets::{
    StepState, connection_dot, glyph, list_row, list_row_lines, list_row_subtitle, list_row_title,
    pill, section_title, step_glyph, topbar,
};
use hooked_ui::{icons, logo, theme};
use rune::{Cursor, Cx, El, ScrollSpec, col, el, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, StateColors};

use crate::branches::{self, Row};
use crate::flow::Step;
use crate::{Run, State, Status};

const LOG_TAIL_LINES: usize = 30;

pub fn view(s: &State, cx: &mut Cx<State>) -> El {
    let k = theme::kit(s.theme.dark(cx.system_dark()));
    let body = match &s.run {
        Some(run) => run_panel(run, &k),
        None => list(s, &k),
    };
    let base = col()
        .w_full()
        .h_full()
        .fill(k.c.bg_deep)
        .child(header(s, &k, cx.titlebar_inset()))
        .child(body);
    rune_kit::root(base, [])
}

fn header(s: &State, k: &Kit, inset: f32) -> El {
    let mark = match &s.logo {
        Some(images) => logo::mark(images, k.dark),
        None => glyph(&icons::CIRCLE_DOT, 16.0, k.c.text_base),
    };
    let mut bar = topbar(k, inset)
        .child(mark)
        .child(text("hooked launcher").font(k.ty.ui_medium).color(k.c.text_base).single_line())
        .child(el().grow(1.0));
    if s.run.is_none() {
        bar = bar.child(
            Button::new(if s.loading { "Fetching…" } else { "Refresh" })
                .icon(&icons::REFRESH)
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .disabled(s.loading)
                .help("Fetch the branches again")
                .on_press(|s: &mut State| s.refresh())
                .build(k)
                .key("refresh"),
        );
    }
    // Unknown until the first poll answers: no dot rather than a red one.
    if let Some(up) = s.reachable {
        let help = if up { "The hooked service answers" } else { "The hooked service is unreachable" };
        bar = bar.child(connection_dot(k, up, help));
    }
    bar
}

/// A message on its state's soft fill, as the app's flash: success, warning or danger.
fn callout(k: &Kit, tone: &StateColors, msg: impl Into<String>) -> El {
    row()
        .w_full()
        .padding(10.0)
        .radius(k.radius.md)
        .fill(tone.bg)
        .border(1.0, tone.border)
        .child(
            text(msg.into())
                .font(k.ty.text_small)
                .color(tone.fg)
                .wrap()
                .selectable(true)
                .grow(1.0)
                .min_w(0.0),
        )
}

fn list(s: &State, k: &Kit) -> El {
    let heading = row()
        .w_full()
        .px(10.0)
        .pb(6.0)
        .gap(12.0)
        .center_y()
        .child(section_title(k, "BRANCHES"))
        .child(
            text(s.repo.display().to_string())
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint)
                .single_line()
                .truncate_head()
                .grow(1.0)
                .min_w(0.0),
        );
    let mut out = col()
        .key("branches")
        .w_full()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .padding(12.0)
        .gap(2.0)
        .scroll(ScrollSpec { stick_bottom: false })
        .child(heading);
    if let Some(e) = &s.list_error {
        out = out.child(callout(k, &k.c.danger, e.clone()));
    }
    if let Some(e) = &s.stale {
        out = out.child(callout(k, &k.c.warning, format!("Fetch failed, showing the last known branches: {e}")));
    }
    if s.rows.is_empty() && s.loading {
        out = out.child(text("Loading branches…").font(k.ty.text_small).color(k.c.text_muted).px(10.0));
    }
    let now = crate::now();
    for r in &s.rows {
        out = out.child(branch_row(r, now, k));
    }
    out
}

/// A sidebar row: the branch over its last commit.
fn branch_row(r: &Row, now: i64, k: &Kit) -> El {
    let b = &r.branch;
    // At rest the pills and the commit's age trail the name; on hover the switch button takes
    // their place, as the sidebar's row actions do.
    let mut resting = row().gap(6.0).center_y().group_opacity(1.0, 0.0);
    if r.running {
        resting = resting.child(pill(k, "running", k.c.success.fg, k.c.success.bg));
    }
    if r.update {
        resting = resting.child(pill(k, "update available", k.c.warning.fg, k.c.warning.bg));
    }
    resting = resting.child(text(branches::ago(now, b.time)).font(k.ty.text_xsmall).color(k.c.text_faint).single_line());
    let title = row().w_full().gap(8.0).center_y().child(list_row_title(k, b.name.clone())).child(resting);
    let branch = b.name.clone();
    let switch = Button::new("Build and switch")
        .control_size(ControlSize::Small)
        .on_press(move |s: &mut State| s.start(branch.clone()))
        .build(k)
        .key("switch");
    let mut line = list_row(k, 0)
        .key(format!("branch-{}", b.name))
        .label(b.name.clone())
        .cursor(Cursor::Default)
        .child(list_row_lines(title, list_row_subtitle(k, format!("{} · {}", b.subject, b.author))))
        .child(
            row()
                .center_y()
                .pin(None, Some(0.0), Some(8.0), Some(0.0))
                .group_opacity(0.0, 1.0)
                .child(switch),
        );
    if r.running {
        line = line.fill(k.c.pressed);
    }
    k.interactive(line)
}

fn run_panel(run: &Run, k: &Kit) -> El {
    let mut steps = col().gap(8.0);
    for (step, status) in &run.steps {
        steps = steps.child(step_line(*step, *status, run, k));
    }
    let mut panel = col()
        .key("run")
        .w_full()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .padding(20.0)
        .gap(14.0)
        .child(
            col().gap(4.0).child(section_title(k, "SWITCHING TO")).child(
                text(run.branch.clone()).font(k.ty.body_medium).color(k.c.text_base).single_line().truncate(),
            ),
        )
        .child(steps);
    if let Some(n) = run.busy {
        let control = run.control.clone();
        let cancel = run.control.clone();
        panel = panel.child(
            col()
                .gap(8.0)
                .child(callout(k, &k.c.warning, format!("{n} session(s) mid-turn: the restart waits for them.")))
                .child(
                    row()
                        .gap(8.0)
                        .child(
                            Button::new("Restart anyway")
                                .variant(ButtonVariant::Warning)
                                .control_size(ControlSize::Small)
                                .on_press(move |_: &mut State| {
                                    control.restart_anyway.store(true, std::sync::atomic::Ordering::Relaxed)
                                })
                                .build(k)
                                .key("restart-anyway"),
                        )
                        .child(
                            Button::new("Cancel")
                                .control_size(ControlSize::Small)
                                .on_press(move |_: &mut State| {
                                    cancel.cancel.store(true, std::sync::atomic::Ordering::Relaxed)
                                })
                                .build(k)
                                .key("cancel"),
                        ),
                ),
        );
    }
    if run.switched {
        panel = panel.child(callout(k, &k.c.success, format!("hooked now runs {}.", run.branch)));
    }
    if let Some(f) = &run.failure {
        panel = panel.child(failure(f, k));
    }
    let mut actions = row().gap(8.0);
    if run.finished() {
        actions = actions.child(
            Button::new("Back to branches")
                .icon(&icons::ARROW_LEFT)
                .control_size(ControlSize::Small)
                .on_press(|s: &mut State| s.close_run())
                .build(k)
                .key("back"),
        );
    }
    if let Some(f) = &run.failure {
        let full_log = format!("{}\n\n--- rollback ---\n{}", f.log, f.undo_log);
        actions = actions.child(
            Button::new("Copy log")
                .icon(&icons::COPY)
                .control_size(ControlSize::Small)
                .on_press_tx(move |_: &mut State, tx| tx.copy(&full_log))
                .build(k)
                .key("copy-log"),
        );
    }
    panel.child(actions)
}

fn step_line(step: Step, status: Status, run: &Run, k: &Kit) -> El {
    let state = match status {
        Status::Pending => StepState::Pending,
        Status::Running => StepState::Active,
        Status::Done => StepState::Done,
        Status::Failed => StepState::Failed,
    };
    let (mark, color) = step_glyph(k, state);
    let label = if step == Step::Build
        && run.steps.iter().position(|(s, _)| *s == Step::WaitTurns)
            < run.steps.iter().position(|(s, _)| *s == Step::Build)
    {
        "Install dependencies and build".to_string()
    } else {
        step.label().to_string()
    };
    row()
        .gap(8.0)
        .center_y()
        .child(glyph(mark, 14.0, color))
        .child(text(label).font(k.ty.text_small).color(if state == StepState::Pending {
            k.c.text_muted
        } else {
            k.c.text_base
        }))
}

fn failure(f: &crate::Failure, k: &Kit) -> El {
    let tail: Vec<&str> = f.log.lines().rev().take(LOG_TAIL_LINES).collect::<Vec<_>>().into_iter().rev().collect();
    let undo = match &f.undone {
        None => callout(k, &k.c.warning, "Rolling back…"),
        Some(Ok(())) => text("Rolled back: the checkout and the service are as before.")
            .font(k.ty.text_small)
            .color(k.c.text_base)
            .wrap(),
        Some(Err(e)) => callout(k, &k.c.danger, format!("Rollback incomplete, fix by hand:\n{e}")),
    };
    let mut out = col()
        .gap(10.0)
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .child(callout(k, &k.c.danger, format!("{} failed: {}", f.step.label(), f.error)))
        .child(undo);
    if !tail.is_empty() {
        out = out.child(
            col()
                .key("log")
                .w_full()
                .grow(1.0)
                .shrink()
                .min_h(80.0)
                .padding(10.0)
                .radius(k.radius.md)
                .fill(k.c.layer_01)
                .border(1.0, k.c.border_weak)
                .scroll(ScrollSpec { stick_bottom: true })
                .child(text(tail.join("\n")).font(k.ty.mono).color(k.c.text_muted).w_full().wrap().selectable(true)),
        );
    }
    out
}
