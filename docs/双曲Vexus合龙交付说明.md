# 双曲 Vexus 合龙交付说明

日期：2026-11-17。

## 1. 分支与施工范围

- 生产导向试验分支：experiment/warped-production-v5-20261117。
- 从当时的双曲试验分支创建；Git 本地分支描述已记录“生产导向试验分支”。
- 源码与生成产物改动限定在 [Rust 子项目](../rust-vexus-lite/)，另新增本文。
- 未改上层 JS、LightMemo、KBM 源码；未操作生产数据库。测试数据库均为临时合成夹具。
- [原施工图](双曲施工图.md)和[用户提供的 V5 施工图](双曲施工图V5终极版.md)未修改。
- 未执行提交、推送或取消暂存。工作期间已观察到暂存区变化，保持用户/环境的暂存状态。

## 2. 生产配置

配置定义见 [PipelineConfig](../rust-vexus-lite/src/memo_pipeline.rs:108)。

全局默认仍为余弦。只有显式指定双曲路由才会加载或构建双曲场。

最简双曲配置为：
[{"config":{"tagRoutingMode":"warped_ags"}}](../rust-vexus-lite/src/memo_pipeline.rs:108)。

显式生产配置为：
[{"config":{"tagRoutingMode":"warped_ags","warpedPreset":"locked_2","warpedRadiusStrategy":"epa_guided"}}](../rust-vexus-lite/src/memo_pipeline.rs:108)。

| 配置字段 | 可用值与默认值 |
| --- | --- |
| [tagRoutingMode](../rust-vexus-lite/src/memo_pipeline.rs:138) | cosine（全局默认）、warped_ags |
| [warpedPreset](../rust-vexus-lite/src/memo_pipeline.rs:139) | locked_2（双曲默认）、locked_0 |
| [warpedRadiusStrategy](../rust-vexus-lite/src/memo_pipeline.rs:140) | epa_guided / EpaGuided（默认）；layer_schedule / LayerSchedule |

[生产预设](../rust-vexus-lite/src/warped_tag_field.rs:25)统一为：软化系数 0.15、喉部 1.5、角尺度 2.0、节点半径 0.35–0.65、自适应罗盘开启。默认预设的均值减除系数为 0.7；另一个 AB 预设为 1.0。

默认导航策略：

- 规模预算：不超过 4096 节点为 1024/256，不超过 16384 节点为 1536/384，更大为 2048/512；分别表示访问与展开上限。
- 非对称导航、束分数复用、兼容精排变换和解析包络均开启。
- 全局 64 方向目录与最多 512 个跨壳目录并集，4 个内壳入口加 12 个方向种子，最多 16 种子。
- [rerank_limit](../rust-vexus-lite/src/warped_tag_field.rs:251)固定为 64；金字塔单层结果数限制为 1–64。
- EPA 分析不可用但场仍可用时，半径计算沿用层级调度保底。

旧实验开关仍保留供受控诊断使用，但不建议作为生产接口使用。若主动关闭跨壳目录，应同时选择兼容的种子策略，避免非法组合。

## 3. 资产生命周期与增量窗口

[WarpedTagField::current()](../rust-vexus-lite/src/warped_tag_field.rs:203)只检查同一数据库身份、同一原生资产签名，以及[原生资产合法性校验](../rust-vexus-lite/src/rivermemo_topology_v3.rs:1116)。

沿用原生资产的现役规则：就绪状态、算法/格式匹配、完整依赖集合，以及当前依赖版本不得落后于发布基线。没有新增独立的训练阈值。

因此，在现有 1% 累积变动窗口内：

- 数据库代际和 Tag 事实计数前移不会单独使双曲场失效。
- 热请求不再额外校验 EPA 缓存摘要相等。
- 构建使用同模型最新就绪几何，不要求其事实计数等于实时计数；EPA 均值与所选几何签名必须一致。
- 增量任务清空内存后，下一次合法双曲请求会自动恢复快照。
- 精排遇到已删除 Tag 时仅跳过单个候选；损坏、非有限或零向量仍显式拒绝。
- 新原生资产发布后，新请求加载绑定新签名的场；已经持有旧场引用的请求保持其快照，不覆盖新活动资产。

现有训练调度及 1% 记账不变；本轮没有添加后台重训调度器。

## 4. 快照与冷启动

格式见[场级快照实现](../rust-vexus-lite/src/warped_field_snapshot.rs:8)及[索引编解码](../rust-vexus-lite/crates/vcp-tdb-index/src/index/quiver/hyperbolic/warped_snapshot.rs)。

格式包含：VCPWF001 魔数、两个 64 位小端长度、身份头、节点分位数组、索引载荷及整包 CRC32。索引载荷保存几何配置、位平面、极坐标元数据、均值轴、插值表、CSR、入口和方向目录，不保存原始向量矩阵。

加载校验包括：

- 魔数、长度上限、整包 CRC、维度、签名、预设和完整生产配置；
- 节点 ID、分位数与计数关系、有限浮点数、位平面尾位和强位计数；
- CSR 边界、度数、目标范围、目录范围及图连通性。

[旁路命名](../rust-vexus-lite/src/warped_field_snapshot.rs:27)以数据库文件名为前缀、资产签名的 SHA-256 为身份，并带预设后缀，扩展名为 .vcpwf，存放于数据库同目录。

原子发布复用[CheckpointStaging](../rust-vexus-lite/src/lib.rs:110)、文件同步和原子替换。快照是可重建派生文件，不修改数据库事实。

[冷加载流程](../rust-vexus-lite/src/warped_field_snapshot.rs:112)：先内存命中，再快照恢复，最后在当前读事务中流式构建并持久化。每个索引实例使用独立冷加载锁；同进程的临时文件发布也做串行保护。

仅基础就绪几何或 EPA 缓存尚未初始化时平滑回退余弦；坏向量、非法资产、数据库或持久化错误不会静默伪装成正常回退。

[原生资产清理任务](../rust-vexus-lite/src/knowledge_runtime.rs:2244)会回收不再对应就绪原生资产的受控快照，并清理受控命名的遗留临时文件。不匹配命名规则的邻接文件不会删除。

部署进程需要数据库同目录的旁路文件写权限。本轮单飞与发布锁是进程内机制，未宣称提供跨进程共享目录的分布式构建锁。

## 5. 预热接口

新增 [warmupWarpedTagField()](../rust-vexus-lite/src/warped_tag_field.rs:526)，不改变既有方法签名。

AB 脚本调用方式：
[await index.warmupWarpedTagField(dbPath, artifactSig, "locked_2")](../rust-vexus-lite/src/warped_tag_field.rs:526)。

省略第三个参数使用默认生产预设；传 locked_0 切换另一个 AB 预设。前两个参数分别为已由原生存储运行时注册的数据库路径和合法就绪资产签名。不要将预热接口当成数据库初始化或修复接口。

返回值为 JSON 文本，脚本解析后包含：

| 字段 | 含义 |
| --- | --- |
| [artifactSig / preset](../rust-vexus-lite/src/warped_tag_field.rs:512) | 实际绑定的原生资产及预设 |
| [source](../rust-vexus-lite/src/warped_tag_field.rs:512) | memory、snapshot 或 built |
| [nodes / hotBytes](../rust-vexus-lite/src/warped_tag_field.rs:513) | 节点数、受管载荷容量估算，不等于 RSS |
| [elapsedMs / buildMs](../rust-vexus-lite/src/warped_tag_field.rs:514) | 本次预热总耗时、驻留场记录的构建或恢复耗时 |

建议在服务器 AB 实验前显式预热两个预设，避免把首次构建成本混入热检索延迟。

## 6. 状态与查询诊断

同步调用 [index.warpedRuntimeStats()](../rust-vexus-lite/src/warped_tag_field.rs:533)，返回 JSON 文本，含驻留场列表与当前双曲代际。每个场包含签名、预设、节点数、热载荷容量和耗时记录。

[runMemoPipeline()](../rust-vexus-lite/src/lib.rs:518)的调用参数及返回载体保持不变。读取返回载体中的元数据 JSON，查看[diagnostics.tagRouting](../rust-vexus-lite/src/memo_pipeline.rs:2505)：

| 字段 | 含义 |
| --- | --- |
| [used / fallback](../rust-vexus-lite/src/memo_pipeline.rs:2506) | 实际采用的路由与是否发生初始化回退 |
| [source](../rust-vexus-lite/src/memo_pipeline.rs:2509) | 内存、快照或新构建；初始化回退时为空 |
| [fallbackReason](../rust-vexus-lite/src/memo_pipeline.rs:2510) | 初始化回退的具体原因；正常双曲命中时为空 |
| [preset / radiusStrategy](../rust-vexus-lite/src/memo_pipeline.rs:2508) | 实际请求的预设与半径策略 |
| [shellDirectory / reuseBeam / seedPolicy](../rust-vexus-lite/src/memo_pipeline.rs:2513) | 导航控制，用于核对实验条件 |
| [attempts](../rust-vexus-lite/src/memo_pipeline.rs:2516) | 各层半径、候选 ID、访问/展开、SQL/缓存读取及包络跳过等统计 |

顶层诊断中的[tagRoutingCheckMs](../rust-vexus-lite/src/memo_pipeline.rs:2303)包含本次内存检查或冷恢复/构建时间，不是仅计算一个布尔条件的耗时。默认余弦请求不增加双曲诊断对象。

## 7. 验证证据

所有测试与构建均设置[禁用 AVX-512 的环境开关](../rust-vexus-lite/crates/vcp-tdb-index/src/index/bq.rs:13)。

| 范围 | 最终结果 |
| --- | --- |
| [索引子项目](../rust-vexus-lite/crates/vcp-tdb-index/Cargo.toml)全量 Release 测试 | 129 通过、0 失败、3 个既有诊断/基准忽略，零编译警告 |
| [原生主项目](../rust-vexus-lite/Cargo.toml)全量 Release 测试 | 245 通过、0 失败、4 个既有私有离线实验忽略，零编译警告 |
| [十万对浮点护栏](../rust-vexus-lite/crates/vcp-tdb-index/src/index/quiver/hyperbolic/warped_geometry.rs:384) | 覆盖 65/384/768/1536/3072 维、近同向、近对跖及极端合法参数，0 次假阴性 |
| [真实存储生命周期](../rust-vexus-lite/src/warped_lifecycle_tests.rs:27) | 发布、低于阈值的触发器写入/删除、增量任务、并发查询、存储关闭重开、新代发布及旧快照回收通过 |
| 快照损坏与边界测试 | CRC、截断、签名/预设/维度、CSR、元数据、尾位、目录及临时文件回收通过 |
| Node 原生加载冒烟 | 新旧方法导出、空状态统计、非法预设拒绝通过 |

私有离线实验仍隔离在测试条件编译下，本轮没有运行私有工作库重建、抽取新盲测集或重新选参。

最终主项目测试日志保存在[构建目录日志](../rust-vexus-lite/target/warped-v5-release-tests.log)，属于本地构建证据，不是生产资产。

## 8. 性能测量及边界

本机 Windows Release、合成夹具的测量：

- 40,452,064 字节、48,000 节点、3072 维索引载荷：内存解码中位数约 23.0 ms。
- 40,644,347 字节完整场级包：隔离运行时，文件读取、CRC、结构校验和资产验证总计中位数约 25.8 ms。
- 同一完整场级探针在全量并行测试竞争下约 51.6 ms，说明 50 ms 不是高争用下的硬实时上界。
- 真实增量夹具的热态路由检查：128 次，中位数 0.0090 ms，P95 0.0126 ms。

大快照探针使用合成连通环及合法重复编码，仅验证恢复成本与工程边界，不代表真实检索质量。文件读取测量使用操作系统已有页缓存，不代表断电后物理冷盘性能。上述场级恢复耗时不包含首次原生图解压与完整查询后续计算。

真实数据的首次无快照构建成本、服务器冷盘延迟和检索质量仍须在服务器 AB 实验室验收，不以这些合成测量替代。

## 9. 原生构建产物与平台限制

最终新建/更新的原生模块为 [vexus-lite.win32-x64-msvc.node](../rust-vexus-lite/vexus-lite.win32-x64-msvc.node)。

- 平台：Windows x64 MSVC。
- 大小：15,626,752 字节。
- SHA-256：885559d62d456777f457055c52db2e745039264e09bcf9d925ddd96fd5bbde9a。
- [生成的类型声明](../rust-vexus-lite/index.d.ts:381)已新增两个辅助接口，旧声明未改变。
- 构建入口为[生产构建脚本](../rust-vexus-lite/package.json:7)。

目录中的其他平台原生模块是既有文件，**本轮没有重建 Linux 或 macOS 模块，不能将其当作本轮新功能的交付二进制**。Linux 服务器应在对应目标环境用同一份源码执行生产构建，并核对新接口实际存在后再做 AB。

运行测试时设置的禁用 AVX-512 开关不等于永久编译禁用该指令集；若服务器 AB 需要相同条件，也应设置同一运行时环境开关。

## 10. 服务器验收顺序

1. 在目标平台构建并加载本轮原生模块，确认两个辅助接口存在。
2. 使用现有原生存储初始化流程注册测试数据库，取得合法就绪资产签名。
3. 显式预热生产预设及另一个 AB 预设，记录来源和内存统计。
4. 以默认余弦作为对照，以显式双曲配置作为实验组。
5. 在日常写入和个别删除后确认仍命中双曲路由；重启后确认从快照恢复。
6. 达到既有训练阈值后，核对新签名切换及旧旁路资产清理。
7. 用用户自有服务器测试集评估真实检索质量，不将本轮工程测试结果当作质量结论。