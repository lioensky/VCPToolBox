// The settings panel of one indicator: its parameters, and the colour and width of each line. It floats over the
// chart so each change shows as it is made; every valid change applies and is saved at once, and an invalid value
// is marked and left unapplied until it is corrected.
import { INDICATORS, DEFAULT_CHART_INDICATORS, LINE_COLORS, indicatorLines } from './indicators.mjs';
import { el, iconButton } from './indicator-layer.mjs';

// [key, label, min, max, step]
const FIELDS = {
    boll: [['period', '周期', 2, 250, 1], ['multiplier', '倍数', 0.1, 5, 0.1]],
    macd: [['fast', '快线周期', 2, 250, 1], ['slow', '慢线周期', 2, 250, 1], ['signal', '信号周期', 2, 250, 1]],
    kdj: [['period', '周期', 2, 250, 1], ['smoothK', 'K 平滑', 2, 250, 1], ['smoothD', 'D 平滑', 2, 250, 1]],
    rsi: [['period', '周期', 2, 250, 1]],
};
// Two theme colours (they follow light and dark), then fixed colours that read on both backgrounds.
const SWATCHES = [['ma5', '文字色'], ['ma10', '琥珀'], ['#a970ff', '紫'], ['#2f8cff', '蓝'], ['#00b8a9', '青绿'], ['#ff7a45', '橙'],
    ['#ff4fa3', '粉'], ['#f2c200', '黄'], ['#2fbf71', '绿'], ['#1fc8ff', '天蓝'], ['#6c63ff', '靛'], ['#c08457', '棕'], ['#8c8c8c', '灰'],
    ['accent', '强调色']];
const WIDTHS = [[1, '细'], [2, '中'], [3, '粗']];
const MAX_PERIODS = 6;

export function openIndicatorEditor(layer, id, onClose) {
    const spec = INDICATORS[id], periodic = id === 'ma' || id === 'ema';
    const panel = el('section', 'ind-editor');
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', `${spec.name} ${spec.title}设置`);
    // The values being edited; a valid draft is applied to the chart, an invalid one only marks the field.
    const draft = { params: structuredClone(layer.selection.params[id]), styles: structuredClone(layer.selection.styles[id]) };
    const error = el('p', 'ind-error'); error.setAttribute('role', 'alert');
    const body = el('div', 'ind-editor-body');

    function apply() {
        try {
            layer.change(s => { s.params[id] = structuredClone(draft.params); s.styles[id] = structuredClone(draft.styles); });
            error.textContent = '';
            body.querySelectorAll('[aria-invalid="true"]').forEach(input => input.removeAttribute('aria-invalid'));
            return true;
        } catch (failure) { error.textContent = failure.message; return false; }
    }
    function numberInput(value, [min, max, step], label, onInput) {
        const input = el('input', 'ind-number'); input.type = 'number'; input.inputMode = 'decimal';
        Object.assign(input, { min: String(min), max: String(max), step: String(step), value: String(value) });
        input.setAttribute('aria-label', label);
        input.addEventListener('input', () => {
            onInput(input.value === '' ? NaN : Number(input.value));
            if (!apply()) input.setAttribute('aria-invalid', 'true');
        });
        return input;
    }
    function swatch(k, label) {
        const wrap = el('div', 'ind-swatch-wrap');
        const button = el('button', 'ind-swatch'); button.type = 'button';
        button.setAttribute('aria-label', `${label}颜色`); button.setAttribute('aria-expanded', 'false');
        const paint = () => button.style.setProperty('--ind-color', layer.chart.color(draft.styles[k].color));
        paint();
        button.addEventListener('click', () => {
            const open = button.getAttribute('aria-expanded') === 'true';
            body.querySelectorAll('.ind-palette').forEach(node => node.remove());
            body.querySelectorAll('.ind-swatch[aria-expanded="true"]').forEach(node => node.setAttribute('aria-expanded', 'false'));
            if (open) return;
            button.setAttribute('aria-expanded', 'true');
            const grid = el('div', 'ind-palette'); grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', `${label}颜色`);
            for (const [color, name] of SWATCHES) {
                const choice = el('button', 'ind-palette-color'); choice.type = 'button';
                choice.style.setProperty('--ind-color', layer.chart.color(color));
                choice.setAttribute('aria-label', name);
                choice.setAttribute('aria-pressed', String(draft.styles[k].color === color));
                choice.addEventListener('click', () => { draft.styles[k].color = color; paint(); apply(); grid.remove(); button.setAttribute('aria-expanded', 'false'); });
                grid.append(choice);
            }
            const custom = el('label', 'ind-palette-custom', '自定义');
            const picker = el('input'); picker.type = 'color';
            picker.value = /^#[0-9a-f]{6}$/i.test(draft.styles[k].color) ? draft.styles[k].color : '#1fa2ff';
            picker.addEventListener('input', () => { draft.styles[k].color = picker.value.toLowerCase(); paint(); apply(); });
            custom.append(picker); grid.append(custom);
            wrap.closest('.ind-line').after(grid);
        });
        wrap.append(button);
        return wrap;
    }
    function widths(k, label) {
        const group = el('div', 'ind-widths'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', `${label}线宽`);
        for (const [width, name] of WIDTHS) {
            const button = el('button', 'ind-width'); button.type = 'button'; button.dataset.width = String(width);
            button.setAttribute('aria-pressed', String(draft.styles[k].width === width)); button.setAttribute('aria-label', `${name}线`);
            button.append(el('i'));
            button.addEventListener('click', () => {
                draft.styles[k].width = width; apply();
                group.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.width) === width)));
            });
            group.append(button);
        }
        return group;
    }
    // A line's colour, its label or other controls, and its width.
    function lineRow(k, label, middle = [el('span', 'ind-line-label', label)]) {
        const row = el('div', 'ind-line');
        row.append(swatch(k, label), ...middle, widths(k, label));
        return row;
    }

    function paint() {
        body.replaceChildren();
        if (periodic) {
            const list = el('div', 'ind-lines');
            draft.params.periods.forEach((period, k) => {
                const label = `${spec.name}${period}`;
                const input = numberInput(period, [2, 250, 1], `第 ${k + 1} 条${spec.name}的周期`, value => { draft.params.periods[k] = value; });
                const remove = draft.params.periods.length > 1 ? iconButton('close', `移除 ${label}`, () => {
                    draft.params.periods.splice(k, 1); draft.styles.splice(k, 1); if (apply()) paint();
                }) : el('span', 'ind-tool-space');
                list.append(lineRow(k, label, [el('span', 'ind-line-label', spec.name), input, remove]));
            });
            body.append(el('h4', '', '周期与线条'), list);
            if (draft.params.periods.length < MAX_PERIODS) {
                const add = el('button', 'ind-add', '添加周期'); add.type = 'button';
                add.addEventListener('click', () => {
                    const used = new Set(draft.params.periods);
                    const next = [5, 10, 20, 30, 60, 120, 250].find(p => !used.has(p)) ?? Math.min(250, Math.max(...used) + 1);
                    draft.params.periods.push(next);
                    draft.styles.push({ color: LINE_COLORS[(draft.styles.length) % LINE_COLORS.length], width: 1 });
                    if (apply()) paint();
                });
                body.append(add);
            }
        } else {
            const fields = el('div', 'ind-fields');
            for (const [key, label, ...range] of FIELDS[id]) {
                const field = el('label', 'ind-field');
                field.append(el('span', '', label), numberInput(draft.params[key], range, `${spec.name} ${label}`, value => { draft.params[key] = value; }));
                fields.append(field);
            }
            const lines = el('div', 'ind-lines');
            indicatorLines(id, draft.params).forEach((line, k) => {
                if (line.bars) { lines.append(el('p', 'ind-note', 'MACD 柱按涨跌色绘制，正值为涨色、负值为跌色。')); return; }
                lines.append(lineRow(k, line.label));
            });
            body.append(el('h4', '', '参数'), fields, el('h4', '', '线条'), lines);
        }
        body.append(error);
    }

    const close = () => {
        document.removeEventListener('keydown', keydown, true);
        document.removeEventListener('pointerdown', outside, true);
        panel.remove(); onClose();
    };
    const keydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    // A press outside closes the panel, except on the legend or switches, whose own buttons decide what to open.
    const outside = event => { if (!panel.contains(event.target) && !event.target.closest?.('.ind-legends, .ind-toolbar')) close(); };
    const reset = el('button', 'ind-text-button', '恢复默认'); reset.type = 'button';
    reset.addEventListener('click', () => {
        draft.params = structuredClone(DEFAULT_CHART_INDICATORS.params[id]);
        draft.styles = indicatorLines(id, draft.params).map((_, k) => ({ color: LINE_COLORS[k % LINE_COLORS.length], width: 1 }));
        if (apply()) paint();
    });
    const done = el('button', 'ind-text-button primary', '完成'); done.type = 'button';
    done.addEventListener('click', close);
    const header = el('header', 'ind-editor-head');
    header.append(el('strong', '', `${spec.name} · ${spec.title}`), iconButton('close', '关闭设置', close));
    const footer = el('footer', 'ind-editor-foot');
    footer.append(el('span', 'ind-saved', '修改即时生效并自动保存'), reset, done);
    panel.append(header, el('p', 'ind-hint', spec.hint), body, footer);
    paint();
    // Below any toolbar above the chart: the panel starts at the chart's top edge.
    const top = layer.host.offsetParent === layer.panelRoot ? layer.host.offsetTop + 8 : 8;
    panel.style.setProperty('top', `${top}px`); panel.style.setProperty('max-height', `calc(100% - ${top + 8}px)`);
    layer.panelRoot.append(panel);
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('pointerdown', outside, true);
    panel.querySelector('input, button.ind-swatch')?.focus({ preventScroll: true });
    return { id, close };
}
