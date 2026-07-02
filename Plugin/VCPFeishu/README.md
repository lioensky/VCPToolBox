# VCPFeishu 插件

VCPChat 飞书桥接插件。飞书消息进入后，插件会在绑定 Agent 下创建或复用一个 VCPChat 话题，把消息写入 `history.json`，再按系统设置与 Agent 配置调用 VCP 后端，最后把回复发回飞书。

## 配置

复制 `config.env.example` 为 `config.env`：

```ini
FeishuAppId=cli_xxxxxxxxxxxx
FeishuAppSecret=xxxxxxxxxxxxxxxxxxxxxxxx
FeishuBindAgent=记忆大师

FeishuStreamReply=true
FeishuStreamHint=正在思考中…
# FeishuAllowedUsers=ou_xxxxx,ou_yyyyy
DebugMode=false
```

手动编辑 `config.env` 后，重启应用即可。

## 对外能力

- `POST /api/plugins/feishu/send`
- `GET /api/plugins/feishu/sessions`
- `GET /api/plugins/feishu/groups`
- `FeishuSend`
- `FeishuListSessions`
- `FeishuListGroups`

`sessions` 和 `groups` 是只读查询，读取的是插件已经记录到绑定 Agent `config.json` 里的飞书话题元数据，不会额外调用飞书开放平台。
