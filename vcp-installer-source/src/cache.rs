//! 统一缓存管理器
//!
//! 所有下载（运行时、组件 tarball、镜像站测试）都通过此模块检查缓存，
//! 避免重复下载，保持日志格式统一。
//!
//! ## 缓存策略
//! - 按名称检查 dl_runtimes_dir 下是否已存在文件
//! - 存在则跳过下载，复用已有缓存
//! - 可选版本检查（用于运行时：Git/Node.js/Python/NewAPI）
//!
//! ## 设计原则（与 log_router 一致）
//! - 单一入口：find_or_download() / ensure_cached()
//! - 统一日志格式（调用方提供前缀标签）
//! - 可扩展：版本检查、损坏检测

use std::path::{Path, PathBuf};
use anyhow::{Context, Result};
use crate::utils::format_file_size;

/// 缓存管理器（Clone，方便跨线程传递）
#[derive(Clone, Debug)]
pub struct CacheManager {
    /// DL_runtimes 目录路径（exe 同级）
    dl_runtimes_dir: PathBuf,
}

impl CacheManager {
    /// 创建缓存管理器
    pub fn new(dl_runtimes_dir: PathBuf) -> Self {
        Self { dl_runtimes_dir }
    }

    /// 获取 dl_runtimes_dir 引用
    pub fn dl_runtimes_dir(&self) -> &Path {
        &self.dl_runtimes_dir
    }

    // ========================
    // 基本缓存操作（无版本检查）
    // ========================

    /// 检查缓存是否存在
    pub fn exists(&self, name: &str) -> bool {
        self.dl_runtimes_dir.join(name).exists()
    }

    /// 获取缓存文件路径（无论是否存在）
    pub fn path(&self, name: &str) -> PathBuf {
        self.dl_runtimes_dir.join(name)
    }

    /// 获取缓存文件大小（不存在返回 0）
    pub fn size(&self, name: &str) -> u64 {
        self.path(name).metadata().map(|m| m.len()).unwrap_or(0)
    }

    /// 确保缓存存在：检查缓存或调用下载器下载
    ///
    /// 这是核心方法，调用方负责构造下载闭包。
    ///
    /// # 参数
    /// - `tag`: 日志标签（如 "[tarball]", "[git]", "[node]"）
    /// - `name`: 缓存文件名（如 "VCPToolBox.tar.gz"）
    /// - `log_fn`: 日志回调
    /// - `downloader`: 下载闭包，参数为缓存文件路径，返回 Result<()>
    ///
    /// # 日志格式
    /// - 缓存命中: `{tag} 使用缓存: {path} ({size})`
    /// - 缓存下载: `{tag} 开始下载: {url} -> {path}`  +  `{tag} 下载完成: {path} ({size})`
    pub fn ensure_cached<F>(&self, tag: &str, name: &str, log_fn: &dyn Fn(&str), downloader: F) -> Result<PathBuf>
    where
        F: FnOnce(&Path) -> Result<()>,
    {
        // 确保目录存在
        std::fs::create_dir_all(&self.dl_runtimes_dir)
            .with_context(|| format!("创建 DL_runtimes 目录失败: {}", self.dl_runtimes_dir.display()))?;

        let cached_file = self.path(name);

        // 检查缓存
        if cached_file.exists() {
            let size = self.size(name);
            log_fn(&format!("{tag} 使用缓存: {} ({})", cached_file.display(), format_file_size(size)));
            return Ok(cached_file);
        }

        // 调用下载器
        downloader(&cached_file)?;

        // 验证下载结果
        if !cached_file.exists() {
            anyhow::bail!("下载完成但文件不存在: {}", cached_file.display());
        }

        let size = self.size(name);
        log_fn(&format!("{tag} 下载完成: {} ({})", cached_file.display(), format_file_size(size)));

        Ok(cached_file)
    }

    /// 异步版本：确保缓存存在（用于 runtime/*.rs 的异步下载）
    ///
    /// 用法与 ensure_cached 相同，但 downloader 是 async closure。
    pub async fn ensure_cached_async<F, Fut>(
        &self,
        tag: &str,
        name: &str,
        log_fn: &(dyn Fn(&str) + Send + Sync),
        downloader: F,
    ) -> Result<PathBuf>
    where
        F: FnOnce(&Path) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<()>> + Send + 'static,
    {
        // 确保目录存在
        tokio::fs::create_dir_all(&self.dl_runtimes_dir).await.with_context(|| {
            format!(
                "创建 DL_runtimes 目录失败: {}",
                self.dl_runtimes_dir.display()
            )
        })?;

        let cached_file = self.path(name);

        // 检查缓存
        if cached_file.exists() {
            let size = self.size(name);
            log_fn(&format!(
                "{tag} 使用缓存: {} ({})",
                cached_file.display(),
                format_file_size(size)
            ));
            return Ok(cached_file);
        }

        // 调用异步下载器
        downloader(&cached_file).await?;

        // 验证下载结果
        if !cached_file.exists() {
            anyhow::bail!("下载完成但文件不存在: {}", cached_file.display());
        }

        let size = self.size(name);
        log_fn(&format!(
            "{tag} 下载完成: {} ({})",
            cached_file.display(),
            format_file_size(size)
        ));

        Ok(cached_file)
    }

    // ========================
    // 带版本检查的缓存（运行时专用）
    // ========================

    /// 确保缓存存在且版本匹配：检查缓存或下载指定版本
    ///
    /// 用于运行时（Git/Node.js/Python/NewAPI），支持：
    /// - 版本检查：已安装的版本是否匹配要求
    /// - 缓存检查：DL_runtimes 中是否有对应安装包
    /// - 下载：必要时下载指定版本
    ///
    /// # 参数
    /// - `tag`: 日志标签（如 "[git]", "[node]"）
    /// - `name`: 缓存文件名（如 "PortableGit.7z.exe"）
    /// - `current_version`: 当前已安装的版本号（None = 未安装）
    /// - `required_version`: 要求的版本号
    /// - `log_fn`: 日志回调
    /// - `downloader`: 下载闭包
    ///
    /// # 返回值
    /// - `Ok(Some(path))`: 下载或复用缓存，返回缓存路径
    /// - `Ok(None)`: 已安装版本匹配，无需下载
    pub fn ensure_cached_version<F>(
        &self,
        tag: &str,
        name: &str,
        current_version: Option<&str>,
        required_version: &str,
        log_fn: &dyn Fn(&str),
        downloader: F,
    ) -> Result<Option<PathBuf>>
    where
        F: FnOnce(&Path) -> Result<()>,
    {
        // 版本匹配检查：已安装版本 == 要求版本 → 无需下载
        if let Some(curr) = current_version {
            if curr == required_version {
                log_fn(&format!("{tag} 已安装版本匹配: {}，无需下载", required_version));
                return Ok(None);
            }
            log_fn(&format!("{tag} 版本不匹配：已安装 {}，需要 {}，将下载新版本", curr, required_version));
        }

        // 确保缓存存在（使用 ensure_cached）
        let path = self.ensure_cached(tag, name, log_fn, downloader)?;

        log_fn(&format!("{tag} 已获取缓存（版本 {}），准备安装", required_version));
        Ok(Some(path))
    }
}
