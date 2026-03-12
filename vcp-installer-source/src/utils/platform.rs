use std::path::{Path, PathBuf};
use sysinfo::Disks;

/// 获取系统版本字符串
pub fn get_os_version() -> String {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        use winreg::RegKey;

        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        if let Ok(key) = hklm.open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion") {
            let product: String = key
                .get_value("ProductName")
                .unwrap_or_else(|_| "Windows".to_string());
            let build: String = key
                .get_value("CurrentBuildNumber")
                .unwrap_or_else(|_| "未知".to_string());

            // Windows 11的ProductName注册表仍写着Windows 10，需用Build号判断
            let display_product = if build.parse::<u32>().unwrap_or(0) >= 22000 {
                product.replace("Windows 10", "Windows 11")
            } else {
                product
            };

            return format!("{display_product} (Build {build})");
        }

        "Windows (版本未知)".to_string()
    }

    #[cfg(not(windows))]
    {
        let info = os_info::get();
        format!("{} {}", info.os_type(), info.version())
    }
}

/// 检查指定路径所在磁盘的可用空间（GB）
pub fn get_available_disk_space_gb(path: &Path) -> f64 {
    let resolved = resolve_path_no_unc(path);

    let disks = Disks::new_with_refreshed_list();

    let best_match = disks
        .list()
        .iter()
        .filter(|disk| resolved.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().to_string_lossy().len());

    best_match
        .map(|disk| disk.available_space() as f64 / 1_073_741_824.0)
        .unwrap_or(0.0)
}

/// 解析路径，去除Windows的 \\?\ UNC前缀
fn resolve_path_no_unc(path: &Path) -> PathBuf {
    // 先尝试canonicalize获取绝对路径
    let abs_path = path
        .canonicalize()
        .or_else(|_| {
            // 路径不存在时，尝试其父目录
            path.parent()
                .and_then(|p| p.canonicalize().ok())
                .ok_or(std::io::Error::new(std::io::ErrorKind::NotFound, "no parent"))
        })
        .or_else(|_| std::env::current_dir())
        .unwrap_or_else(|_| PathBuf::from("C:\\"));

    strip_unc_prefix(&abs_path)
}

/// 去除 \\?\ 前缀
fn strip_unc_prefix(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if s.starts_with("\\\\?\\") {
        PathBuf::from(&s[4..])
    } else {
        path.to_path_buf()
    }
}

/// 检查当前程序是否构建为 64 位
pub fn is_64bit() -> bool {
    cfg!(target_arch = "x86_64")
}