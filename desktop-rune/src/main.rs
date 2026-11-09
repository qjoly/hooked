mod api;
mod app;
mod export;
mod fmt;
mod ghostty;
mod ghrun;
mod icons;
mod lenses;
mod organize;
mod pages;
mod quick;
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
    if ev.is_command('p') && ev.mods.shift {
        s.open_palette(">");
        return true;
    }
    if ev.is_command('k') || ev.is_command('p') {
        if s.palette_open {
            s.palette_open = false;
        } else {
            s.open_palette("");
        }
        return true;
    }
    if ev.mods.cmd && ev.mods.shift {
        let handled = match tx.key_base() {
            Some('d') => {
                s.toggle_dock();
                true
            }
            Some('f') => {
                s.focus = !s.focus;
                true
            }
            Some('t') => {
                s.cycle_theme();
                true
            }
            Some('j') if s.page == Page::Session => {
                s.term.open = true;
                s.new_term();
                true
            }
            _ => false,
        };
        if handled {
            return true;
        }
    }
    if ev.is_command('j') && !ev.mods.shift && s.page == Page::Session {
        s.toggle_terms();
        return true;
    }
    if ev.mods.alt && !ev.mods.cmd && !ev.mods.ctrl {
        let page = match tx.key_base() {
            Some('1') => Some(Page::Deck),
            Some('2') => Some(Page::Session),
            Some('4') => Some(Page::Stats),
            Some('5') => Some(Page::Digest),
            Some('6') => Some(Page::Memory),
            Some('7') => Some(Page::GitHub),
            _ => None,
        };
        match page {
            Some(Page::Deck) => s.go_deck(),
            Some(Page::Session) => s.open_sessions(),
            Some(p) => s.go(p),
            None => {}
        }
        if page.is_some() {
            return true;
        }
    }
    if ev.is_command(',') {
        s.go(Page::Settings);
        return true;
    }
    if ev.is_command('s') && ev.mods.shift {
        s.toggle_split();
        return true;
    }
    if ev.is_command('n') {
        s.go_new(None);
        return true;
    }
    if ev.is_command('b') {
        s.toggle_sidebar();
        return true;
    }
    if ev.is_command('r') {
        app::refresh_sessions();
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
    if s.page == Page::Session
        && s.lens == Lens::Review
        && !ev.mods.cmd
        && !ev.mods.ctrl
        && matches!(&ev.key, Key::Text(t) if t == "v")
    {
        let i = s.lens_data.diff.visible_file();
        s.toggle_reviewed(i, Some(tx));
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
    s.poll_run(now);
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
    if let Some(wait) = s.flush_term_size(now) {
        tx.wake_after(wait);
    }
    tray::sync(s);
    tx.wake_after(Duration::from_millis(if working { 1000 } else { 5000 }));
    changed
}

fn setup(s: &mut Hooked, waker: rune::Waker) {
    s.images = Some(rune::ImageCache::new(waker));
    if let Some(d) = s.detail.clone() {
        s.want_media(&d, true);
    }
    s.tray_dirty = true;
    app::start_workers();
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
        traffic_lights: Some((18.0, 26.0)),
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
