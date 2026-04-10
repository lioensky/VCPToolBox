# MemoInboxAPI WebSocket 验证清单

## 建连

连接地址：

```text
ws://127.0.0.1:<PORT>/vcp-memo-inbox/VCP_Key=<VCP_Key>
```

预期：
- 连接成功

## 订阅任务

发送：

```json
{
  "type": "memo_subscribe_task",
  "data": {
    "taskId": "<taskId>"
  }
}
```

预期：
- 导入任务状态变化时能收到：
  - `memo_task_accepted`
  - `memo_task_progress`
  - `memo_task_completed`

## 退订任务

发送：

```json
{
  "type": "memo_unsubscribe_task",
  "data": {
    "taskId": "<taskId>"
  }
}
```

预期：
- 后续不再收到该任务事件

## HTTP 回退

断线后使用：

```bash
curl "http://127.0.0.1:<PORT>/api/plugins/MemoInboxAPI/tasks/<taskId>" \
  -H "Authorization: Bearer <API_Key>"
```

预期：
- 仍可查询任务最终状态
