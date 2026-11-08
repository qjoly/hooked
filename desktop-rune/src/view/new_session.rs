use rune::{El, col, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, Select, TextArea, TextInput};

use super::section_title;
use crate::app::{Hooked, Popup};
use crate::{fmt, icons};

pub fn view(s: &Hooked, k: &Kit, layer: &mut Vec<El>) -> El {
    let projects = s.projects();
    let picks = row()
        .key("new-recent")
        .w_full()
        .gap(6.0)
        .flex_wrap()
        .children(projects.iter().take(10).map(|p| {
            let path = p.clone();
            let name = p.rsplit('/').next().unwrap_or(p).to_string();
            Button::new(name)
                .variant(if s.new_project.text == *p {
                    ButtonVariant::Neutral
                } else {
                    ButtonVariant::GhostMuted
                })
                .control_size(ControlSize::Small)
                .help(p.clone())
                .on_press(move |s: &mut Hooked| s.new_project = rune::TextEdit::new(path.clone()))
                .build(k)
                .key(format!("new-proj-{p}"))
        }));

    let model_ids: Vec<String> = std::iter::once("default".to_string())
        .chain(s.caps.models.iter().map(|(id, _)| id.clone()))
        .collect();
    let model_labels: Vec<String> = std::iter::once("Default model".to_string())
        .chain(s.caps.models.iter().map(|(_, l)| l.clone()))
        .collect();
    let cur_model = s
        .new_model
        .as_ref()
        .and_then(|m| model_ids.iter().position(|x| x == m))
        .map(|i| model_labels[i].clone())
        .unwrap_or_else(|| model_labels[0].clone());
    let model = Select::new("new-model", &model_labels)
        .current(Some(&cur_model))
        .label("Model")
        .width(220.0)
        .open(s.popup == Some(Popup::NewModel))
        .on_toggle(|s: &mut Hooked| {
            s.popup = if s.popup == Some(Popup::NewModel) {
                None
            } else {
                Some(Popup::NewModel)
            }
        })
        .on_close(|s: &mut Hooked| s.popup = None)
        .on_choose(move |s: &mut Hooked, v: &str, _| {
            let ids: Vec<String> = std::iter::once("default".to_string())
                .chain(s.caps.models.iter().map(|(id, _)| id.clone()))
                .collect();
            let labels: Vec<String> = std::iter::once("Default model".to_string())
                .chain(s.caps.models.iter().map(|(_, l)| l.clone()))
                .collect();
            s.new_model = labels
                .iter()
                .position(|l| l == v)
                .and_then(|i| (i > 0).then(|| ids[i].clone()));
            s.popup = None;
        })
        .build(k, layer);

    let efforts: Vec<String> = std::iter::once("default".to_string())
        .chain(s.caps.efforts.iter().cloned())
        .collect();
    let cur_effort = s.new_effort.clone().unwrap_or_else(|| "default".into());
    let effort = Select::new("new-effort", &efforts)
        .current(Some(&cur_effort))
        .label("Effort")
        .width(140.0)
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
            s.new_effort = (v != "default").then(|| v.to_string());
            s.popup = None;
        })
        .build(k, layer);

    let mode_labels: Vec<&str> = fmt::LAUNCH_MODES
        .iter()
        .map(|m| fmt::mode_label(m))
        .collect();
    let mode = Select::new("new-mode", &mode_labels)
        .current(Some(fmt::mode_label(&s.new_mode)))
        .label("Permission mode")
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
            if let Some(m) = fmt::LAUNCH_MODES.iter().find(|m| fmt::mode_label(m) == v) {
                s.new_mode = (*m).to_string();
            }
            s.popup = None;
        })
        .build(k, layer);

    let form = col()
        .key("new-form")
        .w_full()
        .max_w(760.0)
        .self_center()
        .padding(28.0)
        .gap(18.0)
        .child(
            text("New session")
                .font(k.ty.body_medium)
                .color(k.c.text_base),
        )
        .child(
            col()
                .w_full()
                .gap(8.0)
                .child(section_title(k, "PROJECT"))
                .child(
                    TextInput::new(&s.new_project)
                        .placeholder("/path/to/project")
                        .leading_icon(&icons::FOLDER)
                        .width(None)
                        .on_edit(|s: &mut Hooked| &mut s.new_project)
                        .build(k)
                        .key("new-project"),
                )
                .child(picks),
        )
        .child(
            col()
                .w_full()
                .gap(8.0)
                .child(section_title(k, "PROMPT"))
                .child(
                    TextArea::new(&s.new_prompt)
                        .placeholder("What should Claude do? (⌘Enter to launch)")
                        .auto_grow(4, 16)
                        .width(None)
                        .on_edit(|s: &mut Hooked| &mut s.new_prompt)
                        .on_key(|s: &mut Hooked, ev: &rune::KeyEvent, _| {
                            if ev.key == rune::Key::Enter && ev.mods.cmd {
                                s.launch();
                                return true;
                            }
                            false
                        })
                        .build(k)
                        .key("new-prompt"),
                ),
        )
        .child(
            row()
                .w_full()
                .gap(12.0)
                .flex_wrap()
                .child(model)
                .child(effort)
                .child(mode),
        )
        .child(
            row()
                .w_full()
                .gap(8.0)
                .justify_end()
                .child(
                    Button::new("Cancel")
                        .variant(ButtonVariant::GhostMuted)
                        .on_press(|s: &mut Hooked| s.go_deck())
                        .build(k)
                        .key("new-cancel"),
                )
                .child(
                    Button::new(if s.sending { "Launching…" } else { "Launch" })
                        .icon(&icons::PLAY)
                        .variant(ButtonVariant::Contrast)
                        .shortcut("⌘↵")
                        .disabled(s.sending)
                        .on_press(|s: &mut Hooked| s.launch())
                        .build(k)
                        .key("new-launch"),
                ),
        );
    col()
        .key("new-page")
        .w_full()
        .h_full()
        .scroll(rune::ScrollSpec {
            stick_bottom: false,
        })
        .child(form)
}
