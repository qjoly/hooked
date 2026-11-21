//! A client for the incident.io desktop binary, which only speaks MCP over stdio (`incident mcp`).
//!
//! One child process serves every call, one call at a time. A write is never sent twice: most of
//! the tools post in an incident channel, so a call that failed half-way is reported, not retried.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const TIMEOUT: Duration = Duration::from_secs(45);

/// Where the desktop app installs its binary. `HOOKED_INCIDENT_BIN` overrides it (a fake server
/// for tests and snapshots), and set to an empty string it turns the integration off.
pub fn find_bin() -> Option<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    pick_bin(
        std::env::var("HOOKED_INCIDENT_BIN").ok().as_deref(),
        &[
            PathBuf::from(format!("{home}/.incidentio/incident")),
            PathBuf::from(
                "/Applications/incident.io.app/Contents/Resources/incident.app/Contents/MacOS/incident",
            ),
        ],
    )
}

fn pick_bin(forced: Option<&str>, known: &[PathBuf]) -> Option<PathBuf> {
    match forced {
        Some(p) => Some(PathBuf::from(p)).filter(|p| p.is_file()),
        None => known.iter().find(|p| p.is_file()).cloned(),
    }
}

struct Conn {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    next_id: u64,
}

impl Drop for Conn {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct Client {
    bin: PathBuf,
    conn: Mutex<Option<Conn>>,
}

impl Client {
    pub fn new(bin: PathBuf) -> Client {
        Client {
            bin,
            conn: Mutex::new(None),
        }
    }

    fn connect(&self) -> Result<Conn, String> {
        let mut child = Command::new(&self.bin)
            .arg("mcp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("{}: {e}", self.bin.display()))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let (tx, lines) = channel();
        crate::app::spawn_named("incident-mcp", move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let mut conn = Conn {
            child,
            stdin,
            lines,
            next_id: 1,
        };
        request(
            &mut conn,
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "hooked", "version": env!("CARGO_PKG_VERSION") },
            }),
        )?;
        send(
            &mut conn,
            &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        )?;
        Ok(conn)
    }

    /// One JSON-RPC request. A dead connection is replaced before the request goes out, never
    /// after: once it is written, a failure is the caller's to report.
    pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut slot = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if slot
            .as_mut()
            .is_some_and(|c| !matches!(c.child.try_wait(), Ok(None)))
        {
            *slot = None;
        }
        if slot.is_none() {
            *slot = Some(self.connect()?);
        }
        let r = request(slot.as_mut().expect("just connected"), method, params);
        if r.as_ref().is_err_and(|e| e.starts_with(LOST)) {
            *slot = None;
        }
        r
    }

    /// A tool call: its structured result, or the server's own words when it refuses.
    pub fn tool(&self, name: &str, args: Value) -> Result<Value, String> {
        tool_result(&self.call("tools/call", json!({ "name": name, "arguments": args }))?)
    }

    pub fn tools(&self) -> Result<Vec<String>, String> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let params = cursor.take().map_or(json!({}), |c| json!({ "cursor": c }));
            let page = self.call("tools/list", params)?;
            out.extend(
                page["tools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|t| t["name"].as_str().map(str::to_string)),
            );
            match page["nextCursor"].as_str().filter(|c| !c.is_empty()) {
                Some(c) => cursor = Some(c.to_string()),
                None => return Ok(out),
            }
        }
    }

    pub fn resource(&self, uri: &str) -> Result<String, String> {
        let r = self.call("resources/read", json!({ "uri": uri }))?;
        r["contents"][0]["text"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| format!("{uri}: no text"))
    }
}

const LOST: &str = "incident.io connection lost";

fn send(conn: &mut Conn, msg: &Value) -> Result<(), String> {
    writeln!(conn.stdin, "{msg}")
        .and_then(|()| conn.stdin.flush())
        .map_err(|e| format!("{LOST}: {e}"))
}

fn request(conn: &mut Conn, method: &str, params: Value) -> Result<Value, String> {
    let id = conn.next_id;
    conn.next_id += 1;
    send(
        conn,
        &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
    )?;
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let line = match conn.lines.recv_timeout(left) {
            Ok(l) => l,
            Err(RecvTimeoutError::Timeout) => return Err(format!("{LOST}: no answer to {method}")),
            Err(RecvTimeoutError::Disconnected) => {
                return Err(format!("{LOST}: the incident.io process exited"));
            }
        };
        // Notifications and log lines share the stream with the answer.
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if msg["id"].as_u64() != Some(id) {
            continue;
        }
        if let Some(e) = msg.get("error") {
            return Err(e["message"]
                .as_str()
                .unwrap_or("request failed")
                .to_string());
        }
        return Ok(msg["result"].clone());
    }
}

/// The payload of a `tools/call` result. On `isError` the structured content is an empty
/// placeholder, so the text is what counts there.
pub fn tool_result(r: &Value) -> Result<Value, String> {
    let text = r["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if r["isError"].as_bool() == Some(true) {
        return Err(error_text(&text));
    }
    if let Some(v) = r.get("structuredContent").filter(|v| !v.is_null()) {
        return Ok(v.clone());
    }
    Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
}

/// `{"type":…,"errors":[{"message":…}]}` as its messages, anything else as is.
fn error_text(text: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(text).ok();
    let messages: Vec<&str> = parsed
        .as_ref()
        .and_then(|v| v["errors"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|e| e["message"].as_str())
        .collect();
    if messages.is_empty() {
        if text.trim().is_empty() {
            "the incident.io tool failed".into()
        } else {
            text.trim().to_string()
        }
    } else {
        messages.join("; ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_result_gives_the_servers_message_not_the_empty_placeholder() {
        let r = json!({
            "isError": true,
            "structuredContent": { "id": "", "name": "" },
            "content": [{ "type": "text", "text": "{\"type\":\"not_found\",\"errors\":[{\"code\":\"not_found\",\"message\":\"incident not found\"}]}" }],
        });
        assert_eq!(tool_result(&r), Err("incident not found".into()));
        let plain = json!({ "isError": true, "content": [{ "type": "text", "text": "validating root: missing id" }] });
        assert_eq!(
            tool_result(&plain),
            Err("validating root: missing id".into())
        );
    }

    #[test]
    fn a_result_is_its_structured_content_then_its_json_text_then_its_text() {
        let both = json!({ "structuredContent": { "a": 1 }, "content": [{ "type": "text", "text": "{\"a\":2}" }] });
        assert_eq!(tool_result(&both), Ok(json!({ "a": 1 })));
        let text = json!({ "content": [{ "type": "text", "text": "{\"a\":2}" }] });
        assert_eq!(tool_result(&text), Ok(json!({ "a": 2 })));
        let words = json!({ "content": [{ "type": "text", "text": "No active incident" }] });
        assert_eq!(tool_result(&words), Ok(json!("No active incident")));
    }

    #[test]
    fn a_forced_binary_that_is_missing_turns_the_integration_off() {
        let here = PathBuf::from(file!());
        let known = [PathBuf::from("/nonexistent/incident"), here.clone()];
        assert_eq!(pick_bin(None, &known), Some(here.clone()));
        assert_eq!(pick_bin(Some(""), &known), None);
        assert_eq!(pick_bin(Some("/nonexistent/other"), &known), None);
        assert_eq!(pick_bin(None, &known[..1]), None);
    }
}
