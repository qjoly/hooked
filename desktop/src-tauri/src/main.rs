#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::time::Duration;

use serde::Deserialize;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Instant;

use tauri::{
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const BASE: &str = "http://localhost:4123";
const TOAST_W: f64 = 360.0;
const SHIM: &str = include_str!("../shim.js");

#[derive(Deserialize)]
struct Session {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    state: String,
    #[serde(default, rename = "projectName")]
    project_name: String,
    #[serde(default, rename = "hasQuestion")]
    has_question: bool,
    // Shape varies with what the session is blocked on; a plain string is the
    // only form worth showing.
    #[serde(default)]
    question: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct Tool {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct RawMessage {
    #[serde(default)]
    role: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    tools: Vec<Tool>,
}

#[derive(Deserialize)]
struct Detail {
    #[serde(default)]
    messages: Vec<RawMessage>,
}

#[derive(Serialize)]
struct Message {
    role: String,
    text: String,
}

// What the quick reply window needs to show one line per session.
#[derive(Serialize)]
struct Waiting {
    id: String,
    title: String,
    project: String,
    reason: String,
}

#[derive(Deserialize)]
struct Sessions {
    #[serde(default)]
    sessions: Vec<Session>,
}

// A session counts when Claude is blocked on you: a pending question, a
// permission to grant, or a finished turn.
fn waiting_on_you(s: &Session) -> bool {
    s.has_question || s.state == "attention" || s.state == "waiting"
}

// Links can come from a transcript, so only ordinary web URLs leave the app.
fn open_externally(url: &str) {
    if url.starts_with("http://") || url.starts_with("https://") {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .build()
}

fn fetch_sessions(agent: &ureq::Agent) -> Option<Vec<Session>> {
    let payload: Sessions = agent
        .get(&format!("{BASE}/api/sessions"))
        .call()
        .ok()?
        .into_json()
        .ok()?;
    Some(payload.sessions)
}

fn to_waiting(sessions: Vec<Session>) -> Vec<Waiting> {
    sessions
        .into_iter()
        .filter(waiting_on_you)
        .take(6)
        .map(|s| Waiting {
            reason: s
                .question
                .as_ref()
                .and_then(|q| q.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| match s.state.as_str() {
                    "attention" => "action required".into(),
                    "ended" => "session ended".into(),
                    _ => "finished its turn".into(),
                }),
            id: s.id,
            title: s.title,
            project: s.project_name,
        })
        .collect()
}

// Sessions blocked on you, as the quick window and the tray menu list them.
#[tauri::command]
fn waiting() -> Vec<Waiting> {
    fetch_sessions(&agent()).map(to_waiting).unwrap_or_default()
}

// The tail of a conversation, so a reply can be written with the thread in
// view. A turn that only ran tools is kept as a one-line trace.
#[tauri::command]
fn transcript(id: String) -> Vec<Message> {
    let Ok(resp) = agent()
        .get(&format!("{BASE}/api/session"))
        .query("id", &id)
        .call()
    else {
        return Vec::new();
    };
    let Ok(detail) = resp.into_json::<Detail>() else { return Vec::new() };
    let mut out: Vec<Message> = detail
        .messages
        .into_iter()
        .filter_map(|m| {
            let text = if !m.text.trim().is_empty() {
                m.text
            } else if m.tools.is_empty() {
                return None;
            } else {
                let names: Vec<&str> = m.tools.iter().map(|t| t.name.as_str()).collect();
                format!("· {}", names.join(", "))
            };
            Some(Message { role: m.role, text })
        })
        .collect();
    let keep = out.len().saturating_sub(10);
    out.drain(..keep);
    out
}

#[tauri::command]
fn send_reply(id: String, text: String) -> Result<(), String> {
    agent()
        .post(&format!("{BASE}/api/reply"))
        .send_json(ureq::json!({ "id": id, "text": text }))
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// The dashboard is served from another origin, where a failed call is
// indistinguishable from a call never made. This is how it reports back.
#[tauri::command]
fn page_log(msg: String) {
    eprintln!("page: {msg}");
}

#[tauri::command]
fn hide_quick(app: AppHandle) {
    if let Some(w) = app.get_webview_window("quick") {
        let _ = w.hide();
    }
}

// The shortcut both summons and dismisses the window.
fn toggle_quick(app: &AppHandle) {
    let Some(w) = app.get_webview_window("quick") else { return };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
    } else {
        let _ = w.center();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// Anything that is not the page the window was built for goes to the browser.
// The quick window hosts no dashboard, so the dashboard is foreign to it too.
fn route_navigation(url: &tauri::Url, dashboard_allowed: bool) -> bool {
    let is_web = matches!(url.scheme(), "http" | "https");
    let dashboard = url.port() == Some(4123);
    let leaving = is_web && !(dashboard && dashboard_allowed);
    if leaving {
        eprintln!("handing {url} to the browser");
        open_externally(url.as_str());
    }
    !leaving
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// Answers "is this the build I just made?" without a version to keep in sync.
fn built_ago() -> String {
    let secs = std::env::current_exe()
        .and_then(std::fs::metadata)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|d| d.as_secs());
    match secs {
        None => "build age unknown".into(),
        Some(s) if s < 3600 => format!("built {} min ago", s / 60),
        Some(s) if s < 86_400 => format!("built {} h ago", s / 3600),
        Some(s) => format!("built {} d ago", s / 86_400),
    }
}

// The menu is rebuilt only when the list it shows changes, so a heartbeat
// every few seconds does not keep replacing an identical menu.
static MENU_SIG: Mutex<String> = Mutex::new(String::new());

fn sync_menu(app: &AppHandle, tray: &TrayIcon, list: &[Waiting]) {
    let (mics, current_mic) = microphones();
    let signature = list
        .iter()
        .map(|w| format!("{}\u{1}{}", w.id, w.title))
        .chain(std::iter::once(format!("{}\u{1}{}", mics.join(","), current_mic)))
        .collect::<Vec<_>>()
        .join("\u{2}");
    let Ok(mut last) = MENU_SIG.lock() else { return };
    if *last == signature {
        return;
    }

    let mut items: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = Vec::new();
    let Ok(open) = MenuItem::with_id(app, "open", "Open hooked", true, None::<&str>) else { return };
    items.push(Box::new(open));
    if !list.is_empty() {
        let Ok(sep) = PredefinedMenuItem::separator(app) else { return };
        items.push(Box::new(sep));
        for w in list {
            let label = format!("{} — {}", w.title, w.project);
            if let Ok(item) = MenuItem::with_id(app, format!("s:{}", w.id), label, true, None::<&str>) {
                items.push(Box::new(item));
            }
        }
    }
    if mics.len() > 1 {
        let entries: Vec<CheckMenuItem<tauri::Wry>> = mics
            .iter()
            .filter_map(|m| {
                CheckMenuItem::with_id(app, format!("mic:{m}"), m, true, *m == current_mic, None::<&str>).ok()
            })
            .collect();
        let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = entries.iter().map(|m| m as &dyn IsMenuItem<_>).collect();
        if let Ok(menu) = Submenu::with_items(app, "Microphone", true, &refs) {
            let Ok(sep) = PredefinedMenuItem::separator(app) else { return };
            items.push(Box::new(sep));
            items.push(Box::new(menu));
        }
    }

    let Ok(sep) = PredefinedMenuItem::separator(app) else { return };
    items.push(Box::new(sep));
    if let Ok(test) = MenuItem::with_id(app, "test-toast", "Show a test notice", true, None::<&str>) {
        items.push(Box::new(test));
    }
    let Ok(quit) = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>) else { return };
    items.push(Box::new(quit));

    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items.iter().map(|b| b.as_ref()).collect();
    if let Ok(menu) = Menu::with_items(app, &refs) {
        if tray.set_menu(Some(menu)).is_ok() {
            *last = signature;
        }
    }
}

// Dictation follows the system input device, and nothing in the page can
// choose one. SwitchAudioSource is the lever; without it the submenu is simply
// absent.
fn switch_audio(args: &[&str]) -> Option<String> {
    let bin = ["/opt/homebrew/bin/SwitchAudioSource", "/usr/local/bin/SwitchAudioSource"]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())?;
    let out = std::process::Command::new(bin).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

static MIC_CACHE: Mutex<Option<(Instant, Vec<String>, String)>> = Mutex::new(None);

// Two process spawns per tick would be a lot for a list that changes when you
// plug something in.
fn microphones() -> (Vec<String>, String) {
    let Ok(mut cache) = MIC_CACHE.lock() else { return (Vec::new(), String::new()) };
    if let Some((at, devices, current)) = cache.as_ref() {
        if at.elapsed() < Duration::from_secs(15) {
            return (devices.clone(), current.clone());
        }
    }
    let devices: Vec<String> = switch_audio(&["-a", "-t", "input"])
        .map(|s| s.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default();
    let current = switch_audio(&["-c", "-t", "input"]).unwrap_or_default().trim().to_string();
    *cache = Some((Instant::now(), devices.clone(), current.clone()));
    (devices, current)
}

fn choose_microphone(app: &AppHandle, name: &str) {
    switch_audio(&["-s", name, "-t", "input"]);
    if let Ok(mut cache) = MIC_CACHE.lock() {
        *cache = None;
    }
    // The tick would otherwise leave the tick mark on the old device.
    if let Ok(mut sig) = MENU_SIG.lock() {
        sig.clear();
    }
    if let Some(list) = poll_waiting(&agent()) {
        if let Some(tray) = app.tray_by_id("main") {
            sync_menu(app, &tray, &list);
        }
    }
}

#[tauri::command]
fn hide_toast(app: AppHandle) {
    if let Some(w) = app.get_webview_window("toast") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn open_from_toast(app: AppHandle, id: String) {
    hide_toast(app.clone());
    open_session(&app, &id);
}

// Top right, under the menu bar.
fn place_toast(win: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = win.primary_monitor() else {
        eprintln!("toast: no monitor");
        return;
    };
    let scale = monitor.scale_factor();
    let screen = monitor.size().to_logical::<f64>(scale);
    let origin = monitor.position().to_logical::<f64>(scale);
    let _ = win.set_position(tauri::LogicalPosition::new(
        origin.x + screen.width - TOAST_W - 16.0,
        origin.y + 36.0,
    ));
}

fn show_toast(app: &AppHandle, session: &Waiting, extra: usize) {
    let Some(win) = app.get_webview_window("toast") else {
        eprintln!("toast: no window");
        return;
    };
    let payload = serde_json::json!({
        "id": session.id,
        "title": session.title,
        "project": session.project,
        "reason": session.reason,
        "extra": extra,
    });
    let _ = win.eval(&format!("render({payload})"));
    place_toast(&win);
    let _ = win.show();
}

static ANNOUNCED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

// Only a session that was not already waiting is news. The first pass records
// without announcing, so a restart does not replay everything at once.
fn announce(app: &AppHandle, list: &[Waiting]) {
    let Ok(mut announced) = ANNOUNCED.lock() else { return };
    let now: HashSet<String> = list.iter().map(|w| w.id.clone()).collect();
    if let Some(before) = announced.as_ref() {
        let fresh: Vec<&Waiting> = list.iter().filter(|w| !before.contains(&w.id)).collect();
        if let Some(first) = fresh.first() {
            show_toast(app, first, fresh.len() - 1);
        }
    }
    *announced = Some(now);
}

// Brings the dashboard up on one session.
fn open_session(app: &AppHandle, id: &str) {
    show_window(app);
    if let Some(w) = app.get_webview_window("main") {
        let path = serde_json::json!(format!("/session/{id}"));
        let _ = w.eval(&format!("location.assign({path})"));
    }
}

fn paint_tray(app: &AppHandle, waiting: Option<Vec<Waiting>>) {
    let Some(tray) = app.tray_by_id("main") else { return };
    let age = built_ago();
    if let Some(list) = waiting.as_deref() {
        sync_menu(app, &tray, list);
        announce(app, list);
    }
    match waiting.as_ref().map(|l| l.len()) {
        Some(0) => {
            let _ = tray.set_title(None::<&str>);
            let _ = tray.set_tooltip(Some(format!("hooked — nothing waiting · {age}")));
        }
        Some(n) => {
            let _ = tray.set_title(Some(n.to_string()));
            let _ = tray.set_tooltip(Some(format!("hooked — {n} waiting for you · {age}")));
        }
        None => {
            let _ = tray.set_title(Some("·"));
            let _ = tray.set_tooltip(Some(format!("hooked — service unreachable · {age}")));
        }
    }
}

fn poll_waiting(agent: &ureq::Agent) -> Option<Vec<Waiting>> {
    Some(to_waiting(fetch_sessions(agent)?))
}

// The dashboard already pushes an event on every hook and transcript write, plus
// a heartbeat. We follow that stream and re-read the session list on each one,
// so the tray stays right whether or not the window is open.
fn follow_stream(app: AppHandle) {
    std::thread::spawn(move || {
        let agent = ureq::AgentBuilder::new()
            // Longer than the stream's own heartbeat, so a silent connection is
            // a dead one.
            .timeout_read(Duration::from_secs(30))
            .build();
        loop {
            match agent.get(&format!("{BASE}/api/stream")).call() {
                Ok(resp) => {
                    paint_tray(&app, poll_waiting(&agent));
                    for line in BufReader::new(resp.into_reader()).lines() {
                        match line {
                            Ok(l) if l.starts_with("data:") => {
                                paint_tray(&app, poll_waiting(&agent))
                            }
                            Ok(_) => {}
                            Err(_) => break,
                        }
                    }
                }
                Err(_) => paint_tray(&app, None),
            }
            std::thread::sleep(Duration::from_secs(3));
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![waiting, transcript, send_reply, hide_quick, page_log, hide_toast, open_from_toast])
        .setup(|app| {
            let handle = app.handle().clone();

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("hooked")
                .inner_size(1280.0, 860.0)
                .min_inner_size(480.0, 520.0)
                .initialization_script(SHIM)
                // Catches what the click handler cannot: anything that
                // navigates the window somewhere other than the dashboard.
                .on_navigation(|url| route_navigation(url, true))
                .build()?;

            // Closing hides the window instead of destroying it: the page keeps
            // running, so notifications survive.
            let hidden = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });

            // A menu to start from; the poller replaces it with the session list.
            let open = MenuItem::with_id(app, "open", "Open hooked", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .menu(&menu)
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    match id {
                        "open" => show_window(app),
                        "quit" => app.exit(0),
                        "test-toast" => show_toast(
                            app,
                            &Waiting {
                                id: String::new(),
                                title: "Test notice".into(),
                                project: "hooked".into(),
                                reason: "this is what a finished turn looks like".into(),
                            },
                            0,
                        ),
                        _ => {
                            if let Some(session) = id.strip_prefix("s:") {
                                open_session(app, session);
                            } else if let Some(mic) = id.strip_prefix("mic:") {
                                choose_microphone(app, mic);
                            }
                        }
                    }
                })
                .build(app)?;

            // Small, frameless, on top of everything: answering a session should
            // not mean leaving what you are doing.
            let quick = WebviewWindowBuilder::new(app, "quick", WebviewUrl::App("quick.html".into()))
                .title("hooked quick reply")
                .inner_size(680.0, 520.0)
                .resizable(false)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible(false)
                .center()
                .on_navigation(|url| route_navigation(url, false))
                .build()?;

            // Clicking elsewhere dismisses it, like any other overlay.
            let blurred = quick.clone();
            quick.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    let _ = blurred.hide();
                }
            });

            // Visual notice that does not go through the system: it follows the
            // same stream as the menu bar count, so it works with the dashboard
            // closed and whatever the system allows.
            WebviewWindowBuilder::new(app, "toast", WebviewUrl::App("toast.html".into()))
                .title("hooked")
                .inner_size(TOAST_W, 68.0)
                .resizable(false)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .build()?;

            let hotkey = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyH);
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, pressed, event| {
                        if event.state() == ShortcutState::Pressed && pressed == &hotkey {
                            toggle_quick(app);
                        }
                    })
                    .build(),
            )?;
            app.global_shortcut().register(hotkey)?;

            // Tells apart "macOS refuses to show anything" from "the page never
            // asked": HOOKED_TEST_NOTIFY=1 fires one banner straight from here.
            if std::env::var_os("HOOKED_TEST_NOTIFY").is_some() {
                use tauri_plugin_notification::NotificationExt;
                let _ = app
                    .notification()
                    .builder()
                    .title("hooked")
                    .body("If you can read this, the system path works.")
                    .show();
            }

            if std::env::var_os("HOOKED_TEST_TOAST").is_some() {
                let probe = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(3));
                    show_toast(
                        &probe,
                        &Waiting {
                            id: String::new(),
                            title: "Test notice".into(),
                            project: "hooked".into(),
                            reason: "this is what a finished turn looks like".into(),
                        },
                        0,
                    );
                });
            }

            follow_stream(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start the hooked window");
}
