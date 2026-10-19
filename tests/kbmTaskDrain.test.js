'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const IngestionPipeline = require('../modules/knowledgeBase/ingestionPipeline');
const TagConsistencyService = require('../modules/knowledgeBase/tagConsistencyService');

test('ingestion drain waits for every admitted operation', async () => {
    const pipeline = new IngestionPipeline({});
    let finish;
    const operation = pipeline._track(() => new Promise(resolve => { finish = resolve; }));
    await Promise.resolve();
    let drained = false;
    const draining = pipeline.drain().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    finish();
    await operation;
    await draining;
    assert.equal(pipeline.inFlight.size, 0);
});

test('failed ingestion operation does not prevent draining', async () => {
    const pipeline = new IngestionPipeline({});
    await assert.rejects(pipeline._track(() => Promise.reject(new Error('injected'))));
    await pipeline.drain();
    assert.equal(pipeline.inFlight.size, 0);
});

test('Tag drain waits for confirmation and rejects new work during shutdown', async () => {
    const owner = {};
    const service = new TagConsistencyService(owner);
    let finish;
    service._applyPreview = () => new Promise(resolve => { finish = resolve; });
    const pending = service.applyPreview('test');
    let drained = false;
    const draining = service.drain().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    owner._shuttingDown = true;
    await assert.rejects(service.applyPreview('another'), { code: 'KNOWLEDGE_STORE_CLOSED' });
    finish({ applied: false });
    await pending;
    await draining;
    assert.equal(drained, true);
});