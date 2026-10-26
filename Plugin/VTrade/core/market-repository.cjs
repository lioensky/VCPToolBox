'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite } = require('./store.cjs');
const { check, hash, date, completedDate, normalizeDataset, market, demoDataset, workbenchDemoDataset } = require('./data.cjs');

const validSource = id => typeof id === 'string' && /^feed-[A-Za-z0-9_-]{1,60}$/.test(id);
const validVersion = id => typeof id === 'string' && /^data-[a-f0-9]{64}$/.test(id);
const identity = source => ['kind', 'adjustment', 'currency', 'timezone', 'volumeUnit'].map(k => source[k]);
const summary = (id, m) => ({ datasetId: id, source: { ...m.dataset.source },
    securities: m.dataset.securities.map(s => ({ symbol: s.symbol, name: s.name })),
    firstDate: m.days[0], lastDate: m.days.at(-1) });

class MarketRepository {
    constructor(store) { this.store = store; this.catalog = new Map(); this.cache = new Map(); this.feeds = new Map(); this.versions = new Map(); }
    async open() {
        await fs.mkdir(path.join(this.store.directory, 'feeds'), { recursive: true });
        await fs.mkdir(path.join(this.store.directory, 'versions'), { recursive: true });
        for (const [id, data] of [['demo', demoDataset()], ['demo-workbench', workbenchDemoDataset()]]) this.remember(id, market(data));
        for (const file of await fs.readdir(path.join(this.store.directory, 'datasets'))) {
            if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
            const id = `data-${file.slice(0, -5)}`;
            this.remember(id, await this.readVersion(id));
        }
        for (const file of await fs.readdir(path.join(this.store.directory, 'versions'))) {
            if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
            const id = `data-${file.slice(0, -5)}`, descriptor = await this.readDelta(id);
            this.catalog.set(id, descriptor.catalog);
            this.versions.set(id, descriptor.parentDatasetId);
        }
        check([...this.versions.values()].every(id => this.catalog.has(id)), 'CORRUPT_DATA', '增量版本缺少父快照，已保留原文件。');
        for (const file of await fs.readdir(path.join(this.store.directory, 'feeds'))) {
            if (!file.endsWith('.json') || !validSource(file.slice(0, -5))) continue;
            const feed = JSON.parse(await fs.readFile(this.feedFile(file.slice(0, -5)), 'utf8'));
            check(feed.schemaVersion === 1 && feed.sourceId === file.slice(0, -5)
                && validVersion(feed.datasetId) && this.catalog.has(feed.datasetId)
                && Number.isSafeInteger(feed.revision) && feed.revision >= 1
                && Array.isArray(feed.history) && feed.history.length === feed.revision
                && feed.history.at(-1).datasetId === feed.datasetId
                && feed.receipts && typeof feed.receipts === 'object' && !Array.isArray(feed.receipts),
            'CORRUPT_DATA', '行情来源版本记录损坏，已保留原文件。');
            const revisions = new Map(feed.history.map(h => [h.revision, h.datasetId]));
            check(feed.history.every((h, i) => h.revision === i + 1 && validVersion(h.datasetId) && this.catalog.has(h.datasetId)
                && h.parentDatasetId === (i ? feed.history[i - 1].datasetId : null)
                && typeof h.ingestedAt === 'string' && h.availableAt === null && typeof h.completedThrough === 'string')
                && Object.entries(feed.receipts).every(([key, r]) => /^[A-Za-z0-9_-]{1,100}$/.test(key)
                    && r && /^[a-f0-9]{64}$/.test(r.fingerprint) && r.result?.sourceId === feed.sourceId
                    && revisions.get(r.result.revision) === r.result.datasetId
                    && Number.isSafeInteger(r.result.added) && r.result.added >= 0
                    && Number.isSafeInteger(r.result.unchanged) && r.result.unchanged >= 0
                    && typeof r.result.changed === 'boolean'
                    && (r.invocationFingerprint === undefined || /^[a-f0-9]{64}$/.test(r.invocationFingerprint))),
            'CORRUPT_DATA', '行情版本链或同步回执损坏，已保留原文件。');
            this.feeds.set(feed.sourceId, feed);
        }
    }
    async readDelta(id) {
        const descriptor = JSON.parse(await fs.readFile(path.join(this.store.directory, 'versions', `${id.slice(5)}.json`), 'utf8'));
        const { checksum, ...body } = descriptor;
        check(body.schemaVersion === 2 && body.datasetId === id && validVersion(body.parentDatasetId)
            && body.catalog?.datasetId === id && hash(body) === checksum, 'CORRUPT_DATA', '增量文件标识或校验失败。');
        normalizeDataset(body.delta, { minimumBars: 1 });
        return descriptor;
    }
    feedFile(id) { check(validSource(id), 'INVALID_SOURCE', '来源标识须为 feed- 开头的字母、数字、下划线或连字符。'); return path.join(this.store.directory, 'feeds', `${id}.json`); }
    remember(id, m) {
        this.catalog.set(id, summary(id, m));
        this.cache.delete(id); this.cache.set(id, m);
        while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
        return m;
    }
    async readVersion(id) {
        check(validVersion(id), 'PROVIDER_UNAVAILABLE', '行情快照不存在。');
        if (this.versions.has(id)) {
            const chain = [], seen = new Set(); let parent = id;
            while (this.versions.has(parent) && !this.cache.has(parent)) {
                check(!seen.has(parent) && chain.length < 10000, 'CORRUPT_DATA', '增量版本链循环或过长。');
                seen.add(parent);
                const descriptor = await this.readDelta(parent); chain.push(descriptor); parent = descriptor.parentDatasetId;
            }
            const base = await this.load(parent), data = structuredClone(base.dataset);
            for (const descriptor of chain.reverse()) {
                check(hash(identity(data.source)) === hash(identity(descriptor.delta.source)), 'CORRUPT_DATA', '增量版本改变了来源口径。');
                for (const item of descriptor.delta.securities) {
                    const target = data.securities.find(s => s.symbol === item.symbol);
                    check(target && target.name === item.name && item.bars[0].date > target.bars.at(-1).date,
                        'CORRUPT_DATA', '增量文件修改或插入了历史。');
                    target.bars.push(...item.bars);
                }
            }
            const normalized = normalizeDataset(data);
            check(hash(normalized) === id.slice(5), 'CORRUPT_DATA', '增量重建结果与内容版本不一致。');
            return market(normalized);
        }
        let input;
        try { input = JSON.parse(await fs.readFile(path.join(this.store.directory, 'datasets', `${id.slice(5)}.json`), 'utf8')); }
        catch (error) { check(error.code !== 'ENOENT', 'PROVIDER_UNAVAILABLE', '行情快照不存在。'); throw error; }
        const data = normalizeDataset(input);
        check(hash(data) === id.slice(5), 'CORRUPT_DATA', '行情内容与版本标识不一致。');
        return market(data);
    }
    async load(id) {
        if (this.cache.has(id)) { const m = this.cache.get(id); this.cache.delete(id); this.cache.set(id, m); return m; }
        if (id === 'demo') return this.remember(id, market(demoDataset()));
        if (id === 'demo-workbench') return this.remember(id, market(workbenchDemoDataset()));
        return this.remember(id, await this.readVersion(id));
    }
    async persist(data, parentDatasetId) {
        const id = `data-${hash(data)}`;
        // Data is immutable. Publishing a feed descriptor is the commit point; an orphan version is harmless.
        if (!this.catalog.has(id)) {
            if (parentDatasetId) {
                const parent = await this.load(parentDatasetId);
                const securities = data.securities.map(s => ({ ...s, bars: s.bars.slice(parent.bySymbol.get(s.symbol).bars.length) })).filter(s => s.bars.length);
                const body = { schemaVersion: 2, datasetId: id, parentDatasetId,
                    delta: { ...data, securities }, catalog: summary(id, market(data)) };
                await atomicWrite(path.join(this.store.directory, 'versions', `${id.slice(5)}.json`), { ...body, checksum: hash(body) });
                this.versions.set(id, parentDatasetId);
            } else await atomicWrite(path.join(this.store.directory, 'datasets', `${id.slice(5)}.json`), data);
        }
        this.remember(id, market(data)); return id;
    }
    async import(input) {
        const data = normalizeDataset(input);
        return this.store.serial('datasets', async () => {
            const id = await this.persist(data);
            return { datasetId: id, source: { ...data.source }, securities: data.securities.map(s => ({ symbol: s.symbol, name: s.name, bars: s.bars.length })) };
        });
    }
    feed(id) {
        check(validSource(id) && this.feeds.has(id), 'SOURCE_UNAVAILABLE',
            '行情来源不存在，未切换其他来源。sourceId 只接受 GetSources 中 dataFeeds 的 feed- 标识；演示或导入的数据集请用 datasetId。');
        return this.feeds.get(id);
    }
    async status(id) {
        const feed = this.feed(id), m = await this.load(feed.datasetId);
        return { sourceId: id, datasetId: feed.datasetId, revision: feed.revision,
            lastAttemptAt: feed.lastAttemptAt, lastSuccessAt: feed.lastSuccessAt, lastError: feed.lastError || null,
            completedThrough: feed.completedThrough, availabilityPolicy: 'completed-date-confirmed; original-publication-time-unknown',
            history: feed.history.map(h => ({ ...h })),
            coverage: m.dataset.securities.map(s => ({ symbol: s.symbol, firstDate: s.bars[0].date,
                lastDate: s.bars.at(-1).date, bars: s.bars.length })) };
    }
    async ingest(input, options) {
        const { requestId, completedThrough, expectedDataVersion } = options;
        check(typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(requestId), 'INVALID_REQUEST', '同步需要唯一 requestId。');
        const sourceId = options.sourceId || `feed-${hash(requestId).slice(0, 24)}`;
        this.feedFile(sourceId); date(completedThrough);
        check(completedThrough <= completedDate(), 'INCOMPLETE_BAR', '仅接收上海时区保守盘后截止日期以前的数据。');
        const patch = normalizeDataset(input, { minimumBars: 1 });
        check(patch.securities.every(s => s.bars.every(b => b.date <= completedThrough)), 'INCOMPLETE_BAR', '批次包含尚未确认收盘的日期。');
        const fp = hash({ patch, completedThrough, expectedDataVersion: expectedDataVersion ?? null });
        return this.store.serial('datasets', async () => {
            const previous = this.feeds.get(sourceId);
            if (previous && Object.hasOwn(previous.receipts, requestId)) {
                const prior = previous.receipts[requestId];
                check(prior.fingerprint === fp, 'REQUEST_CONFLICT', '同一同步请求不能更换批次或版本。');
                if (options.automatic) {
                    const checked = { ...previous, lastAttemptAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), lastError: null };
                    await atomicWrite(this.feedFile(sourceId), checked); this.feeds.set(sourceId, checked);
                }
                return { ...structuredClone(prior.result), duplicate: true };
            }
            check(previous ? expectedDataVersion === previous.datasetId : expectedDataVersion === undefined || expectedDataVersion === null,
                'STALE_DATA_VERSION', '行情版本已变化，请重新读取来源状态。');
            const now = new Date().toISOString();
            let data, added = 0, unchanged = 0;
            try {
                if (!previous) {
                    data = normalizeDataset(patch); added = data.securities.reduce((n, s) => n + s.bars.length, 0);
                } else {
                    const base = (await this.load(previous.datasetId)).dataset;
                    check(hash(identity(base.source)) === hash(identity(patch.source)), 'SOURCE_MISMATCH', '来源、单位和价格口径不能在增量中切换。');
                    data = structuredClone(base);
                    for (const item of patch.securities) {
                        const target = data.securities.find(s => s.symbol === item.symbol);
                        check(target, 'UNKNOWN_SYMBOL', '增量不能悄悄更改证券池，请为新证券池新建来源。');
                        const existing = new Map(target.bars.map(b => [b.date, b]));
                        for (const bar of item.bars) {
                            if (existing.has(bar.date)) {
                                check(hash(existing.get(bar.date)) === hash(bar), 'HISTORICAL_CONFLICT', `历史日线存在差异：${item.symbol} / ${bar.date}，原版本未覆盖。`);
                                unchanged++;
                            } else {
                                check(bar.date > target.bars.at(-1).date, 'HISTORICAL_CONFLICT', '历史缺口需作为新快照处理，不能插入连续运行的既有日历。');
                                target.bars.push(bar); added++;
                            }
                        }
                    }
                    data = normalizeDataset(data);
                }
                const datasetId = await this.persist(data, previous?.datasetId);
                const changed = !previous || datasetId !== previous.datasetId;
                const feed = previous ? structuredClone(previous) : { schemaVersion: 1, sourceId, revision: 0, history: [], receipts: {} };
                check(Object.keys(feed.receipts).length < 10000, 'SOURCE_LIMIT', '同步回执达到上限，请归档并新建来源。');
                if (changed) {
                    feed.revision++;
                    feed.history.push({ revision: feed.revision, datasetId, parentDatasetId: previous?.datasetId || null,
                        ingestedAt: now, availableAt: null, completedThrough });
                }
                Object.assign(feed, { datasetId, completedThrough: previous && previous.completedThrough > completedThrough ? previous.completedThrough : completedThrough,
                    lastAttemptAt: now, lastSuccessAt: now, lastError: null });
                const result = { sourceId, datasetId, revision: feed.revision, added, unchanged, changed, duplicate: false };
                Object.defineProperty(feed.receipts, requestId, { enumerable: true, configurable: true, value: { fingerprint: fp, result,
                    ...(options.invocationFingerprint ? { invocationFingerprint: options.invocationFingerprint } : {}) } });
                await atomicWrite(this.feedFile(sourceId), feed);
                this.feeds.set(sourceId, feed);
                return structuredClone(result);
            } catch (error) {
                if (previous) {
                    const failed = { ...previous, lastAttemptAt: now, lastError: error.code || 'SYNC_FAILED' };
                    await atomicWrite(this.feedFile(sourceId), failed).then(() => this.feeds.set(sourceId, failed)).catch(() => {});
                }
                throw error;
            }
        });
    }
    async failure(id, code) {
        return this.store.serial('datasets', async () => {
            const previous = this.feeds.get(id);
            if (!previous) return;
            const failed = { ...previous, lastAttemptAt: new Date().toISOString(), lastError: code };
            await atomicWrite(this.feedFile(id), failed); this.feeds.set(id, failed);
        });
    }
}

function assertExtension(before, after) {
    check(hash(identity(before.dataset.source)) === hash(identity(after.dataset.source))
        && before.dataset.securities.length === after.dataset.securities.length,
    'INCOMPATIBLE_DATA', '续接不能切换来源、口径或证券池。');
    for (const item of before.dataset.securities) {
        const next = after.bySymbol.get(item.symbol);
        check(next && item.name === next.name && next.bars.length >= item.bars.length
            && item.bars.every((b, i) => hash(b) === hash(next.bars[i])),
        'HISTORICAL_CONFLICT', '续接必须保留全部旧日线，不能修改、删除或插入历史。');
    }
    check(before.days.every((day, i) => after.days[i] === day), 'HISTORICAL_CONFLICT', '续接不能改变既有交易日索引。');
}
module.exports = { MarketRepository, assertExtension, validSource };
