'use strict';

// Plain-text views of a 对决 round for Agents: the turn (what one seat may see and decide), the settle receipt, the
// result and the rules. Agents read text more reliably than nested JSON, and the turn stays within a few kilobytes:
// the latest 20 days in full, older days in groups of five.
const { HISTORY, LEVELS, STOPS } = require('./duel-rules.cjs');
const { COSTS } = require('./builtins.cjs');

const RECENT = 20;
const GROUP = 5;
const pct = value => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
const share = value => `${Math.round(value * 100)}%`;
const money = cents => Math.abs(cents) >= 1000000 ? `${(cents / 1000000).toFixed(2)} 万元` : `${(cents / 100).toFixed(2)} 元`;
const lots = shares => shares.toLocaleString('en-US');
// Prices are cents; under strict blind they are an index with the start at 100.00, printed the same way.
const price = value => (value / 100).toFixed(2);
const FILL = {
    open: `次日开盘价成交，买入加万分之 ${COSTS.slippageBps} 滑点、卖出减万分之 ${COSTS.slippageBps}；涨停开盘买不进，跌停开盘卖不出`,
    close: '当天收盘价成交；收盘涨停买不进，收盘跌停卖不出',
};

function rules(view) {
    return [
        `- 每天收盘后交一次目标仓位：${LEVELS.join('、')}（百分比）。系统按${view.lot === 1 ? ' 1 份（指数按点位计价，相当于跟踪指数的基金）' : '整手（100 股）'}换算买卖；保持同一仓位不会再买卖。`,
        `- 成交：${FILL[view.settings.fill]}。没成交的单下一天按原目标重试。`,
        `- 费用：万分之 ${COSTS.feeBps}，最低 ${COSTS.minFeeCents / 100} 元（演示费率）。起始资金 ${money(view.settings.initialCashCents)}，共 ${view.lengthDays} 天。`,
        `- 可选止损：${STOPS.filter(Boolean).join('、')}（%），0 表示不设。收盘价较持仓成本跌超该比例时，下一次成交清仓。`,
        '- 同场的其他座位看不到你本回合的决定，你也看不到他们的；全部交齐后一起推进一天。',
        '- 只用这里给出的行情决定。不要调用 GetMarketSecurities、GetMarketQuotes、GetMarketBars 或其他行情工具。',
    ];
}
function barLine(view, bar, previous) {
    const change = previous ? pct(bar.closeCents / previous.closeCents - 1) : '';
    const limit = bar.limitUpCents !== undefined && bar.closeCents >= bar.limitUpCents ? ' 涨停'
        : bar.limitDownCents !== undefined && bar.closeCents <= bar.limitDownCents ? ' 跌停' : '';
    const volume = view.strict ? bar.relativeVolume.toFixed(2) : (bar.volume / 10000).toFixed(1);
    return `${bar.key} ${price(bar.openCents)} ${price(bar.highCents)} ${price(bar.lowCents)} ${price(bar.closeCents)} ${change}${limit} ${volume}`;
}
function groupLine(view, bars, previous) {
    const last = bars.at(-1);
    const high = Math.max(...bars.map(b => b.highCents)), low = Math.min(...bars.map(b => b.lowCents));
    const volume = view.strict ? (bars.reduce((s, b) => s + b.relativeVolume, 0) / bars.length).toFixed(2)
        : (bars.reduce((s, b) => s + b.volume, 0) / 10000).toFixed(1);
    const change = previous ? pct(last.closeCents / previous.closeCents - 1) : '';
    return `${bars[0].key}~${last.key} ${price(bars[0].openCents)} ${price(high)} ${price(low)} ${price(last.closeCents)} ${change} ${volume}`;
}
function averages(bars) {
    return [5, 10, 20, 60].filter(n => bars.length >= n)
        .map(n => `MA${n} ${(bars.slice(-n).reduce((s, b) => s + b.closeCents, 0) / n / 100).toFixed(2)}`).join('，');
}
function seatLine(view, seat) {
    const parts = [`仓位 ${share(seat.position)}（目标 ${seat.target}%）`];
    if (seat.shares) parts.push(`持有 ${lots(seat.shares)} 股，成本 ${(seat.costCents / seat.shares / 100).toFixed(2)}`);
    parts.push(`现金 ${money(seat.cashCents)}`, `总资产 ${money(seat.equityCents)}（${pct(seat.returnRate)}）`);
    if (seat.stopPct) parts.push(`止损 ${seat.stopPct}%`);
    return parts.join('，');
}
function fillText(fill) {
    if (!fill) return '无买卖';
    if (fill.failed) return `${fill.side === 'buy' ? '买入' : '卖出'}未成交（${fill.reason}）`;
    return `${fill.side === 'buy' ? '买入' : '卖出'} ${lots(fill.quantity)} 股 @ ${(fill.priceCents / 100).toFixed(2)}，费用 ${(fill.feeCents / 100).toFixed(2)} 元`;
}

// What one seat sees before deciding: its account, the table, the bars so far and the rules.
function turnText(view, seatId, ticket) {
    const seat = view.seats.find(s => s.id === seatId), bars = view.bars;
    const recent = bars.slice(-RECENT), older = bars.slice(0, -RECENT), lines = [];
    const problem = view.revealed ? `明牌：${view.problem.name}（${view.problem.code}），${view.problem.startDate} 起`
        : `盲测：${view.problem.label}，名称、代码和日期已隐藏${view.strict ? '；严格盲测，价格换算为起点 100、成交量为 20 日相对值' : ''}`;
    lines.push(`VTrade 对决 · ${view.id} · 你的座位 ${seat.id}（${seat.label}）`,
        view.day === 0 ? `开局：你看到了开局前 ${HISTORY} 个交易日，现在决定第 1 天的仓位。` : `第 ${view.day} 天收盘后（共 ${view.lengthDays} 天），现在决定第 ${view.day + 1} 天的仓位。`,
        `题目：${problem}。`, '', '规则：', ...rules(view), '', `你的账户：${seatLine(view, seat)}。`);
    const last = view.log.at(-1)?.entries[seat.id];
    if (last) {
        lines.push(`上一回合：目标 ${last.target}%${last.stopped ? '（触发止损）' : ''}，${fillText(last.fill)}。`);
        if (last.fill?.failed) lines.push('那笔单没成交，这回合如果目标不变会再试一次。');
        if (last.highlights?.length) lines.push(`高光：${last.highlights.map(h => h.text).join('；')}。`);
    }
    const others = view.seats.filter(s => s.id !== seat.id);
    if (others.length) lines.push(`同场：${others.map(s => `${s.label} ${pct(s.returnRate)}（${s.decided ? '已交' : '未交'}）`).join('，')}。`);
    lines.push(`买入持有：${pct(view.hold.at(-1) / view.hold[0] - 1)}。`);
    // The same market line the player sees under the chart: 沪深 300 since the start and over the last five days.
    const market = view.benchmark?.returns, now = market?.at(-1), before = market?.at(-6) ?? market?.[0];
    if (Number.isFinite(now)) lines.push(`大盘（${view.benchmark.name}）：开局以来 ${pct(now)}，近 5 日 ${pct((1 + now) / (1 + before) - 1)}。`);
    lines.push('');
    const f = view.fundamentals;
    if (f) {
        const yi = cents => `${(cents / 1e10).toFixed(cents >= 1e11 ? 0 : 1)} 亿元`;
        const parts = [f.marketCapCents ? `总市值 ${yi(f.marketCapCents)}` : null, f.floatCapCents ? `流通市值 ${yi(f.floatCapCents)}` : null,
            f.pe !== null ? `市盈率（TTM）${f.pe.toFixed(1)}` : null, f.pb !== null ? `市净率 ${f.pb.toFixed(2)}` : null,
            f.roe !== null ? `ROE ${pct(f.roe).replace('+', '')}` : null, f.profitGrowth !== null ? `净利润同比 ${pct(f.profitGrowth)}` : null].filter(Boolean);
        if (parts.length) lines.push(`基本面（最近一期已公告的报告，按当天收盘价计算）：${parts.join('，')}。`, '');
    }
    const unit = view.strict ? '价格指数，相对量' : '元，万股';
    lines.push(`最近 ${recent.length} 个交易日（开 高 低 收 涨跌 量；单位：${unit}）：`);
    recent.forEach((bar, i) => lines.push(barLine(view, bar, i ? recent[i - 1] : older.at(-1))));
    lines.push(`均线：${averages(bars)}。`, '');
    if (older.length) {
        lines.push(`更早的行情，每 ${GROUP} 个交易日一行（开 高 低 收 涨跌 量合计）：`);
        for (let start = older.length % GROUP, previous = null; start < older.length; start += GROUP) {
            const group = older.slice(start, start + GROUP);
            lines.push(groupLine(view, group, previous));
            previous = group.at(-1);
        }
        lines.push('');
    }
    if (view.status === 'finished') lines.push('本局已结束，用 GetDuelResult 看成绩。');
    else if (seat.decided) lines.push('你这一回合已经交过了，等其他座位交齐。');
    else if (ticket) lines.push(`请用 SubmitDuelDecision 交本回合的决定：必填目标仓位 target 和理由 reason（写操作结论，一两句话；分析照常写在回复里，仓位不变也要写），可选止损 stopPct；票据原样带上：`, `ticket:${ticket}`);
    lines.push('', view.notice);
    return lines.join('\n');
}
// The receipt after a decision: sealed, or the settled day for this seat.
function decisionText(view, seatId, settled) {
    if (!settled) return `已密封：第 ${view.day + 1} 天的目标仓位已记录。其他座位交齐后才会结算，届时编排器会再请你出手。`;
    const entry = settled.entries[seatId], bar = view.bars.at(-1), previous = view.bars.at(-2), seat = view.seats.find(s => s.id === seatId);
    const lines = [`已结算第 ${settled.day} 天：目标 ${entry.target}%${entry.stopped ? '（触发止损）' : ''}，${fillText(entry.fill)}。`,
        `收盘 ${(bar.closeCents / 100).toFixed(2)}（${pct(bar.closeCents / previous.closeCents - 1)}），你的${seatLine(view, seat)}。`];
    if (entry.highlights?.length) lines.push(`高光：${entry.highlights.map(h => h.text).join('；')}。`);
    return lines.join('\n');
}
function resultText(view) {
    const result = view.result, lines = [`VTrade 对决 · ${view.id} · 结果`];
    lines.push(view.revealed ? `题目：${view.problem.name}（${view.problem.code}），${view.problem.startDate} 至 ${view.problem.endDate}。`
        : '题目仍未揭晓；揭晓由玩家在页面上操作。');
    lines.push(`买入持有：${pct(result.hold.returnRate)}，最大回撤 ${share(result.hold.maxDrawdown)}。`, '');
    for (const id of result.ranking) {
        const seat = view.seats.find(s => s.id === id), s = result.seats[id];
        lines.push(`${result.ranking.indexOf(id) + 1}. ${seat.label}：评级 ${s.grade}，超过 ${share(s.percentile)} 的随机操作者；收益 ${pct(s.returnRate)}，`
            + `相对买入持有 ${pct(s.excess)}，最大回撤 ${share(s.maxDrawdown)}，成交 ${s.trades} 次${s.winRate === null ? '' : `，卖出胜率 ${share(s.winRate)}`}。`);
        const m = s.moments;
        if (m.best) lines.push(`   最好的一步：第 ${m.best.day} 天把仓位从 ${m.best.from}% 调到 ${m.best.to}%，之后到第 ${m.best.end} 天走了 ${pct(m.best.move)}。`);
        if (m.missed) lines.push(`   错过的一段：第 ${m.missed.from} 到 ${m.missed.to} 天涨了 ${pct(m.missed.rise)}，平均仓位只有 ${share(m.missed.held)}。`);
        if (m.drawdown) lines.push(`   最深的回撤：第 ${m.drawdown.from} 到 ${m.drawdown.to} 天，${share(m.drawdown.depth)}。`);
    }
    if (result.winner) lines.push('', `胜者：${view.seats.find(s => s.id === result.winner).label}。`);
    lines.push('', '评级按随机操作者的百分位给：S 前 10%，A 前 25%，B 前 50%，C 前 75%，其余为 D。', view.notice);
    return lines.join('\n');
}
// The orchestrator's invitation for one Agent seat: the turn and a filled-in tool block with this turn's ticket.
function invitationText(view, seatId, ticket, { reminder = false } = {}) {
    const seat = view.seats.find(s => s.id === seatId);
    return [`【VTrade 对决邀请】轮到 ${seat.label} 决定第 ${view.day + 1} 天的仓位。本回合局面已附在下面，不必再调用 GetDuelTurn。`,
        reminder ? '这是补邀：上一次没有收到有效的 SubmitDuelDecision，本回合仍在等你。' : null,
        '本局用 VTrade 工具交决定；同场的人能看到的话写在 reason 里。', '', turnText(view, seatId, ticket), '',
        '按下面的格式交决定（target 改成你的目标仓位，reason 改成你的理由，ticket 原样保留）：',
        ['<<<[TOOL_REQUEST]>>>', 'tool_name:「始」VTrade「末」,', 'command:「始」SubmitDuelDecision「末」,', `ticket:「始」${ticket}「末」,`,
            'target:「始」50「末」,', 'reason:「始」操作结论，一两句话「末」', '<<<[END_TOOL_REQUEST]>>>'].join('\n')].filter(line => line !== null).join('\n');
}
function guideText() {
    return ['VTrade 对决：几个人或 Agent 在同一段历史行情上一天一天地决定仓位，比谁的决定更好。', '',
        '流程：编排器请你出手时会给你局号、座位和一张决策票据。用 GetDuelTurn 读本回合（带票据），',
        '再用 SubmitDuelDecision 交目标仓位（带同一张票据）。票据只对这一局、这个座位、这一回合有效，过期或不符会被拒绝。', '',
        '规则（以下按默认设置；开局时也可能改为当天收盘价成交、其他起始资金，以 GetDuelTurn 写的为准）：',
        ...rules({ settings: { fill: 'open', initialCashCents: 10000000 }, lengthDays: 60 }), '',
        '评级：和 1000 个随机操作者比，他们改仓的频率和你一样。交易多不加分，好的决定才加分。',
        '每天交决定时在 reason 里写操作结论（一两句话），结算后同场的人能看到；分析过程照常写在回复里。'].join('\n');
}

module.exports = { turnText, decisionText, resultText, guideText, invitationText };
