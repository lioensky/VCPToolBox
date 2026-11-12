'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildQueryTokens } = require('../Plugin/LightMemo/queryTokens');

function fixture(tokens, groups = []) {
    return {
        _tokenize: () => tokens,
        wordToGroupMap: new Map(groups.flatMap(group => group.map(word => [word, group])))
    };
}

test('285-word group fits budget with original query words first', () => {
    const group = ['vps', ...Array.from({ length: 284 }, (_, i) => `syn_${i}`)];
    const { queryTokens, diagnostics } = buildQueryTokens(
        fixture(['VPS', 'asset', 'asset'], [group]), 'query', true);
    assert.equal(queryTokens.length, 256);
    assert.deepEqual(queryTokens.slice(0, 2), ['vps', 'asset']);
    assert.equal(diagnostics.originalUnique, 2);
    assert.equal(diagnostics.expansionUnique, 284);
    assert.equal(diagnostics.dropped, 30);
    assert.equal(diagnostics.truncated, true);
});

test('multiple groups share remaining slots by round', () => {
    const a = ['a', ...Array.from({ length: 300 }, (_, i) => `a_${i}`)];
    const b = ['b', ...Array.from({ length: 300 }, (_, i) => `b_${i}`)];
    const result = buildQueryTokens(fixture(['a', 'b'], [a, b]), '', true);
    assert.equal(result.queryTokens.length, 256);
    assert.deepEqual(result.queryTokens.slice(2, 6), ['a_0', 'b_0', 'a_1', 'b_1']);
    assert.equal(result.queryTokens.filter(word => word.startsWith('a_')).length, 127);
    assert.equal(result.queryTokens.filter(word => word.startsWith('b_')).length, 127);
});

test('disabled keyword path performs no tokenization', () => {
    const plugin = { _tokenize() { throw new Error('must not tokenize'); } };
    assert.deepEqual(buildQueryTokens(plugin, '', false).queryTokens, []);
});

test('256 and 257 original words have explicit deterministic boundaries', () => {
    for (const count of [256, 257]) {
        const tokens = Array.from({ length: count }, (_, i) => `q_${i}`);
        const result = buildQueryTokens(fixture(tokens), '', true);
        assert.deepEqual(result.queryTokens, tokens.slice(0, 256));
        assert.equal(result.diagnostics.dropped, count - 256);
    }
});

test('UTF-8 byte cap, normalization and global dedup apply to expansions', () => {
    const group = ['a', ' A ', ' Mixed ', '汉'.repeat(342), 'x'.repeat(1024)];
    const result = buildQueryTokens(fixture([' A ', '汉'.repeat(342)], [group]), '', true);
    assert.deepEqual(result.queryTokens, ['a', 'mixed', 'x'.repeat(1024)]);
    assert.equal(result.diagnostics.invalid, 2);
    assert.equal(new Set(result.queryTokens).size, result.queryTokens.length);
});

test('native search and laboratory enforce effective keyword mode per request', async () => {
    const { search, laboratory } = require('../Plugin/LightMemo/nativeQuery');
    const group = ['vps', ...Array.from({ length: 284 }, (_, i) => `syn_${i}`)];
    const plans = [];
    function plugin(mode) {
        return {
            ...fixture(['vps', 'asset'], [group]),
            excludedFolders: [],
            _parseMaidScopedFolder: () => ({ maid: '', folder: null }),
            _mergeFolderScopes: value => value,
            _parseBoolean: (value, fallback) => value ?? fallback,
            _parseBooleanAlias: pairs => pairs.find(([, value]) => value !== undefined)?.[1] ?? true,
            _parseNumber: (value, fallback) => value ?? fallback,
            _parseEngineMode: () => mode,
            _parseStringArray: value => value || [],
            getSingleEmbedding: async () => [1, 0],
            vectorDBManager: {
                async executeLightMemoQuery(query, options) {
                    plans.push(options);
                    return { results: [], comparisonPool: [], tdbTopK: [] };
                }
            },
            _detectColdKnowledgeRoute: () => null,
            _parseRerankOptions: () => ({ enabled: false }),
            _parseAIMemoOptions: () => ({ enabled: false }),
            formatResults: () => 'ok',
            _escapeMarkdownCell: String
        };
    }
    const args = { query: 'vps asset', folder: 'test' };
    await Promise.all(Array.from({ length: 4 }, () => search.call(plugin('rivermemo'), args)));
    assert(plans.every(plan => plan.queryTokens.length === 256 && plan.useBm25));
    plans.length = 0;
    await search.call(plugin('knn'), args);
    await search.call(plugin('rivermemo'), { ...args, bm25: false });
    assert(plans.every(plan => !plan.useBm25 && plan.queryTokens.length === 0));
    plans.length = 0;
    await laboratory.call(plugin('knn'), args);
    assert.equal(plans[0].useBm25, true);
    assert.equal(plans[0].queryTokens.length, 256);
});