'use strict';

const { check, integer, text, hash, completedDate } = require('./data.cjs');
const { reserveCents: defaultReserve } = require('./builtins.cjs');
const { invokeSync } = require('./slots.cjs');
const ENGINE_VERSION = 'daily-reference-v1';
// Market rules the ledger owns. Prices, fees and fill-or-reject come from the execution slot.
const RULES = Object.freeze({ lotSize: 100, sellDelay: 1 });
const SLOT_ID = /^[a-z][a-z0-9-]{1,49}$/;
const rules = model => ({ lotSize: RULES.lotSize, ...(model?.costs || {}), sellDelay: RULES.sellDelay });

function validateState(s) {
    const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const valid = condition => check(condition, 'CORRUPT_SAVE', '模拟存档结构或账本不一致，已保留原文件。');
    valid(record(s) && s.schemaVersion === 1 && /^run-[a-f0-9]{32}$/.test(s.id)
        && integer(s.revision) && integer(s.cursor) && typeof s.paused === 'boolean'
        && typeof s.name === 'string' && typeof s.agentName === 'string'
        && typeof s.datasetId === 'string' && /^[a-f0-9]{64}$/.test(s.fingerprint)
        && /^[a-f0-9]{64}$/.test(s.creationFingerprint)
        && typeof s.rulesProfile === 'string' && SLOT_ID.test(s.rulesProfile));
    valid(s.universe === undefined || record(s.universe) && SLOT_ID.test(s.universe.id)
        && typeof s.universe.group === 'string' && typeof s.universe.asOf === 'string');
    valid(s.dataMode === undefined || ['snapshot', 'continuous'].includes(s.dataMode));
    valid(s.marketDirectory === undefined || s.marketDirectory === true && s.datasetId === 'market-directory'
        && s.dataMode === 'continuous');
    valid(!s.marketDirectory || record(s.marketHistory) && Array.isArray(s.symbols)
        && Object.keys(s.marketHistory).every(symbol =>
        s.symbols.includes(symbol) && typeof s.marketHistory[symbol]?.asOf === 'string'
            && /^[a-f0-9]{64}$/.test(s.marketHistory[symbol]?.fingerprint)));
    valid(s.dataSourceId === undefined || s.dataSourceId === null || /^feed-[A-Za-z0-9_-]{1,60}$/.test(s.dataSourceId));
    valid(s.engineVersion === undefined || s.engineVersion === ENGINE_VERSION);
    valid(s.dataHistory === undefined || Array.isArray(s.dataHistory) && s.dataHistory.length > 0
        && s.dataHistory.every(h => record(h) && typeof h.datasetId === 'string' && /^[a-f0-9]{64}$/.test(h.fingerprint)
            && typeof h.date === 'string') && s.dataHistory.at(-1).datasetId === s.datasetId
        && s.dataHistory.at(-1).fingerprint === s.fingerprint);
    valid(s.training === undefined || record(s.training) && typeof s.training.pairId === 'string'
        && ['human', 'agent'].includes(s.training.role) && typeof s.training.seed === 'string'
        && typeof s.training.blind === 'boolean' && typeof s.training.revealed === 'boolean'
        && typeof s.training.originalSymbol === 'string' && typeof s.training.originalStartDate === 'string');
    valid(Array.isArray(s.symbols) && (s.marketDirectory || s.symbols.length > 0) && s.symbols.length <= (s.marketDirectory ? 20000 : 100)
        && new Set(s.symbols).size === s.symbols.length
        && s.symbols.every(v => typeof v === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(v)
            && !['__proto__', 'constructor', 'prototype'].includes(v)));
    valid(integer(s.cashCents) && integer(s.initialCashCents, 10000, 10000000000)
        && Number.isSafeInteger(s.realizedCents) && record(s.holdings)
        && Array.isArray(s.plans) && Array.isArray(s.orders) && Array.isArray(s.events)
        && Array.isArray(s.reviews) && Array.isArray(s.equity) && record(s.receipts));
    let cost = 0n;
    for (const [symbol, p] of Object.entries(s.holdings)) {
        valid(s.symbols.includes(symbol) && record(p) && integer(p.quantity)
            && integer(p.costCents) && Array.isArray(p.lots));
        valid(p.lots.every(l => record(l) && integer(l.quantity, 1) && integer(l.sellableFrom)));
        valid(p.lots.reduce((sum, l) => sum + l.quantity, 0) === p.quantity
            && (p.quantity > 0 ? p.costCents > 0 : p.costCents === 0));
        cost += BigInt(p.costCents);
    }
    valid(BigInt(s.cashCents) + cost === BigInt(s.initialCashCents) + BigInt(s.realizedCents));
    valid(s.plans.every((p, i) => record(p) && p.id === `plan-${i + 1}`
        && s.symbols.includes(p.symbol) && ['buy', 'sell'].includes(p.side)
        && integer(p.quantity, RULES.lotSize, 100000) && p.quantity % RULES.lotSize === 0
        && typeof p.date === 'string' && typeof p.note === 'string'));
    valid(s.orders.every((o, i) => record(o) && o.id === `order-${i + 1}`
        && s.symbols.includes(o.symbol) && ['buy', 'sell'].includes(o.side)
        && ['pending', 'filled', 'cancelled', 'unfilled'].includes(o.status)
        && integer(o.quantity, RULES.lotSize, 100000) && o.quantity % RULES.lotSize === 0
        && integer(o.reservedCents) && typeof o.plannedDate === 'string'
        && (o.limitPriceCents === undefined || integer(o.limitPriceCents, 1, 100000000))
        && (o.status !== 'filled' || (typeof o.date === 'string'
            && integer(o.priceCents, 1) && integer(o.feeCents)))));
    valid(s.conditionals === undefined || Array.isArray(s.conditionals) && s.conditionals.every((c, i) =>
        record(c) && c.id === `conditional-${i + 1}` && s.symbols.includes(c.symbol)
        && ['stop-loss', 'take-profit', 'trailing-stop', 'buy-stop', 'buy-limit'].includes(c.type)
        && ['active', 'triggered', 'cancelled'].includes(c.status)
        && integer(c.quantity, RULES.lotSize, 100000) && c.quantity % RULES.lotSize === 0
        && integer(c.activeFromCursor) && integer(c.reservedCents)
        && (c.triggerPriceCents === null || integer(c.triggerPriceCents, 1, 100000000))
        && (c.groupId === null || typeof c.groupId === 'string')));
    const pending = s.orders.filter(o => o.status === 'pending');
    const conditionalCash = (s.conditionals || []).filter(c => c.status === 'active')
        .reduce((sum, c) => sum + c.reservedCents, 0);
    valid(pending.reduce((sum, o) => sum + o.reservedCents, conditionalCash) <= s.cashCents);
    for (const symbol of s.symbols) {
        const p = Object.hasOwn(s.holdings, symbol) ? s.holdings[symbol] : null;
        valid(pending.filter(o => o.side === 'sell' && o.symbol === symbol)
            .reduce((sum, o) => sum + o.quantity, conditionalSellReserved(s, symbol)) <= (p?.quantity || 0));
    }
    valid(s.events.every((e, i) => record(e) && e.id === `event-${i + 1}`
        && typeof e.kind === 'string' && typeof e.date === 'string'));
    valid(s.reviews.every(r => record(r) && typeof r.date === 'string' && typeof r.note === 'string'));
    valid(s.equity.length > 0 && s.equity.every(e => record(e) && typeof e.date === 'string'
        && integer(e.equityCents) && integer(e.cashCents) && typeof e.stale === 'boolean'));
    valid(Object.entries(s.receipts).every(([key, r]) => /^[A-Za-z0-9_-]{1,100}$/.test(key)
        && record(r) && /^[a-f0-9]{64}$/.test(r.fingerprint) && record(r.receipt)
        && r.receipt.requestId === key && integer(r.receipt.revision, 1, s.revision)));
}

function currentBar(m, symbol, day) {
    return m.bySymbol.get(symbol)?.bars.find(b => b.date === day);
}
function mark(m, symbol, day) {
    return m.bySymbol.get(symbol)?.bars.filter(b => b.date <= day).at(-1);
}
function conditionalSellReserved(state, symbol) {
    const groups = new Map();
    for (const c of state.conditionals || []) {
        if (c.status !== 'active' || c.symbol !== symbol || c.type.startsWith('buy-')) continue;
        const key = c.groupId || c.id;
        groups.set(key, Math.max(groups.get(key) || 0, c.quantity));
    }
    return [...groups.values()].reduce((sum, quantity) => sum + quantity, 0);
}
function quote(state, m, symbol) {
    const item = m.bySymbol.get(symbol);
    check(item, 'UNKNOWN_SYMBOL', '证券不属于本次运行的数据源。');
    const bars = item.bars.filter(b => b.date <= m.days[state.cursor]);
    const last = bars.at(-1);
    return { symbol, name: item.name, bars: bars.slice(-30).map(b => ({ ...b })),
        closeCents: last?.closeCents ?? null, stale: last?.date !== m.days[state.cursor],
        ma5Cents: bars.length >= 5 ? Math.round(bars.slice(-5).reduce((a, b) => a + b.closeCents, 0) / 5) : null };
}
function account(state, m) {
    const day = m.days[state.cursor];
    const positions = Object.entries(state.holdings).filter(([, p]) => p.quantity > 0).map(([symbol, p]) => {
        const price = mark(m, symbol, day);
        const held = state.orders.filter(o => o.status === 'pending' && o.side === 'sell' && o.symbol === symbol)
            .reduce((a, o) => a + o.quantity, conditionalSellReserved(state, symbol));
        return { symbol, ...p, reservedQuantity: held,
            sellableQuantity: p.lots.filter(l => l.sellableFrom <= state.cursor).reduce((a, l) => a + l.quantity, 0),
            marketValueCents: (price?.closeCents || 0) * p.quantity, stale: price?.date !== day };
    });
    const reservedCents = state.orders.filter(o => o.status === 'pending').reduce((a, o) => a + o.reservedCents, 0)
        + (state.conditionals || []).filter(c => c.status === 'active').reduce((a, c) => a + c.reservedCents, 0);
    const equityCents = state.cashCents + positions.reduce((a, p) => a + p.marketValueCents, 0);
    check(integer(state.cashCents) && integer(reservedCents, 0, state.cashCents) && integer(equityCents)
        && Number.isSafeInteger(state.realizedCents)
        && positions.every(p => integer(p.quantity) && integer(p.costCents) && integer(p.marketValueCents)),
    'AMOUNT_RANGE', '金额或数量超过本原型的精确整数范围。');
    return { cashCents: state.cashCents, availableCents: state.cashCents - reservedCents, reservedCents,
        realizedCents: state.realizedCents, positions,
        equityCents };
}
// model is the session's execution implementation, or null when it is no longer registered (read-only use).
function observe(state, m, model) {
    const atEnd = state.cursor === m.days.length - 1, continuous = state.dataMode === 'continuous';
    const ready = nextDataReady(state, m);
    return { sessionId: state.id, name: state.name, agentName: state.agentName, mode: 'simulation',
        revision: state.revision, observationId: `${state.id}:${state.cursor}:${state.revision}`,
        date: m.days[state.cursor], paused: state.paused, finished: atEnd && !continuous,
        dataMode: state.dataMode || 'snapshot', dataSourceId: state.dataSourceId || null,
        waitingForData: continuous && !ready, canAdvance: ready && !state.paused,
        runState: state.paused ? 'paused' : continuous && !ready ? 'waiting_for_data' : atEnd ? 'completed' : 'active',
        datasetId: state.datasetId, marketDirectory: state.marketDirectory === true,
        source: { ...m.dataset.source }, rulesProfile: state.rulesProfile, rules: rules(model),
        ...(model ? {} : { executionUnavailable: true }), ...(state.universe ? { universe: { ...state.universe } } : {}),
        account: account(state, m), quotes: state.symbols.map(s => quote(state, m, s)),
        plans: state.plans, orders: state.orders, conditionals: state.conditionals || [], journal: state.events.slice(-100),
        reviews: state.reviews, equity: state.equity,
        ...(state.training ? { training: { pairId: state.training.pairId, role: state.training.role,
            blind: state.training.blind, revealed: state.training.revealed, seed: state.training.seed,
            dayNumber: state.cursor - state.training.startCursor + 1,
            ...(state.training.revealed ? { original: { symbol: state.training.originalSymbol,
                startDate: state.training.originalStartDate } } : {}) } } : {}),
        notice: '虚拟资金与参考价格记账，不连接券商。MA5 仅为公开指标示例，不是选股建议。' };
}
const defaultProfile = (args, m) => args.rulesProfile || (m.dataset.source.kind === 'demo' ? 'a-share-demo' : 'reference');
function startIndex(args, m) {
    const dataMode = args.dataMode || (args.sourceId ? 'continuous' : 'snapshot');
    check(['snapshot', 'continuous'].includes(dataMode), 'INVALID_ARGUMENT', '数据模式须为 snapshot 或 continuous。');
    check(dataMode !== 'continuous' || m.days.at(-1) <= completedDate(), 'INCOMPLETE_BAR', '连续模拟不能使用尚未完成的日线。');
    const start = args.startDate ? m.days.indexOf(args.startDate) : dataMode === 'continuous' ? m.days.length - 1 : Math.min(4, m.days.length - 2);
    check(start >= 0 && start < m.days.length - (dataMode === 'continuous' ? 0 : 1), 'INVALID_ARGUMENT', '起始日不在数据中或固定回放没有下一数据日。');
    return { dataMode, start };
}
// universe, when given, is the resolved universe slot choice: { id, group, asOf, symbols }.
function create(id, args, m, datasetId, universe) {
    const profile = defaultProfile(args, m);
    check(typeof profile === 'string' && SLOT_ID.test(profile), 'INVALID_ARGUMENT', '未知撮合规则（rulesProfile）。');
    const { dataMode, start } = startIndex(args, m);
    const directory = args.marketMode === 'directory';
    const symbols = directory ? [] : universe?.symbols ?? args.symbols ?? [...m.bySymbol.keys()];
    check(Array.isArray(symbols) && (directory || symbols.length > 0) && symbols.length <= 100
        && new Set(symbols).size === symbols.length && symbols.every(s => m.bySymbol.has(s)),
    'INVALID_ARGUMENT', '股票池必须来自所选数据源。');
    const cash = args.initialCashCents ?? 10000000;
    check(integer(cash, 10000, 10000000000), 'INVALID_ARGUMENT', '初始虚拟资金超出范围。');
    const state = { schemaVersion: 1, id, revision: 0, name: text(args.name, 'VTrade 模拟实验'),
        agentName: text(args.agentName, '演示代理'), datasetId, fingerprint: m.fingerprint,
        rulesProfile: profile, symbols, cursor: start, paused: false, cashCents: cash,
        engineVersion: ENGINE_VERSION, dataMode, dataSourceId: args.sourceId || null,
        ...(directory ? { marketDirectory: true, marketHistory: {} } : {}),
        dataHistory: [{ datasetId, fingerprint: m.fingerprint, date: m.days[start] }],
        initialCashCents: cash, realizedCents: 0, holdings: {}, plans: [], orders: [], conditionals: [], events: [],
        reviews: [], receipts: {}, equity: [] };
    if (args.trainingMeta) state.training = { ...args.trainingMeta, startCursor: start };
    if (universe) state.universe = { id: universe.id, group: universe.group, asOf: universe.asOf };
    state.equity.push({ date: m.days[start], equityCents: cash, cashCents: cash, stale: false });
    return state;
}
function binding(state, args) {
    check(args.expectedRevision === state.revision && args.observationId === `${state.id}:${state.cursor}:${state.revision}`,
        'STALE_OBSERVATION', '观察或账户版本已过期，请重新读取再决定。');
}
function planFields(state, args) {
    check(['buy', 'sell'].includes(args.side) && state.symbols.includes(args.symbol),
        'INVALID_ORDER', '请选择池内证券及 buy/sell。');
    check(integer(args.quantity, RULES.lotSize, 100000) && args.quantity % RULES.lotSize === 0,
        'INVALID_ORDER', '此原型的数量须为 100 的整数倍，且不超过十万。');
    if (args.limitPriceCents !== undefined) {
        check(integer(args.limitPriceCents, 1, 100000000), 'INVALID_ORDER', '限价须为正整数分。');
    }
}
function intent(state, m, args, model) {
    check(!state.paused, 'PAUSED', '运行已暂停。');
    check(state.dataMode === 'continuous' || state.cursor < m.days.length - 1, 'FINISHED', '固定回放已结束，不能提交新的模拟操作。');
    planFields(state, args);
    const price = currentBar(m, args.symbol, m.days[state.cursor]);
    check(price && !price.suspended && price.volume > 0, 'DATA_UNAVAILABLE', '当前证券没有可用的当日日线。');
    const a = account(state, m);
    let reservedCents = 0;
    if (args.side === 'buy') {
        // A budget cap from the execution slot (or the public default), not a prediction of tomorrow's price.
        const reserve = model.reserveCents ? model.reserveCents.bind(model) : defaultReserve;
        reservedCents = invokeSync('execution', state.rulesProfile, () => reserve({ quantity: args.quantity,
            limitPriceCents: args.limitPriceCents, closeCents: price.closeCents }));
        check(integer(reservedCents, 1, 1000000000000), 'PROVIDER_FAILED', '撮合规则返回的预留金额无效。');
        check(reservedCents <= a.availableCents, 'INSUFFICIENT_CASH', '可用虚拟资金不足。');
    } else {
        const p = Object.hasOwn(state.holdings, args.symbol) ? state.holdings[args.symbol] : null;
        const reserved = a.positions.find(p => p.symbol === args.symbol)?.reservedQuantity || 0;
        const sellableNext = p?.lots.filter(l => l.sellableFrom <= state.cursor + 1)
            .reduce((sum, l) => sum + l.quantity, 0) || 0;
        check(args.quantity <= sellableNext - reserved, 'INSUFFICIENT_POSITION', '下一交易日可用持有数量不足。');
    }
    return { side: args.side, symbol: args.symbol, quantity: args.quantity,
        ...(args.limitPriceCents === undefined ? {} : { limitPriceCents: args.limitPriceCents }),
        reservedCents, settlement: '下一数据交易日按所选撮合规则记账；可能拒绝，不保证成交。' };
}
function event(state, kind, detail = {}) {
    const e = { id: `event-${state.events.length + 1}`, kind, ...detail };
    state.events.push(e);
    return e;
}
function nextDataReady(state, m) {
    const next = m.days[state.cursor + 1];
    if (!next) return false;
    return state.dataMode !== 'continuous' || [...state.orders.filter(o => o.status === 'pending'),
        ...(state.conditionals || []).filter(c => c.status === 'active' && c.activeFromCursor <= state.cursor + 1)]
        .every(o => currentBar(m, o.symbol, next));
}
function settle(state, m, order, model, forcedPriceCents = null) {
    const day = m.days[state.cursor];
    const bar = currentBar(m, order.symbol, day);
    const reject = reason => {
        order.status = 'unfilled'; order.reason = reason;
        event(state, 'unfilled', { date: day, orderId: order.id, symbol: order.symbol, reason });
    };
    if (!bar || bar.suspended || bar.volume === 0) return reject('缺少日线、停牌或无成交量。');
    const method = forcedPriceCents === null ? model.settle : model.settleConditional;
    check(typeof method === 'function', 'PROVIDER_UNAVAILABLE', '所选撮合规则不支持条件单。');
    const decision = invokeSync('execution', state.rulesProfile, () => method.call(model, { date: day, side: order.side,
        symbol: order.symbol, quantity: order.quantity, limitPriceCents: order.limitPriceCents,
        reservedCents: order.reservedCents, triggerPriceCents: forcedPriceCents, bar: { ...bar } }));
    check(decision !== null && typeof decision === 'object', 'PROVIDER_FAILED', '撮合规则须返回成交价格或拒绝原因。');
    if (decision.rejected !== undefined) {
        check(typeof decision.rejected === 'string' && decision.rejected.trim(), 'PROVIDER_FAILED', '撮合规则的拒绝原因须为文本。');
        return reject(decision.rejected.trim().slice(0, 200));
    }
    const { priceCents: price, feeCents: commission } = decision;
    check(integer(commission, 0, 1000000000000), 'PROVIDER_FAILED', '撮合规则返回的费用须为非负整数分。');
    if (!integer(price, 1, 100000000)) return reject('参考价格超出整数分范围。');
    // These guards hold for every execution implementation: no fill better than the day's range or the limit.
    if (order.side === 'buy' ? price < bar.lowCents : price > bar.highCents) return reject('参考价优于当日最低或最高价，不记成交。');
    if (order.limitPriceCents !== undefined && (order.side === 'buy'
        ? price > order.limitPriceCents : price < order.limitPriceCents)) return reject('参考价不满足限价。');
    const notional = price * order.quantity;
    if (order.side === 'sell' && commission > notional) return reject('费用超过卖出金额。');
    if (order.side === 'buy') {
        if (notional + commission > order.reservedCents) return reject('参考价格超过预留预算。');
        const p = Object.hasOwn(state.holdings, order.symbol) ? state.holdings[order.symbol]
            : (state.holdings[order.symbol] = { quantity: 0, costCents: 0, lots: [] });
        p.quantity += order.quantity;
        p.costCents += notional + commission;
        p.lots.push({ quantity: order.quantity, sellableFrom: state.cursor + RULES.sellDelay });
        state.cashCents -= notional + commission;
    } else {
        const p = state.holdings[order.symbol];
        const available = p.lots.filter(l => l.sellableFrom <= state.cursor).reduce((a, l) => a + l.quantity, 0);
        if (available < order.quantity) return reject('尚未到可卖交易日。');
        const cost = Number(BigInt(p.costCents) * BigInt(order.quantity) / BigInt(p.quantity));
        p.costCents -= cost; p.quantity -= order.quantity;
        order.realizedProfitCents = notional - commission - cost;
        let remaining = order.quantity;
        let holdingDays = 0;
        for (const lot of p.lots) {
            if (lot.sellableFrom > state.cursor) continue;
            const taken = Math.min(remaining, lot.quantity);
            holdingDays += taken * (state.cursor - lot.sellableFrom + RULES.sellDelay);
            lot.quantity -= taken; remaining -= taken;
        }
        order.heldDays = Math.round(holdingDays / order.quantity);
        p.lots = p.lots.filter(l => l.quantity > 0);
        state.cashCents += notional - commission;
        state.realizedCents += notional - commission - cost;
    }
    Object.assign(order, { status: 'filled', date: day, priceCents: price, feeCents: commission });
    event(state, 'virtual-fill', { date: day, orderId: order.id, symbol: order.symbol,
        side: order.side, quantity: order.quantity, priceCents: price, feeCents: commission });
}
const conditionSide = type => type.startsWith('buy-') ? 'buy' : 'sell';
function conditionInput(state, m, args, model, groupId = null, activeFromCursor = state.cursor + 1) {
    const type = args.type;
    check(['stop-loss', 'take-profit', 'trailing-stop', 'buy-stop', 'buy-limit'].includes(type),
        'INVALID_CONDITIONAL', '条件单类型无效。');
    const side = conditionSide(type);
    planFields(state, { symbol: args.symbol, side, quantity: args.quantity });
    const triggerPriceCents = type === 'trailing-stop' ? null : args.triggerPriceCents;
    check(triggerPriceCents === null || integer(triggerPriceCents, 1, 100000000),
        'INVALID_CONDITIONAL', '触发价须为正整数分。');
    const trailPercentBps = type === 'trailing-stop' ? args.trailPercentBps ?? null : null;
    const trailAmountCents = type === 'trailing-stop' ? args.trailAmountCents ?? null : null;
    if (type === 'trailing-stop') check((integer(trailPercentBps, 1, 5000) && trailAmountCents === null)
        || (integer(trailAmountCents, 1, 10000000) && trailPercentBps === null),
    'INVALID_CONDITIONAL', '移动止损须设置回落基点或回落整数分，且只能选一项。');
    const current = currentBar(m, args.symbol, m.days[state.cursor]);
    check(current, 'DATA_UNAVAILABLE', '当前证券没有日线。');
    let reservedCents = 0;
    if (side === 'buy') {
        const reserve = model.reserveCents ? model.reserveCents.bind(model) : defaultReserve;
        reservedCents = invokeSync('execution', state.rulesProfile, () => reserve({ quantity: args.quantity,
            limitPriceCents: triggerPriceCents, closeCents: current.closeCents }));
        check(integer(reservedCents, 1, 1000000000000) && reservedCents <= account(state, m).availableCents,
            'INSUFFICIENT_CASH', '条件单所需虚拟资金不足。');
    } else {
        const p = state.holdings[args.symbol];
        const sellableNext = p?.lots.filter(l => l.sellableFrom <= activeFromCursor)
            .reduce((sum, l) => sum + l.quantity, 0) || 0;
        const existing = conditionalSellReserved(state, args.symbol)
            + state.orders.filter(o => o.status === 'pending' && o.side === 'sell' && o.symbol === args.symbol)
                .reduce((sum, order) => sum + order.quantity, 0);
        const sameGroup = groupId && (state.conditionals || []).some(c => c.status === 'active' && c.groupId === groupId);
        check(args.quantity + existing - (sameGroup ? args.quantity : 0) <= sellableNext,
            'INSUFFICIENT_POSITION', '条件单数量超过下一交易日可卖持仓。');
    }
    return { id: `conditional-${state.conditionals.length + 1}`, type, symbol: args.symbol,
        quantity: args.quantity, triggerPriceCents, trailPercentBps, trailAmountCents,
        peakCloseCents: type === 'trailing-stop' ? current.closeCents : null,
        groupId, activeFromCursor, reservedCents, status: 'active', placedDate: m.days[state.cursor] };
}
function processConditionals(state, m, model) {
    const day = m.days[state.cursor];
    const priority = { 'stop-loss': 0, 'trailing-stop': 1, 'take-profit': 2, 'buy-stop': 3, 'buy-limit': 4 };
    const active = (state.conditionals || []).filter(c => c.status === 'active' && c.activeFromCursor <= state.cursor)
        .sort((a, b) => priority[a.type] - priority[b.type] || a.id.localeCompare(b.id));
    for (const c of active) {
        if (c.status !== 'active') continue;
        const bar = currentBar(m, c.symbol, day);
        if (!bar || bar.suspended || bar.volume === 0) continue;
        const threshold = c.type === 'trailing-stop'
            ? c.trailPercentBps !== null ? Math.floor(c.peakCloseCents * (10000 - c.trailPercentBps) / 10000)
                : c.peakCloseCents - c.trailAmountCents : c.triggerPriceCents;
        const highTrigger = c.type === 'take-profit' || c.type === 'buy-stop';
        if (!(highTrigger ? bar.highCents >= threshold : bar.lowCents <= threshold)) {
            if (c.type === 'trailing-stop') c.peakCloseCents = Math.max(c.peakCloseCents, bar.closeCents);
            continue;
        }
        const side = conditionSide(c.type);
        if (side === 'sell') {
            const position = state.holdings[c.symbol];
            const sellable = position?.lots.filter(l => l.sellableFrom <= state.cursor)
                .reduce((sum, lot) => sum + lot.quantity, 0) || 0;
            if (sellable < c.quantity) continue;
        }
        const price = highTrigger ? Math.max(bar.openCents, threshold) : Math.min(bar.openCents, threshold);
        const order = { id: `order-${state.orders.length + 1}`, symbol: c.symbol, side, quantity: c.quantity,
            reservedCents: c.reservedCents, plannedDate: c.placedDate, conditionalId: c.id, status: 'pending' };
        c.status = 'triggered'; c.triggeredDate = day; c.orderId = order.id;
        state.orders.push(order);
        event(state, 'conditional-triggered', { date: day, conditionalId: c.id, orderId: order.id });
        settle(state, m, order, model, price);
        if (c.groupId) for (const sibling of state.conditionals) {
            if (sibling.id !== c.id && sibling.groupId === c.groupId && sibling.status === 'active') {
                sibling.status = 'cancelled';
                event(state, 'conditional-cancelled', { date: day, conditionalId: sibling.id, reason: 'OCO' });
            }
        }
    }
}
function apply(state, m, args, model) {
    check(state.events.length < 5000, 'SESSION_LIMIT', '本次运行记录已达上限，请新建运行。');
    const day = m.days[state.cursor];
    switch (args.command) {
    case 'PlaceConditional': {
        check(!state.paused, 'PAUSED', '运行已暂停。');
        check(typeof model?.settleConditional === 'function', 'PROVIDER_UNAVAILABLE', '所选撮合规则不支持条件单。');
        state.conditionals ||= [];
        check(state.conditionals.length < 500, 'SESSION_LIMIT', '条件单数量已达上限。');
        const groupId = args.groupId ?? null;
        check(groupId === null || typeof groupId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(groupId),
            'INVALID_CONDITIONAL', 'OCO 组标识无效。');
        if (groupId) check(state.conditionals.filter(c => c.groupId === groupId && c.status === 'active')
            .every(c => c.symbol === args.symbol && c.quantity === args.quantity && conditionSide(c.type) === conditionSide(args.type)),
        'INVALID_CONDITIONAL', '同一 OCO 组的证券、方向与数量须一致。');
        const c = conditionInput(state, m, args, model, groupId);
        state.conditionals.push(c);
        event(state, 'conditional-placed', { date: day, conditionalId: c.id });
        return { conditionalId: c.id, status: c.status };
    }
    case 'UpdateConditional': {
        const c = (state.conditionals || []).find(item => item.id === args.conditionalId);
        check(c?.status === 'active', 'INVALID_CONDITIONAL', '只能修改生效中的条件单。');
        if (c.type === 'trailing-stop') {
            const pct = args.trailPercentBps ?? null, amount = args.trailAmountCents ?? null;
            check((integer(pct, 1, 5000) && amount === null) || (integer(amount, 1, 10000000) && pct === null),
                'INVALID_CONDITIONAL', '移动止损须设置一种回落幅度。');
            c.trailPercentBps = pct; c.trailAmountCents = amount;
        } else {
            check(integer(args.triggerPriceCents, 1, 100000000), 'INVALID_CONDITIONAL', '触发价无效。');
            if (conditionSide(c.type) === 'buy') {
                const reserve = model.reserveCents ? model.reserveCents.bind(model) : defaultReserve;
                const current = currentBar(m, c.symbol, day);
                const replacement = invokeSync('execution', state.rulesProfile, () => reserve({ quantity: c.quantity,
                    limitPriceCents: args.triggerPriceCents, closeCents: current.closeCents }));
                check(integer(replacement, 1, 1000000000000)
                    && replacement <= account(state, m).availableCents + c.reservedCents,
                'INSUFFICIENT_CASH', '修改后的条件单所需虚拟资金不足。');
                c.reservedCents = replacement;
            }
            c.triggerPriceCents = args.triggerPriceCents;
        }
        event(state, 'conditional-updated', { date: day, conditionalId: c.id });
        return { conditionalId: c.id, status: c.status };
    }
    case 'CancelConditional': {
        const c = (state.conditionals || []).find(item => item.id === args.conditionalId);
        check(c?.status === 'active', 'INVALID_CONDITIONAL', '只能撤销生效中的条件单。');
        c.status = 'cancelled';
        event(state, 'conditional-cancelled', { date: day, conditionalId: c.id });
        return { conditionalId: c.id, status: c.status };
    }
    case 'RevealTraining': {
        check(state.training && !state.training.revealed, 'INVALID_SESSION', '本次训练无须揭晓。');
        state.training.revealed = true;
        event(state, 'training-revealed', { date: day });
        return { revealed: true };
    }
    case 'SavePlan': {
        check(!state.paused, 'PAUSED', '运行已暂停。');
        planFields(state, args);
        const plan = { id: `plan-${state.plans.length + 1}`, date: day, symbol: args.symbol,
            side: args.side, quantity: args.quantity, note: text(args.note, '', 500) };
        check(state.plans.length < 500, 'SESSION_LIMIT', '计划数量已达上限。');
        state.plans.push(plan); event(state, 'plan', { date: day, planId: plan.id });
        // VCP drops parameters written without 「始」「末」; say so instead of silently storing an empty reason.
        return { planId: plan.id, ...(plan.note ? {} : { hint: '未收到 note，计划理由为空；VCP 参数格式为 note:「始」理由「末」。' }) };
    }
    case 'SubmitOrder': {
        const prepared = intent(state, m, args, model);
        if (args.stopLossCents !== undefined || args.takeProfitCents !== undefined) {
            check(args.side === 'buy' && typeof model?.settleConditional === 'function',
                'INVALID_CONDITIONAL', '附带止损止盈只支持可处理条件单的买入规则。');
            for (const value of [args.stopLossCents, args.takeProfitCents]) if (value !== undefined) {
                check(integer(value, 1, 100000000), 'INVALID_CONDITIONAL', '止损止盈价须为正整数分。');
            }
            check(args.stopLossCents === undefined || args.takeProfitCents === undefined
                || args.stopLossCents < args.takeProfitCents,
            'INVALID_CONDITIONAL', '止损价须低于止盈价。');
        }
        if (args.planId) {
            const p = state.plans.find(p => p.id === args.planId);
            check(p && p.symbol === args.symbol && p.side === args.side && p.quantity === args.quantity,
                'INVALID_PLAN', '计划与本次操作不一致。');
        }
        const order = { ...prepared, id: `order-${state.orders.length + 1}`, plannedDate: day,
            planId: args.planId || null, status: 'pending',
            ...(args.stopLossCents === undefined ? {} : { stopLossCents: args.stopLossCents }),
            ...(args.takeProfitCents === undefined ? {} : { takeProfitCents: args.takeProfitCents }) };
        state.orders.push(order); event(state, 'intent', { date: day, orderId: order.id });
        return { orderId: order.id, status: 'pending' };
    }
    case 'CancelOrder': {
        const order = state.orders.find(o => o.id === args.orderId);
        check(order?.status === 'pending', 'INVALID_ORDER', '只能撤销待结算的虚拟操作。');
        order.status = 'cancelled'; event(state, 'cancelled', { date: day, orderId: order.id });
        return { orderId: order.id, status: order.status };
    }
    case 'AdvanceDay': {
        check(!state.paused, 'PAUSED', '运行已暂停。');
        check(state.cursor < m.days.length - 1, state.dataMode === 'continuous' ? 'WAITING_DATA' : 'FINISHED',
            state.dataMode === 'continuous' ? '等待已完成的新日线；行情同步和日期推进分别操作。' : '已到固定回放末尾。');
        check(nextDataReady(state, m), 'WAITING_DATA', '下一数据日仍缺少待结算证券的日线，意图保留 pending；可补齐数据或撤销。');
        state.cursor++;
        for (const order of state.orders.filter(o => o.status === 'pending')) settle(state, m, order, model);
        for (const order of state.orders.filter(o => o.status === 'filled' && o.date === m.days[state.cursor]
            && o.side === 'buy' && (o.stopLossCents !== undefined || o.takeProfitCents !== undefined))) {
            const groupId = `oco-${order.id}`;
            for (const [type, triggerPriceCents] of [['stop-loss', order.stopLossCents], ['take-profit', order.takeProfitCents]]) {
                if (triggerPriceCents === undefined) continue;
                const c = conditionInput(state, m, { type, symbol: order.symbol, quantity: order.quantity,
                    triggerPriceCents }, model, groupId, state.cursor + 1);
                state.conditionals.push(c);
                event(state, 'conditional-placed', { date: m.days[state.cursor], conditionalId: c.id, orderId: order.id });
            }
        }
        processConditionals(state, m, model);
        const a = account(state, m);
        state.equity.push({ date: m.days[state.cursor], equityCents: a.equityCents,
            cashCents: a.cashCents, stale: a.positions.some(p => p.stale) });
        event(state, 'day', { date: m.days[state.cursor] });
        return { date: m.days[state.cursor] };
    }
    case 'PauseSession': case 'ResumeSession':
        state.paused = args.command === 'PauseSession';
        event(state, state.paused ? 'paused' : 'resumed', { date: day });
        return { paused: state.paused };
    case 'SaveReview': {
        check(typeof args.note === 'string' && args.note.trim(), 'INVALID_ARGUMENT',
            '缺少复盘正文 note。VCP 参数格式为 note:「始」正文「末」，缺少「始」「末」时该参数不会送达。');
        check(args.note.length <= 2000, 'INVALID_ARGUMENT', `复盘正文 ${args.note.length} 字，超过 2000 字上限。`);
        state.reviews.push({ date: day, note: args.note.trim() });
        event(state, 'review', { date: day });
        return { saved: true };
    }
    default: check(false, 'UNKNOWN_COMMAND', '未知 VTrade 命令。');
    }
}
function attachData(state, before, after, datasetId, sourceId) {
    check(state.events.length < 5000, 'SESSION_LIMIT', '本次运行记录已达上限。');
    const previousDatasetId = state.datasetId;
    if (previousDatasetId === datasetId) return { changed: false, datasetId };
    state.dataHistory ||= [{ datasetId: previousDatasetId, fingerprint: state.fingerprint, date: before.days[state.cursor] }];
    state.datasetId = datasetId; state.fingerprint = after.fingerprint; state.dataSourceId = sourceId;
    state.dataHistory.push({ datasetId, fingerprint: after.fingerprint, date: before.days[state.cursor] });
    event(state, 'data-attached', { date: before.days[state.cursor], previousDatasetId, datasetId, sourceId });
    return { changed: true, previousDatasetId, datasetId, date: before.days[state.cursor] };
}
function manifest(state, m, model) {
    const config = { engineVersion: state.engineVersion || ENGINE_VERSION, rules: rules(model), rulesProfile: state.rulesProfile,
        datasetId: state.datasetId, dataFingerprint: m.fingerprint,
        ...(state.marketDirectory ? {} : { symbols: [...state.symbols] }),
        ...(state.marketDirectory ? { universePolicy: 'on-demand-directory', marketDirectory: true } : {}),
        startDate: state.equity[0].date, initialCashCents: state.initialCashCents,
        priceBasis: 'unadjusted-cents', volumeUnit: 'shares', timezone: 'Asia/Shanghai',
        clock: 'completed-daily-bar; decisions-before-next-data-day-open',
        calendar: state.marketDirectory ? 'local-index-daily-v1' : 'dataset-date-union-v1',
        corporateActions: 'not-modeled', originalPublicationTime: 'unknown', execution: `execution-slot:${state.rulesProfile}`,
        ...(state.universe ? { universe: { ...state.universe } } : {}) };
    return { ...config, ...(state.marketDirectory ? { symbols: [...state.symbols] } : {}),
        configHash: hash(config), sessionId: state.id, dataMode: state.dataMode || 'snapshot',
        revision: state.revision, asOf: m.days[state.cursor], dataHistory: structuredClone(state.dataHistory || []),
        strategyExecution: 'external-agent; decisions-recorded-in-journal',
        limitations: ['No authoritative exchange calendar', 'No historical universe membership',
            'No corporate action accounting', 'No claim of point-in-time source archives or real execution'] };
}
module.exports = { RULES, ENGINE_VERSION, defaultProfile, startIndex, create, observe, binding, intent, apply, account,
    validateState, attachData, manifest };
