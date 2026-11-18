// The player's record: level, grades, achievements with progress, opponents, every finished round and the local ranking.
import { h, put, api, button, notify, pct, share, num, tone, grade, money, challengeTrack } from './ui.mjs';
import { levelBlock, historyTitle } from './home.mjs';

const OUTCOME = { win: '胜', loss: '负', draw: '平' };
const RUN_RESULT = { cleared: '通关', bust: '资金不足', reset: '主动重置' };
const when = iso => new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });

export function careerScreen(ctx) {
    const element = h('div.duel-career');
    (async () => {
        let profile, players;
        try { [profile, players] = await Promise.all([api('profile').then(r => r.profile), api('players').then(r => r.players)]); }
        catch (error) { notify(error.message, 'danger'); return; }
        const total = Object.values(profile.grades).reduce((a, b) => a + b, 0);
        put(element,
            h('header.career-top', {}, button('返回首页', () => ctx.show('home'), { variant: 'ghost', size: 'sm' }).element, h('h1', {}, '战绩')),
            h('section.career-summary', {},
                h('div', {}, levelBlock(profile),
                    h('div.statline', {},
                        h('div.stat', {}, h('b', {}, String(profile.rounds)), h('span', {}, '已完成对局')),
                        h('div.stat', {}, h('b', {}, profile.best ? share(profile.best.percentile) : '—'), h('span', {}, '最高百分位')),
                        h('div.stat', {}, h('b', {}, profile.best ? pct(profile.best.returnRate) : '—'), h('span', {}, '最高收益')),
                        h('div.stat', {}, h('b', {}, `${profile.streak} / ${profile.bestStreak}`), h('span', {}, '当前 / 最长连胜')),
                        h('div.stat', {}, h('b', {}, `${profile.daily.streak} / ${profile.daily.best}`), h('span', {}, '每日挑战连续 / 最长')))),
                h('div.grade-bars', { 'aria-label': '评级分布' }, ['S', 'A', 'B', 'C', 'D'].map(g => h('div', {}, grade(g),
                    h('div.bar', {}, h('i', { style: `width:${total ? profile.grades[g] / total * 100 : 0}%` })), h('span.num', {}, String(profile.grades[g])))))),
            h('section', {}, h('div.section-title', {}, h('h2', {}, '成就'), h('span.hint', {}, '按客观规则判定')),
                h('div.achievements', {}, profile.achievements.map(a => h('div.ach', { class: a.got ? '' : 'locked' }, h('i', {}, a.mark),
                    h('div', {}, h('strong', {}, a.name), h('span', {}, a.text),
                        a.goal && !a.got ? h('span.progress-text', {}, `${a.progress} / ${a.goal}`) : null, a.got ? h('span.faint', {}, when(a.at)) : null))))),
            h('section', {}, h('div.section-title', {}, h('h2', {}, '资金挑战'),
                h('span.hint', {}, `第 ${profile.challenge.run} 轮进行中：${money(profile.challenge.cashCents)}，已打 ${profile.challenge.rounds} 局`)),
                challengeTrack(profile.challenge),
                profile.challenge.runs.length ? h('table.versus-table', {}, h('thead', {}, h('tr', {}, ['轮次', '结果', '局数', '结束资金', '最高资金', '结束日期'].map(t => h('th', {}, t)))),
                    h('tbody', {}, profile.challenge.runs.map(r => h('tr', {}, h('td', {}, `第 ${r.run} 轮`), h('td', {}, RUN_RESULT[r.result]),
                        h('td', {}, String(r.rounds)), h('td', {}, money(r.endCents)), h('td', {}, money(r.peakCents)), h('td', {}, when(r.endedAt))))))
                    : h('p.hint', {}, '已结束的各轮会列在这里：通关、资金不足或主动重置。')),
            Object.keys(profile.versus).length ? h('section', {}, h('div.section-title', {}, h('h2', {}, '对手')),
                h('table.versus-table', {}, h('thead', {}, h('tr', {}, ['对手', '胜', '负', '平'].map(t => h('th', {}, t)))),
                    h('tbody', {}, Object.values(profile.versus).map(v => h('tr', {}, h('td', {}, v.label), h('td', {}, String(v.wins)),
                        h('td', {}, String(v.losses)), h('td', {}, String(v.draws))))))) : null,
            h('section', {}, h('div.section-title', {}, h('h2', {}, '对局记录'), h('span.hint', {}, '最近 50 局')),
                profile.history.length ? h('div.table-wrap', {}, h('table.history-table', {},
                    h('thead', {}, h('tr', {}, ['日期', '对局', '对手', '评级', '收益', '相对买入持有', '结果', '经验'].map(t => h('th', {}, t)))),
                    h('tbody', {}, profile.history.map(entry => h('tr', { on: { click: () => ctx.show('result', { roundId: entry.roundId }) } },
                        h('td', {}, when(entry.at)), h('td', {}, historyTitle(entry)), h('td', {}, entry.opponents.join('、') || '—'),
                        h('td', {}, grade(entry.grade)), h('td', {}, num(pct(entry.returnRate), tone(entry.returnRate))),
                        h('td', {}, num(pct(entry.excess), tone(entry.excess))), h('td', {}, entry.outcome ? OUTCOME[entry.outcome] : '—'),
                        h('td', {}, `+${entry.xp}`))))))
                    : h('p.hint', {}, '尚无完成的对局。')),
            h('section', {}, h('div.section-title', {}, h('h2', {}, '本机排行'), h('span.hint', {}, '按经验排列；平均百分位反映每局相对随机操作者的水平')),
                h('table.versus-table', {}, h('thead', {}, h('tr', {}, ['', '参赛者', '等级', '对局', '平均百分位'].map(t => h('th', {}, t)))),
                    h('tbody', {}, players.map((p, k) => h('tr', { class: p.kind === 'human' ? 'me' : '' }, h('td', {}, String(k + 1)),
                        h('td', {}, p.kind === 'human' ? '你' : p.label), h('td', {}, `Lv.${p.level}`), h('td', {}, String(p.rounds)),
                        h('td', {}, p.averagePercentile === null ? '—' : share(p.averagePercentile))))))));
    })();
    return { element, dispose() {} };
}
