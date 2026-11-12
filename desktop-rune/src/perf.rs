use std::cell::Cell;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::time::Instant;

use rune::{FrameEncoded, FrameOutcome, Tx};
use rune_perf::{Config, Frame, Outcome, Recorder};

pub const MAIN: u64 = 1;
pub const QUICK: u64 = 2;

static ON: AtomicBool = AtomicBool::new(false);
static EPOCH: AtomicU64 = AtomicU64::new(0);
static RECORDER: Mutex<Option<Recorder>> = Mutex::new(None);

thread_local! {
    static PENDING_INPUT: [Cell<Option<Instant>>; 3] = const { [const { Cell::new(None) }; 3] };
}

pub fn env_override() -> Option<bool> {
    let v = std::env::var("HOOKED_PERF").ok()?;
    Some(!matches!(v.trim(), "" | "0" | "false" | "off"))
}

pub fn enabled() -> bool {
    ON.load(Relaxed)
}

/// Headless runs get their own directory: rune-perf locks one directory per process, and a
/// scripted run must neither wait on nor mix with the installed app's live data.
pub fn dir() -> PathBuf {
    if let Some(d) = std::env::var_os("HOOKED_PERF_DIR") {
        return d.into();
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let leaf = if rune::is_headless() { "perf-headless" } else { "perf" };
    home.join("Library/Application Support/dev.qjoly.hooked-rune").join(leaf)
}

pub fn set_enabled(on: bool) {
    let mut slot = RECORDER.lock().unwrap_or_else(|e| e.into_inner());
    if on == slot.is_some() {
        return;
    }
    if on {
        let config = Config::new(dir(), "hooked-rune").build(env!("CARGO_PKG_VERSION"));
        match Recorder::start(config) {
            Ok(r) => {
                *slot = Some(r);
                EPOCH.fetch_add(1, Relaxed);
                ON.store(true, Relaxed);
                serve_procwatch();
            }
            Err(e) => eprintln!("hooked-rune: perf recorder: {e}"),
        }
    } else {
        ON.store(false, Relaxed);
        if let Some(r) = slot.take() {
            crate::app::spawn_named("hooked-perf-stop", move || {
                let _ = r.shutdown();
            });
        }
    }
}

/// procwatch's listener can't be stopped, so it is opt-in and started at most once.
fn serve_procwatch() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    let Some(port) = std::env::var("HOOKED_PERF_PORT").ok().and_then(|p| p.trim().parse::<u16>().ok()) else {
        return;
    };
    if STARTED.swap(true, Relaxed) {
        return;
    }
    match procwatch::serve(([127, 0, 0, 1], port).into()) {
        Ok(addr) => eprintln!("hooked-rune: procwatch on http://{addr}"),
        Err(e) => eprintln!("hooked-rune: procwatch: {e}"),
    }
}

pub fn input(window: u64, tx: &Tx) {
    if !enabled() {
        return;
    }
    let Some(at) = tx.input_time() else { return };
    PENDING_INPUT.with(|p| {
        let slot = &p[window as usize % p.len()];
        if slot.get().is_none() {
            slot.set(Some(at));
        }
    });
}

pub fn frame_hook(window: u64) -> impl FnMut(&FrameEncoded) + 'static {
    let mut epoch = 0;
    let mut last_drawn: Option<Instant> = None;
    move |f| {
        if !enabled() {
            return;
        }
        let fresh = EPOCH.load(Relaxed);
        if epoch != fresh {
            epoch = fresh;
            last_drawn = None;
            rune_perf::take_allocated_bytes();
            PENDING_INPUT.with(|p| p[window as usize % p.len()].set(None));
        }
        let outcome = match f.outcome() {
            FrameOutcome::Drawn => Outcome::Drawn,
            FrameOutcome::Unchanged => Outcome::Unchanged,
            _ => Outcome::Skipped,
        };
        let mut input_ms = None;
        if outcome == Outcome::Drawn {
            // Pointer and wheel events have no central handler: fall back to the latest
            // dispatch since the previous drawn frame, which understates their latency.
            let key = PENDING_INPUT.with(|p| p[window as usize % p.len()].take());
            let pointer = rune::last_input().filter(|t| last_drawn.is_some_and(|d| *t > d));
            input_ms = key
                .or(pointer)
                .map(|t| f.at().saturating_duration_since(t).as_secs_f64() * 1000.0);
            last_drawn = Some(f.at());
        }
        let frame = Frame::new(window, f.seq(), outcome)
            .update_ms(f.update_ms())
            .render_ms(f.encode_ms())
            .input_to_frame_ms(input_ms)
            .allocated_bytes(rune_perf::take_allocated_bytes());
        if let Some(r) = RECORDER.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            r.record(frame);
        }
    }
}

/// Drains the queue to disk; the process exits right after, so this may block.
pub fn shutdown() {
    ON.store(false, Relaxed);
    if let Some(r) = RECORDER.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = r.shutdown();
    }
}
