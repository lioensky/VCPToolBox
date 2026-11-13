'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createHandoffGate } = require('../modules/vcpLoop/handoffGate');
const jevFoldFilter = require('../modules/jevFoldFilter');
const { getEmbeddingsBatch } = require('../EmbeddingUtils');

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

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

test('jevFoldFilter fast-aborts pre-aborted signal, detaches caller on mid-flight abort while draining result into turnCache, and PluginManager rethrows AbortError', async () => {
    jevFoldFilter.clearTurnCache();
    const prevFilter = process.env.JevFoldFilter;
    const prevMinChars = process.env.JevFoldMinChars;
    const prevGate = process.env.JevFoldGate;
    process.env.JevFoldFilter = 'true';
    process.env.JevFoldMinChars = '0';
    process.env.JevFoldGate = '0.5';

    try {
        // 1. Pre-aborted signal never invokes client.decide
        const preAborted = new AbortController();
        preAborted.abort();

        await assert.rejects(
            () => jevFoldFilter.filterCandidates({
                userContent: 'Search repository symbols',
                candidates: [{ description: 'Code search utility', content: 'x'.repeat(200) }],
                universe: ['Code search utility'],
                signal: preAborted.signal,
                client: {
                    isConfigured: () => true,
                    decide: async () => {
                        assert.fail('JEV client must not be called when signal is already aborted');
                    },
                },
            }),
            err => err?.name === 'AbortError'
        );

        // 2. Mid-flight abort detaches caller immediately, while background response populates turnCache for instant retry reuse
        const midAbort = new AbortController();
        const decideStarted = createDeferred();
        const releaseDecide = createDeferred();
        let decideCallCount = 0;
        let capturedDecideSignal = null;

        const mockJevClient = {
            isConfigured: () => true,
            async decide(_state, questions, options) {
                decideCallCount += 1;
                capturedDecideSignal = options?.signal || null;
                decideStarted.resolve();
                await releaseDecide.promise;
                const answers = { turn_intent: { type: 'noul', noul: 0.92 } };
                for (const [qid, q] of Object.entries(questions)) {
                    if (qid === 'turn_intent') continue;
                    answers[qid] = {
                        type: 'noul',
                        noul: String(q.instructions).includes('Code search utility') ? 0.88 : 0.12,
                    };
                }
                return { model: 'jev-mock', answers, usage: { input_tokens: 48 } };
            },
        };

        const firstRunPromise = jevFoldFilter.filterCandidates({
            userContent: 'Find symbol definitions in workspace',
            candidates: [
                { description: 'Code search utility', content: 'a'.repeat(240) },
                { description: 'Music playback tool', content: 'b'.repeat(240) },
            ],
            universe: ['Code search utility', 'Music playback tool'],
            signal: midAbort.signal,
            client: mockJevClient,
        });

        await decideStarted.promise;
        midAbort.abort();

        // Caller detaches immediately before releaseDecide resolves, and underlying socket signal is NOT aborted
        await assert.rejects(() => firstRunPromise, err => err?.name === 'AbortError');
        assert.equal(Boolean(capturedDecideSignal?.aborted), false);

        // Let the in-flight JEV call finish and populate turnCache silently
        releaseDecide.resolve();
        await new Promise(resolve => setImmediate(resolve));

        const retryDecision = await jevFoldFilter.filterCandidates({
            userContent: 'Find symbol definitions in workspace',
            candidates: [
                { description: 'Code search utility', content: 'a'.repeat(240) },
                { description: 'Music playback tool', content: 'b'.repeat(240) },
            ],
            universe: ['Code search utility', 'Music playback tool'],
            client: mockJevClient,
        });
        assert.equal(decideCallCount, 1);
        assert.equal(retryDecision.cached, true);
        assert.deepEqual(retryDecision.droppedIndices, [1]);

        // 3. PluginManager.executeMessagePreprocessor propagates AbortError without swallowing
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
                { signal: preAborted.signal }
            ),
            err => err?.name === 'AbortError'
        );
    } finally {
        if (prevFilter === undefined) delete process.env.JevFoldFilter;
        else process.env.JevFoldFilter = prevFilter;
        if (prevMinChars === undefined) delete process.env.JevFoldMinChars;
        else process.env.JevFoldMinChars = prevMinChars;
        if (prevGate === undefined) delete process.env.JevFoldGate;
        else process.env.JevFoldGate = prevGate;
    }
});

test('getEmbeddingsBatch harvests in-flight batch via onBatchComplete while halting unscheduled queued batches on abort', async () => {
    const controller = new AbortController();
    const firstBatchStarted = createDeferred();
    const releaseFirstBatch = createDeferred();
    const fetchedBatches = [];
    const harvestedMap = new Map();

    // Force 4 items into multiple batches by setting single-worker concurrency and using >32 items (MAX_BATCH_ITEMS=32)
    const inputs = Array.from({ length: 70 }, (_, idx) => `sample-segment-${idx}`);

    const mockFetch = async (_url, options) => {
        const parsed = JSON.parse(options.body);
        fetchedBatches.push({ count: parsed.input.length, signalAbortedAtStart: Boolean(options.signal?.aborted) });
        if (fetchedBatches.length === 1) {
            firstBatchStarted.resolve(options.signal);
            await releaseFirstBatch.promise;
        }
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                data: parsed.input.map((_, index) => ({
                    index,
                    embedding: [index + 1, parsed.input.length],
                })),
            }),
        };
    };

    const batchPromise = getEmbeddingsBatch(inputs, {
        apiUrl: 'http://127.0.0.1:65530',
        apiKey: 'test-key',
        model: 'mock-embedding-v1',
        concurrency: 1,
        signal: controller.signal,
        fetchImpl: mockFetch,
        onBatchComplete: ({ texts, vectors }) => {
            texts.forEach((text, i) => harvestedMap.set(text, vectors[i]));
        },
    });

    const firstInflightSignal = await firstBatchStarted.promise;
    controller.abort();

    // Caller detaches immediately with AbortError while batch 1 is still in flight
    await assert.rejects(() => batchPromise, err => err?.name === 'AbortError');
    assert.equal(Boolean(firstInflightSignal?.aborted), false);

    // Finish batch 1: its 32 vectors are harvested into cache, while batches 2 & 3 (remaining 38 items) are never sent!
    releaseFirstBatch.resolve();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(fetchedBatches.length, 1);
    assert.equal(harvestedMap.size, 32);
    assert.deepEqual(harvestedMap.get('sample-segment-0'), [1, 32]);
    assert.equal(harvestedMap.has('sample-segment-32'), false);
});

test('RAGDiaryPlugin.getSingleEmbeddingCached isolates concurrent callers on abort and harvests completed vector into cache', async () => {
    const ragSource = fs.readFileSync(
        path.join(__dirname, '..', 'Plugin', 'RAGDiaryPlugin', 'RAGDiaryPlugin.js'),
        'utf8'
    );
    const fnStart = ragSource.indexOf('async getSingleEmbeddingCached(');
    const fnEnd = ragSource.indexOf('\n    _rememberEmbeddingText(', fnStart);
    assert.ok(fnStart >= 0 && fnEnd > fnStart, 'getSingleEmbeddingCached slice boundary not found');

    const methodHolder = vm.runInNewContext(
        `({ ${ragSource.slice(fnStart, fnEnd)} })`,
        { console: { log() {} }, Error }
    );

    const store = new Map();
    const remembered = [];
    const apiStarted = createDeferred();
    const releaseApi = createDeferred();
    let apiCalls = 0;
    let passedOptions = null;

    const plugin = Object.assign(Object.create(methodHolder), {
        pendingEmbeddingRequests: new Map(),
        cacheManager: {
            generateKey: ({ text }) => `emb:${text}`,
            get: (_ns, key) => store.get(key) || null,
            set: (_ns, key, val) => { store.set(key, val); },
        },
        _rememberEmbeddingText: (key, text) => remembered.push([key, text]),
        _findFuzzyEmbeddingFromCache: () => null,
        async getSingleEmbedding(_text, opts) {
            apiCalls += 1;
            passedOptions = opts;
            apiStarted.resolve();
            return await releaseApi.promise;
        },
    });

    const abortA = new AbortController();
    const callerA = plugin.getSingleEmbeddingCached('shared-context-paragraph', { signal: abortA.signal });
    await apiStarted.promise;

    // Caller B joins the exact same in-flight request
    const callerB = plugin.getSingleEmbeddingCached('shared-context-paragraph', {});

    // Caller A aborts: A detaches immediately, underlying call has NO single-caller signal, and B continues safely
    abortA.abort();
    await assert.rejects(() => callerA, err => err?.name === 'AbortError');
    assert.equal(passedOptions, undefined);

    releaseApi.resolve([0.25, 0.75]);
    const vecB = await callerB;
    assert.deepEqual(vecB, [0.25, 0.75]);
    assert.equal(apiCalls, 1);
    assert.deepEqual(store.get('emb:shared-context-paragraph'), [0.25, 0.75]);
    assert.equal(remembered.length >= 1, true);

    // Subsequent retry hits exact cache in 0ms without calling API again
    const retryVec = await plugin.getSingleEmbeddingCached('shared-context-paragraph', {});
    assert.deepEqual(retryVec, [0.25, 0.75]);
    assert.equal(apiCalls, 1);

    // Late background rejection after caller detach must never cause unhandledRejection
    let unhandledCount = 0;
    const onUnhandled = () => { unhandledCount += 1; };
    process.on('unhandledRejection', onUnhandled);
    try {
        const failStarted = createDeferred();
        const rejectApi = createDeferred();
        plugin.getSingleEmbedding = async () => {
            failStarted.resolve();
            return await rejectApi.promise;
        };
        const abortC = new AbortController();
        const callerC = plugin.getSingleEmbeddingCached('transient-network-failure-sample', { signal: abortC.signal });
        await failStarted.promise;
        abortC.abort();
        await assert.rejects(() => callerC, err => err?.name === 'AbortError');

        rejectApi.reject(new Error('Upstream 502 after caller detached'));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(unhandledCount, 0);
        assert.equal(plugin.pendingEmbeddingRequests.size, 0);
    } finally {
        process.removeListener('unhandledRejection', onUnhandled);
    }
});