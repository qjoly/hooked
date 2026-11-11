//! The web's mini fleet wheel (`FleetWheel.svelte`, `mini`; the favicon draws the same): the hook
//! on a cup, ringed by one arc per state family sized by how many sessions sit in it. Dashes are in
//! real lengths, not `pathLength`, which the SVG rasterizer ignores.

use crate::app::Hooked;
use crate::theme;

fn hex(c: rune::Color) -> String {
    c.hex().chars().take(7).collect()
}

pub fn svg(counts: [usize; 6], dark: bool) -> String {
    let s = theme::scheme(dark);
    let hue = [
        s.danger.0,
        s.warn.0,
        s.success.0,
        s.info.0,
        s.idle,
        s.border2,
    ];
    let total: usize = counts.iter().sum();
    let mut arcs = String::new();
    if total == 0 {
        arcs.push_str(&format!(
            r#"<circle cx="32" cy="32" r="27" fill="none" stroke="{}" stroke-width="7"/>"#,
            hex(s.border2)
        ));
    } else {
        let circ = 2.0 * std::f32::consts::PI * 27.0;
        let gap = if total > 1 {
            (250.0 / total as f32).min(7.0) * circ / 1000.0
        } else {
            0.0
        };
        let mut start = 0.0_f32;
        for (i, n) in counts.iter().enumerate().filter(|(_, n)| **n > 0) {
            let len = *n as f32 / total as f32;
            arcs.push_str(&format!(
                r#"<circle cx="32" cy="32" r="27" fill="none" transform="rotate(-90 32 32)" stroke="{}" stroke-width="7" stroke-dasharray="{:.2} {:.2}" stroke-dashoffset="{:.2}"/>"#,
                hex(hue[i]),
                (len * circ - gap).max(0.5),
                circ,
                -(start * circ + gap / 2.0),
            ));
            start += len;
        }
    }
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="22" fill="{core}"/>{arcs}<g fill="none" stroke="{ink}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"><path d="M32 15v18"/><path d="M32 33a8.5 8.5 0 1 1-8.5 8.5"/><path d="M26.5 15h11"/></g></svg>"#,
        core = hex(s.accent),
        ink = hex(s.accent_fg),
    )
}

impl Hooked {
    /// Rebuilds the wheel when the family counts change; cheap to call every poll.
    pub fn refresh_logo(&mut self) {
        let mut counts = [0usize; 6];
        for x in self
            .sessions
            .iter()
            .filter(|x| self.visible(x) && !self.is_archived(x))
        {
            counts[crate::fleet::family(x)] += 1;
        }
        if self.logo.as_ref().is_some_and(|(c, _)| *c == counts) {
            return;
        }
        let Some(cache) = self.images.as_ref() else {
            return;
        };
        let images = [false, true].map(|dark| cache.svg(svg(counts, dark).into_bytes(), 26.0, 2.0));
        self.logo = Some((counts, images));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wheel_draws_one_arc_per_family_present() {
        let s = svg([1, 0, 2, 0, 0, 0], true);
        assert_eq!(s.matches("stroke-dasharray").count(), 2);
        assert!(svg([0; 6], false).contains("stroke-width=\"7\""));
    }
}
