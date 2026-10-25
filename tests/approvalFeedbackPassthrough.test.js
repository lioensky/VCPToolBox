// tests/approvalFeedbackPassthrough.test.js
// 覆盖需求：工具审核带 archery 时，用户填写的反馈必须优先回传给 AI；无反馈则保持静默。
//
// 说明：Plugin.js 顶层 require 会拉起 express / chokidar watcher，无法在测试进程内自由加载。
// 因此这里从源码中抽取 handleApprovalResponse 方法体，在 vm 沙箱中以独立函数上下文编译执行——
// 测的仍是磁盘上的真实实现，而非复制品。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PLUGIN_SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'Plugin.js'),
    'utf8'
);

function extractMethodBody(source, methodName) {
    const signature = new RegExp(`^\\s*${methodName}\\s*\\([^)]*\\)\\s*\\{`, 'm');
    const match = signature.exec(source);
    assert.ok(match, `未在 Plugin.js 中找到 ${methodName} 方法`);

    const bodyStart = source.indexOf('{', match.index) + 1;
    let depth = 1;
    let i = bodyStart;
    for (; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) break;
        }
    }
    assert.ok(depth === 0, `${methodName} 方法体花括号不平衡`);
    return source.slice(bodyStart, i);
}

const HANDLE_APPROVAL_BODY = extractMethodBody(PLUGIN_SOURCE, 'handleApprovalResponse');
const handleApprovalResponse = vm.runInNewContext(
    `(function handleApprovalResponse(requestId, approved, reason) {${HANDLE_APPROVAL_BODY}})`,
    { console, clearTimeout, setTimeout }
);

function makeContext(pending) {
    return {
        pendingApprovals: pending || new Map(),
        webSocketServer: null,
        debugMode: false
    };
}

function makePendingEntry(notifyAiOnReject) {
    let resolveFn;
    const promise = new Promise(resolve => {
        resolveFn = resolve;
    });
    const entry = {
        resolve: resolveFn,
        reject: error => { throw error; },
        timeoutId: null,
        notifyAiOnReject
    };
    return { entry, promise };
}

test('静默拒绝：用户填写反馈时，反馈随 resolve 一并带出', async () => {
    const { entry, promise } = makePendingEntry(false);
    const pending = new Map([['req-1', entry]]);
    const ctx = makeContext(pending);

    const handled = handleApprovalResponse.call(ctx, 'req-1', false, '  文件名写错了  ');
    assert.equal(handled, true);
    assert.equal(pending.has('req-1'), false);

    const resolved = await promise;
    assert.equal(resolved.silentRejected, true);
    assert.equal(resolved.userFeedback, '文件名写错了');
});

test('静默拒绝：用户未填写反馈时，不携带 userFeedback', async () => {
    const { entry, promise } = makePendingEntry(false);
    const pending = new Map([['req-2', entry]]);
    const ctx = makeContext(pending);

    handleApprovalResponse.call(ctx, 'req-2', false, '   ');
    const resolved = await promise;
    assert.equal(resolved.silentRejected, true);
    assert.equal(resolved.userFeedback, undefined);
});

test('非静默规则：拒绝时走 reject 并携带理由', () => {
    const { entry } = makePendingEntry(true);
    let captured = null;
    entry.reject = error => {
        captured = JSON.parse(error.message);
    };
    const pending = new Map([['req-3', entry]]);
    const ctx = makeContext(pending);

    assert.equal(handleApprovalResponse.call(ctx, 'req-3', false, '用户不同意'), true);
    assert.ok(captured, '应触发 reject');
    assert.equal(captured.error_type, 'approval_rejected');
    assert.equal(captured.rejected_by_user, true);
    assert.match(captured.plugin_error, /用户不同意/);
});

// toolExecutor.js 顶部 require 了 EmbeddingUtils 等重依赖，同样改为源码抽取编译。
const EXECUTOR_SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'modules', 'vcpLoop', 'toolExecutor.js'),
    'utf8'
);
const PROCESS_RESULT_BODY = extractMethodBody(EXECUTOR_SOURCE, '_processResult');
const FORMAT_RESULT_BODY = extractMethodBody(EXECUTOR_SOURCE, '_formatResult');
const BROADCAST_BODY = extractMethodBody(EXECUTOR_SOURCE, '_broadcast');

function makeExecutorStub(webSocketServer) {
    const stub = {
        webSocketServer: webSocketServer || { broadcast: () => {} },
        debugMode: false,
        pluginManager: null
    };
    stub._formatResult = vm.runInNewContext(
        `(function _formatResult(result) {${FORMAT_RESULT_BODY}})`,
        { console }
    );
    stub._broadcast = vm.runInNewContext(
        `(function _broadcast(toolName, status, content) {${BROADCAST_BODY}})`,
        { console }
    );
    stub._processResult = vm.runInNewContext(
        `(function _processResult(toolName, result) {${PROCESS_RESULT_BODY}})`,
        { console }
    );
    return stub;
}

test('_processResult：内层 success:false 透传为失败', () => {
    const executor = makeExecutorStub();
    const rejected = executor._processResult('DemoTool', {
        success: false,
        error: '被用户拒绝',
        content: [{ type: 'text', text: '[工具调用 "DemoTool" 已被用户拒绝]' }]
    });
    assert.equal(rejected.success, false);
    assert.equal(rejected.error, '被用户拒绝');
    assert.equal(rejected.content[0].text, '[工具调用 "DemoTool" 已被用户拒绝]');
});

test('_processResult：正常结果仍为成功', () => {
    const executor = makeExecutorStub();
    const ok = executor._processResult('DemoTool', { hello: 'world' });
    assert.equal(ok.success, true);
    assert.equal(ok.error, undefined);
});