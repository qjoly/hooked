use rune::TextEdit;
use serde_json::{Value, json};

use crate::api;
use crate::app::{Hooked, Page, refresh_sessions, spawn};

pub const GITHUB_TABS: [(&str, &str); 4] = [
    ("review", "Review requested"),
    ("mine", "My pull requests"),
    ("issues", "Assigned issues"),
    ("notifications", "Notifications"),
];

pub const STATS_RANGES: [(&str, &str); 4] = [
    ("1", "Today"),
    ("7", "7 days"),
    ("30", "30 days"),
    ("all", "All"),
];

pub struct CronForm {
    pub id: Option<String>,
    pub name: TextEdit,
    pub schedule: TextEdit,
    pub cwd: TextEdit,
    pub prompt: TextEdit,
    pub enabled: bool,
}

impl CronForm {
    fn from(task: Option<&Value>) -> CronForm {
        let t = |k: &str| task.and_then(|v| v[k].as_str()).unwrap_or("").to_string();
        CronForm {
            id: task.and_then(|v| v["id"].as_str()).map(str::to_string),
            name: TextEdit::new(t("name")),
            schedule: TextEdit::new(if task.is_some() {
                t("schedule")
            } else {
                "0 9 * * 1-5".into()
            }),
            cwd: TextEdit::new(t("cwd")),
            prompt: TextEdit::new(t("prompt")),
            enabled: task.is_none_or(|v| v["enabled"].as_bool().unwrap_or(true)),
        }
    }
}

#[derive(Default)]
pub struct PageData {
    pub stats_range: usize,
    pub stats: Option<Value>,
    pub stats_loaded_for: Option<usize>,
    pub stats_loading: bool,

    pub digests: Vec<Value>,
    pub digests_loaded: bool,
    pub digest_date: Option<String>,
    pub digest: Option<Value>,
    pub digest_loading: bool,

    pub memory: Option<Value>,
    pub memory_loading: bool,
    pub memory_project: usize,
    pub memory_open: Option<String>,

    pub cron: Vec<Value>,
    pub cron_loaded: bool,
    pub cron_form: Option<CronForm>,

    pub github: Option<Value>,
    pub github_loading: bool,
    pub github_tab: usize,

    pub settings: Option<Value>,
    pub settings_loading: bool,
    pub settings_project: Option<TextEdit>,
}

impl Hooked {
    /// The synchronous twin of `ensure_page`, for headless renders where no worker lands in time.
    pub fn preload_page(&mut self) {
        let pd = &mut self.pages;
        match self.page {
            Page::Stats => {
                pd.stats = api::get("/api/stats?range=7").ok();
                pd.stats_range = 1;
                pd.stats_loaded_for = Some(1);
            }
            Page::Digest => {
                if let Ok(v) = api::get("/api/digest") {
                    pd.digests = v["digests"].as_array().cloned().unwrap_or_default();
                    pd.digests_loaded = true;
                    if let Some(d) = pd
                        .digests
                        .iter()
                        .find(|d| d["totals"]["sessions"].as_f64().unwrap_or(0.0) > 1.0)
                        .and_then(|d| d["date"].as_str())
                    {
                        pd.digest_date = Some(d.to_string());
                        pd.digest = api::get(&format!("/api/digest?date={d}")).ok();
                    }
                }
            }
            Page::Memory => pd.memory = api::get("/api/memory").ok(),
            Page::GitHub => pd.github = api::get("/api/github").ok(),
            Page::Cron => {
                pd.cron = api::get("/api/cron")
                    .ok()
                    .and_then(|v| v["tasks"].as_array().cloned())
                    .unwrap_or_default();
                pd.cron_loaded = true;
            }
            Page::Settings => {
                if let Ok(v) = api::get("/api/settings") {
                    pd.settings_project = Some(TextEdit::new(
                        v["quickLaunchProject"].as_str().unwrap_or(""),
                    ));
                    pd.settings = Some(v);
                }
                self.caps = api::capabilities().unwrap_or_default();
            }
            _ => {}
        }
    }

    /// Starts the fetch the open page is missing; true when state changed synchronously.
    pub fn ensure_page(&mut self) -> bool {
        let pd = &mut self.pages;
        match self.page {
            Page::Stats if pd.stats_loaded_for != Some(pd.stats_range) && !pd.stats_loading => {
                pd.stats_loading = true;
                let range = pd.stats_range;
                spawn(
                    move || api::get(&format!("/api/stats?range={}", STATS_RANGES[range].0)),
                    move |s, r, _| {
                        s.pages.stats_loading = false;
                        s.pages.stats_loaded_for = Some(range);
                        match r {
                            Ok(v) => s.pages.stats = Some(v),
                            Err(e) => s.flash(format!("✗ Stats: {e}"), true),
                        }
                    },
                );
                true
            }
            Page::Digest if !pd.digests_loaded && !pd.digest_loading => {
                pd.digest_loading = true;
                spawn(
                    || api::get("/api/digest"),
                    |s, r, _| {
                        s.pages.digest_loading = false;
                        s.pages.digests_loaded = true;
                        match r {
                            Ok(v) => {
                                s.pages.digests =
                                    v["digests"].as_array().cloned().unwrap_or_default();
                                let first = v["latest"].as_str().map(str::to_string);
                                if s.pages.digest_date.is_none()
                                    && let Some(d) = first
                                {
                                    s.open_digest(d);
                                }
                            }
                            Err(e) => s.flash(format!("✗ Digest: {e}"), true),
                        }
                    },
                );
                true
            }
            Page::Memory if pd.memory.is_none() && !pd.memory_loading => {
                pd.memory_loading = true;
                spawn(
                    || api::get("/api/memory"),
                    |s, r, _| {
                        s.pages.memory_loading = false;
                        match r {
                            Ok(v) => s.pages.memory = Some(v),
                            Err(e) => s.flash(format!("✗ Memory: {e}"), true),
                        }
                    },
                );
                true
            }
            Page::Cron if !pd.cron_loaded => {
                pd.cron_loaded = true;
                self.load_cron();
                true
            }
            Page::GitHub if pd.github.is_none() && !pd.github_loading => {
                pd.github_loading = true;
                spawn(
                    || api::get("/api/github"),
                    |s, r, _| {
                        s.pages.github_loading = false;
                        match r {
                            Ok(v) => s.pages.github = Some(v),
                            Err(e) => s.flash(format!("✗ GitHub: {e}"), true),
                        }
                    },
                );
                true
            }
            Page::Settings if pd.settings.is_none() && !pd.settings_loading => {
                pd.settings_loading = true;
                spawn(
                    || api::get("/api/settings"),
                    |s, r, _| {
                        s.pages.settings_loading = false;
                        match r {
                            Ok(v) => {
                                s.pages.settings_project = Some(TextEdit::new(
                                    v["quickLaunchProject"].as_str().unwrap_or(""),
                                ));
                                s.pages.settings = Some(v);
                            }
                            Err(e) => s.flash(format!("✗ Settings: {e}"), true),
                        }
                    },
                );
                true
            }
            _ => false,
        }
    }

    pub fn go(&mut self, page: Page) {
        self.page = page;
        self.popup = None;
        self.palette_open = false;
        match page {
            Page::Stats => self.pages.stats_loaded_for = None,
            Page::Digest => self.pages.digests_loaded = false,
            Page::Memory => self.pages.memory = None,
            Page::Cron => self.pages.cron_loaded = false,
            Page::GitHub => self.pages.github = None,
            Page::Settings => self.pages.settings = None,
            _ => {}
        }
    }

    pub fn open_digest(&mut self, date: String) {
        self.pages.digest_date = Some(date.clone());
        self.pages.digest = None;
        spawn(
            move || api::get(&format!("/api/digest?date={date}")),
            |s, r, _| match r {
                Ok(v) => s.pages.digest = Some(v),
                Err(e) => s.flash(format!("✗ Digest: {e}"), true),
            },
        );
    }

    pub fn generate_digest(&mut self, force: bool) {
        let Some(date) = self.pages.digest_date.clone() else {
            return;
        };
        self.flash("Generating the digest… this takes a minute", false);
        spawn(
            move || api::post("/api/digest", json!({ "date": date, "force": force })),
            |s, r, _| match r {
                Ok(_) => {
                    s.flash("✓ Digest generated", false);
                    if let Some(d) = s.pages.digest_date.clone() {
                        s.open_digest(d);
                    }
                }
                Err(e) => s.flash(format!("✗ Digest: {e}"), true),
            },
        );
    }

    pub fn load_cron(&mut self) {
        spawn(
            || api::get("/api/cron"),
            |s, r, _| match r {
                Ok(v) => s.pages.cron = v["tasks"].as_array().cloned().unwrap_or_default(),
                Err(e) => s.flash(format!("✗ Cron: {e}"), true),
            },
        );
    }

    pub fn edit_cron(&mut self, id: Option<String>) {
        let task = id.and_then(|id| {
            self.pages
                .cron
                .iter()
                .find(|t| t["id"].as_str() == Some(id.as_str()))
                .cloned()
        });
        let mut form = CronForm::from(task.as_ref());
        if task.is_none() {
            let p = self
                .detail
                .as_ref()
                .and_then(|d| d.session.project.clone())
                .unwrap_or_default();
            form.cwd = TextEdit::new(p);
            form.name.focused = true;
        }
        self.pages.cron_form = Some(form);
    }

    fn cron_op(&mut self, body: Value, done: &'static str) {
        spawn(
            move || api::post("/api/cron", body),
            move |s, r, _| {
                match r {
                    Ok(_) => s.flash(format!("✓ {done}"), false),
                    Err(e) => s.flash(format!("✗ {e}"), true),
                }
                s.load_cron();
                refresh_sessions();
            },
        );
    }

    pub fn save_cron(&mut self) {
        let Some(f) = self.pages.cron_form.as_ref() else {
            return;
        };
        let mut task = json!({
            "name": f.name.text.trim(),
            "schedule": f.schedule.text.trim(),
            "cwd": f.cwd.text.trim(),
            "prompt": f.prompt.text.trim(),
            "enabled": f.enabled,
        });
        if let Some(id) = f.id.as_ref() {
            task["id"] = json!(id);
        }
        self.pages.cron_form = None;
        self.cron_op(json!({ "op": "save", "task": task }), "Saved");
    }

    pub fn toggle_cron(&mut self, id: String) {
        let Some(t) = self
            .pages
            .cron
            .iter_mut()
            .find(|t| t["id"].as_str() == Some(id.as_str()))
        else {
            return;
        };
        let on = !t["enabled"].as_bool().unwrap_or(true);
        t["enabled"] = json!(on);
        self.cron_op(
            json!({ "op": "save", "task": { "id": id, "enabled": on } }),
            if on { "Enabled" } else { "Paused" },
        );
    }

    pub fn run_cron(&mut self, id: String) {
        self.cron_op(json!({ "op": "run", "id": id }), "Started");
    }

    pub fn delete_cron(&mut self, id: String) {
        self.pages
            .cron
            .retain(|t| t["id"].as_str() != Some(id.as_str()));
        self.cron_op(json!({ "op": "delete", "id": id }), "Deleted");
    }

    /// Settings are a shallow merge server-side, so a nested object is sent whole.
    pub fn save_setting(&mut self, key: &str, value: Value) {
        if let Some(s) = self.pages.settings.as_mut() {
            s[key] = value.clone();
        }
        let body = json!({ key: value });
        spawn(
            move || api::post("/api/settings", body),
            |s, r, _| {
                if let Err(e) = r {
                    s.flash(format!("✗ Settings: {e}"), true);
                }
            },
        );
    }

    pub fn save_nested(&mut self, key: &str, field: &str, value: Value) {
        let mut obj = self
            .pages
            .settings
            .as_ref()
            .map(|s| s[key].clone())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        obj[field] = value;
        self.save_setting(key, obj);
    }
}
