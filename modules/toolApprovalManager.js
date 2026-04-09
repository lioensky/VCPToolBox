const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

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

    shouldApprove(toolName, toolArgs = {}) {
        if (!this.config.enabled) {
            return false;
        }

        if (this.config.approveAll) {
            console.log(`[ToolApprovalManager] 🛡️ [${toolName}] 所有工具均需审核 (approveAll=true)`);
            return true;
        }

        const approvalList = Array.isArray(this.config.approvalList) ? this.config.approvalList : [];
        const matchedToolRule = approvalList.includes(toolName);
        if (matchedToolRule) {
            console.log(`[ToolApprovalManager] 🛡️ [${toolName}] 命中工具级审核规则，准备发送请求`);
            return true;
        }

        const commands = this.extractCommands(toolArgs);
        for (const command of commands) {
            const commandRule = `${toolName}:${command}`;
            if (approvalList.includes(commandRule)) {
                console.log(`[ToolApprovalManager] 🛡️ [${toolName}] 命中命令级审核规则 [${commandRule}]，准备发送请求`);
                return true;
            }
        }

        if (this.config.debugMode) {
            const commandInfo = commands.length > 0 ? `，commands=${JSON.stringify(commands)}` : '';
            console.log(`[ToolApprovalManager] [${toolName}] 不需要审核${commandInfo}`);
        }
        return false;
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
