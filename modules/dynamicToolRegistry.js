// modules/dynamicToolRegistry.js
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

const PRIVATE_CONFIG_RELATIVE_PATH = path.join('Plugin', 'DynamicToolBridge', 'config.env');
const LIGHT_LIST_TOKEN_BUDGET = 15;
const DEFAULT_BRIEF_TOKEN_BUDGET = 6;
const MIN_BRIEF_TOKEN_BUDGET = 3;

const DEFAULT_CONFIG = Object.freeze({
    version: 1,
    enabled: true,
    placeholder: '{{VCPDynamicTools}}',
    maxBriefListItems: 120,
    maxExpandedPlugins: 4,
    maxForcedCategoryPlugins: 12,
    maxInjectionChars: 16000,
    classificationDebounceMs: 1000,
    classifierTimeoutMs: 30000,
    useRagEmbeddings: true,
    manualOverrides: {
        excludedOriginKeys: [],
        pinnedOriginKeys: [],
        categoryAliases: {}
    },
    smallModel: {
        enabled: false,
        useMainConfig: true,
        endpoint: '',
        model: ''
    }
});

const CATEGORY_RULES = [
    {
        category: 'search',
        keywords: ['search', 'web', 'lookup', 'query', 'retrieval', 'google', 'tavily', 'serp', 'url', 'paper', 'citation', '搜索', '检索', '网页', '查询', '论文', '资料']
    },
    {
        category: 'file_code',
        keywords: ['file', 'code', 'read', 'write', 'edit', 'patch', 'repo', 'git', 'directory', '文件', '代码', '仓库', '读取', '写入', '编辑']
    },
    {
        category: 'image_media',
        keywords: ['image', 'photo', 'picture', 'media', 'video', 'audio', 'ocr', 'screenshot', '图片', '图像', '视频', '音频', '截图']
    },
    {
        category: 'memory_knowledge',
        keywords: ['memory', 'knowledge', 'rag', 'diary', 'note', 'vector', 'context', '知识', '记忆', '日记', '笔记', '向量']
    },
    {
        category: 'agent_task',
        keywords: ['agent', 'task', 'schedule', 'plan', 'workflow', 'assistant', '任务', '计划', '调度', '代理']
    },
    {
        category: 'communication',
        keywords: ['mail', 'email', 'message', 'notification', 'push', 'forum', 'wechat', 'telegram', '邮件', '消息', '通知', '推送']
    },
    {
        category: 'data',
        keywords: ['json', 'csv', 'excel', 'sql', 'database', 'table', 'parse', '数据', '表格', '数据库', '解析']
    }
];

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function cleanText(value, maxLength = 240) {
    const text = String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function tokenPieces(value) {
    return String(value || '').match(/[A-Za-z0-9_.-]+|[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) || [];
}

function estimateTokenCount(value) {
    return tokenPieces(value).length;
}

function truncateToTokenBudget(value, maxTokens) {
    const text = cleanText(value, 500);
    const budget = Math.max(1, Math.trunc(Number(maxTokens) || 1));
    const pieces = tokenPieces(text);
    if (pieces.length <= budget) return text;
    if (pieces.length === 0) return cleanText(text, Math.max(12, budget * 8));
    return cleanText(`${pieces.slice(0, budget).join(' ')}...`, Math.max(24, budget * 14));
}

function parseEnvBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    return String(value).trim().toLowerCase() === 'true';
}

function normalizeOpenAIChatEndpoint(value) {
    const endpoint = String(value || '').trim().replace(/\/+$/, '');
    if (!endpoint) return '';
    if (/\/v1\/chat\/completions$/i.test(endpoint)) return endpoint;
    if (/\/chat\/completions$/i.test(endpoint)) return endpoint;
    if (/\/v1$/i.test(endpoint)) return `${endpoint}/chat/completions`;
    return `${endpoint}/v1/chat/completions`;
}

function normalizeName(value) {
    return String(value || '').trim().toLowerCase();
}

function mergeConfig(base, fileConfig, overrideConfig) {
    const merged = {
        ...cloneJson(base),
        ...(fileConfig && typeof fileConfig === 'object' ? fileConfig : {}),
        ...(overrideConfig && typeof overrideConfig === 'object' ? overrideConfig : {})
    };

    merged.manualOverrides = {
        ...cloneJson(base.manualOverrides),
        ...(fileConfig && fileConfig.manualOverrides ? fileConfig.manualOverrides : {}),
        ...(overrideConfig && overrideConfig.manualOverrides ? overrideConfig.manualOverrides : {})
    };
    merged.smallModel = {
        ...cloneJson(base.smallModel),
        ...(fileConfig && fileConfig.smallModel ? fileConfig.smallModel : {}),
        ...(overrideConfig && overrideConfig.smallModel ? overrideConfig.smallModel : {})
    };
    delete merged.smallModel.apiKey;
    delete merged.smallModel.apiKeyEnv;

    merged.maxBriefListItems = clampInteger(merged.maxBriefListItems, 1, 500, DEFAULT_CONFIG.maxBriefListItems);
    merged.maxExpandedPlugins = clampInteger(merged.maxExpandedPlugins, 0, 50, DEFAULT_CONFIG.maxExpandedPlugins);
    merged.maxForcedCategoryPlugins = clampInteger(merged.maxForcedCategoryPlugins, 1, 100, DEFAULT_CONFIG.maxForcedCategoryPlugins);
    merged.maxInjectionChars = clampInteger(merged.maxInjectionChars, 1000, 120000, DEFAULT_CONFIG.maxInjectionChars);
    merged.classificationDebounceMs = clampInteger(merged.classificationDebounceMs, 0, 60000, DEFAULT_CONFIG.classificationDebounceMs);
    merged.classifierTimeoutMs = clampInteger(merged.classifierTimeoutMs, 100, 120000, DEFAULT_CONFIG.classifierTimeoutMs);
    merged.enabled = merged.enabled !== false;
    return merged;
}

function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(number)));
}

function extractMessageText(messages) {
    if (!Array.isArray(messages)) return '';
    const chunks = [];
    for (const message of messages.slice(-12)) {
        if (!message) continue;
        const content = message.content;
        if (typeof content === 'string') {
            chunks.push(content);
        } else if (Array.isArray(content)) {
            for (const part of content) {
                if (!part) continue;
                if (typeof part === 'string') chunks.push(part);
                else if (typeof part.text === 'string') chunks.push(part.text);
                else if (typeof part.content === 'string') chunks.push(part.content);
            }
        } else if (content && typeof content === 'object') {
            try {
                chunks.push(JSON.stringify(content));
            } catch {
                // Ignore non-serializable message fragments.
            }
        }
    }
    return chunks.join('\n');
}

function tokenSet(text) {
    const lower = String(text || '').toLowerCase();
    const tokens = new Set();
    const latinMatches = lower.match(/[a-z0-9_.-]{2,}/g) || [];
    for (const token of latinMatches) tokens.add(token);
    for (const rule of CATEGORY_RULES) {
        for (const keyword of rule.keywords) {
            if (lower.includes(keyword.toLowerCase())) tokens.add(keyword.toLowerCase());
        }
    }
    return tokens;
}

function withTimeout(promise, timeoutMs, label) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

class DynamicToolRegistry {
    constructor() {
        this.initialized = false;
        this.debugMode = false;
        this.projectBasePath = path.join(__dirname, '..');
        this.toolConfigsDir = path.join(this.projectBasePath, 'ToolConfigs');
        this.catalogPath = path.join(this.toolConfigsDir, 'dynamic_tool_catalog.json');
        this.categoriesPath = path.join(this.toolConfigsDir, 'dynamic_tool_categories.json');
        this.configPath = path.join(this.toolConfigsDir, 'dynamic_tool_bridge.config.json');
        this.privateConfigPath = path.join(this.projectBasePath, PRIVATE_CONFIG_RELATIVE_PATH);
        this.privateConfig = {};
        this.persistedConfig = cloneJson(DEFAULT_CONFIG);
        this.config = cloneJson(DEFAULT_CONFIG);
        this.catalog = new Map();
        this.categories = new Map();
        this.classificationQueue = new Map();
        this.snapshotId = 0;
        this.pluginManager = null;
        this.classifier = null;
        this.writePromise = Promise.resolve();
        this.syncPromise = Promise.resolve();
        this.classificationPromise = null;
        this.classificationTimer = null;
        this.lastError = null;
        this.categoryEmbeddingCache = new Map();
        this._boundPluginManager = null;
        this._toolsChangedHandler = null;
        this._distributedOfflineHandler = null;
    }

    async initialize(options = {}) {
        const {
            pluginManager,
            projectBasePath = path.join(__dirname, '..'),
            debugMode = false,
            config = {},
            classifier = null
        } = options;

        this.debugMode = Boolean(debugMode);
        this.projectBasePath = projectBasePath;
        this.toolConfigsDir = path.join(this.projectBasePath, 'ToolConfigs');
        this.catalogPath = path.join(this.toolConfigsDir, 'dynamic_tool_catalog.json');
        this.categoriesPath = path.join(this.toolConfigsDir, 'dynamic_tool_categories.json');
        this.configPath = path.join(this.toolConfigsDir, 'dynamic_tool_bridge.config.json');
        this.privateConfigPath = path.join(this.projectBasePath, PRIVATE_CONFIG_RELATIVE_PATH);
        this.pluginManager = pluginManager || this.pluginManager;
        this.classifier = classifier || null;

        await fs.mkdir(this.toolConfigsDir, { recursive: true });
        const fileConfig = await this._readJson(this.configPath, null);
        this.persistedConfig = mergeConfig(DEFAULT_CONFIG, fileConfig, config);
        this.config = cloneJson(this.persistedConfig);
        this.privateConfig = await this._readPrivatePluginConfig();
        this._applyPrivateConfig();
        await this._writeConfigIfMissingOrSanitized(fileConfig, this.persistedConfig);

        await this._loadCatalog();
        await this._loadCategories();
        this._bindPluginManagerEvents(this.pluginManager);
        this.initialized = true;
        return this;
    }

    getRecord(originKey) {
        return this.catalog.get(originKey);
    }

    async syncFromPluginManager(reason = 'manual') {
        this.syncPromise = this.syncPromise
            .catch((error) => {
                this.lastError = error.message;
            })
            .then(() => this._syncFromPluginManager(reason));
        return this.syncPromise;
    }

    async _syncFromPluginManager(reason) {
        if (!this.pluginManager || !this.pluginManager.plugins) return;
        const now = new Date().toISOString();
        const currentRecords = this._extractRecords(this.pluginManager, now);
        const seen = new Set(currentRecords.map((record) => record.originKey));

        for (const record of currentRecords) {
            const previous = this.catalog.get(record.originKey);
            const merged = {
                ...(previous || {}),
                ...record,
                firstSeenAt: previous?.firstSeenAt || now,
                lastSeenAt: now
            };

            merged.available = this._isAvailable(merged);
            const previousStatus = previous ? `${previous.enabled}:${previous.online}:${previous.available}` : null;
            const nextStatus = `${merged.enabled}:${merged.online}:${merged.available}`;
            merged.lastStatusChangeAt = previousStatus !== nextStatus ? now : (previous?.lastStatusChangeAt || now);
            this.catalog.set(record.originKey, merged);

            const classification = this.categories.get(record.originKey);
            if (!classification || classification.sourceHash !== merged.sourceHash) {
                this.enqueueClassification(merged, reason || 'source_changed');
            }
        }

        for (const [originKey, previous] of this.catalog.entries()) {
            if (seen.has(originKey)) continue;
            const next = { ...previous };
            if (next.originKind === 'distributed') {
                next.online = false;
            } else {
                next.enabled = false;
                next.online = true;
            }
            next.available = false;
            if (previous.available !== next.available || previous.online !== next.online || previous.enabled !== next.enabled) {
                next.lastStatusChangeAt = now;
            }
            this.catalog.set(originKey, next);
        }

        this.snapshotId += 1;
        await this._writeCatalog();
        this._scheduleClassificationFlush();
    }

    async markDistributedOffline(serverId, manifests = []) {
        if (!serverId) return;
        const now = new Date().toISOString();
        let changed = false;
        const manifestRecords = this._extractRecords({
            plugins: new Map(asArray(manifests).filter((manifest) => manifest && manifest.name).map((manifest) => [manifest.name, {
                ...manifest,
                isDistributed: true,
                serverId
            }])),
            getIndividualPluginDescriptions: () => new Map()
        }, now);

        for (const record of manifestRecords) {
            const previous = this.catalog.get(record.originKey);
            const next = {
                ...(previous || {}),
                ...record,
                enabled: previous?.enabled !== false,
                online: false,
                available: false,
                firstSeenAt: previous?.firstSeenAt || now,
                lastSeenAt: now,
                lastStatusChangeAt: now
            };
            this.catalog.set(record.originKey, next);
            const classification = this.categories.get(record.originKey);
            if (!classification || classification.sourceHash !== next.sourceHash) {
                this.enqueueClassification(next, 'distributed_offline_snapshot');
            }
            changed = true;
        }

        for (const [originKey, record] of this.catalog.entries()) {
            if (record.originKind === 'distributed' && record.originId === serverId) {
                const next = {
                    ...record,
                    online: false,
                    available: false,
                    lastStatusChangeAt: now
                };
                this.catalog.set(originKey, next);
                changed = true;
            }
        }
        if (changed) {
            this.snapshotId += 1;
            await this._writeCatalog();
            this._scheduleClassificationFlush();
        }
    }

    enqueueClassification(record, reason = 'source_changed') {
        if (!record || !record.originKey || !record.sourceHash) return;
        const queueKey = `${record.originKey}:${record.sourceHash}`;
        this.classificationQueue.set(queueKey, {
            record: { ...record },
            reason,
            queuedAt: new Date().toISOString()
        });
    }

    async flushClassificationQueue() {
        if (this.classificationTimer) {
            clearTimeout(this.classificationTimer);
            this.classificationTimer = null;
        }
        if (this.classificationPromise) return this.classificationPromise;

        this.classificationPromise = (async () => {
            while (this.classificationQueue.size > 0) {
                const items = Array.from(this.classificationQueue.values());
                this.classificationQueue.clear();

                for (const item of items) {
                    const current = this.catalog.get(item.record.originKey);
                    if (!current || current.sourceHash !== item.record.sourceHash) continue;
                    try {
                        const classification = await this._classifyRecord(current, item.reason);
                        this.categories.set(current.originKey, {
                            pluginName: current.pluginName,
                            sourceHash: current.sourceHash,
                            brief: classification.brief || current.brief,
                            categories: asArray(classification.categories).map(String).filter(Boolean),
                            keywords: asArray(classification.keywords).map(String).filter(Boolean),
                            classifiedBy: classification.classifiedBy || 'keyword_fallback',
                            classifiedAt: new Date().toISOString(),
                            confidence: Number.isFinite(Number(classification.confidence)) ? Number(classification.confidence) : 0.5
                        });
                    } catch (error) {
                        this.lastError = error.message;
                        const fallback = this._fallbackClassify(current);
                        this.categories.set(current.originKey, {
                            pluginName: current.pluginName,
                            sourceHash: current.sourceHash,
                            brief: fallback.brief,
                            categories: fallback.categories,
                            keywords: fallback.keywords,
                            classifiedBy: 'keyword_fallback_after_error',
                            classifiedAt: new Date().toISOString(),
                            confidence: fallback.confidence
                        });
                    }
                }
                await this._writeCategories();
            }
        })().finally(() => {
            this.classificationPromise = null;
        });

        return this.classificationPromise;
    }

    async buildInjection(options = {}) {
        if (!this.config.enabled) return '[Dynamic VCP Tools disabled]';
        if (options.pluginManager && options.pluginManager !== this.pluginManager) {
            this.pluginManager = options.pluginManager;
            this._bindPluginManagerEvents(this.pluginManager);
        }
        if (this.catalog.size === 0 && this.pluginManager) {
            await this.syncFromPluginManager('lazy_build_injection');
        }

        const messages = options.messages || [];
        const queryText = extractMessageText(messages);
        const directives = this._parseDirectives(queryText);
        const available = this._getAvailableRecords();
        if (available.length === 0) return 'Dynamic VCP Tools: no currently available tools.';

        const scored = available.map((record) => ({
            record,
            score: this._scoreRecord(record, queryText, directives)
        }));
        scored.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return this._compareRecords(a.record, b.record);
        });

        const expandedKeys = new Set();
        const notices = [];
        for (const toolName of directives.tools) {
            const match = available.find((record) => this._matchesToolName(record, toolName));
            if (match) expandedKeys.add(match.originKey);
        }

        for (const categoryName of directives.categories) {
            const matches = available
                .filter((record) => this._recordCategories(record).some((category) => this._categoryMatches(category, categoryName)))
                .sort((a, b) => this._compareRecords(a, b));
            const allowed = matches.slice(0, this.config.maxForcedCategoryPlugins);
            for (const record of allowed) expandedKeys.add(record.originKey);
            if (matches.length > allowed.length) {
                notices.push(`Category "${categoryName}" has ${matches.length - allowed.length} more tools hidden by maxForcedCategoryPlugins.`);
            }
        }

        for (const item of scored) {
            if (expandedKeys.size >= this.config.maxExpandedPlugins + directives.tools.size + (directives.categories.size * this.config.maxForcedCategoryPlugins)) break;
            if (item.score <= 0) continue;
            if (expandedKeys.has(item.record.originKey)) continue;
            expandedKeys.add(item.record.originKey);
            if (Array.from(expandedKeys).filter((key) => !this._isForcedKey(key, directives, available)).length >= this.config.maxExpandedPlugins) break;
        }

        const lines = [];
        lines.push('Dynamic VCP Tools');
        lines.push('Light list: names and short descriptions are always shown; full usage is expanded only for matched or explicitly requested tools.');
        lines.push('');
        lines.push('Brief tool list:');

        const briefRecords = scored
            .map((item) => item.record)
            .sort((a, b) => this._compareRecordsWithPinned(a, b))
            .slice(0, this.config.maxBriefListItems);
        for (const record of briefRecords) {
            const categories = this._recordCategories(record).join(', ') || 'general';
            const brief = this._briefForLightList(record, categories.split(',').map((item) => item.trim()).filter(Boolean));
            lines.push(`- ${this._formatLightListName(record)} [${categories}]: ${brief}`);
        }
        if (available.length > briefRecords.length) {
            lines.push(`- ... ${available.length - briefRecords.length} more tools hidden by maxBriefListItems.`);
        }

        const expandedRecords = Array.from(expandedKeys)
            .map((originKey) => this.catalog.get(originKey))
            .filter((record) => record && record.available)
            .sort((a, b) => this._compareRecordsWithPinned(a, b));
        if (expandedRecords.length > 0) {
            lines.push('');
            lines.push('Expanded tool usage:');
            for (const record of expandedRecords) {
                lines.push(`--- ${record.displayName || record.pluginName} (${record.pluginName}) ---`);
                lines.push(record.fullDescription || record.description || 'No full description available.');
            }
        }

        if (notices.length > 0) {
            lines.push('');
            lines.push('Expansion notices:');
            for (const notice of notices) lines.push(`- ${notice}`);
        }

        return this._truncateInjection(lines.join('\n'));
    }

    getAdminState() {
        const records = Array.from(this.catalog.values())
            .sort((a, b) => this._compareRecordsWithPinned(a, b))
            .map((record) => {
                const classification = this.categories.get(record.originKey);
                return {
                    originKey: record.originKey,
                    pluginName: record.pluginName,
                    displayName: record.displayName,
                    originKind: record.originKind,
                    originId: record.originId,
                    enabled: record.enabled,
                    online: record.online,
                available: this._isAvailable(record) && record.available !== false,
                    sourceHash: record.sourceHash,
                    categories: classification?.categories || [],
                    keywords: classification?.keywords || [],
                    brief: this._briefForLightList(record, classification?.categories || []),
                    classifiedBy: classification?.classifiedBy || null,
                    classifiedAt: classification?.classifiedAt || null,
                    lastSeenAt: record.lastSeenAt,
                    lastStatusChangeAt: record.lastStatusChangeAt
                };
            });
        return {
            initialized: this.initialized,
            snapshotId: this.snapshotId,
            queueSize: this.classificationQueue.size,
            isClassifying: Boolean(this.classificationPromise || this.classificationTimer || this.classificationQueue.size > 0),
            lastError: this.lastError,
            config: this._redactConfig(this.config),
            records
        };
    }

    async updateConfig(nextConfig = {}) {
        this.persistedConfig = mergeConfig(DEFAULT_CONFIG, this.persistedConfig, nextConfig);
        this.config = cloneJson(this.persistedConfig);
        this._applyPrivateConfig();
        await this._queueWrite(this.configPath, this._redactConfig(this.persistedConfig));
        return this._redactConfig(this.config);
    }

    async forceRebuild(options = {}) {
        const mode = typeof options === 'string' ? options : (options.mode || 'classification');
        const wait = typeof options === 'string' ? true : options.wait !== false;
        if (mode === 'catalog' || mode === 'all') {
            await this.syncFromPluginManager('manual_rebuild');
        }
        if (mode === 'classification' || mode === 'all') {
            for (const record of this.catalog.values()) {
                if (record.enabled || record.online || record.available) {
                    this.enqueueClassification(record, 'manual_rebuild');
                }
            }
        }
        const classificationPromise = this.flushClassificationQueue();
        if (wait) {
            await classificationPromise;
        } else {
            classificationPromise.catch((error) => {
                this.lastError = error.message;
                console.error('[DynamicToolRegistry] manual rebuild classification failed:', error);
            });
        }
        return this.getAdminState();
    }

    _extractRecords(pluginManager, now) {
        const descriptions = typeof pluginManager.getIndividualPluginDescriptions === 'function'
            ? pluginManager.getIndividualPluginDescriptions()
            : new Map();
        const records = [];

        for (const manifest of pluginManager.plugins.values()) {
            if (!manifest || !manifest.name) continue;
            const commands = asArray(manifest.capabilities?.invocationCommands);
            if (commands.length === 0) continue;

            const originKind = manifest.isDistributed ? 'distributed' : 'local';
            const originId = manifest.isDistributed ? (manifest.serverId || 'unknown') : 'local';
            const originKey = originKind === 'distributed'
                ? `distributed:${originId}:${manifest.name}`
                : `local:${manifest.name}`;
            const fullDescription = descriptions.get(`VCP${manifest.name}`) || this._buildFullDescriptionFromManifest(manifest);
            const manifestHash = sha256(stableStringify({
                name: manifest.name,
                displayName: manifest.displayName,
                description: manifest.description,
                pluginType: manifest.pluginType,
                entryPoint: manifest.entryPoint,
                capabilities: manifest.capabilities
            }));
            const descriptionHash = sha256(fullDescription);
            const sourceHash = sha256(`${manifestHash}:${descriptionHash}`);
            const record = {
                originKey,
                pluginName: manifest.name,
                displayName: manifest.displayName || manifest.name,
                description: manifest.description || '',
                pluginType: manifest.pluginType || '',
                originKind,
                originId,
                enabled: true,
                online: true,
                available: true,
                manifestHash,
                descriptionHash,
                sourceHash,
                commandIdentifiers: commands.map((cmd) => cmd.commandIdentifier || cmd.command || manifest.name).filter(Boolean),
                brief: cleanText(manifest.description || commands.map((cmd) => cmd.description).find(Boolean) || ''),
                fullDescription,
                lastSeenAt: now
            };
            record.available = this._isAvailable(record);
            records.push(record);
        }
        return records;
    }

    _buildFullDescriptionFromManifest(manifest) {
        const commands = asArray(manifest.capabilities?.invocationCommands);
        const chunks = [];
        for (const command of commands) {
            const identifier = command.commandIdentifier || command.command || manifest.name;
            chunks.push(`- ${manifest.displayName || manifest.name} (${manifest.name}) - command: ${identifier}`);
            if (command.description) chunks.push(`  ${String(command.description).trim()}`);
            if (command.example) chunks.push(`  Example:\n${String(command.example).trim()}`);
        }
        return chunks.join('\n');
    }

    _isAvailable(record) {
        const excluded = new Set(asArray(this.config.manualOverrides?.excludedOriginKeys));
        return record.enabled !== false && record.online !== false && !excluded.has(record.originKey);
    }

    async _classifyRecord(record, reason) {
        if (this.classifier) {
            const result = await withTimeout(
                Promise.resolve(this.classifier(record, { reason, config: this._redactConfig(this.config) })),
                this.config.classifierTimeoutMs,
                'DynamicToolRegistry classifier'
            );
            return this._normalizeClassification(result, record, 'custom_classifier');
        }

        const smallModelResult = await this._classifyWithSmallModel(record, reason);
        if (smallModelResult) return smallModelResult;
        const embeddingResult = await this._classifyWithEmbeddings(record);
        if (embeddingResult) return embeddingResult;
        return this._fallbackClassify(record);
    }

    async _classifyWithSmallModel(record, reason) {
        const smallModel = this.config.smallModel || {};
        const requestConfig = this._resolveSmallModelRequestConfig(smallModel);
        if (!requestConfig) return null;

        const prompt = [
            'Classify this VCP plugin into concise semantic categories.',
            'Return strict JSON: {"brief": "...", "categories": ["..."], "keywords": ["..."], "confidence": 0.0}.',
            `Keep "brief" extremely compact: target ${DEFAULT_BRIEF_TOKEN_BUDGET} tokens, and keep plugin name + categories + brief within ${LIGHT_LIST_TOKEN_BUDGET} tokens for lightweight tool lists.`,
            `Reason: ${reason}`,
            `Name: ${record.pluginName}`,
            `Display: ${record.displayName}`,
            `Description: ${record.description}`,
            `Usage: ${cleanText(record.fullDescription, 2000)}`
        ].join('\n');

        try {
            const response = await withTimeout(fetch(requestConfig.endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(requestConfig.apiKey ? { Authorization: `Bearer ${requestConfig.apiKey}` } : {})
                },
                body: JSON.stringify({
                    model: requestConfig.model,
                    messages: [
                        { role: 'system', content: 'You classify tool plugins. Return JSON only.' },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.1,
                    max_tokens: 220
                })
            }), this.config.classifierTimeoutMs, 'small model classification request');

            if (!response.ok) throw new Error(`small model HTTP ${response.status}`);
            const data = await response.json();
            const content = data?.choices?.[0]?.message?.content || data?.content || '';
            const jsonText = String(content).match(/\{[\s\S]*\}/)?.[0];
            if (!jsonText) throw new Error('small model returned no JSON object');
            return this._normalizeClassification(JSON.parse(jsonText), record, 'small_model');
        } catch (error) {
            this.lastError = error.message;
            if (this.debugMode) console.warn('[DynamicToolRegistry] small model classification failed:', error.message);
            return null;
        }
    }

    _resolveSmallModelRequestConfig(smallModel = {}) {
        if (!smallModel.enabled || !smallModel.model) return null;
        const useMainConfig = smallModel.useMainConfig !== false;
        const endpoint = useMainConfig
            ? normalizeOpenAIChatEndpoint(process.env.API_URL)
            : normalizeOpenAIChatEndpoint(smallModel.endpoint);
        if (!endpoint) return null;

        const apiKey = useMainConfig
            ? (process.env.API_Key || '')
            : (smallModel.apiKey || (smallModel.apiKeyEnv ? process.env[smallModel.apiKeyEnv] : ''));
        return {
            endpoint,
            apiKey,
            model: smallModel.model
        };
    }

    _normalizeClassification(result, record, classifiedBy) {
        const fallback = this._fallbackClassify(record);
        if (!result || typeof result !== 'object') return fallback;
        const categories = asArray(result.categories).map(String).map((item) => item.trim()).filter(Boolean);
        const keywords = asArray(result.keywords).map(String).map((item) => item.trim()).filter(Boolean);
        const selectedCategories = categories.length > 0 ? categories : fallback.categories;
        return {
            brief: this._compactBrief(record, selectedCategories, result.brief || fallback.brief),
            categories: selectedCategories,
            keywords: keywords.length > 0 ? keywords : fallback.keywords,
            classifiedBy: result.classifiedBy || classifiedBy,
            confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : fallback.confidence
        };
    }

    async _classifyWithEmbeddings(record) {
        if (!this.config.useRagEmbeddings) return null;
        const getEmbedding = this._resolveEmbeddingProvider();
        if (!getEmbedding) return null;

        try {
            const text = cleanText(`${record.pluginName} ${record.displayName} ${record.description} ${record.fullDescription}`, 2000);
            const pluginVector = await withTimeout(
                Promise.resolve(getEmbedding(text)),
                this.config.classifierTimeoutMs,
                'RAG embedding plugin classification'
            );
            if (!Array.isArray(pluginVector) || pluginVector.length === 0) return null;

            const scored = [];
            for (const rule of CATEGORY_RULES) {
                const categoryVector = await this._getCategoryEmbedding(rule, getEmbedding);
                if (!categoryVector) continue;
                scored.push({
                    category: rule.category,
                    score: this._cosineSimilarity(pluginVector, categoryVector),
                    keywords: rule.keywords
                });
            }
            scored.sort((a, b) => b.score - a.score);
            const selected = scored.filter((item) => item.score >= 0.34).slice(0, 3);
            if (selected.length === 0) return null;
            const keywords = selected.flatMap((item) => item.keywords.slice(0, 6));
            const categories = selected.map((item) => item.category);
            return {
                brief: this._compactBrief(record, categories, record.brief || record.description || `${record.pluginName} provides a VCP tool.`),
                categories,
                keywords: Array.from(new Set(keywords)),
                classifiedBy: 'rag_embedding_fallback',
                confidence: Math.max(0.45, Math.min(0.95, selected[0].score))
            };
        } catch (error) {
            this.lastError = error.message;
            if (this.debugMode) console.warn('[DynamicToolRegistry] RAG embedding classification failed:', error.message);
            return null;
        }
    }

    async _getCategoryEmbedding(rule, getEmbedding) {
        if (this.categoryEmbeddingCache.has(rule.category)) {
            return this.categoryEmbeddingCache.get(rule.category);
        }
        const text = `${rule.category}: ${rule.keywords.join(', ')}`;
        const vector = await withTimeout(
            Promise.resolve(getEmbedding(text)),
            this.config.classifierTimeoutMs,
            'RAG embedding category classification'
        );
        if (Array.isArray(vector) && vector.length > 0) {
            this.categoryEmbeddingCache.set(rule.category, vector);
            return vector;
        }
        return null;
    }

    _resolveEmbeddingProvider() {
        const ragPlugin = this.pluginManager?.messagePreprocessors?.get
            ? this.pluginManager.messagePreprocessors.get('RAGDiaryPlugin')
            : null;
        if (ragPlugin && typeof ragPlugin.getSingleEmbedding === 'function') {
            return ragPlugin.getSingleEmbedding.bind(ragPlugin);
        }
        if (ragPlugin && typeof ragPlugin.getContextBridge === 'function') {
            const bridge = ragPlugin.getContextBridge();
            if (bridge && typeof bridge.getSingleEmbedding === 'function') {
                return bridge.getSingleEmbedding.bind(bridge);
            }
        }
        return null;
    }

    _cosineSimilarity(a, b) {
        const length = Math.min(a.length, b.length);
        if (length === 0) return 0;
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < length; i++) {
            const av = Number(a[i]) || 0;
            const bv = Number(b[i]) || 0;
            dot += av * bv;
            normA += av * av;
            normB += bv * bv;
        }
        if (normA === 0 || normB === 0) return 0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    _fallbackClassify(record) {
        const text = `${record.pluginName} ${record.displayName} ${record.description} ${record.fullDescription}`.toLowerCase();
        const categories = [];
        const keywords = new Set();
        for (const rule of CATEGORY_RULES) {
            const matched = rule.keywords.filter((keyword) => text.includes(keyword.toLowerCase()));
            if (matched.length > 0) {
                categories.push(rule.category);
                for (const keyword of matched.slice(0, 12)) keywords.add(keyword);
            }
        }
        if (categories.length === 0) {
            categories.push('general');
            keywords.add('tool');
        }
        const selectedCategories = Array.from(new Set(categories));
        const brief = this._compactBrief(record, selectedCategories, record.brief || record.description || `${record.pluginName} provides a VCP tool.`);
        return {
            brief,
            categories: selectedCategories,
            keywords: Array.from(keywords),
            classifiedBy: 'keyword_fallback',
            confidence: categories.includes('general') ? 0.45 : 0.7
        };
    }

    _formatLightListName(record) {
        const pluginName = String(record?.pluginName || '').trim();
        const displayName = String(record?.displayName || '').trim();
        if (displayName && displayName !== pluginName) return `${displayName} (${pluginName})`;
        return pluginName || displayName || 'UnknownTool';
    }

    _briefTokenBudget(record, categories = []) {
        const categoryText = asArray(categories).join(' ');
        const used = estimateTokenCount(`${this._formatLightListName(record)} ${categoryText}`);
        return Math.max(
            MIN_BRIEF_TOKEN_BUDGET,
            Math.min(DEFAULT_BRIEF_TOKEN_BUDGET, LIGHT_LIST_TOKEN_BUDGET - used)
        );
    }

    _compactBrief(record, categories, brief) {
        const fallback = record?.description || `${record?.pluginName || 'This tool'} provides a VCP tool.`;
        const source = brief || record?.brief || fallback;
        return truncateToTokenBudget(source, this._briefTokenBudget(record, categories));
    }

    _briefForLightList(record, categories = []) {
        const classification = this._classificationFor(record);
        const selectedCategories = asArray(categories).length > 0 ? categories : (classification?.categories || []);
        return this._compactBrief(
            record,
            selectedCategories,
            classification?.brief || record.brief || record.description || 'No brief description.'
        );
    }

    _parseDirectives(text) {
        const directives = {
            categories: new Set(),
            tools: new Set()
        };
        const raw = String(text || '');
        const categoryRegex = /\[\[VCPDynamicTools:category=([^:\]]+):all\]\]/gi;
        const toolRegex = /\[\[VCPDynamicTools:tool=([^\]]+)\]\]/gi;
        let match;
        while ((match = categoryRegex.exec(raw)) !== null) {
            directives.categories.add(match[1].trim());
        }
        while ((match = toolRegex.exec(raw)) !== null) {
            directives.tools.add(match[1].trim());
        }

        const strongVerb = /(expand|expose|show|list|display|full|details|完整|全部|展开|暴露|显示|列出|详情)/i;
        if (!strongVerb.test(raw)) return directives;

        const available = this._getAvailableRecords();
        const lower = raw.toLowerCase();
        const knownCategories = new Set();
        for (const record of available) {
            for (const category of this._recordCategories(record)) knownCategories.add(category);
        }
        for (const category of knownCategories) {
            if (lower.includes(category.toLowerCase())) directives.categories.add(category);
        }
        for (const record of available) {
            const names = [record.pluginName, record.displayName, ...(record.commandIdentifiers || [])].filter(Boolean);
            if (names.some((name) => lower.includes(String(name).toLowerCase()))) {
                directives.tools.add(record.pluginName);
            }
        }
        return directives;
    }

    _scoreRecord(record, queryText, directives) {
        let score = 0;
        const queryLower = String(queryText || '').toLowerCase();
        const queryTokens = tokenSet(queryText);
        if (directives.tools.has(record.pluginName) || Array.from(directives.tools).some((name) => this._matchesToolName(record, name))) {
            score += 100;
        }
        if (Array.from(directives.categories).some((name) => this._recordCategories(record).some((category) => this._categoryMatches(category, name)))) {
            score += 80;
        }

        const classification = this._classificationFor(record);
        const categories = this._recordCategories(record);
        const keywords = asArray(classification?.keywords).map((item) => item.toLowerCase());
        for (const category of categories) {
            if (queryLower.includes(category.toLowerCase()) || queryTokens.has(category.toLowerCase())) score += 8;
        }
        for (const keyword of keywords) {
            if (queryLower.includes(keyword.toLowerCase()) || queryTokens.has(keyword.toLowerCase())) score += 5;
        }
        const haystack = `${record.pluginName} ${record.displayName} ${record.description} ${classification?.brief || ''}`.toLowerCase();
        for (const token of queryTokens) {
            if (haystack.includes(token)) score += 2;
        }
        return score;
    }

    _getAvailableRecords() {
        return Array.from(this.catalog.values())
            .map((record) => ({ ...record, available: this._isAvailable(record) && record.available !== false }))
            .filter((record) => record.available)
            .sort((a, b) => this._compareRecordsWithPinned(a, b));
    }

    _recordCategories(record) {
        return asArray(this._classificationFor(record)?.categories);
    }

    _classificationFor(record) {
        return this.categories.get(record.originKey) || this._fallbackClassify(record);
    }

    _categoryMatches(actual, requested) {
        const aliases = this.config.manualOverrides?.categoryAliases || {};
        const normalizedRequested = normalizeName(aliases[requested] || requested);
        const normalizedActual = normalizeName(actual);
        return normalizedActual === normalizedRequested || normalizedActual.includes(normalizedRequested) || normalizedRequested.includes(normalizedActual);
    }

    _matchesToolName(record, requested) {
        const requestedLower = normalizeName(requested);
        return [record.pluginName, record.displayName, ...(record.commandIdentifiers || [])]
            .filter(Boolean)
            .some((value) => normalizeName(value) === requestedLower);
    }

    _isForcedKey(originKey, directives, records) {
        const record = records.find((item) => item.originKey === originKey);
        if (!record) return false;
        if (Array.from(directives.tools).some((name) => this._matchesToolName(record, name))) return true;
        return Array.from(directives.categories).some((name) => this._recordCategories(record).some((category) => this._categoryMatches(category, name)));
    }

    _compareRecordsWithPinned(a, b) {
        const pinned = new Set(asArray(this.config.manualOverrides?.pinnedOriginKeys));
        const aPinned = pinned.has(a.originKey) ? 1 : 0;
        const bPinned = pinned.has(b.originKey) ? 1 : 0;
        if (aPinned !== bPinned) return bPinned - aPinned;
        return this._compareRecords(a, b);
    }

    _compareRecords(a, b) {
        const aCategory = this._recordCategories(a)[0] || 'general';
        const bCategory = this._recordCategories(b)[0] || 'general';
        const categoryCompare = aCategory.localeCompare(bCategory);
        if (categoryCompare !== 0) return categoryCompare;
        const displayCompare = String(a.displayName || a.pluginName).localeCompare(String(b.displayName || b.pluginName));
        if (displayCompare !== 0) return displayCompare;
        return String(a.originKey).localeCompare(String(b.originKey));
    }

    _truncateInjection(text) {
        const max = this.config.maxInjectionChars;
        if (String(text).length <= max) return text;
        const suffix = '\n\n[Dynamic VCP Tools truncated by maxInjectionChars; request a category or specific tool for more detail.]';
        return `${String(text).slice(0, Math.max(0, max - suffix.length)).trimEnd()}${suffix}`;
    }

    _scheduleClassificationFlush() {
        if (this.classificationQueue.size === 0) return;
        if (this.classificationTimer) clearTimeout(this.classificationTimer);
        const delay = this.config.classificationDebounceMs;
        this.classificationTimer = setTimeout(() => {
            this.flushClassificationQueue().catch((error) => {
                this.lastError = error.message;
                console.error('[DynamicToolRegistry] classification flush failed:', error);
            });
        }, delay);
        if (delay === 0 && this.classificationTimer.unref) this.classificationTimer.unref();
    }

    async _loadCatalog() {
        const data = await this._readJson(this.catalogPath, { version: 1, snapshotId: 0, plugins: {} });
        this.snapshotId = Number(data.snapshotId || 0);
        this.catalog = new Map(Object.entries(data.plugins || {}));
    }

    async _loadCategories() {
        const data = await this._readJson(this.categoriesPath, { version: 1, items: {} });
        this.categories = new Map(Object.entries(data.items || {}));
    }

    async _writeCatalog() {
        const plugins = {};
        for (const [originKey, record] of this.catalog.entries()) {
            const { fullDescription, ...serializable } = record;
            plugins[originKey] = serializable;
        }
        await this._queueWrite(this.catalogPath, {
            version: 1,
            updatedAt: new Date().toISOString(),
            snapshotId: this.snapshotId,
            plugins
        });
    }

    async _writeCategories() {
        const items = Object.fromEntries(this.categories.entries());
        await this._queueWrite(this.categoriesPath, {
            version: 1,
            updatedAt: new Date().toISOString(),
            items
        });
    }

    async _writeConfigIfMissingOrSanitized(fileConfig, configToWrite = this.persistedConfig) {
        const shouldWrite = !fileConfig || JSON.stringify(this._redactConfig(fileConfig)) !== JSON.stringify(this._redactConfig(configToWrite));
        if (shouldWrite) {
            await this._queueWrite(this.configPath, this._redactConfig(configToWrite));
        }
    }

    async _queueWrite(filePath, data) {
        this.writePromise = this.writePromise
            .catch((error) => {
                this.lastError = error.message;
            })
            .then(() => this._writeJsonAtomic(filePath, data));
        return this.writePromise;
    }

    async _writeJsonAtomic(filePath, data) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        await fs.rename(tmpPath, filePath);
    }

    async _readJson(filePath, fallback) {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            return JSON.parse(content);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                this.lastError = `Failed to read ${path.basename(filePath)}: ${error.message}`;
                if (this.debugMode) console.warn(`[DynamicToolRegistry] ${this.lastError}`);
            }
            return fallback;
        }
    }

    async _readPrivatePluginConfig() {
        try {
            const content = await fs.readFile(this.privateConfigPath, 'utf8');
            const env = dotenv.parse(content);
            const smallModel = {};
            if (Object.prototype.hasOwnProperty.call(env, 'SmallModel_Enabled')) {
                smallModel.enabled = parseEnvBoolean(env.SmallModel_Enabled, false);
            }
            if (Object.prototype.hasOwnProperty.call(env, 'SmallModel_Use_Main_Config')) {
                smallModel.useMainConfig = parseEnvBoolean(env.SmallModel_Use_Main_Config, true);
            }
            if (env.SmallModel_Endpoint) smallModel.endpoint = env.SmallModel_Endpoint;
            if (env.SmallModel_Model) smallModel.model = env.SmallModel_Model;
            if (env.SmallModel_API_Key) smallModel.apiKey = env.SmallModel_API_Key;
            if (env.SmallModel_API_Key_Env) smallModel.apiKeyEnv = env.SmallModel_API_Key_Env;
            return Object.keys(smallModel).length > 0 ? { smallModel } : {};
        } catch (error) {
            if (error.code !== 'ENOENT') {
                this.lastError = `Failed to read ${path.basename(this.privateConfigPath)}: ${error.message}`;
                if (this.debugMode) console.warn(`[DynamicToolRegistry] ${this.lastError}`);
            }
            return {};
        }
    }

    _applyPrivateConfig() {
        if (!this.privateConfig?.smallModel) return;
        this.config.smallModel = {
            ...(this.config.smallModel || {}),
            ...this.privateConfig.smallModel
        };
    }

    _redactConfig(config) {
        const redacted = mergeConfig(DEFAULT_CONFIG, config, {});
        if (redacted.smallModel) delete redacted.smallModel.apiKey;
        return redacted;
    }

    _bindPluginManagerEvents(pluginManager) {
        if (!pluginManager || typeof pluginManager.on !== 'function') return;
        if (this._boundPluginManager === pluginManager) return;
        if (this._boundPluginManager && typeof this._boundPluginManager.removeListener === 'function') {
            if (this._toolsChangedHandler) this._boundPluginManager.removeListener('tools_changed', this._toolsChangedHandler);
            if (this._distributedOfflineHandler) this._boundPluginManager.removeListener('distributed_tools_offline', this._distributedOfflineHandler);
        }

        this._toolsChangedHandler = (payload = {}) => {
            this.syncFromPluginManager(payload.reason || 'tools_changed').catch((error) => {
                this.lastError = error.message;
                console.error('[DynamicToolRegistry] tools_changed sync failed:', error);
            });
        };
        this._distributedOfflineHandler = (payload = {}) => {
            this.markDistributedOffline(payload.serverId, payload.manifests || payload.tools || []).catch((error) => {
                this.lastError = error.message;
                console.error('[DynamicToolRegistry] distributed offline sync failed:', error);
            });
        };
        pluginManager.on('tools_changed', this._toolsChangedHandler);
        pluginManager.on('distributed_tools_offline', this._distributedOfflineHandler);
        this._boundPluginManager = pluginManager;
    }
}

const singleton = new DynamicToolRegistry();

module.exports = singleton;
module.exports.DynamicToolRegistry = DynamicToolRegistry;
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
