# VCPToolBox 记忆系统文档

**版本:** VCP 6.4  
**生成日期:** 2026-02-13  
**核心模块:** KnowledgeBaseManager.js, EPAModule.js, ResidualPyramid.js, ResultDeduplicator.js

---

## 目录

1. [系统概述](#1-系统概述)
2. [多索引架构](#2-多索引架构)
3. [TagMemo "浪潮"算法 V3.7](#3-tagmemo-浪潮算法-v37)
4. [EPA 模块 (Embedding Projection Analysis)](#4-epa-模块-embedding-projection-analysis)
5. [残差金字塔 (Residual Pyramid)](#5-残差金字塔-residual-pyramid)
6. [SVD 结果去重器 (ResultDeduplicator)](#6-svd-结果去重器-resultdeduplicator)
7. [RAG 参数热调控](#7-rag-参数热调控)
8. [文件索引管道](#8-文件索引管道)
9. [数学原理详解](#9-数学原理详解)

---

## 1. 系统概述

VCP 记忆系统是一个基于向量语义检索的 RAG (Retrieval-Augmented Generation) 系统，核心目标是为 AI Agent 提供长期记忆和上下文感知能力。

### 1.1 核心设计哲学

在浪潮算法的视角下，**向量空间并非平坦的，而是充满了语义引力**：

- **语义锚点**：标签（Tags）被视为空间中的引力源
- **向量重塑**：算法根据感应到的标签引力，将向量向核心语义点进行"拉扯"和"扭曲"
- **原子级精准**：穿透表层文字，直达语义核心

### 1.2 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| 向量索引 | Rust N-API (USearch/Vexus) | 业界最快的向量搜索引擎之一 |
| 持久化 | SQLite (better-sqlite3) | WAL 模式，支持 ACID 事务 |
| Embedding | 兼容 OpenAI API 格式 | 支持 Gemini、OpenAI 等模型 |
| 文件监听 | chokidar | 实时索引更新 |

### 1.3 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                    KnowledgeBaseManager                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │ diaryIndices│  │  tagIndex   │  │  SQLite (better-sqlite3)│ │
│  │ (Map结构)   │  │ (VexusIndex)│  │  knowledge_base.sqlite  │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
└───────────────────────────┬─────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────────┐
│   EPAModule   │  │ResidualPyramid│  │ResultDeduplicator │
│  (语义空间定位)│  │ (能量精细拆解)│  │  (智能结果去重)   │
└───────────────┘  └───────────────┘  └───────────────────┘
```

---

## 2. 多索引架构

### 2.1 双索引系统

系统采用 **diaryIndices + tagIndex** 双索引架构：

```javascript
// KnowledgeBaseManager.js:59-60
this.diaryIndices = new Map();  // 每个日记本独立的向量索引
this.tagIndex = null;           // 全局 Tag 索引
```

#### diaryIndices (日记本索引)

- **结构**: `Map<diaryName, VexusIndex>`
- **特点**: 每个日记本拥有独立的向量索引
- **优势**:
  - 检索隔离：避免跨日记本干扰
  - 懒加载：只在访问时加载对应索引
  - 故障隔离：单个索引损坏不影响其他

```javascript
// KnowledgeBaseManager.js:210-220
async _getOrLoadDiaryIndex(diaryName) {
    if (this.diaryIndices.has(diaryName)) {
        return this.diaryIndices.get(diaryName);
    }
    const safeName = crypto.createHash('md5').update(diaryName).digest('hex');
    const idxName = `diary_${safeName}`;
    const idx = await this._loadOrBuildIndex(idxName, 50000, 'chunks', diaryName);
    this.diaryIndices.set(diaryName, idx);
    return idx;
}
```

#### tagIndex (全局标签索引)

- **结构**: 单一 `VexusIndex` 实例
- **容量**: 50,000 个向量
- **用途**: TagMemo 算法的核心查询对象

```javascript
// KnowledgeBaseManager.js:91-98
const tagIdxPath = path.join(this.config.storePath, 'index_global_tags.usearch');
const tagCapacity = 50000;
if (fsSync.existsSync(tagIdxPath)) {
    this.tagIndex = VexusIndex.load(tagIdxPath, null, this.config.dimension, tagCapacity);
} else {
    this.tagIndex = new VexusIndex(this.config.dimension, tagCapacity);
}
```

### 2.2 物理存储结构

```
VectorStore/
├── knowledge_base.sqlite        # SQLite 主数据库
│   ├── files                    # 文件元数据
│   ├── chunks                   # 文本块 + 向量
│   ├── tags                     # 标签 + 向量
│   ├── file_tags                # 文件-标签关联
│   └── kv_store                 # 键值存储 (EPA缓存等)
├── index_global_tags.usearch    # 全局 Tag 索引
├── index_diary_{md5hash}.usearch # 各日记本独立索引
└── ...
```

### 2.3 数据库 Schema

```sql
-- KnowledgeBaseManager.js:166-206
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    diary_name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    mtime INTEGER NOT NULL,
    size INTEGER NOT NULL,
    updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    vector BLOB,
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    vector BLOB
);

CREATE TABLE IF NOT EXISTS file_tags (
    file_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (file_id, tag_id),
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
```

---

## 3. TagMemo "浪潮"算法 V3.7

> **版本说明：** 当前实现为 V3.7 版本。文档中提到的部分 V4/V5 特性（如 PSR 偏振语义舵）为规划中的功能，尚未在代码中实现。

### 3.1 算法概述

TagMemo "浪潮"算法是 VCP 系统中用于 RAG 的核心优化方案。不同于传统的线性向量检索，浪潮算法引入了物理学中的**能量分解**与**引力坍缩**概念。

### 3.2 四阶段工作流

#### 阶段一：感应 (Sensing)

1. **净化处理**：移除 HTML 标签、JSON 结构化转 MD、Emoji 及工具调用标记
2. **EPA 投影**：计算原始向量的逻辑深度和共振值

```javascript
// KnowledgeBaseManager.js:451-456
const epaResult = this.epa.project(originalFloat32);
const resonance = this.epa.detectCrossDomainResonance(originalFloat32);
const queryWorld = epaResult.dominantAxes[0]?.label || 'Unknown';
```

#### 阶段二：分解 (Decomposition)

残差金字塔迭代分解，使用 Gram-Schmidt 正交化投影：

```javascript
// KnowledgeBaseManager.js:458-459
const pyramid = this.residualPyramid.analyze(originalFloat32);
const features = pyramid.features;
```

**能量阈值截断**：当残差能量低于原始能量的 10% 时停止（即解释了 90%）

#### 阶段三：扩张 (Expansion)

1. **核心标签补全**：显式指定的核心标签若未被搜到，强行从数据库捞取
2. **关联词拉回**：利用共现矩阵扩展关联语义
3. **特权过滤**：核心标签无条件保留，普通标签需通过世界观门控筛选

```javascript
// KnowledgeBaseManager.js:550-576
if (allTags.length > 0 && this.tagCooccurrenceMatrix) {
    const topTags = allTags.slice(0, 5);
    topTags.forEach(parentTag => {
        const related = this.tagCooccurrenceMatrix.get(parentTag.id);
        // 找回前 4 个最相关的关联词
        // ...
    });
}
```

#### 阶段四：重塑 (Reshaping)

1. **动态参数计算**：根据逻辑深度和共振值动态决定标签增强比例
2. **向量融合**：原始向量与增强标签向量按动态比例混合
3. **语义去重**：消除冗余标签

```javascript
// KnowledgeBaseManager.js:688-696
const fused = new Float32Array(dim);
for (let d = 0; d < dim; d++) {
    fused[d] = (1 - effectiveTagBoost) * originalFloat32[d] 
             + effectiveTagBoost * contextVec[d];
}
```

### 3.3 核心标签 vs 普通标签

| 特性 | 核心标签 (Core Tags) | 普通标签 (Other Tags) |
|------|---------------------|----------------------|
| **产生方式** | 显式指定或首轮强感应 | 残差金字塔逐层剥离 |
| **缺失处理** | **虚拟补全**（强行捞取） | 自动忽略 |
| **权重待遇** | **Core Boost** (1.2x-1.4x) | 原始贡献权重 |
| **噪音过滤** | **完全豁免** | 严格门控筛选 |

### 3.4 动态 Beta 公式

```javascript
// KnowledgeBaseManager.js:468-473
const dynamicBoostFactor = (logicDepth * (1 + resonanceBoost) 
    / (1 + entropyPenalty * 0.5)) * activationMultiplier;
const effectiveTagBoost = baseTagBoost * Math.max(boostRange[0], 
    Math.min(boostRange[1], dynamicBoostFactor));
```

**物理意义**：
- 当用户意图明确（logicDepth 高）且逻辑清晰（resonance 高）时，加大标签增强力度
- 当噪音较多（entropy 高）时，收紧增强，回归稳健检索

---

## 4. EPA 模块 (Embedding Projection Analysis)

### 4.1 模块职责

EPA 模块负责语义空间的初步定位，提供三个核心指标：

- **逻辑深度 (Logic Depth)**：通过计算投影熵值，判断用户意图的聚焦程度
- **世界观门控 (Worldview Gating)**：识别当前对话所处的语义维度
- **跨域共振 (Resonance)**：检测用户是否同时触及了多个正交的语义轴

### 4.2 核心算法：加权 PCA

基于 **K-Means 聚类 + SVD 分解** 的两阶段算法：

#### Step 1: K-Means 聚类

```javascript
// EPAModule.js:208-285
_clusterTags(tags, k) {
    // Forgy 初始化：随机选择 k 个点作为初始质心
    let centroids = [];
    const indices = new Set();
    while(indices.size < k) indices.add(Math.floor(Math.random() * vectors.length));
    centroids = Array.from(indices).map(i => new Float32Array(vectors[i]));

    // 迭代更新，收敛阈值 1e-4，最大迭代 50 次
    for (let iter = 0; iter < maxIter; iter++) {
        // Assign: 计算每个向量到各质心的相似度，分配到最近簇
        // Update: 重新计算质心并归一化
        if (movement < tolerance) break;
    }
    return { vectors: centroids, labels, weights: clusterSizes };
}
```

#### Step 2: 加权 SVD

```javascript
// EPAModule.js:295-383
_computeWeightedPCA(clusterData) {
    // 1. 计算全局加权平均向量
    const meanVector = new Float32Array(dim);
    for (let i = 0; i < n; i++) {
        const w = weights[i];
        for (let d = 0; d < dim; d++) {
            meanVector[d] += vectors[i][d] * w;
        }
    }
    
    // 2. 构建加权 Gram 矩阵 (n x n)
    // G = X_centered * W * X_centered^T
    
    // 3. Power Iteration with Re-orthogonalization
    // 提取特征向量，每次迭代后对已有基进行 Gram-Schmidt 正交化
}
```

### 4.3 投影与熵计算

```javascript
// EPAModule.js:71-161
project(vector) {
    // 1. 去中心化: v' = v - mean
    const centeredVec = new Float32Array(dim);
    for(let i=0; i<dim; i++) centeredVec[i] = vec[i] - this.basisMean[i];

    // 2. 投影到主成分轴
    for (let k = 0; k < K; k++) {
        let dot = 0;
        const basis = this.orthoBasis[k];
        for (let d = 0; d < dim; d++) dot += centeredVec[d] * basis[d];
        projections[k] = dot;
        totalEnergy += dot * dot;
    }

    // 3. 计算熵 (信息散度)
    for (let k = 0; k < K; k++) {
        probabilities[k] = (projections[k] * projections[k]) / totalEnergy;
        if (probabilities[k] > 1e-9) {
            entropy -= probabilities[k] * Math.log2(probabilities[k]);
        }
    }
    
    // 4. 逻辑深度 = 1 - 归一化熵
    const normalizedEntropy = K > 1 ? entropy / Math.log2(K) : 0;
    return { logicDepth: 1 - normalizedEntropy, ... };
}
```

### 4.4 跨域共振检测

```javascript
// EPAModule.js:170-201
detectCrossDomainResonance(vector) {
    const { dominantAxes } = this.project(vector);
    if (dominantAxes.length < 2) return { resonance: 0, bridges: [] };
    
    const bridges = [];
    const topAxis = dominantAxes[0];
    
    for (let i = 1; i < dominantAxes.length; i++) {
        const secondaryAxis = dominantAxes[i];
        
        // 几何平均能量：sqrt(E1 * E2)
        const coActivation = Math.sqrt(topAxis.energy * secondaryAxis.energy);
        
        if (coActivation > 0.15) {
            bridges.push({
                from: topAxis.label,
                to: secondaryAxis.label,
                strength: coActivation,
                balance: Math.min(topAxis.energy, secondaryAxis.energy) 
                       / Math.max(topAxis.energy, secondaryAxis.energy)
            });
        }
    }
    
    // 总共振值 = 所有 Bridge 强度的总和
    const resonance = bridges.reduce((sum, b) => sum + b.strength, 0);
    return { resonance, bridges };
}
```

---

## 5. 残差金字塔 (Residual Pyramid)

### 5.1 模块职责

残差金字塔是浪潮算法的"数学心脏"，负责语义能量的精细拆解：

- **多级剥离**：利用 Gram-Schmidt 正交化投影，将查询向量分解为"已解释能量"和"残差能量"
- **微弱信号捕获**：通过对残差向量的递归搜索，捕捉被宏观概念掩盖的微弱语义信号
- **相干性分析**：评估召回标签之间的逻辑一致性

### 5.2 核心算法：Gram-Schmidt 正交化

```javascript
// ResidualPyramid.js:126-210
_computeOrthogonalProjection(vector, tags) {
    const basis = []; // 正交基向量
    const basisCoefficients = new Float32Array(n);
    
    // Modified Gram-Schmidt 算法 (数值更稳定)
    for (let i = 0; i < n; i++) {
        const tagVec = new Float32Array(dim);
        new Uint8Array(tagVec.buffer).set(tags[i].vector);
        
        let v = new Float32Array(tagVec);
        
        // 减去在已有基上的投影: v = v - <v, u_j> * u_j
        for (let j = 0; j < basis.length; j++) {
            const u = basis[j];
            const dot = this._dotProduct(v, u);
            for (let d = 0; d < dim; d++) v[d] -= dot * u[d];
        }
        
        // 归一化得到 u_i
        const mag = this._magnitude(v);
        if (mag > 1e-6) {
            for (let d = 0; d < dim; d++) v[d] /= mag;
            basis.push(v);
            
            // 计算投影分量系数
            const coeff = this._dotProduct(vector, v);
            basisCoefficients[i] = Math.abs(coeff);
        }
    }

    // 计算总投影 P = Σ <vector, u_i> * u_i
    const projection = new Float32Array(dim);
    for (let i = 0; i < basis.length; i++) {
        const u = basis[i];
        const dot = this._dotProduct(vector, u);
        for (let d = 0; d < dim; d++) projection[d] += dot * u[d];
    }

    // 残差 R = vector - P
    const residual = new Float32Array(dim);
    for (let d = 0; d < dim; d++) residual[d] = vector[d] - projection[d];

    return { projection, residual, orthogonalBasis: basis, basisCoefficients };
}
```

### 5.3 金字塔分析流程

```javascript
// ResidualPyramid.js:25-120
analyze(queryVector) {
    const pyramid = {
        levels: [],
        totalExplainedEnergy: 0,
        finalResidual: null,
        features: {}
    };

    let currentResidual = new Float32Array(queryVector);
    const originalEnergy = this._magnitude(queryVector) ** 2;

    for (let level = 0; level < this.config.maxLevels; level++) {
        // 1. 搜索当前残差向量的最近 Tags
        const tagResults = this.tagIndex.search(searchBuffer, this.config.topK);
        
        // 2. Gram-Schmidt 正交投影
        const { projection, residual, basisCoefficients } = 
            this._computeOrthogonalProjection(currentResidual, rawTags);
        
        // 3. 计算能量数据
        const residualEnergy = this._magnitude(residual) ** 2;
        const energyExplainedByLevel = (currentEnergy - residualEnergy) / originalEnergy;
        
        pyramid.levels.push({ level, tags: [...], energyExplained: energyExplainedByLevel });
        pyramid.totalExplainedEnergy += energyExplainedByLevel;
        currentResidual = residual;

        // 4. 能量阈值截断 (90% 解释率)
        if ((residualEnergy / originalEnergy) < this.config.minEnergyRatio) break;
    }
    
    pyramid.features = this._extractPyramidFeatures(pyramid);
    return pyramid;
}
```

### 5.4 握手特征分析

握手差值分析用于评估查询与标签之间的方向性差异：

```javascript
// ResidualPyramid.js:279-320
_analyzeHandshakes(handshakes, dim) {
    // 1. 方向一致性 (Coherence)
    // 如果所有 Tag 都在同一个方向上偏离 Query，说明有明确的"偏移意图"
    const directionCoherence = this._magnitude(avgDirection);
    
    // 2. 内部张力 (Pattern Strength)
    // Tag 之间的差值方向是否相似
    const avgPairwiseSim = pairwiseSimSum / pairCount;
    
    return {
        directionCoherence,
        patternStrength: avgPairwiseSim,
        noveltySignal: directionCoherence,  // 新颖信号
        noiseSignal: (1 - directionCoherence) * (1 - avgPairwiseSim)  // 噪音信号
    };
}
```

### 5.5 特征提取

```javascript
// ResidualPyramid.js:325-360
_extractPyramidFeatures(pyramid) {
    const coverage = Math.min(1.0, pyramid.totalExplainedEnergy);  // 覆盖率
    const coherence = handshake ? handshake.patternStrength : 0;    // 相干度
    
    // Novelty (新颖度) = 残差能量 + 方向一致性
    const residualRatio = 1 - coverage;
    const directionalNovelty = handshake ? handshake.noveltySignal : 0;
    const novelty = (residualRatio * 0.7) + (directionalNovelty * 0.3);

    return {
        depth: pyramid.levels.length,
        coverage,
        novelty,
        coherence,
        tagMemoActivation: coverage * coherence * (1 - (handshake?.noiseSignal || 0)),
        expansionSignal: novelty
    };
}
```

---

## 6. SVD 结果去重器 (ResultDeduplicator)

### 6.1 模块职责

**智能过滤器**，用于处理"霰弹枪"检索回来的海量结果：

- **SVD 主题建模**：对候选结果进行 SVD 分解，识别潜在主题
- **残差选择**：使用 Gram-Schmidt 正交化，迭代选择能解释"未覆盖主题能量"的最佳结果
- **弱语义保留**：确保微弱但独特的重要信息不被丢弃

### 6.2 去重算法流程

```javascript
// ResultDeduplicator.js:44-168
async deduplicate(candidates, queryVector) {
    // 1. 预处理：过滤无向量的结果
    const validCandidates = candidates.filter(c => c.vector || c._vector);
    if (validCandidates.length <= 5) return candidates;

    // 2. 提取向量数组
    const vectors = validCandidates.map(c => new Float32Array(c.vector || c._vector));

    // 3. SVD 分析：提取当前结果集的主题分布
    const clusterData = { vectors, weights: vectors.map(() => 1), labels: [...] };
    const svdResult = this.epa._computeWeightedPCA(clusterData);
    const { U: topics, S: energies } = svdResult;

    // 4. 过滤极弱主题 (95% 累积能量)
    const significantTopics = [];
    let cumEnergy = 0;
    for (let i = 0; i < topics.length; i++) {
        significantTopics.push(topics[i]);
        cumEnergy += energies[i];
        if (cumEnergy / totalEnergy > 0.95) break;
    }

    // 5. 残差选择算法
    const selectedIndices = new Set();
    const selectedResults = [];
    
    // 5.1 优先保留与 Query 最直接相关的第一名
    let bestIdx = -1, bestSim = -1;
    for (let i = 0; i < vectors.length; i++) {
        const sim = this._dotProduct(this._normalize(vectors[i]), nQuery);
        if (sim > bestSim) { bestSim = sim; bestIdx = i; }
    }
    selectedResults.push(validCandidates[bestIdx]);
    
    // 5.2 迭代选择：寻找能解释剩余特征的最佳候选项
    const currentBasis = [vectors[bestIdx]];
    for (let round = 0; round < maxRounds; round++) {
        let maxProjectedEnergy = -1, nextBestIdx = -1;
        
        for (let i = 0; i < vectors.length; i++) {
            if (selectedIndices.has(i)) continue;
            
            // 计算该向量与已选集合的"差异" (残差)
            const { residual } = this.residualCalculator._computeOrthogonalProjection(
                vectors[i], currentBasis.map(v => ({ vector: v }))
            );
            const noveltyEnergy = this._magnitude(residual) ** 2;
            
            // 综合评分：差异性 * 原始相关度
            const score = noveltyEnergy * (validCandidates[i].score + 0.5);
            if (score > maxProjectedEnergy) {
                maxProjectedEnergy = score;
                nextBestIdx = i;
            }
        }
        
        // 检查新信息量是否足够
        if (maxProjectedEnergy < 0.01) break;
        
        selectedResults.push(validCandidates[nextBestIdx]);
        currentBasis.push(vectors[nextBestIdx]);
    }
    
    return selectedResults;
}
```

---

## 7. RAG 参数热调控

### 7.1 参数文件

系统支持通过 `rag_params.json` 文件进行实时参数调整：

```javascript
// KnowledgeBaseManager.js:140-164
async loadRagParams() {
    const paramsPath = path.join(__dirname, 'rag_params.json');
    try {
        const data = await fs.readFile(paramsPath, 'utf-8');
        this.ragParams = JSON.parse(data);
        console.log('[KnowledgeBase] ✅ RAG 热调控参数已加载');
    } catch (e) {
        this.ragParams = { KnowledgeBaseManager: {} };
    }
}
```

### 7.2 参数监听

通过 chokidar 实现参数文件变更的实时监听：

```javascript
// KnowledgeBaseManager.js:155-164
_startRagParamsWatcher() {
    const paramsPath = path.join(__dirname, 'rag_params.json');
    this.ragParamsWatcher = chokidar.watch(paramsPath);
    this.ragParamsWatcher.on('change', async () => {
        console.log('[KnowledgeBase] 🔄 检测到 rag_params.json 变更，正在重新加载...');
        await this.loadRagParams();
    });
}
```

### 7.3 可调控参数

| 参数名 | 默认值 | 说明 |
|--------|--------|------|
| `activationMultiplier` | [0.5, 1.5] | TagMemo 激活乘数范围 |
| `dynamicBoostRange` | [0.3, 2.0] | 动态增强范围 |
| `coreBoostRange` | [1.20, 1.40] | 核心标签增强范围 |
| `deduplicationThreshold` | 0.88 | 语义去重阈值 |
| `techTagThreshold` | 0.08 | 技术标签过滤门槛 |
| `normalTagThreshold` | 0.015 | 普通标签过滤门槛 |
| `languageCompensator.penaltyUnknown` | 0.05 | 未知语言惩罚 |
| `languageCompensator.penaltyCrossDomain` | 0.1 | 跨域惩罚 |

### 7.4 参数应用示例

```javascript
// KnowledgeBaseManager.js:462-473
const config = this.ragParams?.KnowledgeBaseManager || {};

const actRange = config.activationMultiplier || [0.5, 1.5];
const activationMultiplier = actRange[0] + features.tagMemoActivation * (actRange[1] - actRange[0]);

const boostRange = config.dynamicBoostRange || [0.3, 2.0];
const effectiveTagBoost = baseTagBoost * Math.max(boostRange[0], Math.min(boostRange[1], dynamicBoostFactor));
```

---

## 8. 文件索引管道

### 8.1 文件监听机制

使用 chokidar 实现实时文件监听：

```javascript
// KnowledgeBaseManager.js:880-904
_startWatcher() {
    const handleFile = (filePath) => {
        const relPath = path.relative(this.config.rootPath, filePath);
        const parts = relPath.split(path.sep);
        const diaryName = parts.length > 1 ? parts[0] : 'Root';

        // 忽略规则检查
        if (this.config.ignoreFolders.includes(diaryName)) return;
        if (this.config.ignorePrefixes.some(p => fileName.startsWith(p))) return;
        if (this.config.ignoreSuffixes.some(s => fileName.endsWith(s))) return;
        if (!filePath.match(/\.(md|txt)$/i)) return;

        this.pendingFiles.add(filePath);
        if (this.pendingFiles.size >= this.config.maxBatchSize) {
            this._flushBatch();
        } else {
            this._scheduleBatch();
        }
    };
    
    this.watcher = chokidar.watch(this.config.rootPath, {
        ignored: /(^|[\/\\])\../,
        ignoreInitial: !this.config.fullScanOnStartup
    });
    this.watcher.on('add', handleFile).on('change', handleFile).on('unlink', fp => this._handleDelete(fp));
}
```

### 8.2 批处理流程

```javascript
// KnowledgeBaseManager.js:911-1152
async _flushBatch() {
    // 1. 解析文件并按日记本分组
    const docsByDiary = new Map();
    await Promise.all(batchFiles.map(async (filePath) => {
        // 读取文件、计算 checksum、分块、提取标签
    }));

    // 2. 收集所有文本进行 Embedding
    const allChunksWithMeta = [];
    const uniqueTags = new Set();
    // ... 收集 chunks 和 tags

    // 3. 批量 Embedding API 调用
    const chunkVectors = await getEmbeddingsBatch(texts, embeddingConfig);
    const tagVectors = await getEmbeddingsBatch(newTags, embeddingConfig);

    // 4. 数据库事务写入
    const transaction = this.db.transaction(() => {
        // 插入/更新 tags
        // 插入/更新 files
        // 插入 chunks
        // 建立 file_tags 关联
    });
    const { updates, tagUpdates, deletions } = transaction();

    // 5. 更新向量索引
    // 先删除旧向量，再添加新向量
    if (deletions && deletions.size > 0) {
        for (const [dName, chunkIds] of deletions) {
            const idx = await this._getOrLoadDiaryIndex(dName);
            chunkIds.forEach(id => idx.remove(id));
        }
    }
    
    // 6. 添加新向量到索引
    for (const [dName, chunks] of updates) {
        const idx = await this._getOrLoadDiaryIndex(dName);
        chunks.forEach(u => idx.add(u.id, u.vec));
        this._scheduleIndexSave(dName);
    }

    // 7. 异步重建共现矩阵
    setImmediate(() => this._buildCooccurrenceMatrix());
}
```

### 8.3 标签提取

```javascript
// KnowledgeBaseManager.js:1206-1230
_extractTags(content) {
    // 支持多行 Tag 提取，兼容多种分隔符 (中英文逗号、分号、顿号、竖线)
    const tagLines = content.match(/Tag:\s*(.+)$/gim);
    if (!tagLines) return [];

    let allTags = [];
    tagLines.forEach(line => {
        const tagContent = line.replace(/Tag:\s*/i, '');
        const splitTags = tagContent.split(/[,，、;|｜]/).map(t => t.trim()).filter(Boolean);
        allTags.push(...splitTags);
    });

    // 清理每个 tag 末尾的句号，应用 Embedding 预处理
    let tags = allTags.map(t => {
        let cleaned = t.replace(/[。.]+$/g, '').trim();
        return this._prepareTextForEmbedding(cleaned);
    }).filter(t => t !== '[EMPTY_CONTENT]');

    // 应用黑名单过滤
    tags = tags.filter(t => !this.config.tagBlacklist.has(t) && t.length > 0);
    return [...new Set(tags)];
}
```

### 8.4 共现矩阵构建

```javascript
// KnowledgeBaseManager.js:1233-1258
_buildCooccurrenceMatrix() {
    const stmt = this.db.prepare(`
        SELECT ft1.tag_id as tag1, ft2.tag_id as tag2, COUNT(ft1.file_id) as weight
        FROM file_tags ft1
        JOIN file_tags ft2 ON ft1.file_id = ft2.file_id AND ft1.tag_id < ft2.tag_id
        GROUP BY ft1.tag_id, ft2.tag_id
    `);

    const matrix = new Map();
    for (const row of stmt.iterate()) {
        if (!matrix.has(row.tag1)) matrix.set(row.tag1, new Map());
        if (!matrix.has(row.tag2)) matrix.set(row.tag2, new Map());

        matrix.get(row.tag1).set(row.tag2, row.weight);
        matrix.get(row.tag2).set(row.tag1, row.weight); // 对称填充
    }
    this.tagCooccurrenceMatrix = matrix;
}
```

---

## 9. 数学原理详解

### 9.1 Gram-Schmidt 正交化

**目的**：将一组线性无关的向量转化为一组正交（垂直）的向量。

**算法**（Modified Gram-Schmidt，数值更稳定）：

对于向量组 $\{v_1, v_2, ..., v_n\}$：

$$u_1 = \frac{v_1}{\|v_1\|}$$

$$u_k = \frac{v_k - \sum_{j=1}^{k-1} \langle v_k, u_j \rangle u_j}{\|v_k - \sum_{j=1}^{k-1} \langle v_k, u_j \rangle u_j\|}$$

**在残差金字塔中的应用**：

- 将搜索到的 Tag 向量转化为正交基
- 计算查询向量在正交基上的投影（已解释能量）
- 残差 = 原始向量 - 投影（未解释能量）

### 9.2 加权 PCA (基于 SVD)

**目的**：找到数据的主要变化方向（主成分），同时考虑样本权重。

**算法步骤**：

1. **加权平均**：
   $$\mu = \frac{\sum_{i=1}^{n} w_i v_i}{\sum_{i=1}^{n} w_i}$$

2. **中心化**：
   $$\tilde{v}_i = v_i - \mu$$

3. **构建加权 Gram 矩阵**：
   $$G = X W X^T$$
   其中 $X$ 是中心化后的向量矩阵，$W$ 是权重对角矩阵

4. **Power Iteration**：迭代求解特征值和特征向量

### 9.3 投影熵与逻辑深度

**投影概率分布**：
$$p_k = \frac{\langle v, u_k \rangle^2}{\sum_{j=1}^{K} \langle v, u_j \rangle^2}$$

**熵**（信息散度）：
$$H = -\sum_{k=1}^{K} p_k \log_2 p_k$$

**归一化熵**：
$$H_{norm} = \frac{H}{\log_2 K}$$

**逻辑深度**：
$$L = 1 - H_{norm}$$

**物理意义**：
- 熵低 → 投影能量集中在少数几个主成分上 → 意图聚焦 → 逻辑深度高
- 熵高 → 投影能量分散 → 意图发散 → 逻辑深度低

### 9.4 跨域共振

**几何平均能量**（共激活强度）：
$$C_{i,j} = \sqrt{E_i \cdot E_j}$$

**共振条件**：$C_{i,j} > 0.15$

**总共振值**：
$$R = \sum_{(i,j) \in Bridges} C_{i,j}$$

### 9.5 能量分解

**原始能量**：
$$E_{original} = \|v\|^2$$

**投影能量**（已解释）：
$$E_{projection} = \|P\|^2$$

**残差能量**（未解释）：
$$E_{residual} = \|R\|^2 = \|v - P\|^2$$

**能量守恒**（正交投影性质）：
$$E_{original} = E_{projection} + E_{residual}$$

**解释率**：
$$\text{Coverage} = \frac{E_{projection}}{E_{original}}$$

---

## 附录 A: 配置参数汇总

| 参数名 | 环境变量 | 默认值 | 说明 |
|--------|----------|--------|------|
| 向量维度 | `VECTORDB_DIMENSION` | 3072 | 与 Embedding 模型匹配 |
| 批处理窗口 | `KNOWLEDGEBASE_BATCH_WINDOW_MS` | 2000 | 毫秒 |
| 最大批大小 | `KNOWLEDGEBASE_MAX_BATCH_SIZE` | 50 | 文件数 |
| 索引保存延迟 | `KNOWLEDGEBASE_INDEX_SAVE_DELAY` | 120000 | 毫秒 |
| 标签索引保存延迟 | `KNOWLEDGEBASE_TAG_INDEX_SAVE_DELAY` | 300000 | 毫秒 |
| 忽略文件夹 | `IGNORE_FOLDERS` | VCP论坛 | 逗号分隔 |
| 忽略前缀 | `IGNORE_PREFIXES` | 已整理 | 逗号分隔 |
| 忽略后缀 | `IGNORE_SUFFIXES` | 夜伽 | 逗号分隔 |
| 标签黑名单 | `TAG_BLACKLIST` | (空) | 逗号分隔 |
| 标签扩展上限 | `TAG_EXPAND_MAX_COUNT` | 30 | |
| 启动全扫描 | `KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP` | true | |
| 语言门控 | `LANG_CONFIDENCE_GATING_ENABLED` | true | |

---

## 附录 B: 相关文件索引

| 文件 | 职责 | 核心类/函数 |
|------|------|-------------|
| `KnowledgeBaseManager.js` | 向量库总控 | `KnowledgeBaseManager` |
| `EPAModule.js` | 语义空间分析 | `EPAModule` |
| `ResidualPyramid.js` | 残差金字塔 | `ResidualPyramid` |
| `ResultDeduplicator.js` | 结果去重 | `ResultDeduplicator` |
| `TextChunker.js` | 文本分块 | `chunkText()` |
| `EmbeddingUtils.js` | Embedding 工具 | `getEmbeddingsBatch()` |
| `rust-vexus-lite/` | Rust 向量引擎 | `VexusIndex` |

---

*文档结束*
