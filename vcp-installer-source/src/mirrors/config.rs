use anyhow::Result;
use std::{collections::HashMap, fs, path::Path, time::Duration};

// ==========================================
// 镜像站点定义
// ==========================================

#[derive(Debug, Clone)]
pub struct MirrorEntry {
    /// 显示名称（在TUI中展示给用户）
    pub name: String,
    /// 完整URL前缀
    pub url: String,
}

impl MirrorEntry {
    pub fn new(name: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            url: url.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct MirrorConfig {
    /// GitHub download mirrors (备用列表，过去可用，离线维护)
    pub github: Vec<MirrorEntry>,
    /// GitHub preferred mirrors (可用列表，安装时动态测试生成)
    pub preferred_github: Vec<MirrorEntry>,
    /// npm registry mirrors
    pub npm: Vec<MirrorEntry>,
    /// pip simple API mirrors
    pub pip: Vec<MirrorEntry>,
    /// MSVC Build Tools download mirrors (for vs_BuildTools.exe bootstrap)
    pub msvc: Vec<MirrorEntry>,
    /// 2026-08-23 新增：组件 commit 版本（key = 组件短名，value = commit hash）
    /// 镜像测试阶段下载 tarball 时记录，安装阶段校验使用
    pub component_commits: HashMap<String, String>,
    /// 2026-08-23 新增：运行时版本号（key = 运行时常量名，value = 版本号）
    /// 下载运行时时记录，下次安装时校验缓存是否过期
    /// 统一 PortableGit / Node.js / Python / NewAPI 的缓存校验机制
    pub runtime_versions: HashMap<String, String>,
}

impl Default for MirrorConfig {
    /// 内置默认镜像列表（当 vcp-mirrors.ini 不存在或解析失败时使用）
    fn default() -> Self {
        Self {
            github: vec![
                MirrorEntry::new("ghproxy.com", "https://ghproxy.com/https://github.com/"),
                MirrorEntry::new("ghfast.top", "https://ghfast.top/https://github.com/"),
                MirrorEntry::new("gitclone.com", "https://gitclone.com/https://github.com/"),
                MirrorEntry::new("gh-proxy.com", "https://gh-proxy.com/https://github.com/"),
                MirrorEntry::new("mirror.ghproxy.com", "https://mirror.ghproxy.com/https://github.com/"),
                MirrorEntry::new("ghproxy.net", "https://ghproxy.net/https://github.com/"),
                MirrorEntry::new("ghp.ci", "https://ghp.ci/https://github.com/"),
                MirrorEntry::new("down.chinamirror.org", "https://down.chinamirror.org/https://github.com/"),
            ],
            preferred_github: Vec::new(),
            npm: vec![
                MirrorEntry::new("npmmirror(淘宝)", "https://registry.npmmirror.com/"),
                MirrorEntry::new("taobao(备用)", "https://registry.npm.taobao.org/"),
                MirrorEntry::new("cnpm", "https://r.cnpmjs.org/"),
            ],
            pip: vec![
                MirrorEntry::new("阿里云", "https://mirrors.aliyun.com/pypi/simple/"),
                MirrorEntry::new("中科大", "https://pypi.mirrors.ustc.edu.cn/simple/"),
                MirrorEntry::new("腾讯云", "https://mirrors.cloud.tencent.com/pypi/simple/"),
            ],
            msvc: vec![
                MirrorEntry::new(
                    "Microsoft Official",
                    "https://aka.ms/vs/17/release/vs_BuildTools.exe",
                ),
                MirrorEntry::new(
                    "Azure Blob",
                    "https://vsdownload.blob.core.windows.net/release/vs_BuildTools.exe",
                ),
            ],
            component_commits: HashMap::new(),
            runtime_versions: HashMap::new(),
        }
    }
}

// ==========================================
// 镜像检测结果
// ==========================================

#[derive(Debug, Clone)]
pub struct MirrorResult {
    pub entry: MirrorEntry,
    /// 检测到的延迟；None 表示不可达
    pub latency: Option<Duration>,
}

impl MirrorResult {
    pub fn is_reachable(&self) -> bool {
        self.latency.is_some()
    }

    pub fn display_latency(&self) -> String {
        match self.latency {
            Some(d) => format!("{}ms", d.as_millis()),
            None => String::from("不可达"),
        }
    }
}

// ==========================================
// INI 文件解析
// ==========================================

/// 从配置文件路径加载镜像配置
/// - 文件不存在 → 返回默认配置
/// - 文件存在但为空 → 返回默认配置
/// - section 缺失 → 该类别用默认配置
/// - 解析错误 → 打印警告，该类别用默认配置
pub fn load_mirror_config(path: &Path) -> Result<MirrorConfig> {
    // 尝试读取文件
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("[INFO] 配置文件 {} 不存在，使用默认镜像列表", path.display());
            return Ok(MirrorConfig::default());
        }
        Err(e) => {
            eprintln!("[WARN] 读取配置文件 {} 失败: {}，使用默认镜像列表", path.display(), e);
            return Ok(MirrorConfig::default());
        }
    };

    let content = content.trim();
    if content.is_empty() {
        eprintln!("[INFO] 配置文件 {} 为空，使用默认镜像列表", path.display());
        return Ok(MirrorConfig::default());
    }

    // 解析 INI
    let sections = parse_ini_sections(content)?;

    let github = parse_section_or_default(&sections, "github", &MirrorConfig::default().github);
    let preferred_github = parse_section(&sections, "preferred_github");
    let npm = parse_section_or_default(&sections, "npm", &MirrorConfig::default().npm);
    let pip = parse_section_or_default(&sections, "pip", &MirrorConfig::default().pip);
    let msvc = parse_section_or_default(&sections, "msvc", &MirrorConfig::default().msvc);

    // 2026-08-23: 解析 [component_commits] section（组件 commit 版本记录）
    let component_commits = match sections.get("component_commits") {
        Some(entries) => {
            let mut map = HashMap::new();
            for (key, value) in entries {
                if !key.is_empty() && !value.is_empty() {
                    map.insert(key.clone(), value.clone());
                }
            }
            map
        }
        None => HashMap::new(),
    };

    // 2026-08-23: 解析 [runtime_versions] section（运行时版本号记录）
    let runtime_versions = match sections.get("runtime_versions") {
        Some(entries) => {
            let mut map = HashMap::new();
            for (key, value) in entries {
                if !key.is_empty() && !value.is_empty() {
                    map.insert(key.clone(), value.clone());
                }
            }
            map
        }
        None => HashMap::new(),
    };

    if github.is_empty() && preferred_github.is_empty() && npm.is_empty() && pip.is_empty() && msvc.is_empty() {
        eprintln!("[INFO] Config file has no valid mirrors, using defaults");
        return Ok(MirrorConfig::default());
    }

    Ok(MirrorConfig {
        github,
        preferred_github,
        npm,
        pip,
        msvc,
        component_commits,
        runtime_versions,
    })
}

fn parse_section_or_default(
    sections: &HashMap<String, Vec<(String, String)>>,
    name: &str,
    fallback: &[MirrorEntry],
) -> Vec<MirrorEntry> {
    match sections.get(name) {
        Some(entries) => {
            let parsed: Vec<MirrorEntry> = entries
                .iter()
                .filter_map(|(key, value)| parse_mirror_entry(key, value))
                .collect();
            if parsed.is_empty() {
                eprintln!(
                    "[WARN] 配置文件中 [{}] section 没有有效镜像，使用默认列表",
                    name
                );
                fallback.to_vec()
            } else {
                parsed
            }
        }
        None => {
            eprintln!("[INFO] 配置文件中缺少 [{}] section，使用默认列表", name);
            fallback.to_vec()
        }
    }
}

/// 解析 section，没有就返回空（不 fallback）
fn parse_section(
    sections: &HashMap<String, Vec<(String, String)>>,
    name: &str,
) -> Vec<MirrorEntry> {
    match sections.get(name) {
        Some(entries) => entries
            .iter()
            .filter_map(|(key, value)| parse_mirror_entry(key, value))
            .collect(),
        None => Vec::new(),
    }
}

fn parse_ini_sections(content: &str) -> Result<HashMap<String, Vec<(String, String)>>> {
    let mut sections: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut current_section: Option<String> = None;

    for (line_num, raw_line) in content.lines().enumerate() {
        let line = raw_line.trim();

        // 跳过空行和注释
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }

        // section 头
        if line.starts_with('[') && line.ends_with(']') {
            let section_name = line[1..line.len() - 1].trim().to_lowercase();
            current_section = Some(section_name);
            continue;
        }

        // key = value
        if let Some(idx) = line.find('=') {
            let key = line[..idx].trim().to_string();
            let value = line[idx + 1..].trim().to_string();

            if let Some(ref section) = current_section {
                sections.entry(section.clone()).or_default().push((key, value));
            }
            // 如果不在任何 section 中，忽略该行
        }
    }

    Ok(sections)
}

fn parse_mirror_entry(key: &str, value: &str) -> Option<MirrorEntry> {
    if key.is_empty() || value.is_empty() {
        return None;
    }

    let name = key.trim().to_string();
    let url = value.trim().to_string();

    // 简单验证 URL 格式（必须以 http 开头）
    if !url.starts_with("http://") && !url.starts_with("https://") {
        eprintln!(
            "[WARN] 镜像 URL 格式无效（必须以 http(s):// 开头）: {} = {}",
            name, url
        );
        return None;
    }

    Some(MirrorEntry { name, url })
}

// ==========================================
// 工具函数：获取配置文件路径
// ==========================================

/// 返回配置文件路径：exe 同级目录下的 vcp-mirrors.ini
pub fn get_config_path() -> std::path::PathBuf {
    get_exe_dir().join("vcp-mirrors.ini")
}

/// 获取 exe 所在目录（供 DL_runtimes 定位使用）
pub fn get_exe_dir() -> std::path::PathBuf {
    std::env::current_exe().unwrap_or_default().parent().unwrap_or(std::path::Path::new(".")).to_path_buf()
}

/// 返回默认镜像配置（供其他模块获取前缀时使用）
pub fn get_default_config() -> MirrorConfig {
    MirrorConfig::default()
}

/// 保存 preferred_github 列表到配置文件
/// 保留原文件其他内容，只更新 [preferred_github] section
impl MirrorConfig {
    pub fn save_preferred_github(&self, preferred: &[MirrorEntry]) -> Result<()> {
        let path = get_config_path();
        
        // 读取原文件内容（如果存在）
        let original = fs::read_to_string(&path).ok();
        
        let mut lines = Vec::new();
        
        if let Some(content) = original {
            let sections = parse_ini_sections(&content)?;
            let has_preferred = sections.contains_key("preferred_github");
            
            if !has_preferred {
                // 保留原内容，在末尾追加 preferred_github section
                lines.extend(content.lines().map(|l| l.to_string()));
                if !lines.is_empty() && !lines.last().unwrap().is_empty() {
                    lines.push(String::new());
                }
            } else {
                // 替换 existing [preferred_github] section
                let mut in_preferred = false;
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed == "[preferred_github]" {
                        in_preferred = true;
                        continue;
                    }
                    if in_preferred && (trimmed.starts_with('[') || trimmed.is_empty()) {
                        // 遇到下一个 section 或空行，结束 preferred_github
                        if trimmed.starts_with('[') {
                            in_preferred = false;
                        }
                        lines.push(line.to_string());
                    }
                    if !in_preferred {
                        lines.push(line.to_string());
                    }
                }
            }
        }
        
        // 写入 [preferred_github] section
        lines.push("[preferred_github]".to_string());
        lines.push("; 安装时自动生成，当前优选站点（最多3个）".to_string());
        for entry in preferred {
            lines.push(format!("{} = {}", entry.name, entry.url));
        }
        
        fs::write(&path, lines.join("\n"))?;
        Ok(())
    }

    /// 2026-08-23 新增：获取组件 commit hash
    pub fn get_component_commit(&self, short_name: &str) -> Option<&String> {
        self.component_commits.get(short_name)
    }

    /// 2026-08-23 新增：设置组件 commit hash 并保存到 ini 文件
    pub fn set_and_save_component_commit(&mut self, short_name: &str, commit_hash: &str) -> Result<()> {
        // 更新内存
        self.component_commits.insert(short_name.to_string(), commit_hash.to_string());
        
        // 保存到 ini 文件
        let path = get_config_path();
        let original = fs::read_to_string(&path).ok();
        
        let mut lines = Vec::new();
        
        if let Some(content) = original {
            let sections = parse_ini_sections(&content)?;
            let has_commits = sections.contains_key("component_commits");
            
            if !has_commits {
                // 保留原内容，在末尾追加 component_commits section
                lines.extend(content.lines().map(|l| l.to_string()));
                if !lines.is_empty() && !lines.last().unwrap().is_empty() {
                    lines.push(String::new());
                }
            } else {
                // 替换 existing [component_commits] section
                let mut in_commits = false;
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed == "[component_commits]" {
                        in_commits = true;
                        continue;
                    }
                    if in_commits && (trimmed.starts_with('[') || trimmed.is_empty()) {
                        // 遇到下一个 section 或空行，结束 component_commits
                        if trimmed.starts_with('[') {
                            in_commits = false;
                        }
                        lines.push(line.to_string());
                    }
                    if !in_commits {
                        lines.push(line.to_string());
                    }
                }
            }
        }
        
        // 写入 [component_commits] section
        lines.push("[component_commits]".to_string());
        lines.push("; 组件 commit 版本记录（镜像测试阶段自动生成）".to_string());
        for (name, commit) in &self.component_commits {
            lines.push(format!("{} = {}", name, commit));
        }
        
        fs::write(&path, lines.join("\n"))?;
        Ok(())
    }

    /// 2026-08-23 新增：获取运行时版本号
    pub fn get_runtime_version(&self, key: &str) -> Option<&String> {
        self.runtime_versions.get(key)
    }

    /// 2026-08-23 新增：设置运行时版本号并保存到 ini 文件
    pub fn set_and_save_runtime_version(&mut self, key: &str, version: &str) -> Result<()> {
        // 更新内存
        self.runtime_versions.insert(key.to_string(), version.to_string());

        // 保存到 ini 文件
        let path = get_config_path();
        let original = fs::read_to_string(&path).ok();

        let mut lines = Vec::new();

        if let Some(content) = original {
            let sections = parse_ini_sections(&content)?;
            let has_versions = sections.contains_key("runtime_versions");

            if !has_versions {
                // 保留原内容，在末尾追加 runtime_versions section
                lines.extend(content.lines().map(|l| l.to_string()));
                if !lines.is_empty() && !lines.last().unwrap().is_empty() {
                    lines.push(String::new());
                }
            } else {
                // 替换 existing [runtime_versions] section
                let mut in_versions = false;
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed == "[runtime_versions]" {
                        in_versions = true;
                        continue;
                    }
                    if in_versions && (trimmed.starts_with('[') || trimmed.is_empty()) {
                        // 遇到下一个 section 或空行，结束 runtime_versions
                        if trimmed.starts_with('[') {
                            in_versions = false;
                        }
                        lines.push(line.to_string());
                    }
                    if !in_versions {
                        lines.push(line.to_string());
                    }
                }
            }

            // 2026-08-23: 合并 INI 中已有的 runtime_versions 条目到内存
            // 防止多次调用时后写入的覆盖先写入的（Git/Node/Python/NewAPI 各自 clone 了 mirror_config）
            if let Some(existing_entries) = sections.get("runtime_versions") {
                for (k, v) in existing_entries {
                    if !k.is_empty() && !v.is_empty()
                        && !self.runtime_versions.contains_key(k)
                    {
                        self.runtime_versions.insert(k.clone(), v.clone());
                    }
                }
            }
        }

        // 写入 [runtime_versions] section（合并后的完整列表）
        lines.push("[runtime_versions]".to_string());
        lines.push("; 运行时版本号记录（安装时自动生成，用于缓存校验）".to_string());
        for (name, ver) in &self.runtime_versions {
            lines.push(format!("{} = {}", name, ver));
        }

        fs::write(&path, lines.join("\n"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_ini_sections() {
        let content = r#"
; comment
[github]
ghproxy = https://ghproxy.com/
[npmmirror]
registry = https://registry.npmmirror.com/
"#;
        let sections = parse_ini_sections(content).unwrap();
        assert_eq!(sections.len(), 2);
        assert!(sections.contains_key("github"));
        assert!(sections.contains_key("npmmirror"));
        assert_eq!(sections["github"].len(), 1);
        assert_eq!(sections["github"][0].0, "ghproxy");
        assert_eq!(sections["github"][0].1, "https://ghproxy.com/");
    }

    #[test]
    fn test_parse_mirror_entry() {
        let entry = parse_mirror_entry("ghproxy", "https://ghproxy.com/https://github.com/");
        assert!(entry.is_some());
        assert_eq!(entry.unwrap().name, "ghproxy");

        let invalid = parse_mirror_entry("bad", "not-a-url");
        assert!(invalid.is_none());
    }

    #[test]
    fn test_default_config() {
        let config = MirrorConfig::default();
        assert!(!config.github.is_empty());
        assert!(!config.npm.is_empty());
        assert!(!config.pip.is_empty());
    }
}
