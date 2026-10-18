'use strict';

const { resolveFieldWorkspace } = require('./fieldWorkspace');

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function cosine(left, right) {
    if (!left || !right || left.length !== right.length || left.length === 0) return 0;
    let dot = 0;
    let normLeft = 0;
    let normRight = 0;
    for (let index = 0; index < left.length; index++) {
        const a = Number(left[index]) || 0;
        const b = Number(right[index]) || 0;
        dot += a * b;
        normLeft += a * a;
        normRight += b * b;
    }
    return normLeft > 1e-15 && normRight > 1e-15
        ? dot / Math.sqrt(normLeft * normRight)
        : 0;
}

function fieldMap(entries) {
    return new Map(
        (Array.isArray(entries) ? entries : [])
            .map(entry => [Number(entry[0]), Math.max(0, Number(entry[1]) || 0)])
            .filter(entry => Number.isFinite(entry[0]) && entry[1] > 0)
    );
}

function normalizeField(field) {
    let maximum = 0;
    for (const value of field.values()) maximum = Math.max(maximum, value);
    if (maximum <= 0) return field;
    return new Map([...field.entries()].map(([id, value]) => [id, value / maximum]));
}

function domainSet(domain) {
    return new Set(
        Array.isArray(domain?.ids)
            ? domain.ids.map(Number).filter(Number.isFinite)
            : []
    );
}

function evaluateUnifiedPath(curve, queryState, options = {}) {
    const chain = Array.isArray(curve?.tagCurve) ? curve.tagCurve : [];
    const workspace = resolveFieldWorkspace(queryState, options);
    const local = workspace.local;
    const transfer = workspace.transfer;
    const localDomain = workspace.localDomain;
    const transferDomain = workspace.transferDomain;
    const supportMode = String(
        options.supportMode || 'effective_domain'
    ).trim().toLowerCase();
    const minimumSupportedPotential = Math.max(
        0,
        Number(options.minimumSupportedPotential) || 0
    );
    const localOperator = queryState?.conditionedTransportView?.local;
    const transferOperator = queryState?.conditionedTransportView?.transfer || localOperator;
    const localWeight = clamp01(options.localWeight ?? 0.6);
    const transferWeight = clamp01(options.transferWeight ?? 0.4);
    const weightTotal = localWeight + transferWeight || 1;
    const directionFloor = clamp01(options.directionFloor ?? 0.05);
    const closureFloor = Math.max(-1, Math.min(1, Number(options.closureFloor) || 0));
    const segmentAttributions = [];

    let supportedSegments = 0;
    let segmentQualityMass = 0;
    let directionMass = 0;
    let continuityMass = 0;
    let localPotentialMass = 0;
    let transferPotentialMass = 0;
    let transferSegments = 0;

    for (let index = 0; index + 1 < chain.length; index++) {
        const current = chain[index];
        const next = chain[index + 1];
        const localPotential = Math.sqrt(
            (local.get(Number(current.id)) || 0)
            * (local.get(Number(next.id)) || 0)
        );
        const transferPotential = Math.sqrt(
            (transfer.get(Number(current.id)) || 0)
            * (transfer.get(Number(next.id)) || 0)
        );
        const localForward = Math.max(
            0,
            Number(localOperator?.edgeWeight?.(current.id, next.id))
            || (() => {
                let found = 0;
                localOperator?.forEachEdge?.(current.id, (targetId, weight) => {
                    if (Number(targetId) === Number(next.id)) found = weight;
                });
                return found;
            })()
        );
        const localReverse = Math.max(
            0,
            Number(localOperator?.edgeWeight?.(next.id, current.id))
            || (() => {
                let found = 0;
                localOperator?.forEachEdge?.(next.id, (targetId, weight) => {
                    if (Number(targetId) === Number(current.id)) found = weight;
                });
                return found;
            })()
        );
        const transferForward = Math.max(
            localForward,
            (() => {
                let found = 0;
                transferOperator?.forEachEdge?.(current.id, (targetId, weight) => {
                    if (Number(targetId) === Number(next.id)) found = weight;
                });
                return found;
            })()
        );
        const transferReverse = Math.max(
            localReverse,
            (() => {
                let found = 0;
                transferOperator?.forEachEdge?.(next.id, (targetId, weight) => {
                    if (Number(targetId) === Number(current.id)) found = weight;
                });
                return found;
            })()
        );
        const forward = Math.max(localForward, transferForward);
        const reverse = Math.max(localReverse, transferReverse);
        const direction = forward + reverse > 0
            ? clamp01(forward / (forward + reverse))
            : directionFloor;
        const semanticContinuity = current.vector && next.vector
            ? clamp01((cosine(current.vector, next.vector) + 1) / 2)
            : 0;
        const fieldContinuity = Math.sqrt(
            Math.max(localPotential, transferPotential)
            * Math.max(
                local.get(Number(next.id)) || 0,
                transfer.get(Number(next.id)) || 0
            )
        );
        const continuity = clamp01(
            0.5 * semanticContinuity + 0.5 * fieldContinuity
        );
        const currentId = Number(current.id);
        const nextId = Number(next.id);
        const localDomainSupported = localDomain.has(currentId)
            && localDomain.has(nextId);
        const transferDomainSupported = transferDomain.has(currentId)
            && transferDomain.has(nextId);
        const isTransfer = transferDomainSupported
            && (!localDomainSupported || transferPotential > localPotential);
        const potential = (
            localWeight * localPotential
            + transferWeight * transferPotential
        ) / weightTotal;
        const domainSupported = localDomainSupported
            || transferDomainSupported;
        const supported = supportMode === 'positive_tail'
            ? potential > minimumSupportedPotential
                && (forward > 0 || reverse > 0)
            : domainSupported
                && potential > minimumSupportedPotential
                && (forward > 0 || reverse > 0);
        // 未进入有效支持域的尾部边保留诊断，但不得贡献路径主质量。
        const quality = supported
            ? clamp01(
                potential
                * Math.sqrt(Math.max(directionFloor, direction))
                * Math.sqrt(Math.max(0, continuity))
            )
            : 0;

        if (supported) supportedSegments++;
        if (isTransfer && supported) transferSegments++;
        segmentQualityMass += quality;
        directionMass += direction;
        continuityMass += continuity;
        localPotentialMass += localPotential;
        transferPotentialMass += transferPotential;
        segmentAttributions.push(Object.freeze({
            index,
            sourceId: Number(current.id),
            targetId: Number(next.id),
            localPotential,
            transferPotential,
            direction,
            forwardConductance: forward,
            reverseConductance: reverse,
            continuity,
            semanticContinuity,
            localDomainSupported,
            transferDomainSupported,
            supportMode,
            isTransfer,
            supported,
            quality
        }));
    }

    const segmentCount = segmentAttributions.length;
    const pathCore = segmentCount > 0
        ? clamp01(segmentQualityMass / segmentCount)
        : clamp01(
            Math.max(
                local.get(Number(chain[0]?.id)) || 0,
                transfer.get(Number(chain[0]?.id)) || 0
            ) * 0.5
        );
    const tagClosure = chain.length > 0 && curve?.chunkVector
        ? chain.reduce((sum, tag) => {
            if (!tag.vector) return sum;
            const rawCosine = Number.isFinite(Number(tag.chunkCosine))
                ? Number(tag.chunkCosine)
                : cosine(tag.vector, curve.chunkVector);
            return sum + clamp01(
                (rawCosine - closureFloor)
                / Math.max(1e-9, 1 - closureFloor)
            );
        }, 0) / chain.length
        : 0;
    const supportCoverage = segmentCount > 0
        ? supportedSegments / segmentCount
        : 0;
    const pathQuality = clamp01(
        pathCore
        * (0.5 + 0.25 * supportCoverage + 0.25 * tagClosure)
    );
    const action = -Math.log(Math.max(1e-12, pathQuality));

    return Object.freeze({
        schema: 'tagmemo-v10-alpha-path-geometry-v1',
        candidateId: Number(curve?.id ?? curve?.chunkId),
        pathQuality,
        action,
        pathCore,
        tagClosure,
        supportMode,
        minimumSupportedPotential,
        supportCoverage,
        segmentCount,
        supportedSegments,
        transferSegments,
        meanDirection: segmentCount > 0 ? directionMass / segmentCount : 0,
        meanContinuity: segmentCount > 0 ? continuityMass / segmentCount : 0,
        meanLocalPotential: segmentCount > 0 ? localPotentialMass / segmentCount : 0,
        meanTransferPotential: segmentCount > 0 ? transferPotentialMass / segmentCount : 0,
        segments: Object.freeze(segmentAttributions),
        unsupportedReason: chain.length === 0
            ? 'missing-tag-curve'
            : supportedSegments === 0
                ? 'no-supported-segment'
                : null
    });
}

function evaluateCandidateCurves(curves, queryState, options = {}) {
    const fieldWorkspace = resolveFieldWorkspace(queryState, options);
    const sharedOptions = { ...options, fieldWorkspace };
    const results = (Array.isArray(curves) ? curves : [])
        .map(curve => Object.freeze({
            curve,
            geometry: evaluateUnifiedPath(curve, queryState, sharedOptions)
        }));
    return Object.freeze({
        schema: 'tagmemo-v10-alpha-path-batch-v1',
        results: Object.freeze(results),
        diagnostics: Object.freeze({
            candidates: results.length,
            supported: results.filter(item =>
                item.geometry.supportedSegments > 0
            ).length,
            meanCoverage: results.length > 0
                ? results.reduce(
                    (sum, item) => sum + item.geometry.supportCoverage,
                    0
                ) / results.length
                : 0
        })
    });
}

module.exports = {
    cosine,
    domainSet,
    evaluateUnifiedPath,
    evaluateCandidateCurves
};