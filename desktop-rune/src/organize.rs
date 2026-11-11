use std::collections::BTreeSet;

use rune::TextEdit;
use serde_json::json;

use crate::api::{self, Session};
use crate::app::Hooked;

pub enum Picker {
    Tags {
        id: String,
        edit: TextEdit,
    },
    Group {
        id: String,
        query: TextEdit,
    },
    RenameGroup {
        id: String,
        edit: TextEdit,
    },
    Trash {
        items: Option<Vec<serde_json::Value>>,
        busy: Option<String>,
    },
    Cost,
    Account(Box<crate::account::AccountWin>),
    Image {
        paths: Vec<String>,
        index: usize,
    },
    Agent {
        title: String,
        messages: Option<Vec<crate::api::Message>>,
    },
    Fork {
        uuid: String,
        model: Option<String>,
        effort: Option<String>,
        mode: String,
        prompt: TextEdit,
    },
}

/// A sidebar entry: a session, and the sessions grouped under it when it leads a group.
pub struct Unit<'a> {
    pub mother: &'a Session,
    pub children: Vec<&'a Session>,
}

/// An agent's cut points are its own transcript's; forking the session at one would be wrong.
pub fn agent_messages(v: Option<serde_json::Value>) -> Vec<crate::api::Message> {
    let mut list: Vec<crate::api::Message> = v
        .and_then(|v| serde_json::from_value(v["messages"].clone()).ok())
        .unwrap_or_default();
    for m in &mut list {
        m.fork_uuid = None;
    }
    list
}

pub fn parse_tags(text: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    text.split(|c: char| c == ',' || c.is_whitespace())
        .map(|t| t.trim().trim_start_matches('#').to_lowercase())
        .filter(|t| !t.is_empty() && seen.insert(t.clone()))
        .collect()
}

impl Hooked {
    pub fn visible(&self, s: &Session) -> bool {
        !self.incognito || self.meta.get(&s.id).is_some_and(|m| m.incognito)
    }

    pub fn session_tags(&self, id: &str) -> &[String] {
        self.tags.get(id).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn known_tags(&self) -> Vec<(String, usize)> {
        let mut counts: std::collections::BTreeMap<String, usize> = Default::default();
        for s in self
            .sessions
            .iter()
            .filter(|s| self.visible(s) && !self.is_archived(s))
        {
            for t in self.session_tags(&s.id) {
                *counts.entry(t.clone()).or_default() += 1;
            }
        }
        counts.into_iter().collect()
    }

    pub fn group_of(&self, id: &str) -> Option<&str> {
        self.meta.get(id).and_then(|m| m.group_of.as_deref())
    }

    pub fn group_members(&self, mother: &str) -> Vec<String> {
        let mut out = vec![mother.to_string()];
        out.extend(
            self.sessions
                .iter()
                .filter(|s| self.group_of(&s.id) == Some(mother))
                .map(|s| s.id.clone()),
        );
        out
    }

    pub fn group_label(&self, mother: &Session) -> String {
        self.meta
            .get(&mother.id)
            .and_then(|m| m.group_name.clone())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| mother.display_title())
    }

    /// Folds a flat list into groups: a child follows its mother when the mother is in the list.
    pub fn units<'a>(&self, list: &[&'a Session]) -> Vec<Unit<'a>> {
        let ids: std::collections::HashSet<&str> = list.iter().map(|s| s.id.as_str()).collect();
        let mut out: Vec<Unit<'a>> = Vec::new();
        for s in list {
            match self.group_of(&s.id) {
                Some(m) if ids.contains(m) => {}
                _ => out.push(Unit {
                    mother: s,
                    children: Vec::new(),
                }),
            }
        }
        for s in list {
            if let Some(m) = self.group_of(&s.id).filter(|m| ids.contains(m))
                && let Some(u) = out.iter_mut().find(|u| u.mother.id == m)
            {
                u.children.push(s);
            }
        }
        out
    }

    pub fn toggle_incognito_mode(&mut self) {
        self.incognito = !self.incognito;
        let v = self.incognito;
        self.save_pref("incognito", &v);
        self.tag_filter.clear();
        self.tray_dirty = true;
    }

    pub fn toggle_incognito(&mut self, id: &str) {
        let on = !self.meta.get(id).is_some_and(|m| m.incognito);
        let ids = if self.group_of(id).is_none() {
            self.group_members(id)
        } else {
            vec![id.to_string()]
        };
        for m in &ids {
            self.meta.entry(m.clone()).or_default().incognito = on;
        }
        self.spawn(
            move || {
                ids.iter()
                    .try_for_each(|m| api::patch_meta(m, json!({ "incognito": on })))
            },
            |s, r, _| {
                if let Err(e) = r {
                    s.flash(format!("✗ Incognito: {e}"), true);
                }
                s.refresh_sessions();
            },
        );
    }

    pub fn open_tags(&mut self, id: String) {
        let mut edit = TextEdit::new(self.session_tags(&id).join(" "));
        edit.focused = true;
        self.popup = None;
        self.picker = Some(Picker::Tags { id, edit });
    }

    pub fn toggle_tag_in_editor(&mut self, tag: &str) {
        if let Some(Picker::Tags { edit, .. }) = self.picker.as_mut() {
            let mut tags = parse_tags(&edit.text);
            if let Some(i) = tags.iter().position(|t| t == tag) {
                tags.remove(i);
            } else {
                tags.push(tag.to_string());
            }
            let mut e = TextEdit::new(tags.join(" "));
            e.focused = true;
            *edit = e;
        }
    }

    pub fn save_tags(&mut self) {
        let Some(Picker::Tags { id, edit }) = self.picker.take() else {
            return;
        };
        let tags = parse_tags(&edit.text);
        self.tags.insert(id.clone(), tags.clone());
        self.spawn(
            move || api::save_tags(&id, &tags),
            |s, r, _| match r {
                Ok(()) => s.flash("✓ Tags saved", false),
                Err(e) => s.flash(format!("✗ Tags: {e}"), true),
            },
        );
    }

    pub fn toggle_tag_filter(&mut self, tag: String) {
        if let Some(i) = self.tag_filter.iter().position(|t| *t == tag) {
            self.tag_filter.remove(i);
        } else {
            self.tag_filter.push(tag);
        }
    }

    pub fn open_group_picker(&mut self, id: String) {
        let mut query = TextEdit::new("");
        query.focused = true;
        self.popup = None;
        self.picker = Some(Picker::Group { id, query });
    }

    pub fn open_rename_group(&mut self, id: String) {
        let name = self
            .meta
            .get(&id)
            .and_then(|m| m.group_name.clone())
            .unwrap_or_default();
        let mut edit = TextEdit::new(name);
        edit.focused = true;
        self.popup = None;
        self.picker = Some(Picker::RenameGroup { id, edit });
    }

    pub fn group_op(&mut self, op: &'static str, id: String, extra: serde_json::Value) {
        self.picker = None;
        self.popup = None;
        self.spawn(
            move || api::group_op(op, &id, extra),
            move |s, r, _| {
                match r {
                    Ok(()) => s.flash(
                        match op {
                            "join" => "✓ Moved to the group",
                            "leave" => "✓ Left the group",
                            "rename" => "✓ Group renamed",
                            "mother" => "✓ New lead session",
                            _ => "✓ Done",
                        },
                        false,
                    ),
                    Err(e) => s.flash(format!("✗ Group: {e}"), true),
                }
                s.refresh_sessions();
            },
        );
    }

    pub fn save_group_name(&mut self) {
        let Some(Picker::RenameGroup { id, edit }) = self.picker.take() else {
            return;
        };
        let name = edit.text.trim().to_string();
        self.group_op("rename", id, json!({ "name": name }));
    }

    pub fn open_image(&mut self, paths: Vec<String>, index: usize) {
        self.picker = Some(Picker::Image { paths, index });
    }

    pub fn step_image(&mut self, delta: isize) -> bool {
        let Some(Picker::Image { paths, index }) = self.picker.as_mut() else {
            return false;
        };
        let n = paths.len() as isize;
        *index = ((*index as isize + delta).rem_euclid(n.max(1))) as usize;
        true
    }

    pub fn open_agent(&mut self, agent: String, title: String) {
        let Some(session) = self.selected.clone() else {
            return;
        };
        self.picker = Some(Picker::Agent {
            title,
            messages: None,
        });
        self.spawn(
            move || {
                api::get(&format!(
                    "/api/agent?session={}&agent={}",
                    api::enc(&session),
                    api::enc(&agent)
                ))
            },
            |s, r, _| {
                let list = agent_messages(r.ok());
                if let Some(Picker::Agent { messages, .. }) = s.picker.as_mut() {
                    *messages = Some(list);
                }
            },
        );
    }

    pub fn fork_options(&mut self, uuid: String) {
        let Some(d) = self.detail.as_ref() else {
            return;
        };
        let mut prompt = TextEdit::new("");
        prompt.focused = true;
        self.picker = Some(Picker::Fork {
            uuid,
            model: d.session.model.clone(),
            effort: d.session.effort.clone(),
            mode: "default".into(),
            prompt,
        });
    }

    pub fn fork_with_options(&mut self) {
        let Some(Picker::Fork {
            uuid,
            model,
            effort,
            mode,
            prompt,
        }) = self.picker.take()
        else {
            return;
        };
        self.fork_request(api::ForkRequest {
            fork_uuid: uuid,
            prompt: prompt.text.trim().to_string(),
            model,
            effort,
            permission_mode: Some(mode),
        });
    }

    pub fn fork_at(&mut self, fork_uuid: String) {
        let Some(d) = self.detail.as_ref() else {
            return;
        };
        let req = api::ForkRequest {
            fork_uuid,
            prompt: String::new(),
            model: d.session.model.clone(),
            effort: d.session.effort.clone(),
            permission_mode: None,
        };
        self.fork_request(req);
    }

    fn fork_request(&mut self, req: api::ForkRequest) {
        let Some(id) = self.detail.as_ref().map(|d| d.session.id.clone()) else {
            return;
        };
        self.flash("⑂ Forking…", false);
        self.spawn(
            move || api::fork(&id, &req),
            |s, r, _| match r {
                Ok(new_id) => {
                    s.flash("✓ Forked into a new session", false);
                    s.refresh_sessions();
                    s.open_session(&new_id);
                }
                Err(e) => s.flash(format!("✗ Fork: {e}"), true),
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_parse_from_free_text() {
        assert_eq!(
            parse_tags("#Infra, p1  p1 azure"),
            vec!["infra", "p1", "azure"]
        );
        assert!(parse_tags("  , ").is_empty());
    }
}
