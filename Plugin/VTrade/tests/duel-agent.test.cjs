'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { TradeService } = require('../core/service.cjs');
const { start } = require('../preview.cjs');
const plugin = require('../VTrade.js');

// A temporary directory removed after the given close step; after-hooks run in the order they were added.
async function temporary(t, prefix, close) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    t.after(async () => {
        await close();
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        await fs.rm(directory, { recursive: true, force: true });
    });
    return directory;
}
async function setup(t) {
    let service;
    const directory = await temporary(t, 'vtrade-duel-agent-', () => service?.close());
    service = await new TradeService(directory, { prewarm: false }).initialize();
    return service;
}
const ticketIn = text => /^ticket:(\S+)$/m.exec(text)?.[1];

test('the roster keeps valid Agent names and small avatars; views say whether an orchestrator is inviting Agents', async t => {
    const service = await setup(t);
    assert.deepEqual((await service.duel({ action: 'roster' })).roster.agents, []);
    const avatar = `data:image/png;base64,${Buffer.from('png').toString('base64')}`;
    const synced = await service.duel({ action: 'syncRoster', agents: [{ name: 'Nova', avatar }, { name: '墨·Mo' }, { name: 'Nova' },
        { name: '<script>' }, { name: 'Kerr', avatar: 'javascript:alert(1)' }, { name: 'Big', avatar: `data:image/png;base64,${'A'.repeat(100 * 1024)}` }] });
    assert.equal(synced.roster.count, 4);
    const { roster } = await service.duel({ action: 'roster' });
    assert.deepEqual(roster.agents, [{ name: 'Nova', avatar }, { name: '墨·Mo' }, { name: 'Kerr' }, { name: 'Big' }]);
    assert.deepEqual(roster.orchestrator, { connected: false, quietMs: null });
    await assert.rejects(service.duel({ action: 'syncRoster', agents: 'Nova' }), { code: 'INVALID_ARGUMENT' });
    const { round } = await service.duel({ action: 'create', problem: { kind: 'blind', seed: 'roster' }, seats: [{ kind: 'agent', agent: '墨·Mo' }] });
    assert.equal(round.mode, 'watch');
    assert.equal((await service.duel({ action: 'view', roundId: round.id })).round.orchestrator.connected, false);
    await service.duel({ action: 'invites' });
    assert.equal((await service.duel({ action: 'view', roundId: round.id })).round.orchestrator.connected, true);
    const solo = (await service.duel({ action: 'create', problem: { kind: 'blind', seed: 'roster-solo' }, seats: [{ kind: 'human' }] })).round;
    assert.equal((await service.duel({ action: 'view', roundId: solo.id })).round.orchestrator, undefined);
});

test('views show when each Agent was invited; long reasons are cut at a clause and lose stray quote marks', async t => {
    const service = await setup(t);
    const { round } = await service.duel({ action: 'create', problem: { kind: 'blind', seed: 'invited' },
        seats: [{ kind: 'agent', agent: 'Nova' }, { kind: 'agent', agent: 'Kerr' }] });
    const [nova] = (await service.duel({ action: 'invites' })).invites;
    assert.deepEqual((await service.duel({ action: 'view', roundId: round.id })).round.orchestrator.invited, {});
    await service.duel({ action: 'turn', roundId: round.id, seatId: nova.seatId });
    await service.duel({ action: 'turn', roundId: round.id, seatId: nova.seatId, reminder: true });
    const invited = (await service.duel({ action: 'view', roundId: round.id })).round.orchestrator.invited;
    assert.deepEqual(Object.keys(invited), [nova.seatId]);
    assert.equal(invited[nova.seatId].count, 2);
    assert.ok(invited[nova.seatId].sinceMs >= 0 && invited[nova.seatId].sinceMs < 5000);
    // A reason of a couple of hundred characters is kept whole; only a runaway one is cut, at a clause.
    const long = `${'均线空头排列，'.repeat(90)}继续观望。`;
    await service.duelTool({ command: 'SubmitDuelDecision', ticket: nova.ticket, target: 0, reason: `「${long}」` });
    const after = (await service.duel({ action: 'view', roundId: round.id })).round;
    assert.deepEqual(after.orchestrator.invited, {});
    const kerr = (await service.duel({ action: 'invites' })).invites[0];
    const settled = await service.duel({ action: 'hold', roundId: round.id, seatId: kerr.seatId, day: 0 });
    const reason = settled.settled.entries[nova.seatId].reason;
    assert.ok(reason.length <= 600 && reason.length > 500 && reason.endsWith('，'), reason);
    assert.doesNotMatch(reason, /[「」]/);
});

test('a paused round invites no Agent, still takes an answer already on its way, and 推进一天 pauses after one day', async t => {
    const service = await setup(t);
    const { round } = await service.duel({ action: 'create', problem: { kind: 'blind', seed: 'pause' }, seats: [{ kind: 'agent', agent: 'Nova' }] });
    const [invite] = (await service.duel({ action: 'invites' })).invites;
    const paused = (await service.duel({ action: 'pause', roundId: round.id })).round;
    assert.equal(paused.paused, true);
    assert.deepEqual((await service.duel({ action: 'invites' })).invites, []);
    // The home page lists every round in play with whether it is paused and whose decision it waits for.
    const listed = (await service.duel({ action: 'list' })).rounds.find(r => r.id === round.id);
    assert.deepEqual([listed.paused, listed.awaiting], [true, ['agent']]);
    // The invitation sent before the pause still counts.
    await service.duelTool({ command: 'SubmitDuelDecision', ticket: invite.ticket, target: 50, reason: '试探' });
    let view = (await service.duel({ action: 'view', roundId: round.id })).round;
    assert.deepEqual([view.day, view.paused], [1, true]);
    assert.deepEqual((await service.duel({ action: 'invites' })).invites, []);
    view = (await service.duel({ action: 'step', roundId: round.id })).round;
    assert.deepEqual([view.paused, view.pauseAt], [false, 2]);
    const [next] = (await service.duel({ action: 'invites' })).invites;
    await service.duelTool({ command: 'SubmitDuelDecision', ticket: next.ticket, target: 50, reason: '保持' });
    view = (await service.duel({ action: 'view', roundId: round.id })).round;
    assert.deepEqual([view.day, view.paused, view.pauseAt], [2, true, undefined]);
    view = (await service.duel({ action: 'resume', roundId: round.id })).round;
    assert.equal(view.paused, false);
    assert.equal((await service.duel({ action: 'invites' })).invites.length, 1);
    // A player alone has nothing to pause.
    const solo = (await service.duel({ action: 'create', problem: { kind: 'blind', seed: 'pause-solo' }, seats: [{ kind: 'human' }] })).round;
    await assert.rejects(service.duel({ action: 'pause', roundId: solo.id }), { code: 'INVALID_ARGUMENT' });
});

test('only the invited Agent can decide for its seat, and only in that turn', async t => {
    const service = await setup(t);
    const { round } = await service.duel({ action: 'create', problem: { kind: 'blind', seed: 'tickets' },
        seats: [{ kind: 'human' }, { kind: 'agent', agent: 'Nova' }] });
    // Round views and tool turns never carry tickets; the authenticated invites list does.
    assert.doesNotMatch(JSON.stringify(round), /ticket/);
    const [invite] = (await service.duel({ action: 'invites' })).invites;
    assert.deepEqual([invite.roundId, invite.seatId, invite.agent, invite.day], [round.id, 'seat-2', 'Nova', 0]);
    const turn = (await service.duelTool({ command: 'GetDuelTurn', ticket: invite.ticket })).text;
    assert.match(turn, /你的座位 seat-2（Nova）/);
    assert.match(turn, /最近 20 个交易日/);
    assert.equal(ticketIn(turn), invite.ticket);
    assert.doesNotMatch(turn, /\d{4}-\d{2}-\d{2}/);
    assert.ok(Buffer.byteLength(turn) < 8 * 1024, `turn text is ${Buffer.byteLength(turn)} bytes`);
    const forged = invite.ticket.replace('.seat-2.', '.seat-1.');
    await assert.rejects(service.duelTool({ command: 'SubmitDuelDecision', ticket: forged, target: 100 }), { code: 'INVALID_TICKET' });
    await assert.rejects(service.duelTool({ command: 'SubmitDuelDecision', ticket: invite.ticket.replace(/.$/, c => c === '0' ? '1' : '0'), target: 100 }),
        { code: 'INVALID_TICKET' });
    await assert.rejects(service.duelTool({ command: 'SubmitDuelDecision', ticket: 'seat-2', target: 100 }), { code: 'INVALID_TICKET' });
    await assert.rejects(service.duelTool({ command: 'SubmitDuelDecision', ticket: invite.ticket, target: '30', reason: '试' }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(service.duelTool({ command: 'SubmitDuelDecision', ticket: invite.ticket, target: 50, reason: ' ' }), { code: 'INVALID_ARGUMENT', message: /reason 必填/ });
    const sealed = (await service.duelTool({ command: 'SubmitDuelDecision', ticket: invite.ticket, target: '75%', stopPct: '8', reason: '试探' })).text;
    assert.match(sealed, /^已密封/);
    assert.deepEqual((await service.duel({ action: 'invites' })).invites, []);
    await assert.rejects(service.duelTool({ command: 'SubmitDuelDecision', ticket: invite.ticket, target: 0, reason: '再交一次' }), { code: 'ALREADY_DECIDED' });
    // The page decides only for the player; it cannot decide for an Agent seat.
    await assert.rejects(service.duel({ action: 'decide', roundId: round.id, seatId: 'seat-2', target: 0 }), { code: 'INVALID_SEAT' });
    const settled = await service.duel({ action: 'decide', roundId: round.id, seatId: 'seat-1', target: 25 });
    assert.equal(settled.round.day, 1);
    assert.equal(settled.settled.entries['seat-2'].reason, '试探');
    assert.equal(settled.ticket, undefined);
    await assert.rejects(service.duelTool({ command: 'GetDuelTurn', ticket: invite.ticket }), { code: 'STALE_TICKET' });
    const next = (await service.duel({ action: 'invites' })).invites[0];
    assert.equal(next.day, 1);
    assert.notEqual(next.ticket, invite.ticket);
    // An Agent that does not answer keeps its position; the orchestrator cannot hold the player's seat.
    await assert.rejects(service.duel({ action: 'hold', roundId: round.id, seatId: 'seat-1' }), { code: 'INVALID_SEAT' });
    const held = await service.duel({ action: 'hold', roundId: round.id, seatId: 'seat-2', day: 1 });
    assert.equal(held.settled, null);
    const day2 = await service.duel({ action: 'decide', roundId: round.id, seatId: 'seat-1', target: 25 });
    assert.deepEqual([day2.settled.entries['seat-2'].target, day2.settled.entries['seat-2'].reason], [75, '超时未提交，维持原仓位']);
});

test('a watched Agent plays a whole round from the receipts alone and reads its result', async t => {
    const service = await setup(t);
    const { round } = await service.duel({ action: 'create', problem: { kind: 'blind', seed: 'watch' }, seats: [{ kind: 'agent', agent: 'Nova' }] });
    assert.equal(round.mode, 'watch');
    await assert.rejects(service.duelTool({ command: 'GetDuelResult', roundId: round.id }), { code: 'NOT_FINISHED' });
    let ticket = (await service.duel({ action: 'turn', roundId: round.id, seatId: 'seat-1' })).turn.ticket, text;
    for (let day = 0; day < 60; day++) {
        text = (await service.duelTool({ command: 'SubmitDuelDecision', ticket, target: String([0, 50, 100][day % 3]), reason: `第${day}步` })).text;
        assert.match(text, new RegExp(`^已结算第 ${day + 1} 天`));
        ticket = ticketIn(text);
        if (day < 59) assert.ok(ticket, `no next ticket after day ${day + 1}`);
    }
    assert.equal(ticket, undefined);
    assert.match(text, /结果\n题目仍未揭晓/);
    assert.match(text, /评级 [SABCD]，超过 \d+% 的随机操作者/);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/);
    const result = (await service.duelTool({ command: 'GetDuelResult', roundId: round.id })).text;
    assert.match(result, /1\. Nova：评级/);
    assert.match((await service.duelTool({ command: 'GetDuelGuide' })).text, /决策票据/);
    const profile = (await service.duel({ action: 'profile', key: 'agent:Nova' })).profile;
    assert.equal(profile.rounds, 1);
    assert.equal((await service.duel({ action: 'list' })).rounds[0].seats[0].grade, profile.history[0].grade);
});

test('the VCP entry returns duel answers as plain text and the page route is behind the preview access check', async t => {
    const directory = await temporary(t, 'vtrade-duel-plugin-', () => plugin.shutdown());
    await plugin.initialize({ VTRADE_DATA_DIR: directory });
    const guide = await plugin.processToolCall({ command: 'GetDuelGuide' });
    assert.equal(guide.status, 'success');
    assert.match(guide.result.content[0].text, /^VTrade 对决/);
    const bad = await plugin.processToolCall({ command: 'SubmitDuelDecision', ticket: 'x', target: '50' });
    assert.equal(bad.status, 'error');
    assert.equal(bad.code, 'INVALID_TICKET');

    let preview;
    const previewDirectory = await temporary(t, 'vtrade-duel-http-', () => preview?.close());
    preview = await start({ port: 0, directory: previewDirectory });
    const post = (body, token = preview.token) => fetch(`${preview.origin}/api/duel`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-VTrade-Request': '1', 'X-VTrade-Access': token }, body: JSON.stringify(body) });
    assert.equal((await post({ action: 'invites' }, '')).status, 403);
    const created = await (await post({ action: 'create', problem: { kind: 'blind', seed: 'http' }, seats: [{ kind: 'human' }] })).json();
    assert.equal(created.ok, true);
    const decided = await (await post({ action: 'decide', roundId: created.round.id, seatId: 'seat-1', target: 50 })).json();
    assert.equal(decided.round.day, 1);
    assert.equal((await (await post({ action: 'nope' })).json()).code, 'INVALID_ARGUMENT');
});
