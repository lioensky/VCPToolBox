'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { cleanRagParams, cleanRiverConfig, LEGACY_TOPOLOGY } =
    require('../modules/knowledgeBase/memoConfig');
const Engine = require('../TagMemoV10Engine');
const River = require('../RiverMemoEngine');

test('retired controls are removed without changing production values', () => {
    const original = {
        RAGDiaryPlugin: { tagTruncationBase: 0.6, tagTruncationRange: [0.5, 0.9], noise_penalty: 0.05 },
        KnowledgeBaseManager: {
            tagMemoVersioning: {}, geodesicRerank: {}, intrinsicResidual: {},
            v9: { algorithmVersion: 'v9.1', outboundMass: 0.95 },
            geometry: { local: { maxBasis: 7 } },
            riverMemo: {
                enabled: false, safety: {}, agentConditioning: {},
                localField: { solver: 'scaled_resolvent', alpha: 0.21 },
                candidateSuperset: { queryK: 87, minimumQuota: { query_knn: 20 } },
                dstc: { topologyV3OmegaGamma: 1.7, topologyV2RoleCaps: {} }
            }
        }
    };
    const cleaned = cleanRagParams(original);
    assert.deepEqual(cleaned.RAGDiaryPlugin, { noise_penalty: 0.05 });
    assert.deepEqual(cleaned.KnowledgeBaseManager, {
        v9: { outboundMass: 0.95 },
        geometry: { local: { maxBasis: 7 } },
        riverMemo: {
            localField: { alpha: 0.21 },
            candidateSuperset: { queryK: 87 },
            topology: { omegaGamma: 1.7 }
        }
    });
    assert.deepEqual(cleanRagParams(cleaned), cleaned);
    assert.equal(original.KnowledgeBaseManager.riverMemo.enabled, false);
});

test('legacy local geometry imports only when AGS configuration is absent', () => {
    const cleaned = cleanRagParams({ KnowledgeBaseManager: {
        intrinsicResidual: { method: 'svd', maxBasis: 6, semanticEnabled: false, v9AnchorScale: 1.4 }
    } });
    assert.deepEqual(cleaned.KnowledgeBaseManager.geometry.local, {
        maxBasis: 6, semanticGate: { enabled: false }, anchorGain: { scale: 1.4 }
    });
    const withCurrent = cleanRagParams({ KnowledgeBaseManager: {
        geometry: { local: { maxBasis: 9 } }, intrinsicResidual: { maxBasis: 2 }
    } });
    assert.equal(withCurrent.KnowledgeBaseManager.geometry.local.maxBasis, 9);
});

test('all legacy live scoring parameters retain their native values', () => {
    const dstc = Object.fromEntries(Object.keys(LEGACY_TOPOLOGY).map((key, index) => [key, (index + 1) / 100]));
    const legacy = cleanRiverConfig({ dstc }, true);
    const runtime = new Engine(null, null, { dimension: 2 }, {
        KnowledgeBaseManager: { riverMemo: { dstc } }
    });
    const effective = runtime.getEffectiveConfig();
    assert.deepEqual(effective, legacy);
    assert.equal(Object.hasOwn(effective, 'dstc'), false);
    assert.equal(Object.hasOwn(effective, 'enabled'), false);
    const river = new River(runtime);
    const native = river._nativeConfig({ effectiveConfig: effective });
    const oldNative = river._nativeConfig({ effectiveConfig: { ...effective, topology: undefined, dstc } });
    assert.deepEqual(native, oldNative);
    for (const [oldKey, key] of Object.entries(LEGACY_TOPOLOGY)) {
        assert.equal(native[key], dstc[oldKey], key);
    }
    assert.equal(cleanRiverConfig({ dstc, topology: { omegaGamma: 0 } }).topology.omegaGamma, 0);
});

test('active configuration is clean and panel edits authoritative AGS settings', () => {
    const active = require('../rag_params.json');
    assert.deepEqual(cleanRagParams(active), active);
    const root = 'AdminPanel-Vue/src/features/rag-tuning/';
    const panel = fs.readFileSync(root + 'TagMemoV9ControlPanel.vue', 'utf8');
    assert.doesNotMatch(panel, /modelValue\.intrinsicResidual|value="centroid"|value="svd"/);
    assert.match(panel, /props\.modelValue\.geometry/);
    assert.match(panel, /global\.candidateMode/);
    const river = fs.readFileSync(root + 'RiverMemoV3ControlPanel.vue', 'utf8');
    assert.doesNotMatch(river, /updateBoolean\('enabled'/);
    const metadata = fs.readFileSync(root + 'metadata.ts', 'utf8');
    assert.doesNotMatch(metadata, /"dstc\.|agentConditioning|minimumQuota|geodesicRerank/);
    assert.match(metadata, /"topology\.omegaGamma"/);
});