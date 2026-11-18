import { uid } from './dock.mjs';

// Preset layouts. split(dir, [share, node], ...) and group(...panels) build a fresh model each time.
function build(make) {
    const panels = {};
    const panel = (kind, link = 'a', state = {}) => { const id = uid('p'); panels[id] = { kind, link, state }; return id; };
    const group = (...ids) => ({ type: 'group', id: uid('g'), tabs: ids, active: ids[0] });
    const split = (dir, ...parts) => ({ type: 'split', dir, sizes: parts.map(p => p[0]), children: parts.map(p => p[1]) });
    return { root: make({ panel, group, split }), panels };
}

// mode: 'market' browses the local market directly; 'run' works inside a simulation (account plus replay clock).
export const PRESETS = Object.freeze({
    watch: { label: '看盘', mode: 'market', make: () => build(({ panel, group, split }) => split('row',
        [.25, group(panel('watchlist'))],
        [.57, group(panel('chart'))],
        [.18, group(panel('quote'), panel('guide'))])) },
    trade: { label: '模拟交易', mode: 'run', make: () => build(({ panel, group, split }) => split('row',
        [.22, group(panel('watchlist'))],
        [.52, split('col', [.7, group(panel('chart'))], [.3, group(panel('positions'), panel('orders'), panel('journal'))])],
        [.26, split('col', [.62, group(panel('order'), panel('quote'), panel('conditional'))], [.38, group(panel('equity'))])])) },
    review: { label: '复盘', mode: 'run', make: () => build(({ panel, group, split }) => split('row',
        [.62, split('col', [.6, group(panel('chart'))], [.4, group(panel('equity'))])],
        [.38, split('col', [.55, group(panel('orders'), panel('journal'))], [.45, group(panel('positions'), panel('watchlist'))])])) },
});
