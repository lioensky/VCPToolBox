// modules/messageProcessor.js
const fs = require('fs').promises;
const path = require('path');
const lunarCalendar = require('chinese-lunar-calendar');
const agentManager = require('./agentManager.js'); // 引入新的Agent管理器
const tvsManager = require('./tvsManager.js'); // 引入新的TVS管理器
const toolboxManager = require('./toolboxManager.js');
const sarPromptManager = require('./sarPromptManager.js');

const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai';
const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || 'Asia/Shanghai'; // 新增：用于控制 AI 报告的时间，默认回退到中国时区
function resolveAgentDir() {
    const configPath = process.env.AGENT_DIR_PATH;
    if (!configPath || typeof configPath !== 'string' || configPath.trim() === '') {
        return path.join(__dirname, '..', 'Agent');
    }
    const normalizedPath = path.normalize(configPath.trim());
    return path.isAbsolute(normalizedPath)
        ? normalizedPath
        : path.resolve(__dirname, '..', normalizedPath);
}
const AGENT_DIR = resolveAgentDir();
function resolveTvsDir() {
    const configPath = process.env.TVSTXT_DIR_PATH;
    if (!configPath || typeof configPath !== 'string' || configPath.trim() === '') {
        return path.join(__dirname, '..', 'TVStxt');
    }
    const normalizedPath = path.normalize(configPath.trim());
    return path.isAbsolute(normalizedPath)
        ? normalizedPath
        : path.resolve(__dirname, '..', normalizedPath);
}
const TVS_DIR = resolveTvsDir();
const VCP_ASYNC_RESULTS_DIR = path.join(__dirname, '..', 'VCPAsyncResults');

async function resolveAllVariables(text, model, role, context, processingStack = new Set()) {
    if (text == null) return '';
    let processedText = String(text);

    // 🔒 安全防护：Agent 和 Toolbox 占位符仅在特权角色中展开
    // 特权角色包括：1) 标准 system 消息  2) VCPTavern 注入的以 [系统提示:] / [系统邀请指令:] 开头的 user 消息
    // 防止用户在普通 user/assistant 消息中通过 {{agent:XXX}} 注入来读取 Agent prompt 或触发意外展开
    const isPrivilegedRole = (role === 'system') || (role === 'user' && (processedText.startsWith('[系统提示:]') || processedText.startsWith('[系统邀请指令:]')));

    // 通用正则表达式，匹配所有 {{...}} 格式的占位符
    // CJK Radicals Supplement - Ideographic Description Characters 0x2E80 - 0x2FFF
    // Hiragana - CJK Unified Ideographs 0x3040 - 0x9FFF
    // 跳过标点符号 CJK Symbols and Punctuation 0x3000 - 0x303F
    const placeholderRegex = /\{\{([a-zA-Z0-9_:\u2e80-\u2fff\u3040-\u9fff]+)\}\}/g;
    const matches = [...processedText.matchAll(placeholderRegex)];

    // 提取所有潜在的别名（去除 "agent:" / "toolbox:" 前缀）
    const allAliases = new Set(matches.map(match => match[1].replace(/^(agent:|toolbox:)/, '')));

    if (isPrivilegedRole) {
        for (const alias of allAliases) {
            // 关键：使用 agentManager 来判断这是否是一个真正的Agent
            if (agentManager.isAgent(alias)) {
                // 🔒 灵魂级安全：Agent 占位符在整个上下文中只允许展开一个
                // 如果已有其他 Agent 被展开，当前 Agent 占位符静默移除（替换为空串）
                if (context.expandedAgentName !== undefined && context.expandedAgentName !== null) {
                    if (context.expandedAgentName !== alias) {
                        // 已有不同的 Agent 被展开，静默移除当前占位符
                        if (context.DEBUG_MODE) {
                            console.log(`[AgentGuard] Agent '${alias}' 被拒绝展开：上下文中已展开 '${context.expandedAgentName}'，仅允许一个 Agent`);
                        }
                        processedText = processedText.replaceAll(`{{${alias}}}`, '').replaceAll(`{{agent:${alias}}}`, '');
                        continue;
                    }
                    // 同名 Agent 在后续消息中重复出现，也静默移除（首次已展开）
                    processedText = processedText.replaceAll(`{{${alias}}}`, '').replaceAll(`{{agent:${alias}}}`, '');
                    continue;
                }

                if (processingStack.has(alias)) {
                    console.error(`[AgentManager] Circular dependency detected! Stack: [${[...processingStack].join(' -> ')} -> ${alias}]`);
                    const errorMessage = `[Error: Circular agent reference detected for '${alias}']`;
                    processedText = processedText.replaceAll(`{{${alias}}}`, errorMessage).replaceAll(`{{agent:${alias}}}`, errorMessage);
                    continue;
                }

                const agentContent = await agentManager.getAgentPrompt(alias);

                processingStack.add(alias);
                const resolvedAgentContent = await resolveAllVariables(agentContent, model, role, context, processingStack);
                processingStack.delete(alias);

                // 替换两种可能的Agent占位符格式
                processedText = processedText.replaceAll(`{{${alias}}}`, resolvedAgentContent);
                processedText = processedText.replaceAll(`{{agent:${alias}}}`, resolvedAgentContent);

                // 标记此 Agent 已被展开，后续消息中的任何 Agent 占位符都将被忽略
                context.expandedAgentName = alias;
            }
        }

        // 在所有Agent都被递归展开后，处理 toolbox 占位符
        for (const alias of allAliases) {
            if (toolboxManager.isToolbox(alias)) {
                // 🔒 Toolbox 去重：每种 toolbox 在整个上下文中只展开一次
                // 同名 toolbox 在后续消息中重复出现时静默移除
                if (context.expandedToolboxes && context.expandedToolboxes.has(alias)) {
                    if (context.DEBUG_MODE) {
                        console.log(`[ToolboxGuard] Toolbox '${alias}' 已在之前的消息中展开，跳过重复展开`);
                    }
                    processedText = processedText
                        .replaceAll(`{{${alias}}}`, '')
                        .replaceAll(`{{toolbox:${alias}}}`, '');
                    continue;
                }

                const stackKey = `toolbox:${alias}`;
                if (processingStack.has(stackKey)) {
                    const errorMessage = `[Error: Circular toolbox reference detected for '${alias}']`;
                    processedText = processedText
                        .replaceAll(`{{${alias}}}`, errorMessage)
                        .replaceAll(`{{toolbox:${alias}}}`, errorMessage);
                    continue;
                }

                processingStack.add(stackKey);
                const foldObj = await toolboxManager.getFoldObject(alias);
                const expandedText = await resolveDynamicFoldProtocol(
                    foldObj,
                    context,
                    `{{${alias}}}`
                );
                processingStack.delete(stackKey);

                processedText = processedText
                    .replaceAll(`{{${alias}}}`, expandedText)
                    .replaceAll(`{{toolbox:${alias}}}`, expandedText);

                // 标记此 Toolbox 已展开
                if (context.expandedToolboxes) {
                    context.expandedToolboxes.add(alias);
                }
            }
        }
    }

    // 处理剩余的非Agent占位符
    processedText = await replacePriorityVariables(processedText, context, role);
    processedText = await replaceOtherVariables(processedText, model, role, context);

    return processedText;
}

// 🌟 新增：动态折叠协议处理器
async function resolveDynamicFoldProtocol(foldObj, context, placeholderKey) {
    if (!foldObj || !foldObj.vcp_dynamic_fold || !Array.isArray(foldObj.fold_blocks) || foldObj.fold_blocks.length === 0) {
        return `[无效的动态折叠数据结构: ${placeholderKey}]`;
    }

    const blocks = foldObj.fold_blocks
        .filter(block => block && typeof block.content === 'string');
    const blocksByThreshold = [...blocks].sort((a, b) => (b.threshold || 0) - (a.threshold || 0));
    const fallbackBlock = [...blocksByThreshold].reverse().find(block => block.content)
        || { threshold: 0.0, content: '' };

    try {
        const ragPlugin = context.pluginManager.messagePreprocessors?.get('RAGDiaryPlugin');
        if (!ragPlugin || typeof ragPlugin.getSingleEmbeddingCached !== 'function') {
            if (context.DEBUG_MODE) console.log(`[DynamicFold] RAGDiaryPlugin 不可用，返回基础内容 (${placeholderKey})`);
            return fallbackBlock.content;
        }

        const contextMessages = context.messages || [];
        const lastUserMessageIndex = contextMessages.findLastIndex(m => {
            if (m.role !== 'user') return false;
            const content = typeof m.content === 'string'
                ? m.content
                : (Array.isArray(m.content) ? (m.content.find(p => p.type === 'text')?.text || '') : '');
            return !content.startsWith('[系统邀请指令:]') && !content.trim().startsWith('[系统提示:]无内容');
        });
        const lastAiMessageIndex = contextMessages.findLastIndex(m => m.role === 'assistant');

        let userContent = '';
        let aiContent = null;

        if (lastUserMessageIndex > -1) {
            const m = contextMessages[lastUserMessageIndex];
            userContent = typeof m.content === 'string'
                ? m.content
                : (Array.isArray(m.content) ? (m.content.find(p => p.type === 'text')?.text || '') : '');
        }

        if (lastAiMessageIndex > -1) {
            const m = contextMessages[lastAiMessageIndex];
            aiContent = typeof m.content === 'string'
                ? m.content
                : (Array.isArray(m.content) ? (m.content.find(p => p.type === 'text')?.text || '') : '');
        }

        if (!userContent) {
            if (context.DEBUG_MODE) console.log(`[DynamicFold] 未找到 User 文本消息，返回基础内容 (${placeholderKey})`);
            return fallbackBlock.content;
        }

        if (typeof ragPlugin.sanitizeForEmbedding === 'function') {
            if (userContent) {
                const originalUserContent = userContent;
                userContent = ragPlugin.sanitizeForEmbedding(userContent, 'user');
                if (context.DEBUG_MODE && originalUserContent.length !== userContent.length) {
                    console.log('[DynamicFold] User content was sanitized via unified sanitizer.');
                }
            }
            if (aiContent) {
                const originalAiContent = aiContent;
                aiContent = ragPlugin.sanitizeForEmbedding(aiContent, 'assistant');
                if (context.DEBUG_MODE && originalAiContent.length !== aiContent.length) {
                    console.log('[DynamicFold] AI content was sanitized via unified sanitizer.');
                }
            }
        } else {
            if (typeof ragPlugin._stripSystemNotification === 'function') {
                if (userContent) {
                    userContent = ragPlugin._stripSystemNotification(userContent);
                    userContent = ragPlugin._stripHtml(userContent);
                    userContent = ragPlugin._stripEmoji(userContent);
                    userContent = ragPlugin._stripToolMarkers(userContent);
                }
            }
            if (aiContent && typeof ragPlugin._stripHtml === 'function') {
                aiContent = ragPlugin._stripHtml(aiContent);
                aiContent = ragPlugin._stripEmoji(aiContent);
                aiContent = ragPlugin._stripToolMarkers(aiContent);
            }
        }

        const config = ragPlugin.ragParams?.RAGDiaryPlugin || {};
        const mainWeights = config.mainSearchWeights || [0.7, 0.3];

        const [uVec, aVec] = await Promise.all([
            userContent ? ragPlugin.getSingleEmbeddingCached(userContent) : Promise.resolve(null),
            aiContent ? ragPlugin.getSingleEmbeddingCached(aiContent) : Promise.resolve(null)
        ]);

        const userVector = ragPlugin._getWeightedAverageVector([uVec, aVec], mainWeights);
        if (!userVector) {
            if (context.DEBUG_MODE) console.log(`[DynamicFold] 获取用户上下文向量失败，返回基础内容 (${placeholderKey})`);
            return fallbackBlock.content;
        }

        const vectorCache = new Map();
        const getDescriptionVector = async (descriptionText) => {
            const key = String(descriptionText || '').trim();
            if (!key) return null;
            if (vectorCache.has(key)) return vectorCache.get(key);

            let descVector = null;
            if (ragPlugin.vectorDBManager && typeof ragPlugin.vectorDBManager.getPluginDescriptionVector === 'function') {
                descVector = await ragPlugin.vectorDBManager.getPluginDescriptionVector(
                    key,
                    ragPlugin.getSingleEmbeddingCached.bind(ragPlugin)
                );
            } else {
                descVector = await ragPlugin.getSingleEmbeddingCached(key);
            }
            vectorCache.set(key, descVector);
            return descVector;
        };

        const cosineSimilarity = (vectorA, vectorB) => {
            if (!vectorA || !vectorB) return 0;
            let dotProduct = 0;
            let normA = 0;
            let normB = 0;
            const len = Math.min(vectorA.length, vectorB.length);
            for (let i = 0; i < len; i++) {
                dotProduct += vectorA[i] * vectorB[i];
                normA += vectorA[i] * vectorA[i];
                normB += vectorB[i] * vectorB[i];
            }
            return (normA === 0 || normB === 0)
                ? 0
                : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
        };

        const toolboxBlockStrategy = foldObj.dynamic_fold_strategy === 'toolbox_block_similarity';

        let pluginSimilarity = null;
        const getPluginSimilarity = async () => {
            if (pluginSimilarity != null) return pluginSimilarity;
            const descText = foldObj.plugin_description || placeholderKey;
            const descVector = await getDescriptionVector(descText);
            if (!descVector) {
                if (context.DEBUG_MODE) console.log(`[DynamicFold] 获取插件描述向量失败，返回基础内容 (${placeholderKey})`);
                pluginSimilarity = 0;
                return pluginSimilarity;
            }
            pluginSimilarity = cosineSimilarity(descVector, userVector);
            if (context.DEBUG_MODE) {
                console.log(`[DynamicFold] ${placeholderKey} 上下文相似度: ${pluginSimilarity.toFixed(3)} (目标区块数: ${blocks.length})`);
            }
            return pluginSimilarity;
        };

        if (!toolboxBlockStrategy) {
            const sim = await getPluginSimilarity();
            for (const block of blocksByThreshold) {
                const threshold = Number.isFinite(Number(block.threshold)) ? Number(block.threshold) : 0;
                if (sim >= threshold) {
                    if (context.DEBUG_MODE) console.log(`[DynamicFold] ${placeholderKey} 命中阈值 >= ${threshold}，展开相关内容。`);
                    return block.content;
                }
            }
            return fallbackBlock.content;
        }

        const getThreshold = (block) => Number.isFinite(Number(block.threshold)) ? Number(block.threshold) : 0;
        const includedContents = [];
        let hiddenBlocksCount = 0;

        const legacyBlocks = blocks.filter(block => !(typeof block.description === 'string' && block.description.trim()));
        let activeLegacyBlocks = new Set();
        if (legacyBlocks.length > 0) {
            const legacySim = await getPluginSimilarity();
            const matchedLegacyBlocks = legacyBlocks.filter(block => legacySim >= getThreshold(block));
            if (matchedLegacyBlocks.length > 0) {
                activeLegacyBlocks = new Set(matchedLegacyBlocks);
            } else {
                const minLegacyThreshold = legacyBlocks.reduce((min, block) => Math.min(min, getThreshold(block)), Infinity);
                activeLegacyBlocks = new Set(legacyBlocks.filter(block => getThreshold(block) <= minLegacyThreshold));
            }
        }

        for (const block of blocks) {
            const threshold = getThreshold(block);
            const description = typeof block.description === 'string' ? block.description.trim() : '';
            const content = block.content;

            if (!description) {
                if (activeLegacyBlocks.has(block)) {
                    includedContents.push(content);
                } else {
                    hiddenBlocksCount += 1;
                }
                continue;
            }

            const descVector = await getDescriptionVector(description);
            const sim = cosineSimilarity(descVector, userVector);
            if (context.DEBUG_MODE) {
                console.log(`[DynamicFold] ${placeholderKey} 区块描述相似度: ${sim.toFixed(3)} / 阈值 ${threshold.toFixed(3)} / 描述 ${description}`);
            }

            if (sim >= threshold) {
                includedContents.push(content);
            } else {
                hiddenBlocksCount += 1;
            }
        }

        let combinedContent = includedContents.filter(Boolean).join('\n\n---\n\n');
        if (!combinedContent) {
            combinedContent = fallbackBlock.content;
        }

        if (hiddenBlocksCount > 0) {
            combinedContent += `\n\n*(提示：当前上下文中还隐藏收纳了另外 ${hiddenBlocksCount} 个工具模块分组，您可以通过明确提问或强调相关语境来获得展开。)*`;
        }

        return combinedContent;
    } catch (e) {
        console.error(`[DynamicFold] 处理动态折叠时发生异常 (${placeholderKey}):`, e.message);
        return fallbackBlock.content;
    }
}

async function replaceOtherVariables(text, model, role, context) {
    const { pluginManager, cachedEmojiLists, detectors, superDetectors, DEBUG_MODE } = context;
    if (text == null) return '';
    let processedText = String(text);

    // SarModel 高级预设注入，对 system 角色或 VCPTavern 注入的 user 角色生效
    const systemMarkers = ['[系统提示:]', '[系统邀请指令:]', '[系统通知:]', '[系统通知]'];
    const isSystemLike = role === 'system' || (role === 'user' && systemMarkers.some(marker => processedText.startsWith(marker)));

    if (isSystemLike) {
        // 查找所有独特的 SarPrompt 占位符，例如 {{SarPrompt1}}, {{SarPrompt2}}
        const sarPlaceholderRegex = /\{\{(SarPrompt\d+)\}\}/g;
        const matches = [...processedText.matchAll(sarPlaceholderRegex)];
        const uniquePlaceholders = [...new Set(matches.map(match => match[0]))];

        for (const placeholder of uniquePlaceholders) {
            // 从 {{SarPrompt4}} 中提取 SarPrompt4
            const promptKey = placeholder.substring(2, placeholder.length - 2);
            
            // 从 sarPromptManager 中查找匹配的 promptKey
            const prompts = sarPromptManager.getAllPrompts();
            const group = prompts.find(g => g.promptKey === promptKey);
            let replacementText = ''; // 默认替换为空字符串

            if (group && group.models && group.content) {
                const modelList = group.models.map(m => m.trim().toLowerCase());
                // 检查当前模型是否在列表中
                if (model && modelList.includes(model.toLowerCase())) {
                    let promptValue = group.content;
                    // 模型匹配，准备注入的文本
                    if (typeof promptValue === 'string' && promptValue.toLowerCase().endsWith('.txt')) {
                        const fileContent = await tvsManager.getContent(promptValue);
                        if (fileContent.startsWith('[变量文件') || fileContent.startsWith('[处理变量文件')) {
                            promptValue = fileContent;
                        } else {
                            // 递归解析文件内容中的变量
                            promptValue = await replaceOtherVariables(fileContent, model, role, context);
                        }
                    }
                    replacementText = promptValue;
                }
            }

            // 对当前文本中所有匹配的占位符进行替换
            const placeholderRegExp = new RegExp(placeholder.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
            processedText = processedText.replace(placeholderRegExp, replacementText);
        }
    }

    if (role === 'system') {
        for (const envKey in process.env) {
            if (envKey.startsWith('Tar') || envKey.startsWith('Var')) {
                const placeholder = `{{${envKey}}}`;
                if (processedText.includes(placeholder)) {
                    const value = process.env[envKey];
                    if (value && typeof value === 'string' && value.toLowerCase().endsWith('.txt')) {
                        const fileContent = await tvsManager.getContent(value);
                        // 检查内容是否表示错误
                        if (fileContent.startsWith('[变量文件') || fileContent.startsWith('[处理变量文件')) {
                            processedText = processedText.replaceAll(placeholder, fileContent);
                        } else {
                            const resolvedContent = await replaceOtherVariables(fileContent, model, role, context);
                            processedText = processedText.replaceAll(placeholder, resolvedContent);
                        }
                    } else {
                        processedText = processedText.replaceAll(placeholder, value || `[未配置 ${envKey}]`);
                    }
                }
            }
        }

        const now = new Date();
        if (DEBUG_MODE) {
            console.log(`[TimeVar] Raw Date: ${now.toISOString()}`);
            console.log(`[TimeVar] Default Timezone (for internal use): ${DEFAULT_TIMEZONE}`);
            console.log(`[TimeVar] Report Timezone (for AI prompt): ${REPORT_TIMEZONE}`);
        }
        // 使用 REPORT_TIMEZONE 替换时间占位符
        const date = now.toLocaleDateString('zh-CN', { timeZone: REPORT_TIMEZONE });
        processedText = processedText.replace(/\{\{Date\}\}/g, date);
        const time = now.toLocaleTimeString('zh-CN', { timeZone: REPORT_TIMEZONE });
        processedText = processedText.replace(/\{\{Time\}\}/g, time);
        const today = now.toLocaleDateString('zh-CN', { weekday: 'long', timeZone: REPORT_TIMEZONE });
        processedText = processedText.replace(/\{\{Today\}\}/g, today);
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const day = now.getDate();
        const lunarDate = lunarCalendar.getLunar(year, month, day);
        let yearName = lunarDate.lunarYear.replace('年', '');
        let festivalInfo = `${yearName}${lunarDate.zodiac}年${lunarDate.dateStr}`;
        if (lunarDate.solarTerm) festivalInfo += ` ${lunarDate.solarTerm}`;
        processedText = processedText.replace(/\{\{Festival\}\}/g, festivalInfo);

        const staticPlaceholderValues = pluginManager.getAllPlaceholderValues(); // Use the getter
        if (staticPlaceholderValues && staticPlaceholderValues.size > 0) {
            for (const [placeholder, entry] of staticPlaceholderValues.entries()) {
                // 修复上下文折叠漏洞：如果当前文本压根没有这个占位符，直接跳过，避免触发不必要的向量化和计算
                if (!processedText.includes(placeholder)) {
                    continue;
                }

                const placeholderRegex = new RegExp(placeholder.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');

                let valueToInject = entry;
                if (typeof entry === 'object' && entry !== null && entry.hasOwnProperty('value')) {
                    valueToInject = entry.value;
                }

                // 支持 vcp_dynamic_fold 协议
                if (typeof valueToInject === 'object' && valueToInject !== null && valueToInject.vcp_dynamic_fold) {
                    valueToInject = await resolveDynamicFoldProtocol(valueToInject, context, placeholder);
                }

                processedText = processedText.replace(placeholderRegex, valueToInject || `[${placeholder} 信息不可用]`);
            }
        }

        const individualPluginDescriptions = pluginManager.getIndividualPluginDescriptions();
        if (individualPluginDescriptions && individualPluginDescriptions.size > 0) {
            for (const [placeholderKey, description] of individualPluginDescriptions) {
                processedText = processedText.replaceAll(`{{${placeholderKey}}}`, description || `[${placeholderKey} 信息不可用]`);
            }
        }

        if (processedText.includes('{{VCPAllTools}}')) {
            const vcpDescriptionsList = [];
            if (individualPluginDescriptions && individualPluginDescriptions.size > 0) {
                for (const description of individualPluginDescriptions.values()) {
                    vcpDescriptionsList.push(description);
                }
            }
            const allVcpToolsString = vcpDescriptionsList.length > 0 ? vcpDescriptionsList.join('\n\n---\n\n') : '没有可用的VCP工具描述信息';
            processedText = processedText.replaceAll('{{VCPAllTools}}', allVcpToolsString);
        }

        if (process.env.PORT) {
            processedText = processedText.replaceAll('{{Port}}', process.env.PORT);
        }
        const effectiveImageKey = pluginManager.getResolvedPluginConfigValue('ImageServer', 'Image_Key');
        if (processedText && typeof processedText === 'string' && effectiveImageKey) {
            processedText = processedText.replaceAll('{{Image_Key}}', effectiveImageKey);
        } else if (processedText && typeof processedText === 'string' && processedText.includes('{{Image_Key}}')) {
            if (DEBUG_MODE) console.warn('[replaceOtherVariables] {{Image_Key}} placeholder found in text, but ImageServer plugin or its Image_Key is not resolved. Placeholder will not be replaced.');
        }
        for (const rule of detectors) {
            if (typeof rule.detector === 'string' && rule.detector.length > 0 && typeof rule.output === 'string') {
                processedText = processedText.replaceAll(rule.detector, rule.output);
            }
        }
    }

    for (const rule of superDetectors) {
        if (typeof rule.detector === 'string' && rule.detector.length > 0 && typeof rule.output === 'string') {
            processedText = processedText.replaceAll(rule.detector, rule.output);
        }
    }

    const asyncResultPlaceholderRegex = /\{\{VCP_ASYNC_RESULT::([a-zA-Z0-9_.-]+)::([a-zA-Z0-9_-]+)\}\}/g;
    let asyncMatch;
    let tempAsyncProcessedText = processedText;
    const promises = [];

    while ((asyncMatch = asyncResultPlaceholderRegex.exec(processedText)) !== null) {
        const placeholder = asyncMatch[0];
        const pluginName = asyncMatch[1];
        const requestId = asyncMatch[2];

        promises.push(
            (async () => {
                const resultFilePath = path.join(VCP_ASYNC_RESULTS_DIR, `${pluginName}-${requestId}.json`);
                try {
                    const fileContent = await fs.readFile(resultFilePath, 'utf-8');
                    const callbackData = JSON.parse(fileContent);
                    let replacementText = `[任务 ${pluginName} (ID: ${requestId}) 已完成]`;
                    if (callbackData && callbackData.message) {
                        replacementText = callbackData.message;
                    } else if (callbackData && callbackData.status === 'Succeed') {
                        replacementText = `任务 ${pluginName} (ID: ${requestId}) 已成功完成。详情: ${JSON.stringify(callbackData.data || callbackData.result || callbackData)}`;
                    } else if (callbackData && callbackData.status === 'Failed') {
                        replacementText = `任务 ${pluginName} (ID: ${requestId}) 处理失败。原因: ${callbackData.reason || JSON.stringify(callbackData.data || callbackData.error || callbackData)}`;
                    }
                    tempAsyncProcessedText = tempAsyncProcessedText.replace(placeholder, replacementText);
                } catch (error) {
                    if (error.code === 'ENOENT') {
                        tempAsyncProcessedText = tempAsyncProcessedText.replace(placeholder, `[任务 ${pluginName} (ID: ${requestId}) 结果待更新...]`);
                    } else {
                        console.error(`[replaceOtherVariables] Error processing async placeholder ${placeholder}:`, error);
                        tempAsyncProcessedText = tempAsyncProcessedText.replace(placeholder, `[获取任务 ${pluginName} (ID: ${requestId}) 结果时出错]`);
                    }
                }
            })()
        );
    }

    await Promise.all(promises);
    processedText = tempAsyncProcessedText;

    return processedText;
}

async function replacePriorityVariables(text, context, role) {
    const { pluginManager, cachedEmojiLists, DEBUG_MODE } = context;
    if (text == null) return '';
    let processedText = String(text);

    // 只在 system role 中处理
    if (role !== 'system') {
        return processedText;
    }

    // --- 表情包处理 ---
    const emojiPlaceholderRegex = /\{\{([^{}]+?表情包)\}\}/g;
    let emojiMatch;
    while ((emojiMatch = emojiPlaceholderRegex.exec(processedText)) !== null) {
        const placeholder = emojiMatch[0];
        const emojiName = emojiMatch[1];
        const emojiList = cachedEmojiLists.get(emojiName);
        processedText = processedText.replaceAll(placeholder, emojiList || `[${emojiName}列表不可用]`);
    }

    // --- 日记本处理 (迁移到 RAGDiaryPlugin) ---
    // (逻辑已移除)

    return processedText;
}

module.exports = {
    // 导出主函数，并重命名旧函数以供内部调用
    replaceAgentVariables: resolveAllVariables,
    replaceOtherVariables,
    replacePriorityVariables
};
