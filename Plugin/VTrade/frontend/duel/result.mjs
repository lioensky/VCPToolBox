// After the last day: the scorecard with the reveal and the rewards, and the replay of every decision.
import { DuelChart } from './duel-chart.mjs';
import { equityStrip } from './equity.mjs';
import { h, put, api, button, notify, pct, share, price, money, num, tone, grade, avatar, seatName, seatColor, levelName,
    roundTitle, MARK_NAMES, NOTICE } from './ui.mjs';

const ACHIEVEMENT_NAMES = { first: '初次对决', dodge: '躲过下跌', bottom: '抄在低位', ride: '吃到主升', 'grade-s': 'S 级', strict: '严格盲测',
    streak3: '三连胜', beat10: '十胜', daily7: '每日不缺', billion: '一万到一亿' };
const history = view => view.bars.length - view.day;

// Returns of the 1000 random traders as a histogram, with the participants and buy-and-hold marked on it.
function distribution(view, focus) {
    const bench = view.result.seats[focus.id].bench, { min, max, counts } = bench.histogram;
    const marks = [...view.seats.map(seat => ({ label: seatName(seat), value: view.result.seats[seat.id].returnRate, seat })),
        { label: '买入持有', value: view.result.hold.returnRate }];
    const lo = Math.min(min, ...marks.map(m => m.value)), hi = Math.max(max, ...marks.map(m => m.value)), span = hi - lo || 1;
    const W = 960, H = 200, top = 32, bottom = 22, x = v => 8 + (v - lo) / span * (W - 16), peak = Math.max(...counts);
    const width = (max - min) / counts.length;
    const svg = [`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="随机操作者收益分布">`];
    counts.forEach((count, i) => {
        const x0 = x(min + i * width), x1 = x(min + (i + 1) * width), height = count / peak * (H - top - bottom);
        svg.push(`<rect class="dist-bar" x="${x0.toFixed(1)}" y="${(H - bottom - height).toFixed(1)}" width="${Math.max(1, x1 - x0 - 1).toFixed(1)}" height="${height.toFixed(1)}"/>`);
    });
    marks.forEach((m, k) => {
        const px = x(m.value).toFixed(1), cls = m.seat ? `dist-mark seat-${seatColor(m.seat)}` : 'dist-mark bench';
        svg.push(`<line class="${cls}" x1="${px}" x2="${px}" y1="${top - 6}" y2="${H - bottom}"/>`);
        const anchor = m.value - lo < span * 0.15 ? 'start' : hi - m.value < span * 0.15 ? 'end' : 'middle';
        svg.push(`<text class="${cls}" x="${px}" y="${10 + (k % 2) * 13}" text-anchor="${anchor}">${m.label} ${pct(m.value)}</text>`);
    });
    svg.push(`<text class="dist-axis" x="8" y="${H - 6}">${pct(lo)}</text><text class="dist-axis" x="${W - 8}" y="${H - 6}" text-anchor="end">${pct(hi)}</text></svg>`);
    const wrap = h('div.dist');
    wrap.innerHTML = svg.join('');
    return wrap;
}

// 资金挑战: the balance carried into the next round, milestones crossed, and the end of a run.
function challengeBlock(ctx, reward) {
    const c = reward?.challenge;
    if (!c) return null;
    const change = c.afterCents / c.beforeCents - 1;
    const headline = c.result === 'cleared' ? `通关：第 ${c.run} 轮用 ${c.round} 局做到 ${money(c.afterCents)}`
        : c.result === 'bust' ? `本轮结束：资金降到 ${money(c.afterCents)}，不足 500 元` : `资金带入第 ${c.round + 1} 局`;
    return h('section.challenge-card', { class: c.result === 'cleared' ? 'cleared' : '' },
        h('div.row-between', {}, h('h2', {}, `资金挑战 · 第 ${c.round} 局`), num(pct(change), tone(change))),
        h('p.challenge-move', {}, money(c.beforeCents), h('span.faint', {}, ' → '), h('b', {}, money(c.afterCents))),
        h('div.badges', {}, c.crossed.map(mark => h('span.tag.gold', {}, `跨过 ${MARK_NAMES[mark]} 元`)),
            c.result === 'cleared' ? h('span.tag.gold', {}, '一万到一亿') : null),
        h('div.row-between', {}, h('strong', { class: c.result === 'cleared' ? 'gold-text' : '' }, headline),
            button(c.result ? '开始新一轮' : '继续挑战', () => ctx.show('setup', { mode: 'solo', challenge: true }), { variant: 'primary', size: 'sm' }).element));
}
function rewardsBlock(reward) {
    if (!reward) return null;
    const after = reward.after, before = reward.before, width = after.into / after.need;
    const near = reward.near ? `再超过 ${Math.max(1, Math.ceil(reward.near.gap * 100))}% 的随机操作者即可达到 ${reward.near.grade} 级` : null;
    return h('section.rewards', { class: reward.levelUp ? 'levelup' : '' },
        h('div.row-between', {}, h('h2', {}, '本局收获'), h('span.xp-gain', {}, `经验 +${reward.xp}`)),
        h('div.xpbar.big', {}, h('i', { style: `width:${(width * 100).toFixed(1)}%` })),
        h('div.row-between', {}, reward.levelUp ? h('strong.gold-text', {}, `升级到 Lv.${after.level}`) : h('span', {}, `Lv.${after.level}`),
            h('span.hint', {}, `经验 ${after.into} / ${after.need}${reward.levelUp ? `（原 Lv.${before.level}）` : ''}`)),
        h('ul.breakdown', {}, reward.breakdown.map(item => h('li', {}, h('span', {}, item.label), h('span.num', {}, `+${item.xp}`)))),
        h('div.badges', {},
            reward.achievements.map(id => h('span.tag.gold', {}, `新成就 · ${ACHIEVEMENT_NAMES[id] || id}`)),
            reward.personalBest.percentile ? h('span.tag.gold', {}, '个人最佳 · 百分位') : null,
            reward.personalBest.returnRate ? h('span.tag.gold', {}, '个人最佳 · 收益') : null,
            reward.streak >= 2 ? h('span.tag.gold', {}, `同场对决 ${reward.streak} 连胜`) : null,
            reward.dailyStreak >= 2 ? h('span.tag', {}, `每日挑战连续 ${reward.dailyStreak} 天`) : null,
            near ? h('span.tag.accent', {}, near) : null));
}

export function resultScreen(ctx, { roundId }) {
    const element = h('div.duel-result');
    async function load() {
        let view;
        try { view = (await api('view', { roundId })).round; } catch (error) { notify(error.message, 'danger'); ctx.show('home'); return; }
        if (view.status !== 'finished') { ctx.show('game', { roundId }); return; }
        render(view);
    }
    async function reveal() {
        try { render((await api('reveal', { roundId })).round); } catch (error) { notify(error.message, 'danger'); }
    }
    function render(view) {
        const result = view.result, focus = view.seats.find(s => s.kind === 'human') || view.seats[0], stats = result.seats[focus.id];
        const winner = result.winner ? view.seats.find(s => s.id === result.winner) : null;
        const headline = view.seats.length > 1 ? (winner ? (winner.kind === 'human' ? '你赢了本局' : `${winner.label} 赢了本局`) : '本局打平')
            : `本局评级 ${stats.grade}`;
        const m = stats.moments, jump = day => ctx.show('replay', { roundId, day });
        const moment = (title, text, day) => h('div.moment', {}, h('strong', {}, title), h('span', {}, text),
            button('在复盘中查看', () => jump(day), { variant: 'ghost', size: 'sm' }).element);
        put(element,
            h('section.result-hero', {},
                h('div.result-grade', {}, grade(stats.grade, 'xl'), h('div', {},
                    h('span.eyebrow', {}, roundTitle(view)), h('h1', {}, headline),
                    h('p.beat', {}, '超过了 ', h('b', {}, share(stats.percentile)), ' 的随机操作者（他们改仓的频率与', seatName(focus), '相同）'))),
                h('dl.result-stats', {},
                    h('div', {}, h('dt', {}, '收益'), h('dd', {}, num(pct(stats.returnRate), tone(stats.returnRate)))),
                    h('div', {}, h('dt', {}, '相对买入持有'), h('dd', {}, num(pct(stats.excess), tone(stats.excess)))),
                    h('div', {}, h('dt', {}, '最大回撤'), h('dd', {}, num(share(stats.maxDrawdown)))),
                    h('div', {}, h('dt', {}, '成交次数'), h('dd', {}, num(String(stats.trades)))),
                    h('div', {}, h('dt', {}, '卖出胜率'), h('dd', {}, num(stats.winRate === null ? '—' : share(stats.winRate)))),
                    h('div', {}, h('dt', {}, '本局高光'), h('dd', {}, num(String(stats.highlights)))))),
            view.seats.length > 1 ? h('section.panel', {}, h('h3', {}, '排名'), h('table.ranking-table', {},
                h('thead', {}, h('tr', {}, ['名次', '参赛者', '评级', '收益', '相对买入持有', '最大回撤', '成交'].map(t => h('th', {}, t)))),
                h('tbody', {}, result.ranking.map((id, k) => {
                    const seat = view.seats.find(s => s.id === id), s = result.seats[id];
                    return h('tr', {}, h('td', {}, String(k + 1)), h('td', {}, avatar(seat, 'sm'), ' ', seatName(seat)), h('td', {}, grade(s.grade)),
                        h('td', {}, num(pct(s.returnRate), tone(s.returnRate))), h('td', {}, num(pct(s.excess), tone(s.excess))),
                        h('td', {}, share(s.maxDrawdown)), h('td', {}, String(s.trades)));
                })))) : null,
            h('section.panel', {}, h('h3', {}, '随机操作者分布', h('span', {}, `${stats.bench.size} 人，中位数 ${pct(stats.bench.quantiles.p50)}`)), distribution(view, focus)),
            challengeBlock(ctx, result.rewards?.[focus.id]),
            rewardsBlock(result.rewards?.[focus.id]),
            h('section.panel.reveal-panel', {}, view.revealed
                ? [h('h3', {}, '题目', h('span', {}, view.problem.kind === 'known' ? '明牌' : '已揭晓')),
                    h('p.reveal-name', {}, `${view.problem.name}（${view.problem.code}）`),
                    h('p.hint', {}, `${view.problem.startDate} 至 ${view.problem.endDate}，共 ${view.lengthDays} 个交易日；开局前 ${history(view)} 个交易日的历史。`)]
                : [h('h3', {}, '题目', h('span', {}, '尚未揭晓')), h('p', {}, '揭晓后显示证券名称、代码和真实日期；复盘和成绩不受影响。'),
                    button('揭晓题目', () => reveal(), { variant: 'primary' }).element]),
            h('section.panel', {}, h('h3', {}, '关键时刻', h('span', {}, seatName(focus))),
                m.best ? moment('最好的一步', `第 ${m.best.day} 天由${levelName(m.best.from)}调到${levelName(m.best.to)}，此后到第 ${m.best.end} 天走了 ${pct(m.best.move)}。`, m.best.day) : null,
                m.missed ? moment('错过的一段', `第 ${m.missed.from} 至 ${m.missed.to} 天上涨 ${pct(m.missed.rise)}，平均仓位 ${share(m.missed.held)}。`, m.missed.from) : null,
                m.drawdown ? moment('最深的回撤', `第 ${m.drawdown.from} 至 ${m.drawdown.to} 天回撤 ${share(m.drawdown.depth)}。`, m.drawdown.to) : null,
                !m.best && !m.missed && !m.drawdown ? h('p.hint', {}, '本局没有明显的关键时刻。') : null),
            h('div.result-actions', {},
                button('复盘', () => ctx.show('replay', { roundId }), { variant: 'primary' }).element,
                button('再来一局', () => ctx.show('setup', { mode: view.mode }), {}).element,
                button('返回首页', () => ctx.show('home'), { variant: 'ghost' }).element),
            h('p.notice-line', {}, NOTICE));
    }
    load();
    return { element, dispose() {} };
}

export function replayScreen(ctx, { roundId, day }) {
    const element = h('div.duel-replay');
    let chart = null, equity = null, view = null;
    const shown = new Set();
    async function load() {
        try { view = (await api('view', { roundId })).round; } catch (error) { notify(error.message, 'danger'); ctx.show('home'); return; }
        if (view.status !== 'finished') { ctx.show('game', { roundId }); return; }
        view.seats.forEach(seat => shown.add(seat.id));
        render();
        if (day !== undefined) chart.focus(history(view) - 1 + day);
    }
    function render() {
        chart?.destroy(); equity?.destroy();
        const legend = h('div.chart-legend'), host = h('div.chart-host');
        const chartBox = h('section.game-chart', {}, legend, host);
        const toggles = h('div.toggles', {}, view.seats.map(seat => h('button.seat-toggle', { type: 'button', dataset: { seat: seatColor(seat) },
            'aria-pressed': String(shown.has(seat.id)), on: { click: event => {
                if (shown.has(seat.id)) shown.delete(seat.id); else shown.add(seat.id);
                event.currentTarget.setAttribute('aria-pressed', String(shown.has(seat.id)));
                chart.update(view, { marks: [...shown], future: false });
            } } }, avatar(seat, 'sm'), seatName(seat))));
        const rows = view.log.map(row => {
            const bar = view.bars[history(view) - 1 + row.day], before = view.bars[history(view) - 2 + row.day], change = bar.closeCents / before.closeCents - 1;
            return h('tr', { on: { click: () => chart.focus(history(view) - 1 + row.day) } },
                h('td', {}, `第 ${row.day} 天`), h('td', {}, num(pct(change), tone(change))),
                view.seats.map(seat => {
                    const e = row.entries[seat.id];
                    return h('td', {}, h('span', {}, levelName(e.target)), e.fill ? h('small', { class: e.fill.failed ? 'notice' : 'faint' },
                        e.fill.failed ? ' 未成交' : ` ${e.fill.side === 'buy' ? '买' : '卖'} ${price(e.fill.priceCents)}`) : null,
                    e.reason ? h('div.reason', {}, e.reason) : null);
                }));
        });
        put(element,
            h('header.replay-top', {}, button('返回成绩', () => ctx.show('result', { roundId }), { variant: 'ghost', size: 'sm' }).element,
                h('div.game-title', {}, h('strong', {}, `复盘 · ${roundTitle(view)}`), h('span', {}, view.revealed ? `${view.problem.startDate} 至 ${view.problem.endDate}` : '题目尚未揭晓')),
                toggles),
            chartBox,
            (equity = equityStrip()).element,
            h('section.panel.replay-log', {}, h('h3', {}, '每日决定', h('span', {}, '点击一行定位到图表')),
                h('div.table-wrap', {}, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '回合'), h('th', {}, '涨跌'), view.seats.map(seat => h('th', {}, seatName(seat))))),
                    h('tbody', {}, rows)))));
        chart = new DuelChart(host, { onCrosshair: index => describe(legend, index), panelRoot: chartBox });
        chartBox.prepend(chart.indicators.toolbar());
        chart.update(view, { marks: [...shown], future: false });
        describe(legend, null);
        equity.update(view);
    }
    function describe(legend, index) {
        const i = index === null || index === undefined ? view.bars.length - 1 : index, bar = view.bars[i], previous = view.bars[i - 1];
        const change = previous ? bar.closeCents / previous.closeCents - 1 : null;
        put(legend, h('span.ohlc-pair.date', {}, bar.key), ['开', '高', '低', '收'].map((label, k) => h('span.ohlc-pair', { dataset: { tone: change === null ? 'flat' : tone(change) } },
            h('i', {}, label), price([bar.openCents, bar.highCents, bar.lowCents, bar.closeCents][k]))),
        change === null ? null : h('span.ohlc-pair', { dataset: { tone: tone(change) } }, h('i', {}, '幅'), pct(change, 2)));
    }
    load();
    return { element, dispose() { chart?.destroy(); equity?.destroy(); } };
}
