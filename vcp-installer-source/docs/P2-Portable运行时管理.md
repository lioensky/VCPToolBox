# P2 - Portable运行时管理

> 本文档基于实际代码逐行核对后重写（2026-03-10），与代码100%一致。

## 一、概述

P2阶段负责检测系统环境、管理三个Portable运行时（Git、Node.js、Python）。核心设计原则：**环境隔离**——所有运行时下载到安装目录的 `runtimes/` 子目录，不污染系统环境。

### 涉及文件

| 文件 | 路径 | 职责 |
|------|------|------|
| detector.rs | src/installer/detector.rs | 系统环境检测（Git/Node/Python/网络/磁盘） |
| env.rs | src/utils/env.rs | PATH环境变量构建与应用 |
| portable_git.rs | src/runtime/portable_git.rs | PortableGit 下载/解压/验证 |
| portable_node.rs | src/runtime/portable_node.rs | Node.js Portable 下载/解压/验证 |
| portable_python.rs | src/runtime/portable_python.rs | Python Standalone 下载/解压/配置/pip/验证 |
| mod.rs | src/runtime/mod.rs | RuntimeManager 协调器（三态逻辑） |

### 依赖的P0/P1模块

- `app.rs`: DependencyStatus, EnvCheckResult, ProgressEvent, GithubMirror
- `downloader.rs`: download_with_retry, get_github_release_url, get_nodejs_lts_version, apply_mirror
- `extractor.rs`: extract, detect_format
- `platform.rs`: get_os_version, get_available_disk_space_gb

---

## 二、detector.rs — 系统环境检测

### 公开接口

```rust
/// 检测单个工具是否存在及其版本
pub fn detect_tool(_name: &str, command: &str, version_flag: &str) -> DependencyStatus

/// 检测完整环境（Git/Node/Python/网络/磁盘），返回EnvCheckResult
pub async fn detect_environment(install_path: &Path) -> EnvCheckResult
```

### 内部函数

```rust
/// 统一的输出文本读取（从stdout/stderr中提取版本信息）
fn read_output_text(stdout: &[u8], stderr: &[u8]) -> String

/// Python检测（尝试python/python3/py三个命令，排除WindowsApps）
fn detect_python() -> DependencyStatus

/// 网络可达性检测（HEAD→GET双重兜底）
async fn check_network(url: &str) -> bool
```

### detect_tool() 实现

```rust
pub fn detect_tool(_name: &str, command: &str, version_flag: &str) -> DependencyStatus {
    // 1. which(command) 查找可执行文件路径
    // 2. Command::new(&path).arg(version_flag).output()
    // 3. read_output_text(stdout, stderr) 提取版本
    // 4. 版本为空 → "版本未知"
    // 5. 返回 DependencyStatus::Installed(version)
    // Err → DependencyStatus::NotFound
}
```

### detect_python() 实现

```rust
fn detect_python() -> DependencyStatus {
    let commands = ["python", "python3", "py"];
    for cmd in commands {
        let Ok(path) = which(cmd) else { continue; };
        
        // 排除 WindowsApps 虚假Python
        if path.to_string_lossy().to_lowercase().contains("windowsapps") {
            continue;
        }
        
        // py 命令特殊处理：加 -3 参数指定Python3
        let output = if cmd == "py" {
            Command::new(&path).args(["-3", "--version"]).output()
        } else {
            Command::new(&path).arg("--version").output()
        };
        
        // 接受 "Python 3.x" 或 "Python 2.x"（检测到Python2也报告版本）
        let version = read_output_text(stdout, stderr);
        if version.starts_with("Python 3.") || version.starts_with("Python 2.") {
            return DependencyStatus::Installed(version);
        }
    }
    DependencyStatus::NotFound
}
```

### detect_environment() 实现

```rust
pub async fn detect_environment(install_path: &Path) -> EnvCheckResult {
    // 1. 系统工具检测
    let git_status = detect_tool("Git", "git", "--version");
    let node_status = detect_tool("Node.js", "node", "--version");
    let python_status = detect_python();
    
    // 2. 网络检测 — tokio::join! 并发执行
    let (github_ok, npm_ok) = tokio::join!(
        check_network("https://github.com"),
        check_network("https://registry.npmjs.org"),
    );
    
    // 3. 系统信息
    let disk_space = get_available_disk_space_gb(install_path);
    let os_version = get_os_version();
    
    // 4. 构建结果
    EnvCheckResult {
        git: git_status,
        node: node_status,
        python: python_status,
        github_reachable: github_ok,
        npm_reachable: npm_ok,
        disk_space_gb: disk_space,
        disk_space_ok: disk_space >= 3.0,
        os_info: os_version,
    }
}
```

### check_network() 实现 — HEAD→GET双重兜底

```rust
async fn check_network(url: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build() {
        Ok(c) => c,
        Err(_) => return false,  // Client构建失败直接返回false
    };
    
    // 第一层：HEAD请求
    if let Ok(resp) = client.head(url).send().await {
        if resp.status().is_success() {  // 检查状态码而非仅is_ok
            return true;
        }
    }
    
    // 第二层：GET兜底（某些站点对HEAD不友好）
    if let Ok(resp) = client.get(url).send().await {
        return resp.status().is_success();
    }
    
    false
}
```

### read_output_text() — 输出文本统一提取

```rust
fn read_output_text(stdout: &[u8], stderr: &[u8]) -> String {
    let out = String::from_utf8_lossy(stdout).trim().to_string();
    if !out.is_empty() { return out; }
    String::from_utf8_lossy(stderr).trim().to_string()
}
```

---

## 三、env.rs — 环境变量操作

### 公开接口

```rust
/// 构建包含所有Portable运行时的PATH字符串
pub fn build_runtime_path(runtimes_dir: &Path) -> String

/// 将构建的PATH应用到当前进程
pub fn apply_runtime_path(runtimes_dir: &Path)

/// 生成BAT脚本中的SET PATH行（相对路径）
pub fn generate_bat_path_line(runtimes_dir_relative: &str) -> String
```

### build_runtime_path() 实现

```rust
pub fn build_runtime_path(runtimes_dir: &Path) -> String {
    let mut paths: Vec<PathBuf> = vec![
        runtimes_dir.join("node"),
        runtimes_dir.join("git").join("cmd"),
        runtimes_dir.join("git").join("bin"),     // ← git/bin/ 也包含
        runtimes_dir.join("python"),
        runtimes_dir.join("python").join("Scripts"),
    ];
    
    // 追加系统原有PATH — 使用标准库API
    if let Some(system_path) = env::var_os("PATH") {
        paths.extend(env::split_paths(&system_path));
    }
    
    // 使用 env::join_paths 正确拼接（处理路径中的特殊字符）
    env::join_paths(&paths)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| {
            // fallback: 回退到原始PATH
            env::var("PATH").unwrap_or_default()
        })
}
```

> **设计说明**：使用 `env::join_paths` + `env::split_paths` 是Rust标准做法，能正确处理路径中含分号等特殊字符的情况，比手动 `.join(";")` 更安全。

### apply_runtime_path() 实现

```rust
pub fn apply_runtime_path(runtimes_dir: &Path) {
    let new_path = build_runtime_path(runtimes_dir);
    env::set_var("PATH", new_path);
}
```

### generate_bat_path_line() 实现

```rust
pub fn generate_bat_path_line(runtimes_dir_relative: &str) -> String {
    // 路径清理：trim斜杠 + 规范化为Windows反斜杠
    let base = if runtimes_dir_relative.is_empty() {
        "%~dp0runtimes".to_string()   // 空路径默认值
    } else {
        runtimes_dir_relative.trim_matches('/').trim_matches('\\')
            .replace('/', "\\")
    };
    
    format!(
        "SET PATH={b}\\node;{b}\\git\\cmd;{b}\\git\\bin;{b}\\python;{b}\\python\\Scripts;%PATH%",
        b = base
    )
}
```

> **注意**：bat行中包含 `git\\bin`，与 `build_runtime_path()` 保持一致。

---

## 四、portable_git.rs — PortableGit 管理

### 结构体

```rust
#[derive(Debug, Clone)]
pub struct PortableGit {
    pub install_dir: PathBuf,  // runtimes/git/
    pub git_exe: PathBuf,      // runtimes/git/cmd/git.exe
}
```

### 公开接口

```rust
/// 检查是否已安装
pub fn is_installed(runtimes_dir: &Path) -> bool {
    Self::git_exe_path(runtimes_dir).exists()
}

/// git.exe 路径
pub fn git_exe_path(runtimes_dir: &Path) -> PathBuf {
    runtimes_dir.join("git").join("cmd").join("git.exe")
}

/// 下载安装PortableGit
pub async fn install(
    runtimes_dir: &Path,
    mirror: &GithubMirror,
    step_index: usize,
    progress_tx: &Sender<ProgressEvent>,
) -> Result<Self>

/// 验证安装完整性
pub fn verify(&self) -> Result<String>
```

### install() 实现 — async块错误处理模式

```rust
pub async fn install(...) -> Result<Self> {
    progress_tx.send(ProgressEvent::StepStarted { step_index, name: "安装 Portable Git".into() })?;
    
    // 整个安装流程包裹在async块中，统一错误处理
    let result: Result<Self> = async {
        fs::create_dir_all(runtimes_dir)?;
        
        // 1. 查询GitHub Release
        let (download_url, _asset_name) = get_github_release_url(
            "git-for-windows/git", "PortableGit"
        ).await?;
        
        // 2. URL验证：检查是否为64位7z.exe格式
        if !download_url.contains("64-bit.7z.exe") {
            progress_tx.send(ProgressEvent::Log(
                format!("⚠ Git下载URL可能不是预期格式: {}", download_url)
            ))?;
        }
        
        // 3. 应用镜像
        let final_url = apply_mirror(&download_url, &mirror.prefix());
        
        // 4. 下载
        let archive_path = download_with_retry(
            &DownloadConfig { url: final_url, dest: temp_path, step_index, resume: false },
            progress_tx, 3
        ).await?;
        
        // 5. 解压 — 双层保险
        let git_dir = runtimes_dir.join("git");
        let extracted = match extractor::extract(&archive_path, &git_dir).await {
            Ok(p) => p,
            Err(_) => extract_self_extracting_7z(&archive_path, &git_dir)?  // 降级：SFX自解压
        };
        
        // 6. 清理临时文件
        let _ = fs::remove_file(&archive_path);
        
        // 7. 构建 + 验证
        let pg = Self { install_dir: git_dir, git_exe: Self::git_exe_path(runtimes_dir) };
        pg.verify()?;
        Ok(pg)
    }.await;
    
    // 统一发送成功/失败事件
    match &result {
        Ok(_) => progress_tx.send(ProgressEvent::StepCompleted { step_index })?,
        Err(e) => progress_tx.send(ProgressEvent::StepFailed {
            step_index, error: format!("{:#}", e)
        })?,
    }
    result
}
```

> **架构要点**：async块 + match result 模式确保**无论成功还是失败，TUI都能正确更新步骤状态**。文档原始设计中直接用`?`传播错误，失败时不会发StepFailed。

### extract_self_extracting_7z() — 解压降级方案

```rust
fn extract_self_extracting_7z(archive_path: &Path, dest_dir: &Path) -> Result<PathBuf> {
    fs::create_dir_all(dest_dir)?;
    let status = std::process::Command::new(archive_path)
        .arg(format!("-o{}", dest_dir.display()))  // 7z标准格式：-oOutputDir（无空格）
        .arg("-y")
        .status()
        .with_context(|| "执行自解压失败")?;
    
    if !status.success() {
        bail!("自解压返回非零退出码");
    }
    Ok(dest_dir.to_path_buf())
}
```

### verify() 实现

```rust
pub fn verify(&self) -> Result<String> {
    // 1. 文件存在检查
    if !self.git_exe.exists() {
        bail!("git.exe 不存在: {:?}", self.git_exe);
    }
    
    // 2. 执行 git --version
    let output = Command::new(&self.git_exe)
        .arg("--version")
        .output()
        .with_context(|| format!("执行 git --version 失败: {:?}", self.git_exe))?;
    
    // 3. 退出码检查
    if !output.status.success() {
        bail!("git --version 返回非零退出码");
    }
    
    // 4. 版本格式验证
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !version.contains("git version") {
        bail!("git版本输出异常: {}", version);
    }
    Ok(version)
}
```

---

## 五、portable_node.rs — Node.js Portable 管理

### 结构体

```rust
#[derive(Debug, Clone)]
pub struct PortableNode {
    pub install_dir: PathBuf,  // runtimes/node/
    pub node_exe: PathBuf,     // runtimes/node/node.exe
    pub npm_cmd: PathBuf,      // runtimes/node/npm.cmd
}
```

### 公开接口

```rust
pub fn is_installed(runtimes_dir: &Path) -> bool
pub fn node_exe_path(runtimes_dir: &Path) -> PathBuf   // → runtimes/node/node.exe
pub fn npm_cmd_path(runtimes_dir: &Path) -> PathBuf     // → runtimes/node/npm.cmd
pub async fn install(runtimes_dir: &Path, step_index: usize, progress_tx: &Sender<ProgressEvent>) -> Result<Self>
pub fn verify(&self) -> Result<String>
```

> **注意**：Node.js的install没有mirror参数，因为nodejs.org的下载地址不需要GitHub镜像。

### install() 实现

```rust
pub async fn install(...) -> Result<Self> {
    progress_tx.send(ProgressEvent::StepStarted { ... })?;
    
    let result: Result<Self> = async {
        // 1. 获取LTS版本号
        let version = get_nodejs_lts_version().await?;
        
        // 2. 构建下载URL
        let url = format!("https://nodejs.org/dist/{v}/node-{v}-win-x64.zip", v = version);
        
        // 3. 下载
        let archive_path = download_with_retry(&config, progress_tx, 3).await?;
        
        // 4. 解压到临时目录
        let temp_extract = runtimes_dir.join("node_temp");
        let extracted = extractor::extract(&archive_path, &temp_extract).await?;
        
        // 5. 找到Node根目录 — 三层回退
        let node_root = find_node_root(&temp_extract)?;
        
        // 6. 目录提升
        let node_dir = runtimes_dir.join("node");
        if node_root == temp_extract {
            fs::rename(&temp_extract, &node_dir)?;  // 根就是temp→直接rename
        } else {
            fs::rename(&node_root, &node_dir)?;      // 子目录→rename子目录
            let _ = fs::remove_dir_all(&temp_extract);
        }
        
        // 7. 清理 + 构建 + 验证
        let _ = fs::remove_file(&archive_path);
        let pn = Self { install_dir: node_dir, node_exe: ..., npm_cmd: ... };
        pn.verify()?;
        Ok(pn)
    }.await;
    
    match &result { /* StepCompleted / StepFailed */ }
    result
}
```

### find_node_root() — 三层回退搜索

```rust
fn find_node_root(extracted: &Path) -> Result<PathBuf> {
    // 层1：直接在extracted下找node.exe
    if extracted.join("node.exe").exists() {
        return Ok(extracted.to_path_buf());
    }
    
    // 层2：一级子目录中找node.exe
    for entry in fs::read_dir(extracted)? {
        let path = entry?.path();
        if path.is_dir() && path.join("node.exe").exists() {
            return Ok(path);
        }
    }
    
    // 层3：只有一个子目录时fallback使用（可能node.exe在更深层）
    let entries: Vec<_> = fs::read_dir(extracted)?.filter_map(|e| e.ok()).collect();
    if entries.len() == 1 && entries[0].path().is_dir() {
        return Ok(entries[0].path());
    }
    
    bail!("无法在解压目录中找到Node.js根目录")
}
```

### verify() 实现

```rust
pub fn verify(&self) -> Result<String> {
    // 1. node.exe 存在检查
    if !self.node_exe.exists() {
        bail!("node.exe 不存在");
    }
    // 2. npm.cmd 存在检查
    if !self.npm_cmd.exists() {
        bail!("npm.cmd 不存在");
    }
    
    // 3. node --version
    let output = Command::new(&self.node_exe).arg("--version").output()?;
    if !output.status.success() { bail!("node --version 失败"); }
    
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !version.starts_with('v') {
        bail!("node版本格式异常: {}", version);
    }
    Ok(version)
}
```

---

## 六、portable_python.rs — Python Standalone 管理

### 常量定义

```rust
const PYTHON_VERSION: &str = "3.12.8";
const PYTHON_BUILD_TAG: &str = "20250106";
const PYPI_MIRROR: &str = "https://pypi.tuna.tsinghua.edu.cn/simple";
```

### 结构体

```rust
#[derive(Debug, Clone)]
pub struct PortablePython {
    pub install_dir: PathBuf,  // runtimes/python/
    pub python_exe: PathBuf,   // runtimes/python/python.exe
    pub pip_exe: PathBuf,      // runtimes/python/Scripts/pip.exe
}
```

### 公开接口

```rust
pub fn is_installed(runtimes_dir: &Path) -> bool {
    // 同时检查python.exe和pip.exe（比文档更严格）
    Self::python_exe_path(runtimes_dir).exists()
        && Self::pip_exe_path(runtimes_dir).exists()
}

pub fn python_exe_path(runtimes_dir: &Path) -> PathBuf  // → runtimes/python/python.exe
pub fn pip_exe_path(runtimes_dir: &Path) -> PathBuf      // → runtimes/python/Scripts/pip.exe

pub async fn install(
    runtimes_dir: &Path, mirror: &GithubMirror,
    step_index: usize, progress_tx: &Sender<ProgressEvent>
) -> Result<Self>

pub fn pip_install(&self, requirements_file: &Path, use_mirror: bool) -> Result<()>
pub fn verify(&self) -> Result<String>
```

### install() 实现

```rust
pub async fn install(...) -> Result<Self> {
    progress_tx.send(ProgressEvent::StepStarted { ... })?;
    progress_tx.send(ProgressEvent::Log(
        format!("Python 目标版本: {} ({})", PYTHON_VERSION, PYTHON_BUILD_TAG)
    ))?;
    
    let result: Result<Self> = async {
        // 1. 构建python-build-standalone下载URL
        let url = format!(
            "https://github.com/indygreg/python-build-standalone/releases/download/{tag}/cpython-{ver}+{tag}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
            tag = PYTHON_BUILD_TAG, ver = PYTHON_VERSION
        );
        let final_url = apply_mirror(&url, &mirror.prefix());
        
        // 2. 下载
        let archive = download_with_retry(&config, progress_tx, 3).await?;
        
        // 3. 解压
        let temp_extract = runtimes_dir.join("python_temp");
        let _ = fs::remove_dir_all(&temp_extract);  // 清理旧临时目录
        fs::create_dir_all(&temp_extract)?;
        let extracted = extractor::extract(&archive, &temp_extract).await?;
        
        // 4. 找到Python根目录 — 三级递归搜索
        let python_root = find_python_root(&temp_extract)?;
        
        // 5. 目录提升
        let python_dir = runtimes_dir.join("python");
        if python_root == temp_extract {
            fs::rename(&temp_extract, &python_dir)?;
        } else {
            fs::rename(&python_root, &python_dir)?;
            let _ = fs::remove_dir_all(&temp_extract);
        }
        
        // 6. 清理临时文件
        let _ = fs::remove_file(&archive);
        
        // 7. 配置pth文件（启用import site）
        configure_pth_file(&python_dir)?;
        
        // 8. 安装pip
        install_pip(&python_dir).await?;
        
        // 9. 构建 + 验证
        let pp = Self { install_dir: python_dir, python_exe: ..., pip_exe: ... };
        pp.verify()?;
        Ok(pp)
    }.await;
    
    match &result { /* StepCompleted / StepFailed */ }
    result
}
```

### configure_pth_file() — pth文件配置（搜索fallback）

```rust
fn configure_pth_file(python_dir: &Path) -> Result<()> {
    // 1. 尝试精确路径
    let pth_file = python_dir.join(format!("python{}{}._pth",
        PYTHON_VERSION.split('.').nth(0).unwrap_or("3"),
        PYTHON_VERSION.split('.').nth(1).unwrap_or("12")
    ));
    
    let pth_path = if pth_file.exists() {
        pth_file
    } else {
        // 2. 搜索fallback：遍历目录找所有 pythonXX._pth
        let mut found = None;
        if let Ok(entries) = fs::read_dir(python_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if name.starts_with("python") && name.ends_with("._pth") {
                    found = Some(entry.path());
                    break;
                }
            }
        }
        match found {
            Some(p) => p,
            None => return Ok(()),  // 没有pth文件→跳过（不报错）
        }
    };
    
    // 3. 读取并修改
    let content = fs::read_to_string(&pth_path)?;
    if content.contains("#import site") {
        // 取消注释
        let new_content = content.replace("#import site", "import site");
        fs::write(&pth_path, new_content)?;
    } else if !content.contains("import site") {
        // 完全没有import site → 追加
        let mut new_content = content;
        new_content.push_str("import site\n");
        fs::write(&pth_path, new_content)?;
    }
    Ok(())
}
```

### install_pip() — pip安装（含下载重试）

```rust
async fn install_pip(python_dir: &Path) -> Result<()> {
    let python_exe = python_dir.join("python.exe");
    let get_pip_path = python_dir.join("get-pip.py");
    
    // 1. 下载get-pip.py — 独立重试函数
    download_get_pip(&get_pip_path).await?;
    
    // 2. 运行 python get-pip.py
    let status = Command::new(&python_exe)
        .arg(&get_pip_path)
        .arg("--disable-pip-version-check")
        .current_dir(python_dir)
        .status()
        .with_context(|| "执行 get-pip.py 失败")?;
    
    // 3. 清理（无论成功失败）
    let _ = fs::remove_file(&get_pip_path);
    
    if !status.success() {
        bail!("pip安装失败");
    }
    Ok(())
}

/// 下载get-pip.py，含3次重试 + 退避延迟
async fn download_get_pip(dest: &Path) -> Result<()> {
    let url = "https://bootstrap.pypa.io/get-pip.py";
    let max_retries = 3;
    
    for attempt in 0..max_retries {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()?;
        
        match client.get(url).send().await {
            Ok(resp) if resp.status().is_success() => {
                let content = resp.text().await?;
                fs::write(dest, &content)?;
                return Ok(());
            }
            _ => {
                if attempt < max_retries - 1 {
                    tokio::time::sleep(Duration::from_secs(2 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    bail!("下载 get-pip.py 失败（已重试{}次）", max_retries)
}
```

### pip_install() — 安装requirements

```rust
pub fn pip_install(&self, requirements_file: &Path, use_mirror: bool) -> Result<()> {
    // 1. requirements文件存在检查
    if !requirements_file.exists() {
        bail!("requirements文件不存在: {:?}", requirements_file);
    }
    
    // 2. 构建命令
    let mut cmd = Command::new(&self.python_exe);
    cmd.args(["-m", "pip", "install", "-r"])
       .arg(requirements_file)
       .arg("--disable-pip-version-check")
       .current_dir(&self.install_dir);
    
    // 3. 清华镜像
    if use_mirror {
        cmd.args(["-i", PYPI_MIRROR]);
    }
    
    // 4. 执行
    let status = cmd.status()?;
    if !status.success() {
        bail!("pip install 失败");
    }
    Ok(())
}
```

### verify() — 双重验证（python + pip）

```rust
pub fn verify(&self) -> Result<String> {
    // 1. 文件存在检查
    if !self.python_exe.exists() { bail!("python.exe 不存在"); }
    if !self.pip_exe.exists() { bail!("pip.exe 不存在"); }
    
    // 2. python --version
    let output = Command::new(&self.python_exe).arg("--version").output()?;
    if !output.status.success() { bail!("python --version 失败"); }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !version.starts_with("Python 3.") { bail!("版本异常: {}", version); }
    
    // 3. pip --version（双重验证）
    let pip_output = Command::new(&self.python_exe)
        .args(["-m", "pip", "--version"]).output()?;
    if !pip_output.status.success() { bail!("pip --version 失败"); }
    
    Ok(version)
}
```

### find_python_root() — 三级递归搜索

```rust
fn find_python_root(extracted: &Path) -> Result<PathBuf> {
    // 层1：当前目录
    if extracted.join("python.exe").exists() {
        return Ok(extracted.to_path_buf());
    }
    // 层2：一级子目录
    for entry in fs::read_dir(extracted)? {
        let path = entry?.path();
        if path.is_dir() && path.join("python.exe").exists() {
            return Ok(path);
        }
    }
    // 层3：二级子目录
    for entry in fs::read_dir(extracted)? {
        let path = entry?.path();
        if path.is_dir() {
            for sub in fs::read_dir(&path)? {
                let sub_path = sub?.path();
                if sub_path.is_dir() && sub_path.join("python.exe").exists() {
                    return Ok(sub_path);
                }
            }
        }
    }
    bail!("无法找到Python根目录")
}
```

---

## 七、runtime/mod.rs — RuntimeManager 协调器

### 模块导出

```rust
pub mod portable_git;
pub mod portable_node;
pub mod portable_python;
```

### 结构体

```rust
#[derive(Debug)]
pub struct RuntimeManager {
    pub runtimes_dir: PathBuf,
    pub git: Option<PortableGit>,
    pub node: Option<PortableNode>,
    pub python: Option<PortablePython>,
}
```

### 公开接口

```rust
pub fn new(install_path: &Path) -> Self
pub async fn ensure_all(
    &mut self, env_check: &EnvCheckResult, mirror: &GithubMirror,
    progress_tx: &Sender<ProgressEvent>, step_offset: usize
) -> Result<()>
pub fn build_path_env(&self) -> String
pub fn apply_path_env(&self)
```

### ensure_all() — 三态逻辑协调器

```rust
pub async fn ensure_all(&mut self, ...) -> Result<()> {
    fs::create_dir_all(&self.runtimes_dir)?;
    
    // Git (step_offset + 0)
    self.git = Some(self.ensure_git(env_check, mirror, progress_tx, step_offset).await?);
    
    // Node (step_offset + 1)
    self.node = Some(self.ensure_node(env_check, progress_tx, step_offset + 1).await?);
    
    // Python (step_offset + 2)
    self.python = Some(self.ensure_python(env_check, mirror, progress_tx, step_offset + 2).await?);
    
    Ok(())
}
```

### ensure_*() — 核心三态逻辑

每个运行时的ensure函数都遵循相同的三态模式：

```rust
async fn ensure_git(&self, ...) -> Result<PortableGit> {
    log_system_status("Git", &env_check.git, progress_tx)?;
    
    if PortableGit::is_installed(&self.runtimes_dir) {
        // 状态1：已安装 → verify检查
        let existing = PortableGit { /* 从已有路径构建 */ };
        match existing.verify() {
            Ok(_version) => {
                // verify通过 → 跳过安装
                progress_tx.send(ProgressEvent::StepSkipped { step_index })?;
                return Ok(existing);
            }
            Err(_) => {
                // 状态2：已安装但verify失败 → 删除重装
                progress_tx.send(ProgressEvent::Log("验证失败，重新安装...".into()))?;
                let _ = fs::remove_dir_all(install_dir);
            }
        }
    }
    
    // 状态3：未安装（或删除后重装）→ 全新安装
    PortableGit::install(&self.runtimes_dir, mirror, step_index, progress_tx).await
}
```

> **三态逻辑总结**：
> 1. ✅ 已安装 + verify通过 → StepSkipped，复用existing
> 2. ⚠️ 已安装 + verify失败 → 删除旧目录 → 全新安装
> 3. 🆕 未安装 → 全新安装

### log_system_status() — 系统状态日志

```rust
fn log_system_status(name: &str, status: &DependencyStatus, tx: &Sender<ProgressEvent>) -> Result<()> {
    let msg = match status {
        DependencyStatus::Installed(v) =>
            format!("检测到系统 {}: {}，但为保证环境隔离，仍优先使用 Portable 版", name, v),
        DependencyStatus::NotFound =>
            format!("未检测到系统 {}，将安装 Portable 版", name),
        DependencyStatus::Checking =>
            format!("{} 仍处于检测中，按需准备 Portable 版", name),
        DependencyStatus::WillUsePortable =>
            format!("{} 已标记为使用 Portable 版", name),
    };
    tx.send(ProgressEvent::Log(msg))?;
    Ok(())
}
```

### build_path_env() / apply_path_env()

```rust
pub fn build_path_env(&self) -> String {
    env::build_runtime_path(&self.runtimes_dir)
}

pub fn apply_path_env(&self) {
    env::apply_runtime_path(&self.runtimes_dir);
}
```

---

## 八、验收标准

| # | 验收项 | 验证方式 |
|---|--------|----------|
| 1 | cargo build编译通过 | 0 error |
| 2 | 环境检测：detect_environment返回正确的EnvCheckResult | Git/Node/Python/网络/磁盘 全检测 |
| 3 | Python检测：排除WindowsApps虚假Python | `contains("windowsapps")` + `py -3` |
| 4 | 网络检测：GitHub和npm可达性 | `tokio::join!` + HEAD→GET双重兜底 |
| 5 | PortableGit：下载+解压+SFX降级+验证 | install + extractor→SFX fallback + verify |
| 6 | PortableNode：下载+解压+目录提升+验证 | install + find_node_root三层 + verify(node+npm) |
| 7 | PortablePython：下载+解压+pth配置+pip安装+双重验证 | install + configure_pth(搜索fallback) + install_pip(3重试) + verify(python+pip) |
| 8 | PATH构建：env::join_paths标准API | build_runtime_path + generate_bat_path_line |
| 9 | RuntimeManager：三态逻辑协调 | ensure_all → ensure_*(已装verify通过→跳过 / verify失败→重装 / 未装→新装) |

---

## 九、与P1的接口依赖

| P2调用 | P1提供 |
|--------|--------|
| `download_with_retry(config, tx, 3)` | downloader.rs |
| `get_github_release_url(repo, pattern)` | downloader.rs |
| `get_nodejs_lts_version()` | downloader.rs |
| `apply_mirror(url, prefix)` | downloader.rs |
| `extractor::extract(archive, dest)` | extractor.rs |