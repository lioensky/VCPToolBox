'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rag = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');

function host(useJev = false) {
    const instance = Object.create(rag);
    instance.rerankConfig = {
        useJev, multiplier: 2, jevPrompt: 'default',
        jevPrompts: { 1: 'one', 2: 'two', 3: 'three', 4: 'four' }
    };
    instance.queryCacheEnabled = false;
    instance.ragParams = {};
    instance.pushVcpInfo = null;
    return instance;
}

test('legacy Rerank and Rerank+ still follow the Jev env switch', () => {
    for (const enabled of [false, true]) {
        const instance = host(enabled);
        for (const suffix of ['::Rerank', '::Rerank+', '::Rerank+0.6']) {
            const options = instance._parseRerankModifiers(suffix);
            assert.equal(options.useRerank, true);
            assert.equal(options.useJev, enabled);
            assert.equal(options.jevPrompt, 'default');
            assert.equal(options.rrfAlpha, suffix.endsWith('0.6') ? 0.6 : suffix.endsWith('+') ? 0.5 : null);
        }
    }
});

test('explicit Jev presets and fusion weights are independent', () => {
    const instance = host();
    for (const preset of ['', '1', '2', '3', '4']) {
        for (const plus of ['', '+', '+0.6', '+0', '+1', '+.6', '+2']) {
            const suffix = `::Jev${preset}${plus}`;
            const options = instance._parseRerankModifiers(`${suffix}::Expand`);
            assert.equal(options.useJev, true);
            assert.equal(options.useRerank, true);
            assert.equal(options.useRerankPlus, !!plus);
            assert.equal(options.jevPrompt, preset ? instance.rerankConfig.jevPrompts[preset] : 'default');
            assert.equal(options.rrfAlpha, !plus ? null : plus === '+' ? 0.5 : Math.min(1, Number(plus.slice(1))));
            assert.equal(instance._extractKMultiplier(suffix), 1);
        }
    }
    assert.equal(instance._parseRerankModifiers('::Rerank+0.8::Jev2').useRerankPlus, false);
    for (const invalid of ['::Jev20', '::Jev5', '::Jev2oops', '::Jev2+0.6.5']) {
        assert.equal(instance._parseRerankModifiers(invalid).useRerank, false);
    }
    delete instance.rerankConfig.jevPrompts[2];
    assert.equal(instance._parseRerankModifiers('::Jev2').jevPrompt, 'default');
    assert.equal(instance._parseRerankModifiers('::Jev2').missingPreset, true);
});

test('cache identity includes selected prompt and legacy backend switch', () => {
    const instance = host();
    const input = { dbName: 'Diary', modifiers: '::Jev2+' };
    const original = instance._generateCacheKey(input);
    instance.rerankConfig.jevPrompts[1] = 'unrelated change';
    assert.equal(instance._generateCacheKey(input), original);
    instance.rerankConfig.jevPrompts[2] = 'changed';
    assert.notEqual(instance._generateCacheKey(input), original);
    const legacy = { dbName: 'Diary', modifiers: '::Rerank+' };
    const traditional = instance._generateCacheKey(legacy);
    instance.rerankConfig.useJev = true;
    assert.notEqual(instance._generateCacheKey(legacy), traditional);
});

test('concurrent explicit Jev calls do not mutate shared configuration or call traditional rerank', async () => {
    const instance = host();
    const seen = [];
    instance.jevClient = {
        isConfigured: () => true,
        async decide(state, questions) {
            const prompt = questions.best_memory.instructions;
            await new Promise(resolve => setTimeout(resolve, prompt === 'one' ? 10 : 1));
            seen.push(prompt);
            return { answers: { best_memory: {
                type: 'choice', choice: 'doc_001', confidence: 0.8,
                probabilities: { doc_000: 0.2, doc_001: 0.8 }
            } } };
        }
    };
    const documents = [{ text: 'a', retrieval_rank: 1 }, { text: 'b', retrieval_rank: 2 }];
    const results = await Promise.all([1, 2].map(preset => instance._rerankDocuments(
        'query', documents, 1, null, instance._parseRerankModifiers(`::Jev${preset}`)
    )));
    assert.deepEqual(results.map(items => items[0].text), ['b', 'b']);
    assert.deepEqual(seen.sort(), ['one', 'two']);
    assert.equal(instance.rerankConfig.useJev, false);
    assert.equal(instance.rerankConfig.jevPrompt, 'default');
});

test('Jev2+0.6 reaches native parallel rank with request prompt and keeps fused order', async () => {
    const instance = host();
    instance.vectorDBManager = {
        config: { nativeRiverQueryEnabled: true },
        nativeKnowledgeRuntime: { executeParallelRerank() {} },
        async executeParallelRerank(query, options) {
            assert.equal(options.useJev, true);
            assert.equal(options.jevPrompt, 'two');
            assert.equal(options.alpha, 0.6);
            return { results: [
                { chunkId: 2, text: 'second', score: 0.4, rrf_score: 0.02 },
                { chunkId: 1, text: 'first', score: 0.9, rrf_score: 0.01 }
            ] };
        },
        async executeNativeRiverQuery() { throw new Error('serial path used'); },
        async deduplicateResults(results) { return results; }
    };
    instance._rerankDocuments = async () => { throw new Error('JS rerank used'); };
    const results = await instance._processRAGPlaceholder({
        dbName: ['A', 'B'], modifiers: '::Jev2+0.6', queryVector: [1, 0],
        userContent: 'query', dynamicK: 2, timeRanges: [], returnRawResults: true
    });
    assert.deepEqual(results.map(item => item.chunkId), [2, 1]);
});

test('ranking suffix accepts a trailing K multiplier without confusing preset and alpha', () => {
    const instance = host();
    for (const suffix of ['::Jev2+0.6:1.5', '::Rerank+0.6:1.5']) {
        const options = instance._parseRerankModifiers(suffix);
        assert.equal(options.useRerank, true);
        assert.equal(options.useRerankPlus, true);
        assert.equal(options.rrfAlpha, 0.6);
        assert.equal(instance._extractKMultiplier(suffix), 1.5);
    }
});