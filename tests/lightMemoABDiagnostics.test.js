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

test('2.4 diagnostics exposes out-of-top-k candidates and intent route ledger', () => {
    const data = response();
    data.river.candidateDiagnostics = [{
        ...data.river.results[0], id: 10640, chunkId: 10640,
        topologyV3: { intentReadout: {
            available: true, satisfaction: 0.6, directSatisfaction: 0.3, wormholeLift: 0.3,
            ledger: [{ seedIds: [1], weight: 1, residualEnergy: 0.8,
                directSupport: 0.3, wormholeSupport: 0.6, satisfaction: 0.6,
                routeSource: 1, routeTarget: 2 }]
        } }
    }];
    const output = formatDiagnostics({ _escapeMarkdownCell: cell }, request, data);
    for (const text of ['10640', '意图账本', '虫洞提升 0.3000',
        '核心\\|标签 → 传播', '包含 Top-K 之外']) {
        assert.ok(output.includes(text), text);
    }
});

test('source endpoint diagnostics explains shared accounting and contiguous ledger tables', () => {
    const data = response();
    data.river.algorithmVersion = 'rivermemo.source-endpoint-v2.4.1';
    data.river.results[0].topologyV3.intentReadout = {
        available: true, satisfaction: 0.5, directSatisfaction: 0.2, wormholeLift: 0.3,
        ledger: [{ seedIds: [1], weight: 1, residualEnergy: 0.8, queryExplanation: 0.4,
            directSupport: 0.2, wormholeSupport: 0.5, satisfaction: 0.5,
            routeSource: 1, routeTarget: 2, routeCurrent: 0.8,
            endpointGrounding: 0.625, routeIsWormhole: true }]
    };
    const output = formatDiagnostics({ _escapeMarkdownCell: cell }, request, data);
    for (const text of ['共享单一预算', '传播边际提升 0.3000', '查询独立解释量',
        '电流校准', '终点落地', '0.6250']) assert.ok(output.includes(text), text);
    assert.match(output, /\|---:\|---\|[^\n]+\n\| 11 \|/);
});

test('wormhole readout exposes independent score and honest approximate address outside top-k', () => {
    const data = response();
    data.river.algorithmVersion = 'rivermemo.wormhole-readout-v2.5';
    data.river.candidateDiagnostics = [{
        id: 10640, rank: 2, score: 0.5375, role: 'wormhole_endpoint',
        topologyV3: { queryScore: 0.5547, wormholeReadout: {
            available: true, sourceId: 1, targetId: 2, flow: 0.1076,
            relativeFlow: 1, endpointBodyCosine: 0.5375,
            exactTargetTag: false, edgeSourceFile: false,
            location: 'semantic-body-approximation'
        } }
    }];
    const output = formatDiagnostics({ _escapeMarkdownCell: cell }, request, data);
    for (const text of ['独立虫洞通道', '不是原查询底分加奖励', '10640',
        '0.5375', '0.5547', 'semantic-body-approximation', '核心\\|标签 → 传播',
        '文件级地址诊断', '包含 Top-K 之外']) assert.ok(output.includes(text), text);
    assert.ok(!output.includes('意图账本'));
    assert.ok(!output.includes('共享单一预算'));
});

test('auxiliary wormholes retain topology explanation and expose additive accounting', () => {
    const data = response();
    data.river.algorithmVersion = 'rivermemo.conservative-topology-v2.5fix-test2';
    data.river.parameters.wormholeScoring = 'auxiliary-only; existing topology budget; Omega gated';
    data.river.results[0].topologyV3.wormholeAuxiliary = {
        originalFinalScore: 0.68, originalGraphBonus: 0.01,
        addedGraphBonus: 0.02, addedFinalScore: 0.02,
        readout: { available: true, sourceId: 1, targetId: 2 }
    };
    const output = formatDiagnostics({ _escapeMarkdownCell: cell }, request, data);
    for (const text of ['保留原拓扑与 Ω 门控', '原最终分', '0.6800', '0.0200',
        '勿重复累加场共振', 'matchedEdgeCoverage', 'pathQuality']) {
        assert.ok(output.includes(text), text);
    }
    assert.ok(!output.includes('独立虫洞通道'));
    assert.ok(!output.includes('回退查询余弦'));
});

test('confidence RRF exposes baseline rank, explanation weight and separate fusion score', () => {
    const data = response();
    data.river.algorithmVersion = 'rivermemo.conservative-topology-v2.5-confidence-rrf';
    data.river.parameters.wormholeScoring = 'explanation-weighted-RRF';
    data.river.results[0].topologyV3.wormholeRrf = {
        active: true, baselineRank: 24, baselineScore: 0.5344,
        baselineContribution: 1 / 84, wormholeContribution: 0.0587,
        winner: { weight: 3.58, routeRank: 1, sourceId: 1, targetId: 2 }
    };
    const output = formatDiagnostics({ _escapeMarkdownCell: cell }, request, data);
    for (const text of ['解释力度 RRF', '原排名', '0.5344', '3.58',
        '不是下方原评分分项之和', 'matchedEdgeCoverage']) {
        assert.ok(output.includes(text), text);
    }
    assert.ok(!output.includes('虫洞辅助加权（保留原拓扑'));
});