//! The EXTENSIONS section: hooked's extensions (docs/extensions.md) with their switch. The list
//! comes from the running service; when it is unreachable, it is read from disk and the switches
//! are disabled, since the launcher never writes `settings.json` itself (it would race with the
//! service's own writes). Installing, updating and uninstalling run `runner::apply_extension`,
//! which reaches the service through `Service`.

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
    /// Where it was fetched from (`.origin.json`): what Update fetches again.
    pub from: Option<Source>,
    pub enabled: bool,
    /// Loaded, on and started with no error. Unknown (false) when read from disk.
    pub active: bool,
    pub errors: Vec<String>,
}

impl Ext {
    pub fn origin(&self) -> String {
        let place = match &self.from {
            Some(f) => format!("{}@{}", f.repo, f.r#ref),
            None => self.source.clone(),
        };
        let mut parts = vec![place];
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
    /// The extension contract hooked offers (`EXTENSION_API`): the service's, else the checkout's.
    pub api: Option<u64>,
}

/// Written into an installed extension's folder by the launcher; the service shows it as `origin`.
pub const ORIGIN: &str = ".origin.json";

/// A git source of an extension: a repo, a ref, and the folder inside it.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Source {
    pub repo: String,
    pub r#ref: String,
    pub path: String,
}

impl Source {
    pub fn of_origin(o: &Value) -> Option<Source> {
        Some(Source {
            repo: o["repo"].as_str()?.to_string(),
            r#ref: o["ref"].as_str().unwrap_or("main").to_string(),
            path: o["path"].as_str().unwrap_or(".").to_string(),
        })
    }

    /// The content of `.origin.json`: the source, the commit it was fetched at, and when.
    pub fn origin_json(&self, commit: &str, now_secs: i64) -> Value {
        json!({ "repo": self.repo, "ref": self.r#ref, "path": self.path, "commit": commit, "installedAt": iso_utc(now_secs) })
    }
}

/// `2026-11-27T10:04:05Z`, without a date crate for one timestamp (days to civil date, Howard
/// Hinnant's algorithm).
pub fn iso_utc(secs: i64) -> String {
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// The service as the extension flow sees it, so the flow can be tested without one.
pub trait Service {
    /// `GET /api/extensions`; an error means the service is unreachable.
    fn listing(&self) -> Result<Value, String>;
    /// `POST /api/extensions/reload { id }`: loads what is on disk for `id` now.
    fn reload(&self, id: &str) -> Result<Value, String>;
}

/// The running service, at `sys::base_url()`.
pub struct Http;

impl Service for Http {
    fn listing(&self) -> Result<Value, String> {
        sys::get_json("/api/extensions", TIMEOUT)
    }

    fn reload(&self, id: &str) -> Result<Value, String> {
        // A reload compiles the extension's page: longer than a listing.
        sys::post_json("/api/extensions/reload", &json!({ "id": id }), Duration::from_secs(60))
    }
}

/// `EXTENSION_API` as the checkout declares it, for when the service cannot say.
pub fn api_from_checkout(repo: &Path) -> Option<u64> {
    let src = std::fs::read_to_string(repo.join("server/ext/context.js")).ok()?;
    api_in_source(&src)
}

fn api_in_source(src: &str) -> Option<u64> {
    let rest = src.split("const EXTENSION_API").nth(1)?;
    rest.trim_start().strip_prefix('=')?.trim_start().split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
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
            from: Source::of_origin(&e["origin"]),
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
            let origin = read_json(&root.join(&name).join(ORIGIN));
            out.push(Ext {
                id: name.clone(),
                label: m["label"].as_str().unwrap_or(&name).to_string(),
                description: str_of(&m, "description"),
                source: source.to_string(),
                version: m["version"].as_str().map(str::to_string),
                commit: origin.as_ref().and_then(|o| o["commit"].as_str().map(str::to_string)),
                from: origin.as_ref().and_then(Source::of_origin),
                enabled: enabled_in(settings, &name, m["default"].as_bool() != Some(false)),
                active: false,
                errors: Vec::new(),
            });
        }
    }
    out
}

pub fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// `HOOKED_DATA_DIR`, as the service resolves it.
pub fn data_dir() -> PathBuf {
    std::env::var_os("HOOKED_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".claude/hooked"))
}

/// Where the launcher installs extensions; the service reads the same variable.
pub fn installed_root() -> PathBuf {
    std::env::var_os("HOOKED_EXTENSIONS_DIR").map(PathBuf::from).unwrap_or_else(|| data_dir().join("extensions"))
}

fn roots(repo: &Path) -> Vec<(PathBuf, &'static str)> {
    vec![(repo.join("extensions"), "bundled"), (installed_root(), "installed")]
}

pub fn list(repo: &Path) -> Listing {
    match Http.listing() {
        Ok(v) => Listing { exts: from_service(&v), live: true, api: v["api"].as_u64() },
        Err(_) => {
            let settings = read_json(&data_dir().join("settings.json")).unwrap_or(Value::Null);
            Listing { exts: from_disk(&roots(repo), &settings), live: false, api: api_from_checkout(repo) }
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
    fn shows_where_an_installed_extension_came_from() {
        let v = json!({ "extensions": [{
            "id": "hello", "label": "Hello", "source": "installed", "version": "1.0.0",
            "origin": { "repo": "https://example.com/x.git", "ref": "main", "path": "hello", "commit": "0123456789" }
        }]});
        let e = &from_service(&v)[0];
        assert_eq!(e.origin(), "https://example.com/x.git@main · 1.0.0 · 0123456");
        assert_eq!(e.from.as_ref().map(|f| f.path.as_str()), Some("hello"));
    }

    #[test]
    fn writes_the_origin_the_service_reads() {
        let src = Source { repo: "/tmp/repo".into(), r#ref: "main".into(), path: ".".into() };
        let o = src.origin_json("abc123", 1_795_773_845);
        assert_eq!(
            o,
            json!({ "repo": "/tmp/repo", "ref": "main", "path": ".", "commit": "abc123", "installedAt": "2026-11-27T10:04:05Z" })
        );
        assert_eq!(Source::of_origin(&o), Some(src));
    }

    #[test]
    fn formats_utc_dates() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso_utc(1_709_251_199), "2024-02-29T23:59:59Z");
    }

    #[test]
    fn reads_the_contract_version_from_the_checkout() {
        assert_eq!(api_in_source("/** x */\nconst EXTENSION_API = 1;\nexport { EXTENSION_API };"), Some(1));
        assert_eq!(api_in_source("const EXTENSION_API=12;"), Some(12));
        assert_eq!(api_in_source("export { EXTENSION_API };"), None);
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        assert_eq!(api_from_checkout(&repo), Some(1));
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
