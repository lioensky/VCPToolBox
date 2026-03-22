const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    const ASSISTANT_DIR = path.join(__dirname, '..', '..', 'Plugin', 'AgentAssistant');
    const AGENT_ASSISTANT_CONFIG_FILE = path.join(ASSISTANT_DIR, 'AgentAssistantConfig.json');
    const AGENT_ASSISTANT_SCORES_FILE = path.join(ASSISTANT_DIR, 'AgentAssistantScores.json');

    router.get('/agent-assistant/config', async (req, res) => {
        try {
            const content = await fs.readFile(AGENT_ASSISTANT_CONFIG_FILE, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) { res.json({ systemPromptTemplate: '', defaultMemoryPrompt: '' }); }
    });

    router.post('/agent-assistant/config', async (req, res) => {
        try {
            await fs.mkdir(ASSISTANT_DIR, { recursive: true });
            await fs.writeFile(AGENT_ASSISTANT_CONFIG_FILE, JSON.stringify(req.body, null, 2), 'utf-8');
            res.json({ success: true, message: 'Settings saved.' });
        } catch (error) { res.status(500).json({ error: 'Failed' }); }
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
