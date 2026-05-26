# DingTalkTable 插件

> 钉钉 AI 表格兼容层。旧的 DingTalkTable 调用会转发到
> `Plugin/DingTalkCLI`，由统一的 `dry_run` 和 `DWS_GRAY_STAGE` 策略门控保护。

## 功能特性

- 兼容旧动作：`write_daily_report`、`write_weekly_report`、`list_tables`、
  `call_mcp_tool`。
- 支持记录级动作：`add_record`、`batch_add_records`、`update_record`、
  `delete_record`、`get_record`。
- 默认写动作保持 dry-run，只有显式 `apply=true` 才请求真实执行。
- `DingTalkCLI` 的 `DWS_GRAY_STAGE=query_only` 会阻止写动作，即使传入
  `apply=true`。

## 配置

复制 `config.env.example` 为 `config.env`:

```bash
cp config.env.example config.env
```

可选配置:

```env
DINGTALK_TABLE_UUID=
DEFAULT_TIMEZONE=Asia/Shanghai
```

真实钉钉/DWS 访问配置请放在 `Plugin/DingTalkCLI/config.env`。生产或未确认
环境建议保持：

```env
DWS_GRAY_STAGE=query_only
```

## 使用方法

### 写入日报 dry-run

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」DingTalkTable「末」,
action:「始」write_daily_report「末」,
content:「始」今日完成：1.项目评审 2.功能开发 3.Bug 修复「末」,
report_date:「始」2026-03-30「末」
<<<[END_TOOL_REQUEST]>>>
```

### 显式请求真实写入

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」DingTalkTable「末」,
action:「始」add_record「末」,
table_uuid:「始」your_table_id「末」,
data:「始」{"field1":"value1"}「末」,
apply:「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

注意：如果 `DingTalkCLI` 当前处于 `DWS_GRAY_STAGE=query_only`，该写入仍会被
策略门控阻止。

### 查询记录

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」DingTalkTable「末」,
action:「始」get_record「末」,
table_uuid:「始」your_table_id「末」,
record_id:「始」record_id「末」
<<<[END_TOOL_REQUEST]>>>
```

### 调用底层 DingTalkCLI 工具

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」DingTalkTable「末」,
action:「始」call_mcp_tool「末」,
tool_name:「始」record create「末」,
arguments:「始」{"data":{"field1":"value1"}}「末」
<<<[END_TOOL_REQUEST]>>>
```

## 架构

```text
用户请求 -> VCP 服务器 -> DingTalkTable -> DingTalkCLI -> dingtalk-workspace-cli
                                      |
                                      +-> dry_run / DWS_GRAY_STAGE / 参数校验
```

## 验证

本插件应通过 mock runtime 测试验证，不需要真实钉钉或 MCP 服务：

```bash
node --test tests/dingtalk-table-compat.test.js
```

## 相关文档

- [DingTalkCLI 架构](../../docs/dingtalk-cli/01-architecture.md)
- [DingTalkCLI API 规范](../../docs/dingtalk-cli/02-api-spec.md)
- [DingTalkCLI 灰度发布](../../docs/dingtalk-cli/05-gray-release.md)

_版本：1.1.0_
