const express = require('express');
const jevThirdPartyRegistry = require('../../modules/jevThirdPartyRegistry');
const jevToolCallExp = require('../../modules/jevToolCallExp');

/**
 * JEV 第三方注册表只读调试接口（实验）。
 * 挂载在 admin_api 下，沿用现有管理员认证。
 * plan-preview 只做规划，不执行任何真实工具调用。
 */
module.exports = function (options) {
    const router = express.Router();
    const pluginManager = options.pluginManager;

    router.get('/jev/registry', (req, res) => {
        try {
            res.json({ status: 'success', ...jevThirdPartyRegistry.getSnapshot() });
        } catch (error) {
            console.error('[JevRegistry Admin] Failed to get registry:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    router.get('/jev/registry/catalog', (req, res) => {
        try {
            res.json({
                status: 'success',
                catalog: jevThirdPartyRegistry.getCatalog(),
                conflicts: jevThirdPartyRegistry.getCatalogConflicts()
            });
        } catch (error) {
            console.error('[JevRegistry Admin] Failed to get catalog:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    router.get('/jev/registry/:pluginName', (req, res) => {
        // 精确、大小写敏感查找，与调用侧不变量一致。
        const entry = jevThirdPartyRegistry.getEntry(req.params.pluginName);
        if (!entry) {
            return res.status(404).json({ status: 'error', error: `Plugin "${req.params.pluginName}" not found in JEV registry.` });
        }
        res.json({ status: 'success', entry });
    });

    router.post('/jev/registry/rebuild', async (req, res) => {
        try {
            if (!pluginManager || typeof pluginManager.buildJevPromptRegistry !== 'function') {
                return res.status(503).json({ status: 'error', error: 'PluginManager is unavailable.' });
            }
            const snapshot = await pluginManager.buildJevPromptRegistry('admin_rebuild');
            if (!snapshot) {
                return res.status(500).json({ status: 'error', error: 'Registry rebuild failed or was superseded. Check server logs.' });
            }
            res.json({ status: 'success', ...snapshot });
        } catch (error) {
            console.error('[JevRegistry Admin] Failed to rebuild registry:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    router.post('/jev/registry/plan-preview', async (req, res) => {
        const expression = typeof req.body?.expression === 'string' ? req.body.expression : '';
        if (!expression.trim()) {
            return res.status(400).json({ status: 'error', error: 'expression is required.' });
        }
        if (expression.length > 8000) {
            return res.status(400).json({ status: 'error', error: 'expression is too long (max 8000).' });
        }
        try {
            // 不传入 maid/tool_password 等继承字段，预览结果不包含任何凭据。
            const calls = await jevToolCallExp.plan(expression, {});
            res.json({ status: 'success', executed: false, calls });
        } catch (error) {
            res.status(400).json({ status: 'error', executed: false, error: error.message });
        }
    });

    return router;
};