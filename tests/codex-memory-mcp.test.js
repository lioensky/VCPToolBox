const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const createCodexMemoryMcpRouter = require('../routes/codexMemoryMcp');
const { KNOWLEDGE_DIARY_NAME, PROCESS_DIARY_NAME } = require('../modules/codexMemoryConstants');

async function withServer(handler) {
    const tempBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-codex-mcp-test-'));
    const dailyNoteRootPath = path.join(tempBasePath, 'dailynote');
    const logsDir = path.join(tempBasePath, 'logs');
    const processDiaryPath = path.join(dailyNoteRootPath, PROCESS_DIARY_NAME);
    const knowledgeDiaryPath = path.join(dailyNoteRootPath, KNOWLEDGE_DIARY_NAME);
    const recordCalls = [];

    await fs.mkdir(logsDir, { recursive: true });
    await fs.mkdir(processDiaryPath, { recursive: true });
    await fs.mkdir(knowledgeDiaryPath, { recursive: true });
    await fs.writeFile(path.join(logsDir, 'codex-memory-bridge.jsonl'), '', 'utf8');
    await fs.writeFile(path.join(logsDir, 'codex-memory-recall.jsonl'), '', 'utf8');

    const pluginManager = {
        async processToolCall(toolName, toolArgs, requestIp, executionContext) {
            recordCalls.push({ toolName, toolArgs, requestIp, executionContext });
            return {
                decision: 'accepted',
                toolName,
                toolArgs,
                requestIp,
                executionContext
            };
        }
    };

    const knowledgeBaseManager = {
        config: { rootPath: dailyNoteRootPath },
        async search(dbName) {
            return [
                {
                    text: `Memory-ID: ${dbName === PROCESS_DIARY_NAME ? 'codex-process-1' : 'codex-knowledge-1'}\nTitle: ${dbName} result\nBody line`,
                    score: dbName === PROCESS_DIARY_NAME ? 0.88 : 0.71,
                    fullPath: `${dbName}/2026-04-13-00_00_01.txt`,
                    matchedTags: ['tag-a']
                }
            ];
        }
    };

    const ragDiaryPlugin = {
        async getSingleEmbeddingCached() {
            return [0.2, 0.3, 0.4];
        },
        _buildCodexRecallAuditPayload({ dbName, recallType, results }) {
            return {
                dbName,
                target: dbName === PROCESS_DIARY_NAME ? 'process' : 'knowledge',
                recallType,
                resultCount: results.length
            };
        },
        async _recordCodexRecallAudit(payload, overrides) {
            await fs.appendFile(
                path.join(logsDir, 'codex-memory-recall.jsonl'),
                `${JSON.stringify({ ...payload, ...overrides })}\n`,
                'utf8'
            );
        },
        _stripCodexMemoryMarkers(text) {
            return text.replace(/^Memory-ID:\s*[A-Za-z0-9-]+\n?/m, '').trim();
        },
        _extractMemoryIdsFromText(text) {
            const match = text.match(/Memory-ID:\s*([A-Za-z0-9-]+)/);
            return match ? [match[1]] : [];
        }
    };

    await fs.writeFile(path.join(processDiaryPath, '2026-04-13-00_00_01.txt'), 'Memory-ID: codex-process-1\nTitle: Codex result\nBody line', 'utf8');
    await fs.writeFile(path.join(knowledgeDiaryPath, '2026-04-13-00_00_01.txt'), 'Memory-ID: codex-knowledge-1\nTitle: Knowledge result\nBody line', 'utf8');

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        if (req.headers.authorization !== 'Bearer test-key') {
            return res.status(401).json({ error: 'Unauthorized (Bearer token required)' });
        }
        return next();
    });
    app.use('/mcp/codex-memory', createCodexMemoryMcpRouter({
        pluginManager,
        knowledgeBaseManager,
        ragDiaryPlugin,
        projectBasePath: tempBasePath,
        dailyNoteRootPath
    }));

    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    try {
        await handler({
            baseUrl: `http://127.0.0.1:${server.address().port}/mcp/codex-memory`,
            recordCalls,
            tempBasePath
        });
    } finally {
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
        await fs.rm(tempBasePath, { recursive: true, force: true });
    }
}

test('codex-memory MCP should require bearer auth and initialize a session', async () => {
    await withServer(async ({ baseUrl }) => {
        const unauthorized = await fetch(baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
        });
        assert.equal(unauthorized.status, 401);

        const response = await fetch(baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer test-key'
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
        });

        assert.equal(response.status, 200);
        assert.ok(response.headers.get('mcp-session-id'));

        const payload = await response.json();
        assert.equal(payload.result.protocolVersion, '2025-06-18');
        assert.equal(payload.result.serverInfo.name, 'vcp_codex_memory');
        assert.match(payload.result.instructions, /record_memory/);
        assert.match(payload.result.instructions, /write-capable/);
        assert.match(payload.result.instructions, /Do not use record_memory/);
    });
});

test('codex-memory MCP should negotiate protocol version and expose empty resource templates', async () => {
    await withServer(async ({ baseUrl }) => {
        const headers = {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-key'
        };

        const initResponse = await fetch(baseUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 10,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: {},
                    clientInfo: { name: 'test-client', version: '1.0.0' }
                }
            })
        });
        const initPayload = await initResponse.json();
        assert.equal(initPayload.result.protocolVersion, '2025-06-18');

        const templateResponse = await fetch(baseUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 11,
                method: 'resources/templates/list',
                params: {}
            })
        });
        const templatePayload = await templateResponse.json();
        assert.deepEqual(templatePayload.result.resourceTemplates, []);
    });
});

test('codex-memory MCP should expose tools and execute record/search/overview', async () => {
    await withServer(async ({ baseUrl, recordCalls, tempBasePath }) => {
        const headers = {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-key'
        };

        const listResponse = await fetch(baseUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        });
        const listPayload = await listResponse.json();
        assert.equal(listPayload.result.tools.length, 3);
        const recordTool = listPayload.result.tools.find(tool => tool.name === 'record_memory');
        const searchTool = listPayload.result.tools.find(tool => tool.name === 'search_memory');
        const overviewTool = listPayload.result.tools.find(tool => tool.name === 'memory_overview');
        assert.equal(recordTool.annotations.readOnlyHint, false);
        assert.equal(recordTool.annotations.openWorldHint, false);
        assert.match(recordTool.description, /Write-capable/);
        assert.match(recordTool.inputSchema.properties.sensitivity.description, /secret/);
        assert.equal(searchTool.annotations.readOnlyHint, true);
        assert.equal(overviewTool.annotations.readOnlyHint, true);

        const recordResponse = await fetch(baseUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: {
                    name: 'record_memory',
                    arguments: {
                        target: 'process',
                        title: 'Checkpoint',
                        content: 'Type: checkpoint\nbody',
                        evidence: 'evidence',
                        validated: true,
                        reusable: false,
                        tags: ['checkpoint'],
                        sensitivity: 'none'
                    }
                }
            })
        });
        const recordPayload = await recordResponse.json();
        assert.equal(recordPayload.result.structuredContent.decision, 'accepted');
        assert.equal(recordCalls.length, 1);
        assert.equal(recordCalls[0].toolName, 'CodexMemoryBridge');
        assert.equal(recordCalls[0].executionContext.agentAlias, 'Codex');
        assert.equal(recordCalls[0].executionContext.agentId, 'codex-desktop');

        const searchResponse = await fetch(baseUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 4,
                method: 'tools/call',
                params: {
                    name: 'search_memory',
                    arguments: {
                        query: 'find checkpoint',
                        target: 'both',
                        limit: 5,
                        include_content: true
                    }
                }
            })
        });
        const searchPayload = await searchResponse.json();
        assert.equal(searchPayload.result.structuredContent.results.length, 2);
        assert.equal(searchPayload.result.structuredContent.results[0].target, 'process');

        const recallLog = await fs.readFile(path.join(tempBasePath, 'logs', 'codex-memory-recall.jsonl'), 'utf8');
        assert.match(recallLog, /"source":"mcp"/);

        const overviewResponse = await fetch(baseUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 5,
                method: 'tools/call',
                params: {
                    name: 'memory_overview',
                    arguments: {
                        auditWindow: 200,
                        limit: 10
                    }
                }
            })
        });
        const overviewPayload = await overviewResponse.json();
        assert.ok(overviewPayload.result.structuredContent.paths.auditLogPath.endsWith('codex-memory-bridge.jsonl'));
        assert.equal(overviewPayload.result.isError, false);
    });
});
