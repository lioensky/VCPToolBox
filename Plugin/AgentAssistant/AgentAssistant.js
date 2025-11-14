// AgentAssistant.js (Service Module)
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const chokidar = require('chokidar');

// --- State and Config Variables ---
let VCP_SERVER_PORT;
let VCP_SERVER_ACCESS_KEY;
let MAX_HISTORY_ROUNDS;
let CONTEXT_TTL_HOURS;
let DEBUG_MODE;
let VCP_API_TARGET_URL;

const AGENTS = {};
const agentContexts = new Map();
let pushVcpInfo = () => {}; // Default no-op function
let cleanupInterval;
let configWatcher = null; // File watcher for config hot reload

// --- Configuration File Paths ---
const AGENT_ASSISTANT_CONFIG_JSON = path.join(__dirname, 'agent_assistant_config.json');
const PLUGIN_CONFIG_ENV_PATH = path.join(__dirname, 'config.env'); // Legacy ENV config path

// API Configuration validation
let API_KEY, API_URL;

// --- Core Module Functions ---

/**
 * Initializes the AgentAssistant service module.
 * This is called by the PluginManager when the plugin is loaded.
 * @param {object} config - The configuration object passed from PluginManager.
 * @param {object} dependencies - An object containing dependencies, like vcpLogFunctions.
 */
function initialize(config, dependencies) {
    VCP_SERVER_PORT = config.PORT;
    VCP_SERVER_ACCESS_KEY = config.Key;
    MAX_HISTORY_ROUNDS = parseInt(config.AGENT_ASSISTANT_MAX_HISTORY_ROUNDS || '7', 10);
    CONTEXT_TTL_HOURS = parseInt(config.AGENT_ASSISTANT_CONTEXT_TTL_HOURS || '24', 10);
    DEBUG_MODE = String(config.DebugMode || 'false').toLowerCase() === 'true';
    VCP_API_TARGET_URL = `http://localhost:${VCP_SERVER_PORT}/v1`;

    // 验证API配置 - 修复AgentAssistant配置读取问题
    API_KEY = process.env.API_Key;
    API_URL = process.env.API_URL;

    if (DEBUG_MODE) {
        console.error('[AgentAssistant] === API配置验证 ===');
        console.error(`[AgentAssistant] API_KEY: ${API_KEY ? '已配置 (' + API_KEY.substring(0, 10) + '...)' : '未配置'}`);
        console.error(`[AgentAssistant] API_URL: ${API_URL || '未配置'}`);
        console.error(`[AgentAssistant] WhitelistImageModel: ${process.env.WhitelistImageModel || '未配置'}`);
        console.error('[AgentAssistant] ====================');
    }

    if (DEBUG_MODE) {
        console.error(`[AgentAssistant Service] Initializing...`);
        console.error(`[AgentAssistant Service] VCP PORT: ${VCP_SERVER_PORT}, VCP Key: ${VCP_SERVER_ACCESS_KEY ? 'FOUND' : 'NOT FOUND'}`);
        console.error(`[AgentAssistant Service] History rounds: ${MAX_HISTORY_ROUNDS}, Context TTL: ${CONTEXT_TTL_HOURS}h.`);
    }

    loadAgentsFromLocalConfig();

    // Set up configuration file watcher for hot reload
    setupConfigWatcher();

    if (dependencies && dependencies.vcpLogFunctions && typeof dependencies.vcpLogFunctions.pushVcpInfo === 'function') {
        pushVcpInfo = dependencies.vcpLogFunctions.pushVcpInfo;
        if (DEBUG_MODE) console.error('[AgentAssistant Service] pushVcpInfo dependency injected successfully.');
    } else {
        console.error('[AgentAssistant Service] Warning: pushVcpInfo dependency injection failed. Broadcasts will be ignored.');
    }

    if (cleanupInterval) clearInterval(cleanupInterval);
    cleanupInterval = setInterval(periodicCleanup, 60 * 60 * 1000);

    // Output configuration status in debug mode
    if (DEBUG_MODE) {
        const configStatus = getConfigStatus();
        console.error(`[AgentAssistant] Configuration Status:`, configStatus);
    }

    console.log('[AgentAssistant Service] Initialized successfully.');
}

/**
 * Shuts down the service, clearing any intervals and watchers.
 */
function shutdown() {
    // Clear context cleanup interval
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        if (DEBUG_MODE) console.error('[AgentAssistant Service] Context cleanup interval stopped.');
    }

    // Close configuration file watcher
    if (configWatcher) {
        configWatcher.close();
        configWatcher = null;
        if (DEBUG_MODE) console.error('[AgentAssistant Service] Configuration file watcher closed.');
    }

    // Clear fallback polling interval
    if (typeof global.agentAssistantPollInterval !== 'undefined') {
        clearInterval(global.agentAssistantPollInterval);
        delete global.agentAssistantPollInterval;
        if (DEBUG_MODE) console.error('[AgentAssistant Service] Fallback polling interval cleared.');
    }

    console.log('[AgentAssistant Service] Shutdown complete.');
}


/**
 * Compares two agent configurations for equality
 * @param {object} envConfig - Configuration from ENV format
 * @param {object} jsonConfig - Configuration from JSON format
 * @returns {boolean} - True if configurations are equivalent
 */
function configsAreEqual(envConfig, jsonConfig) {
    try {
        // Get agent base names from ENV config
        const envAgentBaseNames = new Set();
        for (const key in envConfig) {
            if (key.startsWith('AGENT_') && key.endsWith('_MODEL_ID')) {
                const nameMatch = key.match(/^AGENT_([A-Z0-9_]+)_MODEL_ID$/i);
                if (nameMatch && nameMatch[1]) envAgentBaseNames.add(nameMatch[1].toUpperCase());
            }
        }

        // Check if agent count matches
        if (envAgentBaseNames.size !== jsonConfig.agents.length) {
            if (DEBUG_MODE) {
                console.error(`[AgentAssistant] Agent count mismatch: ENV has ${envAgentBaseNames.size}, JSON has ${jsonConfig.agents.length}`);
            }
            return false;
        }

        // Compare each agent configuration
        for (const baseName of envAgentBaseNames) {
            const jsonAgent = jsonConfig.agents.find(agent =>
                agent.baseName.toUpperCase() === baseName
            );

            if (!jsonAgent) {
                if (DEBUG_MODE) {
                    console.error(`[AgentAssistant] Agent ${baseName} missing in JSON config`);
                }
                return false;
            }

            // Compare key fields
            const envModelId = envConfig[`AGENT_${baseName}_MODEL_ID`];
            const envChineseName = envConfig[`AGENT_${baseName}_CHINESE_NAME`];
            const envSystemPrompt = envConfig[`AGENT_${baseName}_SYSTEM_PROMPT`] || `You are {{MaidName}}.`;
            const envMaxTokens = parseInt(envConfig[`AGENT_${baseName}_MAX_OUTPUT_TOKENS`] || '40000', 10);
            const envTemperature = parseFloat(envConfig[`AGENT_${baseName}_TEMPERATURE`] || '0.7');
            const envDescription = envConfig[`AGENT_${baseName}_DESCRIPTION`] || `Assistant ${envChineseName}.`;

            if (
                jsonAgent.modelId !== envModelId ||
                jsonAgent.chineseName !== envChineseName ||
                jsonAgent.systemPrompt !== envSystemPrompt ||
                jsonAgent.maxOutputTokens !== envMaxTokens ||
                Math.abs(jsonAgent.temperature - envTemperature) > 0.001 ||
                jsonAgent.description !== envDescription
            ) {
                if (DEBUG_MODE) {
                    console.error(`[AgentAssistant] Agent ${baseName} configuration mismatch detected`);
                    console.error(`[AgentAssistant] ENV: modelId=${envModelId}, chineseName=${envChineseName}`);
                    console.error(`[AgentAssistant] JSON: modelId=${jsonAgent.modelId}, chineseName=${jsonAgent.chineseName}`);
                }
                return false;
            }
        }

        return true;
    } catch (error) {
        if (DEBUG_MODE) {
            console.error(`[AgentAssistant] Error comparing configs:`, error.message);
        }
        return false;
    }
}

}

/**
 * Migrates configuration from ENV format to JSON format if needed.
 * This ensures backward compatibility while standardizing on JSON format.
 */
function migrateConfigIfNeeded() {
    // Check if ENV config exists
    if (!fs.existsSync(PLUGIN_CONFIG_ENV_PATH)) {
        if (DEBUG_MODE) {
            console.error(`[AgentAssistant] No ENV config found - using empty config or existing JSON`);
        }
        return; // No ENV config to migrate from
    }

    let needsMigration = false;
    let shouldCompare = false;

    // If JSON config doesn't exist, migration is needed
    if (!fs.existsSync(AGENT_ASSISTANT_CONFIG_JSON)) {
        if (DEBUG_MODE) {
            console.error(`[AgentAssistant] JSON config doesn't exist - migration needed`);
        }
        needsMigration = true;
    } else {
        // JSON exists, but we need to check if it's valid and up-to-date
        try {
            const jsonContent = fs.readFileSync(AGENT_ASSISTANT_CONFIG_JSON, 'utf8');
            const jsonConfig = JSON.parse(jsonContent);

            if (!jsonConfig.agents || !Array.isArray(jsonConfig.agents) || jsonConfig.agents.length === 0) {
                // JSON exists but is invalid or empty
                if (DEBUG_MODE) {
                    console.error(`[AgentAssistant] JSON config exists but is invalid/empty - migration needed`);
                }
                needsMigration = true;
            } else {
                // JSON is valid, but we should compare with ENV to check for changes
                shouldCompare = true;
            }
        } catch (error) {
            // JSON exists but is malformed
            if (DEBUG_MODE) {
                console.error(`[AgentAssistant] JSON config exists but is malformed - migration needed:`, error.message);
            }
            needsMigration = true;
        }
    }

    // If we need to compare configurations, load both and check for differences
    if (shouldCompare) {
        try {
            // Load ENV config
            const envFileContent = fs.readFileSync(PLUGIN_CONFIG_ENV_PATH, 'utf8');
            const envConfig = dotenv.parse(envFileContent);

            // Load JSON config
            const jsonContent = fs.readFileSync(AGENT_ASSISTANT_CONFIG_JSON, 'utf8');
            const jsonConfig = JSON.parse(jsonContent);

            // Compare configurations
            if (!configsAreEqual(envConfig, jsonConfig)) {
                if (DEBUG_MODE) {
                    console.error(`[AgentAssistant] Configuration changes detected - performing migration`);
                }
                needsMigration = true;
            } else {
                if (DEBUG_MODE) {
                    console.error(`[AgentAssistant] Configurations are identical - no migration needed`);
                }
                return; // No migration needed
            }
        } catch (error) {
            if (DEBUG_MODE) {
                console.error(`[AgentAssistant] Error comparing configurations - performing migration:`, error.message);
            }
            needsMigration = true;
        }
    }

    // If migration is needed, proceed with it
    if (!needsMigration) {
        return;
    }

    if (DEBUG_MODE) {
        console.error(`[AgentAssistant] Starting migration from ENV config to JSON format...`);
    }

    try {
        // Load agents from ENV (existing logic)
        const fileContent = fs.readFileSync(PLUGIN_CONFIG_ENV_PATH, 'utf8');
        const pluginLocalEnvConfig = dotenv.parse(fileContent);

        const AGENT_ALL_SYSTEM_PROMPT = pluginLocalEnvConfig.AGENT_ALL_SYSTEM_PROMPT || "";
        const agentBaseNames = new Set();

        // Identify agent base names from environment variables
        for (const key in pluginLocalEnvConfig) {
            if (key.startsWith('AGENT_') && key.endsWith('_MODEL_ID')) {
                const nameMatch = key.match(/^AGENT_([A-Z0-9_]+)_MODEL_ID$/i);
                if (nameMatch && nameMatch[1]) agentBaseNames.add(nameMatch[1].toUpperCase());
            }
        }

        // Convert ENV config to JSON format
        const agents = [];
        for (const baseName of agentBaseNames) {
            const modelId = pluginLocalEnvConfig[`AGENT_${baseName}_MODEL_ID`];
            const chineseName = pluginLocalEnvConfig[`AGENT_${baseName}_CHINESE_NAME`];

            if (!modelId || !chineseName) {
                if (DEBUG_MODE) {
                    console.error(`[AgentAssistant] Skipping agent ${baseName}: Missing MODEL_ID or CHINESE_NAME.`);
                }
                continue;
            }

            const agentConfig = {
                baseName: baseName,
                chineseName: chineseName,
                modelId: modelId,
                systemPrompt: pluginLocalEnvConfig[`AGENT_${baseName}_SYSTEM_PROMPT`] || `You are {{MaidName}}.`,
                maxOutputTokens: parseInt(pluginLocalEnvConfig[`AGENT_${baseName}_MAX_OUTPUT_TOKENS`] || '40000', 10),
                temperature: parseFloat(pluginLocalEnvConfig[`AGENT_${baseName}_TEMPERATURE`] || '0.7'),
                description: pluginLocalEnvConfig[`AGENT_${baseName}_DESCRIPTION`] || `Assistant ${chineseName}.`
            };

            agents.push(agentConfig);

            if (DEBUG_MODE) {
                console.error(`[AgentAssistant] Migrated agent: '${chineseName}' (Base: ${baseName}, ModelID: ${modelId})`);
            }
        }

        // Create JSON config structure
        const jsonConfig = {
            agents: agents,
            globalSystemPrompt: AGENT_ALL_SYSTEM_PROMPT,
            migratedAt: new Date().toISOString(),
            migrationVersion: "1.0",
            migratedFrom: "config.env"
        };

        // Write JSON config file
        const jsonString = JSON.stringify(jsonConfig, null, 2);
        fs.writeFileSync(AGENT_ASSISTANT_CONFIG_JSON, jsonString, 'utf8');

        if (DEBUG_MODE) {
            console.error(`[AgentAssistant] ✅ Migration completed successfully!`);
            console.error(`[AgentAssistant] Migrated ${agents.length} agents from ENV to JSON format`);
            console.error(`[AgentAssistant] JSON config saved to: ${AGENT_ASSISTANT_CONFIG_JSON}`);
        }

    } catch (error) {
        console.error(`[AgentAssistant] ❌ Migration failed:`, error.message);
        if (DEBUG_MODE) {
            console.error(`[AgentAssistant] Migration error details:`, error.stack);
        }
    }
}


/**
 * Loads agent definitions from configuration files with auto-migration support.
 * Priority: JSON config (auto-migrated from ENV if needed)
 */
function loadAgentsFromLocalConfig() {
    if (DEBUG_MODE) {
        console.error(`[AgentAssistant] Loading agents from configuration files...`);
        console.error(`[AgentAssistant] JSON config path: ${AGENT_ASSISTANT_CONFIG_JSON}`);
        console.error(`[AgentAssistant] ENV config path: ${PLUGIN_CONFIG_ENV_PATH}`);
    }

    // Clear existing agents first
    Object.keys(AGENTS).forEach(key => delete AGENTS[key]);

    // Step 1: Check if migration is needed and perform it
    migrateConfigIfNeeded();

    // Step 2: Load from JSON config (post-migration)
    if (fs.existsSync(AGENT_ASSISTANT_CONFIG_JSON)) {
        try {
            loadFromJSON(AGENT_ASSISTANT_CONFIG_JSON);
            if (DEBUG_MODE) {
                console.error(`[AgentAssistant] Successfully loaded ${Object.keys(AGENTS).length} agents from JSON config`);
            }
            return;
        } catch (error) {
            console.error(`[AgentAssistant] JSON config failed:`, error.message);
            if (DEBUG_MODE) {
                console.error(`[AgentAssistant] JSON config error details:`, error.stack);
            }
        }
    } else {
        console.error(`[AgentAssistant] No configuration found. Please create ${AGENT_ASSISTANT_CONFIG_JSON}`);
    }
}

/**
 * Loads agents from JSON configuration file
 * @param {string} jsonPath - Path to JSON config file
 */
function loadFromJSON(jsonPath) {
    const fileContent = fs.readFileSync(jsonPath, { encoding: 'utf8' });
    const config = JSON.parse(fileContent);

    // Validate config format
    if (!config.agents || !Array.isArray(config.agents)) {
        throw new Error('Invalid JSON config format: missing or invalid "agents" array');
    }

    const globalSystemPrompt = config.globalSystemPrompt || "";

    // Convert JSON config to standard AGENTS format
    for (const agentDef of config.agents) {
        // Validate required fields
        if (!agentDef.chineseName || !agentDef.modelId) {
            if (DEBUG_MODE) {
                console.error(`[AgentAssistant] Skipping agent: missing required fields (chineseName or modelId)`);
            }
            continue;
        }

        // Process system prompt with placeholders
        let finalSystemPrompt = agentDef.systemPrompt || 'You are {{MaidName}}.';
        finalSystemPrompt = finalSystemPrompt.replace(/\{\{MaidName\}\}/g, agentDef.chineseName);
        if (globalSystemPrompt) {
            finalSystemPrompt += `\n\n${globalSystemPrompt}`;
        }

        // Build standard AGENTS format
        AGENTS[agentDef.chineseName] = {
            id: agentDef.modelId,
            name: agentDef.chineseName,
            baseName: agentDef.baseName || agentDef.chineseName.toUpperCase().replace(/\s+/g, '_'),
            systemPrompt: finalSystemPrompt,
            maxOutputTokens: agentDef.maxOutputTokens || 40000,
            temperature: agentDef.temperature || 0.7,
            description: agentDef.description || `Assistant ${agentDef.chineseName}.`,
        };

        if (DEBUG_MODE) {
            console.error(`[AgentAssistant] Loaded JSON agent: '${agentDef.chineseName}' (Base: ${AGENTS[agentDef.chineseName].baseName}, ModelID: ${agentDef.modelId})`);
        }
    }
}

/**
 * Loads agents from ENV configuration file (legacy format)
 * @param {string} envPath - Path to ENV config file
 */
function loadFromEnv(envPath) {
    const fileContent = fs.readFileSync(envPath, { encoding: 'utf8' });
    const pluginLocalEnvConfig = dotenv.parse(fileContent);

    const AGENT_ALL_SYSTEM_PROMPT = pluginLocalEnvConfig.AGENT_ALL_SYSTEM_PROMPT || "";
    const agentBaseNames = new Set();

    // Identify agent base names from environment variables
    for (const key in pluginLocalEnvConfig) {
        if (key.startsWith('AGENT_') && key.endsWith('_MODEL_ID')) {
            const nameMatch = key.match(/^AGENT_([A-Z0-9_]+)_MODEL_ID$/i);
            if (nameMatch && nameMatch[1]) agentBaseNames.add(nameMatch[1].toUpperCase());
        }
    }

    if (DEBUG_MODE) {
        console.error(`[AgentAssistant] Identified agent base names: ${[...agentBaseNames].join(', ') || 'None'}`);
    }

    // Load each agent from ENV configuration
    for (const baseName of agentBaseNames) {
        const modelId = pluginLocalEnvConfig[`AGENT_${baseName}_MODEL_ID`];
        const chineseName = pluginLocalEnvConfig[`AGENT_${baseName}_CHINESE_NAME`];

        if (!modelId || !chineseName) {
            if (DEBUG_MODE) {
                console.error(`[AgentAssistant] Skipping agent ${baseName}: Missing MODEL_ID or CHINESE_NAME.`);
            }
            continue;
        }

        const systemPromptTemplate = pluginLocalEnvConfig[`AGENT_${baseName}_SYSTEM_PROMPT`] || `You are a helpful AI assistant named {{MaidName}}.`;
        let finalSystemPrompt = systemPromptTemplate.replace(/\{\{MaidName\}\}/g, chineseName);
        if (AGENT_ALL_SYSTEM_PROMPT) finalSystemPrompt += `\n\n${AGENT_ALL_SYSTEM_PROMPT}`;

        AGENTS[chineseName] = {
            id: modelId,
            name: chineseName,
            baseName: baseName,
            systemPrompt: finalSystemPrompt,
            maxOutputTokens: parseInt(pluginLocalEnvConfig[`AGENT_${baseName}_MAX_OUTPUT_TOKENS`] || '40000', 10),
            temperature: parseFloat(pluginLocalEnvConfig[`AGENT_${baseName}_TEMPERATURE`] || '0.7'),
            description: pluginLocalEnvConfig[`AGENT_${baseName}_DESCRIPTION`] || `Assistant ${chineseName}.`,
        };

        if (DEBUG_MODE) {
            console.error(`[AgentAssistant] Loaded ENV agent: '${chineseName}' (Base: ${baseName}, ModelID: ${modelId})`);
        }
    }

    if (Object.keys(AGENTS).length === 0 && DEBUG_MODE) {
        console.error("[AgentAssistant] Warning: No agents were loaded from ENV config.");
    }
}

/**
 * Sets up file watchers for configuration files to enable hot reload
 */
function setupConfigWatcher() {
    try {
        // Stop existing watcher if any
        if (configWatcher) {
            configWatcher.close();
            if (DEBUG_MODE) {
                console.error(`[AgentAssistant] Closed existing config watcher`);
            }
        }

        // Ensure the directory exists before watching
        const configDir = path.dirname(AGENT_ASSISTANT_CONFIG_JSON);
        if (!fs.existsSync(configDir)) {
            if (DEBUG_MODE) {
                console.error(`[AgentAssistant] Creating config directory: ${configDir}`);
            }
            fs.mkdirSync(configDir, { recursive: true });
        }

        // Watch JSON config file with enhanced options
        const configFiles = [AGENT_ASSISTANT_CONFIG_JSON];

        // Always try to watch the file, even if it doesn't exist yet
        configWatcher = chokidar.watch(configFiles, {
            persistent: true,
            ignoreInitial: true,
            usePolling: false, // Use native file system events
            interval: 100,
            binaryInterval: 300,
            awaitWriteFinish: {
                stabilityThreshold: 300, // Increased stability threshold
                pollInterval: 100
            }
        });

        let reloadInProgress = false;

        const performReload = (reason) => {
            if (reloadInProgress) {
                if (DEBUG_MODE) {
                    console.error(`[AgentAssistant] Reload already in progress, skipping...`);
                }
                return;
            }

            reloadInProgress = true;
            if (DEBUG_MODE) {
                console.error(`[AgentAssistant] Configuration reloaded: ${reason}`);
            }

            try {
                loadAgentsFromLocalConfig();
                if (DEBUG_MODE) {
                    const agentCount = Object.keys(AGENTS).length;
                    console.error(`[AgentAssistant] ✅ Reload completed. Currently loaded ${agentCount} agents`);
                }
            } catch (error) {
                console.error(`[AgentAssistant] ❌ Reload failed:`, error.message);
            } finally {
                // Use a timeout to prevent rapid successive reloads
                setTimeout(() => {
                    reloadInProgress = false;
                }, 500);
            }
        };

        configWatcher
            .on('change', (filePath) => {
                performReload(`file changed: ${path.basename(filePath)}`);
            })
            .on('unlink', (filePath) => {
                console.log(`[AgentAssistant] Configuration file deleted: ${path.basename(filePath)}`);
                performReload(`file deleted: ${path.basename(filePath)}`);
            })
            .on('add', (filePath) => {
                console.log(`[AgentAssistant] New configuration file detected: ${path.basename(filePath)}`);
                performReload(`file added: ${path.basename(filePath)}`);
            })
            .on('error', (error) => {
                console.error(`[AgentAssistant] File watcher error:`, error);
                // Try to recover by re-setting up the watcher
                setTimeout(() => {
                    if (DEBUG_MODE) {
                        console.error(`[AgentAssistant] Attempting to recover file watcher...`);
                    }
                    setupConfigWatcher();
                }, 5000);
            });

        if (DEBUG_MODE) {
            console.error(`[AgentAssistant] ✅ File watcher set up for config files: ${configFiles.join(', ')}`);
            console.error(`[AgentAssistant] Watching directory: ${configDir}`);
        }
    } catch (error) {
        console.error(`[AgentAssistant] ❌ Failed to set up config file watcher:`, error);

        // Fallback: try to set up a simple polling mechanism
        if (DEBUG_MODE) {
            console.error(`[AgentAssistant] Setting up fallback polling mechanism...`);
        }
        setupFallbackPolling();
    }
}

/**
 * Fallback polling mechanism for configuration changes
 */
function setupFallbackPolling() {
    let lastModified = 0;

    try {
        if (fs.existsSync(AGENT_ASSISTANT_CONFIG_JSON)) {
            const stats = fs.statSync(AGENT_ASSISTANT_CONFIG_JSON);
            lastModified = stats.mtime.getTime();
        }
    } catch (error) {
        // Ignore errors during initial check
    }

    const pollInterval = setInterval(() => {
        try {
            if (fs.existsSync(AGENT_ASSISTANT_CONFIG_JSON)) {
                const stats = fs.statSync(AGENT_ASSISTANT_CONFIG_JSON);
                const currentModified = stats.mtime.getTime();

                if (currentModified > lastModified) {
                    lastModified = currentModified;
                    if (DEBUG_MODE) {
                        console.error(`[AgentAssistant] Configuration change detected by polling`);
                    }
                    loadAgentsFromLocalConfig();
                    if (DEBUG_MODE) {
                        const agentCount = Object.keys(AGENTS).length;
                        console.error(`[AgentAssistant] ✅ Poll-based reload completed. Currently loaded ${agentCount} agents`);
                    }
                }
            }
        } catch (error) {
            console.error(`[AgentAssistant] Polling error:`, error.message);
        }
    }, 2000); // Check every 2 seconds

    // Store polling interval reference for cleanup
    if (typeof global.agentAssistantPollInterval !== 'undefined') {
        clearInterval(global.agentAssistantPollInterval);
    }
    global.agentAssistantPollInterval = pollInterval;

    if (DEBUG_MODE) {
        console.error(`[AgentAssistant] ✅ Fallback polling mechanism started`);
    }
}

/**
 * Gets the current configuration status for debugging
 * @returns {object} Configuration status information
 */
function getConfigStatus() {
    const jsonExists = fs.existsSync(AGENT_ASSISTANT_CONFIG_JSON);
    const envExists = fs.existsSync(PLUGIN_CONFIG_ENV_PATH);

    // Check if JSON config was migrated from ENV
    let migrationInfo = null;
    if (jsonExists) {
        try {
            const jsonContent = fs.readFileSync(AGENT_ASSISTANT_CONFIG_JSON, 'utf8');
            const jsonConfig = JSON.parse(jsonContent);
            if (jsonConfig.migratedFrom === 'config.env') {
                migrationInfo = {
                    migrated: true,
                    migratedAt: jsonConfig.migratedAt,
                    migrationVersion: jsonConfig.migrationVersion
                };
            }
        } catch (error) {
            // Ignore parsing errors for migration info
        }
    }

    return {
        jsonConfigExists: jsonExists,
        envConfigExists: envExists,
        currentFormat: jsonExists ? 'json' : 'none', // ENV is now read-only for migration
        jsonConfigPath: AGENT_ASSISTANT_CONFIG_JSON,
        envConfigPath: PLUGIN_CONFIG_ENV_PATH,
        envConfigStatus: envExists ? 'read-only (migration source)' : 'not found',
        migrationInfo: migrationInfo,
        agentCount: Object.keys(AGENTS).length,
        loadedAgents: Object.keys(AGENTS),
        watcherActive: configWatcher !== null
    };
}

/**
 * Migrates configuration from ENV format to JSON format
 * @returns {object} Migration result with statistics
 */
function migrateFromEnvToJson() {
    try {
        if (!fs.existsSync(PLUGIN_CONFIG_ENV_PATH)) {
            return {
                success: false,
                message: 'ENV configuration file not found',
                migratedCount: 0
            };
        }

        const fileContent = fs.readFileSync(PLUGIN_CONFIG_ENV_PATH, { encoding: 'utf8' });
        const pluginLocalEnvConfig = dotenv.parse(fileContent);

        const agentBaseNames = new Set();
        for (const key in pluginLocalEnvConfig) {
            if (key.startsWith('AGENT_') && key.endsWith('_MODEL_ID')) {
                const nameMatch = key.match(/^AGENT_([A-Z0-9_]+)_MODEL_ID$/i);
                if (nameMatch && nameMatch[1]) agentBaseNames.add(nameMatch[1].toUpperCase());
            }
        }

        if (agentBaseNames.size === 0) {
            return {
                success: false,
                message: 'No agents found in ENV configuration',
                migratedCount: 0
            };
        }

        const globalSystemPrompt = pluginLocalEnvConfig.AGENT_ALL_SYSTEM_PROMPT || "";
        const agents = [];

        for (const baseName of agentBaseNames) {
            const modelId = pluginLocalEnvConfig[`AGENT_${baseName}_MODEL_ID`];
            const chineseName = pluginLocalEnvConfig[`AGENT_${baseName}_CHINESE_NAME`];

            if (!modelId || !chineseName) {
                continue;
            }

            const systemPrompt = pluginLocalEnvConfig[`AGENT_${baseName}_SYSTEM_PROMPT`] || `You are {{MaidName}}.`;
            const maxOutputTokens = parseInt(pluginLocalEnvConfig[`AGENT_${baseName}_MAX_OUTPUT_TOKENS`] || '40000', 10);
            const temperature = parseFloat(pluginLocalEnvConfig[`AGENT_${baseName}_TEMPERATURE`] || '0.7');
            const description = pluginLocalEnvConfig[`AGENT_${baseName}_DESCRIPTION`] || `Assistant ${chineseName}.`;

            agents.push({
                baseName: baseName,
                chineseName: chineseName,
                modelId: modelId,
                systemPrompt: systemPrompt,
                maxOutputTokens: maxOutputTokens,
                temperature: temperature,
                description: description
            });
        }

        const jsonConfig = {
            version: "2.0",
            agents: agents,
            globalSystemPrompt: globalSystemPrompt
        };

        // Write JSON config file
        fs.writeFileSync(AGENT_ASSISTANT_CONFIG_JSON, JSON.stringify(jsonConfig, null, 2), 'utf8');

        return {
            success: true,
            message: `Successfully migrated ${agents.length} agents from ENV to JSON format`,
            migratedCount: agents.length,
            jsonConfigPath: AGENT_ASSISTANT_CONFIG_JSON
        };
    } catch (error) {
        return {
            success: false,
            message: `Migration failed: ${error.message}`,
            migratedCount: 0
        };
    }
}

// --- Context Management ---

function getAgentSessionHistory(agentName, sessionId = 'default_user_session') {
    if (!agentContexts.has(agentName)) {
        agentContexts.set(agentName, new Map());
    }
    const agentSessions = agentContexts.get(agentName);
    if (!agentSessions.has(sessionId) || isContextExpired(agentSessions.get(sessionId).timestamp)) {
        agentSessions.set(sessionId, { timestamp: Date.now(), history: [] });
    }
    return agentSessions.get(sessionId).history;
}

function updateAgentSessionHistory(agentName, userMessage, assistantMessage, sessionId = 'default_user_session') {
    const agentSessions = agentContexts.get(agentName);
    if (!agentSessions) return;
    let sessionData = agentSessions.get(sessionId);
    if (!sessionData || isContextExpired(sessionData.timestamp)) {
        sessionData = { timestamp: Date.now(), history: [] };
        agentSessions.set(sessionId, sessionData);
    }
    sessionData.history.push(userMessage, assistantMessage);
    sessionData.timestamp = Date.now();
    const maxMessages = MAX_HISTORY_ROUNDS * 20;
    if (sessionData.history.length > maxMessages) {
        sessionData.history = sessionData.history.slice(-maxMessages);
    }
}

function isContextExpired(timestamp) {
    return (Date.now() - timestamp) > (CONTEXT_TTL_HOURS * 60 * 60 * 1000);
}

function periodicCleanup() {
    if (DEBUG_MODE && agentContexts.size > 0) console.error(`[AgentAssistant Service] Running periodic context cleanup...`);
    for (const [agentName, sessions] of agentContexts) {
        for (const [sessionId, sessionData] of sessions) {
            if (isContextExpired(sessionData.timestamp)) {
                sessions.delete(sessionId);
                if (DEBUG_MODE) console.error(`[AgentAssistant Service] Cleared expired context for agent ${agentName}, session ${sessionId}`);
            }
        }
        if (sessions.size === 0) {
            agentContexts.delete(agentName);
        }
    }
}

// --- Helper Functions ---

async function replacePlaceholdersInUserPrompt(text, agentConfig) {
    if (text == null) return '';
    let processedText = String(text);
    if (agentConfig && agentConfig.name) {
        processedText = processedText.replace(/\{\{AgentName\}\}/g, agentConfig.name).replace(/\{\{MaidName\}\}/g, agentConfig.name);
    }
    return processedText;
}

function parseAndValidateDate(dateString) {
    if (!dateString) return null;
    const standardizedString = String(dateString).replace(/[/\.]/g, '-');
    const regex = /^(\d{4})-(\d{1,2})-(\d{1,2})-(\d{1,2}):(\d{1,2})$/;
    const match = standardizedString.match(regex);
    if (!match) return null;
    const [, year, month, day, hour, minute] = match.map(Number);
    const date = new Date(year, month - 1, day, hour, minute);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    if (date.getTime() <= Date.now()) return 'past';
    return date;
}

/**
 * This is the main entry point for handling tool calls from PluginManager.
 * @param {object} args - The arguments for the tool call.
 * @returns {Promise<object>} A promise that resolves to the result of the tool call.
 */
async function processToolCall(args) {
    if (!VCP_SERVER_PORT || !VCP_SERVER_ACCESS_KEY) {
        const errorMsg = "AgentAssistant Critical Error: VCP Server PORT or Access Key is not configured.";
        if (DEBUG_MODE) console.error(`[AgentAssistant Service] ${errorMsg}`);
        return { status: "error", error: errorMsg };
    }

    const { agent_name, prompt, timely_contact, temporary_contact } = args;
    if (!agent_name || !prompt) {
        return { status: "error", error: "Missing 'agent_name' or 'prompt' in request." };
    }

    const agentConfig = AGENTS[agent_name];
    if (!agentConfig) {
        const availableAgentNames = Object.keys(AGENTS);
        let errorMessage = `请求的 Agent '${agent_name}' 未找到。`;
        errorMessage += availableAgentNames.length > 0 ? ` 当前可用的 Agent 有: ${availableAgentNames.join(', ')}。` : ` 当前没有加载任何 Agent。`;
        if (DEBUG_MODE) console.error(`[AgentAssistant Service] Failed to find agent: '${agent_name}'.`);
        return { status: "error", error: errorMessage };
    }

    // Handle future calls (timely_contact)
    if (timely_contact) {
        const targetDate = parseAndValidateDate(timely_contact);
        if (!targetDate) return { status: "error", error: `无效的 'timely_contact' 时间格式: '${timely_contact}'。请使用 YYYY-MM-DD-HH:mm 格式。` };
        if (targetDate === 'past') return { status: "error", error: `无效的 'timely_contact' 时间: '${timely_contact}'。不能设置为过去的时间。` };

        try {
            const schedulerPayload = {
                schedule_time: targetDate.toISOString(),
                task_id: `task-${targetDate.getTime()}-${uuidv4()}`,
                tool_call: { tool_name: "AgentAssistant", arguments: { agent_name, prompt } }
            };
            if (DEBUG_MODE) console.error(`[AgentAssistant Service] Calling /v1/schedule_task with payload:`, JSON.stringify(schedulerPayload, null, 2));

            const response = await axios.post(`${VCP_API_TARGET_URL}/schedule_task`, schedulerPayload, {
                headers: { 'Authorization': `Bearer ${VCP_SERVER_ACCESS_KEY}`, 'Content-Type': 'application/json' },
                timeout: 15000
            });

            if (response.data && response.data.status === "success") {
                const formattedDate = `${targetDate.getFullYear()}年${targetDate.getMonth() + 1}月${targetDate.getDate()}日 ${targetDate.getHours().toString().padStart(2, '0')}:${targetDate.getMinutes().toString().padStart(2, '0')}`;
                const friendlyReceipt = `您预定于 ${formattedDate} 发给 ${agent_name} 的未来通讯已经被系统记录，届时会自动发送。`;
                return { status: "success", result: friendlyReceipt };
            } else {
                const errorMessage = `调度任务失败: ${response.data?.error || '服务器返回未知错误'}`;
                if (DEBUG_MODE) console.error(`[AgentAssistant Service] ${errorMessage}`, response.data);
                return { status: "error", error: errorMessage };
            }
        } catch (error) {
            let errorMessage = "调用任务调度API时发生网络或内部错误。";
            if (axios.isAxiosError(error)) errorMessage += ` API Status: ${error.response?.status}. Message: ${error.response?.data?.error || error.message}`;
            else errorMessage += ` ${error.message}`;
            if (DEBUG_MODE) console.error(`[AgentAssistant Service] Error calling /v1/schedule_task:`, errorMessage);
            return { status: "error", error: errorMessage };
        }
    }

    // Handle immediate chat
    const useContext = !temporary_contact; // Check if temporary_contact is provided and truthy
    const userSessionId = args.session_id || `agent_${agentConfig.baseName}_default_user_session`;
    try {
        const processedUserPrompt = await replacePlaceholdersInUserPrompt(prompt, agentConfig);
        
        let history = [];
        if (useContext) {
            history = getAgentSessionHistory(agent_name, userSessionId);
        } else if (DEBUG_MODE) {
            console.error(`[AgentAssistant Service] Temporary contact requested for ${agent_name}. Skipping context loading.`);
        }

        const messagesForVCP = [
            { role: 'system', content: agentConfig.systemPrompt },
            { role: 'user', content: processedUserPrompt }
        ];
        if (history.length > 0) {
            messagesForVCP.splice(1, 0, ...history); // Insert history after system prompt
        }
        const payloadForVCP = {
            model: agentConfig.id,
            messages: messagesForVCP,
            max_tokens: agentConfig.maxOutputTokens,
            temperature: agentConfig.temperature,
            stream: false
        };
        
        if (DEBUG_MODE) console.error(`[AgentAssistant Service] Sending request to VCP Server for agent ${agent_name}`);

        const responseFromVCP = await axios.post(`${VCP_API_TARGET_URL}/chat/completions`, payloadForVCP, {
            headers: { 'Authorization': `Bearer ${VCP_SERVER_ACCESS_KEY}`, 'Content-Type': 'application/json' },
            timeout: (parseInt(process.env.PLUGIN_COMMUNICATION_TIMEOUT) || 118000)
        });
        
        const assistantResponseContent = responseFromVCP.data?.choices?.[0]?.message?.content;
        if (typeof assistantResponseContent !== 'string') {
            if (DEBUG_MODE) console.error("[AgentAssistant Service] Response from VCP Server did not contain valid assistant content for agent " + agent_name, responseFromVCP.data);
            return { status: "error", error: `Agent '${agent_name}' 从VCP服务器获取的响应无效或缺失内容。` };
        }

        if (useContext) {
            updateAgentSessionHistory(agent_name, { role: 'user', content: processedUserPrompt }, { role: 'assistant', content: assistantResponseContent }, userSessionId);
        } else if (DEBUG_MODE) {
            console.error(`[AgentAssistant Service] Temporary contact requested for ${agent_name}. Skipping context update.`);
        }
        
        // VCP Info Broadcast
        const broadcastData = {
            type: 'AGENT_PRIVATE_CHAT_PREVIEW',
            agentName: agent_name,
            sessionId: userSessionId,
            query: processedUserPrompt,
            response: assistantResponseContent,
            timestamp: new Date().toISOString()
        };
        try {
            // 关键修复：在调用时动态获取最新的 PluginManager 实例和 VCPLog 函数，以避免初始化阶段的陈旧引用。
            const pluginManager = require('../../Plugin.js');
            const freshVcpLogFunctions = pluginManager.getVCPLogFunctions();
            if (freshVcpLogFunctions && typeof freshVcpLogFunctions.pushVcpInfo === 'function') {
                freshVcpLogFunctions.pushVcpInfo(broadcastData);
                if (DEBUG_MODE) console.error(`[AgentAssistant Service] VCP Info broadcasted for chat with ${agent_name}.`);
            } else {
                if (DEBUG_MODE) console.error(`[AgentAssistant Service] Could not get fresh pushVcpInfo function.`);
            }
        } catch (e) {
            console.error('[AgentAssistant Service] Error broadcasting VCP Info:', e.message);
        }
        
        return { status: "success", result: assistantResponseContent };

    } catch (error) {
        let errorMessage = `调用 Agent '${agent_name}' 时发生错误。`;
        if (axios.isAxiosError(error)) {
            errorMessage += ` API Status: ${error.response?.status}.`;
            if (error.response?.data?.error?.message) errorMessage += ` Message: ${error.response.data.error.message}`;
            else if (typeof error.response?.data === 'string') errorMessage += ` Data: ${error.response.data.substring(0,150)}`;
            else if (error.message.includes('timeout')) errorMessage += ` Request to VCP server timed out.`;
        } else if (error instanceof Error) {
            errorMessage += ` ${error.message}`;
        }
        if (DEBUG_MODE) console.error(`[AgentAssistant Service] Error in processToolCall for ${agent_name}: ${errorMessage}`);
        return { status: "error", error: errorMessage };
    }
}

module.exports = {
    initialize,
    shutdown,
    processToolCall,
    loadAgentsFromLocalConfig,
    getConfigStatus,
    migrateFromEnvToJson
};
