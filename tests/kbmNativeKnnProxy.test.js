'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SearchService = require('../modules/knowledgeBase/searchService');

test('KNN consumes native frozen hydration without synchronous index access', async () => {
    const calls = [];
    const owner = {
        config: { dimension: 2 },
        _isVectorLike: value => Array.isArray(value) || value instanceof Float32Array,
        async _getOrLoadDiaryIndex() { throw new Error('old index forbidden'); },
        async hydrateChunksByIds() { throw new Error('second hydration forbidden'); },
        async executeLightMemoQuery(query, options) {
            calls.push('warped');
            assert.deepEqual(options.scope.exactDiaryNames, ['diary']);
            assert.deepEqual(options.scope.deniedFileIds, [20]);
            assert.equal(query.vector.length, 2);
            assert.equal(options.k, 5);
            return { results: [
                { id: 1, score: -0.1, text: 'allowed', dbName: 'diary',
                    fileId: 10, sourceFile: 'diary/a.txt' }
            ] };
        }
    };
    const results = await new SearchService(owner).searchKnn(
        'diary', [1, 0], 5, { deniedFileIds: [20] }
    );
    assert.deepEqual(calls, ['warped']);
    assert.equal(results.length, 1);
    assert.equal(results[0].text, 'allowed');
    assert.equal(results[0].fullPath, 'diary/a.txt');
    assert.equal(results[0].retrievalEngine, 'warped_ann');
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

test('permission filtering reaches native warped recall before spending K', async () => {
    const requested = [];
    const owner = {
        config: { dimension: 2 },
        _isVectorLike: Array.isArray,
        async _getOrLoadDiaryIndex() { throw new Error('old index forbidden'); },
        async executeLightMemoQuery(_query, options) {
            requested.push(options.k);
            assert.deepEqual(options.scope.deniedFileIds, [1, 2]);
            return { results: [3, 4].map(id => ({
                id, fileId: id, dbName: 'diary', sourceFile: `diary/${id}.txt`
            })) };
        }
    };
    const result = await new SearchService(owner).searchKnn(
        'diary', [1, 0], 2, { deniedFileIds: [1, 2] }
    );
    assert.deepEqual(requested, [2]);
    assert.deepEqual(result.map(item => item.id), [3, 4]);
});