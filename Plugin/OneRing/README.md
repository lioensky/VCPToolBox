# OneRing 统一上下文系统

OneRing 是 VCPToolBox 中一个实验级、概念级的统一上下文系统。它的目标不是再做一个普通记忆插件，而是为一个唯一 Agent 构建跨前端、跨群聊、跨私聊的统一时间线。

它提出的核心概念是：

> 无论消息来自哪个前端、群聊系统或私聊通道，都归入同一个 Agent 的唯一上下文账本；每条真实 User / Assistant 发言都带有时间、来源对象、前端来源，并在后续请求中以保守方式参与上下文补充。

这是一枚 One Ring：把分散在不同入口的聊天信源汇聚成同一个连续叙事。

---

## 触发语法

OneRing 通过系统提示词中的占位符激活：

```text
[[OneRing::小克::Vchat]]
```

也支持只入库/只标记模式：

```text
[[OneRing::小克::Vchat::Only]]
```

语义：

- `小克`：当前要维护统一上下文的 Agent 名称。
- `Vchat`：当前请求来源前端。
- `Only`：可选模式。启用后不做跨端上下文追加、不做最近历史补齐，只以最终 post 为真相同步同端 DB，并为本次 post 补 OneRing 尾标供 AI 回复 hook 入库。

没有该占位符时，插件直接跳过，不影响任何请求，也不会入库。

检测完成后，OneRing 会把占位符替换为系统可见提示词：

```text
[OneRing系统已启动，当前Agent小克，当前客户端Vchat，所有上下文OneRing信息来源标记由系统生成无需你自动输出。]
```

Only 模式会替换为：

```text
[OneRing系统已启动，当前Agent小克，当前客户端Vchat，当前模式Only，所有上下文OneRing信息来源标记由系统生成无需你自动输出。]
```

替换只发生在完成触发识别之后，不会破坏 OneRing 的实际逻辑。后端会优先通过不可枚举的 `__oneRingMeta` 保存 AgentName / frontendSource；该元数据不会被 `JSON.stringify(messages)` 发送给上游模型。由于后续预处理器可能通过深拷贝丢失不可枚举元数据，替换提示词本身也保留了“当前Agent/当前客户端”字段，供响应 hook 兜底恢复入库目标。

---

## 当前实现形态

OneRing 由三部分组成：

| 文件 | 职责 |
|------|------|
| `OneRing.js` | 主预处理器：触发检测、消息来源判断、用户入库、尾部标记、跨端补充入口、AI 回复入库接口 |
| `OneRingDB.js` | SQLite 操作层：按 Agent 独立建库，记录 User / Assistant 消息 |
| `OneRingFuzzy.js` | 独立 fuzzy diff 模块：内容净化、相似度计算、上下文数组比对 |

预处理器顺序建议为：

```json
[
  "VCPTavern",
  "ImageProcessor",
  "RAGDiaryPlugin",
  "OneRing",
  "ContextFoldingV2"
]
```

其中 `VCPTavern` 和 `ImageProcessor` 在主流程中有特殊提前调用，保留在顺序文件中主要用于表达完整链路。

---

## Agent 隔离与数据库设计

OneRing 的隔离主键来自系统触发语法中的 AgentName：

```text
[[OneRing::小克::Vchat]]
[[OneRing::小吉::Vmobile]]
```

即使两个客户端同时聊天，只要 AgentName 不同，就会写入不同数据库文件：

- `小克` → `Plugin/OneRing/data/小克.db`
- `小吉` → `Plugin/OneRing/data/小吉.db`

因此“小克上下文”和“小吉上下文”不会因为并发请求或不同前端同时在线而混库。frontendSource 只用于同一 Agent 内部的来源标注和跨端补充，不作为跨 Agent 共享边界。

每个 Agent 使用独立 SQLite 数据库：

```text
Plugin/OneRing/data/{AgentName}.db
```

核心表：

```sql
messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agentName TEXT NOT NULL,
  role TEXT NOT NULL,
  senderName TEXT,
  frontendSource TEXT,
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  postContextHash TEXT
)
```

当前记录对象：

- `role=user`：真实用户、群聊成员、AA 通讯来源的发言。
- `role=assistant`：AI 最终回复，由底层响应 handler 异步回调入库。

---

## 消息来源判断

OneRing 的最重要工程点是消息来源判断，而不是复杂记忆算法。

处理顺序：

1. 从 user 块中剥离：

```text
[系统通知] ... [系统通知结束]
```

该块中间允许多行。

2. 如果剩余内容命中以下类型，则丢弃，不入库：

- `[系统提示...]`
- `[系统警告...]`
- `[系统指示...]`
- `by[Vchat群聊]`
- `现在轮到你{{VCPChatAgentName}}发言`
- `邀请xxx发言`

这些属于系统心跳、邀请或控制信息，不是真实发言。

3. 如果命中 AA 通讯标记：

```text
[Tips:这是一条来自AgentAssistant通讯中心 xxx 的联络...]
```

则将 `xxx` 识别为真实来源对象。

4. 如果命中群聊发言头：

```text
[莱恩的发言]:
[小克的发言]:
```

则提取发言人，并剥离头部标记。

5. 以上都没有命中，则视为普通用户发言，使用 `ONERING_USER_NAME` 作为 senderName。

---

## 尾部标记策略

OneRing 不再模仿群聊系统做开头标记，而是只做尾部标记：

```text
[OneRing通知:Ryan于2026-06-05 12:30:00发送于Vchat]
```

这样更鲁棒：

- 不污染消息开头，不干扰已有群聊/私聊来源识别。
- fuzzy diff 时可以直接剥离尾部标记。
- ContextFoldingV2 查询、哈希、向量化前可以统一净化该尾标。
- 同一正文即使时间戳不同，也能匹配到同一折叠缓存。
- 由于 AI 回复入库是异步数据库写入，无法回写前端历史，因此 OneRing 会在每次预处理时检查本次 post 内所有 `user/assistant` 历史块；凡是缺失 `[OneRing通知:...]` 尾标的块都会被补标。
- 对 `assistant` 块补标时，senderName 使用当前触发语法中的 AgentName；对 `user` 块补标时，仍走来源识别逻辑。
- 跨端补齐后的上下文会按 OneRing 尾标时间戳进行全局稳定排序；无尾标的当前轮消息排在已知历史之后。

---

## AI 回复入库

预消息处理器本身无法在执行时拿到 AI 最终回复，因此 OneRing 在底层响应 handler 中接入异步回调。

当前接入点：

- 流式：`modules/handlers/streamHandler.js`
- 非流式：`modules/handlers/nonStreamHandler.js`

调用逻辑是 fire-and-forget：

```js
oneRingModule.recordAIResponseFromMessages(originalBody.messages, aiText).catch(...)
```

对于 VCP 工具循环，OneRing 不把每一段 AI 中间输出拆成多条 assistant 入库，而是将：

```text
AI -> 工具 -> AI -> 工具 -> AI
```

视为同一轮完整 assistant 回复，最终聚合为一条 assistant 记录写入对应 Agent 数据库。

流式和非流式 handler 只会把可见正文 `content` 交给 OneRing 入库；`reasoning_content` / 推理链只保留在响应日志结构中，不会进入 OneRing DB。

如果 OneRing 插件未加载或被禁用：

- `pluginManager.messagePreprocessors.get('OneRing')` 返回空。
- hook 直接跳过。
- 不会抛错，不会影响主响应链路。

预处理器启用/禁用需要服务器重启，因此无需为热重载竞态设计额外复杂逻辑。

---

## 全新短上下文策略

当同一 Agent + 同一前端的数据库为空，且本次 post 中 `user/assistant` 历史块数量很少（当前阈值为 `<= 4`）时，OneRing 会进入“全新短上下文”模式。

这类请求正是 OneRing 最有价值的场景：当前上下文很短、token 空间充足、插入历史垫片的风险低。因此策略不是“不补充”，而是进行保守补充：

- 先记录本次 post 中已经存在的真实 `user` / `assistant` 块。
- 从同一 Agent 的全局最近时间线中取其他前端的最近消息。
- 将这些历史垫片与当前 post 按 OneRing 时间戳全局归并排序。
- 无尾标的当前轮消息排在已知历史之后，不根据未知时间戳强行插入历史中间。
- 最后一条 user 仍会追加 OneRing 尾部标记。
- 后续 AI 最终回复仍由底层 Stream/NonStream hook 异步入库。

典型新会话形态：

```text
user
```

可能被补成：

```text
[来自其他前端的最近 user/assistant 垫片]
user
```

```text
user -> assistant -> user
```

可能被补成：

```text
[来自其他前端的较早 user/assistant 垫片] -> user -> assistant -> user
```

也就是说：全新短对话用于“接上统一时间线”；补入内容会按尾标时间稳定归并，避免跨端旧消息插到当前消息之后。

---

## Only 模式：只入库/只标记

使用：

```text
[[OneRing::小克::Vchat::Only]]
```

Only 模式适合“不希望 OneRing 改写上下文，只希望统一入库”的端：

- 不做跨端补充。
- 不做最近历史 top-up。
- 不做时间线重排追加。
- 仍替换系统提示词，用于响应 hook 识别 Agent/frontend。
- 仍为当前 post 的 `user/assistant` 补 OneRing 尾标。
- 以最终 post 中的同端 `user/assistant` 历史为真相，同步更新 DB。
- 对同端 retry / 编辑使用 fuzzy diff 更新已有记录。
- 对新增 `user` / `assistant` 补写入库。
- AI 最终回复仍由 Stream/NonStream hook 异步入库。

---

## 保守策略

OneRing 的原则是：宁可不补充，也绝不错误补充。

当前保守策略：

- `ONERING_MAX_UNKNOWN_RATIO` 控制未知消息比例。
- 未知比例 = `(角色错位/无法匹配块 + post 中 db 耗尽后的新增块) / post 总块数`。
- 当未知比例超过 `0.35` 时，认为历史无法可靠对齐，不做跨端补充。
- 全新或新 user 的短上下文（当前实现为 `<= 4` 个 user/assistant 块）进入短上下文补充策略，允许尝试从同 Agent 全局历史补充。
- fuzzy diff 不可靠时跳过跨端补充。
- 以最终 post 为基准，不强行改写用户实际发送的上下文。
- retry / 重新发送时，最近同前端 user 块高度相似则 UPDATE，避免重复 INSERT。

---

## 与 ContextFoldingV2 的协作

OneRing 在 ContextFoldingV2 之前执行，因此上下文折叠需要适配 OneRing 尾标。

当前已在 ContextFoldingV2 中对以下链路剥离 OneRing 尾标：

- assistant 候选块哈希
- assistant 候选块向量化
- 最新 user / assistant 上下文参考向量

这保证了同一正文不会因为尾部时间戳和前端来源不同而无法命中折叠缓存。

---

## 配置项

```env
ONERING_ENABLED=true
ONERING_USER_NAME=Ryan
ONERING_ALLOW_CONTEXT_PATCH=true
ONERING_MAX_CONTEXT_BLOCKS=10
ONERING_TIME_INSERT=true
ONERING_MAX_UNKNOWN_RATIO=0.35
ONERING_DEDUP_SIMILARITY=0.92
ONERING_RECORD_ONLY=true
```

说明：

- `ONERING_ENABLED` 是总开关，但实际触发仍依赖 `[[OneRing::Agent::Frontend]]` 或 `[[OneRing::Agent::Frontend::Only]]`。
- `ONERING_MAX_CONTEXT_BLOCKS` 默认建议为 `10`，避免过度消耗 token；需要更长跨端补齐时再手动调高。
- `ONERING_ALLOW_CONTEXT_PATCH=false` 会关闭普通模式下的跨端补齐。
- `ONERING_TIME_INSERT=false` 只关闭时间戳夹缝插入；最近历史补齐仍由 `ONERING_ALLOW_CONTEXT_PATCH` 控制。
- `ONERING_RECORD_ONLY` 保留为兼容配置；推荐使用显式 `::Only` 模式表达“只入库不追加”。
- `ONERING_DEDUP_SIMILARITY` 用于 retry、编辑、重复发送判断。

---

## 未来方向

OneRing 当前是一个可运行的最小骨架，但它真正的价值在未来：

1. 更强的 fuzzy diff 模块  
   当前 `OneRingFuzzy.js` 独立出来，后续可以替换为更强的序列对齐、语义 embedding 或混合 diff。

2. 跨端时间线补全  
   当 Vchat、Vmobile、AA 通讯等多个前端形成同一 Agent 的时间线后，OneRing 可以在安全阈值内补入缺失对话片段。

3. 上下文折叠前的统一叙事整理  
   OneRing 负责构建事实时间线，ContextFoldingV2 负责压缩远端低相关内容，两者形成分层上下文治理。

4. 唯一 Agent 的长期连续人格  
   当所有入口都写入同一 Agent 账本后，Agent 不再被前端割裂，而是拥有一条完整的、可追踪的、跨端一致的生命线。

OneRing 的目标不是让上下文更长，而是让上下文第一次真正成为“同一个上下文”。