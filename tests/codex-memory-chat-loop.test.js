const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.join(__dirname, '..');
const BRIDGE_PLUGIN_DIR = path.join(ROOT_DIR, 'Plugin', 'CodexMemoryBridge');
const BRIDGE_PLUGIN_ENTRY = path.join(BRIDGE_PLUGIN_DIR, 'codex-memory-bridge.js');
const LOCAL_NO_PROXY = '127.0.0.1,localhost';
const EMBEDDING_DIMENSION = 3072;

function createTempWorkspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-memory-e2e-'));
}

function removeDirectory(targetPath) {
    fs.rmSync(targetPath, { recursive: true, force: true });
}

function createEmbeddingVector(text, dimension = EMBEDDING_DIMENSION) {
    const vector = new Array(dimension).fill(0);
    const normalized = String(text || '').toLowerCase();

    for (const token of normalized.split(/[^a-z0-9\u4e00-\u9fff_-]+/).filter(Boolean)) {
        let hash = 0;
        for (let i = 0; i < token.length; i++) {
            hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
        }
        vector[hash % dimension] += 1;
    }

    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map(value => value / norm);
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
            body += chunk;
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

async function startFakeUpstream() {
    const chatRequests = [];
    const embeddingRequests = [];

    const server = http.createServer(async (req, res) => {
        try {
            if (req.method !== 'POST') {
                res.writeHead(405).end();
                return;
            }

            const body = await readJsonBody(req);

            if (req.url === '/v1/embeddings') {
                embeddingRequests.push(body);
                const inputs = Array.isArray(body.input) ? body.input : [body.input];
                const response = {
                    object: 'list',
                    data: inputs.map((text, index) => ({
                        object: 'embedding',
                        index,
                        embedding: createEmbeddingVector(text)
                    }))
                };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
                return;
            }

            if (req.url === '/v1/chat/completions') {
                chatRequests.push(body);
                const messages = Array.isArray(body.messages) ? body.messages : [];
                const lastUserMessage = [...messages].reverse().find(message => message.role === 'user');
                const lastUserText = typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';
                const systemText = messages
                    .filter(message => message.role === 'system')
                    .map(message => typeof message.content === 'string' ? message.content : '')
                    .join('\n');

                let content;
                if (lastUserText.includes('WRITE_PROCESS_E2E')) {
                    content = [
                        '<<<[TOOL_REQUEST]>>>',
                        'tool_name:「始」CodexMemoryBridge「末」,',
                        'command:「始」record「末」,',
                        'target:「始」process「末」,',
                        'title:「始」E2E process anchor memory「末」,',
                        'content:「始」Type: checkpoint',
                        'Anchor: e2e-process-anchor-token',
                        'Tool loop write completed.「末」,',
                        'evidence:「始」chatCompletionHandler e2e regression test evidence.「末」,',
                        'validated:「始」true「末」,',
                        'reusable:「始」false「末」,',
                        'sensitivity:「始」none「末」,',
                        'tags:「始」e2e, checkpoint, anchor「末」',
                        '<<<[END_TOOL_REQUEST]>>>'
                    ].join('\n');
                } else if (lastUserText.startsWith('<!-- VCP_TOOL_PAYLOAD -->')) {
                    content = /accepted|已写入 Codex/.test(lastUserText)
                        ? 'WRITE_COMPLETE'
                        : 'WRITE_FAILED';
                } else if (lastUserText.includes('e2e-process-anchor-token')) {
                    content = systemText.includes('e2e-process-anchor-token') && systemText.includes('E2E process anchor memory')
                        ? 'RECALL_OK'
                        : 'RECALL_MISS';
                } else {
                    content = 'UNHANDLED';
                }

                const response = {
                    id: 'fake-chatcmpl',
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model || 'fake-model',
                    choices: [
                        {
                            index: 0,
                            message: {
                                role: 'assistant',
                                content
                            },
                            finish_reason: 'stop'
                        }
                    ]
                };

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
                return;
            }

            res.writeHead(404).end();
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();

    return {
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        chatRequests,
        embeddingRequests,
        close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    };
}

function createMockResponse() {
    return {
        statusCode: 200,
        headers: new Map(),
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        body: '',
        status(code) {
            this.statusCode = code;
            return this;
        },
        setHeader(name, value) {
            this.headers.set(String(name).toLowerCase(), value);
        },
        getHeader(name) {
            return this.headers.get(String(name).toLowerCase());
        },
        send(payload) {
            this.headersSent = true;
            this.writableEnded = true;
            this.body = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
            return this;
        },
        json(payload) {
            return this.send(Buffer.from(JSON.stringify(payload)));
        },
        write(payload) {
            this.headersSent = true;
            this.body += Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
            return true;
        },
        end(payload = '') {
            if (payload) {
                this.body += Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
            }
            this.headersSent = true;
            this.writableEnded = true;
        }
    };
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientSqliteReadError(error) {
    return error?.code === 'SQLITE_IOERR_SHORT_READ' ||
        error?.code === 'SQLITE_BUSY' ||
        error?.code === 'SQLITE_LOCKED' ||
        /disk I\/O error/i.test(error?.message || '');
}

async function waitUntilIndexed(vectorDBManager, pattern, timeoutMs = 8000) {
    const startedAt = Date.now();
    let lastTransientError = null;

    while (Date.now() - startedAt < timeoutMs) {
        const db = vectorDBManager?.db;
        if (db && db.open !== false) {
            try {
                const row = db.prepare('SELECT path FROM files WHERE path LIKE ? LIMIT 1').get(pattern);
                if (row?.path) {
                    return row.path;
                }
            } catch (error) {
                if (!isTransientSqliteReadError(error)) {
                    throw error;
                }
                lastTransientError = error;
            }
        }
        await wait(100);
    }

    const transientDetail = lastTransientError
        ? ` Last SQLite read error: ${lastTransientError.code || 'unknown'} ${lastTransientError.message}`
        : '';
    throw new Error(`Timed out waiting for indexed file: ${pattern}.${transientDetail}`);
}

function loadFreshModule(modulePath) {
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
}

class MinimalPluginManager {
    constructor(options) {
        this.projectBasePath = options.projectBasePath;
        this.messagePreprocessors = new Map([
            ['RAGDiaryPlugin', options.ragPlugin]
        ]);
        this.plugins = new Map([
            ['CodexMemoryBridge', { name: 'CodexMemoryBridge' }]
        ]);
    }

    getPlaceholderValue(placeholder) {
        return `[Placeholder ${placeholder} not found]`;
    }

    getAllPlaceholderValues() {
        return new Map();
    }

    getIndividualPluginDescriptions() {
        return new Map();
    }

    getResolvedPluginConfigValue() {
        return undefined;
    }

    async executeMessagePreprocessor(name, messages) {
        const preprocessor = this.messagePreprocessors.get(name);
        if (!preprocessor) return messages;
        return preprocessor.processMessages(messages, {});
    }

    getPlugin(name) {
        return this.plugins.get(name) || null;
    }

    async processToolCall(toolName, toolArgs, requestIp = null, executionContext = null) {
        if (toolName !== 'CodexMemoryBridge') {
            throw new Error(`Unsupported plugin in e2e test: ${toolName}`);
        }

        const result = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [BRIDGE_PLUGIN_ENTRY], {
                cwd: BRIDGE_PLUGIN_DIR,
                windowsHide: true,
                env: {
                    ...process.env,
                    PROJECT_BASE_PATH: this.projectBasePath,
                    KNOWLEDGEBASE_ROOT_PATH: path.join(this.projectBasePath, 'dailynote'),
                    DAILY_NOTE_EXTENSION: 'txt',
                    DebugMode: 'false',
                    VCP_REQUEST_IP: requestIp || '',
                    VCP_EXECUTION_CONTEXT: JSON.stringify({
                        agentAlias: executionContext?.agentAlias || null,
                        agentId: executionContext?.agentId || null,
                        requestSource: executionContext?.requestSource || 'unknown'
                    })
                },
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';
            child.stdout.on('data', chunk => {
                stdout += chunk.toString();
            });
            child.stderr.on('data', chunk => {
                stderr += chunk.toString();
            });
            child.on('error', reject);
            child.on('close', code => {
                if (code !== 0) {
                    reject(new Error(`CodexMemoryBridge exited with ${code}: ${stderr}`));
                    return;
                }
                try {
                    resolve(JSON.parse(stdout));
                } catch (error) {
                    reject(new Error(`Failed to parse bridge output: ${error.message}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`));
                }
            });
            child.stdin.write(JSON.stringify(toolArgs));
            child.stdin.end();
        });

        if (result.status !== 'success') {
            throw new Error(result.error || 'CodexMemoryBridge returned non-success status');
        }

        return {
            ...result.result,
            timestamp: new Date().toISOString()
        };
    }
}

test('chatCompletionHandler completes tool loop write and subsequent RAG recall', { timeout: 30000 }, async () => {
    const tempRoot = createTempWorkspace();
    const dailynoteRoot = path.join(tempRoot, 'dailynote');
    const storeRoot = path.join(tempRoot, 'VectorStore');
    const tvsRoot = path.join(tempRoot, 'TVStxt');
    const fakeUpstream = await startFakeUpstream();

    const originalEnv = {
        API_URL: process.env.API_URL,
        API_Key: process.env.API_Key,
        EMBEDDING_API_URL: process.env.EMBEDDING_API_URL,
        EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY,
        PROJECT_BASE_PATH: process.env.PROJECT_BASE_PATH,
        KNOWLEDGEBASE_ROOT_PATH: process.env.KNOWLEDGEBASE_ROOT_PATH,
        KNOWLEDGEBASE_STORE_PATH: process.env.KNOWLEDGEBASE_STORE_PATH,
        AGENT_DIR_PATH: process.env.AGENT_DIR_PATH,
        TVSTXT_DIR_PATH: process.env.TVSTXT_DIR_PATH,
        VECTORDB_DIMENSION: process.env.VECTORDB_DIMENSION,
        WhitelistEmbeddingModel: process.env.WhitelistEmbeddingModel,
        KNOWLEDGEBASE_BATCH_WINDOW_MS: process.env.KNOWLEDGEBASE_BATCH_WINDOW_MS,
        KNOWLEDGEBASE_INDEX_SAVE_DELAY: process.env.KNOWLEDGEBASE_INDEX_SAVE_DELAY,
        KNOWLEDGEBASE_TAG_INDEX_SAVE_DELAY: process.env.KNOWLEDGEBASE_TAG_INDEX_SAVE_DELAY,
        KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP: process.env.KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP,
        IGNORE_FOLDERS: process.env.IGNORE_FOLDERS,
        IGNORE_PREFIXES: process.env.IGNORE_PREFIXES,
        IGNORE_SUFFIXES: process.env.IGNORE_SUFFIXES,
        DEFAULT_TIMEZONE: process.env.DEFAULT_TIMEZONE,
        DAILY_NOTE_EXTENSION: process.env.DAILY_NOTE_EXTENSION,
        HTTP_PROXY: process.env.HTTP_PROXY,
        HTTPS_PROXY: process.env.HTTPS_PROXY,
        ALL_PROXY: process.env.ALL_PROXY,
        NO_PROXY: process.env.NO_PROXY,
        http_proxy: process.env.http_proxy,
        https_proxy: process.env.https_proxy,
        all_proxy: process.env.all_proxy,
        no_proxy: process.env.no_proxy
    };

    let knowledgeBaseManager = null;
    let ragPlugin = null;

    try {
        fs.mkdirSync(dailynoteRoot, { recursive: true });
        fs.mkdirSync(storeRoot, { recursive: true });
        fs.mkdirSync(tvsRoot, { recursive: true });
        fs.writeFileSync(path.join(tempRoot, 'rag_params.json'), JSON.stringify({}, null, 2));

        process.env.API_URL = fakeUpstream.baseUrl;
        process.env.API_Key = 'test-key';
        process.env.EMBEDDING_API_URL = fakeUpstream.baseUrl;
        process.env.EMBEDDING_API_KEY = 'test-key';
        process.env.PROJECT_BASE_PATH = tempRoot;
        process.env.KNOWLEDGEBASE_ROOT_PATH = dailynoteRoot;
        process.env.KNOWLEDGEBASE_STORE_PATH = storeRoot;
        process.env.AGENT_DIR_PATH = path.join(tempRoot, 'Agent');
        process.env.TVSTXT_DIR_PATH = tvsRoot;
        process.env.VECTORDB_DIMENSION = String(EMBEDDING_DIMENSION);
        process.env.WhitelistEmbeddingModel = 'test-embedding';
        process.env.KNOWLEDGEBASE_BATCH_WINDOW_MS = '50';
        process.env.KNOWLEDGEBASE_INDEX_SAVE_DELAY = '50';
        process.env.KNOWLEDGEBASE_TAG_INDEX_SAVE_DELAY = '50';
        process.env.KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP = 'false';
        process.env.IGNORE_FOLDERS = '';
        process.env.IGNORE_PREFIXES = '';
        process.env.IGNORE_SUFFIXES = '';
        process.env.DEFAULT_TIMEZONE = 'Asia/Shanghai';
        process.env.DAILY_NOTE_EXTENSION = 'txt';
        delete process.env.HTTP_PROXY;
        delete process.env.HTTPS_PROXY;
        delete process.env.ALL_PROXY;
        delete process.env.http_proxy;
        delete process.env.https_proxy;
        delete process.env.all_proxy;
        process.env.NO_PROXY = LOCAL_NO_PROXY;
        process.env.no_proxy = LOCAL_NO_PROXY;

        const ChatCompletionHandler = loadFreshModule('../modules/chatCompletionHandler.js');
        knowledgeBaseManager = loadFreshModule('../KnowledgeBaseManager.js');
        ragPlugin = loadFreshModule('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js');

        Object.assign(knowledgeBaseManager.config, {
            rootPath: dailynoteRoot,
            storePath: storeRoot,
            apiKey: 'test-key',
            apiUrl: fakeUpstream.baseUrl,
            model: 'test-embedding',
            dimension: EMBEDDING_DIMENSION,
            batchWindow: 50,
            maxBatchSize: 20,
            indexSaveDelay: 50,
            tagIndexSaveDelay: 50,
            fullScanOnStartup: false,
            ignoreFolders: [],
            ignorePrefixes: [],
            ignoreSuffixes: []
        });

        await knowledgeBaseManager.initialize();
        await ragPlugin.initialize({}, {
            vectorDBManager: knowledgeBaseManager,
            vcpLogFunctions: {
                pushVcpInfo() {}
            }
        });

        const pluginManager = new MinimalPluginManager({
            projectBasePath: tempRoot,
            ragPlugin
        });

        const chatHandler = new ChatCompletionHandler({
            apiUrl: fakeUpstream.baseUrl,
            apiKey: 'test-key',
            modelRedirectHandler: {
                redirectModelForBackend(modelName) {
                    return modelName;
                }
            },
            pluginManager,
            activeRequests: new Map(),
            writeDebugLog: async () => {},
            writeChatLog: undefined,
            handleDiaryFromAIResponse: async () => {},
            webSocketServer: {
                broadcast() {}
            },
            DEBUG_MODE: false,
            // Trusted process-owned context; request body fields must not grant Codex writes.
            executionContext: {
                agentAlias: 'Codex',
                agentId: null,
                requestSource: 'codex-memory-chat-loop-test'
            },
            SHOW_VCP_OUTPUT: false,
            VCPToolCode: false,
            maxVCPLoopStream: 2,
            maxVCPLoopNonStream: 2,
            apiRetries: 1,
            apiRetryDelay: 10,
            RAGMemoRefresh: false,
            enableRoleDivider: false,
            enableRoleDividerInLoop: false,
            roleDividerIgnoreList: [],
            roleDividerSwitches: {},
            roleDividerScanSwitches: {},
            roleDividerRemoveDisabledTags: true,
            chinaModel1: [],
            chinaModel1Cot: false,
            cachedEmojiLists: [],
            detectors: [],
            superDetectors: []
        });

        const writeReq = {
            ip: '127.0.0.1',
            headers: {},
            body: {
                model: 'fake-model',
                stream: false,
                messages: [
                    {
                        role: 'system',
                        content: 'You are the Codex e2e test agent.\n[[Codex日记本]]'
                    },
                    {
                        role: 'user',
                        content: 'WRITE_PROCESS_E2E'
                    }
                ]
            }
        };
        const writeRes = createMockResponse();

        await chatHandler.handle(writeReq, writeRes, false);
        const writeJson = JSON.parse(writeRes.body);
        const writeContent = writeJson.choices[0].message.content;
        assert.match(writeContent, /WRITE_COMPLETE/);

        const indexedPath = await waitUntilIndexed(knowledgeBaseManager, '%E2E process anchor memory%');
        assert.match(indexedPath, /E2E process anchor memory/);

        const recallReq = {
            ip: '127.0.0.1',
            headers: {},
            body: {
                model: 'fake-model',
                stream: false,
                messages: [
                    {
                        role: 'system',
                        content: 'You are the Codex e2e test agent.\n[[Codex日记本]]'
                    },
                    {
                        role: 'user',
                        content: 'What note mentions e2e-process-anchor-token?'
                    }
                ]
            }
        };
        const recallRes = createMockResponse();

        await chatHandler.handle(recallReq, recallRes, false);
        const recallJson = JSON.parse(recallRes.body);
        const recallContent = recallJson.choices[0].message.content;
        assert.match(recallContent, /RECALL_OK/);

        assert.ok(fakeUpstream.chatRequests.length >= 3, `expected at least 3 chat requests, got ${fakeUpstream.chatRequests.length}`);
        const toolLoopRequest = fakeUpstream.chatRequests.find(request =>
            JSON.stringify(request.messages).includes('VCP_TOOL_PAYLOAD')
        );
        assert.ok(toolLoopRequest, 'expected tool loop follow-up request');
        const toolPayloadMessage = toolLoopRequest.messages.find(message =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.startsWith('<!-- VCP_TOOL_PAYLOAD -->')
        );
        assert.ok(toolPayloadMessage, 'expected tool loop payload message');
        const toolPayloadParts = JSON.parse(toolPayloadMessage.content.replace(/^<!-- VCP_TOOL_PAYLOAD -->\s*/, ''));
        const toolPayloadText = toolPayloadParts
            .filter(part => part && typeof part.text === 'string')
            .map(part => part.text)
            .join('\n');
        const toolPayloadResult = JSON.parse(toolPayloadText);
        assert.equal(toolPayloadResult.decision, 'accepted');
        assert.equal(toolPayloadResult.targetDiary, 'Codex');

        const recallUpstreamRequest = fakeUpstream.chatRequests[fakeUpstream.chatRequests.length - 1];
        const recallSystemText = recallUpstreamRequest.messages
            .filter(message => message.role === 'system')
            .map(message => message.content)
            .join('\n');
        assert.ok(fakeUpstream.embeddingRequests.length >= 2, `expected at least 2 embedding requests, got ${fakeUpstream.embeddingRequests.length}`);
        assert.match(JSON.stringify(fakeUpstream.embeddingRequests), /e2e-process-anchor-token|WRITE_PROCESS_E2E/);
        assert.match(recallSystemText, /e2e-process-anchor-token/);
        assert.match(recallSystemText, /E2E process anchor memory/);
    } finally {
        try {
            if (ragPlugin && typeof ragPlugin.shutdown === 'function') {
                await ragPlugin.shutdown();
            }
        } catch (error) {
            // ignore cleanup errors in test teardown
        }

        try {
            if (knowledgeBaseManager && typeof knowledgeBaseManager.shutdown === 'function') {
                await knowledgeBaseManager.shutdown();
            }
        } catch (error) {
            // ignore cleanup errors in test teardown
        }

        await fakeUpstream.close();
        removeDirectory(tempRoot);

        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
});
