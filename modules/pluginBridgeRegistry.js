'use strict';

const jevClient = require('./jevClient');

class PluginDependencyBridgeRegistry {
    constructor() {
        this.bridges = [];
    }

    register(bridge) {
        validateBridge(bridge, 'inject');
        this.bridges.push(normalizeBridge(bridge));
        this.bridges.sort(compareBridges);
        return this;
    }

    async buildDependencies(manifest, baseDependencies, context) {
        const dependencies = { ...baseDependencies };
        for (const bridge of this.bridges) {
            if (await bridge.canHandle(manifest, context)) {
                await bridge.inject(manifest, dependencies, context);
            }
        }
        return dependencies;
    }

    list() {
        return this.bridges.map(({ name, priority }) => ({ name, priority }));
    }
}

class PluginExecutionBridgeRegistry {
    constructor() {
        this.bridges = [];
    }

    register(bridge) {
        validateBridge(bridge, 'execute');
        this.bridges.push(normalizeBridge(bridge));
        this.bridges.sort(compareBridges);
        return this;
    }

    async execute(plugin, toolArgs, context) {
        for (const bridge of this.bridges) {
            if (await bridge.canHandle(plugin, context)) {
                if (context.debugMode) {
                    console.log(`[PluginManager] Executing "${plugin.name}" through bridge "${bridge.name}".`);
                }
                return bridge.execute(plugin, toolArgs, context);
            }
        }

        throw new Error(
            `[PluginManager] No execution bridge can handle local plugin "${plugin.name}" ` +
            `(type: ${plugin.pluginType}, protocol: ${plugin.communication?.protocol}).`
        );
    }

    list() {
        return this.bridges.map(({ name, priority }) => ({ name, priority }));
    }
}

function validateBridge(bridge, operationName) {
    if (!bridge || typeof bridge !== 'object') {
        throw new TypeError('Plugin bridge must be an object.');
    }
    if (!bridge.name || typeof bridge.name !== 'string') {
        throw new TypeError('Plugin bridge must have a non-empty name.');
    }
    if (typeof bridge.canHandle !== 'function') {
        throw new TypeError(`Plugin bridge "${bridge.name}" must define canHandle().`);
    }
    if (typeof bridge[operationName] !== 'function') {
        throw new TypeError(`Plugin bridge "${bridge.name}" must define ${operationName}().`);
    }
}

function normalizeBridge(bridge) {
    return {
        ...bridge,
        priority: Number.isFinite(Number(bridge.priority)) ? Number(bridge.priority) : 0
    };
}

function compareBridges(left, right) {
    return right.priority - left.priority || left.name.localeCompare(right.name);
}

function createDefaultDependencyBridgeRegistry() {
    const registry = new PluginDependencyBridgeRegistry();

    registry.register({
        name: 'knowledge-base',
        priority: 100,
        canHandle: manifest => (
            manifest.requiresKnowledgeBaseManager === true ||
            manifest.name === 'RAGDiaryPlugin' ||
            manifest.name === 'DailyNote' ||
            manifest.name === 'DailyNoteManager'
        ),
        inject: (_manifest, dependencies, context) => {
            dependencies.vectorDBManager = context.vectorDBManager;
            dependencies.knowledgeBaseManager = context.vectorDBManager;
        }
    });

    registry.register({
        name: 'rag-diary-cold-knowledge',
        priority: 90,
        canHandle: manifest => manifest.name === 'RAGDiaryPlugin',
        inject: (manifest, dependencies, context) => {
            if (!context.tdbKnowledgeManager) return;
            dependencies.tdbKnowledgeManager = context.tdbKnowledgeManager;
            context.debugLog(`🧊 Injected TDBKnowledgeManager into ${manifest.name}.`);
        }
    });

    registry.register({
        name: 'jev-client',
        priority: 80,
        canHandle: manifest => manifest.requiresJevClient === true,
        inject: (manifest, dependencies, context) => {
            dependencies.jevClient = jevClient;
            context.debugLog(`Injected JevClient into ${manifest.name}.`);
        }
    });

    registry.register({
        name: 'context-bridge',
        priority: 70,
        canHandle: manifest => manifest.requiresContextBridge === true,
        inject: (manifest, dependencies, context) => {
            const ragPluginModule = context.getMessagePreprocessor('RAGDiaryPlugin');
            if (ragPluginModule && typeof ragPluginModule.getContextBridge === 'function') {
                dependencies.contextBridge = ragPluginModule.getContextBridge();
                context.debugLog(`🌟 Injected ContextBridge into ${manifest.name}.`);
                return;
            }
            console.warn(
                `[PluginManager] Plugin "${manifest.name}" requires ContextBridge, ` +
                'but RAGDiaryPlugin is not available.'
            );
        }
    });

    registry.register({
        name: 'light-memo-compatibility',
        priority: 60,
        canHandle: manifest => manifest.name === 'LightMemo',
        inject: (_manifest, dependencies, context) => {
            const ragPluginModule = context.getMessagePreprocessor('RAGDiaryPlugin');
            if (
                ragPluginModule &&
                ragPluginModule.vectorDBManager &&
                typeof ragPluginModule.getSingleEmbedding === 'function'
            ) {
                dependencies.vectorDBManager = ragPluginModule.vectorDBManager;
                dependencies.getSingleEmbedding =
                    ragPluginModule.getSingleEmbedding.bind(ragPluginModule);

                if (typeof ragPluginModule.getBatchEmbeddingsCached === 'function') {
                    dependencies.getBatchEmbeddings =
                        ragPluginModule.getBatchEmbeddingsCached.bind(ragPluginModule);
                } else if (typeof ragPluginModule.getBatchEmbeddings === 'function') {
                    dependencies.getBatchEmbeddings =
                        ragPluginModule.getBatchEmbeddings.bind(ragPluginModule);
                }

                if (
                    !dependencies.contextBridge &&
                    typeof ragPluginModule.getContextBridge === 'function'
                ) {
                    dependencies.contextBridge = ragPluginModule.getContextBridge();
                }

                if (typeof ragPluginModule.getAIMemoBridge === 'function') {
                    dependencies.aiMemoBridge = ragPluginModule.getAIMemoBridge();
                }

                context.debugLog(
                    'Injected VectorDBManager, embeddings, ContextBridge and ' +
                    'AIMemoBridge into LightMemo.'
                );
            } else {
                console.error(
                    '[PluginManager] Critical dependency failure: RAGDiaryPlugin or its ' +
                    'components not available for LightMemo injection.'
                );
            }

            if (context.tdbKnowledgeManager) {
                dependencies.tdbKnowledgeManager = context.tdbKnowledgeManager;
                context.debugLog('Injected TDBKnowledgeManager into LightMemo.');
            }
        }
    });

    return registry;
}

function createDefaultExecutionBridgeRegistry() {
    const registry = new PluginExecutionBridgeRegistry();

    registry.register({
        name: 'distributed',
        priority: 400,
        canHandle: plugin => plugin.isDistributed === true,
        execute: async (plugin, toolArgs, context) => {
            if (!context.webSocketServer) {
                throw new Error(
                    '[PluginManager] WebSocketServer is not initialized. ' +
                    'Cannot call distributed tool.'
                );
            }
            context.debugLog(
                `Processing distributed tool call for: ${context.toolName} ` +
                `on server ${plugin.serverId}`
            );
            const result = await context.webSocketServer.executeDistributedTool(
                plugin.serverId,
                context.toolName,
                toolArgs
            );
            return { result };
        }
    });

    registry.register({
        name: 'chrome-control-websocket',
        priority: 300,
        canHandle: plugin => (
            plugin.name === 'ChromeControl' &&
            plugin.communication?.protocol === 'direct'
        ),
        execute: async (_plugin, toolArgs, context) => {
            if (!context.webSocketServer) {
                throw new Error(
                    '[PluginManager] WebSocketServer is not initialized. ' +
                    'Cannot call ChromeControl tool.'
                );
            }
            context.debugLog(
                `Processing direct WebSocket tool call for: ${context.toolName}`
            );
            const forwardedArgs = { ...toolArgs };
            const command = forwardedArgs.command;
            delete forwardedArgs.command;
            const result = await context.webSocketServer.forwardCommandToChrome(
                command,
                forwardedArgs
            );
            return { result };
        }
    });

    registry.register({
        name: 'direct-hybrid-service',
        priority: 200,
        canHandle: plugin => (
            plugin.pluginType === 'hybridservice' &&
            plugin.communication?.protocol === 'direct'
        ),
        execute: async (plugin, toolArgs, context) => {
            context.debugLog(
                `Processing direct tool call for hybrid service: ${context.toolName}`
            );
            const serviceModule = context.getServiceModule(context.toolName);
            if (!serviceModule) {
                throw new Error(
                    `[PluginManager] Hybrid service plugin "${context.toolName}" module ` +
                    'not found. It may have failed to load or initialize during hot-reload.'
                );
            }
            if (typeof serviceModule.processToolCall !== 'function') {
                throw new Error(
                    `[PluginManager] Hybrid service plugin "${context.toolName}" does not ` +
                    'have a processToolCall function.'
                );
            }

            const directContext = {
                requestIp: context.requestIp,
                sourceNode: context.sourceNode,
                pluginName: context.toolName
            };

            if (plugin.requiresAdmin) {
                const decryptedCode = await context.getDecryptedAuthCode();
                if (!decryptedCode) {
                    console.error(
                        `[PluginManager] Failed to obtain auth code for admin-required ` +
                        `hybrid plugin: ${context.toolName}. Execution denied.`
                    );
                    throw new Error(JSON.stringify({
                        plugin_error:
                            `Plugin "${context.toolName}" requires admin authentication, ` +
                            'but auth code could not be obtained. Execution denied.'
                    }));
                }
                directContext.decryptedAuthCode = decryptedCode;
                context.debugLog(
                    `Provided decrypted auth context for admin-required hybrid plugin: ` +
                    context.toolName
                );
            }

            const result = await context.executeDirectWithTimeout(
                plugin,
                context.toolName,
                serviceModule,
                toolArgs,
                directContext
            );
            return { result };
        }
    });

    registry.register({
        name: 'local-stdio',
        priority: 100,
        canHandle: plugin => (
            (plugin.pluginType === 'synchronous' ||
                plugin.pluginType === 'asynchronous') &&
            plugin.communication?.protocol === 'stdio'
        ),
        execute: async (plugin, toolArgs, context) => {
            const executionParam = Object.keys(toolArgs).length > 0
                ? JSON.stringify(toolArgs)
                : null;
            const logParam = executionParam && executionParam.length > 100
                ? `${executionParam.substring(0, 100)}...`
                : executionParam;
            context.debugLog(
                `Calling local executePlugin for: ${context.toolName} with prepared param:`,
                logParam
            );

            if (context.toolName === 'VCPSleep') {
                context.triggerSleepDream(plugin, toolArgs);
            }

            const pluginOutput = await context.executeStdio(
                context.toolName,
                executionParam,
                context.requestIp,
                context.executionOptions
            );

            if (pluginOutput.__vcpArcheryNoReplySilent) {
                return { shortCircuitResult: pluginOutput.result };
            }

            if (pluginOutput.status !== 'success') {
                const normalizedPluginOutput = {};
                if (pluginOutput.result) {
                    normalizedPluginOutput.result = pluginOutput.result;
                }
                normalizedPluginOutput.plugin_error =
                    pluginOutput.error ||
                    `Plugin "${context.toolName}" reported an unspecified error.`;
                context.filterFuzzyDiff(
                    normalizedPluginOutput,
                    context.getTimestamp()
                );
                throw new Error(JSON.stringify(normalizedPluginOutput));
            }

            if (typeof pluginOutput.result !== 'string') {
                return { result: pluginOutput.result };
            }

            try {
                return { result: JSON.parse(pluginOutput.result) };
            } catch (_parseError) {
                context.debugWarn(
                    `Local plugin ${context.toolName} result string was not valid JSON. ` +
                    `Original: "${pluginOutput.result.substring(0, 100)}"`
                );
                return {
                    result: { original_plugin_output: pluginOutput.result }
                };
            }
        }
    });

    return registry;
}

module.exports = {
    PluginDependencyBridgeRegistry,
    PluginExecutionBridgeRegistry,
    createDefaultDependencyBridgeRegistry,
    createDefaultExecutionBridgeRegistry
};