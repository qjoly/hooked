use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use rune::{Color, Tx};
use rune_luau::mlua::Table;
use rune_luau::{Data, LogLevel, Script, ScriptOptions, Sources};
use serde_json::{Value, json};

use crate::api;
use crate::app::Hooked;

const MEMORY_LIMIT: usize = 16 << 20;
const TIME_LIMIT: Duration = Duration::from_millis(250);
const MODULE_KEY: &str = "hooked.panel.module";
pub const MAX_ACTIONS: usize = 4;
const MAX_LABEL: usize = 40;

#[derive(Clone, Debug, PartialEq)]
pub struct Action {
    pub label: String,
    pub send: Value,
}

pub struct PanelWin {
    pub id: String,
    pub session: Option<String>,
    pub title: String,
    pub rev: u64,
    pub source_rev: u64,
    pub script: Script,
    pub status: Option<(String, bool)>,
    pub minimized: bool,
    pub unseen: bool,
    state: Rc<RefCell<Data>>,
    dark: Rc<Cell<bool>>,
    actions: RefCell<Option<(u64, Vec<Action>)>>,
    stale: Option<String>,
    reported: Option<String>,
    rejected: Option<String>,
}

pub fn to_data(v: &Value) -> Data {
    match v {
        Value::Null => Data::Nil,
        Value::Bool(b) => Data::Bool(*b),
        Value::Number(n) => n.as_i64().map_or_else(|| Data::Number(n.as_f64().unwrap_or(0.0)), Data::Integer),
        Value::String(s) => Data::String(s.clone()),
        Value::Array(a) => Data::List(a.iter().map(to_data).collect()),
        Value::Object(m) => Data::Map(m.iter().map(|(k, v)| (k.clone(), to_data(v))).collect()),
    }
}

fn parse_actions(d: &Data) -> Vec<Action> {
    let Data::List(items) = d else { return Vec::new() };
    items
        .iter()
        .filter_map(|a| {
            let label = a.get("label").as_str()?.trim();
            (!label.is_empty()).then(|| Action {
                label: label.chars().take(MAX_LABEL).collect(),
                send: a.get("send").to_json(),
            })
        })
        .take(MAX_ACTIONS)
        .collect()
}

pub fn sources(files: &Value) -> Sources {
    let mut s = Sources::new();
    if let Some(m) = files.as_object() {
        for (path, src) in m {
            if let Some(src) = src.as_str() {
                s.insert(path, src);
            }
        }
    }
    s
}

/// A panel as `show_panel` would ship it, from a folder of `.luau` files and an optional
/// `state.json`: for `--panel <dir>` snapshots.
pub fn panel_from_dir(dir: &str) -> Value {
    let path = std::path::Path::new(dir);
    let mut files = serde_json::Map::new();
    for e in std::fs::read_dir(path).into_iter().flatten().flatten() {
        let p = e.path();
        if p.extension().is_some_and(|x| x == "luau")
            && let (Some(name), Ok(src)) = (p.file_name().and_then(|n| n.to_str()), std::fs::read_to_string(&p))
        {
            files.insert(name.to_string(), json!(src));
        }
    }
    let state = std::fs::read_to_string(path.join("state.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let id = path.file_name().and_then(|n| n.to_str()).unwrap_or("panel");
    json!({ "id": id, "title": id, "files": files, "state": state, "rev": 1, "sourceRev": 1 })
}

fn palette(dark: Rc<Cell<bool>>) -> rune_luau::Palette {
    let kits = [crate::theme::kit(false).c, crate::theme::kit(true).c];
    let fallback = rune_luau::default_palette();
    Rc::new(move |name: &str, system_dark: bool| -> Option<Color> {
        let c = &kits[usize::from(dark.get())];
        Some(match name {
            "bg" => c.bg_base,
            "bg-deep" => c.bg_deep,
            "surface" => c.surface_raised,
            "text" => c.text_base,
            "text-muted" | "text-secondary" => c.text_muted,
            "text-faint" => c.text_faint,
            "text-accent" => c.text_accent,
            "accent" => c.bg_accent,
            "border" => c.border_base,
            "border-weak" => c.border_weak,
            "border-strong" => c.border_strong,
            "hover" => c.hover,
            "press" => c.pressed,
            "success" => c.success.icon,
            "warning" => c.warning.icon,
            "danger" => c.danger.icon,
            "info" => c.info.icon,
            "success-bg" => c.success.bg,
            "warning-bg" => c.warning.bg,
            "danger-bg" => c.danger.bg,
            "info-bg" => c.info.bg,
            _ => return fallback(name, system_dark),
        })
    })
}

impl PanelWin {
    pub fn new(panel: &Value, dark: bool) -> Self {
        let state = Rc::new(RefCell::new(to_data(&panel["state"])));
        let dark = Rc::new(Cell::new(dark));
        let id = panel["id"].as_str().unwrap_or("panel").to_string();
        let st = state.clone();
        let tag = id.clone();
        let options = ScriptOptions::new()
            .memory_limit(MEMORY_LIMIT)
            .time_limit(TIME_LIMIT)
            .palette(palette(dark.clone()))
            .on_log(move |level, line| {
                if level != LogLevel::Info {
                    eprintln!("panel {tag} {level:?}: {line}");
                }
            })
            .setup(move |host| {
                let lua = host.lua();
                let m = lua.create_table()?;
                m.raw_set("state", st.borrow().clone())?;
                m.raw_set("changed", host.signal("changed")?)?;
                lua.set_named_registry_value(MODULE_KEY, &m)?;
                host.register_module("@hooked", m)
            });
        let script = Script::with_options(&format!("panel-{id}"), sources(&panel["files"]), options);
        PanelWin {
            title: panel["title"].as_str().unwrap_or(&id).to_string(),
            session: panel["session"].as_str().map(str::to_string),
            rev: panel["rev"].as_u64().unwrap_or(0),
            source_rev: panel["sourceRev"].as_u64().unwrap_or(0),
            id,
            script,
            status: None,
            minimized: false,
            unseen: false,
            state,
            dark,
            actions: RefCell::default(),
            stale: None,
            reported: None,
            rejected: None,
        }
    }

    pub fn same(&self, panel: &Value) -> bool {
        panel["id"].as_str() == Some(&self.id) && panel["session"].as_str() == self.session.as_deref()
    }

    /// A later show_panel call for this panel: new source reloads the VM (keeping
    /// `saveHotState`), new state reaches the script through `hooked.changed`.
    pub fn update(&mut self, panel: &Value) {
        let rev = panel["rev"].as_u64().unwrap_or(0);
        if rev <= self.rev {
            return;
        }
        self.rev = rev;
        self.unseen = self.minimized;
        self.stale = self.last_error();
        self.reported = None;
        if let Some(t) = panel["title"].as_str() {
            self.title = t.to_string();
        }
        let data = to_data(&panel["state"]);
        *self.state.borrow_mut() = data.clone();
        let source_rev = panel["sourceRev"].as_u64().unwrap_or(0);
        if source_rev != self.source_rev {
            self.source_rev = source_rev;
            if let Err(e) = self.script.reload(sources(&panel["files"])) {
                self.status = Some((format!("New source rejected: {}", e.message), true));
                self.rejected = Some(e.message);
            }
            return;
        }
        self.script.with_lua(|lua| {
            lua.named_registry_value::<Table>(MODULE_KEY)
                .and_then(|m| m.raw_set("state", data.clone()))
                .ok()
        });
        self.script.fire("changed", [data]);
    }

    pub fn set_minimized(&mut self, minimized: bool) {
        self.minimized = minimized;
        if !minimized {
            self.unseen = false;
        }
    }

    pub fn set_dark(&self, dark: bool) {
        self.dark.set(dark);
    }

    /// The buttons hooked draws in its own footer, from the module's `actions()`. Scripts never
    /// place a sending control themselves: one inside their area could be hidden or stretched
    /// over other content, and its click would reach the session.
    pub fn actions(&self) -> Vec<Action> {
        let version = self.script.version();
        if let Some((v, a)) = self.actions.borrow().as_ref()
            && *v == version
        {
            return a.clone();
        }
        let list = self
            .script
            .module()
            .and_then(|m| m.raw_get::<Option<rune_luau::mlua::Function>>("actions").ok().flatten())
            .and_then(|f| self.script.eval_fn::<Data>(&f, ()).ok())
            .map(|d| parse_actions(&d))
            .unwrap_or_default();
        *self.actions.borrow_mut() = Some((self.script.version(), list.clone()));
        list
    }

    fn last_error(&self) -> Option<String> {
        self.script.error().map(|e| e.message).or_else(|| {
            self.script
                .log()
                .into_iter()
                .rev()
                .find(|l| l.level == LogLevel::Error)
                .map(|l| l.message)
        })
    }

    /// A script error Claude hasn't been told about yet. An error already showing before the
    /// latest show_panel call belongs to the previous version and is never reported again.
    pub fn take_problem(&mut self) -> Option<String> {
        if let Some(e) = self.rejected.take() {
            self.reported = Some(e.clone());
            return Some(e);
        }
        let e = self.last_error()?;
        if self.stale.as_ref() == Some(&e) || self.reported.as_ref() == Some(&e) {
            return None;
        }
        self.reported = Some(e.clone());
        Some(e)
    }

    pub fn last_problem(&self) -> Option<String> {
        if let Some(e) = self.script.error() {
            return Some(e.message);
        }
        self.script
            .log()
            .into_iter()
            .rev()
            .find(|l| l.level != LogLevel::Info)
            .map(|l| l.message)
    }
}

impl Hooked {
    pub fn show_panel(&mut self, panel: Value) {
        if let Some(w) = self.panel_win.as_mut()
            && w.same(&panel)
        {
            w.update(&panel);
            return;
        }
        self.panel_win = Some(PanelWin::new(&panel, self.theme_dark.get()));
    }

    pub fn closed_panel(&mut self, panel: &Value) {
        if self.panel_win.as_ref().is_some_and(|w| w.same(panel)) {
            self.panel_win = None;
        }
    }

    pub fn poll_panel(&mut self, clock: f64, tx: &mut Tx) -> bool {
        let Some(w) = self.panel_win.as_mut() else {
            return false;
        };
        let ran = w.script.poll(clock, tx);
        if let Some(message) = w.take_problem() {
            let body = json!({ "op": "error", "id": w.id, "session": w.session, "rev": w.rev, "message": message });
            self.spawn(move || api::post_any("/api/panel", body), |_, _, _| {});
        }
        ran
    }

    pub fn panel_click(&mut self, action: Action) {
        let Some(w) = self.panel_win.as_mut() else {
            return;
        };
        w.status = Some((format!("Sending \"{}\"…", action.label), false));
        let body = json!({ "op": "send", "id": w.id, "session": w.session, "label": action.label, "value": action.send });
        self.spawn(
            move || api::post_any("/api/panel", body),
            |s, r, _| {
                let status = match r {
                    Ok(v) if v.get("error").is_some() => {
                        (format!("Not sent: {}", v["error"].as_str().unwrap_or("")), true)
                    }
                    Ok(_) => ("Sent to the session".to_string(), false),
                    Err(e) => (format!("Not sent: {e}"), true),
                };
                if let Some(w) = s.panel_win.as_mut() {
                    w.status = Some(status);
                }
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_crosses_into_luau_data() {
        let d = to_data(&json!({"n": 3, "x": 1.5, "steps": [{"done": true}], "s": null}));
        assert_eq!(d.get("n"), &Data::Integer(3));
        assert_eq!(d.get("x"), &Data::Number(1.5));
        assert!(matches!(d.get("steps"), Data::List(l) if l.len() == 1));
    }

    #[test]
    fn a_panel_follows_its_state_and_declares_actions() {
        let src = r#"
            local ui = require("@rune/ui")
            local hooked = require("@hooked")
            local n = hooked.state.n
            hooked.changed:Connect(function(s) n = s.n end)
            return {
                render = function() return ui.text(`n={n}`) end,
                count = function() return n end,
                actions = function()
                    return {
                        { label = "Pick", send = { picked = n } },
                        { label = "  " },
                        { label = "Skip" },
                        { label = "3" }, { label = "4" }, { label = "5" },
                    }
                end,
            }
        "#;
        let mut w = PanelWin::new(
            &json!({"id": "t", "rev": 1, "sourceRev": 1, "files": {"init.luau": src}, "state": {"n": 1}}),
            true,
        );
        assert!(w.script.error().is_none(), "{:?}", w.script.error());
        assert_eq!(w.actions()[0], Action { label: "Pick".into(), send: json!({"picked": 1}) });
        w.update(&json!({"id": "t", "rev": 2, "sourceRev": 1, "state": {"n": 7}}));
        w.script.poll(1.0, &mut Tx::default());
        assert_eq!(w.script.query("count", []).unwrap(), Data::Integer(7));
        let actions = w.actions();
        assert_eq!(actions[0].send, json!({"picked": 7}));
        assert_eq!(actions[1], Action { label: "Skip".into(), send: Value::Null });
        assert_eq!(actions.len(), MAX_ACTIONS);
    }

    #[test]
    fn a_script_cannot_send_by_itself() {
        let src = r#"return { render = function() return nil end, probe = function() return type(require("@hooked").send) end }"#;
        let w = PanelWin::new(&json!({"id": "t", "files": {"init.luau": src}}), true);
        assert_eq!(w.script.query("probe", []).unwrap(), Data::String("nil".into()));
        assert!(w.actions().is_empty());
    }

    #[test]
    fn script_errors_are_reported_once_per_version() {
        let broken = "return { render = function( end }";
        let mut w = PanelWin::new(&json!({"id": "t", "rev": 1, "sourceRev": 1, "files": {"init.luau": broken}}), true);
        assert!(w.take_problem().is_some());
        assert!(w.take_problem().is_none());

        let fixed = r#"return { render = function() return nil end, boom = function() error("kaboom") end }"#;
        w.update(&json!({"id": "t", "rev": 2, "sourceRev": 2, "files": {"init.luau": fixed}}));
        assert!(w.take_problem().is_none(), "{:?}", w.script.log());

        w.script.call("boom", []).unwrap();
        assert!(w.take_problem().is_some_and(|m| m.contains("kaboom")));
        assert!(w.take_problem().is_none());

        w.update(&json!({"id": "t", "rev": 3, "sourceRev": 2, "state": {"n": 1}}));
        assert!(w.take_problem().is_none());

        let mut w = PanelWin::new(&json!({"id": "t", "rev": 1, "sourceRev": 1, "files": {"init.luau": fixed}}), true);
        w.update(&json!({"id": "t", "rev": 2, "sourceRev": 2, "files": {"init.luau": broken}}));
        let first = w.take_problem().unwrap();
        w.update(&json!({"id": "t", "rev": 3, "sourceRev": 3, "files": {"init.luau": broken}}));
        assert_eq!(w.take_problem(), Some(first), "the same mistake twice is reported twice");
        assert!(w.take_problem().is_none());
    }

    #[test]
    fn a_minimized_panel_flags_updates_until_expanded() {
        let src = "return { render = function() return nil end }";
        let mut w = PanelWin::new(&json!({"id": "t", "rev": 1, "sourceRev": 1, "files": {"init.luau": src}}), true);
        w.update(&json!({"id": "t", "rev": 2, "sourceRev": 1, "state": 1}));
        assert!(!w.unseen);
        w.set_minimized(true);
        w.update(&json!({"id": "t", "rev": 3, "sourceRev": 1, "state": 2}));
        assert!(w.minimized && w.unseen);
        w.set_minimized(false);
        assert!(!w.unseen);
    }

    #[test]
    fn a_runaway_script_is_stopped() {
        let src = r#"return { render = function() return nil end, spin = function() while true do end end }"#;
        let w = PanelWin::new(&json!({"id": "t", "files": {"init.luau": src}}), true);
        let e = w.script.query("spin", []).unwrap_err();
        assert!(!e.message.is_empty());
    }

    #[test]
    fn the_sandbox_has_no_io() {
        let src = r#"return {
            render = function() return nil end,
            probe = function()
                local inner = loadstring("return type(io), type(os.execute), type(os.getenv)")
                local a, b, c = inner()
                local escaped = pcall(require, "../../../etc/hosts")
                return `{type(io)} {type(os.execute)} {a} {b} {c} {escaped}`
            end,
        }"#;
        let w = PanelWin::new(&json!({"id": "t", "files": {"init.luau": src}}), true);
        assert_eq!(
            w.script.query("probe", []).unwrap(),
            Data::String("nil nil nil nil nil false".into())
        );
    }
}
