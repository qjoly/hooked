//! The Incidents page: incident.io through the desktop binary's MCP server (`incmcp`).
//!
//! Everything the page can do is a tool of that server, and a tool the server does not list (or a
//! read-only connection) hides the matching action. No binary, no page.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use rune::{TextEdit, Tx};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::app::{Hooked, Page};
use crate::fmt;
use crate::incmcp::Client;

const PAGE_SIZE: u64 = 50;
/// How old a list gets before the open page reads it again.
const FRESH_MS: i64 = 60_000;
/// The pace of everything that runs while the page is closed: the badge, and a new look for a
/// binary that was missing or failing.
const BACKGROUND_MS: i64 = 5 * 60_000;
/// Two incidents further apart than this are not offered as look-alikes.
const ALIKE_WINDOW_MS: i64 = 72 * 3_600_000;

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct Named {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct Status {
    pub id: String,
    pub name: String,
    pub category: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct Role {
    pub role: String,
    pub role_id: String,
    pub user: String,
    pub user_id: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct MergedInto {
    pub id: String,
    pub reference: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct You {
    pub participant: bool,
}

/// One row of `incident_list`.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct Inc {
    pub id: String,
    pub external_id: u64,
    pub reference: String,
    pub name: String,
    pub status: Status,
    pub severity: Option<Named>,
    pub incident_type: Option<Named>,
    pub mode: String,
    pub visibility: String,
    pub reported_at: String,
    pub updated_at: String,
    pub summary: Option<String>,
    pub permalink: String,
    pub roles: Vec<Role>,
    pub merged_into: Option<MergedInto>,
    pub you: You,
}

impl Inc {
    pub fn lead(&self) -> Option<&Role> {
        self.roles
            .iter()
            .find(|r| r.role.to_lowercase().contains("lead"))
    }

    pub fn open(&self) -> bool {
        matches!(
            self.status.category.as_str(),
            "triage" | "active" | "paused"
        )
    }

    /// Whether `user` takes part: the list says so for the caller, the roles for anyone.
    pub fn involves(&self, user: Option<&str>) -> bool {
        self.you.participant || user.is_some_and(|u| self.roles.iter().any(|r| r.user_id == u))
    }
}

pub struct Scope {
    pub key: &'static str,
    pub label: &'static str,
    pub categories: &'static [&'static str],
    pub mine: bool,
}

pub const SCOPES: [Scope; 5] = [
    Scope {
        key: "open",
        label: "Open",
        categories: &["triage", "active", "paused"],
        mine: false,
    },
    Scope {
        key: "mine",
        label: "Mine",
        categories: &["triage", "active", "paused", "post-incident"],
        mine: true,
    },
    Scope {
        key: "post",
        label: "Post-incident",
        categories: &["post-incident"],
        mine: false,
    },
    Scope {
        key: "closed",
        label: "Closed",
        categories: &["closed"],
        mine: false,
    },
    Scope {
        key: "merged",
        label: "Merged",
        categories: &["merged"],
        mine: false,
    },
];
const MINE: usize = 1;
const OPEN: usize = 0;
/// How often the open list is read in the background for the "new incident" notification.
const NOTIFY_MS: i64 = 2 * 60_000;

/// Open incidents not in the previous read. The first read only seeds: what was open when the
/// app started is not news.
pub fn new_incidents<'a>(seen: Option<&HashSet<String>>, items: &'a [Inc]) -> Vec<&'a Inc> {
    let Some(seen) = seen else {
        return Vec::new();
    };
    items.iter().filter(|i| !seen.contains(&i.id)).collect()
}

#[derive(Default)]
pub struct List {
    pub items: Vec<Inc>,
    pub total: Option<u64>,
    pub cursor: Option<String>,
    pub loaded_at: Option<i64>,
    pub loading: bool,
    pub error: Option<String>,
    /// Counts the reads started, so an answer that a newer read overtook is dropped.
    pub reads: u64,
}

pub struct ListPage {
    pub items: Vec<Inc>,
    pub total: Option<u64>,
    pub cursor: Option<String>,
}

/// What `config://organisation` says that the page needs: who is calling, how severities rank,
/// which roles exist. The resource is Markdown, so this reads its bullet lines.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Org {
    pub me: Option<String>,
    pub me_name: Option<String>,
    /// The caller's teams: id, name.
    pub teams: Vec<(String, String)>,
    /// id, name, rank (higher is more severe).
    pub severities: Vec<(String, String, i64)>,
    /// id, name.
    pub roles: Vec<(String, String)>,
}

impl Org {
    pub fn rank(&self, severity: Option<&Named>) -> Option<i64> {
        let s = severity?;
        self.severities
            .iter()
            .find(|x| x.0 == s.id || x.1 == s.name)
            .map(|x| x.2)
    }

    pub fn top_rank(&self) -> i64 {
        self.severities.iter().map(|x| x.2).max().unwrap_or(0)
    }
}

/// `- **Name** rest` as (name, rest).
fn bullet(line: &str) -> Option<(&str, &str)> {
    let rest = line.strip_prefix("- **")?;
    let end = rest.find("**")?;
    Some((&rest[..end], rest[end + 2..].trim_start()))
}

fn ticked(s: &str) -> Option<&str> {
    let rest = s.strip_prefix('`')?;
    Some(&rest[..rest.find('`')?])
}

pub fn parse_org(md: &str) -> Org {
    let mut org = Org::default();
    let mut section = "";
    let mut in_teams = false;
    for line in md.lines() {
        if let Some(h) = line.strip_prefix("## ") {
            section = h.trim();
            in_teams = false;
            continue;
        }
        // Under "Teams:", one team per line indented once; its schedules sit one level deeper.
        if in_teams
            && let Some((name, id)) = line.strip_prefix("  - ").and_then(|l| l.split_once(" `"))
            && let Some(id) = id.strip_suffix('`')
        {
            org.teams.push((id.to_string(), name.trim().to_string()));
            continue;
        }
        let Some((name, rest)) = bullet(line) else {
            continue;
        };
        in_teams = section == "You" && name == "Teams:";
        match section {
            "You" => match name {
                "Name:" => org.me_name = Some(rest.to_string()).filter(|n| !n.is_empty()),
                "User ID:" => org.me = ticked(rest).map(str::to_string),
                _ => {}
            },
            "Severities" => {
                let rank = rest
                    .strip_prefix("(rank ")
                    .and_then(|r| r.split_once(')'))
                    .and_then(|(n, after)| Some((n.trim().parse().ok()?, after.trim_start())));
                if let Some((rank, after)) = rank
                    && let Some(id) = ticked(after)
                {
                    org.severities
                        .push((id.to_string(), name.to_string(), rank));
                }
            }
            "Incident roles" => {
                if let Some(id) = ticked(rest) {
                    org.roles.push((id.to_string(), name.to_string()));
                }
            }
            _ => {}
        }
    }
    org
}

/// The pinned incident's number from `incident_pin`'s sentence, which carries nothing else.
pub fn parse_pinned(v: &Value) -> Option<u64> {
    if let Some(n) = v["external_id"].as_u64().or(v["incident_id"].as_u64()) {
        return Some(n);
    }
    let text = v.as_str()?;
    let digits: String = text
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

const STOPWORDS: [&str; 22] = [
    "the", "and", "for", "with", "from", "into", "has", "have", "are", "was", "not", "des", "les",
    "une", "sur", "dans", "pour", "est", "pas", "aux", "avec", "par",
];

/// The words of a name that say what broke: no pod hashes, replica suffixes or small words.
pub fn name_tokens(name: &str) -> BTreeSet<String> {
    name.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() >= 3)
        .filter(|t| !t.chars().any(|c| c.is_ascii_digit()))
        .filter(|t| !STOPWORDS.contains(t))
        .map(str::to_string)
        .collect()
}

fn alike(a: &BTreeSet<String>, b: &BTreeSet<String>) -> bool {
    let shared = a.intersection(b).count();
    shared >= 2 && shared * 2 >= a.union(b).count()
}

/// Groups of open incidents whose names share most of their words, reported within three days of
/// each other: candidates for a merge, for a person to judge. Indices into `items`, the group
/// with the most incidents first.
pub fn look_alike(items: &[Inc]) -> Vec<Vec<usize>> {
    let cands: Vec<(usize, BTreeSet<String>, Option<i64>)> = items
        .iter()
        .enumerate()
        .filter(|(_, i)| i.open() && mergeable(i).is_ok())
        .map(|(n, i)| (n, name_tokens(&i.name), fmt::parse_ts(&i.reported_at)))
        .collect();
    let mut group: Vec<usize> = (0..cands.len()).collect();
    fn root(group: &mut [usize], mut i: usize) -> usize {
        while group[i] != i {
            group[i] = group[group[i]];
            i = group[i];
        }
        i
    }
    for a in 0..cands.len() {
        for b in a + 1..cands.len() {
            let near = match (cands[a].2, cands[b].2) {
                (Some(x), Some(y)) => (x - y).abs() <= ALIKE_WINDOW_MS,
                _ => false,
            };
            if near && alike(&cands[a].1, &cands[b].1) {
                let (ra, rb) = (root(&mut group, a), root(&mut group, b));
                group[ra] = rb;
            }
        }
    }
    let mut out: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..cands.len() {
        let r = root(&mut group, i);
        out.entry(r).or_default().push(cands[i].0);
    }
    let mut clusters: Vec<Vec<usize>> = out.into_values().filter(|c| c.len() > 1).collect();
    clusters.sort_by(|a, b| b.len().cmp(&a.len()).then(a.cmp(b)));
    clusters
}

/// What `incident_merge` refuses on either side of a merge.
pub fn mergeable(i: &Inc) -> Result<(), &'static str> {
    match (i.status.category.as_str(), i.mode.as_str()) {
        ("merged", _) => Err("already merged"),
        ("canceled", _) => Err("canceled"),
        (_, "stream") => Err("a stream"),
        _ => Ok(()),
    }
}

fn target_rank(i: &Inc) -> u8 {
    match i.status.category.as_str() {
        "active" => 0,
        "paused" => 1,
        "post-incident" => 2,
        "triage" => 3,
        _ => 4,
    }
}

/// The incident a merge should keep: the one already being worked, else the oldest.
pub fn default_target(items: &[Inc]) -> Option<String> {
    items
        .iter()
        .filter(|i| mergeable(i).is_ok())
        .min_by(|a, b| {
            target_rank(a)
                .cmp(&target_rank(b))
                .then(a.reported_at.cmp(&b.reported_at))
        })
        .map(|i| i.id.clone())
}

pub struct MergeForm {
    pub items: Vec<Inc>,
    /// One of `items`, unless `other` names an incident outside the selection.
    pub target: Option<String>,
    pub other: TextEdit,
    pub busy: bool,
    pub error: Option<String>,
}

pub struct MergePlan<'a> {
    /// What the tool is told to merge into, and how to name it to a person.
    pub target: Option<(String, String)>,
    pub sources: Vec<&'a Inc>,
    pub skipped: Vec<(&'a Inc, &'static str)>,
}

/// `inc-12`, `12` and `INC-12` all name INC-12.
pub fn normalize_reference(text: &str) -> Option<String> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    let digits = t
        .strip_prefix("INC-")
        .or_else(|| t.strip_prefix("inc-"))
        .unwrap_or(t);
    if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
        Some(format!("INC-{digits}"))
    } else {
        Some(t.to_string())
    }
}

impl MergeForm {
    pub fn new(items: Vec<Inc>) -> MergeForm {
        MergeForm {
            // One incident alone is the source: its target is typed.
            target: default_target(&items).filter(|_| items.len() > 1),
            items,
            other: TextEdit::new(""),
            busy: false,
            error: None,
        }
    }

    pub fn plan(&self) -> MergePlan<'_> {
        let outside = normalize_reference(&self.other.text);
        let inside = self
            .target
            .as_ref()
            .and_then(|t| self.items.iter().find(|i| &i.id == t))
            .filter(|i| mergeable(i).is_ok());
        let target = match (&outside, inside) {
            (Some(r), _) => Some((r.clone(), r.clone())),
            (None, Some(i)) => Some((i.id.clone(), i.reference.clone())),
            (None, None) => None,
        };
        let mut sources = Vec::new();
        let mut skipped = Vec::new();
        for i in &self.items {
            if outside.is_none() && inside.is_some_and(|t| t.id == i.id) {
                continue;
            }
            if outside.as_deref() == Some(i.reference.as_str()) {
                skipped.push((i, "the target"));
                continue;
            }
            match mergeable(i) {
                Ok(()) => sources.push(i),
                Err(why) => skipped.push((i, why)),
            }
        }
        MergePlan {
            target,
            sources,
            skipped,
        }
    }
}

impl MergePlan<'_> {
    /// The arguments of the one `incident_merge` call, or why there is nothing to send.
    pub fn args(&self) -> Result<Value, String> {
        let Some((target, _)) = self.target.as_ref() else {
            return Err("Pick the incident to keep.".into());
        };
        if self.sources.is_empty() {
            return Err("Nothing left to merge into it.".into());
        }
        Ok(json!({
            "incident_ids": self.sources.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            "merged_into_incident_id": target,
        }))
    }
}

pub struct RoleForm {
    pub incident: String,
    pub reference: String,
    pub role_id: String,
    pub role: String,
    /// Who holds the role now, and loses it.
    pub holder: Option<String>,
    pub busy: bool,
    pub error: Option<String>,
}

/// The last merge, kept on screen so it can be read and undone.
pub struct Outcome {
    pub target: String,
    pub target_ref: String,
    /// id and reference of what was sent as sources.
    pub sources: Vec<(String, String)>,
    pub lines: Vec<String>,
    pub undoing: bool,
}

fn item_label(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    let name = v["reference"]
        .as_str()
        .or(v["incident"]["reference"].as_str())
        .or(v["name"].as_str())
        .or(v["id"].as_str())?;
    let why = v["reason"]
        .as_str()
        .or(v["message"].as_str())
        .or(v["error"].as_str());
    Some(match why {
        Some(w) => format!("{name} ({w})"),
        None => name.to_string(),
    })
}

/// A tool's answer as lines a person can read, without assuming its keys: each list it holds
/// becomes `key: a, b (why)`.
pub fn outcome_lines(v: &Value) -> Vec<String> {
    let Some(obj) = v.as_object() else {
        return v.as_str().map(|s| vec![s.to_string()]).unwrap_or_default();
    };
    obj.iter()
        .filter_map(|(key, val)| {
            let items: Vec<String> = val.as_array()?.iter().filter_map(item_label).collect();
            (!items.is_empty()).then(|| format!("{}: {}", key.replace('_', " "), items.join(", ")))
        })
        .collect()
}

/// The Slack app's own link to a channel (`slack://channel?team=…&id=…`). Rune opens web links
/// only, so this one is handed to the system directly, and no other scheme is.
pub fn slack_deep_link(url: &str) -> bool {
    url.starts_with("slack://") && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Hands a link to the system's handler; false when nothing took it.
pub fn system_open(url: &str) -> bool {
    if cfg!(target_os = "macos") {
        std::process::Command::new("/usr/bin/open")
            .arg(url)
            .status()
            .is_ok_and(|s| s.success())
    } else {
        false
    }
}

pub fn claude_prompt(reference: &str, name: &str, permalink: &str) -> String {
    format!(
        "Look into incident {reference} \"{name}\" ({permalink}) with the incident.io tools: read the incident, its alerts and its investigation, then tell me what is going on and what you would check next. Read only: do not change the incident or post anything in its channel without asking me first."
    )
}

#[derive(Clone, Debug, PartialEq)]
pub enum Avail {
    /// No binary on this machine: the page does not exist.
    Off,
    Checking,
    Ready,
    Failed(String),
}

pub struct Hello {
    pub tools: HashSet<String>,
    pub writable: bool,
    pub org: Org,
    pub pinned: Option<u64>,
}

/// The first exchange: what the server can do, with which rights, for whom.
pub fn hello(c: &Client) -> Result<Hello, String> {
    let tools: HashSet<String> = c.tools()?.into_iter().collect();
    if !tools.contains("incident_list") {
        return Err("the incident.io server lists no incident tools".into());
    }
    // A missing answer is not a refusal: only an explicit read-only level hides the writes.
    let writable = match tools
        .contains("identity_show")
        .then(|| c.tool("identity_show", json!({})))
    {
        Some(Ok(v)) => v["access_level"]
            .as_str()
            .is_none_or(|l| l.contains("write")),
        Some(Err(e)) => return Err(e),
        None => true,
    };
    let org = c
        .resource("config://organisation")
        .map(|md| parse_org(&md))
        .unwrap_or_default();
    let pinned = tools
        .contains("incident_pin")
        .then(|| c.tool("incident_pin", json!({})).ok())
        .flatten()
        .and_then(|v| parse_pinned(&v));
    Ok(Hello {
        tools,
        writable,
        org,
        pinned,
    })
}

/// Who a list is read for: the caller, and the teams the lists are narrowed to.
#[derive(Clone, Debug, Default)]
pub struct Who {
    pub me: Option<String>,
    pub teams: Vec<String>,
}

/// "Mine" is already about one person, so the teams narrow every list but that one.
pub fn list_args(scope: &Scope, who: &Who, after: Option<&str>) -> Value {
    let mut a = json!({
        "page_size": PAGE_SIZE,
        "include": ["summary", "roles"],
        "status_category": scope.categories,
    });
    if scope.mine {
        a["assigned_to"] = json!([who.me.as_deref().unwrap_or("me")]);
    } else if !who.teams.is_empty() {
        a["team_part_of"] = json!(who.teams);
    }
    if let Some(c) = after {
        a["after"] = json!(c);
    }
    a
}

pub fn fetch_list(
    c: &Client,
    scope: &Scope,
    who: &Who,
    after: Option<&str>,
) -> Result<ListPage, String> {
    let v = c.tool("incident_list", list_args(scope, who, after))?;
    let items: Vec<Inc> = crate::api::decode(v["incidents"].clone())?;
    let p = &v["pagination"];
    Ok(ListPage {
        items,
        total: p["total_count"].as_u64(),
        cursor: p["has_more"]
            .as_bool()
            .unwrap_or(false)
            .then(|| p["next_cursor"].as_str().map(str::to_string))
            .flatten(),
    })
}

pub fn fetch_detail(c: &Client, id: &str, investigation: bool) -> Result<Value, String> {
    let include: &[&str] = if investigation {
        &["investigation"]
    } else {
        &[]
    };
    c.tool("incident_show", json!({ "id": id, "include": include }))
}

/// Unmerges each incident in turn (the tool takes one), and says how each went.
pub fn unmerge_all(c: &Client, items: &[(String, String)]) -> Vec<(String, Result<(), String>)> {
    items
        .iter()
        .map(|(id, reference)| {
            let r = c
                .tool("incident_unmerge", json!({ "incident_id": id }))
                .map(|_| ());
            (reference.clone(), r)
        })
        .collect()
}

/// Undoes a merge: the sources that are merged into `target` right now, read back first so an
/// incident that was merged somewhere else before is left alone.
pub fn undo_merge(
    c: &Client,
    target: &str,
    target_ref: &str,
    sources: &[(String, String)],
) -> Vec<(String, Result<(), String>)> {
    let mut out = Vec::new();
    for (id, reference) in sources {
        let r = fetch_detail(c, id, false).and_then(|d| {
            let into = &d["merged_into"];
            let ours = into["id"].as_str() == Some(target)
                || into["reference"].as_str() == Some(target_ref);
            if !ours {
                return Err(format!("not merged into {target_ref}"));
            }
            c.tool("incident_unmerge", json!({ "incident_id": id }))
                .map(|_| ())
        });
        out.push((reference.clone(), r));
    }
    out
}

fn tally(done: &[(String, Result<(), String>)], verb: &str) -> (String, bool) {
    let ok: Vec<&str> = done
        .iter()
        .filter(|d| d.1.is_ok())
        .map(|d| d.0.as_str())
        .collect();
    let ko: Vec<String> = done
        .iter()
        .filter_map(|d| d.1.as_ref().err().map(|e| format!("{} ({e})", d.0)))
        .collect();
    match (ok.is_empty(), ko.is_empty()) {
        (_, true) => (format!("✓ {verb} {}", ok.join(", ")), false),
        (true, false) => (format!("✗ {}", ko.join(", ")), true),
        (false, false) => (
            format!("{verb} {} · ✗ {}", ok.join(", "), ko.join(", ")),
            true,
        ),
    }
}

pub struct Incidents {
    pub client: Option<Arc<Client>>,
    pub avail: Avail,
    /// The tab turned off in Settings.
    pub hidden: bool,
    pub tools: HashSet<String>,
    pub writable: bool,
    pub org: Org,
    pub scope: usize,
    pub lists: [List; SCOPES.len()],
    pub query: TextEdit,
    pub severity: Option<String>,
    /// Team ids the lists are narrowed to; empty for every team.
    pub teams: BTreeSet<String>,
    pub selected: BTreeSet<String>,
    pub open: Option<String>,
    pub details: HashMap<String, Result<Value, String>>,
    pub detail_loading: HashSet<String>,
    pub pinned: Option<u64>,
    pub merge: Option<MergeForm>,
    pub role: Option<RoleForm>,
    pub outcome: Option<Outcome>,
    pub dismissed: HashSet<String>,
    pub busy: bool,
    pub checked_at: i64,
    /// Ids in the open list as last read; `None` until the first read, which only seeds it.
    pub seen_open: Option<HashSet<String>>,
}

impl Incidents {
    pub fn new(hidden: bool, teams: BTreeSet<String>) -> Incidents {
        Incidents {
            teams,
            ..Incidents::with(
                crate::incmcp::find_bin().map(|b| Arc::new(Client::new(b))),
                hidden,
            )
        }
    }

    fn with(client: Option<Arc<Client>>, hidden: bool) -> Incidents {
        Incidents {
            avail: if client.is_some() {
                Avail::Checking
            } else {
                Avail::Off
            },
            client,
            hidden,
            tools: HashSet::new(),
            writable: false,
            org: Org::default(),
            scope: 0,
            lists: Default::default(),
            query: TextEdit::new(""),
            severity: None,
            teams: BTreeSet::new(),
            selected: BTreeSet::new(),
            open: None,
            details: HashMap::new(),
            detail_loading: HashSet::new(),
            pinned: None,
            merge: None,
            role: None,
            outcome: None,
            dismissed: HashSet::new(),
            busy: false,
            checked_at: 0,
            seen_open: None,
        }
    }

    pub fn ready(&self) -> bool {
        self.avail == Avail::Ready
    }

    /// Whether the server offers `tool`, and for a write, whether the connection may write.
    pub fn can(&self, tool: &str) -> bool {
        let write = !matches!(tool, "incident_list" | "incident_show" | "incident_pin");
        self.ready() && self.tools.contains(tool) && (self.writable || !write)
    }

    pub fn find(&self, id: &str) -> Option<&Inc> {
        self.lists[self.scope]
            .items
            .iter()
            .chain(self.lists.iter().flat_map(|l| l.items.iter()))
            .find(|i| i.id == id)
    }

    /// The current list after the text and severity filters.
    pub fn shown(&self) -> Vec<&Inc> {
        let q = self.query.text.trim().to_lowercase();
        let words: Vec<&str> = q.split_whitespace().collect();
        self.lists[self.scope]
            .items
            .iter()
            .filter(|i| {
                self.severity.is_none()
                    || i.severity.as_ref().map(|s| &s.name) == self.severity.as_ref()
            })
            .filter(|i| {
                let hay = format!(
                    "{} {} {} {} {}",
                    i.reference,
                    i.name,
                    i.status.name,
                    i.incident_type.as_ref().map_or("", |t| t.name.as_str()),
                    i.lead().map_or("", |r| r.user.as_str()),
                )
                .to_lowercase();
                words.iter().all(|w| hay.contains(w))
            })
            .collect()
    }

    /// Open incidents the caller takes part in, for the tab's badge.
    pub fn mine_open(&self) -> usize {
        self.lists[MINE]
            .items
            .iter()
            .filter(|i| matches!(i.status.category.as_str(), "triage" | "active"))
            .count()
    }

    fn apply(&mut self, h: Hello) {
        self.tools = h.tools;
        self.writable = h.writable;
        self.org = h.org;
        self.pinned = h.pinned;
        self.avail = Avail::Ready;
        // A team the caller left would narrow the lists with no chip to show it.
        if !self.org.teams.is_empty() {
            let mine = &self.org.teams;
            self.teams.retain(|t| mine.iter().any(|m| &m.0 == t));
        }
    }

    pub fn who(&self) -> Who {
        Who {
            me: self.org.me.clone(),
            teams: self.teams.iter().cloned().collect(),
        }
    }

    fn stale(&mut self) {
        for l in &mut self.lists {
            l.loaded_at = None;
            l.loading = false;
            l.reads += 1;
        }
    }
}

impl Hooked {
    /// The tab, the palette entry and the shortcut exist only while this holds.
    pub fn incidents_on(&self) -> bool {
        self.inc.ready() && !self.inc.hidden && !self.incognito
    }

    pub fn go_incidents(&mut self) {
        if self.incidents_on() {
            self.go(Page::Incidents);
        }
    }

    /// The synchronous start, for headless renders.
    pub fn preload_incidents(&mut self) {
        let Some(c) = self.inc.client.clone() else {
            return;
        };
        match hello(&c) {
            Ok(h) => self.inc.apply(h),
            Err(e) => {
                self.inc.avail = Avail::Failed(e);
                return;
            }
        }
        // `--scope merged`, `--team`, `--incident INC-12` and `--merge` set a snapshot up.
        let args = rune::extra_args();
        let after = |flag: &str| {
            let at = args.iter().position(|a| a == flag)?;
            args.get(at + 1).cloned()
        };
        if let Some(n) = after("--scope").and_then(|k| SCOPES.iter().position(|s| s.key == k)) {
            self.inc.scope = n;
        }
        if args.iter().any(|a| a == "--team")
            && let Some(t) = self.inc.org.teams.first()
        {
            self.inc.teams.insert(t.0.clone());
        }
        let who = self.inc.who();
        for n in [self.inc.scope, MINE] {
            let l = &mut self.inc.lists[n];
            l.loaded_at = Some(fmt::now_ms());
            match fetch_list(&c, &SCOPES[n], &who, None) {
                Ok(p) => (l.items, l.total, l.cursor) = (p.items, p.total, p.cursor),
                Err(e) => l.error = Some(e),
            }
        }
        let list = &self.inc.lists[self.inc.scope];
        if let Some(id) = after("--incident")
            .and_then(|r| list.items.iter().find(|i| i.reference == r))
            .map(|i| i.id.clone())
        {
            self.inc
                .details
                .insert(id.clone(), fetch_detail(&c, &id, true));
            self.inc.open = Some(id);
        }
        if args.iter().any(|a| a == "--merge")
            && let Some(group) = look_alike(&list.items).first()
        {
            let ids: Vec<String> = group.iter().map(|&i| list.items[i].id.clone()).collect();
            self.inc.selected.extend(ids.iter().cloned());
            self.start_merge(ids);
        }
    }

    pub fn check_incidents(&mut self) {
        self.inc.checked_at = fmt::now_ms();
        if self.inc.client.is_none() {
            self.inc = Incidents {
                checked_at: self.inc.checked_at,
                ..Incidents::new(self.inc.hidden, std::mem::take(&mut self.inc.teams))
            };
        }
        let Some(c) = self.inc.client.clone() else {
            return;
        };
        self.spawn(
            move || hello(&c),
            |s, r, _| match r {
                Ok(h) => s.inc.apply(h),
                Err(e) => s.inc.avail = Avail::Failed(e),
            },
        );
    }

    /// Runs with the app: the first check, the badge, and another look for a binary that was
    /// missing or failing.
    pub fn poll_incidents(&mut self, now: i64) {
        if self.handle.is_none() || self.inc.hidden {
            return;
        }
        let due = now - self.inc.checked_at > BACKGROUND_MS;
        if !self.inc.ready() {
            if self.inc.checked_at == 0 || due {
                self.check_incidents();
            }
            return;
        }
        let mine = &self.inc.lists[MINE];
        if !mine.loading && mine.loaded_at.is_none_or(|t| now - t > BACKGROUND_MS) {
            self.load_incidents(MINE, false);
        }
        // The open list feeds the "new incident" notification.
        let open = &self.inc.lists[OPEN];
        if !open.loading && open.loaded_at.is_none_or(|t| now - t > NOTIFY_MS) {
            self.load_incidents(OPEN, false);
        }
    }

    /// Reads the open list again when it is missing or old; true when a load started.
    pub fn ensure_incidents(&mut self) -> bool {
        if !self.inc.ready() {
            return false;
        }
        let now = fmt::now_ms();
        let n = self.inc.scope;
        let l = &self.inc.lists[n];
        if l.loading || l.loaded_at.is_some_and(|t| now - t <= FRESH_MS) {
            return false;
        }
        self.load_incidents(n, false);
        if let Some(id) = self.inc.open.clone() {
            self.load_incident(id, true);
        }
        true
    }

    pub fn load_incidents(&mut self, n: usize, more: bool) {
        let Some(c) = self.inc.client.clone() else {
            return;
        };
        let l = &mut self.inc.lists[n];
        let after = if more { l.cursor.clone() } else { None };
        if l.loading || (more && after.is_none()) {
            return;
        }
        l.loading = true;
        l.reads += 1;
        let read = l.reads;
        let who = self.inc.who();
        self.spawn(
            move || fetch_list(&c, &SCOPES[n], &who, after.as_deref()),
            move |s, r, _| {
                let l = &mut s.inc.lists[n];
                if l.reads != read {
                    return;
                }
                l.loading = false;
                l.loaded_at = Some(fmt::now_ms());
                match r {
                    Ok(p) => {
                        l.error = None;
                        l.total = p.total;
                        l.cursor = p.cursor;
                        if n == OPEN && !more {
                            let fresh = new_incidents(s.inc.seen_open.as_ref(), &p.items);
                            s.inc.seen_open = Some(p.items.iter().map(|i| i.id.clone()).collect());
                            if s.notify {
                                for i in fresh {
                                    let sev = i.severity.as_ref().map(|x| x.name.as_str()).unwrap_or("");
                                    crate::tray::notify_link(
                                        &format!("inc-{}", i.id),
                                        &format!("New incident {}", i.reference),
                                        &if sev.is_empty() { i.name.clone() } else { format!("{sev} · {}", i.name) },
                                        "incident",
                                        &i.id,
                                    );
                                }
                            }
                        }
                        if more {
                            let known: HashSet<String> =
                                l.items.iter().map(|i| i.id.clone()).collect();
                            l.items
                                .extend(p.items.into_iter().filter(|i| !known.contains(&i.id)));
                        } else {
                            l.items = p.items;
                        }
                        if n == s.inc.scope {
                            let here: HashSet<&str> =
                                s.inc.lists[n].items.iter().map(|i| i.id.as_str()).collect();
                            let gone: Vec<String> = s
                                .inc
                                .selected
                                .iter()
                                .filter(|id| !here.contains(id.as_str()))
                                .cloned()
                                .collect();
                            for id in gone {
                                s.inc.selected.remove(&id);
                            }
                        }
                    }
                    Err(e) => l.error = Some(e),
                }
            },
        );
    }

    pub fn refresh_incidents(&mut self) {
        self.inc.stale();
        self.inc.details.clear();
        if let Some(id) = self.inc.open.clone() {
            self.load_incident(id, false);
        }
        self.ensure_incidents();
    }

    pub fn set_incident_scope(&mut self, n: usize) {
        if n < SCOPES.len() && n != self.inc.scope {
            self.inc.scope = n;
            self.inc.selected.clear();
            self.inc.severity = None;
            self.ensure_incidents();
        }
    }

    /// Narrows every list but "Mine" to a team (and its sub-teams), or lifts that.
    pub fn toggle_incident_team(&mut self, id: &str) {
        if !self.inc.teams.remove(id) {
            self.inc.teams.insert(id.to_string());
        }
        let saved: Vec<String> = self.inc.teams.iter().cloned().collect();
        self.save_pref("incidentsTeams", &saved);
        self.inc.selected.clear();
        self.inc.severity = None;
        for (l, scope) in self.inc.lists.iter_mut().zip(&SCOPES) {
            if !scope.mine {
                // A count read for another team would sit on the tab until its list is opened.
                *l = List {
                    reads: l.reads + 1,
                    ..List::default()
                };
            }
        }
        self.ensure_incidents();
    }

    pub fn peek_incident(&mut self, id: String) {
        if self.inc.open.as_deref() == Some(id.as_str()) {
            self.inc.open = None;
            return;
        }
        self.inc.open = Some(id.clone());
        self.load_incident(id, false);
    }

    /// `quiet` keeps what is on screen until the new answer lands.
    pub fn load_incident(&mut self, id: String, quiet: bool) {
        let Some(c) = self.inc.client.clone() else {
            return;
        };
        if (!quiet && self.inc.details.contains_key(&id))
            || !self.inc.detail_loading.insert(id.clone())
        {
            return;
        }
        let key = id.clone();
        self.spawn(
            move || fetch_detail(&c, &id, true),
            move |s, r, _| {
                s.inc.detail_loading.remove(&key);
                if let Ok(d) = r.as_ref()
                    && s.inc.org.me.is_none()
                {
                    s.inc.org.me = d["you"]["user_id"].as_str().map(str::to_string);
                }
                if r.is_ok() || !s.inc.details.get(&key).is_some_and(Result::is_ok) {
                    s.inc.details.insert(key, r);
                }
            },
        );
    }

    pub fn toggle_incident(&mut self, id: &str) {
        if !self.inc.selected.remove(id) {
            self.inc.selected.insert(id.to_string());
        }
    }

    pub fn select_shown_incidents(&mut self) {
        let ids: Vec<String> = self.inc.shown().iter().map(|i| i.id.clone()).collect();
        if ids.iter().all(|id| self.inc.selected.contains(id)) {
            self.inc.selected.clear();
        } else {
            self.inc.selected.extend(ids);
        }
    }

    pub fn start_merge(&mut self, ids: Vec<String>) {
        let items: Vec<Inc> = ids
            .iter()
            .filter_map(|id| self.inc.find(id).cloned())
            .collect();
        if !items.is_empty() && self.inc.can("incident_merge") {
            self.inc.merge = Some(MergeForm::new(items));
        }
    }

    pub fn confirm_merge(&mut self) {
        let (Some(c), Some(form)) = (self.inc.client.clone(), self.inc.merge.as_mut()) else {
            return;
        };
        if form.busy {
            return;
        }
        let plan = form.plan();
        let args = match plan.args() {
            Ok(a) => a,
            Err(e) => {
                form.error = Some(e);
                return;
            }
        };
        let (target, target_ref) = plan.target.clone().expect("args checked the target");
        let sources: Vec<(String, String)> = plan
            .sources
            .iter()
            .map(|i| (i.id.clone(), i.reference.clone()))
            .collect();
        form.busy = true;
        form.error = None;
        self.spawn(
            move || c.tool("incident_merge", args),
            move |s, r, _| match r {
                Ok(v) => {
                    let mut lines = outcome_lines(&v);
                    if lines.is_empty() {
                        lines.push(format!(
                            "sent: {}",
                            sources
                                .iter()
                                .map(|x| x.1.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        ));
                    }
                    s.inc.merge = None;
                    s.inc.selected.clear();
                    s.inc.outcome = Some(Outcome {
                        target,
                        target_ref,
                        sources,
                        lines,
                        undoing: false,
                    });
                    s.refresh_incidents();
                }
                Err(e) => {
                    if let Some(f) = s.inc.merge.as_mut() {
                        f.busy = false;
                        f.error = Some(e);
                    }
                }
            },
        );
    }

    pub fn undo_merge(&mut self) {
        let (Some(c), Some(o)) = (self.inc.client.clone(), self.inc.outcome.as_mut()) else {
            return;
        };
        if o.undoing {
            return;
        }
        o.undoing = true;
        let (target, target_ref, sources) =
            (o.target.clone(), o.target_ref.clone(), o.sources.clone());
        self.spawn(
            move || undo_merge(&c, &target, &target_ref, &sources),
            |s, done, _| {
                let (msg, error) = tally(&done, "Unmerged");
                s.inc.outcome = None;
                s.flash(msg, error);
                s.refresh_incidents();
            },
        );
    }

    pub fn unmerge_incidents(&mut self, ids: Vec<String>) {
        let Some(c) = self.inc.client.clone() else {
            return;
        };
        let items: Vec<(String, String)> = ids
            .iter()
            .filter_map(|id| self.inc.find(id))
            .filter(|i| i.status.category == "merged")
            .map(|i| (i.id.clone(), i.reference.clone()))
            .collect();
        if items.is_empty() || self.inc.busy || !self.inc.can("incident_unmerge") {
            return;
        }
        self.inc.busy = true;
        self.spawn(
            move || unmerge_all(&c, &items),
            |s, done, _| {
                let (msg, error) = tally(&done, "Unmerged");
                s.inc.busy = false;
                s.inc.selected.clear();
                s.flash(msg, error);
                s.refresh_incidents();
            },
        );
    }

    /// Pins an incident in the desktop app (what "my incident" means to a Claude session), or
    /// clears the pin. It changes nothing on the incident itself.
    pub fn pin_incident(&mut self, reference: Option<String>) {
        let Some(c) = self.inc.client.clone() else {
            return;
        };
        if self.inc.busy {
            return;
        }
        self.inc.busy = true;
        self.spawn(
            move || {
                let args = match reference.as_ref() {
                    Some(r) => json!({ "incident_id": r }),
                    None => json!({ "unset": true }),
                };
                c.tool("incident_pin", args)?;
                let now = c.tool("incident_pin", json!({}))?;
                Ok::<_, String>((parse_pinned(&now), reference))
            },
            |s, r, _| {
                s.inc.busy = false;
                match r {
                    Ok((pinned, reference)) => {
                        s.inc.pinned = pinned;
                        s.flash(
                            match reference {
                                Some(r) => format!("✓ {r} pinned"),
                                None => "✓ Pin cleared".into(),
                            },
                            false,
                        );
                    }
                    Err(e) => s.flash(format!("✗ Pin: {e}"), true),
                }
            },
        );
    }

    pub fn start_role(&mut self, incident: String, role_id: String) {
        let Some(d) = self
            .inc
            .details
            .get(&incident)
            .and_then(|d| d.as_ref().ok())
        else {
            return;
        };
        let Some(role) = self
            .inc
            .org
            .roles
            .iter()
            .find(|r| r.0 == role_id)
            .map(|r| r.1.clone())
        else {
            return;
        };
        let holder = d["roles"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|r| r["role_id"].as_str() == Some(role_id.as_str()))
            .and_then(|r| r["user"].as_str())
            .map(str::to_string);
        self.inc.role = Some(RoleForm {
            reference: d["reference"].as_str().unwrap_or("").to_string(),
            incident,
            role_id,
            role,
            holder,
            busy: false,
            error: None,
        });
    }

    pub fn confirm_role(&mut self) {
        let (Some(c), Some(me)) = (self.inc.client.clone(), self.inc.org.me.clone()) else {
            return;
        };
        let Some(form) = self.inc.role.as_mut().filter(|f| !f.busy) else {
            return;
        };
        form.busy = true;
        form.error = None;
        let (id, role_id) = (form.incident.clone(), form.role_id.clone());
        let label = format!("{} on {}", form.role, form.reference);
        self.spawn(
            move || {
                c.tool(
                    "incident_update",
                    json!({
                        "incident_id": id,
                        "role_assignments": [{ "role": role_id, "user_id": me }],
                    }),
                )
            },
            move |s, r, _| match r {
                Ok(_) => {
                    s.inc.role = None;
                    s.flash(format!("✓ You are {label}"), false);
                    s.refresh_incidents();
                }
                Err(e) => {
                    if let Some(f) = s.inc.role.as_mut() {
                        f.busy = false;
                        f.error = Some(e);
                    }
                }
            },
        );
    }

    /// Opens a web link, and says so when it cannot.
    pub fn open_web(&mut self, url: &str, tx: &mut Tx) {
        if url.is_empty() || tx.open_url(url).is_err() {
            self.flash(format!("✗ Could not open {url}"), true);
        }
    }

    /// The incident's channel: in the Slack app when the incident carries its link there, else
    /// (no Slack app, another chat platform) through the web link.
    pub fn open_incident_channel(&mut self, deep: String, web: String, tx: &mut Tx) {
        if !slack_deep_link(&deep) {
            let url = if web.is_empty() { deep } else { web };
            self.open_web(&url, tx);
            return;
        }
        self.spawn(
            move || (system_open(&deep), deep, web),
            |s, (opened, deep, web), tx| {
                if opened {
                    return;
                }
                if web.is_empty() {
                    s.flash(format!("✗ Could not open {deep}"), true);
                } else {
                    s.open_web(&web, tx);
                }
            },
        );
    }

    /// Opens the new-session page with a read-only brief about the incident.
    pub fn claude_on_incident(&mut self, id: &str) {
        let Some(i) = self.inc.find(id) else {
            return;
        };
        let prompt = claude_prompt(&i.reference, &i.name, &i.permalink);
        self.go_new(None);
        self.new_prompt = TextEdit::new(prompt);
        self.new_prompt.focused = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inc(n: u64, name: &str, category: &str, hours_ago: i64) -> Inc {
        // Counted back from 2027-01-20 12:00, which leaves room for nineteen days.
        let hour = 20 * 24 + 12 - hours_ago;
        let reported = format!("2027-01-{:02}T{:02}:00:00Z", hour / 24, hour % 24);
        Inc {
            id: format!("ID{n}"),
            external_id: n,
            reference: format!("INC-{n}"),
            name: name.into(),
            status: Status {
                id: String::new(),
                name: category.into(),
                category: category.into(),
            },
            mode: "standard".into(),
            reported_at: reported,
            ..Inc::default()
        }
    }

    const CONFIG: &str = "# Organisation configuration\n\n## You\n\n- **Name:** Ada Lovelace\n- **Email:** ada@acme.example\n- **User ID:** `U-ME`\n- **Teams:**\n  - Platform `T1`\n    - Schedule: Platform on-call `SCHED1`\n  - Data `T2`\n\n## Incident statuses\n\n- **Triage** [triage] `ST1` — New\n\n## Severities\n\nHigher rank = more severe.\n\n- **Critique / Critical** (rank 3) `SEV3` — (FR) : Incidents majeurs.\nExemple:\n\n• Indisponibilité\n- **Moyen / Medium** (rank 1) `SEV1` — text\n- **Not a severity** `X` — no rank\n\n## Incident roles\n\n- **Incident Lead** `ROLE1` — coordinates\n- **Scribe** `ROLE2` — writes\n\n## Custom fields\n\n- **Team** (single-select) `CF1` — owner\n";

    #[test]
    fn the_organisation_config_gives_the_caller_the_ranked_severities_and_the_roles() {
        let org = parse_org(CONFIG);
        assert_eq!(org.me.as_deref(), Some("U-ME"));
        assert_eq!(org.me_name.as_deref(), Some("Ada Lovelace"));
        assert_eq!(
            org.teams,
            vec![
                ("T1".into(), "Platform".into()),
                ("T2".into(), "Data".into())
            ],
            "teams, not their schedules"
        );
        assert_eq!(
            org.severities,
            vec![
                ("SEV3".into(), "Critique / Critical".into(), 3),
                ("SEV1".into(), "Moyen / Medium".into(), 1)
            ]
        );
        assert_eq!(
            org.roles,
            vec![
                ("ROLE1".into(), "Incident Lead".into()),
                ("ROLE2".into(), "Scribe".into())
            ]
        );
        let medium = Named {
            id: "SEV1".into(),
            name: "Moyen / Medium".into(),
        };
        assert_eq!(org.rank(Some(&medium)), Some(1));
        assert_eq!(org.top_rank(), 3);
    }

    #[test]
    fn the_pin_sentence_gives_the_incident_number_or_nothing() {
        assert_eq!(parse_pinned(&json!("No active incident")), None);
        assert_eq!(parse_pinned(&json!("Active incident: 6936")), Some(6936));
        assert_eq!(
            parse_pinned(&json!("Pinned INC-42 (since 14:02)")),
            Some(42)
        );
        assert_eq!(parse_pinned(&json!({ "external_id": 7 })), Some(7));
    }

    #[test]
    fn name_tokens_drop_hashes_and_small_words() {
        let t = name_tokens("Pods in CrashLoopBackOff in recruitment-c67cc8c5d");
        assert_eq!(
            t.into_iter().collect::<Vec<_>>(),
            vec!["crashloopbackoff", "pods", "recruitment"]
        );
    }

    #[test]
    fn look_alikes_group_open_incidents_with_close_names_and_dates() {
        let items = vec![
            inc(
                1,
                "Pods in CrashLoopBackOff in checkout-7c9d8b6f5",
                "triage",
                1,
            ),
            inc(2, "Search latency above 2 s on eu-west", "active", 2),
            inc(
                3,
                "checkout-7c9d8b6f5-x2k9p stuck in CrashLoopBackOff",
                "triage",
                2,
            ),
            inc(
                4,
                "checkout pods CrashLoopBackOff after rollout",
                "active",
                3,
            ),
            // Same words, but closed, merged or a week away: not candidates.
            inc(5, "checkout pods CrashLoopBackOff", "closed", 3),
            inc(6, "checkout pods CrashLoopBackOff", "merged", 3),
            inc(7, "checkout pods CrashLoopBackOff", "triage", 24 * 7),
        ];
        assert_eq!(look_alike(&items), vec![vec![0, 2, 3]]);
    }

    #[test]
    fn a_merge_keeps_the_incident_being_worked_and_skips_what_the_tool_refuses() {
        let items = vec![
            inc(1, "a", "triage", 9),
            inc(2, "b", "active", 2),
            inc(3, "c", "active", 5),
            inc(4, "d", "merged", 1),
            inc(5, "e", "canceled", 1),
        ];
        let form = MergeForm::new(items);
        assert_eq!(form.target.as_deref(), Some("ID3"), "the oldest active one");
        let plan = form.plan();
        assert_eq!(plan.target, Some(("ID3".into(), "INC-3".into())));
        let refs = |v: &[&Inc]| v.iter().map(|i| i.reference.clone()).collect::<Vec<_>>();
        assert_eq!(refs(&plan.sources), ["INC-1", "INC-2"]);
        assert_eq!(
            plan.skipped
                .iter()
                .map(|(i, why)| (i.reference.as_str(), *why))
                .collect::<Vec<_>>(),
            [("INC-4", "already merged"), ("INC-5", "canceled")]
        );
        assert_eq!(
            plan.args(),
            Ok(json!({ "incident_ids": ["ID1", "ID2"], "merged_into_incident_id": "ID3" }))
        );
    }

    #[test]
    fn a_target_outside_the_selection_takes_every_selected_incident() {
        let mut form = MergeForm::new(vec![inc(1, "a", "triage", 9), inc(2, "b", "active", 2)]);
        form.other = TextEdit::new(" 77 ");
        let plan = form.plan();
        assert_eq!(plan.target, Some(("INC-77".into(), "INC-77".into())));
        assert_eq!(plan.sources.len(), 2);
        form.other = TextEdit::new("inc-2");
        let plan = form.plan();
        assert_eq!(
            plan.sources.len(),
            1,
            "the typed target is not its own source"
        );
        assert_eq!(plan.skipped[0].1, "the target");
    }

    #[test]
    fn a_merge_with_no_target_or_no_source_sends_nothing() {
        let only_merged = MergeForm::new(vec![inc(1, "a", "merged", 1), inc(2, "b", "merged", 1)]);
        assert!(only_merged.plan().args().is_err());
        let alone = MergeForm::new(vec![inc(1, "a", "active", 1)]);
        assert!(alone.plan().args().is_err());
    }

    #[test]
    fn an_outcome_reads_as_lines_whatever_its_keys() {
        let v = json!({
            "merged_into": { "reference": "INC-9" },
            "merged": [{ "reference": "INC-1", "name": "a" }, "INC-2"],
            "not_merged": [{ "incident": { "reference": "INC-3" }, "reason": "already canceled" }],
            "empty": [],
        });
        assert_eq!(
            outcome_lines(&v),
            vec![
                "merged: INC-1, INC-2".to_string(),
                "not merged: INC-3 (already canceled)".to_string()
            ]
        );
        assert_eq!(outcome_lines(&json!("done")), vec!["done".to_string()]);
    }

    #[test]
    fn only_the_mine_scope_filters_on_the_caller() {
        let me = Who {
            me: Some("U1".into()),
            teams: vec![],
        };
        let open = list_args(&SCOPES[0], &me, None);
        assert!(open.get("assigned_to").is_none());
        assert_eq!(
            open["status_category"],
            json!(["triage", "active", "paused"])
        );
        let mine = list_args(&SCOPES[MINE], &me, Some("CUR"));
        assert_eq!(mine["assigned_to"], json!(["U1"]));
        assert_eq!(mine["after"], json!("CUR"));
        assert_eq!(
            list_args(&SCOPES[MINE], &Who::default(), None)["assigned_to"],
            json!(["me"])
        );
    }

    #[test]
    fn only_a_slack_link_is_handed_to_the_system() {
        assert!(slack_deep_link("slack://channel?team=T1&id=C1"));
        for other in [
            "",
            "https://slack.com/app_redirect?team=T1&channel=C1",
            "file:///etc/passwd",
            "slack://channel?team=T1 --args x",
            "x-slack://channel",
        ] {
            assert!(!slack_deep_link(other), "{other}");
        }
    }

    #[test]
    fn the_teams_narrow_every_list_but_mine() {
        let who = Who {
            me: Some("U1".into()),
            teams: vec!["T1".into(), "T2".into()],
        };
        for scope in &SCOPES {
            let a = list_args(scope, &who, None);
            if scope.mine {
                assert!(a.get("team_part_of").is_none(), "{}", scope.key);
            } else {
                assert_eq!(a["team_part_of"], json!(["T1", "T2"]), "{}", scope.key);
            }
        }
        assert!(
            list_args(&SCOPES[0], &Who::default(), None)
                .get("team_part_of")
                .is_none()
        );
    }

    #[test]
    fn an_action_needs_its_tool_and_a_write_needs_a_connection_that_may_write() {
        let mut inc = Incidents::with(None, false);
        assert_eq!(inc.avail, Avail::Off);
        inc.tools = ["incident_list", "incident_merge", "incident_pin"]
            .map(String::from)
            .into();
        inc.writable = true;
        assert!(
            !inc.can("incident_list"),
            "nothing before the server answered"
        );
        inc.avail = Avail::Ready;
        assert!(inc.can("incident_list") && inc.can("incident_merge"));
        assert!(
            !inc.can("incident_unmerge"),
            "a tool the server does not list"
        );
        inc.writable = false;
        assert!(inc.can("incident_list") && inc.can("incident_pin"));
        assert!(!inc.can("incident_merge"), "a read-only connection");
    }

    fn fake() -> Option<Client> {
        let bin =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scripts/fake-incident");
        let node = std::process::Command::new("node").arg("--version").output();
        node.is_ok_and(|o| o.status.success())
            .then(|| Client::new(bin))
    }

    /// The whole path against the stand-in server: never a real incident.
    #[test]
    fn against_the_stand_in_server_a_merge_lands_and_its_undo_restores_it() {
        let Some(c) = fake() else {
            eprintln!("skipped: node is not on PATH");
            return;
        };
        let h = hello(&c).expect("handshake");
        assert!(h.writable && h.tools.contains("incident_merge"));
        assert_eq!(h.org.me.as_deref(), Some("U-ME"));
        assert_eq!(h.pinned, None);

        let who = Who {
            me: h.org.me.clone(),
            teams: vec![],
        };
        let all = Who::default();
        let open = fetch_list(&c, &SCOPES[0], &who, None).expect("open list");
        assert_eq!(open.total, Some(8));
        let alike = look_alike(&open.items);
        let first: Vec<&str> = alike[0]
            .iter()
            .map(|&i| open.items[i].reference.as_str())
            .collect();
        assert_eq!(first, ["INC-412", "INC-411", "INC-409"]);

        let form = MergeForm::new(alike[0].iter().map(|&i| open.items[i].clone()).collect());
        let plan = form.plan();
        let (target, target_ref) = plan.target.clone().expect("a target");
        assert_eq!(target_ref, "INC-409", "the one already being investigated");
        let sources: Vec<(String, String)> = plan
            .sources
            .iter()
            .map(|i| (i.id.clone(), i.reference.clone()))
            .collect();
        let out = c
            .tool("incident_merge", plan.args().unwrap())
            .expect("merge");
        assert_eq!(outcome_lines(&out), ["merged: INC-412, INC-411"]);
        let after = fetch_list(&c, &SCOPES[0], &all, None).unwrap();
        assert_eq!(after.total, Some(6));
        let d = fetch_detail(&c, "INC-412", true).unwrap();
        assert_eq!(d["merged_into"]["reference"], "INC-409");

        let undone = undo_merge(&c, &target, &target_ref, &sources);
        assert!(undone.iter().all(|u| u.1.is_ok()), "{undone:?}");
        assert_eq!(
            fetch_list(&c, &SCOPES[0], &all, None).unwrap().total,
            Some(8)
        );
        // INC-393 was merged into something else long ago: an undo must not touch it.
        let other = undo_merge(
            &c,
            &target,
            &target_ref,
            &[("INC-393".into(), "INC-393".into())],
        );
        assert_eq!(other[0].1, Err("not merged into INC-409".into()));

        assert_eq!(
            h.org.teams,
            vec![("TEAM-PLATFORM".into(), "Platform".into())]
        );
        let team = Who {
            me: h.org.me.clone(),
            teams: vec!["TEAM-PLATFORM".into()],
        };
        let ours = fetch_list(&c, &SCOPES[0], &team, None).unwrap();
        assert_eq!(
            ours.total,
            Some(5),
            "the open incidents of the caller's team"
        );
        let mine = fetch_list(&c, &SCOPES[MINE], &team, None).unwrap();
        assert_eq!(mine.total, Some(3), "Mine ignores the teams");
        let mine = fetch_list(&c, &SCOPES[MINE], &who, None).unwrap();
        assert!(mine.items.iter().all(|i| i.involves(Some("U-ME"))));
        assert_eq!(
            c.tool("incident_show", json!({ "id": "INC-1" })),
            Err("incident not found".into())
        );
        c.tool("incident_pin", json!({ "incident_id": "INC-409" }))
            .unwrap();
        assert_eq!(
            parse_pinned(&c.tool("incident_pin", json!({})).unwrap()),
            Some(409)
        );
    }
}
