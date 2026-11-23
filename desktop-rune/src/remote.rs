//! Remote hooked instances: the sessions of other hooked services, listed next to the local ones.
//!
//! A feature of this app alone, off by default and kept in its local prefs (`remoteInstances`,
//! `remotes`): the hooked service knows nothing about it. The app is a plain HTTP client of each
//! instance, exactly as it is of the local one:
//!
//!   - listing: each instance's `/api/sessions` (+ tags and session meta) is polled by a worker
//!     and cached here; `api::sessions()` appends the cache to the local list, every remote
//!     session stamped with the [`Instance`] it runs on so the UI can never mistake it for a
//!     local one;
//!   - everything else: `api::get` / `post` / `follow` ask [`route`] where a request goes. One
//!     that names a remote session is sent to its instance, so the conversation, the live
//!     stream, replies, questions, plans and the Review lens need no per-call code.
//!
//! With the feature off, [`route`] answers `Local` without looking at the request and the merges
//! hand their input back untouched.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api::{Meta, Session};

/// At most this many instances: each one is polled.
pub const MAX_INSTANCES: usize = 4;
/// An unreachable instance keeps its last list this long, then its sessions leave the sidebar.
const KEEP: Duration = Duration::from_secs(30);

/// One other hooked service. `name` is what every one of its sessions is badged with.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Instance {
    pub name: String,
    pub url: String,
}

#[derive(Default)]
struct Cache {
    sessions: Vec<Session>,
    tags: HashMap<String, Vec<String>>,
    meta: HashMap<String, Meta>,
    ok_at: Option<Instant>,
    error: Option<String>,
    checked: bool,
}

impl Cache {
    fn usable(&self) -> bool {
        self.ok_at.is_some_and(|t| t.elapsed() <= KEEP)
    }
}

#[derive(Default)]
struct State {
    instances: Vec<Instance>,
    caches: HashMap<String, Cache>,
    /// Session id → the URL of its instance, from the last successful polls. Kept while the
    /// instance is unreachable, so a request for one of its sessions fails as "unreachable"
    /// instead of being answered by the local service with a misleading "session not found".
    owner: HashMap<String, String>,
}

static STATE: LazyLock<RwLock<State>> = LazyLock::new(Default::default);
/// Bumped by [`configure`], so the poll worker reacts at once instead of on its next round.
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn read() -> std::sync::RwLockReadGuard<'static, State> {
    STATE.read().unwrap_or_else(|e| e.into_inner())
}

fn write() -> std::sync::RwLockWriteGuard<'static, State> {
    STATE.write().unwrap_or_else(|e| e.into_inner())
}

/// What the prefs say: the feature switch and the instance list. Off empties everything.
pub fn configure(enabled: bool, list: &[Instance]) {
    let mut st = write();
    st.instances = if enabled {
        list.iter().take(MAX_INSTANCES).cloned().collect()
    } else {
        Vec::new()
    };
    let keep: HashSet<String> = st.instances.iter().map(|i| i.url.clone()).collect();
    st.caches.retain(|url, _| keep.contains(url));
    st.owner.retain(|_, url| keep.contains(url));
    drop(st);
    GENERATION.fetch_add(1, Ordering::Relaxed);
}

pub fn generation() -> u64 {
    GENERATION.load(Ordering::Relaxed)
}

pub fn enabled() -> bool {
    !read().instances.is_empty()
}

/// `http(s)://host[:port][/path]` without a trailing slash, or `None` for anything else.
pub fn normalize_url(raw: &str) -> Option<String> {
    let url = raw.trim().trim_end_matches('/');
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))?;
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() || url.chars().any(|c| c.is_whitespace() || c == '?' || c == '#') {
        return None;
    }
    Some(url.to_string())
}

/// The name shown when none was typed: the host, without its port.
pub fn default_name(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let host = rest.split('/').next().unwrap_or(rest);
    host.rsplit_once(':')
        .map_or(host, |(h, port)| {
            if port.chars().all(|c| c.is_ascii_digit()) {
                h
            } else {
                host
            }
        })
        .to_string()
}

/// Where a request goes.
#[derive(Debug, PartialEq)]
pub enum Route {
    Local,
    /// The base URL of the instance that owns the session the request names.
    Remote(String),
    /// Not something to do on another machine; the message is shown to the user.
    Refused(String),
}

/// Where a request names the session it is about. `resumeId` is the launch payload's: resuming
/// a remote session happens over there. A new session is always launched on the local service.
const ID_KEYS: [&str; 4] = ["id", "session", "sessionId", "resumeId"];
/// Bound to the machine the service runs on: a shell or an editor opened on the other host
/// would be out of reach. Writes are refused; reads stay local (this machine's shells for that
/// session, an empty list).
const MACHINE_BOUND: [&str; 3] = ["/api/terminal", "/api/open-editor", "/api/open-ghostty"];

fn query_ids(path: &str) -> impl Iterator<Item = &str> {
    path.split_once('?')
        .map_or("", |(_, q)| q)
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .filter(|(k, v)| ID_KEYS.contains(k) && !v.is_empty())
        .map(|(_, v)| v)
}

/// `body` is `None` for a read. Pure but for the owner map it consults.
pub fn route(path: &str, body: Option<&Value>) -> Route {
    let st = read();
    if st.owner.is_empty() {
        return Route::Local;
    }
    let owner = |id: &str| st.owner.get(id).map(String::as_str);
    let in_body = |key: &str| body.and_then(|b| b.get(key)).and_then(Value::as_str);
    // A group is stored by the instance that owns its sessions: both ends must be on one.
    if let (Some(id), Some(target)) = (in_body("id"), in_body("target"))
        && owner(id) != owner(target)
    {
        return Route::Refused("Sessions of different hooked instances cannot share a group".into());
    }
    let found = query_ids(path)
        .chain(ID_KEYS.iter().copied().filter_map(in_body))
        .find_map(owner);
    let Some(url) = found else {
        return Route::Local;
    };
    let bare = path.split('?').next().unwrap_or(path);
    if MACHINE_BOUND
        .iter()
        .any(|p| bare == *p || bare.starts_with(&format!("{p}/")))
    {
        return if body.is_none() {
            Route::Local
        } else {
            let name = st
                .instances
                .iter()
                .find(|i| i.url == url)
                .map_or(url, |i| i.name.as_str());
            Route::Refused(format!("Not available for a session of the remote hooked \"{name}\""))
        };
    }
    Route::Remote(url.to_string())
}

/// The instance a session runs on, `None` for a local one.
pub fn instance_of(id: &str) -> Option<Instance> {
    let st = read();
    let url = st.owner.get(id)?;
    st.instances.iter().find(|i| &i.url == url).cloned()
}

/// The local list followed by the cached remote sessions. A local session wins over a remote
/// one with the same id.
pub fn merge_sessions(mut local: Vec<Session>) -> Vec<Session> {
    let st = read();
    if st.instances.is_empty() {
        return local;
    }
    let known: HashSet<String> = local.iter().map(|s| s.id.clone()).collect();
    for inst in &st.instances {
        if let Some(c) = st.caches.get(&inst.url).filter(|c| c.usable()) {
            local.extend(c.sessions.iter().filter(|s| !known.contains(&s.id)).cloned());
        }
    }
    local
}

pub fn merge_tags(mut local: HashMap<String, Vec<String>>) -> HashMap<String, Vec<String>> {
    let st = read();
    for c in st.caches.values().filter(|c| c.usable()) {
        for (id, t) in &c.tags {
            local.entry(id.clone()).or_insert_with(|| t.clone());
        }
    }
    local
}

pub fn merge_meta(mut local: HashMap<String, Meta>) -> HashMap<String, Meta> {
    let st = read();
    for c in st.caches.values().filter(|c| c.usable()) {
        for (id, m) in &c.meta {
            local.entry(id.clone()).or_insert_with(|| m.clone());
        }
    }
    local
}

/// Keeps the entries of the instance's own sessions: its maps also hold what it tagged itself.
fn only<T>(map: HashMap<String, T>, ids: &HashSet<&str>) -> HashMap<String, T> {
    map.into_iter().filter(|(id, _)| ids.contains(id.as_str())).collect()
}

fn store_maps(c: &mut Cache, tags: Option<Value>, meta: Option<Value>) {
    let ids: HashSet<&str> = c.sessions.iter().map(|s| s.id.as_str()).collect();
    if let Some(t) = tags.and_then(|v| crate::api::decode::<HashMap<String, Vec<String>>>(v).ok()) {
        c.tags = only(t, &ids);
    }
    if let Some(m) = meta.and_then(|v| crate::api::decode::<HashMap<String, Meta>>(v).ok()) {
        c.meta = only(m, &ids);
    }
}

/// The tags and meta endpoints answer a write with their whole map: taken as the new cache, so
/// the change shows at once instead of on the next poll.
pub fn store_answer(base: &str, path: &str, answer: &Value) {
    let (tags, meta) = match path.split('?').next().unwrap_or(path) {
        "/api/tags" => (answer.get("tags").cloned(), None),
        "/api/session-meta" => (None, answer.get("meta").cloned()),
        _ => return,
    };
    if let Some(c) = write().caches.get_mut(base) {
        store_maps(c, tags, meta);
    }
}

/// Stamps what an instance listed. A session it got from a third instance is dropped.
fn stamp(list: Vec<Session>, inst: &Instance) -> Vec<Session> {
    list.into_iter()
        .filter(|s| !s.id.is_empty())
        .map(|mut s| {
            s.remote = Some(inst.clone());
            s
        })
        .collect()
}

/// One round over every instance. → whether anything the UI shows changed.
pub fn poll() -> bool {
    let instances = read().instances.clone();
    let mut changed = false;
    for inst in &instances {
        let fetched = crate::api::sessions_of(&inst.url).map(|list| {
            let get = |path: &str, key: &str| {
                crate::api::get_from(&inst.url, path)
                    .ok()
                    .and_then(|v| v.get(key).cloned())
            };
            (stamp(list, inst), get("/api/tags", "tags"), get("/api/session-meta", "meta"))
        });
        let mut guard = write();
        let st = &mut *guard;
        // Removed from the prefs while the request was in flight.
        if !st.instances.iter().any(|i| i.url == inst.url) {
            continue;
        }
        let was_usable = st.caches.get(&inst.url).is_some_and(Cache::usable);
        let c = st.caches.entry(inst.url.clone()).or_default();
        let before = (c.error.clone(), c.checked);
        c.checked = true;
        match fetched {
            Ok((sessions, tags, meta)) => {
                let (old_tags, old_meta) = (c.tags.clone(), c.meta.clone());
                changed |= !was_usable || c.sessions != sessions;
                c.sessions = sessions;
                store_maps(c, tags, meta);
                changed |= c.tags != old_tags || c.meta != old_meta;
                c.ok_at = Some(Instant::now());
                c.error = None;
                let ids: Vec<String> = c.sessions.iter().map(|s| s.id.clone()).collect();
                st.owner.retain(|_, url| url != &inst.url);
                for id in ids {
                    st.owner.insert(id, inst.url.clone());
                }
            }
            Err(e) => {
                c.error = Some(e);
                // Its sessions just aged out of the list.
                changed |= was_usable && !c.usable();
            }
        }
        let c = &st.caches[&inst.url];
        changed |= before != (c.error.clone(), c.checked);
    }
    changed
}

/// The Settings line of an instance.
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Checking,
    Ok(usize),
    Unreachable(String),
}

/// The cause alone, out of a transport error: `io: No route to host (os error 65)` reads
/// `No route to host`.
pub fn brief_error(e: &str) -> String {
    let cause = e.rsplit(": ").next().unwrap_or(e).trim();
    let cause = cause.split(" (os error").next().unwrap_or(cause).trim();
    if cause.is_empty() { e.to_string() } else { cause.to_string() }
}

/// macOS answers "No route to host" for an address of the local network when the app has not
/// been allowed on it (System Settings → Privacy & Security → Local Network), which is how a
/// LAN instance that `curl` reaches fine looks from here until the prompt is accepted.
pub fn local_network_blocked(e: &str) -> bool {
    cfg!(target_os = "macos") && e.contains("No route to host")
}

pub fn status(url: &str) -> Status {
    match read().caches.get(url) {
        Some(c) if c.checked => match &c.error {
            None => Status::Ok(c.sessions.len()),
            Some(e) => Status::Unreachable(e.clone()),
        },
        _ => Status::Checking,
    }
}

/// A first round at launch, waited for briefly: an instance that answers at once is in the
/// first frame (and a remote session the app reopens on finds its owner), a slow one shows up
/// when the worker gets it. Returns at once when the feature is off.
pub fn first_poll(budget: Duration) {
    if !enabled() {
        return;
    }
    let (done, wait) = std::sync::mpsc::channel();
    crate::app::spawn_named("hooked-remotes-first", move || {
        poll();
        let _ = done.send(());
    });
    let _ = wait.recv_timeout(budget);
}

/// The poll worker: a round every three seconds while the feature is on, and at once when the
/// prefs change. A tick makes the app reread its session list, which then merges the new cache.
pub fn run(tick: std::sync::mpsc::Sender<()>) {
    loop {
        let seen = generation();
        if enabled() && poll() && tick.send(()).is_err() {
            return;
        }
        for _ in 0..12 {
            std::thread::sleep(Duration::from_millis(250));
            if generation() != seen {
                break;
            }
        }
    }
}

impl crate::app::Hooked {
    fn apply_remotes(&mut self) {
        configure(self.remote_on, &self.remotes);
        self.refresh_sessions();
    }

    pub fn set_remote_enabled(&mut self, on: bool) {
        self.remote_on = on;
        self.save_pref("remoteInstances", &on);
        self.apply_remotes();
    }

    /// Adds what the Settings form holds; an unnamed instance is named after its host.
    pub fn add_remote(&mut self) {
        let Some(url) = normalize_url(&self.pages.remote_url.text) else {
            self.flash("✗ Expected a URL such as http://host:4123", true);
            return;
        };
        if self.remotes.iter().any(|i| i.url == url) {
            self.flash("✗ This instance is already listed", true);
            return;
        }
        if self.remotes.len() >= MAX_INSTANCES {
            self.flash(format!("✗ At most {MAX_INSTANCES} remote instances"), true);
            return;
        }
        let name: String = self.pages.remote_name.text.trim().chars().take(32).collect();
        let name = if name.is_empty() { default_name(&url) } else { name };
        self.remotes.push(Instance { name, url });
        self.pages.remote_name = rune::TextEdit::new("");
        self.pages.remote_url = rune::TextEdit::new("");
        let list = self.remotes.clone();
        self.save_pref("remotes", &list);
        self.apply_remotes();
    }

    pub fn remove_remote(&mut self, url: &str) {
        self.remotes.retain(|i| i.url != url);
        let list = self.remotes.clone();
        self.save_pref("remotes", &list);
        self.apply_remotes();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The state is process-wide: the tests that touch it run one at a time.
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn seed(sessions: &[(&str, &str)]) {
        let mut st = write();
        *st = State::default();
        for (id, url) in sessions {
            let inst = Instance { name: default_name(url), url: (*url).to_string() };
            if !st.instances.contains(&inst) {
                st.instances.push(inst.clone());
            }
            let c = st.caches.entry(inst.url.clone()).or_default();
            c.sessions.push(Session { id: (*id).to_string(), remote: Some(inst.clone()), ..Default::default() });
            c.ok_at = Some(Instant::now());
            c.checked = true;
            st.owner.insert((*id).to_string(), inst.url.clone());
        }
    }

    const A: &str = "http://mini.lan:4123";
    const B: &str = "http://box:4123";

    #[test]
    fn off_routes_everything_locally_and_merges_nothing() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        seed(&[("r-1", A)]);
        configure(false, &[Instance { name: "mini".into(), url: A.into() }]);
        assert!(!enabled());
        assert_eq!(route("/api/session?id=r-1", None), Route::Local);
        assert_eq!(route("/api/reply", Some(&json!({ "id": "r-1", "text": "hi" }))), Route::Local);
        let local = vec![Session { id: "l-1".into(), ..Default::default() }];
        assert_eq!(merge_sessions(local.clone()), local);
        assert!(merge_tags(HashMap::new()).is_empty());
        assert!(merge_meta(HashMap::new()).is_empty());
        assert_eq!(instance_of("r-1"), None);
    }

    #[test]
    fn a_request_naming_a_remote_session_goes_to_its_instance() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        seed(&[("r-1", A), ("r-2", B)]);
        assert_eq!(route("/api/session?id=r-1", None), Route::Remote(A.into()));
        assert_eq!(route("/api/user-file?session=r-2&agent=&path=%2Fx", None), Route::Remote(B.into()));
        assert_eq!(route("/api/session/stream?id=r-1", None), Route::Remote(A.into()));
        assert_eq!(route("/api/reply", Some(&json!({ "id": "r-2", "text": "go" }))), Route::Remote(B.into()));
        assert_eq!(route("/api/launch", Some(&json!({ "resumeId": "r-1", "prompt": "" }))), Route::Remote(A.into()));
        assert_eq!(route("/api/tags", Some(&json!({ "id": "r-1", "tags": ["x"] }))), Route::Remote(A.into()));
    }

    #[test]
    fn local_and_session_less_requests_stay_local() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        seed(&[("r-1", A)]);
        assert_eq!(route("/api/session?id=l-1", None), Route::Local);
        assert_eq!(route("/api/sessions", None), Route::Local);
        assert_eq!(route("/api/stats?range=7d", None), Route::Local);
        assert_eq!(route("/api/launch", Some(&json!({ "cwd": "/x", "prompt": "p", "groupWith": "r-1" }))), Route::Local);
        // a terminal id is not a session id
        assert_eq!(route("/api/terminal/input", Some(&json!({ "id": "t-9", "data": "ls" }))), Route::Local);
    }

    #[test]
    fn what_is_bound_to_a_machine_is_refused_not_forwarded() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        seed(&[("r-1", A)]);
        for (path, body) in [
            ("/api/terminal", json!({ "cwd": "/srv", "sessionId": "r-1" })),
            ("/api/open-editor", json!({ "id": "r-1" })),
            ("/api/open-ghostty", json!({ "id": "r-1" })),
        ] {
            assert!(matches!(route(path, Some(&body)), Route::Refused(why) if why.contains("mini.lan")));
        }
        // listing this machine's shells for that session is a local read
        assert_eq!(route("/api/terminal?sessionId=r-1", None), Route::Local);
    }

    #[test]
    fn a_group_cannot_span_two_instances() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        seed(&[("r-1", A), ("r-2", A), ("r-3", B)]);
        let join = |id: &str, target: &str| route("/api/session-meta", Some(&json!({ "op": "join", "id": id, "target": target })));
        assert_eq!(join("r-1", "r-2"), Route::Remote(A.into()));
        assert_eq!(join("l-1", "l-2"), Route::Local);
        assert!(matches!(join("l-1", "r-1"), Route::Refused(_)));
        assert!(matches!(join("r-1", "l-1"), Route::Refused(_)));
        assert!(matches!(join("r-1", "r-3"), Route::Refused(_)));
    }

    #[test]
    fn remote_sessions_follow_the_local_ones_and_never_shadow_them() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        seed(&[("r-1", A), ("both", A)]);
        let local = vec![Session { id: "both".into(), title: Some("local copy".into()), ..Default::default() }];
        let merged = merge_sessions(local);
        assert_eq!(merged.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["both", "r-1"]);
        assert_eq!(merged[0].title.as_deref(), Some("local copy"));
        assert_eq!(merged[0].remote, None);
        assert_eq!(merged[1].remote.as_ref().map(|i| i.url.as_str()), Some(A));
    }

    #[test]
    fn a_write_answer_refreshes_the_cached_map_of_listed_sessions_only() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        seed(&[("r-1", A)]);
        store_answer(A, "/api/tags", &json!({ "ok": true, "tags": { "r-1": ["prod"], "elsewhere": ["leak"] } }));
        let tags = merge_tags(HashMap::from([("l-1".to_string(), vec!["mine".to_string()])]));
        assert_eq!(tags.get("r-1"), Some(&vec!["prod".to_string()]));
        assert_eq!(tags.get("l-1"), Some(&vec!["mine".to_string()]));
        assert!(!tags.contains_key("elsewhere"));
        store_answer(A, "/api/session-meta", &json!({ "ok": true, "meta": { "r-1": { "archived": true } } }));
        assert!(merge_meta(HashMap::new())["r-1"].archived);
    }

    #[test]
    fn a_transport_error_is_cut_down_to_its_cause() {
        let e = "io: No route to host (os error 65)";
        assert_eq!(brief_error(e), "No route to host");
        assert_eq!(brief_error("HTTP 502"), "HTTP 502");
        assert_eq!(brief_error(""), "");
        assert_eq!(local_network_blocked(e), cfg!(target_os = "macos"));
        assert!(!local_network_blocked(
            "io: Connection refused (os error 61)"
        ));
    }

    #[test]
    fn urls_are_checked_and_named() {
        assert_eq!(normalize_url(" http://mini.lan:4123/ ").as_deref(), Some("http://mini.lan:4123"));
        assert_eq!(normalize_url("https://hooked.example.com").as_deref(), Some("https://hooked.example.com"));
        assert_eq!(normalize_url("ftp://x"), None);
        assert_eq!(normalize_url("mini.lan:4123"), None);
        assert_eq!(normalize_url("http://"), None);
        assert_eq!(normalize_url("http://a b"), None);
        assert_eq!(default_name("http://mini.lan:4123"), "mini.lan");
        assert_eq!(default_name("https://hooked.example.com/x"), "hooked.example.com");
    }
}
