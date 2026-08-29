use crate::app::{App, DependencyStatus};
use ratatui::{
    Frame,
    layout::{Alignment, Margin},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
};

const SPINNER: &[char] = &['-', '/', '|', '\\'];

pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();

    let block = Block::default()
        .title(" 环境检测 ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let spinner = spinner_char();

    let mut lines: Vec<Line> = Vec::new();

    // ===== Header =====
    if app.env_check_done {
        lines.push(Line::from(Span::styled(
            "[OK] 环境检测完成",
            Style::default().fg(Color::Green).add_modifier(Modifier::BOLD),
        )));
        lines.push(Line::from(""));
    }

    if app.env_check_done {
        // ===== 系统信息 =====
        lines.push(Line::from(Span::styled(
            "系统信息：",
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
        )));
        lines.push(system_line("系  统", &app.env_check.os_version, Color::White));
        lines.push(system_line("处理器", &app.env_check.cpu_name, Color::White));
        lines.push(system_line("内  存", &format!("{:.1} GB", app.env_check.total_memory_gb), Color::White));
        lines.push(system_line("显  卡", &app.env_check.gpu_name, Color::White));
        lines.push(Line::from(""));

        // ===== 网络检测 =====
        lines.push(Line::from(Span::styled(
            "网络检测：",
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
        )));

        let (gh_mark, gh_text, gh_color) = if app.env_check.network_github {
            ("YES", "GitHub官方源，可达。", Color::Green)
        } else {
            ("NO ", "GitHub官方源，不可达。", Color::Red)
        };
        lines.push(network_line(gh_mark, gh_text, gh_color));

        let (npm_mark, npm_text, npm_color) = if app.env_check.network_npm {
            ("YES", "NPM   官方源，可达。", Color::Green)
        } else {
            ("NO ", "NPM   官方源，不可达。", Color::Red)
        };
        lines.push(network_line(npm_mark, npm_text, npm_color));

        let (pip_mark, pip_text, pip_color) = if app.pip_source_ok {
            ("YES", "PIP   官方源，可达。", Color::Green)
        } else {
            ("NO ", "PIP   官方源，不可达。", Color::Red)
        };
        lines.push(network_line(pip_mark, pip_text, pip_color));

        let (msvc_mark, msvc_text, msvc_color) = if app.msvc_source_ok {
            ("YES", "MSVC  官方源，可达。", Color::Green)
        } else {
            ("NO ", "MSVC  官方源，不可达。", Color::Red)
        };
        lines.push(network_line(msvc_mark, msvc_text, msvc_color));

        lines.push(Line::from(Span::styled(
            "注：可在 vcp-mirrors.ini 文件中配置所有镜像站，加速安装进程。",
            Style::default().fg(Color::DarkGray),
        )));
        lines.push(Line::from(""));

        // ===== 安装应用 =====
        lines.push(Line::from(Span::styled(
            "安装应用：",
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
        )));

        lines.push(app_line("Git", &app.env_check.git));
        lines.push(app_line("Node.js", &app.env_check.node));
        lines.push(app_line("Python", &app.env_check.python));
        lines.push(msvc_line(&app.env_check.msvc));

        if let Some(err) = &app.env_check_error {
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled(
                format!("  ! {}", err),
                Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
            )));
        }
    } else {
        lines.push(Line::from(Span::styled(
            format!("  {} 正在检测系统环境与网络状态，请稍候...", spinner),
            Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
        )));
    }

    // ===== Footer =====
    lines.push(Line::from(""));
    if app.env_check_done {
        lines.push(Line::from(Span::styled(
            "  按 Enter 继续  |  按 R 重新检测  |  按 Esc 返回",
            Style::default().fg(Color::DarkGray),
        )));
    } else {
        lines.push(Line::from(Span::styled(
            "  按 Esc 返回",
            Style::default().fg(Color::DarkGray),
        )));
    }

    let para = Paragraph::new(lines).wrap(Wrap { trim: false });
    frame.render_widget(para, inner.inner(Margin { horizontal: 2, vertical: 1 }));
}

// ===== Helper: system info line =====
fn system_line(label: &str, value: &str, color: Color) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            format!("[{}]  ", label),
            Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
        ),
        Span::styled(value.to_string(), Style::default().fg(color)),
    ])
}

// ===== Helper: network status line =====
fn network_line(mark: &str, text: &str, color: Color) -> Line<'static> {
    let mark_styled = if mark == "YES" {
        Span::styled("[YES] ", Style::default().fg(Color::Green).add_modifier(Modifier::BOLD))
    } else {
        Span::styled("[NO ] ", Style::default().fg(Color::Red).add_modifier(Modifier::BOLD))
    };
    Line::from(vec![
        mark_styled,
        Span::styled(text.to_string(), Style::default().fg(color)),
    ])
}

// ===== Helper: app status line =====
fn app_line(name: &str, status: &DependencyStatus) -> Line<'static> {
    let (mark, text, color) = match status {
        DependencyStatus::Installed(v) => {
            ("YES", format!("{} ({})", name, v), Color::Green)
        }
        DependencyStatus::NotFound => {
            ("NO ", format!("{} 未检测到，将自动下载 Portable 版", name), Color::Yellow)
        }
        DependencyStatus::Checking => {
            ("-- ", format!("{} 检测中...", name), Color::DarkGray)
        }
        DependencyStatus::WillUsePortable => {
            ("NO ", format!("{} 未检测到，将使用 Portable 版", name), Color::Yellow)
        }
    };

    let mark_styled = if mark == "YES" {
        Span::styled("[YES] ", Style::default().fg(Color::Green).add_modifier(Modifier::BOLD))
    } else if mark == "NO " {
        Span::styled("[NO ] ", Style::default().fg(Color::Red).add_modifier(Modifier::BOLD))
    } else {
        Span::styled("[-- ] ", Style::default().fg(Color::DarkGray))
    };

    Line::from(vec![
        mark_styled,
        Span::styled(text, Style::default().fg(color)),
    ])
}

// ===== Helper: MSVC status line =====
fn msvc_line(status: &DependencyStatus) -> Line<'static> {
    let (mark, text, color) = match status {
        DependencyStatus::Installed(v) => {
            ("YES", format!("MSVC Build Tools ({})", v), Color::Green)
        }
        DependencyStatus::NotFound => {
            ("NO ", "MSVC Build Tools 未检测到，将尝试 winget 自动安装".to_string(), Color::Yellow)
        }
        DependencyStatus::Checking => {
            ("-- ", "MSVC Build Tools 检测中...".to_string(), Color::DarkGray)
        }
        DependencyStatus::WillUsePortable => {
            ("-- ", "MSVC Build Tools 将自动安装".to_string(), Color::Yellow)
        }
    };

    let mark_styled = if mark == "YES" {
        Span::styled("[YES] ", Style::default().fg(Color::Green).add_modifier(Modifier::BOLD))
    } else if mark == "NO " {
        Span::styled("[NO ] ", Style::default().fg(Color::Red).add_modifier(Modifier::BOLD))
    } else {
        Span::styled("[-- ] ", Style::default().fg(Color::DarkGray))
    };

    Line::from(vec![
        mark_styled,
        Span::styled(text, Style::default().fg(color)),
    ])
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