use rune::TextEdit;
use serde_json::{Value, json};

use crate::api;
use crate::app::{Hooked, spawn};
use crate::fmt;
use crate::organize::Picker;

#[derive(Default)]
pub struct AccountWin {
    pub info: Option<Value>,
    pub login: Option<Value>,
    pub redirect: TextEdit,
    pub confirm_logout: bool,
    pub notice: Option<String>,
    pub polled: i64,
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
    }

    fn refresh_account(&mut self) {
        spawn(
            || api::get("/api/account"),
            |s, r, _| {
                if let Some(a) = s.account() {
                    a.info = r.ok();
                }
            },
        );
    }

    fn account_action(&mut self, body: Value) {
        spawn(
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
                                s.refresh_account();
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(e) => a.notice = Some(e),
                }
            },
        );
    }

    pub fn account_login(&mut self, mode: &'static str) {
        if let Some(a) = self.account() {
            a.login = Some(json!({ "starting": true }));
            a.notice = None;
        }
        self.account_action(json!({ "action": "login", "mode": mode }));
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
        let id = a
            .login
            .take()
            .and_then(|l| l["id"].as_str().map(str::to_string));
        if let Some(id) = id {
            spawn(
                move || {
                    api::post(
                        "/api/account",
                        json!({ "action": "login-cancel", "id": id }),
                    )
                },
                |_, _, _| {},
            );
        }
    }

    pub fn account_logout(&mut self) {
        spawn(
            || api::post("/api/account", json!({ "action": "logout" })),
            |s, r, _| match r {
                Ok(_) => {
                    s.flash("✓ Signed out", false);
                    if let Some(a) = s.account() {
                        a.confirm_logout = false;
                    }
                    s.refresh_account();
                }
                Err(e) => s.flash(format!("✗ Sign out: {e}"), true),
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
