# P2：Portable 运行时管理

> 状态：✅ 已完成（生产代码）  
> 对应源码：src/runtime/mod.rs, src/runtime/portable_git.rs, src/runtime/portable_node.rs, src/runtime/portable_python.rs  
> 文档更新：2026-08-29（v2.0 / v18.12，新增下载韧性 + Node.js CDN）

---

## 一、RuntimeManager 三态逻辑

每个运行时有三种状态：

1. **System**：系统已安装（通过 `which` crate 检测）
2. **Portable**：已下载到安装目录 `runtimes/`
3. **Missing**：需要下载安装

**检测流程**：
```rust
pub enum RuntimeStatus {
    System(PathBuf),      // 系统已安装
    Portable(PathBuf),    // 本地已安装
    Missing,              // 需要下载
}
```

## 二、PortableGit

- **来源**：GitHub Release API → git-for-windows/git → latest release
- **文件名**：PortableGit.7z.exe（固定名，不含版本号）
- **下载韧性**（v18.12）：
  - download_with_preferred_fallback() 多镜像降级
  - resume:true 断点续传
- **解压**：sevenz-rust → runtimes/git/
- **验证**：`runtimes/git/cmd/git.exe --version`
- **INI 版本校验**：[runtime_versions] PortableGit = v2.55.0.windows.5

## 三、Node.js Portable

- **来源**：nodejs.org/dist/index.json → LTS 版本
- **文件名**：node-v{v}-win-x64.zip
- **下载韧性**（v18.12 新增）：
  - 双源循环：npmmirror CDN → nodejs.org 兜底
  - resume:true 断点续传
  - 下载速度 10-20x 提升
- **解压**：zip crate → runtimes/node/
- **验证**：`runtimes/node/node.exe --version`
- **INI 版本校验**：[runtime_versions] Node.js = v24.19.0

## 四、Python Portable（动态版本）

- **来源**：astral-sh/python-build-standalone → latest release → 最高稳定版
- **下载韧性**（v18.12）：
  - download_with_preferred_fallback() 多镜像降级
  - resume:true 断点续传
- **解压**：flate2 + tar → runtimes/python/
- **pip 安装**：优先 `python -m ensurepip`（零网络依赖），fallback 到 get-pip.py
- **版本策略**：不再锁死 3.12.8，跟随官方发布（当前为 3.14.7）
- **缓存清理**：DL_runtimes 中保留最新版本，删除过期旧版本
- **INI 版本校验**：[runtime_versions] Python = cpython-3.14.7+...-x86_64-pc-windows-msvc-install_only.tar.gz

**版本选择逻辑**：
```rust
// portable_python.rs: get_latest_python_standalone_url()
// 1. 拉取 latest release 的 assets
// 2. 过滤 x86_64-pc-windows-msvc-install_only.tar.gz
// 3. 排除 freethreaded、RC/beta
// 4. 按 (major, minor, patch) 降序排序
// 5. 返回最高稳定版
```

**教训**：`/releases/latest` API 返回的是发布日期最新的 Release，每个 Release 包含多个 Python 版本，必须排序后选最高稳定版。

## 五、MSVC Build Tools（必需组件）

> 详见 P3 部署引擎的 msvc_ops.rs 部分

- **v18.11 起改为必需组件**（UI 锁定 + 默认勾选 + 未检测到强制安装）
- 30 分钟总超时 + 180 秒活动看门狗 + 3 次重试 + vswhere 二次验证
- 失败阻断整体安装

## 六、DL_runtimes 缓存

所有安装包缓存到 `DL_runtimes/`：

```
DL_runtimes/
├── PortableGit.7z.exe
├── node-v*.zip
├── cpython-*.tar.gz
├── new-api.exe
├── VCPToolBox.tar.gz    # Phase2 测试缓存，安装时复用
├── VCPChat.tar.gz
├── VCPBackUpDEV.tar.gz
└── VCPDistributedServer.tar.gz
```

**复用规则**：
- Python：精确匹配文件名（版本号必须一致）
- 其他：文件存在则直接复用，版本升级时自动下载新版
- **INI 版本校验**（v18.8+）：文件存在 ≠ 版本正确，必须校验 [runtime_versions] 才用缓存

## 七、运行时下载韧性（v18.12）

| 运行时 | 多镜像降级 | 断点续传 | Node.js CDN |
|--------|-----------|---------|------------|
| PortableGit | ✅ download_with_preferred_fallback | ✅ resume:true | - |
| Node.js | ✅ 双源循环（npmmirror→nodejs.org） | ✅ resume:true | ✅ |
| Python | ✅ download_with_preferred_fallback | ✅ resume:true | - |
| NewAPI | ✅ download_with_preferred_fallback | ✅ resume:true | - |

---

*文档更新：2026-08-29 | 基于实际生产代码*
