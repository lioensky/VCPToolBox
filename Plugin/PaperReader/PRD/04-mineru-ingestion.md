# 04. MinerU Ingestion

> 状态: Implemented (MinerU v4 + pdf-parse fallback)
> 所属: PaperReader Rust DDD PRD

---

## 1. 核心原则

本系统的解析前端以 **MinerU** 为主路径，但允许在缺少 Token 或外部依赖不可用时降级，以保证插件可用性与门禁可复现。

架构裁决：

- 当 `MINERU_API_TOKEN` 存在时：优先走 MinerU v4（高保真解析，适配公式/表格/多栏/OCR 等复杂情况）
- 当 `MINERU_API_TOKEN` 缺失时：允许降级到 `pdf-parse` 纯文本模式（低保真，但可用）
- `PAPERREADER_FORCE_DETERMINISTIC=1` 时：强制离线可复现路径（用于 smoke/门禁）

---

## 2. 支持范围的定义方式

“多文档兼容”在本系统中的含义是：

- 凡是 MinerU 可处理并返回结构化结果的输入，都可以进入统一文档流
- 不再把系统能力定义为“支持 PDF”，而是定义为“支持 MinerU 可解析的长文档/长文本输入”

因此输入类型不是按我们自己手写 parser 决定，而是按 MinerU 能力边界决定。

---

## 3. MinerU API 模式选择

根据官方文档，MinerU 当前提供两组 API：

- **精准解析 API**：需要 Token，支持单文件、批量、Zip 结果、多格式导出、文件上限 200MB / 600 页
- **Agent 轻量解析 API**：免登录，轻量快速，但仅输出 Markdown，文件上限 10MB / 20 页，更适合轻量 Agent 场景

对新系统的设计裁决：

- **主路径采用精准解析 API（v4）**
- Agent 轻量 API 只作为未来可选的特殊模式，不作为核心架构基线

原因：

- 我们需要的不只是 Markdown，而是结构化结果、Zip 工件、多格式导出和更高上限
- 新系统目标包含单文档深读与多文档归纳，必须以高保真解析为基础
- 轻量 API 更像“快速通道”，不适合作为系统宪法层接口

建议优先覆盖的 v4 接口：

- `POST /api/v4/extract/task`
- `GET /api/v4/extract/task/{task_id}`
- `POST /api/v4/file-urls/batch`
- `POST /api/v4/extract/task/batch`
- `GET /api/v4/extract-results/batch/{batch_id}`

---

## 4. 官方调用流程约束

### 4.1 认证

精准解析 API 统一要求：

- `Authorization: Bearer <TOKEN>`
- `Content-Type: application/json`

错误码层面，必须特殊处理：

- `A0202`：Token 错误
- `A0211`：Token 过期

### 4.2 单文档 URL 提交

适合远程文件场景：

1. `POST /api/v4/extract/task`
2. body 中传 `url` 与 `model_version`
3. 返回 `task_id`
4. 轮询 `GET /api/v4/extract/task/{task_id}`
5. `state=done` 后读取 `full_zip_url`

### 4.3 本地文件上传

适合本地文件场景：

1. `POST /api/v4/file-urls/batch`
2. 获取 `batch_id` 与 `file_urls`
3. 对返回的 OSS URL 执行 `PUT` 上传
4. 系统自动提交解析任务
5. 轮询 `GET /api/v4/extract-results/batch/{batch_id}``

### 4.4 批量 URL 提交

适合远程多文档集合场景：

1. `POST /api/v4/extract/task/batch`
2. 获取 `batch_id`
3. 轮询 `GET /api/v4/extract-results/batch/{batch_id}`

---

## 5. 模型版本与文档类型策略

根据官方文档，`model_version` 关键选项为：

- `pipeline`
- `vlm`
- `MinerU-HTML`

新系统建议策略：

- **HTML 输入**：强制使用 `MinerU-HTML`
- **非 HTML 输入**：默认使用 `vlm`
- `pipeline` 保留为人工配置的兼容选项，不作为默认值

理由：

- 官方文档明确指出 HTML 文件需显式指定 `MinerU-HTML`
- 文档中也给出 `vlm(推荐)` 信号，适合高保真解析主路径

---

## 6. 导入流程

建议导入状态机：

```text
Submitted
-> UploadingOrSubmitting
-> ParseRequested
-> Parsing
-> Parsed
-> Normalizing
-> Ready
```

说明：

- `UploadingOrSubmitting` 统一吸收“本地文件上传”和“远程 URL 提交”两条入口
- 对本地文件模式，真正的解析提交由 MinerU 在上传完成后自动触发

失败路径：

```text
UploadingOrSubmitting/ParseRequested/Parsing/Normalizing
-> Failed
```

官方状态需映射到内部统一状态。至少覆盖：

- `waiting-file`
- `uploading`
- `pending`
- `converting`
- `running`
- `done`
- `failed`

---

## 7. 输入模型

建议 `ImportDocumentRequest` 字段：

- `source_type`
- `source_ref`
- `display_name?`
- `collection_id?`
- `tags?`
- `goal?`

`source_type` 可以是：

- `file`
- `url`
- `raw_text`
- `snapshot`

注意：

- 这些类型只是输入来源类型，不代表系统内部有多套解析器
- 最终都统一交由 MinerU 解析或转换后再交给 MinerU

---

## 8. MinerU Gateway 职责

`MinerU Gateway` 只负责：

- 构造提交请求
- 上传输入
- 提交解析任务
- 轮询任务状态
- 下载解析结果
- 输出结构化 raw result

不负责：

- 业务字段重命名
- block 标准化
- outline 修复
- reading/query 相关逻辑

---

## 9. 结果模型分层

建议区分两层：

### 9.1 MinerURawResult

保留 MinerU 原始返回结构，用于审计和问题排查。

### 9.2 NormalizedDocument

由 normalizer 从 raw result 投影生成。

好处：

- 外部接口变化不会直接冲击领域层
- 解析问题可追溯
- normalizer 可独立演进

---

## 10. 错误模型

建议显式错误类型：

- `UploadFailed`
- `ParseRequestFailed`
- `ParseTimeout`
- `ParseFailed`
- `UnsupportedByMinerU`
- `MalformedMinerUResult`
- `NormalizationFailed`

每类错误都应返回：

- `error_code`
- `message`
- `stage`
- `retryable`
- `document_id?`

---

## 11. 无兜底策略的工程后果

如果启用“无兜底策略”，工程后果是必须加强：

- 错误透明度
- 状态可观测性
- 原始响应留档
- 重试策略边界清晰

但本仓库的当前实现选择了“可用性优先”的降级策略，因此这里补充一条实际约束：

- **允许降级，但必须显式标注 degrade_mode**，避免“看似成功但质量低”的静默失败

允许做：

- 同一导入任务的重试
- 对明确可重试错误做指数退避
- 记录 raw response 以便后续人工定位

---

## 12. Rust 模块建议

- `ingestion/mineru_gateway.rs`
- `ingestion/import_service.rs`
- `ingestion/job_state.rs`
- `ingestion/errors.rs`

共享契约：

- `contracts/import_request.rs`
- `contracts/import_response.rs`
- `contracts/mineru_raw_result.rs`

---

## 13. 与后续上下文的契约

`Ingestion Context` 对下游承诺：

- 成功时一定提供完整 `MinerURawResult`
- 失败时一定提供结构化错误
- 不把领域推理夹带进解析结果

`Normalization Context` 对上游假设：

- 输入是 MinerU 成功返回的结构化结果
- 输入不是任意野生文本流
