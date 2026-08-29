use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};

use crate::installer::stream_util::{self, StreamEvent, WatchdogPolicy};

/// Git clone 默认超时时间（秒）
const GIT_CLONE_TIMEOUT_SECS: u64 = 900; // 15分钟

/// 使用指定的 git 可执行文件克隆仓库（实时输出日志 + 超时保护）。
/// 如果目标目录已存在且是 git 仓库，则自动执行 git pull。
pub fn git_clone(
    git_exe: &Path,
    repo_url: &str,
    dest: &Path,
    env_path: &str,
    log_fn: &dyn Fn(&str),
) -> Result<()> {
    git_clone_with_timeout(git_exe, repo_url, dest, env_path, log_fn, GIT_CLONE_TIMEOUT_SECS)
}

/// 带超时和实时日志的 git clone 内部实现。
fn git_clone_with_timeout(
    git_exe: &Path,
    repo_url: &str,
    dest: &Path,
    env_path: &str,
    log_fn: &dyn Fn(&str),
    timeout_secs: u64,
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
    log_fn(&format!("[git] 超时设置: {}秒", timeout_secs));

    let mut child = Command::new(git_exe)
        .args(["clone", "--depth", "1", "--progress", repo_url])
        .arg(dest)
        .env("PATH", env_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("启动 git clone 失败: {}", dest.display()))?;

    let pid = child.id();
    log_fn(&format!("[git] git process PID: {}", pid));

    // git clone 进度输出在 stderr，实时流式读取（含 \r 规范化 + 活动看门狗 + 中间进度）
    let clean = stream_output(&mut child, log_fn, true);
    if !clean {
        // 看门狗已 kill（拔网线静默挂死），返回失败交给上层重试
        bail!("git clone 挂死（90秒无任何输出），已终止 (PID: {})", pid);
    }

    // 带超时的 wait
    let start = std::time::Instant::now();
    let status = loop {
        if start.elapsed() >= Duration::from_secs(timeout_secs) {
            log_fn(&format!("[git] ⚠️ 超时 ({})秒，终止 git clone...", timeout_secs));
            // 尝试优雅终止
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(&["/T", "/F", "/PID", &pid.to_string()])
                    .output();
            }
            #[cfg(unix)]
            {
                let _ = std::process::Command::new("kill")
                    .args(&["-9", &pid.to_string()])
                    .output();
            }
            return Err(anyhow!(
                "git clone 超时 ({}秒): {} -> {}",
                timeout_secs,
                repo_url,
                dest.display()
            ));
        }

        // 非阻塞检查是否结束
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                // 还在运行，等待一小会儿再检查
                std::thread::sleep(Duration::from_millis(500));
            }
            Err(e) => {
                return Err(anyhow!("等待 git clone 状态失败: {}", e));
            }
        }
    };

    if !status.success() {
        bail!("git clone 失败 (exit code: {:?})", status.code());
    }

    let elapsed = start.elapsed();
    log_fn(&format!("[git] clone 完成 (耗时 {}秒)", elapsed.as_secs()));
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

    // 丢弃本地修改（installer生成的bat等会覆盖仓库文件，导致pull冲突）
    let reset = Command::new(git_exe)
        .args(["checkout", "--", "."])
        .current_dir(repo_dir)
        .env("PATH", env_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
    if let Ok(out) = &reset {
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            log_fn(&format!("[git] checkout -- . 警告: {}", err.trim()));
        }
    }

    let mut child = Command::new(git_exe)
        .args(["pull", "--ff-only"])
        .current_dir(repo_dir)
        .env("PATH", env_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("启动 git pull 失败: {}", repo_dir.display()))?;

    // git pull 进度也用 \r → 规范化 + 看门狗
    let clean = stream_output(&mut child, log_fn, true);
    if !clean {
        bail!("git pull 挂死（90秒无任何输出），已终止 (PID: {})", child.id());
    }

    let status = child.wait().with_context(|| "等待 git pull 完成失败")?;
    if !status.success() {
        bail!("git pull 失败 (exit code: {:?})", status.code());
    }

    log_fn("[git] pull 完成");
    Ok(())
}

/// 实时读取子进程的 stdout 和 stderr，逐行推送到 log_fn。
///
/// # 设计（三项保障）
/// 1. **fatal 错误完整**：双线程并发读 stderr/stdout + mpsc 回传，大仓库不丢输出、不死锁。
/// 2. **TUI 不假进度**：`normalize_cr` 把 git 的 `\r` 进度条压成"最终态"一条，不再撑爆面板。
/// 3. **拔网线不挂死**：`pump_child_output` 用活动看门狗，90 秒无字节即 kill，交给上层重试。
///
/// # 参数
/// - `normalize`: 是否做 `\r` 规范化（git clone/pull 传 true，进度条场景）。
///
/// # 返回
/// - `true`：两管道正常 EOF（进程正常结束）
/// - `false`：看门狗检测到挂死并已 kill（**未 wait**，调用方负责 wait/判定）
fn stream_output(
    child: &mut std::process::Child,
    log_fn: &dyn Fn(&str),
    normalize: bool,
) -> bool {
    const ACTIVITY_TIMEOUT_SECS: u64 = 90;

    let (tx, rx) = mpsc::channel::<StreamEvent>();

    // stderr 读线程（git 的进度和 fatal 错误都在 stderr）
    if let Some(stderr) = child.stderr.take() {
        stream_util::spawn_pipe_reader(stderr, tx.clone(), "[git]", normalize);
    }

    // stdout 读线程
    if let Some(stdout) = child.stdout.take() {
        stream_util::spawn_pipe_reader(stdout, tx, "[git]", normalize);
    }

    // 父线程：转发 + 活动看门狗（git 全程几乎都在等网络 → Always 启用）
    // 2026-08-22: progress_fn 传 None → 回退到全局 TUI_PROGRESS_FN（component_ops 设置）
    // 这样 git 中间进度实时滚动到 TUI，但不污染日志文件
    stream_util::pump_child_output(
        child,
        rx,
        log_fn,
        None,
        ACTIVITY_TIMEOUT_SECS,
        WatchdogPolicy::Always,
        None,
    )
}


/// 在已有部署目录中初始化 git 仓库（Tarball+Git 模式）。
///
/// 目录中必须已有完整源码（tarball 解压而来），本函数只补齐 .git 仓库，
/// 使该目录具备 git pull 更新能力。
///
/// 流程：
/// 1. git init（若 .git 不存在）
/// 2. git remote 配置 origin
/// 3. git fetch --depth 1（多镜像站轮换 + 超时保护，Plan B 韧性增强）
/// 4. git reset --hard origin/main（工作区对齐远程快照）
/// 5. git branch --set-upstream-to（确保 git pull 正常工作）
///
/// # Plan B 多镜像轮换（2026-08-29）
/// 2026-08-28 拔线测试发现：单站点 fetch 遇 429 限流/断网时 3 次重试全失败，
/// 留下空 .git（有 remote 无 commit），后续 git pull 必失败。
/// 修复：fetch 失败时按 candidate_prefixes 顺序轮换镜像站，每站最多 3 次重试。
///
/// # 参数
/// - `git_exe`: git 可执行文件路径
/// - `base_repo_url`: 原始仓库 URL（https://github.com/xxx/yyy.git）
/// - `candidate_prefixes`: 候选镜像前缀列表（有序，优先级从高到低）
/// - `repo_dir`: 目标仓库目录
/// - `env_path`: 环境变量 PATH
/// - `log_fn`: 日志回调
///
/// # 返回
/// - `Ok(())`: 仓库初始化成功，已具备 git pull 能力
/// - `Err`: 所有镜像站均失败（调用方应执行 Plan A 回滚）
pub fn git_init_from_remote(
    git_exe: &Path,
    base_repo_url: &str,
    candidate_prefixes: &[String],
    repo_dir: &Path,
    env_path: &str,
    log_fn: &dyn Fn(&str),
) -> Result<()> {
    const BRANCH: &str = "main";

    if !git_exe.exists() {
        bail!("未找到 git 可执行文件: {}", git_exe.display());
    }
    if !repo_dir.exists() {
        bail!("仓库目录不存在: {}", repo_dir.display());
    }

    // 1. git init -b main（2026-08-23 v18.10: 统一分支名为 main，与 clone 模式一致）
    // 2026-08-23 A1: 关闭 defaultBranchName 提示
    if !is_git_repo(repo_dir) {
        log_fn(&format!("[git] init -b main（Tarball+Git 模式）: {}", repo_dir.display()));
        let init = match run_git(
            git_exe,
            repo_dir,
            &["-c", "advice.defaultBranchName=false", "init", "-b", BRANCH],
            env_path,
            log_fn,
        ) {
            Some(out) => out,
            None => bail!("git init 执行失败"),
        };
        if !init.status.success() {
            bail!("git init 失败 (exit code: {:?})", init.status.code());
        }
    } else {
        log_fn(&format!("[git] .git 已存在，跳过 init: {}", repo_dir.display()));
    }

    // 2+3. 多镜像站轮换 fetch（Plan B 韧性增强，2026-08-29）
    // 按 candidate_prefixes 顺序逐站尝试：set-url origin → fetch --depth 1
    // 每站最多 3 次重试（含超时保护），全部站均失败则 bail（触发 Plan A 回滚）
    if candidate_prefixes.is_empty() {
        bail!(
            "无可用候选镜像站: {} -> {}",
            base_repo_url,
            repo_dir.display()
        );
    }

    let mut last_err = String::new();
    let mut fetch_success_prefix: Option<String> = None;

    for (mi, prefix) in candidate_prefixes.iter().enumerate() {
        // 拼接本候选站的完整 URL
        let site_url = crate::installer::downloader::apply_mirror(base_repo_url, prefix);

        // 设置/更新 origin 为本站 URL
        let probe = run_git(git_exe, repo_dir, &["remote", "get-url", "origin"], env_path, &|_| {});
        let origin_exists = probe.map(|o| o.status.success()).unwrap_or(false);

        let set_ok = if origin_exists {
            match run_git(
                git_exe,
                repo_dir,
                &["remote", "set-url", "origin", &site_url],
                env_path,
                &|_| {},
            ) {
                Some(out) => out.status.success(),
                None => false,
            }
        } else {
            match run_git(
                git_exe,
                repo_dir,
                &["remote", "add", "origin", &site_url],
                env_path,
                &|_| {},
            ) {
                Some(out) => out.status.success(),
                None => false,
            }
        };

        if !set_ok {
            log_fn(&format!(
                "[git] ! 设置 origin 失败 (站点: {})，尝试下一站",
                prefix
            ));
            last_err = format!("设置 origin 失败: {}", prefix);
            continue;
        }

        // 尝试本站 fetch（最多 3 次）
        let mut site_ok = false;
        for attempt in 1u32..=3 {
            log_fn(&format!("[git] fetch --depth 1 origin {}: {}", BRANCH, site_url));

            let mut child = match Command::new(git_exe)
                .args(["fetch", "--depth", "1", "--progress", "origin", BRANCH])
                .current_dir(repo_dir)
                .env("PATH", env_path)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
            {
                Ok(c) => c,
                Err(e) => {
                    log_fn(&format!("[git] ! 启动 git fetch 失败: {}", e));
                    last_err = format!("启动 git fetch 失败: {}", e);
                    break;
                }
            };

            let pid = child.id();
            let clean = stream_output(&mut child, log_fn, true);

            let start = std::time::Instant::now();
            const FETCH_TIMEOUT_SECS: u64 = 600;
            let status = if clean {
                loop {
                    if start.elapsed() >= Duration::from_secs(FETCH_TIMEOUT_SECS) {
                        log_fn(&format!("[git] ! 超时 ({}秒)，终止 git fetch...", FETCH_TIMEOUT_SECS));
                        #[cfg(windows)]
                        {
                            let _ = Command::new("taskkill")
                                .args(&["/T", "/F", "/PID", &pid.to_string()])
                                .output();
                        }
                        #[cfg(unix)]
                        {
                            let _ = std::process::Command::new("kill")
                                .args(&["-9", &pid.to_string()])
                                .output();
                        }
                        break None;
                    }
                    match child.try_wait() {
                        Ok(Some(s)) => break Some(s),
                        Ok(None) => std::thread::sleep(Duration::from_millis(500)),
                        Err(e) => {
                            log_fn(&format!("[git] ! 等待 git fetch 状态失败: {}", e));
                            last_err = format!("等待 git fetch 状态失败: {}", e);
                            break None;
                        }
                    }
                }
            } else {
                // 看门狗已 kill（拔网线挂死）
                None
            };

            match status {
                Some(s) if s.success() => {
                    site_ok = true;
                    break;
                }
                Some(s) => {
                    last_err = format!("fetch 失败 (exit: {:?})", s.code());
                    if attempt < 3 {
                        let delay = 3u64 * (attempt as u64);
                        log_fn(&format!(
                            "[git] fetch 失败 (exit code: {:?})，{} 秒后重试 ({}/{})...",
                            s.code(), delay, attempt, 3
                        ));
                        std::thread::sleep(Duration::from_secs(delay));
                    }
                }
                None => {
                    last_err = format!("fetch 超时 ({}秒)", FETCH_TIMEOUT_SECS);
                    if attempt < 3 {
                        let delay = 3u64 * (attempt as u64);
                        log_fn(&format!(
                            "[git] fetch 超时 ({}秒)，{} 秒后重试 ({}/{})...",
                            FETCH_TIMEOUT_SECS, delay, attempt, 3
                        ));
                        std::thread::sleep(Duration::from_secs(delay));
                    }
                }
            }
        }

        if site_ok {
            fetch_success_prefix = Some(prefix.clone());
            break;
        }

        // 本站 3 次全失败，换下一站
        log_fn(&format!(
            "[git] ! 站点 {} 重试3次仍失败，切换备用站点",
            prefix
        ));
        if mi < candidate_prefixes.len() - 1 {
            log_fn(&format!(
                "[git] ! 切换至下一站: {}",
                candidate_prefixes[mi + 1]
            ));
        }
    }

    if fetch_success_prefix.is_none() {
        bail!(
            "git fetch 所有镜像站均失败: {} (最后错误: {})",
            repo_dir.display(),
            last_err
        );
    }

    // 4. git reset --hard origin/main（静默执行，避免原始输出进日志）
    let reset = match run_git(
        git_exe,
        repo_dir,
        &["reset", "--hard", &format!("origin/{}", BRANCH)],
        env_path,
        &|_| {}, // 静默
    ) {
        Some(out) => out,
        None => bail!("git reset 执行失败"),
    };

    if !reset.status.success() {
        // 失败时记录错误信息
        let err = String::from_utf8_lossy(&reset.stderr);
        log_fn(&format!("[git] git reset --hard 失败: {}", err.trim()));
        bail!("git reset --hard 失败 (exit code: {:?})", reset.status.code());
    }

    // 5. 设置 upstream tracking（2026-08-23 v18.10: 确保 git pull 正常工作）
    // 静默执行，成功/失败都不影响安装（git pull 失败时会报错提示用户）
    let _ = run_git(
        git_exe,
        repo_dir,
        &["branch", "--set-upstream-to", &format!("origin/{}", BRANCH), BRANCH],
        env_path,
        &|_| {}, // 静默
    );

    // 成功时记录标准化日志
    log_fn(&format!(
        "[git] 仓库已同步到最新状态: {}",
        repo_dir.display()
    ));
    Ok(())
}

/// 执行单个 git 命令并同步输出日志（非流式，用于短命令）。
///
/// 2026-08-23 A4: 对 stderr/stdout 每行做 CR 规范化（normalize_cr），
/// 避免 `Updating files: 62%...63%...100%` 的 \r 式进度条在日志中刷屏。
fn run_git(
    git_exe: &Path,
    repo_dir: &Path,
    args: &[&str],
    env_path: &str,
    log_fn: &dyn Fn(&str),
) -> Option<std::process::Output> {
    let output = Command::new(git_exe)
        .args(args)
        .current_dir(repo_dir)
        .env("PATH", env_path)
        .output();
    match output {
        Ok(out) => {
            for line in String::from_utf8_lossy(&out.stderr).lines() {
                // A4: CR 规范化（git 进度条用 \r 更新，只保留最终态）
                let normalized = crate::installer::stream_util::normalize_cr(line);
                let t = normalized.trim();
                if !t.is_empty() {
                    log_fn(&format!("[git] {}", t));
                }
            }
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let normalized = crate::installer::stream_util::normalize_cr(line);
                let t = normalized.trim();
                if !t.is_empty() {
                    log_fn(&format!("[git] {}", t));
                }
            }
            Some(out)
        }
        Err(e) => {
            log_fn(&format!("[git] ! 执行 git 命令失败: {}", e));
            None
        }
    }
}


/// 清理残缺的 clone 目录（clone 中断/不完整时，重试前必须清理）
///
/// - dest 存在且不是合法 git 仓库 → 判定为残缺目录，删除
/// - dest 是 git 仓库（重装场景）→ 保留（git_clone 会自动 pull 更新）
pub fn clean_partial_clone(dest: &Path, log_fn: &dyn Fn(&str)) {
    if dest.exists() && !is_git_repo(dest) {
        log_fn(&format!("[git] 清理残缺目录: {}", dest.display()));
        let _ = std::fs::remove_dir_all(dest);
    }
}

/// 韧性 git clone：按候选站点顺序，每站最多 3 次尝试，失败换下一站
///
/// # 参数
/// - `git_exe`: git 可执行文件路径
/// - `base_repo_url`: 原始仓库 URL（https://github.com/xxx/yyy.git）
/// - `candidate_prefixes`: 候选镜像前缀列表（有序，优先级从高到低）
/// - `dest`: 目标目录
/// - `env_path`: 环境变量 PATH
/// - `log_fn`: 日志回调
///
/// # 返回
/// - `Ok(())`: 克隆成功
/// - `Err`: 所有候选站点均失败
pub fn git_clone_resilient(
    git_exe: &Path,
    base_repo_url: &str,
    candidate_prefixes: &[String],
    dest: &Path,
    env_path: &str,
    log_fn: &dyn Fn(&str),
) -> Result<()> {
    if candidate_prefixes.is_empty() {
        bail!("无可用候选镜像站");
    }

    let mut last_err = String::new();

    for (mi, prefix) in candidate_prefixes.iter().enumerate() {
        let repo_url = crate::installer::downloader::apply_mirror(base_repo_url, prefix);

        for attempt in 0..3 {
            // 每次尝试前清理残缺目录（首次时若 dest 不存在则无操作）
            clean_partial_clone(dest, log_fn);

            match git_clone(git_exe, &repo_url, dest, env_path, log_fn) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last_err = e.to_string();
                    log_fn(&format!(
                        "[git] ! 第{}/3次尝试失败 (站点: {}): {}",
                        attempt + 1,
                        prefix,
                        e
                    ));
                    // 非本站最后一次，等待后重试
                    if attempt < 2 {
                        std::thread::sleep(Duration::from_secs(2));
                    }
                }
            }
        }

        // 本站 3 次耗尽，切换下一站
        if mi < candidate_prefixes.len() - 1 {
            let next_prefix = &candidate_prefixes[mi + 1];
            log_fn(&format!(
                "[git] ! 站点 {} 重试3次仍失败，切换备用站点: {}",
                prefix, next_prefix
            ));
        }
    }

    bail!("所有 git 镜像站均失败: {}", last_err)
}
