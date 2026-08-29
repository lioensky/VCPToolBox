//! 统一安装包执行器
//!
//! 设计目标：把运行时安装（Git/Node/Python）和应用组件安装（tarball/git clone）
//! 纳入同一套「检测 → 下载/克隆 → 安装 → 验证 → 记录日志」流程，避免重复代码。
//!
//! 核心抽象：
//! - PackageContext: 安装上下文（安装目录、缓存、进度发送器、日志目录等）
//! - PackageTask:    一个可安装包任务，包含名称、阶段、步骤索引、实际工作 Future
//! - run_package_task: 统一执行器，负责发送 StepStarted/Skipped/Completed/Failed
//!                     并自动切换到对应 Stage 日志文件
//!
//! 使用方式：
//! ```
//! let task = PackageTask {
//!     name: "下载 PortableGit".to_string(),
//!     stage: Stage::Runtime,
//!     step_index,
//!     work: Box::pin(async move { ... }),
//! };
//! run_package_task(task, &progress_tx, &mut errors).await;
//! ```

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use anyhow::Result;
use tokio::sync::mpsc;

use crate::app::ProgressEvent;
use crate::cache::CacheManager;
use crate::installer::Stage;

/// 安装包任务上下文（跨多个 task 共享）
#[derive(Clone, Debug)]
pub struct PackageContext {
    /// 安装根目录
    pub install_dir: PathBuf,
    /// 运行时目录（install_dir/runtimes）
    pub runtimes_dir: PathBuf,
    /// DL_runtimes 缓存目录
    pub cache: CacheManager,
    /// 全局进度事件发送器
    pub progress_tx: mpsc::Sender<ProgressEvent>,
}

impl PackageContext {
    pub fn new(
        install_dir: impl Into<PathBuf>,
        cache: CacheManager,
        progress_tx: mpsc::Sender<ProgressEvent>,
    ) -> Self {
        let install_dir = install_dir.into();
        let runtimes_dir = install_dir.join("runtimes");
        Self {
            install_dir,
            runtimes_dir,
            cache,
            progress_tx,
        }
    }
}

/// 一个安装包任务
///
/// 调用方负责构造实际工作 Future；run_package_task 只负责统一事件和错误包装。
pub struct PackageTask {
    /// 步骤显示名称
    pub name: String,
    /// 所属阶段（用于日志文件切换）
    pub stage: Stage,
    /// 在 TUI 步骤列表中的索引
    pub step_index: usize,
    /// 进度事件发送器
    pub progress_tx: mpsc::Sender<ProgressEvent>,
    /// 实际工作：检测/下载/安装/验证都封装在这里
    pub work: Pin<Box<dyn Future<Output = Result<()>> + Send>>,
}

impl std::fmt::Debug for PackageTask {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PackageTask")
            .field("name", &self.name)
            .field("stage", &self.stage)
            .field("step_index", &self.step_index)
            .field("progress_tx", &"<sender>")
            .field("work", &"<future>")
            .finish()
    }
}

/// 统一执行一个安装包任务
///
/// 行为：
/// 1. 发送 StepStarted
/// 2. 设置 stage 日志文件
/// 3. 执行 work Future
/// 4. 成功 → 发送 StepCompleted；失败 → 发送 StepFailed 并把错误追加到 errors
///
/// 注意：本函数不决定 step_index 如何递增，调用方自行管理。
pub async fn run_package_task(
    task: PackageTask,
    log_dir: &Path,
    errors: &mut Vec<String>,
) {
    use crate::log_router;

    // 切换到阶段日志文件
    let stage_log = log_dir.join(task.stage.filename());
    log_router::set_stage_log(Some(stage_log));

    // 发送开始事件
    let _ = task
        .progress_tx
        .send(ProgressEvent::StepStarted {
            step_index: task.step_index,
        })
        .await;

    log_router::send_log_event(&task.progress_tx, format!("[{}] 开始...", task.name)).await;

    // 执行任务
    match task.work.await {
        Ok(()) => {
            log_router::send_log_event(&task.progress_tx, format!("[{}] 完成", task.name)).await;
            let _ = task
                .progress_tx
                .send(ProgressEvent::StepCompleted {
                    step_index: task.step_index,
                })
                .await;
        }
        Err(e) => {
            let err_msg = format!("{:#}", e);
            log_router::send_log_event(
                &task.progress_tx,
                format!("[{}] 失败: {}", task.name, err_msg),
            )
            .await;
            errors.push(format!("{}: {}", task.name, err_msg));
            let _ = task
                .progress_tx
                .send(ProgressEvent::StepFailed {
                    step_index: task.step_index,
                    error: err_msg,
                })
                .await;
        }
    }

    // 离开阶段日志
    log_router::set_stage_log(None);
}

/// 便捷：执行一个静默任务（不发送 StepStarted/Completed，只写日志）
///
/// 用于 npm install / pip install / 配置文件生成等子步骤。
pub async fn run_silent_task<F>(
    name: &str,
    stage: Stage,
    log_dir: &Path,
    progress_tx: &mpsc::Sender<ProgressEvent>,
    work: F,
    errors: &mut Vec<String>,
) where
    F: Future<Output = Result<()>> + Send,
{
    use crate::log_router;

    let stage_log = log_dir.join(stage.filename());
    log_router::set_stage_log(Some(stage_log));

    log_router::send_log_event(progress_tx, format!("[{}] 开始...", name)).await;

    match work.await {
        Ok(()) => {
            log_router::send_log_event(progress_tx, format!("[{}] 完成", name)).await;
        }
        Err(e) => {
            let err_msg = format!("{:#}", e);
            log_router::send_log_event(
                progress_tx,
                format!("[{}] 失败: {}", name, err_msg),
            )
            .await;
            errors.push(format!("{}: {}", name, err_msg));
        }
    }

    log_router::set_stage_log(None);
}

// ========================
// Stage 扩展（供 package.rs 使用）
// ========================

impl Stage {
    pub fn filename(&self) -> &'static str {
        match self {
            Stage::Prepare => "01_prepare.log",
            Stage::SiteTest => "02_site_test.log",
            Stage::Runtime => "03_runtime.log",
            Stage::Msvc => "04_msvc.log",
            Stage::VCPToolBox => "05_vcptoolbox.log",
            Stage::VCPChat => "06_vcpchat.log",
            Stage::VCPBackUpDEV => "07_backupdev.log",
            Stage::VCPDistributedServer => "08_distserver.log",
            Stage::Scripts => "09_scripts.log",
        }
    }

    pub fn description(&self) -> &'static str {
        match self {
            Stage::Prepare => "环境检测+准备",
            Stage::SiteTest => "镜像站点测试",
            Stage::Runtime => "运行时安装（Git/Node/Python/NewAPI）",
            Stage::Msvc => "MSVC Build Tools",
            Stage::VCPToolBox => "VCPToolBox 安装",
            Stage::VCPChat => "VCPChat 安装",
            Stage::VCPBackUpDEV => "VCPBackUpDEV 安装",
            Stage::VCPDistributedServer => "VCPDistributedServer 安装",
            Stage::Scripts => "配置文件+启动脚本生成",
        }
    }
}
