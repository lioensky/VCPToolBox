use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;

use anyhow::{bail, Context, Result};

use crate::installer::stream_util::WatchdogPolicy;

/// 检测 npm 输出中是否包含网络类瞬时错误（用于决定是否值得重试）。
/// 命中任一错误码即返回 true；其余错误（缺依赖、编译失败等）不重试。
fn is_npm_network_error(output: &str) -> bool {
    const CODES: [&str; 8] = [
        "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED",
        "ENOTFOUND", "ECONNABORTED", "ENETUNREACH", "EPIPE",
    ];
    CODES.iter().any(|c| output.contains(c))
}

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
    // 内层重试(B)：npm 原生 fetch 重试，处理单个包的瞬时断流
    // 配合外层 2 次重试(A)，双层兜底
    install_args.push("--fetch-retries=5".to_string());
    install_args.push("--fetch-retry-mintimeout=3000".to_string());
    install_args.push("--fetch-retry-maxtimeout=30000".to_string());

    log_fn(&format!("[npm] install ({})", project_dir.display()));

    // 外层重试：网络瞬时错误（ECONNRESET/ETIMEDOUT 等）最多重试 2 次（共 3 次尝试）
    // npm install 幂等，重试时已装的包直接跳过，安全
    const MAX_ATTEMPTS: u32 = 3;
    let mut attempt = 1u32;
    loop {
        let mut cmd = build_npm_command(&npm_exe, &install_args, vcvarsall.as_deref(), project_dir);
        apply_npm_env(&mut cmd, project_dir, env_path, &node_exe);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .with_context(|| format!("启动 npm install 失败: {}", project_dir.display()))?;

        let mut output_buf = String::new();
        // B6: npm install 预期下载时长 120s（VCPChat 最长，进度封顶 99%，宁慢勿快跳）
        let clean = stream_npm_output_collect(&mut child, &mut output_buf, log_fn, 120);
        if !clean {
            log_fn("[npm] ! 看门狗检测到挂死（90秒无输出），已终止进程，将重试");
            output_buf.push_str("\n[watchdog] HUNG_PROCESS_KILLED");
        }

        let status = child.wait().with_context(|| "等待 npm install 完成失败")?;
        if status.success() {
            break;
        }

        // 仅网络类瞬时错误或看门狗挂死才重试；其他错误（缺依赖、脚本编译失败）重试无益
        let is_retriable = is_npm_network_error(&output_buf) || output_buf.contains("HUNG_PROCESS_KILLED");
        if attempt < MAX_ATTEMPTS && is_retriable {
            let delay = 3u64 * (attempt as u64);
            log_fn(&format!(
                "[npm] install 遇网络瞬时错误/挂死，{} 秒后重试 ({}/{})...",
                delay, attempt, MAX_ATTEMPTS
            ));
            std::thread::sleep(std::time::Duration::from_secs(delay));
            attempt += 1;
        } else {
            bail!("npm install 失败 (exit code: {:?})", status.code());
        }
    }

    // Node.js 24+ allow-scripts 机制：批准并执行挂起的 install scripts
    approve_npm_scripts(&npm_exe, project_dir, env_path, log_fn)?;

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
                // 2026-08-28 Plan A 修复（v3）：node_dir/install_dir 在 mod.rs 源头已绝对化，
                // 无需在此 canonicalize（canonicalize 在 Windows 上会加 \\?\ 前缀，cmd 不识别）。
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

/// 2026-08-28 Plan A v3: 把路径转换为 cmd/bat 友好的"绝对路径"。
///
/// 背景：
/// - headless 传参可能是相对路径（如 `VCP_AIOS`），导致 bat 内
///   `"VCP_AIOS\runtimes\node\npm.cmd"` 在 cwd=组件目录 下多解析一层失败
/// - 用 `canonicalize` 绝对化时，Windows 上盘符路径会被加上 `\\?\` 前缀，
///   而 cmd 无法识别 `\\?\`，反而引入新的失败
///
/// 策略：
/// 1. 已是绝对路径 → 直接返回（避免 canonicalize 引入 `\\?\`）
/// 2. 相对路径 → current_dir().join(p).canonicalize() → 剥离 `\\?\` 前缀
/// 3. canonicalize 失败（路径不存在）→ 仅 join 不做 canonicalize，保持原行为
pub fn to_command_abs_path(p: PathBuf) -> PathBuf {
    if p.is_absolute() {
        return p;
    }
    let base = match std::env::current_dir() {
        Ok(b) => b,
        Err(_) => return p,
    };
    let joined = base.join(p);
    match joined.canonicalize() {
        Ok(canon) => strip_windows_long_path_prefix(canon),
        Err(_) => joined, // 目录尚不存在时，保留 join 结果（绝对路径）
    }
}

/// 2026-08-28: 剥离 Windows canonicalize 产生的 `\\?\` 长路径前缀。
/// cmd 无法识别 `\\?\` 前缀，bat 内若带该前缀会报"系统找不到指定的路径"。
fn strip_windows_long_path_prefix(p: PathBuf) -> PathBuf {
    if !cfg!(windows) {
        return p;
    }
    if let Some(s) = p.to_str() {
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            // UNC 路径（\\\\server\share）→ 加 ?\\ 前缀会变成 \\?\\?\server\share
            // 正确剥离为 \\server\share
            if stripped.starts_with("\\\\") {
                let mut s: PathBuf = PathBuf::new();
                s.push("\\\\");
                s.push(Path::new(&stripped[2..]));
                return s;
            }
            return PathBuf::from(stripped);
        }
    }
    p
}

/// 2026-08-28 Plan A v3: 便捷包装——to_command_abs_path 的引用版
pub fn to_command_abs_ref(p: &Path) -> PathBuf {
    to_command_abs_path(p.to_path_buf())
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

/// 全局安装 PM2 进程管理器（VCP 后端 PM2 双进程方案需要）
/// 如果 PM2 已安装则跳过。
pub fn npm_install_global_pm2(
    node_dir: &Path,
    env_path: &str,
    log_fn: &dyn Fn(&str),
) -> Result<()> {
    // 检测 PM2 是否已安装（检查 node 全局目录下的 pm2.cmd / pm2）
    let pm2_cmd = if cfg!(windows) {
        node_dir.join("pm2.cmd")
    } else {
        node_dir.join("bin").join("pm2")
    };

    if pm2_cmd.exists() {
        log_fn("[npm] PM2 已安装（portable），跳过");
        return Ok(());
    }

    // 不做命令行兜底检测——系统PATH里的pm2对portable环境没用
    // 必须装到node_dir下，start_server.bat的PATH才能找到

    let npm_exe = npm_executable(node_dir);
    if !npm_exe.exists() {
        bail!("未找到 npm 入口文件: {}", npm_exe.display());
    }

    log_fn("[npm] 正在全局安装 PM2 进程管理器...");

    // 2026-08-22: 加 --registry（npmmirror）+ fetch 重试参数，修复拔线/弱网下
    // npm install -g pm2 走官方源 3x 90s 超时挂死问题。
    // PM2 是 portable 环境依赖（start_server.bat 需要），但非核心 —— 失败仅告警。
    // 2026-08-28 Plan A v3: node_dir 已在 mod.rs 源头绝对化，直接用即可
    let mut cmd = Command::new("cmd");
    cmd.arg("/C")
        .arg(npm_exe)
        .arg("install")
        .arg("-g")
        .arg("--prefix")
        .arg(node_dir.to_string_lossy().as_ref())
        .arg("--registry=https://registry.npmmirror.com")
        .arg("--fetch-retries=5")
        .arg("--fetch-retry-mintimeout=3000")
        .arg("--fetch-retry-maxtimeout=30000")
        .arg("pm2");
    cmd.current_dir(node_dir)
        .env("PATH", env_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .with_context(|| "启动 npm install -g pm2 失败")?;

    // 外层重试：网络瞬时错误/看门狗挂死最多重试 2 次（pm2 install 幂等，已装则快速跳过）
    const MAX_ATTEMPTS: u32 = 3;
    let mut attempt = 1u32;
    loop {
        let mut output_buf = String::new();
        // B6: PM2 包小（~5s），给 30s 预期，进度封顶 99%
        let clean = stream_npm_output_collect(&mut child, &mut output_buf, log_fn, 30);
        if !clean {
            log_fn("[npm] ! PM2 看门狗检测到挂死（90秒无输出），已终止，将重试");
            output_buf.push_str("\n[watchdog] HUNG_PROCESS_KILLED");
        }

        let status = child.wait().with_context(|| "等待 npm install -g pm2 完成失败")?;
        if status.success() {
            log_fn("[npm] PM2 安装完成");
            return Ok(());
        }

        let is_retriable =
            is_npm_network_error(&output_buf) || output_buf.contains("HUNG_PROCESS_KILLED");
        if attempt < MAX_ATTEMPTS && is_retriable {
            let delay = 3u64 * (attempt as u64);
            log_fn(&format!(
                "[npm] PM2 安装遇网络瞬时错误/挂死，{} 秒后重试 ({}/{})...",
                delay, attempt, MAX_ATTEMPTS
            ));
            std::thread::sleep(std::time::Duration::from_secs(delay));
            attempt += 1;

            child = cmd
                .spawn()
                .with_context(|| "重试启动 npm install -g pm2 失败")?;
        } else {
            bail!("npm install -g pm2 失败 (exit code: {:?})", status.code());
        }
    }
}

/// 实时读取 npm 子进程的 stdout 和 stderr，同时收集完整输出文本（供网络错误判定）。
///
/// # 设计
/// - 双线程并发读取 + mpsc 回传（防管道死锁）
/// - 活动看门狗：90 秒无输出（npm 下载阶段）则 kill，交给外层重试
///   - 看门狗在出现 "added N packages"（下载完成）后解除，避免误杀 npm rebuild 的本地编译静默期
/// - 2026-08-23 A2/B6 日志精简：
///   - `npm warn deprecated` 行不逐条刷屏，汇总为一行
///   - 时间估算进度分桶（每 5% 一条），npm 不提供真实百分比，
///     按 elapsed / expected_secs 估算；"added N packages" 出现即 100%
///
/// # 返回
/// - `true`：两管道正常 EOF（进程正常结束）
/// - `false`：看门狗检测到挂死并已 kill（**未 wait**，调用方负责 wait）
fn stream_npm_output_collect(
    child: &mut std::process::Child,
    output_buf: &mut String,
    log_fn: &dyn Fn(&str),
    expected_secs: u64,
) -> bool {
    use std::cell::Cell;

    const ACTIVITY_TIMEOUT_SECS: u64 = 90;

    // A2/B6 状态（用 Cell 包装可变字段，让闭包能实现 Fn 而非 FnMut）
    let deprecated_count: Cell<usize> = Cell::new(0);
    let start = std::time::Instant::now();
    let next_bucket: Cell<u32> = Cell::new(5);
    let download_done: Cell<bool> = Cell::new(false);

    let (tx, rx) = mpsc::channel::<crate::installer::stream_util::StreamEvent>();

    // stderr 读线程
    if let Some(stderr) = child.stderr.take() {
        crate::installer::stream_util::spawn_pipe_reader(stderr, tx.clone(), "[npm]", false);
    }

    // stdout 读线程
    if let Some(stdout) = child.stdout.take() {
        crate::installer::stream_util::spawn_pipe_reader(stdout, tx, "[npm]", false);
    }

    // A2/B6 包装层
    let log_fn_ref: &dyn Fn(&str) = log_fn;
    let filtered_log = |line: &str| {
        if !download_done.get() {
            if line.contains("added ") && line.contains("packages") {
                download_done.set(true);
                log_fn_ref("[npm] 下载进度 100%");
            } else if expected_secs > 0 {
                let elapsed_secs = start.elapsed().as_secs();
                let pct = (elapsed_secs * 100u64)
                    .saturating_div(expected_secs)
                    .min(99) as u32;
                let mut nb = next_bucket.get();
                while nb <= pct {
                    log_fn_ref(&format!("[npm] 下载进度 {}%", nb));
                    nb += 5;
                }
                next_bucket.set(nb);
            }
        }
        if line.contains("npm warn deprecated") {
            deprecated_count.set(deprecated_count.get() + 1);
            return;
        }
        log_fn_ref(line);
    };

    // 父线程：转发 + 活动看门狗
    let result = crate::installer::stream_util::pump_child_output(
        child,
        rx,
        &filtered_log,
        None,
        ACTIVITY_TIMEOUT_SECS,
        WatchdogPolicy::UntilMarker("added ".to_string()),
        Some(output_buf),
    );

    // A2: 汇总输出 deprecated 警告
    if deprecated_count.get() > 0 {
        log_fn(&format!(
            "[npm] {} 条上游包废弃提示（不影响安装）",
            deprecated_count.get()
        ));
    }

    result
}

/// Node.js 24+ allow-scripts 机制：批准所有挂起的 install scripts 并触发执行。
///
/// 两阶段处理：
/// Phase1: `npm approve-scripts --allow-scripts-pending` 列出所有挂起的包
/// Phase2: 对每个挂起的包逐个执行 `npm approve-scripts <pkg>@<version>`
/// Phase3: `npm run-scripts` 触发已批准的脚本执行
///
/// 如果无挂起的脚本，整个流程静默成功。
fn approve_npm_scripts(
    npm_exe: &Path,
    project_dir: &Path,
    env_path: &str,
    log_fn: &dyn Fn(&str),
) -> Result<()> {
    log_fn("[npm] 处理 Node.js 24+ allow-scripts 挂起的 install scripts...");

    // ====== Phase1: 列出挂起的包 ======
    let pending_list = run_npm_command(npm_exe, project_dir, env_path, &[
        "approve-scripts",
        "--allow-scripts-pending",
    ], log_fn);

    // 解析输出，提取挂起的包名（格式：better-sqlite3@12.10.0）
    let pending_packages = parse_pending_packages(&pending_list.stdout);

    if pending_packages.is_empty() {
        log_fn("[npm] 无挂起的 install scripts，跳过");
        return Ok(());
    }

    log_fn(&format!(
        "[npm] Phase1 完成：发现 {} 个挂起的包，开始逐个批准",
        pending_packages.len()
    ));

    // ====== Phase2: 逐个批准 ======
    let mut approved = 0;
    let mut failed = 0;

    for pkg in &pending_packages {
        log_fn(&format!("[npm] Phase2: 批准 {} ...", pkg));

        let pkg_str = pkg.as_str();
        let output = run_npm_command(
            npm_exe,
            project_dir,
            env_path,
            &["approve-scripts", pkg_str],
            log_fn,
        );

        if output.status.success() {
            approved += 1;
        } else {
            failed += 1;
            log_fn(&format!(
                "[npm] Phase2: 批准 {} 失败 (exit {:?})",
                pkg,
                output.status.code()
            ));
        }
    }

    log_fn(&format!(
        "[npm] Phase2 完成：批准 {}/{} 个包（{} 失败）",
        approved,
        approved + failed,
        failed
    ));

    if approved == 0 {
        log_fn("[npm] 所有包批准失败，跳过 npm install");
        return Ok(());
    }

    // ====== Phase3: 触发执行（用 npm rebuild 重新运行已批准包的 install scripts） ======
    // npm approve-scripts 批准后，已安装的包不会重新执行脚本，需要用 npm rebuild 触发
    log_fn("[npm] Phase3: 执行 npm rebuild 以重新运行已批准的 install scripts...");

    let output = run_npm_command(npm_exe, project_dir, env_path, &["rebuild"], log_fn);

    if output.status.success() {
        log_fn("[npm] install scripts 已全部批准并执行完成");
    } else {
        log_fn("[npm] npm rebuild (Phase3) 返回非零退出码（部分脚本可能执行失败，但包已安装）");
    }

    // ====== Phase4（2026-08-22 新增）: 验证关键原生模块是否真正编译成功 ======
    // Node.js 24+ allow-scripts 机制下，install scripts 被挂起批准执行后，
    // 原生模块（如 better-sqlite3 的 .node 文件）需要 rebuild 才会生成。
    // 如果 rebuild 成功但包内没有任何 .node 产物，说明 install scripts 未真正执行——
    // 此时给 CARP 明确提示 + 手动修复命令，避免后端启动时报"模块未找到"却无从排查。
    // 非阻断：这只是诊断提示，不判安装失败（原生模块可后续联网补编译）。
    // 注：.node 产物路径因包而异（better-sqlite3 → build/Release/better_sqlite3.node，
    //     非 <basename>.node 约定），故用"包目录内是否存在任意 .node 文件"判定，不猜具体文件名。
    let node_modules = project_dir.join("node_modules");
    if node_modules.exists() {
        let native_pkgs = scan_native_modules(&node_modules);
        if !native_pkgs.is_empty() {
            log_fn(&format!(
                "[npm] Phase4: 检测到 {} 个原生模块，验证 .node 产物是否生成...",
                native_pkgs.len()
            ));
            let missing: Vec<String> = native_pkgs
                .into_iter()
                .filter(|(_, has_node)| !*has_node)
                .map(|(pkg, _)| pkg)
                .collect();
            if missing.is_empty() {
                log_fn("[npm] Phase4: 所有原生模块均已生成 .node 产物，install scripts 执行成功 ✓");
            } else {
                log_fn(&format!(
                    "[npm] Phase4: 警告：以下原生模块未发现 .node 产物（install scripts 可能未执行）: {}",
                    missing.join(", ")
                ));
                log_fn(&format!(
                    "[npm]       手动修复: cd {} && npm approve-scripts --allow-scripts-pending && npm rebuild",
                    project_dir.display()
                ));
            }
        }
    }

    Ok(())
}

/// 扫描 node_modules 下声明了原生构建的包，返回 (包名, 包内是否存在 .node 产物)。
///
/// 判定依据：
/// - 包目录内存在 binding.gyp → 认定为需要原生编译的包（node-gyp 模块标志）
/// - 递归遍历该包目录，只要找到任意 *.node 文件即视为产物已生成
///   （.node 具体路径因包而异，不依赖命名约定，避免误判）
fn scan_native_modules(node_modules: &Path) -> Vec<(String, bool)> {
    let mut result = Vec::new();
    let entries = match std::fs::read_dir(node_modules) {
        Ok(e) => e,
        Err(_) => return result,
    };
    for entry in entries.flatten() {
        let pkg_dir = entry.path();
        if !pkg_dir.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // 跳过 @scope 目录（scoped 包单独一层处理，VCP 当前无 scoped 原生模块）
        if name.starts_with('@') {
            continue;
        }
        if !pkg_dir.join("binding.gyp").exists() {
            continue;
        }
        let has_node = contains_node_file(&pkg_dir);
        result.push((name.to_string(), has_node));
    }
    result
}

/// 递归判断目录内（含子目录）是否存在任意 *.node 文件。
fn contains_node_file(dir: &Path) -> bool {
    let read_dir = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return false,
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if contains_node_file(&path) {
                return true;
            }
        } else if path.extension().and_then(|e| e.to_str()) == Some("node") {
            return true;
        }
    }
    false
}

/// 执行 npm 命令并返回结构化输出（供 approve-scripts 使用）。
fn run_npm_command(
    npm_exe: &Path,
    project_dir: &Path,
    env_path: &str,
    args: &[&str],
    log_fn: &dyn Fn(&str),
) -> CommandOutput {
    // 2026-08-28 Plan A v3: npm_exe 已在 mod.rs 源头绝对化
    let mut cmd = Command::new("cmd");
    cmd.arg("/C")
        .arg(npm_exe);
    for arg in args {
        cmd.arg(arg);
    }
    cmd.current_dir(project_dir)
        .env("PATH", env_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = cmd.output();

    let (status, stdout, stderr) = match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout).to_string();
            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
            // 输出到日志
            for line in stdout.lines() {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    log_fn(&format!("[npm] {}", trimmed));
                }
            }
            for line in stderr.lines() {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    log_fn(&format!("[npm] {}", trimmed));
                }
            }
            (o.status, stdout, stderr)
        }
        Err(e) => {
            log_fn(&format!("[npm] 执行 npm 命令失败: {}", e));
            return CommandOutput {
                status: std::process::ExitStatus::default(),
                stdout: format!("error: {}", e),
                stderr: String::new(),
            };
        }
    };

    CommandOutput { status, stdout, stderr }
}

struct CommandOutput {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
}

/// 解析 `npm approve-scripts --allow-scripts-pending` 的输出，
/// 提取挂起的包名（格式：better-sqlite3@12.10.0）。
///
/// 输出示例：
/// ```
/// 9 packages have install scripts not yet covered by allowScripts:
/// better-sqlite3@12.10.0 (install: node-gyp rebuild)
/// electron@41.10.4 (postinstall: node install.js)
/// ```
fn parse_pending_packages(output: &str) -> Vec<String> {
    let mut packages = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim();

        // 跳过空行和提示信息
        if trimmed.is_empty()
            || trimmed.starts_with('[')
            || trimmed.starts_with("npm warn")
            || trimmed.starts_with("Run `npm")
            || trimmed.starts_with("packages have")
        {
            continue;
        }

        // 包名行格式：better-sqlite3@12.10.0 (install: ...)
        // 只取第一部分（包名@版本），去掉括号后的脚本描述
        let pkg = if let Some(bracket_pos) = trimmed.find('(') {
            trimmed[..bracket_pos].trim().to_string()
        } else {
            trimmed.to_string()
        };

        // 验证包名格式（必须包含 @）
        if !pkg.is_empty() && pkg.contains('@') && !pkg.starts_with("npm") {
            packages.push(pkg);
        }
    }

    packages
}