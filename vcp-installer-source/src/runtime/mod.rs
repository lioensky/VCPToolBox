pub mod portable_git;
pub mod portable_node;
pub mod portable_python;

use std::path::{Path, PathBuf};

use anyhow::Result;
use tokio::sync::mpsc;

use crate::app::{DependencyStatus, EnvCheckResult, GithubMirror, ProgressEvent};

#[derive(Debug)]
pub struct RuntimeManager {
    pub runtimes_dir: PathBuf,
    pub git: Option<portable_git::PortableGit>,
    pub node: Option<portable_node::PortableNode>,
    pub python: Option<portable_python::PortablePython>,
}

impl RuntimeManager {
    pub fn new(install_path: &Path) -> Self {
        Self {
            runtimes_dir: install_path.join("runtimes"),
            git: None,
            node: None,
            python: None,
        }
    }

    /// 确保三个运行时全部就绪
    /// step_offset:
    /// - Git: step_offset
    /// - Node: step_offset + 1
    /// - Python: step_offset + 2
    pub async fn ensure_all(
        &mut self,
        env_check: &EnvCheckResult,
        mirror: &GithubMirror,
        progress_tx: mpsc::Sender<ProgressEvent>,
        step_offset: usize,
    ) -> Result<()> {
        tokio::fs::create_dir_all(&self.runtimes_dir).await?;

        ensure_git(
            &self.runtimes_dir,
            &mut self.git,
            &env_check.git,
            mirror,
            step_offset,
            &progress_tx,
        )
        .await?;

        ensure_node(
            &self.runtimes_dir,
            &mut self.node,
            &env_check.node,
            step_offset + 1,
            &progress_tx,
        )
        .await?;

        ensure_python(
            &self.runtimes_dir,
            &mut self.python,
            &env_check.python,
            mirror,
            step_offset + 2,
            &progress_tx,
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
}

async fn ensure_git(
    runtimes_dir: &Path,
    slot: &mut Option<portable_git::PortableGit>,
    system_status: &DependencyStatus,
    mirror: &GithubMirror,
    step_index: usize,
    progress_tx: &mpsc::Sender<ProgressEvent>,
) -> Result<()> {
    log_system_status("Git", system_status, progress_tx).await;

    let existing = portable_git::PortableGit {
        install_dir: runtimes_dir.join("git"),
        git_exe: portable_git::PortableGit::git_exe_path(runtimes_dir),
    };

    if portable_git::PortableGit::is_installed(runtimes_dir) {
        match existing.verify() {
            Ok(version) => {
                let _ = progress_tx
                    .send(ProgressEvent::Log(format!(
                        "PortableGit 已存在，跳过下载：{}",
                        version
                    )))
                    .await;
                let _ = progress_tx
                    .send(ProgressEvent::StepSkipped { step_index })
                    .await;
                *slot = Some(existing);
                return Ok(());
            }
            Err(err) => {
                let _ = progress_tx
                    .send(ProgressEvent::Log(format!(
                        "已有 PortableGit 校验失败，准备重装：{}",
                        err
                    )))
                    .await;
                let _ = tokio::fs::remove_dir_all(runtimes_dir.join("git")).await;
            }
        }
    }

    *slot = Some(
        portable_git::PortableGit::install(
            runtimes_dir,
            mirror,
            step_index,
            progress_tx.clone(),
        )
        .await?,
    );

    Ok(())
}

async fn ensure_node(
    runtimes_dir: &Path,
    slot: &mut Option<portable_node::PortableNode>,
    system_status: &DependencyStatus,
    step_index: usize,
    progress_tx: &mpsc::Sender<ProgressEvent>,
) -> Result<()> {
    log_system_status("Node.js", system_status, progress_tx).await;

    let existing = portable_node::PortableNode {
        install_dir: runtimes_dir.join("node"),
        node_exe: portable_node::PortableNode::node_exe_path(runtimes_dir),
        npm_cmd: portable_node::PortableNode::npm_cmd_path(runtimes_dir),
    };

    if portable_node::PortableNode::is_installed(runtimes_dir) {
        match existing.verify() {
            Ok(version) => {
                let _ = progress_tx
                    .send(ProgressEvent::Log(format!(
                        "PortableNode 已存在，跳过下载：{}",
                        version
                    )))
                    .await;
                let _ = progress_tx
                    .send(ProgressEvent::StepSkipped { step_index })
                    .await;
                *slot = Some(existing);
                return Ok(());
            }
            Err(err) => {
                let _ = progress_tx
                    .send(ProgressEvent::Log(format!(
                        "已有 PortableNode 校验失败，准备重装：{}",
                        err
                    )))
                    .await;
                let _ = tokio::fs::remove_dir_all(runtimes_dir.join("node")).await;
            }
        }
    }

    *slot = Some(
        portable_node::PortableNode::install(
            runtimes_dir,
            step_index,
            progress_tx.clone(),
        )
        .await?,
    );

    Ok(())
}

async fn ensure_python(
    runtimes_dir: &Path,
    slot: &mut Option<portable_python::PortablePython>,
    system_status: &DependencyStatus,
    mirror: &GithubMirror,
    step_index: usize,
    progress_tx: &mpsc::Sender<ProgressEvent>,
) -> Result<()> {
    log_system_status("Python", system_status, progress_tx).await;

    let existing = portable_python::PortablePython {
        install_dir: runtimes_dir.join("python"),
        python_exe: portable_python::PortablePython::python_exe_path(runtimes_dir),
        pip_exe: portable_python::PortablePython::pip_exe_path(runtimes_dir),
    };

    if portable_python::PortablePython::is_installed(runtimes_dir) {
        match existing.verify() {
            Ok(version) => {
                let _ = progress_tx
                    .send(ProgressEvent::Log(format!(
                        "PortablePython 已存在，跳过下载：{}",
                        version
                    )))
                    .await;
                let _ = progress_tx
                    .send(ProgressEvent::StepSkipped { step_index })
                    .await;
                *slot = Some(existing);
                return Ok(());
            }
            Err(err) => {
                let _ = progress_tx
                    .send(ProgressEvent::Log(format!(
                        "已有 PortablePython 校验失败，准备重装：{}",
                        err
                    )))
                    .await;
                let _ = tokio::fs::remove_dir_all(runtimes_dir.join("python")).await;
            }
        }
    }

    *slot = Some(
        portable_python::PortablePython::install(
            runtimes_dir,
            mirror,
            step_index,
            progress_tx.clone(),
        )
        .await?,
    );

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

    let _ = progress_tx.send(ProgressEvent::Log(message)).await;
}