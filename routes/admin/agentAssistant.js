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
            
            // 直接保存 JSON
            const config = req.body;
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
