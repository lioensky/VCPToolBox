// Plugin/ImageProcessor/image-processor.js
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

let mediaBase64Cache = {};
// Cache file will be stored inside the plugin's directory for better encapsulation
const mediaCacheFilePath = path.join(__dirname, 'multimodal_cache.json');
let pluginConfig = {}; // To store config passed from Plugin.js
const cognitoPresetPromptCache = new Map();

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

function _getMultimediaPresetsDir() {
    const explicit = process.env.MULTIMEDIA_PRESETS_PATH || process.env.MULTIMEDIA_PRESETS_DIR_PATH;
    if (explicit && explicit.trim()) return explicit.trim();
    if (process.env.PROJECT_BASE_PATH) return path.join(process.env.PROJECT_BASE_PATH, 'MultimediaPresets');
    return path.join(__dirname, '..', '..', 'MultimediaPresets');
}

function _toOptionalNumber(value) {
    if (value === null || value === undefined || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function _toOptionalInteger(value) {
    const parsed = _toOptionalNumber(value);
    if (parsed === undefined) return undefined;
    return Number.isInteger(parsed) ? parsed : Math.round(parsed);
}

function _extractPresetRequestParams(presetJson) {
    const requestParams = (presetJson && typeof presetJson.requestParams === 'object' && !Array.isArray(presetJson.requestParams))
        ? presetJson.requestParams
        : {};

    const model = typeof requestParams.model === 'string' && requestParams.model.trim()
        ? requestParams.model.trim()
        : (typeof presetJson?.model === 'string' && presetJson.model.trim() ? presetJson.model.trim() : undefined);

    const temperature = _toOptionalNumber(requestParams.temperature ?? presetJson?.temperature);
    const topP = _toOptionalNumber(requestParams.top_p ?? requestParams.topP ?? presetJson?.top_p ?? presetJson?.topP);
    const topK = _toOptionalInteger(requestParams.top_k ?? requestParams.topK ?? presetJson?.top_k ?? presetJson?.topK);

    return {
        model,
        temperature,
        top_p: topP,
        top_k: topK
    };
}

async function _resolveCognitoPrompt(currentConfig, cognitoAgents = []) {
    const defaultPrompt = currentConfig.MultiModalPrompt;
    if (!Array.isArray(cognitoAgents) || cognitoAgents.length === 0) {
        return { prompt: defaultPrompt, agentName: 'Cognito-Core', requestParams: {} };
    }

    const presetsDir = _getMultimediaPresetsDir();
    for (const rawName of cognitoAgents) {
        const agentName = (rawName || '').trim();
        if (!agentName) continue;

        const cacheKey = `${presetsDir}::${agentName}`;
        if (cognitoPresetPromptCache.has(cacheKey)) {
            const cachedPreset = cognitoPresetPromptCache.get(cacheKey);
            if (cachedPreset && cachedPreset.prompt) {
                return cachedPreset;
            }
            continue;
        }

        try {
            const presetPath = path.join(presetsDir, `${agentName}.json`);
            const presetRaw = await fs.readFile(presetPath, 'utf-8');
            const presetJson = JSON.parse(presetRaw);
            const presetPrompt = typeof presetJson.systemPrompt === 'string'
                ? presetJson.systemPrompt.trim()
                : (typeof presetJson.prompt === 'string' ? presetJson.prompt.trim() : '');

            if (presetPrompt) {
                const resolvedPreset = {
                    prompt: presetPrompt,
                    agentName,
                    requestParams: _extractPresetRequestParams(presetJson)
                };
                cognitoPresetPromptCache.set(cacheKey, resolvedPreset);
                return resolvedPreset;
            }

            cognitoPresetPromptCache.set(cacheKey, null);
            console.warn(`[MultiModalProcessor] Cognito预设缺少 systemPrompt/prompt，跳过: ${agentName}`);
        } catch (error) {
            cognitoPresetPromptCache.set(cacheKey, null);
            console.warn(`[MultiModalProcessor] Cognito预设加载失败，跳过: ${agentName} (${error.message})`);
        }
    }

    return { prompt: defaultPrompt, agentName: 'Cognito-Core', requestParams: {} };
}

async function translateMediaAndCacheInternal(base64DataWithPrefix, mediaIndexForLabel, currentConfig, cognitoAgents = []) {
    const { default: fetch } = await import('node-fetch');
    const base64PrefixPattern = /^data:(image|audio|video)\/[^;]+;base64,/;
    const pureBase64Data = base64DataWithPrefix.replace(base64PrefixPattern, '');
    const mediaMimeType = (base64DataWithPrefix.match(base64PrefixPattern) || ['data:application/octet-stream;base64,'])[0].replace('base64,', '');

    const cacheKey = pureBase64Data;
    const hasExplicitPreset = Array.isArray(cognitoAgents) && cognitoAgents.length > 0;

    const cachedEntry = mediaBase64Cache[cacheKey];
    if (cachedEntry && hasExplicitPreset && cachedEntry && typeof cachedEntry === 'object') {
        for (const rawName of cognitoAgents) {
            const agentName = (rawName || '').trim();
            if (!agentName) continue;

            if (cachedEntry.variants && cachedEntry.variants[agentName] && typeof cachedEntry.variants[agentName].description === 'string' && cachedEntry.variants[agentName].description.trim()) {
                const selectedEntry = cachedEntry.variants[agentName];
                console.log(`[MultiModalProcessor] Cache hit for media ${mediaIndexForLabel + 1}. agent=${agentName}`);
                return {
                    inlineText: `[MULTIMODAL_DATA_${mediaIndexForLabel + 1}_Info: ${selectedEntry.description}]`,
                    structuredText: _formatStructuredMediaInfo(selectedEntry.description, selectedEntry, mediaIndexForLabel),
                    cacheEntry: selectedEntry
                };
            }

            if (cachedEntry.cognitoAgent === agentName && typeof cachedEntry.description === 'string' && cachedEntry.description.trim()) {
                const selectedEntry = cachedEntry;
                console.log(`[MultiModalProcessor] Cache hit for media ${mediaIndexForLabel + 1}. agent=${agentName}`);
                return {
                    inlineText: `[MULTIMODAL_DATA_${mediaIndexForLabel + 1}_Info: ${selectedEntry.description}]`,
                    structuredText: _formatStructuredMediaInfo(selectedEntry.description, selectedEntry, mediaIndexForLabel),
                    cacheEntry: selectedEntry
                };
            }
        }
    }

    const { prompt: effectivePrompt, agentName: effectiveAgentName, requestParams } = await _resolveCognitoPrompt(currentConfig, cognitoAgents);
    const presetSignature = effectiveAgentName || 'Cognito-Core';
    const requirePresetVariant = hasExplicitPreset && presetSignature !== 'Cognito-Core';

    if (cachedEntry) {
        let selectedEntry = null;

        if (typeof cachedEntry === 'string') {
            if (!requirePresetVariant) {
                selectedEntry = {
                    id: crypto.randomUUID(),
                    description: cachedEntry,
                    timestamp: new Date().toISOString(),
                    mimeType: mediaMimeType,
                    cognitoAgent: 'Cognito-Core'
                };
            }
        } else if (cachedEntry && typeof cachedEntry === 'object') {
            if (cachedEntry.variants && cachedEntry.variants[presetSignature]) {
                selectedEntry = cachedEntry.variants[presetSignature];
            } else if (requirePresetVariant && cachedEntry.cognitoAgent === presetSignature && typeof cachedEntry.description === 'string' && cachedEntry.description.trim()) {
                selectedEntry = cachedEntry;
            } else if (!requirePresetVariant) {
                const isDefaultAgent = !cachedEntry.cognitoAgent || cachedEntry.cognitoAgent === 'Cognito-Core';
                if (isDefaultAgent && typeof cachedEntry.description === 'string' && cachedEntry.description.trim()) {
                    selectedEntry = cachedEntry;
                } else if (cachedEntry.variants && cachedEntry.variants['Cognito-Core']) {
                    selectedEntry = cachedEntry.variants['Cognito-Core'];
                }
            }
        }

        if (selectedEntry && typeof selectedEntry.description === 'string' && selectedEntry.description.trim()) {
            console.log(`[MultiModalProcessor] Cache hit for media ${mediaIndexForLabel + 1}. agent=${presetSignature}`);
            return {
                inlineText: `[MULTIMODAL_DATA_${mediaIndexForLabel + 1}_Info: ${selectedEntry.description}]`,
                structuredText: _formatStructuredMediaInfo(selectedEntry.description, selectedEntry, mediaIndexForLabel),
                cacheEntry: selectedEntry
            };
        }
    }

    console.log(`[MultiModalProcessor] Translating media ${mediaIndexForLabel + 1} with agent=${presetSignature}...`);
    if (!currentConfig.MultiModalModel || !effectivePrompt || !currentConfig.API_Key || !currentConfig.API_URL) {
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
                model: requestParams?.model || currentConfig.MultiModalModel,
                messages: [{
                    role: "user",
                    content: [
                        { type: "text", text: effectivePrompt },
                        { type: "image_url", image_url: { url: `${mediaMimeType}base64,${pureBase64Data}` } }
                    ]
                }],
                max_tokens: currentConfig.MultiModalModelOutputMaxTokens || 50000,
            };

            if (typeof requestParams?.temperature === 'number') {
                payload.temperature = requestParams.temperature;
            }
            if (typeof requestParams?.top_p === 'number') {
                payload.top_p = requestParams.top_p;
            }
            if (typeof requestParams?.top_k === 'number') {
                payload.top_k = requestParams.top_k;
            }

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
                    mimeType: mediaMimeType,
                    cognitoAgent: presetSignature
                };

                const existing = mediaBase64Cache[cacheKey];
                if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
                    const mergedVariants = {
                        ...(existing.variants && typeof existing.variants === 'object' ? existing.variants : {})
                    };
                    mergedVariants[presetSignature] = newCacheEntry;
                    mediaBase64Cache[cacheKey] = {
                        ...existing,
                        variants: mergedVariants,
                        description: existing.description || newCacheEntry.description,
                        id: existing.id || newCacheEntry.id,
                        timestamp: existing.timestamp || newCacheEntry.timestamp,
                        mimeType: existing.mimeType || newCacheEntry.mimeType,
                        cognitoAgent: existing.cognitoAgent || newCacheEntry.cognitoAgent
                    };
                } else if (typeof existing === 'string') {
                    mediaBase64Cache[cacheKey] = {
                        id: crypto.randomUUID(),
                        description: existing,
                        timestamp: new Date().toISOString(),
                        mimeType: mediaMimeType,
                        cognitoAgent: 'Cognito-Core',
                        variants: {
                            'Cognito-Core': {
                                id: crypto.randomUUID(),
                                description: existing,
                                timestamp: new Date().toISOString(),
                                mimeType: mediaMimeType,
                                cognitoAgent: 'Cognito-Core'
                            },
                            [presetSignature]: newCacheEntry
                        }
                    };
                } else {
                    mediaBase64Cache[cacheKey] = {
                        ...newCacheEntry,
                        variants: {
                            [presetSignature]: newCacheEntry
                        }
                    };
                }

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
                    const translatedStructuredTexts = [];
                    const asyncLimit = currentConfig.MultiModalModelAsynchronousLimit || 1;

                    for (let j = 0; j < mediaPartsToTranslate.length; j += asyncLimit) {
                        const chunkToTranslate = mediaPartsToTranslate.slice(j, j + asyncLimit);
                        const translationPromisesInChunk = chunkToTranslate.map((base64Url) =>
                            translateMediaAndCacheInternal(base64Url, globalMediaIndexForLabel++, currentConfig, cognitoAgents)
                        );
                        const translatedResultsInChunk = await Promise.all(translationPromisesInChunk);
                        for (const result of translatedResultsInChunk) {
                            translatedStructuredTexts.push(result.structuredText);
                        }
                    }

                    const agentsLine = `[CognitoAgents: ${cognitoAgents.length > 0 ? cognitoAgents.join(', ') : 'Cognito-Core'}]`;

                    if (transMode === 'minus') {
                        const markerId = crypto.randomUUID();
                        const beginMarker = `[TRANSBASE64_MINUS_BEGIN_${markerId}]`;
                        const endMarker = `[TRANSBASE64_MINUS_END_${markerId}]`;
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
                    const injectedBlock = `${insertPrompt}\n${agentsLine}\n${translatedStructuredTexts.join('\n')}`;
                    userTextPart.text = (userTextPart.text ? userTextPart.text.trim() + '\n' : '') + injectedBlock;

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