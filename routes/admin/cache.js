const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { reidentifyMediaByBase64Key } = require('../../Plugin/ImageProcessor/reidentify_image');

module.exports = function(options) {
    const router = express.Router();

    // --- MultiModal Cache API ---
    router.get('/multimodal-cache', async (req, res) => {
        const cachePath = path.join(__dirname, '..', '..', 'Plugin', 'ImageProcessor', 'multimodal_cache.json');
        try {
            const content = await fs.readFile(cachePath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error reading multimodal cache file:', error);
            if (error.code === 'ENOENT') {
                res.json({});
            } else {
                res.status(500).json({ error: 'Failed to read multimodal cache file', details: error.message });
            }
        }
    });

    router.post('/multimodal-cache', async (req, res) => {
        const { data } = req.body;
        const cachePath = path.join(__dirname, '..', '..', 'Plugin', 'ImageProcessor', 'multimodal_cache.json');
        if (typeof data !== 'object' || data === null) {
            return res.status(400).json({ error: 'Invalid request body. Expected a JSON object in "data" field.' });
        }
        try {
            await fs.writeFile(cachePath, JSON.stringify(data, null, 2), 'utf-8');
            res.json({ message: '多媒体缓存文件已成功保存。' });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error writing multimodal cache file:', error);
            res.status(500).json({ error: 'Failed to write multimodal cache file', details: error.message });
        }
    });

    router.post('/multimodal-cache/reidentify', async (req, res) => {
        const { base64Key } = req.body;
        if (typeof base64Key !== 'string' || !base64Key) {
            return res.status(400).json({ error: 'Invalid request body. Expected { base64Key: string }.' });
        }
        try {
            const result = await reidentifyMediaByBase64Key(base64Key);
            res.json({
                message: '媒体重新识别成功。',
                newDescription: result.newDescription,
                newTimestamp: result.newTimestamp
            });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error reidentifying media:', error);
            res.status(500).json({ error: 'Failed to reidentify media', details: error.message });
        }
    });

    // --- Image Cache API ---
    router.get('/image-cache', async (req, res) => {
        const imageCachePath = path.join(__dirname, '..', '..', 'Plugin', 'ImageProcessor', 'image_cache.json');
        try {
            const content = await fs.readFile(imageCachePath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error reading image cache file:', error);
            if (error.code === 'ENOENT') {
                res.json({});
            } else {
                res.status(500).json({ error: 'Failed to read image cache file', details: error.message });
            }
        }
    });

    router.post('/image-cache', async (req, res) => {
        const { data } = req.body;
        const imageCachePath = path.join(__dirname, '..', '..', 'Plugin', 'ImageProcessor', 'image_cache.json');
        if (typeof data !== 'object' || data === null) {
            return res.status(400).json({ error: 'Invalid request body. Expected a JSON object in "data" field.' });
        }
        try {
            await fs.writeFile(imageCachePath, JSON.stringify(data, null, 2), 'utf-8');
            res.json({ message: '图像缓存文件已成功保存。' });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error writing image cache file:', error);
            res.status(500).json({ error: 'Failed to write image cache file', details: error.message });
        }
    });

    router.post('/image-cache/reidentify', async (req, res) => {
        const { base64Key } = req.body;
        if (typeof base64Key !== 'string' || !base64Key) {
            return res.status(400).json({ error: 'Invalid request body. Expected { base64Key: string }.' });
        }
        try {
            const result = await reidentifyMediaByBase64Key(base64Key);
            res.json({
                message: '图片重新识别成功。',
                newDescription: result.newDescription,
                newTimestamp: result.newTimestamp
            });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error reidentifying image:', error);
            res.status(500).json({ error: 'Failed to reidentify image', details: error.message });
        }
    });

    // POST delete image from cache
    router.delete('/image-cache/delete', async (req, res) => {
        const { base64Key } = req.body;
        if (typeof base64Key !== 'string' || !base64Key) {
            return res.status(400).json({ error: 'Invalid request body. Expected { base64Key: string }.' });
        }
        const imageCachePath = path.join(__dirname, '..', '..', 'Plugin', 'ImageProcessor', 'image_cache.json');
        try {
            const content = await fs.readFile(imageCachePath, 'utf-8');
            const data = JSON.parse(content);
            if (data[base64Key]) {
                delete data[base64Key];
                await fs.writeFile(imageCachePath, JSON.stringify(data, null, 2), 'utf-8');
                res.json({ message: '图片已从缓存中删除。' });
            } else {
                res.status(404).json({ error: 'Image not found in cache' });
            }
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error deleting image from cache:', error);
            res.status(500).json({ error: 'Failed to delete image from cache', details: error.message });
        }
    });

    return router;
};
