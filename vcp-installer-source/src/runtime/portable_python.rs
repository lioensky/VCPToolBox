use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use anyhow::{Context, Result};
use tokio::sync::mpsc;

use crate::app::{GithubMirror, ProgressEvent};

const PYTHON_VERSION: &str = "3.12.8";
const PYTHON_BUILD_TAG: &str = "20250106";
const PYPI_MIRROR: &str = "https://pypi.tuna.tsinghua.edu.cn/simple";

#[derive(Debug, Clone)]
pub struct PortablePython {
    pub install_dir: PathBuf,
    pub python_exe: PathBuf,
    pub pip_exe: PathBuf,
}

impl PortablePython {
    pub fn is_installed(runtimes_dir: &Path) -> bool {
        Self::python_exe_path(runtimes_dir).exists() && Self::pip_exe_path(runtimes_dir).exists()
    }

    pub fn python_exe_path(runtimes_dir: &Path) -> PathBuf {
        runtimes_dir.join("python").join("python.exe")
    }

    pub fn pip_exe_path(runtimes_dir: &Path) -> PathBuf {
        runtimes_dir.join("python").join("Scripts").join("pip.exe")
    }

    pub async fn install(
        runtimes_dir: &Path,
        mirror: &GithubMirror,
        step_index: usize,
        progress_tx: mpsc::Sender<ProgressEvent>,
    ) -> Result<Self> {
        let install_dir = runtimes_dir.join("python");
        let temp_file = runtimes_dir.join("python.tar.gz");
        let temp_extract = runtimes_dir.join("python_temp");

        let result: Result<Self> = async {
            tokio::fs::create_dir_all(runtimes_dir)
                .await
                .context("创建 runtimes 目录失败")?;

            let _ = progress_tx
                .send(ProgressEvent::StepStarted { step_index })
                .await;

            let _ = progress_tx
                .send(ProgressEvent::Log(format!(
                    "Python 目标版本: {} ({})",
                    PYTHON_VERSION, PYTHON_BUILD_TAG
                )))
                .await;

            let download_url = format!(
                "https://github.com/indygreg/python-build-standalone/releases/download/{}/cpython-{}+{}-x86_64-pc-windows-msvc-install_only.tar.gz",
                PYTHON_BUILD_TAG,
                PYTHON_VERSION,
                PYTHON_BUILD_TAG
            );

            let mirror_prefix = mirror.prefix();
            let url = crate::installer::downloader::apply_mirror(&download_url, &mirror_prefix);

            let _ = progress_tx
                .send(ProgressEvent::Log("正在下载 PortablePython...".to_string()))
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
            .context("下载 PortablePython 失败")?;

            let _ = progress_tx
                .send(ProgressEvent::Log("正在解压 Python...".to_string()))
                .await;

            if temp_extract.exists() {
                let _ = tokio::fs::remove_dir_all(&temp_extract).await;
            }
            tokio::fs::create_dir_all(&temp_extract).await?;

            crate::installer::extractor::extract(&temp_file, &temp_extract)
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

            let _ = tokio::fs::remove_file(&temp_file).await;

            configure_pth_file(&install_dir, PYTHON_VERSION)
                .context("配置 Python ._pth 文件失败")?;

            let _ = progress_tx
                .send(ProgressEvent::Log("正在安装 pip...".to_string()))
                .await;

            install_pip(&install_dir).await.context("安装 pip 失败")?;

            let python = Self {
                install_dir: install_dir.clone(),
                python_exe: Self::python_exe_path(runtimes_dir),
                pip_exe: Self::pip_exe_path(runtimes_dir),
            };

            let verified = python.verify()?;
            let _ = progress_tx
                .send(ProgressEvent::Log(format!(
                    "Python 安装完成：{}",
                    verified
                )))
                .await;

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

        if !self.pip_exe.exists() {
            anyhow::bail!("未找到 pip.exe: {}", self.pip_exe.display());
        }

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

fn configure_pth_file(python_dir: &Path, version: &str) -> Result<()> {
    let major_minor = version.split('.').take(2).collect::<Vec<_>>().join("");
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

async fn install_pip(python_dir: &Path) -> Result<()> {
    let python_exe = python_dir.join("python.exe");
    let get_pip_path = python_dir.join("get-pip.py");

    download_get_pip(&get_pip_path).await?;

    let output = Command::new(&python_exe)
        .arg(&get_pip_path)
        .arg("--disable-pip-version-check")
        .output()
        .with_context(|| format!("运行 get-pip.py 失败: {}", python_exe.display()))?;

    let _ = tokio::fs::remove_file(&get_pip_path).await;

    if !output.status.success() {
        anyhow::bail!(
            "安装 pip 失败: {}",
            read_output_text(&output.stdout, &output.stderr)
        );
    }

    Ok(())
}

async fn download_get_pip(dest: &Path) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .context("创建 reqwest client 失败")?;

    let url = "https://bootstrap.pypa.io/get-pip.py";
    let mut last_error: Option<anyhow::Error> = None;

    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(2 * attempt as u64)).await;
        }

        let result: Result<()> = async {
            let resp = client
                .get(url)
                .send()
                .await
                .context("请求 get-pip.py 失败")?
                .error_for_status()
                .context("get-pip.py 返回非成功状态码")?;

            let bytes = resp.bytes().await.context("读取 get-pip.py 内容失败")?;
            tokio::fs::write(dest, &bytes)
                .await
                .with_context(|| format!("写入 get-pip.py 失败: {}", dest.display()))?;

            Ok(())
        }
        .await;

        match result {
            Ok(()) => return Ok(()),
            Err(err) => last_error = Some(err),
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("下载 get-pip.py 失败")))
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