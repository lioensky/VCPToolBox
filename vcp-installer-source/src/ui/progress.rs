use crate::app::{App, StepStatus};
use ratatui::{
    Frame,
    layout::{Constraint, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Gauge, Paragraph, Wrap},
};

pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();

    let block = Block::default()
        .title(" 安装进度 ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    if let Some(progress) = &app.install_progress {
        let chunks = Layout::vertical([
            Constraint::Length(3),
            Constraint::Min(8),
            Constraint::Length(6),
        ])
        .split(inner);

        let gauge = Gauge::default()
            .gauge_style(Style::default().fg(Color::Green))
            .percent(progress.overall_percentage.clamp(0.0, 100.0) as u16)
            .label(format!("{:.0}%", progress.overall_percentage));
        frame.render_widget(gauge, chunks[0]);

        let mut step_lines = Vec::new();

        for (idx, step) in progress.steps.iter().enumerate() {
            let (icon, color) = match &step.status {
                StepStatus::Pending => ("○", Color::DarkGray),
                StepStatus::Running => ("⏳", Color::Yellow),
                StepStatus::Completed => ("✅", Color::Green),
                StepStatus::Failed(_) => ("❌", Color::Red),
                StepStatus::Skipped => ("⏭", Color::DarkGray),
            };

            let mut text = format!("  {} {}", icon, step.name);

            if let Some(dl) = &step.download_progress {
                text.push_str(&format!(
                    "  {:.1}/{:.1} MB ({:.0}%)",
                    dl.downloaded_mb(),
                    dl.total_mb(),
                    dl.percentage()
                ));
            }

            if let StepStatus::Failed(err) = &step.status {
                text.push_str(&format!("  错误: {}", err));
            }

            let style = if idx == progress.current_step_index {
                Style::default().fg(color).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(color)
            };

            step_lines.push(Line::from(Span::styled(text, style)));
        }

        let step_paragraph = Paragraph::new(step_lines).wrap(Wrap { trim: false });
        frame.render_widget(step_paragraph, chunks[1]);

        let log_block = Block::default()
            .title(" 日志 (↑↓滚动) | ⚠ 点击窗口会暂停显示，右键恢复 | 安装始终在后台运行 ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray));

        let visible_height = chunks[2].height.saturating_sub(2) as usize;
        let total_logs = app.log_messages.len();
        let scroll = app.log_scroll.min(total_logs.saturating_sub(1));
        let end = total_logs.saturating_sub(scroll);
        let start = end.saturating_sub(visible_height);

        let visible_logs: Vec<Line> = if start < end {
            app.log_messages[start..end]
                .iter()
                .map(|msg| {
                    Line::from(Span::styled(
                        format!("  {}", msg),
                        Style::default().fg(Color::DarkGray),
                    ))
                })
                .collect()
        } else {
            vec![Line::from(Span::styled(
                "  暂无日志...",
                Style::default().fg(Color::DarkGray),
            ))]
        };

        let log_paragraph = Paragraph::new(visible_logs)
            .block(log_block)
            .wrap(Wrap { trim: false });

        frame.render_widget(log_paragraph, chunks[2]);
    } else {
        let lines = vec![
            Line::from(""),
            Line::from(Span::styled(
                "  等待安装任务启动...",
                Style::default().fg(Color::Yellow),
            )),
        ];
        frame.render_widget(Paragraph::new(lines), inner);
    }
}