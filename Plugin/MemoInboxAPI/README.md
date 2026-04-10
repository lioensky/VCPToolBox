# MemoInboxAPI

`MemoInboxAPI` 是一个 `hybridservice` 插件，统一承载 memo 的 HTTP API、任务注册表、WebSocket 推送、搜索与维护接口。

挂载路径：

```text
/api/plugins/MemoInboxAPI
```

认证方式：

- Bearer 认证由 `server.js` 全局中间件统一处理
- 插件层不重复实现鉴权

## HTTP 接口

基础 CRUD：

- `POST /memos`
- `GET /memos/:memoId`
- `PATCH /memos/:memoId`
- `DELETE /memos/:memoId`
- `POST /memos/:memoId/restore`
- `DELETE /memos/:memoId/purge`
- `GET /memos`
- `GET /trash`

搜索与回顾：

- `GET /search`
- `GET /review/random`
- `GET /review/daily`

导入与维护：

- `POST /imports`
- `GET /tasks/:taskId`
- `GET /tasks/:taskId/errors`
- `POST /tasks/:taskId/cancel`
- `GET /maintenance/status`
- `POST /maintenance/reindex`
- `POST /maintenance/reconcile`

统一错误响应：

```json
{
  "error": {
    "code": "MEMO_NOT_FOUND",
    "message": "memo not found",
    "status": 404
  }
}
```

## WebSocket 接入

连接地址：

```text
ws://<host>:<port>/vcp-memo-inbox/VCP_Key=<VCP_Key>
```

消息：

- 订阅任务：`memo_subscribe_task`
- 退订任务：`memo_unsubscribe_task`

事件：

- `memo_task_accepted`
- `memo_task_progress`
- `memo_task_completed`
- `memo_task_failed`
- `memo_task_cancelled`

断线回退：

- 使用 `GET /tasks/:taskId` 轮询最终状态

## 图片行为

当前支持：

- `data:image/...;base64,...`
- URL 下载输入的存储逻辑已实现

图片存储路径：

```text
image/memo-inbox/YYYY/MM/DD/<memoId>-<seq>.<ext>
```

ImageServer URL 形态：

```text
/pw=<Image_Key>/images/memo-inbox/YYYY/MM/DD/<memoId>-<seq>.<ext>
```

## RAG 集成

- memo 文本文件写入 `dailynote/MyMemos/`
- `KnowledgeBaseManager` 会自动监听并索引该目录
- `.trash/` 是点目录，会被 watcher 忽略，适合作为软删除目录
- 走 `DailyNoteWrite` 路径时可复用既有 Tag 生成逻辑
