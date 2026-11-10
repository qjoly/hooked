mod account;
mod api;
mod app;
mod cron;
mod export;
mod fleet;
mod fmt;
mod ghdetail;
mod ghostty;
mod ghrun;
mod icons;
mod lenses;
mod logo;
mod organize;
mod pages;
mod querywin;
mod quick;
mod shortcuts;
mod terminal;
mod theme;
mod tray;
mod view;

use std::time::Duration;

use rune::{AppSpec, Chrome, Key, KeyEvent, Tx};

use app::{HANDLE, Hooked, Lens, Page};

/// Rune's default mono family is Inter; terminals and code need a real fixed-width face.
pub const MONO: &str = "ui-monospace, Menlo, monospace";

fn on_key(s: &mut Hooked, ev: &KeyEvent, tx: &mut Tx) -> bool {
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
    if s.page == Page::Session && s.lens == Lens::Review && s.lens_data.diff.key(ev, tx) {
        return true;
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

fn poll(s: &mut Hooked, _clock: f64, tx: &mut Tx) -> bool {
    let now = fmt::now_ms();
    let mut changed = false;
    s.stash_draft();
    s.refresh_logo();
    s.poll_run(now);
    s.poll_query(now);
    s.poll_account(now);
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
    changed |= s.ensure_page();
    s.sync_ptys();
    if let Some(wait) = s.flush_term_size(now) {
        tx.wake_after(wait);
    }
    if now - s.term.bell_at < 250 {
        tx.wake_after(Duration::from_millis(300));
    }
    tray::sync(s);
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
}

fn on_close(s: &mut Hooked, _: &mut Tx) {
    s.stash_draft();
}

fn on_ime(s: &mut Hooked, ime: &rune::Ime, tx: &mut Tx) -> bool {
    if tx.focused() != Some("term-screen") {
        return false;
    }
    tx.instant();
    s.term_ime(ime);
    true
}

fn main() {
    let _ = rune_notify::register(&rune_notify::Identity::new(
        "dev.qjoly.hooked-rune",
        "hooked",
    ));
    let chrome = Chrome {
        full_size_content: true,
        traffic_lights: Some((
            18.0,
            ((view::TOPBAR_H - Chrome::TRAFFIC_LIGHT) / 2.0).round(),
        )),
        drag_regions: true,
    };
    let spec = AppSpec {
        on_key: Some(on_key),
        poll: Some(poll),
        setup: Some(setup),
        min_size: Some((720.0, 480.0)),
        families: ("Inter", MONO),
        ..AppSpec::new("hooked", (1320.0, 860.0), Hooked::new, view::view)
    };
    let app = rune::App::new(spec)
        .chrome(chrome)
        .keep_running()
        .on_close(on_close)
        .on_ime(on_ime);
    let _ = HANDLE.set(app.handle());
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
}
