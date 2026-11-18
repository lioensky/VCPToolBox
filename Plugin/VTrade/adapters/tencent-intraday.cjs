'use strict';

// Optional, off by default. Tencent's web minute endpoint is not a documented public API: personal study only,
// it may change or stop at any time. Points are for viewing; they never reach settlement or the ledger.
const ENDPOINT = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query';
const SOURCE = '腾讯网页分时（非公开接口，仅供个人学习，可能随时失效）';

function tencentCode(symbol) {
    const m = /^(?:(SH|SZ|BJ)\.?(\d{6})|(\d{6})\.(SH|SZ|BJ))$/i.exec(symbol);
    return m ? `${(m[1] || m[4]).toLowerCase()}${m[2] || m[3]}` : null;
}
// Exact decimal text to integer hundredths; floats never touch the amounts.
function hundredths(value) {
    const m = /^(\d{1,12})(?:\.(\d{1,2})\d*)?$/.exec(value);
    if (!m || value.split('.')[1]?.slice(2).replace(/0/g, '')) return null;
    return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
}
function parse(payload, code) {
    const day = payload?.code === 0 ? payload.data?.[code]?.data : null;
    if (!day || !/^\d{8}$/.test(String(day.date)) || !Array.isArray(day.data) || day.data.length > 400) return null;
    const date = `${day.date.slice(0, 4)}-${day.date.slice(4, 6)}-${day.date.slice(6, 8)}`;
    const points = [];
    for (const line of day.data) {
        const [time, price, lots, amount] = String(line).split(' ');
        const priceCents = hundredths(price ?? ''), amountCents = hundredths(amount ?? '');
        if (!/^\d{4}$/.test(time) || !priceCents || amountCents === null || !/^\d{1,12}$/.test(lots ?? '')) return null;
        // Cumulative volume is reported in lots of 100 shares.
        points.push({ time: `${time.slice(0, 2)}:${time.slice(2)}`, priceCents,
            cumulativeVolume: Number(lots) * 100, cumulativeAmountCents: amountCents });
    }
    return { date, points };
}
function register({ register: add, TradeError }, { fetch = globalThis.fetch, timeoutMs = 8000 } = {}) {
    const fail = (code, message) => { throw new TradeError(code, message); };
    return add('tool', 'tencent-intraday', {
        description: `${SOURCE}。只读；只返回日期不晚于模拟日的分时，不参与虚拟结算。`,
        network: true,
        parameters: { symbol: '池内证券，形如 SH.xxxxxx 或 xxxxxx.SZ（六位数字）' },
        async run({ asOf, session, signal }, args) {
            if (!session.symbols.includes(args.symbol)) fail('UNKNOWN_SYMBOL', '证券不在本次运行的股票池中。');
            const code = tencentCode(args.symbol) || fail('UNSUPPORTED_SYMBOL', '无法从证券标识识别沪深北六位代码。');
            let payload;
            try {
                const response = await fetch(`${ENDPOINT}?code=${code}`, {
                    headers: { Accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
                if (!response.ok) fail('PROVIDER_UNAVAILABLE', `腾讯分时返回 HTTP ${response.status}。`);
                const text = await response.text();
                if (text.length > 1024 * 1024) fail('PROVIDER_UNAVAILABLE', '腾讯分时响应过大。');
                payload = JSON.parse(text);
            } catch (error) {
                if (error instanceof TradeError) throw error;
                fail('PROVIDER_UNAVAILABLE', '腾讯分时暂不可用，请稍后再试。');
            }
            const result = parse(payload, code) || fail('PROVIDER_UNAVAILABLE', '腾讯分时格式与预期不符，适配器可能需要更新。');
            if (result.date > asOf) fail('FUTURE_DATA', '分时日期晚于模拟日；为避免提前看到行情，不返回。');
            return { symbol: args.symbol, date: result.date, points: result.points, source: SOURCE,
                notice: '仅供观察，不参与虚拟结算；价格单位整数分，成交量为当日累计股数。' };
        },
    });
}
module.exports = { register, tencentCode, parse };
