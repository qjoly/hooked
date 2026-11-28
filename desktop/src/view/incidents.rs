use rune::{Color, Cursor, El, ScrollSpec, col, el, row, text};
use rune_kit::{
    Button, ButtonVariant, Checkbox, ControlSize, IconButton, Kit, RadioItem, SegmentedControl,
    Spinner, TextInput,
};
use serde_json::Value;

use super::pages::{loading, page, scroll};
use super::{Shadows, glyph, modal_scrim, pill, section_title};
use crate::app::Hooked;
use crate::incidents::{Avail, Inc, MergeForm, Outcome, RoleForm, SCOPES, look_alike, mergeable};
use crate::{fmt, icons};

/// The sections of a list that mixes lifecycle stages, in the order a responder reads them.
const STAGES: [(&str, &str); 4] = [
    ("triage", "TRIAGE"),
    ("active", "ACTIVE"),
    ("paused", "PAUSED"),
    ("post-incident", "POST-INCIDENT"),
];

fn status_tone(k: &Kit, category: &str) -> (Color, Color) {
    match category {
        "triage" => (k.c.warning.fg, k.c.warning.bg),
        "active" => (k.c.danger.fg, k.c.danger.bg),
        "post-incident" => (k.c.text_accent, k.c.layer_02),
        "closed" => (k.c.success.fg, k.c.success.bg),
        _ => (k.c.text_muted, k.c.layer_02),
    }
}

/// A severity's colour from where its rank sits on the organisation's own scale.
fn severity_color(s: &Hooked, k: &Kit, rank: Option<i64>) -> Color {
    let Some(rank) = rank else {
        return k.c.border_weak;
    };
    let top = s.inc.org.top_rank().max(1);
    match rank * 4 / top {
        3.. => k.c.danger.icon,
        2 => k.c.warning.icon,
        1 => k.c.icon_muted,
        _ => k.c.icon_faint,
    }
}

fn small(label: impl Into<String>) -> Button {
    Button::new(label.into())
        .variant(ButtonVariant::Outline)
        .control_size(ControlSize::Small)
}

fn note(k: &Kit, msg: impl Into<String>, c: Color) -> El {
    text(msg.into()).font(k.ty.text_small).color(c).wrap()
}

fn unavailable(k: &Kit, title: &str, detail: &str, retry: bool) -> El {
    let mut c = col()
        .key("inc-unavailable")
        .w_full()
        .h_full()
        .center()
        .gap(10.0)
        .padding(24.0)
        .child(glyph(&icons::SIREN, 28.0, k.c.icon_faint))
        .child(
            text(title.to_string())
                .font(k.ty.body_medium)
                .color(k.c.text_base),
        )
        .child(
            col()
                .max_w(520.0)
                .child(note(k, detail.to_string(), k.c.text_faint)),
        );
    if retry {
        c = c.child(
            small("Try again")
                .icon(&icons::RESTART)
                .on_press(|s: &mut Hooked| s.check_incidents())
                .build(k)
                .key("inc-retry"),
        );
    }
    c
}

pub fn view(s: &Hooked, k: &Kit) -> El {
    let title = "Incidents";
    if s.incognito {
        let body = unavailable(
            k,
            "Hidden in incognito mode",
            "Incident names stay off the screen while incognito mode is on.",
            false,
        );
        return page(k, "incidents", title, el(), body);
    }
    match &s.inc.avail {
        Avail::Ready => {}
        Avail::Checking => return page(k, "incidents", title, el(), loading(k)),
        Avail::Off => {
            let body = unavailable(
                k,
                "incident.io is not available here",
                "This page talks to the incident.io desktop app, which is not installed on this machine.",
                true,
            );
            return page(k, "incidents", title, el(), body);
        }
        Avail::Failed(e) => {
            let body = unavailable(
                k,
                "incident.io did not answer",
                &format!("{e}. Open the incident.io desktop app and check that you are signed in."),
                true,
            );
            return page(k, "incidents", title, el(), body);
        }
    }
    let inc = &s.inc;
    let list = &inc.lists[inc.scope];
    let mut actions = row().gap(8.0).center_y();
    if let Some(n) = inc.pinned {
        actions = actions.child(
            row()
                .key("inc-pinned")
                .h(24.0)
                .pl(8.0)
                .pr(2.0)
                .gap(4.0)
                .center_y()
                .radius(k.radius.md)
                .fill(k.c.layer_02)
                .help("The incident pinned in the incident.io desktop app: what \"my incident\" means to a Claude session.")
                .child(glyph(&icons::PIN, 12.0, k.c.icon_muted))
                .child(
                    text(format!("INC-{n}"))
                        .font(k.ty.text_small_medium)
                        .color(k.c.text_base),
                )
                .child(
                    IconButton::new(&icons::CLOSE)
                        .label("Clear the pin")
                        .help("Clear the pin")
                        .control_size(ControlSize::Small)
                        .disabled(inc.busy)
                        .on_press(|s: &mut Hooked| s.pin_incident(None))
                        .build(k),
                ),
        );
    }
    actions = actions.child(
        Button::new("Refresh")
            .icon(&icons::RESTART)
            .variant(ButtonVariant::GhostMuted)
            .control_size(ControlSize::Regular)
            .disabled(list.loading)
            .on_press(|s: &mut Hooked| s.refresh_incidents())
            .build(k)
            .key("inc-refresh"),
    );

    let labels: Vec<String> = SCOPES
        .iter()
        .zip(&inc.lists)
        .map(|(sc, l)| match l.total {
            Some(n) => format!("{} · {n}", sc.label),
            None => sc.label.to_string(),
        })
        .collect();
    let tabs = SegmentedControl::new(&labels, Some(inc.scope))
        .label("List")
        .fit()
        .on_pick(|s: &mut Hooked, i, _| s.set_incident_scope(i))
        .build(k)
        .key("inc-tabs");
    let mut body = col()
        .key("inc-list")
        .w_full()
        .max_w(1100.0)
        .self_center()
        .padding(24.0)
        .gap(6.0)
        .child(row().w_full().min_w(0.0).pb(4.0).scroll_x().child(tabs))
        .child(filters(s, k));

    if let Some(o) = inc.outcome.as_ref() {
        body = body.child(outcome(s, k, o));
    }
    let can_merge = inc.can("incident_merge") && SCOPES[inc.scope].key != "merged";
    let can_unmerge = inc.can("incident_unmerge") && SCOPES[inc.scope].key == "merged";
    if can_merge && SCOPES[inc.scope].key == "open" {
        for group in look_alike(&list.items) {
            let items: Vec<&Inc> = group.iter().map(|&i| &list.items[i]).collect();
            let key = alike_key(&items);
            if !inc.dismissed.contains(&key) {
                body = body.child(alike(k, key, &items));
            }
        }
    }
    let shown = inc.shown();
    if can_merge || can_unmerge {
        body = body.child(selection(s, k, &shown, can_merge));
    }
    if let Some(e) = list.error.as_ref() {
        body = body.child(note(k, format!("✗ {e}"), k.c.danger.fg));
    }
    if shown.is_empty() {
        let msg = match (list.loaded_at.is_none(), list.items.is_empty()) {
            (true, _) => "Loading…",
            (false, true) => "Nothing here.",
            (false, false) => "Nothing matches the filter.",
        };
        body = body.child(text(msg).font(k.ty.body).color(k.c.text_faint));
    }
    let pickable = can_merge || can_unmerge;
    let staged = SCOPES[inc.scope].categories.len() > 1;
    if staged {
        for (cat, label) in STAGES {
            let rows: Vec<&&Inc> = shown.iter().filter(|i| i.status.category == cat).collect();
            if rows.is_empty() {
                continue;
            }
            body = body.child(
                row()
                    .pt(10.0)
                    .pb(2.0)
                    .child(section_title(k, &format!("{label} · {}", rows.len()))),
            );
            for i in rows {
                body = body.child(incident_row(s, k, i, pickable));
            }
        }
    } else {
        for i in &shown {
            body = body.child(incident_row(s, k, i, pickable));
        }
    }
    if list.cursor.is_some() {
        let n = inc.scope;
        body = body.child(
            row().pt(8.0).child(
                small(match list.total {
                    Some(t) => format!("Load more ({} of {t})", list.items.len()),
                    None => "Load more".into(),
                })
                .disabled(list.loading)
                .on_press(move |s: &mut Hooked| s.load_incidents(n, true))
                .build(k)
                .key("inc-more"),
            ),
        );
    }

    let mut split = row().key("inc-split").w_full().h_full().child(
        col()
            .grow(1.0)
            .min_w(0.0)
            .h_full()
            .child(scroll("inc-scroll", body)),
    );
    if let Some(id) = inc.open.as_ref() {
        split = split.child(
            col()
                .key("inc-aside")
                .w((s.window_w * 0.42).clamp(400.0, 680.0))
                .h_full()
                .fill(k.c.bg_deep)
                .border_sides([0.0, 0.0, 0.0, 1.0], k.c.border_weak)
                .child(detail(s, k, id)),
        );
    }
    page(k, "incidents", title, actions, split)
}

fn filters(s: &Hooked, k: &Kit) -> El {
    let inc = &s.inc;
    let mut rail = row().w_full().gap(6.0).flex_wrap().pb(6.0).child(
        TextInput::new(&inc.query)
            .placeholder("Filter by name, reference, lead or type…")
            .width(Some(320.0))
            .on_edit(|s: &mut Hooked| &mut s.inc.query)
            .build(k)
            .key("inc-query"),
    );
    // "Mine" is about one person already, so the teams do not narrow it.
    if !SCOPES[inc.scope].mine {
        for (id, name) in &inc.org.teams {
            let on = inc.teams.contains(id);
            let pick = id.clone();
            rail = rail.child(
                k.interactive(
                    row()
                        .key(format!("inc-team-{id}"))
                        .role("checkbox")
                        .checked(on)
                        .h(26.0)
                        .px(8.0)
                        .gap(6.0)
                        .center_y()
                        .radius(k.radius.sm)
                        .cursor(Cursor::Pointer)
                        .help(format!(
                            "Only the incidents of {name} and its sub-teams, in every list but Mine."
                        ))
                        .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
                        .border(
                            1.0,
                            if on {
                                k.c.border_strong
                            } else {
                                k.c.border_weak
                            },
                        )
                        .child(glyph(
                            &icons::USER,
                            12.0,
                            if on { k.c.icon_accent } else { k.c.icon_muted },
                        ))
                        .child(text(name.clone()).font(k.ty.text_small).color(k.c.text_base)),
                )
                .on_press(move |s: &mut Hooked| s.toggle_incident_team(&pick)),
            );
        }
    }
    let mut seen: Vec<(String, usize, Option<i64>)> = Vec::new();
    for i in &inc.lists[inc.scope].items {
        let Some(sev) = i.severity.as_ref() else {
            continue;
        };
        match seen.iter_mut().find(|e| e.0 == sev.name) {
            Some(e) => e.1 += 1,
            None => seen.push((sev.name.clone(), 1, inc.org.rank(Some(sev)))),
        }
    }
    seen.sort_by(|a, b| b.2.cmp(&a.2).then(a.0.cmp(&b.0)));
    for (name, n, rank) in seen {
        let on = inc.severity.as_deref() == Some(name.as_str());
        let pick = name.clone();
        rail = rail.child(
            k.interactive(
                row()
                    .key(format!("inc-sev-{name}"))
                    .role("checkbox")
                    .checked(on)
                    .h(26.0)
                    .px(8.0)
                    .gap(6.0)
                    .center_y()
                    .radius(k.radius.sm)
                    .cursor(Cursor::Pointer)
                    .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
                    .border(
                        1.0,
                        if on {
                            k.c.border_strong
                        } else {
                            k.c.border_weak
                        },
                    )
                    .child(
                        el().size(8.0, 8.0)
                            .radius(4.0)
                            .fill(severity_color(s, k, rank)),
                    )
                    .child(text(name).font(k.ty.text_small).color(k.c.text_base))
                    .child(
                        text(n.to_string())
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_faint),
                    ),
            )
            .on_press(move |s: &mut Hooked| {
                s.inc.severity = if s.inc.severity.as_deref() == Some(pick.as_str()) {
                    None
                } else {
                    Some(pick.clone())
                };
            }),
        );
    }
    rail
}

fn alike_key(items: &[&Inc]) -> String {
    let mut ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
    ids.sort_unstable();
    ids.join("+")
}

/// Open incidents whose names look the same: a merge to review, never one made for the user.
fn alike(k: &Kit, key: String, items: &[&Inc]) -> El {
    let ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
    let refs: Vec<&str> = items.iter().map(|i| i.reference.as_str()).collect();
    let dismiss = key.clone();
    row()
        .key(format!("inc-alike-{key}"))
        .w_full()
        .px(12.0)
        .py(8.0)
        .gap(10.0)
        .center_y()
        .radius(k.radius.md)
        .fill(k.c.layer_01)
        .border(1.0, k.c.border_base)
        .child(glyph(&icons::MERGE, 14.0, k.c.icon_accent))
        .child(
            col()
                .grow(1.0)
                .shrink()
                .gap(2.0)
                .child(
                    text(format!("{} open incidents look alike", items.len()))
                        .font(k.ty.text_small_medium)
                        .color(k.c.text_base),
                )
                .child(
                    text(format!("{} · {}", refs.join(", "), items[0].name))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_muted)
                        .truncate(),
                ),
        )
        .child(
            small("Review merge…")
                .on_press(move |s: &mut Hooked| s.start_merge(ids.clone()))
                .build(k),
        )
        .child(
            IconButton::new(&icons::CLOSE)
                .label("Not the same problem")
                .help("Not the same problem")
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut Hooked| {
                    s.inc.dismissed.insert(dismiss.clone());
                })
                .build(k),
        )
}

fn outcome(s: &Hooked, k: &Kit, o: &Outcome) -> El {
    let mut lines = col().grow(1.0).shrink().gap(2.0).child(
        text(format!("Merged into {}", o.target_ref))
            .font(k.ty.text_small_medium)
            .color(k.c.success.fg),
    );
    for l in &o.lines {
        lines = lines.child(note(k, l.clone(), k.c.text_muted));
    }
    let mut r = row()
        .key("inc-outcome")
        .w_full()
        .px(12.0)
        .py(8.0)
        .gap(10.0)
        .center_y()
        .radius(k.radius.md)
        .fill(k.c.success.bg)
        .border(1.0, k.c.success.border)
        .child(glyph(&icons::CIRCLE_CHECK, 14.0, k.c.success.icon))
        .child(lines);
    if s.inc.can("incident_unmerge") {
        r = r.child(
            small(if o.undoing { "Undoing…" } else { "Undo" })
                .disabled(o.undoing)
                .on_press(|s: &mut Hooked| s.undo_merge())
                .build(k)
                .key("inc-undo"),
        );
    }
    r.child(
        IconButton::new(&icons::CLOSE)
            .label("Dismiss")
            .control_size(ControlSize::Small)
            .on_press(|s: &mut Hooked| s.inc.outcome = None)
            .build(k),
    )
}

fn selection(s: &Hooked, k: &Kit, shown: &[&Inc], merge: bool) -> El {
    let n = s.inc.selected.len();
    let all = !shown.is_empty() && shown.iter().all(|i| s.inc.selected.contains(&i.id));
    let some = n > 0 && !all;
    let mut every = Checkbox::new(all)
        .label("Select all shown")
        .hide_label()
        .indeterminate(some)
        .on_toggle(|s: &mut Hooked| s.select_shown_incidents());
    if some {
        every = every.icon(&icons::MINUS);
    }
    let mut r = row()
        .key("inc-selection")
        .w_full()
        .h(32.0)
        .px(12.0)
        .gap(10.0)
        .center_y()
        .child(every.build(k).key("inc-all"))
        .child(
            text(if n == 0 {
                format!("{} shown", shown.len())
            } else {
                format!("{n} selected")
            })
            .font(k.ty.text_small)
            .color(if n == 0 {
                k.c.text_faint
            } else {
                k.c.text_base
            }),
        );
    if n == 0 {
        return r;
    }
    r = r.child(el().grow(1.0));
    if merge {
        r = r.child(
            small(if n == 1 {
                "Merge into…".to_string()
            } else {
                format!("Merge {n}…")
            })
            .icon(&icons::MERGE)
            .on_press(|s: &mut Hooked| {
                let ids = s.inc.selected.iter().cloned().collect();
                s.start_merge(ids);
            })
            .build(k)
            .key("inc-merge"),
        );
    } else {
        r = r.child(
            small(format!("Unmerge {n}"))
                .disabled(s.inc.busy)
                .on_press(|s: &mut Hooked| {
                    let ids = s.inc.selected.iter().cloned().collect();
                    s.unmerge_incidents(ids);
                })
                .build(k)
                .key("inc-unmerge"),
        );
    }
    r.child(
        Button::new("Clear")
            .variant(ButtonVariant::GhostMuted)
            .control_size(ControlSize::Small)
            .on_press(|s: &mut Hooked| s.inc.selected.clear())
            .build(k),
    )
}

fn incident_row(s: &Hooked, k: &Kit, i: &Inc, pickable: bool) -> El {
    let inc = &s.inc;
    let id = i.id.clone();
    let picked = inc.selected.contains(&i.id);
    let open = inc.open.as_deref() == Some(i.id.as_str());
    let mine = i.involves(inc.org.me.as_deref());
    let (fg, bg) = status_tone(k, &i.status.category);
    let mut sub: Vec<String> = Vec::new();
    if let Some(sev) = i.severity.as_ref() {
        sub.push(sev.name.clone());
    }
    if let Some(t) = i.incident_type.as_ref() {
        sub.push(t.name.clone());
    }
    match i.lead() {
        Some(l) => sub.push(format!("lead {}", l.user)),
        None if i.open() => sub.push("no lead".into()),
        None => {}
    }
    sub.push(fmt::ago_short(Some(&i.reported_at), s.now));
    if let Some(m) = i.merged_into.as_ref() {
        sub.push(format!("→ {}", m.reference));
    }
    let mut r = row()
        .key(format!("inc-{}", i.id))
        .role("link")
        .w_full()
        .px(12.0)
        .py(8.0)
        .gap(10.0)
        .center_y()
        .radius(k.radius.md)
        .cursor(Cursor::Pointer)
        .border(1.0, k.c.border_weak)
        .help(i.summary.clone().unwrap_or_default());
    if pickable {
        let pick = id.clone();
        r = r.child(
            Checkbox::new(picked)
                .label(format!("Select {}", i.reference))
                .hide_label()
                .on_toggle(move |s: &mut Hooked| s.toggle_incident(&pick))
                .build(k)
                .key(format!("inc-pick-{}", i.id)),
        );
    }
    r = r
        .child(el().w(4.0).h(30.0).radius(2.0).fill(severity_color(
            s,
            k,
            inc.org.rank(i.severity.as_ref()),
        )))
        .child(
            col()
                .grow(1.0)
                .shrink()
                .gap(2.0)
                .child(
                    row()
                        .gap(8.0)
                        .center_y()
                        .child(
                            text(i.reference.clone())
                                .font(k.ty.mono)
                                .color(k.c.text_faint),
                        )
                        .child(
                            text(i.name.clone())
                                .font(k.ty.ui_medium)
                                .color(k.c.text_base)
                                .truncate()
                                .grow(1.0)
                                .shrink(),
                        ),
                )
                .child(
                    text(sub.join(" · "))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint)
                        .truncate(),
                ),
        );
    if inc.pinned == Some(i.external_id) {
        r = r.child(glyph(&icons::PIN, 12.0, k.c.icon_accent));
    }
    if mine {
        r = r.child(pill(k, "you", k.c.text_accent, k.c.layer_02));
    }
    r = r.child(pill(k, i.status.name.clone(), fg, bg));
    if open || picked {
        r = r.fill(k.c.layer_02).border(
            1.0,
            if open {
                k.c.border_focus
            } else {
                k.c.border_strong
            },
        );
    }
    let url = i.permalink.clone();
    k.interactive(r).on_press_tx(move |s: &mut Hooked, tx| {
        if tx.mods().cmd && !url.is_empty() {
            s.open_web(&url, tx);
        } else {
            s.peek_incident(id.clone());
        }
    })
}

fn show(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(show).collect::<Vec<_>>().join(", "),
        Value::Object(o) => o
            .get("name")
            .or(o.get("label"))
            .or(o.get("value"))
            .map(show)
            .unwrap_or_default(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn fact(k: &Kit, label: &str, value: String) -> El {
    row()
        .w_full()
        .gap(10.0)
        .child(
            text(label.to_string())
                .font(k.ty.text_small)
                .color(k.c.text_faint)
                .w(130.0),
        )
        .child(
            text(value)
                .font(k.ty.text_small)
                .color(k.c.text_base)
                .wrap()
                .grow(1.0)
                .shrink(),
        )
}

fn section(k: &Kit, key: &str, title: &str) -> El {
    col()
        .key(format!("incd-{key}"))
        .w_full()
        .gap(6.0)
        .child(section_title(k, title))
}

fn link_button(k: &Kit, label: &str, url: &str) -> Option<El> {
    let url = Some(url.to_string()).filter(|u| !u.is_empty())?;
    Some(
        small(label)
            .on_press_tx(move |s: &mut Hooked, tx| s.open_web(&url, tx))
            .build(k),
    )
}

fn detail(s: &Hooked, k: &Kit, id: &str) -> El {
    let close = IconButton::new(&icons::CLOSE)
        .label("Close")
        .control_size(ControlSize::Small)
        .on_press(|s: &mut Hooked| s.inc.open = None)
        .build(k);
    let base = col().key("incd").w_full().grow(1.0).min_h(0.0);
    let d = match s.inc.details.get(id) {
        Some(Ok(d)) => d,
        other => {
            let msg = match other {
                Some(Err(e)) => note(k, format!("✗ {e}"), k.c.danger.fg),
                _ => row().child(Spinner::new().build(k)),
            };
            return base
                .child(
                    row()
                        .w_full()
                        .px(8.0)
                        .pt(8.0)
                        .child(el().grow(1.0))
                        .child(close),
                )
                .child(col().w_full().padding(24.0).child(msg));
        }
    };
    let str_of = |key: &str| d[key].as_str().unwrap_or("").to_string();
    let reference = str_of("reference");
    let category = d["status"]["category"].as_str().unwrap_or("");
    let (fg, bg) = status_tone(k, category);
    let severity = d["severity"]["name"]
        .as_str()
        .map(|name| crate::incidents::Named {
            id: d["severity"]["id"].as_str().unwrap_or("").to_string(),
            name: name.to_string(),
        });
    let rank = s.inc.org.rank(severity.as_ref());
    let mut pills = row()
        .gap(6.0)
        .center_y()
        .flex_wrap()
        .grow(1.0)
        .shrink()
        .child({
            // A click copies the reference, ready for the Paste of a merge into this incident.
            let copied = reference.clone();
            k.interactive(
                row()
                    .key("incd-ref")
                    .role("button")
                    .label(format!("Copy {reference}"))
                    .gap(4.0)
                    .px(4.0)
                    .center_y()
                    .radius(k.radius.sm)
                    .cursor(Cursor::Pointer)
                    .help(format!("Copy {reference}, to paste it as a merge target"))
                    .child(text(reference.clone()).font(k.ty.mono).color(k.c.text_muted))
                    .child(glyph(&icons::COPY, 11.0, k.c.icon_faint)),
            )
            .on_press_tx(move |s: &mut Hooked, tx| {
                tx.copy(&copied);
                s.flash(format!("✓ Copied {copied}"), false);
            })
        })
        .child(pill(k, show(&d["status"]), fg, bg));
    if let Some(sev) = d["severity"]["name"].as_str() {
        pills = pills.child(
            row()
                .h(20.0)
                .px(8.0)
                .gap(5.0)
                .center_y()
                .radius(10.0)
                .fill(k.c.layer_02)
                .child(
                    el().size(7.0, 7.0)
                        .radius(3.5)
                        .fill(severity_color(s, k, rank)),
                )
                .child(
                    text(sev.to_string())
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.text_base),
                ),
        );
    }
    for (key, plain) in [("mode", "standard"), ("visibility", "public")] {
        let v = str_of(key);
        if !v.is_empty() && v != plain {
            pills = pills.child(pill(k, v, k.c.text_muted, k.c.layer_02));
        }
    }
    let mut meta: Vec<String> = Vec::new();
    if let Some(t) = d["incident_type"]["name"].as_str() {
        meta.push(t.to_string());
    }
    meta.push(format!(
        "reported {} ago",
        fmt::ago_short(d["reported_at"].as_str(), s.now)
    ));
    meta.push(format!(
        "updated {} ago",
        fmt::ago_short(d["updated_at"].as_str(), s.now)
    ));
    let head = col()
        .key("incd-head")
        .w_full()
        .padding(14.0)
        .gap(8.0)
        .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_weak)
        .child(row().w_full().gap(8.0).center_y().child(pills).child(close))
        .child(
            text(str_of("name"))
                .font(k.ty.body_medium)
                .color(k.c.text_base)
                .wrap(),
        )
        .child(
            text(meta.join(" · "))
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        )
        .child(actions(s, k, id, d));

    let mut body = col().w_full().padding(14.0).gap(16.0);
    if let Some(m) = d.get("merged_into").filter(|m| m.is_object()) {
        let target = m["id"].as_str().unwrap_or("").to_string();
        let mut banner = row()
            .key("incd-merged")
            .w_full()
            .px(12.0)
            .py(8.0)
            .gap(10.0)
            .center_y()
            .radius(k.radius.md)
            .fill(k.c.layer_01)
            .border(1.0, k.c.border_base)
            .child(glyph(&icons::MERGE, 14.0, k.c.icon_accent))
            .child(
                text(format!(
                    "Merged into {} · {}",
                    m["reference"].as_str().unwrap_or(""),
                    m["name"].as_str().unwrap_or("")
                ))
                .font(k.ty.text_small)
                .color(k.c.text_base)
                .truncate()
                .grow(1.0)
                .shrink(),
            )
            .child(
                small("Open it")
                    .on_press(move |s: &mut Hooked| s.peek_incident(target.clone()))
                    .build(k),
            );
        if s.inc.can("incident_unmerge") {
            let me = id.to_string();
            banner = banner.child(
                small("Unmerge")
                    .disabled(s.inc.busy)
                    .on_press(move |s: &mut Hooked| s.unmerge_incidents(vec![me.clone()]))
                    .build(k)
                    .key("incd-unmerge"),
            );
        }
        body = body.child(banner);
    }
    let summary = d["summary"]
        .as_str()
        .or(d["ai_summary"].as_str())
        .unwrap_or("");
    if !summary.is_empty() {
        body = body.child(
            section(k, "summary", "SUMMARY")
                .child(super::md(summary.to_string()).selectable(true).build(k)),
        );
    }
    body = body.child(roles(s, k, id, d));
    let people: Vec<String> = d["participants"]
        .as_array()
        .into_iter()
        .flatten()
        .map(show)
        .collect();
    if !people.is_empty() {
        let more = if d["participants_truncated"].as_bool() == Some(true) {
            ", …"
        } else {
            ""
        };
        body = body.child(
            section(
                k,
                "people",
                &format!(
                    "PARTICIPANTS · {}",
                    d["participant_count"]
                        .as_u64()
                        .unwrap_or(people.len() as u64)
                ),
            )
            .child(note(
                k,
                format!("{}{more}", people.join(", ")),
                k.c.text_base,
            )),
        );
    }
    let alerts = d["alerts"].as_array().cloned().unwrap_or_default();
    if !alerts.is_empty() {
        let mut sec = section(k, "alerts", &format!("ALERTS · {}", alerts.len()));
        for a in &alerts {
            let firing = a["status"].as_str() == Some("firing");
            sec = sec.child(
                row()
                    .w_full()
                    .gap(8.0)
                    .center_y()
                    .child(el().size(8.0, 8.0).radius(4.0).fill(if firing {
                        k.c.danger.icon
                    } else {
                        k.c.success.icon
                    }))
                    .child(
                        text(show(&a["title"]))
                            .font(k.ty.text_small)
                            .color(k.c.text_base)
                            .truncate()
                            .grow(1.0)
                            .shrink(),
                    )
                    .child(
                        text(show(&a["status"]))
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_faint),
                    ),
            );
        }
        body = body.child(sec);
    }
    let updates = d["updates"].as_array().cloned().unwrap_or_default();
    if !updates.is_empty() {
        let total = d["updates_total_count"]
            .as_u64()
            .unwrap_or(updates.len() as u64);
        let mut sec = section(
            k,
            "updates",
            &if total > updates.len() as u64 {
                format!("UPDATES · latest {} of {total}", updates.len())
            } else {
                format!("UPDATES · {total}")
            },
        );
        for u in &updates {
            let mut line: Vec<String> = vec![show(&u["author"])];
            for key in ["status", "severity"] {
                let v = show(&u[key]);
                if !v.is_empty() {
                    line.push(v);
                }
            }
            line.retain(|x| !x.is_empty());
            let mut item = col()
                .w_full()
                .pl(10.0)
                .gap(3.0)
                .border_sides([0.0, 0.0, 0.0, 2.0], k.c.border_weak)
                .child(
                    text(format!(
                        "{} · {} ago",
                        line.join(" · "),
                        fmt::ago_short(u["at"].as_str(), s.now)
                    ))
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_faint),
                );
            if let Some(m) = u["message"].as_str().filter(|m| !m.is_empty()) {
                item = item.child(super::md(m.to_string()).selectable(true).build(k));
            }
            sec = sec.child(item);
        }
        body = body.child(sec);
    }
    if let Some(inv) = d.get("investigation").filter(|v| v.is_object()) {
        let status = inv["status"].as_str().unwrap_or("");
        let mut sec = section(k, "investigation", "AI INVESTIGATION");
        let texts: Vec<&str> = inv
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(key, _)| key.as_str() != "status")
            .filter_map(|(_, v)| v.as_str())
            .filter(|t| !t.is_empty())
            .collect();
        sec = sec.child(note(
            k,
            match status {
                "none" | "" if texts.is_empty() => "No investigation on this incident.".to_string(),
                other => format!("Status: {other}"),
            },
            k.c.text_faint,
        ));
        for t in texts {
            sec = sec.child(super::md(t.to_string()).selectable(true).build(k));
        }
        body = body.child(sec);
    }
    let fields = d["custom_fields"].as_array().cloned().unwrap_or_default();
    let stamps = d["timestamps"].as_array().cloned().unwrap_or_default();
    if !fields.is_empty() || !stamps.is_empty() || d.get("workload").is_some() {
        let mut sec = section(k, "facts", "DETAILS");
        for f in &fields {
            sec = sec.child(fact(k, &show(&f["name"]), show(&f["value"])));
        }
        for t in &stamps {
            let at = t["value"].as_str();
            sec = sec.child(fact(
                k,
                &show(&t["name"]),
                format!(
                    "{} ({} ago)",
                    at.unwrap_or("").replace('T', " ").trim_end_matches('Z'),
                    fmt::ago_short(at, s.now)
                ),
            ));
        }
        if let Some(m) = d["workload"]["total_minutes"].as_f64() {
            sec = sec.child(fact(
                k,
                "Responder time",
                fmt::span((m * 60_000.0) as i64, " "),
            ));
        }
        body = body.child(sec);
    }
    base.child(head).child(
        col()
            .key("incd-body")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .child(body),
    )
}

/// Ways into the incident. None of the links changes it; the pin lives in the desktop app.
fn actions(s: &Hooked, k: &Kit, id: &str, d: &Value) -> El {
    let str_of = |key: &str| d[key].as_str().unwrap_or("");
    let mut r = row().key("incd-actions").w_full().gap(6.0).flex_wrap();
    let deep = str_of("slack_channel_deep_link").to_string();
    let web = ["slack_channel_url", "chat_channel_url"]
        .into_iter()
        .map(str_of)
        .find(|u| !u.is_empty())
        .unwrap_or("")
        .to_string();
    r = r.children(link_button(k, "Open in incident.io", str_of("permalink")));
    if !deep.is_empty() || !web.is_empty() {
        r = r.child(
            small("Join the channel")
                .help("Opens the incident's channel in Slack, where you can join it.")
                .on_press_tx(move |s: &mut Hooked, tx| {
                    s.open_incident_channel(deep.clone(), web.clone(), tx);
                })
                .build(k)
                .key("incd-channel"),
        );
    }
    r = r.children(link_button(k, "Join the call", str_of("call_url")));
    if s.inc.tools.contains("incident_pin") {
        let pinned =
            d["external_id"].as_u64().is_some() && d["external_id"].as_u64() == s.inc.pinned;
        let reference = str_of("reference").to_string();
        r = r.child(
            small(if pinned { "Unpin" } else { "Pin" })
                .icon(&icons::PIN)
                .disabled(s.inc.busy)
                .help("Makes it \"my incident\" for the incident.io desktop app and the Claude sessions that use it. Nobody is added to the incident.")
                .on_press(move |s: &mut Hooked| {
                    s.pin_incident((!pinned).then(|| reference.clone()));
                })
                .build(k)
                .key("incd-pin"),
        );
    }
    let ask = id.to_string();
    r = r.child(
        small("Ask Claude")
            .icon(&icons::SPARKLE)
            .help("Opens a new session with a read-only brief about this incident.")
            .on_press(move |s: &mut Hooked| s.claude_on_incident(&ask))
            .build(k)
            .key("incd-claude"),
    );
    let mergeable_here = s.inc.find(id).is_some_and(|i| mergeable(i).is_ok());
    if s.inc.can("incident_merge") && mergeable_here {
        let me = id.to_string();
        r = r.child(
            small("Merge into…")
                .icon(&icons::MERGE)
                .on_press(move |s: &mut Hooked| s.start_merge(vec![me.clone()]))
                .build(k)
                .key("incd-merge"),
        );
    }
    r
}

/// Each role of the organisation with who holds it, and a way to take it.
fn roles(s: &Hooked, k: &Kit, id: &str, d: &Value) -> El {
    let held = d["roles"].as_array().cloned().unwrap_or_default();
    let me = s.inc.org.me.as_deref();
    let live = !matches!(
        d["status"]["category"].as_str().unwrap_or(""),
        "merged" | "canceled" | "declined" | "closed"
    );
    let can_take = s.inc.can("incident_update") && me.is_some() && live;
    let mut sec = section(k, "roles", "ROLES");
    let mut names: Vec<(String, String)> = s.inc.org.roles.clone();
    for h in &held {
        let rid = show(&h["role_id"]);
        if !names.iter().any(|n| n.0 == rid) {
            names.push((rid, show(&h["role"])));
        }
    }
    for (rid, name) in names {
        let holder = held
            .iter()
            .find(|h| h["role_id"].as_str() == Some(rid.as_str()));
        let mine = holder.is_some_and(|h| h["user_id"].as_str() == me && me.is_some());
        let known = s.inc.org.roles.iter().any(|r| r.0 == rid);
        let mut line = row()
            .w_full()
            .h(26.0)
            .gap(10.0)
            .center_y()
            .child(
                text(name.clone())
                    .font(k.ty.text_small)
                    .color(k.c.text_faint)
                    .w(130.0),
            )
            .child(
                text(match holder {
                    Some(h) if mine => format!("{} (you)", show(&h["user"])),
                    Some(h) => show(&h["user"]),
                    None => "Unassigned".into(),
                })
                .font(k.ty.text_small)
                .color(if holder.is_some() {
                    k.c.text_base
                } else {
                    k.c.text_faint
                })
                .truncate()
                .grow(1.0)
                .shrink(),
            );
        if can_take && known && !mine {
            let (incident, role) = (id.to_string(), rid.clone());
            line = line.child(
                small("Take it")
                    .on_press(move |s: &mut Hooked| s.start_role(incident.clone(), role.clone()))
                    .build(k)
                    .key(format!("incd-take-{rid}")),
            );
        }
        sec = sec.child(line);
    }
    if s.inc.org.roles.is_empty() && held.is_empty() {
        sec = sec.child(note(k, "No role assigned.", k.c.text_faint));
    }
    sec
}

fn dialog(k: &Kit, key: &str, title: &str, body: El, dismiss: fn(&mut Hooked)) -> El {
    let panel = col()
        .key(format!("{key}-panel"))
        .w(560.0)
        .padding(16.0)
        .gap(12.0)
        .radius(k.radius.lg)
        .fill(k.c.bg_base)
        .border(1.0, k.c.border_base)
        .box_shadows(&k.elevation.overlay)
        .child(
            text(title.to_string())
                .font(k.ty.ui_medium)
                .color(k.c.text_base),
        )
        .child(body);
    modal_scrim(k, key, 100.0, panel, dismiss)
}

pub fn modal(s: &Hooked, k: &Kit) -> Option<El> {
    if let Some(f) = s.inc.merge.as_ref() {
        return Some(merge_dialog(s, k, f));
    }
    s.inc.role.as_ref().map(|f| role_dialog(k, f))
}

fn merge_dialog(s: &Hooked, k: &Kit, f: &MergeForm) -> El {
    let plan = f.plan();
    let typed = !f.other.text.trim().is_empty();
    let mut body = col().w_full().gap(10.0);
    if f.items.len() > 1 {
        body = body.child(note(
            k,
            "Pick the incident to keep. The others are merged into it.",
            k.c.text_muted,
        ));
    }
    let mut picks = col().key("inc-merge-picks").w_full().gap(10.0);
    for i in &f.items {
        let mut about: Vec<String> = vec![i.status.name.clone()];
        if let Some(sev) = i.severity.as_ref() {
            about.push(sev.name.clone());
        }
        if let Some(l) = i.lead() {
            about.push(format!("lead {}", l.user));
        }
        about.push(format!(
            "reported {} ago",
            fmt::ago_short(Some(&i.reported_at), s.now)
        ));
        if let Err(why) = mergeable(i) {
            about.push(format!("cannot be merged: {why}"));
        }
        let label = format!("{} · {}", i.reference, i.name);
        if f.items.len() == 1 {
            picks = picks.child(
                col()
                    .w_full()
                    .gap(2.0)
                    .child(
                        text(label)
                            .font(k.ty.text_small_medium)
                            .color(k.c.text_base)
                            .wrap(),
                    )
                    .child(note(k, about.join(" · "), k.c.text_faint)),
            );
            continue;
        }
        let on = !typed && f.target.as_deref() == Some(i.id.as_str());
        let id = i.id.clone();
        picks = picks.child(
            RadioItem::new(label, on)
                .description(about.join(" · "))
                .disabled(mergeable(i).is_err() || f.busy)
                .on_select(move |s: &mut Hooked| {
                    if let Some(f) = s.inc.merge.as_mut() {
                        f.target = Some(id.clone());
                        f.other = rune::TextEdit::new("");
                        f.error = None;
                    }
                })
                .build(k)
                .key(format!("inc-merge-pick-{}", i.id)),
        );
    }
    body = body.child(picks).child(
        row()
            .w_full()
            .gap(10.0)
            .center_y()
            .child(
                text(if f.items.len() == 1 {
                    "Merge it into incident"
                } else {
                    "Or merge them all into incident"
                })
                .font(k.ty.text_small)
                .color(k.c.text_muted),
            )
            .child(
                TextInput::new(&f.other)
                    .placeholder("123")
                    .width(Some(120.0))
                    .on_edit(|s: &mut Hooked| {
                        let f = s.inc.merge.as_mut().expect("the merge dialog is open");
                        f.error = None;
                        &mut f.other
                    })
                    .on_change(|s: &mut Hooked, _| s.lookup_merge_target())
                    .build(k)
                    .key("inc-merge-other"),
            )
            .child(
                small("Paste")
                    .icon(&icons::COPY)
                    .disabled(f.busy)
                    .on_press_tx(|s: &mut Hooked, tx| s.paste_merge_target(tx))
                    .build(k)
                    .key("inc-merge-paste"),
            ),
    );
    body = body.child(note(
        k,
        "The number is enough: INC- is optional, and a pasted incident link works too.",
        k.c.text_faint,
    ));
    // The incident a typed number points at, shown before anything is merged into it.
    if typed {
        body = body.child(merge_target_card(s, k, f));
    }
    let ready = plan.args().is_ok();
    let target = plan.target.as_ref().map(|t| t.1.clone());
    if let (true, Some(t)) = (ready, target.as_ref()) {
        let refs: Vec<&str> = plan.sources.iter().map(|i| i.reference.as_str()).collect();
        body = body.child(
            col()
                .key("inc-merge-plan")
                .w_full()
                .padding(10.0)
                .gap(4.0)
                .radius(k.radius.md)
                .fill(k.c.layer_01)
                .border(1.0, k.c.border_weak)
                .child(
                    text(format!("{} → {t}", refs.join(", ")))
                        .font(k.ty.text_small_medium)
                        .color(k.c.text_base)
                        .wrap(),
                )
                .children(plan.skipped.iter().map(|(i, why)| {
                    note(
                        k,
                        format!("{} is left out: {why}", i.reference),
                        k.c.text_faint,
                    )
                })),
        );
    }
    body = body.child(note(
        k,
        "Responders see a merge: each merged incident's channel is archived after a delay, its alerts and attachments move to the incident that is kept, and its subscribers are notified. Undo unmerges them.",
        k.c.warning.fg,
    ));
    if let Some(e) = f.error.as_ref() {
        body = body.child(note(k, format!("✗ {e}"), k.c.danger.fg));
    }
    let label = match (ready, target) {
        (true, Some(t)) if f.busy => format!("Merging into {t}…"),
        (true, Some(t)) => format!(
            "Merge {} into {t}",
            match plan.sources.len() {
                1 => plan.sources[0].reference.clone(),
                n => format!("{n} incidents"),
            }
        ),
        _ => "Merge".into(),
    };
    body = body.child(
        row()
            .w_full()
            .gap(8.0)
            .child(el().grow(1.0))
            .child(
                Button::new("Cancel")
                    .variant(ButtonVariant::GhostMuted)
                    .on_press(|s: &mut Hooked| s.inc.merge = None)
                    .build(k),
            )
            .child(
                Button::new(label)
                    .variant(ButtonVariant::Danger)
                    .disabled(!ready || f.busy)
                    .on_press(|s: &mut Hooked| s.confirm_merge())
                    .build(k)
                    .key("inc-merge-go"),
            ),
    );
    dialog(k, "inc-merge-modal", "Merge incidents", body, |s| {
        if !s.inc.merge.as_ref().is_some_and(|f| f.busy) {
            s.inc.merge = None;
        }
    })
}

/// The incident typed as the merge target: who it is, or why it cannot be used.
fn merge_target_card(s: &Hooked, k: &Kit, f: &MergeForm) -> El {
    let r = crate::incidents::normalize_reference(&f.other.text).unwrap_or_default();
    let card = col()
        .key("inc-merge-target")
        .w_full()
        .padding(10.0)
        .gap(4.0)
        .radius(k.radius.md);
    match f.typed_target() {
        None => card
            .fill(k.c.layer_01)
            .border(1.0, k.c.border_weak)
            .child(note(k, format!("Looking up {r}…"), k.c.text_muted)),
        Some(Err(e)) => card
            .fill(k.c.danger.bg)
            .border(1.0, k.c.danger.border)
            .child(note(k, format!("✗ {r}: {e}"), k.c.danger.fg)),
        Some(Ok(i)) => {
            let mut about: Vec<String> = vec![i.status.name.clone()];
            if let Some(sev) = i.severity.as_ref() {
                about.push(sev.name.clone());
            }
            if let Some(l) = i.lead() {
                about.push(format!("lead {}", l.user));
            }
            about.push(format!("reported {} ago", fmt::ago_short(Some(&i.reported_at), s.now)));
            let blocked = mergeable(i).err();
            let mut c = card
                .fill(if blocked.is_some() { k.c.danger.bg } else { k.c.info.bg })
                .border(1.0, if blocked.is_some() { k.c.danger.border } else { k.c.info.border })
                .child(note(k, "Target", k.c.text_faint))
                .child(
                    text(format!("{} · {}", i.reference, i.name))
                        .font(k.ty.text_small_medium)
                        .color(k.c.text_base)
                        .wrap(),
                )
                .child(note(k, about.join(" · "), k.c.text_muted));
            if let Some(why) = blocked {
                c = c.child(note(k, format!("✗ It cannot take a merge: {why}."), k.c.danger.fg));
            }
            c
        }
    }
}

fn role_dialog(k: &Kit, f: &RoleForm) -> El {
    let mut body = col().w_full().gap(10.0).child(note(
        k,
        match f.holder.as_ref() {
            Some(h) => format!("{h} holds this role now and loses it."),
            None => "Nobody holds this role yet.".into(),
        },
        k.c.text_muted,
    ));
    body = body.child(note(
        k,
        "The change is announced in the incident's channel.",
        k.c.warning.fg,
    ));
    if let Some(e) = f.error.as_ref() {
        body = body.child(note(k, format!("✗ {e}"), k.c.danger.fg));
    }
    body = body.child(
        row()
            .w_full()
            .gap(8.0)
            .child(el().grow(1.0))
            .child(
                Button::new("Cancel")
                    .variant(ButtonVariant::GhostMuted)
                    .on_press(|s: &mut Hooked| s.inc.role = None)
                    .build(k),
            )
            .child(
                Button::new(if f.busy {
                    "Taking it…".to_string()
                } else {
                    format!("Become {}", f.role)
                })
                .variant(ButtonVariant::Submit)
                .disabled(f.busy)
                .on_press(|s: &mut Hooked| s.confirm_role())
                .build(k)
                .key("inc-role-go"),
            ),
    );
    dialog(
        k,
        "inc-role-modal",
        &format!("Take {} on {}?", f.role, f.reference),
        body,
        |s| {
            if !s.inc.role.as_ref().is_some_and(|f| f.busy) {
                s.inc.role = None;
            }
        },
    )
}
