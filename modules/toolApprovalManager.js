const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const toolMarkerFuzzyMatcher = require('./vcpLoop/toolMarkerFuzzyMatcher');

const SILENT_REJECT_SUFFIX = '::SilentReject';

// 参数级规则：ToolName:ParamKey:[pattern]
const PARAM_RULE_REGEX = /^([^:]+?):([^:\[\]]+):\[([\s\S]*)\]$/;

// 虚拟参数键：Path 覆盖所有“路径类”参数；* 覆盖所有参数
const PATH_VIRTUAL_KEY = 'path';
const ANY_ARG_KEY = '*';

// 路径类参数名：filePath/sourcePath/destinationPath/directoryPath/searchPath/downloadDir/cwd... 及其编号变体
const PATH_LIKE_ARG_KEY_REGEX = /(?:path|dir|directory|folder)\d*$|^cwd\d*$/i;

// 命令类参数名：白名单对这些参数额外做命令串联防护
const COMMAND_LIKE_ARG_KEY_REGEX = /^(?:command|cmd|script|shell|code)\d*$/i;

// 白名单防绕过：命令中出现串联/管道/子表达式/重定向/换行等元字符时，白名单一律不生效
const SHELL_CHAIN_META_REGEX = /[;&|`$(){}<>\r\n]/;

// 非路径前缀匹配时，判定“单词仍在延续”的字符（用于 node 不误匹配 nodemon / node-gyp）
const NON_PATH_CONTINUATION_REGEX = /[\p{L}\p{N}_.\-]/u;

// * 通配参数时排除的内部参数
const WILDCARD_EXCLUDED_ARG_KEYS = new Set(['maid']);

const SPECIFICITY_LABELS = {
    0: '全局',
    1: '工具级',
    2: '命令级',
    3: '参数级'
};

function stripWrappingQuotes(value) {
    if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return value.slice(1, -1);
        }
    }
    return value;
}

function normalizePathValue(raw) {
    let value = stripWrappingQuotes(String(raw).trim()).trim();
    if (!value) return '';

    if (/^file:\/\//i.test(value)) {
        value = value.replace(/^file:\/\//i, '');
        try {
            value = decodeURIComponent(value);
        } catch (_) {
            // 保留原值
        }
        if (/^\/[a-zA-Z]:/.test(value)) value = value.slice(1);
    }

    if (/^[a-zA-Z]:$/.test(value)) return value;

    let normalized;
    if (/^[a-zA-Z]:/.test(value) || /^[\\/]{2}/.test(value)) {
        // Windows 盘符 / UNC 路径：使用 win32 规则折叠 ..，防止 C:\safe\..\Windows 绕过
        normalized = path.win32.normalize(value).replace(/\\/g, '/');
    } else {
        normalized = path.posix.normalize(value.replace(/\\/g, '/'));
    }

    if (normalized.length > 1) {
        normalized = normalized.replace(/\/+$/, '') || '/';
    }
    return normalized;
}

function normalizePathPattern(raw) {
    const pattern = String(raw).trim();
    if (!pattern) return '';
    if (pattern.includes('*')) return pattern.replace(/\\/g, '/');
    // 单字母视为盘符：[C] 等价于 [C:]
    if (/^[a-zA-Z]$/.test(pattern)) return `${pattern}:`;
    return normalizePathValue(pattern);
}

function globToRegex(pattern) {
    const escaped = pattern
        .split('*')
        .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[\\s\\S]*');
    return new RegExp(`^${escaped}$`);
}

function flattenStringValues(raw) {
    if (raw === undefined || raw === null) return [];
    if (typeof raw === 'string') return [raw];
    if (typeof raw === 'number' || typeof raw === 'boolean') return [String(raw)];
    if (Array.isArray(raw)) return raw.flatMap(item => flattenStringValues(item));
    return [];
}

class ToolApprovalManager {
    constructor(configPath) {
        this.configPath = configPath;
        this.config = {
            enabled: false,
            timeoutMinutes: 5,
            approveAll: false,
            approvalList: [],
            whitelist: [],
            fuzzyToolMatching: false,
            privacyProtection: {
                enabled: false
            }
        };
        this._ruleCache = {};
        this.watcher = null;
        this.loadConfig();
        this.startWatching();
    }

    loadConfig() {
        try {
            if (fs.existsSync(this.configPath)) {
                const content = fs.readFileSync(this.configPath, 'utf8');
                const loadedConfig = JSON.parse(content);
                this.config = {
                    enabled: Boolean(loadedConfig.enabled),
                    timeoutMinutes: loadedConfig.timeoutMinutes || 5,
                    approveAll: Boolean(loadedConfig.approveAll),
                    approvalList: Array.isArray(loadedConfig.approvalList) ? loadedConfig.approvalList : [],
                    whitelist: Array.isArray(loadedConfig.whitelist) ? loadedConfig.whitelist : [],
                    fuzzyToolMatching: Boolean(loadedConfig.fuzzyToolMatching),
                    debugMode: Boolean(loadedConfig.debugMode),
                    privacyProtection: (loadedConfig.privacyProtection && typeof loadedConfig.privacyProtection === 'object')
                        ? { ...loadedConfig.privacyProtection, enabled: loadedConfig.privacyProtection.enabled === true }
                        : { enabled: false }
                };
                this._ruleCache = {};
                this.applyRuntimeConfig();
                console.log(`[ToolApprovalManager] Configuration loaded from ${this.configPath}`);
                if (this.config.debugMode) {
                    console.log('[ToolApprovalManager] Current Config:', JSON.stringify(this.config, null, 2));
                }
            } else {
                this.applyRuntimeConfig();
                console.warn(`[ToolApprovalManager] Config file not found at ${this.configPath}, using defaults.`);
            }
        } catch (error) {
            console.error(`[ToolApprovalManager] Error loading config: ${error.message}`);
        }
    }

    applyRuntimeConfig() {
        toolMarkerFuzzyMatcher.configure({
            enabled: this.config.fuzzyToolMatching === true,
            debugMode: this.config.debugMode === true
        });

        console.log(
            `[ToolApprovalManager] Fuzzy tool marker matching: ${this.config.fuzzyToolMatching === true ? 'enabled' : 'disabled'}`
        );
    }

    startWatching() {
        if (this.watcher) {
            this.watcher.close();
        }
        this.watcher = chokidar.watch(this.configPath, {
            ignored: [
                '**/node_modules/**',
                '**/.git/**',
                '**/dist/**',
                '**/target/**',
                '**/image/**',
                '**/.*'
            ],
            persistent: true,
            ignoreInitial: true
        });

        this.watcher.on('change', () => {
            console.log(`[ToolApprovalManager] Config file changed, reloading...`);
            this.loadConfig();
        });

        this.watcher.on('error', (error) => {
            console.error(`[ToolApprovalManager] Watcher error: ${error.message}`);
        });
    }

    extractCommands(toolArgs = {}) {
        if (!toolArgs || typeof toolArgs !== 'object') {
            return [];
        }

        const commands = [];

        if (typeof toolArgs.command === 'string' && toolArgs.command.trim()) {
            commands.push(toolArgs.command.trim());
        }

        const numberedCommandKeys = Object.keys(toolArgs)
            .filter(key => /^command\d+$/.test(key))
            .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));

        for (const key of numberedCommandKeys) {
            if (typeof toolArgs[key] === 'string' && toolArgs[key].trim()) {
                commands.push(toolArgs[key].trim());
            }
        }

        return commands;
    }

    parseApprovalRule(entry) {
        if (typeof entry !== 'string') {
            return null;
        }

        const trimmed = entry.trim();
        if (!trimmed) {
            return null;
        }

        const isSilentRule = trimmed.endsWith(SILENT_REJECT_SUFFIX);
        const baseRule = isSilentRule
            ? trimmed.slice(0, -SILENT_REJECT_SUFFIX.length).trim()
            : trimmed;

        if (!baseRule) {
            return null;
        }

        return {
            rawRule: trimmed,
            baseRule,
            notifyAiOnReject: !isSilentRule
        };
    }

    /**
     * 解析规则主体：
     * - ToolName                    → 工具级 (specificity 1)
     * - ToolName:Command            → 命令级，command 精确匹配 (specificity 2，旧语法)
     * - ToolName:ParamKey:[pattern] → 参数级 (specificity 3)
     *   pattern: 默认前缀匹配；`=xxx` 精确匹配；含 `*` 时为通配匹配。均不区分大小写。
     */
    parseRuleDefinition(baseRule) {
        const paramMatch = baseRule.match(PARAM_RULE_REGEX);
        if (paramMatch) {
            const toolName = paramMatch[1].trim();
            const paramKey = paramMatch[2].trim();
            let pattern = paramMatch[3].trim();
            if (!toolName || !paramKey || !pattern) return null;

            let mode = 'prefix';
            if (pattern.startsWith('=')) {
                mode = 'exact';
                pattern = pattern.slice(1).trim();
                if (!pattern) return null;
            } else if (pattern.includes('*')) {
                mode = 'glob';
            }

            return {
                type: 'param',
                toolName,
                paramKey,
                paramKeyLower: paramKey.toLowerCase(),
                pattern,
                mode,
                specificity: 3
            };
        }

        const separatorIndex = baseRule.indexOf(':');
        if (separatorIndex === -1) {
            return { type: 'tool', toolName: baseRule.trim(), specificity: 1 };
        }

        const toolName = baseRule.slice(0, separatorIndex).trim();
        const command = baseRule.slice(separatorIndex + 1).trim();
        if (!toolName || !command) return null;

        return {
            type: 'command',
            toolName,
            paramKey: 'command',
            paramKeyLower: 'command',
            pattern: command,
            mode: 'exact',
            specificity: 2
        };
    }

    _parseRuleList(entries, allowSilent) {
        const rules = [];
        for (const entry of entries) {
            const parsed = this.parseApprovalRule(entry);
            if (!parsed) continue;
            const definition = this.parseRuleDefinition(parsed.baseRule);
            if (!definition) {
                console.warn(`[ToolApprovalManager] 忽略无效规则: ${parsed.rawRule}`);
                continue;
            }
            rules.push({
                ...parsed,
                ...definition,
                notifyAiOnReject: allowSilent ? parsed.notifyAiOnReject : true
            });
        }
        return rules;
    }

    _getParsedRules(listName) {
        const list = Array.isArray(this.config[listName]) ? this.config[listName] : [];
        const signature = list.map(item => String(item)).join('\n');
        const cached = this._ruleCache[listName];
        if (cached && cached.signature === signature) {
            return cached.rules;
        }
        const rules = this._parseRuleList(list, listName === 'approvalList');
        this._ruleCache[listName] = { signature, rules };
        return rules;
    }

    _toolNameMatches(ruleToolName, toolName) {
        return String(ruleToolName).toLowerCase() === String(toolName || '').toLowerCase();
    }

    _argKeyMatches(argKey, ruleKeyLower) {
        const lower = argKey.toLowerCase();
        if (ruleKeyLower === ANY_ARG_KEY) return !WILDCARD_EXCLUDED_ARG_KEYS.has(lower);
        if (ruleKeyLower === PATH_VIRTUAL_KEY) return PATH_LIKE_ARG_KEY_REGEX.test(lower);
        if (lower === ruleKeyLower) return true;
        return lower.startsWith(ruleKeyLower) && /^\d+$/.test(lower.slice(ruleKeyLower.length));
    }

    _collectArgValues(toolArgs, ruleKeyLower) {
        if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) return [];
        const results = [];
        for (const [argKey, raw] of Object.entries(toolArgs)) {
            if (!this._argKeyMatches(argKey, ruleKeyLower)) continue;
            for (const value of flattenStringValues(raw)) {
                const trimmed = value.trim();
                if (trimmed) results.push({ argKey, value: trimmed });
            }
        }
        return results;
    }

    _isPathContext(ruleKeyLower, argKey) {
        return ruleKeyLower === PATH_VIRTUAL_KEY || PATH_LIKE_ARG_KEY_REGEX.test(argKey);
    }

    _matchValue(rawValue, rule, isPath) {
        const value = isPath ? normalizePathValue(rawValue) : String(rawValue).trim();
        const pattern = isPath ? normalizePathPattern(rule.pattern) : String(rule.pattern).trim();
        if (!value || !pattern) return false;

        const valueLower = value.toLowerCase();
        const patternLower = pattern.toLowerCase();

        if (rule.mode === 'exact') return valueLower === patternLower;
        if (rule.mode === 'glob') return globToRegex(patternLower).test(valueLower);

        if (!valueLower.startsWith(patternLower)) return false;
        if (valueLower.length === patternLower.length) return true;

        const lastChar = patternLower[patternLower.length - 1];
        const nextChar = valueLower[patternLower.length];

        if (isPath) {
            // 路径边界：H:/work 不匹配 H:/work-old
            return lastChar === '/' || lastChar === ':' || nextChar === '/';
        }
        // 单词边界：node 不匹配 nodemon / node-gyp / node.exe
        return !NON_PATH_CONTINUATION_REGEX.test(lastChar) || !NON_PATH_CONTINUATION_REGEX.test(nextChar);
    }

    _matchApprovalRule(rule, toolArgs) {
        if (rule.type === 'tool') {
            return { matched: true, matchedValue: null };
        }
        const values = this._collectArgValues(toolArgs, rule.paramKeyLower);
        for (const { argKey, value } of values) {
            if (this._matchValue(value, rule, this._isPathContext(rule.paramKeyLower, argKey))) {
                return { matched: true, matchedValue: value };
            }
        }
        return { matched: false, matchedValue: null };
    }

    /**
     * 白名单匹配：
     * - 工具级白名单直接成立；
     * - 参数/命令级白名单按参数键分组，调用中该键的“全部值”都必须命中同组某条白名单才成立
     *   （防止 command1 白名单 + command2 危险命令的批量绕过）；
     * - 命令类参数若含串联/管道/子表达式等元字符，白名单一律不生效。
     */
    _findWhitelistMatch(toolName, toolArgs) {
        const rules = this._getParsedRules('whitelist').filter(rule => this._toolNameMatches(rule.toolName, toolName));
        if (rules.length === 0) return null;

        let best = null;
        const consider = candidate => {
            if (!best || candidate.specificity > best.specificity) best = candidate;
        };

        const groups = new Map();
        for (const rule of rules) {
            if (rule.type === 'tool') {
                consider({ rawRule: rule.rawRule, specificity: 1 });
                continue;
            }
            if (!groups.has(rule.paramKeyLower)) groups.set(rule.paramKeyLower, []);
            groups.get(rule.paramKeyLower).push(rule);
        }

        for (const [ruleKeyLower, groupRules] of groups) {
            const values = this._collectArgValues(toolArgs, ruleKeyLower);
            if (values.length === 0) continue;

            let satisfied = true;
            let minSpecificity = Infinity;
            const hitRules = new Set();

            for (const { argKey, value } of values) {
                if (COMMAND_LIKE_ARG_KEY_REGEX.test(argKey) && SHELL_CHAIN_META_REGEX.test(value)) {
                    if (this.config.debugMode) {
                        console.log(`[ToolApprovalManager] [${toolName}] 参数 ${argKey} 含命令串联/子表达式元字符，白名单不生效`);
                    }
                    satisfied = false;
                    break;
                }
                const isPath = this._isPathContext(ruleKeyLower, argKey);
                let hit = null;
                for (const rule of groupRules) {
                    if (this._matchValue(value, rule, isPath) && (!hit || rule.specificity > hit.specificity)) {
                        hit = rule;
                    }
                }
                if (!hit) {
                    satisfied = false;
                    break;
                }
                minSpecificity = Math.min(minSpecificity, hit.specificity);
                hitRules.add(hit.rawRule);
            }

            if (satisfied) {
                consider({ rawRule: Array.from(hitRules).join(' + '), specificity: minSpecificity });
            }
        }

        return best;
    }

    getApprovalDecision(toolName, toolArgs = {}) {
        const defaultDecision = {
            requiresApproval: false,
            notifyAiOnReject: true,
            matchedRule: null,
            matchedCommand: null,
            matchedValue: null,
            whitelistedBy: null
        };

        if (!this.config.enabled) {
            return defaultDecision;
        }

        let bestMatch = null;

        if (this.config.approveAll) {
            bestMatch = {
                rawRule: '__APPROVE_ALL__',
                notifyAiOnReject: true,
                specificity: 0,
                type: 'all',
                matchedValue: null
            };
        } else {
            const considerMatch = (rule, matchedValue) => {
                const candidate = { ...rule, matchedValue };
                if (!bestMatch || rule.specificity > bestMatch.specificity) {
                    bestMatch = candidate;
                    return;
                }
                if (
                    rule.specificity === bestMatch.specificity &&
                    rule.notifyAiOnReject === false &&
                    bestMatch.notifyAiOnReject !== false
                ) {
                    bestMatch = candidate;
                }
            };

            for (const rule of this._getParsedRules('approvalList')) {
                if (!this._toolNameMatches(rule.toolName, toolName)) continue;
                const result = this._matchApprovalRule(rule, toolArgs);
                if (result.matched) considerMatch(rule, result.matchedValue);
            }
        }

        if (!bestMatch) {
            if (this.config.debugMode) {
                const commands = this.extractCommands(toolArgs);
                const commandInfo = commands.length > 0 ? `，commands=${JSON.stringify(commands)}` : '';
                console.log(`[ToolApprovalManager] [${toolName}] 不需要审核${commandInfo}`);
            }
            return defaultDecision;
        }

        // 白名单：具体程度不低于命中的审核规则时豁免（同级时白名单优先）
        const whitelistMatch = this._findWhitelistMatch(toolName, toolArgs);
        if (whitelistMatch && whitelistMatch.specificity >= bestMatch.specificity) {
            console.log(
                `[ToolApprovalManager] ✅ [${toolName}] 命中${SPECIFICITY_LABELS[whitelistMatch.specificity]}白名单 [${whitelistMatch.rawRule}]，豁免审核规则 [${bestMatch.rawRule}]`
            );
            return {
                ...defaultDecision,
                whitelistedBy: whitelistMatch.rawRule,
                overriddenRule: bestMatch.rawRule
            };
        }

        if (bestMatch.type === 'all') {
            console.log(`[ToolApprovalManager] 🛡️ [${toolName}] 所有工具均需审核 (approveAll=true)`);
        } else {
            const silentTag = bestMatch.notifyAiOnReject === false ? '，拒绝时不提示AI' : '';
            const valueTag = bestMatch.matchedValue ? `，命中值: ${String(bestMatch.matchedValue).substring(0, 120)}` : '';
            console.log(
                `[ToolApprovalManager] 🛡️ [${toolName}] 命中${SPECIFICITY_LABELS[bestMatch.specificity]}审核规则 [${bestMatch.rawRule}]${valueTag}，准备发送请求${silentTag}`
            );
        }

        const isCommandMatch = bestMatch.type === 'command' ||
            (bestMatch.type === 'param' && bestMatch.paramKeyLower === 'command');

        return {
            requiresApproval: true,
            notifyAiOnReject: bestMatch.notifyAiOnReject,
            matchedRule: bestMatch.rawRule,
            matchedCommand: isCommandMatch ? (bestMatch.matchedValue || null) : null,
            matchedValue: bestMatch.matchedValue || null,
            whitelistedBy: null
        };
    }

    shouldApprove(toolName, toolArgs = {}) {
        return this.getApprovalDecision(toolName, toolArgs).requiresApproval;
    }

    getTimeoutMs() {
        return (this.config.timeoutMinutes || 5) * 60 * 1000;
    }

    getPrivacyProtectionConfig() {
        return this.config.privacyProtection || { enabled: false };
    }

    shutdown() {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
    }
}

ToolApprovalManager.normalizePathValue = normalizePathValue;

module.exports = ToolApprovalManager;
