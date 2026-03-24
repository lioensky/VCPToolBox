# Interaction Middleware Docs

这一组文档统一归档到 `docs/interaction-middleware/`，作为 VCP 交互中间层专题目录。

## 当前进度

**总体进度：约 90%** (2026-03-24 更新)

### ✅ 已完成

- ChannelHub 核心服务 (Phase 1-4)
- 钉钉/企微/飞书/QQ 适配器 B2 协议支持
- per-adapter 密钥管理与轮换
- 会话绑定与身份映射
- 审计与投递队列
- 死信自动处理（自动重试策略、指数退避、自动清理）
- 媒体网关增强（签名URL、远程缓存、缩略图）
- AdminPanel API（channelHub + mediaGateway 路由）
- 前端运维页面（适配器/绑定/发件箱/死信/媒体/指标/审计）
- 健康检查端点

### ⚠️ 进行中

- 压力测试
- 高并发场景验证

---

## 建议阅读顺序

1. `VCP_INTERACTION_MIDDLEWARE_TARGET.md`
2. `VCP_INTERACTION_MIDDLEWARE_SCHEMA.md`
3. `CHANNEL_MIDDLEWARE_DESIGN.md`
4. `CHANNEL_MIDDLEWARE_IMPLEMENTATION_PLAN.md`
5. `CHANNEL_MIDDLEWARE_FILE_TODOS.md`
6. `ASTRBOT_QQ_VS_CHANNELHUB.md`
7. `CHANNEL_HUB_USER_GUIDE.md`

模板文件：

- `CHANNEL_HUB_ADAPTER_CONFIG_TEMPLATE.json`
- `CHANNEL_HUB_ADAPTER_CONFIG_TEMPLATE.jsonc`
- `CHANNEL_HUB_BINDING_TEMPLATE.json`
- `CHANNEL_HUB_BINDING_TEMPLATE.jsonc`

## 已接入适配器

| 适配器 | 路径 | 协议 |
|--------|------|------|
| 钉钉 | Plugin/vcp-dingtalk-adapter | B2 |
| 企业微信 | Plugin/vcp-wecom-adapter | B2 |
| 飞书 | Plugin/vcp-feishu-adapter | B2 |
| QQ (OneBot) | Plugin/vcp-onebot-adapter | B2 |

说明：

- 本目录下的文件是交互中间层与 ChannelHub 相关文档的主位置。
- `docs` 根目录中若还存在同名旧文件，视为兼容副本，不作为后续维护入口。

