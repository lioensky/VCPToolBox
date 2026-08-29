//! 子进程流式读取 + 活动看门狗（共享原语，供 git/npm/pip 使用）。
//!
//! # 解决的三个问题
//! 1. **TUI 假进度**：git 进度条用 `\r` 更新（不换行），`read_line` 会把整条
//!    进度打包成"一条超长日志"（9772 字符），TUI 按条算行高被撑爆，屏幕显示
//!    滞后的旧进度。→ 本模块按字节读取并做 `\r` 规范化，每条进度只保留最后一段。
//! 2. **拔网线停滞**：拔网线后已建立的 TCP 连接静默挂死（OS 级重传 15+ 分钟），
//!    子进程既不退出也不报错，外层重试卡在 `child.wait()`。→ 本模块用
//!    "活动心跳 + 90 秒无活动判定"看门狗，主动 kill 挂死进程，交给上层重试。
//! 3. **管道死锁**：双线程并发读 stderr/stdout，防 4KB 缓冲写满死锁（沿用既有设计）。
//!
//! # 心跳机制（防止误杀）
//! 读线程每读到一个非空数据块就发一个 `Heartbeat`，不管是否凑成完整行。
//! 因此 git/npm/pip 只要在"动"（有字节流过），父线程就认为进程健康，不触发看门狗；
//! 只有真正"一个字节都没有"（拔网线/挂死）持续 90 秒，才 kill。

use std::io::Read;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 全局 TUI 专用进度函数（用于 Progress 事件）。
/// 2026-08-22: 让 git/npm/pip 的中间进度实时滚动到 TUI，但不污染日志文件。
/// git_ops 在调用 pump_child_output 前设置，完成后清除。
static TUI_PROGRESS_FN: OnceLock<Arc<Mutex<Option<Box<dyn Fn(&str) + Send + Sync>>>>> =
    OnceLock::new();

fn tui_progress_fn_slot() -> &'static Arc<Mutex<Option<Box<dyn Fn(&str) + Send + Sync>>>> {
    TUI_PROGRESS_FN.get_or_init(|| Arc::new(Mutex::new(None)))
}

/// 设置 TUI 专用进度函数（git_ops 用）。
pub fn set_tui_progress_fn<F>(f: F)
where
    F: Fn(&str) + Send + Sync + 'static,
{
    if let Ok(mut guard) = tui_progress_fn_slot().lock() {
        *guard = Some(Box::new(f));
    }
}

/// 清除 TUI 专用进度函数。
pub fn clear_tui_progress_fn() {
    if let Ok(mut guard) = tui_progress_fn_slot().lock() {
        *guard = None;
    }
}

/// 获取并调用 TUI 专用进度函数（如果已设置）。
pub fn call_tui_progress_fn(msg: &str) {
    if let Ok(guard) = tui_progress_fn_slot().lock() {
        if let Some(f) = guard.as_ref() {
            f(msg);
        }
    }
}

/// 读线程 → 父线程 的事件。
#[derive(Debug, Clone)]
pub enum StreamEvent {
    /// 读到一个数据块（活动指示，不一定成行）。
    Heartbeat,
    /// 一条完整日志（已加前缀、已做 \r 规范化、已 trim）。
    Line(String),
    /// 中间进度段（\r 式进度条的实时滚动，供 TUI 显示）。
    /// 2026-08-21 拔线测试修复：之前中间进度被 normalize_cr 全吞，
    /// CARP 无法观察 git 克隆实时进度、无法在 50% 时精准拔线。
    /// 现在 spawn_pipe_reader 在 normalize=true 时，
    /// 每读到一个 \r 分隔的新段就发一个 Progress 事件，
    /// TUI 侧单独渲染成实时进度条，日志文件不受影响。
    Progress(String),
}

/// 规范化 \r 式进度更新：保留最终态行，同时把中间进度段拆出来供 TUI 实时显示。
///
/// git/npm 进度条形如 `0% ...\r1% ...\r...\r100% ...`，每段是同一行的重绘。
/// 日志文件里只保留最终态（避免 9772 字符超长行撑爆 TUI），
/// 中间的 0%→50%→100% 由 split_progress_segments 拆出，TUI 侧用 Progress 事件实时渲染。
pub fn normalize_cr(line: &str) -> String {
    let trimmed = line.trim_end_matches('\r').trim_end_matches('\n');
    trimmed
        .rsplit('\r')
        .find(|s| !s.trim().is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

/// 从 \r 式进度条中提取所有中间进度段（含最终态），供 TUI 实时显示。
/// 无 \r 的普通行返回空 Vec。
pub fn split_progress_segments(line: &str) -> Vec<String> {
    if !line.contains('\r') {
        return Vec::new();
    }
    let trimmed = line.trim_end_matches('\r').trim_end_matches('\n');
    trimmed
        .split('\r')
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .collect()
}

/// 为一个管道派生读线程：字节级读取，发 Heartbeat + Line + Progress 事件。
///
/// - 每读到非空数据块 → 发 Heartbeat（活动心跳）
/// - 每凑成一条 `\n` 结尾的行 → 发 Line（已加前缀、已规范化）
/// - EOF 时若 buffer 有残留 → 作为最后一条 Line 发出
/// - **2026-08-21 新增**：`normalize=true` 时，每凑成一条含 `\r` 的行，
///   把中间进度段逐个发 Progress 事件（TUI 实时显示用）
///
/// `normalize=true` 时对每行做 `\r` 规范化（git 进度条用）。
pub fn spawn_pipe_reader<R>(
    reader: R,
    tx: mpsc::Sender<StreamEvent>,
    prefix: &'static str,
    normalize: bool,
) where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        let mut line_buf: Vec<u8> = Vec::new();

        // 处理单行：发 Progress（中间进度段）+ Line（最终态）
        let mut process_line = |raw_line: &str| {
            // 2026-08-21: 先拆出中间进度段发 Progress（TUI 实时显示）
            if normalize {
                for seg in split_progress_segments(raw_line) {
                    let _ = tx.send(StreamEvent::Progress(format!(
                        "{} {}",
                        prefix, seg
                    )));
                }
            }
            // 再发最终态 Line（日志文件记录）
            let mut line = raw_line.to_string();
            if normalize {
                line = normalize_cr(&line);
            }
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                let _ = tx.send(StreamEvent::Line(format!(
                    "{} {}",
                    prefix, trimmed
                )));
            }
        };

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let _ = tx.send(StreamEvent::Heartbeat);
                    line_buf.extend_from_slice(&buf[..n]);
                    // 抽取所有完整行
                    while let Some(pos) = line_buf.iter().position(|&b| b == b'\n') {
                        let line_bytes = line_buf[..pos].to_vec();
                        line_buf.drain(..=pos);
                        let line = String::from_utf8_lossy(&line_bytes).to_string();
                        process_line(&line);
                    }
                }
                Err(_) => break,
            }
        }
        // 处理无结尾换行的残留
        if !line_buf.is_empty() {
            let line = String::from_utf8_lossy(&line_buf).to_string();
            process_line(&line);
        }
    });
}

/// 看门狗策略。
#[derive(Clone)]
pub enum WatchdogPolicy {
    /// 始终启用（如 git：全程几乎都在等网络）。
    Always,
    /// 直到某条日志包含 `marker` 才解除（如 npm/pip 的下载完成标志）。
    UntilMarker(String),
}

/// 转发子进程输出并执行活动看门狗。
///
/// - 5 秒轮询一次事件
/// - 每次 Heartbeat/Line 刷新活动计时
/// - 若看门狗启用且"距上次活动 ≥ activity_timeout_secs"→ kill 子进程（进程树）
/// - **2026-08-23 A4/A5/B6 进度分桶**：对 Progress 事件做百分比过滤，
///   每跨 `progress_bucket` 个百分比才转发一条（默认 10%），避免刷屏
///
/// # 参数
/// - `output_buf`: 可选，非 None 时把每条 Line 追加进去（供 npm/pip 做网络错误判定）
/// - `progress_bucket`: 进度分桶阈值（0 = 禁用过滤，全部转发）
///
/// # 返回
/// - `true`：两条管道均正常 EOF（进程正常结束）
/// - `false`：检测到挂死，已 kill（**未 wait**，由调用方负责 wait 拿到退出码）
///
/// 注意：kill 用 `taskkill /T /F`（Windows）杀整棵进程树，确保 `cmd → node` 这类
/// 包装进程被一并终止。
pub fn pump_child_output(
    child: &mut std::process::Child,
    rx: mpsc::Receiver<StreamEvent>,
    log_fn: &dyn Fn(&str),
    progress_fn: Option<&dyn Fn(&str)>,
    activity_timeout_secs: u64,
    policy: WatchdogPolicy,
    output_buf: Option<&mut String>,
) -> bool {
    pump_child_output_with_bucket(child, rx, log_fn, progress_fn, activity_timeout_secs, policy, output_buf, 10)
}

/// 带进度分桶参数的版本。
///
/// # 参数
/// - `progress_bucket`: 进度分桶阈值（0 = 禁用过滤，全部转发；5 = 每 5% 转发一次；10 = 每 10% 转发一次）
pub fn pump_child_output_with_bucket(
    child: &mut std::process::Child,
    rx: mpsc::Receiver<StreamEvent>,
    log_fn: &dyn Fn(&str),
    progress_fn: Option<&dyn Fn(&str)>,
    activity_timeout_secs: u64,
    policy: WatchdogPolicy,
    output_buf: Option<&mut String>,
    progress_bucket: u32,
) -> bool {
    let mut last_activity = Instant::now();
    let mut armed = true;
    let marker = match &policy {
        WatchdogPolicy::Always => None,
        WatchdogPolicy::UntilMarker(m) => Some(m.clone()),
    };
    // 循环内复用 &mut 借用（Option<&mut String> 不能每轮都 move）
    let mut output_ref = output_buf;
    // A4: 进度分桶状态（git 用）
    let mut last_sent_pct: u32 = 0;
    let mut current_phase: String = String::new();

    loop {
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(StreamEvent::Heartbeat) => {
                last_activity = Instant::now();
            }
            Ok(StreamEvent::Line(line)) => {
                last_activity = Instant::now();
                // 检查解除标志
                if let Some(m) = &marker {
                    if line.contains(m.as_str()) {
                        armed = false;
                    }
                }
                if let Some(buf) = output_ref.as_mut() {
                    buf.push_str(&line);
                    buf.push('\n');
                }
                // A4: git 进度行（"Updating files: 100% (3020/3020), done."）由 Progress
                // 分桶器负责 10/20/...% 的中间态。这里只在「该阶段尚未被 Progress 跟踪」
                // 时放行最终态（如换阶段后第一行的 100% done），避免重复刷屏。
                if let Some((lp, _)) = parse_git_progress(&line) {
                    if lp == current_phase && last_sent_pct > 0 {
                        continue;
                    }
                }
                // 2026-08-23: 过滤 remote: 进度行（git 远程服务器进度，噪音）
                if line.contains("remote: ") || line.contains("[git] remote: ") {
                    continue;
                }
                log_fn(&line);
            }
            // A4: git 进度分桶过滤（Progress 事件 = \r 进度条的中间段）
            Ok(StreamEvent::Progress(msg)) => {
                last_activity = Instant::now();
                // 2026-08-23 修复：过滤 remote: 进度行（Progress 事件也要过滤）
                if msg.contains("remote: ") || msg.contains("[git] remote: ") {
                    continue;
                }
                // 尝试提取百分比和阶段
                if let Some((phase, pct)) = parse_git_progress(&msg) {
                    // 阶段变化时重置
                    if phase != current_phase {
                        current_phase = phase.clone();
                        last_sent_pct = 0;
                    }
                    // 分桶：只转发跨 bucket 的进度（95% 起封顶，避免 95/96/97/98/99 连发）
                    // 2026-08-23 修复：加 || pct == 100，确保 100% 总是显示
                    let bucket_reached = pct >= last_sent_pct + progress_bucket;
                    if progress_bucket == 0 || bucket_reached || (pct >= 95 && last_sent_pct < 95) || pct == 100 {
                        let translated = translate_git_progress(&current_phase, pct);
                        log_fn(&translated);
                        let _ = send_progress(progress_fn, &translated);
                        last_sent_pct = pct;
                    }
                } else {
                    // 无法解析百分比 → 原样转发（如 "Enumerating objects..." 等）
                    let _ = send_progress(progress_fn, &msg);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if armed && last_activity.elapsed() >= Duration::from_secs(activity_timeout_secs) {
                    // 挂死：kill 进程树（不 wait，交给调用方）
                    let pid = child.id();
                    #[cfg(windows)]
                    {
                        let _ = std::process::Command::new("taskkill")
                            .args(["/T", "/F", "/PID", &pid.to_string()])
                            .output();
                    }
                    #[cfg(unix)]
                    {
                        let _ = std::process::Command::new("kill")
                            .args(["-9", &pid.to_string()])
                            .output();
                    }
                    return false;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // 两个读线程都退出（EOF）= 进程正常结束
                return true;
            }
        }
    }
}

/// 从 git 进度消息中提取阶段名和百分比。
///
/// git 进度格式示例：
/// - "Receiving objects: 56% (1200/3020)"
/// - "Updating files:  62% (1875/3020)"
///
/// 返回 (阶段名, 百分比)。无法解析时返回 None。
pub fn parse_git_progress(msg: &str) -> Option<(String, u32)> {
    // 查找 "XXX: YY%" 模式（支持 1 位或 2 位百分比）
    let percent_pos = msg.find("%")?;
    let before_pct = &msg[..percent_pos];

    // 从右向左收集连续数字（支持 1-3 位百分比）
    let mut digits_end = percent_pos;
    let mut digits_start = percent_pos;
    while digits_start > 0
        && before_pct[digits_start - 1..digits_start]
            .chars()
            .next()
            .unwrap()
            .is_ascii_digit()
    {
        digits_start -= 1;
    }
    if digits_start == digits_end {
        return None; // 没有数字
    }
    let percent_num: u32 = before_pct[digits_start..digits_end].parse().ok()?;

    // 阶段名 = 数字前的 "XXX:" 部分
    let colon_pos = before_pct[..digits_start].rfind(':')?;
    let phase = before_pct[..colon_pos].trim().to_string();

    // 2026-08-23 修复：跳过 "remote: Counting objects" / "remote: Compressing objects"
    // 这些是 git 远程服务器的进度，不是本地进度，对用户无意义，且会产生
    // "[git] [git] remote: ..." 双前缀噪音行
    // 注意：parse 出的 phase 可能带前缀（如 "[git] remote"），所以检查 endswith
    if phase.ends_with("remote") {
        return None;
    }

    Some((phase, percent_num))
}

/// 检查一行是否是 git 进度行（含百分比）
pub fn parse_git_progress_pct(line: &str) -> Option<u32> {
    parse_git_progress(line).map(|(_, pct)| pct)
}

/// 将 git 进度翻译为中文显示
///
/// git 阶段名 → 中文：
/// - "Receiving objects" → "接收对象"
/// - "Updating files" → "更新文件"
/// - "Resolving deltas" → "解析增量"
pub fn translate_git_progress(phase: &str, pct: u32) -> String {
    let phase_cn = if phase.contains("Receiving") {
        "接收对象"
    } else if phase.contains("Updating") {
        "更新文件"
    } else if phase.contains("Resolving") {
        "解析增量"
    } else {
        return format!("[git] {} {}%", phase, pct);
    };
    format!("[git] {} {}%", phase_cn, pct)
}

/// 发送进度事件（优先用 progress_fn，否则用全局 TUI 函数）
fn send_progress(progress_fn: Option<&dyn Fn(&str)>, msg: &str) {
    if let Some(fn_) = progress_fn {
        fn_(msg);
    } else {
        call_tui_progress_fn(msg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TUI 假进度修复：git 进度条（\r 串联）应只保留最后一段（最终态）。
    #[test]
    fn normalize_cr_collapse_progress_bar() {
        // 模拟 git 的 Receiving objects 进度条：102 个 \r 段挤在一行
        let raw = (0..100)
            .map(|i| format!("Receiving objects: {}% (1/3020)", i))
            .collect::<Vec<_>>()
            .join("\r");
        let out = normalize_cr(&raw);
        // 应只剩最后一段（99%），不含前段的 0%
        assert!(out.contains("99%"), "got: {}", out);
        assert!(!out.contains("Receiving objects: 0%"), "got: {}", out);
        assert!(out.chars().filter(|c| *c == '\r').count() == 0);
    }

    /// 普通日志行（无 \r）应原样保留。
    #[test]
    fn normalize_cr_plain_line_unchanged() {
        assert_eq!(normalize_cr("[git] clone 完成"), "[git] clone 完成");
    }

    /// 看门狗：子进程挂死（无输出）时应在超时时 kill，返回 false。
    #[test]
    #[ignore = "需真实进程与 taskkill，CI 跳过"]
    fn watchdog_kills_hung_process() {
        // 起一个会一直阻塞、不输出的进程（ping 不存在的地址）
        let mut child = std::process::Command::new("ping")
            .args(["-n", "3600", "10.255.255.1"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn");
        let (tx, rx) = mpsc::channel::<StreamEvent>();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        spawn_pipe_reader(stdout, tx.clone(), "[t]", false);
        spawn_pipe_reader(stderr, tx, "[t]", false);
        // 1 秒超时会很快触发（测试用短超时）
        let res = pump_child_output(&mut child, rx, &|_| {}, None, 1, WatchdogPolicy::Always, None);
        let _ = child.wait();
        assert!(!res, "看门狗应检测到挂死并 kill");
    }
}
