# VCP TelegramBridge

TelegramBridge 是 VCPToolBox 的 Telegram 私聊传输插件。它把 Telegram 更新持久化后送入指定 VCP Agent，并将流式回复、附件、工具审批和异步任务结果安全地返回 Telegram。

当前版本默认只允许显式配置的 owner，示例 Agent 名称为 `ExampleAgent`（安装时必须改为自己的已配置 Agent），默认不开启群聊和主动推送。Bot Token、VCP Key、聊天记录、附件与 SQLite 状态都不属于发布包，也不得提交到 Git。

本插件为测试版，默认关闭。完整媒体支持面向 Linux/Docker；原生 Windows 有下文所述限制。

## 运行要求

- Node.js `20.20.2`，或 Node.js `22.21.1` 及兼容的同主版本运行时；
- VCPToolBox 提供 Host Integration v1（本 PR 同时包含该接口，未经集成的旧主机不能仅复制插件使用）；
- VCP 的 OpenAI 兼容端点只允许回环地址，例如 `http://127.0.0.1:6005/v1`；
- 同一个 Telegram Bot 同一时刻只能有一个 `enabled` poller。

## 三种模式

- `disabled`：只解析配置，不打开数据库、不联网，也不启动定时器；这是默认值。
- `probe`：执行目录、SQLite、Telegram `getMe`/webhook、VCP HTTP、Host Integration 和恢复检查，但不调用 `getUpdates`。
- `enabled`：完成全部 probe 后启动长轮询。

上线时先使用 `probe`。只有确认本地或 AWS 上不存在另一个 poller 后，才能切换为 `enabled`。迁移时应先关闭旧端 poller，再启用新端，避免 Telegram 409 冲突和重复处理风险。

## 安装与配置

复制发布包到 `VCPToolBox/Plugin/TelegramBridge/`，在该目录执行：

```powershell
npm ci --omit=dev
Copy-Item config.env.example config.env
```

然后只在本机编辑 `config.env`。最小私聊配置如下，示例值必须替换，真实密钥不要粘贴到聊天、日志或 issue：

```dotenv
TELEGRAM_MODE=probe
TELEGRAM_BOT_TOKEN=<private-bot-token>
TELEGRAM_ALLOWED_USER_IDS=<owner-user-id>
TELEGRAM_ALLOWED_CHAT_IDS=
TELEGRAM_GROUPS_ENABLED=false
TELEGRAM_ALLOWED_AGENTS=ExampleAgent
TELEGRAM_DEFAULT_AGENT=ExampleAgent
TELEGRAM_VCP_BASE_URL=http://127.0.0.1:6005/v1
TELEGRAM_VCP_MODEL=VCPModelAuto
TELEGRAM_VCP_KEY=<private-vcp-key>
```

完整字段及安全默认值见 `config.env.example`。`state/` 由插件创建，包含会话、offset、审批、异步任务和投递幂等状态，更新代码时必须保留。

Telegram 不会自动读取桌面 VCPChat 的模型设置。可用 `TELEGRAM_AGENT_MODELS={"ExampleAgent":"your-local-model"}` 显式按 Agent 对齐，未列出的 Agent 使用 `TELEGRAM_VCP_MODEL`；`TELEGRAM_VCP_TEMPERATURE` / `TELEGRAM_VCP_MAX_TOKENS` 留空时保持上游默认。不要假设两个客户端显示同一 Agent 就必然使用同一模型或采样参数。

## 用户命令

- `/start`、`/help`：查看入口和命令；
- `/whoami`：在私聊中查看 Telegram user/chat ID，用于首次 owner 配置；
- `/agent`、`/agent ExampleAgent`：查看或切换允许的 Agent；
- `/new`：为当前 chat/thread/Agent 开始新会话；
- `/status`：查看脱敏运行状态；
- `/stop`：停止当前 owner 和会话范围内的请求；
- `/tasks`：查看属于当前 owner 和 scope 的异步任务；
- `/retry <request-id>`：只对明确可重放、归属当前 owner/scope 的记录发起人工重试。

直接发送 `/retry` 可查看当前 Agent 会话的失败记录。停止会覆盖下载、VCP 请求、未发送附件和待批准工具；已经执行的工具效果不会回滚。

工具审批按钮只处理与当前 owner、chat、thread、消息和 Host 请求严格关联的事件。`requiresAdmin` 仍由 VCP 主机强制执行；Telegram 插件不会保存或代填 Auth code。

## 文件、回复与恢复

支持 `![说明](相对于 image/ 的路径)` 和 `<img>` 图片；`[文件](file:///允许目录/报告.pdf)`、VCP 文件链接和公共 HTTPS 下载链接可回传真实附件。私有地址会被隐藏。出站目录为 `image/`、`file/`、插件 `state/outbox/` 和 `VCPAsyncResults/`，远程下载实施 HTTPS、DNS/IP、重定向、MIME 和实际大小检查。

若系统代理把公共网站解析到 Fake-IP（如 198.18.0.0/15），默认安全策略会拒绝下载。可显式设置 `TELEGRAM_OUTBOUND_DNS=cloudflare`，只为外部文件下载启用固定 TLS 端点的加密 DNS。目标域名会提交到 Cloudflare，不会提交资源路径、密钥或文件内容；不修改系统 DNS、Telegram API 或 VCP 连接。默认仍为 `system`，解析失败不降级绕过检查，内网地址仍被拒绝。协议参考：[Cloudflare DoH JSON 文档](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/)。

收到的图片、OGG/WAV/MP3 音频、MP4/WebM 视频通过 VCP 原生多模态接口处理，不另配第二个模型；具体解码仍取决于 VCP 后端模型。UTF-8 文本、Markdown、JSON、CSV 提供有界正文；PDF 等二进制提供已验证的文件引用，交给 VCP 工具。最多 10 项附件、总计 20 MB。相册合为一轮；无配文也可处理。回复 Bot 的图片或追问当前会话最近发出的图片时，会重新附上原图供判断。

无说明的单图或纯图片相册最多等待 7.5 秒：紧随的问题会合为一轮；图片自带文字时不等待这个窗口。历史图片按原来的用户消息位置传给 VCP，不附在每一句新文字后面，也不把问候或生成请求改写成识图问题。历史与当前附件共用 10 项 / 20 MB 原生媒体预算，优先保留本轮附件，再保留较新的历史图片；缺失、变化、部分接收或超出预算的图片会明确标注，不用其他图替代。明确问已发出的 Bot 图片或原生引用 Bot 图片时仍可使用 Bot 图。`/new` 不带入旧图片。身份不确定时应先描述可见特征，不应编造角色、作品或出处；用户明确要求查证时仍可调用 VCP 工具。

普通用户输入在附件下载或 VCP 请求之前独立持久化。即使回复中断，下一轮仍能看到你提出过的要求及桥接器记录的中断/失败/未确认状态；不会把未完成的 Agent 输出当成成功回复，也不会自动重跑不确定的工具或生成任务。已完成的轮次不会重复加入历史。会话按消息数和文本容量限制保留，不因闲置一小时而重置；这不是无限历史或对 VCP 长期记忆系统的替换。

流式预览与最终投递分开调度。预览至少间隔一秒、独立超时；草稿网络失败不生成额外持久气泡，最终回复不等待预览限流队列。编辑模式会持久化首段目标消息 ID，结束与重启恢复均编辑同一条消息。

新增文件和远程资源暂存采用 Linux 目录句柄与 `/proc/self/fd`，当前完整部署目标是 Linux/Docker。原生 Windows 的新资源暂存默认明确拒绝；测试中的 portable 选项不是生产开关。已有本地图片链路不受影响。


SQLite 优先使用插件本地 `better-sqlite3@12.9.0`；只有本地原生模块无法加载、宿主模块也满足相同精确版本时才允许兼容后备。不要用 Windows 测试进程打开 Docker 正在使用的状态数据库，也不要为通过测试替换运行中的平台依赖。

异步完成会自动发送文字和文件，启动恢复须先确认 polling 就绪。未知网络结果保留待核对状态；失败会给出提示，不能仅凭 Agent 说“已成功”认定工具真的完成。

可选在私有 `state/media-catalog.json` 写入 `{ "version": 1, "entries": [{ "agent": "ExampleAgent", "path": "表情包/图片.png", "description": "已人工核实的图中文字、表情含义和适用语境", "sha256": "文件SHA256" }] }`。只有 Agent 匹配、文件存在且哈希未变化的条目会附在 Telegram 频道提示中。目录属于运行数据，不随发布包分享；未知表情不应凭数字文件名猜测。

入站附件使用流式 SHA-256、实际字节上限、MIME 魔数和物理路径检查。出站文件只能来自配置允许的输出根目录。长回复会按 Telegram 限制切分；HTML 被拒绝时回退到纯文本。网络结果不确定时记录为 `needs_review`，不会盲目重发。

插件先持久化 Telegram batch 和 offset，再分发更新。重启时只自动恢复尚未开始副作用的工作；已开始但结果不确定的请求、投递和审批会被隔离，避免重复执行工具。

`enabled` 启动时的临时 Telegram 网络故障会清理本次实例后退避重试，不阻塞宿主后续启动；鉴权、配置、Webhook 和重复 poller 问题仍保持停止。可信本地 VCP 冷启动尚未就绪时会继续有界退避等待。轮询停止或过期不再伪装成就绪；日志仅记录时间、阶段、固定错误码、接收延迟和重试期限，不记录消息内容或凭据。分发超时会停止新消费并保留账本，不启动第二个消费者或盲目重放。

## 验证与发布

```powershell
npm test
npm run check
npm run scan:secrets
node scripts/package-release.js --version 0.1.0-beta.1
```

发布脚本生成 `dist/VCP-TelegramBridge-vX.Y.Z.tar.gz` 和对应 `.sha256`。包内容采用固定顺序和元数据；不包含测试、配置、state、数据库、媒体、日志、`.git` 或 `node_modules`。

安装、更新和回滚见 `docs/OPERATIONS.md`，真实 Bot 验收步骤见 `docs/ACCEPTANCE.md`。任何正式切换都必须保留旧版本发布包、校验和以及独立的私密 `config.env`/`state/`。
