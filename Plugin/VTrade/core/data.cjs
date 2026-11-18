'use strict';

const { createHash } = require('node:crypto');

class TradeError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}
function check(condition, code, message) {
    if (!condition) throw new TradeError(code, message);
}
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    return Number.isSafeInteger(value) && value >= min && value <= max;
}
function hash(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && !Number.isNaN(Date.parse(value))
        && new Date(value).toISOString().slice(0, 10) === value;
}
function date(value) {
    check(validDate(value), 'INVALID_DATA', '日期须为有效的 YYYY-MM-DD。');
    return value;
}
function completedDate(now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    return Number(parts.hour) >= 18 ? day : new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10);
}
function text(value, fallback, max = 120) {
    check(value === undefined || typeof value === 'string', 'INVALID_ARGUMENT', '文本字段类型错误。');
    return String(value ?? fallback).trim().slice(0, max);
}
function normalizeDataset(input, { minimumBars = 2 } = {}) {
    check(input && input.schemaVersion === 1, 'INVALID_DATA', '不支持的数据格式版本。');
    const source = input.source;
    // kind is a label (demo, user, tdx, akshare or a market slot id); units below are the contract.
    check(source && typeof source.kind === 'string' && /^[a-z][a-z0-9-]{1,49}$/.test(source.kind)
        && source.adjustment === 'none' && source.currency === 'CNY'
        && source.timezone === 'Asia/Shanghai' && source.volumeUnit === 'shares',
    'INVALID_DATA', '需明确来源类型、人民币分、不复权、上海时区和成交量单位（股）。');
    check(Array.isArray(input.securities) && input.securities.length > 0 && input.securities.length <= 100,
        'INVALID_DATA', '每份数据需要 1 至 100 个证券。');
    const symbols = new Set();
    let count = 0;
    const securities = input.securities.map(item => {
        check(item && typeof item.symbol === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(item.symbol)
            && !['__proto__', 'constructor', 'prototype'].includes(item.symbol)
            && !symbols.has(item.symbol), 'INVALID_DATA', '证券标识无效或重复。');
        symbols.add(item.symbol);
        check(Array.isArray(item.bars) && item.bars.length >= minimumBars, 'INVALID_DATA', `每个证券至少需要 ${minimumBars} 根日线。`);
        count += item.bars.length;
        check(count <= 50000, 'INVALID_DATA', '单次导入最多五万根日线。');
        let previous = '';
        const bars = item.bars.map(raw => {
            check(raw && typeof raw === 'object', 'INVALID_DATA', '日线记录须为对象。');
            const day = date(raw.date);
            check(day > previous, 'INVALID_DATA', '日线须按日期严格递增，不能重复。');
            previous = day;
            const bar = { date: day };
            for (const key of ['openCents', 'highCents', 'lowCents', 'closeCents']) {
                check(integer(raw[key], 1, 100000000), 'INVALID_DATA', '价格须为正整数分。');
                bar[key] = raw[key];
            }
            check(bar.lowCents <= Math.min(bar.openCents, bar.closeCents)
                && bar.highCents >= Math.max(bar.openCents, bar.closeCents)
                && bar.lowCents <= bar.highCents && integer(raw.volume, 0, 1000000000000),
            'INVALID_DATA', '价格区间或成交量不合法。');
            bar.volume = raw.volume;
            check(raw.suspended === undefined || typeof raw.suspended === 'boolean',
                'INVALID_DATA', '停牌字段须为布尔值。');
            bar.suspended = raw.suspended === true;
            for (const key of ['limitUpCents', 'limitDownCents']) {
                if (raw[key] !== undefined) {
                    check(integer(raw[key], 1, 100000000), 'INVALID_DATA', '涨跌停价格须为正整数分。');
                    bar[key] = raw[key];
                }
            }
            if (bar.limitDownCents !== undefined && bar.limitUpCents !== undefined) {
                check(bar.limitDownCents <= bar.limitUpCents, 'INVALID_DATA', '涨跌停区间不合法。');
            }
            check((bar.limitUpCents === undefined || bar.highCents <= bar.limitUpCents)
                && (bar.limitDownCents === undefined || bar.lowCents >= bar.limitDownCents),
            'INVALID_DATA', '日线价格超出声明的涨跌停区间。');
            return bar;
        });
        return { symbol: item.symbol, name: text(item.name, item.symbol), bars };
    });
    return {
        schemaVersion: 1,
        source: {
            kind: source.kind, name: text(source.name, '用户数据'), adjustment: 'none',
            currency: 'CNY', timezone: 'Asia/Shanghai', volumeUnit: 'shares',
        },
        securities,
    };
}
function demoDataset() {
    const days = [];
    for (let d = new Date('2025-01-06T00:00:00Z'); days.length < 35; d.setUTCDate(d.getUTCDate() + 1)) {
        if (![0, 6].includes(d.getUTCDay())) days.push(d.toISOString().slice(0, 10));
    }
    return normalizeDataset({
        schemaVersion: 1,
        source: { kind: 'demo', name: '合成日线 · 非真实证券', adjustment: 'none', currency: 'CNY',
            timezone: 'Asia/Shanghai', volumeUnit: 'shares' },
        securities: ['DEMO-A', 'DEMO-B', 'DEMO-C'].map((symbol, index) => {
            let previous = 1600 + index * 800;
            const bars = days.map((day, n) => {
                const open = previous + [12, -18, 7, 20, -9][(n + index) % 5];
                const close = open + [15, -8, 21, -12][(n + index * 2) % 4];
                const bar = { date: day, openCents: open, closeCents: close,
                    highCents: Math.max(open, close) + 12, lowCents: Math.min(open, close) - 12,
                    volume: 100000 + n * 1200, limitUpCents: Math.floor(previous * 1.1),
                    limitDownCents: Math.ceil(previous * 0.9) };
                previous = close;
                return bar;
            });
            return { symbol, name: ['演示证券甲', '演示证券乙', '演示证券丙'][index], bars };
        }),
    });
}
function workbenchDemoDataset() {
    const days = [];
    for (let d = new Date('2024-06-03T00:00:00Z'); days.length < 320; d.setUTCDate(d.getUTCDate() + 1)) {
        if (![0, 6].includes(d.getUTCDay())) days.push(d.toISOString().slice(0, 10));
    }
    const names = ['云帆', '青禾', '远山', '星河', '澄明', '北辰', '海岚', '新原'];
    return normalizeDataset({
        schemaVersion: 1,
        source: { kind: 'demo', name: '合成长周期行情 · 非真实证券', adjustment: 'none',
            currency: 'CNY', timezone: 'Asia/Shanghai', volumeUnit: 'shares' },
        securities: names.map((name, index) => {
            let seed = 17031 + index * 919;
            const random = () => {
                seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                return seed / 4294967296;
            };
            let previous = 1800 + index * 740;
            const bars = days.map((day, n) => {
                const movement = .0006 + Math.sin(n / 19 + index) * .0035
                    + Math.sin(n / 57 + index * .7) * .002 + (random() - .5) * .036;
                const open = Math.round(previous * (1 + (random() - .5) * .009));
                const close = Math.round(previous * (1 + movement));
                const up = Math.floor(previous * 1.1), down = Math.ceil(previous * .9);
                const bar = { date: day, openCents: open, closeCents: close,
                    highCents: Math.min(up, Math.ceil(Math.max(open, close) * (1 + random() * .014))),
                    lowCents: Math.max(down, Math.floor(Math.min(open, close) * (1 - random() * .014))),
                    volume: Math.round((420000 + random() * 1500000 + Math.abs(close - open) * 2700)
                        * (1 + .25 * Math.sin(n / 13 + index))),
                    limitUpCents: up, limitDownCents: down };
                previous = close;
                return bar;
            });
            return { symbol: `DEMO-${String.fromCharCode(65 + index)}`, name: `演示${name}`, bars };
        }),
    });
}
function fromTdx(buffer, symbol, name, options) {
    check(Buffer.isBuffer(buffer) && buffer.length > 0 && buffer.length % 32 === 0
        && buffer.length <= 32 * 50000, 'INVALID_DATA', '仅支持完整的通达信 32 字节 .day 日线记录。');
    const bars = [];
    for (let i = 0; i < buffer.length; i += 32) {
        const value = String(buffer.readUInt32LE(i));
        bars.push({ date: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`,
            openCents: buffer.readUInt32LE(i + 4), highCents: buffer.readUInt32LE(i + 8),
            lowCents: buffer.readUInt32LE(i + 12), closeCents: buffer.readUInt32LE(i + 16),
            volume: buffer.readUInt32LE(i + 24) });
    }
    return normalizeDataset({ schemaVersion: 1, source: { kind: 'tdx', name: '用户导入通达信日线',
        adjustment: 'none', currency: 'CNY', timezone: 'Asia/Shanghai', volumeUnit: 'shares' },
    securities: [{ symbol, name, bars }] }, options);
}
function market(dataset) {
    const days = [...new Set(dataset.securities.flatMap(s => s.bars.map(b => b.date)))].sort();
    const bySymbol = new Map(dataset.securities.map(s => [s.symbol, s]));
    return { dataset, days, bySymbol, fingerprint: hash(dataset) };
}

module.exports = { TradeError, check, integer, hash, text, date, validDate, completedDate, normalizeDataset, demoDataset,
    workbenchDemoDataset, fromTdx, market };
