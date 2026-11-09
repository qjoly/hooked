use rune::{Color, Cursor, El, ScrollSpec, col, el, row, text};
use rune_kit::{
    Button, ButtonVariant, ControlSize, Kit, SegmentedControl, Spinner, Switch, TextArea, TextInput,
};
use serde_json::Value;

use super::{dot, glyph, pill, section_title};
use crate::app::Hooked;
use crate::pages::{GITHUB_TABS, STATS_RANGES};
use crate::{fmt, icons};

pub(super) fn page(k: &Kit, key: &str, title: &str, actions: El, body: El) -> El {
    col()
        .key(key.to_string())
        .w_full()
        .h_full()
        .child(
            row()
                .key(format!("{key}-bar"))
                .w_full()
                .h(48.0)
                .px(24.0)
                .gap(12.0)
                .center_y()
                .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_weak)
                .child(
                    text(title.to_string())
                        .font(k.ty.body_medium)
                        .color(k.c.text_base),
                )
                .child(el().grow(1.0))
                .child(actions),
        )
        .child(
            col()
                .key(format!("{key}-body"))
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .child(body),
        )
}

pub(super) fn scroll(key: &str, inner: El) -> El {
    col()
        .key(key.to_string())
        .w_full()
        .h_full()
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(inner)
}

pub(super) fn loading(k: &Kit) -> El {
    col()
        .w_full()
        .h_full()
        .center()
        .child(Spinner::new().build(k))
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

fn tokens(n: f64) -> String {
    if n >= 1e9 {
        format!("{:.1}B", n / 1e9)
    } else if n >= 1e6 {
        format!("{:.1}M", n / 1e6)
    } else if n >= 1e3 {
        format!("{:.1}k", n / 1e3)
    } else {
        format!("{n:.0}")
    }
}

fn tile(k: &Kit, label: &str, value: String) -> El {
    col()
        .w(170.0)
        .padding(14.0)
        .gap(4.0)
        .radius(k.radius.lg)
        .fill(k.c.layer_01)
        .border(1.0, k.c.border_weak)
        .child(section_title(k, label))
        .child(text(value).font(k.ty.body_medium).color(k.c.text_base))
}

fn hbar(k: &Kit, label: String, frac: f32, value: String, color: Color) -> El {
    row()
        .w_full()
        .h(24.0)
        .gap(10.0)
        .center_y()
        .child(
            text(label)
                .font(k.ty.text_small)
                .color(k.c.text_muted)
                .w(220.0)
                .truncate(),
        )
        .child(
            row().grow(1.0).h(8.0).radius(3.0).fill(k.c.layer_02).child(
                el().w_frac(frac.clamp(0.0, 1.0))
                    .h(8.0)
                    .radius(3.0)
                    .fill(color),
            ),
        )
        .child(
            text(value)
                .font(k.ty.text_small)
                .color(k.c.text_faint)
                .w(80.0),
        )
}

fn card(k: &Kit, key: &str, title: &str) -> El {
    col()
        .key(key.to_string())
        .w_full()
        .padding(16.0)
        .gap(8.0)
        .radius(k.radius.lg)
        .fill(k.c.layer_01)
        .border(1.0, k.c.border_weak)
        .child(section_title(k, title))
}

fn sorted_by(obj: &Value, field: &str) -> Vec<(String, Value)> {
    let mut v: Vec<(String, Value)> = obj
        .as_object()
        .map(|m| m.iter().map(|(a, b)| (a.clone(), b.clone())).collect())
        .unwrap_or_default();
    v.sort_by(|a, b| {
        num(&b.1[field])
            .partial_cmp(&num(&a.1[field]))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    v
}

fn usage_bar(k: &Kit, label: &str, pct: Option<f64>, sub: String) -> El {
    let p = pct.unwrap_or(0.0).clamp(0.0, 100.0) as f32;
    let fill = if p >= 90.0 {
        k.c.danger.icon
    } else if p >= 75.0 {
        k.c.warning.icon
    } else {
        k.c.icon_accent
    };
    col()
        .w_full()
        .gap(4.0)
        .child(
            row()
                .w_full()
                .child(
                    text(label.to_string())
                        .font(k.ty.text_small)
                        .color(k.c.text_muted),
                )
                .child(el().grow(1.0))
                .child(
                    text(pct.map_or("—".into(), |p| format!("{p:.0}%")))
                        .font(k.ty.text_small_medium)
                        .color(k.c.text_base),
                ),
        )
        .child(
            el().w_full()
                .h(6.0)
                .radius(3.0)
                .fill(k.c.layer_02)
                .child(el().w_frac(p / 100.0).h(6.0).radius(3.0).fill(fill)),
        )
        .child(text(sub).font(k.ty.text_xsmall).color(k.c.text_faint))
}

fn resets(v: &Value) -> String {
    v["resetInMin"]
        .as_f64()
        .map(|m| format!("resets in {}", fmt::span((m * 60_000.0) as i64, " ")))
        .unwrap_or_else(|| "—".into())
}

fn usage_cards(s: &Hooked, k: &Kit) -> El {
    let Some(u) = s.usage.as_ref() else {
        return el();
    };
    let card = |title: &str| {
        col()
            .grow(1.0)
            .min_w(280.0)
            .padding(16.0)
            .gap(12.0)
            .radius(k.radius.lg)
            .fill(k.c.layer_01)
            .border(1.0, k.c.border_weak)
            .child(
                text(title.to_string())
                    .font(k.ty.ui_medium)
                    .color(k.c.text_base),
            )
    };
    let a = &u["account"];
    let mut limits = card("Account limits")
        .child(usage_bar(
            k,
            "5-hour",
            a["fiveHour"]["pct"].as_f64(),
            resets(&a["fiveHour"]),
        ))
        .child(usage_bar(
            k,
            "7-day",
            a["sevenDay"]["pct"].as_f64(),
            resets(&a["sevenDay"]),
        ));
    if a["fable"].is_object() {
        limits = limits.child(usage_bar(
            k,
            a["fable"]["label"].as_str().unwrap_or("Fable"),
            a["fable"]["pct"].as_f64(),
            resets(&a["fable"]),
        ));
    }
    if let Some(at) = a["at"].as_str() {
        limits = limits.child(
            text(format!("updated {} ago", fmt::ago_short(Some(at), s.now)))
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint),
        );
    }
    let x = &u["session"];
    let current = if x.is_object() {
        let size = x["context"]["size"].as_f64().map_or("—".into(), |n| {
            if n >= 1e6 {
                format!("of {:.0}M tokens", n / 1e6)
            } else {
                format!("of {:.0}k tokens", n / 1e3)
            }
        });
        let mut chips = row()
            .gap(6.0)
            .flex_wrap()
            .child(pill(
                k,
                format!("Effort: {}", x["effort"].as_str().unwrap_or("—")),
                k.c.text_muted,
                k.c.layer_02,
            ))
            .child(pill(
                k,
                format!(
                    "Model: {}",
                    x["modelName"]
                        .as_str()
                        .or(x["modelId"].as_str())
                        .unwrap_or("—")
                ),
                k.c.text_muted,
                k.c.layer_02,
            ));
        if x["fastMode"] == true {
            chips = chips.child(pill(k, "Fast", k.c.warning.fg, k.c.warning.bg));
        }
        card("Current session")
            .child(usage_bar(k, "Context", x["context"]["pct"].as_f64(), size))
            .child(chips)
    } else {
        card("Current session").child(
            text("No active session snapshot.")
                .font(k.ty.text_small)
                .color(k.c.text_faint),
        )
    };
    row()
        .key("stats-usage")
        .w_full()
        .gap(12.0)
        .flex_wrap()
        .child(limits)
        .child(current)
}

pub fn stats(s: &Hooked, k: &Kit) -> El {
    let pd = &s.pages;
    let labels: Vec<&str> = STATS_RANGES.iter().map(|r| r.1).collect();
    let actions = SegmentedControl::new(&labels, Some(pd.stats_range))
        .label("Range")
        .fit()
        .on_pick(|s: &mut Hooked, i, _| s.pages.stats_range = i)
        .build(k)
        .key("stats-range");
    let Some(v) = pd.stats.as_ref() else {
        return page(k, "stats", "Stats", actions, loading(k));
    };
    let t = &v["totals"];
    let usage = usage_cards(s, k);
    let tiles = row()
        .key("stats-tiles")
        .w_full()
        .gap(12.0)
        .flex_wrap()
        .child(tile(k, "COST", fmt::cost(t["cost"].as_f64())))
        .child(tile(k, "SESSIONS", format!("{:.0}", num(&t["sessions"]))))
        .child(tile(k, "PROMPTS", format!("{:.0}", num(&t["prompts"]))))
        .child(tile(k, "TURNS", format!("{:.0}", num(&t["turns"]))))
        .child(tile(k, "OUTPUT", tokens(num(&t["output"]))))
        .child(tile(k, "CACHE READ", tokens(num(&t["cacheRead"]))));
    let mut days: Vec<(String, Value)> = v["byDay"]
        .as_object()
        .map(|m| m.iter().map(|(a, b)| (a.clone(), b.clone())).collect())
        .unwrap_or_default();
    days.sort_by(|a, b| a.0.cmp(&b.0));
    let max_day = days
        .iter()
        .map(|d| num(&d.1["cost"]))
        .fold(0.0, f64::max)
        .max(0.01);
    let chart = row()
        .key("stats-days")
        .w_full()
        .h(160.0)
        .gap(6.0)
        .items_end()
        .children(days.iter().rev().take(31).rev().map(|(d, x)| {
            let c = num(&x["cost"]);
            col()
                .grow(1.0)
                .h_full()
                .gap(4.0)
                .justify_end()
                .items_center()
                .help(format!(
                    "{d} · {} · {:.0} turns",
                    fmt::cost(Some(c)),
                    num(&x["turns"])
                ))
                .child(
                    el().w_full()
                        .max_w(36.0)
                        .h((c / max_day * 120.0) as f32 + 2.0)
                        .radius(3.0)
                        .fill(k.c.info.icon),
                )
                .child(
                    text(d.get(5..).unwrap_or(d).to_string())
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                )
        }));
    let models = sorted_by(&v["byModel"], "cost");
    let max_m = models
        .first()
        .map(|m| num(&m.1["cost"]))
        .unwrap_or(1.0)
        .max(0.01);
    let mut by_model = card(k, "stats-models", "BY MODEL");
    for (m, x) in &models {
        by_model = by_model.child(hbar(
            k,
            fmt::short_model(m),
            (num(&x["cost"]) / max_m) as f32,
            fmt::cost(x["cost"].as_f64()),
            k.c.success.icon,
        ));
    }
    let projects = sorted_by(&v["byProject"], "cost");
    let max_p = projects
        .first()
        .map(|m| num(&m.1["cost"]))
        .unwrap_or(1.0)
        .max(0.01);
    let mut by_project = card(k, "stats-projects", "BY PROJECT");
    for (p, x) in projects.iter().take(12) {
        by_project = by_project.child(hbar(
            k,
            p.clone(),
            (num(&x["cost"]) / max_p) as f32,
            fmt::cost(x["cost"].as_f64()),
            k.c.warning.icon,
        ));
    }
    let mut tools: Vec<(String, f64)> = v["byTool"]
        .as_object()
        .map(|m| m.iter().map(|(a, b)| (a.clone(), num(b))).collect())
        .unwrap_or_default();
    tools.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let max_t = tools.first().map(|t| t.1).unwrap_or(1.0).max(1.0);
    let mut by_tool = card(k, "stats-tools", "TOOLS");
    for (name, n) in tools.iter().take(12) {
        let label = name.rsplit("__").next().unwrap_or(name).to_string();
        by_tool = by_tool.child(hbar(
            k,
            label,
            (*n / max_t) as f32,
            format!("{n:.0}"),
            k.c.icon_muted,
        ));
    }
    let body = col()
        .key("stats-inner")
        .w_full()
        .max_w(1100.0)
        .self_center()
        .padding(24.0)
        .gap(18.0)
        .child(usage)
        .child(tiles)
        .child(card(k, "stats-chart", "COST PER DAY").child(chart))
        .child(
            row()
                .w_full()
                .gap(18.0)
                .items_start()
                .child(by_model.grow(1.0).shrink())
                .child(by_tool.grow(1.0).shrink()),
        )
        .child(by_project);
    page(k, "stats", "Stats", actions, scroll("stats-scroll", body))
}

pub fn digest(s: &Hooked, k: &Kit) -> El {
    let pd = &s.pages;
    let step = |label: &'static str, delta: i64| {
        let date = pd.digest_date.clone();
        Button::new(label)
            .variant(ButtonVariant::GhostMuted)
            .control_size(ControlSize::Regular)
            .disabled(date.is_none())
            .on_press(move |s: &mut Hooked| {
                if let Some(d) = date.as_deref().and_then(|d| fmt::shift_date(d, delta)) {
                    s.open_digest(d);
                }
            })
            .build(k)
    };
    let actions = row()
        .gap(8.0)
        .center_y()
        .child(step("◀", -1))
        .child(
            TextInput::new(&pd.digest_pick)
                .placeholder(
                    pd.digest_date
                        .clone()
                        .unwrap_or_else(|| "YYYY-MM-DD".into()),
                )
                .width(Some(130.0))
                .on_edit(|s: &mut Hooked| &mut s.pages.digest_pick)
                .on_submit(|s: &mut Hooked, _| {
                    let d = s.pages.digest_pick.text.trim().to_string();
                    if fmt::shift_date(&d, 0).is_some() {
                        s.pages.digest_pick = rune::TextEdit::new("");
                        s.open_digest(d);
                    } else {
                        s.flash("Type a date as YYYY-MM-DD", true);
                    }
                })
                .build(k)
                .key("dg-pick"),
        )
        .child(step("▶", 1))
        .child(
            Button::new("Generate")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Regular)
                .help("Write the AI summary for this day (missing or partial)")
                .disabled(pd.digest_date.is_none())
                .on_press(|s: &mut Hooked| s.generate_digest(false))
                .build(k)
                .key("dg-gen"),
        )
        .child(
            Button::new("Regenerate")
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Regular)
                .disabled(pd.digest_date.is_none())
                .on_press(|s: &mut Hooked| s.generate_digest(true))
                .build(k)
                .key("dg-regen"),
        );
    let list = col()
        .key("dg-list")
        .w(240.0)
        .h_full()
        .gap(2.0)
        .padding(10.0)
        .border_sides([0.0, 1.0, 0.0, 0.0], k.c.border_weak)
        .children(pd.digests.iter().take(120).map(|d| {
            let date = d["date"].as_str().unwrap_or("").to_string();
            let on = pd.digest_date.as_deref() == Some(date.as_str());
            let t = &d["totals"];
            let id = date.clone();
            k.interactive(
                row()
                    .key(format!("dg-{date}"))
                    .role("option")
                    .checked(on)
                    .w_full()
                    .h(32.0)
                    .px(10.0)
                    .gap(8.0)
                    .center_y()
                    .radius(k.radius.md)
                    .cursor(Cursor::Pointer)
                    .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
                    .child(text(date).font(k.ty.ui).color(k.c.text_base).grow(1.0))
                    .child(
                        text(format!(
                            "{:.0} · {}",
                            num(&t["sessions"]),
                            fmt::cost(t["cost"].as_f64())
                        ))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                    ),
            )
            .on_press(move |s: &mut Hooked| s.open_digest(id.clone()))
        }));
    let detail = match pd.digest.as_ref() {
        None if pd.digest_date.is_some() => loading(k),
        None => col()
            .w_full()
            .h_full()
            .center()
            .child(text("No digest yet.").font(k.ty.body).color(k.c.text_faint)),
        Some(d) => {
            let t = &d["totals"];
            let mut c = col()
                .key("dg-detail")
                .w_full()
                .max_w(900.0)
                .padding(24.0)
                .gap(16.0)
                .child(
                    row()
                        .gap(10.0)
                        .center_y()
                        .child(
                            text(d["date"].as_str().unwrap_or("").to_string())
                                .font(k.ty.body_medium)
                                .color(k.c.text_base),
                        )
                        .child(pill(
                            k,
                            d["status"].as_str().unwrap_or("").to_string(),
                            k.c.text_muted,
                            k.c.layer_02,
                        ))
                        .child(
                            text(format!(
                                "{:.0} sessions · {:.0} prompts · {}",
                                num(&t["sessions"]),
                                num(&t["prompts"]),
                                fmt::cost(t["cost"].as_f64())
                            ))
                            .font(k.ty.text_small)
                            .color(k.c.text_faint),
                        ),
                );
            if let Some(e) = d["aiError"].as_str().filter(|e| !e.is_empty()) {
                c = c.child(
                    text(format!("Summary failed: {e}"))
                        .font(k.ty.ui)
                        .color(k.c.danger.fg),
                );
            }
            if let Some(sum) = d["summary"].as_str().filter(|x| !x.is_empty()) {
                c = c.child(super::md(sum.to_string()).build(k));
            }
            let pending: Vec<&Value> = d["pending"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|p| {
                    p["id"]
                        .as_str()
                        .and_then(|id| s.session(id))
                        .is_some_and(|x| x.has_question)
                })
                .collect();
            if !pending.is_empty() {
                c = c.child(section_title(k, "NEEDS ATTENTION"));
                for p in pending {
                    let id = p["id"].as_str().unwrap_or("").to_string();
                    c = c.child(
                        k.interactive(
                            row()
                                .role("link")
                                .w_full()
                                .gap(8.0)
                                .center_y()
                                .cursor(Cursor::Pointer)
                                .child(pill(
                                    k,
                                    p["kind"].as_str().unwrap_or("question").to_string(),
                                    k.c.warning.fg,
                                    k.c.warning.bg,
                                ))
                                .child(
                                    text(format!(
                                        "{} — {}",
                                        p["title"].as_str().unwrap_or(""),
                                        p["text"].as_str().unwrap_or("")
                                    ))
                                    .font(k.ty.text_small)
                                    .color(k.c.text_base)
                                    .truncate()
                                    .grow(1.0)
                                    .min_w(0.0),
                                ),
                        )
                        .on_press(move |s: &mut Hooked| s.open_session(&id)),
                    );
                }
            }
            for (key, title) in [("highlights", "HIGHLIGHTS"), ("blockers", "BLOCKERS")] {
                let items: Vec<String> = d[key]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect();
                if !items.is_empty() {
                    c = c.child(
                        super::md(format!(
                            "**{title}**\n\n{}",
                            items
                                .iter()
                                .map(|i| format!("- {i}"))
                                .collect::<Vec<_>>()
                                .join("\n")
                        ))
                        .build(k),
                    );
                }
            }
            c = c.child(section_title(k, "SESSIONS"));
            for x in d["sessions"].as_array().into_iter().flatten() {
                let id = x["id"].as_str().unwrap_or("").to_string();
                let mut sc = col()
                    .key(format!("dgs-{id}"))
                    .role("button")
                    .w_full()
                    .padding(12.0)
                    .gap(4.0)
                    .radius(k.radius.md)
                    .fill(k.c.layer_01)
                    .border(1.0, k.c.border_weak)
                    .cursor(Cursor::Pointer)
                    .child(
                        row()
                            .w_full()
                            .gap(8.0)
                            .center_y()
                            .child(dot(
                                k,
                                if x["statusKind"].as_str() == Some("done") {
                                    "background"
                                } else {
                                    "waiting"
                                },
                                7.0,
                            ))
                            .child(
                                text(x["title"].as_str().unwrap_or("").to_string())
                                    .font(k.ty.ui_medium)
                                    .color(k.c.text_base)
                                    .truncate()
                                    .grow(1.0)
                                    .shrink(),
                            )
                            .child(
                                text(x["status"].as_str().unwrap_or("").to_string())
                                    .font(k.ty.text_xsmall)
                                    .color(k.c.text_faint),
                            )
                            .child(
                                text(fmt::cost(x["cost"].as_f64()))
                                    .font(k.ty.text_xsmall)
                                    .color(k.c.text_faint),
                            ),
                    )
                    .child(
                        text(x["projectName"].as_str().unwrap_or("").to_string())
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_faint),
                    );
                for (f, label) in [("accomplished", "Done"), ("pending", "Pending")] {
                    if let Some(t) = x[f].as_str().filter(|t| !t.is_empty()) {
                        sc = sc.child(
                            text(format!("{label}: {t}"))
                                .font(k.ty.text_small)
                                .color(k.c.text_muted)
                                .wrap(),
                        );
                    }
                }
                c = c.child(
                    k.interactive(sc)
                        .on_press(move |s: &mut Hooked| s.open_session(&id)),
                );
            }
            scroll("dg-scroll", c)
        }
    };
    let body = row()
        .key("dg")
        .w_full()
        .h_full()
        .child(scroll("dg-list-scroll", list).w(240.0))
        .child(col().grow(1.0).h_full().shrink().child(detail));
    page(k, "digest", "Daily digest", actions, body)
}

pub fn memory(s: &Hooked, k: &Kit) -> El {
    let pd = &s.pages;
    let Some(v) = pd.memory.as_ref() else {
        return page(k, "memory", "Memory", el(), loading(k));
    };
    let q = pd.memory_query.text.trim().to_lowercase();
    let kind = pd.memory_type.clone();
    let keep = |m: &Value| {
        kind.as_deref()
            .is_none_or(|t| m["type"].as_str() == Some(t))
            && (q.is_empty()
                || ["name", "description", "body"].iter().any(|f| {
                    m[*f]
                        .as_str()
                        .is_some_and(|x| x.to_lowercase().contains(&q))
                }))
    };
    let projects: Vec<Value> = v["projects"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut p| {
            if let Some(ms) = p["memories"].as_array_mut() {
                ms.retain(|m| keep(m));
            }
            p
        })
        .filter(|p| p["memories"].as_array().is_some_and(|m| !m.is_empty()))
        .collect();
    let total = num(&v["total"]);
    let mut types = row().w_full().gap(6.0).flex_wrap().center_y().child(
        TextInput::new(&pd.memory_query)
            .placeholder("Search memories…")
            .width(Some(260.0))
            .on_edit(|s: &mut Hooked| &mut s.pages.memory_query)
            .on_change(|s: &mut Hooked, _| s.pages.memory_project = 0)
            .build(k)
            .key("mem-query"),
    );
    for (t, n) in v["byType"].as_object().into_iter().flatten() {
        let on = pd.memory_type.as_deref() == Some(t.as_str());
        let t2 = t.clone();
        types = types.child(super::settings::chip(
            k,
            format!("memt-{t}"),
            format!("{t} {}", n.as_u64().unwrap_or(0)),
            on,
            move |s| {
                s.pages.memory_project = 0;
                s.pages.memory_type = if s.pages.memory_type.as_deref() == Some(t2.as_str()) {
                    None
                } else {
                    Some(t2.clone())
                };
            },
        ));
    }
    let list = col()
        .key("mem-projects")
        .w(260.0)
        .padding(10.0)
        .gap(2.0)
        .children(projects.iter().enumerate().map(|(i, p)| {
            let on = i == pd.memory_project;
            let n = p["memories"].as_array().map_or(0, Vec::len);
            k.interactive(
                row()
                    .key(format!("memp-{i}"))
                    .role("option")
                    .checked(on)
                    .w_full()
                    .h(34.0)
                    .px(10.0)
                    .gap(8.0)
                    .center_y()
                    .radius(k.radius.md)
                    .cursor(Cursor::Pointer)
                    .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
                    .help(p["cwd"].as_str().unwrap_or("").to_string())
                    .child(glyph(&icons::FOLDER, 13.0, k.c.icon_muted))
                    .child(
                        text(p["name"].as_str().unwrap_or("").to_string())
                            .font(k.ty.ui)
                            .color(k.c.text_base)
                            .truncate()
                            .grow(1.0)
                            .shrink(),
                    )
                    .child(
                        text(n.to_string())
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_faint),
                    ),
            )
            .on_press(move |s: &mut Hooked| {
                s.pages.memory_project = i;
                s.pages.memory_open = None;
            })
        }));
    let mut detail = col()
        .key("mem-detail")
        .w_full()
        .max_w(900.0)
        .padding(24.0)
        .gap(10.0)
        .child(types);
    if let Some(p) = projects.get(pd.memory_project) {
        detail = detail.child(
            text(p["cwd"].as_str().unwrap_or("").to_string())
                .font(k.ty.text_small)
                .color(k.c.text_faint),
        );
        for m in p["memories"].as_array().into_iter().flatten() {
            let file = m["file"].as_str().unwrap_or("").to_string();
            let open = pd.memory_open.as_deref() == Some(file.as_str());
            let mut c = col()
                .key(format!("mem-{file}"))
                .w_full()
                .padding(12.0)
                .gap(6.0)
                .radius(k.radius.md)
                .fill(k.c.layer_01)
                .border(1.0, k.c.border_weak);
            let f = file.clone();
            c = c.child(
                k.interactive(
                    row()
                        .role("button")
                        .expanded(open)
                        .w_full()
                        .gap(8.0)
                        .center_y()
                        .cursor(Cursor::Pointer)
                        .child(pill(
                            k,
                            m["type"].as_str().unwrap_or("").to_string(),
                            k.c.text_muted,
                            k.c.layer_02,
                        ))
                        .child(
                            text(m["name"].as_str().unwrap_or(&file).to_string())
                                .font(k.ty.ui_medium)
                                .color(k.c.text_base)
                                .truncate()
                                .grow(1.0)
                                .shrink(),
                        )
                        .child(
                            text(file.clone())
                                .font(k.ty.text_xsmall)
                                .color(k.c.text_faint),
                        ),
                )
                .on_press(move |s: &mut Hooked| {
                    s.pages.memory_open = if s.pages.memory_open.as_deref() == Some(f.as_str()) {
                        None
                    } else {
                        Some(f.clone())
                    }
                }),
            );
            if let Some(d) = m["description"].as_str().filter(|d| !d.is_empty()) {
                c = c.child(
                    text(d.to_string())
                        .font(k.ty.text_small)
                        .color(k.c.text_muted)
                        .wrap(),
                );
            }
            if open {
                c = c.child(
                    super::md(m["body"].as_str().unwrap_or("").to_string())
                        .selectable(true)
                        .build(k),
                );
            }
            detail = detail.child(c);
        }
    }
    let body = row()
        .key("mem")
        .w_full()
        .h_full()
        .child(
            scroll("mem-list", list)
                .w(260.0)
                .border_sides([0.0, 1.0, 0.0, 0.0], k.c.border_weak),
        )
        .child(
            col()
                .grow(1.0)
                .shrink()
                .h_full()
                .child(scroll("mem-scroll", detail)),
        );
    page(k, "memory", &format!("Memory · {total:.0}"), el(), body)
}

fn field(k: &Kit, label: &str, input: El) -> El {
    col()
        .w_full()
        .gap(6.0)
        .child(section_title(k, label))
        .child(input)
}

pub fn cron(s: &Hooked, k: &Kit) -> El {
    let pd = &s.pages;
    let actions = Button::new("New task")
        .icon(&icons::PLUS)
        .variant(ButtonVariant::Contrast)
        .control_size(ControlSize::Regular)
        .on_press(|s: &mut Hooked| s.edit_cron(None))
        .build(k)
        .key("cron-new");
    let mut list = col()
        .key("cron-list")
        .w_full()
        .max_w(1000.0)
        .self_center()
        .padding(24.0)
        .gap(10.0);
    if let Some(f) = pd.cron_form.as_ref() {
        list = list.child(
            col()
                .key("cron-form")
                .w_full()
                .padding(16.0)
                .gap(12.0)
                .radius(k.radius.lg)
                .fill(k.c.surface_raised)
                .border(1.0, k.c.info.border)
                .child(
                    text(if f.id.is_some() {
                        "Edit task"
                    } else {
                        "New task"
                    })
                    .font(k.ty.ui_medium)
                    .color(k.c.text_base),
                )
                .child(
                    row()
                        .w_full()
                        .gap(12.0)
                        .child(
                            field(
                                k,
                                "NAME",
                                TextInput::new(&f.name)
                                    .width(None)
                                    .on_edit(|s: &mut Hooked| {
                                        &mut s.pages.cron_form.as_mut().unwrap().name
                                    })
                                    .build(k)
                                    .key("cron-name"),
                            )
                            .grow(1.0)
                            .shrink(),
                        )
                        .child(
                            field(
                                k,
                                "SCHEDULE (CRON, LOCAL TIME)",
                                TextInput::new(&f.schedule)
                                    .width(None)
                                    .on_edit(|s: &mut Hooked| {
                                        &mut s.pages.cron_form.as_mut().unwrap().schedule
                                    })
                                    .build(k)
                                    .key("cron-schedule"),
                            )
                            .w(260.0),
                        ),
                )
                .child(field(
                    k,
                    "PROJECT",
                    TextInput::new(&f.cwd)
                        .width(None)
                        .leading_icon(&icons::FOLDER)
                        .on_edit(|s: &mut Hooked| &mut s.pages.cron_form.as_mut().unwrap().cwd)
                        .build(k)
                        .key("cron-cwd"),
                ))
                .child({
                    let (msg, color) =
                        match crate::cron::next_runs(&f.schedule.text, 3, fmt::now_ms()) {
                            Ok(r) if !r.is_empty() => (
                                format!(
                                    "Next: {}",
                                    r.iter()
                                        .map(|t| crate::cron::stamp(*t))
                                        .collect::<Vec<_>>()
                                        .join(" · ")
                                ),
                                k.c.text_faint,
                            ),
                            Ok(_) => ("Never runs".to_string(), k.c.warning.fg),
                            Err(e) => (e, k.c.danger.fg),
                        };
                    text(msg).font(k.ty.text_xsmall).color(color)
                })
                .child(field(
                    k,
                    "PROMPT",
                    TextArea::new(&f.prompt)
                        .width(None)
                        .auto_grow(3, 12)
                        .on_edit(|s: &mut Hooked| &mut s.pages.cron_form.as_mut().unwrap().prompt)
                        .build(k)
                        .key("cron-prompt"),
                ))
                .child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .center_y()
                        .child(
                            Switch::new(f.enabled)
                                .label("Enabled")
                                .on_toggle(|s: &mut Hooked| {
                                    if let Some(f) = s.pages.cron_form.as_mut() {
                                        f.enabled = !f.enabled;
                                    }
                                })
                                .build(k),
                        )
                        .child(el().grow(1.0))
                        .child(
                            Button::new("Cancel")
                                .variant(ButtonVariant::GhostMuted)
                                .on_press(|s: &mut Hooked| s.pages.cron_form = None)
                                .build(k)
                                .key("cron-cancel"),
                        )
                        .child(
                            Button::new("Save")
                                .variant(ButtonVariant::Contrast)
                                .on_press(|s: &mut Hooked| s.save_cron())
                                .build(k)
                                .key("cron-save"),
                        ),
                ),
        );
    }
    for t in &pd.cron {
        let id = t["id"].as_str().unwrap_or("").to_string();
        let on = t["enabled"].as_bool().unwrap_or(true);
        let last = t["runs"].as_array().and_then(|r| r.last()).cloned();
        let (i1, i2, i3, i4) = (id.clone(), id.clone(), id.clone(), id.clone());
        let mut c = col()
            .key(format!("cron-{id}"))
            .w_full()
            .padding(14.0)
            .gap(6.0)
            .radius(k.radius.lg)
            .fill(k.c.layer_01)
            .border(1.0, k.c.border_weak)
            .child(
                row()
                    .w_full()
                    .gap(10.0)
                    .center_y()
                    .child(
                        Switch::new(on)
                            .label(t["name"].as_str().unwrap_or("").to_string())
                            .on_toggle(move |s: &mut Hooked| s.toggle_cron(i1.clone()))
                            .build(k),
                    )
                    .child(pill(
                        k,
                        t["schedule"].as_str().unwrap_or("").to_string(),
                        k.c.text_muted,
                        k.c.layer_02,
                    ))
                    .child(el().grow(1.0))
                    .child(
                        Button::new("Run now")
                            .icon(&icons::PLAY)
                            .variant(ButtonVariant::Outline)
                            .control_size(ControlSize::Small)
                            .on_press(move |s: &mut Hooked| s.run_cron(i2.clone()))
                            .build(k)
                            .key(format!("cron-run-{id}")),
                    )
                    .child(
                        Button::new("Edit")
                            .variant(ButtonVariant::GhostMuted)
                            .control_size(ControlSize::Small)
                            .on_press(move |s: &mut Hooked| s.edit_cron(Some(i3.clone())))
                            .build(k)
                            .key(format!("cron-edit-{id}")),
                    )
                    .child(
                        Button::new("Delete")
                            .variant(ButtonVariant::GhostMuted)
                            .control_size(ControlSize::Small)
                            .on_press(move |s: &mut Hooked| s.delete_cron(i4.clone()))
                            .build(k)
                            .key(format!("cron-del-{id}")),
                    ),
            )
            .child(
                text(t["cwd"].as_str().unwrap_or("").to_string())
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_faint),
            )
            .child(
                text(fmt::first_line(t["prompt"].as_str().unwrap_or(""), 220))
                    .font(k.ty.text_small)
                    .color(k.c.text_muted)
                    .wrap(),
            );
        let next = t["nextRun"]
            .as_str()
            .and_then(fmt::parse_ts)
            .filter(|_| on)
            .map(|n| format!("Next {}", crate::cron::stamp(n)))
            .unwrap_or_default();
        let runs: Vec<Value> = t["runs"].as_array().cloned().unwrap_or_default();
        let showing = pd.cron_history.as_deref() == Some(id.as_str());
        let hid = id.clone();
        c = c.child(
            row()
                .gap(8.0)
                .center_y()
                .child(text(next).font(k.ty.text_xsmall).color(k.c.text_faint))
                .child(if runs.is_empty() {
                    el()
                } else {
                    Button::new(format!("{} runs", runs.len()))
                        .icon(&icons::CHEVRON_DOWN)
                        .variant(ButtonVariant::GhostMuted)
                        .control_size(ControlSize::Small)
                        .on_press(move |s: &mut Hooked| {
                            s.pages.cron_history =
                                if s.pages.cron_history.as_deref() == Some(hid.as_str()) {
                                    None
                                } else {
                                    Some(hid.clone())
                                };
                        })
                        .build(k)
                }),
        );
        if showing {
            let mut hist = col().w_full().gap(4.0).pl(8.0);
            for r in runs.iter().rev().take(30) {
                let at = fmt::ago_short(r["at"].as_str(), s.now);
                let mut line = row().gap(8.0).center_y().child(
                    text(format!("{at} ago"))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_muted),
                );
                if r["manual"] == true {
                    line = line.child(pill(k, "manual", k.c.text_muted, k.c.layer_02));
                }
                line = if let Some(e) = r["error"].as_str() {
                    line.child(
                        text(e.to_string())
                            .font(k.ty.text_xsmall)
                            .color(k.c.danger.fg),
                    )
                } else if let Some(sk) = r["skipped"].as_str() {
                    line.child(
                        text(format!("Skipped: {sk}"))
                            .font(k.ty.text_xsmall)
                            .color(k.c.warning.fg),
                    )
                } else if let Some(sid) = r["sessionId"].as_str().map(str::to_string) {
                    line.child(
                        k.interactive(
                            text("Open session")
                                .role("link")
                                .font(k.ty.text_xsmall)
                                .color(k.c.text_accent)
                                .cursor(Cursor::Pointer),
                        )
                        .on_press(move |s: &mut Hooked| s.open_session(&sid)),
                    )
                } else {
                    line
                };
                hist = hist.child(line);
            }
            c = c.child(hist);
        }
        if let Some(r) = last.filter(|_| !showing) {
            let sid = r["sessionId"].as_str().unwrap_or("").to_string();
            let at = fmt::ago_short(r["at"].as_str(), s.now);
            c = c.child(
                k.interactive(
                    row()
                        .role("link")
                        .gap(6.0)
                        .center_y()
                        .cursor(Cursor::Pointer)
                        .child(glyph(&icons::CLOCK, 11.0, k.c.icon_faint))
                        .child(
                            text(format!("Last run {at} ago · open its session"))
                                .font(k.ty.text_xsmall)
                                .color(k.c.text_accent),
                        ),
                )
                .on_press(move |s: &mut Hooked| s.open_session(&sid)),
            );
        }
        list = list.child(c);
    }
    if pd.cron.is_empty() && pd.cron_form.is_none() {
        list = list.child(
            text("No scheduled tasks.")
                .font(k.ty.body)
                .color(k.c.text_faint),
        );
    }
    page(
        k,
        "cron",
        "Scheduled tasks",
        actions,
        scroll("cron-scroll", list),
    )
}

pub fn github(s: &Hooked, k: &Kit) -> El {
    let pd = &s.pages;
    let refresh = Button::new("Refresh")
        .icon(&icons::RESTART)
        .variant(ButtonVariant::GhostMuted)
        .control_size(ControlSize::Regular)
        .disabled(pd.github_loading)
        .on_press(|s: &mut Hooked| s.pages.github = None)
        .build(k)
        .key("gh-refresh");
    let Some(v) = pd.github.as_ref() else {
        return page(k, "github", "GitHub", refresh, loading(k));
    };
    let labels: Vec<String> = GITHUB_TABS
        .iter()
        .map(|(key, label)| format!("{label} · {}", s.gh_items(key).len()))
        .collect();
    let tabs = SegmentedControl::new(&labels, Some(pd.github_tab))
        .label("List")
        .fit()
        .on_pick(|s: &mut Hooked, i, _| s.pages.github_tab = i)
        .build(k)
        .key("gh-tabs");
    let key = GITHUB_TABS[pd.github_tab].0;
    let mut list = col()
        .key("gh-list")
        .w_full()
        .max_w(1100.0)
        .self_center()
        .padding(24.0)
        .gap(6.0)
        .child(row().pb(4.0).child(tabs));
    let mut repos: Vec<(String, usize, String)> = Vec::new();
    for (k2, _) in GITHUB_TABS {
        let all = if k2 == "reviews" {
            crate::pages::gh_reviews(v)
        } else {
            v[k2].as_array().cloned().unwrap_or_default()
        };
        for x in all {
            let r = x["repo"].as_str().unwrap_or("").to_string();
            let at = x["updatedAt"].as_str().unwrap_or("").to_string();
            match repos.iter_mut().find(|e| e.0 == r) {
                Some(e) => {
                    e.1 += 1;
                    if at > e.2 {
                        e.2 = at;
                    }
                }
                None => repos.push((r, 1, at)),
            }
        }
    }
    repos.sort_by(|a, b| b.2.cmp(&a.2));
    let mut rail = row().w_full().gap(6.0).flex_wrap().pb(6.0).child(
        TextInput::new(&pd.gh_query)
            .placeholder("Filter by title or repo, org/ to scope…")
            .width(Some(320.0))
            .on_edit(|s: &mut Hooked| &mut s.pages.gh_query)
            .build(k)
            .key("gh-query"),
    );
    for (r, n, _) in repos.into_iter().take(16) {
        let on = pd.gh_repo.as_deref() == Some(r.as_str());
        let name = r.rsplit('/').next().unwrap_or(&r).to_string();
        let pick = r.clone();
        rail = rail.child(
            k.interactive(
                row()
                    .key(format!("gh-repo-{r}"))
                    .role("checkbox")
                    .checked(on)
                    .h(26.0)
                    .px(8.0)
                    .gap(4.0)
                    .center_y()
                    .radius(k.radius.sm)
                    .cursor(Cursor::Pointer)
                    .help(r.clone())
                    .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
                    .border(
                        1.0,
                        if on {
                            k.c.border_strong
                        } else {
                            k.c.border_weak
                        },
                    )
                    .child(text(name).font(k.ty.text_small).color(k.c.text_base))
                    .child(
                        text(n.to_string())
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_faint),
                    ),
            )
            .on_press(move |s: &mut Hooked| {
                s.pages.gh_repo = if s.pages.gh_repo.as_deref() == Some(pick.as_str()) {
                    None
                } else {
                    Some(pick.clone())
                };
            }),
        );
    }
    list = list.child(rail);
    let items = s.gh_items(key);
    if key == "notifications" && !items.is_empty() {
        list = list.child(
            row().pb(4.0).child(
                Button::new(format!("Mark the {} shown as done", items.len()))
                    .icon(&icons::CIRCLE_CHECK)
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Small)
                    .on_press(|s: &mut Hooked| s.mark_notifications_done())
                    .build(k),
            ),
        );
    }
    if items.is_empty() {
        list = list.child(text("Nothing here.").font(k.ty.body).color(k.c.text_faint));
    }
    for (i, x) in items.iter().enumerate() {
        let url = x["url"].as_str().unwrap_or("").to_string();
        let title = x["title"]
            .as_str()
            .or(x["subject"].as_str())
            .unwrap_or("")
            .to_string();
        let repo = x["repo"].as_str().unwrap_or("").to_string();
        let num = x["number"]
            .as_i64()
            .map(|n| format!("#{n}"))
            .unwrap_or_default();
        let checks = x["checks"].as_str().unwrap_or("");
        let check_color = match checks {
            "SUCCESS" => k.c.success.icon,
            "FAILURE" | "ERROR" => k.c.danger.icon,
            "PENDING" => k.c.warning.icon,
            _ => k.c.icon_faint,
        };
        let decision = match x["decision"].as_str().or(x["state"].as_str()).unwrap_or("") {
            "APPROVED" => Some(("Approved", k.c.success.fg)),
            "CHANGES_REQUESTED" => Some(("Changes requested", k.c.danger.fg)),
            "COMMENTED" => Some(("Commented", k.c.text_muted)),
            "DISMISSED" => Some(("Dismissed", k.c.text_faint)),
            "REVIEW_REQUIRED" => Some(("Review required", k.c.text_faint)),
            _ => None,
        };
        let mut r = row()
            .key(format!("gh-{key}-{i}"))
            .role("link")
            .w_full()
            .px(12.0)
            .py(8.0)
            .gap(10.0)
            .center_y()
            .radius(k.radius.md)
            .cursor(Cursor::Pointer)
            .border(1.0, k.c.border_weak)
            .help(url.clone())
            .child(el().size(8.0, 8.0).radius(4.0).fill(check_color))
            .child(
                col()
                    .grow(1.0)
                    .shrink()
                    .gap(2.0)
                    .child(
                        text(title)
                            .font(k.ty.ui_medium)
                            .color(k.c.text_base)
                            .truncate(),
                    )
                    .child(
                        text(format!(
                            "{repo} {num} · {} · {}",
                            x["author"].as_str().unwrap_or(""),
                            fmt::ago_short(x["updatedAt"].as_str(), s.now)
                        ))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                    ),
            );
        if x["draft"].as_bool() == Some(true) {
            r = r.child(pill(k, "draft", k.c.text_muted, k.c.layer_02));
        }
        if let Some((label, color)) = decision {
            r = r.child(text(label).font(k.ty.text_xsmall_medium).color(color));
        }
        if let (Some(a), Some(d)) = (x["additions"].as_i64(), x["deletions"].as_i64()) {
            r = r
                .child(
                    text(format!("+{a}"))
                        .font(k.ty.text_xsmall)
                        .color(k.c.success.fg),
                )
                .child(
                    text(format!("−{d}"))
                        .font(k.ty.text_xsmall)
                        .color(k.c.danger.fg),
                );
        }
        list = list.child(k.interactive(r).on_press_tx(move |_: &mut Hooked, tx| {
            let _ = tx.open_url(&url);
        }));
    }
    page(k, "github", "GitHub", refresh, scroll("gh-scroll", list))
}

pub fn skills(s: &Hooked, k: &Kit) -> El {
    let pd = &s.pages;
    let Some(list) = pd.skills.as_ref().filter(|l| !l.is_empty()) else {
        return page(k, "skills", "Skills", el(), loading(k));
    };
    let q = pd.skills_query.text.trim().to_lowercase();
    let mut groups: Vec<(String, Vec<&Value>)> = Vec::new();
    for x in list.iter().filter(|x| {
        q.is_empty()
            || ["name", "description"].iter().any(|f| {
                x[*f]
                    .as_str()
                    .is_some_and(|v| v.to_lowercase().contains(&q))
            })
    }) {
        let src = x["source"].as_str().unwrap_or("other").to_string();
        match groups.iter_mut().find(|g| g.0 == src) {
            Some(g) => g.1.push(x),
            None => groups.push((src, vec![x])),
        }
    }
    let mut left = col()
        .key("skills-list")
        .w_full()
        .padding(10.0)
        .gap(2.0)
        .child(
            TextInput::new(&pd.skills_query)
                .placeholder("Search skills…")
                .width(None)
                .on_edit(|s: &mut Hooked| &mut s.pages.skills_query)
                .build(k)
                .key("skills-query"),
        );
    for (src, items) in groups {
        left = left.child(
            row()
                .pt(8.0)
                .pb(4.0)
                .px(6.0)
                .child(section_title(k, &src.to_uppercase())),
        );
        for x in items {
            let id = x["id"].as_str().unwrap_or("").to_string();
            let on = pd.skill_open.as_deref() == Some(id.as_str());
            let open = id.clone();
            left = left.child(
                k.interactive(
                    col()
                        .key(format!("sk-{id}"))
                        .role("option")
                        .checked(on)
                        .w_full()
                        .px(10.0)
                        .py(6.0)
                        .gap(2.0)
                        .radius(k.radius.md)
                        .cursor(Cursor::Pointer)
                        .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
                        .child(
                            text(x["name"].as_str().unwrap_or("").to_string())
                                .font(k.ty.ui_medium)
                                .color(k.c.text_base)
                                .truncate(),
                        )
                        .child(
                            text(fmt::first_line(x["description"].as_str().unwrap_or(""), 90))
                                .font(k.ty.text_xsmall)
                                .color(k.c.text_faint)
                                .truncate(),
                        ),
                )
                .on_press(move |s: &mut Hooked| s.open_skill(open.clone())),
            );
        }
    }
    let detail = match pd.skill.as_ref() {
        None => loading(k),
        Some(x) => {
            let mut c = col()
                .key("skill-detail")
                .w_full()
                .max_w(900.0)
                .padding(24.0)
                .gap(12.0)
                .child(
                    row()
                        .gap(10.0)
                        .center_y()
                        .child(
                            text(x["name"].as_str().unwrap_or("").to_string())
                                .font(k.ty.body_medium)
                                .color(k.c.text_base),
                        )
                        .child(pill(
                            k,
                            x["source"].as_str().unwrap_or("").to_string(),
                            k.c.text_muted,
                            k.c.layer_02,
                        ))
                        .child(el().grow(1.0))
                        .child({
                            let cmd = format!("/{}", x["name"].as_str().unwrap_or(""));
                            Button::new("Copy command")
                                .icon(&icons::COPY)
                                .variant(ButtonVariant::Outline)
                                .control_size(ControlSize::Small)
                                .help(cmd.clone())
                                .on_press_tx(move |s: &mut Hooked, tx| {
                                    tx.copy(&cmd);
                                    s.flash(format!("✓ Copied {cmd}"), false);
                                })
                                .build(k)
                        }),
                )
                .child(
                    text(x["file"].as_str().unwrap_or("").to_string())
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint)
                        .selectable(true),
                )
                .child(
                    text(x["description"].as_str().unwrap_or("").to_string())
                        .font(k.ty.ui)
                        .color(k.c.text_muted)
                        .wrap(),
                );
            let meta: Vec<String> = x["meta"]
                .as_object()
                .map(|m| {
                    m.iter()
                        .filter(|(key, _)| *key != "name" && *key != "description")
                        .map(|(key, v)| {
                            format!(
                                "{key}: {}",
                                v.as_str()
                                    .map(str::to_string)
                                    .unwrap_or_else(|| v.to_string())
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !meta.is_empty() {
                c = c.child(
                    text(meta.join("  ·  "))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint)
                        .wrap(),
                );
            }
            c = c.child(
                super::md(x["body"].as_str().unwrap_or("").to_string())
                    .selectable(true)
                    .build(k),
            );
            scroll("skill-scroll", c)
        }
    };
    let body = row()
        .key("skills")
        .w_full()
        .h_full()
        .child(
            scroll("skills-scroll", left)
                .w(300.0)
                .border_sides([0.0, 1.0, 0.0, 0.0], k.c.border_weak),
        )
        .child(col().grow(1.0).shrink().h_full().child(detail));
    page(k, "skills", &format!("Skills · {}", list.len()), el(), body)
}

pub fn prompts(s: &Hooked, k: &Kit) -> El {
    use rune_kit::{TextArea, TextInput};
    let list = s.prompts();
    let sel = s.pages.prompt_sel;
    let mut items = col().w_full().gap(2.0);
    if list.is_empty() {
        items = items.child(
            text("No prompt yet. Saved prompts show up on the New session page, ready to drop into the draft.")
                .font(k.ty.text_small)
                .color(k.c.text_faint)
                .wrap(),
        );
    }
    for (i, (name, body)) in list.iter().enumerate() {
        let on = sel == Some(Some(i));
        items = items.child(
            k.interactive(
                col()
                    .key(format!("prompt-{i}"))
                    .role("button")
                    .checked(on)
                    .w_full()
                    .px(10.0)
                    .py(8.0)
                    .gap(2.0)
                    .radius(k.radius.sm)
                    .cursor(Cursor::Pointer)
                    .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
                    .child(
                        text(name.clone())
                            .font(k.ty.ui_medium)
                            .color(k.c.text_base)
                            .truncate(),
                    )
                    .child(
                        text(fmt::first_line(body, 80))
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_faint)
                            .truncate(),
                    ),
            )
            .on_press(move |s: &mut Hooked| s.edit_prompt(Some(i))),
        );
    }
    let left = col()
        .key("prompts-list")
        .w(300.0)
        .h_full()
        .padding(12.0)
        .gap(8.0)
        .border_sides([0.0, 1.0, 0.0, 0.0], k.c.border_weak)
        .child(
            Button::new("New prompt")
                .icon(&icons::PLUS)
                .variant(ButtonVariant::Contrast)
                .on_press(|s: &mut Hooked| s.edit_prompt(None))
                .build(k),
        )
        .child(scroll("prompts-scroll", items));
    let right = match sel {
        None => col().grow(1.0).center().child(
            text("Pick a prompt to edit it, or create one.")
                .font(k.ty.body)
                .color(k.c.text_faint),
        ),
        Some(i) => {
            let mut actions = row()
                .gap(8.0)
                .child(
                    Button::new("Save")
                        .variant(ButtonVariant::Contrast)
                        .on_press(|s: &mut Hooked| s.save_prompt())
                        .build(k),
                )
                .child(
                    Button::new("Cancel")
                        .variant(ButtonVariant::GhostMuted)
                        .on_press(|s: &mut Hooked| s.pages.prompt_sel = None)
                        .build(k),
                );
            if i.is_some() {
                actions = actions.child(el().grow(1.0)).child(
                    Button::new("Delete")
                        .variant(ButtonVariant::Danger)
                        .on_press(|s: &mut Hooked| s.delete_prompt())
                        .build(k),
                );
            }
            col()
                .grow(1.0)
                .min_w(0.0)
                .h_full()
                .padding(20.0)
                .gap(12.0)
                .child(
                    TextInput::new(&s.pages.prompt_name)
                        .placeholder("Name")
                        .width(None)
                        .on_edit(|s: &mut Hooked| &mut s.pages.prompt_name)
                        .build(k)
                        .key("prompt-name"),
                )
                .child(
                    TextArea::new(&s.pages.prompt_text)
                        .placeholder("The prompt…")
                        .width(None)
                        .auto_grow(8, 30)
                        .on_edit(|s: &mut Hooked| &mut s.pages.prompt_text)
                        .build(k)
                        .key("prompt-text"),
                )
                .child(actions)
        }
    };
    page(
        k,
        "prompts",
        &format!("Prompts · {}", list.len()),
        el(),
        row().w_full().grow(1.0).min_h(0.0).child(left).child(right),
    )
}
