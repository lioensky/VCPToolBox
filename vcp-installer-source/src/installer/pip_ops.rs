use std::path::Path;
use std::process::Stdio;
use std::sync::mpsc;

use anyhow::{bail, Context, Result};

use crate::app::PipMirrorChoice;
use crate::installer::stream_util::{self, WatchdogPolicy};
use crate::mirrors::MirrorConfig;

const PYPI_OFFICIAL: &str = "https://pypi.org/simple";

/// 检测 pip 输出中是否包含网络类瞬时错误（用于日志提示，决定失败原因归类）。
/// pip 的网络错误多为 ReadTimeoutError / ConnectionError / NewConnectionError /
/// "Connection aborted" / "RemoteDisconnected" 等。
fn is_pip_network_error(output: &str) -> bool {
    const SIGS: [&str; 12] = [
        "ReadTimeoutError",
        "ConnectionError",
        "NewConnectionError",
        "NameResolutionError",
        "Connection aborted",
        "RemoteDisconnected",
        "Connection reset",
        "ConnectionRefusedError",
        "MaxRetryError",
        // 2026-08-21 拔线测试暴露：断网时 pip 报的 DNS 解析失败/连接失败特征
        // （WinError 11001 getaddrinfo / error: connection-failed），此前不在列表导致重试失效
        "getaddrinfo",
        "connection-failed",
        "Failed to resolve",
    ];
    SIGS.iter().any(|s| output.contains(s))
}

/// 检测 pip 输出是否为「源不可用」特征（镜像站 403 / 无匹配版本）。
/// 命中即说明该源当前不可用，应切换到下一个候选源（同源重试无意义）。
fn is_pip_source_dead(output: &str) -> bool {
    const SIGS: [&str; 4] = [
        "No matching distribution",
        "Could not find a version that satisfies",
        "HTTPError 403",
        "403 Forbidden",
    ];
    SIGS.iter().any(|s| output.contains(s))
}

/// 构建 pip 候选源列表（韧性核心，2026-08-23 Plan A）：
/// 顺序：站点测试选出的优选源 → 其余已配置镜像（去重）→ 官方 PyPI 兜底。
/// 任一源失败（403/网络错误/挂死）即切到下一个，不再硬编码单源。
fn build_pip_source_candidates(
    pip_mirror: &PipMirrorChoice,
    mirror_config: &MirrorConfig,
) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();

    // 1. 站点测试选出的优选源（use_mirror=false 时为官方源）
    if pip_mirror.use_mirror {
        if let Some(entry) = mirror_config.pip.get(pip_mirror.mirror_index) {
            candidates.push(normalize_url(entry.url.as_str()));
        }
    } else {
        candidates.push(PYPI_OFFICIAL.to_string());
    }

    // 2. 其余已配置镜像（去重）
    for entry in &mirror_config.pip {
        let url = normalize_url(entry.url.as_str());
        if !candidates.iter().any(|c| c == &url) {
            candidates.push(url);
        }
    }

    // 3. 官方 PyPI 最后兜底（去重）
    if !candidates.iter().any(|c| c == PYPI_OFFICIAL) {
        candidates.push(PYPI_OFFICIAL.to_string());
    }

    candidates
}

/// 规范化 URL：去掉尾部斜杠（pip -i 参数两种写法都接受，统一便于去重/显示）。
fn normalize_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// 使用指定的 Python 执行 pip install -r requirements.txt（实时输出日志）。
///
/// 多源韧性（2026-08-23 Plan A）：
/// - 按 build_pip_source_candidates 顺序逐源尝试，每源一次（pip 内部已有 --retries 5）
/// - 源 403 / 网络错误 / 看门狗挂死 → 自动切下一个候选源
/// - 全部源失败 → bail（由调用方降级为 WARNING，不判组件失败）
pub fn pip_install_requirements(
    python_exe: &Path,
    project_dir: &Path,
    env_path: &str,
    pip_mirror: &PipMirrorChoice,
    mirror_config: &MirrorConfig,
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

    let candidates = build_pip_source_candidates(pip_mirror, mirror_config);

    let mut last_reason = String::from("未知原因");
    for (idx, url) in candidates.iter().enumerate() {
        log_fn(&format!(
            "[pip] 使用源 {}/{}: {}",
            idx + 1,
            candidates.len(),
            url
        ));

        let mut cmd = build_pip_command(python_exe, project_dir, &requirements, env_path, url);
        let mut child = cmd
            .spawn()
            .with_context(|| format!("启动 pip install 失败: {}", project_dir.display()))?;

        let mut output_buf = String::new();
        let clean = stream_pip_output_collect(&mut child, &mut output_buf, log_fn);

        let status = child.wait().with_context(|| "等待 pip install 完成失败")?;
        if status.success() {
            log_fn("[pip] install 完成");
            return Ok(());
        }

        // 记录失败原因（供日志提示 + 最终 bail 信息）
        if !clean {
            last_reason = "看门狗检测到挂死（90秒无输出）".to_string();
        } else if is_pip_source_dead(&output_buf) {
            last_reason = "源不可用（403 / 无匹配版本）".to_string();
        } else if is_pip_network_error(&output_buf) {
            last_reason = "网络瞬时错误（pip 内部 5 次重试后仍失败）".to_string();
        } else {
            last_reason = format!("exit code: {:?}", status.code());
        }

        log_fn(&format!(
            "[pip] 源 {} 失败（{}），尝试下一源...",
            url, last_reason
        ));
    }

    bail!(
        "pip install 失败（{} 个源全部尝试，最后原因: {}）",
        candidates.len(),
        last_reason
    );
}

/// 构建 pip install 命令（含重试/超时参数与镜像源 URL）。
fn build_pip_command(
    python_exe: &Path,
    project_dir: &Path,
    requirements: &Path,
    env_path: &str,
    index_url: &str,
) -> std::process::Command {
    let mut cmd = std::process::Command::new(python_exe);
    // --retries 5 --timeout 60：内层重试（pip 默认 timeout 仅 15s，大 wheel 易超时）
    cmd.args([
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-warn-script-location", // 抑制 Scripts not on PATH 警告（非报错）
        "--retries",
        "5",
        "--timeout",
        "60",
        "-r",
    ])
    .arg(requirements)
    .current_dir(project_dir)
    // 不覆盖 PATH，避免 pip wheel build 把包装到系统 venv
    .env_remove("PATH")
    .env("PIP_NO_CONFIG", "1") // 禁用系统 pip.ini（避免镜像源影响）
    .env("PYTHONPATH", "") // 清空 PYTHONPATH，避免导入系统 venv 的包
    .env("VIRTUAL_ENV", "") // 清空 VIRTUAL_ENV，避免 pip 认为在 venv 中
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    // 显式指定 -i（避免 pip.ini 残留配置 / 环境差异）
    cmd.args(["-i", index_url]);

    let _ = env_path; // env_path 预留（当前 pip 通过 env_remove(PATH) 隔离）
    cmd
}

/// 实时读取 pip 子进程的 stdout 和 stderr，同时收集完整输出文本（供网络错误判定）。
///
/// # 设计
/// - 双线程并发读取 + mpsc 回传（防管道死锁）
/// - 活动看门狗：90 秒无输出（pip 下载阶段）则 kill，交给外层重试
///   - 看门狗在出现 "Installing collected packages"（安装阶段）后解除
///     避免误杀 pip 本地安装/编译的静默期
/// - 2026-08-23 A5 日志精简（CARP：进度 5% 一条估算即可，不求精确）：
///   1. 过滤 "INFO: pip is looking at multiple versions..."（依赖回溯噪音，2+ 行）
///   2. 时间估算：每 10 秒 +5%，封顶 95%
///   3. "Installing collected packages" 出现 → 100%
///   4. "Successfully installed" / "Requirement already satisfied" 保留
///
/// # 返回
/// - `true`：两管道正常 EOF（进程正常结束）
/// - `false`：看门狗检测到挂死并已 kill（**未 wait**，调用方负责 wait）
fn stream_pip_output_collect(
    child: &mut std::process::Child,
    output_buf: &mut String,
    log_fn: &dyn Fn(&str),
) -> bool {
    use std::cell::Cell;

    const ACTIVITY_TIMEOUT_SECS: u64 = 90;

    // A5 状态（Cell 包装让闭包实现 Fn 而非 FnMut）
    let start = std::time::Instant::now();
    let next_bucket: Cell<u32> = Cell::new(5);
    let downloads_done: Cell<bool> = Cell::new(false);

    let (tx, rx) = mpsc::channel::<crate::installer::stream_util::StreamEvent>();

    // stdout 读线程（pip 主要输出）
    if let Some(stdout) = child.stdout.take() {
        stream_util::spawn_pipe_reader(stdout, tx.clone(), "[pip]", false);
    }

    // stderr 读线程（pip 警告/错误，网络错误多在此）
    if let Some(stderr) = child.stderr.take() {
        stream_util::spawn_pipe_reader(stderr, tx, "[pip]", false);
    }

    // A5 包装层：过滤 + 时间估算进度
    let log_fn_ref: &dyn Fn(&str) = log_fn;
    let filtered_log = |line: &str| {
        let line_trim = line.trim();
        // 1. 过滤依赖回溯噪音
        if line_trim.starts_with("[pip] INFO: pip is looking at multiple versions") {
            return;
        }
        // 2. "Installing collected packages" → 下载完成 → 100%
        if line_trim.contains("Installing collected packages") {
            if !downloads_done.get() {
                downloads_done.set(true);
                log_fn_ref("[pip] 下载进度 100%");
            }
            log_fn_ref(line);
            return;
        }
        // 3. 时间估算进度（每 10 秒 +5%，封顶 95%）
        if !downloads_done.get() {
            let elapsed = start.elapsed().as_secs();
            let pct = ((elapsed / 10) * 5).min(95) as u32;
            let mut nb = next_bucket.get();
            while nb <= pct {
                log_fn_ref(&format!("[pip] 下载进度 {}%", nb));
                nb += 5;
            }
            next_bucket.set(nb);
        }
        log_fn_ref(line);
    };

    // 父线程：转发 + 活动看门狗（pip 无 \r 进度条，bucket=0 不启用进度过滤）
    let result = stream_util::pump_child_output_with_bucket(
        child,
        rx,
        &filtered_log,
        None,
        ACTIVITY_TIMEOUT_SECS,
        WatchdogPolicy::UntilMarker("Installing collected packages".to_string()),
        Some(output_buf),
        0,
    );

    result
}

/// 从 pip 日志行中提取包名（用于 Collecting/Downloading 统计）。
/// 格式："[pip] Collecting sympy (from requirements.txt)" 或
///      "[pip] Downloading sympy-1.14.0-py3-none-any.whl (6.3 MB)"
fn extract_pip_package_name(line: &str, prefix: &str) -> Option<String> {
    // 找到前缀（如 "Collecting "）后的第一个非空白字符开始
    let idx = line.find(prefix)? + prefix.len();
    let rest = line[idx..].trim_start();
    // 提取第一个单词（到空格或括号）
    let pkg_end = rest.find(|c: char| c.is_whitespace() || c == '(').unwrap_or(rest.len());
    let pkg = &rest[..pkg_end];
    if pkg.is_empty() {
        None
    } else {
        Some(pkg.to_string())
    }
}