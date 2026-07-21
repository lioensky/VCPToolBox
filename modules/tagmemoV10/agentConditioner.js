'use strict';

const { hashStable, immutableSnapshot } = require('./immutable');

const PROVENANCE_CLASSES = Object.freeze([
    'public',
    'agent_own',
    'authorized',
    'other_agent_public',
    'private_forbidden',
    'unknown'
]);

function clamp(value, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return min;
    return Math.max(min, Math.min(max, numeric));
}

function normalizeProvenance(raw = {}) {
    const mass = {};
    let total = 0;
    for (const key of PROVENANCE_CLASSES) {
        const value = Math.max(0, Number(raw[key]) || 0);
        mass[key] = value;
        total += value;
    }
    if (total <= 0) {
        mass.unknown = 1;
        total = 1;
    }
    return Object.freeze({
        ...mass,
        total
    });
}

function createConditionedOperator(sharedTransport, context = {}, options = {}) {
    if (!sharedTransport || typeof sharedTransport.forEachEdge !== 'function') {
        throw new TypeError('createConditionedOperator requires a readonly shared transport');
    }

    const scale = options.scale === 'transfer' ? 'transfer' : 'local';
    const failClosed = options.failClosed !== false;
    const queryGate = typeof options.queryGate === 'function'
        ? options.queryGate
        : () => 1;
    const affinityGate = typeof options.affinityGate === 'function'
        ? options.affinityGate
        : () => 1;
    const nodeVisibility = typeof options.nodeVisibility === 'function'
        ? options.nodeVisibility
        : () => true;
    const edgeProvenance = typeof options.edgeProvenance === 'function'
        ? options.edgeProvenance
        : () => ({ unknown: 1 });
    const edgeAuthorization = typeof options.edgeAuthorization === 'function'
        ? options.edgeAuthorization
        : null;

    const localMin = clamp(options.localAffinityMin ?? 0.75, 0, 1);
    const localMax = clamp(options.localAffinityMax ?? 1.25, 1, 4);
    const transferMin = clamp(options.transferAffinityMin ?? 0.9, 0, 1);
    const transferMax = clamp(options.transferAffinityMax ?? 1.1, 1, 4);
    const affinityMin = scale === 'local' ? localMin : transferMin;
    const affinityMax = scale === 'local' ? localMax : transferMax;

    const permissions = context.permissions || {};
    const allowUnknownProvenance = permissions.allowUnknownProvenance === true
        && failClosed === false;
    const allowOtherAgentPublic = permissions.allowOtherAgentPublic !== false;
    const allowAuthorized = permissions.allowAuthorized !== false;
    const allowOwn = permissions.allowOwn !== false;
    const allowPublic = permissions.allowPublic !== false;

    const authorizedFraction = rawProvenance => {
        const provenance = normalizeProvenance(rawProvenance);
        let authorizedMass = 0;
        if (allowPublic) authorizedMass += provenance.public;
        if (allowOwn) authorizedMass += provenance.agent_own;
        if (allowAuthorized) authorizedMass += provenance.authorized;
        if (allowOtherAgentPublic) authorizedMass += provenance.other_agent_public;
        if (allowUnknownProvenance) authorizedMass += provenance.unknown;
        return Object.freeze({
            provenance,
            authorizedMass,
            fraction: provenance.total > 0 ? authorizedMass / provenance.total : 0,
            forbiddenMass: provenance.private_forbidden
                + (allowUnknownProvenance ? 0 : provenance.unknown)
        });
    };

    const inspectEdge = (sourceId, targetId, baseWeight) => {
        const sourceVisible = nodeVisibility(sourceId, context) === true;
        const targetVisible = nodeVisibility(targetId, context) === true;
        const hardVisible = sourceVisible && targetVisible;
        const authorization = authorizedFraction(
            edgeProvenance(sourceId, targetId, context) || {}
        );
        const explicitAuthorized = edgeAuthorization
            ? edgeAuthorization(sourceId, targetId, authorization.provenance, context) === true
            : true;
        const propagationEligible = hardVisible
            && explicitAuthorized
            && authorization.fraction > 0;

        const queryAffinity = propagationEligible
            ? clamp(queryGate(sourceId, targetId, context, scale), 0, 1)
            : 0;
        const subjectAffinity = propagationEligible
            ? clamp(
                affinityGate(sourceId, targetId, context, scale),
                affinityMin,
                affinityMax
            )
            : 0;
        const rawWeight = propagationEligible
            ? Math.max(0, Number(baseWeight) || 0)
                * authorization.fraction
                * queryAffinity
                * subjectAffinity
            : 0;

        const targetIdentity = typeof options.identityEligibility === 'function'
            ? options.identityEligibility(targetId, context) === true
            : false;
        const targetRanking = typeof options.rankingEligibility === 'function'
            ? options.rankingEligibility(targetId, context) !== false
            : hardVisible;

        return Object.freeze({
            sourceId,
            targetId,
            baseWeight: Math.max(0, Number(baseWeight) || 0),
            hardVisible,
            propagationEligible,
            identityEligible: hardVisible && targetIdentity,
            rankingEligible: hardVisible && targetRanking,
            queryAffinity,
            subjectAffinity,
            authorizedFraction: authorization.fraction,
            forbiddenMass: authorization.forbiddenMass,
            provenance: authorization.provenance,
            rawWeight
        });
    };

    const collectRow = sourceId => {
        const inspected = [];
        let rawMass = 0;
        sharedTransport.forEachEdge(sourceId, (targetId, baseWeight) => {
            const edge = inspectEdge(sourceId, targetId, baseWeight);
            if (edge.rawWeight <= 0) return;
            inspected.push(edge);
            rawMass += edge.rawWeight;
        });

        const baseBudget = sharedTransport.rowMass(sourceId);
        // 禁止质量被裁掉后不向合法边重分配；仅在软亲和 > 1 导致超预算时向下投影。
        const projection = rawMass > baseBudget && rawMass > 0
            ? baseBudget / rawMass
            : 1;
        return Object.freeze({
            sourceId,
            baseBudget,
            rawMass,
            projectedMass: rawMass * projection,
            projection,
            edges: Object.freeze(inspected)
        });
    };

    const descriptor = immutableSnapshot({
        schema: 'tagmemo-v10-alpha-conditioned-operator-v1',
        scale,
        failClosed,
        affinityMin,
        affinityMax,
        scopeHash: options.scopeHash || null,
        permissions: {
            allowPublic,
            allowOwn,
            allowAuthorized,
            allowOtherAgentPublic,
            allowUnknownProvenance
        }
    });

    return Object.freeze({
        ...descriptor,
        operatorSig: hashStable({
            descriptor,
            sharedTransportSig: sharedTransport.contentSig
        }, 40),
        nodeCount: sharedTransport.nodeCount,
        nodeIdAt: sharedTransport.nodeIdAt,
        nodeIndexOf: sharedTransport.nodeIndexOf,
        inspectEdge,
        rowMass(sourceId) {
            return collectRow(sourceId).projectedMass;
        },
        forEachEdge(sourceId, callback) {
            const row = collectRow(sourceId);
            for (const edge of row.edges) {
                callback(
                    edge.targetId,
                    edge.rawWeight * row.projection,
                    edge
                );
            }
        },
        apply(input, output = new Float64Array(sharedTransport.nodeCount), diagnostics = null) {
            if (!input || input.length !== sharedTransport.nodeCount) {
                throw new RangeError(
                    `Conditioned operator input length must be ${sharedTransport.nodeCount}`
                );
            }
            if (!output || output.length !== sharedTransport.nodeCount) {
                throw new RangeError(
                    `Conditioned operator output length must be ${sharedTransport.nodeCount}`
                );
            }

            output.fill(0);
            let visitedEdges = 0;
            let permittedEdges = 0;
            let forbiddenMass = 0;
            let propagatedMass = 0;

            sharedTransport.forEachRow(sourceId => {
                const sourceIndex = sharedTransport.nodeIndexOf(sourceId);
                const sourceMass = Number(input[sourceIndex]) || 0;
                if (sourceMass === 0) return;

                const row = collectRow(sourceId);
                sharedTransport.forEachEdge(sourceId, (targetId, baseWeight) => {
                    visitedEdges++;
                    const edge = inspectEdge(sourceId, targetId, baseWeight);
                    forbiddenMass += sourceMass
                        * edge.baseWeight
                        * (1 - edge.authorizedFraction);
                });
                for (const edge of row.edges) {
                    const targetIndex = sharedTransport.nodeIndexOf(edge.targetId);
                    const weight = edge.rawWeight * row.projection;
                    if (targetIndex === undefined || weight <= 0) continue;
                    output[targetIndex] += sourceMass * weight;
                    propagatedMass += sourceMass * weight;
                    permittedEdges++;
                }
            });

            if (diagnostics && typeof diagnostics === 'object') {
                diagnostics.visitedEdges = visitedEdges;
                diagnostics.permittedEdges = permittedEdges;
                diagnostics.forbiddenMass = forbiddenMass;
                diagnostics.propagatedMass = propagatedMass;
            }
            return output;
        }
    });
}

/**
 * 查询级成对编译条件化算子。
 *
 * 共享图只扫描一次，权限/provenance 只分类一次；Local 与 Transfer 的软门权重
 * 分别写入闭包内 TypedArray。发布对象不暴露底层数组，因此调用方无法修改资产。
 */
function createDualConditionedOperators(sharedTransport, context = {}, options = {}) {
    if (!sharedTransport || typeof sharedTransport.forEachEdge !== 'function') {
        throw new TypeError('createDualConditionedOperators requires a readonly shared transport');
    }

    const failClosed = options.failClosed !== false;
    const queryGate = typeof options.queryGate === 'function'
        ? options.queryGate
        : () => 1;
    const affinityGate = typeof options.affinityGate === 'function'
        ? options.affinityGate
        : () => 1;
    const nodeVisibility = typeof options.nodeVisibility === 'function'
        ? options.nodeVisibility
        : () => true;
    const edgeProvenance = typeof options.edgeProvenance === 'function'
        ? options.edgeProvenance
        : () => ({ unknown: 1 });
    const edgeAuthorization = typeof options.edgeAuthorization === 'function'
        ? options.edgeAuthorization
        : null;

    const permissions = context.permissions || {};
    const allowUnknownProvenance = permissions.allowUnknownProvenance === true
        && failClosed === false;
    const allowOtherAgentPublic = permissions.allowOtherAgentPublic !== false;
    const allowAuthorized = permissions.allowAuthorized !== false;
    const allowOwn = permissions.allowOwn !== false;
    const allowPublic = permissions.allowPublic !== false;
    const localMin = clamp(options.localAffinityMin ?? 0.75, 0, 1);
    const localMax = clamp(options.localAffinityMax ?? 1.25, 1, 4);
    const transferMin = clamp(options.transferAffinityMin ?? 0.9, 0, 1);
    const transferMax = clamp(options.transferAffinityMax ?? 1.1, 1, 4);
    const nodeCount = sharedTransport.nodeCount;

    const rowOffsets = new Uint32Array(nodeCount + 1);
    const targetIndices = [];
    const localWeights = [];
    const transferWeights = [];
    const baseWeights = [];
    const authorizedFractions = [];
    const forbiddenFractions = [];
    let permittedEdges = 0;
    let forbiddenEdgeMass = 0;
    let cursor = 0;

    const visibility = new Uint8Array(nodeCount);
    for (let index = 0; index < nodeCount; index++) {
        visibility[index] = nodeVisibility(sharedTransport.nodeIdAt(index), context) === true
            ? 1
            : 0;
    }

    const authorizationFor = raw => {
        const provenance = normalizeProvenance(raw);
        let authorizedMass = 0;
        if (allowPublic) authorizedMass += provenance.public;
        if (allowOwn) authorizedMass += provenance.agent_own;
        if (allowAuthorized) authorizedMass += provenance.authorized;
        if (allowOtherAgentPublic) authorizedMass += provenance.other_agent_public;
        if (allowUnknownProvenance) authorizedMass += provenance.unknown;
        return {
            provenance,
            fraction: provenance.total > 0 ? authorizedMass / provenance.total : 0,
            forbiddenMass: provenance.private_forbidden
                + (allowUnknownProvenance ? 0 : provenance.unknown)
        };
    };

    sharedTransport.forEachRow((sourceId, sourceIndex) => {
        const rowStart = cursor;
        const baseBudget = sharedTransport.rowMass(sourceId);
        let localRawMass = 0;
        let transferRawMass = 0;

        sharedTransport.forEachEdge(sourceId, (targetId, baseWeight) => {
            const targetIndex = sharedTransport.nodeIndexOf(targetId);
            const hardVisible = visibility[sourceIndex] === 1
                && targetIndex !== undefined
                && visibility[targetIndex] === 1;
            const authorization = authorizationFor(
                edgeProvenance(sourceId, targetId, context) || {}
            );
            const explicitlyAuthorized = edgeAuthorization
                ? edgeAuthorization(
                    sourceId,
                    targetId,
                    authorization.provenance,
                    context
                ) === true
                : true;
            const propagationEligible = hardVisible
                && explicitlyAuthorized
                && authorization.fraction > 0;
            const numericBaseWeight = Math.max(0, Number(baseWeight) || 0);
            let localWeight = 0;
            let transferWeight = 0;

            if (propagationEligible) {
                const localQueryAffinity = clamp(
                    queryGate(sourceId, targetId, context, 'local'),
                    0,
                    1
                );
                const transferQueryAffinity = clamp(
                    queryGate(sourceId, targetId, context, 'transfer'),
                    0,
                    1
                );
                const localSubjectAffinity = clamp(
                    affinityGate(sourceId, targetId, context, 'local'),
                    localMin,
                    localMax
                );
                const transferSubjectAffinity = clamp(
                    affinityGate(sourceId, targetId, context, 'transfer'),
                    transferMin,
                    transferMax
                );
                localWeight = numericBaseWeight
                    * authorization.fraction
                    * localQueryAffinity
                    * localSubjectAffinity;
                transferWeight = numericBaseWeight
                    * authorization.fraction
                    * transferQueryAffinity
                    * transferSubjectAffinity;
            }

            if (localWeight <= 0 && transferWeight <= 0) {
                forbiddenEdgeMass += numericBaseWeight
                    * (1 - authorization.fraction);
                return;
            }

            targetIndices.push(targetIndex);
            localWeights.push(localWeight);
            transferWeights.push(transferWeight);
            baseWeights.push(numericBaseWeight);
            authorizedFractions.push(authorization.fraction);
            forbiddenFractions.push(
                numericBaseWeight > 0
                    ? Math.max(0, 1 - authorization.fraction)
                    : 0
            );
            localRawMass += localWeight;
            transferRawMass += transferWeight;
            cursor++;
            permittedEdges++;
        });

        const localProjection = localRawMass > baseBudget && localRawMass > 0
            ? baseBudget / localRawMass
            : 1;
        const transferProjection = transferRawMass > baseBudget && transferRawMass > 0
            ? baseBudget / transferRawMass
            : 1;
        for (let edgeIndex = rowStart; edgeIndex < cursor; edgeIndex++) {
            localWeights[edgeIndex] *= localProjection;
            transferWeights[edgeIndex] *= transferProjection;
        }
        rowOffsets[sourceIndex + 1] = cursor;
    });

    const targets = Uint32Array.from(targetIndices);
    const local = Float64Array.from(localWeights);
    const transfer = Float64Array.from(transferWeights);
    const base = Float64Array.from(baseWeights);
    const authorized = Float64Array.from(authorizedFractions);
    const forbidden = Float64Array.from(forbiddenFractions);
    const pairSig = hashStable({
        schema: 'tagmemo-v10-alpha-compiled-dual-operator-v1',
        sharedTransportSig: sharedTransport.contentSig,
        scopeHash: options.scopeHash || null,
        permissions: {
            allowPublic,
            allowOwn,
            allowAuthorized,
            allowOtherAgentPublic,
            allowUnknownProvenance
        }
    }, 40);

    const applyOne = (weights, input, output, diagnostics = null) => {
        if (!input || input.length !== nodeCount || !output || output.length !== nodeCount) {
            throw new RangeError(`Compiled operator vector length must be ${nodeCount}`);
        }
        output.fill(0);
        let propagatedMass = 0;
        let activeVisitedEdges = 0;
        let activePermittedEdges = 0;
        let forbiddenMass = 0;
        for (let sourceIndex = 0; sourceIndex < nodeCount; sourceIndex++) {
            const sourceMass = Number(input[sourceIndex]) || 0;
            if (sourceMass === 0) continue;
            for (
                let edgeIndex = rowOffsets[sourceIndex];
                edgeIndex < rowOffsets[sourceIndex + 1];
                edgeIndex++
            ) {
                activeVisitedEdges++;
                forbiddenMass += sourceMass * base[edgeIndex] * forbidden[edgeIndex];
                const weight = weights[edgeIndex];
                if (weight <= 0) continue;
                const mass = sourceMass * weight;
                output[targets[edgeIndex]] += mass;
                propagatedMass += mass;
                activePermittedEdges++;
            }
        }
        if (diagnostics && typeof diagnostics === 'object') {
            diagnostics.visitedEdges = activeVisitedEdges;
            diagnostics.permittedEdges = activePermittedEdges;
            diagnostics.forbiddenMass = forbiddenMass;
            diagnostics.propagatedMass = propagatedMass;
        }
        return output;
    };

    const makeOperator = (scale, weights) => {
        const operatorSig = hashStable({ pairSig, scale }, 40);
        return Object.freeze({
            schema: 'tagmemo-v10-alpha-compiled-conditioned-operator-v1',
            scale,
            operatorSig,
            pairSig,
            nodeCount,
            edgeCount: targets.length,
            nodeIdAt: sharedTransport.nodeIdAt,
            nodeIndexOf: sharedTransport.nodeIndexOf,
            rowMass(sourceId) {
                const rowIndex = sharedTransport.nodeIndexOf(sourceId);
                if (rowIndex === undefined) return 0;
                let mass = 0;
                for (
                    let edgeIndex = rowOffsets[rowIndex];
                    edgeIndex < rowOffsets[rowIndex + 1];
                    edgeIndex++
                ) {
                    mass += weights[edgeIndex];
                }
                return mass;
            },
            forEachEdge(sourceId, callback) {
                const rowIndex = sharedTransport.nodeIndexOf(sourceId);
                if (rowIndex === undefined) return;
                for (
                    let edgeIndex = rowOffsets[rowIndex];
                    edgeIndex < rowOffsets[rowIndex + 1];
                    edgeIndex++
                ) {
                    const weight = weights[edgeIndex];
                    if (weight <= 0) continue;
                    callback(
                        sharedTransport.nodeIdAt(targets[edgeIndex]),
                        weight,
                        {
                            baseWeight: base[edgeIndex],
                            authorizedFraction: authorized[edgeIndex],
                            rawWeight: weight
                        }
                    );
                }
            },
            apply(input, output = new Float64Array(nodeCount), diagnostics = null) {
                return applyOne(weights, input, output, diagnostics);
            }
        });
    };

    const localOperator = makeOperator('local', local);
    const transferOperator = makeOperator('transfer', transfer);

    const applyDual = (
        localInput,
        transferInput,
        localOutput,
        transferOutput,
        localDiagnostics = null,
        transferDiagnostics = null
    ) => {
        if (
            !localInput || localInput.length !== nodeCount
            || !transferInput || transferInput.length !== nodeCount
            || !localOutput || localOutput.length !== nodeCount
            || !transferOutput || transferOutput.length !== nodeCount
        ) {
            throw new RangeError(`Compiled dual operator vector length must be ${nodeCount}`);
        }
        localOutput.fill(0);
        transferOutput.fill(0);
        let localPropagatedMass = 0;
        let transferPropagatedMass = 0;
        let localVisitedEdges = 0;
        let transferVisitedEdges = 0;
        let localPermittedEdges = 0;
        let transferPermittedEdges = 0;
        let localForbiddenMass = 0;
        let transferForbiddenMass = 0;

        for (let sourceIndex = 0; sourceIndex < nodeCount; sourceIndex++) {
            const localSourceMass = Number(localInput[sourceIndex]) || 0;
            const transferSourceMass = Number(transferInput[sourceIndex]) || 0;
            if (localSourceMass === 0 && transferSourceMass === 0) continue;

            for (
                let edgeIndex = rowOffsets[sourceIndex];
                edgeIndex < rowOffsets[sourceIndex + 1];
                edgeIndex++
            ) {
                const targetIndex = targets[edgeIndex];
                if (localSourceMass !== 0) {
                    localVisitedEdges++;
                    localForbiddenMass += localSourceMass
                        * base[edgeIndex]
                        * forbidden[edgeIndex];
                    const localWeight = local[edgeIndex];
                    if (localWeight > 0) {
                        const mass = localSourceMass * localWeight;
                        localOutput[targetIndex] += mass;
                        localPropagatedMass += mass;
                        localPermittedEdges++;
                    }
                }
                if (transferSourceMass !== 0) {
                    transferVisitedEdges++;
                    transferForbiddenMass += transferSourceMass
                        * base[edgeIndex]
                        * forbidden[edgeIndex];
                    const transferWeight = transfer[edgeIndex];
                    if (transferWeight > 0) {
                        const mass = transferSourceMass * transferWeight;
                        transferOutput[targetIndex] += mass;
                        transferPropagatedMass += mass;
                        transferPermittedEdges++;
                    }
                }
            }
        }

        if (localDiagnostics && typeof localDiagnostics === 'object') {
            localDiagnostics.visitedEdges = localVisitedEdges;
            localDiagnostics.permittedEdges = localPermittedEdges;
            localDiagnostics.forbiddenMass = localForbiddenMass;
            localDiagnostics.propagatedMass = localPropagatedMass;
        }
        if (transferDiagnostics && typeof transferDiagnostics === 'object') {
            transferDiagnostics.visitedEdges = transferVisitedEdges;
            transferDiagnostics.permittedEdges = transferPermittedEdges;
            transferDiagnostics.forbiddenMass = transferForbiddenMass;
            transferDiagnostics.propagatedMass = transferPropagatedMass;
        }
    };

    return Object.freeze({
        schema: 'tagmemo-v10-alpha-compiled-dual-operator-v1',
        pairSig,
        nodeCount,
        edgeCount: targets.length,
        permittedEdges,
        forbiddenEdgeMass,
        localOperator,
        transferOperator,
        applyDual
    });
}

module.exports = {
    PROVENANCE_CLASSES,
    normalizeProvenance,
    createConditionedOperator,
    createDualConditionedOperators
};