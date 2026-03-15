use crate::app::{App, DependencyStatus};
use ratatui::{
    Frame,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
};

const SPINNER: &[char] = &['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();

    let block = Block::default()
        .title(" 环境检测 ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines = vec![Line::from("")];

    if app.env_check_done {
        lines.push(Line::from(Span::styled(
            "  ✅ 环境检测完成",
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::BOLD),
        )));
    } else {
        lines.push(Line::from(Span::styled(
            format!("  {} 正在检测系统环境与网络状态，请稍候...", spinner_char()),
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )));
        lines.push(Line::from(Span::styled(
            "  检测完成后才能继续下一步。",
            Style::default().fg(Color::DarkGray),
        )));
    }

    lines.push(Line::from(""));

    lines.push(status_line(
        "操作系统",
        if app.env_check_done && !app.env_check.os_version.is_empty() {
            app.env_check.os_version.clone()
        } else {
            "检测中...".to_string()
        },
        if app.env_check_done {
            Color::Green
        } else {
            Color::DarkGray
        },
    ));

    let disk_text = if app.env_check_done {
        if app.env_check.disk_space_ok {
            format!("{:.1} GB 可用", app.env_check.disk_space_gb)
        } else {
            format!("{:.1} GB 可用（不足 3GB）", app.env_check.disk_space_gb)
        }
    } else {
        "检测中...".to_string()
    };
    lines.push(status_line(
        "磁盘空间",
        disk_text,
        if !app.env_check_done {
            Color::DarkGray
        } else if app.env_check.disk_space_ok {
            Color::Green
        } else {
            Color::Red
        },
    ));

    let github_text = if app.env_check_done {
        if app.env_check.network_github {
            format!("可达，推荐 {}", app.config.mirror.display_name())
        } else {
            "直连和镜像均不可达".to_string()
        }
    } else {
        "检测中...".to_string()
    };
    lines.push(status_line(
        "GitHub网络",
        github_text,
        if !app.env_check_done {
            Color::DarkGray
        } else if app.env_check.network_github {
            Color::Green
        } else {
            Color::Red
        },
    ));

    let npm_text = if app.env_check_done {
        if !app.env_check.network_npm {
            "官方源和镜像均不可达".to_string()
        } else if app.config.use_npm_mirror {
            "官方源较慢/不可达，已推荐 npmmirror.com".to_string()
        } else {
            "官方源可达".to_string()
        }
    } else {
        "检测中...".to_string()
    };
    lines.push(status_line(
        "npm源",
        npm_text,
        if !app.env_check_done {
            Color::DarkGray
        } else if !app.env_check.network_npm {
            Color::Red
        } else if app.config.use_npm_mirror {
            Color::Yellow
        } else {
            Color::Green
        },
    ));

    let pip_text = if app.env_check_done {
        if !app.pip_source_ok {
            "官方源和镜像均不可达".to_string()
        } else if app.config.use_pip_mirror {
            "官方源较慢/不可达，已推荐清华源".to_string()
        } else {
            "官方源可达".to_string()
        }
    } else {
        "检测中...".to_string()
    };
    lines.push(status_line(
        "pip源",
        pip_text,
        if !app.env_check_done {
            Color::DarkGray
        } else if !app.pip_source_ok {
            Color::Red
        } else if app.config.use_pip_mirror {
            Color::Yellow
        } else {
            Color::Green
        },
    ));

    lines.push(Line::from(""));

    lines.push(dep_line("Git", &app.env_check.git));
    lines.push(dep_line("Node.js", &app.env_check.node));
    lines.push(dep_line("Python", &app.env_check.python));
    lines.push(msvc_dep_line(&app.env_check.msvc));

    if let Some(err) = &app.env_check_error {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            format!("  ⚠ {}", err),
            Style::default().fg(Color::Red),
        )));
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        if app.env_check_done {
            "  按 Enter 继续  |  按 R 重新检测  |  按 Esc 返回"
        } else {
            "  正在检测中...  |  按 Esc 返回"
        },
        Style::default().fg(Color::DarkGray),
    )));

    let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
    frame.render_widget(paragraph, inner);
}

fn spinner_char() -> char {
    let idx = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        / 100) as usize
        % SPINNER.len();

    SPINNER[idx]
}

fn status_line(label: &str, value: impl Into<String>, color: Color) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            format!("  {:<12}", label),
            Style::default().fg(Color::White),
        ),
        Span::styled(value.into(), Style::default().fg(color)),
    ])
}

fn dep_line(name: &str, status: &DependencyStatus) -> Line<'static> {
    let (icon, text, color) = match status {
        DependencyStatus::Installed(v) => {
            ("✅", format!("{} ({})", name, v), Color::Green)
        }
        DependencyStatus::NotFound => (
            "📦",
            format!("{} 未检测到，将自动下载 Portable 版", name),
            Color::Yellow,
        ),
        DependencyStatus::Checking => (
            "🔍",
            format!("{} 检测中...", name),
            Color::DarkGray,
        ),
        DependencyStatus::WillUsePortable => (
            "📦",
            format!("{} 使用 Portable 版", name),
            Color::Blue,
        ),
    };

    Line::from(vec![
        Span::styled(format!("  {} ", icon), Style::default()),
        Span::styled(text, Style::default().fg(color)),
    ])
}

fn msvc_dep_line(status: &DependencyStatus) -> Line<'static> {
    let (icon, text, color) = match status {
        DependencyStatus::Installed(v) => {
            ("✅", format!("MSVC Build Tools ({})", v), Color::Green)
        }
        DependencyStatus::NotFound => (
            "📦",
            "MSVC Build Tools 未检测到，将尝试 winget 自动安装".to_string(),
            Color::Yellow,
        ),
        DependencyStatus::Checking => (
            "🔍",
            "MSVC Build Tools 检测中...".to_string(),
            Color::DarkGray,
        ),
        DependencyStatus::WillUsePortable => (
            "⚠️",
            "MSVC Build Tools 未检测到".to_string(),
            Color::Yellow,
        ),
    };

    Line::from(vec![
        Span::styled(format!("  {} ", icon), Style::default()),
        Span::styled(text, Style::default().fg(color)),
    ])
}