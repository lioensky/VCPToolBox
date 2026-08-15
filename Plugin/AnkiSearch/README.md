# AnkiSearch

AnkiSearch 是一个同步 `stdio` 插件，通过本机 AnkiConnect 对 Anki 数据进行只读查询。它支持 Anki 查询语法、牌组统计和笔记类型字段探查，不会修改卡片或笔记。

## 前提

- Python 3.8 或更高版本。
- 本机 Anki 桌面端已启动。
- 已安装并启用 [AnkiConnect](https://ankiweb.net/shared/info/2055492159)。

默认端点是 `http://127.0.0.1:8765`。AnkiConnect 不应暴露到公共网络；如有自定义地址，请确认它只接受受信任的本机请求。

## 配置

复制 `config.env.example` 为 `config.env`。所有配置均可选：

```env
ANKI_CONNECT_URL=http://127.0.0.1:8765
ANKI_CONNECT_TIMEOUT_SECONDS=5
ANKI_CONNECT_RETRIES=3
```

插件优先使用已存在的系统环境变量，随后读取本地 `config.env`。`config.env` 不应提交。

## 命令

| 命令 | 说明 |
| --- | --- |
| `anki_search_cards` | 以 Anki 查询语法搜索卡片，并返回最多 15 张的字段摘要。参数：`query`。 |
| `anki_get_decks` | 返回牌组和学习统计。 |
| `anki_get_models` | 返回笔记类型及其字段结构。 |

示例：

```text
<<<[TOOL_REQUEST]>>>
tool_name: AnkiSearch
command: anki_search_cards
query: deck:Default is:due
<<<[END_TOOL_REQUEST]>>>
```

若返回连接错误，请确认 Anki 已打开、AnkiConnect 已启用，并检查端点与防火墙设置。
