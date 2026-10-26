//! ZIP 安全解压：防压缩炸弹 + 防文件数洪水 + 防路径穿越 + 拒绝符号链接
//! （复刻 paper_study ziputil.py 三重防御）。

use crate::error::AppError;
use std::fs::{self, File};
use std::io;
use std::path::{Component, Path, PathBuf};

/// 所有条目解压后总大小上限。
pub const MAX_TOTAL_SIZE: u64 = 2 * 1024 * 1024 * 1024;
/// 条目数量上限。
pub const MAX_ENTRY_COUNT: usize = 20000;

/// 条目名安全检查与归一化：拒绝绝对路径、盘符前缀、`..` 逃逸与不可解路径，
/// 消费 `.` 组件，返回相对 output_dir 的归一化路径。
fn safe_join(output_dir: &Path, name: &str) -> Result<PathBuf, String> {
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(format!("条目为绝对路径: {}", name));
    }
    // 盘符前缀（如 C:）在 Unix 语义下是普通组件，但作为 ZIP 条目几乎必为穿越攻击
    let first = normalized.split('/').next().unwrap_or("");
    if first.len() >= 2 && first.as_bytes()[1] == b':' {
        return Err(format!("条目含盘符前缀: {}", name));
    }

    let mut stack: Vec<String> = Vec::new();
    for comp in normalized.split('/') {
        match comp {
            "" | "." => {}
            ".." => return Err(format!("条目含 .. 逃逸: {}", name)),
            other => stack.push(other.to_string()),
        }
    }
    if stack.is_empty() {
        return Err(format!("条目路径为空: {}", name));
    }

    let mut path = output_dir.to_path_buf();
    for comp in &stack {
        path.push(comp);
    }

    // 双保险：归一化结果必须仍在 output_dir 之下
    let mut canonical_base = output_dir.to_path_buf();
    canonical_base = normalize(canonical_base);
    let normalized_path = normalize(path.clone());
    if !starts_with_component(&normalized_path, &canonical_base) {
        return Err(format!("条目路径逃逸出输出目录: {}", name));
    }
    Ok(path)
}

/// 纯词法路径归一化（不触碰文件系统，避免 TOCTOU）。
fn normalize(path: PathBuf) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn starts_with_component(path: &Path, base: &Path) -> bool {
    path.starts_with(base)
}

fn is_symlink_entry(entry: &zip::read::ZipFile) -> bool {
    entry
        .unix_mode()
        .map(|m| (m & 0o170000) == 0o120000)
        .unwrap_or(false)
}

/// 条目数与累计解压大小防御检查。
fn check_limits(entry_count: usize, total_size: u64) -> Result<(), String> {
    if entry_count > MAX_ENTRY_COUNT {
        return Err(format!(
            "ZIP 条目数 {} 超过上限 {}，疑似异常压缩包",
            entry_count, MAX_ENTRY_COUNT
        ));
    }
    if total_size > MAX_TOTAL_SIZE {
        return Err("ZIP 解压总大小超过 2GB 上限，疑似压缩炸弹".to_string());
    }
    Ok(())
}

/// 安全解压 ZIP 到 output_dir。
pub fn safe_extract_zip(zip_file: &Path, output_dir: &Path) -> Result<(), AppError> {
    let file = File::open(zip_file)
        .map_err(|e| AppError::fix(format!("打开 ZIP 失败: {}", e)))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::fix(format!("ZIP 读取失败（文件可能损坏）: {}", e)))?;

    check_limits(archive.len() as usize, 0).map_err(AppError::fix)?;

    let mut total_size: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::fix(format!("读取 ZIP 条目失败: {}", e)))?;
        total_size += entry.size();
        check_limits(i as usize, total_size).map_err(AppError::fix)?;

        let name = entry.name().to_string();
        if is_symlink_entry(&entry) {
            return Err(AppError::fix(format!("ZIP 含符号链接条目，已拒绝: {}", name)));
        }

        let dest = safe_join(output_dir, &name).map_err(AppError::fix)?;

        if entry.is_dir() {
            fs::create_dir_all(&dest).map_err(|e| AppError::fix(format!("创建目录失败: {}", e)))?;
        } else {
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| AppError::fix(format!("创建目录失败: {}", e)))?;
            }
            let mut out = File::create(&dest)
                .map_err(|e| AppError::fix(format!("创建文件失败 {}: {}", dest.display(), e)))?;
            io::copy(&mut entry, &mut out)
                .map_err(|e| AppError::fix(format!("解压写入失败: {}", e)))?;
        }
    }
    Ok(())
}

/// 递归列出 root 下全部文件，返回 (POSIX 相对路径, 字节数)，按路径排序。
pub fn list_files(root: &Path) -> Vec<(String, u64)> {
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, u64)>) {
    // 迭代式遍历：解压产物的目录深度不可信，递归实现存在爆栈风险。
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let entries = match fs::read_dir(&current) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut children: Vec<_> = entries.flatten().collect();
        children.sort_by_key(|e| e.file_name());
        for entry in children {
            let path = entry.path();
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() {
                let rel = match path.strip_prefix(root) {
                    Ok(r) => r.to_string_lossy().replace('\\', "/"),
                    Err(_) => continue,
                };
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                out.push((rel, size));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("mineruparser_test_{}_{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_zip(path: &Path, entries: &[(&str, &str)]) {
        let file = File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for (name, content) in entries {
            zip.start_file(
                *name,
                zip::write::FileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn extract_normal() {
        let dir = temp_dir("zip_normal");
        let zip_path = dir.join("a.zip");
        write_zip(
            &zip_path,
            &[
                ("full.md", "# hello"),
                ("images/fig_1.jpg", "fake-jpg"),
                ("nest/deep/x.json", "{}"),
            ],
        );
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        safe_extract_zip(&zip_path, &out).unwrap();
        assert!(out.join("full.md").is_file());
        assert!(out.join("images/fig_1.jpg").is_file());
        assert!(out.join("nest/deep/x.json").is_file());
        let files = list_files(&out);
        assert_eq!(files.len(), 3);
        assert!(files.iter().any(|(r, _)| r == "images/fig_1.jpg"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reject_traversal() {
        let dir = temp_dir("zip_traversal");
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        for (name, tag) in [
            ("../evil.txt", "dotdot"),
            ("a/../../evil.txt", "dotdot_mid"),
            ("/abs/evil.txt", "abs"),
            ("C:/evil.txt", "drive"),
            ("..\\evil.txt", "win_dotdot"),
        ] {
            let zip_path = dir.join(format!("{}.zip", tag));
            write_zip(&zip_path, &[(name, "x")]);
            let err = safe_extract_zip(&zip_path, &out).unwrap_err();
            assert!(err.message().contains("逃逸") || err.message().contains("绝对路径") || err.message().contains("盘符"), "应拒绝 {}: {}", name, err.message());
            assert!(!dir.join("evil.txt").exists(), "不得产生逃逸文件");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reject_bomb_by_declared_size() {
        // 防御上限函数直接断言：累计大小与条目数超限必须拒绝
        assert!(check_limits(1, MAX_TOTAL_SIZE).is_ok());
        assert!(check_limits(1, MAX_TOTAL_SIZE + 1).is_err());
        assert!(check_limits(MAX_ENTRY_COUNT, 0).is_ok());
        assert!(check_limits(MAX_ENTRY_COUNT + 1, 0).is_err());
    }

    #[test]
    fn reject_entry_flood() {
        // 真实构造 20001 条目的 ZIP：必须在解压前被条目数上限拦截
        let dir = temp_dir("zip_flood");
        let zip_path = dir.join("flood.zip");
        let file = File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for i in 0..=MAX_ENTRY_COUNT {
            zip.start_file(format!("f/{}.txt", i), opts).unwrap();
            zip.write_all(b"x").unwrap();
        }
        zip.finish().unwrap();

        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        let err = safe_extract_zip(&zip_path, &out).unwrap_err();
        assert!(err.message().contains("条目数"), "{}", err.message());
        // 拦截发生在解压前，输出目录应保持为空
        assert!(list_files(&out).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_files_handles_deep_and_wide_trees() {
        let dir = temp_dir("zip_list_extreme");
        let mut deep = dir.join("root");
        // 在 Windows MAX_PATH 内尽量加深，确认迭代遍历不受深度影响
        for _ in 0..60 {
            deep.push("d");
        }
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("deep.md"), b"deep").unwrap();
        let wide = dir.join("root").join("wide");
        fs::create_dir_all(&wide).unwrap();
        for i in 0..2000 {
            fs::write(wide.join(format!("{}.txt", i)), b"x").unwrap();
        }

        let files = list_files(&dir.join("root"));
        assert_eq!(files.len(), 2001);
        let expected_deep = format!("{}/deep.md", vec!["d"; 60].join("/"));
        assert!(files.iter().any(|(rel, size)| rel == &expected_deep && *size == 4));
        // list_files 输出必须始终有序，供后续索引生成使用
        let mut sorted = files.clone();
        sorted.sort();
        assert_eq!(files, sorted);
        let _ = fs::remove_dir_all(&dir);
    }
}
