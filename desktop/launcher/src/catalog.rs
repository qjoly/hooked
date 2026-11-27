//! The catalog behind "Add from catalog…": `catalog.json`, a list of extensions with their git
//! source. By default it is `extensions/catalog.json` of the service's checkout, read in place (it
//! is the hooked repo itself, already on disk). The launcher setting `catalog` in `launcher.json`
//! names another git repo instead, cloned into `$HOOKED_EXTENSIONS_DIR/.catalog/` (the service skips
//! dot folders) with the user's own git credentials, so a private repo works.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::extensions::{self, Source};
use crate::sys;

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub label: String,
    pub description: String,
    pub source: Source,
    /// The extension contract it was written against; hooked rejects any other.
    pub api: u64,
}

/// Entries without an id or a repo are dropped: there would be nothing to install.
pub fn parse(text: &str) -> Result<Vec<Entry>, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("catalog.json: {e}"))?;
    let list = v.as_array().ok_or("catalog.json: not a list")?;
    Ok(list
        .iter()
        .filter_map(|e| {
            let id = e["id"].as_str()?.to_string();
            Some(Entry {
                label: e["label"].as_str().unwrap_or(&id).to_string(),
                description: e["description"].as_str().unwrap_or_default().to_string(),
                source: Source {
                    repo: e["repo"].as_str()?.to_string(),
                    r#ref: e["ref"].as_str().unwrap_or("main").to_string(),
                    path: e["path"].as_str().unwrap_or(".").to_string(),
                },
                api: e["api"].as_u64().unwrap_or(0),
                id,
            })
        })
        .collect())
}

/// `HOOKED_LAUNCHER_CONFIG`, else `launcher.json` in hooked's data folder.
fn config_path() -> PathBuf {
    std::env::var_os("HOOKED_LAUNCHER_CONFIG").map(PathBuf::from).unwrap_or_else(|| extensions::data_dir().join("launcher.json"))
}

/// The `catalog` setting: a git URL, or none for the default.
pub fn setting(config: &Value) -> Option<String> {
    config["catalog"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

pub fn load(repo: &Path) -> Result<Vec<Entry>, String> {
    let config = extensions::read_json(&config_path()).unwrap_or(Value::Null);
    let file = match setting(&config) {
        None => repo.join("extensions/catalog.json"),
        Some(url) => sync(&url, &extensions::installed_root().join(".catalog"))?.join("catalog.json"),
    };
    parse(&std::fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?)
}

/// A shallow clone of `url` at `dir`, fetched again when it is already there.
fn sync(url: &str, dir: &Path) -> Result<PathBuf, String> {
    let mut log = String::new();
    // Without its own .git, git would answer for the repository around it and reset that one.
    let same = dir.join(".git").exists() && sys::query(dir, &["remote", "get-url", "origin"]).is_ok_and(|u| u.trim() == url);
    if same {
        sys::git(&mut log, dir, &["fetch", "--depth", "1", "origin"])?;
        sys::git(&mut log, dir, &["reset", "--hard", "FETCH_HEAD"])?;
    } else {
        // Another URL, or no clone yet: a fresh clone (the folder holds nothing else).
        let _ = std::fs::remove_dir_all(dir);
        let parent = dir.parent().ok_or("no parent folder for the catalog")?;
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        let target = dir.to_string_lossy();
        sys::git(&mut log, parent, &["clone", "--depth", "1", "--", url, &target])?;
    }
    Ok(dir.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_entries_with_their_defaults() {
        let text = json!([
            { "id": "hello", "label": "Hello", "description": "A fixture", "repo": "https://x/h.git", "ref": "v1", "path": "ext/hello", "api": 1 },
            { "id": "bare", "repo": "https://x/b.git" },
            { "id": "no-repo" },
            { "repo": "https://x/no-id.git" }
        ])
        .to_string();
        let entries = parse(&text).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0],
            Entry {
                id: "hello".into(),
                label: "Hello".into(),
                description: "A fixture".into(),
                source: Source { repo: "https://x/h.git".into(), r#ref: "v1".into(), path: "ext/hello".into() },
                api: 1,
            }
        );
        assert_eq!((entries[1].label.as_str(), entries[1].source.r#ref.as_str(), entries[1].source.path.as_str()), ("bare", "main", "."));
    }

    #[test]
    fn rejects_a_catalog_that_is_not_a_list() {
        assert!(parse("{}").is_err());
        assert!(parse("nope").is_err());
    }

    #[test]
    fn the_default_catalog_parses() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let text = std::fs::read_to_string(repo.join("extensions/catalog.json")).unwrap();
        assert!(parse(&text).unwrap().iter().any(|e| e.id == "hello" && e.api == 1));
    }

    #[test]
    fn an_empty_setting_means_the_default_catalog() {
        assert_eq!(setting(&json!({})), None);
        assert_eq!(setting(&json!({ "catalog": " " })), None);
        assert_eq!(setting(&json!({ "catalog": "git@x:y.git" })), Some("git@x:y.git".into()));
    }
}
