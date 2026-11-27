//! Declarative extension views (docs/extensions.md, "Declarative view"): an extension's API
//! serves its desktop page as a JSON tree, rendered here with native widgets. No extension code
//! enters the app, so installing, updating or switching an extension needs no rebuild.
//!
//! Vocabulary v1 (versioned by the extension contract's `api`): `column`, `row`, `section`,
//! `text`, `badge`, `empty`, `list`, `form` (fields `text`, `textarea`, `number`, `bool`,
//! `select`, with an optional server-side `preview`) and `button`. An unknown node renders as a
//! notice instead of failing the page.

use std::collections::HashMap;

use rune::{Color, El, ScrollSpec, TextEdit, col, el, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, SegmentedControl, Switch, TextArea, TextInput};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::api::{self, enc};
use crate::app::{Hooked, Page};
use crate::icons;
use hooked_ui::widgets::section_title;

const PREVIEW_DEBOUNCE_MS: i64 = 300;
/// A fallback only: the service pushes `extensionsChanged` on its stream (`start_workers`).
const LIST_REFRESH_MS: i64 = 30_000;

#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Node {
    Column {
        #[serde(default)]
        children: Vec<Node>,
        #[serde(default)]
        refresh: Option<u64>,
    },
    Row {
        #[serde(default)]
        children: Vec<Node>,
    },
    Section {
        title: String,
        #[serde(default)]
        actions: Vec<ButtonSpec>,
    },
    Text {
        value: String,
        #[serde(default)]
        tone: Tone,
        #[serde(default)]
        mono: bool,
    },
    Badge(BadgeSpec),
    Empty {
        text: String,
    },
    List {
        items: Vec<Item>,
    },
    Form(FormSpec),
    Button(ButtonSpec),
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    #[default]
    Normal,
    Muted,
    Warn,
    Error,
    Ok,
    Primary,
    Danger,
    #[serde(other)]
    Other,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct BadgeSpec {
    pub label: String,
    #[serde(default)]
    pub tone: Tone,
    #[serde(default)]
    pub mono: bool,
}

#[derive(Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(default)]
pub struct Item {
    pub key: String,
    pub title: String,
    pub subtitle: String,
    pub text: String,
    pub badges: Vec<BadgeSpec>,
    pub actions: Vec<ButtonSpec>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct FormSpec {
    pub id: String,
    pub fields: Vec<Field>,
    #[serde(default)]
    pub submit: Option<ButtonSpec>,
}

#[derive(Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(default)]
pub struct Field {
    #[serde(rename = "type")]
    pub kind: FieldKind,
    pub key: String,
    pub label: String,
    pub value: Value,
    pub hint: String,
    pub options: Vec<Choice>,
    pub preview: Option<String>,
    pub mono: bool,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum FieldKind {
    #[default]
    Text,
    Textarea,
    Number,
    Bool,
    Select,
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Choice {
    pub value: String,
    pub label: String,
}

#[derive(Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(default)]
pub struct ButtonSpec {
    pub label: String,
    pub icon: Option<String>,
    pub tone: Tone,
    pub action: ActionSpec,
}

/// The wire shape of an action; `Action` is what it means.
#[derive(Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(default)]
pub struct ActionSpec {
    pub post: Option<String>,
    pub body: Option<Value>,
    pub confirm: Option<String>,
    pub view: Option<String>,
    pub open: Option<OpenSpec>,
}

#[derive(Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(default)]
pub struct OpenSpec {
    pub session: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Post { rest: String, body: Value, confirm: Option<String> },
    View(String),
    OpenSession(String),
    OpenUrl(String),
    Invalid,
}

impl From<&ActionSpec> for Action {
    fn from(a: &ActionSpec) -> Action {
        if let Some(rest) = &a.post {
            return Action::Post { rest: rest.clone(), body: a.body.clone().unwrap_or(json!({})), confirm: a.confirm.clone() };
        }
        if let Some(path) = &a.view {
            return Action::View(path.clone());
        }
        match &a.open {
            Some(OpenSpec { session: Some(id), .. }) => Action::OpenSession(id.clone()),
            Some(OpenSpec { url: Some(u), .. }) => Action::OpenUrl(u.clone()),
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

pub fn parse_view(v: Value) -> Result<Node, String> {
    serde_json::from_value(v).map_err(|e| format!("invalid view: {e}"))
}

/// What a `post` sends: the action's body, plus the form's values when it submits one.
pub fn post_body(body: &Value, form: Option<Value>) -> Value {
    let mut out = body.as_object().cloned().unwrap_or_default();
    if let Some(f) = form {
        out.insert("form".into(), f);
    }
    Value::Object(out)
}

#[derive(Debug, Clone)]
pub enum FieldValue {
    Text(TextEdit),
    Bool(bool),
    Choice(String),
}

impl FieldValue {
    fn from(f: &Field) -> FieldValue {
        match f.kind {
            FieldKind::Bool => FieldValue::Bool(f.value.as_bool().unwrap_or(false)),
            FieldKind::Select => FieldValue::Choice(f.value.as_str().unwrap_or("").to_string()),
            _ => FieldValue::Text(TextEdit::new(match &f.value {
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                v => v.to_string(),
            })),
        }
    }

    fn json(&self, kind: FieldKind) -> Value {
        match (self, kind) {
            (FieldValue::Text(t), FieldKind::Number) => t.text.trim().parse::<f64>().map_or(Value::Null, |n| json!(n)),
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
    pub tone: Tone,
}

/// One extension page as shown: the path inside the extension, its tree, and what the user typed.
#[derive(Debug, Default)]
pub struct ExtView {
    pub path: String,
    pub tree: Option<Node>,
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
    fn adopt(&mut self, tree: Node) {
        for_each_field(&tree, &mut |f| {
            self.values.entry(f.key.clone()).or_insert_with(|| FieldValue::from(f));
        });
        self.tree = Some(tree);
    }

    pub fn form_values(&self, form: &FormSpec) -> Value {
        let mut out = Map::new();
        for f in &form.fields {
            if let Some(v) = self.values.get(&f.key) {
                out.insert(f.key.clone(), v.json(f.kind));
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
}

fn for_each_field<'a>(n: &'a Node, f: &mut impl FnMut(&'a Field)) {
    match n {
        Node::Column { children, .. } | Node::Row { children } => children.iter().for_each(|c| for_each_field(c, f)),
        Node::Form(form) => form.fields.iter().for_each(f),
        _ => {}
    }
}

fn find_form<'a>(n: &'a Node, id: &str) -> Option<&'a FormSpec> {
    match n {
        Node::Form(f) if f.id == id => Some(f),
        Node::Column { children, .. } | Node::Row { children } => children.iter().find_map(|c| find_form(c, id)),
        _ => None,
    }
}

/// An extension as GET /api/extensions lists it (the fields the app needs).
#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct ExtInfo {
    pub id: String,
    pub label: String,
    pub description: String,
    pub icon: String,
    pub page: Option<Value>,
    pub desktop: Option<Value>,
    pub enabled: bool,
    pub active: bool,
}

impl ExtInfo {
    /// The API route of its declarative desktop view, if it has one.
    pub fn view_route(&self) -> Option<&str> {
        self.desktop.as_ref()?["view"].as_str()
    }
    pub fn page_key(&self) -> Option<&str> {
        self.page.as_ref()?["key"].as_str()
    }
    pub fn order(&self) -> f64 {
        self.page.as_ref().and_then(|p| p["order"].as_f64()).unwrap_or(1000.0)
    }
}

#[derive(Debug, Default)]
pub struct ExtState {
    pub list: Vec<ExtInfo>,
    pub list_at: i64,
    pub views: HashMap<String, ExtView>,
}

/// Extension ids, labels and keys as `&'static str`, so `Page` stays `Copy` and the navigation
/// keeps its static tables: a handful of strings, leaked once each.
pub fn intern(s: &str) -> &'static str {
    use std::sync::{Mutex, OnceLock};
    static ALL: OnceLock<Mutex<Vec<&'static str>>> = OnceLock::new();
    let mut all = ALL.get_or_init(Default::default).lock().unwrap();
    if let Some(found) = all.iter().copied().find(|x| *x == s) {
        return found;
    }
    let leaked: &'static str = Box::leak(s.to_string().into_boxed_str());
    all.push(leaked);
    leaked
}

pub fn page_of(id: &str) -> Page {
    Page::Ext(intern(id))
}

/// (nav key, label) of the extensions' declarative pages, for Settings → navigation.
pub fn nav_keys(s: &Hooked) -> impl Iterator<Item = (&'static str, &'static str)> + '_ {
    s.ext.list.iter().filter(|e| e.view_route().is_some() && e.enabled).filter_map(|e| Some((intern(e.page_key()?), intern(&e.label))))
}

pub fn icon_named(name: &str) -> &'static rune::Icon {
    match name {
        "clock" | "timer" => &icons::TIMER,
        "plus" => &icons::PLUS,
        "play" => &icons::PLAY,
        "zap" | "sparkle" => &icons::SPARKLE,
        "github" => &icons::GITHUB,
        "workflow" => &icons::WORKFLOW,
        "book" => &icons::BOOK,
        _ => &icons::PLUG,
    }
}

impl Hooked {
    pub fn ext_info(&self, id: &str) -> Option<&ExtInfo> {
        self.ext.list.iter().find(|e| e.id == id)
    }

    /// The extension whose page has `key` (a nav key, `defaultPage`, `--page`).
    pub fn ext_page_for(&self, key: &str) -> Option<Page> {
        self.ext.list.iter().find(|e| e.enabled && e.page_key() == Some(key)).map(|e| page_of(&e.id))
    }

    /// An extension switched off or removed takes its page with it, the open one included: no tab
    /// is left behind to say it is off.
    fn leave_extension_page_if_gone(&mut self) {
        if let Page::Ext(id) = self.page
            && !self.page_on(self.page)
        {
            self.ext.views.remove(id);
            self.go_deck();
        }
    }

    pub fn set_extension_enabled(&mut self, id: &str, enabled: bool) {
        let body = json!({ "id": id, "enabled": enabled });
        self.spawn(
            move || api::post_any("/api/extensions", body),
            |s, r, _| match r {
                Ok(v) => {
                    s.ext.list = serde_json::from_value(v["extensions"].clone()).unwrap_or_default();
                    s.leave_extension_page_if_gone();
                }
                Err(e) => s.flash(format!("✗ {e}"), true),
            },
        );
    }

    pub fn load_extensions(&mut self) {
        self.ext.list_at = crate::fmt::now_ms();
        self.spawn(
            || api::get("/api/extensions"),
            |s, r, _| {
                if let Ok(v) = r {
                    s.ext.list = serde_json::from_value(v["extensions"].clone()).unwrap_or_default();
                    s.leave_extension_page_if_gone();
                }
            },
        );
    }

    pub fn ext_open(&mut self, id: &str, path: &str) {
        let v = self.ext.views.entry(id.to_string()).or_default();
        *v = ExtView { path: path.to_string(), ..Default::default() };
        self.ext_load(id);
    }

    /// The synchronous twin of `ext_open`, for headless renders.
    pub fn ext_preload(&mut self, id: &str) {
        let Some(route) = self.ext_info(id).and_then(|e| e.view_route()).map(str::to_string) else {
            return;
        };
        let v = self.ext.views.entry(id.to_string()).or_default();
        match api::get(&format!("/api/{id}/{route}?path={}", enc(&v.path))).and_then(parse_view) {
            Ok(tree) => v.adopt(tree),
            Err(e) => v.error = Some(e),
        }
        v.loaded_at = crate::fmt::now_ms();
        let mut wanted = Vec::new();
        if let Some(tree) = &v.tree {
            for_each_field(tree, &mut |f| wanted.extend(f.preview.clone().map(|rest| (f.key.clone(), rest))));
        }
        for (key, rest) in wanted {
            let asked = v.text_of(&key);
            if let Ok(r) = api::get(&format!("/api/{id}/{rest}?{}={}&path={}", enc(&key), enc(&asked), enc(&v.path))) {
                let lines = r["lines"].as_array().into_iter().flatten().filter_map(|l| l.as_str().map(str::to_string)).collect();
                let tone = serde_json::from_value(r["tone"].clone()).unwrap_or_default();
                v.previews.insert(key, Preview { asked, changed_at: 0, lines, tone });
            }
        }
    }

    pub fn ext_load(&mut self, id: &str) {
        let Some(route) = self.ext_info(id).and_then(|e| e.view_route()).map(str::to_string) else {
            return;
        };
        let v = self.ext.views.entry(id.to_string()).or_default();
        v.loading = true;
        let url = format!("/api/{id}/{route}?path={}", enc(&v.path));
        let (id, path) = (id.to_string(), v.path.clone());
        self.spawn(
            move || api::get(&url),
            move |s, r, _| {
                let Some(v) = s.ext.views.get_mut(&id).filter(|v| v.path == path) else {
                    return;
                };
                v.loading = false;
                v.loaded_at = crate::fmt::now_ms();
                match r.and_then(parse_view) {
                    Ok(tree) => {
                        v.error = None;
                        v.adopt(tree);
                    }
                    Err(e) => v.error = Some(e),
                }
            },
        );
    }

    pub fn ext_act(&mut self, id: &str, action: Action, form: Option<String>, confirmed: bool) {
        match action {
            Action::View(path) => self.ext_open(id, &path),
            Action::OpenSession(sid) => self.open_session(&sid),
            Action::OpenUrl(url) => self.flash(format!("Open {url} in a browser"), false),
            Action::Invalid => self.flash("✗ This action needs a newer hooked desktop app", true),
            Action::Post { ref confirm, .. } if confirm.is_some() && !confirmed => {
                let msg = confirm.clone().unwrap_or_default();
                if let Some(v) = self.ext.views.get_mut(id) {
                    v.confirm = Some((msg, action));
                }
            }
            Action::Post { rest, body, .. } => {
                let view = self.ext.views.get_mut(id);
                let form_values = view.as_ref().and_then(|v| {
                    let f = find_form(v.tree.as_ref()?, form.as_deref()?)?;
                    Some(v.form_values(f))
                });
                if let Some(v) = view {
                    v.confirm = None;
                }
                let payload = post_body(&body, form_values);
                let (id, url) = (id.to_string(), format!("/api/{id}/{rest}"));
                self.spawn(
                    move || api::post_any(&url, payload),
                    move |s, r, _| {
                        let out = r.as_ref().map(Outcome::from).unwrap_or_else(|e| Outcome { error: Some(e.clone()), ..Default::default() });
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
    /// user stops typing. Also keeps the extension list fresh for the navigation.
    pub fn poll_ext(&mut self, now: i64) -> bool {
        if now - self.ext.list_at > LIST_REFRESH_MS {
            self.load_extensions();
        }
        let Page::Ext(id) = self.page else {
            return false;
        };
        let Some(v) = self.ext.views.get_mut(id) else {
            return false;
        };
        let refresh = match &v.tree {
            Some(Node::Column { refresh: Some(r), .. }) => Some(*r as i64 * 1000),
            _ => None,
        };
        if refresh.is_some_and(|r| !v.loading && now - v.loaded_at >= r) {
            self.ext_load(id);
            return false;
        }
        let mut wanted = Vec::new();
        if let Some(tree) = &v.tree {
            for_each_field(tree, &mut |f| {
                if let Some(rest) = &f.preview {
                    wanted.push((f.key.clone(), rest.clone()));
                }
            });
        }
        let mut due = Vec::new();
        for (key, rest) in wanted {
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
            let url = format!("/api/{id}/{rest}?{}={}&path={}", enc(&key), enc(&current), enc(&v.path));
            due.push((key, current, url));
        }
        for (key, current, url) in due {
            self.spawn(
                move || api::get(&url),
                move |s, r, _| {
                    if let Some(p) = s.ext.views.get_mut(id).and_then(|v| v.previews.get_mut(&key)).filter(|p| p.asked == current)
                        && let Ok(v) = r
                    {
                        p.lines = v["lines"].as_array().into_iter().flatten().filter_map(|l| l.as_str().map(str::to_string)).collect();
                        p.tone = serde_json::from_value(v["tone"].clone()).unwrap_or_default();
                    }
                },
            );
        }
        false
    }
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────

fn tone_color(k: &Kit, t: Tone) -> Color {
    match t {
        Tone::Muted => k.c.text_muted,
        Tone::Warn => k.c.warning.fg,
        Tone::Error | Tone::Danger => k.c.danger.fg,
        Tone::Ok => k.c.success.fg,
        _ => k.c.text_base,
    }
}

fn variant(t: Tone) -> ButtonVariant {
    match t {
        Tone::Primary => ButtonVariant::Contrast,
        Tone::Danger => ButtonVariant::Danger,
        _ => ButtonVariant::Outline,
    }
}

struct Ctx<'a> {
    k: &'a Kit,
    id: &'static str,
    view: &'a ExtView,
}

/// The whole page of extension `id`.
pub fn page(s: &Hooked, k: &Kit, id: &'static str) -> El {
    let label = s.ext_info(id).map_or(id.to_string(), |e| e.label.clone());
    let mut body = col().key(format!("ext-{id}")).w_full().max_w(1000.0).self_center().padding(24.0).gap(12.0);
    match s.ext.views.get(id) {
        Some(v) if v.tree.is_some() => {
            let cx = Ctx { k, id, view: v };
            if let Some((msg, action)) = &v.confirm {
                body = body.child(confirm_bar(k, id, msg, action.clone()));
            }
            body = body.child(node(&cx, v.tree.as_ref().unwrap(), "r".into()));
        }
        Some(ExtView { error: Some(e), .. }) => body = body.child(text(format!("{label}: {e}")).font(k.ty.text_small).color(k.c.danger.fg).wrap()),
        _ => body = body.child(text("Loading…").font(k.ty.text_small).color(k.c.text_muted)),
    }
    col().key(format!("ext-{id}-scroll")).w_full().h_full().scroll(ScrollSpec { stick_bottom: false }).child(body)
}

fn confirm_bar(k: &Kit, id: &'static str, msg: &str, action: Action) -> El {
    row()
        .key(format!("ext-{id}-confirm"))
        .w_full()
        .padding(12.0)
        .gap(8.0)
        .center_y()
        .radius(k.radius.lg)
        .fill(k.c.layer_01)
        .border(1.0, k.c.danger.border)
        .child(text(msg.to_string()).font(k.ty.text_small).color(k.c.text_base).grow(1.0).shrink())
        .child(
            Button::new("Cancel")
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut Hooked| {
                    if let Some(v) = s.ext.views.get_mut(id) {
                        v.confirm = None;
                    }
                })
                .build(k)
                .key(format!("ext-{id}-confirm-no")),
        )
        .child(
            Button::new("Confirm")
                .variant(ButtonVariant::Danger)
                .control_size(ControlSize::Small)
                .on_press(move |s: &mut Hooked| s.ext_act(id, action.clone(), None, true))
                .build(k)
                .key(format!("ext-{id}-confirm-yes")),
        )
}

fn node(cx: &Ctx, n: &Node, key: String) -> El {
    let k = cx.k;
    match n {
        Node::Column { children, .. } => children
            .iter()
            .enumerate()
            .fold(col().key(key.clone()).w_full().gap(12.0), |c, (i, ch)| c.child(node(cx, ch, format!("{key}.{i}")))),
        Node::Row { children } => children
            .iter()
            .enumerate()
            .fold(row().key(key.clone()).w_full().gap(8.0).center_y(), |r, (i, ch)| r.child(node(cx, ch, format!("{key}.{i}")))),
        Node::Section { title, actions } => row()
            .key(key.clone())
            .w_full()
            .gap(8.0)
            .center_y()
            .child(text(title.clone()).font(k.ty.ui_medium).color(k.c.text_base))
            .child(el().grow(1.0))
            .children(actions.iter().enumerate().map(|(i, b)| button(cx, b, None, format!("{key}.a{i}")))),
        Node::Text { value, tone, mono } => text(value.clone())
            .font(if *mono { k.ty.mono } else { k.ty.text_small })
            .color(tone_color(k, *tone))
            .wrap()
            .key(key),
        Node::Badge(b) => badge(k, b),
        Node::Empty { text: t } => text(t.clone()).font(k.ty.text_small).color(k.c.text_muted).wrap().key(key),
        Node::List { items } => items
            .iter()
            .fold(col().key(key.clone()).w_full().gap(10.0), |c, it| c.child(item(cx, it, format!("{key}.{}", it.key)))),
        Node::Form(f) => form(cx, f, key),
        Node::Button(b) => button(cx, b, None, key),
        Node::Unknown => text("This view needs a newer hooked desktop app.").font(k.ty.text_small).color(k.c.warning.fg).key(key),
    }
}

fn badge(k: &Kit, b: &BadgeSpec) -> El {
    let fg = tone_color(k, if b.tone == Tone::Normal { Tone::Muted } else { b.tone });
    row()
        .h(20.0)
        .px(8.0)
        .center_y()
        .radius(10.0)
        .fill(k.c.layer_02)
        .child(text(b.label.clone()).font(if b.mono { k.ty.mono } else { k.ty.text_xsmall_medium }).color(fg))
}

fn item(cx: &Ctx, it: &Item, key: String) -> El {
    let k = cx.k;
    let mut head = row().w_full().gap(8.0).center_y().child(text(it.title.clone()).font(k.ty.ui_medium).color(k.c.text_base).shrink());
    for b in &it.badges {
        head = head.child(badge(k, b));
    }
    head = head
        .child(el().grow(1.0))
        .children(it.actions.iter().enumerate().map(|(i, b)| button(cx, b, None, format!("{key}.a{i}"))));
    let mut c = col().key(key).w_full().padding(14.0).gap(6.0).radius(k.radius.lg).fill(k.c.layer_01).border(1.0, k.c.border_weak).child(head);
    if !it.subtitle.is_empty() {
        c = c.child(text(it.subtitle.clone()).font(k.ty.text_xsmall).color(k.c.text_faint).wrap());
    }
    if !it.text.is_empty() {
        c = c.child(text(it.text.clone()).font(k.ty.text_small).color(k.c.text_muted).wrap());
    }
    c
}

fn button(cx: &Ctx, b: &ButtonSpec, form: Option<&str>, key: String) -> El {
    let (id, action, form) = (cx.id, Action::from(&b.action), form.map(str::to_string));
    let mut btn = Button::new(b.label.clone()).variant(variant(b.tone)).control_size(ControlSize::Small);
    if let Some(i) = &b.icon {
        btn = btn.icon(icon_named(i));
    }
    btn.on_press(move |s: &mut Hooked| s.ext_act(id, action.clone(), form.clone(), false)).build(cx.k).key(key)
}

fn form(cx: &Ctx, f: &FormSpec, key: String) -> El {
    let k = cx.k;
    let mut c = col().key(key.clone()).w_full().padding(16.0).gap(12.0).radius(k.radius.lg).fill(k.c.surface_raised).border(1.0, k.c.info.border);
    for fld in &f.fields {
        c = c.child(field(cx, fld, format!("{key}.{}", fld.key)));
    }
    if let Some(b) = &f.submit {
        c = c.child(row().w_full().child(el().grow(1.0)).child(button(cx, b, Some(&f.id), format!("{key}.submit"))));
    }
    c
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

fn field(cx: &Ctx, f: &Field, key: String) -> El {
    let (k, id) = (cx.k, cx.id);
    let fkey = f.key.clone();
    let value = cx.view.values.get(&f.key);
    let input = match (f.kind, value) {
        (FieldKind::Bool, Some(FieldValue::Bool(on))) => Switch::new(*on)
            .label(f.label.clone())
            .on_toggle(move |s: &mut Hooked| {
                if let Some(FieldValue::Bool(b)) = s.ext.views.get_mut(id).and_then(|v| v.values.get_mut(&fkey)) {
                    *b = !*b;
                }
            })
            .build(k),
        (FieldKind::Select, Some(FieldValue::Choice(cur))) => {
            let labels: Vec<&str> = f.options.iter().map(|o| o.label.as_str()).collect();
            let values: Vec<String> = f.options.iter().map(|o| o.value.clone()).collect();
            SegmentedControl::new(&labels, values.iter().position(|v| v == cur))
                .label(f.label.clone())
                .fit()
                .on_pick(move |s: &mut Hooked, i, _| {
                    if let Some(FieldValue::Choice(c)) = s.ext.views.get_mut(id).and_then(|v| v.values.get_mut(&fkey)) {
                        *c = values[i].clone();
                    }
                })
                .build(k)
        }
        (FieldKind::Textarea, Some(FieldValue::Text(t))) => TextArea::new(t)
            .width(None)
            .auto_grow(3, 12)
            .on_edit(move |s: &mut Hooked| text_slot(s, id, &fkey))
            .build(k),
        (FieldKind::Text | FieldKind::Number, Some(FieldValue::Text(t))) => TextInput::new(t)
            .width(None)
            .on_edit(move |s: &mut Hooked| text_slot(s, id, &fkey))
            .build(k),
        _ => text("This field needs a newer hooked desktop app.").font(k.ty.text_xsmall).color(k.c.warning.fg),
    };
    let mut c = col().key(key).w_full().gap(6.0);
    if f.kind != FieldKind::Bool {
        c = c.child(section_title(k, &f.label.to_uppercase()));
    }
    c = c.child(input);
    let note = cx.view.field_errors.get(&f.key).map(|e| (vec![e.clone()], Tone::Error)).or_else(|| {
        let p = cx.view.previews.get(&f.key).filter(|p| !p.lines.is_empty())?;
        Some((p.lines.clone(), p.tone))
    });
    match note {
        Some((lines, tone)) => c.child(text(lines.join("\n")).font(k.ty.text_xsmall).color(tone_color(k, tone)).wrap()),
        None if !f.hint.is_empty() => c.child(text(f.hint.clone()).font(k.ty.text_xsmall).color(k.c.text_faint).wrap()),
        None => c,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        let path = format!("{}/tests/fixtures/extview/{name}.json", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
    }

    #[test]
    fn parses_every_node_type_of_the_cron_list() {
        let Node::Column { children, refresh } = parse_view(fixture("cron-list")).unwrap() else { panic!("root is a column") };
        assert_eq!(refresh, Some(10));
        let Node::Section { title, actions } = &children[0] else { panic!() };
        assert_eq!(title, "Cron");
        assert_eq!(Action::from(&actions[0].action), Action::View("edit".into()));
        let Node::List { items } = &children[1] else { panic!() };
        assert_eq!(items[0].badges[0], BadgeSpec { label: "0 9 * * 1-5".into(), tone: Tone::Muted, mono: true });
        let kinds: Vec<Action> = items[0].actions.iter().map(|b| Action::from(&b.action)).collect();
        assert_eq!(kinds[0], Action::Post { rest: "view".into(), body: json!({ "op": "run", "id": "abc" }), confirm: None });
        assert_eq!(kinds[2], Action::View("edit/abc".into()));
        assert!(matches!(kinds.last(), Some(Action::Post { confirm: Some(c), .. }) if c == "Delete \"Standup\"?"));
    }

    #[test]
    fn an_unknown_node_or_field_does_not_fail_the_view() {
        let tree = parse_view(json!({ "type": "column", "children": [
            { "type": "chart", "series": [] },
            { "type": "text", "value": "hi", "tone": "sparkly" },
            { "type": "form", "id": "f", "fields": [{ "type": "color", "key": "c", "label": "C" }] },
            { "type": "row", "children": [
                { "type": "badge", "label": "on", "tone": "ok" },
                { "type": "empty", "text": "Nothing yet" },
                { "type": "button", "label": "Docs", "action": { "open": { "url": "https://example.com" } } }
            ] }
        ] }))
        .unwrap();
        let Node::Column { children, .. } = tree else { panic!() };
        assert_eq!(children[0], Node::Unknown);
        assert!(matches!(children[1], Node::Text { tone: Tone::Other, .. }));
        let Node::Form(f) = &children[2] else { panic!() };
        assert_eq!(f.fields[0].kind, FieldKind::Unknown);
        let Node::Row { children: row } = &children[3] else { panic!() };
        assert_eq!(row[0], Node::Badge(BadgeSpec { label: "on".into(), tone: Tone::Ok, mono: false }));
        assert_eq!(row[1], Node::Empty { text: "Nothing yet".into() });
        let Node::Button(b) = &row[2] else { panic!() };
        assert_eq!(Action::from(&b.action), Action::OpenUrl("https://example.com".into()));
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
        let preview = form.fields[1].preview.clone();
        // A refresh keeps what the user typed.
        v.adopt(tree.clone());
        assert!(matches!(v.values.get("schedule"), Some(FieldValue::Text(t)) if t.text == "*/5 * * * *"));
        assert_eq!(preview.as_deref(), Some("preview"));
    }

    #[test]
    fn reads_what_a_post_answered() {
        assert_eq!(
            Outcome::from(&json!({ "errors": { "schedule": "invalid schedule: bad" } })),
            Outcome { errors: [("schedule".to_string(), "invalid schedule: bad".to_string())].into(), ..Default::default() }
        );
        assert_eq!(Outcome::from(&json!({ "flash": "Saved", "view": "" })), Outcome { flash: Some("Saved".into()), view: Some(String::new()), ..Default::default() });
        assert_eq!(Action::from(&ActionSpec { open: Some(OpenSpec { session: Some("s1".into()), url: None }), ..Default::default() }), Action::OpenSession("s1".into()));
        assert_eq!(Action::from(&ActionSpec::default()), Action::Invalid);
    }

    #[test]
    fn extension_list_entries_and_page_ids() {
        let list: Vec<ExtInfo> = serde_json::from_value(fixture("extensions")["extensions"].clone()).unwrap();
        assert_eq!(list[0].view_route(), Some("view"));
        assert_eq!(list[0].page_key(), Some("cron"));
        assert_eq!(list[0].order(), 80.0);
        assert_eq!(list[1].view_route(), None);
        assert_eq!(page_of("cron"), page_of(&String::from("cron")));
        assert_ne!(page_of("cron"), page_of("hello"));
    }
}
