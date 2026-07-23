'use strict';

const SOURCE_ORDER = Object.freeze([
    'query_knn',
    'denoised_field_knn',
    'local_field_knn',
    'transfer_field_knn',
    'bm25',
    'anchor_direct'
]);

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function candidateId(item) {
    const raw = item?.id ?? item?.chunkId ?? item?.label;
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : String(raw || '');
}

function normalizeSource(items, source) {
    const valid = (Array.isArray(items) ? items : [])
        .map((item, index) => ({
            item,
            id: candidateId(item),
            rawScore: Number(
                item?.score
                ?? item?.hybridScore
                ?? item?.vectorScore
                ?? item?.bm25Score
                ?? 0
            ) || 0,
            sourceRank: index + 1
        }))
        .filter(entry => entry.id !== '');

    if (valid.length === 0) return [];
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const entry of valid) {
        minimum = Math.min(minimum, entry.rawScore);
        maximum = Math.max(maximum, entry.rawScore);
    }
    const spread = maximum - minimum;

    return valid.map(entry => Object.freeze({
        ...entry,
        source,
        normalizedScore: spread > 1e-12
            ? clamp01((entry.rawScore - minimum) / spread)
            : clamp01(1 / entry.sourceRank)
    }));
}

function resolveQuotas(config, nonEmptySources, cap) {
    const explicit = config.minimumQuota || config.minimumQuotas || {};
    const quotas = {};
    let explicitTotal = 0;
    for (const source of nonEmptySources) {
        const value = Math.max(0, Math.floor(Number(explicit[source]) || 0));
        quotas[source] = value;
        explicitTotal += value;
    }

    if (explicitTotal === 0) {
        const fair = Math.max(1, Math.floor(cap / Math.max(1, nonEmptySources.length) * 0.35));
        for (const source of nonEmptySources) quotas[source] = fair;
    }

    let quotaTotal = nonEmptySources.reduce((sum, source) => sum + quotas[source], 0);
    if (quotaTotal > cap) {
        // 配额超出总上限时按 SOURCE_ORDER 确定性轮转分配，至少不让第一路吞掉全部预算。
        for (const source of nonEmptySources) quotas[source] = 0;
        let remaining = cap;
        let cursor = 0;
        while (remaining > 0 && nonEmptySources.length > 0) {
            quotas[nonEmptySources[cursor % nonEmptySources.length]]++;
            remaining--;
            cursor++;
        }
        quotaTotal = cap;
    }
    return Object.freeze({ quotas: Object.freeze(quotas), quotaTotal });
}

function buildCandidateSuperset(sourceCandidates = {}, config = {}) {
    const cap = Math.max(1, Math.floor(Number(config.maxUnionCandidates) || 300));
    const normalizedBySource = {};
    const nonEmptySources = [];
    for (const source of SOURCE_ORDER) {
        normalizedBySource[source] = normalizeSource(sourceCandidates[source], source);
        if (normalizedBySource[source].length > 0) nonEmptySources.push(source);
    }

    const merged = new Map();
    for (const source of SOURCE_ORDER) {
        for (const entry of normalizedBySource[source]) {
            if (!merged.has(entry.id)) {
                merged.set(entry.id, {
                    id: entry.id,
                    canonical: { ...entry.item },
                    sources: new Map(),
                    firstSourceOrder: SOURCE_ORDER.indexOf(source)
                });
            }
            const candidate = merged.get(entry.id);
            const previous = candidate.sources.get(source);
            if (!previous || entry.sourceRank < previous.sourceRank) {
                candidate.sources.set(source, entry);
            }
            // 保留更完整文本，但不让后到来源覆盖 chunk 身份。
            if (!candidate.canonical.text && entry.item?.text) {
                candidate.canonical.text = entry.item.text;
            }
        }
    }

    const candidates = [...merged.values()].map(candidate => {
        const sourceEntries = [...candidate.sources.values()];
        const maxNormalized = Math.max(...sourceEntries.map(entry => entry.normalizedScore), 0);
        const meanNormalized = sourceEntries.reduce(
            (sum, entry) => sum + entry.normalizedScore,
            0
        ) / Math.max(1, sourceEntries.length);
        const reciprocalRank = sourceEntries.reduce(
            (sum, entry) => sum + 1 / (60 + entry.sourceRank),
            0
        );
        const multiSourceBonus = Math.min(0.2, 0.05 * (sourceEntries.length - 1));
        const unionScore = clamp01(
            0.5 * maxNormalized
            + 0.25 * meanNormalized
            + 0.25 * clamp01(reciprocalRank * 20)
            + multiSourceBonus
        );
        return {
            ...candidate,
            sourceEntries,
            sourceCount: sourceEntries.length,
            unionScore
        };
    });

    const compareCandidates = (left, right) =>
        (right.sourceCount - left.sourceCount)
        || (right.unionScore - left.unionScore)
        || (left.firstSourceOrder - right.firstSourceOrder)
        || String(left.id).localeCompare(String(right.id));

    const { quotas } = resolveQuotas(config, nonEmptySources, cap);
    const selected = new Map();
    const selectedByQuota = new Set();

    // 第一阶段：每路最低配额。各路内部优先多来源，再看该路归一分与统一分。
    for (const source of SOURCE_ORDER) {
        const quota = quotas[source] || 0;
        if (quota <= 0) continue;
        const ranked = candidates
            .filter(candidate => candidate.sources.has(source))
            .sort((left, right) =>
                (right.sourceCount - left.sourceCount)
                || (
                    right.sources.get(source).normalizedScore
                    - left.sources.get(source).normalizedScore
                )
                || (right.unionScore - left.unionScore)
                || String(left.id).localeCompare(String(right.id))
            );
        let admitted = 0;
        for (const candidate of ranked) {
            if (selected.size >= cap || admitted >= quota) break;
            if (!selected.has(candidate.id)) {
                selected.set(candidate.id, candidate);
                selectedByQuota.add(candidate.id);
                admitted++;
            }
        }
    }

    // 第二阶段：多来源优先，剩余位置按统一归一分竞争。
    const remaining = candidates
        .filter(candidate => !selected.has(candidate.id))
        .sort(compareCandidates);
    for (const candidate of remaining) {
        if (selected.size >= cap) break;
        selected.set(candidate.id, candidate);
    }

    const selectedCandidates = [...selected.values()].sort(compareCandidates);
    const selectedIds = new Set(selectedCandidates.map(candidate => candidate.id));
    const dropped = candidates
        .filter(candidate => !selectedIds.has(candidate.id))
        .sort(compareCandidates);
    const sourceDiagnostics = {};

    for (const source of SOURCE_ORDER) {
        const sourceList = normalizedBySource[source];
        const sourceIds = new Set(sourceList.map(entry => entry.id));
        const entered = [...sourceIds].filter(id => selectedIds.has(id)).length;
        const exclusive = selectedCandidates.filter(candidate =>
            candidate.sources.has(source) && candidate.sourceCount === 1
        ).length;
        const droppedCount = sourceIds.size - entered;
        sourceDiagnostics[source] = Object.freeze({
            offered: sourceIds.size,
            entered,
            exclusive,
            dropped: droppedCount,
            quota: quotas[source] || 0,
            entryRate: sourceIds.size > 0 ? entered / sourceIds.size : 0,
            exclusiveRate: entered > 0 ? exclusive / entered : 0,
            dropRate: sourceIds.size > 0 ? droppedCount / sourceIds.size : 0
        });
    }

    const output = selectedCandidates.map((candidate, index) => Object.freeze({
        ...candidate.canonical,
        id: candidate.id,
        chunkId: candidate.canonical.chunkId ?? candidate.id,
        candidateUnionRank: index + 1,
        candidateUnionScore: candidate.unionScore,
        candidateSources: Object.freeze(
            candidate.sourceEntries
                .sort((left, right) =>
                    SOURCE_ORDER.indexOf(left.source) - SOURCE_ORDER.indexOf(right.source)
                )
                .map(entry => Object.freeze({
                    source: entry.source,
                    rank: entry.sourceRank,
                    rawScore: entry.rawScore,
                    normalizedScore: entry.normalizedScore
                }))
        ),
        candidateSourceCount: candidate.sourceCount,
        admittedByMinimumQuota: selectedByQuota.has(candidate.id)
    }));

    return Object.freeze({
        schema: 'tagmemo-v10-alpha-candidate-superset-v1',
        candidates: Object.freeze(output),
        diagnostics: Object.freeze({
            offeredUnique: candidates.length,
            selectedUnique: output.length,
            maxUnionCandidates: cap,
            capApplied: candidates.length > cap,
            multiSourceSelected: selectedCandidates.filter(item => item.sourceCount > 1).length,
            droppedByUnionCap: Object.freeze(dropped.map(candidate => Object.freeze({
                id: candidate.id,
                sources: Object.freeze([...candidate.sources.keys()]),
                sourceCount: candidate.sourceCount,
                unionScore: candidate.unionScore
            }))),
            sources: Object.freeze(sourceDiagnostics)
        })
    });
}

module.exports = {
    SOURCE_ORDER,
    buildCandidateSuperset
};