import { Chart, palette } from './chart-engine.mjs';
import { formatVolume } from './chart-scale.mjs';
import { chartModel, periodKey } from './chart-model.mjs';
import { chartIndicatorSettings } from './indicators.mjs';
import { IndicatorLayer } from './indicator-layer.mjs';

// Bars carry integer prices in 1/scale yuan: 100 for stocks and indices, 1000 for funds.
const SPANS = { day: null, week: 80, month: 72, quarter: 60, year: 40 };
const PERIOD_NAMES = { day: '日线', week: '周线', month: '月线', quarter: '季线', year: '年线' };
export class CandleChart {
    // extras: volumeReadout (element), headroom kept clear above the candles, panelRoot (holds the indicator settings
    // panel) and onIndicators(selection), called when the user changes the indicators.
    constructor(root, readout, caption, empty, onTrade, onNotice = () => {}, extras = {}) {
        this.root = root; this.readout = readout; this.caption = caption; this.empty = empty; this.extras = extras;
        this.onTrade = onTrade; this.onNotice = onNotice; this.period = 'day'; this.symbolKey = '';
        this.showMarks = true; this.showCost = true; this.tool = 'crosshair';
        this.annotations = new Map(); this.scale = 100;
        this.selectedIndicators = chartIndicatorSettings();
    }
    get digits() { return this.scale === 1000 ? 3 : 2; }
    price(units) { return (units / this.scale).toFixed(this.digits); }
    initialize() {
        if (this.chart) return;
        this.chart = new Chart(this.root, { theme: palette,
            onCrosshair: index => { const bars = this.model?.bars || []; if (bars.length) this.describe(bars[index ?? bars.length - 1]); },
            onClick: hit => this.click(hit), onResize: first => { if (first && this.model?.bars.length) this.reset(); },
            onReset: () => this.reset(), plotCursor: () => this.tool === 'line' ? 'cell' : 'crosshair' });
        // headroom keeps the top of the price pane clear for a heading drawn over the chart.
        this.pricePane = this.chart.pane({ weight: 1, margins: { top: this.extras.headroom ?? 0.16, bottom: 0.06 },
            format: v => v.toFixed(this.digits) });
        this.volumePane = this.chart.pane({ weight: 0.26, margins: { top: 0.12, bottom: 0 }, format: formatVolume, maxTicks: 2 });
        this.series = this.pricePane.add('candles', { lastValue: true });
        this.volume = this.volumePane.add('histogram', { alpha: 0.45 });
        this.indicators = new IndicatorLayer(this.chart, this.pricePane, this.root, { selection: this.selectedIndicators,
            scale: () => this.scale, digits: () => this.digits, panelRoot: this.extras.panelRoot || this.root.parentElement,
            volume: { pane: this.volumePane, series: this.volume },
            onChange: selection => { this.selectedIndicators = selection; this.extras.onIndicators?.(selection); } });
        this.keyboard = e => {
            if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); this.chart.scrollBy(e.key === 'ArrowLeft' ? -1 : 1); }
            else if (['ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); this.zoom(e.key === 'ArrowUp' ? -1 : 1); }
            else if (e.key === 'Home') { e.preventDefault(); this.reset(); }
        };
        this.root.addEventListener('keydown', this.keyboard);
    }
    click(hit) {
        if (this.tool === 'line') {
            if (hit.pane > 0) { this.onNotice('请在价格主图添加参考线。'); return; }
            if (hit.price > 0) {
                const list = this.annotations.get(this.symbolKey) || [];
                list.push(Number(hit.price.toFixed(this.digits)));
                this.annotations.set(this.symbolKey, list); this.drawLines(); this.tool = 'crosshair';
                this.onNotice('已添加参考线。它只用于当前页面标注，不会设置止损或提交交易。');
            }
            return;
        }
        const rows = hit.marker !== null ? this.markerGroups.get(hit.marker)
            : this.model?.markers.filter(o => o.key === this.model.bars[hit.index]?.key);
        if (rows?.length) this.onTrade(rows);
    }
    update(quote, orders, position, asOf) {
        this.initialize();
        const key = (quote.chartSessionId || '') + ':' + quote.symbol;
        const changed = key !== this.symbolKey;
        this.symbolKey = key; this.input = { quote, orders, position, asOf };
        this.render(changed);
    }
    setPeriod(period) { this.period = period; this.render(true); }
    setIndicators(selection) {
        this.selectedIndicators = chartIndicatorSettings(selection);
        this.indicators?.set(this.selectedIndicators, { save: false });
    }
    setTool(tool) {
        this.tool = tool;
        this.onNotice(tool === 'line' ? '在主图点击一个价格添加参考线；这不是交易条件。' : '十字线模式。拖动主图平移，滚轮缩放，双击价格轴复位。');
    }
    clearLines() { this.annotations.delete(this.symbolKey); this.drawLines(); this.onNotice('已清除当前个股的页面参考线。'); }
    toggle(name) {
        if (!this.chart) return true;
        if (name === 'marks') { this.showMarks = !this.showMarks; this.drawMarkers(); return this.showMarks; }
        this.showCost = !this.showCost; this.drawLines(); return this.showCost;
    }
    zoom(delta) { this.chart?.zoomBy(delta < 0 ? 0.8 : 1.25); }
    reset() {
        if (!this.chart) return;
        const width = this.chart.width - this.chart.axisWidth, n = this.model?.bars.length || 0;
        const span = SPANS[this.period] ?? Math.max(45, Math.min(150, Math.floor(width / 6.5)));
        if (n) this.chart.setRange(Math.max(-2, n - span), n + 6);
    }
    setRange(months) {
        if (!this.chart || !this.model?.bars.length) return;
        const n = this.model.bars.length;
        const perMonth = { day: 22, week: 4.35, month: 1, quarter: 1 / 3, year: 1 / 12 }[this.period];
        const span = months === 'all' ? n + 2 : Math.max(8, Number(months) * perMonth);
        this.chart.setRange(Math.max(-2, n - span), n + 6);
    }
    focus(date) {
        const key = periodKey(date, this.period);
        const index = this.model?.bars.findIndex(b => b.key === key) ?? -1;
        if (index < 0) { this.onNotice('这笔成交不在当前已加载的历史窗口中。'); return; }
        const span = Math.min(30, Math.max(10, this.model.bars.length));
        this.chart.setRange(index - span / 2, index + span / 2);
        const bar = this.model.bars[index]; this.chart.crosshairAt(index, bar.closeCents / this.scale); this.describe(bar);
    }
    render(reset = false) {
        if (!this.input) return;
        const { quote, orders, position, asOf } = this.input;
        const previous = this.model?.bars, view = this.chart.range();
        this.scale = quote.priceScale || 100;
        this.model = chartModel(quote, orders, position, this.period, asOf, quote.bars.length);
        const m = this.model, s = this.scale;
        this.root.dataset.period = this.period; this.root.dataset.candleCount = m.bars.length;
        this.root.dataset.engine = 'vtrade-canvas';
        this.root.setAttribute('aria-label', `${quote.name} ${PERIOD_NAMES[this.period]}，${m.bars.length} 根，${m.markers.length} 笔虚拟成交，截至 ${asOf}`);
        this.empty.hidden = m.bars.length > 0;
        this.chart.setKeys(m.bars.map(b => b.key));
        this.series.data = m.bars.map(b => ({ open: b.openCents / s, high: b.highCents / s, low: b.lowCents / s, close: b.closeCents / s }));
        this.volume.data = m.bars.map(b => ({ value: b.volume, tone: b.closeCents >= b.openCents ? 'up' : 'down' }));
        this.indicators.setBars(m.bars);
        this.drawMarkers(); this.drawLines();
        // Keep the view on the same bars: follow new bars when the right edge was in view, otherwise hold the left edge.
        if (reset || !previous?.length) this.reset();
        else {
            const atEnd = view.to >= previous.length - 1;
            const left = Math.max(0, Math.min(previous.length - 1, Math.floor(view.from)));
            const shift = atEnd ? m.bars.length - previous.length : m.bars.findIndex(b => b.key === previous[left].key) - left;
            if (!atEnd && shift < -left) this.reset(); else this.chart.setRange(view.from + shift, view.to + shift);
        }
        const trades = quote.chartSessionId === 'market' ? '' : ` · ${m.markers.length} 笔成交`;
        this.caption.textContent = `${m.bars.length} 根${PERIOD_NAMES[this.period]}${trades}` + (quote.chartTruncated ? ' · 历史窗口' : '')
            + (this.period === 'day' ? '' : ` · 截至 ${asOf}`);
        if (m.bars.length) this.describe(m.bars.at(-1));
    }
    drawMarkers() {
        this.markerGroups = new Map();
        const byIndex = new Map(), index = new Map((this.model?.bars || []).map((b, i) => [b.key, i]));
        for (const order of this.model?.markers || []) {
            const id = order.key + ':' + order.side;
            if (!this.markerGroups.has(id)) {
                this.markerGroups.set(id, []);
                const i = index.get(order.key);
                byIndex.set(i, [...byIndex.get(i) || [], { side: order.side, id }]);
            }
            this.markerGroups.get(id).push(order);
        }
        this.series.markers = this.showMarks ? byIndex : null;
        this.chart.invalidate();
    }
    drawLines() {
        const lines = [];
        if (this.showCost && this.model?.averageCostCents !== null && this.model?.averageCostCents !== undefined) {
            lines.push({ value: this.model.averageCostCents / this.scale, color: 'cost', title: '持仓成本' });
        }
        for (const value of this.annotations.get(this.symbolKey) || []) lines.push({ value, color: 'accent', title: '参考线' });
        this.pricePane.setLines(lines);
    }
    describe(b) {
        this.readout.replaceChildren();
        const index = this.model.bars.findIndex(row => row.key === b.key);
        const previous = this.model.bars[index - 1];
        const change = previous ? (b.closeCents - previous.closeCents) / previous.closeCents : null;
        const color = change === null ? (b.closeCents >= b.openCents ? 'up' : 'down') : change >= 0 ? 'up' : 'down';
        const pair = (label, text, tone = color) => {
            const element = document.createElement('span'); element.className = 'ohlc-pair ' + tone;
            const title = document.createElement('i'); title.textContent = label;
            element.append(title, document.createTextNode(text)); this.readout.append(element);
        };
        pair('', b.startDate === b.endDate ? b.endDate : `${b.startDate}～${b.endDate}`, 'date');
        for (const [label, value] of [['开', b.openCents], ['高', b.highCents], ['低', b.lowCents], ['收', b.closeCents]]) pair(label, this.price(value));
        if (change !== null) pair('幅', `${change > 0 ? '+' : ''}${(change * 100).toFixed(2)}%`);
        const amount = b.amount ? ` · 额 ${formatVolume(b.amount)}` : '';
        this.extras.volumeReadout.textContent = `量 ${formatVolume(b.volume)}${amount}`;
        this.indicators.show(index);
    }
    applyTheme() { this.chart?.setColors(palette()); }
    destroy() {
        if (!this.chart) return;
        this.closed = true;
        this.root.removeEventListener('keydown', this.keyboard);
        this.indicators.destroy(); this.chart.destroy();
    }
}
