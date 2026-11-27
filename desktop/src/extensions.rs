//! The extensions the service lists (`GET /api/extensions`, docs/extensions.md): their pages in
//! the navigation, their switches and declarative settings, and their session menu actions. A
//! declarative page itself is `crate::extview`.

use std::collections::HashMap;

use rune::{Icon, TextEdit};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::{self, enc};
use crate::app::{Hooked, Page};
use crate::extview::{ExtView, Outcome};
use crate::icons;

/// A fallback only: the service pushes `extensionsChanged` on its stream (`start_workers`).
const LIST_REFRESH_MS: i64 = 30_000;

/// Legacy extensions whose desktop page is native code of this app, by extension id. Any other
/// extension page is `Page::Ext`.
const NATIVE_PAGES: [(&str, Page); 3] = [("flows", Page::Flows), ("github", Page::GitHub), ("incidents", Page::Incidents)];

/// An extension as GET /api/extensions lists it (the fields the app needs).
#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ExtInfo {
    pub id: String,
    pub label: String,
    pub version: String,
    pub description: String,
    pub icon: String,
    pub page: Option<Value>,
    pub desktop: Option<Value>,
    pub settings: Vec<Value>,
    pub session_menu: Vec<Value>,
    pub source: String,
    pub origin: Option<Value>,
    pub enabled: bool,
    pub active: bool,
    pub errors: Vec<Value>,
}

impl ExtInfo {
    /// The API route of its declarative desktop view, if it has one.
    pub fn view_route(&self) -> Option<&str> {
        self.desktop.as_ref()?["view"].as_str()
    }

    pub fn page_key(&self) -> Option<&str> {
        self.page.as_ref()?["key"].as_str()
    }

    pub fn order(&self) -> f64 {
        self.page.as_ref().and_then(|p| p["order"].as_f64()).unwrap_or(1000.0)
    }

    /// Where its page opens in this app, if it has one.
    pub fn app_page(&self) -> Option<Page> {
        self.page_key()?;
        Some(NATIVE_PAGES.iter().find(|(id, _)| *id == self.id).map_or_else(|| Page::Ext(intern(&self.id)), |(_, p)| *p))
    }

    /// Where it comes from: the repository and commit the launcher installed, else its source.
    pub fn provenance(&self) -> String {
        let o = self.origin.as_ref().filter(|o| o["repo"].is_string());
        match o {
            Some(o) => {
                let commit = o["commit"].as_str().unwrap_or("");
                format!("{}@{}", o["repo"].as_str().unwrap_or(""), &commit[..commit.len().min(7)])
            }
            None => [self.source.as_str(), self.version.as_str()].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" · "),
        }
    }
}

#[derive(Debug, Default)]
pub struct ExtState {
    pub list: Vec<ExtInfo>,
    /// Entries of `rejected` / `pending`, shown as they come (`{ id, error }`, `{ id, state }`).
    pub rejected: Vec<Value>,
    pub pending: Vec<Value>,
    pub list_at: i64,
    pub views: HashMap<String, ExtView>,
    pub settings: HashMap<String, SettingsForm>,
}

impl ExtState {
    pub fn apply(&mut self, v: &Value) {
        self.list = serde_json::from_value(v["extensions"].clone()).unwrap_or_default();
        self.rejected = v["rejected"].as_array().cloned().unwrap_or_default();
        self.pending = v["pending"].as_array().cloned().unwrap_or_default();
    }
}

/// Extension ids, labels and keys as `&'static str`, so `Page` stays `Copy` and the navigation
/// keeps its static tables: a handful of strings, leaked once each.
pub fn intern(s: &str) -> &'static str {
    use std::sync::{Mutex, OnceLock};
    static ALL: OnceLock<Mutex<Vec<&'static str>>> = OnceLock::new();
    let mut all = ALL.get_or_init(Default::default).lock().unwrap();
    if let Some(found) = all.iter().copied().find(|x| *x == s) {
        return found;
    }
    let leaked: &'static str = Box::leak(s.to_string().into_boxed_str());
    all.push(leaked);
    leaked
}

pub fn icon_named(name: &str) -> &'static Icon {
    match name {
        "clock" | "timer" => &icons::TIMER,
        "plus" => &icons::PLUS,
        "play" => &icons::PLAY,
        "zap" | "sparkle" => &icons::SPARKLE,
        "github" | "pr" => &icons::GITHUB,
        "warning" | "siren" => &icons::SIREN,
        "workflow" => &icons::WORKFLOW,
        "book" => &icons::BOOK,
        _ => &icons::PLUG,
    }
}

/// The extension a page belongs to, if any.
pub fn page_extension(page: Page) -> Option<&'static str> {
    match page {
        Page::Ext(id) => Some(id),
        _ => NATIVE_PAGES.iter().find(|(_, p)| *p == page).map(|(id, _)| *id),
    }
}

/// A page of the navigation: (settings key, element key, label, icon, page).
pub type NavPage = (&'static str, &'static str, &'static str, &'static Icon, Page);

/// The pages of the active extensions with their `page.order`, for the top bar, the palette and
/// Settings → navigation.
pub fn nav_entries(list: &[ExtInfo]) -> Vec<(NavPage, f64)> {
    list.iter()
        .filter(|e| e.active)
        .filter_map(|e| {
            let key = intern(e.page_key()?);
            Some(((key, intern(&format!("tb-{key}")), intern(&e.label), icon_named(&e.icon), e.app_page()?), e.order()))
        })
        .collect()
}

/// The session menu entries of the active extensions, as (extension id, entry), filtered by
/// `when`. hooked drives a session exactly when it is `live` here, so `driven` and `live` read the
/// same flag, as on the web.
pub fn session_actions(list: &[ExtInfo], live: bool) -> Vec<(&str, &Value)> {
    list.iter()
        .filter(|e| e.active)
        .flat_map(|e| e.session_menu.iter().map(move |a| (e.id.as_str(), a)))
        .filter(|(_, a)| match a["when"].as_str().unwrap_or("any") {
            "any" => true,
            "driven" | "live" => live,
            _ => false,
        })
        .collect()
}

/// The text a declarative setting is edited as: a list as comma-separated items.
pub fn setting_text(kind: &str, v: &Value) -> String {
    match (kind, v) {
        ("list", Value::Array(a)) => a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "),
        (_, Value::String(s)) => s.clone(),
        (_, Value::Null) => String::new(),
        (_, v) => v.to_string(),
    }
}

/// What a typed setting sends. Only a number that does not parse is refused here: bounds and the
/// rest are the service's to check, so its message is the one shown.
pub fn setting_value(kind: &str, text: &str) -> Result<Value, String> {
    match kind {
        "number" => text.trim().parse::<f64>().map(|n| json!(n)).map_err(|_| "Not a number".to_string()),
        "list" => Ok(text.split([',', '\n']).map(str::trim).filter(|x| !x.is_empty()).collect::<Vec<_>>().into()),
        _ => Ok(json!(text)),
    }
}

/// One extension's declarative settings as Settings → Extensions edits them.
#[derive(Debug, Default)]
pub struct SettingsForm {
    pub schema: Vec<Value>,
    pub values: Value,
    /// What is typed in the text fields (`number`, `string`, `list`), saved on Enter.
    pub drafts: HashMap<String, TextEdit>,
    pub errors: HashMap<String, String>,
}

impl SettingsForm {
    pub fn new(schema: Vec<Value>, values: Value) -> SettingsForm {
        let drafts = schema
            .iter()
            .filter(|f| matches!(f["type"].as_str(), Some("number" | "string" | "list")))
            .filter_map(|f| {
                let key = f["key"].as_str()?;
                Some((key.to_string(), TextEdit::new(setting_text(f["type"].as_str().unwrap_or(""), &values[key]))))
            })
            .collect();
        SettingsForm { schema, values, drafts, errors: HashMap::new() }
    }

    fn kind(&self, key: &str) -> &str {
        self.schema.iter().find(|f| f["key"] == key).and_then(|f| f["type"].as_str()).unwrap_or("")
    }
}

impl Hooked {
    pub fn ext_info(&self, id: &str) -> Option<&ExtInfo> {
        self.ext.list.iter().find(|e| e.id == id)
    }

    /// Whether an extension is on: what the service's list says once loaded, else the switches of
    /// the settings (`modules` is the mirror an older service only has). Unnamed means on.
    pub fn extension_on(&self, id: &str) -> bool {
        if let Some(e) = self.ext_info(id) {
            return e.active;
        }
        let named = |k: &str| self.setting(k)[id].as_bool();
        named("extensions").or_else(|| named("modules")) != Some(false)
    }

    /// The page of the extension whose page has `key` (a nav key, `defaultPage`, `--page`).
    pub fn ext_page_for(&self, key: &str) -> Option<Page> {
        self.ext.list.iter().filter(|e| e.active && e.page_key() == Some(key)).find_map(ExtInfo::app_page)
    }

    fn apply_extensions(&mut self, v: &Value) {
        self.ext.apply(v);
        // An extension switched off or removed takes its page with it, the open one included: no
        // tab is left behind to say it is off.
        if !self.page_on(self.page) {
            if let Page::Ext(id) = self.page {
                self.ext.views.remove(id);
            }
            self.go_deck();
        }
    }

    pub fn load_extensions(&mut self) {
        self.ext.list_at = crate::fmt::now_ms();
        self.spawn(
            || api::get("/api/extensions"),
            |s, r, _| {
                if let Ok(v) = r {
                    s.apply_extensions(&v);
                }
            },
        );
    }

    pub fn poll_extension_list(&mut self, now: i64) {
        if now - self.ext.list_at > LIST_REFRESH_MS {
            self.load_extensions();
        }
    }

    pub fn set_extension_enabled(&mut self, id: &str, enabled: bool) {
        let body = json!({ "id": id, "enabled": enabled });
        self.spawn(
            move || api::post_any("/api/extensions", body),
            |s, r, _| match r {
                Ok(v) if v["extensions"].is_array() => s.apply_extensions(&v),
                Ok(v) => s.flash(format!("✗ {}", v["error"].as_str().unwrap_or("The service refused the switch")), true),
                Err(e) => s.flash(format!("✗ {e}"), true),
            },
        );
    }

    pub fn run_session_action(&mut self, ext: &str, post: &str, session: &str) {
        let (url, body) = (format!("/api/{ext}/{post}"), json!({ "sessionId": session }));
        self.spawn(
            move || api::post_any(&url, body),
            |s, r, _| {
                let v = r.unwrap_or_else(|e| json!({ "error": e }));
                if let Some(e) = v["error"].as_str() {
                    return s.flash(format!("✗ {e}"), true);
                }
                if let Some(f) = v["flash"].as_str() {
                    s.flash(format!("✓ {f}"), false);
                }
                let open = &v["open"];
                if let Some(id) = open["session"].as_str() {
                    s.open_session(id);
                } else if let Some(key) = open["page"].as_str() {
                    s.open_extension_page(key, open["rest"].as_str().unwrap_or(""));
                }
            },
        );
    }

    pub fn open_extension_page(&mut self, key: &str, rest: &str) {
        let Some(page) = self.ext_page_for(key) else {
            return self.flash(format!("✗ No page {key} in this app"), true);
        };
        self.go(page);
        if let Page::Ext(id) = page
            && !rest.is_empty()
        {
            self.ext_open(id, rest);
        }
    }

    fn settings_ids(&self) -> Vec<String> {
        self.ext.list.iter().filter(|e| !e.settings.is_empty()).map(|e| e.id.clone()).collect()
    }

    fn store_extension_settings(&mut self, answers: Vec<(String, Value)>) {
        for (id, v) in answers {
            let schema = v["schema"].as_array().cloned().unwrap_or_default();
            self.ext.settings.insert(id, SettingsForm::new(schema, v["values"].clone()));
        }
    }

    pub fn load_extension_settings(&mut self) {
        let ids = self.settings_ids();
        self.spawn(move || fetch_settings(ids), |s, answers, _| s.store_extension_settings(answers));
    }

    /// The synchronous twin of `load_extension_settings`, for headless renders.
    pub fn preload_extension_settings(&mut self) {
        let answers = fetch_settings(self.settings_ids());
        self.store_extension_settings(answers);
    }

    /// Saves one setting along with the others as they were saved.
    pub fn save_extension_setting(&mut self, id: &str, key: &str, value: Value) {
        let Some(form) = self.ext.settings.get(id) else { return };
        let mut values = form.values.as_object().cloned().unwrap_or_default();
        values.insert(key.to_string(), value);
        let body = json!({ "id": id, "values": values });
        let id = id.to_string();
        self.spawn(
            move || api::post_any("/api/extensions/settings", body),
            move |s, r, _| {
                let v = r.unwrap_or_else(|e| json!({ "error": e }));
                let Some(form) = s.ext.settings.get_mut(&id) else { return };
                if v["values"].is_object() {
                    *form = SettingsForm::new(std::mem::take(&mut form.schema), v["values"].clone());
                    return;
                }
                let out = Outcome::from(&v);
                form.errors = out.errors;
                if let Some(e) = out.error {
                    s.flash(format!("✗ {e}"), true);
                }
            },
        );
    }

    /// Saves what is typed in a text setting, once it reads as its type.
    pub fn submit_extension_setting(&mut self, id: &str, key: &str) {
        let Some(form) = self.ext.settings.get_mut(id) else { return };
        let parsed = setting_value(form.kind(key), form.drafts.get(key).map_or("", |t| t.text.as_str()));
        match parsed {
            Ok(v) => self.save_extension_setting(id, key, v),
            Err(e) => {
                form.errors.insert(key.to_string(), e);
            }
        }
    }
}

fn fetch_settings(ids: Vec<String>) -> Vec<(String, Value)> {
    ids.into_iter().filter_map(|id| Some((id.clone(), api::get(&format!("/api/extensions/settings?id={}", enc(&id))).ok()?))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list() -> Vec<ExtInfo> {
        let path = format!("{}/tests/fixtures/extview/extensions.json", env!("CARGO_MANIFEST_DIR"));
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        serde_json::from_value(v["extensions"].clone()).unwrap()
    }

    #[test]
    fn the_navigation_holds_the_pages_of_the_active_extensions() {
        let list = list();
        let pages: Vec<(&str, Page, f64)> = nav_entries(&list).into_iter().map(|((key, _, _, _, page), order)| (key, page, order)).collect();
        // Legacy pages keep their native code; Flows is off, Hello has no page.
        assert_eq!(pages, vec![("cron", Page::Ext(intern("cron")), 80.0), ("github", Page::GitHub, 50.0)]);
        assert_eq!(page_extension(Page::GitHub), Some("github"));
        assert_eq!(page_extension(Page::Ext(intern("cron"))), Some("cron"));
        assert_eq!(page_extension(Page::Stats), None);
        assert_eq!(list[0].view_route(), Some("view"));
        assert_eq!(list[1].view_route(), None);
    }

    #[test]
    fn says_where_an_extension_comes_from() {
        let list = list();
        assert_eq!(list[0].provenance(), "bundled · 1.0.0");
        assert_eq!(list[1].provenance(), "acme/hooked-hello@0123456");
    }

    #[test]
    fn session_menu_entries_follow_when() {
        let list = list();
        let ids = |live| session_actions(&list, live).iter().map(|(ext, a)| format!("{ext}/{}", a["id"].as_str().unwrap())).collect::<Vec<_>>();
        assert_eq!(ids(false), vec!["hello/say-hello"]);
        assert_eq!(ids(true), vec!["hello/say-hello", "hello/nudge", "hello/stop"]);
    }

    #[test]
    fn declarative_settings_edit_as_text_and_parse_back() {
        let schema = list()[1].settings.clone();
        let form = SettingsForm::new(schema, json!({ "loud": true, "name": "you", "max": 3, "tags": ["a", "b"] }));
        assert_eq!(form.drafts["name"].text, "you");
        assert_eq!(form.drafts["max"].text, "3");
        assert_eq!(form.drafts["tags"].text, "a, b");
        assert!(!form.drafts.contains_key("loud"), "a bool is a switch, not a draft");
        assert_eq!(form.kind("tags"), "list");
        assert_eq!(setting_value("list", "a,\n b ,, c"), Ok(json!(["a", "b", "c"])));
        assert_eq!(setting_value("number", " 4 "), Ok(json!(4.0)));
        assert!(setting_value("number", "four").is_err());
        assert_eq!(setting_value("string", " x "), Ok(json!(" x ")));
    }
}
