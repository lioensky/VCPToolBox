const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    const { tvsDirPath } = options;
    const TVS_FILES_DIR = tvsDirPath;

    // GET list of TVS files
    router.get('/tvsvars', async (req, res) => {
        try {
            await fs.mkdir(TVS_FILES_DIR, { recursive: true });
            const files = await fs.readdir(TVS_FILES_DIR);
            const txtFiles = files.filter(file => file.toLowerCase().endsWith('.txt'));
            res.json({ files: txtFiles });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error listing TVS files:', error);
            res.status(500).json({ error: 'Failed to list TVS files', details: error.message });
        }
    });

    // GET specific TVS file content
    router.get('/tvsvars/:fileName', async (req, res) => {
        const { fileName } = req.params;
        if (!fileName.toLowerCase().endsWith('.txt')) {
            return res.status(400).json({ error: 'Invalid file name. Must be a .txt file.' });
        }
        const filePath = path.join(TVS_FILES_DIR, fileName);
        try {
            await fs.access(filePath);
            const content = await fs.readFile(filePath, 'utf-8');
            res.json({ content });
        } catch (error) {
            if (error.code === 'ENOENT') res.status(404).json({ error: 'TVS file not found.' });
            else res.status(500).json({ error: 'Failed to read TVS file', details: error.message });
        }
    });

    // POST save specific TVS file content
    router.post('/tvsvars/:fileName', async (req, res) => {
        const { fileName } = req.params;
        const { content } = req.body;
        if (!fileName.toLowerCase().endsWith('.txt')) {
            return res.status(400).json({ error: 'Invalid file name.' });
        }
        if (typeof content !== 'string') return res.status(400).json({ error: 'Invalid request body.' });
        const filePath = path.join(TVS_FILES_DIR, fileName);
        try {
            await fs.mkdir(TVS_FILES_DIR, { recursive: true });
            await fs.writeFile(filePath, content, 'utf-8');
            res.json({ message: `TVS file '${fileName}' saved successfully.` });
        } catch (error) {
            res.status(500).json({ error: 'Failed to save TVS file', details: error.message });
        }
    });

    return router;
};
