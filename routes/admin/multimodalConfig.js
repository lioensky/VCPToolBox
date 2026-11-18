// routes/admin/multimodalConfig.js
//
// 多模态配置 API（multimodal-config.json 真相源）
// ----------------------------------------------------------------
// GET  /multimodal-config        读取当前 JSON 配置 + 元信息
// PUT  /multimodal-config        部分更新（深合并字段）
// POST /multimodal-config/reset  根据 config.env 重置为默认（保留 force translate models 列表语义）
//
// 与前端契约：
// - PUT 请求体可只携带变更字段；后端会与现有内存配置合并后再写盘
// - PUT 写盘后立即热刷新 image-processor / chatCompletionHandler 使用的 store

const express = require('express');
const multiModalConfigStore = require('../../modules/multiModalConfigStore.js');

module.exports = function () {
    const router = express.Router();

    function buildResponse(message) {
        const config = multiModalConfigStore.getConfig();
        const status = multiModalConfigStore.getStatus();
        return {
            success: true,
            config,
            path: status.path,
            watcherActive: status.watcherActive,
            lastLoadError: status.lastLoadError,
            ...(message ? { message } : {})
        };
    }

    router.get('/multimodal-config', (req, res) => {
        try {
            res.json(buildResponse());
        } catch (error) {
            console.error('[MultiModalConfig] read failed:', error);
            res.status(500).json({ success: false, error: '读取多模态配置失败', details: error.message });
        }
    });

    router.put('/multimodal-config', (req, res) => {
        const payload = req.body || {};
        if (typeof payload !== 'object' || Array.isArray(payload)) {
            return res.status(400).json({ success: false, error: '请求体必须是对象' });
        }
        try {
            const allowedKeys = [
                'MultiModalModel',
                'MultiModalPrompt',
                'MediaInsertPrompt',
                'MultiModalModelOutputMaxTokens',
                'MultiModalModelContent',
                'MultiModalModelThinkingBudget',
                'MultiModalModelAsynchronousLimit',
                'MultiModalForceTranslateModels'
            ];
            const patch = {};
            for (const key of allowedKeys) {
                if (key in payload) {
                    patch[key] = payload[key];
                }
            }
            multiModalConfigStore.saveConfig(patch);
            res.json(buildResponse('多模态配置已保存，运行中插件将自动热加载新值。'));
        } catch (error) {
            console.error('[MultiModalConfig] save failed:', error);
            res.status(500).json({ success: false, error: '保存多模态配置失败', details: error.message });
        }
    });

    return router;
};