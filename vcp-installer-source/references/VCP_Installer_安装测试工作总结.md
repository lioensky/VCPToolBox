# VCP Installer 安装测试工作总结

> **整理日期**：2026-08-29（收尾归纳）
> **整理者**：ASH（Hermes Agent）
> **项目路径**：`D:\Desktop\vcp-installer-source-new`（代码+报告）/ `D:\Desktop\vcp-installer-test`（测试+日志）
> **时间跨度**：2026-08-11 ~ 2026-08-29（19 天）
> **版本演进**：v10 → v18.12（内部精修版）/ TUI 用户可见版 v2.0
> **文档性质**：整合 md 目录全部安装调试报告（1-25）+ 运行调试报告（01-03）+ 经验总结 + 阶段总结的去重归纳版，作为项目完整历史档案与后续维护参考

> **一句话结论**：经过 19 天迭代，VCP Installer 完成**两大阶段**——① **安装精修阶段**（v10→v18.11）把工具从"基本可用"精修到**安装可靠性、版本准确性、升级能力、日志质量、断网韧性**五维达标；② **运行测试阶段**（运行调试01-03）验证安装产物真正可启动运行，并补齐 **electron-rebuild 原生模块重建、运行时下载韧性、TUI 使用引导、组件升级脚本、双模式 git 边界 bug 修复**。核心成果：三阶段镜像筛选、三层韧性链路、看门狗+心跳防挂死、npm/pip 全链路重试、INI 统一版本校验、tarball/clone 双模式 git 等价、better-sqlite3 ABI 自动重建、Node.js CDN 加速、断点续传。**当前开发版本 v18.12（含 npm 路径 bug Plan A 彻底修复 + 运行时下载韧性 Phase1+2），双模式安装+升级全部验证通过。**

---

## 目录

1. [项目概述](#一项目概述)
2. [测试环境与工具链](#二测试环境与工具链)
3. [版本演进时间线](#三版本演进时间线)
4. [核心架构与技术方案](#四核心架构与技术方案)
5. [重大问题与修复记录](#五重大问题与修复记录)
6. [关键测试验证记录](#六关键测试验证记录)
7. [运行测试阶段专项总结](#七运行测试阶段专项总结)
8. [当前状态与遗留项](#八当前状态与遗留项)
9. [经验教训](#九经验教训)
10. [源报告索引](#十源报告索引)
11. [快速参考](#十一快速参考)

---

## 一、项目概述

### 1.1 项目定位

VCP Installer 是 Rust 编写的 Windows TUI 单 exe 工具，用于一键部署 VCP（VCPToolBox + VCPChat + NewAPI + VCPBackUpDEV + VCPDistributedServer）全栈环境。

- **VCP 定位**：VCP(Variable & Command Protocol) 是全栈自研、工程化、分布式的 AGI 运行时系统，目标把 LLM 改造为拥有持久记忆、时间感知、自主行动、群体协作的 Agent。
- **安装器定位**：在**原代码（source-old）基础上做精修/完善/优化**，不是全新构建。

### 1.2 两大测试阶段

| 阶段 | 报告编号 | 时间 | 目标 | 状态 |
|------|----------|------|------|------|
| **安装精修阶段** | 安装调试报告 1-21 | 08-11 ~ 08-24 | 把安装器从"基本可用"精修到五维达标（可靠性/版本/升级/日志/韧性） | ✅ 完成（v18.11 收官） |
| **运行测试阶段** | 运行调试报告 01-03（对应文件 22-25） | 08-24 ~ 08-29 | 验证安装产物可正常启动运行 + 补齐安装器运行相关能力 | ✅ 完成 |

### 1.3 核心能力（最终状态）

| 维度 | 能力 |
|------|------|
| 双安装方式 | Git Clone / Tarball 二选一，功能等价，均支持 `git pull` 升级 |
| 运行时隔离 | Portable Git/Node/Python 独立安装到 `runtimes\`，不污染系统 |
| 镜像容错 | 三阶段动态筛选 + 三层韧性链路（重试/换站/兜底） |
| 缓存复用 | `DL_runtimes\` 永久缓存，二次安装/重装直接复用 |
| 断网韧性 | 看门狗+心跳防挂死，90 秒无活动自动杀进程树重试 |
| 版本准确 | INI `[runtime_versions]` + `[component_commits]` 统一校验 |
| 日志完备 | 单路分段实时写 + 合并全量日志，TUI/Headless 一致 |
| 原生模块 | electron-rebuild 自动重建（better-sqlite3 等）按 Electron ABI |
| 下载加速 | Node.js 走 npmmirror CDN + 全运行时断点续传 + 多镜像降级 |
| 运行验证 | 前后端可启动 + AdminPanel 鉴权 + TUI 使用引导页 + 升级脚本 |

### 1.4 目录纪律（严格遵守）

| 目录 | 职责 |
|------|------|
| `vcp-installer-source-old` | 只读原始代码（勿改） |
| `vcp-installer-source-new` | **修改后的代码 + 报告**（当前活跃） |
| `vcp-installer-test` | 安装测试 + 日志记录（`Install_log\`） |
| `vcp-installer-source-new-bak` | 近期跑通的代码完整备份 |

---

## 二、测试环境与工具链

### 2.1 系统环境

| 项 | 值 |
|----|-----|
| 操作系统 | Windows 10 IoT Enterprise LTSC 2021 (Build 19044) |
| CPU | Intel Core i7-8700 @ 3.20GHz |
| 内存 | 32GB |
| 显卡 | NVIDIA RTX 4060 Ti |
| 系统 Git | 2.54.0.windows.1（测试用，安装器仍用 Portable 版） |
| 系统 Node.js | v22.23.2（测试用） |
| 系统 Python | 3.11.15（测试用） |
| 代理 | SOCKS5 127.0.0.1:9909 / HTTP 127.0.0.1:9910（测试期） |

### 2.2 构建工具链

| 项 | 值 |
|----|-----|
| 编译器 | Cargo 1.97.1，target `x86_64-pc-windows-msvc` |
| 构建命令 | `cargo build --release --target x86_64-pc-windows-msvc` |
| 看门狗单测 | `cargo test --release stream_util -- --ignored` |
| MSVC | Build Tools 2022（v18.11 起为**必需**组件） |

### 2.3 运行时版本（验证期）

| 运行时 | 版本 |
|--------|------|
| Portable Git | v2.55.0.windows.5 |
| Node.js | v24.19.0（Portable） |
| Python | 3.14.7（Portable，python-build-standalone） |
| NewAPI | v1.0.0-rc.25 |
| Electron（VCPChat） | 41.10.4（内置 Node ABI **145**） |

### 2.4 组件依赖矩阵

| 仓库 | package.json | requirements.txt | npm install | pip install |
|------|:---:|:---:|:---:|:---:|
| VCPToolBox | ✅ | ✅ | 需要 | 需要 |
| VCPChat | ✅ | ✅ | 需要 | 需要 |
| VCPDistributedServer | ✅ | - | 需要 | - |
| VCPBackUpDEV | ❌ | ❌ | - | -（纯代码） |
| NewAPI | - | - | - | -（二进制运行时） |

### 2.5 VCP 运行架构速查（运行调试01 确认）

> 安装产物运行时的关键架构知识，供运行维护参考。

| 项 | 值 |
|----|-----|
| VCPToolBox 主 API | 端口 **6005**（Key 鉴权，Header/Query） |
| AdminPanel 管理面板 | 端口 **6006 = MAIN_PORT + 1**（Basic Auth + Cookie + IP 防爆破），**独立进程 vcp-admin** |
| VCP-CDS 数据服务 | Rust 写的本地服务，随机端口（如 57871），Electron 内部通信 |
| VCPChat 管理面板 | ❌ **不存在**——VCPChat 定位"前端界面"，只有用户级全局设置（用户名/服务器地址/通知地址） |
| 进程模型 | pm2 守护 `vcp-main`(server.js) + `vcp-admin`(adminServer.js)；VCPChat 用 electron.exe ×3 |
| config.env 读取 | **直接读字面量**——占位符字符串就是当前有效密码，生产环境必须替换 |
| pm2 日志 | `~/.pm2/logs/vcp-main-out.log` / `vcp-admin-out.log` |
| ServerLog | `VCPToolBox/ServerLog.txt`（轮转，5MB×7 天） |
| 停止服务 | `pm2 stop all` + `taskkill /IM electron.exe /F` |

---

## 三、版本演进时间线

> 双版本轨说明：**v18.x** 是内部精修版本号（体现在 exe 文件名，如 `vcp-installer-18.10-tarball-git-fix.exe`）；**v2.0** 是 TUI 用户可见版本号（`welcome.rs:44` 标题 + `Cargo.toml 2.0.0`，2026-08-24 起）。两者并行，TUI 标题给用户看 v2.0，内部构建沿用 v18.x 脉络。

| 版本 | 日期 | 主题 | 核心成果 |
|------|------|------|----------|
| v10.0-10.2 | 08-18 | Tarball 安装方式 | 双安装方式（Git Clone/Tarball）实现；DL_runtimes 重复文件修复；headless 全组件默认安装 |
| v11 | 08-18 | 日志系统统一 | 01_prepare.log TUI/Headless 统一；cache.rs 框架；TUI 进度列表 17→11 步 |
| v12/v15 | 08-20 | Tarball+Git 模式 + 三层韧性 | git clone 断流→同站重试→换站→Tarball 兜底；git_exhausted 状态共享 |
| v16 | 08-21 | 全链路网络重试 | npm/pip A+B 双层重试；git fetch/pm2 重试补全 |
| v17 | 08-21 | 无VPN Git Clone 实战 | 三层韧性链首次真实触发；子进程输出丢失修复（git fatal 详情） |
| v18 | 08-21 | 拔网线停滞修复 | stream_util.rs（\r 规范化+心跳+90秒看门狗）；TUI 假进度修复 |
| v18.1 | 08-21 | 拔线测试闭环 | 看门狗+Tarball 兜底验证；20 分 10 秒零卡死 |
| v18.2 | 08-23 | TUI 显示修正 + 遗留收尾 | 8 项修复（环境误报/进度灰色/Progress 接 TUI/PM2/allow-scripts Phase4/pip 索引映射/路径分隔符） |
| v18.3 | 08-23 | 进度 100% + commit 校验 | git 进度 100%；remote: 噪音过滤；tarball commit 伴生文件 |
| v18.4 | 08-23 | remote 噪音二次修复 | Progress handler 也过滤 remote:；commit 补记逻辑修正 |
| v18.8 | 08-23 | INI 统一版本校验 | 运行时 4 项 INI 校验（有覆盖 bug） |
| v18.9 | 08-23 | INI 覆盖修复 + 日志清理 | runtime_versions 写前合并；删除无用日志行；git reset 静默 |
| v18.10 | 08-23 | tarball git 分支统一（收官） | `git init -b main` + tracking 配置；双模式 git pull 等价验证 |
| v18.11 | 08-24 | MSVC 改必需 + 韧性加固 | MSVC 从可选改必需（UI 锁定+默认勾选+未检测到强制安装）；失败阻断；30分钟总超时+180秒看门狗；3次重试；vswhere二次验证 |
| **v2.0** | 08-24 | **TUI 用户可见版本号** | welcome.rs `v1.1`→`v2.0` + Cargo.toml `1.0.0`→`2.0.0`；headless 精简组件（去 NewAPI/VCPBackUpDEV/VCPDistributedServer） |
| v18.12 | 08-28 | **运行时下载韧性 + npm 路径 bug 彻底修复** | download_with_preferred_fallback 多镜像降级；Node.js npmmirror CDN；全运行时断点续传；npm 相对路径 bug Plan A 修复（install_dir 源头绝对化 + 剥离 `\\?\` 前缀） |

---

## 四、核心架构与技术方案

> 本项目沉淀的核心技术方案，每项含"问题→方案→实现位置"。这些方案是项目最宝贵的资产。

### 4.1 镜像站三阶段筛选（tester.rs）

**问题**：HEAD 测速假阳性极高（30 站 HEAD 全通，真实 git clone 仅 2 个成功）；直接完整下载代价太大（16 站 × 175MB ≈ 3GB 流量）。

**方案**：Phase0→1→2 多步骤组合，由粗到细、由多到少，利用 VCP 自身代码包作测试文件。

```
Phase0: 项目存在性预校验（HEAD 请求，秒级，5 并发）
    ↓ (16个候选 → 8个支持)
Phase1: 快速连通测试（真实下载 ~10MB，10秒超时，按 bytes/sec 排序）
    ↓ (8个 → 4个可达)
Phase2: 完整下载测试（真实下载 ~175MB，300秒超时，保存到 DL_runtimes 缓存）
    ↓ (4个 → 3-4个可用)
输出: 前3个最快站点写入 vcp-mirrors.ini [preferred_github]（持久化复用）
```

**测试文件选择**：VCPToolBox main 分支 tar.gz（~175MB）——实际安装文件，测试与安装一体化（Phase2 缓存可直接复用）。

**双机制**：
- 备用列表（`[github]`）：离线维护，过去可用站点
- 可用列表（`[preferred_github]`）：安装时动态测试生成并持久化

**实现**：`src/mirrors/tester.rs`（`phase0_check_project_exists`/`quick_test_all`/`full_test_candidates`）+ `config.rs`（`save_preferred_github`）

### 4.2 三层韧性链路（git_ops.rs + archive_ops.rs）

**问题**：git clone 一次瞬时断流（`curl 56`/`ECONNRESET`）= 组件直接失败；DL_runtimes 已有缓存却无法利用。

**方案**：韧性哲学——"Tarball 部署永远能成，git 能力锦上添花"。

```
遇到断流 → 同站重试 2 次（每站最多 3 次尝试）
        → 失败换 [preferred_github] 备用站
        → 备用站全试过 → 切换 Tarball 模式兜底
```

**git_exhausted 状态共享**：某组件 git 全失败后，后续组件跳过 git 直接 Tarball（省 ~15 分钟）。

**适用**：Git Clone 模式（clone 断流）+ Tarball 模式（无缓存时 tar.gz 下载断流）都套用。

**实现**：`git_clone_resilient` + `archive_extract_resilient`（curl --retry 3）

### 4.3 看门狗 + 心跳 + \r 规范化（stream_util.rs）

**问题**（拔网线测试暴露）：
1. **拔线停滞**：拔线 ≠ VPN 关闭。拔线后已建立的 TCP 连接留在 ESTABLISHED，OS 静默重传 15+ 分钟，不产生错误码 → 重试全失效，卡在 `child.wait()`。
2. **TUI 假进度**：git 进度条用 `\r` 更新，`read_line` 等 `\n` 才 flush，整条 `Receiving objects: 0%→100%`（163 段）被打包成 1 条 9772 字符超长日志，撑爆 TUI 面板。

**方案**：共享模块 `stream_util.rs`，三机制统一：

| 机制 | 作用 |
|------|------|
| **双线程并发读 + mpsc 回传** | 防 4KB 管道死锁丢输出（git 的 fatal 行最后写入） |
| **字节级心跳** `StreamEvent::Heartbeat` | 每读到非空块发心跳 → 防看门狗误杀正常下载的 git |
| **90 秒活动看门狗** `pump_child_output` | 90 秒无任何活动 → `taskkill /T /F` 杀进程树 → 返回 false 触发重试 |
| **\r 规范化** `normalize_cr` | 每条进度条压成 1 条最终态日志 → 治 TUI 假进度（副作用：吞掉中间进度，待修） |

**看门狗策略（按工具区分）**：

| 工具 | 策略 | 理由 |
|------|------|------|
| git | `Always` | 全程几乎都在等网络，90 秒无字节基本断定挂死 |
| npm | `UntilMarker("added ")` | 见 `added N packages` 后解除，防误杀 `npm rebuild` 本地编译（2-5 分钟静默） |
| pip | `UntilMarker("Installing collected packages")` | 进入安装阶段后解除 |

**实现**：`src/installer/stream_util.rs`

### 4.4 npm allow-scripts 四阶段（npm_ops.rs）

**问题**：Node.js 24+（npm 11+）的 allow-scripts 安全机制阻止 native 模块 postinstall 脚本执行，导致 VCPToolBox/VCPChat 核心功能（better-sqlite3/electron/node-pty 等）不可用。**关键陷阱**：npm install 返回 exit code 0（包文件下载成功），但 postinstall 脚本未执行，易误判为成功。

**方案**：四阶段组合（v11 验证通过）：

```
Phase1: npm approve-scripts --allow-scripts-pending (列出挂起的包)
    ↓ (parse_pending_packages 解析输出)
Phase2: 对每个包逐个执行 npm approve-scripts <pkg>@<version> (逐个批准)
    ↓
Phase3: npm rebuild (触发已批准包的 install scripts 重新执行)
    ↓
Phase4: 验证原生模块 .node 产物是否生成
```

**为什么必须多步骤**：
- `approve-scripts --allow-scripts-pending` 只列出、不批准
- 批准后包已装完，npm 不会自动重跑脚本，必须 `npm rebuild` 触发
- Phase4 用"包内是否存在任意 .node 文件"判定（不猜文件名，因 better-sqlite3 产物是 `build/Release/better_sqlite3.node`）

**实现**：`src/installer/npm_ops.rs::approve_npm_scripts`

### 4.5 pip 多源韧性 + ensurepip（pip_ops.rs + portable_python.rs）

**问题**：
1. get-pip.py 所有国内镜像 URL 均 404（PyPI 镜像只同步 simple 索引，不托管 get-pip.py 静态文件）
2. pip install 断网/弱网失败

**方案**：
- **pip 安装**：优先 `python -m ensurepip --upgrade --default-pip`（零网络依赖），失败才 fallback 到 get-pip.py
- **pip install 重试**：A+B 双层（B 层 pip 原生超时配置 + A 层外层整进程重试），多源轮换（腾讯/阿里/官方等）

**实现**：`pip_ops.rs`（`is_pip_network_error` 判定）+ `portable_python.rs`（ensurepip）

### 4.6 缓存架构（cache.rs + DL_runtimes）

**问题**：下载包存到 `VCP_AIOS` 临时目录，重装重复下载；缓存检查逻辑分散。

**方案**：
- **DL_runtimes 永久缓存**：所有下载包（运行时安装包 + 组件 tarball）存到 exe 同级 `DL_runtimes\`，不随安装清除
- **CacheManager 统一**：`cache.rs` 的 `CacheManager` 统一缓存检查（`path()`/`exists()`/`ensure_cached()`），被 archive_ops/component_ops/runtime/* 全部接入
- **NewAPI 策略**：先下载 `DL_runtimes/new-api.exe`（缓存）→ 拷贝到 `runtimes/new-api.exe` → 二次安装直接复用

**实现**：`src/cache.rs`（CacheManager）

### 4.7 INI 统一版本校验（config.rs + 各 runtime）

**问题**：DL_runtimes 缓存文件存在 ≠ 版本正确（如 Python 旧缓存 3.10.21 覆盖了应下载的 3.14.7）。

**方案**：INI 记录版本/commit，安装时校验：
- `[runtime_versions]`：PortableGit/Node/Python/NewAPI 的版本号
- `[component_commits]`：4 组件 tarball 的远程 HEAD commit hash（伴生 `.commit` 文件）

**校验逻辑**（3 案例）：
- INI 版本 == 最新版本 且 缓存存在 → 用缓存
- INI 版本 != 最新版本 → 缓存过期，重新下载
- INI 无记录 → 重新下载并记录

**关键 bug 修复（v18.9）**：4 运行时各自 `mirror_config.clone()`，写 INI 时后写覆盖前写（INI 只剩 NewAPI）。修复为**写前合并**已有 `[runtime_versions]` 条目。

**实现**：`config.rs::set_and_save_runtime_version`（写前合并）+ 各 runtime 的 INI 校验

### 4.8 日志架构（log_router.rs + env_log.rs）

**问题**：
1. 单 `install_log.txt` 条目太多、分段缺失、summary 简略
2. TUI 全量日志丢失（OnceLock 顺序依赖）
3. TUI 全量日志内容重复（双写）

**方案**：单路分段实时写 + 安装结束后合并全量日志
- **分段日志**：`00_full_log.txt`（全量）+ `01_prepare`~`09_scripts`（按阶段）+ `install_summary.log`
- **日志位置**：exe 同级 `Install_log\`
- **时机**：环境检测完成即生成日志目录 + 01_prepare.log
- **StageGuard**：RAII 管理各阶段日志（`enter` 写 [START]/[END]，`enter_quiet` 只设 stage 不写标记）
- **write_prepare_log**：TUI/Headless 统一调用，内容完全一致

**实现**：`src/log_router.rs` + `src/env_log.rs` + `installer/mod.rs`（StageGuard）

### 4.9 TUI 界面规范（ui/*.rs）

**硬性规定**：禁用 emoji/特殊符号（ratatui + Windows 终端宽度计算异常，导致居中对齐文字重叠）。统一 ASCII：

| 符号 | 替代 |
|------|------|
| ▶ | `>` |
| √ | `*`（选中） |
| ↑↓ | `上下键`（中文） |
| ─ | `-` |
| ○ | `--`（Pending） |
| [FAIL] | `XX` |

**状态图标**（等宽 4 字符）：`[--]`Pending / `[**]`Running / `[OK]`Completed / `[XX]`Failed / `[$]`Skipped

**布局**：5 段（Gauge(3行) + 空行 + Steps(Min4) + 空行 + Logs(Min4, 弹性扩展)）

**排版偏好**（CARP）：链接用 `[语义中文标签]` 格式；URL 带 `https://`；两列 `[标签] URL`；分区边框用语义色（绿=代码仓库、青=学习资源、红=警告）

**检查范围**：只查 `ui/*.rs`，日志文件不处理。

### 4.10 electron-rebuild 原生模块自动重建（electron_rebuild.rs，v18.11+ 新增）

**问题**：VCPChat 是 Electron 41 应用（内置 Node ABI **145**），但 better-sqlite3/node-pty/hnswlib-node 等原生模块按系统 Node.js 24（ABI **137**）编译，ABI 不匹配 → require 抛错 → 主进程崩、UI 窗口不显示。这是 VCP 安装后前端**静默失败**的隐蔽原因（依赖看着全、进程却崩、窗口不出来）。

**方案**：安装流程第 09 步（Stage::Scripts，启动脚本生成后）自动 electron-rebuild：
- `scan_rebuildable_modules`：扫描 node_modules 下含 `binding.gyp` 的模块，**排除 electron-edge-js**（自动识别出 better-sqlite3/hnswlib-node/node-pty 三个）
- `rebuild_modules`：`node node_modules/@electron/rebuild/lib/cli.js -f -o <模块列表>` 按 Electron ABI 重编译
- 流式读取：stream_util 双线程并发读 + 300 秒看门狗 + WatchdogPolicy::Always
- 日志过滤：C4996 警告不刷屏（electron-edge-js 编译噪音）
- **失败策略**：不阻断安装（仅警告 + 提示手动命令），与 npm install 失败哲学一致

**electron-edge-js 特殊处理（勿误伤）**：.NET CoreCLR 嵌入模块，本用预编译二进制（`lib/native/win32/x64/<electron主版本>/`，官方最高 38）。electron-rebuild 误对其跑 node-gyp 会导致 edge_nativeclr 编译失败（缺 MSCOREE.lib），但 edge.js 加载逻辑会自动回退到 edge_coreclr.node，不影响运行。**结论：跳过它**。

**精准重建**：用 `-o <模块名>` 精确指定崩溃模块，避免 `-w`/默认全量重建误伤特殊模块。

**实现**：`src/installer/electron_rebuild.rs`（scan_rebuildable_modules + rebuild_modules + rebuild_modules_internal）

### 4.11 运行时下载韧性改造（downloader.rs + runtime/*，v18.12 新增）

**问题**：四大运行时（PortableGit/Node/Python/NewAPI）下载链路与 VCPToolBox 组件的韧性差距明显：
- PortableGit/Python/NewAPI：`download_with_retry()` 仅单镜像 3 次重试，失败 bail
- **Node.js（最大缺口）**：完全硬编码 `nodejs.org/dist/`，不走任何镜像，国内几十 KB/s（200MB 需 10-20 分钟）
- 全运行时**无断点续传**，断网中断要重下几百 MB

**方案（Phase 1+2，已实施）**：

| 改动 | 实现 | 效果 |
|------|------|------|
| Node.js 走 npmmirror CDN | `portable_node.rs` 双源循环：npmmirror → nodejs.org | 下载提速 10-20x（10-20min → 1-2min） |
| 多镜像降级 | 新增 `downloader.rs::download_with_preferred_fallback()` | 候选=用户镜像→preferred_github(去重)→GitHub直连；每镜像 2 次重试，自动 resume |
| 断点续传 | 四运行时 `resume: false`→`resume: true` | 断网中断后 RANGE 续传，不从头重下 |

> Node.js 非 GitHub 资源，不走 `download_with_preferred_fallback`，而是独立的 npmmirror→nodejs.org 双源循环。底层 `download_once()` 已完备支持断点续传（RANGE 头 / PARTIAL_CONTENT / RANGE_NOT_SATISFIABLE），改动极小。

**待实施（Phase 3）**：reqwest 下载增加"无进展超时"机制（类似 stream_util heartbeat）——记录上次下载字节数，N 秒增量为零则中断，与 HTTP_TIMEOUT_SECS=300 总超时配合。

**实现**：`src/installer/downloader.rs`（download_with_preferred_fallback）+ `src/runtime/portable_node.rs`/`portable_git.rs`/`portable_python.rs` + `src/installer/config_gen.rs::download_newapi`

### 4.12 TUI 页面预览 + 第七页配置向导（main.rs + ui/config_guide.rs，2026-08-28 新增）

**--ui-preview 预览模式**：
- `main.rs` 新增 `run_ui_preview()`，复用 6 个 `render` 函数 + mock 数据（不新增 UI 文件）
- 键位：**PgDn 下一页 / PgUp 上一页 / Q 退出**
- 底部导航条（黄色）：`[UI Preview] {页名} (idx/total) | PgDn 下一页 / PgUp 上一页 / Q 退出`
- 快捷脚本：`show-tui-pages.bat`（双击运行，CARP 手动验证用）

**第七页 ConfigGuide（VCP 使用引导）**：
- 第六页 complete.rs 恢复 bak 原版；新文件 `src/ui/config_guide.rs`（青色边框）
- 四项引导：① 加载后端登录页面（AdminPanel http://localhost:6006/AdminPanel/）② 加载前端 UI 交互界面（start-frontend.bat）③ 推荐 llama.cpp 本地 AI 框架 ④ 推荐硅基流动 SiliconFlow API
- 真实流程：安装完成页按 **Enter** → 第七页；**Q/Enter/Esc** 退出
- 排版遵循 TUI 规范（禁 emoji、`[语义中文标签] URL` 两列、语义色边框）

**技术坑**：
- crossterm 0.28 翻页键是 `KeyCode::PageUp`/`KeyCode::PageDown`（非 PgUp/PgDn）
- ratatui `Style` 无 `.bold()`，必须 `.add_modifier(Modifier::BOLD)`
- 预览循环单次 `terminal.draw`（双 draw 清屏覆盖）
- **TUI 自动化测试限制**：管道发键序列不可靠（非 TTY 行为异常），TUI 交互效果**必须由 CARP 手动验证**

**实现**：`src/main.rs::run_ui_preview` + `src/ui/config_guide.rs` + `src/ui/app.rs`（ConfigGuide 变体）

### 4.13 start-upgrade.bat 组件升级脚本（config_gen.rs，2026-08-28 新增）

**需求**：安装流程结束后自动生成组件升级脚本到安装根目录，与 start-backend/frontend.bat 并列。

**设计**：

| 特性 | 实现 |
|------|------|
| 路径自适应 | `set "VCP_ROOT=%~dp0"` + 去尾部反斜杠 |
| 组件检测 | 4 个 `if exist "<组件>\\.git"` 检测；VCPToolBox/VCPChat 必选缺失→[WARN]，VCPBackUpDEV/VCPDistributedServer 可选缺失→[SKIP] |
| 重试韧性 | 每组件最多 3 次 `git pull`，失败等 5 秒（ping 占位）重试 |
| 日志 | 全部 git 输出写 `<root>\upgrade_log\upgrade.log`，控制台保留关键进度 |
| 双击友好 | 所有退出路径 pause 防闪退；纯 ASCII（chcp 65001 读取无乱码） |
| PATH 注入 | 注入 runtimes 下 git/node/python，与 start-backend.bat 一致 |

**融入**：`config_gen.rs::generate_start_upgrade_bat()`（bat 以 Rust 字符串内嵌，CRLF）+ `mod.rs` 第 09 步无条件生成。

**cmd 批处理坑（踩过，勿重踩）**：
1. **if 块内括号灾难**：`if %X%=="1" (echo [OK] xxx (required)>>"%LOG%")` 中 echo 文本的 `(required)` 会被 cmd 当块结束符 → `) was unexpected at this time`；`^)` 转义不可靠，**用单行 if-echo 不包块**
2. **延迟变量陷阱**：`!VAR!` 需 `setlocal EnableDelayedExpansion` 才生效；set 后立即用的普通变量用 `%VAR%` 即可
3. **Rust 字符串嵌 bat**：手工编辑 `\r\n` 转义 + `\` 续行符极易错乱，用 Python 脚本从源 bat 生成 Rust 字符串（自动转义）

**实现**：`src/installer/config_gen.rs::generate_start_upgrade_bat`

---

## 五、重大问题与修复记录

> 按主题归纳项目遇到的重大问题，每项含"现象→根因→修复"。这些是宝贵的踩坑记录。

### 5.1 网络类问题

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | pip install 失败（清华镜像缺包） | 系统 `pip.ini` 强制清华镜像 | 显式 `-i https://pypi.org/simple` 覆盖 |
| 2 | get-pip.py 下载失败 | 6 个 URL 前 5 个 404，第 6 个国内超时 | 改用 `ensurepip`（零网络依赖） |
| 3 | GitHub 网络不通 | reqwest 不自动读系统代理 | 启动 exe 传 `https_proxy` 环境变量 |
| 4 | 镜像站 HEAD 测速不可靠 | HEAD 不触发大文件传输，假阳性高 | 三阶段真实下载测试（Phase0/1/2） |
| 5 | git clone 永久卡死 | 阻塞式 `child.wait()` 无超时 | 非阻塞轮询 + 看门狗 |
| 6 | git clone 断流失败（curl 56） | 代理端突然关闭连接，瞬时故障 | 三层韧性链路（重试/换站/兜底） |
| 7 | npm/pip 断网挂死 | 拔线后 TCP 静默重传，不产生错误码 | 90 秒看门狗 + 心跳 |
| 8 | npm/pip 走官方源（海外） | `use_mirror` 为 false 未加 `--registry` | PM2 加 `--registry=npmmirror` + fetch 重试 |
| 9 | 拔线停滞 | TCP ESTABLISHED 静默重传 15+ 分钟 | 看门狗 `taskkill /T /F` 杀进程树 |
| 10 | 运行时下载慢（Node.js 直连） | Node.js 硬编码 nodejs.org，无镜像 | npmmirror CDN 双源降级（v18.12） |

### 5.2 版本/缓存类问题

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | Python 版本过低（3.10.21 装不上 mcpo） | `/releases/latest` API 含多版本未排序，取了最低版 | 按 (major,minor,patch) 降序取最高稳定版 |
| 2 | Python 旧缓存覆盖新版本 | 文件存在就认为可用，未校验版本 | 版本校验 + `clean_old_python_cache` 清理 |
| 3 | NewAPI 选错架构（arm64） | `asset_matches` 简单 contains 匹配 | 架构优先级匹配（amd64/x64 > arm64） |
| 4 | DL_runtimes 重复文件 | tester.rs 与 archive_ops.rs 缓存文件名不一致 | 统一为 `VCPToolBox.tar.gz` |
| 5 | INI runtime_versions 只记录 NewAPI | 4 运行时各自 clone，后写覆盖前写 | 写前合并已有条目（v18.9） |
| 6 | tarball commit 文件未生成 | 旧缓存无 .commit 直接跳过补记 | 无 .commit → `Ok(false)` 触发重新下载 |

### 5.3 路径类问题

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | MSYS2 路径与 Windows exe 不兼容 | MSYS2 传 POSIX 路径 `/d/Desktop/...`，exe 不识别 | `msys_to_native_path()` + `cygpath -w` |
| 2 | 安装到错误目录 `D:\d\Desktop` | headless 路径未转换 | main.rs 增加 `msys_to_native_path()` |
| 3 | 路径分隔符混用（/ 和 \） | 命令行保留 `/`，`Path::join()` 用 `\` | `normalize_path_display()` 统一为 `\` |
| 4 | npm 不识别 `\\?\` 长路径前缀 | canonicalize 在 Windows 盘符路径返回 `\\?\D:\...`（4 字符前缀），cmd/bat 不识别 | `strip_windows_long_path_prefix()` 剥离前缀 |
| 5 | **npm/pip 相对路径 bug（高）** | `run_installation()` 入口直接用 `config.install_path` 原始参数；headless 传相对路径时 runtimes_dir/node_dir/npm bat 路径全相对 → bat 在 cwd=组件目录 下多解析一层失败 | **Plan A**（v18.12）：`mod.rs` 最开头 `install_dir = to_command_abs_path(...)` 源头绝对化；`npm_ops.rs::to_command_abs_path()`（绝对直通/相对 join+canonicalize+剥前缀）+ `strip_windows_long_path_prefix()` |

> **5.3-5 教训**：canonicalize 在 Windows 返回 `\\?\` 前缀，bat 不识别 → bat 内报"找不到路径"。首轮修复曾直接用 canonicalize 结果写入 bat 仍失败，第二轮测试暴露后立即加 strip 修正。正式目录（exe 与 VCP_AIOS 同级）相对路径恰好成立故未暴露，test-install 嵌套布局才暴露。

### 5.4 日志类问题

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | TUI 日志截断 | AllCompleted 用 `std::fs::write`（覆盖）dump 清除前段 | 删除 write dump，仅靠 `push_log()` 追加 |
| 2 | TUI 日志刷屏 | tester.rs 40+ 处 `eprintln!` 绕过日志通道 | 全部改 `send_log(&progress_tx)` |
| 3 | TUI 全量日志丢失 | `OnceLock::get()` 顺序依赖，setter 静默落空 | 单路分段架构 |
| 4 | TUI 全量日志重复 | 双写（installer 线程 + TUI 主循环同时 append） | 单路分段 + 合并全量 |
| 5 | 01_prepare.log 双重来源 | TUI/Headless 两条写日志路径 | `write_prepare_log()` 统一 |
| 6 | 文件大小显示 0.0 MB | 小文件（8.3KB）格式化错误 | `format_file_size()` 自动选单位 |
| 7 | git reset 原始输出进日志 | `run_git` 把 stderr 原样记入 | 静默执行 + 标准化日志（v18.9） |
| 8 | remote: 噪音（Counting/Compressing） | 只在 Line handler 过滤，Progress 漏掉 | Line + Progress 双通道过滤（v18.4） |

### 5.5 界面类问题

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | TUI 闪退（git clone 时） | 步骤名过长导致文字溢出 | 步骤名缩短 + 布局 Min(13) |
| 2 | 步骤列表文字重叠 | ○/*/[FAIL] 全角字符宽度计算异常 | 统一 ASCII 等宽 4 字符 |
| 3 | 进度条 95% 卡住（不到 100%） | 分桶条件缺 `pct == 100` | 加 `\|\| pct == 100`（v18.3） |
| 4 | 进度条灰色不动 | 3 运行时闭包硬编码 `step_index: 0` | 传入正确索引（Git=1,Node=2,Python=3） |
| 5 | 环境检测误报（拔线仍 YES） | 配置有镜像站就恒 true | 真实探测 `test_all_github_mirrors()` |
| 6 | MSVC 误报可达 | 用的是安装状态非下载源探测 | 新增 `test_msvc_source_reachable()` |
| 7 | URL 双重拼接 | 镜像 URL 已含 `https://github.com/`，未去前缀 | `apply_mirror_to_url` 加前缀 strip |
| 8 | 17 步进度列表被窗口截断 | 窗口高度有限，底部步骤溢出 | 移除子步骤，17→11 步 |
| 9 | npm warn 刷屏（deprecated） | npm 上游包废弃提示 | 2 条提示不影响安装，跳过 |

### 5.6 git 升级类问题（v18.10 + 运行调试03）

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | tarball 模式 git pull 失败 | `.git` 分支名 `master`（git init 默认），缺 tracking 配置 | `git init -b main` + `branch --set-upstream-to=origin/main`（v18.10） |
| 2 | 目录对比发现差异 | tarball 松散 objects vs clone pack 文件 | git 自动选择，不影响 pull（无需修） |
| 3 | **tarball 模式空仓库升级 bug** | tarball 模式 VCPBackUpDEV：git init 后 `git fetch --depth 1` 遇镜像 429 限流，3 次全失败 → 留下"有 origin 但无 commit、无 upstream"的**空 .git 仓库** → `git pull` 报 no tracking information，升级 3 次全 FAIL | **Plan B**（git_ops.rs::git_init_from_remote 多镜像轮换 fetch，每站 3 次重试）+ **Plan A**（component_ops.rs 调用处：fetch 全失败时 remove_dir_all 遗留 .git，回退纯 tarball 状态）（运行调试03，2026-08-29） |

> **5.6-3 风险评估**：单镜像 fetch 失败**不应留下半吊子 .git**。tarball+git 模式的 git 初始化是"尽力而为"的增强（不阻断安装），失败时必须回滚到纯 tarball 干净态。有 .git → 升级脚本误判为 git 仓库尝试 pull → 必 FAIL；无 .git → 升级脚本 SKIP（正确处理）。**教训**：单镜像 fetch 失败不应留下半吊子 .git。

**风险评估结论**：
- **导致 git pull 失败的**：分支名 `master`≠`main` + 缺 `branch.main.remote`/`merge` + 空仓库无 commit
- **不影响 git pull 的**（git 自动管理）：packed-refs vs 松散 refs、pack vs 松散对象、FETCH_HEAD

### 5.7 原生模块/ABI 类问题（运行调试01，2026-08-24）

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | **better-sqlite3 ABI 不匹配（VCPChat UI 不显示）** | VCPChat 是 Electron 41（ABI 145），但 better-sqlite3 按系统 Node 24（ABI 137）编译，require 抛错 → 主进程崩 | electron-rebuild 按 Electron ABI 重建（`node cli.js -f -o better-sqlite3`）；验证 `.forge-meta = x64--145` |
| 2 | electron-edge-js 误编译 | electron-rebuild 误对 .NET CoreCLR 模块跑 node-gyp，edge_nativeclr 缺 MSCOREE.lib 编译失败 | 跳过 electron-edge-js（edge.js 自动回退 edge_coreclr.node）；electron_rebuild.rs 扫描时排除 |
| 3 | **0xC0000409 进程闪退（安装第 09 步）** | 初版用 `run_sync_step`（在 async worker 线程直接调 `job()`），electron-rebuild 长时间阻塞 + `blocking_send`，channel 满需真正 block 时 tokio 检测"async 上下文 block" → panic → `panic=abort` → 0xc0000409 fail-fast | 改用 `run_blocking_step_with_log`（走 `spawn_blocking`，阻塞操作在独立线程池，blocking_send 合法） |

> **5.7-3 巧合同码**：0xC0000409 与 VCPChat 的 audio_server.exe 崩溃同码，但**成因独立**——一个是安装器 run_sync_step 的 async 阻塞（已修复），一个是 VCPChat 自带 Rust 音频引擎 tokio runtime 在 async 上下文 drop（VCPChat 自身 bug，安装器不处理）。

### 5.8 依赖类问题（记录在案，部分待上游处理）

| # | 问题 | 影响 | 处置 |
|---|------|------|------|
| 1 | mcpo 版本回退（0.0.20→0.0.9） | 依赖冲突 | Python 升到 3.14.7 后解决 |
| 2 | npm deprecated 包（glob/rimraf/xterm 等） | 潜在安全风险 | 留给上游项目升级 |
| 3 | pip 脚本 PATH 警告 | 不影响（启动脚本已注入 PATH） | 可选 `--no-warn-script-location` |
| 4 | npm allow-scripts 挂起脚本 | VCPChat 几乎确定无法启动 | 四阶段方案（4.4） |
| 5 | **VCPChat 音频引擎 0xC0000409（VCPChat 自身 bug）** | audio_server.exe tokio runtime 在 async 上下文 drop → panic=abort → 音乐播放/TTS 不可用 | **非安装器问题**，留给 VCPChat 上游修复 |
| 6 | config.env 全部占位符 | 主 API /v1/models 返回 Invalid URL；VCPChat 对话会失败 | 不影响启动测试；生产环境替换真实值 |

---

## 六、关键测试验证记录

> 项目的关键测试里程碑，证明各项能力真正生效。

### 6.1 拔线测试（v18.1，2026-08-21）

**测试条件**：中途拔网线，之后**始终断网未恢复**（比"拔线再插回"更严苛）。

**核心验证（全部通过）**：

| 验证点 | 结果 |
|--------|------|
| npm 挂死被杀 | ✅ 全程 9 次触发看门狗，每次 ~90 秒内 kill 后重试 |
| git 镜像站轮询 | ✅ VCPChat：3 站 × 3 次全失败 → 自动切 Tarball 兜底成功 |
| git 通道记忆 | ✅ 后续组件直接跳过 git（省 ~15 分钟） |
| Tarball 兜底 | ✅ 3 组件从 DL_runtimes 缓存部署成功 |
| 进程残留 | ✅ 无孤儿 node/git/pip/python 进程（taskkill /T /F 有效） |
| 断网不挂死 | ✅ 全程 20 分 10 秒跑完 9 阶段，**无任何一处卡死** |

**结论**：看门狗 + Tarball 兜底链路基本生效，v17 拔线停滞 bug 已消灭。

### 6.2 无 VPN Git Clone 实战（v17，2026-08-21）

**三层韧性链首次真实触发**：
```
[git] clone https://g.z321.cc.cd/...VCPToolBox.git
[git] ! 第1/3次尝试失败: git clone 失败 (exit 128)
[git] ! 第2/3次尝试失败: git clone 失败 (exit 128)
[git] ! 第3/3次尝试失败: git clone 失败 (exit 128)
! git clone 所有镜像站均失败，切换 Tarball 兜底模式
[tarball] 使用缓存: VCPToolBox.tar.gz (174.3 MB)   ← Phase2 测试缓存复用
```

**深层洞察**：tarball 能下 ≠ git 能 clone（同一时刻同一站点，tarball 成功但 git clone 失败）。ASh 手动复测证明是**瞬时故障，现已恢复**——正是韧性链要应对的场景。

**结论**：无 VPN 时可用站极少（仅 1 个），韧性设计是刚需不是保险。总耗时 6 分 40 秒，0 错误。

### 6.3 双模式 git pull 升级测试（v18.10，2026-08-23）

**测试结果（8/8 全部成功）**：

| 组件 | tarball 模式 | clone 模式 |
|------|:---:|:---:|
| VCPToolBox | ✅ SUCCESS (exit 0) | ✅ SUCCESS (exit 0) |
| VCPChat | ✅ SUCCESS (exit 0) | ✅ SUCCESS (exit 0) |
| VCPBackUpDEV | ✅ SUCCESS (exit 0) | ✅ SUCCESS (exit 0) |
| VCPDistributedServer | ✅ SUCCESS (exit 0) | ✅ SUCCESS (exit 0) |

**结论**：tarball/clone 双模式升级行为完全等价，v18.10 git 分支统一 + tracking 配置修复彻底解决 tarball 模式 git pull 问题。

### 6.4 headless 全流程验证（v18.12 候选，2026-08-28 第二轮，npm 路径 bug 修复后）

**测试环境**：`D:\Desktop\vcp-installer-test\test-install`（独立目录）

**结果**（全新目录，~12 分钟，EXIT_CODE=0，**全部成功无错误**）：

| 阶段 | 状态 | 耗时 | 验证点 |
|------|------|------|--------|
| 02 镜像站点测试 | ✅ | 80s | 三步筛选 + 优选复用 |
| 03 运行时安装 | ✅ | 19s | Git/Node/Python/NewAPI 全缓存命中 |
| 04 MSVC | ✅ | 0s | 已检测 |
| 05 VCPToolBox | ✅ | 309s | npm install 成功 + **PM2 安装完成** + pip install 成功 |
| 06 VCPChat | ✅ | 291s | npm install 成功 + 原生模块 .node 产物验证 + pip install 成功 |
| 09 脚本生成 | ✅ | 94s | start-backend/frontend/upgrade.bat 生成 |

**运行时下载韧性逐项验证**（248 秒首轮回测 + 第二轮确认）：

| 链路 | 日志证据 | 结论 |
|------|----------|------|
| PortableGit 多镜像降级 | `开始下载（多镜像降级，共 4 个候选）` + 首选成功 | ✅ 生效 |
| Node.js 多源降级 | `多源降级：npmmirror → nodejs.org` → `[OK] 下载成功（来源: npmmirror 国内CDN）` | ✅ 生效（走 CDN 未回退） |
| 断点续传 | `检测到本地文件可能已完整下载，跳过续传` | ✅ 生效 |
| Python 缓存校验 | `缓存校验通过（版本 cpython-3.14.7+...），使用缓存` | ✅ 符合预期 |
| NewAPI | headless 精简版不含 NewAPI 未触发 | ⏳ 代码已改编译通过，待完整组件测试 |

**npm install 全链路**（approve-scripts / electron-rebuild / PM2）均正常，bat 内 npm.cmd 为绝对路径且无 `\\?\` 前缀。

### 6.5 双模式产物对比 + 空仓库 bug 修复验证（运行调试03，2026-08-29）

**双模式产物对比**（CARP 手动两次安装 VCP_AIOS_tarball / VCP_AIOS_gitclone）：

| 项 | VCP_AIOS_tarball | VCP_AIOS_gitclone |
|----|------------------|-------------------|
| 顶层结构 | 4组件 + runtimes + 3bat + upgrade_log | **完全一致** |
| 4 组件 .git | 有（VCPBackUpDEV 除外，见下） | 有 |
| 分支名 | main | main |

**空仓库 bug 修复验证**（CARP 用新 exe 重装 VCP_AIOS3 + 升级）：

| 组件 | 升级结果 |
|------|------|
| VCPToolBox | ✅ SUCCESS（a45eba0e） |
| VCPChat | ✅ SUCCESS（2e472f67） |
| VCPBackUpDEV | ✅ SUCCESS（544629e，**上次 FAIL 的组件**） |
| VCPDistributedServer | ✅ SUCCESS（55dfd68） |

VCPBackUpDEV 的 .git 恢复正常（HEAD: main / commit: 544629ec / upstream: origin/main）。

**诚实说明**：本次优选镜像 #1 是 gh-proxy.com（上次 429 的是 gh.jasonzeng.dev），fetch **首次就成功**，所以 **Plan B 多镜像轮换 + Plan A 回滚路径均未触发**。已确认代码编译正确、常见场景无回归；降级路径压测需复现 429/断网（首镜像失败才轮换）——延后处理。

### 6.6 缓存复用验证（v1，2026-08-11）

清空 `VCP_AIOS/runtimes` 后重新安装：
```
✅ 发现 DL_runtimes 中的 new-api.exe，拷贝到 runtimes
✅ [12/13] 下载 NewAPI（未重新下载，直接复用）
```

### 6.7 v18.9 INI 版本校验验证

```ini
[runtime_versions]
Node.js = v24.19.0
PortableGit = v2.55.0.windows.5
Python = cpython-3.14.7+20260814-x86_64-pc-windows-msvc-install_only.tar.gz
NewAPI = v1.0.0-rc.25
```
4 条全部写入（修复覆盖 bug 后）。

---

## 七、运行测试阶段专项总结

> 安装精修完成后转入的**运行测试阶段**（运行调试01-03），验证安装产物真正可启动运行，并补齐安装器运行相关能力。

### 7.1 VCPToolBox + VCPChat 启动验证（运行调试01，2026-08-24）

**测试目标**：`start-backend.bat` 启动 VCPToolBox + `start-frontend.bat` 启动 VCPChat，成功打开控制面板，不缺依赖，不报错。

**启动验证结果（全部达标）**：

| 测试项 | 结果 | 关键证据 |
|--------|------|----------|
| VCPToolBox 后端启动 | ✅ | vcp-main (PID 8552, 381MB) + vcp-admin (PID 12900, 89MB) 双进程 online |
| 依赖完整性 | ✅ | 无缺包/缺模块报错 |
| VCPChat 前端启动 | ✅ | electron.exe ×3 进程运行 |
| VCP-CDS 初始化 | ✅ | Rust 数据服务 ready（端口 57871） |
| AdminPanel 访问 | ✅ | 6006 端口，未认证 302→login.html |
| AdminPanel 鉴权 | ✅ | Basic Auth + Cookie + IP 防爆破机制正常 |

**关键架构确认**：
1. **AdminPanel 是独立进程**，端口 6006 = MAIN_PORT + 1（`adminServer.js:16`）
2. **VCPChat 无独立管理面板**——官方定位 VCPToolBox=后端大脑、VCPChat=前端界面；所有后端管理统一走 AdminPanel（18 个功能分区）
3. **系统直接读 config.env 字面量**——占位符字符串就是当前有效密码

**VCPChat 控制台报错分类**（CARP 要求）：

| 级别 | 报错 | 性质 |
|------|------|------|
| 🔴 关键 | Rust 音频引擎 audio_server.exe 崩溃 0xC0000409 | VCPChat 自身 bug（tokio runtime 在 async 上下文 drop），非安装器问题 |
| 🟡 配置 | `settings.json` ENOENT / `mainServerUrl or vcpKey is not configured` | 首启未配置服务器的预期表现 |
| ⚪ 警告 | npm warn Unknown project config / loudness database 重复列 / DEP0190 | 可忽略 |

### 7.2 本轮待办演进（运行测试阶段）

| # | 事项 | 优先级 | 状态 |
|---|------|--------|------|
| 1 | 配置 VCPChat 全局设置 → 验证前后端通信 | 高 | 待做 |
| 2 | 替换 config.env 占位符 → 验证真实 AI 对话 | 高 | 待做 |
| 3 | AdminPanel 18 个功能分区逐项走查 | 中（CARP 手动为主） | 待做 |
| 4 | VCP 工具调用链路验证（插件 config.env） | 中 | 待做 |
| 5 | 修复 vcp-upgrade.bat 闪退 + 优化为 start-upgrade.bat 融入安装器 | 中 | ✅ 完成（CARP 实测通过） |
| 6 | 第七页排版 + 真实流程 Enter 翻页 | 低 | ✅ 完成（CARP 实测通过） |
| 7 | 运行时下载韧性改造（Phase1+2） | 高 | ✅ 完成（编译+headless 验证）；Phase3 下载看门狗待做 |
| 8 | npm install 相对路径 bug（Plan A 彻底修复） | 高 | ✅ 完成（headless 验证通过） |

---

## 八、当前状态与遗留项

### 8.1 当前版本

| 项 | 值 |
|----|-----|
| 稳定版本 | **v18.10**（`vcp-installer-18.10-tarball-git-fix.exe`，双模式安装+升级全部验证通过） |
| 开发版本 | **v18.12**（运行时下载韧性 Phase1+2 + npm 路径 bug Plan A 彻底修复 + 空仓库 bug Plan A+B，2,705,408 bytes，已部署） |
| TUI 用户可见版 | **v2.0**（welcome.rs + Cargo.toml，08-24 起） |
| 状态 | ✅ v18.10 稳定 / ⚠️ v18.12 含多项未完整压测的修复（见 8.3） |
| 精修状态 | **安装精修大体完成**（五维达标）+ **运行测试阶段完成**（产物可启动运行） |

### 8.2 已核实关闭的历史遗留（2026-08-23 ASH 自主核实）

这些是历史报告里标记的"待处理"项，实际已解决或被替代，**无需再处理**：

| # | 遗留项 | 核实结论 |
|---|--------|----------|
| 1 | npm allow-scripts（v11 遗留） | ✅ 已实现完整四阶段（Phase1-4 含 .node 产物验证），代码在 `npm_ops.rs::approve_npm_scripts` |
| 2 | 缓存迁移 cache.rs（11a 遗留） | ✅ `CacheManager` 已被 archive_ops/component_ops/runtime/* 全部接入 |
| 3 | download_manifest.json（早期 P1） | ✅ 从未实现，已被 INI `[component_commits]` + `.commit` 伴生文件 + INI `[runtime_versions]` 机制替代 |
| 4 | PortableGit 文件名规范化 | ✅ 固定名 + INI 版本校验已覆盖（版本匹配才用缓存），无实际影响 |

### 8.3 剩余遗留项（不阻塞，记录待办）

| # | 遗留项 | 说明 | 风险 |
|---|--------|------|------|
| 1 | **Plan B 多镜像降级压测**（运行调试03） | 空仓库 bug 修复的降级路径未真实触发（需复现 429/断网首镜像失败） | 中 |
| 2 | **Phase 3 下载看门狗**（运行调试03） | reqwest 下载"无进展超时"机制待实施 | 中 |
| 3 | **NewAPI 下载链路完整测试**（运行调试03） | 运行时下载韧性 Phase1+2 的 NewAPI 链路 headless 精简版未覆盖 | 低 |
| 4 | **v18.11 MSVC 必需性实测** | 代码已编译通过，待卸载 MSVC 后重跑完整安装验证看门狗/重试/验证链路 | 中 |
| 5 | **前后端真实通信验证** | VCPChat 配置服务器地址+用户名 → 验证前后端通信 + 真实 AI 对话 | 高 |
| 6 | Python 版本值格式 | INI 存的是文件名而非干净版本号（Git/Node 是版本号）。仅美观 | 低 |
| 7 | PM2 全局安装偶发超时 | 断网/弱网下偶发，非核心，可手动补装 | 低 |
| 8 | preferred_github 时效性 | 优选列表安装时动态生成保存，每次重装会重新测试，风险低 | 低 |
| 9 | npm ECONNRESET 重试 | 已有 download_with_retry，npm 本身无独立重试封装 | 低 |

### 8.4 预期行为（非 bug）

- npm/pip 断网装不上依赖 → 预期行为，联网后手动补装
- tarball 模式 .git 用松散对象（小仓库）/clone 用 pack 文件 → git 自动选择，不影响功能
- VCPChat 首启 `VCP Server URL is not configured` → 需在界面手动配置（官方必做项）
- VCPChat 音频引擎 0xC0000409 → VCPChat 自身 bug，安装器不处理

---

## 九、经验教训

> 项目开发中沉淀的核心经验，是后续维护的黄金法则。

### 9.1 工作方法论

1. **充分学习已有报告，避免重复踩坑**：开始工作前先读所有相关测试报告，了解已有经验和结论。HEAD 测速不可靠的结论 8 月 13 日已得出，不要重复验证。

2. **多步骤组合处理复杂问题**：单步骤解决不了的问题（镜像筛选/allow-scripts/断网韧性）用多步骤叠加，效果远大于单步骤。

3. **测试与生产一体化**：Phase2 测试文件直接用于安装，不产生额外流量，测试结果直接服务生产。

4. **先记录后修复**（CARP 偏好）：逐个测试时先记录所有问题不改代码，全部测完再统一修复。

5. **方案讨论用 Plan A/B/C**：复杂问题给 CARP 多方案选择，不未经确认直接改代码。

6. **参考旧代码对比定位**（CARP 原则）：调试疑难 bug 时主动读反复测试且能稳定运行的旧版/备份代码对比找差异，而不是只在脑子里空想机制。

### 9.2 技术教训

1. **不要轻信 exit code**：npm install exit 0 只表示包文件下载成功，不代表 postinstall 脚本执行成功，必须看日志 warn。

2. **HEAD 测速完全不可信**：HEAD 响应快 ≠ 大数据传输可用，必须用真实 git clone 验证（至少 200MB+ 负载）。

3. **拔线 ≠ VPN 关闭**：VPN 关闭产生 ECONNREFUSED（重试能抓），拔线是 TCP 静默重传（不产生错误码，重试全失效），需看门狗兜底。

4. **tarball 能下 ≠ git 能 clone**：同一时刻同一站点，tarball 成功但 git clone 可能失败（代理对 git 协议和大文件处理不同）。

5. **Python 版本取最高稳定版**：`/releases/latest` API 含多版本，必须按 (major,minor,patch) 降序取最高，排除 freethreaded/RC/beta。

6. **git 分支名统一**：`git init` 默认 `master`，需显式 `-b main` + tracking 配置，否则 git pull 失败。

7. **单镜像 fetch 失败不留半吊子 .git**：tarball+git 模式的 git 初始化是"尽力而为"增强，失败时必须回滚到纯 tarball 干净态（运行调试03）。

8. **网络请求统一加超时和重试**：所有长时操作必须有超时，下载必须有重试和换站兜底。

9. **Electron 原生模块 ABI**：Electron 应用的原生模块必须按 Electron ABI 重编译（electron-rebuild），重装/升级 Electron 后需跑，否则前端静默失败（UI 不显示）。

10. **async 上下文阻塞必闪退**：tokio async worker 线程上做长时间阻塞 + blocking_send，channel 满需真正 block 时触发 panic=abort（0xc0000409）。阻塞操作必须走 `spawn_blocking`。

11. **canonicalize 后剥离 `\\?\` 前缀**：Windows 盘符路径 canonicalize 返回 `\\?\` 4 字符前缀，cmd/bat 不识别 → 报"找不到路径"。

### 9.3 编码规范

- Windows CMD/PowerShell 脚本含中文必须 GBK 或纯 ASCII（UTF-8 会乱码）
- cmd.exe 中 `start` 命令第一个引号参数是窗口标题，需 `start "" "exe_path"` 语法
- TUI 界面禁用 emoji/特殊符号（只查 ui/*.rs）
- 子进程输出统一走 `stream_util.rs`（防管道死锁 + 看门狗）
- 关键流程（校验/下载/状态变化）必须同步输出到 TUI 和日志文件（CARP 原则）
- 安装路径必须在 `run_installation()` 入口源头绝对化（防相对路径 bug 传播到整条链路）
- cmd 批处理：if-echo 不包块（避括号灾难）；Rust 嵌 bat 用 Python 脚本生成（自动转义）

---

## 十、源报告索引

> 本总结整合的源报告清单，供追溯原始细节。

### 安装调试报告（md/ 目录，安装精修阶段）

| 报告 | 日期 | 主题 | 对应版本 |
|------|------|------|----------|
| 安装调试报告1.md | 08-11 | pip 镜像干扰 + 路径修复 | v1 |
| 安装调试报告2.md | 08-11 | 无 VPN 真实测试 | - |
| 安装调试报告3.md | 08-14 | 网络提示 + Python 动态化 + NewAPI | - |
| 安装调试报告4.md | 08-15 | 镜像站分阶段测试 | - |
| 安装调试报告5.md | 08-15 | TUI 优化 + URL 拼接 | - |
| 安装调试报告6.md | 08-15 | Python 版本升级 + 缓存架构 | - |
| 安装调试报告7.md | 08-16 | 日志架构定稿 | - |
| 安装调试报告8.md | 08-17 | 日志时机前移 + Defender | - |
| 安装调试报告9.md | 08-18 | 镜像站文件优化 + 双安装方式 UI | - |
| 安装调试报告10.md | 08-18 | Tarball 安装方式实现 | v10 |
| 安装调试报告11.md | 08-18 | 日志系统统一 | v11 |
| 安装调试报告12.md | 08-20 | Tarball+Git 模式 + 三层韧性 | v12/15 |
| 安装调试报告13.md | 08-21 | 全链路网络重试补全 | v16 |
| 安装调试报告14.md | 08-21 | 无 VPN Git Clone 实战 | v17 |
| 安装调试报告15.md | 08-21 | 拔线停滞修复 | v18 |
| 安装调试报告16.md | 08-21 | 拔线停滞修复交接 | v18 |
| 安装调试报告17.md | 08-21 | 拔线测试核对 | v18.1 |
| 安装调试报告18.md | 08-23 | TUI 显示修正 + 遗留收尾 | v18.2 |
| 安装调试报告19.md | 08-23 | remote 噪音二次修复 + commit 校验 | v18.3/18.4 |
| 安装调试报告20.md | 08-23 | INI 覆盖修复 + git 分支统一 | v18.9/18.10 |
| 安装调试报告21.md | 08-24 | MSVC 改必需 + 看门狗/重试/验证加固 | v18.11 |

### 运行调试报告（md/ 目录，运行测试阶段；物理文件名与内容标题对照）

| 物理文件名 | 内容标题 | 日期 | 主题 |
|------|------|------|------|
| 安装调试报告22.md | 运行调试报告01 | 08-24 | VCPToolBox+VCPChat 启动验证 + better-sqlite3 ABI 修复 + electron-rebuild 融入 + 0xC0000409 闪退修复 |
| 安装调试报告23.md | 运行调试报告02 | 08-24/08-28 | headless 精简 + v2.0 + 前后端验证 + UI 预览/第七页 + start-upgrade.bat 升级脚本 |
| 安装调试报告24.md | 运行调试报告03 | 08-28 | 运行时下载韧性 Phase1+2 + npm 路径 bug Plan A 彻底修复 |
| 安装调试报告25.md | 运行调试报告03 | 08-29 | tarball/clone 双模式对比 + 空仓库升级 bug Plan A+B |

> 注：24/25 文件内容标题都标"运行调试报告03"（源文档编号碰撞），本索引以物理文件名为准区分。

### 阶段总结 + 经验总结（md/ 目录）

| 报告 | 主题 |
|------|------|
| 安装测试工作总结_阶段2.md | 运行测试阶段滚动总结（运行调试01-03） |
| get-pip.py下载失败原因分析报告.md | get-pip.py URL 失效 + ensurepip 方案 |
| GitHub镜像站筛选测试工作经验总结.md | Phase0/1/2 筛选方法论 |
| npm allow-scripts安装问题工作经验总结.md | allow-scripts 多步骤方案 |
| VCP安装测试npm.md | npm/pip 依赖问题分析 |
| 安装调试报告_汇总.md | 报告 1-6 整合 |

### 必须保留（md/必须保留/ 目录，勿删）

| 文件 | 说明 |
|------|------|
| VCP Installer_工作经验总结报告.md | 综合工作经验 |
| VCP_Installer_新旧版本对比分析.md | 新旧版本对比 |

### 配套测试工具

| 文件 | 说明 |
|------|------|
| `D:\Desktop\vcp-installer-test\vcp-upgrade.bat` | 早期 git pull 升级测试脚本（已被 start-upgrade.bat 取代） |
| `D:\Desktop\vcp-installer-test\v18.2-verify.bat` | v18.2 自动验证脚本（纯 ASCII） |
| `D:\Desktop\vcp-installer-test\show-tui-pages.bat` | TUI 页面预览快捷脚本 |
| `D:\Desktop\vcp-installer-test\upgrade_log\` | git pull 升级测试日志 |

---

## 十一、快速参考

### 11.1 构建命令

```bash
cd /d D:\Desktop\vcp-installer-source-new
cargo build --release --target x86_64-pc-windows-msvc
```

### 11.2 headless 测试命令

```bash
cd D:\Desktop\vcp-installer-test
.\vcp-installer.exe --headless --install-dir VCP_AIOS_test --mirror-config vcp-mirrors.ini
```

### 11.3 VCP 运行命令

```bash
cd D:\Desktop\vcp-installer-test\VCP_AIOS
start-backend.bat          # 启动 VCPToolBox 后端（pm2 守护 vcp-main + vcp-admin）
start-frontend.bat         # 启动 VCPChat 前端（electron .）
start-upgrade.bat          # 组件 git pull 升级（4 组件，3 次重试）

# 停止服务
runtimes\node\node_modules\pm2\bin\pm2 stop all
taskkill /IM electron.exe /F
```

### 11.4 关键日志位置

| 日志 | 位置 |
|------|------|
| 全量日志 | `Install_log\00_full_log.txt` |
| 分段日志 | `Install_log\01_prepare` ~ `09_scripts` |
| 汇总日志 | `Install_log\install_summary.log` |
| 升级日志 | `VCP_AIOS\upgrade_log\upgrade.log` |
| pm2 日志 | `~/.pm2/logs/vcp-main-out.log` / `vcp-admin-out.log` |
| VCPToolBox ServerLog | `VCPToolBox\ServerLog.txt` |

### 11.5 关键代码位置

| 功能 | 文件 |
|------|------|
| 镜像筛选 | `src/mirrors/tester.rs` |
| 三层韧性 | `src/installer/git_ops.rs` + `archive_ops.rs` |
| 看门狗/心跳 | `src/installer/stream_util.rs` |
| npm allow-scripts | `src/installer/npm_ops.rs::approve_npm_scripts` |
| npm 路径绝对化 | `src/installer/npm_ops.rs::to_command_abs_path` + `mod.rs::run_installation` |
| pip 多源韧性 | `src/installer/pip_ops.rs` |
| 缓存管理 | `src/cache.rs`（CacheManager） |
| INI 版本校验 | `src/mirrors/config.rs::set_and_save_runtime_version` |
| 日志架构 | `src/log_router.rs` + `src/env_log.rs` |
| TUI 界面 | `src/ui/*.rs` |
| electron-rebuild | `src/installer/electron_rebuild.rs` |
| 运行时下载韧性 | `src/installer/downloader.rs::download_with_preferred_fallback` |
| TUI 预览/第七页 | `src/main.rs::run_ui_preview` + `src/ui/config_guide.rs` |
| 升级脚本生成 | `src/installer/config_gen.rs::generate_start_upgrade_bat` |
| 空仓库 bug 修复 | `src/installer/git_ops.rs::git_init_from_remote`（Plan B）+ `component_ops.rs`（Plan A） |

---

*本总结由 Hermes Agent (ASH) 整合 md 目录全部安装调试报告（1-25）+ 运行调试报告（01-03）+ 经验总结 + 阶段总结去重归纳，最后更新：2026-08-29。*
*安装精修收官 + 运行测试达标，VCP Installer 进入稳定维护阶段。*
