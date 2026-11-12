//! A knob's name is its constant's name, so the panel's Copy gives `BUBBLE_PAD = 10` lines that
//! replace the `BUBBLE_PAD = 12.0` line of a `knobs!` declaration as is.
//!
//! Views read knobs through a process-wide copy of the panel's values, synced at the top of
//! every frame, because view helpers are free functions that never see `Hooked`.

pub use rune_knobs::Knob;

#[cfg(feature = "knobs")]
rune_register::slice!(pub GROUPS: rune_knobs::Group);

macro_rules! knobs {
    (
        $group:literal at $region:literal $(under $page:literal)?;
        $( $name:ident = $default:literal, $min:literal ..= $max:literal, $label:literal $(, step $step:literal)? ; )+
    ) => {
        $(
            pub const $name: $crate::knobs::Knob = $crate::knobs::Knob::new(
                stringify!($name),
                $min as f32,
                $max as f32,
                $default as f32,
            )
            .label($label)
            $(.step($step as f32))?;
        )+
        #[cfg(feature = "knobs")]
        rune_register::register!($crate::knobs::GROUPS: rune_knobs::Group = [
            rune_knobs::Group::new($group, $region, &[$($name),+]) $(.under($page))?
        ]);
    };
}
pub(crate) use knobs;

#[cfg(feature = "knobs")]
mod live {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{OnceLock, RwLock};

    static VALUES: RwLock<BTreeMap<String, f32>> = RwLock::new(BTreeMap::new());
    static GENERATION: AtomicU64 = AtomicU64::new(0);

    pub fn get(k: &super::Knob) -> f32 {
        VALUES
            .read()
            .ok()
            .and_then(|v| v.get(k.name).copied())
            .map_or(k.default, |v| v.clamp(k.min, k.max))
    }

    pub fn sync(k: &rune_knobs::Knobs) {
        let Ok(mut v) = VALUES.write() else { return };
        if *v != k.values {
            v.clone_from(&k.values);
            GENERATION.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn generation() -> u64 {
        GENERATION.load(Ordering::Relaxed)
    }

    pub fn groups() -> &'static [rune_knobs::Group] {
        static ALL: OnceLock<Vec<rune_knobs::Group>> = OnceLock::new();
        ALL.get_or_init(|| rune_register::collect(&super::GROUPS))
    }
}

#[cfg(feature = "knobs")]
pub use live::{generation, groups, sync};

#[inline]
pub fn get(k: &Knob) -> f32 {
    #[cfg(feature = "knobs")]
    {
        live::get(k)
    }
    #[cfg(not(feature = "knobs"))]
    {
        k.default
    }
}

#[cfg(not(feature = "knobs"))]
#[inline]
pub fn generation() -> u64 {
    0
}

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
