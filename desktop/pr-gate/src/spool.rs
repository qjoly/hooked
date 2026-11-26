use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

pub const REQUEST: &str = ".request.json";
pub const RESULT: &str = ".result.json";

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Input {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workdir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Output {
    pub decision: String,
    pub title: String,
    pub body: String,
}

pub fn exit_code(decision: &str) -> i32 {
    match decision {
        "open" => 0,
        "draft" => 10,
        "denied" => 20,
        _ => 1,
    }
}

pub fn spool_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join("Library/Application Support/pr-gate")
}

pub fn queue_dir() -> PathBuf {
    let q = spool_dir().join("queue");
    let _ = fs::create_dir_all(&q);
    q
}

pub fn request_path(id: &str) -> PathBuf {
    queue_dir().join(format!("{id}{REQUEST}"))
}

pub fn result_path(id: &str) -> PathBuf {
    queue_dir().join(format!("{id}{RESULT}"))
}

pub fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path)
}

pub fn daemon_alive() -> bool {
    let Ok(s) = fs::read_to_string(spool_dir().join("daemon.pid")) else { return false };
    let Ok(pid) = s.trim().parse::<i32>() else { return false };
    unsafe { libc::kill(pid, 0) == 0 }
}

/// The request file goes only once the answer is durably written, so a crash in between
/// re-shows the request rather than losing it.
pub fn answer(id: &str, out: &Output) {
    let Ok(data) = serde_json::to_vec(out) else { return };
    if write_atomic(&result_path(id), &data).is_ok() {
        let _ = fs::remove_file(request_path(id));
    }
}

pub fn pending() -> Vec<(String, Input)> {
    let Ok(entries) = fs::read_dir(queue_dir()) else { return Vec::new() };
    let mut found: Vec<(SystemTime, String, Input)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let id = name.strip_suffix(REQUEST)?.to_owned();
            let mtime = e.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
            let input = serde_json::from_slice(&fs::read(e.path()).ok()?).ok()?;
            Some((mtime, id, input))
        })
        .collect();
    found.sort_by_key(|(t, _, _)| *t);
    found.into_iter().map(|(_, id, input)| (id, input)).collect()
}
