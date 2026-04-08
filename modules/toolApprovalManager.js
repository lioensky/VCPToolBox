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

    shouldApprove(toolName) {
        if (!this.config.enabled) {
            return false;
        }

        if (this.config.approveAll) {
            console.log(`[ToolApprovalManager] 🛡️ [${toolName}] 所有工具均需审核 (approveAll=true)`);
            return true;
        }

        const isMatch = Array.isArray(this.config.approvalList) && this.config.approvalList.includes(toolName);
        if (isMatch) {
            console.log(`[ToolApprovalManager] 🛡️ [${toolName}] 在审核名单中，准备发送请求`);
        } else {
            if (this.config.debugMode) console.log(`[ToolApprovalManager] [${toolName}] 不需要审核`);
        }
        return isMatch;
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
