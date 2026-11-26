use crate::app::{HANDLE, Hooked};

/// The last notifications this app posted, newest last, so "I got nothing" can be told apart
/// from "nothing was posted": macOS keeps its own delivery log out of reach.
fn journal(title: &str, body: &str, posted: bool) {
    use std::io::Write;
    let Some(dirs) = rune::dirs::AppDirs::new(crate::theme::PREFS_ID) else {
        return;
    };
    let path = dirs.data().join("notifications.log");
    // Kept small: once past 64 KB it starts over.
    let fresh = std::fs::metadata(&path).is_ok_and(|m| m.len() > 64 * 1024);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(!fresh)
        .write(true)
        .truncate(fresh)
        .open(&path);
    if let Ok(mut f) = file {
        let state = if posted { "posted" } else { "unavailable" };
        let _ = writeln!(f, "{} {state} {title} — {body}", crate::fmt::now_ms());
    }
}

/// Posts a sample notification that opens the GitHub page when clicked: it checks that macOS
/// lets this app show notifications at all.
pub fn test_notification() {
    notify_link(
        "test",
        "hooked test notification",
        "Notifications from hooked show up here",
        "gh",
        "https://github.com/qjoly/hooked",
    );
}

pub fn notify(id: &str, title: &str, body: &str) {
    journal(title, body, rune_notify::available());
    if !rune_notify::available() {
        return;
    }
    rune_notify::post(
        &rune_notify::Notification::new(format!("wait-{id}"), title)
            .body(body)
            .info("session", id),
    );
}

/// A notification that is not about a session: `kind` (`gh` or `incident`) and `target` say what
/// a click opens.
pub fn notify_link(id: &str, title: &str, body: &str, kind: &str, target: &str) {
    journal(title, body, rune_notify::available());
    if !rune_notify::available() {
        return;
    }
    rune_notify::post(
        &rune_notify::Notification::new(id.to_string(), title)
            .body(body)
            .info(kind, target),
    );
}

pub fn init_notifications() {
    rune_notify::on_click(|click| {
        let Some(h) = HANDLE.get() else {
            return;
        };
        if let Some(id) = click.get("session").map(str::to_string) {
            h.open();
            h.update(move |s, _| s.open_session(&id));
        } else if let Some(url) = click.get("gh").map(str::to_string) {
            h.open();
            h.update(move |s, _| {
                s.go(crate::app::Page::GitHub);
                if s.gh_page_view.as_ref().is_none_or(|v| v.url != url) {
                    s.peek_gh(url);
                }
            });
        } else if let Some(id) = click.get("incident").map(str::to_string) {
            h.open();
            h.update(move |s, _| {
                s.go(crate::app::Page::Incidents);
                if s.inc.open.as_deref() != Some(id.as_str()) {
                    s.peek_incident(id);
                }
            });
        }
    });
}

#[cfg(any(target_os = "macos", windows))]
pub mod native {
    pub use tray_icon::TrayIcon;
    use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
    use tray_icon::{Icon, TrayIconBuilder};

    use crate::app::{HANDLE, Hooked};

    fn glyph() -> Icon {
        const N: u32 = 36;
        let mut rgba = vec![0u8; (N * N * 4) as usize];
        let c = (N as f32 - 1.0) / 2.0;
        for y in 0..N {
            for x in 0..N {
                let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
                let ring = 1.0 - ((d - 13.0).abs() - 2.2).clamp(0.0, 1.0);
                let dot = 1.0 - (d - 5.0).clamp(0.0, 1.0);
                let a = ring.max(dot);
                // macOS reads only the alpha of a template icon; white shows on Windows' dark taskbar.
                let i = ((y * N + x) * 4) as usize;
                rgba[i..i + 4].copy_from_slice(&[255, 255, 255, (a * 255.0) as u8]);
            }
        }
        Icon::from_rgba(rgba, N, N).expect("tray glyph")
    }

    fn menu(s: &Hooked) -> (Menu, String) {
        let m = Menu::new();
        let waiting = s.waiting();
        let mut sig = format!("{}|", s.connected);
        if waiting.is_empty() {
            let _ = m.append(&MenuItem::with_id(
                "none",
                "Nothing waiting on you",
                false,
                None,
            ));
        }
        for w in waiting.iter().take(8) {
            let label = format!(
                "{} — {}",
                w.display_title(),
                w.project_name.clone().unwrap_or_default()
            );
            sig.push_str(&w.id);
            let _ = m.append(&MenuItem::with_id(format!("s:{}", w.id), label, true, None));
        }
        let _ = m.append(&PredefinedMenuItem::separator());
        let _ = m.append(&MenuItem::with_id("open", "Open hooked", true, None));
        let _ = m.append(&MenuItem::with_id("quick", "Quick reply (⌘⇧H)", true, None));
        let _ = m.append(&MenuItem::with_id("new", "New session…", true, None));
        let _ = m.append(&PredefinedMenuItem::separator());
        let _ = m.append(&MenuItem::with_id("quit", "Quit", true, None));
        (m, sig)
    }

    fn title(s: &Hooked) -> (Option<String>, String) {
        let n = s.waiting().len();
        match (s.connected, n) {
            (false, _) => (Some("·".into()), "hooked — service unreachable".into()),
            (true, 0) => (None, "hooked — nothing waiting".into()),
            (true, n) => (Some(n.to_string()), format!("hooked — {n} waiting for you")),
        }
    }

    /// Builds the tray on first call and repaints it after; must run on the main thread with
    /// the event loop running, which `poll` guarantees. The icon lives in the app state, where a
    /// live-editing patch still finds it.
    pub fn sync(s: &mut Hooked) {
        let mut slot = s.tray.take();
        {
            let (t, tip) = title(s);
            let (m, sig) = menu(s);
            match &mut slot {
                Some((tray, last)) => {
                    tray.set_title(t.as_deref());
                    let _ = tray.set_tooltip(Some(&tip));
                    if *last != sig {
                        tray.set_menu(Some(Box::new(m)));
                        *last = sig;
                    }
                }
                None => {
                    let built = TrayIconBuilder::new()
                        .with_id("hooked")
                        .with_icon(glyph())
                        .with_icon_as_template(true)
                        .with_tooltip(&tip)
                        .with_menu(Box::new(m))
                        .build();
                    if let Ok(tray) = built {
                        tray.set_title(t.as_deref());
                        slot = Some((tray, sig));
                        MenuEvent::set_event_handler(Some(on_menu));
                    }
                }
            }
        }
        s.tray = slot;
    }

    fn on_menu(e: MenuEvent) {
        let Some(h) = HANDLE.get() else { return };
        let id = e.id.0.clone();
        match id.as_str() {
            "quit" => h.quit(),
            "open" => h.open(),
            "quick" => {
                if let Some(q) = crate::quick::QUICK.get() {
                    q.update(|s, _| crate::quick::show(s));
                }
            }
            "new" => {
                h.open();
                h.update(|s, _| s.go_new(None));
            }
            _ => {
                if let Some(sid) = id.strip_prefix("s:").map(str::to_string) {
                    h.open();
                    h.update(move |s, _| s.open_session(&sid));
                }
            }
        }
    }
}

pub fn sync(s: &mut Hooked) {
    if !s.tray_dirty {
        return;
    }
    s.tray_dirty = false;
    #[cfg(any(target_os = "macos", windows))]
    native::sync(s);
}
