use crate::app::{App, Component};
use ratatui::{
    Frame,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
};
use std::path::Path;

pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();

    let block = Block::default()
        .title(" 完成 ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Green));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let lines = if let Some(result) = &app.install_result {
        let mut lines = vec![
            Line::from(""),
            Line::from(Span::styled(
                if result.success {
                    "  🎉 VCP 安装完成！"
                } else {
                    "  ⚠ 安装完成（有错误）"
                },
                Style::default()
                    .fg(if result.success {
                        Color::Green
                    } else {
                        Color::Yellow
                    })
                    .add_modifier(Modifier::BOLD),
            )),
            Line::from(""),
        ];

        lines.push(Line::from(vec![
            Span::styled("  📁 安装路径: ", Style::default().fg(Color::White)),
            Span::styled(
                result.install_path.display().to_string(),
                Style::default().fg(Color::Cyan),
            ),
        ]));
        lines.push(Line::from(""));

        lines.push(Line::from(Span::styled(
            "  已安装组件:",
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        )));

        for comp in &result.installed_components {
            lines.push(Line::from(Span::styled(
                format!("    ✅ {}", comp.display_name()),
                Style::default().fg(Color::Green),
            )));
        }

        lines.push(Line::from(""));

        if let Some(backend) = &result.backend_start_script {
            lines.push(Line::from(vec![
                Span::styled("  🚀 启动后端: ", Style::default().fg(Color::White)),
                Span::styled(short_name(backend), Style::default().fg(Color::Green)),
            ]));
        }

        if let Some(frontend) = &result.frontend_start_script {
            lines.push(Line::from(vec![
                Span::styled("  🖥 启动前端: ", Style::default().fg(Color::White)),
                Span::styled(short_name(frontend), Style::default().fg(Color::Green)),
            ]));
        }

        lines.push(Line::from(""));

        // === 配置向导引导 ===
        if result.installed_components.contains(&Component::VCPToolBox) {
            lines.push(Line::from(Span::styled(
                "  ─── 🌐 下一步：配置向导 ───",
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            )));
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled(
                "  退出后将自动打开浏览器配置页面",
                Style::default().fg(Color::White),
            )));
            lines.push(Line::from(Span::styled(
                "  在网页中填写 API 密钥等配置即可完成设置",
                Style::default().fg(Color::White),
            )));
            lines.push(Line::from(""));
        }

        if !result.errors.is_empty() {
            lines.push(Line::from(Span::styled(
                "  ⚠ 以下步骤出现错误:",
                Style::default().fg(Color::Yellow),
            )));

            for err in &result.errors {
                lines.push(Line::from(Span::styled(
                    format!("    ❌ {}", err),
                    Style::default().fg(Color::Red),
                )));
            }

            lines.push(Line::from(""));
        }

        lines.push(Line::from(Span::styled(
            "  ↑↓/PgUp/PgDn 滚动  |  O 打开目录  |  Q/Enter 退出",
            Style::default().fg(Color::DarkGray),
        )));

        lines
    } else {
        vec![
            Line::from(""),
            Line::from(Span::styled(
                "  安装未执行或未返回结果",
                Style::default().fg(Color::Yellow),
            )),
            Line::from(Span::styled(
                "  按 Q / Enter 退出",
                Style::default().fg(Color::DarkGray),
            )),
        ]
    };

    let paragraph = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .scroll((app.complete_scroll as u16, 0));
    frame.render_widget(paragraph, inner);
}

fn short_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string())
}