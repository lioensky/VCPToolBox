const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    const { tvsDirPath } = options;
    const TOOLBOX_MAP_FILE = path.join(__dirname, '..', '..', 'toolbox_map.json');
    const TVSTXT_DIR_PATH = tvsDirPath;
    const TOOLBOX_ALIAS_REGEX = /^[A-Za-z0-9_]+$/;

    function isPathInsideRoot(targetPath, rootPath) {
        const resolvedTarget = path.resolve(targetPath);
        const resolvedRoot = path.resolve(rootPath);
        return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
    }

    function safeResolveUnderTVSTxt(relativePath = '') {
        const normalizedRelativePath = String(relativePath || '').replace(/\\/g, '/');
        const resolved = path.resolve(TVSTXT_DIR_PATH, normalizedRelativePath);
        if (!isPathInsideRoot(resolved, TVSTXT_DIR_PATH)) {
            throw new Error('Invalid path: outside TVStxt root');
        }
        if (resolved === path.resolve(TVSTXT_DIR_PATH)) {
            throw new Error('Invalid path: target resolves to root directory');
        }
        return resolved;
    }

    function normalizeToolboxMap(rawMap) {
        if (!rawMap || typeof rawMap !== 'object') return {};
        const normalized = {};
        for (const [alias, rawValue] of Object.entries(rawMap)) {
            if (typeof rawValue === 'string') {
                normalized[alias] = { file: rawValue, description: '' };
            } else if (rawValue && typeof rawValue === 'object') {
                normalized[alias] = {
                    file: typeof rawValue.file === 'string' ? rawValue.file : '',
                    description: typeof rawValue.description === 'string' ? rawValue.description : ''
                };
            }
        }
        return normalized;
    }

    function serializeToolboxMap(normalizedMap) {
        const serialized = {};
        for (const [alias, value] of Object.entries(normalizedMap || {})) {
            if (!value || typeof value !== 'object') continue;
            const file = typeof value.file === 'string' ? value.file.replace(/\\/g, '/') : '';
            const description = typeof value.description === 'string' ? value.description.trim() : '';
            if (!file) continue;
            serialized[alias] = description
                ? { file, description }
                : file;
        }
        return serialized;
    }

    function buildFolderStructureFromFiles(files) {
        const root = {};
        for (const filePath of files) {
            const segments = filePath.split('/').filter(Boolean);
            let current = root;
            for (let i = 0; i < segments.length; i += 1) {
                const segment = segments[i];
                const isLast = i === segments.length - 1;
                if (isLast) {
                    current[segment] = { type: 'file', path: filePath };
                } else {
                    if (!current[segment] || current[segment].type !== 'folder') {
                        current[segment] = { type: 'folder', children: {} };
                    }
                    current = current[segment].children;
                }
            }
        }
        return root;
    }

    async function scanTVSTxtFiles() {
        await fs.mkdir(TVSTXT_DIR_PATH, { recursive: true });
        const results = [];
        async function walk(currentDir, relativePrefix = '') {
            const entries = await fs.readdir(currentDir, { withFileTypes: true });
            for (const entry of entries) {
                const entryAbsolutePath = path.join(currentDir, entry.name);
                const entryRelativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    await walk(entryAbsolutePath, entryRelativePath);
                    continue;
                }
                if (!entry.isFile()) continue;
                const lower = entry.name.toLowerCase();
                if (lower.endsWith('.txt') || lower.endsWith('.md')) {
                    results.push(entryRelativePath.replace(/\\/g, '/'));
                }
            }
        }
        await walk(TVSTXT_DIR_PATH);
        results.sort((a, b) => a.localeCompare(b));
        return {
            files: results,
            folderStructure: buildFolderStructureFromFiles(results)
        };
    }

    // GET toolbox map
    router.get('/toolbox/map', async (req, res) => {
        try {
            const content = await fs.readFile(TOOLBOX_MAP_FILE, 'utf-8');
            res.json(normalizeToolboxMap(JSON.parse(content)));
        } catch (error) {
            if (error.code === 'ENOENT') res.json({});
            else res.status(500).json({ error: 'Failed to read toolbox map file', details: error.message });
        }
    });

    // POST save toolbox map
    router.post('/toolbox/map', async (req, res) => {
        const payload = req.body;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return res.status(400).json({ error: 'Invalid request body.' });
        }
        try {
            const normalized = normalizeToolboxMap(payload);
            const validated = {};
            for (const [alias, value] of Object.entries(normalized)) {
                if (!alias || !TOOLBOX_ALIAS_REGEX.test(alias)) {
                    return res.status(400).json({ error: `Invalid alias '${alias}'.` });
                }
                const { file, description } = value;
                if (typeof file !== 'string' || !file.trim()) {
                    return res.status(400).json({ error: `Invalid file for alias '${alias}'.` });
                }
                const absolute = safeResolveUnderTVSTxt(file);
                if (!isPathInsideRoot(absolute, TVSTXT_DIR_PATH)) {
                    return res.status(400).json({ error: `Invalid file path for alias '${alias}'.` });
                }
                validated[alias] = { file: file.replace(/\\/g, '/'), description: description || '' };
            }
            await fs.writeFile(TOOLBOX_MAP_FILE, JSON.stringify(serializeToolboxMap(validated), null, 2), 'utf-8');
            try {
                const toolboxManager = require('../../modules/toolboxManager');
                if (toolboxManager && typeof toolboxManager.loadMap === 'function') await toolboxManager.loadMap();
            } catch (e) {}
            res.json({ message: 'Toolbox map saved successfully.' });
        } catch (error) {
            res.status(500).json({ error: 'Failed to write toolbox map file', details: error.message });
        }
    });

    // GET toolbox files
    router.get('/toolbox/files', async (req, res) => {
        try {
            const result = await scanTVSTxtFiles();
            res.json(result);
        } catch (error) {
            res.status(500).json({ error: 'Failed to list toolbox files', details: error.message });
        }
    });

    // GET toolbox file content
    router.get('/toolbox/file/:encodedPath', async (req, res) => {
        try {
            const decodedPath = decodeURIComponent(req.params.encodedPath || '');
            const lower = decodedPath.toLowerCase();
            if (!lower.endsWith('.txt') && !lower.endsWith('.md')) {
                return res.status(400).json({ error: 'Invalid file name.' });
            }
            const filePath = safeResolveUnderTVSTxt(decodedPath);
            const content = await fs.readFile(filePath, 'utf-8');
            res.json({ content });
        } catch (error) {
            if (error.code === 'ENOENT') res.status(404).json({ error: 'Toolbox file not found.' });
            else res.status(500).json({ error: 'Failed to read toolbox file', details: error.message });
        }
    });

    // POST save toolbox file content
    router.post('/toolbox/file/:encodedPath', async (req, res) => {
        const { content } = req.body;
        if (typeof content !== 'string') return res.status(400).json({ error: 'Invalid request body.' });
        try {
            const decodedPath = decodeURIComponent(req.params.encodedPath || '');
            const lower = decodedPath.toLowerCase();
            if (!lower.endsWith('.txt') && !lower.endsWith('.md')) {
                return res.status(400).json({ error: 'Invalid file name.' });
            }
            const filePath = safeResolveUnderTVSTxt(decodedPath);
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, content, 'utf-8');
            try {
                const toolboxManager = require('../../modules/toolboxManager');
                if (toolboxManager && toolboxManager.contentCache instanceof Map) {
                    toolboxManager.contentCache.delete(decodedPath.replace(/\\/g, '/'));
                }
            } catch (e) {}
            res.json({ message: 'Toolbox file saved successfully.' });
        } catch (error) {
            res.status(500).json({ error: 'Failed to save toolbox file', details: error.message });
        }
    });

    // POST create new toolbox file
    router.post('/toolbox/new-file', async (req, res) => {
        const { fileName, folderPath } = req.body;
        if (!fileName || typeof fileName !== 'string' || !fileName.trim()) {
            return res.status(400).json({ error: 'Invalid fileName.' });
        }
        let finalFileName = fileName.trim();
        if (!/\.(txt|md)$/i.test(finalFileName)) finalFileName = `${finalFileName}.txt`;
        try {
            const normalizedFolderPath = typeof folderPath === 'string' ? folderPath.trim() : '';
            const sanitizedFolderPath = normalizedFolderPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
            const targetDir = sanitizedFolderPath ? safeResolveUnderTVSTxt(sanitizedFolderPath) : path.resolve(TVSTXT_DIR_PATH);
            const targetRelativePath = sanitizedFolderPath ? path.posix.join(sanitizedFolderPath, finalFileName) : finalFileName;
            const targetFilePath = safeResolveUnderTVSTxt(targetRelativePath);
            await fs.mkdir(targetDir, { recursive: true });
            await fs.writeFile(targetFilePath, '', { encoding: 'utf-8', flag: 'wx' });
            res.json({ message: `Toolbox file '${finalFileName}' created successfully.` });
        } catch (error) {
            if (error.code === 'EEXIST') res.status(409).json({ error: `File '${finalFileName}' already exists.` });
            else res.status(500).json({ error: 'Failed to create toolbox file', details: error.message });
        }
    });

    return router;
};
