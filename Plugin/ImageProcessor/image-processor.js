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

function _resolveMediaPath(cacheEntry, mediaIndexForLabel) {
    if (cacheEntry && typeof cacheEntry.filePath === 'string' && cacheEntry.filePath.trim()) {
        return cacheEntry.filePath.trim();
    }
    if (cacheEntry && typeof cacheEntry.id === 'string' && cacheEntry.id.trim()) {
        return `file://multimodal_cache/${cacheEntry.id.trim()}`;
    }
    return `file://multimodal_cache/media_${mediaIndexForLabel + 1}`;
}

function _formatStructuredMediaInfo(description, cacheEntry, mediaIndexForLabel) {
    const safeDescription = (description || '').replace(/\s+/g, ' ').trim();
    const mediaPath = _resolveMediaPath(cacheEntry, mediaIndexForLabel);
    return JSON.stringify(
        {
            description: safeDescription,
            filePath: mediaPath
        },
        null,
        2
    );
}

async function translateMediaAndCacheInternal(base64DataWithPrefix, mediaIndexForLabel, currentConfig) {
    const { default: fetch } = await import('node-fetch');
    const base64PrefixPattern = /^data:(image|audio|video)\/[^;]+;base64,/;
    const pureBase64Data = base64DataWithPrefix.replace(base64PrefixPattern, '');
    const mediaMimeType = (base64DataWithPrefix.match(base64PrefixPattern) || ['data:application/octet-stream;base64,'])[0].replace('base64,', '');

    const cachedEntry = mediaBase64Cache[pureBase64Data];
    if (cachedEntry) {
        const description = typeof cachedEntry === 'string' ? cachedEntry : cachedEntry.description;
        const normalizedEntry = typeof cachedEntry === 'string'
            ? { id: crypto.randomUUID(), description, timestamp: new Date().toISOString(), mimeType: mediaMimeType }
            : cachedEntry;
        console.log(`[MultiModalProcessor] Cache hit for media ${mediaIndexForLabel + 1}.`);
        return {
            inlineText: `[MULTIMODAL_DATA_${mediaIndexForLabel + 1}_Info: ${description}]`,
            structuredText: _formatStructuredMediaInfo(description, normalizedEntry, mediaIndexForLabel),
            cacheEntry: normalizedEntry
        };
    }

    console.log(`[MultiModalProcessor] Translating media ${mediaIndexForLabel + 1}...`);
    if (!currentConfig.MultiModalModel || !currentConfig.MultiModalPrompt || !currentConfig.API_Key || !currentConfig.API_URL) {
        console.error('[MultiModalProcessor] Multimodal translation config incomplete.');
        const failText = '[多模态数据转译服务配置不完整]';
        return {
            inlineText: `[MULTIMODAL_DATA_${mediaIndexForLabel + 1}_Info: ${failText}]`,
            structuredText: _formatStructuredMediaInfo(failText, null, mediaIndexForLabel),
            cacheEntry: null
        };
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
                return {
                    inlineText: `[MULTIMODAL_DATA_${mediaIndexForLabel + 1}_Info: ${cleanedDescription}]`,
                    structuredText: _formatStructuredMediaInfo(cleanedDescription, newCacheEntry, mediaIndexForLabel),
                    cacheEntry: newCacheEntry
                };
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
    const failReason = `多模态数据转译失败: ${lastError ? lastError.message.substring(0, 100) : '未知错误'}`;
    return {
        inlineText: `[MULTIMODAL_DATA_${mediaIndexForLabel + 1}_Info: ${failReason}]`,
        structuredText: _formatStructuredMediaInfo(failReason, null, mediaIndexForLabel),
        cacheEntry: null
    };
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
        const currentConfig = { ...pluginConfig, ...requestConfig };
        const transModeRaw = (currentConfig.TransBase64Mode || 'default').toString().toLowerCase();
        const transMode = ['default', 'plus', 'minus'].includes(transModeRaw) ? transModeRaw : 'default';
        const cognitoAgents = Array.isArray(currentConfig.TransBase64CognitoAgents)
            ? currentConfig.TransBase64CognitoAgents.filter(item => typeof item === 'string' && item.trim())
            : [];

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
                    const translatedInlineTexts = [];
                    const translatedStructuredTexts = [];
                    const asyncLimit = currentConfig.MultiModalModelAsynchronousLimit || 1;

                    for (let j = 0; j < mediaPartsToTranslate.length; j += asyncLimit) {
                        const chunkToTranslate = mediaPartsToTranslate.slice(j, j + asyncLimit);
                        const translationPromisesInChunk = chunkToTranslate.map((base64Url) =>
                            translateMediaAndCacheInternal(base64Url, globalMediaIndexForLabel++, currentConfig)
                        );
                        const translatedResultsInChunk = await Promise.all(translationPromisesInChunk);
                        for (const result of translatedResultsInChunk) {
                            translatedInlineTexts.push(result.inlineText);
                            translatedStructuredTexts.push(result.structuredText);
                        }
                    }

                    if (transMode === 'minus') {
                        const markerId = crypto.randomUUID();
                        const beginMarker = `[TRANSBASE64_MINUS_BEGIN_${markerId}]`;
                        const endMarker = `[TRANSBASE64_MINUS_END_${markerId}]`;
                        const agentsLine = `[CognitoAgents: ${cognitoAgents.length > 0 ? cognitoAgents.join(', ') : 'Cognito-Core'}]`;
                        const hiddenBlock = `${beginMarker}\n${agentsLine}\n${translatedStructuredTexts.join('\n')}\n${endMarker}`;

                        let userTextPart = contentWithoutMedia.find(p => p.type === 'text');
                        if (!userTextPart) {
                            userTextPart = { type: 'text', text: '' };
                            contentWithoutMedia.unshift(userTextPart);
                        }
                        userTextPart.text = (userTextPart.text ? userTextPart.text.trim() + '\n' : '') + hiddenBlock;
                        msg.content = contentWithoutMedia;
                        continue;
                    }

                    let userTextPart;
                    if (transMode === 'plus') {
                        userTextPart = msg.content.find(p => p.type === 'text');
                        if (!userTextPart) {
                            userTextPart = { type: 'text', text: '' };
                            msg.content.unshift(userTextPart);
                        }
                    } else {
                        userTextPart = contentWithoutMedia.find(p => p.type === 'text');
                        if (!userTextPart) {
                            userTextPart = { type: 'text', text: '' };
                            contentWithoutMedia.unshift(userTextPart);
                        }
                    }

                    const insertPrompt = currentConfig.MediaInsertPrompt || "[多模态数据信息已提取:]";
                    userTextPart.text = (userTextPart.text ? userTextPart.text.trim() + '\n' : '') +
                                        insertPrompt + '\n' +
                                        translatedInlineTexts.join('\n');

                    if (transMode === 'default') {
                        msg.content = contentWithoutMedia;
                    }
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