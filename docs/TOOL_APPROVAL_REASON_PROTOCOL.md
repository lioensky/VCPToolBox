# 工具调用审核反馈字段适配说明

本文档用于前端应用、管理面板、VCPChat、VCPLog 客户端等适配工具调用人工审核的文本反馈能力。

## 背景

后端工具审核 WebSocket 协议已在原有确认/拒绝基础上，新增可选字段 `reason`。

该字段允许用户在点击通过或拒绝时，额外输入一段文本，说明本次审核决策的原因。

## 协议兼容性

这是一个向后兼容改动。

旧客户端仍然可以只发送：

```json
{
  "type": "tool_approval_response",
  "data": {
    "requestId": "approve-xxx",
    "approved": false
  }
}
```

新客户端可以额外发送：

```json
{
  "type": "tool_approval_response",
  "data": {
    "requestId": "approve-xxx",
    "approved": false,
    "reason": "这个命令风险太高，请先列出影响范围"
  }
}
```

## 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | 是 | 固定为 `tool_approval_response` |
| `data.requestId` | string | 是 | 后端下发的审核请求 ID |
| `data.approved` | boolean | 是 | 是否批准本次工具调用 |
| `data.reason` | string | 否 | 用户输入的审核说明文本 |

## 后端行为

### 拒绝并通知 AI

当 `approved` 为 `false`，且该工具规则允许把拒绝结果通知 AI 时：

```json
{
  "plugin_error": "Manual approval was REJECTED by user. User reason: 这个命令风险太高，请先列出影响范围"
}
```

AI 可以根据该原因调整下一次工具调用。

### 拒绝但静默处理

当工具审核规则配置为静默拒绝时，只有未填写 `reason` 的拒绝保持静默。

用户明确填写反馈时，反馈优先于静默规则，仍会返回给 AI，便于模型修正后续行为。

### 批准并附带说明

当 `approved` 为 `true` 且传入非空 `reason` 时，后端继续执行原工具调用，并将说明作为明确标注来源的用户审核留言回传给 AI。留言不进入插件执行参数，也不会改变工具成功/失败状态。

回执格式兼容规则：

- 旧格式回执：在最终文本尾部追加审核留言。
- 标准 OpenAI 内容数组（裸数组、`content` 或 `data.content` 包装）：只在最后一个 `type: "text"` 块的 `text` 尾部追加；没有文本块时，在数组末尾新增文本块。
- `image_url` 以及其他非文本块的字段、内容和顺序保持不变，绝不把多模态数组整体字符串化。
- 工具执行失败时，允许留言仍随错误回执返回。
- `archery` / `archery: no_reply` 成功时，只将用户审核留言回灌给 AI，不额外回灌成功业务输出；未填写留言时保留原有静默行为。
- 留言随回执经过现有隐私保护过滤。

追加文本使用独立来源标记：

> 【用户审核留言：已允许本次工具调用】
>
> 用户输入的说明……

用户留言会在本次工具执行结束或免回执接收确认后进入后续模型请求，并非在工具执行前要求模型重新规划。

## 前端建议

建议在审核弹窗中增加一个可选文本框：

- placeholder 可使用：`可选：告诉 AI 为什么通过或拒绝`
- 拒绝时建议鼓励用户填写原因
- 通过时原因可选，不建议强制填写
- 文本建议限制在 500 到 1000 字以内
- 发送前建议执行 `trim`
- 空字符串可以不发送 `reason` 字段

## 推荐交互

### 用户点击拒绝

```js
ws.send(JSON.stringify({
  type: 'tool_approval_response',
  data: {
    requestId,
    approved: false,
    reason: reasonInput.trim()
  }
}));
```

### 用户点击通过

```js
ws.send(JSON.stringify({
  type: 'tool_approval_response',
  data: {
    requestId,
    approved: true,
    reason: reasonInput.trim()
  }
}));
```

如果 `reasonInput.trim()` 为空，也可以省略 `reason`：

```js
const data = {
  requestId,
  approved
};

const reason = reasonInput.trim();
if (reason) {
  data.reason = reason;
}

ws.send(JSON.stringify({
  type: 'tool_approval_response',
  data
}));
```

## 安全与产品建议

- 不要在前端把 `reason` 当成必须字段。
- 通过留言应明确标注为用户审核反馈，而不是插件产生的业务输出。
- 通过和拒绝理由都会进入 AI 上下文，前端应避免自动填入敏感信息。
- 对危险工具，例如 Shell、文件删除、批量修改、远程分布式执行，建议在拒绝时提示用户填写可执行的修正建议。
- 对静默拒绝场景，填写原因表示用户希望向 AI 反馈；仅空原因维持静默。

## 当前后端实现位置

- WebSocket 审核响应解析：`WebSocketServer.js`
- 审核决策处理：`Plugin.js`

## 最小适配结论

前端只需要在原有审核响应包的 `data` 内可选增加：

```json
{
  "reason": "用户输入的审核说明"
}
```

不传该字段时，行为与旧版本完全一致。