use std::{
    path::Path,
    process::Command,
    time::Duration,
};

use crate::app::{DependencyStatus, EnvCheckResult};
use which::which;

/// 检测单个工具是否已安装（系统PATH优先，回退到portable目录）
pub fn detect_tool(_name: &str, command: &str, version_flag: &str, install_path: &Path) -> DependencyStatus {
    // 第一层：系统PATH检测
    match which(command) {
        Ok(path) => match Command::new(&path).arg(version_flag).output() {
            Ok(output) => {
                let version = read_output_text(&output.stdout, &output.stderr);
                if version.is_empty() {
                    DependencyStatus::Installed("版本未知".to_string())
                } else {
                    DependencyStatus::Installed(version)
                }
            }
            Err(_) => DependencyStatus::Installed("版本未知".to_string()),
        },
        Err(_) => {
            // 第二层：portable目录回退检测
            let portable_exe = match command {
                "git" => Some(install_path.join("runtimes").join("git").join("cmd").join("git.exe")),
                "node" => Some(install_path.join("runtimes").join("node").join("node.exe")),
                _ => None,
            };
            if let Some(ref exe) = portable_exe {
                if exe.exists() {
                    match Command::new(exe).arg(version_flag).output() {
                        Ok(output) => {
                            let version = read_output_text(&output.stdout, &output.stderr);
                            if version.is_empty() {
                                DependencyStatus::Installed("Portable - 版本未知".to_string())
                            } else {
                                DependencyStatus::Installed(format!("{} (Portable)", version))
                            }
                        }
                        Err(_) => DependencyStatus::Installed("Portable".to_string()),
                    }
                } else {
                    DependencyStatus::NotFound
                }
            } else {
                DependencyStatus::NotFound
            }
        }
    }
}

/// 执行完整的环境检测
pub async fn detect_environment(install_path: &Path) -> EnvCheckResult {
    let git = detect_tool("Git", "git", "--version", install_path);
    let node = detect_tool("Node.js", "node", "--version", install_path);
    let python = detect_python(install_path);
    let msvc = detect_msvc(install_path);

    let disk_space_gb = crate::utils::platform::get_available_disk_space_gb(install_path);
    let os_version = crate::utils::platform::get_os_version();

    let (network_github, network_npm) = tokio::join!(
        check_network("https://github.com"),
        check_network("https://registry.npmjs.org"),
    );

    EnvCheckResult {
        git,
        node,
        python,
        msvc,
        disk_space_gb,
        disk_space_ok: disk_space_gb >= 3.0,
        network_github,
        network_npm,
        os_version,
    }
}

/// MSVC Build Tools 检测：
/// - 第一层：通过 vswhere.exe 查询是否安装了完整 VC++ 编译工具
/// - 第二层：回退检测 portable MSVC（runtimes/msvc/）
fn detect_msvc(install_path: &Path) -> DependencyStatus {
    // 第一层：vswhere 查注册表
    let program_files_x86 = std::env::var("ProgramFiles(x86)")
        .unwrap_or_else(|_| r"C:\Program Files (x86)".to_string());
    let vswhere_path = Path::new(&program_files_x86)
        .join("Microsoft Visual Studio")
        .join("Installer")
        .join("vswhere.exe");

    if vswhere_path.exists() {
        if let Ok(output) = Command::new(&vswhere_path)
            .args([
                "-latest",
                "-products", "*",
                "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
                "-property", "displayName",
            ])
            .output()
        {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !name.is_empty() {
                return DependencyStatus::Installed(name);
            }
        }
    }

    DependencyStatus::NotFound
}

/// Python 检测：
/// - 尝试 python / python3 / py（系统PATH）
/// - 排除 WindowsApps 里的微软商店占位 python
/// - 回退到 portable python
fn detect_python(install_path: &Path) -> DependencyStatus {
    // 第一层：系统PATH检测
    for cmd in ["python", "python3", "py"] {
        let Ok(path) = which(cmd) else {
            continue;
        };

        let lower = path.to_string_lossy().to_lowercase();
        if lower.contains("windowsapps") {
            continue;
        }

        let mut command = Command::new(&path);

        // py 启动器优先尝试 Python 3
        if cmd == "py" {
            command.arg("-3");
        }

        if let Ok(output) = command.arg("--version").output() {
            let version = read_output_text(&output.stdout, &output.stderr);
            if version.starts_with("Python 3.") || version.starts_with("Python 2.") {
                return DependencyStatus::Installed(version);
            }
        }
    }

    // 第二层：portable目录回退检测
    let portable_python = install_path.join("runtimes").join("python").join("python.exe");
    if portable_python.exists() {
        if let Ok(output) = Command::new(&portable_python).arg("--version").output() {
            let version = read_output_text(&output.stdout, &output.stderr);
            if version.starts_with("Python 3.") || version.starts_with("Python 2.") {
                return DependencyStatus::Installed(format!("{} (Portable)", version));
            }
        }
        return DependencyStatus::Installed("Portable".to_string());
    }

    DependencyStatus::NotFound
}

fn read_output_text(stdout: &[u8], stderr: &[u8]) -> String {
    let out = String::from_utf8_lossy(stdout).trim().to_string();
    if !out.is_empty() {
        out
    } else {
        String::from_utf8_lossy(stderr).trim().to_string()
    }
}

/// 简单网络连通性检测
async fn check_network(url: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };

    // 先 HEAD，失败再 GET 兜底（有些站点不友好对 HEAD）
    if let Ok(resp) = client.head(url).send().await {
        if resp.status().is_success() {
            return true;
        }
    }

    match client.get(url).send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}