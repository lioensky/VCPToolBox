mod app;
mod installer;
mod runtime;
mod ui;
mod utils;
mod web_config;
mod web_config_html;

use anyhow::Result;
use app::{
    App, AppState, Component, DependencyStatus, DownloadProgress, EnvCheckEvent, EnvCheckResult,
    GithubMirror, InstallProgress, ProgressEvent, StepStatus,
};
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::CrosstermBackend, Terminal};
use std::{io, time::Duration};
use tokio::sync::mpsc;
use tokio::time::sleep;
use utils::platform;

#[tokio::main]
async fn main() -> Result<()> {
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

fn run_app(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> Result<()> {
    let mut app = App::new();

    loop {
        terminal.draw(|frame| match &app.state {
            AppState::Welcome => ui::welcome::render(frame, &app),
            AppState::EnvCheck => ui::env_check::render(frame, &app),
            AppState::ComponentSelect => ui::component_select::render(frame, &app),
            AppState::ConfigForm => ui::config_form::render(frame, &app),
            AppState::Installing => ui::progress::render(frame, &app),
            AppState::Complete => ui::complete::render(frame, &app),
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
                        if app.state != AppState::Installing && app.state != AppState::Complete {
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
                if app.env_check_done {
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
                let max_index = Component::all().len().saturating_sub(1);
                if app.component_cursor < max_index {
                    app.component_cursor += 1;
                }
            }
            KeyCode::Char(' ') => {
                app.toggle_component_at_cursor();
            }
            KeyCode::Enter => {
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
            KeyCode::Enter | KeyCode::Char('q') | KeyCode::Char('Q') => {
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

    let install_path = app.config.install_path.clone();
    let (tx, rx) = mpsc::channel(1);
    app.env_check_rx = Some(rx);

    tokio::spawn(async move {
        let (
            detect_result,
            recommended_mirror,
            _github_direct,
            _github_mirror,
            npm_direct,
            npm_mirror,
            pip_direct,
            pip_mirror,
        ) = tokio::join!(
            installer::detector::detect_environment(&install_path),
            utils::network::recommend_mirror(),
            utils::network::test_github_direct(),
            utils::network::test_github_mirror(),
            utils::network::test_npm_registry(false),
            utils::network::test_npm_registry(true),
            utils::network::test_pip_source(false),
            utils::network::test_pip_source(true),
        );

        // detector返回EnvCheckResult直接值（非Result），不需要match
        let mut result = detect_result;

        // 用network模块的结果覆盖detector的简单检测
        result.network_github =
            _github_direct.is_some() || _github_mirror.is_some();
        result.network_npm = npm_direct || npm_mirror;

        let pip_source_ok = pip_direct || pip_mirror;
        let use_npm_mirror = !npm_direct && npm_mirror;
        let use_pip_mirror = !pip_direct && pip_mirror;

        let _ = tx
            .send(EnvCheckEvent::Completed {
                result,
                mirror: recommended_mirror,
                use_npm_mirror,
                use_pip_mirror,
                pip_source_ok,
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
            use_npm_mirror,
            use_pip_mirror,
            pip_source_ok,
            error,
        } => {
            app.env_check = result;
            app.config.mirror = mirror;
            app.config.use_npm_mirror = use_npm_mirror;
            app.config.use_pip_mirror = use_pip_mirror;
            app.pip_source_ok = pip_source_ok;
            app.env_check_error = error;
            app.env_check_done = true;
        }
    }
}

// ==========================================
//  真实安装（P3收尾：替换mock入口）
// ==========================================

fn start_real_install(app: &mut App) {
    app.apply_config_form();

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

    let config = app.config.clone();
    tokio::spawn(async move {
        if let Err(e) = installer::run_installation(config, tx).await {
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

            let _ = tx
                .send(ProgressEvent::Log(format!("开始: {}", step_name)))
                .await;

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

            let _ = tx
                .send(ProgressEvent::Log(format!("完成: {}", step_name)))
                .await;

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
            // 方案C: 安装完成时自动dump日志到文件
            if !app.log_messages.is_empty() {
                let log_path = app.config.install_path.join("install_log.txt");
                let log_content = app.log_messages.join("\n");
                let _ = std::fs::write(&log_path, &log_content);
            }
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
    // 实时追加写入日志文件（即使进程崩溃也不丢）
    {
        use std::io::Write;
        let log_path = app.config.install_path.join("install_log.txt");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            let _ = writeln!(f, "{}", &msg);
        }
    }
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
