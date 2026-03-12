use std::{
    fs,
    io,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, bail, Context, Result};
use flate2::read::GzDecoder;
use tar::Archive;
use zip::ZipArchive;

/// 解压文件格式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    Zip,
    TarGz,
    SevenZip,
}

/// 自动检测格式并解压
/// 返回解压后的根目录路径
pub async fn extract(archive_path: &Path, dest_dir: &Path) -> Result<PathBuf> {
    let archive = archive_path.to_path_buf();
    let dest = dest_dir.to_path_buf();

    let result = tokio::task::spawn_blocking(move || extract_sync(&archive, &dest))
        .await
        .context("解压任务执行失败")?;

    result
}

/// 根据文件扩展名检测格式
pub fn detect_format(path: &Path) -> Result<ArchiveFormat> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if name.ends_with(".zip") {
        Ok(ArchiveFormat::Zip)
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        Ok(ArchiveFormat::TarGz)
    } else if name.ends_with(".7z") || name.ends_with(".7z.exe") {
        Ok(ArchiveFormat::SevenZip)
    } else {
        bail!("无法识别的压缩格式: {}", name)
    }
}

fn extract_sync(archive_path: &Path, dest_dir: &Path) -> Result<PathBuf> {
    match detect_format(archive_path)? {
        ArchiveFormat::Zip => extract_zip(archive_path, dest_dir),
        ArchiveFormat::TarGz => extract_tar_gz(archive_path, dest_dir),
        ArchiveFormat::SevenZip => extract_7z(archive_path, dest_dir),
    }
}

fn extract_zip(archive_path: &Path, dest_dir: &Path) -> Result<PathBuf> {
    fs::create_dir_all(dest_dir)
        .with_context(|| format!("创建解压目录失败: {}", dest_dir.display()))?;

    let file = fs::File::open(archive_path)
        .with_context(|| format!("打开 ZIP 文件失败: {}", archive_path.display()))?;
    let mut archive =
        ZipArchive::new(file).with_context(|| format!("读取 ZIP 文件失败: {}", archive_path.display()))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .with_context(|| format!("读取 ZIP 条目失败，索引: {i}"))?;

        let safe_rel_path = entry
            .enclosed_name()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| anyhow!("ZIP 包含不安全路径: {}", entry.name()))?;

        let out_path = dest_dir.join(&safe_rel_path);

        if entry.name().ends_with('/') {
            fs::create_dir_all(&out_path)
                .with_context(|| format!("创建 ZIP 目录失败: {}", out_path.display()))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)
                    .with_context(|| format!("创建 ZIP 父目录失败: {}", parent.display()))?;
            }

            let mut out_file = fs::File::create(&out_path)
                .with_context(|| format!("创建输出文件失败: {}", out_path.display()))?;

            io::copy(&mut entry, &mut out_file)
                .with_context(|| format!("写入 ZIP 解压文件失败: {}", out_path.display()))?;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            if let Some(mode) = entry.unix_mode() {
                fs::set_permissions(&out_path, fs::Permissions::from_mode(mode)).ok();
            }
        }
    }

    infer_single_root_dir(dest_dir)
}

fn extract_tar_gz(archive_path: &Path, dest_dir: &Path) -> Result<PathBuf> {
    fs::create_dir_all(dest_dir)
        .with_context(|| format!("创建解压目录失败: {}", dest_dir.display()))?;

    let file = fs::File::open(archive_path)
        .with_context(|| format!("打开 tar.gz 文件失败: {}", archive_path.display()))?;
    let decoder = GzDecoder::new(file);
    let mut archive = Archive::new(decoder);

    let entries = archive
        .entries()
        .with_context(|| format!("读取 tar.gz 条目失败: {}", archive_path.display()))?;

    for entry_result in entries {
        let mut entry = entry_result
            .with_context(|| format!("读取 tar.gz 条目失败: {}", archive_path.display()))?;

        let entry_path = entry
            .path()
            .with_context(|| format!("读取 tar.gz 条目路径失败: {}", archive_path.display()))?
            .into_owned();

        let unpacked = entry
            .unpack_in(dest_dir)
            .with_context(|| format!("解压 tar.gz 条目失败: {}", entry_path.display()))?;

        if !unpacked {
            bail!("tar.gz 包含不安全路径: {}", entry_path.display());
        }
    }

    infer_single_root_dir(dest_dir)
}

fn extract_7z(archive_path: &Path, dest_dir: &Path) -> Result<PathBuf> {
    fs::create_dir_all(dest_dir)
        .with_context(|| format!("创建解压目录失败: {}", dest_dir.display()))?;

    let name = archive_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if name.ends_with(".7z.exe") {
        #[cfg(windows)]
        {
            return extract_7z_fallback(archive_path, dest_dir);
        }

        #[cfg(not(windows))]
        {
            bail!("当前平台不支持 .7z.exe 自解压，请在 Windows 上执行");
        }
    }

    match sevenz_rust::decompress_file(archive_path, dest_dir) {
        Ok(_) => infer_single_root_dir(dest_dir),
        Err(primary_err) => {
            #[cfg(windows)]
            {
                extract_7z_fallback(archive_path, dest_dir).with_context(|| {
                    format!("7z 解压失败，已尝试降级方案。原始错误: {primary_err}")
                })
            }

            #[cfg(not(windows))]
            {
                Err(anyhow!("7z 解压失败: {primary_err}"))
            }
        }
    }
}

#[cfg(windows)]
fn extract_7z_fallback(archive_path: &Path, dest_dir: &Path) -> Result<PathBuf> {
    use std::process::Command;

    let is_exe = archive_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("exe"))
        .unwrap_or(false);

    let output = if is_exe {
        Command::new(archive_path)
            .arg(format!("-o{}", dest_dir.display()))
            .arg("-y")
            .output()
            .with_context(|| format!("执行自解压文件失败: {}", archive_path.display()))?
    } else {
        Command::new("7z")
            .arg("x")
            .arg(archive_path)
            .arg(format!("-o{}", dest_dir.display()))
            .arg("-y")
            .output()
            .context("调用系统 7z 失败，请确认 PATH 中可用 7z.exe")?
    };

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        bail!(
            "7z 降级解压失败。\nstdout: {}\nstderr: {}",
            stdout.trim(),
            stderr.trim()
        );
    }

    infer_single_root_dir(dest_dir)
}

fn infer_single_root_dir(dest_dir: &Path) -> Result<PathBuf> {
    let mut entries = fs::read_dir(dest_dir)
        .with_context(|| format!("读取解压目录失败: {}", dest_dir.display()))?
        .filter_map(|entry| entry.ok())
        .collect::<Vec<_>>();

    if entries.len() == 1 && entries[0].file_type()?.is_dir() {
        Ok(entries.remove(0).path())
    } else {
        Ok(dest_dir.to_path_buf())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_format() {
        assert_eq!(detect_format(Path::new("node-v20.11.0-win-x64.zip")).unwrap(), ArchiveFormat::Zip);
        assert_eq!(detect_format(Path::new("python.tar.gz")).unwrap(), ArchiveFormat::TarGz);
        assert_eq!(detect_format(Path::new("python.tgz")).unwrap(), ArchiveFormat::TarGz);
        assert_eq!(detect_format(Path::new("PortableGit.7z")).unwrap(), ArchiveFormat::SevenZip);
        assert_eq!(detect_format(Path::new("PortableGit.7z.exe")).unwrap(), ArchiveFormat::SevenZip);
        assert!(detect_format(Path::new("README.md")).is_err());
    }
}