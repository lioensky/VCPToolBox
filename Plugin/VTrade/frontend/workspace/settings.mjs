import VCPUI from '../vendor/vcp-ui/vcp-ui.js';
import { command, adminSettings, marketRequest, ruleName } from './store.mjs';
import { openNotice } from './notice.mjs';
import { promptText } from './dock.mjs';

// Full-page settings shown in place of the dock. Each section is rebuilt when opened, so it always reads fresh data.
const SECTIONS = [
    ['layout', '布局', 'dashboard_customize'], ['appearance', '外观', 'palette'], ['data', '数据', 'database'],
    ['runs', '模拟交易', 'play_circle'], ['trading', '交易', 'receipt'], ['extensions', '扩展', 'extension'], ['about', '关于', 'info'],
];
const SLOT_NAMES = { market: '行情源', analysis: '指标与信号', universe: '股票池与板块', execution: '撮合规则', broker: '券商接口', tool: 'AI 工具' };
const THIRD_PARTY = [
    ['VCPUI 组件库与 lucide-adapter', 'VCPChat', 'CC BY-NC-SA 4.0', '控件、样式令牌与图标适配'],
    ['Lucide 图标（子集）', '1.31.0', 'ISC', '图标'],
];
const INTERVALS = [{ value: '0', label: '手动同步' }, { value: '3600', label: '每小时自动同步' }, { value: '86400', label: '每天自动同步' }];
const h = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
const yuan = cents => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const completed = () => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date()).map(x => [x.type, x.value]));
    const day = `${p.year}-${p.month}-${p.day}`;
    return Number(p.hour) >= 18 ? day : new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10);
};

export class SettingsView {
    // prefs: { get(), set(patch) }; layouts: { list(), current(), apply(id), saveAs(label), rename(id, label), remove(id), reset(id), exportCurrent(), importModel(model, label) }
    constructor({ store, market, boardStore, notify, prefs, layouts, onOpenRun, onMarketChanged }) {
        Object.assign(this, { store, market, boardStore, notify, prefs, layouts, onOpenRun, onMarketChanged });
        this.controls = []; this.page = [];
        this.element = h('div', 'ws-settings'); this.element.hidden = true;
        this.nav = this.own(VCPUI.create('List', { items: [] }));
        this.content = h('div', 'ws-settings-content');
        const aside = h('nav', 'ws-settings-nav'); aside.append(h('strong', 'ws-settings-title', '设置'), this.nav.element);
        this.element.append(aside, this.content);
    }
    own(control) { this.controls.push(control); return control; }
    keep(control) { this.page.push(control); return control; }
    get open() { return !this.element.hidden; }
    show(section = this.currentSection || 'layout') {
        if (section !== this.currentSection) this.sourceDraft = null;
        this.element.hidden = false; this.currentSection = section;
        this.nav.update({ items: SECTIONS.map(([id, label, icon]) => ({ value: id, label, icon, selected: id === section, onClick: () => this.show(id) })) });
        this.page.forEach(c => c.destroy()); this.page = [];
        const [, label] = SECTIONS.find(s => s[0] === section);
        this.content.replaceChildren(h('h2', 'ws-settings-heading', label));
        Promise.resolve(this[section]()).catch(error => this.notify(error.message, 'danger'));
    }
    hide() { this.element.hidden = true; this.page.forEach(c => c.destroy()); this.page = []; }
    dispose() { this.hide(); this.controls.forEach(c => c.destroy()); }

    // Small builders over VCPUI controllers.
    section(title, summary, ...children) {
        const body = h('div', 'ws-settings-body'); body.append(...children.filter(Boolean));
        const control = this.keep(VCPUI.create('SettingsSection', { title, summary, content: body }));
        this.content.append(control.element);
        return body;
    }
    field(label, control, helper) { return this.keep(VCPUI.create('Field', { label, control, helper })).element; }
    segmented(label, items, value, onChange) {
        const control = this.keep(VCPUI.create('SegmentedControl', { items, value, label, size: 'sm' }));
        control.element.addEventListener('change', () => onChange(control.element.querySelector('[aria-checked="true"]')?.dataset.value));
        return control;
    }
    select(options, value, onChange) {
        const control = this.keep(VCPUI.create('Select', { options, value, size: 'sm' }));
        if (onChange) control.element.addEventListener('change', () => onChange(control.element.value));
        return control;
    }
    input(options = {}) { return this.keep(VCPUI.create('Input', { size: 'sm', ...options })); }
    value(control) { return (control.element.querySelector?.('input, textarea') || control.element).value.trim(); }
    button(label, onClick, variant = 'secondary', icon) {
        const control = this.keep(VCPUI.create('Button', { label, variant, size: 'sm', ...(icon ? { icon } : {}) }));
        control.element.addEventListener('click', async () => {
            control.update({ loading: true });
            try { await onClick(); } catch (error) { this.notify(error.message, 'danger'); } finally { control.update({ loading: false }); }
        });
        return control.element;
    }
    row(...children) { const e = h('div', 'ws-settings-row'); e.append(...children.filter(Boolean)); return e; }
    table(columns, rows, empty = '暂无') { return this.keep(VCPUI.create('TableFrame', { columns, rows, empty })).element; }

    layout() {
        const current = this.layouts.current();
        const list = this.keep(VCPUI.create('List', { items: this.layouts.list().map(item => ({ value: item.id, label: item.label,
            description: item.builtin ? '内置方案' : '自定义方案', icon: item.builtin ? 'dashboard' : 'dashboard_customize',
            selected: item.id === current.id, trailing: item.id === current.id ? '当前' : '',
            onClick: () => { this.layouts.apply(item.id); this.show('layout'); } })) }));
        list.element.classList.add('ws-settings-list');
        const file = h('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
        file.addEventListener('change', async () => {
            const chosen = file.files?.[0]; file.value = '';
            if (!chosen) return;
            try { this.layouts.importModel(JSON.parse(await chosen.text()), chosen.name.replace(/\.json$/i, '')); this.notify('布局已导入并应用。', 'success'); this.show('layout'); }
            catch (error) { this.notify(`无法导入布局：${error.message}`, 'danger'); }
        });
        this.section('布局方案', '选择后立即应用；对布局的拖动与调整会自动保存到当前方案。', list.element);
        this.section('管理当前方案', current.label, this.row(
            this.button('另存为新方案', async () => {
                const label = await promptText({ title: '另存为新方案', label: '方案名称', placeholder: '方案名称', confirmLabel: '保存' });
                if (label) { this.layouts.saveAs(label); this.show('layout'); }
            }, 'primary', 'save'),
            this.button('恢复为默认', () => { this.layouts.reset(current.id); this.notify(`“${current.label}”已恢复为默认。`); }, 'secondary', 'restart_alt'),
            !current.builtin && this.button('重命名', async () => {
                const label = await promptText({ title: '重命名方案', label: '方案名称', value: current.label });
                if (label) { this.layouts.rename(current.id, label); this.show('layout'); }
            }),
            !current.builtin && this.button('删除', async () => {
                if (await VCPUI.feedback.confirm({ title: '删除方案', message: `确定删除“${current.label}”吗？此操作不可撤销。`, confirmLabel: '删除', danger: true })) {
                    this.layouts.remove(current.id); this.show('layout');
                }
            }, 'danger', 'delete'),
        ));
        this.section('导入与导出', '布局文件只包含面板排列与面板设置，不包含行情、账户或模拟交易记录。', this.row(
            this.button('导出当前布局', () => {
                const url = URL.createObjectURL(new Blob([JSON.stringify(this.layouts.exportCurrent(), null, 2)], { type: 'application/json' }));
                const link = h('a'); link.href = url; link.download = `vtrade-layout-${current.label}.json`; link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            }, 'secondary', 'download'),
            this.button('导入布局文件', () => file.click(), 'secondary', 'upload'), file));
    }

    appearance() {
        const p = this.prefs.get();
        const tooltips = this.keep(VCPUI.create('Switch', { label: '显示图标按钮的悬停提示', checked: p.tooltips }));
        tooltips.element.addEventListener('change', () => this.prefs.set({ tooltips: tooltips.element.getAttribute('aria-checked') === 'true' }));
        this.section('主题', '深色与浅色均使用 VCP 组件库的颜色令牌。', this.field('配色',
            this.segmented('配色', [{ value: 'dark', label: '深色' }, { value: 'light', label: '浅色' }, { value: 'system', label: '跟随系统' }],
                p.theme, theme => this.prefs.set({ theme }))));
        this.section('显示', '', this.field('界面密度', this.segmented('界面密度', [{ value: 'compact', label: '紧凑' }, { value: 'comfortable', label: '舒适' }],
            p.density, density => this.prefs.set({ density }))),
        this.field('涨跌颜色', this.segmented('涨跌颜色', [{ value: 'red-up', label: '红涨绿跌' }, { value: 'green-up', label: '绿涨红跌' }],
            p.trend, trend => this.prefs.set({ trend })), '同时作用于 K 线、列表与盈亏数字。'), tooltips.element);
    }

    async data() {
        this.marketSection((await adminSettings({ action: 'market' })).market);
        const [sources, configs] = [await command({ command: 'GetSources' }), (await adminSettings({ action: 'sources' })).sources];
        const configured = h('div', 'ws-source-list');
        if (!configs.length) configured.append(h('p', 'muted', '尚未配置本机来源。添加来源时填写通达信 vipdoc 目录和要读取的证券。'));
        for (const source of configs) {
            const status = (await command({ command: 'GetDataStatus', sourceId: source.id })).dataStatus;
            const card = h('div', 'ws-source');
            const detail = status.revision
                ? `版本 ${status.revision} · 已确认至 ${status.completedThrough} · ${status.coverage?.length || 0} 只证券`
                    + (status.lastError ? ` · 上次同步失败：${source.lastMessage || status.lastError}` : '')
                : '尚未同步' + (status.lastError ? `，上次同步失败：${source.lastMessage || status.lastError}` : '');
            const scope = `${source.securities?.length ?? 0} 只证券` + (source.since ? `，自 ${source.since} 起` : '')
                + ` · ${INTERVALS.find(i => i.value === String(source.syncIntervalSeconds))?.label || `每 ${source.syncIntervalSeconds} 秒`}`;
            const info = h('div', 'ws-source-info');
            info.append(h('strong', '', source.name || source.id), h('span', 'muted', `${source.id} · ${source.origin === 'settings' ? '设置页面' : '配置文件'} · ${detail}`),
                h('span', 'muted', `目录 ${source.directory} · ${scope}`));
            const sync = this.button('同步', async () => {
                const result = (await command({ command: 'SyncSource', sourceId: source.id, requestId: crypto.randomUUID(),
                    ...(status.datasetId ? { expectedDataVersion: status.datasetId } : {}) })).sync;
                this.notify(result.changed ? `已同步：新增 ${result.added} 根日线，版本 ${result.revision}。` : '数据无变化。', 'success');
                this.show('data');
            }, 'secondary', 'sync');
            const actions = this.row(sync, source.origin === 'settings' && this.button('编辑', () => { this.sourceDraft = source; this.show('data'); }),
                source.origin === 'settings' && this.button('删除', async () => {
                    if (!await VCPUI.feedback.confirm({ title: '删除来源', danger: true, confirmLabel: '删除',
                        message: `删除“${source.name}”后不再同步；已同步的行情版本仍保留，现有模拟交易不受影响。` })) return;
                    await adminSettings({ action: 'removeSource', sourceId: source.id }); this.show('data');
                }, 'danger', 'delete'));
            card.append(info, actions);
            configured.append(card);
        }
        const add = this.button('添加本机来源', () => { this.sourceDraft = {}; this.show('data'); }, 'primary', 'add');
        const guide = this.button('数据获取说明', () => openNotice({ tab: 'data' }), 'ghost', 'info');
        this.section('模拟交易用的行情来源', '模拟交易使用同步后的固定行情版本，回放时不会读到未来数据；看盘不需要同步。', configured, this.row(add, guide));
        if (this.sourceDraft) this.sourceForm(this.sourceDraft);
        const feeds = new Set(sources.dataFeeds.map(f => f.datasetId));
        this.section('已导入的数据集', '固定数据集可用于历史回放；来源版本见上方。', this.table(
            [{ key: 'name', label: '名称' }, { key: 'count', label: '证券数' }, { key: 'range', label: '日期范围' }, { key: 'id', label: '标识' }],
            sources.sources.filter(s => !feeds.has(s.datasetId)).map(s => ({ name: s.source.name, count: s.securities.length,
                range: `${s.firstDate} 至 ${s.lastDate}`, id: s.datasetId.slice(0, 18) }))));
        this.importForm(sources);
        await this.minuteImportForm(sources);
    }
    // Browsing reads the TDX directory directly; an empty field falls back to the first local source's directory.
    marketSection(m) {
        const directory = this.input({ value: m.directory || '', placeholder: m.effective || 'D:/通达信/vipdoc' });
        const status = h('p', 'muted ws-source-probe', m.effective
            ? `当前使用 ${m.effective}（${m.origin === 'settings' ? '本页设置' : '沿用模拟交易行情来源的目录'}）。`
            : '尚未设置，看盘无法读取行情。');
        const save = this.button('保存', async () => {
            await adminSettings({ action: 'saveMarket', directory: this.value(directory) });
            this.notify('已保存看盘数据目录，正在重新读取行情。', 'success');
            this.onMarketChanged?.(); this.show('data');
        }, 'primary', 'save');
        const status2 = this.market?.status;
        this.section('看盘数据目录', '看盘直接读取通达信 vipdoc 目录下的全部日线，以及同级 T0002/hq_cache 中的证券名称与拼音简称；不复制、不改写这些文件。',
            this.field('通达信 vipdoc 目录', directory, '留空则沿用下方第一个行情来源的目录。'), this.row(save), status,
            status2 && h('p', 'muted ws-source-probe', `已读取股票 ${status2.stocks} 只、指数 ${status2.indices} 个、基金 ${status2.funds} 只，数据截至 ${status2.lastDate || '—'}`
                + (status2.namesFound ? '。' : '；未找到名称文件，列表只显示代码。')));
    }
    // Add or edit a settings-page source. Once synced, its securities and earliest date stay fixed.
    sourceForm(draft) {
        const locked = Boolean(draft.synced);
        const name = this.input({ value: draft.name || '本机通达信日线' });
        const directory = this.input({ value: draft.directory || '', placeholder: 'D:/通达信/vipdoc' });
        const list = this.keep(VCPUI.create('Textarea', { rows: 8, disabled: locked, placeholder: '600000 示例证券甲\n000000\nsz300000 示例证券乙',
            value: (draft.securities || []).map(s => {
                const code = s.symbol.slice(3);
                return s.symbol.slice(0, 2).toLowerCase() + code + (s.name && s.name !== code ? ` ${s.name}` : '');
            }).join('\n') }));
        const since = this.input({ value: draft.since || '', placeholder: 'YYYY-MM-DD，可留空', disabled: locked });
        const interval = this.select(INTERVALS, String(draft.syncIntervalSeconds ?? 0));
        const result = h('p', 'muted ws-source-probe');
        const input = () => ({ ...(draft.id ? { id: draft.id } : {}), name: this.value(name), directory: this.value(directory),
            securities: this.value(list), ...(this.value(since) ? { since: this.value(since) } : {}), syncIntervalSeconds: Number(interval.element.value) });
        const probe = this.button('检查目录', async () => {
            const p = (await adminSettings({ action: 'probe', directory: this.value(directory), securities: this.value(list) || undefined })).probe;
            const files = `沪市 ${p.counts.sh} 个、深市 ${p.counts.sz} 个、北交所 ${p.counts.bj} 个日线文件`;
            result.textContent = !p.counts.sh && !p.counts.sz && !p.counts.bj ? `${files}。请确认填写的是 vipdoc 目录。`
                : p.missing.length ? `${files}；未找到：${p.missing.join('、')}。` : `${files}${p.securities ? `；列出的 ${p.securities} 只证券均已找到` : ''}。`;
        }, 'secondary', 'search');
        const save = this.button(locked ? '保存' : '保存并同步', async () => {
            const saved = (await adminSettings({ action: 'saveSource', source: input() })).source;
            // The source exists from here on; a failed first sync is reported on its card, not by keeping the form open.
            this.sourceDraft = null;
            try {
                if (locked) this.notify(`已保存“${saved.name}”。`, 'success');
                else {
                    const sync = (await command({ command: 'SyncSource', sourceId: saved.id, requestId: crypto.randomUUID() })).sync;
                    this.notify(`已保存“${saved.name}”并同步 ${sync.added} 根日线。`, 'success');
                }
            } catch (error) { this.notify(`已保存“${saved.name}”，但同步失败：${error.message}`, 'danger'); }
            this.show('data');
        }, 'primary', 'save');
        const cancel = this.button('取消', () => { this.sourceDraft = null; this.show('data'); }, 'ghost');
        const grid = h('div', 'ws-settings-grid');
        grid.append(this.field('名称', name), this.field('自动同步', interval));
        this.section(draft.id ? `编辑来源 · ${draft.id}` : '添加本机来源', '只读取列出的 sh/sz/bj lday 日线文件，不读取目录中的其他内容。', grid,
            this.field('通达信数据目录', directory, '填写 vipdoc 目录的完整路径，其下应有 sh/lday、sz/lday 等子目录。'),
            this.row(probe), result,
            this.field('证券', list, locked ? '已同步的来源不能更改证券列表；如需调整，请添加新来源。'
                : '每行一只：6 位代码，可加市场前缀和名称；最多 100 只。'),
            this.field('最早日期', since, '只读取此日期以后的日线。每个来源合计不超过 5 万根日线，约为 10 只证券的完整历史。'),
            this.row(save, cancel));
    }
    importForm(sources) {
        const format = this.select([{ value: 'json', label: '标准 JSON（含下载脚本输出）' }, { value: 'tdx', label: '通达信 .day 日线' }], 'json');
        const target = this.select([{ value: '', label: '新建来源' }, ...sources.dataFeeds.map(f => ({ value: f.sourceId, label: `${f.source.name} · 版本 ${f.revision}` }))], '');
        const through = this.input({ value: completed(), placeholder: 'YYYY-MM-DD' });
        const symbol = this.input({ placeholder: '.day 文件必填，如 SH.000000' });
        const file = h('input', 'ws-file'); file.type = 'file'; file.accept = '.json,.day';
        const submit = this.button('校验并导入', async () => {
            const chosen = file.files?.[0];
            if (!chosen) throw new Error('请选择文件。');
            const kind = format.element.value, sourceId = target.element.value;
            const feed = sources.dataFeeds.find(f => f.sourceId === sourceId);
            const body = { format: kind, requestId: crypto.randomUUID(), completedThrough: this.value(through),
                ...(sourceId ? { sourceId, expectedDataVersion: feed.datasetId } : {}) };
            if (kind === 'json') body.dataset = JSON.parse(await chosen.text());
            else {
                const bytes = new Uint8Array(await chosen.arrayBuffer());
                let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                Object.assign(body, { dataBase64: btoa(binary), symbol: this.value(symbol), name: this.value(symbol) });
            }
            const access = (() => { try { return sessionStorage.getItem('vtrade-access') || ''; } catch { return ''; } })();
            const response = await fetch('../api/import', { method: 'POST', body: JSON.stringify(body),
                headers: { 'Content-Type': 'application/json', 'X-VTrade-Request': '1', 'X-VTrade-Access': access } });
            const result = await response.json();
            if (!result.ok) throw new Error(result.error || '导入失败。');
            this.notify(`已导入：来源 ${result.sourceId}，版本 ${result.revision}，新增 ${result.added} 根日线。`, 'success');
            this.show('data');
        }, 'primary', 'upload');
        const grid = h('div', 'ws-settings-grid');
        grid.append(this.field('格式', format), this.field('写入目标', target, '已有来源只接受新增的日线'),
            this.field('已确认收盘的截止日', through), this.field('证券标识', symbol), this.field('文件', file, '单个文件最大 8 MB'));
        this.section('导入行情', '价格须为不复权日线；同日数据冲突时整批拒绝，原版本保持不变。', grid, this.row(submit));
    }

    async minuteImportForm(sources) {
        const [knownReply, directory] = await Promise.all([marketRequest({ action: 'minuteSources' }),
            adminSettings({ action: 'market' })]);
        const known = knownReply.minuteSources;
        const refs = [...(directory.market.effective ? [{ value: 'market-directory', label: '本机通达信全市场' }] : []),
            ...sources.dataFeeds.map(f => ({ value: f.sourceId, label: `${f.source.name} · 来源` })),
            ...sources.sources.filter(s => !sources.dataFeeds.some(f => f.datasetId === s.datasetId))
                .map(s => ({ value: s.datasetId, label: s.source.name }))];
        const format = this.select([{ value: 'minute-json', label: '一分钟 JSON' }, { value: 'minute-csv', label: '一分钟 CSV' }], 'minute-json');
        const daily = this.select(refs, refs[0]?.value || 'demo');
        const source = this.input({ value: 'minute-local', placeholder: 'minute- 开头的来源标识' });
        const name = this.input({ value: '本机一分钟线' });
        const file = h('input', 'ws-file'); file.type = 'file'; file.accept = '.json,.csv';
        const submit = this.button('导入一分钟线', async () => {
            const chosen = file.files?.[0]; if (!chosen) throw new Error('请选择一分钟 JSON 或 CSV 文件。');
            const text = await chosen.text(), sourceId = this.value(source), previous = known.find(item => item.sourceId === sourceId);
            const body = { format: format.element.value, requestId: crypto.randomUUID(),
                ...(previous ? { expectedVersion: previous.version } : {}) };
            if (body.format === 'minute-json') body.dataset = JSON.parse(text);
            else Object.assign(body, { sourceId, dailyRef: daily.element.value, name: this.value(name), csv: text });
            const access = (() => { try { return sessionStorage.getItem('vtrade-access') || ''; } catch { return ''; } })();
            const response = await fetch('../api/import', { method: 'POST', body: JSON.stringify(body),
                headers: { 'Content-Type': 'application/json', 'X-VTrade-Request': '1', 'X-VTrade-Access': access } });
            const result = await response.json();
            if (!result.ok) throw new Error(result.error || '一分钟线导入失败。');
            this.notify(`一分钟线已导入：${result.minuteImport.sourceId}，新增 ${result.minuteImport.added} 根。`, 'success');
            this.show('data');
        }, 'primary', 'upload');
        this.section('一分钟线', '只接收本机文件，须提供完整 OHLCV；分钟线按上海交易时段聚合，日线模拟时钟与撮合规则不变。',
            this.table([{ key: 'name', label: '来源' }, { key: 'id', label: '标识' }, { key: 'daily', label: '关联日线' }, { key: 'count', label: '一分钟线' }],
                known.map(item => ({ name: item.name, id: item.sourceId, daily: item.dailyRef,
                    count: item.securities.reduce((sum, security) => sum + security.bars, 0) }))),
            this.row(this.field('格式', format), this.field('关联日线', daily)),
            this.row(this.field('来源标识', source), this.field('名称', name)),
            this.field('文件', file, 'JSON 含 schemaVersion、sourceId、dailyRef、securities；CSV 表头见 README。完整来源再次导入时应保留旧记录。'),
            this.row(submit));
    }

    async runs() {
        const sessions = (await command({ command: 'ListSessions' })).sessions, current = this.store.sessionId;
        const list = this.keep(VCPUI.create('List', { items: sessions.map(s => ({ value: s.sessionId, label: s.name,
            description: `${s.agentName} · 版本 ${s.revision}`, icon: 'play_circle', selected: s.sessionId === current,
            trailing: s.sessionId === current ? '当前' : '', onClick: () => this.onOpenRun(s.sessionId) })) }));
        list.element.classList.add('ws-settings-list');
        this.section('模拟交易记录', '一次模拟交易是一个虚拟账户加一条回放时间线，用于练习下单、复盘或让 AI 交易；看盘不需要它。选择后切换到该模拟交易。', list.element, current && this.row(this.button('查看当前模拟交易清单', async () => {
            const m = (await command({ command: 'GetRunManifest', sessionId: current })).manifest;
            const rows = [['回放方式', m.dataMode === 'continuous' ? '连续模拟' : '固定回放'], ['撮合规则', ruleName(m.rulesProfile)], ['起始日期', m.startDate],
                ['当前日期', m.asOf], ['初始资金', yuan(m.initialCashCents)],
                [m.marketDirectory ? '可交易范围' : '证券池', m.marketDirectory ? '本机行情源中模拟日已接入的全部股票' : m.symbols.join('、')],
                ...(m.marketDirectory ? [['账本涉及', m.symbols.join('、') || '尚无']] : []), ['价格口径', m.priceBasis],
                ['执行模型', m.execution], ['数据指纹', m.dataFingerprint.slice(0, 16)], ['配置摘要', m.configHash.slice(0, 16)]];
            const content = h('div'); content.append(this.table([{ key: 'k', label: '项目' }, { key: 'v', label: '内容' }], rows.map(([k, v]) => ({ k, v }))),
                h('p', 'muted', '局限：' + m.limitations.join('；')));
            const close = VCPUI.create('Button', { label: '关闭', variant: 'primary', size: 'sm' });
            const modal = VCPUI.create('Modal', { title: '模拟交易清单', size: 'lg', content, actions: [close] });
            close.element.addEventListener('click', () => modal.close(null)); document.body.append(modal.element);
        }, 'secondary', 'menu_book'), this.button('删除当前模拟交易', async () => {
            const selected = sessions.find(session => session.sessionId === current);
            if (!selected || !await VCPUI.feedback.confirm({ title: '删除模拟交易', danger: true, confirmLabel: '删除账本',
                message: `确定删除“${selected.name}”及其全部计划、委托、成交和复盘记录吗？此操作不可撤销。` })) return;
            await adminSettings({ action: 'deleteSession', sessionId: current, expectedRevision: selected.revision });
            if (this.store.sessionId === current) this.store.clear();
            await this.store.loadSessions(); this.notify(`已删除“${selected.name}”。`, 'success'); this.show('runs');
        }, 'danger', 'delete')));
        await this.newRunForm();
    }
    async newRunForm() {
        const [sources, extensions, directory] = await Promise.all([command({ command: 'GetSources' }),
            command({ command: 'ListExtensions' }), adminSettings({ action: 'market' })]);
        const feeds = new Set(sources.dataFeeds.map(f => f.datasetId));
        const options = [...(directory.market.effective ? [{ value: 'directory', label: '本机通达信 · 动态全部股票' }] : []),
            ...sources.dataFeeds.map(f => ({ value: f.sourceId, label: `${f.source.name}（来源，版本 ${f.revision}）` })),
            ...sources.sources.filter(s => !feeds.has(s.datasetId)).map(s => ({ value: s.datasetId, label: s.source.name }))];
        const p = this.prefs.get();
        const name = this.input({ value: '模拟账户' });
        const source = this.select(options, options[0]?.value || '');
        const rules = this.select(extensions.extensions.execution.map(e => ({ value: e.id, label: `${ruleName(e.id)}${e.builtin ? '' : '（扩展）'}` })), p.rules || 'reference');
        const cash = this.input({ type: 'number', value: '100000' });
        const submit = this.button('创建并打开', async () => {
            const value = source.element.value, cents = Math.round(Number(this.value(cash)) * 100);
            const args = { command: 'CreateSession', requestId: crypto.randomUUID(), name: this.value(name), agentName: '用户',
                dataMode: value === 'directory' || value.startsWith('feed-') ? 'continuous' : 'snapshot',
                rulesProfile: rules.element.value, initialCashCents: cents,
                ...(value === 'directory' ? { marketMode: 'directory' }
                    : value.startsWith('feed-') ? { sourceId: value } : { datasetId: value }) };
            const created = (await command(args)).observation;
            this.notify(`已创建模拟交易“${created.name}”，模拟日 ${created.date}。`, 'success');
            this.onOpenRun(created.sessionId);
        }, 'primary', 'add');
        const grid = h('div', 'ws-settings-grid');
        grid.append(this.field('名称', name), this.field('行情来源', source,
            '本机通达信可搜索全部已接入证券；导入的数据集只覆盖其中包含的证券。'),
        this.field('撮合规则', rules), this.field('初始虚拟资金（元）', cash));
        this.section('新建模拟账户', '建立虚拟资金账本后，直接搜索证券并模拟下单。自选和板块仅用于整理视图，不限制可交易范围。',
            grid, this.row(submit));
    }

    async trading() {
        const p = this.prefs.get(), extensions = (await command({ command: 'ListExtensions' })).extensions;
        const quantity = this.input({ type: 'number', value: String(p.quantity) });
        quantity.element.addEventListener('change', () => {
            const q = Number(this.value(quantity));
            if (Number.isSafeInteger(q) && q >= 100 && q % 100 === 0) this.prefs.set({ quantity: q });
            else this.notify('默认数量须为 100 的整数倍。', 'warning');
        });
        const confirm = this.keep(VCPUI.create('Switch', { label: '记录模拟意图前再次确认', checked: p.confirm }));
        confirm.element.addEventListener('change', () => this.prefs.set({ confirm: confirm.element.getAttribute('aria-checked') === 'true' }));
        const rules = this.select(extensions.execution.map(e => ({ value: e.id, label: `${ruleName(e.id)}${e.builtin ? '' : '（扩展）'}` })), p.rules || 'reference', value => this.prefs.set({ rules: value }));
        this.section('下单默认值', '仅影响本机浏览器中的下单面板。', this.field('默认数量（股）', quantity, '须为 100 的整数倍'), confirm.element);
        this.section('新建模拟交易默认值', '', this.field('默认撮合规则', rules, extensions.execution.find(e => e.id === (p.rules || 'reference'))?.description));
    }

    async extensions() {
        const ext = (await command({ command: 'ListExtensions' })).extensions;
        for (const [slot, items] of Object.entries(ext)) {
            this.section(SLOT_NAMES[slot] || slot, `${items.length} 个实现`, this.table(
                [{ key: 'id', label: '标识' }, { key: 'origin', label: '来源' }, { key: 'note', label: '属性' }, { key: 'description', label: '说明' }],
                items.map(i => ({ id: i.id, origin: i.builtin ? '内置' : '扩展插件', description: i.description,
                    note: [i.type === 'indicator' ? '指标' : i.type === 'signal' ? '信号' : '', i.network ? '访问外部服务' : '', i.live ? '实盘能力' : ''].filter(Boolean).join('、') || '—' }))));
        }
        this.content.append(h('p', 'muted ws-settings-foot', '扩展插件通过 register(slot, id, implementation) 注册，契约见插件目录中的 SLOTS.md。'));
    }

    about() {
        this.section('VTrade', '模拟交易工作台（第二版样张）', h('p', 'muted', '用于学习与模拟研究，账户资金均为虚拟资金，未接入任何证券公司或交易所的交易系统。'),
            this.row(this.button('查看免责声明', () => openNotice(), 'secondary', 'info'), this.button('数据获取说明', () => openNotice({ tab: 'data' }), 'ghost')));
        this.section('第三方组件与许可', '各组件保留其原有许可；许可全文随插件附带。', this.table(
            [{ key: 'name', label: '组件' }, { key: 'version', label: '版本或来源' }, { key: 'license', label: '许可' }, { key: 'use', label: '用途' }],
            THIRD_PARTY.map(([name, version, license, use]) => ({ name, version, license, use }))),
            h('p', 'muted ws-settings-foot', 'K 线与资金曲线由 VTrade 自带的图表引擎绘制，不依赖第三方图表库。'));
    }
}
