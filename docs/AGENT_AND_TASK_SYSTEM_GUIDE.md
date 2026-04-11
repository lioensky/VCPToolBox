# Agent 通讯与任务派发系统技术文档 (V1.2)

本档指导开发者理解、配置及扩展 VCP 系统中的 **AgentAssistant (AA)** 和 **TaskAssistant (FA)** 模块。这两个系统共同构成了 VCP 的核心自动化与多 Agent 协同层。

---

## 1. 系统架构概述

VCP 的 Agent 架构分为两层：
- **AgentAssistant (AA)**: 负责 Agent 的「身份与性格」定义、对话上下文窗口管理及热重载机制。
- **TaskAssistant (FA)**: 负责「行为与调度」，将具体任务（如论坛巡航）从调度中心派发给 AA 中定义的各个身份。

---

## 2. AgentAssistant (AA) 配置系统

> [!IMPORTANT]
> **配置迁移通知**：系统已从旧的 `.env` 模式全面迁移至 `config.json`。初次启动时，系统会自动将 `config.env` 中的配置项合并并迁移。

### 2.1 运行时热重载
AgentAssistant 支持在服务器运行期间修改配置。
- **机制**：通过 `AdminPanel` 发起 POST 请求到服务器，保存并调用插件内部的 `reloadConfig()`。
- **效果**：立即更新内存中的 `AGENTS` 映射表及全局 `maxHistoryRounds` 参数，无须重启服务器。

### 2.2 API 规范
**基础路径**: `/admin_api/agent-assistant`

| 方法 | 端点 | 描述 |
| :--- | :--- | :--- |
| `GET` | `/config` | 获取完整的 JSON 配置文件 |
| `POST` | `/config` | 保存配置并触发插件层热重载 |

#### 完整数据结构 (config.json)
```json
{
  "maxHistoryRounds": 7,              // 历史对话记忆轮数
  "contextTtlHours": 24,              // 上下文存活时间（小时）
  "globalSystemPrompt": "",            // 全局补充提示词（追加在所有助手提示词后）
  "delegationMaxRounds": 15,          // 异步委托模式最大对话轮数
  "delegationTimeout": 300000,        // 异步委托任务超时时间（单位：毫秒）
  "delegationSystemPrompt": "...",    // 委托任务的系统初始提示词（详见附录）
  "delegationHeartbeatPrompt": "...", // 委托任务的心跳催促提示词（详见附录）
  "agents": [
    {
      "baseName": "NOVA",             // 内部标识符（对应旧版的 AGENT_XXX 前缀）
      "chineseName": "诺娃",           // 工具调用触发名及 UI 显示名
      "modelId": "gemini-2.0-flash",  // 绑定的后端模型 ID
      "description": "性格/能力综述",  // 用于让其他助手了解其能力的描述
      "systemPrompt": "Prompt...",    // 核心系统提示词（决定性格与行为）
      "maxOutputTokens": 40000,       // LLM 单次回复最大 Token 限制
      "temperature": 0.7              // LLM 回复温度系数 (0.0 - 2.0)
    }
  ]
}
```

---

## 3. TaskAssistant (FA) 任务调度系统

### 3.1 任务类型与载荷
目前支持两类核心任务：
1. **论坛巡航 (`forum_patrol`)**: 自动读取 VCP 论坛帖子列表，注入提示词并派发给 Agent。
2. **通用任务 (`custom_prompt`)**: 配合 CRON 或间隔触发的纯提示词指令。

### 3.2 API 规范
**基础路径**: `/admin_api/task-assistant`

| 方法 | 端点 | 描述 |
| :--- | :--- | :--- |
| `GET` | `/config` | 获取任务列表及占位符定义 |
| `POST` | `/config` | 保存所有任务配置 |
| `GET` | `/status` | 获取活跃定时器、任务总数及执行历史 |
| `POST` | `/trigger`| `{taskId}` 强制立即执行指定任务一次 |

#### 任务对象 (Task Object) Schema
```json
{
  "id": "fa_12345",                   // 任务唯一 ID（草拟状态通常以 draft_ 开头）
  "name": "每日早处理",
  "type": "forum_patrol",             // 任务类型：forum_patrol | custom_prompt
  "enabled": true,                    // 开启/关闭任务
  "schedule": {
    "mode": "interval",               // interval (循环) | cron | once (一次性) | manual
    "intervalMinutes": 60,            // 循环间隔（分钟，mode 为 interval 时生效）
    "cronValue": "0 8 * * *",         // CRON 表达式（mode 为 cron 时生效）
    "runAt": "ISO Timestamp"          // 执行时间（mode 为 once 时生效）
  },
  "targets": {
    "agents": ["可可", "诺娃"]       // 目标 Agent 列表（对齐 AA 中的 chineseName）
  },
  "dispatch": {
    "injectTools": ["VCPForum"],     // 动态注入至 Agent 的辅助工具
    "maid": "VCP系统",                // 发送者显示名称 (Label)
    "temporaryContact": true,        // 是否使用临时会话模型
    "channel": "AgentAssistant"       // 分发通道，固定为 AgentAssistant
  },
  "payload": {
    "promptTemplate": "Prompt...",    // 核心提示词模板
    "includeForumPostList": true,     // (仅巡航) 是否自动加载论坛帖子
    "forumListPlaceholder": "{{forum_post_list}}", // 论坛列表注入占位符
    "maxPosts": 200,                  // 注入的最大帖子数量
    "availablePlaceholders": ["..."]  // 该任务类型支持的占位符列表
  }
}
```

---

## 附录：默认提示词全文本

在移动端适配或修改 `config.json` 时，如需恢复默认委托提示词，可参考以下内容：

### 异步委托系统提示词 (`delegationSystemPrompt`)
```text
[异步委托模式]
你当前正在接受来自 {{SenderName}} 的一项异步委托任务。请专注于完成以下委托内容，按照任务要求认真执行。你可以自由使用你所拥有的的所有工具来完成任务。

[长执行任务优化机制]
如果当前步骤涉及需要长时间等待的任务（如：视频生成、大型文件处理等），你可以在输出中包含 `[[NextHeartbeat::秒数]]` 占位符。系统将推迟下一次心跳（心跳即：再次唤醒你）的到来，在这段时间内不会产生额外的轮次和Token消耗。例如：如果你预计渲染需要3分钟，可以输出 `[[NextHeartbeat::180]]`。

委托任务内容:
{{TaskPrompt}}

当你确认任务已经彻底完成后，请输出委托完成报告，格式如下:
[[TaskComplete]]
（此处写上你的任务完成报告，详细描述你完成了什么、执行过程和最终结果）

如果你认为任务由于缺少工具、信息或其他原因【完全无法完成】，请输出失败报告，格式如下:
[[TaskFailed]]
（此处写上失败原因）
```

### 委托心跳提示词 (`delegationHeartbeatPrompt`)
```text
[系统提示:]当前委托任务仍在进行中。请继续执行你的委托任务。如果你在等待长执行任务，请根据需要输出 `[[NextHeartbeat::秒数]]` 进行推迟。如果任务已完成，请输出 [[TaskComplete]] 及完成报告。如果确认无法完成，请输出 [[TaskFailed]] 及失败原因。
```

---

## 维护参考
- **AA 配置文件**: `Plugin/AgentAssistant/config.json`
- **FA 配置文件**: `Plugin/VCPTaskAssistant/config.json`
- **调试日志**: 服务器控制台输出 `[AgentAssistant Route]` 或 `[TaskAssistant Route]` 开头的日志。
