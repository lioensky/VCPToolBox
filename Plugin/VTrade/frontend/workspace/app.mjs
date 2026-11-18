// Safe crypto polyfill
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
    crypto.randomUUID = function() {
        if (typeof crypto.getRandomValues === 'function') {
            return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, function(c) {
                return (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16);
            });
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    };
}
import VCPUI from '../vendor/vcp-ui/vcp-ui.js';
import { DockLayout, LINKS, uid, normalize } from './dock.mjs';
import { PANELS, simulationOnly, setBoardStore } from './panels.mjs';
import { PRESETS } from './presets.mjs';
import { Store, MarketStore, BoardStore, local, ruleName } from './store.mjs';
import { openNotice, needsNotice } from './notice.mjs';
import { SettingsView } from './settings.mjs';

const store = new Store(), market = new MarketStore(), boardStore = new BoardStore();
setBoardStore(boardStore);
const body = document.body;
const notify = (message, variant = 'info') => VCPUI.feedback.toast(message, { variant: variant === 'danger' ? 'critical' : variant });
const h = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text) e.textContent = text; return e; };

// Preferences live in this browser only: look and feel, plus order-ticket defaults.
const DEFAULTS = { theme: 'dark', density: 'compact', trend: 'red-up', tooltips: true, quantity: 100, confirm: false, rules: 'reference' };
const prefs = {
    get: () => ({ ...DEFAULTS, ...local.get('vtrade-next-prefs', {}) }),
    set(patch) { local.set('vtrade-next-prefs', { ...prefs.get(), ...patch }); applyPrefs(); },
};
const systemLight = matchMedia('(prefers-color-scheme: light)');
let titleObserver = null;
function applyPrefs() {
    const p = prefs.get();
    body.dataset.vcpTheme = p.theme === 'system' ? (systemLight.matches ? 'light' : 'dark') : p.theme;
    body.dataset.trend = p.trend;
    VCPUI.setDensity(body, p.density);
    theme?.update({ icon: body.dataset.vcpTheme === 'light' ? 'dark_mode' : 'light_mode' });
    // VCPUI icon buttons carry a native title; it can be switched off without losing the accessible label.
    titleObserver?.disconnect(); titleObserver = null;
    const sweep = root => root.querySelectorAll?.('.vcp-ui-icon-button').forEach(button => {
        if (p.tooltips) button.title = button.getAttribute('aria-label') || '';
        else button.removeAttribute('title');
    });
    sweep(body);
    if (!p.tooltips) {
        titleObserver = new MutationObserver(records => records.forEach(r => r.addedNodes.forEach(node => {
            if (node.nodeType !== 1) return;
            if (node.matches('.vcp-ui-icon-button')) node.removeAttribute('title');
            sweep(node);
        })));
        titleObserver.observe(body, { childList: true, subtree: true });
    }
}
systemLight.addEventListener('change', () => { if (prefs.get().theme === 'system') applyPrefs(); });

// Layouts: built-in presets plus named layouts the user saves. Each layout is either for browsing the market
// or for working in a simulation; edits persist per layout.
const customs = () => local.get('vtrade-next-custom-layouts', []);
let preset = local.get('vtrade-next-preset', 'watch');
if (!PRESETS[preset] && !customs().some(c => c.id === preset)) preset = 'watch';
const layoutKey = id => 'vtrade-next-layout-v2:' + id;
// The first workbench build opened each run on its whole source pool. Switch those saved defaults once
// to the shared favorites board; explicit choices made afterwards remain untouched.
if (!local.get('vtrade-run-watchlist-v3', false)) {
    for (const id of ['trade', 'review', 'duel']) {
        const saved = local.get(layoutKey(id));
        if (!saved?.panels) continue;
        for (const panel of Object.values(saved.panels)) {
            panel.state ||= {};
            if (panel.kind === 'watchlist' && (!panel.state.board || panel.state.board === 'all')) panel.state.board = 'favorites';
        }
        local.set(layoutKey(id), saved);
    }
    local.set('vtrade-run-watchlist-v3', true);
}
const fresh = id => PRESETS[id] ? PRESETS[id].make() : structuredClone(customs().find(c => c.id === id)?.model || PRESETS.watch.make());
const modeOf = id => PRESETS[id]?.mode || customs().find(c => c.id === id)?.mode || 'market';
const mode = () => modeOf(preset);
const layouts = {
    list: () => [...Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, builtin: true, mode: p.mode })),
        ...customs().map(c => ({ id: c.id, label: c.label, builtin: false, mode: c.mode || 'market' }))],
    current: () => layouts.list().find(l => l.id === preset) || layouts.list()[0],
    apply: id => applyPreset(id),
    reset: id => applyPreset(id, true),
    saveAs(label) {
        const id = uid('layout');
        local.set('vtrade-next-custom-layouts', [...customs(), { id, label, mode: mode(), model: structuredClone(dock.model) }].slice(-6));
        applyPreset(id); notify(`已保存布局方案“${label}”。`, 'success');
    },
    rename(id, label) { local.set('vtrade-next-custom-layouts', customs().map(c => c.id === id ? { ...c, label } : c)); syncPresetControl(); },
    remove(id) {
        local.set('vtrade-next-custom-layouts', customs().filter(c => c.id !== id));
        try { localStorage.removeItem(layoutKey(id)); } catch { /* storage unavailable */ }
        applyPreset('watch');
    },
    exportCurrent: () => ({ format: 'vtrade-layout', version: 1, label: layouts.current().label, mode: mode(), model: dock.model }),
    importModel(input, label) {
        const model = input?.format === 'vtrade-layout' ? input.model : input;
        if (!model?.root || !model.panels || !Object.values(model.panels).every(p => PANELS[p?.kind] && typeof p.state === 'object')) {
            throw new Error('不是有效的 VTrade 布局文件。');
        }
        const ids = new Set(Object.keys(model.panels));
        const tabs = node => node.type === 'group' ? node.tabs : node.children.flatMap(tabs);
        if (!normalize(structuredClone(model.root)) || !tabs(model.root).every(id => ids.has(id))) throw new Error('布局结构不完整。');
        const id = uid('layout');
        local.set('vtrade-next-custom-layouts', [...customs(), { id, label: String(input.label || label || '导入的布局').slice(0, 20),
            mode: input.mode === 'run' ? 'run' : 'market', model }].slice(-6));
        applyPreset(id);
    },
};

const links = local.get('vtrade-next-links', {});
const instances = new Map();
function symbolOf(panel) {
    const pick = panel.link ? links[panel.link] : panel.state.symbol;
    if (mode() === 'market') return market.security(pick) ? pick
        : boardStore.state.favorites.find(symbol => market.security(symbol))
            || (market.security('SH.000001') ? 'SH.000001' : market.securities[0]?.symbol || null);
    if (store.observation?.marketDirectory) return store.sessionBySymbol.has(pick) ? pick
        : boardStore.state.favorites.find(symbol => store.sessionBySymbol.has(symbol))
            || store.sessionSecurities.find(security => security.kind === 'stock')?.symbol || null;
    return store.quote(pick) ? pick : boardStore.state.favorites.find(symbol => store.quote(symbol)) || null;
}

// Top bar. Browsing shows the data directory's state; a simulation shows its account, clock and controls.
const runPicker = VCPUI.create('Select', { options: [], placeholder: '选择模拟交易', size: 'sm' });
const dateBadge = VCPUI.create('Badge', { label: '—' }), stateBadge = VCPUI.create('Badge', { label: '未打开' });
const marketBadge = VCPUI.create('Badge', { label: '正在读取本机行情' });
const icon = (name, label, onClick, extra) => {
    const c = VCPUI.create('IconButton', { icon: name, label, size: 'sm', ...extra });
    c.element.addEventListener('click', onClick);
    return c;
};
const pause = icon('pause', '暂停模拟', () => act(store.observation?.paused ? 'ResumeSession' : 'PauseSession'));
const next = icon('skip-forward', '推进到下一数据日', () => act('AdvanceDay'));
const reload = icon('refresh', '刷新本机行情', () => { market.charts.clear(); market.load().then(() => notify('已刷新本机行情。', 'success')); });
const presetControl = VCPUI.create('SegmentedControl', { items: [], size: 'sm', label: '布局方案' });
// 对决 has its own page: rounds on historical problems, alone or with Agents.
const duelLink = VCPUI.create('Button', { label: '对决', variant: 'secondary', size: 'sm' });
duelLink.element.addEventListener('click', () => { location.href = '../duel/'; });
const addPanel = icon('add', '添加面板', () => openLibrary());
const help = icon('info', '免责声明与获取数据', () => openNotice());
const gear = icon('settings', '设置', () => toggleSettings());
const theme = icon('light_mode', '切换深浅色', () => prefs.set({ theme: body.dataset.vcpTheme === 'light' ? 'dark' : 'light' }));
const title = h('div', 'ws-title');
const runControls = h('div', 'ws-run'); runControls.append(runPicker.element, dateBadge.element, stateBadge.element, pause.element, next.element);
const marketControls = h('div', 'ws-run'); marketControls.append(marketBadge.element, reload.element);
title.append(h('span', 'ws-brand', 'VTrade'), marketControls, runControls);
const actions = h('div', 'ws-actions');
actions.append(presetControl.element, duelLink.element, addPanel.element, help.element, theme.element, gear.element);
const dockRoot = h('div', 'ws-dock'), footer = h('footer', 'ws-footer');
const settings = new SettingsView({ store, market, boardStore, notify, prefs, layouts,
    onOpenRun: id => openRun(id).then(() => toggleSettings(false)), onMarketChanged: () => market.load() });
const content = h('div', 'ws-content'); content.append(dockRoot, settings.element, footer);
const shell = VCPUI.create('AppPageShell', { title, actions: [actions], content, windowControls: false });
body.append(shell.element);
applyPrefs();

function toggleSettings(open = !settings.open, section) {
    if (open) settings.show(section); else settings.hide();
    dockRoot.hidden = open;
    gear.update({ active: open, label: open ? '关闭设置' : '设置' });
    if (!open) for (const g of dock.groups()) dock.mounted.get(g.active)?.shown?.();
}
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && settings.open && !document.querySelector('.vcp-ui-modal-overlay')) { event.preventDefault(); toggleSettings(false); return; }
    // Keyboard search as in TDX: typing a code or pinyin initials anywhere starts a search in the market list.
    const target = event.target;
    if (settings.open || event.ctrlKey || event.metaKey || event.altKey || !/^[0-9A-Za-z]$/.test(event.key)) return;
    if (target.closest?.('input, textarea, select, [contenteditable="true"], .vcp-ui-modal-overlay')) return;
    const list = [...instances.values()].find(i => i.focusSearch && i.element.isConnected && i.element.offsetParent);
    if (list) { event.preventDefault(); list.focusSearch(event.key); }
});

const dock = new DockLayout(dockRoot, {
    mount(id) {
        const panel = dock.model.panels[id], kind = PANELS[panel.kind];
        const ctx = { store, market, panel, notify, prefs, mode, symbol: () => symbolOf(panel),
            save: () => local.set(layoutKey(preset), dock.model),
            refresh: () => refresh(),
            openRun,
            openSettings: section => toggleSettings(true, section),
            openSimulation,
            select(symbol) {
                if (panel.link) { links[panel.link] = symbol; local.set('vtrade-next-links', links); }
                else panel.state.symbol = symbol;
                ctx.save(); refresh(panel.link ? p => p.link === panel.link : p => p === panel);
                if (store.observation?.marketDirectory) store.loadSessionQuotes([symbol]).then(() =>
                    refresh(panel.link ? p => p.link === panel.link : p => p === panel))
                    .catch(error => notify(error.message, 'danger'));
            } };
        const instance = (mode() === 'market' && kind.run ? simulationOnly(kind) : kind.create)(ctx);
        instance.element.dataset.panel = id;
        instances.set(id, instance);
        queueMicrotask(() => instance.update());
        return { element: instance.element, shown: () => instance.shown?.(),
            dispose() { instance.dispose(); instances.delete(id); } };
    },
    describe(id) {
        const panel = dock.model.panels[id];
        return { title: PANELS[panel.kind].title, link: panel.link };
    },
    onChange: model => local.set(layoutKey(preset), model),
    onAdd: groupId => openLibrary(groupId),
    onLink(id, choice) {
        const panel = dock.model.panels[id], order = [null, 'a', 'b', 'c'];
        panel.link = choice !== undefined ? choice : order[(order.indexOf(panel.link) + 1) % order.length];
        if (!panel.link) panel.state.symbol = symbolOf({ link: 'a', state: {} });
        dock.render(); local.set(layoutKey(preset), dock.model);
        notify(panel.link ? `“${PANELS[panel.kind].title}”已加入${LINKS[panel.link]}，将随该组切换证券。` : `“${PANELS[panel.kind].title}”已取消联动，保留当前证券。`);
        instances.get(id)?.update();
    },
    empty() {
        const empty = VCPUI.create('EmptyState', { icon: 'dashboard', title: '当前布局没有面板',
            description: '可通过右上角添加面板，或在设置中恢复布局方案。' });
        return empty.element;
    },
});

function refresh(filter = () => true) {
    for (const [id, instance] of instances) if (filter(dock.model.panels[id])) instance.update();
}
function syncPresetControl() {
    presetControl.update({ items: layouts.list().map(l => ({ value: l.id, label: l.label })), value: preset });
}
function applyPreset(id, reset = false) {
    preset = id; local.set('vtrade-next-preset', id);
    const saved = reset ? null : local.get(layoutKey(id));
    const model = saved?.root && saved.panels ? saved : fresh(id);
    renderChrome();
    dock.setModel(model); local.set(layoutKey(id), model);
    syncPresetControl();
}
presetControl.element.addEventListener('change', () => {
    const value = presetControl.element.querySelector('[aria-checked="true"]')?.dataset.value;
    if (value && value !== preset) applyPreset(value);
    if (settings.open) toggleSettings(false);
});
function openSimulation() {
    if (mode() === 'market') applyPreset(layouts.list().find(l => l.mode === 'run')?.id || 'trade');
    if (!store.sessions.length) { toggleSettings(true, 'runs'); notify('尚无模拟交易，请先新建一次。', 'info'); }
}

function openLibrary(groupId) {
    const grid = h('div', 'ws-library');
    let modal;
    for (const [kind, spec] of Object.entries(PANELS)) {
        if (spec.retired || (mode() === 'market' && spec.run)) continue;
        const card = VCPUI.create('Card', { interactive: true, title: spec.title, description: spec.description });
        card.element.prepend(window.VCPIcons?.create?.(spec.icon, { size: 20 }) || h('span'));
        card.element.addEventListener('click', () => {
            const id = uid('p');
            dock.model.panels[id] = { kind, link: 'a', state: {} };
            if (settings.open) toggleSettings(false);
            dock.add(id, groupId);
            modal.close(kind);
        });
        grid.append(card.element);
    }
    const cancel = VCPUI.create('Button', { label: '取消', variant: 'ghost', size: 'sm' });
    modal = VCPUI.create('Modal', { title: mode() === 'market' ? '添加面板（看盘）' : '添加面板（模拟交易）', size: 'lg', content: grid, actions: [cancel] });
    cancel.element.addEventListener('click', () => modal.close(null));
    body.append(modal.element);
}

async function act(command) {
    if (!store.observation) return;
    try {
        const result = await store.write(command);
        if (command === 'AdvanceDay') {
            const fills = store.observation.journal.filter(e => e.date === result.receipt.date && ['virtual-fill', 'unfilled'].includes(e.kind));
            notify(`已推进到 ${result.receipt.date}` + (fills.length ? `，${fills.length} 笔结算记录` : ''), 'success');
        }
    } catch (error) { notify(error.message, error.code === 'WAITING_DATA' || error.code === 'FINISHED' ? 'warning' : 'danger'); }
}
async function openRun(id) {
    if (mode() === 'market') applyPreset(layouts.list().find(l => l.mode === 'run')?.id || 'trade');
    await store.open(id);
    await store.loadSessions();
    runPicker.update({ value: id });
}

const NOTICE = '模拟环境，使用虚拟资金 · 理财有风险，投资需谨慎';
function renderChrome() {
    const browsing = mode() === 'market', o = store.observation;
    marketControls.hidden = !browsing; runControls.hidden = browsing;
    if (browsing) {
        const s = market.status;
        marketBadge.update({ label: market.error ? '未读取到本机行情' : s ? `本机通达信 · 截至 ${s.lastDate || '—'}` : '正在读取本机行情',
            variant: market.error ? 'warning' : s ? 'accent' : 'neutral' });
        footer.textContent = s ? `${s.directory} · 股票 ${s.stocks} · 指数 ${s.indices} · 基金 ${s.funds} · ${NOTICE}` : NOTICE;
        return;
    }
    dateBadge.update({ label: o ? `模拟日 ${o.date}` : '—', variant: o ? 'accent' : 'neutral' });
    const state = !o ? ['未打开', 'neutral'] : o.paused ? ['已暂停', 'warning'] : o.waitingForData ? ['等待新日线', 'warning']
        : o.finished ? ['回放结束', 'neutral'] : ['进行中', 'success'];
    stateBadge.update({ label: state[0], variant: state[1] });
    pause.update({ icon: o?.paused ? 'play_arrow' : 'pause', label: o?.paused ? '继续模拟' : '暂停模拟', disabled: !o });
    next.update({ disabled: !o?.canAdvance });
    footer.textContent = o ? `${o.source.name} · ${ruleName(o.rulesProfile)} · 版本 ${o.revision} · ${NOTICE}` : NOTICE;
}
store.addEventListener('observation', () => {
    renderChrome(); if (mode() === 'run') refresh();
    if (store.observation?.marketDirectory) store.loadSessionSecurities().catch(error => notify(error.message, 'danger'));
});
store.addEventListener('sessions', event => {
    runPicker.update({ options: event.detail.map(s => ({ value: s.sessionId, label: s.name })), value: store.sessionId || '' });
});
runPicker.element.addEventListener('change', () => store.open(runPicker.element.value).catch(error => notify(error.message, 'danger')));
market.addEventListener('list', () => { renderChrome(); if (mode() === 'market') refresh(); });
store.addEventListener('sessionSecurities', () => { if (store.observation?.marketDirectory) refresh(); });
store.addEventListener('sessionQuotes', () => { if (store.observation?.marketDirectory) refresh(); });
boardStore.addEventListener('change', () => refresh(panel => panel.kind === 'watchlist'));
let quoteFrame = 0;
market.addEventListener('quotes', () => {
    if (mode() !== 'market' || quoteFrame) return;
    quoteFrame = requestAnimationFrame(() => { quoteFrame = 0; refresh(p => p.kind === 'watchlist'); });
});

applyPreset(preset);
if (needsNotice()) openNotice({ firstRun: true });
market.load();
boardStore.load().catch(error => notify(error.message, 'danger'));
(async () => {
    try {
        const sessions = await store.loadSessions();
        const remembered = local.get('vtrade-next-session');
        const target = sessions.find(s => s.sessionId === remembered) || sessions[0];
        if (target) { await store.open(target.sessionId); runPicker.update({ value: target.sessionId }); }
    } catch (error) { notify(error.message, 'danger'); }
})();
