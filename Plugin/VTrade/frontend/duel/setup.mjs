// New round: who plays, which problem, and the round settings. The defaults start a blind solo round at once.
import { h, put, api, marketApi, local, button, segmented, select, notify, avatar, money, challengeTrack, MODE_NAMES, KIND_NAMES } from './ui.mjs';

const RECENT_AGENTS = 'vtrade-duel-agents';
const SETTINGS = 'vtrade-duel-settings';
const CASH = [[1000000, '1 万元'], [10000000, '10 万元'], [100000000, '100 万元']];
const FILLS = [['open', '次日开盘价（默认）'], ['close', '当天收盘价']];
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

export function setupScreen(ctx, params = {}) {
    const saved = local.get(SETTINGS, {});
    const s = { mode: params.mode || 'solo', problem: params.problem || 'blind', agents: [], symbol: null, startDate: '',
        fill: saved.fill === 'close' ? 'close' : 'open', cash: CASH.some(([v]) => v === saved.cash) ? saved.cash : 10000000, strict: Boolean(saved.strict),
        classic: null, challenge: Boolean(params.challenge) };
    // Chat's Agents first (synced by VCPChat's game hall), then Agents used before and any named in the address.
    const synced = () => ctx.roster.agents.map(a => a.name);
    let offered = [...new Set([...(params.agents || []), ...synced(), ...local.get(RECENT_AGENTS, [])])].slice(0, 40);
    if (offered.length) s.agents = [offered[0]];
    ctx.loadRoster().then(() => { offered = [...new Set([...offered, ...synced()])].slice(0, 40); if (!s.agents.length && offered.length) s.agents = [offered[0]]; render(); });
    let securities = null, marketError = null, query = '', busy = false, classics = null, challenge = null;
    api('challenge').then(r => { challenge = r.challenge; render(); }).catch(() => {});
    const element = h('div.duel-setup'), main = h('div.setup-main'), side = h('aside.setup-side');
    element.append(main, side);
    const field = (label, ...content) => h('div.field', {}, h('span.label', {}, label), ...content);
    const choice = (key, value, name, text) => h('button.choice', { type: 'button', 'aria-pressed': String(s[key] === value),
        on: { click: () => { s[key] = value; if (key === 'mode' && value === 'duel') s.agents = s.agents.slice(0, 3); render(); } } },
    h('strong', {}, name), h('span', {}, text));

    const usingChallenge = () => s.mode === 'solo' && s.challenge && challenge && !challenge.activeRoundId;
    function agentPicker() {
        const max = s.mode === 'watch' ? 4 : 3, roster = ctx.roster, inChat = new Set(synced());
        const names = [...new Set([...offered, ...s.agents])];
        const input = h('input.vcp-ui-input', { type: 'text', maxLength: 40, placeholder: '名称须与 Chat 中的 Agent 一致', 'aria-label': '按名称添加 Agent' });
        const add = () => {
            const name = input.value.trim();
            if (!name) return;
            if (!/^[\p{L}\p{N}][\p{L}\p{N} _.·-]{0,39}$/u.test(name)) { notify('Agent 名称只能含文字、数字、空格、下划线、点、间隔号和连字符。', 'warning'); return; }
            s.agents = [...new Set([...s.agents, name])].slice(0, max);
            if (!offered.includes(name)) offered.unshift(name);
            render();
        };
        input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); add(); } });
        const status = roster.agents.length
            ? h('span.hint', {}, `来自 VCPChat 的 ${roster.agents.length} 位 Agent（已配置模型），同步于 ${new Date(roster.updatedAt).toLocaleString('zh-CN', { hour12: false })}。`)
            : h('span.notice', {}, '尚未从 VCPChat 同步 Agent。在 VCPChat 中打开游戏大厅（VGame）的 VTrade 对决后，这里会列出已配置模型的 Agent 及其头像。');
        const offline = roster.orchestrator && !roster.orchestrator.connected
            ? h('span.notice', {}, 'VCPChat 的游戏大厅当前没有连接：Agent 由它邀请出手，开局后请在 VCPChat 中打开游戏大厅，否则 Agent 会一直等待。') : null;
        return field(s.mode === 'watch' ? `由哪些 Agent 操作（最多 ${max} 位；两位以上即 Agent 同场对决）` : `对手（最多 ${max} 位）`,
            h('div.agents', {}, names.map((name, k) => h('button.agent', { type: 'button', 'aria-pressed': String(s.agents.includes(name)),
                dataset: { synced: String(inChat.has(name)) },
                on: { click: () => {
                    if (s.agents.includes(name)) s.agents = s.agents.filter(x => x !== name);
                    else if (s.agents.length < max) s.agents = [...s.agents, name];
                    render();
                } } }, avatar({ id: `seat-${k % 3 + 2}`, kind: 'agent', label: name }), h('span', {}, name),
            inChat.has(name) ? null : h('small', {}, '未同步')))),
            status, offline,
            h('details.manual-agent', {}, h('summary', {}, '按名称添加'),
                h('div.inline-fields', {}, h('div.vcp-ui-input-wrap', { dataset: { size: 'sm' } }, input), button('添加', add, { size: 'sm' }).element)));
    }
    function knownPicker() {
        if (marketError) return h('div.sub-panel', {}, h('strong', {}, '明牌需要本机行情'), h('span', {}, marketError));
        if (!securities) {
            marketApi({ action: 'list' }).then(r => { securities = r.securities.filter(x => x.kind === 'stock'); render(); })
                .catch(error => { marketError = error.message; render(); });
            return h('div.sub-panel', {}, h('span.hint', {}, '正在读取本机证券列表。'));
        }
        const search = h('input.vcp-ui-input', { type: 'search', value: query, placeholder: '代码、名称或拼音首字母', 'aria-label': '搜索股票',
            on: { input: event => { query = event.target.value; paintMatches(); } } });
        const matches = h('div.matches');
        const paintMatches = () => {
            const q = query.trim().toUpperCase();
            const list = q ? securities.filter(x => x.code.includes(q) || x.name.includes(query.trim()) || (x.abbr || '').startsWith(q)).slice(0, 8) : [];
            put(matches, list.map(x => h('button', { type: 'button', 'aria-pressed': String(s.symbol?.symbol === x.symbol),
                on: { click: () => { s.symbol = x; query = ''; render(); } } }, `${x.code} ${x.name}`)));
        };
        paintMatches();
        const start = h('input.vcp-ui-input', { type: 'date', value: s.startDate, max: today(), 'aria-label': '起始日',
            on: { change: event => { s.startDate = event.target.value; renderSide(); } } });
        return h('div.sub-panel', {}, h('strong', {}, s.symbol ? `${s.symbol.code} ${s.symbol.name}` : '指定股票和起始日'),
            h('div.inline-fields', {}, h('div.vcp-ui-input-wrap', { dataset: { size: 'sm' } }, search), h('div.vcp-ui-input-wrap', { dataset: { size: 'sm' } }, start)),
            matches,
            h('span.hint', {}, '起始日之前需要 120 个交易日的历史，之后需要 60 个交易日。'),
            s.mode !== 'solo' ? h('span.notice', {}, 'Agent 可能记得这段历史的后续走势。与 Agent 比较时，建议使用盲测。') : null);
    }
    function classicPicker() {
        if (!classics) {
            api('classics').then(r => { classics = r.classics; if (!s.classic) s.classic = classics[0]?.id ?? null; render(); })
                .catch(error => { classics = []; notify(error.message, 'warning'); render(); });
            return h('div.sub-panel', {}, h('span.hint', {}, '正在查找本机行情中可用的名局。'));
        }
        if (!classics.length) return h('div.sub-panel', {}, h('strong', {}, '没有可用的名局'), h('span', {}, '名局重现使用上证指数等主要指数的历史行情，需要本机通达信目录包含这些指数的日线。'));
        return h('div.sub-panel', {}, h('strong', {}, '主要指数的一段知名行情，按盲测进行'),
            h('div.classic-list', {}, classics.map(c => h('button', { type: 'button', 'aria-pressed': String(s.classic === c.id),
                on: { click: () => { s.classic = c.id; render(); } } }, c.name))),
            h('span', {}, '名称只描述开局前已能看到的形势。指数按 1 份交易，相当于跟踪指数的基金；结束后揭晓是哪一段。'),
            s.mode !== 'solo' ? h('span.notice', {}, 'Agent 可能凭点位认出知名行情；与 Agent 比较时，可在高级设置中开启严格盲测。') : null);
    }
    function challengePanel() {
        if (s.mode !== 'solo' || !challenge) return null;
        const active = challenge.activeRoundId;
        return field('资金挑战', h('div.sub-panel', {},
            h('label.challenge-toggle', {}, h('input', { type: 'checkbox', checked: s.challenge, disabled: Boolean(active),
                on: { change: event => { s.challenge = event.target.checked; render(); } } }),
            h('span', {}, h('strong', {}, '用资金挑战的资金开局'), ` 当前 ${money(challenge.cashCents)} · 第 ${challenge.run} 轮第 ${challenge.rounds + 1} 局`)),
            challengeTrack(challenge),
            active ? h('div.row-between', {}, h('span.notice', {}, '资金挑战有一局正在进行，打完后才能开下一局。'),
                button('继续这一局', () => ctx.show('game', { roundId: active }), { size: 'sm' }).element)
                : h('span', {}, '从 1 万元做到 1 亿元。每局结束时的资金带入下一局；可随时在首页重置。')));
    }
    function render() {
        const withAgents = s.mode !== 'solo';
        const problem = {
            blind: h('div.sub-panel', {}, h('strong', {}, '随机出题'),
                h('span', {}, '从本机行情中抽取一只上市满一年、非 ST、停牌较少、起始资金买得起一手的股票，再抽取一段时间。名称、代码和日期在结束后揭晓；价格和成交量照常显示。')),
            daily: h('div.sub-panel', {}, h('strong', {}, `${today()} 的挑战`),
                h('span', {}, '盲测 · 当天所有人同一道题。完成后计入每日挑战连续天数。')),
            known: knownPicker(),
            classic: classicPicker(),
        }[s.problem];
        put(main,
            h('header', {}, h('h1', {}, '开始新局'), h('p', {}, '默认设置可直接开始；其余选项在“高级设置”中。')),
            field('玩法', h('div.choice-row', {},
                choice('mode', 'solo', '单练', '仅玩家一人'), choice('mode', 'watch', '观战', '由 Agent 操作'), choice('mode', 'duel', '同场对决', '玩家与 Agent 同场'))),
            withAgents ? agentPicker() : null,
            challengePanel(),
            field('出题', segmented([{ value: 'blind', label: '盲测' }, { value: 'daily', label: '每日挑战' }, { value: 'classic', label: '名局重现' },
                { value: 'known', label: '明牌' }], s.problem, value => { s.problem = value; render(); }, { label: '出题方式' }).element, problem),
            field('局长', h('div.sub-panel.compact', {}, h('strong', {}, '60 个交易日'), h('span', {}, '开局前可见 120 个交易日的历史。'))),
            h('details.advanced', { open: Boolean(params.advanced) }, h('summary', {}, '高级设置'),
                h('div.adv-grid', {},
                    h('label.adv-item', {}, h('span', {}, '成交价'), select(FILLS, s.fill, value => { s.fill = value; renderSide(); }, { label: '成交价' }),
                        h('small', {}, '次日开盘价与实际交易一致：收盘后决定，下一交易日开盘成交。')),
                    usingChallenge() ? null : h('label.adv-item', {}, h('span', {}, '起始资金'), select(CASH, s.cash, value => { s.cash = Number(value); renderSide(); }, { label: '起始资金' }),
                        h('small', {}, '虚拟资金。')),
                    h('label.adv-item.switch', {}, h('input', { type: 'checkbox', checked: s.strict, disabled: s.problem === 'known',
                        on: { change: event => { s.strict = event.target.checked; renderSide(); } } }),
                    h('span', {}, '严格盲测', h('small', {}, '价格换算为起点 100，成交量换算为 20 日相对值，防止凭数值认出股票。默认关闭。'))))));
        renderSide();
    }
    function renderSide() {
        const withAgents = s.mode !== 'solo';
        const people = [s.mode !== 'watch' ? h('div.person', {}, avatar({ id: 'seat-1', kind: 'human' }, 'lg'), h('strong', {}, '你')) : null,
            withAgents && s.mode !== 'watch' ? h('span.vs', {}, 'VS') : null,
            ...(withAgents ? s.agents.map((name, i) => h('div.person', {}, avatar({ id: `seat-${i + 2}`, kind: 'agent', label: name }, 'lg'), h('strong', {}, name))) : []),
            !withAgents ? h('span.muted', {}, '与“买入持有”比较') : null];
        const classic = s.problem === 'classic' ? classics?.find(c => c.id === s.classic) : null;
        const kind = s.problem === 'known' ? '明牌' : classic ? `名局重现 · ${classic.name}` : s.strict ? `${KIND_NAMES[s.problem]}（严格）` : KIND_NAMES[s.problem];
        const start = button(s.mode === 'watch' ? '开始观战' : '开始', () => create(), { variant: 'primary', size: 'lg', disabled: busy });
        put(side, h('span.eyebrow', {}, '本局'), h('div.versus', {}, people),
            h('dl.summary', {},
                h('div', {}, h('dt', {}, '玩法'), h('dd', {}, MODE_NAMES[s.mode])),
                h('div', {}, h('dt', {}, '出题'), h('dd', {}, kind)),
                h('div', {}, h('dt', {}, '局长'), h('dd', {}, '60 个交易日')),
                h('div', {}, h('dt', {}, '成交'), h('dd', {}, s.fill === 'open' ? '次日开盘价' : '当天收盘价')),
                h('div', {}, h('dt', {}, '资金'), h('dd', {}, usingChallenge() ? `资金挑战 · ${money(challenge.cashCents)}` : CASH.find(([v]) => v === s.cash)[1])),
                withAgents ? h('div', {}, h('dt', {}, '模型调用'), h('dd', {}, `约 60 次 / 每位 Agent`)) : null),
            start.element,
            h('span.hint', {}, s.problem === 'classic'
                ? '规则：指数按 1 份交易，没有涨跌停；每日决定一次；费用万分之三、最低 1 元（演示费率）。'
                : '规则：100 股整手，每日决定一次（T+1 自然满足），涨停开盘买不进、跌停开盘卖不出；费用万分之三、最低 1 元（演示费率）。'));
    }
    async function create() {
        if (busy) return;
        if (s.mode !== 'solo' && !s.agents.length) { notify('请先选择或添加一位 Agent。', 'warning'); return; }
        if (s.problem === 'known' && (!s.symbol || !s.startDate)) { notify('明牌需要选择股票并填写起始日。', 'warning'); return; }
        if (s.problem === 'classic' && !s.classic) { notify('请选择一局名局重现。', 'warning'); return; }
        busy = true; renderSide();
        const seats = [...(s.mode === 'watch' ? [] : [{ kind: 'human' }]), ...(s.mode === 'solo' ? [] : s.agents.map(agent => ({ kind: 'agent', agent })))];
        const problem = s.problem === 'known' ? { kind: 'known', symbol: s.symbol.symbol, startDate: s.startDate }
            : s.problem === 'classic' ? { kind: 'classic', classic: s.classic }
                : s.problem === 'daily' ? { kind: 'daily', date: today() } : { kind: 'blind' };
        try {
            const { round } = await api('create', { requestId: crypto.randomUUID(), problem, seats,
                settings: { fill: s.fill, ...(usingChallenge() ? { challenge: true } : { initialCashCents: s.cash }), strict: s.problem !== 'known' && s.strict } });
            local.set(SETTINGS, { fill: s.fill, cash: s.cash, strict: s.strict });
            if (s.agents.length) local.set(RECENT_AGENTS, [...new Set([...s.agents, ...local.get(RECENT_AGENTS, [])])].slice(0, 8));
            ctx.show('game', { roundId: round.id });
        } catch (error) { busy = false; renderSide(); notify(error.message, 'danger'); }
    }
    render();
    return { element, dispose() {} };
}
