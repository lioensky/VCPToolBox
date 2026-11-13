'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createHandoffGate } = require('../modules/vcpLoop/handoffGate');
const jevFoldFilter = require('../modules/jevFoldFilter');

test('/v1/interrupt returns unified boolean success and status fields for both active and missing requests', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const start = source.indexOf("app.post('/v1/interrupt',");
    const end = source.indexOf('\n});', start) + '\n});'.length;

    let handler;
    const activeRequests = new Map();
    vm.runInNewContext(source.slice(start, end), {
        app: { post(_route, fn) { handler = fn; } },
        activeRequests,
        console: { log() {}, error() {} },
        setImmediate: fn => fn(),
        setTimeout: () => {},
    });

    const controller = new AbortController();
    const context = {
        req: { body: { stream: true } },
        aborted: false,
        abortReason: null,
        abortController: controller,
        handoffGate: createHandoffGate(controller.signal),
        res: {
            headersSent: true,
            writableEnded: false,
            destroyed: false,
            getHeader: () => 'text/event-stream',
            write() {},
            end() { this.writableEnded = true; },
        },
    };
    activeRequests.set('req-demo-1', context);

    const invoke = body => {
        const out = { statusCode: 200, body: null };
        const res = {
            status(code) { out.statusCode = code; return this; },
            json(payload) { out.body = payload; return this; },
        };
        handler({ body }, res);
        return out;
    };

    const hit = invoke({ messageId: 'req-demo-1' });
    assert.equal(hit.statusCode, 200);
    assert.equal(hit.body.success, true);
    assert.equal(hit.body.status, 'success');
    assert.equal(context.aborted, true);
    assert.equal(context.abortReason, 'explicit_interrupt');
    assert.equal(controller.signal.aborted, true);

    const miss = invoke({ requestId: 'req-non-existent' });
    assert.equal(miss.statusCode, 404);
    assert.equal(miss.body.success, false);
    assert.equal(miss.body.code, 'REQUEST_NOT_FOUND');
    context.handoffGate.dispose();
});

test('installResponseCacheRecorder skips caching when request is marked aborted', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'modules', 'chatCompletionHandler.js'), 'utf8');
    const start = source.indexOf('function installResponseCacheRecorder(');
    const nextFn = source.indexOf('function consumeVcpToolUseForbiddenPlaceholder(', start);
    const commentStart = source.lastIndexOf('/**', nextFn);
    const end = commentStart > start ? commentStart : nextFn;
    assert.ok(start >= 0 && end > start, 'installResponseCacheRecorder slice boundary not found');

    const sandbox = { Buffer, console: { log() {} } };
    vm.runInNewContext(`${source.slice(start, end)}\nthis.fn = installResponseCacheRecorder;`, sandbox);
    const installResponseCacheRecorder = sandbox.fn;

    const stored = new Map();
    const cache = {
        enabled: true,
        set(key, value) { stored.set(key, value); },
    };

    const createMockRes = () => {
        const emitter = new EventEmitter();
        emitter.statusCode = 200;
        emitter.getHeaders = () => ({ 'content-type': 'text/event-stream' });
        emitter.write = () => true;
        emitter.end = () => { emitter.emit('finish'); };
        return emitter;
    };

    let abortedFlag = true;
    const abortedRes = createMockRes();
    installResponseCacheRecorder(abortedRes, {
        cache,
        cacheKey: '127.0.0.1:req-aborted',
        id: 'req-aborted',
        clientIp: '127.0.0.1',
        streamMode: true,
        debugMode: false,
        shouldSkipCache: () => abortedFlag,
    });
    abortedRes.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    abortedRes.end('data: [DONE]\n\n');
    assert.equal(stored.has('127.0.0.1:req-aborted'), false);

    abortedFlag = false;
    const normalRes = createMockRes();
    installResponseCacheRecorder(normalRes, {
        cache,
        cacheKey: '127.0.0.1:req-normal',
        id: 'req-normal',
        clientIp: '127.0.0.1',
        streamMode: true,
        debugMode: false,
        shouldSkipCache: () => abortedFlag,
    });
    normalRes.write('data: {"choices":[{"delta":{"content":"complete"}}]}\n\n');
    normalRes.end('data: [DONE]\n\n');
    assert.equal(stored.has('127.0.0.1:req-normal'), true);
});

test('jevFoldFilter and PluginManager.executeMessagePreprocessor propagate AbortError immediately when signal aborts', async () => {
    jevFoldFilter.clearTurnCache();
    const prevFilter = process.env.JevFoldFilter;
    const prevMinChars = process.env.JevFoldMinChars;
    process.env.JevFoldFilter = 'true';
    process.env.JevFoldMinChars = '0';

    try {
        const controller = new AbortController();
        controller.abort();

        await assert.rejects(
            () => jevFoldFilter.filterCandidates({
                userContent: 'Search repository symbols',
                candidates: [{ description: 'Code search utility', content: 'x'.repeat(200) }],
                universe: ['Code search utility'],
                signal: controller.signal,
                client: {
                    isConfigured: () => true,
                    decide: async () => {
                        assert.fail('JEV client must not be called when signal is already aborted');
                    },
                },
            }),
            err => err?.name === 'AbortError'
        );

        const pluginSource = fs.readFileSync(path.join(__dirname, '..', 'Plugin.js'), 'utf8');
        const fnStart = pluginSource.indexOf('async executeMessagePreprocessor(');
        const fnEnd = pluginSource.indexOf('async shutdownAllPlugins(', fnStart);
        assert.ok(fnStart >= 0 && fnEnd > fnStart, 'executeMessagePreprocessor slice boundary not found');

        const harnessProto = vm.runInNewContext(
            `({ ${pluginSource.slice(fnStart, fnEnd)} })`,
            { console: { log() {}, error() {} }, Error }
        );
        const manager = Object.assign(Object.create(harnessProto), {
            debugMode: false,
            plugins: new Map([['DemoPreprocessor', { name: 'DemoPreprocessor', configSchema: {} }]]),
            _getPluginConfig: () => ({}),
            messagePreprocessors: new Map([
                ['DemoPreprocessor', {
                    async processMessages(_messages, config) {
                        if (config.signal?.aborted) {
                            const abortErr = new Error('Preprocessor cancelled');
                            abortErr.name = 'AbortError';
                            throw abortErr;
                        }
                        return _messages;
                    },
                }],
            ]),
        });

        await assert.rejects(
            () => manager.executeMessagePreprocessor(
                'DemoPreprocessor',
                [{ role: 'user', content: 'hello' }],
                { signal: controller.signal }
            ),
            err => err?.name === 'AbortError'
        );
    } finally {
        if (prevFilter === undefined) delete process.env.JevFoldFilter;
        else process.env.JevFoldFilter = prevFilter;
        if (prevMinChars === undefined) delete process.env.JevFoldMinChars;
        else process.env.JevFoldMinChars = prevMinChars;
    }
});