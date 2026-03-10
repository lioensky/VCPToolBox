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
        // 辅助函数：从数组中提取文本内容
        const extractFromContentArray = (arr) => {
            if (!Array.isArray(arr)) return null;
            const textParts = arr
                .filter(part => part && part.type === 'text' && typeof part.text === 'string')
                .map(part => part.text);
            return textParts.length > 0 ? textParts.join('\n') : null;
        };

        // 1. 尝试从各种可能的路径提取文本内容
        // 路径 A: 直接在 content 数组中
        let text = extractFromContentArray(pluginResult.content);
        if (text) return text;

        // 路径 B: 直接在 result 数组中
        text = extractFromContentArray(pluginResult.result);
        if (text) return text;

        // 路径 C: 在 result.content 数组中 (处理某些嵌套返回)
        if (pluginResult.result && typeof pluginResult.result === 'object') {
            text = extractFromContentArray(pluginResult.result.content);
            if (text) return text;
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

        // 4. 最后的备用方案：返回 JSON 字符串，但使用 replacer 过滤掉 Base64 数据
        try {
            return JSON.stringify(pluginResult, (key, value) => {
                if (typeof value === 'string' && (value.includes(';base64,') || value.startsWith('data:image/'))) {
                    return `[Base64 Data Ignored] (Length: ${value.length})`;
                }
                return value;
            });
        } catch (e) {
            return JSON.stringify(pluginResult).substring(0, 1000) + '... [JSON解析失败或过长已截断]';
        }
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

    const textBlock = `[[VCP调用结果信息汇总:\n- 工具名称: ${toolName}\n- 执行状态: ${statusIcon} ${status.toUpperCase()}\n- 返回内容: ${readableContent}\nVCP调用结果结束]]`;

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
 * @param {AbortController} abortController - 可选的中止控制器，用于检查请求是否已被中止。
 * @returns {string} - 格式化后的 VCP 信息文本。
 */
function streamVcpInfo(responseStream, modelName, toolName, status, pluginResult, abortController = null) {
    // 新增：检查中止信号，如果请求已被中止，则跳过写入
    if (abortController && abortController.signal && abortController.signal.aborted) {
        // 请求已中止，直接返回空字符串，不执行任何写入操作
        return '';
    }

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