//! hooked's "datadog" scheme (src/app.css) as a rune-kit theme: cool flat surfaces held apart by
//! borders rather than elevation, tight 3 pt corners, a violet accent, and states coloured by how
//! much they need you.

use rune::Color;
use rune_kit::{Kit, PaletteSeed, StateColors};

fn hex(s: &str) -> Color {
    rune::color::hex(s).unwrap_or(Color::BLACK)
}

/// The scheme's tokens for one appearance.
pub struct Scheme {
    pub bg: Color,
    pub surface: Color,
    pub chip: Color,
    pub border: Color,
    pub border2: Color,
    pub fg: Color,
    pub muted: Color,
    pub accent: Color,
    pub accent_fg: Color,
    pub info: (Color, Color),
    pub warn: (Color, Color),
    pub success: (Color, Color),
    pub danger: (Color, Color),
    pub idle: Color,
}

pub fn scheme(dark: bool) -> Scheme {
    if dark {
        Scheme {
            bg: hex("#14141c"),
            surface: hex("#1c1c26"),
            chip: hex("#24242f"),
            border: hex("#33333f"),
            border2: hex("#454553"),
            fg: hex("#e9e9f0"),
            muted: hex("#9d9db3"),
            accent: hex("#a78bfa"),
            accent_fg: hex("#14141c"),
            info: (hex("#4aa3f0"), hex("#132534")),
            warn: (hex("#e0a92e"), hex("#2e2513")),
            success: (hex("#4cc86b"), hex("#14291a")),
            danger: (hex("#ef5f4e"), hex("#2c1714")),
            idle: hex("#6b6b7d"),
        }
    } else {
        Scheme {
            bg: hex("#f2f2f6"),
            surface: hex("#ffffff"),
            chip: hex("#e9e9f0"),
            border: hex("#dcdce6"),
            border2: hex("#c3c3d2"),
            fg: hex("#1c1c22"),
            muted: hex("#5c5c73"),
            accent: hex("#632ca6"),
            accent_fg: hex("#ffffff"),
            info: (hex("#0f74c4"), hex("#e4f0fb")),
            warn: (hex("#b3760f"), hex("#fbf1de")),
            success: (hex("#1f8f45"), hex("#e6f5ea")),
            danger: (hex("#cc2f22"), hex("#fbe9e7")),
            idle: hex("#a0a0b4"),
        }
    }
}

fn state((ink, soft): (Color, Color)) -> StateColors {
    StateColors {
        bg: soft,
        fg: ink,
        border: ink.alpha(0.45),
        icon: ink,
    }
}

pub fn kit(dark: bool) -> Kit {
    let s = scheme(dark);
    let mut k = Kit::from_palette(PaletteSeed {
        bg: s.bg,
        fg: s.fg,
        accent: s.accent,
    });
    let c = &mut k.c;
    c.page = s.bg;
    c.bg_deep = s.bg;
    c.bg_base = s.bg;
    c.layer_01 = s.surface;
    c.layer_02 = s.chip;
    c.layer_03 = s.border;
    c.surface_base = s.surface;
    c.surface_raised = s.surface;
    c.surface_float = s.surface;
    c.border_weak = s.border;
    c.border_muted = s.border;
    c.border_base = s.border;
    c.border_strong = s.border2;
    c.border_focus = s.accent;
    c.text_base = s.fg;
    c.text_strong = s.fg;
    c.text_muted = s.muted;
    c.text_accent = s.accent;
    c.icon_base = s.fg;
    c.icon_muted = s.muted;
    c.icon_accent = s.accent;
    c.bg_contrast = s.accent;
    c.text_contrast = s.accent_fg;
    c.icon_contrast = s.accent_fg;
    c.bg_icon_button_contrast = s.accent;
    c.submit_icon = s.accent_fg;
    c.info = state(s.info);
    c.warning = state(s.warn);
    c.success = state(s.success);
    c.danger = state(s.danger);
    k.radius.xs = 2.0;
    k.radius.sm = 3.0;
    k.radius.md = 3.0;
    k.radius.lg = 3.0;
    k.radius.xl = 3.0;
    k.elevation.raised.clear();
    k.elevation.floating.truncate(1);
    k
}

/// Session states by how much they need you: red decide now, amber your turn, green running,
/// blue informational, grey nothing to report.
pub fn state_color(dark: bool, state: &str) -> Color {
    let s = scheme(dark);
    match state {
        "attention" => s.danger.0,
        "waiting" => s.warn.0,
        "working" => s.success.0,
        "background" => s.info.0,
        _ => s.idle,
    }
}

/// hooked's tag palette: a few names keep a fixed hue, the rest hash to one, as in the web UI.
pub fn tag_color(dark: bool, name: &str) -> Color {
    const LIGHT: [&str; 6] = [
        "#665d00", "#006f5d", "#006c7b", "#005f99", "#41559e", "#8a3a64",
    ];
    const DARK: [&str; 6] = [
        "#c6c17c", "#78d1c0", "#71cfd9", "#8cc4f4", "#a7bbf9", "#eba6c6",
    ];
    let n = name.to_lowercase();
    let i = match n.as_str() {
        "chart" => 0,
        "constant" => 1,
        "azure" => 3,
        "infra" => 4,
        "urgent" => 5,
        _ => {
            (n.encode_utf16()
                .fold(0u32, |h, c| h.wrapping_mul(31).wrapping_add(u32::from(c)))
                % 6) as usize
        }
    };
    hex(if dark { DARK[i] } else { LIGHT[i] })
}

/// A stable hue per project folder, from the scheme's accent and state colours.
pub fn folder_color(dark: bool, path: &str) -> Color {
    let s = scheme(dark);
    let hues = [s.accent, s.info.0, s.success.0, s.warn.0, s.danger.0];
    let h = path.encode_utf16().fold(0i32, |h, c| {
        h.wrapping_mul(31).wrapping_add(i32::from(c as i16))
    });
    hues[(h.unsigned_abs() as usize) % hues.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_keep_the_web_hues() {
        assert_eq!(tag_color(true, "infra"), hex("#a7bbf9"));
        assert_eq!(tag_color(true, "Azure"), hex("#8cc4f4"));
        assert_eq!(tag_color(false, "feature"), tag_color(false, "feature"));
    }
}
