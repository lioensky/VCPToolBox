// Plugin/VCPToolBridge/index.js
const path = require('path');

class VCPToolBridge {
    constructor() {
        this.pluginManager = null;
        this.wss = null;
        this.config = {};
        this.debugMode = false;
        this.isHooked = false;
        this.taskToClientMap = new Map(); // taskId -> serverId
    }

    /**
     * 初始化插件，接收 PluginManager 注入
     */
    async initialize(config, dependencies) {
        this.config = config;
        this.debugMode = config.DebugMode === true;
        this.log = dependencies.vcpLogFunctions || { pushVcpLog: () => { }, pushVcpInfo: () => { } };

        // 拿到核心 PluginManager 实例
        try {
            this.pluginManager = require('../../Plugin.js');
            this.setupEventListeners();
        } catch (e) {
            console.error('[VCPToolBridge] Failed to load PluginManager for event listening:', e.message);
        }

        if (this.debugMode) console.log('[VCPToolBridge] Initialized with Event Listeners.');
    }

    /**
     * 设置核心事件监听
     */
    setupEventListeners() {
        if (!this.pluginManager) return;

        // 1. 监听进度日志 (vcp_log / vcp_info)
        const forwardLog = (type, data) => {
            if (this.config.Bridge_Enabled === false) return;
            
            const taskId = data.job_id || data.taskId;
            const serverId = this.taskToClientMap.get(taskId);
            
            if (serverId && this.wss) {
                if (this.debugMode) console.log(`[VCPToolBridge] 📡 Forwarding ${type} for task ${taskId} to ${serverId}`);
                this.wss.sendMessageToClient(serverId.replace('dist-', ''), {
                    type: 'vcp_tool_status',
                    data: {
                        ...data,
                        bridgeType: type
                    }
                });
            }
        };

        this.pluginManager.on('vcp_log', (data) => forwardLog('log', data));
        this.pluginManager.on('vcp_info', (data) => forwardLog('info', data));

        // 2. 监听异步回调结果 (plugin_async_callback)
        this.pluginManager.on('plugin_async_callback', (info) => {
            if (this.config.Bridge_Enabled === false) return;

            const { taskId, data } = info;
            const serverId = this.taskToClientMap.get(taskId);

            if (serverId && this.wss) {
                if (this.debugMode) console.log(`[VCPToolBridge] ✅ Forwarding async result for task ${taskId} to ${serverId}`);
                this.wss.sendMessageToClient(serverId.replace('dist-', ''), {
                    type: 'vcp_tool_result',
                    data: {
                        requestId: taskId, // 对应 AIO 的请求 ID
                        status: 'success',
                        result: data
                    }
                });
                
                // 任务完成，清理映射
                this.taskToClientMap.delete(taskId);
            }
        });
    }

    /**
     * 注册 API 路由，这是拿到 WebSocketServer 实例的最佳时机
     */
    registerApiRoutes(router, config, projectBasePath, wss) {
        this.wss = wss;
        this.config = { ...this.config, ...config }; // 合并配置

        if (!this.wss) {
            console.error('[VCPToolBridge] WebSocketServer instance is missing in registerApiRoutes.');
            return;
        }

        // 核心：执行 Monkey Patch
        this.applyMonkeyPatch();

        // 提供一个简单的状态查询接口
        router.get('/status', (req, res) => {
            res.json({
                status: 'active',
                hooked: this.isHooked,
                bridgeEnabled: this.config.Bridge_Enabled !== false
            });
        });

        if (this.debugMode) console.log('[VCPToolBridge] API routes registered and Monkey Patch applied.');
    }

    /**
     * 劫持 WebSocketServer 的消息处理逻辑
     */
    applyMonkeyPatch() {
        if (this.isHooked) return;

        const self = this;
        const wss = this.wss;

        // 1. 尝试获取 PluginManager 的引用
        let pluginManager;
        try {
            pluginManager = require('../../Plugin.js');
        } catch (e) {
            console.error('[VCPToolBridge] Error requiring Plugin.js:', e.message);
        }

        if (!pluginManager) {
            console.error('[VCPToolBridge] Could not obtain PluginManager instance.');
            return;
        }

        // 2. 劫持 handleDistributedServerMessage
        const originalHandler = wss.handleDistributedServerMessage;

        if (typeof originalHandler !== 'function') {
            console.error('[VCPToolBridge] WebSocketServer.handleDistributedServerMessage is not a function. Hook failed.');
            return;
        }

        // 替换原始处理器
        wss.handleDistributedServerMessage = async function (serverId, message) {
            if (self.config.Bridge_Enabled === false) {
                return originalHandler.call(wss, serverId, message);
            }

            try {
                if (self.debugMode) console.log(`[VCPToolBridge] Intercepted message type: ${message.type} from ${serverId}`);

                switch (message.type) {
                    case 'get_vcp_manifests':
                        await self.handleGetManifests(serverId, message, pluginManager);
                        return; // 拦截

                    case 'execute_vcp_tool':
                        await self.handleExecuteTool(serverId, message, pluginManager);
                        return; // 拦截
                }
            } catch (err) {
                console.error(`[VCPToolBridge] Error handling bridged message ${message.type}:`, err);
            }

            return originalHandler.call(wss, serverId, message);
        };

        this.isHooked = true;
        console.log('[VCPToolBridge] 🛡️ Monkey Patch successful: VCP Tool Bridge is now active.');
    }

    /**
     * 处理清单同步请求
     */
    async handleGetManifests(serverId, message, pluginManager) {
        const requestId = message.data?.requestId;
        if (this.debugMode) console.log(`[VCPToolBridge] 📤 Exporting manifests to server: ${serverId} (Req: ${requestId})`);

        const excludedTools = (this.config.Excluded_Tools || "").split(',').map(t => t.trim()).filter(Boolean);
        const excludedKeywords = (this.config.Excluded_Display_Keywords || "")
            .split(',')
            .map(t => t.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
        const exportablePlugins = [];

        for (const [name, plugin] of pluginManager.plugins.entries()) {
            if (excludedTools.includes(name)) continue;
            if (plugin.isDistributed) continue;
            if (plugin.displayName && excludedKeywords.some(kw => plugin.displayName.includes(kw))) continue;

            if (plugin.capabilities && plugin.capabilities.invocationCommands && plugin.capabilities.invocationCommands.length > 0) {
                exportablePlugins.push({
                    name: plugin.name,
                    displayName: plugin.displayName || plugin.name,
                    description: plugin.description || "",
                    capabilities: {
                        invocationCommands: plugin.capabilities.invocationCommands
                    }
                });
            }
        }

        this.wss.sendMessageToClient(serverId.replace('dist-', ''), {
            type: 'vcp_manifest_response',
            data: {
                requestId,
                plugins: exportablePlugins,
                vcpVersion: '1.0.0'
            }
        });
    }

    /**
     * 处理远程执行请求
     */
    async handleExecuteTool(serverId, message, pluginManager) {
        const { requestId, toolName, toolArgs } = message.data;
        if (this.debugMode) console.log(`[VCPToolBridge] ⚡ Executing bridged tool: ${toolName} (Req: ${requestId})`);

        try {
            const result = await pluginManager.processToolCall(toolName, toolArgs);

            // 如果是异步任务（返回了 taskId），记录映射关系
            // 这样当 vcp_log 或 plugin_async_callback 事件触发时，我们知道发回给谁
            if (result && result.taskId) {
                if (this.debugMode) console.log(`[VCPToolBridge] 📝 Registered async task mapping: ${result.taskId} -> ${serverId}`);
                this.taskToClientMap.set(result.taskId, serverId);
            }

            this.wss.sendMessageToClient(serverId.replace('dist-', ''), {
                type: 'vcp_tool_result',
                data: {
                    requestId,
                    status: 'success',
                    result: result
                }
            });
        } catch (error) {
            let errorMsg = error.message;
            try {
                const parsed = JSON.parse(error.message);
                errorMsg = parsed.plugin_error || parsed.plugin_execution_error || error.message;
            } catch (e) { }

            this.wss.sendMessageToClient(serverId.replace('dist-', ''), {
                type: 'vcp_tool_result',
                data: {
                    requestId,
                    status: 'error',
                    error: errorMsg
                }
            });
        }
    }

    /**
     * 实现 VCP 工具调用接口 (GetStatus)
     */
    async processToolCall(args) {
        if (args.command === 'GetStatus') {
            return {
                status: 'running',
                hooked: this.isHooked,
                config: this.config
            };
        }
        throw new Error(`Unknown command: ${args.command}`);
    }

    /**
     * 插件关闭时清理
     */
    shutdown() {
        if (this.debugMode) console.log('[VCPToolBridge] Shutting down...');
    }
}

module.exports = new VCPToolBridge();