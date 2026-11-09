use rune::{Color, Cursor, El, col, el, row, text};
use rune_kit::{
    Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant, Kit, Switch, TextInput,
};
use serde_json::{Value, json};

use super::pages::{loading, page, scroll};
use super::section_title;
use crate::app::{Hooked, Theme};
use crate::{fmt, icons};

const NAV: [(&str, &str); 8] = [
    ("sessions", "Sessions"),
    ("stats", "Stats"),
    ("digest", "Digest"),
    ("memory", "Memory"),
    ("github", "GitHub"),
    ("skills", "Skills"),
    ("cron", "Cron"),
    ("prompts", "Prompts"),
];
const EDITORS: [(&str, &str); 6] = [
    ("vscode", "VS Code"),
    ("zed", "Zed"),
    ("cursor", "Cursor"),
    ("windsurf", "Windsurf"),
    ("sublime", "Sublime Text"),
    ("jetbrains", "JetBrains"),
];
const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MENU: [(&str, &str); 2] = [
    ("modelEffort", "Model and effort"),
    ("permissionMode", "Permission mode"),
];

fn card(k: &Kit, key: &str, title: &str) -> El {
    col()
        .key(key.to_string())
        .w_full()
        .padding(16.0)
        .gap(2.0)
        .radius(k.radius.lg)
        .fill(k.c.layer_01)
        .border(1.0, k.c.border_weak)
        .child(row().pb(6.0).child(section_title(k, title)))
}

fn line(k: &Kit, title: &str, hint: &str, control: El) -> El {
    row()
        .w_full()
        .py(10.0)
        .gap(16.0)
        .center_y()
        .border_sides([1.0, 0.0, 0.0, 0.0], k.c.border_weak)
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
                .children((!hint.is_empty()).then(|| {
                    text(hint.to_string())
                        .font(k.ty.text_small)
                        .color(k.c.text_faint)
                        .wrap()
                })),
        )
        .child(control.shrink())
}

/// A stacked setting: the controls get a full-width row under the title.
fn block(k: &Kit, title: &str, hint: &str, control: El) -> El {
    col()
        .w_full()
        .py(10.0)
        .gap(8.0)
        .border_sides([1.0, 0.0, 0.0, 0.0], k.c.border_weak)
        .child(
            text(title.to_string())
                .font(k.ty.ui_medium)
                .color(k.c.text_base),
        )
        .children((!hint.is_empty()).then(|| {
            text(hint.to_string())
                .font(k.ty.text_small)
                .color(k.c.text_faint)
                .wrap()
        }))
        .child(control.w_full())
}

pub(super) fn chip(
    k: &Kit,
    key: String,
    label: String,
    on: bool,
    f: impl Fn(&mut Hooked) + 'static,
) -> El {
    k.interactive(
        row()
            .key(key)
            .role("checkbox")
            .checked(on)
            .h(26.0)
            .px(10.0)
            .center_y()
            .radius(k.radius.sm)
            .cursor(Cursor::Pointer)
            .fill(if on { k.c.layer_02 } else { Color::TRANSPARENT })
            .border(
                1.0,
                if on {
                    k.c.border_focus
                } else {
                    k.c.border_weak
                },
            )
            .child(text(label).font(k.ty.text_small_medium).color(if on {
                k.c.text_base
            } else {
                k.c.text_muted
            })),
    )
    .on_press(f)
}

pub(super) fn chips(items: Vec<El>) -> El {
    row().gap(6.0).flex_wrap().children(items)
}

fn toggle(k: &Kit, key: &'static str, on: bool, f: impl Fn(&mut Hooked) + 'static) -> El {
    Switch::new(on)
        .hide_label()
        .label(key)
        .on_toggle(f)
        .build(k)
        .key(key)
}

fn stepper(
    k: &Kit,
    key: &'static str,
    value: String,
    minus: impl Fn(&mut Hooked) + 'static,
    plus: impl Fn(&mut Hooked) + 'static,
) -> El {
    let b = |icon: &'static rune::Icon, label: &str, f: Box<dyn Fn(&mut Hooked)>| {
        IconButton::new(icon)
            .variant(IconButtonVariant::GhostMuted)
            .control_size(ControlSize::Small)
            .label(label.to_string())
            .on_press(move |s: &mut Hooked| f(s))
            .build(k)
    };
    row()
        .key(key)
        .gap(4.0)
        .center_y()
        .child(b(&icons::MINUS, "Less", Box::new(minus)))
        .child(
            row()
                .w(64.0)
                .justify_center()
                .child(text(value).font(k.ty.ui_medium).color(k.c.text_base)),
        )
        .child(b(&icons::PLUS, "More", Box::new(plus)))
}

fn flag(v: &Value, key: &str) -> bool {
    v[key].as_bool().unwrap_or(false)
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str().map(str::to_string))
        .collect()
}

fn app_card(s: &Hooked, k: &Kit, v: &Value) -> El {
    let theme = |t: Theme, label: &str| {
        chip(
            k,
            format!("theme-{label}"),
            label.to_string(),
            s.theme == t,
            move |s: &mut Hooked| {
                s.theme = t;
                s.save_pref("theme", &t);
            },
        )
    };
    let nav_on = strs(&v["navTabs"]);
    let home = v["defaultPage"].as_str().unwrap_or("deck").to_string();
    let review_split = s.lens_data.diff.mode() == rune_kit::diff::DiffMode::Split;
    card(k, "set-app", "THIS APP")
        .child(line(k, "Theme", "Follows the system unless forced.", chips(vec![theme(Theme::System, "System"), theme(Theme::Light, "Light"), theme(Theme::Dark, "Dark")])))
        .child(line(
            k,
            "Notifications",
            "A system notification when a session starts waiting on you, while the window is in the background.",
            toggle(k, "set-notify", s.notify, |s| {
                s.notify = !s.notify;
                let n = s.notify;
                s.save_pref("notify", &n);
            }),
        ))
        .child(block(
            k,
            "Navigation",
            "Which pages get a tab in the top bar. The others stay one search away (⌘K).",
            chips(NAV.iter().map(|&(key, label)| chip(k, format!("nav-{key}"), label.into(), nav_on.iter().any(|x| x == key), move |s| s.toggle_in_list("navTabs", key))).collect()),
        ))
        .child(block(
            k,
            "Default page",
            "Where the app opens.",
            chips(
                std::iter::once(("deck", "Deck"))
                    .chain(NAV.iter().copied().filter(|(key, _)| *key != "sessions"))
                    .map(|(key, label)| chip(k, format!("home-{key}"), label.into(), home == key, move |s| s.save_setting("defaultPage", json!(key))))
                    .collect(),
            ),
        ))
        .child(line(
            k,
            "Review layout",
            "How the Review lens shows a diff by default.",
            chips(vec![
                chip(k, "rv-unified".into(), "Unified".into(), !review_split, |s| {
                    s.lens_data.diff.set_mode(rune_kit::diff::DiffMode::Unified);
                    s.save_pref("diffSplit", &false);
                }),
                chip(k, "rv-split".into(), "Side by side".into(), review_split, |s| {
                    s.lens_data.diff.set_mode(rune_kit::diff::DiffMode::Split);
                    s.save_pref("diffSplit", &true);
                }),
            ]),
        ))
}

fn sessions_card(s: &Hooked, k: &Kit, v: &Value) -> El {
    let hidden = strs(&v["hiddenModels"]);
    let model = v["defaultModel"].as_str().unwrap_or("").to_string();
    let effort = v["defaultEffort"].as_str().unwrap_or("").to_string();
    let mode = v["defaultMode"].as_str().unwrap_or("default").to_string();
    let models = std::iter::once(chip(
        k,
        "dm-default".into(),
        "Claude's default".into(),
        model.is_empty(),
        |s| s.save_setting("defaultModel", json!("")),
    ))
    .chain(
        s.caps
            .models
            .iter()
            .filter(|(id, _)| !hidden.contains(id))
            .map(|(id, label)| {
                let id2 = id.clone();
                chip(
                    k,
                    format!("dm-{id}"),
                    label.clone(),
                    &model == id,
                    move |s| s.save_setting("defaultModel", json!(id2)),
                )
            }),
    )
    .collect();
    let efforts = s
        .caps
        .efforts
        .iter()
        .map(|e| {
            let e2 = e.clone();
            chip(k, format!("de-{e}"), e.clone(), &effort == e, move |s| {
                s.save_setting("defaultEffort", json!(e2))
            })
        })
        .collect();
    let modes = fmt::LAUNCH_MODES
        .iter()
        .map(|&m| {
            chip(
                k,
                format!("dmode-{m}"),
                fmt::mode_label(m).into(),
                mode == m,
                move |s| s.save_setting("defaultMode", json!(m)),
            )
        })
        .collect();
    let visible = s
        .caps
        .models
        .iter()
        .map(|(id, label)| {
            let id2 = id.clone();
            chip(
                k,
                format!("vm-{id}"),
                label.clone(),
                !hidden.contains(id),
                move |s| s.toggle_in_list("hiddenModels", &id2),
            )
        })
        .collect();
    let project = s.pages.settings_project.as_ref().map_or_else(el, |p| {
        TextInput::new(p)
            .width(Some(360.0))
            .placeholder("/path/to/project")
            .on_edit(|s: &mut Hooked| s.pages.settings_project.as_mut().expect("loaded"))
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
    card(k, "set-sessions", "NEW SESSIONS")
        .child(block(
            k,
            "Default model",
            "Used when a session is launched without one.",
            chips(models),
        ))
        .child(block(k, "Default effort", "", chips(efforts)))
        .child(block(
            k,
            "Default permission mode",
            "Also the mode a Resume runs in.",
            chips(modes),
        ))
        .child(line(
            k,
            "Default project",
            "Pre-filled in New session. Enter to save.",
            project,
        ))
        .child(block(
            k,
            "Visible models",
            "Which models the pickers offer. The list comes from your installed claude.",
            chips(visible),
        ))
        .child(line(
            k,
            "Show your work",
            "Ask Claude to narrate its steps between tool calls.",
            toggle(k, "set-showwork", flag(v, "showWork"), |s| {
                let on = s.setting("showWork").as_bool().unwrap_or(false);
                s.save_setting("showWork", json!(!on));
            }),
        ))
}

fn sidebar_card(k: &Kit, v: &Value) -> El {
    let sc = &v["sidebarCache"];
    let display = sc["display"].as_str().unwrap_or("badge").to_string();
    let window = sc["windowMin"].as_i64().unwrap_or(15);
    let editor = v["editor"].as_str().unwrap_or("vscode").to_string();
    let menu = &v["statusBar"];
    card(k, "set-display", "SIDEBAR AND SESSION")
        .child(line(
            k,
            "Prompt cache countdown",
            "Beside each row's age, or instead of it.",
            chips(vec![
                chip(
                    k,
                    "pc-badge".into(),
                    "Beside".into(),
                    display != "replace",
                    |s| s.save_nested("sidebarCache", "display", json!("badge")),
                ),
                chip(
                    k,
                    "pc-replace".into(),
                    "Instead".into(),
                    display == "replace",
                    |s| s.save_nested("sidebarCache", "display", json!("replace")),
                ),
            ]),
        ))
        .child(line(
            k,
            "Countdown shows",
            "Only once the cache has this little left (0 = always).",
            stepper(
                k,
                "pc-window",
                if window == 0 {
                    "always".into()
                } else {
                    format!("{window} min")
                },
                move |s| s.save_nested("sidebarCache", "windowMin", json!((window - 5).max(0))),
                move |s| s.save_nested("sidebarCache", "windowMin", json!((window + 5).min(60))),
            ),
        ))
        .child(block(
            k,
            "Code editor",
            "Used by Open in editor.",
            chips(
                EDITORS
                    .iter()
                    .map(|&(key, label)| {
                        chip(
                            k,
                            format!("ed-{key}"),
                            label.into(),
                            editor == key,
                            move |s| s.save_setting("editor", json!(key)),
                        )
                    })
                    .collect(),
            ),
        ))
        .child(block(
            k,
            "Session menu",
            "Controls the session header's ⋯ menu shows.",
            chips(
                MENU.iter()
                    .map(|&(key, label)| {
                        let on = menu[key].as_bool().unwrap_or(true);
                        chip(k, format!("sb-{key}"), label.into(), on, move |s| {
                            s.save_nested("statusBar", key, json!(!on))
                        })
                    })
                    .collect(),
            ),
        ))
}

fn service_card(s: &Hooked, k: &Kit, v: &Value) -> El {
    let dg = &v["digest"];
    let hour = dg["hour"].as_i64().unwrap_or(7);
    let ac = &v["autoCompact"];
    let ac_on = flag(ac, "enabled");
    let min_k = ac["minContextK"].as_i64().unwrap_or(100);
    let wu = &v["warmup"];
    let wu_on = flag(wu, "enabled");
    let days: Vec<i64> = wu["days"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_i64)
        .collect();
    let skip = wu["skipIfWeeklyOver"].as_i64().unwrap_or(90);
    let wu_model = wu["model"].as_str().unwrap_or("haiku").to_string();
    let hours = s.pages.hours.as_ref().map_or_else(el, |h| {
        TextInput::new(h)
            .width(Some(320.0))
            .placeholder("09:00-12:00, 14:00-18:00")
            .on_edit(|s: &mut Hooked| s.pages.hours.as_mut().expect("loaded"))
            .on_submit(|s: &mut Hooked, _| s.save_hours())
            .build(k)
            .key("wu-hours")
    });
    card(k, "set-service", "HOOKED SERVICE")
        .child(line(
            k,
            "Daily digest",
            "Writes yesterday's summary every morning.",
            toggle(k, "dg-auto", flag(dg, "auto"), |s| {
                let on = flag(&s.setting("digest").clone(), "auto");
                s.save_nested("digest", "auto", json!(!on));
            }),
        ))
        .child(line(
            k,
            "Digest time",
            "Hour of the day the digest is written.",
            stepper(
                k,
                "dg-hour",
                format!("{hour:02}:00"),
                move |s| s.save_nested("digest", "hour", json!((hour + 23) % 24)),
                move |s| s.save_nested("digest", "hour", json!((hour + 1) % 24)),
            ),
        ))
        .child(line(
            k,
            "Auto-compact",
            "Runs /compact on a session waiting for you just before its prompt cache expires. Lossy: earlier turns become a summary.",
            toggle(k, "ac-on", ac_on, move |s| s.save_nested("autoCompact", "enabled", json!(!ac_on))),
        ))
        .child(line(
            k,
            "Only above",
            "Context size under which a cold resume is cheap anyway.",
            chips(
                [0i64, 50, 100, 200, 400]
                    .into_iter()
                    .map(|n| {
                        chip(k, format!("ac-{n}"), if n == 0 { "any size".into() } else { format!("{n}k") }, min_k == n, move |s| {
                            s.save_nested("autoCompact", "minContextK", json!(n))
                        })
                    })
                    .collect(),
            ),
        ))
        .child(line(
            k,
            "5-hour window",
            &match s.pages.warmup.as_ref().filter(|w| w["decision"].is_object()) {
                Some(w) => {
                    let d = &w["decision"];
                    let now = if d["act"] == true {
                        "ping due".to_string()
                    } else {
                        d["reason"].as_str().unwrap_or("").to_string()
                    };
                    let window = w["fiveHour"]["at"]
                        .as_str()
                        .map(|at| {
                            format!(
                                " · window open until {at} ({}% used)",
                                w["fiveHour"]["pct"].as_f64().unwrap_or(0.0)
                            )
                        })
                        .unwrap_or_default();
                    format!("Keep a usage window open across your working hours with a tiny early ping. Scheduler right now: {now}{window}.")
                }
                None => "Keep a usage window open across your working hours with a tiny early ping.".to_string(),
            },
            row()
                .gap(8.0)
                .center_y()
                .child(
                    Button::new("Run now")
                        .variant(ButtonVariant::GhostMuted)
                        .control_size(ControlSize::Small)
                        .disabled(s.pages.busy.is_some())
                        .help("Send the warm-up ping now")
                        .on_press(|s: &mut Hooked| s.run_warmup())
                        .build(k),
                )
                .child(toggle(k, "wu-on", wu_on, move |s| s.save_nested("warmup", "enabled", json!(!wu_on)))),
        ))
        .child(line(k, "Working hours", "Slots separated by commas. Enter to save.", hours))
        .child(line(
            k,
            "Days",
            "",
            chips(
                DAYS.iter()
                    .enumerate()
                    .map(|(i, d)| {
                        let i = i as i64;
                        let mut next = days.clone();
                        if let Some(p) = next.iter().position(|x| *x == i) {
                            next.remove(p);
                        } else {
                            next.push(i);
                            next.sort();
                        }
                        chip(k, format!("wu-day-{i}"), (*d).into(), days.contains(&i), move |s| s.save_nested("warmup", "days", json!(next)))
                    })
                    .collect(),
            ),
        ))
        .child(line(
            k,
            "Ping model",
            "",
            chips(
                ["haiku", "sonnet"]
                    .into_iter()
                    .map(|m| chip(k, format!("wu-m-{m}"), m.into(), wu_model == m, move |s| s.save_nested("warmup", "model", json!(m))))
                    .collect(),
            ),
        ))
        .child(line(
            k,
            "Skip above",
            "No ping once the weekly limit is used this much.",
            stepper(
                k,
                "wu-skip",
                format!("{skip}%"),
                move |s| s.save_nested("warmup", "skipIfWeeklyOver", json!((skip - 5).max(0))),
                move |s| s.save_nested("warmup", "skipIfWeeklyOver", json!((skip + 5).min(100))),
            ),
        ))
}

fn tags_card(s: &Hooked, k: &Kit, v: &Value) -> El {
    let mut c = card(k, "set-tags", "TAGS")
        .child(line(
            k,
            "Auto tags",
            "Tag new sessions from their content (one Haiku call after the first turn).",
            toggle(k, "set-autotags", flag(v, "autoTags"), |s| {
                let on = s.setting("autoTags").as_bool().unwrap_or(false);
                s.save_setting("autoTags", json!(!on));
            }),
        ))
        .child(line(
            k,
            "PR review tags",
            "Tag a session pr-approved / pr-changes-requested when its pull request gets reviewed.",
            toggle(k, "set-prtags", flag(v, "autoPrReviewTag"), |s| {
                let on = s.setting("autoPrReviewTag").as_bool().unwrap_or(false);
                s.save_setting("autoPrReviewTag", json!(!on));
            }),
        ));
    let mut counts: std::collections::BTreeMap<&str, usize> = Default::default();
    for t in s.tags.values().flatten() {
        *counts.entry(t.as_str()).or_default() += 1;
    }
    for (t, n) in counts {
        let tag = t.to_string();
        let editing = s.pages.tag_edit.as_ref().filter(|(old, _)| old == t);
        let name: El = match editing {
            Some((_, edit)) => TextInput::new(edit)
                .width(Some(220.0))
                .on_edit(|s: &mut Hooked| &mut s.pages.tag_edit.as_mut().expect("editing").1)
                .on_submit(|s: &mut Hooked, _| s.rename_tag())
                .build(k)
                .key(format!("tag-edit-{t}")),
            None => super::tag_pill(s, k, t),
        };
        let (t1, t2, t3) = (tag.clone(), tag.clone(), tag.clone());
        let picking = s.pages.tag_hue_open.as_deref() == Some(t);
        let swatch = k
            .interactive(
                el().key(format!("tag-hue-{t}"))
                    .role("button")
                    .label(format!("Colour of #{t}"))
                    .help("Pick a colour")
                    .size(16.0, 16.0)
                    .radius(k.radius.sm)
                    .cursor(Cursor::Pointer)
                    .fill(s.tag_color(k.dark, t))
                    .border(
                        if picking { 2.0 } else { 1.0 },
                        if picking {
                            k.c.border_focus
                        } else {
                            k.c.border_strong
                        },
                    ),
            )
            .on_press(move |s: &mut Hooked| {
                s.pages.tag_hue_open = if s.pages.tag_hue_open.as_deref() == Some(t3.as_str()) {
                    None
                } else {
                    Some(t3.clone())
                };
            });
        c = c.child(
            row()
                .key(format!("tag-row-{t}"))
                .w_full()
                .py(6.0)
                .gap(10.0)
                .center_y()
                .border_sides([1.0, 0.0, 0.0, 0.0], k.c.border_weak)
                .child(swatch)
                .child(name)
                .child(
                    text(format!("{n} session{}", if n == 1 { "" } else { "s" }))
                        .font(k.ty.text_small)
                        .color(k.c.text_faint),
                )
                .child(el().grow(1.0))
                .child(
                    Button::new("Rename")
                        .variant(ButtonVariant::GhostMuted)
                        .control_size(ControlSize::Small)
                        .on_press(move |s: &mut Hooked| {
                            let mut e = rune::TextEdit::new(t1.clone());
                            e.focused = true;
                            s.pages.tag_edit = Some((t1.clone(), e));
                        })
                        .build(k),
                )
                .child(
                    Button::new("Delete")
                        .variant(ButtonVariant::GhostMuted)
                        .control_size(ControlSize::Small)
                        .on_press(move |s: &mut Hooked| s.delete_tag(&t2))
                        .build(k),
                ),
        );
        if picking {
            c = c.child(hue_picker(s, k, t));
        }
    }
    c
}

fn hue_picker(s: &Hooked, k: &Kit, tag: &str) -> El {
    let picked = s.tag_colors.get(tag).copied();
    let mut strip = row()
        .key(format!("tag-hues-{tag}"))
        .w_full()
        .pl(26.0)
        .pb(8.0)
        .gap(6.0)
        .center_y()
        .flex_wrap();
    for i in 0..crate::theme::TAG_HUE_COUNT {
        let hue = crate::theme::tag_hue(k.dark, i);
        let on = picked == Some(i);
        let t = tag.to_string();
        strip = strip.child(
            k.interactive(
                row()
                    .key(format!("tag-hue-{tag}-{i}"))
                    .role("radio")
                    .checked(on)
                    .label(format!("Hue {}", i + 1))
                    .h(22.0)
                    .px(7.0)
                    .center_y()
                    .radius(k.radius.sm)
                    .cursor(Cursor::Pointer)
                    .fill(hue.alpha(0.14))
                    .border(
                        if on { 2.0 } else { 1.0 },
                        if on { hue } else { hue.alpha(0.35) },
                    )
                    .child(
                        text(format!("#{tag}"))
                            .font(k.ty.text_xsmall_medium)
                            .color(hue),
                    ),
            )
            .on_press(move |s: &mut Hooked| s.set_tag_color(&t, Some(i))),
        );
    }
    let t = tag.to_string();
    strip.child(
        Button::new("Auto")
            .variant(if picked.is_none() {
                ButtonVariant::Outline
            } else {
                ButtonVariant::GhostMuted
            })
            .control_size(ControlSize::Small)
            .help("Back to the colour hooked derives from the name")
            .on_press(move |s: &mut Hooked| s.set_tag_color(&t, None))
            .build(k),
    )
}

fn remote_card(s: &Hooked, k: &Kit, v: &Value) -> El {
    let on = strs(&v["remoteControlProjects"]);
    let mut projects = strs(&v["favoriteProjects"]);
    for p in s.projects().into_iter().chain(on.iter().cloned()) {
        if !projects.contains(&p) {
            projects.push(p);
        }
    }
    let status = |cwd: &str| -> String {
        s.pages
            .rc
            .as_ref()
            .and_then(|r| r["projects"].as_array())
            .and_then(|l| l.iter().find(|p| p["cwd"].as_str() == Some(cwd)))
            .and_then(|p| p["status"].as_str().or(p["state"].as_str()))
            .unwrap_or("")
            .to_string()
    };
    let items = projects
        .iter()
        .take(16)
        .map(|p| {
            let name = p.rsplit('/').next().unwrap_or(p).to_string();
            let st = status(p);
            let label = if on.contains(p) && !st.is_empty() {
                format!("{name} · {st}")
            } else {
                name
            };
            let cwd = p.clone();
            chip(k, format!("rc-{p}"), label, on.contains(p), move |s| {
                s.toggle_in_list("remoteControlProjects", &cwd)
            })
        })
        .collect();
    card(k, "set-rc", "REMOTE CONTROL").child(block(
        k,
        "Projects",
        "hooked keeps a claude remote-control server running for these, so each shows up as an environment in the Claude app.",
        chips(items),
    ))
}

fn maintenance_card(s: &Hooked, k: &Kit, v: &Value) -> El {
    let claude = s.pages.claude.as_ref();
    let installed = claude
        .and_then(|c| c["installed"].as_str())
        .unwrap_or("…")
        .to_string();
    let method = claude
        .and_then(|c| c["install"]["label"].as_str())
        .unwrap_or("")
        .to_string();
    let can_upgrade = claude.is_some_and(|c| !c["install"]["upgrade"].is_null());
    let git = s.pages.git.as_ref();
    let branch = git
        .and_then(|g| g["current"].as_str())
        .unwrap_or("…")
        .to_string();
    let (ahead, behind) = git.map_or((0, 0), |g| {
        (
            g["ahead"].as_i64().unwrap_or(0),
            g["behind"].as_i64().unwrap_or(0),
        )
    });
    let busy = s.pages.busy.is_some();
    card(k, "set-maint", "MAINTENANCE")
        .child(line(
            k,
            "Live state",
            "Recompute every session's state now, to fix one stuck on working after it finished.",
            Button::new("Resync").icon(&icons::RESTART).variant(ButtonVariant::Outline).control_size(ControlSize::Small).disabled(busy).on_press(|s: &mut Hooked| s.resync_states()).build(k).key("set-resync"),
        ))
        .child(line(
            k,
            &format!("Claude Code {installed}"),
            &if method.is_empty() { "Running sessions keep their version until they restart.".to_string() } else { format!("Installed through {method}. Running sessions keep their version until they restart.") },
            Button::new("Upgrade")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .disabled(busy || !can_upgrade)
                .help(if can_upgrade { "Upgrade the claude binary" } else { "This install can't be upgraded from hooked" })
                .on_press(|s: &mut Hooked| s.upgrade_claude())
                .build(k)
                .key("set-upgrade"),
        ))
        .child(line(
            k,
            &format!("hooked on {branch}"),
            &format!("{ahead} ahead, {behind} behind its upstream."),
            Button::new(if s.pages.branches_open { "Close" } else { "Switch branch…" })
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .on_press(|s: &mut Hooked| s.pages.branches_open = !s.pages.branches_open)
                .build(k)
                .key("set-branches"),
        ))
        .child(branches(s, k))
        .child(line(
            k,
            "Auto git sync",
            "Keep hooked's own checkout up to date with its remote.",
            toggle(k, "set-gitsync", flag(v, "autoGitSync"), |s| {
                let on = s.setting("autoGitSync").as_bool().unwrap_or(false);
                s.save_setting("autoGitSync", json!(!on));
            }),
        ))
        .child(line(
            k,
            "Restart after an update",
            "Restart hooked by itself when a sync pulled changes and nothing is running.",
            toggle(k, "set-gitrestart", flag(v, "gitAutoRestartOnLock"), |s| {
                let on = s.setting("gitAutoRestartOnLock").as_bool().unwrap_or(false);
                s.save_setting("gitAutoRestartOnLock", json!(!on));
            }),
        ))
}

pub fn view(s: &Hooked, k: &Kit) -> El {
    let Some(v) = s.pages.settings.as_ref() else {
        return page(k, "settings", "Settings", el(), loading(k));
    };
    let more = Button::new("Open the web settings")
        .icon(&icons::LINK)
        .variant(ButtonVariant::GhostMuted)
        .control_size(ControlSize::Regular)
        .on_press_tx(|_: &mut Hooked, tx| {
            let _ = tx.open_url(&format!("{}/settings", crate::api::base()));
        })
        .build(k)
        .key("set-web");
    let body = col()
        .key("set-inner")
        .w_full()
        .max_w(860.0)
        .self_center()
        .padding(24.0)
        .gap(18.0)
        .child(app_card(s, k, v))
        .child(sessions_card(s, k, v))
        .child(sidebar_card(k, v))
        .child(service_card(s, k, v))
        .child(tags_card(s, k, v))
        .child(remote_card(s, k, v))
        .child(maintenance_card(s, k, v));
    page(k, "settings", "Settings", more, scroll("set-scroll", body))
}

fn branches(s: &Hooked, k: &Kit) -> El {
    if !s.pages.branches_open {
        return el();
    }
    let git = s.pages.git.clone().unwrap_or_default();
    let busy = s.pages.busy.is_some();
    let mut c = col().w_full().gap(8.0).pb(8.0);
    if let Some(b) = s.pages.checkout_dirty.clone() {
        let (b1, b2) = (b.clone(), b.clone());
        c = c.child(
            row()
                .gap(8.0)
                .center_y()
                .child(
                    text("The working tree is dirty: choose how to proceed.")
                        .font(k.ty.text_small)
                        .color(k.c.warning.fg),
                )
                .child(
                    Button::new("Stash & checkout")
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Small)
                        .disabled(busy)
                        .on_press(move |s: &mut Hooked| s.checkout(b1.clone(), "stash"))
                        .build(k),
                )
                .child(
                    Button::new("Force (drop changes)")
                        .variant(ButtonVariant::Danger)
                        .control_size(ControlSize::Small)
                        .disabled(busy)
                        .on_press(move |s: &mut Hooked| s.checkout(b2.clone(), "force"))
                        .build(k),
                ),
        );
    }
    let list: Vec<El> = git["branches"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["locked"] != true)
        .take(40)
        .map(|b| {
            let name = b["name"].as_str().unwrap_or("").to_string();
            let current = b["current"] == true;
            let label = if b["remote"] == true && !current {
                format!("{name} ↓")
            } else {
                name.clone()
            };
            chip(k, format!("br-{name}"), label, current, move |s| {
                if !current {
                    s.checkout(name.clone(), "block");
                }
            })
        })
        .collect();
    c.child(chips(list))
}
