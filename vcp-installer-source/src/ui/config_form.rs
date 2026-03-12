use crate::app::{App, GithubMirror};
use crossterm::event::KeyCode;
use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

#[derive(Debug, Clone, Copy)]
enum ToggleRef {
    NpmMirror,
    PipMirror,
}

#[derive(Debug, Clone, Copy)]
enum FieldType {
    TextInput {
        buffer_index: usize,
        is_password: bool,
    },
    MirrorSelect,
    Toggle {
        value_ref: ToggleRef,
    },
}

#[derive(Debug, Clone, Copy)]
struct FormField {
    label: &'static str,
    field_type: FieldType,
    hint: &'static str,
}

const FIELDS: [FormField; 4] = [
    FormField {
        label: "安装路径",
        field_type: FieldType::TextInput {
            buffer_index: 0,
            is_password: false,
        },
        hint: "VCP 安装目录，建议不要放系统盘根目录",
    },
    FormField {
        label: "GitHub 镜像",
        field_type: FieldType::MirrorSelect,
        hint: "← → 或 空格切换：直连 / ghproxy",
    },
    FormField {
        label: "npm 镜像",
        field_type: FieldType::Toggle {
            value_ref: ToggleRef::NpmMirror,
        },
        hint: "空格切换，国内网络建议开启",
    },
    FormField {
        label: "pip 镜像",
        field_type: FieldType::Toggle {
            value_ref: ToggleRef::PipMirror,
        },
        hint: "空格切换，国内网络建议开启",
    },
];

pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();

    let block = Block::default()
        .title(" 配置表 ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let focused_index = app
        .config_form_cursor
        .min(FIELDS.len().saturating_sub(1));

    let mut lines = Vec::new();

    lines.push(Line::from(vec![Span::styled(
        "  ─── VCP 安装配置 ───",
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
    )]));
    lines.push(Line::from(""));

    for (index, field) in FIELDS.iter().enumerate() {
        let is_focused = index == focused_index;
        let prefix = if is_focused { "▸ " } else { "  " };

        let label_style = if is_focused {
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::White)
        };

        lines.push(Line::from(vec![Span::styled(
            format!("  {}{}", prefix, field.label),
            label_style,
        )]));

        lines.push(render_value_line(app, *field, is_focused));

        if is_focused {
            lines.push(Line::from(vec![Span::styled(
                format!("      💡 {}", field.hint),
                Style::default().fg(Color::DarkGray),
            )]));
        }

        lines.push(Line::from(""));
    }

    lines.push(Line::from(""));
    lines.push(Line::from(vec![Span::styled(
        "  💡 API密钥、管理密码等配置将在安装完成后引导您编辑 config.env",
        Style::default().fg(Color::Yellow),
    )]));

    lines.push(Line::from(""));
    lines.push(Line::from(vec![Span::styled(
        format!(
            "  字段 {}/{}  |  ↑↓/Tab 切换  |  ←→/空格 切换选项  |  直接输入编辑  |  Enter 开始安装  |  Esc 返回",
            focused_index + 1,
            FIELDS.len()
        ),
        Style::default().fg(Color::DarkGray),
    )]));

    frame.render_widget(Paragraph::new(lines), inner);
}

fn render_value_line(app: &App, field: FormField, is_focused: bool) -> Line<'static> {
    match field.field_type {
        FieldType::TextInput {
            buffer_index,
            is_password,
        } => {
            let raw = app
                .config_form_buffers
                .get(buffer_index)
                .cloned()
                .unwrap_or_default();

            let display = if is_password && !is_focused && !raw.is_empty() {
                "*".repeat(raw.chars().count().min(24))
            } else {
                raw
            };

            let border_style = if is_focused {
                Style::default().fg(Color::Green)
            } else {
                Style::default().fg(Color::DarkGray)
            };

            let text_style = if is_focused {
                Style::default().fg(Color::White)
            } else {
                Style::default().fg(Color::Gray)
            };

            let cursor = if is_focused { "│" } else { "" };

            Line::from(vec![
                Span::styled("      [", border_style),
                Span::styled(format!("{display}{cursor}"), text_style),
                Span::styled("]", border_style),
            ])
        }
        FieldType::MirrorSelect => {
            let direct_selected = matches!(app.config.mirror, GithubMirror::Direct);
            let ghproxy_selected = matches!(app.config.mirror, GithubMirror::GhProxy);
            let custom_selected = matches!(app.config.mirror, GithubMirror::Custom(_));

            let mut spans = vec![Span::raw("      ")];
            spans.extend(render_radio("直连", direct_selected));
            spans.push(Span::raw("   "));
            spans.extend(render_radio("ghproxy 加速", ghproxy_selected));

            if custom_selected {
                spans.push(Span::raw("   "));
                spans.extend(render_radio("自定义(已保存)", true));
            }

            Line::from(spans)
        }
        FieldType::Toggle { value_ref } => {
            let is_on = match value_ref {
                ToggleRef::NpmMirror => app.config.use_npm_mirror,
                ToggleRef::PipMirror => app.config.use_pip_mirror,
            };

            let (text, color) = if is_on {
                ("[  ON  ] 已启用", Color::Green)
            } else {
                ("[ OFF  ] 已关闭", Color::DarkGray)
            };

            Line::from(vec![
                Span::raw("      "),
                Span::styled(text, Style::default().fg(color).add_modifier(Modifier::BOLD)),
            ])
        }
    }
}

fn render_radio(label: &str, selected: bool) -> Vec<Span<'static>> {
    let prefix = if selected { "● " } else { "○ " };
    let style = if selected {
        Style::default()
            .fg(Color::Green)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::DarkGray)
    };

    vec![Span::styled(format!("{prefix}{label}"), style)]
}

/// 返回 true 表示应开始安装
pub fn handle_input(app: &mut App, key: KeyCode) -> bool {
    if app.config_form_cursor >= FIELDS.len() {
        app.config_form_cursor = FIELDS.len().saturating_sub(1);
    }

    let current = FIELDS[app.config_form_cursor];

    match key {
        KeyCode::Up | KeyCode::BackTab => {
            if app.config_form_cursor > 0 {
                app.config_form_cursor -= 1;
            }
            false
        }
        KeyCode::Down | KeyCode::Tab => {
            if app.config_form_cursor + 1 < FIELDS.len() {
                app.config_form_cursor += 1;
            }
            false
        }
        KeyCode::Enter => {
            app.apply_config_form();
            true
        }
        KeyCode::Left => {
            match current.field_type {
                FieldType::MirrorSelect => set_prev_mirror(app),
                FieldType::Toggle { value_ref } => set_toggle(app, value_ref, false),
                FieldType::TextInput { .. } => {}
            }
            false
        }
        KeyCode::Right => {
            match current.field_type {
                FieldType::MirrorSelect => set_next_mirror(app),
                FieldType::Toggle { value_ref } => set_toggle(app, value_ref, true),
                FieldType::TextInput { .. } => {}
            }
            false
        }
        KeyCode::Char(' ') => {
            match current.field_type {
                FieldType::MirrorSelect => cycle_mirror(app),
                FieldType::Toggle { value_ref } => toggle_switch(app, value_ref),
                FieldType::TextInput { buffer_index, .. } => {
                    if let Some(buffer) = app.config_form_buffers.get_mut(buffer_index) {
                        buffer.push(' ');
                    }
                }
            }
            false
        }
        KeyCode::Backspace => {
            if let FieldType::TextInput { buffer_index, .. } = current.field_type {
                if let Some(buffer) = app.config_form_buffers.get_mut(buffer_index) {
                    buffer.pop();
                }
            }
            false
        }
        KeyCode::Char(c) => {
            if let FieldType::TextInput { buffer_index, .. } = current.field_type {
                if let Some(buffer) = app.config_form_buffers.get_mut(buffer_index) {
                    buffer.push(c);
                }
            }
            false
        }
        _ => false,
    }
}

fn toggle_switch(app: &mut App, toggle: ToggleRef) {
    match toggle {
        ToggleRef::NpmMirror => app.config.use_npm_mirror = !app.config.use_npm_mirror,
        ToggleRef::PipMirror => app.config.use_pip_mirror = !app.config.use_pip_mirror,
    }
}

fn set_toggle(app: &mut App, toggle: ToggleRef, value: bool) {
    match toggle {
        ToggleRef::NpmMirror => app.config.use_npm_mirror = value,
        ToggleRef::PipMirror => app.config.use_pip_mirror = value,
    }
}

fn cycle_mirror(app: &mut App) {
    app.config.mirror = match &app.config.mirror {
        GithubMirror::Direct => GithubMirror::GhProxy,
        GithubMirror::GhProxy => GithubMirror::Direct,
        GithubMirror::Custom(_) => GithubMirror::Direct,
    };
}

fn set_prev_mirror(app: &mut App) {
    app.config.mirror = match &app.config.mirror {
        GithubMirror::Direct => GithubMirror::Direct,
        GithubMirror::GhProxy => GithubMirror::Direct,
        GithubMirror::Custom(_) => GithubMirror::Direct,
    };
}

fn set_next_mirror(app: &mut App) {
    app.config.mirror = match &app.config.mirror {
        GithubMirror::Direct => GithubMirror::GhProxy,
        GithubMirror::GhProxy => GithubMirror::GhProxy,
        GithubMirror::Custom(_) => GithubMirror::Direct,
    };
}