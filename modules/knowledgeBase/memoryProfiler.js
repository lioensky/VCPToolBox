'use strict';

function estimateVexusIndexBytes(totalVectors = 0, dimension = 0) {
    const vectorBytes = Math.max(0, Number(totalVectors) || 0)
        * Math.max(0, Number(dimension) || 0)
        * Float32Array.BYTES_PER_ELEMENT;
    return Math.round(vectorBytes * 1.6);
}

function safeIndexStats(index) {
    if (!index || typeof index.stats !== 'function') {
        return { available: false, totalVectors: 0 };
    }

    try {
        const stats = index.stats() || {};
        return {
            available: true,
            ...stats,
            totalVectors: Number(
                stats.totalVectors ?? stats.size ?? stats.vectors ?? 0
            ) || 0
        };
    } catch (error) {
        return {
            available: false,
            totalVectors: 0,
            error: error.message || String(error)
        };
    }
}

function profileTagMemo(tagMemoEngine) {
    if (!tagMemoEngine) {
        return { available: false, estimatedBytes: 0 };
    }

    const cooccurrenceSources = tagMemoEngine.tagCooccurrenceMatrix instanceof Map
        ? tagMemoEngine.tagCooccurrenceMatrix.size
        : 0;
    let cooccurrenceEdges = 0;
    if (tagMemoEngine.tagCooccurrenceMatrix instanceof Map) {
        for (const edges of tagMemoEngine.tagCooccurrenceMatrix.values()) {
            if (edges instanceof Map) cooccurrenceEdges += edges.size;
        }
    }

    const pairwiseSimilarities = tagMemoEngine.tagPairSimilarities instanceof Map
        ? tagMemoEngine.tagPairSimilarities.size
        : 0;
    const intrinsicResiduals = tagMemoEngine.tagIntrinsicResiduals instanceof Map
        ? tagMemoEngine.tagIntrinsicResiduals.size
        : 0;
    const pairwiseEstimatedBytes = pairwiseSimilarities * 80;
    const cooccurrenceEstimatedBytes = cooccurrenceSources * 96
        + cooccurrenceEdges * 64;
    const intrinsicEstimatedBytes = intrinsicResiduals * 32;

    return {
        available: true,
        modelSig: tagMemoEngine.modelSig || null,
        pairwiseSimilarities,
        pairwiseEstimatedBytes,
        cooccurrenceSources,
        cooccurrenceEdges,
        cooccurrenceEstimatedBytes,
        intrinsicResiduals,
        intrinsicEstimatedBytes,
        matrixRebuilding: !!tagMemoEngine._isMatrixRebuilding,
        derivedQueueLength: Array.isArray(tagMemoEngine._derivedTaskQueue)
            ? tagMemoEngine._derivedTaskQueue.length
            : 0,
        estimatedBytes: pairwiseEstimatedBytes
            + cooccurrenceEstimatedBytes
            + intrinsicEstimatedBytes
    };
}

function profileRiverMemo(state) {
    const controlRuntime = state.tagMemoV10Engine;
    if (!controlRuntime) {
        return { available: false, estimatedBytes: 0 };
    }

    const artifact = controlRuntime.getArtifactSnapshot?.({
        buildIfMissing: false
    }) || null;
    let nativeRuntime = null;
    try {
        nativeRuntime = typeof state.tagIndex?.memoRuntimeStats === 'function'
            ? state.tagIndex.memoRuntimeStats()
            : null;
    } catch (error) {
        nativeRuntime = { available: false, error: error.message || String(error) };
    }

    const residentArtifactSig =
        nativeRuntime?.activeArtifactSig
        ?? nativeRuntime?.artifactSig
        ?? null;
    const nativeNodeCount = Math.max(
        0,
        Number(nativeRuntime?.nodeCount) || 0
    );
    const nativeEdgeCount = Math.max(
        0,
        Number(nativeRuntime?.edgeCount) || 0
    );
    const resident = Boolean(
        residentArtifactSig
        && residentArtifactSig === artifact?.artifactSig
    );
    // 仅提供 Rust CSR 数组下界，不把它计入 JS estimatedBytes。
    // HashMap、HashSet、Provenance Vec 与 allocator 开销仍只能由进程 RSS 观察。
    const nativeCsrLowerBoundBytes = resident
        ? nativeNodeCount * 8
            + (nativeNodeCount + 1) * 8
            + nativeEdgeCount * 16
        : 0;
    const conditionedOperator =
        controlRuntime.getConditionedOperatorCacheDiagnostics?.() || null;
    const conditionedEstimatedBytes = Math.max(
        0,
        Number(conditionedOperator?.estimatedBytes) || 0
    );

    return {
        available: true,
        artifactSig: artifact?.artifactSig || null,
        sourceV9ArtifactSig: artifact?.sourceArtifactSig || null,
        generation: artifact?.generation || null,
        nativeGeneration:
            Number(nativeRuntime?.generation)
            || artifact?.nativeGeneration
            || null,
        storageMode: artifact?.storageMode || null,
        resident,
        residentAtControlPublication:
            artifact?.residentAtPublication === true,
        transport: {
            nodeCount: nativeNodeCount || Number(artifact?.nodeCount) || 0,
            edgeCount: nativeEdgeCount || Number(artifact?.edgeCount) || 0,
            estimatedBytes: 0,
            storageMode: 'rust-arc'
        },
        jsGraphAssets: {
            csrResident: false,
            provenanceResident: false,
            pairwiseResident: false,
            estimatedBytes: 0
        },
        conditionedOperator,
        nativeRuntime: {
            available: nativeRuntime !== null
                && nativeRuntime?.available !== false,
            resident,
            activeArtifactSig: residentArtifactSig,
            generation: Number(nativeRuntime?.generation) || 0,
            nodeCount: nativeNodeCount,
            edgeCount: nativeEdgeCount,
            csrLowerBoundBytes: nativeCsrLowerBoundBytes,
            error: nativeRuntime?.error || null,
            note:
                'Rust 资产由 VexusIndex MemoRuntime 的 Arc 持有；下界不含 HashMap/Provenance/allocator 开销。'
        },
        // JS 可归因内存只剩控制面与可能存在的退休兼容算子缓存。
        estimatedBytes: conditionedEstimatedBytes
    };
}

function buildMemoryProfile(state) {
    const startedAt = Date.now();
    const dimension = state.config.dimension;
    const loadedDiaryIndices = [];

    for (const [diaryName, index] of state.diaryIndices.entries()) {
        const stats = safeIndexStats(index);
        const estimatedBytes = estimateVexusIndexBytes(
            stats.totalVectors,
            dimension
        );
        const lastUsedAt = state.diaryIndexLastUsed.get(diaryName) || null;
        loadedDiaryIndices.push({
            name: diaryName,
            stats,
            estimatedBytes,
            lastUsedAt,
            idleMs: lastUsedAt ? Date.now() - lastUsedAt : null,
            dateIndexItems: state.diaryDateIndexCache.get(diaryName)?.length || 0
        });
    }
    loadedDiaryIndices.sort(
        (left, right) => right.estimatedBytes - left.estimatedBytes
    );

    const tagIndexStats = safeIndexStats(state.tagIndex);
    const tagIndexEstimatedBytes = estimateVexusIndexBytes(
        tagIndexStats.totalVectors,
        dimension
    );
    const tagMemo = profileTagMemo(state.tagMemoEngine);
    const riverMemo = profileRiverMemo(state);
    const diaryNameVectorEstimatedBytes =
        state.diaryNameVectorCache.size * dimension * 8;
    const diaryDateIndexEstimatedBytes =
        Array.from(state.diaryDateIndexCache.values()).reduce(
            (sum, items) => sum + (Array.isArray(items) ? items.length * 160 : 0),
            0
        );
    const loadedDiaryEstimatedBytes = loadedDiaryIndices.reduce(
        (sum, item) => sum + item.estimatedBytes,
        0
    );
    const estimatedBytes = tagIndexEstimatedBytes
        + loadedDiaryEstimatedBytes
        + tagMemo.estimatedBytes
        + riverMemo.estimatedBytes
        + diaryNameVectorEstimatedBytes
        + diaryDateIndexEstimatedBytes;

    return {
        module: 'KnowledgeBaseManager',
        initialized: state.initialized,
        dimension,
        rootPath: state.config.rootPath,
        storePath: state.config.storePath,
        dbHealthState: state.dbHealthState,
        databaseCorruptionDetected: state.databaseCorruptionDetected,
        queues: {
            pendingFiles: state.pendingFiles.size,
            pendingDeletes: state.pendingDeletes.size,
            saveTimers: state.saveTimers.size,
            isProcessing: state.isProcessing,
            isProcessingDeletes: state.isProcessingDeletes,
            externalMutationActive: state.externalMutationActive,
            externalMutationOwner: state.externalMutationOwner,
            externalMutationQueueLength: state.externalMutationQueueLength,
            indexRecoveryActive: state.indexRecoveryActive,
            diaryIndexLoadsInFlight: state.diaryIndexLoadPromises.size,
            watcherTrackedGenerations: state.watcherPathGenerations.size,
            staleWatcherEventsDropped: state.staleWatcherEventsDropped
        },
        tagIndex: {
            stats: tagIndexStats,
            estimatedBytes: tagIndexEstimatedBytes
        },
        diaryIndices: {
            loadedCount: state.diaryIndices.size,
            trackedCount: state.diaryIndexLastUsed.size,
            idleTtlMs: state.config.indexIdleTTL,
            estimatedBytes: loadedDiaryEstimatedBytes,
            items: loadedDiaryIndices
        },
        caches: {
            diaryNameVectorCount: state.diaryNameVectorCache.size,
            diaryNameVectorEstimatedBytes,
            diaryDateIndexCount: state.diaryDateIndexCache.size,
            diaryDateIndexEstimatedBytes
        },
        tagMemo,
        riverMemo,
        estimatedBytes,
        generatedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt
    };
}

module.exports = {
    estimateVexusIndexBytes,
    safeIndexStats,
    buildMemoryProfile
};