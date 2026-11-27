use hooked_ui::widgets::{
    StepState, connection_dot, glyph, list_row, list_row_lines, list_row_subtitle, list_row_title,
    pill, section_title, step_glyph, topbar,
};
use hooked_ui::{icons, logo, theme};
use rune::{Cursor, Cx, El, ScrollSpec, col, el, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, StateColors, Switch, TextInput};

use crate::branches::{self, Row};
use crate::catalog::Entry;
use crate::extensions::Ext;
use crate::flow::Step;
use crate::{GitForm, Kind, Run, State, Status};

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
    extensions(s, k, out)
}

fn extensions(s: &State, k: &Kit, mut out: El) -> El {
    out = out.child(row().w_full().px(10.0).pt(18.0).pb(6.0).child(section_title(k, "EXTENSIONS")));
    if !s.exts_live && !s.exts.is_empty() {
        out = out.child(callout(k, &k.c.warning, "The service is unreachable: read from disk, switches disabled."));
    }
    if let Some(e) = &s.ext_error {
        out = out.child(callout(k, &k.c.danger, e.clone()));
    }
    if s.exts.is_empty() {
        out = out.child(text("No extension.").font(k.ty.text_small).color(k.c.text_muted).px(10.0));
    }
    for e in &s.exts {
        out = out.child(extension_row(s, e, k));
    }
    out = out.child(
        row()
            .px(10.0)
            .pt(8.0)
            .gap(8.0)
            .child(small_button(k, "Add from catalog…", "add-catalog", |s| s.toggle_catalog()))
            .child(small_button(k, "Add from git…", "add-git", |s| s.toggle_git_form())),
    );
    if let Some(catalog) = &s.catalog {
        out = out.child(catalog_panel(s, catalog.as_ref(), k));
    }
    if let Some(form) = &s.git_form {
        out = out.child(git_form(form, k));
    }
    out
}

fn small_button(k: &Kit, label: &str, key: &str, press: impl Fn(&mut State) + 'static) -> El {
    Button::new(label).control_size(ControlSize::Small).on_press(press).build(k).key(key.to_string())
}

fn catalog_panel(s: &State, catalog: Option<&Result<Vec<Entry>, String>>, k: &Kit) -> El {
    let mut out = col().key("catalog").w_full().pt(6.0).gap(2.0);
    match catalog {
        None => out = out.child(text("Loading the catalog…").font(k.ty.text_small).color(k.c.text_muted).px(10.0)),
        Some(Err(e)) => out = out.child(callout(k, &k.c.danger, format!("Could not read the catalog: {e}"))),
        Some(Ok(entries)) if entries.is_empty() => {
            out = out.child(text("The catalog is empty.").font(k.ty.text_small).color(k.c.text_muted).px(10.0));
        }
        Some(Ok(entries)) => {
            for e in entries {
                out = out.child(catalog_row(s, e, k));
            }
        }
    }
    out
}

/// A catalog entry with its badges; incompatible or bundled ones cannot be installed.
fn catalog_row(s: &State, e: &Entry, k: &Kit) -> El {
    let mut title = row().w_full().gap(8.0).center_y().child(list_row_title(k, e.label.clone()));
    let installed = s.installed(&e.id);
    let bundled = s.exts.iter().any(|x| x.id == e.id && x.source == "bundled");
    let incompatible = s.ext_api.is_some_and(|api| api != e.api);
    if installed {
        title = title.child(pill(k, "installed", k.c.success.fg, k.c.success.bg));
    }
    if bundled {
        title = title.child(pill(k, "bundled", k.c.text_muted, k.c.layer_01));
    }
    if incompatible {
        title = title.child(pill(k, format!("incompatible (api {})", e.api), k.c.warning.fg, k.c.warning.bg));
    }
    let sub = format!("{}@{} · {}", e.source.repo, e.source.r#ref, e.description);
    let entry = e.clone();
    let button = Button::new(if installed { "Update" } else { "Install" })
        .control_size(ControlSize::Small)
        .disabled(incompatible || bundled)
        .on_press(move |s: &mut State| s.install(&entry))
        .build(k)
        .key("install");
    list_row(k, 0)
        .key(format!("catalog-{}", e.id))
        .label(e.label.clone())
        .cursor(Cursor::Default)
        .child(list_row_lines(title, list_row_subtitle(k, sub)))
        .child(row().pl(12.0).center_y().child(button))
}

fn git_form(form: &GitForm, k: &Kit) -> El {
    let field = |label: &str, value: &rune::TextEdit, edit: fn(&mut GitForm) -> &mut rune::TextEdit| {
        // Grows rather than taking the full width, so two fields share a row.
        col().grow(1.0).min_w(0.0).gap(4.0).child(section_title(k, label)).child(
            TextInput::new(value)
                .width(None)
                .on_edit(move |s: &mut State| edit(s.git_form.get_or_insert_with(GitForm::default)))
                .build(k)
                .key(label.to_lowercase()),
        )
    };
    col()
        .key("git-form")
        .w_full()
        .px(10.0)
        .pt(8.0)
        .gap(8.0)
        .child(row().w_full().child(field("GIT URL", &form.repo, |f| &mut f.repo)))
        .child(
            row()
                .w_full()
                .gap(8.0)
                .child(field("REF", &form.r#ref, |f| &mut f.r#ref))
                .child(field("PATH IN THE REPO", &form.path, |f| &mut f.path)),
        )
        .child(
            row().child(
                Button::new("Fetch")
                    .control_size(ControlSize::Small)
                    .disabled(form.source().is_none())
                    .on_press(|s: &mut State| s.install_from_git())
                    .build(k)
                    .key("git-fetch"),
            ),
        )
}

/// An extension over where it comes from, with its switch. Applied at once by the service.
fn extension_row(s: &State, e: &Ext, k: &Kit) -> El {
    let mut title = row().w_full().gap(8.0).center_y().child(list_row_title(k, e.label.clone()));
    if !e.errors.is_empty() {
        title = title.child(pill(k, "error", k.c.danger.fg, k.c.danger.bg));
    } else if e.enabled && e.active {
        title = title.child(pill(k, "on", k.c.success.fg, k.c.success.bg));
    }
    let mut sub = e.origin();
    if !e.description.is_empty() {
        sub = format!("{sub} · {}", e.description);
    }
    if let Some(err) = e.errors.first() {
        sub = format!("{err} · {sub}");
    }
    let (id, on) = (e.id.clone(), e.enabled);
    let mut actions = row().pl(12.0).gap(6.0).center_y();
    if e.source == "installed" {
        let (update, uninstall) = (e.clone(), e.id.clone());
        actions = actions
            .child(
                Button::new("Update")
                    .control_size(ControlSize::Small)
                    .disabled(e.from.is_none())
                    .help(if e.from.is_none() { "No .origin.json: installed by hand" } else { "Fetch its source again" })
                    .on_press(move |s: &mut State| s.update_extension(&update))
                    .build(k)
                    .key("update"),
            )
            .child(
                Button::new("Uninstall")
                    .control_size(ControlSize::Small)
                    .on_press(move |s: &mut State| s.uninstall(uninstall.clone()))
                    .build(k)
                    .key("uninstall"),
            );
    }
    let switch = Switch::new(on)
        .label(format!("{} on", e.label))
        .hide_label()
        .disabled(!s.exts_live || s.ext_busy.is_some() || e.errors.iter().any(|x| x.starts_with("rejected")))
        .on_toggle(move |s: &mut State| s.set_extension(id.clone(), !on))
        .build(k);
    list_row(k, 0)
        .key(format!("ext-{}", e.id))
        .label(e.label.clone())
        .cursor(Cursor::Default)
        .child(list_row_lines(title, list_row_subtitle(k, sub)))
        .child(actions.child(switch))
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
            col().gap(4.0).child(section_title(k, heading(run.kind))).child(
                text(run.name.clone()).font(k.ty.body_medium).color(k.c.text_base).single_line().truncate(),
            ),
        )
        .child(steps);
    if let Some(msg) = &run.confirm {
        panel = panel.child(confirmation(run, msg, k));
    }
    for note in &run.notes {
        panel = panel.child(callout(k, &k.c.warning, note.clone()));
    }
    if run.cancelled {
        panel = panel.child(text("Cancelled: nothing was changed.").font(k.ty.text_small).color(k.c.text_base));
    }
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
    if run.verified() {
        panel = panel.child(callout(k, &k.c.success, success(run)));
    }
    if let Some(f) = &run.app_failure {
        panel = panel.child(app_failure(f, k));
    }
    if let Some(f) = &run.failure {
        panel = panel.child(failure(f, run.kind, k));
    }
    let mut actions = row().gap(8.0);
    if run.finished() {
        actions = actions.child(
            Button::new("Back")
                .icon(&icons::ARROW_LEFT)
                .control_size(ControlSize::Small)
                .on_press(|s: &mut State| s.close_run())
                .build(k)
                .key("back"),
        );
    }
    let full_log = match (&run.failure, &run.app_failure) {
        (Some(f), _) => Some(format!("{}\n\n--- rollback ---\n{}", f.log, f.undo_log)),
        (None, Some(f)) => Some(f.log.clone()),
        (None, None) => None,
    };
    if let Some(full_log) = full_log {
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

fn heading(kind: Kind) -> &'static str {
    match kind {
        Kind::Switch => "SWITCHING TO",
        Kind::Install => "INSTALLING",
        Kind::Update => "UPDATING",
        Kind::Uninstall => "UNINSTALLING",
    }
}

fn success(run: &Run) -> String {
    match run.kind {
        Kind::Switch => format!("hooked now runs {}.", run.name),
        Kind::Install | Kind::Update => format!("{} is installed.", run.name),
        Kind::Uninstall => format!("{} is uninstalled. Its data and settings files are kept.", run.name),
    }
}

/// The extension flow stops here until the user accepts the source it shows.
fn confirmation(run: &Run, msg: &str, k: &Kit) -> El {
    let (accept, cancel) = (run.control.clone(), run.control.clone());
    let verb = match run.kind {
        Kind::Uninstall => "Uninstall",
        Kind::Update => "Update",
        _ => "Install",
    };
    col()
        .gap(8.0)
        .child(callout(k, &k.c.warning, msg.to_string()))
        .child(
            row()
                .gap(8.0)
                .child(
                    Button::new(verb)
                        .variant(ButtonVariant::Warning)
                        .control_size(ControlSize::Small)
                        .on_press(move |_: &mut State| accept.confirm.store(true, std::sync::atomic::Ordering::Relaxed))
                        .build(k)
                        .key("confirm"),
                )
                .child(
                    Button::new("Cancel")
                        .control_size(ControlSize::Small)
                        .on_press(move |_: &mut State| cancel.cancel.store(true, std::sync::atomic::Ordering::Relaxed))
                        .build(k)
                        .key("cancel"),
                ),
        )
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

fn failure(f: &crate::Failure, kind: Kind, k: &Kit) -> El {
    let undo = match &f.undone {
        None => callout(k, &k.c.warning, "Rolling back…"),
        Some(Ok(())) => text(if kind == Kind::Switch {
            "Rolled back: the checkout and the service are as before."
        } else {
            "Rolled back: the extensions folder and the service are as before."
        })
            .font(k.ty.text_small)
            .color(k.c.text_base)
            .wrap(),
        Some(Err(e)) => callout(k, &k.c.danger, format!("Rollback incomplete, fix by hand:\n{e}")),
    };
    let out = col()
        .gap(10.0)
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .child(callout(k, &k.c.danger, format!("{} failed: {}", f.step.label(), f.error)))
        .child(undo);
    with_log_tail(out, &f.log, k)
}

fn app_failure(f: &crate::AppFailure, k: &Kit) -> El {
    let msg = format!(
        "The desktop app was not updated: {}. The previous version is still installed.",
        f.error.trim_end_matches('.')
    );
    let out = col().gap(10.0).grow(1.0).shrink().min_h(0.0).child(callout(k, &k.c.warning, msg));
    with_log_tail(out, &f.log, k)
}

fn with_log_tail(out: El, log: &str, k: &Kit) -> El {
    let tail: Vec<&str> = log.lines().rev().take(LOG_TAIL_LINES).collect::<Vec<_>>().into_iter().rev().collect();
    if tail.is_empty() {
        return out;
    }
    out.child(
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
    )
}
