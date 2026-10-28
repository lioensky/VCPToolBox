'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDiagnostics } = require('../Plugin/LightMemo/abDiagnostics');
const { laboratory, search } = require('../Plugin/LightMemo/nativeQuery');

const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const request = { coreTags: ['核心'], tagBoost: 0.5, coreBoostFactor: 1.33 };
const response = () => ({
    results: [], comparisonPool: [], tdbTopK: [],
    memoObservation: {
        queryTags: { matchedTags: ['核心'], coreTagsMatched: ['核心'] },
        effectiveTagBoost: 0.42,
        propagation: { parameters: { maxSafeHops: 4, firGamma: 0.6 } }
    },
    river: {
        algorithmVersion: 'rivermemo.conservative-topology-v2',
        omega: { omega: 0.8, omegaEdge: 1, omegaEmerge: 0.7, omegaFlow: 0.9,
            completeObservation: true },
        queryMorphology: { confidence: 0.75, narrativeWeight: 0.6 },
        parameters: { omegaGamma: 1 },
        queryRiverGraph: {
            totalNodes: 3, totalEdges: 2, truncated: true,
            nodes: [
                { id: 1, name: '核心|标签', hop: 0, sourceType: 'core', energy: 1 },
                { id: 2, name: '传播', hop: 1, sourceType: 'emergent', energy: 0.5 }
            ],
            edges: [{ sourceId: 1, targetId: 2, flow: 0.2,
                normalizedFlow: 1, wormhole: true, immediateReturn: false }]
        },
        results: [{ id: 11, chunkId: 11, score: 0.7, role: 'direct_answer',
            baseScore: 0.6, fieldScore: 0.65, fieldResonanceBonus: 0.015,
            topologyBonus: 0.02, anchorBonus: 0.08,
            coreTagsMatched: ['核心'], matchedTags: ['核心'],
            topologyV3: { graphGate: 0.8, anchorReliability: 0.9 },
            relativeTopology: { reliability: 0.8, matchedEdgeCoverage: 0.5 },
            geometry: { pathQuality: 0.7 }, observables: { closure: 0.8 } }]
    }
});

test('AB diagnostics retains omega, confidence, mapping, core tags and bounded propagation', () => {
    const output = formatDiagnostics({ _escapeMarkdownCell: cell }, request, response());
    for (const text of ['omegaEdge', 'omegaEmerge', 'omegaFlow', 'confidence',
        'maxSafeHops', 'firGamma', '实际命中 CoreTag', 'anchorReliability',
        'matchedEdgeCoverage', 'pathQuality', 'graphGate', '核心\\|标签',
        '展示已截断，计算仍使用完整观测', '→', '场共振增益', '0.0150',
        '勿重复累加场共振', 'conservative-topology-v2', '原生解析值']) {
        assert.ok(output.includes(text), text);
    }
});

test('missing graph is not misreported as no propagation; empty river is explicit', () => {
    const data = response();
    delete data.river.queryRiverGraph;
    assert.match(formatDiagnostics({ _escapeMarkdownCell: cell }, request, data),
        /不代表没有传播/);
    data.river = null;
    assert.match(formatDiagnostics({ _escapeMarkdownCell: cell }, request, data),
        /RiverMemo 未执行/);
});

test('laboratory appends diagnostics but normal search keeps its original output', async () => {
    const data = response();
    const plugin = {
        excludedFolders: [],
        _parseMaidScopedFolder: () => ({ maid: '', folder: null }),
        _mergeFolderScopes: value => value,
        _parseBoolean: (value, fallback) => value ?? fallback,
        _parseBooleanAlias: () => true,
        _parseNumber: (value, fallback) => value ?? fallback,
        _parseEngineMode: () => 'rivermemo',
        _parseStringArray: value => value || [],
        _tokenize: () => [], _expandQueryTokens: () => [],
        getSingleEmbedding: async () => [1, 0],
        vectorDBManager: { executeLightMemoQuery: async () => data },
        _escapeMarkdownCell: cell,
        _detectColdKnowledgeRoute: () => null,
        _parseRerankOptions: () => ({ enabled: false }),
        _parseAIMemoOptions: () => ({ enabled: false }),
        formatResults: () => 'ordinary search'
    };
    const args = { query: '查询', folder: '日记', core_tags: ['核心'] };
    const output = await laboratory.call(plugin, args);
    assert.match(output, /四轨实验室/);
    assert.match(output, /RiverMemo 查询诊断/);
    assert.match(output, /confidence/);
    assert.equal(await search.call(plugin, args), 'ordinary search');
});