// Asset curves under the round chart and on the replay: each participant's money, buying and holding, and the market
// (沪深 300) as returns since the start, over the whole round with the days still to come shaded. The strip folds to
// its header, which keeps the latest values; the choice is remembered on this browser.
import { Chart, palette } from '../chart-engine.mjs';
import { iconButton } from '../indicator-layer.mjs';
import { h, put, pct, tone, local, seatColor, seatName } from './ui.mjs';

const FOLDED = 'vtrade-duel-equity-folded';
const MARKET_COLOR = '#a970ff';

export function equityStrip({ title = '资产走势' } = {}) {
    const legend = h('div.eq-legend'), host = h('div.equity-host'), empty = h('p.eq-empty', {}, '开局后按天画出资产变化。');
    let folded = Boolean(local.get(FOLDED, false)), view = null, lines = [], index = null;
    const element = h('section.equity-strip');
    const toggle = iconButton('expand_less', '收起资产走势', () => {
        folded = !folded; local.set(FOLDED, folded); paintFold();
    }, 'ind-tool eq-toggle');
    element.append(h('header.eq-head', {}, h('strong', {}, title), legend, toggle), host);
    host.append(empty);

    const chart = new Chart(host, { theme: palette, gridX: true, onCrosshair: i => { index = i; paintLegend(); },
        onResize: () => frame(), onReset: () => frame() });
    // At least ±1% is shown, so the first days' small moves are not blown up; values near zero read 0.0%.
    const pane = chart.pane({ weight: 1, margins: { top: 0.14, bottom: 0.1 }, maxTicks: 4, minSpan: 2,
        format: value => (Math.abs(value) < 0.05 ? '0.0%' : `${value > 0 ? '+' : ''}${value.toFixed(1)}%`) });
    // Legend colours follow the theme: the engine reports colour changes through the layout watcher.
    chart.watchLayout(() => paintLegend());

    function paintFold() {
        element.dataset.folded = String(folded);
        host.hidden = folded;
        toggle.replaceChildren(window.VCPIcons?.create?.(folded ? 'expand_more' : 'expand_less', { size: 14 }) || '');
        toggle.setAttribute('aria-label', folded ? `展开${title}` : `收起${title}`);
        toggle.setAttribute('aria-expanded', String(!folded));
    }
    // The whole round is in view: played days on the left, the days still to come shaded on the right.
    function frame() { if (view) chart.setRange(-0.5, view.lengthDays + 0.5); }
    function update(next) {
        view = next;
        const percent = values => values.map(value => (value === null || value === undefined ? null : value * 100));
        lines = [
            ...view.seats.map(seat => ({ label: seatName(seat), color: seatColor(seat), width: 2,
                values: percent(seat.equity.map(v => v / seat.equity[0] - 1)) })),
            { label: '买入持有', color: 'text', width: 1, values: percent(view.hold.map(v => v / view.hold[0] - 1)) },
            ...(view.benchmark ? [{ label: view.benchmark.name, color: MARKET_COLOR, width: 1, values: percent(view.benchmark.returns) }] : []),
        ];
        pane.series.length = 0;
        for (const line of lines) pane.add('line', { color: line.color, width: line.width, lastValue: true }).data = line.values;
        const keys = view.seats[0].equity.map((_, d) => (d ? keyOf(view, d) : '开局'));
        chart.setKeys(keys);
        const left = view.lengthDays - view.day;
        chart.setFuture(view.status === 'active' && left > 0 ? { count: left, label: '' } : null);
        empty.hidden = view.day > 0;
        frame();
        paintLegend();
    }
    function paintLegend() {
        if (!view) return;
        const at = index === null || index === undefined ? null : index;
        put(legend, lines.map(line => {
            const value = at === null ? line.values.at(-1) : line.values[Math.min(at, line.values.length - 1)];
            return h('span.eq-item', { style: `--eq-color:${chart.color(line.color)}` }, h('i'), line.label,
                h('b', { dataset: { tone: value === null || value === undefined ? 'flat' : tone(value) } },
                    value === null || value === undefined ? '—' : pct(value / 100)));
        }), view.benchmark ? null : h('span.eq-note', {}, '无沪深 300 数据'));
    }
    paintFold();
    return { element, update, destroy() { chart.destroy(); } };
}

// Day labels match the main chart: the date once revealed, otherwise the counted day.
function keyOf(view, day) {
    const history = view.bars.length - view.day;
    return view.bars[history - 1 + day]?.key ?? `第${day}天`;
}
