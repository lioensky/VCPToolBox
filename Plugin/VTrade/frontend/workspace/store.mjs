// One session at a time; panels read the observation and send writes through the same binding rules as the AI tools.
const storage = (() => { try { return window.localStorage; } catch { return null; } })();
export const local = {
    get(key, fallback) { try { const raw = storage?.getItem(key); return raw === null || raw === undefined ? fallback : JSON.parse(raw); } catch { return fallback; } },
    set(key, value) { try { storage?.setItem(key, JSON.stringify(value)); } catch { /* private mode or quota: keep working without it */ } },
};
const access = (() => {
    const fragment = new URLSearchParams(location.hash.slice(1));
    try {
        if (fragment.has('access')) { sessionStorage.setItem('vtrade-access', fragment.get('access')); history.replaceState(null, '', location.pathname + location.search); }
        return sessionStorage.getItem('vtrade-access') || '';
    } catch { return fragment.get('access') || ''; }
})();

// Display names for the built-in execution models; extension models show their registered id.
const RULE_NAMES = { reference: '通用参考记账', 'a-share-demo': 'A 股涨跌停演示' };
export const ruleName = id => RULE_NAMES[id] || id;

// Source settings use their own endpoint, which tool calls cannot reach.
export const adminSettings = input => command(input, 'settings');
export async function command(input, route = 'command') {
    let response;
    try {
        response = await fetch(`../api/${route}`, { method: 'POST', body: JSON.stringify(input), signal: AbortSignal.timeout(60000),
            headers: { 'Content-Type': 'application/json', 'X-VTrade-Request': '1', 'X-VTrade-Access': access } });
    } catch { throw Object.assign(new Error('连接中断，结果尚不确定。刷新后核对再决定是否重试。'), { code: 'NETWORK' }); }
    let result;
    try { result = await response.json(); } catch { throw Object.assign(new Error('服务没有返回可识别的回执。'), { code: 'BAD_RESPONSE' }); }
    if (!response.ok || !result.ok) throw Object.assign(new Error(result.error || '操作失败。'), { code: result.code || 'HTTP_ERROR' });
    return result;
}

// Browsing the local market: the security list once, quotes in chunks so the list fills while a cold directory
// is read, and day bars per security. Like settings, this endpoint is closed to tool calls.
export const marketRequest = input => command(input, 'market');
export class BoardStore extends EventTarget {
    constructor() { super(); this.state = { revision: 0, favorites: [], boards: [] }; this.queue = Promise.resolve(); }
    async load() {
        this.state = (await command({ command: 'ListBoards' })).boardState;
        const favorites = local.get('vtrade-next-favorites', []), boards = local.get('vtrade-next-boards', []);
        if ((favorites.length || boards.length) && !local.get('vtrade-board-migrated', false)) {
            const requestId = local.get('vtrade-board-migration-id', crypto.randomUUID());
            local.set('vtrade-board-migration-id', requestId);
            this.state = (await command({ command: 'ChangeBoard', action: 'importLocal', requestId,
                expectedRevision: this.state.revision, favorites, boards })).boardState;
            local.set('vtrade-board-migrated', true);
            local.set('vtrade-next-favorites', []); local.set('vtrade-next-boards', []);
        }
        this.dispatchEvent(new Event('change'));
        return this.state;
    }
    change(action, extra = {}) {
        const work = async () => {
            try {
                this.state = (await command({ command: 'ChangeBoard', action, ...extra,
                    requestId: crypto.randomUUID(), expectedRevision: this.state.revision })).boardState;
            } catch (error) {
                if (error.code === 'STALE_BOARD') await this.load();
                throw error;
            }
            this.dispatchEvent(new Event('change'));
            return this.state;
        };
        this.queue = this.queue.catch(() => {}).then(work);
        return this.queue;
    }
    has(symbol) { return this.state.favorites.includes(symbol); }
    toggle(symbol) { return this.change('favorites', { symbols: this.has(symbol)
        ? this.state.favorites.filter(value => value !== symbol) : [...this.state.favorites, symbol] }); }
}
export class MarketStore extends EventTarget {
    constructor() {
        super(); this.securities = []; this.bySymbol = new Map(); this.quotes = new Map(); this.quoteVersion = 0;
        this.charts = new Map(); this.status = null; this.error = null; this.ticket = 0;
    }
    emit(type) { this.dispatchEvent(new Event(type)); }
    security(symbol) { return this.bySymbol.get(symbol) || null; }
    async load() {
        try {
            this.status = (await marketRequest({ action: 'status' })).status;
            this.securities = (await marketRequest({ action: 'list' })).securities;
            this.bySymbol = new Map(this.securities.map(s => [s.symbol, s]));
            this.error = null; this.charts.clear();
        } catch (error) { this.error = error; this.securities = []; this.bySymbol = new Map(); }
        this.emit('list');
        if (!this.error) await this.refreshQuotes();
    }
    // Stocks first, then indices and funds; each chunk is shown as it arrives.
    async refreshQuotes() {
        const ticket = ++this.ticket, order = { stock: 0, index: 1, fund: 2 };
        const symbols = [...this.securities].sort((a, b) => order[a.kind] - order[b.kind]).map(s => s.symbol);
        for (let i = 0; i < symbols.length; i += 1000) {
            try {
                const chunk = (await marketRequest({ action: 'quotes', symbols: symbols.slice(i, i + 1000) })).quotes;
                if (ticket !== this.ticket) return;
                for (const q of chunk) this.quotes.set(q.symbol, q);
                this.quoteVersion++; this.emit('quotes');
            } catch (error) { this.error = error; this.emit('list'); return; }
        }
    }
    chart(symbol) {
        const key = `${symbol}:${this.status?.lastDate}`;
        if (!this.charts.has(key)) {
            this.charts.set(key, marketRequest({ action: 'bars', symbol, limit: 5000 }).then(r => r.chart)
                .catch(error => { this.charts.delete(key); throw error; }));
            while (this.charts.size > 40) this.charts.delete(this.charts.keys().next().value);
        }
        return this.charts.get(key);
    }
}

export class Store extends EventTarget {
    constructor() { super(); this.sessions = []; this.observation = null; this.charts = new Map();
        this.sessionQuotes = new Map(); this.sessionQuotePending = new Set();
        this.sessionSecurities = []; this.sessionBySymbol = new Map(); this.busy = false; }
    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
    get sessionId() { return this.observation?.sessionId || null; }
    async loadSessions() {
        this.sessions = (await command({ command: 'ListSessions' })).sessions;
        this.emit('sessions', this.sessions);
        return this.sessions;
    }
    async open(sessionId) {
        this.adopt((await command({ command: 'GetObservation', sessionId })).observation);
        local.set('vtrade-next-session', sessionId);
    }
    clear() { this.observation = null; this.sessionQuotes.clear(); this.sessionQuotePending.clear();
        this.sessionSecurities = []; this.sessionBySymbol.clear();
        this.sessionSecuritiesKey = null; local.set('vtrade-next-session', null); this.emit('observation', null); }
    adopt(observation) {
        if (this.observation?.sessionId !== observation.sessionId || this.observation?.date !== observation.date) {
            this.sessionQuotes.clear(); this.sessionQuotePending.clear();
            this.sessionSecurities = []; this.sessionBySymbol.clear(); this.sessionSecuritiesKey = null;
        }
        this.observation = observation; this.emit('observation', observation);
    }
    quote(symbol) { return this.observation?.quotes.find(q => q.symbol === symbol) || this.sessionQuotes.get(symbol) || null; }
    loadSessionSecurities() {
        const o = this.observation;
        if (!o?.marketDirectory) return Promise.resolve();
        const key = `${o.sessionId}:${o.date}`;
        if (this.sessionSecuritiesKey === key) return Promise.resolve();
        if (this.sessionSecuritiesLoading?.key === key) return this.sessionSecuritiesLoading.promise;
        const promise = (async () => {
            const securities = [];
            for (let offset = 0; ; offset += 500) {
                const page = (await command({ command: 'GetSessionSecurities', sessionId: o.sessionId,
                    offset, limit: 500 })).sessionSecurities;
                if (this.observation?.sessionId !== o.sessionId || this.observation?.date !== page.asOf) return;
                securities.push(...page.securities);
                if (securities.length >= page.total) break;
            }
            this.sessionSecurities = securities; this.sessionBySymbol = new Map(securities.map(security => [security.symbol, security]));
            this.sessionSecuritiesKey = key; this.emit('sessionSecurities', securities);
        })();
        this.sessionSecuritiesLoading = { key, promise };
        void promise.finally(() => { if (this.sessionSecuritiesLoading?.promise === promise) this.sessionSecuritiesLoading = null; }).catch(() => {});
        return promise;
    }
    async loadSessionQuotes(symbols) {
        const o = this.observation;
        if (!o?.marketDirectory) return;
        const missing = [...new Set(symbols)].filter(symbol => symbol && !this.sessionQuotes.has(symbol)
            && !this.sessionQuotePending.has(symbol));
        for (let i = 0; i < missing.length; i += 100) {
            const batch = missing.slice(i, i + 100);
            batch.forEach(symbol => this.sessionQuotePending.add(symbol));
            let quotes;
            try { quotes = (await command({ command: 'GetSessionQuotes', sessionId: o.sessionId,
                symbols: batch })).sessionQuotes; }
            finally { batch.forEach(symbol => this.sessionQuotePending.delete(symbol)); }
            if (this.observation?.sessionId !== o.sessionId || this.observation?.date !== quotes.asOf) return;
            for (const quote of quotes.quotes) this.sessionQuotes.set(quote.symbol, quote);
        }
        if (missing.length) this.emit('sessionQuotes', missing);
    }
    position(symbol) { return this.observation?.account.positions.find(p => p.symbol === symbol) || null; }
    // Writes carry the latest binding; a stale observation is refused by the service and shown to the user.
    async write(name, extra = {}) {
        const o = this.observation;
        const result = await command({ command: name, requestId: crypto.randomUUID(), sessionId: o.sessionId,
            observationId: o.observationId, expectedRevision: o.revision, ...extra });
        if (result.observation) this.adopt(result.observation);
        return result;
    }
    async preview(extra) {
        const o = this.observation;
        return (await command({ command: 'PreviewOrder', sessionId: o.sessionId, observationId: o.observationId, expectedRevision: o.revision, ...extra })).preview;
    }
    async chart(symbol) {
        const o = this.observation, key = `${o.sessionId}:${symbol}:${o.revision}`;
        if (!this.charts.has(key)) {
            this.charts.set(key, command({ command: 'GetChart', sessionId: o.sessionId, symbol, limit: 2000 }).then(r => r.chart)
                .catch(error => { this.charts.delete(key); throw error; }));
            while (this.charts.size > 24) this.charts.delete(this.charts.keys().next().value);
        }
        return this.charts.get(key);
    }
}
