use std::io::Write;
pub mod package;
pub mod component_ops;
pub mod downloader;
pub mod extractor;
pub mod detector;
pub mod git_ops;
pub mod npm_ops;
pub mod pip_ops;
pub mod config_gen;
pub mod msvc_ops;
pub mod archive_ops;
pub mod electron_rebuild;
pub mod stream_util;

use std::future::Future;

use anyhow::Result;
use tokio::sync::mpsc;

use crate::app::{
    EnvCheckResult,
    Component,
    DependencyStatus,
    GithubMirror,
    InstallConfig,
    InstallResult,
    InstallStep,
    InstallMethod,
    ProgressEvent,
    RuntimeComponent,
    StepStatus,
};
use crate::mirrors::{MirrorConfig, MirrorEntry, MirrorResult, test_sites_by_download, phase0_check_project_exists};
use crate::runtime::RuntimeManager;
use crate::log_router;

/// 安装阶段枚举（与日志文件名对应）
/// 整个安装流程中 stage 永不为 None —— 从 01_prepare 开始到 09_scripts 结束，
/// 每条日志都有明确的阶段归属文件，不存在"间隙丢弃"。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Stage {
    Prepare,                // 01_prepare.log - 环境检测 + 准备
    SiteTest,               // 02_site_test.log - 镜像站点测试
    Runtime,                // 03_runtime.log - 运行时安装（Git/Node/Python + NewAPI）
    Msvc,                   // 04_msvc.log - MSVC Build Tools
    VCPToolBox,             // 05_vcptoolbox.log - VCPToolBox 安装
    VCPChat,                // 06_vcpchat.log - VCPChat 安装
    VCPBackUpDEV,           // 07_backupdev.log - VCPBackUpDEV 安装
    VCPDistributedServer,   // 08_distserver.log - VCPDistributedServer 安装
    Scripts,                // 09_scripts.log - 配置文件 + 启动脚本生成
}


/// RAII 阶段守卫：进入阶段时写 [START] 并设置全局阶段日志，
/// 作用域结束（正常/错误/panic）时自动写 [END] 并记录耗时。
/// 彻底解决"失败/提前 return 时缺少 [END] 标记"的问题。
struct StageGuard {
    log_dir: std::path::PathBuf,
    stage: Stage,
    success: bool,
    start: std::time::Instant,
    write_markers: bool, // 是否写自己的 [START]/[END]；Prepare=false（由 env_log 写）
}

impl StageGuard {
    fn enter(log_dir: &std::path::Path, stage: Stage) -> Self {
        Self::enter_with_markers(log_dir, stage, true)
    }

    fn enter_quiet(log_dir: &std::path::Path, stage: Stage) -> Self {
        Self::enter_with_markers(log_dir, stage, false)
    }

    fn enter_with_markers(log_dir: &std::path::Path, stage: Stage, write_markers: bool) -> Self {
        let log_file = log_dir.join(stage.filename());
        if write_markers {
            let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
            let header = format!(
                "{:=^80}\n[START] {} | {}\n{:=^80}",
                "",
                stage.description(),
                now,
                ""
            );
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_file)
            {
                let _ = f.write_all(format!("{}\n", header).as_bytes());
            }
        }
        crate::log_router::set_stage_log(Some(log_file));
        Self {
            log_dir: log_dir.to_path_buf(),
            stage,
            success: true,
            start: std::time::Instant::now(),
            write_markers,
        }
    }

    fn mark_failed(&mut self) {
        self.success = false;
    }

    /// 该阶段的真实耗时（自 enter 起算，供 summary 使用）
    fn elapsed_secs(&self) -> u64 {
        self.start.elapsed().as_secs()
    }

    /// 该阶段是否成功（自 mark_failed 起算，供 summary 使用）
    fn is_success(&self) -> bool {
        self.success
    }
}

impl Drop for StageGuard {
    fn drop(&mut self) {
        let log_file = self.log_dir.join(self.stage.filename());
        if self.write_markers {
            let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
            let status = if self.success { "SUCCESS" } else { "FAILED" };
            let elapsed = self.start.elapsed();
            let footer = format!(
                "[END] {} | {} | {} | 耗时 {} 秒\n{:=^80}",
                self.stage.description(),
                status,
                now,
                elapsed.as_secs(),
                ""
            );
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_file)
            {
                let _ = f.write_all(format!("{}\n", footer).as_bytes());
            }
        }
        crate::log_router::set_stage_log(None);
    }
}

/// 记录单个阶段的耗时与成功状态（供 summary 使用）
#[derive(Default)]
struct StageRecord {
    secs: u64,
    success: Option<bool>,
}

/// 构建安装步骤列表（基于用户选择的组件）
pub fn build_install_steps(config: &InstallConfig) -> Vec<InstallStep> {
    let is_tarball = config.install_method == InstallMethod::TarballGit;

    let clone_or_download = if is_tarball { "下载" } else { "克隆" };

    let mut steps = vec![
        pending_step("镜像站点测试"),
        pending_step("下载 PortableGit"),
        pending_step("下载 Node.js"),
        pending_step("下载 Python"),
        pending_step("下载 NewAPI"),
        pending_step("安装 MSVC Build Tools"),
    ];

    if config.components.contains(&Component::VCPToolBox) {
        steps.push(pending_step(format!("{} VCPToolBox", clone_or_download)));
        // 省略 npm/pip 子步骤，保持列表简洁（窗口高度有限）
    }

    if config.components.contains(&Component::VCPChat) {
        steps.push(pending_step(format!("{} VCPChat", clone_or_download)));
        // 省略 npm/pip 子步骤，保持列表简洁
    }

    if config.components.contains(&Component::VCPBackUpDEV) {
        steps.push(pending_step(format!("{} VCPBackUpDEV", clone_or_download)));
    }

    if config.components.contains(&Component::VCPDistributedServer) {
        steps.push(pending_step(format!("{} VCPDistributedServer", clone_or_download)));
        // 省略 npm 子步骤，保持列表简洁
    }

    // 移除不需要的步骤（镜像测试后索引 +1）
    if !config.components.contains(&Component::NewAPI) {
        steps.remove(4);
    }

    steps.push(pending_step("生成启动脚本"));
    steps
}

/// 执行完整安装流程
pub async fn run_installation(
    mut config: InstallConfig,
    mirror_config: MirrorConfig,
    _github_results: Vec<MirrorResult>,
    dl_runtimes_dir: std::path::PathBuf,
    progress_tx: mpsc::Sender<ProgressEvent>,
    env_check: EnvCheckResult,
) -> Result<InstallResult> {
    let install_start = std::time::Instant::now();
    let install_start_str = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

    // ====== 2026-08-28 Plan A 彻底修复：install_dir 绝对化（必须在最源头）======
    // 根因：headless 传参为相对路径（如 `VCP_AIOS`），导致 runtimes_dir/node_dir/
    // python_exe/git_exe/component_dir 全部相对。npm bat 内 `"VCP_AIOS\runtimes\node\npm.cmd"`
    // 在 current_dir=组件目录 下多解析一层 → "系统找不到指定的路径"。
    // 在源头绝对化，一次性解决 npm/pip/electron-rebuild/所有 bat 的相对路径问题。
    // 真实 GUI 部署时 install_path 已是绝对路径，此步骤为幂等 no-op。
    // 注意：canonicalize 在 Windows 上会给盘符路径加 \\?\ 前缀，cmd/bat 无法识别，
    // to_command_abs_path 内部会自动剥离该前缀。
    let install_dir = crate::installer::npm_ops::to_command_abs_path(config.install_path.clone());

    let runtimes_dir = install_dir.join("runtimes");

    let mut errors = Vec::new();
    let mut installed_runtimes = Vec::new();
    let mut installed_components = Vec::new();
    let mut step_idx: usize = 1;  // step_idx=0 是镜像站点测试，在安装步骤列表的最前面

    // 记录各阶段耗时与状态（供 summary 使用）
    let mut stage_records: std::collections::HashMap<Stage, StageRecord> = Default::default();

    // 记录运行时具体版本号（供 summary 使用）
    let mut runtime_versions: Vec<(String, String)> = Vec::new();
    // 记录优选镜像站（供 summary 使用）
    let mut preferred_mirrors: Vec<String> = Vec::new();

    // 统一缓存管理器
    let cache = crate::cache::CacheManager::new(dl_runtimes_dir);

    // ====== 初始化日志目录（exe 同级 Install_log）======
    let log_dir = crate::log_router::init_log_dir(&install_dir);

    // 确保安装目录存在
    if let Err(e) = tokio::fs::create_dir_all(&install_dir).await {
        errors.push(format!("创建安装目录失败: {}", e));
        let result = build_fail_result(&config, errors);
        let _ = progress_tx.send(ProgressEvent::AllCompleted(result.clone())).await;
        return Ok(result);
    }

    // ====== 01 准备阶段：写完整的准备日志 ======
    // TUI/Headless 统一由 run_installation 生成 01_prepare.log，复用 env_log::write_prepare_log
    let mut prepare_guard = StageGuard::enter_quiet(&log_dir, Stage::Prepare); // env_log 已写 [START]/[END]

    crate::env_log::write_prepare_log(&env_check, true); // pip_source_ok=true（安装流程中已确认）

    stage_records.insert(
        Stage::Prepare,
        StageRecord {
            secs: prepare_guard.elapsed_secs(),
            success: Some(prepare_guard.is_success()),
        },
    );
    drop(prepare_guard);

    // ====== 02 站点可用性测试 ======
    let mut site_guard = StageGuard::enter(&log_dir, Stage::SiteTest);

    // Windows Defender 排除（写入 02_site_test.log，需要管理员权限，失败不阻断）
    crate::log_router::send_log_event(
        &progress_tx,
        "正在添加 Windows Defender 排除路径（需要管理员权限）...",
    )
    .await;
    {
        let exclude_path = install_dir.to_string_lossy().to_string();
        let ps_result = tokio::task::spawn_blocking(move || {
            std::process::Command::new("powershell")
                .args(&[
                    "-NoProfile",
                    "-Command",
                    &format!(
                        "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile -Command Add-MpPreference -ExclusionPath \\\"{}\\\"'",
                        exclude_path
                    ),
                ])
                .output()
        })
        .await;

        // 复制一份路径用于日志输出（exclude_path 已在闭包中被移动）
        let excluded_path_display = install_dir.to_string_lossy().to_string();
        match ps_result {
            Ok(Ok(output)) if output.status.success() => {
                crate::log_router::send_log_event(
                    &progress_tx,
                    &format!("已添加 Defender 排除路径: {}", excluded_path_display),
                )
                .await;
            }
            _ => {
                send_log(
                    &progress_tx,
                    &format!("添加 Defender 排除失败: {}（用户取消或无权限）", excluded_path_display),
                )
                .await;
            }
        }
    }

    crate::log_router::send_log_event(&progress_tx, "=== 开始测试 GitHub 镜像站可用性 ===").await;
    // 镜像站点测试步骤开始（步骤索引 0）
    let _ = progress_tx.send(ProgressEvent::StepStarted { step_index: 0 }).await;

    // ====== Phase0: 项目存在性预校验 ======
    let phase0_start = std::time::Instant::now();
    crate::log_router::send_log_event(
        &progress_tx,
        "[SITE-TEST] Phase0: 检查 GitHub 官方 + [github] 镜像站是否支持 VCPToolBox...",
    )
    .await;

    let filtered_github = phase0_check_project_exists(
        &mirror_config.github,
        "lioensky",
        "VCPToolBox",
        &progress_tx,
    )
    .await;

    let phase0_elapsed = phase0_start.elapsed().as_secs();
    crate::log_router::send_log_event(
        &progress_tx,
        format!("Phase0 耗时 {} 秒，剩余 {} 个候选站点进入下载测试", phase0_elapsed, filtered_github.len()),
    )
    .await;

    // 如果 Phase0 全部过滤掉，阻止安装
    if filtered_github.is_empty() {
        crate::log_router::send_log_event(&progress_tx, "GitHub 官方及所有镜像站均不支持 VCPToolBox 项目").await;
        crate::log_router::send_log_event(&progress_tx, "请检查网络连接或开启 VPN 代理后再试").await;
        site_guard.mark_failed();
        stage_records.insert(
            Stage::SiteTest,
            StageRecord {
                secs: phase0_elapsed,
                success: Some(false),
            },
        );
        drop(site_guard);
        let fail_result = build_fail_result(
            &config,
            vec![
                "GitHub 官方及所有镜像站均不支持 VCPToolBox 项目（Phase0 预校验失败），请检查网络或开启 VPN 后重试".to_string()
            ],
        );
        write_install_summary(
            &log_dir, &install_dir, install_start, install_start_str, &stage_records,
            &runtime_versions, &preferred_mirrors,
            &installed_runtimes, &installed_components, &errors,
            None, None, &fail_result,
        );
        let _ = progress_tx.send(ProgressEvent::AllCompleted(fail_result.clone())).await;
        return Ok(fail_result);
    }

    crate::log_router::send_log_event(&progress_tx, "正在下载 VCPToolBox 源码测试站点（约 175MB，可能需要 1-5 分钟）...").await;
    crate::log_router::send_log_event(&progress_tx, "测试通过才能继续，如果全部失败说明当前网络无法安装，请开启 VPN 后重试").await;

    let test_start = std::time::Instant::now();
    let test_result = test_sites_by_download(
        &filtered_github,  // ← 使用 Phase0 过滤后的列表
        &cache.dl_runtimes_dir(),
        3,      // 最多 3 个并发
        600,    // 600 秒超时（~175MB 文件）
        progress_tx.clone(),
    )
    .await;

    let elapsed = test_start.elapsed().as_secs();
    let (mirror_config, use_mirror) = match test_result {
        Ok((test_results, _cached_file)) => {
            let successful: Vec<_> = test_results.iter().filter(|r| r.success).collect();

            if successful.is_empty() {
                // 全部失败 → 阻止安装
                crate::log_router::send_log_event(&progress_tx, format!("测试耗时 {} 秒", elapsed)).await;
                crate::log_router::send_log_event(&progress_tx, "所有 GitHub 站点测试失败，无法继续安装").await;
                crate::log_router::send_log_event(&progress_tx, "请检查网络连接或开启 VPN 代理后再试").await;
                crate::log_router::send_log_event(&progress_tx, "").await;
                crate::log_router::send_log_event(&progress_tx, "=== 测试详情 ===").await;
                for r in &test_results {
                    send_log(
                        &progress_tx,
                        format!(
                            "  [X] {} {}秒 (下载 {}MB)",
                            r.entry.name,
                            r.elapsed_secs.round() as u64,
                            (r.downloaded_bytes as f64 / 1_048_576.0).round() as u64
                        ),
                    )
                    .await;
                }
                site_guard.mark_failed();
                stage_records.insert(
                    Stage::SiteTest,
                    StageRecord {
                        secs: elapsed,
                        success: Some(false),
                    },
                );
                drop(site_guard);
                let fail_result = build_fail_result(
                    &config,
                    vec![
                        "所有 GitHub 站点无法完成真实下载测试（约 40MB，5 分钟超时），请检查网络或开启 VPN".to_string()
                    ],
                );
                write_install_summary(
                    &log_dir, &install_dir, install_start, install_start_str, &stage_records,
                    &runtime_versions, &preferred_mirrors,
                    &installed_runtimes, &installed_components, &errors,
                    None, None, &fail_result,
                );
                let _ = progress_tx.send(ProgressEvent::AllCompleted(fail_result.clone())).await;
                return Ok(fail_result);
            }

            // 保存 preferred 列表（始终保留前 3 个最快的）
            let preferred: Vec<MirrorEntry> = successful.iter().take(3).map(|r| r.entry.clone()).collect();
            preferred_mirrors = preferred.iter().map(|e| e.name.clone()).collect();
            let save_result = mirror_config.save_preferred_github(&preferred);

            crate::log_router::send_log_event(&progress_tx, format!("测试完成（耗时 {} 秒），{} 个站点可用", elapsed, successful.len())).await;
            crate::log_router::send_log_event(&progress_tx, "=== 可用站点 ===").await;
            for r in &successful {
                send_log(
                    &progress_tx,
                    format!(
                        "  [OK] {} {}秒 ({:.1}MB)",
                        r.entry.name,
                        r.elapsed_secs.round() as u64,
                        r.total_bytes as f64 / 1_048_576.0
                    ),
                )
                .await;
            }

            if let Err(e) = save_result {
                crate::log_router::send_log_event(&progress_tx, format!("保存优选站点列表失败: {}", e)).await;
            } else {
                crate::log_router::send_log_event(&progress_tx, format!("已保存 {} 个优选站点到配置文件", preferred.len())).await;
            }

            // 更新 mirror_config 包含 preferred 列表
            let mirror_config_with_preferred = MirrorConfig {
                preferred_github: preferred.clone(),
                ..mirror_config.clone()
            };

            // 设置 config.mirror 为 Preferred(0)，使用完整下载测试选出的最快站点
            let use_mirror: GithubMirror = if !preferred.is_empty() {
                GithubMirror::Preferred(0)
            } else {
                GithubMirror::Direct
            };
            crate::log_router::send_log_event(&progress_tx, format!("将使用镜像: {}", use_mirror.prefix(&mirror_config_with_preferred))).await;

            (mirror_config_with_preferred, use_mirror)
        }
        Err(e) => {
            crate::log_router::send_log_event(&progress_tx, format!("❌ 站点测试过程出错: {}", e)).await;
            crate::log_router::send_log_event(&progress_tx, "将使用备用列表继续安装，但可能会遇到网络问题").await;
            (mirror_config.clone(), GithubMirror::Direct)
        }
    };

    // 应用站点测试选出的镜像到 config
    config.mirror = use_mirror;
    stage_records.insert(
        Stage::SiteTest,
        StageRecord {
            secs: elapsed,
            success: Some(true),
        },
    );
    drop(site_guard);
    // 镜像站点测试步骤完成（步骤索引 0）
    let _ = progress_tx.send(ProgressEvent::StepCompleted { step_index: 0 }).await;

    // ====== 03 运行时安装阶段（Git/Node/Python + NewAPI）======
    let mut runtime_guard = StageGuard::enter(&log_dir, Stage::Runtime);
    let mut runtime_mgr = RuntimeManager::new(&install_dir, cache.clone());

    if let Err(e) = runtime_mgr
        .ensure_all(&env_check, &config.mirror, &mirror_config, progress_tx.clone(), step_idx)
        .await
    {
        errors.push(format!("运行时安装失败: {}", e));
        runtime_guard.mark_failed();
        stage_records.insert(
            Stage::Runtime,
            StageRecord {
                secs: runtime_guard.elapsed_secs(),
                success: Some(false),
            },
        );
        drop(runtime_guard);
        let result = build_fail_result(&config, errors.clone());
        write_install_summary(
            &log_dir, &install_dir, install_start, install_start_str, &stage_records,
            &runtime_versions, &preferred_mirrors,
            &installed_runtimes, &installed_components, &errors,
            None, None, &result,
        );
        let _ = progress_tx.send(ProgressEvent::AllCompleted(result.clone())).await;
        return Ok(result);
    }

    // 收集已安装的运行时及其具体版本号（供 summary 使用）
    installed_runtimes = runtime_mgr.get_installed_runtimes();
    if let Some(g) = &runtime_mgr.git {
        if let Ok(v) = g.verify() {
            runtime_versions.push(("Git".to_string(), v));
        }
    }
    if let Some(n) = &runtime_mgr.node {
        if let Ok(v) = n.verify() {
            runtime_versions.push(("Node.js".to_string(), v));
        }
    }
    if let Some(p) = &runtime_mgr.python {
        if let Ok(v) = p.verify() {
            runtime_versions.push(("Python".to_string(), v));
        }
    }

    step_idx += 3;
    stage_records.insert(
        Stage::Runtime,
        StageRecord {
            secs: runtime_guard.elapsed_secs(),
            success: Some(runtime_guard.is_success()),
        },
    );
    drop(runtime_guard);

    // ====== NewAPI 下载（归入 03_runtime 阶段，利用刚下载完的空档）======
    if config.components.contains(&Component::NewAPI) {
        let mut newapi_guard = StageGuard::enter(&log_dir, Stage::Runtime);
        let error_count_before = errors.len();

        run_async_step(step_idx, &progress_tx, &mut errors, {
            let install_dir = install_dir.clone();
            let mirror = config.mirror.clone();
            let mirror_config = mirror_config.clone();
            let progress_tx = progress_tx.clone();

            move || async move {
                config_gen::download_newapi(&install_dir, &mirror, &mirror_config, step_idx, progress_tx).await
            }
        })
        .await;
        step_idx += 1;

        if errors.len() == error_count_before && install_dir.join("runtimes/new-api.exe").exists() {
            installed_components.push(Component::NewAPI);
        } else {
            newapi_guard.mark_failed();
        }
        drop(newapi_guard);
    }

    // ====== 04 MSVC Build Tools 安装（必需，失败阻断）======
    // MSVC 是 npm 原生模块（better-sqlite3/node-pty/hnswlib-node）编译的硬依赖，
    // 只要未检测到就强制安装（不再依赖组件勾选）；已检测到则跳过。
    // 安装失败 = 原生模块无法编译 = 后续 npm install 必然失败，故直接中止整体安装。
    let mut msvc_guard = StageGuard::enter(&log_dir, Stage::Msvc);
    if matches!(env_check.msvc, DependencyStatus::NotFound) {
        let _ = progress_tx
            .send(ProgressEvent::StepStarted { step_index: step_idx })
            .await;
        match msvc_ops::install_msvc_build_tools(&progress_tx, &install_dir, &mirror_config).await {
            Ok(()) => {
                let _ = progress_tx
                    .send(ProgressEvent::StepCompleted { step_index: step_idx })
                    .await;
            }
            Err(e) => {
                // MSVC 安装失败阻断流程：原生模块无法编译，中止整体安装
                msvc_guard.mark_failed();
                drop(msvc_guard);
                let _ = progress_tx
                    .send(ProgressEvent::StepFailed {
                        step_index: step_idx,
                        error: e.to_string(),
                    })
                    .await;
                send_log(
                    &progress_tx,
                    "MSVC 安装失败，原生模块无法编译，中止安装",
                )
                .await;
                let fail_result = build_fail_result(
                    &config,
                    vec![format!(
                        "MSVC Build Tools 安装失败（必需组件，npm 原生模块编译依赖）: {}",
                        e
                    )],
                );
                let _ = progress_tx
                    .send(ProgressEvent::AllCompleted(fail_result.clone()))
                    .await;
                return Ok(fail_result);
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
    stage_records.insert(
        Stage::Msvc,
        StageRecord {
            secs: msvc_guard.elapsed_secs(),
            success: Some(msvc_guard.is_success()),
        },
    );
    drop(msvc_guard);

    let env_path = runtime_mgr.build_path_env();
    let git_exe = crate::runtime::portable_git::PortableGit::git_exe_path(&runtimes_dir);
    let node_dir = runtimes_dir.join("node");
    let python_exe = crate::runtime::portable_python::PortablePython::python_exe_path(&runtimes_dir);

    // ====== git 通道耗尽标记（韧性状态，跨组件共享）======
    // 某个组件 git clone 耗尽所有镜像站后设为 true，
    // 后续组件跳过 git 尝试，直接走 tarball（git 通道已证明不通）
    let mut git_exhausted = false;

    // ====== 05 VCPToolBox 安装 ======
    if config.components.contains(&Component::VCPToolBox) {
        component_ops::install_component_package(
            &component_ops::ComponentInstallPlan::new(Component::VCPToolBox),
            &install_dir,
            &cache,
            &config.mirror,
            &mirror_config,
            &config.npm_mirror,
            &config.pip_mirror,
            env_path.clone(),
            &git_exe,
            &node_dir,
            &python_exe,
            &config,
            &progress_tx,
            step_idx,
            &mut errors,
            &mut installed_components,
            &mut stage_records,
            install_start,
            &log_dir,
            &mut git_exhausted,
        )
        .await;
        step_idx += 1;
    }

    // ====== 06 VCPChat 安装 ======
    if config.components.contains(&Component::VCPChat) {
        component_ops::install_component_package(
            &component_ops::ComponentInstallPlan::new(Component::VCPChat),
            &install_dir,
            &cache,
            &config.mirror,
            &mirror_config,
            &config.npm_mirror,
            &config.pip_mirror,
            env_path.clone(),
            &git_exe,
            &node_dir,
            &python_exe,
            &config,
            &progress_tx,
            step_idx,
            &mut errors,
            &mut installed_components,
            &mut stage_records,
            install_start,
            &log_dir,
            &mut git_exhausted,
        )
        .await;
        step_idx += 1;
    }

                // ====== VCPBackUpDEV 安装 ======
    if config.components.contains(&Component::VCPBackUpDEV) {
        component_ops::install_component_package(
            &component_ops::ComponentInstallPlan::new(Component::VCPBackUpDEV),
            &install_dir,
            &cache,
            &config.mirror,
            &mirror_config,
            &config.npm_mirror,
            &config.pip_mirror,
            env_path.clone(),
            &git_exe,
            &node_dir,
            &python_exe,
            &config,
            &progress_tx,
            step_idx,
            &mut errors,
            &mut installed_components,
            &mut stage_records,
            install_start,
            &log_dir,
            &mut git_exhausted,
        )
        .await;
        step_idx += 1;
    }

                // ====== VCPDistributedServer 安装 ======
    if config.components.contains(&Component::VCPDistributedServer) {
        component_ops::install_component_package(
            &component_ops::ComponentInstallPlan::new(Component::VCPDistributedServer),
            &install_dir,
            &cache,
            &config.mirror,
            &mirror_config,
            &config.npm_mirror,
            &config.pip_mirror,
            env_path.clone(),
            &git_exe,
            &node_dir,
            &python_exe,
            &config,
            &progress_tx,
            step_idx,
            &mut errors,
            &mut installed_components,
            &mut stage_records,
            install_start,
            &log_dir,
            &mut git_exhausted,
        )
        .await;
        step_idx += 1;
    }

        // ====== 生成启动脚本阶段 ======
    let mut scripts_guard = StageGuard::enter(&log_dir, Stage::Scripts);
    let scripts_error_before = errors.len();  // 记录本步骤前的错误数，用于判断本步骤是否引入新错误

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

                // 组件升级脚本（start-upgrade.bat）：自动适配路径 + 自动检测组件 + 3 次重试
                // 安装完成后可与 start-backend.bat / start-frontend.bat 并列使用
                config_gen::generate_start_upgrade_bat(&install_dir)?;

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

    // ====== VCPChat 原生模块 Electron ABI 重建（2026-08-24 新增）======
    // 背景：npm install 用便携 Node 24（ABI 137）编译 better-sqlite3 等原生模块，
    //       但 VCPChat 运行用 Electron 41（ABI 145），ABI 不匹配导致启动崩溃
    // 修复：安装最后环节用 electron-rebuild 按 Electron ABI 重编译
    // 策略：失败不阻断安装（仅警告 + 提示手动修复），与现有 npm 失败哲学一致
    let vcpchat_dir = install_dir.join("VCPChat");
    if config.components.contains(&Component::VCPChat) && vcpchat_dir.exists() {
        run_blocking_step_with_log(step_idx, &progress_tx, &mut errors, {
            let vcpchat_dir = vcpchat_dir.clone();
            let node_dir = node_dir.clone();
            let env_path = env_path.clone();
            let install_path_str = install_dir.display().to_string();

            move |log_fn| {
                // 扫描需要重建的原生模块
                let modules = electron_rebuild::scan_rebuildable_modules(&vcpchat_dir, log_fn);

                if modules.is_empty() {
                    return Ok(());
                }

                // 执行 electron-rebuild（失败不阻断，仅记录警告）
                if let Err(e) = electron_rebuild::rebuild_modules(&node_dir, &vcpchat_dir, &env_path, &modules, log_fn) {
                    // 记录警告但不写入 errors（避免阻断安装）
                    log_fn(&format!(
                        "! [electron-rebuild] 原生模块重建失败: {}",
                        e
                    ));
                    log_fn("[electron-rebuild] 提示：VCPChat 启动前请手动执行以下命令修复 ABI 不匹配：");
                    log_fn(&format!(
                        "    cd {}\\VCPChat",
                        install_path_str
                    ));
                    log_fn("    node node_modules/@electron/rebuild/lib/cli.js -f -o better-sqlite3,node-pty,hnswlib-node");
                }

                Ok(())
            }
        })
        .await;
    }

    // 本步骤是否引入新错误（避免被前面步骤的 npm/pip 失败污染）
    let scripts_introduced_error = errors.len() > scripts_error_before;
    if scripts_introduced_error {
        scripts_guard.mark_failed();
    }

    let backend_script = install_dir.join("start-backend.bat");
    let frontend_script = install_dir.join("start-frontend.bat");

    stage_records.insert(
        Stage::Scripts,
        StageRecord {
            secs: scripts_guard.elapsed_secs(),
            success: Some(!scripts_introduced_error),
        },
    );
    drop(scripts_guard);

    let result = InstallResult {
        success: errors.is_empty(),
        installed_runtimes: installed_runtimes.clone(),
        installed_components: installed_components.clone(),
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
        errors: errors.clone(),
    };

    // ====== 安装汇总（增强版）======
    write_install_summary(
        &log_dir, &install_dir, install_start, install_start_str, &stage_records,
        &runtime_versions, &preferred_mirrors,
        &installed_runtimes, &installed_components, &errors,
        result.backend_start_script.as_ref().map(|p| p.as_path()),
        result.frontend_start_script.as_ref().map(|p| p.as_path()),
        &result,
    );

    let _ = progress_tx.send(ProgressEvent::AllCompleted(result.clone())).await;
    Ok(result)
}

fn pending_step(name: impl Into<String>) -> InstallStep {
    InstallStep {
        name: name.into(),
        status: StepStatus::Pending,
        download_progress: None,
    }
}

fn apply_mirror_to_repo(url: &str, mirror: &GithubMirror, mirror_config: &MirrorConfig) -> String {
    let prefix = mirror.prefix(mirror_config);
    downloader::apply_mirror(url, &prefix)
}

fn build_fail_result(config: &InstallConfig, errors: Vec<String>) -> InstallResult {
    InstallResult {
        success: false,
        installed_runtimes: vec![],
        installed_components: vec![],
        install_path: config.install_path.clone(),
        backend_start_script: None,
        frontend_start_script: None,
        errors,
    }
}

/// 写入增强版安装汇总（install_summary.log）
/// 内容：开始/结束/总耗时、各阶段耗时+状态表、运行时具体版本号、
///       已安装组件、优选镜像站、错误明细、安装路径+脚本路径
fn write_install_summary(
    log_dir: &std::path::Path,
    install_dir: &std::path::Path,
    install_start: std::time::Instant,
    install_start_str: String,
    stage_records: &std::collections::HashMap<Stage, StageRecord>,
    runtime_versions: &[(String, String)],
    preferred_mirrors: &[String],
    installed_runtimes: &[RuntimeComponent],
    installed_components: &[Component],
    errors: &[String],
    backend_script: Option<&std::path::Path>,
    frontend_script: Option<&std::path::Path>,
    result: &InstallResult,
) {
    let total_secs = install_start.elapsed().as_secs();
    let total_str = format_duration(total_secs);
    let end_str = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");

    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("{:=^70}", ""));
    lines.push(format!("VCP Installer 安装汇总 | {}", end_str));
    lines.push(format!("{:=^70}", ""));
    lines.push(format!("开始时间: {}", install_start_str));
    lines.push(format!("结束时间: {}", end_str));
    lines.push(format!("总耗时: {} ({} 秒)", total_str, total_secs));
    lines.push(format!(
        "安装结果: {}",
        if result.success { "全部成功" } else { "完成（有错误）" }
    ));
    lines.push(format!("安装目录: {}", install_dir.display()));
    lines.push(format!("日志目录: {}", log_dir.display()));
    lines.push(String::new());

    // 各阶段耗时与状态
    lines.push("── 各阶段耗时与状态 ──".to_string());
    let stage_order = [
        Stage::SiteTest,
        Stage::Runtime,
        Stage::Msvc,
        Stage::VCPToolBox,
        Stage::VCPChat,
        Stage::Scripts,
    ];
    for stage in &stage_order {
        if let Some(rec) = stage_records.get(stage) {
            let status = match rec.success {
                Some(true) => "[OK] 成功",
                Some(false) => "[XX] 失败",
                None => "[-]  未执行",
            };
            lines.push(format!(
                "  {} {:<24} {} | {} ({} 秒)",
                stage.filename(),
                stage.description(),
                status,
                format_duration(rec.secs),
                rec.secs
            ));
        } else {
            lines.push(format!(
                "  {} {:<24} [-]  未执行",
                stage.filename(),
                stage.description()
            ));
        }
    }
    lines.push(String::new());

    // 运行时具体版本号
    lines.push("── 运行时环境 ──".to_string());
    if runtime_versions.is_empty() {
        lines.push("  （无）".to_string());
    } else {
        for (name, version) in runtime_versions {
            lines.push(format!("  [OK] {:<10} {}", name, version));
        }
    }
    let runtimes_str = if installed_runtimes.is_empty() {
        "无".to_string()
    } else {
        installed_runtimes
            .iter()
            .map(|r| format!("{:?}", r))
            .collect::<Vec<_>>()
            .join(", ")
    };
    lines.push(format!("  已安装运行时: {}", runtimes_str));
    lines.push(String::new());

    // 已安装组件
    lines.push("── 已安装组件 ──".to_string());
    let components_str = if installed_components.is_empty() {
        "无".to_string()
    } else {
        installed_components
            .iter()
            .map(|c| format!("{:?}", c))
            .collect::<Vec<_>>()
            .join(", ")
    };
    lines.push(format!("  {}", components_str));
    lines.push(String::new());

    // 优选镜像站
    lines.push("── 优选 GitHub 镜像站 ──".to_string());
    if preferred_mirrors.is_empty() {
        lines.push("  （未选出）".to_string());
    } else {
        for (i, m) in preferred_mirrors.iter().enumerate() {
            lines.push(format!("  {}. {}", i + 1, m));
        }
    }
    lines.push(String::new());

    // 错误明细
    lines.push("── 错误明细 ──".to_string());
    if errors.is_empty() {
        lines.push("  （无错误）".to_string());
    } else {
        lines.push(format!("  错误数: {}", errors.len()));
        for (i, e) in errors.iter().enumerate() {
            lines.push(format!("  {}. {}", i + 1, e));
        }
    }
    lines.push(String::new());

    // 启动脚本
    lines.push("── 启动脚本 ──".to_string());
    match backend_script {
        Some(p) => lines.push(format!("  [OK] 后端: {}", p.display())),
        None => lines.push("  [-]  后端: 未生成".to_string()),
    }
    match frontend_script {
        Some(p) => lines.push(format!("  [OK] 前端: {}", p.display())),
        None => lines.push("  [-]  前端: 未生成".to_string()),
    }
    lines.push(String::new());
    lines.push("详细日志见各阶段文件（01~07）及全量日志 00_full_log.txt".to_string());
    lines.push(format!("{:=^70}", ""));

    let _ = std::fs::write(log_dir.join("install_summary.log"), lines.join("\n"));

    // 合并全量日志：把所有阶段（01~07）分段日志按顺序拼接成 00_full_log.txt。
    // 安装结束时调用，此时所有阶段 guard 已 drop、分段文件已写完，
    // 单线程纯拼接、无并发写入，从结构上避免双写/重复。
    crate::log_router::merge_full_log(log_dir);
}

/// 秒数格式化为 "X 分 Y 秒" 或 "Y 秒"
fn format_duration(secs: u64) -> String {
    if secs >= 60 {
        format!("{} 分 {} 秒", secs / 60, secs % 60)
    } else {
        format!("{} 秒", secs)
    }
}

async fn send_log(progress_tx: &mpsc::Sender<ProgressEvent>, message: impl Into<String>) {
    crate::log_router::send_log_event(progress_tx, message).await;
}

/// 静默执行阻塞任务（写日志，不发送进度事件，不占用可见步骤）
async fn run_blocking_silent<F>(errors: &mut Vec<String>, job: F) -> bool
where
    F: FnOnce(&dyn Fn(&str)) -> Result<()> + Send + 'static,
{
    match tokio::task::spawn_blocking(move || {
        let log_fn = |msg: &str| {
            crate::log_router::append_log(msg);
        };
        job(&log_fn)
    }).await {
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

/// 静默跳过子步骤（写日志，不占用可见步骤）
async fn skip_silent(progress_tx: &mpsc::Sender<ProgressEvent>, reason: impl Into<String>) {
    let _ = crate::log_router::send_log_event(progress_tx, reason).await;
}

async fn skip_step(
    progress_tx: &mpsc::Sender<ProgressEvent>,
    step_index: usize,
    reason: impl Into<String>,
) {
    let reason = reason.into();
    if !reason.is_empty() {
        let _ = crate::log_router::send_log_event(&progress_tx, reason).await;
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
            let _ = crate::log_router::send_log_event_sync(&tx, (msg.to_string()));
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