'use strict';

const { check, integer, validDate, fromTdx } = require('./data.cjs');
const { SlotRegistry } = require('./slots.cjs');

const ceil = (a, b) => Math.ceil(a / b);
// Public demo costs, not any broker's fee schedule.
const COSTS = Object.freeze({ feeBps: 3, minFeeCents: 100, slippageBps: 5 });
const fee = notional => Math.max(COSTS.minFeeCents, ceil(notional * COSTS.feeBps, 10000));
// Buy budget: limit price, or last close plus 10%, plus the demo fee. A cap on reserved cash, not a forecast.
function reserveCents({ quantity, limitPriceCents, closeCents }) {
    const notional = (limitPriceCents ?? ceil(closeCents * 11000, 10000)) * quantity;
    return notional + fee(notional);
}
function nextOpen({ side, quantity, bar }) {
    const price = side === 'buy' ? ceil(bar.openCents * (10000 + COSTS.slippageBps), 10000)
        : Math.floor(bar.openCents * (10000 - COSTS.slippageBps) / 10000);
    if (!integer(price, 1, 100000000)) return { rejected: '滑点后的参考价格超出整数分范围。' };
    return { priceCents: price, feeCents: fee(price * quantity) };
}
function conditionalFill({ quantity, triggerPriceCents }) {
    return { priceCents: triggerPriceCents, feeCents: fee(triggerPriceCents * quantity) };
}
function parseJson(bytes) {
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { check(false, 'INVALID_DATA', '文件不是有效的 JSON。'); }
}
const whole = (value, fallback, min, max, name) => {
    const v = value ?? fallback;
    check(Number.isSafeInteger(v) && v >= min && v <= max, 'INVALID_ARGUMENT', `${name} 须为 ${min} 至 ${max} 的整数。`);
    return v;
};
function sma(bars, period) {
    let sum = 0;
    return bars.map((b, i) => {
        sum += b.closeCents;
        if (i >= period) sum -= bars[i - period].closeCents;
        return i + 1 >= period ? Math.round(sum / period) : null;
    });
}
async function classic(id, bars, options) {
    try {
        const { calculateIndicator } = await import('../frontend/indicators.mjs');
        return { series: calculateIndicator(id, bars, options) };
    } catch (error) { check(false, 'INVALID_ARGUMENT', error.message); }
}
function financials(input) {
    const KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
    check(input?.schemaVersion === 1 && input.kind === 'financials' && Array.isArray(input.securities)
        && input.securities.length <= 5000, 'INVALID_DATA', '财务文件须为 schemaVersion 1、kind financials 的标准格式。');
    const fields = input.fields && typeof input.fields === 'object' ? Object.fromEntries(Object.entries(input.fields)
        .filter(([k, v]) => KEY.test(k) && typeof v === 'string').slice(0, 64).map(([k, v]) => [k, v.slice(0, 120)])) : {};
    return { source: { name: String(input.source?.name || '用户财务文件').slice(0, 80) }, fields,
        securities: new Map(input.securities.map(item => {
            check(typeof item?.symbol === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(item.symbol)
                && Array.isArray(item.reports) && item.reports.length <= 400, 'INVALID_DATA', '财务证券标识或报告列表无效。');
            const reports = item.reports.map(r => {
                check(validDate(r?.period) && (r.publishedAt === null || validDate(r.publishedAt))
                    && r.metrics && typeof r.metrics === 'object' && Object.keys(r.metrics).length <= 64
                    && Object.entries(r.metrics).every(([k, v]) => KEY.test(k) && (v === null || Number.isFinite(v))),
                'INVALID_DATA', '每期财务须有 period、publishedAt（日期或 null）和数值 metrics。');
                return { period: r.period, publishedAt: r.publishedAt, metrics: { ...r.metrics } };
            }).sort((a, b) => a.period < b.period ? -1 : a.period > b.period ? 1 : 0);
            return [item.symbol, reports];
        })) };
}

const BUILTINS = {
    market: {
        tdx: {
            description: '只读管理员逐项列出的通达信 sh/sz/bj lday .day 日线文件，可设最早日期；不扫描目录，不联网。',
            validate(config) {
                check(Array.isArray(config.securities) && config.securities.length > 0 && config.securities.length <= 100,
                    'INVALID_SOURCE', '通达信来源需要明确证券列表。');
                check(config.since === undefined || validDate(config.since), 'INVALID_SOURCE', '最早日期须为 YYYY-MM-DD。');
                const symbols = new Set();
                for (const item of config.securities) {
                    const match = typeof item.file === 'string' && /^(sh|sz|bj)\/lday\/(sh|sz|bj)[0-9]{6}\.day$/.exec(item.file);
                    check(match && match[1] === match[2] && typeof item.symbol === 'string' && !symbols.has(item.symbol),
                        'INVALID_SOURCE', '只允许显式列出的 sh/sz/bj 日线文件，不能读取策略或账户目录。');
                    symbols.add(item.symbol);
                }
            },
            async load({ name, config, readFile }) {
                check(readFile, 'INVALID_SOURCE', '通达信来源需要绝对数据目录。');
                const securities = []; let count = 0;
                for (const item of config.securities) {
                    const parsed = fromTdx(await readFile(item.file, 32 * 50000), item.symbol, item.name, { minimumBars: 1 }).securities[0];
                    // since trims older history so more securities fit under the per-source limit.
                    if (config.since) parsed.bars = parsed.bars.filter(b => b.date >= config.since);
                    check(parsed.bars.length > 0, 'DATA_UNAVAILABLE', `${item.symbol} 在最早日期之后没有日线。`);
                    count += parsed.bars.length;
                    check(count <= 50000, 'INVALID_DATA', '配置证券的日线合计超过五万根，请减少证券或设置较晚的最早日期。');
                    securities.push(parsed);
                }
                return { schemaVersion: 1, source: { kind: 'tdx', name, adjustment: 'none',
                    currency: 'CNY', timezone: 'Asia/Shanghai', volumeUnit: 'shares' }, securities };
            },
        },
        json: {
            description: '只读管理员指定目录下的一个标准 JSON 日线文件（可由 scripts/ 的下载脚本生成）；不联网。',
            validate(config) {
                check(typeof config.file === 'string' && /^[A-Za-z0-9._-]+\.json$/.test(config.file),
                    'INVALID_SOURCE', 'JSON 来源只接受指定数据目录下的单个文件名。');
            },
            async load({ config, readFile }) {
                check(readFile, 'INVALID_SOURCE', 'JSON 来源需要绝对数据目录。');
                return parseJson(await readFile(config.file, 8 * 1024 * 1024));
            },
        },
    },
    analysis: {
        ma: {
            type: 'indicator', description: '收盘价简单移动平均，单位整数分。公开经典指标，不是选股建议。',
            parameters: { period: '均线天数，2 至 250，默认 5' },
            compute({ bars, options }) {
                const values = sma(bars, whole(options.period, 5, 2, 250, 'period'));
                return { series: bars.map((b, i) => ({ date: b.date, values: { ma: values[i] } })) };
            },
        },
        'ma-cross': {
            type: 'signal', description: '短均线上穿长均线记 buy，下穿记 sell。教科书示例，不是选股建议。',
            parameters: { fast: '短均线天数，默认 5', slow: '长均线天数，默认 20，须大于 fast' },
            compute({ bars, options }) {
                const fast = whole(options.fast, 5, 2, 120, 'fast'), slow = whole(options.slow, 20, fast + 1, 250, 'slow');
                const f = sma(bars, fast), s = sma(bars, slow), signals = [];
                for (let i = 1; i < bars.length; i++) {
                    if (s[i - 1] === null) continue;
                    if (f[i - 1] <= s[i - 1] && f[i] > s[i]) signals.push({ date: bars[i].date, action: 'buy', note: `MA${fast} 上穿 MA${slow}` });
                    if (f[i - 1] >= s[i - 1] && f[i] < s[i]) signals.push({ date: bars[i].date, action: 'sell', note: `MA${fast} 下穿 MA${slow}` });
                }
                return { signals };
            },
        },
        ema: { type: 'indicator', description: '经典指数移动平均线，价格单位整数分。',
            parameters: { period: '周期，默认 12' }, compute: ({ bars, options }) => classic('ema', bars, options) },
        boll: { type: 'indicator', description: '经典布林带中轨、上轨和下轨，价格单位整数分。',
            parameters: { period: '周期，默认 20', multiplier: '标准差倍数，默认 2' },
            compute: ({ bars, options }) => classic('boll', bars, options) },
        macd: { type: 'indicator', description: '经典 MACD 的 DIF、DEA 与两倍柱值。',
            parameters: { fast: '快线周期，默认 12', slow: '慢线周期，默认 26', signal: '信号周期，默认 9' },
            compute: ({ bars, options }) => classic('macd', bars, options) },
        kdj: { type: 'indicator', description: '经典随机指标 K、D、J；初始 K、D 为 50。',
            parameters: { period: '回看周期，默认 9', smoothK: 'K 平滑周期，默认 3', smoothD: 'D 平滑周期，默认 3' },
            compute: ({ bars, options }) => classic('kdj', bars, options) },
        rsi: { type: 'indicator', description: '经典 Wilder RSI，默认 14 周期。',
            parameters: { period: '周期，默认 14' }, compute: ({ bars, options }) => classic('rsi', bars, options) },
    },
    universe: {
        all: {
            description: '所选数据源的全部证券，作为一个分组。',
            groups: ({ securities }) => ({ groups: [{ id: 'all', name: '全部证券', symbols: securities.map(s => s.symbol) }] }),
        },
    },
    execution: {
        reference: {
            description: '下一数据日开盘价加万分之五滑点，手续费万分之三、最低一元；不校验来源未提供的涨跌停。演示设置，不代表真实费用。',
            costs: COSTS, reserveCents, settle: nextOpen, settleConditional: conditionalFill,
        },
        'a-share-demo': {
            description: '同 reference，另要求下一日涨跌停字段；缺失、开盘在不利边界或滑点越界时记为未完成。不是完整 A 股规则。',
            costs: COSTS, reserveCents,
            settle(order) {
                const { side, bar } = order;
                if (bar.limitUpCents === undefined || bar.limitDownCents === undefined) return { rejected: '缺少涨跌停字段。' };
                if ((side === 'buy' && bar.openCents >= bar.limitUpCents)
                    || (side === 'sell' && bar.openCents <= bar.limitDownCents)) return { rejected: '开盘已在不利涨跌停边界。' };
                const fill = nextOpen(order);
                if (fill.priceCents !== undefined && (fill.priceCents > bar.limitUpCents || fill.priceCents < bar.limitDownCents)) {
                    return { rejected: '参考价及滑点超出声明的涨跌停区间。' };
                }
                return fill;
            },
            settleConditional(order) {
                const { side, bar, triggerPriceCents } = order;
                if (bar.limitUpCents === undefined || bar.limitDownCents === undefined) return { rejected: '缺少涨跌停字段。' };
                if ((side === 'buy' && triggerPriceCents >= bar.limitUpCents)
                    || (side === 'sell' && triggerPriceCents <= bar.limitDownCents)) return { rejected: '参考价位于不利涨跌停边界。' };
                return conditionalFill(order);
            },
        },
    },
    broker: {
        none: { description: '默认空实现：不连接任何券商。本版 VTrade 不调用券商插槽。', capabilities: { live: false } },
    },
    tool: {
        financials: {
            description: '读取管理员在本机配置的财务文件，只返回公告日不晚于模拟日的报告期；缺少公告日的期次不提供。不联网。',
            parameters: { symbol: '池内证券标识', limit: '最近几期，1 至 20，默认 4' },
            async run({ asOf, session, options, readFile }, args) {
                check(readFile && typeof options.file === 'string' && /^[A-Za-z0-9._-]+\.json$/.test(options.file),
                    'NOT_CONFIGURED', '管理员尚未在本机来源配置的 tools.financials 中指定财务文件。');
                check(session.symbols.includes(args.symbol), 'UNKNOWN_SYMBOL', '证券不在本次运行的股票池中。');
                const limit = whole(args.limit, 4, 1, 20, 'limit');
                const data = financials(parseJson(await readFile(options.file, 16 * 1024 * 1024)));
                const reports = data.securities.get(args.symbol) || [];
                const visible = reports.filter(r => r.publishedAt !== null && r.publishedAt <= asOf);
                return { symbol: args.symbol, asOf, source: data.source, fields: data.fields,
                    reports: visible.slice(-limit), withheld: reports.length - visible.length,
                    notice: '只含模拟日以前已公告的期次；数值按下载来源原样保存，单位见 fields。' };
            },
        },
    },
};

function createRegistry() {
    const registry = new SlotRegistry();
    for (const [slot, entries] of Object.entries(BUILTINS)) {
        for (const [id, implementation] of Object.entries(entries)) registry.register(slot, id, implementation, { builtin: true });
    }
    return registry;
}
module.exports = { BUILTINS, COSTS, createRegistry, reserveCents, financials };
