// modules/agentManager.js
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const AGENT_DIR = path.join(__dirname, '..', 'Agent');
const MAP_FILE = path.join(__dirname, '..', 'agent_map.json');

class AgentManager {
    constructor() {
        this.agentMap = new Map();
        this.promptCache = new Map();
        this.debugMode = false;
    }

    /**
     * Initializes the AgentManager, loads the mapping file, and starts watching for changes.
     * @param {boolean} debugMode - Enable debug logging.
     */
    async initialize(debugMode = false) {
        this.debugMode = debugMode;
        console.log('[AgentManager] Initializing...');
        await this.loadMap();
        this.watchFiles();
    }

    /**
     * Loads or reloads the agent alias-to-filename mapping from agent_map.json.
     */
    async loadMap() {
        try {
            const mapContent = await fs.readFile(MAP_FILE, 'utf8');
            const mapJson = JSON.parse(mapContent);
            
            this.agentMap.clear();
            for (const alias in mapJson) {
                this.agentMap.set(alias, mapJson[alias]);
            }

            if (this.debugMode) {
                console.log(`[AgentManager] Loaded ${this.agentMap.size} agent mappings from agent_map.json.`);
            }
            // When the map changes, the entire prompt cache becomes potentially invalid.
            this.promptCache.clear();
            console.log('[AgentManager] Agent map reloaded and prompt cache cleared.');

        } catch (error) {
            if (error.code === 'ENOENT') {
                console.warn(`[AgentManager] agent_map.json not found. No agents will be loaded.`);
            } else {
                console.error('[AgentManager] Error loading or parsing agent_map.json:', error);
            }
            // Clear map and cache on error to prevent using stale data.
            this.agentMap.clear();
            this.promptCache.clear();
        }
    }

    /**
     * Sets up watchers on the mapping file and the Agent directory for hot-reloading.
     */
    watchFiles() {
        try {
            fsSync.watch(MAP_FILE, (eventType, filename) => {
                if (filename && (eventType === 'change' || eventType === 'rename')) {
                    console.log(`[AgentManager] Detected change in ${filename}. Reloading agent map...`);
                    this.loadMap();
                }
            });

            const watcher = chokidar.watch(AGENT_DIR, {
                ignored: /(^|[\/\\])\../, // ignore dotfiles
                persistent: true,
                ignoreInitial: true,
            });

            watcher.on('change', (filePath) => {
                const filename = path.relative(AGENT_DIR, filePath);
                for (const [alias, file] of this.agentMap.entries()) {
                    // Normalize path separators for comparison
                    if (file.replace(/\\/g, '/') === filename.replace(/\\/g, '/')) {
                        if (this.promptCache.has(alias)) {
                            this.promptCache.delete(alias);
                            console.log(`[AgentManager] Prompt cache for '${alias}' (${filename}) cleared due to file change.`);
                        }
                        return;
                    }
                }
            });
        } catch (error) {
            console.error(`[AgentManager] Failed to set up file watchers:`, error);
        }
    }

    /**
     * Retrieves the prompt for a given agent alias, using cache if available.
     * @param {string} alias - The agent alias (e.g., "XiaoKe").
     * @returns {Promise<string>} The agent's prompt content.
     */
    async getAgentPrompt(alias) {
        if (this.promptCache.has(alias)) {
            return this.promptCache.get(alias);
        }

        const filename = this.agentMap.get(alias);
        if (!filename) {
            if (this.debugMode) {
                console.warn(`[AgentManager] Agent alias '${alias}' not found in map.`);
            }
            return `{{agent:${alias}}}`; // Return original placeholder if not found
        }

        try {
            const filePath = path.join(AGENT_DIR, filename);
            const prompt = await fs.readFile(filePath, 'utf8');
            this.promptCache.set(alias, prompt);
            return prompt;
        } catch (error) {
            console.error(`[AgentManager] Error reading agent file for '${alias}' (${filename}):`, error.message);
            return `[AgentManager: Error loading prompt for '${alias}'. File not found or unreadable.]`;
        }
    }

    /**
     * Checks if a given alias is a registered agent.
     * @param {string} alias - The agent alias to check.
     * @returns {boolean} True if the alias exists in the map.
     */
    isAgent(alias) {
        return this.agentMap.has(alias);
    }
}

const agentManager = new AgentManager();
module.exports = agentManager;