//! 日志路由：所有日志实时写入**当前阶段日志文件**（01_prepare ~ 07_scripts，分段存储）。
//! 安装结束后由 `merge_full_log` 把 01~07 分段按顺序拼接为 `00_full_log.txt`（全量日志）。
//!
//! 设计原则：**单路实时写（分段）**，全量日志"事后合并"生成。
//! 全量日志不再有任何实时写入方，从结构上消除了多路并发 append 同一个文件
//! 造成的双写 / 块状重复 / 体积膨胀问题。
//!
//! 日志目录 Install_log 建在 exe 同级目录（与 DL_runtimes 一致）。
//! 阶段切换由 installer/mod.rs 在阶段进入/离开时调用 set_stage_log 完成。
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};

static CURRENT_STAGE_LOG: OnceLock<Arc<Mutex<Option<PathBuf>>>> = OnceLock::new();
// 本进程是否已执行过"首次初始化"（清空旧日志）。
// 之后再次调用 init_log_dir 只保证目录存在（幂等），
// 避免同进程内多次调用（如 TUI start_real_install 与 run_installation 各一次）
// 二次清空已写入的日志。
static INIT_DONE: AtomicBool = AtomicBool::new(false);

fn get_mutex() -> Arc<Mutex<Option<PathBuf>>> {
    CURRENT_STAGE_LOG
        .get_or_init(|| Arc::new(Mutex::new(None)))
        .clone()
}

/// 初始化日志目录（进程内幂等）：
/// 1. 在 exe 同级创建 Install_log 目录（失败时回退到 install_path 下）
/// 2. 仅本进程**首次**调用时清空旧日志（每次安装从干净状态开始）；
///    同进程后续调用不再清空，只确保目录存在。
/// 返回最终使用的日志目录路径。
pub fn init_log_dir(install_path: &Path) -> PathBuf {
    let log_dir = resolve_log_dir(install_path);
    if !INIT_DONE.swap(true, Ordering::SeqCst) {
        // 仅首次：清空旧日志
        if log_dir.exists() {
            let _ = std::fs::remove_dir_all(&log_dir);
        }
        if std::fs::create_dir_all(&log_dir).is_ok() {
            log_dir
        } else {
            // 极端情况：两处都建不了目录，返回 exe 同级路径（后续写入会静默失败）
            PathBuf::from(crate::mirrors::config::get_exe_dir()).join("Install_log")
        }
    } else {
        // 非首次：确保目录存在（不清空）
        let _ = std::fs::create_dir_all(&log_dir);
        log_dir
    }
}

/// 日志目录定位：优先 exe 同级，不可写时回退到安装目标目录
fn resolve_log_dir(install_path: &Path) -> PathBuf {
    let exe_dir = crate::mirrors::config::get_exe_dir();
    let candidate = exe_dir.join("Install_log");
    if create_dir_or_check_writable(&candidate) {
        return candidate;
    }
    let fallback = install_path.join("Install_log");
    let _ = std::fs::create_dir_all(&fallback);
    fallback
}

/// 尝试创建目录并验证可写；已存在时验证可写性
fn create_dir_or_check_writable(path: &Path) -> bool {
    if let Err(_) = std::fs::create_dir_all(path) {
        return false;
    }
    let probe = path.join(".write_probe");
    if std::fs::write(&probe, b"ok").is_ok() {
        let _ = std::fs::remove_file(&probe);
        true
    } else {
        false
    }
}

/// 设置当前阶段日志文件路径（由 installer/mod.rs 在阶段切换时调用）
pub fn set_stage_log(path: Option<PathBuf>) {
    let mutex = get_mutex();
    let _ = mutex.lock().map(|mut g| *g = path);
}

/// 附加日志到当前阶段文件（实时、单路；不写全量日志）
/// 全量日志 00_full_log.txt 由安装结束后的 merge_full_log 合并生成。
pub fn append_log(message: &str) {
    let mutex = get_mutex();
    let guard = match mutex.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(p) = guard.as_ref() {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
        {
            let _ = f.write_all(format!("{}\n", message).as_bytes());
        }
    }
}

/// 返回当前日志目录路径（供 env_log 等模块获取 "日志目录" 信息）
pub fn get_log_dir() -> PathBuf {
    crate::mirrors::config::get_exe_dir().join("Install_log")
}

/// 分段日志文件名（按时间顺序），merge_full_log 按此顺序拼接
const STAGE_FILES: [&str; 9] = [
    "01_prepare.log",
    "02_site_test.log",
    "03_runtime.log",
    "04_msvc.log",
    "05_vcptoolbox.log",
    "06_vcpchat.log",
    "07_backupdev.log",
    "08_distserver.log",
    "09_scripts.log",
];

/// 把 01~07 分段日志按文件名顺序拼接成 00_full_log.txt（覆盖写）。
/// 在安装结束后（write_install_summary 末尾）调用：此时所有阶段 guard 已 drop、
/// 分段文件已写完，拼接顺序 = 时间顺序，单线程纯拼接、无并发写入。
/// 若没有任何分段内容（极端早退），则不写全量日志。
pub fn merge_full_log(log_dir: &Path) {
    let mut out = String::new();
    for name in STAGE_FILES {
        let p = log_dir.join(name);
        if let Ok(content) = std::fs::read_to_string(&p) {
            if !content.is_empty() {
                if !content.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(&content);
            }
        }
    }
    if out.is_empty() {
        return;
    }
    let full = log_dir.join("00_full_log.txt");
    let _ = std::fs::write(&full, out);
}

/// 辅助函数：先写阶段日志，再发送 ProgressEvent::Log（async 版本）
pub async fn send_log_event(
    tx: &tokio::sync::mpsc::Sender<crate::app::ProgressEvent>,
    msg: impl Into<String>,
) {
    let s = msg.into();
    append_log(&s);
    let _ = tx.send(crate::app::ProgressEvent::Log(s)).await;
}

/// 辅助函数：同步版本（用于 spawn_blocking 上下文）
pub fn send_log_event_sync(
    tx: &tokio::sync::mpsc::Sender<crate::app::ProgressEvent>,
    msg: String,
) {
    append_log(&msg);
    let _ = tx.blocking_send(crate::app::ProgressEvent::Log(msg));
}

/// 辅助函数：TUI 专用（只发 ProgressEvent::Log，不写文件）
/// 用于 Progress 事件：中间进度段实时滚动到 TUI，但不污染日志文件。
/// 日志文件只记录 normalize_cr 后的最终态（由 send_log_event_sync 写入）。
pub fn send_log_tui_only(
    tx: &tokio::sync::mpsc::Sender<crate::app::ProgressEvent>,
    msg: String,
) {
    let _ = tx.blocking_send(crate::app::ProgressEvent::Log(msg));
}
