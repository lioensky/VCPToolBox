# VTrade 插槽契约

VTrade 的核心只管账本、时钟和行情版本。行情从哪来、看什么指标和信号、股票池怎么分、模拟成交怎么算、以后接哪个券商、AI 还能调用什么工具，都放在六个插槽里。每个插槽有内置默认实现；别的插件注册自己的实现即可替换或增加，不需要修改 VTrade。

契约版本：`1`。可运行的最小例子见 `examples/extensions.cjs`，测试见 `tests/slots.test.cjs`。

## 速查

| 插槽 | 核心调用 | 默认实现 | 由谁选择 |
| --- | --- | --- | --- |
| `market` 行情源 | `load(request)` → 标准日线数据 | `tdx`、`json` | 管理员来源配置 `sources[].kind` |
| `analysis` 指标与信号 | `compute(request)` → `series` 或 `signals` | `ma`、`ema`、`boll`、`macd`、`kdj`、`rsi`、`ma-cross` | `GetAnalysis` 的 `analysis` |
| `universe` 股票池与板块 | `groups(request)` → `groups` | `all` | `GetUniverse`、`CreateSession` 的 `universe`/`group` |
| `execution` 模拟撮合规则 | `settle(order)` → 成交或拒绝 | `reference`、`a-share-demo` | `CreateSession` 的 `rulesProfile` |
| `broker` 券商接口 | 本版不调用 | `none` | — |
| `tool` AI 决策工具 | `run(context, args)` → JSON | `financials`；可选适配器 `tencent-intraday` | `CallTool` 的 `tool` |

`ListExtensions` 按插槽列出当前全部实现，模型和页面看到的就是这份列表。

## 注册方式

扩展通常是另一个 `hybridservice`/`direct` 插件，在自己的 `initialize` 里拿到 VTrade 模块后注册：

```js
// Plugin/MyVTradeExtension/index.js
let dispose = () => {};
async function initialize(config, { pluginManager }) {
    const vtrade = pluginManager.getServiceModule('VTrade');
    if (!vtrade) return; // VTrade 未启用
    dispose = vtrade.register('analysis', 'my-signal', mySignal);
}
async function shutdown() { dispose(); }
module.exports = { initialize, shutdown };
```

- `register(slot, id, implementation)` 返回撤销函数。加载器按目录名顺序初始化插件，所以注册可以早于或晚于 VTrade 自己的初始化；VTrade 在用到时才按标识查找。
- `id`：2 至 50 位小写字母、数字或连字符，字母开头。同一插槽不能重名，内置标识不能覆盖。建议带上自己的前缀。
- 每个实现必须有 `description`（不超过 300 字，模型可见）；可选 `contractVersion`（目前只接受 `1`）和 `parameters`（参数名到说明的对象，模型可见）。
- VTrade 停止或重载时清除全部外部注册；重载后各插件的 `initialize` 会再次注册。
- 找不到指定实现时返回 `PROVIDER_UNAVAILABLE`，不会改用默认实现或合成数据。
- 实现抛出 `vtrade.TradeError(code, message)` 时，调用方收到这组 `code` 与 `message`。抛出其他错误时调用方只收到 `PROVIDER_FAILED`，原始信息只写本机服务日志。私有实现不要把内部细节放进 `TradeError`。
- 异步调用有时限：`analysis`、`universe`、`tool` 10 秒，`market` 60 秒。超时返回 `PROVIDER_TIMEOUT`，同时通过传入的 `signal` 通知实现停止。

VTrade 自带的可选适配器放在 `adapters/`，只有管理员在 `VTRADE_ADAPTERS` 中列出时才加载，默认一个都不加载。

## market 行情源

- **输入** `request`：
  - `sourceId`、`name`：来源配置中的标识与名称。
  - `config`：该来源在配置文件里的条目（去掉 `directory`），实现自己定义需要的字段，例如 `options`、`securities`。
  - `completedThrough`：本次接收的最晚日期（上海时区保守盘后截止）。
  - `readFile(relativePath, maxBytes?)`：配置了绝对 `directory` 时才提供，只能读该目录内的文件，返回 `Buffer`。实现拿不到目录本身。
  - `signal`：超时或停止时触发。
- **输出**：标准日线数据，格式见 README「标准 JSON」：整数分、股、不复权、上海时区，`source.kind` 为来源类型标签。
- **核心做什么**：校验格式与单位，丢弃晚于 `completedThrough` 的日线，写入不可变的版本化来源；同一来源在增量中不能改变来源类型、单位或证券池，历史日线冲突整批拒绝。AI 只能用 `sourceId` 触发 `SyncSource`，不能传路径或 URL。
- **可选** `validate(config)`：配置不对时抛错。内置类型在启动时检查，插件类型在同步时检查。
- **选择**：来源配置 `sources[]` 中写 `"kind": "<id>"`。
- **默认**：`tdx` 只读逐项列出的 `sh/sz/bj/lday/*.day`；`json` 读取一个标准 JSON 文件，可由 `scripts/vtrade_download.py` 生成。

## analysis 指标与信号

- **声明** `type`：`indicator` 或 `signal`。
- **输入** `request`：`symbol`；`asOf`（模拟日）；`bars`（截至模拟日的日线，按日期升序，整数分、股）；`options`（调用方传入的 JSON 对象）；`signal`。
- **输出**：
  - `indicator`：`{ series: [{ date, values: { 名称: 数值或 null } }] }`，日期严格递增，每项最多 16 个值。价格类指标沿用整数分口径。
  - `signal`：`{ signals: [{ date, action, strength?, note? }] }`，`action` 为 `buy`/`sell`/`hold`/`watch`，`strength` 在 0 至 1，`note` 不超过 200 字。
- **核心保证**：`bars` 不含模拟日之后的数据；结果中出现之后的日期返回 `FUTURE_DATA`。最多 50000 项（与单个数据源的日线上限一致），按调用方的 `limit` 返回最后几项。分析只读，不写账本，也不会自动下单。
- **默认**：`ma`（收盘价简单均线，`period` 2 至 250，默认 5）；`ma-cross`（`fast` 默认 5、`slow` 默认 20 的均线交叉）。两者都是公开经典指标，不是选股建议。

## universe 股票池与板块

- **输入** `request`：`asOf`；`securities`（所选数据源的 `{ symbol, name }`）；`options`；`signal`。
- **输出**：`{ groups: [{ id, name?, symbols }] }`，1 至 200 组，组内最多 5000 个标识。
- **核心做什么**：只保留数据源中存在的证券，并返回 `missing` 计数。`CreateSession` 使用 `universe` 与 `group` 时，以运行的起始日为 `asOf` 解析一次，把结果写进运行和 `GetRunManifest`；之后不随实现变化。`symbols` 与 `universe`/`group` 只能二选一。
- **默认**：`all`，所选数据源的全部证券。

## execution 模拟撮合规则

- **`settle(order)`**，同步调用，在账本事务内执行：
  - 输入 `order`：`date`（结算日）、`side`、`symbol`、`quantity`、`limitPriceCents?`、`reservedCents`、`bar`（结算日日线的副本）。
  - 输出 `{ priceCents, feeCents }`（整数分）或 `{ rejected: '原因' }`。
- **可选** `reserveCents({ quantity, limitPriceCents?, closeCents })`：买入意图的预留整数分。不提供时使用默认公式：限价或当日收盘价上浮一成，加万分之三、最低一元的演示手续费。
- **可选** `settleConditional({ side, type, quantity, triggerPriceCents?, bar, reservedCents })`：条件单触发后的同步参考价格与费用。未实现此方法的旧扩展仍可处理普通意图，但不能创建条件单或带止盈止损的买入；内置执行模型均实现此方法。核心仍检查价格范围、预算和 T+1。
- **可选** `costs`：公开的成本参数（数值），出现在观察的 `rules` 和运行清单中。
- **核心保证**（对任何实现都成立）：缺日线、停牌或零成交量时不调用实现，直接记未完成；买价低于当日最低价、卖价高于当日最高价不记成交；限价必须满足；买入总额不超过预留；卖出费用不超过成交额；数量单位 100 股和买入后下一数据日可卖由核心管理；`settle` 返回 Promise 时拒绝本次推进，账本不变。
- **选择**：`CreateSession` 的 `rulesProfile`，运行记住所用标识。实现被移除后，运行仍可查询，但不能下单或推进日期。
- **默认**：`reference`（下一数据日开盘价加万分之五滑点，手续费万分之三、最低一元）；`a-share-demo`（另要求涨跌停字段）。这些是演示设置，不代表真实费用。

## broker 券商接口

- 本版只固定形状，**核心不调用**。实现必须有 `capabilities: { live: boolean }`，`ListExtensions` 会列出 `live`。
- 以后若另行立项接入券商，会在新的契约版本中定义 `submit(intent)`、`cancel(reference)`、`status(reference)`，并要求管理员显式启用。
- **默认** `none`：`live: false`，不连接任何券商。

## tool AI 决策工具

- **`run(context, args)`**：
  - `context`：`asOf`；`session`（`sessionId`、`symbols`、`dataMode`、`revision`、`rulesProfile`）；`bars(symbol)`（池内证券截至模拟日的日线）；`options`（来源配置 `tools.<id>` 中除 `directory` 外的字段）；`readFile`（配置了 `tools.<id>.directory` 时提供）；`signal`。
  - `args`：`CallTool` 的其余参数，VCP 传来的多为字符串。`command`、`sessionId`、`tool`、`maid`、`requestId` 不会传给工具。
- **输出**：可序列化为 JSON 的对象，不超过 64 KB。
- **核心保证**：工具拿不到账本写入口，`bars` 截至模拟日。工具自己读取的外部数据由实现负责时点正确。`network: true` 表示会访问外部服务，列表和结果都会标出。
- **默认** `financials`：读取 `tools.financials` 配置的本机财务文件，只返回公告日不晚于模拟日的期次，缺少公告日的期次不提供。
- **可选适配器** `tencent-intraday`：见 README「腾讯分时」。

## 不在插槽里的部分

账本结构、请求去重、观察绑定、版本化行情仓库、存档校验和 HTTP 页面属于核心，不开放替换。策略本身不是插槽：Agent 通过工具读观察、调用分析与工具、提交计划和模拟意图，决策过程留在 Agent 侧并记录在账本中。
