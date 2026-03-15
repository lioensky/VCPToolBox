use std::{
    env,
    ffi::OsString,
    path::{Path, PathBuf},
};

/// 构建包含 Portable 运行时的 PATH 字符串
pub fn build_runtime_path(runtimes_dir: &Path) -> String {
    let mut paths: Vec<PathBuf> = Vec::new();

    // Node.js
    let node_dir = runtimes_dir.join("node");
    if node_dir.exists() {
        paths.push(node_dir);
    }

    // Git
    let git_cmd = runtimes_dir.join("git").join("cmd");
    if git_cmd.exists() {
        paths.push(git_cmd);
    }

    let git_bin = runtimes_dir.join("git").join("bin");
    if git_bin.exists() {
        paths.push(git_bin);
    }

    // Python
    let python_dir = runtimes_dir.join("python");
    if python_dir.exists() {
        paths.push(python_dir.clone());

        let python_scripts = python_dir.join("Scripts");
        if python_scripts.exists() {
            paths.push(python_scripts);
        }
    }

    // 追加系统原有 PATH
    if let Some(system_path) = env::var_os("PATH") {
        paths.extend(env::split_paths(&system_path));
    }

    env::join_paths(paths)
        .unwrap_or_else(|_| env::var_os("PATH").unwrap_or_else(OsString::new))
        .to_string_lossy()
        .to_string()
}

/// 将 Portable PATH 应用到当前进程
pub fn apply_runtime_path(runtimes_dir: &Path) {
    let new_path = build_runtime_path(runtimes_dir);
    env::set_var("PATH", new_path);
}

/// 生成 bat 启动脚本里的 PATH 设置行
pub fn generate_bat_path_line(runtimes_dir_relative: &str) -> String {
    let rel = runtimes_dir_relative
        .trim_matches(|c| c == '\\' || c == '/')
        .replace('/', "\\");

    let base = if rel.is_empty() {
        "%~dp0runtimes".to_string()
    } else {
        format!("%~dp0{}", rel)
    };

    format!(
        "set PATH={}\\node;{}\\git\\cmd;{}\\git\\bin;{}\\python;{}\\python\\Scripts;%PATH%",
        base, base, base, base, base
    )
}