'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SearchService = require('../modules/knowledgeBase/searchService');

test('KNN consumes native frozen hydration without synchronous index access', async () => {
    const calls = [];
    const owner = {
        config: { dimension: 2 },
        _isVectorLike: value => Array.isArray(value) || value instanceof Float32Array,
        async _getOrLoadDiaryIndex(name) {
            calls.push(name);
            return {
                search() { throw new Error('synchronous search forbidden'); },
                stats() { throw new Error('synchronous stats forbidden'); }
            };
        },
        async hydrateChunksByIds() { throw new Error('second hydration forbidden'); },
        nativeKnowledgeRuntime: {
            async searchDiaryIndices(names, vector, perIndexK) {
                assert.deepEqual(names, ['diary']);
                assert.equal(vector.length, 2);
                assert.equal(perIndexK, 5);
                return JSON.stringify({
                    results: [{ id: 1, score: 0.9 }, { id: 2, score: 0.8 }],
                    hydratedChunks: [
                        { id: 1, text: 'allowed', diaryName: 'diary', fileId: 10, sourceFile: 'diary/a.txt' },
                        { id: 2, text: 'denied', diaryName: 'diary', fileId: 20, sourceFile: 'diary/b.txt' }
                    ]
                });
            }
        }
    };
    const results = await new SearchService(owner).searchKnn(
        'diary', [1, 0], 5, { deniedFileIds: [20] }
    );
    assert.deepEqual(calls, ['diary']);
    assert.equal(results.length, 1);
    assert.equal(results[0].text, 'allowed');
    assert.equal(results[0].fullPath, 'diary/a.txt');
    assert.equal(results[0].retrievalEngine, 'knn');
});

test('similar Tag search consumes native hydrated results with bounded limit', async () => {
    const owner = {
        tagIndex: { search() { throw new Error('synchronous Tag search forbidden'); } },
        async hydrateTagNamesByIds() { throw new Error('second Tag hydration forbidden'); },
        nativeKnowledgeRuntime: {
            async searchGlobalTags(vector, limit) {
                assert.ok(vector instanceof Float32Array);
                assert.equal(limit, 1000);
                return JSON.stringify([{ tag: 'native', score: 0.75 }]);
            }
        }
    };
    assert.deepEqual(
        await new SearchService(owner).searchSimilarTags([1, 0], 100000),
        [{ tag: 'native', score: 0.75 }]
    );
});