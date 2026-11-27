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
            |s, (profile, r), _| {
                // The open session moved on while this was in flight: its answer is another account's.
                if s.usage_wanted != profile {
                    return;
                }
                match r {
                    Ok((g, pi, raw)) => {
                        s.gauges = g;
                        s.pi_usage = pi;
                        s.provider_usage = api::parse_provider_usage(&raw);
                        // A server has no account, so no limits: nothing to show rather than dashes.
                        s.no_limits = profile.is_some()
                            && raw["profile"].as_str() == profile.as_deref()
                            && raw["account"].is_null();
                        s.usage = Some(raw);
                    }
                    // The profile is gone: another account's gauges would be a lie.
                    Err(_) if profile.is_some() => {
                        s.gauges.clear();
                        s.no_limits = true;
                    }
                    Err(_) => {}
                }
            },
        );
    }

    /// Called from `poll`: the gauges follow the open session's account.
    pub fn sync_usage_profile(&mut self) {
        if self.gauge_profile() != self.usage_wanted {
            self.refresh_usage();
        }
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
        self.new_profile = Some(profile.clone());
        self.new_effort = None;
        self.new_model = None;
        self.ensure_profile_models(profile.as_deref());
        self.fill_server_model();
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
    fn a_scoped_request_names_its_profile_only_off_the_main_account() {
        assert_eq!(query(None), "");
        assert_eq!(query(Some("lm studio")), "profile=lm%20studio");
    }
}
