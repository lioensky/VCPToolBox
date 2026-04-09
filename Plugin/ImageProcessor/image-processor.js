// Plugin/ImageProcessor/image-processor.js
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

let db = null;
let pluginConfig = {}; 
let fetchInstance = null; // Cache fetch instance

async function getFetch() {
    if (!fetchInstance) {
        const { default: fetch } = await import('node-fetch');
        fetchInstance = fetch;
    }
    return fetchInstance;
}

// --- Database Initialization ---
function initDatabase() {
    try {
        const dbPath = path.join(__dirname, 'multimodal_cache.sqlite');
        db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.exec(`
            CREATE TABLE IF NOT EXISTS multimodal_cache (
                hash TEXT PRIMARY KEY,
                base64 TEXT NOT NULL,
                description TEXT,
                mime_type TEXT,
                timestamp TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_cache_description ON multimodal_cache(description);
        `);
        console.log(`[MultiModalProcessor] SQLite database initialized at ${dbPath}`);
    } catch (error) {
        console.error('[MultiModalProcessor] Failed to initialize SQLite database:', error);
    }
}

// --- Debug logging ---
function debugLog(message, data) {
    if (pluginConfig.DebugMode) {
        console.log(`[MultiModalProcessor][Debug] ${message}`, data !== undefined ? JSON.stringify(data, null, 2) : '');
    }
}

function calculateHash(data) {
    return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * Normalize local URLs to 127.0.0.1 only if 'localhost' is explicitly used as the host.
 * This avoids Node.js 17+ localhost DNS delay and IPv4/v6 mismatch issues.
 */
function normalizeUrl(url) {
    if (typeof url !== 'string') return url;
    // Precisely match http(s)://localhost followed by port, slash, or end of string (case-insensitive)
    return url.replace(/^(https?:\/\/)localhost([:/].*|$)/i, '$1127.0.0.1$2');
}

async function translateMediaAndCacheInternal(base64DataWithPrefix, mediaIndexForLabel, currentConfig) {
    const fetch = await getFetch();
    const base64PrefixPattern = /^data:(image|audio|video)\/[^;]+;base64,/;
    const pureBase64Data = base64DataWithPrefix.replace(base64PrefixPattern, '');
    const mediaMimeType = (base64DataWithPrefix.match(base64PrefixPattern) || ['data:application/octet-stream;base64,'])[0].replace('base64,', '');

    const hash = calculateHash(base64DataWithPrefix);
    
    // Check SQLite cache
    try {
        const cachedRow = db.prepare('SELECT description FROM multimodal_cache WHERE hash = ?').get(hash);
        if (cachedRow) {
            console.log(`[MultiModalProcessor] Cache hit (hash: ${hash}) for media ${mediaIndexForLabel + 1}.`);
            return `[MULTIMODAL_DATA_${mediaIndexForLabel + 1}_Info: ${cachedRow.description}]`;
        }
    } catch (dbError) {
        console.error('[MultiModalProcessor] DB Query error:', dbError);
    }

    console.log(`[MultiModalProcessor] Translating media ${mediaIndexForLabel + 1} (hash: ${hash})...`);
    if (!currentConfig.MultiModalModel || !currentConfig.MultiModalPrompt || !currentConfig.API_Key || !currentConfig.API_URL) {
        console.error('[MultiModalProcessor] Multimodal translation config incomplete.');
        return `[MULTIMODAL_DATA_${mediaIndexForLabel + 1}_Info: 多模态数据转译服务配置不完整]`;
    }

    const apiUrl = normalizeUrl(currentConfig.API_URL);
    const maxRetries = 3;
    let attempt = 0;
    let lastError = null;

    while (attempt < maxRetries) {
        attempt++;
        try {
            const payload = {
                model: currentConfig.MultiModalModel,
                messages: [{
                    role: "user",
                    content: [
                        { type: "text", text: currentConfig.MultiModalPrompt },
                        { type: "image_url", image_url: { url: `${mediaMimeType}base64,${pureBase64Data}` } }
                    ]
                }],
                max_tokens: currentConfig.MultiModalModelOutputMaxTokens || 50000,
            };
            if (currentConfig.MultiModalModelThinkingBudget && currentConfig.MultiModalModelThinkingBudget > 0) {
                payload.extra_body = { thinking_config: { thinking_budget: currentConfig.MultiModalModelThinkingBudget } };
            }

            const fetchResponse = await fetch(`${apiUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json', 
                    'Authorization': `Bearer ${currentConfig.API_Key}`,
                    // Optimization: Disable keep-alive for the first failed attempt if it's a socket error
                    'Connection': attempt > 1 ? 'keep-alive' : 'close' 
                },
                body: JSON.stringify(payload),
                timeout: 60000 // 60s timeout for large images/busy servers
            });

            if (!fetchResponse.ok) {
                const errorText = await fetchResponse.text();
                throw new Error(`API call failed (attempt ${attempt}): ${fetchResponse.status} - ${errorText}`);
            }

            const result = await fetchResponse.json();
            const description = result.choices?.[0]?.message?.content?.trim();

            if (description && description.length >= 20) {
                const cleanedDescription = description.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
                
                // Save to SQLite
                try {
                    db.prepare(`
                        INSERT OR REPLACE INTO multimodal_cache (hash, base64, description, mime_type, timestamp)
                        VALUES (?, ?, ?, ?, ?)
                    `).run(hash, base64DataWithPrefix, cleanedDescription, mediaMimeType, new Date().toISOString());
                    debugLog(`Saved to cache: ${hash}`);
                } catch (dbSaveError) {
                    console.error('[MultiModalProcessor] DB Save error:', dbSaveError);
                }

                return `[MULTIMODAL_DATA_${mediaIndexForLabel + 1}_Info: ${cleanedDescription}]`;
            } else if (description) {
                lastError = new Error(`Description too short (length: ${description.length}, attempt ${attempt}).`);
            } else {
                lastError = new Error(`No description found in API response (attempt ${attempt}).`);
            }
        } catch (error) {
            lastError = error;
            console.error(`[MultiModalProcessor] Error translating media ${mediaIndexForLabel + 1} (attempt ${attempt}):`, error.message);
            
            // Special handling for socket hang up / connection reset
            if (error.message.includes('socket hang up') || error.message.includes('ECONNRESET')) {
                // Wait longer for the next attempt (1s -> 2s) to allow local server to load model
                const retryDelay = 1000 * attempt;
                console.log(`[MultiModalProcessor] Connection issue detected. Retrying in ${retryDelay}ms... (Attempt ${attempt}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                continue; 
            }
        }
        if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, 500));
    }
    console.error(`[MultiModalProcessor] Failed to translate media ${mediaIndexForLabel + 1} after ${maxRetries} attempts.`);
    return `[MULTIMODAL_DATA_${mediaIndexForLabel + 1}_Info: 多模态数据转译失败: ${lastError ? lastError.message.substring(0, 100) : '未知错误'}]`;
}

module.exports = {
    async initialize(initialConfig = {}) {
        pluginConfig = initialConfig; 
        initDatabase();
        await getFetch(); // Pre-warm fetch instance
        console.log('[MultiModalProcessor] Initialized and SQLite connected.');
    },

    async processMessages(messages, requestConfig = {}) {
        const currentConfig = { ...pluginConfig, ...requestConfig };
        let globalMediaIndexForLabel = 0;
        const processedMessages = JSON.parse(JSON.stringify(messages));

        for (let i = 0; i < processedMessages.length; i++) {
            const msg = processedMessages[i];
            if (msg.role === 'user' && Array.isArray(msg.content)) {
                const mediaPartsToTranslate = [];
                const contentWithoutMedia = [];

                for (const part of msg.content) {
                    if (part.type === 'image_url' && part.image_url &&
                        typeof part.image_url.url === 'string' &&
                        /^data:(image|audio|video)\/[^;]+;base64,/.test(part.image_url.url)) {
                        mediaPartsToTranslate.push(part.image_url.url);
                    } else {
                        contentWithoutMedia.push(part);
                    }
                }

                if (mediaPartsToTranslate.length > 0) {
                    const allTranslatedMediaTexts = [];
                    const asyncLimit = currentConfig.MultiModalModelAsynchronousLimit || 1;

                    for (let j = 0; j < mediaPartsToTranslate.length; j += asyncLimit) {
                        const chunkToTranslate = mediaPartsToTranslate.slice(j, j + asyncLimit);
                        const translationPromisesInChunk = chunkToTranslate.map((base64Url) =>
                            translateMediaAndCacheInternal(base64Url, globalMediaIndexForLabel++, currentConfig)
                        );
                        const translatedTextsInChunk = await Promise.all(translationPromisesInChunk);
                        allTranslatedMediaTexts.push(...translatedTextsInChunk);
                    }

                    let userTextPart = contentWithoutMedia.find(p => p.type === 'text');
                    if (!userTextPart) {
                        userTextPart = { type: 'text', text: '' };
                        contentWithoutMedia.unshift(userTextPart);
                    }
                    const insertPrompt = currentConfig.MediaInsertPrompt || "[多模态数据信息已提取:]";
                    userTextPart.text = (userTextPart.text ? userTextPart.text.trim() + '\n' : '') +
                        '<VCP_MULTIMODAL_INFO>\n' +
                        insertPrompt + '\n' +
                        allTranslatedMediaTexts.join('\n') +
                        '\n</VCP_MULTIMODAL_INFO>';
                    msg.content = contentWithoutMedia;
                }
            }
        }
        return processedMessages;
    },

    async shutdown() {
        if (db) {
            db.close();
            console.log('[MultiModalProcessor] SQLite connection closed.');
        }
    }
};
