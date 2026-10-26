// One session at a time; panels read the observation and send writes through the same binding rules as the AI tools.
const storage = (() => { try { return window.localStorage; } catch { return null; } })();
export const local = {
    get(key, fallback) { try { const raw = storage?.getItem(key); return raw === null || raw === undefined ? fallback : JSON.parse(raw); } catch { return fallback; } },
    set(key, value) { try { storage?.setItem(key, JSON.stringify(value)); } catch { /* private mode or quota: keep working without it */ } },
};
const access = (() => {
    const fragment = new URLSearchParams(location.hash.slice(1));
    try {
        if (fragment.has('access')) { sessionStorage.setItem('vtrade-access', fragment.get('access')); history.replaceState(null, '', location.pathname); }
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
    constructor() { super(); this.sessions = []; this.observation = null; this.charts = new Map(); this.busy = false; }
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
    adopt(observation) { this.observation = observation; this.emit('observation', observation); }
    quote(symbol) { return this.observation?.quotes.find(q => q.symbol === symbol) || null; }
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
