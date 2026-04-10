const express = require('express');

module.exports = function (options) {
    const router = express.Router();
    const pluginManager = options.pluginManager;

    function getModule() {
        return pluginManager.getServiceModule('VCPTaskAssistant');
    }

    function ensureModule(res) {
        const mod = getModule();
        if (!mod) {
            res.status(503).json({ error: 'VCPTaskAssistant 插件未加载' });
            return null;
        }
        return mod;
    }

    router.get('/task-assistant/config', (req, res) => {
        try {
            const mod = ensureModule(res);
            if (!mod) return;
            res.json(mod.getConfig());
        } catch (e) {
            console.error('[TaskAssistant Route] getConfig error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/task-assistant/config', async (req, res) => {
        try {
            const mod = ensureModule(res);
            if (!mod) return;
            await mod.updateConfig(req.body || {});
            res.json({ success: true, message: '任务派发中心配置已保存。' });
        } catch (e) {
            console.error('[TaskAssistant Route] saveConfig error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/task-assistant/status', (req, res) => {
        try {
            const mod = ensureModule(res);
            if (!mod) return;
            res.json(mod.getStatus());
        } catch (e) {
            console.error('[TaskAssistant Route] getStatus error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/task-assistant/trigger', async (req, res) => {
        try {
            const mod = ensureModule(res);
            if (!mod) return;

            if (req.body.taskId) {
                const result = await mod.triggerTask(req.body.taskId);
                res.json({ success: true, ...result });
                return;
            }

            if (req.body.agentName) {
                const config = mod.getConfig();
                const matchedTask = (config.config?.tasks || []).find(task =>
                    task.type === 'forum_patrol' &&
                    Array.isArray(task.targets?.agents) &&
                    task.targets.agents.includes(req.body.agentName)
                );

                if (!matchedTask) {
                    return res.status(404).json({ error: `未找到 Agent "${req.body.agentName}" 对应的巡航任务` });
                }

                const result = await mod.triggerTask(matchedTask.id);
                res.json({ success: true, ...result });
                return;
            }

            res.status(400).json({ error: '缺少 taskId 或 agentName' });
        } catch (e) {
            console.error('[TaskAssistant Route] trigger error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/task-assistant/tasks', (req, res) => {
        try {
            const mod = ensureModule(res);
            if (!mod) return;
            const data = mod.getConfig();
            res.json({
                success: true,
                tasks: data.config?.tasks || [],
                availableTaskTypes: data.availableTaskTypes || [],
                taskTemplates: data.taskTemplates || {}
            });
        } catch (e) {
            console.error('[TaskAssistant Route] listTasks error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/task-assistant/tasks', async (req, res) => {
        try {
            const mod = ensureModule(res);
            if (!mod) return;
            const task = await mod.createTask(req.body || {});
            res.json({ success: true, task });
        } catch (e) {
            console.error('[TaskAssistant Route] createTask error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    router.patch('/task-assistant/tasks/:taskId', async (req, res) => {
        try {
            const mod = ensureModule(res);
            if (!mod) return;
            const task = await mod.updateTask(req.params.taskId, req.body || {});
            res.json({ success: true, task });
        } catch (e) {
            console.error('[TaskAssistant Route] updateTask error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    router.delete('/task-assistant/tasks/:taskId', async (req, res) => {
        try {
            const mod = ensureModule(res);
            if (!mod) return;
            const removed = await mod.deleteTask(req.params.taskId);
            res.json({ success: true, removed });
        } catch (e) {
            console.error('[TaskAssistant Route] deleteTask error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
