// core/pipelineUtils.js
/**
 * @fileoverview VCP 方案 2 管道工具函数集
 * 包含占位符清理、模型文本检测、工具错误判定、SSE 解析等纯工具函数。
 */

'use strict';

const path = require('path');
const { StringDecoder } = require('string_decoder');

const VCP_TOOL_USE_FORBIDDEN_PLACEHOLDER = '[[VCPToolUse=Forbidden]]';

/**
 * 消费并移除消息开头的 [[VCPToolUse=Forbidden]] 占位符
 * @param {Array} messages - 消息列表
 * @returns {boolean} 是否发现该占位符
 */
function consumeVcpToolUseForbiddenPlaceholder(messages) {
  if (!Array.isArray(messages)) return false;

  let found = false;
  for (const msg of messages) {
    if (!msg || msg.role !== 'system') break;

    if (typeof msg.content === 'string') {
      if (msg.content.includes(VCP_TOOL_USE_FORBIDDEN_PLACEHOLDER)) {
        found = true;
        msg.content = msg.content.split(VCP_TOOL_USE_FORBIDDEN_PLACEHOLDER).join('');
      }
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.includes(VCP_TOOL_USE_FORBIDDEN_PLACEHOLDER)) {
          found = true;
          part.text = part.text.split(VCP_TOOL_USE_FORBIDDEN_PLACEHOLDER).join('');
        }
      }
    }
  }

  return found;
}

/**
 * 检测当前真实后端模型是否命中纯文本模型 Tag 列表（不区分大小写）。
 * @param {string} modelName - 真实后端模型名
 * @param {string[]} tagList - tag 数组
 * @returns {boolean}
 */
function isTextOnlyModelByTag(modelName, tagList) {
  if (!modelName || !Array.isArray(tagList) || tagList.length === 0) return false;
  const lowerName = String(modelName).toLowerCase();
  for (const tag of tagList) {
    if (!tag) continue;
    if (lowerName.includes(String(tag).toLowerCase())) return true;
  }
  return false;
}

/**
 * 检测一条消息（或其 content 数组）中是否包含 base64 多模态部分。
 * @param {Array} messages - 消息数组
 * @returns {boolean}
 */
function messagesContainBase64Media(messages) {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'system')) continue;
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (
        part &&
        part.type === 'image_url' &&
        part.image_url &&
        typeof part.image_url.url === 'string' &&
        /^data:(image|audio|video)\/[^;]+;base64,/.test(part.image_url.url)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 复制预处理器挂载在消息数组上的非枚举元数据（例如 OneRing 的 __oneRingMeta）。
 * @param {Array} source
 * @param {Array} target
 * @returns {Array}
 */
function copyArrayMetadata(source, target) {
  if (!Array.isArray(source) || !Array.isArray(target)) return target;

  for (const key of Object.getOwnPropertyNames(source)) {
    if (/^(?:length|\d+)$/.test(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    try {
      Object.defineProperty(target, key, descriptor);
    } catch (e) {
      // 容错处理
    }
  }

  return target;
}

/**
 * 检测工具返回结果是否为错误
 * @param {any} result - 工具返回的结果
 * @returns {boolean}
 */
function isToolResultError(result) {
  if (result === undefined || result === null) {
    return false;
  }

  if (typeof result === 'object') {
    if (
      result.success === true ||
      result.status === 'success' ||
      result.status === 'ok' ||
      result.ok === true
    ) {
      return false;
    }

    if (
      result.error === true ||
      result.success === false ||
      result.status === 'error' ||
      result.status === 'failed' ||
      result.status === 'failure' ||
      result.ok === false
    ) {
      return true;
    }

    const codeValue = result.code ?? result.statusCode ?? result.httpStatus;
    const numericCode = Number(codeValue);
    if (Number.isFinite(numericCode) && numericCode >= 400 && numericCode < 600) {
      return true;
    }

    return false;
  }

  if (typeof result === 'string') {
    const lowerResult = result.toLowerCase();
    const errorPrefixes = [
      '[error]', '[错误]', '[失败]', 'error:', '错误：', '失败：'
    ];
    for (const prefix of errorPrefixes) {
      if (lowerResult.startsWith(prefix)) {
        return true;
      }
    }

    if (lowerResult.includes('error:') || lowerResult.includes('failed:')) {
      return true;
    }
  }

  return false;
}

/**
 * 格式化工具结果为字符串
 * @param {any} result - 工具返回的结果
 * @returns {string}
 */
function formatToolResult(result) {
  if (result === undefined || result === null) {
    return '(无返回内容)';
  }
  if (typeof result === 'object') {
    return JSON.stringify(result, null, 2);
  }
  return String(result);
}

/**
 * 获取验证码（动态加载 captchaDecoder，防止缺失报错）
 * @param {boolean} debugMode
 * @returns {Promise<string|null>}
 */
async function getRealAuthCode(debugMode = false) {
  try {
    const { getAuthCode } = require('../modules/captchaDecoder');
    const authCodePath = path.join(__dirname, '..', 'Plugin', 'UserAuth', 'code.bin');
    return await getAuthCode(authCodePath);
  } catch (error) {
    if (debugMode) {
      console.error('[VCPToolCode] Failed to read or decrypt auth code:', error);
    }
    return null;
  }
}

/**
 * 剥离 Markdown 代码块
 * @param {string} text
 * @returns {string}
 */
function stripMarkdownCodeFencesForRagRefresh(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/```[\s\S]*?```/g, '');
}

/**
 * 安全解析 RAG metadata JSON
 * @param {string} rawMetadata
 * @param {boolean} debugMode
 * @returns {object|null}
 */
function safeParseRagBlockMetadata(rawMetadata, debugMode = false) {
  if (typeof rawMetadata !== 'string') return null;
  const trimmed = rawMetadata.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    if (debugMode) console.warn(`[VCP Refresh] 跳过非 JSON metadata: ${trimmed.slice(0, 80)}`);
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch (e) {
    if (debugMode) console.warn(`[VCP Refresh] metadata JSON 解析失败，跳过: ${e.message}`);
    return null;
  }
}

/**
 * 刷新消息列表中的 RAG 区块
 * @param {Array} messages
 * @param {string} newContext
 * @param {object} pluginManager
 * @param {boolean} debugMode
 * @returns {Promise<Array>}
 */
async function _refreshRagBlocksIfNeeded(messages, newContext, pluginManager, debugMode = false) {
  const ragPlugin = pluginManager?.messagePreprocessors?.get?.('RAGDiaryPlugin');
  if (!ragPlugin || typeof ragPlugin.refreshRagBlock !== 'function') {
    if (debugMode) {
      console.log('[VCP Refresh] RAGDiaryPlugin 未找到或版本不兼容 (缺少 refreshRagBlock)，跳过刷新。');
    }
    return messages;
  }

  const newMessages = JSON.parse(JSON.stringify(messages));
  let hasRefreshed = false;
  const ragBlockRegex = /<!-- VCP_RAG_BLOCK_START\s+(\{[\s\S]*?\})\s+-->([\s\S]*?)<!-- VCP_RAG_BLOCK_END -->/g;

  for (let i = 0; i < newMessages.length; i++) {
    if (newMessages[i]?.role === 'system' && typeof newMessages[i].content === 'string') {
      let messageContent = stripMarkdownCodeFencesForRagRefresh(newMessages[i].content);
      if (!messageContent.includes('VCP_RAG_BLOCK_START')) {
        continue;
      }

      const matches = [...messageContent.matchAll(ragBlockRegex)];
      if (matches.length > 0) {
        if (debugMode) console.log(`[VCP Refresh] 消息[${i}]中发现 ${matches.length} 个 RAG 区块，准备刷新...`);

        for (const match of matches) {
          const fullMatchString = match[0];
          const metadataJson = match[1];

          try {
            const metadata = safeParseRagBlockMetadata(metadataJson, debugMode);
            if (!metadata) continue;

            let originalUserQuery = '';
            for (let j = i - 1; j >= 0; j--) {
              const prevMsg = newMessages[j];
              if (prevMsg?.role === 'user' && typeof prevMsg.content === 'string' &&
                !prevMsg.content.startsWith('<!-- VCP_TOOL_PAYLOAD -->') &&
                !prevMsg.content.startsWith('[系统提示:]') &&
                !prevMsg.content.startsWith('[系统邀请指令:]')
              ) {
                originalUserQuery = prevMsg.content;
                break;
              }
            }

            const newBlock = await ragPlugin.refreshRagBlock(metadata, newContext, originalUserQuery);
            messageContent = messageContent.replace(fullMatchString, () => newBlock);
            hasRefreshed = true;
          } catch (e) {
            console.error('[VCP Refresh] 刷新 RAG 区块失败:', e.message);
          }
        }
        newMessages[i].content = messageContent;
      }
    }
  }

  if (hasRefreshed && debugMode) {
    console.log('[VCP Refresh] ✅ 对话历史中的 RAG 记忆区块已根据新上下文成功刷新。');
  }

  return newMessages;
}

/**
 * 异步解析 SSE 数据流，产出标准化事件
 * @param {AsyncIterable<Buffer|string>} bodyStream
 * @param {AbortSignal} [signal]
 * @returns {AsyncGenerator<{ isDone: boolean, data?: object, raw: string }>}
 */
async function* parseSseStream(bodyStream, signal) {
  if (!bodyStream) return;

  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let dataLines = [];

  const onAbort = () => {
    if (bodyStream && typeof bodyStream.destroy === 'function' && !bodyStream.destroyed) {
      bodyStream.destroy();
    }
  };

  if (signal) {
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  function flushEvent() {
    if (dataLines.length === 0) return null;
    const raw = dataLines.join('\n');
    dataLines = [];
    const trimmed = raw.trim();
    if (trimmed === '[DONE]') {
      return { isDone: true, raw };
    }
    try {
      const data = JSON.parse(raw);
      return { isDone: false, data, raw };
    } catch {
      return null;
    }
  }

  function* processLine(line) {
    if (line.startsWith(':')) {
      return;
    }

    if (line.trim() === '') {
      const event = flushEvent();
      if (event) {
        yield event;
      }
      return;
    }

    const trimmed = line.trim();
    if (trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]') {
      const prevEvent = flushEvent();
      if (prevEvent) {
        yield prevEvent;
        if (prevEvent.isDone) return;
      }
      yield { isDone: true, raw: trimmed };
      return;
    }

    if (line.startsWith('data:')) {
      let value = line.slice(5);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
      if (value.trim() === '[DONE]') {
        const prevEvent = flushEvent();
        if (prevEvent) {
          yield prevEvent;
          if (prevEvent.isDone) return;
        }
        yield { isDone: true, raw: line };
        return;
      }
      dataLines.push(value);
    }
  }

  try {
    for await (const chunk of bodyStream) {
      if (signal?.aborted) break;

      const chunkStr = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      buffer += chunkStr;

      let trailingCR = false;
      if (buffer.endsWith('\r')) {
        buffer = buffer.slice(0, -1);
        trailingCR = true;
      }

      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = (lines.pop() || '') + (trailingCR ? '\r' : '');

      for (const line of lines) {
        for (const item of processLine(line)) {
          yield item;
          if (item.isDone) return;
        }
      }
    }

    buffer += decoder.end();
    if (buffer.length > 0) {
      const lines = buffer.split(/\r\n|\r|\n/);
      for (const line of lines) {
        for (const item of processLine(line)) {
          yield item;
          if (item.isDone) return;
        }
      }
    }

    const finalEvent = flushEvent();
    if (finalEvent) {
      yield finalEvent;
    }
  } catch (err) {
    if (signal?.aborted || err.name === 'AbortError') {
      return;
    }
    throw err;
  } finally {
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

module.exports = {
  VCP_TOOL_USE_FORBIDDEN_PLACEHOLDER,
  consumeVcpToolUseForbiddenPlaceholder,
  isTextOnlyModelByTag,
  messagesContainBase64Media,
  copyArrayMetadata,
  isToolResultError,
  formatToolResult,
  getRealAuthCode,
  stripMarkdownCodeFencesForRagRefresh,
  safeParseRagBlockMetadata,
  _refreshRagBlocksIfNeeded,
  parseSseStream
};
