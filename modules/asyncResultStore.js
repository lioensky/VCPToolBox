'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { invalidPath, resolveSafePath, assertSafePath } = require('./safeFilePath');

// Identifiers are names, never paths. Reject percent escapes as well: decode once only.
function validateResultId(value, maxLength = 120) {
    if (typeof value !== 'string' || value.length > maxLength
        || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(value)
        || value.includes('..') || value.endsWith('.')) {
        throw invalidPath('Invalid task or plugin identifier');
    }
    return value;
}

function resultPath(root, pluginName, taskId) {
    validateResultId(pluginName, 100);
    validateResultId(taskId);
    return resolveSafePath(root, `${pluginName}-${taskId}.json`, { singleSegment: true });
}

function taskPath(root, taskId) {
    validateResultId(taskId);
    return resolveSafePath(root, `${taskId}.json`, { singleSegment: true });
}

// Atomic publication avoids partial JSON and never follows an existing target symlink.
// Directory checks do not defend against a concurrent privileged local directory swap.
async function writeJson(root, destination, data) {
    await assertSafePath(root, destination);
    await fs.mkdir(root, { recursive: true });
    await assertSafePath(root, destination);
    const temporary = resolveSafePath(root, `.result-${crypto.randomUUID()}.tmp`, { singleSegment: true });
    try {
        await fs.writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await assertSafePath(root, destination);
        await fs.rename(temporary, destination);
    } finally {
        await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
}

function createCallbackHandler({ root, pluginManager, broadcast, debug = false }) {
    return async (req, res) => {
        const { pluginName, taskId } = req.params;
        try {
            const destination = resultPath(root, pluginName, taskId);
            const manifest = pluginManager.getPlugin(pluginName);
            if (!manifest) return res.status(404).json({ status: 'error', message: 'Plugin not found' });
            if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
                return res.status(400).json({ status: 'error', message: 'Expected a JSON object' });
            }
            await writeJson(root, destination, req.body);
            if (manifest.webSocketPush?.enabled) {
                broadcast({
                    type: manifest.webSocketPush.messageType || 'plugin_callback_notification',
                    data: req.body
                }, manifest.webSocketPush.targetClientType || null);
            }
            return res.status(200).json({ status: 'success', message: 'Callback received and processed' });
        } catch (error) {
            if (debug) console.error('[Plugin Callback] Processing failed:', error.code || error.name);
            return res.status(error.code === 'UNSAFE_PATH' ? 400 : 500)
                .json({ status: 'error', message: error.code === 'UNSAFE_PATH' ? 'Invalid callback identifier or path' : 'Callback processing failed' });
        }
    };
}

module.exports = { validateResultId, resultPath, taskPath, writeJson, createCallbackHandler };