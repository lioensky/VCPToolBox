'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { check, hash, date, validDate, normalizeDataset, completedDate, TradeError } = require('./data.cjs');
const { validSource } = require('./market-repository.cjs');
const { invoke, invokeSync } = require('./slots.cjs');
const { atomicWrite } = require('./store.cjs');

const SECURITY_LINE = /^(?:(sh|sz|bj)\.?)?(\d{6})(?:\s+(\S.{0,39}))?$/i;
// One security per line: a six-digit code with an optional market prefix and name ("600000 示例证券", "sz000000").
// A bare code follows the exchanges' leading digits: 6 and 9 Shanghai, 0, 2 and 3 Shenzhen, 4, 8 and 92 Beijing.
function parseSecurities(text) {
    const lines = String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    check(lines.length > 0 && lines.length <= 100, 'INVALID_SOURCE', '证券列表须有 1 至 100 行。');
    const symbols = new Set();
    return lines.map(line => {
        const match = SECURITY_LINE.exec(line);
        check(match, 'INVALID_SOURCE', `无法识别“${line.slice(0, 40)}”：每行写 6 位代码，可加市场前缀与名称。`);
        const code = match[2];
        const market = match[1]?.toLowerCase() || (/^(?:92|4|8)/.test(code) ? 'bj' : /^[69]/.test(code) ? 'sh' : 'sz');
        const symbol = `${market.toUpperCase()}.${code}`;
        check(!symbols.has(symbol), 'INVALID_SOURCE', `证券 ${symbol} 重复。`);
        symbols.add(symbol);
        return { symbol, name: match[3]?.trim() || code, file: `${market}/lday/${market}${code}.day` };
    });
}

const SLOT_ID = /^[a-z][a-z0-9-]{1,49}$/;
async function stableRead(root, relative, maximum) {
    const base = await fs.realpath(root);
    const file = await fs.realpath(path.join(base, relative));
    const rel = path.relative(base, file);
    check(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'INVALID_SOURCE', '来源文件不在配置的数据目录内。');
    const before = await fs.stat(file, { bigint: true });
    check(before.isFile() && before.size > 0n && before.size <= BigInt(maximum), 'INVALID_DATA', '来源文件为空、不是普通文件或超过读取上限。');
    const bytes = await fs.readFile(file);
    const after = await fs.stat(file, { bigint: true });
    check(before.size === after.size && before.mtimeNs === after.mtimeNs && before.ino === after.ino
        && BigInt(bytes.length) === after.size, 'SOURCE_BUSY', '来源文件正在更新，请稍后重试。');
    return bytes;
}
// Implementations get a reader confined to the administrator's directory, never the directory itself.
const reader = directory => directory ? async (relative, maximum = 8 * 1024 * 1024) => {
    check(typeof relative === 'string' && relative && Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 64 * 1024 * 1024,
        'INVALID_SOURCE', '读取参数无效。');
    try { return await stableRead(directory, relative, maximum); }
    catch (error) {
        check(!['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes(error.code), 'SOURCE_FILE_UNAVAILABLE', '配置的数据文件不可读取，请在本机核对目录与盘后下载。');
        throw error;
    }
} : undefined;
const absolute = directory => directory === undefined || typeof directory === 'string' && path.isAbsolute(directory);
const interval = value => {
    const seconds = value ?? 0;
    check(Number.isInteger(seconds) && (seconds === 0 || seconds >= 60 && seconds <= 86400), 'INVALID_SOURCE', '同步间隔须为 0（手动）或 60 至 86400 秒。');
    return seconds;
};
// Sources come from the administrator's configuration file (read-only here) or from the settings page,
// which keeps its own file in the store. Settings are reachable only through the authenticated page.
class LocalSources {
    constructor(service) {
        this.service = service; this.configs = new Map(); this.origins = new Map(); this.tools = new Map();
        this.timers = new Map(); this.running = new Set(); this.runtimeStatus = new Map(); this.stopped = false;
    }
    get registry() { return this.service.registry; }
    get settingsFile() { return path.join(this.service.store.directory, 'settings', 'sources.json'); }
    async open(file) {
        if (file) this.load(JSON.parse(await fs.readFile(path.resolve(file), 'utf8')), 'file');
        let saved;
        try { saved = JSON.parse(await fs.readFile(this.settingsFile, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (saved) this.load(saved, 'settings');
    }
    load(input, origin) {
        check(input.schemaVersion === 1 && Array.isArray(input.sources) && this.configs.size + input.sources.length <= 20,
            'INVALID_SOURCE', '本机来源配置格式不正确，或来源超过 20 个。');
        for (const config of input.sources) {
            check(validSource(config.id) && !this.configs.has(config.id) && typeof config.kind === 'string' && SLOT_ID.test(config.kind)
                && absolute(config.directory), 'INVALID_SOURCE', '来源标识、类型（market 插槽标识）或绝对数据目录不合法。');
            // Built-in kinds are checked now; a plugin-provided kind may register later and is checked at sync time.
            if (this.registry.has('market', config.kind)) this.validate(config);
            this.configs.set(config.id, { ...config, syncIntervalSeconds: interval(config.syncIntervalSeconds) });
            this.origins.set(config.id, origin);
        }
        if (origin !== 'file') return;
        const tools = input.tools ?? {};
        check(tools && typeof tools === 'object' && !Array.isArray(tools) && Object.keys(tools).length <= 20,
            'INVALID_SOURCE', 'tools 须为以工具标识为键的对象。');
        for (const [id, config] of Object.entries(tools)) {
            check(SLOT_ID.test(id) && config && typeof config === 'object' && !Array.isArray(config) && absolute(config.directory),
                'INVALID_SOURCE', '工具设置须以工具标识为键，directory 须为绝对路径。');
            this.tools.set(id, structuredClone(config));
        }
    }
    validate(config) {
        const provider = this.registry.get('market', config.kind);
        if (provider.validate) invokeSync('market', config.kind, () => provider.validate(structuredClone(config)));
        return provider;
    }
    toolContext(id) {
        const { directory, ...options } = this.tools.get(id) || {};
        return { options: structuredClone(options), readFile: reader(directory) };
    }
    start() { for (const config of this.configs.values()) this.schedule(config); }
    schedule(config) {
        clearInterval(this.timers.get(config.id)); this.timers.delete(config.id);
        if (!config.syncIntervalSeconds || this.stopped) return;
        let active = false;
        const tick = () => {
            if (this.stopped || active || this.configs.get(config.id) !== config) return;
            active = true;
            const task = this.sync(config.id, {
                expectedDataVersion: this.service.repository.feeds.get(config.id)?.datasetId }, { automatic: true }).catch(() => {})
                .finally(() => { active = false; this.running.delete(task); });
            this.running.add(task);
        };
        const timer = setInterval(tick, config.syncIntervalSeconds * 1000); timer.unref(); this.timers.set(config.id, timer);
        tick();
    }
    list() {
        return [...this.configs.values()].map(c => ({ sourceId: c.id, name: c.name || c.id, kind: c.kind,
            syncIntervalSeconds: c.syncIntervalSeconds, origin: this.origins.get(c.id) }));
    }
    // The administrator's view, with directories and security lists. Never returned to tool calls.
    describe() {
        return [...this.configs.values()].map(c => ({ ...structuredClone(c), origin: this.origins.get(c.id),
            synced: this.service.repository.feeds.has(c.id), ...this.runtimeStatus.get(c.id) }));
    }
    // input: { id?, name, directory, securities (one per line), since?, syncIntervalSeconds }. Settings sources are TDX day files.
    async save(input) {
        check(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_SOURCE', '缺少来源设置。');
        const id = input.id || `feed-local-${Date.now().toString(36)}`;
        check(validSource(id), 'INVALID_SOURCE', '来源标识不合法。');
        const existing = this.configs.get(id);
        check(!existing || this.origins.get(id) === 'settings', 'SOURCE_READONLY', '该来源来自管理员的配置文件，请在配置文件中修改。');
        check(existing || this.configs.size < 20, 'INVALID_SOURCE', '本机来源最多 20 个。');
        const directory = String(input.directory ?? '').trim();
        check(path.isAbsolute(directory), 'INVALID_SOURCE', '数据目录须为绝对路径，例如 D:/通达信/vipdoc。');
        check(input.since === undefined || input.since === '' || validDate(input.since), 'INVALID_SOURCE', '最早日期须为 YYYY-MM-DD。');
        const config = { id, name: String(input.name || '本机通达信日线').trim().slice(0, 40), kind: 'tdx', directory,
            syncIntervalSeconds: interval(input.syncIntervalSeconds), securities: parseSecurities(input.securities),
            ...(input.since ? { since: input.since } : {}) };
        this.validate(config);
        // A synced feed keeps its securities and history window; changing them would rewrite earlier versions.
        if (this.service.repository.feeds.has(id)) {
            check(existing && hash([existing.securities, existing.since ?? null]) === hash([config.securities, config.since ?? null]), 'SOURCE_LOCKED',
                '已同步的来源不能更改证券列表或最早日期；请新建来源。');
        }
        await this.writeSettings(sources => [...sources.filter(c => c.id !== id), config], () => {
            this.configs.set(id, config); this.origins.set(id, 'settings');
        });
        this.schedule(config);
        return this.describe().find(c => c.id === id);
    }
    // The file and the in-memory list change together, one write at a time.
    writeSettings(change, apply) {
        return this.service.store.serial('settings', async () => {
            const current = [...this.configs.values()].filter(c => this.origins.get(c.id) === 'settings');
            await fs.mkdir(path.dirname(this.settingsFile), { recursive: true });
            await atomicWrite(this.settingsFile, { schemaVersion: 1, sources: change(current) });
            apply();
        });
    }
    // Removing a source stops its synchronisation; data already synced stays available to runs.
    async remove(id) {
        check(this.configs.has(id) && this.origins.get(id) === 'settings', 'SOURCE_READONLY', '只能删除在设置页面添加的来源。');
        await this.writeSettings(sources => sources.filter(c => c.id !== id), () => { this.configs.delete(id); this.origins.delete(id); });
        clearInterval(this.timers.get(id)); this.timers.delete(id);
    }
    // Counts day files per market and lists the requested securities without a file, so a path can be checked before saving.
    async probe(directory, securities) {
        const root = String(directory ?? '').trim();
        check(path.isAbsolute(root), 'INVALID_SOURCE', '数据目录须为绝对路径。');
        const counts = {};
        for (const market of ['sh', 'sz', 'bj']) {
            try { counts[market] = (await fs.readdir(path.join(root, market, 'lday'))).filter(f => /^(sh|sz|bj)\d{6}\.day$/.test(f)).length; }
            catch { counts[market] = 0; }
        }
        const missing = [];
        const list = securities ? parseSecurities(securities) : [];
        for (const item of list) {
            const found = await fs.stat(path.join(root, item.file)).then(s => s.isFile(), () => false);
            if (!found) missing.push(item.symbol);
        }
        return { counts, securities: list.length, missing };
    }
    sync(id, args, options = {}) {
        const task = this.performSync(id, args, options);
        this.running.add(task);
        void task.finally(() => this.running.delete(task)).catch(() => {});
        return task;
    }
    async performSync(id, args, { automatic = false } = {}) {
        check(!this.stopped && this.configs.has(id), 'SOURCE_UNAVAILABLE', '仅能同步管理员已配置的本机来源标识。');
        const config = this.configs.get(id);
        const invocationFingerprint = hash({ config, expectedDataVersion: args.expectedDataVersion ?? null, completedThrough: args.completedThrough ?? null });
        const prior = this.service.repository.feeds.get(id)?.receipts;
        if (!automatic && prior && Object.hasOwn(prior, args.requestId)) {
            check(prior[args.requestId].invocationFingerprint === invocationFingerprint, 'REQUEST_CONFLICT', '同一同步请求不能更换参数或来源配置。');
            return { ...structuredClone(prior[args.requestId].result), duplicate: true };
        }
        const cutoff = args.completedThrough || completedDate();
        date(cutoff);
        check(cutoff <= completedDate(), 'INCOMPLETE_BAR', '本地同步只接收上海时区保守盘后截止日期以前的数据。');
        try {
            const provider = this.validate(config);
            const { directory, ...visible } = config;
            const loaded = await invoke('market', config.kind, signal => provider.load({ sourceId: id, name: config.name || id,
                config: structuredClone(visible), completedThrough: cutoff, readFile: reader(directory), signal }),
            { timeoutMs: this.service.options.marketTimeoutMs ?? 60000 });
            const data = normalizeDataset(loaded, { minimumBars: 1 });
            for (const item of data.securities) item.bars = item.bars.filter(b => b.date <= cutoff);
            check(data.securities.every(s => s.bars.length > 0), 'DATA_UNAVAILABLE', '配置的证券尚无已确认盘后日线，未合成补数。');
            const requestId = automatic ? 'auto-' + hash({ id, data, cutoff, expectedDataVersion: args.expectedDataVersion }) : args.requestId;
            const result = await this.service.repository.ingest(data, { sourceId: id, requestId,
                expectedDataVersion: args.expectedDataVersion, completedThrough: cutoff, invocationFingerprint, automatic });
            this.runtimeStatus.set(id, { lastAttemptAt: new Date().toISOString(), lastError: null, lastMessage: null });
            return result;
        } catch (error) {
            // Only VTrade's own messages are kept for display; other errors are summarised by their code.
            this.runtimeStatus.set(id, { lastAttemptAt: new Date().toISOString(), lastError: error.code || 'SYNC_FAILED',
                lastMessage: error instanceof TradeError ? error.message : null });
            await this.service.repository.failure(id, error.code || 'SYNC_FAILED');
            throw error;
        }
    }
    async close() { this.stopped = true; this.timers.forEach(clearInterval); this.timers.clear(); await Promise.allSettled([...this.running]); }
}
module.exports = { LocalSources, stableRead, completedDate, parseSecurities };
