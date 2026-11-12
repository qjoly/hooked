//! hooked's colour schemes (`src/app.css`) as rune-kit themes. Two axes besides light / dark, as
//! on the web: the palette (`ColorScheme`) and the corners (`Corners`).

use std::sync::atomic::{AtomicU8, Ordering};

use rune::Color;
use rune_kit::{Kit, PaletteSeed, StateColors};

fn hex(s: &str) -> Color {
    rune::color::hex(s).unwrap_or(Color::BLACK)
}

#[derive(
    Clone, Copy, PartialEq, Eq, Debug, Hash, Default, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum ColorScheme {
    #[default]
    #[serde(rename = "default")]
    Coffee,
    Indigo,
    Legacy,
    Datadog,
    Gruvbox,
    Claude,
}

impl ColorScheme {
    pub const ALL: [ColorScheme; 6] = [
        ColorScheme::Coffee,
        ColorScheme::Indigo,
        ColorScheme::Legacy,
        ColorScheme::Datadog,
        ColorScheme::Gruvbox,
        ColorScheme::Claude,
    ];

    pub fn label(self) -> &'static str {
        match self {
            ColorScheme::Coffee => "Coffee",
            ColorScheme::Indigo => "Indigo",
            ColorScheme::Legacy => "Legacy",
            ColorScheme::Datadog => "Datadog",
            ColorScheme::Gruvbox => "Gruvbox",
            ColorScheme::Claude => "Claude",
        }
    }

    pub fn swatch(self) -> Color {
        hex(match self {
            ColorScheme::Coffee => "#96684f",
            ColorScheme::Indigo => "#7d74f5",
            ColorScheme::Legacy => "#a07a55",
            ColorScheme::Datadog => "#632ca6",
            ColorScheme::Gruvbox => "#d65d0e",
            ColorScheme::Claude => "#b14f32",
        })
    }
}

#[derive(
    Clone, Copy, PartialEq, Eq, Debug, Hash, Default, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum Corners {
    #[default]
    Round,
    Sharp,
}

static LOOK: AtomicU8 = AtomicU8::new(0);

/// The scheme and corners every free function here paints with; `Hooked` sets it from its prefs.
pub fn set_look(scheme: ColorScheme, corners: Corners) {
    let i = ColorScheme::ALL.iter().position(|c| *c == scheme).unwrap_or(0) as u8;
    LOOK.store(i | (u8::from(corners == Corners::Sharp) << 7), Ordering::Relaxed);
}

pub fn current() -> ColorScheme {
    ColorScheme::ALL[usize::from(LOOK.load(Ordering::Relaxed) & 0x7f) % ColorScheme::ALL.len()]
}

pub fn sharp() -> bool {
    LOOK.load(Ordering::Relaxed) & 0x80 != 0
}

/// The scheme's tokens for one appearance. State tuples are (hue, soft fill, ink): the hue paints
/// dots and rings, the ink writes the word on a light ground (`--waiting-ink` and co.).
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
    pub info: (Color, Color, Color),
    pub warn: (Color, Color, Color),
    pub success: (Color, Color, Color),
    pub danger: (Color, Color, Color),
    pub working: Color,
    pub background: Color,
    pub idle: Color,
    pub ended: Color,
}

impl Scheme {
    pub fn hues(&self) -> [Color; 6] {
        [
            self.danger.0,
            self.warn.0,
            self.working,
            self.background,
            self.idle,
            self.ended,
        ]
    }
}

struct Hex {
    bg: &'static str,
    surface: &'static str,
    chip: &'static str,
    border: &'static str,
    border2: &'static str,
    fg: &'static str,
    muted: &'static str,
    accent: &'static str,
    accent_fg: &'static str,
    info: [&'static str; 3],
    warn: [&'static str; 3],
    success: [&'static str; 3],
    danger: [&'static str; 3],
    background: &'static str,
    idle: &'static str,
    ended: Option<&'static str>,
}

const INDIGO_INKS: [&str; 4] = ["#2f689d", "#845f12", "#1f7348", "#b23d32"];

fn inked(pair: [&'static str; 2], ink: &'static str) -> [&'static str; 3] {
    [pair[0], pair[1], ink]
}

fn self_inked(pair: [&'static str; 2]) -> [&'static str; 3] {
    [pair[0], pair[1], pair[0]]
}

fn raw(cs: ColorScheme, dark: bool) -> Hex {
    let [i_ink, w_ink, s_ink, d_ink] = INDIGO_INKS;
    match (cs, dark) {
        (ColorScheme::Coffee, false) => Hex {
            bg: "#e9ebdf",
            surface: "#ffffff",
            chip: "#e3e4d7",
            border: "#dadacd",
            border2: "#c7c4b7",
            fg: "#18110e",
            muted: "#6e6056",
            accent: "#261b18",
            accent_fg: "#fbfbf8",
            info: inked(["#418d50", "#e8f1ea"], "#256b35"),
            warn: inked(["#e1901f", "#fbefe0"], "#8b5500"),
            success: inked(["#418d50", "#e8f1ea"], "#256b35"),
            danger: inked(["#c43d4d", "#f9eaeb"], "#a12437"),
            background: "#9e59b3",
            idle: "#92a1a9",
            ended: Some("#96684f"),
        },
        (ColorScheme::Coffee, true) => Hex {
            bg: "#18110e",
            surface: "#261b18",
            chip: "#2f231f",
            border: "#3a2d27",
            border2: "#4d3f37",
            fg: "#f2f3ec",
            muted: "#aaa497",
            accent: "#e4cdb1",
            accent_fg: "#18110e",
            info: self_inked(["#70c47e", "#323628"]),
            warn: self_inked(["#f5ad5a", "#473223"]),
            success: self_inked(["#70c47e", "#323628"]),
            danger: self_inked(["#ed737b", "#462928"]),
            background: "#ca92dc",
            idle: "#6f7d84",
            ended: Some("#be947d"),
        },
        (ColorScheme::Indigo, false) => Hex {
            bg: "#e7eaef",
            surface: "#ffffff",
            chip: "#e3e6ec",
            border: "#d3d8e0",
            border2: "#bcc3cd",
            fg: "#181b20",
            muted: "#5c636e",
            accent: "#4f46e5",
            accent_fg: "#ffffff",
            info: inked(["#3b82c4", "#e6eef8"], i_ink),
            warn: inked(["#c08a1a", "#f6efda"], w_ink),
            success: inked(["#2a9d63", "#e5f4ec"], s_ink),
            danger: inked(["#dc4b3e", "#fbede4"], d_ink),
            background: "#8250df",
            idle: "#a6adb8",
            ended: None,
        },
        (ColorScheme::Indigo, true) => Hex {
            bg: "#101013",
            surface: "#1a1a1e",
            chip: "#212127",
            border: "#34343c",
            border2: "#44444e",
            fg: "#ececee",
            muted: "#a7a7b2",
            accent: "#7d74f5",
            accent_fg: "#13111d",
            info: self_inked(["#6aa5e0", "#182634"]),
            warn: self_inked(["#d9ad4a", "#2e2717"]),
            success: self_inked(["#56c98a", "#17281f"]),
            danger: self_inked(["#ec6a58", "#2a1a16"]),
            background: "#a992e0",
            idle: "#6a6a74",
            ended: None,
        },
        (ColorScheme::Legacy, false) => Hex {
            bg: "#e9e3d4",
            surface: "#ffffff",
            chip: "#ece6d8",
            border: "#e2dccd",
            border2: "#d6cdb9",
            fg: "#2f2b23",
            muted: "#7d7362",
            accent: "#b05a34",
            accent_fg: "#ffffff",
            info: inked(["#4f7d8c", "#e4edf0"], i_ink),
            warn: inked(["#c2912f", "#f6eed6"], w_ink),
            success: inked(["#7e9a68", "#eaf0e2"], s_ink),
            danger: inked(["#c0492c", "#f7e6df"], d_ink),
            background: "#7a63b8",
            idle: "#a79f8d",
            ended: None,
        },
        (ColorScheme::Legacy, true) => Hex {
            bg: "#15110d",
            surface: "#201a14",
            chip: "#2a231b",
            border: "#342c23",
            border2: "#473c30",
            fg: "#ece5d8",
            muted: "#a89e8d",
            accent: "#cf6f45",
            accent_fg: "#13111d",
            info: self_inked(["#6fa4b5", "#17242a"]),
            warn: self_inked(["#d9a83f", "#2b2413"]),
            success: self_inked(["#93b47a", "#1c261a"]),
            danger: self_inked(["#e06a4a", "#2b1a13"]),
            background: "#a992e0",
            idle: "#8a8172",
            ended: None,
        },
        (ColorScheme::Datadog, false) => Hex {
            bg: "#f2f2f6",
            surface: "#ffffff",
            chip: "#e9e9f0",
            border: "#dcdce6",
            border2: "#c3c3d2",
            fg: "#1c1c22",
            muted: "#5c5c73",
            accent: "#632ca6",
            accent_fg: "#ffffff",
            info: inked(["#0f74c4", "#e4f0fb"], i_ink),
            warn: inked(["#b3760f", "#fbf1de"], w_ink),
            success: inked(["#1f8f45", "#e6f5ea"], s_ink),
            danger: inked(["#cc2f22", "#fbe9e7"], d_ink),
            background: "#0f74c4",
            idle: "#a0a0b4",
            ended: Some("#a0a0b4"),
        },
        (ColorScheme::Datadog, true) => Hex {
            bg: "#14141c",
            surface: "#1c1c26",
            chip: "#24242f",
            border: "#33333f",
            border2: "#454553",
            fg: "#e9e9f0",
            muted: "#9d9db3",
            accent: "#a78bfa",
            accent_fg: "#13111d",
            info: self_inked(["#4aa3f0", "#132534"]),
            warn: self_inked(["#e0a92e", "#2e2513"]),
            success: self_inked(["#4cc86b", "#14291a"]),
            danger: self_inked(["#ef5f4e", "#2c1714"]),
            background: "#4aa3f0",
            idle: "#6b6b7d",
            ended: Some("#6b6b7d"),
        },
        (ColorScheme::Gruvbox, false) => Hex {
            bg: "#ebdbb2",
            surface: "#fbf1c7",
            chip: "#ebdbb2",
            border: "#d5c4a1",
            border2: "#bdae93",
            fg: "#3c3836",
            muted: "#7c6f64",
            accent: "#af3a03",
            accent_fg: "#fbf1c7",
            info: inked(["#076678", "#dee0be"], i_ink),
            warn: inked(["#b57614", "#f3e2b2"], w_ink),
            success: inked(["#79740e", "#ebe2b1"], s_ink),
            danger: inked(["#9d0006", "#f0d4b0"], d_ink),
            background: "#8f3f71",
            idle: "#a89984",
            ended: None,
        },
        (ColorScheme::Gruvbox, true) => Hex {
            bg: "#1d2021",
            surface: "#282828",
            chip: "#3c3836",
            border: "#3c3836",
            border2: "#504945",
            fg: "#ebdbb2",
            muted: "#a89984",
            accent: "#fe8019",
            accent_fg: "#282828",
            info: self_inked(["#83a598", "#333735"]),
            warn: self_inked(["#fabd2f", "#413a29"]),
            success: self_inked(["#b8bb26", "#393a28"]),
            danger: self_inked(["#fb4934", "#412c29"]),
            background: "#d3869b",
            idle: "#7c6f64",
            ended: None,
        },
        (ColorScheme::Claude, false) => Hex {
            bg: "#f0eee6",
            surface: "#ffffff",
            chip: "#eae7dc",
            border: "#e8e5db",
            border2: "#d6d2c4",
            fg: "#141413",
            muted: "#6b6760",
            accent: "#b14f32",
            accent_fg: "#ffffff",
            info: inked(["#3d7fa6", "#e4eef3"], "#2d6382"),
            warn: inked(["#c08a1a", "#f6efdc"], "#8a5a16"),
            success: inked(["#3a8c5f", "#e4f0e8"], "#2c6b47"),
            danger: inked(["#c05c45", "#f8e9e4"], "#a8402f"),
            background: "#7a5ea8",
            idle: "#b5b0a4",
            ended: None,
        },
        (ColorScheme::Claude, true) => Hex {
            bg: "#1f1e1d",
            surface: "#30302e",
            chip: "#3a3a37",
            border: "#3d3d3a",
            border2: "#4e4e4a",
            fg: "#f5f4ef",
            muted: "#a8a39a",
            accent: "#d97757",
            accent_fg: "#1f1e1d",
            info: self_inked(["#6fa8d4", "#1b2833"]),
            warn: self_inked(["#d9a441", "#332a17"]),
            success: self_inked(["#6cc08a", "#1a2a20"]),
            danger: inked(["#e8705c", "#331f1b"], "#ff866e"),
            background: "#a98fd4",
            idle: "#6b6862",
            ended: None,
        },
    }
}

pub fn scheme(dark: bool) -> Scheme {
    scheme_of(current(), dark)
}

pub fn scheme_of(cs: ColorScheme, dark: bool) -> Scheme {
    let r = raw(cs, dark);
    let trio = |t: [&str; 3]| (hex(t[0]), hex(t[1]), hex(t[2]));
    let success = trio(r.success);
    let info = trio(r.info);
    Scheme {
        bg: hex(r.bg),
        surface: hex(r.surface),
        chip: hex(r.chip),
        border: hex(r.border),
        border2: hex(r.border2),
        fg: hex(r.fg),
        muted: hex(r.muted),
        accent: hex(r.accent),
        accent_fg: hex(r.accent_fg),
        working: if cs == ColorScheme::Datadog { success.0 } else { info.0 },
        info,
        warn: trio(r.warn),
        danger: trio(r.danger),
        background: hex(r.background),
        idle: hex(r.idle),
        ended: r.ended.map_or(success.0, hex),
        success,
    }
}

fn state((hue, soft, ink): (Color, Color, Color)) -> StateColors {
    StateColors {
        bg: soft,
        fg: ink,
        border: hue.alpha(0.45),
        icon: hue,
    }
}

pub fn kit(dark: bool) -> Kit {
    let cs = current();
    let s = scheme_of(cs, dark);
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
    c.bg_accent = s.accent;
    c.layer_04 = s.border2;
    c.knob = Color::WHITE;
    c.knob_on = Color::WHITE;
    c.info = state(s.info);
    c.warning = state(s.warn);
    c.success = state(s.success);
    c.danger = state(s.danger);
    match cs {
        ColorScheme::Datadog => {
            k.radius.xs = 2.0;
            k.radius.sm = 3.0;
            k.radius.md = 3.0;
            k.radius.lg = 3.0;
            k.radius.xl = 3.0;
            k.elevation.raised.clear();
            k.elevation.floating.truncate(1);
        }
        ColorScheme::Claude => {
            k.radius.sm = 8.0;
            k.radius.md = 10.0;
            k.radius.lg = 14.0;
            k.radius.xl = 16.0;
        }
        _ => {}
    }
    if sharp() {
        k.radius = rune_kit::Radius {
            xs: 0.0,
            sm: 0.0,
            md: 0.0,
            lg: 0.0,
            xl: 0.0,
        };
    }
    k
}

pub fn state_color(dark: bool, state: &str) -> Color {
    let s = scheme(dark);
    match state {
        "attention" => s.danger.0,
        "waiting" => s.warn.0,
        "working" => s.working,
        "background" => s.background,
        "ended" => s.ended,
        _ => s.idle,
    }
}

/// hooked's six tag hues first (what a tag hashes to, as in the web UI), then extra hues only a
/// picked colour can land on. Each pair stays readable as text over its own hue at 14 %. Every
/// scheme but Coffee swaps the first six for `SCHEME_TAG_HUES`, in both appearances, as the web does.
const TAG_HUES: [(&str, &str); 11] = [
    ("#665d00", "#c6c17c"),
    ("#006f5d", "#78d1c0"),
    ("#006c7b", "#71cfd9"),
    ("#005f99", "#8cc4f4"),
    ("#41559e", "#a7bbf9"),
    ("#8a3a64", "#eba6c6"),
    ("#b42318", "#f19a8f"),
    ("#9a4a00", "#f0b27a"),
    ("#2b6a14", "#9fd68a"),
    ("#632ca6", "#c4a8fb"),
    ("#55556a", "#b4b4c6"),
];

const SCHEME_TAG_HUES: [&str; 6] = [
    "#c27a12", "#0f8a7e", "#2a9d63", "#c62a9e", "#7c4bd0", "#d1493a",
];

pub const TAG_HUE_COUNT: usize = TAG_HUES.len();

pub fn tag_hue(dark: bool, i: usize) -> Color {
    let i = i % TAG_HUES.len();
    if current() != ColorScheme::Coffee && i < SCHEME_TAG_HUES.len() {
        return hex(SCHEME_TAG_HUES[i]);
    }
    let (light, dark_hex) = TAG_HUES[i];
    hex(if dark { dark_hex } else { light })
}

pub fn tag_index(name: &str) -> usize {
    let n = name.to_lowercase();
    match n.as_str() {
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
    }
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
        assert_eq!(tag_hue(true, tag_index("infra")), hex("#a7bbf9"));
        assert_eq!(tag_hue(true, tag_index("Azure")), hex("#8cc4f4"));
        assert!(tag_index("feature") < 6);
    }

    #[test]
    fn scheme_keys_match_the_web() {
        let keys: Vec<String> = ColorScheme::ALL
            .iter()
            .map(|c| serde_json::to_string(c).unwrap())
            .collect();
        assert_eq!(
            keys,
            [
                "\"default\"",
                "\"indigo\"",
                "\"legacy\"",
                "\"datadog\"",
                "\"gruvbox\"",
                "\"claude\"",
            ]
        );
    }

    #[test]
    fn datadog_colours_states_by_severity() {
        let d = scheme_of(ColorScheme::Datadog, true);
        assert_eq!(d.working, d.success.0);
        assert_eq!(d.background, d.info.0);
        assert_eq!(d.ended, d.idle);
        let i = scheme_of(ColorScheme::Indigo, false);
        assert_eq!(i.working, i.info.0);
        assert_eq!(i.ended, i.success.0);
    }
}
