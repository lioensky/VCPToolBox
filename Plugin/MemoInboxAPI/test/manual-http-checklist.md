# MemoInboxAPI HTTP 验证清单

## 创建与读取

```bash
curl -X POST "http://127.0.0.1:<PORT>/api/plugins/MemoInboxAPI/memos" \
  -H "Authorization: Bearer <API_Key>" \
  -H "Content-Type: application/json" \
  -d "{\"content\":\"测试 memo 文本\",\"tags\":[\"测试\",\"MemoInbox\"]}"
```

预期：
- 返回 `201`
- 响应包含 `memoId`

```bash
curl "http://127.0.0.1:<PORT>/api/plugins/MemoInboxAPI/memos/<memoId>" \
  -H "Authorization: Bearer <API_Key>"
```

预期：
- 返回 `200`
- `content` 与创建时一致

## 更新与删除

```bash
curl -X PATCH "http://127.0.0.1:<PORT>/api/plugins/MemoInboxAPI/memos/<memoId>" \
  -H "Authorization: Bearer <API_Key>" \
  -H "Content-Type: application/json" \
  -d "{\"content\":\"更新后的 memo\",\"tags\":[\"已更新\"]}"
```

预期：
- 返回 `200`
- `tags` 已更新

```bash
curl -X DELETE "http://127.0.0.1:<PORT>/api/plugins/MemoInboxAPI/memos/<memoId>" \
  -H "Authorization: Bearer <API_Key>"
```

预期：
- 返回 `204`

```bash
curl -X POST "http://127.0.0.1:<PORT>/api/plugins/MemoInboxAPI/memos/<memoId>/restore" \
  -H "Authorization: Bearer <API_Key>"
```

预期：
- 返回 `200`

## 列表、搜索、导入与维护

```bash
curl "http://127.0.0.1:<PORT>/api/plugins/MemoInboxAPI/memos?limit=20" \
  -H "Authorization: Bearer <API_Key>"
```

```bash
curl "http://127.0.0.1:<PORT>/api/plugins/MemoInboxAPI/search?q=MemoInbox" \
  -H "Authorization: Bearer <API_Key>"
```

```bash
curl -X POST "http://127.0.0.1:<PORT>/api/plugins/MemoInboxAPI/imports" \
  -H "Authorization: Bearer <API_Key>" \
  -H "Content-Type: application/json" \
  -d "{\"items\":[{\"content\":\"导入 memo\",\"tags\":[\"导入\"]}],\"mode\":\"insert\"}"
```

```bash
curl "http://127.0.0.1:<PORT>/api/plugins/MemoInboxAPI/maintenance/status" \
  -H "Authorization: Bearer <API_Key>"
```

```bash
curl -X POST "http://127.0.0.1:<PORT>/api/plugins/MemoInboxAPI/maintenance/reindex" \
  -H "Authorization: Bearer <API_Key>"
```

```bash
curl -X POST "http://127.0.0.1:<PORT>/api/plugins/MemoInboxAPI/maintenance/reconcile" \
  -H "Authorization: Bearer <API_Key>"
```

预期：
- 列表接口返回 `items`
- 搜索接口能按关键词返回结果
- 导入接口返回 `taskId`
- 维护状态返回数量统计

## RAG 集成验证

- 创建 memo 后观察 `KnowledgeBaseManager` 日志，确认新增文件被自动索引
- 软删除后确认原文件 `unlink` 被处理，索引结果消失
- 恢复后确认文件重新进入索引
- 在 Agent 对话中检索刚创建的 memo 内容，确认可被召回

## 错误响应格式

```bash
curl "http://127.0.0.1:<PORT>/api/plugins/MemoInboxAPI/memos/not-exists" \
  -H "Authorization: Bearer <API_Key>"
```

预期：

```json
{
  "error": {
    "code": "MEMO_NOT_FOUND",
    "message": "memo not found",
    "status": 404
  }
}
```
