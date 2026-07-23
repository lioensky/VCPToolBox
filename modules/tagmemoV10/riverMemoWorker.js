'use strict';

const { parentPort } = require('worker_threads');
const Database = require('better-sqlite3');
const TagMemoV10Engine = require('../../TagMemoV10Engine');
const RiverMemoEngine = require('../../RiverMemoEngine');
const RiverMemoArtifactRepository = require('./riverMemoArtifactRepository');

if (!parentPort) {
    throw new Error('riverMemoWorker must run inside a worker thread.');
}

let db = null;
let dbPath = null;
let dimension = 0;
let runtime = null;
let engine = null;
let activeArtifactSig = null;
let activeSourceArtifactSig = null;
let currentConfigHash = null;

function closeDatabase() {
    try {
        db?.close();
    } catch (_) {
        // Worker 退出时忽略关闭异常。
    }
    db = null;
    runtime = null;
    engine = null;
    activeArtifactSig = null;
    activeSourceArtifactSig = null;
    currentConfigHash = null;
}

function openDatabase(nextDbPath) {
    if (db && dbPath === nextDbPath) return;
    closeDatabase();
    dbPath = nextDbPath;
    db = new Database(dbPath, {
        readonly: true,
        fileMustExist: true,
        timeout: 30_000
    });
    db.pragma('query_only = ON');
}

function loadArtifactRow(artifactSig) {
    return db.prepare(`
        SELECT *
        FROM rivermemo_artifacts
        WHERE artifact_sig = ?
          AND status = 'ready'
        LIMIT 1
    `).get(artifactSig);
}

function ensureEngine(payload) {
    const nextDbPath = String(payload.dbPath || '');
    if (!nextDbPath) {
        const error = new Error('RiverMemo worker requires dbPath.');
        error.code = 'RIVERMEMO_WORKER_DB_PATH_REQUIRED';
        throw error;
    }

    openDatabase(nextDbPath);
    dimension = Math.max(1, Number(payload.dimension) || 0);
    const artifactSig = String(payload.artifactSig || '');
    if (!artifactSig) {
        const error = new Error('RiverMemo worker requires artifactSig.');
        error.code = 'RIVERMEMO_WORKER_ARTIFACT_SIG_REQUIRED';
        throw error;
    }

    const configHash = JSON.stringify(payload.riverMemoConfig || {});
    if (
        runtime
        && engine
        && activeArtifactSig === artifactSig
        && currentConfigHash === configHash
    ) {
        return;
    }

    const row = loadArtifactRow(artifactSig);
    if (!row) {
        const error = new Error(
            `RiverMemo persisted artifact "${artifactSig}" is unavailable to worker.`
        );
        error.code = 'RIVERMEMO_WORKER_ARTIFACT_UNAVAILABLE';
        throw error;
    }

    const repository = new RiverMemoArtifactRepository({ db });
    const artifactPayload = repository.decodePayload(row);
    activeSourceArtifactSig = String(
        artifactPayload?.artifact?.sourceArtifactSig
        || row.source_v9_artifact_sig
        || ''
    );

    const v9Facade = {
        getArtifactBundleSnapshot() {
            return { artifactSig: activeSourceArtifactSig };
        }
    };
    runtime = new TagMemoV10Engine(
        db,
        null,
        {
            dimension,
            modelSig: row.model_sig || payload.modelSig || 'unknown-model'
        },
        {
            KnowledgeBaseManager: {
                riverMemo: payload.riverMemoConfig || {}
            }
        },
        {
            v9Engine: v9Facade,
            artifactRepository: repository
        }
    );

    const artifact = runtime.restoreArtifact(artifactPayload, {
        publishedAt: row.published_at
    });
    runtime.publishArtifact(artifact, {
        publishedAt: row.published_at
    });
    engine = new RiverMemoEngine(runtime, {
        config: payload.riverMemoConfig || {}
    });
    activeArtifactSig = artifactSig;
    currentConfigHash = configHash;
}

function sanitizeOptions(options = {}) {
    const identityDiaryName = String(options.identityDiaryName || '').trim();
    return {
        topK: options.topK,
        coreTags: Array.isArray(options.coreTags) ? options.coreTags : [],
        sourceObservationResult: options.sourceObservationResult || null,
        // prepareQuery 不会从 sourceObservationResult 自动提取 sourceField；
        // 必须显式传入同一份 V9 Spike 源场，否则会误入禁用的 KNN fallback。
        sourceField: Array.isArray(options.sourceObservationResult?.sourceField)
            ? options.sourceObservationResult.sourceField
            : null,
        sourceObservationConfig: options.sourceObservationConfig || {},
        candidateSuperset: options.candidateSuperset || {},
        pathEvaluation: options.pathEvaluation || {},
        dstc: options.dstc || {},
        riverObservability: options.riverObservability || {},
        includeTrace: options.includeTrace === true,
        identityEligibility: identityDiaryName
            ? curve => String(curve?.diaryName || '').includes(identityDiaryName)
            : () => false
    };
}

parentPort.on('message', message => {
    const id = message?.id;
    const payload = message?.payload || {};
    try {
        ensureEngine(payload);
        const result = engine.rerank(
            payload.query || {},
            Array.isArray(payload.candidates) ? payload.candidates : [],
            payload.agentContext || {},
            sanitizeOptions(payload.options)
        );
        parentPort.postMessage({ id, ok: true, result });
    } catch (error) {
        parentPort.postMessage({
            id,
            ok: false,
            error: {
                message: error?.message || String(error),
                code: error?.code || 'RIVERMEMO_WORKER_ERROR',
                stack: error?.stack || null
            }
        });
    }
});

process.once('exit', closeDatabase);