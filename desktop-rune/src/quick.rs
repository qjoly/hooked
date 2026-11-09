use rune::{
    Align, AppHandle, AppSpec, Color, Cursor, Cx, DisplayTarget, El, Key, OverlayPlacement,
    ScreenEdge, ScrollSpec, TextEdit, Tx, col, el, row, text,
};
use rune_kit::{Markdown, TextArea};

use crate::api::{self, Part, Session};
use crate::app::HANDLE;

pub static QUICK: std::sync::OnceLock<AppHandle<Quick>> = std::sync::OnceLock::new();
use crate::{fmt, view};

pub struct Quick {
    pub me: Option<AppHandle<Quick>>,
    items: Vec<Session>,
    at: usize,
    msgs: Vec<(bool, String)>,
    loading: bool,
    token: u64,
    reply: TextEdit,
    note: String,
}

impl Quick {
    pub fn new(me: AppHandle<Quick>) -> Quick {
        let mut reply = TextEdit::new("");
        reply.focused = true;
        let mut q = Quick {
            me: Some(me),
            items: Vec::new(),
            at: 0,
            msgs: Vec::new(),
            loading: false,
            token: 0,
            reply,
            note: String::new(),
        };
        if std::env::args().any(|a| a == "quick") {
            q.items = api::sessions()
                .unwrap_or_default()
                .into_iter()
                .filter(|s| s.needs_you())
                .take(12)
                .collect();
            if let Some(d) = q.items.first().and_then(|x| api::detail(&x.id).ok()) {
                q.msgs = d
                    .messages
                    .iter()
                    .rev()
                    .take(6)
                    .rev()
                    .map(|m| (m.role == "user", m.text.clone()))
                    .collect();
            }
        }
        q
    }

    fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
        done: impl FnOnce(&mut Quick, T) + Send + 'static,
    ) {
        let Some(me) = self.me.clone() else { return };
        std::thread::spawn(move || {
            let r = work();
            me.update(move |s, _| done(s, r));
        });
    }

    pub fn refresh(&mut self) {
        self.note.clear();
        self.reply.focused = true;
        self.run(
            || {
                let meta = api::session_meta().unwrap_or_default();
                let now = fmt::now_ms();
                api::sessions()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|s| s.needs_you())
                    .filter(|s| {
                        !meta.get(&s.id).is_some_and(|m| m.archived)
                            && !fmt::finished_and_cold(
                                &s.state,
                                s.last_seen_ts.as_deref().or(s.last_activity.as_deref()),
                                now,
                            )
                    })
                    .take(12)
                    .collect::<Vec<_>>()
            },
            |s, items| {
                s.items = items;
                s.at = 0;
                s.pick();
            },
        );
    }

    fn pick(&mut self) {
        self.token += 1;
        self.msgs.clear();
        let Some(id) = self.items.get(self.at).map(|x| x.id.clone()) else {
            return;
        };
        let token = self.token;
        self.loading = true;
        self.run(
            move || api::detail(&id),
            move |s, r| {
                if s.token != token {
                    return;
                }
                s.loading = false;
                let Ok(d) = r else { return };
                let mut msgs: Vec<(bool, String)> = Vec::new();
                for m in d.messages.iter().rev().take(10).rev() {
                    let text: Vec<String> = m
                        .render_parts()
                        .into_iter()
                        .map(|p| match p {
                            Part::Text(t) => t,
                            Part::Tool(t) => {
                                format!("`{}` {}", t.name, t.detail.unwrap_or_default())
                            }
                        })
                        .collect();
                    if !text.is_empty() && m.role != "system" {
                        msgs.push((m.role == "user", text.join("\n\n")));
                    }
                }
                if let Some(q) = d
                    .pending_question
                    .as_ref()
                    .and_then(|q| q.questions.first())
                {
                    let opts: Vec<String> = q
                        .options
                        .iter()
                        .enumerate()
                        .map(|(i, o)| format!("{}. {}", i + 1, o.label))
                        .collect();
                    msgs.push((false, format!("**{}**\n\n{}", q.question, opts.join("\n"))));
                }
                s.msgs = msgs;
            },
        );
    }

    fn send(&mut self) {
        let body = self.reply.text.trim().to_string();
        let Some(x) = self.items.get(self.at).cloned() else {
            return;
        };
        if body.is_empty() {
            return;
        }
        self.note = "sending…".into();
        self.run(
            move || {
                if x.live {
                    api::reply(&x.id, &body)
                } else {
                    api::resume(&x.id, &body, x.effort.as_deref())
                }
            },
            |s, r| match r {
                Ok(()) => {
                    s.reply = TextEdit::new("");
                    s.note.clear();
                    if let Some(me) = s.me.as_ref() {
                        me.close();
                    }
                }
                Err(e) => s.note = e,
            },
        );
    }

    fn open_in_app(&mut self, tx: &mut Tx) {
        let Some(id) = self.items.get(self.at).map(|x| x.id.clone()) else {
            return;
        };
        if let Some(h) = HANDLE.get() {
            h.open();
            h.update(move |s, _| s.open_session(&id));
        }
        tx.close_window();
    }
}

fn on_key(s: &mut Quick, ev: &rune::KeyEvent, tx: &mut Tx) -> bool {
    match ev.key {
        Key::Escape => tx.close_window(),
        Key::Down if !s.items.is_empty() => {
            s.at = (s.at + 1) % s.items.len();
            s.pick();
        }
        Key::Up if !s.items.is_empty() => {
            s.at = (s.at + s.items.len() - 1) % s.items.len();
            s.pick();
        }
        _ if ev.is_command('o') => s.open_in_app(tx),
        _ => return false,
    }
    true
}

pub fn show(s: &mut Quick) {
    if let Some(me) = s.me.as_ref() {
        me.place(
            DisplayTarget::Primary,
            OverlayPlacement::Edge {
                edge: ScreenEdge::Top,
                margin: 140.0,
                align: Align::Center,
                inset: 0.0,
            },
        );
        me.show();
        me.focus();
    }
    s.refresh();
}

fn view(s: &Quick, cx: &mut Cx<Quick>) -> El {
    let k = crate::theme::kit(cx.system_dark());
    let list = col()
        .key("q-list")
        .w(250.0)
        .h_full()
        .padding(8.0)
        .gap(2.0)
        .border_sides([0.0, 1.0, 0.0, 0.0], k.c.border_weak)
        .children(s.items.iter().enumerate().map(|(i, x)| {
            let on = i == s.at;
            let reason = match x.question.as_ref().and_then(|q| q.as_str()) {
                Some(q) => q.to_string(),
                None if x.has_plan => "plan to review".into(),
                None if x.state == "attention" => "action required".into(),
                None => "finished its turn".into(),
            };
            k.interactive(
                col()
                    .key(format!("q-{}", x.id))
                    .role("option")
                    .checked(on)
                    .w_full()
                    .px(10.0)
                    .py(7.0)
                    .gap(2.0)
                    .radius(k.radius.md)
                    .cursor(Cursor::Pointer)
                    .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
                    .child(
                        row()
                            .w_full()
                            .gap(6.0)
                            .center_y()
                            .child(view::dot(&k, &x.state, 6.0))
                            .child(
                                text(x.display_title())
                                    .font(k.ty.ui_medium)
                                    .color(k.c.text_base)
                                    .truncate()
                                    .grow(1.0)
                                    .shrink(),
                            ),
                    )
                    .child(
                        text(format!(
                            "{} — {reason}",
                            x.project_name.clone().unwrap_or_default()
                        ))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint)
                        .truncate(),
                    ),
            )
            .on_press(move |s: &mut Quick| {
                s.at = i;
                s.pick();
                s.reply.focused = true;
            })
        }));
    let mut chat = col().key("q-chat").w_full().padding(14.0).gap(10.0);
    if s.items.is_empty() {
        chat = chat.child(
            text("Nothing is waiting on you.")
                .font(k.ty.body)
                .color(k.c.text_faint),
        );
    } else if s.loading {
        chat = chat.child(
            text("Loading the conversation…")
                .font(k.ty.ui)
                .color(k.c.text_faint),
        );
    }
    for (i, (user, body)) in s.msgs.iter().enumerate() {
        let who = text(if *user { "You" } else { "Claude" })
            .font(k.ty.text_xsmall_medium)
            .color(k.c.text_faint);
        let mut b = col()
            .key(format!("qm-{i}"))
            .w_full()
            .gap(4.0)
            .child(who)
            .child(Markdown::new(body.clone()).on_link_tx(|_: &mut Quick, url: &str, tx: &mut rune::Tx| {
            if url.starts_with("/session/") {
                if let Some(h) = HANDLE.get() {
                    let id = url.trim_start_matches("/session/").to_string();
                    h.open();
                    h.update(move |s, tx| crate::app::open_link(s, &format!("/session/{id}"), tx));
                }
            } else {
                let _ = tx.open_url(url);
            }
        }).build(&k));
        if *user {
            b = b.padding(10.0).radius(k.radius.md).fill(k.c.layer_01);
        }
        chat = chat.child(b);
    }
    let input = TextArea::new(&s.reply)
        .placeholder("Reply… (Enter sends, ↑↓ switches, ⌘O opens in hooked, Esc closes)")
        .width(None)
        .auto_grow(1, 6)
        .on_edit(|s: &mut Quick| &mut s.reply)
        .on_key(|s: &mut Quick, ev: &rune::KeyEvent, tx| match ev.key {
            Key::Enter if !ev.mods.shift => {
                s.send();
                true
            }
            Key::Up | Key::Down if s.reply.text.is_empty() => on_key(s, ev, tx),
            Key::Escape => on_key(s, ev, tx),
            _ if ev.is_command('o') => on_key(s, ev, tx),
            _ => false,
        })
        .build(&k)
        .key("q-reply");
    let right = col()
        .key("q-right")
        .grow(1.0)
        .shrink()
        .h_full()
        .child(
            col()
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec { stick_bottom: true })
                .child(chat),
        )
        .child(
            col()
                .w_full()
                .padding(10.0)
                .gap(4.0)
                .border_sides([1.0, 0.0, 0.0, 0.0], k.c.border_weak)
                .child(input)
                .child(
                    text(s.note.clone())
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                ),
        );
    row()
        .key("quick")
        .w_full()
        .h_full()
        .radius(14.0)
        .fill(k.c.bg_base)
        .border(1.0, k.c.border_base)
        .child(list)
        .child(right)
        .child(el())
}

pub fn app() -> rune::App<Quick> {
    let spec = AppSpec {
        on_key: Some(on_key),
        ..AppSpec::new(
            "hooked quick reply",
            (760.0, 500.0),
            || unreachable!(),
            view,
        )
    };
    let quick = rune::App::new(spec).windowless();
    let me = quick.handle();
    let _ = QUICK.set(me.clone());
    quick
        .init(move || Quick::new(me))
        .global_shortcut(
            &std::env::var("HOOKED_QUICK_SHORTCUT").unwrap_or_else(|_| "Cmd+Shift+H".into()),
            |s, _| show(s),
        )
        .on_focus(|s, focused, tx| {
            if !focused {
                tx.close_window();
            } else if s.items.is_empty() {
                s.refresh();
            }
        })
}
