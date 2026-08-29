use crate::app::{App, Component, InstallMethod};
use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

/// 组件选择项数量（6个组件 + MSVCBuildTools）
const COMPONENT_COUNT: usize = 6;
/// 安装方式选项数量（2个）
const METHOD_COUNT: usize = 2;
/// 总光标位置数量（组件区0-5 + 方式区6-7）
const TOTAL_ITEMS: usize = COMPONENT_COUNT + METHOD_COUNT;

pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();

    let block = Block::default()
        .title(" 选择安装组件 ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let components = Component::all();
    let mut lines = Vec::new();

    // ====== 组件区域 ======
    for (index, component) in components.iter().enumerate() {
        let item_index = index;
        let is_cursor = item_index == app.component_cursor;
        let is_selected = app.is_component_selected(component);
        let pre_installed = app.is_component_pre_installed(component);
        let installed_tag = if pre_installed { " [OK] 已安装" } else { "" };

        let cursor = if is_cursor { ">" } else { " " };
        let checkbox = if is_selected { "[*]" } else { "[ ]" };

        let style = if is_cursor {
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
        } else if pre_installed && is_selected {
            Style::default().fg(Color::Yellow)
        } else if is_selected {
            Style::default().fg(Color::Green)
        } else {
            Style::default().fg(Color::DarkGray)
        };

        lines.push(Line::from(vec![Span::styled(
            format!("  {cursor} {checkbox} {}{installed_tag}", component.display_name()),
            style,
        )]));

        let desc = if pre_installed {
            format!("      {} -- 再次安装将执行更新", component.description())
        } else {
            format!("      {}", component.description())
        };
        lines.push(Line::from(vec![Span::styled(
            desc,
            Style::default().fg(Color::DarkGray),
        )]));
        // 最后一个组件后不加空行，节省空间
        if index < components.len() - 1 {
            lines.push(Line::from(""));
        }
    }

    // ====== 安装方式区域分隔 ======
    lines.push(Line::from(vec![Span::styled(
        "-------------------------------------------------------------------",
        Style::default().fg(Color::DarkGray),
    )]));
    lines.push(Line::from(vec![Span::styled(
        "  选择安装方式（Git clone / Tarball+Git）",
        Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
    )]));

    // ====== 安装方式选项 ======
    let methods = [InstallMethod::GitClone, InstallMethod::TarballGit];
    for (i, method) in methods.iter().enumerate() {
        let item_index = COMPONENT_COUNT + i;
        let is_cursor = item_index == app.component_cursor;
        let is_selected = *method == app.install_method;

        let cursor = if is_cursor { ">" } else { " " };
        let checkbox = if is_selected { "[*]" } else { "[ ]" };

        let style = if is_cursor {
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
        } else if is_selected {
            Style::default().fg(Color::Green)
        } else {
            Style::default().fg(Color::DarkGray)
        };

        lines.push(Line::from(vec![Span::styled(
            format!("  {cursor} {checkbox} {}", method.display_name()),
            style,
        )]));

        let pros_cons = match method {
            InstallMethod::GitClone => {
                "+ 直接 git clone，原生支持 git pull 更新\n- 速度较慢，镜像站支持参差不齐，Git 通道不通时自动切换到Tarball+Git模式"
            }
            InstallMethod::TarballGit => {
                "+ 节省流量，成功率高，离线缓存复用，完成后尽力初始化 git 仓库。推荐使用\n- 多下载一份 git 数据；git 通道不通时退化为无 git 更新能力"
            }
        };
        for line in pros_cons.lines() {
            lines.push(Line::from(vec![Span::styled(
                format!("    {}", line),
                Style::default().fg(Color::DarkGray),
            )]));
        }
        // 最后一个方式后不加空行
        if i < methods.len() - 1 {
            lines.push(Line::from(""));
        }
    }

    // ====== 底部操作提示 ======
    lines.push(Line::from(vec![Span::styled(
        "  上下键 切换选项  |  空格 切换勾选  |  Enter 确认  |  Esc 返回",
        Style::default().fg(Color::DarkGray),
    )]));

    frame.render_widget(Paragraph::new(lines), inner);
}
