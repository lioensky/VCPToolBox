# VCP Agent 记忆构成详解

## 一、记忆系统概述

VCP 的 Agent 记忆系统是一个多层次、向量化的长期记忆与上下文感知系统，核心目标是为 AI Agent 提供**长期记忆**和**上下文感知**能力。

### 1.1 核心技术

| 组件 | 技术 |
|------|------|
| 向量索引 | Rust N-API (USearch/Vexus) |
| 持久化 | SQLite (better-sqlite3) |
| Embedding | 兼容 OpenAI API 格式 |
| 文件监听 | chokidar |

---

## 二、Agent 记忆的构成

根据对 Agent 配置文件（如 [Nova.txt](VCPToolBox/Agent/Nova.txt)）的分析，VCP Agent 的记忆由以下几个层面构成：

### 2.1 记忆层次结构

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent 系统提示词 (System Prompt)           │
├─────────────────────────────────────────────────────────────┤
│  1. 日记时间线 (VarTimeline)                                  │
│     - 按时间排序的日记条目                                     │
│     - 可通过 TagMemo 算法检索相关记忆                         │
├─────────────────────────────────────────────────────────────┤
│  2. VCP 元思维模块 (MetaThinking)                            │
│     - 递归向量增强的多阶段推理                                 │
│     - 支持多主题自动切换                                       │
├─────────────────────────────────────────────────────────────┤
│  3. 知识库日记本                                              │
│     - 个人日记本 (TagMemo 检索)                               │
│     - 公共日记本 (TagMemo + Rerank)                          │
│     - 开发专用日记本                                          │
├─────────────────────────────────────────────────────────────┤
│  4. 论坛模块 (VCP Forum)                                     │
│     - 社区帖子列表                                            │
│     - Agent 间共享信息                                        │
├─────────────────────────────────────────────────────────────┤
│  5. 工具箱系统                                               │
│     - 系统工具列表                                            │
│     - 媒体工具、搜索工具、联系人工具                           │
│     - 文件工具、日记编辑工具                                  │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 记忆配置示例 (Nova.txt)

```txt
————日记时间线————
{{VarTimelineNova}}
————VCP元思维模块————
[[VCP元思考::Group]]
————VCP元思考加载结束—————
Nova的日记本:[[Nova日记本::Time::Group::TagMemo0.65]]。
这里是Nova的知识库：[[Nova的知识日记本::Time::Group::TagMemo0.5]]
这里是莱恩家公共日记本:[[公共日记本:Time::Group::Rerank::TagMemo0.55]]
这是VCP开发说明书:<<VCP开发日记本>>
————————以上是过往记忆区————————
{{VarForum}}
{{VCPForumLister}}
——————论坛模块————
{{VCPMemoToolBox}}
{{VCPMediaToolBox}}
{{VCPSearchToolBox}}
{{VCPContactToolBox}}
{{VCPFileToolBox}}
{{VarDailyNoteGuide}}
{{VCPDailyNoteEditor}}
```

---

## 三、核心记忆模块详解

### 3.1 日记时间线 (Timeline)

- **变量**: `{{VarTimelineNova}}`
- **作用**: 按时间排序的历史日记条目
- **来源**: VCP 分布式服务器或本地存储

### 3.2 VCP 元思维模块 (MetaThinking)

**作用**: 递归向量增强的多阶段推理系统

**核心文件**: [Plugin/RAGDiaryPlugin/MetaThinkingManager.js](VCPToolBox/Plugin/RAGDiaryPlugin/MetaThinkingManager.js)

**工作流程**:
1. 加载元思考链配置 (`meta_thinking_chains.json`)
2. 主题向量自动匹配（相似度阈值 0.65）
3. 执行多阶段递归推理

**配置结构**:
```javascript
// meta_thinking_chains.json
{
  "chains": {
    "Group": { ... },
    "Code": { ... },
    "Creative": { ... }
  }
}
```

### 3.3 TagMemo "浪潮" 算法 (V3.7)

**核心文件**:
- [KnowledgeBaseManager.js](VCPToolBox/KnowledgeBaseManager.js)
- [EPAModule.js](VCPToolBox/EPAModule.js)
- [ResidualPyramid.js](VCPToolBox/ResidualPyramid.js)

#### 四阶段工作流

| 阶段 | 说明 |
|------|------|
| **感应 (Sensing)** | 净化处理、EPA 投影、计算逻辑深度和共振值 |
| **分解 (Decomposition)** | 残差金字塔迭代分解、能量阈值截断 (90%) |
| **扩张 (Expansion)** | 核心标签补全、关联词拉回、特权过滤 |
| **重塑 (Reshaping)** | 动态参数计算、向量融合、语义去重 |

#### 核心标签 vs 普通标签

| 特性 | 核心标签 (Core Tags) | 普通标签 (Other Tags) |
|------|---------------------|----------------------|
| **产生方式** | 显式指定或首轮强感应 | 残差金字塔逐层剥离 |
| **缺失处理** | **虚拟补全**（强行捞取） | 自动忽略 |
| **权重待遇** | **Core Boost** (1.2x-1.4x) | 原始贡献权重 |
| **噪音过滤** | **完全豁免** | 严格门控筛选 |

### 3.4 多索引架构

```
VectorStore/
├── knowledge_base.sqlite        # SQLite 主数据库
│   ├── files                    # 文件元数据
│   ├── chunks                   # 文本块 + 向量
│   ├── tags                     # 标签 + 向量
│   └── file_tags                # 文件-标签关联
├── index_global_tags.usearch    # 全局 Tag 索引 (50,000 向量)
└── index_diary_{md5hash}.usearch # 各日记本独立索引
```

#### 双索引系统

| 索引 | 类型 | 说明 |
|------|------|------|
| **diaryIndices** | Map<diaryName, VexusIndex> | 每个日记本独立的向量索引 |
| **tagIndex** | VexusIndex | 全局标签索引，容量 50,000 |

### 3.5 EPA 模块 (Embedding Projection Analysis)

**职责**: 语义空间初步定位

**核心指标**:
- **逻辑深度**: 通过投影熵值判断用户意图聚焦程度
- **世界观门控**: 识别当前对话的语义维度
- **跨域共振**: 检测是否同时触及多个正交语义轴

**算法**: K-Means 聚类 + 加权 SVD 分解

### 3.6 残差金字塔 (Residual Pyramid)

**职责**: 语义能量的精细拆解

**核心功能**:
- 多级剥离：Gram-Schmidt 正交化投影
- 微弱信号捕获：递归搜索残差向量
- 相干性分析：评估召回标签一致性

---

## 四、变量系统

VCP 使用四类自定义变量注入记忆：

| 变量类型 | 格式 | 示例 |
|----------|------|------|
| Agent 变量 | `{{Agent*}}` | `{{VarTimelineNova}}` |
| Target 变量 | `{{Tar*}}` | `{{TarEmojiPrompt}}` |
| 变量 | `{{Var*}}` | `{{VarUser}}`, `{{VarSystemInfo}}` |
| 系统变量 | `{{Sar*}}` | `{{SarSystem}}` |

---

## 五、上下文管理

### 5.1 contextManager.js

**作用**: 处理 VCP 特有的 `contextTokenLimit` 参数，控制上下文长度

**修剪规则**:
1. 系统提示词必须保留
2. 以 `[系统提示:]` 开头的 User 消息必须保留
3. 最后两组 AI/User 对话必须保留

```javascript
// modules/contextManager.js
function pruneMessages(messages, limit) {
    // 1. 保留 system 消息
    // 2. 保留 [系统提示:] 开头的 user 消息
    // 3. 保留最后两条消息
    // 4. 从前往后删除其他消息直到满足限制
}
```

---

## 六、RAGDiaryPlugin 记忆插件

**核心文件**: [Plugin/RAGDiaryPlugin/](VCPToolBox/Plugin/RAGDiaryPlugin/)

**功能**:
- 语义分组
- 向量管理
- 元思考系统
- 日记标签批处理

---

## 七、记忆检索语法

在 Agent 配置中使用特殊的检索语法：

| 语法 | 说明 |
|------|------|
| `[[日记本名::Time]]` | 按时间排序 |
| `[[日记本名::Group]]` | 按语义分组 |
| `[[日记本名::TagMemo0.65]]` | TagMemo 检索，阈值 0.65 |
| `[[日记本名::Rerank::TagMemo0.55]]` | TagMemo + Rerank 重排序 |
| `<<日记本名>>` | 直接引用日记本内容 |

---

## 八、总结

VCP Agent 的记忆系统是一个**多层次、向量化的智能记忆系统**，其特点：

1. **双索引架构**: 日记本独立索引 + 全局标签索引
2. **TagMemo 浪潮算法**: 模拟物理引力的语义检索
3. **EPA 模块**: 语义空间定位与逻辑深度分析
4. **残差金字塔**: 语义能量的精细拆解
5. **元思考系统**: 多阶段递归推理能力
6. **变量注入**: 灵活的动态提示词组装

这套系统让 AI Agent 能够：
- 长期记忆用户交互历史
- 按语义检索相关记忆
- 多维度分析用户意图
- 支持 Agent 间信息共享

---

*文档生成时间: 2026-03-22*