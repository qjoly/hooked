//! Connection profiles (the service's `profiles.json`): where a Claude session sends its requests,
//! another Claude account or an Anthropic-compatible server such as LM Studio.
//!
//! The app reads them from `/api/profiles`, shows the one a session runs on, and passes it along
//! wherever the service scopes something to an account: the launch, the rate-limit gauges, the
//! account window, the MCP lens. A session with no profile runs on the main account (the implicit
//! `default` profile).

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::api;
use crate::app::{Hooked, Page};

/// The profile a session runs on, as `/api/sessions` carries it. Absent on the main account.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ProfileRef {
    pub id: String,
    pub label: String,
    pub kind: String,
    /// The profile is no longer in `profiles.json`.
    pub missing: bool,
}

impl ProfileRef {
    pub fn compatible(&self) -> bool {
        self.kind == "compatible"
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProfileModel {
    pub id: String,
    pub label: String,
}

/// One entry of `/api/profiles`. Never carries an env: no token leaves the service.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub models: Vec<ProfileModel>,
    pub implicit: bool,
    /// It has a Claude account of its own, which can be signed in and out.
    pub has_account: bool,
}

impl Profile {
    pub fn compatible(&self) -> bool {
        self.kind == "compatible"
    }

    /// What lists call it: the implicit profile is the main account.
    pub fn name(&self) -> String {
        if self.implicit {
            "Main account".into()
        } else if self.label.is_empty() {
            self.id.clone()
        } else {
            self.label.clone()
        }
    }
}

pub fn list() -> Result<Vec<Profile>, String> {
    let v = api::get("/api/profiles")?;
    api::decode(v["profiles"].clone())
}

/// The models a compatible profile's server offers (`/v1/models`), and why there are none when
/// that failed.
pub fn live_models(id: &str) -> Result<(Vec<ProfileModel>, Option<String>), String> {
    let v = api::get(&format!("/api/profiles/models?profile={}", api::enc(id)))?;
    let models = api::decode(v["models"].clone()).unwrap_or_default();
    Ok((models, v["error"].as_str().map(str::to_string)))
}

/// `add-account`, `probe-server`, `add-server` and `remove-profile` of `POST /api/profiles`.
pub fn action(body: Value) -> Result<Value, String> {
    api::post("/api/profiles", body)
}

/// Resumes a session on another profile. A model is required when either side is a server.
pub fn move_session(
    id: &str,
    profile: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<(), String> {
    api::post(
        "/api/claude",
        json!({ "action": "move", "id": id, "profile": profile, "model": model, "effort": effort }),
    )
    .map(|_| ())
}

/// The model a session runs, as a picker has to mark it. The transcript's last answer says
/// `current`, and it is stale right after a move to another account or server (the old side's model
/// until the next turn), while `launch` is what the service resumed it with. `server_models` is the
/// list of the session's server when it is on one.
pub fn model_key(current: &str, launch: Option<&str>, server_models: Option<&[String]>) -> String {
    let Some(launch) = launch.filter(|l| !l.is_empty()) else {
        return current.to_string();
    };
    let current_fits = match server_models {
        Some(models) if !models.is_empty() => models.iter().any(|m| m == current),
        // A server whose models are not known: any model that is not a Claude one is its own.
        Some(_) => !current.is_empty() && !current.starts_with("claude"),
        None => current.starts_with("claude"),
    };
    if current_fits { current } else { launch }.to_string()
}

/// `?profile=` of a request scoped to an account; nothing for the main one.
pub fn query(profile: Option<&str>) -> String {
    profile.map_or_else(String::new, |p| format!("profile={}", api::enc(p)))
}

impl Hooked {
    pub fn refresh_profiles(&mut self) {
        self.spawn(list, |s, r, _| {
            if let Ok(list) = r {
                s.profiles = list;
            }
        });
    }

    pub fn profile(&self, id: &str) -> Option<&Profile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    /// The profile of a session, `None` for one on the main account (or on a remote instance,
    /// whose profiles are not this service's).
    pub fn profile_of(&self, session: &str) -> Option<ProfileRef> {
        self.session(session)
            .filter(|x| x.remote.is_none())
            .and_then(|x| x.profile.clone())
    }

    /// The model of a session for its pickers and its fork (see [`model_key`]).
    pub fn model_of(&self, x: &crate::api::Session) -> String {
        let profile = x.profile.as_ref().filter(|_| x.remote.is_none());
        let server = profile
            .filter(|p| p.compatible())
            .map(|p| self.models_for(Some(&p.id)).into_iter().map(|(id, _)| id).collect::<Vec<_>>());
        model_key(
            x.model.as_deref().unwrap_or(""),
            x.launch_model.as_deref(),
            server.as_deref(),
        )
    }

    /// The account new sessions start on (account window → "Use for new sessions"), as the
    /// service stores it.
    pub fn default_profile_id(&self) -> Option<String> {
        self.setting("defaultProfile")
            .as_str()
            .filter(|p| !p.is_empty())
            .map(str::to_string)
    }

    /// Whose rate limits the gauges show: the open session's account, else the default one.
    pub fn gauge_profile(&self) -> Option<String> {
        // The new-session screen shows the limits of the account the session is about to run on.
        if self.page == Page::New && self.providers.info(&self.new_provider).is_claude() {
            return self.new_profile_now();
        }
        if self.page == Page::Session {
            if let Some(id) = self.selected.as_deref() {
                return self.profile_of(id).map(|p| p.id);
            }
        }
        self.default_profile_id()
    }

    /// Reads the gauges again, for the account they belong to now.
    pub fn refresh_usage(&mut self) {
        let profile = self.gauge_profile();
        self.usage_wanted = profile.clone();
        self.spawn(
            move || (profile.clone(), api::usage(profile.as_deref())),
            |s, (profile, r), _| s.apply_usage(profile, r),
        );
    }

    /// The same, answered before the first frame (there is no handle to run a task on yet).
    pub fn load_usage(&mut self) {
        let profile = self.gauge_profile();
        self.usage_wanted = profile.clone();
        let r = api::usage(profile.as_deref());
        self.apply_usage(profile, r);
    }

    fn apply_usage(
        &mut self,
        profile: Option<String>,
        r: Result<(Vec<api::Gauge>, Option<api::PiUsage>, Value), String>,
    ) {
        // The open session moved on while this was in flight: its answer is another account's.
        if self.usage_wanted != profile {
            return;
        }
        match r {
            Ok((g, pi, raw)) => {
                self.gauges = g;
                self.pi_usage = pi;
                self.provider_usage = api::parse_provider_usage(&raw);
                // A server has no account, so no limits: nothing to show rather than dashes.
                self.no_limits = profile.is_some()
                    && raw["profile"].as_str() == profile.as_deref()
                    && raw["account"].is_null();
                self.usage = Some(raw);
            }
            // The profile is gone: another account's gauges would be a lie.
            Err(_) if profile.is_some() => {
                self.gauges.clear();
                self.no_limits = true;
            }
            Err(_) => {}
        }
    }

    /// Called from `poll`: the gauges follow the open session's account.
    pub fn sync_usage_profile(&mut self) {
        if self.gauge_profile() != self.usage_wanted {
            self.refresh_usage();
        }
        // The open session's profile: its server's models are read, and a profile this app has
        // not heard of (added since it started) makes the list read again, once per profile.
        let Some(id) = self
            .selected
            .as_deref()
            .and_then(|id| self.profile_of(id))
            .map(|p| p.id)
        else {
            return;
        };
        if self.profile(&id).is_none() {
            if self.profiles_asked.as_deref() != Some(id.as_str()) {
                self.profiles_asked = Some(id);
                self.refresh_profiles();
            }
            return;
        }
        self.ensure_profile_models(Some(&id));
    }

    /// The models a picker offers for `profile` (`None`: the main account): the server's for a
    /// compatible profile, Claude's own otherwise.
    pub fn models_for(&self, profile: Option<&str>) -> Vec<(String, String)> {
        let Some(p) = profile.and_then(|id| self.profile(id)).filter(|p| p.compatible()) else {
            return self.visible_models();
        };
        if !p.models.is_empty() {
            return p.models.iter().map(|m| (m.id.clone(), m.label.clone())).collect();
        }
        self.profile_live
            .get(&p.id)
            .map(|(models, _)| models.iter().map(|m| (m.id.clone(), m.label.clone())).collect())
            .unwrap_or_default()
    }

    /// Why a compatible profile's model list is empty, when its server was asked and said.
    pub fn models_note(&self, profile: Option<&str>) -> Option<String> {
        let p = self.profile(profile?).filter(|p| p.compatible() && p.models.is_empty())?;
        self.profile_live.get(&p.id).and_then(|(_, e)| e.clone())
    }

    /// Whether `profile` is a server, which has no effort levels and takes no Claude model name.
    pub fn is_server(&self, profile: Option<&str>) -> bool {
        profile
            .and_then(|id| self.profile(id))
            .is_some_and(Profile::compatible)
    }

    /// A compatible profile that names no models gets them from its server, once.
    pub fn ensure_profile_models(&mut self, profile: Option<&str>) {
        let Some(p) = profile.and_then(|id| self.profile(id)) else {
            return;
        };
        if !p.compatible() || !p.models.is_empty() || self.profile_live.contains_key(&p.id) {
            return;
        }
        let id = p.id.clone();
        self.profile_live.insert(id.clone(), (Vec::new(), None));
        self.spawn(
            {
                let id = id.clone();
                move || live_models(&id)
            },
            move |s, r, _| {
                let entry = match r {
                    Ok(v) => v,
                    Err(e) => (Vec::new(), Some(e)),
                };
                s.profile_live.insert(id, entry);
            },
        );
    }

    /// The profile a new session starts on: the account set as the default when it still has an
    /// account of its own, until one is picked. `None` is the main account.
    pub fn new_profile_now(&self) -> Option<String> {
        if let Some(p) = &self.new_profile {
            return p.clone();
        }
        self.default_profile_id()
            .filter(|d| self.profile(d).is_some_and(|p| p.has_account))
    }

    /// Picks where the new session goes, and resets the model, which means something else there.
    pub fn pick_new_profile(&mut self, profile: Option<String>) {
        self.new_profile = Some(profile);
        self.reset_new_pickers();
    }

    /// The model and effort of the new session, back to what the profile in force means: a
    /// server's first model and no effort, else the defaults of the Settings.
    pub fn reset_new_pickers(&mut self) {
        let profile = self.new_profile_now();
        self.ensure_profile_models(profile.as_deref());
        if self.is_server(profile.as_deref()) {
            self.new_model = None;
            self.new_effort = None;
            self.fill_server_model();
            return;
        }
        let setting = |s: &Self, key: &str| {
            s.setting(key)
                .as_str()
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        };
        self.new_model = setting(self, "defaultModel");
        self.new_effort = setting(self, "defaultEffort");
    }

    /// A server needs a model named: the first one it offers, until one is picked.
    pub fn fill_server_model(&mut self) {
        let profile = self.new_profile_now();
        if !self.is_server(profile.as_deref()) {
            return;
        }
        let models = self.models_for(profile.as_deref());
        if self.new_model.is_none() || !models.iter().any(|(id, _)| Some(id) == self.new_model.as_ref())
        {
            self.new_model = models.first().map(|(id, _)| id.clone());
        }
    }
}

/// The window that moves a session to another account or server.
#[derive(Default)]
pub struct MoveWin {
    pub id: String,
    pub title: String,
    /// The profile the session is on now (`default` for the main account) and its kind.
    pub from: String,
    pub from_kind: String,
    /// A turn is in progress and would be lost.
    pub working: bool,
    pub target: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub busy: bool,
    pub error: Option<String>,
}

impl MoveWin {
    pub fn from_server(&self) -> bool {
        self.from_kind == "compatible"
    }
}

impl Hooked {
    /// Whether a session can move: a Claude session of this service (an ACP or pi agent has no
    /// accounts, and a remote instance has its own).
    pub fn can_move(&self, session: &str) -> bool {
        self.session(session).is_some_and(|x| {
            x.remote.is_none() && self.providers.info(x.provider.as_deref().unwrap_or("claude")).is_claude()
        })
    }

    pub fn open_move(&mut self) {
        let Some(d) = self.detail.as_ref() else { return };
        let x = &d.session;
        let (from, from_kind) = match &x.profile {
            Some(p) => (p.id.clone(), p.kind.clone()),
            None => ("default".to_string(), "anthropic".to_string()),
        };
        let w = MoveWin {
            id: x.id.clone(),
            title: self.title_of(x),
            from,
            from_kind,
            working: x.state == "working",
            ..Default::default()
        };
        self.popup = None;
        self.picker = Some(crate::organize::Picker::Move(Box::new(w)));
        self.refresh_profiles();
    }

    /// Where it can go: every profile but the one it is on.
    pub fn move_choices(&self, w: &MoveWin) -> Vec<&Profile> {
        self.profiles.iter().filter(|p| p.id != w.from).collect()
    }

    /// What the destination asks to be picked: a model when either side is a server, since its ids
    /// mean nothing to the other side. Between two accounts the session keeps its own.
    pub fn move_needs_model(&self, w: &MoveWin) -> bool {
        let to_server = w.target.as_deref().is_some_and(|t| self.is_server(Some(t)));
        w.target.is_some() && (to_server || w.from_server())
    }

    pub fn move_pick(&mut self, target: &str) {
        let to_server = self.is_server(Some(target));
        self.ensure_profile_models(Some(target));
        let default_model = self
            .setting("defaultModel")
            .as_str()
            .filter(|m| !m.is_empty())
            .unwrap_or("opus")
            .to_string();
        let first = self.models_for(Some(target)).first().map(|(id, _)| id.clone());
        let from_server = matches!(&self.picker, Some(crate::organize::Picker::Move(w)) if w.from_server());
        if let Some(crate::organize::Picker::Move(w)) = self.picker.as_mut() {
            w.target = Some(target.to_string());
            w.error = None;
            w.effort = None;
            // On a server the first model it offers; coming back from one, the usual default.
            w.model = if to_server {
                first
            } else if from_server {
                Some(default_model)
            } else {
                None
            };
        }
    }

    pub fn move_go(&mut self) {
        let Some(crate::organize::Picker::Move(w)) = self.picker.as_ref() else { return };
        let Some(target) = w.target.clone() else { return };
        let needs = self.move_needs_model(w);
        let to_server = self.is_server(Some(&target));
        let (id, model, effort) = (w.id.clone(), w.model.clone(), w.effort.clone());
        if needs && model.is_none() {
            let why = if to_server {
                "Pick one of the server's models."
            } else {
                "Pick the Claude model it continues with."
            };
            if let Some(crate::organize::Picker::Move(w)) = self.picker.as_mut() {
                w.error = Some(why.into());
            }
            return;
        }
        if let Some(crate::organize::Picker::Move(w)) = self.picker.as_mut() {
            w.busy = true;
            w.error = None;
        }
        self.spawn(
            move || {
                move_session(
                    &id,
                    &target,
                    model.as_deref().filter(|_| needs),
                    effort.as_deref().filter(|_| !to_server),
                )
            },
            |s, r, _| match r {
                Ok(()) => {
                    s.picker = None;
                    s.flash("✓ Session moved", false);
                    s.refresh_sessions();
                    s.refresh_detail();
                    s.refresh_usage();
                }
                Err(e) => {
                    if let Some(crate::organize::Picker::Move(w)) = s.picker.as_mut() {
                        w.busy = false;
                        w.error = Some(e);
                    }
                }
            },
        );
    }
}

/// The accounts' state in the account window, by profile id (`""` is the main account).
pub type Live = HashMap<String, (Vec<ProfileModel>, Option<String>)>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_list_parses_what_the_service_sends() {
        let v = json!([
            { "id": "default", "label": "Default", "kind": "anthropic", "models": [], "implicit": true, "hasAccount": false },
            { "id": "lucca", "label": "Lucca", "kind": "anthropic", "models": [], "implicit": false, "hasAccount": true },
            { "id": "lm-studio", "label": "LM Studio", "kind": "compatible",
              "models": [{ "id": "qwen/qwen3-coder-30b", "label": "qwen/qwen3-coder-30b" }],
              "implicit": false, "hasAccount": false },
        ]);
        let list: Vec<Profile> = api::decode(v).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].name(), "Main account");
        assert!(list[1].has_account && !list[1].compatible());
        assert!(list[2].compatible());
        assert_eq!(list[2].models[0].id, "qwen/qwen3-coder-30b");
    }

    #[test]
    fn a_session_carries_its_profile_or_none() {
        let on: crate::api::Session = api::decode(json!({
            "id": "a", "profile": { "id": "lucca", "label": "Lucca", "kind": "anthropic" }
        }))
        .unwrap();
        assert_eq!(on.profile.as_ref().map(|p| p.id.as_str()), Some("lucca"));
        assert!(!on.profile.unwrap().missing);
        let off: crate::api::Session = api::decode(json!({ "id": "b", "profile": null })).unwrap();
        assert!(off.profile.is_none());
        let old: crate::api::Session = api::decode(json!({ "id": "c" })).unwrap();
        assert!(old.profile.is_none());
    }

    #[test]
    fn a_moved_session_shows_the_model_it_was_resumed_with() {
        let qwen = ["qwen/qwen3-coder-30b".to_string()];
        // Just moved from a server to a Claude account: the transcript still says qwen.
        assert_eq!(model_key("qwen/qwen3-coder-30b", Some("sonnet"), None), "sonnet");
        // After its first turn there it says Claude, which is kept as it is.
        assert_eq!(model_key("claude-sonnet-5-5", Some("sonnet"), None), "claude-sonnet-5-5");
        // The other way: a Claude transcript on a server.
        assert_eq!(
            model_key("claude-sonnet-5-5", Some("qwen/qwen3-coder-30b"), Some(&qwen)),
            "qwen/qwen3-coder-30b"
        );
        assert_eq!(model_key("qwen/qwen3-coder-30b", Some("qwen/qwen3-coder-30b"), Some(&qwen)), "qwen/qwen3-coder-30b");
        // A server that lists no models: what is not a Claude model is its own.
        assert_eq!(model_key("qwen/x", Some("qwen/y"), Some(&[])), "qwen/x");
        assert_eq!(model_key("claude-opus-4-8", Some("qwen/y"), Some(&[])), "qwen/y");
        // Nothing launched yet: the transcript's.
        assert_eq!(model_key("claude-opus-4-8", None, None), "claude-opus-4-8");
        assert_eq!(model_key("claude-opus-4-8", Some(""), None), "claude-opus-4-8");
    }

    #[test]
    fn a_scoped_request_names_its_profile_only_off_the_main_account() {
        assert_eq!(query(None), "");
        assert_eq!(query(Some("lm studio")), "profile=lm%20studio");
    }
}
