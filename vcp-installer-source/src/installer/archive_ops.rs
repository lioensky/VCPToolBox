use std::path::Path;
use anyhow::{anyhow, bail, Context, Result};

use super::downloader;
use super::extractor;
use crate::app::Component;
use crate::cache::CacheManager;
use crate::mirrors::config::get_config_path;

/// 从 git 仓库 URL 获取远程 HEAD commit hash
///
/// 2026-08-23 新增：tarball 缓存 commit 校验机制
/// - 下载 tarball 时调用此函数获取当前远程 HEAD
/// - 保存到 ini 文件的 [component_commits] section
/// - 使用缓存前对比 commit，不匹配则重新下载
///
/// # 参数
/// - `repo_url`: git 仓库完整 URL（如 `https://github.com/lioensky/VCPChat.git`）
/// - `env_path`: 环境变量 PATH（用于找到 git 可执行文件）
///
/// # 返回
/// - `Ok(commit_hash)`: 远程 HEAD commit hash（40 位 hex）
/// - `Err(_)`: 获取失败（网络问题、URL 格式错误等）
pub fn get_remote_head_commit(repo_url: &str, env_path: &str) -> Result<String> {
    let output = std::process::Command::new("git")
        .args(["ls-remote", repo_url, "HEAD"])
        .env("PATH", env_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .context("执行 git ls-remote 失败")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("git ls-remote 失败: {}", stderr.trim());
    }

    // 输出格式: <commit_hash>\tHEAD
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().next().context("git ls-remote 输出为空")?;
    let commit_hash = line
        .split_whitespace()
        .next()
        .context("无法解析 commit hash")?;

    // 验证是有效的 40 位 hex hash
    if commit_hash.len() != 40 || !commit_hash.chars().all(|c| c.is_ascii_hexdigit()) {
        bail!("无效的 commit hash: {}", commit_hash);
    }

    Ok(commit_hash.to_string())
}

/// 检查 tarball 缓存是否与远程 commit 匹配（ini-based）
///
/// 2026-08-23 新增：tarball 缓存 commit 校验机制
/// 使用 ini 文件存储 commit 信息，而非伴生文件
///
/// # 逻辑
/// 1. 从 ini 读取该组件的 commit hash
///    - 不存在 → 返回 `Ok(false)`（触发重新下载）
/// 2. 获取当前远程 HEAD commit
///    - 失败 → 返回 `Ok(true)`（网络问题不阻断安装，使用缓存）
/// 3. 对比 commit
///    - 匹配 → `Ok(true)`
///    - 不匹配 → `Ok(false)`（需要重新下载）
///
/// # 参数
/// - `short_name`: 组件短名（如 "VCPToolBox"）
/// - `repo_url`: git 仓库 URL
/// - `env_path`: 环境变量 PATH
/// - `log_fn`: 日志回调
///
/// # 返回
/// - `Ok(true)`: 缓存有效（commit 匹配或无法验证）
/// - `Ok(false)`: 缓存过期或无记录（需要重新下载）
pub fn is_tarball_cache_valid_inini(
    short_name: &str,
    repo_url: &str,
    env_path: &str,
    log_fn: &dyn Fn(&str),
) -> Result<bool> {
    // 1. 从 ini 读取 commit
    let config_path = get_config_path();
    let mut config = match crate::mirrors::config::load_mirror_config(&config_path) {
        Ok(c) => c,
        Err(e) => {
            log_fn(&format!(
                "[tarball]   - 读取 ini 失败: {}，假设缓存有效",
                e
            ));
            return Ok(true);
        }
    };

    let ini_commit = match config.get_component_commit(short_name) {
        Some(commit) => {
            log_fn(&format!(
                "[tarball]   - ini 中的 commit: {}",
                &commit[..8.min(commit.len())]
            ));
            commit.clone()
        }
        None => {
            log_fn(&format!(
                "[tarball]   - ini 中无 {} 的 commit 记录",
                short_name
            ));
            return Ok(false);
        }
    };

    // 2. 获取当前远程 HEAD commit
    log_fn("[tarball]   - 获取远程 commit...");
    let remote_commit = match get_remote_head_commit(repo_url, env_path) {
        Ok(commit) => {
            log_fn(&format!(
                "[tarball]   - 远程 commit: {}",
                &commit[..8.min(commit.len())]
            ));
            commit
        }
        Err(e) => {
            log_fn(&format!(
                "[tarball]   - 无法获取远程 commit（{}），使用缓存",
                e
            ));
            return Ok(true);
        }
    };

    // 3. 对比 commit
    if ini_commit == remote_commit {
        Ok(true)
    } else {
        Ok(false)
    }
}

/// 保存 commit hash 到 ini 文件
///
/// 2026-08-23 新增：tarball 缓存 commit 校验机制
pub fn save_commit_to_ini(
    short_name: &str,
    commit_hash: &str,
    log_fn: &dyn Fn(&str),
) -> Result<()> {
    let config_path = get_config_path();
    let mut config = match crate::mirrors::config::load_mirror_config(&config_path) {
        Ok(c) => c,
        Err(e) => {
            log_fn(&format!(
                "[tarball] 警告: 读取 ini 失败（{}），无法保存 commit",
                e
            ));
            return Ok(());
        }
    };

    config
        .set_and_save_component_commit(short_name, commit_hash)
        .map_err(|e| {
            log_fn(&format!(
                "[tarball] 警告: 保存 commit 到 ini 失败（{}）",
                e
            ));
            e
        })?;

    log_fn(&format!(
        "[tarball] 已记录 commit: {} = {}",
        short_name,
        &commit_hash[..8]
    ));
    Ok(())
}

/// 韧性 tarball 安装：按候选站点顺序下载，失败自动换站
fn download_sync(url: &str, dest: &Path, log_fn: &dyn Fn(&str)) -> Result<()> {
    log_fn(&format!(
        "[tarball] 开始下载: {} -> {}",
        url,
        dest.display()
    ));

    let output = std::process::Command::new("curl")
        .args([
            "-L",
            "-f",
            "--retry",
            "3",
            "--retry-delay",
            "2",
            "-o",
            dest.to_str().unwrap_or(""),
            url,
        ])
        .output()
        .context("执行 curl 失败，请确认系统 PATH 中有 curl.exe")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("curl 下载失败: {}", stderr.trim());
    }

    Ok(())
}

/// 韧性 tarball 安装：按候选站点顺序下载，失败自动换站
///
/// # 参数
/// - `component`: 要安装的组件
/// - `candidate_prefixes`: 候选镜像前缀列表（有序，优先级从高到低）
/// - `target_dir`: 目标目录
/// - `cache`: 缓存管理器
/// - `env_path`: 环境变量 PATH（tarball 下载不需要，但保留参数一致性）
/// - `log_fn`: 日志回调
///
/// # 逻辑
/// 1. 先查缓存，有则检查 commit 是否匹配
/// 2. 无缓存或 commit 不匹配时按候选站点下载
/// 3. 下载成功后保存 commit 到 ini
/// 4. 走解压逻辑
pub fn archive_extract_resilient(
    component: &Component,
    candidate_prefixes: &[String],
    target_dir: &Path,
    cache: &CacheManager,
    _env_path: &str,
    log_fn: &dyn Fn(&str),
) -> Result<()> {
    let Some(repo_url) = component.git_repo_url() else {
        bail!(
            "组件 {:?} 没有 git_repo_url，无法使用 tarball 方式",
            component
        );
    };

    let repo_path = repo_url
        .strip_prefix("https://github.com/")
        .ok_or_else(|| anyhow!("无效的 GitHub URL: {}", repo_url))?;
    let repo_path = repo_path.strip_suffix(".git").unwrap_or(repo_path);

    let short_name = component.short_name();
    let tarball_name = format!("{}.tar.gz", short_name);
    let tarball_url = format!(
        "https://github.com/{}/archive/refs/heads/main.tar.gz",
        repo_path
    );

    // 1. 先查缓存 + commit 校验（ini-based）
    let cached_file = cache.path(&tarball_name);
    
    // VCPToolBox 特殊处理：镜像测试阶段已确保最新，无需校验
    let skip_commit_check = short_name == "VCPToolBox";
    
    let cache_valid = if cached_file.exists() {
        if skip_commit_check {
            // VCPToolBox 跳过 commit 校验（镜像测试已保证最新）
            log_fn(&format!(
                "[tarball] VCPToolBox 跳过 commit 校验（镜像测试已更新缓存）"
            ));
            true
        } else {
            // 其他组件：需要 commit 校验
            log_fn(&format!(
                "[tarball] 开始 commit 校验: {}",
                short_name
            ));
            
            let result = is_tarball_cache_valid_inini(short_name, &repo_url, _env_path, log_fn)
                .unwrap_or_else(|e| {
                    log_fn(&format!(
                        "[tarball] commit 校验出错: {}，使用缓存",
                        e
                    ));
                    true
                });
            
            if result {
                log_fn(&format!(
                    "[tarball] ✓ commit 校验通过: {}",
                    short_name
                ));
            } else {
                log_fn(&format!(
                    "[tarball] ✗ commit 校验失败，需要重新下载: {}",
                    short_name
                ));
            }
            
            result
        }
    } else {
        false
    };

    if cache_valid {
        let size = cache.size(&tarball_name);
        log_fn(&format!(
            "[tarball] 使用缓存: {} ({})",
            cached_file.display(),
            crate::utils::format_file_size(size)
        ));
    } else {
        // 2. 无缓存或缓存过期，按候选站点下载
        if cached_file.exists() {
            // 缓存过期，删除旧文件
            log_fn("[tarball] 删除过期缓存，重新下载...");
            let _ = std::fs::remove_file(&cached_file);
        }

        if candidate_prefixes.is_empty() {
            bail!("无可用候选镜像站");
        }

        let mut last_err = String::new();
        let mut success = false;

        for (mi, prefix) in candidate_prefixes.iter().enumerate() {
            let mirrored_url = downloader::apply_mirror(&tarball_url, prefix);
            log_fn(&format!(
                "[tarball] 下载: {} (站点: {})",
                mirrored_url, prefix
            ));

            match download_sync(&mirrored_url, &cached_file, log_fn) {
                Ok(()) => {
                    success = true;
                    break;
                }
                Err(e) => {
                    last_err = e.to_string();
                    log_fn(&format!("[tarball] ! 下载失败: {}", e));
                    // 清理可能的残留文件
                    let _ = std::fs::remove_file(&cached_file);

                    // 非最后一个站点，等待后换站
                    if mi < candidate_prefixes.len() - 1 {
                        log_fn(&format!(
                            "[tarball] ! 站点 {} 失败，切换备用站点: {}",
                            prefix, candidate_prefixes[mi + 1]
                        ));
                    }
                }
            }
        }

        if !success {
            bail!("所有 tarball 镜像站均失败: {}", last_err);
        }

        let size = cache.size(&tarball_name);
        log_fn(&format!(
            "[tarball] 下载完成: {} ({})",
            cached_file.display(),
            crate::utils::format_file_size(size)
        ));

        // 2026-08-23: 保存 commit hash 到 ini 文件
        match get_remote_head_commit(&repo_url, _env_path) {
            Ok(commit) => {
                if let Err(e) = save_commit_to_ini(short_name, &commit, log_fn) {
                    log_fn(&format!(
                        "[tarball] 警告: 保存 commit 失败: {}",
                        e
                    ));
                }
            }
            Err(e) => {
                log_fn(&format!(
                    "[tarball] 警告: 无法获取 commit hash（{}），下次将重新验证",
                    e
                ));
            }
        }
    }

    // 3. 解压逻辑（复用现有代码）
    // 临时解压目录
    let temp_extract_dir = cache
        .dl_runtimes_dir()
        .join(format!("_extract_{}", short_name));
    let _ = std::fs::remove_dir_all(&temp_extract_dir);
    std::fs::create_dir_all(&temp_extract_dir)
        .with_context(|| {
            format!(
                "创建临时解压目录失败: {}",
                temp_extract_dir.display()
            )
        })?;

    log_fn(&format!(
        "[tarball] 解压: {} -> {}",
        cached_file.display(),
        temp_extract_dir.display()
    ));

    let extracted_root = extractor::extract_sync(&cached_file, &temp_extract_dir)
        .with_context(|| format!("解压 tarball 失败: {}", cached_file.display()))?;

    log_fn(&format!(
        "[tarball] 解压根目录: {}",
        extracted_root.display()
    ));

    // 检查目录是否非空
    if !extracted_root.exists() || std::fs::read_dir(&extracted_root)?.next().is_none() {
        bail!("解压后目录为空或不存在: {}", extracted_root.display());
    }

    // 清理旧目录
    if target_dir.exists() {
        log_fn(&format!(
            "[tarball] 清理旧目录: {}",
            target_dir.display()
        ));
        std::fs::remove_dir_all(target_dir)
            .with_context(|| format!("清理旧安装目录失败: {}", target_dir.display()))?;
    }

    // 移动到目标
    log_fn(&format!(
        "[tarball] 移动到: {}",
        target_dir.display()
    ));
    std::fs::rename(&extracted_root, target_dir)
        .with_context(|| {
            format!(
                "移动目录失败: {} -> {}",
                extracted_root.display(),
                target_dir.display()
            )
        })?;

    // 清理临时目录
    let _ = std::fs::remove_dir_all(&temp_extract_dir);

    log_fn(&format!(
        "[tarball] {} 安装完成: {}",
        short_name,
        target_dir.display()
    ));

    Ok(())
}
