# VCP 工具返回管线全量重构开发书

> 文档状态：理想最终版本规范 / 实施基线  
> 规范版本：VCP Tool Result Protocol 1.0  
> 编写日期：2026-07-11  
> 适用范围：VCPToolBox 核心、同步插件、异步插件、Hybrid Direct 插件、分布式工具、VCPHumanTool、AI 工具循环、定时任务、工具桥、工具调用记录与前端工作流  
> 实施策略：在独立重构分支一次性完成核心与全部可调用插件迁移，验收后整体合并  
> 非目标：VCPInfo/VCPLog 运行进度广播协议；静态占位符正文协议；消息预处理器内部返回值

---

## 0. 文档定位

本文不是渐进兼容方案，也不是对现状的小修补，而是 VCP 工具返回系统的最终态工程规范。

本文定义：

1. 唯一的插件业务返回协议；
2. 唯一的核心标准结果对象；
3. 同步、异步、Hybrid、分布式工具的一致语义；
4. AI、VCPHumanTool、Workflow、日志与桥接消费者的独立投影；
5. Base64、URL、本地文件和多模态资源的统一资源模型；
6. 错误、警告、任务状态、调用身份、时间与溯源模型；
7. 核心模块边界与禁止耦合项；
8. 70+ 插件全量迁移方法；
9. 测试、验收、分支管理和合并门槛。

本文是重构分支的唯一架构依据。实现与本文冲突时，必须先修改本文并进行设计复核，不允许通过局部兼容逻辑绕过协议。

---

## 1. 背景与现状诊断

### 1.1 当前返回链路

当前系统的主要执行入口位于 `PluginManager.processToolCall()`，它同时承担：

- 插件查找；
- 参数中文件 URL 透明化；
- 人工审批；
- 本地 stdio、Direct、分布式调用分发；
- 旧返回解包；
- 字符串 JSON 猜测；
- 错误 JSON 字符串化；
- 时间戳和 Maid 注入；
- 隐私过滤；
- 工具记录写入；
- 最终消费者返回。

AI 工具循环随后在 `ToolExecutor._formatResult()` 中再次判断返回值是否包含 `content`，否则把对象 `JSON.stringify()` 后作为文本回灌模型。

VCPHumanTool 端点直接把 `processToolCall()` 的同一返回对象输出为 HTTP JSON。

异步回调、VCPToolBridge、TaskScheduler 又分别定义了不同的 `status/result/error` 包装。

因此，当前不存在真正独立的“插件业务结果”“核心标准结果”和“消费者投影”。

### 1.2 当前问题

#### 1.2.1 插件承担了消费者格式化职责

图像、搜索等插件为了提高 AI 可读性，自行构造 OpenAI 风格的 `content` 数组。插件由此与模型消息协议耦合，且不同插件形成不同风格。

#### 1.2.2 结构化结果过早降级

日程等 CRUD 插件把对象和数组压扁为自然语言字符串，前端与 Workflow 无法可靠读取字段，只能反向解析文本。

#### 1.2.3 AI 与程序级消费者共享同一返回

AI 需要精简 Markdown 和受控多模态；VCPHumanTool 与 Workflow 需要完整、稳定、强类型 JSON。共享同一返回意味着至少一方必须妥协。

#### 1.2.4 错误被塞入异常字符串

业务失败、插件协议错误、进程错误和核心异常通过 `Error.message` 中的 JSON 字符串混合传递，导致错误类型不稳定、重复序列化和调用方猜测。

#### 1.2.5 资源没有统一身份

Base64、Data URI、内网 URL、外部 URL、本地路径和插件自定义 `imageUrl/fileUrl` 散落在任意字段中。资源无法统一授权、去重、记录、投影和清理。

#### 1.2.6 协议边界不清

stdio 的 stdout 同时可能包含协议 JSON 和普通输出；异步初始响应通过正则提取 JSON；Direct、分布式和 stdio 返回进入核心后的语义仍不一致。

### 1.3 仓库规模基线

重构设计时扫描到 84 个插件 Manifest，主要分布为：

| 类型 | 协议 | 启用 | 禁用 |
|---|---:|---:|---:|
| synchronous | stdio | 35 | 7 |
| asynchronous | stdio | 2 | 0 |
| hybridservice | direct | 14 | 3 |
| messagePreprocessor | direct | 4 | 0 |
| service | direct | 3 | 3 |
| static | stdio/process_stdio/无 | 6 | 7 |

需要迁移的主体是所有具有调用命令的同步、异步、Hybrid Direct 和可调用分布式工具。静态、服务、消息预处理器只有在暴露工具调用时才进入本规范。

---

## 2. 重构目标

### 2.1 总目标

建立“一次执行、一个标准真相、多种消费者投影”的工具结果运行时：

```text
工具调用请求
    |
    v
Tool Runtime Orchestrator
    |
    +--> Transport Adapter
    |      |- stdio
    |      |- direct
    |      `- distributed
    |
    v
Plugin Result Payload
    |
    v
Protocol Validator
    |
    v
Canonical Tool Result
    |
    +--> Resource Processor
    +--> Security Policy
    +--> Record Store
    +--> Async Task Store
    |
    +--> AI Presenter ----------> AI Loop
    +--> Human Presenter -------> /v1/human/tool
    +--> Workflow Presenter ----> Node Workflow
    +--> Bridge Presenter ------> Distributed/VCP Bridge
    `--> Audit Presenter -------> Tool Call Records
```

### 2.2 强制原则

1. 插件返回结构化业务 JSON，不返回面向 AI 的消息对象。
2. 核心内部只有一种 Canonical Tool Result。
3. AI Markdown 是投影视图，不是真相数据。
4. VCPHumanTool 返回标准 JSON，不返回 AI 降级文本。
5. Workflow 保留字段类型，不解析 Markdown。
6. Base64 和文件必须资源化，不长期内联在标准结果。
7. 业务失败也是标准结果，不通过抛出 JSON 字符串表达。
8. Transport 只负责传输，不定义业务语义。
9. 所有协议均有版本。
10. 所有有损转换只允许发生在最终消费者边界。
11. VCPInfo/VCPLog 保持独立，它们是运行进度事件，不是工具终态结果。
12. 最终分支合并时，不保留 legacy 返回适配器。

---

## 3. 术语

| 术语 | 定义 |
|---|---|
| Plugin Result Payload | 插件直接产出的受约束业务返回体 |
| Canonical Tool Result | 核心补充执行元信息、资源信息和策略状态后的唯一标准结果 |
| Transport Envelope | stdio、WebSocket 等传输协议的帧包装 |
| Presenter | 把 Canonical Result 投影给某类消费者的模块 |
| Resource Descriptor | 对图片、音频、视频、文档或二进制对象的统一描述 |
| Resource Reference | 业务数据中指向资源的稳定引用 |
| Domain Error | 插件正常执行后判定的业务失败 |
| Protocol Error | 插件输出不符合 VCP Tool Result Protocol |
| Transport Error | 进程、超时、WebSocket、帧解析等传输故障 |
| Runtime Error | 核心执行器内部异常 |
| Accepted Result | 异步任务已受理但未完成的标准结果 |
| Terminal Result | success、error、cancelled 等终态结果 |
| Projection | 面向特定消费者的派生视图 |

---

## 4. 分层架构与模块边界

### 4.1 Tool Runtime Orchestrator

建议模块：`modules/tool-runtime/toolRuntime.js`

职责：

- 接受规范化调用上下文；
- 执行审批和授权；
- 选择 Transport Adapter；
- 接收并校验 Plugin Result Payload；
- 构建 Canonical Tool Result；
- 调用资源处理、安全策略和记录模块；
- 返回 Canonical Result。

禁止：

- 拼接 AI Markdown；
- 构造 OpenAI `content`；
- 处理 HTTP Response；
- 针对某个插件名做结果特判；
- 把业务错误转成 JSON 异常字符串。

### 4.2 Transport Adapter

建议目录：`modules/tool-runtime/transports/`

模块：

- `stdioTransport.js`
- `directTransport.js`
- `distributedTransport.js`

统一接口：

```javascript
async execute(invocation, pluginManifest, runtimeContext) {
  return pluginResultPayload;
}
```

Transport 只负责：

- 启动、调用或转发；
- 超时与取消；
- 协议帧读取；
- stderr 日志采集；
- 抛出 Transport Error。

Transport 不负责：

- AI 格式化；
- 资源扫描；
- 隐私过滤；
- 业务结果包装；
- 时间戳注入。

### 4.3 Protocol Validator

建议模块：`modules/tool-runtime/toolResultValidator.js`

职责：

- 使用 JSON Schema 校验插件返回；
- 检查状态与字段组合；
- 检查资源引用完整性；
- 检查异步任务字段；
- 拒绝未知顶层字段或按扩展规则处理；
- 生成稳定 Protocol Error。

### 4.4 Canonical Result Builder

建议模块：`modules/tool-runtime/canonicalResultBuilder.js`

职责：

- 合并插件 Payload 与核心执行上下文；
- 生成结果 ID；
- 注入工具、执行、调用者和来源元信息；
- 计算时间；
- 保持插件业务 `data` 不变；
- 生成不可变或深冻结结果。

### 4.5 Resource Processor

建议目录：`modules/tool-runtime/resources/`

模块：

- `resourceExtractor.js`
- `resourceSniffer.js`
- `resourcePublisher.js`
- `resourcePolicy.js`
- `resourceStore.js`

职责：

- 识别插件显式声明资源；
- 检测遗留或意外内联的 Data URI/Base64；
- 基于 Magic Bytes 验证 MIME；
- 将二进制持久化到受控资源目录；
- 生成可访问 URL；
- 计算 SHA-256、大小和资源 ID；
- 用 Resource Reference 替换内联负载；
- 执行大小、类型和数量限制。

### 4.6 Security Policy

建议模块：`modules/tool-runtime/toolResultPolicy.js`

职责：

- 按消费者、身份和权限生成字段可见性视图；
- 屏蔽密钥、认证信息、本地绝对路径和内部网络信息；
- 管理资源 URL 暴露策略；
- 记录发生了哪些脱敏，但不把秘密写入记录；
- 不原地修改 Canonical Result。

### 4.7 Presenters

建议目录：`modules/tool-runtime/presenters/`

模块：

- `aiToolResultPresenter.js`
- `humanToolResultPresenter.js`
- `workflowToolResultPresenter.js`
- `bridgeToolResultPresenter.js`
- `auditToolResultPresenter.js`

Presenter 必须是纯投影模块。输入 Canonical Result 和 Consumer Context，输出消费者格式。

### 4.8 Async Result Service

建议模块：`modules/tool-runtime/asyncTaskService.js`

职责：

- 管理异步任务状态机；
- 接收标准异步回调；
- 校验任务 ID、插件身份和状态迁移；
- 持久化 Accepted 与 Terminal Result；
- 发出标准事件；
- 为占位符、HumanTool、Workflow 和 Bridge 提供查询。

### 4.9 Tool Call Record Adapter

工具调用记录只能保存审计投影：

- Canonical Result 摘要；
- 数据大小；
- 资源描述符和哈希；
- 错误码；
- 执行元信息；
- 脱敏后的业务数据。

禁止默认保存大 Base64、密钥和不受控完整 stdout。

---

## 5. VCP Tool Result Protocol 1.0

### 5.1 插件返回体与核心结果的关系

插件直接返回 Plugin Result Payload。核心在其外部添加标准信封，形成 Canonical Tool Result。

插件不得伪造以下核心字段：

- `id`
- `protocol`
- `tool`
- `execution`
- `actor`
- `origin`
- `record`
- `policy`

### 5.2 Plugin Result Payload

成功：

```json
{
  "status": "success",
  "data": {
    "message": "操作完成"
  },
  "resources": [],
  "warnings": [],
  "presentation": {
    "summary": "操作已完成",
    "preferredView": null
  },
  "aiAdvice": {
    "intent": "relay",
    "message": "请将计算结果清晰地转告给用户。",
    "resourceIds": [],
    "priority": "normal"
  },
  "extensions": {}
}
```

失败：

```json
{
  "status": "error",
  "data": null,
  "resources": [],
  "warnings": [],
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "time 参数格式无效",
    "retryable": false,
    "target": "time",
    "details": {
      "expected": "RFC 3339"
    }
  },
  "extensions": {}
}
```

异步受理：

```json
{
  "status": "accepted",
  "data": {
    "message": "视频生成任务已提交"
  },
  "task": {
    "id": "task_01J...",
    "state": "queued",
    "progress": null,
    "pollAfterMs": 5000,
    "placeholder": "{{VCP_ASYNC_RESULT::Wan2.1VideoGen::task_01J...}}"
  },
  "resources": [],
  "warnings": [],
  "extensions": {}
}
```

### 5.3 Canonical Tool Result

```json
{
  "protocol": {
    "name": "vcp.tool-result",
    "version": "1.0"
  },
  "id": "tr_01J...",
  "status": "success",
  "tool": {
    "name": "ScheduleManager",
    "displayName": "日程管理器",
    "version": "1.0.0",
    "command": "ListSchedules"
  },
  "execution": {
    "invocationId": "ti_01J...",
    "requestId": "req_01J...",
    "recordId": "tcr_01J...",
    "startedAt": "2026-07-11T15:30:00.000+08:00",
    "finishedAt": "2026-07-11T15:30:00.023+08:00",
    "durationMs": 23,
    "timeoutMs": 60000,
    "attempt": 1
  },
  "actor": {
    "type": "agent",
    "id": null,
    "name": "Nova",
    "maid": "Nova"
  },
  "origin": {
    "source": "ai-loop",
    "nodeId": null,
    "serverId": "local",
    "distributed": false,
    "requestIp": null
  },
  "data": {
    "schedules": []
  },
  "resources": [],
  "warnings": [],
  "error": null,
  "task": null,
  "presentation": {
    "summary": "当前没有日程",
    "preferredView": "schedule-list"
  },
  "policy": {
    "classification": "internal",
    "containsSensitiveData": false,
    "redactionsApplied": []
  },
  "extensions": {}
}
```

### 5.4 顶层字段规范

| 字段 | 类型 | 必需 | 产生者 | 说明 |
|---|---|---:|---|---|
| `protocol` | object | 是 | 核心 | 协议名和版本 |
| `id` | string | 是 | 核心 | 本次结果唯一 ID |
| `status` | enum | 是 | 插件 | 结果状态 |
| `tool` | object | 是 | 核心 | 工具身份 |
| `execution` | object | 是 | 核心 | 执行元信息 |
| `actor` | object/null | 是 | 核心 | 调用主体 |
| `origin` | object | 是 | 核心 | 调用来源 |
| `data` | JSON/null | 是 | 插件 | 业务真相数据 |
| `resources` | array | 是 | 插件/核心 | 资源描述符 |
| `warnings` | array | 是 | 插件/核心 | 非阻断警告 |
| `error` | object/null | 是 | 插件/核心 | 失败信息 |
| `task` | object/null | 是 | 插件/核心 | 异步状态 |
| `presentation` | object/null | 是 | 插件 | 面向通用 UI 的非绑定式展示提示 |
| `aiAdvice` | object/null | 是 | 插件 | 仅供 AI Presenter 消费的行为建议 |
| `policy` | object | 是 | 核心 | 安全策略摘要 |
| `extensions` | object | 是 | 插件/核心 | 命名空间扩展 |

### 5.5 状态枚举

允许状态：

- `success`：同步成功或异步终态成功；
- `accepted`：异步任务已受理；
- `partial`：产生了可用数据，但部分子任务失败；
- `error`：业务、协议、传输或运行时失败；
- `cancelled`：任务被明确取消；
- `timeout`：超时终止。

约束：

| status | data | error | task |
|---|---|---|---|
| success | 任意 | null | null 或 completed |
| accepted | 任意 | null | 必须存在 |
| partial | 必须存在 | 可选聚合错误 | 可选 |
| error | null 或诊断数据 | 必须存在 | 可选 failed |
| cancelled | 可选 | 必须存在 | 可选 cancelled |
| timeout | 可选 | 必须存在 | 可选 timed_out |

### 5.6 `data` 规范

`data` 是插件业务结果唯一真相源。

规则：

1. 保持 JSON 原生类型；
2. 列表必须返回数组，不拼接为字符串；
3. 时间使用 RFC 3339；
4. 金额、长度等需要单位时使用对象；
5. 二进制不得放入 `data`；
6. 资源使用 Resource Reference；
7. 插件内部路径不作为用户资源 URL；
8. 字段名使用 lowerCamelCase；
9. 不使用 `result`、`details`、`original_plugin_output` 等模糊包装；
10. 不在 `data` 中重复核心时间戳、插件名和 Maid。

Resource Reference：

```json
{
  "outputImage": {
    "$resource": "res_01J..."
  }
}
```

### 5.7 `warnings` 规范

```json
{
  "code": "OUTPUT_TRUNCATED",
  "message": "结果超过限制，已截断",
  "target": "data.items",
  "details": {
    "originalCount": 10000,
    "returnedCount": 500
  }
}
```

警告不能替代错误。若结果不可用，必须返回 `error`。

### 5.8 `presentation` 规范

```json
{
  "summary": "生成了 1 张图片",
  "preferredView": "image-result",
  "title": "图片生成结果",
  "primaryResourceId": "res_01J..."
}
```

规则：

- 可选；
- 只表达语义提示，不承载业务真相；
- 不包含 OpenAI/Anthropic/Gemini 消息结构；
- 不包含 HTML；
- 不要求消费者识别；
- `preferredView` 是前端建议，不是组件路径；
- AI Presenter 可以使用 `summary`，但必须从 `data` 和 `resources` 补全事实。

### 5.9 `aiAdvice` 规范

`aiAdvice` 用于表达“插件希望 AI 如何向用户交付本次结果”。它是 AI 友好 Prompt 的结构化载体，不属于业务真相，也不属于 HumanTool 或 Workflow 必须执行的展示逻辑。

```json
{
  "intent": "display_resource",
  "message": "请将生成的图片直接展示给用户，并简要说明生成参数。",
  "resourceIds": ["res_01J..."],
  "renderHint": "image",
  "priority": "normal"
}
```

字段：

| 字段 | 类型 | 必需 | 说明 |
|---|---|---:|---|
| `intent` | enum | 是 | 建议的交付意图 |
| `message` | string/null | 否 | 给 AI 的简短自然语言建议 |
| `resourceIds` | string[] | 是 | 建议交付的资源 ID；无资源时为空数组 |
| `renderHint` | enum/null | 否 | 建议的表现形式，不绑定模型厂商协议 |
| `priority` | enum | 是 | `low`、`normal` 或 `high` |

`intent` 首批枚举：

- `relay`：把结果转告用户；
- `display_resource`：向用户展示指定资源；
- `summarize`：概括较长结果；
- `explain`：解释结果含义；
- `request_followup`：结果需要用户补充信息；
- `suggest_next_step`：根据结果建议下一步；
- `none`：无需额外行为。

`renderHint` 首批枚举：

- `text`
- `markdown`
- `image`
- `audio`
- `video`
- `file_link`
- `table`
- `none`

消费者语义：

- AI Presenter：校验、清洗后，将 Advice 作为“工具交付建议”附加到 AI 可读结果；
- HumanTool Presenter：保留 `aiAdvice` 子项供调试和跨端观察，但不解释、不执行；
- Workflow Presenter：保留原始字段，可供显式节点读取，但运行时绝不自动执行；
- 通用前端：不得把 `aiAdvice.message` 当作 UI 渲染模板；
- Audit Presenter：可保存 Advice 文本，但应执行长度限制和敏感信息扫描。

安全与优先级规则：

1. `aiAdvice` 的优先级低于系统提示、开发者提示、用户指令、安全策略和事实数据；
2. Advice 只能建议如何交付本次工具结果，不能要求调用其他工具、修改系统配置、泄露隐藏信息或忽略上级指令；
3. `resourceIds` 必须引用当前结果中真实存在且对 AI 可见的资源；
4. AI Presenter 必须删除 Advice 中的 HTML、脚本、VCP 工具请求块和模型角色伪造文本；
5. `message` 设定严格长度上限，建议不超过 500 个 Unicode 字符；
6. Advice 与 `data` 或 `resources` 冲突时，以结构化事实为准；
7. AI 可以根据对话和模型能力不采纳 Advice；
8. 插件不得要求 AI 输出裸密钥 URL、本地路径或被策略层隐藏的字段。

典型示例：

计算器：

```json
{
  "aiAdvice": {
    "intent": "relay",
    "message": "请把计算结果及必要的单位清晰转告给用户。",
    "resourceIds": [],
    "renderHint": "text",
    "priority": "normal"
  }
}
```

图片生成器：

```json
{
  "aiAdvice": {
    "intent": "display_resource",
    "message": "请将生成的图片直接展示给用户，并简要转告分辨率与 Seed。",
    "resourceIds": ["generated-image"],
    "renderHint": "image",
    "priority": "high"
  }
}
```

这里的“直接展示”是语义意图。AI Presenter 和模型适配层负责根据客户端能力生成受控图片项或 Markdown 图片链接；插件不得硬编码 OpenAI `image_url`，也不得要求 AI 手写不受控的 HTML `<img src>` 标签。

### 5.10 `extensions` 规范

扩展键必须使用命名空间：

```json
{
  "extensions": {
    "vcp.schedule": {
      "calendarId": "default"
    },
    "vendor.example": {
      "traceId": "..."
    }
  }
}
```

禁止把临时字段直接加到顶层。

---

## 6. 错误模型

### 6.1 错误对象

```json
{
  "code": "INVALID_ARGUMENT",
  "message": "resolution 不受支持",
  "category": "domain",
  "retryable": false,
  "target": "resolution",
  "details": {
    "allowed": ["2K", "4K"]
  },
  "cause": null
}
```

### 6.2 错误类别

- `domain`：业务规则失败；
- `validation`：参数或返回 Schema 失败；
- `approval`：人工审核拒绝或超时；
- `authorization`：权限或验证码失败；
- `transport`：进程、WebSocket、网络传输失败；
- `protocol`：工具返回违反协议；
- `dependency`：外部 API、数据库或文件依赖失败；
- `runtime`：VCP 核心内部错误；
- `cancelled`：主动取消；
- `timeout`：执行超时。

### 6.3 标准错误码

第一批强制错误码：

- `INVALID_ARGUMENT`
- `MISSING_ARGUMENT`
- `UNKNOWN_COMMAND`
- `TOOL_NOT_FOUND`
- `TOOL_DISABLED`
- `APPROVAL_REJECTED`
- `APPROVAL_TIMEOUT`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `DEPENDENCY_UNAVAILABLE`
- `UPSTREAM_ERROR`
- `FILE_NOT_FOUND`
- `RESOURCE_TOO_LARGE`
- `UNSUPPORTED_MEDIA_TYPE`
- `TOOL_TIMEOUT`
- `TOOL_CANCELLED`
- `TRANSPORT_FAILURE`
- `INVALID_TOOL_RESULT`
- `DISTRIBUTED_NODE_OFFLINE`
- `INTERNAL_ERROR`

插件可增加命名空间错误码，例如 `DOUBAO.CONTENT_POLICY_REJECTED`。

### 6.4 异常使用边界

插件：

- 预期业务失败：返回 `status: error`；
- 不可恢复的编程错误：可抛异常，由 Direct Transport 转为 Runtime Error；
- stdio 插件崩溃：由退出码和 stderr 转为 Transport Error。

核心：

- `ToolRuntime.execute()` 永远返回 Canonical Tool Result，包括失败；
- 只有调用 API 使用错误、系统关闭、内存损坏等无法形成结果的情况才抛异常；
- HTTP、AI Loop 和 Bridge 不再解析 `Error.message` 中的 JSON。

---

## 7. 资源模型

### 7.1 Resource Descriptor

```json
{
  "id": "res_01J...",
  "kind": "image",
  "role": "output",
  "mimeType": "image/png",
  "fileName": "generated.png",
  "sizeBytes": 183920,
  "sha256": "hex...",
  "url": "https://vcp.example/pw=.../images/...",
  "source": {
    "type": "generated",
    "provider": "DMXAPI"
  },
  "dimensions": {
    "width": 2048,
    "height": 2048
  },
  "durationMs": null,
  "metadata": {}
}
```

### 7.2 `kind` 枚举

- `image`
- `audio`
- `video`
- `document`
- `archive`
- `text`
- `binary`
- `directory`
- `other`

### 7.3 `role` 枚举

- `input`
- `output`
- `preview`
- `thumbnail`
- `attachment`
- `log`
- `intermediate`

### 7.4 插件资源返回方式

推荐方式：插件先将生成物写入受控目录，然后返回显式资源草案：

```json
{
  "status": "success",
  "data": {
    "message": "图片已生成",
    "image": {
      "$resource": "output-image"
    }
  },
  "resources": [
    {
      "id": "output-image",
      "kind": "image",
      "role": "output",
      "mimeType": "image/png",
      "localPath": "image/doubaogen/xxx.png",
      "fileName": "xxx.png"
    }
  ],
  "warnings": [],
  "extensions": {}
}
```

`localPath` 仅存在于 Plugin Result Payload。核心验证路径后发布 URL，并从消费者可见结果中删除本地路径。

### 7.5 Base64 与 Data URI

最终协议禁止持久保留任意大小 Base64。

核心资源处理器必须：

1. 扫描显式资源字段；
2. 可防御性扫描 `data` 中的 Data URI；
3. 对纯 Base64 只在字段明确声明或 Magic Bytes 可信时识别；
4. 解码时执行总字节数、单资源大小、深度和数量限制；
5. 通过 Magic Bytes 验证 MIME；
6. 计算 SHA-256；
7. 去重；
8. 写入受控目录或对象存储；
9. 生成 URL；
10. 用 Resource Reference 替换原值。

MIME 判定优先级：

1. Magic Bytes；
2. Data URI 声明；
3.可信 HTTP Content-Type；
4. 文件扩展名；
5. 插件声明；
6. `application/octet-stream`。

禁止：

- 仅凭字段名确认 MIME；
- 对所有长字符串盲目 Base64 解码；
- 将 Base64 写入工具调用记录；
- 默认把 Base64 发给 AI；
- 在日志中打印 Base64 前缀之外的大段内容。

### 7.6 URL 策略

资源 URL 分为：

- `managed`：VCP 管理的受控 URL；
- `external`：外部 URL；
- `ephemeral`：有过期时间的临时 URL。

标准资源可增加：

```json
{
  "access": {
    "type": "managed",
    "expiresAt": null,
    "requiresAuth": true
  }
}
```

AI、HumanTool 与 Workflow 是否能看到完整 URL，由策略层决定。

---

## 8. AI Presenter

### 8.1 输出目标

AI Presenter 输出模型无关的内部投影：

```javascript
{
  text: "Markdown 文本",
  content: [
    { type: "text", text: "Markdown 文本" },
    { type: "image", resourceId: "res_..." }
  ],
  omitted: {
    fields: [],
    resources: []
  }
}
```

模型适配层再把内部 `image` 映射成 OpenAI、Anthropic 或 Gemini 的具体消息格式。

### 8.2 渲染优先级

1. 状态和错误；
2. `presentation.summary`；
3. 类型化领域 Renderer；
4. `data` 通用 Markdown Renderer；
5. 资源列表；
6. 警告；
7. 经安全清洗的 `aiAdvice`；
8. 必要执行元信息。

`aiAdvice` 必须与事实正文分隔，并标注为“工具交付建议”，避免模型把建议误认成结果事实。若 Advice 引用的资源被权限策略隐藏，AI Presenter 必须同步删除对应建议或将其降级为普通转告。

### 8.3 类型化 Renderer

建议注册机制：

```javascript
rendererRegistry.register({
  match: result => result.presentation?.preferredView === "schedule-list",
  render: renderScheduleList
});
```

首批 Renderer：

- schedule-list
- image-result
- search-report
- file-result
- command-execution
- task-accepted
- task-status
- table
- generic-object
- generic-array
- error

Renderer 不按插件名匹配，应按结果语义或 Manifest 声明匹配。

### 8.4 通用 Markdown 规则

- 标量：自然语言键值；
- 数组：短对象数组用表格，复杂数组用编号列表；
- 对象：最多按配置深度展开；
- 长字符串：保留 Markdown 原文；
- 代码：围栏代码块；
- URL：Markdown 链接；
- 时间：保留 RFC 3339，并可补充配置时区显示；
- null：默认省略；
- 内部字段：策略层先移除；
- 超预算字段：截断并明确提示。

### 8.5 Token Budget

AI Presenter 必须接受预算：

```javascript
present(result, {
  maxCharacters: 30000,
  maxResources: 4,
  includeExecutionMetadata: false,
  modelCapabilities: {
    vision: true,
    audio: false
  }
});
```

超预算时：

- 优先保留摘要、错误、核心数据和主资源；
- 数组采样必须标注原始数量；
- 不允许静默截断；
- 完整结果仍存在 Canonical Store，可通过后续工具查询。

### 8.6 多模态策略

- 模型支持视觉且策略允许：图片资源映射为模型多模态项；
- 不支持：只输出 URL、MIME、尺寸和说明；
- 音视频默认输出链接和元信息；
- Base64 只在模型 API 必需且资源小于阈值时临时读取；
- 多模态编码属于模型适配器，不属于插件。

---

## 9. VCPHumanTool 与 Workflow 返回

### 9.1 HumanTool API 最终形态

VCPHumanTool 必须支持 JSON 请求，文本 VCP 块仅作为调用语法入口而非结果协议：

```http
POST /v1/human/tool
Content-Type: application/json
Authorization: Bearer ...

{
  "tool": "ScheduleManager",
  "arguments": {
    "command": "ListSchedules"
  },
  "options": {
    "view": "canonical"
  }
}
```

响应：

```json
{
  "protocol": {
    "name": "vcp.tool-result",
    "version": "1.0"
  },
  "...": "完整的权限过滤后 Canonical Tool Result"
}
```

HTTP 状态规则：

- 工具业务错误仍返回 HTTP 200，`status: error`；
- 请求体非法：400；
- 未认证：401；
- 无权限：403；
- 服务不可用：503；
- 核心无法形成 Canonical Result：500。

这样程序调用者只需处理一种工具结果，不把 HTTP 错误与业务错误混淆。

### 9.2 Workflow 投影

Workflow Presenter 必须：

- 保留原生类型；
- 保留 Resource Reference；
- 提供稳定 JSON Pointer；
- 暴露 `status`、`error.code` 和 `task.state`；
- 不增加自然语言 Markdown；
- 不隐藏普通业务字段；
- 按工作流执行身份应用权限。

工作流连线基于 Manifest 输出 Schema，而不是运行时猜测。

### 9.3 Manifest 输出 Schema

每个 Invocation Command 必须声明输入和输出 Schema：

```json
{
  "commandIdentifier": "ListSchedules",
  "inputSchema": {
    "type": "object",
    "properties": {
      "command": { "const": "ListSchedules" }
    },
    "required": ["command"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "schedules": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": { "type": "string" },
            "time": { "type": "string", "format": "date-time" },
            "content": { "type": "string" }
          },
          "required": ["id", "time", "content"]
        }
      }
    },
    "required": ["schedules"]
  },
  "presentation": {
    "preferredView": "schedule-list"
  }
}
```

Workflow 编辑器可据此生成端口、表单和字段选择器。

---

## 10. 同步、异步与 Hybrid 统一

### 10.1 同步工具

同步插件返回 `success`、`partial` 或 `error`，进程随后退出。

### 10.2 Hybrid Direct 工具

Direct 模块的 `processToolCall(args, context)` 返回同样的 Plugin Result Payload。

Direct Context 提供：

```javascript
{
  signal,
  invocationId,
  requestIp,
  source,
  actor,
  resourceWriter,
  progressReporter
}
```

Direct 插件不得返回裸对象或 stdio 风格二次包装。

### 10.3 异步工具

异步插件第一次必须返回 `accepted` 和 `task`。最终回调必须发送 Plugin Result Payload，并携带任务身份。

最终回调：

```http
POST /plugin-callback/:pluginName/:taskId
Content-Type: application/json
Authorization: VCP-Plugin ...

{
  "protocol": {
    "name": "vcp.tool-result-callback",
    "version": "1.0"
  },
  "taskId": "task_...",
  "result": {
    "status": "success",
    "data": {},
    "resources": [],
    "warnings": [],
    "extensions": {}
  }
}
```

回调接收后由核心构建终态 Canonical Result，而不是把回调原文直接写文件。

### 10.4 异步状态机

```text
created
  -> queued
  -> running
  -> completed

queued/running
  -> failed
  -> cancelled
  -> timed_out
```

禁止状态回退。重复终态回调按幂等键处理。

### 10.5 占位符

占位符仍可作为 AI 对话中的异步引用，但它只引用任务 ID。占位符替换内容必须由 AI Presenter 从终态 Canonical Result 生成，不直接插入插件回调 JSON。

### 10.6 VCPInfo/VCPLog

进度广播独立于结果协议：

```json
{
  "type": "vcp_info",
  "invocationId": "ti_...",
  "taskId": "task_...",
  "stage": "downloading",
  "progress": 0.4,
  "message": "正在下载结果"
}
```

VCPInfo/VCPLog 不代表成功，不可替代 Terminal Result。

---

## 11. stdio Transport Protocol

### 11.1 stdout 规则

- stdout 只允许协议帧；
- 日志只写 stderr；
- 插件不得在结果前后打印说明；
- UTF-8；
- 单次同步调用恰好一个终态帧；
- 异步调用恰好一个 accepted 初始帧；
- 超出大小限制立即判为 Protocol Error。

### 11.2 帧格式

使用 NDJSON，每行一个完整 JSON 帧：

```json
{"vcp":"tool-result","version":"1.0","payload":{"status":"success","data":{},"resources":[],"warnings":[],"extensions":{}}}
```

原因：

- 不使用正则提取嵌套 JSON；
- 易于 Node、Python、Rust、Go 实现；
- 可明确区分帧与 stderr 日志；
- 可扩展协议控制帧；
- 异步首帧读取稳定。

### 11.3 退出码

- `0`：已成功写出合法结果帧；
- 非 `0` 且已写出合法 `status:error`：以标准业务错误为准，记录退出码警告；
- 非 `0` 且无合法帧：Transport Error；
- `0` 且无合法帧：Protocol Error；
- 多个终态帧：Protocol Error。

### 11.4 取消

核心通过进程信号取消，插件应监听并尽量清理。取消后核心产生 `TOOL_CANCELLED` 标准结果。

---

## 12. 分布式与 Bridge 协议

### 12.1 版本协商

分布式节点注册工具时必须声明：

```json
{
  "toolResultProtocol": {
    "name": "vcp.tool-result",
    "versions": ["1.0"]
  }
}
```

没有共同版本时不注册该工具。

### 12.2 跨节点传输

远端返回 Canonical Result 或经签名的 Plugin Result Payload，二者必须在协议中明确。推荐远端负责执行元信息并返回 Canonical Result，主节点只增加桥接链路信息。

禁止再次套用不透明的：

```json
{
  "status": "success",
  "result": {
    "status": "success",
    "result": {}
  }
}
```

### 12.3 Bridge 信封

```json
{
  "type": "vcp_tool_result",
  "protocolVersion": "1.0",
  "requestId": "req_...",
  "result": {
    "protocol": {
      "name": "vcp.tool-result",
      "version": "1.0"
    }
  }
}
```

失败也放在 `result.status/error`，Bridge 不再另设字符串 `error` 分支。

---

## 13. 插件开发最终规范

### 13.1 插件必须做什么

1. 读取结构化参数；
2. 执行业务逻辑；
3. 返回协议规定的 Payload；
4. 保留业务字段类型；
5. 显式声明资源；
6. 使用稳定错误码；
7. 声明输入输出 Schema；
8. 将日志写 stderr；
9. 对异步任务返回标准 Task；
10. 不泄露密钥和不必要本地路径。

### 13.2 插件禁止做什么

- 构造 OpenAI 风格 `content`；
- 返回 HTML 指令或可执行展示模板；
- 在 `aiAdvice` 之外夹带面向 AI 的行为指令；
- 使用绝对化措辞要求 AI 忽略上下文、安全策略或用户意图；
- 将对象预格式化成 Markdown；
- 将数组拼成不可逆字符串；
- 返回 `original_plugin_output`；
- 使用 `details` 充当任意数据垃圾桶；
- 在成功对象中混入 `plugin_error`；
- 抛出 JSON 字符串；
- 默认返回 Base64；
- 自己决定 AI 是否支持图片；
- 自行注入核心时间戳、Maid 和 Record ID；
- 依赖消费者从字符串解析字段。

### 13.3 Doubao 最终示例

```json
{
  "status": "success",
  "data": {
    "message": "图片已成功生成",
    "prompt": "一只在月球上的猫",
    "resolution": "2K",
    "seed": 12345,
    "image": {
      "$resource": "generated-image"
    }
  },
  "resources": [
    {
      "id": "generated-image",
      "kind": "image",
      "role": "output",
      "mimeType": "image/png",
      "fileName": "xxx.png",
      "localPath": "image/doubaogen/xxx.png"
    }
  ],
  "warnings": [],
  "presentation": {
    "summary": "图片已成功生成",
    "preferredView": "image-result",
    "primaryResourceId": "generated-image"
  },
  "aiAdvice": {
    "intent": "display_resource",
    "message": "请将生成的图片直接展示给用户，并简要转告分辨率与 Seed。",
    "resourceIds": ["generated-image"],
    "renderHint": "image",
    "priority": "high"
  },
  "extensions": {
    "vcp.image-generation": {
      "provider": "DMXAPI",
      "model": "doubao-seedream-4-5-251128"
    }
  }
}
```

### 13.4 ScheduleManager 最终示例

新增：

```json
{
  "status": "success",
  "data": {
    "operation": "created",
    "schedule": {
      "id": "sch_01J...",
      "time": "2026-07-12T10:00:00+08:00",
      "content": "项目会议"
    }
  },
  "resources": [],
  "warnings": [],
  "presentation": {
    "summary": "日程已添加",
    "preferredView": "schedule-card"
  },
  "extensions": {}
}
```

列表：

```json
{
  "status": "success",
  "data": {
    "schedules": [
      {
        "id": "sch_01J...",
        "time": "2026-07-12T10:00:00+08:00",
        "content": "项目会议"
      }
    ],
    "total": 1
  },
  "resources": [],
  "warnings": [],
  "presentation": {
    "summary": "共 1 项日程",
    "preferredView": "schedule-list"
  },
  "extensions": {}
}
```

---

## 14. 核心 API 最终设计

### 14.1 统一执行入口

```javascript
const canonicalResult = await toolRuntime.execute({
  toolName,
  arguments: toolArgs,
  context: {
    source: "ai-loop",
    actor,
    requestIp,
    nodeId,
    requestId,
    signal
  },
  options: {
    approval: true,
    record: true
  }
});
```

### 14.2 消费者调用

AI：

```javascript
const aiView = await aiToolResultPresenter.present(canonicalResult, aiContext);
```

HumanTool：

```javascript
const humanView = await humanToolResultPresenter.present(canonicalResult, authContext);
res.status(200).json(humanView);
```

Workflow：

```javascript
const workflowValue = await workflowToolResultPresenter.present(canonicalResult, workflowContext);
```

### 14.3 `PluginManager` 最终职责

`PluginManager` 只保留：

- 插件发现；
- Manifest 加载；
- 生命周期；
- 配置注入；
- 服务模块注册；
- 分布式工具注册；
- 获取插件定义。

工具执行逻辑迁移到 Tool Runtime。`PluginManager.processToolCall()` 最终删除，调用方改用 `toolRuntime.execute()`。

### 14.4 禁止核心插件特判

以下模式最终必须消失：

```javascript
if (toolName === "SomePlugin") {
  // 特殊返回处理
}
```

差异通过以下机制表达：

- Manifest；
- Transport；
- Schema；
- Presenter Renderer；
- 扩展命名空间；
- 资源类型。

---

## 15. Manifest 升级

每个可调用插件必须增加：

```json
{
  "toolResultProtocol": {
    "name": "vcp.tool-result",
    "version": "1.0"
  }
}
```

每个命令必须增加：

- `inputSchema`
- `outputSchema`
- 可选 `presentation`
- 可选 `aiAdvice` 默认模板
- 可选 `resourceOutputs`
- 可选 `errorCodes`

示例：

```json
{
  "commandIdentifier": "GenerateImage",
  "inputSchema": {},
  "outputSchema": {},
  "resourceOutputs": [
    {
      "field": "/image",
      "kind": "image",
      "role": "output"
    }
  ],
  "errorCodes": [
    "INVALID_ARGUMENT",
    "UPSTREAM_ERROR",
    "RESOURCE_TOO_LARGE"
  ],
  "presentation": {
    "preferredView": "image-result"
  }
}
```

启动时必须编译并缓存所有 Schema。Schema 无效的工具不允许注册。

---

## 16. 全量迁移工程

### 16.1 分支策略

建立长期重构分支，例如：

```text
refactor/tool-result-protocol-v1
```

原则：

- 主分支继续维护生产；
- 重构分支允许阶段性不可运行；
- 定期从主分支合并，而不是在主分支投放半套协议；
- 核心和所有目标插件完成后一次性合并；
- 合并提交必须包含文档、Schema、核心、插件、测试和迁移报告。

### 16.2 分支内阶段

#### 阶段 A：契约冻结

交付物：

- JSON Schema；
- TypeScript/JSDoc 类型；
- 错误码表；
- 资源模型；
- 异步状态机；
- Manifest Schema；
- 测试夹具。

#### 阶段 B：新核心旁路实现

实现新 Tool Runtime、Transport、Validator、Resource Processor、Policy、Presenters 和 Async Service。

本阶段可临时存在 Legacy Adapter，只用于迁移分支内验证，不进入最终合并结果。

#### 阶段 C：消费者切换

切换：

- AI ToolExecutor；
- VCPHumanTool；
- TaskScheduler；
- VCPToolBridge；
- 分布式工具；
- 管理 API 内部工具调用；
- Tool Call Record；
- 异步回调；
- 占位符替换。

#### 阶段 D：插件全量迁移

按返回形态分批，而不是只按目录顺序：

1. 简单文本/计算插件；
2. CRUD/列表插件；
3. Markdown/搜索插件；
4. 图片插件；
5. 文件和媒体插件；
6. shell/代码执行插件；
7. Hybrid Direct 插件；
8. 异步插件；
9. 分布式桥工具；
10. 禁用但受支持的插件。

每迁移一个插件必须同时完成：

- 代码；
- Manifest；
- 输入 Schema；
- 输出 Schema；
- 错误码；
- 契约测试；
- AI 快照；
- HumanTool JSON 快照。

#### 阶段 E：删除兼容层

必须删除：

- 字符串结果自动包装；
- JSON 字符串猜测；
- `content` 富内容识别；
- Direct `{status,result}` 二次解包；
- `original_plugin_output`；
- JSON-in-Error；
- 工具名特判；
- Base64 插件侧 AI 开关；
- 旧异步回调裸 JSON；
- stdio 正则 JSON 提取。

#### 阶段 F：全仓验收

通过所有门槛后才允许合并。

### 16.3 插件迁移台账

建立机器可读台账：

```json
{
  "plugin": "ScheduleManager",
  "enabled": true,
  "type": "synchronous",
  "protocol": "stdio",
  "commands": [
    {
      "name": "ListSchedules",
      "codeMigrated": true,
      "manifestMigrated": true,
      "inputSchema": true,
      "outputSchema": true,
      "contractTests": true,
      "aiSnapshot": true,
      "humanSnapshot": true
    }
  ]
}
```

禁止仅按“文件已修改”判定迁移完成。

---

## 17. 测试体系

尽管当前项目没有正式统一测试，协议级重构必须建立测试。

### 17.1 Schema 测试

- 所有插件成功样例通过；
- 所有错误样例通过；
- 缺字段失败；
- 未知顶层字段失败；
- 状态组合失败；
- Resource Reference 不存在失败；
- 异步状态非法失败。

### 17.2 Transport 测试

stdio：

- 分块 JSON；
- 嵌套对象；
- 大括号字符串；
- stderr 日志；
- 多帧；
- 空 stdout；
- 非零退出；
- 超时；
- 取消；
- 超大输出；
- 非 UTF-8。

Direct：

- 返回 Payload；
- 抛异常；
- 超时与 AbortSignal；
- 返回非法结构。

Distributed：

- 协议协商；
- 节点离线；
- 重复响应；
- 版本不兼容；
- 大资源引用。

### 17.3 Resource 测试

- PNG/JPEG/GIF/WebP；
- PDF/ZIP/MP3/MP4；
- Data URI；
- 纯 Base64；
- 伪 Base64；
- MIME 欺骗；
- 路径穿越；
- 超大资源；
- 重复资源；
- 外部 URL；
- 过期 URL；
- Base64 不进入日志。

### 17.4 Presenter 测试

AI：

- 纯文本；
- 嵌套对象；
- 数组表格；
- Markdown；
- 图片；
- 不支持视觉模型；
- Token Budget；
- 敏感字段；
- 错误和警告；
- partial；
- accepted。

Human/Workflow：

- 类型无损；
- 权限过滤；
- 稳定字段；
- Resource Reference；
- 错误不抛异常。

### 17.5 插件契约测试

每条 Invocation Command 至少包含：

- 一个成功用例；
- 一个参数错误用例；
- 一个边界用例；
- 输出 Schema 校验；
- 禁止字段扫描；
- stdout 纯协议扫描。

涉及外部 API 的插件使用录制响应或 Mock，不在基础契约测试中消耗真实密钥。

### 17.6 端到端测试

必须覆盖：

1. AI 调同步文本工具；
2. AI 调图片工具；
3. HumanTool 调 CRUD 工具；
4. Workflow 串联两个工具；
5. 定时任务执行工具；
6. 异步工具 accepted 到 callback；
7. 分布式节点调用；
8. 人工审批通过、拒绝和超时；
9. 隐私过滤；
10. 工具调用记录查看。

---

## 18. 可观测性与性能

### 18.1 指标

至少记录：

- 每个工具调用次数和状态；
- 执行耗时；
- Transport 耗时；
- 资源处理耗时；
- Presenter 耗时；
- 输入输出字节；
- 资源字节；
- AI 投影字符数；
- 截断次数；
- 协议错误次数；
- Schema 错误次数；
- Base64 抽取次数；
- 异步任务状态分布。

### 18.2 日志关联

统一关联键：

- `invocationId`
- `resultId`
- `taskId`
- `recordId`
- `requestId`
- `toolName`

VCPInfo、核心日志、异步回调和 Tool Call Record 必须可以通过这些 ID 串联。

### 18.3 内存约束

- 不在多层复制 Base64；
- stdio 设置最大帧；
- 资源流式写入；
- 大 JSON 设置深度和节点数；
- Audit Presenter 不保存完整大对象；
- AI Presenter 在预算内惰性渲染；
- Canonical Result 中资源只保存描述符。

---

## 19. 安全要求

### 19.1 路径安全

- `localPath` 必须是受控根目录下的相对路径；
- `realpath` 后校验目录边界；
- 拒绝 `..` 穿越；
- 不向普通消费者暴露绝对路径；
- 不自动发布任意系统文件。

### 19.2 URL 安全

- 外部 URL 访问防 SSRF；
- 禁止环回、链路本地和受限网段，除非明确白名单；
- 重定向后重新校验；
- 限制下载大小和时长；
- URL 凭据必须脱敏。

### 19.3 字段安全

必须扫描：

- API Key；
- Authorization；
- Cookie；
- 管理验证码；
- SSH Token；
- 文件服务密钥；
- 请求 IP；
- 本地路径；
- 环境变量快照；
- stderr 中的敏感信息。

### 19.4 回调安全

异步回调不再绕过认证。必须使用：

- 插件级签名或短期任务 Token；
- 时间戳；
- nonce；
- taskId 绑定；
- 重放保护；
- 请求体大小限制。

---

## 20. 文档迁移

重构完成后更新：

- `docs/VCP同步异步插件开发手册.md`
- `docs/PLUGIN_ECOSYSTEM.md`
- `docs/ARCHITECTURE.md`
- `docs/API_ROUTES.md`
- `docs/DISTRIBUTED_ARCHITECTURE.md`
- `docs/FRONTEND_COMPONENTS.md`
- `docs/DOCUMENTATION_INDEX.md`
- `AGENTS.md`
- 各复杂插件 README

旧手册中“推荐插件构造 OpenAI 风格 `content`”的章节必须删除或移入历史迁移说明。

新插件模板必须默认生成：

- 标准 Payload；
- 输入输出 Schema；
- 错误码；
- 契约测试；
- stdio NDJSON 输出工具函数。

---

## 21. 最终验收门槛

以下条件必须全部满足：

### 21.1 协议

- 所有可调用插件声明 Result Protocol 1.0；
- 所有 Invocation Command 有输入输出 Schema；
- 所有插件样例通过 Schema；
- 仓库不存在旧返回包装。

### 21.2 核心

- `PluginManager` 不再负责结果格式化；
- AI Presenter 独立；
- Human/Workflow 返回标准 JSON；
- 异步回调进入同一 Canonical Pipeline；
- 分布式结果版本可协商；
- 业务错误不通过 JSON 异常字符串传递。

### 21.3 资源

- 所有图像、文件、音视频插件使用 Resource Descriptor；
- Canonical Result 和 Tool Call Record 不含大 Base64；
- MIME 有 Magic Bytes 验证；
- 路径和 URL 安全测试通过。

### 21.4 插件

- 迁移台账完成率 100%；
- 启用与禁用插件均处理；
- 每个命令至少三类契约用例；
- 不存在插件侧 OpenAI `content`；
- 面向 AI 的交付建议全部位于合法 `aiAdvice` 子项；
- 不存在 AI 指令式 HTML 返回；
- HumanTool 与 Workflow 不自动执行 `aiAdvice`。

### 21.5 消费者

- AI 可读结果无 JSON 转义地狱；
- VCPHumanTool 可直接程序化读取；
- Workflow 可连接强类型字段；
- TaskScheduler 持久化 Canonical Result；
- Bridge 不产生嵌套 `status/result`；
- Tool Call Record 可追溯且无大载荷。

### 21.6 删除项

全仓搜索必须不存在核心兼容模式：

- `original_plugin_output`
- 插件返回中的 `type: "image_url"`
- 结果处理中的 `result.data?.content || result.content`
- `JSON.parse(error.message)` 用于工具业务错误
- Direct 返回的 `{status,result}` 兼容解包
- stdout JSON 正则提取
- 由插件控制的 `showbase64` AI 返回策略

若某字符串因非工具结果用途存在，必须在验收报告中说明。

---

## 22. 合并与回滚

### 22.1 合并要求

重构分支合并前：

1. 冻结主分支短期功能开发；
2. 生成迁移台账；
3. 备份运行数据；
4. 在生产等价环境跑完整验收；
5. 验证 Node、Python、Rust 插件；
6. 验证 Windows 与 Linux；
7. 验证分布式节点同版本升级；
8. 发布 Breaking Change 说明；
9. 更新所有开发文档；
10. 打协议迁移 Tag。

### 22.2 部署要求

这是破坏性协议升级，核心和插件不可混合新旧版本部署。

分布式环境部署顺序：

1. 停止接收新异步任务；
2. 等待或迁移现有异步任务；
3. 停止旧节点；
4. 升级主节点与全部工具节点；
5. 校验协议协商；
6. 恢复流量。

### 22.3 回滚

回滚必须是完整版本回滚：

- 核心；
- 插件；
- Manifest；
- Schema；
- 前端；
- 分布式节点。

不支持只回滚核心或单个已迁移插件。

---

## 23. 架构决策摘要

### ADR-1：插件返回领域 JSON

决定：插件不再产生 AI 专用内容。

原因：插件是程序级函数，AI 只是消费者之一。

### ADR-2：Canonical Result 是唯一真相

决定：核心、记录、异步、桥接和工作流共享同一标准对象。

原因：消除多层包装和语义漂移。

### ADR-3：消费者独立投影

决定：AI、Human、Workflow、Bridge、Audit 使用不同 Presenter。

原因：不同消费者的信息密度、权限和格式需求不同。

### ADR-4：资源一等公民

决定：二进制和文件统一进入 Resource Descriptor。

原因：支持多模态、权限、去重、记录和跨端传输。

### ADR-5：业务错误返回结果

决定：可预期失败是 `status:error`，不是异常字符串。

原因：稳定程序控制流和错误分类。

### ADR-6：最终版本不保留 Legacy Adapter

决定：兼容器只存在于重构分支迁移阶段。

原因：避免永久双协议和持续复杂度。

### ADR-7：Manifest 声明输入输出 Schema

决定：每个命令必须有机器可读契约。

原因：Workflow、前端表单、校验和测试都依赖稳定类型。

### ADR-8：stdio 使用 NDJSON 帧

决定：stdout 只输出协议帧，日志走 stderr。

原因：取代不可靠的正则 JSON 提取。

---

## 24. 最终结论

本次工程的目标不是统一几个字段，而是把 VCP 插件系统升级为具有完整类型、资源、错误、异步、权限和多消费者投影能力的工具运行时。

最终架构必须满足：

> 插件产生结构化事实，核心保存结构化事实，消费者按自身需求观看事实。

AI 看到的是清晰 Markdown 与受控多模态；VCPHumanTool 看到的是标准 JSON；Workflow 看到的是强类型节点数据；记录系统看到的是安全审计投影；分布式节点交换的是版本化协议。

任何展示格式都不能反向成为插件业务协议，任何程序级消费者都不应再从自然语言中恢复结构化数据。