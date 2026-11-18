use std::{
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result};
use tokio::sync::mpsc;

use crate::app::{GithubMirror, ProgressEvent};
use crate::cache::CacheManager;
use crate::mirrors::MirrorConfig;

#[derive(Debug, Clone)]
pub struct PortableGit {
    pub install_dir: PathBuf,
    pub git_exe: PathBuf,
}

impl PortableGit {
    pub fn is_installed(runtimes_dir: &Path) -> bool {
        Self::git_exe_path(runtimes_dir).exists()
    }

    pub fn git_exe_path(runtimes_dir: &Path) -> PathBuf {
        runtimes_dir.join("git").join("cmd").join("git.exe")
    }

    pub async fn install(
        runtimes_dir: &Path,
        cache: &CacheManager,
        mirror: &GithubMirror,
        mirror_config: &MirrorConfig,
        step_index: usize,
        progress_tx: mpsc::Sender<ProgressEvent>,
    ) -> Result<Self> {
        let install_dir = runtimes_dir.join("git");

        let result: Result<Self> = async {
            tokio::fs::create_dir_all(runtimes_dir)
                .await
                .context("创建 runtimes 目录失败")?;

            let _ = progress_tx
                .send(ProgressEvent::StepStarted { step_index })
                .await;

            let _ = crate::log_router::send_log_event(&progress_tx,
                "正在查询 PortableGit 最新版本...".to_string(),
            ).await;

            let (download_url, version) =
                crate::installer::downloader::get_github_release_url(
                    "git-for-windows/git",
                    "PortableGit",
                )
                .await
                .context("获取 PortableGit release 下载地址失败")?;

            let _ = crate::log_router::send_log_event(&progress_tx, format!(
                "PortableGit 版本: {}",
                version
            )).await;

            if !download_url.contains("64-bit.7z.exe") {
                let _ = crate::log_router::send_log_event(&progress_tx, format!(
                    "警告：当前命中的 Git 资源不是显式 64-bit.7z.exe，请确认 P1 的 release 选择逻辑：{}",
                    download_url
                )).await;
            }

            // 2026-08-23: INI 版本校验（统一缓存校验机制）
            // 检查 DL_runtimes 中的缓存文件是否匹配当前最新版本
            let dl_file_path = cache.path("PortableGit.7z.exe");
            let ini_version = mirror_config.get_runtime_version("PortableGit");
            let cache_exists = dl_file_path.exists();

            let needs_download;
            match ini_version {
                Some(v) if v == &version => {
                    // INI 记录版本 == 最新版本
                    if cache_exists {
                        // 缓存存在且版本匹配 → 使用缓存
                        let _ = crate::log_router::send_log_event(&progress_tx, format!(
                            "PortableGit 缓存校验通过（版本 {}），使用缓存",
                            version
                        )).await;
                        needs_download = false;
                    } else {
                        // 版本匹配但缓存文件丢失 → 重新下载
                        let _ = crate::log_router::send_log_event(&progress_tx,
                            "PortableGit 缓存文件丢失，重新下载".to_string()).await;
                        needs_download = true;
                    }
                }
                Some(v) => {
                    // INI 记录版本 != 最新版本 → 缓存过期
                    let _ = crate::log_router::send_log_event(&progress_tx, format!(
                        "PortableGit 缓存过期（INI: {} → 最新: {}），重新下载",
                        v, version
                    )).await;
                    needs_download = true;
                }
                None => {
                    // INI 无记录
                    if cache_exists {
                        // 缓存存在但无 INI 记录 → 无法确认版本，重新下载
                        let _ = crate::log_router::send_log_event(&progress_tx,
                            "PortableGit 缓存存在但无版本记录，重新下载".to_string()).await;
                    }
                    needs_download = true;
                }
            }

            // 下载 PortableGit（多镜像降级：用户镜像 → preferred_github → GitHub 直连）
            if needs_download {
                let _ = crate::log_router::send_log_event(&progress_tx,
                    "正在下载 PortableGit（多镜像降级 + 断点续传）...".to_string()).await;

                let _path = crate::installer::downloader::download_with_preferred_fallback(
                    crate::installer::downloader::DownloadConfig {
                        url: download_url.clone(),
                        dest: dl_file_path.clone(),
                        step_index,
                        resume: true,
                    },
                    mirror,
                    mirror_config,
                    progress_tx.clone(),
                    2,  // 每镜像重试 2 次
                )
                .await
                .context("下载 PortableGit 失败（所有镜像站均已尝试）")?;

                // 下载成功后，更新 INI 记录版本
                let mut mc = mirror_config.clone();
                if mc.set_and_save_runtime_version("PortableGit", &version).is_ok() {
                    let _ = crate::log_router::send_log_event(&progress_tx, format!(
                        "PortableGit 版本已记录到 INI: {}",
                        version
                    )).await;
                }
            }

            let dl_file = dl_file_path;

            let _ = crate::log_router::send_log_event(&progress_tx,
                "正在解压 PortableGit...".to_string()).await;

            if install_dir.exists() {
                let _ = tokio::fs::remove_dir_all(&install_dir).await;
            }
            tokio::fs::create_dir_all(&install_dir)
                .await
                .context("创建 PortableGit 安装目录失败")?;

            // 优先走 P1 extractor；如果 .7z.exe 自解压包处理失败，再走 SFX 兜底
            if let Err(err) = crate::installer::extractor::extract(&dl_file, &install_dir).await {
                let _ = crate::log_router::send_log_event(&progress_tx, format!(
                    "标准 7z 解压失败，尝试调用自解压程序：{}",
                    err
                )).await;

                let _ = tokio::fs::remove_dir_all(&install_dir).await;
                tokio::fs::create_dir_all(&install_dir).await?;
                extract_self_extracting_7z(&dl_file, &install_dir)
                    .context("PortableGit 自解压失败")?;
            }

            // 保留 dl_file，不删除，下次安装可以直接使用
            // let _ = tokio::fs::remove_file(&dl_file).await;

            let git = Self {
                install_dir: install_dir.clone(),
                git_exe: Self::git_exe_path(runtimes_dir),
            };

            let verified = git.verify()?;
            let _ = crate::log_router::send_log_event(&progress_tx, format!(
                "PortableGit 安装完成：{}",
                verified
            )).await;

            Ok(git)
        }
        .await;

        match result {
            Ok(git) => {
                let _ = progress_tx
                    .send(ProgressEvent::StepCompleted { step_index })
                    .await;
                Ok(git)
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
        if !self.git_exe.exists() {
            anyhow::bail!("未找到 git.exe: {}", self.git_exe.display());
        }

        let output = Command::new(&self.git_exe)
            .arg("--version")
            .output()
            .with_context(|| format!("无法运行 git: {}", self.git_exe.display()))?;

        if !output.status.success() {
            anyhow::bail!(
                "git 验证失败: {}",
                read_output_text(&output.stdout, &output.stderr)
            );
        }

        let version = read_output_text(&output.stdout, &output.stderr);
        if version.contains("git version") {
            Ok(version)
        } else {
            anyhow::bail!("git 验证失败，输出异常: {}", version);
        }
    }
}

fn extract_self_extracting_7z(archive_path: &Path, dest_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dest_dir)
        .with_context(|| format!("创建解压目录失败: {}", dest_dir.display()))?;

    let output = Command::new(archive_path)
        .arg(format!("-o{}", dest_dir.display()))
        .arg("-y")
        .output()
        .with_context(|| format!("无法执行自解压程序: {}", archive_path.display()))?;

    if !output.status.success() {
        anyhow::bail!(
            "PortableGit 自解压失败: {}",
            read_output_text(&output.stdout, &output.stderr)
        );
    }

    Ok(())
}

fn read_output_text(stdout: &[u8], stderr: &[u8]) -> String {
    let out = String::from_utf8_lossy(stdout).trim().to_string();
    if !out.is_empty() {
        out
    } else {
        String::from_utf8_lossy(stderr).trim().to_string()
    }
}
