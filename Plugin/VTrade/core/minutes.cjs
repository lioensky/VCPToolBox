'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite } = require('./store.cjs');
const { check, hash, integer, validDate } = require('./data.cjs');

const SYMBOL = /^[A-Za-z0-9._-]{1,32}$/;
const SOURCE = /^minute-[A-Za-z0-9_-]{1,60}$/;
const WINDOWS = [[570, 690], [780, 900]]; // 09:30–11:30 and 13:00–15:00, Shanghai local time.
const minuteOf = value => {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value || '');
    if (!match || !validDate(match[1])) return null;
    const minute = Number(match[2]) * 60 + Number(match[3]);
    const session = WINDOWS.findIndex(([start, end]) => minute >= start && minute < end);
    return session < 0 ? null : { date: match[1], minute, session };
};
function normalize(input) {
    check(input?.schemaVersion === 1 && SOURCE.test(input.sourceId)
        && typeof input.dailyRef === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(input.dailyRef)
        && Array.isArray(input.securities) && input.securities.length > 0 && input.securities.length <= 100,
    'INVALID_MINUTES', '一分钟数据须包含来源标识、日线关联及证券列表。');
    let total = 0;
    const securities = input.securities.map(item => {
        check(SYMBOL.test(item?.symbol) && Array.isArray(item.bars) && item.bars.length > 0,
            'INVALID_MINUTES', '一分钟数据的证券或 K 线列表无效。');
        let previous = '';
        const bars = item.bars.map(bar => {
            check(minuteOf(bar?.timestamp) && bar.timestamp > previous
                && integer(bar.openCents, 1, 100000000) && integer(bar.highCents, 1, 100000000)
                && integer(bar.lowCents, 1, 100000000) && integer(bar.closeCents, 1, 100000000)
                && bar.lowCents <= Math.min(bar.openCents, bar.closeCents)
                && bar.highCents >= Math.max(bar.openCents, bar.closeCents)
                && integer(bar.volume, 0, 1000000000000),
            'INVALID_MINUTES', '一分钟 K 线时间、价格或成交量无效。');
            previous = bar.timestamp; total++;
            return { timestamp: bar.timestamp, openCents: bar.openCents, highCents: bar.highCents,
                lowCents: bar.lowCents, closeCents: bar.closeCents, volume: bar.volume };
        });
        return { symbol: item.symbol, bars };
    });
    check(total <= 200000 && new Set(securities.map(item => item.symbol)).size === securities.length,
        'INVALID_MINUTES', '一分钟数据超过二十万根或证券重复。');
    return { schemaVersion: 1, sourceId: input.sourceId, dailyRef: input.dailyRef,
        name: String(input.name || '本机一分钟线').slice(0, 80), timezone: 'Asia/Shanghai', securities };
}
function fromCsv(input) {
    check(typeof input === 'string' && input.length <= 8 * 1024 * 1024, 'INVALID_MINUTES', 'CSV 内容过大。');
    const lines = input.trim().split(/\r?\n/);
    check(lines.shift()?.trim() === 'symbol,timestamp,openCents,highCents,lowCents,closeCents,volume',
        'INVALID_MINUTES', 'CSV 表头必须为 symbol,timestamp,openCents,highCents,lowCents,closeCents,volume。');
    const securities = new Map();
    for (const line of lines) {
        const fields = line.split(',');
        check(fields.length === 7, 'INVALID_MINUTES', 'CSV 每行须有七列。');
        const [symbol, timestamp, ...numbers] = fields;
        const keys = ['openCents', 'highCents', 'lowCents', 'closeCents', 'volume'];
        const bar = { timestamp };
        keys.forEach((key, i) => { bar[key] = /^\d+$/.test(numbers[i]) ? Number(numbers[i]) : NaN; });
        if (!securities.has(symbol)) securities.set(symbol, { symbol, bars: [] });
        securities.get(symbol).bars.push(bar);
    }
    return [...securities.values()];
}
function aggregate(bars, period) {
    check(Number.isSafeInteger(period) && period >= 1 && period <= 120,
        'INVALID_ARGUMENT', '分钟周期须为 1 至 120 的整数。');
    const result = [];
    for (const bar of bars) {
        const at = minuteOf(bar.timestamp);
        const [start] = WINDOWS[at.session];
        const key = `${at.date}:${at.session}:${Math.floor((at.minute - start) / period)}`;
        const last = result.at(-1);
        if (last?._key === key) {
            last.highCents = Math.max(last.highCents, bar.highCents);
            last.lowCents = Math.min(last.lowCents, bar.lowCents);
            last.closeCents = bar.closeCents;
            last.volume += bar.volume;
            last.count++;
            last.contiguous = last.contiguous && at.minute === last.lastMinute + 1;
            last.lastMinute = at.minute;
        } else result.push({ _key: key, timestamp: bar.timestamp, openCents: bar.openCents,
            highCents: bar.highCents, lowCents: bar.lowCents, closeCents: bar.closeCents,
            volume: bar.volume, count: 1, contiguous: true, lastMinute: at.minute });
    }
    return result.map(({ _key, contiguous, lastMinute, ...bar }) => ({ ...bar, complete: bar.count === period && contiguous }));
}
class Minutes {
    constructor(store) { this.store = store; this.root = path.join(store.directory, 'minutes'); this.index = new Map(); }
    async open() {
        await fs.mkdir(this.root, { recursive: true });
        for (const file of await fs.readdir(this.root)) {
            if (!file.endsWith('.json') || !SOURCE.test(file.slice(0, -5))) continue;
            const state = JSON.parse(await fs.readFile(path.join(this.root, file), 'utf8'));
            check(state.revision >= 1 && typeof state.version === 'string' && state.receipts
                && hash(normalize(state.data)) === state.version,
            'CORRUPT_DATA', '一分钟数据存档校验失败，原文件已保留。');
            this.index.set(state.data.sourceId, state);
        }
    }
    list() { return [...this.index.values()].map(s => ({ sourceId: s.data.sourceId, dailyRef: s.data.dailyRef,
        name: s.data.name, revision: s.revision, version: s.version,
        securities: s.data.securities.map(item => ({ symbol: item.symbol, bars: item.bars.length })) })); }
    async ingest(input) {
        const data = normalize(input.format === 'csv' ? { ...input, securities: fromCsv(input.csv) } : input);
        return this.store.serial(`minutes:${data.sourceId}`, async () => {
            const previous = this.index.get(data.sourceId);
            const requestId = input.requestId;
            check(typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(requestId),
                'INVALID_REQUEST', '一分钟导入需要唯一 requestId。');
            const version = hash(data);
            if (previous?.receipts[requestId]) {
                check(previous.receipts[requestId].version === version, 'REQUEST_CONFLICT', '同一导入请求不能更换内容。');
                return { ...previous.receipts[requestId].result, duplicate: true };
            }
            check(previous ? input.expectedVersion === previous.version : input.expectedVersion === undefined,
                'STALE_DATA_VERSION', '一分钟来源版本已变化。');
            if (previous) {
                check(previous.data.dailyRef === data.dailyRef, 'SOURCE_MISMATCH', '一分钟来源不能更换日线关联。');
                for (const item of previous.data.securities) {
                    const replacement = data.securities.find(value => value.symbol === item.symbol);
                    check(replacement && replacement.bars.length >= item.bars.length
                        && item.bars.every((bar, i) => JSON.stringify(bar) === JSON.stringify(replacement.bars[i])),
                    'SOURCE_MISMATCH', '历史一分钟线不可覆盖或删除。');
                }
            }
            const result = { sourceId: data.sourceId, dailyRef: data.dailyRef, version,
                revision: (previous?.revision || 0) + 1, added: data.securities.reduce((sum, item) => sum + item.bars.length, 0)
                    - (previous?.data.securities.reduce((sum, item) => sum + item.bars.length, 0) || 0) };
            const next = { data, version, revision: result.revision,
                receipts: { ...(previous?.receipts || {}), [requestId]: { version, result } } };
            await atomicWrite(path.join(this.root, `${data.sourceId}.json`), next);
            this.index.set(data.sourceId, next);
            return result;
        });
    }
    chart(sourceId, symbol, { asOf = null, period = 1, limit = 5000, dailyRef = null } = {}) {
        const state = this.index.get(sourceId);
        check(state && (!dailyRef || state.data.dailyRef === dailyRef), 'SOURCE_UNAVAILABLE', '一分钟来源不存在或日线关联不一致。');
        check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 20000, 'INVALID_ARGUMENT', '分钟线数量须为 1 至 20000。');
        const item = state.data.securities.find(value => value.symbol === symbol);
        check(item, 'UNKNOWN_SYMBOL', '一分钟来源没有该证券。');
        const bars = item.bars.filter(bar => !asOf || bar.timestamp.slice(0, 10) <= asOf);
        return { sourceId, version: state.version, symbol, period, asOf,
            bars: aggregate(bars, period).slice(-limit) };
    }
}
module.exports = { Minutes, normalize, fromCsv, aggregate };
