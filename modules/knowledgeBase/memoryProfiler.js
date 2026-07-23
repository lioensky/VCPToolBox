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
    const runtime = state.tagMemoV10Engine;
    const engine = state.riverMemoEngine;
    if (!runtime) {
        return { available: false, estimatedBytes: 0 };
    }

    const artifact = runtime.getArtifactSnapshot?.({ buildIfMissing: false })
        || null;
    const nodeCount = Math.max(
        0,
        Number(artifact?.sharedTransport?.nodeCount) || 0
    );
    const edgeCount = Math.max(
        0,
        Number(artifact?.sharedTransport?.edgeCount) || 0
    );
    // CSR 自有数组：nodeIds 作为 JS Number 估 8B，rowOffsets Uint32 4B，
    // targetIndices Uint32 4B，weights Float64 8B；Map/对象壳不在此精确归因。
    const transportEstimatedBytes = nodeCount * 8
        + (nodeCount + 1) * 4
        + edgeCount * 12;
    const provenanceEdges = Math.max(
        0,
        Number(artifact?.provenanceView?.edgeCount) || 0
    );
    // 仅为诊断级下界：key、数组及至少一个贡献对象的保守壳开销。
    const provenanceEstimatedBytes = provenanceEdges * 128;
    const conditionedOperator =
        runtime.getConditionedOperatorCacheDiagnostics?.() || null;
    const borrowedViews = {
        rawResidualRatio: artifact?.rawResidualRatioView?.storageMode
            === 'borrowed',
        anchorGain: artifact?.anchorGainView?.storageMode === 'borrowed',
        pairwise: artifact?.pairwiseView?.storageMode === 'borrowed',
        inboundMass: artifact?.inboundMassView?.storageMode === 'borrowed',
        wormhole: artifact?.wormholeView?.storageMode === 'borrowed'
    };
    const borrowedViewCount = Object.values(borrowedViews)
        .filter(Boolean).length;
    const conditionedEstimatedBytes = Math.max(
        0,
        Number(conditionedOperator?.estimatedBytes) || 0
    );
    const estimatedBytes = transportEstimatedBytes
        + provenanceEstimatedBytes
        + conditionedEstimatedBytes;

    return {
        available: true,
        artifactSig: artifact?.artifactSig || null,
        sourceV9ArtifactSig: artifact?.sourceArtifactSig || null,
        generation: artifact?.generation || null,
        transport: {
            nodeCount,
            edgeCount,
            estimatedBytes: transportEstimatedBytes,
            storageMode: 'owned-csr'
        },
        provenance: {
            edgeCount: provenanceEdges,
            sourceCount: Math.max(
                0,
                Number(artifact?.provenanceView?.sourceCount) || 0
            ),
            estimatedBytes: provenanceEstimatedBytes
        },
        auxiliaryViews: {
            borrowedFromV9: borrowedViews,
            borrowedViewCount,
            ownedViewCount: Object.keys(borrowedViews).length
                - borrowedViewCount,
            pairwisePersistedInV2: false
        },
        conditionedOperator,
        nativeArtifactCache: {
            observedLoaded:
                engine?._nativeArtifactCacheObserved === true,
            artifactSig:
                engine?._nativeArtifactSigObserved || null,
            pairwiseResident: false,
            estimatedBytes: null,
            note:
                'Rust 原生分配计入 RSS，但无法由 process.memoryUsage() 按资产精确归因。'
        },
        estimatedBytes
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