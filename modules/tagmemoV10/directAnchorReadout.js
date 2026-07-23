'use strict';

const { cosine } = require('./unifiedPathGeometry');

const SCHEMA = 'tagmemo-v10-direct-anchor-batch-v1';

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function freezeContact(contact) {
    return Object.freeze(contact);
}

function freezeResult(result) {
    return Object.freeze({
        ...result,
        contacts: Object.freeze(result.contacts.map(freezeContact))
    });
}

function normalizeMap(value) {
    if (value instanceof Map) return value;
    if (Array.isArray(value)) return new Map(value);
    if (value && typeof value === 'object') return new Map(Object.entries(value));
    return new Map();
}

function extractAnchorSeeds(queryState) {
    const sourceField = Array.isArray(queryState?.sourceField)
        ? queryState.sourceField
        : [];
    const massById = new Map(
        sourceField
            .map(entry => [Number(entry?.[0]), Math.max(0, Number(entry?.[1]) || 0)])
            .filter(([id, mass]) => Number.isFinite(id) && id > 0 && mass > 0)
    );
    const provenanceEntries = Array.isArray(
        queryState?.sourceObservation?.fieldProvenance
    )
        ? queryState.sourceObservation.fieldProvenance
        : [];
    const directIds = new Set();

    for (const entry of provenanceEntries) {
        const id = Number(entry?.[0]);
        const provenance = entry?.[1] || {};
        if (
            Number.isFinite(id)
            && Number(provenance.hop) === 0
            && (
                provenance.sourceType === 'core'
                || provenance.sourceType === 'seed'
            )
        ) {
            directIds.add(id);
        }
    }

    const fallback = directIds.size === 0;
    const selectedIds = fallback ? [...massById.keys()] : [...directIds];
    const seeds = selectedIds
        .map(id => ({
            tagId: id,
            mass: massById.get(id) || 0
        }))
        .filter(seed => seed.mass > 0)
        .sort((left, right) =>
            (right.mass - left.mass) || (left.tagId - right.tagId)
        );

    return { seeds, fallback };
}

function findContact(seed, curve, anchorTagVectorById, semanticThreshold) {
    const tagCurve = Array.isArray(curve?.tagCurve) ? curve.tagCurve : [];
    const exact = tagCurve.find(tag => Number(tag?.id) === seed.tagId);
    if (exact) {
        return {
            seedTagId: seed.tagId,
            candidateTagId: Number(exact.id),
            candidateTag: exact,
            exact: true,
            similarity: 1
        };
    }

    const seedVector = anchorTagVectorById.get(seed.tagId);
    if (!seedVector) return null;

    let best = null;
    for (const tag of tagCurve) {
        if (!tag?.vector) continue;
        const similarity = cosine(seedVector, tag.vector);
        if (
            similarity >= semanticThreshold
            && (!best || similarity > best.similarity)
        ) {
            best = {
                seedTagId: seed.tagId,
                candidateTagId: Number(tag.id),
                candidateTag: tag,
                exact: false,
                similarity
            };
        }
    }
    return best;
}

/**
 * 在整批候选原生 Tag 边界上读取 hop=0 的 Query Seed/Core 落点。
 * 第一遍建立接触与池内频率，第二遍计算稀有度、特异性、闭合和可靠度。
 *
 * @param {object} pathBatch 候选路径批
 * @param {object} queryState V10 查询状态
 * @param {object} options 批量向量、Artifact 统计与可回放参数
 * @returns {Readonly<object>}
 */
function computeDirectAnchorBatch(pathBatch, queryState, options = {}) {
    const semanticThreshold = clamp01(options.semanticThreshold ?? 0.8);
    const semanticDiscount = clamp01(options.semanticDiscount ?? 0.7);
    const specificityFloor = clamp01(options.specificityFloor ?? 0.35);
    const reliabilitySeedSaturation = Math.max(
        1,
        Number(options.reliabilitySeedSaturation) || 2
    );
    const fallbackReliabilityCap = clamp01(
        options.fallbackReliabilityCap ?? 0.5
    );
    const traceLimit = Math.max(0, Math.floor(Number(options.traceLimit) || 8));
    const inboundMassView = normalizeMap(options.inboundMassView);
    const anchorTagVectorById = normalizeMap(options.anchorTagVectorById);
    const configuredMaxInbound = Number(options.maxInbound);
    const maxInbound = Number.isFinite(configuredMaxInbound)
        && configuredMaxInbound > 0
        ? configuredMaxInbound
        : 0;
    const specificityUnavailable = maxInbound <= 0;
    const resultsInput = Array.isArray(pathBatch?.results)
        ? pathBatch.results
        : [];
    const { seeds, fallback } = extractAnchorSeeds(queryState);

    const contactsByCandidate = [];
    const poolContactCounts = new Map(seeds.map(seed => [seed.tagId, 0]));

    // 第一遍：每个候选对每个锚种子最多形成一个最佳接触。
    for (const item of resultsInput) {
        const curve = item?.curve || item;
        const contacts = [];
        for (const seed of seeds) {
            const contact = findContact(
                seed,
                curve,
                anchorTagVectorById,
                semanticThreshold
            );
            if (!contact) continue;
            contacts.push({ ...contact, mass: seed.mass });
            poolContactCounts.set(
                seed.tagId,
                (poolContactCounts.get(seed.tagId) || 0) + 1
            );
        }
        contactsByCandidate.push(contacts);
    }

    // 第二遍：使用批级接触频率计算候选观测。
    const results = resultsInput.map((item, index) => {
        const curve = item?.curve || item;
        const chunkVector = curve?.chunkVector;
        const contacts = contactsByCandidate[index];
        let contributionSum = 0;
        let closureSum = 0;
        let exactContacts = 0;
        let semanticContacts = 0;
        const observations = [];

        for (const contact of contacts) {
            const inbound = Math.max(
                0,
                Number(inboundMassView.get(contact.candidateTagId)) || 0
            );
            const specificity = specificityUnavailable
                ? 1
                : Math.max(
                    specificityFloor,
                    1 - Math.sqrt(clamp01(inbound / maxInbound))
                );
            const closure = clamp01(
                cosine(contact.candidateTag?.vector, chunkVector)
            );
            const poolCount = poolContactCounts.get(contact.seedTagId) || 0;
            const rarity = 1 / Math.sqrt(1 + poolCount);
            const matchWeight = contact.exact ? 1 : semanticDiscount;
            const contribution = contact.mass
                * specificity
                * closure
                * rarity
                * matchWeight;

            contributionSum += contribution;
            closureSum += closure;
            if (contact.exact) exactContacts++;
            else semanticContacts++;
            observations.push({
                seedTagId: contact.seedTagId,
                candidateTagId: contact.candidateTagId,
                exact: contact.exact,
                similarity: contact.similarity,
                mass: contact.mass,
                specificity,
                closure,
                rarity,
                matchWeight,
                contribution
            });
        }

        const contactedSeeds = contacts.length;
        const meanClosure = contactedSeeds > 0
            ? closureSum / contactedSeeds
            : 0;
        const anchorScore = clamp01(
            contributionSum / Math.sqrt(Math.max(1, contactedSeeds))
        );
        let anchorReliability = clamp01(Math.sqrt(
            meanClosure
            * Math.min(1, contactedSeeds / reliabilitySeedSaturation)
        ));
        if (fallback) {
            anchorReliability = Math.min(
                fallbackReliabilityCap,
                anchorReliability
            );
        }

        observations.sort((left, right) =>
            (right.contribution - left.contribution)
            || (left.seedTagId - right.seedTagId)
        );

        return freezeResult({
            anchorScore,
            anchorReliability,
            contactedSeeds,
            exactContacts,
            semanticContacts,
            meanClosure,
            fallbackProvenance: fallback,
            contacts: observations.slice(0, traceLimit)
        });
    });

    return Object.freeze({
        schema: SCHEMA,
        results: Object.freeze(results),
        diagnostics: Object.freeze({
            anchorSeedCount: seeds.length,
            candidateCount: resultsInput.length,
            fallbackProvenance: fallback,
            fallbackReliabilityCap,
            specificityUnavailable,
            maxInbound,
            poolContactCounts: Object.freeze(
                [...poolContactCounts.entries()]
                    .sort((left, right) => left[0] - right[0])
                    .map(entry => Object.freeze(entry.slice()))
            ),
            parameters: Object.freeze({
                semanticThreshold,
                semanticDiscount,
                specificityFloor,
                reliabilitySeedSaturation,
                fallbackReliabilityCap,
                traceLimit
            })
        })
    });
}

module.exports = {
    SCHEMA,
    computeDirectAnchorBatch
};