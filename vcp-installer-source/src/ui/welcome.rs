use crate::app::App;
use ratatui::{
    layout::{Alignment, Constraint, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

pub fn render(frame: &mut Frame, _app: &App) {
    let area = frame.area();

    let chunks = Layout::vertical([
        Constraint::Percentage(30),
        Constraint::Length(25),
        Constraint::Percentage(30),
    ])
    .split(area);

    let lines = vec![
        Line::from(vec![Span::styled(
            "╔══════════════════════════════════════╗",
            Style::default().fg(Color::Cyan),
        )]),
        Line::from(vec![Span::styled(
            "║                                      ║",
            Style::default().fg(Color::Cyan),
        )]),
        Line::from(vec![Span::styled(
            "║      VCP 一键部署工具  v1.0          ║",
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )]),
        Line::from(vec![Span::styled(
            "║                                      ║",
            Style::default().fg(Color::Cyan),
        )]),
        Line::from(vec![Span::styled(
            "║   自动部署 VCPToolBox + VCPChat      ║",
            Style::default().fg(Color::White),
        )]),
        Line::from(vec![Span::styled(
            "║   github.com/lioensky/VCPToolBox     ║",
            Style::default().fg(Color::DarkGray),
        )]),
        Line::from(vec![Span::styled(
            "║                                      ║",
            Style::default().fg(Color::Cyan),
        )]),
        Line::from(vec![Span::styled(
            "╚══════════════════════════════════════╝",
            Style::default().fg(Color::Cyan),
        )]),
        Line::from(""),
        Line::from(vec![Span::styled(
            "── 全程一键部署，无需手动操作 ──",
            Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
        )]),
        Line::from(""),
        Line::from(vec![Span::styled(
            "📺 视频教程: bilibili.com/video/BV1kqZSBWE4T",
            Style::default().fg(Color::Green),
        )]),
        Line::from(vec![Span::styled(
            "📖 图文教程: gcores.com/articles/210054",
            Style::default().fg(Color::Green),
        )]),
        Line::from(""),
        Line::from(vec![Span::styled(
            "⚠ 安装如遇错误，请查看安装目录下 install_log.txt",
            Style::default().fg(Color::DarkGray),
        )]),
        Line::from(vec![Span::styled(
            "⚠ 镜像暂不可用，请确保稳定的网络环境",
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        )]),
        Line::from(""),

        Line::from(vec![
            Span::styled("按 ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                "Enter",
                Style::default()
                    .fg(Color::Green)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" 开始  |  按 ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                "Q",
                Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
            ),
            Span::styled(" 退出", Style::default().fg(Color::DarkGray)),
        ]),
    ];

    let paragraph = Paragraph::new(lines).alignment(Alignment::Center);
    frame.render_widget(paragraph, chunks[1]);
}