const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { getEmbeddingsBatch } = require('../../EmbeddingUtils');

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

    // ===== TagMemo Knowledge Base Search API =====
    // POST /rag/search - Search knowledge base with text query
    router.post('/rag/search', async (req, res) => {
        const { query, diaryName, k = 10, tagBoost, coreTags, coreBoostFactor } = req.body;

        if (!query || typeof query !== 'string') {
            return res.status(400).json({ error: 'Query text is required' });
        }

        if (!vectorDBManager || typeof vectorDBManager.search !== 'function') {
            return res.status(503).json({ error: 'Knowledge base manager not available' });
        }

        try {
            // Convert text query to embedding vector
            const embeddingConfig = vectorDBManager.config?.embedding || {};
            const [queryVec] = await getEmbeddingsBatch([query], embeddingConfig);

            if (!queryVec) {
                return res.status(500).json({ error: 'Failed to generate embedding for query' });
            }

            // Perform search
            const searchOptions = {
                k: parseInt(k) || 10,
                tagBoost: tagBoost || null,
                coreTags: coreTags || [],
                coreBoostFactor: coreBoostFactor || 1.33
            };

            let results;
            if (diaryName && typeof diaryName === 'string') {
                results = await vectorDBManager.search(diaryName, queryVec, searchOptions.k, searchOptions.tagBoost, searchOptions.coreTags, searchOptions.coreBoostFactor);
            } else {
                results = await vectorDBManager.search(queryVec, searchOptions.k, searchOptions.tagBoost, searchOptions.coreTags, searchOptions.coreBoostFactor);
            }

            // Format results for display
            const formattedResults = results.map((r, idx) => ({
                rank: idx + 1,
                score: r.score,
                diaryName: r.diary_name || r.diaryName,
                chunkId: r.chunk_id || r.chunkId,
                content: r.content || r.text || '',
                metadata: r.metadata || {}
            }));

            res.json({
                success: true,
                query,
                total: formattedResults.length,
                results: formattedResults
            });
        } catch (error) {
            console.error('[TagMemo Search] Error:', error.message);
            res.status(500).json({ error: 'Search failed', details: error.message });
        }
    });

    // GET /rag/stats - Get knowledge base statistics
    router.get('/rag/stats', async (req, res) => {
        if (!vectorDBManager) {
            return res.status(503).json({ error: 'Knowledge base manager not available' });
        }

        try {
            const stats = {
                health: vectorDBManager.getHealthStatus ? vectorDBManager.getHealthStatus() : null,
                config: vectorDBManager.config ? {
                    dimension: vectorDBManager.config.dimension,
                    storePath: vectorDBManager.config.storePath,
                    embeddingModel: vectorDBManager.config.embedding?.model || 'unknown'
                } : null
            };

            // Try to get diary count
            if (vectorDBManager.allDiaries) {
                stats.diaryCount = vectorDBManager.allDiaries.length;
                stats.diaries = vectorDBManager.allDiaries.map(d => ({
                    name: d.diary_name || d.name,
                    chunkCount: d.chunk_count || d.chunkCount || 0,
                    lastUpdated: d.last_updated || d.lastUpdated || null
                }));
            }

            res.json(stats);
        } catch (error) {
            console.error('[TagMemo Stats] Error:', error.message);
            res.status(500).json({ error: 'Failed to get stats', details: error.message });
        }
    });

    return router;
};
