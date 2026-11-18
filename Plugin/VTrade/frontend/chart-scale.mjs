// Scale arithmetic for the VTrade chart engine. No DOM here, so Node tests cover it directly.

// Bar i sits at logical position i + 0.5; the view shows logical positions from..to across `width` pixels.
export class TimeScale {
    constructor({ minSpacing = 0.5, maxSpacing = 48 } = {}) {
        this.minSpacing = minSpacing; this.maxSpacing = maxSpacing;
        this.width = 0; this.count = 0; this.from = 0; this.to = 1;
    }
    get spacing() { return this.width / (this.to - this.from); }
    x(index) { return (index + 0.5 - this.from) * this.spacing; }
    position(x) { return this.from + x / this.spacing; }
    nearest(x) { return Math.max(0, Math.min(this.count - 1, Math.floor(this.position(x)))); }
    set(from, to) {
        if (!(to > from)) return;
        this.from = from; this.to = to; this.clamp();
    }
    // Spacing stays within limits around the right edge; at least one bar stays in view when panning.
    clamp() {
        if (!this.width) return;
        const span = Math.min(Math.max(this.to - this.from, this.width / this.maxSpacing, 1), this.width / this.minSpacing);
        this.from = this.to - span;
        if (!this.count) return;
        const shift = Math.max(0, 1 - this.to) - Math.max(0, this.from - (this.count - 1));
        this.from += shift; this.to += shift;
    }
    // A new plot width keeps the bar spacing and the right edge.
    resize(width) {
        const spacing = this.width ? this.spacing : 0;
        this.width = width;
        if (spacing) this.from = this.to - width / spacing;
        this.clamp();
    }
    zoom(factor, anchorX = this.width) {
        const anchor = this.position(anchorX), ratio = anchorX / this.width, span = (this.to - this.from) * factor;
        this.from = anchor - ratio * span; this.to = this.from + span; this.clamp();
    }
    pan(dx) { const shift = dx / this.spacing; this.from -= shift; this.to -= shift; this.clamp(); }
    // Bars whose slot [i, i + 1) overlaps the view.
    visible() { return [Math.max(0, Math.floor(this.from)), Math.min(this.count - 1, Math.ceil(this.to) - 1)]; }
}

export function niceStep(raw) {
    const power = 10 ** Math.floor(Math.log10(raw)), n = raw / power;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * power;
}
export function decimalsOf(step) {
    const text = step.toFixed(10).replace(/0+$/, '');
    return text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
}
export function priceTicks(min, max, count) {
    if (!(max > min) || count < 1) return [];
    const step = niceStep((max - min) / count), digits = decimalsOf(step), values = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) values.push(Number(v.toFixed(digits)));
    return values;
}

// Range of the visible data with fractional margins of the pane height; flat data still gets a usable band.
export function paddedRange(low, high, top, bottom) {
    if (!Number.isFinite(low) || !Number.isFinite(high)) return { min: 0, max: 1 };
    if (high - low < 1e-9) { const pad = Math.max(Math.abs(high) * 0.001, 0.01); low -= pad; high += pad; }
    const total = (high - low) / Math.max(0.05, 1 - top - bottom);
    return { min: low - total * bottom, max: high + total * top };
}

// Keys are ISO dates, or the counted days of a blind round ("前20", "第1天"). For dates, year starts outrank month
// starts, which outrank other days; for counted days, the first played day outranks every tenth day, then every
// fifth, and other days get no label (weight 0). Labels keep `gap` pixels apart.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function timeWeight(previous, key) {
    if (!DATE.test(key)) {
        const counted = /^(?:第(\d+)天|前(\d+))$/.exec(key), n = Number(counted?.[1] ?? counted?.[2]);
        if (!counted) return 1;
        if (counted[1] === '1') return 3;
        return n % 10 === 0 ? 2 : n % 5 === 0 ? 1 : 0;
    }
    if (!previous || previous.slice(0, 4) !== key.slice(0, 4)) return 3;
    return previous.slice(5, 7) !== key.slice(5, 7) ? 2 : 1;
}
export function timeLabel(key, weight) {
    if (!DATE.test(key)) return key;
    return weight === 3 ? key.slice(0, 4) : weight === 2 ? `${Number(key.slice(5, 7))}月` : `${Number(key.slice(8, 10))}日`;
}
export function timeLabels(keys, first, last, x, gap) {
    const candidates = [];
    for (let i = first; i <= last; i++) {
        const weight = timeWeight(keys[i - 1], keys[i]);
        if (weight) candidates.push({ index: i, weight, x: x(i) });
    }
    candidates.sort((a, b) => b.weight - a.weight || a.index - b.index);
    const chosen = [];
    for (const c of candidates) if (chosen.every(o => Math.abs(o.x - c.x) >= gap)) chosen.push(c);
    return chosen.sort((a, b) => a.index - b.index).map(c => ({ ...c, text: timeLabel(keys[c.index], c.weight) }));
}

export function formatVolume(value) {
    if (value >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
    if (value >= 1e4) return `${(value / 1e4).toFixed(value >= 1e6 ? 0 : 1)}万`;
    return String(Math.round(value));
}
