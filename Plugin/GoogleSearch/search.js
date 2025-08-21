#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, 'config.env') });
const axios = require('axios');
const fs = require('fs');

// --- Cache File Setup ---
// 将缓存文件放在和当前脚本同一个目录下
const CACHE_FILE_PATH = path.join(__dirname, '.google_pse_cache.json');
const API_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

/**
 * ApiKeyPool
 * Manages a pool of Google API Keys with state persisted to a file.
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
                console.error(`[ApiKeyPool] Disabling API Key due to multiple errors: ${key.substring(0, 8)}...`);
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

async function googleApiSearch(query, apiKey, cx) {
    const params = { key: apiKey, cx: cx, q: query, num: 10 };
    const options = { params };

    if (process.env.GOOGLE_PROXY_PORT) {
        options.proxy = { host: '127.0.0.1', port: process.env.GOOGLE_PROXY_PORT, protocol: 'http' };
    }

    try {
        const response = await axios.get(API_ENDPOINT, options);
        if (response.data && response.data.items) {
            return {
                status: 'success',
                result: response.data.items.map(item => ({ title: item.title, url: item.link, snippet: item.snippet }))
            };
        }
        return { status: 'success', result: [] }; // No results found
    } catch (error) {
        let errorMessage = `Google Search API request failed.`;
        if (error.response) errorMessage += ` Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`;
        else if (error.request) errorMessage += ` No response received.`;
        else errorMessage += ` Error: ${error.message}`;
        throw new Error(errorMessage);
    }
}

async function main() {
    const CX = process.env.GOOGLE_CX;
    if (!CX) {
        console.log(JSON.stringify({ status: 'error', error: 'Custom Search Engine ID (GOOGLE_CX) is not configured in config.env.' }, null, 2));
        process.exit(1);
    }

    if (!apiKeyPool) {
        const apiKeysEnv = process.env.GOOGLE_SEARCH_API;
        if (!apiKeysEnv) {
            console.log(JSON.stringify({ status: 'error', error: 'Google API Key (GOOGLE_SEARCH_API) is not configured in config.env.' }, null, 2));
            process.exit(1);
        }
        const keys = apiKeysEnv.split(',').map(key => key.trim()).filter(key => key);
        if (keys.length === 0) {
            console.log(JSON.stringify({ status: 'error', error: 'No valid API Keys found in GOOGLE_SEARCH_API.' }, null, 2));
            process.exit(1);
        }
        apiKeyPool = new ApiKeyPool(keys);
    }
    
    let selectedKeyConfig = null;
    let output;

    try {
        const input = await readInput();
        const request = JSON.parse(input);
        const query = request.query;

        if (!query) {
            throw new Error('Query parameter is missing.');
        }

        selectedKeyConfig = apiKeyPool.getNextKey();
        if (!selectedKeyConfig) {
            throw new Error("No active Google API keys available in the pool.");
        }
        
        const apiKey = selectedKeyConfig.key;
        output = await googleApiSearch(query, apiKey, CX); // Uses fixed CX
        
        apiKeyPool.markKeySuccess(apiKey);

    } catch (e) {
        if (selectedKeyConfig) {
            apiKeyPool.markKeyError(selectedKeyConfig.key);
        }
        output = { status: 'error', error: e.message };
    } finally {
        if (apiKeyPool) {
            apiKeyPool.saveState();
        }
        console.log(JSON.stringify(output, null, 2));
        if (output.status === 'error') {
            process.exit(1);
        }
    }
}

function readInput() {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        let data = '';
        stdin.setEncoding('utf8');
        stdin.on('data', (chunk) => { data += chunk; });
        stdin.on('end', () => { resolve(data); });
        if (stdin.isTTY) { resolve('{}'); }
    });
}

main();
