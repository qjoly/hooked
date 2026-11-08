use rune::{Cursor, El, ScrollSpec, col, el, row, text};
use rune_kit::Kit;

use super::{dot, section_title};
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
        .label(x.display_title())
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
                    text(x.display_title())
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
    let decide: Vec<&Session> = active.iter().copied().filter(|x| x.needs_you()).collect();
    let working: Vec<&Session> = active
        .iter()
        .copied()
        .filter(|x| !x.needs_you() && (x.state == "working" || x.state == "background"))
        .collect();
    let rest: Vec<&Session> = active
        .iter()
        .copied()
        .filter(|x| !x.needs_you() && x.state != "working" && x.state != "background")
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
        .child(lane(s, k, "lane-decide", "AWAITING YOU", &decide))
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
