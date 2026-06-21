# VCPRedisOperator - Redis 操作插件

让 VCP Agent 安全操作 Redis。三道安全闸：命令白名单 / Key 前缀白名单 / 按 Agent 分桶限频。核心用途：配合数据库插件实现实时通知未读计数、用户状态标记等轻量级缓存操作。

## 安全机制

| 安全层 | 说明 |
|--------|------|
| **命令白名单** | 仅允许安全命令（GET/SET/DEL/INCR/INCRBY/DECR/DECRBY/HSET/HGET/HDEL/HGETALL/EXPIRE/TTL/EXISTS/LRANGE 等），禁止 FLUSHDB / FLUSHALL / EVAL / KEYS / CONFIG / SHUTDOWN 等危险命令 |
| **Key 前缀白名单** | 配置 `REDIS_KEY_PREFIX_N`，AI 只能操作匹配前缀的 Key，防止越权访问其他业务数据 |
| **限频** | 写操作和总操作分别有每分钟次数上限，超出返回 `RATE_LIMIT_EXCEEDED` |

## 配置

`config.env`（复制 `config.env.example` 修改，**此文件含敏感信息，已被 .gitignore 保护**）：

```env
# Redis 连接信息（必填）
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password
REDIS_DB=0

# Key 前缀白名单（可配置多个，编号从 1 开始）
# AI 只能操作以这些前缀开头的 Key
REDIS_KEY_PREFIX_1=user:unread:
REDIS_KEY_PREFIX_2=user:ban:
REDIS_KEY_PREFIX_3=session:

# 限频：每分钟最大总请求数（默认 60）
RATE_LIMIT_PER_MINUTE=60

# 每分钟最大写操作数（默认 20）
WRITE_RATE_LIMIT_PER_MINUTE=20
```

## 使用示例

### 通知未读计数 +1

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPRedisOperator「末」,
command:「始」ExecuteRedis「末」,
maid:「始」先驱798「末」,
redis_command:「始」INCR「末」,
key:「始」user:unread:42「末」
<<<[END_TOOL_REQUEST]>>>
```

### SET 写入带过期时间（禁言标记）

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPRedisOperator「末」,
command:「始」ExecuteRedis「末」,
maid:「始」先驱798「末」,
redis_command:「始」SET「末」,
key:「始」user:ban:42「末」,
args:「始」["1", "EX", "86400"]「末」
<<<[END_TOOL_REQUEST]>>>
```

### 查询未读数

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPRedisOperator「末」,
command:「始」ExecuteRedis「末」,
redis_command:「始」GET「末」,
key:「始」user:unread:42「末」
<<<[END_TOOL_REQUEST]>>>
```

### 清零未读（删除 Key）

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPRedisOperator「末」,
command:「始」ExecuteRedis「末」,
redis_command:「始」DEL「末」,
key:「始」user:unread:42「末」
<<<[END_TOOL_REQUEST]>>>
```

## 参数说明

| 参数 | 必需 | 说明 |
|------|------|------|
| `redis_command` | 是 | Redis 命令名，大写，如 `INCR` / `GET` / `SET` / `DEL` / `HSET` / `EXPIRE` |
| `key` | 是 | 目标 Key，必须匹配配置的前缀白名单之一 |
| `args` | 否 | 命令附加参数的 JSON 数组，如 SET 的 value、INCRBY 的步长、EXPIRE 的秒数 |
| `maid` | 否 | 调用方 Agent 名称，用于限频分桶 |

## 返回结构

```json
// 成功
{ "status": "ok", "command": "INCR", "key": "user:unread:42", "result": 5, "type": "number" }

// 安全拒绝
{ "plugin_error": "COMMAND_NOT_ALLOWED", "message": "..." }
{ "plugin_error": "KEY_PREFIX_NOT_ALLOWED", "message": "..." }
{ "plugin_error": "RATE_LIMIT_EXCEEDED", "message": "..." }

// 执行错误
{ "status": "error", "command": "GET", "key": "...", "error": "..." }
```

## 典型使用场景

- **实时角标**：数据库插件写入通知后，Redis INCR 未读计数，前端 WebSocket 收到变化立即刷新
- **临时状态**：用户禁言、登录 Token 黑名单等短期状态，用 SET + EX 自动过期
- **计数器**：文章点击数、API 调用次数等高频写入场景

## 依赖

- Node.js >= 16
- npm 依赖：`ioredis`（需在插件目录执行 `npm install`）
