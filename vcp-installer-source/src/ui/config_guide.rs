use crate::app::App;
use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

/// 分区标题：===== 标题 =====
fn section(title: &str) -> Line<'static> {
    Line::from(Span::styled(
        format!("  ===== {} =====", title),
        Style::default()
            .fg(Color::White)
            .add_modifier(Modifier::BOLD),
    ))
}

/// [标签] + 值 两列条目（标签绿色、值青色）
fn entry(label: &str, value: &str) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("  [{}]  ", label), Style::default().fg(Color::Green)),
        Span::styled(value.to_string(), Style::default().fg(Color::Cyan)),
    ])
}

/// 灰色说明行
fn note(text: &str) -> Line<'static> {
    Line::from(Span::styled(
        format!("  {}", text),
        Style::default().fg(Color::DarkGray),
    ))
}

pub fn render(frame: &mut Frame, _app: &App) {
    let area = frame.area();

    let block = Block::default()
        .title(" 配置向导 ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let lines = vec![
        Line::from(""),
        // 一行提示（CARP 指定合并为一行）
        Line::from(Span::styled(
            "  VCP 安装完成，以下是常用入口和配置指引。首次使用时请逐项检查并配置。",
            Style::default().fg(Color::White),
        )),
        Line::from(""),
        section("本地 AI 框架"),
        entry("官方仓库", "https://github.com/ggml-org/llama.cpp/releases"),
        entry("汉化界面", "https://github.com/IIIIIllllIIIIIlllll/llama.cpp-hub/releases"),
        entry("模型推荐", "Qwen3.6-27B\\Qwen3.6-35B-A3B"),
        note("本地部署AI模型，无需联网即可对话，需要同时配备 LLM 和 Embedding 两种模型，获得推理服务地址。"),
        Line::from(""),
        section("云端 API 服务"),
        entry("硅基流动", "https://siliconflow.cn/models"),
        entry("千问平台", "https://www.qianwenai.com/models"),
        note("云端接入，注册获得 API Key，多模型种类可选，大模型能力优秀，小模型可免费使用。"),
        Line::from(""),
        section("后端管理面板"),
        entry("启动程序", "start-backend.bat"),
        entry("配置入口", "http://localhost:6006/AdminPanel/"),
        note("修改关键配置文件 VCPToolBox\\config.env，建议用浏览器登录配置界面，初始帐号密码见 config.env 内部。"),
        Line::from(""),
        section("前端交互界面"),
        entry("启动程序", "start-frontend.bat"),
        note("VCPChat 聊天主界面，先创建对话助手，并修改全局设置参数。使用多个助手，还需返回 VCPToolBox 做相应配置。"),
        Line::from(""),
        section("VCP 百科全书"),
        entry("帮助文件", "查看 VCPToolBox\\knowledge 里面的帮助文档，推荐先看 VCP知识\\35_小白入门教程_VCP快速上手.txt"),
        Line::from(""),
        Line::from(Span::styled(
            "  按 Q / Enter 退出安装程序",
            Style::default().fg(Color::DarkGray),
        )),
    ];

    let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
    frame.render_widget(paragraph, inner);
}
