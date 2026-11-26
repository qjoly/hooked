use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use rune::prefs::Prefs;
use rune::{AppHandle, TextEdit, Tx};

use crate::api::{self, Capabilities, Detail, Gauge, LiveSnapshot, Meta, Session};
use crate::coderun::CodeRun;
use crate::fmt;
use crate::lenses::ReviewSource;

pub static HANDLE: OnceLock<AppHandle<Hooked>> = OnceLock::new();

/// Runs `work` off the main thread, then `done` on the app state. The handle lives in the state,
/// not in `HANDLE`: code a live-editing patch replaced sees a fresh copy of the crate's statics,
/// so it would find `HANDLE` empty and never call back.
impl Hooked {
    pub fn spawn<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
        done: impl FnOnce(&mut Hooked, T, &mut Tx) + Send + 'static,
    ) {
        spawn_on(self.handle.as_ref(), work, done);
    }
}

pub fn spawn_named(name: &str, work: impl FnOnce() + Send + 'static) {
    let _ = std::thread::Builder::new().name(name.into()).spawn(work);
}

pub fn spawn_on<T: Send + 'static>(
    handle: Option<&AppHandle<Hooked>>,
    work: impl FnOnce() -> T + Send + 'static,
    done: impl FnOnce(&mut Hooked, T, &mut Tx) + Send + 'static,
) {
    let Some(h) = handle.cloned() else {
        return;
    };
    crate::app::spawn_named("hooked-task", move || {
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
    Flows,
    GitHub,
    Incidents,
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

pub use hooked_ui::theme::Theme;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Popup {
    Sort,
    Filter,
    More,
    /// The top bar's menu of the pages not shown as tabs.
    Nav,
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

/// Provider filter cycle: all → each enabled provider in settings order → all. No-op with a
/// single provider (the filter would have nothing to tell apart).
pub fn next_provider_filter(cur: Option<&str>, enabled: &[String]) -> Option<String> {
    if enabled.len() < 2 {
        return None;
    }
    match cur {
        None => enabled.first().cloned(),
        Some(c) => enabled
            .iter()
            .position(|p| p == c)
            .and_then(|i| enabled.get(i + 1).cloned()),
    }
}

/// Provider to pin a new session on when a single one is enabled (nothing to choose); `None`
/// when several are — the user's choice is respected then.
pub fn pinned_provider(p: &api::Providers) -> Option<String> {
    p.only()
}

// Launch options of a provider not loaded (yet).
static NO_OPTS: serde_json::Value = serde_json::Value::Null;

pub struct Hooked {
    pub prefs: Prefs,
    pub sessions: Vec<Session>,
    pub meta: HashMap<String, Meta>,
    pub tags: HashMap<String, Vec<String>>,
    pub tag_filter: Vec<String>,
    pub repo_filter: Vec<String>,
    /// Provider filter (a provider id, None = all) — cycled by the filter-provider shortcut.
    /// Only meaningful with several providers enabled (providers.both()).
    pub provider_filter: Option<String>,
    pub incognito: bool,
    /// Remote hooked instances (`crate::remote`): the switch, off by default, and the list.
    pub remote_on: bool,
    pub remotes: Vec<crate::remote::Instance>,
    pub picker: Option<crate::organize::Picker>,
    pub gauges: Vec<Gauge>,
    /// Bloc `pi` de /api/usage : jauge de contexte de la session pi la plus fraîche (entête).
    pub pi_usage: Option<api::PiUsage>,
    /// Quelle vue d'usage affiche l'entête (rate limits claude ↔ jauge pi, cf. toggle_usage_view).
    pub usage_view: api::UsageView,
    pub caps: Capabilities,
    pub connected: bool,
    pub now: i64,

    pub page: Page,
    pub selected: Option<String>,
    pub lens: Lens,
    pub theme: Theme,
    pub scheme: crate::theme::ColorScheme,
    pub corners: crate::theme::Corners,
    pub notify: bool,

    pub sidebar_open: bool,
    pub sidebar_w: f32,
    pub dock_w: f32,
    pub dock_gh_w: Option<f32>,
    /// The Review lens's rendered Markdown column.
    pub rendered_w: f32,
    /// The Review lens leaves out the unchanged lines around each change.
    pub review_compact: bool,
    /// The Review lens's files rail and comments panel, both resizable.
    pub review_files_w: f32,
    pub review_threads_w: f32,
    /// The Review lens's width, as last laid out.
    pub review_w: f32,
    /// The lens is narrow and showed its side-by-side diff unified: it goes back to split
    /// once there is room.
    pub review_forced_unified: bool,
    /// The laid-out height of each short diff of the conversation, by tool call: what decides
    /// whether it needs "Show more".
    pub tool_diff_h: HashMap<String, f32>,
    pub window_h: f32,
    pub window_w: f32,
    pub show_archived: bool,
    pub hide_old: bool,
    pub layout: String,
    pub flipped_sections: HashSet<&'static str>,
    pub open_sections: HashSet<&'static str>,
    pub snooze_menu: Option<String>,
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
    /// Where each session's review was left, by session id.
    pub review_places: HashMap<String, crate::lenses::ReviewPlace>,
    /// `review_places` changed since it was last written, and when that was (ms).
    pub places_dirty: bool,
    pub places_saved_at: i64,
    pub job_log: Option<(String, String)>,
    /// Runs on shell blocks, by session and command.
    pub code_runs: HashMap<(String, String), CodeRun>,
    pub run_win: Option<crate::ghrun::RunWin>,
    pub query_win: Option<crate::querywin::QueryWin>,
    pub panel_win: Option<crate::panel::PanelWin>,
    pub float_at: HashMap<&'static str, [f32; 2]>,
    pub float_grab: [f32; 2],
    pub gh_checks: HashMap<String, Vec<serde_json::Value>>,
    pub gh_details: HashMap<String, Result<serde_json::Value, String>>,
    pub gh_diffs: HashMap<String, Result<serde_json::Value, String>>,
    pub gh_loading: std::collections::HashSet<String>,
    pub gh_page_view: Option<crate::ghdetail::GhView>,
    pub gh_dock_view: Option<crate::ghdetail::GhView>,
    pub plan_quote: Option<String>,
    pub usage: Option<serde_json::Value>,
    pub logo: Option<([usize; 6], [rune::Image; 2])>,
    pub handle: Option<AppHandle<Hooked>>,
    #[cfg(any(target_os = "macos", windows))]
    pub tray: Option<(crate::tray::native::TrayIcon, String)>,
    pub shortcuts: HashMap<&'static str, rune_kit::ShortcutRecorderState>,
    pub deck_plans: HashMap<String, (String, Option<String>)>,
    pub fleet: crate::fleet::Fleet,
    pub deck_w: f32,
    pub drop_rects: HashMap<String, [f32; 4]>,
    pub drop_live: std::cell::RefCell<std::collections::HashSet<String>>,
    pub dnd: Option<crate::dnd::Dnd>,
    pub players: crate::media::Players,
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
    pub ptys: crate::terminal::Ptys,
    pub term_focus: Option<crate::terminal::TermFocus>,
    pub term_claimed: bool,
    #[cfg(feature = "knobs")]
    pub knobs: rune_knobs::Knobs,
    pub theme_dark: std::cell::Cell<bool>,
    pub attach_seq: u64,
    pub queued: Vec<String>,
    pub sending: bool,

    pub q_sel: Vec<BTreeSet<usize>>,
    /// Per question, the "Other" write-in: `None` while not chosen.
    pub q_other: Vec<Option<TextEdit>>,
    /// Notes on chosen options, by (question, option).
    pub q_notes: std::collections::BTreeMap<(usize, usize), TextEdit>,
    pub plan_feedback: TextEdit,

    pub popup: Option<Popup>,
    pub flash: Option<Flash>,
    pub held_switch: Option<(Option<String>, Option<String>)>,

    pub new_project: TextEdit,
    pub new_prompt: TextEdit,
    pub new_model: Option<String>,
    pub new_effort: Option<String>,
    pub new_mode: String,
    /// Launch provider (any enabled provider id) — new-session screen.
    pub new_provider: String,
    /// Providers of this hooked (enabled flags + descriptors), refreshed with the session list.
    pub providers: api::Providers,
    /// /api/provider-options payload per provider (models / thinking / modes), loaded once per
    /// provider when it is enabled. `Null` while loading.
    pub prov_opts: HashMap<String, serde_json::Value>,
    /// Usage of every non-Claude provider (header block), from /api/usage.
    pub provider_usage: Vec<api::PiUsage>,
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
    pub inc: crate::incidents::Incidents,
    pub ghw: crate::ghwatch::GhWatch,
    pub announced: Option<HashSet<String>>,
    pub tray_dirty: bool,
    /// The conversation is scrolled up, away from its latest message: what shows the
    /// "back to the latest" arrow. Derived from `chat_edges` by [`Hooked::chat_moved`].
    pub chat_up: bool,
    /// Bottom edge of the conversation's content, then of its viewport, in window points.
    pub chat_edges: [f32; 2],
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
        let prefs = Prefs::open(crate::theme::PREFS_ID);
        let deck_grid = prefs.get::<String>("deckView").is_none_or(|v| v != "list");
        let pinned: Vec<String> = prefs.get("pinned").unwrap_or_default();
        let names: HashMap<String, String> = prefs.get("names").unwrap_or_default();
        let sort_mode: String = prefs
            .get("sortMode")
            .unwrap_or_else(|| "dynamic".to_string());
        let folded_groups: HashSet<String> = prefs.get("foldedGroups").unwrap_or_default();
        let tag_colors: HashMap<String, usize> = prefs.get("tagColors").unwrap_or_default();
        let drafts: HashMap<String, String> = prefs.get("drafts").unwrap_or_default();
        let reviewed: HashMap<String, Vec<String>> = prefs.get("reviewed").unwrap_or_default();
        let review_places: HashMap<String, crate::lenses::ReviewPlace> =
            prefs.get("reviewPlaces").unwrap_or_default();
        let saved_keys: HashMap<String, String> = prefs.get("shortcuts").unwrap_or_default();
        let shortcuts = crate::shortcuts::load(&saved_keys);
        let collapse_worktrees: bool = prefs.get("collapseWorktrees").unwrap_or(true);
        let crate::theme::Look {
            theme,
            scheme,
            corners,
        } = crate::theme::Look::load(&prefs);
        let notify = prefs.get("notify").unwrap_or(true);
        let incidents_hidden = prefs.get("incidentsHidden").unwrap_or(false);
        let incident_teams: Vec<String> = prefs.get("incidentsTeams").unwrap_or_default();
        let gh_watched: Vec<String> = prefs.get("ghWatched").unwrap_or_default();
        crate::perf::set_enabled(
            crate::perf::env_override().unwrap_or(prefs.get("perfDiagnostics").unwrap_or(false)),
        );
        let incognito = prefs.get("incognito").unwrap_or(false);
        let usage_view = api::UsageView::from_key(prefs.get::<String>("usageView").as_deref());
        // The address of the service, before anything below talks to it.
        let server_url: String = prefs.get("serverUrl").unwrap_or_default();
        api::set_server(api::normalize_server(&server_url));
        let remote_on: bool = prefs.get("remoteInstances").unwrap_or(false);
        let remotes: Vec<crate::remote::Instance> = prefs.get("remotes").unwrap_or_default();
        crate::remote::configure(remote_on, &remotes);
        crate::remote::first_poll(Duration::from_millis(700));
        let sidebar_open = prefs.get("sidebarOpen").unwrap_or(true);
        let hide_old = prefs.get("hideOld").unwrap_or(false);
        let layout = prefs
            .get("sidebarLayout")
            .unwrap_or_else(|| "status".to_string());
        let dock_open = prefs.get("dockOpen").unwrap_or(true);
        let prefs_w = prefs.get("sidebarW").unwrap_or(crate::view::SIDEBAR_W);
        let dock_w = prefs.get("dockW").unwrap_or(crate::view::DOCK_W);
        let dock_gh_w = prefs.get("dockGhW");
        let rendered_w = prefs.get("renderedW").unwrap_or(crate::view::RENDERED_W);
        let review_compact = prefs.get("reviewCompact").unwrap_or(false);
        let review_files_w = prefs
            .get("reviewFilesW")
            .unwrap_or(crate::view::REVIEW_FILES_W);
        let review_threads_w = prefs
            .get("reviewThreadsW")
            .unwrap_or(crate::view::REVIEW_THREADS_W);
        let mut s = Hooked {
            prefs,
            sessions: Vec::new(),
            meta: HashMap::new(),
            tags: HashMap::new(),
            tag_filter: Vec::new(),
            repo_filter: Vec::new(),
            provider_filter: None,
            tag_colors,
            incognito,
            remote_on,
            remotes,
            picker: None,
            gauges: Vec::new(),
            pi_usage: None,
            usage_view,
            caps: Capabilities::default(),
            connected: false,
            now: fmt::now_ms(),
            page: Page::Deck,
            selected: None,
            lens: Lens::Converse,
            theme,
            scheme,
            corners,
            notify,
            sidebar_open,
            sidebar_w: prefs_w,
            dock_w,
            dock_gh_w,
            rendered_w,
            review_compact,
            review_files_w,
            review_threads_w,
            review_w: f32::MAX,
            review_forced_unified: false,
            tool_diff_h: HashMap::new(),
            window_h: 860.0,
            window_w: 1320.0,
            show_archived: false,
            hide_old,
            layout,
            flipped_sections: HashSet::new(),
            open_sections: HashSet::new(),
            snooze_menu: None,
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
            review_places,
            places_dirty: false,
            places_saved_at: 0,
            job_log: None,
            code_runs: HashMap::new(),
            run_win: None,
            query_win: None,
            panel_win: None,
            float_at: HashMap::new(),
            float_grab: [0.0; 2],
            gh_checks: HashMap::new(),
            gh_details: HashMap::new(),
            gh_diffs: HashMap::new(),
            gh_loading: Default::default(),
            gh_page_view: None,
            gh_dock_view: None,
            plan_quote: None,
            usage: None,
            logo: None,
            handle: None,
            #[cfg(any(target_os = "macos", windows))]
            tray: None,
            shortcuts,
            deck_plans: HashMap::new(),
            fleet: crate::fleet::Fleet::new(deck_grid),
            deck_w: 1140.0,
            drop_rects: HashMap::new(),
            drop_live: Default::default(),
            dnd: None,
            players: Default::default(),
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
            ptys: Default::default(),
            term_focus: None,
            term_claimed: false,
            #[cfg(feature = "knobs")]
            knobs: Default::default(),
            theme_dark: std::cell::Cell::new(true),
            attach_seq: 0,
            queued: Vec::new(),
            sending: false,
            q_sel: Vec::new(),
            q_other: Vec::new(),
            q_notes: Default::default(),
            plan_feedback: TextEdit::new(""),
            popup: None,
            flash: None,
            held_switch: None,
            new_project: TextEdit::new(""),
            new_prompt: TextEdit::new(""),
            new_model: None,
            new_effort: None,
            new_mode: "default".into(),
            new_provider: "claude".into(),
            providers: api::Providers::default(),
            prov_opts: HashMap::new(),
            provider_usage: Vec::new(),
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
            pages: crate::pages::PageData {
                server_url: TextEdit::new(server_url),
                ..Default::default()
            },
            inc: crate::incidents::Incidents::new(
                incidents_hidden,
                incident_teams.into_iter().collect(),
            ),
            ghw: crate::ghwatch::GhWatch::new(gh_watched),
            announced: None,
            tray_dirty: true,
            chat_up: false,
            chat_edges: [f32::NAN; 2],
        };
        // A synchronous first read: headless snapshots and the first frame show real data.
        if let Ok((list, providers)) = api::sessions_full() {
            s.connected = true;
            s.sessions = list;
            // A single provider enabled → no picker, new_provider is pinned on it.
            if let Some(p) = pinned_provider(&providers) {
                s.new_provider = p;
            }
            s.providers = providers;
        }
        // Launch options of the enabled non-Claude providers (the pickers need them).
        for id in s.providers.enabled_ids() {
            if !s.providers.info(&id).is_claude() {
                if let Ok(v) = api::provider_options(&id) {
                    s.prov_opts.insert(id, v);
                }
            }
        }
        s.meta = api::session_meta().unwrap_or_default();
        s.tags = api::tags().unwrap_or_default();
        // The layout last picked in the lens wins; the Settings default is for a lens whose
        // layout was never picked.
        let split = s
            .prefs
            .get::<bool>("diffLastSplit")
            .or_else(|| s.prefs.get::<bool>("diffSplit"))
            .unwrap_or(false);
        if split {
            s.lens_data.diff.set_mode(rune_kit::diff::DiffMode::Split);
        }
        if let Ok(v) = api::get("/api/settings") {
            s.apply_settings(v);
            s.page = match s.setting("defaultPage").as_str().unwrap_or("deck") {
                "sessions" => Page::Session,
                "stats" => Page::Stats,
                "digest" => Page::Digest,
                "memory" => Page::Memory,
                "github" => Page::GitHub,
                "skills" => Page::Skills,
                "cron" => Page::Cron,
                "flows" => Page::Flows,
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
        if let Ok((g, pi, raw)) = api::usage() {
            s.gauges = g;
            s.pi_usage = pi;
            s.provider_usage = api::parse_provider_usage(&raw);
            s.usage = Some(raw);
        }
        // The settings' default provider is where a new session starts, when it is enabled.
        if let Some(d) = s.setting("defaultProvider").as_str().map(str::to_string) {
            if s.providers.is_enabled(&d) {
                s.new_provider = d;
            }
        }
        let args = rune::extra_args();
        s.term.height = s.prefs.get("termHeight");
        s.term.side = s.prefs.get("termSide").unwrap_or(false);
        s.term.side_w = s.prefs.get("termSideW").unwrap_or(0.0);
        s.term.font = s.prefs.get("termFont").unwrap_or(0.0);
        let family: String = s.prefs.get("termFontFamily").unwrap_or_default();
        s.term.family = rune::TextEdit::new(family.clone());
        if !family.is_empty() {
            s.term.family_name = Some(Box::leak(family.into_boxed_str()));
        }
        let start = args
            .iter()
            .position(|a| a == "--session")
            .and_then(|i| args.get(i + 1).cloned())
            .or_else(|| {
                (s.page == Page::Session)
                    .then(|| s.last_session())
                    .flatten()
            });
        if let Some(id) = start {
            s.page = Page::Session;
            s.detail = api::detail(&id).ok();
            let in_worktree = s
                .detail
                .as_ref()
                .is_some_and(|d| d.session.worktree_of.is_some());
            s.lens_data.review_source = ReviewSource::default_for(in_worktree);
            if let Some(place) = s.review_places.get(&id).cloned() {
                s.lens_data.restore(&place);
            }
            s.selected = Some(id);
            s.reset_question();
        } else if s.page == Page::Session {
            s.page = Page::Deck;
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
                    s.lens_data.mcp_provider = api::mcp_param(d.session.provider.as_deref());
                    s.lens_data.mcp =
                        api::mcp_list(&cwd, true, s.lens_data.mcp_provider.as_deref()).unwrap_or_default();
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
                Some("filter-repo") => s.open_filter_picker(true),
                Some("filter-tag") => s.open_filter_picker(false),
                _ => {}
            }
        }
        if args.iter().any(|a| a == "--row-menu")
            && let Some(id) = s.selected.clone()
        {
            s.row_menu = Some((id, rune::PointerPress { x: 220.0, y: 260.0 }));
        }
        if let Some(i) = args.iter().position(|a| a == "--open-section") {
            let label = args.get(i + 1).cloned().unwrap_or_default();
            if let Some(sec) = crate::sections::Section::ALL
                .into_iter()
                .find(|x| x.label().eq_ignore_ascii_case(&label))
            {
                s.toggle_section(sec);
            }
        }
        #[cfg(feature = "knobs")]
        if let Some(i) = args.iter().position(|a| a == "--knobs") {
            s.knobs.show();
            if let Some(g) = args.get(i + 1).filter(|g| !g.starts_with("--")) {
                s.knobs.pick(g);
                s.knobs.set_folded(g, false);
                if let Some(group) = crate::knobs::groups().iter().find(|x| x.name == g.as_str()) {
                    s.knobs.set_folded(group.page(), false);
                }
            }
        }
        if args.iter().any(|a| a == "--snooze-menu") {
            s.snooze_menu = s.selected.clone();
        }
        if args.iter().any(|a| a == "--filter-menu") {
            s.popup = Some(Popup::Filter);
        }
        if args.iter().any(|a| a == "--sort-menu") {
            s.popup = Some(Popup::Sort);
        }
        if args.iter().any(|a| a == "--more-menu") {
            s.popup = Some(Popup::More);
        }
        if args.iter().any(|a| a == "--model-menu") {
            s.popup = Some(Popup::Model);
        }
        if args.iter().any(|a| a == "--effort-menu") {
            s.popup = Some(Popup::Effort);
        }
        if let Some(i) = args.iter().position(|a| a == "--media") {
            let path = args.get(i + 1).cloned().unwrap_or_default();
            let kind = args.get(i + 2).cloned().unwrap_or_else(|| "video".into());
            let m = serde_json::json!({
                "role": "assistant",
                "parts": [{
                    "type": "tool",
                    "tool": { "id": "media-test", "name": format!("mcp__hooked__show_{kind}"), "result": "shown" },
                    "show": { "kind": kind, "path": path, "title": "Media check" }
                }]
            });
            if let (Some(d), Ok(m)) = (s.detail.as_mut(), serde_json::from_value(m)) {
                d.messages.push(m);
            }
            if args.iter().any(|a| a == "--media-play") {
                s.players.get(&path, kind == "audio").play();
            }
        }
        if let Some(i) = args.iter().position(|a| a == "--pty") {
            let id = args.get(i + 1).cloned().unwrap_or_default();
            s.preload_pty(&id, args.get(i + 2).map_or("/tmp", String::as_str));
        }
        if args.iter().any(|a| a == "--term") {
            s.preload_terms();
            if args.iter().any(|a| a == "--term-closed") {
                s.term.open = false;
            }
            if args.iter().any(|a| a == "--term-side") {
                s.term.side = true;
            }
            if args.iter().any(|a| a == "--term-sel") {
                let top = s.term.terms.first().map_or(0, |t| t.vt.viewport_top());
                s.term.sel = Some(crate::terminal::Sel {
                    anchor: (2, top + 1),
                    head: (12, top + 2),
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
                Some("deck") => Page::Deck,
                Some("stats") => Page::Stats,
                Some("digest") => Page::Digest,
                Some("memory") => Page::Memory,
                Some("cron") => Page::Cron,
                Some("flows") => Page::Flows,
                Some("github") => Page::GitHub,
                Some("incidents") => Page::Incidents,
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
                        format!("/api/commands?id={}&q={}{}", api::enc(&id), api::enc(&q), Self::ac_provider_suffix(&s, &id)),
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
        if let Some(i) = args.iter().position(|a| a == "--query") {
            let (session, id) = (
                args.get(i + 1).cloned().unwrap_or_default(),
                args.get(i + 2).cloned().unwrap_or_default(),
            );
            let v = api::get(&format!(
                "/api/query-result?session={}&agent=&id={}",
                api::enc(&session),
                api::enc(&id)
            ))
            .unwrap_or_default();
            s.query_win = Some(crate::querywin::QueryWin {
                spec: Some(crate::querywin::live_spec(
                    v["tool"].as_str().unwrap_or(""),
                    &v["input"],
                )),
                data: Some(v["data"].clone()),
                refresh: 0,
                ..Default::default()
            });
        }
        if let Some(dir) = args
            .iter()
            .position(|a| a == "--panel")
            .and_then(|i| args.get(i + 1))
        {
            let mut w = crate::panel::PanelWin::new(&crate::panel::panel_from_dir(dir), true);
            if args.iter().any(|a| a == "--panel-minimized") {
                w.set_minimized(true);
                w.unseen = true;
            }
            s.panel_win = Some(w);
        }
        if let Some(i) = args.iter().position(|a| a == "--gh") {
            let url = args.get(i + 1).cloned().unwrap_or_default();
            let tab = args.get(i + 2).and_then(|t| t.parse().ok()).unwrap_or(0);
            let d = api::get(&format!("/api/github/detail?url={}", api::enc(&url)));
            s.gh_details.insert(url.clone(), d);
            if tab == 2 {
                let p = api::get(&format!("/api/github/diff?url={}", api::enc(&url)))
                    .map(|v| v["files"].clone());
                s.gh_diffs.insert(url.clone(), p);
            }
            let in_dock = s.selected.is_some();
            s.gh_open = Some(url.clone());
            if in_dock {
                s.open_gh_full(url.clone());
            } else {
                s.peek_gh(url.clone());
            }
            let slot = if in_dock {
                crate::ghdetail::GhSlot::Dock
            } else {
                crate::ghdetail::GhSlot::Page
            };
            if let Some(v) = s.gh_view_mut(slot) {
                v.tab = tab;
                if let Some(f) = args.get(i + 3) {
                    v.files.insert(f.clone());
                }
            }
        }
        if args.iter().any(|a| a == "--fleet-list") {
            s.fleet.grid = false;
            s.fleet.archived_open = true;
        }
        if args.iter().any(|a| a == "--branch") {
            s.lens_data.review_source = ReviewSource::Branch;
            s.lens_data.branch_open = true;
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

    /// Applies the address typed in Settings → This app → Server (empty: back to this machine's
    /// port 4123), and has everything that was read from the old service read again.
    pub fn apply_server(&mut self) {
        let typed = self.pages.server_url.text.trim().to_string();
        let url = if typed.is_empty() {
            None
        } else {
            let Some(u) = api::normalize_server(&typed) else {
                self.flash("✗ Expected an address such as 192.168.1.5:4123 or http://host:4123", true);
                return;
            };
            Some(u)
        };
        // The field shows what is in force, so a bare `box` reads `http://box:4123` afterwards.
        self.pages.server_url = TextEdit::new(url.clone().unwrap_or_default());
        self.save_pref("serverUrl", &url.clone().unwrap_or_default());
        api::set_server(url);
        self.connected = false;
        self.tray_dirty = true;
        self.pages.settings_stale = true;
        self.refresh_sessions();
        self.refresh_detail();
        self.spawn(api::capabilities, |s, r, _| {
            if let Ok(caps) = r {
                s.caps = caps;
            }
        });
        let label = api::base_label();
        self.flash(format!("Connecting to {label}…"), false);
    }

    pub fn dark(&self, system_dark: bool) -> bool {
        self.theme.dark(system_dark)
    }

    pub fn set_theme(&mut self, theme: Theme) {
        self.theme = theme;
        self.save_pref(crate::theme::PREF_THEME, &theme);
    }

    pub fn set_scheme(&mut self, scheme: crate::theme::ColorScheme) {
        self.scheme = scheme;
        self.save_pref(crate::theme::PREF_SCHEME, &scheme);
        self.apply_look();
    }

    pub fn set_corners(&mut self, corners: crate::theme::Corners) {
        self.corners = corners;
        self.save_pref(crate::theme::PREF_CORNERS, &corners);
        self.apply_look();
    }

    fn apply_look(&mut self) {
        crate::theme::set_look(self.scheme, self.corners);
        self.logo = None;
        self.refresh_logo();
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
        self.spawn(
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

    fn last_session(&self) -> Option<String> {
        let last: Option<String> = self.prefs.get("lastSession");
        last.filter(|id| self.sessions.iter().any(|x| &x.id == id))
            .or_else(|| {
                self.sessions
                    .iter()
                    .filter(|x| !self.is_archived(x) && self.visible(x))
                    .max_by(|a, b| a.last_activity.cmp(&b.last_activity))
                    .map(|x| x.id.clone())
            })
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
        self.spawn(
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

    
/// `&provider=<id>` for the « / » completion when no session is selected (New session screen)
/// and the picked provider is not Claude — the server would fall back on claude otherwise.
fn ac_provider_suffix(s: &Hooked, id: &str) -> String {
    if id.is_empty() && s.new_provider != "claude" && s.providers.is_enabled(&s.new_provider) {
        format!("&provider={}", api::enc(&s.new_provider))
    } else {
        String::new()
    }
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
                format!("/api/commands?id={}&q={}{}", api::enc(&id), api::enc(q), Self::ac_provider_suffix(self, &id)),
                0,
            ),
            AcQuery::File(q, at) => (
                format!("/api/files?id={}&q={}", api::enc(&id), api::enc(q)),
                *at,
            ),
        };
        let files = matches!(query, AcQuery::File(..));
        self.spawn(
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
        let (Some(id), Some(h)) = (self.selected.clone(), self.handle.clone()) else {
            return;
        };
        self.job_log = Some((task.clone(), String::new()));
        let gen_ref = self.job_gen.clone();
        crate::app::spawn_named("hooked-job-log", move || {
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
                        fmt::keep_tail(text, 65_536);
                    }
                });
                true
            });
        });
    }

    /// Runs a shell block Claude proposed, its output streaming under the block. The agent gets
    /// the output once the command ends, and continues.
    pub fn run_code(&mut self, session: String, code: String) {
        let Some(h) = self.handle.clone() else {
            return;
        };
        let command = code.trim().to_string();
        let key = (session.clone(), command.clone());
        self.code_runs.insert(key.clone(), CodeRun::started());
        crate::app::spawn_named("hooked-run", move || {
            let on_output = |chunk: &str| {
                let (chunk, key) = (chunk.to_string(), key.clone());
                h.update(move |s, _| {
                    if let Some(run) = s.code_runs.get_mut(&key) {
                        run.push(&chunk);
                    }
                });
            };
            let r = api::run_command(&session, &command, on_output);
            h.update(move |s, _| {
                if let Some(run) = s.code_runs.get_mut(&key) {
                    run.finish(&r);
                }
                if let Err(e) = r {
                    s.flash(format!("✗ Run: {e}"), true);
                }
                s.refresh_detail();
            });
        });
    }

    /// The Runs of `session` whose command appears in `text`, by command: what the code blocks of
    /// one message show.
    pub fn code_runs_in(&self, session: &str, text: &str) -> BTreeMap<String, CodeRun> {
        self.code_runs
            .iter()
            .filter(|((id, command), _)| id == session && text.contains(command.as_str()))
            .map(|((_, command), run)| (command.clone(), run.clone()))
            .collect()
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
        self.save_pref(crate::theme::PREF_THEME, &t);
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
        self.snooze_until(ids, fmt::now_ms() + (hours * 3_600_000.0) as i64);
    }

    pub fn send_followup(&mut self, id: String, text: String) {
        self.spawn(
            move || api::reply(&id, &text),
            |s, r, _| {
                match r {
                    Ok(_) => s.flash("✓ Follow-up sent", false),
                    Err(e) => s.flash(format!("✗ Follow-up: {e}"), true),
                }
                s.refresh_sessions();
            },
        );
    }

    pub fn deck_answer(&mut self, id: String, index: usize) {
        self.spawn(
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
                s.refresh_sessions();
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

    /// Reported by the conversation's content (`edge` 0) and viewport (`edge` 1) as they are
    /// laid out and scrolled. The view only reads `chat_up`, so a scroll re-runs it twice at
    /// most: when the arrow appears and when it leaves.
    pub fn chat_moved(&mut self, edge: usize, bottom: f32, tx: &mut Tx) {
        /// How far above the end, in points, counts as "scrolled up".
        const AWAY: f32 = 120.0;
        self.chat_edges[edge] = bottom;
        // False while either edge is still unknown (NaN).
        let up = self.chat_edges[0] - self.chat_edges[1] > AWAY;
        if up == self.chat_up {
            tx.live_only();
        } else {
            self.chat_up = up;
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
        self.save_pref("lastSession", &id);
        self.players.clear();
        self.set_term_focus(None);
        self.term_claimed = false;
        self.selected = Some(id.to_string());
        self.detail = None;
        self.live = None;
        self.working_since = None;
        self.visible = WINDOW;
        self.queued.clear();
        self.attachments.clear();
        self.tools_open.clear();
        let in_worktree = self
            .sessions
            .iter()
            .any(|x| x.id == id && x.worktree_of.is_some());
        self.tool_diff_h.clear();
        // A session opens on its own review, not on the scope the previous one was left on.
        let source = ReviewSource::default_for(in_worktree);
        let mode = self.lens_data.diff.mode();
        self.lens_data = crate::lenses::LensData {
            review_source: source,
            ..Default::default()
        };
        if let Some(place) = self.review_places.get(id) {
            self.lens_data.restore(place);
        }
        self.lens_data.diff.set_mode(mode);
        self.ac = None;
        self.job_gen.fetch_add(1, Ordering::SeqCst);
        self.job_log = None;
        self.code_runs.retain(|_, run| run.busy);
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
        self.spawn(
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
        self.wake(&sid);
        self.spawn(
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
        self.q_other = vec![None; n];
        self.q_notes.clear();
        self.plan_feedback = TextEdit::new("");
    }

    pub fn load_detail(&mut self) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        let generation = self.detail_gen.fetch_add(1, Ordering::SeqCst) + 1;
        self.detail_loading = true;
        let gen_ref = self.detail_gen.clone();
        let worker_gen = gen_ref.clone();
        self.spawn(
            {
                let id = id.clone();
                // A freshly launched session is not served until its transcript or first hook
                // event lands, which can trail /api/launch's reply.
                move || {
                    let mut tries = 0;
                    loop {
                        let r = api::detail(&id);
                        let missing = matches!(&r, Err(e) if e == "HTTP 404");
                        if !missing
                            || tries >= 20
                            || worker_gen.load(Ordering::SeqCst) != generation
                        {
                            return r;
                        }
                        tries += 1;
                        std::thread::sleep(Duration::from_millis(400));
                    }
                }
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
        self.spawn(
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
        if self.detail.as_ref().is_none_or(|x| x.session.id != d.session.id) {
            self.prune_media(&d);
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

    fn shots_wanted(&self) -> usize {
        if self.dock_cards.contains("dock-shots") {
            crate::view::SHOTS_OPEN
        } else {
            crate::view::SHOTS_FOLDED
        }
    }

    fn prune_media(&mut self, d: &Detail) {
        let shots = self.shots_wanted();
        let mut keep: HashSet<String> = api::media_refs(d, shots).into_iter().map(|(p, _)| p).collect();
        for p in &self.splits {
            if let Some(sd) = p.detail.as_ref() {
                keep.extend(api::media_refs(sd, shots).into_iter().map(|(p, _)| p));
            }
        }
        if let Some(crate::organize::Picker::Image { paths, .. }) = self.picker.as_ref() {
            keep.extend(paths.iter().cloned());
        }
        self.media.retain(|p, _| keep.contains(p));
    }

    /// The lightbox steps past the screenshots the dock preloaded.
    pub fn want_image(&mut self, path: &str) {
        if self.media.contains_key(path) {
            return;
        }
        let Some(d) = self.detail.as_ref() else {
            return;
        };
        let refs: Vec<(String, String)> = api::media_refs(d, usize::MAX)
            .into_iter()
            .filter(|(p, _)| p == path)
            .take(1)
            .collect();
        self.load_media(refs, false);
    }

    pub fn want_media(&mut self, d: &Detail, now: bool) {
        let refs = api::media_refs(d, self.shots_wanted());
        self.load_media(refs, now);
    }

    fn load_media(&mut self, refs: Vec<(String, String)>, now: bool) {
        let Some(cache) = self.images.as_ref() else {
            return;
        };
        let handle = self.handle.clone();
        let media = &mut self.media;
        for (path, url) in refs {
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
            spawn_on(
                handle.as_ref(),
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
        let Some(h) = self.handle.clone() else {
            return;
        };
        let gen_ref = self.detail_gen.clone();
        crate::app::spawn_named("hooked-session-stream", move || {
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
            self.spawn(
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
        self.spawn(
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
                s.refresh_sessions();
            },
        );
    }

    pub fn apply_sessions(&mut self, list: Vec<Session>, meta: Option<HashMap<String, Meta>>) {
        self.want_deck_plans(&list);
        // A stage moving on always comes with hook events: the open pipeline follows them.
        if self.page == Page::Flows {
            self.load_flows();
        }
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
        let Some(seen) = self.announced.replace(waiting.clone()) else {
            return;
        };
        if !self.notify || rune_notify::app_focused() {
            return;
        }
        let now = fmt::now_ms();
        let fresh: Vec<Session> = self
            .sessions
            .iter()
            .filter(|s| waiting.contains(&s.id) && !seen.contains(&s.id))
            .filter(|s| !self.snoozed(&s.id) && recently_active(s, now))
            .cloned()
            .collect();
        for s in fresh {
            let body = match s.question.as_ref().and_then(|q| q.as_str()) {
                Some(q) => q.to_string(),
                None if s.state == "attention" => "Action required".into(),
                None => {
                    fmt::first_line(s.last_reply.as_deref().unwrap_or("Finished its turn"), 140)
                }
            };
            // A remote session says so in its notification: the title alone could be a local one.
            let title = match &s.remote {
                Some(r) => format!("[{}] {}", r.name, s.display_title()),
                None => s.display_title(),
            };
            crate::tray::notify(&s.id, &title, &body);
        }
    }

    fn act(
        &mut self,
        label: &'static str,
        work: impl FnOnce() -> Result<(), String> + Send + 'static,
    ) {
        self.spawn(work, move |s, r, _| {
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
        self.wake(&id);
        self.spawn(
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
        // Attachments are collected on the session page AND on the New-session page (a pasted
        // image must be attachable before any session exists); launch() joins their paths to the
        // first prompt, like send() does for replies.
        if !matches!(self.page, Page::Session | Page::New) {
            return;
        }
        if self.page == Page::Session && self.detail.is_none() {
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
        let bytes: std::sync::Arc<[u8]> = bytes.into();
        let upload = bytes.clone();
        // The image has to land on the machine whose Claude will read it. A new session is
        // always local (it is launched with a local cwd), so there is no remote to target.
        let remote = if self.page == Page::Session {
            self.detail
                .as_ref()
                .filter(|d| d.session.remote.is_some())
                .map(|d| d.session.id.clone())
        } else {
            None
        };
        self.spawn(
            move || api::upload_image(mime, &upload, remote.as_deref()),
            move |s, r, _| {
                // Seed the media cache from the bytes in hand, keyed by the server path: the
                // composer chip gets its thumbnail and the sent message its picture at once.
                if let (Ok(p), Some(cache)) = (&r, s.images.as_ref()) {
                    s.media.insert(p.clone(), Some(cache.load(bytes)));
                }
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

    pub fn followup(&self) -> Option<String> {
        let d = self.detail.as_ref()?;
        d.followup_suggestion.clone().filter(|f| {
            !f.is_empty()
                && d.pending_question.is_none()
                && d.pending_plan.is_none()
                && self.queued.is_empty()
        })
    }

    pub fn use_followup(&mut self, text: String) {
        self.composer = TextEdit::new(text);
        self.composer.focused = true;
    }

    pub fn send_suggestion(&mut self, text: String) {
        if self.sending {
            return;
        }
        self.send_prompt(text);
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
        self.spawn(
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
        self.spawn(
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
                s.refresh_sessions();
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
        self.spawn(
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
        self.spawn(
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
        self.spawn(
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
                s.refresh_sessions();
            },
        );
    }

    pub fn delete(&mut self) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        self.popup = None;
        self.spawn(
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
                s.refresh_sessions();
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

    /// Whether every question has an answer: a ticked option or a typed "Other".
    pub fn question_answered(&self) -> bool {
        let Some(q) = self
            .detail
            .as_ref()
            .and_then(|d| d.pending_question.as_ref())
        else {
            return false;
        };
        (0..q.questions.len()).all(|i| {
            self.q_sel.get(i).is_some_and(|s| !s.is_empty()) || !self.other_text(i).is_empty()
        })
    }

    fn other_text(&self, qi: usize) -> String {
        self.q_other
            .get(qi)
            .and_then(Option::as_ref)
            .map(|t| t.text.trim().to_string())
            .unwrap_or_default()
    }

    pub fn answer(&mut self) {
        if !self.question_answered() {
            return;
        }
        let Some(d) = self.detail.as_ref() else {
            return;
        };
        let Some(q) = d.pending_question.as_ref() else {
            return;
        };
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
                other: Some(self.other_text(i)).filter(|o| !o.is_empty()),
            })
            .collect();
        let notes: Vec<(usize, usize, String)> = self
            .q_notes
            .iter()
            .map(|(&(qi, oi), t)| (qi, oi, t.text.clone()))
            .collect();
        let note = compose_notes(&q.questions, &self.q_sel, &notes);
        let id = d.session.id.clone();
        self.wake(&id);
        self.act("Answered", move || {
            api::answer(
                &id,
                &selections,
                Some(note.as_str()).filter(|n| !n.is_empty()),
            )
        });
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

    fn question_multi(&self, qi: usize) -> bool {
        self.detail
            .as_ref()
            .and_then(|d| d.pending_question.as_ref())
            .and_then(|q| q.questions.get(qi))
            .is_some_and(|q| q.multi_select)
    }

    fn question_slots(&mut self, qi: usize) {
        if self.q_sel.len() <= qi {
            self.q_sel.resize(qi + 1, BTreeSet::new());
        }
        if self.q_other.len() <= qi {
            self.q_other.resize(qi + 1, None);
        }
    }

    /// Ticks an option (toggles it on a multi-select). A note only lives on a ticked option,
    /// and picking a listed option on a single choice drops its "Other" write-in.
    pub fn pick_option(&mut self, qi: usize, oi: usize) {
        let multi = self.question_multi(qi);
        self.question_slots(qi);
        let set = &mut self.q_sel[qi];
        if multi {
            if !set.remove(&oi) {
                set.insert(oi);
            }
        } else {
            set.clear();
            set.insert(oi);
            self.q_other[qi] = None;
        }
        let kept = self.q_sel[qi].clone();
        self.q_notes
            .retain(|&(q, o), _| q != qi || kept.contains(&o));
    }

    /// The ✎ on an option: takes it and opens its own note, or drops the note when open.
    pub fn toggle_note(&mut self, qi: usize, oi: usize) {
        if self.q_notes.remove(&(qi, oi)).is_some() {
            return;
        }
        self.question_slots(qi);
        if !self.q_sel[qi].contains(&oi) {
            self.pick_option(qi, oi);
        }
        self.q_notes.insert((qi, oi), TextEdit::new(""));
    }

    pub fn note_edit(&mut self, qi: usize, oi: usize) -> &mut TextEdit {
        self.q_notes
            .entry((qi, oi))
            .or_insert_with(|| TextEdit::new(""))
    }

    /// The "Other" choice: a write-in that replaces the ticked option on a single choice and
    /// joins the ticked ones on a multi-select.
    pub fn toggle_other(&mut self, qi: usize) {
        self.question_slots(qi);
        if self.q_other[qi].take().is_some() {
            return;
        }
        self.q_other[qi] = Some(TextEdit::new(""));
        if !self.question_multi(qi) {
            self.q_sel[qi].clear();
            self.q_notes.retain(|&(q, _), _| q != qi);
        }
    }

    pub fn other_edit(&mut self, qi: usize) -> &mut TextEdit {
        self.question_slots(qi);
        self.q_other[qi].get_or_insert_with(|| TextEdit::new(""))
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
        if cwd.is_empty() {
            self.flash("Pick a project folder first", true);
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
        // The uploaded images' paths go first in the prompt: Claude Code reads them by path,
        // like a drag-drop in the TUI (same convention as the web composer and send()).
        let paths = self.attachments.iter().filter_map(|a| a.path.clone());
        let prompt = paths
            .chain(std::iter::once(self.new_prompt.text.trim().to_string()))
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        self.attachments.clear();
        let (model, effort, mode, incognito) = (
            self.new_model.clone(),
            self.new_effort.clone(),
            self.new_mode.clone(),
            self.incognito,
        );
        // Always explicit: with a default provider set in the settings, "none" would not mean
        // Claude. worktree / ephemeral only go out when the provider supports them (the UI hides
        // them otherwise).
        let info = self.providers.info(&self.new_provider);
        let (worktree, ephemeral) = (
            self.new_worktree && info.can("worktree"),
            self.new_ephemeral && info.can("ephemeral"),
        );
        let provider = Some(self.new_provider.clone());
        self.sending = true;
        self.spawn(
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
                    provider,
                })
            },
            |s, r, _| {
                s.sending = false;
                match r {
                    Ok(id) => {
                        s.flash("✓ Session launched", false);
                        s.refresh_sessions();
                        s.open_session(&id);
                    }
                    Err(e) => s.flash(format!("✗ Launch: {e}"), true),
                }
            },
        );
    }

    /// The ids hidden from one picker list in Settings (`hiddenModels`, `hiddenPiModels`).
    fn hidden_setting(&self, key: &str) -> Vec<String> {
        self.setting(key)
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|x| x.as_str().map(str::to_string))
            .collect()
    }

    /// The models the pickers offer: the installed claude's list minus the ones hidden in Settings.
    pub fn visible_models(&self) -> Vec<(String, String)> {
        let hidden = self.hidden_setting("hiddenModels");
        self.caps
            .models
            .iter()
            .filter(|(id, _)| !hidden.contains(id))
            .cloned()
            .collect()
    }

    /// Launch options of a provider (/api/provider-options), `Null` until loaded.
    pub fn opts_for(&self, provider: &str) -> &serde_json::Value {
        self.prov_opts.get(provider).unwrap_or(&NO_OPTS)
    }

    /// Loads the launch options of `provider` in the background, once.
    pub fn ensure_opts(&mut self, provider: &str) {
        if provider.is_empty() || self.prov_opts.contains_key(provider) || self.providers.info(provider).is_claude() {
            return;
        }
        self.prov_opts.insert(provider.to_string(), serde_json::Value::Null);
        let id = provider.to_string();
        let id2 = id.clone();
        self.spawn(
            move || api::provider_options(&id),
            move |s, r, _| {
                s.prov_opts.insert(id2, r.unwrap_or(serde_json::Value::Null));
            },
        );
    }

    /// The same blacklist for a non-Claude provider: its catalogue entries (from
    /// /api/provider-options) minus `hiddenPiModels` (the pi catalogue list, shared by every
    /// pi-based provider) and the provider's own `hiddenModels`. An id hidden before models were
    /// qualified (`devstral` for `mistral/devstral`) still hides it. Entries are returned raw
    /// (callers pick alias / label / thinking).
    pub fn visible_provider_models(&self, provider: &str) -> Vec<serde_json::Value> {
        let info = self.providers.info(provider);
        let mut hidden = if info.engine() == "pi" { self.hidden_setting("hiddenPiModels") } else { Vec::new() };
        hidden.extend(info.hidden_models.clone().unwrap_or_default());
        self.opts_for(provider)["models"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|m| {
                let alias = m["alias"].as_str().or(m["name"].as_str()).unwrap_or("");
                let bare = alias.split_once('/').map(|(_, b)| b).unwrap_or(alias);
                !hidden.iter().any(|h| h == alias || h == bare)
            })
            .collect()
    }

    /// Provider filter cycle: all → each enabled provider → all. No-op with a single provider.
    pub fn cycle_provider_filter(&mut self) {
        self.provider_filter = next_provider_filter(self.provider_filter.as_deref(), &self.providers.enabled_ids());
    }

    /// Whether a module of the service is on (Settings → Modules, `settings.modules`). A module
    /// the settings do not name is on.
    pub fn module_on(&self, id: &str) -> bool {
        self.setting("modules")[id].as_bool() != Some(false)
    }

    /// Whether `page` can be shown: a page that belongs to a module needs that module on.
    pub fn page_on(&self, page: Page) -> bool {
        page_module(page).is_none_or(|m| self.module_on(m))
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
    /// Provider ('claude'/'pi') d'une session, cherché d'abord dans la liste, puis dans le
    /// détail chargé — sert aux libellés provider-aware (agent_label).
    pub fn provider_of(&self, id: &str) -> Option<&str> {
        self.sessions
            .iter()
            .find(|x| x.id == id)
            .and_then(|x| x.provider.as_deref())
            .or_else(|| {
                self.detail
                    .as_ref()
                    .filter(|d| d.session.id == id)
                    .and_then(|d| d.session.provider.as_deref())
            })
    }

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
        if card == "dock-shots"
            && let Some(d) = self.detail.clone()
        {
            self.want_media(&d, false);
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
        self.spawn(
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
            self.spawn(
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
        self.spawn(
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
        // A remote session names a folder of the other machine: nothing to launch in here.
        for s in self.sessions.iter().filter(|s| s.remote.is_none()) {
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

const ANNOUNCE_WINDOW_MS: i64 = 10 * 60_000;

/// `lastActivity` ignores SessionStart/SessionEnd, so a session that hooked only
/// restarted and resumed keeps its old timestamp and is not re-announced.
fn recently_active(s: &Session, now: i64) -> bool {
    fmt::age_ms(s.last_activity.as_deref(), now).is_some_and(|age| age < ANNOUNCE_WINDOW_MS)
}

/// The module of the service a page belongs to (modules/index.js on the server), if any.
pub fn page_module(page: Page) -> Option<&'static str> {
    match page {
        Page::Cron => Some("cron"),
        Page::Flows => Some("flows"),
        Page::GitHub => Some("github"),
        Page::Incidents => Some("incidents"),
        _ => None,
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

    #[test]
    fn only_recent_activity_is_announced() {
        let now = fmt::parse_ts("2026-11-11T12:00:00Z").unwrap();
        let at = |ts: Option<&str>| Session {
            last_activity: ts.map(str::to_string),
            ..Default::default()
        };
        assert!(recently_active(&at(Some("2026-11-11T11:58:00Z")), now));
        assert!(!recently_active(&at(Some("2026-11-08T09:00:00Z")), now));
        assert!(!recently_active(&at(None), now));
    }
}

impl Hooked {
    pub fn refresh_sessions(&self) {
        self.spawn(
            || (api::sessions_full(), api::session_meta().ok(), api::tags().ok()),
            |s, (r, meta, tags), _| match r {
                Ok((list, providers)) => {
                    if let Some(t) = tags {
                        s.tags = t;
                    }
                    // A single provider enabled → no picker, new_provider is pinned on it; a
                    // provider switched off since is dropped for the first enabled one.
                    if let Some(p) = pinned_provider(&providers) {
                        s.new_provider = p;
                    } else if !providers.is_enabled(&s.new_provider) {
                        if let Some(first) = providers.enabled_ids().into_iter().next() {
                            s.new_provider = first;
                        }
                    }
                    let ids = providers.enabled_ids();
                    s.providers = providers;
                    for id in ids {
                        s.ensure_opts(&id);
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
}

const LIST_DEBOUNCE: Duration = Duration::from_millis(250);
const LIST_MIN_GAP: Duration = Duration::from_secs(1);

/// Rereads the session list after `/api/stream` ticks, like the web's `scheduleRefresh`: a burst
/// becomes one fetch, at most one a second, and a tick that lands mid-fetch still gets one after.
fn refresh_on_ticks(h: AppHandle<Hooked>, ticks: std::sync::mpsc::Receiver<()>) {
    let mut last: Option<Instant> = None;
    while ticks.recv().is_ok() {
        let gap = last.map_or(Duration::ZERO, |t| LIST_MIN_GAP.saturating_sub(t.elapsed()));
        std::thread::sleep(LIST_DEBOUNCE.max(gap));
        while ticks.try_recv().is_ok() {}
        last = Some(Instant::now());
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
}

/// Follows `/api/stream` (a tick per hook event and transcript write, plus a heartbeat).
pub fn start_workers(h: Option<AppHandle<Hooked>>) {
    let Some(h) = h else {
        return;
    };
    let h2 = h.clone();
    let (tick, ticks) = std::sync::mpsc::channel();
    {
        let h = h.clone();
        crate::app::spawn_named("hooked-list-refresh", move || refresh_on_ticks(h, ticks));
    }
    {
        let tick = tick.clone();
        crate::app::spawn_named("hooked-remotes", move || crate::remote::run(tick));
    }
    crate::app::spawn_named("hooked-events", move || {
        loop {
            // The stream is tied to the address it was opened on: once Settings changes it, the
            // next event closes this one, and the loop opens another on the new address.
            let epoch = api::server_epoch();
            let r = api::follow("/api/stream", |payload| {
                if api::server_epoch() != epoch {
                    return false;
                }
                if payload.starts_with("{\"panel\"")
                    && let Ok(mut v) = serde_json::from_str::<serde_json::Value>(payload)
                    && v["panel"]["id"].is_string()
                {
                    let panel = v["panel"].take();
                    if panel["closed"] == true {
                        h.update(move |s, _| s.closed_panel(&panel));
                    } else {
                        h.update(move |s, _| s.show_panel(panel));
                    }
                    return true;
                }
                if payload.contains("\"spec\"")
                    && let Ok(v) = serde_json::from_str::<serde_json::Value>(payload)
                    && v["spec"]["query"].is_string()
                {
                    let spec = v["spec"].clone();
                    h.update(move |s, _| s.open_query_spec(spec));
                    return true;
                }
                let _ = tick.send(());
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
    crate::app::spawn_named("hooked-usage", move || {
        let h = h2;
        if let Ok(caps) = api::capabilities() {
            h.update(move |s, _| s.caps = caps);
        }
        loop {
            std::thread::sleep(Duration::from_secs(60));
            if let Ok((g, pi, raw)) = api::usage() {
                h.update(move |s, _| {
                    s.gauges = g;
                    s.pi_usage = pi;
                    s.provider_usage = api::parse_provider_usage(&raw);
                    s.usage = Some(raw);
                });
            }
        }
    });
}

/// The follow-up message that carries the notes, in the web dashboard's format: one line per
/// ticked option that has a note (the ticks say what, the note says why).
pub fn compose_notes(
    questions: &[api::Question],
    sel: &[BTreeSet<usize>],
    notes: &[(usize, usize, String)],
) -> String {
    let mut lines = Vec::new();
    for (qi, q) in questions.iter().enumerate() {
        let Some(ticked) = sel.get(qi) else { continue };
        for &oi in ticked {
            let note = notes
                .iter()
                .find(|(nq, no, _)| *nq == qi && *no == oi)
                .map(|(_, _, t)| t.trim())
                .unwrap_or("");
            if note.is_empty() {
                continue;
            }
            let label = q.options.get(oi).map_or("", |o| o.label.as_str());
            lines.push(format!("- «{label}» — {note}"));
        }
    }
    if lines.is_empty() {
        String::new()
    } else {
        format!("Notes on my selection:\n{}", lines.join("\n"))
    }
}

#[cfg(test)]
mod question_tests {
    use super::*;

    fn q(labels: &[&str], multi: bool) -> api::Question {
        api::Question {
            question: "Q".into(),
            header: None,
            multi_select: multi,
            options: labels
                .iter()
                .map(|l| api::QOption {
                    label: l.to_string(),
                    ..Default::default()
                })
                .collect(),
        }
    }

    #[test]
    fn notes_list_only_ticked_options_with_text() {
        let qs = [q(&["A", "B", "C"], true), q(&["X", "Y"], false)];
        let sel = [BTreeSet::from([0, 2]), BTreeSet::from([1])];
        let notes = [
            (0, 0, " keep it short ".to_string()),
            (0, 1, "not ticked".to_string()),
            (0, 2, "  ".to_string()),
            (1, 1, "because".to_string()),
        ];
        assert_eq!(
            compose_notes(&qs, &sel, &notes),
            "Notes on my selection:\n- «A» — keep it short\n- «Y» — because"
        );
        assert_eq!(compose_notes(&qs, &sel, &[]), "");
    }
}
