/**
 * vcpInfoHandler.js
 * 
 * 专用于处理 VCP (Virtual Cherry-Var Protocol) 工具调用信息的模块。
 * 负责格式化工具调用的结果，并以流式或非流式的方式将其推送给前端。
 */
const { Writable } = require('stream');

/**
 * 从插件的原始返回结果中智能地提取核心的可读文本信息。
 * @param {any} pluginResult - 插件 processToolCall 返回的原始结果。
 * @returns {string} - 提取出的核心纯文本信息。
 */
function extractReadableText(pluginResult) {
    if (!pluginResult) {
        return '插件执行完毕，但没有返回明确内容。';
    }
    if (typeof pluginResult === 'string') {
        return pluginResult;
    }
    if (typeof pluginResult === 'object') {
        // 1. 优先处理多模态 content 数组
        if (Array.isArray(pluginResult.content)) {
            const textParts = pluginResult.content
                .filter(part => part.type === 'text' && part.text)
                .map(part => part.text);
            if (textParts.length > 0) {
                return textParts.join('\n');
            }
        }

        // 2. 其次按优先级查找常见的纯文本结果字段
        if (typeof pluginResult.result === 'string') return pluginResult.result;
        if (typeof pluginResult.message === 'string') return pluginResult.message;
        
        // 3. 特殊处理 SciCalculator 的 original_plugin_output
        if (typeof pluginResult.original_plugin_output === 'string') {
            const match = pluginResult.original_plugin_output.match(/###计算结果：(.*?)###/);
            if (match && match[1]) {
                // 尝试解析内部可能存在的JSON/Dict，提取核心信息
                try {
                    // Python的dict表示法在JS中不是有效的JSON，需要转换
                    const correctedJsonStr = match[1].replace(/'/g, '"');
                    const parsed = JSON.parse(correctedJsonStr);
                    if (parsed && parsed.arg) {
                         // 如果解析成功并且有arg，说明内容复杂，返回原始匹配结果
                         return match[1];
                    }
                } catch (e) {
                    // 如果解析失败，说明它可能就是个纯粹的数字或字符串
                    return match[1];
                }
            }
            return pluginResult.original_plugin_output; // 如果正则不匹配，返回原始值
        }

        if (typeof pluginResult.content === 'string') return pluginResult.content;

        // 4. 最后的备用方案：返回一个单行的JSON字符串
        return JSON.stringify(pluginResult);
    }
    return `插件返回了未知类型的数据。`;
}


/**
 * 将 VCP 工具调用的信息格式化为简洁、结构化的纯文本块。
 * @param {string} toolName - 调用的工具名称。
 * @param {string} status - 调用状态 ('success' 或 'error')。
 * @param {any} pluginResult - 插件返回的原始结果。
 * @returns {string} - 格式化后的文本块。
 */
function formatVcpInfoToText(toolName, status, pluginResult) {
    const readableContent = extractReadableText(pluginResult);
    const statusIcon = status === 'success' ? '✅' : '❌';

    const textBlock = `[[VCP调用结果信息汇总:
- 工具名称: ${toolName}
- 执行状态: ${statusIcon} ${status.toUpperCase()}
- 返回内容: ${readableContent}
]]`;

    // 在前后添加换行符，使其在聊天流中作为独立的块出现
    return `\n${textBlock}\n`;
}

/**
 * 以流式（SSE）的方式，将格式化后的 VCP 信息作为 AI chunk 推送给客户端。
 * 同时，该函数也返回格式化后的文本，以便在非流式模式下收集。
 * @param {Writable | null} responseStream - Express 的 res 对象，如果为 null，则不发送流数据。
 * @param {string} modelName - 当前对话使用的模型名称。
 * @param {string} toolName - 调用的工具名称。
 * @param {string} status - 调用状态 ('success' 或 'error')。
 * @param {any} pluginResult - 插件返回的原始结果。
 * @returns {string} - 格式化后的 VCP 信息文本。
 */
function streamVcpInfo(responseStream, modelName, toolName, status, pluginResult) {
    const formattedText = formatVcpInfoToText(toolName, status, pluginResult);

    // If a responseStream is provided and it's writable, send the data as an SSE chunk.
    if (responseStream && !responseStream.writableEnded) {
        const ssePayload = {
            id: `chatcmpl-vcp-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [{
                index: 0,
                delta: { content: formattedText },
                finish_reason: null
            }]
        };

        try {
            responseStream.write(`data: ${JSON.stringify(ssePayload)}\n\n`);
        } catch (error) {
            // Silently ignore write errors when stream is closed (likely from abort)
            // Only log if it's not a simple "write after end" error
            if (!error.message.includes('write after end') && !error.message.includes('Cannot write after end')) {
                console.error('[vcpInfoHandler] 写入VCP流信息时出错:', error.message);
            }
        }
    }
    
    // Always return the formatted text so it can be collected in non-streaming mode.
    return formattedText;
}

module.exports = {
    streamVcpInfo,
};