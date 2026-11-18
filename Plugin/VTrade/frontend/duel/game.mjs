// The round screen: the chart up to the current day, the table, and the player's decision for the next day.
// Agent seats decide through the Chat orchestrator; while one is thinking the page polls the round.
import { DuelChart } from './duel-chart.mjs';
import { equityStrip } from './equity.mjs';
import { h, put, api, button, select, notify, pct, share, money, price, tone, num, levelName, avatar, seatName,
    seatColor, roundTitle, NOTICE } from './ui.mjs';

const LEVELS = [0, 25, 50, 75, 100];
const STOPS = [[0, '不设止损'], [5, '跌破成本 5%'], [8, '跌破成本 8%'], [10, '跌破成本 10%']];
const POLL_MS = 1500;
// Agents usually answer within a minute or two; only after this long does the page offer to keep their position.
const HOLD_AFTER_MS = 180000;

function fillText(fill) {
    if (!fill) return null;
    if (fill.failed) return `${fill.side === 'buy' ? '买入' : '卖出'}未成交：${fill.reason}`;
    return `${fill.side === 'buy' ? '买入' : '卖出'} ${fill.quantity.toLocaleString('zh-CN')} 股，成交价 ${price(fill.priceCents)}`;
}

export function gameScreen(ctx, roundId) {
    const state = { view: null, target: 0, stopPct: 0, reason: '', busy: false, auto: false, waitingSince: null, timer: 0, disposed: false };
    const element = h('div.duel-game');
    const top = h('header.game-top'), legend = h('div.chart-legend'), host = h('div.chart-host');
    const chartBox = h('section.game-chart', {}, legend, host), equity = equityStrip();
    const side = h('aside.game-side'), bottom = h('footer.game-bottom');
    element.append(top, h('div.game-main', {}, chartBox, equity.element), side, bottom);
    const panels = { facts: h('section.panel'), action: h('section.panel.action-panel'), watch: h('section.panel'),
        opponents: h('div.opponents'), highlights: h('section.panel'), log: h('section.panel') };
    let chart = null;

    const me = () => state.view?.seats.find(s => s.kind === 'human');
    const agents = () => state.view?.seats.filter(s => s.kind === 'agent') ?? [];
    const latestIndex = () => state.view.bars.length - 1;

    async function load() {
        try {
            const { round } = await api('view', { roundId });
            if (state.disposed) return;
            const first = !state.view;
            accept(round);
            if (first) { const seat = me(); state.target = seat?.target ?? 0; state.stopPct = seat?.stopPct ?? 0; }
            paint();
        } catch (error) { notify(error.message, 'danger'); ctx.show('home'); }
    }
    function accept(round) {
        const advanced = state.view && round.day !== state.view.day;
        state.view = round;
        if (advanced) { state.waitingSince = null; const seat = me(); if (seat) state.target = seat.target; }
        if (round.status === 'finished') { stopPolling(); ctx.show('result', { roundId }); return; }
        const waiting = agents().some(s => !s.decided);
        if (waiting && !state.waitingSince) state.waitingSince = Date.now();
        if (waiting || (me() && me().decided)) startPolling(); else stopPolling();
    }
    function startPolling() {
        if (state.timer || state.disposed) return;
        state.timer = setInterval(async () => {
            try {
                const { round } = await api('view', { roundId });
                if (state.disposed) return;
                const before = state.view;
                accept(round);
                if (round.status !== 'active') return;
                if (round.day !== before.day) { celebrate(round); paint(); }
                else paintWaiting();
            } catch { /* the next poll retries */ }
        }, POLL_MS);
    }
    function stopPolling() { clearInterval(state.timer); state.timer = 0; }

    // Highlights of the day just settled, for the player first; other seats' highlights show in the panel.
    function celebrate(view) {
        const row = view.log.at(-1);
        if (!row) return;
        const seat = me() || view.seats[0], entry = row.entries[seat.id];
        if (entry?.highlights?.length) notify(entry.highlights.map(item => item.text).join('　'), 'success');
        if (entry?.stopped) notify('触发止损，已按计划清仓。', 'warning');
    }

    function paint() {
        const view = state.view;
        paintTop();
        if (!chart) {
            chart = new DuelChart(host, { onCrosshair: index => paintLegend(index), panelRoot: chartBox });
            chartBox.prepend(chart.indicators.toolbar());
        }
        chart.update(view);
        equity.update(view);
        paintLegend(null);
        paintFacts();
        put(side, panels.facts, me() ? panels.action : panels.watch, agents().length ? panels.opponents : null, panels.highlights, panels.log);
        if (me()) paintAction(); else paintWatch();
        paintOpponents(); paintHighlights(); paintLog(); paintBottom();
    }
    function paintTop() {
        const view = state.view;
        const chips = [...view.seats.map(seat => {
            const today = view.day ? seat.equity.at(-1) - seat.equity.at(-2) : 0;
            return h('div.player', { dataset: { seat: seatColor(seat) } }, avatar(seat),
                h('div.who', {}, h('strong', {}, seatName(seat)), h('span', {}, `仓位 ${share(seat.position)}`),
                    h('div.posbar', {}, h('i', { style: `width:${Math.round(seat.position * 100)}%` }))),
                h('div.score', {}, num(pct(seat.returnRate), tone(seat.returnRate)),
                    view.day ? h('span.today', { dataset: { tone: tone(today) } }, `今日 ${money(today, { signed: true })}`) : null));
        }), h('div.player.bench', {}, h('span.avatar.bench', { 'aria-hidden': 'true' }, '持'),
            h('div.who', {}, h('strong', {}, '买入持有'), h('span', {}, '基准')),
            h('div.score', {}, num(pct(view.hold.at(-1) / view.hold[0] - 1), tone(view.hold.at(-1) - view.hold[0]))))];
        put(top,
            button('返回首页', () => ctx.show('home'), { variant: 'ghost', size: 'sm' }).element,
            h('div.game-title', {}, h('strong', {}, roundTitle(view)),
                h('span', {}, view.revealed ? '名称和日期公开' : view.strict ? '严格盲测：价格以开局前一天收盘为 100，成交量为 20 日相对值' : '名称、代码和日期在结束后揭晓')),
            h('div.daybar', {}, h('span.num', {}, `第 ${view.day} `, h('small', {}, `/ ${view.lengthDays} 天`)),
                h('div.progress', {}, h('i', { style: `width:${view.day / view.lengthDays * 100}%` }))),
            h('div.scoreboard', {}, chips));
    }
    function paintLegend(index) {
        const view = state.view, i = index === null || index === undefined ? latestIndex() : Math.min(index, latestIndex());
        const bar = view.bars[i], previous = view.bars[i - 1];
        const change = previous ? bar.closeCents / previous.closeCents - 1 : null, t = change === null ? 'flat' : tone(change);
        const pair = (label, text, toneName = t) => h('span.ohlc-pair', { dataset: { tone: toneName } }, h('i', {}, label), text);
        put(legend, h('span.ohlc-pair.date', {}, bar.key), pair('开', price(bar.openCents)), pair('高', price(bar.highCents)),
            pair('低', price(bar.lowCents)), pair('收', price(bar.closeCents)), change === null ? null : pair('幅', pct(change, 2)),
            h('span.muted', {}, view.strict ? `相对量 ${bar.relativeVolume.toFixed(2)}` : `量 ${(bar.volume / 10000).toFixed(1)} 万股`));
    }
    function paintFacts() {
        const view = state.view, bar = view.bars.at(-1), previous = view.bars.at(-2), base = view.bars.at(-21) || view.bars[0];
        const change = bar.closeCents / previous.closeCents - 1, swing = (bar.highCents - bar.lowCents) / previous.closeCents;
        const fact = (label, value, toneName) => h('div', {}, h('dt', {}, label), h('dd', { dataset: toneName ? { tone: toneName } : undefined }, value));
        const limit = bar.limitUpCents !== undefined && bar.closeCents >= bar.limitUpCents ? '收盘涨停'
            : bar.limitDownCents !== undefined && bar.closeCents <= bar.limitDownCents ? '收盘跌停' : null;
        put(panels.facts, h('h3', {}, view.revealed ? `${view.problem.name} ${view.problem.code}` : view.problem.label,
            h('span', {}, limit || (view.revealed ? '明牌' : '名称已隐藏'))),
        h('dl.facts', {},
            fact(view.strict ? '价格指数' : '现价', price(bar.closeCents), tone(change)), fact('涨跌', pct(change, 2), tone(change)),
            fact('振幅', pct(swing, 2).replace('+', '')), fact('20 日涨跌', pct(bar.closeCents / base.closeCents - 1), tone(bar.closeCents - base.closeCents)),
            view.strict ? fact('相对量', bar.relativeVolume.toFixed(2)) : fact('成交量', `${(bar.volume / 10000).toFixed(1)} 万股`),
            !view.strict && bar.amount ? fact('成交额', money(bar.amount * 100)) : null,
            bar.limitUpCents !== undefined ? fact('次日涨停', price(Math.round(bar.closeCents * bar.limitUpCents / previous.closeCents))) : null,
            bar.limitDownCents !== undefined ? fact('次日跌停', price(Math.round(bar.closeCents * bar.limitDownCents / previous.closeCents))) : null,
            ...fundamentals(view.fundamentals).map(([label, value]) => fact(label, value))));
    }
    // Market values and ratios from the latest report announced by the current day, when a financial file is set.
    function fundamentals(f) {
        if (!f) return [];
        const yi = cents => `${(cents / 1e10).toFixed(cents >= 1e11 ? 0 : 1)} 亿`;
        return [f.marketCapCents ? ['总市值', yi(f.marketCapCents)] : null, f.floatCapCents ? ['流通市值', yi(f.floatCapCents)] : null,
            f.pe !== null ? ['市盈率 TTM', f.pe.toFixed(1)] : null, f.pb !== null ? ['市净率', f.pb.toFixed(2)] : null,
            f.roe !== null ? ['ROE', pct(f.roe).replace('+', '')] : null, f.profitGrowth !== null ? ['净利润同比', pct(f.profitGrowth)] : null].filter(Boolean);
    }
    function paintAction() {
        const view = state.view, seat = me(), last = view.log.at(-1)?.entries[seat.id];
        const sealed = seat.decided, fill = view.settings.fill;
        const levels = h('div.levels', { role: 'group', 'aria-label': '目标仓位' }, LEVELS.map((level, k) => h('button', { type: 'button',
            class: level === seat.target ? 'current' : '', 'aria-pressed': String(state.target === level), disabled: sealed || state.busy,
            on: { click: () => { state.target = level; paintAction(); } } }, h('b', {}, level === 0 ? '空' : level === 100 ? '满' : String(level)), h('small', {}, String(k)))));
        const stop = select(STOPS, state.stopPct, value => { state.stopPct = Number(value); }, { size: 'sm', label: '止损' });
        stop.disabled = sealed || state.busy;
        const reason = h('input.vcp-ui-input', { type: 'text', maxLength: 120, value: state.reason, placeholder: '理由（可选，结算后同场可见）',
            'aria-label': '理由', disabled: sealed || state.busy, on: { input: event => { state.reason = event.target.value; } } });
        const plan = state.target === seat.target ? '保持当前仓位，不会买卖。'
            : fill === 'open' ? `第 ${view.day + 1} 天按开盘价调到${levelName(state.target)}；涨停开盘买不进，跌停开盘卖不出。`
                : `按今天收盘价调到${levelName(state.target)}；收盘涨停买不进，收盘跌停卖不出。`;
        panels.confirm = button('', () => confirm(), { variant: 'primary', size: 'lg' });
        put(panels.action,
            h('h3', {}, '本回合', h('span', {}, view.day ? `第 ${view.day} 天收盘后` : '开局前')),
            h('div.row-between', {}, h('span.muted', {}, '当前仓位'),
                h('span', {}, num(share(seat.position)), h('span.faint', {}, ` · 持股 ${seat.shares.toLocaleString('zh-CN')} · 现金 ${money(seat.cashCents)}`))),
            last?.fill ? h('p', { class: last.fill.failed ? 'notice' : 'hint' }, `第 ${view.day} 天：${fillText(last.fill)}`) : null,
            levels,
            h('div.row-between', {}, h('span.muted', {}, '止损'), stop),
            h('div.vcp-ui-input-wrap', { dataset: { size: 'sm' } }, reason),
            h('p.hint', {}, sealed ? '你的决定已密封，等其他参赛者决定后一起揭晓。' : plan),
            panels.confirm.element);
        paintConfirm();
    }
    function paintConfirm() {
        if (!panels.confirm) return;
        const view = state.view, seat = me(), waiting = agents().filter(s => !s.decided).map(s => s.label);
        const label = state.busy ? '结算中' : seat?.decided ? (waiting.length ? `等待 ${waiting.join('、')} 决定` : '结算中')
            : `确定，进入第 ${view.day + 1} 天`;
        panels.confirm.update({ label, disabled: state.busy || Boolean(seat?.decided) });
    }
    function paintWaiting() { paintConfirm(); paintOpponents(); if (!me()) paintWatch(); }
    // How long ago an Agent seat was invited today, and how many times; null before the first invitation.
    const invitedOf = seat => state.view.orchestrator?.invited?.[seat.id] ?? null;
    function thinking(seat) {
        const sent = invitedOf(seat);
        if (!sent && state.view.paused) return '已暂停';
        if (!sent) return state.view.orchestrator?.connected === false ? '未邀请' : '排队等待邀请';
        return `思考中 ${Math.round(sent.sinceMs / 1000)} 秒${sent.count > 1 ? ` · 第 ${sent.count} 次邀请` : ''}`;
    }
    // Agents decide only when VCPChat's game hall invites them; without it they would wait, so say so at once. A seat
    // invited in the last three minutes means the hall is working even if it has not polled for a moment.
    function offlineBanner() {
        const waiting = agents().filter(s => !s.decided), status = state.view.orchestrator;
        if (state.view.paused || !waiting.length || !status || status.connected) return null;
        if (waiting.some(seat => (invitedOf(seat)?.sinceMs ?? Infinity) < 180000)) return null;
        return h('div.offline-banner', {}, h('strong', {}, 'VCPChat 的游戏大厅没有连接'),
            h('p', {}, `${waiting.map(s => s.label).join('、')} 由 VCPChat 邀请出手。在 VCPChat 中打开游戏大厅（VGame）的 VTrade 对决，对局从当前回合继续；也可以让本回合维持原仓位。`),
            h('div', {}, button('本回合维持原仓位', () => holdLate(), { size: 'sm' }).element));
    }
    // Pause stops inviting the Agents (an answer already on its way still counts); 推进一天 lets them play one more day.
    function pauseControls() {
        const view = state.view;
        if (!agents().length || view.status !== 'active') return null;
        const act = action => async () => {
            try { const { round } = await api(action, { roundId }); accept(round); paint(); }
            catch (error) { notify(error.message, 'warning'); }
        };
        if (view.paused) {
            return h('div.pause-controls', {},
                h('p.hint', {}, '已暂停：不再邀请 Agent；已经发出的邀请，回答照常收下。'),
                h('div.row-actions', {}, button('继续', act('resume'), { variant: 'primary', size: 'sm' }).element,
                    button('推进一天', act('step'), { size: 'sm' }).element));
        }
        return h('div.pause-controls', {},
            view.pauseAt !== undefined ? h('p.hint', {}, `推进一天：第 ${view.pauseAt} 天结算后暂停。`) : null,
            h('div.row-actions', {}, button('暂停', act('pause'), { size: 'sm' }).element));
    }
    function paintWatch() {
        const waiting = agents().filter(s => !s.decided), offline = offlineBanner();
        const longest = Math.max(0, ...waiting.map(seat => invitedOf(seat)?.sinceMs ?? 0));
        const late = !offline && !state.view.paused && (longest || (state.waitingSince ? Date.now() - state.waitingSince : 0)) > HOLD_AFTER_MS;
        put(panels.watch, h('h3', {}, '观战', h('span', {}, state.view.paused ? '已暂停' : waiting.length ? '等待决定' : '结算中')),
            offline || h('p.hint', {}, 'Agent 由 VCPChat 的游戏大厅邀请，每天决定一次；关闭本页不会中断对局。'),
            pauseControls(),
            late ? h('div.row-between', {}, h('span.notice', {}, `${waiting.map(s => s.label).join('、')} 已超过 3 分钟未决定。`),
                button('维持原仓位', () => holdLate(), { size: 'sm' }).element) : null);
    }
    function paintOpponents() {
        const view = state.view;
        put(panels.opponents, me() ? offlineBanner() : null, me() ? pauseControls() : null, agents().map(seat => {
            const last = view.log.at(-1)?.entries[seat.id];
            const pill = seat.decided ? h('span.state-pill.ready', {}, '已决定') : h('span.state-pill.thinking', {}, thinking(seat));
            return h('section.panel.opponent', { dataset: { seat: seatColor(seat) } },
                h('div.opp-head', {}, avatar(seat), h('div.who', {}, h('strong', {}, seat.label), h('span', {}, `仓位 ${share(seat.position)} · ${pct(seat.returnRate)}`)), pill),
                seat.decided && me() && !me().decided ? h('p.hint', {}, '它本回合的仓位在你确定后一起揭晓。') : null,
                last ? h('div.reveal', {},
                    h('div.row-between', {}, h('span.muted', {}, `第 ${view.day} 天揭晓`), num(`${levelName(last.before)} → ${levelName(last.target)}`)),
                    last.fill ? h('span', { class: last.fill.failed ? 'notice' : 'hint' }, fillText(last.fill)) : null,
                    last.reason ? h('blockquote.quote', {}, last.reason) : null) : h('p.hint', {}, '第一回合揭晓后显示它的仓位和理由。'));
        }));
    }
    function paintHighlights() {
        const view = state.view, list = [];
        for (const row of view.log) for (const seat of view.seats) for (const item of row.entries[seat.id].highlights || []) list.push({ day: row.day, seat, item });
        const recent = list.slice(-8).reverse();
        put(panels.highlights, h('h3', {}, '本局高光', h('span', {}, '好的决定记在这里')),
            recent.length ? h('div.highlights', {}, recent.map(({ day, seat, item }, k) => h('div.highlight', { class: k === 0 && day === view.day ? 'fresh' : '', dataset: { kind: item.kind } },
                h('span.faint', {}, `第 ${day} 天`), h('span', {}, `${seat.kind === 'human' ? '' : `${seat.label} `}${item.text}`))))
                : h('p.hint', {}, '重仓吃到大涨、减仓躲过大跌、执行止损、净值创新高、领先对手时，会在这里记一笔。'));
    }
    function paintLog() {
        const view = state.view, history = view.bars.length - view.day;
        put(panels.log, h('h3', {}, '回合记录', h('span', {}, '最近的在上')),
            h('div.log', {}, view.log.slice(-12).reverse().map(row => {
                const bar = view.bars[history - 1 + row.day], before = view.bars[history - 2 + row.day], change = bar.closeCents / before.closeCents - 1;
                return h('div', {}, h('span.faint', {}, `第 ${row.day} 天`),
                    h('span', {}, view.seats.map(seat => `${seatName(seat)} ${levelName(row.entries[seat.id].target)}`).join(' · ')),
                    num(pct(change), tone(change)));
            })));
    }
    function paintBottom() {
        const solo = state.view.mode === 'solo';
        const auto = h('label.auto', {}, h('input', { type: 'checkbox', checked: state.auto, on: { change: event => setAuto(event.target.checked) } }), '自动推进',
            h('span.faint', {}, '有成交或止损时自动停'));
        put(bottom, me() ? h('div.keys', {},
            h('span', {}, h('kbd', {}, 'B'), ' 加仓'), h('span', {}, h('kbd', {}, 'S'), ' 减仓'), h('span', {}, h('kbd', {}, '0'), '–', h('kbd', {}, '4'), ' 仓位档'),
            h('span', {}, h('kbd', {}, '空格'), ' 确定'), h('span', {}, h('kbd', {}, '←'), h('kbd', {}, '→'), ' 平移图表'))
            : h('span.muted', {}, state.view.paused ? '已暂停；点“继续”恢复。' : '观战中；Agent 每天决定一次。'), solo ? auto : null, h('span.notice-line', {}, NOTICE));
    }

    async function confirm() {
        const view = state.view, seat = me();
        if (!seat || seat.decided || state.busy || view.status !== 'active') return;
        state.busy = true; paintConfirm();
        try {
            const result = await api('decide', { roundId, seatId: seat.id, day: view.day, target: state.target,
                ...(state.stopPct !== seat.stopPct ? { stopPct: state.stopPct } : {}), reason: state.reason });
            state.busy = false; state.reason = '';
            accept(result.round);
            if (result.round.status !== 'active') return;
            if (result.settled) {
                celebrate(result.round); paint();
                const entry = result.settled.entries[seat.id];
                if (state.auto && (entry.fill || entry.stopped)) {
                    setAuto(false);
                    notify(entry.stopped ? '触发止损，自动推进已停止。' : entry.fill.failed ? `${fillText(entry.fill)}，自动推进已停止。` : '有成交，自动推进已停止。');
                } else if (state.auto) setTimeout(() => { if (!state.disposed && state.auto) confirm(); }, 450);
            } else paint();
        } catch (error) {
            state.busy = false; paintConfirm();
            notify(error.message, error.code === 'STALE_DAY' ? 'warning' : 'danger');
            if (error.code === 'STALE_DAY' || error.code === 'ALREADY_DECIDED') load();
        }
    }
    function setAuto(on) { state.auto = on; paintBottom(); if (on) confirm(); }
    async function holdLate() {
        for (const seat of agents().filter(s => !s.decided)) {
            try { await api('hold', { roundId, seatId: seat.id, day: state.view.day }); } catch (error) { notify(error.message, 'warning'); }
        }
        state.waitingSince = null; load();
    }

    const keydown = event => {
        if (!state.view || !me() || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.target.closest?.('input, textarea, select, .vcp-ui-modal-overlay, .ind-editor')) return;
        const k = LEVELS.indexOf(state.target);
        if (event.key === 'b' || event.key === 'B') state.target = LEVELS[Math.min(4, k + 1)];
        else if (event.key === 's' || event.key === 'S') state.target = LEVELS[Math.max(0, k - 1)];
        else if (/^[0-4]$/.test(event.key)) state.target = LEVELS[Number(event.key)];
        else if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); confirm(); return; }
        else return;
        event.preventDefault(); if (!me().decided) paintAction();
    };
    document.addEventListener('keydown', keydown);
    load();
    return { element, dispose() { state.disposed = true; stopPolling(); document.removeEventListener('keydown', keydown); chart?.destroy(); equity.destroy(); } };
}
