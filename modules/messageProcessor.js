// modules/messageProcessor.js
const fs = require('fs').promises;
const path = require('path');
const lunarCalendar = require('chinese-lunar-calendar');
const agentManager = require('./agentManager.js'); // 引入新的Agent管理器
const tvsManager = require('./tvsManager.js'); // 引入新的TVS管理器

const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai';
const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || 'Asia/Shanghai'; // 新增：用于控制 AI 报告的时间，默认回退到中国时区
const AGENT_DIR = path.join(__dirname, '..', 'Agent');
const TVS_DIR = path.join(__dirname, '..', 'TVStxt');
const VCP_ASYNC_RESULTS_DIR = path.join(__dirname, '..', 'VCPAsyncResults');

async function resolveAllVariables(text, model, role, context, processingStack = new Set()) {
    if (text == null) return '';
    let processedText = String(text);

    // 通用正则表达式，匹配所有 {{...}} 格式的占位符
    const placeholderRegex = /\{\{([a-zA-Z0-9_:]+)\}\}/g;
    const matches = [...processedText.matchAll(placeholderRegex)];

    // 提取所有潜在的别名（去除 "agent:" 前缀）
    const allAliases = new Set(matches.map(match => match[1].replace(/^agent:/, '')));

    for (const alias of allAliases) {
        // 关键：使用 agentManager 来判断这是否是一个真正的Agent
        if (agentManager.isAgent(alias)) {
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
        }
    }

    // 在所有Agent都被递归展开后，处理剩余的非Agent占位符
    processedText = await replacePriorityVariables(processedText, context, role);
    processedText = await replaceOtherVariables(processedText, model, role, context);

    return processedText;
}

// 🌟 新增：动态折叠协议处理器
async function resolveDynamicFoldProtocol(foldObj, context, placeholderKey) {
    if (!foldObj || !foldObj.vcp_dynamic_fold || !Array.isArray(foldObj.fold_blocks) || foldObj.fold_blocks.length === 0) {
        return `[无效的动态折叠数据结构: ${placeholderKey}]`;
    }

    // 按阈值降序排序 (0.7, 0.5, 0.0)
    const blocks = [...foldObj.fold_blocks].sort((a, b) => b.threshold - a.threshold);
    // 最低阈值区块作为后备 (Fallback)
    const fallbackBlock = blocks[blocks.length - 1];

    try {
        const ragPlugin = context.pluginManager.messagePreprocessors?.get('RAGDiaryPlugin');
        if (!ragPlugin || typeof ragPlugin.getSingleEmbeddingCached !== 'function') {
            if (context.DEBUG_MODE) console.log(`[DynamicFold] RAGDiaryPlugin 不可用，返回基础内容 (${placeholderKey})`);
            return fallbackBlock.content;
        }

        // 提取最后一个 User 的消息作为核心比对内容
        const contextMessages = context.messages || [];
        let lastUserText = '';
        for (let i = contextMessages.length - 1; i >= 0; i--) {
            if (contextMessages[i].role === 'user') {
                const msgContent = contextMessages[i].content;
                lastUserText = typeof msgContent === 'string'
                    ? msgContent
                    : (Array.isArray(msgContent) ? (msgContent.find(p => p.type === 'text')?.text || '') : '');
                if (lastUserText) break;
            }
        }

        if (!lastUserText) {
            if (context.DEBUG_MODE) console.log(`[DynamicFold] 未找到 User 文本消息，返回基础内容 (${placeholderKey})`);
            return fallbackBlock.content;
        }

        // 获取当前会话上下文向量
        const userVector = await ragPlugin.getSingleEmbeddingCached(lastUserText);
        if (!userVector) {
            if (context.DEBUG_MODE) console.log(`[DynamicFold] 获取用户上下文向量失败，返回基础内容 (${placeholderKey})`);
            return fallbackBlock.content;
        }

        // 计算插件描述向量 (使用 KBM 的 SQLite 持久化缓存)
        const descText = foldObj.plugin_description || placeholderKey;
        let descVector = null;
        if (ragPlugin.vectorDBManager && typeof ragPlugin.vectorDBManager.getPluginDescriptionVector === 'function') {
            descVector = await ragPlugin.vectorDBManager.getPluginDescriptionVector(
                descText,
                // 必须绑定 this 到 ragPlugin 避免上下文丢失
                ragPlugin.getSingleEmbeddingCached.bind(ragPlugin)
            );
        } else {
            // 后备：没有 SQLite 时使用自带内存缓存
            descVector = await ragPlugin.getSingleEmbeddingCached(descText);
        }

        if (!descVector) {
            if (context.DEBUG_MODE) console.log(`[DynamicFold] 获取插件描述向量失败，返回基础内容 (${placeholderKey})`);
            return fallbackBlock.content;
        }

        // 计算余弦相似度
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        const len = Math.min(descVector.length, userVector.length);
        for (let i = 0; i < len; i++) {
            dotProduct += descVector[i] * userVector[i];
            normA += descVector[i] * descVector[i];
            normB += userVector[i] * userVector[i];
        }
        const sim = (normA === 0 || normB === 0) ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));

        if (context.DEBUG_MODE) {
            console.log(`[DynamicFold] ${placeholderKey} 上下文相似度: ${sim.toFixed(3)} (目标区块数: ${blocks.length})`);
        }

        // 匹配折叠阈值
        for (const block of blocks) {
            if (sim >= block.threshold) {
                if (context.DEBUG_MODE) console.log(`[DynamicFold] ${placeholderKey} 命中阈值 >= ${block.threshold}，展开相关内容。`);
                return block.content;
            }
        }

        return fallbackBlock.content;
    } catch (e) {
        console.error(`[DynamicFold] 处理动态折叠时发生异常 (${placeholderKey}):`, e.message);
        // 如果出错或者拿不到索引，安全回退到最精简内容
        return fallbackBlock.content;
    }
}

async function replaceOtherVariables(text, model, role, context) {
    const { pluginManager, cachedEmojiLists, detectors, superDetectors, DEBUG_MODE } = context;
    if (text == null) return '';
    let processedText = String(text);

    // SarModel 高级预设注入，对 system 角色或 VCPTavern 注入的 user 角色生效
    if (role === 'system' || (role === 'user' && processedText.startsWith('[系统'))) {
        // 查找所有独特的 SarPrompt 占位符，例如 {{SarPrompt1}}, {{SarPrompt2}}
        const sarPlaceholderRegex = /\{\{(SarPrompt\d+)\}\}/g;
        const matches = [...processedText.matchAll(sarPlaceholderRegex)];
        const uniquePlaceholders = [...new Set(matches.map(match => match[0]))];

        for (const placeholder of uniquePlaceholders) {
            // 从 {{SarPrompt4}} 中提取 SarPrompt4
            const promptKey = placeholder.substring(2, placeholder.length - 2);
            // 从 SarPrompt4 中提取数字 4
            const numberMatch = promptKey.match(/\d+$/);
            if (!numberMatch) continue;

            const index = numberMatch[0];
            const modelKey = `SarModel${index}`;

            const models = process.env[modelKey];
            let promptValue = process.env[promptKey];
            let replacementText = ''; // 默认替换为空字符串

            // 检查模型和提示是否存在
            if (models && promptValue) {
                const modelList = models.split(',').map(m => m.trim().toLowerCase());
                // 检查当前模型是否在列表中
                if (model && modelList.includes(model.toLowerCase())) {
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
