'use strict';

const { TradeError, check, validDate } = require('./data.cjs');

const CONTRACT_VERSION = 1;
const ID = /^[a-z][a-z0-9-]{1,49}$/;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fn = (impl, name) => typeof impl[name] === 'function';
// The methods the core calls in each slot. Other fields on an implementation are ignored.
const SLOTS = Object.freeze({
    market: impl => fn(impl, 'load') && (impl.validate === undefined || fn(impl, 'validate')),
    analysis: impl => fn(impl, 'compute') && ['indicator', 'signal'].includes(impl.type),
    universe: impl => fn(impl, 'groups'),
    execution: impl => fn(impl, 'settle') && (impl.reserveCents === undefined || fn(impl, 'reserveCents'))
        && (impl.settleConditional === undefined || fn(impl, 'settleConditional'))
        && (impl.costs === undefined || record(impl.costs) && Object.keys(impl.costs).length <= 10
            && Object.entries(impl.costs).every(([k, v]) => KEY.test(k) && Number.isFinite(v))),
    broker: impl => record(impl.capabilities) && typeof impl.capabilities.live === 'boolean',
    tool: impl => fn(impl, 'run') && (impl.network === undefined || typeof impl.network === 'boolean'),
});
const SIGNAL_ACTIONS = ['buy', 'sell', 'hold', 'watch'];

class SlotRegistry {
    constructor() { this.slots = new Map(Object.keys(SLOTS).map(slot => [slot, new Map()])); }
    register(slot, id, implementation, { builtin = false } = {}) {
        check(Object.hasOwn(SLOTS, slot), 'INVALID_PROVIDER', `未知插槽 ${slot}；可用：${Object.keys(SLOTS).join('、')}。`);
        check(typeof id === 'string' && ID.test(id), 'INVALID_PROVIDER', '实现标识须为 2 至 50 位小写字母、数字或连字符，以字母开头。');
        const parameters = implementation?.parameters;
        check(record(implementation) && (implementation.contractVersion ?? CONTRACT_VERSION) === CONTRACT_VERSION
            && typeof implementation.description === 'string' && implementation.description.trim()
            && implementation.description.length <= 300
            && (parameters === undefined || record(parameters) && Object.keys(parameters).length <= 20
                && Object.entries(parameters).every(([k, v]) => KEY.test(k) && typeof v === 'string' && v.length <= 200))
            && SLOTS[slot](implementation),
        'INVALID_PROVIDER', `${slot} 插槽实现缺少必需方法或说明，或契约版本不是 ${CONTRACT_VERSION}。`);
        const table = this.slots.get(slot);
        check(!table.has(id), 'DUPLICATE_PROVIDER', `${slot} 插槽已注册 ${id}。`);
        const entry = { implementation, builtin };
        table.set(id, entry);
        return () => { if (table.get(id) === entry) table.delete(id); };
    }
    get(slot, id) {
        const entry = this.slots.get(slot)?.get(id);
        check(entry, 'PROVIDER_UNAVAILABLE', `${slot} 插槽没有已注册的实现 ${id}；不会改用其他实现。`);
        return entry.implementation;
    }
    has(slot, id) { return Boolean(this.slots.get(slot)?.has(id)); }
    removeExternal() {
        for (const table of this.slots.values()) for (const [id, entry] of table) if (!entry.builtin) table.delete(id);
    }
    list() {
        return Object.fromEntries([...this.slots].map(([slot, table]) => [slot, [...table].map(([id, { implementation: i, builtin }]) => ({
            id, builtin, description: i.description,
            ...(i.type ? { type: i.type } : {}), ...(i.parameters ? { parameters: { ...i.parameters } } : {}),
            ...(slot === 'execution' && i.costs ? { costs: { ...i.costs } } : {}),
            ...(slot === 'tool' ? { network: i.network === true } : {}),
            ...(slot === 'broker' ? { live: i.capabilities.live } : {}),
        }))]));
    }
}

// Runs one implementation call with a deadline. The implementation receives an AbortSignal for its own I/O.
async function invoke(slot, id, operation, { timeoutMs = 10000, signal } = {}) {
    const controller = new AbortController();
    let timer;
    const stopped = new Promise((_, reject) => {
        const stop = error => { controller.abort(error); reject(error); };
        timer = setTimeout(() => stop(new TradeError('PROVIDER_TIMEOUT', `${slot} 插槽实现 ${id} 超时。`)), timeoutMs);
        if (signal?.aborted) stop(new TradeError('CANCELLED', '调用已被宿主取消。'));
        signal?.addEventListener('abort', () => stop(new TradeError('CANCELLED', '调用已被宿主取消。')), { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), stopped]); }
    catch (error) {
        if (error instanceof TradeError) throw error;
        // Implementations may hold private logic; only the local log sees their raw error.
        console.error(`[VTrade] ${slot}/${id} failed:`, error?.message || error);
        throw new TradeError('PROVIDER_FAILED', `${slot} 插槽实现 ${id} 执行失败，详情见本机服务日志。`);
    } finally { clearTimeout(timer); }
}
// Ledger transactions call execution rules synchronously so a settlement cannot interleave with other I/O.
function invokeSync(slot, id, operation) {
    let result;
    try { result = operation(); }
    catch (error) {
        if (error instanceof TradeError) throw error;
        console.error(`[VTrade] ${slot}/${id} failed:`, error?.message || error);
        throw new TradeError('PROVIDER_FAILED', `${slot} 插槽实现 ${id} 执行失败，详情见本机服务日志。`);
    }
    if (typeof result?.then === 'function') {
        result.then(() => {}, () => {});
        check(false, 'PROVIDER_FAILED', `${slot} 插槽实现 ${id} 须同步返回结果。`);
    }
    return result;
}
const bad = message => { throw new TradeError('PROVIDER_FAILED', message); };
function analysisOutput(type, output, asOf, limit) {
    // Implementations see the whole observed history (one dataset holds at most 50000 bars), so allow that much.
    const key = type === 'indicator' ? 'series' : 'signals', rows = output?.[key];
    if (!Array.isArray(rows) || rows.length > 50000) bad(`分析结果须包含 ${key} 数组，最多 50000 项。`);
    let previous = '';
    const clean = rows.map(row => {
        if (!record(row) || !validDate(row.date)) bad('分析结果的每一项须为带 YYYY-MM-DD 日期的对象。');
        check(row.date <= asOf, 'FUTURE_DATA', '分析结果含模拟日之后的日期，已拒绝。');
        if (type === 'indicator') {
            const values = row.values;
            if (row.date <= previous || !record(values) || Object.keys(values).length > 16
                || !Object.entries(values).every(([k, v]) => KEY.test(k) && (v === null || Number.isFinite(v)))) {
                bad('指标序列须按日期严格递增，values 最多 16 个有限数值或 null。');
            }
            previous = row.date;
            return { date: row.date, values: { ...values } };
        }
        if (row.date < previous || !SIGNAL_ACTIONS.includes(row.action)
            || row.strength !== undefined && !(Number.isFinite(row.strength) && row.strength >= 0 && row.strength <= 1)
            || row.note !== undefined && typeof row.note !== 'string') {
            bad(`信号须按日期排列，action 为 ${SIGNAL_ACTIONS.join('/')}，strength 为 0 至 1，note 为文本。`);
        }
        previous = row.date;
        return { date: row.date, action: row.action, ...(row.strength === undefined ? {} : { strength: row.strength }),
            ...(row.note ? { note: row.note.trim().slice(0, 200) } : {}) };
    });
    return clean.slice(-limit);
}
function universeOutput(output, available) {
    const groups = output?.groups, ids = new Set();
    if (!Array.isArray(groups) || groups.length === 0 || groups.length > 200) bad('股票池结果须包含 1 至 200 个 groups。');
    return groups.map(g => {
        if (!record(g) || typeof g.id !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(g.id) || ids.has(g.id)
            || g.name !== undefined && typeof g.name !== 'string'
            || !Array.isArray(g.symbols) || g.symbols.length > 5000 || !g.symbols.every(s => typeof s === 'string')) {
            bad('每个分组须有唯一 id、可选 name 和证券标识数组（最多 5000）。');
        }
        ids.add(g.id);
        const symbols = [...new Set(g.symbols)].filter(s => available.has(s));
        return { id: g.id, name: (g.name || g.id).trim().slice(0, 60), symbols, missing: new Set(g.symbols).size - symbols.length };
    });
}
function toolOutput(result) {
    let json;
    try { json = JSON.stringify(result); } catch { json = undefined; }
    if (json === undefined || Buffer.byteLength(json) > 64 * 1024) bad('工具结果须可序列化为 JSON，且不超过 64 KB。');
    return JSON.parse(json);
}

module.exports = { CONTRACT_VERSION, SLOTS, SIGNAL_ACTIONS, SlotRegistry, invoke, invokeSync,
    analysisOutput, universeOutput, toolOutput };
