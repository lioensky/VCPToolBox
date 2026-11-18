const express = require('express');

const DEFAULT_CHAT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MODELS_TIMEOUT_MS = 30 * 1000;

function getMainServerBaseUrl() {
    const port = process.env.PORT || 3000;
    return `http://127.0.0.1:${port}`;
}

function getServerKey() {
    return process.env.Key || '';
}

function normalizeTimeout(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function copySafeResponseHeaders(upstreamResponse, res) {
    upstreamResponse.headers.forEach((value, name) => {
        if (!['content-encoding', 'transfer-encoding', 'connection', 'content-length', 'keep-alive'].includes(name.toLowerCase())) {
            res.setHeader(name, value);
        }
    });
}

async function proxyJsonRequest(req, res, {
    targetPath,
    timeoutMs,
    logLabel,
    defaultRequestBody
}) {
    const serverKey = getServerKey();
    if (!serverKey) {
        return res.status(503).json({
            error: 'VCP server Key is not configured.',
            message: '请先在 config.env 中配置 Key，用于后台代理安全调用主服务。'
        });
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);

    try {
        const { default: fetch } = await import('node-fetch');
        const targetUrl = `${getMainServerBaseUrl()}${targetPath}`;
        const body = typeof defaultRequestBody === 'undefined' ? (req.body || {}) : defaultRequestBody;

        if (req.app?.locals?.DEBUG_MODE || process.env.DebugMode === 'true') {
            console.log(`[AdminAI] Proxying ${logLabel || targetPath} to ${targetUrl}`);
        }

        const upstreamResponse = await fetch(targetUrl, {
            method: req.method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${serverKey}`,
                ...(req.headers['user-agent'] && { 'User-Agent': req.headers['user-agent'] }),
                ...(req.headers.accept && { 'Accept': req.headers.accept })
            },
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(body),
            signal: abortController.signal
        });

        res.status(upstreamResponse.status);
        copySafeResponseHeaders(upstreamResponse, res);

        if (body && body.stream === true) {
            if (!res.getHeader('Content-Type')) {
                res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            }
            upstreamResponse.body.pipe(res);
            return;
        }

        const responseText = await upstreamResponse.text();
        const contentType = upstreamResponse.headers.get('content-type') || '';

        if (contentType.includes('application/json')) {
            try {
                return res.json(responseText ? JSON.parse(responseText) : {});
            } catch (parseError) {
                return res.type('text/plain').send(responseText);
            }
        }

        return res.send(responseText);
    } catch (error) {
        const isAbort = error && error.name === 'AbortError';
        console.error(`[AdminAI] Failed to proxy ${logLabel || targetPath}:`, error.message);
        if (!res.headersSent) {
            return res.status(isAbort ? 504 : 502).json({
                error: isAbort ? 'Gateway Timeout' : 'Bad Gateway',
                message: isAbort ? '后台 AI 代理请求主服务超时。' : '后台 AI 代理无法连接到主服务。',
                details: error.message
            });
        }
        if (!res.writableEnded) {
            res.end();
        }
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = function(options = {}) {
    const router = express.Router();

    const chatTimeoutMs = normalizeTimeout(
        process.env.ADMIN_AI_CHAT_TIMEOUT_MS || options.adminAiChatTimeoutMs,
        DEFAULT_CHAT_TIMEOUT_MS
    );
    const modelsTimeoutMs = normalizeTimeout(
        process.env.ADMIN_AI_MODELS_TIMEOUT_MS || options.adminAiModelsTimeoutMs,
        DEFAULT_MODELS_TIMEOUT_MS
    );

    router.post('/ai/chat', async (req, res) => {
        await proxyJsonRequest(req, res, {
            targetPath: '/v1/chat/completions',
            timeoutMs: chatTimeoutMs,
            logLabel: '/v1/chat/completions'
        });
    });

    router.post('/ai/chatvcp', async (req, res) => {
        await proxyJsonRequest(req, res, {
            targetPath: '/v1/chatvcp/completions',
            timeoutMs: chatTimeoutMs,
            logLabel: '/v1/chatvcp/completions'
        });
    });

    router.get('/ai/models', async (req, res) => {
        await proxyJsonRequest(req, res, {
            targetPath: '/v1/models',
            timeoutMs: modelsTimeoutMs,
            logLabel: '/v1/models',
            defaultRequestBody: undefined
        });
    });

    return router;
};