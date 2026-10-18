'use strict';

// The production RiverMemo contract. Fixed algorithms and retired laboratory
// switches are deliberately absent: retaining them would imply working controls.
const RIVER_DEFAULTS = {
    sourceObservation: { baseTagBoost: 0.6, coreBoostFactor: 1.33 },
    localField: { alpha: 0.15, maxIterations: 80, tolerance: 1e-9 },
    transferField: { alpha: 0.55, maxIterations: 80, tolerance: 1e-9 },
    effectiveSupport: { localMassRatio: 0.8, transferMassRatio: 0.9 },
    candidateSuperset: {
        queryK: 100, denoisedK: 100, localFieldK: 100,
        transferFieldK: 100, bm25K: 50, anchorK: 50, maxUnionCandidates: 300
    },
    pathGeometry: { localWeight: 0.6, transferWeight: 0.4, directionFloor: 0.05, closureFloor: 0 },
    relativeTopology: {
        semanticNodeThreshold: 0.48, relativeDistanceTemperature: 0.35,
        reverseDirectionCredit: 0.25, nodeOnlyReliabilityCap: 0.2,
        minimumRiverEdgeFlow: 0.015, maximumRiverEdges: 96
    },
    riverObservability: {
        kappaEdge: 0.5, kappaRatio: 0.3, epsilon: 0.02,
        collapsedThreshold: 0.12, sparseThreshold: 0.45
    },
    directAnchor: {
        semanticThreshold: 0.8, semanticDiscount: 0.7, specificityFloor: 0.35,
        rarityFloor: 0.15, reliabilitySeedSaturation: 2, fallbackReliabilityCap: 0.5
    },
    topology: {
        topologyBonusCap: 0.08, topologyPathSaturation: 0.15,
        innovationScale: 0.5, conditionalBandwidth: 0.04,
        conditionalClosureBandwidth: 0.1, conditionalDirectBandwidth: 0.12,
        minimumPeers: 3, minimumEffectivePeers: 2.5, innovationConfidenceZ: 1,
        omegaGamma: 1, structRoleMinOmega: 0.12,
        anchorBonusCap: 0.1, anchorActivationZ: 2, anchorActivationFloor: 0.05,
        anchorSaturation: 0.2, anchorFrontierContrast: 2, anchorFrontierAbsFloor: 0.1
    }
};

const LEGACY_TOPOLOGY = {
    topologyBonusCap: 'topologyBonusCap',
    topologyPathSaturation: 'topologyPathSaturation',
    topologyV2InnovationScale: 'innovationScale',
    topologyV2ConditionalBandwidth: 'conditionalBandwidth',
    topologyV2ClosureBandwidth: 'conditionalClosureBandwidth',
    topologyV2DirectBandwidth: 'conditionalDirectBandwidth',
    topologyV2MinimumPeers: 'minimumPeers',
    topologyV2MinimumEffectivePeers: 'minimumEffectivePeers',
    topologyV2InnovationConfidenceZ: 'innovationConfidenceZ',
    topologyV3OmegaGamma: 'omegaGamma',
    topologyV3StructRoleMinOmega: 'structRoleMinOmega',
    topologyV3AnchorBonusCap: 'anchorBonusCap',
    topologyV3AnchorActivationZ: 'anchorActivationZ',
    topologyV3AnchorActivationFloor: 'anchorActivationFloor',
    topologyV3AnchorSaturation: 'anchorSaturation',
    topologyV3AnchorFrontierContrast: 'anchorFrontierContrast',
    topologyV3AnchorFrontierAbsFloor: 'anchorFrontierAbsFloor'
};

const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function cleanRiverConfig(value = {}, withDefaults = false) {
    const source = record(value);
    const migrated = {};
    for (const [oldKey, key] of Object.entries(LEGACY_TOPOLOGY)) {
        if (Object.hasOwn(record(source.dstc), oldKey)) migrated[key] = source.dstc[oldKey];
    }
    const output = {};
    for (const [section, defaults] of Object.entries(RIVER_DEFAULTS)) {
        const configured = section === 'topology'
            ? { ...migrated, ...record(source.topology) } : record(source[section]);
        const fields = withDefaults ? { ...defaults } : {};
        for (const key of Object.keys(defaults)) {
            if (Object.hasOwn(configured, key)) fields[key] = configured[key];
        }
        if (Object.keys(fields).length) output[section] = fields;
    }
    return output;
}

function cleanRagParams(value) {
    const output = JSON.parse(JSON.stringify(value));
    const kb = record(output.KnowledgeBaseManager);
    if (output.KnowledgeBaseManager) {
        for (const key of ['tagMemoVersioning', 'geodesicRerank', 'potentialFieldRerank', 'tagMemoV10Alpha']) {
            delete kb[key];
        }
        // Import local settings from old presets only when no AGS config exists.
        if (!kb.geometry && kb.intrinsicResidual) {
            const old = record(kb.intrinsicResidual);
            const local = {};
            for (const key of ['maxNeighbors', 'minNeighbors', 'maxBasis', 'minGain', 'positionDecay']) {
                if (Object.hasOwn(old, key)) local[key] = old[key];
            }
            const semanticGate = {};
            for (const [key, oldKey] of Object.entries({
                enabled: 'semanticEnabled', peak: 'semanticPeak', sigma: 'semanticSigma',
                floor: 'semanticFloor', hardFloor: 'semanticHardFloor'
            })) {
                if (Object.hasOwn(old, oldKey)) semanticGate[key] = old[oldKey];
            }
            const anchorGain = {};
            for (const key of ['base', 'scale', 'gamma', 'min', 'max']) {
                const oldKey = `v9Anchor${key[0].toUpperCase()}${key.slice(1)}`;
                if (Object.hasOwn(old, oldKey)) anchorGain[key] = old[oldKey];
            }
            kb.geometry = { local: { ...local, semanticGate, anchorGain } };
        }
        delete kb.intrinsicResidual;
        if (kb.v9) delete kb.v9.algorithmVersion;
        if (kb.riverMemo) kb.riverMemo = cleanRiverConfig(kb.riverMemo);
    }
    if (output.RAGDiaryPlugin) {
        delete output.RAGDiaryPlugin.tagTruncationBase;
        delete output.RAGDiaryPlugin.tagTruncationRange;
    }
    return output;
}

module.exports = { cleanRagParams, cleanRiverConfig, LEGACY_TOPOLOGY };