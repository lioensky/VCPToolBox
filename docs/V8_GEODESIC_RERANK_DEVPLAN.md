# V8 测地线重排 (Geodesic Rerank) 开发计划

**日期**: 2026-04-12  
**参与者**: 莱恩、小克、小娜  
**状态**: 单元测试中

---

## 一、核心思路

复用 Spike Propagation 在 `applyTagBoost()` 中已经计算好的 `accumulatedEnergy` 距离场，对 KNN 候选 chunk 做基于"地形贴地距离"的二次重排。

**关键公式**:
```
finalScore = (1 - α) * knnScore + α * normalizedGeoScore
```

**激活方式**: `::TagMemo+` 修饰符（`::TagMemo` 的增强版）

**安全保证**: 三层防御链，最坏情况 = 不改动（退化为纯 KNN 排序）

---

## 二、数据流全景

```
RAGDiaryPlugin._processRAGPlaceholder()
  │
  ├─ 1. 解析 ::TagMemo+ → useGeodesicRerank = true
  │     （同时 tagWeight 仍然生效，TagMemo+ 是 TagMemo 的超集）
  │
  ├─ 2. applyTagBoost() [在外部感应 Tag 时调用]
  │     → TagMemoEngine.lastEnergyField 被设置（但会被 search 内部再次覆写）
  │
  ├─ 3. vectorDBManager.search(diaryName, vector, k, tagWeight, coreTags, 1.33, { geodesicRerank: true, geoAlpha, minGeoSamples })
  │     │
  │     ├─ KnowledgeBaseManager._searchSpecificIndex()
  │     │   ├─ applyTagBoost() → 缓存 lastEnergyField ✅（这是搜索时使用的正确距离场）
  │     │   ├─ vexusIdx.search() → rawResults [{id, score}]
  │     │   ├─ 🌟 geodesicRerank(rawResults) → rerankedResults（只重排，不截断）
  │     │   └─ hydrate → 返回完整结果
  │     │
  │     └─ KnowledgeBaseManager._searchAllIndices()
  │         ├─ applyTagBoost() → 缓存 lastEnergyField ✅（单次调用，所有索引共享）
  │         ├─ 并行搜索所有索引 → flatResults
  │         ├─ 合并排序
  │         ├─ 🌟 geodesicRerank(topResults) → rerankedResults（只重排，不截断）
  │         └─ hydrate → 返回完整结果
  │
  ├─ 4. [可选] deduplicateResults() — Tagmemo V4 去重
  │
  ├─ 5. [可选] TimeDecay — 时间衰减
  │
  ├─ 6. [可选] _rerankDocuments() — Rerank 或 Rerank+（交叉编码器精排）
  │
  └─ 7. 最终截断到 finalK → 格式化输出
```

**关键时序保证**: JavaScript 单线程 → `applyTagBoost()` 和 `idx.search()` 都是同步调用 → 在同一个 `_searchSpecificIndex` 执行期间不会被其他搜索覆写 `lastEnergyField`。

---

## 三、文件修改清单

### 3.1 TagMemoEngine.js

#### 修改 1: 构造函数 — 新增 `lastEnergyField` 属性  
**位置**: 第 17-23 行（constructor 内部）  
**内容**: 添加 `this.lastEnergyField = null;`

#### 修改 2: `applyTagBoost()` — 缓存距离场  
**位置**: 第 58 行（方法入口处清空旧值）和第 ~256 行（spike 循环结束后缓存新值）  
**逻辑**:
- 方法入口：`this.lastEnergyField = null;`（防止旧数据泄露）
- spike 循环结束后：`this.lastEnergyField = accumulatedEnergy;`（缓存新计算的距离场）
- 如果 `allTags.length === 0` 或 `tagCooccurrenceMatrix` 不存在，`lastEnergyField` 保持 `null`

#### 修改 3: 新增 `geodesicRerank()` 方法  
**位置**: 在 `getEPAAnalysis()` 方法之后（~第 510 行）  
**方法签名**:
```js
geodesicRerank(candidates, options = {})
```
**参数**:
- `candidates`: `[{id: BigInt|Number, score: Number}]` — 原始 KNN 搜索结果
- `options.alpha`: 测地线分数混合权重 (0~1)，默认 0.3
- `options.minGeoSamples`: 最小采样密度门槛，默认 4

**算法步骤**:
```
1. 检查 lastEnergyField 是否存在 → 否则退化返回原数组 (L0)
2. 批量查询 chunk_id → file_id 映射
3. 批量查询 file_id → tag_id[] 映射
4. 对每个候选计算 geoScore:
   a. 遍历该 chunk 关联的 tag_ids
   b. 统计在 lastEnergyField 中命中的次数 (hitCount) 和总能量 (totalEnergy)
   c. hitCount >= minGeoSamples → geoScore = totalEnergy / hitCount (L1)
   d. hitCount < minGeoSamples → geoScore = 0（采样密度不足，退化为纯 KNN）
5. 找到 maxGeo → 如果 maxGeo = 0，跳过归一化，直接返回原数组 (L2)
6. 归一化 geoScore 到 [0~1] 范围 (÷ maxGeo)
7. 混合: finalScore = (1-α) * knnScore + α * normalizedGeoScore
8. 按 finalScore 降序排列
9. 返回重排后的完整数组（不截断）
```

**SQL 查询设计**:
```sql
-- Step 2: chunk → file 映射
SELECT id, file_id FROM chunks WHERE id IN (?, ?, ...)

-- Step 3: file → tags 映射
SELECT file_id, tag_id FROM file_tags WHERE file_id IN (?, ?, ...)
```

### 3.2 KnowledgeBaseManager.js

#### 修改 1: `search()` 方法 — 支持第 7 个 `options` 参数  
**位置**: 第 315 行  
**内容**: 在参数解析逻辑中提取 `options` 对象

#### 修改 2: `_searchSpecificIndex()` — 在 hydrate 前插入 geodesicRerank  
**位置**: 第 353 行（方法签名）和 第 ~388-393 行（`idx.search()` 之后、hydrate 之前）  
**逻辑**:
```js
let results = idx.search(searchVecFloat, k);
// 🌟 V8: 测地线重排（只重排，不截断）
if (options?.geodesicRerank && this.tagMemoEngine?.lastEnergyField) {
    results = this.tagMemoEngine.geodesicRerank(results, {
        alpha: options.geoAlpha,
        minGeoSamples: options.minGeoSamples
    });
}
```

#### 修改 3: `_searchAllIndices()` — 在合并排序后插入 geodesicRerank  
**位置**: 第 428 行（方法签名）和 第 ~458-460 行（`sort` 和 `slice` 之间）  
**逻辑**:
```js
allResults.sort((a, b) => b.score - a.score);
// 🌟 V8: 测地线重排（只重排，不截断）
if (options?.geodesicRerank && this.tagMemoEngine?.lastEnergyField) {
    allResults = this.tagMemoEngine.geodesicRerank(allResults, {
        alpha: options.geoAlpha,
        minGeoSamples: options.minGeoSamples
    });
}
const topK = allResults.slice(0, k);
```

#### 修改 4: 暴露公共接口 `geodesicRerank()`  
**位置**: `applyTagBoost()` 之后（~第 492 行）  
**内容**: 代理方法，供外部直接调用（主要用于未来扩展和测试）

### 3.3 RAGDiaryPlugin.js

#### 修改 1: `_processRAGPlaceholder()` — 解析 `::TagMemo+` 修饰符  
**位置**: 第 2275-2277 行（现有 TagMemo 解析区域）  
**改动**: 将现有的 `::TagMemo` 解析扩展为支持 `::TagMemo+`

**解析逻辑**:
```js
// 🌟 V8: 解析 TagMemo/TagMemo+ 修饰符
const tagMemoPlusMatch = modifiers.match(/::TagMemo\+(\d+\.?\d*)?/);
const useGeodesicRerank = !!tagMemoPlusMatch;
const tagMemoMatch = modifiers.match(/::TagMemo\+?(\d+\.?\d*)?/);
// tagWeight 提取逻辑保持不变，TagMemo+ 同时激活 TagMemo 功能
let tagWeight = tagMemoMatch?.[1] ? parseFloat(tagMemoMatch[1]) : 
    (modifiers.includes('::TagMemo') ? defaultTagWeight : null);
```

#### 修改 2: 在所有 `search()` 调用中传递 geodesicRerank 选项  
**位置**: 
- 第 2370 行（Time 模式语义路搜索）
- 第 2423 行（Shotgun Query 标准路搜索）

**改动**: 在 `search()` 调用中追加第 7 个参数
```js
const geoOptions = useGeodesicRerank ? {
    geodesicRerank: true,
    geoAlpha: this.ragParams?.KnowledgeBaseManager?.geodesicRerank?.alpha ?? 0.3,
    minGeoSamples: this.ragParams?.KnowledgeBaseManager?.geodesicRerank?.minGeoSamples ?? 4
} : undefined;

// 传递给 search 调用
await this.vectorDBManager.search(dbName, qv.vector, k, tagWeight, coreTagsForSearch, undefined, geoOptions);
```

#### 修改 3: VCP Info 广播 — 添加 geodesicRerank 状态  
**位置**: 第 ~2549-2553 行（vcpInfoData 对象）  
**改动**: 追加 `useGeodesicRerank` 和 `geoAlpha` 字段

### 3.4 rag_params.json

**新增字段**: 在 `KnowledgeBaseManager` 下添加 `geodesicRerank` 配置节

```json
{
  "KnowledgeBaseManager": {
    "geodesicRerank": {
      "alpha": 0.3,
      "minGeoSamples": 4
    },
    // ... 现有配置不变
  }
}
```

---

## 四、三层防御链

| 层级 | 条件 | 行为 | 影响范围 |
|------|------|------|----------|
| **L0** | `lastEnergyField` 为空（无 spike 传播结果） | 整个 `geodesicRerank` 退化，返回原数组 | 全局 |
| **L1** | 某 chunk 的 `hitCount < minGeoSamples` | 该 chunk 的 `geoScore = 0` | 单个候选 |
| **L2** | 所有 chunk 的 `maxGeo = 0` | 归一化跳过，全部走纯 KNN 排序 | 全局 |

**最坏情况**: 等于没改（纯 KNN 排序结果原样返回）

---

## 五、热调参清单（rag_params.json）

| 参数 | 路径 | 默认值 | 说明 | 调参建议 |
|------|------|--------|------|----------|
| `alpha` | `KnowledgeBaseManager.geodesicRerank.alpha` | `0.3` | 测地线分数混合权重。0=纯KNN，1=纯测地线 | 0.2~0.5 为合理区间。先从 0.3 开始，观察召回质量变化 |
| `minGeoSamples` | `KnowledgeBaseManager.geodesicRerank.minGeoSamples` | `4` | 最小采样密度门槛。低于此值的 chunk 退化为纯 KNN | 莱恩建议为 4。Tag 密度高的库可以提高到 5-6 |

---

## 六、测试要点

### 单元测试验证点

1. **L0 退化**: `lastEnergyField = null` 时，`geodesicRerank` 返回原数组不变
2. **L1 退化**: 所有 chunk 的 hitCount < minGeoSamples 时，geoScore 全为 0
3. **L2 退化**: maxGeo = 0 时，跳过归一化，返回原序
4. **正常混合**: 构造有差异的 geoScore，验证排序结果符合 `(1-α)*knn + α*geo` 公式
5. **不截断**: 输入 N 个候选，输出仍为 N 个（只重排，不丢弃）
6. **修饰符解析**: `::TagMemo+` 激活 geodesic，`::TagMemo` 不激活
7. **权重兼容**: `::TagMemo+0.3` 正确提取 tagWeight=0.3 且激活 geodesic
8. **与 Rerank+ 协作**: geodesicRerank 重排后的结果能正确进入 Rerank+ 精排

### 集成测试场景

- 使用已知日记本，构造查询使某些 chunk 通过 Tag 拓扑关联但余弦距离较远
- 对比 `::TagMemo` vs `::TagMemo+` 的召回差异
- 验证 `alpha` 参数热调控生效（修改 rag_params.json 后不重启即可生效）

---

## 七、风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| SQL 查询性能（大量 chunk→file→tag 查询）| 中 | 搜索延迟增加 | 批量 IN 查询 + SQLite WAL 模式 |
| shotgun query 并发覆写 lastEnergyField | 低 | 不会发生：JS 单线程 + 同步调用链 | 已验证无竞态 |
| 万能 Tag 误拉高分 | 低 | L1 门槛已自然过滤 | minGeoSamples=4 兜底 |
| Rerank+ 候选池被提前截断 | 无 | geodesicRerank 只重排不截断 | 架构设计保证 |

---

## 八、实施步骤（按文件顺序）

1. **TagMemoEngine.js** — 缓存距离场 + 实现 geodesicRerank()
2. **KnowledgeBaseManager.js** — 搜索方法接受 options + 调用 geodesicRerank + 暴露公共接口
3. **RAGDiaryPlugin.js** — 解析 ::TagMemo+ + 传递 options 到 search 调用 + VCP Info 广播
4. **rag_params.json** — 新增 geodesicRerank 配置节
5. **单元测试** — 验证以上所有逻辑