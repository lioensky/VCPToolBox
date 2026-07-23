'use strict';

const {
    computeRiverObservability
} = require('./riverObservability');

const ARM_NAMES = Object.freeze([
    'pure',
    'gated',
    'observed',
    'topology',
    'topology_v2',
    'topology_v3'
]);

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function smoothstep01(value) {
    const normalized = clamp01(value);
    return normalized * normalized * (3 - 2 * normalized);
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

/**
 * 识别当前查询对离散结构的预期形态。原子概念天然可以只有节点而没有边，
 * 命题与叙事查询才逐级要求关系边、方向和 Motif，避免“边少即低可信”。
 */
function classifyTopologyV2Query(dstcBatch, options = {}) {
    const queryState = options.queryState || {};
    const text = String(queryState.query?.text || options.queryText || '').trim();
    const river = queryState.queryRiverGraph || {};
    const nodes = Array.isArray(river.nodes) ? river.nodes : [];
    const edges = Array.isArray(river.edges) ? river.edges : [];
    const diagnostics = river.diagnostics || {};
    const relationMatches = text.match(
        /导致|造成|因为|所以|通过|依赖|属于|定义|源于|来自|用于|影响|支持|反对|转化|蒸馏|击败|损失|赔款|前提|机制|关系|→|->/g
    ) || [];
    const narrativeMatches = text.match(
        /随后|之后|此前|最终|阶段|过程|历史|战争|事件|先是|然后|同时|但是|然而|结果|演变/g
    ) || [];
    const clauseCount = text
        ? text.split(/[，,。；;！？!?\n]+/).filter(Boolean).length
        : 0;

    let mode = 'propositional';
    if (
        text.length <= 28
        && clauseCount <= 1
        && relationMatches.length === 0
    ) {
        mode = 'atomic';
    } else if (
        text.length >= 90
        || clauseCount >= 4
        || narrativeMatches.length >= 2
        || relationMatches.length >= 3
    ) {
        mode = 'narrative';
    }

    const seedNodes = Math.max(
        0,
        Number(diagnostics.seedNodes)
        || nodes.filter(node =>
            String(node.sourceType || node.provenance || '')
                .toLowerCase()
                .includes('seed')
        ).length
    );
    const nonSeedRatio = nodes.length > 0
        ? clamp01((nodes.length - seedNodes) / nodes.length)
        : 0;
    const completeObservation =
        queryState.sourceObservation?.diagnostics?.completeObservation === true;

    // 场相干性描述“第一步感应是否已经形成统一逻辑核”。它与边数量正交：
    // 私有原子概念可以没有传播边，却拥有高集中 Seed 场、高 EPA 逻辑深度
    // 和高 Pyramid coherence；这正是全库零样本仍可可靠寻源的情况。
    const positiveEnergies = nodes
        .map(node => Math.max(
            0,
            Number(node.energy ?? node.normalizedEnergy) || 0
        ))
        .filter(value => value > 0);
    const totalEnergy = positiveEnergies.reduce(
        (sum, value) => sum + value,
        0
    );
    let energyEntropy = 0;
    if (totalEnergy > 0) {
        for (const energy of positiveEnergies) {
            const probability = energy / totalEnergy;
            energyEntropy -= probability * Math.log(probability);
        }
    }
    const normalizedEnergyEntropy = positiveEnergies.length > 1
        ? clamp01(energyEntropy / Math.log(positiveEnergies.length))
        : 0;
    const energyConcentration = clamp01(1 - normalizedEnergyEntropy);
    const epaLogicDepth = clamp01(
        queryState.sourceObservation?.epa?.logicDepth
    );
    const pyramidCoherence = clamp01(
        queryState.sourceObservation?.pyramid?.coherence
    );
    const fieldCoherence = clamp01(
        0.4 * energyConcentration
        + 0.3 * epaLogicDepth
        + 0.3 * pyramidCoherence
    );

    // 当前候选池是“查询 × 知识域”的实际探针。地缘政治完整河网会表现为
    // 大量边级可观测对应；小克式跨学科离散河道会在这里诚实降置信；
    // 原子概念则读取节点对应与正文闭合，不要求虚构关系边。
    const batchItems = Array.isArray(dstcBatch?.results)
        ? dstcBatch.results
        : [];
    const observabilityValues = batchItems.map(item => {
        const graph = item.relativeTopology || {};
        const closure = clamp01(
            item.observables?.closure?.queryChunkScore
            ?? item.observables?.values?.closure
        );
        if (mode === 'atomic') {
            return Math.cbrt(
                clamp01(graph.matchedNodeCoverage)
                * clamp01(graph.nodeAlignmentScore)
                * closure
            );
        }
        return Math.pow(
            clamp01(graph.matchedEdgeCoverage)
            * clamp01(graph.edgeReliability)
            * clamp01(graph.meanClosure ?? closure),
            1 / 3
        );
    });
    const observableValues = observabilityValues
        .filter(value => value > 0)
        .sort((left, right) => right - left);
    // 用头部有效候选而非全池均值衡量“该域是否存在完整河道”，避免大量
    // 正常负例把少量但高度统一的零样本逻辑链稀释掉。
    const observabilityHeadK = Math.max(
        1,
        Math.min(
            observableValues.length,
            Math.ceil(Math.sqrt(Math.max(1, batchItems.length)))
        )
    );
    const domainObservability = observabilityHeadK > 0
        ? clamp01(
            observableValues.slice(0, observabilityHeadK).reduce(
                (sum, value) => sum + value,
                0
            ) / observabilityHeadK
        )
        : 0;

    const expected = mode === 'atomic'
        ? { nodes: 2, edges: 0, nonSeedRatio: 0 }
        : mode === 'narrative'
            ? { nodes: 8, edges: 4, nonSeedRatio: 0.2 }
            : { nodes: 4, edges: 2, nonSeedRatio: 0.1 };
    const nodeAdequacy = clamp01(nodes.length / expected.nodes);
    const edgeAdequacy = expected.edges === 0
        ? 1
        : clamp01(edges.length / expected.edges);
    const emergenceAdequacy = expected.nonSeedRatio === 0
        ? 1
        : clamp01(nonSeedRatio / expected.nonSeedRatio);
    const structuralAdequacy = mode === 'atomic'
        ? nodeAdequacy
        : mode === 'narrative'
            ? 0.25 * nodeAdequacy
                + 0.55 * edgeAdequacy
                + 0.2 * emergenceAdequacy
            : 0.35 * nodeAdequacy
                + 0.5 * edgeAdequacy
                + 0.15 * emergenceAdequacy;
    const dynamicAdequacy = mode === 'atomic'
        ? clamp01(
            0.35 * structuralAdequacy
            + 0.35 * fieldCoherence
            + 0.3 * domainObservability
        )
        : mode === 'narrative'
            ? clamp01(
                0.35 * structuralAdequacy
                + 0.15 * fieldCoherence
                + 0.5 * domainObservability
            )
            : clamp01(
                0.3 * structuralAdequacy
                + 0.2 * fieldCoherence
                + 0.5 * domainObservability
            );
    const observationFactor = completeObservation ? 1 : 0.5;
    const confidenceFloor = clamp01(
        options.topologyV2QueryConfidenceFloor ?? 0.2
    );
    const confidence = clamp01(
        observationFactor
        * (
            confidenceFloor
            + (1 - confidenceFloor) * dynamicAdequacy
        )
    );

    return Object.freeze({
        mode,
        confidence,
        textLength: text.length,
        clauseCount,
        relationSignals: relationMatches.length,
        narrativeSignals: narrativeMatches.length,
        nodes: nodes.length,
        edges: edges.length,
        seedNodes,
        nonSeedRatio,
        nodeAdequacy,
        edgeAdequacy,
        emergenceAdequacy,
        structuralAdequacy,
        dynamicAdequacy,
        energyConcentration,
        normalizedEnergyEntropy,
        epaLogicDepth,
        pyramidCoherence,
        fieldCoherence,
        domainObservability,
        observabilityHeadK,
        completeObservation,
        expected: Object.freeze(expected)
    });
}

function buildTopologyV2BatchContext(dstcBatch, options = {}) {
    const items = Array.isArray(dstcBatch?.results) ? dstcBatch.results : [];
    const queryProfile = classifyTopologyV2Query(dstcBatch, options);
    const samples = items.map((item, index) => {
        const pure = scorePure(item, options);
        const graph = item.relativeTopology || {};
        const direct = item.observables?.direct || {};
        const closure = clamp01(
            item.observables?.closure?.queryChunkScore
            ?? pure.closureReliability
        );
        const directEvidence = clamp01(Math.max(
            direct.semanticBoundaryScore,
            item.observables?.values?.direct
        ));
        const nodeScore = clamp01(
            graph.nodeGraphScore
            ?? graph.nodeAlignmentScore
            ?? graph.score
        );
        const edgeScore = clamp01(
            graph.edgeGraphScore
            ?? graph.edgeTopologyScore
            ?? 0
        );
        const graphScore = queryProfile.mode === 'atomic'
            ? clamp01(0.75 * nodeScore + 0.25 * edgeScore)
            : queryProfile.mode === 'narrative'
                ? clamp01(0.15 * nodeScore + 0.85 * edgeScore)
                : clamp01(0.25 * nodeScore + 0.75 * edgeScore);
        return {
            index,
            item,
            pure,
            graph,
            closure,
            directEvidence,
            graphScore,
            nodeScore,
            edgeScore
        };
    });
    const maximumPure = Math.max(0, ...samples.map(sample => sample.pure.score));
    const directThreshold = clamp01(
        options.topologyV2DirectEvidenceThreshold ?? 0.55
    );
    const directFrontierMargin = clamp01(
        options.topologyV2DirectFrontierMargin ?? 0.03
    );

    for (const sample of samples) {
        const nearPureFrontier =
            sample.pure.score >= maximumPure - directFrontierMargin;
        const directAnswer = queryProfile.mode !== 'atomic'
            && sample.closure >= 0.55
            && (
                sample.directEvidence >= directThreshold
                || (
                    nearPureFrontier
                    && sample.pure.components.query >= 0.55
                )
            );
        const structuralEvidence = Math.cbrt(
            clamp01(sample.graph.matchedEdgeCoverage)
            * clamp01(sample.graph.edgeReliability)
            * sample.closure
        );
        sample.role = queryProfile.mode === 'atomic'
            ? 'atomic_concept'
            : directAnswer
                ? 'direct_answer'
                : structuralEvidence >= 0.35
                    ? 'structural_explanation'
                    : 'thematic_neighbor';
        sample.structuralEvidence = structuralEvidence;
    }

    const directFrontierScore = Math.max(
        0,
        ...samples
            .filter(sample => sample.role === 'direct_answer')
            .map(sample => sample.pure.score)
    );
    const bandwidth = Math.max(
        1e-4,
        Number(options.topologyV2ConditionalBandwidth) || 0.04
    );
    const closureBandwidth = Math.max(
        1e-4,
        Number(options.topologyV2ClosureBandwidth) || 0.1
    );
    const directBandwidth = Math.max(
        1e-4,
        Number(options.topologyV2DirectBandwidth) || 0.12
    );
    const minimumPeers = Math.max(
        1,
        Math.floor(Number(options.topologyV2MinimumPeers) || 3)
    );
    const minimumEffectivePeers = Math.max(
        1,
        Number(options.topologyV2MinimumEffectivePeers) || 2.5
    );
    const confidenceZ = Math.max(
        0,
        Number(options.topologyV2InnovationConfidenceZ) || 1
    );

    for (const sample of samples) {
        const neighbors = samples
            .filter(peer => peer.index !== sample.index)
            .map(peer => {
                const pureDelta = (
                    peer.pure.score - sample.pure.score
                ) / bandwidth;
                const closureDelta = (
                    peer.closure - sample.closure
                ) / closureBandwidth;
                const directDelta = (
                    peer.directEvidence - sample.directEvidence
                ) / directBandwidth;
                const roleWeight = peer.role === sample.role ? 1 : 0.35;
                return {
                    peer,
                    weight: roleWeight * Math.exp(
                        -0.5 * (
                            pureDelta * pureDelta
                            + closureDelta * closureDelta
                            + directDelta * directDelta
                        )
                    )
                };
            })
            .sort((left, right) =>
                (right.weight - left.weight)
                || (left.peer.index - right.peer.index)
            );
        const selected = neighbors.filter(entry => entry.weight >= 1e-4);
        if (selected.length < minimumPeers) {
            for (const entry of neighbors.slice(0, minimumPeers)) {
                if (!selected.includes(entry)) selected.push(entry);
            }
        }
        const totalWeight = selected.reduce(
            (sum, entry) => sum + entry.weight,
            0
        );
        const squaredWeightMass = selected.reduce(
            (sum, entry) => sum + entry.weight * entry.weight,
            0
        );
        const expected = totalWeight > 1e-12
            ? selected.reduce(
                (sum, entry) =>
                    sum + entry.weight * entry.peer.graphScore,
                0
            ) / totalWeight
            : sample.graphScore;
        const variance = totalWeight > 1e-12
            ? selected.reduce(
                (sum, entry) => sum + entry.weight
                    * Math.pow(entry.peer.graphScore - expected, 2),
                0
            ) / totalWeight
            : 0;
        const effectivePeerCount = squaredWeightMass > 1e-12
            ? totalWeight * totalWeight / squaredWeightMass
            : 0;
        const predictionUncertainty = Math.sqrt(
            Math.max(0, variance)
            * (1 + 1 / Math.max(1, effectivePeerCount))
        );

        sample.conditionalExpectedGraph = expected;
        sample.conditionalVariance = variance;
        sample.conditionalStdDev = Math.sqrt(Math.max(0, variance));
        sample.conditionalPredictionUncertainty = predictionUncertainty;
        sample.conditionalEffectivePeerCount = effectivePeerCount;
        sample.conditionalSampleReliability = clamp01(
            effectivePeerCount / minimumEffectivePeers
        );
        sample.conditionalInnovationLowerBound =
            sample.graphScore - expected - confidenceZ * predictionUncertainty;
        sample.conditionalPeerCount = selected.length;
        sample.conditionalWeightMass = totalWeight;
    }

    return Object.freeze({
        queryProfile,
        bandwidth,
        closureBandwidth,
        directBandwidth,
        minimumPeers,
        minimumEffectivePeers,
        confidenceZ,
        maximumPure,
        directFrontierScore,
        directFrontierMargin,
        samples: Object.freeze(samples.map(Object.freeze))
    });
}

function scoreTopologyV2(item, options = {}, batchContext = null, index = 0) {
    const context = batchContext
        || buildTopologyV2BatchContext({ results: [item] }, options);
    const sample = context.samples[index] || context.samples[0];
    const pure = sample?.pure || scorePure(item, options);
    const graph = sample?.graph || item.relativeTopology || {};
    const queryProfile = context.queryProfile;
    const closure = clamp01(sample?.closure);
    const nodeCoverage = clamp01(graph.matchedNodeCoverage);
    const edgeCoverage = clamp01(graph.matchedEdgeCoverage);
    const nodeAlignment = clamp01(graph.nodeAlignmentScore);
    const edgeReliability = clamp01(graph.edgeReliability);
    const nodeReliability = clamp01(
        graph.nodeOnlyReliability
        ?? graph.reliability
    );
    const candidateConfidence = queryProfile.mode === 'atomic'
        ? Math.sqrt(
            closure
            * clamp01(0.55 * nodeCoverage + 0.45 * nodeAlignment)
        )
        : queryProfile.mode === 'narrative'
            ? Math.pow(
                closure
                * edgeCoverage
                * clamp01(0.65 * edgeReliability + 0.35 * nodeAlignment),
                1 / 3
            )
            : Math.pow(
                closure
                * clamp01(0.75 * edgeCoverage + 0.25 * nodeCoverage)
                * clamp01(0.7 * edgeReliability + 0.3 * nodeAlignment),
                1 / 3
            );
    const statisticalReliability = clamp01(
        sample?.conditionalSampleReliability
    );
    const combinedConfidence = clamp01(
        queryProfile.confidence
        * candidateConfidence
        * statisticalReliability
    );
    const graphScore = clamp01(sample?.graphScore);
    const conditionalExpectedGraph = clamp01(
        sample?.conditionalExpectedGraph
    );
    const graphInnovationRaw = graphScore - conditionalExpectedGraph;
    const graphInnovationLowerBound = Number(
        sample?.conditionalInnovationLowerBound
    ) || 0;
    const graphInnovationPositive = Math.max(
        0,
        graphInnovationLowerBound
    );
    const globalBonusCap = clamp01(options.topologyV2BonusCap ?? 0.08);
    const role = sample?.role || 'thematic_neighbor';
    const roleCapDefaults = {
        atomic_concept: globalBonusCap,
        direct_answer: 0.02,
        structural_explanation: 0.045,
        thematic_neighbor: 0.008
    };
    const configuredRoleCap = options.topologyV2RoleCaps?.[role];
    const roleBonusCap = Math.min(
        globalBonusCap,
        clamp01(configuredRoleCap ?? roleCapDefaults[role] ?? 0)
    );
    const roleMultiplierDefaults = {
        atomic_concept: 1,
        direct_answer: 0.35,
        structural_explanation: 0.7,
        thematic_neighbor: 0.15
    };
    const roleMultiplier = clamp01(
        options.topologyV2RoleMultipliers?.[role]
        ?? roleMultiplierDefaults[role]
        ?? 0
    );
    const innovationScale = Math.max(
        0,
        Number(options.topologyV2InnovationScale) || 0.5
    );
    const requestedBonus = graphInnovationPositive
        * combinedConfidence
        * innovationScale
        * roleMultiplier;
    const confidenceLimitedBonus = Math.min(
        roleBonusCap,
        requestedBonus
    );

    // 非直接答案不得仅凭宏观结构创新越过当前直接答案前沿。
    // 这不是给 Direct 固定奖金，而是保护已经由连续场与正文闭合共同确认的答案。
    const frontierProtectionMargin = clamp01(
        options.topologyV2FrontierProtectionMargin ?? 0.005
    );
    const frontierBonusBudget =
        context.directFrontierScore > 0
        && role !== 'direct_answer'
        && queryProfile.mode !== 'atomic'
            ? Math.max(
                0,
                context.directFrontierScore
                    - frontierProtectionMargin
                    - pure.score
            )
            : Infinity;
    const bonus = Math.min(
        confidenceLimitedBonus,
        frontierBonusBudget
    );
    const score = clamp01(pure.score + bonus);

    return Object.freeze({
        ...pure,
        arm: 'topology_v2',
        score,
        baseScore: pure.score,
        topologyV2: Object.freeze({
            mode: 'role_aware_conservative_innovation',
            queryMode: queryProfile.mode,
            queryConfidence: queryProfile.confidence,
            queryProfile,
            role,
            directEvidence: clamp01(sample?.directEvidence),
            structuralEvidence: clamp01(sample?.structuralEvidence),
            candidateConfidence,
            statisticalReliability,
            combinedConfidence,
            graphScore,
            graphNodeScore: clamp01(sample?.nodeScore),
            graphEdgeScore: clamp01(sample?.edgeScore),
            graphReliabilityMode: graph.reliabilityMode || 'unavailable',
            closure,
            nodeCoverage,
            edgeCoverage,
            nodeAlignment,
            edgeReliability,
            nodeReliability,
            conditionalExpectedGraph,
            conditionalVariance:
                Number(sample?.conditionalVariance) || 0,
            conditionalStdDev:
                Number(sample?.conditionalStdDev) || 0,
            conditionalPredictionUncertainty:
                Number(sample?.conditionalPredictionUncertainty) || 0,
            conditionalEffectivePeerCount:
                Number(sample?.conditionalEffectivePeerCount) || 0,
            conditionalBandwidth: context.bandwidth,
            conditionalClosureBandwidth: context.closureBandwidth,
            conditionalDirectBandwidth: context.directBandwidth,
            conditionalPeerCount: sample?.conditionalPeerCount || 0,
            conditionalWeightMass:
                Number(sample?.conditionalWeightMass) || 0,
            innovationConfidenceZ: context.confidenceZ,
            graphInnovationRaw,
            graphInnovationLowerBound,
            graphInnovationPositive,
            innovationScale,
            roleMultiplier,
            globalBonusCap,
            roleBonusCap,
            requestedBonus,
            confidenceLimitedBonus,
            directFrontierScore: context.directFrontierScore,
            frontierProtectionMargin,
            frontierBonusBudget: Number.isFinite(frontierBonusBudget)
                ? frontierBonusBudget
                : null,
            frontierLimited: bonus < confidenceLimitedBonus,
            bonusCap: roleBonusCap,
            bonus,
            pureScore: pure.score,
            finalScore: score,
            noNegativePenalty: true
        })
    });
}

function buildTopologyV3BatchContext(dstcBatch, options = {}) {
    const v2Context = buildTopologyV2BatchContext(dstcBatch, options);
    const riverObservability = options.riverObservability
        || computeRiverObservability(options.queryState, {
            ...(options.riverObservabilityConfig || {}),
            structRoleMinOmega:
                options.topologyV3StructRoleMinOmega
        });
    const anchorResults = Array.isArray(options.anchorBatch?.results)
        ? options.anchorBatch.results
        : [];
    const structRoleMinOmega = clamp01(
        options.topologyV3StructRoleMinOmega ?? 0.12
    );
    const anchorBonusCap = clamp01(
        options.topologyV3AnchorBonusCap ?? 0.1
    );
    const anchorActivationZ = Math.max(
        0,
        Number(options.topologyV3AnchorActivationZ) || 2
    );
    const anchorActivationFloor = clamp01(
        options.topologyV3AnchorActivationFloor ?? 0.05
    );
    const anchorSaturation = clamp01(
        options.topologyV3AnchorSaturation ?? 0.2
    );
    const anchorFrontierContrast = Math.max(
        1,
        Number(options.topologyV3AnchorFrontierContrast) || 2
    );
    const anchorFrontierAbsFloor = clamp01(
        options.topologyV3AnchorFrontierAbsFloor ?? 0.1
    );
    const anchorStrengths = v2Context.samples.map((sample, index) => {
        const anchor = anchorResults[index] || {};
        return clamp01(
            clamp01(anchor.anchorScore)
            * clamp01(anchor.anchorReliability)
        );
    });
    const anchorBatchMean = anchorStrengths.length > 0
        ? anchorStrengths.reduce((sum, value) => sum + value, 0)
            / anchorStrengths.length
        : 0;
    const anchorBatchVariance = anchorStrengths.length > 0
        ? anchorStrengths.reduce(
            (sum, value) =>
                sum + Math.pow(value - anchorBatchMean, 2),
            0
        ) / anchorStrengths.length
        : 0;
    const anchorBatchStdDev = Math.sqrt(
        Math.max(0, anchorBatchVariance)
    );
    const anchorActivationThreshold = clamp01(Math.max(
        anchorActivationFloor,
        anchorBatchMean + anchorActivationZ * anchorBatchStdDev
    ));
    const rankedAnchorStrengths = anchorStrengths
        .map((strength, index) => ({ strength, index }))
        .sort((left, right) =>
            (right.strength - left.strength)
            || (left.index - right.index)
        );
    const strongestAnchorIndex = rankedAnchorStrengths[0]?.index ?? null;
    const strongestAnchorStrength =
        rankedAnchorStrengths[0]?.strength || 0;
    const secondAnchorStrength = rankedAnchorStrengths[1]?.strength || 0;
    const anchorFrontierPromoted = strongestAnchorIndex !== null
        && strongestAnchorStrength >= anchorFrontierAbsFloor
        && strongestAnchorStrength >= (
            anchorFrontierContrast * secondAnchorStrength
        );

    const samples = v2Context.samples.map((sample, index) => {
        const anchor = anchorResults[index] || {};
        const anchorScore = clamp01(anchor.anchorScore);
        const anchorReliability = clamp01(anchor.anchorReliability);
        const anchorStrength = anchorStrengths[index] || 0;
        const activationDenominator =
            anchorSaturation - anchorActivationThreshold;
        const anchorActivation = anchorStrength
            <= anchorActivationThreshold
            ? 0
            : activationDenominator > 1e-12
                ? smoothstep01(
                    (anchorStrength - anchorActivationThreshold)
                    / activationDenominator
                )
                : 1;
        const anchorBonus = anchorBonusCap * anchorActivation;
        const originalRole = sample.role;
        let role = originalRole;
        let roleReclassified = false;
        let roleReclassificationReason = null;

        if (anchorFrontierPromoted && index === strongestAnchorIndex) {
            role = 'direct_answer';
            roleReclassified = role !== originalRole;
            roleReclassificationReason = roleReclassified
                ? 'strong-direct-anchor-contrast'
                : null;
        } else if (
            riverObservability.omega < structRoleMinOmega
            && role === 'structural_explanation'
        ) {
            role = 'thematic_neighbor';
            roleReclassified = true;
            roleReclassificationReason = 'collapsed-river-structure';
        }

        return Object.freeze({
            ...sample,
            role,
            originalRole,
            roleReclassified,
            roleReclassificationReason,
            anchor: Object.freeze({
                ...anchor,
                anchorScore,
                anchorReliability,
                anchorStrength,
                anchorActivation,
                anchorBonus
            })
        });
    });

    const v2DirectFrontierScore = v2Context.directFrontierScore;
    const anchorDirectFrontierScore = anchorFrontierPromoted
        ? samples[strongestAnchorIndex].pure.score
            + samples[strongestAnchorIndex].anchor.anchorBonus
        : 0;
    const directFrontierScore = Math.max(
        v2DirectFrontierScore,
        anchorDirectFrontierScore
    );
    const frontierSource = anchorDirectFrontierScore > v2DirectFrontierScore
        ? 'anchor'
        : 'v2';

    return Object.freeze({
        ...v2Context,
        samples: Object.freeze(samples),
        directFrontierScore,
        riverObservability,
        anchorBatchAvailable: anchorResults.length === samples.length,
        anchorBatchDiagnostics: options.anchorBatch?.diagnostics || null,
        anchorMassNormalization:
            options.anchorBatch?.massNormalization || null,
        structRoleMinOmega,
        anchorBonusCap,
        anchorActivationZ,
        anchorActivationFloor,
        anchorSaturation,
        anchorBatchMean,
        anchorBatchVariance,
        anchorBatchStdDev,
        anchorActivationThreshold,
        anchorFrontierContrast,
        anchorFrontierAbsFloor,
        strongestAnchorIndex,
        strongestAnchorStrength,
        secondAnchorStrength,
        anchorFrontierPromoted,
        anchorAwardedCount: samples.filter(
            sample => sample.anchor.anchorBonus > 0
        ).length,
        v2DirectFrontierScore,
        anchorDirectFrontierScore,
        frontierSource
    });
}

function scoreTopologyV3(item, options = {}, batchContext = null, index = 0) {
    const context = batchContext
        || buildTopologyV3BatchContext({ results: [item] }, options);
    const sample = context.samples[index] || context.samples[0];
    const v2Result = scoreTopologyV2(item, options, context, index);
    const pure = sample?.pure || scorePure(item, options);
    const omega = clamp01(context.riverObservability?.omega);
    const omegaGamma = Math.max(
        0,
        Number(options.topologyV3OmegaGamma) || 1
    );
    const graphGate = Math.pow(omega, omegaGamma);
    const v2Bonus = clamp01(v2Result.topologyV2?.bonus);
    const gatedV2Bonus = v2Bonus * graphGate;
    const anchor = sample?.anchor || {};
    const anchorBonus = clamp01(anchor.anchorBonus);
    const score = clamp01(
        pure.score + gatedV2Bonus + anchorBonus
    );

    return Object.freeze({
        ...v2Result,
        arm: 'topology_v3',
        score,
        baseScore: pure.score,
        topologyV3: Object.freeze({
            mode: 'river_observability_gated_v2_with_direct_anchor',
            omega,
            regime: context.riverObservability?.regime || 'collapsed',
            omegaEdge: clamp01(context.riverObservability?.omegaEdge),
            omegaEmerge: clamp01(context.riverObservability?.omegaEmerge),
            omegaFlow: clamp01(context.riverObservability?.omegaFlow),
            omegaGamma,
            graphGate,
            v2Bonus,
            gatedV2Bonus,
            anchorBatchAvailable: context.anchorBatchAvailable,
            anchorMassNormalization:
                context.anchorMassNormalization || null,
            anchorScore: clamp01(anchor.anchorScore),
            anchorReliability: clamp01(anchor.anchorReliability),
            anchorStrength: clamp01(anchor.anchorStrength),
            anchorActivation: clamp01(anchor.anchorActivation),
            anchorBonus,
            anchorBonusCap: context.anchorBonusCap,
            anchorActivationZ: context.anchorActivationZ,
            anchorActivationFloor: context.anchorActivationFloor,
            anchorSaturation: context.anchorSaturation,
            anchorBatchMean: context.anchorBatchMean,
            anchorBatchVariance: context.anchorBatchVariance,
            anchorBatchStdDev: context.anchorBatchStdDev,
            anchorActivationThreshold:
                context.anchorActivationThreshold,
            anchorFrontierContrast: context.anchorFrontierContrast,
            anchorFrontierAbsFloor: context.anchorFrontierAbsFloor,
            strongestAnchorStrength: context.strongestAnchorStrength,
            secondAnchorStrength: context.secondAnchorStrength,
            anchorFrontierPromoted: context.anchorFrontierPromoted,
            anchorAwardedCount: context.anchorAwardedCount,
            contactedSeeds: Number(anchor.contactedSeeds) || 0,
            exactContacts: Number(anchor.exactContacts) || 0,
            semanticContacts: Number(anchor.semanticContacts) || 0,
            meanClosure: clamp01(anchor.meanClosure),
            contacts: Array.isArray(anchor.contacts)
                ? anchor.contacts
                : Object.freeze([]),
            originalRole: sample?.originalRole || null,
            role: sample?.role || 'thematic_neighbor',
            roleReclassified: sample?.roleReclassified === true,
            roleReclassificationReason:
                sample?.roleReclassificationReason || null,
            structRoleMinOmega: context.structRoleMinOmega,
            directFrontierScore: context.directFrontierScore,
            v2DirectFrontierScore: context.v2DirectFrontierScore,
            anchorDirectFrontierScore:
                context.anchorDirectFrontierScore,
            frontierSource: context.frontierSource,
            pureScore: pure.score,
            finalScore: score,
            noNegativePenalty: true
        })
    });
}

const ARM_SCORERS = Object.freeze({
    pure: scorePure,
    gated: scoreGated,
    observed: scoreObserved,
    topology: scoreTopology,
    topology_v2: scoreTopologyV2,
    topology_v3: scoreTopologyV3
});

function scoreExperimentArm(dstcBatch, arm = 'pure', options = {}) {
    const normalizedArm = String(arm || 'pure').toLowerCase();
    const scorer = ARM_SCORERS[normalizedArm];
    if (!scorer) {
        throw new RangeError(
            `Unknown V10 experiment arm "${arm}"; expected ${ARM_NAMES.join(', ')}`
        );
    }

    const input = Array.isArray(dstcBatch?.results) ? dstcBatch.results : [];
    const batchContext = normalizedArm === 'topology_v2'
        ? buildTopologyV2BatchContext(dstcBatch, options)
        : normalizedArm === 'topology_v3'
            ? buildTopologyV3BatchContext(dstcBatch, options)
            : null;
    const scored = input
        .map((item, originalIndex) => Object.freeze({
            ...item,
            armResult: scorer(
                item,
                options,
                batchContext,
                originalIndex
            ),
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
            queryProfile: batchContext?.queryProfile || null,
            riverObservability:
                batchContext?.riverObservability || null,
            anchorBatchAvailable:
                batchContext?.anchorBatchAvailable ?? null,
            anchorBatchDiagnostics:
                batchContext?.anchorBatchDiagnostics || null,
            anchorMassNormalization:
                batchContext?.anchorMassNormalization || null,
            anchorBatchMean:
                batchContext?.anchorBatchMean ?? null,
            anchorBatchStdDev:
                batchContext?.anchorBatchStdDev ?? null,
            anchorActivationThreshold:
                batchContext?.anchorActivationThreshold ?? null,
            strongestAnchorStrength:
                batchContext?.strongestAnchorStrength ?? null,
            secondAnchorStrength:
                batchContext?.secondAnchorStrength ?? null,
            anchorFrontierPromoted:
                batchContext?.anchorFrontierPromoted ?? null,
            anchorAwardedCount:
                batchContext?.anchorAwardedCount ?? null,
            totalTopologyV2Bonus: scored.reduce(
                (sum, item) =>
                    sum + (Number(item.armResult.topologyV2?.bonus) || 0),
                0
            ),
            totalTopologyV3GatedBonus: scored.reduce(
                (sum, item) =>
                    sum + (
                        Number(item.armResult.topologyV3?.gatedV2Bonus)
                        || 0
                    ),
                0
            ),
            totalTopologyV3AnchorBonus: scored.reduce(
                (sum, item) =>
                    sum + (
                        Number(item.armResult.topologyV3?.anchorBonus)
                        || 0
                    ),
                0
            ),
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
    scoreTopologyV2,
    scoreTopologyV3,
    classifyTopologyV2Query,
    buildTopologyV2BatchContext,
    buildTopologyV3BatchContext,
    scoreExperimentArm,
    runExperimentArms
};