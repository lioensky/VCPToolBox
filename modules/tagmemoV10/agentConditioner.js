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

module.exports = {
    PROVENANCE_CLASSES,
    normalizeProvenance,
    createConditionedOperator
};