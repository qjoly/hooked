use std::io::{BufRead, BufReader, Read};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use ureq::config::ConfigBuilder;
use ureq::http::Response;
use ureq::typestate::AgentScope;
use ureq::{Agent, Body};

pub fn base() -> String {
    std::env::var("HOOKED_URL").unwrap_or_else(|_| "http://localhost:4123".into())
}

fn agent() -> Agent {
    config()
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .into()
}

/// hooked runs on this machine or the LAN, so a proxy from the environment stays out of the way.
/// A 4xx/5xx comes back as a response: its JSON body says why.
fn config() -> ConfigBuilder<AgentScope> {
    Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(3)))
        .proxy(None)
        .http_status_as_error(false)
}

pub fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The URL a request goes to: the local service, unless it names a session of a remote hooked
/// instance (`crate::remote`, off by default), which is then asked directly. The second value
/// is that instance's base URL.
fn target(path: &str, body: Option<&Value>) -> Result<(String, Option<String>), String> {
    match crate::remote::route(path, body) {
        crate::remote::Route::Local => Ok((format!("{}{path}", base()), None)),
        crate::remote::Route::Remote(b) => Ok((format!("{b}{path}"), Some(b))),
        crate::remote::Route::Refused(why) => Err(why),
    }
}

/// The base URL of the service a session runs on, for links that open it in a browser.
pub fn base_of(session: &str) -> String {
    crate::remote::instance_of(session).map_or_else(base, |i| i.url)
}

pub fn get(path: &str) -> Result<Value, String> {
    let (url, _) = target(path, None)?;
    read(agent().get(&url).call())
}

/// A read from one given service, whatever the path names: how a remote instance is polled.
pub fn get_from(base: &str, path: &str) -> Result<Value, String> {
    let a: Agent = config()
        .timeout_global(Some(Duration::from_secs(8)))
        .build()
        .into();
    read(a.get(&format!("{base}{path}")).call())
}

pub fn bytes(path: &str) -> Result<Vec<u8>, String> {
    let (url, _) = target(path, None)?;
    let resp = success(agent().get(&url).call())?;
    let mut out = Vec::new();
    resp.into_body()
        .into_reader()
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// The JSON body whatever the status, for endpoints that explain a refusal in it.
pub fn post_any(path: &str, body: Value) -> Result<Value, String> {
    let (url, _) = target(path, Some(&body))?;
    json(
        agent()
            .post(&url)
            .send_json(body)
            .map_err(|e| e.to_string())?,
    )
}

pub fn post(path: &str, body: Value) -> Result<Value, String> {
    let (url, remote) = target(path, Some(&body))?;
    let r = read(agent().post(&url).send_json(body));
    if let (Some(base), Ok(v)) = (&remote, &r) {
        crate::remote::store_answer(base, path, v);
    }
    r
}

fn read(r: Result<Response<Body>, ureq::Error>) -> Result<Value, String> {
    let resp = r.map_err(|e| e.to_string())?;
    match resp.status().as_u16() {
        code @ 400.. => {
            let v = json(resp).unwrap_or(Value::Null);
            Err(v
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("HTTP {code}")))
        }
        _ => {
            let v = json(resp)?;
            if v.get("ok") == Some(&Value::Bool(false)) {
                return Err(v
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("request failed")
                    .to_string());
            }
            Ok(v)
        }
    }
}

/// The response, or its status as the error when its body is of no use to the caller.
fn success(r: Result<Response<Body>, ureq::Error>) -> Result<Response<Body>, String> {
    let resp = r.map_err(|e| e.to_string())?;
    match resp.status().as_u16() {
        code @ 400.. => Err(format!("HTTP {code}")),
        _ => Ok(resp),
    }
}

/// ureq caps a body it reads at 10 MB, and a long conversation or a CI log can be larger.
fn json(resp: Response<Body>) -> Result<Value, String> {
    resp.into_body()
        .into_with_config()
        .limit(u64::MAX)
        .read_json()
        .map_err(|e| e.to_string())
}

pub fn follow(path: &str, mut on_data: impl FnMut(&str) -> bool) -> Result<(), String> {
    let a: Agent = config()
        .timeout_per_read(Some(Duration::from_secs(45)))
        .build()
        .into();
    let (url, _) = target(path, None)?;
    let resp = success(a.get(&url).header("Accept", "text/event-stream").call())?;
    for line in BufReader::new(resp.into_body().into_reader()).lines() {
        let line = line.map_err(|e| e.to_string())?;
        if let Some(d) = line.strip_prefix("data:")
            && !on_data(d.trim())
        {
            return Ok(());
        }
    }
    Ok(())
}

/// `#[serde(default)]` covers a missing key, not an explicit `null`, and the server sends both.
fn strip_nulls(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.retain(|_, x| !x.is_null());
            m.values_mut().for_each(strip_nulls);
        }
        Value::Array(a) => a.iter_mut().for_each(strip_nulls),
        _ => {}
    }
}

pub fn decode<T: serde::de::DeserializeOwned>(mut v: Value) -> Result<T, String> {
    strip_nulls(&mut v);
    serde_json::from_value(v).map_err(|e| e.to_string())
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct TodoSummary {
    pub total: u32,
    pub done: u32,
    pub current: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct CacheInfo {
    pub last_request_at: Option<String>,
    pub ttl: Option<String>,
    pub context_tokens: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub title: Option<String>,
    pub project: Option<String>,
    pub project_name: Option<String>,
    pub repo: Option<String>,
    pub git_branch: Option<String>,
    pub worktree_of: Option<String>,
    pub state: String,
    pub live: bool,
    pub activity: Option<String>,
    pub current_tool: Option<String>,
    pub last_activity: Option<String>,
    pub last_seen_ts: Option<String>,
    pub last_prompt: Option<String>,
    pub last_reply: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub cost: Option<f64>,
    pub has_question: bool,
    pub has_plan: bool,
    pub question: Option<Value>,
    pub followup: Option<String>,
    pub todo: Option<TodoSummary>,
    pub cache: Option<CacheInfo>,
    /// Agent provider of the session: a provider id of the server's settings ("claude", "pi",
    /// or a custom one such as "mistral" / "gemini" — see `ProviderInfo`).
    pub provider: Option<String>,
    /// The remote hooked instance the session runs on (`crate::remote`), `None` for a local
    /// one. Set by this app when it lists an instance, never read from the wire.
    #[serde(skip)]
    pub remote: Option<crate::remote::Instance>,
}

impl Session {
    pub fn display_title(&self) -> String {
        let t = self
            .title
            .as_deref()
            .filter(|t| !t.is_empty() && *t != "(sans titre)");
        t.or(self.last_prompt.as_deref())
            .or(self.project_name.as_deref())
            .unwrap_or("(untitled)")
            .to_string()
    }

    pub fn needs_you(&self) -> bool {
        self.has_question || self.has_plan || self.state == "attention" || self.state == "waiting"
    }

    /// What the session is filed under in the lists. A remote one gets a label of its own
    /// (« repo @ instance »): the same repository cloned on two machines is two working
    /// copies, and a local project section must never hold a remote session.
    pub fn project_label(&self) -> String {
        let label = self
            .repo
            .clone()
            .or_else(|| self.project_name.clone())
            .unwrap_or_else(|| "?".into());
        match &self.remote {
            Some(r) => format!("{label} @ {}", r.name),
            None => label,
        }
    }
}

/// One provider as the server describes it (`providerList` of /api/sessions, cf.
/// server/providers.js and docs/providers.md): label, badge, colour, engine and capabilities.
/// Built-ins are `claude` (Claude Code, Agent SDK) and `pi` (pi coding agent); every other id
/// is a provider declared in the hooked settings (an ACP agent, a pi narrowed to some models…).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub engine: Option<String>,
    pub label: String,
    pub short: String,
    /// `#rrggbb` set in the settings, if any.
    pub color: Option<String>,
    pub enabled: bool,
    /// Which flavour of the MCP lens applies: "claude", "pi", or none.
    pub mcp_kind: Option<String>,
    pub hidden_models: Option<Vec<String>>,
    pub capabilities: std::collections::HashMap<String, bool>,
}

// Capabilities of the built-in engines, used before the server's list arrives (or with an
// older server that sends none). Mirrors server/engines/{claude,pi}.js.
const PI_CAPS: &[&str] = &[
    "models", "effort", "resume", "fork", "forkAtMessage", "worktree", "trace", "search", "trash",
    "promptCache", "commands", "skills", "mcp",
];

impl ProviderInfo {
    /// Defaults for a provider the server did not describe: the built-ins, or a neutral entry
    /// whose label comes from the id (a session of a provider removed from the settings).
    pub fn fallback(id: &str) -> Self {
        let mut p = ProviderInfo { id: id.to_string(), enabled: true, ..Default::default() };
        match id {
            "claude" => {
                p.engine = Some("claude".into());
                p.label = "Claude".into();
                p.short = "cc".into();
                p.mcp_kind = Some("claude".into());
            }
            "pi" => {
                p.engine = Some("pi".into());
                p.label = "Pi".into();
                p.short = "pi".into();
                p.mcp_kind = Some("pi".into());
                p.capabilities = PI_CAPS.iter().map(|c| (c.to_string(), true)).collect();
            }
            _ => {
                p.label = id
                    .split('-')
                    .map(|w| {
                        let mut c = w.chars();
                        c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
                    })
                    .collect::<Vec<String>>()
                    .join(" ");
                p.short = id.chars().take(2).collect();
            }
        }
        p
    }

    /// The engine behind it: "claude", "pi", "acp", or an external engine id.
    pub fn engine(&self) -> &str {
        self.engine.as_deref().unwrap_or(if self.id == "pi" { "pi" } else if self.id == "claude" { "claude" } else { "" })
    }

    pub fn is_claude(&self) -> bool {
        self.engine() == "claude"
    }

    /// Does this provider support `cap`? (keys of CAPABILITY_KEYS in server/providerConfig.js)
    /// Claude Code has them all, whatever the server sent.
    pub fn can(&self, cap: &str) -> bool {
        self.is_claude() || self.capabilities.get(cap).copied().unwrap_or(false)
    }
}

// Last provider list read from the server, for the display helpers that have no access to the
// app state (fmt::agent_label…). Remote instances may know providers this one does not: those
// fall back to ProviderInfo::fallback.
static PROVIDER_LIST: std::sync::RwLock<Vec<ProviderInfo>> = std::sync::RwLock::new(Vec::new());

/// What the MCP lens sends as `provider` for a session of provider `id`: "pi" for any pi-based
/// provider (pi's mcp.json flavour), None for Claude Code, the id itself otherwise (the server
/// answers an agent that keeps its MCP config to itself with an empty list).
pub fn mcp_param(id: Option<&str>) -> Option<String> {
    let info = provider_info(id);
    match info.mcp_kind.as_deref() {
        Some("pi") => Some("pi".into()),
        Some("claude") => None,
        _ if info.is_claude() => None,
        _ => Some(info.id),
    }
}

/// Descriptor of provider `id` (None = claude).
pub fn provider_info(id: Option<&str>) -> ProviderInfo {
    let id = id.unwrap_or("claude");
    PROVIDER_LIST
        .read()
        .ok()
        .and_then(|l| l.iter().find(|p| p.id == id).cloned())
        .unwrap_or_else(|| ProviderInfo::fallback(id))
}

/// Which providers this hooked can launch on (from /api/sessions): enabled flags + descriptors.
/// `claude` / `pi` stay as fields (the historical shape); custom providers live in `list`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Providers {
    pub claude: bool,
    pub pi: bool,
    /// Every provider in settings order, with its `enabled` flag and descriptor.
    pub list: Vec<ProviderInfo>,
}

impl Providers {
    /// Builds the set from the `providers` map ({ id: enabled }) and the optional `providerList`.
    pub fn from_wire(enabled: &serde_json::Map<String, Value>, list: Option<Vec<ProviderInfo>>) -> Self {
        let on = |id: &str| enabled.get(id).and_then(Value::as_bool).unwrap_or(false);
        let list = match list {
            Some(l) if !l.is_empty() => l
                .into_iter()
                .map(|mut p| {
                    p.enabled = on(&p.id);
                    p
                })
                .collect(),
            _ => {
                // Older server: only the map. Built-ins first, then the others in key order.
                let mut ids: Vec<&String> = enabled.keys().collect();
                ids.sort_by_key(|k| (k.as_str() != "claude", k.as_str() != "pi", k.as_str().to_string()));
                ids.into_iter()
                    .map(|id| {
                        let mut p = ProviderInfo::fallback(id);
                        p.enabled = on(id);
                        p
                    })
                    .collect()
            }
        };
        Providers { claude: on("claude"), pi: on("pi"), list }
    }

    /// Two providers only (tests).
    #[cfg(test)]
    pub fn pair(claude: bool, pi: bool) -> Self {
        let mut m = serde_json::Map::new();
        m.insert("claude".into(), Value::Bool(claude));
        m.insert("pi".into(), Value::Bool(pi));
        Self::from_wire(&m, None)
    }

    /// Ids of the enabled providers, in settings order.
    pub fn enabled_ids(&self) -> Vec<String> {
        self.list.iter().filter(|p| p.enabled).map(|p| p.id.clone()).collect()
    }

    pub fn is_enabled(&self, id: &str) -> bool {
        self.list.iter().any(|p| p.id == id && p.enabled)
    }

    /// Descriptor of `id` (fallback when the server did not describe it).
    pub fn info(&self, id: &str) -> ProviderInfo {
        self.list.iter().find(|p| p.id == id).cloned().unwrap_or_else(|| ProviderInfo::fallback(id))
    }

    /// More than one provider enabled: only then do badges, the picker and the provider filter
    /// tell anything (with a single one they would not).
    pub fn both(&self) -> bool {
        self.list.iter().filter(|p| p.enabled).count() > 1
    }

    /// With a single provider enabled there is nothing to choose: it is the one to use.
    /// `None` when several (or none) are.
    pub fn only(&self) -> Option<String> {
        let ids = self.enabled_ids();
        if ids.len() == 1 { ids.into_iter().next() } else { None }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
struct SessionsPayload {
    #[serde(default)]
    sessions: Vec<Session>,
    #[serde(default)]
    providers: Option<serde_json::Map<String, Value>>,
    #[serde(default, rename = "providerList")]
    provider_list: Option<Vec<ProviderInfo>>,
}

fn session_list(v: Value) -> Result<Vec<Session>, String> {
    let p: SessionsPayload = decode(v)?;
    Ok(p.sessions
        .into_iter()
        .filter(|s| !s.id.is_empty())
        .collect())
}

/// The local sessions, then those of the remote instances when that feature is on.
/// Sessions + the providers of this hooked, in one call (the payload carries both).
pub fn sessions_full() -> Result<(Vec<Session>, Providers), String> {
    let v = get("/api/sessions")?;
    let p: SessionsPayload = decode(v)?;
    let providers = Providers::from_wire(&p.providers.unwrap_or_default(), p.provider_list);
    if let Ok(mut g) = PROVIDER_LIST.write() {
        *g = providers.list.clone();
    }
    Ok((
        crate::remote::merge_sessions(p.sessions.into_iter().filter(|s| !s.id.is_empty()).collect()),
        providers,
    ))
}

pub fn sessions() -> Result<Vec<Session>, String> {
    Ok(crate::remote::merge_sessions(session_list(get("/api/sessions")?)?))
}

/// What one remote instance lists.
pub fn sessions_of(base: &str) -> Result<Vec<Session>, String> {
    session_list(get_from(base, "/api/sessions")?)
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Meta {
    pub archived: bool,
    pub incognito: bool,
    pub group_of: Option<String>,
    pub group_at: Option<Value>,
    pub group_name: Option<String>,
    pub snooze_until: Option<f64>,
}

pub fn session_meta() -> Result<std::collections::HashMap<String, Meta>, String> {
    let v = get("/api/session-meta")?;
    decode(
        v.get("meta")
            .cloned()
            .unwrap_or(Value::Object(Default::default())),
    )
    .map(crate::remote::merge_meta)
}

pub fn patch_meta(id: &str, mut patch: Value) -> Result<(), String> {
    patch["id"] = json!(id);
    post("/api/session-meta", patch).map(|_| ())
}

pub fn group_op(op: &str, id: &str, extra: Value) -> Result<(), String> {
    let mut body = json!({ "op": op, "id": id });
    if let (Some(b), Some(e)) = (body.as_object_mut(), extra.as_object()) {
        b.extend(e.clone());
    }
    post("/api/session-meta", body).map(|_| ())
}

pub fn tags() -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    decode(get("/api/tags")?.get("tags").cloned().unwrap_or(json!({}))).map(crate::remote::merge_tags)
}

pub fn save_tags(id: &str, tags: &[String]) -> Result<(), String> {
    post("/api/tags", json!({ "id": id, "tags": tags })).map(|_| ())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkRequest {
    pub fork_uuid: String,
    pub prompt: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
}

pub fn fork(id: &str, req: &ForkRequest) -> Result<String, String> {
    let mut body = serde_json::to_value(req).map_err(|e| e.to_string())?;
    body["id"] = json!(id);
    let v = post("/api/fork", body)?;
    v["sessionId"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "the fork returned no session id".into())
}

pub fn set_archived(id: &str, archived: bool) -> Result<(), String> {
    post(
        "/api/session-meta",
        json!({ "id": id, "archived": archived }),
    )
    .map(|_| ())
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Tool {
    pub id: Option<String>,
    pub name: String,
    pub detail: Option<String>,
    pub input_text: Option<String>,
    pub result: Option<Value>,
    #[serde(skip)]
    pub send: Option<Value>,
    #[serde(skip)]
    pub show: Option<Value>,
    #[serde(skip)]
    pub diff: Option<Value>,
}

impl Tool {
    pub fn result_text(&self) -> Option<String> {
        match &self.result {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(v) => Some(serde_json::to_string_pretty(v).unwrap_or_default()),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    Text(String),
    /// Model reasoning (non-Claude engines), kept in order with the text and tool calls.
    Thinking(String),
    Tool(Tool),
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
struct RawPart {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
    tool: Option<Tool>,
    send: Option<Value>,
    show: Option<Value>,
    diff: Option<Value>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Message {
    pub role: String,
    pub ts: Option<String>,
    pub text: String,
    pub tools: Vec<Tool>,
    parts: Vec<RawPart>,
    pub kind: Option<String>,
    pub auto: bool,
    pub fork_uuid: Option<String>,
    pub truncated: bool,
}

impl Message {
    pub fn render_parts(&self) -> Vec<Part> {
        let parts: Vec<Part> = self
            .parts
            .iter()
            .filter_map(|p| match p.kind.as_str() {
                "text" => p
                    .text
                    .clone()
                    .filter(|t| !t.trim().is_empty())
                    .map(Part::Text),
                "thinking" => p
                    .text
                    .clone()
                    .filter(|t| !t.trim().is_empty())
                    .map(Part::Thinking),
                "tool" => p.tool.clone().map(|mut t| {
                    t.send = p.send.clone();
                    t.show = p.show.clone();
                    t.diff = p
                        .diff
                        .clone()
                        .filter(|d| d["ops"].as_array().is_some_and(|o| !o.is_empty()));
                    Part::Tool(t)
                }),
                _ => None,
            })
            .collect();
        if !parts.is_empty() {
            return parts;
        }
        let mut out = Vec::new();
        if !self.text.trim().is_empty() {
            out.push(Part::Text(self.text.clone()));
        }
        out.extend(self.tools.iter().cloned().map(Part::Tool));
        out
    }
}

const IMAGE_EXTS: [&str; 5] = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

fn is_image_name(p: &str) -> bool {
    let l = p.to_lowercase();
    IMAGE_EXTS.iter().any(|e| l.ends_with(e))
}

/// Pasted images reach the transcript as absolute paths under hooked's images dir, written into
/// the prompt text; this splits them out, as the web's `splitMessageImages`.
pub fn split_message_images(text: &str) -> (Vec<String>, String) {
    let mut images = Vec::new();
    let mut rest = String::with_capacity(text.len());
    for piece in text.split_inclusive(char::is_whitespace) {
        let word = piece.trim_end();
        if word.starts_with('/') && word.contains("/images/") && is_image_name(word) {
            images.push(word.to_string());
            rest.push_str(&piece[word.len()..]);
        } else {
            rest.push_str(piece);
        }
    }
    (images, rest.trim().to_string())
}

/// `shots` caps the screenshots to the newest ones, as the dock shows them.
pub fn media_refs(d: &Detail, shots: usize) -> Vec<(String, String)> {
    let user_file = |p: &str| {
        format!(
            "/api/user-file?session={}&agent=&path={}",
            enc(&d.session.id),
            enc(p)
        )
    };
    let mut out = Vec::new();
    for m in &d.messages {
        if m.role == "user" {
            for p in split_message_images(&m.text).0 {
                // No session in this endpoint's own query: naming a remote one sends the read
                // to its instance, which holds the file.
                let owner = d
                    .session
                    .remote
                    .as_ref()
                    .map(|_| format!("&id={}", enc(&d.session.id)))
                    .unwrap_or_default();
                out.push((p.clone(), format!("/api/image?path={}{owner}", enc(&p))));
            }
        }
        for part in m.render_parts() {
            let Part::Tool(t) = part else { continue };
            for p in tool_media(&t) {
                out.push((p.clone(), user_file(&p)));
            }
        }
    }
    let mut newest: Vec<&Value> = d.screenshots.iter().collect();
    newest.sort_by(|a, b| b["ts"].as_str().unwrap_or("").cmp(a["ts"].as_str().unwrap_or("")));
    for shot in newest.into_iter().take(shots) {
        if let Some(p) = shot["path"].as_str() {
            out.push((
                p.to_string(),
                format!(
                    "/api/screenshot?session={}&path={}",
                    enc(&d.session.id),
                    enc(p)
                ),
            ));
        }
    }
    out
}

pub fn tool_media(t: &Tool) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(files) = t.send.as_ref().and_then(|s| s["files"].as_array()) {
        for f in files {
            if f["kind"] == "image"
                && let Some(p) = f["path"].as_str()
            {
                out.push(p.to_string());
            }
        }
    }
    if let Some(show) = t.show.as_ref().filter(|s| s["kind"] == "image") {
        for key in ["compare", "path"] {
            if let Some(p) = show[key].as_str().filter(|p| !p.is_empty()) {
                out.push(p.to_string());
            }
        }
    }
    out
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct QOption {
    pub label: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Question {
    pub question: String,
    pub header: Option<String>,
    pub multi_select: bool,
    pub options: Vec<QOption>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct PendingQuestion {
    pub id: String,
    pub kind: Option<String>,
    pub tool_name: Option<String>,
    pub questions: Vec<Question>,
}

impl PendingQuestion {
    pub fn is_permission(&self) -> bool {
        self.kind.as_deref() == Some("permission")
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct PendingPlan {
    pub id: String,
    pub plan: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Todo {
    pub content: String,
    pub status: String,
    pub active_form: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Change {
    pub file: String,
    pub name: Option<String>,
    pub badge: Option<String>,
    /// The tool that made the change: `Bash` for a file a shell command wrote.
    pub tool: Option<String>,
    /// No text to diff on one side or the other.
    pub binary: bool,
    pub ops: Vec<Value>,
    pub raw_ops: Vec<Value>,
    pub original: Option<String>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ChangeTurn {
    pub turn: usize,
    pub ts: String,
    pub prompt: String,
}

impl Change {
    pub fn label(&self) -> String {
        self.name.clone().unwrap_or_else(|| {
            self.file
                .rsplit('/')
                .next()
                .unwrap_or(&self.file)
                .to_string()
        })
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SubSession {
    pub id: String,
    pub label: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Context {
    pub pct: Option<f64>,
    pub size: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Detail {
    #[serde(flatten)]
    pub session: Session,
    pub messages: Vec<Message>,
    pub pending_question: Option<PendingQuestion>,
    pub pending_plan: Option<PendingPlan>,
    pub pending_lead_in: Option<String>,
    pub permission_mode: Option<String>,
    pub auto_approve: bool,
    pub followup_suggestion: Option<String>,
    pub todos: Vec<Todo>,
    pub changes: Vec<Change>,
    pub change_turns: Vec<ChangeTurn>,
    pub cost_break: Option<Value>,
    pub usage: Option<Value>,
    pub subagent_cost: Option<f64>,
    pub start_ts: Option<String>,
    pub last_ts: Option<String>,
    pub subagents: Vec<Value>,
    pub sub_sessions: Vec<SubSession>,
    pub context: Option<Context>,
    pub pr_links: Vec<String>,
    pub issue_links: Vec<String>,
    pub bg_jobs: Vec<Value>,
    pub workflows: Vec<Value>,
    pub screenshots: Vec<Value>,
}

pub fn detail(id: &str) -> Result<Detail, String> {
    let mut d: Detail = decode(get(&format!("/api/session?id={}", enc(id)))?)?;
    // Answered by the instance the session runs on, which does not know it is remote to us.
    d.session.remote = crate::remote::instance_of(id);
    Ok(d)
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct LiveSnapshot {
    pub live: Option<bool>,
    pub state: Option<String>,
    pub busy: bool,
    pub activity: Option<String>,
    pub text: String,
    pub thinking: String,
    pub tool: Option<String>,
    pub ended: bool,
}

pub fn session_stream_path(id: &str) -> String {
    format!("/api/session/stream?id={}", enc(id))
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Gauge {
    pub label: String,
    pub pct: Option<f64>,
}

/// Which usage the header shows: the Claude account rate limits, or the usage of one other
/// provider (cost + tokens of the day, freshest session). A click on the block cycles through
/// them (choice persisted in the prefs, key "usageView": "claude" or the provider id).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum UsageView {
    #[default]
    Claude,
    Provider(String),
}

impl UsageView {
    pub fn key(&self) -> &str {
        match self {
            UsageView::Claude => "claude",
            UsageView::Provider(id) => id,
        }
    }

    pub fn from_key(k: Option<&str>) -> Self {
        match k {
            None | Some("") | Some("claude") => UsageView::Claude,
            Some(id) => UsageView::Provider(id.to_string()),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PiContext {
    pub pct: Option<f64>,
    pub size: Option<f64>,
    pub context_window: Option<f64>,
}

/// One provider's usage block of /api/usage (`usage.providers.<id>`, or the historical `pi`
/// block): its freshest session with context gauge, model and cost, plus the day's totals — what
/// the header shows for a provider without account rate limits (only Anthropic exposes those).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PiUsage {
    /// Provider the block describes ("pi" for the historical `pi` block of /api/usage).
    pub provider: String,
    /// Its label (from `usage.providers.<id>.label`).
    pub label: Option<String>,
    pub session_id: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub live: bool,
    pub at: Option<String>,
    pub context: Option<PiContext>,
    pub cost: Option<f64>,
    pub today_cost: Option<f64>,
    pub today_tokens: Option<f64>,
    pub sessions: Option<f64>,
}

pub fn usage() -> Result<(Vec<Gauge>, Option<PiUsage>, Value), String> {
    let v = get("/api/usage")?;
    let (g, pi) = parse_usage(&v);
    Ok((g, pi, v))
}

// Parse pur de /api/usage : jauges compte Claude + bloc `pi` (session la plus fraîche).
fn parse_usage(v: &Value) -> (Vec<Gauge>, Option<PiUsage>) {
    let a = v.get("account").cloned().unwrap_or(Value::Null);
    let pct = |x: &Value| x.get("pct").and_then(Value::as_f64);
    let mut out = vec![
        Gauge {
            label: "5H".into(),
            pct: pct(&a["fiveHour"]),
        },
        Gauge {
            label: "7D".into(),
            pct: pct(&a["sevenDay"]),
        },
    ];
    if a.get("fable").is_some_and(|f| f.is_object()) {
        let label = a["fable"]["label"]
            .as_str()
            .unwrap_or("Fable")
            .to_uppercase();
        out.push(Gauge {
            label,
            pct: pct(&a["fable"]),
        });
    }
    let pi = v.get("pi").and_then(|p| usage_block(p, "pi"));
    (out, pi)
}

/// Usage of every non-Claude provider (`usage.providers` of /api/usage, cf. buildProviderUsage
/// server-side), in key order. An older server only has the `pi` block: it stands for the
/// `pi` provider then.
pub fn parse_provider_usage(v: &Value) -> Vec<PiUsage> {
    match v.get("providers").and_then(Value::as_object) {
        Some(m) if !m.is_empty() => m.iter().filter_map(|(id, b)| usage_block(b, id)).collect(),
        _ => v.get("pi").and_then(|p| usage_block(p, "pi")).into_iter().collect(),
    }
}

fn usage_block(p: &Value, provider: &str) -> Option<PiUsage> {
    {
        if !p.is_object() {
            return None;
        }
        let context = p.get("context").and_then(|c| {
            c.is_object().then(|| PiContext {
                pct: c.get("pct").and_then(Value::as_f64),
                size: c.get("size").and_then(Value::as_f64),
                context_window: c.get("contextWindow").and_then(Value::as_f64),
            })
        });
        Some(PiUsage {
            provider: provider.to_string(),
            label: p.get("label").and_then(Value::as_str).map(str::to_string),
            session_id: p
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            title: p.get("title").and_then(Value::as_str).map(str::to_string),
            model: p.get("model").and_then(Value::as_str).map(str::to_string),
            live: p.get("live").and_then(Value::as_bool).unwrap_or(false),
            at: p.get("at").and_then(Value::as_str).map(str::to_string),
            context,
            cost: p.get("cost").and_then(Value::as_f64),
            today_cost: p.get("todayCost").and_then(Value::as_f64),
            today_tokens: p.get("todayTokens").and_then(Value::as_f64),
            sessions: p.get("sessions").and_then(Value::as_f64),
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Capabilities {
    pub models: Vec<(String, String)>,
    pub efforts: Vec<String>,
}

/// Launch options of one provider (/api/provider-options): `models` ([{ name, alias, label,
/// thinking }]), `activeModel`, `thinkingLevels`, `modes` ([{ id, label }]). Falls back to the
/// historical /api/pi-options for `pi` on an older server.
pub fn provider_options(id: &str) -> Result<Value, String> {
    match get(&format!("/api/provider-options?provider={}", enc(id))) {
        Ok(v) => Ok(v),
        Err(_) if id == "pi" => get("/api/pi-options"),
        Err(e) => Err(e),
    }
}

pub fn capabilities() -> Result<Capabilities, String> {
    let v = get("/api/capabilities")?;
    let mut models = Vec::new();
    for g in v["models"].as_array().into_iter().flatten() {
        let group = g["label"].as_str().unwrap_or("");
        for o in g["opts"].as_array().into_iter().flatten() {
            if let Some(pair) = o.as_array()
                && let Some(id) = pair.first().and_then(Value::as_str)
            {
                let label = pair.get(1).and_then(Value::as_str).unwrap_or(id);
                let label = if label.to_lowercase().starts_with(&group.to_lowercase()) {
                    label.to_string()
                } else {
                    format!("{group} {label}")
                };
                models.push((id.to_string(), label.trim().to_string()));
            }
        }
    }
    let efforts = v["efforts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    Ok(Capabilities { models, efforts })
}

pub fn reply(id: &str, text: &str) -> Result<(), String> {
    post("/api/reply", json!({ "id": id, "text": text })).map(|_| ())
}

pub struct Selection {
    pub multi: bool,
    pub indices: Vec<usize>,
    pub other: Option<String>,
}

pub fn answer(id: &str, selections: &[Selection], note: Option<&str>) -> Result<(), String> {
    let sel: Vec<Value> = selections
        .iter()
        .map(|s| json!({ "multi": s.multi, "indices": s.indices, "other": s.other }))
        .collect();
    post(
        "/api/reply",
        json!({ "id": id, "selections": sel, "note": note }),
    )
    .map(|_| ())
}

pub fn plan(id: &str, action: &str, feedback: Option<&str>) -> Result<(), String> {
    post(
        "/api/plan",
        json!({ "id": id, "action": action, "feedback": feedback }),
    )
    .map(|_| ())
}

pub fn interrupt(id: &str) -> Result<(), String> {
    post("/api/interrupt", json!({ "id": id })).map(|_| ())
}

pub fn kill(id: &str) -> Result<(), String> {
    post("/api/kill", json!({ "id": id })).map(|_| ())
}

pub fn set_mode(id: &str, mode: &str) -> Result<(), String> {
    post("/api/mode", json!({ "id": id, "mode": mode })).map(|_| ())
}

pub fn set_auto_approve(id: &str, on: bool) -> Result<(), String> {
    post("/api/auto-approve", json!({ "id": id, "on": on })).map(|_| ())
}

/// `Ok(Some(msg))` when the server held the switch because the prompt cache is warm.
pub fn set_model(
    id: &str,
    model: Option<&str>,
    effort: Option<&str>,
    force: bool,
) -> Result<Option<String>, String> {
    let v = post(
        "/api/model",
        json!({ "id": id, "model": model, "effort": effort, "force": force }),
    )?;
    if v["held"].as_bool() == Some(true) {
        return Ok(Some(
            "Switching model now re-caches the whole conversation.".into(),
        ));
    }
    Ok(None)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    pub cwd: String,
    pub prompt: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: String,
    pub incognito: bool,
    pub worktree: bool,
    pub ephemeral: bool,
    /// Provider id ("claude", "pi", or a custom one). None = the settings' default provider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

pub fn launch(req: &Launch) -> Result<String, String> {
    let v = post(
        "/api/launch",
        serde_json::to_value(req).map_err(|e| e.to_string())?,
    )?;
    v["sessionId"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "the server returned no session id".into())
}

pub fn resume(id: &str, prompt: &str, effort: Option<&str>) -> Result<(), String> {
    let mode = get("/api/settings")
        .ok()
        .and_then(|s| s["defaultMode"].as_str().map(str::to_string));
    let mode = mode
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "default".into());
    post(
        "/api/launch",
        json!({ "resumeId": id, "prompt": prompt, "effort": effort, "permissionMode": mode }),
    )
    .map(|_| ())
}

pub fn restart(id: &str) -> Result<(), String> {
    post("/api/claude", json!({ "action": "restart", "id": id })).map(|_| ())
}

pub fn delete(id: &str) -> Result<(), String> {
    post("/api/delete", json!({ "id": id })).map(|_| ())
}

pub fn gh_view(url: &str) -> Result<Value, String> {
    Ok(get(&format!("/api/gh?url={}", enc(url)))?
        .get("data")
        .cloned()
        .unwrap_or(Value::Null))
}

/// `remote_session`: the session the image is for, when it runs on a remote hooked instance.
/// The endpoint carries no session of its own, so this is what sends the upload over there.
pub fn upload_image(mime: &str, bytes: &[u8], remote_session: Option<&str>) -> Result<String, String> {
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    let mut body = json!({ "dataUrl": format!("data:{mime};base64,{data}") });
    if let Some(id) = remote_session {
        body["id"] = json!(id);
    }
    let v = post("/api/upload-image", body)?;
    v["path"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "the upload returned no path".into())
}

pub fn image_mime(path: &std::path::Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

pub fn open_editor(id: &str) -> Result<(), String> {
    post("/api/open-editor", json!({ "id": id })).map(|_| ())
}

/// A git / jj repository detected under the session's directory: the one it runs in, or a clone
/// nested below it. `changes` is only filled by the working-tree diff.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Repo {
    pub root: String,
    pub label: String,
    pub primary: bool,
    pub changes: Vec<Change>,
}

impl Repo {
    /// The server leaves the primary repo's label empty.
    pub fn name(&self) -> &str {
        if self.label.is_empty() {
            self.root.rsplit('/').next().unwrap_or(&self.root)
        } else {
            &self.label
        }
    }
}

/// The uncommitted changes of every repo detected under the session's directory. No repo at all
/// means the directory is not under version control; `truncated` that the file limit cut some
/// repos short.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct TreeDiff {
    pub repos: Vec<Repo>,
    pub truncated: bool,
}

/// Read from `repos`, not the top-level `changes`: those only mirror the primary repo, which a
/// session started above several clones does not have.
pub fn vcs_changes(id: &str) -> Result<TreeDiff, String> {
    decode(get(&format!("/api/session/vcs-diff?id={}", enc(id)))?)
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct BaseDiff {
    pub root: Option<String>,
    pub base: Option<String>,
    pub merge_base: Option<String>,
    pub branch: Option<String>,
    pub commits: u32,
    pub changes: Vec<Change>,
    pub truncated: bool,
}

pub fn vcs_base_diff(id: &str) -> Result<BaseDiff, String> {
    decode(get(&format!("/api/session/vcs-base-diff?id={}", enc(id)))?)
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub target: Option<String>,
    pub transport: Option<String>,
    pub state: String,
    pub status: Option<String>,
    pub scope_label: Option<String>,
    pub authable: bool,
    // pi fields (server/piMcp.js): raw scope + detailed config, to edit the mcp.json files.
    pub scope: Option<String>,
    pub url: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<serde_json::Map<String, Value>>,
    pub headers: Option<serde_json::Map<String, Value>>,
    pub enabled: Option<bool>,
}

impl McpServer {
    /// The editable JSON config of a pi server, rebuilt from the fields read.
    pub fn pi_config_json(&self) -> Value {
        let mut m = serde_json::Map::new();
        if let Some(u) = &self.url {
            m.insert("url".into(), Value::String(u.clone()));
            m.insert("type".into(), Value::String(self.transport.clone().unwrap_or_else(|| "http".into())));
            if let Some(h) = &self.headers {
                m.insert("headers".into(), Value::Object(h.clone()));
            }
        } else {
            if let Some(c) = &self.command {
                m.insert("command".into(), Value::String(c.clone()));
            }
            if let Some(a) = &self.args {
                m.insert("args".into(), Value::Array(a.iter().cloned().map(Value::String).collect()));
            }
            if let Some(e) = &self.env {
                m.insert("env".into(), Value::Object(e.clone()));
            }
        }
        if self.enabled == Some(false) {
            m.insert("enabled".into(), Value::Bool(false));
        }
        Value::Object(m)
    }
}

pub fn mcp_list(cwd: &str, cached: bool, provider: Option<&str>) -> Result<Vec<McpServer>, String> {
    // provider=pi : liste lue dans la config Pi ; `cached` n'existe pas côté pi, le
    // health-check (`check=1`) est l'appel complet. Any other non-Claude id is sent as is: the
    // server picks the flavour from its engine (an ACP agent lists nothing).
    let mut url = format!("/api/mcp?cwd={}", enc(cwd));
    if provider == Some("pi") {
        url.push_str("&provider=pi");
        if !cached {
            url.push_str("&check=1");
        }
    } else if let Some(p) = provider.filter(|p| *p != "claude") {
        url.push_str(&format!("&provider={}", enc(p)));
    } else if cached {
        url.push_str("&cached=1");
    }
    let v = get(&url)?;
    decode(
        v.get("servers")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
    )
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct McpLogin {
    pub id: Option<String>,
    pub name: String,
    pub url: Option<String>,
    pub done: bool,
    pub exit_code: Option<i64>,
    pub needs_paste: bool,
    pub out_of_band: bool,
    pub output: String,
}

pub fn mcp_action(body: Value) -> Result<Value, String> {
    post("/api/mcp", body)
}

pub fn mcp_login(body: Value) -> Result<McpLogin, String> {
    let v = mcp_action(body)?;
    decode(v.get("login").cloned().unwrap_or(Value::Null))
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct TraceSpan {
    pub id: String,
    pub name: String,
    pub detail: Option<String>,
    pub start: f64,
    pub end: Option<f64>,
    pub error: bool,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct TraceTurn {
    pub prompt: Option<String>,
    pub start: f64,
    pub end: Option<f64>,
    pub spans: Vec<TraceSpan>,
}

pub fn trace(id: &str) -> Result<Vec<TraceTurn>, String> {
    let v = get(&format!("/api/session/trace?id={}", enc(id)))?;
    decode(v.get("turns").cloned().unwrap_or(Value::Array(Vec::new())))
}

pub fn trace_tool(id: &str, tool: &str) -> Result<(String, String), String> {
    let v = get(&format!(
        "/api/session/trace?id={}&tool={}",
        enc(id),
        enc(tool)
    ))?;
    let text = |k: &str| match &v[k] {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    };
    Ok((text("input"), text("result")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_config_json_rebuilds_a_stdio_or_http_server() {
        let stdio: McpServer = serde_json::from_value(json!({
            "name": "hooked", "scope": "project", "transport": "stdio", "state": "configured",
            "command": "node", "args": ["mcp/server.cjs"], "env": { "A": "1" }, "enabled": true,
        }))
        .unwrap();
        let cfg = stdio.pi_config_json();
        assert_eq!(cfg["command"], "node");
        assert_eq!(cfg["args"][0], "mcp/server.cjs");
        assert_eq!(cfg["env"]["A"], "1");
        assert!(cfg.get("enabled").is_none(), "enabled:true is the default, not written");

        let http: McpServer = serde_json::from_value(json!({
            "name": "remote", "scope": "user", "transport": "http", "state": "configured",
            "url": "https://m.example.com", "headers": { "Authorization": "Bearer x" },
            "enabled": false,
        }))
        .unwrap();
        let cfg = http.pi_config_json();
        assert_eq!(cfg["url"], "https://m.example.com");
        assert_eq!(cfg["type"], "http");
        assert_eq!(cfg["headers"]["Authorization"], "Bearer x");
        assert_eq!(cfg["enabled"], false);
        assert!(cfg.get("command").is_none());
    }

    #[test]
    fn parts_fall_back_to_text_then_tools() {
        let m: Message = serde_json::from_value(json!({
            "role": "assistant", "text": "hi", "tools": [{ "name": "Bash", "detail": "ls" }]
        }))
        .unwrap();
        let parts = m.render_parts();
        assert_eq!(parts.len(), 2);
        assert!(matches!(&parts[0], Part::Text(t) if t == "hi"));
        assert!(matches!(&parts[1], Part::Tool(t) if t.name == "Bash"));
    }

    #[test]
    fn thinking_parts_keep_their_order() {
        let m: Message = serde_json::from_value(json!({
            "role": "assistant", "text": "", "parts": [
                { "type": "thinking", "text": "I should list the files" },
                { "type": "thinking", "text": "   " },
                { "type": "tool", "tool": { "name": "bash", "detail": "ls" } }
            ]
        }))
        .unwrap();
        let parts = m.render_parts();
        assert_eq!(parts.len(), 2);
        assert!(matches!(&parts[0], Part::Thinking(t) if t == "I should list the files"));
        assert!(matches!(&parts[1], Part::Tool(t) if t.name == "bash"));
    }

    #[test]
    fn title_skips_the_server_placeholder() {
        let s: Session = serde_json::from_value(
            json!({ "id": "a", "title": "(sans titre)", "lastPrompt": "do it" }),
        )
        .unwrap();
        assert_eq!(s.display_title(), "do it");
    }

    #[test]
    fn null_lists_decode_as_empty() {
        let d: Detail =
            decode(json!({ "id": "a", "todos": null, "messages": [], "pendingQuestion": null }))
                .unwrap();
        assert!(d.todos.is_empty() && d.pending_question.is_none());
    }

    #[test]
    fn query_values_are_percent_encoded() {
        assert_eq!(enc("a b/c"), "a%20b%2Fc");
    }

    #[test]
    fn usage_parses_the_claude_gauges_and_the_pi_block() {
        let (g, pi) = parse_usage(&json!({
            "account": {
                "fiveHour": { "pct": 42.0 },
                "sevenDay": { "pct": 7.0 },
                "fable": { "label": "Fable", "pct": 88.0 }
            },
            "pi": {
                "sessionId": "sess-pi-1", "title": "démo pi", "model": "mistral-medium-3.5",
                "live": true, "at": "2026-11-21T09:05:00.000Z",
                "context": { "pct": 0.5, "size": 1345, "contextWindow": 262144 },
                "cost": 0.0017, "todayCost": 1.14, "todayTokens": 89243, "sessions": 13
            }
        }));
        assert_eq!(g.len(), 3);
        assert_eq!(g[0].label, "5H");
        assert_eq!(g[0].pct, Some(42.0));
        assert_eq!(g[2].label, "FABLE");
        assert_eq!(g[2].pct, Some(88.0));
        let p = pi.expect("bloc pi présent");
        assert_eq!(p.session_id, "sess-pi-1");
        assert_eq!(p.model.as_deref(), Some("mistral-medium-3.5"));
        assert!(p.live);
        let ctx = p.context.unwrap();
        assert_eq!(ctx.pct, Some(0.5));
        assert_eq!(ctx.size, Some(1345.0));
        assert_eq!(ctx.context_window, Some(262144.0));
        assert_eq!(p.cost, Some(0.0017));
        assert_eq!(p.today_cost, Some(1.14));
        assert_eq!(p.today_tokens, Some(89243.0));
        assert_eq!(p.sessions, Some(13.0));
    }

    #[test]
    fn usage_without_pi_or_account_is_empty() {
        let (g, pi) = parse_usage(&json!({}));
        assert_eq!(g.len(), 2); // 5H/7D à null, pas de fable
        assert!(g[0].pct.is_none());
        assert!(pi.is_none());
        let (_, pi) = parse_usage(&json!({ "pi": null }));
        assert!(pi.is_none());
        // bloc pi sans contexte → présent mais sans jauge (l'entête filtre sur context.pct)
        let (_, pi) = parse_usage(&json!({ "pi": { "sessionId": "x", "context": null } }));
        assert!(pi.is_some_and(|p| p.context.is_none()));
    }

    #[test]
    fn providers_only_when_a_single_one_is_installed() {
        let both = Providers::pair(true, true);
        let claude_only = Providers::pair(true, false);
        let pi_only = Providers::pair(false, true);
        let none = Providers::default();
        assert!(both.both() && both.only().is_none());
        assert!(!claude_only.both());
        assert_eq!(claude_only.only().as_deref(), Some("claude"));
        assert!(!pi_only.both());
        assert_eq!(pi_only.only().as_deref(), Some("pi"));
        assert!(!none.both() && none.only().is_none());
    }

    #[test]
    fn providers_read_custom_entries_from_the_provider_list() {
        let p: SessionsPayload = serde_json::from_value(json!({
            "sessions": [],
            "providers": { "claude": false, "pi": true, "gemini": true },
            "providerList": [
                { "id": "claude", "engine": "claude", "label": "Claude", "short": "cc" },
                { "id": "pi", "engine": "pi", "label": "Pi", "short": "pi", "capabilities": { "plan": false, "fork": true } },
                { "id": "gemini", "engine": "acp", "label": "Gemini", "short": "gm", "color": "#4285f4",
                  "mcpKind": null, "capabilities": { "permissions": true, "modes": true } }
            ]
        }))
        .unwrap();
        let ps = Providers::from_wire(&p.providers.unwrap(), p.provider_list);
        assert!(!ps.claude && ps.pi);
        assert_eq!(ps.enabled_ids(), ["pi", "gemini"]);
        assert!(ps.both());
        let g = ps.info("gemini");
        assert_eq!((g.label.as_str(), g.short.as_str(), g.engine()), ("Gemini", "gm", "acp"));
        assert_eq!(g.color.as_deref(), Some("#4285f4"));
        assert!(g.can("permissions") && !g.can("plan"));
        assert!(ps.info("claude").can("plan")); // Claude Code has every capability
        assert!(!ps.info("pi").can("plan"));
        // a provider the server never described still gets a usable descriptor
        let unknown = ps.info("my-agent");
        assert_eq!((unknown.label.as_str(), unknown.short.as_str()), ("My Agent", "my"));
    }

    #[test]
    fn provider_usage_reads_every_provider_block() {
        let list = parse_provider_usage(&json!({
            "pi": { "sessionId": "a", "todayCost": 1.0 },
            "providers": {
                "mistral": { "sessionId": "a", "label": "Mistral", "todayCost": 1.0 },
                "gemini": { "sessionId": "b", "label": "Gemini", "todayCost": 0.5 }
            }
        }));
        assert_eq!(list.iter().map(|u| u.provider.as_str()).collect::<Vec<_>>(), ["gemini", "mistral"]);
        assert_eq!(list[1].label.as_deref(), Some("Mistral"));
        // older server: only the `pi` block
        let old = parse_provider_usage(&json!({ "pi": { "sessionId": "a" } }));
        assert_eq!(old.len(), 1);
        assert_eq!(old[0].provider, "pi");
        assert_eq!(UsageView::from_key(Some("gemini")), UsageView::Provider("gemini".into()));
        assert_eq!(UsageView::from_key(Some("claude")).key(), "claude");
    }

    // `remote::brief_error` cuts the cause out of ureq's own wording of a transport error.
    #[test]
    fn a_refused_connection_reads_as_its_cause() {
        let e = get_from("http://127.0.0.1:1", "/api/sessions").unwrap_err();
        assert_eq!(crate::remote::brief_error(&e), "Connection refused");
    }
}

#[cfg(test)]
mod media_tests {
    use super::*;

    #[test]
    fn pasted_images_leave_the_text() {
        let (imgs, rest) =
            split_message_images("/Users/me/.hooked/images/a1.png look at this\n/tmp/images/b.JPG");
        assert_eq!(
            imgs,
            ["/Users/me/.hooked/images/a1.png", "/tmp/images/b.JPG"]
        );
        assert_eq!(rest, "look at this");
        let (none, same) = split_message_images("see /tmp/shot.png");
        assert!(none.is_empty());
        assert_eq!(same, "see /tmp/shot.png");
    }
}
