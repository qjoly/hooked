use rune::{Color, Cursor, El, ScrollSpec, col, el, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, IconButton, Kit, SegmentedControl};
use serde_json::Value;

use super::{dot, glyph, pill, section_title};
use crate::app::Hooked;
use crate::ghdetail::{
    Fix, GhSlot, GhToggle, GhView, PatchLine, check_rank, detail_kind, patch_lines,
};
use crate::{fmt, icons};

const MAX_PATCH_LINES: usize = 2000;

fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}

fn badge(k: &Kit, label: &str, tone: &str) -> El {
    let (fg, bg) = match tone {
        "open" | "ok" => (k.c.success.fg, k.c.success.bg),
        "merged" => (k.c.info.fg, k.c.info.bg),
        "closed" | "ko" => (k.c.danger.fg, k.c.danger.bg),
        "wait" => (k.c.warning.fg, k.c.warning.bg),
        _ => (k.c.text_muted, k.c.layer_02),
    };
    pill(k, label.to_string(), fg, bg)
}

fn state_of(d: &Value) -> (&'static str, &'static str) {
    let issue = detail_kind(d) == "issue";
    match str_of(d, "state") {
        "CLOSED" if issue => ("Closed", "merged"),
        "OPEN" => ("Open", "open"),
        "DRAFT" => ("Draft", "muted"),
        "MERGED" => ("Merged", "merged"),
        "CLOSED" => ("Closed", "closed"),
        "NOT_PLANNED" => ("Not planned", "muted"),
        _ => ("Unknown", "muted"),
    }
}

fn check_label(status: &str) -> &'static str {
    match status {
        "passed" => "Passed",
        "failed" => "Failed",
        "cancelled" => "Cancelled",
        "pending" => "Running",
        "skipped" => "Skipped",
        _ => "Neutral",
    }
}

fn link_row(k: &Kit, key: String, url: String, body: El) -> El {
    k.interactive(
        body.key(key)
            .role("link")
            .cursor(Cursor::Pointer)
            .help(url.clone()),
    )
    .on_press_tx(move |s: &mut Hooked, tx| crate::app::open_link(s, &url, tx))
}

pub fn panel(s: &Hooked, k: &Kit, slot: GhSlot, extra: El) -> El {
    let Some(v) = s.gh_view(slot) else {
        return el();
    };
    let base = col().key("ghd").w_full().grow(1.0).min_h(0.0);
    let d = match s.gh_details.get(&v.url) {
        Some(Ok(d)) => d,
        other => {
            let (msg, c) = match other {
                Some(Err(e)) => (e.as_str(), k.c.danger.fg),
                _ => ("Loading…", k.c.text_faint),
            };
            return base
                .child(
                    row()
                        .w_full()
                        .px(8.0)
                        .pt(8.0)
                        .child(el().grow(1.0))
                        .child(extra),
                )
                .child(empty(k, msg, c));
        }
    };
    let is_pr = detail_kind(d) == "pr";
    let body = match v.tab {
        1 => timeline(s, k, d),
        2 if is_pr => code(s, k, v, d, slot),
        _ => summary(s, k, v, d, slot),
    };
    base.child(header(s, k, v, d, slot, extra)).child(
        col()
            .key(format!("ghd-body-{}", v.tab))
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .child(col().w_full().padding(14.0).gap(14.0).child(body)),
    )
}

fn empty(k: &Kit, msg: &str, c: Color) -> El {
    row()
        .w_full()
        .py(40.0)
        .padding(14.0)
        .child(text(msg.to_string()).font(k.ty.body).color(c).wrap())
}

fn header(s: &Hooked, k: &Kit, v: &GhView, d: &Value, slot: GhSlot, extra: El) -> El {
    let is_pr = detail_kind(d) == "pr";
    let url = str_of(d, "url").to_string();
    let (st, tone) = state_of(d);
    let title = link_row(
        k,
        "ghd-title".into(),
        url.clone(),
        row()
            .grow(1.0)
            .min_w(0.0)
            .gap(6.0)
            .child(
                text(format!(
                    "#{} {}",
                    d["number"].as_i64().unwrap_or(0),
                    str_of(d, "title")
                ))
                .font(k.ty.text_small_medium)
                .color(k.c.text_base)
                .wrap()
                .grow(1.0)
                .min_w(0.0),
            )
            .child(glyph(&icons::LINK, 12.0, k.c.icon_faint)),
    );
    let mut meta = row()
        .w_full()
        .gap(8.0)
        .center_y()
        .flex_wrap()
        .child(
            text(str_of(d, "author").to_string())
                .font(k.ty.text_xsmall_medium)
                .color(k.c.text_muted),
        )
        .child(
            text(fmt::ago_short(d["createdAt"].as_str(), s.now))
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        );
    if is_pr {
        meta = meta
            .child(
                text(format!("{} ← {}", str_of(d, "base"), str_of(d, "head")))
                    .font(k.ty.mono)
                    .color(k.c.text_muted)
                    .truncate()
                    .min_w(0.0),
            )
            .child(glyph(&icons::DIFF, 12.0, k.c.icon_faint))
            .child(
                text(d["changedFiles"].as_i64().unwrap_or(0).to_string())
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_muted),
            )
            .child(
                text(format!("+{}", d["additions"].as_i64().unwrap_or(0)))
                    .font(k.ty.text_xsmall_medium)
                    .color(k.c.success.fg),
            )
            .child(
                text(format!("−{}", d["deletions"].as_i64().unwrap_or(0)))
                    .font(k.ty.text_xsmall_medium)
                    .color(k.c.danger.fg),
            );
    } else {
        let repo = url
            .trim_start_matches("https://github.com/")
            .split("/issues/")
            .next()
            .unwrap_or("")
            .to_string();
        meta = meta.child(text(repo).font(k.ty.text_xsmall).color(k.c.text_faint));
    }
    let labels: Vec<&str> = if is_pr {
        vec!["Summary", "Timeline", "Code"]
    } else {
        vec!["Summary", "Timeline"]
    };
    let mut tabs = row().w_full().gap(8.0).center_y().flex_wrap().child(
        SegmentedControl::new(&labels, Some(v.tab.min(labels.len() - 1)))
            .label("Section")
            .fit()
            .on_pick(move |s: &mut Hooked, i, _| s.gh_tab(slot, i))
            .build(k)
            .key("ghd-tabs"),
    );
    match str_of(d, "decision") {
        "APPROVED" => tabs = tabs.child(badge(k, "Approved", "ok")),
        "CHANGES_REQUESTED" => tabs = tabs.child(badge(k, "Changes requested", "ko")),
        "REVIEW_REQUIRED" => tabs = tabs.child(badge(k, "Review required", "wait")),
        _ => {}
    }
    let checks = d["checks"].as_array().cloned().unwrap_or_default();
    if !checks.is_empty() {
        let n = checks.len();
        let failing = checks
            .iter()
            .filter(|c| matches!(str_of(c, "status"), "failed" | "cancelled"))
            .count();
        let running = checks
            .iter()
            .filter(|c| str_of(c, "status") == "pending")
            .count();
        let (label, c) = if failing > 0 {
            (format!("{failing} of {n} failing"), k.c.danger.fg)
        } else if running > 0 {
            (format!("{running} of {n} running"), k.c.warning.fg)
        } else {
            ("All checks passed".to_string(), k.c.success.fg)
        };
        tabs = tabs.child(text(label).font(k.ty.text_xsmall_medium).color(c));
    }
    tabs = tabs
        .child(el().grow(1.0))
        .child(
            IconButton::new(&icons::RESTART)
                .label("Refresh")
                .control_size(ControlSize::Small)
                .disabled(s.gh_loading.contains(&v.url))
                .on_press(move |s: &mut Hooked| s.gh_refresh(slot))
                .build(k),
        )
        .child(extra);
    col()
        .key("ghd-head")
        .w_full()
        .px(14.0)
        .pt(12.0)
        .pb(10.0)
        .gap(8.0)
        .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_weak)
        .child(
            row()
                .w_full()
                .gap(8.0)
                .child(title)
                .child(badge(k, st, tone)),
        )
        .child(meta)
        .child(tabs)
}

fn section(k: &Kit, title: String, body: El) -> El {
    col()
        .w_full()
        .gap(8.0)
        .child(section_title(k, &title))
        .child(body)
}

fn summary(s: &Hooked, k: &Kit, v: &GhView, d: &Value, slot: GhSlot) -> El {
    let mut c = col().w_full().gap(18.0);
    if detail_kind(d) == "issue" {
        let labels = d["labels"].as_array().cloned().unwrap_or_default();
        let assignees: Vec<&str> = d["assignees"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
            .unwrap_or_default();
        if !labels.is_empty() || !assignees.is_empty() {
            let mut chips = row().w_full().gap(6.0).flex_wrap().center_y();
            for l in &labels {
                let col =
                    rune::color::hex(&format!("#{}", str_of(l, "color"))).unwrap_or(k.c.text_muted);
                chips = chips.child(pill(
                    k,
                    str_of(l, "name").to_string(),
                    k.c.text_base,
                    col.alpha(0.3),
                ));
            }
            if !assignees.is_empty() {
                chips = chips.child(
                    text(format!("→ {}", assignees.join(", ")))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                );
            }
            c = c.child(chips);
        }
    }
    let body = str_of(d, "body");
    c = c.child(section(
        k,
        "DESCRIPTION".into(),
        if body.trim().is_empty() {
            text("No description.")
                .font(k.ty.text_small)
                .color(k.c.text_faint)
        } else {
            super::md(body.to_string()).selectable(true).build(k)
        },
    ));
    let mut checks = d["checks"].as_array().cloned().unwrap_or_default();
    if !checks.is_empty() {
        checks.sort_by_key(|c| check_rank(str_of(c, "status")));
        let mut list = col().w_full().gap(2.0);
        for (i, ch) in checks.iter().enumerate() {
            let status = str_of(ch, "status");
            let name = str_of(ch, "name").to_string();
            let curl = str_of(ch, "url").to_string();
            let line = row()
                .w_full()
                .h(26.0)
                .px(6.0)
                .gap(8.0)
                .center_y()
                .radius(k.radius.sm)
                .fill(if status == "failed" {
                    k.c.danger.bg.alpha(0.5)
                } else {
                    Color::TRANSPARENT
                })
                .child(dot(k, super::ghrun::state_of(status), 7.0))
                .child(
                    text(name.clone())
                        .font(k.ty.text_small)
                        .color(k.c.text_base)
                        .truncate()
                        .grow(1.0)
                        .min_w(0.0),
                )
                .child(
                    text(check_label(status))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                );
            let mut r = row()
                .w_full()
                .gap(6.0)
                .center_y()
                .child(if curl.is_empty() {
                    line.grow(1.0).min_w(0.0)
                } else {
                    link_row(
                        k,
                        format!("ghd-check-{i}"),
                        curl.clone(),
                        line.grow(1.0).min_w(0.0),
                    )
                });
            if v.session.is_some() && status == "failed" {
                let state = v.fixed.get(&name).copied();
                let label = match state {
                    Some(Fix::Sent) => "Sent",
                    Some(Fix::Failed) => "Retry",
                    Some(Fix::Sending) => "Sending…",
                    None => "Fix in this thread",
                };
                r = r.child(
                    Button::new(label)
                        .icon(&icons::TOOL)
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Small)
                        .disabled(matches!(state, Some(Fix::Sent | Fix::Sending)))
                        .on_press(move |s: &mut Hooked| {
                            s.fix_check(slot, name.clone(), curl.clone())
                        })
                        .build(k),
                );
            }
            list = list.child(r);
        }
        c = c.child(section(k, "CHECKS".into(), list));
    }
    let comments = d["comments"].as_array().cloned().unwrap_or_default();
    let mut list = col().w_full().gap(6.0);
    if comments.is_empty() {
        list = list.child(
            text("No comments.")
                .font(k.ty.text_small)
                .color(k.c.text_faint),
        );
    }
    let (bots, people): (Vec<&Value>, Vec<&Value>) = comments
        .iter()
        .rev()
        .partition(|c| c["bot"].as_bool() == Some(true));
    for c in people {
        list = list.child(comment(s, k, v, c, slot));
    }
    if !bots.is_empty() {
        let head = k
            .interactive(
                row()
                    .key("ghd-bots")
                    .role("button")
                    .w_full()
                    .h(30.0)
                    .px(8.0)
                    .gap(8.0)
                    .center_y()
                    .radius(k.radius.sm)
                    .cursor(Cursor::Pointer)
                    .border(1.0, k.c.border_weak)
                    .child(glyph(
                        if v.bots {
                            &icons::CHEVRON_DOWN
                        } else {
                            &icons::ARROW_RIGHT
                        },
                        12.0,
                        k.c.icon_faint,
                    ))
                    .child(glyph(&icons::BOT, 13.0, k.c.icon_muted))
                    .child(
                        text(format!(
                            "{} bot comment{}",
                            bots.len(),
                            if bots.len() > 1 { "s" } else { "" }
                        ))
                        .font(k.ty.text_small_medium)
                        .color(k.c.text_base),
                    )
                    .child(
                        text(format!(
                            "latest {}",
                            fmt::ago_short(bots[0]["at"].as_str(), s.now)
                        ))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                    ),
            )
            .on_press(move |s: &mut Hooked| s.gh_toggle(slot, GhToggle::Bots, String::new()));
        list = list.child(head);
        if v.bots {
            let mut inner = col().w_full().gap(6.0).pl(16.0);
            for c in bots {
                inner = inner.child(comment(s, k, v, c, slot));
            }
            list = list.child(inner);
        }
    }
    c.child(section(k, format!("COMMENTS ({})", comments.len()), list))
}

fn comment(s: &Hooked, k: &Kit, v: &GhView, c: &Value, slot: GhSlot) -> El {
    let key = format!("{}|{}", str_of(c, "at"), str_of(c, "author"));
    let open = v.comments.contains(&key);
    let body = str_of(c, "body");
    let excerpt: String = body
        .chars()
        .filter(|ch| !"#*`>_[]".contains(*ch))
        .map(|ch| if ch.is_whitespace() { ' ' } else { ch })
        .take(120)
        .collect();
    let toggle = key.clone();
    let head = k
        .interactive(
            row()
                .key(format!("ghd-c-{key}"))
                .role("button")
                .w_full()
                .min_h(30.0)
                .px(8.0)
                .gap(8.0)
                .center_y()
                .cursor(Cursor::Pointer)
                .child(glyph(
                    if open {
                        &icons::CHEVRON_DOWN
                    } else {
                        &icons::ARROW_RIGHT
                    },
                    12.0,
                    k.c.icon_faint,
                ))
                .child(
                    text(str_of(c, "author").to_string())
                        .font(k.ty.text_small_medium)
                        .color(k.c.text_base),
                )
                .child(
                    text(fmt::ago_short(c["at"].as_str(), s.now))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                )
                .child(
                    text(if open { String::new() } else { excerpt })
                        .font(k.ty.text_small)
                        .color(k.c.text_muted)
                        .truncate()
                        .grow(1.0)
                        .min_w(0.0),
                ),
        )
        .on_press(move |s: &mut Hooked| s.gh_toggle(slot, GhToggle::Comment, toggle.clone()));
    let mut card = col()
        .w_full()
        .radius(k.radius.sm)
        .border(1.0, k.c.border_weak)
        .child(head);
    if open {
        card = card.child(
            col()
                .w_full()
                .px(12.0)
                .pb(10.0)
                .child(super::md(body.to_string()).selectable(true).build(k)),
        );
    }
    card
}

fn timeline(s: &Hooked, k: &Kit, d: &Value) -> El {
    let events = d["timeline"].as_array().cloned().unwrap_or_default();
    if events.is_empty() {
        return text("Nothing yet.")
            .font(k.ty.text_small)
            .color(k.c.text_faint);
    }
    let mut c = col().w_full().gap(14.0);
    for (i, e) in events.iter().enumerate() {
        let kind = str_of(e, "kind");
        let (icon, tint, verb) = match kind {
            "commit" => (&icons::GIT_BRANCH, k.c.icon_faint, "committed".to_string()),
            "review" => {
                let (verb, tint) = match str_of(e, "state") {
                    "APPROVED" => ("approved", k.c.success.icon),
                    "CHANGES_REQUESTED" => ("requested changes", k.c.danger.icon),
                    "DISMISSED" => ("dismissed", k.c.icon_faint),
                    "COMMENTED" => ("reviewed", k.c.icon_faint),
                    other => (other, k.c.icon_faint),
                };
                (&icons::EYE, tint, verb.to_lowercase())
            }
            _ => (&icons::CONVERSE, k.c.icon_faint, "commented".to_string()),
        };
        let mut head = row()
            .w_full()
            .gap(6.0)
            .center_y()
            .child(
                text(str_of(e, "author").to_string())
                    .font(k.ty.text_small_medium)
                    .color(k.c.text_base),
            )
            .child(text(verb).font(k.ty.text_small).color(k.c.text_faint));
        if kind == "commit" {
            head = head.child(
                row().px(5.0).radius(k.radius.sm).fill(k.c.layer_02).child(
                    text(str_of(e, "sha").to_string())
                        .font(k.ty.mono)
                        .color(k.c.text_muted),
                ),
            );
        }
        head = head.child(el().grow(1.0)).child(
            text(fmt::ago_short(e["at"].as_str(), s.now))
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        );
        let mut ev = col().grow(1.0).min_w(0.0).gap(4.0).child(head);
        let t = str_of(e, "text");
        if kind == "commit" {
            ev = ev.child(
                text(t.to_string())
                    .font(k.ty.text_small)
                    .color(k.c.text_muted)
                    .wrap(),
            );
        } else if !t.trim().is_empty() {
            ev = ev.child(super::md(t.to_string()).selectable(true).build(k));
        }
        c = c.child(
            row()
                .key(format!("ghd-ev-{i}"))
                .w_full()
                .gap(10.0)
                .child(
                    row()
                        .size(24.0, 24.0)
                        .center()
                        .radius(12.0)
                        .fill(k.c.layer_02)
                        .child(glyph(icon, 13.0, tint)),
                )
                .child(ev),
        );
    }
    c
}

fn code(s: &Hooked, k: &Kit, v: &GhView, d: &Value, slot: GhSlot) -> El {
    let files = d["files"].as_array().cloned().unwrap_or_default();
    let patches = s.gh_diffs.get(&v.url);
    let mut c = col().w_full().gap(4.0);
    for f in &files {
        let path = str_of(f, "path").to_string();
        let open = v.files.contains(&path);
        let change = match str_of(f, "change") {
            "ADDED" => "A",
            "DELETED" => "D",
            "RENAMED" => "R",
            "MODIFIED" => "M",
            _ => "·",
        };
        let toggle = path.clone();
        c = c.child(
            k.interactive(
                row()
                    .key(format!("ghd-f-{path}"))
                    .role("button")
                    .w_full()
                    .h(28.0)
                    .px(8.0)
                    .gap(8.0)
                    .center_y()
                    .radius(k.radius.sm)
                    .cursor(Cursor::Pointer)
                    .fill(if open {
                        k.c.layer_02
                    } else {
                        Color::TRANSPARENT
                    })
                    .child(glyph(
                        if open {
                            &icons::CHEVRON_DOWN
                        } else {
                            &icons::ARROW_RIGHT
                        },
                        12.0,
                        k.c.icon_faint,
                    ))
                    .child(text(change).font(k.ty.mono).color(k.c.text_faint).w(10.0))
                    .child(
                        text(path.clone())
                            .font(k.ty.text_small)
                            .color(k.c.text_base)
                            .truncate()
                            .grow(1.0)
                            .min_w(0.0),
                    )
                    .child(
                        text(format!("+{}", f["additions"].as_i64().unwrap_or(0)))
                            .font(k.ty.text_xsmall_medium)
                            .color(k.c.success.fg),
                    )
                    .child(
                        text(format!("−{}", f["deletions"].as_i64().unwrap_or(0)))
                            .font(k.ty.text_xsmall_medium)
                            .color(k.c.danger.fg),
                    ),
            )
            .on_press(move |s: &mut Hooked| s.gh_toggle(slot, GhToggle::File, toggle.clone())),
        );
        if open {
            c = c.child(match patches {
                None => note(k, "Loading the diff…", k.c.text_faint),
                Some(Err(e)) => note(k, e, k.c.danger.fg),
                Some(Ok(p)) => match p[path.as_str()].as_str() {
                    Some(patch) => patch_view(k, &path, patch),
                    None => note(k, "No textual diff (binary or too large).", k.c.text_faint),
                },
            });
        }
    }
    c
}

fn note(k: &Kit, msg: &str, c: Color) -> El {
    row()
        .w_full()
        .px(28.0)
        .py(6.0)
        .child(text(msg.to_string()).font(k.ty.text_small).color(c).wrap())
}

fn patch_view(k: &Kit, path: &str, patch: &str) -> El {
    let lines = patch_lines(patch);
    let total = lines.len();
    let mut c = col()
        .key(format!("ghd-p-{path}"))
        .w_full()
        .py(4.0)
        .radius(k.radius.sm)
        .clip_rounded(k.radius.sm)
        .border(1.0, k.c.border_weak)
        .fill(k.c.bg_deep);
    for l in lines.into_iter().take(MAX_PATCH_LINES) {
        let (sign, body, fill, ink) = match l {
            PatchLine::Meta(t) => (" ", t, Color::TRANSPARENT, k.c.text_faint),
            PatchLine::Hunk(t) => (" ", t, k.c.info.bg.alpha(0.5), k.c.info.fg),
            PatchLine::Add(t) => ("+", t, k.c.success.bg, k.c.text_base),
            PatchLine::Del(t) => ("-", t, k.c.danger.bg, k.c.text_base),
            PatchLine::Ctx(t) => (" ", t, Color::TRANSPARENT, k.c.text_muted),
        };
        c = c.child(
            row()
                .w_full()
                .px(8.0)
                .gap(6.0)
                .fill(fill)
                .child(text(sign).font(k.ty.mono).color(ink).w(10.0))
                .child(
                    text(if body.is_empty() {
                        " ".to_string()
                    } else {
                        body.to_string()
                    })
                    .font(k.ty.mono)
                    .color(ink)
                    .wrap_anywhere()
                    .grow(1.0)
                    .min_w(0.0),
                ),
        );
    }
    if total > MAX_PATCH_LINES {
        c = c.child(note(
            k,
            &format!(
                "{} more lines: open the pull request on GitHub.",
                total - MAX_PATCH_LINES
            ),
            k.c.text_faint,
        ));
    }
    c
}
