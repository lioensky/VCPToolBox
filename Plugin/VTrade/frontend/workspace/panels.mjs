import VCPUI from '../vendor/vcp-ui/vcp-ui.js';
import { CandleChart } from '../candle-chart.mjs';
import { Chart, palette } from '../chart-engine.mjs';
import { formatVolume } from '../chart-scale.mjs';
import { INDICATORS, calculateIndicator, chartIndicatorSettings } from '../indicators.mjs';
import { command, marketRequest, local } from './store.mjs';
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
function unavailableRow(symbol, reason) {
    return { ...marketRow({ symbol, code: symbol.split('.').pop(), name: reason, abbr: '', scale: 100, kind: 'stock' }, null),
        available: false };
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
let boardStore;
export function setBoardStore(value) { boardStore = value; }
const favorites = {
    list: () => boardStore?.state.favorites || [],
    has: symbol => boardStore?.has(symbol) || false,
    toggle: symbol => boardStore.toggle(symbol),
};
const boards = () => boardStore?.state.boards || [];
async function trainingPairSessions(pairId) {
    const saved = local.get(`vtrade-training-pair:${pairId}`, null);
    if (saved?.human && saved?.agent) return saved;
    const sessions = (await command({ command: 'ListSessions' })).sessions;
    const pair = Object.fromEntries(sessions.filter(item => item.training?.pairId === pairId)
        .map(item => [item.training.role, item.sessionId]));
    return pair.human && pair.agent ? pair : null;
}
const MARKET_BOARDS = [
    { id: 'favorites', label: '自选' }, { id: 'a', label: 'A股', test: s => s.kind === 'stock' },
    { id: 'chinext', label: '创业板', test: s => s.board === 'chinext' }, { id: 'star', label: '科创板', test: s => s.board === 'star' },
    { id: 'bse', label: '北交所', test: s => s.board === 'bse' }, { id: 'index', label: '指数', test: s => s.kind === 'index' },
    { id: 'fund', label: '基金', test: s => s.kind === 'fund' },
];
const RUN_BOARDS = [{ id: 'favorites', label: '自选' }, { id: 'all', label: '全部股票' },
    { id: 'held', label: '持仓' }, { id: 'planned', label: '计划' }];
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
    const changeBoard = (action, extra) => boardStore.change(action, extra).then(() => update())
        .catch(error => ctx.notify(error.message, 'danger'));
    const head = h('div', 'mk-head'), title = h('strong', 'mk-title'), count = h('small', 'mk-count muted');
    const search = owned.add(VCPUI.create('Input', { placeholder: '代码 / 名称 / 拼音首字母', size: 'sm', type: 'search' }));
    search.element.classList.add('mk-search');
    const star = owned.add(VCPUI.create('IconButton', { icon: 'check_circle', label: '加入自选', size: 'sm' }));
    const manager = h('button', 'mk-manage', '板块管理'); manager.type = 'button';
    manager.addEventListener('click', openBoardManager);
    head.append(title, count, search.element, star.element, manager);
    const scroller = h('div', 'mk-table'), header = h('div', 'mk-header'), body = h('div', 'mk-body'), rowsHost = h('div', 'mk-rows');
    scroller.tabIndex = 0;
    body.append(rowsHost); scroller.append(header, body);
    const state = h('div', 'mk-state');
    const tabs = h('div', 'mk-tabs');
    element.append(head, scroller, state, tabs);
    const defaults = COLUMNS.map(c => c.key);
    const keys = () => (Array.isArray(ctx.panel.state.columns) ? ctx.panel.state.columns : defaults)
        .filter((key, index, list) => COLUMNS.some(c => c.key === key) && list.indexOf(key) === index);
    const visible = () => keys().map(key => COLUMNS.find(c => c.key === key));
    const widths = () => ctx.panel.state.columnWidths || {};
    const setGrid = () => element.style.setProperty('--mk-cols', visible().map(c => `${widths()[c.key] || c.width}px`).join(' '));
    setGrid();
    let rows = [], sorted = [], query = '', rowsKey = '';
    const sort = () => ctx.panel.state.sort || null;
    function renderHeader() {
        setGrid(); header.replaceChildren();
        for (const column of visible()) {
            const button = h('button', 'mk-col', column.label);
            button.type = 'button'; button.dataset.key = column.key;
            if (column.key !== 'code' && column.key !== 'name') button.dataset.num = 'true';
            button.addEventListener('click', () => {
                const current = sort();
                ctx.panel.state.sort = current?.key !== column.key ? { key: column.key, dir: column.sort === 'text' ? 'asc' : 'desc' }
                    : current.dir === 'desc' ? { key: column.key, dir: 'asc' } : null;
                ctx.save(); arrange(); paint();
            });
            button.addEventListener('contextmenu', event => {
                event.preventDefault();
                const current = keys(), index = current.indexOf(column.key);
                const change = next => { ctx.panel.state.columns = next; ctx.save(); renderHeader(); arrange(); paint(); };
                openMenu(button, [
                    { label: '向左移动', icon: 'arrow_left', onClick: () => { if (index > 0) { [current[index - 1], current[index]] = [current[index], current[index - 1]]; change(current); } } },
                    { label: '向右移动', icon: 'arrow_right', onClick: () => { if (index < current.length - 1) { [current[index + 1], current[index]] = [current[index], current[index + 1]]; change(current); } } },
                    ...COLUMNS.map(item => ({ label: `${current.includes(item.key) ? '✓ ' : ''}${item.label}`, icon: 'view_column', onClick: () => {
                        if (current.includes(item.key)) { if (current.length > 1) change(current.filter(key => key !== item.key)); }
                        else change([...current, item.key]);
                    } })),
                    { label: '恢复默认列', icon: 'restart_alt', onClick: () => { ctx.panel.state.columnWidths = {}; change([...defaults]); } },
                ]);
            });
            const grip = h('span', 'mk-resize'); grip.setAttribute('aria-label', `调整${column.label}列宽`);
            grip.addEventListener('pointerdown', event => {
                event.preventDefault(); event.stopPropagation();
                const x = event.clientX, initial = widths()[column.key] || column.width;
                grip.setPointerCapture(event.pointerId);
                const move = e => { ctx.panel.state.columnWidths ||= {}; ctx.panel.state.columnWidths[column.key] = Math.max(45, Math.min(280, initial + e.clientX - x)); setGrid(); };
                const end = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', end); ctx.save(); };
                grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', end);
            });
            button.append(grip); header.append(button);
        }
    }
    renderHeader();
    const boardKey = () => market ? 'marketBoard' : ctx.store.observation?.marketDirectory ? 'directoryBoard' : 'board';
    const board = () => ctx.panel.state[boardKey()]
        || (market ? 'a' : ctx.store.observation?.marketDirectory ? 'all' : 'favorites');
    function renderTabs() {
        const items = [...(market ? MARKET_BOARDS : RUN_BOARDS), ...boards().map(b => ({ id: b.id, label: b.name }))];
        tabs.replaceChildren(...items.map(item => {
            const button = h('button', 'mk-tab', item.label);
            button.type = 'button'; button.setAttribute('aria-pressed', String(item.id === board()));
            button.addEventListener('click', () => { ctx.panel.state[boardKey()] = item.id; ctx.save(); clearSearch(); update(); });
            button.addEventListener('contextmenu', event => {
                const custom = boards().find(b => b.id === item.id);
                if (!custom) return;
                event.preventDefault();
                openMenu(button, [{ label: '重命名板块', icon: 'edit', onClick: async () => {
                    const name = await promptText({ title: '重命名板块', label: '板块名称', value: custom.name });
                    if (name) void changeBoard('save', { boardId: custom.id, name, symbols: custom.symbols });
                } }, { label: '删除板块', icon: 'delete', onClick: () => {
                    void changeBoard('delete', { boardId: custom.id });
                } }, { label: '向前移动板块', icon: 'arrow_left', onClick: () => {
                    const ids = boards().map(b => b.id), index = ids.indexOf(custom.id);
                    if (index > 0) { [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]; void changeBoard('reorder', { boardIds: ids }); }
                } }, { label: '向后移动板块', icon: 'arrow_right', onClick: () => {
                    const ids = boards().map(b => b.id), index = ids.indexOf(custom.id);
                    if (index < ids.length - 1) { [ids[index + 1], ids[index]] = [ids[index], ids[index + 1]]; void changeBoard('reorder', { boardIds: ids }); }
                } }]);
            });
            return button;
        }));
        const add = h('button', 'mk-tab mk-tab-add', '+ 板块'); add.type = 'button';
        add.addEventListener('click', async () => {
            const name = await promptText({ title: '新建板块', label: '板块名称', placeholder: '例如：观察池', confirmLabel: '新建' });
            if (!name) return;
            boardStore.change('save', { name, symbols: [] }).then(state => {
                ctx.panel.state[boardKey()] = state.boardId;
                ctx.save(); update();
            }).catch(error => ctx.notify(error.message, 'danger'));
        });
        tabs.append(add);
    }
    function openBoardManager() {
        const content = h('div', 'mk-manager');
        const help = h('p', 'muted', '自选在看盘、模拟交易和 Agent 中共用。右键证券行也可增删成员。');
        const create = h('div', 'mk-manager-create');
        const name = h('input'); name.placeholder = '新板块名称'; name.maxLength = 40; name.setAttribute('aria-label', '新板块名称');
        const add = h('button', '', '新建板块'); add.type = 'button';
        const list = h('div', 'mk-manager-list'), error = h('p', 'mk-manager-error'); error.setAttribute('role', 'alert');
        const close = VCPUI.create('Button', { label: '完成', variant: 'primary', size: 'sm' });
        const modal = VCPUI.create('Modal', { title: '板块管理', size: 'lg', content, actions: [close] });
        close.element.addEventListener('click', () => modal.close(null));
        const fail = failure => { error.textContent = failure.message; };
        const editMembers = (boardId, label) => {
            const current = boardId === 'favorites' ? { symbols: favorites.list() } : boards().find(item => item.id === boardId);
            if (!current) return;
            const form = h('div', 'mk-members-form');
            form.append(h('p', 'muted', '每行填写一个证券标识，例如 SH.600000。保存空白内容可清空成员。'));
            const input = h('textarea'); input.value = current.symbols.join('\n'); input.setAttribute('aria-label', `${label}证券成员`);
            const issue = h('p', 'mk-manager-error'); issue.setAttribute('role', 'alert'); form.append(input, issue);
            const cancel = VCPUI.create('Button', { label: '取消', variant: 'ghost', size: 'sm' });
            const save = VCPUI.create('Button', { label: '保存成员', variant: 'primary', size: 'sm' });
            const editor = VCPUI.create('Modal', { title: `管理“${label}”的证券`, size: 'lg', content: form, actions: [cancel, save] });
            cancel.element.addEventListener('click', () => editor.close(null));
            save.element.addEventListener('click', async () => {
                const symbols = [...new Set(input.value.split(/[\s,，;；]+/).map(value => value.trim()).filter(Boolean))];
                try {
                    await boardStore.change(boardId === 'favorites' ? 'favorites' : 'save', boardId === 'favorites'
                        ? { symbols } : { boardId, name: boards().find(item => item.id === boardId)?.name, symbols });
                    editor.close(null); renderRows(); update();
                } catch (failure) { issue.textContent = failure.message; }
            });
            document.body.append(editor.element);
        };
        const action = (label, run, danger = false) => {
            const button = h('button', danger ? 'danger' : '', label); button.type = 'button';
            button.addEventListener('click', () => { void Promise.resolve(run()).catch(fail); }); return button;
        };
        const renderRows = () => {
            list.replaceChildren();
            const entries = [{ id: 'favorites', name: '全局自选', symbols: favorites.list() }, ...boards()];
            for (const item of entries) {
                const row = h('div', 'mk-manager-row');
                row.append(h('strong', '', item.name), h('span', 'muted', `${item.symbols.length} 只`),
                    action('管理成员', () => editMembers(item.id, item.name)));
                if (item.id !== 'favorites') {
                    row.append(action('重命名', async () => {
                        const next = await promptText({ title: '重命名板块', label: '板块名称', value: item.name, maxLength: 40 });
                        if (next) { await boardStore.change('save', { boardId: item.id, name: next, symbols: item.symbols }); renderRows(); update(); }
                    }), action('上移', async () => {
                        const ids = boards().map(board => board.id), index = ids.indexOf(item.id);
                        if (index < 1) return;
                        [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
                        await boardStore.change('reorder', { boardIds: ids }); renderRows(); update();
                    }), action('下移', async () => {
                        const ids = boards().map(board => board.id), index = ids.indexOf(item.id);
                        if (index < 0 || index === ids.length - 1) return;
                        [ids[index + 1], ids[index]] = [ids[index], ids[index + 1]];
                        await boardStore.change('reorder', { boardIds: ids }); renderRows(); update();
                    }), action('删除', async () => {
                        if (!await VCPUI.feedback.confirm({ title: '删除板块', danger: true, confirmLabel: '删除',
                            message: `确定删除“${item.name}”吗？板块成员不会从全局自选或模拟账本中移除。` })) return;
                        await boardStore.change('delete', { boardId: item.id });
                        if (board() === item.id) { ctx.panel.state[boardKey()] = 'favorites'; ctx.save(); }
                        renderRows(); update();
                    }, true));
                }
                list.append(row);
            }
        };
        add.addEventListener('click', async () => {
            const value = name.value.trim();
            if (!value) { error.textContent = '请先填写板块名称。'; name.focus(); return; }
            try {
                const result = await boardStore.change('save', { name: value, symbols: [] });
                ctx.panel.state[boardKey()] = result.boardId; ctx.save();
                name.value = ''; error.textContent = ''; renderRows(); update();
            } catch (failure) { fail(failure); }
        });
        name.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); add.click(); } });
        create.append(name, add); content.append(help, create, error, list); renderRows(); document.body.append(modal.element);
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
            if (id === 'favorites' || custom) return (custom ? custom.symbols : favorites.list()).map(symbol => {
                const security = ctx.market.security(symbol);
                return security ? marketRow(security, ctx.market.quotes.get(symbol)) : unavailableRow(symbol, '未接入当前行情源');
            });
            const chosen = list.filter(pick);
            return chosen.map(s => marketRow(s, ctx.market.quotes.get(s.symbol)));
        }
        const o = ctx.store.observation;
        if (o?.marketDirectory) {
            const list = ctx.store.sessionSecurities, known = ctx.store.sessionBySymbol;
            const toRow = security => {
                const quote = ctx.store.quote(security.symbol);
                return quote ? runRow(quote) : marketRow(security, null);
            };
            const savedRows = symbols => symbols.map(symbol => known.has(symbol)
                ? toRow(known.get(symbol)) : unavailableRow(symbol, '未接入当前行情源'));
            if (query) return list.map(security => [security, rank(security, query)]).filter(([, score]) => score < 99)
                .sort((a, b) => a[1] - b[1] || a[0].symbol.localeCompare(b[0].symbol))
                .slice(0, 300).map(([security]) => toRow(security));
            if (id === 'favorites') return savedRows(favorites.list());
            if (custom) return savedRows(custom.symbols);
            const held = new Set(o.account.positions.map(position => position.symbol));
            const planned = new Set(o.plans.map(plan => plan.symbol));
            return list.filter(security => id === 'all' || id === 'held' && held.has(security.symbol)
                || id === 'planned' && planned.has(security.symbol)).map(toRow);
        }
        const held = new Set(o?.account.positions.map(p => p.symbol) || []), planned = new Set(o?.plans.map(p => p.symbol) || []);
        const all = o?.quotes.map(runRow) || [], bySymbol = new Map(all.map(row => [row.symbol, row]));
        const savedRows = symbols => symbols.map(symbol => bySymbol.get(symbol) || unavailableRow(symbol,
            o ? '未纳入本次模拟' : '尚未打开模拟交易'));
        if (query) return [...new Map([...all, ...savedRows(favorites.list())].map(row => [row.symbol, row])).values()]
            .map(r => [r, rank(r, query)]).filter(([, r]) => r < 99).sort((a, b) => a[1] - b[1]).map(([r]) => r);
        if (id === 'favorites') return savedRows(favorites.list());
        if (custom) return savedRows(custom.symbols);
        return all.filter(r => id === 'all' || id === 'held' && held.has(r.symbol) || id === 'planned' && planned.has(r.symbol));
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
            if (row.available === false) line.dataset.unavailable = 'true';
            if (row.symbol === current) line.dataset.selected = 'true';
            for (const column of visible()) {
                const cell = h('span', column.key === 'code' || column.key === 'name' ? 'mk-cell' : 'mk-cell mk-num', column.text(row));
                const t = column.tone?.(row); if (t) cell.dataset.tone = t;
                line.append(cell);
            }
            return line;
        }));
        if (!market && ctx.store.observation?.marketDirectory) {
            const visibleSymbols = sorted.slice(first, last).filter(row => row.available !== false && !ctx.store.quote(row.symbol))
                .map(row => row.symbol);
            if (visibleSymbols.length) void ctx.store.loadSessionQuotes(visibleSymbols)
                .catch(error => ctx.notify(error.message, 'danger'));
        }
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
        if (row) {
            if (row.dataset.unavailable) ctx.notify(market || ctx.store.observation?.marketDirectory
                ? '该证券尚未接入当前行情源。' : '该证券不在本次固定回放数据中。', 'warning');
            else ctx.select(row.dataset.symbol);
            scroller.focus({ preventScroll: true });
        }
    });
    rowsHost.addEventListener('contextmenu', event => {
        const row = event.target.closest('.mk-row');
        if (!row) return;
        event.preventDefault();
        const symbol = row.dataset.symbol, custom = boards().find(b => b.id === board());
        openMenu(row, [
            { label: favorites.has(symbol) ? '移出自选' : '加入自选', icon: 'check_circle', onClick: () => {
                favorites.toggle(symbol).then(update).catch(error => ctx.notify(error.message, 'danger'));
            } },
            ...boards().map(b => ({ label: b.symbols.includes(symbol) ? `移出“${b.name}”` : `加入“${b.name}”`, icon: 'layers', onClick: () => {
                void changeBoard('save', { boardId: b.id, name: b.name,
                    symbols: b.symbols.includes(symbol) ? b.symbols.filter(s => s !== symbol) : [...b.symbols, symbol] });
            } })),
            ...(custom ? [] : [{ label: '新建板块并加入', icon: 'add', onClick: async () => {
                const name = await promptText({ title: '新建板块', label: '板块名称', confirmLabel: '新建' });
                if (name) void changeBoard('save', { name, symbols: [symbol] });
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
    star.element.addEventListener('click', async () => {
        const symbol = ctx.symbol();
        if (!symbol) return;
        const added = !favorites.has(symbol);
        try { await favorites.toggle(symbol); ctx.notify(added ? '已加入自选。' : '已移出自选。'); update(); }
        catch (error) { ctx.notify(error.message, 'danger'); }
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
        const key = `${board()}|${query}|${boardStore?.state.revision}|${market ? ctx.market.securities.length + ':' + ctx.market.quoteVersion
            : ctx.store.observation?.marketDirectory ? ctx.store.sessionSecurities.length + ':' + ctx.store.sessionId + ':' + ctx.store.observation?.revision + ':' + ctx.store.sessionQuotes.size
                : ctx.store.sessionId + ':' + ctx.store.observation?.revision}`;
        if (key !== rowsKey) { rows = collect(); rowsKey = key; arrange(); }
        count.textContent = `${sorted.length} 只`;
        star.update({ active: favorites.has(ctx.symbol()), label: favorites.has(ctx.symbol()) ? '移出自选' : '加入自选' });
        if (!sorted.length && !error) {
            state.append(h('p', 'mk-empty muted', query ? '没有匹配的证券。' : board() === 'favorites' ? '全局自选为空。先在看盘页搜索证券并加入自选。'
                : boards().some(b => b.id === board()) ? '此板块暂无证券。在列表中右键证券即可加入。'
                    : market || ctx.store.observation?.marketDirectory ? '正在读取本机行情。' : '本次固定回放没有证券或尚未打开模拟交易。'));
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
    const volume = h('span', 'muted chart-volume');
    title.append(name, code, readout);
    const period = owned.add(VCPUI.create('SegmentedControl', { items: [['day', '日'], ['week', '周'], ['month', '月'], ['quarter', '季'], ['year', '年']]
        .map(([value, label]) => ({ value, label })), value: ctx.panel.state.period || 'day', size: 'sm', label: 'K 线周期' }));
    const toggles = (market ? [] : [['receipt', '买卖点', 'marks'], ['account_balance_wallet', '持仓成本线', 'cost']])
        .map(([icon, label, key]) => {
            const button = owned.add(VCPUI.create('IconButton', { icon, label, size: 'sm', active: true }));
            button.element.addEventListener('click', () => button.update({ active: candles.toggle(key) }));
            return button.element;
        });
    const reset = owned.add(VCPUI.create('IconButton', { icon: 'restart_alt', label: '复位视图', size: 'sm' }));
    reset.element.addEventListener('click', () => candles.reset());
    const selection = () => { try { return chartIndicatorSettings(ctx.panel.state.indicators || {}); } catch { return chartIndicatorSettings({}); } };
    const minutePeriod = h('select', 'chart-minute-select');
    for (const [value, label] of [['0', '日线'], ['1', '1 分钟'], ['5', '5 分钟'], ['15', '15 分钟'],
        ['custom', '自定义分钟'], ['tencent', '腾讯当日分时']]) {
        const option = h('option', '', label); option.value = value; minutePeriod.append(option);
    }
    minutePeriod.value = ctx.panel.state.minutePeriod || '0'; minutePeriod.setAttribute('aria-label', '分钟周期');
    const customPeriod = h('input', 'chart-minute-custom'); customPeriod.type = 'number'; customPeriod.min = '1'; customPeriod.max = '120';
    customPeriod.value = String(ctx.panel.state.customMinutePeriod || 30); customPeriod.title = '自定义分钟周期（1 至 120）';
    customPeriod.hidden = minutePeriod.value !== 'custom';
    const tools = h('div', 'panel-tools'); tools.append(period.element, minutePeriod, customPeriod, ...toggles, reset.element);
    const host = h('div', 'chart-host'), minuteHost = h('div', 'chart-host'), empty = h('div', 'chart-empty', '请选择证券'), caption = h('div', 'chart-caption muted');
    minuteHost.hidden = true;
    const legend = h('div', 'chart-legend'); legend.append(volume);
    host.tabIndex = 0;
    const candles = new CandleChart(host, readout, caption, empty, group => {
        ctx.notify(group.map(o => `${o.date} ${o.side === 'buy' ? '买' : '卖'} ${o.quantity} 股 @ ${yuan(o.priceCents)}`).join('；'));
    }, message => ctx.notify(message), { volumeReadout: volume, headroom: 0.08, panelRoot: element,
        onIndicators: value => { ctx.panel.state.indicators = value; ctx.save(); } });
    candles.period = ctx.panel.state.period || 'day';
    candles.setIndicators(selection());
    candles.initialize();
    const indicatorBar = candles.indicators.toolbar();
    element.append(bar(title, tools), indicatorBar, legend, host, minuteHost, empty, caption);
    const showIndicatorSettings = () => candles.indicators.editFirst();
    host.addEventListener('contextmenu', event => { event.preventDefault(); showIndicatorSettings(); });
    minuteHost.addEventListener('contextmenu', event => {
        event.preventDefault();
        openMenu(minuteHost, [{ label: '切换日线并设置指标', icon: 'tune', onClick: () => {
            minutePeriod.value = '0'; minutePeriod.dispatchEvent(new Event('change')); showIndicatorSettings();
        } }]);
    });
    let minuteChart, minuteCandles, minuteVolume, intradayChart;
    const showMinute = () => minutePeriod.value !== '0';
    minutePeriod.addEventListener('change', () => {
        ctx.panel.state.minutePeriod = minutePeriod.value; customPeriod.hidden = minutePeriod.value !== 'custom';
        ctx.save(); void update();
    });
    customPeriod.addEventListener('change', () => { ctx.panel.state.customMinutePeriod = Number(customPeriod.value); ctx.save(); void update(); });
    async function updateMinutes(symbol, mine) {
        if (minutePeriod.value === 'tencent') {
            const points = market ? (await marketRequest({ action: 'intraday', symbol })).intraday
                : (await command({ command: 'CallTool', sessionId: ctx.store.sessionId,
                    tool: 'tencent-intraday', symbol })).tool.result;
            if (mine !== ticket) return;
            if (minuteChart) { minuteChart.destroy(); minuteChart = null; }
            if (!intradayChart) {
                intradayChart = new Chart(minuteHost, { theme: palette,
                    onResize: () => intradayChart.fit(), onReset: () => intradayChart.fit() });
                intradayChart.price = intradayChart.pane({ weight: 1, margins: { top: 0.12, bottom: 0.08 },
                    format: value => value.toFixed(2) }).add('line', { color: 'accent', width: 2, lastValue: true });
                intradayChart.volume = intradayChart.pane({ weight: 0.25, format: formatVolume, maxTicks: 2 })
                    .add('histogram', { alpha: 0.45 });
            }
            intradayChart.setKeys(points.points.map(point => `${points.date}T${point.time}`));
            intradayChart.price.data = points.points.map(point => point.priceCents / 100);
            intradayChart.volume.data = points.points.map((point, index) => ({
                value: Math.max(0, point.cumulativeVolume - (points.points[index - 1]?.cumulativeVolume || 0)), tone: 'accent' }));
            intradayChart.fit(); empty.hidden = points.points.length > 0;
            caption.textContent = `${points.date} · ${points.points.length} 个分时点 · ${points.source} · 非 OHLCV K 线`;
            return;
        }
        if (intradayChart) { intradayChart.destroy(); intradayChart = null; }
        const sources = (await marketRequest({ action: 'minuteSources' })).minuteSources;
        if (mine !== ticket) return;
        const dailyRef = market ? null : ctx.store.observation?.dataSourceId || ctx.store.observation?.datasetId;
        const source = sources.find(s => (!dailyRef || s.dailyRef === dailyRef) && s.securities.some(item => item.symbol === symbol));
        if (!source) { empty.hidden = false; empty.textContent = '尚未导入此证券的一分钟 OHLCV 数据'; caption.textContent = '在数据设置中导入本机 JSON 或 CSV'; return; }
        const periodValue = minutePeriod.value === 'custom' ? Number(customPeriod.value) : Number(minutePeriod.value);
        if (!Number.isSafeInteger(periodValue) || periodValue < 1 || periodValue > 120) {
            empty.hidden = false; empty.textContent = '自定义周期须为 1 至 120 分钟'; return;
        }
        const chart = market ? (await marketRequest({ action: 'minuteChart', sourceId: source.sourceId, symbol, period: periodValue })).minuteChart
            : (await command({ command: 'GetMinuteChart', sessionId: ctx.store.sessionId, sourceId: source.sourceId,
                symbol, period: periodValue })).minuteChart;
        if (mine !== ticket) return;
        if (!minuteChart) {
            minuteChart = new Chart(minuteHost, { theme: palette, onResize: () => minuteChart.fit(), onReset: () => minuteChart.fit() });
            minuteCandles = minuteChart.pane({ weight: 1, margins: { top: 0.12, bottom: 0.08 }, format: value => value.toFixed(2) })
                .add('candles', { lastValue: true });
            minuteVolume = minuteChart.pane({ weight: 0.25, format: formatVolume, maxTicks: 2 }).add('histogram', { alpha: 0.45 });
        }
        minuteChart.setKeys(chart.bars.map(b => b.timestamp));
        minuteCandles.data = chart.bars.map(b => ({ open: b.openCents / 100, high: b.highCents / 100,
            low: b.lowCents / 100, close: b.closeCents / 100 }));
        minuteVolume.data = chart.bars.map(b => ({ value: b.volume, tone: b.closeCents >= b.openCents ? 'up' : 'down' }));
        minuteChart.fit(); empty.hidden = chart.bars.length > 0;
        caption.textContent = `${chart.bars.length} 根 ${periodValue} 分钟线 · 来源 ${source.name}${market ? '' : ` · 截至模拟日 ${chart.asOf}`}`;
    }
    period.element.addEventListener('change', () => {
        const value = period.element.querySelector('[aria-checked="true"]')?.dataset.value || 'day';
        ctx.panel.state.period = value; ctx.save(); candles.setPeriod(value);
    });
    let ticket = 0;
    async function update() {
        const symbol = ctx.symbol(), mine = ++ticket;
        host.hidden = showMinute(); minuteHost.hidden = !showMinute();
        period.element.hidden = showMinute(); indicatorBar.hidden = showMinute();
        for (const toggle of toggles) toggle.hidden = showMinute();
        if (showMinute()) {
            name.textContent = market ? ctx.market.security(symbol)?.name || '—' : ctx.store.quote(symbol)?.name || '—';
            code.textContent = symbol || ''; legend.hidden = true; readout.textContent = '';
            if (!symbol) { empty.hidden = false; return; }
            try { await updateMinutes(symbol, mine); } catch (error) { if (mine === ticket) { empty.hidden = false; empty.textContent = error.message; } }
            return;
        }
        legend.hidden = false; empty.textContent = '请选择证券';
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
        const o = ctx.store.observation;
        if (o?.marketDirectory && symbol && !ctx.store.quote(symbol)) {
            try { await ctx.store.loadSessionQuotes([symbol]); } catch (error) {
                if (mine === ticket) { empty.hidden = false; empty.textContent = error.message; } return;
            }
        }
        if (mine !== ticket) return;
        const quote = ctx.store.quote(symbol);
        name.textContent = quote?.name || '—'; code.textContent = symbol || '';
        if (!o || !quote) { empty.hidden = false; return; }
        try {
            const chart = await ctx.store.chart(symbol);
            if (mine !== ticket) return;
            candles.update({ ...quote, bars: chart.bars, chartSessionId: o.sessionId, chartTruncated: chart.truncated },
                o.orders, ctx.store.position(symbol), o.date);
        } catch (error) { if (mine === ticket) ctx.notify(error.message, 'danger'); }
    }
    return { element, update, shown: () => showMinute() ? minuteChart?.fit() : candles.chart && candles.reset(),
        dispose() { candles.destroy(); minuteChart?.destroy(); intradayChart?.destroy(); owned.destroy(); } };
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
    star.element.addEventListener('click', async () => {
        const symbol = ctx.symbol();
        if (symbol) {
            const added = !favorites.has(symbol);
            try { await favorites.toggle(symbol); ctx.notify(added ? '已加入自选。' : '已移出自选。'); ctx.refresh(); }
            catch (error) { ctx.notify(error.message, 'danger'); }
        }
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
    const stop = input('附带止损（元）', { type: 'number', placeholder: '选填' }, '买入成交后自动生效');
    const take = input('附带止盈（元）', { type: 'number', placeholder: '选填' }, '与止损组成 OCO');
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
        const q = Number(value(quantity.control)), l = value(limit.control), stopValue = value(stop.control), takeValue = value(take.control);
        if (!Number.isSafeInteger(q) || q < 100 || q % 100) throw new Error('数量须为 100 的整数倍。');
        if (l && !/^\d+(\.\d{1,2})?$/.test(l)) throw new Error('限价最多保留两位小数。');
        for (const field of [stopValue, takeValue]) if (field && !/^\d+(\.\d{1,2})?$/.test(field)) throw new Error('止盈止损最多保留两位小数。');
        if ((stopValue || takeValue) && (ctx.panel.state.side || 'buy') !== 'buy') throw new Error('附带止盈止损只用于买入。');
        return { symbol: ctx.symbol(), side: ctx.panel.state.side || 'buy', quantity: q,
            ...(l ? { limitPriceCents: Math.round(Number(l) * 100) } : {}),
            ...(stopValue ? { stopLossCents: Math.round(Number(stopValue) * 100) } : {}),
            ...(takeValue ? { takeProfitCents: Math.round(Number(takeValue) * 100) } : {}) };
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

const field = (label, input, hint = '') => {
    const wrapper = h('label', 'vt-field'); wrapper.append(h('span', '', label), input);
    if (hint) wrapper.append(h('small', 'muted', hint));
    return wrapper;
};
const nativeInput = (type, value = '', placeholder = '') => {
    const input = h('input', 'vt-input'); input.type = type; input.value = value; input.placeholder = placeholder; return input;
};
const nativeSelect = (items, value) => {
    const select = h('select', 'vt-input');
    for (const [key, label] of items) { const option = h('option', '', label); option.value = key; select.append(option); }
    if (value !== undefined) select.value = value;
    return select;
};
const nativeButton = (label, handler) => { const button = h('button', 'vt-action', label); button.type = 'button'; button.addEventListener('click', handler); return button; };
const centsInput = input => {
    const value = input.value.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(value) || Number(value) <= 0) throw new Error('价格须为正数，最多两位小数。');
    return Math.round(Number(value) * 100);
};
function conditionalPanel(ctx) {
    const element = h('div', 'panel vt-form-panel'), form = h('div', 'vt-form-grid'), list = h('div', 'vt-list'), status = h('p', 'muted');
    const type = nativeSelect([['stop-loss', '止损卖出'], ['take-profit', '止盈卖出'], ['trailing-stop', '移动止损'],
        ['buy-stop', '突破买入'], ['buy-limit', '回落买入']]);
    const quantity = nativeInput('number', '100'), trigger = nativeInput('number', '', '元'), trail = nativeInput('number', '500', '基点');
    const group = nativeInput('text', '', '选填，相同标识构成 OCO');
    const showFields = () => { trigger.closest('label').hidden = type.value === 'trailing-stop'; trail.closest('label').hidden = type.value !== 'trailing-stop'; };
    type.addEventListener('change', showFields);
    form.append(field('类型', type), field('数量（股）', quantity), field('触发价（元）', trigger),
        field('回落幅度（基点）', trail, '500 基点 = 5%'), field('OCO 组标识', group)); showFields();
    const submit = nativeButton('设置条件单', async () => {
        try {
            const count = Number(quantity.value);
            if (!Number.isSafeInteger(count) || count < 100 || count % 100) throw new Error('数量须为 100 的整数倍。');
            const args = { type: type.value, symbol: ctx.symbol(), quantity: count,
                ...(type.value === 'trailing-stop' ? { trailPercentBps: Number(trail.value) } : { triggerPriceCents: centsInput(trigger) }),
                ...(group.value.trim() ? { groupId: group.value.trim() } : {}) };
            await ctx.store.write('PlaceConditional', args); status.textContent = '条件单已生效。'; update();
        } catch (error) { status.textContent = error.message; ctx.notify(error.message, 'danger'); }
    });
    element.append(form, submit, status, list);
    function update() {
        const rows = ctx.store.observation?.conditionals || [];
        list.replaceChildren(...rows.slice().reverse().map(item => {
            const row = h('div', 'vt-list-row');
            const detail = `${item.id} · ${item.symbol} · ${item.quantity} 股 · ${item.type}`
                + (item.triggerPriceCents ? ` @ ${yuan(item.triggerPriceCents)}` : item.trailPercentBps ? ` · 回落 ${item.trailPercentBps / 100}%` : '')
                + (item.groupId ? ` · OCO ${item.groupId}` : '');
            row.append(h('span', '', detail), h('small', 'muted', item.status));
            if (item.status === 'active') {
                row.append(nativeButton('修改', async () => {
                    const next = await promptText({ title: '修改条件单', label: item.type === 'trailing-stop' ? '回落幅度（基点）' : '触发价（元）',
                        value: item.type === 'trailing-stop' ? String(item.trailPercentBps || 500) : yuan(item.triggerPriceCents), maxLength: 12 });
                    if (!next) return;
                    try { await ctx.store.write('UpdateConditional', { conditionalId: item.id,
                        ...(item.type === 'trailing-stop' ? { trailPercentBps: Number(next) } : { triggerPriceCents: centsInput({ value: next }) }) }); update(); }
                    catch (error) { ctx.notify(error.message, 'danger'); }
                }), nativeButton('撤销', async () => {
                    try { await ctx.store.write('CancelConditional', { conditionalId: item.id }); update(); }
                    catch (error) { ctx.notify(error.message, 'danger'); }
                }));
            }
            return row;
        }));
        if (!rows.length) list.append(h('p', 'muted', '尚无条件单。止损和止盈在同一天触发时，先执行止损。'));
    }
    return { element, update, dispose() {} };
}

function screenerPanel(ctx) {
    const element = h('div', 'panel vt-form-panel'), form = h('div', 'vt-form-grid'), result = h('div', 'vt-list');
    const board = nativeSelect([['all', '当前行情源全部股票'], ['favorites', '自选'], ...boards().map(b => [b.id, b.name])], 'all');
    const indicator = nativeSelect(Object.entries(INDICATORS).map(([id, spec]) => [id, spec.name]), 'ma');
    const fields = { ma: ['MA'], ema: ['EMA'], boll: ['MID', 'UPPER', 'LOWER'], macd: ['DIF', 'DEA', 'MACD'],
        kdj: ['K', 'D', 'J'], rsi: ['RSI'] };
    const output = nativeSelect([['MA', 'MA']]), operator = nativeSelect([['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤']]);
    const threshold = nativeInput('number', '10');
    const syncFields = () => { output.replaceChildren(); for (const key of fields[indicator.value]) { const option = h('option', '', key); option.value = key; output.append(option); } };
    indicator.addEventListener('change', syncFields);
    form.append(field('板块', board), field('指标', indicator), field('字段', output), field('比较', operator), field('阈值', threshold,
        '价格指标填写元，MACD 用元；KDJ / RSI 填写数值。'));
    let symbols = [];
    element.append(form, nativeButton('执行筛选', async () => {
        try {
            const number = Number(threshold.value);
            if (!Number.isFinite(number)) throw new Error('阈值须为数字。');
            const scale = ['ma', 'ema', 'boll', 'macd'].includes(indicator.value) ? 100 : 1;
            symbols = []; let offset = 0, more;
            do {
                const reply = await command({ command: 'ScreenBoard', sessionId: ctx.store.sessionId,
                    boardId: board.value, analysis: indicator.value, field: output.value, operator: operator.value,
                    value: number * scale, offset, limit: 200 });
                symbols.push(...reply.screening.symbols);
                more = reply.screening.hasMore; offset = reply.screening.nextOffset;
                result.textContent = `已检查 ${offset} / ${reply.screening.total} 只证券…`;
            } while (more);
            draw();
        } catch (error) { ctx.notify(error.message, 'danger'); }
    }), nativeButton('结果另存为板块', async () => {
        if (!symbols.length) { ctx.notify('先执行筛选并取得结果。', 'warning'); return; }
        const name = await promptText({ title: '保存筛选结果', label: '板块名称', placeholder: '筛选结果' });
        if (!name) return;
        try { await boardStore.change('save', { name, symbols }); ctx.notify(`已保存“${name}”。`, 'success'); }
        catch (error) { ctx.notify(error.message, 'danger'); }
    }), result);
    const draw = () => result.replaceChildren(h('p', 'muted', `筛出 ${symbols.length} 只证券${symbols.length > 200 ? '，显示前 200 只' : ''}`), ...symbols.slice(0, 200).map(symbol => {
        const row = nativeButton(`${ctx.store.quote(symbol)?.name || symbol} · ${symbol}`, () => ctx.select(symbol));
        row.classList.add('vt-result'); return row;
    }));
    return { element, update() {}, dispose() {} };
}

function trainingPanel(ctx) {
    const element = h('div', 'panel vt-form-panel'), form = h('div', 'vt-form-grid'), result = h('div', 'vt-list');
    const source = nativeSelect([['demo', '合成演示数据']]), start = nativeInput('date'), seed = nativeInput('text', crypto.randomUUID().slice(0, 12));
    const blind = h('input'); blind.type = 'checkbox';
    const cash = nativeInput('number', '100000');
    const reveal = nativeButton('揭晓盲测标的', async () => {
        try { await ctx.store.write('RevealTraining'); update(); } catch (error) { ctx.notify(error.message, 'danger'); }
    });
    form.append(field('数据源', source), field('指定起点', start, '留空按种子抽取'), field('随机种子', seed),
        field('盲测', blind, '隐藏证券名称和真实日期'), field('初始资金（元）', cash));
    let timer = null, playing = false;
    const play = nativeButton('自动播放', () => {
        playing = !playing; play.textContent = playing ? '暂停播放' : '自动播放';
        if (!playing) { clearTimeout(timer); return; }
        const step = async () => {
            if (!playing) return;
            try {
                if (!ctx.store.observation?.canAdvance) { playing = false; play.textContent = '自动播放'; update(); return; }
                await ctx.store.write('AdvanceDay'); update(); timer = setTimeout(step, 800);
            } catch (error) { playing = false; play.textContent = '自动播放'; ctx.notify(error.message, 'danger'); }
        };
        void step();
    });
    element.append(form, nativeButton('创建人与 Agent 同起点训练', async () => {
        try {
            const cents = Math.round(Number(cash.value) * 100);
            if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('初始资金无效。');
            const pair = (await command({ command: 'CreateTrainingPair', requestId: crypto.randomUUID(),
                ...(source.value.startsWith('feed-') ? { sourceId: source.value } : { datasetId: source.value }),
                ...(start.value ? { startDate: start.value } : {}), randomSeed: seed.value.trim() || 'training',
                blind: blind.checked, initialCashCents: cents })).trainingPair;
            local.set(`vtrade-training-pair:${pair.pairId}`, { human: pair.human.sessionId, agent: pair.agent.sessionId });
            local.set('vtrade-training-last-pair', pair.pairId);
            ctx.notify(`训练已创建。Agent 运行标识：${pair.agent.sessionId}`, 'success');
            await ctx.openRun(pair.human.sessionId); update();
        } catch (error) { ctx.notify(error.message, 'danger'); }
    }), nativeButton('推进一天', async () => {
        try { await ctx.store.write('AdvanceDay'); update(); } catch (error) { ctx.notify(error.message, 'danger'); }
    }), play, reveal, result);
    async function loadSources() {
        try {
            const sources = await command({ command: 'GetSources' });
            const list = [...sources.dataFeeds.map(f => [f.sourceId, f.source.name]),
                ...sources.sources.filter(s => s.datasetId !== 'demo' && s.source.kind !== 'training-blind')
                    .map(s => [s.datasetId, s.source.name])];
            for (const [id, label] of list) { const option = h('option', '', label); option.value = id; source.append(option); }
            if (list.some(([id]) => id === 'demo-workbench')) source.value = 'demo-workbench';
        } catch (error) { ctx.notify(error.message, 'danger'); }
    }
    void loadSources();
    async function update() {
        const o = ctx.store.observation;
        reveal.hidden = !o?.training?.blind || o.training.revealed;
        if (!o?.training) { result.replaceChildren(h('p', 'muted', '创建训练后，可逐日推进或自动播放。Agent 在 VCPChat 使用同一套 VTrade 工具操作其独立账本。')); return; }
        try {
            const score = (await command({ command: 'GetTrainingResult', sessionId: o.sessionId })).trainingResult;
            const pair = await trainingPairSessions(o.training.pairId);
            const lines = [`训练日 ${score.days} · 收益 ${pct(score.totalReturn)} · 最大回撤 ${pct(-score.maxDrawdown)}`,
                `平仓 ${score.closedTrades} 笔 · 胜率 ${pct(score.winRate)} · 买入持有基准 ${pct(score.buyHoldReturn)}`,
                `随机种子 ${o.training.seed} · ${o.training.blind && !o.training.revealed ? '盲测中' : o.date}`];
            if (score.original) lines.push(`已揭晓：${score.original.symbol} · 原始起点 ${score.original.startDate}`);
            result.replaceChildren(...lines.map(line => h('p', '', line)));
            if (pair?.agent) result.append(h('p', 'muted', `Agent 运行标识：${pair.agent}`),
                nativeButton('复制 Agent 运行标识', () => navigator.clipboard.writeText(pair.agent).then(() => ctx.notify('已复制。'))));
        } catch (error) { ctx.notify(error.message, 'danger'); }
    }
    return { element, update, dispose() { playing = false; clearTimeout(timer); } };
}

function aiPanel(ctx) {
    const element = h('div', 'panel vt-form-panel'), content = h('div', 'vt-list');
    const preset = nativeSelect([['observe', '只读观察与计划'], ['one-day', '自主决策一日'], ['ten-days', '连续训练十日']]);
    element.append(field('VCPChat 操作预设', preset), content);
    async function update() {
        const o = ctx.store.observation;
        if (!o?.training) { content.replaceChildren(h('p', 'muted', '请先在训练控制面板创建同起点训练。')); return; }
        const pair = await trainingPairSessions(o.training.pairId);
        if (!pair) { content.replaceChildren(h('p', 'muted', `训练组 ${o.training.pairId}。可在 VCPChat 对 Agent 运行使用 VTrade 工具。`)); return; }
        try {
            const [human, agent] = await Promise.all([pair.human, pair.agent].map(sessionId =>
                command({ command: 'GetTrainingResult', sessionId }).then(reply => reply.trainingResult)));
            content.replaceChildren(h('strong', '', '人与 Agent 同起点对照'),
                h('p', '', `人工：${pct(human.totalReturn)} · 回撤 ${pct(-human.maxDrawdown)} · ${human.closedTrades} 笔平仓`),
                h('p', '', `Agent：${pct(agent.totalReturn)} · 回撤 ${pct(-agent.maxDrawdown)} · ${agent.closedTrades} 笔平仓`),
                h('p', 'muted', `Agent 运行标识：${pair.agent}`),
                nativeButton('复制给 VCPChat 的操作说明', async () => {
                    const scope = preset.value === 'observe' ? '只读观察并保存计划，不下单也不推进日期。'
                        : preset.value === 'one-day' ? '自主分析当前已观察行情，必要时计划并模拟下单，然后只推进一个数据日，读取回执并复盘。'
                            : '重复单日决策最多十个数据日；每次先读观察和回执，失败或达到数据末尾立即停止。';
                    const prompt = `请在 VCPChat 使用 VTrade 工具操作模拟训练账本 ${pair.agent}。${scope}`
                        + ' 只使用该账本模拟日及以前的行情，不调用 GetMarketSecurities、GetMarketQuotes 或 GetMarketBars。'
                        + ' 写入时使用最新 observationId、expectedRevision 和唯一 requestId；所有操作均为虚拟交易。';
                    await navigator.clipboard.writeText(prompt); ctx.notify('已复制操作说明，在 VCPChat 中发给选定的 Agent。', 'success');
                }),
                nativeButton('切换到 Agent 账本', () => ctx.openRun(pair.agent)));
        } catch (error) { content.replaceChildren(h('p', 'muted', error.message)); }
    }
    return { element, update, dispose() {} };
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
    chart: { title: '图表', icon: 'candlestick_chart', description: '日、周、月、季、年及已导入分钟 K 线；主图与副图内置经典指标。', create: chartPanel },
    quote: { title: '个股行情', icon: 'show_chart', description: '最新价、开高低收、成交额、振幅及区间涨跌。', create: quotePanel },
    order: { title: '下单', icon: 'receipt', run: true, description: '预览并记录模拟买卖意图，附账户摘要。', create: orderPanel },
    positions: { title: '持仓', icon: 'account_balance_wallet', run: true, description: '数量、可卖数量、成本、市值及浮动盈亏。', create: positionsPanel },
    orders: { title: '委托与成交', icon: 'history', run: true, description: '待结算、虚拟成交、未完成及已撤销记录。', create: ordersPanel },
    journal: { title: '日志', icon: 'menu_book', run: true, description: '计划、意图、结算、推进及复盘的完整记录。', create: journalPanel },
    equity: { title: '资金曲线', icon: 'show_chart', run: true, description: '每日权益、收益率及最大回撤。', create: equityPanel },
    conditional: { title: '条件单', icon: 'tune', run: true, description: '止损、止盈、移动止损、到价买入和 OCO。', create: conditionalPanel },
    // Replaced by the 对决 page; kept so saved layouts that contain them still open, but no longer offered in the library.
    training: { title: '训练控制', icon: 'school', run: true, retired: true, description: '指定日期或随机开局、盲测、逐日或自动播放、成绩单。', create: trainingPanel },
    ai: { title: 'AI 对照', icon: 'smart_toy', run: true, retired: true, description: '查看人与 Agent 同起点训练的成绩。', create: aiPanel },
    guide: { title: '获取数据', icon: 'info', description: '通达信、AKShare、baostock 及自有数据的接入方式。', create: () => {
        const element = h('div', 'panel panel-guide'); element.append(dataGuide());
        return { element, update() {}, dispose() {} };
    } },
    screener: { title: '条件选股', icon: 'funnel', run: true, description: '用内置经典指标筛选本次运行的证券池，结果可存为板块。', create: screenerPanel },
});
