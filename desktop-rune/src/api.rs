use std::io::{BufRead, BufReader};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

pub fn base() -> String {
    std::env::var("HOOKED_URL").unwrap_or_else(|_| "http://localhost:4123".into())
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout(Duration::from_secs(30))
        .build()
}

fn enc(s: &str) -> String {
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

pub fn get(path: &str) -> Result<Value, String> {
    let r = agent().get(&format!("{}{path}", base())).call();
    read(r)
}

pub fn post(path: &str, body: Value) -> Result<Value, String> {
    let r = agent().post(&format!("{}{path}", base())).send_json(body);
    read(r)
}

fn read(r: Result<ureq::Response, ureq::Error>) -> Result<Value, String> {
    match r {
        Ok(resp) => {
            let v: Value = resp.into_json().map_err(|e| e.to_string())?;
            if v.get("ok") == Some(&Value::Bool(false)) {
                return Err(v
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("request failed")
                    .to_string());
            }
            Ok(v)
        }
        Err(ureq::Error::Status(code, resp)) => {
            let v: Value = resp.into_json().unwrap_or(Value::Null);
            Err(v
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("HTTP {code}")))
        }
        Err(e) => Err(e.to_string()),
    }
}

pub fn follow(path: &str, mut on_data: impl FnMut(&str) -> bool) -> Result<(), String> {
    let a = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(45))
        .build();
    let resp = a
        .get(&format!("{}{path}", base()))
        .set("Accept", "text/event-stream")
        .call()
        .map_err(|e| e.to_string())?;
    for line in BufReader::new(resp.into_reader()).lines() {
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

fn decode<T: serde::de::DeserializeOwned>(mut v: Value) -> Result<T, String> {
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
    pub todo: Option<TodoSummary>,
    pub cache: Option<CacheInfo>,
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

    pub fn project_label(&self) -> String {
        self.repo
            .clone()
            .or_else(|| self.project_name.clone())
            .unwrap_or_else(|| "?".into())
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
struct SessionsPayload {
    #[serde(default)]
    sessions: Vec<Session>,
}

pub fn sessions() -> Result<Vec<Session>, String> {
    let v = get("/api/sessions")?;
    let p: SessionsPayload = decode(v)?;
    Ok(p.sessions
        .into_iter()
        .filter(|s| !s.id.is_empty())
        .collect())
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Meta {
    pub archived: bool,
    pub incognito: bool,
    pub group_of: Option<String>,
    pub group_at: Option<Value>,
    pub group_name: Option<String>,
}

pub fn session_meta() -> Result<std::collections::HashMap<String, Meta>, String> {
    let v = get("/api/session-meta")?;
    decode(
        v.get("meta")
            .cloned()
            .unwrap_or(Value::Object(Default::default())),
    )
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
    decode(get("/api/tags")?.get("tags").cloned().unwrap_or(json!({})))
}

pub fn save_tags(id: &str, tags: &[String]) -> Result<(), String> {
    post("/api/tags", json!({ "id": id, "tags": tags })).map(|_| ())
}

pub fn fork(
    id: &str,
    fork_uuid: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<String, String> {
    let v = post(
        "/api/fork",
        json!({ "id": id, "forkUuid": fork_uuid, "prompt": "", "model": model, "effort": effort }),
    )?;
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
    Tool(Tool),
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
struct RawPart {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
    tool: Option<Tool>,
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
                "tool" => p.tool.clone().map(Part::Tool),
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
    pub ops: Vec<Value>,
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
    decode(get(&format!("/api/session?id={}", enc(id)))?)
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

pub fn usage() -> Result<Vec<Gauge>, String> {
    let v = get("/api/usage")?;
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
    Ok(out)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Capabilities {
    pub models: Vec<(String, String)>,
    pub efforts: Vec<String>,
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

pub fn launch(
    cwd: &str,
    prompt: &str,
    model: Option<&str>,
    effort: Option<&str>,
    mode: Option<&str>,
    incognito: bool,
) -> Result<String, String> {
    let v = post(
        "/api/launch",
        json!({ "cwd": cwd, "prompt": prompt, "model": model, "effort": effort, "permissionMode": mode, "incognito": incognito }),
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

pub fn upload_image(mime: &str, bytes: &[u8]) -> Result<String, String> {
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    let v = post(
        "/api/upload-image",
        json!({ "dataUrl": format!("data:{mime};base64,{data}") }),
    )?;
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

pub fn vcs_changes(id: &str) -> Result<Vec<Change>, String> {
    let v = get(&format!("/api/session/vcs-diff?id={}", enc(id)))?;
    decode(
        v.get("changes")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
    )
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
}

pub fn mcp_list(cwd: &str, cached: bool) -> Result<Vec<McpServer>, String> {
    let v = get(&format!(
        "/api/mcp?cwd={}{}",
        enc(cwd),
        if cached { "&cached=1" } else { "" }
    ))?;
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
}
