// tests/approvalFeedbackPassthrough.test.js
// 覆盖需求：工具审核带 archery 时，用户填写的反馈必须优先回传给 AI；无反馈则保持静默。
//
// 说明：Plugin.js 顶层 require 会拉起 express / chokidar watcher，无法在测试进程内自由加载。
// 因此这里用 acorn AST 从源码中定位方法体，在 vm 沙箱中以独立函数上下文编译执行——
// 测的仍是磁盘上的真实实现，而非复制品。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');

const PLUGIN_SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'Plugin.js'),
    'utf8'
);
const EXECUTOR_SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'modules', 'vcpLoop', 'toolExecutor.js'),
    'utf8'
);

const PLUGIN_AST = acorn.parse(PLUGIN_SOURCE, {
    ecmaVersion: 'latest',
    sourceType: 'script'
});
const EXECUTOR_AST = acorn.parse(EXECUTOR_SOURCE, {
    ecmaVersion: 'latest',
    sourceType: 'script'
});

// 按 AST 定位方法与函数体：手写词法扫描在模板字符串、转义引号、正则字面量上必然错位。
function findFunctionNode(root, name) {
    let found = null;
    (function walk(node) {
        if (!node || typeof node !== 'object' || found) return;
        if (node.type === 'MethodDefinition' && node.key && node.key.name === name) {
            found = node.value;
            return;
        }
        if (node.type === 'FunctionDeclaration' && node.id && node.id.name === name) {
            found = node;
            return;
        }
        for (const key in node) {
            if (key === 'loc' || key === 'start' || key === 'end') continue;
            const value = node[key];
            if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === 'object') walk(value);
        }
    })(root);
    return found;
}

function extractMethodBody(ast, source, methodName) {
    const fn = findFunctionNode(ast, methodName);
    assert.ok(fn && fn.body, `未在源码 AST 中找到 ${methodName}`);
    return source.slice(fn.body.start + 1, fn.body.end - 1);
}

const HANDLE_APPROVAL_BODY = extractMethodBody(PLUGIN_AST, PLUGIN_SOURCE, 'handleApprovalResponse');
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
const PROCESS_RESULT_BODY = extractMethodBody(EXECUTOR_AST, EXECUTOR_SOURCE, '_processResult');
const FORMAT_RESULT_BODY = extractMethodBody(EXECUTOR_AST, EXECUTOR_SOURCE, '_formatResult');
const BROADCAST_BODY = extractMethodBody(EXECUTOR_AST, EXECUTOR_SOURCE, '_broadcast');

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

// _createErrorResult 会在成功路径之外生成失败结果，同样用源码抽取编译。
const CREATE_ERROR_BODY = extractMethodBody(EXECUTOR_AST, EXECUTOR_SOURCE, '_createErrorResult');

function makeErrorStub() {
    const stub = {
        webSocketServer: { broadcast: () => {} },
        debugMode: false
    };
    stub._broadcast = vm.runInNewContext(
        `(function _broadcast(toolName, status, content) {${BROADCAST_BODY}})`,
        { console }
    );
    stub._createErrorResult = vm.runInNewContext(
        `(function _createErrorResult(toolName, message) {${CREATE_ERROR_BODY}})`,
        { console }
    );
    return stub;
}

test('_createErrorResult：审核拒绝的 JSON 错误被还原为可读文本', () => {
    const executor = makeErrorStub();
    const payload = JSON.stringify({
        plugin_error: 'Tool call "DemoTool" was REJECTED by manual approval. User feedback: 路径写错了',
        error_type: 'approval_rejected',
        rejected_by_user: true,
        user_feedback: '路径写错了'
    });

    const result = executor._createErrorResult('DemoTool', payload);
    assert.equal(result.success, false);
    assert.equal(result.error, payload, 'error 保留原始串供日志排查');
    assert.match(result.content[0].text, /REJECTED by manual approval/);
    assert.match(result.content[0].text, /路径写错了/);
    assert.equal(result.raw.error_type, 'approval_rejected');
    assert.equal(result.raw.user_feedback, '路径写错了');
    assert.doesNotMatch(result.content[0].text, /plugin_error/, '可读文本不应含 JSON 键名');
});

// 真实链路：ToolExecutor 的 catch 会给 error.message 套上 `执行错误: ` 前缀。
// 若解析逻辑只认裸 JSON，这条路径会退化成把转义串丢给 AI。
test('_createErrorResult：真实链路的「执行错误: {json}」仍被还原为可读文本', () => {
    const executor = makeErrorStub();
    const inner = JSON.stringify({
        plugin_error: 'Tool call "DemoTool" was REJECTED by manual approval. User feedback: 参数不对',
        error_type: 'approval_rejected',
        rejected_by_user: true,
        user_feedback: '参数不对'
    });
    const wrapped = '执行错误: ' + inner;

    const result = executor._createErrorResult('DemoTool', wrapped);
    assert.equal(result.success, false);
    assert.equal(result.error, wrapped, 'error 保留完整原始串');
    assert.equal(result.raw.error_type, 'approval_rejected');
    assert.equal(result.raw.user_feedback, '参数不对');
    assert.ok(!result.content[0].text.includes('plugin_error'), '可读文本不应含 JSON 键名');
    assert.match(result.content[0].text, /REJECTED by manual approval/);
    assert.match(result.content[0].text, /参数不对/);
});

test('_createErrorResult：可读文本用真实换行而非字面量反斜杠-n', () => {
    const executor = makeErrorStub();
    const inner = JSON.stringify({
        plugin_error: 'PLUGIN_SIDE_MESSAGE',
        error_type: 'approval_rejected',
        user_feedback: 'USER_SIDE_MESSAGE'
    });
    const result = executor._createErrorResult('DemoTool', inner);
    const text = result.content[0].text;
    assert.ok(text.indexOf(String.fromCharCode(10)) !== -1, '应包含真实换行符');
    assert.ok(text.indexOf(String.fromCharCode(92) + 'n') === -1, '不应包含字面量反斜杠-n');
});

test('_createErrorResult：普通字符串错误保持原样', () => {
    const executor = makeErrorStub();
    const result = executor._createErrorResult('DemoTool', '插件崩了');
    assert.equal(result.success, false);
    assert.equal(result.content[0].text, '[错误] 插件崩了');
    assert.equal(result.raw, undefined);
});
