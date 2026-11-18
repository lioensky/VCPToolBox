'use strict';

const path = require('node:path');
const { TradeService } = require('./core/service.cjs');
const { TradeError } = require('./core/data.cjs');
const { createRegistry } = require('./core/builtins.cjs');
const { CONTRACT_VERSION } = require('./core/slots.cjs');
const { createHandler } = require('./http.cjs');
const { TOOL_COMMANDS } = require('./core/duel.cjs');
// The loader initializes plugins in folder order, so registrations may arrive before initialize().
const registry = createRegistry();
let service = null;
let initializing = null;
let mounted = false;
let adapters = [];

function register(slot, id, implementation) { return registry.register(slot, id, implementation); }
function loadAdapters(list) {
    for (const name of String(list || '').split(',').map(s => s.trim()).filter(Boolean)) {
        if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) throw new Error(`VTrade adapter name is invalid: ${name}`);
        const adapter = require(path.join(__dirname, 'adapters', `${name}.cjs`));
        adapters.push(adapter.register({ register, TradeError, CONTRACT_VERSION }));
    }
}
async function initialize(config = {}) {
    if (service) return;
    if (initializing) return initializing;
    initializing = (async () => {
        const directory = config.VTRADE_DATA_DIR || path.join(__dirname, 'data');
        try {
            loadAdapters(config.VTRADE_ADAPTERS);
            const candidate = new TradeService(directory, { registry, sourcesFile: config.VTRADE_SOURCES_FILE || undefined });
            await candidate.initialize();
            service = candidate;
        } catch (error) { adapters.forEach(dispose => dispose()); adapters = []; throw error; }
    })();
    try { await initializing; } finally { initializing = null; }
}
// Four arguments select the loader's admin-router integration branch.
function registerRoutes(app, adminApiRouter, config, projectBasePath) {
    if (!service) throw new Error('VTrade initialization did not complete.');
    if (mounted) return;
    if (!adminApiRouter || typeof adminApiRouter.use !== 'function') {
        throw new Error('VTrade requires the authenticated admin API router.');
    }
    adminApiRouter.use('/vtrade', createHandler(service, { adminMounted: true }));
    mounted = true;
}
async function processToolCall(args, context = {}) {
    if (!service) throw new Error('VTrade is not initialized.');
    try {
        const normalized = { ...args };
        for (const key of ['expectedRevision', 'quantity', 'limitPriceCents', 'initialCashCents', 'limit', 'offset', 'period',
            'triggerPriceCents', 'trailPercentBps', 'trailAmountCents', 'stopLossCents', 'takeProfitCents', 'value']) {
            if (typeof normalized[key] === 'string' && /^-?\d+(?:\.\d+)?$/.test(normalized[key])) normalized[key] = Number(normalized[key]);
        }
        if (normalized.blind === 'true' || normalized.blind === 'false') normalized.blind = normalized.blind === 'true';
        for (const key of ['symbols', 'options']) {
            if (typeof normalized[key] !== 'string') continue;
            try { normalized[key] = JSON.parse(normalized[key]); }
            catch { throw new TradeError('INVALID_ARGUMENT', `${key} 须为有效 JSON。`); }
        }
        if (TOOL_COMMANDS.has(normalized.command)) {
            return { status: 'success', result: { content: [{ type: 'text', text: (await service.duelTool(normalized)).text }] } };
        }
        return { status: 'success', result: { content: [
            { type: 'text', text: JSON.stringify({ ok: true, ...await (
                ['GetMarketSecurities', 'GetMarketQuotes', 'GetMarketBars'].includes(normalized.command)
                    ? service.marketTool(normalized) : service.command(normalized, { signal: context.signal })) }) },
        ] } };
    } catch (error) {
        if (!(error instanceof TradeError)) throw error;
        return { status: 'error', code: error.code, error: error.message, result: { content: [
            { type: 'text', text: JSON.stringify({ ok: false, code: error.code, error: error.message }) },
        ] } };
    }
}
async function shutdown() {
    if (initializing) await initializing.catch(() => {});
    if (service) await service.close();
    service = null; mounted = false;
    // Every plugin is re-initialized after a reload, so extensions register again; nothing outlives VTrade.
    adapters = [];
    registry.removeExternal();
}
module.exports = { initialize, registerRoutes, processToolCall, register, shutdown, TradeError, CONTRACT_VERSION };
