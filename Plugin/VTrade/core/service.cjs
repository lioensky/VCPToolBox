'use strict';

const { Store } = require('./store.cjs');
const { check, hash, date, completedDate } = require('./data.cjs');
const { MarketRepository, assertExtension } = require('./market-repository.cjs');
const { LocalSources } = require('./local-sources.cjs');
const { MarketDirectory } = require('./market-directory.cjs');
const { Boards } = require('./boards.cjs');
const { Minutes } = require('./minutes.cjs');
const { DuelService } = require('./duel.cjs');
const { atomicWrite } = require('./store.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRegistry } = require('./builtins.cjs');
const { invoke, analysisOutput, universeOutput, toolOutput } = require('./slots.cjs');
const engine = require('./engine.cjs');
const training = require('./training.cjs');

const READ_COMMANDS = new Set(['GetObservation', 'GetJournal', 'GetPerformance', 'GetChart', 'GetRunManifest', 'GetTrainingResult', 'GetMinuteChart',
    'GetSessionSecurities', 'GetSessionQuotes']);
const WRITE_COMMANDS = new Set(['SavePlan', 'SubmitOrder', 'CancelOrder', 'AdvanceDay',
    'PauseSession', 'ResumeSession', 'SaveReview', 'SyncSessionData', 'PlaceConditional', 'UpdateConditional', 'CancelConditional', 'RevealTraining']);
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
        'quantity', 'limitPriceCents', 'planId', 'orderId', 'note', 'dataMode', 'sourceId', 'universe', 'group',
        'type', 'triggerPriceCents', 'trailPercentBps', 'trailAmountCents', 'conditionalId', 'groupId',
        'stopLossCents', 'takeProfitCents', 'marketMode'];
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
        this.boards = new Boards(this.store);
        this.minutes = new Minutes(this.store);
        this.duels = new DuelService(this);
        this.options = options;
        this.timeoutMs = options.providerTimeoutMs ?? 10000;
        this.closed = false;
    }
    async initialize() {
        try {
            await this.store.open();
            await this.repository.open();
            await this.localSources.open(this.options.sourcesFile);
            await this.boards.open();
            await this.minutes.open();
            await this.duels.open();
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
        if (input.action === 'minuteSources') return { minuteSources: this.minutes.list() };
        if (input.action === 'minuteChart') return { minuteChart: this.minutes.chart(input.sourceId, input.symbol,
            { period: input.period ?? 1, limit: input.limit ?? 5000 }) };
        if (input.action === 'intraday') {
            check(typeof input.symbol === 'string', 'INVALID_ARGUMENT', '分时需要证券标识。');
            const provider = this.registry.get('tool', 'tencent-intraday');
            const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai',
                year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(part => [part.type, part.value]));
            const asOf = `${parts.year}-${parts.month}-${parts.day}`;
            const controller = new AbortController();
            const result = await invoke('tool', 'tencent-intraday', signal => provider.run({ asOf,
                session: { symbols: [input.symbol] }, signal }, { symbol: input.symbol }),
            { timeoutMs: this.timeoutMs, signal: controller.signal });
            return { intraday: toolOutput(result) };
        }
        const market = this.marketDirectory(false);
        if (input.action === 'status') {
            if (!market) return { status: { directory: null, stocks: 0, indices: 0, funds: 0, lastDate: null, origin: null } };
            return { status: { ...await market.status(), origin: market.origin } };
        }
        if (input.action === 'list') {
            if (!market) return { securities: [] };
            return { securities: await market.securities() };
        }
        if (input.action === 'quotes') {
            if (!market) return { quotes: [] };
            return { quotes: await market.quotes(input.symbols) };
        }
        if (input.action === 'bars') {
            if (!market) return { chart: { symbol: input.symbol, bars: [] } };
            return { chart: await market.bars(input.symbol, input.limit ?? 5000) };
        }
        check(false, 'INVALID_ARGUMENT', '未知的行情操作。');
    }
    // 对决: the page and orchestrator interface (authenticated page only) and the Agents' tool commands.
    async duel(input) {
        check(!this.closed, 'CLOSED', 'VTrade 已停止。');
        return this.duels.page(input);
    }
    async duelTool(args) {
        check(!this.closed, 'CLOSED', 'VTrade 已停止。');
        check(args && typeof args === 'object' && !Array.isArray(args), 'INVALID_ARGUMENT', '参数须为对象。');
        return this.duels.tool(args);
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
    async ingestMinutes(input) { return this.minutes.ingest(input); }
    async marketTool(args) {
        if (args.command === 'GetMarketSecurities') {
            const offset = args.offset ?? 0, limit = args.limit ?? 100;
            check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 500,
                'INVALID_ARGUMENT', '看盘列表分页参数无效。');
            const list = (await this.browse({ action: 'list' })).securities;
            return { market: { total: list.length, offset, securities: list.slice(offset, offset + limit) } };
        }
        if (args.command === 'GetMarketQuotes') {
            check(Array.isArray(args.symbols) && args.symbols.length <= 100, 'INVALID_ARGUMENT', '一次最多查询一百只证券。');
            return { market: { quotes: (await this.browse({ action: 'quotes', symbols: args.symbols })).quotes } };
        }
        if (args.command === 'GetMarketBars') {
            const limit = args.limit ?? 250;
            check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000,
                'INVALID_ARGUMENT', '看盘日线数量须为 1 至 1000。');
            return { market: { chart: (await this.browse({ action: 'bars', symbol: args.symbol, limit })).chart } };
        }
        check(false, 'UNKNOWN_COMMAND', '未知看盘命令。');
    }
    async createTrainingPair(args) {
        const key = requestKey(args.requestId), pairId = `pair-${hash(key).slice(0, 16)}`;
        const signature = hash(Object.fromEntries(Object.entries(args).filter(([name]) => name !== 'command')));
        const ids = ['human', 'agent'].map(role => `run-${hash(`${key}:${role}`).slice(0, 32)}`);
        const existing = await Promise.all(ids.map(id => this.store.read(id).catch(error => {
            if (error.code === 'NOT_FOUND') return null;
            throw error;
        })));
        if (existing.every(Boolean)) {
            check(existing.every(state => state.training?.requestSignature === signature),
                'REQUEST_CONFLICT', '同一训练请求不能更换设置。');
            return { pairId, duplicate: true, human: this.observe(existing[0], await this.sessionMarket(existing[0])),
                agent: this.observe(existing[1], await this.sessionMarket(existing[1])) };
        }
        const sourceDatasetId = this.datasetFor(args), original = await this.data(sourceDatasetId);
        const selected = training.choose(original, args);
        const blind = args.blind === true;
        const transformed = blind ? training.blindDataset(original, selected.symbol, selected.date) : null;
        const imported = transformed ? await this.repository.import(transformed.dataset) : null;
        const datasetId = imported?.datasetId || sourceDatasetId;
        const m = transformed ? await this.data(datasetId) : original;
        const startDate = transformed?.startDate || selected.date;
        const symbol = blind ? 'BLIND-A' : selected.symbol;
        const observations = [];
        for (const [index, role] of ['human', 'agent'].entries()) {
            const id = ids[index];
            const state = await this.store.serial(id, async () => {
                const found = await this.store.read(id).catch(error => error.code === 'NOT_FOUND' ? null : Promise.reject(error));
                if (found) {
                    check(found.training?.requestSignature === signature, 'REQUEST_CONFLICT', '训练请求已被其他设置使用。');
                    return found;
                }
                const input = { datasetId, startDate, symbols: [symbol], dataMode: 'snapshot',
                    initialCashCents: args.initialCashCents, rulesProfile: args.rulesProfile,
                    name: role === 'human' ? '训练 · 人工' : '训练 · Agent', agentName: role,
                    trainingMeta: { pairId, role, seed: selected.seed, blind, revealed: false,
                        originalSymbol: selected.symbol, originalStartDate: selected.date,
                        sourceDatasetId, requestSignature: signature } };
                const created = engine.create(id, input, m, datasetId);
                created.creationFingerprint = hash(input);
                await this.store.write(created);
                return created;
            });
            observations.push(this.observe(state, m));
        }
        return { pairId, duplicate: false, human: observations[0], agent: observations[1] };
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
        if (input.action === 'deleteSession') {
            check(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
                'INVALID_ARGUMENT', '删除模拟交易需要当前账本版本。');
            await this.store.serial(input.sessionId, async () => {
                const state = await this.store.read(input.sessionId);
                check(state.revision === input.expectedRevision, 'STALE_REVISION', '账本已变化，请刷新后再删除。');
                await fs.unlink(this.store.file(input.sessionId));
            });
            return { deletedSessionId: input.sessionId };
        }
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
    async directoryMarket(state = null, extraSymbols = []) {
        const directory = this.marketDirectory();
        const fingerprint = hash({ kind: 'local-market-directory', root: path.resolve(directory.root).toLowerCase() });
        if (state) check(state.fingerprint === fingerprint, 'SOURCE_CHANGED',
            '本机行情目录已变更；请恢复原目录后再打开此模拟账户。');
        const securities = await directory.securities();
        const known = new Map(securities.map(security => [security.symbol, security]));
        const cutoff = completedDate();
        const candidates = [known.get('SH.000001'), ...securities.filter(security => security.kind === 'index'),
            ...securities.filter(security => security.kind === 'stock')].filter(Boolean);
        let days = [];
        for (const candidate of candidates) {
            const history = await directory.bars(candidate.symbol, 20000).catch(() => null);
            days = history?.bars.filter(bar => bar.date <= cutoff).map(bar => bar.date) || [];
            if (days.length >= 2) break;
        }
        check(days.length >= 2, 'MARKET_UNAVAILABLE', '本机行情至少需要两个已完成的交易日。');
        if (state) check(Number.isInteger(state.cursor) && state.cursor >= 0 && state.cursor < days.length,
            'SOURCE_CHANGED', '本机行情交易日发生变化；已停止操作，避免账本日期错位。');
        const requested = [...new Set([...(state?.symbols || []), ...extraSymbols])];
        check(requested.length <= 20000, 'SESSION_LIMIT', '模拟账户跟踪证券过多。');
        const bySymbol = new Map();
        for (const symbol of requested) {
            const security = known.get(symbol);
            check(security?.kind === 'stock', 'UNKNOWN_SYMBOL', '本机全市场模拟只支持已接入的股票。');
            const history = await directory.bars(symbol, 20000);
            if (state && !state.symbols.includes(symbol)) check(history.bars.some(bar => bar.date <= days[state.cursor]),
                'UNKNOWN_SYMBOL', '模拟日尚无该证券的行情。');
            const cents = (value, scale) => Math.round(value * 100 / scale);
            bySymbol.set(symbol, { symbol, name: security.name, kind: security.kind,
                bars: history.bars.filter(bar => bar.date <= cutoff).map(bar => ({ date: bar.date,
                    openCents: cents(bar.open, security.scale), highCents: cents(bar.high, security.scale),
                    lowCents: cents(bar.low, security.scale), closeCents: cents(bar.close, security.scale),
                    volume: bar.volume, suspended: bar.volume === 0 })) });
            const prior = state?.marketHistory?.[symbol];
            if (prior) check(hash(bySymbol.get(symbol).bars.filter(bar => bar.date <= prior.asOf)) === prior.fingerprint,
                'SOURCE_CHANGED', '本机行情中的已记账历史发生变化；已停止操作，避免重写交易依据。');
        }
        const m = { dataset: { source: { kind: 'tdx', name: '本机通达信全市场', adjustment: 'none',
            currency: 'CNY', timezone: 'Asia/Shanghai', volumeUnit: 'shares' },
            securities: [...bySymbol.values()] }, days, bySymbol, fingerprint };
        if (state) {
            check(Number.isInteger(state.cursor) && state.cursor >= 0 && state.cursor < days.length
                && state.equity.at(-1).date === days[state.cursor], 'SOURCE_CHANGED',
            '本机行情历史交易日发生变化；已停止操作，避免账本日期错位。');
        }
        return m;
    }
    async sessionMarket(state, extraSymbols = []) {
        if (state.marketDirectory) return this.directoryMarket(state, extraSymbols);
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
    async snapshot(sessionId, extraSymbols = []) {
        const state = await this.store.read(sessionId);
        const m = await this.sessionMarket(state, extraSymbols), asOf = m.days[state.cursor];
        const bars = symbol => m.bySymbol.get(symbol).bars.filter(b => b.date <= asOf).map(b => ({ ...b }));
        return { state, m, asOf, bars };
    }
    async slotCommand(args, signal) {
        // Read the session in its queue, then run the implementation outside it so slow I/O never blocks writes.
        const { state, asOf, bars } = await this.store.serial(args.sessionId,
            () => this.snapshot(args.sessionId, args.command === 'GetAnalysis' && args.symbol ? [args.symbol] : []));
        const session = { sessionId: state.id, symbols: [...state.symbols], dataMode: state.dataMode || 'snapshot',
            revision: state.revision, rulesProfile: state.rulesProfile };
        if (args.command === 'GetAnalysis') {
            check(state.marketDirectory || state.symbols.includes(args.symbol), 'UNKNOWN_SYMBOL', '证券不在本次运行的股票池中。');
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
        if (command === 'CreateTrainingPair') return { trainingPair: await this.createTrainingPair(args) };
        if (command === 'ListBoards') return { boardState: this.boards.list() };
        if (command === 'ChangeBoard') return { boardState: await this.boards.change(args) };
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
            return { universe: { id, datasetId, asOf, groups: id === 'boards'
                ? this.boards.groups(new Set(m.bySymbol.keys())) : await this.universe(id, m, asOf, plainOptions(args.options), signal) } };
        }
        if (command === 'ScreenBoard') {
            check(typeof args.sessionId === 'string', 'INVALID_ARGUMENT', '筛选需要模拟交易标识。');
            const { state, m, asOf } = await this.store.serial(args.sessionId, () => this.snapshot(args.sessionId));
            const available = state.marketDirectory ? (await this.marketDirectory().securitiesAsOf(asOf))
                .filter(security => security.kind === 'stock').map(security => security.symbol) : state.symbols;
            const pool = args.boardId === 'all' ? available : this.boards.groups(new Set(available))
                .find(group => group.id === args.boardId)?.symbols;
            check(Array.isArray(pool), 'INVALID_BOARD', '筛选板块不存在。');
            const id = args.analysis;
            check(['ma', 'ema', 'boll', 'macd', 'kdj', 'rsi'].includes(id), 'INVALID_ARGUMENT', '筛选只支持内置指标。');
            check(typeof args.field === 'string' && ['gt', 'gte', 'lt', 'lte'].includes(args.operator)
                && Number.isFinite(args.value), 'INVALID_ARGUMENT', '筛选条件须包含指标字段、比较符和数值。');
            const offset = state.marketDirectory ? args.offset ?? 0 : 0;
            const limit = state.marketDirectory ? args.limit ?? 200 : Math.max(pool.length, 1);
            check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1
                && limit <= (state.marketDirectory ? 200 : 20000), 'INVALID_ARGUMENT', '筛选分页参数无效。');
            const page = pool.slice(offset, offset + limit);
            const sample = state.marketDirectory ? await this.directoryMarket(state, page) : m;
            const { calculateIndicator } = await import('../frontend/indicators.mjs');
            const matches = page.filter(symbol => {
                const bars = sample.bySymbol.get(symbol)?.bars.filter(bar => bar.date <= asOf) || [];
                const value = calculateIndicator(id, bars, plainOptions(args.options)).at(-1)?.values?.[args.field];
                return typeof value === 'number' && ({ gt: value > args.value, gte: value >= args.value,
                    lt: value < args.value, lte: value <= args.value })[args.operator];
            });
            return { screening: { sessionId: state.id, asOf, boardId: args.boardId, analysis: id,
                field: args.field, operator: args.operator, value: args.value, symbols: matches,
                total: pool.length, offset, nextOffset: offset + page.length, hasMore: offset + page.length < pool.length } };
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
                check(args.marketMode === undefined || args.marketMode === 'directory',
                    'INVALID_ARGUMENT', '未知的模拟行情模式。');
                const directory = args.marketMode === 'directory';
                check(!directory || args.sourceId === undefined && args.datasetId === undefined
                    && args.symbols === undefined && args.universe === undefined && args.group === undefined,
                'INVALID_ARGUMENT', '本机全市场模拟无需预选证券池或同步数据源。');
                check(!directory || args.dataMode === undefined || args.dataMode === 'continuous',
                    'INVALID_ARGUMENT', '本机全市场模拟按连续交易日运行。');
                const datasetId = directory ? 'market-directory' : this.datasetFor(args);
                const m = directory ? await this.directoryMarket() : await this.data(datasetId);
                this.registry.get('execution', engine.defaultProfile(args, m));
                let universe;
                if (!directory && (args.universe !== undefined || args.group !== undefined)) {
                    check(args.symbols === undefined, 'INVALID_ARGUMENT', 'symbols 与 universe/group 只能二选一。');
                    const universeId = args.universe || 'all', asOf = m.days[engine.startIndex(args, m).start];
                    const groups = universeId === 'boards' ? this.boards.groups(new Set(m.bySymbol.keys()))
                        : await this.universe(universeId, m, asOf, {}, signal);
                    check(args.group !== undefined || groups.length === 1, 'INVALID_ARGUMENT', '该股票池有多个分组，请用 group 指定。');
                    const group = groups.find(g => g.id === (args.group ?? groups[0].id));
                    check(group, 'INVALID_ARGUMENT', '股票池中没有该分组。');
                    check(group.symbols.length > 0 && group.symbols.length <= 100, 'INVALID_ARGUMENT', '分组在所选数据源中须有 1 至 100 个证券。');
                    universe = { id: universeId, group: group.id, asOf, symbols: group.symbols };
                }
                const state = engine.create(id, directory ? { ...args, dataMode: 'continuous' } : args, m, datasetId, universe);
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
            const requested = args.command === 'GetSessionQuotes' ? args.symbols : args.symbol ? [args.symbol] : [];
            if (args.command === 'GetSessionQuotes') check(Array.isArray(requested) && requested.length <= 100,
                'INVALID_ARGUMENT', '一次最多读取一百只模拟日行情。');
            const m = await this.sessionMarket(state, requested);
            if (READ_COMMANDS.has(command)) {
                if (command === 'GetSessionSecurities') {
                    check(state.marketDirectory, 'INVALID_SESSION', '固定回放使用创建时的数据集。');
                    const query = String(args.query || '').trim().toLowerCase(), offset = args.offset ?? 0, limit = args.limit ?? 100;
                    check(query.length <= 40 && Number.isSafeInteger(offset) && offset >= 0
                        && Number.isSafeInteger(limit) && limit >= 1 && limit <= 500,
                    'INVALID_ARGUMENT', '证券检索参数无效。');
                    const securities = (await this.marketDirectory().securitiesAsOf(m.days[state.cursor]))
                        .filter(security => security.kind === 'stock' && (!query
                        || [security.symbol, security.code, security.name, security.abbr].some(value => value?.toLowerCase().includes(query))));
                    return { sessionSecurities: { sessionId: state.id, asOf: m.days[state.cursor], total: securities.length,
                        securities: securities.slice(offset, offset + limit) } };
                }
                if (command === 'GetSessionQuotes') {
                    check(state.marketDirectory, 'INVALID_SESSION', '固定回放使用创建时的数据集。');
                    const asOf = m.days[state.cursor];
                    return { sessionQuotes: { sessionId: state.id, asOf, quotes: requested.map(symbol => {
                        const item = m.bySymbol.get(symbol), bars = item.bars.filter(bar => bar.date <= asOf);
                        return { symbol, name: item.name, bars: bars.slice(-30).map(bar => ({ ...bar })),
                            closeCents: bars.at(-1)?.closeCents ?? null, stale: bars.at(-1)?.date !== asOf };
                    }) } };
                }
                if (command === 'GetTrainingResult') return { trainingResult: training.result(state, m) };
                if (command === 'GetRunManifest') return { manifest: engine.manifest(state, m, this.execution(state, false)) };
                if (command === 'GetChart') {
                    check(state.marketDirectory || state.symbols.includes(args.symbol), 'UNKNOWN_SYMBOL', '证券不在本次运行的股票池中。');
                    const limit = args.limit ?? 500;
                    check(Number.isSafeInteger(limit) && limit >= 2 && limit <= 5000,
                        'INVALID_ARGUMENT', '图表日线数量须为 2 至 5000。');
                    const bars = m.bySymbol.get(args.symbol).bars.filter(b => b.date <= m.days[state.cursor]);
                    return { chart: { sessionId: state.id, symbol: args.symbol, revision: state.revision,
                        asOf: m.days[state.cursor], adjustment: 'none', priceUnit: 'cents', volumeUnit: 'shares',
                        bars: bars.slice(-limit).map(b => ({ ...b })), truncated: bars.length > limit } };
                }
                if (command === 'GetMinuteChart') {
                    check(state.marketDirectory || state.symbols.includes(args.symbol), 'UNKNOWN_SYMBOL', '证券不在本次运行的股票池中。');
                    const dailyRef = state.dataSourceId || state.datasetId;
                    return { minuteChart: this.minutes.chart(args.sourceId, args.symbol, { dailyRef,
                        asOf: m.days[state.cursor], period: args.period ?? 1, limit: args.limit ?? 5000 }) };
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
                if (state.marketDirectory) {
                    check(m.bySymbol.get(args.symbol)?.kind === 'stock', 'INVALID_ORDER', '只能模拟买卖股票。');
                }
                const previewState = state.marketDirectory && !state.symbols.includes(args.symbol)
                    ? { ...state, symbols: [...state.symbols, args.symbol] } : state;
                return { preview: engine.intent(previewState, m, args, this.execution(state, true)), observation: this.observe(state, m) };
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
            if (state.marketDirectory && ['SavePlan', 'SubmitOrder', 'PlaceConditional'].includes(command)) {
                check(m.bySymbol.get(args.symbol)?.kind === 'stock', 'INVALID_ORDER', '只能模拟买卖股票。');
                if (!state.symbols.includes(args.symbol)) state.symbols.push(args.symbol);
            }
            if (command === 'SyncSessionData') {
                check(!state.marketDirectory, 'INVALID_SESSION', '本机全市场模拟按需读取已完成日线，无需同步固定证券池。');
                check(state.dataMode === 'continuous', 'FROZEN_RUN', '固定回放不能续接行情，请创建连续模拟。');
                const sourceId = args.sourceId || state.dataSourceId;
                check(sourceId && (!state.dataSourceId || sourceId === state.dataSourceId), 'SOURCE_MISMATCH', '续接必须使用运行绑定的行情来源。');
                const targetId = this.repository.feed(sourceId).datasetId;
                if (args.datasetId !== undefined) check(args.datasetId === targetId, 'STALE_DATA_VERSION', '来源头版本已变化，请重新确认后续接。');
                currentMarket = await this.data(targetId);
                assertExtension(m, currentMarket);
                result = engine.attachData(state, m, currentMarket, targetId, sourceId);
            } else {
                const settles = ['SubmitOrder', 'AdvanceDay', 'PlaceConditional', 'UpdateConditional'].includes(command);
                result = engine.apply(state, m, args, settles ? this.execution(state, true) : null);
            }
            if (state.marketDirectory) {
                const asOf = currentMarket.days[state.cursor];
                for (const symbol of state.symbols) state.marketHistory[symbol] = { asOf,
                    fingerprint: hash(currentMarket.bySymbol.get(symbol).bars.filter(bar => bar.date <= asOf)) };
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
