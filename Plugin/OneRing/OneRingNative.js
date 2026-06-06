'use strict';

const path = require('path');

let nativeModule = null;
let nativeEngine = null;
let loadError = null;
let nativeAvailable = false;
let unavailableLogged = false;

function toBoolean(value, defaultValue = true) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    }
    return defaultValue;
}

function isEnabled(config = {}) {
    return toBoolean(config.ONERING_NATIVE_ENGINE ?? process.env.ONERING_NATIVE_ENGINE ?? 'true', true);
}

function loadNativeModule(projectBasePath = '') {
    if (nativeModule || loadError) return nativeModule;

    try {
        const basePath = projectBasePath || path.join(__dirname, '..', '..');
        nativeModule = require(path.join(basePath, 'rust-vexus-lite'));
        if (!nativeModule || typeof nativeModule.OneRingEngine !== 'function') {
            throw new Error('OneRingEngine export not found in rust-vexus-lite');
        }
        nativeAvailable = true;
        return nativeModule;
    } catch (e) {
        loadError = e;
        nativeAvailable = false;
        if (!unavailableLogged) {
            unavailableLogged = true;
            console.warn(`[OneRingNative] Native module unavailable, JS fallback will be used: ${e.message}`);
        }
        return null;
    }
}

function getEngine(projectBasePath = '', config = {}) {
    if (!isEnabled(config)) {
        if (!unavailableLogged) {
            unavailableLogged = true;
            console.warn('[OneRingNative] Disabled by ONERING_NATIVE_ENGINE=false, JS fallback will be used.');
        }
        return null;
    }

    const mod = loadNativeModule(projectBasePath);
    if (!mod) return null;

    if (!nativeEngine) {
        nativeEngine = new mod.OneRingEngine();
        console.log('[OneRingNative] OneRingEngine initialized.');
    }

    return nativeEngine;
}

function getAgentDbPath(projectBasePath, agentName) {
    const basePath = projectBasePath || path.join(__dirname, '..', '..');
    return path.join(basePath, 'Plugin', 'OneRing', 'data', `${agentName}.db`);
}

function toNativePostBlocks(postBlocks = []) {
    return (Array.isArray(postBlocks) ? postBlocks : []).map((block, idx) => {
        const nativeBlock = {
            role: String(block.role || ''),
            text: String(block.text || ''),
            index: Number.isInteger(block.index) ? block.index : idx
        };

        if (block.senderName) nativeBlock.senderName = String(block.senderName);
        if (block.frontendSource) nativeBlock.frontendSource = String(block.frontendSource);

        return nativeBlock;
    });
}

function normalizeDiffResult(nativeResult) {
    if (!nativeResult) return null;
    return {
        matchedCount: nativeResult.matchedCount || 0,
        unknownCount: nativeResult.unknownCount || 0,
        editedBlocks: Array.isArray(nativeResult.editedBlocks)
            ? nativeResult.editedBlocks.map(block => ({
                postIndex: block.postIndex,
                dbId: block.dbId,
                oldContent: block.oldContent,
                newText: block.newText,
                similarity: block.similarity
            }))
            : [],
        newBlocks: Array.isArray(nativeResult.newBlocks)
            ? nativeResult.newBlocks.map(block => ({
                postIndex: block.postIndex,
                role: block.role,
                text: block.text,
                senderName: block.senderName || undefined,
                index: block.index
            }))
            : [],
        reliable: nativeResult.reliable !== false,
        elapsedMs: nativeResult.elapsedMs || 0,
        phaseSummary: nativeResult.phaseSummary || ''
    };
}

function diffFrontendContext({ projectBasePath, config, agentName, frontendSource, postBlocks, threshold, limit }) {
    const engine = getEngine(projectBasePath, config);
    if (!engine) return null;

    const dbPath = getAgentDbPath(projectBasePath, agentName);
    if (process.env.ONERING_NATIVE_TRACE === 'true') {
        console.log(`[OneRingNative] diffFrontendContext start agent="${agentName}" frontend="${frontendSource}" blocks=${Array.isArray(postBlocks) ? postBlocks.length : 0} limit=${limit}`);
    }
    const nativeResult = engine.diffFrontendContext({
        dbPath,
        agentName,
        frontendSource,
        postBlocks: toNativePostBlocks(postBlocks),
        threshold,
        limit
    });

    const normalized = normalizeDiffResult(nativeResult);
    if (process.env.ONERING_NATIVE_TRACE === 'true') {
        console.log(`[OneRingNative] diffFrontendContext done agent="${agentName}" frontend="${frontendSource}" elapsed=${normalized?.elapsedMs || 0}ms phase=${normalized?.phaseSummary || ''}`);
    }
    return normalized;
}

function loadAgent(projectBasePath, config, agentName, maxRecords = 256) {
    const engine = getEngine(projectBasePath, config);
    if (!engine) return null;
    return engine.loadAgent(getAgentDbPath(projectBasePath, agentName), agentName, maxRecords);
}

function updateMessageById(projectBasePath, config, agentName, id, content) {
    const engine = getEngine(projectBasePath, config);
    if (!engine) return null;
    return engine.updateMessageById({
        dbPath: getAgentDbPath(projectBasePath, agentName),
        agentName,
        id,
        content
    });
}

function getStatus() {
    return {
        available: nativeAvailable,
        loaded: !!nativeModule,
        engineCreated: !!nativeEngine,
        error: loadError ? loadError.message : null
    };
}

module.exports = {
    isEnabled,
    getEngine,
    loadAgent,
    diffFrontendContext,
    updateMessageById,
    getStatus
};