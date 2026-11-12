use rune::{Color, El, LineCap, ScrollSpec, Shape, canvas, col, el, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, SegmentedControl};
use serde_json::Value;

use super::pill;
use crate::app::Hooked;
use crate::fmt;
use crate::querywin::{QueryWin, REFRESH};

const W: f32 = 660.0;
const H: f32 = 220.0;
const LIGHT: [&str; 8] = [
    "#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948",
];
const DARK: [&str; 8] = [
    "#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767",
];

fn compact(v: f64) -> String {
    let a = v.abs();
    if !v.is_finite() {
        "–".into()
    } else if a >= 1e9 {
        format!("{:.2}G", v / 1e9)
    } else if a >= 1e6 {
        format!("{:.2}M", v / 1e6)
    } else if a >= 1e3 {
        format!("{:.2}k", v / 1e3)
    } else if a >= 10.0 || a == 0.0 {
        format!("{v:.0}")
    } else {
        format!("{v:.3}")
    }
}

fn series_color(palette: [&str; 8], i: usize) -> Color {
    rune::color::hex(palette.get(i).copied().unwrap_or("#8a8a99")).unwrap_or(Color::WHITE)
}

fn hhmm(ms: f64) -> String {
    crate::cron::stamp(ms as i64)
        .rsplit(' ')
        .next()
        .unwrap_or("")
        .to_string()
}

struct Series {
    label: String,
    points: Vec<(f64, f64)>,
    last: f64,
    max: f64,
    mean: f64,
}

fn series(data: &Value) -> Vec<Series> {
    let mut out: Vec<Series> = data["series"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| {
            let points: Vec<(f64, f64)> = s["points"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|p| Some((p[0].as_f64()?, p[1].as_f64()?)))
                .filter(|(_, v)| v.is_finite())
                .collect();
            let vals: Vec<f64> = points.iter().map(|p| p.1).collect();
            let max = vals.iter().copied().fold(f64::NAN, f64::max);
            let mean = if vals.is_empty() {
                f64::NAN
            } else {
                vals.iter().sum::<f64>() / vals.len() as f64
            };
            Series {
                label: s["label"].as_str().unwrap_or("").to_string(),
                last: vals.last().copied().unwrap_or(f64::NAN),
                max,
                mean,
                points,
            }
        })
        .collect();
    out.sort_by(|a, b| {
        b.max
            .partial_cmp(&a.max)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

fn chart(k: &Kit, list: &[Series]) -> El {
    let (mut t0, mut t1, mut lo, mut hi) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for p in list.iter().flat_map(|s| &s.points) {
        t0 = t0.min(p.0);
        t1 = t1.max(p.0);
        lo = lo.min(p.1);
        hi = hi.max(p.1);
    }
    if t0 >= t1 || !lo.is_finite() {
        return text("No data points in this range.")
            .font(k.ty.text_small)
            .color(k.c.text_faint);
    }
    if lo > 0.0 && lo < hi * 0.5 {
        lo = 0.0;
    }
    if hi <= lo {
        hi = lo + 1.0;
    }
    let palette = if k.dark { DARK } else { LIGHT };
    let mut shape = Shape::new();
    for i in 0..=3 {
        let y = H * i as f32 / 3.0;
        shape = shape.line([0.0, y], [W, y], 1.0, LineCap::Butt, k.c.border_weak);
    }
    for (i, se) in list.iter().enumerate().rev() {
        let color = series_color(palette, i);
        let pts: Vec<[f32; 2]> = se
            .points
            .iter()
            .map(|(t, v)| {
                let x = ((t - t0) / (t1 - t0)) as f32 * W;
                let y = H - ((v - lo) / (hi - lo)) as f32 * (H - 4.0) - 2.0;
                [x, y]
            })
            .collect();
        shape = shape.stroke(pts, 1.6, color);
    }
    let plot = canvas(shape).size(W, H);
    let axis = |v: f64| {
        text(compact(v))
            .font(k.ty.text_xsmall)
            .color(k.c.text_faint)
    };
    col()
        .gap(2.0)
        .child(
            row()
                .gap(6.0)
                .child(
                    col()
                        .w(44.0)
                        .h(H)
                        .items_end()
                        .child(axis(hi))
                        .child(el().grow(1.0))
                        .child(axis((hi + lo) / 2.0))
                        .child(el().grow(1.0))
                        .child(axis(lo)),
                )
                .child(plot),
        )
        .child(
            row()
                .pl(50.0)
                .w(W + 50.0)
                .child(text(hhmm(t0)).font(k.ty.text_xsmall).color(k.c.text_faint))
                .child(el().grow(1.0))
                .child(text(hhmm(t1)).font(k.ty.text_xsmall).color(k.c.text_faint)),
        )
}

fn body(w: &QueryWin, k: &Kit) -> El {
    if w.login {
        return col()
            .gap(10.0)
            .padding(16.0)
            .child(
                text(
                    "hooked isn't connected to mcp-gateway yet, so it can't run the query itself.",
                )
                .font(k.ty.text_small)
                .color(k.c.text_muted)
                .wrap(),
            )
            .child(
                row().child(
                    Button::new(if w.login_polled > 0 {
                        "Waiting for the sign-in…"
                    } else {
                        "Sign in to mcp-gateway"
                    })
                    .variant(ButtonVariant::Contrast)
                    .on_press(|s: &mut Hooked| s.query_login())
                    .build(k),
                ),
            );
    }
    if let Some(e) = w.err.as_ref() {
        return text(e.clone())
            .font(k.ty.text_small)
            .color(k.c.danger.fg)
            .wrap()
            .padding(16.0);
    }
    let Some(d) = w.data.as_ref() else {
        return text("Loading…")
            .font(k.ty.text_small)
            .color(k.c.text_faint)
            .padding(16.0);
    };
    let mut c = col().w_full().gap(8.0).padding(12.0);
    match d["kind"].as_str().unwrap_or("") {
        "series" => {
            let list = series(d);
            let palette = if k.dark { DARK } else { LIGHT };
            c = c.child(chart(k, &list));
            let mut legend = col().w_full().gap(2.0).child(
                row().w_full().gap(8.0).child(el().grow(1.0)).children(
                    ["last", "max", "mean"].map(|h| {
                        text(h)
                            .font(k.ty.text_xsmall_medium)
                            .color(k.c.text_faint)
                            .w(64.0)
                    }),
                ),
            );
            for (i, se) in list.iter().enumerate().take(30) {
                let color = series_color(palette, i);
                legend = legend.child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .center_y()
                        .child(el().size(10.0, 3.0).radius(1.5).fill(color))
                        .child(
                            text(se.label.clone())
                                .font(k.ty.text_xsmall)
                                .color(k.c.text_base)
                                .truncate()
                                .grow(1.0)
                                .min_w(0.0),
                        )
                        .children([se.last, se.max, se.mean].map(|v| {
                            text(compact(v))
                                .font(k.ty.mono)
                                .color(k.c.text_muted)
                                .w(64.0)
                        })),
                );
            }
            c = c.child(legend);
        }
        "table" => {
            for r in d["rows"].as_array().into_iter().flatten().take(200) {
                c = c.child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .child(
                            text(r["label"].as_str().unwrap_or("").to_string())
                                .font(k.ty.text_small)
                                .color(k.c.text_base)
                                .truncate()
                                .grow(1.0)
                                .min_w(0.0),
                        )
                        .child(
                            text(compact(r["value"].as_f64().unwrap_or(f64::NAN)))
                                .font(k.ty.mono)
                                .color(k.c.text_muted),
                        ),
                );
            }
        }
        "logs" => {
            c = c.child(
                text(format!("{} lines", d["total"].as_u64().unwrap_or(0)))
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_faint),
            );
            for l in d["lines"].as_array().into_iter().flatten().take(500) {
                let level = l["level"].as_str().unwrap_or("");
                let (fg, bg) = match level {
                    "error" | "fatal" | "critical" => (k.c.danger.fg, k.c.danger.bg),
                    "warn" | "warning" => (k.c.warning.fg, k.c.warning.bg),
                    _ => (k.c.text_muted, k.c.layer_02),
                };
                let mut line = row().w_full().gap(6.0).items_start().child(
                    text(hhmm(l["t"].as_f64().unwrap_or(0.0)))
                        .font(k.ty.mono)
                        .color(k.c.text_faint),
                );
                if !level.is_empty() {
                    line = line.child(pill(k, level.to_string(), fg, bg));
                }
                c = c.child(
                    line.child(
                        text(l["line"].as_str().unwrap_or("").to_string())
                            .font(k.ty.mono)
                            .color(k.c.text_base)
                            .wrap_anywhere()
                            .grow(1.0)
                            .min_w(0.0)
                            .selectable(true),
                    ),
                );
            }
        }
        _ => {
            c = c.child(
                text(d["error"].as_str().unwrap_or("No result").to_string())
                    .font(k.ty.text_small)
                    .color(k.c.danger.fg),
            );
        }
    }
    c
}

pub fn view(s: &Hooked, w: &QueryWin, k: &Kit) -> El {
    let spec = w.spec.clone().unwrap_or_default();
    let title = spec["title"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "{} · {}",
                spec["tool"].as_str().unwrap_or("query"),
                fmt::first_line(spec["query"].as_str().unwrap_or(""), 80)
            )
        });
    let labels: Vec<&str> = REFRESH.iter().map(|r| r.1).collect();
    let at = REFRESH.iter().position(|r| r.0 == w.refresh).unwrap_or(0);
    let status = match w.updated {
        Some(t) => format!(
            "live · updated {} ago",
            fmt::ago_short(Some(&ms_to_iso(t)), s.now)
        ),
        None if w.data.is_some() => "Claude's result".to_string(),
        None => String::new(),
    };
    let head = row()
        .w_full()
        .h(40.0)
        .px(12.0)
        .gap(8.0)
        .center_y()
        .border_sides([0.0, 0.0, 1.0, 0.0], k.c.border_weak)
        .child(
            text(title)
                .font(k.ty.ui_medium)
                .color(k.c.text_base)
                .truncate()
                .grow(1.0)
                .min_w(0.0),
        )
        .child(text(status).font(k.ty.text_xsmall).color(k.c.text_faint))
        .child(
            SegmentedControl::new(&labels, Some(at))
                .label("Refresh every")
                .fit()
                .on_pick(|s: &mut Hooked, i, _| {
                    if let Some(w) = s.query_win.as_mut() {
                        w.refresh = REFRESH[i].0;
                    }
                })
                .build(k),
        )
        .child(
            Button::new(if w.loading { "Running…" } else { "Run" })
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .disabled(w.loading || w.spec.is_none())
                .on_press(|s: &mut Hooked| s.run_query())
                .build(k),
        )
        .child(
            Button::new("Close")
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .on_press(|s: &mut Hooked| s.query_win = None)
                .build(k),
        );
    super::floating(
        s,
        k,
        "query-win",
        head,
        col()
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .child(body(w, k)),
    )
}

fn ms_to_iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let date = fmt::shift_date("1970-01-01", days).unwrap_or_default();
    let rem = secs.rem_euclid(86_400);
    format!(
        "{date}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}
