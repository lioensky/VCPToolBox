//! 环境检测日志模块
//!
//! TUI/Headless 都调用此模块生成 01_prepare.log，保证内容一致。
use crate::app::{DependencyStatus, EnvCheckResult};

/// 写入完整的准备阶段日志（01_prepare.log）
///
/// TUI/Headless 都调用此函数，通过 StageGuard::Prepare 包裹，
/// 保证 [START]/[END] 正确闭合。
///
/// Parameters:
/// - env_check: 环境检测结果
/// - github_mirror: GitHub 镜像配置
/// - pip_source_ok: pip 源是否可达
pub fn write_prepare_log(env_check: &EnvCheckResult, pip_source_ok: bool) {
    use crate::log_router::append_log;

    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

    append_log(&format!(
        "================================================================================\n[START] 准备阶段（环境检测） | {}\n================================================================================",
        ts
    ));

    append_log(&format!("=== VCP Installer 开始 | {} ===", ts));
    append_log(&format!("日志目录: {}", crate::log_router::get_log_dir().display()));
    append_log(&format!("系统: {}", env_check.os_version));
    append_log(&format!("CPU: {}", env_check.cpu_name));
    append_log(&format!("内存: {:.1} GB", env_check.total_memory_gb));
    append_log(&format!("显卡: {}", env_check.gpu_name));
    append_log(&format!("系统 Git: {:?}", env_check.git));
    append_log(&format!("系统 Node.js: {:?}", env_check.node));
    append_log(&format!("系统 Python: {:?}", env_check.python));
    append_log(&format!("系统 MSVC: {:?}", env_check.msvc));
    append_log(&format!(
        "磁盘可用: {:.1}GB (OK={})",
        env_check.disk_space_gb, env_check.disk_space_ok
    ));

    let gh_label = if env_check.network_github { "[YES]" } else { "[NO ]" };
    let gh_state = if env_check.network_github { "可达" } else { "不可达" };
    append_log(&format!("{} GitHub 官方源，{}。", gh_label, gh_state));

    let npm_label = if env_check.network_npm { "[YES]" } else { "[NO ]" };
    let npm_state = if env_check.network_npm { "可达" } else { "不可达" };
    append_log(&format!("{} NPM   官方源，{}。", npm_label, npm_state));

    let pip_label = if pip_source_ok { "[YES]" } else { "[NO ]" };
    let pip_state = if pip_source_ok { "可达" } else { "不可达" };
    append_log(&format!("{} PIP   官方源，{}。", pip_label, pip_state));

    let msvc_label = if matches!(env_check.msvc, DependencyStatus::Installed(_)) {
        "[YES]"
    } else {
        "[NO ]"
    };
    let msvc_state = if matches!(env_check.msvc, DependencyStatus::Installed(_)) {
        "已安装"
    } else {
        "未安装"
    };
    append_log(&format!("{} MSVC  官方源，{}。", msvc_label, msvc_state));

    // 写 [END] —— StageGuard::enter_quiet 不写自己的标记，这里收尾
    let end_ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    append_log(&format!(
        "[END] 准备阶段（环境检测） | SUCCESS | {} | 耗时 0 秒\n================================================================================",
        end_ts
    ));
}
