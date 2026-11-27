//! The accounts window: the Claude accounts a session can run on (the main one and one per
//! profile that has an account of its own), the servers it can run on instead, and the forms that
//! add either. The service does the work (`/api/account`, `/api/profiles`); this is its client.

use std::collections::BTreeSet;

use rune::TextEdit;
use serde_json::{Value, json};

use crate::api;
use crate::app::Hooked;
use crate::fmt;
use crate::organize::Picker;
use crate::profiles::{self, Profile, ProfileModel};

/// One account of the list. `key` is `""` for the main account (Claude Code's own login on this
/// machine), else the id of the profile that has an account of its own.
#[derive(Clone, Debug, Default)]
pub struct AccountCard {
    pub key: String,
    pub label: String,
    pub info: Option<Value>,
    pub usage: Option<Value>,
}

/// What the address typed in the server form answered.
#[derive(Clone, Debug)]
pub enum Probe {
    Loading,
    Done {
        models: Vec<ProfileModel>,
        error: Option<String>,
    },
}

/// The form that adds a server (LM Studio, or any Anthropic-compatible one).
#[derive(Default)]
pub struct ServerForm {
    pub name: TextEdit,
    pub url: TextEdit,
    pub token: TextEdit,
    pub ctx: TextEdit,
    pub probe: Option<Probe>,
    /// The models kept, out of the ones the server offered.
    pub kept: BTreeSet<String>,
    pub saving: bool,
}

#[derive(Default)]
pub struct AccountWin {
    pub loaded: bool,
    pub cards: Vec<AccountCard>,
    pub servers: Vec<Profile>,
    /// The sign-in in flight, and the card it is on.
    pub login: Option<Value>,
    pub login_key: Option<String>,
    pub redirect: TextEdit,
    /// `("logout" | "remove", key)`: the card that is asked to confirm.
    pub confirm: Option<(&'static str, String)>,
    pub notice: Option<String>,
    pub card_error: Option<(String, String)>,
    pub polled: i64,
    pub new_name: TextEdit,
    pub server: Option<ServerForm>,
    pub busy: bool,
}

/// Everything the window lists, read from the service (blocking).
pub struct Loaded {
    pub cards: Vec<AccountCard>,
    pub servers: Vec<Profile>,
}

pub fn load() -> Loaded {
    let list = profiles::list().unwrap_or_default();
    let usage_of = |profile: Option<&str>| api::usage(profile).ok().map(|(_, _, raw)| raw);
    let main = api::get("/api/account").ok();
    let main_label = main
        .as_ref()
        .and_then(|i| i["displayName"].as_str().or(i["email"].as_str()))
        .unwrap_or("Main account")
        .to_string();
    let mut cards = vec![AccountCard {
        key: String::new(),
        label: main_label,
        usage: usage_of(None),
        info: main,
    }];
    for p in list.iter().filter(|p| p.has_account) {
        let info = api::get(&format!("/api/account?{}", profiles::query(Some(&p.id)))).ok();
        // Its limits are asked for once it is signed in: there is nothing to read before.
        let usage = info
            .as_ref()
            .filter(|i| i["loggedIn"] == true)
            .and_then(|_| usage_of(Some(&p.id)));
        cards.push(AccountCard {
            key: p.id.clone(),
            label: p.name(),
            info,
            usage,
        });
    }
    Loaded {
        cards,
        servers: list.into_iter().filter(Profile::compatible).collect(),
    }
}

/// The 5 h and 7 d limits of an account as text, `None` when there is nothing to show.
pub fn limits_of(usage: &Value) -> Option<String> {
    let a = &usage["account"];
    if a["fiveHour"].is_null() && a["sevenDay"].is_null() {
        return None;
    }
    let f = |x: &Value| x["pct"].as_f64().map_or("—".to_string(), |p| format!("{p:.0}%"));
    Some(format!("5h {} · 7d {}", f(&a["fiveHour"]), f(&a["sevenDay"])))
}

impl Hooked {
    fn account(&mut self) -> Option<&mut AccountWin> {
        match self.picker.as_mut() {
            Some(Picker::Account(a)) => Some(a),
            _ => None,
        }
    }

    pub fn open_account(&mut self) {
        self.picker = Some(Picker::Account(Box::default()));
        self.refresh_account();
        self.refresh_profiles();
    }

    pub fn refresh_account(&mut self) {
        self.spawn(load, |s, l, _| {
            if let Some(a) = s.account() {
                a.cards = l.cards;
                a.servers = l.servers;
                a.loaded = true;
            }
        });
    }

    /// After the profiles or the settings changed: the lists that read them read again.
    fn profiles_changed(&mut self) {
        self.refresh_account();
        self.refresh_profiles();
        self.spawn(
            || api::get("/api/settings"),
            |s, r, _| {
                if let Ok(v) = r {
                    s.apply_settings(v);
                    s.refresh_usage();
                }
            },
        );
    }

    /// The account new sessions start on. Picking one there starts from it again.
    pub fn account_use_default(&mut self, key: &str) {
        self.save_setting("defaultProfile", json!(key));
        self.new_profile = None;
        self.new_model = None;
        self.new_effort = None;
        self.refresh_usage();
    }

    fn account_action(&mut self, body: Value) {
        self.spawn(
            move || api::post("/api/account", body),
            |s, r, _| {
                let Some(a) = s.account() else { return };
                match r {
                    Ok(v) if !v["login"].is_null() => {
                        let done = v["login"]["done"] == true;
                        let ok = v["login"]["exitCode"] == 0;
                        a.login = Some(v["login"].clone());
                        if done {
                            a.notice = Some(if ok {
                                "Signed in.".into()
                            } else {
                                "The login flow ended before completing.".into()
                            });
                            if ok {
                                s.profiles_changed();
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(e) => {
                        let key = a.login_key.clone().unwrap_or_default();
                        a.login = None;
                        a.login_key = None;
                        a.card_error = Some((key, e));
                    }
                }
            },
        );
    }

    /// Signs `key` in (again) with `claude auth login`, shown inside its card.
    pub fn account_login(&mut self, key: &str, mode: &'static str) {
        let had = self.account().and_then(|a| a.login.take());
        if let Some(id) = had.and_then(|l| l["id"].as_str().map(str::to_string)) {
            self.spawn(
                move || api::post("/api/account", json!({ "action": "login-cancel", "id": id })),
                |_, _, _| {},
            );
        }
        if let Some(a) = self.account() {
            a.login = Some(json!({ "starting": true }));
            a.login_key = Some(key.to_string());
            a.notice = None;
            a.card_error = None;
            a.confirm = None;
            a.redirect = TextEdit::new("");
        }
        let mut body = json!({ "action": "login", "mode": mode });
        if !key.is_empty() {
            body["profile"] = json!(key);
        }
        self.account_action(body);
    }

    pub fn account_send_redirect(&mut self) {
        let Some(a) = self.account() else { return };
        let text = a.redirect.text.trim().to_string();
        let Some(id) = a
            .login
            .as_ref()
            .and_then(|l| l["id"].as_str())
            .map(str::to_string)
        else {
            return;
        };
        if text.is_empty() {
            return;
        }
        a.redirect = TextEdit::new("");
        self.account_action(json!({ "action": "login-input", "id": id, "text": text }));
    }

    pub fn account_cancel_login(&mut self) {
        let Some(a) = self.account() else { return };
        a.login_key = None;
        let id = a
            .login
            .take()
            .and_then(|l| l["id"].as_str().map(str::to_string));
        if let Some(id) = id {
            self.spawn(
                move || api::post("/api/account", json!({ "action": "login-cancel", "id": id })),
                |_, _, _| {},
            );
        }
    }

    pub fn account_logout(&mut self, key: &str) {
        let mut body = json!({ "action": "logout" });
        if !key.is_empty() {
            body["profile"] = json!(key);
        }
        if let Some(a) = self.account() {
            a.confirm = None;
            a.busy = true;
        }
        self.spawn(
            move || api::post("/api/account", body),
            |s, r, _| {
                if let Some(a) = s.account() {
                    a.busy = false;
                    a.notice = Some(match &r {
                        Ok(_) => "Signed out.".into(),
                        Err(e) => format!("Sign-out failed: {e}"),
                    });
                }
                s.profiles_changed();
            },
        );
    }

    /// Takes an account or a server out of `profiles.json`; refused by the service while a
    /// session runs on it.
    pub fn account_remove(&mut self, key: &str) {
        let id = key.to_string();
        if let Some(a) = self.account() {
            a.confirm = None;
            a.busy = true;
        }
        self.spawn(
            {
                let id = id.clone();
                move || profiles::action(json!({ "action": "remove-profile", "id": id }))
            },
            move |s, r, _| {
                if let Some(a) = s.account() {
                    a.busy = false;
                    match &r {
                        Ok(v) => {
                            let mut note = "Removed.".to_string();
                            if v["loggedOut"] == false {
                                note.push_str(
                                    " Signing out failed: its login may still be on this machine.",
                                );
                            }
                            if let Some(dir) = v["keptDir"].as_str() {
                                note.push_str(&format!(" Its folder was kept: {dir}"));
                            }
                            a.notice = Some(note);
                        }
                        Err(e) => a.card_error = Some((id.clone(), e.clone())),
                    }
                }
                if r.is_ok() {
                    // A new session that was about to start on it starts on the default again.
                    if s.new_profile.as_ref().and_then(|p| p.as_deref()) == Some(id.as_str()) {
                        s.new_profile = None;
                        s.new_model = None;
                    }
                    s.profiles_changed();
                }
            },
        );
    }

    /// A new profile with an account of its own, then straight into its sign-in.
    pub fn account_add(&mut self) {
        let Some(a) = self.account() else { return };
        let label = a.new_name.text.trim().to_string();
        if label.is_empty() || a.busy || a.login.is_some() {
            return;
        }
        a.busy = true;
        a.notice = None;
        self.spawn(
            move || profiles::action(json!({ "action": "add-account", "label": label })),
            |s, r, _| {
                let Some(a) = s.account() else { return };
                a.busy = false;
                match r {
                    Ok(v) => {
                        a.new_name = TextEdit::new("");
                        let id = v["profile"]["id"].as_str().unwrap_or("").to_string();
                        s.refresh_profiles();
                        s.refresh_account();
                        if !id.is_empty() {
                            s.account_login(&id, "claudeai");
                        }
                    }
                    Err(e) => a.notice = Some(e),
                }
            },
        );
    }

    pub fn server_form_open(&mut self) {
        if let Some(a) = self.account() {
            let mut f = ServerForm::default();
            f.name.focused = true;
            a.server = Some(f);
        }
    }

    /// What the server at the typed address offers, checked before saving: a typo or a server
    /// that is asleep shows up here and not at the first launch.
    pub fn server_test(&mut self) {
        let Some(f) = self.account().and_then(|a| a.server.as_mut()) else {
            return;
        };
        let (url, token) = (f.url.text.trim().to_string(), f.token.text.trim().to_string());
        if url.is_empty() {
            return;
        }
        f.probe = Some(Probe::Loading);
        self.spawn(
            move || profiles::action(json!({ "action": "probe-server", "url": url, "token": token })),
            |s, r, _| {
                let Some(f) = s.account().and_then(|a| a.server.as_mut()) else {
                    return;
                };
                f.probe = Some(match r {
                    Ok(v) => {
                        let models: Vec<ProfileModel> =
                            api::decode(v["models"].clone()).unwrap_or_default();
                        f.kept = models.iter().map(|m| m.id.clone()).collect();
                        Probe::Done {
                            models,
                            error: v["error"].as_str().map(str::to_string),
                        }
                    }
                    Err(e) => Probe::Done {
                        models: Vec::new(),
                        error: Some(e),
                    },
                });
            },
        );
    }

    pub fn server_add(&mut self) {
        let Some(a) = self.account() else { return };
        let Some(f) = a.server.as_mut() else { return };
        let label = f.name.text.trim().to_string();
        let url = f.url.text.trim().to_string();
        if label.is_empty() || url.is_empty() || f.saving {
            return;
        }
        let offered = match &f.probe {
            Some(Probe::Done { models, .. }) => models.len(),
            _ => 0,
        };
        // Models were found and none is kept: saving would quietly mean "all of them".
        if offered > 0 && f.kept.is_empty() {
            a.notice = Some("Keep at least one model, or cancel.".into());
            return;
        }
        let models: Vec<String> = f.kept.iter().cloned().collect();
        let ctx = f.ctx.text.trim().parse::<u64>().ok();
        let token = f.token.text.trim().to_string();
        f.saving = true;
        a.notice = None;
        self.spawn(
            move || {
                profiles::action(json!({
                    "action": "add-server", "label": label, "url": url, "token": token,
                    "contextWindow": ctx, "models": models,
                }))
            },
            |s, r, _| {
                let Some(a) = s.account() else { return };
                match r {
                    Ok(v) => {
                        let name = v["profile"]["label"].as_str().unwrap_or("The server").to_string();
                        a.notice = Some(format!("Added “{name}”. Pick it in New session."));
                        a.server = None;
                        s.profiles_changed();
                    }
                    Err(e) => {
                        a.notice = Some(e);
                        if let Some(f) = a.server.as_mut() {
                            f.saving = false;
                        }
                    }
                }
            },
        );
    }

    /// Called from `poll`: follows a login flow until the CLI exits.
    pub fn poll_account(&mut self, now: i64) {
        let Some(a) = self.account() else { return };
        let Some(id) = a
            .login
            .as_ref()
            .filter(|l| l["done"] != true)
            .and_then(|l| l["id"].as_str())
            .map(str::to_string)
        else {
            return;
        };
        if now - a.polled < 1500 {
            return;
        }
        a.polled = fmt::now_ms();
        self.account_action(json!({ "action": "login-status", "id": id }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_read_the_two_windows_of_an_account() {
        let u = json!({ "account": { "fiveHour": { "pct": 48.4 }, "sevenDay": { "pct": 78.0 } } });
        assert_eq!(limits_of(&u).as_deref(), Some("5h 48% · 7d 78%"));
        let half = json!({ "account": { "fiveHour": { "pct": 10.0 } } });
        assert_eq!(limits_of(&half).as_deref(), Some("5h 10% · 7d —"));
    }

    #[test]
    fn a_server_has_no_limits_to_show() {
        assert_eq!(limits_of(&json!({ "profile": "lm-studio", "account": null })), None);
        assert_eq!(limits_of(&json!({})), None);
    }
}
