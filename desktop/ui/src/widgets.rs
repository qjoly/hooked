//! The pieces of hooked's window both apps build with: the window chrome and its top bar, the
//! connection dot, list rows, progress marks and a few small labels.

use rune::{Chrome, Color, Cursor, El, Icon, col, el, icon, row, text};
use rune_kit::Kit;

use crate::icons;
use crate::knobs::get;

/// Rune's default mono family is Inter; terminals and code need a real fixed-width face.
pub const MONO: &str = "ui-monospace, Menlo, monospace";

/// `AppSpec::families`: the UI face and the code face.
pub const FAMILIES: (&str, &str) = ("Inter", MONO);

pub const TOPBAR_H: f32 = 52.0;

/// The content runs under a transparent titlebar, the traffic lights centred in [`topbar`], and
/// only `.window_drag()` regions move the window so the bar's controls stay clickable.
pub fn chrome() -> Chrome {
    Chrome {
        full_size_content: true,
        traffic_lights: Some((18.0, ((TOPBAR_H - Chrome::TRAFFIC_LIGHT) / 2.0).round())),
        drag_regions: true,
    }
}

/// The bar across the top of the window, empty: `inset` is `Cx::titlebar_inset()`, the room the
/// traffic lights take on the left (0 in full screen).
pub fn topbar(k: &Kit, inset: f32) -> El {
    row()
        .key("topbar")
        .w_full()
        .h(TOPBAR_H)
        .pl(inset.max(12.0) + 12.0)
        .pr(12.0)
        .gap(12.0)
        .center_y()
        .window_drag()
        .fill(k.c.bg_deep)
        .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_weak)
}

/// The top bar's last item: green while the hooked service answers, red when it does not.
pub fn connection_dot(k: &Kit, connected: bool, help: &str) -> El {
    el().key("tb-live")
        .size(8.0, 8.0)
        .radius(4.0)
        .fill(if connected { k.c.success.icon } else { k.c.danger.icon })
        .help(help.to_string())
}

pub fn glyph(i: &'static Icon, size: f32, c: Color) -> El {
    icon(i, size).color(c)
}

pub fn pill(k: &Kit, label: impl Into<String>, fg: Color, bg: Color) -> El {
    row()
        .h(20.0)
        .px(8.0)
        .gap(5.0)
        .center_y()
        .radius(10.0)
        .fill(bg)
        .child(text(label.into()).font(k.ty.text_xsmall_medium).color(fg))
}

pub fn section_title(k: &Kit, label: &str) -> El {
    text(label.to_string())
        .font(k.ty.text_xsmall_medium)
        .color(k.c.text_faint)
}

crate::knobs! {
    "Session row" at "sidebar-wrap" under "Sidebar";
    SIDEBAR_ROW_PAD_Y = 6.0, 0.0..=20.0, "Padding top and bottom", step 0.5;
    SIDEBAR_ROW_PAD_L = 10.0, 0.0..=32.0, "Padding left", step 0.5;
    SIDEBAR_ROW_PAD_R = 8.0, 0.0..=32.0, "Padding right", step 0.5;
    SIDEBAR_ROW_MIN_H = 0.0, 0.0..=80.0, "Min height (0: fits its lines)", step 1.0;
    SIDEBAR_ROW_LINE_GAP = 2.0, 0.0..=12.0, "Gap between title and subtitle", step 0.5;
    SIDEBAR_ROW_INDENT = 16.0, 0.0..=40.0, "Indent per group level", step 1.0;
}

/// A sidebar row's frame, `depth` levels in: add its [`list_row_lines`], then a fill for the
/// selected state, and wrap it in `Kit::interactive` for the hover.
pub fn list_row(k: &Kit, depth: u8) -> El {
    let r = row()
        .w_full()
        .pl(get(&SIDEBAR_ROW_PAD_L) + f32::from(depth) * get(&SIDEBAR_ROW_INDENT))
        .pr(get(&SIDEBAR_ROW_PAD_R))
        .py(get(&SIDEBAR_ROW_PAD_Y))
        .radius(k.radius.md)
        .cursor(Cursor::Pointer)
        .hover_group()
        .hover_motion(rune::Anim::INSTANT, rune::Anim::INSTANT);
    if get(&SIDEBAR_ROW_MIN_H) > 0.0 {
        r.min_h(get(&SIDEBAR_ROW_MIN_H)).center_y()
    } else {
        r
    }
}

/// The row's two lines: `title` (with what trails it) over the subtitle.
pub fn list_row_lines(title: El, subtitle: El) -> El {
    col()
        .grow(1.0)
        .min_w(0.0)
        .gap(get(&SIDEBAR_ROW_LINE_GAP))
        .child(title)
        .child(subtitle)
}

pub fn list_row_title(k: &Kit, label: impl Into<String>) -> El {
    text(label.into())
        .font(k.ty.text_small_medium)
        .color(k.c.text_base)
        .truncate()
        .grow(1.0)
        .min_w(0.0)
}

pub fn list_row_subtitle(k: &Kit, label: impl Into<String>) -> El {
    text(label.into())
        .font(k.ty.text_xsmall)
        .color(k.c.text_faint)
        .truncate()
        .w_full()
}

/// Where a task or a step stands, as the dock's task list draws it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StepState {
    Pending,
    Active,
    Done,
    Failed,
}

pub fn step_glyph(k: &Kit, state: StepState) -> (&'static Icon, Color) {
    match state {
        StepState::Pending => (&icons::CIRCLE, k.c.icon_faint),
        StepState::Active => (&icons::CIRCLE_DOT, k.c.info.icon),
        StepState::Done => (&icons::CIRCLE_CHECK, k.c.success.icon),
        StepState::Failed => (&icons::CIRCLE_X, k.c.danger.icon),
    }
}
