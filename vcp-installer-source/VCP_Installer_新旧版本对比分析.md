# VCP Installer 新旧版本对比分析报告

> 生成时间：2026-08-29
> 原始代码路径：D:\Desktop\vcp-installer-source-old
> 新版本路径：D:\Desktop\vcp-installer-source-new
> 文档用途：项目演进存档，记录所有改进
> **版本演进**：v10 → v18.12（内部精修版）/ TUI 用户可见版 v2.0
> **时间跨度**：2026-08-11 ~ 2026-08-29（19 天）

---

## 一、项目概述

VCP Installer 是一个 Rust 编写的 Windows TUI 单 exe 工具，用于一键部署 VCP（Variable & Command Protocol）环境，包含 VCPToolBox（后端大脑）、VCPChat（前端界面）、NewAPI（API 聚合管理）、VCPBackUpDEV（备份开发）、VCPDistributedServer（分布式服务器）五个组件。

| 项 | 值 |
|----|-----|
| 版本 | v18.12（内部精修版）/ v2.0（TUI 用户可见版，2026-08-24 起） |
| 许可证 | CC-BY-NC-SA-4.0 |
| 编译目标 | x86_64-pc-windows-msvc |
| 目标体积 | ~3-5MB，零前置依赖 |
| 编译大小 | 2,705,408 bytes（v18.12） |

### 两大测试阶段

| 阶段 | 时间 | 目标 | 状态 |
|------|------|------|------|
| **安装精修阶段** | 08-11 ~ 08-24 | 把安装器从"基本可用"精修到五维达标（可靠性/版本/升级/日志/韧性） | ✅ 完成（v18.11 收官） |
| **运行测试阶段** | 08-24 ~ 08-29 | 验证安装产物可正常启动运行 + 补齐安装器运行相关能力 | ✅ 完成 |

---

## 二、核心架构对比

### 2.1 原始版本架构

```
vcp-installer.exe
    │
    ├─ TUI 界面 (ratatui + crossterm)
    ├─ 依赖管理器
    │   ├─ 检测已安装 (which crate)
    │   ├─ 下载 (reqwest 流式)
    │   ├─ 解压 (zip/flate2/sevenz-rust)
    │   └─ 环境变量 (winreg crate)
    │
    └─ 部署引擎
        ├─ git clone (PortableGit)
        ├─ npm install (Portable Node.js)
        ├─ pip install (Portable Python)
        └─ config.env 生成
```

### 2.2 新版本架构变化

**新增模块**：
- `src/mirrors/` — 镜像站管理（INI 解析 + 三阶段测试 + Fallback + 持久化）
  - config.rs：INI 配置解析 + preferred_github 保存 + set_and_save_runtime_version（写前合并）
  - tester.rs：三阶段镜像站测试（Phase0 存在性预校验 + Phase1 快速连通 + Phase2 完整下载）
  - mod.rs：镜像站模块导出
- `src/installer/stream_util.rs` — 子进程输出标准（双线程并发读 + mpsc 回传 + 字节级心跳 + 90 秒看门狗 + \r 规范化）
- `src/installer/electron_rebuild.rs` — Electron 原生模块自动重建（scan_rebuildable_modules + rebuild_modules）
- `src/ui/config_guide.rs` — 第七页 VCP 使用引导（ConfigGuide）
- `src/installer/msvc_ops.rs` — MSVC Build Tools 检测/安装（v18.11 起为必需组件，UI 锁定 + 看门狗加固）

**核心增强**：
- `src/installer/downloader.rs` — download_with_preferred_fallback 多镜像降级 + 断点续传
- `src/installer/git_ops.rs` — git_init_from_remote 多镜像轮换 fetch（Plan B）+ 空仓库回滚（Plan A）
- `src/installer/component_ops.rs` — 空仓库回滚（fetch 全失败时 remove_dir_all .git）
- `src/installer/npm_ops.rs` — to_command_abs_path 路径绝对化 + strip_windows_long_path_prefix
- `src/installer/config_gen.rs` — generate_start_upgrade_bat 组件升级脚本生成

**新增功能**：
- DL_runtimes 永久缓存机制（CacheManager 统一）
- Windows Defender 排除路径自动配置
- headless 模式支持（`--headless <路径>` + `--ui-preview` 预览模式）
- 安装日志输出（分段实时写 + 合并全量日志）
- MSYS2 路径自动转换
- Python 版本动态化（跟随官方发布）
- 三层韧性链路（git clone 断流 → 同站重试 → 换站 → Tarball 兜底）
- INI 统一版本校验（[runtime_versions] + [component_commits]）
- TUI 第七页 VCP 使用引导（安装完成页 Enter 进入）
- start-upgrade.bat 组件升级脚本自动生成

---

## 三、详细功能对比

### 3.1 镜像站管理（核心改造）

| 对比项 | 原始版本 | 新版本 |
|--------|----------|--------|
| **配置方式** | 硬编码单个镜像（ghproxy） | `vcp-mirrors.ini` INI 配置文件，用户可自定义 |
| **默认站点数量** | 1 个（ghproxy.com） | 15+ 个内置，支持用户扩展 |
| **站点选择策略** | 无，使用固定镜像 | 三阶段测试：Phase0 存在性预校验（HEAD，秒级） + Phase1 快速连通（10MB，10秒） + Phase2 完整下载验证（175MB，300秒） |
| **容错机制** | 无 | 下载失败后按速度排序依次尝试其他站点（Fallback）+ git_exhausted 状态共享 |
| **官方直连** | 不参与测试 | 官方直连参与竞争，如果是前3快则直接使用 |
| **持久化** | 无 | preferred_github 写入 INI，下次安装直接复用 |
| **涉及文件** | — | `src/mirrors/config.rs` / `src/mirrors/tester.rs`（新增） |

**关键设计**：
- 拒绝 HEAD 测速（假阳性高），必须用真实下载验证
- 测试文件使用 VCPToolBox.tar.gz（实际安装文件），测试与安装一体化
- 漏斗过滤：越筛越准，越筛越省流量

### 3.2 下载缓存机制

| 对比项 | 原始版本 | 新版本 |
|--------|----------|--------|
| **缓存目录** | 无 | `DL_runtimes/`（与 exe/ini 同级，永久保留） |
| **缓存内容** | 无 | PortableGit/Node.js/Python/NewAPI/MSVC 全部缓存 + 组件 tarball |
| **重复安装** | 重复下载所有文件 | 检查缓存 → 直接使用，无需重新下载 |
| **离线支持** | 不支持 | 支持（可预放安装包到 DL_runtimes） |
| **缓存校验** | 无 | INI [runtime_versions] 版本校验 + [component_commits] commit 校验 + 伴生 .commit 文件 |
| **统一接口** | 无 | CacheManager（cache.rs）统一缓存检查（path()/exists()/ensure_cached()） |

**关键 bug 修复**：
- INI runtime_versions 覆盖 bug（v18.8）：4 运行时各自 clone，后写覆盖前写 → 写前合并已有条目
- tarball commit 文件未生成：旧缓存无 .commit 直接跳过补记 → 无 .commit → Ok(false) 触发重新下载

### 3.3 运行时管理

| 运行时 | 原始版本 | 新版本变化 |
|--------|----------|-----------|
| **Git** | PortableGit，GitHub Release 最新版 | 缓存到 DL_runtimes + 多镜像降级（download_with_preferred_fallback）+ 断点续传 |
| **Node.js** | nodejs.org LTS 最新版 | 缓存到 DL_runtimes + npmmirror CDN 双源降级（10-20x 提速）+ 断点续传 |
| **Python** | python-build-standalone 3.12.8（锁死） | 动态获取最新稳定版（当前 3.14.7）+ 缓存到 DL_runtimes + 多镜像降级 + 断点续传 + ensurepip 优先 + pip.ini 干扰修复 |
| **MSVC Build Tools** | 支持弱（缺少心跳提示，可选组件） | **必需组件**（v18.11 起，UI 锁定 + 默认勾选 + 未检测到强制安装）+ --quiet 静默安装 + 30分钟总超时 + 180秒活动看门狗 + 3次重试 + vswhere 二次验证 + 失败阻断 |
| **NewAPI** | 直接下载到安装目录 | 先缓存到 DL_runtimes → 拷贝到 runtimes/ + 架构优先级匹配 + 多镜像降级 + 断点续传 |

**关键 bug 修复**：
- Python 版本过低（3.10.21）：/releases/latest API 含多版本未排序，取了最低版 → 按 (major,minor,patch) 降序取最高稳定版
- Python 旧缓存覆盖新版本：文件存在就认为可用 → 版本校验 + clean_old_python_cache 清理
- NewAPI 选错架构（arm64）：asset_matches 简单 contains 匹配 → 架构优先级匹配（amd64/x64 > arm64）

### 3.4 安装目录结构对比

#### 原始版本

```
安装目录/
├── VCPToolBox/
├── VCPChat/
├── runtimes/
│   ├── git/
│   ├── node/
│   └── python/
├── new-api.exe          ← 直接下载到安装目录
├── start-backend.bat
└── start-frontend.bat
```

#### 新版本

```
exe所在目录/
├── vcp-installer.exe
├── vcp-mirrors.ini      ← 新增：镜像配置文件
└── DL_runtimes/         ← 新增：永久缓存目录

安装目录/
├── VCPToolBox/
├── VCPChat/
├── VCPBackUpDEV/
├── VCPDistributedServer/
├── runtimes/
│   ├── git/
│   ├── node/
│   ├── python/
│   └── new-api.exe      ← 从 DL_runtimes 拷贝
├── start-backend.bat
├── start-frontend.bat
├── start-upgrade.bat    ← 新增：组件 git pull 升级脚本
└── Install_log/         ← 新增：安装日志目录（分段 + 全量）
    ├── 00_full_log.txt
    ├── 01_prepare.log
    ├── 02_mirrors.log
    ├── 03_runtimes.log
    ├── 04_msvc.log
    ├── 05_toolbox.log
    ├── 06_chat.log
    ├── 07_backupdev.log
    ├── 08_distributed.log
    ├── 09_scripts.log
    └── install_summary.log
```

### 3.5 NewAPI 下载策略

| 对比项 | 原始版本 | 新版本 |
|--------|----------|--------|
| **架构匹配** | 简单 `contains`，可能匹配到 arm64 | 架构优先级匹配（amd64/x64 > arm64）+ 限定 `.exe` |
| **下载路径** | 直接到安装目录 | 先缓存到 DL_runtimes，再拷贝到 runtimes/ |
| **二次安装** | 重复下载 | 缓存存在 → 直接拷贝 |
| **镜像支持** | 无 | apply_mirror() 改写 URL + download_with_preferred_fallback 多镜像降级 + 断点续传 |

### 3.6 MSVC Build Tools

| 项目 | 原始版本 | 新版本 |
|------|----------|--------|
| **组件状态** | 可选组件，默认不选 | **必需组件**（v18.11 起，UI 锁定不可取消，默认勾选，未检测到强制安装） |
| **安装模式** | --passive（有 GUI，与 TUI 冲突） | --quiet（静默模式，不弹 GUI） |
| **进度提示** | 无 | 180秒活动看门狗：`MSVC 安装 已运行 X分X秒...` |
| **安装前提示** | 无 | 充分提示：约需下载 1-2GB，预计 5-15 分钟 |
| **缓存策略** | 无 | vs_BuildTools.exe 缓存到 DL_runtimes |
| **超时保护** | 无 | 30 分钟总超时 + 180 秒活动看门狗（AtomicU64 共享时间戳） |
| **重试机制** | 无 | 3 次重试 + vswhere 二次验证 + --norestart 防弹窗 |
| **失败处理** | 失败不阻断，继续走 npm install | **失败阻断整体安装**（build_fail_result + return） |

**关键 bug 修复**：
- MSVC 误报可达：用的是安装状态非下载源探测 → 新增 test_msvc_source_reachable()
- MSVC 是 npm rebuild 的硬依赖：原代码标为"可选"，实际 npm rebuild 走了 MSVC 编译路径 → 改为必需组件

### 3.7 Windows Defender 排除路径

| 对比项 | 原始版本 | 新版本 |
|--------|----------|--------|
| **问题** | npm install 时 Windows Defender 可能触发 EPERM 错误 | 自动将安装目录添加到 Windows Defender 排除列表 |

### 3.8 命令行与自动化

| 功能 | 原始版本 | 新版本 |
|------|----------|--------|
| **headless 模式** | 无 | `--headless <安装路径>` 支持无 TUI 的自动化安装 |
| **UI 预览模式** | 无 | `--ui-preview` 预览 TUI 全部页面（PgDn/PgUp 翻页，Q 退出） |
| **代理支持** | reqwest 不自动使用系统代理 | 通过 `https_proxy`/`http_proxy` 环境变量 |
| **安装日志** | 无 | 安装过程输出到 `Install_log/`（分段实时写 + 合并全量日志） |
| **MSYS2 路径** | 不支持 | 自动转换 MSYS2 路径为 Windows 路径（msys_to_native_path） |
| **快捷脚本** | 无 | show-tui-pages.bat（TUI 预览）+ start-upgrade.bat（组件升级） |

### 3.9 三层韧性链路（v12/v15 起）

| 机制 | 说明 |
|------|------|
| **同站重试** | 每镜像 2 次重试（每站最多 3 次尝试） |
| **换站容错** | 失败换 [preferred_github] 备用站 |
| **Tarball 兜底** | 备用站全试过 → 切换 Tarball 模式兜底 |
| **git_exhausted 状态共享** | 某组件 git 全失败后，后续组件跳过 git 直接 Tarball（省 ~15 分钟） |
| **stream_util 看门狗** | 双线程读管道 + 90 秒无活动 taskkill /T /F，防拔线挂死 |
| **npm/pip UntilMarker** | 等 `added XXX` / `Installing collected packages` 标志才解除看门狗，防误杀本地编译 |

**拔线测试验证**（v18.1，2026-08-21）：
- 全程 9 次触发看门狗，每次 ~90 秒内 kill 后重试
- 3 站 × 3 次全失败 → 自动切 Tarball 兜底成功
- 全程 20 分 10 秒跑完 9 阶段，**无任何一处卡死**

### 3.10 看门狗 + 心跳 + \r 规范化（stream_util.rs）

| 机制 | 作用 |
|------|------|
| **双线程并发读 + mpsc 回传** | 防 4KB 管道死锁丢输出（git 的 fatal 行最后写入） |
| **字节级心跳** `StreamEvent::Heartbeat` | 每读到非空块发心跳 → 防看门狗误杀正常下载的 git |
| **90 秒活动看门狗** `pump_child_output` | 90 秒无任何活动 → `taskkill /T /F` 杀进程树 → 返回 false 触发重试 |
| **\r 规范化** `normalize_cr` | 每条进度条压成 1 条最终态日志 → 治 TUI 假进度 |

**看门狗策略（按工具区分）**：

| 工具 | 策略 | 理由 |
|------|------|------|
| git | `Always` | 全程几乎都在等网络，90 秒无字节基本断定挂死 |
| npm | `UntilMarker("added ")` | 见 `added N packages` 后解除，防误杀 `npm rebuild` 本地编译（2-5 分钟静默） |
| pip | `UntilMarker("Installing collected packages")` | 进入安装阶段后解除 |

### 3.11 npm allow-scripts 四阶段（npm_ops.rs）

| Phase | 操作 | 说明 |
|-------|------|------|
| Phase1 | `npm approve-scripts --allow-scripts-pending` | 列出挂起的包 |
| Phase2 | 逐个执行 `npm approve-scripts <pkg>@<version>` | 逐个批准 |
| Phase3 | `npm rebuild` | 触发已批准包的 install scripts 重新执行 |
| Phase4 | 验证原生模块 .node 产物 | 检查包内是否存在任意 .node 文件 |

**关键陷阱**：npm install 返回 exit code 0（包文件下载成功），但 postinstall 脚本未执行，易误判为成功。必须看日志 warn。

### 3.12 pip 多源韧性 + ensurepip（pip_ops.rs + portable_python.rs）

| 机制 | 说明 |
|------|------|
| **ensurepip 优先** | `python -m ensurepip --upgrade --default-pip`（零网络依赖），失败才 fallback 到 get-pip.py |
| **pip install 重试** | A+B 双层（B 层 pip 原生超时配置 + A 层外层整进程重试），多源轮换（腾讯/阿里/官方等） |
| **显式指定源** | `-i https://pypi.org/simple` 覆盖系统 pip.ini 干扰 |

### 3.13 electron-rebuild 原生模块自动重建（electron_rebuild.rs，v18.11+ 新增）

| 项 | 说明 |
|----|------|
| **触发时机** | 安装流程第 09 步（Stage::Scripts，启动脚本生成后） |
| **扫描逻辑** | node_modules 下含 binding.gyp 的模块，排除 electron-edge-js |
| **重建命令** | `node node_modules/@electron/rebuild/lib/cli.js -f -o <模块列表>` |
| **流式读取** | stream_util 双线程并发读 + 300 秒看门狗 + WatchdogPolicy::Always |
| **失败策略** | 不阻断安装（仅警告 + 提示手动命令） |
| **验证标志** | `build/Release/.forge-meta = x64--145`（与 Electron 41 ABI 匹配） |

**关键 bug 修复**：
- better-sqlite3 ABI 不匹配（VCPChat UI 不显示）：Electron 41 ABI 145 vs Node 24 ABI 137 → electron-rebuild 按 Electron ABI 重建
- electron-edge-js 误编译：.NET CoreCLR 嵌入模块，electron-rebuild 误对其跑 node-gyp 会失败 → 扫描时排除
- 0xC0000409 闪退：run_sync_step 在 async 上下文阻塞 → 改用 run_blocking_step_with_log（spawn_blocking）

### 3.14 运行时下载韧性改造（downloader.rs + runtime/*，v18.12 新增）

| 改动 | 实现 | 效果 |
|------|------|------|
| **Node.js 走 npmmirror CDN** | `portable_node.rs` 双源循环：npmmirror → nodejs.org | 下载提速 10-20x（10-20min → 1-2min） |
| **多镜像降级** | 新增 `downloader.rs::download_with_preferred_fallback()` | 候选=用户镜像→preferred_github(去重)→GitHub直连；每镜像 2 次重试，自动 resume |
| **断点续传** | 四运行时 `resume: false`→`resume: true` | 断网中断后 RANGE 续传，不从头重下 |

### 3.15 TUI 第七页 VCP 使用引导（config_guide.rs，2026-08-28 新增）

| 项 | 说明 |
|----|------|
| **触发方式** | 安装完成页（第六页）按 **Enter** → 第七页；**Q/Enter/Esc** 退出 |
| **四项引导** | ① 加载后端登录页面（AdminPanel http://localhost:6006/AdminPanel/）② 加载前端 UI 交互界面（start-frontend.bat）③ 推荐 llama.cpp 本地 AI 框架 ④ 推荐硅基流动 SiliconFlow API |
| **排版规范** | 禁 emoji、`[语义中文标签] URL` 两列格式、青色边框 |

### 3.16 start-upgrade.bat 组件升级脚本（config_gen.rs，2026-08-28 新增）

| 特性 | 实现 |
|------|------|
| **生成时机** | 安装流程第 09 步（Stage::Scripts）无条件生成 |
| **路径自适应** | `set "VCP_ROOT=%~dp0"` + 去尾部反斜杠 |
| **组件检测** | 4 个 `if exist "<组件>\\.git"` 检测；VCPToolBox/VCPChat 必选缺失→[WARN]，VCPBackUpDEV/VCPDistributedServer 可选缺失→[SKIP] |
| **重试韧性** | 每组件最多 3 次 `git pull`，失败等 5 秒（ping 占位）重试 |
| **日志** | 全部 git 输出写 `<root>\upgrade_log\upgrade.log`，控制台保留关键进度 |
| **双击友好** | 所有退出路径 pause 防闪退；纯 ASCII（chcp 65001 读取无乱码） |

### 3.17 git 升级能力（v18.10 + 运行调试03）

| 机制 | 说明 |
|------|------|
| **分支统一** | `git init -b main` + `branch --set-upstream-to=origin/main`（v18.10） |
| **多镜像轮换 fetch** | `git_init_from_remote` 按候选镜像列表顺序轮换，每站 3 次重试（运行调试03 Plan B） |
| **空仓库回滚** | fetch 全失败时 remove_dir_all 遗留 .git，回退纯 tarball 状态（运行调试03 Plan A） |
| **双模式等价** | tarball/clone 双模式 8 组件 git pull 全部 SUCCESS（v18.10 验证） |

**关键 bug 修复**：
- tarball 模式 git pull 失败：.git 分支名 master + 缺 tracking 配置 → git init -b main + set-upstream
- tarball 模式空仓库升级 bug：git init 后 fetch 全失败留下空 .git → 多镜像轮换 + 失败回滚

---

## 四、问题修复汇总

| # | 问题描述 | 原始版本 | 新版本解决方案 |
|---|----------|----------|---------------|
| 1 | pip install 失败 | 系统 pip.ini 强制使用清华镜像，部分包缺失 | 显式指定 `-i https://pypi.org/simple`，覆盖 pip.ini |
| 2 | MSYS2 路径兼容 | MSYS2 bash 路径给 Windows exe 无法识别 | `msys_to_native_path()` 自动转换 |
| 3 | GitHub 网络不通 | reqwest 不自动使用系统代理 | 环境变量代理 + 扩大默认镜像站列表 + 自动测速 |
| 4 | NewAPI 架构错误 | 匹配到 arm64 版本 | 增加架构优先级匹配 + 限定 `.exe` |
| 5 | NewAPI 路径混乱 | 直接下载到安装目录 | DL_runtimes 缓存 → runtimes 拷贝策略 |
| 6 | MSVC 安装体验 | 无进度提示，GUI 与 TUI 冲突 | --quiet 模式 + 180秒心跳提示 + DL_runtimes 缓存 |
| 7 | Python 版本锁死 | 硬编码 3.12.8，几年后可能过时 | 动态获取最高稳定版（跟随官方发布） |
| 8 | Python 缓存污染 | DL_runtimes 缓存了旧版 Python 直接使用 | 精确匹配文件名 + 自动清理旧缓存 |
| 9 | HEAD 测速不可靠 | 延迟低不代表大数据传输可靠 | 三阶段测试：Phase0 存在性 + Phase1 快速连通 + Phase2 完整下载验证 |
| 10 | git clone 永久卡死 | 阻塞式 wait，无超时保护 | 90 秒看门狗 + 非阻塞轮询 |
| 11 | TUI 文字重叠 | emoji/全角符号宽度计算异常 | 统一使用等宽 ASCII 符号 |
| 12 | TUI 日志截断 | AllCompleted 覆盖写入，前面日志丢失 | 统一使用 push_log() 追加模式 |
| 13 | URL 双重拼接 | 镜像站 URL 拼接重复 | apply_mirror_to_url 去前缀 |
| 14 | 完成页面不显示运行时 | 运行时组件从未加入显示列表 | 新增 RuntimeComponent 枚举 + 分区域显示 |
| 15 | **git clone 断流失败** | 单镜像失败就 bail，无容错 | 三层韧性链路：同站重试 → 换站 → Tarball 兜底 + git_exhausted 状态共享 |
| 16 | **拔线停滞** | TCP 静默重传 15+ 分钟，不产生错误码 | 90 秒看门狗 taskkill /T /F 杀进程树 + Tarball 兜底 |
| 17 | **TUI 假进度** | git 进度条 \r 更新，read_line 等 \n 才 flush，打包成超长日志 | \r 规范化 normalize_cr，每条进度条压成 1 条最终态日志 |
| 18 | **TUI 全量日志丢失** | OnceLock::get() 顺序依赖，setter 静默落空 | 单路分段架构 |
| 19 | **TUI 全量日志重复** | 双写（installer 线程 + TUI 主循环同时 append） | 单路分段 + 合并全量 |
| 20 | **INI runtime_versions 覆盖** | 4 运行时各自 clone，后写覆盖前写（INI 只剩 NewAPI） | 写前合并已有条目（v18.9） |
| 21 | **tarball commit 文件未生成** | 旧缓存无 .commit 直接跳过补记 | 无 .commit → Ok(false) 触发重新下载 |
| 22 | **tarball 模式 git pull 失败** | .git 分支名 master + 缺 tracking 配置 | git init -b main + branch --set-upstream-to=origin/main（v18.10） |
| 23 | **MSVC 是硬依赖但标为可选** | npm rebuild 实际走了 MSVC 编译路径，但原代码标为"可选" | 改为必需组件（UI 锁定 + 默认勾选 + 未检测到强制安装 + 失败阻断）（v18.11） |
| 24 | **better-sqlite3 ABI 不匹配** | VCPChat 是 Electron 41（ABI 145），但 better-sqlite3 按系统 Node 24（ABI 137）编译 | electron-rebuild 按 Electron ABI 重建（v18.11+） |
| 25 | **0xC0000409 进程闪退** | run_sync_step 在 async 上下文阻塞 + blocking_send | 改用 run_blocking_step_with_log（spawn_blocking）（v18.11+） |
| 26 | **npm/pip 相对路径 bug** | install_path 原始参数相对路径，bat 内路径多解析一层 | Plan A：mod.rs 入口 install_dir 源头绝对化 + to_command_abs_path + 剥离 `\\?\` 前缀（v18.12） |
| 27 | **运行时下载慢（Node.js 直连）** | Node.js 硬编码 nodejs.org，无镜像，国内几十 KB/s | npmmirror CDN 双源降级 + 多镜像降级 + 断点续传（v18.12） |
| 28 | **tarball 模式空仓库升级 bug** | git init 后 fetch 全失败留下空 .git，git pull 报 no tracking information | Plan B：fetch 多镜像轮换 + Plan A：失败回滚 .git（运行调试03） |
| 29 | **remote: 噪音（Counting/Compressing）** | 只在 Line handler 过滤，Progress 漏掉 | Line + Progress 双通道过滤（v18.4） |
| 30 | **git reset 原始输出进日志** | run_git 把 stderr 原样记入 | 静默执行 + 标准化日志（v18.9） |

---

## 五、代码变更汇总

### 5.1 新增文件

| 文件路径 | 职责 |
|----------|------|
| `src/mirrors/config.rs` | 镜像站 INI 配置解析 + preferred_github 保存 + set_and_save_runtime_version（写前合并） |
| `src/mirrors/tester.rs` | 三阶段镜像站测试（Phase0 + Phase1 + Phase2） |
| `src/mirrors/mod.rs` | 镜像站模块导出 |
| `src/installer/stream_util.rs` | 子进程输出标准（双线程并发读 + mpsc 回传 + 心跳 + 看门狗 + \r 规范化） |
| `src/installer/electron_rebuild.rs` | Electron 原生模块自动重建（scan_rebuildable_modules + rebuild_modules） |
| `src/ui/config_guide.rs` | 第七页 VCP 使用引导（ConfigGuide） |
| `vcp-mirrors.ini` | 用户可自定义的镜像配置文件 |
| `show-tui-pages.bat` | TUI 页面预览快捷脚本 |

### 5.2 修改文件

| 文件路径 | 变更内容 |
|----------|----------|
| `src/main.rs` | headless 模式 + --ui-preview 预览模式 + msys_to_native_path + 组件列表精简（去 NewAPI/VCPBackUpDEV/VCPDistributedServer） |
| `src/app.rs` | 新增 RuntimeComponent 枚举；GithubMirror/NpmMirrorChoice/PipMirrorChoice 动态化；InstallResult 新增 installed_runtimes 字段；AppState 新增 ConfigGuide 变体；MSVCBuildTools 改为必需组件（is_required + 默认勾选 + UI 锁定） |
| `src/installer/mod.rs` | 安装流程接入站点测试；NewAPI 检测路径改为 runtimes/new-api.exe；install_dir 入口源头绝对化（v18.12）；第 09 步调用 electron_rebuild + generate_start_upgrade_bat；MSVC 失败阻断 |
| `src/installer/downloader.rs` | 新增 get_latest_python_standalone_url() + 多版本排序 + RC 排除；新增 download_with_preferred_fallback 多镜像降级 + 断点续传（v18.12） |
| `src/installer/config_gen.rs` | NewAPI 缓存策略：DL_runtimes → runtimes；generate_start_upgrade_bat 组件升级脚本生成（v18.12） |
| `src/installer/git_ops.rs` | git_init_from_remote 多镜像轮换 fetch（Plan B）+ 空仓库回滚（Plan A）（运行调试03） |
| `src/installer/component_ops.rs` | 空仓库回滚（fetch 全失败时 remove_dir_all .git）（运行调试03） |
| `src/installer/npm_ops.rs` | approve_npm_scripts 四阶段；to_command_abs_path 路径绝对化 + strip_windows_long_path_prefix（v18.12） |
| `src/installer/pip_ops.rs` | 显式指定 `-i https://pypi.org/simple`，绕过 pip.ini |
| `src/installer/msvc_ops.rs` | --quiet 模式、180秒看门狗、30分钟总超时、3次重试、vswhere 二次验证、DL_runtimes 缓存检查（v18.11 加固） |
| `src/cache.rs` | CacheManager 统一缓存检查（path()/exists()/ensure_cached()） |
| `src/log_router.rs` | 分段日志架构（StageGuard RAII） |
| `src/env_log.rs` | write_prepare_log TUI/Headless 统一 |
| `src/runtime/mod.rs` | 新增 get_installed_runtimes() 方法 |
| `src/runtime/portable_python.rs` | Python 版本动态化 + ensurepip 优先 + 缓存清理 + pip verify 修复 + 多镜像降级 + 断点续传（v18.12） |
| `src/runtime/portable_node.rs` | npmmirror CDN 双源降级 + 断点续传（v18.12） |
| `src/runtime/portable_git.rs` | 多镜像降级 + 断点续传（v18.12） |
| `src/ui/welcome.rs` | 新增红色网络警告提示；版本号 v1.1→v2.0 |
| `src/ui/env_check.rs` | 新增止损逻辑（GitHub 全不通则阻止继续）+ test_msvc_source_reachable() |
| `src/ui/progress.rs` | 5段布局 + ASCII 符号统一 + 步骤名缩短 + remote: 噪音过滤 |
| `src/ui/complete.rs` | 运行时环境 + 已安装应用分区域显示；Enter→ConfigGuide 跳转 |
| `Cargo.toml` | 版本号 1.0.0→2.0.0 |

---

## 六、版本策略对比

| 运行时 | 原始版本 | 新版本 |
|--------|----------|--------|
| **Git** | 动态最新版 | ✅ 保持 + 多镜像降级 + 断点续传 |
| **Node.js** | 动态 LTS | ✅ 保持 + npmmirror CDN 双源降级 + 断点续传 |
| **Python** | ❌ 锁死 3.12.8 | ✅ 动态最新（astral-sh latest release → 最高稳定版，当前 3.14.7）+ 多镜像降级 + 断点续传 |
| **NewAPI** | ⚠️ 宽泛匹配 | ✅ 限定 `.exe`，防架构误下 + 多镜像降级 + 断点续传 |
| **MSVC Build Tools** | 可选组件，支持弱 | ✅ **必需组件**（UI 锁定 + 默认勾选 + 未检测到强制安装 + 失败阻断）+ 看门狗加固 |

---

## 七、总结

新版本相比原始版本的核心提升（19 天迭代，13 个主要版本）：

### 安装精修阶段（v10→v18.11）

1. **镜像管理**：从硬编码单个镜像 → INI 配置 + 三阶段自动测速 + Fallback 多站点容错 + preferred_github 持久化
2. **下载缓存**：从每次重复下载 → DL_runtimes 永久缓存，支持离线/复用 + CacheManager 统一 + INI 版本校验
3. **运行时完善**：MSVC Build Tools 改为必需组件 + 看门狗加固 + Windows Defender 排除路径
4. **NewAPI 策略**：架构精准匹配 + 缓存到 DL_runtimes + 安装到 runtimes + 多镜像降级
5. **pip 稳定性**：显式指定源，绕过系统 pip.ini 干扰 + ensurepip 零网络依赖 + 多源韧性
6. **Python 版本**：从锁死 3.12.8 → 动态获取最高稳定版（当前 3.14.7）
7. **自动化支持**：headless 模式 + 代理环境变量 + 安装日志（分段 + 全量）+ MSYS2 路径转换
8. **TUI 体验**：网络警告 + 止损逻辑 + ASCII 符号统一 + 完成页面分区域显示 + 日志完整性
9. **三层韧性**：git clone 断流 → 同站重试 → 换站 → Tarball 兜底 + git_exhausted 状态共享
10. **看门狗 + 心跳**：防拔线挂死 + 防管道死锁 + \r 规范化治 TUI 假进度
11. **npm allow-scripts 四阶段**：防 postinstall 脚本未执行陷阱
12. **INI 统一版本校验**：[runtime_versions] + [component_commits] + 伴生 .commit 文件
13. **git 升级能力**：tarball/clone 双模式 git pull 等价（v18.10 分支统一 + tracking 配置）

### 运行测试阶段（v18.12 + 运行调试01-03）

14. **electron-rebuild 原生模块自动重建**：VCPChat 前端静默失败根治（better-sqlite3 ABI 不匹配）
15. **0xC0000409 闪退修复**：spawn_blocking 替代 async 上下文阻塞
16. **npm 相对路径 bug 彻底修复**：install_dir 源头绝对化 + 剥离 `\\?\` 前缀
17. **运行时下载韧性**：Node.js npmmirror CDN + 多镜像降级 + 断点续传
18. **TUI 第七页 VCP 使用引导**：安装完成页 Enter 进入，四项引导（AdminPanel/VCPChat/llama.cpp/SiliconFlow）
19. **start-upgrade.bat 组件升级脚本**：安装后自动生成，4 组件 git pull 3 次重试
20. **空仓库升级 bug 修复**：Plan B 多镜像轮换 + Plan A 失败回滚 .git
21. **双模式产物对比验证**：tarball/clone 等价（VCPBackUpDEV 空仓库 bug 修复后）

### 五维达标

| 维度 | 能力 |
|------|------|
| **安装可靠性** | 三层韧性 + 看门狗 + 空仓库回滚 + npm 路径 bug 修复 |
| **版本准确性** | INI 统一版本校验 + commit 伴生文件 + 双模式 git pull 等价 |
| **升级能力** | tarball/clone 双模式 git pull + start-upgrade.bat 自动生成 |
| **日志质量** | 分段实时写 + 合并全量 + remote: 噪音过滤 + 进度 100% |
| **断网韧性** | 90 秒看门狗 + Tarball 兜底 + 拔线测试零卡死 + 运行时下载韧性 |

**当前状态**：
- 稳定版本：v18.10（双模式安装+升级全部验证通过）
- 开发版本：v18.12（运行时下载韧性 + npm 路径 bug 修复 + 空仓库 bug 修复，2,705,408 bytes）
- TUI 用户可见版：v2.0
- **安装精修收官 + 运行测试达标，VCP Installer 进入稳定维护阶段**

---

*本文档由 Hermes Agent (ASH) 生成，基于原始开发文档与安装调试报告 1-25、运行调试报告 01-03 整理，最后更新：2026-08-29。*
