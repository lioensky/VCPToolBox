// modules/dynamicToolRegistry.js
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { buildDynamicFoldObject, hasFoldMarkers } = require('./foldProtocol');

const PRIVATE_CONFIG_RELATIVE_PATH = path.join('Plugin', 'DynamicToolBridge', 'config.env');
const {
    DEFAULT_CONFIG, DEFAULT_CATEGORY_RULES: CATEGORY_RULES, validateConfigPatch, mergeConfig,
    estimateTokenCount, truncateToTokenBudget, hasFragmentedChinese, keywordMatches,
    parseModelContent, validateClassification
} = require('./dynamicToolSemantics');

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
        this._configWatchers = [];
        this._configReloadTimer = null;
        this._configReloadPromise = Promise.resolve();
        this._configMutationPromise = Promise.resolve();
        this.configGeneration = 0;
        this._activeClassifierControllers = new Set();
    }

    async initialize(options = {}) {
        const {
            pluginManager,
            projectBasePath = path.join(__dirname, '..'),
            debugMode = false,
            config = {},
            classifier = null,
            watchConfigFiles = true
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
        const fileConfig = await this._readConfigFile();
        let candidate = mergeConfig(DEFAULT_CONFIG, config, fileConfig);
        if (!fileConfig || fileConfig.version !== 2) {
            const legacy = await this._readPrivatePluginConfig();
            candidate = mergeConfig(candidate, legacy);
        }
        await this._writeConfigIfMissingOrSanitized(fileConfig, candidate);
        this.persistedConfig = cloneJson(candidate);
        this.config = cloneJson(candidate);

        await this._loadCatalog();
        await this._loadCategories();
        this._bindPluginManagerEvents(this.pluginManager);
        if (watchConfigFiles) this._watchConfigFiles();
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
            const reusablePrevious = previous || this._findReusableDistributedRecord(record);
            if (!previous && reusablePrevious && reusablePrevious.originKey !== record.originKey) {
                const reusableClassification = this.categories.get(reusablePrevious.originKey);
                if (reusableClassification && !this.categories.has(record.originKey)) {
                    this.categories.set(record.originKey, {
                        ...reusableClassification,
                        pluginName: record.pluginName
                    });
                }
            }
            const merged = {
                ...(reusablePrevious || {}),
                ...record,
                firstSeenAt: reusablePrevious?.firstSeenAt || now,
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

        this._compactDistributedHistory();

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
            const reusablePrevious = previous || this._findReusableDistributedRecord(record);
            if (!previous && reusablePrevious && reusablePrevious.originKey !== record.originKey) {
                const reusableClassification = this.categories.get(reusablePrevious.originKey);
                if (reusableClassification && !this.categories.has(record.originKey)) {
                    this.categories.set(record.originKey, {
                        ...reusableClassification,
                        pluginName: record.pluginName
                    });
                }
            }
            const next = {
                ...(reusablePrevious || {}),
                ...record,
                enabled: reusablePrevious?.enabled !== false,
                online: false,
                available: false,
                firstSeenAt: reusablePrevious?.firstSeenAt || now,
                lastSeenAt: now,
                lastStatusChangeAt: now
            };
            if (reusablePrevious && reusablePrevious.sourceHash) {
                next.manifestHash = reusablePrevious.manifestHash;
                next.descriptionHash = reusablePrevious.descriptionHash;
                next.sourceHash = reusablePrevious.sourceHash;
                next.fullDescription = reusablePrevious.fullDescription || record.fullDescription;
            }
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
            this._compactDistributedHistory();
            this.snapshotId += 1;
            await this._writeCatalog();
            this._scheduleClassificationFlush();
        }
    }

    _findReusableDistributedRecord(record) {
        if (!record || record.originKind !== 'distributed') return null;
        const identityKey = this._stableDistributedIdentityKey(record);
        if (!identityKey) return null;

        const candidates = Array.from(this.catalog.values())
            .filter((item) => (
                item &&
                item.originKind === 'distributed' &&
                item.originKey !== record.originKey &&
                this._stableDistributedIdentityKey(item) === identityKey
            ))
            .sort((a, b) => this._compareDistributedHistoryCandidates(a, b));

        return candidates[0] || null;
    }

    _compactDistributedHistory() {
        const groups = new Map();
        for (const record of this.catalog.values()) {
            if (!record || record.originKind !== 'distributed') continue;
            const identityKey = this._stableDistributedIdentityKey(record);
            if (!identityKey) continue;
            if (!groups.has(identityKey)) groups.set(identityKey, []);
            groups.get(identityKey).push(record);
        }

        for (const records of groups.values()) {
            if (records.length <= 1) continue;
            records.sort((a, b) => this._compareDistributedHistoryCandidates(a, b));
            const keeper = records[0];
            const keeperClassification = this.categories.get(keeper.originKey);

            for (const duplicate of records.slice(1)) {
                const duplicateClassification = this.categories.get(duplicate.originKey);
                if (!keeperClassification && duplicateClassification) {
                    this.categories.set(keeper.originKey, {
                        ...duplicateClassification,
                        pluginName: keeper.pluginName
                    });
                }
                this.catalog.delete(duplicate.originKey);
                this.categories.delete(duplicate.originKey);
                this._removeClassificationQueueEntriesForOrigin(duplicate.originKey);
            }
        }
    }

    _removeClassificationQueueEntriesForOrigin(originKey) {
        if (!originKey) return;
        for (const queueKey of Array.from(this.classificationQueue.keys())) {
            if (queueKey.startsWith(`${originKey}:`)) {
                this.classificationQueue.delete(queueKey);
            }
        }
    }

    _compareDistributedHistoryCandidates(a, b) {
        const aAvailable = this._isAvailable(a) && a.available !== false ? 1 : 0;
        const bAvailable = this._isAvailable(b) && b.available !== false ? 1 : 0;
        if (aAvailable !== bAvailable) return bAvailable - aAvailable;

        const aOnline = a.online !== false ? 1 : 0;
        const bOnline = b.online !== false ? 1 : 0;
        if (aOnline !== bOnline) return bOnline - aOnline;

        const aSeen = Date.parse(a.lastSeenAt || a.lastStatusChangeAt || a.firstSeenAt || 0) || 0;
        const bSeen = Date.parse(b.lastSeenAt || b.lastStatusChangeAt || b.firstSeenAt || 0) || 0;
        if (aSeen !== bSeen) return bSeen - aSeen;

        return String(a.originKey || '').localeCompare(String(b.originKey || ''));
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
                    const generation = this.configGeneration;
                    this._activeClassificationRecord = current;
                    try {
                        const classification = await this._classifyRecord(current, item.reason);
                        if (generation !== this.configGeneration || this.catalog.get(current.originKey)?.sourceHash !== current.sourceHash) continue;
                        this.categories.set(current.originKey, {
                            pluginName: current.pluginName,
                            sourceHash: current.sourceHash,
                            brief: classification.brief || current.brief,
                            ...(classification.baseClassification ? { baseClassification: classification.baseClassification } : {}),
                            categories: asArray(classification.categories).map(String).filter(Boolean),
                            keywords: asArray(classification.keywords).map(String).filter(Boolean),
                            classifiedBy: classification.classifiedBy || 'keyword_fallback',
                            classifiedAt: new Date().toISOString(),
                            confidence: Number.isFinite(Number(classification.confidence)) ? Number(classification.confidence) : 0.5
                        });
                    } catch (error) {
                        if (generation !== this.configGeneration || this.catalog.get(current.originKey)?.sourceHash !== current.sourceHash) continue;
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
                    } finally {
                        this._activeClassificationRecord = null;
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
                lines.push(await this._expandedDescriptionFor(record, options));
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
        const records = this._getAdminRecords()
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
        const patch = validateConfigPatch(nextConfig);
        return this._mutateConfig(() => patch);
    }

    async updateOverride(payload) {
        const invalid = () => { const error = new Error('动态工具覆盖配置无效'); error.status = 400; throw error; };
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalid();
        if (Object.keys(payload).some((key) => !['originKey', 'excluded', 'pinned', 'manualOverrides'].includes(key))) invalid();
        const has = (key) => Object.prototype.hasOwnProperty.call(payload, key);
        const hasFlags = has('excluded') || has('pinned');
        if (!hasFlags && !has('manualOverrides')) invalid();
        if (has('originKey') && (typeof payload.originKey !== 'string' || !payload.originKey.trim() || payload.originKey.length > 300)) invalid();
        if (hasFlags && !has('originKey')) invalid();
        for (const key of ['excluded', 'pinned']) if (has(key) && typeof payload[key] !== 'boolean') invalid();
        const patch = has('manualOverrides') ? validateConfigPatch({ manualOverrides: payload.manualOverrides }) : { manualOverrides: {} };
        return this._mutateConfig((current) => {
            for (const field of ['excluded', 'pinned']) {
                if (!has(field)) continue;
                const key = field === 'excluded' ? 'excludedOriginKeys' : 'pinnedOriginKeys';
                const list = new Set(patch.manualOverrides[key] || current.manualOverrides[key]);
                if (payload[field]) list.add(payload.originKey.trim());
                else list.delete(payload.originKey.trim());
                patch.manualOverrides[key] = [...list].sort();
            }
            return patch;
        });
    }

    async _mutateConfig(makePatch) {
        this._configMutationPromise = this._configMutationPromise.catch(() => {}).then(async () => {
            const candidate = mergeConfig(this.persistedConfig, makePatch(this.persistedConfig));
            await this._queueWrite(this.configPath, candidate);
            this._activateConfig(candidate);
            await this._syncAfterConfigCommit('config_saved');
            return this._redactConfig(this.config);
        });
        return this._configMutationPromise;
    }

    async _syncAfterConfigCommit(reason) {
        if (!this.pluginManager?.plugins) return;
        const warning = '配置已保存并生效，工具目录同步失败；请重试目录同步';
        // The previous failure was already reported; do not replay its raw message.
        this.syncPromise = this.syncPromise.catch(() => {});
        try {
            await this.syncFromPluginManager(reason);
            if (this.lastError === warning) this.lastError = null;
        } catch { this.lastError = warning; }
    }

    async reloadConfigFromDisk(reason = 'config_file_changed') {
        this._configMutationPromise = this._configMutationPromise.catch(() => {}).then(async () => {
            try {
                const fileConfig = await this._readConfigFile();
                if (!fileConfig) throw new Error('配置文件不存在');
                // Legacy env is consumed only during initialization's v1 -> v2 migration.
                const candidate = mergeConfig(DEFAULT_CONFIG, fileConfig);
                await this._writeConfigIfMissingOrSanitized(fileConfig, candidate);
                this._activateConfig(candidate);
            } catch (error) {
                this.lastError = error.status === 400 ? error.message : '动态工具配置重载失败：JSON 或文件读取无效，保留上次有效配置';
                return this.getAdminState();
            }
            await this._syncAfterConfigCommit(reason);
            return this.getAdminState();
        });
        this._configReloadPromise = this._configMutationPromise;
        return this._configReloadPromise;
    }

    _activateConfig(candidate) {
        if (stableStringify(candidate) === stableStringify(this.config)) return;
        this.configGeneration += 1;
        for (const controller of this._activeClassifierControllers) controller.abort();
        this.persistedConfig = cloneJson(candidate);
        this.config = cloneJson(candidate);
        this.categoryEmbeddingCache.clear();
        for (const record of this.catalog.values()) record.available = this._isAvailable(record);
        this._refreshClassificationOverrides();
        if (this._activeClassificationRecord) this.enqueueClassification(this._activeClassificationRecord, 'config_changed');
        this._scheduleClassificationFlush();
    }

    async _readConfigFile() {
        let content;
        try { content = await fs.readFile(this.configPath, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') return null; throw new Error('动态工具配置读取失败'); }
        try {
            const value = JSON.parse(content);
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
            return value;
        } catch { throw new Error('动态工具配置 JSON 无效'); }
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

    _getAdminRecords() {
        const records = Array.from(this.catalog.values());
        const distributedGroups = new Map();

        for (const record of records) {
            if (!record || record.originKind !== 'distributed') continue;
            const identityKey = this._stableDistributedIdentityKey(record);
            if (!identityKey) continue;
            if (!distributedGroups.has(identityKey)) distributedGroups.set(identityKey, []);
            distributedGroups.get(identityKey).push(record);
        }

        const visibleDistributedKeys = new Set();
        for (const group of distributedGroups.values()) {
            group.sort((a, b) => this._compareDistributedHistoryCandidates(a, b));
            if (group[0]?.originKey) visibleDistributedKeys.add(group[0].originKey);
        }

        return records
            .filter((record) => {
                if (!record || record.originKind !== 'distributed') return true;
                const identityKey = this._stableDistributedIdentityKey(record);
                if (!identityKey) return true;
                return visibleDistributedKeys.has(record.originKey);
            })
            .sort((a, b) => this._compareRecordsWithPinned(a, b));
    }

    _stableDistributedIdentityKey(record) {
        if (!record || record.originKind !== 'distributed') return '';
        return [
            record.pluginName || '',
            this._normalizeDistributedDisplayName(record.displayName || record.pluginName),
            record.description || ''
        ].map((item) => String(item).trim()).join('::');
    }

    _normalizeDistributedDisplayName(value) {
        return String(value || '')
            .replace(/^(?:\s*\[云端\]\s*)+/u, '')
            .trim();
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
            const rawFullDescription = descriptions.get(`VCP${manifest.name}`) || this._buildFullDescriptionFromManifest(manifest);
            const descriptionOverride = this._descriptionOverrideFor(originKey);
            const fullDescription = descriptionOverride.fullDescription || rawFullDescription;
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
                brief: String(manifest.description || commands.map((cmd) => cmd.description).find(Boolean) || '').trim(),
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

    async _expandedDescriptionFor(record, options = {}) {
        const fullDescription = record.fullDescription || record.description || 'No full description available.';
        if (!this._descriptionHasFoldProtocol(fullDescription)) return fullDescription;

        const foldObj = this._parseFoldProtocolDescription(fullDescription, record);
        return this._resolveFoldBlocksForInjection(foldObj, options, record);
    }

    _parseFoldProtocolDescription(fullDescription, record = {}) {
        const text = String(fullDescription || '').trim();
        if (text.startsWith('{')) {
            try {
                const json = JSON.parse(text);
                if (json && json.vcp_dynamic_fold && Array.isArray(json.fold_blocks)) return json;
            } catch {
                // Fall through to marker parsing.
            }
        }
        return buildDynamicFoldObject({
            content: fullDescription,
            pluginDescription: record.description || record.displayName || record.pluginName,
            strategy: 'toolbox_block_similarity'
        });
    }

    _descriptionHasFoldProtocol(fullDescription) {
        if (typeof fullDescription !== 'string') return false;
        if (hasFoldMarkers(fullDescription)) return true;
        const trimmed = fullDescription.trim();
        if (!trimmed.startsWith('{')) return false;
        try {
            const json = JSON.parse(trimmed);
            return Boolean(json && json.vcp_dynamic_fold && Array.isArray(json.fold_blocks));
        } catch {
            return false;
        }
    }

    async _resolveFoldBlocksForInjection(foldObj, options = {}, record = {}) {
        const blocks = asArray(foldObj?.fold_blocks).filter((block) => block && typeof block.content === 'string');
        if (blocks.length === 0) return record.fullDescription || record.description || 'No full description available.';

        const fallbackBlock = [...blocks]
            .sort((a, b) => Number(a.threshold || 0) - Number(b.threshold || 0))
            .find((block) => block.content) || blocks[0];
        const ragPlugin = options.pluginManager?.messagePreprocessors?.get
            ? options.pluginManager.messagePreprocessors.get('RAGDiaryPlugin')
            : null;
        if (!ragPlugin || typeof ragPlugin.getSingleEmbeddingCached !== 'function') {
            return fallbackBlock.content;
        }

        const queryText = extractMessageText(options.messages || []);
        if (!queryText.trim()) return fallbackBlock.content;

        try {
            const userVector = await withTimeout(
                Promise.resolve(ragPlugin.getSingleEmbeddingCached(queryText)),
                this.config.classifierTimeoutMs,
                'dynamic tool fold query embedding'
            );
            const vectorDBManager = options.pluginManager?.vectorDBManager || ragPlugin.vectorDBManager;
            const getBlockVector = async (text) => {
                if (vectorDBManager && typeof vectorDBManager.getPluginDescriptionVector === 'function') {
                    return vectorDBManager.getPluginDescriptionVector(
                        `dynamic_tool_fold:${String(text || '').trim()}`,
                        ragPlugin.getSingleEmbeddingCached.bind(ragPlugin)
                    );
                }
                return ragPlugin.getSingleEmbeddingCached(text);
            };
            let pluginSimilarity = null;
            const getPluginSimilarity = async () => {
                if (pluginSimilarity !== null) return pluginSimilarity;
                const descText = foldObj.plugin_description || record.description || record.displayName || record.pluginName;
                const descVector = await withTimeout(
                    Promise.resolve(getBlockVector(descText)),
                    this.config.classifierTimeoutMs,
                    'dynamic tool fold plugin embedding'
                );
                pluginSimilarity = this._cosineSimilarity(userVector, descVector);
                return pluginSimilarity;
            };

            const included = [];
            for (const block of blocks) {
                const threshold = Number.isFinite(Number(block.threshold)) ? Number(block.threshold) : 0;
                if (threshold <= 0) {
                    included.push(block.content);
                    continue;
                }
                if (!String(block.description || '').trim()) {
                    if (await getPluginSimilarity() >= threshold) included.push(block.content);
                    continue;
                }
                const targetText = block.description || block.content;
                const blockVector = await withTimeout(
                    Promise.resolve(getBlockVector(targetText)),
                    this.config.classifierTimeoutMs,
                    'dynamic tool fold block embedding'
                );
                if (this._cosineSimilarity(userVector, blockVector) >= threshold) {
                    included.push(block.content);
                }
            }
            return included.length > 0 ? included.join('\n\n') : fallbackBlock.content;
        } catch (error) {
            this.lastError = error.message;
            if (this.debugMode) console.warn('[DynamicToolRegistry] fold block expansion failed:', error.message);
            return fallbackBlock.content;
        }
    }

    _isAvailable(record) {
        const excluded = new Set(asArray(this.config.manualOverrides?.excludedOriginKeys));
        return record.enabled !== false && record.online !== false && !excluded.has(record.originKey);
    }

    _descriptionOverrideFor(originKey) {
        const overrides = this.config.manualOverrides?.descriptionOverrides;
        const value = overrides && typeof overrides === 'object' ? overrides[originKey] : null;
        if (!value || typeof value !== 'object') {
            return {
                brief: '',
                fullDescription: '',
                categories: [],
                keywords: []
            };
        }
        return {
            brief: typeof value.brief === 'string' ? value.brief.trim() : '',
            fullDescription: typeof value.fullDescription === 'string' ? value.fullDescription : '',
            categories: asArray(value.categories).map(String).map((item) => item.trim()).filter(Boolean),
            keywords: asArray(value.keywords).map(String).map((item) => item.trim()).filter(Boolean)
        };
    }

    async _classifyRecord(record, reason) {
        const generation = this.configGeneration;
        if (this.classifier) {
            const result = await withTimeout(
                Promise.resolve(this.classifier(record, { reason, config: this._redactConfig(this.config) })),
                this.config.classifierTimeoutMs,
                'DynamicToolRegistry classifier'
            );
            return this._normalizeClassification(result, record, 'custom_classifier');
        }

        const smallModelResult = await this._classifyWithSmallModel(record, reason);
        if (generation !== this.configGeneration) throw new Error('分类配置已变更，旧任务结束');
        if (smallModelResult) return smallModelResult;
        const embeddingResult = await this._classifyWithEmbeddings(record);
        if (generation !== this.configGeneration) throw new Error('分类配置已变更，旧任务结束');
        if (embeddingResult) return embeddingResult;
        return this._fallbackClassify(record);
    }

    async _classifyWithSmallModel(record, reason) {
        const config = this.config;
        const generation = this.configGeneration;
        const smallModel = config.smallModel;
        const requestConfig = this._resolveSmallModelRequestConfig(smallModel);
        if (!requestConfig) return null;
        const controller = new AbortController();
        this._activeClassifierControllers.add(controller);
        const timeout = setTimeout(() => controller.abort(new Error('分类总预算超时')), config.classifierTimeoutMs);
        const aborted = new Promise((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(new Error('分类已取消或超时')), { once: true });
        });
        const withinDeadline = (promise) => Promise.race([promise, aborted]);
        const prompt = [
            'Classify this VCP plugin using the capability definitions below; choose the most specific category IDs.',
            'Return strict JSON: {"brief":"...","categories":["..."],"keywords":["..."],"confidence":0.0}. All fields are required.',
            `Write a short complete capability phrase in the description language. Target ${config.summary.briefTokenBudget} tokens, name + categories + brief target ${config.summary.lightListTokenBudget} tokens; semantic completeness overrides this soft target. Never split Chinese words or insert spaces between characters.`,
            `Select at most ${config.classification.maxCategories} categories. Definitions: ${JSON.stringify(config.classification.categoryRules)}`,
            `Reason: ${reason}`, `Name: ${record.pluginName}`, `Display: ${record.displayName}`,
            `Description: ${record.description}`, `Usage: ${cleanText(record.fullDescription, 2000)}`
        ].join('\n');
        const messages = [{ role: 'system', content: 'You classify tool capabilities. Return JSON only; preserve complete phrases.' }, { role: 'user', content: prompt }];
        let diagnostic = '请求失败';
        try {
            for (let attempt = 0; attempt <= smallModel.maxRetries; attempt++) {
                if (controller.signal.aborted) break;
                try {
                    const response = await withinDeadline(fetch(requestConfig.endpoint, {
                        method: 'POST', signal: controller.signal,
                        headers: { 'Content-Type': 'application/json', ...(requestConfig.apiKey ? { Authorization: `Bearer ${requestConfig.apiKey}` } : {}) },
                        body: JSON.stringify({ model: requestConfig.model, messages, temperature: smallModel.temperature, max_tokens: smallModel.maxTokens })
                    }));
                    if (!response.ok) {
                        diagnostic = `HTTP ${response.status}`;
                        // Do not leave unsuccessful HTTP response bodies downloading across retries.
                        if (response.body?.cancel) Promise.resolve(response.body.cancel()).catch(() => {});
                        if (response.status !== 429 && !(response.status >= 500 && response.status <= 599)) break;
                    } else {
                        let data;
                        try { data = await withinDeadline(response.json()); }
                        catch (error) { if (controller.signal.aborted) throw error; diagnostic = '格式错误：响应不是 JSON'; }
                        if (data !== undefined) {
                            try {
                                const allowed = new Set(config.classification.categoryRules.flatMap((rule) => [rule.category, rule.parent].filter(Boolean)).concat('general'));
                                const result = parseModelContent(data?.choices?.[0]?.message?.content ?? data?.content ?? data, (candidate) => {
                                    validateClassification(candidate);
                                    if (candidate.categories.some((category) => !allowed.has(category.trim()))) throw new Error('结构错误：categories 必须使用给定类别 ID');
                                    if (candidate.categories.length > config.classification.maxCategories) throw new Error('结构错误：categories 数量超过 maxCategories');
                                    return candidate;
                                });
                                const normalized = this._normalizeClassification(result, record, 'small_model');
                                if (generation === this.configGeneration && this.lastError?.startsWith(`小模型分类失败：${record.pluginName}（`)) this.lastError = null;
                                return normalized;
                            } catch (error) { diagnostic = error.message; }
                        }
                    }
                } catch {
                    diagnostic = controller.signal.aborted ? '已取消或超时' : '网络请求失败';
                    if (controller.signal.aborted) break;
                }
                if (attempt < smallModel.maxRetries) {
                    messages.push({ role: 'user', content: `Previous response failed validation: ${diagnostic}. Return the complete JSON object with brief:string, categories:string[], keywords:string[], confidence:number 0..1. No missing fields or wrong types.` });
                    if (smallModel.retryDelayMs) {
                        let delay;
                        try { await withinDeadline(new Promise((resolve) => { delay = setTimeout(resolve, smallModel.retryDelayMs); })); }
                        finally { clearTimeout(delay); }
                    }
                }
            }
        } catch {
            diagnostic = controller.signal.aborted ? '已取消或超时' : diagnostic;
        } finally {
            clearTimeout(timeout);
            this._activeClassifierControllers.delete(controller);
        }
        if (generation === this.configGeneration) this.lastError = `小模型分类失败：${record.pluginName}（${diagnostic}；最多 ${smallModel.maxRetries + 1} 次请求）`;
        return null;
    }

    _resolveSmallModelRequestConfig(smallModel = {}) {
        if (!smallModel.enabled || !smallModel.model) return null;
        const endpoint = normalizeOpenAIChatEndpoint(process.env.API_URL);
        if (!endpoint) return null;
        return { endpoint, apiKey: process.env.API_Key || '', model: smallModel.model };
    }

    _normalizeClassification(result, record, classifiedBy) {
        const fallback = this._fallbackClassify(record);
        if (!result || typeof result !== 'object') return fallback;
        const categories = asArray(result.categories).map(String).map((item) => item.trim()).filter(Boolean);
        const keywords = asArray(result.keywords).map(String).map((item) => item.trim()).filter(Boolean);
        const selectedCategories = categories.length > 0 ? categories : fallback.categories;
        const normalized = {
            brief: this._compactBrief(record, selectedCategories, result.brief || fallback.brief),
            categories: selectedCategories,
            keywords: keywords.length > 0 ? keywords : fallback.keywords,
            classifiedBy: result.classifiedBy || classifiedBy,
            confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : fallback.confidence
        };
        return this._applyDescriptionOverrideToClassification(record, normalized);
    }

    _applyDescriptionOverrideToClassification(record, classification) {
        const override = this._descriptionOverrideFor(record.originKey);
        const base = classification.baseClassification || classification;
        const categories = override.categories.length > 0 ? override.categories : base.categories;
        const hasOverride = Boolean(override.brief || override.categories.length || override.keywords.length);
        const { baseClassification, ...metadata } = classification;
        return {
            ...metadata,
            brief: override.brief ? this._compactBrief(record, categories, override.brief) : base.brief,
            categories,
            keywords: override.keywords.length > 0 ? override.keywords : base.keywords,
            classifiedBy: hasOverride ? `${base.classifiedBy || 'keyword_fallback'}+manual_override` : base.classifiedBy,
            ...(hasOverride ? { baseClassification: { brief: base.brief, categories: base.categories, keywords: base.keywords, classifiedBy: base.classifiedBy } } : {})
        };
    }

    _refreshClassificationOverrides() {
        for (const [originKey, classification] of this.categories.entries()) {
            const record = this.catalog.get(originKey);
            if (!record || !classification) continue;
            this.categories.set(originKey, this._applyDescriptionOverrideToClassification(record, classification));
        }
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
            for (const rule of this.config.classification.categoryRules) {
                const categoryVector = await this._getCategoryEmbedding(rule, getEmbedding);
                if (!categoryVector) continue;
                scored.push({
                    category: rule.category,
                    score: this._cosineSimilarity(pluginVector, categoryVector),
                    keywords: rule.keywords
                });
            }
            scored.sort((a, b) => b.score - a.score);
            const selected = scored.filter((item) => item.score >= this.config.classification.embeddingThreshold).slice(0, this.config.classification.maxCategories);
            if (selected.length === 0) return null;
            const keywords = selected.flatMap((item) => item.keywords.slice(0, 6));
            const categories = selected.map((item) => item.category);
            return this._applyDescriptionOverrideToClassification(record, {
                brief: this._compactBrief(record, categories, record.brief || record.description || `${record.pluginName} provides a VCP tool.`),
                categories,
                keywords: Array.from(new Set(keywords)),
                classifiedBy: 'rag_embedding_fallback',
                confidence: Math.max(0.45, Math.min(0.95, selected[0].score))
            });
        } catch (error) {
            this.lastError = error.message;
            if (this.debugMode) console.warn('[DynamicToolRegistry] RAG embedding classification failed:', error.message);
            return null;
        }
    }

    async _getCategoryEmbedding(rule, getEmbedding) {
        const cacheKey = stableStringify(rule);
        if (this.categoryEmbeddingCache.has(cacheKey)) {
            return this.categoryEmbeddingCache.get(cacheKey);
        }
        const text = `${rule.category} (${rule.parent || ''}): ${rule.description}; ${rule.keywords.join(', ')}`;
        const vector = await withTimeout(
            Promise.resolve(getEmbedding(text)),
            this.config.classifierTimeoutMs,
            'RAG embedding category classification'
        );
        if (Array.isArray(vector) && vector.length > 0) {
            this.categoryEmbeddingCache.set(cacheKey, vector);
            return vector;
        }
        return null;
    }

    _resolveEmbeddingProvider() {
        const ragPlugin = this.pluginManager?.messagePreprocessors?.get
            ? this.pluginManager.messagePreprocessors.get('RAGDiaryPlugin')
            : null;
        if (!ragPlugin) return null;

        let rawEmbeddingFn = null;
        if (typeof ragPlugin.getSingleEmbeddingCached === 'function') {
            rawEmbeddingFn = ragPlugin.getSingleEmbeddingCached.bind(ragPlugin);
        } else if (typeof ragPlugin.getSingleEmbedding === 'function') {
            rawEmbeddingFn = ragPlugin.getSingleEmbedding.bind(ragPlugin);
        } else if (typeof ragPlugin.getContextBridge === 'function') {
            const bridge = ragPlugin.getContextBridge();
            if (bridge && typeof bridge.embedText === 'function') {
                rawEmbeddingFn = bridge.embedText.bind(bridge);
            }
        }

        if (!rawEmbeddingFn) return null;

        const vectorDBManager = this.pluginManager?.vectorDBManager || ragPlugin.vectorDBManager;
        if (vectorDBManager && typeof vectorDBManager.getPluginDescriptionVector === 'function') {
            return async (text) => vectorDBManager.getPluginDescriptionVector(
                `dynamic_tool_registry:${String(text || '').trim()}`,
                rawEmbeddingFn
            );
        }

        return rawEmbeddingFn;
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
        // Only capability descriptions, never incidental example parameters or response prose.
        const text = `${String(record.pluginName || '').replace(/([a-z])([A-Z])/g, '$1 $2')} ${record.displayName || ''} ${record.description || ''}`;
        const scored = this.config.classification.categoryRules.map((rule) => ({
            category: rule.category, matched: rule.keywords.filter((keyword) => keywordMatches(text, keyword))
        })).filter((item) => item.matched.length).sort((a, b) => b.matched.length - a.matched.length);
        const selected = scored.slice(0, this.config.classification.maxCategories);
        const categories = selected.length ? selected.map((item) => item.category) : ['general'];
        return this._applyDescriptionOverrideToClassification(record, {
            brief: this._compactBrief(record, categories, record.brief || record.description || `${record.pluginName} provides a VCP tool.`),
            categories,
            keywords: selected.length ? [...new Set(selected.flatMap((item) => item.matched))] : ['tool'],
            classifiedBy: 'keyword_fallback', confidence: selected.length ? 0.7 : 0.45
        });
    }

    _formatLightListName(record) {
        const pluginName = String(record?.pluginName || '').trim();
        const displayName = String(record?.displayName || '').trim();
        if (displayName && displayName !== pluginName) return `${displayName} (${pluginName})`;
        return pluginName || displayName || 'UnknownTool';
    }

    _briefTokenBudget(record, categories = []) {
        const summary = this.config.summary;
        const used = estimateTokenCount(`${this._formatLightListName(record)} ${asArray(categories).join(' ')}`);
        return Math.max(summary.minBriefTokenBudget, Math.min(summary.briefTokenBudget, summary.lightListTokenBudget - used));
    }

    _compactBrief(record, categories, brief) {
        const fallback = record?.description || `${record?.pluginName || 'This tool'} provides a VCP tool.`;
        let source = brief || record?.brief || fallback;
        if (hasFragmentedChinese(source)) source = record?.description || record?.brief || fallback;
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
        const lower = raw.replace(categoryRegex, ' ').replace(toolRegex, ' ').toLowerCase();
        const knownCategories = new Set(Object.keys(this.config.manualOverrides.categoryAliases));
        for (const record of available) {
            for (const category of this._recordCategories(record)) {
                knownCategories.add(category);
                const parent = this.config.classification.categoryRules.find((rule) => rule.category === category)?.parent || category.split('/')[0];
                if (parent) knownCategories.add(parent);
            }
        }
        for (const category of knownCategories) {
            const escaped = category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`(?:^|[^a-z0-9_./-])${escaped}(?=$|[^a-z0-9_./-])`, 'i').test(lower)) directives.categories.add(category);
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
        const parent = normalizeName(this.config.classification.categoryRules.find((rule) => normalizeName(rule.category) === normalizedActual)?.parent);
        return normalizedActual === normalizedRequested || parent === normalizedRequested || normalizedActual.startsWith(`${normalizedRequested}/`) || normalizedRequested.startsWith(`${normalizedActual}/`);
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

    _watchConfigFiles() {
        this._closeConfigWatchers();
        const watchTargets = [{ dir: this.toolConfigsDir, names: new Set([path.basename(this.configPath)]) }];

        for (const target of watchTargets) {
            try {
                if (!fsSync.existsSync(target.dir)) continue;
                const watcher = fsSync.watch(target.dir, (eventType, filename) => {
                    if (!filename || !target.names.has(String(filename))) return;
                    if (eventType !== 'change' && eventType !== 'rename') return;
                    this._scheduleConfigReload(`config_${eventType}`);
                });
                if (typeof watcher.unref === 'function') watcher.unref();
                watcher.on('error', (error) => {
                    this.lastError = error.message;
                    if (this.debugMode) console.warn('[DynamicToolRegistry] config watcher error:', error.message);
                });
                this._configWatchers.push(watcher);
            } catch (error) {
                this.lastError = error.message;
                if (this.debugMode) console.warn('[DynamicToolRegistry] failed to watch config files:', error.message);
            }
        }
    }

    _scheduleConfigReload(reason) {
        if (this._configReloadTimer) clearTimeout(this._configReloadTimer);
        this._configReloadTimer = setTimeout(() => {
            this._configReloadTimer = null;
            this.reloadConfigFromDisk(reason).catch((error) => {
                this.lastError = error.message;
                console.error('[DynamicToolRegistry] config hot reload failed:', error);
            });
        }, 100);
        if (typeof this._configReloadTimer.unref === 'function') this._configReloadTimer.unref();
    }

    _closeConfigWatchers() {
        for (const watcher of this._configWatchers) {
            try {
                watcher.close();
            } catch {
                // Ignore watcher close failures during reinitialization.
            }
        }
        this._configWatchers = [];
        if (this._configReloadTimer) {
            clearTimeout(this._configReloadTimer);
            this._configReloadTimer = null;
        }
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
        const shouldWrite = !fileConfig || stableStringify(fileConfig) !== stableStringify(configToWrite);
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
            if (env.SmallModel_Model) smallModel.model = env.SmallModel_Model;
            return Object.keys(smallModel).length > 0 ? { smallModel } : {};
        } catch (error) {
            if (error.code !== 'ENOENT') {
                this.lastError = `Failed to read ${path.basename(this.privateConfigPath)}: ${error.message}`;
                if (this.debugMode) console.warn(`[DynamicToolRegistry] ${this.lastError}`);
            }
            return {};
        }
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
module.exports.validateConfigPatch = validateConfigPatch;
