TagMemo 退休与 RiverMemo 单轨化施工图-莱恩-1791813031821
# TagMemo 退休与 RiverMemo 单轨化施工图

## 一、目标与不可变边界

### 最终检索结构

```text
上下文 / 查询文本 / 查询向量
                │
                ▼
       共享降噪与信号提取底座
   AGS 贪婪投影 / IR 残差金字塔 / Spike
                │
                ▼
        统一查询观测与原生资产
                │
                ▼
        RiverMemo 双尺度场 + Ω
                │
                ▼
             最终排序

独立纯 KNN 出口
   ├─ 内部候选检索
   ├─ 显式 KNN 请求与评测基线
   └─ Dream / Timeline 的故障回退
```

**本次退休对象是旧检索分支和 DTSC 读出，不是共享传播机制。** [@!共享传播底座与独立读出]

### 硬边界

- 保留 AGS、IR、Spike、EPA 及其有效配置、资产和更新机制。
- 保留统一 Rust MemoRuntime、资产代际、发布与关闭机制。
- RiverMemo 仍复用现有底座，不新增第二套查询场。
- 不强制重命名 `TagMemoEngine`、`TagMemoV10Engine` 或 `modules/tagmemoV10`。
- 不按 `tagmemo`、`v9` 等名字批量删除配置和数据库表。
- 不改变 TDB 冷知识库的独立检索体系。
- **明确区分“RiverMemo 内部的候选兼容路径”和“业务上的纯 KNN 故障回退”。**

---

## 二、KBM 检索接口收束

**涉及文件：**

- `KnowledgeBaseManager.js`
- `modules/knowledgeBase/searchService.js`

### 施工内容

1. **建立明确的纯 KNN 出口**
   - 单库与联合库均支持。
   - 只执行 ANN、必要的合并与 SQLite hydrate。
   - 不进行查询增强、DTSC 或 RiverMemo 重排。
   - 保留调用方需要的作用域、结果字段与 Top-K 契约。

2. **通用 `search / searchMany` 收束为 RiverMemo**
   - 单库与联合库最终使用 RiverMemo 读出。
   - 透传可用的查询正文、Core 锚点、作用域和查询配置。
   - 删除旧 TagMemo 专属执行分支及 `+` 后缀触发 DTSC 的行为。

3. **梳理原生联合查询的内部回退**
   - `executeNativeRiverQuery()` 的候选兼容路径必须调用纯候选出口。
   - 不能通过新 `search()` 再进入 RiverMemo，造成递归。
   - 候选兼容路径完成后仍使用 RiverMemo 读出，不算引擎降级。

4. **删除 DTSC 公共门面**
   - 删除 `rerankWithTagMemoAsync()`。
   - 删除 `rerankWithMemo('dtsc', …)` 分支及旧结果转换。
   - 清理旧同步势场排序入口，确认无调用后移除。

### 特别注意

**`applyTagBoostAsync()` 等历史名称下承载的共享感应能力，不能整块删掉。** 应先区分：

- 旧 TagMemo 调用与返回兼容层：可清理。
- RiverMemo 使用的统一感应、观测准备和信号提取：保留。

### 验收

- 单库、联合库检索作用域正确。
- 查询只执行一次共享感应与一次最终读出。
- 原生联合查询关闭或失败时，候选兼容路径无递归。
- 纯 KNN 出口不调用任何 Memo 重排。

---

## 三、AgentDream 与 VCPTimeLine

### AgentDream

**文件：** `Plugin/AgentDream/DreamWaveEngine.js`

将当前：

```text
RiverMemo → 失败后 ANN + TagMemo DTSC
```

改为：

```text
RiverMemo → 异常或能力不可用后纯 KNN
```

- 删除 `'0.6+'` 回退调用。
- 使用独立 KNN 出口。
- 保留文件级去重、梦境后续聚合与权限范围。
- 日志明确标记实际引擎及回退原因。

### VCPTimeLine

**文件：**

- `Plugin/VCPTimeLine/VCPTimeLine.js`
- RAGDiary 的 ContextBridge 实现

- 删除 `tagMemo: true`、`geodesicRerank: true`。
- 桥接层支持明确的 RiverMemo → KNN 故障回退。
- 保留月度文件聚合、阈值筛选和全文展开行为。

### 回退语义

**RiverMemo 正常返回空结果，不触发 KNN 回退。** 只有异常或能力不可用才回退。

### 验收

- RiverMemo 成功时不执行 KNN 第二次召回。
- 异常时执行纯 KNN，不触发共享增强或 DTSC。
- 正常空召回保持为空。
- 日志及展示不会把 KNN 标成 RiverMemo。

---

## 四、RAGDiary 单轨化

**主要涉及：**

- `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`
- `Plugin/RAGDiaryPlugin/AIMemoHandler.js`

### 施工内容

1. **移除旧占位符**
   - 删除 `::TagMemo`、`::TagMemo+` 及显式权重变体的识别和执行。
   - 同步清理缓存键、日志、广播字段中的旧引擎分支。
   - 旧语法不静默映射为 RiverMemo；迁移现有模板与说明。

2. **AIMemo+ 初筛使用 RiverMemo**
   - 无外部候选源时，自主初筛走 RiverMemo。
   - 已有 `sourceFiles` 时，继续消费后缀管线产生的候选。
   - 不为 AIMemo+ 重复感应、重复召回。
   - 保留现有候选规模、截断、去重及 LLM 总结流程。

3. **Associate 去掉旧 TagMemo 路径**
   - 二次联想的结构检索收束为 RiverMemo。
   - 保留跨种子共现判定、排除原结果和最终合并规则。

4. **ContextBridge 清理**
   - 移除 TagMemo 增强与 DTSC 回退参数。
   - 显式区分 RiverMemo 检索和纯 KNN。
   - Timeline 的回退策略由明确契约表达，不再堆叠引擎布尔开关。

5. **保留动态参数的共享分析**
   - `getEPAAnalysis()` 等仍有效的能力保留。
   - 不因为其代理对象名为 TagMemoEngine 就移除。

### 验收

- Time、Group、BM25、Rerank、Expand、Truncate 等组合不被破坏。
- 时间/BM25 已构造的候选不会被错误替换成无约束全库召回。
- AIMemo+ 两种候选来源均只执行必要的一次检索。
- 元思维的纯候选搜索调用需显式确认用途，不能随通用 `search()` 改动而意外增加重排。

---

## 五、LightMemo 单轨化

**涉及文件：**

- `Plugin/LightMemo/LightMemo.js`
- `Plugin/LightMemo/plugin-manifest.json`

### 施工内容

- 删除 `tagmemo`、`tagmemo_v9`、`v9` 等引擎模式。
- 保留 RiverMemo 与显式 KNN 模式。
- 删除 `tag_boost` 的 `+` 后缀触发旧势场读出的行为。
- A/B 移除 TagMemo V9 轨：
  - 保留 KNN；
  - 保留 RiverMemo；
  - 保留需要的外部 Rerank / JEV 比较。
- 清理旧轨的资产快照、增强、重排、重合率和结果文案。
- A/B 命令名称与别名同步收束，避免继续宣传已退休能力。
- TDB 冷知识库分流不变。

### 验收

- 默认检索走 RiverMemo。
- 显式 KNN 保持纯 KNN。
- 已退休模式返回明确错误，不偷偷换引擎。
- A/B 不再要求 V9 快照或 DTSC ABI 存在。

---

## 六、底座与资源清理

### 必须移除

**Rust：**

- `rust-vexus-lite/src/memo_dtsc.rs`
- `lib.rs` 的 `mod memo_dtsc` 与 `rerank_memo_dtsc` 导出
- `index.d.ts` 的 `rerankMemoDtsc` 声明

**JS：**

- `_resolveUnifiedMemoRuntime()` 对 DTSC ABI 的强制检查。
- DTSC 参数组装、调用、诊断与结果转换。
- 确认仅服务旧 TagMemo 路径的缓存、对象及任务。

### 明确保留

- 统一资产构建与发布。
- AGS / IR / Spike / EPA 共享处理。
- 新 Tag 摄取后的资产更新调度。
- 模型签名、资产代际与数据库一致性机制。
- 热参数更新、数据库重绑和关闭等待。
- RiverMemo 当前仍依赖的控制面。

### 资源清理原则

**按实际读写与持有关系清理，不按历史名称清理。**

当前共享图并不是 DTSC、RiverMemo 各持一份，因此不预设“删 DTSC 就能释放一整份图”。需要分别核实：

- 旧读出独占的常驻内存；
- 旧 JS/实验路径的对象与模块依赖；
- 仅旧路径使用的派生计算；
- 仍被共享构建器消费的持久化资产。

数据库旧表、来源字段与配置项，确认无有效依赖后再决定保留、迁移或删除。**本轮不以清空旧 schema 为完成条件。**

---

## 七、配套与最终验收

### 配套调整

- 管理面板移除 DTSC 专属调参，保留共享底座与 RiverMemo 参数。
- `/rag-active-full-training` 保留有效资产重建能力，修正文案及旧专属行为。
- 内存诊断不再把共享资产误计为两个引擎的独占资源。
- 更新插件清单、工具说明、模板、检查脚本及测试。

### 最终验收线

1. 生产入口中无 TagMemo 增强/DTSC 检索分支。
2. Rust 在不包含 DTSC 模块时成功编译。
3. RiverMemo 不依赖 DTSC ABI 存在。
4. 冷启动、首次查询、新 Tag 摄取、资产重建、热更新与关闭均正常。
5. Dream / Timeline 故障回退确实是纯 KNN。
6. 搜索作用域、时间过滤、联合索引和候选语义未被破坏。
7. 共享感应没有重复执行。
8. 清理前后记录实际内存与查询延迟，不凭文件大小宣称收益。

---

**施工顺序：先分离纯 KNN 出口 → 迁移调用方 → 移除 DTSC → 清理独占资源与配套。**

这份图的核心就一句话：

> **同一套查询场底座，保留 RiverMemo 读出；纯 KNN 留作明确的候选工具、基线与指定故障回退。**