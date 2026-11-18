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


test('允许审核：留言规范化后传给等待方，空留言保持旧行为', async () => {
    for (const reason of ['  请继续并汇总结果  ', '   ', undefined]) {
        const { entry, promise } = makePendingEntry(true);
        const ctx = makeContext(new Map([['approved', entry]]));
        assert.equal(handleApprovalResponse.call(ctx, 'approved', true, reason), true);
        const result = await promise;
        if (typeof reason === 'string' && reason.trim()) {
            assert.equal(result.userFeedback, reason.trim());
        } else {
            assert.equal(result, undefined);
        }
        assert.equal(ctx.pendingApprovals.size, 0);
    }
});

test('允许留言：旧对象回执在文本尾部追加，不重复展示内部字段', () => {
    const executor = makeExecutorStub();
    const result = executor._formatResult({ message: '执行完成', __vcpApprovalFeedback: '继续检查' });
    assert.match(result.content[0].text, /执行完成/);
    assert.ok(result.content[0].text.endsWith('继续检查'));
    assert.doesNotMatch(result.content[0].text, /__vcpApprovalFeedback/);
});

test('允许留言：标准内容数组只追加最后一个文本块，图片与原始对象保持不变', () => {
    const executor = makeExecutorStub();
    for (const nested of [false, true]) {
        const image = Object.freeze({
            type: 'image_url',
            image_url: Object.freeze({ url: 'data:image/png;base64,AAAA', detail: 'high' })
        });
        const first = Object.freeze({ type: 'text', text: '前段' });
        const last = Object.freeze({ type: 'text', text: '后段', custom: '保留' });
        const content = Object.freeze([first, image, last, image]);
        const input = nested
            ? { data: { content }, __vcpApprovalFeedback: '允许留言' }
            : { content, __vcpApprovalFeedback: '允许留言' };
        const result = executor._formatResult(input);
        assert.equal(result.content.length, 4);
        assert.equal(result.content[0], first);
        assert.equal(result.content[1], image);
        assert.equal(result.content[3], image);
        assert.equal(result.content[2].custom, '保留');
        assert.ok(result.content[2].text.startsWith('后段\n\n'));
        assert.ok(result.content[2].text.endsWith('允许留言'));
        assert.equal(last.text, '后段');
        assert.equal(image.image_url.url, 'data:image/png;base64,AAAA');
    }
});

test('允许留言：纯图片回执在末尾增加文本块，无留言原样透传', () => {
    const executor = makeExecutorStub();
    const image = { type: 'image_url', image_url: { url: 'https://example.com/image.png' } };
    const content = [image];
    const plain = executor._formatResult({ content });
    assert.equal(plain.content, content);
    const annotated = executor._formatResult({ content, __vcpApprovalFeedback: '图片已允许' });
    assert.equal(annotated.content[0], image);
    assert.equal(annotated.content[1].type, 'text');
    assert.ok(annotated.content[1].text.endsWith('图片已允许'));
    assert.equal(content.length, 1);
    assert.equal(executor._formatResult(content).content, content, '兼容裸标准数组');
});

test('允许留言：免回执提供独立反馈内容，不泄漏成功业务输出且保持成功', () => {
    const executor = makeExecutorStub();
    const result = executor._processResult('DemoTool', {
        __vcpArcheryNoReplySilent: true,
        __vcpApprovalFeedback: '请汇总',
        content: [{ type: 'text', text: 'BUSINESS_OUTPUT' }]
    });
    assert.equal(result.success, true);
    assert.equal(result.approvalFeedbackContent.length, 1);
    assert.match(result.approvalFeedbackContent[0].text, /DemoTool/);
    assert.ok(result.approvalFeedbackContent[0].text.endsWith('请汇总'));
    assert.doesNotMatch(result.approvalFeedbackContent[0].text, /BUSINESS_OUTPUT/);
});

test('允许后执行失败：错误文本仍包含允许留言', () => {
    const executor = makeErrorStub();
    const result = executor._createErrorResult('DemoTool', '执行错误: ' + JSON.stringify({
        plugin_error: '工具执行失败',
        __vcpApprovalFeedback: '执行后请汇总'
    }));
    assert.equal(result.success, false);
    assert.match(result.content[0].text, /工具执行失败/);
    assert.ok(result.content[0].text.endsWith('执行后请汇总'));
});

const PROCESS_TOOL_BODY = extractMethodBody(PLUGIN_AST, PLUGIN_SOURCE, 'processToolCall');

test('真实工具审核链：普通、富内容、裸数组、短路、异常均携带允许留言且不污染参数', async () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
    const cases = [
        { result: { message: 'done' } },
        { result: { content: [{ type: 'text', text: 'done' }, image] } },
        { result: [{ type: 'text', text: 'done' }, image] },
        { shortCircuitResult: { __vcpArcheryNoReplySilent: true, message: 'accepted' } },
        { error: true }
    ];
    for (const output of cases) {
        let executedArgs;
        let sanitizeCount = 0;
        const run = vm.runInNewContext(
            `(async function processToolCall(toolName, toolArgs, requestIp = null, sourceNode = null, executionOptions = {}) {${PROCESS_TOOL_BODY}})`,
            {
                console, setTimeout, clearTimeout,
                resolveArgsFileUrls: async () => {},
                buildToolChangePreview: () => null,
                getFormattedLocalTimestamp: () => 'test-time',
                filterFuzzyDiff: () => {},
                toolCallRecordStore: { beginRecord: () => null, finishRecord: () => {} }
            }
        );
        const ctx = {
            plugins: new Map([['DemoTool', {}]]),
            pendingApprovals: new Map(),
            debugMode: false,
            toolApprovalManager: {
                getApprovalDecision: () => ({ requiresApproval: true }),
                getTimeoutMs: () => 10000
            },
            webSocketServer: {
                broadcast: payload => handleApprovalResponse.call(ctx, payload.data.requestId, true, '  审核留言  ')
            },
            toolLifecycleVcpInfo: { createContext: () => ({}), emit: () => {} },
            _getPluginConfig: () => ({}),
            _sanitizeToolResultForAi: result => { sanitizeCount++; return result; },
            executionBridgeRegistry: {
                execute: async (_plugin, args) => {
                    executedArgs = args;
                    if (output.error) throw new Error(JSON.stringify({ plugin_error: 'failed' }));
                    return output;
                }
            }
        };
        let result;
        try {
            result = await run.call(ctx, 'DemoTool', { command: 'read' });
            assert.equal(output.error, undefined);
        } catch (error) {
            assert.equal(output.error, true);
            result = JSON.parse(error.message);
        }
        assert.equal(result.__vcpApprovalFeedback, '审核留言');
        assert.equal(executedArgs.command, 'read');
        assert.equal(executedArgs.__vcpApprovalFeedback, undefined);
        assert.equal(ctx.pendingApprovals.size, 0);
        assert.equal(sanitizeCount, 1);
        if (Array.isArray(output.result)) assert.equal(result.content, output.result);
    }
});


test('流式/非流式模型请求：多模态回执不损坏，免回执仅传留言，无留言不续轮', async () => {
    const { Readable } = require('node:stream');
    for (const stream of [false, true]) {
        const filename = stream ? 'streamHandler.js' : 'nonStreamHandler.js';
        const source = fs.readFileSync(path.join(__dirname, '..', 'modules', 'handlers', filename), 'utf8');
        const moduleStub = { exports: {} };
        vm.runInNewContext(source, {
            module: moduleStub, exports: moduleStub.exports,
            require: name => {
                if (name.includes('vcpInfoHandler')) return { streamVcpInfo: () => '' };
                if (name.includes('roleDivider')) return { process: messages => messages };
                return require(name.startsWith('../') ? path.join(__dirname, '..', 'modules', name.slice(3)) : name);
            },
            console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval
        });
        const Handler = moduleStub.exports;
        for (const scenario of ['normal', 'archery', 'silent']) {
            const requests = [];
            const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
            const feedback = [{ type: 'text', text: '用户允许留言：请汇总' }];
            const executor = makeExecutorStub();
            const formatted = executor._formatResult({
                content: [{ type: 'text', text: 'BUSINESS_OUTPUT' }, image],
                __vcpApprovalFeedback: '请汇总'
            });
            const makeResponse = text => stream
                ? {
                    ok: true,
                    body: Readable.from([
                        `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`,
                        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
                        'data: [DONE]\n\n'
                    ])
                }
                : {
                    ok: true,
                    arrayBuffer: async () => Buffer.from(JSON.stringify({
                        choices: [{ message: { content: text }, finish_reason: 'stop' }]
                    }))
                };
            const context = {
                apiUrl: 'https://example.com', apiKey: 'test',
                pluginManager: { messagePreprocessors: new Map() },
                originalBody: { model: 'test', messages: [{ role: 'user', content: '执行' }] },
                abortController: new AbortController(),
                maxVCPLoopStream: 3, maxVCPLoopNonStream: 3,
                apiRetries: 1,
                ToolCallParser: {
                    parse: text => text.includes('CALL_TOOL') ? [{ name: 'DemoTool', args: {} }] : [],
                    separate: calls => scenario === 'normal'
                        ? { normal: calls, archery: [] }
                        : { normal: [], archery: calls }
                },
                toolExecutor: {
                    execute: async () => ({
                        success: true,
                        content: formatted.content,
                        raw: {},
                        approvalFeedbackContent: scenario === 'archery' ? feedback : []
                    }),
                    executeAll: async () => [{ success: true, content: formatted.content, raw: {} }]
                },
                isToolResultError: () => false,
                fetchWithRetry: async (_url, options) => {
                    requests.push(JSON.parse(options.body));
                    return makeResponse('完成');
                }
            };
            const res = {
                writableEnded: false, destroyed: false,
                write: (_text, callback) => { if (callback) callback(); },
                end: () => { res.writableEnded = true; },
                send: () => { res.writableEnded = true; }
            };
            await new Handler(context).handle({}, res, makeResponse('CALL_TOOL'));
            if (scenario === 'silent') {
                assert.equal(requests.length, 0);
                continue;
            }
            assert.equal(requests.length, 1);
            const payload = requests[0].messages.at(-1);
            assert.equal(payload.role, 'user');
            if (scenario === 'normal') {
                assert.ok(Array.isArray(payload.content));
                assert.equal(payload.content[1].text.endsWith('请汇总'), true);
                assert.deepEqual(payload.content[2], image);
            } else {
                assert.match(payload.content, /请汇总/);
                assert.doesNotMatch(payload.content, /BUSINESS_OUTPUT|image_url/);
            }
        }
    }
});
