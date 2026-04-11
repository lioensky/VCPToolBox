const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    const { agentDirPath, DEBUG_MODE } = options;
    const AGENT_FILES_DIR = agentDirPath;
    const AGENT_MAP_FILE = path.join(__dirname, '..', '..', 'agent_map.json');

    // 确保 agentManager 单例在当前进程中已正确配置
    // 在独立 adminServer 进程中，agentManager.initialize() 不会被主服务调用，
    // 因此需要在此处设置目录并触发文件扫描
    const agentManager = require('../../modules/agentManager');
    const _agentScanReady = (async () => {
        try {
            agentManager.setAgentDir(AGENT_FILES_DIR);
            agentManager.debugMode = !!DEBUG_MODE;
            await agentManager.scanAgentFiles();
        } catch (err) {
            console.error('[routes/admin/agents] Failed to initialize agentManager scan:', err.message);
        }
    })();

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
            await _agentScanReady; // 确保初始扫描已完成
            const agentFilesData = await agentManager.getAllAgentFiles();
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

    return router;
};
