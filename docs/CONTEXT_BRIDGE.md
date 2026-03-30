# ContextBridge — 上下文向量引力场公开接口

**版本：** 1.0  
**创建时间：** 2026-03-30  
**所属模块：** [`Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`](../Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js)  
**注入入口：** [`Plugin.js`](../Plugin.js) `loadPlugins()` 依赖注入循环

---

## 概述

ContextBridge 是 RAGDiaryPlugin 暴露给其他插件的**只读查询接口**，允许任意 VCP 插件访问 RAG 系统构建的上下文向量引力场，包括：

- 会话历史的衰减聚合向量
- 语义分段后的主题向量
- EPA 指标计算（逻辑深度 L、语义宽度 S）
- 带缓存的向量化工具
- 文本净化器和向量数学工具

**设计原则：**
1. **只读** — `Object.freeze()` 冻结，外部无法修改内部状态
2. **懒计算** — 聚合向量按需计算，不预先生成
3. **零拷贝** — 返回 `Float32Array` 视图，不复制数据
4. **安全** — 所有方法都有空值保护

---

## 快速接入指南

### Step 1：在 plugin-manifest.json 中声明依赖

```json
{
    "name": "MyPlugin",
    "pluginType": "hybridservice",
    "requiresContextBridge": true,
    "entryPoint": {
        "script": "MyPlugin.js"
    },
    "communication": {
        "protocol": "direct"
    }
}
```

关键字段：`"requiresContextBridge": true`

### Step 2：在 initialize 中接收 bridge

```javascript
class MyPlugin {
    constructor() {
        this.contextBridge = null;
    }

    initialize(config, dependencies) {
        if (dependencies.contextBridge) {
            this.contextBridge = dependencies.contextBridge;
            console.log(`[MyPlugin] ContextBridge v${this.contextBridge.version} injected.`);
        } else {
            console.warn('[MyPlugin] ContextBridge not available. Some features will be disabled.');
        }
    }
}
```

### Step 3：使用接口

```javascript
async someMethod(userQuery) {
    if (!this.contextBridge) return;

    // 向量化用户查询
    const queryVector = await this.contextBridge.embedText(userQuery);
    
    // 获取当前对话的"语义重心"
    const contextVector = this.contextBridge.getAggregatedVector('assistant');
    
    // 计算与上下文的相关性
    if (queryVector && contextVector) {
        const relevance = this.contextBridge.cosineSimilarity(queryVector, contextVector);
        console.log(`Query-Context relevance: ${relevance.toFixed(4)}`);
    }
    
    // 获取 EPA 指标判断意图复杂度
    if (queryVector) {
        const depth = this.contextBridge.computeLogicDepth(queryVector);
        const width = this.contextBridge.computeSemanticWidth(queryVector);
        console.log(`Logic Depth: ${depth.toFixed(3)}, Semantic Width: ${width.toFixed(3)}`);
    }
}
```

---

## 完整 API 参考

### 属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `version` | `string` | 接口版本号（当前 `'1.0'`），用于兼容性检查 |

### 上下文向量查询

#### `getAggregatedVector(role?)`

获取当前会话的衰减聚合上下文向量。近期楼层权重更高，远期楼层指数衰减。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `role` | `string` | `'assistant'` | `'assistant'` 或 `'user'` |

**返回：** `Float32Array | null`

**示例：**
```javascript
const aiContext = bridge.getAggregatedVector('assistant');
const userContext = bridge.getAggregatedVector('user');
```

---

#### `getHistoryAssistantVectors()`

获取所有历史 AI 输出的向量列表（按时间顺序排列）。

**返回：** `Array<Float32Array>` — 可能为空数组

---

#### `getHistoryUserVectors()`

获取所有历史用户输入的向量列表（按时间顺序排列）。

**返回：** `Array<Float32Array>` — 可能为空数组

---

#### `getContextSegments(messages, similarityThreshold?)`

将连续的、高相似度的消息归并为语义段落（Segment/Topic）。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `messages` | `Array` | — | 消息列表（OpenAI 格式） |
| `similarityThreshold` | `number` | `0.70` | 分段阈值，低于此值则断开 |

**返回：** `Array<{vector, text, roles, range, count}>`

| 字段 | 类型 | 说明 |
|------|------|------|
| `vector` | `Float32Array` | 段落的平均向量（L2 归一化） |
| `text` | `string` | 段落内所有消息的拼接文本 |
| `roles` | `string[]` | 段落涉及的角色（去重） |
| `range` | `[number, number]` | 段落在消息数组中的起止索引 |
| `count` | `number` | 段落包含的消息数量 |

---

### EPA 指标计算

#### `computeLogicDepth(vector)`

计算向量的**逻辑深度指数 L**。

- `L ≈ 1` → 能量集中在少数维度，逻辑聚焦（如精确的技术问题）
- `L ≈ 0` → 能量分散，逻辑模糊（如闲聊）

| 参数 | 类型 | 说明 |
|------|------|------|
| `vector` | `Array \| Float32Array` | 输入向量 |

**返回：** `number` ∈ [0, 1]

---

#### `computeSemanticWidth(vector)`

计算向量的**语义宽度指数 S**。基于归一化熵衡量能量的分散程度。

- `S ≈ 1` → 能量均匀分布，语义宽泛
- `S ≈ 0` → 能量集中少数维度，语义精准

| 参数 | 类型 | 说明 |
|------|------|------|
| `vector` | `Array \| Float32Array` | L2 归一化向量 |

**返回：** `number` ∈ [0, 1]

---

### 向量化工具

#### `embedText(text)` — async

带缓存的单文本向量化。缓存未命中时会调用 Embedding API。

| 参数 | 类型 | 说明 |
|------|------|------|
| `text` | `string` | 要向量化的文本 |

**返回：** `Promise<Array<number> | null>`

**注意：** 此方法可能触发外部 API 调用，请注意调用频率。高频场景建议先用 `getEmbeddingFromCache()` 检查缓存。

---

#### `embedBatch(texts)` — async

带缓存的批量向量化。

| 参数 | 类型 | 说明 |
|------|------|------|
| `texts` | `string[]` | 要向量化的文本数组 |

**返回：** `Promise<Array<Array<number> | null>>` — 长度与输入一致，失败位置为 `null`

---

#### `getEmbeddingFromCache(text)`

仅从内存缓存获取向量，**不触发 API**。适合高频调用场景。

| 参数 | 类型 | 说明 |
|------|------|------|
| `text` | `string` | 要查询的文本 |

**返回：** `Array<number> | null`

---

### 文本处理工具

#### `sanitize(content, role)`

统一内容净化器。移除 HTML 标签、Emoji、工具调用标记（`<<<[TOOL_REQUEST]>>>`）、系统通知等噪音，确保向量化输入的一致性。

| 参数 | 类型 | 说明 |
|------|------|------|
| `content` | `string` | 原始文本 |
| `role` | `string` | `'user'` 或 `'assistant'`（影响净化策略） |

**返回：** `string` — 净化后的文本

**净化流程：**
1. `user` 角色：移除 `[系统通知]...[系统通知结束]` 块
2. `assistant` 角色：移除 `[@tag]` 锚点标记
3. 通用：`stripHtml` → `stripEmoji` → `stripToolMarkers`

---

### 向量数学工具

#### `cosineSimilarity(vecA, vecB)`

余弦相似度计算。

| 参数 | 类型 | 说明 |
|------|------|------|
| `vecA` | `Array \| Float32Array` | 向量 A |
| `vecB` | `Array \| Float32Array` | 向量 B |

**返回：** `number` ∈ [-1, 1]，无效输入返回 `0`

---

#### `weightedAverage(vectors, weights)`

加权平均向量计算。权重会自动归一化。

| 参数 | 类型 | 说明 |
|------|------|------|
| `vectors` | `Array<Array<number>>` | 向量数组 |
| `weights` | `Array<number>` | 对应权重数组 |

**返回：** `Array<number> | null`

---

#### `averageVector(vectors)`

多向量简单平均值计算。

| 参数 | 类型 | 说明 |
|------|------|------|
| `vectors` | `Array<Array<number>>` | 向量数组 |

**返回：** `Array<number> | null`

---

## 架构图

```
┌─────────────────────────────────────────────────────────┐
│                     Plugin.js                            │
│                   (PluginManager)                         │
│                                                          │
│  loadPlugins() 初始化循环:                                │
│    ┌──────────────────────────────────────────────┐      │
│    │ if (manifest.requiresContextBridge) {        │      │
│    │   const rag = preprocessors.get('RAGDiary'); │      │
│    │   deps.contextBridge = rag.getContextBridge()│      │
│    │ }                                            │      │
│    └──────────────┬───────────────────────────────┘      │
│                   │                                      │
└───────────────────┼──────────────────────────────────────┘
                    │ Object.freeze({...})
                    ▼
┌─────────────────────────────────────────────────────────┐
│              ContextBridge (只读接口)                      │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ 向量查询     │  │ EPA 指标     │  │ 向量化工具     │  │
│  │             │  │              │  │                │  │
│  │ aggregated  │  │ logicDepth   │  │ embedText      │  │
│  │ history*    │  │ semanticWidth│  │ embedBatch     │  │
│  │ segments    │  │              │  │ fromCache      │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                │                   │           │
│  ┌──────┴──────┐  ┌──────┴───────┐  ┌───────┴────────┐  │
│  │ 文本处理     │  │ 向量数学     │  │ 元信息         │  │
│  │             │  │              │  │                │  │
│  │ sanitize    │  │ cosineSim    │  │ version: '1.0' │  │
│  │             │  │ weightedAvg  │  │                │  │
│  │             │  │ averageVec   │  │                │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
└──────────────────────────┬──────────────────────────────┘
                           │ 委托调用 (方法绑定到 self)
                           ▼
┌─────────────────────────────────────────────────────────┐
│              RAGDiaryPlugin (内部实现)                     │
│                                                          │
│  ContextVectorManager    CacheManager    Embedding API   │
│  ├─ vectorMap            ├─ query cache  ├─ getSingle    │
│  ├─ historyVectors       ├─ embed cache  └─ getBatch     │
│  ├─ aggregateContext()   └─ aimemo cache                 │
│  ├─ segmentContext()                                     │
│  ├─ computeLogicDepth()                                  │
│  └─ computeSemanticWidth()                               │
└─────────────────────────────────────────────────────────┘
```

---

## 使用场景示例

### 场景 1：智能搜索插件 — 根据上下文自动调整搜索策略

```javascript
async adjustSearchStrategy(userQuery, messages) {
    const bridge = this.contextBridge;
    if (!bridge) return { k: 5, strategy: 'default' };

    const queryVec = await bridge.embedText(bridge.sanitize(userQuery, 'user'));
    if (!queryVec) return { k: 5, strategy: 'default' };

    // 分析查询的逻辑深度和语义宽度
    const L = bridge.computeLogicDepth(queryVec);
    const S = bridge.computeSemanticWidth(queryVec);

    // 获取上下文重心，判断是否与当前话题相关
    const contextVec = bridge.getAggregatedVector('assistant');
    const contextRelevance = contextVec ? bridge.cosineSimilarity(queryVec, contextVec) : 0;

    // 决策逻辑
    if (L > 0.7 && S < 0.3) {
        // 高逻辑深度 + 低语义宽度 = 精确查询
        return { k: 3, strategy: 'precise', contextRelevance };
    } else if (S > 0.7) {
        // 高语义宽度 = 发散查询，需要更多结果
        return { k: 10, strategy: 'broad', contextRelevance };
    } else {
        return { k: 5, strategy: 'balanced', contextRelevance };
    }
}
```

### 场景 2：话题检测插件 — 检测对话中的话题转换

```javascript
async detectTopicShift(messages) {
    const bridge = this.contextBridge;
    if (!bridge) return null;

    const segments = bridge.getContextSegments(messages);
    if (segments.length < 2) return null;

    const lastTwo = segments.slice(-2);
    const similarity = bridge.cosineSimilarity(lastTwo[0].vector, lastTwo[1].vector);

    return {
        shifted: similarity < 0.5,
        similarity: similarity,
        previousTopic: lastTwo[0].text.substring(0, 100),
        currentTopic: lastTwo[1].text.substring(0, 100)
    };
}
```

### 场景 3：记忆关联插件 — 找到与当前上下文最相关的历史片段

```javascript
async findMostRelevantHistory(currentQuery) {
    const bridge = this.contextBridge;
    if (!bridge) return [];

    const queryVec = await bridge.embedText(currentQuery);
    if (!queryVec) return [];

    const historyVecs = bridge.getHistoryAssistantVectors();
    
    // 计算每个历史片段与当前查询的相关性
    const scored = historyVecs.map((vec, idx) => ({
        index: idx,
        similarity: bridge.cosineSimilarity(queryVec, vec)
    }));

    // 返回最相关的 3 个
    return scored
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 3);
}
```

---

## 注意事项

### 性能

- `embedText()` 和 `embedBatch()` 可能触发外部 API 调用，有网络延迟
- `getEmbeddingFromCache()` 是纯内存操作，适合高频调用
- `getAggregatedVector()` 每次调用都会重新计算衰减聚合，但计算量很小（O(n×d)，n=楼层数，d=向量维度）
- `getContextSegments()` 需要遍历所有消息并查找向量映射，建议不要在循环中频繁调用

### 生命周期

- ContextBridge 的生命周期跟随 RAGDiaryPlugin
- 如果 RAGDiaryPlugin 未加载或初始化失败，`dependencies.contextBridge` 将为 `undefined`
- 插件应始终检查 `this.contextBridge` 是否存在后再使用

### 线程安全

- ContextBridge 的所有方法都是**只读**的，不会修改 RAGDiaryPlugin 的内部状态
- `embedText()` / `embedBatch()` 内部使用了缓存，多个插件并发调用是安全的（CacheManager 使用 Map，Node.js 单线程保证原子性）

### 向后兼容

- LightMemo 仍然保留了原有的 `vectorDBManager` + `getSingleEmbedding` 注入方式
- ContextBridge 是**额外**注入的，不影响现有插件的运行
- 未来新插件建议优先使用 ContextBridge，而非直接依赖 RAGDiaryPlugin 的内部方法

### 不适用 ContextBridge 的场景

**[`modules/messageProcessor.js`](../modules/messageProcessor.js) 中的 `resolveDynamicFoldProtocol()` 不应使用 ContextBridge。**

原因：
1. **时序问题** — `messageProcessor` 的变量替换在所有预处理器（包括 RAGDiaryPlugin）执行**之前**运行。此时 ContextBridge 的 `contextVectorManager.updateContext()` 还没被调用，`getAggregatedVector()` 会返回 null 或上一轮的旧数据。
2. **缓存命中策略** — 当前代码刻意"模仿"RAGDiaryPlugin 的向量化流程（净化 → 加权平均 → 向量化），目的是让后续 RAG 运行时能**命中同一份缓存**。这是一个有意为之的性能优化，如果改用 ContextBridge 的 `embedText()` 会破坏这个缓存对齐。
3. **功能需求不同** — DynamicFold 只需要向量化和相似度计算来决定折叠级别，不需要历史聚合向量或 EPA 指标。它直接调用 RAGDiaryPlugin 实例的方法是正确的做法。

---

## 变更日志

| 版本 | 日期 | 变更内容 |
|------|------|---------|
| 1.0 | 2026-03-30 | 初始版本：上下文向量查询、EPA 指标、向量化工具、文本净化、向量数学 |