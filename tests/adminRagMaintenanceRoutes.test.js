'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { VexusIndex, NativeKnowledgeRuntime } = require('../rust-vexus-lite');
const TagConsistencyService = require('../modules/knowledgeBase/tagConsistencyService');
const createRagRouter = require('../routes/admin/rag');

test('admin HTTP accepts Rust preview token and commits before queuing training', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-admin-tag-route-'));
    const dbPath = path.join(root, 'test.sqlite');
    fs.writeFileSync(path.join(root, 'note.txt'), 'Tag: keep');
    const index = new VexusIndex(4, 32);
    const runtime = new NativeKnowledgeRuntime(index);
    let server;
    try {
        runtime.openAndInitStore(dbPath);
        await runtime.commitIngestionBatch(dbPath, JSON.stringify({
            operationId: 'route-fixture', batchId: 'route-fixture',
            dimension: 4, modelSig: 'route-test',
            files: [{ path: 'note.txt', diaryName: 'Root', checksum: 'old',
                mtime: 1, size: 9, expectedVersion: 0,
                chunkStart: 0, chunkCount: 0, tagStart: 0, tagCount: 2 }],
            chunks: [],
            tags: [
                { name: 'keep', position: 1, vectorSlot: 0 },
                { name: 'orphan', position: 2, vectorSlot: 1 }
            ]
        }), new Float32Array(), new Float32Array([1,0,0,0, 0,1,0,0]));
        let queued = 0;
        const owner = {
            initialized: true, dbPath, nativeKnowledgeRuntime: runtime,
            config: { rootPath: root, dimension: 4, modelSig: 'route-test',
                ignoreFolders: [], ignorePrefixes: [], ignoreSuffixes: [],
                tagBlacklist: new Set(), tagBlacklistSuper: [], maxTagsPerFile: 50 },
            requestActiveFullTraining() {
                queued++;
                return { queued: true, taskId: 'training' };
            },
            // 58a6780e moved tag-consistency apply off requestActiveFullTraining
            // onto the Memo engine's threshold refresh; /rag-active-full-training
            // still drives requestActiveFullTraining, so both counters matter.
            tagMemoEngine: {
                async scheduleMatrixRebuildForNewTags() {
                    queued++;
                    return true;
                }
            }
        };
        const service = new TagConsistencyService(owner);
        owner.startTagConsistencyPreview = () => service.startPreviewTask();
        owner.getTagConsistencyPreviewStatus = () => service.getPreviewTaskStatus();
        owner.applyTagConsistencyPreview = token => service.applyPreview(token);
        const app = express();
        app.use(express.json());
        app.use('/admin_api', createRagRouter({ dailyNoteRootPath: root, vectorDBManager: owner }));
        server = await new Promise(resolve => {
            const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        });
        const base = `http://127.0.0.1:${server.address().port}/admin_api`;
        const post = (endpoint, body = {}) => fetch(`${base}/${endpoint}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        assert.equal((await post('rag-tag-consistency/preview')).status, 202);
        await service.previewTaskPromise;
        const status = await (await fetch(`${base}/rag-tag-consistency/preview/status`)).json();
        const preview = status.task.preview;
        assert.match(preview.token, /^[a-f0-9]{64}$/);
        assert.equal(preview.summary.orphanTagsToRemove, 1);
        assert.equal((await post('rag-tag-consistency/apply', { token: 'a'.repeat(48) })).status, 400);
        const response = await post('rag-tag-consistency/apply', { token: preview.token });
        assert.equal(response.status, 200);
        const applied = await response.json();
        assert.equal(applied.result.factsCommitted, true);
        assert.equal(applied.result.indexReady, true);
        assert.equal(applied.result.training.queued, true);
        assert.equal(queued, 1);
        const training = await (await post('rag-active-full-training')).json();
        assert.equal(training.result.queued, true);
        assert.equal(queued, 2);
        await service.drain();
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        runtime.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});