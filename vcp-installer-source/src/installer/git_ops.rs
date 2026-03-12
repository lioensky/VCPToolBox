use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{bail, Context, Result};

/// 使用指定的 git 可执行文件克隆仓库（实时输出日志）。
/// 如果目标目录已存在且是 git 仓库，则自动执行 git pull。
pub fn git_clone(
    git_exe: &Path,
    repo_url: &str,
    dest: &Path,
    env_path: &str,
    log_fn: &dyn Fn(&str),
) -> Result<()> {
    if !git_exe.exists() {
        bail!("未找到 git 可执行文件: {}", git_exe.display());
    }

    if dest.exists() {
        if is_git_repo(dest) {
            return git_pull(git_exe, dest, env_path, log_fn);
        }

        bail!("目标目录已存在且不是 git 仓库: {}", dest.display());
    }

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("创建仓库父目录失败: {}", parent.display()))?;
    }

    log_fn(&format!("[git] clone {} -> {}", repo_url, dest.display()));

    let mut child = Command::new(git_exe)
        .args(["clone", "--depth", "1", "--progress", repo_url])
        .arg(dest)
        .env("PATH", env_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("启动 git clone 失败: {}", dest.display()))?;

    // git clone 进度输出在 stderr
    stream_output(&mut child, log_fn);

    let status = child.wait().with_context(|| "等待 git clone 完成失败")?;
    if !status.success() {
        bail!("git clone 失败 (exit code: {:?})", status.code());
    }

    log_fn("[git] clone 完成");
    Ok(())
}

/// 检查目录是否是 git 仓库。
pub fn is_git_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

/// 如果目录已存在且是 git 仓库，执行 git pull 更新。
pub fn git_pull(
    git_exe: &Path,
    repo_dir: &Path,
    env_path: &str,
    log_fn: &dyn Fn(&str),
) -> Result<()> {
    if !git_exe.exists() {
        bail!("未找到 git 可执行文件: {}", git_exe.display());
    }

    if !repo_dir.exists() || !is_git_repo(repo_dir) {
        bail!("目标目录不是 git 仓库: {}", repo_dir.display());
    }

    log_fn(&format!("[git] pull {}", repo_dir.display()));

    let mut child = Command::new(git_exe)
        .args(["pull", "--ff-only"])
        .current_dir(repo_dir)
        .env("PATH", env_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("启动 git pull 失败: {}", repo_dir.display()))?;

    stream_output(&mut child, log_fn);

    let status = child.wait().with_context(|| "等待 git pull 完成失败")?;
    if !status.success() {
        bail!("git pull 失败 (exit code: {:?})", status.code());
    }

    log_fn("[git] pull 完成");
    Ok(())
}

/// 实时读取子进程的 stdout 和 stderr，逐行推送到 log_fn。
fn stream_output(child: &mut std::process::Child, log_fn: &dyn Fn(&str)) {
    // 读 stderr（git 把进度输出到 stderr）
    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(line) = line {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    log_fn(&format!("[git] {}", trimmed));
                }
            }
        }
    }

    // 读 stdout
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(line) = line {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    log_fn(&format!("[git] {}", trimmed));
                }
            }
        }
    }
}