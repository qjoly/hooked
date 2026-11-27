// Debug builds keep the console, for their logs.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod account;
mod api;
mod app;
mod coderun;
mod cron;
mod flows;
mod defs;
mod dnd;
mod echo;
mod export;
mod fleet;
mod fmt;
mod ghdetail;
mod ghwatch;
mod ghostty;
mod ghrun;
mod incidents;
mod incmcp;
mod knobs;
mod lenses;
mod logo;
mod mddiff;
mod media;
mod organize;
mod pages;
mod panel;
mod perf;
mod profiles;
mod querywin;
mod quick;
mod remote;
mod sections;
mod shortcuts;
mod single;
mod terminal;
mod tray;
mod view;

use std::time::Duration;

use hooked_ui::{icons, theme};
use rune::{AppSpec, Key, KeyEvent, Tx};

use app::{HANDLE, Hooked, Lens, Page};

#[global_allocator]
static ALLOCATOR: procwatch::alloc::Counting = procwatch::alloc::Counting::system();

fn on_key(s: &mut Hooked, ev: &KeyEvent, tx: &mut Tx) -> bool {
    perf::input(perf::MAIN, tx);
    #[cfg(feature = "knobs")]
    if rune_knobs::key(&mut s.knobs, ev) {
        tx.motion(s.knobs.slide());
        return true;
    }
    let focused = tx.focused();
    let on_chrome = focused.is_none_or(|f| f.starts_with("term-"));
    if s.term_claimed && on_chrome && s.term.open && s.page == app::Page::Session {
        let handled = if s.term_copy_chord(ev, tx) || s.term_paste_chord(ev, tx) {
            true
        } else if terminal::app_chord(ev) {
            s.term_cmd_key(&ev.key)
        } else {
            s.term_key(ev, tx.physical_key(), tx.key_repeat())
        };
        if handled {
            tx.instant();
            return true;
        }
    } else if !focused.is_some_and(terminal::is_term_key) {
        s.set_term_focus(None);
        s.term_claimed = false;
    }
    if s.shortcuts.values().any(|r| r.is_recording()) {
        return false;
    }
    if let Some(id) = s.shortcut_hit(ev, tx)
        && s.run_shortcut(id, tx)
    {
        return true;
    }
    if ev.is_command('k') {
        if s.palette_open {
            s.palette_open = false;
        } else {
            s.open_palette("");
        }
        return true;
    }
    if ev.is_command('r') {
        s.refresh_sessions();
        s.refresh_detail();
        return true;
    }
    if ev.is_command('w') {
        tx.close_window();
        return true;
    }
    if ev.is_command('q') {
        tx.quit();
        return true;
    }
    if s.page == Page::Session && s.lens == Lens::Review {
        if ev.key == Key::Escape && s.lens_data.def.is_some() {
            s.close_def();
            return true;
        }
        if ev.key == Key::Function(12)
            && let Some(sel) = tx.text_selection().cloned()
        {
            if !s.def_from_selection(&sel) {
                s.def_selected(sel.text().trim());
            }
            return true;
        }
        if s.lens_data.diff.key(ev, tx) {
            return true;
        }
    }
    if matches!(s.picker, Some(organize::Picker::Image { .. })) {
        match ev.key {
            Key::Left => return s.step_image(-1),
            Key::Right => return s.step_image(1),
            _ => {}
        }
    }
    if ev.key == Key::Escape {
        if s.focus && !s.palette_open && s.picker.is_none() && s.popup.is_none() {
            s.focus = false;
            return true;
        }
        if s.palette_open {
            s.palette_open = false;
            return true;
        }
        if s.picker.is_some() {
            s.picker = None;
            return true;
        }
        if s.popup.is_some() {
            s.popup = None;
            return true;
        }
        let busy = s
            .detail
            .as_ref()
            .is_some_and(|d| d.session.state == "working")
            || s.live.as_ref().is_some_and(|l| l.busy);
        if s.page == Page::Session && busy {
            s.interrupt();
            return true;
        }
        return false;
    }
    if s.page == Page::Session
        && !ev.mods.cmd
        && !ev.mods.ctrl
        && let Key::Text(t) = &ev.key
    {
        let lens = match t.as_str() {
            "1" => Some(Lens::Converse),
            "2" => {
                s.toggle_terms();
                return true;
            }
            "3" => Some(Lens::Review),
            "4" => Some(Lens::Mcp),
            "5" => Some(Lens::Trace),
            _ => None,
        };
        if let Some(l) = lens {
            s.lens = l;
            return true;
        }
    }
    false
}

fn poll(s: &mut Hooked, clock: f64, tx: &mut Tx) -> bool {
    let now = fmt::now_ms();
    let mut changed = s.poll_panel(clock, tx);
    s.stash_draft();
    s.refresh_logo();
    s.poll_run(now);
    s.poll_query(now);
    s.poll_account(now);
    s.sync_usage_profile();
    s.poll_incidents(now);
    s.poll_gh_watch(now);
    let working = s.page == Page::Session && s.working_since.is_some();
    let step = if working { 1000 } else { 30_000 };
    if now / step != s.now / step {
        s.now = now;
        changed = true;
    }
    if s.flash.as_ref().is_some_and(|f| f.until <= now) {
        s.flash = None;
        changed = true;
    }
    changed |= s.ensure_lens();
    s.stash_review_place();
    s.poll_threads(now, tx);
    changed |= s.fit_review();
    changed |= s.resolve_jump(tx);
    changed |= s.resolve_goto(tx);
    changed |= s.ensure_page();
    s.sync_ptys();
    s.sync_term_theme();
    if s.term_focus.is_some() && s.term_cursor_blinks() {
        tx.wake_after(Duration::from_millis(terminal::blink_due()));
    }
    if let Some(wait) = s.flush_term_size(now) {
        tx.wake_after(wait);
    }
    if now - s.term.bell_at < 250 {
        tx.wake_after(Duration::from_millis(300));
    }
    tray::sync(s);
    if s.players.any_playing() {
        changed = true;
        tx.wake_after(Duration::from_millis(250));
    }
    tx.wake_after(Duration::from_millis(if working { 1000 } else { 5000 }));
    changed
}

fn setup(s: &mut Hooked, waker: rune::Waker) {
    s.handle = HANDLE.get().cloned();
    s.images = Some(rune::ImageCache::new(waker));
    if let Some(d) = s.detail.clone() {
        s.want_media(&d, true);
    }
    s.tray_dirty = true;
    s.refresh_logo();
    app::start_workers(s.handle.clone());
    // `--test-notify` posts a sample notification once the app is up, to check delivery.
    if std::env::args().any(|a| a == "--test-notify") {
        tray::test_notification();
    }
}

fn on_close(s: &mut Hooked, _tx: &mut Tx) {
    s.stash_draft();
    // The app outlives its window for the tray icon. Without one the shell shows (it was refused, or
    // never given a place), nothing could bring the window back, so closing it quits.
    #[cfg(windows)]
    if !tray::reachable(s) {
        _tx.quit();
    }
}

fn on_ime(s: &mut Hooked, ime: &rune::Ime, tx: &mut Tx) -> bool {
    perf::input(perf::MAIN, tx);
    tx.instant();
    s.focused_ime(ime)
}

fn main() {
    // A second launch brings the first one up and leaves.
    if !single::acquire() {
        return;
    }
    let _ = rune_notify::register(&rune_notify::Identity::new(
        "dev.qjoly.hooked-rune",
        "hooked",
    ));
    let spec = AppSpec {
        on_key: Some(on_key),
        poll: Some(poll),
        setup: Some(setup),
        min_size: Some((720.0, 480.0)),
        families: hooked_ui::widgets::FAMILIES,
        ..AppSpec::new("hooked", (1320.0, 860.0), Hooked::new, view::view)
    };
    let app = rune::App::new(spec)
        .chrome(hooked_ui::widgets::chrome())
        .keep_running()
        .on_close(on_close)
        .on_ime(on_ime)
        .on_frame_encoded(perf::frame_hook(perf::MAIN));
    let _ = HANDLE.set(app.handle());
    single::serve();
    tray::init_notifications();
    let quick = quick::app();
    rune::run_windows(move |_| {
        let windows: Vec<rune::AnyWindowSpec> = vec![
            rune::WindowSpec::from_app("main", app).into(),
            rune::WindowSpec::from_app("quick", quick)
                .configured_options(
                    rune::WindowOptions::launcher_panel().macos(|n| n.corner_radius(14.0)),
                )
                .into(),
        ];
        windows
    });
    perf::shutdown();
}
