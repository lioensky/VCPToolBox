use std::{
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result};
use tokio::sync::mpsc;

use crate::app::ProgressEvent;

#[derive(Debug, Clone)]
pub struct PortableNode {
    pub install_dir: PathBuf,
    pub node_exe: PathBuf,
    pub npm_cmd: PathBuf,
}

impl PortableNode {
    pub fn is_installed(runtimes_dir: &Path) -> bool {
        Self::node_exe_path(runtimes_dir).exists()
    }

    pub fn node_exe_path(runtimes_dir: &Path) -> PathBuf {
        runtimes_dir.join("node").join("node.exe")
    }

    pub fn npm_cmd_path(runtimes_dir: &Path) -> PathBuf {
        runtimes_dir.join("node").join("npm.cmd")
    }

    pub async fn install(
        runtimes_dir: &Path,
        step_index: usize,
        progress_tx: mpsc::Sender<ProgressEvent>,
    ) -> Result<Self> {
        let install_dir = runtimes_dir.join("node");
        let temp_file = runtimes_dir.join("node.zip");
        let temp_extract = runtimes_dir.join("node_temp");

        let result: Result<Self> = async {
            tokio::fs::create_dir_all(runtimes_dir)
                .await
                .context("创建 runtimes 目录失败")?;

            let _ = progress_tx
                .send(ProgressEvent::StepStarted { step_index })
                .await;

            let version = crate::installer::downloader::get_nodejs_lts_version()
                .await
                .context("获取 Node.js LTS 版本失败")?;

            let _ = progress_tx
                .send(ProgressEvent::Log(format!(
                    "Node.js LTS 版本: {}",
                    version
                )))
                .await;

            let url = format!(
                "https://nodejs.org/dist/{}/node-{}-win-x64.zip",
                version, version
            );

            let _ = progress_tx
                .send(ProgressEvent::Log("正在下载 Node.js...".to_string()))
                .await;

            crate::installer::downloader::download_with_retry(
                crate::installer::downloader::DownloadConfig {
                    url,
                    dest: temp_file.clone(),
                    step_index,
                    resume: false,
                },
                progress_tx.clone(),
                3,
            )
            .await
            .context("下载 Node.js 失败")?;

            let _ = progress_tx
                .send(ProgressEvent::Log("正在解压 Node.js...".to_string()))
                .await;

            if temp_extract.exists() {
                let _ = tokio::fs::remove_dir_all(&temp_extract).await;
            }
            tokio::fs::create_dir_all(&temp_extract).await?;

            crate::installer::extractor::extract(&temp_file, &temp_extract)
                .await
                .context("解压 Node.js ZIP 失败")?;

            let extracted_root =
                find_node_root(&temp_extract).context("定位 Node.js 根目录失败")?;

            if install_dir.exists() {
                let _ = tokio::fs::remove_dir_all(&install_dir).await;
            }

            if extracted_root == temp_extract {
                tokio::fs::rename(&temp_extract, &install_dir)
                    .await
                    .context("移动 Node.js 安装目录失败")?;
            } else {
                tokio::fs::rename(&extracted_root, &install_dir)
                    .await
                    .context("提升 Node.js 目录层级失败")?;
                let _ = tokio::fs::remove_dir_all(&temp_extract).await;
            }

            let _ = tokio::fs::remove_file(&temp_file).await;

            let node = Self {
                install_dir: install_dir.clone(),
                node_exe: Self::node_exe_path(runtimes_dir),
                npm_cmd: Self::npm_cmd_path(runtimes_dir),
            };

            let verified = node.verify()?;
            let _ = progress_tx
                .send(ProgressEvent::Log(format!(
                    "Node.js 安装完成：{}",
                    verified
                )))
                .await;

            Ok(node)
        }
        .await;

        match result {
            Ok(node) => {
                let _ = progress_tx
                    .send(ProgressEvent::StepCompleted { step_index })
                    .await;
                Ok(node)
            }
            Err(err) => {
                let _ = progress_tx
                    .send(ProgressEvent::StepFailed {
                        step_index,
                        error: format!("{err:#}"),
                    })
                    .await;
                Err(err)
            }
        }
    }

    pub fn verify(&self) -> Result<String> {
        if !self.node_exe.exists() {
            anyhow::bail!("未找到 node.exe: {}", self.node_exe.display());
        }
        if !self.npm_cmd.exists() {
            anyhow::bail!("未找到 npm.cmd: {}", self.npm_cmd.display());
        }

        let output = Command::new(&self.node_exe)
            .arg("--version")
            .output()
            .with_context(|| format!("无法运行 node: {}", self.node_exe.display()))?;

        if !output.status.success() {
            anyhow::bail!(
                "Node.js 验证失败: {}",
                read_output_text(&output.stdout, &output.stderr)
            );
        }

        let version = read_output_text(&output.stdout, &output.stderr);
        if version.starts_with('v') {
            Ok(version)
        } else {
            anyhow::bail!("Node.js 验证失败，输出异常: {}", version);
        }
    }
}

fn find_node_root(dir: &Path) -> Result<PathBuf> {
    if dir.join("node.exe").exists() {
        return Ok(dir.to_path_buf());
    }

    let mut children = Vec::new();

    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            children.push(entry.path());
        }
    }

    for child in &children {
        if child.join("node.exe").exists() {
            return Ok(child.clone());
        }
    }

    if children.len() == 1 {
        return Ok(children.remove(0));
    }

    anyhow::bail!("解压目录结构异常，未找到 Node.js 根目录");
}

fn read_output_text(stdout: &[u8], stderr: &[u8]) -> String {
    let out = String::from_utf8_lossy(stdout).trim().to_string();
    if !out.is_empty() {
        out
    } else {
        String::from_utf8_lossy(stderr).trim().to_string()
    }
}