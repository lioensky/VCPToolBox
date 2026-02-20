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
            for (const [placeholder, value] of staticPlaceholderValues.entries()) {
                const placeholderRegex = new RegExp(placeholder.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
                // The getter now returns the correct string value
                processedText = processedText.replace(placeholderRegex, value || `[${placeholder} 信息不可用]`);
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
