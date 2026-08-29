use crate::app::App;
use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect, Margin},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Clear},
    Frame,
};

pub fn render(frame: &mut Frame, _app: &App) {
    let area = frame.area();

    // Clear background first
    frame.render_widget(Clear, area);

    // Main centered area
    let width = area.width.saturating_sub(4).min(100);
    let height = area.height.saturating_sub(2).min(38);
    let x = (area.width - width) / 2;
    let y = (area.height - height) / 2;
    let center = Rect::new(x.max(0), y.max(0), width, height);

    // Vertical layout: header + sections + footer
    let chunks = Layout::vertical([
        Constraint::Length(3), // Title block
        Constraint::Length(1), // Spacer
        Constraint::Length(5), // About section
        Constraint::Length(1), // Spacer
        Constraint::Length(6), // Repos block
        Constraint::Length(1), // Spacer
        Constraint::Length(5), // Resources block
        Constraint::Length(1), // Spacer
        Constraint::Length(5), // Warnings block
        Constraint::Length(1), // Spacer
        Constraint::Length(1), // Footer
        Constraint::Min(0),
    ])
    .split(center);

    // ===== Title block =====
    let title_block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title_bottom(Span::styled(" v2.0 ", Style::default().fg(Color::DarkGray)));

    let title = Paragraph::new(Line::from(vec![
        Span::styled("VCP ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
        Span::styled("一键部署工具", Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
        Span::styled("  |  ", Style::default().fg(Color::DarkGray)),
        Span::styled("AGI 运行时系统", Style::default().fg(Color::Yellow)),
    ])).alignment(Alignment::Center);

    frame.render_widget(title_block, chunks[0]);
    frame.render_widget(title, chunks[0].inner(Margin { horizontal: 1, vertical: 1 }));

    // ===== About section (left-aligned, italic style) =====
    let about_lines = vec![
        Line::from(vec![
            Span::styled("VCP(Variable & Command Protocol) ", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
            Span::styled("是一个全栈自研、工程化、分布式的 AGI 运行时系统。", Style::default().fg(Color::White)),
        ]),
        Line::from(vec![
            Span::styled("目标：", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
            Span::styled(
                "把大语言模型改造为一个拥有持久记忆、时间感知、自主行动、群体协作、跨端统一意识的 Agent。",
                Style::default().fg(Color::White).add_modifier(Modifier::ITALIC),
            ),
        ]),
        Line::from(vec![
            Span::styled("VCP 不是给 AI 一份\"工具清单\"，而是给 AI 建一座完整的城市。", Style::default().fg(Color::White).add_modifier(Modifier::ITALIC)),
        ]),
    ];

    let about_para = Paragraph::new(about_lines)
        .wrap(ratatui::widgets::Wrap { trim: true });
    frame.render_widget(about_para, chunks[2]);

    // ===== Repos block =====
    let repos_block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Green))
        .title(Span::styled(" 代码仓库 ", Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)));

    let repos_lines = vec![
        Line::from(vec![
            Span::styled("[主服务器] ", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
            Span::styled("https://github.com/lioensky/VCPToolBox", Style::default().fg(Color::DarkGray)),
        ]),
        Line::from(vec![
            Span::styled("[官方前端] ", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
            Span::styled("https://github.com/lioensky/VCPChat", Style::default().fg(Color::DarkGray)),
        ]),
        Line::from(vec![
            Span::styled("[分布服务] ", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
            Span::styled("https://github.com/lioensky/VCPDistributedServer", Style::default().fg(Color::DarkGray)),
        ]),
        Line::from(vec![
            Span::styled("[备份系统] ", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
            Span::styled("https://github.com/lioensky/VCPBackUpDEV", Style::default().fg(Color::DarkGray)),
        ]),
    ];

    let repos_para = Paragraph::new(repos_lines);
    frame.render_widget(repos_block, chunks[4]);
    frame.render_widget(repos_para, chunks[4].inner(Margin { horizontal: 1, vertical: 1 }));

    // ===== Resources block =====
    let res_block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(Span::styled(" 学习资源 ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)));

    let res_lines = vec![
        Line::from(vec![
            Span::styled("[官方文档] ", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
            Span::styled("https://www.vcptoolbox.com/?page=learn-vcp", Style::default().fg(Color::DarkGray)),
        ]),
        Line::from(vec![
            Span::styled("[视频教程] ", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
            Span::styled("https://bilibili.com/video/BV1kqZSBWE4T", Style::default().fg(Color::DarkGray)),
        ]),
        Line::from(vec![
            Span::styled("[图文教程] ", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
            Span::styled("https://gcores.com/articles/210054", Style::default().fg(Color::DarkGray)),
        ]),
    ];

    let res_para = Paragraph::new(res_lines);
    frame.render_widget(res_block, chunks[6]);
    frame.render_widget(res_para, chunks[6].inner(Margin { horizontal: 1, vertical: 1 }));

    // ===== Warnings block =====
    let warn_block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Red))
        .title(Span::styled(" ! 安装前必读 ! ", Style::default().fg(Color::Red).add_modifier(Modifier::BOLD)));

    let warn_lines = vec![
        Line::from(vec![
            Span::styled("! ", Style::default().fg(Color::Red).add_modifier(Modifier::BOLD)),
            Span::styled("下载约 2-3GB，全程可能需要 10-30 分钟", Style::default().fg(Color::White)),
        ]),
        Line::from(vec![
            Span::styled("! ", Style::default().fg(Color::Red).add_modifier(Modifier::BOLD)),
            Span::styled("强烈建议开启 VPN/代理，避开网络拥堵时段，否则下载可能极慢甚至失败", Style::default().fg(Color::White)),
        ]),
        Line::from(vec![
            Span::styled("! ", Style::default().fg(Color::Red).add_modifier(Modifier::BOLD)),
            Span::styled("建议暂时关闭 Windows Defender 实时保护", Style::default().fg(Color::White)),
        ]),
        Line::from(""),
        Line::from(vec![
            Span::styled("* ", Style::default().fg(Color::DarkGray)),
            Span::styled("安装如遇错误，请查看 exe 同级的 Install_log 文件夹", Style::default().fg(Color::DarkGray)),
        ]),
    ];

    let warn_para = Paragraph::new(warn_lines)
        .wrap(ratatui::widgets::Wrap { trim: true });
    frame.render_widget(warn_block, chunks[8]);
    frame.render_widget(warn_para, chunks[8].inner(Margin { horizontal: 1, vertical: 1 }));

    // ===== Footer =====
    let footer_line = Line::from(vec![
        Span::styled("按 ", Style::default().fg(Color::DarkGray)),
        Span::styled("Enter", Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)),
        Span::styled(" 开始部署  |  按 ", Style::default().fg(Color::DarkGray)),
        Span::styled("Q", Style::default().fg(Color::Red).add_modifier(Modifier::BOLD)),
        Span::styled(" 退出", Style::default().fg(Color::DarkGray)),
    ]);

    let footer = Paragraph::new(footer_line).alignment(Alignment::Center);
    frame.render_widget(footer, chunks[10]);
}