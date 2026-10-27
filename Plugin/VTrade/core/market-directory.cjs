'use strict';

// Read-only view of a local TongDaXin directory for browsing the market: every listed security with the name and
// pinyin abbreviation from TDX's own name files, the latest quote from the end of each .day file, and full day bars
// on request. Nothing is copied into the store; simulation runs keep using versioned sources, which cannot leak
// later bars. Only the authenticated page reaches this, never a tool call.
const fs = require('node:fs/promises');
const path = require('node:path');
const { check } = require('./data.cjs');

const MARKETS = ['sh', 'sz', 'bj'];
const DAY_FILE = /^(sh|sz|bj)(\d{6})\.day$/;
const SYMBOL = /^(SH|SZ|BJ)\.(\d{6})$/;
const RECORD = 32;
// Name files in TDX's hq_cache: a 50-byte header, then 360-byte records with the code at 0, the GBK name at 31
// and the upper-case pinyin abbreviation at 329.
const TNF = { header: 50, record: 360, name: [31, 47], abbr: [329, 345] };

// Securities shown for browsing; bonds, repos and B shares are left out. Funds are priced in 0.001 yuan in .day files.
function classify(market, code) {
    if (market === 'sh') {
        if (/^60[0-5]/.test(code)) return { kind: 'stock', board: 'sh-main' };
        if (/^68[89]/.test(code)) return { kind: 'stock', board: 'star' };
        if (/^000/.test(code)) return { kind: 'index', board: 'index' };
        if (/^5[0-9]/.test(code)) return { kind: 'fund', board: 'fund' };
    } else if (market === 'sz') {
        if (/^00[0-3]/.test(code)) return { kind: 'stock', board: 'sz-main' };
        if (/^30[0-2]/.test(code)) return { kind: 'stock', board: 'chinext' };
        if (/^399/.test(code)) return { kind: 'index', board: 'index' };
        if (/^1[568]/.test(code)) return { kind: 'fund', board: 'fund' };
    } else if (/^899/.test(code)) return { kind: 'index', board: 'index' };
    else if (/^(43|83|87|88|92)/.test(code)) return { kind: 'stock', board: 'bse' };
    return null;
}
const gbk = new TextDecoder('gbk');
const text = (bytes, decode) => {
    const end = bytes.indexOf(0);
    return (decode ? gbk.decode(end < 0 ? bytes : bytes.subarray(0, end)) : bytes.toString('ascii', 0, end < 0 ? bytes.length : end)).trim();
};
function parseNames(buffer, market, into) {
    for (let offset = TNF.header; offset + TNF.record <= buffer.length; offset += TNF.record) {
        const record = buffer.subarray(offset, offset + TNF.record);
        const code = record.toString('ascii', 0, 6);
        if (!/^\d{6}$/.test(code)) continue;
        const name = text(record.subarray(...TNF.name), true), abbr = text(record.subarray(...TNF.abbr), false);
        if (name) into.set(market + code, { name, abbr: /^[A-Z0-9]{1,16}$/.test(abbr) ? abbr : '' });
    }
}
function readRecord(buffer, offset, scale) {
    const value = String(buffer.readUInt32LE(offset));
    return { date: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`,
        open: buffer.readUInt32LE(offset + 4), high: buffer.readUInt32LE(offset + 8), low: buffer.readUInt32LE(offset + 12),
        close: buffer.readUInt32LE(offset + 16), amount: Math.round(buffer.readFloatLE(offset + 20)),
        volume: buffer.readUInt32LE(offset + 24), scale };
}
const valid = bar => /^\d{4}-\d{2}-\d{2}$/.test(bar.date) && bar.close > 0 && bar.low > 0 && bar.low <= bar.high;

class MarketDirectory {
    // root: the vipdoc directory. names: TDX's hq_cache directory, by default <root>/../T0002/hq_cache.
    // cacheFile keeps the latest quotes between restarts: a cold read of every file's end takes tens of seconds.
    constructor(root, { names = path.join(root, '..', 'T0002', 'hq_cache'), cacheFile } = {}) {
        this.root = root; this.namesDirectory = names; this.cacheFile = cacheFile;
        this.listCache = null; this.quoteCache = new Map(); this.loaded = null; this.dirty = false;
        this.asOfCache = null;
    }
    async loadCache() {
        if (!this.cacheFile) return;
        this.loaded ??= fs.readFile(this.cacheFile, 'utf8').then(raw => {
            const saved = JSON.parse(raw);
            if (saved.root === this.root) for (const [symbol, entry] of Object.entries(saved.quotes || {})) this.quoteCache.set(symbol, entry);
        }).catch(() => {});
        return this.loaded;
    }
    async saveCache() {
        if (!this.cacheFile || !this.dirty) return;
        this.dirty = false;
        await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
        const temporary = `${this.cacheFile}.${process.pid}.tmp`;
        await fs.writeFile(temporary, JSON.stringify({ root: this.root, quotes: Object.fromEntries(this.quoteCache) }));
        await fs.rename(temporary, this.cacheFile);
    }
    // Reads every listed security's latest quote once, so the first page load finds them cached.
    async prewarm(stopped = () => false) {
        const list = await this.securities();
        for (let i = 0; i < list.length && !stopped(); i += 256) await this.quotes(list.slice(i, i + 256).map(s => s.symbol));
        await this.saveCache();
    }
    file(symbol) {
        const match = SYMBOL.exec(String(symbol));
        check(match, 'INVALID_ARGUMENT', '证券标识须为 SH.600000 这样的格式。');
        const market = match[1].toLowerCase();
        return path.join(this.root, market, 'lday', `${market}${match[2]}.day`);
    }
    // Directory and name-file times decide when the list is rebuilt; a listing takes well under a second.
    async stamp() {
        const parts = [];
        for (const market of MARKETS) {
            parts.push(await fs.stat(path.join(this.root, market, 'lday')).then(s => s.mtimeMs, () => 0));
            parts.push(await fs.stat(path.join(this.namesDirectory, `${market}s.tnf`)).then(s => `${s.size}:${s.mtimeMs}`, () => 0));
        }
        return parts.join('|');
    }
    async securities() {
        const stamp = await this.stamp();
        if (this.listCache?.stamp === stamp) return this.listCache.list;
        const names = new Map();
        for (const market of MARKETS) {
            const buffer = await fs.readFile(path.join(this.namesDirectory, `${market}s.tnf`)).catch(() => null);
            if (buffer) parseNames(buffer, market, names);
        }
        const list = [];
        for (const market of MARKETS) {
            const files = await fs.readdir(path.join(this.root, market, 'lday')).catch(() => []);
            for (const file of files) {
                const match = DAY_FILE.exec(file);
                if (!match || match[1] !== market) continue;
                const kind = classify(market, match[2]);
                if (!kind) continue;
                const named = names.get(market + match[2]);
                list.push({ symbol: `${market.toUpperCase()}.${match[2]}`, code: match[2], market, name: named?.name || match[2],
                    abbr: named?.abbr || '', ...kind, scale: kind.kind === 'fund' ? 1000 : 100 });
            }
        }
        check(list.length, 'MARKET_UNAVAILABLE', '数据目录下没有 sh/sz/bj lday 日线文件，请确认填写的是 vipdoc 目录。');
        list.sort((a, b) => a.symbol < b.symbol ? -1 : 1);
        this.listCache = { stamp, list, bySymbol: new Map(list.map(s => [s.symbol, s])), names: names.size };
        this.asOfCache = null;
        return list;
    }
    async securitiesAsOf(asOf) {
        const list = await this.securities();
        if (this.asOfCache?.stamp === this.listCache.stamp && this.asOfCache.date === asOf) return this.asOfCache.list;
        const eligible = [];
        for (let i = 0; i < list.length; i += 64) {
            const batch = await Promise.all(list.slice(i, i + 64).map(async security => {
                let handle;
                try {
                    handle = await fs.open(this.file(security.symbol), 'r');
                    const buffer = Buffer.alloc(RECORD);
                    const { bytesRead } = await handle.read(buffer, 0, RECORD, 0);
                    const first = bytesRead === RECORD ? readRecord(buffer, 0, security.scale) : null;
                    return first && valid(first) && first.date <= asOf ? security : null;
                } catch { return null; } finally { await handle?.close(); }
            }));
            eligible.push(...batch.filter(Boolean));
        }
        this.asOfCache = { stamp: this.listCache.stamp, date: asOf, list: eligible };
        return eligible;
    }
    async status() {
        const list = await this.securities();
        const count = kind => list.filter(s => s.kind === kind).length;
        const index = await this.quotes(['SH.000001']).catch(() => []);
        return { directory: this.root, namesFound: this.listCache.names > 0, stocks: count('stock'), indices: count('index'),
            funds: count('fund'), lastDate: index[0]?.date || null };
    }
    // Latest and previous day for each symbol, read from the last two records; cached until the file changes.
    async quotes(symbols) {
        check(Array.isArray(symbols) && symbols.length <= 20000, 'INVALID_ARGUMENT', 'symbols 须为证券标识数组。');
        await this.loadCache();
        const known = (await this.securities(), this.listCache.bySymbol);
        const out = [];
        for (let i = 0; i < symbols.length; i += 64) {
            out.push(...await Promise.all(symbols.slice(i, i + 64).map(symbol => this.quote(symbol, known.get(symbol)))));
        }
        if (this.dirty && symbols.length >= 256) await this.saveCache().catch(() => {});
        return out.filter(Boolean);
    }
    async quote(symbol, security) {
        if (!security) return null;
        const file = this.file(symbol);
        let handle;
        try {
            const { size, mtimeMs } = await fs.stat(file);
            const key = `${size}:${mtimeMs}`, cached = this.quoteCache.get(symbol);
            if (cached?.key === key) return cached.quote;
            const count = Math.min(2, Math.floor(size / RECORD));
            if (!count) return null;
            const buffer = Buffer.alloc(count * RECORD);
            handle = await fs.open(file, 'r');
            await handle.read(buffer, 0, buffer.length, size - buffer.length);
            const last = readRecord(buffer, (count - 1) * RECORD, security.scale), previous = count > 1 ? readRecord(buffer, 0, security.scale) : null;
            const quote = valid(last) ? { symbol, date: last.date, open: last.open, high: last.high, low: last.low, close: last.close,
                previousClose: previous && valid(previous) ? previous.close : null, volume: last.volume, amount: last.amount, scale: security.scale } : null;
            this.quoteCache.set(symbol, { key, quote }); this.dirty = true;
            return quote;
        } catch { return null; } finally { await handle?.close(); }
    }
    // Day bars, oldest first; limit keeps only the most recent ones.
    async bars(symbol, limit = 5000) {
        check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 20000, 'INVALID_ARGUMENT', 'limit 须为 1 至 20000。');
        await this.securities();
        const security = this.listCache.bySymbol.get(symbol);
        check(security, 'UNKNOWN_SYMBOL', '数据目录中没有该证券。');
        let buffer;
        try { buffer = await fs.readFile(this.file(symbol)); }
        catch { check(false, 'SOURCE_FILE_UNAVAILABLE', '该证券的日线文件不可读取。'); }
        const total = Math.floor(buffer.length / RECORD), first = Math.max(0, total - limit), bars = [];
        for (let i = first; i < total; i++) {
            const bar = readRecord(buffer, i * RECORD, security.scale);
            if (valid(bar)) bars.push(bar);
        }
        return { ...security, bars, truncated: first > 0 };
    }
}
module.exports = { MarketDirectory, classify, parseNames };
