//! A Run on a shell block of a conversation (`/api/run-command`): the command's output as it
//! streams in, shown under the block and kept once the command ends.

use serde_json::Value;

use crate::fmt;

/// What is kept of the output as received, and how many lines of it the pane shows.
const RAW_MAX_BYTES: usize = 64_000;
const SHOWN_MAX_LINES: usize = 200;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct CodeRun {
    raw: String,
    /// `raw` as a terminal shows it, last lines only.
    pub shown: String,
    pub busy: bool,
    /// Why the Run failed: the request was refused, or the connection dropped.
    pub error: Option<String>,
    /// Whether the output pane shows. It hides when nothing ran, or when the session's own agent
    /// ran the command (pi does `!command` itself; its output lands in the thread).
    pub pane: bool,
}

impl CodeRun {
    pub fn started() -> Self {
        CodeRun {
            busy: true,
            pane: true,
            ..Default::default()
        }
    }

    pub fn push(&mut self, chunk: &str) {
        self.raw.push_str(chunk);
        fmt::keep_tail(&mut self.raw, RAW_MAX_BYTES);
        self.shown = fmt::last_lines(&fmt::live_log_text(&self.raw), SHOWN_MAX_LINES);
    }

    /// `result` is the closing line of `/api/run-command`, which carries `localCommand` when
    /// hooked ran the command itself.
    pub fn finish(&mut self, result: &Result<Value, String>) {
        self.busy = false;
        self.error = result.as_ref().err().cloned();
        let ran_here = result
            .as_ref()
            .is_ok_and(|v| v.get("localCommand").is_some());
        self.pane = ran_here || !self.raw.is_empty();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_pane_shows_the_output_as_a_terminal_would() {
        let mut r = CodeRun::started();
        r.push("start\n 10%\r");
        assert_eq!(r.shown, "start\n 10%");
        r.push(" 50%\r100%\n");
        assert_eq!(r.shown, "start\n100%");
    }

    #[test]
    fn the_pane_shows_the_last_lines_only() {
        let mut r = CodeRun::started();
        r.push(&(1..=250).map(|i| format!("{i}\n")).collect::<String>());
        assert_eq!(r.shown.lines().count(), SHOWN_MAX_LINES);
        assert_eq!(r.shown.lines().last(), Some("250"));
    }

    #[test]
    fn a_run_hooked_made_keeps_its_pane_even_without_output() {
        let mut r = CodeRun::started();
        r.finish(&Ok(
            json!({ "done": true, "ok": true, "localCommand": { "code": 0 } }),
        ));
        assert!(!r.busy && r.pane && r.error.is_none());
    }

    #[test]
    fn the_pane_hides_when_nothing_ran_here() {
        let mut refused = CodeRun::started();
        refused.finish(&Err("this session is not driven by hooked".into()));
        assert!(!refused.pane);
        assert_eq!(
            refused.error.as_deref(),
            Some("this session is not driven by hooked")
        );

        let mut by_pi = CodeRun::started();
        by_pi.finish(&Ok(json!({ "done": true, "ok": true })));
        assert!(!by_pi.pane);
    }
}
