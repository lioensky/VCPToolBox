'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { EventEmitter } = require('node:events');
const ChatCompletionHandler = require('../modules/chatCompletionHandler.js');
const contextBudget = require('../modules/contextBudget.js');
const NonStreamHandler = require('../modules/handlers/nonStreamHandler.js');
const { delegationHeaders, isAgentDelegation, delegationLimit, fitDelegationWindow, delegationBudgetReport } = require('../modules/agentDelegationBudget.js');

const msg = (role, content) => ({ role, content });

test('delegation keeps the task with its attachment and drops complete old heartbeat pairs in place', () => {
    const system = msg('system', 'rules');
    const task = msg('user', [{ type: 'text', text: 'task' }, { type: 'image_url', image_url: { url: 'https://example.invalid/image' } }]);
    const messages = [system, task];
    for (let i = 0; i < 20; i++) {
        const pair = [msg('assistant', `${i}:` + 'x'.repeat(1200)), msg('user', `heartbeat ${i}`)];
        messages.push(...pair);
        const budget = fitDelegationWindow(messages, 1700);
        assert.equal(budget.over, false);
        assert.equal(budget.estimated, contextBudget.estimateMessagesTokens(messages));
        assert.equal(messages[0], system);
        assert.equal(messages[1], task);
        assert.deepEqual(messages.slice(-2), pair);
        assert.ok(messages.length <= 6);
        if (i >= 1) assert.equal(messages[2].content.startsWith(`${i - 1}:`), true);
    }
});

test('protected content cannot be silently truncated even on the first request', () => {
    const first = [msg('system', 'rules'), msg('user', 'x'.repeat(600))];
    const lastPair = [msg('assistant', 'last'), msg('user', 'heartbeat')];
    assert.equal(fitDelegationWindow(first.slice(), 100).over, true);
    const messages = [...first, msg('assistant', 'old'), msg('user', 'old heartbeat'), ...lastPair];
    const result = fitDelegationWindow(messages, 100);
    assert.equal(result.over, true);
    assert.deepEqual(messages, [...first, ...lastPair]);
    assert.match(delegationBudgetReport({ ...result, stage: 'delegation_window' }), /delegation_window.*上限 100/);
});

test('only the process marker over loopback selects delegation policy', () => {
    const socket = { remoteAddress: '::ffff:127.0.0.1' };
    const headers = delegationHeaders();
    const [name] = Object.keys(headers);
    assert.equal(isAgentDelegation({ headers, socket }), true);
    assert.equal(isAgentDelegation({ headers, socket: { remoteAddress: '192.0.2.1' } }), false);
    assert.equal(isAgentDelegation({ headers: { [name]: '0'.repeat(64) }, socket }), false);
    assert.equal(isAgentDelegation({ headers: {}, socket, body: { agentDelegation: true } }), false);
});

test('delegation falls back to a configured limit without changing regular requests', () => {
    const values = { AgentDelegationContextTokenLimit: undefined, ContextBudgetHardCap: undefined, ContextBudgetGuard: 'off' };
    const original = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    const set = entries => {
        for (const [key, value] of Object.entries(entries)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
    try {
        set(values);
        assert.equal(delegationLimit(), 64000);
        set({ AgentDelegationContextTokenLimit: '0.5' });
        assert.equal(delegationLimit(), 64000);
        set({ AgentDelegationContextTokenLimit: '8000', ContextBudgetHardCap: '4000' });
        assert.equal(delegationLimit(), 4000);
        assert.equal(delegationLimit(10000), 4000);
        assert.equal(delegationLimit(3000), 3000);
        assert.equal(contextBudget.createBudgetGuard().enforcing, false);
        assert.equal(contextBudget.createBudgetGuard({ limit: delegationLimit(), mode: 'enforce' }).enforcing, true);
    } finally {
        set(original);
    }
});

for (const agentDelegation of [true, false]) {
    test(`non-stream tool result stops before next upstream fetch (delegation=${agentDelegation})`, async () => {
        const res = { send(buf) { this.body = JSON.parse(buf.toString()); } };
        const originalBody = { model: 'budget-test', messages: [msg('user', 'task')] };
        const handler = new NonStreamHandler({
            originalBody,
            agentDelegation,
            budgetGuard: contextBudget.createBudgetGuard({ limit: 100, mode: 'enforce' }),
            pluginManager: { messagePreprocessors: new Map() },
            abortController: new AbortController(),
            ToolCallParser: { parse: () => [{ name: 'demo' }], separate: normal => ({ normal, archery: [] }) },
            toolExecutor: { executeAll: async () => [{ success: true, content: [{ type: 'text', text: 'x'.repeat(6000) }] }] },
            isToolResultError: () => false,
            fetchWithRetry: () => assert.fail('oversized tool payload reached upstream'),
            apiRetries: 1
        });
        const initial = { choices: [{ message: msg('assistant', 'call demo'), finish_reason: 'stop' }] };
        const result = await handler.handle({}, res, { ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify(initial)) });
        assert.equal(result.completed, false);
        assert.match(res.body.choices[0].message.content, /工具循环在此停止/);
        if (agentDelegation) {
            assert.equal(res.body.vcp_incomplete, true);
            assert.equal(res.body.vcp_context_budget.stage, 'tool_loop');
            assert.match(delegationBudgetReport(res.body.vcp_context_budget), /tool_loop.*上限 100/);
        } else {
            assert.equal(res.body.vcp_context_budget, undefined);
            assert.equal(res.body.vcp_incomplete, undefined);
        }
    });
}

test('chat egress enforces the delegation fallback after expansion, not for ordinary callers', async t => {
    const prev = process.env.AgentDelegationContextTokenLimit;
    const guardMode = process.env.ContextBudgetGuard;
    const cap = process.env.ContextBudgetHardCap;
    process.env.AgentDelegationContextTokenLimit = '100';
    process.env.ContextBudgetGuard = 'observe';
    delete process.env.ContextBudgetHardCap;
    t.after(() => {
        for (const [key, value] of Object.entries({ AgentDelegationContextTokenLimit: prev, ContextBudgetGuard: guardMode, ContextBudgetHardCap: cap })) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    const sent = [];
    const upstream = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        sent.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: msg('assistant', 'done'), finish_reason: 'stop' }] }));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
    const handler = new ChatCompletionHandler({
        apiUrl: `http://127.0.0.1:${upstream.address().port}`,
        activeRequests: new Map(),
        writeDebugLog: async () => {},
        modelRedirectHandler: { redirectModelForBackend: model => model },
        pluginManager: {
            messagePreprocessors: new Map([['expand', {}]]),
            executeMessagePreprocessor: async (_name, messages) => [...messages, msg('system', 'x'.repeat(600))]
        },
        apiRetries: 1,
        apiConnectionTimeoutMs: 2000
    });
    const invoke = async (headers, contextTokenLimit) => {
        const req = { method: 'POST', headers, socket: { remoteAddress: '127.0.0.1' }, body: {
            model: 'delegation-egress-test', messages: [msg('user', 'small task')], contextTokenLimit
        } };
        const res = Object.assign(new EventEmitter(), {
            status(code) { this.statusCode = code; return this; },
            setHeader() {},
            json(body) { this.body = body; this.writableEnded = true; this.emit('finish'); },
            send(buf) { this.json(JSON.parse(buf.toString())); }
        });
        await handler.handle(req, res);
        return res;
    };
    const rejected = await invoke(delegationHeaders());
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.body.vcp_context_budget.stage, 'outbound');
    assert.equal(rejected.body.vcp_context_budget.limit, 100);
    assert.equal(sent.length, 0);
    const ordinary = await invoke({});
    assert.equal(ordinary.statusCode, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.messages.at(-1).content.length, 600);
    process.env.AgentDelegationContextTokenLimit = '300';
    const accepted = await invoke(delegationHeaders(), 300);
    assert.equal(accepted.statusCode, 200);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].body.contextTokenLimit, undefined);
    for (const name of Object.keys(delegationHeaders())) assert.equal(sent[1].headers[name], undefined);
});
