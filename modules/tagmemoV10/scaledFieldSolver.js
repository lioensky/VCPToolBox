'use strict';

function clamp(value, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return min;
    return Math.max(min, Math.min(max, numeric));
}

function l1Distance(left, right) {
    let distance = 0;
    for (let index = 0; index < left.length; index++) {
        distance += Math.abs((Number(left[index]) || 0) - (Number(right[index]) || 0));
    }
    return distance;
}

function vectorMass(vector) {
    let mass = 0;
    for (const value of vector) mass += Math.max(0, Number(value) || 0);
    return mass;
}

function normalizeSource(operator, sourceField) {
    const source = new Float64Array(operator.nodeCount);
    if (sourceField instanceof Map) {
        for (const [rawId, rawMass] of sourceField.entries()) {
            const index = operator.nodeIndexOf(rawId);
            const mass = Math.max(0, Number(rawMass) || 0);
            if (index !== undefined && mass > 0) source[index] += mass;
        }
    } else if (Array.isArray(sourceField)) {
        for (const entry of sourceField) {
            if (!Array.isArray(entry) || entry.length < 2) continue;
            const index = operator.nodeIndexOf(entry[0]);
            const mass = Math.max(0, Number(entry[1]) || 0);
            if (index !== undefined && mass > 0) source[index] += mass;
        }
    } else if (sourceField && typeof sourceField.length === 'number') {
        if (sourceField.length !== operator.nodeCount) {
            throw new RangeError(`Source field length must be ${operator.nodeCount}`);
        }
        for (let index = 0; index < source.length; index++) {
            source[index] = Math.max(0, Number(sourceField[index]) || 0);
        }
    }

    const mass = vectorMass(source);
    if (mass <= 0) {
        const error = new Error('V10 source field contains no positive mass');
        error.code = 'TAGMEMO_V10_EMPTY_SOURCE';
        throw error;
    }
    for (let index = 0; index < source.length; index++) source[index] /= mass;
    return source;
}

function effectiveSupport(vector, operator, options = {}) {
    const method = String(options.method || 'mass_ratio').toLowerCase();
    const massRatio = clamp(options.massRatio ?? 0.9, 0.01, 1);
    const positive = [];
    let totalMass = 0;
    let squareMass = 0;
    let entropy = 0;

    for (let index = 0; index < vector.length; index++) {
        const mass = Math.max(0, Number(vector[index]) || 0);
        if (mass <= 0) continue;
        positive.push({
            id: operator.nodeIdAt(index),
            index,
            mass
        });
        totalMass += mass;
        squareMass += mass * mass;
    }
    positive.sort((left, right) =>
        (right.mass - left.mass) || (left.id - right.id)
    );

    if (totalMass <= 0) {
        return Object.freeze({
            method,
            ids: Object.freeze([]),
            size: 0,
            totalMass: 0,
            retainedMass: 0,
            retainedMassRatio: 0,
            tailMass: 0,
            shannonEffectiveSize: 0,
            participationRatio: 0
        });
    }

    for (const item of positive) {
        const probability = item.mass / totalMass;
        entropy -= probability * Math.log(probability);
    }
    const shannonEffectiveSize = Math.exp(entropy);
    const participationRatio = squareMass > 0
        ? (totalMass * totalMass) / squareMass
        : 0;

    let targetCount = positive.length;
    if (method === 'shannon') {
        targetCount = Math.max(1, Math.ceil(shannonEffectiveSize));
    } else if (method === 'participation_ratio') {
        targetCount = Math.max(1, Math.ceil(participationRatio));
    } else if (method === 'spectral_gap' && positive.length > 1) {
        let largestGap = -Infinity;
        let largestGapIndex = 0;
        for (let index = 0; index + 1 < positive.length; index++) {
            const gap = positive[index].mass - positive[index + 1].mass;
            if (gap > largestGap) {
                largestGap = gap;
                largestGapIndex = index;
            }
        }
        targetCount = largestGapIndex + 1;
    }

    const retained = [];
    let retainedMass = 0;
    if (method === 'mass_ratio' || method === 'tail_budget') {
        for (const item of positive) {
            retained.push(item);
            retainedMass += item.mass;
            if (retainedMass / totalMass >= massRatio) break;
        }
    } else {
        retained.push(...positive.slice(0, targetCount));
        retainedMass = retained.reduce((sum, item) => sum + item.mass, 0);
    }

    return Object.freeze({
        method,
        ids: Object.freeze(retained.map(item => item.id)),
        entries: Object.freeze(retained.map(item => Object.freeze({
            id: item.id,
            mass: item.mass,
            normalizedMass: item.mass / totalMass
        }))),
        size: retained.length,
        totalMass,
        retainedMass,
        retainedMassRatio: retainedMass / totalMass,
        tailMass: Math.max(0, totalMass - retainedMass),
        shannonEffectiveSize,
        participationRatio
    });
}

function fieldToEntries(vector, operator) {
    const entries = [];
    for (let index = 0; index < vector.length; index++) {
        const mass = Math.max(0, Number(vector[index]) || 0);
        if (mass > 0) entries.push(Object.freeze([operator.nodeIdAt(index), mass]));
    }
    entries.sort((left, right) => (right[1] - left[1]) || (left[0] - right[0]));
    return Object.freeze(entries);
}

/**
 * 同一迭代框架中并行求解：
 * u = (1-alpha)S + alpha T(u)
 *
 * 两个尺度共享循环调度；若调用方传入同一个条件化算子，则通过 packed apply
 * 在一次逐行遍历中同时传播 Local/Transfer。不同算子时仍保持状态同步，但分别 apply。
 */
function solveDualScaledFields(options = {}) {
    const localOperator = options.localOperator || options.operator;
    const transferOperator = options.transferOperator || options.operator || localOperator;
    if (!localOperator || !transferOperator) {
        throw new TypeError('solveDualScaledFields requires conditioned operators');
    }
    if (localOperator.nodeCount !== transferOperator.nodeCount) {
        throw new RangeError('Local and transfer operators must share the same node space');
    }

    const source = normalizeSource(localOperator, options.sourceField);
    const localConfig = options.local || {};
    const transferConfig = options.transfer || {};
    const alphaLocal = clamp(localConfig.alpha ?? 0.15, 0, 0.999999);
    const alphaTransfer = clamp(transferConfig.alpha ?? 0.55, 0, 0.999999);
    const maxIterations = Math.max(
        1,
        Math.floor(Math.max(
            Number(localConfig.maxIterations) || 80,
            Number(transferConfig.maxIterations) || 80
        ))
    );
    const localTolerance = Math.max(1e-15, Number(localConfig.tolerance) || 1e-9);
    const transferTolerance = Math.max(1e-15, Number(transferConfig.tolerance) || 1e-9);

    let local = Float64Array.from(source);
    let transfer = Float64Array.from(source);
    let nextLocal = new Float64Array(source.length);
    let nextTransfer = new Float64Array(source.length);
    const propagatedLocal = new Float64Array(source.length);
    const propagatedTransfer = new Float64Array(source.length);
    let localResidual = Infinity;
    let transferResidual = Infinity;
    let localConverged = false;
    let transferConverged = false;
    let iterations = 0;
    const iterationTrace = [];
    const aggregateDiagnostics = {
        local: { visitedEdges: 0, permittedEdges: 0, forbiddenMass: 0, propagatedMass: 0 },
        transfer: { visitedEdges: 0, permittedEdges: 0, forbiddenMass: 0, propagatedMass: 0 }
    };

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
        iterations = iteration;
        const localApplyDiagnostics = {};
        const transferApplyDiagnostics = {};
        localOperator.apply(local, propagatedLocal, localApplyDiagnostics);
        transferOperator.apply(transfer, propagatedTransfer, transferApplyDiagnostics);

        for (let index = 0; index < source.length; index++) {
            nextLocal[index] = (1 - alphaLocal) * source[index]
                + alphaLocal * propagatedLocal[index];
            nextTransfer[index] = (1 - alphaTransfer) * source[index]
                + alphaTransfer * propagatedTransfer[index];
        }

        localResidual = l1Distance(nextLocal, local);
        transferResidual = l1Distance(nextTransfer, transfer);
        localConverged = localResidual <= localTolerance;
        transferConverged = transferResidual <= transferTolerance;

        for (const [key, value] of Object.entries(localApplyDiagnostics)) {
            aggregateDiagnostics.local[key] += Number(value) || 0;
        }
        for (const [key, value] of Object.entries(transferApplyDiagnostics)) {
            aggregateDiagnostics.transfer[key] += Number(value) || 0;
        }

        iterationTrace.push(Object.freeze({
            iteration,
            localResidual,
            transferResidual,
            localMass: vectorMass(nextLocal),
            transferMass: vectorMass(nextTransfer)
        }));

        [local, nextLocal] = [nextLocal, local];
        [transfer, nextTransfer] = [nextTransfer, transfer];
        if (localConverged && transferConverged) break;
    }

    const localSupportOptions = {
        method: options.localSupport?.method
            || options.support?.method
            || 'mass_ratio',
        massRatio: options.localSupport?.massRatio
            ?? options.support?.localMassRatio
            ?? 0.8
    };
    const transferSupportOptions = {
        method: options.transferSupport?.method
            || options.support?.method
            || 'mass_ratio',
        massRatio: options.transferSupport?.massRatio
            ?? options.support?.transferMassRatio
            ?? 0.9
    };
    const localDomain = effectiveSupport(local, localOperator, localSupportOptions);
    const transferDomain = effectiveSupport(
        transfer,
        transferOperator,
        transferSupportOptions
    );

    const sourceMass = vectorMass(source);
    const localMass = vectorMass(local);
    const transferMass = vectorMass(transfer);
    const diagnostics = Object.freeze({
        iterations,
        converged: localConverged && transferConverged,
        localConverged,
        transferConverged,
        localResidual,
        transferResidual,
        sourceMass,
        localMass,
        transferMass,
        localMassDelta: localMass - sourceMass,
        transferMassDelta: transferMass - sourceMass,
        localOperatorSig: localOperator.operatorSig || null,
        transferOperatorSig: transferOperator.operatorSig || null,
        operatorShared: localOperator === transferOperator,
        localApply: Object.freeze({ ...aggregateDiagnostics.local }),
        transferApply: Object.freeze({ ...aggregateDiagnostics.transfer }),
        iterationTrace: Object.freeze(iterationTrace)
    });

    return Object.freeze({
        sourceVector: Object.freeze(Array.from(source)),
        localVector: Object.freeze(Array.from(local)),
        transferVector: Object.freeze(Array.from(transfer)),
        localField: fieldToEntries(local, localOperator),
        transferField: fieldToEntries(transfer, transferOperator),
        localDomain,
        transferDomain,
        diagnostics
    });
}

module.exports = {
    normalizeSource,
    effectiveSupport,
    solveDualScaledFields
};