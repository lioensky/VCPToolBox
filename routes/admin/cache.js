const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const Database = require('better-sqlite3');
const { reidentifyMediaByBase64Key } = require('../../Plugin/ImageProcessor/reidentify_image');

module.exports = function(options) {
    const router = express.Router();

    // --- SQLite Database Connection ---
    const dbPath = path.join(__dirname, '..', '..', 'Plugin', 'ImageProcessor', 'multimodal_cache.sqlite');
    let db;
    try {
        db = new Database(dbPath, { fileMustExist: false });
    } catch (err) {
        console.error('[AdminAPI] Failed to open multimodal cache database:', err);
    }

    // --- MultiModal Cache API (SQLite + Pagination + Search) ---
    router.get('/multimodal-cache', async (req, res) => {
        if (!db) {
            return res.status(503).json({ error: 'Database not available' });
        }

        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 20;
        const search = req.query.search || '';
        const offset = (page - 1) * pageSize;

        try {
            let itemsQuery = 'SELECT hash, description, timestamp, mime_type as mimeType, base64 FROM multimodal_cache';
            let countQuery = 'SELECT COUNT(*) as total FROM multimodal_cache';
            const params = [];

            if (search) {
                const searchParam = `%${search}%`;
                itemsQuery += ' WHERE description LIKE ?';
                countQuery += ' WHERE description LIKE ?';
                params.push(searchParam);
            }

            itemsQuery += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
            const itemsParams = [...params, pageSize, offset];

            const items = db.prepare(itemsQuery).all(...itemsParams);
            const totalResult = db.prepare(countQuery).get(...params);
            const total = totalResult ? totalResult.total : 0;
            const totalPages = Math.ceil(total / pageSize);

            res.json({
                items,
                total,
                page,
                totalPages,
                pageSize
            });
        } catch (error) {
            console.error('[AdminAPI] Error querying multimodal cache:', error);
            res.status(500).json({ error: 'Failed to query database', details: error.message });
        }
    });

    // Update single entry
    router.post('/multimodal-cache/update', async (req, res) => {
        const { hash, description } = req.body;
        if (!hash || typeof description !== 'string') {
            return res.status(400).json({ error: 'Invalid request body. Expected { hash: string, description: string }.' });
        }

        try {
            const result = db.prepare('UPDATE multimodal_cache SET description = ? WHERE hash = ?').run(description, hash);
            if (result.changes > 0) {
                res.json({ message: '条目已成功更新。' });
            } else {
                res.status(404).json({ error: 'Entry not found' });
            }
        } catch (error) {
            console.error('[AdminAPI] Error updating multimodal cache:', error);
            res.status(500).json({ error: 'Failed to update database', details: error.message });
        }
    });

    // Delete single entry
    router.delete('/multimodal-cache/:hash', async (req, res) => {
        const hash = req.params.hash;
        try {
            const result = db.prepare('DELETE FROM multimodal_cache WHERE hash = ?').run(hash);
            if (result.changes > 0) {
                res.json({ message: '条目已成功删除。' });
            } else {
                res.status(404).json({ error: 'Entry not found' });
            }
        } catch (error) {
            console.error('[AdminAPI] Error deleting from multimodal cache:', error);
            res.status(500).json({ error: 'Failed to delete from database', details: error.message });
        }
    });

    router.post('/multimodal-cache/reidentify', async (req, res) => {
        const { base64Key, hash } = req.body;
        // Search by hash first if available, else by base64Key
        const identifier = hash || base64Key;

        if (!identifier) {
            return res.status(400).json({ error: 'Invalid request body.' });
        }

        try {
            // If we have hash, we need to get the base64 first
            let base64 = base64Key;
            if (hash && !base64) {
                const row = db.prepare('SELECT base64 FROM multimodal_cache WHERE hash = ?').get(hash);
                if (row) base64 = row.base64;
            }

            if (!base64) {
                return res.status(404).json({ error: 'Media content not found for reidentification' });
            }

            const result = await reidentifyMediaByBase64Key(base64);
            
            // Update DB if hash is available
            if (hash) {
                db.prepare('UPDATE multimodal_cache SET description = ?, timestamp = ? WHERE hash = ?')
                  .run(result.newDescription, result.newTimestamp, hash);
            }

            res.json({
                message: '媒体重新识别成功。',
                newDescription: result.newDescription,
                newTimestamp: result.newTimestamp
            });
        } catch (error) {
            console.error('[AdminAPI] Error reidentifying media:', error);
            res.status(500).json({ error: 'Failed to reidentify media', details: error.message });
        }
    });

    // --- Legacy / Other Cache Support (Optional / Keeping for compatibility) ---
    // Note: If image_cache.json is still used, keep these. If not, they can be removed later.

    router.get('/image-cache', async (req, res) => {
        const imageCachePath = path.join(__dirname, '..', '..', 'Plugin', 'ImageProcessor', 'image_cache.json');
        try {
            const content = await fs.readFile(imageCachePath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            if (error.code === 'ENOENT') res.json({});
            else res.status(500).json({ error: 'Failed to read image cache', details: error.message });
        }
    });

    router.post('/image-cache', async (req, res) => {
        const { data } = req.body;
        const imageCachePath = path.join(__dirname, '..', '..', 'Plugin', 'ImageProcessor', 'image_cache.json');
        try {
            await fs.writeFile(imageCachePath, JSON.stringify(data, null, 2), 'utf-8');
            res.json({ message: '图像缓存已保存。' });
        } catch (error) {
            res.status(500).json({ error: 'Failed to save', details: error.message });
        }
    });

    return router;
};
