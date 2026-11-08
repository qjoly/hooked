mod api;
mod app;
mod fmt;
mod icons;
mod lenses;
mod tray;
mod view;

use std::time::Duration;

use rune::{AppSpec, Chrome, Key, KeyEvent, Tx};

use app::{HANDLE, Hooked, Lens, Page};

fn on_key(s: &mut Hooked, ev: &KeyEvent, tx: &mut Tx) -> bool {
    if ev.is_command('k') || ev.is_command('p') {
        s.palette_open = !s.palette_open;
        s.palette_query = rune::TextEdit::new("");
        s.palette_query.focused = true;
        s.palette_index = 0;
        return true;
    }
    if ev.is_command('n') {
        s.go_new(None);
        return true;
    }
    if ev.is_command('b') {
        s.sidebar_open = !s.sidebar_open;
        let v = s.sidebar_open;
        s.save_pref("sidebarOpen", &v);
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
    if s.page == Page::Session && s.lens == Lens::Review && s.lens_data.diff.key(ev, tx) {
        return true;
    }
    if ev.key == Key::Escape {
        if s.palette_open {
            s.palette_open = false;
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
    tray::sync(s);
    tx.wake_after(Duration::from_millis(if working { 1000 } else { 5000 }));
    changed
}

fn setup(s: &mut Hooked, _waker: rune::Waker) {
    s.tray_dirty = true;
    app::start_workers();
}

fn on_close(_: &mut Hooked, _: &mut Tx) {}

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
        ..AppSpec::new("hooked", (1320.0, 860.0), Hooked::new, view::view)
    };
    let app = rune::App::new(spec)
        .chrome(chrome)
        .keep_running()
        .on_close(on_close)
        .global_shortcut("Cmd+Shift+H", |s: &mut Hooked, _| {
            if let Some(h) = HANDLE.get() {
                h.open();
            }
            if let Some(w) = s.waiting().first().map(|x| x.id.clone()) {
                s.open_session(&w);
            }
        });
    let _ = HANDLE.set(app.handle());
    tray::init_notifications();
    app.run();
}
