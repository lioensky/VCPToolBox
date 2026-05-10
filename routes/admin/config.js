const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    const { pluginManager } = options;

    async function readFileIfExists(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            return { exists: true, content };
        } catch (error) {
            if (error.code === 'ENOENT') {
                return { exists: false, content: '' };
            }
            throw error;
        }
    }

    function normalizeEnvContent(content) {
        return String(content || '').replace(/\r\n/g, '\n').trimEnd();
    }

    // --- Tool Approval Config API ---
    router.get('/tool-approval-config', async (req, res) => {
        const configPath = path.join(__dirname, '..', '..', 'toolApprovalConfig.json');
        try {
            const content = await fs.readFile(configPath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            if (error.code === 'ENOENT') {
                res.json({ enabled: false, timeoutMinutes: 5, approveAll: false, approvalList: [] });
            } else {
                console.error('[AdminPanelRoutes API] Error reading tool approval config:', error);
                res.status(500).json({ error: 'Failed to read tool approval config', details: error.message });
            }
        }
    });

    router.post('/tool-approval-config', async (req, res) => {
        const { config } = req.body;
        if (typeof config !== 'object' || config === null) {
            return res.status(400).json({ error: 'Invalid configuration data. Object expected.' });
        }
        const configPath = path.join(__dirname, '..', '..', 'toolApprovalConfig.json');
        try {
            await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
            res.json({ success: true, message: '工具调用审核配置已成功保存。' });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error writing tool approval config:', error);
            res.status(500).json({ error: 'Failed to write tool approval config', details: error.message });
        }
    });

    // --- Main Config API ---
    router.get('/config/main', async (req, res) => {
        try {
            const configPath = path.join(__dirname, '..', '..', 'config.env');
            const examplePath = path.join(__dirname, '..', '..', 'config.env.example');
            const [configResult, exampleResult] = await Promise.all([
                readFileIfExists(configPath),
                readFileIfExists(examplePath),
            ]);

            const configExists = configResult.exists;
            const exampleExists = exampleResult.exists;
            const configMatchesExample =
                configExists &&
                exampleExists &&
                normalizeEnvContent(configResult.content) ===
                    normalizeEnvContent(exampleResult.content);
            const hasCustomConfig = configExists && (!exampleExists || !configMatchesExample);

            let source = 'none';
            let content = '';

            if (hasCustomConfig) {
                source = 'config.env';
                content = configResult.content;
            } else if (exampleExists) {
                source = 'config.env.example';
                content = exampleResult.content;
            } else if (configExists) {
                source = 'config.env';
                content = configResult.content;
            }

            res.json({
                content,
                exampleContent: exampleExists ? exampleResult.content : '',
                source,
                configExists,
                exampleExists,
                configMatchesExample,
                hasCustomConfig,
            });
        } catch (error) {
            console.error('Error reading main config for admin panel:', error);
            res.status(500).json({ error: 'Failed to read main config file', details: error.message });
        }
    });

    router.get('/config/main/raw', async (req, res) => {
        try {
            const configPath = path.join(__dirname, '..', '..', 'config.env');
            const content = await fs.readFile(configPath, 'utf-8');
            res.json({ content: content });
        } catch (error) {
            console.error('Error reading raw main config for admin panel:', error);
            res.status(500).json({ error: 'Failed to read raw main config file', details: error.message });
        }
    });

    router.post('/config/main', async (req, res) => {
        const { content } = req.body;
        if (typeof content !== 'string') {
            return res.status(400).json({ error: 'Invalid content format. String expected.' });
        }
        try {
            const configPath = path.join(__dirname, '..', '..', 'config.env');
            await fs.writeFile(configPath, content, 'utf-8');
            await pluginManager.loadPlugins();
            res.json({ message: '主配置已成功保存并已重新加载。' });
        } catch (error) {
            console.error('Error writing main config for admin panel:', error);
            res.status(500).json({ error: 'Failed to write main config file', details: error.message });
        }
    });

    return router;
};
