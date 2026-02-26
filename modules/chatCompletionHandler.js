// modules/chatCompletionHandler.js
const messageProcessor = require('./messageProcessor.js');
const vcpInfoHandler = require('../vcpInfoHandler.js');
const contextManager = require('./contextManager.js');
const roleDivider = require('./roleDivider.js');
const fs = require('fs').promises;
const path = require('path');
const { getAuthCode } = require('./captchaDecoder');
const ToolCallParser = require('./vcpLoop/toolCallParser');
const ToolExecutor = require('./vcpLoop/toolExecutor');
const StreamHandler = require('./handlers/streamHandler');
const NonStreamHandler = require('./handlers/nonStreamHandler');

/**
 * 检测工具返回结果是否为错误
 * @param {any} result - 工具返回的结果
 * @returns {boolean} - 是否为错误结果
 */
function isToolResultError(result) {
  if (result === undefined || result === null) {
    return false; // 空结果不视为错误
  }

  // 1. 对象形式的错误检测
  if (typeof result === 'object') {
    // 检查常见的错误标识字段
    if (result.error === true ||
      result.success === false ||
      result.status === 'error' ||
      result.status === 'failed' ||
      result.code?.toString().startsWith('4') || // 4xx 错误码
      result.code?.toString().startsWith('5')) { // 5xx 错误码
      return true;
    }

    // 对象转字符串后检查
    try {
      const jsonStr = JSON.stringify(result).toLowerCase();
      return jsonStr.includes('"error"') && !jsonStr.includes('"error":false');
    } catch (e) {
      return false;
    }
  }

  // 2. 字符串形式的错误检测（模糊匹配）
  if (typeof result === 'string') {
    const lowerResult = result.toLowerCase();

    // 检查是否以错误前缀开头（更可靠的判断）
    const errorPrefixes = [
      '[error]', '[错误]', '[失败]', 'error:', '错误：', '失败：'
    ];
    for (const prefix of errorPrefixes) {
      if (lowerResult.startsWith(prefix)) {
        return true;
      }
    }

    // 模糊匹配（需要更谨慎）
    // 只有在明确包含"错误"或"失败"这类强指示词时才认为是错误
    if (result.includes('错误') || result.includes('失败') ||
      lowerResult.includes('error:') || lowerResult.includes('failed:')) {
      return true;
    }
  }

  return false;
}

/**
 * 格式化工具结果为字符串
 * @param {any} result - 工具返回的结果
 * @returns {string} - 格式化后的字符串
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

async function getRealAuthCode(debugMode = false) {
  try {
    const authCodePath = path.join(__dirname, '..', 'Plugin', 'UserAuth', 'code.bin');
    // 使用正确的 getAuthCode 函数，它会自行处理文件读取和解码
    return await getAuthCode(authCodePath);
  } catch (error) {
    if (debugMode) {
      console.error('[VCPToolCode] Failed to read or decrypt auth code:', error);
    }
    return null; // Return null if code cannot be obtained
  }
}

// A helper function to handle fetch with retries for specific status codes
// connectionTimeout: 连接超时安全网，防止上游 API 静默挂起导致永久等待（仅覆盖到收到响应头为止）
async function fetchWithRetry(
  url,
  options,
  { retries = 3, delay = 1000, debugMode = false, onRetry = null, connectionTimeout = 120000 } = {},
) {
  const { default: fetch } = await import('node-fetch');
  for (let i = 0; i < retries; i++) {
    // 为每次尝试创建独立的中止控制器，用于超时保护
    const attemptController = new AbortController();
    let didTimeout = false;
    const externalSignal = options.signal;

    // 将外部中止信号转发给本次尝试的控制器
    let removeExternalListener = null;
    if (externalSignal) {
      if (externalSignal.aborted) {
        throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
      }
      const forwardAbort = () => attemptController.abort();
      externalSignal.addEventListener('abort', forwardAbort, { once: true });
      removeExternalListener = () => externalSignal.removeEventListener('abort', forwardAbort);
    }

    // 设置连接超时
    const timeoutId = connectionTimeout > 0
      ? setTimeout(() => { didTimeout = true; attemptController.abort(); }, connectionTimeout)
      : null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (removeExternalListener) removeExternalListener();
    };

    try {
      const response = await fetch(url, {
        ...options,
        signal: attemptController.signal,
      });
      cleanup();

      if (response.status === 500 || response.status === 503 || response.status === 429) {
        const currentDelay = delay * (i + 1);
        if (debugMode) {
          console.warn(
            `[Fetch Retry] Received status ${response.status}. Retrying in ${currentDelay}ms... (${i + 1}/${retries})`,
          );
        }
        if (onRetry) {
          await onRetry(i + 1, { status: response.status, message: response.statusText });
        }
        await new Promise(resolve => setTimeout(resolve, currentDelay));
        continue;
      }
      return response;
    } catch (error) {
      cleanup();

      // 区分超时中止和外部中止
      if (error.name === 'AbortError') {
        if (didTimeout) {
          // 超时中止 → 视为可重试的网络错误
          const msg = `Connection timed out after ${connectionTimeout / 1000}s`;
          if (i === retries - 1) {
            console.error(`[Fetch Retry] ${msg}. All retries exhausted.`);
            throw new Error(msg);
          }
          if (debugMode) console.warn(`[Fetch Retry] ${msg}. Retrying... (${i + 1}/${retries})`);
          if (onRetry) {
            await onRetry(i + 1, { status: 'TIMEOUT', message: msg });
          }
          await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
          continue;
        }
        // 外部中止（用户取消）→ 不重试
        if (debugMode) console.log('[Fetch Retry] Request was aborted. No retries will be attempted.');
        throw error;
      }

      if (i === retries - 1) {
        console.error(`[Fetch Retry] All retries failed. Last error: ${error.message}`);
        throw error;
      }
      if (debugMode) {
        console.warn(
          `[Fetch Retry] Fetch failed with error: ${error.message}. Retrying in ${delay}ms... (${i + 1}/${retries})`,
        );
      }
      if (onRetry) {
        await onRetry(i + 1, { status: 'NETWORK_ERROR', message: error.message });
      }
      await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
    }
  }
  throw new Error('Fetch failed after all retries.');
}
// 辅助函数：根据新上下文刷新对话历史中的RAG区块
async function _refreshRagBlocksIfNeeded(messages, newContext, pluginManager, debugMode = false) {
  const ragPlugin = pluginManager.messagePreprocessors?.get('RAGDiaryPlugin');
  // 检查插件是否存在且是否实现了refreshRagBlock方法
  if (!ragPlugin || typeof ragPlugin.refreshRagBlock !== 'function') {
    if (debugMode) {
      console.log('[VCP Refresh] RAGDiaryPlugin 未找到或版本不兼容 (缺少 refreshRagBlock)，跳过刷新。');
    }
    return messages;
  }

  // 创建消息数组的深拷贝以安全地进行修改
  const newMessages = JSON.parse(JSON.stringify(messages));
  let hasRefreshed = false;

  // 🟢 改进点1：使用更健壮的正则 [\s\S]*? 匹配跨行内容，并允许标签周围有空格
  const ragBlockRegex = /<!-- VCP_RAG_BLOCK_START ([\s\S]*?) -->([\s\S]*?)<!-- VCP_RAG_BLOCK_END -->/g;

  for (let i = 0; i < newMessages.length; i++) {
    // 只处理 assistant 和 system 角色中的字符串内容
    // 🟢 改进点2：有些场景下 RAG 可能会被注入到 user 消息中，建议也检查 user
    if (['assistant', 'system', 'user'].includes(newMessages[i].role) && typeof newMessages[i].content === 'string') {
      let messageContent = newMessages[i].content;

      // 快速检查是否存在标记，避免无效正则匹配
      if (!messageContent.includes('VCP_RAG_BLOCK_START')) {
        continue;
      }

      // 使用 replace 的回调函数模式来处理异步逻辑通常比较麻烦
      // 所以我们先收集所有匹配项，然后串行处理替换
      const matches = [...messageContent.matchAll(ragBlockRegex)];

      if (matches.length > 0) {
        if (debugMode) console.log(`[VCP Refresh] 消息[${i}]中发现 ${matches.length} 个 RAG 区块，准备刷新...`);

        // 我们从后往前替换，这样替换操作不会影响前面匹配项的索引位置（虽然 replace(str) 不依赖索引，但这是一个好习惯）
        // 这里为了简单，我们直接构建一个新的 content 字符串或使用 split/join 策略

        for (const match of matches) {
          const fullMatchString = match[0]; // 完整的 ... const metadataJson = match[1];    // 第一个捕获组：元数据 JSON
          const metadataJson = match[1];

          try {
            // 🟢 改进点3：解析元数据时如果不严谨可能会报错，增加容错
            const metadata = JSON.parse(metadataJson);

            if (debugMode) {
              console.log(`[VCP Refresh] 正在刷新区块 (${metadata.dbName})...`);
            }

            // V4.0: Find the last *true* user message to use as the original query
            let originalUserQuery = '';
            // Search backwards from the message *before* the one containing the RAG block
            for (let j = i - 1; j >= 0; j--) {
              const prevMsg = newMessages[j];
              if (prevMsg.role === 'user' && typeof prevMsg.content === 'string' &&
                !prevMsg.content.startsWith('<!-- VCP_TOOL_PAYLOAD -->') &&
                !prevMsg.content.startsWith('[系统提示:]') &&
                !prevMsg.content.startsWith('[系统邀请指令:]')
              ) {
                originalUserQuery = prevMsg.content;
                if (debugMode) console.log(`[VCP Refresh] Found original user query for refresh at index ${j}.`);
                break; // Found it, stop searching
              }
            }
            if (!originalUserQuery && debugMode) {
              console.warn(`[VCP Refresh] Could not find a true user query for the RAG block at index ${i}. Refresh may be inaccurate.`);
            }

            // 调用 RAG 插件的刷新接口, now with originalUserQuery
            const newBlock = await ragPlugin.refreshRagBlock(metadata, newContext, originalUserQuery);

            // 🟢 改进点4：关键修复！使用回调函数进行替换，防止 newBlock 中的 "$" 符号被解析为正则特殊字符
            // 这是一个极其常见的 Bug，导致包含 $ 的内容（如公式、代码）替换失败或乱码
            messageContent = messageContent.replace(fullMatchString, () => newBlock);

            hasRefreshed = true;

          } catch (e) {
            console.error("[VCP Refresh] 刷新 RAG 区块失败:", e.message);
            if (debugMode) console.error(e);
            // 出错时保持原样，不中断流程
          }
        }
        newMessages[i].content = messageContent;
      }
    }
  }

  if (hasRefreshed && debugMode) {
    console.log("[VCP Refresh] ✅ 对话历史中的 RAG 记忆区块已根据新上下文成功刷新。");
  }

  return newMessages;
}

class ChatCompletionHandler {
  constructor(config) {
    this.config = config;
    this.toolExecutor = new ToolExecutor({
      pluginManager: config.pluginManager,
      webSocketServer: config.webSocketServer,
      debugMode: config.DEBUG_MODE,
      vcpToolCode: config.VCPToolCode,
      getRealAuthCode: getRealAuthCode
    });
  }

  async handle(req, res, forceShowVCP = false) {
    const {
      apiUrl,
      apiKey,
      modelRedirectHandler,
      pluginManager,
      activeRequests,
      writeDebugLog,
      handleDiaryFromAIResponse,
      webSocketServer,
      DEBUG_MODE,
      SHOW_VCP_OUTPUT,
      VCPToolCode,
      maxVCPLoopStream,
      maxVCPLoopNonStream,
      apiRetries,
      apiRetryDelay,
      RAGMemoRefresh,
      enableRoleDivider, // 新增
      enableRoleDividerInLoop, // 新增
      roleDividerIgnoreList, // 新增
      roleDividerSwitches, // 新增
      roleDividerScanSwitches, // 新增
      roleDividerRemoveDisabledTags, // 新增
      chinaModel1, // 新增
      chinaModel1Cot, // 新增
    } = this.config;

    const shouldShowVCP = SHOW_VCP_OUTPUT || forceShowVCP;

    let clientIp = req.ip;
    if (clientIp && clientIp.substr(0, 7) === '::ffff:') {
      clientIp = clientIp.substr(7);
    }

    const id = req.body.requestId || req.body.messageId;
    const abortController = new AbortController();

    if (id) {
      activeRequests.set(id, {
        req,
        res,
        abortController,
        timestamp: Date.now(),
        aborted: false // 修复 Bug #4: 添加中止标志
      });
    }

    let originalBody = req.body;
    const isOriginalRequestStreaming = originalBody.stream === true;

    // --- 上下文控制 (Context Control) ---
    // 1. 拦截 contextTokenLimit 参数
    const contextTokenLimit = originalBody.contextTokenLimit;
    if (contextTokenLimit !== undefined) {
      if (DEBUG_MODE) console.log(`[ContextControl] 检测到 contextTokenLimit: ${contextTokenLimit}`);
      // 2. 从发送给后端的 body 中移除该参数
      delete originalBody.contextTokenLimit;

      // 3. 执行上下文修剪
      if (originalBody.messages && Array.isArray(originalBody.messages)) {
        const originalCount = originalBody.messages.length;
        originalBody.messages = contextManager.pruneMessages(
          originalBody.messages,
          contextTokenLimit,
          DEBUG_MODE
        );
        if (DEBUG_MODE && originalBody.messages.length < originalCount) {
          console.log(`[ContextControl] 上下文已修剪: ${originalCount} -> ${originalBody.messages.length} 条消息`);
        }
      }
    }

    try {
      if (originalBody.model) {
        const originalModel = originalBody.model;
        const redirectedModel = modelRedirectHandler.redirectModelForBackend(originalModel);
        if (redirectedModel !== originalModel) {
          originalBody = { ...originalBody, model: redirectedModel };
          console.log(`[ModelRedirect] 客户端请求模型 '${originalModel}' 已重定向为后端模型 '${redirectedModel}'`);
        }

        // --- 国产A类模型推理功能控制 (ChinaModel Thinking Control) ---
        if (chinaModel1 && Array.isArray(chinaModel1) && chinaModel1.length > 0) {
          const modelNameLower = originalBody.model.toLowerCase();
          const isChinaModel = chinaModel1.some(m => modelNameLower.includes(m.toLowerCase()));
          if (isChinaModel) {
            if (chinaModel1Cot) {
              originalBody.thinking = { type: "enabled" };
            } else {
              delete originalBody.thinking;
            }

            if (DEBUG_MODE) {
              console.log(`[ChinaModel] 模型 '${originalBody.model}' 匹配成功。思维链状态: ${chinaModel1Cot ? '开启 (enabled)' : '关闭 (已移除字段)'}`);
            }
          }
        }
      }

      await writeDebugLog('LogInput', originalBody);

      // --- 角色分割处理 (Role Divider) - 初始阶段 ---
      // 移动到最前端，确保拆分出的楼层能享受后续所有解析功能
      if (enableRoleDivider) {
        if (DEBUG_MODE) console.log('[Server] Applying Role Divider processing (Initial Stage)...');
        // skipCount: 1 to exclude the initial SystemPrompt from splitting
        originalBody.messages = roleDivider.process(originalBody.messages, {
          ignoreList: roleDividerIgnoreList,
          switches: roleDividerSwitches,
          scanSwitches: roleDividerScanSwitches,
          removeDisabledTags: roleDividerRemoveDisabledTags,
          skipCount: 1
        });
        if (DEBUG_MODE) await writeDebugLog('LogAfterInitialRoleDivider', originalBody.messages);
      }

      let shouldProcessMedia = false;
      let shouldProcessMediaPlus = false;
      if (originalBody.messages && Array.isArray(originalBody.messages)) {
        for (const msg of originalBody.messages) {
          let foundPlaceholderInMsg = false;
          let foundPlusPlaceholderInMsg = false;
          if (msg.role === 'user' || msg.role === 'system') {
            if (typeof msg.content === 'string') {
              if (msg.content.includes('{{TransBase64+}}')) {
                foundPlusPlaceholderInMsg = true;
                msg.content = msg.content.replace(/\{\{TransBase64\+\}\}/g, '');
              } else if (msg.content.includes('{{TransBase64}}')) {
                foundPlaceholderInMsg = true;
                msg.content = msg.content.replace(/\{\{TransBase64\}\}/g, '');
              }
            } else if (Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part.type === 'text' && typeof part.text === 'string') {
                  if (part.text.includes('{{TransBase64+}}')) {
                    foundPlusPlaceholderInMsg = true;
                    part.text = part.text.replace(/\{\{TransBase64\+\}\}/g, '');
                  } else if (part.text.includes('{{TransBase64}}')) {
                    foundPlaceholderInMsg = true;
                    part.text = part.text.replace(/\{\{TransBase64\}\}/g, '');
                  }
                }
              }
            }
          }
          if (foundPlaceholderInMsg || foundPlusPlaceholderInMsg) {
            shouldProcessMedia = true;
            if (foundPlusPlaceholderInMsg) {
              shouldProcessMediaPlus = true;
            }
            if (DEBUG_MODE) console.log(`[Server] Media translation enabled by ${foundPlusPlaceholderInMsg ? '{{TransBase64+}}' : '{{TransBase64}}'} placeholder.`);
            // Removed break to ensure all + modifiers are processed if present in multiple messages
          }
        }
      }

      // --- VCPTavern 优先处理 ---
      // 在任何变量替换之前，首先运行 VCPTavern 来注入预设内容
      let tavernProcessedMessages = originalBody.messages;
      if (pluginManager.messagePreprocessors.has('VCPTavern')) {
        if (DEBUG_MODE) console.log(`[Server] Calling priority message preprocessor: VCPTavern`);
        try {
          tavernProcessedMessages = await pluginManager.executeMessagePreprocessor('VCPTavern', originalBody.messages);
        } catch (pluginError) {
          console.error(`[Server] Error in priority preprocessor VCPTavern:`, pluginError);
        }
      }

      // --- 统一处理所有变量替换 ---
      // 创建一个包含所有所需依赖的统一上下文
      const processingContext = {
        pluginManager,
        cachedEmojiLists: this.config.cachedEmojiLists,
        detectors: this.config.detectors,
        superDetectors: this.config.superDetectors,
        DEBUG_MODE,
        messages: tavernProcessedMessages // 将近期消息列表传递下去，用于支持上下文动态折叠 (Contextual Folding)
      };

      // 调用一个主函数来递归处理所有变量，确保Agent优先展开
      let processedMessages = await Promise.all(
        tavernProcessedMessages.map(async msg => {
          const newMessage = JSON.parse(JSON.stringify(msg));
          if (newMessage.content && typeof newMessage.content === 'string') {
            // messageProcessor.js 中的 replaceAgentVariables 将被改造为处理所有变量的主函数
            newMessage.content = await messageProcessor.replaceAgentVariables(
              newMessage.content,
              originalBody.model,
              msg.role,
              processingContext,
            );
          } else if (Array.isArray(newMessage.content)) {
            newMessage.content = await Promise.all(
              newMessage.content.map(async part => {
                if (part.type === 'text' && typeof part.text === 'string') {
                  const newPart = JSON.parse(JSON.stringify(part));
                  newPart.text = await messageProcessor.replaceAgentVariables(
                    newPart.text,
                    originalBody.model,
                    msg.role,
                    processingContext,
                  );
                  return newPart;
                }
                return part;
              }),
            );
          }
          return newMessage;
        }),
      );
      if (DEBUG_MODE) await writeDebugLog('LogAfterVariableProcessing', processedMessages);

      // --- 媒体处理器 ---
      if (shouldProcessMedia) {
        if (shouldProcessMediaPlus) {
          for (const msg of processedMessages) {
            if (msg.role === 'user' && Array.isArray(msg.content)) {
              const mediaParts = msg.content.filter(part => part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string' && /^data:(image|audio|video)\/[^;]+;base64,/.test(part.image_url.url));
              if (mediaParts.length > 0) {
                msg.__vcp_media_backup__ = JSON.parse(JSON.stringify(mediaParts));
              }
            }
          }
        }

        const processorName = pluginManager.messagePreprocessors.has('MultiModalProcessor')
          ? 'MultiModalProcessor'
          : 'ImageProcessor';
        if (pluginManager.messagePreprocessors.has(processorName)) {
          if (DEBUG_MODE) console.log(`[Server] Calling message preprocessor: ${processorName}`);
          try {
            processedMessages = await pluginManager.executeMessagePreprocessor(processorName, processedMessages);
          } catch (pluginError) {
            console.error(`[Server] Error in preprocessor ${processorName}:`, pluginError);
          }
        }
      }

      // --- 其他通用消息预处理器 ---
      for (const name of pluginManager.messagePreprocessors.keys()) {
        // 跳过已经特殊处理的插件
        if (name === 'ImageProcessor' || name === 'MultiModalProcessor' || name === 'VCPTavern') continue;

        if (DEBUG_MODE) console.log(`[Server] Calling message preprocessor: ${name}`);
        try {
          processedMessages = await pluginManager.executeMessagePreprocessor(name, processedMessages);
        } catch (pluginError) {
          console.error(`[Server] Error in preprocessor ${name}:`, pluginError);
        }
      }
      if (DEBUG_MODE) await writeDebugLog('LogAfterPreprocessors', processedMessages);

      // --- TransBase64+ Cleanup & Restore ---
      if (shouldProcessMediaPlus) {
        for (const msg of processedMessages) {
          if (msg.role === 'user') {
            // Remove the info block
            if (typeof msg.content === 'string') {
              msg.content = msg.content.replace(/<VCP_MULTIMODAL_INFO>[\s\S]*?<\/VCP_MULTIMODAL_INFO>/g, '');
            } else if (Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part.type === 'text' && typeof part.text === 'string') {
                  part.text = part.text.replace(/<VCP_MULTIMODAL_INFO>[\s\S]*?<\/VCP_MULTIMODAL_INFO>/g, '');
                }
              }
            }

            // Restore the backup
            if (msg.__vcp_media_backup__) {
              if (typeof msg.content === 'string') {
                msg.content = [
                  { type: 'text', text: msg.content },
                  ...msg.__vcp_media_backup__
                ];
              } else if (Array.isArray(msg.content)) {
                msg.content = [
                  ...msg.content,
                  ...msg.__vcp_media_backup__
                ];
              }
              delete msg.__vcp_media_backup__;
            }
          }
        }
        if (DEBUG_MODE) console.log(`[Server] TransBase64+ cleanup and media restore complete.`);
      }

      // 经过改造后，processedMessages 已经是最终版本，无需再调用 replaceOtherVariables

      originalBody.messages = processedMessages;
      await writeDebugLog('LogOutputAfterProcessing', originalBody);

      const willStreamResponse = isOriginalRequestStreaming;

      let firstAiAPIResponse = await fetchWithRetry(
        `${apiUrl}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...(req.headers['user-agent'] && { 'User-Agent': req.headers['user-agent'] }),
            Accept: willStreamResponse ? 'text/event-stream' : req.headers['accept'] || 'application/json',
          },
          body: JSON.stringify({ ...originalBody, stream: willStreamResponse }),
          signal: abortController.signal,
        },
        {
          retries: apiRetries,
          delay: apiRetryDelay,
          debugMode: DEBUG_MODE,
          onRetry: async (attempt, errorInfo) => {
            if (!res.headersSent && isOriginalRequestStreaming) {
              if (DEBUG_MODE)
                console.log(`[VCP Retry] First retry attempt (#${attempt}). Sending 200 OK to client to establish stream.`);
              res.status(200);
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
            }
          },
        },
      );

      const isUpstreamStreaming =
        willStreamResponse && firstAiAPIResponse.headers.get('content-type')?.includes('text/event-stream');

      if (!res.headersSent) {
        const upstreamStatus = firstAiAPIResponse.status;

        if (isOriginalRequestStreaming && upstreamStatus !== 200) {
          // If streaming was requested, but upstream returned a non-200 status (e.g., 400, 401, 502, 504),
          // we must return 200 OK and stream the error as an SSE chunk to prevent client listener termination.
          res.status(200);
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          // Read the error body from the upstream response
          const errorBodyText = await firstAiAPIResponse.text();

          // Log the error
          console.error(`[Upstream Error Stream Proxy] Upstream API returned status ${upstreamStatus}. Streaming error to client: ${errorBodyText}`);

          // Construct the error message for the client
          const errorContent = `[UPSTREAM_ERROR] 上游API返回状态码 ${upstreamStatus}，错误信息: ${errorBodyText}`;

          // Send an error chunk
          const errorPayload = {
            id: `chatcmpl-VCP-upstream-error-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: originalBody.model || 'unknown',
            choices: [
              {
                index: 0,
                delta: {
                  content: errorContent,
                },
                finish_reason: 'stop',
              },
            ],
          };
          try {
            res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
            res.write('data: [DONE]\n\n', () => {
              res.end();
            });
          } catch (writeError) {
            console.error('[Upstream Error] Failed to write error to stream:', writeError.message);
            if (!res.writableEnded) {
              try {
                res.end();
              } catch (endError) {
                console.error('[Upstream Error] Failed to end response:', endError.message);
              }
            }
          }

          // We are done with this request. Return early.
          return;
        }

        // Normal header setting for non-streaming or successful streaming responses
        res.status(upstreamStatus);
        firstAiAPIResponse.headers.forEach((value, name) => {
          if (
            !['content-encoding', 'transfer-encoding', 'connection', 'content-length', 'keep-alive'].includes(
              name.toLowerCase(),
            )
          ) {
            res.setHeader(name, value);
          }
        });
        if (isOriginalRequestStreaming && !res.getHeader('Content-Type')?.includes('text/event-stream')) {
          res.setHeader('Content-Type', 'text/event-stream');
          if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
          if (!res.getHeader('Connection')) res.setHeader('Connection', 'keep-alive');
        }
      }

      const context = {
        ...this.config,
        toolExecutor: this.toolExecutor,
        ToolCallParser,
        abortController,
        originalBody,
        clientIp,
        forceShowVCP,
        _refreshRagBlocksIfNeeded,
        fetchWithRetry,
        isToolResultError,
        formatToolResult
      };

      if (isUpstreamStreaming) {
        await new StreamHandler(context).handle(req, res, firstAiAPIResponse);
      } else {
        await new NonStreamHandler(context).handle(req, res, firstAiAPIResponse);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        // When a request is aborted, the '/v1/interrupt' handler is responsible for closing the response stream.
        // This catch block should simply log the event and stop processing to prevent race conditions
        // and avoid throwing an uncaught exception if it also tries to write to the already-closed stream.
        console.log(`[Abort] Caught AbortError for request ${id}. Execution will be halted. The interrupt handler is responsible for the client response.`);
        return; // Stop processing and allow the 'finally' block to clean up.
      }
      // Only log full stack trace for non-abort errors
      console.error('处理请求或转发时出错:', error.message, error.stack);

      if (!res.headersSent) {
        if (isOriginalRequestStreaming) {
          // If streaming was requested but failed before headers were sent (e.g., fetchWithRetry failed),
          // send a 200 status and communicate the error via SSE chunks to prevent the client from stopping listening.
          res.status(200);
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          const errorContent = `[ERROR] 代理服务器在连接上游API时失败，可能已达到重试上限或网络错误: ${error.message}`;

          // Send an error chunk
          const errorPayload = {
            id: `chatcmpl-VCP-error-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: originalBody.model || 'unknown',
            choices: [
              {
                index: 0,
                delta: {
                  content: errorContent,
                },
                finish_reason: 'stop',
              },
            ],
          };
          try {
            res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
            res.write('data: [DONE]\n\n', () => {
              res.end();
            });
          } catch (writeError) {
            console.error('[Error Handler Stream] Failed to write error:', writeError.message);
            if (!res.writableEnded && !res.destroyed) {
              try {
                res.end();
              } catch (endError) {
                console.error('[Error Handler Stream] Failed to end response:', endError.message);
              }
            }
          }
        } else {
          // Non-streaming failure
          res.status(500).json({ error: 'Internal Server Error', details: error.message });
        }
      } else if (!res.writableEnded) {
        // Headers already sent (error during streaming loop)
        console.error(
          '[STREAM ERROR] Headers already sent. Cannot send JSON error. Ending stream if not already ended.',
        );
        // Send [DONE] marker before ending the stream for graceful termination
        try {
          res.write('data: [DONE]\n\n', () => {
            res.end();
          });
        } catch (writeError) {
          console.error('[Error Handler Stream Cleanup] Failed to write [DONE]:', writeError.message);
          if (!res.writableEnded && !res.destroyed) {
            try {
              res.end();
            } catch (endError) {
              console.error('[Error Handler Stream Cleanup] Failed to end response:', endError.message);
            }
          }
        }
      }
    } finally {
      if (id) {
        const requestData = activeRequests.get(id);
        if (requestData) {
          // 修复 Bug #4: 只有在未被 interrupt 路由中止时才执行清理
          // 优化清理逻辑：只有在请求未正常结束且未被中止时才调用 abort
          // 🟢 修复：不再在 finally 块中盲目 abort
          // 只有在客户端连接已断开（res.destroyed）且请求未正常结束时才中止上游
          // 这防止了在模型输出异常（如潜空间坍缩）导致处理逻辑快速结束时，服务器误杀上游连接
          if (!requestData.aborted && requestData.abortController && !requestData.abortController.signal.aborted) {
            if (res.destroyed && !res.writableEnded) {
              requestData.aborted = true;
              requestData.abortController.abort();
            }
          }

          // 无论如何都要删除 Map 条目以释放内存
          // 但使用 setImmediate 延迟删除，确保 interrupt 路由完成操作
          setImmediate(() => {
            activeRequests.delete(id);
            if (DEBUG_MODE) console.log(`[ChatHandler Cleanup] Removed request ${id} from activeRequests.`);
          });
        }
      }
    }
  }
}

module.exports = ChatCompletionHandler;
