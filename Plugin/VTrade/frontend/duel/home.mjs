// The 对决 home: continue a round, start one, today's goals, level and recent results.
import { h, put, api, marketApi, button, notify, modal, pct, share, num, tone, grade, avatar, seatName, money, challengeTrack,
    MODE_NAMES, KIND_NAMES, NOTICE } from './ui.mjs';

// 资金挑战: the balance on its way from 1 万 to 1 亿, continue or start over.
function challengeCard(ctx, challenge, refresh) {
    const reset = () => {
        const confirm = button('重置', async () => {
            try { await api('challengeReset'); dialog.close(true); refresh(); } catch (error) { notify(error.message, 'danger'); }
        }, { variant: 'danger', size: 'sm' });
        const cancel = button('取消', () => dialog.close(false), { variant: 'ghost', size: 'sm' });
        const dialog = modal({ title: '重置资金挑战', size: 'sm', actions: [cancel, confirm],
            content: h('p', {}, `本轮第 ${challenge.rounds} 局、${money(challenge.cashCents)} 将记为主动结束，然后从 1 万元重新开始。记录会保留。`) });
    };
    const active = challenge.activeRoundId;
    return h('section.challenge-card', {},
        h('div.row-between', {}, h('div', {}, h('h2', {}, '资金挑战'), h('p.hint', {}, '从 1 万元做到 1 亿元，每局结束时的资金带入下一局。')),
            h('div.challenge-balance', {}, h('b', {}, money(challenge.cashCents)), h('span.hint', {}, `第 ${challenge.run} 轮 · 已打 ${challenge.rounds} 局`))),
        challengeTrack(challenge),
        h('div.row-between', {},
            h('span.hint', {}, challenge.best ? `最快通关：${challenge.best} 局` : challenge.runs.length ? `已结束 ${challenge.runs.length} 轮` : '尚未通关'),
            h('div.hero-actions', {},
                active ? button('继续这一局', () => ctx.show('game', { roundId: active }), { variant: 'primary', size: 'sm' }).element
                    : button(challenge.rounds ? '继续挑战' : '开始挑战', () => ctx.show('setup', { mode: 'solo', challenge: true }), { variant: 'primary', size: 'sm' }).element,
                challenge.rounds || active ? button('重置', reset, { variant: 'ghost', size: 'sm' }).element : null)));
}

const OUTCOME = { win: '胜', loss: '负', draw: '平' };
const when = iso => new Date(iso).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
export const historyTitle = entry => `${MODE_NAMES[entry.mode]} · ${entry.kind === 'blind' && entry.strict ? '严格盲测' : KIND_NAMES[entry.kind]} · ${entry.lengthDays} 天`;

export function levelBlock(profile) {
    const { level, into, need } = profile.level;
    return h('div.level', {},
        h('div.row-between', {}, h('strong', {}, `Lv.${level}`), h('span.hint', {}, `经验 ${into} / ${need} · 再 ${need - into} 升级`)),
        h('div.xpbar', {}, h('i', { style: `width:${into / need * 100}%` })));
}

export function homeScreen(ctx) {
    const element = h('div.duel-home');
    const modeCard = (mode, name, tag, text) => h('button.mode', { type: 'button', on: { click: () => ctx.show('setup', { mode }) } },
        h('div.mode-name', {}, h('strong', {}, name), h('span.tag', {}, tag)), h('p', {}, text), h('span.go', {}, '选择此玩法'));
    const load = async () => {
        let profile, rounds, players, source;
        try {
            [profile, rounds, players] = await Promise.all([api('profile').then(r => r.profile), api('list').then(r => r.rounds), api('players').then(r => r.players)]);
        } catch (error) { notify(error.message, 'danger'); return; }
        try { const status = (await marketApi({ action: 'status' })).status; source = `本机通达信日线，截至 ${status.lastDate || '—'}`; }
        catch { source = '未设置通达信目录，题目使用合成演示行情'; }
        // Every round still in play, so rounds left running in the background (and the Agents they keep inviting) show here.
        const active = rounds.filter(r => r.status === 'active');
        const stateOf = round => (round.paused ? ['paused', '已暂停'] : round.awaiting.includes('human') ? ['you', '等你决定']
            : round.awaiting.includes('agent') ? ['agent', 'Agent 在走'] : ['agent', '结算中']);
        const playing = active.filter(r => !r.paused && r.awaiting.includes('agent')).length;
        const continueRow = round => {
            const [state, text] = stateOf(round), withAgents = round.seats.some(s => s.kind === 'agent');
            const flip = async () => {
                try { await api(round.paused ? 'resume' : 'pause', { roundId: round.id }); load(); } catch (error) { notify(error.message, 'warning'); }
            };
            return h('article.continue-row', {},
                h('div.continue-main', {}, h('strong', {}, `${MODE_NAMES[round.mode]} · ${KIND_NAMES[round.kind]}`),
                    h('span.hint', {}, `第 ${round.day} / ${round.lengthDays} 天 · 开局于 ${when(round.createdAt)}`)),
                h('div.mini-score', {}, round.seats.map(seat => h('span', {}, avatar(seat, 'sm'), seatName(seat)))),
                h('span.state-pill', { dataset: { state } }, text),
                h('div.row-actions', {}, withAgents ? button(round.paused ? '继续' : '暂停', flip, { variant: 'ghost', size: 'sm' }).element : null,
                    button('打开', () => ctx.show('game', { roundId: round.id }), { variant: 'primary', size: 'sm' }).element));
        };
        const done = profile.history;
        const average = done.length ? done.reduce((s, e) => s + e.percentile, 0) / done.length : null;
        const best = ['S', 'A', 'B', 'C', 'D'].find(g => profile.grades[g]);
        put(element,
            h('section.home-hero', {},
                h('div.hero-copy', {},
                    h('span.eyebrow', {}, 'VTrade · 历史行情对局'),
                    h('h1', {}, '对决'),
                    h('p', {}, '每局取一段真实历史行情。参赛者只能看到当天及以前的 K 线，每个交易日收盘后决定仓位。可以单练，可以观看 Agent 操作，也可以与 Agent 同场比较。'),
                    h('div.hero-actions', {},
                        button('开始新局', () => ctx.show('setup'), { variant: 'primary', size: 'lg' }).element,
                        button('今日挑战', () => ctx.show('setup', { problem: 'daily' }), { size: 'lg' }).element)),
                active.length ? h('article.continue', {},
                    h('header', {}, h('h2', {}, '进行中'), h('span.hint', {}, `${active.length} 局${playing ? ` · ${playing} 局有 Agent 在走` : ''}`)),
                    h('div.continue-rows', {}, active.map(continueRow)))
                    : h('article.continue.empty', {}, h('h2', {}, '尚无进行中的对局'), h('p.hint', {}, '选择下方玩法开始第一局；默认设置可直接开始。'))),
            h('section', {},
                h('div.section-title', {}, h('h2', {}, '玩法'), h('span.hint', {}, '一局一道题，每局 60 个交易日')),
                h('div.modes', {},
                    modeCard('solo', '单练', '仅玩家', '盲测或明牌，按自己的节奏逐日决定，用键盘几分钟即可完成一局。'),
                    modeCard('watch', '观战', 'Agent 操作', '选择一位 Agent 和一道题，由它逐日决定，页面显示每一步及其理由。'),
                    modeCard('duel', '同场对决', '玩家与 Agent', '同一道题，各方每日密封决定，结算后一并揭晓。最多四位参赛者。'))),
            challengeCard(ctx, profile.challenge, load),
            h('section.home-lower', {},
                h('div', {},
                    h('div.section-title', {}, h('h2', {}, '我的战绩'), button('全部战绩', () => ctx.show('career'), { variant: 'ghost', size: 'sm' }).element),
                    h('div.statline', {},
                        h('div.stat', {}, h('b', {}, String(profile.rounds)), h('span', {}, '已完成对局')),
                        h('div.stat', {}, h('b', {}, average === null ? '—' : share(average)), h('span', {}, '平均超过随机操作者')),
                        h('div.stat', {}, best ? grade(best, 'md') : h('b', {}, '—'), h('span', {}, '最佳评级')),
                        h('div.stat', {}, h('b', {}, String(profile.daily.streak)), h('span', {}, '每日挑战连续天数'))),
                    levelBlock(profile),
                    h('div.goals', {},
                        h('div.section-title', {}, h('h2', {}, '今日目标'), profile.daily.today ? h('span.tag.gold', {}, '今日挑战已完成') : null),
                        profile.goals.map(goal => h('div.goal', { class: goal.done ? 'done' : '' },
                            h('i', { 'aria-hidden': 'true' }, goal.done ? '✓' : ''), h('span', {}, goal.text), h('span.faint', {}, goal.done ? '已完成' : `+${goal.xp} 经验`))))),
                h('div', {},
                    h('div.section-title', {}, h('h2', {}, '最近对局')),
                    done.length ? h('div.recent', {}, done.slice(0, 6).map(entry => h('button.recent-row', { type: 'button',
                        on: { click: () => ctx.show('result', { roundId: entry.roundId }) } },
                    grade(entry.grade), h('span', {}, historyTitle(entry), entry.opponents.length ? h('span.faint', {}, ` · ${entry.opponents.join('、')}`) : null),
                    num(pct(entry.returnRate), tone(entry.returnRate)),
                    h('span.faint', {}, entry.outcome ? `${OUTCOME[entry.outcome]} · ${when(entry.at)}` : when(entry.at)))))
                        : h('p.hint', {}, '完成的对局会列在这里，可随时打开复盘。'),
                    players.length > 1 ? [h('div.section-title', {}, h('h2', {}, '本机排行')),
                        h('ol.ranking', {}, players.slice(0, 5).map(p => h('li', {}, h('span', {}, p.kind === 'human' ? '你' : p.label),
                            h('span.faint', {}, `Lv.${p.level} · ${p.rounds} 局`), num(p.averagePercentile === null ? '—' : share(p.averagePercentile)))))] : null)),
            h('footer.home-foot', {}, h('span.source', {}, source),
                h('span.links', {}, h('button', { type: 'button', on: { click: () => ctx.onboarding() } }, '玩法说明'),
                    h('button', { type: 'button', on: { click: () => ctx.notice() } }, '免责声明')),
                h('span', {}, NOTICE)));
    };
    load();
    return { element, dispose() {} };
}
