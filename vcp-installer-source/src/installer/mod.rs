pub mod downloader;
pub mod extractor;
pub mod detector;
pub mod git_ops;
pub mod npm_ops;
pub mod pip_ops;
pub mod config_gen;
pub mod msvc_ops;

use std::future::Future;

use anyhow::Result;
use tokio::sync::mpsc;

use crate::app::{
    Component,
    DependencyStatus,
    GithubMirror,
    InstallConfig,
    InstallResult,
    InstallStep,
    ProgressEvent,
    StepStatus,
};
use crate::runtime::RuntimeManager;

/// 构建安装步骤列表（基于用户选择的组件）
pub fn build_install_steps(config: &InstallConfig) -> Vec<InstallStep> {
    let mut steps = vec![
        pending_step("下载 PortableGit"),
        pending_step("下载 Node.js"),
        pending_step("下载 Python"),
        pending_step("安装 MSVC Build Tools"),
    ];

    if config.components.contains(&Component::VCPToolBox) {
        steps.push(pending_step("克隆 VCPToolBox"));
        steps.push(pending_step("安装后端 Node.js 依赖"));
        steps.push(pending_step("安装后端 Python 依赖"));
        steps.push(pending_step("生成配置文件"));
    }

    if config.components.contains(&Component::VCPChat) {
        steps.push(pending_step("克隆 VCPChat"));
        steps.push(pending_step("安装前端 Node.js 依赖"));
        steps.push(pending_step("安装前端 Python 依赖"));
    }

    if config.components.contains(&Component::NewAPI) {
        steps.push(pending_step("下载 NewAPI"));
    }

    steps.push(pending_step("生成启动脚本"));
    steps
}

/// 执行完整安装流程
pub async fn run_installation(
    config: InstallConfig,
    progress_tx: mpsc::Sender<ProgressEvent>,
) -> Result<InstallResult> {
    let install_dir = config.install_path.clone();
    let runtimes_dir = install_dir.join("runtimes");

    let mut errors = Vec::new();
    let mut installed_components = Vec::new();
    let mut step_idx: usize = 0;

    // 确保安装目录存在
    if let Err(e) = tokio::fs::create_dir_all(&install_dir).await {
        errors.push(format!("创建安装目录失败: {}", e));
        let result = build_fail_result(&config, errors);
        let _ = progress_tx.send(ProgressEvent::AllCompleted(result.clone())).await;
        return Ok(result);
    }

    // ====== 阶段1: Portable 运行时 ======
    let mut runtime_mgr = RuntimeManager::new(&install_dir);
    let env_check = detector::detect_environment(&install_dir).await;

    if let Err(e) = runtime_mgr
        .ensure_all(&env_check, &config.mirror, progress_tx.clone(), step_idx)
        .await
    {
        errors.push(format!("运行时安装失败: {}", e));
        let result = build_fail_result(&config, errors);
        let _ = progress_tx.send(ProgressEvent::AllCompleted(result.clone())).await;
        return Ok(result);
    }

    step_idx += 3;

    // ====== MSVC Build Tools 安装（npm原生模块编译需要）======
    if matches!(env_check.msvc, DependencyStatus::NotFound) {
        let _ = progress_tx
            .send(ProgressEvent::StepStarted { step_index: step_idx })
            .await;
        match msvc_ops::install_msvc_build_tools(&progress_tx, &install_dir).await {
            Ok(()) => {
                let _ = progress_tx
                    .send(ProgressEvent::StepCompleted { step_index: step_idx })
                    .await;
            }
            Err(e) => {
                // MSVC 安装失败不阻断流程，只记录警告
                let _ = progress_tx
                    .send(ProgressEvent::StepFailed {
                        step_index: step_idx,
                        error: e.to_string(),
                    })
                    .await;
                send_log(
                    &progress_tx,
                    "⚠ MSVC 安装失败，npm install 的原生模块可能编译失败",
                )
                .await;
            }
        }
    } else {
        skip_step(
            &progress_tx,
            step_idx,
            "MSVC Build Tools 已安装，跳过",
        )
        .await;
    }
    step_idx += 1;

    // ====== Windows Defender 排除（防止实时保护扫描 node_modules 导致 EPERM）======
    {
        send_log(&progress_tx, "正在添加 Windows Defender 排除路径（需要管理员权限）...").await;
        let exclude_path = install_dir.to_string_lossy().to_string();
        let ps_result = tokio::task::spawn_blocking(move || {
            // 用 Start-Process -Verb RunAs 提权执行，弹 UAC 窗口
            std::process::Command::new("powershell")
                .args(&[
                    "-NoProfile",
                    "-Command",
                    &format!(
                        "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile -Command Add-MpPreference -ExclusionPath \"{}\"'",
                        exclude_path
                    ),
                ])
                .output()
        })
        .await;

        match ps_result {
            Ok(Ok(output)) if output.status.success() => {
                send_log(&progress_tx, "✅ 已添加 Defender 排除路径").await;
            }
            _ => {
                send_log(
                    &progress_tx,
                    "⚠ 添加 Defender 排除失败（用户取消或无权限），npm install 可能遇到 EPERM 错误",
                )
                .await;
            }
        }
    }

        let env_path = runtime_mgr.build_path_env();
    let git_exe = crate::runtime::portable_git::PortableGit::git_exe_path(&runtimes_dir);
    let node_dir = runtimes_dir.join("node");
    let python_exe = crate::runtime::portable_python::PortablePython::python_exe_path(&runtimes_dir);

    // ====== 阶段2: VCPToolBox ======
    if config.components.contains(&Component::VCPToolBox) {
        let error_count_before = errors.len();
        let toolbox_dir = install_dir.join("VCPToolBox");
        let repo_url = apply_mirror_to_repo(
            "https://github.com/lioensky/VCPToolBox.git",
            &config.mirror,
        );

        // git clone / git pull
        run_blocking_step_with_log(step_idx, &progress_tx, &mut errors, {
            let git_exe = git_exe.clone();
            let repo_url = repo_url.clone();
            let toolbox_dir = toolbox_dir.clone();
            let env_path = env_path.clone();

            move |log_fn: &dyn Fn(&str)| git_ops::git_clone(&git_exe, &repo_url, &toolbox_dir, &env_path, log_fn)
        })
        .await;
        step_idx += 1;

        // npm install
        if toolbox_dir.exists() {
            send_log(
                &progress_tx,
                "VCPToolBox: npm install 可能需要几分钟，请耐心等待...",
            )
            .await;

            run_blocking_step_with_log(step_idx, &progress_tx, &mut errors, {
                let node_dir = node_dir.clone();
                let toolbox_dir = toolbox_dir.clone();
                let env_path = env_path.clone();
                let use_mirror = config.use_npm_mirror;

                move |log_fn: &dyn Fn(&str)| npm_ops::npm_install(&node_dir, &toolbox_dir, &env_path, use_mirror, log_fn)
            })
            .await;
        } else {
            skip_step(
                &progress_tx,
                step_idx,
                "未找到 VCPToolBox 目录，跳过后端 Node.js 依赖安装",
            )
            .await;
        }
        step_idx += 1;

        // pip install
        if toolbox_dir.exists() {
            run_blocking_step_with_log(step_idx, &progress_tx, &mut errors, {
                let python_exe = python_exe.clone();
                let toolbox_dir = toolbox_dir.clone();
                let env_path = env_path.clone();
                let use_mirror = config.use_pip_mirror;

                move |log_fn: &dyn Fn(&str)| {
                    pip_ops::pip_install_requirements(
                        &python_exe,
                        &toolbox_dir,
                        &env_path,
                        use_mirror,
                        log_fn,
                    )
                }
            })
            .await;
        } else {
            skip_step(
                &progress_tx,
                step_idx,
                "未找到 VCPToolBox 目录，跳过后端 Python 依赖安装",
            )
            .await;
        }
        step_idx += 1;

        // 全局安装 PM2（VCP 后端 PM2 双进程方案需要）
        {
            let node_dir_clone = node_dir.clone();
            let env_path_clone = env_path.clone();
            let tx = progress_tx.clone();
            let pm2_result = tokio::task::spawn_blocking(move || {
                let log_fn = |msg: &str| {
                    let _ = tx.blocking_send(ProgressEvent::Log(msg.to_string()));
                };
                npm_ops::npm_install_global_pm2(&node_dir_clone, &env_path_clone, &log_fn)
            }).await;
            match pm2_result {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    send_log(&progress_tx, &format!("⚠ PM2 安装失败: {}，后端将无法使用 PM2 双进程启动", e)).await;
                }
                Err(e) => {
                    send_log(&progress_tx, &format!("⚠ PM2 安装任务异常: {}", e)).await;
                }
            }
        }

        // 生成 config.env
        if toolbox_dir.exists() {
            run_sync_step(step_idx, &progress_tx, &mut errors, {
                let toolbox_dir = toolbox_dir.clone();
                let config = config.clone();

                move || config_gen::generate_config_env(&toolbox_dir, &config)
            })
            .await;
        } else {
            skip_step(
                &progress_tx,
                step_idx,
                "未找到 VCPToolBox 目录，跳过配置文件生成",
            )
            .await;
        }
        step_idx += 1;

        if errors.len() == error_count_before && toolbox_dir.exists() {
            installed_components.push(Component::VCPToolBox);
        }
    }

    // ====== 阶段3: VCPChat ======
    if config.components.contains(&Component::VCPChat) {
        let error_count_before = errors.len();
        let chat_dir = install_dir.join("VCPChat");
        let repo_url = apply_mirror_to_repo(
            "https://github.com/lioensky/VCPChat.git",
            &config.mirror,
        );

        // git clone / git pull
        run_blocking_step_with_log(step_idx, &progress_tx, &mut errors, {
            let git_exe = git_exe.clone();
            let repo_url = repo_url.clone();
            let chat_dir = chat_dir.clone();
            let env_path = env_path.clone();

            move |log_fn: &dyn Fn(&str)| git_ops::git_clone(&git_exe, &repo_url, &chat_dir, &env_path, log_fn)
        })
        .await;
        step_idx += 1;

        // npm install
        if chat_dir.exists() {
            send_log(
                &progress_tx,
                "VCPChat: npm install 可能需要几分钟，请耐心等待...",
            )
            .await;

            run_blocking_step_with_log(step_idx, &progress_tx, &mut errors, {
                let node_dir = node_dir.clone();
                let chat_dir = chat_dir.clone();
                let env_path = env_path.clone();
                let use_mirror = config.use_npm_mirror;

                move |log_fn: &dyn Fn(&str)| npm_ops::npm_install(&node_dir, &chat_dir, &env_path, use_mirror, log_fn)
            })
            .await;
        } else {
            skip_step(
                &progress_tx,
                step_idx,
                "未找到 VCPChat 目录，跳过前端 Node.js 依赖安装",
            )
            .await;
        }
        step_idx += 1;

        // pip install
        if chat_dir.exists() {
            run_blocking_step_with_log(step_idx, &progress_tx, &mut errors, {
                let python_exe = python_exe.clone();
                let chat_dir = chat_dir.clone();
                let env_path = env_path.clone();
                let use_mirror = config.use_pip_mirror;

                move |log_fn: &dyn Fn(&str)| {
                    pip_ops::pip_install_requirements(
                        &python_exe,
                        &chat_dir,
                        &env_path,
                        use_mirror,
                        log_fn,
                    )
                }
            })
            .await;
        } else {
            skip_step(
                &progress_tx,
                step_idx,
                "未找到 VCPChat 目录，跳过前端 Python 依赖安装",
            )
            .await;
        }
        step_idx += 1;

        if errors.len() == error_count_before && chat_dir.exists() {
            installed_components.push(Component::VCPChat);
        }
    }

    // ====== 阶段4: NewAPI ======
    if config.components.contains(&Component::NewAPI) {
        let error_count_before = errors.len();

        run_async_step(step_idx, &progress_tx, &mut errors, {
            let install_dir = install_dir.clone();
            let mirror = config.mirror.clone();
            let progress_tx = progress_tx.clone();

            move || async move {
                config_gen::download_newapi(&install_dir, &mirror, step_idx, progress_tx).await
            }
        })
        .await;
        step_idx += 1;

        if errors.len() == error_count_before && install_dir.join("new-api.exe").exists() {
            installed_components.push(Component::NewAPI);
        }
    }

    // ====== 阶段5: 生成启动脚本 ======
    let should_generate_backend =
        config.components.contains(&Component::VCPToolBox)
            && install_dir.join("VCPToolBox").exists();

    let should_generate_frontend =
        config.components.contains(&Component::VCPChat)
            && install_dir.join("VCPChat").exists();

    if should_generate_backend || should_generate_frontend {
        run_sync_step(step_idx, &progress_tx, &mut errors, {
            let install_dir = install_dir.clone();

            move || {
                if should_generate_backend {
                    config_gen::generate_start_backend_bat(&install_dir)?;
                }

                if should_generate_frontend {
                    config_gen::generate_start_frontend_bat(&install_dir)?;
                }

                // 覆盖项目内部的启动脚本，注入 portable 运行时 PATH
                // 解决：VCPToolBox/start_server.bat 找不到 runtimes 中的 node/git/python
                config_gen::generate_inner_start_bat(&install_dir)?;

                Ok(())
            }
        })
        .await;
    } else {
        skip_step(
            &progress_tx,
            step_idx,
            "未找到可生成启动脚本的项目目录，跳过该步骤",
        )
        .await;
    }

    let backend_script = install_dir.join("start-backend.bat");
    let frontend_script = install_dir.join("start-frontend.bat");

    let result = InstallResult {
        success: errors.is_empty(),
        installed_components,
        install_path: install_dir.clone(),
        backend_start_script: if backend_script.exists() {
            Some(backend_script)
        } else {
            None
        },
        frontend_start_script: if frontend_script.exists() {
            Some(frontend_script)
        } else {
            None
        },
        errors,
    };

    let _ = progress_tx.send(ProgressEvent::AllCompleted(result.clone())).await;
    Ok(result)
}

fn pending_step(name: &str) -> InstallStep {
    InstallStep {
        name: name.to_string(),
        status: StepStatus::Pending,
        download_progress: None,
    }
}

fn apply_mirror_to_repo(url: &str, mirror: &GithubMirror) -> String {
    let prefix = mirror.prefix();
    downloader::apply_mirror(url, &prefix)
}

fn build_fail_result(config: &InstallConfig, errors: Vec<String>) -> InstallResult {
    InstallResult {
        success: false,
        installed_components: vec![],
        install_path: config.install_path.clone(),
        backend_start_script: None,
        frontend_start_script: None,
        errors,
    }
}

async fn send_log(progress_tx: &mpsc::Sender<ProgressEvent>, message: impl Into<String>) {
    let _ = progress_tx.send(ProgressEvent::Log(message.into())).await;
}

async fn skip_step(
    progress_tx: &mpsc::Sender<ProgressEvent>,
    step_index: usize,
    reason: impl Into<String>,
) {
    let reason = reason.into();
    if !reason.is_empty() {
        let _ = progress_tx.send(ProgressEvent::Log(reason)).await;
    }
    let _ = progress_tx.send(ProgressEvent::StepSkipped { step_index }).await;
}

async fn run_blocking_step_with_log<F>(
    step_index: usize,
    progress_tx: &mpsc::Sender<ProgressEvent>,
    errors: &mut Vec<String>,
    job: F,
) -> bool
where
    F: FnOnce(&dyn Fn(&str)) -> Result<()> + Send + 'static,
{
    let _ = progress_tx
        .send(ProgressEvent::StepStarted { step_index })
        .await;

    let tx = progress_tx.clone();
    match tokio::task::spawn_blocking(move || {
        let log_fn = |msg: &str| {
            let _ = tx.blocking_send(ProgressEvent::Log(msg.to_string()));
        };
        job(&log_fn)
    }).await {
        Ok(Ok(())) => {
            let _ = progress_tx
                .send(ProgressEvent::StepCompleted { step_index })
                .await;
            true
        }
        Ok(Err(err)) => {
            let msg = err.to_string();
            errors.push(msg.clone());
            let _ = progress_tx
                .send(ProgressEvent::StepFailed {
                    step_index,
                    error: msg,
                })
                .await;
            false
        }
        Err(join_err) => {
            let msg = format!("后台任务执行异常: {}", join_err);
            errors.push(msg.clone());
            let _ = progress_tx
                .send(ProgressEvent::StepFailed {
                    step_index,
                    error: msg,
                })
                .await;
            false
        }
    }
}

async fn run_sync_step<F>(
    step_index: usize,
    progress_tx: &mpsc::Sender<ProgressEvent>,
    errors: &mut Vec<String>,
    job: F,
) -> bool
where
    F: FnOnce() -> Result<()>,
{
    let _ = progress_tx
        .send(ProgressEvent::StepStarted { step_index })
        .await;

    match job() {
        Ok(()) => {
            let _ = progress_tx
                .send(ProgressEvent::StepCompleted { step_index })
                .await;
            true
        }
        Err(err) => {
            let msg = err.to_string();
            errors.push(msg.clone());
            let _ = progress_tx
                .send(ProgressEvent::StepFailed {
                    step_index,
                    error: msg,
                })
                .await;
            false
        }
    }
}

async fn run_async_step<F, Fut>(
    step_index: usize,
    progress_tx: &mpsc::Sender<ProgressEvent>,
    errors: &mut Vec<String>,
    job: F,
) -> bool
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let _ = progress_tx
        .send(ProgressEvent::StepStarted { step_index })
        .await;

    match job().await {
        Ok(()) => {
            let _ = progress_tx
                .send(ProgressEvent::StepCompleted { step_index })
                .await;
            true
        }
        Err(err) => {
            let msg = err.to_string();
            errors.push(msg.clone());
            let _ = progress_tx
                .send(ProgressEvent::StepFailed {
                    step_index,
                    error: msg,
                })
                .await;
            false
        }
    }
}