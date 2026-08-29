use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use anyhow::{Context, Result};
use tokio::sync::mpsc;

use crate::app::{GithubMirror, ProgressEvent};
use crate::cache::CacheManager;
use crate::mirrors::MirrorConfig;

const PYPI_MIRROR: &str = "https://mirrors.aliyun.com/pypi/simple";

#[derive(Debug, Clone)]
pub struct PortablePython {
    pub install_dir: PathBuf,
    pub python_exe: PathBuf,
    pub pip_exe: PathBuf,
}

impl PortablePython {
    pub fn is_installed(runtimes_dir: &Path) -> bool {
        let python_exe = Self::python_exe_path(runtimes_dir);
        if !python_exe.exists() {
            return false;
        }
        // 验证 pip 是否可用：用 python -m pip --version
        let output = Command::new(&python_exe)
            .arg("-m")
            .arg("pip")
            .arg("--version")
            .output();
        match output {
            Ok(o) => o.status.success(),
            Err(_) => false,
        }
    }

    pub fn python_exe_path(runtimes_dir: &Path) -> PathBuf {
        runtimes_dir.join("python").join("python.exe")
    }

    pub fn pip_exe_path(runtimes_dir: &Path) -> PathBuf {
        runtimes_dir.join("python").join("Scripts").join("pip.exe")
    }

    pub async fn install(
        runtimes_dir: &Path,
        cache: &CacheManager,
        mirror: &GithubMirror,
        mirror_config: &MirrorConfig,
        step_index: usize,
        progress_tx: mpsc::Sender<ProgressEvent>,
    ) -> Result<Self> {
        let install_dir = runtimes_dir.join("python");
        let temp_extract = runtimes_dir.join("python_temp");
        let dl_runtimes_dir = cache.dl_runtimes_dir();

        let result: Result<Self> = async {
            tokio::fs::create_dir_all(runtimes_dir)
                .await
                .context("创建 runtimes 目录失败")?;
            tokio::fs::create_dir_all(dl_runtimes_dir)
                .await
                .context("创建 DL_runtimes 目录失败")?;

            let _ = progress_tx
                .send(ProgressEvent::StepStarted { step_index })
                .await;

            let _ = crate::log_router::send_log_event(&progress_tx, "正在查询 python-build-standalone 最新版本...".to_string()).await;

            let (download_url, version) = crate::installer::downloader::get_latest_python_standalone_url()
                .await
                .context("获取 Python portable 下载地址失败")?;

            let _ = crate::log_router::send_log_event(&progress_tx, format!(
                    "Python portable 版本: {}",
                    version
                )).await;

            // 从 URL 提取文件名作为缓存名
            let file_name = download_url.split('/').last().unwrap_or("python.tar.gz");
            let dl_file = dl_runtimes_dir.join(file_name);

            // 2026-08-23: INI 版本校验（统一缓存校验机制）
            let ini_version = mirror_config.get_runtime_version("Python");
            let cache_exists = dl_file.exists();

            let needs_download;
            match ini_version {
                Some(v) if v == &version => {
                    if cache_exists {
                        let _ = crate::log_router::send_log_event(&progress_tx, format!(
                            "Python 缓存校验通过（版本 {}），使用缓存",
                            version
                        )).await;
                        needs_download = false;
                    } else {
                        let _ = crate::log_router::send_log_event(&progress_tx,
                            "Python 缓存文件丢失，重新下载".to_string()).await;
                        needs_download = true;
                    }
                }
                Some(v) => {
                    let _ = crate::log_router::send_log_event(&progress_tx, format!(
                        "Python 缓存过期（INI: {} → 最新: {}），重新下载",
                        v, version
                    )).await;
                    needs_download = true;
                }
                None => {
                    if cache_exists {
                        let _ = crate::log_router::send_log_event(&progress_tx,
                            "Python 缓存存在但无版本记录，重新下载".to_string()).await;
                    }
                    needs_download = true;
                }
            }

            if needs_download {
                // 清理过期的旧版本缓存文件
                let _ = clean_old_python_cache(dl_runtimes_dir);

                let _ = crate::log_router::send_log_event(&progress_tx,
                    "正在下载 PortablePython（多镜像降级 + 断点续传）...".to_string()).await;

                crate::installer::downloader::download_with_preferred_fallback(
                    crate::installer::downloader::DownloadConfig {
                        url: download_url.clone(),
                        dest: dl_file.clone(),
                        step_index,
                        resume: true,
                    },
                    mirror,
                    mirror_config,
                    progress_tx.clone(),
                    2,  // 每镜像重试 2 次
                )
                .await
                .context("下载 PortablePython 失败（所有镜像站均已尝试）")?;

                // 下载成功后，更新 INI 记录版本
                let mut mc = mirror_config.clone();
                if mc.set_and_save_runtime_version("Python", &version).is_ok() {
                    let _ = crate::log_router::send_log_event(&progress_tx, format!(
                        "Python 版本已记录到 INI: {}",
                        version
                    )).await;
                }
            }

            let _ = crate::log_router::send_log_event(&progress_tx, "正在解压 Python...".to_string()).await;

            if temp_extract.exists() {
                let _ = tokio::fs::remove_dir_all(&temp_extract).await;
            }
            tokio::fs::create_dir_all(&temp_extract).await?;

            crate::installer::extractor::extract(&dl_file, &temp_extract)
                .await
                .context("解压 Python tar.gz 失败")?;

            let extracted_root =
                find_python_root(&temp_extract).context("定位 Python 根目录失败")?;

            if install_dir.exists() {
                let _ = tokio::fs::remove_dir_all(&install_dir).await;
            }

            if extracted_root == temp_extract {
                tokio::fs::rename(&temp_extract, &install_dir)
                    .await
                    .context("移动 Python 安装目录失败")?;
            } else {
                tokio::fs::rename(&extracted_root, &install_dir)
                    .await
                    .context("提升 Python 目录层级失败")?;
                let _ = tokio::fs::remove_dir_all(&temp_extract).await;
            }

            // 保留 dl_file，不删除，下次安装可以直接使用

            // 从 version 字符串提取大版本号（如 "3.12.8+20250106" → "3.12"）
            let major_minor = version
                .split('+')
                .next()
                .unwrap_or(&version)
                .split('.')
                .take(2)
                .collect::<Vec<_>>()
                .join("");
            configure_pth_file(&install_dir, &major_minor)
                .context("配置 Python ._pth 文件失败")?;

            let _ = crate::log_router::send_log_event(&progress_tx, "正在安装 pip...".to_string()).await;

            install_pip(&install_dir, &progress_tx).await.context("安装 pip 失败")?;

            let python = Self {
                install_dir: install_dir.clone(),
                python_exe: Self::python_exe_path(runtimes_dir),
                pip_exe: Self::pip_exe_path(runtimes_dir),
            };

            let verified = python.verify()?;
            let _ = crate::log_router::send_log_event(&progress_tx, format!(
                    "Python 安装完成：{}",
                    verified
                )).await;

            Ok(python)
        }
        .await;

        match result {
            Ok(python) => {
                let _ = progress_tx
                    .send(ProgressEvent::StepCompleted { step_index })
                    .await;
                Ok(python)
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

    /// 使用 portable python 执行 pip install
    pub fn pip_install(&self, requirements_file: &Path, use_mirror: bool) -> Result<()> {
        if !requirements_file.exists() {
            anyhow::bail!(
                "requirements 文件不存在: {}",
                requirements_file.display()
            );
        }

        let mut cmd = Command::new(&self.python_exe);
        cmd.arg("-m")
            .arg("pip")
            .arg("install")
            .arg("--disable-pip-version-check")
            .arg("-r")
            .arg(requirements_file)
            .current_dir(&self.install_dir);

        if use_mirror {
            cmd.arg("-i").arg(PYPI_MIRROR);
        }

        let output = cmd
            .output()
            .with_context(|| format!("执行 pip install 失败: {}", requirements_file.display()))?;

        if !output.status.success() {
            anyhow::bail!(
                "pip install 失败: {}",
                read_output_text(&output.stdout, &output.stderr)
            );
        }

        Ok(())
    }

    pub fn verify(&self) -> Result<String> {
        if !self.python_exe.exists() {
            anyhow::bail!("未找到 python.exe: {}", self.python_exe.display());
        }

        let output = Command::new(&self.python_exe)
            .arg("--version")
            .output()
            .with_context(|| format!("无法运行 python: {}", self.python_exe.display()))?;

        if !output.status.success() {
            anyhow::bail!(
                "Python 验证失败: {}",
                read_output_text(&output.stdout, &output.stderr)
            );
        }

        let version = read_output_text(&output.stdout, &output.stderr);
        if !version.starts_with("Python 3.") {
            anyhow::bail!("Python 验证失败，输出异常: {}", version);
        }

        // 用 python -m pip --version 验证 pip（不依赖 Scripts/pip.exe）
        let pip_check = Command::new(&self.python_exe)
            .arg("-m")
            .arg("pip")
            .arg("--version")
            .output()
            .context("执行 python -m pip --version 失败")?;

        if !pip_check.status.success() {
            anyhow::bail!(
                "pip 验证失败: {}",
                read_output_text(&pip_check.stdout, &pip_check.stderr)
            );
        }

        Ok(version)
    }
}

fn configure_pth_file(python_dir: &Path, major_minor: &str) -> Result<()> {
    let expected = python_dir.join(format!("python{}._pth", major_minor));

    let pth_path = if expected.exists() {
        expected
    } else {
        let mut found = None;
        for entry in std::fs::read_dir(python_dir)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if name.starts_with("python") && name.ends_with("._pth") {
                    found = Some(entry.path());
                    break;
                }
            }
        }

        match found {
            Some(path) => path,
            None => {
                return Ok(());
            }
        }
    };

    let mut content = std::fs::read_to_string(&pth_path)
        .with_context(|| format!("读取 ._pth 文件失败: {}", pth_path.display()))?;

    if content.contains("#import site") {
        content = content.replace("#import site", "import site");
    } else if !content.lines().any(|line| line.trim() == "import site") {
        if !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str("import site\n");
    }

    std::fs::write(&pth_path, content)
        .with_context(|| format!("写入 ._pth 文件失败: {}", pth_path.display()))?;

    Ok(())
}

async fn install_pip(python_dir: &Path, progress_tx: &mpsc::Sender<ProgressEvent>) -> Result<()> {
    let python_exe = python_dir.join("python.exe");

    let _ = crate::log_router::send_log_event(&progress_tx, format!("[DEBUG] Python 目录: {}", python_dir.display())).await;
    let _ = crate::log_router::send_log_event(&progress_tx, format!("[DEBUG] python.exe: {}", python_exe.display())).await;

    // 先验证 python.exe 能正常运行
    {
        let verify = Command::new(&python_exe)
            .arg("--version")
            .output();
        match verify {
            Ok(out) if out.status.success() => {
                let ver = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let _ = crate::log_router::send_log_event(&progress_tx, format!("[DEBUG] Python 版本验证: {}", ver)).await;
            }
            Ok(out) => {
                let err = read_output_text(&out.stdout, &out.stderr);
                let _ = crate::log_router::send_log_event(&progress_tx, format!("[WARN] Python 版本验证失败: {}", err)).await;
            }
            Err(e) => {
                let _ = crate::log_router::send_log_event(&progress_tx, format!("[WARN] 无法运行 python --version: {}", e)).await;
            }
        }
    }

    // 方案 1: 使用 ensurepip（Python 3.4+ 内置，零网络依赖）
    let _ = crate::log_router::send_log_event(&progress_tx, "正在安装 pip (ensurepip)...".to_string()).await;

    let mut cmd = Command::new(&python_exe);
    cmd.arg("-m")
        .arg("ensurepip")
        .arg("--upgrade")
        .arg("--default-pip");

    let output = cmd
        .output()
        .with_context(|| format!("运行 ensurepip 失败: {}", python_exe.display()))?;

    let stdout_text = String::from_utf8_lossy(&output.stdout);
    let stderr_text = String::from_utf8_lossy(&output.stderr);

    if output.status.success() {
        let _ = crate::log_router::send_log_event(&progress_tx, "[DEBUG] ensurepip 安装 pip 成功".to_string()).await;
        return Ok(());
    } else {
        let full_output = format!(
            "exit_code={}\n=== STDOUT ({}) ===\n{}\n=== STDERR ({}) ===\n{}",
            output.status.code().unwrap_or(-1),
            stdout_text.len(),
            stdout_text.lines().take(50).collect::<Vec<_>>().join("\n"),
            stderr_text.len(),
            stderr_text.lines().take(50).collect::<Vec<_>>().join("\n")
        );
        let _ = crate::log_router::send_log_event(&progress_tx, format!("[WARN] ensurepip 失败，回退到 get-pip.py:\n{}", full_output)).await;
    }

    // 方案 2: fallback 到 get-pip.py（确保 pip.ini 不干扰）
    let get_pip_path = python_dir.join("get-pip.py");

    // 临时处理系统 pip.ini：get-pip.py 内部使用 pip 模块，会读取系统 pip.ini
    let pip_ini_path = std::env::var("HOME")
        .ok()
        .and_then(|h| {
            let p = PathBuf::from(h).join("pip").join("pip.ini");
            if p.exists() { Some(p) } else { None }
        })
        .or_else(|| std::env::var("USERPROFILE").ok().and_then(|h| {
            let p = PathBuf::from(h).join("pip").join("pip.ini");
            if p.exists() { Some(p) } else { None }
        }))
        .or_else(|| std::env::var("APPDATA").ok().and_then(|h| {
            let p = PathBuf::from(h).join("pip").join("pip.ini");
            if p.exists() { Some(p) } else { None }
        }));

    let (pip_ini_backup, backed_up) = if let Some(ref p) = pip_ini_path {
        if p.exists() {
            let backup_path = p.with_extension("ini.bak_getpip");
            if std::fs::rename(p, &backup_path).is_ok() {
                let _ = crate::log_router::send_log_event(&progress_tx, format!("[DEBUG] 已临时备份 pip.ini: {}", p.display())).await;
                (Some(backup_path), true)
            } else {
                (None, false)
            }
        } else {
            (None, false)
        }
    } else {
        (None, false)
    };

    // 下载 get-pip.py（仅使用正确且可达的源）
    download_get_pip(&get_pip_path, progress_tx).await?;

    let _ = crate::log_router::send_log_event(&progress_tx, format!("[DEBUG] 正在执行: {} {}", python_exe.display(), get_pip_path.display())).await;

    let mut cmd = Command::new(&python_exe);
    cmd.arg(&get_pip_path)
        .arg("--disable-pip-version-check")
        .env_remove("PIP_INDEX_URL")
        .env_remove("PIP_EXTRA_INDEX_URL")
        .env_remove("PIP_TRUSTED_HOST");

    let output = cmd
        .output()
        .with_context(|| format!("运行 get-pip.py 失败: {}", python_exe.display()))?;

    // 恢复 pip.ini
    if backed_up {
        if let Some(ref backup_path) = pip_ini_backup {
            let backup_name = backup_path.file_name().unwrap().to_string_lossy().to_string();
            let orig_name = backup_name.strip_suffix(".bak_getpip").unwrap_or("");
            let orig_path = backup_path.with_file_name(orig_name);
            if std::fs::rename(backup_path, &orig_path).is_err() {
                let _ = crate::log_router::send_log_event(&progress_tx, format!("[WARN] 恢复 pip.ini 失败，备份在: {}", backup_path.display())).await;
            } else {
                let _ = crate::log_router::send_log_event(&progress_tx, format!("[DEBUG] 已恢复 pip.ini: {}", orig_path.display())).await;
            }
        }
    }

    // 删除 get-pip.py
    let _ = tokio::fs::remove_file(&get_pip_path).await;

    if output.status.success() {
        let _ = crate::log_router::send_log_event(&progress_tx, "[DEBUG] get-pip.py 安装 pip 成功".to_string()).await;
        Ok(())
    } else {
        let full_output = format!(
            "exit_code={}\n=== STDOUT ({}) ===\n{}\n=== STDERR ({}) ===\n{}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stdout).lines().take(100).collect::<Vec<_>>().join("\n"),
            output.stdout.len(),
            String::from_utf8_lossy(&output.stderr).lines().take(100).collect::<Vec<_>>().join("\n"),
            output.stderr.len()
        );
        let _ = crate::log_router::send_log_event(&progress_tx, format!("[ERROR] get-pip.py 详细输出:\n{}", full_output)).await;
        anyhow::bail!("安装 pip 失败 (exit_code={})", output.status.code().unwrap_or(-1));
    }
}

async fn download_get_pip(dest: &Path, progress_tx: &mpsc::Sender<ProgressEvent>) -> Result<()> {
    // 只保留正确的源：bootstrap.pypa.io（官方）和 raw.githubusercontent.com（通过镜像可达）
    let urls: &[(&str, u64, usize)] = &[
        // (url, timeout_secs, retries)
        // GitHub raw（可以通过 GitHub 镜像站加速）
        ("https://raw.githubusercontent.com/pypa/get-pip/main/public/get-pip.py", 120, 5),
        // bootstrap.pypa.io（官方，国内可能超时）
        ("https://bootstrap.pypa.io/get-pip.py", 120, 5),
    ];

    let mut last_error: Option<anyhow::Error> = None;

    for (url, timeout_secs, max_retries) in urls {
        let _ = crate::log_router::send_log_event(&progress_tx, format!(
                "[DEBUG] 尝试从 {} 下载 get-pip.py (超时 {}s, 重试 {} 次)",
                url, timeout_secs, max_retries
            )).await;

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(*timeout_secs))
            .build()
            .context("创建 reqwest client 失败")?;

        for attempt in 0..=*max_retries {
            if attempt > 0 {
                let delay = 2u64 * attempt as u64;
                let _ = crate::log_router::send_log_event(&progress_tx, format!(
                        "[DEBUG] 重试 ({}/{}): {} (等待 {}s)",
                        attempt, max_retries, url, delay
                    )).await;
                tokio::time::sleep(Duration::from_secs(delay)).await;
            }

            let result: Result<()> = async {
                let resp = client
                    .get(*url)
                    .send()
                    .await
                    .context("请求 get-pip.py 失败")?
                    .error_for_status()
                    .context("get-pip.py 返回非成功状态码")?;

                let bytes = resp.bytes().await.context("读取 get-pip.py 内容失败")?;
                if bytes.is_empty() {
                    anyhow::bail!("get-pip.py 内容为空");
                }
                tokio::fs::write(dest, &bytes)
                    .await
                    .with_context(|| format!("写入 get-pip.py 失败: {}", dest.display()))?;

                Ok(())
            }
            .await;

            match result {
                Ok(()) => {
                    let _ = crate::log_router::send_log_event(&progress_tx, format!("[DEBUG] get-pip.py 下载成功: {}", url)).await;
                    return Ok(());
                }
                Err(err) => {
                    let _ = crate::log_router::send_log_event(&progress_tx, format!(
                            "[WARN] 下载 get-pip.py 失败 {}: {}",
                            url, err
                        )).await;
                    last_error = Some(err);
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("下载 get-pip.py 失败，所有源均不可达")))
}

fn find_python_root(dir: &Path) -> Result<PathBuf> {
    if dir.join("python.exe").exists() {
        return Ok(dir.to_path_buf());
    }

    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            let sub = entry.path();

            if sub.join("python.exe").exists() {
                return Ok(sub);
            }

            for inner in std::fs::read_dir(&sub)? {
                let inner = inner?;
                if inner.file_type()?.is_dir() {
                    let inner_path = inner.path();
                    if inner_path.join("python.exe").exists() {
                        return Ok(inner_path);
                    }
                }
            }
        }
    }

    anyhow::bail!("未在解压目录中找到 python.exe");
}

fn read_output_text(stdout: &[u8], stderr: &[u8]) -> String {
    let out = String::from_utf8_lossy(stdout).trim().to_string();
    if !out.is_empty() {
        out
    } else {
        String::from_utf8_lossy(stderr).trim().to_string()
    }
}

/// 清理 DL_runtimes 中的过期 Python 缓存文件（保留最新的 install_only.tar.gz）
fn clean_old_python_cache(dl_runtimes_dir: &Path) {
    let entries = std::fs::read_dir(dl_runtimes_dir).ok();
    if let Some(entries) = entries {
        let mut python_caches: Vec<PathBuf> = Vec::new();
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("cpython-")
                    && name.contains("x86_64-pc-windows-msvc-install_only.tar.gz")
                {
                    python_caches.push(entry.path());
                }
            }
        }
        // 只保留最新的（按文件名自然排序最后一个）
        if python_caches.len() > 1 {
            python_caches.sort();
            for old_path in python_caches.iter().take(python_caches.len() - 1) {
                let _ = std::fs::remove_file(old_path);
            }
        }
    }
}
