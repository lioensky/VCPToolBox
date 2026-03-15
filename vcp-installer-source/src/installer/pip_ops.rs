use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{bail, Context, Result};

/// 使用指定的 Python 执行 pip install -r requirements.txt（实时输出日志）。
pub fn pip_install_requirements(
    python_exe: &Path,
    project_dir: &Path,
    env_path: &str,
    use_mirror: bool,
    log_fn: &dyn Fn(&str),
) -> Result<()> {
    if !python_exe.exists() {
        bail!("未找到 python 可执行文件: {}", python_exe.display());
    }

    let requirements = project_dir.join("requirements.txt");

    // 没有 requirements.txt 时直接跳过
    if !requirements.exists() {
        log_fn("[pip] 未找到 requirements.txt，跳过");
        return Ok(());
    }

    log_fn(&format!("[pip] install -r requirements.txt ({})", project_dir.display()));

    let mut cmd = Command::new(python_exe);
    cmd.args(["-m", "pip", "install", "--disable-pip-version-check", "-r"])
        .arg(&requirements)
        .current_dir(project_dir)
        .env("PATH", env_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if use_mirror {
        cmd.args(["-i", "https://pypi.tuna.tsinghua.edu.cn/simple"]);
    }

    let mut child = cmd
        .spawn()
        .with_context(|| format!("启动 pip install 失败: {}", project_dir.display()))?;

    // pip 进度在 stdout，警告在 stderr
    stream_pip_output(&mut child, log_fn);

    let status = child.wait().with_context(|| "等待 pip install 完成失败")?;
    if !status.success() {
        bail!("pip install 失败 (exit code: {:?})", status.code());
    }

    log_fn("[pip] install 完成");
    Ok(())
}

fn stream_pip_output(child: &mut std::process::Child, log_fn: &dyn Fn(&str)) {
    // 读 stdout（pip 主要输出）
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(line) = line {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    log_fn(&format!("[pip] {}", trimmed));
                }
            }
        }
    }

    // 读 stderr（pip 警告/错误）
    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(line) = line {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    log_fn(&format!("[pip] {}", trimmed));
                }
            }
        }
    }
}