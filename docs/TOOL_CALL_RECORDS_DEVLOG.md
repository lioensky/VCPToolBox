# 工具调用记录系统开发日志

## 1. 开发目标

本次新增“工具调用记录系统”，用于持久化 VCP 工具调用事件，方便后续通过管理面板查看、检索、清理和配置记录策略。

核心目标：

- 使用项目已有 `better-sqlite3` 依赖。
- 不复用知识库 / KDB / RAG 数据库，改为独立 SQLite 数据库。
- 数据库与配置文件统一放在根目录 `config/` 文件夹。
- 记录工具调用的完整生命周期：
  - 记录 ID
  - 调用者署名 `maid` / `valet`
  - 工具名
  - 发起时间
  - 调用内容
  - 返回时间
  - 返回内容
  - 成功 / 失败 / 拒绝
  - 请求 IP / 来源节点
  - 多模态标记
- 新增同步查询工具，允许 AI 通过记录 ID 或条件查询历史调用。
- 管理接口预留给后续 AdminPanel 配置管理页接入。
- 开启记录功能时，工具调用摘要中追加记录 ID，方便 AI 后续查询详情。

---

## 2. 新增与修改文件

### 2.1 新增文件

| 文件 | 作用 |
|------|------|
| `modules/toolCallRecordStore.js` | 工具调用记录核心模块，负责配置、SQLite 表、写入、查询、清理、热加载 |
| `routes/admin/toolCallRecords.js` | 管理端 API 路由，供后续面板配置和查询 |
| `Plugin/ToolCallRecordQuery/ToolCallRecordQuery.js` | 同步查询工具入口 |
| `Plugin/ToolCallRecordQuery/plugin-manifest.json` | 查询工具插件声明 |
| `docs/TOOL_CALL_RECORDS_DEVLOG.md` | 本开发日志 |

### 2.2 修改文件

| 文件 | 修改点 |
|------|--------|
| `server.js` | 初始化 / 关闭 `toolCallRecordStore` |
| `routes/adminPanelRoutes.js` | 挂载 `toolCallRecords` 管理路由 |
| `modules/vcpLoop/toolExecutor.js` | VCP-loop 工具执行链路写入记录，返回结果附加 `recordId` |
| `Plugin.js` | 直接工具调用链路写入记录，覆盖 `/v1/human/tool` 等非 loop 入口 |
| `modules/handlers/streamHandler.js` | 流式工具调用摘要追加记录 ID |
| `modules/handlers/nonStreamHandler.js` | 非流式工具调用摘要追加记录 ID |
| `.gitignore` | 忽略 `.sqlite3`、`.sqlite3-shm`、`.sqlite3-wal` 运行文件 |

---

## 3. 数据文件与配置文件

系统运行后会自动创建：

```text
config/tool-call-records.config.json
config/tool-call-records.sqlite3
config/tool-call-records.sqlite3-shm
config/tool-call-records.sqlite3-wal
```

其中：

- `tool-call-records.config.json` 是热配置文件。
- `tool-call-records.sqlite3` 是主数据库。
- `tool-call-records.sqlite3-shm` / `tool-call-records.sqlite3-wal` 是 SQLite WAL 模式运行文件，已加入 `.gitignore`。

---

## 4. 配置结构

配置文件路径：

```text
config/tool-call-records.config.json
```

默认配置：

```json
{
  "enabled": false,
  "retentionDays": 30,
  "autoCleanupEnabled": true,
  "cleanupIntervalMinutes": 1440,
  "maxQueryLimit": 100,
  "defaultQueryLimit": 20,
  "captureMultimodal": true,
  "summarizeLargePayloadsInList": true,
  "listPayloadPreviewChars": 1200,
  "excludeTools": ["ToolCallRecordQuery"]
}
```

字段说明：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `false` | 记录总开关。关闭时不写入新的工具调用记录 |
| `retentionDays` | number | `30` | 保留天数。`<=0` 表示不按时间过期 |
| `autoCleanupEnabled` | boolean | `true` | 是否启用自动清理过期记录 |
| `cleanupIntervalMinutes` | number | `1440` | 自动清理周期，单位分钟 |
| `maxQueryLimit` | number | `100` | 查询接口允许的最大返回条数 |
| `defaultQueryLimit` | number | `20` | 未指定 `limit` 时默认返回条数 |
| `captureMultimodal` | boolean | `true` | 是否保存多模态返回内容。关闭时会脱敏 `data:image/*` |
| `summarizeLargePayloadsInList` | boolean | `true` | 列表查询是否截断大字段预览 |
| `listPayloadPreviewChars` | number | `1200` | 列表预览截断字符数 |
| `excludeTools` | string[] | `["ToolCallRecordQuery"]` | 不记录的工具名列表，避免查询器自查询污染 |

### 热加载行为

`modules/toolCallRecordStore.js` 会通过 `chokidar` 监听配置文件：

- 配置变更后自动刷新内存配置。
- `cleanupIntervalMinutes`、`autoCleanupEnabled` 等清理相关字段会自动重建定时清理任务。
- 管理 API 保存配置后无需重启服务。

---

## 5. SQLite 表结构

表名：

```sql
tool_call_records
```

主要字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PRIMARY KEY | 记录 ID，格式类似 `tcr-时间戳-uuid` |
| `tool_name` | TEXT | 工具名 |
| `caller_signature` | TEXT | 调用者署名，优先取 `maid`，其次取 `valet` |
| `caller_type` | TEXT | `maid` / `valet` |
| `request_ip` | TEXT | 请求 IP |
| `source_node` | TEXT | 来源节点 / 来源入口 |
| `started_at` | TEXT | ISO 发起时间 |
| `started_at_ms` | INTEGER | 发起时间毫秒时间戳 |
| `finished_at` | TEXT | ISO 返回时间 |
| `finished_at_ms` | INTEGER | 返回时间毫秒时间戳 |
| `duration_ms` | INTEGER | 调用耗时 |
| `status` | TEXT | `running` / `success` / `failure` |
| `success` | INTEGER | `1` 成功，`0` 失败 |
| `call_content_json` | TEXT | 调用内容 JSON |
| `return_content_json` | TEXT | 返回内容 JSON |
| `error_text` | TEXT | 错误文本 |
| `has_multimodal` | INTEGER | 是否包含多模态内容 |
| `created_at` | TEXT | 创建时间 |
| `updated_at` | TEXT | 更新时间 |

已建立索引：

- `started_at_ms`
- `tool_name`
- `caller_signature`
- `status`
- `success`

---

## 6. 记录语义

### 6.1 正常工具调用

当工具正常完成时：

- `status = "success"`
- `success = 1`
- `return_content_json` 保存完整返回对象
- VCP-loop 结果对象会附加：
  - `recordId`
  - `raw.tool_call_record_id`

### 6.2 工具执行失败

工具执行失败时：

- `status = "failure"`
- `success = 0`
- `return_content_json` 保存错误结构 / 错误返回内容
- `error_text` 保存错误文本

### 6.3 人工审核拒绝

人工审核拒绝仍然视为一次已发起的工具调用事件，必须入库。

#### 普通拒绝

普通拒绝由原异常流程进入失败记录，返回内容含：

```json
{
  "plugin_error": "Manual approval was REJECTED by user...",
  "error_type": "approval_rejected",
  "rejected_by_user": true
}
```

#### 静默拒绝

静默拒绝不会提示 AI，但仍写入数据库：

```json
{
  "status": "rejected",
  "success": false,
  "silentRejected": true,
  "error_type": "approval_rejected",
  "rejected_by_user": true,
  "message": "Tool call \"xxx\" was rejected silently by manual approval."
}
```

记录状态：

```text
status = failure
success = 0
```

### 6.4 异步 no-reply

异步 no-reply 的语义是“AI 看不到工具返回 / 不触发二次 loop”，不是“不记录”。

因此：

- 仍完整入库。
- 记录实际收到的 no-reply 初始结果。
- `tool_call_record_id` 会注入到返回对象。
- 不因 no-reply 裁剪数据库内容。

---

## 7. 新的工具调用摘要结构

当记录开关开启并成功创建记录时，工具摘要中的每个工具状态项会追加记录 ID。

### 7.1 流式摘要

位置：

- `modules/handlers/streamHandler.js`

摘要文本格式：

```text
[本轮工具调用摘要:]
UrlFetch 调用成功 (记录ID: tcr-1783312348333-83cc1cb6-a3b5-4aa8-b810-2daa5788669b)；VSearch 调用失败 (记录ID: tcr-...)
[本轮工具调用摘要结束]
```

Archery 异步错误摘要：

```text
SomeAsyncTool 调用失败 (记录ID: tcr-...)
```

### 7.2 非流式摘要

位置：

- `modules/handlers/nonStreamHandler.js`

摘要文本格式同流式：

```text
[本轮工具调用摘要:]
ServerSearchController 调用成功 (记录ID: tcr-1783312348333-83cc1cb6-a3b5-4aa8-b810-2daa5788669b)。
[本轮工具调用摘要结束]
```

### 7.3 状态文案

原有状态文案保持不变，只追加记录 ID：

| 原状态 | 新示例 |
|--------|--------|
| `调用成功` | `工具名 调用成功 (记录ID: tcr-...)` |
| `调用失败` | `工具名 调用失败 (记录ID: tcr-...)` |
| `调用拒绝` | `工具名 调用拒绝 (记录ID: tcr-...)` |
| `调用超时` | `工具名 调用超时 (记录ID: tcr-...)` |

### 7.4 记录 ID 的用途

AI 可以复制摘要中的记录 ID，调用 `ToolCallRecordQuery` 查询完整调用参数和返回内容。

---

## 8. 同步查询工具：ToolCallRecordQuery

插件目录：

```text
Plugin/ToolCallRecordQuery/
```

### 8.1 工具名

```text
ToolCallRecordQuery
```

### 8.2 支持参数

| 参数 | 别名 | 说明 |
|------|------|------|
| `id` | `recordId`, `record_id` | 精确查询记录 ID |
| `from` | `startTime`, `start_time`, `startedAfter` | 起始时间 |
| `to` | `endTime`, `end_time`, `startedBefore` | 结束时间 |
| `callerSignature` | `caller`, `maid`, `valet` | 调用者署名模糊查询 |
| `callerType` | `caller_type` | `maid` / `valet` |
| `toolName` | `tool_name`, `tool` | 工具名模糊查询 |
| `success` | - | 成功 / 失败，可传 `true` / `false` |
| `status` | - | `running` / `success` / `failure` |
| `search` | `keyword`, `q` | 全字段模糊搜索 |
| `limit` | - | 返回条数 |
| `offset` | - | 分页偏移 |
| `order` | - | `desc` / `asc` |
| `detail` | - | 是否返回完整详情 |

### 8.3 查询示例

按摘要 ID 查询完整详情：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」ToolCallRecordQuery「末」,
id:「始」tcr-1783312348333-83cc1cb6-a3b5-4aa8-b810-2daa5788669b「末」,
detail:「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

按调用者和工具名查询：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」ToolCallRecordQuery「末」,
caller:「始」Nova「末」,
toolName:「始」UrlFetch「末」,
limit:「始」20「末」
<<<[END_TOOL_REQUEST]>>>
```

按时间范围和关键词查询：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」ToolCallRecordQuery「末」,
from:「始」2026-07-06T00:00:00+08:00「末」,
to:「始」2026-07-06T23:59:59+08:00「末」,
search:「始」图片生成「末」,
detail:「始」false「末」
<<<[END_TOOL_REQUEST]>>>
```

### 8.4 返回结构

插件返回 stdio 标准结构：

```json
{
  "status": "success",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{ ...格式化后的查询结果 JSON... }"
      }
    ],
    "query": {
      "toolName": "UrlFetch",
      "callerSignature": "Nova",
      "detail": false
    },
    "status": "success",
    "total": 1,
    "limit": 20,
    "offset": 0,
    "records": []
  }
}
```

单条记录结构：

```json
{
  "id": "tcr-1783312348333-83cc1cb6-a3b5-4aa8-b810-2daa5788669b",
  "toolName": "UrlFetch",
  "callerSignature": "Nova",
  "callerType": "maid",
  "requestIp": "127.0.0.1",
  "sourceNode": "post",
  "startedAt": "2026-07-06T04:32:28.331Z",
  "finishedAt": "2026-07-06T04:32:28.338Z",
  "durationMs": 7,
  "status": "success",
  "success": true,
  "callContent": {
    "tool_name": "UrlFetch",
    "arguments": {}
  },
  "returnContent": {},
  "errorText": null,
  "hasMultimodal": false
}
```

---

## 9. 后台管理 API

所有接口挂载在现有管理 API 下：

```text
/admin_api
```

由 `routes/admin/toolCallRecords.js` 提供。

### 9.1 获取状态

```http
GET /admin_api/tool-call-records/status
```

返回：

```json
{
  "status": "success",
  "store": {
    "initialized": true,
    "enabled": false,
    "configPath": "h:\\VCP\\VCPMain\\VCPToolBox\\config\\tool-call-records.config.json",
    "dbPath": "h:\\VCP\\VCPMain\\VCPToolBox\\config\\tool-call-records.sqlite3",
    "watcherActive": true,
    "autoCleanupEnabled": true,
    "retentionDays": 30,
    "cleanupIntervalMinutes": 1440,
    "lastLoadError": null
  }
}
```

### 9.2 获取配置

```http
GET /admin_api/tool-call-records/config
```

返回：

```json
{
  "status": "success",
  "config": {
    "enabled": false,
    "retentionDays": 30,
    "autoCleanupEnabled": true,
    "cleanupIntervalMinutes": 1440,
    "maxQueryLimit": 100,
    "defaultQueryLimit": 20,
    "captureMultimodal": true,
    "summarizeLargePayloadsInList": true,
    "listPayloadPreviewChars": 1200,
    "excludeTools": ["ToolCallRecordQuery"]
  }
}
```

### 9.3 保存配置

```http
POST /admin_api/tool-call-records/config
Content-Type: application/json
```

请求体可用两种形式：

```json
{
  "config": {
    "enabled": true,
    "retentionDays": 60
  }
}
```

或直接传配置对象：

```json
{
  "enabled": true,
  "retentionDays": 60
}
```

返回：

```json
{
  "status": "success",
  "message": "工具调用记录配置已保存并热更新。",
  "config": {}
}
```

### 9.4 查询记录列表

```http
GET /admin_api/tool-call-records
```

支持 query 参数：

| Query | 说明 |
|-------|------|
| `id` | 精确记录 ID |
| `toolName` / `tool_name` | 工具名模糊查询 |
| `callerSignature` / `caller` / `maid` / `valet` | 署名模糊查询 |
| `callerType` / `caller_type` | `maid` / `valet` |
| `status` | `running` / `success` / `failure` |
| `success` | `true` / `false` |
| `from` / `startFrom` | 起始时间 |
| `to` / `endTo` | 结束时间 |
| `search` / `q` | 全字段搜索 |
| `limit` | 返回条数 |
| `offset` | 分页偏移 |
| `order` | `desc` / `asc` |
| `detail` | `true` 返回完整内容 |

示例：

```http
GET /admin_api/tool-call-records?toolName=UrlFetch&caller=Nova&limit=20&detail=false
```

返回：

```json
{
  "status": "success",
  "total": 1,
  "limit": 20,
  "offset": 0,
  "records": []
}
```

### 9.5 查询单条详情

```http
GET /admin_api/tool-call-records/:id
```

示例：

```http
GET /admin_api/tool-call-records/tcr-1783312348333-83cc1cb6-a3b5-4aa8-b810-2daa5788669b
```

返回：

```json
{
  "status": "success",
  "record": {}
}
```

不存在时：

```json
{
  "status": "error",
  "error": "Record not found."
}
```

HTTP 状态码为 `404`。

### 9.6 一键清理过期记录

```http
POST /admin_api/tool-call-records/cleanup-expired
```

根据当前配置 `retentionDays` 删除过期记录。

返回：

```json
{
  "status": "success",
  "deleted": 12,
  "cutoff": "2026-06-06T00:00:00.000Z",
  "retentionDays": 30,
  "message": "已清理 12 条过期工具调用记录。"
}
```

当 `retentionDays <= 0`：

```json
{
  "status": "success",
  "deleted": 0,
  "skipped": true,
  "reason": "retentionDays<=0",
  "message": "未配置过期时间，已跳过清理。"
}
```

### 9.7 一键清空记录

```http
POST /admin_api/tool-call-records/clear-all
Content-Type: application/json
```

请求体：

```json
{
  "confirm": true
}
```

返回：

```json
{
  "status": "success",
  "deleted": 100,
  "message": "已清空 100 条工具调用记录。"
}
```

未确认时返回 `400`：

```json
{
  "status": "error",
  "error": "clear-all requires { \"confirm\": true }."
}
```

---

## 10. 后续 AdminPanel 页面适配建议

建议新增一个“工具调用记录”管理页，包含三个区域。

### 10.1 状态卡片

调用：

```http
GET /admin_api/tool-call-records/status
```

展示：

- 当前开关状态
- 数据库路径
- 配置路径
- watcher 是否活跃
- 保留天数
- 自动清理周期
- 上次加载错误

### 10.2 配置管理区

调用：

```http
GET /admin_api/tool-call-records/config
POST /admin_api/tool-call-records/config
```

建议表单项：

| 控件 | 对应字段 |
|------|----------|
| 开关 | `enabled` |
| 数字输入 | `retentionDays` |
| 开关 | `autoCleanupEnabled` |
| 数字输入 | `cleanupIntervalMinutes` |
| 数字输入 | `maxQueryLimit` |
| 数字输入 | `defaultQueryLimit` |
| 开关 | `captureMultimodal` |
| 开关 | `summarizeLargePayloadsInList` |
| 数字输入 | `listPayloadPreviewChars` |
| 标签输入 | `excludeTools` |

保存后展示返回 message。

### 10.3 查询与详情区

列表接口：

```http
GET /admin_api/tool-call-records
```

详情接口：

```http
GET /admin_api/tool-call-records/:id
```

建议筛选项：

- 时间范围
- 工具名
- 调用者署名
- 调用者类型
- 成功 / 失败
- 状态
- 全文搜索
- 是否详情模式
- limit / offset

建议列表列：

| 列 | 字段 |
|----|------|
| 记录 ID | `id` |
| 工具名 | `toolName` |
| 调用者 | `callerSignature` |
| 调用者类型 | `callerType` |
| 开始时间 | `startedAt` |
| 耗时 | `durationMs` |
| 状态 | `status` |
| 成功 | `success` |
| 多模态 | `hasMultimodal` |
| 操作 | 查看详情 |

详情弹窗展示：

- 调用参数 `callContent`
- 返回内容 `returnContent`
- 错误文本 `errorText`
- 请求来源 `requestIp` / `sourceNode`

### 10.4 危险操作区

清理过期：

```http
POST /admin_api/tool-call-records/cleanup-expired
```

清空全部：

```http
POST /admin_api/tool-call-records/clear-all
```

`clear-all` 必须二次确认，并传：

```json
{
  "confirm": true
}
```

---

## 11. 验证记录

已执行基础验证：

```bash
node --check Plugin.js
node --check modules/vcpLoop/toolExecutor.js
node --check modules/toolCallRecordStore.js
node --check routes/admin/toolCallRecords.js
node --check Plugin/ToolCallRecordQuery/ToolCallRecordQuery.js
node --check modules/handlers/streamHandler.js
node --check modules/handlers/nonStreamHandler.js
node --check server.js
```

执行结果：语法检查通过。

已执行写入 / 查询冒烟测试：

- 临时开启 `enabled`
- 写入一条测试记录
- 按工具名和 `maid` 查询
- 查询结果包含记录 ID、调用者署名、调用内容、返回内容
- 恢复原配置为默认关闭

---

## 12. 注意事项

1. `ToolCallRecordQuery` 默认被加入 `excludeTools`，避免查询器查询自身时产生无限污染记录。
2. 如果未来希望记录查询器自身调用，可从 `excludeTools` 删除 `ToolCallRecordQuery`。
3. `captureMultimodal = true` 时会完整保存 `image_url` / data URI 等多模态返回；这可能增加数据库体积。
4. `captureMultimodal = false` 时，返回中的 `data:image/*` 会脱敏为占位文本。
5. 列表查询默认可能截断大字段，详情查询不会截断。
6. 异步 no-reply 不影响入库，只影响 AI 是否看到返回。
7. 人工审核拒绝也会入库，代表“AI 发起了调用但被系统/用户拒绝”。