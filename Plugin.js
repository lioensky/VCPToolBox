// Plugin.js
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const schedule = require('node-schedule');
const dotenv = require('dotenv'); // Ensures dotenv is available

const PLUGIN_DIR = path.join(__dirname, 'Plugin');
const manifestFileName = 'plugin-manifest.json';

class PluginManager {
    constructor() {
        this.plugins = new Map();
        this.staticPlaceholderValues = new Map();
        this.scheduledJobs = new Map();
        this.messagePreprocessors = new Map();
        this.serviceModules = new Map();
        this.projectBasePath = null;
        this.individualPluginDescriptions = new Map(); // New map for individual descriptions
    }

    setProjectBasePath(basePath) {
        this.projectBasePath = basePath;
        console.log(`[PluginManager] Project base path set to: ${this.projectBasePath}`);
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
                       console.warn(`[PluginManager] Config key '${key}' for ${pluginManifest.name} expected integer, got NaN from raw value '${rawValue}'. Using undefined.`);
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
            const pluginProcess = spawn(command, args, { cwd: plugin.basePath, shell: true, env: envForProcess });
            let output = '';
            let errorOutput = '';
            let processExited = false;
            const timeoutDuration = plugin.communication?.timeout || 30000;

            const timeoutId = setTimeout(() => {
                if (!processExited) {
                    console.error(`[PluginManager] Static plugin "${plugin.name}" execution timed out after ${timeoutDuration}ms.`);
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
                    if (errorOutput.trim()) {
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
            console.log(`[PluginManager] Updating static plugin: ${plugin.name}`);
            newValue = await this._executeStaticPluginCommand(plugin);
        } catch (error) {
            console.error(`[PluginManager] Error executing static plugin ${plugin.name} script:`, error.message);
            executionError = error;
        }

        if (plugin.capabilities && plugin.capabilities.systemPromptPlaceholders) {
            plugin.capabilities.systemPromptPlaceholders.forEach(ph => {
                const placeholderKey = ph.placeholder;
                const currentValue = this.staticPlaceholderValues.get(placeholderKey);

                if (newValue !== null && newValue.trim() !== "") {
                    this.staticPlaceholderValues.set(placeholderKey, newValue.trim());
                    console.log(`[PluginManager] Placeholder ${placeholderKey} for ${plugin.name} updated with value: "${(newValue.trim()).substring(0,70)}..."`);
                } else if (executionError) {
                    const errorMessage = `[Error updating ${plugin.name}: ${executionError.message.substring(0,100)}...]`;
                    if (!currentValue || (currentValue && currentValue.startsWith("[Error"))) {
                        this.staticPlaceholderValues.set(placeholderKey, errorMessage);
                        console.warn(`[PluginManager] Placeholder ${placeholderKey} for ${plugin.name} set to error state: ${errorMessage}`);
                    } else {
                        console.warn(`[PluginManager] Placeholder ${placeholderKey} for ${plugin.name} failed to update. Keeping stale value: "${(currentValue || "").substring(0,70)}..."`);
                    }
                } else {
                    console.warn(`[PluginManager] Static plugin ${plugin.name} produced no new output for ${placeholderKey}. Keeping stale value (if any).`);
                    if (!this.staticPlaceholderValues.has(placeholderKey)) {
                        this.staticPlaceholderValues.set(placeholderKey, `[${plugin.name} data currently unavailable]`);
                        console.log(`[PluginManager] Placeholder ${placeholderKey} for ${plugin.name} set to 'unavailable'.`);
                    }
                }
            });
        }
    }

    async initializeStaticPlugins() {
        console.log('[PluginManager] Initializing static plugins...');
        for (const plugin of this.plugins.values()) {
            if (plugin.pluginType === 'static') {
                await this._updateStaticPluginValue(plugin); 
                if (plugin.refreshIntervalCron) {
                    if (this.scheduledJobs.has(plugin.name)) {
                        this.scheduledJobs.get(plugin.name).cancel();
                    }
                    try {
                        const job = schedule.scheduleJob(plugin.refreshIntervalCron, async () => {
                            console.log(`[PluginManager] Scheduled update for static plugin: ${plugin.name}`);
                            await this._updateStaticPluginValue(plugin);
                        });
                        this.scheduledJobs.set(plugin.name, job);
                        console.log(`[PluginManager] Scheduled ${plugin.name} with cron: ${plugin.refreshIntervalCron}`);
                    } catch (e) {
                        console.error(`[PluginManager] Invalid cron string for ${plugin.name}: ${plugin.refreshIntervalCron}. Error: ${e.message}`);
                    }
                }
            }
        }
        console.log('[PluginManager] Static plugins initialized.');
    }
    
    getPlaceholderValue(placeholder) {
        return this.staticPlaceholderValues.get(placeholder) || `[Placeholder ${placeholder} not found]`;
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
            console.log(`[PluginManager] Executing message preprocessor: ${pluginName}`);
            const pluginSpecificConfig = this._getPluginConfig(pluginManifest);
            const processedMessages = await processorModule.processMessages(messages, pluginSpecificConfig);
            console.log(`[PluginManager] Message preprocessor ${pluginName} finished.`);
            return processedMessages;
        } catch (error) {
            console.error(`[PluginManager] Error in message preprocessor ${pluginName}:`, error);
            return messages;
        }
    }
    
    async shutdownAllPlugins() {
        console.log('[PluginManager] Shutting down all plugins...');
        for (const [name, pluginModuleData] of this.messagePreprocessors) { 
             const pluginModule = pluginModuleData.module || pluginModuleData; 
            if (pluginModule && typeof pluginModule.shutdown === 'function') {
                try {
                    console.log(`[PluginManager] Calling shutdown for ${name}...`);
                    await pluginModule.shutdown();
                } catch (error) {
                    console.error(`[PluginManager] Error during shutdown of plugin ${name}:`, error);
                }
            }
        }
        for (const [name, serviceData] of this.serviceModules) {
            if (serviceData.module && typeof serviceData.module.shutdown === 'function') {
                try {
                    console.log(`[PluginManager] Calling shutdown for service plugin ${name}...`);
                    await serviceData.module.shutdown();
                } catch (error) {
                    console.error(`[PluginManager] Error during shutdown of service plugin ${name}:`, error);
                }
            }
        }
        for (const job of this.scheduledJobs.values()) {
            job.cancel();
        }
        this.scheduledJobs.clear();
        console.log('[PluginManager] All plugin shutdown processes initiated and scheduled jobs cancelled.');
    }

    async loadPlugins() {
        console.log('[PluginManager] Starting plugin discovery...');
        this.plugins.clear();
        this.messagePreprocessors.clear();
        this.staticPlaceholderValues.clear();
        this.serviceModules.clear();

        try {
            const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
            for (const folder of pluginFolders) {
                if (folder.isDirectory()) {
                    const pluginPath = path.join(PLUGIN_DIR, folder.name);
                    const manifestPath = path.join(pluginPath, manifestFileName);
                    try {
                        const manifestContent = await fs.readFile(manifestPath, 'utf-8');
                        const manifest = JSON.parse(manifestContent);
                        if (!manifest.name || !manifest.pluginType || !manifest.entryPoint) {
                            console.warn(`[PluginManager] Invalid manifest in ${folder.name}: Missing fields.`);
                            continue;
                        }
                        if (this.plugins.has(manifest.name)) {
                            console.warn(`[PluginManager] Duplicate plugin name '${manifest.name}' in ${folder.name}. Skipping.`);
                            continue;
                        }
                        manifest.basePath = pluginPath;

                        manifest.pluginSpecificEnvConfig = {}; 
                        try {
                            await fs.access(path.join(pluginPath, '.env')); 
                            const pluginEnvContent = await fs.readFile(path.join(pluginPath, '.env'), 'utf-8');
                            manifest.pluginSpecificEnvConfig = dotenv.parse(pluginEnvContent);
                            console.log(`[PluginManager] Loaded specific .env for plugin: ${manifest.name}`);
                        } catch (envError) {
                            if (envError.code !== 'ENOENT') { 
                                console.warn(`[PluginManager] Error reading or parsing .env for plugin ${manifest.name}:`, envError.message);
                            }
                        }
                        
                        this.plugins.set(manifest.name, manifest);
                        console.log(`[PluginManager] Loaded manifest: ${manifest.displayName} (${manifest.name}, Type: ${manifest.pluginType})`);
                        
                        if (manifest.pluginType === 'messagePreprocessor') {
                            if (manifest.entryPoint.script) {
                                try {
                                    const scriptPath = path.join(pluginPath, manifest.entryPoint.script);
                                    if (manifest.communication?.protocol === 'direct') {
                                        const pluginModule = require(scriptPath);
                                        const initialConfig = this._getPluginConfig(manifest); 
                                        if (pluginModule && typeof pluginModule.initialize === 'function') {
                                            await pluginModule.initialize(initialConfig);
                                            console.log(`[PluginManager] Initialized messagePreprocessor: ${manifest.name}`);
                                        }
                                        this.messagePreprocessors.set(manifest.name, pluginModule); 
                                    } else {
                                         console.warn(`[PluginManager] messagePreprocessor ${manifest.name} has non-direct communication, not yet fully supported for this type.`);
                                    }
                                } catch (e) {
                                    console.error(`[PluginManager] Error requiring/initializing messagePreprocessor ${manifest.name}:`, e);
                                }
                            } else {
                                console.warn(`[PluginManager] messagePreprocessor ${manifest.name} missing entryPoint.script.`);
                            }
                        } else if (manifest.pluginType === 'service') {
                            if (manifest.entryPoint.script && manifest.communication?.protocol === 'direct') {
                                try {
                                    const scriptPath = path.join(pluginPath, manifest.entryPoint.script);
                                    const serviceModule = require(scriptPath);
                                    if (serviceModule && typeof serviceModule.registerRoutes === 'function') {
                                        this.serviceModules.set(manifest.name, { manifest, module: serviceModule });
                                        console.log(`[PluginManager] Loaded service module: ${manifest.name}`);
                                    } else {
                                        console.warn(`[PluginManager] Service plugin ${manifest.name} does not export a 'registerRoutes' function.`);
                                    }
                                } catch (e) {
                                    console.error(`[PluginManager] Error requiring service plugin ${manifest.name}:`, e);
                                }
                            } else {
                                console.warn(`[PluginManager] Service plugin ${manifest.name} is missing a script path or has non-direct communication.`);
                            }
                        }
                    } catch (error) {
                        if (error.code === 'ENOENT') {
                        } else if (error instanceof SyntaxError) {
                            console.warn(`[PluginManager] Invalid JSON in ${manifestPath}. Skipping ${folder.name}.`);
                        } else {
                            console.error(`[PluginManager] Error loading plugin from ${folder.name}:`, error);
                        }
                    }
                }
            }
            this.buildVCPDescription(); 
            console.log(`[PluginManager] Plugin discovery finished. Loaded ${this.plugins.size} plugins.`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.error(`[PluginManager] Plugin directory ${PLUGIN_DIR} not found.`);
            } else {
                console.error('[PluginManager] Error reading plugin directory:', error);
            }
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
        console.log(overallLog.join('\n'));
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

async processToolCall(toolName, toolArgs) {
        const plugin = this.plugins.get(toolName);
        if (!plugin) {
            throw new Error(`[PluginManager] Plugin "${toolName}" not found for tool call.`);
        }

        // 根据插件类型和约定准备执行参数
        // 目前我们主要处理 synchronous stdio 插件
        if (plugin.pluginType !== 'synchronous' || plugin.communication?.protocol !== 'stdio') {
            throw new Error(`[PluginManager] Plugin "${toolName}" is not a supported synchronous stdio plugin for direct tool call.`);
        }

        let executionParam = null;
        // toolArgs 来自 server.js 的 parsedToolArgs (一个对象)
        if (toolName === "SciCalculator") {
            if (toolArgs && typeof toolArgs.expression === 'string') {
                executionParam = toolArgs.expression;
            } else {
                throw new Error(`[PluginManager] Missing or invalid 'expression' (string) argument for SciCalculator in toolArgs.`);
            }
        } else if (toolName === "FluxGen") {
            // FluxGen 期望一个 JSON 字符串, toolArgs 应该是包含 prompt 和 resolution 的对象
            if (toolArgs && typeof toolArgs === 'object' && typeof toolArgs.prompt === 'string' && typeof toolArgs.resolution === 'string') {
                executionParam = JSON.stringify(toolArgs);
            } else {
                 throw new Error(`[PluginManager] Invalid or incomplete arguments for FluxGen in toolArgs. Expected an object with string 'prompt' and 'resolution'. Received: ${JSON.stringify(toolArgs)}`);
            }
        } else {
            // 对于其他插件，如果它们也期望通过 stdin 接收 JSON 字符串化的参数
            if (toolArgs && typeof toolArgs === 'object' && Object.keys(toolArgs).length > 0) {
                executionParam = JSON.stringify(toolArgs);
            } else if (typeof toolArgs === 'string' && toolArgs.trim() !== '') {
                // 如果已经是字符串，直接使用 (假设插件能处理)
                executionParam = toolArgs;
            }
            // 如果 toolArgs 是 null 或 undefined，executionParam 也会是 null，executePlugin 会处理
        }
        const logParam = executionParam ? (executionParam.length > 100 ? executionParam.substring(0,100) + '...' : executionParam) : null;
        console.log(`[PluginManager processToolCall] Calling executePlugin for: ${toolName} with prepared param:`, logParam);
        
        try {
            const pluginOutput = await this.executePlugin(toolName, executionParam); // executePlugin now returns {status, result/error}
            if (pluginOutput.status === "success") {
                return pluginOutput.result; // Return the formatted result string directly
            } else {
                // If plugin itself reported an error via JSON, throw that.
                throw new Error(pluginOutput.error || `Plugin "${toolName}" reported an unspecified error.`);
            }
        } catch (e) {
            // Catch errors from executePlugin (e.g., process spawn error, timeout) or the error thrown above
            console.error(`[PluginManager processToolCall] Error during execution or processing result for plugin ${toolName}:`, e.message);
            throw e; // Re-throw to be caught by server.js
        }
    }

    async executePlugin(pluginName, inputData) {
        const plugin = this.plugins.get(pluginName);
        if (!plugin) {
            // This case should ideally be caught by processToolCall before calling executePlugin
            throw new Error(`[PluginManager executePlugin] Plugin "${pluginName}" not found.`);
        }
        // Validations for pluginType, communication, entryPoint remain important
        if (plugin.pluginType !== 'synchronous' || plugin.communication?.protocol !== 'stdio') {
            throw new Error(`[PluginManager executePlugin] Plugin "${pluginName}" not a supported sync stdio plugin.`);
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
            console.warn("[PluginManager executePlugin] projectBasePath not set, PROJECT_BASE_PATH will not be available to plugins.");
        }
        if (process.env.PORT) {
            additionalEnv.SERVER_PORT = process.env.PORT;
        }
        const imageServerKey = this.getResolvedPluginConfigValue('ImageServer', 'Image_Key');
        if (imageServerKey) {
            additionalEnv.IMAGESERVER_IMAGE_KEY = imageServerKey;
        }
        
        // Force Python stdio encoding to UTF-8
        additionalEnv.PYTHONIOENCODING = 'utf-8';
        const finalEnv = { ...envForProcess, ...additionalEnv };

        return new Promise((resolve, reject) => {
            console.log(`[PluginManager executePlugin Internal] For plugin "${pluginName}", manifest entryPoint command is: "${plugin.entryPoint.command}"`);
            const [command, ...args] = plugin.entryPoint.command.split(' ');
            console.log(`[PluginManager executePlugin Internal] Attempting to spawn command: "${command}" with args: [${args.join(', ')}] in cwd: ${plugin.basePath}`);

            const pluginProcess = spawn(command, args, { cwd: plugin.basePath, shell: true, env: finalEnv });
            let output = '';
            let errorOutput = ''; // For stderr from the process itself
            let processExited = false;
            const timeoutDuration = plugin.communication.timeout || 5000;
            const timeoutId = setTimeout(() => {
                if (!processExited) {
                    console.error(`[PluginManager executePlugin Internal] Plugin "${pluginName}" timed out after ${timeoutDuration}ms.`);
                    pluginProcess.kill('SIGKILL');
                    reject(new Error(`Plugin "${pluginName}" execution timed out.`)); // This error will be caught by processToolCall
                }
            }, timeoutDuration);

            pluginProcess.stdout.setEncoding('utf8'); // Specify UTF-8 encoding
            pluginProcess.stdout.on('data', (data) => { output += data; }); // No need for toString() anymore
            pluginProcess.stderr.setEncoding('utf8'); // Specify UTF-8 encoding
            pluginProcess.stderr.on('data', (data) => { errorOutput += data; }); // No need for toString() anymore

            pluginProcess.on('error', (err) => { // Errors in spawning the process
                processExited = true; clearTimeout(timeoutId);
                reject(new Error(`Failed to start plugin "${pluginName}": ${err.message}`));
            });
            
            pluginProcess.on('exit', (code, signal) => {
                processExited = true; clearTimeout(timeoutId);
                if (signal === 'SIGKILL') return; // Already handled by timeout rejection

                // Regardless of exit code, try to parse stdout as JSON first,
                // as the plugin is now expected to always output JSON.
                try {
                    const parsedOutput = JSON.parse(output.trim());
                    if (parsedOutput && (parsedOutput.status === "success" || parsedOutput.status === "error")) {
                        // If plugin exited with non-zero but provided valid JSON error
                        if (code !== 0 && parsedOutput.status === "success") {
                             console.warn(`[PluginManager executePlugin Internal] Plugin "${pluginName}" exited with code ${code} but reported success in JSON. Trusting JSON.`);
                        }
                        // If plugin exited 0 but reported error in JSON
                        if (code === 0 && parsedOutput.status === "error") {
                            console.warn(`[PluginManager executePlugin Internal] Plugin "${pluginName}" exited with code 0 but reported error in JSON. Trusting JSON.`);
                        }
                        resolve(parsedOutput); // Resolve with the parsed {status, result/error} object
                        return;
                    }
                    // If JSON is not in the expected format, fall through to error handling based on exit code
                    console.warn(`[PluginManager executePlugin Internal] Plugin "${pluginName}" stdout was not in the expected JSON format: ${output.trim().substring(0,100)}`);
                } catch (e) {
                    // JSON parsing failed. This is an issue if the plugin was supposed to output JSON.
                    // Proceed to handle based on exit code, but log this parsing failure.
                    console.warn(`[PluginManager executePlugin Internal] Failed to parse stdout JSON from plugin "${pluginName}". Error: ${e.message}. Stdout: ${output.trim().substring(0,100)}`);
                }

                // Fallback error handling if JSON parsing failed or wasn't as expected
                if (code !== 0) {
                    let detailedError = `Plugin "${pluginName}" exited with code ${code}.`;
                    if (output.trim()) detailedError += ` Stdout: ${output.trim().substring(0, 200)}`;
                    if (errorOutput.trim()) detailedError += ` Stderr: ${errorOutput.trim().substring(0, 200)}`;
                    // Reject with an error object that processToolCall can then convert to the plugin's error format if needed,
                    // or just use the message. For now, just the message.
                    reject(new Error(detailedError));
                } else {
                    // Exit code 0, but JSON parsing failed or was not in the expected {status: 'success'} format.
                    // This is problematic. Report as an error.
                    if (errorOutput.trim()) {
                        console.warn(`[PluginManager executePlugin Internal] Plugin "${pluginName}" (exit code 0) produced stderr: ${errorOutput.trim()}`);
                    }
                    reject(new Error(`Plugin "${pluginName}" exited successfully but did not provide a valid JSON response. Stdout: ${output.trim().substring(0,200)}`));
                }
            });

            try {
                if (inputData !== undefined && inputData !== null) {
                    pluginProcess.stdin.write(inputData.toString());
                }
                pluginProcess.stdin.end();
            } catch (e) {
                console.error(`[PluginManager executePlugin Internal] Stdin write error for "${pluginName}": ${e.message}`);
                // This error should also be caught by processToolCall
                reject(new Error(`Stdin write error for "${pluginName}": ${e.message}`));
            }
        });
    }

    initializeServices(app, projectBasePath) {
        if (!app) {
            console.error('[PluginManager] Cannot initialize services without Express app instance.');
            return;
        }
        if (!projectBasePath) {
            console.error('[PluginManager] Cannot initialize services without projectBasePath.');
            return;
        }
        console.log('[PluginManager] Initializing service plugins...');
        for (const [name, serviceData] of this.serviceModules) {
            try {
                const pluginConfig = this._getPluginConfig(serviceData.manifest);
                // console.log(`[PluginManager] Registering routes for service plugin: ${name} with config:`, pluginConfig); // Sensitive
                const debugMode = typeof pluginConfig.DebugMode === 'boolean' ? pluginConfig.DebugMode : 'N/A';
                console.log(`[PluginManager] Registering routes for service plugin: ${name}. DebugMode: ${debugMode}`);
                serviceData.module.registerRoutes(app, pluginConfig, projectBasePath);
            } catch (e) {
                console.error(`[PluginManager] Error initializing service plugin ${name}:`, e);
            }
        }
        console.log('[PluginManager] Service plugins initialized.');
    }
}

const pluginManager = new PluginManager();
module.exports = pluginManager;