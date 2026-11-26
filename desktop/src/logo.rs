//! The top bar's logo: `hooked_ui::logo` draws the wheel, this feeds it the session counts.

use hooked_ui::logo;

use crate::app::Hooked;

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
        self.logo = Some((counts, logo::render(cache, counts)));
    }
}
