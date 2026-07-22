'use strict';

const { cosine } = require('./unifiedPathGeometry');

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function pairKey(left, right) {
    const a = Number(left);
    const b = Number(right);
    return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function pairSimilarity(view, left, right) {
    if (Number(left) === Number(right)) return 1;
    const value = view?.get?.(pairKey(left, right));
    return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function positiveCosine(left, right) {
    return clamp01(cosine(left, right));
}

function buildCandidateGeometry(curve) {
    const chain = Array.isArray(curve?.tagCurve) ? curve.tagCurve : [];
    const ordered = chain.map((tag, index) => ({
        tag,
        id: Number(tag.id),
        index,
        position: Number(tag.position) > 0 ? Number(tag.position) : index + 1,
        closure: tag.vector && curve?.chunkVector
            ? positiveCosine(tag.vector, curve.chunkVector)
            : 0
    }));
    const minimumPosition = ordered[0]?.position || 0;
    const maximumPosition = ordered[ordered.length - 1]?.position || minimumPosition;
    const span = Math.max(1, maximumPosition - minimumPosition);
    return { ordered, minimumPosition, maximumPosition, span };
}

function buildRiverGeometry(queryState) {
    const river = queryState?.queryRiverGraph;
    const nodes = Array.isArray(river?.nodes) ? river.nodes : [];
    const edges = Array.isArray(river?.edges) ? river.edges : [];
    const nodeById = new Map(nodes.map(node => [Number(node.id), node]));
    const maximumHop = Math.max(
        1,
        ...nodes.map(node => Number.isFinite(Number(node.hop)) ? Number(node.hop) : 0)
    );
    const inDegree = new Map();
    const outDegree = new Map();
    for (const edge of edges) {
        const sourceId = Number(edge.sourceId);
        const targetId = Number(edge.targetId);
        outDegree.set(sourceId, (outDegree.get(sourceId) || 0) + 1);
        inDegree.set(targetId, (inDegree.get(targetId) || 0) + 1);
    }
    return { river, nodes, edges, nodeById, maximumHop, inDegree, outDegree };
}

function bestNodeAlignment(riverNode, candidate, pairwiseView, options = {}) {
    const semanticThreshold = Math.max(
        -1,
        Math.min(1, Number(options.semanticNodeThreshold ?? 0.48))
    );
    const queryTagVector = options.queryTagVectorById?.get?.(
        Number(riverNode.id)
    ) || null;
    const exact = candidate.ordered.find(item => item.id === Number(riverNode.id));
    if (exact) {
        return Object.freeze({
            queryTagId: Number(riverNode.id),
            candidateTagId: exact.id,
            candidateIndex: exact.index,
            candidatePosition: exact.position,
            exact: true,
            semanticSimilarity: 1,
            closure: exact.closure,
            alignmentQuality: Math.sqrt(Math.max(0, exact.closure))
        });
    }

    let best = null;
    for (const item of candidate.ordered) {
        const cachedSimilarity = pairSimilarity(
            pairwiseView,
            Number(riverNode.id),
            item.id
        );
        // Pairwise 资产只覆盖预计算过的 Tag 对，不是全矩阵。缓存未命中时
        // 必须读取查询河网节点与候选 Tag 的真实向量余弦，否则所有非同 ID
        // 的语义同构节点都会被误判为无对应，整条 Graph 通道静默归零。
        const vectorSimilarity = queryTagVector && item.tag?.vector
            ? positiveCosine(queryTagVector, item.tag.vector)
            : 0;
        const similarity = Math.max(cachedSimilarity, vectorSimilarity);
        if (similarity < semanticThreshold) continue;
        const normalizedSemantic = clamp01(
            (similarity - semanticThreshold)
            / Math.max(1e-9, 1 - semanticThreshold)
        );
        const quality = Math.sqrt(normalizedSemantic * item.closure);
        if (
            !best
            || quality > best.alignmentQuality
            || (
                quality === best.alignmentQuality
                && item.index < best.candidateIndex
            )
        ) {
            best = {
                queryTagId: Number(riverNode.id),
                candidateTagId: item.id,
                candidateIndex: item.index,
                candidatePosition: item.position,
                exact: false,
                semanticSimilarity: similarity,
                semanticSource: vectorSimilarity >= cachedSimilarity
                    ? 'query_tag_vector'
                    : 'pairwise_cache',
                closure: item.closure,
                alignmentQuality: quality
            };
        }
    }
    return best ? Object.freeze(best) : null;
}

function candidateIndependentFraction(provenanceView, edge, fileId, floor) {
    const inspection = provenanceView?.inspectEdge?.(
        Number(edge.sourceId),
        Number(edge.targetId)
    );
    if (!inspection || inspection.unknown || !(inspection.totalMass > 0)) return 1;
    const ownMass = (Array.isArray(inspection.contributions)
        ? inspection.contributions
        : []
    ).reduce(
        (sum, contribution) =>
            Number(contribution.fileId) === Number(fileId)
                ? sum + Math.max(0, Number(contribution.mass) || 0)
                : sum,
        0
    );
    return Math.max(
        floor,
        clamp01(1 - ownMass / inspection.totalMass)
    );
}

function evaluateRelativeTopology(curve, queryState, options = {}) {
    const candidate = buildCandidateGeometry(curve);
    const query = buildRiverGeometry(queryState);
    if (candidate.ordered.length === 0 || query.nodes.length === 0) {
        return Object.freeze({
            schema: 'tagmemo-v10-relative-topology-v1',
            score: 0,
            reliability: 0,
            nodeAlignmentScore: 0,
            relativeDistanceScore: 0,
            directionScore: 0,
            edgeTopologyScore: 0,
            motifScore: 0,
            matchedNodeCoverage: 0,
            matchedEdgeCoverage: 0,
            reason: candidate.ordered.length === 0
                ? 'missing-candidate-tag-curve'
                : 'missing-query-river-graph',
            nodeAlignments: Object.freeze([]),
            edgeAlignments: Object.freeze([])
        });
    }

    const pairwiseView = options.pairwiseView;
    const provenanceView = options.provenanceView;
    const selfEvidenceFloor = clamp01(options.selfEvidenceFloor ?? 0.15);
    const reverseDirectionCredit = clamp01(
        options.reverseDirectionCredit ?? 0.25
    );
    const distanceTemperature = Math.max(
        1e-6,
        Number(options.relativeDistanceTemperature) || 0.35
    );
    const minimumRiverEdgeFlow = clamp01(
        options.minimumRiverEdgeFlow ?? 0.015
    );
    const maximumRiverEdges = Math.max(
        1,
        Math.floor(Number(options.maximumRiverEdges) || 96)
    );

    const alignments = new Map();
    let totalNodeWeight = 0;
    let matchedNodeWeight = 0;
    let nodeQualityMass = 0;
    for (const node of query.nodes) {
        const nodeWeight = Math.max(
            1e-9,
            Number(node.normalizedEnergy ?? node.energy) || 0
        );
        totalNodeWeight += nodeWeight;
        const alignment = bestNodeAlignment(
            node,
            candidate,
            pairwiseView,
            options
        );
        if (!alignment) continue;
        alignments.set(Number(node.id), alignment);
        matchedNodeWeight += nodeWeight;
        nodeQualityMass += nodeWeight * alignment.alignmentQuality;
    }
    const matchedNodeCoverage = totalNodeWeight > 0
        ? clamp01(matchedNodeWeight / totalNodeWeight)
        : 0;
    const nodeAlignmentScore = matchedNodeWeight > 0
        ? clamp01(nodeQualityMass / matchedNodeWeight)
        : 0;

    const retainedEdges = query.edges
        .filter(edge =>
            clamp01(edge.normalizedFlow ?? edge.flow) >= minimumRiverEdgeFlow
        )
        .slice(0, maximumRiverEdges);
    let totalEdgeWeight = 0;
    let matchedEdgeWeight = 0;
    let distanceMass = 0;
    let directionMass = 0;
    let topologyMass = 0;
    const edgeAlignments = [];

    for (const edge of retainedEdges) {
        const edgeWeight = Math.max(
            1e-9,
            Number(edge.normalizedFlow ?? edge.flow) || 0
        );
        totalEdgeWeight += edgeWeight;
        const source = alignments.get(Number(edge.sourceId));
        const target = alignments.get(Number(edge.targetId));
        if (!source || !target || source.candidateIndex === target.candidateIndex) {
            continue;
        }

        const sourceNode = query.nodeById.get(Number(edge.sourceId)) || {};
        const targetNode = query.nodeById.get(Number(edge.targetId)) || {};
        const queryHopDistance = Math.max(
            1,
            Math.abs(
                (Number(targetNode.hop) || 0)
                - (Number(sourceNode.hop) || 0)
            )
        );
        const normalizedQueryDistance = queryHopDistance / query.maximumHop;
        const candidatePositionDistance = Math.abs(
            target.candidatePosition - source.candidatePosition
        );
        const normalizedCandidateDistance =
            candidatePositionDistance / candidate.span;
        const distanceSimilarity = Math.exp(
            -Math.abs(
                normalizedQueryDistance - normalizedCandidateDistance
            ) / distanceTemperature
        );
        const forward = target.candidatePosition > source.candidatePosition;
        const directionSimilarity = forward ? 1 : reverseDirectionCredit;
        const independentFraction = candidateIndependentFraction(
            provenanceView,
            edge,
            curve?.fileId,
            selfEvidenceFloor
        );
        const endpointQuality = Math.sqrt(
            source.alignmentQuality * target.alignmentQuality
        );
        const edgeQuality = clamp01(
            endpointQuality
            * distanceSimilarity
            * directionSimilarity
            * independentFraction
        );

        matchedEdgeWeight += edgeWeight;
        distanceMass += edgeWeight * distanceSimilarity;
        directionMass += edgeWeight * directionSimilarity;
        topologyMass += edgeWeight * edgeQuality;
        edgeAlignments.push(Object.freeze({
            sourceId: Number(edge.sourceId),
            targetId: Number(edge.targetId),
            candidateSourceId: source.candidateTagId,
            candidateTargetId: target.candidateTagId,
            queryHopDistance,
            candidatePositionDistance,
            distanceSimilarity,
            directionSimilarity,
            independentFraction,
            endpointQuality,
            edgeQuality,
            wormhole: edge.wormhole === true,
            flow: Number(edge.flow) || 0,
            normalizedFlow: clamp01(edge.normalizedFlow ?? edge.flow)
        }));
    }

    const matchedEdgeCoverage = totalEdgeWeight > 0
        ? clamp01(matchedEdgeWeight / totalEdgeWeight)
        : 0;
    const relativeDistanceScore = matchedEdgeWeight > 0
        ? clamp01(distanceMass / matchedEdgeWeight)
        : 0;
    const directionScore = matchedEdgeWeight > 0
        ? clamp01(directionMass / matchedEdgeWeight)
        : 0;
    const edgeTopologyScore = matchedEdgeWeight > 0
        ? clamp01(topologyMass / matchedEdgeWeight)
        : 0;

    let motifWeight = 0;
    let motifMass = 0;
    for (const [queryTagId, alignment] of alignments.entries()) {
        const queryIn = query.inDegree.get(queryTagId) || 0;
        const queryOut = query.outDegree.get(queryTagId) || 0;
        if (queryIn <= 1 && queryOut <= 1) continue;
        const alignedEdges = edgeAlignments.filter(edge =>
            edge.sourceId === queryTagId || edge.targetId === queryTagId
        );
        const candidateIn = new Set(
            alignedEdges
                .filter(edge =>
                    edge.targetId === queryTagId
                    && edge.candidateSourceId !== alignment.candidateTagId
                )
                .map(edge => edge.candidateSourceId)
        ).size;
        const candidateOut = new Set(
            alignedEdges
                .filter(edge =>
                    edge.sourceId === queryTagId
                    && edge.candidateTargetId !== alignment.candidateTagId
                )
                .map(edge => edge.candidateTargetId)
        ).size;
        const inPreservation = queryIn > 1
            ? clamp01(candidateIn / queryIn)
            : 1;
        const outPreservation = queryOut > 1
            ? clamp01(candidateOut / queryOut)
            : 1;
        const weight = Math.max(1, queryIn + queryOut);
        motifWeight += weight;
        motifMass += weight * Math.sqrt(inPreservation * outPreservation);
    }
    const motifScore = motifWeight > 0
        ? clamp01(motifMass / motifWeight)
        : edgeTopologyScore;

    const meanClosure = alignments.size > 0
        ? [...alignments.values()].reduce(
            (sum, alignment) => sum + alignment.closure,
            0
        ) / alignments.size
        : 0;
    const rawWeights = {
        node: Math.max(0, Number(options.nodeWeight) || 0.18),
        distance: Math.max(0, Number(options.distanceWeight) || 0.22),
        direction: Math.max(0, Number(options.directionWeight) || 0.18),
        edge: Math.max(0, Number(options.edgeWeight) || 0.28),
        motif: Math.max(0, Number(options.motifWeight) || 0.14)
    };
    const weightTotal = Object.values(rawWeights)
        .reduce((sum, value) => sum + value, 0) || 1;
    const edgeGraphScore = clamp01(
        (
            rawWeights.node * nodeAlignmentScore
            + rawWeights.distance * relativeDistanceScore
            + rawWeights.direction * directionScore
            + rawWeights.edge * edgeTopologyScore
            + rawWeights.motif * motifScore
        ) / weightTotal
    );
    // 没有完整边对应时，不能继续把距离/方向/边/Motif 四个不可观测量
    // 当作 0 混入总分。节点退化读出只表达 Query River Node 与候选
    // 原生 Tag 的对齐质量及其回到 Chunk 正文的闭合能力。
    const nodeGraphScore = alignments.size > 0
        ? clamp01(Math.sqrt(nodeAlignmentScore * meanClosure))
        : 0;
    const score = edgeAlignments.length > 0
        ? edgeGraphScore
        : nodeGraphScore;
    const edgeReliability = clamp01(Math.cbrt(
        Math.max(0, matchedNodeCoverage)
        * Math.max(0, matchedEdgeCoverage)
        * Math.max(0, meanClosure)
    ));
    // 稀疏河道中可能已经存在可信的 Query River Node → Candidate Tag
    // 对应，但没有两端同时落到候选曲线的完整边。旧公式把 edgeCoverage
    // 作为乘法硬门，会让第二主读出永久归零。节点级退化只授予严格限幅的
    // 可靠度，完整边一旦存在仍使用更强的三因子可靠度。
    const nodeOnlyReliabilityCap = clamp01(
        options.nodeOnlyReliabilityCap ?? 0.2
    );
    const nodeOnlyReliability = Math.min(
        nodeOnlyReliabilityCap,
        clamp01(Math.sqrt(
            Math.max(0, matchedNodeCoverage)
            * Math.max(0, meanClosure)
        ))
    );
    const hasMatchedEdges = edgeAlignments.length > 0;
    const reliability = hasMatchedEdges
        ? edgeReliability
        : nodeOnlyReliability;
    const reliabilityMode = hasMatchedEdges
        ? 'edge_topology'
        : alignments.size > 0
            ? 'node_alignment_fallback'
            : 'unavailable';

    return Object.freeze({
        schema: 'tagmemo-v10-relative-topology-v1',
        score,
        reliability,
        reliabilityMode,
        edgeReliability,
        nodeOnlyReliability,
        nodeOnlyReliabilityCap,
        reliableScore: score * reliability,
        nodeAlignmentScore,
        edgeGraphScore,
        nodeGraphScore,
        relativeDistanceScore,
        directionScore,
        edgeTopologyScore,
        motifScore,
        matchedNodeCoverage,
        matchedEdgeCoverage,
        meanClosure,
        matchedNodes: alignments.size,
        queryNodes: query.nodes.length,
        matchedEdges: edgeAlignments.length,
        queryEdges: retainedEdges.length,
        reason: edgeAlignments.length > 0
            ? null
            : alignments.size > 0
                ? 'node-alignment-only-no-river-edge-match'
                : 'no-query-river-node-aligned-to-candidate',
        nodeAlignments: Object.freeze([...alignments.values()]),
        edgeAlignments: Object.freeze(
            edgeAlignments
                .sort((left, right) =>
                    (right.edgeQuality * right.normalizedFlow)
                    - (left.edgeQuality * left.normalizedFlow)
                )
                .slice(0, Math.max(
                    1,
                    Math.floor(Number(options.traceEdgeLimit) || 24)
                ))
        )
    });
}

function evaluateRelativeTopologyBatch(pathBatch, queryState, options = {}) {
    const results = (Array.isArray(pathBatch?.results)
        ? pathBatch.results
        : []
    ).map(item => Object.freeze({
        ...item,
        relativeTopology: evaluateRelativeTopology(
            item.curve,
            queryState,
            options
        )
    }));
    return Object.freeze({
        schema: 'tagmemo-v10-relative-topology-batch-v1',
        results: Object.freeze(results),
        diagnostics: Object.freeze({
            candidates: results.length,
            matched: results.filter(item =>
                item.relativeTopology.matchedEdges > 0
            ).length,
            meanScore: results.length > 0
                ? results.reduce(
                    (sum, item) => sum + item.relativeTopology.score,
                    0
                ) / results.length
                : 0,
            meanReliability: results.length > 0
                ? results.reduce(
                    (sum, item) => sum + item.relativeTopology.reliability,
                    0
                ) / results.length
                : 0
        })
    });
}

module.exports = {
    pairKey,
    pairSimilarity,
    evaluateRelativeTopology,
    evaluateRelativeTopologyBatch
};