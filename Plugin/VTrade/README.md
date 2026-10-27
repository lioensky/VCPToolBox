# VTrade

VTrade 是 VCP 的本地看盘与模拟交易插件。看盘直接读取本机通达信目录中的全市场日线；模拟交易把行情观察、候选计划、虚拟操作、持有记录和复盘放在同一条流程中，供 Agent 和人使用同一套账本；对决让玩家和 Agent 在同一段历史行情上逐日决定仓位，与随机操作者比较成绩。

行情由用户自行下载或导入。插件不附带真实证券数据，不连接券商或交易所，核心不联网。内置合成日线只用于离线演示。行情源、指标与信号、股票池、撮合规则、券商接口和 AI 工具是六个可注册的插槽，见下文「插槽与扩展」和 `SLOTS.md`。

## 快速演示

需要 Node.js 22.7 或更新版本。独立预览和核心不需要安装 npm 依赖。

在插件目录运行：

```sh
node preview.cjs
```

打开终端输出的本机链接。访问凭据放在 URL fragment 中，页面读取后移除；服务只监听 `127.0.0.1`。可用 `--port` 选择端口，或用 `--data-dir` 指定本机目录。默认预览数据保存在用户目录的 `.vtrade-preview/`，不写入源码目录。

页面是可自由拼放面板的工作台，顶栏按布局切换看盘与模拟交易，另有“对决”入口：

1. **看盘**（默认）：在“设置 → 数据 → 看盘数据目录”填写通达信的 `vipdoc` 目录后，行情列表显示全部股票、指数和基金。可按代码、名称或拼音首字母搜索（在页面任意处直接输入即可开始搜索），按列排序，用方向键逐只切换；底部切换 A 股、创业板、科创板、北交所、指数、基金、自选和自建板块。图表提供日、周、月、季、年 K 线，成交量和 MA5/10/20/60；“个股行情”面板显示开高低收、成交额、振幅与区间涨跌。看盘不需要模拟交易。
2. **模拟交易**（“模拟交易”“复盘”布局）：一次模拟交易是一个虚拟账户加一条按数据日推进的时间线。在“设置 → 模拟交易”中选择本机通达信行情并建立账户后，可以搜索当前行情源覆盖的全部股票，选中后直接计划、看图和模拟下单。自选与板块只整理视图，不限制可交易范围；账本仅记录实际用到的股票。记录模拟意图后点击“推进到下一数据日”查看虚拟成交，持仓、委托、日志和资金曲线随之更新。导入的固定数据集仍只覆盖文件内证券，主要供历史实验使用。删除模拟交易会删除这条账本的全部记录，不影响自选、板块或行情源。
3. **对决**（`/duel/` 页面，见下文「对决」）：单练、观战 Agent、与 Agent 同场，一局 60 个交易日。

真实 VCP Agent 使用下面的工具协议；插件不内置模型账号或调用模型的网络客户端。

K 线、成交量与资金曲线由插件自带的画布图表引擎绘制（`frontend/chart-engine.mjs`、`frontend/chart-scale.mjs`），不依赖第三方图表库；控件使用固定版本的 VCPUI 组件。模拟交易中图表只显示到当前模拟日，买卖箭头只来自虚拟成交，持仓线是当前均摊成本；水平参考线只留在当前页面，不会创建条件单或影响账本。首次打开页面会显示免责声明与数据获取说明。

## 在 VCP 中使用

将整个 `VTrade/` 目录放入 `Plugin/`，按正常流程重启后端。插件使用 `hybridservice` 与 `direct` 协议，现有加载器会发现清单，不需要修改 `server.js` 或 `Plugin.js`。

- 工具名称为 `VTrade`。将 `{{VCPVTrade}}` 等工具说明注入所选 Agent；`AI_GUIDE.md` 是给 Agent 的操作说明。
- 页面位于主后端的 `/admin_api/vtrade/`（经管理面板端口访问同样可用），对决页是 `/admin_api/vtrade/duel/`；页面与 API 都挂在现有管理员认证之后，不新增匿名接口。管理面板无需改动；VCPChat 的 VGame 大厅可以打开对决页并请 Agent 出手（另一个改动），不装也能在浏览器里单练。
- 存储默认在 `Plugin/VTrade/data/`（已被 `.gitignore` 排除）。可在本机 `config.env` 设置 `VTRADE_DATA_DIR`、`VTRADE_SOURCES_FILE`、`VTRADE_ADAPTERS`，模板见 `config.env.example`。
- AI 工具不接受服务器路径、远程 URL 或下载指令，只能同步管理员已配置的来源。导入数据、来源设置和看盘只在管理员页面进行，分别走 `/api/import`、`/api/settings`、`/api/market`，工具调用无法访问，因此模拟交易中的 Agent 拿不到模拟日之后的行情。
- 关闭插件时加载器调用 `shutdown()`。direct 插件更新需要正常重启。

`agentName`、`maid` 都不是身份凭据。本版本面向管理员控制的受信任 Agent，所有运行由同一管理员管理，不提供多租户账户隔离。

## 对决

一局是一道历史行情题加一至四个座位（最多一位玩家）。参赛者只看到开局前 120 个交易日和已经走过的日子，每个交易日收盘后交一次目标仓位（0、25、50、75、100%），可选止损（0、5、8、10%），再写一句理由。全部座位交齐前，决定是密封的；交齐后一起推进一天，揭晓各自的决定和理由。局长 60 个交易日。

- **玩法**：单练（只有玩家）、观战（一至四位 Agent 操作）、同场对决（玩家与一至三位 Agent）。
- **出题**：盲测（从本机行情随机抽一只上市满一年、非 ST、起始资金买得起一手的股票和一段时间，种子可复现）、每日挑战（当天日期做种子，所有人同一道题）、名局重现（主要指数的七段知名行情，按盲测进行，指数按 1 份交易）、明牌（指定股票和起始日）。没有设置通达信目录时使用合成演示行情。
- **盲测**只隐藏名称、代码和日期（界面显示“前N”“第N天”），价格、成交量照常显示；配置了财务文件（`tools.financials`）时，另按当天以前已公告的最近一期报告显示总市值、流通市值、市盈率（TTM）、市净率等。“严格盲测”把价格换算为起点 100、成交量换算为 20 日相对值，并隐藏基本面，默认关闭。结束后才能揭晓题目。
- **成交**：默认次日开盘价，滑点、费用和涨跌停沿用 execution 插槽的 `a-share-demo`（指数题用 `reference`）；可改为当天收盘价，收盘封板时不成交。整手买卖，保持同一仓位不再交易，未成交的单下一天按原目标重试。每局一个独立的小账本，不占用模拟交易账户。
- **成绩**：收益、相对买入持有、最大回撤、成交次数、卖出胜率；与 1000 个随机操作者比较百分位（他们改仓的频率与该座位相同，在同一道题上按同样规则成交），评级 S（前 10%）、A（前 25%）、B（前 50%）、C（前 75%）、D。复盘给出最好的一步、错过的一段和最深的回撤。同一道题、同样的决定，成绩完全一样。
- **资产走势**：对局页和复盘的 K 线下方，按开局以来的收益画出每位参赛者、买入持有和沪深 300（本机目录有 `sh000300` 时）；沪深 300 只给到当天，不显示点位和日期，盲测不会因此暴露时段。Agent 的局面文本里有同样的大盘一行。这一栏和各个副图（成交量、MACD 等）都可收起，收起后保留图例和当前值。
- **正反馈**：每天结算时判定高光（重仓吃到大涨、减仓后躲过大跌、执行止损、净值新高、反超、连续领先）。玩家和每位 Agent 各有战绩：经验与等级、今日目标、成就、连胜、对手战绩、每日挑战连续天数、本机排行。经验按百分位和好的决定给，不按收益多少或交易次数。
- **资金挑战**：每位玩家一个资金，从 1 万元做到 1 亿元，只用于单练，每局结束时的资金带入下一局；跨过 10 万、100 万、1000 万各提示一次，到 1 亿通关，资金低于 500 元本轮结束，可随时重置。

Agent 用四条命令参加对决：`GetDuelGuide`、`GetDuelTurn`、`SubmitDuelDecision`、`GetDuelResult`，均返回纯文本。交决定必须带决策票据：每个 Agent 座位每回合一张，只能从登录后的页面接口 `/api/duel`（`invites`、`turn`）取得，工具调用列不出来，所以 Agent 不能替别的座位或在别的回合下决定。请 Agent 出手的编排在 VCPChat 的 VGame 大厅一侧（大厅卡片打开本页，编排器把 `turn` 返回的邀请文本交给对应 Agent）。编排器打开本页前用 `syncRoster` 送来 Chat 中已配置模型的 Agent 名单和小头像，新局按这份名单选 Agent；每次 `invites` 也表明编排器在线，对局视图据此带 `orchestrator.connected`。编排器超过 15 秒没有来取邀请时，页面立即提示 Agent 不会出手，并可让本回合维持原仓位。

对局、战绩和资金挑战保存在插件存储的 `duels/` 目录。

## 插槽与扩展

| 插槽 | 用途 | 默认实现 |
| --- | --- | --- |
| `market` | 行情源：把某处的日线变成标准数据 | `tdx`、`json` |
| `analysis` | 指标与信号：只看截至模拟日的日线 | `ma`、`ma-cross` |
| `universe` | 股票池与板块分组 | `all` |
| `execution` | 模拟撮合规则：成交价、费用或拒绝 | `reference`、`a-share-demo` |
| `broker` | 券商接口：只定义形状，本版不调用 | `none` |
| `tool` | AI 决策工具：只读，拿到截至模拟日的行情 | `financials` |

扩展插件在 `initialize` 中调用 `pluginManager.getServiceModule('VTrade').register(slot, id, implementation)`，得到撤销函数。注册可以早于或晚于 VTrade 初始化；找不到实现时直接报 `PROVIDER_UNAVAILABLE`，不会悄悄换成默认实现。每个插槽的输入、输出、核心保证和错误约定见 `SLOTS.md`。

### 最小例子：接一个 CSV 数据源和一个突破信号

完整可运行版本在 `examples/extensions.cjs`，`tests/slots.test.cjs` 用它跑通“同步来源 → 建立运行 → 取信号”。

```js
const csvSource = {
    description: '示例：读取管理员目录下的 CSV 日线（元、股），不复权。',
    async load({ name, config, readFile }) {
        const cents = text => Math.round(Number(text) * 100);
        const securities = [];
        for (const item of config.securities) {
            const [, ...lines] = (await readFile(item.file)).toString('utf8').trim().split(/\r?\n/);
            securities.push({ symbol: item.symbol, name: item.name, bars: lines.map(line => {
                const [date, open, high, low, close, volume] = line.split(',');
                return { date, openCents: cents(open), highCents: cents(high), lowCents: cents(low),
                    closeCents: cents(close), volume: Number(volume) };
            }) });
        }
        return { schemaVersion: 1, source: { kind: 'example-csv', name, adjustment: 'none', currency: 'CNY',
            timezone: 'Asia/Shanghai', volumeUnit: 'shares' }, securities };
    },
};
const breakout = {
    type: 'signal',
    description: '示例：收盘价突破前 N 日最高价记 buy。教科书示例，不是选股建议。',
    parameters: { days: '回看天数，默认 20' },
    compute({ bars, options }) { // bars 截至模拟日，看不到未来
        const days = options.days ?? 20, signals = [];
        for (let i = days; i < bars.length; i++) {
            const high = Math.max(...bars.slice(i - days, i).map(b => b.highCents));
            if (bars[i].closeCents > high) signals.push({ date: bars[i].date, action: 'buy' });
        }
        return { signals };
    },
};
vtrade.register('market', 'example-csv', csvSource);
vtrade.register('analysis', 'example-breakout', breakout);
```

管理员在来源配置中启用这个数据源（`directory` 必须是绝对路径；AI 只看到 `sourceId`）：

```json
{ "schemaVersion": 1, "sources": [
  { "id": "feed-csv", "kind": "example-csv", "directory": "C:/YOUR_CSV",
    "securities": [{ "symbol": "EXAMPLE", "name": "自建数据", "file": "EXAMPLE.csv" }] }
] }
```

之后 Agent 按普通流程使用：`SyncSource(sourceId: feed-csv)` → `CreateSession(sourceId: feed-csv)` → `GetAnalysis(analysis: example-breakout, options: {"days":20})`。

## 数据由用户准备

所有价格使用**整数分**，成交量使用**股**；日期是上海时区的交易日期，严格递增；只支持 `adjustment: "none"` 的不复权日线。真实数据、下载结果和运行记录都不要提交到代码仓库。

### 标准 JSON

以下全部为合成数据：

```json
{
  "schemaVersion": 1,
  "source": {
    "kind": "user",
    "name": "我的本地日线",
    "adjustment": "none",
    "currency": "CNY",
    "timezone": "Asia/Shanghai",
    "volumeUnit": "shares"
  },
  "securities": [{
    "symbol": "DEMO-USER",
    "name": "自建演示证券",
    "bars": [
      {"date":"2025-01-06","openCents":1000,"highCents":1020,"lowCents":990,"closeCents":1010,"volume":10000},
      {"date":"2025-01-07","openCents":1010,"highCents":1040,"lowCents":1000,"closeCents":1030,"volume":12000}
    ]
  }]
}
```

`source.kind` 是来源类型标签（小写字母、数字、连字符）。可选字段为 `suspended`、`limitUpCents`、`limitDownCents`。每份数据最多 100 个证券、合计五万根日线；页面单文件上限 5 MB。额外字段不会进入标准数据对象。

### 通达信 .day（核心内置，不联网）

通达信由用户在客户端完成盘后下载。VTrade 不修改通达信文件，也不读取板块、公式、自选或账户。支持常见的小端 32 字节日线记录：日期、四个整数价格、成交额、成交量和保留字段。不支持分钟线或复权文件。

- **看盘**读取 `vipdoc` 下 `sh/sz/bj/lday` 的文件列表、每个文件末尾两条记录（列表报价）和所选证券的全部日线，以及同级 `T0002/hq_cache` 中 `shs.tnf`、`szs.tnf`、`bjs.tnf` 的证券名称与拼音简称。债券、回购和 B 股不列出；基金价格按 0.001 元读取，其余按分。报价按文件大小与修改时间缓存在存储目录的 `cache/market-quotes.json`，服务启动后在后台预读一次。
- **普通全市场模拟**按需从已配置的本机通达信目录读取股票日线；列表和报价都按模拟日截断。当前虚拟账本只支持以分计价的股票，基金和指数仍可在独立看盘页查看。目录绑定到创建时的路径指纹；目录、历史交易日或已记账的历史日线发生变化时停止操作，避免账本错位。日线文件由用户在客户端维护，VTrade 不写回。
- **版本化固定来源**只读逐项列出的文件，价格按分、成交量按股读取；读取前后核对文件大小、修改时间和身份，遇到半写文件或不完整记录时失败并保留旧行情。

也可以在“设置 → 数据 → 导入行情”中选择单个 `.day` 文件，填写证券标识后导入。

### 来源配置与日更

两种配置方式，可同时使用：

- 在“设置 → 数据 → 添加本机来源”中填写通达信目录、证券（每行一个六位代码，可加市场前缀与名称）、可选的最早日期和自动同步间隔，可先“检查目录”。保存在存储目录的 `settings/sources.json`；已同步的来源不能再改证券列表或最早日期，只能新建来源。
- 把 `sources.example.json` 复制到自己的运行目录，改为自己选择的目录和证券，在 `config.env` 中设置 `VTRADE_SOURCES_FILE`（独立预览用 `node preview.cjs --sources-file <文件>`）。这类来源在页面中只读。

两者都留空时不读取任何外部目录。模型拿不到配置中的路径。

- `kind` 是 market 插槽标识：内置 `tdx`、`json`，或扩展插件注册的标识。
- `syncIntervalSeconds: 0` 表示手动同步；设为 60 至 86400 后，服务启动时同步一次，并按间隔检查。同步只更新行情，不会续接运行或推进模拟日期。
- `tools` 段给工具插槽提供本机设置，例如 `tools.financials` 指向财务文件。

所有增量采用上海时区保守的 18:00 截止：此前最多接收到前一自然日，此后可接收当日。该规则不证明供应商已发布完整行情。每个证券保留各自的覆盖日期，缺少日线不会补成零价。原始发布时间未知，版本记录中的 `availableAt` 为 `null`，`ingestedAt` 只表示本机采集时间。

### 可选下载脚本（核心之外）

`scripts/vtrade_download.py` 是用户自己运行的 Python 脚本，服务器不会导入或执行它。先在自己的 Python 环境安装 AKShare 或 baostock，再运行（尖括号为需替换的参数）：

```sh
python scripts/vtrade_download.py daily --provider akshare --symbols <SH.xxxxxx,SZ.xxxxxx> --start <YYYYMMDD> --end <YYYYMMDD> --out <本机JSON>
python scripts/vtrade_download.py daily --provider baostock --symbols <SH.xxxxxx> --start <YYYYMMDD> --end <YYYYMMDD> --out <本机JSON>
python scripts/vtrade_download.py financials --provider baostock --symbols <SH.xxxxxx> --years <YYYY-YYYY> --out <本机JSON>
```

- 日线：AKShare 调用 `stock_zh_a_hist(period="daily", adjust="")`，价格元转分，成交量手转股；baostock 调用 `query_history_k_data_plus(adjustflag="3")`（不复权），成交量本来就是股，`tradestatus=0` 记为停牌。输出即标准 JSON，可作为 `json` 来源或在页面导入。
- 财务：AKShare 按报告期调用 `stock_yjbb_em`，公告日取“最新公告日期”；baostock 调用 `query_profit_data` 与 `query_growth_data`，公告日取 `pubDate`，两者不同时取较晚者。只请求已经结束的报告期。数值原样保存，单位写在文件的 `fields` 中（baostock 的比率是小数，0.07 约为 7%）。
- 默认不覆盖已有输出。加 `--replace` 时先完成下载和校验，再原子替换；失败保留原文件。
- 依据 AKShare 与 baostock 官方文档，核对日期 2026-10-26。接口或单位变化时应先更新脚本。开源接口库的许可不等于行情再分发许可，数据可得性和使用权限由用户向实际来源确认。

### 财务文件与 financials 工具

财务文件格式：`{ schemaVersion: 1, kind: "financials", source, fields, securities: [{ symbol, reports: [{ period, publishedAt, metrics }] }] }`。在来源配置写上 `"tools": { "financials": { "directory": "<绝对目录>", "file": "financials.json" } }` 后，Agent 可用 `CallTool(tool: financials, symbol)` 读取。工具只返回 `publishedAt` 不晚于模拟日的期次；没有公告日的期次不提供，并在 `withheld` 中计数。同一证券在行情和财务文件中要使用同一个标识。

### 腾讯分时（可选适配器，默认关闭）

`adapters/tencent-intraday.cjs` 读取腾讯网页分时。它是**非公开接口，仅供个人学习**，可能随时变化或失效，不是默认数据源。管理员在 `config.env` 写 `VTRADE_ADAPTERS=tencent-intraday` 后才加载；Agent 通过 `CallTool(tool: tencent-intraday, symbol)` 调用。证券标识需形如 `SH.xxxxxx` 或 `xxxxxx.SH`（六位数字）。分时只供观察，不参与虚拟结算；分时日期晚于模拟日时拒绝返回，避免提前看到行情。

图表中的“腾讯当日分时”显示该适配器返回的价格点和累计成交量变化，明确标为分时点，不当作一分钟 OHLCV。看盘页显示当前网页分时；历史模拟页只能查看模拟日及以前的数据。适配器未启用、接口失效或历史日期不匹配时，页面显示错误，不自动填造 K 线。

### 本机一分钟 OHLCV

“设置 → 数据 → 一分钟线”接收本机 JSON 或 CSV 文件。插件不提供历史下载渠道。JSON 格式如下，时间为上海本地交易时间，价格为整数分、成交量为股：

```json
{
  "schemaVersion": 1,
  "sourceId": "minute-example",
  "dailyRef": "demo",
  "name": "示例一分钟线",
  "securities": [{ "symbol": "DEMO-A", "bars": [
    { "timestamp": "2025-01-10T09:30", "openCents": 1000, "highCents": 1010,
      "lowCents": 995, "closeCents": 1005, "volume": 1200 }
  ] }]
}
```

CSV 首行须为 `symbol,timestamp,openCents,highCents,lowCents,closeCents,volume`，其余逐行填写同一字段。`dailyRef` 关联日线数据集标识，或同步来源的 `feed-` 标识。时间只能在 09:30–11:29、13:00–14:59，逐证券严格递增，OHLC 须自洽。再次导入同一来源须保留已有记录且仅在末尾增加数据；导入会保存内容版本与请求回执。图表和 `GetMinuteChart` 支持 1、5、15 和 1–120 分钟自定义聚合，不跨午休或隔日合并；`complete: false` 表示该组缺少连续的一分钟数据。模拟交易只能读取当前模拟日及以前的分钟线，推进和撮合仍按日线。

### 板块、指标与训练

自选和自建板块保存在 VTrade 本机存储中。工作台第一次打开时会迁移浏览器里已有的自选与板块；看盘、模拟交易和 Agent 此后共用 `ListBoards` / `ChangeBoard`。行情列表的“板块管理”可新建、删除、重命名、排序并编辑成员。普通全市场模拟列表默认显示全局自选，也可切换到全部证券并搜索；只要模拟日已有数据，就能选中并下单，不必先加入自选。固定数据集回放仍仅显示该数据集覆盖的证券。行情列表的表头右键可调整显示列及顺序，拖动表头右缘可改列宽；布局和列设置保存在本机浏览器。

主图提供 MA、EMA、BOLL，副图提供 MACD、KDJ、RSI。图表上方每个指标一个开关，按下即显示；各图区左上角的图例按线条颜色显示当前值，并可隐藏、设置或移除该指标。设置面板浮在图表上，可改参数（MA 与 EMA 各 1 至 6 个周期）以及每条线的颜色和粗细，修改即时生效并自动保存：看盘随当前图表布局保存，对决保存在本机浏览器。图表右键打开第一个指标的设置。`GetAnalysis` 提供同一套公开指标；`ScreenBoard` 可按一个指标字段和阈值筛选当前模拟股票池，结果在页面上可另存为板块。自定义通达信公式与逐笔数据属于后续工程，本期没有公式编辑器。

模拟买入可附带止盈或止损；条件单面板还可设到价买入、移动止损和 OCO，支持改价及撤销。到价触发后仍由所选执行模型做虚拟撮合。日线跳空按开盘价参考，同一天止盈与止损都触发时先处理止损；无法知道盘中先后顺序。

训练面板（旧流程，已由对决取代，不再出现在面板库，已保存的布局仍可打开）可指定或按种子随机抽取起点，并创建人与 Agent 两份独立账本。盲测用匿名证券和伪日期展示，直到调用 `RevealTraining`；可逐日推进或在页面自动播放。`GetTrainingResult` 返回收益、回撤、胜率、盈亏比、持有时间及买入持有基准。Agent 在 VCPChat 使用训练回执中的 Agent `sessionId`，由 Agent 按所选操作预设调用工具；服务不会在后台自动发模型请求。同一 Agent 若主动调用独立的最新看盘命令，插件无法证明其未看过未来行情，严格防作弊需要宿主权限隔离。

## 运行模式

接口中的“运行”（`session`）即页面中的“一次模拟交易”。

- **固定回放 `snapshot`**：固定内容版本，适合复现历史实验。来源以后更新不会改变该运行。
- **连续模拟 `continuous`**：可以从最新已完成日开始。到数据末尾时显示“等待新日线”，仍可保存计划、预览和记录待结算意图；没有下一根数据时推进返回 `WAITING_DATA`，不改变日期、持仓或资金。
- **本机全市场账户**：`CreateSession` 使用 `marketMode: "directory"`，无需 `symbols`、`universe` 或 `group`。`GetSessionSecurities` 搜索模拟日已出现的证券，`GetSessionQuotes` 与 `GetChart` 按模拟日截断；下单时才把该证券记入账本。目录新增已完成日线后，可直接 `AdvanceDay`，无需 `SyncSessionData`。
- **同步、接收版本、推进日期分开**：`SyncSource` 只产生行情版本；`SyncSessionData` 才把新版本接到连续运行，仍不改变模拟日；`AdvanceDay` 才处理下一数据日的虚拟结算。

“设置 → 数据 → 导入行情”可新建行情来源，或对已有来源导入增量。重复日期且字段相同则去重；同日数据冲突时整批拒绝，旧版本保留。增量中不能切换单位、来源类型、价格口径或证券池。首版历史只保存一次，后续版本保存新增日线和父版本引用，读取时重建并核验内容哈希。

`GetRunManifest(sessionId)` 提供行情或目录指纹、执行模型、规则、实际用到的证券、起始日期与资金、版本接收历史及 `configHash`。本机全市场模拟按需读取当前目录，是日常练习账本，不是冻结历史快照；可复现实验请使用固定数据集或训练。当前未处理权威交易日历、历史股票池与公司行动，净值不等于含分红等事件的长期总收益。

## 模拟规则

- 每次观察只返回当前模拟日期及以前的日线，最多展示最近三十根；更长历史用 `GetChart`。
- 意图记录与虚拟成交分开。记录后预留资金或数量；推进到下一数据日时，才由所选撮合规则（execution 插槽）决定成交价、费用或拒绝。核心对所有规则统一检查：停牌或缺数据记未完成，不记优于当日最低/最高价的成交，满足限价和预留预算。
- 数量单位 100 股，买入后的下一数据日可卖，由核心管理。
- `reference`：下一数据日开盘价加万分之五滑点；手续费为成交额的万分之三、最低一元。不校验来源未提供的涨跌停。
- `a-share-demo`：在此基础上要求下一日的涨跌停字段；缺失、开盘在不利边界或滑点越界时记为未完成。不是完整 A 股规则，不处理特殊品种、竞价、盘口或排队。
- 未设限价的买入按当前收盘价上浮一成预留预算；次日参考价超过预算或不满足限价时记为未完成并释放预留。
- 持有证券缺少当日数据时，估值沿用最后已知收盘价并标记 `stale`。
- 不处理分红、送股、拆合股和退市权益。

## AI 工具与请求恢复

工具清单以 `plugin-manifest.json` 为准。常用顺序：

`CreateSession(marketMode=directory) → GetSessionSecurities → GetSessionQuotes / GetChart → GetAnalysis → SavePlan / PreviewOrder / SubmitOrder → AdvanceDay → GetJournal / GetPerformance → SaveReview`

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VTrade「末」,
command:「始」CreateSession「末」,
requestId:「始」example-create-1「末」,
marketMode:「始」directory「末」,
agentName:「始」我的助手「末」
<<<[END_TOOL_REQUEST]>>>
```

- 账本写入请求都带唯一 `requestId`；除创建外还需要最新回执中的 `sessionId`、`observationId` 和 `expectedRevision`。不能自行猜测或递增观察版本。
- 相同请求重发返回已持久化的原回执；同一个 `requestId` 携带不同内容会被拒绝。网络中断或内部错误意味着结果未知，先查询再按原参数重试。
- `ok: true` 且 `status: pending` 表示已记录意图，不表示成交；`filled` 也只表示虚拟成交。
- `GetSessionSecurities`、`GetSessionQuotes`、`GetChart`、`GetAnalysis`、`CallTool`、`ListBoards`、`ScreenBoard`、`GetMinuteChart` 只读，不改变账本和模拟日期。`GetMarketSecurities`、`GetMarketQuotes`、`GetMarketBars` 是独立的最新看盘命令，不用于盲测决策。
- VCP 文本协议中的整数参数、`symbols` 与 `options`（JSON 字符串）会在薄适配层转换；核心接口使用真正的整数和对象。
- direct 入口返回 `{status: "success", result: {content: [...]}}`；业务失败返回顶层 `status: "error"`、`code` 和 `error`。HTTP 接口使用 `{ok, ...}`，两者经过同一命令服务和账本校验。
- 观察中的 `journal` 仅含最近一百条；完整历史用 `GetJournal` 分页。

暂停会阻止新意图和日期推进，保留查询、撤销与复盘。服务没有后台模型循环；关闭页面不会自行产生下一步决策。

## 存储边界

`core/data.cjs` 负责数据标准化，`market-repository.cjs` 管理不可变行情版本与来源头，`local-sources.cjs` 只读已配置的本机来源并保存设置页添加的来源，`market-directory.cjs` 为看盘只读通达信目录，`slots.cjs` 与 `builtins.cjs` 定义插槽和默认实现，`engine.cjs` 处理时钟和虚拟账本，`store.cjs` 负责串行写入与原子替换，`service.cjs` 提供命令契约。页面、HTTP 和 VCP 语法在外层。

一个存储目录只允许一个进程写入。`writer.lock` 在正常关闭时移除；异常终止后，若锁中记录的进程已不存在，下次启动自动接管，该进程仍在运行时报 `STORE_LOCKED`。存档、去重回执与状态变化保存在同一个文件中，写入失败不提交内存状态。版本不兼容或文件损坏时保留原文件，不当成新账户覆盖。

运行数据和工具回执可能含用户自己的行情、计划和备注。宿主的工具记录、模型上下文和日志仍可能保存它们；只把允许的字段交给模型，不要把运行目录作为问题附件公开。

## 测试

```sh
node --test --test-timeout=15000 tests/*.test.cjs
python -m unittest discover -s tests -p "test_*.py"
```

测试全部使用合成数据和临时目录，不需要行情、券商或模型账号，也不联网（腾讯分时适配器使用模拟响应）。覆盖账本流程、去重与并发、写入失败与坏档、行情版本与日更、通达信布局与名称文件、看盘目录与报价缓存、设置页来源、存储锁接管、六个插槽的契约与核心保证、README 示例、下载脚本的单位换算与原子替换、图表刻度与周期聚合、预览 HTTP（含管理面板代理下的来源校验）和插件直接调用。

## 界面与许可

页面是 ToolBox 插件自带的独立工作台，未修改 VCPChat、管理面板导航或 vgame。基础控件来自固定版本的 VCPUI，来源与许可见 `frontend/vendor/vcp-ui/NOTICE.md`；图标为 Lucide 子集，见 `frontend/vendor/lucide/README.md`。图表引擎为 VTrade 自有代码，页面不加载外部 CDN。

VTrade 自有部分随 VCPToolBox 的 CC BY-NC-SA 4.0 许可贡献，见仓库根目录 `LICENSE`。第三方代码保留各自许可；数据来源和 AKShare、baostock 的条款仍需遵守。
