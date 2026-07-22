'use strict';

const ARM_NAMES = Object.freeze(['pure', 'gated', 'observed', 'topology']);

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function normalizeWeightGroup(raw, names) {
    const values = Object.fromEntries(names.map(name => [
        name,
        Math.max(0, Number(raw[name]) || 0)
    ]));
    const total = Object.values(values).reduce(
        (sum, value) => sum + value,
        0
    ) || 1;
    return Object.freeze(
        Object.fromEntries(
            Object.entries(values).map(([name, value]) => [
                name,
                value / total
            ])
        )
    );
}

function normalizedWeights(raw = {}) {
    const weights = {
        query: Math.max(0, Number(raw.query) || 0.25),
        local: Math.max(0, Number(raw.local) || 0.2),
        transfer: Math.max(0, Number(raw.transfer) || 0.15),
        path: Math.max(0, Number(raw.path) || 0.25),
        occupancy: Math.max(0, Number(raw.occupancy) || 0.15)
    };
    const total = Object.values(weights).reduce((sum, value) => sum + value, 0) || 1;
    return Object.freeze(
        Object.fromEntries(
            Object.entries(weights).map(([key, value]) => [key, value / total])
        )
    );
}

function buildUnifiedBase(item, options = {}) {
    const curve = item.curve || {};
    const geometry = item.geometry || {};
    const observables = item.observables || {};
    const thematic = observables.thematic || {};
    const weights = normalizedWeights(options.pureWeights);
    const semanticScoreMode = String(
        options.semanticScoreMode || 'positive'
    ).trim().toLowerCase();
    const semanticScore = value => semanticScoreMode === 'shifted'
        ? clamp01(((Number(value) || 0) + 1) / 2)
        : clamp01(Number(value) || 0);
    const components = Object.freeze({
        query: semanticScore(curve.queryScore),
        local: semanticScore(curve.localFieldScore),
        transfer: semanticScore(curve.transferFieldScore),
        path: clamp01(geometry.pathQuality),
        occupancy: clamp01(
            0.35 * (Number(thematic.localCoverage) || 0)
            + 0.25 * (Number(thematic.transferCoverage) || 0)
            + 0.25 * clamp01(thematic.localPotential)
            + 0.15 * clamp01(thematic.transferPotential)
        )
    });
    const pureScoreMode = String(
        options.pureScoreMode || 'topology_limited'
    ).trim().toLowerCase();
    const legacyLinearScore = clamp01(
        weights.query * components.query
        + weights.local * components.local
        + weights.transfer * components.transfer
        + weights.path * components.path
        + weights.occupancy * components.occupancy
    );
    const semanticWeights = normalizeWeightGroup(weights, [
        'query',
        'local',
        'transfer'
    ]);
    const topologyWeights = normalizeWeightGroup(weights, [
        'path',
        'occupancy'
    ]);
    const semanticBase = clamp01(
        semanticWeights.query * components.query
        + semanticWeights.local * components.local
        + semanticWeights.transfer * components.transfer
    );
    const topologyRaw = clamp01(
        topologyWeights.path * components.path
        + topologyWeights.occupancy * components.occupancy
    );
    const topologyPathSaturation = Math.max(
        1e-6,
        Number(options.topologyPathSaturation) || 0.15
    );
    const pathReliability = clamp01(
        components.path / topologyPathSaturation
    );
    const closureReliability = clamp01(
        observables.closure?.queryChunkScore
        ?? observables.values?.closure
        ?? 0
    );
    const topologyReliabilityMode = String(
        options.topologyReliabilityMode || 'path_closure'
    ).trim().toLowerCase();
    const topologyReliability = topologyReliabilityMode === 'path_only'
        ? pathReliability
        : Math.sqrt(pathReliability * closureReliability);
    const topologyBonusCap = clamp01(
        options.topologyBonusCap ?? 0.08
    );
    const topologyBonus = Math.min(
        topologyBonusCap,
        topologyBonusCap * topologyRaw * topologyReliability
    );
    const score = pureScoreMode === 'legacy_linear'
        ? legacyLinearScore
        : clamp01(semanticBase + topologyBonus);
    return Object.freeze({
        score,
        weights,
        components,
        semanticScoreMode,
        pureScoreMode,
        legacyLinearScore,
        semanticWeights,
        topologyWeights,
        semanticBase,
        topologyRaw,
        pathReliability,
        closureReliability,
        topologyReliabilityMode,
        topologyReliability,
        topologyBonusCap,
        topologyBonus
    });
}

function scorePure(item, options = {}) {
    const base = buildUnifiedBase(item, options);
    return Object.freeze({
        arm: 'pure',
        score: base.score,
        baseScore: base.score,
        gateMultiplier: 1,
        observedBonus: 0,
        rejected: false,
        rejectionReasons: Object.freeze([]),
        components: base.components,
        weights: base.weights,
        semanticScoreMode: base.semanticScoreMode,
        pureScoreMode: base.pureScoreMode,
        legacyLinearScore: base.legacyLinearScore,
        semanticBase: base.semanticBase,
        topologyRaw: base.topologyRaw,
        pathReliability: base.pathReliability,
        closureReliability: base.closureReliability,
        topologyReliabilityMode: base.topologyReliabilityMode,
        topologyReliability: base.topologyReliability,
        topologyBonusCap: base.topologyBonusCap,
        topologyBonus: base.topologyBonus,
        marginalContributions: Object.freeze({
            direct: 0,
            structural: 0,
            thematic: 0,
            closure: 0
        })
    });
}

function scoreGated(item, options = {}) {
    const pure = scorePure(item, options);
    const observables = item.observables || {};
    const values = observables.values || {};
    const gated = options.gated || {};
    const reasons = [];
    let multiplier = 1;

    if (observables.direct?.legal === false || observables.direct?.visibilityEligible === false) {
        reasons.push('visibility-denied');
        multiplier = 0;
    }
    const minimumClosure = clamp01(gated.minimumClosure ?? 0);
    if (clamp01(values.closure) < minimumClosure) {
        reasons.push('closure-below-minimum');
        multiplier = 0;
    }
    const maximumTailOnlyRatio = clamp01(gated.maximumTailOnlyRatio ?? 0.8);
    if ((Number(observables.thematic?.tailOnlyRatio) || 0) > maximumTailOnlyRatio) {
        reasons.push('tail-only-risk');
        multiplier *= clamp01(
            1 - (
                (Number(observables.thematic.tailOnlyRatio) || 0)
                - maximumTailOnlyRatio
            )
        );
    }
    const maximumTransferDominance = clamp01(
        gated.maximumTransferDominance ?? 0.8
    );
    const localPotential = Math.max(
        0,
        Number(observables.thematic?.localPotential) || 0
    );
    const transferPotential = Math.max(
        0,
        Number(observables.thematic?.transferPotential) || 0
    );
    const transferDominance = transferPotential / Math.max(
        1e-12,
        localPotential + transferPotential
    );
    if (transferDominance > maximumTransferDominance) {
        reasons.push('transfer-dominance-risk');
        multiplier *= clamp01(
            1 - (transferDominance - maximumTransferDominance)
        );
    }

    multiplier = clamp01(multiplier);
    return Object.freeze({
        ...pure,
        arm: 'gated',
        score: pure.baseScore * multiplier,
        gateMultiplier: multiplier,
        rejected: multiplier === 0,
        rejectionReasons: Object.freeze(reasons),
        gateDiagnostics: Object.freeze({
            minimumClosure,
            maximumTailOnlyRatio,
            maximumTransferDominance,
            transferDominance
        })
    });
}

function scoreObserved(item, options = {}) {
    const pure = scorePure(item, options);
    const values = item.observables?.values || {};
    const cap = clamp01(options.observedRewardCap ?? 0.12);
    const rawWeights = {
        direct: Math.max(0, Number(options.observedWeights?.direct) || 0.3),
        structural: Math.max(0, Number(options.observedWeights?.structural) || 0.25),
        thematic: Math.max(0, Number(options.observedWeights?.thematic) || 0.2),
        closure: Math.max(0, Number(options.observedWeights?.closure) || 0.25)
    };
    const totalWeight = Object.values(rawWeights)
        .reduce((sum, value) => sum + value, 0) || 1;
    const disabled = new Set(
        Array.isArray(options.disabledObservables)
            ? options.disabledObservables.map(value => String(value).toLowerCase())
            : []
    );
    const activeWeighted = {};
    let activeMass = 0;
    for (const [name, weight] of Object.entries(rawWeights)) {
        if (disabled.has(name)) {
            activeWeighted[name] = 0;
            continue;
        }
        activeWeighted[name] = clamp01(values[name]) * weight / totalWeight;
        activeMass += activeWeighted[name];
    }
    const observedBonus = Math.min(
        cap,
        cap * clamp01(activeMass)
    );
    const contributionScale = activeMass > 0
        ? observedBonus / activeMass
        : 0;
    const marginalContributions = Object.freeze(
        Object.fromEntries(
            Object.entries(activeWeighted).map(([name, value]) => [
                name,
                value * contributionScale
            ])
        )
    );

    return Object.freeze({
        ...pure,
        arm: 'observed',
        score: clamp01(pure.baseScore + observedBonus),
        observedBonus,
        observedRewardCap: cap,
        disabledObservables: Object.freeze([...disabled]),
        marginalContributions
    });
}

function scoreTopology(item, options = {}) {
    const pure = scorePure(item, options);
    const components = pure.components;
    const closureReliability = pure.closureReliability;
    const localGain = Math.max(0, components.local - components.query);
    const transferReference = Math.max(components.query, components.local);
    const transferGain = Math.max(0, components.transfer - transferReference);

    const direct = item.observables?.direct || {};
    const boundaryScore = clamp01(direct.semanticBoundaryScore);
    const boundaryGain = Math.max(0, boundaryScore - components.query);
    const localGainCap = clamp01(options.topologyLocalGainCap ?? 0.12);
    const transferGainCap = clamp01(options.topologyTransferGainCap ?? 0.08);
    const boundaryGainCap = clamp01(options.topologyBoundaryGainCap ?? 0.12);
    const pathGainCap = clamp01(options.topologyPathGainCap ?? 0.08);
    // Local 回投影本身就是 Query→Field→Candidate 的连续几何观测。
    // 不能再要求候选离散 Tag 链命中 Local Effective Support，否则严格支持域下
    // 大量真实的 Local 向量增量会被归零，使 Topology 退化成原始 KNN。
    // Query→Chunk Closure 负责确认这段位移确实回到候选正文。
    const localReliability = Math.sqrt(closureReliability);
    const transferReliability = Math.sqrt(
        closureReliability
        * clamp01(item.observables?.thematic?.transferCoverage ?? 0)
        * clamp01(pure.pathReliability)
    );
    const boundaryReliability = Math.sqrt(
        closureReliability
        * clamp01(
            0.8 + 0.2 * (Number(direct.semanticBoundarySaturation) || 0)
        )
    );
    const localGainAward = Math.min(
        localGainCap,
        localGain * localReliability
    );
    const transferGainAward = Math.min(
        transferGainCap,
        transferGain * transferReliability
    );
    const boundaryGainAward = Math.min(
        boundaryGainCap,
        boundaryGain * boundaryReliability
    );
    const pathGainAward = Math.min(
        pathGainCap,
        pathGainCap * pure.topologyRaw * pure.topologyReliability
    );
    const legacyRelativeScore = clamp01(
        components.query
        + localGainAward
        + transferGainAward
        + boundaryGainAward
        + pathGainAward
    );

    const topologyScoreMode = String(
        options.topologyScoreMode || 'relative_graph_dual_readout'
    ).trim().toLowerCase();
    const graph = item.relativeTopology || {};
    const fieldMode = String(
        options.topologyFieldScore || 'denoised'
    ).trim().toLowerCase();
    const denoisedScore = clamp01(
        item.curve?.denoisedFieldScore
        ?? item.curve?.v9DenoisedScore
        ?? components.local
    );
    const fieldScore = fieldMode === 'query'
        ? components.query
        : fieldMode === 'local'
            ? components.local
            : fieldMode === 'transfer'
                ? components.transfer
                : denoisedScore;
    const graphScore = clamp01(graph.score);
    const graphReliability = clamp01(graph.reliability);
    const graphWeightMaximum = clamp01(
        options.topologyGraphWeightMax ?? 0.55
    );
    const graphWeightFloor = Math.min(
        graphWeightMaximum,
        clamp01(options.topologyGraphWeightFloor ?? 0)
    );
    const graphWeight = graphScore > 0
        ? graphWeightFloor
            + (graphWeightMaximum - graphWeightFloor)
                * graphReliability
        : 0;
    const dualReadoutScore = clamp01(
        (1 - graphWeight) * fieldScore
        + graphWeight * graphScore
    );
    const score = topologyScoreMode === 'legacy_relative_bonus'
        ? legacyRelativeScore
        : dualReadoutScore;

    return Object.freeze({
        ...pure,
        arm: 'topology',
        score,
        baseScore: fieldScore,
        topologyScoreMode,
        topologyDualReadout: Object.freeze({
            fieldMode,
            fieldScore,
            denoisedScore,
            graphScore,
            graphReliability,
            graphReliabilityMode: graph.reliabilityMode || 'unavailable',
            graphEdgeReliability: clamp01(graph.edgeReliability),
            graphNodeOnlyReliability: clamp01(
                graph.nodeOnlyReliability
            ),
            graphNodeOnlyReliabilityCap: clamp01(
                graph.nodeOnlyReliabilityCap
            ),
            graphWeight,
            graphWeightFloor,
            graphWeightMaximum,
            dualReadoutScore,
            legacyRelativeScore,
            matchedNodeCoverage:
                clamp01(graph.matchedNodeCoverage),
            matchedEdgeCoverage:
                clamp01(graph.matchedEdgeCoverage),
            nodeAlignmentScore:
                clamp01(graph.nodeAlignmentScore),
            edgeGraphScore: clamp01(graph.edgeGraphScore),
            nodeGraphScore: clamp01(graph.nodeGraphScore),
            relativeDistanceScore:
                clamp01(graph.relativeDistanceScore),
            directionScore: clamp01(graph.directionScore),
            edgeTopologyScore:
                clamp01(graph.edgeTopologyScore),
            motifScore: clamp01(graph.motifScore),
            meanClosure: clamp01(graph.meanClosure),
            matchedNodes: Number(graph.matchedNodes) || 0,
            matchedEdges: Number(graph.matchedEdges) || 0,
            reason: graph.reason || null
        }),
        topologyRelativeGeometry: Object.freeze({
            queryBase: components.query,
            localScore: components.local,
            transferScore: components.transfer,
            localGain,
            transferReference,
            transferGain,
            localReliability,
            transferReliability,
            closureReliability,
            pathReliability: pure.pathReliability,
            boundaryScore,
            boundaryGain,
            boundaryReliability,
            strongestBoundary: direct.strongestBoundary || null,
            secondBoundary: direct.secondBoundary || null,
            boundaryHits: Number(direct.semanticBoundaryHits) || 0,
            boundarySaturation: clamp01(
                direct.semanticBoundarySaturation
            ),
            localGainCap,
            transferGainCap,
            boundaryGainCap,
            pathGainCap,
            localGainAward,
            transferGainAward,
            boundaryGainAward,
            pathGainAward,
            totalGeometryGain: localGainAward
                + transferGainAward
                + boundaryGainAward
                + pathGainAward
        })
    });
}

const ARM_SCORERS = Object.freeze({
    pure: scorePure,
    gated: scoreGated,
    observed: scoreObserved,
    topology: scoreTopology
});

function scoreExperimentArm(dstcBatch, arm = 'pure', options = {}) {
    const normalizedArm = String(arm || 'pure').toLowerCase();
    const scorer = ARM_SCORERS[normalizedArm];
    if (!scorer) {
        throw new RangeError(
            `Unknown V10 experiment arm "${arm}"; expected ${ARM_NAMES.join(', ')}`
        );
    }

    const scored = (Array.isArray(dstcBatch?.results) ? dstcBatch.results : [])
        .map((item, originalIndex) => Object.freeze({
            ...item,
            armResult: scorer(item, options),
            originalIndex
        }))
        .sort((left, right) =>
            (right.armResult.score - left.armResult.score)
            || (
                (right.curve?.candidateUnionScore || 0)
                - (left.curve?.candidateUnionScore || 0)
            )
            || (left.originalIndex - right.originalIndex)
        );

    return Object.freeze({
        schema: 'tagmemo-v10-alpha-experiment-arm-v1',
        arm: normalizedArm,
        results: Object.freeze(scored),
        diagnostics: Object.freeze({
            candidates: scored.length,
            rejected: scored.filter(item => item.armResult.rejected).length,
            totalObservedBonus: scored.reduce(
                (sum, item) => sum + item.armResult.observedBonus,
                0
            ),
            disabledObservables: Object.freeze(
                Array.isArray(options.disabledObservables)
                    ? options.disabledObservables.slice()
                    : []
            )
        })
    });
}

function runExperimentArms(dstcBatch, options = {}) {
    const arms = Array.isArray(options.arms) && options.arms.length > 0
        ? options.arms
        : ARM_NAMES;
    const output = {};
    for (const arm of arms) {
        const normalized = String(arm).toLowerCase();
        output[normalized] = scoreExperimentArm(
            dstcBatch,
            normalized,
            options
        );
    }
    return Object.freeze({
        schema: 'tagmemo-v10-alpha-experiment-arms-v1',
        candidateCount: Array.isArray(dstcBatch?.results)
            ? dstcBatch.results.length
            : 0,
        arms: Object.freeze(output)
    });
}

module.exports = {
    ARM_NAMES,
    buildUnifiedBase,
    scorePure,
    scoreGated,
    scoreObserved,
    scoreTopology,
    scoreExperimentArm,
    runExperimentArms
};