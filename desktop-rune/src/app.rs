use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use rune::prefs::Prefs;
use rune::{AppHandle, TextEdit, Tx};

use crate::api::{self, Capabilities, Detail, Gauge, LiveSnapshot, Meta, Session};
use crate::fmt;

pub static HANDLE: OnceLock<AppHandle<Hooked>> = OnceLock::new();

pub fn spawn<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
    done: impl FnOnce(&mut Hooked, T, &mut Tx) + Send + 'static,
) {
    let Some(h) = HANDLE.get().cloned() else {
        return;
    };
    std::thread::spawn(move || {
        let r = work();
        h.update(move |s, tx| done(s, r, tx));
    });
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Page {
    Deck,
    Session,
    New,
    Stats,
    Digest,
    Memory,
    Cron,
    GitHub,
    Skills,
    Prompts,
    Settings,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Lens {
    Converse,
    Review,
    Mcp,
    Trace,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, serde::Serialize, serde::Deserialize)]
pub enum Theme {
    System,
    Light,
    Dark,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Popup {
    Sort,
    More,
    Model,
    Effort,
}

pub struct Attachment {
    pub id: u64,
    pub name: String,
    pub path: Option<String>,
    pub failed: bool,
}

pub struct SplitPane {
    pub id: String,
    pub detail: Option<Detail>,
    pub composer: TextEdit,
    pub sending: bool,
}

pub struct Flash {
    pub text: String,
    pub error: bool,
    pub until: i64,
}

pub struct Hooked {
    pub prefs: Prefs,
    pub sessions: Vec<Session>,
    pub meta: HashMap<String, Meta>,
    pub tags: HashMap<String, Vec<String>>,
    pub tag_filter: Vec<String>,
    pub incognito: bool,
    pub picker: Option<crate::organize::Picker>,
    pub gauges: Vec<Gauge>,
    pub caps: Capabilities,
    pub connected: bool,
    pub now: i64,

    pub page: Page,
    pub selected: Option<String>,
    pub lens: Lens,
    pub theme: Theme,
    pub notify: bool,

    pub sidebar_open: bool,
    pub sidebar_w: f32,
    pub window_h: f32,
    pub window_w: f32,
    pub show_archived: bool,
    pub hide_old: bool,
    pub group_by_project: bool,
    pub collapsed: HashSet<String>,
    pub pinned: Vec<String>,
    pub names: HashMap<String, String>,
    pub sort_mode: String,
    pub row_menu: Option<(String, rune::PointerPress)>,
    pub renaming: Option<(String, TextEdit)>,
    pub older_open: bool,
    pub folded_groups: HashSet<String>,
    pub tag_colors: HashMap<String, usize>,

    pub detail: Option<Detail>,
    pub detail_gen: Arc<AtomicU64>,
    pub detail_loading: bool,
    pub live: Option<LiveSnapshot>,
    pub working_since: Option<i64>,
    pub dock_open: bool,
    pub dock_cards: HashSet<&'static str>,
    pub dock_agent: Option<String>,
    pub gh_open: Option<String>,
    pub gh: HashMap<String, serde_json::Value>,
    pub images: Option<rune::ImageCache>,
    pub media: HashMap<String, Option<rune::Image>>,
    pub drafts: HashMap<String, String>,
    pub reviewed: HashMap<String, Vec<String>>,
    pub job_log: Option<(String, String)>,
    pub run_win: Option<crate::ghrun::RunWin>,
    pub gh_checks: HashMap<String, Vec<serde_json::Value>>,
    pub plan_quote: Option<String>,
    pub new_group: Option<String>,
    pub usage: Option<serde_json::Value>,
    pub shortcuts: HashMap<&'static str, rune_kit::ShortcutRecorderState>,
    pub deck_plans: HashMap<String, (String, Option<String>)>,
    pub plan_comments: Vec<(String, String)>,
    pub job_gen: Arc<AtomicU64>,
    pub full_texts: HashMap<String, Option<String>>,
    pub ac: Option<Autocomplete>,
    pub ac_req: u64,
    pub tools_open: HashSet<String>,
    pub all_tools_open: bool,
    pub visible: usize,

    pub composer: TextEdit,
    pub attachments: Vec<Attachment>,
    pub splits: Vec<SplitPane>,
    pub term: crate::terminal::TermPanel,
    pub attach_seq: u64,
    pub queued: Vec<String>,
    pub sending: bool,

    pub q_sel: Vec<BTreeSet<usize>>,
    pub q_other: TextEdit,
    pub plan_feedback: TextEdit,

    pub popup: Option<Popup>,
    pub flash: Option<Flash>,
    pub held_switch: Option<(Option<String>, Option<String>)>,

    pub new_project: TextEdit,
    pub new_prompt: TextEdit,
    pub new_model: Option<String>,
    pub new_effort: Option<String>,
    pub new_mode: String,
    pub new_custom: bool,
    pub new_search: TextEdit,
    pub new_worktree: bool,
    pub new_ephemeral: bool,
    pub collapse_worktrees: bool,

    pub palette_open: bool,
    pub palette_query: TextEdit,
    pub palette_index: usize,
    pub palette_cites: Vec<serde_json::Value>,
    pub palette_cites_for: String,
    pub palette_all_cites: bool,
    pub focus: bool,

    pub lens_data: crate::lenses::LensData,
    pub pages: crate::pages::PageData,
    pub announced: HashSet<String>,
    pub tray_dirty: bool,
}

pub const WINDOW: usize = 40;
const MAX_SPLITS: usize = 3;

pub fn compose_plan_feedback(comments: &[(String, String)]) -> String {
    let blocks: Vec<String> = comments
        .iter()
        .map(|(quote, comment)| {
            let q: Vec<String> = quote.lines().map(|l| format!("> {l}")).collect();
            format!("{}\n{comment}", q.join("\n"))
        })
        .collect();
    format!(
        "Feedback on the plan — please keep planning and revise:\n\n{}",
        blocks.join("\n\n")
    )
}

#[derive(Clone, Debug)]
pub struct AcItem {
    pub insert: String,
    pub label: String,
    pub sub: String,
    pub badge: String,
}

pub struct Autocomplete {
    pub start: usize,
    pub caret: usize,
    pub items: Vec<AcItem>,
    pub sel: usize,
}

fn ac_items(v: &serde_json::Value, files: bool) -> Vec<AcItem> {
    if files {
        v["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|f| f.as_str())
            .take(30)
            .map(|f| AcItem {
                insert: format!("@{f} "),
                label: f.rsplit('/').next().unwrap_or(f).to_string(),
                sub: f.to_string(),
                badge: String::new(),
            })
            .collect()
    } else {
        v["commands"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| {
                let name = c["name"].as_str().unwrap_or("");
                AcItem {
                    insert: format!("/{name} "),
                    label: format!("/{name}"),
                    sub: c["description"].as_str().unwrap_or("").to_string(),
                    badge: if c["group"] == "custom" {
                        c["source"].as_str().unwrap_or("custom").to_string()
                    } else {
                        "built-in".to_string()
                    },
                }
            })
            .collect()
    }
}

enum AcQuery {
    Command(String),
    File(String, usize),
}

fn ac_query(before: &str) -> Option<AcQuery> {
    if let Some(q) = before.strip_prefix('/')
        && q.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-'))
    {
        return Some(AcQuery::Command(q.to_string()));
    }
    let at = before.rfind('@')?;
    let q = &before[at + 1..];
    let boundary = before[..at]
        .chars()
        .next_back()
        .is_none_or(char::is_whitespace);
    (boundary && !q.chars().any(char::is_whitespace)).then(|| AcQuery::File(q.to_string(), at))
}
const STEP: usize = 120;

impl Hooked {
    pub fn new() -> Hooked {
        let prefs = Prefs::open("dev.qjoly.hooked-rune");
        let pinned: Vec<String> = prefs.get("pinned").unwrap_or_default();
        let names: HashMap<String, String> = prefs.get("names").unwrap_or_default();
        let sort_mode: String = prefs
            .get("sortMode")
            .unwrap_or_else(|| "dynamic".to_string());
        let folded_groups: HashSet<String> = prefs.get("foldedGroups").unwrap_or_default();
        let tag_colors: HashMap<String, usize> = prefs.get("tagColors").unwrap_or_default();
        let drafts: HashMap<String, String> = prefs.get("drafts").unwrap_or_default();
        let reviewed: HashMap<String, Vec<String>> = prefs.get("reviewed").unwrap_or_default();
        let saved_keys: HashMap<String, String> = prefs.get("shortcuts").unwrap_or_default();
        let shortcuts = crate::shortcuts::load(&saved_keys);
        let collapse_worktrees: bool = prefs.get("collapseWorktrees").unwrap_or(true);
        let theme = prefs.get("theme").unwrap_or(Theme::System);
        let notify = prefs.get("notify").unwrap_or(true);
        let incognito = prefs.get("incognito").unwrap_or(false);
        let sidebar_open = prefs.get("sidebarOpen").unwrap_or(true);
        let hide_old = prefs.get("hideOld").unwrap_or(false);
        let group_by_project = prefs.get("groupByProject").unwrap_or(true);
        let dock_open = prefs.get("dockOpen").unwrap_or(true);
        let prefs_w = prefs.get("sidebarW").unwrap_or(crate::view::SIDEBAR_W);
        let mut s = Hooked {
            prefs,
            sessions: Vec::new(),
            meta: HashMap::new(),
            tags: HashMap::new(),
            tag_filter: Vec::new(),
            tag_colors,
            incognito,
            picker: None,
            gauges: Vec::new(),
            caps: Capabilities::default(),
            connected: false,
            now: fmt::now_ms(),
            page: Page::Deck,
            selected: None,
            lens: Lens::Converse,
            theme,
            notify,
            sidebar_open,
            sidebar_w: prefs_w,
            window_h: 860.0,
            window_w: 1320.0,
            show_archived: false,
            hide_old,
            group_by_project,
            collapsed: HashSet::new(),
            pinned,
            names,
            sort_mode,
            row_menu: None,
            renaming: None,
            older_open: false,
            folded_groups,
            detail: None,
            detail_gen: Arc::new(AtomicU64::new(0)),
            detail_loading: false,
            live: None,
            working_since: None,
            dock_open,
            dock_cards: HashSet::new(),
            dock_agent: None,
            gh_open: None,
            gh: HashMap::new(),
            images: None,
            media: HashMap::new(),
            drafts,
            reviewed,
            job_log: None,
            run_win: None,
            gh_checks: HashMap::new(),
            plan_quote: None,
            new_group: None,
            usage: None,
            shortcuts,
            deck_plans: HashMap::new(),
            plan_comments: Vec::new(),
            job_gen: Arc::new(AtomicU64::new(0)),
            full_texts: HashMap::new(),
            ac: None,
            ac_req: 0,
            tools_open: HashSet::new(),
            all_tools_open: false,
            visible: WINDOW,
            composer: TextEdit::new(""),
            attachments: Vec::new(),
            splits: Vec::new(),
            term: crate::terminal::TermPanel::default(),
            attach_seq: 0,
            queued: Vec::new(),
            sending: false,
            q_sel: Vec::new(),
            q_other: TextEdit::new(""),
            plan_feedback: TextEdit::new(""),
            popup: None,
            flash: None,
            held_switch: None,
            new_project: TextEdit::new(""),
            new_prompt: TextEdit::new(""),
            new_model: None,
            new_effort: None,
            new_mode: "default".into(),
            new_custom: false,
            new_search: TextEdit::new(""),
            new_worktree: false,
            new_ephemeral: false,
            collapse_worktrees,
            palette_open: false,
            palette_query: TextEdit::new(""),
            palette_index: 0,
            palette_cites: Vec::new(),
            palette_cites_for: String::new(),
            palette_all_cites: false,
            focus: false,
            lens_data: crate::lenses::LensData::default(),
            pages: crate::pages::PageData::default(),
            announced: HashSet::new(),
            tray_dirty: true,
        };
        // A synchronous first read: headless snapshots and the first frame show real data.
        if let Ok(list) = api::sessions() {
            s.connected = true;
            s.sessions = list;
        }
        s.meta = api::session_meta().unwrap_or_default();
        s.tags = api::tags().unwrap_or_default();
        if s.prefs.get::<bool>("diffSplit").unwrap_or(false) {
            s.lens_data.diff.set_mode(rune_kit::diff::DiffMode::Split);
        }
        if let Ok(v) = api::get("/api/settings") {
            s.apply_settings(v);
            s.page = match s.setting("defaultPage").as_str().unwrap_or("deck") {
                "stats" => Page::Stats,
                "digest" => Page::Digest,
                "memory" => Page::Memory,
                "github" => Page::GitHub,
                "skills" => Page::Skills,
                "cron" => Page::Cron,
                "prompts" => Page::Prompts,
                _ => Page::Deck,
            };
            s.new_mode = s
                .setting("defaultMode")
                .as_str()
                .filter(|m| !m.is_empty())
                .unwrap_or("default")
                .to_string();
            s.new_effort = s
                .setting("defaultEffort")
                .as_str()
                .filter(|m| !m.is_empty())
                .map(str::to_string);
            s.new_model = s
                .setting("defaultModel")
                .as_str()
                .filter(|m| !m.is_empty())
                .map(str::to_string);
        }
        if let Ok((g, raw)) = api::usage() {
            s.gauges = g;
            s.usage = Some(raw);
        }
        s.announced = s
            .sessions
            .iter()
            .filter(|x| x.needs_you())
            .map(|x| x.id.clone())
            .collect();
        let args = rune::extra_args();
        s.term.height = s.prefs.get("termHeight");
        if let Some(i) = args.iter().position(|a| a == "--session")
            && let Some(id) = args.get(i + 1)
        {
            s.selected = Some(id.clone());
            s.page = Page::Session;
            s.detail = api::detail(id).ok();
            s.reset_question();
        }
        if let Some(i) = args.iter().position(|a| a == "--lens") {
            s.lens = match args.get(i + 1).map(String::as_str) {
                Some("review") => Lens::Review,
                Some("mcp") => Lens::Mcp,
                Some("trace") => Lens::Trace,
                _ => Lens::Converse,
            };
        }
        if let Some(d) = s.detail.as_ref() {
            let (id, cwd) = (
                d.session.id.clone(),
                d.session.project.clone().unwrap_or_default(),
            );
            match s.lens {
                Lens::Mcp => {
                    s.lens_data.mcp_cwd = Some(cwd.clone());
                    s.lens_data.mcp = api::mcp_list(&cwd, true).unwrap_or_default();
                }
                Lens::Review => {
                    s.ensure_lens();
                    s.lens_data.threads = api::get(&format!("/api/review?id={id}"))
                        .ok()
                        .and_then(|v| v["threads"].as_array().cloned())
                        .unwrap_or_default();
                    s.annotate();
                }
                Lens::Trace => {
                    s.lens_data.trace = api::trace(&id).unwrap_or_default();
                    s.lens_data.trace_sig = Some(format!(
                        "{id}|{}",
                        d.session.last_activity.clone().unwrap_or_default()
                    ));
                }
                _ => {}
            }
        }
        if let (Some(i), Some(id)) = (
            args.iter().position(|a| a == "--picker"),
            s.selected.clone(),
        ) {
            match args.get(i + 1).map(String::as_str) {
                Some("tags") => s.open_tags(id),
                Some("group") => s.open_group_picker(id),
                _ => {}
            }
        }
        if args.iter().any(|a| a == "--row-menu")
            && let Some(id) = s.selected.clone()
        {
            s.row_menu = Some((id, rune::PointerPress { x: 220.0, y: 260.0 }));
        }
        if args.iter().any(|a| a == "--sort-menu") {
            s.popup = Some(Popup::Sort);
        }
        if args.iter().any(|a| a == "--term") {
            s.preload_terms();
            if args.iter().any(|a| a == "--term-sel") {
                s.term.sel = Some(crate::terminal::Sel {
                    anchor: (2, 1),
                    head: (12, 2),
                });
            }
        }
        if let Some(i) = args.iter().position(|a| a == "--split")
            && s.detail.is_some()
        {
            let n: usize = args.get(i + 1).and_then(|v| v.parse().ok()).unwrap_or(1);
            for _ in 0..n {
                s.split_with_recent();
            }
            for p in &mut s.splits {
                p.detail = api::detail(&p.id).ok();
            }
        }
        if args.iter().any(|a| a == "--new") {
            s.go_new(None);
        }
        if let Some(i) = args.iter().position(|a| a == "--page") {
            s.page = match args.get(i + 1).map(String::as_str) {
                Some("stats") => Page::Stats,
                Some("digest") => Page::Digest,
                Some("memory") => Page::Memory,
                Some("cron") => Page::Cron,
                Some("github") => Page::GitHub,
                Some("skills") => Page::Skills,
                Some("settings") => Page::Settings,
                Some("prompts") => Page::Prompts,
                _ => s.page,
            };
            s.preload_page();
        }
        if let Some(i) = args.iter().position(|a| a == "--palette") {
            let q = args.get(i + 1).cloned().unwrap_or_default();
            s.open_palette(&q);
            if !q.is_empty() && !q.starts_with('>') {
                s.palette_cites = api::get(&format!("/api/search?q={}&limit=50", api::enc(&q)))
                    .ok()
                    .and_then(|v| v["results"].as_array().cloned())
                    .unwrap_or_default();
                s.palette_cites_for = q;
            }
        }
        if let Some(i) = args.iter().position(|a| a == "--composer") {
            let t = args.get(i + 1).cloned().unwrap_or_default();
            s.composer = TextEdit::new(t.clone());
            s.composer.set_caret(t.len());
            if let (Some(q), Some(id)) = (ac_query(&t), s.selected.clone()) {
                let (path, start, files) = match q {
                    AcQuery::Command(q) => (
                        format!("/api/commands?id={}&q={}", api::enc(&id), api::enc(&q)),
                        0,
                        false,
                    ),
                    AcQuery::File(q, at) => (
                        format!("/api/files?id={}&q={}", api::enc(&id), api::enc(&q)),
                        at,
                        true,
                    ),
                };
                let items = ac_items(&api::get(&path).unwrap_or_default(), files);
                s.ac = Some(Autocomplete {
                    start,
                    caret: t.len(),
                    items,
                    sel: 0,
                });
            }
        }
        if let Some(i) = args.iter().position(|a| a == "--turns") {
            s.lens_data.turns_open = true;
            s.lens_data.turns = args
                .get(i + 1)
                .map(|v| v.split(',').filter_map(|n| n.parse().ok()).collect())
                .unwrap_or_default();
        }
        if let Some(i) = args.iter().position(|a| a == "--agent") {
            let agent = args.get(i + 1).cloned().unwrap_or_default();
            let session = s.selected.clone().unwrap_or_default();
            let messages = crate::organize::agent_messages(
                api::get(&format!(
                    "/api/agent?session={}&agent={}",
                    api::enc(&session),
                    api::enc(&agent)
                ))
                .ok(),
            );
            s.picker = Some(crate::organize::Picker::Agent {
                title: "Agent transcript".into(),
                messages: Some(messages),
            });
        }
        if let Some(i) = args.iter().position(|a| a == "--image") {
            let n: usize = args.get(i + 1).and_then(|v| v.parse().ok()).unwrap_or(0);
            let paths: Vec<String> = s
                .detail
                .as_ref()
                .map(|d| {
                    d.screenshots
                        .iter()
                        .filter_map(|x| x["path"].as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            s.picker = Some(crate::organize::Picker::Image { paths, index: n });
        }
        if let Some(i) = args.iter().position(|a| a == "--run") {
            let url = args.get(i + 1).cloned().unwrap_or_default();
            let run = api::get(&format!("/api/github/run?url={}", api::enc(&url))).ok();
            let mut w = crate::ghrun::RunWin {
                job: crate::ghrun::parse_run_url(&url).filter(|j| !j.is_empty()),
                url,
                run,
                err: None,
                log: None,
                loading: false,
                polled: fmt::now_ms(),
            };
            if let Some(j) = w.job().cloned() {
                let log = api::get(&format!(
                    "/api/github/run/log?url={}",
                    api::enc(j["url"].as_str().unwrap_or(""))
                ))
                .map(|v| v["log"].as_str().map(str::to_string));
                w.log = Some((j["id"].as_str().unwrap_or("").to_string(), log));
            }
            s.run_win = Some(w);
        }
        if args.iter().any(|a| a == "--account") {
            s.picker = Some(crate::organize::Picker::Account(Box::new(
                crate::account::AccountWin {
                    info: api::get("/api/account").ok(),
                    ..Default::default()
                },
            )));
        }
        if args.iter().any(|a| a == "--cost") {
            s.picker = Some(crate::organize::Picker::Cost);
        }
        if args.iter().any(|a| a == "--side-by-side") {
            s.lens_data.diff.set_mode(rune_kit::diff::DiffMode::Split);
        }
        if args.iter().any(|a| a == "--rendered") {
            s.lens_data.rendered = true;
        }
        if args.iter().any(|a| a == "--threads") {
            s.lens_data.threads_open = true;
        }
        if args.iter().any(|a| a == "--expand-tools") {
            s.all_tools_open = true;
        }
        if args.iter().any(|a| a == "--trash") {
            let items = api::get("/api/trash")
                .ok()
                .and_then(|v| v["trashed"].as_array().cloned());
            s.picker = Some(crate::organize::Picker::Trash { items, busy: None });
        }
        if let Some(i) = args.iter().position(|a| a == "--tag-hues") {
            s.pages.tag_hue_open = args.get(i + 1).cloned();
        }
        s
    }

    pub fn tag_color(&self, dark: bool, name: &str) -> rune::Color {
        let i = self
            .tag_colors
            .get(name)
            .copied()
            .unwrap_or_else(|| crate::theme::tag_index(name));
        crate::theme::tag_hue(dark, i)
    }

    pub fn set_tag_color(&mut self, name: &str, hue: Option<usize>) {
        match hue {
            Some(i) => self.tag_colors.insert(name.to_string(), i),
            None => self.tag_colors.remove(name),
        };
        let map = self.tag_colors.clone();
        self.save_pref("tagColors", &map);
    }

    pub fn save_pref<T: serde::Serialize>(&mut self, key: &str, v: &T) {
        let _ = self.prefs.set(key, v);
    }

    pub fn dark(&self, system_dark: bool) -> bool {
        match self.theme {
            Theme::System => system_dark,
            Theme::Light => false,
            Theme::Dark => true,
        }
    }

    pub fn set_theme(&mut self, theme: Theme) {
        self.theme = theme;
        self.save_pref("theme", &theme);
    }

    pub fn open_palette(&mut self, prefix: &str) {
        self.palette_open = true;
        self.palette_query = TextEdit::new(prefix);
        self.palette_query.focused = true;
        self.palette_index = 0;
        self.palette_cites.clear();
        self.palette_cites_for.clear();
        self.palette_all_cites = false;
    }

    pub fn palette_changed(&mut self) {
        self.palette_index = 0;
        self.palette_all_cites = false;
        let q = self.palette_query.text.trim().to_string();
        if q.is_empty() || q.starts_with('>') {
            return;
        }
        spawn(
            {
                let q = q.clone();
                move || {
                    std::thread::sleep(Duration::from_millis(250));
                    api::get(&format!("/api/search?q={}&limit=50", api::enc(&q)))
                }
            },
            move |s, r, _| {
                if s.palette_query.text.trim() != q {
                    return;
                }
                s.palette_cites = r
                    .ok()
                    .and_then(|v| v["results"].as_array().cloned())
                    .unwrap_or_default();
                s.palette_cites_for = q;
            },
        );
    }

    pub fn open_sessions(&mut self) {
        if let Some(id) = self
            .selected
            .clone()
            .or_else(|| self.sessions.first().map(|x| x.id.clone()))
        {
            self.open_session(&id);
        }
    }

    pub fn toggle_sidebar(&mut self) {
        self.sidebar_open = !self.sidebar_open;
        let v = self.sidebar_open;
        self.save_pref("sidebarOpen", &v);
    }

    pub fn toggle_dock(&mut self) {
        self.dock_open = !self.dock_open;
        let v = self.dock_open;
        self.save_pref("dockOpen", &v);
    }

    pub fn toggle_split(&mut self) {
        if !self.splits.is_empty() {
            self.splits.clear();
        } else if self.page == Page::Session {
            self.split_with_recent();
        }
    }

    pub fn load_full_text(&mut self, session: String, uuid: String) {
        if self.full_texts.contains_key(&uuid) {
            return;
        }
        self.full_texts.insert(uuid.clone(), None);
        spawn(
            {
                let uuid = uuid.clone();
                move || {
                    api::get(&format!(
                        "/api/session/message?id={}&uuid={}",
                        api::enc(&session),
                        api::enc(&uuid)
                    ))
                }
            },
            move |s, r, _| match r.ok().and_then(|v| v["text"].as_str().map(str::to_string)) {
                Some(t) => {
                    s.full_texts.insert(uuid, Some(t));
                }
                None => {
                    s.full_texts.remove(&uuid);
                    s.flash("✗ Could not load the full message", true);
                }
            },
        );
    }

    pub fn composer_changed(&mut self) {
        let (caret, end) = self.composer.range();
        let query = (caret == end)
            .then(|| ac_query(&self.composer.text[..caret]))
            .flatten();
        let (Some(query), Some(id)) = (query, self.selected.clone()) else {
            self.ac = None;
            return;
        };
        self.ac_req += 1;
        let req = self.ac_req;
        let (path, start) = match &query {
            AcQuery::Command(q) => (
                format!("/api/commands?id={}&q={}", api::enc(&id), api::enc(q)),
                0,
            ),
            AcQuery::File(q, at) => (
                format!("/api/files?id={}&q={}", api::enc(&id), api::enc(q)),
                *at,
            ),
        };
        let files = matches!(query, AcQuery::File(..));
        spawn(
            move || api::get(&path),
            move |s, r, _| {
                if s.ac_req != req || s.composer.range() != (caret, caret) {
                    return;
                }
                let items = ac_items(&r.unwrap_or_default(), files);
                s.ac = (!items.is_empty()).then_some(Autocomplete {
                    start,
                    caret,
                    items,
                    sel: 0,
                });
            },
        );
    }

    pub fn ac_move(&mut self, delta: isize) {
        if let Some(ac) = self.ac.as_mut() {
            let n = ac.items.len() as isize;
            ac.sel = ((ac.sel as isize + delta).rem_euclid(n)) as usize;
        }
    }

    pub fn ac_accept(&mut self, index: Option<usize>) {
        let Some(ac) = self.ac.take() else {
            return;
        };
        let Some(item) = ac.items.get(index.unwrap_or(ac.sel)) else {
            return;
        };
        let t = &self.composer.text;
        if ac.caret > t.len() || ac.start > ac.caret {
            return;
        }
        let text = format!("{}{}{}", &t[..ac.start], item.insert, &t[ac.caret..]);
        let caret = ac.start + item.insert.len();
        self.composer.replace_text(text);
        self.composer.set_caret(caret);
        self.composer.focused = true;
    }

    /// Streams a background job's output file, keeping the last 64 KB.
    pub fn toggle_job_log(&mut self, task: String) {
        let generation = self.job_gen.fetch_add(1, Ordering::SeqCst) + 1;
        if self.job_log.as_ref().is_some_and(|(t, _)| *t == task) {
            self.job_log = None;
            return;
        }
        let (Some(id), Some(h)) = (self.selected.clone(), HANDLE.get().cloned()) else {
            return;
        };
        self.job_log = Some((task.clone(), String::new()));
        let gen_ref = self.job_gen.clone();
        std::thread::spawn(move || {
            use base64::Engine;
            let path = format!(
                "/api/background/stream?id={}&taskId={}",
                api::enc(&id),
                api::enc(&task)
            );
            let _ = api::follow(&path, |d| {
                if gen_ref.load(Ordering::SeqCst) != generation {
                    return false;
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(d)
                    .unwrap_or_default();
                if bytes.is_empty() {
                    return true;
                }
                let chunk = fmt::strip_ansi(&String::from_utf8_lossy(&bytes));
                let task = task.clone();
                h.update(move |s, _| {
                    if let Some((t, text)) = s.job_log.as_mut()
                        && *t == task
                    {
                        text.push_str(&chunk);
                        if text.len() > 65_536 {
                            let mut cut = text.len() - 65_536;
                            while !text.is_char_boundary(cut) {
                                cut += 1;
                            }
                            text.drain(..cut);
                        }
                    }
                });
                true
            });
        });
    }

    pub fn run_code(&mut self, session: String, code: String) {
        let cmd = format!("!{}", code.trim());
        spawn(
            move || api::reply(&session, &cmd),
            |s, r, _| {
                match r {
                    Ok(_) => s.flash("✓ Running in the session", false),
                    Err(e) => s.flash(format!("✗ Run: {e}"), true),
                }
                s.refresh_detail();
            },
        );
    }

    pub fn open_ghostty(&mut self) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        self.act("Opened in Ghostty", move || {
            api::post("/api/open-ghostty", serde_json::json!({ "id": id })).map(|_| ())
        });
    }

    pub fn cycle_theme(&mut self) {
        self.theme = match self.theme {
            Theme::System => Theme::Light,
            Theme::Light => Theme::Dark,
            Theme::Dark => Theme::System,
        };
        let t = self.theme;
        self.save_pref("theme", &t);
    }

    pub fn flash(&mut self, text: impl Into<String>, error: bool) {
        self.flash = Some(Flash {
            text: text.into(),
            error,
            until: fmt::now_ms() + 4000,
        });
    }

    pub fn session(&self, id: &str) -> Option<&Session> {
        self.sessions.iter().find(|s| s.id == id)
    }

    pub fn snoozed(&self, id: &str) -> bool {
        self.meta
            .get(id)
            .and_then(|m| m.snooze_until)
            .is_some_and(|t| t as i64 > self.now)
    }

    pub fn snooze(&mut self, ids: Vec<String>, hours: f64) {
        let until = fmt::now_ms() as f64 + hours * 3_600_000.0;
        for id in &ids {
            self.meta.entry(id.clone()).or_default().snooze_until = Some(until);
        }
        self.now = fmt::now_ms();
        spawn(
            move || {
                ids.iter().try_for_each(|id| {
                    api::patch_meta(id, serde_json::json!({ "snoozeUntil": until }))
                })
            },
            |s, r, _| match r {
                Ok(()) => s.flash("✓ Snoozed for an hour", false),
                Err(e) => s.flash(format!("✗ Snooze: {e}"), true),
            },
        );
    }

    pub fn send_followup(&mut self, id: String, text: String) {
        spawn(
            move || api::reply(&id, &text),
            |s, r, _| {
                match r {
                    Ok(_) => s.flash("✓ Follow-up sent", false),
                    Err(e) => s.flash(format!("✗ Follow-up: {e}"), true),
                }
                refresh_sessions();
            },
        );
    }

    pub fn deck_answer(&mut self, id: String, index: usize) {
        spawn(
            move || {
                api::answer(
                    &id,
                    &[api::Selection {
                        multi: false,
                        indices: vec![index],
                        other: None,
                    }],
                    None,
                )
            },
            |s, r, _| {
                match r {
                    Ok(()) => s.flash("✓ Answered", false),
                    Err(e) => s.flash(format!("✗ Answer: {e}"), true),
                }
                refresh_sessions();
            },
        );
    }

    pub fn is_archived(&self, s: &Session) -> bool {
        self.meta.get(&s.id).is_some_and(|m| m.archived)
            || fmt::finished_and_cold(
                &s.state,
                s.last_seen_ts.as_deref().or(s.last_activity.as_deref()),
                self.now,
            )
    }

    pub fn waiting(&self) -> Vec<&Session> {
        self.sessions
            .iter()
            .filter(|s| s.needs_you() && !self.is_archived(s))
            .collect()
    }

    pub fn stash_draft(&mut self) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        let text = self.composer.text.trim_end().to_string();
        let changed = if text.is_empty() {
            self.drafts.remove(&id).is_some()
        } else {
            self.drafts.insert(id, text.clone()).as_ref() != Some(&text)
        };
        if changed {
            let drafts = self.drafts.clone();
            self.save_pref("drafts", &drafts);
        }
    }

    pub fn open_session(&mut self, id: &str) {
        self.page = Page::Session;
        self.palette_open = false;
        self.popup = None;
        if self.selected.as_deref() == Some(id) && self.detail.is_some() {
            return;
        }
        self.stash_draft();
        self.selected = Some(id.to_string());
        self.detail = None;
        self.live = None;
        self.working_since = None;
        self.visible = WINDOW;
        self.queued.clear();
        self.attachments.clear();
        self.tools_open.clear();
        let source = self.lens_data.review_source;
        let mode = self.lens_data.diff.mode();
        self.lens_data = crate::lenses::LensData {
            review_source: source,
            ..Default::default()
        };
        self.lens_data.diff.set_mode(mode);
        self.ac = None;
        self.job_gen.fetch_add(1, Ordering::SeqCst);
        self.job_log = None;
        self.composer = TextEdit::new(self.drafts.get(id).cloned().unwrap_or_default());
        self.composer.focused = true;
        self.reset_question();
        self.load_detail();
        self.load_terms();
    }

    /// Opens the most recently active session not already on screen beside the others.
    pub fn split_with_recent(&mut self) {
        let shown: Vec<&str> = self
            .selected
            .iter()
            .map(String::as_str)
            .chain(self.splits.iter().map(|p| p.id.as_str()))
            .collect();
        let mut others: Vec<&Session> = self
            .sessions
            .iter()
            .filter(|x| !shown.contains(&x.id.as_str()) && !self.is_archived(x))
            .collect();
        others.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
        if let Some(id) = others.first().map(|x| x.id.clone()) {
            self.open_split(id);
        }
    }

    /// Up to three panes beside the main one; a fourth replaces the last.
    pub fn open_split(&mut self, id: String) {
        if self.splits.iter().any(|p| p.id == id) || self.selected.as_deref() == Some(id.as_str()) {
            return;
        }
        if self.splits.len() >= MAX_SPLITS {
            self.splits.pop();
        }
        self.splits.push(SplitPane {
            id: id.clone(),
            detail: None,
            composer: TextEdit::new(""),
            sending: false,
        });
        self.refresh_split(&id);
    }

    pub fn close_split(&mut self, id: &str) {
        self.splits.retain(|p| p.id != id);
    }

    pub fn refresh_split(&mut self, id: &str) {
        let id = id.to_string();
        spawn(
            {
                let id = id.clone();
                move || api::detail(&id)
            },
            move |s, r, _| {
                if let Ok(d) = r
                    && s.splits.iter().any(|p| p.id == id)
                {
                    s.want_media(&d, false);
                    if let Some(p) = s.splits.iter_mut().find(|p| p.id == id) {
                        p.detail = Some(d);
                    }
                }
            },
        );
    }

    pub fn swap_split(&mut self, id: &str) {
        let (Some(i), Some(cur)) = (
            self.splits.iter().position(|p| p.id == id),
            self.selected.clone(),
        ) else {
            return;
        };
        let p = self.splits.remove(i);
        self.open_session(&p.id);
        self.open_split(cur);
    }

    pub fn send_split(&mut self, id: &str) {
        let Some(p) = self.splits.iter_mut().find(|p| p.id == id) else {
            return;
        };
        let text = p.composer.text.trim().to_string();
        let Some(d) = p.detail.as_ref() else { return };
        if text.is_empty() || p.sending {
            return;
        }
        let (sid, live, effort) = (
            d.session.id.clone(),
            d.session.live,
            d.session.effort.clone(),
        );
        p.sending = true;
        p.composer = TextEdit::new("");
        spawn(
            move || {
                if live {
                    api::reply(&sid, &text)
                } else {
                    api::resume(&sid, &text, effort.as_deref())
                }
            },
            {
                let id = id.to_string();
                move |s, r, _| {
                    if let Some(p) = s.splits.iter_mut().find(|p| p.id == id) {
                        p.sending = false;
                    }
                    if let Err(e) = r {
                        s.flash(format!("✗ Send failed: {e}"), true);
                    }
                    s.refresh_split(&id);
                }
            },
        );
    }

    pub fn go_deck(&mut self) {
        self.page = Page::Deck;
        self.popup = None;
    }

    pub fn go_new_in_group(&mut self, mother: String) {
        let project = self.session(&mother).and_then(|x| x.project.clone());
        self.go_new(project);
        self.new_group = Some(mother);
    }

    /// The Fable bucket when it is spent: `pct` is the authority, `severity` the fallback.
    pub fn fable_spent(&self) -> Option<&serde_json::Value> {
        let f = &self.usage.as_ref()?["account"]["fable"];
        let spent = match f["pct"].as_f64() {
            Some(p) => p >= 100.0,
            None => f["severity"]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case("exhausted")),
        };
        spent.then_some(f)
    }

    pub fn new_fallback(&self) -> bool {
        let wanted = self.setting("defaultModel").as_str().unwrap_or("");
        let fable = wanted.starts_with("fable") || wanted.starts_with("claude-fable");
        fable && self.fable_spent().is_some()
    }

    pub fn go_new(&mut self, project: Option<String>) {
        self.page = Page::New;
        self.popup = None;
        self.new_group = None;
        if self.new_fallback() {
            self.new_model = Some("opus".into());
        }
        let fallback = self
            .setting("quickLaunchProject")
            .as_str()
            .filter(|p| !p.is_empty())
            .map(str::to_string);
        if let Some(p) = project
            .or(fallback)
            .or_else(|| self.detail.as_ref().and_then(|d| d.session.project.clone()))
        {
            self.new_project = TextEdit::new(p);
        }
        self.new_custom = false;
        self.new_search = TextEdit::new("");
        self.new_prompt = TextEdit::new("");
        self.new_prompt.focused = true;
    }

    pub fn show_earlier(&mut self) {
        self.visible += STEP;
    }

    pub fn reset_question(&mut self) {
        let n = self
            .detail
            .as_ref()
            .and_then(|d| d.pending_question.as_ref())
            .map_or(0, |q| q.questions.len());
        self.q_sel = vec![BTreeSet::new(); n];
        self.q_other = TextEdit::new("");
        self.plan_feedback = TextEdit::new("");
    }

    pub fn load_detail(&mut self) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        let generation = self.detail_gen.fetch_add(1, Ordering::SeqCst) + 1;
        self.detail_loading = true;
        let gen_ref = self.detail_gen.clone();
        spawn(
            {
                let id = id.clone();
                move || api::detail(&id)
            },
            move |s, r, _| {
                if gen_ref.load(Ordering::SeqCst) != generation {
                    return;
                }
                s.detail_loading = false;
                match r {
                    Ok(d) => s.apply_detail(d, generation),
                    Err(e) => s.flash(format!("Could not load the session: {e}"), true),
                }
            },
        );
    }

    /// Refetches the open session without bumping the stream generation.
    pub fn refresh_detail(&mut self) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        let generation = self.detail_gen.load(Ordering::SeqCst);
        let gen_ref = self.detail_gen.clone();
        spawn(
            move || api::detail(&id),
            move |s, r, _| {
                if gen_ref.load(Ordering::SeqCst) != generation {
                    return;
                }
                if let Ok(d) = r {
                    s.apply_detail(d, generation);
                }
            },
        );
    }

    fn apply_detail(&mut self, d: Detail, generation: u64) {
        let had_question = self
            .detail
            .as_ref()
            .and_then(|x| x.pending_question.as_ref())
            .map(|q| q.id.clone());
        let now_question = d.pending_question.as_ref().map(|q| q.id.clone());
        if !self.queued.is_empty() {
            let norm = |t: &str| t.split_whitespace().collect::<Vec<_>>().join(" ");
            let seen: HashSet<String> = d
                .messages
                .iter()
                .filter(|m| m.role == "user")
                .map(|m| norm(&m.text))
                .collect();
            self.queued.retain(|q| !seen.contains(&norm(q)));
        }
        let start_stream = d.session.live
            && self
                .detail
                .as_ref()
                .is_none_or(|x| !x.session.live || x.session.id != d.session.id);
        if d.session.state == "working" {
            self.working_since.get_or_insert(fmt::now_ms());
        } else {
            self.working_since = None;
        }
        self.want_media(&d, false);
        self.detail = Some(d);
        if had_question != now_question {
            self.reset_question();
        }
        if start_stream {
            self.follow_session(generation);
        }
    }

    pub fn want_media(&mut self, d: &Detail, now: bool) {
        let Some(cache) = self.images.as_ref() else {
            return;
        };
        let media = &mut self.media;
        for (path, url) in api::media_refs(d) {
            if media.contains_key(&path) {
                continue;
            }
            media.insert(path.clone(), None);
            if now {
                if let Ok(bytes) = api::bytes(&url) {
                    let img = cache.load(bytes);
                    let _ = img.wait();
                    media.insert(path, Some(img));
                }
                continue;
            }
            spawn(
                move || api::bytes(&url),
                move |s, r, _| {
                    if let (Ok(bytes), Some(cache)) = (r, s.images.as_ref()) {
                        let img = cache.load(bytes);
                        s.media.insert(path, Some(img));
                    }
                },
            );
        }
    }

    fn follow_session(&mut self, generation: u64) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        let Some(h) = HANDLE.get().cloned() else {
            return;
        };
        let gen_ref = self.detail_gen.clone();
        std::thread::spawn(move || {
            let alive = || gen_ref.load(Ordering::SeqCst) == generation;
            while alive() {
                let path = api::session_stream_path(&id);
                let _ = api::follow(&path, |payload| {
                    if !alive() {
                        return false;
                    }
                    let snap: LiveSnapshot = serde_json::from_str(payload).unwrap_or_default();
                    let ended = snap.ended || snap.live == Some(false);
                    let gen_ref = gen_ref.clone();
                    h.update(move |s, _| {
                        if gen_ref.load(Ordering::SeqCst) != generation {
                            return;
                        }
                        let prev = s.live.take();
                        let finished = prev.as_ref().is_some_and(|p| p.busy) && !snap.busy;
                        let needs = snap.state.as_deref() == Some("requires_action")
                            && prev.as_ref().and_then(|p| p.state.as_deref())
                                != Some("requires_action");
                        if snap.busy {
                            s.working_since.get_or_insert(fmt::now_ms());
                        }
                        s.live = if ended { None } else { Some(snap) };
                        if finished || needs || ended {
                            s.refresh_detail();
                        }
                    });
                    !ended
                });
                if !alive() {
                    return;
                }
                std::thread::sleep(Duration::from_secs(2));
            }
        });
    }

    /// The Deck shows a plan in place; the list only says there is one, so fetch it once per change.
    fn want_deck_plans(&mut self, list: &[Session]) {
        for x in list.iter().filter(|x| x.has_plan) {
            let ts = x.last_activity.clone().unwrap_or_default();
            if self.deck_plans.get(&x.id).is_some_and(|(t, _)| *t == ts) {
                continue;
            }
            self.deck_plans.insert(x.id.clone(), (ts.clone(), None));
            let id = x.id.clone();
            spawn(
                {
                    let id = id.clone();
                    move || api::detail(&id)
                },
                move |s, r, _| {
                    let plan = r.ok().and_then(|d| d.pending_plan.map(|p| p.plan));
                    s.deck_plans.insert(id, (ts, plan));
                },
            );
        }
        self.deck_plans
            .retain(|id, _| list.iter().any(|x| x.id == *id && x.has_plan));
    }

    pub fn deck_plan(&mut self, id: String, action: &'static str) {
        self.deck_plans.remove(&id);
        spawn(
            move || api::plan(&id, action, None),
            move |s, r, _| {
                match r {
                    Ok(()) => s.flash(
                        if action == "reject" {
                            "✓ Back to planning"
                        } else {
                            "✓ Plan approved"
                        },
                        false,
                    ),
                    Err(e) => s.flash(format!("✗ Plan: {e}"), true),
                }
                refresh_sessions();
            },
        );
    }

    pub fn apply_sessions(&mut self, list: Vec<Session>, meta: Option<HashMap<String, Meta>>) {
        self.want_deck_plans(&list);
        let changed = |a: &Session, b: &Session| {
            a.last_activity != b.last_activity
                || a.state != b.state
                || a.has_question != b.has_question
                || a.has_plan != b.has_plan
        };
        let panes: Vec<String> = self.splits.iter().map(|p| p.id.clone()).collect();
        for sid in panes {
            let before = self.session(&sid).cloned();
            if let (Some(b), Some(a)) = (before, list.iter().find(|x| x.id == sid))
                && changed(&b, a)
            {
                self.refresh_split(&sid);
            }
        }
        if let Some(sel) = self.selected.clone() {
            let before = self.session(&sel).cloned();
            let after = list.iter().find(|x| x.id == sel);
            if let (Some(b), Some(a)) = (before, after)
                && changed(&b, a)
                && self.page == Page::Session
            {
                self.refresh_detail();
            }
        }
        self.sessions = list;
        if let Some(m) = meta {
            self.meta = m;
        }
        self.connected = true;
        self.tray_dirty = true;
        self.announce();
    }

    fn announce(&mut self) {
        let waiting: HashSet<String> = self.waiting().into_iter().map(|s| s.id.clone()).collect();
        let fresh: Vec<Session> = self
            .sessions
            .iter()
            .filter(|s| waiting.contains(&s.id) && !self.announced.contains(&s.id))
            .cloned()
            .collect();
        self.announced = waiting;
        if !self.notify || rune_notify::app_focused() {
            return;
        }
        for s in fresh {
            let body = match s.question.as_ref().and_then(|q| q.as_str()) {
                Some(q) => q.to_string(),
                None if s.state == "attention" => "Action required".into(),
                None => {
                    fmt::first_line(s.last_reply.as_deref().unwrap_or("Finished its turn"), 140)
                }
            };
            crate::tray::notify(&s.id, &s.display_title(), &body);
        }
    }

    fn act(
        &mut self,
        label: &'static str,
        work: impl FnOnce() -> Result<(), String> + Send + 'static,
    ) {
        spawn(work, move |s, r, _| {
            match r {
                Ok(()) => s.flash(format!("✓ {label}"), false),
                Err(e) => s.flash(format!("✗ {label}: {e}"), true),
            }
            s.refresh_detail();
        });
    }

    pub fn send(&mut self) {
        if self.detail.is_none() {
            return;
        }
        if self.sending {
            return;
        }
        if self
            .attachments
            .iter()
            .any(|a| a.path.is_none() && !a.failed)
        {
            self.flash("Wait for the images to finish uploading", true);
            return;
        }
        let paths = self.attachments.iter().filter_map(|a| a.path.clone());
        let text = paths
            .chain(std::iter::once(self.composer.text.trim().to_string()))
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if text.is_empty() {
            return;
        }
        self.attachments.clear();
        self.composer = TextEdit::new("");
        self.composer.focused = true;
        self.stash_draft();
        self.send_prompt(text);
    }

    pub fn send_prompt(&mut self, text: String) {
        let Some(d) = self.detail.as_ref() else {
            return;
        };
        let (id, live, effort) = (
            d.session.id.clone(),
            d.session.live,
            d.session.effort.clone(),
        );
        self.sending = true;
        self.queued.push(text.clone());
        spawn(
            move || {
                if live {
                    api::reply(&id, &text)
                } else {
                    api::resume(&id, &text, effort.as_deref())
                }
            },
            |s, r, _| {
                s.sending = false;
                if let Err(e) = r {
                    s.queued.pop();
                    s.flash(format!("✗ Send failed: {e}"), true);
                }
                s.refresh_detail();
            },
        );
    }

    pub fn attach(&mut self, name: String, mime: &'static str, bytes: Vec<u8>) {
        if self.page != Page::Session || self.detail.is_none() {
            return;
        }
        self.attach_seq += 1;
        let id = self.attach_seq;
        self.attachments.push(Attachment {
            id,
            name,
            path: None,
            failed: false,
        });
        spawn(
            move || api::upload_image(mime, &bytes),
            move |s, r, _| {
                let Some(a) = s.attachments.iter_mut().find(|a| a.id == id) else {
                    return;
                };
                match r {
                    Ok(p) => a.path = Some(p),
                    Err(e) => {
                        a.failed = true;
                        s.flash(format!("✗ Upload failed: {e}"), true);
                    }
                }
            },
        );
    }

    pub fn attach_files(&mut self, files: &[std::path::PathBuf]) {
        for f in files {
            let Some(mime) = api::image_mime(f) else {
                continue;
            };
            let Ok(bytes) = std::fs::read(f) else {
                continue;
            };
            let name = f
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("image")
                .to_string();
            self.attach(name, mime, bytes);
        }
    }

    pub fn use_followup(&mut self, text: String) {
        self.composer = TextEdit::new(text);
        self.composer.focused = true;
    }

    pub fn interrupt(&mut self) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        self.act("Interrupted", move || api::interrupt(&id));
    }

    pub fn resume(&mut self) {
        let Some(d) = self.detail.as_ref() else {
            return;
        };
        let (id, effort) = (d.session.id.clone(), d.session.effort.clone());
        spawn(
            move || api::resume(&id, "", effort.as_deref()),
            move |s, r, _| {
                match r {
                    Ok(()) => s.flash("✓ Resumed", false),
                    Err(e) => s.flash(format!("✗ Resume: {e}"), true),
                }
                s.load_detail();
            },
        );
    }

    pub fn toggle_archive(&mut self, id: &str) {
        if self.group_of(id).is_none() {
            let members = self.group_members(id);
            if members.len() > 1 {
                for m in members.iter().filter(|m| *m != id) {
                    let archived = self.meta.get(id).is_some_and(|x| x.archived);
                    if self.meta.get(m.as_str()).is_some_and(|x| x.archived) == archived {
                        self.archive_one(m);
                    }
                }
            }
        }
        self.archive_one(id);
    }

    fn archive_one(&mut self, id: &str) {
        let archived = self.meta.get(id).is_some_and(|m| m.archived);
        let live = self.session(id).is_some_and(|s| s.live);
        self.meta.entry(id.to_string()).or_default().archived = !archived;
        let id = id.to_string();
        spawn(
            move || {
                if !archived && live {
                    let _ = api::kill(&id);
                }
                api::set_archived(&id, !archived)
            },
            move |s, r, _| {
                if let Err(e) = r {
                    s.flash(format!("✗ Archive: {e}"), true);
                }
                refresh_sessions();
            },
        );
    }

    pub fn set_mode(&mut self, mode: &'static str) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        if let Some(d) = self.detail.as_mut() {
            d.permission_mode = Some(mode.into());
        }
        self.act(fmt::mode_label(mode), move || api::set_mode(&id, mode));
    }

    pub fn toggle_auto_approve(&mut self) {
        let Some(d) = self.detail.as_mut() else {
            return;
        };
        d.auto_approve = !d.auto_approve;
        let (id, on) = (d.session.id.clone(), d.auto_approve);
        self.act(
            if on {
                "Auto-approve on"
            } else {
                "Auto-approve off"
            },
            move || api::set_auto_approve(&id, on),
        );
    }

    pub fn set_model(&mut self, model: Option<String>, effort: Option<String>, force: bool) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        self.popup = None;
        spawn(
            {
                let (model, effort) = (model.clone(), effort.clone());
                move || api::set_model(&id, model.as_deref(), effort.as_deref(), force)
            },
            move |s, r, _| {
                match r {
                    Ok(None) => s.flash("✓ Model updated", false),
                    Ok(Some(why)) => {
                        s.flash(
                            format!("Held: {why} Pick it again from the menu to force it."),
                            true,
                        );
                        s.held_switch = Some((model, effort));
                    }
                    Err(e) => s.flash(format!("✗ Model: {e}"), true),
                }
                s.refresh_detail();
            },
        );
    }

    pub fn restart(&mut self) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        self.popup = None;
        self.act("Restarted", move || api::restart(&id));
    }

    pub fn open_trash(&mut self) {
        self.palette_open = false;
        self.picker = Some(crate::organize::Picker::Trash {
            items: None,
            busy: None,
        });
        spawn(
            || api::get("/api/trash"),
            |s, r, _| {
                if let Some(crate::organize::Picker::Trash { items, .. }) = s.picker.as_mut() {
                    let mut seen = HashSet::new();
                    let list = r
                        .ok()
                        .and_then(|v| v["trashed"].as_array().cloned())
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|t| {
                            t["id"]
                                .as_str()
                                .is_some_and(|id| seen.insert(id.to_string()))
                        })
                        .collect();
                    *items = Some(list);
                }
            },
        );
    }

    pub fn restore(&mut self, id: String) {
        let Some(crate::organize::Picker::Trash { busy, .. }) = self.picker.as_mut() else {
            return;
        };
        if busy.is_some() {
            return;
        }
        *busy = Some(id.clone());
        spawn(
            {
                let id = id.clone();
                move || api::post("/api/restore", serde_json::json!({ "id": id }))
            },
            move |s, r, _| {
                if let Some(crate::organize::Picker::Trash { items, busy }) = s.picker.as_mut() {
                    *busy = None;
                    if r.is_ok()
                        && let Some(list) = items.as_mut()
                    {
                        list.retain(|t| t["id"].as_str() != Some(id.as_str()));
                    }
                }
                match r {
                    Ok(_) => s.flash("✓ Restored", false),
                    Err(e) => s.flash(format!("✗ Restore: {e}"), true),
                }
                refresh_sessions();
            },
        );
    }

    pub fn delete(&mut self) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        self.popup = None;
        spawn(
            move || api::delete(&id),
            |s, r, _| {
                match r {
                    Ok(()) => {
                        s.flash("✓ Moved to trash", false);
                        s.selected = None;
                        s.detail = None;
                        s.page = Page::Deck;
                    }
                    Err(e) => s.flash(format!("✗ Delete: {e}"), true),
                }
                refresh_sessions();
            },
        );
    }

    pub fn open_editor(&mut self) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        self.popup = None;
        self.act("Opened in editor", move || api::open_editor(&id));
    }

    pub fn answer(&mut self) {
        let Some(d) = self.detail.as_ref() else {
            return;
        };
        let Some(q) = d.pending_question.as_ref() else {
            return;
        };
        let other = self.q_other.text.trim().to_string();
        let selections: Vec<api::Selection> = q
            .questions
            .iter()
            .enumerate()
            .map(|(i, qq)| api::Selection {
                multi: qq.multi_select,
                indices: self
                    .q_sel
                    .get(i)
                    .map(|s| s.iter().copied().collect())
                    .unwrap_or_default(),
                other: (i == 0 && !other.is_empty()).then(|| other.clone()),
            })
            .collect();
        let id = d.session.id.clone();
        self.act("Answered", move || api::answer(&id, &selections, None));
    }

    /// Permission requests are a three-option question; the order is the server's contract.
    pub fn answer_permission(&mut self, index: usize) {
        let Some(d) = self.detail.as_ref() else {
            return;
        };
        let id = d.session.id.clone();
        let label = ["Allowed once", "Always allowed", "Denied"][index.min(2)];
        self.act(label, move || {
            api::answer(
                &id,
                &[api::Selection {
                    multi: false,
                    indices: vec![index],
                    other: None,
                }],
                None,
            )
        });
    }

    pub fn pick_option(&mut self, qi: usize, oi: usize) {
        let multi = self
            .detail
            .as_ref()
            .and_then(|d| d.pending_question.as_ref())
            .and_then(|q| q.questions.get(qi))
            .is_some_and(|q| q.multi_select);
        if self.q_sel.len() <= qi {
            self.q_sel.resize(qi + 1, BTreeSet::new());
        }
        let set = &mut self.q_sel[qi];
        if multi {
            if !set.remove(&oi) {
                set.insert(oi);
            }
        } else {
            set.clear();
            set.insert(oi);
        }
    }

    pub fn plan_action(&mut self, action: &'static str) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        let note = self.plan_feedback.text.trim().to_string();
        if let Some(q) = self.plan_quote.take()
            && !note.is_empty()
        {
            self.plan_comments.push((q, note.clone()));
        }
        let feedback = if action != "reject" {
            None
        } else if self.plan_comments.is_empty() {
            (!note.is_empty()).then_some(note)
        } else {
            Some(compose_plan_feedback(&self.plan_comments))
        };
        self.plan_comments.clear();
        self.plan_feedback = TextEdit::new("");
        let label = if action == "reject" {
            "Plan rejected"
        } else {
            "Plan approved"
        };
        self.act(label, move || api::plan(&id, action, feedback.as_deref()));
    }

    pub fn launch(&mut self) {
        let cwd = self.new_project.text.trim().to_string();
        let prompt = self.new_prompt.text.trim().to_string();
        if cwd.is_empty() {
            self.flash("Pick a project folder first", true);
            return;
        }
        let (model, effort, mode, incognito) = (
            self.new_model.clone(),
            self.new_effort.clone(),
            self.new_mode.clone(),
            self.incognito,
        );
        let (worktree, ephemeral) = (self.new_worktree, self.new_ephemeral);
        let group_with = self.new_group.take();
        self.sending = true;
        spawn(
            move || {
                api::launch(&api::Launch {
                    cwd,
                    prompt,
                    model,
                    effort,
                    permission_mode: mode,
                    incognito,
                    worktree,
                    ephemeral,
                    group_with,
                })
            },
            |s, r, _| {
                s.sending = false;
                match r {
                    Ok(id) => {
                        s.flash("✓ Session launched", false);
                        refresh_sessions();
                        s.open_session(&id);
                    }
                    Err(e) => s.flash(format!("✗ Launch: {e}"), true),
                }
            },
        );
    }

    /// The models the pickers offer: the installed claude's list minus the ones hidden in Settings.
    pub fn visible_models(&self) -> Vec<(String, String)> {
        let hidden = self.setting("hiddenModels");
        let hidden: Vec<&str> = hidden
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|x| x.as_str())
            .collect();
        self.caps
            .models
            .iter()
            .filter(|(id, _)| !hidden.contains(&id.as_str()))
            .cloned()
            .collect()
    }

    pub fn nav_tab(&self, key: &str) -> bool {
        match self.setting("navTabs").as_array() {
            Some(list) => list.iter().any(|x| x.as_str() == Some(key)),
            None => true,
        }
    }

    pub fn menu_shows(&self, key: &str) -> bool {
        self.setting("statusBar")[key].as_bool().unwrap_or(true)
    }

    /// The name a session shows under: the one given here, else its own title.
    pub fn title_of(&self, x: &Session) -> String {
        self.names
            .get(&x.id)
            .cloned()
            .unwrap_or_else(|| x.display_title())
    }

    pub fn is_pinned(&self, id: &str) -> bool {
        self.pinned.iter().any(|p| p == id)
    }

    pub fn toggle_pin(&mut self, id: &str) {
        match self.pinned.iter().position(|p| p == id) {
            Some(i) => {
                self.pinned.remove(i);
            }
            None => self.pinned.push(id.to_string()),
        }
        let v = self.pinned.clone();
        self.save_pref("pinned", &v);
    }

    pub fn start_rename(&mut self, id: &str) {
        let current = self
            .session(id)
            .map(|x| self.title_of(x))
            .unwrap_or_default();
        let mut edit = TextEdit::new(current);
        edit.focused = true;
        self.row_menu = None;
        self.renaming = Some((id.to_string(), edit));
    }

    pub fn commit_rename(&mut self) {
        let Some((id, edit)) = self.renaming.take() else {
            return;
        };
        let name = edit.text.trim();
        if name.is_empty() || self.session(&id).is_some_and(|x| x.display_title() == name) {
            self.names.remove(&id);
        } else {
            self.names.insert(id, name.chars().take(120).collect());
        }
        let v = self.names.clone();
        self.save_pref("names", &v);
    }

    pub fn toggle_group_fold(&mut self, id: &str) {
        if !self.folded_groups.remove(id) {
            self.folded_groups.insert(id.to_string());
        }
        let v = self.folded_groups.clone();
        self.save_pref("foldedGroups", &v);
    }

    /// The sidebar's order: pinned, then (dynamic) awaiting you and most recent, or A→Z.
    pub fn sorted<'a>(&self, mut list: Vec<&'a Session>) -> Vec<&'a Session> {
        let recent = |x: &Session| std::cmp::Reverse(x.last_activity.clone().unwrap_or_default());
        match self.sort_mode.as_str() {
            "alpha" => {
                list.sort_by_key(|x| (!self.is_pinned(&x.id), self.title_of(x).to_lowercase()))
            }
            "alpha-project" => list.sort_by_key(|x| (!self.is_pinned(&x.id), recent(x))),
            _ => list.sort_by_key(|x| (!self.is_pinned(&x.id), !x.needs_you(), recent(x))),
        }
        list
    }

    pub fn toggle_card(&mut self, card: &'static str) {
        if !self.dock_cards.remove(card) {
            self.dock_cards.insert(card);
        }
    }

    pub fn open_gh(&mut self, url: String) {
        if self.gh_open.as_deref() == Some(url.as_str()) {
            self.gh_open = None;
            return;
        }
        self.gh_open = Some(url.clone());
        if self.gh.contains_key(&url) {
            return;
        }
        spawn(
            {
                let url = url.clone();
                move || api::gh_view(&url)
            },
            {
                let url = url.clone();
                move |s, r, _| {
                    let v = r.unwrap_or_else(|e| serde_json::json!({ "error": e }));
                    s.gh.insert(url, v);
                }
            },
        );
        if url.contains("/pull/") {
            spawn(
                {
                    let url = url.clone();
                    move || api::get(&format!("/api/github/detail?url={}", api::enc(&url)))
                },
                move |s, r, _| {
                    let checks = r
                        .ok()
                        .and_then(|v| v["checks"].as_array().cloned())
                        .unwrap_or_default();
                    s.gh_checks.insert(url, checks);
                },
            );
        }
    }

    /// Projects offered by New session: favourites first, then by last activity, worktrees
    /// under `.claude/worktrees/` folded into their project when asked to.
    pub fn launch_projects(&self) -> Vec<(String, bool)> {
        let favs: Vec<String> = self
            .setting("favoriteProjects")
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        let mut out: Vec<(String, bool)> = favs.iter().map(|f| (f.clone(), true)).collect();
        let mut recent: Vec<&Session> = self.sessions.iter().collect();
        recent.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
        for x in recent {
            let Some(p) = x.project.clone() else { continue };
            let p = match p.find("/.claude/worktrees/") {
                Some(i) if self.collapse_worktrees => p[..i].to_string(),
                _ => p,
            };
            if !out.iter().any(|(q, _)| *q == p) {
                out.push((p, false));
            }
        }
        out
    }

    pub fn pick_folder(&mut self) {
        let start = self.new_project.text.trim().to_string();
        self.new_custom = true;
        spawn(
            move || api::post("/api/pick-folder", serde_json::json!({ "start": start })),
            |s, r, _| match r {
                Ok(v) => {
                    if let Some(dir) = v["dir"].as_str() {
                        s.new_project = TextEdit::new(dir);
                    }
                }
                Err(e) => s.flash(format!("✗ Folder picker: {e}"), true),
            },
        );
    }

    pub fn projects(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for s in &self.sessions {
            if let Some(p) = s.project.clone()
                && seen.insert(p.clone())
            {
                out.push(p);
            }
        }
        out
    }
}

pub enum LinkTarget {
    Session(String),
    Open(String),
}

/// Where a link in a message goes: a hooked session link opens the session here, web links and
/// files open outside, other hooked paths open in the web dashboard.
pub fn link_target(url: &str) -> LinkTarget {
    let url = url.trim();
    if let Some(rest) = url.strip_prefix("/session/") {
        let id = rest.split(['?', '#', '/']).next().unwrap_or(rest);
        if !id.is_empty() {
            return LinkTarget::Session(id.to_string());
        }
    }
    LinkTarget::Open(if url.contains("://") || url.starts_with("mailto:") {
        url.to_string()
    } else if url.starts_with('/') && std::path::Path::new(url).exists() {
        format!("file://{url}")
    } else if url.starts_with('/') {
        format!("{}{url}", api::base())
    } else {
        format!("https://{url}")
    })
}

pub fn open_link(s: &mut Hooked, url: &str, tx: &mut Tx) {
    if crate::ghrun::parse_run_url(url).is_some() {
        s.open_run(url.to_string());
        return;
    }
    match link_target(url) {
        LinkTarget::Session(id) => s.open_session(&id),
        LinkTarget::Open(target) => {
            if tx.open_url(&target).is_err() {
                s.flash(format!("✗ Could not open {target}"), true);
            }
        }
    }
}

#[cfg(test)]
mod link_tests {
    use super::*;

    #[test]
    fn plan_feedback_quotes_each_passage() {
        let f = compose_plan_feedback(&[("step 1\nstep 2".into(), "merge these".into())]);
        assert_eq!(
            f,
            "Feedback on the plan — please keep planning and revise:\n\n> step 1\n> step 2\nmerge these"
        );
    }

    #[test]
    fn composer_triggers() {
        assert!(matches!(ac_query("/rev"), Some(AcQuery::Command(q)) if q == "rev"));
        assert!(ac_query("fix /rev").is_none());
        assert!(matches!(ac_query("see @src/ma"), Some(AcQuery::File(q, 4)) if q == "src/ma"));
        assert!(ac_query("mail me@host").is_none());
        assert!(ac_query("@a b").is_none());
    }

    #[test]
    fn links_go_where_hooked_sends_them() {
        assert!(
            matches!(link_target("/session/abc-123?lens=review"), LinkTarget::Session(id) if id == "abc-123")
        );
        assert!(
            matches!(link_target("https://github.com/x"), LinkTarget::Open(u) if u == "https://github.com/x")
        );
        assert!(
            matches!(link_target("/settings"), LinkTarget::Open(u) if u.ends_with("/settings") && u.starts_with("http"))
        );
        assert!(matches!(link_target("/tmp"), LinkTarget::Open(u) if u == "file:///tmp"));
        assert!(
            matches!(link_target("example.com"), LinkTarget::Open(u) if u == "https://example.com")
        );
    }
}

pub fn refresh_sessions() {
    spawn(
        || (api::sessions(), api::session_meta().ok(), api::tags().ok()),
        |s, (r, meta, tags), _| match r {
            Ok(list) => {
                if let Some(t) = tags {
                    s.tags = t;
                }
                s.apply_sessions(list, meta)
            }
            Err(_) => {
                s.connected = false;
                s.tray_dirty = true;
            }
        },
    );
}

/// Follows `/api/stream` (a tick per hook event and transcript write, plus a heartbeat) and
/// rereads the session list, at most a few times a second.
pub fn start_workers() {
    let Some(h) = HANDLE.get().cloned() else {
        return;
    };
    std::thread::spawn(move || {
        let mut last = Instant::now() - Duration::from_secs(10);
        loop {
            let r = api::follow("/api/stream", |_| {
                if last.elapsed() > Duration::from_millis(400) {
                    last = Instant::now();
                    if let (Ok(list), meta, tags) =
                        (api::sessions(), api::session_meta().ok(), api::tags().ok())
                    {
                        h.update(move |s, _| {
                            if let Some(t) = tags {
                                s.tags = t;
                            }
                            s.apply_sessions(list, meta)
                        });
                    }
                }
                true
            });
            if r.is_err() {
                h.update(|s, _| {
                    s.connected = false;
                    s.tray_dirty = true;
                });
            }
            std::thread::sleep(Duration::from_secs(3));
        }
    });
    std::thread::spawn(|| {
        if let Ok(caps) = api::capabilities()
            && let Some(h) = HANDLE.get()
        {
            h.update(move |s, _| s.caps = caps);
        }
        loop {
            std::thread::sleep(Duration::from_secs(60));
            if let (Ok((g, raw)), Some(h)) = (api::usage(), HANDLE.get()) {
                h.update(move |s, _| {
                    s.gauges = g;
                    s.usage = Some(raw);
                });
            }
        }
    });
}
