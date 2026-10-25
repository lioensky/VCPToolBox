'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the real serialization methods without starting the manager singleton.
function loadMethod(name, nextName) {
    const filename = path.join(__dirname, '..', 'KnowledgeBaseManager.js');
    const source = fs.readFileSync(filename, 'utf8');
    const start = source.indexOf(`    async ${name}(`);
    const end = source.indexOf(`    async ${nextName}(`, start + 1);
    assert(start >= 0 && end > start);
    return vm.runInNewContext(`({${source.slice(start, end)}})`, {
        path, __dirname: path.dirname(filename), Float32Array
    })[name];
}

for (const [name, nextName] of [
    ['executeExternalRerank', 'executeParallelRerank'],
    ['executeParallelRerank', 'executeNativeRiverQuery']
]) {
    test(`${name} forwards ANN exclusions and preserves sparse diagnostics`, async () => {
        const query = { text: 'fixture', vector: new Float32Array([1, 0]) };
        let captured;
        const owner = {
            async _getOrLoadDiaryIndex() {},
            async prepareUnifiedMemoObservation() {
                return { artifact: { artifactSig: 'fixture' }, pipeline: {},
                    queryVector: query.vector, ghostVectors: new Float32Array() };
            },
            riverMemoEngine: { _nativeConfig: () => ({}) },
            nativeKnowledgeRuntime: {
                capabilities() { return { capabilities: ['index.query-options.v1'] }; },
                async [name](plan, vector) {
                    captured = JSON.parse(plan);
                    assert.equal(vector, query.vector);
                    return JSON.stringify({ results: [], diagnostics: { nativeRerank: {
                        sparseScan: { filesStoppedAtScanLimit: 1 }
                    } } });
                }
            }
        };
        const run = loadMethod(name, nextName);
        const annSearch = { excludeIds: [17, 34], efSearch: 128 };
        const result = await run.call(owner, query, { diaryNames: ['fixture'], annSearch });
        assert.deepEqual(captured.annSearch, annSearch);
        assert.equal(result.diagnostics.nativeRerank.sparseScan.filesStoppedAtScanLimit, 1);
        await run.call(owner, query, { diaryNames: ['fixture'] });
        assert.equal(captured.annSearch, undefined);
        owner.nativeKnowledgeRuntime.capabilities = () => ({ capabilities: [] });
        captured = undefined;
        await assert.rejects(run.call(owner, query, { diaryNames: ['fixture'], annSearch }),
            /NATIVE_ANN_SEARCH_OPTIONS_UNAVAILABLE/);
        assert.equal(captured, undefined);
        delete owner.nativeKnowledgeRuntime.capabilities;
        await assert.rejects(run.call(owner, query, { diaryNames: ['fixture'], annSearch }),
            /NATIVE_ANN_SEARCH_OPTIONS_UNAVAILABLE/);
        await run.call(owner, query, { diaryNames: ['fixture'] });
        assert.equal(captured.annSearch, undefined);
    });
}
