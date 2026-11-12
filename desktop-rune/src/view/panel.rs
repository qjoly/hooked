use rune::{Cursor, Cx, El, ScrollSpec, col, el, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit};

use crate::app::Hooked;
use crate::panel::PanelWin;
use crate::view::Shadows;

pub fn view(s: &Hooked, w: &PanelWin, k: &Kit, cx: &Cx<Hooked>) -> El {
    w.set_dark(k.dark);
    let owner = w
        .session
        .as_deref()
        .and_then(|id| s.sessions.iter().find(|x| x.id == id))
        .map(|x| x.display_title())
        .unwrap_or_else(|| "a session hooked doesn't drive".into());
    if w.minimized {
        return minimized(w, k);
    }
    let head = row()
        .w_full()
        .h(40.0)
        .px(12.0)
        .gap(8.0)
        .center_y()
        .fill(k.c.info.bg)
        .border_sides([0.0, 0.0, 1.0, 0.0], k.c.info.border)
        .child(
            text(format!("Drawn by Claude · from {owner}"))
                .font(k.ty.ui_medium)
                .color(k.c.info.fg)
                .truncate()
                .grow(1.0)
                .min_w(0.0),
        )
        .child(
            Button::new("Minimize")
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .on_press(|s: &mut Hooked| {
                    if let Some(w) = s.panel_win.as_mut() {
                        w.set_minimized(true);
                    }
                })
                .build(k),
        )
        .child(
            Button::new("Reload")
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .on_press(|s: &mut Hooked| {
                    if let Some(w) = s.panel_win.as_mut() {
                        w.status = w.script.reload(w.script.sources()).err().map(|e| (e.message, true));
                    }
                })
                .build(k),
        )
        .child(
            Button::new("Close")
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .on_press(|s: &mut Hooked| s.panel_win = None)
                .build(k),
        );
    let title = row()
        .w_full()
        .px(12.0)
        .py(6.0)
        .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_weak)
        .child(
            text(w.title.clone())
                .font(k.ty.text_xsmall)
                .color(k.c.text_muted)
                .truncate()
                .min_w(0.0),
        );
    let script = col()
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .clip_rounded(0.0)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(w.script.view(cx));
    super::floating_sized(
        s,
        k,
        "panel-win",
        480.0,
        (s.window_h * 0.6).max(280.0),
        Some(k.c.info.border),
        head,
        col()
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .child(title)
            .child(script)
            .child(footer(w, k)),
    )
}

fn footer(w: &PanelWin, k: &Kit) -> El {
    let actions = w.actions();
    let (status, bad) = match (w.last_problem(), &w.status) {
        (Some(p), _) => (Some(p), true),
        (None, Some((m, bad))) => (Some(m.clone()), *bad),
        (None, None) => (None, false),
    };
    let mut buttons = row().w_full().gap(6.0).center_y();
    if actions.is_empty() {
        buttons = buttons.child(
            text("This panel sends nothing back.")
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        );
    } else {
        buttons = buttons.child(
            text("Send to Claude:")
                .font(k.ty.text_xsmall)
                .color(k.c.info.fg),
        );
        for a in actions {
            let label = a.label.clone();
            buttons = buttons.child(
                Button::new(label)
                    .variant(ButtonVariant::Neutral)
                    .control_size(ControlSize::Small)
                    .on_press(move |s: &mut Hooked| s.panel_click(a.clone()))
                    .build(k),
            );
        }
    }
    let mut foot = col()
        .w_full()
        .px(12.0)
        .py(8.0)
        .gap(4.0)
        .fill(k.c.info.bg)
        .border_sides([1.0, 0.0, 0.0, 0.0], k.c.info.border)
        .child(buttons);
    if let Some(m) = status {
        foot = foot.child(
            text(m)
                .font(k.ty.text_xsmall)
                .color(if bad { k.c.danger.fg } else { k.c.text_faint })
                .truncate(),
        );
    }
    foot
}

fn minimized(w: &PanelWin, k: &Kit) -> El {
    let dot = if w.last_problem().is_some() {
        Some(k.c.danger.icon)
    } else if w.unseen {
        Some(k.c.info.icon)
    } else {
        None
    };
    let mut pill = row()
        .key("panel-pill")
        .pin(None, None, Some(16.0), Some(16.0))
        .max_w(360.0)
        .h(32.0)
        .px(12.0)
        .gap(8.0)
        .center_y()
        .radius(k.radius.lg)
        .fill(k.c.info.bg)
        .border(2.0, k.c.info.border)
        .box_shadows(&k.elevation.overlay)
        .cursor(Cursor::Pointer)
        .help("Expand the panel".to_string())
        .on_press(|s: &mut Hooked| {
            if let Some(w) = s.panel_win.as_mut() {
                w.set_minimized(false);
            }
        });
    if let Some(c) = dot {
        pill = pill.child(el().size(8.0, 8.0).radius(4.0).fill(c));
    }
    pill = pill.child(
        text(format!("Claude panel · {}", w.title))
            .font(k.ty.text_xsmall)
            .color(k.c.info.fg)
            .truncate()
            .min_w(0.0),
    );
    el().key("panel-win-layer").absolute(0.0, 0.0).w_full().h_full().child(pill)
}
