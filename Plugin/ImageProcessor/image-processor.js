// Plugin/ImageProcessor/image-processor.js
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

let mediaBase64Cache = {};
// Cache file will be stored inside the plugin's directory for better encapsulation
const mediaCacheFilePath = path.join(__dirname, 'multimodal_cache.json');
let pluginConfig = {}; // To store config passed from Plugin.js

// --- Debug logging (simplified for plugin) ---
function debugLog(message, data) {
    if (pluginConfig.DebugMode) {
        console.log(`[MultiModalProcessor][Debug] ${message}`, data !== undefined ? JSON.stringify(data, null, 2) : '');
    }
}

async function loadMediaCacheFromFile() {
    try {
        const data = await fs.readFile(mediaCacheFilePath, 'utf-8');
        mediaBase64Cache = JSON.parse(data);
        console.log(`[MultiModalProcessor] Loaded ${Object.keys(mediaBase64Cache).length} media cache entries from ${mediaCacheFilePath}`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`[MultiModalProcessor] Cache file ${mediaCacheFilePath} not found. Initializing new cache.`);
            mediaBase64Cache = {};
            await saveMediaCacheToFile(); // Create an empty cache file
        } else {
            console.error(`[MultiModalProcessor] Error reading media cache file ${mediaCacheFilePath}:`, error);
            mediaBase64Cache = {}; // Fallback to empty cache
        }
    }
}

async function saveMediaCacheToFile() {
    try {
        await fs.writeFile(mediaCacheFilePath, JSON.stringify(mediaBase64Cache, null, 2));
        debugLog(`Media cache saved to ${mediaCacheFilePath}`);
    } catch (error) {
        console.error(`[MultiModalProcessor] Error saving media cache to ${mediaCacheFilePath}:`, error);
    }
}

async function translateMediaAndCacheInternal(base64DataWithPrefix, mediaIndexForLabel, currentConfig) {
    const { default: fetch } = await import('node-fetch');
    const base64PrefixPattern = /^data:(image|audio|video)\/[^;]+;base64,/;
    const pureBase64Data = base64DataWithPrefix.replace(base64PrefixPattern, '');
    const mediaMimeType = (base64DataWithPrefix.match(base64PrefixPattern) || ['data:application/octet-stream;base64,'])[0].replace('base64,', '');

    const cachedEntry = mediaBase64Cache[pureBase64Data];
    if (cachedEntry) {
        const description = typeof cachedEntry === 'string' ? cachedEntry : cachedEntry.description; // Handle old and new cache format
        console.log(`[MultiModalProcessor] Cache hit for media ${mediaIndexForLabel + 1}.`);
        return `[MULTIMODAL_DATA_${mediaIndexForLabel + 1}_Info: ${description}]`;
    }

    console.log(`[MultiModalProcessor] Translating media ${mediaIndexForLabel + 1}...`);
    if (!currentConfig.MultiModalModel || !currentConfig.MultiModalPrompt || !currentConfig.API_Key || !currentConfig.API_URL) {
        console.error('[MultiModalProcessor] Multimodal translation config incomplete.');
        return `[MULTIMODAL_DATA_${mediaIndexForLabel + 1}_Info: 多模态数据转译服务配置不完整]`;
    }

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

            const fetchResponse = await fetch(`${currentConfig.API_URL}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentConfig.API_Key}` },
                body: JSON.stringify(payload),
            });

            if (!fetchResponse.ok) {
                const errorText = await fetchResponse.text();
                throw new Error(`API call failed (attempt ${attempt}): ${fetchResponse.status} - ${errorText}`);
            }

            const result = await fetchResponse.json();
            const description = result.choices?.[0]?.message?.content?.trim();

            if (description && description.length >= 50) {
                const cleanedDescription = description.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
                const newCacheEntry = {
                    id: crypto.randomUUID(),
                    description: cleanedDescription,
                    timestamp: new Date().toISOString(),
                    mimeType: mediaMimeType
                };
                mediaBase64Cache[pureBase64Data] = newCacheEntry;
                await saveMediaCacheToFile();
                return `[MULTIMODAL_DATA_${mediaIndexForLabel + 1}_Info: ${cleanedDescription}]`;
            } else if (description) {
                lastError = new Error(`Description too short (length: ${description.length}, attempt ${attempt}).`);
            } else {
                lastError = new Error(`No description found in API response (attempt ${attempt}).`);
            }
        } catch (error) {
            lastError = error;
            console.error(`[MultiModalProcessor] Error translating media ${mediaIndexForLabel + 1} (attempt ${attempt}):`, error.message);
        }
        if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, 500));
    }
    console.error(`[MultiModalProcessor] Failed to translate media ${mediaIndexForLabel + 1} after ${maxRetries} attempts.`);
    return `[MULTIMODAL_DATA_${mediaIndexForLabel + 1}_Info: 多模态数据转译失败: ${lastError ? lastError.message.substring(0, 100) : '未知错误'}]`;
}

module.exports = {
    // Called by Plugin.js when loading the plugin
    async initialize(initialConfig = {}) {
        pluginConfig = initialConfig; // Store base config (like DebugMode)
        await loadMediaCacheFromFile();
        console.log('[MultiModalProcessor] Initialized and cache loaded.');
    },

    // Called by Plugin.js for each relevant request
    async processMessages(messages, requestConfig = {}) {
        // Merge base config with request-specific config
        const currentConfig = { ...pluginConfig, ...requestConfig };
        let globalMediaIndexForLabel = 0;
        const processedMessages = JSON.parse(JSON.stringify(messages)); // Deep copy

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

    // Called by Plugin.js on shutdown (optional)
    async shutdown() {
        await saveMediaCacheToFile();
        console.log('[MultiModalProcessor] Shutdown complete, cache saved.');
    }
};