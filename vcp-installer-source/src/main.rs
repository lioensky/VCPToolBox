mod app;
mod cache;
mod env_log;
mod installer;
mod log_router;
mod mirrors;
mod runtime;
mod ui;
mod utils;
mod web_config;
mod web_config_html;

use anyhow::Result;
use app::{
    App, AppState, Component, DependencyStatus, DownloadProgress, EnvCheckEvent, EnvCheckResult,
    GithubMirror, InstallMethod, InstallProgress, ProgressEvent, StepStatus,
};
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::CrosstermBackend, Terminal, text::{Line, Span}, style::{Style, Color}, widgets::Paragraph};
use ratatui::layout::Rect;
use std::{io, time::Duration};
use tokio::sync::mpsc;
use tokio::time::sleep;
use utils::platform;

#[tokio::main]
async fn main() -> Result<()> {
    // Headless 模式: --headless [OPTIONS]
    //   --install-dir <path>       安装路径（默认: ./VCP_AIOS）
    //   --mirror-config <path>     镜像配置文件（默认: vcp-mirrors.ini）
    let args: Vec<String> = std::env::args().collect();
    // UI 预览模式: --ui-preview
    //   仅渲染 6 个安装页面（填充 mock 数据），不触发真实安装。
    //   键位: PgDn 下一页 / PgUp 上一页 / Q 退出
    if args.len() >= 2 && args[1] == "--ui-preview" {
        if let Err(err) = run_ui_preview() {
            eprintln!("Error: {err:?}");
            return Ok(());
        }
        return Ok(());
    }
    if args.len() >= 2 && args[1] == "--headless" {
        let mut install_path_str = None;
        let mut mirror_config_path_str = None;
        let mut env_check_only = false;
        let mut i = 2;
        while i < args.len() {
            match args[i].as_str() {
                "--install-dir" => {
                    i += 1;
                    if i < args.len() {
                        install_path_str = Some(args[i].clone());
                    }
                }
                "--mirror-config" => {
                    i += 1;
                    if i < args.len() {
                        mirror_config_path_str = Some(args[i].clone());
                    }
                }
                "--env-check-only" => {
                    env_check_only = true;
                }
                arg if !arg.starts_with("--") => {
                    // 向后兼容: 位置参数作为 install_path
                    if install_path_str.is_none() {
                        install_path_str = Some(arg.to_string());
                    }
                }
                _ => {}
            }
            i += 1;
        }
        let install_path = msys_to_native_path(
            &install_path_str.unwrap_or_else(|| "VCP_AIOS".to_string()),
        );
        // 转为绝对路径，避免后续 subprocess 路径解析错误
        // 2026-08-23 修复：strip_extended_prefix 去掉 Windows 长路径 \\?\ 前缀——
        // npm/better-sqlite3 等工具不识别该前缀，会导致 "系统找不到指定的路径"
        let canonical = install_path
            .canonicalize()
            .unwrap_or(install_path);
        let install_path = std::path::PathBuf::from(utils::normalize_path_display(
            &utils::strip_extended_prefix(&canonical).to_string_lossy(),
        ));
        run_headless(install_path, mirror_config_path_str, env_check_only).await?;
        return Ok(());
    }

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;

    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let result = run_app(&mut terminal);

    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen
    )?;
    terminal.show_cursor()?;

    if let Err(err) = &result {
        eprintln!("Error: {err:?}");
    }

    // 安装完成后启动 Web 配置向导
    if result.is_ok() {
        let install_dir = std::env::current_dir().unwrap_or_default();
        if install_dir.join("VCPToolBox").exists() {
            println!();
            println!("  [VCP] 安装完成，正在启动配置向导...");
            if let Err(e) = web_config::start_web_config(&install_dir) {
                eprintln!("  [VCP] 配置向导出错: {:#}", e);
            }
        }
    }

    Ok(())
}

// ==========================================
//  UI 预览模式：仅渲染页面，不触发安装
// ==========================================

fn run_ui_preview() -> Result<()> {
    let mirror_config = mirrors::load_mirror_config(&mirrors::get_config_path())?;

    let mut app = App::new(mirror_config);

    // 填充 mock 数据，使各页面有内容可渲染
    app.component_cursor = 0;
    app.config_form_cursor = 0;
    app.config_form_buffers = vec![
        "D:\\Desktop\\VCP_AIOS_preview".to_string(),
        "test_user".to_string(),
        "http://localhost:3000/v1".to_string(),
        "6005".to_string(),
    ];

    // 环境检测页面：填充 mock 结果
    app.set_mock_env_check(
        "Windows 10 IoT Enterprise LTSC 2021".to_string(),
        256.0,
    );
    app.env_check_done = true;

    // 组件选择页面：默认选中 VCPToolBox + VCPChat + NewAPI + MSVC
    app.config.components = vec![
        Component::VCPToolBox,
        Component::VCPChat,
        Component::NewAPI,
        Component::MSVCBuildTools,
    ];
    app.install_method = InstallMethod::TarballGit;
    app.detect_pre_installed();

    // 安装进度页面：填充 mock 步骤
    app.install_progress = Some(app.build_mock_install_progress());
    if let Some(ref mut progress) = app.install_progress {
        // 标记前两个步骤完成，第三个运行中
        if progress.steps.len() > 0 {
            progress.steps[0].status = StepStatus::Completed;
        }
        if progress.steps.len() > 1 {
            progress.steps[1].status = StepStatus::Completed;
        }
        if progress.steps.len() > 2 {
            progress.steps[2].status = StepStatus::Running;
            progress.steps[2].download_progress = Some(DownloadProgress {
                downloaded_bytes: 32 * 1024 * 1024,
                total_bytes: 64 * 1024 * 1024,
            });
        }
        progress.current_step_index = 2;
        progress.recalculate_overall_percentage();
    }

    // 完成页面：填充 mock 安装结果
    app.install_result = Some(app.build_mock_install_result(true));

    // 预置一些日志消息
    app.log_messages = vec![
        "[INFO] 开始安装...".to_string(),
        "[INFO] 步骤 1/8: 检查安装目录 ... OK".to_string(),
        "[INFO] 步骤 2/8: 准备 Portable 运行时 ... OK".to_string(),
        "[INFO] 步骤 3/8: 克隆 VCPToolBox ... 下载中 50.0%".to_string(),
    ];

    // 7 个页面的名称（用于底部提示）
    let page_names = [
        "Welcome (欢迎页)",
        "EnvCheck (环境检测)",
        "ComponentSelect (组件选择)",
        "ConfigForm (配置表单)",
        "Installing (安装进度)",
        "Complete (完成页)",
        "ConfigGuide (配置向导)",
    ];

    // 当前预览的页面索引（0-6）
    let mut current_page_idx = 0usize;

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;

    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let page_states = [
        AppState::Welcome,
        AppState::EnvCheck,
        AppState::ComponentSelect,
        AppState::ConfigForm,
        AppState::Installing,
        AppState::Complete,
        AppState::ConfigGuide,
    ];

    loop {
        // 渲染当前预览的页面 + 底部导航提示（单次 draw，避免二次清屏覆盖）
        app.state = page_states[current_page_idx].clone();
        let current_idx = current_page_idx;
        let nav_text = format!(
            "[UI Preview] {} ({}/{})  |  PgDn 下一页 / PgUp 上一页 / Q 退出",
            page_names[current_idx],
            current_idx + 1,
            page_names.len(),
        );
        terminal.draw(|frame| {
            match &app.state {
                AppState::Welcome => ui::welcome::render(frame, &app),
                AppState::EnvCheck => ui::env_check::render(frame, &app),
                AppState::ComponentSelect => ui::component_select::render(frame, &app),
                AppState::ConfigForm => ui::config_form::render(frame, &app),
                AppState::Installing => ui::progress::render(frame, &app),
                AppState::Complete => ui::complete::render(frame, &app),
                AppState::ConfigGuide => ui::config_guide::render(frame, &app),
            }

            // 在底部覆盖一行导航提示
            let area = frame.area();
            let nav_line = Line::from(vec![
                Span::raw(" "),
                Span::styled(nav_text, Style::default().fg(Color::Yellow)),
                Span::raw(" "),
            ]);
            let nav_area = Rect::new(0, area.height.saturating_sub(1), area.width, 1);
            frame.render_widget(
                Paragraph::new(nav_line)
                    .style(Style::default().bg(Color::Black).fg(Color::Yellow)),
                nav_area,
            );
        })?;

        // 处理按键
        if event::poll(Duration::from_millis(100))? {
            if let Event::Key(key) = event::read()? {
                if key.kind != KeyEventKind::Press {
                    continue;
                }

                match key.code {
                    KeyCode::Char('q') | KeyCode::Char('Q') | KeyCode::Esc => {
                        app.should_quit = true;
                        break;
                    }
                    KeyCode::PageUp => {
                        if current_page_idx > 0 {
                            current_page_idx -= 1;
                        }
                    }
                    KeyCode::PageDown => {
                        current_page_idx = (current_page_idx + 1).min(page_names.len() - 1);
                    }
                    _ => {}
                }
            }
        }

        if app.should_quit {
            break;
        }
    }

    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen
    )?;
    terminal.show_cursor()?;

    Ok(())
}

/// Headless 模式：直接运行完整安装流程（不启动 TUI）
async fn run_headless(
    install_path: std::path::PathBuf,
    mirror_config_path_str: Option<String>,
    env_check_only: bool,
) -> Result<()> {

    // 加载镜像配置（优先使用 --mirror-config 指定路径）
    let mirror_config_path: std::path::PathBuf = if let Some(path_str) = mirror_config_path_str {
        msys_to_native_path(&path_str)
    } else {
        mirrors::get_config_path()
    };
    let mirror_config = mirrors::load_mirror_config(&mirror_config_path)?;
    let dl_runtimes_dir = mirrors::get_exe_dir().join("DL_runtimes");

    // 日志目录：exe 同级 Install_log（与 TUI 模式一致）
    let log_dir = log_router::init_log_dir(&install_path);
    let log_path = log_dir.join("00_full_log.txt");

    // 清空旧日志
    let _ = std::fs::create_dir_all(&install_path);

    println!("[HEADLESS] VCP Installer Headless Mode");
    println!("[HEADLESS] 安装路径: {}", install_path.display());
    println!("[HEADLESS] DL_runtimes: {}", dl_runtimes_dir.display());
    println!("[HEADLESS] 日志目录: {}", log_dir.display());
    println!("[HEADLESS] 全量日志: {}", log_path.display());
    println!("[HEADLESS] 开始环境检测...");

    // 运行环境检测
    let (tx_env, mut rx_env) = mpsc::channel(1);
    let install_path_clone = install_path.clone();
    let github_entries = mirror_config.github.clone();
    let npm_entries = mirror_config.npm.clone();
    let pip_entries = mirror_config.pip.clone();
    let msvc_entries = mirror_config.msvc.clone();

    tokio::spawn(async move {
        let (
            detect_result,
            github_direct,
            npm_official,
            (npm_rec, npm_results),
            pip_official,
            (pip_rec, pip_results),
            msvc_source_reachable,
        ) = tokio::join!(
            installer::detector::detect_environment(&install_path_clone),
            utils::network::test_github_direct(),
            utils::network::test_npm_registry_official(),
            utils::network::recommend_npm_mirror(&npm_entries),
            utils::network::test_pip_source_official(),
            utils::network::recommend_pip_mirror(&pip_entries),
            utils::network::test_msvc_source_reachable(&msvc_entries),
        );

        let mut result = detect_result;
        // GitHub：直连可达 OR 任一备用镜像站可达（与 TUI 路径一致）
        let github_results_probe = if github_entries.is_empty() {
            Vec::new()
        } else {
            utils::network::test_all_github_mirrors(&github_entries).await
        };
        result.network_github = github_direct.is_some()
            || github_results_probe.iter().any(|r| r.is_reachable());
        result.network_npm = npm_official || npm_results.iter().any(|r| r.is_reachable());

        // 环境检测只判断连通性，不推荐具体镜像（交给安装时的完整下载测试）
        let mirror: GithubMirror = if github_direct.is_some() {
            GithubMirror::Direct
        } else {
            GithubMirror::Direct
        };

        // 2026-08-21 拔线测试修复：优先使用国内镜像（npmmirror），
        // 只有国内镜像不可达时才回退到官方源（npmjs.org）。
        // 之前逻辑：!npm_official && npm_rec.is_some() → 官方源通就用官方源，
        // 但 better-sqlite3/electron 的二进制硬编码 npmmirror，自相矛盾。
        let npm_mirror = app::NpmMirrorChoice {
            use_mirror: npm_rec.is_some(),
            mirror_index: npm_rec.unwrap_or(0),
        };

        let pip_mirror = app::PipMirrorChoice {
            use_mirror: pip_rec.is_some(),
            mirror_index: pip_rec.unwrap_or(0),
        };

        let _ = tx_env
            .send((result, mirror, npm_mirror, pip_mirror, Vec::<crate::mirrors::MirrorResult>::new(), msvc_source_reachable))
            .await;
    });

    let (env_check, mirror, npm_mirror, pip_mirror, _github_results, msvc_source_reachable) = rx_env.recv().await
        .ok_or_else(|| anyhow::anyhow!("环境检测任务未返回"))?;

    // 打印环境检测结果
    println!("[HEADLESS] === 环境检测结果 ===");
    println!("[HEADLESS] Git: {:?}", env_check.git);
    println!("[HEADLESS] Node.js: {:?}", env_check.node);
    println!("[HEADLESS] Python: {:?}", env_check.python);
    println!("[HEADLESS] MSVC: {:?}", env_check.msvc);
    println!("[HEADLESS] 磁盘空间: {:.1}GB (OK={})", env_check.disk_space_gb, env_check.disk_space_ok);
    println!("[HEADLESS] GitHub 网络: {}", env_check.network_github);
    println!("[HEADLESS] npm 网络: {}", env_check.network_npm);
    println!("[HEADLESS] MSVC 下载源: {}", if msvc_source_reachable { "可达" } else { "不可达" });
    println!("[HEADLESS] GitHub 镜像: {}", mirror.prefix(&mirror_config));
    println!("[HEADLESS] npm 镜像: use={} index={}", npm_mirror.use_mirror, npm_mirror.mirror_index);
    println!("[HEADLESS] pip 镜像: use={} index={}", pip_mirror.use_mirror, pip_mirror.mirror_index);

    // --env-check-only 模式：只做环境检测，打印结果后立即返回（供自动验证脚本用）
    if env_check_only {
        println!("[HEADLESS] === 环境检测完成（--env-check-only，跳过安装）===");
        return Ok(());
    }

    println!("[HEADLESS] 开始安装...");

    // 构建安装配置（headless 模式：VCPToolBox + VCPChat，不含 NewAPI/VCPDistributedServer/VCPBackUpDEV 以加快测试）
    // MSVC Build Tools 由 Stage::Msvc 阶段独立安装，不依赖组件选择
    let config = app::InstallConfig {
        install_path: install_path.clone(),
        components: vec![
            Component::VCPToolBox,
            Component::VCPChat,
        ],
        mirror,
        npm_mirror,
        pip_mirror,
        api_endpoint: "http://localhost:3000/v1".to_string(),
        api_key: String::new(),
        admin_password: String::from("headless_test"),
        tool_auth_code: String::from("headless_test"),
        server_port: 6005,
        install_method: app::InstallMethod::TarballGit,
    };

    // 构建安装步骤
    let steps = installer::build_install_steps(&config);
    let mut step_index = 0;

    // 启动安装流程
    let (tx, mut rx) = mpsc::channel(64);

    let config_clone = config.clone();
    let mirror_config_clone = mirror_config.clone();
    let dl_runtimes_dir_clone = dl_runtimes_dir.clone();

    let mut install_handle = tokio::spawn(async move {
        installer::run_installation(
            config_clone,
            mirror_config_clone,
            Vec::new(),
            dl_runtimes_dir_clone,
            tx,
            env_check,
        )
        .await
    });

    // 处理事件，实时输出到控制台和日志文件
    loop {
        tokio::select! {
            biased;

            event = rx.recv() => {
                match event {
                    Some(ProgressEvent::StepStarted { step_index: idx }) => {
                        let name = steps.get(idx).map(|s| s.name.as_str()).unwrap_or("?");
                        println!("[HEADLESS] >>> [{}/{}] {}", idx + 1, steps.len(), name);
                        log_line(&log_path, &format!("[{}] >>> {}", idx + 1, name));
                    }
                    Some(ProgressEvent::DownloadProgress { step_index: idx, downloaded, total }) => {
                        let pct = if total > 0 { (downloaded as f64 / total as f64) * 100.0 } else { 0.0 };
                        println!("[HEADLESS]       {:.1}% ({:.1}/{:.1} MB)", pct, downloaded as f64 / 1_048_576.0, total as f64 / 1_048_576.0);
                    }
                    Some(ProgressEvent::StepCompleted { step_index: idx }) => {
                        let name = steps.get(idx).map(|s| s.name.as_str()).unwrap_or("?");
                        println!("[HEADLESS] ✅ [{}/{}] {}", idx + 1, steps.len(), name);
                        log_line(&log_path, &format!("[{}] ✅ {}", idx + 1, name));
                    }
                    Some(ProgressEvent::StepFailed { step_index: idx, error }) => {
                        let name = steps.get(idx).map(|s| s.name.as_str()).unwrap_or("?");
                        println!("[HEADLESS] ❌ [{}/{}] {} — {}", idx + 1, steps.len(), name, error);
                        log_line(&log_path, &format!("[{}] ❌ {} — {}", idx + 1, name, error));
                    }
                    Some(ProgressEvent::StepSkipped { step_index: idx }) => {
                        let name = steps.get(idx).map(|s| s.name.as_str()).unwrap_or("?");
                        println!("[HEADLESS] ⏭ [{}/{}] {} (跳过)", idx + 1, steps.len(), name);
                        log_line(&log_path, &format!("[{}] ⏭ {}", idx + 1, name));
                    }
                    Some(ProgressEvent::AllCompleted(result)) => {
                        println!("[HEADLESS] === 安装完成 ===");
                        println!("[HEADLESS] 成功: {}", result.success);
                        println!("[HEADLESS] 已安装运行时: {:?}", result.installed_runtimes);
                        println!("[HEADLESS] 已安装应用组件: {:?}", result.installed_components);
                        println!("[HEADLESS] 后端脚本: {:?}", result.backend_start_script);
                        println!("[HEADLESS] 前端脚本: {:?}", result.frontend_start_script);
                        if !result.errors.is_empty() {
                            println!("[HEADLESS] 错误:");
                            for e in &result.errors {
                                println!("[HEADLESS]   - {}", e);
                            }
                        }
                        log_line(&log_path, "=== 安装完成 ===");
                        if !result.errors.is_empty() {
                            for e in &result.errors {
                                log_line(&log_path, &format!("错误: {}", e));
                            }
                        }
                        drop(rx);
                        break;
                    }
                    Some(ProgressEvent::Log(msg)) => {
                        // 打印日志（多行也处理）
                        for line in msg.lines() {
                            println!("[HEADLESS] {}", line);
                            log_line(&log_path, line);
                        }
                    }
                    None => {
                        println!("[HEADLESS] ⚠ 进度通道已关闭，但未收到 AllCompleted");
                        break;
                    }
                }
            }

            res = (&mut install_handle) => {
                match res {
                    Ok(Ok(r)) => {
                        println!("[HEADLESS] 安装任务正常结束: success={}", r.success);
                    }
                    Ok(Err(e)) => {
                        println!("[HEADLESS] ❌ 安装任务异常: {:?}", e);
                        log_line(&log_path, &format!("安装任务异常: {:?}", e));
                    }
                    Err(e) => {
                        println!("[HEADLESS] ❌ 安装任务 panic: {:?}", e);
                        log_line(&log_path, &format!("安装任务 panic: {:?}", e));
                    }
                }
                break;
            }
        }
    }

    Ok(())
}

fn log_line(_path: &std::path::Path, _line: &str) {
    // 新日志架构（分段实时写 + 安装结束后合并全量）下，
    // headless 事件处理器不再直接写 00_full_log.txt：
    //   - Log 消息由 log_router::append_log 实时写入分段文件（01~07）
    //   - 全量日志 00_full_log.txt 由 log_router::merge_full_log 在安装结束后合并生成
    // headless 的控制台输出仍由各调用点的 println! 负责。
    // 此函数保留为占位（各调用点不变），从结构上消除 headless 侧的双写/重复。
}

/// 将 MSYS2/Git Bash 路径转换为 Windows 原生路径
/// /d/Desktop/foo → D:\Desktop\foo
fn msys_to_native_path(path: &str) -> std::path::PathBuf {
    // 如果是 MSYS 格式路径：/X/...
    if path.starts_with('/') && path.chars().nth(1).map(|c| c.is_ascii_alphabetic()).unwrap_or(false) && path.chars().nth(2) == Some('/') {
        let drive = path.chars().nth(1).unwrap().to_ascii_uppercase().to_string();
        let rest = &path[2..];
        let win_path = format!("{}:\\{}", drive, rest.replace('/', "\\"));
        std::path::PathBuf::from(win_path)
    } else {
        // 已经是 Windows 路径或非 MSYS 路径
        std::path::PathBuf::from(path)
    }
}

fn run_app(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> Result<()> {
    // 加载镜像配置（从 exe 同级的 vcp-mirrors.ini）
    let mirror_config = mirrors::load_mirror_config(&mirrors::get_config_path())?;

    let mut app = App::new(mirror_config);

    loop {
        terminal.draw(|frame| match &app.state {
            AppState::Welcome => ui::welcome::render(frame, &app),
            AppState::EnvCheck => ui::env_check::render(frame, &app),
            AppState::ComponentSelect => ui::component_select::render(frame, &app),
            AppState::ConfigForm => ui::config_form::render(frame, &app),
            AppState::Installing => ui::progress::render(frame, &app),
            AppState::Complete => ui::complete::render(frame, &app),
            AppState::ConfigGuide => ui::config_guide::render(frame, &app),
        })?;

        // 非阻塞轮询环境检测事件
        if let Some(mut rx) = app.env_check_rx.take() {
            while let Ok(event) = rx.try_recv() {
                handle_env_check_event(&mut app, event);
            }
            if !app.env_check_done {
                app.env_check_rx = Some(rx);
            }
        }

        // 非阻塞轮询安装进度事件
        let mut pending_events = Vec::new();
        if let Some(rx) = app.progress_rx.as_mut() {
            while let Ok(event) = rx.try_recv() {
                pending_events.push(event);
            }
        }
        for event in pending_events {
            handle_progress_event(&mut app, event);
        }

        if event::poll(Duration::from_millis(100))? {
            if let Event::Key(key) = event::read()? {
                if key.kind != KeyEventKind::Press {
                    continue;
                }

                match key.code {
                    KeyCode::Char('q') | KeyCode::Char('Q') => {
                        if app.state != AppState::Installing {
                            app.should_quit = true;
                        }
                    }
                    KeyCode::Esc => {
                        if app.state != AppState::Installing
                            && app.state != AppState::Complete
                            && app.state != AppState::ConfigGuide
                        {
                            app.prev_page();
                        }
                    }
                    other => handle_page_input(&mut app, other),
                }
            }
        }

        if app.should_quit {
            break;
        }
    }

    Ok(())
}

fn handle_page_input(app: &mut App, key: KeyCode) {
    match app.state.clone() {
        AppState::Welcome => {
            if key == KeyCode::Enter {
                app.next_page();
                spawn_env_check(app);
            }
        }
        AppState::EnvCheck => match key {
            KeyCode::Enter => {
                if app.env_check_done && app.env_check.network_github {
                    app.next_page();
                }
            }
            KeyCode::Char('r') | KeyCode::Char('R') => {
                spawn_env_check(app);
            }
            _ => {}
        },
        AppState::ComponentSelect => match key {
            KeyCode::Up => {
                if app.component_cursor > 0 {
                    app.component_cursor -= 1;
                }
            }
            KeyCode::Down => {
                // 总项目数 = 6个组件 + 2个安装方式 = 8
                const TOTAL_ITEMS: usize = 8;
                if app.component_cursor < TOTAL_ITEMS - 1 {
                    app.component_cursor += 1;
                }
            }
            KeyCode::Char(' ') => {
                // 组件区 (0-5): 空格切换勾选状态
                // 方式区 (6-7): 空格切换安装方式
                if app.component_cursor < 6 {
                    app.toggle_component_at_cursor();
                } else {
                    app.toggle_install_method();
                }
            }
            KeyCode::Enter => {
                // 确认选择，进入配置页面
                app.init_config_form();
                app.next_page();
            }
            _ => {}
        },
        AppState::ConfigForm => {
            let should_start = ui::config_form::handle_input(app, key);
            if should_start {
                app.log_messages.clear();
                app.log_scroll = 0;
                start_real_install(app);
            }
        }
        AppState::Installing => match key {
            KeyCode::Up => {
                let max_scroll = app.log_messages.len().saturating_sub(1);
                app.log_scroll = (app.log_scroll + 1).min(max_scroll);
            }
            KeyCode::Down => {
                app.log_scroll = app.log_scroll.saturating_sub(1);
            }
            KeyCode::PageUp => {
                let max_scroll = app.log_messages.len().saturating_sub(1);
                app.log_scroll = (app.log_scroll + 5).min(max_scroll);
            }
            KeyCode::PageDown => {
                app.log_scroll = app.log_scroll.saturating_sub(5);
            }
            _ => {}
        },
        AppState::Complete => match key {
            KeyCode::Enter => {
                // 进入第七页：配置向导
                app.state = AppState::ConfigGuide;
            }
            KeyCode::Char('q') | KeyCode::Char('Q') => {
                app.should_quit = true;
            }
            KeyCode::Up => {
                app.complete_scroll = app.complete_scroll.saturating_add(1);
            }
            KeyCode::Down => {
                app.complete_scroll = app.complete_scroll.saturating_sub(1);
            }
            KeyCode::PageUp => {
                app.complete_scroll = app.complete_scroll.saturating_add(5);
            }
            KeyCode::PageDown => {
                app.complete_scroll = app.complete_scroll.saturating_sub(5);
            }
            KeyCode::Char('o') | KeyCode::Char('O') => {
                #[cfg(windows)]
                {
                    let path = app
                        .install_result
                        .as_ref()
                        .map(|r| r.install_path.clone())
                        .unwrap_or_else(|| app.config.install_path.clone());

                    let _ = std::process::Command::new("explorer")
                        .arg(path.as_os_str())
                        .spawn();
                }
            }
            _ => {}
        },
        AppState::ConfigGuide => match key {
            KeyCode::Enter | KeyCode::Char('q') | KeyCode::Char('Q') | KeyCode::Esc => {
                app.should_quit = true;
            }
            _ => {}
        },
    }
}

// ==========================================
//  环境检测（异步后台任务）
// ==========================================

fn spawn_env_check(app: &mut App) {
    app.env_check = EnvCheckResult::default();
    app.env_check_done = false;
    app.env_check_error = None;
    app.pip_source_ok = false;
    app.msvc_source_ok = false;
    app.github_results.clear();
    app.npm_results.clear();
    app.pip_results.clear();

    let install_path = app.config.install_path.clone();
    let github_entries = app.mirror_config.github.clone();
    let npm_entries = app.mirror_config.npm.clone();
    let pip_entries = app.mirror_config.pip.clone();
    let msvc_entries = app.mirror_config.msvc.clone();
    let (tx, rx) = mpsc::channel(1);
    app.env_check_rx = Some(rx);

    tokio::spawn(async move {
        let (detect_result, github_direct, npm_official, (npm_rec, npm_results), pip_official, (pip_rec, pip_results), msvc_source_reachable) = tokio::join!(
            installer::detector::detect_environment(&install_path),
            utils::network::test_github_direct(),
            utils::network::test_npm_registry_official(),
            utils::network::recommend_npm_mirror(&npm_entries),
            utils::network::test_pip_source_official(),
            utils::network::recommend_pip_mirror(&pip_entries),
            utils::network::test_msvc_source_reachable(&msvc_entries),
        );

        let mut result = detect_result;

        // GitHub：直连可达 OR 任一备用镜像站可达（真实探测，不再用「配置里有就报可达」）
        // test_all_github_mirrors 内部已并发探测全部站点，复用即可
        let github_results_probe = if github_entries.is_empty() {
            Vec::new()
        } else {
            utils::network::test_all_github_mirrors(&github_entries).await
        };
        result.network_github = github_direct.is_some()
            || github_results_probe.iter().any(|r| r.is_reachable());

        result.network_npm = npm_official || npm_results.iter().any(|r| r.is_reachable());

        let pip_source_ok = pip_official || pip_results.iter().any(|r| r.is_reachable());
        let msvc_source_ok = msvc_source_reachable;

        // 环境检测只判断连通性，不推荐具体镜像（交给安装时的完整下载测试）
        let mirror: GithubMirror = if github_direct.is_some() {
            GithubMirror::Direct
        } else {
            GithubMirror::Direct
        };

        // 2026-08-21 拔线测试修复：优先使用国内镜像（npmmirror），
        // 只有国内镜像不可达时才回退到官方源（npmjs.org）。
        // 之前逻辑：!npm_official && npm_rec.is_some() → 官方源通就用官方源，
        // 但 better-sqlite3/electron 的二进制硬编码 npmmirror，自相矛盾。
        let npm_mirror = app::NpmMirrorChoice {
            use_mirror: npm_rec.is_some(),
            mirror_index: npm_rec.unwrap_or(0),
        };

        let pip_mirror = app::PipMirrorChoice {
            use_mirror: pip_rec.is_some(),
            mirror_index: pip_rec.unwrap_or(0),
        };

        let _ = tx
            .send(EnvCheckEvent::Completed {
                result,
                mirror,
                npm_mirror,
                pip_mirror,
                github_results: Vec::new(),
                npm_results,
                pip_results,
                pip_source_ok,
                msvc_source_ok,
                error: None,
            })
            .await;
    });
}

fn handle_env_check_event(app: &mut App, event: EnvCheckEvent) {
    match event {
        EnvCheckEvent::Completed {
            result,
            mirror,
            npm_mirror,
            pip_mirror,
            github_results,
            npm_results,
            pip_results,
            pip_source_ok,
            msvc_source_ok,
            error,
        } => {
            app.env_check = result;
            app.config.mirror = mirror;
            app.config.npm_mirror = npm_mirror;
            app.config.pip_mirror = pip_mirror;
            app.github_results = github_results;
            app.npm_results = npm_results;
            app.pip_results = pip_results;
            app.pip_source_ok = pip_source_ok;
            app.msvc_source_ok = msvc_source_ok;
            app.env_check_error = error;
            app.env_check_done = true;

            // 环境检测完成后立即初始化日志目录（exe 同级）
            // init_log_dir 是进程内幂等的：run_installation 再次调用时不会清空日志。
            let _log_dir = crate::log_router::init_log_dir(&crate::mirrors::get_exe_dir());
        }
    }
}

// ==========================================
//  真实安装（P3收尾：替换mock入口）
// ==========================================

fn start_real_install(app: &mut App) {
    // 防御性同步：确保 TUI 选中的全局安装方式在启动安装前一定生效
    // （init_config_form 已做一次，这里再加一层保险，防止其他入口改动）
    app.config.install_method = app.install_method;

    app.apply_config_form();

    // Plan B: 用户点击"开始安装"时立即初始化日志目录
    // （创建 Install_log + 00_full_log.txt，设置全量日志路径）。
    // init_log_dir 是进程内幂等的：run_installation 内部再次调用时不会清空日志。
    // 这样全量日志在 run_installation 跑之前就绪，TUI 模式下 00_full_log.txt 必被创建。
    let install_path_for_log = app.config.install_path.clone();
    let _log_dir = crate::log_router::init_log_dir(&install_path_for_log);

    let steps = installer::build_install_steps(&app.config);
    let progress = InstallProgress {
        steps,
        current_step_index: 0,
        overall_percentage: 0.0,
    };

    let (tx, rx) = mpsc::channel(64);

    app.install_progress = Some(progress);
    app.install_result = None;
    app.progress_rx = Some(rx);
    app.state = AppState::Installing;

    let env_check = app.env_check.clone();
    let config = app.config.clone();
    let mirror_config = app.mirror_config.clone();
    let github_results = app.github_results.clone();
    let dl_runtimes_dir = crate::mirrors::get_exe_dir().join("DL_runtimes");
    tokio::spawn(async move {
        if let Err(e) = installer::run_installation(config, mirror_config, github_results, dl_runtimes_dir, tx, env_check).await {
            eprintln!("安装过程发生未预期错误: {:?}", e);
        }
    });
}

// ==========================================
//  模拟安装（保留备用）
// ==========================================

#[allow(dead_code)]
fn start_mock_install(app: &mut App) {
    let progress = app.build_mock_install_progress();
    let step_names = progress
        .steps
        .iter()
        .map(|step| step.name.clone())
        .collect::<Vec<_>>();

    let result = app.build_mock_install_result(true);
    let (tx, rx) = tokio::sync::mpsc::channel(64);

    app.install_progress = Some(progress);
    app.install_result = None;
    app.progress_rx = Some(rx);
    app.state = AppState::Installing;

    tokio::spawn(async move {
        for (step_index, step_name) in step_names.into_iter().enumerate() {
            if tx
                .send(ProgressEvent::StepStarted { step_index })
                .await
                .is_err()
            {
                return;
            }

            let _ = crate::log_router::send_log_event(&tx, format!("开始: {}", step_name)).await;

            let is_download_step = step_name.contains("下载") || step_name.contains("Portable");

            if is_download_step {
                let total = 64_u64 * 1024 * 1024;
                for chunk in 1..=8 {
                    let downloaded = total / 8 * chunk;
                    if tx
                        .send(ProgressEvent::DownloadProgress {
                            step_index,
                            downloaded,
                            total,
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    sleep(Duration::from_millis(120)).await;
                }
            } else {
                sleep(Duration::from_millis(300)).await;
            }

            let _ = crate::log_router::send_log_event(&tx, format!("完成: {}", step_name)).await;

            if tx
                .send(ProgressEvent::StepCompleted { step_index })
                .await
                .is_err()
            {
                return;
            }

            sleep(Duration::from_millis(120)).await;
        }

        let _ = tx.send(ProgressEvent::AllCompleted(result)).await;
    });
}

// ==========================================
//  进度事件处理
// ==========================================

fn handle_progress_event(app: &mut App, event: ProgressEvent) {
    match event {
        ProgressEvent::StepStarted { step_index } => {
            if let Some(progress) = app.install_progress.as_mut() {
                if let Some(step) = progress.steps.get_mut(step_index) {
                    step.status = StepStatus::Running;
                    step.download_progress = None;
                }
                progress.current_step_index = step_index;
            }
        }
        ProgressEvent::DownloadProgress {
            step_index,
            downloaded,
            total,
        } => {
            if let Some(progress) = app.install_progress.as_mut() {
                if let Some(step) = progress.steps.get_mut(step_index) {
                    step.status = StepStatus::Running;
                    step.download_progress = Some(DownloadProgress {
                        downloaded_bytes: downloaded,
                        total_bytes: total,
                    });
                }
                progress.current_step_index = step_index;
            }
        }
        ProgressEvent::StepCompleted { step_index } => {
            if let Some(progress) = app.install_progress.as_mut() {
                if let Some(step) = progress.steps.get_mut(step_index) {
                    step.status = StepStatus::Completed;
                }
                progress.current_step_index = step_index;
                progress.recalculate_overall_percentage();
            }
        }
        ProgressEvent::StepFailed { step_index, error } => {
            let step_name = app
                .install_progress
                .as_ref()
                .and_then(|p| p.steps.get(step_index))
                .map(|s| s.name.clone())
                .unwrap_or_else(|| format!("步骤 {}", step_index + 1));

            if let Some(progress) = app.install_progress.as_mut() {
                if let Some(step) = progress.steps.get_mut(step_index) {
                    step.status = StepStatus::Failed(error.clone());
                }
                progress.current_step_index = step_index;
                progress.recalculate_overall_percentage();
            }

            push_log(app, format!("{} 失败: {}", step_name, error));
        }
        ProgressEvent::StepSkipped { step_index } => {
            if let Some(progress) = app.install_progress.as_mut() {
                if let Some(step) = progress.steps.get_mut(step_index) {
                    step.status = StepStatus::Skipped;
                }
                progress.current_step_index = step_index;
                progress.recalculate_overall_percentage();
            }
        }
        ProgressEvent::AllCompleted(result) => {
            if let Some(progress) = app.install_progress.as_mut() {
                progress.overall_percentage = 100.0;
            }
            // 日志已由 push_log() 实时追加写入，无需再 dump（避免被截断的内存列表覆盖）
            app.install_result = Some(result);
            app.progress_rx = None;
            app.complete_scroll = 0;
            app.state = AppState::Complete;
        }
        ProgressEvent::Log(msg) => {
            push_log(app, msg);
        }
    }
}

fn push_log(app: &mut App, msg: String) {
    // 只更新内存日志（供 TUI 实时显示），不再写文件。
    // 全量日志 00_full_log.txt 由 log_router::merge_full_log 在安装结束后合并生成，
    // 因此 push_log 不再参与文件写入 —— 从结构上消除 TUI 侧的双写/重复。
    let keep_bottom = app.log_scroll == 0;

    app.log_messages.push(msg);

    if app.log_messages.len() > 200 {
        let overflow = app.log_messages.len() - 200;
        app.log_messages.drain(0..overflow);
    }

    if keep_bottom {
        app.log_scroll = 0;
    }
}
