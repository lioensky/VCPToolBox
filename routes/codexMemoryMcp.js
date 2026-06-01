const crypto = require('crypto');
const express = require('express');

const { buildCodexMemoryOverview } = require('../modules/codexMemoryOverview');
const { searchCodexMemory } = require('../modules/codexMemorySearch');
const { executeToolCallWithContext } = require('../modules/toolExecution');

const SERVER_NAME = 'vcp_codex_memory';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-03-26', '2025-06-18']);
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const SESSION_HEADER = 'Mcp-Session-Id';
const SERVER_INSTRUCTIONS = [
    'Use search_memory for read-only Codex diary semantic recall.',
    'Use memory_overview for read-only bridge observability and audit summaries.',
    'Use record_memory only for normal Codex long-term memory candidates that pass durability, validation, reuse, and sensitivity checks.',
    'record_memory is write-capable and remains gated by CodexMemoryBridge; rejected writes are returned as tool errors.',
    'Do not use record_memory for dream diary entries, secrets, raw env values, temporary logs, unverified guesses, or private one-off data.'
].join(' ');

function createToolDefinitions() {
    return [
        {
            name: 'record_memory',
            title: 'Record Codex Memory',
            description: 'Write-capable. Submit a normal Codex long-term memory candidate through CodexMemoryBridge. The bridge may reject unsafe, unvalidated, non-reusable, secret-bearing, or non-Codex-context writes. Do not use this for dream diary entries.',
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false
            },
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    target: {
                        type: 'string',
                        enum: ['process', 'knowledge'],
                        description: 'process for checkpoints/risks/todos/pending/stage conclusions; knowledge for validated reusable conclusions.'
                    },
                    title: { type: 'string', description: 'Short durable memory title. Do not include secrets.' },
                    content: { type: 'string', description: 'Memory body. Must be durable and non-secret.' },
                    evidence: { type: 'string', description: 'Evidence summary or source proving why this memory is valid.' },
                    validated: { type: 'boolean', description: 'Required true for knowledge memories.' },
                    reusable: { type: 'boolean', description: 'Required true for knowledge memories.' },
                    tags: {
                        description: 'Optional comma-like labels. Avoid private identifiers and secrets.',
                        oneOf: [
                            { type: 'string' },
                            { type: 'array', items: { type: 'string' } }
                        ]
                    },
                    sensitivity: { type: 'string', description: 'Use none for knowledge memories. High-risk markers such as secret, token, password, credential, or api key are rejected.' }
                },
                required: ['target', 'title', 'content', 'evidence', 'validated', 'reusable', 'sensitivity']
            }
        },
        {
            name: 'search_memory',
            title: 'Search Codex Memory',
            description: 'Semantic search over the Codex process and knowledge diaries. This is not a global full-text search.',
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            },
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    query: { type: 'string' },
                    target: { type: 'string', enum: ['process', 'knowledge', 'both'] },
                    limit: { type: 'integer', minimum: 1, maximum: 10 },
                    include_content: { type: 'boolean' }
                },
                required: ['query']
            }
        },
        {
            name: 'memory_overview',
            title: 'Codex Memory Overview',
            description: 'Operational overview of bridge audits, recall hits, recent files, and adaptive profile.',
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            },
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    auditWindow: { type: 'integer', minimum: 10, maximum: 2000 },
                    limit: { type: 'integer', minimum: 1, maximum: 50 }
                }
            }
        }
    ];
}

function jsonRpcSuccess(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
    return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: {
            code,
            message,
            ...(data === undefined ? {} : { data })
        }
    };
}

function formatToolResult(payload, isError = false) {
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(payload, null, 2)
            }
        ],
        structuredContent: payload,
        isError
    };
}

function normalizeTags(tags) {
    if (Array.isArray(tags)) {
        return tags.map(tag => String(tag).trim()).filter(Boolean).join(', ');
    }
    return typeof tags === 'string' ? tags : '';
}

function negotiateProtocolVersion(requestedVersion) {
    if (typeof requestedVersion === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)) {
        return requestedVersion;
    }
    return DEFAULT_PROTOCOL_VERSION;
}

module.exports = function createCodexMemoryMcpRouter(options) {
    const router = express.Router();
    const sessions = new Map();
    const {
        pluginManager,
        knowledgeBaseManager,
        ragDiaryPlugin,
        getRagDiaryPlugin,
        projectBasePath,
        dailyNoteRootPath
    } = options;

    function createSession(existingId = null) {
        const sessionId = existingId || crypto.randomUUID();
        if (!sessions.has(sessionId)) {
            sessions.set(sessionId, { streams: new Set() });
        }
        return sessionId;
    }

    function closeSession(sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return;
        for (const stream of session.streams) {
            try {
                stream.end();
            } catch {
                // ignore
            }
        }
        sessions.delete(sessionId);
    }

    async function handleToolCall(req, toolName, args = {}) {
        if (toolName === 'record_memory') {
            const result = await executeToolCallWithContext({
                pluginManager,
                req,
                toolName: 'CodexMemoryBridge',
                toolArgs: {
                    command: 'record',
                    target: args.target,
                    title: args.title,
                    content: args.content,
                    evidence: args.evidence,
                    validated: !!args.validated,
                    reusable: !!args.reusable,
                    tags: normalizeTags(args.tags),
                    sensitivity: args.sensitivity
                },
                executionContext: {
                    agentAlias: 'Codex',
                    agentId: 'codex-desktop',
                    requestSource: 'codex-desktop-mcp'
                }
            });

            return formatToolResult(result, result?.decision === 'rejected');
        }

        if (toolName === 'search_memory') {
            const activeRagDiaryPlugin = typeof getRagDiaryPlugin === 'function'
                ? getRagDiaryPlugin()
                : ragDiaryPlugin;
            const result = await searchCodexMemory({
                query: args.query,
                target: args.target || 'both',
                limit: args.limit,
                includeContent: !!args.include_content,
                knowledgeBaseManager,
                ragDiaryPlugin: activeRagDiaryPlugin
            });
            return formatToolResult({ results: result });
        }

        if (toolName === 'memory_overview') {
            const result = await buildCodexMemoryOverview({
                projectBasePath,
                dailyNoteRootPath,
                auditWindow: args.auditWindow,
                listLimit: args.limit
            });
            return formatToolResult(result);
        }

        throw new Error(`Unknown tool: ${toolName}`);
    }

    async function handleJsonRpc(req, body) {
        const { id = null, method, params = {} } = body || {};

        if (typeof method !== 'string' || !method.trim()) {
            return jsonRpcError(id, -32600, 'Invalid Request', 'method must be a non-empty string');
        }

        if (method === 'initialize') {
            const requestedSessionId = req.get(SESSION_HEADER) || null;
            const sessionId = createSession(requestedSessionId);
            const protocolVersion = negotiateProtocolVersion(params?.protocolVersion);
            return {
                sessionId,
                response: jsonRpcSuccess(id, {
                    protocolVersion,
                    capabilities: {
                        tools: { listChanged: true },
                        resources: { subscribe: false, listChanged: true }
                    },
                    serverInfo: {
                        name: SERVER_NAME,
                        version: SERVER_VERSION
                    },
                    instructions: SERVER_INSTRUCTIONS
                })
            };
        }

        if (method === 'notifications/initialized') {
            return { notification: true };
        }

        if (method === 'ping') {
            return { response: jsonRpcSuccess(id, {}) };
        }

        if (method === 'tools/list') {
            return {
                response: jsonRpcSuccess(id, {
                    tools: createToolDefinitions()
                })
            };
        }

        if (method === 'resources/list') {
            return {
                response: jsonRpcSuccess(id, {
                    resources: []
                })
            };
        }

        if (method === 'resources/templates/list') {
            return {
                response: jsonRpcSuccess(id, {
                    resourceTemplates: []
                })
            };
        }

        if (method === 'tools/call') {
            const toolName = params?.name;
            const toolArgs = params?.arguments || {};

            if (typeof toolName !== 'string' || !toolName.trim()) {
                return {
                    response: jsonRpcError(id, -32602, 'Invalid params', 'tools/call requires params.name')
                };
            }

            try {
                const result = await handleToolCall(req, toolName.trim(), toolArgs);
                return { response: jsonRpcSuccess(id, result) };
            } catch (error) {
                return {
                    response: jsonRpcError(id, -32000, error.message || 'Tool call failed')
                };
            }
        }

        return {
            response: jsonRpcError(id, -32601, `Method not found: ${method}`)
        };
    }

    router.get('/', (req, res) => {
        const sessionId = createSession(req.get(SESSION_HEADER) || null);
        const session = sessions.get(sessionId);

        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader(SESSION_HEADER, sessionId);
        res.flushHeaders?.();

        session.streams.add(res);
        res.write(`: connected ${sessionId}\n\n`);

        const heartbeat = setInterval(() => {
            if (!res.writableEnded) {
                res.write(`: heartbeat ${Date.now()}\n\n`);
            }
        }, 15000);

        req.on('close', () => {
            clearInterval(heartbeat);
            session.streams.delete(res);
            if (session.streams.size === 0) {
                sessions.delete(sessionId);
            }
        });
    });

    router.post('/', async (req, res) => {
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return res.status(400).json(jsonRpcError(null, -32600, 'Invalid Request', 'Expected a JSON-RPC object body.'));
        }

        const result = await handleJsonRpc(req, body);
        if (result.sessionId) {
            res.setHeader(SESSION_HEADER, result.sessionId);
        }

        if (result.notification) {
            return res.status(202).end();
        }

        return res.status(200).json(result.response);
    });

    router.delete('/', (req, res) => {
        const sessionId = req.get(SESSION_HEADER);
        if (!sessionId) {
            return res.status(400).json({ error: `${SESSION_HEADER} header is required.` });
        }

        closeSession(sessionId);
        return res.status(204).end();
    });

    return router;
};
