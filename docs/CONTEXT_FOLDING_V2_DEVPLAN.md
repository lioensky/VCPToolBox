# 上下文语义折叠 V2 - 开发计划

**创建时间：** 2026-04-11
**状态：** 实现

---

## 1. 项目概述

在 V1 中，我们实现了基于最后一轮对话向量对静态插件/工具列表的自动折叠（`messageProcessor.js` 中的 `resolveDynamicFoldProtocol`）。

V2 的目标是**折叠正文中远距离、低相关性的 AI 输出**：
- 只折叠 `role: assistant` 的消息块
- 根据最后一轮 user+AI 的语义向量判断相关性
- 不相关的 assistant 块被替换为精简摘要 `[VCP上下文语义折叠-本层摘要:xxxx]`
- 摘要生成是**异步非阻塞**的，首次检测到需折叠时触发，下次 POST 生效

---

## 2. 架构决策

### 2.1 FoldingStore 归属：RAGDiaryPlugin 管理，通过 ContextBridge 暴露

**决策：FoldingStore.js 放在 `Plugin/RAGDiaryPlugin/` 目录，由 RAGDiaryPlugin 初始化和管理，通过 ContextBridge 向 ContextFoldingV2 插件暴露读写接口。**

理由：
1. **基础设施复用** — RAGDiaryPlugin 已经管理了 ContextVectorManager、CacheManager、embedding 缓存等向量基础设施，FoldingStore 的向量存取与这些系统天然耦合
2. **桥接模式已建立** — ContextBridge 是跨插件通信的标准通道，LightMemo 已经通过它获取向量能力
3. **初始化顺序保证** — RAGDiaryPlugin 在 preprocessor_order 中先于 ContextFoldingV2 执行，保证 store 在被消费前已就绪
4. **ContextFoldingV2 保持轻量** — 折叠插件只负责折叠逻辑和摘要生成，不持有存储责任
5. **共享维度一致性** — embedding 维度由 RAGDiaryPlugin 的向量化管线决定，store 自然继承

### 2.2 数据流架构

```
POST /v1/chat/completions
  │
  ├─ [1] RAGDiaryPlugin.processMessages()
  │     ├─ ContextVectorManager.updateContext()  ← 向量化历史消息
  │     ├─ FoldingStore 同步更新（写入新块的 hash+vector）
  │     └─ RAG 日记本检索 & 注入
  │
  └─ [2] ContextFoldingV2.processMessages()
        ├─ 通过 ContextBridge 获取 FoldingStore 引用
        ├─ 识别候选折叠块（深度 > minDepth 的 assistant 消息）
        ├─ 从 store 读取/计算向量，与上下文向量比较
        ├─ 相似度 < 动态阈值 → 检查摘要状态
        │     ├─ 摘要已就绪 → 替换内容
        │     └─ 摘要未就绪 → 异步触发生成（不阻塞）
        └─ 返回处理后的 messages
```

### 2.3 ContextBridge 扩展

在 RAGDiaryPlugin 的 `getContextBridge()` 中新增 **FoldingStore 接口**：

```javascript
// ContextBridge 新增接口
{
    // === 现有接口不变 ===
    getAggregatedVector, getHistoryAssistantVectors, ...

    // === 新增：FoldingStore 读写接口 ===
    foldingStore: Object.freeze({
        getEntry(contentHash),          // 读取条目
        upsertVector(contentHash, data), // 写入/更新向量
        upsertSummary(contentHash, summary, status), // 写入摘要
        markPending(contentHash),        // 标记为摘要生成中
        getStats(),                      // 获取统计信息
    })
}
```

---

## 3. 文件结构

```
Plugin/RAGDiaryPlugin/
├── FoldingStore.js          ← [新增] SQLite 迷你数据库，由 RAGDiaryPlugin 管理
├── RAGDiaryPlugin.js        ← [修改] 初始化 FoldingStore，扩展 ContextBridge
├── ContextVectorManager.js  ← [不变]
├── CacheManager.js          ← [不变]
└── ...

Plugin/ContextFoldingV2/
├── plugin-manifest.json     ← [新增] 插件清单
├── ContextFoldingV2.js      ← [新增] 折叠逻辑主文件
└── config.env               ← [新增] 插件配置

preprocessor_order.json      ← [修改] 添加 ContextFoldingV2 到末尾
Plugin.js                    ← [修改] 添加 ContextBridge 注入路径（已自动支持）
```

---

## 4. FoldingStore 数据库设计

### 4.1 Schema

```sql
CREATE TABLE IF NOT EXISTS folding_entries (
    content_hash    TEXT PRIMARY KEY,        -- SHA-256 of sanitized content
    text_preview    TEXT NOT NULL,           -- 前80字符预览，方便调试
    vector          BLOB,                    -- Float32Array 二进制存储
    summary         TEXT DEFAULT '',         -- 生成的摘要文本
    summary_status  TEXT DEFAULT 'none',     -- 'none' | 'pending' | 'ready' | 'failed'
    retry_count     INTEGER DEFAULT 0,       -- 摘要生成重试次数
    created_at      INTEGER NOT NULL,        -- 创建时间戳
    updated_at      INTEGER NOT NULL         -- 最后更新时间戳
);
```

### 4.2 容量与淘汰

- **最大容量**：200 条
- **淘汰策略**：超过上限时，按 `updated_at` 升序删除最旧的 20 条（10%）
- **差异更新**：`upsertVector` 和 `upsertSummary` 使用 `INSERT OR REPLACE`，最小化写入

### 4.3 向量存储

- 存储格式：`Float32Array → Buffer → BLOB`
- 读取格式：`BLOB → Buffer → Float32Array`（复制而非引用，避免对齐问题）

---

## 5. 折叠逻辑核心算法

### 5.1 深度计算

```
messages: [sys, user, AI_1, user, AI_2, user, AI_3, user, AI_4(最新)]
                          ↑depth=3   ↑depth=2   ↑depth=1   ↑depth=0(不折叠)

minDepth=3 → AI_1 开始可能被折叠
系统强制最低 minDepth=2 → AI_3, AI_4 始终不折叠
```

深度从最新的 assistant 块往回数，`depth=0` 是最新的 AI 输出。

### 5.2 动态阈值公式

借鉴 RAGDiaryPlugin 的 EPA 指标：

```
L = LogicDepth(contextVector)    // 逻辑深度 [0,1]
S = SemanticWidth(contextVector)  // 语义宽度 [0,1]

threshold = clamp(0.40 + 0.10 * L - 0.10 * S, 0.30, 0.50)
```

- L 高（逻辑聚焦）→ 阈值升高 → 更激进折叠无关内容
- S 高（语义宽泛）→ 阈值降低 → 保守保留更多上下文
- 实际场景中，L∈[0.3,0.7], S∈[0.5,0.8] → threshold ≈ 0.35~0.42

### 5.3 折叠判定

对每个候选 assistant 块：
1. 获取块向量（store 缓存 → ContextBridge 缓存 → embedding API）
2. 获取上下文向量（最新 user + AI 的加权平均）
3. `similarity = cosineSimilarity(blockVector, contextVector)`
4. `similarity < threshold` → 判定为低相关，进入折叠流程

### 5.4 异步摘要生成（指数退避）

```
触发条件：块被判定为低相关 且 summary_status ∈ ['none', 'failed']
退避公式：delay = 1000 * 3^retry_count (1s, 3s, 9s)
最大重试：3 次
```

摘要生成不阻塞当前 POST：
- 首次检测 → 标记 pending → `setImmediate()` 异步调用 LLM → 存入 store
- 下次 POST → 检查 status='ready' → 执行折叠替换

### 5.5 折叠替换格式

```
原始内容: "很长的一段AI回复，包含了各种讨论..."
替换为:   "[VCP上下文语义折叠-本层摘要:讨论了X和Y的关系，结论是Z]"
```

摘要目标：≤80 字符，精准概括核心信息。

### 5.6 摘要输出安全验证（灾难防护）

**核心原则：宁可不折叠，绝不用错误信息覆盖原文。**

摘要模型的回复必须通过**三级验证**才能被采纳：

**第一级：结构验证**
- 响应必须包含前缀 `[VCP上下文语义折叠-本层摘要:` 和后缀 `]`
- 使用正则 `/\[VCP上下文语义折叠-本层摘要:(.+?)\]/` 提取
- 不匹配 → 判定失败

**第二级：内容验证**
- 提取出的摘要内容长度 ≥ 2 字符（防止空摘要 `[VCP上下文语义折叠-本层摘要:]`）
- 提取出的摘要内容长度 ≤ 200 字符（防止模型输出冗长内容）
- 不包含 `error`、`无法`、`抱歉` 等拒绝关键词（防止模型拒答被当作摘要）
- 不匹配 → 判定失败

**第三级：写入验证**
- 只有通过前两级验证，才会将 `summary_status` 设为 `'ready'`
- 任何一级失败 → `summary_status = 'failed'`，`retry_count++`
- 失败的摘要**永远不会**被用来替换原文

**提示词设计**
```
系统提示词要求模型严格输出格式：
"请严格按以下格式输出，不要输出任何其他内容：
[VCP上下文语义折叠-本层摘要:你的摘要内容]
摘要要求：一句话概括核心内容，不超过80字。"
```

这确保了即使模型返回空内容、网络超时、格式错误、拒绝回答等异常情况，都不会导致原始上下文被破坏。

---

## 6. RAGDiaryPlugin 修改清单

### 6.1 新增 FoldingStore.js

独立模块，接收 db 路径和配置参数。

### 6.2 RAGDiaryPlugin.js 修改

1. **构造函数**：添加 `this.foldingStore = null;`
2. **`loadConfig()`**：初始化 FoldingStore（路径: `Plugin/RAGDiaryPlugin/folding_store.db`）
3. **`processMessages()`**：在 `contextVectorManager.updateContext()` 之后，同步将新的消息 hash+vector 写入 FoldingStore
4. **`getContextBridge()`**：扩展返回对象，新增 `foldingStore` 子接口

### 6.3 修改粒度评估

- `RAGDiaryPlugin.js`：约增加 50 行代码（store 初始化 + bridge 扩展 + processMessages 中同步写入）
- `FoldingStore.js`：全新文件，约 180 行

---

## 7. ContextFoldingV2 实现清单

### 7.1 plugin-manifest.json

- `pluginType`: `"messagePreprocessor"`
- `requiresContextBridge`: `true`
- `communication.protocol`: `"direct"`

### 7.2 config.env

```env
# 摘要生成模型（应为便宜快速的模型）
FOLDING_SUMMARY_MODEL=gemini-2.0-flash-lite

# 摘要提示词
FOLDING_SUMMARY_PROMPT=请用一句话（不超过80字）概括以下AI回复的核心内容，只输出摘要本身，不要任何前缀或解释：

# 最低折叠深度（从最新AI回复往上数，>=此值的才可能折叠）
FOLDING_MIN_DEPTH=3
```

### 7.3 ContextFoldingV2.js 核心流程

```
initialize(config, dependencies)
  ├─ 接收 contextBridge
  ├─ 加载 config.env
  └─ 验证 foldingStore 可用性

processMessages(messages, pluginConfig)
  ├─ 分离 system 和 body 消息
  ├─ 从 body 中识别所有 assistant 块，计算深度
  ├─ 过滤 depth < minDepth 的块（不可折叠）
  ├─ 获取上下文向量（lastUser + lastAI 加权平均）
  ├─ 计算动态阈值
  ├─ 对每个候选块：
  │     ├─ sanitize → hash → 查 store
  │     ├─ 获取/计算 block 向量
  │     ├─ 计算 similarity
  │     ├─ similarity < threshold？
  │     │     ├─ YES: 检查摘要状态
  │     │     │     ├─ 'ready' → 折叠替换 ✅
  │     │     │     ├─ 'none'/'failed' → 触发异步摘要生成
  │     │     │     └─ 'pending' → 跳过（等待中）
  │     │     └─ NO: 内容相关，保留原文
  │     └─ 更新 store 中的向量（如果是新的）
  ├─ 日志：输出折叠结果
  └─ 返回修改后的 messages
```

---

## 8. 日志规范

```
[ContextFoldingV2] ✅ 摘要生成成功: hash=abc12...（耗时 1.2s）
[ContextFoldingV2] 本次已折叠楼层: 3,5,7（阈值: 0.42）
[ContextFoldingV2] 触发异步摘要: 2 个块待生成
```

只输出关键事件，不输出每个块的详细相似度。

---

## 9. 边界条件与防护

| 场景 | 应对策略 |
|------|----------|
| ContextBridge 不可用 | 跳过折叠，直接返回原始 messages |
| FoldingStore 不可用 | 同上 |
| 向量化失败 | 跳过该块的折叠判定 |
| 摘要生成失败 | retry_count++，下次 POST 指数退避重试，最多 3 次 |
| 内容已被折叠 | 通过 `[VCP上下文语义折叠-` 前缀识别，跳过 |
| 消息内容变化 | hash 不匹配则视为新块，重新处理 |
| Store 超过 200 条 | LRU 淘汰最旧 20 条 |
| 并发摘要请求同一块 | 内存中维护 `pendingHashes` Set，防止重复触发 |
| minDepth 用户设置太小 | 强制最低为 2 |

---

## 10. 实施顺序

1. ✅ 创建 `Plugin/ContextFoldingV2/plugin-manifest.json`
2. 创建 `Plugin/RAGDiaryPlugin/FoldingStore.js`
3. 修改 `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`（初始化 store + 扩展 bridge + processMessages 同步写入）
4. 创建 `Plugin/ContextFoldingV2/config.env`
5. 创建 `Plugin/ContextFoldingV2/ContextFoldingV2.js`
6. 修改 `preprocessor_order.json`
7. 验证 `Plugin.js` 依赖注入链路

---

## 11. 风险评估

| 风险 | 影响 | 缓解 |
|------|------|------|
| RAGDiaryPlugin 加载变慢 | 低 - FoldingStore 是轻量 SQLite，初始化 <50ms | 已验证 better-sqlite3 是同步的 |
| 摘要质量差 | 中 - 折叠后丢失关键信息 | 使用优质便宜模型 + 精确提示词 |
| 向量维度不一致 | 高 - 如果 embedding 模型变更 | Store 检测维度变化时清空重建 |
| 折叠太激进 | 中 - 丢失重要上下文 | 动态阈值 + minDepth 保护 |