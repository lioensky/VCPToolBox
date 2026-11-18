//! 工具函数模块

pub mod platform;
pub mod env;
pub mod network;

/// 将路径中的正斜杠统一为 Windows 原生反斜杠。
///
/// 用于日志显示和路径拼接的入口点，避免混用 `/` 和 `\`。
/// 本程序仅运行于 Windows，无需跨平台分支。
///
/// 例: "D:/Desktop/foo" → "D:\Desktop\foo"；已是 `\` 的路径不变。
pub fn normalize_path_display(path: &str) -> String {
    path.replace('/', "\\")
}

/// 去掉 Windows 长路径前缀 `\\?\`。
///
/// `std::fs::canonicalize` 对绝对路径会返回 `\\?\C:\...` 形式的扩展前缀，
/// 部分子进程工具（npm/better-sqlite3 等）不识别该前缀，会导致
/// "系统找不到指定的路径"。此函数把前缀去掉，保留标准 Windows 路径。
///
/// 例: "\\?\D:\Desktop\foo" → "D:\Desktop\foo"；无前缀的路径原样返回。
pub fn strip_extended_prefix(path: &std::path::Path) -> std::path::PathBuf {
    let s = path.to_string_lossy();
    // Windows 长路径前缀为字面 4 字符：反斜杠 反斜杠 ? 反斜杠
    // 用 chars 判断，避免字符串转义歧义
    let chars: Vec<char> = s.chars().collect();
    if chars.len() >= 4
        && chars[0] == '\\'
        && chars[1] == '\\'
        && chars[2] == '?'
        && chars[3] == '\\'
    {
        std::path::PathBuf::from(chars[4..].iter().collect::<String>())
    } else {
        path.to_path_buf()
    }
}

/// 格式化文件大小为人类可读格式（B / KB / MB / GB）
/// 自动选择合适单位，避免小文件显示 "0.0 MB"
///
/// Examples:
/// ```
/// format_file_size(500)      -> "500 B"
/// format_file_size(10_240)   -> "10.0 KB"
/// format_file_size(174_000_000) -> "174.0 MB"
/// ```
pub fn format_file_size(bytes: u64) -> String {
    match bytes {
        0..=999 => format!("{} B", bytes),
        1_000..=999_999 => format!("{:.1} KB", bytes as f64 / 1024.0),
        1_000_000..=999_999_999 => format!("{:.1} MB", bytes as f64 / 1_048_576.0),
        _ => format!("{:.1} GB", bytes as f64 / 1_073_741_824.0),
    }
}

/// 格式化文件下载进度
pub fn format_progress(downloaded: u64, total: u64) -> String {
    let pct = if total > 0 {
        (downloaded as f64 / total as f64) * 100.0
    } else {
        0.0
    };
    format!(
        "{:.0}% ({}/{} )",
        pct,
        format_file_size(downloaded),
        format_file_size(total)
    )
}
