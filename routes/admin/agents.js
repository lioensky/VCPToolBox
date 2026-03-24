const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    const { agentDirPath } = options;
    const AGENT_FILES_DIR = agentDirPath;
    const AGENT_MAP_FILE = path.join(__dirname, '..', '..', 'agent_map.json');
    const CURRENT_AGENT_FILE = path.join(__dirname, '..', '..', 'current_agent.json');

    // GET agent map
    router.get('/agents/map', async (req, res) => {
        try {
            const content = await fs.readFile(AGENT_MAP_FILE, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            if (error.code === 'ENOENT') res.json({});
            else res.status(500).json({ error: 'Failed to read agent map file', details: error.message });
        }
    });

    // POST save agent map
    router.post('/agents/map', async (req, res) => {
        const newMap = req.body;
        if (typeof newMap !== 'object' || newMap === null) {
            return res.status(400).json({ error: 'Invalid request body.' });
        }
        try {
            await fs.writeFile(AGENT_MAP_FILE, JSON.stringify(newMap, null, 2), 'utf-8');
            res.json({ message: 'Agent map saved successfully. A server restart may be required for changes to apply.' });
        } catch (error) {
            res.status(500).json({ error: 'Failed to write agent map file', details: error.message });
        }
    });

    // GET list of agent files
    router.get('/agents', async (req, res) => {
        try {
            const agentManager = require('../../modules/agentManager');
            const agentFilesData = agentManager.getAllAgentFiles();
            res.json(agentFilesData);
        } catch (error) {
            res.status(500).json({ error: 'Failed to list agent files', details: error.message });
        }
    });

    // POST create new agent file
    router.post('/agents/new-file', async (req, res) => {
        const { fileName, folderPath } = req.body;
        if (!fileName || typeof fileName !== 'string') {
            return res.status(400).json({ error: 'Invalid file name.' });
        }
        let finalFileName = fileName;
        if (!fileName.toLowerCase().endsWith('.txt') && !fileName.toLowerCase().endsWith('.md')) {
            finalFileName = `${fileName}.txt`;
        }
        let targetDir = AGENT_FILES_DIR;
        if (folderPath && typeof folderPath === 'string') {
            targetDir = path.join(AGENT_FILES_DIR, folderPath);
        }
        const filePath = path.join(targetDir, finalFileName);
        try {
            await fs.mkdir(targetDir, { recursive: true });
            await fs.writeFile(filePath, '', { flag: 'wx' });
            const agentManager = require('../../modules/agentManager');
            await agentManager.scanAgentFiles();
            res.json({ message: `File '${finalFileName}' created successfully.` });
        } catch (error) {
            if (error.code === 'EEXIST') res.status(409).json({ error: `File '${finalFileName}' already exists.` });
            else res.status(500).json({ error: `Failed to create agent file ${finalFileName}`, details: error.message });
        }
    });

    // GET specific agent file content
    router.get('/agents/:fileName', async (req, res) => {
        try {
            const decodedFileName = decodeURIComponent(req.params.fileName);
            if (!decodedFileName.toLowerCase().endsWith('.txt') && !decodedFileName.toLowerCase().endsWith('.md')) {
                return res.status(400).json({ error: 'Invalid file name.' });
            }
            const filePath = path.join(AGENT_FILES_DIR, decodedFileName.replace(/\//g, path.sep));
            await fs.access(filePath);
            const content = await fs.readFile(filePath, 'utf-8');
            res.json({ content });
        } catch (error) {
            if (error.code === 'ENOENT') res.status(404).json({ error: 'Agent file not found.' });
            else res.status(500).json({ error: 'Failed to read agent file', details: error.message });
        }
    });

    // POST save specific agent file content
    router.post('/agents/:fileName', async (req, res) => {
        const { content } = req.body;
        try {
            const decodedFileName = decodeURIComponent(req.params.fileName);
            if (!decodedFileName.toLowerCase().endsWith('.txt') && !decodedFileName.toLowerCase().endsWith('.md')) {
                return res.status(400).json({ error: 'Invalid file name.' });
            }
            if (typeof content !== 'string') return res.status(400).json({ error: 'Invalid request body.' });
            const filePath = path.join(AGENT_FILES_DIR, decodedFileName.replace(/\//g, path.sep));
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, content, 'utf-8');
            res.json({ message: `Agent file '${decodedFileName}' saved successfully.` });
        } catch (error) {
            res.status(500).json({ error: 'Failed to save agent file', details: error.message });
        }
    });

    // ===== Agent Activation API =====
    // GET /agents/active - Get currently active agent
    router.get('/agents/active', async (req, res) => {
        try {
            let currentAgent = { name: null, file: null };
            try {
                const content = await fs.readFile(CURRENT_AGENT_FILE, 'utf-8');
                currentAgent = JSON.parse(content);
            } catch (e) {
                // File doesn't exist, return default
                if (e.code !== 'ENOENT') console.warn('[Agent] Failed to read current_agent.json:', e.message);
            }

            // Also read agent_map to get full list
            let agentMap = {};
            try {
                const mapContent = await fs.readFile(AGENT_MAP_FILE, 'utf-8');
                agentMap = JSON.parse(mapContent);
            } catch (e) {
                // ignore
            }

            res.json({
                active: currentAgent.name,
                activeFile: currentAgent.file,
                availableAgents: Object.keys(agentMap)
            });
        } catch (error) {
            res.status(500).json({ error: 'Failed to get active agent', details: error.message });
        }
    });

    // POST /agents/activate - Activate a specific agent
    router.post('/agents/activate', async (req, res) => {
        const { name, file } = req.body;

        if (!name || typeof name !== 'string') {
            return res.status(400).json({ error: 'Agent name is required' });
        }

        try {
            // Validate agent exists in agent_map
            let agentMap = {};
            try {
                const mapContent = await fs.readFile(AGENT_MAP_FILE, 'utf-8');
                agentMap = JSON.parse(mapContent);
            } catch (e) {
                // ignore
            }

            // If file not specified, try to find in map
            let targetFile = file;
            if (!targetFile && agentMap[name]) {
                targetFile = agentMap[name];
            } else if (!targetFile) {
                // Check if name is actually a filename
                targetFile = name;
            }

            // Validate file exists
            const filePath = path.join(AGENT_FILES_DIR, targetFile.replace(/\//g, path.sep));
            try {
                await fs.access(filePath);
            } catch (e) {
                return res.status(404).json({ error: `Agent file not found: ${targetFile}` });
            }

            // Save current agent
            const currentAgent = { name, file: targetFile, activatedAt: new Date().toISOString() };
            await fs.writeFile(CURRENT_AGENT_FILE, JSON.stringify(currentAgent, null, 2), 'utf-8');

            res.json({
                message: `Agent '${name}' activated successfully`,
                active: name,
                activeFile: targetFile
            });
        } catch (error) {
            res.status(500).json({ error: 'Failed to activate agent', details: error.message });
        }
    });

    return router;
};
