// Plugin.js
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const schedule = require('node-schedule');
const dotenv = require('dotenv'); // Ensures dotenv is available
const FileFetcherServer = require('./FileFetcherServer.js');
const express = require('express'); // For plugin API routing
const chokidar = require('chokidar');
const { getAuthCode } = require('./modules/captchaDecoder'); // 导入统一的解码函数
const { VectorDBManager } = require('./VectorDBManager.js');

const PLUGIN_DIR = path.join(__dirname, 'Plugin');
const manifestFileName = 'plugin-manifest.json';
const PREPROCESSOR_ORDER_FILE = path.join(__dirname, 'preprocessor_order.json');

class PluginManager {
    constructor() {
        this.plugins = new Map(); // 存储所有插件（本地和分布式）
        this.staticPlaceholderValues = new Map();
        this.scheduledJobs = new Map();
        this.messagePreprocessors = new Map();
        this.preprocessorOrder = []; // 新增：用于存储预处理器的最终加载顺序
        this.serviceModules = new Map();
        this.projectBasePath = null;
        this.individualPluginDescriptions = new Map(); // New map for individual descriptions
        this.debugMode = (process.env.DebugMode || "False").toLowerCase() === "true";
        this.webSocketServer = null; // 为 WebSocketServer 实例占位
        this.isReloading = false;
        this.reloadTimeout = null;
        this.vectorDBManager = new VectorDBManager();
    }

    setWebSocketServer(wss) {
        this.webSocketServer = wss;
        if (this.debugMode) console.log('[PluginManager] WebSocketServer instance has been set.');
    }

    async _getDecryptedAuthCode() {
        try {
            const authCodePath = path.join(__dirname, 'Plugin', 'UserAuth', 'code.bin');
            // 使用正确的 getAuthCode 函数，并传递文件路径
            return await getAuthCode(authCodePath);
        } catch (error) {
            if (this.debugMode) {
                console.error('[PluginManager] Failed to read or decrypt auth code for plugin execution:', error.message);
            }
            return null; // Return null if code cannot be obtained
        }
    }

    setProjectBasePath(basePath) {
        this.projectBasePath = basePath;
        if (this.debugMode) console.log(`[PluginManager] Project base path set to: ${this.projectBasePath}`);
    }

    _getPluginConfig(pluginManifest) {
        const config = {};
        const globalEnv = process.env; 
        const pluginSpecificEnv = pluginManifest.pluginSpecificEnvConfig || {}; 

        if (pluginManifest.configSchema) {
            for (const key in pluginManifest.configSchema) {
                const expectedType = pluginManifest.configSchema[key];
                let rawValue;

                if (pluginSpecificEnv.hasOwnProperty(key)) { 
                    rawValue = pluginSpecificEnv[key];
                } else if (globalEnv.hasOwnProperty(key)) { 
                    rawValue = globalEnv[key];
                } else {
                    continue; 
                }

                let value = rawValue;
                if (expectedType === 'integer') {
                    value = parseInt(value, 10);
                    if (isNaN(value)) {
                       if (this.debugMode) console.warn(`[PluginManager] Config key '${key}' for ${pluginManifest.name} expected integer, got NaN from raw value '${rawValue}'. Using undefined.`);
                       value = undefined;
                    }
                } else if (expectedType === 'boolean') {
                    value = String(value).toLowerCase() === 'true';
                }
                config[key] = value;
            }
        }

        if (pluginSpecificEnv.hasOwnProperty('DebugMode')) {
            config.DebugMode = String(pluginSpecificEnv.DebugMode).toLowerCase() === 'true';
        } else if (globalEnv.hasOwnProperty('DebugMode')) {
            config.DebugMode = String(globalEnv.DebugMode).toLowerCase() === 'true';
        } else if (!config.hasOwnProperty('DebugMode')) { 
            config.DebugMode = false; 
        }
        return config;
    }

    getResolvedPluginConfigValue(pluginName, configKey) {
        const pluginManifest = this.plugins.get(pluginName);
        if (!pluginManifest) {
            return undefined;
        }
        const effectiveConfig = this._getPluginConfig(pluginManifest); 
        return effectiveConfig ? effectiveConfig[configKey] : undefined;
    }

    async _executeStaticPluginCommand(plugin) {
        if (!plugin || plugin.pluginType !== 'static' || !plugin.entryPoint || !plugin.entryPoint.command) {
            console.error(`[PluginManager] Invalid static plugin or command for execution: ${plugin ? plugin.name : 'Unknown'}`);
            return Promise.reject(new Error(`Invalid static plugin or command for ${plugin ? plugin.name : 'Unknown'}`));
        }

        return new Promise((resolve, reject) => {
            const pluginConfig = this._getPluginConfig(plugin); 
            const envForProcess = { ...process.env }; 
            for (const key in pluginConfig) {
                if (pluginConfig.hasOwnProperty(key) && pluginConfig[key] !== undefined) {
                    envForProcess[key] = String(pluginConfig[key]);
                }
            }
            if (this.projectBasePath) { // Add projectBasePath for static plugins too if needed
                envForProcess.PROJECT_BASE_PATH = this.projectBasePath;
            }


            const [command, ...args] = plugin.entryPoint.command.split(' ');
            const pluginProcess = spawn(command, args, { cwd: plugin.basePath, shell: true, env: envForProcess, windowsHide: true });
            let output = '';
            let errorOutput = '';
            let processExited = false;
            const timeoutDuration = plugin.communication?.timeout || 30000;

            const timeoutId = setTimeout(() => {
                if (!processExited) {
                    console.error(`[PluginManager] Static plugin "${plugin.name}" execution timed out after ${timeoutDuration}ms.`); // Keep error
                    pluginProcess.kill('SIGKILL');
                    reject(new Error(`Static plugin "${plugin.name}" execution timed out.`));
                }
            }, timeoutDuration);

            pluginProcess.stdout.on('data', (data) => { output += data.toString(); });
            pluginProcess.stderr.on('data', (data) => { errorOutput += data.toString(); });

            pluginProcess.on('error', (err) => {
                processExited = true;
                clearTimeout(timeoutId);
                console.error(`[PluginManager] Failed to start static plugin ${plugin.name}: ${err.message}`);
                reject(err);
            });
            
            pluginProcess.on('exit', (code, signal) => {
                processExited = true;
                clearTimeout(timeoutId);
                if (signal === 'SIGKILL') { 
                    return;
                }
                if (code !== 0) {
                    const errMsg = `Static plugin ${plugin.name} exited with code ${code}. Stderr: ${errorOutput.trim()}`;
                    console.error(`[PluginManager] ${errMsg}`);
                    reject(new Error(errMsg));
                } else {
                    if (errorOutput.trim() && this.debugMode) {
                        console.warn(`[PluginManager] Static plugin ${plugin.name} produced stderr output: ${errorOutput.trim()}`);
                    }
                    resolve(output.trim());
                }
            });
        });
    }

    async _updateStaticPluginValue(plugin) {
        let newValue = null;
        let executionError = null;
        try {
            if (this.debugMode) console.log(`[PluginManager] Updating static plugin: ${plugin.name}`);
            newValue = await this._executeStaticPluginCommand(plugin);
        } catch (error) {
            console.error(`[PluginManager] Error executing static plugin ${plugin.name} script:`, error.message);
            executionError = error;
        }

        if (plugin.capabilities && plugin.capabilities.systemPromptPlaceholders) {
            plugin.capabilities.systemPromptPlaceholders.forEach(ph => {
                const placeholderKey = ph.placeholder;
                const currentValueEntry = this.staticPlaceholderValues.get(placeholderKey);
                const currentValue = currentValueEntry ? currentValueEntry.value : undefined;

                if (newValue !== null && newValue.trim() !== "") {
                    this.staticPlaceholderValues.set(placeholderKey, { value: newValue.trim(), serverId: 'local' });
                    if (this.debugMode) console.log(`[PluginManager] Placeholder ${placeholderKey} for ${plugin.name} updated with value: "${(newValue.trim()).substring(0,70)}..."`);
                } else if (executionError) {
                    const errorMessage = `[Error updating ${plugin.name}: ${executionError.message.substring(0,100)}...]`;
                    if (!currentValue || (currentValue && currentValue.startsWith("[Error"))) {
                        this.staticPlaceholderValues.set(placeholderKey, { value: errorMessage, serverId: 'local' });
                        if (this.debugMode) console.warn(`[PluginManager] Placeholder ${placeholderKey} for ${plugin.name} set to error state: ${errorMessage}`);
                    } else {
                        if (this.debugMode) console.warn(`[PluginManager] Placeholder ${placeholderKey} for ${plugin.name} failed to update. Keeping stale value: "${(currentValue || "").substring(0,70)}..."`);
                    }
                } else {
                    if (this.debugMode) console.warn(`[PluginManager] Static plugin ${plugin.name} produced no new output for ${placeholderKey}. Keeping stale value (if any).`);
                    if (!currentValueEntry) {
                        this.staticPlaceholderValues.set(placeholderKey, { value: `[${plugin.name} data currently unavailable]`, serverId: 'local' });
                        if (this.debugMode) console.log(`[PluginManager] Placeholder ${placeholderKey} for ${plugin.name} set to 'unavailable'.`);
                    }
                }
            });
        }
    }

    async initializeStaticPlugins() {
        console.log('[PluginManager] Initializing static plugins...');
        for (const plugin of this.plugins.values()) {
            if (plugin.pluginType === 'static') {
                // Immediately set a "loading" state for the placeholder.
                if (plugin.capabilities && plugin.capabilities.systemPromptPlaceholders) {
                    plugin.capabilities.systemPromptPlaceholders.forEach(ph => {
                        this.staticPlaceholderValues.set(ph.placeholder, { value: `[${plugin.displayName} a-zheng-zai-jia-zai-zhong... ]`, serverId: 'local' });
                    });
                }

                // Trigger the first update in the background (fire and forget).
                this._updateStaticPluginValue(plugin).catch(err => {
                    console.error(`[PluginManager] Initial background update for ${plugin.name} failed: ${err.message}`);
                });

                // Set up the scheduled recurring updates.
                if (plugin.refreshIntervalCron) {
                    if (this.scheduledJobs.has(plugin.name)) {
                        this.scheduledJobs.get(plugin.name).cancel();
                    }
                    try {
                        const job = schedule.scheduleJob(plugin.refreshIntervalCron, () => {
                            if (this.debugMode) console.log(`[PluginManager] Scheduled update for static plugin: ${plugin.name}`);
                            this._updateStaticPluginValue(plugin).catch(err => {
                                 console.error(`[PluginManager] Scheduled background update for ${plugin.name} failed: ${err.message}`);
                            });
                        });
                        this.scheduledJobs.set(plugin.name, job);
                        if (this.debugMode) console.log(`[PluginManager] Scheduled ${plugin.name} with cron: ${plugin.refreshIntervalCron}`);
                    } catch (e) {
                        console.error(`[PluginManager] Invalid cron string for ${plugin.name}: ${plugin.refreshIntervalCron}. Error: ${e.message}`);
                    }
                }
            }
        }
        console.log('[PluginManager] Static plugins initialization process has been started (updates will run in the background).');
    }
    async prewarmPythonPlugins() {
        console.log('[PluginManager] Checking for Python plugins to pre-warm...');
        if (this.plugins.has('SciCalculator')) {
            console.log('[PluginManager] SciCalculator found. Starting pre-warming of Python scientific libraries in the background.');
            try {
                const command = 'python';
                const args = ['-c', 'import sympy, scipy.stats, scipy.integrate, numpy'];
                const prewarmProcess = spawn(command, args, {
                    // 移除 shell: true
                    windowsHide: true
                });

                prewarmProcess.on('error', (err) => {
                    console.warn(`[PluginManager] Python pre-warming process failed to start. Is Python installed and in the system's PATH? Error: ${err.message}`);
                });

                prewarmProcess.stderr.on('data', (data) => {
                    console.warn(`[PluginManager] Python pre-warming process stderr: ${data.toString().trim()}`);
                });

                prewarmProcess.on('exit', (code) => {
                    if (code === 0) {
                        console.log('[PluginManager] Python scientific libraries pre-warmed successfully.');
                    } else {
                        console.warn(`[PluginManager] Python pre-warming process exited with code ${code}. Please ensure required libraries are installed (pip install sympy scipy numpy).`);
                    }
                });
            } catch (e) {
                console.error(`[PluginManager] An exception occurred while spawning the Python pre-warming process: ${e.message}`);
            }
        } else {
            if (this.debugMode) console.log('[PluginManager] SciCalculator not found, skipping Python pre-warming.');
        }
    }
    
    
    getPlaceholderValue(placeholder) {
        const entry = this.staticPlaceholderValues.get(placeholder);
        return entry ? entry.value : `[Placeholder ${placeholder} not found]`;
    }

    async executeMessagePreprocessor(pluginName, messages) {
        const processorModule = this.messagePreprocessors.get(pluginName);
        const pluginManifest = this.plugins.get(pluginName);
        if (!processorModule || !pluginManifest) {
            console.error(`[PluginManager] Message preprocessor plugin "${pluginName}" not found.`);
            return messages;
        }
        if (typeof processorModule.processMessages !== 'function') {
            console.error(`[PluginManager] Plugin "${pluginName}" does not have 'processMessages' function.`);
            return messages;
        }
        try {
            if (this.debugMode) console.log(`[PluginManager] Executing message preprocessor: ${pluginName}`);
            const pluginSpecificConfig = this._getPluginConfig(pluginManifest);
            const processedMessages = await processorModule.processMessages(messages, pluginSpecificConfig);
            if (this.debugMode) console.log(`[PluginManager] Message preprocessor ${pluginName} finished.`);
            return processedMessages;
        } catch (error) {
            console.error(`[PluginManager] Error in message preprocessor ${pluginName}:`, error);
            return messages;
        }
    }
    
    async shutdownAllPlugins() {
        console.log('[PluginManager] Shutting down all plugins...'); // Keep

        // --- Shutdown VectorDBManager first to stop background processing ---
        if (this.vectorDBManager && typeof this.vectorDBManager.shutdown === 'function') {
            try {
                if (this.debugMode) console.log('[PluginManager] Calling shutdown for VectorDBManager...');
                await this.vectorDBManager.shutdown();
            } catch (error) {
                console.error('[PluginManager] Error during shutdown of VectorDBManager:', error);
            }
        }

        for (const [name, pluginModuleData] of this.messagePreprocessors) {
             const pluginModule = pluginModuleData.module || pluginModuleData;
            if (pluginModule && typeof pluginModule.shutdown === 'function') {
                try {
                    if (this.debugMode) console.log(`[PluginManager] Calling shutdown for ${name}...`);
                    await pluginModule.shutdown();
                } catch (error) {
                    console.error(`[PluginManager] Error during shutdown of plugin ${name}:`, error); // Keep error
                }
            }
        }
        for (const [name, serviceData] of this.serviceModules) {
            if (serviceData.module && typeof serviceData.module.shutdown === 'function') {
                try {
                    if (this.debugMode) console.log(`[PluginManager] Calling shutdown for service plugin ${name}...`);
                    await serviceData.module.shutdown();
                } catch (error) {
                    console.error(`[PluginManager] Error during shutdown of service plugin ${name}:`, error); // Keep error
                }
            }
        }
        for (const job of this.scheduledJobs.values()) {
            job.cancel();
        }
        this.scheduledJobs.clear();
        console.log('[PluginManager] All plugin shutdown processes initiated and scheduled jobs cancelled.'); // Keep
    }

    async loadPlugins() {
        console.log('[PluginManager] Starting plugin discovery...');
        // 1. 清理现有插件状态
        const localPlugins = new Map();
        for (const [name, manifest] of this.plugins.entries()) {
            if (!manifest.isDistributed) {
                localPlugins.set(name, manifest);
            }
        }
        this.plugins = localPlugins;
        this.messagePreprocessors.clear();
        this.staticPlaceholderValues.clear();
        this.serviceModules.clear();

        const discoveredPreprocessors = new Map();
        const modulesToInitialize = [];

        try {
            // 2. 发现并加载所有插件模块，但不初始化
            const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
            for (const folder of pluginFolders) {
                if (folder.isDirectory()) {
                    const pluginPath = path.join(PLUGIN_DIR, folder.name);
                    const manifestPath = path.join(pluginPath, manifestFileName);
                    try {
                        const manifestContent = await fs.readFile(manifestPath, 'utf-8');
                        const manifest = JSON.parse(manifestContent);
                        if (!manifest.name || !manifest.pluginType || !manifest.entryPoint) continue;
                        if (this.plugins.has(manifest.name)) continue;
                        
                        manifest.basePath = pluginPath;
                        manifest.pluginSpecificEnvConfig = {};
                        try {
                            const pluginEnvContent = await fs.readFile(path.join(pluginPath, 'config.env'), 'utf-8');
                            manifest.pluginSpecificEnvConfig = dotenv.parse(pluginEnvContent);
                        } catch (envError) {
                            if (envError.code !== 'ENOENT') console.warn(`[PluginManager] Error reading config.env for ${manifest.name}:`, envError.message);
                        }

                        this.plugins.set(manifest.name, manifest);
                        console.log(`[PluginManager] Loaded manifest: ${manifest.displayName} (${manifest.name}, Type: ${manifest.pluginType})`);

                        const isPreprocessor = manifest.pluginType === 'messagePreprocessor' || manifest.pluginType === 'hybridservice';
                        const isService = manifest.pluginType === 'service' || manifest.pluginType === 'hybridservice';

                        if ((isPreprocessor || isService) && manifest.entryPoint.script && manifest.communication?.protocol === 'direct') {
                            try {
                                const scriptPath = path.join(pluginPath, manifest.entryPoint.script);
                                const module = require(scriptPath);
                                
                                modulesToInitialize.push({ manifest, module });

                                if (isPreprocessor && typeof module.processMessages === 'function') {
                                    discoveredPreprocessors.set(manifest.name, module);
                                }
                                if (isService) {
                                    this.serviceModules.set(manifest.name, { manifest, module });
                                }
                            } catch (e) {
                                console.error(`[PluginManager] Error loading module for ${manifest.name}:`, e);
                            }
                        }
                    } catch (error) {
                        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
                            console.error(`[PluginManager] Error loading plugin from ${folder.name}:`, error);
                        }
                    }
                }
            }

            // 3. 确定预处理器加载顺序
            const availablePlugins = new Set(discoveredPreprocessors.keys());
            let finalOrder = [];
            try {
                const orderContent = await fs.readFile(PREPROCESSOR_ORDER_FILE, 'utf-8');
                const savedOrder = JSON.parse(orderContent);
                if (Array.isArray(savedOrder)) {
                    savedOrder.forEach(pluginName => {
                        if (availablePlugins.has(pluginName)) {
                            finalOrder.push(pluginName);
                            availablePlugins.delete(pluginName);
                        }
                    });
                }
            } catch (error) {
                if (error.code !== 'ENOENT') console.error(`[PluginManager] Error reading existing ${PREPROCESSOR_ORDER_FILE}:`, error);
            }
            
            finalOrder.push(...Array.from(availablePlugins).sort());
            
            // 4. 注册预处理器
            for (const pluginName of finalOrder) {
                this.messagePreprocessors.set(pluginName, discoveredPreprocessors.get(pluginName));
            }
            this.preprocessorOrder = finalOrder;
            if (finalOrder.length > 0) console.log('[PluginManager] Final message preprocessor order: ' + finalOrder.join(' -> '));

            // 5. 初始化共享服务 (VectorDBManager)
            if (this.vectorDBManager) {
                await this.vectorDBManager.initialize();
            }

            // 6. 按顺序初始化所有模块
            const allModulesMap = new Map(modulesToInitialize.map(m => [m.manifest.name, m]));
            const initializationOrder = [...this.preprocessorOrder];
            allModulesMap.forEach((_, name) => {
                if (!initializationOrder.includes(name)) {
                    initializationOrder.push(name);
                }
            });

            for (const pluginName of initializationOrder) {
                const item = allModulesMap.get(pluginName);
                if (!item || typeof item.module.initialize !== 'function') continue;

                const { manifest, module } = item;
                try {
                    const initialConfig = this._getPluginConfig(manifest);
                    initialConfig.PORT = process.env.PORT;
                    initialConfig.Key = process.env.Key;
                    initialConfig.PROJECT_BASE_PATH = this.projectBasePath;

                    const dependencies = { vcpLogFunctions: this.getVCPLogFunctions() };

                    // --- 注入 VectorDBManager ---
                    if (manifest.name === 'RAGDiaryPlugin') {
                        dependencies.vectorDBManager = this.vectorDBManager;
                    }

                    // --- LightMemo 特殊依赖注入 ---
                    if (manifest.name === 'LightMemo') {
                        const ragPluginModule = this.messagePreprocessors.get('RAGDiaryPlugin');
                        if (ragPluginModule && ragPluginModule.vectorDBManager && typeof ragPluginModule.getSingleEmbedding === 'function') {
                            dependencies.vectorDBManager = ragPluginModule.vectorDBManager;
                            dependencies.getSingleEmbedding = ragPluginModule.getSingleEmbedding.bind(ragPluginModule);
                            if (this.debugMode) console.log(`[PluginManager] Injected VectorDBManager and getSingleEmbedding into LightMemo.`);
                        } else {
                            console.error(`[PluginManager] Critical dependency failure: RAGDiaryPlugin or its components not available for LightMemo injection.`);
                        }
                    }
                    // --- 注入结束 ---

                    await module.initialize(initialConfig, dependencies);
                } catch (e) {
                    console.error(`[PluginManager] Error initializing module for ${manifest.name}:`, e);
                }
            }

            this.buildVCPDescription();
            console.log(`[PluginManager] Plugin discovery finished. Loaded ${this.plugins.size} plugins.`);
        } catch (error) {
            if (error.code === 'ENOENT') console.error(`[PluginManager] Plugin directory ${PLUGIN_DIR} not found.`);
            else console.error('[PluginManager] Error reading plugin directory:', error);
        }
    }

    buildVCPDescription() {
        this.individualPluginDescriptions.clear(); // Clear previous descriptions
        let overallLog = ['[PluginManager] Building individual VCP descriptions:'];

        for (const plugin of this.plugins.values()) {
            if (plugin.capabilities && plugin.capabilities.invocationCommands && plugin.capabilities.invocationCommands.length > 0) {
                let pluginSpecificDescriptions = [];
                plugin.capabilities.invocationCommands.forEach(cmd => {
                    if (cmd.description) {
                        let commandDescription = `- ${plugin.displayName} (${plugin.name}) - 命令: ${cmd.command || 'N/A'}:\n`; // Assuming cmd might have a 'command' field or similar identifier
                        const indentedCmdDescription = cmd.description.split('\n').map(line => `    ${line}`).join('\n');
                        commandDescription += `${indentedCmdDescription}`;
                        
                        if (cmd.example) {
                            const exampleHeader = `\n  调用示例:\n`;
                            const indentedExample = cmd.example.split('\n').map(line => `    ${line}`).join('\n');
                            commandDescription += exampleHeader + indentedExample;
                        }
                        pluginSpecificDescriptions.push(commandDescription);
                    }
                });

                if (pluginSpecificDescriptions.length > 0) {
                    const placeholderKey = `VCP${plugin.name}`;
                    const fullDescriptionForPlugin = pluginSpecificDescriptions.join('\n\n');
                    this.individualPluginDescriptions.set(placeholderKey, fullDescriptionForPlugin);
                    overallLog.push(`  - Generated description for {{${placeholderKey}}} (Length: ${fullDescriptionForPlugin.length})`);
                }
            }
        }

        if (this.individualPluginDescriptions.size === 0) {
            overallLog.push("  - No VCP plugins with invocation commands found to generate descriptions for.");
        }
        if (this.debugMode) console.log(overallLog.join('\n'));
    }

    // New method to get all individual descriptions
    getIndividualPluginDescriptions() {
        return this.individualPluginDescriptions;
    }

    // getVCPDescription() { // This method is no longer needed as VCPDescription is deprecated
    //     return this.vcpDescription;
    // }
    
    getPlugin(name) {
        return this.plugins.get(name);
    }

    getServiceModule(name) {
        return this.serviceModules.get(name)?.module;
    }
    
    // 新增：获取 VCPLog 插件的推送函数，供其他插件依赖注入
    getVCPLogFunctions() {
        const vcpLogModule = this.getServiceModule('VCPLog');
        if (vcpLogModule) {
            return {
                pushVcpLog: vcpLogModule.pushVcpLog,
                pushVcpInfo: vcpLogModule.pushVcpInfo
            };
        }
        return { pushVcpLog: () => {}, pushVcpInfo: () => {} };
    }

    async processToolCall(toolName, toolArgs, requestIp = null) {
        const plugin = this.plugins.get(toolName);
        if (!plugin) {
            throw new Error(`[PluginManager] Plugin "${toolName}" not found for tool call.`);
        }

        // Helper function to generate a timestamp string
        const _getFormattedLocalTimestamp = () => {
            const date = new Date();
            const year = date.getFullYear();
            const month = (date.getMonth() + 1).toString().padStart(2, '0');
            const day = date.getDate().toString().padStart(2, '0');
            const hours = date.getHours().toString().padStart(2, '0');
            const minutes = date.getMinutes().toString().padStart(2, '0');
            const seconds = date.getSeconds().toString().padStart(2, '0');
            const milliseconds = date.getMilliseconds().toString().padStart(3, '0');
            const timezoneOffsetMinutes = date.getTimezoneOffset();
            const offsetSign = timezoneOffsetMinutes > 0 ? "-" : "+";
            const offsetHours = Math.abs(Math.floor(timezoneOffsetMinutes / 60)).toString().padStart(2, '0');
            const offsetMinutes = Math.abs(timezoneOffsetMinutes % 60).toString().padStart(2, '0');
            const timezoneString = `${offsetSign}${offsetHours}:${offsetMinutes}`;
            return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}${timezoneString}`;
        };

        const maidNameFromArgs = toolArgs && toolArgs.maid ? toolArgs.maid : null;
        const pluginSpecificArgs = { ...toolArgs };
        if (maidNameFromArgs) {
            // The 'maid' parameter is intentionally passed through for plugins like DeepMemo.
            // delete pluginSpecificArgs.maid;
        }

        try {
            let resultFromPlugin;
            if (plugin.isDistributed) {
                // --- 分布式插件调用逻辑 ---
                if (!this.webSocketServer) {
                    throw new Error('[PluginManager] WebSocketServer is not initialized. Cannot call distributed tool.');
                }
                if (this.debugMode) console.log(`[PluginManager] Processing distributed tool call for: ${toolName} on server ${plugin.serverId}`);
                resultFromPlugin = await this.webSocketServer.executeDistributedTool(plugin.serverId, toolName, pluginSpecificArgs);
                // 分布式工具的返回结果应该已经是JS对象了
            } else if (toolName === 'ChromeControl' && plugin.communication?.protocol === 'direct') {
               // --- ChromeControl 特殊处理逻辑 ---
               if (!this.webSocketServer) {
                   throw new Error('[PluginManager] WebSocketServer is not initialized. Cannot call ChromeControl tool.');
               }
               if (this.debugMode) console.log(`[PluginManager] Processing direct WebSocket tool call for: ${toolName}`);
               const command = pluginSpecificArgs.command;
               delete pluginSpecificArgs.command;
               resultFromPlugin = await this.webSocketServer.forwardCommandToChrome(command, pluginSpecificArgs);

            } else if (plugin.pluginType === 'hybridservice' && plugin.communication?.protocol === 'direct') {
               // --- 混合服务插件直接调用逻辑 ---
               if (this.debugMode) console.log(`[PluginManager] Processing direct tool call for hybrid service: ${toolName}`);
               const serviceModule = this.getServiceModule(toolName);
               if (serviceModule && typeof serviceModule.processToolCall === 'function') {
                   resultFromPlugin = await serviceModule.processToolCall(pluginSpecificArgs);
               } else {
                   throw new Error(`[PluginManager] Hybrid service plugin "${toolName}" does not have a processToolCall function.`);
               }
            } else {
                // --- 本地插件调用逻辑 (现有逻辑) ---
                if (!((plugin.pluginType === 'synchronous' || plugin.pluginType === 'asynchronous') && plugin.communication?.protocol === 'stdio')) {
                    throw new Error(`[PluginManager] Local plugin "${toolName}" (type: ${plugin.pluginType}) is not a supported stdio plugin for direct tool call.`);
                }
                
                let executionParam = null;
                if (Object.keys(pluginSpecificArgs).length > 0) {
                    executionParam = JSON.stringify(pluginSpecificArgs);
                }
                
                const logParam = executionParam ? (executionParam.length > 100 ? executionParam.substring(0, 100) + '...' : executionParam) : null;
                if (this.debugMode) console.log(`[PluginManager] Calling local executePlugin for: ${toolName} with prepared param:`, logParam);

                const pluginOutput = await this.executePlugin(toolName, executionParam, requestIp); // Returns {status, result/error}

                if (pluginOutput.status === "success") {
                    if (typeof pluginOutput.result === 'string') {
                        try {
                            // If the result is a string, try to parse it as JSON.
                            resultFromPlugin = JSON.parse(pluginOutput.result);
                        } catch (parseError) {
                            // If parsing fails, wrap it. This is for plugins that return plain text.
                            if (this.debugMode) console.warn(`[PluginManager] Local plugin ${toolName} result string was not valid JSON. Original: "${pluginOutput.result.substring(0, 100)}"`);
                            resultFromPlugin = { original_plugin_output: pluginOutput.result };
                        }
                    } else {
                        // If the result is already an object (as with our new image plugins), use it directly.
                        resultFromPlugin = pluginOutput.result;
                    }
                } else {
                    // 检查是否是文件未找到的特定错误
                    if (pluginOutput.code === 'FILE_NOT_FOUND_LOCALLY' && pluginOutput.fileUrl && requestIp) {
                        if (this.debugMode) console.log(`[PluginManager] Plugin '${toolName}' reported local file not found. Attempting to fetch via FileFetcherServer...`);
                        
                        try {
                            const { buffer, mimeType } = await FileFetcherServer.fetchFile(pluginOutput.fileUrl, requestIp);
                            const base64Data = buffer.toString('base64');
                            const dataUri = `data:${mimeType};base64,${base64Data}`;
                            
                            if (this.debugMode) console.log(`[PluginManager] Successfully fetched file as data URI. Retrying plugin call...`);
                            
                            // 新的重试逻辑：精确替换失败的参数
                            const newToolArgs = { ...toolArgs };
                            const failedParam = pluginOutput.failedParameter; // e.g., "image_url1"

                            if (failedParam && newToolArgs[failedParam]) {
                                // 删除旧的 file:// url 参数
                                delete newToolArgs[failedParam];
                                
                                // 添加新的 base64 参数。我们使用一个新的键来避免命名冲突，
                                // 并且让插件知道这是一个已经处理过的 base64 数据。
                                // e.g., "image_base64_1"
                               // 关键修复：确保正确地从 "image_url_1" 提取出 "1"
                               const paramIndex = failedParam.replace('image_url_', '');
                               const newParamKey = `image_base64_${paramIndex}`;
                               newToolArgs[newParamKey] = dataUri;
                               
                               if (this.debugMode) console.log(`[PluginManager] Retrying with '${failedParam}' replaced by '${newParamKey}'.`);

                            } else {
                                // 旧的后备逻辑，用于兼容单个 image_url 的情况
                                delete newToolArgs.image_url;
                                newToolArgs.image_base64 = dataUri;
                                if (this.debugMode) console.log(`[PluginManager] 'failedParameter' not specified. Falling back to replacing 'image_url' with 'image_base64'.`);
                            }
                            
                            // 直接返回重试调用的结果
                            return await this.processToolCall(toolName, newToolArgs, requestIp);

                        } catch (fetchError) {
                            throw new Error(JSON.stringify({
                                plugin_error: `Plugin reported local file not found, but remote fetch failed: ${fetchError.message}`,
                                original_plugin_error: pluginOutput.error
                            }));
                        }
                    } else {
                        throw new Error(JSON.stringify({ plugin_error: pluginOutput.error || `Plugin "${toolName}" reported an unspecified error.` }));
                    }
                }
            }

            // --- 通用结果处理 ---
            let finalResultObject = (typeof resultFromPlugin === 'object' && resultFromPlugin !== null) ? resultFromPlugin : { original_plugin_output: resultFromPlugin };

            if (maidNameFromArgs) {
                finalResultObject.MaidName = maidNameFromArgs;
            }
            finalResultObject.timestamp = _getFormattedLocalTimestamp();
            
            return finalResultObject;

        } catch (e) {
            console.error(`[PluginManager processToolCall] Error during execution for plugin ${toolName}:`, e.message);
            let errorObject;
            try {
                errorObject = JSON.parse(e.message);
            } catch (jsonParseError) {
                errorObject = { plugin_execution_error: e.message || 'Unknown plugin execution error' };
            }
            
            if (maidNameFromArgs && !errorObject.MaidName) {
                errorObject.MaidName = maidNameFromArgs;
            }
            if (!errorObject.timestamp) {
                errorObject.timestamp = _getFormattedLocalTimestamp();
            }
            throw new Error(JSON.stringify(errorObject));
        }
    }

    async executePlugin(pluginName, inputData, requestIp = null) {
        const plugin = this.plugins.get(pluginName);
        if (!plugin) {
            // This case should ideally be caught by processToolCall before calling executePlugin
            throw new Error(`[PluginManager executePlugin] Plugin "${pluginName}" not found.`);
        }
        // Validations for pluginType, communication, entryPoint remain important
        if (!((plugin.pluginType === 'synchronous' || plugin.pluginType === 'asynchronous') && plugin.communication?.protocol === 'stdio')) {
            throw new Error(`[PluginManager executePlugin] Plugin "${pluginName}" (type: ${plugin.pluginType}, protocol: ${plugin.communication?.protocol}) is not a supported stdio plugin. Expected synchronous or asynchronous stdio plugin.`);
        }
        if (!plugin.entryPoint || !plugin.entryPoint.command) {
            throw new Error(`[PluginManager executePlugin] Entry point command undefined for plugin "${pluginName}".`);
        }
        
        const pluginConfig = this._getPluginConfig(plugin);
        const envForProcess = { ...process.env };

        for (const key in pluginConfig) {
            if (pluginConfig.hasOwnProperty(key) && pluginConfig[key] !== undefined) {
                envForProcess[key] = String(pluginConfig[key]);
            }
        }
        
        const additionalEnv = {};
        if (this.projectBasePath) {
            additionalEnv.PROJECT_BASE_PATH = this.projectBasePath;
        } else {
            if (this.debugMode) console.warn("[PluginManager executePlugin] projectBasePath not set, PROJECT_BASE_PATH will not be available to plugins.");
        }

        // 如果插件需要管理员权限，则获取解密后的验证码并注入环境变量
        if (plugin.requiresAdmin) {
            const decryptedCode = await this._getDecryptedAuthCode();
            if (decryptedCode) {
                additionalEnv.DECRYPTED_AUTH_CODE = decryptedCode;
                if (this.debugMode) console.log(`[PluginManager] Injected DECRYPTED_AUTH_CODE for admin-required plugin: ${pluginName}`);
            } else {
                if (this.debugMode) console.warn(`[PluginManager] Could not get decrypted auth code for admin-required plugin: ${pluginName}. Execution will proceed without it.`);
            }
        }
        // 将 requestIp 添加到环境变量
        if (requestIp) {
            additionalEnv.VCP_REQUEST_IP = requestIp;
        }
        if (process.env.PORT) {
            additionalEnv.SERVER_PORT = process.env.PORT;
        }
        const imageServerKey = this.getResolvedPluginConfigValue('ImageServer', 'Image_Key');
        if (imageServerKey) {
            additionalEnv.IMAGESERVER_IMAGE_KEY = imageServerKey;
        }

        // Pass CALLBACK_BASE_URL and PLUGIN_NAME to asynchronous plugins
        if (plugin.pluginType === 'asynchronous') {
            const callbackBaseUrl = pluginConfig.CALLBACK_BASE_URL || process.env.CALLBACK_BASE_URL; // Prefer plugin-specific, then global
            if (callbackBaseUrl) {
                additionalEnv.CALLBACK_BASE_URL = callbackBaseUrl;
            } else {
                if (this.debugMode) console.warn(`[PluginManager executePlugin] CALLBACK_BASE_URL not configured for asynchronous plugin ${pluginName}. Callback functionality might be impaired.`);
            }
            additionalEnv.PLUGIN_NAME_FOR_CALLBACK = pluginName; // Pass the plugin's name
        }
        
        // Force Python stdio encoding to UTF-8
        additionalEnv.PYTHONIOENCODING = 'utf-8';
        const finalEnv = { ...envForProcess, ...additionalEnv };

        if (this.debugMode && plugin.pluginType === 'asynchronous') {
            console.log(`[PluginManager executePlugin] Final ENV for async plugin ${pluginName}:`, JSON.stringify(finalEnv, null, 2).substring(0, 500) + "...");
        }

        return new Promise((resolve, reject) => {
            if (this.debugMode) console.log(`[PluginManager executePlugin Internal] For plugin "${pluginName}", manifest entryPoint command is: "${plugin.entryPoint.command}"`);
            const [command, ...args] = plugin.entryPoint.command.split(' ');
            if (this.debugMode) console.log(`[PluginManager executePlugin Internal] Attempting to spawn command: "${command}" with args: [${args.join(', ')}] in cwd: ${plugin.basePath}`);

            const pluginProcess = spawn(command, args, { cwd: plugin.basePath, shell: true, env: finalEnv, windowsHide: true });
            let outputBuffer = ''; // Buffer to accumulate data chunks
            let errorOutput = '';
            let processExited = false;
            let initialResponseSent = false; // Flag for async plugins
            const isAsyncPlugin = plugin.pluginType === 'asynchronous';

            const timeoutDuration = plugin.communication.timeout || (isAsyncPlugin ? 1800000 : 60000); // Use manifest timeout, or 30min for async, 1min for sync
            
            const timeoutId = setTimeout(() => {
                if (!processExited && !initialResponseSent && isAsyncPlugin) {
                    // For async, if initial response not sent by timeout, it's an error for that phase
                     console.error(`[PluginManager executePlugin Internal] Async plugin "${pluginName}" initial response timed out after ${timeoutDuration}ms.`);
                     pluginProcess.kill('SIGKILL'); // Kill if no initial response
                     reject(new Error(`Plugin "${pluginName}" initial response timed out.`));
                } else if (!processExited && !isAsyncPlugin) {
                    // For sync plugins, or if async initial response was sent but process hangs
                    console.error(`[PluginManager executePlugin Internal] Plugin "${pluginName}" execution timed out after ${timeoutDuration}ms.`);
                    pluginProcess.kill('SIGKILL');
                    reject(new Error(`Plugin "${pluginName}" execution timed out.`));
                } else if (!processExited && isAsyncPlugin && initialResponseSent) {
                    // Async plugin's initial response was sent, but the process is still running (e.g. for background tasks)
                    // We let it run, but log if it exceeds the overall timeout.
                    // The process will be managed by its own non-daemon threads.
                    if (this.debugMode) console.log(`[PluginManager executePlugin Internal] Async plugin "${pluginName}" process is still running in background after timeout. This is expected for non-daemon threads.`);
                }
            }, timeoutDuration);

            pluginProcess.stdout.setEncoding('utf8');
            pluginProcess.stdout.on('data', (data) => {
                if (processExited || (isAsyncPlugin && initialResponseSent)) {
                    // If async and initial response sent, or process exited, ignore further stdout for this Promise.
                    // The plugin's background task might still log to its own stdout, but we don't collect it here.
                    if (this.debugMode && isAsyncPlugin && initialResponseSent) console.log(`[PluginManager executePlugin Internal] Async plugin ${pluginName} (initial response sent) produced more stdout: ${data.substring(0,100)}...`);
                    return;
                }
                outputBuffer += data;
                try {
                    // Try to parse a complete JSON object from the buffer.
                    // This is a simple check; for robust streaming JSON, a more complex parser is needed.
                    // We assume the first complete JSON is the one we want for async initial response.
                    const potentialJsonMatch = outputBuffer.match(/(\{[\s\S]*?\})(?:\s|$)/);
                    if (potentialJsonMatch && potentialJsonMatch[1]) {
                        const jsonString = potentialJsonMatch[1];
                        const parsedOutput = JSON.parse(jsonString);

                        if (parsedOutput && (parsedOutput.status === "success" || parsedOutput.status === "error")) {
                            if (isAsyncPlugin) {
                                if (!initialResponseSent) {
                                    if (this.debugMode) console.log(`[PluginManager executePlugin Internal] Async plugin "${pluginName}" sent initial JSON response. Resolving promise.`);
                                    initialResponseSent = true;
                                    // For async, we resolve with the first valid JSON and let the process continue if it has non-daemon threads.
                                    // We don't clear the main timeout here for async, as the process might still need to be killed if it misbehaves badly later.
                                    // However, the primary purpose of this promise is fulfilled.
                                    resolve(parsedOutput);
                                    // We don't return or clear outputBuffer here, as more data might be part of a *synchronous* plugin's single large JSON output.
                                }
                            } else { // Synchronous plugin
                                // For sync plugins, we wait for 'exit' to ensure all output is collected.
                                // This block within 'data' event is more for validating if the output *looks* like our expected JSON.
                                // The actual resolve for sync plugins happens in 'exit'.
                                if (this.debugMode) console.log(`[PluginManager executePlugin Internal] Sync plugin "${pluginName}" current output buffer contains a potential JSON.`);
                            }
                        }
                    }
                } catch (e) {
                    // Incomplete JSON or invalid JSON, wait for more data or 'exit' event.
                    if (this.debugMode && outputBuffer.length > 2) console.log(`[PluginManager executePlugin Internal] Plugin "${pluginName}" stdout buffer not yet a complete JSON or invalid. Buffer: ${outputBuffer.substring(0,100)}...`);
                }
            });

            pluginProcess.stderr.setEncoding('utf8');
            pluginProcess.stderr.on('data', (data) => {
                errorOutput += data;
                if (this.debugMode) console.warn(`[PluginManager executePlugin Internal stderr] Plugin "${pluginName}": ${data.trim()}`);
            });

            pluginProcess.on('error', (err) => {
                processExited = true; clearTimeout(timeoutId);
                if (!initialResponseSent) { // Only reject if initial response (for async) or any response (for sync) hasn't been sent
                    reject(new Error(`Failed to start plugin "${pluginName}": ${err.message}`));
                } else if (this.debugMode) {
                    console.error(`[PluginManager executePlugin Internal] Error after initial response for async plugin "${pluginName}": ${err.message}. Process might have been expected to continue.`);
                }
            });
            
            pluginProcess.on('exit', (code, signal) => {
                processExited = true;
                clearTimeout(timeoutId); // Clear the main timeout once the process exits.

                if (isAsyncPlugin && initialResponseSent) {
                    // For async plugins where initial response was already sent, log exit but don't re-resolve/reject.
                    if (this.debugMode) console.log(`[PluginManager executePlugin Internal] Async plugin "${pluginName}" process exited with code ${code}, signal ${signal} after initial response was sent.`);
                    return;
                }
                
                // If we are here, it's either a sync plugin, or an async plugin whose initial response was NOT sent before exit.

                if (signal === 'SIGKILL') { // Typically means timeout killed it
                    if (!initialResponseSent) reject(new Error(`Plugin "${pluginName}" execution timed out or was killed.`));
                    return;
                }

                try {
                    const parsedOutput = JSON.parse(outputBuffer.trim()); // Use accumulated outputBuffer
                    if (parsedOutput && (parsedOutput.status === "success" || parsedOutput.status === "error")) {
                        if (code !== 0 && parsedOutput.status === "success" && this.debugMode) {
                             console.warn(`[PluginManager executePlugin Internal] Plugin "${pluginName}" exited with code ${code} but reported success in JSON. Trusting JSON.`);
                        }
                        if (code === 0 && parsedOutput.status === "error" && this.debugMode) {
                            console.warn(`[PluginManager executePlugin Internal] Plugin "${pluginName}" exited with code 0 but reported error in JSON. Trusting JSON.`);
                        }
                        if (errorOutput.trim()) parsedOutput.pluginStderr = errorOutput.trim();
                        
                        if (!initialResponseSent) resolve(parsedOutput); // Ensure resolve only once
                        else if (this.debugMode) console.log(`[PluginManager executePlugin Internal] Plugin ${pluginName} exited, initial async response already sent.`);
                        return;
                    }
                    if (this.debugMode) console.warn(`[PluginManager executePlugin Internal] Plugin "${pluginName}" final stdout was not in the expected JSON format: ${outputBuffer.trim().substring(0,100)}`);
                } catch (e) {
                    if (this.debugMode) console.warn(`[PluginManager executePlugin Internal] Failed to parse final stdout JSON from plugin "${pluginName}". Error: ${e.message}. Stdout: ${outputBuffer.trim().substring(0,100)}`);
                }

                if (!initialResponseSent) { // Only reject if no response has been sent yet
                    if (code !== 0) {
                        let detailedError = `Plugin "${pluginName}" exited with code ${code}.`;
                        if (outputBuffer.trim()) detailedError += ` Stdout: ${outputBuffer.trim().substring(0, 200)}`;
                        if (errorOutput.trim()) detailedError += ` Stderr: ${errorOutput.trim().substring(0, 200)}`;
                        reject(new Error(detailedError));
                    } else {
                        // Exit code 0, but no valid initial JSON response was sent/parsed.
                        reject(new Error(`Plugin "${pluginName}" exited successfully but did not provide a valid initial JSON response. Stdout: ${outputBuffer.trim().substring(0,200)}`));
                    }
                }
            });

            try {
                if (inputData !== undefined && inputData !== null) {
                    pluginProcess.stdin.write(inputData.toString());
                }
                pluginProcess.stdin.end();
            } catch (e) {
                console.error(`[PluginManager executePlugin Internal] Stdin write error for "${pluginName}": ${e.message}`);
                if (!initialResponseSent) { // Only reject if no response has been sent yet
                    reject(new Error(`Stdin write error for "${pluginName}": ${e.message}`));
                }
            }
        });
    }

    initializeServices(app, adminApiRouter, projectBasePath) {
        if (!app) {
            console.error('[PluginManager] Cannot initialize services without Express app instance.');
            return;
        }
        if (!adminApiRouter) {
            console.error('[PluginManager] Cannot initialize services without adminApiRouter instance.');
            return;
        }
        if (!projectBasePath) {
            console.error('[PluginManager] Cannot initialize services without projectBasePath.'); // Keep error
            return;
        }
        console.log('[PluginManager] Initializing service plugins...'); // Keep
        for (const [name, serviceData] of this.serviceModules) {
            try {
                const pluginConfig = this._getPluginConfig(serviceData.manifest);
                const manifest = serviceData.manifest;
                const module = serviceData.module;

                // 新的、带命名空间的API路由注册机制
                if (manifest.hasApiRoutes && typeof module.registerApiRoutes === 'function') {
                    if (this.debugMode) console.log(`[PluginManager] Registering namespaced API routes for service plugin: ${name}`);
                    const pluginRouter = express.Router();
                    // 将 router 和其他上下文传递给插件
                    module.registerApiRoutes(pluginRouter, pluginConfig, projectBasePath, this.webSocketServer);
                    // 统一挂载到带命名空间的前缀下
                    app.use(`/api/plugins/${name}`, pluginRouter);
                    if (this.debugMode) console.log(`[PluginManager] Mounted API routes for ${name} at /api/plugins/${name}`);
                }
                
                // VCPLog 特殊处理：注入 WebSocketServer 的广播函数
                if (name === 'VCPLog' && this.webSocketServer && typeof module.setBroadcastFunctions === 'function') {
                    if (typeof this.webSocketServer.broadcastVCPInfo === 'function') {
                        module.setBroadcastFunctions(this.webSocketServer.broadcastVCPInfo);
                        if (this.debugMode) console.log(`[PluginManager] Injected broadcastVCPInfo into VCPLog.`);
                    } else {
                        console.warn(`[PluginManager] WebSocketServer is missing broadcastVCPInfo function. VCPInfo will not be broadcastable.`);
                    }
                }

                // 兼容旧的、直接在 app 上注册的 service 插件
                if (typeof module.registerRoutes === 'function') {
                    if (this.debugMode) console.log(`[PluginManager] Registering legacy routes for service plugin: ${name}`);
                    if (module.registerRoutes.length >= 4) {
                        if (this.debugMode) console.log(`[PluginManager] Calling new-style legacy registerRoutes for ${name} (4+ args).`);
                        module.registerRoutes(app, adminApiRouter, pluginConfig, projectBasePath);
                    } else {
                        if (this.debugMode) console.log(`[PluginManager] Calling legacy-style registerRoutes for ${name} (3 args).`);
                        module.registerRoutes(app, pluginConfig, projectBasePath);
                    }
                }

            } catch (e) {
                console.error(`[PluginManager] Error initializing service plugin ${name}:`, e); // Keep error
            }
        }
        console.log('[PluginManager] Service plugins initialized.'); // Keep
    }
    // --- 新增分布式插件管理方法 ---
    registerDistributedTools(serverId, tools) {
        if (this.debugMode) console.log(`[PluginManager] Registering ${tools.length} tools from distributed server: ${serverId}`);
        for (const toolManifest of tools) {
            if (!toolManifest.name || !toolManifest.pluginType || !toolManifest.entryPoint) {
                if (this.debugMode) console.warn(`[PluginManager] Invalid manifest from ${serverId} for tool '${toolManifest.name}'. Skipping.`);
                continue;
            }
            if (this.plugins.has(toolManifest.name)) {
                if (this.debugMode) console.warn(`[PluginManager] Distributed tool '${toolManifest.name}' from ${serverId} conflicts with an existing tool. Skipping.`);
                continue;
            }
            
            // 标记为分布式插件并存储其来源服务器ID
            toolManifest.isDistributed = true;
            toolManifest.serverId = serverId;
            
            // 在显示名称前加上[云端]前缀
            toolManifest.displayName = `[云端] ${toolManifest.displayName || toolManifest.name}`;

            this.plugins.set(toolManifest.name, toolManifest);
            console.log(`[PluginManager] Registered distributed tool: ${toolManifest.displayName} (${toolManifest.name}) from ${serverId}`);
        }
        // 注册后重建描述，以包含新插件
        this.buildVCPDescription();
    }

    unregisterAllDistributedTools(serverId) {
        if (this.debugMode) console.log(`[PluginManager] Unregistering all tools from distributed server: ${serverId}`);
        let unregisteredCount = 0;
        for (const [name, manifest] of this.plugins.entries()) {
            if (manifest.isDistributed && manifest.serverId === serverId) {
                this.plugins.delete(name);
                unregisteredCount++;
                if (this.debugMode) console.log(`  - Unregistered: ${name}`);
            }
        }
        if (unregisteredCount > 0) {
            console.log(`[PluginManager] Unregistered ${unregisteredCount} tools from server ${serverId}.`);
            // 注销后重建描述
            this.buildVCPDescription();
        }
        
        // 新增：清理分布式静态占位符
        this.clearDistributedStaticPlaceholders(serverId);
    }

    // 新增：更新分布式静态占位符
    updateDistributedStaticPlaceholders(serverId, serverName, placeholders) {
        if (this.debugMode) {
            console.log(`[PluginManager] Updating static placeholders from distributed server ${serverName} (${serverId})`);
        }
        
        for (const [placeholder, value] of Object.entries(placeholders)) {
            // 为分布式占位符添加服务器来源标识
            this.staticPlaceholderValues.set(placeholder, { value: value, serverId: serverId });
            
            if (this.debugMode) {
                console.log(`[PluginManager] Updated distributed placeholder ${placeholder} from ${serverName}: ${value.substring(0, 100)}${value.length > 100 ? '...' : ''}`);
            }
        }
        
        // 强制日志记录分布式静态占位符更新
        console.log(`[PluginManager] Updated ${Object.keys(placeholders).length} static placeholders from distributed server ${serverName}.`);
    }

    // 新增：清理分布式静态占位符
    clearDistributedStaticPlaceholders(serverId) {
        const placeholdersToRemove = [];
        
        for (const [placeholder, entry] of this.staticPlaceholderValues.entries()) {
            if (entry && entry.serverId === serverId) {
                placeholdersToRemove.push(placeholder);
            }
        }
        
        for (const placeholder of placeholdersToRemove) {
            this.staticPlaceholderValues.delete(placeholder);
            if (this.debugMode) {
                console.log(`[PluginManager] Removed distributed placeholder ${placeholder} from disconnected server ${serverId}`);
            }
        }
        
        if (placeholdersToRemove.length > 0) {
            console.log(`[PluginManager] Cleared ${placeholdersToRemove.length} static placeholders from disconnected server ${serverId}.`);
        }
    }

    // --- 新增方法 ---
    async hotReloadPluginsAndOrder() {
        console.log('[PluginManager] Hot reloading plugins and preprocessor order...');
        // 重新加载所有插件，这将自动应用新的顺序
        await this.loadPlugins();
        console.log('[PluginManager] Hot reload complete.');
        return this.getPreprocessorOrder();
    }

    getPreprocessorOrder() {
        // 返回所有已发现、已排序的预处理器信息
        return this.preprocessorOrder.map(name => {
            const manifest = this.plugins.get(name);
            return {
                name: name,
                displayName: manifest ? manifest.displayName : name,
                description: manifest ? manifest.description : 'N/A'
            };
        });
    }
    startPluginWatcher() {
        if (this.debugMode) console.log('[PluginManager] Starting plugin file watcher...');
        
        const pathsToWatch = [
            path.join(PLUGIN_DIR, '**/plugin-manifest.json'),
            path.join(PLUGIN_DIR, '**/plugin-manifest.json.block')
        ];

        const watcher = chokidar.watch(pathsToWatch, {
            persistent: true,
            ignoreInitial: true, // Don't fire on initial scan
            awaitWriteFinish: {
                stabilityThreshold: 500,
                pollInterval: 100
            }
        });

        watcher
            .on('add', filePath => this.handlePluginManifestChange('add', filePath))
            .on('change', filePath => this.handlePluginManifestChange('change', filePath))
            .on('unlink', filePath => this.handlePluginManifestChange('unlink', filePath));
            
        console.log(`[PluginManager] Chokidar is now watching for manifest changes in: ${PLUGIN_DIR}`);
    }

    handlePluginManifestChange(eventType, filePath) {
        if (this.isReloading) {
            if (this.debugMode) console.log(`[PluginManager] Already reloading, skipping event '${eventType}' for: ${filePath}`);
            return;
        }
        
        clearTimeout(this.reloadTimeout);
        
        if (this.debugMode) console.log(`[PluginManager] Debouncing plugin reload trigger due to '${eventType}' event on: ${path.basename(filePath)}`);

        this.reloadTimeout = setTimeout(async () => {
            this.isReloading = true;
            console.log(`[PluginManager] Manifest file change detected ('${eventType}'). Hot-reloading plugins...`);
            
            try {
                await this.loadPlugins();
                console.log('[PluginManager] Hot-reload complete.');

                if (this.webSocketServer && typeof this.webSocketServer.broadcastToAdminPanel === 'function') {
                    this.webSocketServer.broadcastToAdminPanel({
                        type: 'plugins-reloaded',
                        message: 'Plugin list has been updated due to file changes.'
                    });
                    if (this.debugMode) console.log('[PluginManager] Notified admin panel about plugin reload.');
                }
            } catch (error) {
                console.error('[PluginManager] Error during hot-reload:', error);
            } finally {
                this.isReloading = false;
            }
        }, 500); // 500ms debounce window
    }
}

const pluginManager = new PluginManager();

// 新增：获取所有静态占位符值
pluginManager.getAllPlaceholderValues = function() {
    const valuesMap = new Map();
    for (const [key, entry] of this.staticPlaceholderValues.entries()) {
        valuesMap.set(key, entry.value || `[Placeholder ${key} not found]`);
    }
    return valuesMap;
};

module.exports = pluginManager;