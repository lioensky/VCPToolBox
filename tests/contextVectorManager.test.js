'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.resolve(__dirname, '../Plugin/RAGDiaryPlugin/ContextVectorManager.js');
const ContextVectorManager = require(modulePath);
const TextSanitizer = require('../Plugin/RAGDiaryPlugin/TextSanitizer.js');
const MessageContentUtils = require('../Plugin/RAGDiaryPlugin/MessageContentUtils.js');

const message = (role, content) => ({ role, content });
const lastTurn = () => [message('user', 'current question'), message('assistant', 'current answer')];

function createPlugin(embeddings = new Map()) {
    return {
        _stripHtml: TextSanitizer.stripHtml,
        _stripEmoji: TextSanitizer.stripEmoji,
        _stripToolMarkers: TextSanitizer.stripToolMarkers,
        _extractTextFromContent: MessageContentUtils.extractTextFromContent,
        _getEmbeddingFromCacheOnly: content => embeddings.get(content) || null,
        getSingleEmbeddingCached: async () => {
            assert.fail('No embedding API should be called');
        }
    };
}

function key(manager, content) {
    return manager._getNormalizedAndHash(content).hash;
}

test('R2 vectorMap evicts the earliest written entry once full and keeps order below the limit', async () => {
    const embeddings = new Map([
        ['apple', new Float32Array([1, 0])],
        ['brick', new Float32Array([0, 1])],
        ['cloud', new Float32Array([-1, 0])]
    ]);
    const manager = new ContextVectorManager(createPlugin(embeddings), 2);
    await manager.updateContext([message('user', 'apple'), message('assistant', 'brick'), ...lastTurn()]);
    await manager.updateContext([message('user', 'apple'), ...lastTurn()]);
    assert.deepEqual([...manager.vectorMap.keys()], [key(manager, 'apple'), key(manager, 'brick')]);
    await manager.updateContext([message('user', 'cloud'), ...lastTurn()]);
    assert.equal(manager.vectorMap.size, 2);
    assert.deepEqual([...manager.vectorMap.keys()], [key(manager, 'brick'), key(manager, 'cloud')]);
});

test('R2 vectorMap defaults to a 1000-entry limit and drops originalText', async () => {
    const vector = new Float32Array([1, 0]);
    const manager = new ContextVectorManager(createPlugin(new Map([['apple', vector]])));
    assert.equal(manager.maxVectorMapSize, 1000);
    await manager.updateContext([message('user', 'apple'), ...lastTurn()]);
    const entry = manager.vectorMap.get(key(manager, 'apple'));
    assert.equal(Object.hasOwn(entry, 'originalText'), false);
    assert.equal(entry.normalizedText, 'apple');
    assert.strictEqual(entry.vector, vector);
});

test('R2 concurrent writes of one hash do not evict an unrelated entry', async () => {
    const manager = new ContextVectorManager(createPlugin(), 2);
    manager.plugin.getSingleEmbeddingCached = async () => new Float32Array([1, 0]);
    await manager.updateContext([message('user', 'apple'), ...lastTurn()], { allowApi: true });
    await manager.updateContext([
        message('user', 'brick'), message('assistant', 'brick'), ...lastTurn()
    ], { allowApi: true });
    assert.equal(manager.vectorMap.size, 2);
    assert.equal(manager.vectorMap.has(key(manager, 'apple')), true);
    assert.equal(manager.vectorMap.has(key(manager, 'brick')), true);
});

function segmentationFixture(Manager = ContextVectorManager) {
    const texts = ['  FIRST topic  ', '<b>First reply</b>', 'different topic', 'different reply', 'tool observation'];
    const vectors = [
        [0.8, 0.2, 0.1], [0.7, 0.3, 0.2], [0.1, -0.7, 0.8], [0.2, -0.8, 0.7], [-0.8, 0.2, 0.1]
    ].map(values => new Float32Array(values));
    const embeddings = new Map(texts.map((text, index) => [text, vectors[index]]));
    const messages = texts.map((text, index) => message(index === 4 ? 'tool' : index % 2 ? 'assistant' : 'user', text));
    messages.unshift(message('system', 'system instructions'));
    messages.push(...lastTurn());
    return { manager: new Manager(createPlugin(embeddings)), messages };
}

test('R3 segmentContext reuses normalized text and hashes without recomputing them', async t => {
    const { manager, messages } = segmentationFixture();
    await manager.updateContext(messages);
    const normalize = t.mock.method(manager, '_normalize');
    const hash = t.mock.method(manager, '_generateHash');
    const first = manager.segmentContext(messages);
    assert.ok(first.length > 0);
    assert.deepEqual(manager.segmentContext(messages), first);
    assert.equal(normalize.mock.callCount(), 0);
    assert.equal(hash.mock.callCount(), 0);
});

for (const includeLastAssistant of [false, true]) {
    test(`R4 segmentContext excludes repeated last-turn text (assistant present: ${includeLastAssistant})`, async () => {
        const embeddings = new Map([
            ['repeat question', new Float32Array([1, 0])],
            ['repeat answer', new Float32Array([1, 0])]
        ]);
        const manager = new ContextVectorManager(createPlugin(embeddings));
        const history = [message('user', 'repeat question'), message('assistant', 'repeat answer')];
        await manager.updateContext([...history, ...lastTurn()]);
        const messages = [...history, message('user', 'repeat question')];
        if (includeLastAssistant) messages.push(message('assistant', 'repeat answer'));
        await manager.updateContext(messages);
        const segments = manager.segmentContext(messages);
        assert.equal(segments.length, 1);
        assert.deepEqual(segments[0].range, includeLastAssistant ? [0, 1] : [0, 0]);
        assert.equal(segments[0].count, includeLastAssistant ? 2 : 1);
        assert.equal(segments[0].text, includeLastAssistant ? 'repeat question\nrepeat answer' : 'repeat question');
    });
}
