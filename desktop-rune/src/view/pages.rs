use rune::{Color, Cursor, El, ScrollSpec, col, el, row, text};
use rune_kit::{
    Button, ButtonVariant, ControlSize, Kit, SegmentedControl, Select, Spinner, Switch,
    TextArea, TextInput,
};
use serde_json::{Value, json};

use super::{dot, glyph, pill, section_title};
use crate::app::{Hooked, Popup, Theme};
use crate::pages::{GITHUB_TABS, STATS_RANGES};
use crate::{fmt, icons};

fn page(k: &Kit, key: &str, title: &str, actions: El, body: El) -> El {
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

fn scroll(key: &str, inner: El) -> El {
    col()
        .key(key.to_string())
        .w_full()
        .h_full()
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(inner)
}

fn loading(k: &Kit) -> El {
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
    let actions = row()
        .gap(8.0)
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
    let projects = v["projects"].as_array().cloned().unwrap_or_default();
    let total = num(&v["total"]);
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
        .gap(10.0);
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
        if let Some(r) = last {
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

fn setting_row(k: &Kit, title: &str, hint: &str, control: El) -> El {
    row()
        .w_full()
        .py(10.0)
        .gap(16.0)
        .center_y()
        .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_weak)
        .child(
            col()
                .grow(1.0)
                .shrink()
                .gap(2.0)
                .child(
                    text(title.to_string())
                        .font(k.ty.ui_medium)
                        .color(k.c.text_base),
                )
                .child(
                    text(hint.to_string())
                        .font(k.ty.text_small)
                        .color(k.c.text_faint)
                        .wrap(),
                ),
        )
        .child(control)
}

fn toggle(k: &Kit, on: bool, key: &'static str, f: impl Fn(&mut Hooked) + 'static) -> El {
    Switch::new(on)
        .hide_label()
        .label(key)
        .on_toggle(f)
        .build(k)
        .key(key)
}

pub fn settings(s: &Hooked, k: &Kit, layer: &mut Vec<El>) -> El {
    let Some(v) = s.pages.settings.as_ref() else {
        return page(k, "settings", "Settings", el(), loading(k));
    };
    let b = |key: &str| v[key].as_bool().unwrap_or(false);
    let theme_idx = match s.theme {
        Theme::System => 0,
        Theme::Light => 1,
        Theme::Dark => 2,
    };
    let local = card(k, "set-local", "THIS APP")
        .child(setting_row(
            k,
            "Theme",
            "Follows the system unless forced.",
            SegmentedControl::new(&["System", "Light", "Dark"], Some(theme_idx))
                .fit()
                .on_pick(|s: &mut Hooked, i, _| {
                    s.theme = [Theme::System, Theme::Light, Theme::Dark][i];
                    let t = s.theme;
                    s.save_pref("theme", &t);
                })
                .build(k)
                .key("set-theme"),
        ))
        .child(setting_row(
            k,
            "Notifications",
            "A system notification when a session starts waiting on you, while the window is in the background.",
            toggle(k, s.notify, "set-notify", |s| {
                s.notify = !s.notify;
                let n = s.notify;
                s.save_pref("notify", &n);
            }),
        ));

    let efforts: Vec<String> = s.caps.efforts.clone();
    let cur_effort = v["defaultEffort"].as_str().unwrap_or("").to_string();
    let effort = Select::new("set-effort", &efforts)
        .current(Some(&cur_effort))
        .width(160.0)
        .open(s.popup == Some(Popup::NewEffort))
        .on_toggle(|s: &mut Hooked| {
            s.popup = if s.popup == Some(Popup::NewEffort) {
                None
            } else {
                Some(Popup::NewEffort)
            }
        })
        .on_close(|s: &mut Hooked| s.popup = None)
        .on_choose(|s: &mut Hooked, v: &str, _| {
            s.popup = None;
            s.save_setting("defaultEffort", json!(v));
        })
        .build(k, layer);
    let modes: Vec<&str> = fmt::LAUNCH_MODES
        .iter()
        .map(|m| fmt::mode_label(m))
        .collect();
    let cur_mode = fmt::mode_label(v["defaultMode"].as_str().unwrap_or("default"));
    let mode = Select::new("set-mode", &modes)
        .current(Some(cur_mode))
        .width(180.0)
        .open(s.popup == Some(Popup::NewMode))
        .on_toggle(|s: &mut Hooked| {
            s.popup = if s.popup == Some(Popup::NewMode) {
                None
            } else {
                Some(Popup::NewMode)
            }
        })
        .on_close(|s: &mut Hooked| s.popup = None)
        .on_choose(|s: &mut Hooked, v: &str, _| {
            s.popup = None;
            if let Some(m) = fmt::LAUNCH_MODES.iter().find(|m| fmt::mode_label(m) == v) {
                s.save_setting("defaultMode", json!(m));
            }
        })
        .build(k, layer);
    let project = s.pages.settings_project.as_ref().map(|p| {
        TextInput::new(p)
            .width(Some(320.0))
            .placeholder("/path/to/project")
            .on_edit(|s: &mut Hooked| s.pages.settings_project.as_mut().unwrap())
            .on_submit(|s: &mut Hooked, _| {
                let p = s
                    .pages
                    .settings_project
                    .as_ref()
                    .map(|p| p.text.trim().to_string())
                    .unwrap_or_default();
                s.save_setting("quickLaunchProject", json!(p));
                s.flash("✓ Saved", false);
            })
            .build(k)
            .key("set-project")
    });
    let sessions = card(k, "set-sessions", "NEW SESSIONS")
        .child(setting_row(
            k,
            "Default effort",
            "Used when a session is launched without one.",
            effort,
        ))
        .child(setting_row(
            k,
            "Default permission mode",
            "Also the mode a Resume runs in.",
            mode,
        ))
        .child(setting_row(
            k,
            "Default project",
            "Pre-filled in New session. Enter to save.",
            project.unwrap_or_else(el),
        ));

    let digest = &v["digest"];
    let ac = &v["autoCompact"];
    let ac_on = ac["enabled"].as_bool().unwrap_or(false);
    let server = card(k, "set-server", "HOOKED SERVICE")
        .child(setting_row(
            k,
            "Daily digest",
            &format!("Writes yesterday's summary every morning at {}:00.", digest["hour"].as_i64().unwrap_or(7)),
            toggle(k, digest["auto"].as_bool().unwrap_or(false), "set-digest", |s| {
                let on = s.pages.settings.as_ref().and_then(|v| v["digest"]["auto"].as_bool()).unwrap_or(false);
                s.save_nested("digest", "auto", json!(!on));
            }),
        ))
        .child(setting_row(
            k,
            "Auto-compact",
            &format!(
                "Runs /compact on a session waiting for you just before its prompt cache expires (only above {}k tokens). Lossy: earlier turns become a summary.",
                ac["minContextK"].as_i64().unwrap_or(100)
            ),
            toggle(k, ac_on, "set-compact", move |s| s.save_nested("autoCompact", "enabled", json!(!ac_on))),
        ))
        .child(setting_row(
            k,
            "Auto tags",
            "Tag sessions from their content.",
            toggle(k, b("autoTags"), "set-autotags", |s| {
                let on = s.pages.settings.as_ref().and_then(|v| v["autoTags"].as_bool()).unwrap_or(false);
                s.save_setting("autoTags", json!(!on));
            }),
        ))
        .child(setting_row(
            k,
            "PR review tags",
            "Tag a session whose pull request got approved or changes requested.",
            toggle(k, b("autoPrReviewTag"), "set-prtags", |s| {
                let on = s.pages.settings.as_ref().and_then(|v| v["autoPrReviewTag"].as_bool()).unwrap_or(false);
                s.save_setting("autoPrReviewTag", json!(!on));
            }),
        ))
        .child(setting_row(
            k,
            "Auto git sync",
            "Keep hooked's own checkout up to date with its remote.",
            toggle(k, b("autoGitSync"), "set-gitsync", |s| {
                let on = s.pages.settings.as_ref().and_then(|v| v["autoGitSync"].as_bool()).unwrap_or(false);
                s.save_setting("autoGitSync", json!(!on));
            }),
        ));
    let more = row().child(
        Button::new("All settings in the web dashboard")
            .icon(&icons::LINK)
            .variant(ButtonVariant::GhostMuted)
            .on_press_tx(|_: &mut Hooked, tx| {
                let _ = tx.open_url(&format!("{}/settings", crate::api::base()));
            })
            .build(k)
            .key("set-web"),
    );
    let body = col()
        .key("set-inner")
        .w_full()
        .max_w(820.0)
        .self_center()
        .padding(24.0)
        .gap(18.0)
        .child(local)
        .child(sessions)
        .child(server)
        .child(more);
    page(k, "settings", "Settings", el(), scroll("set-scroll", body))
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
        .map(|(key, label)| format!("{label} · {}", v[*key].as_array().map_or(0, Vec::len)))
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
        .child(row().pb(10.0).child(tabs));
    let items = v[key].as_array().cloned().unwrap_or_default();
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
        let decision = match x["decision"].as_str().unwrap_or("") {
            "APPROVED" => Some(("Approved", k.c.success.fg)),
            "CHANGES_REQUESTED" => Some(("Changes requested", k.c.danger.fg)),
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
    let mut groups: Vec<(String, Vec<&Value>)> = Vec::new();
    for x in list {
        let src = x["source"].as_str().unwrap_or("other").to_string();
        match groups.iter_mut().find(|g| g.0 == src) {
            Some(g) => g.1.push(x),
            None => groups.push((src, vec![x])),
        }
    }
    let mut left = col().key("skills-list").w_full().padding(10.0).gap(2.0);
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
                        )),
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
