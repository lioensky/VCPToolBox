# Rust 统一数据库分支环境配置审计

## 范围

仅审计热知识库、TagMemo、Embedding 的重构相关配置。未读取服务器真实环境文件，不能断言服务器实际加载值。冷知识库和插件独立配置不在本次结论内。

## 1. 关闭启动全扫仍处理文件：已确认并修复

配置读取链路正常：
- [`KnowledgeBaseManager.js`](../KnowledgeBaseManager.js:94) 读取启动全扫环境变量。
- [`fileWatcher.js`](../modules/knowledgeBase/fileWatcher.js:257) 将其传入原生初始扫描选项。
- [`lib.rs`](../rust-vexus-lite/src/lib.rs:2063) 按该选项决定是否启动初始扫描。

问题在于 JS 启动后另外无条件请求对账，对账最终调用同一个全目录扫描实现。因此关闭初始扫描并未关闭第二条启动扫描路径。

修复：启动对账也受同一开关控制，真实 overflow 恢复仍独立启用。开关开启时仍保留原有初扫和数据库路径对账两条入口，本次未重构合并。回归测试覆盖关闭、开启与关闭后真实溢出恢复。

注意：关闭启动全扫不等于关闭实时监听、启动孤儿记录清理、数据库 schema 迁移、索引恢复或 Memo 必要 bootstrap。运行期真实溢出仍可触发恢复扫描。

## 2. 语言惩罚漏接已修复

LANG_PENALTY_UNKNOWN 与 LANG_PENALTY_CROSS_DOMAIN 统一支持 [0,1]，包括零值。有效程序配置/环境值优先，其次热调参，最后默认值；空白或非法环境值继承热调参。

## 3. 无消费者属性已清理

KNOWLEDGEBASE_DELETE_REBUILD_THRESHOLD、TAG_EXPAND_MAX_COUNT、KNOWLEDGEBASE_IDLE_SWEEP_LOG_TICK 对应的无效配置属性已删除。模板中的前两项也已移除。

## 4. 已无活跃生产消费者的旧参数

以下变量在活跃 JS/Rust 源码中没有消费者，不应继续依赖其调节行为：

- KNOWLEDGEBASE_EPA_BACKGROUND_RECOMPUTE
- EPA_JS_FALLBACK_MAX_TAGS
- EPA_RUST_SAMPLES_PER_ANCHOR
- EPA_RUST_ANCHOR_CANDIDATE_LIMIT
- RUST_LOG_SUMMARY_WHITELIST
- TAGMEMO_MATRIX_PROGRESS_INTERVAL_FILES
- TAGMEMO_IR_METHOD
- TAGMEMO_INTRINSIC_RESIDUAL_FORCE_RECOMPUTE
- TAGMEMO_IR_RECOMPUTE_ON_THRESHOLD
- TAGMEMO_IR_MAX_NEIGHBORS
- TAGMEMO_IR_MAX_BASIS
- TAGMEMO_IR_MIN_NEIGHBORS
- TAGMEMO_IR_POSITION_DECAY
- TAGMEMO_IR_SEMANTIC_GATE_ENABLED
- TAGMEMO_IR_SEMANTIC_PEAK
- TAGMEMO_IR_SEMANTIC_SIGMA
- TAGMEMO_IR_SEMANTIC_FLOOR
- TAGMEMO_IR_SEMANTIC_HARD_FLOOR
- TAGMEMO_IR_MIN_GAIN
- WhitelistEmbeddingModelList

统一几何的配置来源现在是热调参的 KnowledgeBaseManager.geometry；不存在该对象时控制面才回退到旧 intrinsicResidual 对象。旧环境参数不会自动转换成新的几何配置，部分算法也不能一对一映射。

证据：[`TagMemoEngine.js`](../TagMemoEngine.js:218)、[`rag_params.json`](../rag_params.json:223)。

旧双写租约参数也已退休：
- KNOWLEDGEBASE_RUST_WRITE_LEASE_GRACE_MS
- KNOWLEDGEBASE_RUST_WRITE_LEASE_COOLDOWN_MS
- KNOWLEDGEBASE_RUST_WRITE_LEASE_CHECKPOINT_BEFORE_GRANT
- KNOWLEDGEBASE_RUST_WRITE_LEASE_RETRY_MS
- KNOWLEDGEBASE_RUST_WRITE_LEASE_TTL_MS
- KNOWLEDGEBASE_RUST_WRITE_LEASE_MAX_WAIT_MS
- KNOWLEDGEBASE_RUST_WRITE_LEASE_PENDING_THRESHOLD

## 5. 仍有效，但语义或优先级需要注意

- KNOWLEDGEBASE_DERIVED_STARTUP_COOLDOWN_MS：仍读取，但有兼容 Memo 资产时回调不强制重训；没有兼容资产时 Manager 传入零延迟启动必要 bootstrap。不是禁止启动训练的开关。
- TAGMEMO_MATRIX_REBUILD_QUIET_MS：仍生效；当前累计新增 Tag 阈值固定为 50，模板中约 1% 的说明已过时。证据：[`TagMemoEngine.js`](../TagMemoEngine.js:312)。
- LANG_PENALTY_UNKNOWN：已统一为有效环境配置优先，未设置时继承热调参。
- KNOWLEDGEBASE_PERSIST_DEFAULT、KNOWLEDGEBASE_PERSIST_FOLDERS：仍有消费者；Chunk 落盘模式为 none 时优先禁止落盘。generational 不代表所有日记本自动启用持久化。
- KNOWLEDGEBASE_PERSIST_TAG_INDEX=false：兼容含义为 generational，不是关闭全局 Tag 落盘。
- IGNORE_FOLDERS、IGNORE_PREFIXES、IGNORE_SUFFIXES：确实传入 Rust，并由初扫、实时事件、对账共用过滤器。没有发现重构漏传。已修复为空字符串显式清空规则，未设置才使用默认值；支持中英文逗号。
- 许多数值参数采用逻辑或默认值，零会回退默认值。忙锁等待、忙锁重试和 mmap 使用不同的显式校验，支持零；不能把所有数值配置按同一规则理解。

证据：[`indexRepository.js`](../modules/knowledgeBase/indexRepository.js:172)、[`lib.rs`](../rust-vexus-lite/src/lib.rs:1451)。

## 6. 已核对有效的主要配置组

- 根目录、数据库目录、模型名、模型签名、向量维度。
- Embedding Token 上限、批条数、并发、备援模型、dimensions 开关、原文审计。
- 摄取批大小与窗口、删除批大小与窗口、迁移缓存 TTL。
- SQLite 忙锁等待/重试、Rust 只读池大小与 mmap。
- watcher 防抖、稳定采样间隔/次数；热调参监听另有自己的三项参数。
- Tag 黑名单、超级黑名单、每文件 Tag 上限。
- 索引保存延迟、持久化模式与基线差分阈值、空闲 TTL/扫描间隔。
- 原生 River 联合查询总开关、回退开关、候选数量和语义去重阈值。
- 语言门控总开关、未知语言惩罚、事件循环看门狗。
- 矩阵阈值重建静默时间。

Rust 无需自行读取这些环境变量：JS 控制面读取后通过原生接口传参是当前设计。应以实际调用链与消费者判断生效，而不是以 Rust 中是否出现环境变量名判断。

## 7. 验证

启动扫描相关回归测试 5 项全部通过。未连接服务器验证其真实环境值，未调用 Embedding，未修改运行数据库。退休参数已从模板清理，服务器真实配置未自动改写。\n## 8. RiverAGS 训练反馈与重复发布修复\n\n- 手动重复请求复用排队/运行中任务；Tag 一致性提交新事实仍保留必要的后续训练。\n- 相同原生资产签名、代际和驻留状态不再增加 V9 控制面代际或重复通知；失败的伴生发布仍可重试。\n- 新增主服务训练状态接口和独立管理服务代理，面板显示排队、几何计算、图构建、发布、完成和失败。\n- 面板运行中禁止重复提交，重新打开页面可恢复主进程内任务状态；主进程重启后任务历史不持久化。\n- 状态显示真实阶段，不伪造百分比。未做服务器现场或浏览器交互验证。\n\n## 9. 部署\n\n同步后端控制面、管理路由、独立管理服务和前端源码，并重新构建前端或整体同步本次构建产物。主服务与独立管理服务均需重启。此前旧库兼容迁移还需要部署同版本原生模块；不要仅同步 JS，也不要使用模板覆盖真实配置。训练界面修复不需要重建正文向量。\n