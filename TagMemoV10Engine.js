'use strict';

const crypto = require('crypto');
const {
    hashStable,
    immutableSnapshot,
    createReadonlyCsr
} = require('./modules/tagmemoV10/immutable');
const { buildProvenanceView } = require('./modules/tagmemoV10/provenance');
const { createConditionedOperator } = require('./modules/tagmemoV10/agentConditioner');
const { solveDualScaledFields } = require('./modules/tagmemoV10/scaledFieldSolver');
const { buildCandidateSuperset } = require('./modules/tagmemoV10/candidateSuperset');
const { projectCandidateCurves } = require('./modules/tagmemoV10/curveProjector');
const { evaluateCandidateCurves } = require('./modules/tagmemoV10/unifiedPathGeometry');
const { computeDstcBatch } = require('./modules/tagmemoV10/dstcObservables');
const {
    scoreExperimentArm,
    runExperimentArms
} = require('./modules/tagmemoV10/experimentArms');

const VERSION = 'v10_alpha';
const ALGORITHM_VERSION = 'v10.alpha.1';
const ARTIFACT_SCHEMA = 'tagmemo-v10-alpha-artifact-v1';
const QUERY_TRACE_SCHEMA = 'tagmemo-v10-alpha-query-trace-v1';

class TagMemoV10Engine {
    constructor(db, tagIndex, config, ragParams, options = {}) {
        this.db = db;
        this.tagIndex = tagIndex;
        this.config = config || {};
        this.ragParams = ragParams || {};
        this.v9Engine = options.v9Engine || null;
        this._activeArtifact = null;
        this._artifactGeneration = 0;
    }

    updateRagParams(ragParams) {
        this.ragParams = ragParams || {};
    }

    rebindDatabase(db) {
        this.db = db;
    }

    getEffectiveConfig(overrides = {}) {
        const configured = this.ragParams?.KnowledgeBaseManager?.tagMemoV10Alpha || {};
        return immutableSnapshot({
            enabled: configured.enabled === true || configured.enabled === 1,
            mode: configured.mode || 'shadow',
            experimentArm: configured.experimentArm || 'pure',
            strictVersion: configured.strictVersion !== false,
            traceEnabled: configured.traceEnabled !== false,
            localField: {
                solver: 'scaled_resolvent',
                alpha: 0.15,
                maxIterations: 80,
                tolerance: 1e-9,
                ...(configured.localField || {})
            },
            transferField: {
                solver: 'scaled_resolvent',
                alpha: 0.55,
                maxIterations: 80,
                tolerance: 1e-9,
                ...(configured.transferField || {})
            },
            effectiveSupport: {
                method: 'mass_ratio',
                localMassRatio: 0.8,
                transferMassRatio: 0.9,
                ...(configured.effectiveSupport || {})
            },
            agentConditioning: {
                enabled: true,
                localAffinityMin: 0.75,
                localAffinityMax: 1.25,
                transferAffinityMin: 0.9,
                transferAffinityMax: 1.1,
                ...(configured.agentConditioning || {})
            },
            candidateSuperset: {
                queryK: 100,
                localFieldK: 100,
                transferFieldK: 100,
                bm25K: 50,
                anchorK: 50,
                maxUnionCandidates: 300,
                minimumGeometryCoverage: 0.5,
                ...(configured.candidateSuperset || {})
            },
            pathGeometry: {
                localWeight: 0.6,
                transferWeight: 0.4,
                directionFloor: 0.05,
                ...(configured.pathGeometry || {})
            },
            dstc: {
                compute: true,
                arm: configured.experimentArm || 'pure',
                observedRewardCap: 0.12,
                ...(configured.dstc || {})
            },
            safety: {
                permissionViolationTolerance: 0,
                failClosed: true,
                ...(configured.safety || {})
            },
            benchmark: {
                traceCandidates: true,
                ...(configured.benchmark || {})
            },
            ...overrides
        });
    }

    buildAndPublishArtifact(options = {}) {
        const sourceBundle = options.sourceBundle
            || this.v9Engine?.getArtifactBundleSnapshot?.('v9');
        if (!sourceBundle?.propagationKernel) {
            const error = new Error('V10 Alpha requires an available V9.2 fact transport snapshot');
            error.code = 'TAGMEMO_V10_SOURCE_ARTIFACT_UNAVAILABLE';
            throw error;
        }

        const effectiveConfig = this.getEffectiveConfig(options.config || {});
        const configHash = hashStable(effectiveConfig, 32);
        const sharedTransport = createReadonlyCsr(sourceBundle.propagationKernel);
        if (sharedTransport.maxRowMass >= 1) {
            const error = new Error(
                `V10 transport violates convergence budget: maxRowMass=${sharedTransport.maxRowMass}`
            );
            error.code = 'TAGMEMO_V10_UNSTABLE_TRANSPORT';
            throw error;
        }

        const databaseGeneration = this._computeDatabaseGeneration();
        const graphGeneration = sharedTransport.contentSig;
        const modelSig = sourceBundle.modelSig || this.v9Engine?.modelSig || 'unknown-model';
        const provenanceView = buildProvenanceView(this.db, {
            maxTagsPerFile: 100,
            direction: this.ragParams?.KnowledgeBaseManager?.orderedCooccurrence || {}
        });
        const provenanceGeneration = provenanceView.generation;
        const artifactSig = hashStable({
            schema: ARTIFACT_SCHEMA,
            version: VERSION,
            algorithmVersion: ALGORITHM_VERSION,
            graphGeneration,
            databaseGeneration,
            provenanceGeneration,
            modelSig,
            configHash,
            sourceArtifactSig: sourceBundle.artifactSig || null,
            residualArtifactSig: sourceBundle.residualArtifact?.artifactSig || null
        }, 48);

        const generation = ++this._artifactGeneration;
        const publishedAt = Date.now();
        const artifact = Object.freeze({
            schema: ARTIFACT_SCHEMA,
            version: VERSION,
            algorithmVersion: ALGORITHM_VERSION,
            artifactSig,
            generation,
            graphGeneration,
            databaseGeneration,
            provenanceGeneration,
            modelSig,
            configHash,
            sourceArtifactSig: sourceBundle.artifactSig || null,
            sharedTransport,
            rawResidualRatioView: immutableSnapshot(
                sourceBundle.rawResidualRatioMap || new Map()
            ),
            anchorGainView: immutableSnapshot(
                sourceBundle.anchorGainMap || new Map()
            ),
            pairwiseView: immutableSnapshot(
                sourceBundle.pairwiseView || new Map()
            ),
            inboundMassView: immutableSnapshot(
                sourceBundle.inboundMassMap || new Map()
            ),
            wormholeView: immutableSnapshot(
                sourceBundle.wormholeEdges || new Set()
            ),
            provenanceView,
            effectiveConfig,
            publishedAt
        });

        this._activeArtifact = artifact;
        console.log(
            `[TagMemo-V10] 📦 Alpha artifact published: generation=${generation}, ` +
            `artifact=${artifactSig}, nodes=${sharedTransport.nodeCount}, ` +
            `edges=${sharedTransport.edgeCount}, maxRowMass=${sharedTransport.maxRowMass.toFixed(6)}`
        );
        return artifact;
    }

    getArtifactSnapshot(options = {}) {
        if (!this._activeArtifact && options.buildIfMissing !== false) {
            return this.buildAndPublishArtifact(options);
        }
        return this._activeArtifact;
    }

    createQueryState(query, agentContext = {}, artifact = null, options = {}) {
        const snapshot = artifact || this.getArtifactSnapshot();
        if (!snapshot || snapshot.version !== VERSION) {
            const error = new Error('A V10 Alpha artifact snapshot is required');
            error.code = 'TAGMEMO_V10_ARTIFACT_UNAVAILABLE';
            throw error;
        }

        const normalizedQuery = this._normalizeQuery(query);
        const normalizedAgentContext = this._normalizeAgentContext(agentContext);
        const sourceField = this._normalizeSourceField(options.sourceField);
        const solver = immutableSnapshot({
            local: {
                ...snapshot.effectiveConfig.localField,
                ...(options.localField || {})
            },
            transfer: {
                ...snapshot.effectiveConfig.transferField,
                ...(options.transferField || {})
            }
        });
        const scopeHash = hashStable({
            agentId: normalizedAgentContext.agentId,
            diaryNames: normalizedAgentContext.diaryNames,
            allowedFileIds: normalizedAgentContext.allowedFileIds,
            deniedFileIds: normalizedAgentContext.deniedFileIds,
            visibilityMode: normalizedAgentContext.visibilityMode
        }, 32);
        const queryId = options.queryId || crypto.randomUUID();
        const createdAt = Number(options.createdAt) || Date.now();

        return Object.freeze({
            schema: QUERY_TRACE_SCHEMA,
            version: VERSION,
            algorithmVersion: ALGORITHM_VERSION,
            queryId,
            artifactSig: snapshot.artifactSig,
            artifactGeneration: snapshot.generation,
            configHash: snapshot.configHash,
            databaseGeneration: snapshot.databaseGeneration,
            scopeHash,
            query: normalizedQuery,
            agentContext: normalizedAgentContext,
            sourceField,
            solver,
            conditionedTransportView: null,
            localField: null,
            transferField: null,
            localDomain: null,
            transferDomain: null,
            fieldDiagnostics: null,
            createdAt
        });
    }

    buildCandidateSuperset(sourceCandidates, options = {}) {
        const artifact = options.artifact || this.getArtifactSnapshot();
        return buildCandidateSuperset(
            sourceCandidates,
            {
                ...artifact.effectiveConfig.candidateSuperset,
                ...(options.config || {})
            }
        );
    }

    projectCandidateCurves(candidates, options = {}) {
        return projectCandidateCurves(
            this.db,
            candidates,
            {
                dimension: this.config.dimension,
                ...options
            }
        );
    }

    evaluateCandidateCurves(curves, queryState, options = {}) {
        const artifact = options.artifact || this.getArtifactSnapshot();
        return evaluateCandidateCurves(
            curves,
            queryState,
            {
                ...artifact.effectiveConfig.pathGeometry,
                ...(options.config || {})
            }
        );
    }

    computeDstcObservables(pathBatch, queryState, options = {}) {
        const artifact = options.artifact || this.getArtifactSnapshot();
        return computeDstcBatch(
            pathBatch,
            queryState,
            {
                ...artifact.effectiveConfig.pathGeometry,
                ...artifact.effectiveConfig.dstc,
                ...options
            }
        );
    }

    scoreExperimentArm(dstcBatch, arm = 'pure', options = {}) {
        const artifact = options.artifact || this.getArtifactSnapshot();
        return scoreExperimentArm(
            dstcBatch,
            arm,
            {
                ...artifact.effectiveConfig.dstc,
                ...options
            }
        );
    }

    runExperimentArms(dstcBatch, options = {}) {
        const artifact = options.artifact || this.getArtifactSnapshot();
        return runExperimentArms(
            dstcBatch,
            {
                ...artifact.effectiveConfig.dstc,
                ...options
            }
        );
    }

    solveQueryState(queryState, options = {}) {
        const artifact = options.artifact || this.getArtifactSnapshot();
        const replay = this.assertReplayCompatible(queryState, artifact);
        if (!replay.compatible) {
            const error = new Error(
                `V10 query state is not replay-compatible: ${replay.mismatches.join(', ')}`
            );
            error.code = 'TAGMEMO_V10_REPLAY_MISMATCH';
            error.mismatches = replay.mismatches;
            throw error;
        }

        const agentContext = {
            ...queryState.agentContext,
            publicDiaryNames: options.publicDiaryNames || []
        };
        const conditioningConfig = artifact.effectiveConfig.agentConditioning || {};
        const nodeVisibility = typeof options.nodeVisibility === 'function'
            ? options.nodeVisibility
            : () => true;
        const identityEligibility = typeof options.identityEligibility === 'function'
            ? options.identityEligibility
            : () => false;
        const rankingEligibility = typeof options.rankingEligibility === 'function'
            ? options.rankingEligibility
            : () => true;
        const edgeProvenance = (sourceId, targetId, context) =>
            artifact.provenanceView.getEdgeMass(sourceId, targetId, context);
        const common = {
            ...conditioningConfig,
            scopeHash: queryState.scopeHash,
            failClosed: artifact.effectiveConfig.safety?.failClosed !== false,
            nodeVisibility,
            identityEligibility,
            rankingEligibility,
            edgeProvenance,
            queryGate: options.queryGate,
            affinityGate: options.affinityGate
        };
        const localOperator = createConditionedOperator(
            artifact.sharedTransport,
            agentContext,
            { ...common, scale: 'local' }
        );
        const transferOperator = createConditionedOperator(
            artifact.sharedTransport,
            agentContext,
            { ...common, scale: 'transfer' }
        );
        const solved = solveDualScaledFields({
            localOperator,
            transferOperator,
            sourceField: queryState.sourceField,
            local: queryState.solver.local,
            transfer: queryState.solver.transfer,
            support: artifact.effectiveConfig.effectiveSupport
        });

        return Object.freeze({
            ...queryState,
            conditionedTransportView: Object.freeze({
                local: localOperator,
                transfer: transferOperator
            }),
            localField: solved.localField,
            transferField: solved.transferField,
            localDomain: solved.localDomain,
            transferDomain: solved.transferDomain,
            fieldDiagnostics: solved.diagnostics
        });
    }

    assertReplayCompatible(queryState, artifact = null) {
        const snapshot = artifact || this.getArtifactSnapshot({ buildIfMissing: false });
        if (!queryState || queryState.schema !== QUERY_TRACE_SCHEMA) {
            throw new TypeError('Invalid V10 query trace schema');
        }
        const mismatches = [];
        if (!snapshot) mismatches.push('artifact-unavailable');
        else {
            if (queryState.artifactSig !== snapshot.artifactSig) mismatches.push('artifactSig');
            if (queryState.configHash !== snapshot.configHash) mismatches.push('configHash');
            if (queryState.databaseGeneration !== snapshot.databaseGeneration) {
                mismatches.push('databaseGeneration');
            }
        }
        return Object.freeze({
            compatible: mismatches.length === 0,
            mismatches: Object.freeze(mismatches)
        });
    }

    _normalizeQuery(query) {
        if (typeof query === 'string') {
            return Object.freeze({
                text: query.trim(),
                vector: null,
                hash: hashStable(query.trim(), 32)
            });
        }

        const text = String(query?.text || '').trim();
        const rawVector = query?.vector;
        const vector = rawVector && typeof rawVector.length === 'number'
            ? Object.freeze(Array.from(rawVector, value => Number(value) || 0))
            : null;
        return Object.freeze({
            text,
            vector,
            hash: hashStable({ text, vector }, 32)
        });
    }

    _normalizeAgentContext(agentContext) {
        const normalizeIds = value => Object.freeze(
            [...new Set((Array.isArray(value) ? value : [])
                .map(Number)
                .filter(Number.isFinite))]
                .sort((a, b) => a - b)
        );
        const diaryNames = Object.freeze(
            [...new Set((Array.isArray(agentContext.diaryNames)
                ? agentContext.diaryNames
                : agentContext.diaryName
                    ? [agentContext.diaryName]
                    : [])
                .map(value => String(value).trim())
                .filter(Boolean))]
                .sort()
        );

        return Object.freeze({
            agentId: String(agentContext.agentId || agentContext.maid || '').trim() || null,
            diaryNames,
            publicDiaryNames: Object.freeze(
                [...new Set((Array.isArray(agentContext.publicDiaryNames)
                    ? agentContext.publicDiaryNames
                    : [])
                    .map(value => String(value).trim())
                    .filter(Boolean))]
                    .sort()
            ),
            allowedFileIds: normalizeIds(agentContext.allowedFileIds),
            deniedFileIds: normalizeIds(agentContext.deniedFileIds),
            visibilityMode: String(agentContext.visibilityMode || 'scope_only'),
            permissions: immutableSnapshot(agentContext.permissions || {}),
            affinity: immutableSnapshot(agentContext.affinity || {})
        });
    }

    _normalizeSourceField(sourceField) {
        const entries = sourceField instanceof Map
            ? [...sourceField.entries()]
            : Array.isArray(sourceField)
                ? sourceField
                : [];
        const normalized = entries
            .map(([rawId, rawMass]) => [Number(rawId), Math.max(0, Number(rawMass) || 0)])
            .filter(([id, mass]) => Number.isFinite(id) && id > 0 && mass > 0)
            .sort((left, right) => left[0] - right[0]);
        const total = normalized.reduce((sum, entry) => sum + entry[1], 0);
        return Object.freeze(normalized.map(([id, mass]) =>
            Object.freeze([id, total > 0 ? mass / total : 0])
        ));
    }

    _computeDatabaseGeneration() {
        if (!this.db?.prepare) return 'database-unavailable';
        const facts = {};
        for (const table of ['files', 'chunks', 'tags', 'file_tags']) {
            try {
                if (table === 'files') {
                    facts[table] = this.db.prepare(`
                        SELECT
                            COUNT(*) AS count,
                            COALESCE(MAX(id), 0) AS maxId,
                            COALESCE(MAX(updated_at), 0) AS maxUpdatedAt,
                            COALESCE(SUM(size), 0) AS totalSize
                        FROM files
                    `).get();
                } else if (table === 'file_tags') {
                    facts[table] = this.db.prepare(`
                        SELECT
                            COUNT(*) AS count,
                            COALESCE(SUM(file_id), 0) AS fileMass,
                            COALESCE(SUM(tag_id), 0) AS tagMass,
                            COALESCE(SUM(position), 0) AS positionMass
                        FROM file_tags
                    `).get();
                } else {
                    facts[table] = this.db.prepare(`
                        SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS maxId
                        FROM ${table}
                    `).get();
                }
            } catch (error) {
                facts[table] = { error: error.message };
            }
        }
        return hashStable(facts, 40);
    }

    _computeProvenanceGeneration() {
        if (!this.db?.prepare) return 'provenance-unavailable';
        try {
            const rows = this.db.prepare(`
                SELECT diary_name, COUNT(*) AS fileCount,
                       COALESCE(SUM(size), 0) AS totalSize,
                       COALESCE(MAX(updated_at), 0) AS maxUpdatedAt
                FROM files
                GROUP BY diary_name
                ORDER BY diary_name
            `).all();
            return hashStable(rows, 40);
        } catch (error) {
            return hashStable({ error: error.message }, 40);
        }
    }
}

TagMemoV10Engine.VERSION = VERSION;
TagMemoV10Engine.ALGORITHM_VERSION = ALGORITHM_VERSION;
TagMemoV10Engine.ARTIFACT_SCHEMA = ARTIFACT_SCHEMA;
TagMemoV10Engine.QUERY_TRACE_SCHEMA = QUERY_TRACE_SCHEMA;

module.exports = TagMemoV10Engine;