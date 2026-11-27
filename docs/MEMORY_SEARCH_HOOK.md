# 记忆检索 HTTP 接口与被动召回 Hook

面向外部 agent 的只读记忆检索：`POST /v1/memory/search` 把 VCP 的 RiverMemo 浪潮记忆
（与聊天完全相同的原生召回管线）开放给任何能发 HTTP 的宿主——Claude Code、Codex CLI、
自研 agent 或脚本——不需要 VCP 主 Key，也不需要直接访问向量索引。

随附的 `scripts/vcp-memory-recall-hook.js` 是一个零依赖的 Node.js 钩子脚本，
挂进 Claude Code / Codex CLI 的 `UserPromptSubmit` 事件后，每次提交 prompt 都会
自动带上相关的记忆片段（被动召回）。

---

## 1. 服务端配置

### 1.1 签发只读令牌并配置授权

`/v1/memory/search` 默认**不注册**。管理员用 `MEMORY_READ_GRANTS` 把独立只读令牌的
SHA-256 摘要映射到允许读取的日记库：

```bash
# 1. 生成一个高熵只读令牌（绝不是主 Key）
TOKEN=$(openssl rand -hex 32)

# 2. 计算它的 SHA-256 小写十六进制摘要
echo -n "$TOKEN" | sha256sum | awk '{print $1}'
```

```env
# config.env —— 键是摘要，值是这枚令牌允许读取的日记库名数组
MEMORY_READ_GRANTS='{"<64 hex digest>":["ExampleDiary","AnotherDiary"]}'

# 检索排名策略（服务端单方面决定，客户端不可选择）：river（默认）/ jev / rerank
MEMORY_SEARCH_RANKING=river
```

安全模型：

- 令牌明文**永不落盘**在服务端，配置里只存摘要；盗用配置文件的攻击者无法还原令牌。
- 授权检查（`401/403`）严格发生在 embedding 与检索**之前**；只要有一个库越权，整单 `403`，不做部分放行。
- 服务端通用 Key 不允许配置为只读令牌（启动即拒绝）。
- 跨机器使用必须套 TLS 反代；明文 HTTP 仅限回环或可信内网。

### 1.2 请求

```http
POST /v1/memory/search
Authorization: Bearer <read-token>
Content-Type: application/json
```

```json
{
  "query": "我们当时为什么把读写分开？",
  "diaries": ["ExampleDiary"],
  "k": 5,
  "conversation": [
    {"role": "user", "content": "先前排障说了半天读写分离"},
    {"role": "assistant", "content": "对，结论是写路径必须走事务"},
    {"role": "user", "content": "我们当时为什么把读写分开？"}
  ],
  "coreTags": ["事务一致性"],
  "associate": true,
  "metaThinking": {"pool": "MyStarPool", "group": false}
}
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `query` | string | **必填** | 当前用户消息原文 |
| `diaries` | string[] | **必填** | 目标日记库；越权整单 403 |
| `k` | int | 10 | 主召回条数（1–100） |
| `conversation` | array | 无 | 多轮上下文。**末条必须 role=user 且 content 与 query 逐字相同**（与聊天原生投影同构）。提供后启用：用户/助手 0.7:0.3 加权查询向量、历史主题段补充检索、上下文日记去重 |
| `coreTags` | string[] | 无 | 显式幽灵锚（强引力），把检索拉向指定概念，最多 16 个 |
| `associate` | bool | false | 跨种子联想共现，结果进 `associated` |
| `metaThinking` | bool\|object | 无 | 元思考 V3 公式。`{"pool":"星池日记库","group":false}`；星池解析出的日记库必须同样落在令牌授权范围内，否则整单 403 |

未知字段整单 `400`（严格白名单，防止客户端误以为生效）。`metaThinking: true` 使用默认星池。

### 1.3 响应

```json
{
  "direct": [
    {"rank": 1, "diary": "ExampleDiary", "file": "2026-01-01-读写分离.txt", "text": "……", "score": 0.83, "scoreSource": "retrieval", "chunkId": 1234}
  ],
  "associated": [
    {"rank": 1, "diary": "ExampleDiary", "file": "……", "text": "……", "score": 0.61, "scoreSource": "retrieval", "seedCount": 3}
  ],
  "metaFormula": "$$声呐[…]_Ω ↦ …$$"
}
```

- `direct` 主召回；`associated` 仅当 `associate:true` 时出现（可为空数组）；`metaFormula` 仅当请求 `metaThinking` 时出现（求解失败降级为 `null`，不影响召回）。
- `file` 只有文件名（basename）；**永不返回** fullPath、向量、内部签名或查询 ID。
- `scoreSource`：`retrieval` / `rerank` / `rrf`，反映服务端启用的排名策略。
- 错误码：`400` 形状违约 / `401` 令牌无效 / `403` 越权（含星池越权）/ `404` 接口未启用 / `503` 检索暂不可用（不泄漏内部细节）。

---

## 2. 被动召回 Hook（Claude Code / Codex CLI）

`scripts/vcp-memory-recall-hook.js` 是宿主无关的单文件脚本（Node.js ≥ 18，零 npm 依赖）：

- 从 stdin 读钩子 JSON（两家宿主字段同构：`session_id` / `transcript_path` / `cwd` / `hook_event_name` / `prompt`）；
- 从会话 transcript 尾部取最近几轮 user/assistant 消息，组装 `conversation` 调用 `/v1/memory/search`；
- 把召回片段以 `hookSpecificOutput.additionalContext` 单行 JSON 写到 stdout；
- **零阻断**：任何失败（网络、超时、配置缺失、服务不可用）都静默 `exit 0`，prompt 照常送达，绝不卡住会话；
- 只读令牌只发往**回环或 HTTPS** 端点，且永不跟随重定向。

### 2.1 安装

```bash
# 把脚本复制到稳定位置（示例）
cp scripts/vcp-memory-recall-hook.js ~/.vcp/memory-recall-hook.js
```

### 2.2 配置凭证

脚本同目录下放 `vcp-memory-hook.config.json`（或用环境变量，环境变量优先）：

```json
{
  "url": "http://127.0.0.1:6005",
  "token": "<你的只读令牌明文>",
  "diaries": "ExampleDiary,AnotherDiary",
  "k": 5,
  "associate": true
}
```

全部配置项（环境变量名 / 默认值）：

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `VCP_MEMORY_URL` | **必填** | VCP 主服务地址（不含路径） |
| `VCP_MEMORY_TOKEN` | **必填** | 只读令牌明文 |
| `VCP_MEMORY_DIARIES` | **必填** | 逗号分隔的日记库 |
| `VCP_MEMORY_K` | 5 | 主召回条数 |
| `VCP_MEMORY_ASSOCIATE` | off | `1` 开启联想共现 |
| `VCP_MEMORY_CORETAGS` | 无 | 逗号分隔的幽灵锚 |
| `VCP_MEMORY_METATHINKING` | 无 | `1` 或星池名（星池须在授权范围内） |
| `VCP_MEMORY_METATHINKING_GROUP` | off | 星池 group 模式 |
| `VCP_MEMORY_TIMEOUT_MS` | 8000 | 单次召回超时 |
| `VCP_MEMORY_MAX_CHARS` | 6000 | 注入字符预算（Claude 硬上限 10000；Codex 默认阈值约 2500 token，可按 `additionalContextLimit` 调） |
| `VCP_MEMORY_HISTORY` | 6 | transcript 尾取消息数（0=关闭多轮） |
| `VCP_MEMORY_MESSAGE_CHARS` | 2000 | 单条消息截断 |
| `VCP_MEMORY_COOLDOWN_MS` | 30000 | 失败后的退避静默期 |
| `VCP_MEMORY_SKIP_SLASH` | on | 跳过 `/` 开头的斜杠命令 |
| `VCP_MEMORY_HOOK_CONFIG` | 脚本旁 | 显式指定配置文件路径 |

### 2.3 Claude Code 接入

`~/.claude/settings.json`（用户级）或项目级 `.claude/settings.json`：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["/home/you/.vcp/memory-recall-hook.js"],
            "timeout": 12
          }
        ]
      }
    ]
  }
}
```

Windows 用 exec form 同样成立（`node` 是真可执行文件；脚本路径按实际调整，可用
`${CLAUDE_PROJECT_DIR}` 等占位符）。召回作为 system-reminder 注入，不产生可见转录条目。
注意 Claude 对 `additionalContext` 有 10000 字符硬上限，超限只给模型看 2000 字符预览，
`VCP_MEMORY_MAX_CHARS` 默认 6000 已在安全区内。

### 2.4 Codex CLI 接入

`~/.codex/config.toml` 启用钩子功能（Windows 已支持）：

```toml
[features]
hooks = true
```

`~/.codex/hooks.json`：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node C:/Users/you/.vcp/memory-recall-hook.js",
            "timeout": 12,
            "additionalContextLimit": 6000
          }
        ]
      }
    ]
  }
}
```

Windows 可用 `commandWindows` 覆盖命令。`additionalContextLimit` 与脚本的
`VCP_MEMORY_MAX_CHARS` 对齐，避免 Codex 把超限输出落盘后只给模型预览。

---

## 3. 行为与排障

- **延时形状**：召回是同步阻塞式的（注入发生在模型处理前）。内部默认 8s 超时 + 失败冷却，
  即使服务宕机也只会让召回静默缺席，不会拖死会话。建议钩子超时（宿主侧）设为 10–15s。
- **没有注入时**：按顺序排查——VCP 是否在跑、`MEMORY_READ_GRANTS` 是否含该令牌摘要、
  令牌明文是否与摘要配对、日记库名逐字是否匹配、脚本手动执行是否有输出：
  `echo '{"hook_event_name":"UserPromptSubmit","prompt":"test","transcript_path":"","cwd":".","session_id":"x"}' | node memory-recall-hook.js`
- **多轮上下文**：transcript 是异步落盘，可能滞后一拍；当前 prompt 由钩子载荷自带，不依赖 transcript。
- **隐私**：召回内容全部来自你自己的日记库；脚本不写日记、不上报、不联网到 VCP 以外的任何地方。

---

## 4. 测试

```bash
node --test tests/memorySearch.test.js tests/memoryRecallBridge.test.js tests/memoryHook.test.js
```

- `tests/memorySearch.test.js`：HTTP 契约（鉴权、字段校验、越权、向后兼容、排名策略）；
- `tests/memoryRecallBridge.test.js`：桥编排（多轮投影数学、管线入参、输出整形、元思考观测共享与释放）；
- `tests/memoryHook.test.js`：钩子端到端（真实子进程 + 回环假服务器，双 transcript 形状、静默路径、冷却、预算）。
