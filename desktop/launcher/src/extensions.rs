//! The EXTENSIONS section: hooked's extensions (docs/extensions.md) with their switch. The list
//! comes from the running service; when it is unreachable, it is read from disk and the switches
//! are disabled, since the launcher never writes `settings.json` itself (it would race with the
//! service's own writes).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};

use crate::sys;

const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Ext {
    pub id: String,
    pub label: String,
    pub description: String,
    /// `bundled` (in the checkout) or `installed`.
    pub source: String,
    pub version: Option<String>,
    /// The commit an installed extension was fetched at (`.origin.json`).
    pub commit: Option<String>,
    pub enabled: bool,
    /// Loaded, on and started with no error. Unknown (false) when read from disk.
    pub active: bool,
    pub errors: Vec<String>,
}

impl Ext {
    pub fn origin(&self) -> String {
        let mut parts = vec![self.source.clone()];
        parts.extend(self.version.clone());
        parts.extend(self.commit.as_ref().map(|c| c.chars().take(7).collect::<String>()));
        parts.join(" · ")
    }
}

#[derive(Debug, Default)]
pub struct Listing {
    pub exts: Vec<Ext>,
    /// Read from the service: the switches work. Otherwise read from disk.
    pub live: bool,
}

fn str_of(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or_default().to_string()
}

/// `GET /api/extensions` (or the answer of `POST /api/extensions`): the loaded extensions, then the
/// rejected ones with their error.
pub fn from_service(v: &Value) -> Vec<Ext> {
    let mut out: Vec<Ext> = v["extensions"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| Ext {
            id: str_of(e, "id"),
            label: str_of(e, "label"),
            description: str_of(e, "description"),
            source: str_of(e, "source"),
            version: e["version"].as_str().map(str::to_string),
            commit: e["origin"]["commit"].as_str().map(str::to_string),
            enabled: e["enabled"].as_bool().unwrap_or(false),
            active: e["active"].as_bool().unwrap_or(false),
            errors: e["errors"].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        })
        .collect();
    for r in v["rejected"].as_array().into_iter().flatten() {
        out.push(Ext {
            id: str_of(r, "id"),
            label: str_of(r, "id"),
            source: str_of(r, "source"),
            errors: vec![format!("rejected: {}", str_of(r, "error"))],
            ..Default::default()
        });
    }
    out
}

/// The same rule as the service (`extensionOn`): `extensions`, then the older `modules`, then the
/// manifest's `default`.
pub fn enabled_in(settings: &Value, id: &str, default: bool) -> bool {
    settings["extensions"][id].as_bool().or_else(|| settings["modules"][id].as_bool()).unwrap_or(default)
}

/// Every extension folder of the two roots, bundled first; an installed folder that repeats a
/// bundled id is shadowed, as in the service.
pub fn from_disk(roots: &[(PathBuf, &str)], settings: &Value) -> Vec<Ext> {
    let mut out: Vec<Ext> = Vec::new();
    for (root, source) in roots {
        let Ok(dir) = std::fs::read_dir(root) else { continue };
        let mut names: Vec<String> = dir.filter_map(|d| d.ok()?.file_name().into_string().ok()).collect();
        names.sort();
        for name in names {
            if name.starts_with('.') || name.ends_with(".next") || name.ends_with(".prev") || out.iter().any(|e| e.id == name) {
                continue;
            }
            let Some(m) = read_json(&root.join(&name).join("extension.json")) else { continue };
            out.push(Ext {
                id: name.clone(),
                label: m["label"].as_str().unwrap_or(&name).to_string(),
                description: str_of(&m, "description"),
                source: source.to_string(),
                version: m["version"].as_str().map(str::to_string),
                commit: read_json(&root.join(&name).join(".origin.json")).and_then(|o| o["commit"].as_str().map(str::to_string)),
                enabled: enabled_in(settings, &name, m["default"].as_bool() != Some(false)),
                active: false,
                errors: Vec::new(),
            });
        }
    }
    out
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// `HOOKED_DATA_DIR`, as the service resolves it.
fn data_dir() -> PathBuf {
    std::env::var_os("HOOKED_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".claude/hooked"))
}

fn roots(repo: &Path) -> Vec<(PathBuf, &'static str)> {
    let installed = std::env::var_os("HOOKED_EXTENSIONS_DIR").map(PathBuf::from).unwrap_or_else(|| data_dir().join("extensions"));
    vec![(repo.join("extensions"), "bundled"), (installed, "installed")]
}

pub fn list(repo: &Path) -> Listing {
    match sys::get_json("/api/extensions", TIMEOUT) {
        Ok(v) => Listing { exts: from_service(&v), live: true },
        Err(_) => {
            let settings = read_json(&data_dir().join("settings.json")).unwrap_or(Value::Null);
            Listing { exts: from_disk(&roots(repo), &settings), live: false }
        }
    }
}

/// Switches one extension in the running service, which applies it at once (no restart).
pub fn set_enabled(id: &str, enabled: bool) -> Result<Vec<Ext>, String> {
    sys::post_json("/api/extensions", &json!({ "id": id, "enabled": enabled }), TIMEOUT).map(|v| from_service(&v))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_service_listing_with_rejected_extensions() {
        let v = json!({
            "extensions": [{
                "id": "cron", "label": "Cron", "description": "Scheduled sessions", "source": "bundled",
                "version": "1.0.0", "origin": null, "enabled": true, "active": true, "errors": []
            }, {
                "id": "hello", "label": "Hello", "source": "installed", "version": "1.0.0",
                "origin": { "commit": "0123456789abcdef" }, "enabled": false, "active": false, "errors": ["start: boom"]
            }],
            "rejected": [{ "id": "bad", "source": "installed", "error": "api 2, hooked offers 1" }]
        });
        let exts = from_service(&v);
        assert_eq!(exts[0].origin(), "bundled · 1.0.0");
        assert!(exts[0].enabled && exts[0].active);
        assert_eq!(exts[1].origin(), "installed · 1.0.0 · 0123456");
        assert_eq!(exts[1].errors, vec!["start: boom"]);
        assert_eq!(exts[2].errors, vec!["rejected: api 2, hooked offers 1"]);
        assert!(!exts[2].enabled);
    }

    #[test]
    fn reads_both_roots_from_disk_when_the_service_is_down() {
        let tmp = std::env::temp_dir().join(format!("launcher-ext-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let place = |root: &str, id: &str, manifest: Value| {
            let dir = tmp.join(root).join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("extension.json"), manifest.to_string()).unwrap();
            dir
        };
        place("bundled", "cron", json!({ "id": "cron", "label": "Cron", "version": "1.0.0" }));
        place("installed", "cron", json!({ "id": "cron", "label": "Shadowed" }));
        let hello = place("installed", "hello", json!({ "id": "hello", "label": "Hello", "default": false }));
        std::fs::write(hello.join(".origin.json"), json!({ "commit": "abcdef1234" }).to_string()).unwrap();
        place("installed", "hello.next", json!({ "id": "hello", "label": "Staged" }));
        place("installed", ".catalog", json!({ "id": "catalog", "label": "Hidden" }));

        let roots = [(tmp.join("bundled"), "bundled"), (tmp.join("installed"), "installed")];
        let exts = from_disk(&roots, &json!({ "modules": { "cron": false } }));
        let summary: Vec<(&str, &str, bool)> = exts.iter().map(|e| (e.id.as_str(), e.label.as_str(), e.enabled)).collect();
        assert_eq!(summary, vec![("cron", "Cron", false), ("hello", "Hello", false)]);
        assert_eq!(exts[1].origin(), "installed · abcdef1");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn the_switch_follows_the_service_rule() {
        assert!(enabled_in(&json!({}), "cron", true));
        assert!(!enabled_in(&json!({}), "cron", false));
        assert!(!enabled_in(&json!({ "modules": { "cron": false } }), "cron", true));
        assert!(enabled_in(&json!({ "extensions": { "cron": true }, "modules": { "cron": false } }), "cron", false));
    }
}

/// Against a running service: `HOOKED_URL=http://localhost:4124 cargo test -p hooked-launcher -- --ignored`.
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore = "needs a running hooked service with the cron extension"]
    fn switches_an_extension_off_and_on_in_the_running_service() {
        let cron = |exts: &[Ext]| exts.iter().find(|e| e.id == "cron").cloned().unwrap();
        let off = set_enabled("cron", false).unwrap();
        assert!(!cron(&off).enabled && !cron(&off).active);
        let listing = list(Path::new("."));
        assert!(listing.live && !cron(&listing.exts).enabled);
        let on = set_enabled("cron", true).unwrap();
        assert!(cron(&on).enabled && cron(&on).active);
    }
}
