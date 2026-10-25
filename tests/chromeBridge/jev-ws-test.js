'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createJevEntityService } = require('../../Plugin/ChromeBridge/jevEntityService');
const { createJevWsProxy } = require('../../Plugin/ChromeBridge/VCPChrome/jev-ws-proxy');
const { createEntityArbiter, protocol, runtimeCore, adapterContract } =
    require('../../Plugin/ChromeBridge/VCPChrome/webcore');

function fixture() {
    const socket = new EventEmitter();
    socket.readyState = 1;
    const proxy = createJevWsProxy(() => socket);
    let calls = 0;
    let lastState;
    let probabilities = [0.9, 0.1];
    const service = createJevEntityService({
        isConfigured: () => true,
        async decide(state, questions, options) {
            calls++;
            lastState = JSON.parse(state);
            assert.equal(options.maxRetries, 0);
            assert.equal(questions.c_0.type, 'noul');
            return { answers: Object.fromEntries(probabilities.map((noul, i) => [`c_${i}`, { noul }])) };
        }
    });
    socket.send = raw => {
        const message = JSON.parse(raw);
        if (message.type === 'jev_entity_request') void service({ ws: socket }, message.data);
        else proxy.handleMessage(socket, message);
    };
    return {
        socket, proxy, get calls() { return calls; }, get lastState() { return lastState; },
        set probabilities(value) { probabilities = value; }
    };
}

const candidates = [
    { handleId: 'vcp-h-1-1-1-ab', label: '提交', value: 'secret' },
    { handleId: 'vcp-h-1-1-2-cd', label: '取消' }
];

class Adapter extends adapterContract.WebAgentAdapter {
    constructor() {
        super({ id: 'fixture', backend: 'fixture' });
        this.generation = 1;
        this.operations = [];
        this.ambiguous = true;
    }
    async getCapabilities() { return ['page', 'nativeInput']; }
    async getTargetIdentity() { return { targetId: 'one', runtimeInstanceId: 'runtime' }; }
    async getDocumentState() { return { documentGeneration: this.generation, snapshotId: 1 }; }
    async getTarget() { return { url: 'https://example.test/form?token=secret#secret' }; }
    async executePageOperation(operation, payload) {
        this.operations.push({ operation, payload });
        if (this.ambiguous && payload.target === '提交') {
            throw new protocol.WebAgentError('TARGET_AMBIGUOUS', 'ambiguous', { candidates });
        }
        return { status: 'success', code: 'ACTION_VERIFIED', result: { verified: true } };
    }
}

async function execute(adapter, arbiter) {
    const runtime = runtimeCore.createWebAgentRuntime(adapter, { arbiter });
    return runtime.execute(protocol.createRequest({
        command: 'page_click', targetContext: { targetId: 'one' },
        params: { target: '提交' }, options: { backend: 'content-script' }
    }));
}

test('完整代理链路：歧义通过服务器 Jev 仲裁，且不发送输入值或 URL 查询参数', async () => {
    const f = fixture();
    const adapter = new Adapter();
    const arbiter = createEntityArbiter({ decide: f.proxy.decide });
    const result = await execute(adapter, arbiter);
    assert.equal(result.status, 'success');
    assert.equal(f.calls, 1);
    assert.equal(f.lastState.pageUrl, 'https://example.test/form');
    assert.equal(f.lastState.candidates[0].value, undefined);
    assert.equal(adapter.operations.length, 2);
    assert.equal(adapter.operations[1].payload.target, candidates[0].handleId);
    assert.equal(result.result.result.targetResolution.arbiterUsed, true);
});

test('确定性命中不调用模型；content-script 不误走 nativeInput', async () => {
    const f = fixture();
    const adapter = new Adapter();
    adapter.ambiguous = false;
    const result = await execute(adapter, createEntityArbiter({ decide: f.proxy.decide }));
    assert.equal(result.status, 'success');
    assert.equal(f.calls, 0);
    assert.equal(adapter.operations.length, 1);
    assert.equal(adapter.operations[0].operation, 'page_click');
});

test('低置信度和服务断连均保留原歧义错误，不执行候选', async () => {
    const f = fixture();
    f.probabilities = [0.51, 0.49];
    let adapter = new Adapter();
    let result = await execute(adapter, createEntityArbiter({ decide: f.proxy.decide }));
    assert.equal(result.code, 'TARGET_AMBIGUOUS');
    assert.equal(adapter.operations.length, 1);
    f.socket.readyState = 3;
    adapter = new Adapter();
    result = await execute(adapter, createEntityArbiter({ decide: f.proxy.decide }));
    assert.equal(result.code, 'TARGET_AMBIGUOUS');
    assert.equal(adapter.operations.length, 1);
});

test('仲裁期间文档换代拒绝执行旧目标', async () => {
    const adapter = new Adapter();
    const result = await execute(adapter, {
        async arbitrate() {
            adapter.generation++;
            return { resolved: true, chosen: candidates[0], probability: 0.99 };
        }
    });
    assert.equal(result.code, 'DOCUMENT_GENERATION_MISMATCH');
    assert.equal(adapter.operations.length, 1);
});

test('响应必须匹配原 socket；断连立即清理 pending；超时不重试', async () => {
    const socket = { readyState: 1, send(raw) { this.message = JSON.parse(raw); } };
    const proxy = createJevWsProxy(() => socket);
    const pending = proxy.decide(JSON.stringify({
        command: 'page_click', target: '提交', candidates
    }), {}, { timeoutMs: 100 });
    assert.equal(proxy.handleMessage({}, {
        type: 'jev_entity_result',
        data: { requestId: socket.message.data.requestId, status: 'success', answers: {} }
    }), true);
    proxy.clear(socket);
    await assert.rejects(pending, /CLOSED/);
    await assert.rejects(proxy.decide(JSON.stringify({
        command: 'page_click', target: '提交', candidates
    }), {}, { timeoutMs: 100 }), /TIMEOUT/);
});

test('服务端拒绝任意命令、过大请求和缺失配置，不泄露上游错误', async () => {
    const messages = [];
    const socket = new EventEmitter();
    socket.readyState = 1;
    socket.send = raw => messages.push(JSON.parse(raw).data);
    let calls = 0;
    const service = createJevEntityService({
        isConfigured: () => true,
        async decide() { calls++; throw new Error('secret upstream response'); }
    });
    const data = { requestId: 'request-1', state: { command: 'page_click', target: '提交', candidates } };
    await service({ ws: socket }, { ...data, state: { ...data.state, command: 'runtime_evaluate' } });
    await service({ ws: socket }, { ...data, padding: 'x'.repeat(33000) });
    assert.equal(calls, 0);
    await service({ ws: socket }, data);
    assert.equal(calls, 1);
    assert(!JSON.stringify(messages).includes('secret'));
    assert(messages.every(message => message.status === 'error'));
    assert.equal(socket.listenerCount('close'), 0);
});

test('Chrome 适配器使用页面实例身份，不泄漏后台实例身份', async () => {
    const { createChromeWebAgentAdapter } = require('../../Plugin/ChromeBridge/VCPChrome/webcore/chrome-adapter');
    let sent;
    const adapter = createChromeWebAgentAdapter({
        tabs: { async sendMessage(id, message) {
            sent = message;
            return { status: 'success', result: {} };
        } }
    }, { currentActiveTabId: 1 });
    adapter.updateDocumentState(1, {
        documentGeneration: 2, snapshotId: 3, pageRuntimeInstanceId: 'page-runtime'
    });
    await adapter.executePageOperation('page_click', { target: '提交' }, {
        targetContext: { targetId: 1, runtimeInstanceId: 'background-runtime' }
    });
    assert.equal(sent.data.targetContext.runtimeInstanceId, 'page-runtime');
    assert.equal(sent.type, 'EXECUTE_CORE_COMMAND');
});

test('未配置模型立即失败，不发起网络请求', async () => {
    const socket = new EventEmitter();
    socket.readyState = 1;
    let reply;
    socket.send = raw => { reply = JSON.parse(raw); };
    const service = createJevEntityService({
        isConfigured: () => false,
        decide() { assert.fail('must not call model'); }
    });
    await service({ ws: socket }, {
        requestId: 'unconfigured-1',
        state: { command: 'page_click', target: '提交', candidates }
    });
    assert.equal(reply.data.status, 'error');
    assert.equal(reply.data.code, 'JEV_ENTITY_UNAVAILABLE');
});