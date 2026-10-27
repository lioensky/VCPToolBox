// VTrade canvas chart engine: one shared time scale, stacked panes with their own price scales,
// candle / line / histogram series, price lines, trade markers and a crosshair. Colours come from VCPUI tokens.
import { TimeScale, priceTicks, paddedRange, timeLabels } from './chart-scale.mjs';

const CLICK_SLOP = 4, SEPARATOR_HIT = 4, MIN_PANE = 28;

// Resolves the token colours the engine draws with. --vt-up / --vt-down let a page swap the trend colours.
export function palette() {
    const style = getComputedStyle(document.body);
    const probe = document.createElement('span');
    probe.style.fontSize = 'var(--vcp-ui-font-caption)'; probe.hidden = true;
    document.body.append(probe);
    const fontSize = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    const pixel = document.createElement('canvas'); pixel.width = pixel.height = 1;
    const ctx = pixel.getContext('2d', { willReadFrequently: true });
    const color = name => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = style.getPropertyValue(name).trim(); ctx.fillRect(0, 0, 1, 1);
        const p = ctx.getImageData(0, 0, 1, 1).data;
        return `rgba(${p[0]},${p[1]},${p[2]},${p[3] / 255})`;
    };
    const trend = (name, fallback) => style.getPropertyValue(name).trim() ? name : fallback;
    return { background: color('--vcp-ui-bg-1'), text: color('--vcp-ui-text-2'), border: color('--vcp-ui-border'),
        up: color(trend('--vt-up', '--vcp-ui-danger')), down: color(trend('--vt-down', '--vcp-ui-success')), accent: color('--vcp-ui-text-accent'),
        cost: color('--vcp-ui-warning'), font: style.fontFamily, fontSize: Number.isFinite(fontSize) ? fontSize : parseFloat(style.fontSize),
        // Moving averages, shortest first, as in common Chinese charting software: light, amber, accent, blue.
        ma5: color('--vcp-ui-text-1'), ma10: color('--vcp-ui-palette-amber'), ma20: color('--vcp-ui-text-accent'), ma60: color('--vcp-ui-palette-blue'),
        // Participants of a 对决 round, kept apart from the trend colours; the shaded area after the latest bar.
        seat1: color('--vcp-ui-palette-blue'), seat2: color('--vcp-ui-palette-amber'), seat3: color('--vcp-ui-palette-cyan'), seat4: color('--vcp-ui-text-1'),
        future: color('--vcp-ui-fill-1') };
}
// Dark or light label text, whichever reads on the given fill.
function inkOn(fill) {
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(fill);
    const [r, g, b] = hex ? hex.slice(1).map(part => parseInt(part, 16)) : fill.match(/[\d.]+/g).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? 'rgba(0,0,0,0.87)' : 'rgba(255,255,255,0.95)';
}

class Pane {
    // fixed: a height in pixels instead of a share of the chart (e.g. a folded sub-chart that keeps only its legend).
    // minSpan: the smallest value range shown, so a nearly flat series is not blown up to fill the pane.
    constructor(chart, { weight = 1, margins = { top: 0.1, bottom: 0.1 }, format = v => v.toFixed(2), maxTicks = 8, fixed = 0, minSpan = 0 } = {}) {
        Object.assign(this, { chart, weight, margins, format, maxTicks, fixed, minSpan });
        this.series = []; this.lines = []; this.auto = true; this.min = 0; this.max = 1; this.top = 0; this.height = 0; this.ticks = [];
    }
    // kind: 'candles' ({open, high, low, close}), 'line' (number | null), 'histogram' ({value, tone}).
    add(kind, options = {}) {
        const series = { kind, visible: true, data: [], ...options };
        this.series.push(series); this.chart.invalidate(); return series;
    }
    // lines: [{ value, color (palette key), title, dash }]
    setLines(lines) { this.lines = lines; this.chart.invalidate(); }
    y(value) { return this.top + (this.max - value) / (this.max - this.min) * this.height; }
    value(y) { return this.max - (y - this.top) / this.height * (this.max - this.min); }
    fit(first, last) {
        if (!this.auto) return;
        let low = Infinity, high = -Infinity;
        for (const s of this.series) {
            if (!s.visible) continue;
            for (let i = first; i <= last; i++) {
                const d = s.data[i];
                if (d === null || d === undefined) continue;
                const lo = s.kind === 'candles' ? d.low : s.kind === 'histogram' ? Math.min(0, d.value) : d;
                const hi = s.kind === 'candles' ? d.high : s.kind === 'histogram' ? d.value : d;
                if (lo < low) low = lo;
                if (hi > high) high = hi;
            }
        }
        if (this.minSpan && Number.isFinite(low) && high - low < this.minSpan) {
            const middle = (low + high) / 2; low = middle - this.minSpan / 2; high = middle + this.minSpan / 2;
        }
        Object.assign(this, paddedRange(low, high, this.margins.top, this.margins.bottom));
    }
}

export class Chart {
    // options: colors, theme (() => colors, re-read on theme changes), gridX, timeAxis,
    // onCrosshair(index | null), onClick({ index, pane, price, marker }), onResize(first), onReset(), plotCursor().
    constructor(root, options = {}) {
        this.root = root;
        this.options = { gridX: true, timeAxis: true, minSpacing: 0.5, maxSpacing: 48, onCrosshair() {}, onClick() {},
            onResize() {}, onReset() {}, plotCursor: () => 'crosshair', ...options };
        this.colors = options.colors || options.theme();
        this.time = new TimeScale(this.options);
        this.keys = []; this.panes = []; this.hits = []; this.hover = null; this.pinned = null; this.drag = null;
        this.width = 0; this.height = 0; this.ratio = 1; this.axisWidth = 56; this.frame = 0; this.layoutWatchers = new Set(); this.geometry = '';
        root.classList.add('vt-chart');
        this.canvas = document.createElement('canvas'); this.canvas.className = 'vt-chart-canvas';
        root.append(this.canvas); this.ctx = this.canvas.getContext('2d');
        this.handlers = {
            pointerdown: e => this.down(e), pointermove: e => this.move(e), pointerup: e => this.up(e), pointercancel: () => { this.drag = null; },
            pointerleave: () => this.leave(), wheel: e => this.wheel(e), dblclick: e => this.doubleClick(e),
        };
        for (const [name, handler] of Object.entries(this.handlers)) this.canvas.addEventListener(name, handler, name === 'wheel' ? { passive: false } : undefined);
        this.sizing = new ResizeObserver(() => this.resize()); this.sizing.observe(root);
        if (options.theme) {
            this.recolor = () => requestAnimationFrame(() => this.setColors(options.theme()));
            this.themeWatch = new MutationObserver(this.recolor);
            this.themeWatch.observe(document.body, { attributes: true, attributeFilter: ['data-vcp-theme', 'data-trend'] });
            window.addEventListener('vcp-appearance-changed', this.recolor);
        }
    }
    // Adding or removing a pane always reaches the layout watchers, even when the new layout matches the old one.
    pane(options) { const pane = new Pane(this, options); this.panes.push(pane); this.geometry = ''; this.invalidate(); return pane; }
    removePane(pane) { const k = this.panes.indexOf(pane); if (k > 0) { this.panes.splice(k, 1); this.geometry = ''; this.invalidate(); } }
    // Called with the panes after a draw whenever their positions, the plot width or the colours change, e.g. to place
    // and colour legends.
    watchLayout(watcher) { this.layoutWatchers.add(watcher); this.geometry = ''; this.invalidate(); return () => this.layoutWatchers.delete(watcher); }
    // A series colour: a palette key, or any CSS colour the page chose (e.g. a user's #rrggbb).
    color(name) { return this.colors[name] || name; }
    setKeys(keys) { this.keys = keys; this.time.count = keys.length; this.time.clamp(); this.invalidate(); }
    setColors(colors) { this.colors = colors; this.geometry = ''; this.invalidate(); }
    range() { return { from: this.time.from, to: this.time.to }; }
    setRange(from, to) { this.time.set(from, to); for (const p of this.panes) p.auto = true; this.invalidate(); }
    fit() { this.setRange(0, Math.max(1, this.keys.length)); }
    scrollBy(bars) { this.time.from += bars; this.time.to += bars; this.time.clamp(); this.invalidate(); }
    zoomBy(factor) { this.time.zoom(factor, this.time.width / 2); this.invalidate(); }
    // Shows the crosshair at a bar until the pointer next moves over the chart.
    crosshairAt(index, value) { this.pinned = { index, pane: 0, value }; this.invalidate(); }
    invalidate() { if (!this.frame && this.width) this.frame = requestAnimationFrame(() => this.draw()); }

    resize() {
        const width = this.root.clientWidth, height = this.root.clientHeight, ratio = window.devicePixelRatio || 1;
        if (!width || !height || (width === this.width && height === this.height && ratio === this.ratio)) return;
        const first = !this.width;
        Object.assign(this, { width, height, ratio });
        this.canvas.width = Math.round(width * ratio); this.canvas.height = Math.round(height * ratio);
        this.options.onResize(first);
        if (this.frame) cancelAnimationFrame(this.frame);
        this.draw();
    }
    layout() {
        const c = this.colors, timeHeight = this.options.timeAxis ? Math.round(c.fontSize + 12) : 0;
        this.plotHeight = this.height - timeHeight;
        // Fixed panes take their pixels first; the others share the rest by weight, the last of them taking the rounding.
        const room = Math.max(0, this.plotHeight - this.panes.reduce((sum, p) => sum + (p.fixed || 0), 0));
        const total = this.panes.reduce((sum, p) => sum + (p.fixed ? 0 : p.weight), 0) || 1;
        const heights = this.panes.map(p => p.fixed || Math.round(room * p.weight / total));
        const lastShare = this.panes.findLastIndex(p => !p.fixed);
        if (lastShare >= 0) heights[lastShare] += this.plotHeight - heights.reduce((sum, h) => sum + h, 0);
        let top = 0;
        this.panes.forEach((p, k) => {
            const height = heights[k];
            p.top = top + (k ? 1 : 0); p.height = Math.max(1, height - (k ? 1 : 0)); top += height;
        });
        const fitAll = () => {
            const [first, last] = this.time.visible();
            for (const p of this.panes) {
                p.fit(first, last);
                p.ticks = p.fixed && p.height < 40 ? [] : priceTicks(p.min, p.max, Math.max(1, Math.min(p.maxTicks, Math.floor(p.height / 34))));
            }
        };
        if (this.time.width !== this.width - this.axisWidth) this.time.resize(this.width - this.axisWidth);
        fitAll();
        // The price axis is as wide as its widest label, so the plot width follows the labels.
        this.ctx.font = `${c.fontSize}px ${c.font}`;
        let widest = 0;
        for (const p of this.panes) {
            const values = [...p.ticks, ...p.lines.map(l => l.value), ...p.series.filter(s => s.lastValue).map(s => this.last(s)).filter(v => v !== null)];
            for (const v of values) widest = Math.max(widest, this.ctx.measureText(p.format(v)).width);
        }
        const axisWidth = Math.max(48, Math.ceil(widest + 18));
        if (axisWidth !== this.axisWidth) { this.axisWidth = axisWidth; this.time.resize(this.width - axisWidth); fitAll(); }
    }
    last(series) {
        const d = series.data.at(-1);
        return d === undefined || d === null ? null : series.kind === 'candles' ? d.close : series.kind === 'histogram' ? d.value : d;
    }

    draw() {
        this.frame = 0;
        if (!this.width) return;
        const { ctx, ratio: r } = this, c = this.colors;
        ctx.setTransform(r, 0, 0, r, 0, 0);
        ctx.fillStyle = c.background; ctx.fillRect(0, 0, this.width, this.height);
        this.layout();
        ctx.font = `${c.fontSize}px ${c.font}`; ctx.textBaseline = 'middle';
        const plot = this.time.width, [first, last] = this.time.visible();
        const labels = this.options.timeAxis && this.keys.length
            ? timeLabels(this.keys, first, last, i => this.time.x(i), Math.max(56, c.fontSize * 5))
                .filter(l => { const half = ctx.measureText(l.text).width / 2; return l.x - half >= 0 && l.x + half <= plot; }) : [];
        this.hits = [];
        this.futureArea(plot);
        for (const p of this.panes) {
            ctx.save(); ctx.beginPath(); ctx.rect(0, p.top, plot, p.height); ctx.clip();
            ctx.strokeStyle = c.border; ctx.lineWidth = 1; ctx.setLineDash([1, 3]); ctx.beginPath();
            for (const v of p.ticks) { const y = this.crisp(p.y(v)); ctx.moveTo(0, y); ctx.lineTo(plot, y); }
            if (this.options.gridX) for (const l of labels) { const x = this.crisp(l.x); ctx.moveTo(x, p.top); ctx.lineTo(x, p.top + p.height); }
            ctx.stroke(); ctx.setLineDash([]);
            for (const s of p.series) if (s.visible && s.data.length) this[s.kind](p, s, first, last);
            ctx.restore();
        }
        this.frameLines(plot);
        for (const p of this.panes) this.axis(p, plot);
        for (const l of labels) { ctx.fillStyle = c.text; ctx.textAlign = 'center'; ctx.fillText(l.text, l.x, this.plotHeight + (this.height - this.plotHeight) / 2); }
        this.crosshair(plot);
        const geometry = `${plot}:${this.panes.map(p => `${p.top},${p.height}`).join('|')}`;
        if (geometry !== this.geometry) { this.geometry = geometry; for (const watcher of this.layoutWatchers) watcher(this.panes, plot); }
    }
    crisp(v) { return (Math.round(v * this.ratio - 0.5) + 0.5) / this.ratio; }
    frameLines(plot) {
        const { ctx } = this;
        ctx.strokeStyle = this.colors.border; ctx.lineWidth = 1; ctx.beginPath();
        ctx.moveTo(this.crisp(plot), 0); ctx.lineTo(this.crisp(plot), this.height);
        if (this.options.timeAxis) { ctx.moveTo(0, this.crisp(this.plotHeight)); ctx.lineTo(this.width, this.crisp(this.plotHeight)); }
        for (const p of this.panes.slice(1)) { ctx.moveTo(0, this.crisp(p.top - 1)); ctx.lineTo(this.width, this.crisp(p.top - 1)); }
        ctx.stroke();
    }
    // Column widths in device pixels; body and wick share parity so the wick stays centred.
    columns() {
        const r = this.ratio, wick = Math.max(1, Math.round(r));
        let body = Math.floor(this.time.spacing * r * 0.72);
        if (body > wick && (body - wick) % 2) body -= 1;
        return { r, wick, body: Math.max(wick, body) };
    }
    candles(p, s, first, last) {
        const { ctx } = this, c = this.colors, { r, wick, body } = this.columns();
        for (const tone of ['up', 'down']) {
            ctx.fillStyle = c[tone];
            for (let i = first; i <= last; i++) {
                const d = s.data[i];
                if (!d || (d.close >= d.open) !== (tone === 'up')) continue;
                const x = Math.round(this.time.x(i) * r), high = Math.round(p.y(d.high) * r), low = Math.round(p.y(d.low) * r);
                const top = Math.round(p.y(Math.max(d.open, d.close)) * r), bottom = Math.round(p.y(Math.min(d.open, d.close)) * r);
                ctx.fillRect((x - (wick >> 1)) / r, high / r, wick / r, Math.max(1, low - high) / r);
                if (body > wick) ctx.fillRect((x - (body >> 1)) / r, top / r, body / r, Math.max(1, bottom - top) / r);
            }
        }
        if (s.markers) this.markers(p, s, first, last);
    }
    // Arrows below the bar for buys and above it for sells. A marker may name a palette colour (one per participant)
    // and be hollow (an order that did not fill); several on one bar stack outwards.
    markers(p, s, first, last) {
        const { ctx } = this, c = this.colors, size = Math.max(4, Math.min(7, this.time.spacing * 0.45));
        for (let i = first; i <= last; i++) {
            const stacked = { buy: 0, sell: 0 };
            for (const m of s.markers.get(i) || []) {
                const d = s.data[i], x = this.time.x(i), buy = m.side === 'buy', dir = buy ? 1 : -1;
                const tip = (buy ? p.y(d.low) + 4 : p.y(d.high) - 4) + dir * stacked[m.side]++ * (size * 2 + 2);
                const color = c[m.color] || c[buy ? 'up' : 'down'];
                ctx.beginPath();
                ctx.moveTo(x, tip); ctx.lineTo(x + size, tip + dir * size); ctx.lineTo(x + size * 0.4, tip + dir * size);
                ctx.lineTo(x + size * 0.4, tip + dir * size * 2); ctx.lineTo(x - size * 0.4, tip + dir * size * 2);
                ctx.lineTo(x - size * 0.4, tip + dir * size); ctx.lineTo(x - size, tip + dir * size); ctx.closePath();
                if (m.hollow) { ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke(); }
                else { ctx.fillStyle = color; ctx.fill(); }
                const y0 = Math.min(tip, tip + dir * size * 2);
                this.hits.push({ x0: x - size - 2, x1: x + size + 2, y0: y0 - 2, y1: y0 + size * 2 + 2, id: m.id });
            }
        }
    }
    // The bars still to come in a 对决 round: a shaded area after the latest bar with a label, e.g. "未揭晓 · 还剩 23 天".
    // null removes it.
    setFuture(future) { this.future = future; this.invalidate(); }
    futureArea(plot) {
        const f = this.future;
        if (!f || !this.keys.length) return;
        const { ctx } = this, x0 = Math.max(0, this.time.x(this.keys.length - 1) + this.time.spacing / 2);
        const x1 = Math.min(plot, f.count ? x0 + f.count * this.time.spacing : plot);
        if (x1 - x0 < 2) return;
        ctx.fillStyle = this.colors.future; ctx.fillRect(x0, 0, x1 - x0, this.plotHeight);
        if (f.label && x1 - x0 > ctx.measureText(f.label).width + 12) {
            ctx.fillStyle = this.colors.text; ctx.textAlign = 'center'; ctx.fillText(f.label, (x0 + x1) / 2, (this.colors.fontSize + 8) / 2 + 4);
        }
    }
    line(p, s, first, last) {
        const { ctx } = this;
        ctx.strokeStyle = this.color(s.color || 'accent'); ctx.lineWidth = s.width || 1; ctx.lineJoin = 'round'; ctx.beginPath();
        let points = 0, pen = false, lone = null;
        for (let i = Math.max(0, first - 1); i <= Math.min(s.data.length - 1, last + 1); i++) {
            const v = s.data[i];
            if (v === null || v === undefined) { pen = false; continue; }
            const x = this.time.x(i), y = p.y(v);
            if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); lone = [x, y]; }
            pen = true; points++;
        }
        ctx.stroke();
        if (points === 1) { ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(lone[0], lone[1], (s.width || 1) + 1.5, 0, Math.PI * 2); ctx.fill(); }
    }
    histogram(p, s, first, last) {
        const { ctx } = this, { r, body } = this.columns(), base = Math.round(p.y(Math.max(p.min, 0)) * r);
        ctx.globalAlpha = s.alpha ?? 1;
        for (const tone of ['up', 'down', 'accent']) {
            ctx.fillStyle = this.colors[tone];
            for (let i = first; i <= last; i++) {
                const d = s.data[i];
                if (!d || (d.tone || 'accent') !== tone) continue;
                const x = Math.round(this.time.x(i) * r), y = Math.round(p.y(d.value) * r);
                ctx.fillRect((x - (body >> 1)) / r, Math.min(y, base) / r, body / r, Math.max(1, Math.abs(base - y)) / r);
            }
        }
        ctx.globalAlpha = 1;
    }

    // Tick labels, price lines and last values for one pane; later labels draw over earlier ones.
    axis(p, plot) {
        const { ctx } = this, c = this.colors, x = plot + 9;
        ctx.textAlign = 'left'; ctx.fillStyle = c.text;
        for (const v of p.ticks) {
            const y = p.y(v);
            if (y > p.top + 6 && y < p.top + p.height - 6) ctx.fillText(p.format(v), x, y);
        }
        const marks = [];
        for (const s of p.series) {
            if (!s.visible || !s.lastValue) continue;
            const v = this.last(s), d = s.data.at(-1);
            if (v === null) continue;
            marks.push({ value: v, color: s.kind === 'candles' ? (d.close >= d.open ? 'up' : 'down') : s.color || 'accent', dash: s.kind === 'candles' ? [1, 2] : null });
        }
        for (const line of [...marks, ...p.lines.map(l => ({ ...l, dash: l.dash === false ? null : [4, 3] }))]) {
            const y = p.y(line.value);
            if (y < p.top || y > p.top + p.height) continue;
            const color = this.color(line.color);
            if (line.dash) {
                ctx.save(); ctx.beginPath(); ctx.rect(0, p.top, plot, p.height); ctx.clip();
                ctx.strokeStyle = color; ctx.setLineDash(line.dash); ctx.beginPath();
                ctx.moveTo(0, this.crisp(y)); ctx.lineTo(plot, this.crisp(y)); ctx.stroke(); ctx.restore();
            }
            // Titles sit at the left end of the line, away from the newest bars.
            if (line.title) {
                const w = ctx.measureText(line.title).width + 8, h = c.fontSize + 4;
                ctx.fillStyle = c.background; ctx.fillRect(4, y - h / 2, w, h);
                ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.fillText(line.title, 8, y);
            }
            this.tag(p.format(line.value), plot, y, color);
        }
    }
    tag(text, plot, y, fill, ink = inkOn(fill)) {
        const { ctx } = this, h = this.colors.fontSize + 6;
        ctx.fillStyle = fill; ctx.fillRect(plot + 1, y - h / 2, this.axisWidth - 1, h);
        ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.fillText(text, plot + 9, y);
    }
    crosshair(plot) {
        const state = this.drag ? null : this.hover || this.pinned;
        if (!state || !this.keys.length) return;
        const { ctx } = this, c = this.colors, x = this.crisp(this.time.x(state.index));
        if (x < 0 || x > plot) return;
        ctx.strokeStyle = c.text; ctx.globalAlpha = 0.6; ctx.setLineDash([4, 4]); ctx.beginPath();
        ctx.moveTo(x, 0); ctx.lineTo(x, this.plotHeight);
        const pane = this.panes[state.pane], y = state.y ?? (state.value !== undefined && pane ? pane.y(state.value) : null);
        if (pane && y !== null && y >= pane.top && y <= pane.top + pane.height) { ctx.moveTo(0, this.crisp(y)); ctx.lineTo(plot, this.crisp(y)); }
        ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
        if (pane && y !== null && y >= pane.top && y <= pane.top + pane.height) this.tag(pane.format(pane.value(y)), plot, y, c.text, c.background);
        if (this.options.timeAxis) {
            const text = this.keys[state.index], w = ctx.measureText(text).width + 12, h = this.height - this.plotHeight;
            const left = Math.max(0, Math.min(plot - w, x - w / 2));
            ctx.fillStyle = c.text; ctx.fillRect(left, this.plotHeight + 1, w, h - 1);
            ctx.fillStyle = c.background; ctx.textAlign = 'center'; ctx.fillText(text, left + w / 2, this.plotHeight + h / 2);
        }
    }

    point(e) { const box = this.canvas.getBoundingClientRect(); return { x: e.clientX - box.left, y: e.clientY - box.top }; }
    region(x, y) {
        if (y >= this.plotHeight) return { kind: x < this.time.width ? 'time' : 'corner' };
        for (let k = 1; k < this.panes.length; k++) {
            if (this.panes[k].fixed || this.panes[k - 1].fixed) continue;
            if (Math.abs(y - this.panes[k].top) <= SEPARATOR_HIT) return { kind: 'separator', k };
        }
        const pane = Math.max(0, this.panes.findIndex(p => y >= p.top - 1 && y <= p.top + p.height));
        return { kind: x >= this.time.width ? 'axis' : 'plot', pane };
    }
    marker(x, y) { return this.hits.find(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1)?.id ?? null; }
    down(e) {
        if (e.button !== 0) return;
        const { x, y } = this.point(e), region = this.region(x, y), pane = this.panes[region.pane];
        this.drag = { region, x, y, from: this.time.from, to: this.time.to, moved: false,
            min: pane?.min, max: pane?.max, heights: this.panes.map(p => p.height) };
        this.canvas.setPointerCapture(e.pointerId);
    }
    move(e) {
        const { x, y } = this.point(e), d = this.drag;
        if (d) {
            const dx = x - d.x, dy = y - d.y;
            if (!d.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
            d.moved = true; this.hover = null; this.pinned = null;
            const pane = this.panes[d.region.pane], span = d.to - d.from;
            if (d.region.kind === 'plot') {
                const shift = dx * span / this.time.width;
                this.time.from = d.from - shift; this.time.to = d.to - shift; this.time.clamp();
                if (!pane.auto) { const move = dy / pane.height * (d.max - d.min); pane.min = d.min + move; pane.max = d.max + move; }
            } else if (d.region.kind === 'axis') {
                const half = (d.max - d.min) / 2 * Math.exp(dy * 0.006), mid = (d.max + d.min) / 2;
                pane.auto = false; pane.min = mid - half; pane.max = mid + half;
            } else if (d.region.kind === 'time') {
                this.time.from = d.to - span * Math.exp(-dx * 0.005); this.time.to = d.to; this.time.clamp();
            } else if (d.region.kind === 'separator') {
                const k = d.region.k, pair = d.heights[k - 1] + d.heights[k];
                const upper = Math.max(MIN_PANE, Math.min(pair - MIN_PANE, d.heights[k - 1] + dy)), sum = this.panes[k - 1].weight + this.panes[k].weight;
                this.panes[k - 1].weight = sum * upper / pair; this.panes[k].weight = sum - this.panes[k - 1].weight;
            }
            this.invalidate(); return;
        }
        const region = this.region(x, y);
        const marker = region.kind === 'plot' ? this.marker(x, y) : null;
        this.canvas.style.cursor = { plot: marker !== null ? 'pointer' : this.options.plotCursor(), axis: 'ns-resize', time: 'ew-resize',
            separator: 'row-resize' }[region.kind] || 'default';
        if (region.kind === 'plot' && this.keys.length) {
            const index = this.time.nearest(x);
            if (this.hover?.index !== index) this.options.onCrosshair(index);
            this.hover = { index, pane: region.pane, y }; this.pinned = null;
        } else if (this.hover) { this.hover = null; this.options.onCrosshair(null); }
        this.invalidate();
    }
    up(e) {
        const d = this.drag;
        this.drag = null;
        if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
        if (!d) return;
        if (!d.moved && d.region.kind === 'plot' && this.keys.length) {
            const pane = this.panes[d.region.pane];
            this.options.onClick({ index: this.time.nearest(d.x), pane: d.region.pane, price: pane.value(d.y), marker: this.marker(d.x, d.y) });
        }
        this.invalidate();
    }
    leave() { if (this.drag) return; if (this.hover) { this.hover = null; this.options.onCrosshair(null); } this.invalidate(); }
    wheel(e) {
        e.preventDefault();
        if (!this.keys.length) return;
        const scale = e.deltaMode === 1 ? 16 : 1;
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) this.time.pan(-e.deltaX * scale);
        else this.time.zoom(Math.exp(e.deltaY * scale * 0.0015), Math.min(this.time.width, this.point(e).x));
        this.invalidate();
    }
    doubleClick(e) {
        const { x, y } = this.point(e), region = this.region(x, y);
        if (region.kind === 'axis') { this.panes[region.pane].auto = true; this.invalidate(); }
        else if (region.kind === 'time') this.options.onReset();
    }
    destroy() {
        if (this.frame) cancelAnimationFrame(this.frame);
        this.frame = -1; this.width = 0;
        this.sizing.disconnect(); this.themeWatch?.disconnect();
        if (this.recolor) window.removeEventListener('vcp-appearance-changed', this.recolor);
        for (const [name, handler] of Object.entries(this.handlers)) this.canvas.removeEventListener(name, handler);
        this.canvas.remove(); this.root.classList.remove('vt-chart');
    }
}
