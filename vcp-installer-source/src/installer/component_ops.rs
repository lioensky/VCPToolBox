//! 应用组件统一安装流程
//!
//! 把 VCPToolBox / VCPChat / VCPBackUpDEV / VCPDistributedServer 的重复安装逻辑
//! 收敛到单一函数 install_component_package，通过 ComponentInstallPlan 描述差异。

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use tokio::sync::mpsc;

use crate::app::{Component, GithubMirror, InstallConfig, NpmMirrorChoice, PipMirrorChoice, ProgressEvent};
use crate::cache::CacheManager;
use crate::installer::{Stage, StageGuard, StageRecord};
use crate::installer::archive_ops;
use crate::installer::config_gen;
use crate::installer::downloader;
use crate::installer::git_ops;
use crate::installer::npm_ops;
use crate::installer::pip_ops;
use crate::mirrors::MirrorConfig;

/// 组件安装计划：描述一个组件需要执行哪些子步骤
#[derive(Debug, Clone)]
pub struct ComponentInstallPlan {
    pub component: Component,
    pub stage: Stage,
    pub run_npm: bool,
    pub run_pip: bool,
    pub run_pm2: bool,
    pub run_config_env: bool,
}

impl ComponentInstallPlan {
    pub fn new(component: Component) -> Self {
        match component {
            Component::VCPToolBox => Self {
                component,
                stage: Stage::VCPToolBox,
                run_npm: true,
                run_pip: true,
                run_pm2: true,
                run_config_env: true,
            },
            Component::VCPChat => Self {
                component,
                stage: Stage::VCPChat,
                run_npm: true,
                run_pip: true,
                run_pm2: false,
                run_config_env: false,
            },
            Component::VCPBackUpDEV => Self {
                component,
                stage: Stage::VCPBackUpDEV,
                run_npm: false,
                run_pip: false,
                run_pm2: false,
                run_config_env: false,
            },
            Component::VCPDistributedServer => Self {
                component,
                stage: Stage::VCPDistributedServer,
                run_npm: true,
                run_pip: false,
                run_pm2: false,
                run_config_env: false,
            },
            _ => panic!("ComponentInstallPlan 不支持 {:?}", component),
        }
    }
}

/// 统一安装一个应用组件
///
/// 流程：
/// 1. 进入 StageGuard
/// 2. 根据 install_method 执行 tarball 下载或 git clone
/// 3. 按需执行 npm install / pip install / PM2 / config.env
/// 4. 更新 installed_components 和 stage_records
pub async fn install_component_package(
    plan: &ComponentInstallPlan,
    install_dir: &Path,
    cache: &CacheManager,
    mirror: &GithubMirror,
    mirror_config: &MirrorConfig,
    npm_mirror: &NpmMirrorChoice,
    pip_mirror: &PipMirrorChoice,
    env_path: String,
    git_exe: &Path,
    node_dir: &Path,
    python_exe: &Path,
    config: &InstallConfig,
    progress_tx: &mpsc::Sender<ProgressEvent>,
    step_index: usize,
    errors: &mut Vec<String>,
    installed_components: &mut Vec<Component>,
    stage_records: &mut HashMap<Stage, StageRecord>,
    _install_start: Instant,
    log_dir: &Path,
    git_exhausted: &mut bool,
) {
    let mut guard = StageGuard::enter(log_dir, plan.stage);
    let error_count_before = errors.len();
    let env_path = std::sync::Arc::new(env_path);
    let component_dir = install_dir.join(plan.component.short_name());
    let base_repo_url = plan.component.git_repo_url().unwrap_or("").to_string();

    // ====== 构建候选镜像前缀列表（韧性核心）======
    // 顺序：用户所选镜像 → preferred_github 中未选过的站（去重）
    let candidate_prefixes = build_candidate_prefixes(mirror, mirror_config);

    // git 通道是否已耗尽（跨组件共享状态：前序组件 git 全部失败后为 true）
    let git_already_exhausted = *git_exhausted;

    // ====== 下载/克隆 ======
    let tarball_deploy_ok = match config.install_method {
        // Tarball+Git 模式：tarball 快速部署（必成路径，韧性下载）
        crate::app::InstallMethod::TarballGit => {
            run_blocking_step_with_log(step_index, progress_tx, errors, {
                let candidate_prefixes = candidate_prefixes.clone();
                let component_dir = component_dir.clone();
                let cache = cache.clone();
                let component = plan.component.clone();
                let env_path = env_path.clone();

                move |log_fn: &dyn Fn(&str)| {
                    archive_ops::archive_extract_resilient(
                        &component,
                        &candidate_prefixes,
                        &component_dir,
                        &cache,
                        &env_path,
                        log_fn,
                    )
                }
            })
            .await
        }
        // Git Clone 模式（git 通道未耗尽）：韧性克隆（多站 x 3次尝试）
        crate::app::InstallMethod::GitClone if !git_already_exhausted => {
            run_blocking_step_with_log(step_index, progress_tx, errors, {
                let git_exe = git_exe.to_path_buf();
                let candidate_prefixes = candidate_prefixes.clone();
                let base_repo_url = base_repo_url.clone();
                let component_dir = component_dir.clone();
                let env_path = env_path.clone();

                move |log_fn: &dyn Fn(&str)| {
                    git_ops::git_clone_resilient(
                        &git_exe,
                        &base_repo_url,
                        &candidate_prefixes,
                        &component_dir,
                        &env_path,
                        log_fn,
                    )
                }
            })
            .await
        }
        // Git Clone 模式（git 通道已耗尽）：跳过 git，直接 Tarball 部署
        crate::app::InstallMethod::GitClone => {
            crate::log_router::append_log(&format!(
                "! git 通道已证明不通，跳过 git 尝试，直接 Tarball 部署: {}",
                plan.component.short_name()
            ));
            run_blocking_step_with_log(step_index, progress_tx, errors, {
                let candidate_prefixes = candidate_prefixes.clone();
                let component_dir = component_dir.clone();
                let cache = cache.clone();
                let component = plan.component.clone();
                let env_path = env_path.clone();

                move |log_fn: &dyn Fn(&str)| {
                    archive_ops::archive_extract_resilient(
                        &component,
                        &candidate_prefixes,
                        &component_dir,
                        &cache,
                        &env_path,
                        log_fn,
                    )
                }
            })
            .await
        }
    };

    // ====== Git Clone 失败 → Tarball 兜底（韧性设计）======
    // 仅当本组件实际尝试了 git（通道此前未耗尽）且 git 失败时触发
    let tarball_fallback_ok = if config.install_method == crate::app::InstallMethod::GitClone
        && !git_already_exhausted
        && !tarball_deploy_ok
    {
        // 标记 git 通道已耗尽（后续组件跳过 git 尝试）
        *git_exhausted = true;

        let _ = send_log(
            progress_tx,
            format!(
                "! git clone 所有镜像站均失败，切换 Tarball 兜底模式: {}",
                plan.component.short_name()
            ),
        )
        .await;

        // 清理可能的残缺目录（clone 中断残留，不是合法 git 仓库）
        if component_dir.exists() && !git_ops::is_git_repo(&component_dir) {
            crate::log_router::append_log(&format!(
                "[git] 清理残缺目录: {}", component_dir.display()
            ));
            let _ = std::fs::remove_dir_all(&component_dir);
        }

        // 执行 tarball 部署
        let ok = run_blocking_step_with_log(step_index, progress_tx, errors, {
            let candidate_prefixes = candidate_prefixes.clone();
            let component_dir = component_dir.clone();
            let cache = cache.clone();
            let component = plan.component.clone();
            let env_path = env_path.clone();

            move |log_fn: &dyn Fn(&str)| {
                archive_ops::archive_extract_resilient(
                    &component,
                    &candidate_prefixes,
                    &component_dir,
                    &cache,
                    &env_path,
                    log_fn,
                )
            }
        })
        .await;

        // 兜底成功 → 回滚 git 错误（该步骤实际已通过 tarball 完成）
        // 回滚到 git 操作前的基线 error_count_before
        if ok {
            errors.truncate(error_count_before);
        }

        ok
    } else {        false
    };

    // 部署成功判定：主路径成功 OR tarball 兜底成功
    let deploy_ok = tarball_deploy_ok || tarball_fallback_ok;

    // ====== Tarball+Git 增强：部署成功后尽力初始化 git 仓库 ======
    // 失败仅告警，不阻断安装、不写入 errors、不占用步骤索引（韧性设计）
    if config.install_method == crate::app::InstallMethod::TarballGit
        && deploy_ok
        && component_dir.exists()
        && !*git_exhausted
    {
        let git_exe = git_exe.to_path_buf();
        // Plan B: 传入完整候选镜像列表，git_init_from_remote 内部按站点轮换 fetch
        let base_url = base_repo_url.clone();
        let candidates = candidate_prefixes.clone();
        let component_dir = component_dir.clone();
        let env_path = env_path.clone();
        let tx = progress_tx.clone();
        // Plan A: 保留副本，git init 失败时回滚删除遗留的 .git 目录
        let rollback_dir = component_dir.clone();

        let git_init_result = tokio::task::spawn_blocking(move || {
            let log_fn = |msg: &str| {
                let _ = crate::log_router::send_log_event_sync(&tx, msg.to_string());
            };
            git_ops::git_init_from_remote(&git_exe, &base_url, &candidates, &component_dir, &env_path, &log_fn)
        })
        .await;

        match git_init_result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                // Plan A: 回滚删除遗留的 .git 目录
                // 原因：git init 后若 fetch 全部失败，会留下"有 remote 无 commit"的空仓库，
                // 导致 start-upgrade.bat 的 git pull 报 "no tracking information"。
                // 回滚后组件保持纯 tarball 状态（无 .git），升级脚本会 SKIP 而非 FAIL。
                let git_dir = rollback_dir.join(".git");
                if git_dir.exists() {
                    let _ = std::fs::remove_dir_all(&git_dir);
                    send_log(
                        progress_tx,
                        format!(
                            "! git 仓库初始化失败，已回滚 .git（保持纯 Tarball 状态，无法 git pull 更新）: {}",
                            e
                        ),
                    )
                    .await;
                } else {
                    send_log(
                        progress_tx,
                        format!(
                            "! git 仓库初始化失败，组件已按 Tarball 方式部署完成（不影响使用，仅无法 git pull 更新）: {}",
                            e
                        ),
                    )
                    .await;
                }
            }
            Err(join_err) => {
                send_log(
                    progress_tx,
                    format!(
                        "! git 仓库初始化任务异常，组件已按 Tarball 方式部署完成: {}",
                        join_err
                    ),
                )
                .await;
            }
        }
    }

    // ====== npm install ======
    // 2026-08-21 拔线测试修复：npm/pip 失败不再判组件失败（代码已部署成功，
    // 依赖可以后续联网补装）。只记录警告，不写入 errors。
    let npm_ok = if plan.run_npm && component_dir.exists() {
        let _ = send_log(
            progress_tx,
            format!(
                "{}: npm install 可能需要几分钟，请耐心等待...",
                plan.component.short_name()
            ),
        )
        .await;

        let npm_result = run_blocking_silent(errors, {
            let node_dir = node_dir.to_path_buf();
            let component_dir = component_dir.clone();
            let env_path = env_path.clone();
            let use_mirror = npm_mirror.use_mirror;

            move |log_fn: &dyn Fn(&str)| {
                npm_ops::npm_install(&node_dir, &component_dir, &env_path, use_mirror, log_fn)
            }
        })
        .await;

        if !npm_result {
            // 2026-08-21: 降级为警告，不判组件失败
            let _ = send_log(
                progress_tx,
                format!(
                    "! {} npm install 失败（代码已部署，依赖可后续联网补装）",
                    plan.component.short_name()
                ),
            )
            .await;
        }
        npm_result
    } else if plan.run_npm {
        let _ = skip_silent(
            progress_tx,
            format!(
                "未找到 {} 目录，跳过 Node.js 依赖安装",
                plan.component.short_name()
            ),
        )
        .await;
        true
    } else {
        true
    };

    // ====== pip install ======
    // 2026-08-21 拔线测试修复：同 npm，失败不判组件失败
    // 2026-08-23 Plan A：传入 pip_mirror + mirror_config，启用多源韧性重试
    let pip_ok = if plan.run_pip && component_dir.exists() {
        let pip_result = run_blocking_silent(errors, {
            let python_exe = python_exe.to_path_buf();
            let component_dir = component_dir.clone();
            let env_path = env_path.clone();
            let pip_mirror = pip_mirror.clone();
            let mirror_config = mirror_config.clone();

            move |log_fn: &dyn Fn(&str)| {
                pip_ops::pip_install_requirements(
                    &python_exe,
                    &component_dir,
                    &env_path,
                    &pip_mirror,
                    &mirror_config,
                    log_fn,
                )
            }
        })
        .await;

        if !pip_result {
            // 2026-08-21: 降级为警告，不判组件失败
            let _ = send_log(
                progress_tx,
                format!(
                    "! {} pip install 失败（代码已部署，依赖可后续联网补装）",
                    plan.component.short_name()
                ),
            )
            .await;
        }
        pip_result
    } else if plan.run_pip {
        let _ = skip_silent(
            progress_tx,
            format!(
                "未找到 {} 目录，跳过 Python 依赖安装",
                plan.component.short_name()
            ),
        )
        .await;
        true
    } else {
        true
    };

    // ====== 全局安装 PM2 ======
    if plan.run_pm2 {
        let node_dir_clone = node_dir.to_path_buf();
        let env_path_clone = env_path.to_string();
        let tx = progress_tx.clone();
        let pm2_result = tokio::task::spawn_blocking(move || {
            let log_fn = |msg: &str| {
                let _ = crate::log_router::send_log_event_sync(&tx, msg.to_string());
            };
            npm_ops::npm_install_global_pm2(&node_dir_clone, &env_path_clone, &log_fn)
        })
        .await;
        match pm2_result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                crate::log_router::send_log_event(
                    progress_tx,
                    format!("! PM2 安装失败: {}，后端将无法使用 PM2 双进程启动", e),
                )
                .await;
            }
            Err(e) => {
                crate::log_router::send_log_event(
                    progress_tx,
                    format!("! PM2 安装任务异常: {}", e),
                )
                .await;
            }
        }
    }

    // ====== 生成 config.env ======
    if plan.run_config_env && component_dir.exists() {
        let _ = run_blocking_silent(errors, {
            let component_dir = component_dir.clone();
            let config = config.clone();

            move |log_fn: &dyn Fn(&str)| {
                let result = config_gen::generate_config_env(&component_dir, &config);
                if let Err(e) = result.as_ref() {
                    log_fn(&format!("配置文件生成警告: {}", e));
                }
                result
            }
        })
        .await;
    } else if plan.run_config_env {
        let _ = skip_silent(
            progress_tx,
            format!(
                "未找到 {} 目录，跳过配置文件生成",
                plan.component.short_name()
            ),
        )
        .await;
    }

    // ====== 记录结果 ======
    // 2026-08-21 拔线测试修复：组件成功 = 代码部署成功（不看 npm/pip 依赖）
    // 之前：errors.len() == error_count_before && component_dir.exists()
    // 现在：deploy_ok && component_dir.exists()（npm/pip 失败只记警告，不判组件失败）
    if deploy_ok && component_dir.exists() {
        installed_components.push(plan.component.clone());
    } else {
        guard.mark_failed();
    }
    stage_records.insert(
        plan.stage,
        StageRecord {
            secs: guard.elapsed_secs(),
            success: Some(guard.is_success()),
        },
    );
    drop(guard);
}

async fn send_log(
    progress_tx: &mpsc::Sender<ProgressEvent>,
    message: impl Into<String>,
) {
    crate::log_router::send_log_event(progress_tx, message).await;
}

async fn skip_silent(
    progress_tx: &mpsc::Sender<ProgressEvent>,
    reason: impl Into<String>,
) {
    let _ = crate::log_router::send_log_event(progress_tx, reason).await;
}

async fn run_blocking_silent<F>(errors: &mut Vec<String>, job: F) -> bool
where
    F: FnOnce(&dyn Fn(&str)) -> anyhow::Result<()> + Send + 'static,
{
    match tokio::task::spawn_blocking(move || {
        let log_fn = |msg: &str| {
            crate::log_router::append_log(msg);
        };
        job(&log_fn)
    })
    .await
    {
        Ok(Ok(())) => true,
        Ok(Err(e)) => {
            errors.push(format!("{}", e));
            false
        }
        Err(e) => {
            errors.push(format!("任务执行失败: {}", e));
            false
        }
    }
}

async fn run_blocking_step_with_log<F>(
    step_index: usize,
    progress_tx: &mpsc::Sender<ProgressEvent>,
    errors: &mut Vec<String>,
    job: F,
) -> bool
where
    F: FnOnce(&dyn Fn(&str)) -> anyhow::Result<()> + Send + 'static,
{
    let _ = progress_tx
        .send(ProgressEvent::StepStarted { step_index })
        .await;

    let tx = progress_tx.clone();
    match tokio::task::spawn_blocking(move || {
        // 2026-08-22: 设置全局 TUI 进度函数 → git/npm/pip 中间进度实时滚动到 TUI
        // （progress_fn 传 None 时，pump_child_output 回退到全局函数；只发 TUI 不写日志文件）
        {
            let tx_p = tx.clone();
            crate::installer::stream_util::set_tui_progress_fn(move |msg: &str| {
                let _ = crate::log_router::send_log_tui_only(&tx_p, msg.to_string());
            });
        }
        let log_fn = |msg: &str| {
            let _ = crate::log_router::send_log_event_sync(&tx, msg.to_string());
        };
        let result = job(&log_fn);
        // 任务结束清除，避免影响后续无进度需求的任务
        crate::installer::stream_util::clear_tui_progress_fn();
        result
    })
    .await
    {
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


/// 构建候选镜像前缀列表（韧性核心）
///
/// 顺序：用户所选镜像 → preferred_github 中未选过的站（去重）
/// 确保 git 通道不通时能自动切换到备用站点
fn build_candidate_prefixes(mirror: &GithubMirror, mirror_config: &MirrorConfig) -> Vec<String> {
    let mut candidates = Vec::new();

    // 1. 用户所选镜像（最高优先级）
    let user_prefix = mirror.prefix(mirror_config);
    // 存 String 副本，避免借用与 push(move) 冲突
    let user_prefix_set = std::collections::HashSet::from([user_prefix.clone()]);
    candidates.push(user_prefix);

    // 2. preferred_github 中未选过的站（去重）
    for entry in &mirror_config.preferred_github {
        if !user_prefix_set.contains(&entry.url) && !candidates.contains(&entry.url) {
            candidates.push(entry.url.clone());
        }
    }

    candidates
}
