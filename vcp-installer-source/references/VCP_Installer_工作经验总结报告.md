# VCP Installer 工作经验汇总报告

> **日期**: 2026-08-29
> **作者**: ASH (Hermes Agent)
> **来源**: 安装调试报告 1-25、运行调试报告 01-03、交接工作文档、专项经验总结
> **时间跨度**: 2026-08-11 ~ 2026-08-29（19 天）
> **版本演进**: v10 → v18.12（内部精修版）/ TUI 用户可见版 v2.0
> **重点**: 工作方式、思路、逻辑 — 不是怎么修 BUG

---

## 一、核心工作原则

### 原则 1：复杂问题必须多步骤组合处理

**核心观点**：复杂的问题不是单步骤能解决的，多步骤组合处理，各种处理叠加的效果远大于分开单独使用。

**典型例证**：

**镜像站筛选（Phase0 → Phase1 → Phase2）**：
- Phase0：HEAD 请求预校验项目存在性（秒级，过滤不支持的站点）
- Phase1：真实下载前 10MB，10 秒超时（分钟级，排除假通站点，速度排序）
- Phase2：完整下载测试文件 ~175MB（几分钟，最终验证）

**npm allow-scripts（Phase1 → Phase2 → Phase3 → Phase4）**：
- Phase1：`npm approve-scripts --allow-scripts-pending` 列出挂起包
- Phase2：逐个批准每个包
- Phase3：`npm rebuild` 触发已批准包的 install scripts 执行
- Phase4：验证原生模块 .node 产物是否生成（2026-08-22 新增）

**三层韧性链路（git clone 断流）**：
- 同站重试 2 次（每站最多 3 次尝试）
- 失败换 preferred_github 备用站
- 备用站全试过 → 切换 Tarball 模式兜底

**单步骤为什么失败**：
- 镜像站 HEAD 测速全部通，git clone 仅 2 个成功 → HEAD 不可信
- npm install exit code:0，但脚本未执行 → 不检查 warn 信息就会误判
- git clone 一次瞬时断流 → 单镜像失败就 bail，没有换站和兜底

### 原则 2：充分利用已有经验和开发日志

**核心观点**：VCP Installer 是在原代码上做精修，不是全新构建。必须充分学习原代码的开发日志，优先利用已有经验，而不是自己构建一套新逻辑。

**教训**：
- npm allow-scripts 多步骤方案在 v11 版本已验证通过，ASH 一开始差点重新设计方案
- HEAD 测速不可靠的结论在 8月13日的测试报告中已得出，ASH 应该更早利用这个经验
- 每次遇到新问题，先查阅 `md` 目录下的安装调试报告，看是否已有相关经验
- stream_util.rs 的看门狗/心跳机制已解决 git/npm/pip 的管道死锁问题，electron-rebuild 子进程输出读取应直接复用，不要手写

### 原则 3：不信任表面现象

**核心观点**：表面看似成功的结果，可能隐藏着关键问题。必须深入检查日志细节。

**典型例证**：

| 表面现象 | 实际问题 | 验证方法 |
|----------|----------|----------|
| npm install exit code:0 | allow-scripts 导致脚本未执行 | 检查日志中的 `npm warn allow-scripts` |
| HEAD 请求延迟 0.6 秒 | 真实下载速度极慢（60秒仅 11MB） | 必须用真实负载（git clone / 大文件下载）验证 |
| `npm approve-scripts --allow-scripts-pending` 输出包列表 | 这只列出包，不执行审批 | 必须逐个 approve + rebuild |
| 镜像站 HEAD 30个全部通 | git clone 仅 2 个成功 | 必须用真实下载验证 |
| tarball 解压成功（文件完整） | git init 后 fetch 全失败，留下空 .git 仓库 | 检查 `.git` 是否有 commit 和 upstream |
| 前端窗口出来了 | 原生模块 ABI 不匹配，Electron 主进程静默崩溃 | 检查 `NODE_MODULE_VERSION` 报错 + .forge-meta 版本 |
| 安装器 exe 能跑 | 相对路径 bug 只在特定目录布局暴露 | headless 传相对路径时检查 bat 内 npm.cmd 路径 |

### 原则 4：测试与生产一体化

**核心观点**：设计测试流程时，测试结果应直接服务于生产环境，避免"为测试而测试"。

**典型例证**：

**镜像站测试文件缓存**：
- Phase2 测试文件使用 VCPToolBox.tar.gz（实际安装文件）
- 测试成功后缓存到 DL_runtimes/VCPToolBox.tar.gz
- 安装 VCPToolBox 时直接复用缓存，不重新下载

**DL_runtimes 缓存机制**：
- PortableGit、Node.js、Python、new-api.exe 首次下载后缓存到 DL_runtimes
- 后续安装从缓存拷贝，不重复下载
- 安装目录被清除后，缓存仍然存在

**Phase2 缓存复用验证**（v17 无 VPN 实战）：
- git clone 所有镜像站失败 → 切 Tarball 兜底
- 直接使用 Phase2 测试时缓存的 VCPToolBox.tar.gz（174.3MB）
- 零额外流量，部署成功

### 原则 5：基于原代码精修，不是推倒重来

**核心观点**：原代码精修时，代码复用和统一流程的核心逻辑仍然适用，但要基于原代码改进，不要为了"统一"而引入大量新代码，破坏已有稳定逻辑。

**教训**：
- vcp-installer-12 重构时，ASH 创建了 package.rs / component_ops.rs / runtime/mod.rs 统一抽象，看似优雅，但引入了路径处理问题
- npm_ops.rs 中的多步骤 allow-scripts 方案完全没有改动，说明原代码的逻辑是正确的
- 原代码的测试文档中已有大量分析和方案对比，应该优先参考
- v18.10 tarball git 分支修复只需改 `git_init_from_remote` 两处（`git init -b main` + `set-upstream`），不需要重构整个 git 流程

### 原则 6：参考旧代码对比定位疑难 bug

**核心观点**（CARP 经验）：调试疑难 bug 时，主动读反复测试且能稳定运行的旧版/备份代码对比找差异，而不是只在脑子里空想机制。

**典型例证**：
- npm 相对路径 bug（运行调试03）：bak（稳定版）相同写法但真实 GUI 部署时 install_path 始终是绝对路径故未暴露。对比 bak 和 source-new 的路径处理，定位到 `run_installation()` 入口直接用原始参数是根因。
- 第六页恢复：TUI 改动后显示异常，从 source-new-bak 完整复制回原版 + diff 确认，快速恢复。

### 原则 7：阻塞操作必须走 spawn_blocking

**核心观点**：tokio async worker 线程上做长时间阻塞 + blocking_send，channel 满需真正 block 时触发 panic=abort（0xC0000409）。所有子进程调用、长时间 IO 必须走 `spawn_blocking`。

**教训**：
- electron-rebuild 融入第 09 步时用 `run_sync_step`（在 async worker 线程直接调 job()），electron-rebuild 内部长时间阻塞 + blocking_send，channel 满需真正 block 时 tokio 检测到"async 上下文 block" → panic → 0xC0000409 fail-fast 闪退
- 改用 `run_blocking_step_with_log`（走 `spawn_blocking`）后解决
- 这个坑很隐蔽：第一条日志能写入（channel 有空闲容量时 blocking_send 不阻塞），等需要真 block 时才触发

---

## 二、测试方法论

### 2.1 分阶段、由粗到细的测试策略

**思路**：先快速过滤大量候选，再对少数候选做完整验证。

**适用场景**：
- 镜像站筛选（30+ 候选 → 3-4 个可用）
- 安装包版本选择（Python 3.10~3.15 → 3.14.7 稳定版）
- npm 原生模块 ABI 验证（全模块扫描 → 逐个检查 .forge-meta 版本）

**不这样做的后果**：
- 镜像站：每个站点都完整下载测试，流量爆炸
- Python 版本：直接安装第一个匹配的版本（3.10），mcpo 依赖失败

### 2.2 用真实负载验证，不用代理指标

**思路**：用实际使用的文件做测试，不要用轻量级请求做代理。

**适用场景**：
- 镜像站测试：用 VCPToolBox.tar.gz（~175MB），不用 NewAPI Release（~20MB）
- 网络连通性：用完整 git clone，不用 curl HEAD
- Node.js 下载速度：用真实 200MB 文件测试 npmmirror CDN 效果，不用小文件

**教训**：
- HEAD 测速第一的 gh.meali.top，git clone 60 秒仅 11MB
- 小文件测试通过的站点，大文件下载可能直接失败
- 拔线测试用"始终断网未恢复"（比"拔线再插回"更严苛），真实验证看门狗 + 兜底链路

### 2.3 日志是排查问题的第一手资料

**思路**：对比成功日志和失败日志的差异，比分析代码更快定位问题。

**典型例证**：
- npm install 路径问题：成功日志 `D:\Desktop\vcp-installer-test\VCP_AIOS\VCPToolBox`（绝对），失败日志 `VCP_AIOS_test\VCPToolBox`（相对）
- TUI 全量日志重复：对比 headless 正常和 TUI 重复，定位到双写问题
- 0xC0000409 闪退：09_scripts.log 只有 4 行 + 无 [END] 标记 → 进程级崩溃，WER 证据确认 STATUS_STACK_BUFFER_OVERRUN
- 空仓库 bug：读 07_backupdev.log 定位到 git fetch 3 次全 429 → 有 origin 但无 commit 的空仓库

### 2.4 TUI 交互效果必须人工验证

**思路**：TUI 界面是交互式终端应用，管道方式发键序列不可靠（非 TTY 下行为异常），自动化测试无法准确模拟用户操作。

**典型例证**：
- --ui-preview 预览模式：用管道发 ESC 键序列测试翻页，行为异常，最终由 CARP 手动双击 show-tui-pages.bat 验证
- 第七页配置向导：真实安装流程 Enter 进入第七页，由 CARP 手动验证排版和内容
- **原则**：ASH 负责编译+部署，CARP 负责 TUI 交互验证，双方分工

### 2.5 拔线测试方法论（最严苛断网验证）

**思路**：拔网线 ≠ VPN 关闭。拔线后已建立的 TCP 连接留在 ESTABLISHED，OS 静默重传 15+ 分钟，不产生错误码 → 重试全失效。必须验证看门狗 + 兜底链路能处理这种场景。

**测试条件**：
- 中途拔网线，之后**始终断网未恢复**（比"拔线再插回"更严苛）
- Git Clone 模式 + 完整组件

**验证要点**：
- npm 挂死被杀：每次 ~90 秒内 kill 后重试
- git 镜像站轮询：3 站 × 3 次全失败 → 自动切 Tarball 兜底
- git 通道记忆：后续组件直接跳过 git（省 ~15 分钟）
- Tarball 兜底：从 DL_runtimes 缓存部署成功
- 进程残留：无孤儿进程（taskkill /T /F 有效）
- 断网不挂死：全程零卡死

**v18.1 结果**：20 分 10 秒跑完 9 阶段，无任何一处卡死。看门狗 + Tarball 兜底链路基本生效。

---

## 三、架构设计经验

### 3.1 日志系统设计：分段实时写 + 安装结束后合并全量

**思路**：单文件日志条目太多不便定位，分段日志有缺失风险，全量日志有重复问题。最终方案：

- 每个阶段一个日志文件（01_prepare.log → 09_scripts.log）
- 安装过程中只写分段日志，不写全量日志
- 安装结束后，合并所有分段日志为 00_full_log.txt

**解决了什么问题**：
- TUI/headless 全量日志内容不一致 → 统一从分段日志合并
- 全量日志内容重复（双写）→ 消除双写
- 01_prepare.log 缺失 → 阶段初始化时机前移

**关键设计**：
- StageGuard：RAII 管理各阶段日志（enter 写 [START]/[END]，enter_quiet 只设 stage 不写标记）
- write_prepare_log：TUI/Headless 统一调用，内容完全一致

### 3.2 缓存系统设计：DL_runtimes 独立于安装目录

**思路**：下载缓存（DL_runtimes）和安装目录（VCP_AIOS）分开管理。

- DL_runtimes：永久缓存，不随安装目录清除
- VCP_AIOS：每次安装的目标目录，可被清除重建
- 首次安装从 DL_runtimes 拷贝运行时和组件文件

**解决了什么问题**：
- 重复下载同一个文件
- 安装目录被清除后，需要重新下载所有运行时

**演进**：
- CacheManager（cache.rs）统一缓存检查，被 archive_ops/component_ops/runtime/* 全部接入
- INI `[runtime_versions]` 版本校验：文件存在 ≠ 版本正确，必须校验版本才用缓存

### 3.3 备用列表 + 动态可用列表

**思路**：离线维护的备用列表（vcp-mirrors.ini [github]）是过去可用的参考，安装时的动态测试选出当前真正可用的站点（[preferred_github]）。

**解决了什么问题**：
- 镜像站寿命短，今天可用明天失效
- 离线列表无法反映当前网络环境

**实现**：
- Phase2 测试成功后，前 3 个最快站点写入 INI [preferred_github] 持久化
- 下次安装直接复用 preferred_github，无需重复测试
- 安装时仍会重新测试（save_preferred_github 动态覆盖），有过期风险但每次重装会更新

### 3.4 INI 统一版本校验

**思路**：DL_runtimes 缓存文件存在 ≠ 版本正确。INI 记录版本/commit，安装时校验。

**设计**：
- [runtime_versions]：PortableGit/Node/Python/NewAPI 的版本号
- [component_commits]：4 组件 tarball 的远程 HEAD commit hash（伴生 .commit 文件）

**关键 bug**：4 运行时各自 mirror_config.clone()，写 INI 时后写覆盖前写（INI 只剩 NewAPI）。修复为**写前合并**已有 [runtime_versions] 条目。

**教训**：多组件写同一个 INI section 时，必须读-改-写，不能直接覆盖。

### 3.5 stream_util 子进程输出标准

**思路**：子进程输出读取统一走 stream_util.rs，不手写管道处理。

**三机制**：
- 双线程并发读 + mpsc 回传：防 4KB 管道死锁丢输出（git 的 fatal 行最后写入）
- 字节级心跳：每读到非空块发心跳 → 防看门狗误杀正常下载的 git
- 90 秒活动看门狗：90 秒无任何活动 → taskkill /T /F 杀进程树 → 返回 false 触发重试

**看门狗策略（按工具区分）**：
- git：Always（全程几乎都在等网络，90 秒无字节基本断定挂死）
- npm：UntilMarker("added ")（见 added N packages 后解除，防误杀 npm rebuild 本地编译）
- pip：UntilMarker("Installing collected packages")（进入安装阶段后解除）

**适用**：git/npm/pip/electron-rebuild 等所有子进程调用统一走此模块。

### 3.6 electron-rebuild 原生模块自动重建

**思路**：VCPChat 是 Electron 应用，原生模块必须按 Electron ABI 重编译，否则前端静默失败。

**设计**：
- 扫描 node_modules 下含 binding.gyp 的模块，排除 electron-edge-js
- 用 `node cli.js -f -o <模块列表>` 精准重建
- 失败不阻断安装（仅警告 + 提示手动命令）

**教训**：
- electron-edge-js 是 .NET CoreCLR 嵌入模块，本用预编译二进制，electron-rebuild 误对其跑 node-gyp 会失败，必须跳过
- 用 `-o <模块名>` 精确指定，避免 `-w`/默认全量重建误伤特殊模块

### 3.7 安装路径源头绝对化

**思路**：install_path 必须在 run_installation() 入口源头绝对化，防止相对路径 bug 传播到整条链路。

**教训**：
- headless 传相对路径时，runtimes_dir/node_dir/npm bat 路径全相对
- bat 在 cwd=组件目录 下多解析一层 → "系统找不到指定的路径"
- 修复：mod.rs 最开头 `install_dir = to_command_abs_path(config.install_path.clone())`
- canonicalize 在 Windows 返回 `\\?\` 前缀，cmd/bat 不识别，必须剥离

**设计原则**：路径处理必须在源头统一，不能在各调用点分散处理。

---

## 四、工作流程

### 4.1 四步骤循环

```
分析讨论 → todo清单 → 动手编码 → 测试总结 → （回到分析讨论）
```

每一步都有明确产出：
- 分析讨论：确定问题根因和解决方案
- todo清单：明确任务拆解
- 动手编码：实际修改代码
- 测试总结：记录测试结果和经验

**实际执行**：
- 安装精修阶段（v10→v18.11）：每轮迭代按此顺序，报告编号递增
- 运行测试阶段（运行调试01-03）：先验证启动 → 发现问题（ABI/闪退/路径）→ 逐个修复 → headless 验证闭环

### 4.2 四目录职责

| 目录 | 职责 | 规则 |
|------|------|------|
| source-old | 只读原始代码 | 不做任何修改 |
| source-new | 修改后的代码 + 报告 | 所有改动在此进行 |
| test | 安装测试 + 日志 | 测试产物在此保存 |
| source-new-bak | 近期跑通的代码备份 | 用于回退 |

**实际使用**：
- 第六页恢复：从 source-new-bak 完整复制回原版
- npm 路径 bug 对比：bak 相同写法但 GUI 部署时 install_path 始终是绝对路径故未暴露

### 4.3 测试工作风格

**思路**：逐个步骤测试时，先记录所有问题不改代码，等全部测试完成后再统一修复。

**好处**：
- 避免修了一个问题又引入新问题
- 全面了解系统状态后再动手
- 修复方案可以统筹安排

**实际执行**：
- 运行调试03：发现空仓库 bug → 先 Plan B（多镜像轮换）+ Plan A（回滚 .git）设计 → 编译 → CARP 重装验证
- headless 测试：第一轮暴露 npm 路径 bug + pip 失败 → 第二轮 Plan A 修复后全部通过

### 4.4 方案讨论用 Plan A/B/C

**思路**：复杂问题给 CARP 多方案选择，不未经确认直接改代码。

**实际执行**：
- npm 相对路径 bug：Plan A（源头绝对化）→ CARP 确认 → 实施 → 验证
- 空仓库 bug：Plan B（fetch 多镜像轮换）+ Plan A（失败回滚 .git）→ CARP 指定先 B 后 A → 实施 → 验证

---

## 五、技术决策记录

### 5.1 为什么不用 --allow-scripts 而用多步骤 approve-scripts

| 方案 | 优点 | 缺点 |
|------|------|------|
| --allow-scripts | 一行参数，简单粗暴 | 不透明，所有脚本自动执行 |
| 多步骤 approve-scripts | 符合官方推荐，日志清晰，每步可追溯 | 代码稍复杂 |

**决策依据**：
- 符合 Node.js 官方推荐的安全审批流程
- 日志清晰，便于排查问题
- 已在 v11 验证通过，稳定性有保障

### 5.2 为什么镜像站测试用 VCPToolBox.tar.gz 而不是 Python standalone

| 测试文件 | 大小 | 优点 | 缺点 |
|----------|------|------|------|
| Python standalone | ~40MB | 下载快 | 不是实际安装文件 |
| VCPToolBox.tar.gz | ~175MB | 实际安装文件，测试与安装一体化 | 下载慢 |

**决策依据**：
- 用实际安装文件测试，结果直接反映安装时的真实体验
- 测试成功后缓存可直接用于安装，不浪费流量

### 5.3 为什么 MSVC Build Tools 改为必需组件

**原始决策（08-18）**：分析 VCPToolBox/VCPChat 等项目的 package.json，认为原生依赖都有预编译二进制，MSVC 仅在缺少预编译二进制时才需要，改为可选组件。

**修正决策（v18.11，08-24）**：核实安装日志发现 npm rebuild 实际走了 MSVC 编译路径（node_modules 里有 MSVC 工程文件），MSVC 是硬依赖。改为**必需组件**：
- UI 锁定不可取消
- 默认勾选
- 未检测到就强制安装
- 安装失败**中止整体安装**（不再静默继续）

**教训**：表面分析（看 package.json 有预编译二进制）≠ 实际行为（npm rebuild 可能走 MSVC 编译路径）。必须用实际日志验证。

### 5.4 为什么用 spawn_blocking 而不是直接在 async 线程调用

| 方案 | 优点 | 缺点 |
|------|------|------|
| 直接在 async worker 线程调 | 代码简单 | 长时间阻塞 + blocking_send 触发 panic=abort（0xC0000409） |
| spawn_blocking | 阻塞操作在独立线程池，blocking_send 合法 | 多一层抽象 |

**决策依据**：
- tokio 检测到"async 上下文 block"会 panic → panic=abort → 进程崩溃
- electron-rebuild 内部做长时间阻塞（spawn 子进程 + 等待数分钟）+ blocking_send
- 第一条日志能写入（channel 有空闲容量时不阻塞），等需要真 block 时才触发
- 所有子进程调用统一走 spawn_blocking

### 5.5 为什么 Node.js 下载走 npmmirror CDN 而不是 GitHub 镜像

| 方案 | 优点 | 缺点 |
|------|------|------|
| GitHub 镜像（apply_mirror） | 统一走 GitHub 生态 | Node.js 不在 GitHub，无法改写 URL |
| npmmirror CDN | 国内 CDN，速度满速（10-20x 提升） | 独立于 GitHub 镜像体系 |

**决策依据**：
- Node.js 是唯一完全硬编码 nodejs.org 直连的运行时，国内几十 KB/s（200MB 需 10-20 分钟）
- npmmirror.com/mirrors/node/ 完整覆盖 nodejs.org 版本目录，URL 格式一致
- 双源循环：npmmirror → nodejs.org（兜底）+ resume:true（断点续传）

---

## 六、ASH 的工作教训（核心）

1. **充分学习已有开发日志**：遇到问题先查 `md` 目录下的报告，很多经验已经有详细记录。stream_util.rs 的看门狗/心跳机制已解决管道死锁问题，electron-rebuild 子进程输出读取应直接复用。

2. **不轻信表面现象**：exit code:0 不代表真的成功，HEAD 测速不代表真的可用，npm install 成功不代表脚本执行了，tarball 解压成功不代表 .git 仓库可用，前端窗口出来了不代表 ABI 匹配。

3. **多步骤组合处理复杂问题**：单步骤解决复杂问题往往会失败，需要多步骤组合处理。三层韧性链路（重试/换站/兜底）、npm allow-scripts 四阶段、镜像筛选三阶段都是多步骤组合的典范。

4. **测试与生产一体化**：测试流程和结果应直接服务于生产环境。Phase2 测试文件直接用于安装，不产生额外流量，测试结果直接服务生产。

5. **基于原代码精修**：不要为了"统一"而推倒重来，原代码中有很多已经验证的正确逻辑。v18.10 git 分支修复只需改两处，不需要重构整个 git 流程。

6. **日志是排查问题的第一手资料**：对比成功/失败日志的差异，比分析代码更快定位问题。09_scripts.log 只有 4 行 + 无 [END] → 进程级崩溃，WER 证据确认 0xC0000409。

7. **参考旧代码对比定位疑难 bug**（CARP 经验）：调试疑难 bug 时，主动读反复测试且能稳定运行的旧版/备份代码对比找差异。npm 路径 bug 对比 bak 定位到 install_path 绝对化是根因。

8. **阻塞操作必须走 spawn_blocking**：tokio async worker 线程上做长时间阻塞 + blocking_send 会触发 0xC0000409 闪退。electron-rebuild 融入第 09 步的教训。

9. **路径处理必须在源头统一**：install_path 在 run_installation() 入口源头绝对化，防止相对路径 bug 传播到整条链路。canonicalize 后剥离 `\\?\` 前缀。

10. **TUI 交互效果必须人工验证**：管道方式发键序列不可靠（非 TTY 下行为异常），TUI 界面效果必须由 CARP 手动验证，ASH 负责编译+部署。

11. **拔线测试是最严苛的断网验证**：拔线 ≠ VPN 关闭，TCP 静默重传不产生错误码，必须验证看门狗 + 兜底链路能处理这种场景。

12. **关键流程必须同步输出到 TUI 和日志**（CARP 原则）：校验、下载、状态变化等关键流程必须同步输出到 TUI 和日志文件，用户会主动检查日志来验证行为是否正确。

---

*文档由 Hermes Agent (ASH) 根据 VCP Installer 安装调试报告 1-25、运行调试报告 01-03、交接工作文档、专项经验总结提炼编写，最后更新：2026-08-29*
*安装精修收官 + 运行测试达标，VCP Installer 进入稳定维护阶段。*
