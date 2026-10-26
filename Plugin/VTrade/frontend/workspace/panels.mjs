import VCPUI from '../vendor/vcp-ui/vcp-ui.js';
import { CandleChart } from '../candle-chart.mjs';
import { Chart, palette } from '../chart-engine.mjs';
import { formatVolume } from '../chart-scale.mjs';
import { local } from './store.mjs';
import { dataGuide } from './notice.mjs';
import { promptText, openMenu } from './dock.mjs';

// Each panel kind: create(ctx) -> { element, update(), shown?(), dispose() }.
// ctx: { store, market, mode(), panel, symbol(), select(symbol), save(), notify(message, variant), openSimulation() }
// mode() is 'market' (browsing the local market) or 'run' (inside a simulation).
const h = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
};
const yuan = cents => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = cents => (cents > 0 ? '+' : '') + yuan(cents);
const pct = value => value === null || value === undefined ? '—' : (value > 0 ? '+' : '') + (value * 100).toFixed(2) + '%';
const price = (units, scale = 100) => units === null || units === undefined ? '—' : (units / scale).toFixed(scale === 1000 ? 3 : 2);
const tone = (a, b) => a === null || a === undefined || b === null || b === undefined ? '' : a > b ? 'up' : a < b ? 'down' : '';
const STATUS = { pending: '待结算', filled: '虚拟成交', unfilled: '未完成', cancelled: '已撤销' };
const EVENTS = { plan: '计划', intent: '意图', 'virtual-fill': '虚拟成交', unfilled: '未完成', cancelled: '撤销', day: '推进',
    paused: '暂停', resumed: '恢复', review: '复盘', 'data-attached': '接收行情' };
function controls(list) {
    return { add(c) { list.push(c); return c; }, destroy() { list.forEach(c => c.destroy()); list.length = 0; } };
}
// TableFrame renders text cells; tones are added afterwards so up/down colors come from VCPUI tokens.
function table(owner, columns, empty) {
    const control = owner.add(VCPUI.create('TableFrame', { columns, rows: [], empty }));
    return {
        element: control.element,
        update(rows, onRow) {
            control.update({ rows });
            control.element.querySelectorAll('tbody tr').forEach((tr, i) => {
                columns.forEach((column, j) => { if (column.tone) tr.cells[j].dataset.tone = column.tone(rows[i]) || ''; });
                if (onRow) { tr.dataset.clickable = 'true'; tr.onclick = () => onRow(rows[i]); }
            });
        },
    };
}
function bar(...children) { const element = h('div', 'panel-bar'); element.append(...children.filter(Boolean)); return element; }
function emptyState(owned, options, label, onClick) {
    const button = owned.add(VCPUI.create('Button', { label, variant: 'secondary', size: 'sm' }));
    button.element.addEventListener('click', onClick);
    return owned.add(VCPUI.create('EmptyState', { ...options, actions: [button] })).element;
}

// One row shape for both modes. Prices are integers in 1/scale yuan.
function marketRow(security, q) {
    const close = q?.close ?? null, previous = q?.previousClose ?? null;
    return { symbol: security.symbol, code: security.code, name: security.name, abbr: security.abbr, scale: security.scale,
        kind: security.kind, price: close, prev: previous, open: q?.open ?? null, high: q?.high ?? null, low: q?.low ?? null,
        volume: q?.volume ?? null, amount: q?.amount ?? null, date: q?.date ?? null,
        change: close && previous ? (close - previous) / previous : null, delta: close && previous ? close - previous : null,
        amplitude: q && previous ? (q.high - q.low) / previous : null };
}
function runRow(q) {
    const [previous, last] = q.bars.length > 1 ? q.bars.slice(-2) : [null, q.bars.at(-1)];
    return marketRow({ symbol: q.symbol, code: q.symbol.split('.').pop(), name: q.name, abbr: '', scale: 100, kind: 'stock' },
        last ? { close: last.closeCents, previousClose: previous?.closeCents ?? null, open: last.openCents, high: last.highCents,
            low: last.lowCents, volume: last.volume, amount: null, date: last.date } : null);
}
// Matching as in the trading workbench: exact code, name or abbreviation first, then prefixes, then substrings.
export function rank(row, query) {
    const q = query.trim().toLowerCase(), code = row.code.toLowerCase(), symbol = row.symbol.toLowerCase();
    const name = row.name.toLowerCase(), abbr = (row.abbr || '').toLowerCase();
    if ([code, symbol, name, abbr].includes(q)) return 0;
    if (code.startsWith(q) || symbol.startsWith(q)) return 1;
    if (name.startsWith(q)) return 2;
    if (abbr && abbr.startsWith(q)) return 3;
    return [code, name, abbr].some(v => v && v.includes(q)) ? 4 : 99;
}
const favorites = {
    list: () => local.get('vtrade-next-favorites', []),
    has: symbol => favorites.list().includes(symbol),
    toggle(symbol) {
        const list = favorites.list();
        local.set('vtrade-next-favorites', list.includes(symbol) ? list.filter(s => s !== symbol) : [...list, symbol]);
        return !list.includes(symbol);
    },
};
const boards = () => local.get('vtrade-next-boards', []);
const MARKET_BOARDS = [
    { id: 'favorites', label: '自选' }, { id: 'a', label: 'A股', test: s => s.kind === 'stock' },
    { id: 'chinext', label: '创业板', test: s => s.board === 'chinext' }, { id: 'star', label: '科创板', test: s => s.board === 'star' },
    { id: 'bse', label: '北交所', test: s => s.board === 'bse' }, { id: 'index', label: '指数', test: s => s.kind === 'index' },
    { id: 'fund', label: '基金', test: s => s.kind === 'fund' },
];
const RUN_BOARDS = [{ id: 'all', label: '全部' }, { id: 'held', label: '持仓' }, { id: 'planned', label: '计划' }, { id: 'favorites', label: '自选' }];
const COLUMNS = [
    { key: 'code', label: '代码', width: 58, text: r => r.code },
    { key: 'name', label: '名称', width: 76, text: r => r.name, sort: 'text' },
    { key: 'price', label: '现价', width: 60, text: r => price(r.price, r.scale), tone: r => tone(r.price, r.prev) },
    { key: 'change', label: '涨跌幅', width: 62, text: r => pct(r.change), tone: r => tone(r.price, r.prev) },
    { key: 'delta', label: '涨跌', width: 56, text: r => r.delta === null ? '—' : (r.delta > 0 ? '+' : '') + price(r.delta, r.scale), tone: r => tone(r.price, r.prev) },
    { key: 'amount', label: '成交额', width: 64, text: r => r.amount === null ? '—' : formatVolume(r.amount) },
    { key: 'volume', label: '成交量', width: 64, text: r => r.volume === null ? '—' : formatVolume(r.volume) },
    { key: 'amplitude', label: '振幅', width: 54, text: r => r.amplitude === null ? '—' : (r.amplitude * 100).toFixed(2) + '%' },
    { key: 'high', label: '最高', width: 58, text: r => price(r.high, r.scale), tone: r => tone(r.high, r.prev) },
    { key: 'low', label: '最低', width: 58, text: r => price(r.low, r.scale), tone: r => tone(r.low, r.prev) },
    { key: 'open', label: '今开', width: 58, text: r => price(r.open, r.scale), tone: r => tone(r.open, r.prev) },
    { key: 'prev', label: '昨收', width: 58, text: r => price(r.prev, r.scale) },
];
const ROW = 26;

// The market list: dense, sortable, virtualised rows; search across every security by code, name or pinyin initials.
function watchlistPanel(ctx) {
    const owned = controls([]);
    const market = ctx.mode() === 'market';
    const element = h('div', 'panel panel-watchlist mk');
    const head = h('div', 'mk-head'), title = h('strong', 'mk-title'), count = h('small', 'mk-count muted');
    const search = owned.add(VCPUI.create('Input', { placeholder: '代码 / 名称 / 拼音首字母', size: 'sm', type: 'search' }));
    search.element.classList.add('mk-search');
    const star = owned.add(VCPUI.create('IconButton', { icon: 'check_circle', label: '加入自选', size: 'sm' }));
    head.append(title, count, search.element, star.element);
    const scroller = h('div', 'mk-table'), header = h('div', 'mk-header'), body = h('div', 'mk-body'), rowsHost = h('div', 'mk-rows');
    scroller.tabIndex = 0;
    body.append(rowsHost); scroller.append(header, body);
    const state = h('div', 'mk-state');
    const tabs = h('div', 'mk-tabs');
    element.append(head, scroller, state, tabs);
    const cols = COLUMNS.map(c => `${c.width}px`).join(' ');
    element.style.setProperty('--mk-cols', cols);
    let rows = [], sorted = [], query = '', rowsKey = '';
    const sort = () => ctx.panel.state.sort || null;
    for (const column of COLUMNS) {
        const button = h('button', 'mk-col', column.label);
        button.type = 'button'; button.dataset.key = column.key;
        if (column.key !== 'code' && column.key !== 'name') button.dataset.num = 'true';
        button.addEventListener('click', () => {
            const current = sort();
            ctx.panel.state.sort = current?.key !== column.key ? { key: column.key, dir: column.sort === 'text' ? 'asc' : 'desc' }
                : current.dir === 'desc' ? { key: column.key, dir: 'asc' } : null;
            ctx.save(); arrange(); paint();
        });
        header.append(button);
    }
    const board = () => ctx.panel.state[market ? 'marketBoard' : 'board'] || (market ? 'a' : 'all');
    function renderTabs() {
        const items = [...(market ? MARKET_BOARDS : RUN_BOARDS), ...boards().map(b => ({ id: b.id, label: b.name }))];
        tabs.replaceChildren(...items.map(item => {
            const button = h('button', 'mk-tab', item.label);
            button.type = 'button'; button.setAttribute('aria-pressed', String(item.id === board()));
            button.addEventListener('click', () => { ctx.panel.state[market ? 'marketBoard' : 'board'] = item.id; ctx.save(); clearSearch(); update(); });
            button.addEventListener('contextmenu', event => {
                const custom = boards().find(b => b.id === item.id);
                if (!custom) return;
                event.preventDefault();
                openMenu(button, [{ label: '重命名板块', icon: 'edit', onClick: async () => {
                    const name = await promptText({ title: '重命名板块', label: '板块名称', value: custom.name });
                    if (name) { local.set('vtrade-next-boards', boards().map(b => b.id === custom.id ? { ...b, name } : b)); update(); }
                } }, { label: '删除板块', icon: 'delete', onClick: () => {
                    local.set('vtrade-next-boards', boards().filter(b => b.id !== custom.id)); update();
                } }]);
            });
            return button;
        }));
        const add = h('button', 'mk-tab mk-tab-add', '+ 板块'); add.type = 'button';
        add.addEventListener('click', async () => {
            const name = await promptText({ title: '新建板块', label: '板块名称', placeholder: '例如：观察池', confirmLabel: '新建' });
            if (!name) return;
            const id = 'board-' + Date.now().toString(36);
            local.set('vtrade-next-boards', [...boards(), { id, name, symbols: [] }]);
            ctx.panel.state[market ? 'marketBoard' : 'board'] = id; ctx.save(); update();
        });
        tabs.append(add);
    }
    // Rows for the current board or search, before sorting.
    function collect() {
        const id = board(), custom = boards().find(b => b.id === id);
        if (market) {
            const list = ctx.market.securities;
            const pick = s => custom ? custom.symbols.includes(s.symbol) : id === 'favorites' ? favorites.has(s.symbol)
                : (MARKET_BOARDS.find(b => b.id === id)?.test || (() => true))(s);
            if (query) {
                return list.map(s => [s, rank(s, query)]).filter(([, r]) => r < 99).sort((a, b) => a[1] - b[1] || (a[0].symbol < b[0].symbol ? -1 : 1))
                    .slice(0, 300).map(([s]) => marketRow(s, ctx.market.quotes.get(s.symbol)));
            }
            const chosen = id === 'favorites' || custom ? (custom ? custom.symbols : favorites.list()).map(s => ctx.market.security(s)).filter(Boolean)
                : list.filter(pick);
            return chosen.map(s => marketRow(s, ctx.market.quotes.get(s.symbol)));
        }
        const o = ctx.store.observation;
        if (!o) return [];
        const held = new Set(o.account.positions.map(p => p.symbol)), planned = new Set(o.plans.map(p => p.symbol));
        const all = o.quotes.map(runRow);
        if (query) return all.map(r => [r, rank(r, query)]).filter(([, r]) => r < 99).sort((a, b) => a[1] - b[1]).map(([r]) => r);
        return all.filter(r => id === 'all' || id === 'held' && held.has(r.symbol) || id === 'planned' && planned.has(r.symbol)
            || id === 'favorites' && favorites.has(r.symbol) || custom?.symbols.includes(r.symbol));
    }
    function arrange() {
        const s = sort();
        sorted = !s || query ? rows : [...rows].sort((a, b) => {
            const av = a[s.key], bv = b[s.key];
            if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
            if (bv === null || bv === undefined) return -1;
            const order = typeof av === 'string' ? av.localeCompare(bv, 'zh-CN') : av - bv;
            return s.dir === 'desc' ? -order : order;
        });
        header.querySelectorAll('.mk-col').forEach(b => { b.dataset.sort = s?.key === b.dataset.key && !query ? s.dir : ''; });
        body.style.height = `${sorted.length * ROW}px`;
    }
    // Only the rows in view are in the DOM, so a board of several thousand securities scrolls smoothly.
    function paint() {
        const first = Math.max(0, Math.floor(scroller.scrollTop / ROW) - 6);
        const last = Math.min(sorted.length, first + Math.ceil((scroller.clientHeight || 600) / ROW) + 12);
        const current = ctx.symbol();
        rowsHost.style.transform = `translateY(${first * ROW}px)`;
        rowsHost.replaceChildren(...sorted.slice(first, last).map(row => {
            const line = h('div', 'mk-row');
            line.dataset.symbol = row.symbol;
            if (row.symbol === current) line.dataset.selected = 'true';
            for (const column of COLUMNS) {
                const cell = h('span', column.key === 'code' || column.key === 'name' ? 'mk-cell' : 'mk-cell mk-num', column.text(row));
                const t = column.tone?.(row); if (t) cell.dataset.tone = t;
                line.append(cell);
            }
            return line;
        }));
    }
    function locate(symbol) {
        const index = sorted.findIndex(r => r.symbol === symbol);
        if (index < 0) return;
        const top = index * ROW, bottom = top + ROW + header.offsetHeight;
        if (top < scroller.scrollTop) scroller.scrollTop = top;
        else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
    }
    function move(step) {
        if (!sorted.length) return;
        const index = sorted.findIndex(r => r.symbol === ctx.symbol());
        const next = sorted[Math.max(0, Math.min(sorted.length - 1, (index < 0 ? -1 : index) + step))];
        ctx.select(next.symbol); locate(next.symbol); paint();
    }
    scroller.addEventListener('scroll', () => requestAnimationFrame(paint));
    rowsHost.addEventListener('click', event => {
        const row = event.target.closest('.mk-row');
        if (row) { ctx.select(row.dataset.symbol); scroller.focus({ preventScroll: true }); }
    });
    rowsHost.addEventListener('contextmenu', event => {
        const row = event.target.closest('.mk-row');
        if (!row) return;
        event.preventDefault();
        const symbol = row.dataset.symbol, custom = boards().find(b => b.id === board());
        openMenu(row, [
            { label: favorites.has(symbol) ? '移出自选' : '加入自选', icon: 'check_circle', onClick: () => { favorites.toggle(symbol); update(); } },
            ...boards().map(b => ({ label: b.symbols.includes(symbol) ? `移出“${b.name}”` : `加入“${b.name}”`, icon: 'layers', onClick: () => {
                local.set('vtrade-next-boards', boards().map(x => x.id !== b.id ? x : { ...x,
                    symbols: x.symbols.includes(symbol) ? x.symbols.filter(s => s !== symbol) : [...x.symbols, symbol] }));
                update();
            } })),
            ...(custom ? [] : [{ label: '新建板块并加入', icon: 'add', onClick: async () => {
                const name = await promptText({ title: '新建板块', label: '板块名称', confirmLabel: '新建' });
                if (name) { local.set('vtrade-next-boards', [...boards(), { id: 'board-' + Date.now().toString(36), name, symbols: [symbol] }]); update(); }
            } }]),
        ]);
    });
    scroller.addEventListener('keydown', event => {
        const steps = { ArrowDown: 1, ArrowUp: -1, PageDown: 20, PageUp: -20, End: 1e6, Home: -1e6 };
        if (steps[event.key]) { event.preventDefault(); move(steps[event.key]); }
    });
    const input = () => search.element.querySelector('input') || search.element;
    function clearSearch() { query = ''; input().value = ''; }
    input().addEventListener('input', () => { query = input().value.trim(); scroller.scrollTop = 0; update(); });
    input().addEventListener('keydown', event => {
        if (event.key === 'Enter' && sorted[0]) { event.preventDefault(); ctx.select(sorted[0].symbol); clearSearch(); update(); locate(ctx.symbol()); scroller.focus(); }
        else if (event.key === 'Escape') { event.preventDefault(); clearSearch(); update(); scroller.focus(); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); scroller.focus(); move(1); }
    });
    star.element.addEventListener('click', () => {
        const symbol = ctx.symbol();
        if (!symbol) return;
        const added = favorites.toggle(symbol);
        ctx.notify(added ? '已加入自选。' : '已移出自选。'); update();
    });
    function update() {
        renderTabs();
        const items = [...(market ? MARKET_BOARDS : RUN_BOARDS), ...boards().map(b => ({ id: b.id, label: b.name }))];
        title.textContent = query ? '搜索结果' : items.find(i => i.id === board())?.label || '';
        const error = market ? ctx.market.error?.message || '' : '';
        if (error !== state.dataset.error) {
            state.dataset.error = error;
            state.replaceChildren(...(error ? [emptyState(owned, { icon: 'database', title: '尚未读取到本机行情', description: error },
                '打开数据设置', () => ctx.openSettings('data'))] : []));
        }
        state.querySelector('.mk-empty')?.remove();
        const key = `${board()}|${query}|${market ? ctx.market.securities.length + ':' + ctx.market.quoteVersion : ctx.store.observation?.revision}`;
        if (key !== rowsKey) { rows = collect(); rowsKey = key; arrange(); }
        count.textContent = `${sorted.length} 只`;
        star.update({ active: favorites.has(ctx.symbol()), label: favorites.has(ctx.symbol()) ? '移出自选' : '加入自选' });
        if (!sorted.length && !error) {
            state.append(h('p', 'mk-empty muted', query ? '没有匹配的证券。' : board() === 'favorites' ? '自选为空。在列表中右键证券，或点击上方按钮加入自选。'
                : boards().some(b => b.id === board()) ? '此板块暂无证券。在列表中右键证券即可加入。' : market ? '正在读取本机行情。' : '尚未打开模拟交易。'));
        }
        paint();
    }
    return { element, update, focusSearch(text) { input().focus(); if (text) { input().value = text; query = text; update(); } },
        shown: () => { locate(ctx.symbol()); paint(); }, dispose: () => owned.destroy() };
}

function chartPanel(ctx) {
    const owned = controls([]);
    const market = ctx.mode() === 'market';
    const element = h('div', 'panel panel-chart');
    const title = h('div', 'chart-title'), name = h('strong'), code = h('span', 'muted'), readout = h('span', 'chart-readout');
    const volume = h('span', 'muted chart-volume'), ma = h('span', 'chart-ma');
    title.append(name, code, readout);
    const period = owned.add(VCPUI.create('SegmentedControl', { items: [['day', '日'], ['week', '周'], ['month', '月'], ['quarter', '季'], ['year', '年']]
        .map(([value, label]) => ({ value, label })), value: ctx.panel.state.period || 'day', size: 'sm', label: 'K 线周期' }));
    const toggles = [['show_chart', '均线', 'ma'], ...(market ? [] : [['receipt', '买卖点', 'marks'], ['account_balance_wallet', '持仓成本线', 'cost']])]
        .map(([icon, label, key]) => {
            const button = owned.add(VCPUI.create('IconButton', { icon, label, size: 'sm', active: true }));
            button.element.addEventListener('click', () => button.update({ active: candles.toggle(key) }));
            return button.element;
        });
    const reset = owned.add(VCPUI.create('IconButton', { icon: 'restart_alt', label: '复位视图', size: 'sm' }));
    reset.element.addEventListener('click', () => candles.reset());
    const tools = h('div', 'panel-tools'); tools.append(period.element, ...toggles, reset.element);
    const host = h('div', 'chart-host'), empty = h('div', 'chart-empty', '请选择证券'), caption = h('div', 'chart-caption muted');
    const legend = h('div', 'chart-legend'); legend.append(ma, volume);
    host.tabIndex = 0;
    element.append(bar(title, tools), legend, host, empty, caption);
    const candles = new CandleChart(host, readout, caption, empty, group => {
        ctx.notify(group.map(o => `${o.date} ${o.side === 'buy' ? '买' : '卖'} ${o.quantity} 股 @ ${yuan(o.priceCents)}`).join('；'));
    }, message => ctx.notify(message), { volumeReadout: volume, maReadout: ma, headroom: 0.08 });
    candles.period = ctx.panel.state.period || 'day';
    period.element.addEventListener('change', () => {
        const value = period.element.querySelector('[aria-checked="true"]')?.dataset.value || 'day';
        ctx.panel.state.period = value; ctx.save(); candles.setPeriod(value);
    });
    let ticket = 0;
    async function update() {
        const symbol = ctx.symbol(), mine = ++ticket;
        if (market) {
            const security = ctx.market.security(symbol);
            name.textContent = security?.name || '—'; code.textContent = symbol || '';
            if (!security) { empty.hidden = false; return; }
            try {
                const chart = await ctx.market.chart(symbol);
                if (mine !== ticket) return;
                candles.update({ symbol, name: security.name, chartSessionId: 'market', chartTruncated: chart.truncated, priceScale: chart.scale,
                    bars: chart.bars.map(b => ({ date: b.date, openCents: b.open, highCents: b.high, lowCents: b.low, closeCents: b.close,
                        volume: b.volume, amount: b.amount })) }, [], null, chart.bars.at(-1)?.date || '');
            } catch (error) { if (mine === ticket) ctx.notify(error.message, 'danger'); }
            return;
        }
        const o = ctx.store.observation, quote = ctx.store.quote(symbol);
        name.textContent = quote?.name || '—'; code.textContent = symbol || '';
        if (!o || !quote) { empty.hidden = false; return; }
        try {
            const chart = await ctx.store.chart(symbol);
            if (mine !== ticket) return;
            candles.update({ ...quote, bars: chart.bars, chartSessionId: o.sessionId, chartTruncated: chart.truncated },
                o.orders, ctx.store.position(symbol), o.date);
        } catch (error) { if (mine === ticket) ctx.notify(error.message, 'danger'); }
    }
    return { element, update, shown: () => candles.chart && candles.reset(), dispose() { candles.destroy(); owned.destroy(); } };
}

// Quote and range statistics for the selected security, from the same bars the chart uses.
function quotePanel(ctx) {
    const owned = controls([]);
    const market = ctx.mode() === 'market';
    const element = h('div', 'panel panel-quote');
    const head = h('div', 'qt-head'), name = h('strong', 'qt-name'), code = h('span', 'muted qt-code');
    const last = h('div', 'qt-price'), move = h('div', 'qt-move');
    const star = owned.add(VCPUI.create('IconButton', { icon: 'check_circle', label: '加入自选', size: 'sm' }));
    head.append(name, code, star.element);
    const grid = h('div', 'qt-grid'), stats = h('div', 'qt-grid qt-stats');
    element.append(head, last, move, grid, h('div', 'qt-rule'), stats);
    star.element.addEventListener('click', () => {
        const symbol = ctx.symbol();
        if (symbol) { ctx.notify(favorites.toggle(symbol) ? '已加入自选。' : '已移出自选。'); ctx.refresh(); }
    });
    const cell = (label, value, t = '') => { const c = h('div', 'qt-cell'); const v = h('strong', '', value); if (t) v.dataset.tone = t; c.append(h('span', 'muted', label), v); return c; };
    let ticket = 0;
    async function update() {
        const symbol = ctx.symbol(), mine = ++ticket;
        star.update({ active: favorites.has(symbol), label: favorites.has(symbol) ? '移出自选' : '加入自选' });
        let bars, scale = 100, security;
        try {
            if (market) {
                security = ctx.market.security(symbol);
                if (!security) { name.textContent = '未选择证券'; return; }
                const chart = await ctx.market.chart(symbol); bars = chart.bars; scale = chart.scale;
            } else {
                const quote = ctx.store.quote(symbol);
                if (!quote || !ctx.store.observation) { name.textContent = '未选择证券'; return; }
                security = { name: quote.name, symbol };
                bars = (await ctx.store.chart(symbol)).bars.map(b => ({ date: b.date, open: b.openCents, high: b.highCents, low: b.lowCents,
                    close: b.closeCents, volume: b.volume, amount: null }));
            }
        } catch (error) { if (mine === ticket) ctx.notify(error.message, 'danger'); return; }
        if (mine !== ticket || !bars.length) return;
        const b = bars.at(-1), prev = bars.at(-2)?.close ?? null;
        name.textContent = security.name; code.textContent = `${symbol} · ${b.date}`;
        last.textContent = price(b.close, scale); last.dataset.tone = tone(b.close, prev);
        move.textContent = prev ? `${b.close - prev > 0 ? '+' : ''}${price(b.close - prev, scale)}  ${pct((b.close - prev) / prev)}` : '';
        move.dataset.tone = tone(b.close, prev);
        grid.replaceChildren(cell('今开', price(b.open, scale), tone(b.open, prev)), cell('最高', price(b.high, scale), tone(b.high, prev)),
            cell('最低', price(b.low, scale), tone(b.low, prev)), cell('昨收', price(prev, scale)),
            cell('成交量', formatVolume(b.volume)), cell('成交额', b.amount ? formatVolume(b.amount) : '—'),
            cell('振幅', prev ? ((b.high - b.low) / prev * 100).toFixed(2) + '%' : '—'), cell('交易日', String(bars.length)));
        const back = n => bars.length > n ? (b.close - bars.at(-1 - n).close) / bars.at(-1 - n).close : null;
        const year = bars.filter(x => x.date.slice(0, 4) === b.date.slice(0, 4));
        const ytdBase = bars[bars.length - year.length - 1]?.close ?? year[0]?.open;
        const window = bars.slice(-250);
        const high = Math.max(...window.map(x => x.high)), low = Math.min(...window.map(x => x.low));
        stats.replaceChildren(...[['5 日', back(5)], ['20 日', back(20)], ['60 日', back(60)], ['年初至今', ytdBase ? (b.close - ytdBase) / ytdBase : null]]
            .map(([label, value]) => cell(label, pct(value), value > 0 ? 'up' : value < 0 ? 'down' : '')),
        cell('250 日最高', price(high, scale)), cell('250 日最低', price(low, scale)),
        cell('距最高', pct((b.close - high) / high), 'down'), cell('距最低', pct((b.close - low) / low), 'up'));
    }
    return { element, update, dispose: () => owned.destroy() };
}

function orderPanel(ctx) {
    const owned = controls([]);
    const element = h('div', 'panel panel-order');
    const head = h('div', 'order-head'), name = h('strong'), last = h('span', 'order-price');
    head.append(name, last);
    const side = owned.add(VCPUI.create('SegmentedControl', { items: [{ value: 'buy', label: '模拟买入' }, { value: 'sell', label: '模拟卖出' }],
        value: ctx.panel.state.side || 'buy', label: '方向' }));
    const input = (label, options, helper) => {
        const control = owned.add(VCPUI.create('Input', { size: 'sm', ...options }));
        return { control, field: owned.add(VCPUI.create('Field', { label, control, helper })) };
    };
    const quantity = input('数量（股）', { type: 'number', value: String(ctx.prefs?.get().quantity || 100) }, '须为 100 的整数倍');
    const limit = input('限价（元）', { type: 'number', placeholder: '选填' }, '留空则按次日开盘参考价');
    const stop = input('止损价（元）', { type: 'number', placeholder: '—', disabled: true }, 'D2 接入');
    const take = input('止盈价（元）', { type: 'number', placeholder: '—', disabled: true }, 'D2 接入');
    const grid = h('div', 'order-grid');
    grid.append(quantity.field.element, limit.field.element, stop.field.element, take.field.element);
    const preview = owned.add(VCPUI.create('Button', { label: '预览', variant: 'secondary', size: 'sm' }));
    const submit = owned.add(VCPUI.create('Button', { label: '记录模拟意图', variant: 'primary', size: 'sm' }));
    const actions = h('div', 'order-actions'); actions.append(preview.element, submit.element);
    const result = h('div', 'order-result');
    const account = h('div', 'order-account');
    element.append(head, side.element, grid, actions, result, account);
    side.element.addEventListener('change', () => {
        ctx.panel.state.side = side.element.querySelector('[aria-checked="true"]')?.dataset.value || 'buy'; ctx.save();
    });
    const value = control => (control.element.querySelector?.('input') || control.element).value.trim();
    function args() {
        const q = Number(value(quantity.control)), l = value(limit.control);
        if (!Number.isSafeInteger(q) || q < 100 || q % 100) throw new Error('数量须为 100 的整数倍。');
        if (l && !/^\d+(\.\d{1,2})?$/.test(l)) throw new Error('限价最多保留两位小数。');
        return { symbol: ctx.symbol(), side: ctx.panel.state.side || 'buy', quantity: q,
            ...(l ? { limitPriceCents: Math.round(Number(l) * 100) } : {}) };
    }
    const show = (variant, title, message) => {
        result.replaceChildren(owned.add(VCPUI.create('Alert', { variant, title, message, dismissible: true })).element);
    };
    preview.element.addEventListener('click', async () => {
        try { const p = await ctx.store.preview(args());
            show('info', '预览', `${p.side === 'buy' ? '买入' : '卖出'} ${p.quantity} 股；预留 ${yuan(p.reservedCents)} 元。${p.settlement}`);
        } catch (error) { show('danger', '无法记录', error.message); }
    });
    submit.element.addEventListener('click', async () => {
        let order;
        try { order = args(); } catch (error) { show('danger', '无法记录', error.message); return; }
        if (ctx.prefs?.get().confirm && !await VCPUI.feedback.confirm({ title: '确认记录模拟意图',
            message: `${order.side === 'buy' ? '模拟买入' : '模拟卖出'} ${ctx.store.quote(order.symbol)?.name || order.symbol} ${order.quantity} 股，将于下一数据日按规则结算。`,
            confirmLabel: '确认记录' })) return;
        submit.update({ loading: true });
        try { const r = await ctx.store.write('SubmitOrder', order);
            show('success', '已记录待结算意图', `${r.receipt.orderId}：将于下一数据日按规则进行虚拟结算，当前尚未成交。`);
        } catch (error) { show('danger', error.code === 'STALE_OBSERVATION' ? '观察已过期' : '未能记录', error.message); }
        finally { submit.update({ loading: false }); }
    });
    function update() {
        const o = ctx.store.observation, q = ctx.store.quote(ctx.symbol()), r = q ? runRow(q) : null;
        name.textContent = q ? `${q.name} · ${q.symbol}` : '未选择证券';
        last.textContent = q?.closeCents ? yuan(q.closeCents) : '';
        last.dataset.tone = r ? tone(r.price, r.prev) : '';
        submit.update({ disabled: !o || !q || o.paused }); preview.update({ disabled: !o || !q });
        account.replaceChildren();
        if (!o) return;
        const a = o.account, card = h('div', 'account-grid');
        for (const [label, cents] of [['可用', a.availableCents], ['冻结', a.reservedCents], ['总权益', a.equityCents], ['已实现', a.realizedCents]]) {
            const cell = h('div'); cell.append(h('span', 'muted', label), h('strong', '', yuan(cents))); card.append(cell);
        }
        account.append(owned.add(VCPUI.create('Card', { content: card, variant: 'outlined' })).element);
    }
    return { element, update, dispose: () => owned.destroy() };
}

function positionsPanel(ctx) {
    const owned = controls([]), element = h('div', 'panel panel-table');
    const t = table(owned, [{ key: 'name', label: '证券' }, { key: 'quantity', label: '数量' }, { key: 'sellable', label: '可卖' },
        { key: 'cost', label: '成本价' }, { key: 'value', label: '市值' },
        { key: 'pnl', label: '浮动盈亏', tone: r => r.pnlCents > 0 ? 'up' : r.pnlCents < 0 ? 'down' : '' }], '暂无持仓');
    element.append(t.element);
    return { element, dispose: () => owned.destroy(), update() {
        const o = ctx.store.observation;
        t.update((o?.account.positions || []).map(p => ({ symbol: p.symbol, name: ctx.store.quote(p.symbol)?.name || p.symbol,
            quantity: p.quantity, sellable: p.sellableQuantity, cost: yuan(Math.round(p.costCents / p.quantity)),
            value: yuan(p.marketValueCents) + (p.stale ? '（非当日价）' : ''), pnlCents: p.marketValueCents - p.costCents,
            pnl: signed(p.marketValueCents - p.costCents) })), row => ctx.select(row.symbol));
    } };
}

function ordersPanel(ctx) {
    const owned = controls([]), element = h('div', 'panel panel-table');
    const t = table(owned, [{ key: 'date', label: '日期' }, { key: 'name', label: '证券' },
        { key: 'side', label: '方向', tone: r => r.sideKey === 'buy' ? 'up' : 'down' }, { key: 'quantity', label: '数量' },
        { key: 'status', label: '状态', tone: r => r.statusKey === 'filled' ? 'accent' : r.statusKey === 'unfilled' ? 'warning' : '' },
        { key: 'price', label: '价格' }, { key: 'fee', label: '费用' }, { key: 'reason', label: '说明' }], '暂无模拟意图');
    element.append(t.element);
    return { element, dispose: () => owned.destroy(), update() {
        const o = ctx.store.observation;
        t.update([...(o?.orders || [])].reverse().map(order => ({ symbol: order.symbol, date: order.date || order.plannedDate,
            name: ctx.store.quote(order.symbol)?.name || order.symbol, sideKey: order.side, side: order.side === 'buy' ? '买' : '卖',
            quantity: order.quantity, statusKey: order.status, status: STATUS[order.status] || order.status,
            price: order.priceCents ? yuan(order.priceCents) : order.limitPriceCents ? `限 ${yuan(order.limitPriceCents)}` : '—',
            fee: order.feeCents ? yuan(order.feeCents) : '—', reason: order.reason || '' })), row => ctx.select(row.symbol));
    } };
}

function journalPanel(ctx) {
    const owned = controls([]), element = h('div', 'panel panel-table');
    const t = table(owned, [{ key: 'id', label: '#' }, { key: 'date', label: '日期' }, { key: 'kind', label: '事件' }, { key: 'detail', label: '内容' }], '暂无记录');
    element.append(t.element);
    return { element, dispose: () => owned.destroy(), update() {
        const o = ctx.store.observation;
        t.update([...(o?.journal || [])].reverse().map(e => ({ id: e.id.replace('event-', ''), date: e.date, kind: EVENTS[e.kind] || e.kind,
            detail: [e.orderId, e.planId, e.symbol && (ctx.store.quote(e.symbol)?.name || e.symbol),
                e.quantity && `${e.quantity} 股`, e.priceCents && `@ ${yuan(e.priceCents)}`, e.reason].filter(Boolean).join(' · ') })));
    } };
}

function equityPanel(ctx) {
    const element = h('div', 'panel panel-equity'), summary = h('div', 'equity-summary'), host = h('div', 'equity-host');
    element.append(summary, host);
    let chart, line;
    function update() {
        const o = ctx.store.observation;
        if (!o) return;
        if (!chart) {
            // The curve always spans the panel, however few days the run has.
            chart = new Chart(host, { theme: palette, gridX: false, maxSpacing: Infinity, onResize: () => chart.fit(), onReset: () => chart.fit() });
            line = chart.pane({ margins: { top: 0.12, bottom: 0.12 },
                format: v => v.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) }).add('line', { color: 'accent', width: 2, lastValue: true });
        }
        const points = new Map(o.equity.map(e => [e.date, e.equityCents / 100]));
        chart.setKeys([...points.keys()]); line.data = [...points.values()];
        chart.fit();
        const first = o.equity[0]?.equityCents || 1, last = o.account.equityCents;
        let peak = 0, drawdown = 0;
        for (const e of o.equity) { peak = Math.max(peak, e.equityCents); drawdown = Math.min(drawdown, e.equityCents / peak - 1); }
        summary.replaceChildren(...[['收益率', pct(last / first - 1), last > first ? 'up' : last < first ? 'down' : ''], ['当前权益', yuan(last)],
            ['最大回撤', pct(drawdown)], ['记录天数', String(o.equity.length)]].map(([label, value, t]) => {
            const cell = h('div'); const strong = h('strong', '', value); if (t) strong.dataset.tone = t;
            cell.append(h('span', 'muted', label), strong); return cell;
        }));
    }
    return { element, update, dispose() { chart?.destroy(); } };
}

function placeholder(icon, title, description) {
    return () => {
        const owned = controls([]), element = h('div', 'panel panel-placeholder');
        element.append(owned.add(VCPUI.create('EmptyState', { icon, title, description })).element);
        return { element, update() {}, dispose: () => owned.destroy() };
    };
}
// Panels that work on a simulation account. In a browsing layout they explain where they belong.
export function simulationOnly(spec) {
    return ctx => {
        const owned = controls([]), element = h('div', 'panel panel-placeholder');
        element.append(emptyState(owned, { icon: spec.icon, title: `${spec.title}属于模拟交易`,
            description: '看盘不需要模拟账户。要练习下单、回放历史或让 AI 交易，请切换到“模拟交易”等布局，再选择或新建一次模拟交易。' },
        '切换到模拟交易', () => ctx.openSimulation()));
        return { element, update() {}, dispose: () => owned.destroy() };
    };
}

export const PANELS = Object.freeze({
    watchlist: { title: '行情列表', icon: 'format_list_bulleted', description: '全市场、板块与自选，按代码、名称或拼音首字母搜索，可排序。', create: watchlistPanel },
    chart: { title: '图表', icon: 'candlestick_chart', description: '日、周、月、季、年 K 线，成交量与四条均线；模拟交易中另有买卖点与成本线。', create: chartPanel },
    quote: { title: '个股行情', icon: 'show_chart', description: '最新价、开高低收、成交额、振幅及区间涨跌。', create: quotePanel },
    order: { title: '下单', icon: 'receipt', run: true, description: '预览并记录模拟买卖意图，附账户摘要。', create: orderPanel },
    positions: { title: '持仓', icon: 'account_balance_wallet', run: true, description: '数量、可卖数量、成本、市值及浮动盈亏。', create: positionsPanel },
    orders: { title: '委托与成交', icon: 'history', run: true, description: '待结算、虚拟成交、未完成及已撤销记录。', create: ordersPanel },
    journal: { title: '日志', icon: 'menu_book', run: true, description: '计划、意图、结算、推进及复盘的完整记录。', create: journalPanel },
    equity: { title: '资金曲线', icon: 'show_chart', run: true, description: '每日权益、收益率及最大回撤。', create: equityPanel },
    conditional: { title: '条件单', icon: 'tune', run: true, description: '止损、止盈、移动止损及到价买入。', create: placeholder('tune', '条件单（D2 接入）',
        '用于管理止损、止盈及移动止损委托，支持改价与撤销；图表中的价格线可直接拖动调整。') },
    training: { title: '训练控制', icon: 'school', run: true, description: '指定日期或随机开局、盲测、逐日或自动播放、成绩单。', create: placeholder('school', '训练控制（D4 接入）',
        '支持指定日期或随机抽取行情区间；盲测模式下隐藏证券名称与日期；可逐日推进或自动播放，结束后生成成绩单。') },
    ai: { title: 'AI 面板', icon: 'smart_toy', run: true, description: 'AI 的计划、工具调用及回执，与用户同场对照。', create: placeholder('smart_toy', 'AI 面板（D6 接入）',
        '以相同起点为 AI 建立一局，逐条显示其工具调用与回执，结束后与用户成绩并列比较。') },
    formula: { title: '公式编辑', icon: 'functions', description: '以通达信语法编写自定义指标、选股及信号。', create: placeholder('functions', '公式编辑（D3 引擎、D6 编辑器）',
        '使用通达信语法编写指标、选股及买卖信号，提供语法高亮、错误定位与参数表，修改后即时绘制；含未来函数的公式将被拒绝。') },
    guide: { title: '获取数据', icon: 'info', description: '通达信、AKShare、baostock 及自有数据的接入方式。', create: () => {
        const element = h('div', 'panel panel-guide'); element.append(dataGuide());
        return { element, update() {}, dispose() {} };
    } },
    screener: { title: '条件选股', icon: 'funnel', description: '对板块执行选股公式，结果可存为板块。', create: placeholder('funnel', '条件选股（D4 接入）',
        '选择板块与选股公式进行筛选，结果可另存为新板块。') },
});
