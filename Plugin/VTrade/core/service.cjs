'use strict';

const { Store } = require('./store.cjs');
const { check, hash, date } = require('./data.cjs');
const { MarketRepository, assertExtension } = require('./market-repository.cjs');
const { LocalSources } = require('./local-sources.cjs');
const { MarketDirectory } = require('./market-directory.cjs');
const { atomicWrite } = require('./store.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRegistry } = require('./builtins.cjs');
const { invoke, analysisOutput, universeOutput, toolOutput } = require('./slots.cjs');
const engine = require('./engine.cjs');

const READ_COMMANDS = new Set(['GetObservation', 'GetJournal', 'GetPerformance', 'GetChart', 'GetRunManifest']);
const WRITE_COMMANDS = new Set(['SavePlan', 'SubmitOrder', 'CancelOrder', 'AdvanceDay',
    'PauseSession', 'ResumeSession', 'SaveReview', 'SyncSessionData']);
// Commands that run a slot implementation outside the session write queue. They never write the ledger.
const SLOT_COMMANDS = new Set(['GetAnalysis', 'CallTool']);
// Host transport fields; a tool sees only its own arguments.
const TOOL_RESERVED = new Set(['command', 'sessionId', 'tool', 'maid', 'requestId']);

function requestKey(value) {
    check(typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value),
        'INVALID_REQUEST', 'requestId 须为 1 至 100 字符的字母、数字、下划线或连字符。');
    return value;
}
function fingerprint(args) {
    // Explicitly project the contract; prompt-only fields and display signatures are not authority.
    const keys = ['command', 'sessionId', 'datasetId', 'name', 'agentName', 'startDate', 'symbols',
        'initialCashCents', 'rulesProfile', 'expectedRevision', 'observationId', 'symbol', 'side',
        'quantity', 'limitPriceCents', 'planId', 'orderId', 'note', 'dataMode', 'sourceId', 'universe', 'group'];
    return hash(keys.filter(k => args[k] !== undefined).map(k => [k, args[k]]));
}
const plainOptions = value => {
    check(value === undefined || value !== null && typeof value === 'object' && !Array.isArray(value),
        'INVALID_ARGUMENT', 'options 须为 JSON 对象。');
    return structuredClone(value ?? {});
};
class TradeService {
    constructor(directory, options = {}) {
        this.store = new Store(directory);
        this.repository = new MarketRepository(this.store);
        this.registry = options.registry || createRegistry();
        this.localSources = new LocalSources(this);
        this.options = options;
        this.timeoutMs = options.providerTimeoutMs ?? 10000;
        this.closed = false;
    }
    async initialize() {
        try {
            await this.store.open();
            await this.repository.open();
            await this.localSources.open(this.options.sourcesFile);
            this.marketSettings = await fs.readFile(this.marketSettingsFile, 'utf8').then(JSON.parse, () => ({}));
            this.localSources.start();
        } catch (error) { await this.localSources.close(); await this.store.close(); throw error; }
        // Browsing reads quotes from every local file once; doing it now keeps the first page load fast.
        if (this.options.prewarm !== false) {
            this.warming = Promise.resolve().then(() => this.marketDirectory(false)?.prewarm(() => this.closed)).catch(() => {});
        }
        return this;
    }
    get marketSettingsFile() { return path.join(this.store.directory, 'settings', 'market.json'); }
    // The browsing directory: the one set on the settings page, else the first TDX source's directory.
    marketDirectory(required = true) {
        const explicit = this.marketSettings?.directory;
        const directory = explicit || [...this.localSources.configs.values()].find(c => c.kind === 'tdx')?.directory;
        check(directory || !required, 'MARKET_UNCONFIGURED', '尚未设置通达信目录。请在“设置 → 数据”中填写 vipdoc 目录。');
        if (!directory) return null;
        if (this.market?.root !== directory) {
            this.market = new MarketDirectory(directory, { cacheFile: path.join(this.store.directory, 'cache', 'market-quotes.json') });
        }
        this.market.origin = explicit ? 'settings' : 'source';
        return this.market;
    }
    // Browsing the local market. Like settings, only the authenticated page reaches this: a simulation must not see later bars.
    async browse(input) {
        check(!this.closed, 'CLOSED', 'VTrade 已停止。');
        check(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_ARGUMENT', '参数须为对象。');
        const market = this.marketDirectory();
        if (input.action === 'status') return { status: { ...await market.status(), origin: market.origin } };
        if (input.action === 'list') return { securities: await market.securities() };
        if (input.action === 'quotes') return { quotes: await market.quotes(input.symbols) };
        if (input.action === 'bars') return { chart: await market.bars(input.symbol, input.limit ?? 5000) };
        check(false, 'INVALID_ARGUMENT', '未知的行情操作。');
    }
    async data(id) { return this.repository.load(id); }
    async importDataset(input) {
        check(!this.closed, 'CLOSED', 'VTrade 已停止。');
        return this.repository.import(input);
    }
    async ingestDataset(input, options) {
        check(!this.closed, 'CLOSED', 'VTrade 已停止。');
        return this.repository.ingest(input, options);
    }
    sources() {
        const heads = new Set([...this.repository.feeds.values()].map(f => f.datasetId));
        return { sources: [...this.repository.catalog.values()].filter(s => !this.repository.versions.has(s.datasetId) || heads.has(s.datasetId)).map(s => structuredClone(s)),
            dataFeeds: [...this.repository.feeds.values()].map(f => ({ sourceId: f.sourceId, datasetId: f.datasetId,
                revision: f.revision, source: { ...this.repository.catalog.get(f.datasetId).source } })),
            configuredSources: this.localSources.list() };
    }
    // Administrator settings. Only the authenticated page reaches this; tool calls go through command() and cannot.
    async settings(input) {
        check(!this.closed, 'CLOSED', 'VTrade 已停止。');
        check(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_ARGUMENT', '参数须为对象。');
        if (input.action === 'sources') return { sources: this.localSources.describe() };
        if (input.action === 'probe') return { probe: await this.localSources.probe(input.directory, input.securities) };
        if (input.action === 'saveSource') return { source: await this.localSources.save(input.source) };
        if (input.action === 'removeSource') { await this.localSources.remove(input.sourceId); return { removed: input.sourceId }; }
        if (input.action === 'market') {
            const market = this.marketDirectory(false);
            return { market: { directory: this.marketSettings?.directory || null, effective: market?.root || null, origin: market?.origin || null } };
        }
        if (input.action === 'saveMarket') {
            const directory = String(input.directory ?? '').trim();
            check(directory === '' || path.isAbsolute(directory), 'INVALID_SOURCE', '数据目录须为绝对路径，例如 D:/通达信/vipdoc。');
            if (directory) await new MarketDirectory(directory).securities();
            await fs.mkdir(path.dirname(this.marketSettingsFile), { recursive: true });
            await atomicWrite(this.marketSettingsFile, directory ? { directory } : {});
            this.marketSettings = directory ? { directory } : {};
            return this.settings({ action: 'market' });
        }
        check(false, 'INVALID_ARGUMENT', '未知的设置操作。');
    }
    async sessionMarket(state) {
        const m = await this.data(state.datasetId);
        check(m.fingerprint === state.fingerprint, 'SOURCE_CHANGED', '数据源已变化；请新建运行，旧运行未改写。');
        check(Number.isInteger(state.cursor) && state.cursor >= 0 && state.cursor < m.days.length,
            'CORRUPT_SAVE', '存档中的交易日不合法。');
        return m;
    }
    // Reads may continue when a third-party execution model is gone; anything that settles or reserves may not.
    execution(state, required) {
        if (required || this.registry.has('execution', state.rulesProfile)) return this.registry.get('execution', state.rulesProfile);
        return null;
    }
    observe(state, m) { return engine.observe(state, m, this.execution(state, false)); }
    datasetFor(args) { return args.sourceId ? this.repository.feed(args.sourceId).datasetId : args.datasetId || 'demo'; }
    async universe(id, m, asOf, options, signal) {
        const provider = this.registry.get('universe', id);
        const output = await invoke('universe', id, s => provider.groups({ asOf,
            securities: m.dataset.securities.map(x => ({ symbol: x.symbol, name: x.name })), options, signal: s }),
        { timeoutMs: this.timeoutMs, signal });
        return universeOutput(output, new Set(m.bySymbol.keys()));
    }
    async snapshot(sessionId) {
        const state = await this.store.read(sessionId);
        const m = await this.sessionMarket(state), asOf = m.days[state.cursor];
        const bars = symbol => m.bySymbol.get(symbol).bars.filter(b => b.date <= asOf).map(b => ({ ...b }));
        return { state, m, asOf, bars };
    }
    async slotCommand(args, signal) {
        // Read the session in its queue, then run the implementation outside it so slow I/O never blocks writes.
        const { state, asOf, bars } = await this.store.serial(args.sessionId, () => this.snapshot(args.sessionId));
        const session = { sessionId: state.id, symbols: [...state.symbols], dataMode: state.dataMode || 'snapshot',
            revision: state.revision, rulesProfile: state.rulesProfile };
        if (args.command === 'GetAnalysis') {
            check(state.symbols.includes(args.symbol), 'UNKNOWN_SYMBOL', '证券不在本次运行的股票池中。');
            const id = args.analysis || 'ma', provider = this.registry.get('analysis', id);
            const limit = args.limit ?? 120;
            check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000, 'INVALID_ARGUMENT', '分析结果数量须为 1 至 1000。');
            const options = plainOptions(args.options);
            const output = await invoke('analysis', id, s => provider.compute({ symbol: args.symbol, asOf,
                bars: bars(args.symbol), options, signal: s }), { timeoutMs: this.timeoutMs, signal });
            const rows = analysisOutput(provider.type, output, asOf, limit);
            return { analysis: { id, type: provider.type, sessionId: state.id, symbol: args.symbol, asOf, revision: state.revision,
                options, [provider.type === 'indicator' ? 'series' : 'signals']: rows,
                notice: '分析由所选插槽实现计算，只使用模拟日及以前的日线；不是投资建议。' } };
        }
        check(typeof args.tool === 'string', 'INVALID_ARGUMENT', 'CallTool 需要 tool（ListExtensions 中的工具标识）。');
        const provider = this.registry.get('tool', args.tool);
        const input = Object.fromEntries(Object.entries(args).filter(([k]) => !TOOL_RESERVED.has(k)).map(([k, v]) => [k, structuredClone(v)]));
        const result = await invoke('tool', args.tool, s => provider.run({ asOf, session, bars: symbol => {
            check(state.symbols.includes(symbol), 'UNKNOWN_SYMBOL', '证券不在本次运行的股票池中。');
            return bars(symbol);
        }, ...this.localSources.toolContext(args.tool), signal: s }, input), { timeoutMs: this.timeoutMs, signal });
        return { tool: { id: args.tool, sessionId: state.id, asOf, revision: state.revision, network: provider.network === true,
            result: toolOutput(result) } };
    }
    async command(args, { signal } = {}) {
        check(!this.closed, 'CLOSED', 'VTrade 已停止。');
        check(args && typeof args === 'object' && !Array.isArray(args), 'INVALID_ARGUMENT', '参数须为对象。');
        args = structuredClone(args);
        const command = args.command;
        if (command === 'GetSources') return this.sources();
        if (command === 'ListExtensions') return { extensions: this.registry.list() };
        if (command === 'GetDataStatus') {
            const configured = this.localSources.list().find(s => s.sourceId === args.sourceId);
            if (!this.repository.feeds.has(args.sourceId) && configured) return { dataStatus: { ...configured, datasetId: null, revision: 0,
                status: 'not_synced', ...this.localSources.runtimeStatus.get(args.sourceId) } };
            return { dataStatus: await this.repository.status(args.sourceId) };
        }
        if (command === 'SyncSource') {
            requestKey(args.requestId);
            return { sync: await this.localSources.sync(args.sourceId, args) };
        }
        if (command === 'GetUniverse') {
            const datasetId = this.datasetFor(args), m = await this.data(datasetId);
            const asOf = args.asOf === undefined ? m.days.at(-1) : date(args.asOf);
            const id = args.universe || 'all';
            return { universe: { id, datasetId, asOf, groups: await this.universe(id, m, asOf, plainOptions(args.options), signal) } };
        }
        if (command === 'ListSessions') return this.store.list();
        if (command === 'CreateSession') {
            const key = requestKey(args.requestId);
            const id = `run-${hash(key).slice(0, 32)}`;
            return this.store.serial(id, async () => {
                const fp = fingerprint(args);
                let existing;
                try { existing = await this.store.read(id); }
                catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
                if (existing) {
                    check(existing.creationFingerprint === fp, 'REQUEST_CONFLICT', '同一创建请求不能更换内容。');
                    return { duplicate: true, observation: this.observe(existing, await this.sessionMarket(existing)) };
                }
                const datasetId = this.datasetFor(args);
                const m = await this.data(datasetId);
                this.registry.get('execution', engine.defaultProfile(args, m));
                let universe;
                if (args.universe !== undefined || args.group !== undefined) {
                    check(args.symbols === undefined, 'INVALID_ARGUMENT', 'symbols 与 universe/group 只能二选一。');
                    const universeId = args.universe || 'all', asOf = m.days[engine.startIndex(args, m).start];
                    const groups = await this.universe(universeId, m, asOf, {}, signal);
                    check(args.group !== undefined || groups.length === 1, 'INVALID_ARGUMENT', '该股票池有多个分组，请用 group 指定。');
                    const group = groups.find(g => g.id === (args.group ?? groups[0].id));
                    check(group, 'INVALID_ARGUMENT', '股票池中没有该分组。');
                    check(group.symbols.length > 0 && group.symbols.length <= 100, 'INVALID_ARGUMENT', '分组在所选数据源中须有 1 至 100 个证券。');
                    universe = { id: universeId, group: group.id, asOf, symbols: group.symbols };
                }
                const state = engine.create(id, args, m, datasetId, universe);
                state.creationFingerprint = fp;
                await this.store.write(state);
                return { duplicate: false, observation: this.observe(state, m) };
            });
        }
        if (SLOT_COMMANDS.has(command)) return this.slotCommand(args, signal);
        check(READ_COMMANDS.has(command) || WRITE_COMMANDS.has(command) || command === 'PreviewOrder',
            'UNKNOWN_COMMAND', '未知 VTrade 命令。');
        return this.store.serial(args.sessionId, async () => {
            const state = await this.store.read(args.sessionId);
            const m = await this.sessionMarket(state);
            if (READ_COMMANDS.has(command)) {
                if (command === 'GetRunManifest') return { manifest: engine.manifest(state, m, this.execution(state, false)) };
                if (command === 'GetChart') {
                    check(state.symbols.includes(args.symbol), 'UNKNOWN_SYMBOL', '证券不在本次运行的股票池中。');
                    const limit = args.limit ?? 500;
                    check(Number.isSafeInteger(limit) && limit >= 2 && limit <= 5000,
                        'INVALID_ARGUMENT', '图表日线数量须为 2 至 5000。');
                    const bars = m.bySymbol.get(args.symbol).bars.filter(b => b.date <= m.days[state.cursor]);
                    return { chart: { sessionId: state.id, symbol: args.symbol, revision: state.revision,
                        asOf: m.days[state.cursor], adjustment: 'none', priceUnit: 'cents', volumeUnit: 'shares',
                        bars: bars.slice(-limit).map(b => ({ ...b })), truncated: bars.length > limit } };
                }
                if (command === 'GetJournal') {
                    const limit = args.limit ?? 100;
                    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500,
                        'INVALID_ARGUMENT', '记录分页数量须为 1 至 500。');
                    let after = 0;
                    if (args.afterEventId !== undefined) {
                        check(typeof args.afterEventId === 'string' && /^event-[1-9]\d*$/.test(args.afterEventId),
                            'INVALID_ARGUMENT', '记录游标无效。');
                        after = Number(args.afterEventId.slice(6));
                        check(Number.isSafeInteger(after) && after <= state.events.length,
                            'INVALID_ARGUMENT', '记录游标不属于当前运行。');
                    }
                    const events = state.events.slice(after, after + limit);
                    return { journal: { events, total: state.events.length,
                        nextAfterEventId: events.at(-1)?.id || args.afterEventId || null,
                        hasMore: after + events.length < state.events.length }, observation: this.observe(state, m) };
                }
                return { observation: this.observe(state, m) };
            }
            if (command === 'PreviewOrder') {
                engine.binding(state, args);
                return { preview: engine.intent(state, m, args, this.execution(state, true)), observation: this.observe(state, m) };
            }
            const key = requestKey(args.requestId), fp = fingerprint(args);
            if (Object.hasOwn(state.receipts, key)) {
                const prior = state.receipts[key];
                check(prior.fingerprint === fp, 'REQUEST_CONFLICT', '同一 requestId 不能用于不同操作。');
                return { duplicate: true, receipt: prior.receipt, observation: this.observe(state, m) };
            }
            engine.binding(state, args);
            check(Object.keys(state.receipts).length < 10000, 'SESSION_LIMIT', '本次运行回执已达上限，请归档并创建新运行。');
            let result, currentMarket = m;
            if (command === 'SyncSessionData') {
                check(state.dataMode === 'continuous', 'FROZEN_RUN', '固定回放不能续接行情，请创建连续模拟。');
                const sourceId = args.sourceId || state.dataSourceId;
                check(sourceId && (!state.dataSourceId || sourceId === state.dataSourceId), 'SOURCE_MISMATCH', '续接必须使用运行绑定的行情来源。');
                const targetId = this.repository.feed(sourceId).datasetId;
                if (args.datasetId !== undefined) check(args.datasetId === targetId, 'STALE_DATA_VERSION', '来源头版本已变化，请重新确认后续接。');
                currentMarket = await this.data(targetId);
                assertExtension(m, currentMarket);
                result = engine.attachData(state, m, currentMarket, targetId, sourceId);
            } else {
                const settles = command === 'SubmitOrder' || command === 'AdvanceDay';
                result = engine.apply(state, m, args, settles ? this.execution(state, true) : null);
            }
            engine.account(state, currentMarket);
            state.revision++;
            const receipt = { requestId: key, command, revision: state.revision, ...result };
            Object.defineProperty(state.receipts, key, { enumerable: true, configurable: true,
                value: { fingerprint: fp, receipt } });
            // Save the receipt and transition together. A failed write has no in-memory commit.
            await this.store.write(state);
            return { duplicate: false, receipt, observation: this.observe(state, currentMarket) };
        });
    }
    async close() {
        this.closed = true;
        await this.warming; await this.market?.saveCache().catch(() => {});
        await this.localSources.close(); await this.store.close();
    }
}
module.exports = { TradeService, READ_COMMANDS, WRITE_COMMANDS, SLOT_COMMANDS };
