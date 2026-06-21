# VCPDatabaseOperator - MySQL 数据库操作插件

让 VCP Agent 直接写原生 MySQL 语句操作数据库，插件做 AST 解析 + 五道安全闸（动词过滤 / 表白名单 / CRUD 权限矩阵 / 参数化绑定 / 写操作熔断），确保 AI 无法执行危险操作。

## 安全机制

| 安全层 | 说明 |
|--------|------|
| **动词过滤** | 仅允许 SELECT / INSERT / UPDATE / DELETE，拒绝 DROP / TRUNCATE / ALTER / CREATE / RENAME / GRANT / REVOKE / SET |
| **表白名单** | config.env 中配置允许访问的表，操作不在白名单内的表直接拒绝 |
| **CRUD 权限矩阵** | 每张表可独立配置读/写权限，如 READONLY 表禁止 INSERT/UPDATE/DELETE |
| **参数化绑定** | 所有用户输入必须走 `sql_params` 占位符，禁止拼接字符串，防 SQL 注入 |
| **写操作熔断** | UPDATE/DELETE 影响行数超过阈值时先报错，需显式 `confirm:true` 二次确认才执行 |

## 配置

`config.env`（复制 `config.env.example` 修改，**此文件含敏感信息，已被 .gitignore 保护**）：

```env
# MySQL 连接信息（必填）
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_NAME=your_database_name

# 允许 AI 访问的表（逗号分隔）。留空则禁止所有表访问。
ALLOWED_TABLES=users,orders,products

# 表权限矩阵（可选）。格式：表名:权限级别，逗号分隔。
# 权限级别：FULL（读写删）/ READONLY（仅读）/ READWRITE（读写，不能删）
# 不在此配置的表默认使用 FULL 权限（前提：表在 ALLOWED_TABLES 内）
TABLE_PERMISSIONS=users:READONLY,orders:READWRITE

# 写操作熔断阈值：UPDATE/DELETE 预估影响行数超过此值时触发熔断（默认 100）
WRITE_AFFECT_ROW_LIMIT=100

# 按 Agent 限频：每分钟最大总请求数（默认 60）
RATE_LIMIT_PER_MINUTE=60

# 每分钟最大写操作数（默认 20）
WRITE_RATE_LIMIT_PER_MINUTE=20

# 是否启用调试日志（默认 false）
DebugMode=false
```

## 使用示例

### SELECT 查询（推荐写法：参数化）

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPDatabaseOperator「末」,
command:「始」ExecuteSQL「末」,
maid:「始」先驱798「末」,
sql:「始」SELECT id, title, status FROM article WHERE author_id = ? AND status = ? ORDER BY created_at DESC LIMIT 20「末」,
sql_params:「始」[42, "published"]「末」
<<<[END_TOOL_REQUEST]>>>
```

### INSERT 新增记录

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPDatabaseOperator「末」,
command:「始」ExecuteSQL「末」,
maid:「始」先驱798「末」,
sql:「始」INSERT INTO comment (article_id, author, content, created_at) VALUES (?, ?, ?, NOW())「末」,
sql_params:「始」[100, "用户名", "评论内容"]「末」
<<<[END_TOOL_REQUEST]>>>
```

### UPDATE（大范围操作：先触发熔断，确认后重试）

```text
# 第一次：不带 confirm，若影响行数超阈值会被熔断
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPDatabaseOperator「末」,
command:「始」ExecuteSQL「末」,
sql:「始」DELETE FROM log WHERE created_at < ?「末」,
sql_params:「始」["2026-01-01 00:00:00"]「末」
<<<[END_TOOL_REQUEST]>>>

# 熔断回执: { code:"WRITE_AFFECT_TOO_MANY", affected_rows_estimate: 1834 }
# 确认无误后加 confirm:true 重试
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPDatabaseOperator「末」,
command:「始」ExecuteSQL「末」,
sql:「始」DELETE FROM log WHERE created_at < ?「末」,
sql_params:「始」["2026-01-01 00:00:00"]「末」,
confirm:「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

## 命令说明

| 命令 | 说明 |
|------|------|
| `ExecuteSQL` | **主入口（推荐）**：直接执行原生 MySQL 语句，支持 `?` 占位符 |
| `QueryTable` | 结构化查询（旧版兼容，新代码请用 ExecuteSQL） |
| `InsertRow` | 结构化插入（旧版兼容） |
| `UpdateRow` | 结构化更新（旧版兼容） |
| `DeleteRow` | 结构化删除（旧版兼容） |

## 常见错误

| 错误码 | 原因 | 解决方法 |
|--------|------|---------|
| `OPERATION_FORBIDDEN` | 使用了 DDL 语句（DROP/ALTER 等） | 只用 SELECT/INSERT/UPDATE/DELETE |
| `TABLE_NOT_ALLOWED` | 表不在 `ALLOWED_TABLES` 白名单 | 在 config.env 中添加该表 |
| `PERMISSION_DENIED` | 表权限不足（如对 READONLY 表写入） | 检查 `TABLE_PERMISSIONS` 配置 |
| `WRITE_AFFECT_TOO_MANY` | 写操作影响行数超阈值 | 确认无误后加 `confirm:true` 重试 |
| `RATE_LIMIT_EXCEEDED` | 请求频率超限 | 降低调用频率或调大 `RATE_LIMIT_PER_MINUTE` |
| `MULTI_STATEMENT_FORBIDDEN` | SQL 含多条语句（用 `;` 分隔） | 拆分为多次调用，每次一条 |

## 依赖

- Node.js >= 16
- npm 依赖：`mysql2`（需在插件目录执行 `npm install`）
