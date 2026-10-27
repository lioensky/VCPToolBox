// VTrade 对决 page: the shell, the screens and the first-run guide. Theme and trend colours follow the workbench.
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
    crypto.randomUUID = function() {
        if (typeof crypto.getRandomValues === 'function') {
            return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, function(c) {
                return (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16);
            });
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    };
}
import VCPUI from '../vendor/vcp-ui/vcp-ui.js';
import { openNotice, needsNotice } from '../workspace/notice.mjs';
import { h, put, local, api, setAgentPhotos } from './ui.mjs';
import { homeScreen } from './home.mjs';
import { setupScreen } from './setup.mjs';
import { gameScreen } from './game.mjs';
import { resultScreen, replayScreen } from './result.mjs';
import { careerScreen } from './career.mjs';

const body = document.body;
const PREFS = 'vtrade-next-prefs';
const GUIDE = 'vtrade-duel-guide-1';
const prefs = () => ({ theme: 'dark', trend: 'red-up', ...local.get(PREFS, {}) });
const systemLight = matchMedia('(prefers-color-scheme: light)');
function applyPrefs() {
    const p = prefs();
    body.dataset.vcpTheme = p.theme === 'system' ? (systemLight.matches ? 'light' : 'dark') : p.theme;
    body.dataset.trend = p.trend;
    theme?.update({ icon: body.dataset.vcpTheme === 'light' ? 'dark_mode' : 'light_mode' });
}
systemLight.addEventListener('change', () => { if (prefs().theme === 'system') applyPrefs(); });

const icon = (name, label, onClick) => {
    const control = VCPUI.create('IconButton', { icon: name, label, size: 'sm' });
    control.element.title = label;
    control.element.addEventListener('click', onClick);
    return control;
};
// 看盘 and 模拟交易 open the workbench with that layout; 对决 is this page.
const tab = (label, preset) => h('button.app-tab', { type: 'button', 'aria-current': preset ? undefined : 'page',
    on: { click: () => { if (!preset) { show('home'); return; } local.set('vtrade-next-preset', preset); location.href = '../workspace/'; } } }, label);
const title = h('div.duel-title', {}, h('span.ws-brand', {}, 'VTrade'), h('nav.app-tabs', { 'aria-label': 'VTrade 功能' },
    tab('看盘', 'watch'), tab('模拟交易', 'trade'), tab('对决', null)));
const help = icon('book-open', '玩法说明', () => onboarding());
const notice = icon('info', '免责声明', () => openNotice());
const theme = icon('light_mode', '切换深浅色', () => { local.set(PREFS, { ...prefs(), theme: body.dataset.vcpTheme === 'light' ? 'dark' : 'light' }); applyPrefs(); });
const view = h('main.duel-view');
const shell = VCPUI.create('AppPageShell', { title, actions: [h('div.ws-actions', {}, help.element, notice.element, theme.element)], content: view, windowControls: false });
body.append(shell.element);
applyPrefs();

const SCREENS = { home: homeScreen, setup: setupScreen, game: (ctx, p) => gameScreen(ctx, p.roundId), result: resultScreen, replay: replayScreen, career: careerScreen };
let current = null;
const query = new URLSearchParams(location.search);
const names = key => (query.get(key) || '').split(',').map(s => s.trim()).filter(Boolean);
// roster: the Chat Agents VCPChat's game hall syncs (names and avatars), and whether that hall is inviting Agents now.
const ctx = { show, onboarding, notice: () => openNotice(), roster: { agents: [], updatedAt: null, orchestrator: null }, loadRoster };
async function loadRoster() {
    try { ctx.roster = (await api('roster')).roster; setAgentPhotos(ctx.roster.agents); } catch { /* the page works without it */ }
    return ctx.roster;
}
function show(screen, params = {}) {
    current?.dispose();
    current = SCREENS[screen](ctx, params);
    put(view, current.element);
    view.dataset.screen = screen;
    view.scrollTop = 0;
    // A round link survives a reload; other screens start from the home page.
    const url = new URL(location.href);
    if (params.roundId && ['game', 'result', 'replay'].includes(screen)) url.searchParams.set('round', params.roundId);
    else url.searchParams.delete('round');
    url.searchParams.delete('agents'); url.searchParams.delete('mode'); url.searchParams.delete('roster');
    history.replaceState(null, '', url.pathname + url.search);
}

const STEPS = [
    ['在真实历史里操作', '每局是一段真实的历史行情。参赛者只能看到当天及以前的 K 线，每个交易日收盘后决定一次仓位，默认在下一交易日开盘成交。'],
    ['每天只决定一件事', '目标仓位分空仓、两成五、半仓、七成五、满仓五档，可选止损。系统按 100 股整手换算买卖，保持同一仓位不会再交易。'],
    ['成绩看水平，不只看运气', '结束后与 1000 个随机操作者比较，他们改仓的频率与你相同。评级按百分位给出；经验来自百分位和好的决定，不来自交易次数。'],
    ['与 Agent 同场', 'Agent 来自 Chat，轮到它时由 Chat 的编排器邀请它决定。各方的决定在结算前密封，结算后一并揭晓，并附 Agent 的一句理由。'],
];
function onboarding(step = 0) {
    return new Promise(resolve => {
        const content = h('div.guide');
        const next = VCPUI.create('Button', { label: '下一步', variant: 'primary', size: 'sm' });
        const skip = VCPUI.create('Button', { label: '跳过', variant: 'ghost', size: 'sm' });
        const dialog = VCPUI.create('Modal', { title: '对决玩法', size: 'md', content, actions: [skip, next], onClose: () => { local.set(GUIDE, true); resolve(); } });
        const paint = () => {
            const [heading, text] = STEPS[step];
            put(content, h('div.guide-dots', {}, STEPS.map((_, k) => h('i', { class: k === step ? 'on' : '' }))), h('h2', {}, heading), h('p', {}, text));
            next.update({ label: step === STEPS.length - 1 ? '开始' : '下一步' });
        };
        next.element.addEventListener('click', () => { if (step === STEPS.length - 1) dialog.close(true); else { step++; paint(); } });
        skip.element.addEventListener('click', () => dialog.close(false));
        paint();
        body.append(dialog.element);
    });
}

(async () => {
    const round = query.get('round'), agents = names('agents').slice(0, 3);
    await loadRoster();
    if (round && /^duel-[a-f0-9]{16}$/.test(round)) show('game', { roundId: round });
    else if (agents.length) show('setup', { mode: query.get('mode') === 'watch' ? 'watch' : 'duel', agents });
    else show('home');
    if (!local.get(GUIDE, false)) await onboarding();
    if (needsNotice()) await openNotice({ firstRun: true });
})();
