use crate::app::{App, Component};
use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();

    let block = Block::default()
        .title(" 选择安装组件 ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let components = Component::all();
    let mut lines = vec![Line::from("")];

    for (index, component) in components.iter().enumerate() {
        let is_cursor = index == app.component_cursor;
        let is_selected = app.is_component_selected(component);

        let cursor = if is_cursor { "▶" } else { " " };
        let checkbox = if is_selected { "[✓]" } else { "[ ]" };
        let required = if component.is_required() { "（必选）" } else { "" };
        let pre_installed = app.is_component_pre_installed(component);
        let installed_tag = if pre_installed { " ✔ 已安装" } else { "" };

        let style = if is_cursor {
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else if pre_installed && is_selected {
            Style::default().fg(Color::Yellow)
        } else if is_selected {
            Style::default().fg(Color::Green)
        } else {
            Style::default().fg(Color::DarkGray)
        };

        lines.push(Line::from(vec![Span::styled(
            format!(
                "  {cursor} {checkbox} {}{required}{installed_tag}",
                component.display_name()
            ),
            style,
        )]));

        let desc = if pre_installed {
            format!("      {} — 再次安装将执行更新", component.description())
        } else {
            format!("      {}", component.description())
        };
        lines.push(Line::from(vec![Span::styled(
            desc,
            Style::default().fg(Color::DarkGray),
        )]));

        lines.push(Line::from(""));
    }

    lines.push(Line::from(vec![Span::styled(
        "  ↑↓ 选择  |  空格 切换  |  Enter 确认  |  Esc 返回",
        Style::default().fg(Color::DarkGray),
    )]));

    frame.render_widget(Paragraph::new(lines), inner);
}