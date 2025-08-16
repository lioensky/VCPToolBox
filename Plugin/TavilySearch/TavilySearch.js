#!/usr/bin/env node
const { tavily } = require('@tavily/core');
const stdin = require('process').stdin;
const fs = require('fs');
const path = require('path');

// --- Cache File Setup ---
// 将缓存文件放在和当前脚本同一个目录下
// __dirname 是一个 Node.js 的全局变量，代表当前执行脚本所在的目录路径
const CACHE_FILE_PATH = path.join(__dirname, '.vcptoolbox_tavily_cache.json');

/**
 * ApiKeyPool
 * Manages a pool of API keys with state persisted to a file.
 */
class ApiKeyPool {
    constructor(keys) {
        this.state = this.loadState();

        // If no state, or if the keys in the env have changed, re-initialize.
        const envKeySet = new Set(keys);
        const stateKeySet = new Set(this.state.keys.map(k => k.key));

        if (this.state.keys.length !== keys.length || ![...envKeySet].every(k => stateKeySet.has(k))) {
             this.state = {
                currentIndex: 0,
                keys: keys.map(key => ({
                    key,
                    active: true,
                    errorCount: 0,
                    maxErrors: 5
                }))
            };
        }
    }

    loadState() {
        try {
            if (fs.existsSync(CACHE_FILE_PATH)) {
                const data = fs.readFileSync(CACHE_FILE_PATH, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            console.error("[ApiKeyPool] Warning: Could not read cache file. Starting fresh.", error.message);
        }
        return { currentIndex: 0, keys: [] };
    }

    saveState() {
        try {
            fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(this.state, null, 2));
        } catch (error) {
            console.error("[ApiKeyPool] Error: Could not write to cache file.", error.message);
        }
    }

    getNextKey() {
        const activeKeys = this.state.keys.filter(k => k.active);
        if (activeKeys.length === 0) {
            return null;
        }
        const keyConfig = activeKeys[this.state.currentIndex % activeKeys.length];
        this.state.currentIndex = (this.state.currentIndex + 1) % activeKeys.length;
        return keyConfig;
    }

    markKeyError(key) {
        const keyConfig = this.state.keys.find(k => k.key === key);
        if (keyConfig) {
            keyConfig.errorCount++;
            if (keyConfig.errorCount >= keyConfig.maxErrors) {
                keyConfig.active = false;
                console.error(`[ApiKeyPool] Disabling key due to multiple errors: ${key.substring(0, 8)}...`);
            }
        }
    }

    markKeySuccess(key) {
        const keyConfig = this.state.keys.find(k => k.key === key);
        if (keyConfig) {
            keyConfig.errorCount = 0;
        }
    }
}

let apiKeyPool;

async function main() {
    let inputData = '';
    stdin.setEncoding('utf8');

    stdin.on('data', function(chunk) {
        inputData += chunk;
    });

    stdin.on('end', async function() {
        if (!apiKeyPool) {
            const apiKeysEnv = process.env.TavilyKey;
            if (!apiKeysEnv) {
                 process.stdout.write(JSON.stringify({ status: "error", error: "TavilyKey environment variable not set." }));
                 return;
            }
            const keys = apiKeysEnv.split(',').map(key => key.trim()).filter(key => key);
            if (keys.length === 0) {
                 process.stdout.write(JSON.stringify({ status: "error", error: "TavilyKey environment variable is empty or contains only commas." }));
                 return;
            }
            apiKeyPool = new ApiKeyPool(keys);
        }

        let output = {};
        let selectedKeyConfig = null;

        try {
            if (!inputData.trim()) {
                throw new Error("No input data received from stdin.");
            }
            const data = JSON.parse(inputData);
            const query = data.query;
            const topic = data.topic || 'general';
            const searchDepth = 'advanced';
            let maxResults = data.max_results || 10;
            const includeRawContent = data.include_raw_content;
            const startDate = data.start_date;
            const endDate = data.end_date;

            if (!query) {
                throw new Error("Missing required argument: query");
            }

            selectedKeyConfig = apiKeyPool.getNextKey();
            if (!selectedKeyConfig) {
                throw new Error("No active Tavily API keys available.");
            }
            const apiKey = selectedKeyConfig.key;

            try {
                maxResults = parseInt(maxResults, 10);
                if (isNaN(maxResults) || maxResults < 5 || maxResults > 100) {
                    maxResults = 10;
                }
            } catch (e) {
                maxResults = 10;
            }
            
            const tvly = tavily({ apiKey });

            const searchOptions = {
                search_depth: searchDepth,
                topic: topic,
                max_results: maxResults,
                include_answer: false,
                include_images: true,
                include_image_descriptions: true,
            };

            if (includeRawContent === "text" || includeRawContent === "markdown") {
                searchOptions.include_raw_content = includeRawContent;
            }
            if (startDate) searchOptions.start_date = startDate;
            if (endDate) searchOptions.end_date = endDate;
            
            const response = await tvly.search(query, searchOptions);
            
            apiKeyPool.markKeySuccess(apiKey);
            output = { status: "success", result: JSON.stringify(response, null, 2) };

        } catch (e) {
            if (selectedKeyConfig) {
                apiKeyPool.markKeyError(selectedKeyConfig.key);
            }
            let errorMessage = e instanceof Error ? e.message : "An unknown error occurred.";
            if (e instanceof SyntaxError) errorMessage = "Invalid JSON input.";
            output = { status: "error", error: `Tavily Search Error: ${errorMessage}` };
        } finally {
            if (apiKeyPool) {
                apiKeyPool.saveState();
            }
            process.stdout.write(JSON.stringify(output, null, 2));
        }
    });
}

main().catch(error => {
    if (apiKeyPool) {
        apiKeyPool.saveState();
    }
    process.stdout.write(JSON.stringify({ status: "error", error: `Unhandled Plugin Error: ${error.message || error}` }));
    process.exit(1);
});
