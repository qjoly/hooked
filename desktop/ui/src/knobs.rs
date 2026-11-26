//! A knob's name is its constant's name, so the panel's Copy gives `BUBBLE_PAD = 10` lines that
//! replace the `BUBBLE_PAD = 12.0` line of a `knobs!` declaration as is.
//!
//! Views read knobs through a process-wide copy of the panel's values, synced at the top of
//! every frame, because view helpers are free functions that never see the app state.
//!
//! Without the `knobs` feature (the launcher, release builds) nothing registers and every knob
//! reads its default.

pub use rune_knobs::Knob;

#[cfg(feature = "knobs")]
#[doc(hidden)]
pub use {rune_knobs, rune_register};

#[cfg(feature = "knobs")]
rune_register::slice!(pub GROUPS: rune_knobs::Group);

/// Declares knob constants and registers their group for the panel. Usable from any crate: the
/// registration follows this crate's `knobs` feature, not the caller's.
#[macro_export]
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
        $crate::__register_knobs!($group, $region, [$($name),+] $(, $page)?);
    };
}

#[cfg(feature = "knobs")]
#[doc(hidden)]
#[macro_export]
macro_rules! __register_knobs {
    ($group:literal, $region:literal, [$($name:ident),+] $(, $page:literal)?) => {
        $crate::knobs::rune_register::register!($crate::knobs::GROUPS: $crate::knobs::rune_knobs::Group = [
            $crate::knobs::rune_knobs::Group::new($group, $region, &[$($name),+]) $(.under($page))?
        ]);
    };
}

#[cfg(not(feature = "knobs"))]
#[doc(hidden)]
#[macro_export]
macro_rules! __register_knobs {
    ($($any:tt)*) => {};
}

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
