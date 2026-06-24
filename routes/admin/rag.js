const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    const { dailyNoteRootPath, vectorDBManager } = options;
    const ragParamsPath = path.join(__dirname, '..', '..', 'rag_params.json');
    const ragParamThemesDir = path.join(__dirname, '..', '..', 'rag_params_themes');

    const readJsonFile = async (filePath, fallback = {}) => {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(content);
        } catch (error) {
            if (error.code === 'ENOENT') return fallback;
            throw error;
        }
    };

    const assertPlainObject = (body) => {
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            const err = new Error('Invalid request body');
            err.statusCode = 400;
            throw err;
        }
    };

    const saveMergedJsonFile = async (filePath, body) => {
        assertPlainObject(body);

        const existing = await readJsonFile(filePath, {});
        await fs.writeFile(filePath, JSON.stringify({ ...existing, ...body }, null, 2), 'utf-8');
    };

    const normalizeThemeName = (rawName) => {
        const value = String(rawName || '').trim();
        const withoutExtension = value.replace(/\.json$/i, '');
        const withoutPrefix = withoutExtension.replace(/^rag_params_/i, '');
        const safeName = withoutPrefix.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

        if (!safeName) {
            const err = new Error('Invalid theme name');
            err.statusCode = 400;
            throw err;
        }

        if (safeName.length > 120) {
            const err = new Error('Theme name is too long');
            err.statusCode = 400;
            throw err;
        }

        return safeName;
    };

    const getThemeFileName = (themeName) => `rag_params_${normalizeThemeName(themeName)}.json`;

    const getThemeFilePath = (themeName) => path.join(ragParamThemesDir, getThemeFileName(themeName));

    const ensureThemeDir = async () => {
        await fs.mkdir(ragParamThemesDir, { recursive: true });
    };

    const writeJsonFile = async (filePath, body) => {
        assertPlainObject(body);
        await fs.writeFile(filePath, JSON.stringify(body, null, 2), 'utf-8');
    };

    const createJsonConfigRoutes = (routePath, fileName) => {
        const configPath = path.join(__dirname, '..', '..', 'Plugin', 'RAGDiaryPlugin', fileName);

        router.get(routePath, async (req, res) => {
            try {
                res.json(await readJsonFile(configPath, {}));
            } catch (error) {
                res.status(500).json({ error: 'Failed' });
            }
        });

        router.post(routePath, async (req, res) => {
            try {
                await saveMergedJsonFile(configPath, req.body);
                res.json({ message: 'Saved' });
            } catch (error) {
                res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Failed' });
            }
        });
    };

    createJsonConfigRoutes('/rag-tags', 'rag_tags.json');
    createJsonConfigRoutes('/tdb-tags', 'tdb_tags.json');

    router.get('/rag-params', async (req, res) => {
        try {
            const content = await fs.readFile(ragParamsPath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) { res.status(500).json({ error: 'Failed' }); }
    });

    router.post('/rag-params', async (req, res) => {
        try {
            await writeJsonFile(ragParamsPath, req.body);
            res.json({ message: 'Saved' });
        } catch (error) { res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Failed' }); }
    });

    router.get('/rag-param-themes', async (req, res) => {
        try {
            await ensureThemeDir();
            const entries = await fs.readdir(ragParamThemesDir, { withFileTypes: true });
            const themes = entries
                .filter((entry) => entry.isFile() && /^rag_params_.+\.json$/i.test(entry.name))
                .map((entry) => {
                    const name = entry.name.replace(/^rag_params_/i, '').replace(/\.json$/i, '');
                    return {
                        name,
                        fileName: entry.name,
                    };
                })
                .sort((left, right) => left.name.localeCompare(right.name));

            res.json({ themes });
        } catch (error) { res.status(500).json({ error: 'Failed' }); }
    });

    router.get('/rag-param-themes/:themeName', async (req, res) => {
        try {
            const themePath = getThemeFilePath(req.params.themeName);
            res.json(await readJsonFile(themePath, {}));
        } catch (error) { res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Failed' }); }
    });

    router.post('/rag-param-themes/:themeName', async (req, res) => {
        try {
            await ensureThemeDir();
            const themeName = normalizeThemeName(req.params.themeName);
            const themePath = getThemeFilePath(themeName);
            await writeJsonFile(themePath, req.body);
            res.json({ message: 'Saved', theme: { name: themeName, fileName: getThemeFileName(themeName) } });
        } catch (error) { res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Failed' }); }
    });

    router.post('/rag-param-themes/:themeName/apply', async (req, res) => {
        try {
            const themeName = normalizeThemeName(req.params.themeName);
            const themeParams = await readJsonFile(getThemeFilePath(themeName));
            await writeJsonFile(ragParamsPath, themeParams);
            res.json({ message: 'Applied', theme: { name: themeName, fileName: getThemeFileName(themeName) }, params: themeParams });
        } catch (error) { res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Failed' }); }
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
