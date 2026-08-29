//! VCPChat 原生模块 Electron ABI 重建（安装流程第 09 步）
//!
//! 背景：
//! - VCPChat 是 Electron 41 应用（内置 Node ABI 145），运行用 `electron .`
//! - npm install 用便携 Node.js 24（ABI 137）编译原生模块
//! - ABI 不匹配 → VCPChat 启动时 better-sqlite3 require 抛错 → 主进程崩
//!
//! 修复：安装最后环节用 electron-rebuild 按 Electron ABI 重编译原生模块
//!
//! 策略：
//! - 自动扫描 node_modules 找 binding.gyp 模块，排除 electron-edge-js
//! - 失败不阻断安装（仅警告 + 提示），与现有 npm install 失败哲学一致

use std::path::Path;
use std::process::{Command, Stdio};

use crate::installer::stream_util::WatchdogPolicy;

/// 扫描 node_modules 找需要 electron-rebuild 的原生模块
///
/// 判定：包目录有 binding.gyp + 不在排除列表
/// 返回模块名列表（已去重排序）
pub fn scan_rebuildable_modules(
    chat_dir: &Path,
    log_fn: &dyn Fn(&str),
) -> Vec<String> {
    // 排除列表：electron-edge-js 用预编译二进制，不需也不应 electron-rebuild
    const EXCLUDE: [&str; 1] = ["electron-edge-js"];

    let node_modules = chat_dir.join("node_modules");
    let mut modules: Vec<String> = Vec::new();

    let entries = match std::fs::read_dir(&node_modules) {
        Ok(e) => e,
        Err(e) => {
            log_fn(&format!(
                "[electron-rebuild] node_modules 不存在或不可读: {}",
                e
            ));
            return modules;
        }
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let pkg_dir = entry.path();

        // 跳过 scoped 包（@scope/xxx）
        if name.starts_with('@') {
            continue;
        }

        // 跳过排除列表
        if EXCLUDE.contains(&name.as_ref()) {
            continue;
        }

        // 检查是否有 binding.gyp
        if pkg_dir.join("binding.gyp").exists() {
            modules.push(name.to_string());
        }
    }

    modules.sort();

    if modules.is_empty() {
        log_fn("[electron-rebuild] 未找到需要重建的原生模块");
    } else {
        log_fn(&format!(
            "[electron-rebuild] 检测到 {} 个原生模块需重建: {}",
            modules.len(),
            modules.join(", ")
        ));
    }

    modules
}

/// 执行 electron-rebuild 重建原生模块
///
/// 参数：
/// - node_dir: 便携 Node.js 运行时目录
/// - chat_dir: VCPChat 项目目录
/// - env_path: 环境变量 PATH 字符串
/// - modules: 需要重建的模块列表
/// - log_fn: 日志输出回调
///
/// 返回 Ok(()) 表示重建成功，Err 表示失败
pub fn rebuild_modules(
    node_dir: &Path,
    chat_dir: &Path,
    env_path: &str,
    modules: &[String],
    log_fn: &dyn Fn(&str),
) -> Result<(), String> {
    if modules.is_empty() {
        return Ok(());
    }

    let node_exe = node_dir.join("node.exe");
    if !node_exe.exists() {
        return Err(format!(
            "未找到 node 可执行文件: {}",
            node_exe.display()
        ));
    }

    // 检查 electron-rebuild 是否存在
    let rebuild_cli = chat_dir
        .join("node_modules")
        .join("@electron")
        .join("rebuild")
        .join("lib")
        .join("cli.js");

    if !rebuild_cli.exists() {
        // 尝试备选路径（旧版本 electron-rebuild 3.x）
        let alt_cli = chat_dir
            .join("node_modules")
            .join("electron-rebuild")
            .join("lib")
            .join("cli.js");

        if !alt_cli.exists() {
            return Err("未找到 electron-rebuild 模块（VCPChat 应内置）".to_string());
        }
        return rebuild_modules_internal(&node_exe, &alt_cli, chat_dir, env_path, modules, log_fn);
    }

    rebuild_modules_internal(&node_exe, &rebuild_cli, chat_dir, env_path, modules, log_fn)
}

fn rebuild_modules_internal(
    node_exe: &std::path::Path,
    rebuild_cli: &std::path::Path,
    chat_dir: &Path,
    env_path: &str,
    modules: &[String],
    log_fn: &dyn Fn(&str),
) -> Result<(), String> {
    log_fn(&format!(
        "[electron-rebuild] 开始重建 {} 个模块（可能需要 3-8 分钟）...",
        modules.len()
    ));

    // 构建命令：node cli.js -f -o <module1,module2,...>
    let module_list = modules.join(",");
    let mut cmd = Command::new(node_exe);
    cmd.arg(rebuild_cli)
        .arg("-f")
        .arg("-o")
        .arg(&module_list)
        .current_dir(chat_dir)
        .env("PATH", env_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 electron-rebuild 失败: {}", e))?;

    // 双线程读取 stdout/stderr，防管道死锁
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel::<crate::installer::stream_util::StreamEvent>();

    if let Some(stdout) = child.stdout.take() {
        crate::installer::stream_util::spawn_pipe_reader(
            stdout,
            tx.clone(),
            "[electron-rebuild]",
            false,
        );
    }

    if let Some(stderr) = child.stderr.take() {
        crate::installer::stream_util::spawn_pipe_reader(
            stderr,
            tx,
            "[electron-rebuild]",
            false,
        );
    }

    // 包装日志回调：过滤 C4996 警告噪音
    let log_fn_ref: &dyn Fn(&str) = log_fn;
    let filtered_log = |line: &str| {
        if line.contains("C4996") || line.contains("warning C4996") {
            return;
        }
        log_fn_ref(line);
    };

    // 父线程：转发日志 + 看门狗
    // 300 秒活动看门狗：electron-rebuild 纯本地编译（无下载），
    // 但 MSVC 编译大文件时可能有较长静默期，3 模块串行 3-8 分钟，给足余量
    let mut output_buf = String::new();
    let clean = crate::installer::stream_util::pump_child_output(
        &mut child,
        rx,
        &filtered_log,
        None,
        300,
        WatchdogPolicy::Always,
        Some(&mut output_buf),
    );

    if !clean {
        log_fn("[electron-rebuild] ! 看门狗检测到挂死（300秒无输出），已终止进程");
        output_buf.push_str("\n[watchdog] HUNG_PROCESS_KILLED");
    }

    let status = child
        .wait()
        .map_err(|e| format!("等待 electron-rebuild 完成失败: {}", e))?;

    if status.success() {
        log_fn("[electron-rebuild] ✓ 原生模块重建完成，Electron ABI 匹配");
        Ok(())
    } else {
        // 提取错误信息（最后 5 行）
        let error_lines: Vec<&str> = output_buf.lines().rev().take(5).collect();
        let error_msg = error_lines
            .iter()
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");

        log_fn(&format!(
            "[electron-rebuild] ! 重建失败 (exit {:?}): {}",
            status.code(),
            error_msg
        ));

        Err(format!("electron-rebuild 失败 (exit {:?})", status.code()))
    }
}
