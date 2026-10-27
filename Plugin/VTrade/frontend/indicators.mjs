// Public, textbook indicators. Input prices are integer cents; price outputs retain that unit.
const period = (value, fallback, max = 250) => {
    const n = value ?? fallback;
    if (!Number.isSafeInteger(n) || n < 2 || n > max) throw new Error(`周期须为 2 至 ${max} 的整数。`);
    return n;
};
const closes = bars => bars.map(b => b.closeCents);
const average = (values, n) => {
    let sum = 0;
    return values.map((v, i) => {
        sum += v;
        if (i >= n) sum -= values[i - n];
        return i + 1 < n ? null : sum / n;
    });
};
const exponential = (values, n) => {
    const weight = 2 / (n + 1);
    let last = null;
    return values.map(value => (last = last === null ? value : weight * value + (1 - weight) * last));
};
const rows = (bars, fields) => bars.map((bar, i) => ({ date: bar.date, values: Object.fromEntries(
    Object.entries(fields).map(([key, values]) => [key, values[i] === null ? null : Number(values[i].toFixed(6))])) }));

export const INDICATORS = Object.freeze({
    ma: { name: 'MA', title: '均线', pane: 'price', parameters: { period: 5 }, hint: '收盘价的简单平均，用于观察趋势方向。' },
    ema: { name: 'EMA', title: '指数均线', pane: 'price', parameters: { period: 12 }, hint: '近期价格权重更大的均线，转向比 MA 快。' },
    boll: { name: 'BOLL', title: '布林带', pane: 'price', parameters: { period: 20, multiplier: 2 }, hint: '中轨为均线，上下轨为若干倍标准差，用于观察波动与偏离。' },
    macd: { name: 'MACD', title: '平滑异同移动平均', pane: 'oscillator', parameters: { fast: 12, slow: 26, signal: 9 }, hint: '快慢均线之差（DIF）及其均线（DEA），柱体为两者之差的两倍。' },
    kdj: { name: 'KDJ', title: '随机指标', pane: 'oscillator', parameters: { period: 9, smoothK: 3, smoothD: 3 }, hint: '收盘价在近期最高最低价区间中的位置。' },
    rsi: { name: 'RSI', title: '相对强弱', pane: 'oscillator', parameters: { period: 14 }, hint: '一段时间内上涨幅度所占比例，取值 0 至 100。' },
});

// Line colours are a chart-engine palette key (follows the light or dark theme) or a fixed #rrggbb that reads on both
// backgrounds; widths 1 to 4 px. Defaults, in line order, after common Chinese charting software: text colour, amber,
// violet, blue, then teal and orange for further lines.
export const LINE_COLORS = Object.freeze(['ma5', 'ma10', '#a970ff', '#2f8cff', '#00b8a9', '#ff7a45']);
const THEME_COLORS = ['ma5', 'ma10', 'ma20', 'ma60', 'accent', 'cost', 'text'];
const HEX = /^#[0-9a-f]{6}$/i;
const LINE_FIELDS = { boll: [['MID', '中轨'], ['UPPER', '上轨'], ['LOWER', '下轨']], macd: [['DIF', 'DIF'], ['DEA', 'DEA'], ['MACD', 'MACD 柱']],
    kdj: [['K', 'K'], ['D', 'D'], ['J', 'J']], rsi: [['RSI', 'RSI']] };
// The lines an indicator draws, in drawing order. MA and EMA draw one line per period.
export function indicatorLines(id, params) {
    if (id === 'ma' || id === 'ema') return params.periods.map(period => ({ key: `${id.toUpperCase()}${period}`, label: `${id.toUpperCase()}${period}`, period }));
    return LINE_FIELDS[id].map(([key, label]) => ({ key, label, bars: key === 'MACD' }));
}
export const isLineColor = value => THEME_COLORS.includes(value) || HEX.test(String(value));

export const DEFAULT_CHART_INDICATORS = Object.freeze({
    main: ['ma'], sub: [],
    params: { ma: { periods: [5, 10, 20, 60] }, ema: { periods: [12] },
        boll: { period: 20, multiplier: 2 }, macd: { fast: 12, slow: 26, signal: 9 },
        kdj: { period: 9, smoothK: 3, smoothD: 3 }, rsi: { period: 14 } },
});

// Layouts saved before parameter editing contain only main/sub. Keep their familiar MA lines.
export function chartIndicatorSettings(input = {}) {
    const defaults = DEFAULT_CHART_INDICATORS;
    const selected = pane => [...new Set((Array.isArray(input[pane]) ? input[pane] : defaults[pane])
        .filter(id => INDICATORS[id]?.pane === (pane === 'main' ? 'price' : 'oscillator')))];
    const params = {};
    const number = (value, label, min = 2, max = 250, integer = true) => {
        const n = Number(value);
        if (!Number.isFinite(n) || n < min || n > max || integer && !Number.isSafeInteger(n))
            throw new Error(`${label}须为 ${min} 至 ${max} 的${integer ? '整数' : '数字'}。`);
        return n;
    };
    const periods = (value, fallback, label) => {
        const list = value === undefined ? fallback : value;
        if (!Array.isArray(list) || list.length < 1 || list.length > 6)
            throw new Error(`${label}须填写 1 至 6 个周期。`);
        const clean = list.map(item => number(item, `${label}周期`));
        if (new Set(clean).size !== clean.length) throw new Error(`${label}周期不能重复。`);
        return clean;
    };
    const source = input.params || {};
    params.ma = { periods: periods(source.ma?.periods, defaults.params.ma.periods, 'MA') };
    params.ema = { periods: periods(source.ema?.periods, defaults.params.ema.periods, 'EMA') };
    params.boll = { period: number(source.boll?.period ?? 20, 'BOLL 周期'),
        multiplier: number(source.boll?.multiplier ?? 2, 'BOLL 倍数', 0.1, 5, false) };
    params.macd = { fast: number(source.macd?.fast ?? 12, 'MACD 快线周期'),
        slow: number(source.macd?.slow ?? 26, 'MACD 慢线周期'),
        signal: number(source.macd?.signal ?? 9, 'MACD 信号周期') };
    if (params.macd.fast >= params.macd.slow) throw new Error('MACD 快线周期须小于慢线周期。');
    params.kdj = { period: number(source.kdj?.period ?? 9, 'KDJ 周期'),
        smoothK: number(source.kdj?.smoothK ?? 3, 'KDJ K 平滑周期'),
        smoothD: number(source.kdj?.smoothD ?? 3, 'KDJ D 平滑周期') };
    params.rsi = { period: number(source.rsi?.period ?? 14, 'RSI 周期') };
    // One style per line, in the order indicatorLines gives; a missing or invalid style falls back to the default.
    const styles = {};
    for (const id of Object.keys(INDICATORS)) {
        const given = Array.isArray(input.styles?.[id]) ? input.styles[id] : [];
        styles[id] = indicatorLines(id, params[id]).map((_, k) => ({
            color: isLineColor(given[k]?.color) ? given[k].color : LINE_COLORS[k % LINE_COLORS.length],
            width: [1, 2, 3, 4].includes(Number(given[k]?.width)) ? Number(given[k].width) : 1 }));
    }
    const main = selected('main'), sub = selected('sub');
    const hidden = [...new Set(Array.isArray(input.hidden) ? input.hidden : [])].filter(id => main.includes(id) || sub.includes(id));
    // Folded sub-charts (and the volume pane, 'volume') keep only their legend strip.
    const collapsed = [...new Set(Array.isArray(input.collapsed) ? input.collapsed : [])].filter(id => id === 'volume' || sub.includes(id));
    return { main, sub, params, styles, hidden, collapsed };
}

export function calculateIndicator(id, bars, options = {}) {
    if (!INDICATORS[id] || !Array.isArray(bars)) throw new Error('未知指标或日线数据无效。');
    const close = closes(bars);
    if (id === 'ma' || id === 'ema') {
        const n = period(options.period, INDICATORS[id].parameters.period);
        return rows(bars, { [id.toUpperCase()]: id === 'ma' ? average(close, n) : exponential(close, n) });
    }
    if (id === 'boll') {
        const n = period(options.period, 20);
        const multiplier = options.multiplier ?? 2;
        if (!Number.isFinite(multiplier) || multiplier < 0.1 || multiplier > 5) throw new Error('BOLL 倍数须在 0.1 至 5 之间。');
        const mid = average(close, n), upper = [], lower = [];
        for (let i = 0; i < bars.length; i++) {
            if (mid[i] === null) { upper.push(null); lower.push(null); continue; }
            const window = close.slice(i - n + 1, i + 1);
            const std = Math.sqrt(window.reduce((sum, value) => sum + (value - mid[i]) ** 2, 0) / n);
            upper.push(mid[i] + multiplier * std); lower.push(mid[i] - multiplier * std);
        }
        return rows(bars, { MID: mid, UPPER: upper, LOWER: lower });
    }
    if (id === 'macd') {
        const fast = period(options.fast, 12), slow = period(options.slow, 26), signal = period(options.signal, 9);
        if (fast >= slow) throw new Error('MACD 快线周期须小于慢线周期。');
        const f = exponential(close, fast), s = exponential(close, slow);
        const dif = f.map((value, i) => value - s[i]), dea = exponential(dif, signal);
        return rows(bars, { DIF: dif, DEA: dea, MACD: dif.map((value, i) => 2 * (value - dea[i])) });
    }
    if (id === 'kdj') {
        const n = period(options.period, 9), smoothK = period(options.smoothK, 3), smoothD = period(options.smoothD, 3);
        let k = 50, d = 50;
        const ks = [], ds = [], js = [];
        for (let i = 0; i < bars.length; i++) {
            if (i + 1 < n) { ks.push(null); ds.push(null); js.push(null); continue; }
            const window = bars.slice(i - n + 1, i + 1);
            const high = Math.max(...window.map(b => b.highCents)), low = Math.min(...window.map(b => b.lowCents));
            const rsv = high === low ? 50 : 100 * (close[i] - low) / (high - low);
            k = ((smoothK - 1) * k + rsv) / smoothK;
            d = ((smoothD - 1) * d + k) / smoothD;
            ks.push(k); ds.push(d); js.push(3 * k - 2 * d);
        }
        return rows(bars, { K: ks, D: ds, J: js });
    }
    const n = period(options.period, 14);
    let gain = 0, loss = 0;
    const rsi = bars.map((_, i) => {
        if (i === 0) return null;
        const delta = close[i] - close[i - 1];
        const up = Math.max(0, delta), down = Math.max(0, -delta);
        if (i <= n) { gain += up; loss += down; }
        else { gain = (gain * (n - 1) + up) / n; loss = (loss * (n - 1) + down) / n; }
        if (i < n) return null;
        return loss === 0 ? 100 : gain === 0 ? 0 : 100 - 100 / (1 + gain / loss);
    });
    return rows(bars, { RSI: rsi });
}
