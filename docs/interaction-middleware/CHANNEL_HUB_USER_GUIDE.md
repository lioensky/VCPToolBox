# ChannelHub 使用说明

## 1. 适用对象

本文档面向以下人员：

- 需要在 `AdminPanel` 中维护渠道接入配置的运维或开发人员
- 需要排查渠道消息接入、会话绑定、出站投递问题的维护人员
- 需要把 `onebot-adapter` 或其他适配器接入 `ChannelHub` 的开发人员

本文档只讲“怎么用”，不展开底层设计。若需要看架构和实施计划，请参考：

- `docs/interaction-middleware/CHANNEL_MIDDLEWARE_DESIGN.md`
- `docs/interaction-middleware/CHANNEL_MIDDLEWARE_IMPLEMENTATION_PLAN.md`
- `docs/interaction-middleware/CHANNEL_MIDDLEWARE_FILE_TODOS.md`

---

## 2. 入口位置

### 2.1 管理页面入口

`ChannelHub` 页面当前通过 `AdminPanel` 内嵌访问：

- 主入口：`AdminPanel/index.html`
- 页面文件：`AdminPanel/channelHub.html`

在管理后台中打开 `ChannelHub` 页签后，可以看到以下区域：

- 仪表盘
- 适配器管理
- 会话绑定
- 发件箱
- 统计指标
- 审计追踪

### 2.2 后端接口前缀

`ChannelHub` 的管理接口统一挂在：

```text
/admin_api/channelHub
```

常见接口分组：

- `/admin_api/channelHub/adapters`
- `/admin_api/channelHub/bindings`
- `/admin_api/channelHub/outbox`
- `/admin_api/channelHub/metrics`
- `/admin_api/channelHub/audit-logs`

---

## 3. 适配器管理

### 3.1 新增适配器

进入“适配器管理”页后：

1. 点击“添加适配器”
2. 填写 `适配器 ID`
3. 选择 `渠道类型`
4. 填写 `名称`
5. 在“配置 (JSON)”里填写对应适配器配置
6. 点击“保存”

字段说明：

- `适配器 ID`
  - 系统内唯一标识
  - 建议使用稳定、可读的英文 ID，例如 `qq-main`、`ding-prod`
- `渠道类型`
  - 例如 `dingtalk`、`wecom`、`feishu`、`qq`、`wechat`
- `名称`
  - 供管理页面展示，可使用中文
- `配置 (JSON)`
  - 适配器自身依赖的配置项
  - 例如 webhook、token、appId、secret 等

可直接参考模板文件：

- `docs/interaction-middleware/CHANNEL_HUB_ADAPTER_CONFIG_TEMPLATE.json`
- `docs/interaction-middleware/CHANNEL_HUB_ADAPTER_CONFIG_TEMPLATE.jsonc`（带中文注解，适合阅读和二次修改）

示例：

```json
{
  "webhookUrl": "http://127.0.0.1:8080/callback",
  "token": "your-token"
}
```

### 3.2 编辑适配器

适配器列表已支持“编辑”按钮。

编辑时会复用新增弹窗，并回填当前配置。当前行为：

- `适配器 ID` 为主标识，编辑时不可改
- 允许修改名称、渠道类型和配置 JSON

### 3.3 删除适配器

点击“删除”后会弹出确认框。删除后：

- 适配器不会继续参与新的接入和投递
- 已存在的历史审计和历史状态记录不会自动清空

建议在删除前先确认：

- 是否还有会话绑定依赖该适配器
- 是否还有出站任务未处理

---

## 4. 会话绑定

### 4.1 作用

“会话绑定”用于把外部平台会话映射到 VCP 内部会话。

它主要解决两个问题：

- 同一个外部会话持续落到同一个内部会话
- 指定某个外部会话固定走某个 `Agent`

### 4.2 新增绑定

进入“会话绑定”页后：

1. 点击“创建绑定”
2. 选择 `适配器 ID`
3. 填写 `外部会话 Key`
4. 填写 `VCP 会话 ID`
5. 填写 `Agent ID`
6. 点击“保存”

字段说明：

- `适配器 ID`
  - 绑定属于哪个适配器
- `外部会话 Key`
  - 外部平台中的会话标识
  - 应尽量使用稳定值，例如群 ID、频道 ID、组合键
- `VCP 会话 ID`
  - VCP 内部会话标识
- `Agent ID`
  - 当前绑定默认路由到的代理

可直接参考模板文件：

- `docs/interaction-middleware/CHANNEL_HUB_BINDING_TEMPLATE.json`
- `docs/interaction-middleware/CHANNEL_HUB_BINDING_TEMPLATE.jsonc`（带中文注解，适合阅读和二次修改）

### 4.3 编辑绑定

会话绑定列表已支持“编辑”按钮。

当前编辑行为：

- `适配器 ID` 在编辑时不可改
- `外部会话 Key` 现在可以改
- `VCP 会话 ID` 可以改
- `Agent ID` 可以改

当前实现边界：

- 编辑绑定时，系统仍然使用原有 `bindingKey` 作为这条绑定记录的内部标识
- 这意味着“改外部会话 Key”属于更新绑定内容，不是“重建一条全新绑定”

如果你要做的是“完全换一条新绑定关系”，更稳妥的操作仍然是：

1. 删除旧绑定
2. 新建新绑定

### 4.4 删除绑定

点击“删除”后会写入删除状态，不是粗暴硬删历史。

这对审计和问题排查有好处，因为：

- 历史记录仍然可追踪
- 不会直接破坏旧日志中的关联关系

---

## 5. 发件箱

### 5.1 作用

“发件箱”用于展示待投递、重试中或失败的出站消息任务。

你可以把它理解为：

- `ChannelHub` 的出站任务队列观察窗口

### 5.2 页面能看到什么

当前发件箱页主要展示：

- 消息 ID
- 适配器
- 渠道
- 请求/回复标识
- 状态
- 重试次数
- 创建时间

### 5.3 重试

对失败或待处理任务，可以点击“重试”。

适合使用重试的场景：

- 适配器服务短暂不可用
- 外部平台临时限流
- 下游服务恢复后需要重新投递

不建议盲目连续重试的场景：

- 配置项本身错误
- webhook/token/appSecret 写错
- 目标会话 ID 已失效

---

## 6. 统计指标

“统计指标”页用于做运行态观察，当前主要看：

- 每个渠道的事件数量
- 每个渠道的消息数量
- 成功率
- 平均延迟

建议重点关注：

- 某个渠道事件数突然为 `0`
- 成功率明显下降
- 平均延迟异常升高

这通常意味着：

- 渠道接入断了
- 下游运行时卡住了
- 出站投递失败率上升

---

## 7. 审计追踪

“审计追踪”页用于按条件查看 `ChannelHub` 的处理记录。

当前支持的常用筛选包括：

- `Request ID`
- `适配器`
- `事件类型`
- `开始时间`
- `结束时间`

适合用来排查：

- 某条消息为什么没有进入系统
- 某次请求是否经过了正确适配器
- 某个时间段内是否有批量错误

建议排查顺序：

1. 先按时间范围缩小
2. 再按适配器过滤
3. 若已有请求号，再按 `Request ID` 精确定位

---

## 8. onebot-adapter 接入说明

如果你使用的是 `Plugin/vcp-onebot-adapter`，当前建议接到 `B2` 入口：

```text
/internal/channel-hub/events
```

相关配置文件：

- `Plugin/vcp-onebot-adapter/.env.example`
- `Plugin/vcp-onebot-adapter/plugin-manifest.json`

当前默认方向：

- `VCP_CHANNEL_HUB_URL=http://127.0.0.1:6010/internal/channel-hub/events`

说明：

- 如果只填写到主机级别，当前适配器启动代码会自动补到 `ChannelHub` 事件路径
- 文本回包已经兼容 `ReplyNormalizer` 输出的结构

---

## 9. 推荐操作流程

如果你是第一次接入一个新渠道，建议按下面顺序操作：

1. 先创建适配器
2. 确认适配器配置 JSON 无语法错误
3. 发送一条测试消息，让系统先自动产生基础事件
4. 打开“审计追踪”确认消息已经进入 `ChannelHub`
5. 若需要固定会话路由，再创建“会话绑定”
6. 如果出站回包不正常，再检查“发件箱”

---

## 10. 常见问题

### 10.1 点击保存没反应

优先检查：

- 浏览器控制台是否有前端报错
- `routes/admin/channelHub.js` 是否已正确挂载
- `/admin_api/channelHub/*` 是否可访问

### 10.2 会话绑定编辑没反应

当前版本已经支持编辑弹窗打开和保存。

如果仍然无响应，优先检查：

- 页面是否刷新到最新静态资源
- 浏览器是否缓存旧版 `page.unified.js`

### 10.3 改了外部会话 Key，但绑定主键没有变化

这是当前实现行为，不是页面故障。

当前更新逻辑：

- 原 `bindingKey` 仍作为内部主标识
- `externalSessionKey` 作为绑定内容字段更新

如果你需要“主标识也彻底更换”，请删除旧绑定后重新创建。

### 10.4 页面出现乱码

若 `ChannelHub` 页面再出现中文乱码，优先检查：

- `AdminPanel/channelHub.html`
- `AdminPanel/js/channelHub/page.unified.js`

当前版本已经清理过一轮乱码文案，如果后续再次出现，通常是文件编码或错误覆盖导致。

---

## 11. 运维建议

- 不要直接在生产环境里频繁删除适配器，优先先停用或确认依赖关系
- 调整绑定前，先记录原来的 `外部会话 Key / VCP 会话 ID / Agent ID`
- 批量问题优先看“审计追踪”，单条投递问题优先看“发件箱”
- 适配器配置 JSON 建议先在本地格式化后再粘贴

---

## 12. 相关文件

页面与接口：

- `AdminPanel/channelHub.html`
- `AdminPanel/js/channelHub/page.unified.js`
- `AdminPanel/js/channelHub/api.unified.js`
- `routes/admin/channelHub.js`

核心模块：

- `modules/channelHub/ChannelHubService.js`
- `modules/channelHub/AdapterRegistry.js`
- `modules/channelHub/SessionBindingStore.js`
- `modules/channelHub/DeliveryOutbox.js`
- `modules/channelHub/AuditLogger.js`

插件接入：

- `Plugin/vcp-onebot-adapter/src/index.js`
- `Plugin/vcp-onebot-adapter/src/adapters/vcp/channelClient.js`
- `Plugin/vcp-onebot-adapter/README.md`
