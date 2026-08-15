# AnkiManage

AnkiManage 是一个同步 `stdio` 插件，通过本机 AnkiConnect 管理 Anki 笔记与卡片状态。它可添加笔记、更新字段、挂起/取消挂起卡片和调整复习日期。

## 安全边界

这些命令会修改你的本地 Anki 数据库。请先备份 Anki，并在每次写入前使用 `dryRun=true` 查看预期操作；确认牌组、笔记类型、字段和卡片 ID 后，再移除 `dryRun` 执行。新建笔记默认不允许重复，如确有需要可显式传 `allowDuplicate=true`。

插件默认只连接 `http://127.0.0.1:8765`。不要把 AnkiConnect 暴露到公共网络，也不要在不受信任的环境中加载此插件。

## 前提与配置

- Python 3.8 或更高版本。
- 本机 Anki 桌面端已启动。
- 已安装并启用 [AnkiConnect](https://ankiweb.net/shared/info/2055492159)。

复制 `config.env.example` 为 `config.env`，需要时调整本机端点、超时和重试次数：

```env
ANKI_CONNECT_URL=http://127.0.0.1:8765
ANKI_CONNECT_TIMEOUT_SECONDS=10
ANKI_CONNECT_RETRIES=3
```

系统环境变量优先于本地 `config.env`；不要提交本地配置。

## 命令

| 命令 | 说明 |
| --- | --- |
| `anki_add_note` | 添加笔记。参数：`deck`、`model`、`fields`（JSON 字符串）、可选 `tags`、`allowDuplicate`、`dryRun`。 |
| `anki_update_note` | 更新笔记字段。参数：`note_id`、`fields`（JSON 字符串）、可选 `dryRun`。 |
| `anki_suspend` | 挂起或取消挂起卡片。参数：`card_ids`（逗号分隔）、`suspend`、可选 `dryRun`。 |
| `anki_reschedule` | 调整复习日期。参数：`card_ids`、`days`、可选 `dryRun`。 |

安全预检示例：

```text
<<<[TOOL_REQUEST]>>>
tool_name: AnkiManage
command: anki_add_note
deck: Default
model: Basic
fields: {"Front":"hello","Back":"你好"}
tags: vcp example
dryRun: true
<<<[END_TOOL_REQUEST]>>>
```

`anki_update_note` 使用 Note ID；`anki_suspend` 和 `anki_reschedule` 使用 Card ID。字段内容必须是 JSON 对象，而不是 Python 字典或未转义的文本。
