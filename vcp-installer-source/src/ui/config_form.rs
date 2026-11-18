use crate::app::App;
use crossterm::event::KeyCode;
use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

#[derive(Debug, Clone, Copy)]
enum FieldType {
    TextInput {
        buffer_index: usize,
        is_password: bool,
    },
    MirrorList {
        section: &'static str,
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
        label: "GitHub 镜像站",
        field_type: FieldType::MirrorList { section: "github" },
        hint: "安装时将自动选择镜像站点并轮换，无需手动选择",
    },
    FormField {
        label: "npm 镜像站",
        field_type: FieldType::MirrorList { section: "npm" },
        hint: "安装时将自动选择镜像站点并轮换，无需手动选择",
    },
    FormField {
        label: "pip 镜像站",
        field_type: FieldType::MirrorList { section: "pip" },
        hint: "安装时将自动选择镜像站点并轮换，无需手动选择",
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

    let focused_index = app.config_form_cursor.min(FIELDS.len().saturating_sub(1));

    let mut lines = Vec::new();

    lines.push(Line::from(vec![Span::styled(
        "  --- VCP 安装配置 ---",
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
    )]));
    lines.push(Line::from(vec![Span::styled(
        "  * 安装时将自动选择镜像站点并轮换，无需手动选择",
        Style::default().fg(Color::DarkGray),
    )]));
    lines.push(Line::from(""));

    for (index, field) in FIELDS.iter().enumerate() {
        let is_focused = index == focused_index;
        let prefix = if is_focused { "> " } else { "  " };

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

        match field.field_type {
            FieldType::TextInput { .. } => {
                lines.push(render_text_input_line(app, *field, is_focused));
                if is_focused {
                    lines.push(Line::from(vec![Span::styled(
                        format!("      * {}", field.hint),
                        Style::default().fg(Color::DarkGray),
                    )]));
                }
            }
            FieldType::MirrorList { section } => {
                lines.extend(render_mirror_lines(app, *field, is_focused, section));
            }
        }

        lines.push(Line::from(""));
    }

    lines.push(Line::from(""));
    lines.push(Line::from(vec![Span::styled(
        "  * API密钥、管理密码等配置将在安装完成后引导您编辑 config.env",
        Style::default().fg(Color::Yellow),
    )]));

    lines.push(Line::from(""));
    lines.push(Line::from(vec![Span::styled(
        format!(
            "  字段 {}/{}  |  上下键/Tab 切换  |  直接输入编辑路径  |  Enter 开始安装  |  Esc 返回",
            focused_index + 1,
            FIELDS.len()
        ),
        Style::default().fg(Color::DarkGray),
    )]));

    frame.render_widget(
        Paragraph::new(lines).wrap(Wrap { trim: false }),
        inner,
    );
}

fn render_text_input_line(app: &App, field: FormField, is_focused: bool) -> Line<'static> {
    let buffer_index = match field.field_type {
        FieldType::TextInput { buffer_index, .. } => buffer_index,
        _ => 0,
    };
    let is_password = match field.field_type {
        FieldType::TextInput { is_password, .. } => is_password,
        _ => false,
    };

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

    let cursor = if is_focused { "|" } else { "" };

    Line::from(vec![
        Span::styled("      [", border_style),
        Span::styled(format!("{display}{cursor}"), text_style),
        Span::styled("]", border_style),
    ])
}

fn render_mirror_lines(
    app: &App,
    field: FormField,
    _is_focused: bool,
    section: &str,
) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let color = Color::DarkGray;

    match section {
        "github" => {
            // Show preferred_github only (up to 3)
            if !app.mirror_config.preferred_github.is_empty() {
                for (i, entry) in app.mirror_config.preferred_github.iter().take(3).enumerate() {
                    let prefix = match i {
                        0 => "[优选1] ",
                        1 => "[优选2] ",
                        2 => "[优选3] ",
                        _ => "",
                    };
                    lines.push(Line::from(vec![
                        Span::styled(format!("      {}{}", prefix, entry.name), Style::default().fg(Color::Cyan)),
                        Span::styled(format!(" -> {}", truncate_url(&entry.url)), Style::default().fg(color)),
                    ]));
                }
            } else {
                // No preferred yet, show first 3 from github as reference
                for (i, entry) in app.mirror_config.github.iter().take(3).enumerate() {
                    let prefix = match i {
                        0 => "[备用1] ",
                        1 => "[备用2] ",
                        2 => "[备用3] ",
                        _ => "",
                    };
                    lines.push(Line::from(vec![
                        Span::styled(format!("      {}{}", prefix, entry.name), Style::default().fg(color)),
                        Span::styled(format!(" -> {}", truncate_url(&entry.url)), Style::default().fg(color)),
                    ]));
                }
            }
        }
        "npm" => {
            for (i, entry) in app.mirror_config.npm.iter().enumerate() {
                let prefix = match i {
                    0 => "[1] ",
                    1 => "[2] ",
                    2 => "[3] ",
                    _ => "",
                };
                lines.push(Line::from(vec![
                    Span::styled(format!("      {}{}", prefix, entry.name), Style::default().fg(color)),
                    Span::styled(format!(" -> {}", truncate_url(&entry.url)), Style::default().fg(color)),
                ]));
            }
        }
        "pip" => {
            for (i, entry) in app.mirror_config.pip.iter().enumerate() {
                let prefix = match i {
                    0 => "[1] ",
                    1 => "[2] ",
                    2 => "[3] ",
                    3 => "[4] ",
                    4 => "[5] ",
                    5 => "[6] ",
                    _ => "",
                };
                lines.push(Line::from(vec![
                    Span::styled(format!("      {}{}", prefix, entry.name), Style::default().fg(color)),
                    Span::styled(format!(" -> {}", truncate_url(&entry.url)), Style::default().fg(color)),
                ]));
            }
        }
        _ => {
            lines.push(Line::from(vec![
                Span::raw("      "),
                Span::styled("(无配置)", Style::default().fg(Color::DarkGray)),
            ]));
        }
    }

    if lines.is_empty() {
        lines.push(Line::from(vec![
            Span::raw("      "),
            Span::styled("(无配置)", Style::default().fg(Color::DarkGray)),
        ]));
    }

    lines
}

fn truncate_url(url: &str) -> String {
    let max = 55;
    if url.len() <= max {
        url.to_string()
    } else {
        format!("{}...", &url[..max.saturating_sub(3)])
    }
}

/// Returns true if installation should start
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
