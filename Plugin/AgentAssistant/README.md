# AgentAssistant 插件

`AgentAssistant` 是一个强大的同步插件，作为 VCP 系统中 Agent 之间进行标准化通信的核心协议。它允许一个 Agent 调用另一个 Agent，实现基于各自知识库的互助式连续交流、消息群发、任务分发等高级协作功能。

## 核心功能

- **Agent 间对话**: 一个 Agent 可以向另一个指定名称的 Agent 发送消息 (`prompt`)，并获取对方基于其自身知识库和上下文的回复。
- **上下文保持**: 插件内部为每个 Agent 的每个会话维护独立的上下文历史，确保连续对话的流畅性。
- **标准化定时任务**: 支持安排在未来的特定时间点执行通讯任务，赋予 Agent 规划未来行动的能力。

## VCP 调用指令

### 1. 即时通讯

这是 `AgentAssistant` 的基础用法，用于立即向另一个 Agent 发送消息。

**VCP 指令格式:**

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」AgentAssistant「末」,
agent_name:「始」小克「末」,
prompt:「始」你好，小克，请帮我查询一下今天关于“量子计算”的最新研究进展。「末」
<<<[END_TOOL_REQUEST]>>>
```

**参数说明:**

- `tool_name`: **必须**是 `AgentAssistant`。
- `agent_name`: (必需) 你想要通讯的目标 Agent 的名称。这个名称必须与插件 `config.env` 中定义的 `AGENT_..._CHINESE_NAME` 匹配。
- `prompt`: (必需) 你想发送给目标 Agent 的消息内容。

### 2. 定时通讯 (未来任务)

通过增加 `timely_contact` 参数，可以将一个即时通讯请求转变为一个未来执行的任务。

**VCP 指令格式:**

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」AgentAssistant「末」,
agent_name:「始」小娜「末」,
prompt:「始」帮我下载半小时前已经推出的B站新番多罗罗的最新一集。「末」,
timely_contact:「始」2025-06-29-15:00「末」
<<<[END_TOOL_REQUEST]>>>
```

**参数说明:**

- `timely_contact`: (可选) 指定任务执行的未来时间。
  - **格式**: 必须是 `YYYY-MM-DD-HH:mm`。例如 `2025-06-29-15:00` 表示在 2025年6月29日 下午3点整 执行。
  - **机制**: 当插件检测到此参数时，它不会立即执行通讯，而是会调用 VCP 主服务器的标准化任务调度 API (`/v1/schedule_task`)。
  - **任务内容**: 插件会将原始的 `agent_name` 和 `prompt` 等参数打包成一个标准的 VCP Tool Call，作为未来任务的核心内容。
  - **即时回执**: 任务创建成功后，`AgentAssistant` 插件会**立即**返回一条对用户友好的确认信息，例如：“您预定于 2025年6月29日 15:00 发给 小娜 的未来通讯已经被系统记录，届时会自动发送。”
  - **执行通知**: 当预定时间到达，VCP 的中心化任务调度器会执行该任务（即调用 `AgentAssistant` 并传入原始参数），并将最终的执行结果通过 WebSocket 推送给所有 `VCPLog` 客户端，实现全域通知。

这个功能使得 AI Agent 不再局限于即时响应，而是可以真正地为用户或自己安排“待办事项”，极大地扩展了其作为智能助手的应用场景。
