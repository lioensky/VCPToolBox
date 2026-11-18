// The 对决 chart: candles, volume and the same configurable indicators as 看盘, with each participant's buys and
// sells in its own colour (hollow when the order did not fill) and the days still to come shaded on the right.
import { Chart, palette } from '../chart-engine.mjs';
import { formatVolume } from '../chart-scale.mjs';
import { chartIndicatorSettings } from '../indicators.mjs';
import { IndicatorLayer } from '../indicator-layer.mjs';
import { local, seatColor } from './ui.mjs';

const KEY = 'vtrade-duel-indicators';
export function loadIndicators() {
    try { return chartIndicatorSettings(local.get(KEY, {})); } catch { return chartIndicatorSettings({}); }
}
export const saveIndicators = selection => local.set(KEY, selection);

export class DuelChart {
    // panelRoot: a positioned element around the chart that holds the indicator settings panel.
    constructor(root, { onCrosshair = () => {}, panelRoot = root.parentElement } = {}) {
        this.root = root;
        this.chart = new Chart(root, { theme: palette, onResize: first => { if (first && this.bars?.length) this.reset(); },
            onCrosshair: index => { this.indicators.show(index); onCrosshair(index); }, onReset: () => this.reset() });
        this.pricePane = this.chart.pane({ weight: 1, margins: { top: 0.1, bottom: 0.06 }, format: v => v.toFixed(2) });
        this.volumePane = this.chart.pane({ weight: 0.24, margins: { top: 0.12, bottom: 0 }, format: formatVolume, maxTicks: 2 });
        this.candles = this.pricePane.add('candles', { lastValue: true });
        this.volume = this.volumePane.add('histogram', { alpha: 0.45 });
        this.indicators = new IndicatorLayer(this.chart, this.pricePane, root, { selection: loadIndicators(), panelRoot, onChange: saveIndicators,
            volume: { pane: this.volumePane, series: this.volume } });
        this.keyboard = event => {
            if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); this.chart.scrollBy(event.key === 'ArrowLeft' ? -1 : 1); }
            else if (event.key === 'Home') { event.preventDefault(); this.reset(); }
        };
        root.tabIndex = 0;
        root.addEventListener('keydown', this.keyboard);
    }
    // view: a projected round. marks: the seat ids whose fills are drawn. future: shade the days still to come.
    update(view, { marks = view.seats.map(s => s.id), future = view.status === 'active' } = {}) {
        const previous = this.bars?.length ?? 0, range = this.chart.range();
        this.view = view; this.bars = view.bars;
        this.chart.setKeys(this.bars.map(b => b.key));
        this.candles.data = this.bars.map(b => ({ open: b.openCents / 100, high: b.highCents / 100, low: b.lowCents / 100, close: b.closeCents / 100 }));
        this.volume.data = this.bars.map(b => ({ value: b.volume ?? b.relativeVolume, tone: b.closeCents >= b.openCents ? 'up' : 'down' }));
        this.volumePane.format = view.strict ? value => value.toFixed(2) : formatVolume;
        this.indicators.setBars(this.bars);
        this.drawMarkers(marks);
        const left = view.lengthDays - view.day;
        this.chart.setFuture(future && left > 0 ? { count: left, label: `未揭晓 · 还剩 ${left} 天` } : null);
        this.root.setAttribute('aria-label', `K 线图，${this.bars.length} 根日线，最新 ${this.bars.at(-1)?.key ?? ''}`);
        // Follow new bars while the newest one is in view; otherwise keep the bars the player is looking at.
        if (!previous || this.bars.length < previous) this.reset();
        else if (range.to >= previous - 1) this.chart.setRange(range.from + this.bars.length - previous, range.to + this.bars.length - previous);
    }
    drawMarkers(marks) {
        const byIndex = new Map(), seats = this.view.seats.filter(s => marks.includes(s.id));
        for (const seat of seats) {
            for (const fill of seat.fills) {
                if (fill.index >= this.bars.length) continue;
                byIndex.set(fill.index, [...byIndex.get(fill.index) || [],
                    { side: fill.side, id: `${seat.id}:${fill.index}`, color: seatColor(seat), hollow: Boolean(fill.failed) }]);
            }
        }
        this.candles.markers = byIndex;
        this.chart.invalidate();
    }
    reset() {
        const n = this.bars?.length || 0;
        if (!n) return;
        const ahead = this.chart.future ? Math.min(this.chart.future.count, 14) : 4;
        this.chart.setRange(Math.max(-2, n - 90), n + ahead);
    }
    focus(index) {
        const span = 40;
        this.chart.setRange(index - span / 2, index + span / 2);
        this.chart.crosshairAt(index, this.bars[index].closeCents / 100);
    }
    destroy() { this.root.removeEventListener('keydown', this.keyboard); this.indicators.destroy(); this.chart.destroy(); }
}
