[English](README.en.md) | **中文**

# Digital Oracle 📈

Digital Oracle 是一款让 AI Agent 基于从海量金融数据中，挖掘出宏观事件发展趋势的开源 Skill。

适用于 OpenClaw / Claude Code / Cursor / Codex。

我们生活在一个噪音极度泛滥的时代。社交媒体上充斥着情绪化的预测 — 有人说房价要崩了，有人说黄金要上天，有人说明天就打仗。这些观点往往顺应人群情绪，而不是基于客观数据的理性分析。

但交易数据不一样。

价格是绝对理性的 — 当一个人要把自己的钱押在某个结果上时，他会比发一条短视频认真很多。

这就是有效市场理论的核心洞察：**所有公开信息都已经被价格消化了。一切信息都在 K 线里。**

Digital Oracle 把这个洞察变成了一个可执行的工具。它接入了 12 个权威金融数据源 — **从 Polymarket 和 Kalshi 这样的预测市场，到美国国债收益率曲线、CFTC 机构持仓、SEC 内部人交易、各国央行利率、加密衍生品。**

它不看报纸不读新闻，不消费文章、短视频、播客，只通过从金融数据中挖掘出的价值信号，来回答房价涨跌、黄金走势、比特币周期、军事冲突概率这类问题，并给出结构化的概率估计和推理链。

某种意义上，这就是新时代的数字先知。

## 能回答什么问题？

- "WW3 的概率是多少？"
- "中国房价还会跌多久？"
- "AI 是不是泡沫？"
- "现在适合买黄金吗？"
- "比特币到底了吗？"
- "NVDA 期权溢价是不是太高了？"

只要有市场在定价这件事，Digital Oracle 就能给出一个基于交易数据的概率估计。

## 数据源

| Provider | 数据类型 | 用途 |
|----------|---------|------|
| Polymarket | 预测市场合约 | 事件概率定价 |
| Kalshi | SEC 监管二元合约 | 美国政治/经济事件 |
| Stooq | 股票/ETF/外汇/商品 | 价格历史和趋势 |
| Deribit | 加密衍生品 | 期货 term structure、期权 IV |
| US Treasury | 国债收益率 | 利率曲线、通胀预期 |
| CFTC COT | 期货持仓 | 机构仓位方向（smart money） |
| CoinGecko | 加密现货 | BTC/ETH 价格、市值 |
| SEC EDGAR | 内部人交易 | Form 4 买卖信号 |
| BIS | 央行数据 | 政策利率、信贷/GDP 缺口 |
| World Bank | 发展指标 | GDP、人口、贸易 |
| Yahoo Finance | US 期权链 | IV、Greeks、put/call ratio |
| Web Search | 网页搜索 | VIX、CDS 等补充数据 |

所有 API 均免费、无需 API Key。

## 安装

### OpenClaw

```bash
clawhub install digital-oracle
```

### 其他 AI Agent（Claude Code / Cursor / Codex / ...）

直接告诉你的 Agent：

> 安装这个开源项目并读取 SKILL.md 作为你的工作指令：https://github.com/komako-workshop/digital-oracle

Agent 会自行 clone 代码、阅读方法论、调用 provider。

### 前置依赖

- [uv](https://docs.astral.sh/uv/) — Python 包管理器，skill 运行时用它执行 Python 脚本
- 12 个数据源中有 11 个零外部依赖（纯 Python 标准库）。期权链分析需要额外安装：

```bash
uv pip install yfinance
```

## 工作原理

1. **理解问题** — 拆解核心变量、时间窗口、可定价性
2. **选择信号** — 根据问题类型选择 3+ 个独立数据源
3. **并行拉取** — 用 `gather()` 同时调用多个 provider
4. **矛盾推理** — 找不同市场之间的分歧，解释为什么它们可以同时正确
5. **输出报告** — 结构化的多层信号表格 + 概率估计 + 场景分析

## 项目结构

```
digital-oracle/
├── SKILL.md                # Skill 定义（OpenClaw 读取这个文件）
├── digital_oracle/         # Python 源码
│   ├── concurrent.py       # 并行执行工具
│   ├── http.py             # HTTP 客户端抽象
│   ├── snapshots.py        # HTTP 响应录制/回放（测试用）
│   └── providers/          # 12 个数据 provider
├── references/             # API 速查
│   ├── providers.md        # Provider API 参考
│   └── symbols.md          # 交易符号目录
├── scripts/                # Demo 脚本
└── tests/                  # 单元测试 + fixtures
```

## 设计原则

- **零依赖优先** — 11/12 个 provider 只用 Python 标准库，无需 `pip install`
- **依赖注入** — 所有 provider 接受可选的 `http_client` 参数，方便测试
- **部分失败容忍** — 一个数据源挂了不影响其他结果
- **快照测试** — 录制真实 HTTP 响应，CI 里无网络也能跑测试

## License

MIT © 2026 komako-workshop — see [LICENSE](LICENSE).
