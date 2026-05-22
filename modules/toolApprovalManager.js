const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const {
    getAliasesForCanonical,
    resolveToolIdentity
} = require('./toolIdentityResolver');

class ToolApprovalManager {
    constructor(configPath) {
        this.configPath = configPath;
        this.config = {
            enabled: false,
            timeoutMinutes: 5,
            approveAll: false,
            approvalList: []
        };
        this.watcher = null;
        this.loadConfig();
        this.startWatching();
    }

    loadConfig() {
        try {
            if (fs.existsSync(this.configPath)) {
                const content = fs.readFileSync(this.configPath, 'utf8');
                this.config = JSON.parse(content);
                console.log(`[ToolApprovalManager] Configuration loaded from ${this.configPath}`);
                if (this.config.debugMode) {
                    console.log('[ToolApprovalManager] Current Config:', JSON.stringify(this.config, null, 2));
                }
            } else {
                console.warn(`[ToolApprovalManager] Config file not found at ${this.configPath}, using defaults.`);
            }
        } catch (error) {
            console.error(`[ToolApprovalManager] Error loading config: ${error.message}`);
        }
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

        const silentSuffix = '::SilentReject';
        const isSilentRule = trimmed.endsWith(silentSuffix);
        const baseRule = isSilentRule
            ? trimmed.slice(0, -silentSuffix.length).trim()
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

    getApprovalMatchToolNames(identity) {
        const names = [
            identity.requestedToolName,
            identity.canonicalToolName,
            ...getAliasesForCanonical(identity.canonicalToolName),
            ...(Array.isArray(identity.aliases) ? identity.aliases : [])
        ];

        return [...new Set(names.filter(Boolean))];
    }

    getApprovalDecision(toolName, toolArgs = {}, options = {}) {
        const pluginRegistry = options && typeof options.has === 'function'
            ? options
            : options.pluginRegistry;
        const identity = resolveToolIdentity({
            requestedToolName: toolName,
            toolArgs,
            pluginRegistry
        });

        const defaultDecision = {
            requiresApproval: false,
            notifyAiOnReject: true,
            matchedRule: null,
            matchedCommand: null,
            requestedToolName: identity.requestedToolName,
            canonicalToolName: identity.canonicalToolName,
            wasAlias: identity.wasAlias
        };

        if (!this.config.enabled) {
            return defaultDecision;
        }

        if (this.config.approveAll) {
            console.log(`[ToolApprovalManager] 🛡️ [${toolName}] 所有工具均需审核 (approveAll=true)`);
            return {
                requiresApproval: true,
                notifyAiOnReject: true,
                matchedRule: '__APPROVE_ALL__',
                matchedCommand: null,
                requestedToolName: identity.requestedToolName,
                canonicalToolName: identity.canonicalToolName,
                wasAlias: identity.wasAlias
            };
        }

        const approvalList = Array.isArray(this.config.approvalList) ? this.config.approvalList : [];
        const parsedRules = approvalList
            .map(entry => this.parseApprovalRule(entry))
            .filter(Boolean);

        const commands = this.extractCommands(toolArgs);
        const matchToolNames = this.getApprovalMatchToolNames(identity);
        let bestMatch = null;

        const considerMatch = (rule, specificity, matchedCommand = null) => {
            if (!bestMatch) {
                bestMatch = { ...rule, specificity, matchedCommand };
                return;
            }

            if (specificity > bestMatch.specificity) {
                bestMatch = { ...rule, specificity, matchedCommand };
                return;
            }

            if (
                specificity === bestMatch.specificity &&
                rule.notifyAiOnReject === false &&
                bestMatch.notifyAiOnReject !== false
            ) {
                bestMatch = { ...rule, specificity, matchedCommand };
            }
        };

        for (const rule of parsedRules) {
            for (const matchToolName of matchToolNames) {
                if (rule.baseRule === matchToolName) {
                    considerMatch(rule, 1, null);
                }

                for (const command of commands) {
                    const commandRule = `${matchToolName}:${command}`;
                    if (rule.baseRule === commandRule) {
                        considerMatch(rule, 2, command);
                    }
                }
            }
        }

        if (bestMatch) {
            const scope = bestMatch.specificity === 2 ? '命令级' : '工具级';
            const silentTag = bestMatch.notifyAiOnReject === false ? '，拒绝时不提示AI' : '';
            console.log(`[ToolApprovalManager] 🛡️ [${toolName}] 命中${scope}审核规则 [${bestMatch.rawRule}]，准备发送请求${silentTag}`);
            return {
                requiresApproval: true,
                notifyAiOnReject: bestMatch.notifyAiOnReject,
                matchedRule: bestMatch.rawRule,
                matchedCommand: bestMatch.matchedCommand || null,
                requestedToolName: identity.requestedToolName,
                canonicalToolName: identity.canonicalToolName,
                wasAlias: identity.wasAlias
            };
        }

        if (this.config.debugMode) {
            const commandInfo = commands.length > 0 ? `，commands=${JSON.stringify(commands)}` : '';
            console.log(`[ToolApprovalManager] [${toolName}] 不需要审核${commandInfo}`);
        }

        return defaultDecision;
    }

    shouldApprove(toolName, toolArgs = {}, options = {}) {
        return this.getApprovalDecision(toolName, toolArgs, options).requiresApproval;
    }

    getTimeoutMs() {
        return (this.config.timeoutMinutes || 5) * 60 * 1000;
    }

    shutdown() {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
    }
}

module.exports = ToolApprovalManager;
