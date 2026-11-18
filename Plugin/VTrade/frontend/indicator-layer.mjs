// Indicators on a VTrade chart, shared by 看盘 and 对决: the series they draw, a legend at the top left of each pane
// (each line's value in its own colour, with buttons to hide, set up or remove the indicator), a row of switches
// for the toolbar, and the settings panel. Every change applies at once and goes to onChange to be saved; there is
// no separate apply step.
import { INDICATORS, calculateIndicator, chartIndicatorSettings, indicatorLines } from './indicators.mjs';
import { openIndicatorEditor } from './indicator-editor.mjs';

export function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}
export function iconButton(name, label, onClick, className = 'ind-tool') {
    const button = el('button', className); button.type = 'button'; button.setAttribute('aria-label', label);
    button.append(window.VCPIcons?.create?.(name, { size: 14 }) || el('span', '', label));
    button.addEventListener('click', event => { event.stopPropagation(); onClick(event); });
    return button;
}

// A folded sub-chart keeps a strip just tall enough for its legend.
const FOLDED_PX = 24;

export class IndicatorLayer {
    // chart and pricePane come from chart-engine.mjs; host is the chart's root, where the legends are laid over it;
    // panelRoot holds the settings panel (a positioned element around the chart). scale(): price units per yuan of
    // the bars (100, or 1000 for funds); digits(): decimals of a price. volume: { pane, series } of the chart's volume
    // pane, which can be folded like the sub-charts.
    constructor(chart, pricePane, host, { selection, scale = () => 100, digits = () => 2, onChange = () => {}, panelRoot = host, volume = null } = {}) {
        Object.assign(this, { chart, pricePane, host, scale, digits, onChange, panelRoot, volume });
        this.selection = chartIndicatorSettings(selection);
        this.bars = []; this.series = []; this.panes = []; this.groups = []; this.cells = []; this.boxes = new Map();
        this.toolbars = new Set(); this.index = null; this.editor = null;
        this.overlay = el('div', 'ind-legends'); host.append(this.overlay);
        this.unwatch = chart.watchLayout((panes, plot) => { this.place(panes, plot); this.show(this.index); });
    }
    setBars(bars) { this.bars = bars; this.render(); }
    // save: false when the selection comes from storage rather than from the user.
    set(selection, { save = true } = {}) {
        this.selection = chartIndicatorSettings(selection);
        this.render();
        for (const paint of this.toolbars) paint();
        if (save) this.onChange(this.selection);
    }
    change(edit) { const next = structuredClone(this.selection); edit(next); this.set(next); }
    add(id) {
        this.change(s => { const list = INDICATORS[id].pane === 'price' ? s.main : s.sub; if (!list.includes(id)) list.push(id); s.hidden = s.hidden.filter(x => x !== id); });
    }
    remove(id) {
        if (this.editor?.id === id) this.editor.close();
        this.change(s => { s.main = s.main.filter(x => x !== id); s.sub = s.sub.filter(x => x !== id); });
    }
    toggle(id) { this.change(s => { s.hidden = s.hidden.includes(id) ? s.hidden.filter(x => x !== id) : [...s.hidden, id]; }); }
    fold(id) { this.change(s => { s.collapsed = s.collapsed.includes(id) ? s.collapsed.filter(x => x !== id) : [...s.collapsed, id]; }); }
    edit(id) {
        const again = this.editor?.id === id;
        this.editor?.close();
        if (!again) this.editor = openIndicatorEditor(this, id, () => { this.editor = null; });
    }
    // The first indicator on the chart, for a context menu that opens the settings.
    editFirst() { this.edit(this.selection.main[0] || this.selection.sub[0] || 'ma'); }

    lines(id) {
        const s = this.selection, params = s.params[id], styles = s.styles[id], bars = this.bars;
        const shared = id === 'ma' || id === 'ema' ? null : calculateIndicator(id, bars, params);
        return indicatorLines(id, params).map((line, k) => {
            const rows = shared || calculateIndicator(id, bars, { period: line.period });
            return { ...line, ...styles[k], values: rows.map(row => row.values[shared ? line.key : id.toUpperCase()]) };
        });
    }
    render() {
        for (const series of this.series) { const k = this.pricePane.series.indexOf(series); if (k >= 0) this.pricePane.series.splice(k, 1); }
        for (const pane of this.panes) this.chart.removePane(pane);
        this.series = []; this.panes = []; this.groups = [];
        const s = this.selection, unit = this.scale();
        if (this.volume) {
            const folded = s.collapsed.includes('volume');
            this.volume.pane.fixed = folded ? FOLDED_PX : 0; this.volume.series.visible = !folded;
        }
        for (const id of [...s.main, ...s.sub]) {
            const price = INDICATORS[id].pane === 'price', folded = !price && s.collapsed.includes(id);
            const visible = !s.hidden.includes(id) && !folded, lines = this.lines(id);
            const pane = price ? this.pricePane : this.chart.pane({ weight: 0.26, margins: { top: 0.22, bottom: 0.08 },
                format: value => value.toFixed(id === 'macd' ? 3 : 1), maxTicks: 3, fixed: folded ? FOLDED_PX : 0 });
            const scaled = value => (price || id === 'macd' ? value / unit : value);
            for (const line of lines) {
                const series = pane.add(line.bars ? 'histogram' : 'line', { color: line.color, width: line.width, visible });
                series.data = line.values.map(value => value === null ? null : line.bars ? { value: scaled(value), tone: value >= 0 ? 'up' : 'down' } : scaled(value));
                if (price) this.series.push(series);
            }
            if (!price) this.panes.push(pane);
            this.groups.push({ id, pane, lines, visible: !s.hidden.includes(id), folded });
        }
        this.paintLegends();
        this.chart.invalidate();
    }

    format(id, value) {
        if (value === null || value === undefined) return '—';
        if (INDICATORS[id].pane === 'price') return (value / this.scale()).toFixed(this.digits());
        return id === 'macd' ? (value / this.scale()).toFixed(3) : value.toFixed(2);
    }
    paintLegends() {
        this.overlay.replaceChildren(); this.boxes.clear(); this.cells = [];
        if (this.volume) {
            const folded = this.selection.collapsed.includes('volume'), box = el('div', 'ind-legend'), row = el('div', 'ind-row');
            row.append(el('span', 'ind-name', '成交量'), el('span', 'ind-tools'));
            row.lastChild.append(iconButton(folded ? 'expand_more' : 'expand_less', folded ? '展开成交量' : '收起成交量', () => this.fold('volume')));
            box.append(row); this.boxes.set(this.volume.pane, box); this.overlay.append(box);
        }
        for (const group of this.groups) {
            const spec = INDICATORS[group.id], params = Object.values(this.selection.params[group.id]);
            let box = this.boxes.get(group.pane);
            if (!box) { box = el('div', 'ind-legend'); this.boxes.set(group.pane, box); this.overlay.append(box); }
            const row = el('div', 'ind-row'); row.dataset.hidden = String(!group.visible);
            const name = el('button', 'ind-name'); name.type = 'button';
            name.setAttribute('aria-label', `${spec.name} ${spec.title}，打开设置`);
            name.append(el('b', '', spec.name));
            // MA and EMA show their periods in the line labels (MA5, MA10); the others show their parameters here.
            if (!['ma', 'ema'].includes(group.id)) name.append(el('span', '', params.join(',')));
            name.addEventListener('click', () => this.edit(group.id));
            const values = el('span', 'ind-values');
            const cells = group.lines.map(line => { const cell = el('span', 'ind-value'); values.append(cell); return { line, cell }; });
            this.cells.push({ group, cells });
            const tools = el('span', 'ind-tools');
            if (INDICATORS[group.id].pane !== 'price') {
                tools.append(iconButton(group.folded ? 'expand_more' : 'expand_less', group.folded ? `展开 ${spec.name}` : `收起 ${spec.name}`,
                    () => this.fold(group.id)));
            }
            tools.append(iconButton(group.visible ? 'visibility' : 'visibility_off', group.visible ? `隐藏 ${spec.name}` : `显示 ${spec.name}`, () => this.toggle(group.id)),
                iconButton('settings', `设置 ${spec.name}`, () => this.edit(group.id)),
                iconButton('close', `移除 ${spec.name}`, () => this.remove(group.id)));
            row.append(name, values, tools);
            box.append(row);
        }
        this.show(this.index);
        this.geometry();
    }
    // The values at one bar (null: the latest), shown in the legends.
    show(index) {
        this.index = index;
        const i = index === null || index === undefined ? this.bars.length - 1 : Math.min(index, this.bars.length - 1);
        for (const { group, cells } of this.cells) {
            for (const { line, cell } of cells) {
                cell.style.setProperty('--ind-color', this.chart.color(line.color));
                const label = group.lines.length > 1 ? `${line.label} ` : '';
                cell.textContent = `${label}${this.format(group.id, line.values[i])}`;
            }
        }
    }
    geometry() { if (this.chart.width) this.place(this.chart.panes, this.chart.time.width); }
    place(panes, plot) {
        for (const [pane, box] of this.boxes) {
            // A new pane has no position until the next draw, which places it through the layout watcher.
            box.hidden = !panes.includes(pane) || !pane.height;
            box.style.setProperty('top', `${pane.top + 3}px`);
            box.style.setProperty('max-width', `${Math.max(120, plot - 12)}px`);
        }
    }

    // A row of switches, one per indicator, in a 主图 group and a 副图 group; a pressed switch is on the chart.
    toolbar() {
        const bar = el('div', 'ind-toolbar');
        const paint = () => {
            bar.replaceChildren();
            for (const [pane, label] of [['price', '主图'], ['oscillator', '副图']]) {
                const group = el('div', 'ind-switches'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', `${label}指标`);
                group.append(el('span', 'ind-group-label', label));
                for (const [id, spec] of Object.entries(INDICATORS).filter(([, x]) => x.pane === pane)) {
                    const on = this.selection.main.includes(id) || this.selection.sub.includes(id);
                    const button = el('button', 'ind-switch'); button.type = 'button'; button.setAttribute('aria-pressed', String(on));
                    button.append(el('b', '', spec.name), el('span', '', spec.title));
                    button.addEventListener('click', () => (on ? this.remove(id) : this.add(id)));
                    group.append(button);
                }
                bar.append(group);
            }
        };
        paint(); this.toolbars.add(paint);
        return bar;
    }
    destroy() { this.editor?.close(); this.unwatch(); this.overlay.remove(); this.toolbars.clear(); }
}
