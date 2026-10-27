# VTrade：给 Agent 的模拟实验说明

你只能操作本机的虚拟账本。没有券商接口，没有真实资金，也没有保证成交的能力。行情由用户自行下载或导入；不要调用其他工具扫描用户的行情、公式、账户或策略目录。

## 开始之前

先确认用户选择的数据源、模拟日期范围和允许的操作预算。用户只要求演示时使用 `demo` 合成数据，不把演示标识当作真实证券。没有明确的运行范围时，先读取来源和已有运行，不自行开启无限循环。

使用正式 VCP 工具块，`tool_name=VTrade`。不使用原生 function calling，不对写入工具使用隐藏回执或免回复模式。

1. 用 `GetSources` 查看本机已经提供的数据源，用 `ListSessions` 查找运行。
2. 创建时传唯一 `requestId`；或对用户选定的 `sessionId` 调用 `GetObservation`。
3. 当前观察包含日期、公开 MA5、计划、虚拟账户和最新版本。只用观察中已有的信息作决定，不能假装已经取得未来行情。

需要更长的已观察历史时使用 `GetChart`，明确传池内个股和所需 `limit`；默认 500 根，上限 5000 根。日周切换只影响界面显示，不改变决策日或结算频率。页面画的参考线不会设置止损条件。

## 指标、信号和扩展工具

- `ListExtensions` 列出本机可用的行情源、指标与信号、股票池、撮合规则、券商接口和扩展工具。只使用列表里有的标识。
- `GetAnalysis` 计算指标序列或信号，只用模拟日及以前的日线。信号是计算结果，不是指令，也不是投资建议；是否计划或操作由你根据观察决定，并在计划理由里说明依据。
- `CallTool` 调用扩展工具，参数按列表中的 `parameters` 传。工具只读，不能替你下单。`network: true` 的工具会访问外部服务，例如 `tencent-intraday` 是非公开接口，仅供个人学习，结果只供观察。
- `financials` 只返回模拟日以前已公告的财务期次；`withheld` 表示有期次因尚未公告或缺少公告日而不提供。
- `GetUniverse` 查看股票池分组；创建运行时可用 `universe` 与 `group` 代替 `symbols`。
- `ListBoards` 读取共享自选和自建板块；`ChangeBoard` 使用返回的 `revision` 作为 `expectedRevision` 增删或排序。`ScreenBoard` 在模拟日筛选当前运行股票池，价格指标阈值以整数分计。
- 内置指标有 MA、EMA、BOLL、MACD、KDJ、RSI。`GetMinuteChart` 只返回已导入、与运行日线关联的分钟 OHLCV，并截止在模拟日；分钟线不用于日线撮合。
- `GetMarketSecurities`、`GetMarketQuotes`、`GetMarketBars` 是独立最新看盘接口。训练或盲测时不要调用，以免看到模拟日之后的行情。
- 返回 `PROVIDER_UNAVAILABLE`、`PROVIDER_FAILED`、`PROVIDER_TIMEOUT` 时说明该扩展当前不可用，不要换成别的实现假装得到同样结果。`FUTURE_DATA` 表示结果涉及模拟日之后，已被拒绝。

## 准备与模拟操作

- 用 `SavePlan` 记录候选、方向、数量和简短理由。先准备也可以，不必一定买卖。
- 用 `PreviewOrder` 校验意图。当前原型数量单位为 100，价格参数是整数分。
- 用 `SubmitOrder` 记录虚拟意图，必要时附上已保存的 `planId`。回执里的 `pending` 只表示待结算。
- 用户允许推进日期时，再用 `AdvanceDay`。下一数据交易日可能出现 `filled`（虚拟成交）或 `unfilled`（未完成）。读出失败理由，不得将未完成描述为成交。
- `CancelOrder` 只撤销待结算意图。`PauseSession` 阻止新意图与日期推进，查询和复盘仍可使用。
- 买入 `SubmitOrder` 可带 `stopLossCents` 和 `takeProfitCents`，成交后生成相应的 OCO 条件单。也可用 `PlaceConditional` 设置止损、止盈、移动止损、突破买入或回落买入；`UpdateConditional` 修改，`CancelConditional` 撤销。跳空按开盘价参考，同日双触发先止损。这些仍是日线模拟。

## 同起点训练操作预设

这是对决出现以前的旧流程，保留给已有的训练记录。人与 Agent 比较请用上面的对决。

用户明确选择训练时，用 `CreateTrainingPair` 建立人工和 Agent 两份独立运行。`randomSeed` 可复现随机开局，`startDate` 可指定起点，`blind: true` 匿名展示证券和日期。将回执中的 `agent.sessionId` 作为本次工具调用对象。每一步先 `GetObservation`，说明依据，再 `SavePlan`、`PreviewOrder`、`SubmitOrder` 或 `PlaceConditional`，之后按用户允许的节奏 `AdvanceDay`。不要启动无限循环；到达数据末尾、预算耗尽或用户要求停止时结束。用 `GetTrainingResult` 与人工结果对照；只有用户结束盲测后才调用 `RevealTraining`。这个预设是 Chat 中的操作流程，不代表插件后台会自主决策。

## 对决

对决是几个人或 Agent 在同一段历史行情上一天一天地决定仓位。局由玩家在 VTrade 页面上开；轮到你时，编排器会邀请你，并给你局号、座位和一张决策票据（`ticket`）。

1. 用 `GetDuelTurn` 带上票据读本回合：你的账户、同场成绩、最近 20 个交易日、更早的五日汇总和规则。不懂规则时用 `GetDuelGuide`。
2. 用 `SubmitDuelDecision` 交目标仓位 `target`（0、25、50、75、100），可选止损 `stopPct`（0、5、8、10），再写一句 `reason`。票据原样复制。
3. 你的决定在全部座位交齐前是密封的。回执如果写“已密封”，就停下等编排器的下一次邀请；如果写“已结算”，回执里有下一回合的局面和新票据，按编排器给你的节奏继续。
4. 局结束后用 `GetDuelResult` 看成绩。盲测题目由玩家揭晓，你不要猜测或追问真实名称。

票据只对这一局、这个座位、这一回合有效。`STALE_TICKET` 表示回合已推进，`INVALID_TICKET` 表示票据不对，都不要换别的票据重试。对决期间只用局面里给出的行情，不调用 `GetMarket*` 等看盘命令或其他行情工具；评级和交易次数无关，好的决定才加分。

## 写操作的共同要求

除创建外，每个写操作都要带最新回执中的 `sessionId`、`observationId`、`expectedRevision`，以及本次唯一的 `requestId`。成功后使用新观察；版本为零时也不能省略。不要自行拼接观察标识。

所有参数（包括较长的 `note`）都写成 `参数名:「始」内容「末」`。少了「始」「末」的参数不会送达；回执出现 `hint` 或错误提示缺少某个参数时，先检查格式。

## 失败、重试与停止

- `STALE_OBSERVATION`：重新查询并重新决策。不要把旧动作直接套入新版本。
- `REQUEST_CONFLICT`：同一请求标识已经对应另一组参数；先核对历史，不通过改名掩盖重复提交。
- 连接中断或内部错误：结果未知。先查询账户和记录；需要重试时原样重发同一请求，不换新 ID 再买一次。
- 数据源失效或变化：停止该运行，不改用合成数据继续算成绩。
- `FINISHED`、用户要求停止、预算耗尽或连续失败：停止新的操作，保存复盘并汇报。

## 复盘与汇报

使用 `GetJournal`、`GetPerformance` 核对准备、意图、虚拟成交和持有记录，再用 `SaveReview` 保存简短复盘。`stale` 表示估值沿用了旧日价格，需要明确说明。

观察仅附最近一百条事件。需要完整历史时读取 `GetJournal` 的 `journal.events`；`hasMore` 为真时，以 `nextAfterEventId` 作为下一页的 `afterEventId`。不要将最近一百条当作完整操作历史。

汇报实际观察到的日期、虚拟操作及其回执、未完成的原因和数据局限。不得承诺收益、把简化规则说成真实可成交条件，或把模拟结果直接作为个股投资建议。

本版本服务于同一管理员控制的受信任 Agent。`maid` 和展示名不提供账户授权，也不保证多个 Agent 之间相互保密。
