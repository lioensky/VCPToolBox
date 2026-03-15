use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use anyhow::{bail, Context, Result};

/// 探测 vcvarsall.bat 的路径。
fn find_vcvarsall() -> Option<PathBuf> {
    let candidates = [
        r"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat",
        r"C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat",
        r"C:\Program Files (x86)\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat",
        r"C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat",
    ];
    candidates
        .iter()
        .map(Path::new)
        .find(|p| p.exists())
        .map(|p| p.to_path_buf())
}

/// 探测 Windows SDK 的 um\x64 目录，要求 delayimp.lib 真实存在。
fn find_windows_sdk_lib_path() -> Option<String> {
    let kits_root = Path::new(r"C:\Program Files (x86)\Windows Kits\10\Lib");
    if !kits_root.exists() {
        return None;
    }
    let mut versions: Vec<String> = std::fs::read_dir(kits_root)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("10."))
        .collect();
    versions.sort();
    for version in versions.iter().rev() {
        let um_x64 = kits_root.join(version).join("um").join("x64");
        if um_x64.join("delayimp.lib").exists() {
            return Some(um_x64.to_string_lossy().to_string());
        }
    }
    None
}

/// 探测 Windows SDK 的 ucrt\x64 目录。
fn find_sdk_ucrt_path() -> Option<String> {
    let kits_root = Path::new(r"C:\Program Files (x86)\Windows Kits\10\Lib");
    if !kits_root.exists() {
        return None;
    }
    let mut versions: Vec<String> = std::fs::read_dir(kits_root)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("10."))
        .collect();
    versions.sort();
    let latest = versions.last()?.clone();
    let ucrt_x64 = kits_root.join(&latest).join("ucrt").join("x64");
    if ucrt_x64.exists() {
        Some(ucrt_x64.to_string_lossy().to_string())
    } else {
        None
    }
}

/// 探测 MSVC 的 lib 目录绝对路径。
fn find_msvc_lib_path() -> Option<String> {
    let msvc_root = Path::new(
        r"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC",
    );
    if !msvc_root.exists() {
        return None;
    }
    let mut versions: Vec<String> = std::fs::read_dir(msvc_root)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.chars().next().map_or(false, |c| c.is_ascii_digit()))
        .collect();
    versions.sort();
    let latest = versions.last()?.clone();
    let lib_x64 = msvc_root.join(&latest).join("lib").join("x64");
    if lib_x64.exists() {
        Some(lib_x64.to_string_lossy().to_string())
    } else {
        None
    }
}

/// 在指定目录执行 npm install（实时输出日志）。
pub fn npm_install(
    node_dir: &Path,
    project_dir: &Path,
    env_path: &str,
    use_mirror: bool,
    log_fn: &dyn Fn(&str),
) -> Result<()> {
    let package_json = project_dir.join("package.json");
    if !package_json.exists() {
        bail!("未找到 package.json: {}", package_json.display());
    }

    let node_exe = node_executable(node_dir);
    if !node_exe.exists() {
        bail!("未找到 node 可执行文件: {}", node_exe.display());
    }

    // 双保险：Directory.Build.targets
    write_build_targets(project_dir);

    let npm_exe = npm_executable(node_dir);
    if !npm_exe.exists() {
        bail!("未找到 npm 入口文件: {}", npm_exe.display());
    }

    let vcvarsall = find_vcvarsall();
    let mut install_args = vec!["install".to_string()];
    if use_mirror {
        install_args.push("--registry=https://registry.npmmirror.com".to_string());
    }

    log_fn(&format!("[npm] install ({})", project_dir.display()));

    let mut cmd = build_npm_command(&npm_exe, &install_args, vcvarsall.as_deref(), project_dir);
    apply_npm_env(&mut cmd, project_dir, env_path, &node_exe);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .with_context(|| format!("启动 npm install 失败: {}", project_dir.display()))?;

    stream_npm_output(&mut child, log_fn);

    let status = child.wait().with_context(|| "等待 npm install 完成失败")?;
    if !status.success() {
        bail!("npm install 失败 (exit code: {:?})", status.code());
    }

    // 清理临时 bat
    let bat_path = project_dir.join("_vcp_npm_build.bat");
    let _ = std::fs::remove_file(&bat_path);

    log_fn("[npm] install 完成");
    Ok(())
}

/// 在指定目录执行 npm start。
pub fn npm_start(
    node_dir: &Path,
    project_dir: &Path,
    env_path: &str,
) -> Result<Child> {
    let package_json = project_dir.join("package.json");
    if !package_json.exists() {
        bail!("未找到 package.json: {}", package_json.display());
    }

    let node_exe = node_executable(node_dir);
    if !node_exe.exists() {
        bail!("未找到 node 可执行文件: {}", node_exe.display());
    }

    let npm_exe = npm_executable(node_dir);
    if !npm_exe.exists() {
        bail!("未找到 npm 入口文件: {}", npm_exe.display());
    }

    let vcvarsall = find_vcvarsall();
    let mut cmd = build_npm_command(&npm_exe, &["start".to_string()], vcvarsall.as_deref(), project_dir);
    apply_npm_env(&mut cmd, project_dir, env_path, &node_exe);

    cmd.spawn()
        .with_context(|| format!("启动 npm start 失败: {}", project_dir.display()))
}

fn build_npm_command(
    npm_exe: &Path,
    args: &[String],
    vcvarsall: Option<&Path>,
    project_dir: &Path,
) -> Command {
    if cfg!(windows) {
        match vcvarsall {
            Some(vcvarsall_path) => {
                let npm_args = args.join(" ");
                let bat_content = format!(
                    "@echo off\r\ncall \"{}\" x64 >nul 2>&1\r\nif errorlevel 1 (\r\n  echo [WARN] vcvarsall.bat failed, continuing without VS env\r\n)\r\n\"{}\" {}\r\n",
                    vcvarsall_path.display(),
                    npm_exe.display(),
                    npm_args
                );
                let bat_path = project_dir.join("_vcp_npm_build.bat");
                let _ = std::fs::write(&bat_path, &bat_content);

                let mut cmd = Command::new("cmd");
                cmd.arg("/C").arg(&bat_path);
                cmd
            }
            None => {
                let mut cmd = Command::new("cmd");
                cmd.arg("/C").arg(npm_exe);
                for arg in args {
                    cmd.arg(arg);
                }
                cmd
            }
        }
    } else {
        let mut cmd = Command::new(npm_exe);
        for arg in args {
            cmd.arg(arg);
        }
        cmd
    }
}

fn write_build_targets(project_dir: &Path) {
    let mut lib_dirs: Vec<String> = Vec::new();
    if let Some(sdk_um) = find_windows_sdk_lib_path() {
        lib_dirs.push(sdk_um);
    }
    if let Some(sdk_ucrt) = find_sdk_ucrt_path() {
        lib_dirs.push(sdk_ucrt);
    }
    if let Some(msvc_lib) = find_msvc_lib_path() {
        lib_dirs.push(msvc_lib);
    }

    let targets_content = if lib_dirs.is_empty() {
        r#"<Project>
  <PropertyGroup>
    <SpectreMitigation>false</SpectreMitigation>
  </PropertyGroup>
</Project>"#
            .to_string()
    } else {
        let lib_entry = lib_dirs.join(";");
        format!(
            r#"<Project>
  <PropertyGroup>
    <SpectreMitigation>false</SpectreMitigation>
  </PropertyGroup>
  <ItemDefinitionGroup>
    <Link>
      <AdditionalLibraryDirectories>{};%(AdditionalLibraryDirectories)</AdditionalLibraryDirectories>
    </Link>
  </ItemDefinitionGroup>
</Project>"#,
            lib_entry
        )
    };

    let targets_path = project_dir.join("Directory.Build.targets");
    let _ = std::fs::write(&targets_path, &targets_content);

    let nm_targets = project_dir.join("node_modules").join("Directory.Build.targets");
    if project_dir.join("node_modules").exists() {
        let _ = std::fs::write(&nm_targets, &targets_content);
    }
}

fn apply_npm_env(cmd: &mut Command, project_dir: &Path, env_path: &str, node_exe: &Path) {
    cmd.current_dir(project_dir)
        .env("NODE", node_exe)
        .env("PATH", env_path)
        .env("npm_config_fund", "false")
        .env("npm_config_audit", "false")
        .env(
            "npm_config_better_sqlite3_binary_host",
            "https://registry.npmmirror.com/-/binary/better-sqlite3",
        )
        .env("GYP_MSVS_VERSION", "2022")
        .env("SpectreMitigation", "false")
        .env(
            "ELECTRON_MIRROR",
            "https://registry.npmmirror.com/-/binary/electron/",
        )
        .env(
            "ELECTRON_BUILDER_BINARIES_MIRROR",
            "https://registry.npmmirror.com/-/binary/electron-builder-binaries/",
        );

    let mut lib_paths: Vec<String> = Vec::new();
    if let Some(sdk_lib) = find_windows_sdk_lib_path() {
        lib_paths.push(sdk_lib);
    }
    if let Some(ucrt_lib) = find_sdk_ucrt_path() {
        lib_paths.push(ucrt_lib);
    }
    if let Some(msvc_lib) = find_msvc_lib_path() {
        lib_paths.push(msvc_lib);
    }
    if !lib_paths.is_empty() {
        if let Ok(existing_lib) = std::env::var("LIB") {
            lib_paths.push(existing_lib);
        }
        cmd.env("LIB", lib_paths.join(";"));
    }
}

fn npm_executable(node_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        node_dir.join("npm.cmd")
    } else {
        node_dir.join("bin").join("npm")
    }
}

fn node_executable(node_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        node_dir.join("node.exe")
    } else {
        node_dir.join("bin").join("node")
    }
}

/// 实时读取 npm 子进程的 stdout 和 stderr。
fn stream_npm_output(child: &mut std::process::Child, log_fn: &dyn Fn(&str)) {
    // npm 主要输出在 stderr（warn/error），也有 stdout
    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(line) = line {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    log_fn(&format!("[npm] {}", trimmed));
                }
            }
        }
    }

    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(line) = line {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    log_fn(&format!("[npm] {}", trimmed));
                }
            }
        }
    }
}