# P2-3 控制桥收束方案

## 当前职责与建议

| 现役入口 | 保留职责 | 建议命名 |
| --- | --- | --- |
| [TagMemoEngine.js](../TagMemoEngine.js) | 派生队列、防抖、原生 Pairwise/Residual/Artifact 构建和发布句柄 | MemoDerivedScheduler |
| [TagMemoV10Engine.js](../TagMemoV10Engine.js) | 配置默认值合并、不可变 Artifact 句柄、来源签名兼容校验 | MemoArtifactControl |
| [RiverMemoEngine.js](../RiverMemoEngine.js) | N-API 参数封装、原生路由、结果结构适配、显式观测接口 | RiverQueryBridge |

可以最终由一个 MemoControlBridge 聚合三个职责，但**不建议本轮合并成一个大类**。派生调度和查询生命周期不同；合并可能把任务关闭、Artifact 发布代际和查询回退一起改变，超出死代码清理边界。

## 建议后续步骤（本轮未实施）

1. 先在 KBM 内提供聚合控制面，内部复用现有三个实例，不改变插件契约。
2. 将配置默认值与 Artifact 元数据提取为独立纯函数，保持配置哈希、模型身份和来源签名不变。
3. 为派生构建与查询保留各自 admission/drain，先完成 P3 生命周期约束，再决定是否合并实例。
4. KBM、插件、管理路由及内存诊断的调用点全部迁移后，再删除旧名称。禁止修改区域中的消费者必须等独立重构，不在本轮兼容。
5. 用原生临时库验证冷启动恢复、发布、查询与关闭，再移除兼容接口。

## 本轮安全删除范围

- V10 中六个无人调用的私有辅助方法：旧查询、Agent、观测及 SourceField 归一化，旧数据库与 provenance 代际计算。生产统一查询由原生运行时完成。
- V10 无使用的加密导入及稳定哈希导入。
- TagMemo 中无人读取的旧能量场字段。
- River 中只写不读的原生缓存观测标记；真实资产状态仍以原生运行时诊断为准。

## 暂保留与待确认

- 共现矩阵、Pairwise、Residual 兼容字段：仍被 [memoryProfiler.js](../modules/knowledgeBase/memoryProfiler.js) 读取，一致性服务也有旧赋值，不能声称零引用。
- 退休方法中仍有 KBM 包装入口，不在本轮擅自改变公开接口；应在 P2-5 全量调用表审计后决定是否删除。
- V10 配置中的历史参数可能参与原生配置哈希与恢复契约，不应仅凭 JS 无计算逻辑删除。
- Artifact/DerivedManager 注入字段及同步退休方法仍需独立审计。本轮仅完成可证实无调用的子集，P2-3 整项仍保持未完成。