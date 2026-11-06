const express = require('express');
const dynamicToolRegistry = require('../../modules/dynamicToolRegistry.js');

const REBUILD_MODES = new Set(['classification', 'catalog', 'all']);

module.exports = function(options) {
    const router = express.Router();
    const { pluginManager } = options;

    function respondError(res, error, action) {
        const status = error.status === 400 || error.statusCode === 400 ? 400 : 500;
        // Do not reflect request values or upstream credentials through errors/logs.
        if (status === 500) console.error(`[AdminAPI] Failed to ${action} dynamic tools`);
        return res.status(status).json({
            error: status === 400 ? 'Invalid dynamic tools configuration' : `Failed to ${action} dynamic tools`,
            details: status === 400 ? '配置字段类型、范围或结构无效，请检查后重试。' : '操作失败，已保留原配置，请重试。'
        });
    }

    router.get('/dynamic-tools/state', (req, res) => {
        try {
            res.json(dynamicToolRegistry.getAdminState());
        } catch (error) {
            respondError(res, error, 'get');
        }
    });

    router.get('/dynamic-tools/config', (req, res) => {
        try {
            res.json({ config: dynamicToolRegistry.getAdminState().config });
        } catch (error) {
            respondError(res, error, 'get');
        }
    });

    router.post('/dynamic-tools/config', async (req, res) => {
        try {
            const patch = dynamicToolRegistry.validateConfigPatch(req.body);
            const saved = await dynamicToolRegistry.updateConfig(patch);
            res.json({ status: 'success', config: saved });
        } catch (error) {
            respondError(res, error, 'save');
        }
    });

    router.post('/dynamic-tools/rebuild', async (req, res) => {
        try {
            const mode = typeof req.body?.mode === 'string' ? req.body.mode : 'classification';
            if (!REBUILD_MODES.has(mode)) {
                return res.status(400).json({
                    error: 'Invalid dynamic tools rebuild mode',
                    details: `mode must be one of: ${Array.from(REBUILD_MODES).join(', ')}`
                });
            }
            if (pluginManager && pluginManager.plugins) {
                await dynamicToolRegistry.syncFromPluginManager('admin_rebuild');
            }
            const wait = req.body?.wait !== false;
            const state = await dynamicToolRegistry.forceRebuild({ mode, wait });
            res.json({ status: 'success', state });
        } catch (error) {
            respondError(res, error, 'rebuild');
        }
    });

    router.post('/dynamic-tools/override', async (req, res) => {
        try {
            const config = await dynamicToolRegistry.updateOverride(req.body);
            res.json({ status: 'success', config });
        } catch (error) {
            respondError(res, error, 'update');
        }
    });

    return router;
};
