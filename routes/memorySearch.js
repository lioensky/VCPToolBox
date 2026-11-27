'use strict';

const { createHash } = require('node:crypto');

const digest = value => createHash('sha256').update(value).digest('hex');

function mountMemorySearch(app, { grants, serverKey, getBridge, ranking }) {
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

    // Ranking stays a server-side policy; clients never pick the retrieval backend.
    const rankingPolicies = new Map([['river', ''], ['jev', '::Jev'], ['rerank', '::Rerank'], [undefined, ''], ['', '']]);
    if (!rankingPolicies.has(ranking)) throw new Error('Invalid MEMORY_SEARCH_RANKING');
    const rankModifiers = rankingPolicies.get(ranking);

    const BODY_KEYS = new Set(['query', 'diaries', 'k', 'conversation', 'coreTags', 'associate', 'metaThinking']);
    const isValidConversation = value => Array.isArray(value) && value.length > 0 && value.length <= 200
        && value.every(m => m && typeof m === 'object' && !Array.isArray(m)
            && (m.role === 'user' || m.role === 'assistant')
            && typeof m.content === 'string'
            && Object.keys(m).every(key => key === 'role' || key === 'content'));
    const isValidCoreTags = value => Array.isArray(value) && value.length <= 16
        && value.every(tag => typeof tag === 'string' && tag.trim().length > 0 && tag.length <= 100);
    const isValidMetaThinking = value => {
        if (value === true) return true;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        return Object.keys(value).every(key => key === 'pool' || key === 'group')
            && (value.pool === undefined || (typeof value.pool === 'string' && value.pool.trim().length > 0 && value.pool.length <= 200))
            && (value.group === undefined || typeof value.group === 'boolean');
    };

    app.post('/v1/memory/search', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const bearer = /^Bearer ([^\s]+)$/i.exec(req.get('authorization') || '');
        const scope = bearer && scopes.get(digest(bearer[1]));
        if (!scope) return res.sendStatus(401);
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).some(key => !BODY_KEYS.has(key))) return res.sendStatus(400);
        const { query, diaries, k = 10, conversation, coreTags = [], associate = false, metaThinking } = body;
        if (typeof query !== 'string' || !query.trim() || !Array.isArray(diaries) || !diaries.length ||
            diaries.some(name => typeof name !== 'string' || !name.trim()) ||
            !Number.isSafeInteger(k) || k < 1 || k > 100) return res.sendStatus(400);
        if (typeof associate !== 'boolean' || !isValidCoreTags(coreTags)) return res.sendStatus(400);
        if (conversation !== undefined) {
            // The last entry must be the current user message, mirroring the native chat projection.
            if (!isValidConversation(conversation)) return res.sendStatus(400);
            const last = conversation[conversation.length - 1];
            if (last.role !== 'user' || last.content !== query) return res.sendStatus(400);
        }
        if (metaThinking !== undefined && !isValidMetaThinking(metaThinking)) return res.sendStatus(400);
        if (diaries.some(name => !scope.has(name))) return res.sendStatus(403);
        try {
            const bridge = getBridge();
            if (!bridge || typeof bridge.recallMemory !== 'function') return res.sendStatus(503);
            let metaOption = null;
            if (metaThinking) {
                // Star pool diaries must be covered by the same read scope, checked before any embedding or retrieval.
                const pool = typeof metaThinking === 'object' ? metaThinking.pool : undefined;
                const group = typeof metaThinking === 'object' ? Boolean(metaThinking.group) : false;
                const poolDiaries = typeof bridge.resolveStarPoolDiaries === 'function'
                    ? bridge.resolveStarPoolDiaries(pool)
                    : [];
                if (!poolDiaries.length || poolDiaries.some(name => !scope.has(name))) return res.sendStatus(403);
                metaOption = { pool, group };
            }
            const result = await bridge.recallMemory({
                query,
                diaries: [...new Set(diaries)],
                k,
                conversation,
                coreTags,
                associate,
                rankModifiers,
                metaThinking: metaOption
            });
            return res.json(result);
        } catch {
            return res.status(503).json({ error: 'Memory search unavailable' });
        }
    });
}

module.exports = { mountMemorySearch };
