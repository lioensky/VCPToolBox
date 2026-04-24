const express = require('express');
const dynamicToolRegistry = require('../../modules/dynamicToolRegistry.js');

module.exports = function(options) {
    const router = express.Router();
    const { pluginManager } = options;

    function sanitizeConfigPayload(body = {}) {
        const config = {};
        const scalarKeys = [
            'enabled',
            'maxBriefListItems',
            'maxExpandedPlugins',
            'maxForcedCategoryPlugins',
            'maxInjectionChars',
            'classificationDebounceMs',
            'classifierTimeoutMs',
            'useRagEmbeddings'
        ];
        for (const key of scalarKeys) {
            if (Object.prototype.hasOwnProperty.call(body, key)) config[key] = body[key];
        }

        if (body.smallModel && typeof body.smallModel === 'object') {
            config.smallModel = {
                enabled: body.smallModel.enabled === true,
                useMainConfig: body.smallModel.useMainConfig !== false,
                endpoint: typeof body.smallModel.endpoint === 'string' ? body.smallModel.endpoint : '',
                model: typeof body.smallModel.model === 'string' ? body.smallModel.model : ''
            };
        }

        if (body.manualOverrides && typeof body.manualOverrides === 'object') {
            config.manualOverrides = sanitizeManualOverrides(body.manualOverrides);
        }
        return config;
    }

    function sanitizeManualOverrides(overrides = {}) {
        return {
            excludedOriginKeys: Array.isArray(overrides.excludedOriginKeys)
                ? overrides.excludedOriginKeys.map(String).filter(Boolean)
                : [],
            pinnedOriginKeys: Array.isArray(overrides.pinnedOriginKeys)
                ? overrides.pinnedOriginKeys.map(String).filter(Boolean)
                : [],
            categoryAliases: overrides.categoryAliases && typeof overrides.categoryAliases === 'object'
                ? Object.fromEntries(
                    Object.entries(overrides.categoryAliases)
                        .filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
                        .map(([key, value]) => [key, value])
                )
                : {}
        };
    }

    router.get('/dynamic-tools/state', (req, res) => {
        try {
            res.json(dynamicToolRegistry.getAdminState());
        } catch (error) {
            console.error('[AdminAPI] Error getting dynamic tools state:', error);
            res.status(500).json({ error: 'Failed to get dynamic tools state', details: error.message });
        }
    });

    router.get('/dynamic-tools/config', (req, res) => {
        try {
            res.json({ config: dynamicToolRegistry.getAdminState().config });
        } catch (error) {
            console.error('[AdminAPI] Error getting dynamic tools config:', error);
            res.status(500).json({ error: 'Failed to get dynamic tools config', details: error.message });
        }
    });

    router.post('/dynamic-tools/config', async (req, res) => {
        try {
            const config = sanitizeConfigPayload(req.body || {});
            const saved = await dynamicToolRegistry.updateConfig(config);
            res.json({ status: 'success', config: saved });
        } catch (error) {
            console.error('[AdminAPI] Error saving dynamic tools config:', error);
            res.status(500).json({ error: 'Failed to save dynamic tools config', details: error.message });
        }
    });

    router.post('/dynamic-tools/rebuild', async (req, res) => {
        try {
            if (pluginManager && pluginManager.plugins) {
                await dynamicToolRegistry.syncFromPluginManager('admin_rebuild');
            }
            const mode = typeof req.body?.mode === 'string' ? req.body.mode : 'classification';
            const wait = req.body?.wait !== false;
            const state = await dynamicToolRegistry.forceRebuild({ mode, wait });
            res.json({ status: 'success', state });
        } catch (error) {
            console.error('[AdminAPI] Error rebuilding dynamic tools:', error);
            res.status(500).json({ error: 'Failed to rebuild dynamic tools', details: error.message });
        }
    });

    router.post('/dynamic-tools/override', async (req, res) => {
        try {
            const current = dynamicToolRegistry.getAdminState().config;
            const overrides = {
                excludedOriginKeys: Array.isArray(current.manualOverrides?.excludedOriginKeys)
                    ? [...current.manualOverrides.excludedOriginKeys]
                    : [],
                pinnedOriginKeys: Array.isArray(current.manualOverrides?.pinnedOriginKeys)
                    ? [...current.manualOverrides.pinnedOriginKeys]
                    : [],
                categoryAliases: current.manualOverrides?.categoryAliases || {}
            };

            const originKey = typeof req.body?.originKey === 'string' ? req.body.originKey : '';
            if (originKey) {
                if (typeof req.body.excluded === 'boolean') {
                    overrides.excludedOriginKeys = setMembership(overrides.excludedOriginKeys, originKey, req.body.excluded);
                }
                if (typeof req.body.pinned === 'boolean') {
                    overrides.pinnedOriginKeys = setMembership(overrides.pinnedOriginKeys, originKey, req.body.pinned);
                }
            }

            if (req.body?.manualOverrides && typeof req.body.manualOverrides === 'object') {
                const manual = sanitizeManualOverrides(req.body.manualOverrides);
                overrides.excludedOriginKeys = manual.excludedOriginKeys;
                overrides.pinnedOriginKeys = manual.pinnedOriginKeys;
                overrides.categoryAliases = manual.categoryAliases;
            }

            const config = await dynamicToolRegistry.updateConfig({ manualOverrides: overrides });
            res.json({ status: 'success', config });
        } catch (error) {
            console.error('[AdminAPI] Error updating dynamic tools override:', error);
            res.status(500).json({ error: 'Failed to update dynamic tools override', details: error.message });
        }
    });

    function setMembership(list, value, enabled) {
        const next = new Set(list);
        if (enabled) next.add(value);
        else next.delete(value);
        return Array.from(next).sort();
    }

    return router;
};
