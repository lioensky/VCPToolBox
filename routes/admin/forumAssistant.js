const express = require('express');

module.exports = function (options) {
    const router = express.Router();
    const pluginManager = options.pluginManager;

    function getModule() {
        return pluginManager.getServiceModule('VCPForumAssistant');
    }

    // GET /forum-assistant/config
    router.get('/forum-assistant/config', (req, res) => {
        try {
            const mod = getModule();
            if (!mod) return res.status(503).json({ error: 'VCPForumAssistant 插件未加载' });
            res.json(mod.getConfig());
        } catch (e) {
            console.error('[ForumAssistant Route] getConfig error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /forum-assistant/config
    router.post('/forum-assistant/config', async (req, res) => {
        try {
            const mod = getModule();
            if (!mod) return res.status(503).json({ error: 'VCPForumAssistant 插件未加载' });
            await mod.updateConfig(req.body);
            res.json({ success: true, message: '论坛巡航配置已保存，定时器已重启。' });
        } catch (e) {
            console.error('[ForumAssistant Route] saveConfig error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /forum-assistant/status
    router.get('/forum-assistant/status', (req, res) => {
        try {
            const mod = getModule();
            if (!mod) return res.status(503).json({ error: 'VCPForumAssistant 插件未加载' });
            res.json(mod.getStatus());
        } catch (e) {
            console.error('[ForumAssistant Route] getStatus error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /forum-assistant/trigger
    router.post('/forum-assistant/trigger', async (req, res) => {
        try {
            const mod = getModule();
            if (!mod) return res.status(503).json({ error: 'VCPForumAssistant 插件未加载' });
            const result = await mod.processToolCall({ command: 'triggerPatrol', agentName: req.body.agentName });
            res.json(result);
        } catch (e) {
            console.error('[ForumAssistant Route] trigger error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
