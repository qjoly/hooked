//! Declarative extension views (docs/extensions.md, "Declarative view"): an extension's API
//! serves its desktop page as a JSON tree, rendered here with native widgets. No extension code
//! enters the app, so installing, updating or switching an extension needs no rebuild.
//!
//! Vocabulary v1 (versioned by the extension contract's `api`): `column`, `row`, `section`,
//! `text`, `badge`, `empty`, `list`, `form` (fields `text`, `textarea`, `number`, `bool`,
//! `select`, with an optional server-side `preview`) and `button`. The tree stays a `Value`: every
//! key is optional, and an unknown node or field renders as a notice instead of failing the page.

use std::collections::HashMap;

use rune::{Color, El, ScrollSpec, TextEdit, Tx, col, el, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, SegmentedControl, Switch, TextArea, TextInput};
use serde_json::{Map, Value, json};

use crate::api::{self, enc};
use crate::app::{Hooked, Page};
use crate::extensions::icon_named;
use hooked_ui::widgets::section_title;

const PREVIEW_DEBOUNCE_MS: i64 = 300;
const NEWER_APP: &str = "This view needs a newer hooked desktop app.";

fn st<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}

fn all<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v[key].as_array().map_or(&[], Vec::as_slice)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Post { rest: String, body: Value, confirm: Option<String> },
    View(String),
    OpenSession(String),
    OpenUrl(String),
    Invalid,
}

impl Action {
    /// What an action of the wire (`{ post, body?, confirm? }`, `{ view }`, `{ open }`) means.
    pub fn from(a: &Value) -> Action {
        let owned = |k: &str| a[k].as_str().map(str::to_string);
        if let Some(rest) = owned("post") {
            return Action::Post { rest, body: a["body"].clone(), confirm: owned("confirm") };
        }
        if let Some(path) = owned("view") {
            return Action::View(path);
        }
        match (a["open"]["session"].as_str(), a["open"]["url"].as_str()) {
            (Some(id), _) => Action::OpenSession(id.to_string()),
            (_, Some(url)) => Action::OpenUrl(url.to_string()),
            _ => Action::Invalid,
        }
    }
}

/// What a `post` answered: `{ flash?, error?, errors?, view? }`. `view` is the path to show next.
#[derive(Debug, Default, PartialEq)]
pub struct Outcome {
    pub flash: Option<String>,
    pub error: Option<String>,
    pub errors: HashMap<String, String>,
    pub view: Option<String>,
}

impl Outcome {
    pub fn from(v: &Value) -> Outcome {
        let s = |k: &str| v[k].as_str().map(str::to_string);
        let errors = v["errors"]
            .as_object()
            .map(|o| o.iter().filter_map(|(k, m)| Some((k.clone(), m.as_str()?.to_string()))).collect())
            .unwrap_or_default();
        Outcome { flash: s("flash"), error: s("error"), errors, view: s("view") }
    }
}

pub fn parse_view(v: Value) -> Result<Value, String> {
    if v["type"].is_string() { Ok(v) } else { Err("invalid view: the root has no type".into()) }
}

/// What a `post` sends: the action's body, plus the form's values when it submits one.
pub fn post_body(body: &Value, form: Option<Value>) -> Value {
    let mut out = body.as_object().cloned().unwrap_or_default();
    if let Some(f) = form {
        out.insert("form".into(), f);
    }
    Value::Object(out)
}

/// The forms of a tree, in order: fields live nowhere else.
fn forms<'a>(n: &'a Value, out: &mut Vec<&'a Value>) {
    match st(n, "type") {
        "column" | "row" => all(n, "children").iter().for_each(|c| forms(c, out)),
        "form" => out.push(n),
        _ => {}
    }
}

fn fields(tree: &Value) -> impl Iterator<Item = &Value> {
    let mut found = Vec::new();
    forms(tree, &mut found);
    found.into_iter().flat_map(|f| all(f, "fields"))
}

fn find_form<'a>(tree: &'a Value, id: &str) -> Option<&'a Value> {
    let mut found = Vec::new();
    forms(tree, &mut found);
    found.into_iter().find(|f| st(f, "id") == id)
}

#[derive(Debug, Clone)]
pub enum FieldValue {
    Text(TextEdit),
    Bool(bool),
    Choice(String),
}

impl FieldValue {
    fn from(f: &Value) -> FieldValue {
        match (st(f, "type"), &f["value"]) {
            ("bool", v) => FieldValue::Bool(v.as_bool().unwrap_or(false)),
            ("select", v) => FieldValue::Choice(v.as_str().unwrap_or("").to_string()),
            (_, Value::String(s)) => FieldValue::Text(TextEdit::new(s.clone())),
            (_, Value::Null) => FieldValue::Text(TextEdit::new(String::new())),
            (_, v) => FieldValue::Text(TextEdit::new(v.to_string())),
        }
    }

    fn json(&self, kind: &str) -> Value {
        match (self, kind) {
            (FieldValue::Text(t), "number") => t.text.trim().parse::<f64>().map_or(Value::Null, |n| json!(n)),
            (FieldValue::Text(t), _) => json!(t.text),
            (FieldValue::Bool(b), _) => json!(b),
            (FieldValue::Choice(c), _) => json!(c),
        }
    }
}

#[derive(Debug, Default, Clone)]
pub struct Preview {
    pub asked: String,
    pub changed_at: i64,
    pub lines: Vec<String>,
    pub tone: String,
}

impl Preview {
    fn read(&mut self, v: &Value) {
        self.lines = all(v, "lines").iter().filter_map(|l| l.as_str().map(str::to_string)).collect();
        self.tone = st(v, "tone").to_string();
    }
}

/// One extension page as shown: the path inside the extension, its tree, and what the user typed.
#[derive(Debug, Default)]
pub struct ExtView {
    pub path: String,
    pub tree: Option<Value>,
    pub error: Option<String>,
    pub loading: bool,
    pub loaded_at: i64,
    pub values: HashMap<String, FieldValue>,
    pub field_errors: HashMap<String, String>,
    pub previews: HashMap<String, Preview>,
    pub confirm: Option<(String, Action)>,
}

impl ExtView {
    /// Seeds the inputs from a fresh tree, keeping what the user already typed.
    fn adopt(&mut self, tree: Value) {
        for f in fields(&tree) {
            self.values.entry(st(f, "key").to_string()).or_insert_with(|| FieldValue::from(f));
        }
        self.tree = Some(tree);
    }

    fn loaded(&mut self, r: Result<Value, String>) {
        self.loading = false;
        self.loaded_at = crate::fmt::now_ms();
        match r.and_then(parse_view) {
            Ok(tree) => {
                self.error = None;
                self.adopt(tree);
            }
            Err(e) => self.error = Some(e),
        }
    }

    pub fn form_values(&self, form: &Value) -> Value {
        let mut out = Map::new();
        for f in all(form, "fields") {
            if let Some(v) = self.values.get(st(f, "key")) {
                out.insert(st(f, "key").to_string(), v.json(st(f, "type")));
            }
        }
        Value::Object(out)
    }

    fn text_of(&self, key: &str) -> String {
        match self.values.get(key) {
            Some(FieldValue::Text(t)) => t.text.clone(),
            _ => String::new(),
        }
    }

    /// The fields that ask the server for a preview: (field key, API route).
    fn previewed(&self) -> Vec<(String, String)> {
        let Some(tree) = &self.tree else { return Vec::new() };
        fields(tree).filter_map(|f| Some((st(f, "key").to_string(), f["preview"].as_str()?.to_string()))).collect()
    }

    fn refresh_ms(&self) -> Option<i64> {
        Some(self.tree.as_ref()?["refresh"].as_i64()? * 1000)
    }
}

fn preview_url(id: &str, rest: &str, key: &str, asked: &str, path: &str) -> String {
    format!("/api/{id}/{rest}?{}={}&path={}", enc(key), enc(asked), enc(path))
}

impl Hooked {
    fn view_url(&self, id: &str) -> Option<String> {
        let route = self.ext_info(id)?.view_route()?;
        let path = self.ext.views.get(id).map_or("", |v| v.path.as_str());
        Some(format!("/api/{id}/{route}?path={}", enc(path)))
    }

    pub fn ext_open(&mut self, id: &str, path: &str) {
        self.ext.views.insert(id.to_string(), ExtView { path: path.to_string(), ..Default::default() });
        self.ext_load(id);
    }

    /// The synchronous twin of `ext_open`, for headless renders.
    pub fn ext_preload(&mut self, id: &str) {
        let Some(url) = self.view_url(id) else { return };
        let v = self.ext.views.entry(id.to_string()).or_default();
        v.loaded(api::get(&url));
        for (key, rest) in v.previewed() {
            let asked = v.text_of(&key);
            if let Ok(r) = api::get(&preview_url(id, &rest, &key, &asked, &v.path)) {
                let p = v.previews.entry(key).or_default();
                p.read(&r);
                p.asked = asked;
            }
        }
    }

    pub fn ext_load(&mut self, id: &str) {
        let Some(url) = self.view_url(id) else { return };
        let v = self.ext.views.entry(id.to_string()).or_default();
        v.loading = true;
        let (id, path) = (id.to_string(), v.path.clone());
        self.spawn(
            move || api::get(&url),
            move |s, r, _| {
                if let Some(v) = s.ext.views.get_mut(&id).filter(|v| v.path == path) {
                    v.loaded(r);
                }
            },
        );
    }

    pub fn ext_act(&mut self, id: &str, action: Action, form: Option<String>, confirmed: bool, tx: &mut Tx) {
        match action {
            Action::View(path) => self.ext_open(id, &path),
            Action::OpenSession(sid) => self.open_session(&sid),
            Action::OpenUrl(url) => crate::app::open_link(self, &url, tx),
            Action::Invalid => self.flash("✗ This action needs a newer hooked desktop app", true),
            Action::Post { ref confirm, .. } if confirm.is_some() && !confirmed => {
                let msg = confirm.clone().unwrap_or_default();
                if let Some(v) = self.ext.views.get_mut(id) {
                    v.confirm = Some((msg, action));
                }
            }
            Action::Post { rest, body, .. } => {
                let view = self.ext.views.get_mut(id);
                let form_values = view.as_ref().and_then(|v| Some(v.form_values(find_form(v.tree.as_ref()?, form.as_deref()?)?)));
                if let Some(v) = view {
                    v.confirm = None;
                }
                let payload = post_body(&body, form_values);
                let (id, url) = (id.to_string(), format!("/api/{id}/{rest}"));
                self.spawn(
                    move || api::post_any(&url, payload),
                    move |s, r, _| {
                        let out = r.as_ref().map_or_else(|e| Outcome { error: Some(e.clone()), ..Default::default() }, Outcome::from);
                        if let Some(e) = &out.error {
                            s.flash(format!("✗ {e}"), true);
                        } else if let Some(f) = &out.flash {
                            s.flash(format!("✓ {f}"), false);
                        }
                        if let Some(v) = s.ext.views.get_mut(&id) {
                            v.field_errors = out.errors.clone();
                        }
                        match out.view {
                            Some(path) if out.errors.is_empty() => s.ext_open(&id, &path),
                            _ => s.ext_load(&id),
                        }
                    },
                );
            }
        }
    }

    /// Periodic work of the open extension page: the root's `refresh`, and form previews once the
    /// user stops typing.
    pub fn poll_ext(&mut self, now: i64) -> bool {
        self.poll_extension_list(now);
        let Page::Ext(id) = self.page else { return false };
        let Some(v) = self.ext.views.get_mut(id) else { return false };
        if v.refresh_ms().is_some_and(|r| !v.loading && now - v.loaded_at >= r) {
            self.ext_load(id);
            return false;
        }
        let mut due = Vec::new();
        for (key, rest) in v.previewed() {
            let current = v.text_of(&key);
            let p = v.previews.entry(key.clone()).or_default();
            if p.asked == current {
                continue;
            }
            if p.changed_at == 0 {
                p.changed_at = now;
            }
            if now - p.changed_at < PREVIEW_DEBOUNCE_MS {
                continue;
            }
            p.asked = current.clone();
            p.changed_at = 0;
            due.push((preview_url(id, &rest, &key, &current, &v.path), key, current));
        }
        for (url, key, current) in due {
            self.spawn(
                move || api::get(&url),
                move |s, r, _| {
                    if let Some(p) = s.ext.views.get_mut(id).and_then(|v| v.previews.get_mut(&key)).filter(|p| p.asked == current)
                        && let Ok(v) = r
                    {
                        p.read(&v);
                    }
                },
            );
        }
        false
    }
}

fn tone_color(k: &Kit, tone: &str) -> Color {
    match tone {
        "muted" => k.c.text_muted,
        "warn" => k.c.warning.fg,
        "error" | "danger" => k.c.danger.fg,
        "ok" => k.c.success.fg,
        _ => k.c.text_base,
    }
}

fn small(k: &Kit, s: impl Into<String>, color: Color) -> El {
    text(s.into()).font(k.ty.text_small).color(color).wrap()
}

struct Ctx<'a> {
    k: &'a Kit,
    id: &'static str,
    view: &'a ExtView,
}

/// The whole page of extension `id`.
pub fn page(s: &Hooked, k: &Kit, id: &'static str) -> El {
    let info = s.ext_info(id);
    let label = info.map_or(id, |e| e.label.as_str());
    let body = col().key(format!("ext-{id}")).w_full().max_w(1000.0).self_center().padding(24.0).gap(12.0);
    let body = match s.ext.views.get(id) {
        _ if info.is_some_and(|e| e.view_route().is_none()) => body.child(web_only(k, label, info.and_then(|e| e.page_key()).unwrap_or(id))),
        Some(v) if v.tree.is_some() => {
            let cx = Ctx { k, id, view: v };
            let confirm = v.confirm.as_ref().map(|(msg, action)| confirm_bar(k, id, msg, action.clone()));
            body.children(confirm).child(node(&cx, v.tree.as_ref().unwrap(), "r".into()))
        }
        Some(ExtView { error: Some(e), .. }) => body.child(small(k, format!("{label}: {e}"), k.c.danger.fg)),
        _ => body.child(small(k, "Loading…", k.c.text_muted)),
    };
    col().key(format!("ext-{id}-scroll")).w_full().h_full().scroll(ScrollSpec { stick_bottom: false }).child(body)
}

/// An extension with a web page and no desktop view: the page opens in the browser.
fn web_only(k: &Kit, label: &str, key: &str) -> El {
    let url = format!("{}/{key}", api::base());
    col()
        .gap(10.0)
        .child(small(k, format!("{label} has no desktop page yet."), k.c.text_muted))
        .child(
            Button::new("Open in the browser")
                .control_size(ControlSize::Small)
                .on_press_tx(move |_: &mut Hooked, tx| {
                    let _ = tx.open_url(&url);
                })
                .build(k)
                .key("ext-web"),
        )
}

fn confirm_bar(k: &Kit, id: &'static str, msg: &str, action: Action) -> El {
    let cancel = Button::new("Cancel").variant(ButtonVariant::GhostMuted).control_size(ControlSize::Small).on_press(move |s: &mut Hooked| {
        if let Some(v) = s.ext.views.get_mut(id) {
            v.confirm = None;
        }
    });
    let ok = Button::new("Confirm")
        .variant(ButtonVariant::Danger)
        .control_size(ControlSize::Small)
        .on_press_tx(move |s: &mut Hooked, tx| s.ext_act(id, action.clone(), None, true, tx));
    row()
        .key(format!("ext-{id}-confirm"))
        .w_full()
        .padding(12.0)
        .gap(8.0)
        .center_y()
        .radius(k.radius.lg)
        .fill(k.c.layer_01)
        .border(1.0, k.c.danger.border)
        .child(small(k, msg, k.c.text_base).grow(1.0).shrink())
        .child(cancel.build(k).key(format!("ext-{id}-confirm-no")))
        .child(ok.build(k).key(format!("ext-{id}-confirm-yes")))
}

fn children(cx: &Ctx, n: &Value, base: El, key: &str) -> El {
    all(n, "children").iter().enumerate().fold(base, |c, (i, ch)| c.child(node(cx, ch, format!("{key}.{i}"))))
}

fn actions<'a>(cx: &'a Ctx, n: &'a Value, key: &'a str) -> impl Iterator<Item = El> + 'a {
    all(n, "actions").iter().enumerate().map(move |(i, b)| button(cx, b, None, format!("{key}.a{i}")))
}

fn node(cx: &Ctx, n: &Value, key: String) -> El {
    let k = cx.k;
    match st(n, "type") {
        "column" => children(cx, n, col().key(key.clone()).w_full().gap(12.0), &key),
        "row" => children(cx, n, row().key(key.clone()).w_full().gap(8.0).center_y(), &key),
        "section" => row()
            .key(key.clone())
            .w_full()
            .gap(8.0)
            .center_y()
            .child(text(st(n, "title").to_string()).font(k.ty.ui_medium).color(k.c.text_base))
            .child(el().grow(1.0))
            .children(actions(cx, n, &key)),
        "text" => text(st(n, "value").to_string())
            .font(if n["mono"] == true { k.ty.mono } else { k.ty.text_small })
            .color(tone_color(k, st(n, "tone")))
            .wrap()
            .key(key),
        "badge" => badge(k, n),
        "empty" => small(k, st(n, "text"), k.c.text_muted).key(key),
        "list" => all(n, "items")
            .iter()
            .fold(col().key(key.clone()).w_full().gap(10.0), |c, it| c.child(item(cx, it, format!("{key}.{}", st(it, "key"))))),
        "form" => form(cx, n, key),
        "button" => button(cx, n, None, key),
        _ => small(k, NEWER_APP, k.c.warning.fg).key(key),
    }
}

fn badge(k: &Kit, b: &Value) -> El {
    let tone = match st(b, "tone") {
        "" | "normal" => "muted",
        t => t,
    };
    row()
        .h(20.0)
        .px(8.0)
        .center_y()
        .radius(10.0)
        .fill(k.c.layer_02)
        .child(text(st(b, "label").to_string()).font(if b["mono"] == true { k.ty.mono } else { k.ty.text_xsmall_medium }).color(tone_color(k, tone)))
}

fn item(cx: &Ctx, it: &Value, key: String) -> El {
    let k = cx.k;
    let head = row()
        .w_full()
        .gap(8.0)
        .center_y()
        .child(text(st(it, "title").to_string()).font(k.ty.ui_medium).color(k.c.text_base).shrink())
        .children(all(it, "badges").iter().map(|b| badge(k, b)))
        .child(el().grow(1.0))
        .children(actions(cx, it, &key));
    let sub = Some(st(it, "subtitle")).filter(|t| !t.is_empty()).map(|t| text(t.to_string()).font(k.ty.text_xsmall).color(k.c.text_faint).wrap());
    let body = Some(st(it, "text")).filter(|t| !t.is_empty()).map(|t| small(k, t, k.c.text_muted));
    col()
        .key(key)
        .w_full()
        .padding(14.0)
        .gap(6.0)
        .radius(k.radius.lg)
        .fill(k.c.layer_01)
        .border(1.0, k.c.border_weak)
        .child(head)
        .children(sub)
        .children(body)
}

fn button(cx: &Ctx, b: &Value, form: Option<&str>, key: String) -> El {
    let (id, action, form) = (cx.id, Action::from(&b["action"]), form.map(str::to_string));
    let variant = match st(b, "tone") {
        "primary" => ButtonVariant::Contrast,
        "danger" => ButtonVariant::Danger,
        _ => ButtonVariant::Outline,
    };
    let mut btn = Button::new(st(b, "label").to_string()).variant(variant).control_size(ControlSize::Small);
    if let Some(i) = b["icon"].as_str() {
        btn = btn.icon(icon_named(i));
    }
    btn.on_press_tx(move |s: &mut Hooked, tx| s.ext_act(id, action.clone(), form.clone(), false, tx)).build(cx.k).key(key)
}

fn form(cx: &Ctx, f: &Value, key: String) -> El {
    let k = cx.k;
    let submit = f.get("submit").filter(|b| b.is_object()).map(|b| row().w_full().child(el().grow(1.0)).child(button(cx, b, Some(st(f, "id")), format!("{key}.submit"))));
    col()
        .key(key.clone())
        .w_full()
        .padding(16.0)
        .gap(12.0)
        .radius(k.radius.lg)
        .fill(k.c.surface_raised)
        .border(1.0, k.c.info.border)
        .children(all(f, "fields").iter().map(|fld| field(cx, fld, format!("{key}.{}", st(fld, "key")))))
        .children(submit)
}

fn text_slot<'a>(s: &'a mut Hooked, id: &str, key: &str) -> &'a mut TextEdit {
    let v = s.ext.views.entry(id.to_string()).or_default();
    let slot = v.values.entry(key.to_string()).or_insert_with(|| FieldValue::Text(TextEdit::new(String::new())));
    if !matches!(slot, FieldValue::Text(_)) {
        *slot = FieldValue::Text(TextEdit::new(String::new()));
    }
    match slot {
        FieldValue::Text(t) => t,
        _ => unreachable!(),
    }
}

fn field(cx: &Ctx, f: &Value, key: String) -> El {
    let (k, id, kind, label) = (cx.k, cx.id, st(f, "type"), st(f, "label").to_string());
    let fkey = st(f, "key").to_string();
    let input = match (kind, cx.view.values.get(&fkey)) {
        ("bool", Some(FieldValue::Bool(on))) => Switch::new(*on)
            .label(label.clone())
            .on_toggle(move |s: &mut Hooked| {
                if let Some(FieldValue::Bool(b)) = s.ext.views.get_mut(id).and_then(|v| v.values.get_mut(&fkey)) {
                    *b = !*b;
                }
            })
            .build(k),
        ("select", Some(FieldValue::Choice(cur))) => {
            let options = all(f, "options");
            let labels: Vec<&str> = options.iter().map(|o| st(o, "label")).collect();
            let values: Vec<String> = options.iter().map(|o| st(o, "value").to_string()).collect();
            SegmentedControl::new(&labels, values.iter().position(|v| v == cur))
                .label(label.clone())
                .fit()
                .on_pick(move |s: &mut Hooked, i, _| {
                    if let Some(FieldValue::Choice(c)) = s.ext.views.get_mut(id).and_then(|v| v.values.get_mut(&fkey)) {
                        *c = values[i].clone();
                    }
                })
                .build(k)
        }
        ("textarea", Some(FieldValue::Text(t))) => TextArea::new(t).width(None).auto_grow(3, 12).on_edit(move |s: &mut Hooked| text_slot(s, id, &fkey)).build(k),
        ("text" | "number", Some(FieldValue::Text(t))) => TextInput::new(t).width(None).on_edit(move |s: &mut Hooked| text_slot(s, id, &fkey)).build(k),
        _ => text(NEWER_APP).font(k.ty.text_xsmall).color(k.c.warning.fg),
    };
    let fkey = st(f, "key");
    let note = cx.view.field_errors.get(fkey).map(|e| (e.clone(), "error")).or_else(|| {
        let p = cx.view.previews.get(fkey).filter(|p| !p.lines.is_empty())?;
        Some((p.lines.join("\n"), p.tone.as_str()))
    });
    let note = match note {
        Some((lines, tone)) => Some(text(lines).font(k.ty.text_xsmall).color(tone_color(k, tone)).wrap()),
        None => Some(st(f, "hint")).filter(|h| !h.is_empty()).map(|h| text(h.to_string()).font(k.ty.text_xsmall).color(k.c.text_faint).wrap()),
    };
    col()
        .key(key)
        .w_full()
        .gap(6.0)
        .children((kind != "bool").then(|| section_title(k, &label.to_uppercase())))
        .child(input)
        .children(note)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        let path = format!("{}/tests/fixtures/extview/{name}.json", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
    }

    #[test]
    fn reads_the_actions_and_refresh_of_the_cron_list() {
        let mut v = ExtView::default();
        v.adopt(parse_view(fixture("cron-list")).unwrap());
        assert_eq!(v.refresh_ms(), Some(10_000));
        let tree = v.tree.as_ref().unwrap();
        let section = &tree["children"][0];
        assert_eq!(st(section, "title"), "Cron");
        assert_eq!(Action::from(&section["actions"][0]["action"]), Action::View("edit".into()));
        let item = &tree["children"][1]["items"][0];
        assert_eq!(item["badges"][0], json!({ "label": "0 9 * * 1-5", "tone": "muted", "mono": true }));
        let kinds: Vec<Action> = all(item, "actions").iter().map(|b| Action::from(&b["action"])).collect();
        assert_eq!(kinds[0], Action::Post { rest: "view".into(), body: json!({ "op": "run", "id": "abc" }), confirm: None });
        assert_eq!(kinds[2], Action::View("edit/abc".into()));
        assert!(matches!(kinds.last(), Some(Action::Post { confirm: Some(c), .. }) if c == "Delete \"Standup\"?"));
    }

    #[test]
    fn an_unknown_node_or_field_renders_a_notice_instead_of_failing() {
        let tree = parse_view(json!({ "type": "column", "children": [
            { "type": "chart", "series": [] },
            { "type": "text", "value": "hi", "tone": "sparkly" },
            { "type": "form", "id": "f", "fields": [{ "type": "color", "key": "c", "label": "C" }] },
            { "type": "row", "children": [
                { "type": "badge", "label": "on", "tone": "ok" },
                { "type": "empty" },
                { "type": "button", "label": "Docs", "action": { "open": { "url": "https://example.com" } } }
            ] }
        ] }))
        .unwrap();
        let mut view = ExtView::default();
        view.adopt(tree.clone());
        let k = crate::theme::kit(false);
        node(&Ctx { k: &k, id: "x", view: &view }, &tree, "r".into());
        assert_eq!(Action::from(&tree["children"][3]["children"][2]["action"]), Action::OpenUrl("https://example.com".into()));
        assert!(parse_view(json!({ "children": [] })).is_err());
    }

    #[test]
    fn a_form_posts_its_values_with_the_action_body() {
        let tree = parse_view(fixture("cron-edit")).unwrap();
        let mut v = ExtView::default();
        v.adopt(tree.clone());
        if let Some(FieldValue::Text(t)) = v.values.get_mut("schedule") {
            *t = TextEdit::new("*/5 * * * *");
        }
        if let Some(FieldValue::Bool(b)) = v.values.get_mut("enabled") {
            *b = false;
        }
        let form = find_form(&tree, "task").unwrap();
        let body = post_body(&json!({ "op": "save", "id": "abc" }), Some(v.form_values(form)));
        assert_eq!(body, json!({ "op": "save", "id": "abc", "form": {
            "name": "Standup", "schedule": "*/5 * * * *", "cwd": "/tmp/p", "prompt": "Summarize", "enabled": false, "max": 3.0, "mode": "auto"
        } }));
        assert_eq!(v.previewed(), vec![("schedule".to_string(), "preview".to_string())]);
        // A refresh keeps what the user typed.
        v.adopt(tree);
        assert!(matches!(v.values.get("schedule"), Some(FieldValue::Text(t)) if t.text == "*/5 * * * *"));
    }

    #[test]
    fn reads_what_a_post_answered() {
        assert_eq!(
            Outcome::from(&json!({ "errors": { "schedule": "invalid schedule: bad" } })),
            Outcome { errors: [("schedule".to_string(), "invalid schedule: bad".to_string())].into(), ..Default::default() }
        );
        assert_eq!(Outcome::from(&json!({ "flash": "Saved", "view": "" })), Outcome { flash: Some("Saved".into()), view: Some(String::new()), ..Default::default() });
        assert_eq!(Action::from(&json!({ "open": { "session": "s1" } })), Action::OpenSession("s1".into()));
        assert_eq!(Action::from(&json!({})), Action::Invalid);
    }
}
