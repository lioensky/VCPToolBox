pub mod portable_git;
pub mod portable_node;
pub mod portable_python;

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use anyhow::Result;
use tokio::sync::mpsc;

use crate::app::{DependencyStatus, EnvCheckResult, GithubMirror, ProgressEvent};
use crate::cache::CacheManager;
use crate::mirrors::MirrorConfig;

#[derive(Debug)]
pub struct RuntimeManager {
    pub runtimes_dir: PathBuf,
    pub cache: CacheManager,
    pub git: Option<portable_git::PortableGit>,
    pub node: Option<portable_node::PortableNode>,
    pub python: Option<portable_python::PortablePython>,
}

impl RuntimeManager {
    pub fn new(install_path: &Path, cache: CacheManager) -> Self {
        Self {
            runtimes_dir: install_path.join("runtimes"),
            cache,
            git: None,
            node: None,
            python: None,
        }
    }

    /// 确保三个运行时全部就绪
    pub async fn ensure_all(
        &mut self,
        env_check: &EnvCheckResult,
        mirror: &GithubMirror,
        mirror_config: &MirrorConfig,
        progress_tx: mpsc::Sender<ProgressEvent>,
        step_offset: usize,
    ) -> Result<()> {
        tokio::fs::create_dir_all(&self.runtimes_dir).await?;
        tokio::fs::create_dir_all(self.cache.dl_runtimes_dir()).await?;

        ensure_runtime(
            "Git",
            self.runtimes_dir.clone(),
            self.cache.clone(),
            &mut self.git,
            &env_check.git,
            step_offset,
            progress_tx.clone(),
            |runtimes_dir, cache, tx, step_index| {
                let mirror = mirror.clone();
                let mirror_config = mirror_config.clone();
                Box::pin(async move {
                    portable_git::PortableGit::install(
                        &runtimes_dir,
                        &cache,
                        &mirror,
                        &mirror_config,
                        step_index,
                        tx,
                    )
                    .await
                })
            },
        )
        .await?;

        ensure_runtime(
            "Node.js",
            self.runtimes_dir.clone(),
            self.cache.clone(),
            &mut self.node,
            &env_check.node,
            step_offset + 1,
            progress_tx.clone(),
            |_runtimes_dir, cache, tx, step_index| {
                let runtimes_dir = self.runtimes_dir.clone();
                let mirror_config = mirror_config.clone();
                Box::pin(async move {
                    portable_node::PortableNode::install(
                        &runtimes_dir,
                        &cache,
                        &mirror_config,
                        step_index,
                        tx,
                    )
                    .await
                })
            },
        )
        .await?;

        ensure_runtime(
            "Python",
            self.runtimes_dir.clone(),
            self.cache.clone(),
            &mut self.python,
            &env_check.python,
            step_offset + 2,
            progress_tx.clone(),
            |runtimes_dir, cache, tx, step_index| {
                let mirror = mirror.clone();
                let mirror_config = mirror_config.clone();
                Box::pin(async move {
                    portable_python::PortablePython::install(
                        &runtimes_dir,
                        &cache,
                        &mirror,
                        &mirror_config,
                        step_index,
                        tx,
                    )
                    .await
                })
            },
        )
        .await?;

        Ok(())
    }

    /// 构建供子进程使用的 PATH
    pub fn build_path_env(&self) -> String {
        crate::utils::env::build_runtime_path(&self.runtimes_dir)
    }

    /// 直接应用到当前进程
    pub fn apply_path_env(&self) {
        crate::utils::env::apply_runtime_path(&self.runtimes_dir);
    }

    /// 获取当前已安装的运行时组件列表
    pub fn get_installed_runtimes(&self) -> Vec<crate::app::RuntimeComponent> {
        use crate::app::RuntimeComponent;
        let mut runtimes = Vec::new();
        if self.git.is_some() {
            runtimes.push(RuntimeComponent::Git);
        }
        if self.node.is_some() {
            runtimes.push(RuntimeComponent::NodeJs);
        }
        if self.python.is_some() {
            runtimes.push(RuntimeComponent::Python);
        }
        runtimes
    }
}

/// 运行时包统一接口：Git / Node.js / Python 都满足「检测→安装→验证」流程
pub trait RuntimePackage: Clone + Send + 'static {
    /// 显示名称
    fn name() -> &'static str;
    /// runtimes/ 下的目录名
    fn install_dir_name() -> &'static str;
    /// 检查是否已安装
    fn is_installed(runtimes_dir: &Path) -> bool;
    /// 构造一个已存在的实例（用于 verify）
    fn existing(runtimes_dir: &Path) -> Self;
    /// 验证安装
    fn verify(&self) -> Result<String>;
}

impl RuntimePackage for portable_git::PortableGit {
    fn name() -> &'static str { "Git" }
    fn install_dir_name() -> &'static str { "git" }

    fn is_installed(runtimes_dir: &Path) -> bool {
        Self::git_exe_path(runtimes_dir).exists()
    }

    fn existing(runtimes_dir: &Path) -> Self {
        Self {
            install_dir: runtimes_dir.join("git"),
            git_exe: Self::git_exe_path(runtimes_dir),
        }
    }

    fn verify(&self) -> Result<String> {
        portable_git::PortableGit::verify(self)
    }
}

impl RuntimePackage for portable_node::PortableNode {
    fn name() -> &'static str { "Node.js" }
    fn install_dir_name() -> &'static str { "node" }

    fn is_installed(runtimes_dir: &Path) -> bool {
        Self::node_exe_path(runtimes_dir).exists()
    }

    fn existing(runtimes_dir: &Path) -> Self {
        Self {
            install_dir: runtimes_dir.join("node"),
            node_exe: Self::node_exe_path(runtimes_dir),
            npm_cmd: Self::npm_cmd_path(runtimes_dir),
        }
    }

    fn verify(&self) -> Result<String> {
        portable_node::PortableNode::verify(self)
    }
}

impl RuntimePackage for portable_python::PortablePython {
    fn name() -> &'static str { "Python" }
    fn install_dir_name() -> &'static str { "python" }

    fn is_installed(runtimes_dir: &Path) -> bool {
        Self::is_installed(runtimes_dir)
    }

    fn existing(runtimes_dir: &Path) -> Self {
        Self {
            install_dir: runtimes_dir.join("python"),
            python_exe: Self::python_exe_path(runtimes_dir),
            pip_exe: Self::pip_exe_path(runtimes_dir),
        }
    }

    fn verify(&self) -> Result<String> {
        portable_python::PortablePython::verify(self)
    }
}

/// 统一确保单个运行时就绪
///
/// 流程：
/// 1. 记录系统状态
/// 2. 若已安装且验证通过 → StepSkipped
/// 3. 否则调用 installer 闭包下载/安装
/// 4. 安装结果放入 slot
async fn ensure_runtime<T, F>(
    name: &str,
    runtimes_dir: PathBuf,
    cache: CacheManager,
    slot: &mut Option<T>,
    system_status: &DependencyStatus,
    step_index: usize,
    progress_tx: mpsc::Sender<ProgressEvent>,
    installer: F,
) -> Result<()>
where
    T: RuntimePackage,
    F: FnOnce(PathBuf, CacheManager, mpsc::Sender<ProgressEvent>, usize) -> Pin<Box<dyn Future<Output = Result<T>> + Send>>,
{
    log_system_status(name, system_status, &progress_tx).await;

    let existing = T::existing(&runtimes_dir);

    if T::is_installed(&runtimes_dir) {
        match existing.verify() {
            Ok(version) => {
                let _ = crate::log_router::send_log_event(
                    &progress_tx,
                    format!("Portable{} 已存在，跳过下载：{}", name, version),
                )
                .await;
                let _ = progress_tx
                    .send(ProgressEvent::StepSkipped { step_index })
                    .await;
                *slot = Some(existing);
                return Ok(());
            }
            Err(err) => {
                let _ = crate::log_router::send_log_event(
                    &progress_tx,
                    format!("已有 Portable{} 校验失败，准备重装：{}", name, err),
                )
                .await;
                let install_dir = runtimes_dir.join(T::install_dir_name());
                let _ = tokio::fs::remove_dir_all(&install_dir).await;
            }
        }
    }

    *slot = Some(installer(runtimes_dir, cache, progress_tx, step_index).await?);

    Ok(())
}

async fn log_system_status(
    name: &str,
    status: &DependencyStatus,
    progress_tx: &mpsc::Sender<ProgressEvent>,
) {
    let message = match status {
        DependencyStatus::Installed(version) => {
            format!("检测到系统 {}: {}，但为保证环境隔离，仍优先使用 Portable 版", name, version)
        }
        DependencyStatus::NotFound => {
            format!("未检测到系统 {}，将安装 Portable 版", name)
        }
        DependencyStatus::Checking => {
            format!("{} 仍处于检测中，按需准备 Portable 版", name)
        }
        DependencyStatus::WillUsePortable => {
            format!("{} 已标记为使用 Portable 版", name)
        }
    };

    let _ = crate::log_router::send_log_event(progress_tx, message).await;
}
