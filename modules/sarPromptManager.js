// modules/sarPromptManager.js
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const SARPROMPT_FILE = path.join(__dirname, '..', 'sarprompt.json');

class SarPromptManager {
    constructor() {
        this.prompts = []; // Array<{ promptKey: string, models: string[], content: string, matchMode?: string }>
        this.debugMode = false;
    }

    async initialize(debugMode = false) {
        this.debugMode = debugMode;
        console.log('[SarPromptManager] Initializing...');

        if (!fsSync.existsSync(SARPROMPT_FILE)) {
            await this.migrateFromEnv();
        } else {
            await this.loadPrompts();
        }

        this.watchFile();
    }

    async migrateFromEnv() {
        console.log('[SarPromptManager] sarprompt.json not found. Migrating from .env...');
        const migratedPrompts = [];

        // Scan for SarPrompt1, SarPrompt2, ...
        // We look up to 100 as a reasonable limit for legacy migration
        for (let i = 1; i <= 100; i++) {
            const promptKey = `SarPrompt${i}`;
            const modelKey = `SarModel${i}`;

            const promptValue = process.env[promptKey];
            const modelsValue = process.env[modelKey];

            if (promptValue && modelsValue) {
                const models = modelsValue.split(',').map(m => m.trim()).filter(m => m !== '');
                migratedPrompts.push({
                    promptKey,
                    models,
                    content: promptValue
                });
            }
        }

        if (migratedPrompts.length > 0) {
            this.prompts = migratedPrompts;
            await this.savePrompts();
            console.log(`[SarPromptManager] Migrated ${migratedPrompts.length} groups from .env to sarprompt.json.`);
        } else {
            console.log('[SarPromptManager] No SarPrompt variables found in .env.');
            // Save an empty array to identify that migration has been attempt
            this.prompts = [];
            await this.savePrompts();
        }
    }

    async loadPrompts() {
        try {
            const content = await fs.readFile(SARPROMPT_FILE, 'utf8');
            this.prompts = JSON.parse(content);
            if (this.debugMode) {
                console.log(`[SarPromptManager] Loaded ${this.prompts.length} prompt groups.`);
            }
        } catch (error) {
            console.error('[SarPromptManager] Error loading sarprompt.json:', error);
            this.prompts = [];
        }
    }

    async savePrompts() {
        try {
            await fs.writeFile(SARPROMPT_FILE, JSON.stringify(this.prompts, null, 2), 'utf8');
            if (this.debugMode) {
                console.log('[SarPromptManager] sarprompt.json saved successfully.');
            }
        } catch (error) {
            console.error('[SarPromptManager] Error saving sarprompt.json:', error);
            throw error;
        }
    }

    watchFile() {
        try {
            const watcher = chokidar.watch(SARPROMPT_FILE, {
                persistent: true,
                ignoreInitial: true,
            });

            watcher.on('change', () => {
                console.log('[SarPromptManager] sarprompt.json changed. Reloading...');
                this.loadPrompts();
            });

            watcher.on('error', (error) => {
                console.error('[SarPromptManager] Watcher error:', error);
            });
        } catch (error) {
            console.error('[SarPromptManager] Failed to set up file watcher:', error);
        }
    }

    /**
     * 模型匹配辅助函数
     * @param {string[]} modelList - 已toLowerCase的模型名数组
     * @param {string} normalizedModel - 已toLowerCase的当前模型名
     * @param {string} matchMode - 'exact'(默认) | 'includes'(子串包含)
     * @returns {boolean}
     */
    isModelMatch(modelList, normalizedModel, matchMode = 'exact') {
        const filtered = modelList.filter(m => m.length > 0); // 过滤空字符串
        if (matchMode === 'includes') {
            return filtered.some(m => normalizedModel.includes(m));
        }
        // 默认精确匹配（含未知matchMode值的fallback）
        return filtered.includes(normalizedModel);
    }

    getSarPrompt(modelName) {
        if (!modelName) return null;
        const normalizedModel = modelName.toLowerCase();

        for (const group of this.prompts) {
            if (!group.models || group.models.length === 0) continue;
            const modelList = group.models.map(m => m.trim().toLowerCase());
            const matchMode = group.matchMode || 'exact';
            if (this.isModelMatch(modelList, normalizedModel, matchMode)) {
                return group;
            }
        }
        return null;
    }

    getAllPrompts() {
        return this.prompts;
    }

    async updateAllPrompts(newPrompts) {
        if (!Array.isArray(newPrompts)) {
            throw new Error('Prompts must be an array');
        }
        this.prompts = newPrompts;
        await this.savePrompts();
    }
}

const sarPromptManager = new SarPromptManager();
module.exports = sarPromptManager;