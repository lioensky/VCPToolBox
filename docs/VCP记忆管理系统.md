# VCP 记忆管理系统

> 本文面向 VCPToolBox 使用者、Agent 配置者和插件开发者，说明当前记忆系统的分层、写入方式、检索入口、占位符语法与部署边界。
>
> 最后核对日期：2026-07-13。记忆系统仍在持续迭代；涉及实现细节时，应以当前源码、插件清单和专项文档为准，不应仅依据历史知识切片或旧版 README。

---

## 1. 文档定位与事实来源

VCP 的“记忆”不是单一插件，而是由多种时间尺度、数据来源和检索方式组成的系统：

- 日记文件负责持久化 Agent 的经历、项目进展和结构化知识。
- RAGDiaryPlugin 负责把相关日记片段自动注入模型上下文。
- KnowledgeBaseManager 负责热记忆的文件监听、切片、向量索引、Tag 索引和检索。
- TDB 冷知识库负责百科、手册、论文和大型静态资料。
- LightMemo、DeepMemo、TopicMemo 等工具允许 Agent 主动发起回忆。
- OneRing 与 OneRingMemo 负责跨窗口、跨前端的近期连续性。
- VCPTimeLine 负责月级到多年级的长期阶段概览。
- AgentDream 提供可选的离线联想和记忆重构流程。

本文采用以下状态定义：

| 状态 | 含义 |
|---|---|
| 默认启用 | 仓库当前存在有效插件清单，满足配置后会由主服务加载 |
| 可选启用 | 功能实现完整，但以 `.json.block` 等开关形态分发，需要用户配置后手动启用 |
| 外部/分布式 | 工具协议由 VCPToolBox 使用，但实现可能位于 VCPChat、分布式节点或配套前端 |
| 历史名称 | 旧文档或旧知识切片中的名称，当前不应再用于新配置 |

专项资料：

- 系统架构概览：[`MEMORY_SYSTEM.md`](MEMORY_SYSTEM.md)
- TagMemo 浪潮算法：[`TagMemo_Wave_Algorithm_Deep_Dive.md`](TagMemo_Wave_Algorithm_Deep_Dive.md)
- TagMemo 调参：[`TAGMEMO_TUNING_GUIDE.md`](TAGMEMO_TUNING_GUIDE.md)
- ContextBridge：[`CONTEXT_BRIDGE.md`](CONTEXT_BRIDGE.md)
- Rust 向量引擎：[`RUST_VECTOR_ENGINE.md`](RUST_VECTOR_ENGINE.md)
- TDB 冷知识库：[`TDB_COLD_KNOWLEDGE_BASE.md`](TDB_COLD_KNOWLEDGE_BASE.md)
- 配置参数：[`CONFIGURATION.md`](CONFIGURATION.md)
- 运维排障：[`OPERATIONS.md`](OPERATIONS.md)

---

## 2. 记忆层级总览

| 记忆层 | 典型时间尺度 | 数据来源 | 主要入口 | 核心用途 |
|---|---:|---|---|---|
| 当前聊天窗口 | 当前会话 | 请求上下文 | 原生消息 | 保留正在进行的对话 |
| OneRing | 跨窗口的近期原始消息 | OneRing SQLite | `[[OneRing::Agent::Frontend]]` | 补齐跨端近期上下文 |
| OneRingMemo | 1–7 天 | OneRing 消息摘要 | `[[OneRingMemo::Agent]]` | 压缩近期客观事件线 |
| VCPTimeLine | 月至多年 | 日记月度归纳 | `[[VCPTimeLine::Agent]]` | 长期阶段概览与按月展开 |
| 热记忆日记 | 长期或永久 | `dailynote/` | RAG 占位符、LightMemo | 经历、关系、反思、项目状态 |
| 冷知识库 | 长期稳定资料 | `knowledge/` | 知识库占位符、LightMemo | 百科、手册、论文、规范 |
| 历史聊天库 | 长期聊天历史 | VCPChat/分布式侧 | DeepMemo、TopicMemo | 精确回查原始聊天和话题 |

推荐原则：

1. 当前窗口保存正在发生的原始对话。
2. OneRing 系列负责短期连续性，不替代永久记忆。
3. VCPTimeLine 负责长期阶段认知，不替代具体事实。
4. 日记 RAG 负责按当前语义召回细粒度记忆。
5. TDB 负责事实型冷知识，不参与热记忆的 TagMemo 联想。
6. DeepMemo 与 TopicMemo 负责回查聊天信源，不等同于日记检索。

---

## 3. 创建、更新与整理日记

### 3.1 DailyNote：统一创建和更新入口

当前日记写入插件名称为 `DailyNote`，同时提供：

- `create`：创建新日记。
- `update`：通过旧内容定位并替换已有日记中的文本。

旧文档中的 `DailyNoteWrite`、`DailyNoteEdit` 可视为历史称呼或旧部署名称。新配置应以当前插件清单中的 `DailyNote` 为准。

创建示例：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」DailyNote「末」,
command:「始」create「末」,
folder:「始」小克的知识「末」,
maid:「始」小克「末」,
Date:「始」2026-07-13「末」,
fileName:「始」记忆系统修订「末」,
Content:「始」今天完成了记忆系统文档的结构化修订。
Tag: VCP, 记忆系统, 文档维护「末」
<<<[END_TOOL_REQUEST]>>>
```

仍兼容旧式目录语法：

```text
maid:「始」[VCP开发]小克「末」
```

但新调用更推荐把目录放在独立的 `folder` 参数中，让 `maid` 只表达作者。

更新示例：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」DailyNote「末」,
command:「始」update「末」,
folder:「始」VCP开发「末」,
maid:「始」小克「末」,
target:「始」这是需要定位的旧内容，长度至少十五个字符。「末」,
replace:「始」这是修订后的新内容。「末」
<<<[END_TOOL_REQUEST]>>>
```

### 3.2 推荐日记格式

建议每篇日记至少包含：

1. 日期或时间戳。
2. 作者署名。
3. 可独立理解的事件、状态或知识正文。
4. 最后一行稳定、简洁的 `Tag:`。

示例：

```markdown
[2026-07-13] - 小克

完成 VCP 记忆管理文档重构，统一了热记忆、冷知识库、主动回忆和时间线系统的边界。

Tag: VCP, 记忆系统, 文档维护
```

Tag 会参与热记忆索引与 TagMemo 拓扑。避免：

- 使用大量同义 Tag 堆砌。
- 把整句话当作 Tag。
- 在同一概念上反复切换大小写和近义名称。
- 删除 Timeline 等派生文档末尾已有的 Tag 行。

### 3.3 DailyNoteManager：批量整理

`DailyNoteManager` 是现行混合服务插件，提供：

| 命令 | 作用 |
|---|---|
| `list` | 按文件夹和日期范围列出日记及其 URL |
| `organize` | 合并多篇日记并把原文件归档到“已整理”目录 |
| `associate` | 以一篇或多篇日记为种子发现关联日记 |

整理属于高影响操作。执行前应阅读源日记，并确认目标文件夹、合并正文和归档范围。对于大批量整理，建议由专门的记忆管理 Agent 操作并保留人工复核。

### 3.4 多模态附件

日记正文可以记录受支持的 HTTP、HTTPS、`file://` 或 VCP 文件资源。是否能在后续召回时作为多模态内容注入，取决于：

- 资源路径在当前部署中是否可访问。
- 文件类型是否受多模态处理链支持。
- 是否启用了 `::Base64Memo`。
- 当前模型是否支持对应模态。
- 附件数量和大小是否超过配置限制。

文本索引与附件本体是不同层次。附件链接出现在日记中，不意味着所有附件内容都会自动作为文本向量参与每次检索。

---

## 4. 被动记忆：四种日记本占位符

RAGDiaryPlugin 支持四类日记本入口。选择入口时，先确定两个问题：

1. 是否需要相似度门控？
2. 需要文件全文，还是 RAG 片段？

| 语法 | 是否门控 | 返回内容 | 是否进入 RAG 管线 |
|---|---:|---|---:|
| `{{角色日记本}}` | 否 | 文件全文 | 否 |
| `<<角色日记本>>` | 是 | 文件全文 | 门控后走纯文本管线 |
| `[[角色日记本]]` | 否 | 相关片段 | 是 |
| `《《角色日记本》》` | 是 | 相关片段 | 门控通过后进入 |

### 4.1 `{{角色日记本}}`：无条件纯文本引入

默认读取该日记本的全部可用文本，不调用 Embedding，也不执行向量检索。

常用后缀：

```text
{{小克日记本::Last}}
{{小克日记本::Last5}}
{{小克日记本::Random3}}
{{小克日记本::BM25::Last30}}
{{小克日记本::BM25+::Last30}}
```

含义：

- `::LastN`：按文件系统修改时间读取最近 N 个文件；省略 N 时默认 10。
- `::RandomN`：随机读取 N 个文件；省略 N 时默认 1。
- `::BM25`：在候选文件的 Tag 行上进行 BM25 匹配。
- `::BM25+`：在候选文件正文上进行 BM25 匹配。
- BM25 未命中或查询为空时，回退为最近文件读取。
- BM25 未指定 `::LastN` 时，默认候选范围为最近 10 个文件。

该模式适合小日记本、最新进度、随机灵感或明确需要全文的场景。大日记本不应无条件全量注入。

### 4.2 `<<角色日记本>>`：门控后的纯文本引入

`<<>>` 先计算当前上下文与日记本主题的相似度。门控通过后，复用 `{{}}` 的纯文本读取能力：

```text
<<VCP开发进度日记本::Last10>>
<<音乐列表日记本::Random3>>
<<小克日记本::BM25+::Last50>>
```

因此：

- `<<>>` 负责“是否加载”。
- `{{}}` 纯文本管线负责“加载哪些文件”。
- 返回结果仍是文件全文，不是 RAG chunk。

### 4.3 `[[角色日记本]]`：无条件 RAG 片段检索

该入口不做日记本主题门控，只要占位符存在就执行检索：

```text
[[小克日记本]]
[[小克日记本:1.5]]
[[小克日记本::TagMemo+::Rerank+::Truncate0.4]]
```

冒号后的数字是动态 K 倍率，不是固定返回条数。最终数量还受动态 K、去重、截断、展开和联想等步骤影响。

### 4.4 `《《角色日记本》》`：门控后的 RAG 片段检索

该入口先执行主题相关性门控，达标后进入与 `[[]]` 相同的 RAG 片段管线：

```text
《《小克日记本::TagMemo+::Rerank+::Truncate0.4》》
```

适合长期挂载的大型日记本。它能减少无关检索和上下文污染，但门控阈值过高也可能造成漏召回。

### 4.5 聚合检索

使用 `|` 可以声明多个日记本：

```text
[[物理|政治|历史日记本:1.2::TagMemo+::Rerank+]]
《《项目A|项目B|公共日记本::Associate::Truncate0.4》》
```

当前聚合模型是请求级虚拟联合索引：

1. 每个物理日记本保持独立索引。
2. 当前请求并行查询成员索引。
3. 候选合并后执行全局去重、排序和后处理。
4. 所有成员共享一个全局 K，不按日记本预留配额。
5. 不创建组合索引，不复制底层向量。

在 `《《》》` 聚合模式下，主题门控只决定是否检索，不负责给各成员分配名额。

---

## 5. RAG 修饰符

### 5.1 兼容性总表

| 修饰符 | `{{}}` | `<<>>` | `[[]]` | `《《》》` | 热日记 | TDB 冷知识库占位符 |
|---|---:|---:|---:|---:|---:|---:|
| `::LastN` | ✅ | ✅ | — | — | ✅ | — |
| `::RandomN` | ✅ | ✅ | — | — | ✅ | — |
| `::BM25` / `::BM25+` | ✅ 全文筛选 | ✅ 门控后全文筛选 | ✅ 稀疏候选 | ✅ 门控后稀疏候选 | ✅ | ✅，均作用于 chunk 正文 |
| `::RoleValve` | ✅ | ✅ | ✅ | ✅ | ✅ | 以具体处理器支持为准 |
| `::Time` | — | — | ✅ | ✅ | ✅ | — |
| `::Group` | — | — | ✅ | ✅ | ✅ | — |
| `::TagMemo` / `::TagMemo+` | — | — | ✅ | ✅ | ✅ | — |
| `::Rerank` / `::Rerank+` | — | — | ✅ | ✅ | ✅ | ✅ |
| `::TimeDecay` | — | — | ✅ | ✅ | ✅ | — |
| `::TruncateX` | — | — | ✅ | ✅ | ✅ | ✅ |
| `::Expand` | — | — | ✅ | ✅ | ✅ | ✅ |
| `::Associate` | — | — | ✅ | ✅ | ✅ | — |
| `::Base64Memo` | — | — | ✅ | ✅ | ✅ | — |
| `::AIMemo` / `::AIMemo+` | — | — | ✅ | ✅ | 热日记专用 | — |

“—”表示不应依赖该组合。未知修饰符可能被忽略，而不是报错，因此不能通过“没有报错”判断功能已生效。

### 5.2 BM25 与 BM25+

在纯文本入口：

- `::BM25` 匹配日记底部 Tag 行并注入命中文件全文。
- `::BM25+` 匹配日记正文并注入命中文件全文。

在热记忆 RAG 入口：

- 两者作为稀疏召回分支，与向量候选融合。
- `::BM250.4` 表示 BM25 分数权重约为 0.4。
- `::BM25+0.7` 表示正文 BM25+ 分数权重约为 0.7。
- 不写数字时使用实现中的默认融合权重。

在 TDB 冷知识库中没有“日记 Tag 行”语义，因此 `::BM25` 和 `::BM25+` 都作用于 chunk 全文检索。

### 5.3 RoleValve

RoleValve 根据当前上下文中不同角色的消息数量决定是否加载：

```text
[[专业技术日记本::RoleValve@User>3]]
《《背景资料日记本::RoleValve@Assistant<5》》
[[高密度知识日记本::RoleValve@User>=2&@Assistant>=2]]
```

支持：

- 角色：`@User`、`@Assistant`、`@System`
- 运算符：`>`、`<`、`>=`、`<=`
- 逻辑连接：`&`、`|`

条件不成立时，占位符被清空，不执行后续检索。

### 5.4 Time

`::Time` 用于解析“上周”“三个月前”“去年冬天”等自然语言时间表达，并融合语义召回与时间范围召回：

```text
[[小克日记本::Time]]
[[小克日记本::Time0.3::Rerank]]
```

数字表示时间路召回比例；不写数字时使用默认比例。新对话起点还可以补充少量最近连续性记忆。

### 5.5 Group 与 SemanticGroupEditor

`::Group` 使用预先配置的语义词元组增强查询：

```text
[[角色日记本::Group]]
[[角色日记本:1.5::Group]]
```

词元组的现行管理插件名称是 `SemanticGroupEditor`，不是旧文档中的 `SGManager`。它提供：

- `QueryGroups`：查询现有语义组。
- `UpdateGroups`：创建或更新语义组。

语义组适合维护黑话、项目术语、事件链和逻辑相关但向量距离较远的概念。

### 5.6 TagMemo 与 TagMemo+

```text
[[角色日记本::TagMemo]]
[[角色日记本::TagMemo0.3]]
[[角色日记本::TagMemo+]]
[[角色日记本::TagMemo+0.3]]
```

- `::TagMemo`：使用 Tag 共现拓扑和浪潮增强查询向量。
- `::TagMemo+`：在 TagMemo 基础上，对候选执行测地线重排。
- 数字用于指定 TagMemo 权重；省略时由系统动态计算。
- TagMemo 只属于热记忆体系，不用于 TDB 冷知识库。

完整算法、LIF 脉冲传播和能量场说明见 [`TagMemo_Wave_Algorithm_Deep_Dive.md`](TagMemo_Wave_Algorithm_Deep_Dive.md)。

### 5.7 Rerank 与 Rerank+

```text
[[角色日记本::Rerank]]
[[角色日记本::Rerank+]]
[[角色日记本::Rerank+0.7]]
```

- `::Rerank`：使用外部 Reranker 对候选重新排序。
- `::Rerank+`：使用 RRF 融合原检索排名与 Reranker 排名。
- `::Rerank+0.7`：提高 Reranker 排名在融合中的权重。
- 未配置 Rerank 服务或请求失败时，系统会保留原检索结果作为回退。

### 5.8 TimeDecay

```text
[[项目进度日记本::TimeDecay]]
[[项目进度日记本::TimeDecay30/0.5/动态进展]]
```

TimeDecay 对较旧结果执行分数衰减，不等同于时间范围硬过滤。它适合项目进度、游戏进度等“近期状态更重要”的记忆，不适合对永久设定无差别衰减。

### 5.9 Truncate

```text
[[知识日记本::Truncate0.45]]
《《项目日记本::Rerank+::Truncate0.4》》
```

Truncate 按后处理阶段的最终分数执行硬过滤。阈值含义取决于此前是否使用了向量分数、Rerank、RRF、TagMemo+ 或 TimeDecay，因此不同管线中的阈值不能机械横向比较。

### 5.10 Expand

```text
[[技术文档日记本::Expand]]
[[技术文档日记本::Truncate0.5::Expand]]
```

命中一个 chunk 后，Expand 会读取其父文件全文，并按文件路径去重。适合 API 手册和长文档，但可能显著增加上下文长度。

`{{}}` 和 `<<>>` 本身已经返回全文，不需要 Expand。

### 5.11 Associate

```text
[[角色日记本::Associate]]
[[物理|哲学|历史日记本::TagMemo+::Associate]]
```

Associate 把主召回结果作为种子，在同一检索范围内寻找被多个种子共同指向的候选，并把共现结果追加到主结果后。

至少需要两个有效种子。聚合模式下，联想发生在同一个虚拟联合范围中。

### 5.12 Base64Memo

```text
[[角色日记本::Base64Memo]]
《《项目资料日记本::Base64Memo::Rerank》》
```

Base64Memo 从召回文本中提取受支持附件，经过过滤和数量限制后注入多模态消息。应控制附件数量、文件大小和上下文预算，并避免把不可信远程资源直接作为模型输入。

### 5.13 AIMemo 与 AIMemo+

```text
[[角色日记本::AIMemo]]
[[角色日记本::AIMemo+::Time::TagMemo+::Rerank+]]
```

两者均需要系统提示词中的 AIMemo 许可开关；未授权时回退为标准 RAG。

| 模式 | 候选来源 | 适用场景 |
|---|---|---|
| `::AIMemo` | 整本日记内容，必要时分批 | 中小型日记本，需要模型通读 |
| `::AIMemo+` | 先执行 RAG 后缀管线，再把约 5×K 候选交给模型总结 | 大型日记本或聚合检索 |

AIMemo+ 可以继承 Time、Group、TagMemo、Rerank、TimeDecay、Truncate、Associate 和 Expand 等热记忆后缀。它不应用于 TDB 冷知识库占位符。

---

## 6. 冷知识库占位符

冷知识库资料位于 `knowledge/`，由 TDBKnowledgeManager 管理。它与 `dailynote/` 热记忆平行运行。

支持两类入口：

```text
[[VCP开发文档知识库]]
《《业务规则知识库》》
[[产品文档|运维手册|接口规范知识库::Rerank+::Truncate0.4]]
```

- `[[]]`：直接检索。
- `《《》》`：主题门控后检索。
- `|`：联合多个冷知识库。
- 不支持冷知识库的 `{{}}` 或 `<<>>` 全文入口。

推荐修饰符：

```text
::BM25
::BM25+
::Rerank
::Rerank+0.7
::Truncate0.4
::Expand
:1.2
```

重要边界：

- TDB 使用 BM25、向量和图扩散等冷知识检索机制。
- TDB 不进入日记 TagMemo 共现拓扑。
- `::TagMemo`、`::TagMemo+`、`::Time`、`::Associate` 和 `::AIMemo+` 不属于 TDB 占位符管线。
- 冷知识库的 `::BM25` 与 `::BM25+` 都匹配 chunk 正文。
- 如果 TDBKnowledgeManager 未启用，知识库占位符会被清理，避免原始语法泄露给模型。

---

## 7. 主动回忆工具

### 7.1 LightMemo

LightMemo 是主仓中的现行主动检索插件，支持热日记与 TDB 冷知识库路由。

热记忆示例：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」LightMemo「末」,
folder:「始」VCP开发「末」,
maid:「始」小克「末」,
query:「始」[2026-06-01~2026-07-13] 记忆系统重构进展「末」,
k:「始」5「末」,
BM25:「始」true「末」,
tag_boost:「始」0.6+「末」,
rerank:「始」rrf0.7「末」
<<<[END_TOOL_REQUEST]>>>
```

冷知识库示例：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」LightMemo「末」,
query:「始」[知识库:VCP知识] ContextBridge 如何共享检索能力「末」,
k:「始」5「末」,
rerank:「始」rrf0.7「末」
<<<[END_TOOL_REQUEST]>>>
```

冷知识路由中，`tag_boost`、`maid`、`folder` 和日记时间范围不会生效。

### 7.2 DeepMemo

DeepMemo 用于检索 VCPChat 历史聊天数据库，通常由 VCPChat 或分布式工具节点提供，而不是由主仓本地 `Plugin/` 目录承载。

它使用 Rust/Tantivy 关键词召回并可叠加 Reranker。常见查询语法包括：

```text
普通词: VCP
精确短语: "VCP服务器"
正向权重: (重要概念:1.5)
负向排除: [闲聊]
OR 逻辑: {bug|修复|问题:1.3}
时间条件: @2026-6 或 @30d
```

调用 DeepMemo 前，应确认当前前端或分布式节点已注册该工具。工具清单中出现调用说明，不代表所有部署都自动拥有其运行端。

### 7.3 TopicMemo

TopicMemo 是 VCPChat 话题级历史工具，可列出话题、读取话题内容，并在支持的部署中编辑安全字段。其实现通常位于 VCPChat/配套前端或分布式插件侧。

TopicMemo 适合：

- 按话题 ID 精确阅读完整聊天。
- 在 LightMemo 或 DeepMemo 找到线索后回到原始话题信源。
- 管理话题标题或受控内容字段。

它不是日记向量检索器，也不应与 TDB 冷知识库混为一谈。

### 7.4 MeshMemo 迁移说明

MeshMemo 已不再作为独立插件存在。其多条件过滤和多范围搜索能力已并入 LightMemo 等现行检索入口。

旧提示词、知识切片或 Agent 配置中若仍引用 `MeshMemo`，应迁移为：

- LightMemo 的 `maid`、`folder`、时间范围和全库搜索参数。
- 日记占位符的聚合检索与修饰符组合。
- 必要时使用 DailyNoteSearcher 做文本、正则或 BM25 搜索。

不要再把 DeepMemo、LightMemo、MeshMemo 描述为现行“三位一体”插件结构。

### 7.5 SemanticGroupEditor

旧文档中的 `SGManager` 名称不准确。现行插件为 `SemanticGroupEditor`，负责查询、创建和更新语义词元组。它管理的是检索增强配置，不直接返回日记搜索结果。

---

## 8. 热记忆底层架构

KnowledgeBaseManager 负责 `dailynote/` 热记忆：

1. 监听 `.txt` 和 `.md` 文件增删改。
2. 计算文件校验信息并执行差分更新。
3. 把文本切分为 chunk。
4. 调用 Embedding 服务生成向量。
5. 把文件、chunk、Tag 和关联关系写入 SQLite。
6. 更新 Rust Vexus/USearch 索引。
7. 构建 Tag 共现关系，供 TagMemo 使用。
8. 按需加载和卸载日记本索引。

核心存储包括：

- SQLite：文件元数据、chunk、向量、Tag、文件与 Tag 关联、缓存。
- 每日记本独立向量索引。
- 全局 Tag 向量索引。
- 文件系统中的原始日记。

修改文件后，文件写入与索引更新之间存在短暂异步窗口。刚保存的内容不一定能在同一瞬间被检索到；验证时应观察服务器日志，确认批处理和索引更新完成。

性能数据依赖：

- Embedding 维度和模型。
- 索引规模。
- K 值和候选倍率。
- 是否启用 TagMemo、Rerank、Associate、Expand。
- CPU、内存、磁盘和原生模块构建方式。

因此本文不承诺脱离测试条件的固定延迟、固定召回率或“修改一个字只重算一句”等绝对结论。

---

## 9. OneRing 与 OneRingMemo

### 9.1 OneRing

OneRing 为每个 Agent 维护独立 SQLite 消息账本，记录：

- user / assistant 角色。
- 实际发送者。
- 前端来源。
- 时间戳。
- 消息正文和上下文锚点。

启用语法：

```text
[[OneRing::小克::VCPChat]]
```

Only 模式：

```text
[[OneRing::小克::VCPChat::Only]]
```

或：

```text
[[OneRing::小克::VCPChat]]
[[OneRing::Only]]
```

Only 模式继续入库和标记消息，但不执行跨端上下文追加。

OneRing 的原则是保守合并：无法可靠确定时间位置或消息对应关系时，宁可不补充，也不把历史消息插入错误楼层。

### 9.2 OneRingMemo

OneRingMemo 将近期 OneRing 消息压缩成 1–7 天级客观时间线：

```text
[[OneRingMemo::小克]]
```

摘要要求：

- 记录实际事件、操作、结果和状态变化。
- 对推测只记录“谁表达了什么”，不升级为事实。
- 不替主 Agent 生成价值判断、人格结论或策略建议。
- 不生成承诺清单和未经输入支持的待办事项。

摘要生成与聊天请求解耦。生成期间继续使用上一份完整摘要；只有新任务全部成功后才原子替换旧摘要。

OneRingMemo 不应承担永久知识库职责。重要关系、规则、项目结论和专业知识仍应写入日记或冷知识库。

---

## 10. VCPTimeLine：月级长期时间线

VCPTimeLine 从 `dailynote/` 中按 Agent、作者和月份归纳日记，生成：

```text
dailynote/<Agent>timeline/YYYY-MM.md
```

每个月包含：

- 完整月度 Timeline Markdown。
- 单独保存的一句话月摘要。
- 可供热记忆索引提取的稳定 Tag 行。

注入语法：

```text
[[VCPTimeLine::小克]]
[[VCPTimeLine::小克:3]]
[[VCPTimeLine::小克:0.5]]
[[VCPTimeLine::小克:3:0.5]]
```

参数含义：

| 参数 | 含义 |
|---|---|
| 无参数 | 使用管理面板默认 K 和阈值 |
| 单个整数 `>=1` | 最大展开月份数 K |
| 单个 `0.01–0.99` 小数 | 最低相关度阈值 |
| 两个数字 | K 和最低阈值 |

默认注入包括：

1. 全部已有月份的一句话摘要。
2. 根据当前对话检索相关月份。
3. 对命中 chunk 按月份去重。
4. 展开最多 K 篇完整月度 Timeline。

VCPTimeLine 通过 ContextBridge 复用 RAGDiaryPlugin 和 KnowledgeBaseManager 的检索能力。TagMemo 不可用时会降级为普通向量搜索。

使用建议：

- 每月结束或阶段复盘时生成完整 Timeline。
- 生成后等待向量和 Tag 索引完成，再验证召回。
- K 通常设为 1–3。
- Timeline 是归纳层，不是唯一事实来源。
- 人工编辑时保留末尾 Tag 行。

---

## 11. AgentDream：可选梦系统

AgentDream 具有完整的梦境生成、记忆浪潮、定时调度和手动触发实现，但当前以 `plugin-manifest.json.block` 形式分发，表示默认关闭、由用户按需启用，不表示代码已删除。

启用前应：

1. 阅读根目录的 [`../AgentDream.md`](../AgentDream.md)。
2. 检查插件级 `config.env.example` 并创建实际配置。
3. 配置可做梦 Agent、模型、时间窗口、频率和概率。
4. 确认 KnowledgeBaseManager、DailyNote 与相关依赖可用。
5. 将 `.json.block` 重命名为有效插件清单后重启服务。
6. 观察日志确认 DreamWaveEngine 和调度器初始化成功。

AgentDream 的核心流程：

1. 从近期、中期和深层记忆中构建梦境种子。
2. 使用 TagMemo/梦浪潮发现关联记忆。
3. 调用配置的模型生成梦境叙事。
4. 记录梦日志并广播状态。
5. 可生成合并、删除或感悟操作建议。

安全边界：

- 梦操作应经过人工审批，不应让模型直接执行不可逆删除。
- 当前实现中部分审批导出接口仍可能处于预留状态，应以实际管理面板和路由能力为准。
- 默认关闭是合理的部署开关，因为自动调度会消耗模型额度并对记忆内容产生影响。
- 历史知识切片中“暂时下线”的描述反映旧阶段状态，不代表当前代码不存在或不可按需启用。

---

## 12. 提示词收纳箱与静态折叠

ToolboxManager 通过语义折叠减少大型工具说明对上下文的占用。常见占位符：

```text
{{VCPFileToolBox}}
{{VCPMemoToolBox}}
{{VCPMediaToolBox}}
{{VCPSearchToolBox}}
```

收纳箱文件使用 `vcp_fold` 区块：

```text
[===vcp_fold: 0.0===]
常驻基础说明。

[===vcp_fold: 0.35 ::desc: 日记、回忆、知识库检索===]
记忆工具详细说明。
```

静态插件折叠控制：

```text
[[VCPStaticFold::Auto]]
[[VCPStaticFold::Lite]]
[[VCPStaticFold::Full]]
```

- Auto：按语义动态展开，可能调用 Embedding。
- Lite：只展开最低阈值可见块，不做语义向量判定。
- Full：展开全部静态折叠块，不做语义向量判定。

该开关只控制静态插件返回的动态折叠内容，不改变 RAGDiaryPlugin 的日记或知识库检索行为。

---

## 13. 推荐配置

### 13.1 通用长期 Agent

```text
[[OneRing::小克::VCPChat]]
[[OneRingMemo::小克]]
[[VCPTimeLine::小克:2:0.5]]
《《小克日记本::TagMemo+::Rerank+::Truncate0.4》》
```

职责：

- OneRing：近期原始消息连续性。
- OneRingMemo：最近数日客观摘要。
- VCPTimeLine：长期月份概览。
- 日记 RAG：具体事实和长期记忆。

### 13.2 专业知识 Agent

```text
《《项目经验日记本::TagMemo+::Rerank+::Truncate0.45》》
《《产品文档|接口规范|运维手册知识库::Rerank+::Truncate0.4》》
```

热日记用于经验、判断和项目历史；冷知识库用于稳定文档和事实资料。

### 13.3 低成本日常聊天

```text
[[OneRingMemo::小克]]
[[VCPTimeLine::小克:1:0.55]]
<<小克日记本::BM25::Last20>>
```

该组合减少持续向量检索和大规模全文注入，但 `<<>>` 的前置主题门控仍需要上下文相似度判断。

### 13.4 明确任务中的主动回忆

当 Agent 已经知道需要查什么时，优先主动调用：

- 查日记与知识库：LightMemo。
- 查历史聊天片段：DeepMemo。
- 回到完整话题信源：TopicMemo。
- 整理日记：DailyNoteManager。
- 管理语义词元组：SemanticGroupEditor。

不要为所有 Agent 同时挂载所有被动入口和所有主动工具说明。可通过 MemoToolBox 和语义折叠按需暴露。

---

## 14. 运维与排障

### 14.1 修改后检索不到

依次检查：

1. 文件是否位于正确的 `dailynote/` 或 `knowledge/` 一级目录。
2. 扩展名是否受监听器支持。
3. 文件是否被忽略目录、前缀或后缀规则排除。
4. Embedding 服务是否可用。
5. 向量维度是否与索引一致。
6. 日志是否显示文件批处理完成。
7. 日记本名称或冷知识库名称是否完全匹配。
8. 门控、RoleValve 或 Truncate 是否把结果过滤掉。

### 14.2 TagMemo 效果异常

检查：

- 日记末尾是否存在规范 Tag。
- Tag 是否过于泛化或碎片化。
- `TAG_BLACKLIST` 是否屏蔽了关键词。
- 当前检索是否确实走热记忆，而不是 TDB。
- `::TagMemo+` 权重和测地线参数是否过高。
- 聚合范围是否包含大量不相关日记本。

### 14.3 Rerank 没有生效

检查：

- Rerank URL、密钥和模型是否配置。
- 服务是否兼容预期的 `/v1/rerank` 格式。
- 请求是否超时或分批失败。
- 日志是否显示回退到原始检索分数。

### 14.4 占位符残留

正常情况下，未命中、未启用或被门控拦截的占位符应被清空。若原始占位符泄露给模型，检查：

- RAGDiaryPlugin 是否已加载。
- 占位符是否位于插件会扫描的顶层 System Prompt。
- 中文书名号和方括号是否成对。
- 插件执行顺序是否被修改。
- 冷知识库管理器是否注入成功。

### 14.5 上下文过长

优先采取：

1. 把 `{{全部日记}}` 改为 `::LastN`、BM25 或 RAG。
2. 用 `《《》》` 代替无门控 `[[]]`。
3. 降低 K 倍率。
4. 提高 Truncate 阈值。
5. 谨慎使用 Expand、Associate 和 Base64Memo。
6. 用 VCPTimeLine 摘要替代长期全量日记注入。
7. 使用 ToolboxManager 折叠工具说明。

---

## 15. 历史名称与迁移表

| 旧名称或旧说法 | 当前处理 |
|---|---|
| DailyNoteWrite | 新配置使用 `DailyNote create` |
| DailyNoteEdit | 新配置使用 `DailyNote update` |
| SGManager | 更名为 `SemanticGroupEditor` |
| MeshMemo | 独立插件已移除，能力迁移到 LightMemo 等现行入口 |
| VectorDBManager.js | 当前热记忆总控以 `KnowledgeBaseManager.js` 为准 |
| hnswlib-node 主索引 | 当前主线使用 Rust Vexus/USearch 与 SQLite |
| 独立 TimeLine 日记本语法 | 使用 `[[VCPTimeLine::Agent]]` |
| AgentDream 已删除/永久下线 | 不准确；当前为完整实现、默认关闭、可选启用 |
| DeepMemo/TopicMemo 不存在 | 不准确；它们可由 VCPChat或分布式工具侧提供 |
| 冷知识库支持 TagMemo | 不准确；TDB 与热记忆 TagMemo 分层 |
| 固定 99% 召回率或固定亚毫秒性能 | 不作为无条件产品承诺，应以可复现实测为准 |

---

## 16. 管理面板建议

优先使用管理面板完成：

- 查看和编辑日记。
- 管理日记本 Tag 与门控阈值。
- 查看向量化和文件监听状态。
- 管理语义组。
- 配置 OneRing 与 OneRingMemo。
- 生成和编辑 VCPTimeLine。
- 管理冷知识库资料。
- 观察 RAG 检索详情和命中来源。

直接编辑 JSON 或环境变量适合开发与批量部署，但应先备份，并确认字段仍由当前实现消费。不要依据历史文档随意增加未被代码解析的配置项。

---

## 17. 结论

VCP 记忆系统的核心不是把所有历史内容永久塞进上下文，而是按时间尺度和数据性质分层：

- 原始近期交互交给 OneRing。
- 数日摘要交给 OneRingMemo。
- 月级人生与项目阶段交给 VCPTimeLine。
- 长期经历和关联性记忆交给日记 RAG 与 TagMemo。
- 稳定事实资料交给 TDB 冷知识库。
- 精确聊天回查交给 DeepMemo 与 TopicMemo。
- 明确检索任务交给 LightMemo。
- 离线联想与记忆重构可按需启用 AgentDream。

配置时应从最少必要记忆层开始，观察真实召回结果后再增加 TagMemo、Rerank、Associate、Expand 或 AIMemo 等增强能力。这样才能在召回质量、模型成本、上下文长度和可解释性之间保持稳定平衡。
