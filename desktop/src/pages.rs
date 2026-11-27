use rune::TextEdit;
use serde_json::{Value, json};

use crate::api;
use crate::app::{Hooked, Page};

/// The tab listing every open pull request of the selected repository. The page's other lists
/// only hold the viewer's own PRs and direct review requests, so a picked repo looked empty.
pub const GITHUB_REPO_TAB: (&str, &str) = ("repo", "Open pull requests");

/// The tabs on screen: the repository one leads while a repository is picked.
pub fn gh_tabs(repo_picked: bool) -> Vec<(&'static str, &'static str)> {
    let mut tabs = Vec::with_capacity(GITHUB_TABS.len() + 1);
    if repo_picked {
        tabs.push(GITHUB_REPO_TAB);
    }
    tabs.extend(GITHUB_TABS);
    tabs
}

/// Where the selected tab lands when the repository tab appears or goes away, so the same
/// list stays selected; picking a first repository jumps to its pull requests.
pub fn gh_tab_after_pick(tab: usize, was_picked: bool, picked: bool) -> usize {
    match (was_picked, picked) {
        (false, true) => 0,
        (true, false) => tab.saturating_sub(1),
        _ => tab,
    }
}

pub const GITHUB_TABS: [(&str, &str); 5] = [
    ("review", "Review requested"),
    ("mine", "My pull requests"),
    ("reviews", "Latest reviews"),
    ("issues", "Assigned issues"),
    ("notifications", "Notifications"),
];

/// Reviews others left on my pull requests, newest first, as their own feed.
pub fn gh_reviews(v: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for pr in v["mine"].as_array().into_iter().flatten() {
        for rv in pr["reviews"].as_array().into_iter().flatten() {
            if rv["author"] == pr["author"] {
                continue;
            }
            let mut x = rv.clone();
            x["repo"] = pr["repo"].clone();
            x["title"] = pr["title"].clone();
            x["number"] = pr["number"].clone();
            x["url"] = pr["url"].clone();
            x["updatedAt"] = rv["at"].clone();
            out.push(x);
        }
    }
    out.sort_by(|a, b| b["at"].as_str().cmp(&a["at"].as_str()));
    out
}

/// The web's `ghFilter`: words with a `/` scope to repos by prefix, the rest must all match.
pub fn gh_keep(query: &str, x: &Value) -> bool {
    let q = query.trim().to_lowercase();
    let words: Vec<&str> = q.split_whitespace().collect();
    let repo = x["repo"].as_str().unwrap_or("").to_lowercase();
    let title = x["title"]
        .as_str()
        .or(x["subject"].as_str())
        .unwrap_or("")
        .to_lowercase();
    let scopes: Vec<&&str> = words.iter().filter(|w| w.contains('/')).collect();
    let in_scope = scopes.is_empty() || scopes.iter().any(|s| repo.starts_with(**s));
    in_scope
        && words
            .iter()
            .filter(|w| !w.contains('/'))
            .all(|t| title.contains(t) || repo.contains(t))
}

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

/// The Flows page's "New run" form.
pub struct FlowForm {
    pub template: usize,
    pub cwd: TextEdit,
    pub task: TextEdit,
    pub name: TextEdit,
    pub worktree: bool,
}

/// One stage in the template editor. `uid` stays put while the key is edited, so the links
/// between stages (`after`, `loop_to`) survive a rename; keys are resolved on save.
pub struct StageForm {
    pub uid: u32,
    pub key: TextEdit,
    pub name: TextEdit,
    pub role: TextEdit,
    pub after: Vec<u32>,
    pub decider: bool,
    pub loop_to: Option<u32>,
    pub writes: bool,
    pub model: String,
    pub effort: String,
    pub mode: String,
}

/// The Flows page's template editor.
pub struct TplForm {
    pub id: Option<String>,
    pub built_in: bool,
    pub name: TextEdit,
    pub description: TextEdit,
    pub max_loops: TextEdit,
    pub worktree: bool,
    pub stages: Vec<StageForm>,
    pub next_uid: u32,
    pub error: Option<String>,
}

pub const FLOW_MODELS: [&str; 4] = ["inherit", "opus", "sonnet", "haiku"];
pub const FLOW_EFFORTS: [&str; 6] = ["inherit", "low", "medium", "high", "xhigh", "max"];
pub const FLOW_MODES: [&str; 5] = ["default", "acceptEdits", "auto", "plan", "bypassPermissions"];

impl TplForm {
    pub fn from(t: Option<&Value>) -> TplForm {
        let st = |v: &Value, k: &str| v[k].as_str().unwrap_or("").to_string();
        let list: Vec<Value> = t
            .and_then(|t| t["stages"].as_array().cloned())
            .unwrap_or_else(|| vec![json!({ "key": "work", "name": "Work", "after": [] })]);
        let uid_of = |key: &str| list.iter().position(|x| x["key"].as_str() == Some(key)).map(|i| i as u32);
        let stages = list
            .iter()
            .enumerate()
            .map(|(i, v)| StageForm {
                uid: i as u32,
                key: TextEdit::new(st(v, "key")),
                name: TextEdit::new(st(v, "name")),
                role: TextEdit::new(st(v, "role")),
                after: v["after"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|a| uid_of(a.as_str()?))
                    .collect(),
                decider: v["decider"] == true,
                loop_to: v["loopTo"].as_str().and_then(uid_of),
                writes: v["writes"] == true,
                model: st(v, "model"),
                effort: st(v, "effort"),
                mode: v["permissionMode"].as_str().unwrap_or("default").to_string(),
            })
            .collect::<Vec<_>>();
        TplForm {
            id: t.and_then(|t| t["id"].as_str()).map(str::to_string),
            built_in: t.is_some_and(|t| t["builtIn"] == true),
            name: TextEdit::new(t.map_or("New flow".into(), |t| st(t, "name"))),
            description: TextEdit::new(t.map_or(String::new(), |t| st(t, "description"))),
            max_loops: TextEdit::new(t.and_then(|t| t["maxLoops"].as_i64()).unwrap_or(3).to_string()),
            worktree: t.is_none_or(|t| t["worktree"] != false),
            next_uid: stages.len() as u32,
            stages,
            error: None,
        }
    }

    fn key_of(&self, uid: u32) -> Option<String> {
        self.stages
            .iter()
            .find(|x| x.uid == uid)
            .map(|x| x.key.text.trim().to_lowercase())
    }

    /// The template as `/api/flows` takes it (and as the preview draws it).
    pub fn to_json(&self) -> Value {
        let stages: Vec<Value> = self
            .stages
            .iter()
            .map(|x| {
                let opt = |v: &str| if v.is_empty() || v == "inherit" { Value::Null } else { json!(v) };
                json!({
                    "key": x.key.text.trim().to_lowercase(),
                    "name": x.name.text.trim(),
                    "role": x.role.text.trim(),
                    "after": x.after.iter().filter_map(|u| self.key_of(*u)).collect::<Vec<_>>(),
                    "decider": x.decider,
                    "loopTo": if x.decider { x.loop_to.and_then(|u| self.key_of(u)) } else { None },
                    "writes": x.writes,
                    "model": opt(&x.model),
                    "effort": opt(&x.effort),
                    "permissionMode": x.mode,
                })
            })
            .collect();
        let mut t = json!({
            "name": self.name.text.trim(),
            "description": self.description.text.trim(),
            "maxLoops": self.max_loops.text.trim().parse::<i64>().unwrap_or(3),
            "worktree": self.worktree,
            "stages": stages,
        });
        if let Some(id) = self.id.as_ref() {
            t["id"] = json!(id);
        }
        t
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
    pub memory_query: TextEdit,
    pub cron_history: Option<String>,
    pub digest_pick: TextEdit,
    pub warmup: Option<Value>,
    pub branches_open: bool,
    pub checkout_dirty: Option<String>,
    pub memory_type: Option<String>,
    pub skills_query: TextEdit,

    pub cron: Vec<Value>,
    pub cron_loaded: bool,
    pub cron_form: Option<CronForm>,

    /// `{ templates, runs }` from `/api/flows`.
    pub flows: Option<Value>,
    pub flows_loading: bool,
    /// A tick landed during a load: load once more when it returns.
    pub flows_stale: bool,
    pub flow_run: Option<String>,
    pub flow_stage: Option<String>,
    pub flow_form: Option<FlowForm>,
    pub flow_note: TextEdit,
    pub flow_tpl: Option<TplForm>,

    pub skills: Option<Vec<Value>>,
    pub skill_open: Option<String>,
    pub skill: Option<Value>,

    pub github: Option<Value>,
    pub github_loading: bool,
    pub github_tab: usize,
    pub gh_query: TextEdit,
    pub gh_repo: Option<String>,
    /// `{ repo, total, prs }` (or `{ repo, error }`) for the picked repository.
    pub gh_repo_prs: Option<Value>,
    /// The next GitHub load waits for fresh data instead of taking the server's cached copy.
    pub github_force: bool,
    /// Pull request actions in flight or done, by URL: "approving", "approved", "reviewing".
    pub gh_acts: std::collections::HashMap<String, &'static str>,
    /// The right-click menu of a GitHub row: (url, author, where the click landed).
    pub gh_menu: Option<(String, String, rune::PointerPress)>,

    pub settings: Option<Value>,
    pub claude: Option<Value>,
    pub git: Option<Value>,
    pub rc: Option<Value>,
    pub hours: Option<TextEdit>,
    pub tag_edit: Option<(String, TextEdit)>,
    pub tag_hue_open: Option<String>,
    pub prompt_sel: Option<Option<usize>>,
    pub prompt_name: TextEdit,
    pub prompt_text: TextEdit,
    pub busy: Option<&'static str>,
    pub settings_stale: bool,
    pub settings_loading: bool,
    pub settings_project: Option<TextEdit>,
    /// Settings → Remote instances: the two fields of the add form.
    pub remote_name: TextEdit,
    pub remote_url: TextEdit,
    /// Settings → This app → Server: the address of the hooked service, as typed.
    pub server_url: TextEdit,
    pub wt_location: Option<TextEdit>,
    pub wt_names: Option<TextEdit>,
    pub wt_cleanup: Option<Value>,
    pub wt_pull: Option<Value>,
    pub settings_tops: Vec<f32>,
    pub settings_last_h: f32,
    pub settings_view: [f32; 2],
    pub settings_active: usize,
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
            Page::Incidents => self.preload_incidents(),
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
            Page::Flows => {
                pd.flows = api::get("/api/flows").ok();
                pd.flow_run = pd
                    .flows
                    .as_ref()
                    .and_then(|v| v["runs"][0]["id"].as_str())
                    .map(str::to_string);
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
                pd.warmup = api::get("/api/warmup").ok();
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
                self.spawn(
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
                self.spawn(
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
                self.spawn(
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
            Page::Flows if pd.flows.is_none() && !pd.flows_loading => {
                self.load_flows();
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
                self.spawn(
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
                let path = if std::mem::take(&mut pd.github_force) {
                    "/api/github?refresh=1"
                } else {
                    "/api/github"
                };
                self.spawn(
                    move || api::get(path),
                    |s, r, _| {
                        s.pages.github_loading = false;
                        match r {
                            // The server answers at once with its last copy; a stale one is
                            // swapped for the refresh it started, without blanking the page.
                            Ok(v) => {
                                if v["stale"].as_bool() == Some(true) {
                                    s.spawn(
                                        || api::get("/api/github?refresh=1"),
                                        |s, r, _| {
                                            if let Ok(v) = r
                                                && s.pages.github.is_some()
                                            {
                                                s.pages.github = Some(v);
                                            }
                                        },
                                    );
                                }
                                s.pages.github = Some(v);
                            }
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
                self.spawn(
                    || api::get("/api/settings"),
                    |s, r, _| {
                        s.pages.settings_loading = false;
                        s.load_settings_extras();
                        match r {
                            Ok(v) => s.apply_settings(v),
                            Err(e) => {
                                // The page renders from something: what was read before stays, else nothing.
                                if s.pages.settings.is_none() {
                                    s.pages.settings = Some(json!({}));
                                }
                                s.flash(format!("✗ Settings: {e}"), true)
                            }
                        }
                    },
                );
                true
            }
            Page::Incidents => self.ensure_incidents(),
            _ => false,
        }
    }

    pub fn prompts(&self) -> Vec<(String, String)> {
        self.setting("promptLibrary")
            .as_array()
            .into_iter()
            .flatten()
            .map(|p| {
                (
                    p["name"].as_str().unwrap_or("").to_string(),
                    p["text"].as_str().unwrap_or("").to_string(),
                )
            })
            .collect()
    }

    pub fn edit_prompt(&mut self, index: Option<usize>) {
        let (name, text) = index
            .and_then(|i| self.prompts().get(i).cloned())
            .unwrap_or_default();
        self.pages.prompt_sel = Some(index);
        self.pages.prompt_name = TextEdit::new(name);
        self.pages.prompt_text = TextEdit::new(text);
        self.pages.prompt_name.focused = true;
    }

    pub fn save_prompt(&mut self) {
        let Some(sel) = self.pages.prompt_sel else {
            return;
        };
        let name = self.pages.prompt_name.text.trim().to_string();
        let text = self.pages.prompt_text.text.trim().to_string();
        if name.is_empty() || text.is_empty() {
            self.flash("A prompt needs a name and a text", true);
            return;
        }
        let mut list = self.prompts();
        let entry = (name, text);
        match sel {
            Some(i) if i < list.len() => list[i] = entry,
            _ => {
                list.push(entry);
                self.pages.prompt_sel = Some(Some(list.len() - 1));
            }
        }
        self.save_prompts(list);
    }

    pub fn delete_prompt(&mut self) {
        let Some(Some(i)) = self.pages.prompt_sel else {
            return;
        };
        let mut list = self.prompts();
        if i < list.len() {
            list.remove(i);
        }
        self.pages.prompt_sel = None;
        self.save_prompts(list);
    }

    fn save_prompts(&mut self, list: Vec<(String, String)>) {
        let v: Vec<Value> = list
            .into_iter()
            .map(|(name, text)| json!({ "name": name, "text": text }))
            .collect();
        self.save_setting("promptLibrary", Value::Array(v));
    }

    /// Approves a pull request on GitHub as the signed-in user.
    pub fn approve_pr(&mut self, url: String) {
        self.pages.gh_acts.insert(url.clone(), "approving");
        let u = url.clone();
        self.spawn(
            move || api::post("/api/github/approve", json!({ "url": u })),
            move |s, r, _| match r {
                Ok(_) => {
                    s.pages.gh_acts.insert(url, "approved");
                    s.flash("✓ Approved", false);
                }
                Err(e) => {
                    s.pages.gh_acts.remove(&url);
                    s.flash(format!("✗ Approve: {e}"), true);
                }
            },
        );
    }

    /// Closes a pull request without merging it, and drops it from the lists on screen.
    pub fn close_pr(&mut self, url: String) {
        let u = url.clone();
        self.spawn(
            move || api::post("/api/github/close", json!({ "url": u })),
            move |s, r, _| match r {
                Ok(_) => {
                    s.flash("✓ Pull request closed", false);
                    for key in ["mine", "review"] {
                        if let Some(l) = s.pages.github.as_mut().and_then(|g| g[key].as_array_mut()) {
                            l.retain(|p| p["url"].as_str() != Some(url.as_str()));
                        }
                    }
                    if let Some(l) = s.pages.gh_repo_prs.as_mut().and_then(|g| g["prs"].as_array_mut()) {
                        l.retain(|p| p["url"].as_str() != Some(url.as_str()));
                    }
                }
                Err(e) => s.flash(format!("✗ Close: {e}"), true),
            },
        );
    }

    /// Opens a new session that reviews the pull request and reports in its conversation only:
    /// nothing is posted to GitHub.
    pub fn review_pr_in_session(&mut self, url: String) {
        self.pages.gh_acts.insert(url.clone(), "reviewing");
        let u = url.clone();
        self.spawn(
            move || api::post("/api/github/review", json!({ "url": u })),
            move |s, r, _| {
                s.pages.gh_acts.remove(&url);
                match r {
                    Ok(v) => match v["sessionId"].as_str() {
                        Some(id) => s.open_session(id),
                        None => s.flash("✓ Review session launched", false),
                    },
                    Err(e) => s.flash(format!("✗ Review: {e}"), true),
                }
            },
        );
    }

    /// Picks (or clears, with `None`) the repository filter, and loads its open pull requests.
    pub fn pick_gh_repo(&mut self, repo: Option<String>) {
        let pd = &mut self.pages;
        pd.github_tab = gh_tab_after_pick(pd.github_tab, pd.gh_repo.is_some(), repo.is_some());
        pd.gh_repo = repo.clone();
        pd.gh_repo_prs = None;
        if let Some(r) = repo {
            self.load_gh_repo(r, false);
        }
    }

    pub fn load_gh_repo(&self, repo: String, refresh: bool) {
        let path = format!(
            "/api/github/repo?repo={}{}",
            urlenc(&repo),
            if refresh { "&refresh=1" } else { "" }
        );
        self.spawn(
            move || api::get(&path),
            move |s, r, _| {
                if s.pages.gh_repo.as_deref() != Some(repo.as_str()) {
                    return; // another repository was picked meanwhile
                }
                s.pages.gh_repo_prs = Some(match r {
                    Ok(v) => v,
                    Err(e) => json!({ "repo": repo, "error": e.to_string() }),
                });
            },
        );
    }

    pub fn gh_items(&self, key: &str) -> Vec<Value> {
        if key == "repo" {
            let q = self.pages.gh_query.text.clone();
            return self
                .pages
                .gh_repo_prs
                .as_ref()
                .and_then(|v| v["prs"].as_array().cloned())
                .unwrap_or_default()
                .into_iter()
                .filter(|x| gh_keep(&q, x))
                .collect();
        }
        let Some(v) = self.pages.github.as_ref() else {
            return Vec::new();
        };
        let all = if key == "reviews" {
            gh_reviews(v)
        } else {
            v[key].as_array().cloned().unwrap_or_default()
        };
        let q = self.pages.gh_query.text.clone();
        let repo = self.pages.gh_repo.clone();
        all.into_iter()
            .filter(|x| {
                repo.as_deref()
                    .is_none_or(|r| x["repo"].as_str() == Some(r))
            })
            .filter(|x| gh_keep(&q, x))
            .collect()
    }

    pub fn mark_notifications_done(&mut self) {
        let ids: Vec<Value> = self
            .gh_items("notifications")
            .iter()
            .filter_map(|n| n["id"].as_str().map(|s| json!(s)))
            .collect();
        if ids.is_empty() {
            return;
        }
        self.spawn(
            move || api::post("/api/github/notifications", json!({ "ids": ids })),
            |s, r, _| match r {
                Ok(v) => {
                    let done: Vec<String> = v["done"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect();
                    if let Some(list) = s
                        .pages
                        .github
                        .as_mut()
                        .and_then(|g| g["notifications"].as_array_mut())
                    {
                        list.retain(|n| !done.iter().any(|d| n["id"].as_str() == Some(d)));
                    }
                    match v["error"].as_str() {
                        Some(e) => s.flash(format!("✗ Some notifications stayed: {e}"), true),
                        None => s.flash(format!("✓ {} marked done", done.len()), false),
                    }
                }
                Err(e) => s.flash(format!("✗ Notifications: {e}"), true),
            },
        );
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
            Page::Flows => self.pages.flows = None,
            Page::GitHub => {
                self.pages.github = None;
                self.pages.gh_menu = None;
            }
            Page::Incidents => self.inc.lists[self.inc.scope].loaded_at = None,
            Page::Skills => self.pages.skills = None,
            Page::Settings => self.pages.settings_stale = true,
            _ => {}
        }
    }

    pub fn open_skill(&mut self, id: String) {
        self.pages.skill_open = Some(id.clone());
        self.pages.skill = None;
        self.spawn(
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
        self.spawn(
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
        self.spawn(
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

    /// Rereads the flows. Called on page open and on every `/api/stream` tick while the page is
    /// up, so the pipeline follows live.
    pub fn load_flows(&mut self) {
        if self.pages.flows_loading {
            self.pages.flows_stale = true;
            return;
        }
        self.pages.flows_loading = true;
        self.spawn(
            || api::get("/api/flows"),
            |s, r, _| {
                s.pages.flows_loading = false;
                match r {
                    Ok(v) => {
                        if s.pages.flow_run.is_none() && s.pages.flow_form.is_none() {
                            s.pages.flow_run = v["runs"][0]["id"].as_str().map(str::to_string);
                        }
                        s.pages.flows = Some(v);
                    }
                    Err(e) => s.flash(format!("✗ Flows: {e}"), true),
                }
                if std::mem::take(&mut s.pages.flows_stale) {
                    s.load_flows();
                }
            },
        );
    }

    /// The selected run, as last loaded.
    pub fn flow_run(&self) -> Option<&Value> {
        let id = self.pages.flow_run.as_deref()?;
        self.pages.flows.as_ref()?["runs"]
            .as_array()?
            .iter()
            .find(|r| r["id"].as_str() == Some(id))
    }

    pub fn open_flow_run(&mut self, id: String) {
        self.pages.flow_form = None;
        self.pages.flow_tpl = None;
        if self.pages.flow_run.as_deref() != Some(id.as_str()) {
            self.pages.flow_stage = None;
        }
        self.pages.flow_run = Some(id);
    }

    pub fn new_flow_run(&mut self) {
        let cwd = self
            .detail
            .as_ref()
            .and_then(|d| d.session.project.clone())
            .unwrap_or_default();
        let mut task = TextEdit::new("");
        task.focused = true;
        self.pages.flow_tpl = None;
        self.pages.flow_form = Some(FlowForm {
            template: 0,
            cwd: TextEdit::new(cwd),
            task,
            name: TextEdit::new(""),
            worktree: true,
        });
    }

    /// A POST to `/api/flows`, then a reload.
    pub fn flow_op(&mut self, body: Value, done: &'static str) {
        self.spawn(
            move || api::post("/api/flows", body),
            move |s, r, _| {
                match r {
                    Ok(_) => s.flash(format!("✓ {done}"), false),
                    Err(e) => s.flash(format!("✗ {e}"), true),
                }
                s.pages.flow_note = TextEdit::new("");
                s.load_flows();
                s.refresh_sessions();
            },
        );
    }

    pub fn start_flow_run(&mut self) {
        let Some(f) = self.pages.flow_form.as_ref() else {
            return;
        };
        let tpl = self
            .pages
            .flows
            .as_ref()
            .and_then(|v| v["templates"].get(f.template))
            .and_then(|t| t["id"].as_str())
            .unwrap_or("feature")
            .to_string();
        let body = json!({
            "op": "start",
            "templateId": tpl,
            "cwd": f.cwd.text.trim(),
            "task": f.task.text.trim(),
            "name": f.name.text.trim(),
            "worktree": f.worktree,
        });
        self.flash("Starting the flow…", false);
        self.spawn(
            move || api::post("/api/flows", body),
            |s, r, _| match r {
                Ok(v) => {
                    s.pages.flow_form = None;
                    s.pages.flow_stage = None;
                    s.pages.flow_run = v["run"]["id"].as_str().map(str::to_string);
                    s.flash("✓ Flow started", false);
                    s.load_flows();
                    s.refresh_sessions();
                }
                Err(e) => s.flash(format!("✗ {e}"), true),
            },
        );
    }

    /// Run-level actions: stop, continue, finish, delete.
    pub fn flow_act(&mut self, op: &'static str) {
        let Some(id) = self.pages.flow_run.clone() else {
            return;
        };
        if op == "delete" {
            self.pages.flow_run = None;
        }
        let done = match op {
            "stop" => "Stopped",
            "continue" => "Resumed",
            "finish" => "Closed",
            _ => "Deleted",
        };
        self.flow_op(json!({ "op": op, "id": id }), done);
    }

    /// Re-runs `stage` and what follows; `looped` counts as a new pass (the decider's `loop`).
    pub fn flow_rerun(&mut self, stage: String, looped: bool) {
        let Some(id) = self.pages.flow_run.clone() else {
            return;
        };
        let note = self.pages.flow_note.text.trim().to_string();
        self.flow_op(
            json!({ "op": "rerun", "id": id, "stage": stage, "loop": looped, "note": note }),
            if looped { "Looping again" } else { "Re-running" },
        );
    }

    pub fn flow_mark_done(&mut self, stage: String) {
        let Some(id) = self.pages.flow_run.clone() else {
            return;
        };
        self.flow_op(
            json!({ "op": "markDone", "id": id, "stage": stage }),
            "Marked done",
        );
    }

    /// Opens the template editor on `id`, or on a blank template.
    pub fn edit_flow_template(&mut self, id: Option<String>) {
        let t = id.and_then(|id| {
            self.pages.flows.as_ref()?["templates"]
                .as_array()?
                .iter()
                .find(|t| t["id"].as_str() == Some(id.as_str()))
                .cloned()
        });
        self.pages.flow_form = None;
        self.pages.flow_tpl = Some(TplForm::from(t.as_ref()));
    }

    /// The editor turns into a new template with the same stages.
    pub fn duplicate_flow_template(&mut self) {
        if let Some(f) = self.pages.flow_tpl.as_mut() {
            f.id = None;
            f.built_in = false;
            f.name = TextEdit::new(format!("{} (copy)", f.name.text.trim()));
        }
    }

    /// The stage `uid` of the template being edited.
    pub fn tpl_stage(&mut self, uid: u32) -> &mut StageForm {
        self.pages
            .flow_tpl
            .as_mut()
            .and_then(|f| f.stages.iter_mut().find(|x| x.uid == uid))
            .expect("stage of the open template")
    }

    /// A new stage after the last non-decider one, placed before the decider.
    pub fn add_tpl_stage(&mut self) {
        let Some(f) = self.pages.flow_tpl.as_mut() else {
            return;
        };
        let uid = f.next_uid;
        f.next_uid += 1;
        let mut n = f.stages.len() + 1;
        while f.stages.iter().any(|x| x.key.text == format!("stage-{n}")) {
            n += 1;
        }
        let last = f.stages.iter().rev().find(|x| !x.decider).map(|x| x.uid);
        let stage = StageForm {
            uid,
            key: TextEdit::new(format!("stage-{n}")),
            name: TextEdit::new(format!("Stage {n}")),
            role: TextEdit::new(""),
            after: last.into_iter().collect(),
            decider: false,
            loop_to: None,
            writes: false,
            model: String::new(),
            effort: String::new(),
            mode: "default".into(),
        };
        // The decider waits on the new stage too, and stays last.
        match f.stages.iter().position(|x| x.decider) {
            Some(i) => {
                f.stages[i].after.retain(|a| Some(*a) != last);
                f.stages[i].after.push(uid);
                f.stages.insert(i, stage);
            }
            None => f.stages.push(stage),
        }
    }

    pub fn remove_tpl_stage(&mut self, uid: u32) {
        let Some(f) = self.pages.flow_tpl.as_mut() else {
            return;
        };
        f.stages.retain(|x| x.uid != uid);
        for x in &mut f.stages {
            x.after.retain(|a| *a != uid);
            if x.loop_to == Some(uid) {
                x.loop_to = None;
            }
        }
    }

    pub fn toggle_tpl_after(&mut self, uid: u32, other: u32) {
        let st = self.tpl_stage(uid);
        match st.after.iter().position(|a| *a == other) {
            Some(i) => {
                st.after.remove(i);
            }
            None => st.after.push(other),
        }
    }

    /// One decider per flow: making a stage the decider demotes the previous one.
    pub fn toggle_tpl_decider(&mut self, uid: u32) {
        let Some(f) = self.pages.flow_tpl.as_mut() else {
            return;
        };
        let on = !f.stages.iter().any(|x| x.uid == uid && x.decider);
        for x in &mut f.stages {
            x.decider = on && x.uid == uid;
        }
    }

    pub fn save_flow_template(&mut self) {
        let Some(f) = self.pages.flow_tpl.as_mut() else {
            return;
        };
        f.error = None;
        let body = json!({ "op": "saveTemplate", "template": f.to_json() });
        self.spawn(
            move || api::post("/api/flows", body),
            |s, r, _| match r {
                Ok(v) => {
                    if let Some(f) = s.pages.flow_tpl.as_mut() {
                        f.id = v["template"]["id"].as_str().map(str::to_string);
                        f.built_in = false;
                    }
                    s.flash("✓ Template saved", false);
                    s.load_flows();
                }
                Err(e) => {
                    if let Some(f) = s.pages.flow_tpl.as_mut() {
                        f.error = Some(e.to_string());
                    }
                }
            },
        );
    }

    /// Deletes the template; for the built-in one, drops the stored copy (the original returns).
    pub fn delete_flow_template(&mut self) {
        let Some(id) = self.pages.flow_tpl.as_ref().and_then(|f| f.id.clone()) else {
            return;
        };
        self.pages.flow_tpl = None;
        self.flow_op(json!({ "op": "deleteTemplate", "id": id }), "Template deleted");
    }

    pub fn load_cron(&mut self) {
        self.spawn(
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
        self.spawn(
            move || api::post("/api/cron", body),
            move |s, r, _| {
                match r {
                    Ok(_) => s.flash(format!("✓ {done}"), false),
                    Err(e) => s.flash(format!("✗ {e}"), true),
                }
                s.load_cron();
                s.refresh_sessions();
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
        self.pages.wt_location = Some(TextEdit::new(v["worktrees"]["location"].as_str().unwrap_or("")));
        self.pages.wt_names = Some(TextEdit::new(v["worktrees"]["nameInstructions"].as_str().unwrap_or("")));
        self.pages.settings = Some(v);
    }

    pub fn load_settings_extras(&mut self) {
        self.spawn(
            || {
                (
                    api::get("/api/claude").ok(),
                    api::get("/api/git").ok(),
                    api::get("/api/remote-control").ok(),
                    api::get("/api/warmup").ok(),
                )
            },
            |s, (c, g, r, w), _| {
                s.pages.claude = c;
                s.pages.git = g;
                s.pages.rc = r;
                s.pages.warmup = w;
            },
        );
    }

    pub fn run_warmup(&mut self) {
        self.pages.busy = Some("warmup");
        self.spawn(
            || api::post("/api/warmup", json!({})),
            |s, r, _| {
                s.pages.busy = None;
                match r {
                    Ok(_) => s.flash("✓ Warm-up ping sent", false),
                    Err(e) => s.flash(format!("✗ Warm-up: {e}"), true),
                }
                s.load_settings_extras();
            },
        );
    }

    pub fn checkout(&mut self, branch: String, strategy: &'static str) {
        self.pages.busy = Some("checkout");
        self.spawn(
            {
                let branch = branch.clone();
                move || {
                    api::post(
                        "/api/git",
                        json!({ "action": "checkout", "branch": branch, "strategy": strategy }),
                    )
                }
            },
            move |s, r, _| {
                s.pages.busy = None;
                match r {
                    Ok(v) => {
                        s.pages.checkout_dirty = None;
                        s.pages.branches_open = false;
                        let stash = v["stashRef"]
                            .as_str()
                            .map(|x| format!(" (stashed: {x})"))
                            .unwrap_or_default();
                        s.flash(format!("✓ On {branch}{stash}"), false);
                    }
                    Err(e) if e.contains("uncommitted") => s.pages.checkout_dirty = Some(branch),
                    Err(e) => s.flash(format!("✗ Checkout: {e}"), true),
                }
                s.load_settings_extras();
            },
        );
    }

    pub fn setting(&self, key: &str) -> &Value {
        self.pages
            .settings
            .as_ref()
            .map_or(&Value::Null, |v| &v[key])
    }

    pub fn feature(&self, flag: &str) -> bool {
        self.setting("featureFlags")[flag].as_bool().unwrap_or(false)
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
        self.spawn(
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

    pub fn save_wt_cleanup(&mut self, field: &str, value: Value) {
        let mut rules = self.setting("worktrees")["cleanup"].clone();
        if !rules.is_object() {
            rules = json!({});
        }
        rules[field] = value;
        self.save_nested("worktrees", "cleanup", rules);
    }

    pub fn save_wt_text(&mut self, field: &'static str) {
        let edit = match field {
            "location" => &self.pages.wt_location,
            _ => &self.pages.wt_names,
        };
        let text = edit.as_ref().map(|e| e.text.trim().to_string()).unwrap_or_default();
        self.save_nested("worktrees", field, json!(text));
        self.flash("✓ Saved", false);
    }

    pub fn cleanup_worktrees_now(&mut self) {
        self.pages.busy = Some("wt-cleanup");
        self.spawn(
            || api::post("/api/worktrees", json!({ "action": "cleanup" })),
            |s, r, _| {
                s.pages.busy = None;
                match r {
                    Ok(v) => {
                        let n = v["removed"].as_array().map_or(0, Vec::len);
                        s.flash(format!("✓ {n} worktree{} removed", if n == 1 { "" } else { "s" }), false);
                        s.pages.wt_cleanup = Some(v);
                    }
                    Err(e) => s.flash(format!("✗ Cleanup: {e}"), true),
                }
            },
        );
    }

    pub fn pull_checkouts_now(&mut self) {
        self.pages.busy = Some("wt-pull");
        self.spawn(
            || api::post("/api/worktrees", json!({ "action": "pull" })),
            |s, r, _| {
                s.pages.busy = None;
                match r {
                    Ok(v) => {
                        let n = v["checkouts"].as_array().map_or(0, |l| l.iter().filter(|c| c["result"] == "pulled").count());
                        s.flash(format!("✓ {n} checkout{} pulled", if n == 1 { "" } else { "s" }), false);
                        s.pages.wt_pull = Some(v);
                    }
                    Err(e) => s.flash(format!("✗ Pull: {e}"), true),
                }
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
        self.spawn(
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
        self.spawn(
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

#[cfg(test)]
mod gh_tests {
    use super::*;

    #[test]
    fn github_filter_scopes_and_matches() {
        let x = json!({ "repo": "acme/Infra.Charts", "title": "ARC stall alert" });
        assert!(gh_keep("", &x));
        assert!(gh_keep("acme/ stall", &x));
        assert!(gh_keep("charts", &x));
        assert!(!gh_keep("gitbluub/ stall", &x));
        assert!(!gh_keep("stall pprof", &x));
    }

    #[test]
    fn github_repo_tab_leads_while_a_repo_is_picked() {
        assert_eq!(gh_tabs(false).len(), GITHUB_TABS.len());
        assert_eq!(gh_tabs(true)[0], GITHUB_REPO_TAB);
        assert_eq!(gh_tabs(true)[1], GITHUB_TABS[0]);
        // A first pick jumps to the repo's pull requests; clearing keeps the same list selected.
        assert_eq!(gh_tab_after_pick(3, false, true), 0);
        assert_eq!(gh_tab_after_pick(3, true, false), 2);
        assert_eq!(gh_tab_after_pick(0, true, false), 0);
        assert_eq!(gh_tab_after_pick(2, true, true), 2);
    }
}

#[cfg(test)]
mod flow_tpl_tests {
    use super::*;

    fn feature() -> Value {
        json!({
            "id": "feature", "name": "Feature", "maxLoops": 3, "worktree": true,
            "stages": [
                { "key": "pilot", "name": "Pilot", "role": "r", "after": [], "model": "opus" },
                { "key": "build", "name": "Build", "role": "r", "after": ["pilot"], "writes": true },
                { "key": "decide", "name": "Decide", "role": "r", "after": ["build"], "decider": true, "loopTo": "build" },
            ]
        })
    }

    #[test]
    fn round_trips_a_template() {
        let out = TplForm::from(Some(&feature())).to_json();
        assert_eq!(out["stages"][1]["after"], json!(["pilot"]));
        assert_eq!(out["stages"][2]["loopTo"], json!("build"));
        assert_eq!(out["stages"][0]["model"], json!("opus"));
        assert_eq!(out["stages"][1]["model"], Value::Null);
        assert_eq!(out["id"], json!("feature"));
    }

    #[test]
    fn renaming_a_stage_keeps_its_links() {
        let mut f = TplForm::from(Some(&feature()));
        f.stages[1].key = TextEdit::new("implement");
        let out = f.to_json();
        assert_eq!(out["stages"][2]["after"], json!(["implement"]));
        assert_eq!(out["stages"][2]["loopTo"], json!("implement"));
    }
}
