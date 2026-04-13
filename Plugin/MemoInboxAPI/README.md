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

## 接口参数说明

## 1. 状态接口

### `GET /status`

无参数。

返回示例：

```json
{
  "status": "ok",
  "plugin": "MemoInboxAPI",
  "memoDiaryName": "MyMemos",
  "imageServerKeyConfigured": true
}
```

## 2. Memo CRUD

### `POST /memos`

创建一条 memo。

支持两种请求方式：

- `application/json`
- `multipart/form-data`

#### JSON Body 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `content` | `string` | 是 | memo 正文，不能为空 |
| `source` | `string` | 否 | 来源标记，默认 `api` |
| `tags` | `string[]` | 否 | 标签数组 |
| `imageUrls` | `string[]` | 否 | 图片 URL 列表，服务端会下载并保存 |
| `imageBase64` | `string[]` | 否 | Base64 图片列表，要求格式为 `data:image/...;base64,...` |

#### multipart/form-data 参数

除上面字段外，还支持直接上传文件：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `content` | `string` | 是 | memo 正文 |
| `source` | `string` | 否 | 来源标记 |
| `tags` | `string[] \| string` | 否 | 可传 JSON 数组字符串，或逗号分隔字符串 |
| `imageUrls` | `string[] \| string` | 否 | 可传 JSON 数组字符串，或逗号分隔字符串 |
| `imageBase64` | `string[] \| string` | 否 | 可传 JSON 数组字符串，或逗号分隔字符串 |
| 任意上传文件字段 | `file[]` | 否 | 插件通过 multer `.any()` 接收全部上传文件 |

#### 上传限制

- 单文件最大：`20MB`
- 最多文件数：`10`

#### 说明

- `content` 为空会返回 `400 INVALID_REQUEST`
- `tags`、`imageUrls`、`imageBase64` 支持：
  - 原生数组
  - JSON 字符串数组
  - 逗号分隔字符串
- 图片附件最终会写入：
  - `image/memo-inbox/YYYY/MM/DD/<memoId>-<seq>.<ext>`

#### 返回

成功返回 `201`，结构类似：

```json
{
  "memoId": "memo_xxx",
  "header": {
    "date": "2026-04-11",
    "maidName": "[MyMemos]MemoInbox"
  },
  "content": "memo content",
  "attachments": [
    "/pw=<Image_Key>/images/memo-inbox/2026/04/11/memo_xxx-1.png"
  ],
  "tags": ["tag1", "tag2"],
  "meta": {
    "memoId": "memo_xxx",
    "source": "api"
  },
  "createdAt": "2026-04-11T12:00:00.000Z",
  "updatedAt": "2026-04-11T12:00:00.000Z",
  "deleted": false,
  "filename": "2026-04-11-12_00_00-memo_xxx.txt"
}
```

### `GET /memos/:memoId`

按 ID 获取 memo。

#### Path 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `memoId` | `string` | 是 | memo ID |

返回：单条 memo 对象。  
若不存在，返回 `404 MEMO_NOT_FOUND`。

### `PATCH /memos/:memoId`

更新 memo 内容或标签。

#### Path 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `memoId` | `string` | 是 | memo ID |

#### Body 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `content` | `string` | 否 | 新正文 |
| `tags` | `string[]` | 否 | 新标签数组 |

#### 说明

- `content` 和 `tags` 至少要传一个
- 不支持通过该接口更新附件
- 如果两个都没传，返回 `400 INVALID_REQUEST`

返回：更新后的完整 memo 对象。

### `DELETE /memos/:memoId`

软删除 memo。

#### Path 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `memoId` | `string` | 是 | memo ID |

#### 说明

- 实际行为是把文件移动到 `.trash/`
- 成功返回 `204 No Content`

### `POST /memos/:memoId/restore`

从回收站恢复 memo。

#### Path 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `memoId` | `string` | 是 | memo ID |

返回：恢复后的完整 memo 对象。  
若不存在或不在回收站中，返回 `404 MEMO_NOT_FOUND`。

### `DELETE /memos/:memoId/purge`

彻底删除 memo。

#### Path 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `memoId` | `string` | 是 | memo ID |

#### 说明

- 会直接删除文件
- 无论 memo 当前在正常目录还是 `.trash/` 都可清除
- 成功返回 `204 No Content`

### `GET /memos`

分页列出未删除 memo。

#### Query 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `limit` | `number` | 否 | `20` | 返回条数，最大 `100` |
| `cursor` | `string` | 否 | - | 游标，实际使用文件名作为分页游标 |

#### 返回

```json
{
  "items": [],
  "nextCursor": "2026-04-11-12_00_00-memo_xxx.txt"
}
```

#### 说明

- 按文件名倒序返回，通常等价于按时间倒序
- `nextCursor` 为下一页游标，没有更多数据时为 `null`

### `GET /trash`

列出回收站中的 memo。

无参数。

返回：

```json
{
  "items": []
}
```

## 3. 搜索与回顾

### `GET /search`

搜索 memo。

#### Query 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `q` | `string` | 否 | `""` | 按正文做大小写不敏感包含搜索 |
| `tag` | `string` | 否 | `null` | 按标签精确匹配 |
| `from` | `string` | 否 | `null` | 起始日期，格式建议 `YYYY-MM-DD` |
| `to` | `string` | 否 | `null` | 结束日期，格式建议 `YYYY-MM-DD` |
| `limit` | `number` | 否 | `20` | 返回条数，最大 `100` |

#### 说明

- 当前搜索范围最多只会从最近 `100` 条 memo 中筛选
- `q` 只搜索 `content`
- `tag` 只匹配 `tags` 数组
- 日期过滤基于 `createdAt`
  - `from` 实际按 `YYYY-MM-DDT00:00:00.000Z`
  - `to` 实际按 `YYYY-MM-DDT23:59:59.999Z`

#### 返回

```json
{
  "items": []
}
```

### `GET /review/random`

随机回顾。

当前实现没有真正随机，而是返回列表中的第一条 memo。

无参数。

返回：单条 memo 对象。  
如果没有 memo，返回 `404 MEMO_NOT_FOUND`。

### `GET /review/daily`

每日回顾。

无参数。

说明：

当前实现会从最多 `100` 条 memo 中，选出 `createdAt` 最早的一条，并附加：

```json
{
  "reviewReason": "earliest_memo_for_daily_review"
}
```

返回：单条 memo 对象。  
如果没有 memo，返回 `404 MEMO_NOT_FOUND`。

## 4. 导入任务

### `POST /imports`

批量导入 memo，异步执行。

#### Body 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `items` | `object[]` | 是 | 待导入条目数组 |
| `mode` | `string` | 否 | 导入模式，默认 `insert` |

#### `items[]` 子项结构

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `content` | `string` | 建议是 | memo 正文 |
| `tags` | `string[]` | 否 | 标签数组 |
| `createdAt` | `string \| Date` | 否 | 指定创建时间 |
| `externalId` | `string` | 否 | 外部系统 ID，仅在失败信息中回显 |

#### 说明

- 当前实现里 `mode` 只会记录到任务 message 中，没有实际分支逻辑
- 导入时 `source` 会被写死为 `import`
- 附件当前不支持通过导入任务写入

#### 返回

成功接受任务时返回 `202`：

```json
{
  "taskId": "memo-task-xxx",
  "status": "accepted",
  "statusUrl": "/api/plugins/MemoInboxAPI/tasks/memo-task-xxx"
}
```

## 5. 任务查询与取消

### `GET /tasks/:taskId`

获取任务状态。

#### Path 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `taskId` | `string` | 是 | 任务 ID |

返回示例：

```json
{
  "taskId": "memo-task-xxx",
  "type": "memo_import",
  "status": "running",
  "progress": 50,
  "message": "processed 1/2",
  "result": {
    "imported": 1,
    "failed": 0
  },
  "error": null,
  "createdAt": "2026-04-11T12:00:00.000Z",
  "updatedAt": "2026-04-11T12:00:05.000Z"
}
```

#### 任务状态枚举

- `accepted`
- `running`
- `completed`
- `failed`
- `cancelled`

#### 任务类型示例

- `memo_import`
- `memo_reindex`
- `memo_reconcile`

### `GET /tasks/:taskId/errors`

获取任务错误列表。

#### Path 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `taskId` | `string` | 是 | 任务 ID |

返回示例：

```json
{
  "taskId": "memo-task-xxx",
  "errors": [
    {
      "index": 0,
      "externalId": "abc",
      "error": "some error"
    }
  ]
}
```

说明：

- 对导入任务，`errors` 里通常包含失败项的 `index`、`externalId`、`error`
- 对系统任务，通常为：

```json
[
  { "error": "..." }
]
```

### `POST /tasks/:taskId/cancel`

请求取消任务。

#### Path 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `taskId` | `string` | 是 | 任务 ID |

#### 说明

- 当前实现只是把任务状态直接更新为 `cancelled`
- 不会真正中断正在执行的后台逻辑
- 更准确地说，这是“标记取消”，不是“强制中止执行”

返回：更新后的任务对象。

## 6. 维护接口

### `GET /maintenance/status`

获取维护状态。

无参数。

返回示例：

```json
{
  "memoCount": 10,
  "trashCount": 2,
  "attachmentCount": 0,
  "indexCount": 12,
  "taskSummary": {
    "total": 3,
    "accepted": 0,
    "running": 1,
    "completed": 1,
    "failed": 0,
    "cancelled": 1
  },
  "paths": {
    "memoRootPath": "...",
    "memoTrashPath": "...",
    "memoImageRootPath": "..."
  }
}
```

说明：

- `attachmentCount` 当前固定返回 `0`
- `indexCount = memoCount + trashCount`

### `POST /maintenance/reindex`

触发重建索引任务。

无参数。

返回 `202`：

```json
{
  "taskId": "memo-task-xxx",
  "status": "accepted",
  "statusUrl": "/api/plugins/MemoInboxAPI/tasks/memo-task-xxx"
}
```

### `POST /maintenance/reconcile`

触发一致性检查/对账任务。

无参数。

返回 `202`：

```json
{
  "taskId": "memo-task-xxx",
  "status": "accepted",
  "statusUrl": "/api/plugins/MemoInboxAPI/tasks/memo-task-xxx"
}
```

任务完成后的 `result` 结构类似：

```json
{
  "status": "completed",
  "drift": {
    "missingMemoFiles": [],
    "trashFiles": [],
    "missingAttachments": []
  }
}
```

说明：

- 当前实现是占位版本，返回空 drift 结果，并未做真实扫描修复

## WebSocket 接入

连接地址：

```text
ws://<host>:<port>/vcp-memo-inbox/VCP_Key=<VCP_Key>
```

消息：

- 订阅任务：`memo_subscribe_task`
- 退订任务：`memo_unsubscribe_task`

### 客户端发送消息

#### 订阅任务

```json
{
  "type": "memo_subscribe_task",
  "data": {
    "taskId": "memo-task-xxx"
  }
}
```

#### 退订任务

```json
{
  "type": "memo_unsubscribe_task",
  "data": {
    "taskId": "memo-task-xxx"
  }
}
```

### 服务端推送事件

事件：

- `memo_task_accepted`
- `memo_task_progress`
- `memo_task_completed`
- `memo_task_failed`
- `memo_task_cancelled`

事件结构：

```json
{
  "type": "memo_task_progress",
  "data": {
    "taskId": "memo-task-xxx",
    "taskType": "memo_import",
    "status": "running",
    "progress": 50,
    "message": "processed 1/2",
    "result": {
      "imported": 1,
      "failed": 0
    },
    "error": null,
    "createdAt": "2026-04-11T12:00:00.000Z",
    "updatedAt": "2026-04-11T12:00:05.000Z"
  }
}
```

断线回退：

- 使用 `GET /tasks/:taskId` 轮询最终状态

## 图片行为

当前支持：

- `data:image/...;base64,...`
- URL 下载输入
- multipart 文件上传

图片存储路径：

```text
image/memo-inbox/YYYY/MM/DD/<memoId>-<seq>.<ext>
```

ImageServer URL 形态：

```text
/pw=<Image_Key>/images/memo-inbox/YYYY/MM/DD/<memoId>-<seq>.<ext>
```

补充说明：

- URL 下载超时时间约为 `10s`
- URL 下载大小上限为 `20MB`
- 不支持的图片类型会返回内部错误，底层错误通常为 `UNSUPPORTED_IMAGE_TYPE`
- Base64 图片格式不合法时，底层错误通常为 `INVALID_BASE64_IMAGE`

## 返回对象说明

### Memo 对象

大多数 memo 相关接口返回统一结构：

| 字段 | 类型 | 说明 |
|---|---|---|
| `memoId` | `string` | memo ID |
| `header` | `object` | 文件头信息 |
| `header.date` | `string` | 头部日期 |
| `header.maidName` | `string` | maid 名称 |
| `content` | `string` | memo 正文 |
| `attachments` | `string[]` | 附件 URL 列表 |
| `tags` | `string[]` | 标签列表 |
| `meta` | `object` | 元信息，通常包含 `memoId`、`source` |
| `createdAt` | `string` | ISO 时间 |
| `updatedAt` | `string` | ISO 时间 |
| `deleted` | `boolean` | 是否已进入回收站 |
| `filename` | `string` | 底层文件名 |

### Task 对象

任务接口返回统一结构：

| 字段 | 类型 | 说明 |
|---|---|---|
| `taskId` | `string` | 任务 ID |
| `type` | `string` | 任务类型 |
| `status` | `string` | 任务状态 |
| `progress` | `number` | 进度百分比 |
| `message` | `string` | 状态消息 |
| `result` | `object \| null` | 任务结果 |
| `error` | `array \| null` | 错误列表 |
| `createdAt` | `string` | 创建时间 |
| `updatedAt` | `string` | 更新时间 |

## RAG 集成

- memo 文本文件写入 `dailynote/MyMemos/`
- `KnowledgeBaseManager` 会自动监听并索引该目录
- `.trash/` 是点目录，会被 watcher 忽略，适合作为软删除目录
- 走 `DailyNoteWrite` 路径时可复用既有 Tag 生成逻辑

## 当前实现说明

以下行为是当前实现状态，后续可能继续演进：

1. `GET /review/random` 当前并不真正随机，而是返回列表第一条。
2. `POST /tasks/:taskId/cancel` 当前只会更新任务状态，不会真正停止后台执行逻辑。
3. `GET /search` 当前只会从最多 `100` 条 memo 中筛选，不是全量索引搜索。
4. `POST /imports` 的 `mode` 参数当前只做记录，不影响实际导入策略。
5. `PATCH /memos/:memoId` 当前只能修改 `content` 和 `tags`，不能修改附件或 `source`。
6. `GET /maintenance/status` 中的 `attachmentCount` 当前固定为 `0`。
7. `POST /maintenance/reconcile` 当前为占位实现，返回空 drift 结果。
