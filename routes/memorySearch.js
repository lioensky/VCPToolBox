'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');

const digest = value => createHash('sha256').update(value).digest('hex');

function mountMemorySearch(app, { grants, serverKey, getBridge }) {
    if (!grants) return;
    const config = JSON.parse(grants);
    if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('Invalid MEMORY_READ_GRANTS');
    const scopes = new Map();
    for (const [key, names] of Object.entries(config)) {
        if (!/^[a-f0-9]{64}$/.test(key) || (serverKey && digest(serverKey) === key) ||
            !Array.isArray(names) || !names.length || names.some(name => typeof name !== 'string' || !name || name.trim() !== name)) {
            throw new Error('Invalid MEMORY_READ_GRANTS entry');
        }
        scopes.set(key, new Set(names));
    }
    if (!scopes.size) return;

    app.post('/v1/memory/search', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const bearer = /^Bearer ([^\s]+)$/i.exec(req.get('authorization') || '');
        const scope = bearer && scopes.get(digest(bearer[1]));
        if (!scope) return res.sendStatus(401);
        const { query, diaries, k = 10 } = req.body || {};
        if (typeof query !== 'string' || !query.trim() || !Array.isArray(diaries) || !diaries.length ||
            diaries.some(name => typeof name !== 'string' || !name.trim()) || !Number.isSafeInteger(k) || k < 1) return res.sendStatus(400);
        if (diaries.some(name => !scope.has(name))) return res.sendStatus(403);
        const requested = new Set(diaries);
        try {
            const bridge = getBridge();
            if (!bridge) return res.sendStatus(503);
            const vector = await bridge.embedText(query);
            if (!vector?.length) return res.sendStatus(503);
            const { results } = await bridge.retrieveDiary({ diaryNames: [...requested], queryText: query, queryVector: vector, k, engine: 'rivermemo', fallback: 'none' });
            const direct = results.filter(row => requested.has(row.diaryName)).map(row => ({
                diary: row.diaryName, file: path.win32.basename(row.sourceFile || ''), text: row.text, score: row.score, scoreSource: 'retrieval'
            }));
            return res.json({ direct });
        } catch {
            return res.status(503).json({ error: 'Memory search unavailable' });
        }
    });
}

module.exports = { mountMemorySearch };
