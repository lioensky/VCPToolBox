# VCPTaskAssistant 发现记录

## 已确认事实

| 事实 | 证据 |
|------|------|
| VCPTaskAssistant 是 hybridservice/direct 插件 | `Plugin/VCPTaskAssistant/plugin-manifest.json` |
| 任务数据保存在 `task-center-data.json` | `Plugin/VCPTaskAssistant/vcp-task-assistant.js` 第 10 行 |
| 支持 `manual`、`once`、`interval`、`cron` | `normalizeSchedule` 与 `scheduleTask` |
| 执行任务时调用 `/v1/human/tool` | `wakeUpAgent` |
| 当前成功判定只看 HTTP 状态码 | `executeTask` 中判断 `dispatchResult.status` |
| `/v1/human/tool` 用 HTTP 200 返回插件结果对象 | `server.js` 中 `res.status(200).json(result)` |
| 当前 history 不保存 Agent 原始回复 | `appendHistory` 写入字段只有摘要信息 |
| `dispatch.channel` 当前没有真正参与派发选择 | `wakeUpAgent` 写死 `tool_name: AgentAssistant` |
| `broadcastStatusUpdate` 目前只是 debug 日志 | `broadcastStatusUpdate` 函数 |

## 与本次问题相关的发现

- 任务中心显示的 `success (1 agents)` 不能证明任务完成。
- 当前记录只能证明至少一个 AgentAssistant 调用返回了 HTTP 2xx。
- 如果 AgentAssistant 内部返回 `{ status: "error" }`，任务中心仍可能误判。
- 服务日志出现过模型上下文超限错误：请求约 317 万 tokens，超过 DeepSeek 限制。
- 这类执行链路失败需要进入任务运行详情，否则管理面板无法解释“为什么没有产出”。

## 设计判断

- VCPTaskAssistant 的现有骨架适合继续保留。
- 问题主要在完成闭环，不在基础调度能力。
- 不建议把普通通讯任务继续放进任务中心。
- 任务中心应该只承载需要回声和验收的任务。
- Agent 的伙伴感需要通过回声协议保留，不能变成纯 JSON 工单。
