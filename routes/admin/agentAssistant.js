const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');

module.exports = function(options) {
    const router = express.Router();
    const ASSISTANT_DIR = path.join(__dirname, '..', '..', 'Plugin', 'AgentAssistant');
    const AGENT_ASSISTANT_CONFIG_FILE = path.join(ASSISTANT_DIR, 'config.json');
    const AGENT_ASSISTANT_SCORES_FILE = path.join(ASSISTANT_DIR, 'agent_scores.json');

    router.get('/agent-assistant/config', async (req, res) => {
        try {
            let content = '';
            try {
                content = await fs.readFile(AGENT_ASSISTANT_CONFIG_FILE, 'utf-8');
            } catch (e) {
                // 如果 JSON 不存在，尝试读取旧的 env 并（不在此处）期待插件进行迁移
                content = '{}';
            }
            const config = JSON.parse(content || '{}');
            res.json(config);
        } catch (error) { 
            console.error('[AgentAssistant Route] Load Config Error:', error);
            res.json({ maxHistoryRounds: 7, contextTtlHours: 24, globalSystemPrompt: '', agents: [] }); 
        }
    });

    router.post('/agent-assistant/config', async (req, res) => {
        try {
            await fs.mkdir(ASSISTANT_DIR, { recursive: true });
            
            // 合并旧配置后保存，避免旧版/移动端面板未提交的字段被覆盖丢失
            let existingConfig = {};
            try {
                const existingContent = await fs.readFile(AGENT_ASSISTANT_CONFIG_FILE, 'utf-8');
                existingConfig = JSON.parse(existingContent || '{}');
            } catch (readErr) {
                if (readErr.code !== 'ENOENT') {
                    console.warn('[AgentAssistant Route] Failed to read existing config before save, using request body only:', readErr.message);
                }
            }

            const incomingConfig = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
            const config = {
                ...existingConfig,
                ...incomingConfig
            };
            await fs.writeFile(AGENT_ASSISTANT_CONFIG_FILE, JSON.stringify(config, null, 4), 'utf-8');

            // 触发插件热重载
            if (options.pluginManager) {
                const assistantModule = options.pluginManager.getServiceModule('AgentAssistant');
                if (assistantModule && typeof assistantModule.reloadConfig === 'function') {
                    try {
                        assistantModule.reloadConfig();
                        if (options.DEBUG_MODE) console.log('[AgentAssistant Route] Service config hot-reloaded.');
                    } catch (reloadErr) {
                        console.error('[AgentAssistant Route] Failed to trigger hot-reload:', reloadErr);
                    }
                }
            }

            res.json({ success: true, message: 'Settings saved to config.json and reloaded.' });
        } catch (error) { 
            console.error('[AgentAssistant Route] Save Config Error:', error);
            res.status(500).json({ error: 'Failed to save config.json' }); 
        }
    });

    router.get('/agent-assistant/delegations', async (req, res) => {
        try {
            const assistantModule = options.pluginManager?.getServiceModule('AgentAssistant');
            if (!assistantModule || typeof assistantModule.listDelegations !== 'function') {
                return res.status(503).json({ error: 'AgentAssistant service is not available.' });
            }
            res.json({ success: true, data: assistantModule.listDelegations() });
        } catch (error) {
            console.error('[AgentAssistant Route] List Delegations Error:', error);
            res.status(500).json({ error: 'Failed to list delegations' });
        }
    });

    router.get('/agent-assistant/delegations/:delegationId', async (req, res) => {
        try {
            const assistantModule = options.pluginManager?.getServiceModule('AgentAssistant');
            if (!assistantModule || typeof assistantModule.getDelegationDetail !== 'function') {
                return res.status(503).json({ error: 'AgentAssistant service is not available.' });
            }
            const task = assistantModule.getDelegationDetail(req.params.delegationId);
            if (!task) {
                return res.status(404).json({ error: 'Delegation task not found.' });
            }
            res.json({ success: true, data: task });
        } catch (error) {
            console.error('[AgentAssistant Route] Get Delegation Error:', error);
            res.status(500).json({ error: 'Failed to get delegation detail' });
        }
    });

    router.post('/agent-assistant/delegations/:delegationId/cancel', async (req, res) => {
        try {
            const assistantModule = options.pluginManager?.getServiceModule('AgentAssistant');
            if (!assistantModule || typeof assistantModule.cancelDelegation !== 'function') {
                return res.status(503).json({ error: 'AgentAssistant service is not available.' });
            }
            const reason = req.body?.reason || '用户从管理面板请求取消。';
            const result = assistantModule.cancelDelegation(req.params.delegationId, reason);
            res.status(result.success ? 200 : 404).json(result);
        } catch (error) {
            console.error('[AgentAssistant Route] Cancel Delegation Error:', error);
            res.status(500).json({ error: 'Failed to cancel delegation' });
        }
    });

    router.get('/agent-assistant/scores', async (req, res) => {
        try {
            const content = await fs.readFile(AGENT_ASSISTANT_SCORES_FILE, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) { res.json({}); }
    });

    router.post('/agent-assistant/scores', async (req, res) => {
        try {
            await fs.mkdir(ASSISTANT_DIR, { recursive: true });
            await fs.writeFile(AGENT_ASSISTANT_SCORES_FILE, JSON.stringify(req.body, null, 2), 'utf-8');
            res.json({ success: true, message: 'Scores saved.' });
        } catch (error) { res.status(500).json({ error: 'Failed' }); }
    });

    return router;
};
