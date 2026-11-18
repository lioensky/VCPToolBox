// Small DOM and formatting helpers shared by the 对决 screens. Controls come from VCPUI; layout from duel.css.
import VCPUI from '../vendor/vcp-ui/vcp-ui.js';
import { command, local } from '../workspace/store.mjs';

export { local };
// The page interface: round setup, the player's decisions, results and the career. Tool calls cannot reach it.
export const api = (action, input = {}) => command({ action, ...input }, 'duel');
export const marketApi = input => command(input, 'market');

// h('div.class', { on: { click }, attrs, dataset, text }, ...children)
export function h(spec, props = {}, ...children) {
    const [tag, ...classes] = spec.split('.');
    const element = document.createElement(tag || 'div');
    if (classes.length) element.className = classes.join(' ');
    if (props === null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) { children.unshift(props); props = {}; }
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'on') for (const [name, handler] of Object.entries(value)) element.addEventListener(name, handler);
        else if (key === 'dataset') Object.assign(element.dataset, value);
        else if (key === 'text') element.textContent = value;
        else if (key === 'class') element.className += ` ${value}`;
        // The page's CSP forbids style attributes; properties set through the CSSOM are allowed.
        else if (key === 'style') for (const rule of String(value).split(';')) {
            const at = rule.indexOf(':');
            if (at > 0) element.style.setProperty(rule.slice(0, at).trim(), rule.slice(at + 1).trim());
        }
        else if (key in element && typeof value !== 'string') element[key] = value;
        else element.setAttribute(key, value === true ? '' : value);
    }
    append(element, children);
    return element;
}
function append(element, children) {
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue;
        element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
}
export function put(node, ...children) { node.replaceChildren(); append(node, children); return node; }

export function button(label, onClick, { variant = 'secondary', size = 'md', disabled = false, icon } = {}) {
    const control = VCPUI.create('Button', { label, variant, size, disabled, icon });
    if (onClick) control.element.addEventListener('click', onClick);
    return control;
}
export function segmented(items, value, onChange, { size = 'md', label = '选项' } = {}) {
    const control = VCPUI.create('SegmentedControl', { items, value, size, label });
    control.element.addEventListener('change', () => onChange(control.element.querySelector('[aria-checked="true"]')?.dataset.value));
    return control;
}
export function select(options, value, onChange, { size = 'md', label } = {}) {
    const element = h('select.vcp-ui-select', { dataset: { size }, 'aria-label': label, on: { change: () => onChange(element.value) } },
        options.map(([v, text]) => h('option', { value: String(v), selected: String(v) === String(value) }, text)));
    return element;
}
export const notify = (message, variant = 'info') => VCPUI.feedback.toast(message, { variant: variant === 'danger' ? 'critical' : variant });
export function modal({ title, content, actions = [], size = 'md', dismissible = true, onClose }) {
    const dialog = VCPUI.create('Modal', { title, size, content, actions: actions.map(a => a.control || a), closeOnBackdrop: dismissible, dismissible, onClose });
    document.body.append(dialog.element);
    return dialog;
}

// Numbers. Money is in cents; rates are fractions.
export const sign = value => (value > 0 ? '+' : value < 0 ? '−' : '');
export const pct = (value, digits = 1) => `${sign(value)}${Math.abs(value * 100).toFixed(digits)}%`;
export const share = value => `${Math.round(value * 100)}%`;
export function money(cents, { signed = false } = {}) {
    const abs = Math.abs(cents), prefix = signed ? sign(cents) : cents < 0 ? '−' : '';
    if (abs >= 1e10) return `${prefix}${(abs / 1e10).toFixed(abs >= 1e11 ? 1 : 2)} 亿元`;
    if (abs >= 1e6) return `${prefix}${(abs / 1e6).toFixed(abs >= 1e8 ? 1 : 2)} 万元`;
    return `${prefix}${(abs / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 元`;
}
export const price = cents => (cents / 100).toFixed(2);
export const tone = value => (value > 1e-12 ? 'up' : value < -1e-12 ? 'down' : 'flat');
export const num = (text, toneName) => h('span.num', { dataset: toneName ? { tone: toneName } : undefined }, text);
export const LEVEL_NAMES = { 0: '空仓', 25: '两成五', 50: '半仓', 75: '七成五', 100: '满仓' };
export const levelName = level => LEVEL_NAMES[level] ?? `${level}%`;

// Participants: one colour each, shared by the chart markers (palette keys seat1..seat4) and the page.
export const seatIndex = seat => Number(seat.id.slice(5)) - 1;
export const seatColor = seat => `seat${seatIndex(seat) + 1}`;
// Avatars of Chat Agents, from the roster VCPChat syncs; an Agent without one shows its initial.
const agentPhotos = new Map();
export function setAgentPhotos(agents) { agentPhotos.clear(); for (const agent of agents) if (agent.avatar) agentPhotos.set(agent.name, agent.avatar); }
export function avatar(seat, size = '') {
    const initial = seat.kind === 'human' ? '你' : [...(seat.label || seat.agent || '?')][0].toUpperCase();
    const photo = seat.kind === 'agent' ? agentPhotos.get(seat.agent || seat.label) : null;
    return h(`span.avatar${size ? `.${size}` : ''}${photo ? '.photo' : ''}`, { dataset: { seat: String(seatIndex(seat) + 1) }, 'aria-hidden': 'true' },
        photo ? h('img', { src: photo, alt: '' }) : initial);
}
export const seatName = seat => (seat.kind === 'human' ? '你' : seat.label);
export function grade(letter, size = '') { return h(`span.grade${size ? `.${size}` : ''}`, { dataset: { grade: letter } }, letter); }
export const MODE_NAMES = { solo: '单练', watch: '观战', duel: '同场对决' };
export const KIND_NAMES = { blind: '盲测', daily: '每日挑战', known: '明牌', classic: '名局重现' };
export function roundTitle(view) {
    const kind = view.problem.kind === 'classic' ? `名局重现 · ${view.problem.classicName}`
        : view.problem.kind === 'blind' && view.strict ? '严格盲测' : KIND_NAMES[view.problem.kind];
    const mode = view.challenge ? `资金挑战 · 第 ${view.challenge.round} 局` : MODE_NAMES[view.mode];
    return `${mode} · ${kind} · ${view.revealed ? `${view.problem.name}（${view.problem.code}）` : view.problem.label}`;
}
// 资金挑战 progress on a log scale from 1 万 to 1 亿, with the 10 万, 100 万 and 1000 万 marks.
export const MARK_NAMES = { 10000000: '10 万', 100000000: '100 万', 1000000000: '1000 万', 10000000000: '1 亿' };
export function challengeTrack(challenge, cents = challenge.cashCents) {
    const at = value => Math.max(0, Math.min(1, Math.log10(value / challenge.startCents) / Math.log10(challenge.goalCents / challenge.startCents)));
    const marks = [...challenge.marks, challenge.goalCents];
    return h('div.challenge-track', { role: 'img', 'aria-label': `资金 ${money(cents)}，目标 1 亿元` },
        h('i.fill', { style: `width:${(at(cents) * 100).toFixed(1)}%` }),
        marks.map(mark => h('span.mark', { class: cents >= mark ? 'passed' : '', style: `left:${(at(mark) * 100).toFixed(1)}%` },
            h('b', {}, MARK_NAMES[mark]))));
}
export const NOTICE = '虚拟资金和历史行情，不连接券商，不构成投资建议。理财有风险，投资需谨慎。';
