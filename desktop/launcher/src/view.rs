use rune::tok::{self, Theme, radius, type_};
use rune::{Color, Cx, El, ScrollSpec, col, el, oklch, row, text};

use crate::branches::{self, Row};
use crate::flow::Step;
use crate::{Run, State, Status};

const LOG_TAIL_LINES: usize = 30;

fn green() -> Color {
    oklch(0.68, 0.15, 145.0)
}

fn red() -> Color {
    oklch(0.62, 0.2, 25.0)
}

fn amber() -> Color {
    oklch(0.75, 0.15, 75.0)
}

pub fn view(s: &State, cx: &mut Cx<State>) -> El {
    let t = tok::theme(cx.system_dark());
    let body = match &s.run {
        Some(run) => run_panel(run, t),
        None => list(s, t),
    };
    col().w_full().h_full().padding(20.0).gap(14.0).fill(t.bg)
        .child(header(s, t))
        .child(body)
}

fn header(s: &State, t: Theme) -> El {
    let (dot, label) = match s.reachable {
        Some(true) => (green(), "Service up"),
        Some(false) => (red(), "Service down"),
        None => (t.text_secondary, "Service…"),
    };
    let status = row().gap(6.0).center_y()
        .child(el().size(8.0, 8.0).radius(4.0).fill(dot))
        .child(text(label).font(type_::LABEL).color(t.text_secondary));
    let title = col().grow(1.0).shrink().gap(2.0)
        .child(text("hooked launcher").font(type_::TITLE).color(t.text))
        .child(text(s.repo.display().to_string()).font(type_::LABEL).color(t.text_secondary).single_line().truncate_head());
    let mut bar = row().w_full().gap(12.0).center_y().child(title).child(status);
    if s.run.is_none() {
        let label = if s.loading { "Fetching…" } else { "Refresh" };
        bar = bar.child(button("refresh", label, t, !s.loading, |s: &mut State| s.refresh()));
    }
    bar
}

fn button(key: &str, label: &str, t: Theme, enabled: bool, f: impl Fn(&mut State) + 'static) -> El {
    let b = el().key(key.to_string()).h(28.0).px(12.0).center().radius(radius::SM).fill(t.control_off)
        .child(text(label.to_string()).font(type_::LABEL).color(t.text).single_line());
    if enabled { b.on_press(f) } else { b.opacity(0.5) }
}

fn badge(label: &str, color: Color) -> El {
    el().px(6.0).h(18.0).center().radius(9.0).fill(color.alpha(0.18))
        .child(text(label.to_string()).font(type_::LABEL).color(color).single_line())
}

fn list(s: &State, t: Theme) -> El {
    let mut out = col().key("branches").w_full().grow(1.0).shrink().min_h(0.0).gap(6.0)
        .scroll(ScrollSpec { stick_bottom: false });
    if let Some(e) = &s.list_error {
        out = out.child(text(e.clone()).font(type_::BODY).color(red()).wrap());
    }
    if let Some(e) = &s.stale {
        out = out.child(text(format!("Fetch failed, showing the last known branches: {e}"))
            .font(type_::LABEL).color(amber()).wrap());
    }
    if s.rows.is_empty() && s.loading {
        out = out.child(text("Loading branches…").font(type_::BODY).color(t.text_secondary));
    }
    let now = crate::now();
    for r in &s.rows {
        out = out.child(branch_row(r, now, t));
    }
    out
}

fn branch_row(r: &Row, now: i64, t: Theme) -> El {
    let b = &r.branch;
    let mut name = row().gap(8.0).center_y()
        .child(text(b.name.clone()).font(type_::TITLE).color(t.text).single_line().truncate());
    if r.running {
        name = name.child(badge("running", green()));
    }
    if r.update {
        name = name.child(badge("update available", amber()));
    }
    let meta = format!("{} · {} · {}", b.subject, b.author, branches::ago(now, b.time));
    let info = col().grow(1.0).shrink().gap(3.0)
        .child(name)
        .child(text(meta).font(type_::LABEL).color(t.text_secondary).single_line().truncate());
    let branch = b.name.clone();
    row().key(format!("branch-{}", b.name)).w_full().padding(10.0).gap(12.0).center_y()
        .radius(radius::MD).fill(t.card)
        .child(info)
        .child(button("switch", "Build and switch", t, true, move |s: &mut State| s.start(branch.clone())))
}

fn run_panel(run: &Run, t: Theme) -> El {
    let mut steps = col().gap(8.0);
    for (step, status) in &run.steps {
        steps = steps.child(step_line(*step, *status, run, t));
    }
    let mut panel = col().key("run").w_full().grow(1.0).shrink().min_h(0.0).gap(14.0)
        .child(text(format!("Switching to {}", run.branch)).font(type_::TITLE).color(t.text))
        .child(steps);
    if let Some(n) = run.busy {
        let control = run.control.clone();
        let cancel = run.control.clone();
        panel = panel.child(
            col().gap(8.0)
                .child(text(format!("{n} session(s) mid-turn: the restart waits for them.")).font(type_::BODY).color(t.text))
                .child(row().gap(8.0)
                    .child(button("restart-anyway", "Restart anyway", t, true, move |_: &mut State| {
                        control.restart_anyway.store(true, std::sync::atomic::Ordering::Relaxed)
                    }))
                    .child(button("cancel", "Cancel", t, true, move |_: &mut State| {
                        cancel.cancel.store(true, std::sync::atomic::Ordering::Relaxed)
                    }))),
        );
    }
    if run.switched {
        panel = panel.child(text(format!("hooked now runs {}.", run.branch)).font(type_::BODY).color(green()));
    }
    if let Some(f) = &run.failure {
        panel = panel.child(failure(f, t));
    }
    if run.finished() {
        panel = panel.child(button("back", "Back to branches", t, true, |s: &mut State| s.close_run()));
    }
    panel
}

fn step_line(step: Step, status: Status, run: &Run, t: Theme) -> El {
    let (mark, color) = match status {
        Status::Pending => ("·", t.text_secondary),
        Status::Running => ("…", amber()),
        Status::Done => ("✓", green()),
        Status::Failed => ("✗", red()),
    };
    let label = if step == Step::Build && run.steps.iter().position(|(s, _)| *s == Step::WaitTurns)
        < run.steps.iter().position(|(s, _)| *s == Step::Build)
    {
        "Install dependencies and build".to_string()
    } else {
        step.label().to_string()
    };
    row().gap(10.0).center_y()
        .child(text(mark).font(type_::TITLE).color(color).w(14.0))
        .child(text(label).font(type_::BODY).color(if status == Status::Pending { t.text_secondary } else { t.text }))
}

fn failure(f: &crate::Failure, t: Theme) -> El {
    let tail: Vec<&str> = f.log.lines().rev().take(LOG_TAIL_LINES).collect::<Vec<_>>().into_iter().rev().collect();
    let undo = match &f.undone {
        None => ("Rolling back…".to_string(), amber()),
        Some(Ok(())) => ("Rolled back: the checkout and the service are as before.".to_string(), t.text),
        Some(Err(e)) => (format!("Rollback incomplete, fix by hand:\n{e}"), red()),
    };
    let full_log = format!("{}\n\n--- rollback ---\n{}", f.log, f.undo_log);
    let mut out = col().gap(10.0).grow(1.0).shrink().min_h(0.0)
        .child(text(format!("{} failed: {}", f.step.label(), f.error)).font(type_::BODY).color(red()).wrap().selectable(true))
        .child(text(undo.0).font(type_::BODY).color(undo.1).wrap().selectable(true));
    if !tail.is_empty() {
        out = out.child(
            col().key("log").w_full().grow(1.0).shrink().min_h(80.0).padding(10.0).radius(radius::MD).fill(t.card)
                .scroll(ScrollSpec { stick_bottom: true })
                .child(text(tail.join("\n")).font(type_::BODY.mono()).color(t.text).w_full().wrap().selectable(true)),
        );
    }
    out.child(
        el().key("copy-log").h(28.0).px(12.0).center().radius(radius::SM).fill(t.control_off)
            .child(text("Copy log").font(type_::LABEL).color(t.text))
            .on_press_tx(move |_: &mut State, tx| tx.copy(&full_log)),
    )
}
