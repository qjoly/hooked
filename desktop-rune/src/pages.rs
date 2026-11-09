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

    pub skills: Option<Vec<Value>>,
    pub skill_open: Option<String>,
    pub skill: Option<Value>,

    pub github: Option<Value>,
    pub github_loading: bool,
    pub github_tab: usize,

    pub settings: Option<Value>,
    pub claude: Option<Value>,
    pub git: Option<Value>,
    pub rc: Option<Value>,
    pub hours: Option<TextEdit>,
    pub tag_edit: Option<(String, TextEdit)>,
    pub tag_hue_open: Option<String>,
    pub busy: Option<&'static str>,
    pub settings_stale: bool,
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
            Page::Skills => {
                pd.skills = api::get("/api/skills")
                    .ok()
                    .and_then(|v| v.as_array().cloned());
                if let Some(id) = pd
                    .skills
                    .as_ref()
                    .and_then(|l| l.first())
                    .and_then(|x| x["id"].as_str())
                    .map(str::to_string)
                {
                    pd.skill = api::get(&format!("/api/skills?id={}", urlenc(&id))).ok();
                    pd.skill_open = Some(id);
                }
            }
            Page::Cron => {
                pd.cron = api::get("/api/cron")
                    .ok()
                    .and_then(|v| v["tasks"].as_array().cloned())
                    .unwrap_or_default();
                pd.cron_loaded = true;
            }
            Page::Settings => {
                pd.claude = api::get("/api/claude").ok();
                pd.git = api::get("/api/git").ok();
                pd.rc = api::get("/api/remote-control").ok();
                if let Ok(v) = api::get("/api/settings") {
                    self.apply_settings(v);
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
                            Err(e) => {
                                s.pages.memory = Some(Value::Null);
                                s.flash(format!("✗ Memory: {e}"), true)
                            }
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
            Page::Skills if pd.skills.is_none() => {
                pd.skills = Some(Vec::new());
                let cwds: Vec<String> = self.projects();
                spawn(
                    move || {
                        let q: Vec<String> =
                            cwds.iter().map(|c| format!("cwd={}", urlenc(c))).collect();
                        api::get(&format!("/api/skills?{}", q.join("&")))
                    },
                    |s, r, _| match r {
                        Ok(v) => s.pages.skills = Some(v.as_array().cloned().unwrap_or_default()),
                        Err(e) => s.flash(format!("✗ Skills: {e}"), true),
                    },
                );
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
                            Err(e) => {
                                s.pages.github = Some(Value::Null);
                                s.flash(format!("✗ GitHub: {e}"), true)
                            }
                        }
                    },
                );
                true
            }
            Page::Settings
                if (pd.settings.is_none() || pd.settings_stale) && !pd.settings_loading =>
            {
                pd.settings_stale = false;
                pd.settings_loading = true;
                spawn(
                    || api::get("/api/settings"),
                    |s, r, _| {
                        s.pages.settings_loading = false;
                        s.load_settings_extras();
                        match r {
                            Ok(v) => s.apply_settings(v),
                            Err(e) => {
                                s.pages.settings = Some(json!({}));
                                s.flash(format!("✗ Settings: {e}"), true)
                            }
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
            Page::Skills => self.pages.skills = None,
            Page::Settings => self.pages.settings_stale = true,
            _ => {}
        }
    }

    pub fn open_skill(&mut self, id: String) {
        self.pages.skill_open = Some(id.clone());
        self.pages.skill = None;
        spawn(
            move || api::get(&format!("/api/skills?id={}", urlenc(&id))),
            |s, r, _| match r {
                Ok(v) => s.pages.skill = Some(v),
                Err(e) => s.flash(format!("✗ Skill: {e}"), true),
            },
        );
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
    pub fn apply_settings(&mut self, v: Value) {
        self.pages.settings_project = Some(TextEdit::new(
            v["quickLaunchProject"].as_str().unwrap_or(""),
        ));
        let hours: Vec<String> = v["warmup"]["workHours"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| Some(format!("{}-{}", p.get(0)?.as_str()?, p.get(1)?.as_str()?)))
            .collect();
        self.pages.hours = Some(TextEdit::new(hours.join(", ")));
        self.pages.settings = Some(v);
    }

    pub fn load_settings_extras(&mut self) {
        spawn(
            || {
                (
                    api::get("/api/claude").ok(),
                    api::get("/api/git").ok(),
                    api::get("/api/remote-control").ok(),
                )
            },
            |s, (c, g, r), _| {
                s.pages.claude = c;
                s.pages.git = g;
                s.pages.rc = r;
            },
        );
    }

    pub fn setting(&self, key: &str) -> &Value {
        self.pages
            .settings
            .as_ref()
            .map_or(&Value::Null, |v| &v[key])
    }

    pub fn toggle_in_list(&mut self, key: &str, item: &str) {
        let mut list: Vec<String> = self
            .setting(key)
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|x| x.as_str().map(str::to_string))
            .collect();
        match list.iter().position(|x| x == item) {
            Some(i) => {
                list.remove(i);
            }
            None => list.push(item.to_string()),
        }
        self.save_setting(key, json!(list));
    }

    pub fn save_hours(&mut self) {
        let Some(edit) = self.pages.hours.as_ref() else {
            return;
        };
        let slots: Vec<Value> = edit
            .text
            .split(',')
            .filter_map(|slot| {
                let (a, b) = slot.trim().split_once('-')?;
                let ok = |t: &str| {
                    t.len() == 5
                        && t.as_bytes()[2] == b':'
                        && t.split(':').all(|n| n.parse::<u8>().is_ok())
                };
                (ok(a.trim()) && ok(b.trim())).then(|| json!([a.trim(), b.trim()]))
            })
            .collect();
        if slots.is_empty() {
            self.flash("Working hours look like 09:00-12:00, 14:00-18:00", true);
            return;
        }
        self.save_nested("warmup", "workHours", Value::Array(slots));
        self.flash("✓ Saved", false);
    }

    fn server_action(&mut self, label: &'static str, path: &'static str, body: Value) {
        self.pages.busy = Some(label);
        spawn(
            move || api::post(path, body),
            move |s, r, _| {
                s.pages.busy = None;
                match r {
                    Ok(_) => s.flash(format!("✓ {label}"), false),
                    Err(e) => s.flash(format!("✗ {label}: {e}"), true),
                }
                s.load_settings_extras();
            },
        );
    }

    pub fn resync_states(&mut self) {
        self.server_action("Live states resynced", "/api/resync", json!({}));
    }

    pub fn upgrade_claude(&mut self) {
        self.server_action(
            "Claude Code upgraded",
            "/api/claude",
            json!({ "action": "upgrade" }),
        );
    }

    pub fn rename_tag(&mut self) {
        let Some((old, edit)) = self.pages.tag_edit.take() else {
            return;
        };
        let new = edit.text.trim().trim_start_matches('#').to_lowercase();
        if new.is_empty() || new == old {
            return;
        }
        self.retag(&old, Some(&new));
    }

    pub fn delete_tag(&mut self, tag: &str) {
        self.retag(tag, None);
    }

    /// Tags only exist on sessions, so renaming or deleting one rewrites every session's list.
    fn retag(&mut self, old: &str, new: Option<&str>) {
        for tags in self.tags.values_mut() {
            if let Some(i) = tags.iter().position(|t| t == old) {
                tags.remove(i);
                if let Some(n) = new
                    && !tags.iter().any(|t| t == n)
                {
                    tags.insert(i, n.to_string());
                }
            }
        }
        self.tags.retain(|_, v| !v.is_empty());
        self.tag_filter.retain(|t| t != old);
        let hue = self.tag_colors.get(old).copied();
        self.set_tag_color(old, None);
        if let (Some(n), Some(i)) = (new, hue) {
            self.set_tag_color(n, Some(i));
        }
        let map = json!(self.tags);
        spawn(
            move || api::post("/api/tags", json!({ "replace": map })),
            |s, r, _| match r {
                Ok(_) => s.flash("✓ Tags updated", false),
                Err(e) => s.flash(format!("✗ Tags: {e}"), true),
            },
        );
    }

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

fn urlenc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}
