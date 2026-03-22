const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    const { dailyNoteRootPath, vectorDBManager } = options;

    router.get('/rag-tags', async (req, res) => {
        const ragTagsPath = path.join(__dirname, '..', '..', 'Plugin', 'RAGDiaryPlugin', 'rag_tags.json');
        try {
            const content = await fs.readFile(ragTagsPath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            if (error.code === 'ENOENT') res.json({});
            else res.status(500).json({ error: 'Failed' });
        }
    });

    router.post('/rag-tags', async (req, res) => {
        const ragTagsPath = path.join(__dirname, '..', '..', 'Plugin', 'RAGDiaryPlugin', 'rag_tags.json');
        try {
            await fs.writeFile(ragTagsPath, JSON.stringify(req.body, null, 2), 'utf-8');
            res.json({ message: 'Saved' });
        } catch (error) { res.status(500).json({ error: 'Failed' }); }
    });

    router.get('/rag-params', async (req, res) => {
        const ragParamsPath = path.join(__dirname, '..', '..', 'rag_params.json');
        try {
            const content = await fs.readFile(ragParamsPath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) { res.status(500).json({ error: 'Failed' }); }
    });

    router.post('/rag-params', async (req, res) => {
        const ragParamsPath = path.join(__dirname, '..', '..', 'rag_params.json');
        try {
            await fs.writeFile(ragParamsPath, JSON.stringify(req.body, null, 2), 'utf-8');
            res.json({ message: 'Saved' });
        } catch (error) { res.status(500).json({ error: 'Failed' }); }
    });

    router.get('/semantic-groups', async (req, res) => {
        const editFilePath = path.join(__dirname, '..', '..', 'Plugin', 'RAGDiaryPlugin', 'semantic_groups.edit.json');
        const mainFilePath = path.join(__dirname, '..', '..', 'Plugin', 'RAGDiaryPlugin', 'semantic_groups.json');
        try {
            const content = await fs.readFile(editFilePath, 'utf-8').catch(() => fs.readFile(mainFilePath, 'utf-8'));
            res.json(JSON.parse(content));
        } catch (error) { res.json({ config: {}, groups: {} }); }
    });

    router.post('/semantic-groups', async (req, res) => {
        const editFilePath = path.join(__dirname, '..', '..', 'Plugin', 'RAGDiaryPlugin', 'semantic_groups.edit.json');
        try {
            await fs.writeFile(editFilePath, JSON.stringify(req.body, null, 2), 'utf-8');
            res.json({ message: 'Saved' });
        } catch (error) { res.status(500).json({ error: 'Failed' }); }
    });

    router.get('/thinking-chains', async (req, res) => {
        const chainsPath = path.join(__dirname, '..', '..', 'Plugin', 'RAGDiaryPlugin', 'meta_thinking_chains.json');
        try {
            const content = await fs.readFile(chainsPath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) { res.status(500).json({ error: 'Failed' }); }
    });

    router.post('/thinking-chains', async (req, res) => {
        const chainsPath = path.join(__dirname, '..', '..', 'Plugin', 'RAGDiaryPlugin', 'meta_thinking_chains.json');
        try {
            await fs.writeFile(chainsPath, JSON.stringify(req.body, null, 2), 'utf-8');
            res.json({ message: 'Saved' });
        } catch (error) { res.status(500).json({ error: 'Failed' }); }
    });

    router.get('/available-clusters', async (req, res) => {
        try {
            const entries = await fs.readdir(dailyNoteRootPath, { withFileTypes: true });
            res.json({ clusters: entries.filter(e => e.isDirectory() && e.name.endsWith('簇')).map(e => e.name) });
        } catch (error) { res.json({ clusters: [] }); }
    });

    router.get('/vectordb-status', (req, res) => {
        if (vectorDBManager && typeof vectorDBManager.getHealthStatus === 'function') {
            res.json({ success: true, status: vectorDBManager.getHealthStatus() });
        } else res.status(503).json({ error: 'Unavailable' });
    });

    return router;
};
