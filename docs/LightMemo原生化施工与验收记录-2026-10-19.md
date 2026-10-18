# LightMemo 原生化施工与隔离验收记录

日期：2026-10-19。状态：源码与隔离 Windows release 已实现并回归，未部署服务或验证真实生产语料。

## 已实现

- [全局 Chunk 表](../rust-vexus-lite/src/global_chunks.rs)：复用 TDB SM 编码，过滤后无图量化扫描，候选从 SQL 读取原始 f32 计算余弦。不常驻全库 f32。
- [原生查询](../rust-vexus-lite/src/light_memo.rs)：日记本、署名、日期及排除规则前置；RiverMemo 在同一 SQL 读事务中收口。完整首行保留子串署名语义，不截断成 64 字节。
- [JS 控制面](../Plugin/LightMemo/nativeQuery.js)：保留冷库分流、查询向量化、常规 Rerank/Jev、AIMemo 和格式化；移除旧 JS SQLite 候选及余弦遍历。原生能力缺失明确报错，不回退裸查。
- 实验室比较 TDB 原件余弦排序、外部 Rerank、RiverMemo V3。共用一个过滤后的候选输入池；RiverMemo 内部仍可按自身预算选择子集。实验室默认 30、最多 100 个候选；常规候选默认 256。不是全库精确召回实验。
- 新增 SQL Chunk 向量、正文/归属、文件元数据版本及专用事实计数触发器，支持查询时元数据对称差与差量向量加载。
- 双槽全局派生资产，先文件同步发布，再由 Write Actor 背书；不请求新 embedding。
- 冷表单飞加载，闲时卸载、换库清空、关闭排空后释放。查询持有表锁，淘汰使用非阻塞检查，不能卸载正在使用的表。

## 闲时资源策略

配置见[模板](../config.env.example:513)。LightMemo 未配置时空闲 TTL 为 600000 毫秒；当前模板已调整为 900000 毫秒（15 分钟），配置项为 KNOWLEDGEBASE_LIGHTMEMO_IDLE_TTL_MS。

复用日记索引清扫器，默认间隔 600000 毫秒：未配置 TTL 时通常空闲 10～20 分钟释放，按当前模板则为 15～25 分钟；不是精确到期定时器。清扫器不保活进程。Rust 再检查最后使用时间，繁忙则跳过，查询完成刷新时间。

未落盘差量允许丢弃，下次从 SQL 补齐。卸载不强制读全库向量、不重新 embedding。内存诊断新增 LightMemo 驻留、条数、闲时与繁忙状态；不把 allocator 保留的 RSS 误称为索引仍驻留。

## 与原施工图的差异及限制

1. 全局文件采用独立 VCPGCH01 格式：元数据、版本、SM routing snapshot；外层 SQL 背书文件长度和 SHA-256，内层 routing 有 CRC。不是日记索引的 192 字节头格式，不含 f32 原件。
2. 日期与首行在查询差分同步时提取；摄取提交后不直接更新常驻表，下次查询在冻结读事务中补齐。事实代际不变时走快速路径，变化时扫描版本元数据。
3. 5% 脏比例触发 checkpoint，但当前在同一个原生后台查询任务尾部完成，尚非脱离查询延迟的独立后台 checkpoint。首次构建、同步、压实和落盘会影响首调延迟。
4. 全局表互斥锁贯穿原生查询，保证单飞和状态安全，但同一 Runtime 的 LightMemo 查询会串行；共享发布门禁期间摄取发布需等待。真实并发吞吐与尾延迟尚待验证。
5. BM25 当前仅为候选内子串 TF 的过渡词频证据，IDF 也来自候选池；没有独立全局词法召回，不等价于旧 jieba 全作用域 BM25。全局倒排仍未施工。
6. 完整首行与重复日记名当前使用字符串/HashMap，不是最终紧凑串池。实际内存、冷启动峰值和持久化临时副本开销未做真实 5 万条测量。
7. 资产损坏时拒绝加载并从 SQL 恢复；未增加损坏资产单独隔离归档。
8. 普通模式兼容 knn 参数，但它表示量化候选上的原件余弦排序，不再意味着全库暴力精确 KNN；全局无图扫描也不应命名为 QuIVer 图 ANN。

## 已执行验证

| 项目 | 结果 |
|---|---|
| 主库 Rust 单测 | 86 通过 |
| 检索子库 Rust 单测 | 77 通过，2 项既有归因诊断默认忽略 |
| 全目标编译检查 | 通过，无警告 |
| 隔离 release 构建 | 通过，未覆盖默认模块或加载器 |
| 八入口隔离验收 | 全部通过，含真实 LightMemo 原生 RiverMemo 联合查询 |
| JS 业务及生命周期回归 | 31 通过 |
| 过滤 | 署名超过 64 字节、同文件不同 Chunk 日期、负余弦、音乐与排除范围 |
| 全局生命周期 | 差量更新、删除、双槽恢复、损坏恢复、并发首调、TTL 卸载后恢复 |
| 原生驻留 | 未用不驻留、查询后驻留、未到 TTL 不释放、到期释放、换库清空、关闭释放 |

真实原生断言位于[Memo 兼容回归](../tests/nativeMemoManifestCompatibility.test.js:274)，清扫调度断言位于[闲时回归](../tests/lightMemoIdleLifecycle.test.js)。锁内淘汰跳过和关闭释放另有 Rust 单测。

八入口包含控制面桩测试，不能全部称为真实端到端质量实验。外部付费 Rerank/Jev/AIMemo 未调用真实服务。

## 产物和上线边界

隔离产物位于[Windows 模块](../rust-vexus-lite/target/lightmemo-validation/vexus-lite.win32-x64-msvc.node)，匹配声明位于[隔离声明](../rust-vexus-lite/target/lightmemo-validation/index.d.ts)。

按追加的上机验证要求，现已编译并替换本工作区默认 Windows x64 MSVC 模块，匹配声明同步更新，JS 加载器未修改。没有启动服务、迁移真实库或请求 embedding。部署必须使用匹配源码与新模块，能力包含 lightmemo.native-query.v1。原有 TDB 换芯真实生产验收项仍有效，不能以本轮隔离回归抵销。

正式产物：[Windows x64 MSVC 模块](../rust-vexus-lite/vexus-lite.win32-x64-msvc.node)；[匹配声明](../rust-vexus-lite/index.d.ts)。

SHA-256：5DF4E515CA9D5B77546B1F080DF1F0F31381746AA04B831FCBB386FC6915AEE3。

替换前模块、加载器、声明已封存并逐项核验，见[本地备份清单](../.vcp-native-archive/lightmemo-20261019-044911/manifest.json)。本地备份不提交 Git。正式模块八入口回归全部通过，默认加载器能力与新增诊断接口检查通过。其他平台模块未重编译。

待生产试验：真实语料 Recall@K、端到端排序、5 万条冷启动/RSS/P50/P99、摄取并发与长时间稳定性，以及外部精排/总结服务验证。操作前停服并备份 SQL、WAL/SHM、代码、模块与索引；不得只覆盖原生模块完成回退。