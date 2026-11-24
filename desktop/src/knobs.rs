//! The knobs mechanism lives in `hooked-ui` (`ui/src/knobs.rs`), shared with the launcher; this
//! module adds the panel, which needs the app state.

pub(crate) use hooked_ui::knobs;
pub use hooked_ui::knobs::{generation, get};
#[cfg(feature = "knobs")]
pub use hooked_ui::knobs::{groups, sync};

#[cfg(feature = "knobs")]
pub fn side(page: rune::El, s: &crate::app::Hooked, dark: bool) -> rune::El {
    let style = if dark {
        rune_knobs::Style::dark()
    } else {
        rune_knobs::Style::light()
    };
    rune_knobs::side(
        page,
        &s.knobs,
        groups(),
        style,
        |s: &mut crate::app::Hooked| &mut s.knobs,
    )
}

#[cfg(not(feature = "knobs"))]
#[inline]
pub fn side(page: rune::El, _: &crate::app::Hooked, _: bool) -> rune::El {
    page
}

#[cfg(all(test, feature = "knobs"))]
mod tests {
    use super::groups;

    #[test]
    fn copy_gives_lines_that_paste_over_the_declarations() {
        let bubble = groups().iter().find(|g| g.name == "Bubble").unwrap();
        let mut k = rune_knobs::Knobs::default();
        let pad = bubble
            .knobs
            .iter()
            .find(|k| k.name == "BUBBLE_PAD")
            .unwrap();
        k.set(pad, 10.5);
        let code = k.code(bubble);
        assert!(code.lines().any(|l| l == "BUBBLE_PAD = 10.5"), "{code}");
        assert!(code.lines().any(|l| l == "BUBBLE_RADIUS = 14"), "{code}");
        let source = include_str!("view/session.rs");
        for line in code.lines() {
            let name = line.split(" = ").next().unwrap();
            assert!(source.contains(&format!("    {name} = ")), "{name}");
        }
    }

    #[test]
    fn every_group_and_knob_registers_once() {
        let mut names: Vec<&str> = groups().iter().map(|g| g.name).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            [
                "Bubble",
                "Chat",
                "Corners",
                "Motion",
                "Screen",
                "Session row",
                "Type"
            ]
        );
        let mut knobs: Vec<&str> = groups()
            .iter()
            .flat_map(|g| g.knobs.iter().map(|k| k.name))
            .collect();
        let n = knobs.len();
        knobs.sort_unstable();
        knobs.dedup();
        assert_eq!(knobs.len(), n);
    }
}
