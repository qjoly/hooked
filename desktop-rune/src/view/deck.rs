use rune::{Cursor, El, ScrollSpec, col, el, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit};

use super::{dot, pill, section_title};
use crate::api::Session;
use crate::app::Hooked;
use crate::fmt;

fn card(s: &Hooked, x: &Session, k: &Kit) -> El {
    let id = x.id.clone();
    let reason = if let Some(q) = x.question.as_ref().and_then(|q| q.as_str()) {
        q.to_string()
    } else if x.has_plan {
        "Plan ready for review".into()
    } else if x.state == "working" {
        format!(
            "{}…",
            x.activity.clone().unwrap_or_else(|| "Working".into())
        )
    } else {
        fmt::plain(
            x.last_reply
                .as_deref()
                .or(x.last_prompt.as_deref())
                .unwrap_or(""),
            160,
        )
    };
    let mut c = col()
        .key(format!("card-{}", x.id))
        .role("button")
        .label(s.title_of(x))
        .w(320.0)
        .h(132.0)
        .padding(14.0)
        .gap(8.0)
        .radius(k.radius.lg)
        .fill(k.c.surface_raised)
        .border(
            1.0,
            if x.needs_you() {
                k.c.warning.border
            } else {
                k.c.border_weak
            },
        )
        .cursor(Cursor::Pointer)
        .child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(dot(k, &x.state, 8.0))
                .child(
                    text(s.title_of(x))
                        .font(k.ty.ui_medium)
                        .color(k.c.text_base)
                        .truncate()
                        .grow(1.0)
                        .min_w(0.0),
                )
                .child(
                    text(fmt::ago_short(x.last_activity.as_deref(), s.now))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                ),
        )
        .child(
            text(x.project_label())
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        )
        .child(
            text(reason)
                .font(k.ty.text_small)
                .color(k.c.text_muted)
                .wrap()
                .max_lines(3),
        );
    if let Some(t) = x.todo.as_ref().filter(|t| t.total > 0) {
        let pct = t.done as f32 / t.total as f32;
        c = c.child(el().grow(1.0)).child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(
                    el().grow(1.0)
                        .h(3.0)
                        .radius(1.5)
                        .fill(k.c.layer_03)
                        .child(el().w_frac(pct).h(3.0).radius(1.5).fill(k.c.success.icon)),
                )
                .child(
                    text(format!("{}/{}", t.done, t.total))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                ),
        );
    }
    k.interactive(c)
        .on_press(move |s: &mut Hooked| s.open_session(&id))
}

fn kind(x: &Session) -> (&'static str, bool) {
    let permission = x
        .question
        .as_ref()
        .is_some_and(|q| q["kind"] == "permission");
    if x.has_question && permission || x.state == "attention" && !x.has_question {
        ("Permission", true)
    } else if x.has_question {
        ("Question", true)
    } else if x.has_plan {
        ("Plan", true)
    } else {
        ("Your turn", false)
    }
}

fn decision_card(s: &Hooked, x: &Session, k: &Kit) -> El {
    let (label, urgent) = kind(x);
    let (fg, bg) = if urgent {
        (k.c.danger.fg, k.c.danger.bg)
    } else {
        (k.c.warning.fg, k.c.warning.bg)
    };
    let id = x.id.clone();
    let open_id = id.clone();
    let title = k
        .interactive(
            text(s.title_of(x))
                .role("link")
                .font(k.ty.ui_medium)
                .color(k.c.text_base)
                .truncate()
                .cursor(Cursor::Pointer),
        )
        .on_press(move |s: &mut Hooked| s.open_session(&open_id))
        .grow(1.0)
        .min_w(0.0);
    let mut c = col()
        .key(format!("dcard-{}", x.id))
        .w(400.0)
        .padding(14.0)
        .gap(10.0)
        .radius(k.radius.lg)
        .fill(k.c.surface_raised)
        .border(
            1.0,
            if urgent {
                k.c.danger.border
            } else {
                k.c.warning.border
            },
        )
        .child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(pill(k, label, fg, bg))
                .child(title)
                .child(
                    text(fmt::ago_short(x.last_activity.as_deref(), s.now))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                ),
        )
        .child(
            text(x.project_label())
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        );
    let q = x.question.as_ref().filter(|_| x.has_question);
    let single = q
        .and_then(|q| q["questions"].as_array())
        .filter(|qs| qs.len() == 1 && qs[0]["multiSelect"].as_bool() != Some(true))
        .map(|qs| qs[0].clone());
    if let Some(qq) = single {
        if let Some(t) = qq["question"].as_str() {
            c = c.child(
                text(t.to_string())
                    .font(k.ty.text_small)
                    .color(k.c.text_base)
                    .wrap()
                    .max_lines(4),
            );
        }
        let mut opts = col().w_full().gap(4.0);
        for (i, o) in qq["options"].as_array().into_iter().flatten().enumerate() {
            let id = id.clone();
            opts = opts.child(
                Button::new(o["label"].as_str().unwrap_or("").to_string())
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Small)
                    .help(o["description"].as_str().unwrap_or("").to_string())
                    .on_press(move |s: &mut Hooked| s.deck_answer(id.clone(), i))
                    .build(k)
                    .w_full(),
            );
        }
        c = c.child(opts);
    } else if q.is_some() {
        c = c.child(
            text("Several questions: open the session to answer them.")
                .font(k.ty.text_small)
                .color(k.c.text_muted),
        );
    } else if x.has_plan {
        c = c.child(
            text("A plan is ready for review.")
                .font(k.ty.text_small)
                .color(k.c.text_muted),
        );
    } else {
        let reply = fmt::plain(
            x.last_reply
                .as_deref()
                .or(x.last_prompt.as_deref())
                .unwrap_or(""),
            220,
        );
        if !reply.is_empty() {
            c = c.child(
                text(reply)
                    .font(k.ty.text_small)
                    .color(k.c.text_muted)
                    .wrap()
                    .max_lines(4),
            );
        }
        if let Some(f) = x.followup.clone().filter(|f| !f.trim().is_empty()) {
            let (id, send) = (id.clone(), f.clone());
            c = c.child(
                row()
                    .w_full()
                    .gap(8.0)
                    .center_y()
                    .padding(8.0)
                    .radius(k.radius.md)
                    .border(1.0, k.c.border_weak)
                    .child(
                        col()
                            .grow(1.0)
                            .min_w(0.0)
                            .gap(2.0)
                            .child(
                                text("Suggested follow-up")
                                    .font(k.ty.text_xsmall_medium)
                                    .color(k.c.text_faint),
                            )
                            .child(
                                text(f)
                                    .font(k.ty.text_small)
                                    .color(k.c.text_base)
                                    .wrap()
                                    .max_lines(2),
                            ),
                    )
                    .child(
                        Button::new("Send this")
                            .variant(ButtonVariant::Contrast)
                            .control_size(ControlSize::Small)
                            .on_press(move |s: &mut Hooked| {
                                s.send_followup(id.clone(), send.clone())
                            })
                            .build(k),
                    ),
            );
        }
    }
    let (o, z, a) = (id.clone(), id.clone(), id.clone());
    c.child(
        row()
            .w_full()
            .gap(6.0)
            .pt(2.0)
            .child(
                Button::new(if label == "Your turn" {
                    "Reply"
                } else {
                    "Open"
                })
                .variant(ButtonVariant::Neutral)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut Hooked| s.open_session(&o))
                .build(k),
            )
            .child(el().grow(1.0))
            .child(
                Button::new("1h")
                    .icon(&crate::icons::CLOCK)
                    .variant(ButtonVariant::GhostMuted)
                    .control_size(ControlSize::Small)
                    .help("Snooze this decision for an hour")
                    .on_press(move |s: &mut Hooked| s.snooze(vec![z.clone()], 1.0))
                    .build(k),
            )
            .child(
                Button::new("Archive")
                    .icon(&crate::icons::ARCHIVE)
                    .variant(ButtonVariant::GhostMuted)
                    .control_size(ControlSize::Small)
                    .help("Archive this session: hides it from the Deck")
                    .on_press(move |s: &mut Hooked| s.toggle_archive(&a))
                    .build(k),
            ),
    )
}

fn decide_lane(s: &Hooked, k: &Kit, items: &[&Session], snoozed: usize) -> El {
    if items.is_empty() && snoozed == 0 {
        return el();
    }
    let ids: Vec<String> = items.iter().map(|x| x.id.clone()).collect();
    let mut head = row()
        .w_full()
        .gap(8.0)
        .center_y()
        .child(section_title(k, "AWAITING YOU"))
        .child(
            text(if snoozed > 0 {
                format!("{} · {snoozed} snoozed", items.len())
            } else {
                items.len().to_string()
            })
            .font(k.ty.text_xsmall)
            .color(k.c.text_faint),
        )
        .child(el().grow(1.0));
    if items.len() > 1 {
        head = head.child(
            Button::new("Snooze all 1h")
                .icon(&crate::icons::CLOCK)
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut Hooked| s.snooze(ids.clone(), 1.0))
                .build(k),
        );
    }
    col()
        .key("lane-decide")
        .w_full()
        .gap(10.0)
        .child(head)
        .child(
            row()
                .w_full()
                .gap(12.0)
                .flex_wrap()
                .items_start()
                .children(items.iter().map(|x| decision_card(s, x, k))),
        )
}

fn lane(s: &Hooked, k: &Kit, key: &str, title: &str, items: &[&Session]) -> El {
    if items.is_empty() {
        return el();
    }
    col()
        .key(key.to_string())
        .w_full()
        .gap(10.0)
        .child(
            row().gap(8.0).child(section_title(k, title)).child(
                text(items.len().to_string())
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_faint),
            ),
        )
        .child(
            row()
                .w_full()
                .gap(12.0)
                .flex_wrap()
                .children(items.iter().map(|x| card(s, x, k))),
        )
}

pub fn view(s: &Hooked, k: &Kit) -> El {
    let active: Vec<&Session> = s
        .sessions
        .iter()
        .filter(|x| !s.is_archived(x) && s.visible(x))
        .collect();
    let decide: Vec<&Session> = active
        .iter()
        .copied()
        .filter(|x| x.needs_you() && !s.snoozed(&x.id))
        .collect();
    let snoozed = active
        .iter()
        .filter(|x| x.needs_you() && s.snoozed(&x.id))
        .count();
    let quiet = |x: &Session| !x.needs_you() || s.snoozed(&x.id);
    let working: Vec<&Session> = active
        .iter()
        .copied()
        .filter(|x| quiet(x) && (x.state == "working" || x.state == "background"))
        .collect();
    let rest: Vec<&Session> = active
        .iter()
        .copied()
        .filter(|x| quiet(x) && x.state != "working" && x.state != "background")
        .take(24)
        .collect();
    let mut body = col().key("deck").w_full().padding(24.0).gap(26.0);
    if !s.connected {
        body = body.child(
            text("hooked is not answering on localhost:4123. Start it with `mise run start`.")
                .font(k.ty.body)
                .color(k.c.danger.fg),
        );
    }
    if decide.is_empty() {
        body = body.child(
            row()
                .key("deck-calm")
                .gap(8.0)
                .center_y()
                .child(dot(k, "idle", 8.0))
                .child(
                    text("Nothing is waiting on you.")
                        .font(k.ty.body)
                        .color(k.c.text_muted),
                ),
        );
    }
    body = body
        .child(decide_lane(s, k, &decide, snoozed))
        .child(lane(s, k, "lane-working", "WORKING", &working))
        .child(lane(s, k, "lane-recent", "RECENT", &rest));
    col()
        .key("deck-scroll")
        .w_full()
        .h_full()
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(body)
}
