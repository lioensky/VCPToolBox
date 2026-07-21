'use strict';

const { cosine } = require('./unifiedPathGeometry');

const OBSERVABLE_NAMES = Object.freeze([
    'direct',
    'structural',
    'thematic',
    'closure'
]);

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function toFieldMap(entries) {
    return new Map(
        (Array.isArray(entries) ? entries : [])
            .map(entry => [Number(entry[0]), Math.max(0, Number(entry[1]) || 0)])
            .filter(([id, mass]) => Number.isFinite(id) && mass > 0)
    );
}

function semanticSimilarity(left, right, mode = 'positive') {
    const value = cosine(left, right);
    return String(mode).toLowerCase() === 'shifted'
        ? clamp01((value + 1) / 2)
        : clamp01(value);
}

function normalizedField(field) {
    let maximum = 0;
    for (const value of field.values()) maximum = Math.max(maximum, value);
    if (maximum <= 0) return field;
    return new Map([...field.entries()].map(([id, value]) => [id, value / maximum]));
}

function sourceIds(queryState) {
    return new Set(
        (Array.isArray(queryState?.sourceField) ? queryState.sourceField : [])
            .map(entry => Number(entry[0]))
            .filter(Number.isFinite)
    );
}

function domainIds(domain) {
    return new Set(
        Array.isArray(domain?.ids)
            ? domain.ids.map(Number).filter(Number.isFinite)
            : []
    );
}

function vectorWeightedClosure(curve, local, transfer, options = {}) {
    const chain = Array.isArray(curve?.tagCurve) ? curve.tagCurve : [];
    const chunkVector = curve?.chunkVector;
    if (!chunkVector || chain.length === 0) {
        return Object.freeze({
            score: 0,
            weightedTagCount: 0,
            vectorAvailable: false
        });
    }

    const dimension = chunkVector.length;
    const aggregate = new Float64Array(dimension);
    let totalWeight = 0;
    let weightedTagCount = 0;
    const transferWeight = clamp01(options.transferWeight ?? 0.4);
    const localWeight = clamp01(options.localWeight ?? 0.6);
    const scale = localWeight + transferWeight || 1;

    for (const tag of chain) {
        if (!tag.vector || tag.vector.length !== dimension) continue;
        const weight = (
            localWeight * (local.get(Number(tag.id)) || 0)
            + transferWeight * (transfer.get(Number(tag.id)) || 0)
        ) / scale;
        if (weight <= 0) continue;
        for (let index = 0; index < dimension; index++) {
            aggregate[index] += (Number(tag.vector[index]) || 0) * weight;
        }
        totalWeight += weight;
        weightedTagCount++;
    }

    if (totalWeight <= 0) {
        return Object.freeze({
            score: 0,
            weightedTagCount: 0,
            vectorAvailable: true
        });
    }

    for (let index = 0; index < aggregate.length; index++) {
        aggregate[index] /= totalWeight;
    }
    return Object.freeze({
        score: semanticSimilarity(
            aggregate,
            chunkVector,
            options.semanticSimilarityMode
        ),
        weightedTagCount,
        vectorAvailable: true
    });
}

function computeDstcObservables(curve, geometry, queryState, options = {}) {
    const disabled = new Set(
        Array.isArray(options.disabledObservables)
            ? options.disabledObservables.map(value => String(value).toLowerCase())
            : []
    );
    const chain = Array.isArray(curve?.tagCurve) ? curve.tagCurve : [];
    const local = normalizedField(toFieldMap(queryState?.localField));
    const transfer = normalizedField(toFieldMap(queryState?.transferField));
    const seeds = sourceIds(queryState);
    const localDomain = domainIds(queryState?.localDomain);
    const transferDomain = domainIds(queryState?.transferDomain);

    let exactSeedHits = 0;
    let localContacts = 0;
    let transferContacts = 0;
    let localPotential = 0;
    let transferPotential = 0;
    let tailOnlyContacts = 0;
    let isolatedContacts = 0;
    let previousContact = false;

    for (let index = 0; index < chain.length; index++) {
        const id = Number(chain[index].id);
        const localMass = local.get(id) || 0;
        const transferMass = transfer.get(id) || 0;
        const contacted = localMass > 0 || transferMass > 0;
        const next = chain[index + 1];
        const nextContact = next
            ? (local.get(Number(next.id)) || 0) > 0
                || (transfer.get(Number(next.id)) || 0) > 0
            : false;

        if (seeds.has(id)) exactSeedHits++;
        if (localDomain.has(id)) localContacts++;
        if (transferDomain.has(id)) transferContacts++;
        localPotential += localMass;
        transferPotential += transferMass;
        if (contacted && !localDomain.has(id) && !transferDomain.has(id)) tailOnlyContacts++;
        if (contacted && !previousContact && !nextContact) isolatedContacts++;
        previousContact = contacted;
    }

    const chainSize = Math.max(1, chain.length);
    const identityEligible = options.identityEligible === true;
    const visibilityEligible = options.visibilityEligible !== false;
    const directContact = clamp01(exactSeedHits / Math.max(1, seeds.size));
    const directScore = visibilityEligible
        ? clamp01(0.75 * directContact + 0.25 * (identityEligible ? 1 : 0))
        : 0;
    const localCoverage = localContacts / chainSize;
    const transferCoverage = transferContacts / chainSize;
    const localMeanPotential = localPotential / chainSize;
    const transferMeanPotential = transferPotential / chainSize;
    const tailOnlyRatio = tailOnlyContacts / chainSize;
    const isolatedContactRatio = isolatedContacts / chainSize;
    const dualScaleAgreement = 1 - Math.abs(
        clamp01(localMeanPotential) - clamp01(transferMeanPotential)
    );
    const thematicScore = clamp01(
        0.25 * localCoverage
        + 0.2 * transferCoverage
        + 0.2 * clamp01(localMeanPotential)
        + 0.15 * clamp01(transferMeanPotential)
        + 0.2 * dualScaleAgreement
    ) * (1 - 0.5 * clamp01(tailOnlyRatio));
    const tagClosure = vectorWeightedClosure(curve, local, transfer, options);
    const queryVector = queryState?.query?.vector;
    const queryChunkAvailable = Boolean(
        queryVector
        && curve?.chunkVector
        && queryVector.length === curve.chunkVector.length
    );
    const queryChunkScore = queryChunkAvailable
        ? semanticSimilarity(
            queryVector,
            curve.chunkVector,
            options.semanticSimilarityMode
        )
        : 0;
    const closureMode = String(options.closureMode || 'query_weighted')
        .trim()
        .toLowerCase();
    const queryClosureWeight = clamp01(options.queryClosureWeight ?? 0.65);
    const tagClosureWeight = clamp01(options.tagClosureWeight ?? 0.35);
    const closureWeightTotal = queryClosureWeight + tagClosureWeight || 1;
    const closureScore = closureMode === 'tag_only'
        ? tagClosure.score
        : queryChunkAvailable
            ? clamp01(
                (
                    queryClosureWeight * queryChunkScore
                    + tagClosureWeight * tagClosure.score
                ) / closureWeightTotal
            )
            : tagClosure.score;
    const structuralScore = clamp01(geometry?.pathQuality);

    const values = {
        direct: disabled.has('direct') ? 0 : directScore,
        structural: disabled.has('structural') ? 0 : structuralScore,
        thematic: disabled.has('thematic') ? 0 : thematicScore,
        closure: disabled.has('closure') ? 0 : closureScore
    };

    return Object.freeze({
        schema: 'tagmemo-v10-alpha-dstc-v1',
        candidateId: Number(curve?.id ?? curve?.chunkId),
        values: Object.freeze(values),
        disabledObservables: Object.freeze([...disabled]),
        direct: Object.freeze({
            score: values.direct,
            exactSeedHits,
            identityEligible,
            visibilityEligible,
            legal: visibilityEligible
        }),
        structural: Object.freeze({
            score: values.structural,
            pathQuality: structuralScore,
            supportCoverage: clamp01(geometry?.supportCoverage),
            meanDirection: clamp01(geometry?.meanDirection),
            meanContinuity: clamp01(geometry?.meanContinuity),
            transferSegments: Number(geometry?.transferSegments) || 0
        }),
        thematic: Object.freeze({
            score: values.thematic,
            localCoverage,
            transferCoverage,
            localPotential: localMeanPotential,
            transferPotential: transferMeanPotential,
            tailOnlyRatio,
            isolatedContactRatio,
            dualScaleAgreement
        }),
        closure: Object.freeze({
            score: values.closure,
            mode: closureMode,
            semanticSimilarityMode: String(
                options.semanticSimilarityMode || 'positive'
            ),
            queryChunkScore,
            tagChunkScore: tagClosure.score,
            queryClosureWeight,
            tagClosureWeight,
            queryVectorAvailable: queryChunkAvailable,
            weightedTagCount: tagClosure.weightedTagCount,
            vectorAvailable: tagClosure.vectorAvailable
        })
    });
}

function computeDstcBatch(pathBatch, queryState, options = {}) {
    const results = (Array.isArray(pathBatch?.results) ? pathBatch.results : [])
        .map(item => Object.freeze({
            curve: item.curve,
            geometry: item.geometry,
            observables: computeDstcObservables(
                item.curve,
                item.geometry,
                queryState,
                {
                    ...options,
                    identityEligible: typeof options.identityEligibility === 'function'
                        ? options.identityEligibility(item.curve, queryState) === true
                        : options.identityEligible === true,
                    visibilityEligible: typeof options.visibilityEligibility === 'function'
                        ? options.visibilityEligibility(item.curve, queryState) !== false
                        : options.visibilityEligible !== false
                }
            )
        }));

    return Object.freeze({
        schema: 'tagmemo-v10-alpha-dstc-batch-v1',
        results: Object.freeze(results),
        disabledObservables: Object.freeze(
            Array.isArray(options.disabledObservables)
                ? options.disabledObservables.slice()
                : []
        )
    });
}

module.exports = {
    OBSERVABLE_NAMES,
    semanticSimilarity,
    computeDstcObservables,
    computeDstcBatch
};