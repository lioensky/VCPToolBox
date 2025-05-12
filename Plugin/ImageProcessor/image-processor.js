// Plugin/ImageProcessor/image-processor.js
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

let imageBase64Cache = {};
// Cache file will be stored inside the plugin's directory for better encapsulation
const imageCacheFilePath = path.join(__dirname, 'image_cache.json'); 
let pluginConfig = {}; // To store config passed from Plugin.js

// --- Debug logging (simplified for plugin) ---
function debugLog(message, data) {
    if (pluginConfig.DebugMode) {
        console.log(`[ImageProcessor][Debug] ${message}`, data !== undefined ? JSON.stringify(data, null, 2) : '');
    }
}

async function loadImageCacheFromFile() {
    try {
        const data = await fs.readFile(imageCacheFilePath, 'utf-8');
        imageBase64Cache = JSON.parse(data);
        console.log(`[ImageProcessor] Loaded ${Object.keys(imageBase64Cache).length} image cache entries from ${imageCacheFilePath}`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`[ImageProcessor] Cache file ${imageCacheFilePath} not found. Initializing new cache.`);
            imageBase64Cache = {};
            await saveImageCacheToFile(); // Create an empty cache file
        } else {
            console.error(`[ImageProcessor] Error reading image cache file ${imageCacheFilePath}:`, error);
            imageBase64Cache = {}; // Fallback to empty cache
        }
    }
}

async function saveImageCacheToFile() {
    try {
        await fs.writeFile(imageCacheFilePath, JSON.stringify(imageBase64Cache, null, 2));
        debugLog(`Image cache saved to ${imageCacheFilePath}`);
    } catch (error) {
        console.error(`[ImageProcessor] Error saving image cache to ${imageCacheFilePath}:`, error);
    }
}

async function translateImageAndCacheInternal(base64DataWithPrefix, imageIndexForLabel, currentConfig) {
    const { default: fetch } = await import('node-fetch');
    const base64PrefixPattern = /^data:image\/[^;]+;base64,/;
    const pureBase64Data = base64DataWithPrefix.replace(base64PrefixPattern, '');
    const imageMimeType = (base64DataWithPrefix.match(base64PrefixPattern) || ['data:image/jpeg;base64,'])[0].replace('base64,', '');

    const cachedEntry = imageBase64Cache[pureBase64Data];
    if (cachedEntry) {
        const description = typeof cachedEntry === 'string' ? cachedEntry : cachedEntry.description; // Handle old and new cache format
        console.log(`[ImageProcessor] Cache hit for image ${imageIndexForLabel + 1}.`);
        return `[IMAGE${imageIndexForLabel + 1}Info: ${description}]`;
    }

    console.log(`[ImageProcessor] Translating image ${imageIndexForLabel + 1}...`);
    if (!currentConfig.ImageModel || !currentConfig.ImagePrompt || !currentConfig.API_Key || !currentConfig.API_URL) {
        console.error('[ImageProcessor] Image translation config incomplete.');
        return `[IMAGE${imageIndexForLabel + 1}Info: 图片转译服务配置不完整]`;
    }

    const maxRetries = 3;
    let attempt = 0;
    let lastError = null;

    while (attempt < maxRetries) {
        attempt++;
        try {
            const payload = {
                model: currentConfig.ImageModel,
                messages: [{
                    role: "user",
                    content: [
                        { type: "text", text: currentConfig.ImagePrompt },
                        { type: "image_url", image_url: { url: `${imageMimeType}base64,${pureBase64Data}` } }
                    ]
                }],
                max_tokens: currentConfig.ImageModelOutputMaxTokens || 1024,
            };
            if (currentConfig.ImageModelThinkingBudget && currentConfig.ImageModelThinkingBudget > 0) {
                payload.extra_body = { thinking_config: { thinking_budget: currentConfig.ImageModelThinkingBudget } };
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
                    timestamp: new Date().toISOString()
                };
                imageBase64Cache[pureBase64Data] = newCacheEntry;
                await saveImageCacheToFile();
                return `[IMAGE${imageIndexForLabel + 1}Info: ${cleanedDescription}]`;
            } else if (description) {
                lastError = new Error(`Description too short (length: ${description.length}, attempt ${attempt}).`);
            } else {
                lastError = new Error(`No description found in API response (attempt ${attempt}).`);
            }
        } catch (error) {
            lastError = error;
            console.error(`[ImageProcessor] Error translating image ${imageIndexForLabel + 1} (attempt ${attempt}):`, error.message);
        }
        if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, 500));
    }
    console.error(`[ImageProcessor] Failed to translate image ${imageIndexForLabel + 1} after ${maxRetries} attempts.`);
    return `[IMAGE${imageIndexForLabel + 1}Info: 图片转译失败: ${lastError ? lastError.message.substring(0,100) : '未知错误'}]`;
}

module.exports = {
    // Called by Plugin.js when loading the plugin
    async initialize(initialConfig = {}) {
        pluginConfig = initialConfig; // Store base config (like DebugMode)
        await loadImageCacheFromFile();
        console.log('[ImageProcessor] Initialized and cache loaded.');
    },

    // Called by Plugin.js for each relevant request
    async processMessages(messages, requestConfig = {}) {
        // Merge base config with request-specific config
        const currentConfig = { ...pluginConfig, ...requestConfig };
        let globalImageIndexForLabel = 0;
        const processedMessages = JSON.parse(JSON.stringify(messages)); // Deep copy

        for (let i = 0; i < processedMessages.length; i++) {
            const msg = processedMessages[i];
            if (msg.role === 'user' && Array.isArray(msg.content)) {
                const imagePartsToTranslate = [];
                const contentWithoutImages = [];

                for (const part of msg.content) {
                    if (part.type === 'image_url' && part.image_url && 
                        typeof part.image_url.url === 'string' && 
                        part.image_url.url.startsWith('data:image')) {
                        imagePartsToTranslate.push(part.image_url.url);
                    } else {
                        contentWithoutImages.push(part);
                    }
                }

                if (imagePartsToTranslate.length > 0) {
                    const allTranslatedImageTexts = [];
                    const asyncLimit = currentConfig.ImageModelAsynchronousLimit || 1;

                    for (let j = 0; j < imagePartsToTranslate.length; j += asyncLimit) {
                        const chunkToTranslate = imagePartsToTranslate.slice(j, j + asyncLimit);
                        const translationPromisesInChunk = chunkToTranslate.map((base64Url) =>
                            translateImageAndCacheInternal(base64Url, globalImageIndexForLabel++, currentConfig)
                        );
                        const translatedTextsInChunk = await Promise.all(translationPromisesInChunk);
                        allTranslatedImageTexts.push(...translatedTextsInChunk);
                    }

                    let userTextPart = contentWithoutImages.find(p => p.type === 'text');
                    if (!userTextPart) {
                        userTextPart = { type: 'text', text: '' };
                        contentWithoutImages.unshift(userTextPart);
                    }
                    const insertPrompt = currentConfig.ImageInsertPrompt || "[图像信息已提取:]";
                    userTextPart.text = (userTextPart.text ? userTextPart.text.trim() + '\n' : '') + 
                                        insertPrompt + '\n' + 
                                        allTranslatedImageTexts.join('\n');
                    msg.content = contentWithoutImages;
                }
            }
        }
        return processedMessages;
    },

    // Called by Plugin.js on shutdown (optional)
    async shutdown() {
        await saveImageCacheToFile();
        console.log('[ImageProcessor] Shutdown complete, cache saved.');
    }
};