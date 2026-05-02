// modules/handlers/streamHandler.js
const { StringDecoder } = require('string_decoder');
const vcpInfoHandler = require('../../vcpInfoHandler.js');
const roleDivider = require('../roleDivider.js');
const { buildAttachmentChunk, collectAttachmentsFromToolResults } = require('../attachmentCollector.js');

function extractTextFromContentLike(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        if (typeof item.text === 'string') return item.text;
        if (typeof item.content === 'string') return item.content;
        if (Array.isArray(item.content)) return extractTextFromContentLike(item.content);
        if (typeof item.value === 'string') return item.value;
        return '';
      })
      .join('');
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.content)) return extractTextFromContentLike(value.content);
    if (typeof value.value === 'string') return value.value;
  }
  return '';
}

function extractVisibleTextFromChunkData(parsedData) {
  if (!parsedData || typeof parsedData !== 'object') return '';

  const choice = Array.isArray(parsedData.choices) ? parsedData.choices[0] : null;
  const delta = choice?.delta || parsedData.delta;
  const message = choice?.message || parsedData.message;
  const candidate = Array.isArray(parsedData.candidates) ? parsedData.candidates[0] : null;

  return (
    extractTextFromContentLike(delta?.content) ||
    extractTextFromContentLike(delta?.text) ||
    extractTextFromContentLike(delta) ||
    extractTextFromContentLike(choice?.text) ||
    extractTextFromContentLike(message?.content) ||
    extractTextFromContentLike(parsedData.content) ||
    extractTextFromContentLike(parsedData.text) ||
    extractTextFromContentLike(parsedData.output_text) ||
    extractTextFromContentLike(parsedData.output?.[0]?.content) ||
    extractTextFromContentLike(parsedData.response?.output_text) ||
    extractTextFromContentLike(candidate?.content?.parts)
  );
}

function formatUpstreamStreamError(errorValue) {
  if (!errorValue) return 'Unknown upstream stream error';
  if (typeof errorValue === 'string') return errorValue;
  if (typeof errorValue !== 'object') return String(errorValue);

  const parts = [];
  if (errorValue.message) parts.push(errorValue.message);
  if (errorValue.code) parts.push(`code=${errorValue.code}`);
  if (errorValue.type) parts.push(`type=${errorValue.type}`);
  if (errorValue.status) parts.push(`status=${errorValue.status}`);
  if (errorValue.details) {
    parts.push(typeof errorValue.details === 'string' ? errorValue.details : JSON.stringify(errorValue.details));
  }
  if (errorValue.response?.data) {
    parts.push(typeof errorValue.response.data === 'string'
      ? errorValue.response.data
      : JSON.stringify(errorValue.response.data));
  }

  return parts.length > 0 ? parts.join(' | ') : JSON.stringify(errorValue);
}

class StreamHandler {
  constructor(context) {
    this.context = context;
    this.config = context; // 兼容旧代码中的解构
  }

  async handle(req, res, firstAiAPIResponse) {
    const {
      apiUrl,
      apiKey,
      pluginManager,
      writeDebugLog,
      writeChatLog,
      handleDiaryFromAIResponse,
      webSocketServer,
      DEBUG_MODE,
      SHOW_VCP_OUTPUT,
      maxVCPLoopStream,
      apiRetries,
      apiRetryDelay,
      RAGMemoRefresh,
      enableRoleDivider,
      enableRoleDividerInLoop,
      roleDividerIgnoreList,
      roleDividerSwitches,
      roleDividerScanSwitches,
      roleDividerRemoveDisabledTags,
      toolExecutor,
      ToolCallParser,
      abortController,
      originalBody,
      clientIp,
      _refreshRagBlocksIfNeeded,
      fetchWithRetry
    } = this.context;

    const shouldShowVCP = SHOW_VCP_OUTPUT || this.context.forceShowVCP;
    const id = originalBody.requestId || originalBody.messageId;

    let currentMessagesForLoop = originalBody.messages ? JSON.parse(JSON.stringify(originalBody.messages)) : [];
    let recursionDepth = 0;
    const maxRecursion = maxVCPLoopStream || 5;
    let currentAIContentForLoop = '';
    let currentAIRawDataForDiary = '';
    let chatLogs = [];

    const streamUpstreamErrorAndEnd = async (aiResponse, phase, requestMessages) => {
      const status = aiResponse?.status || 'unknown';
      let errorBodyText = '';
      try {
        errorBodyText = aiResponse && typeof aiResponse.text === 'function'
          ? await aiResponse.text()
          : '';
      } catch (e) {
        errorBodyText = `[failed to read upstream error body: ${e.message}]`;
      }

      console.error(`[VCP Stream Loop] Upstream API returned status ${status} during ${phase}: ${errorBodyText}`);

      if (writeChatLog) {
        writeChatLog(originalBody, [
          ...chatLogs,
          {
            request: { messages: requestMessages },
            response: { error: true, status, phase, body: errorBodyText },
          },
        ]);
      }

      if (res.writableEnded || res.destroyed) return;

      const errorPayload = {
        id: `chatcmpl-VCP-loop-upstream-error-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: originalBody.model || 'unknown',
        choices: [
          {
            index: 0,
            delta: {
              content: `[UPSTREAM_ERROR] Upstream API returned status ${status}: ${errorBodyText}`,
            },
            finish_reason: 'stop',
          },
        ],
      };

      try {
        res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
        res.write('data: [DONE]\n\n', () => {
          try { res.end(); } catch (e) { }
        });
      } catch (e) {
        console.error('[VCP Stream Loop] Failed to stream upstream error:', e.message);
        if (!res.writableEnded && !res.destroyed) {
          try { res.end(); } catch (endError) { }
        }
      }
    };

    // 辅助函数：处理 AI 响应流 (优化版：直通转发 + 后台解析 + chunk 空闲超时保护)
    const processAIResponseStreamHelper = async (aiResponse, isInitialCall) => {
      return new Promise((resolve, reject) => {
        const decoder = new StringDecoder('utf8');
        let collectedContentThisTurn = '';
        let rawResponseDataThisTurn = '';
        let sseLineBuffer = '';
        let streamAborted = false;
        let keepAliveTimer = null;
        let chunkIdleTimer = null;
        const CHUNK_IDLE_TIMEOUT = 90000; // 90 秒无新 chunk 则判定上游流冻结
        let message = { content: '', reasoning_content: '' };

        const appendDelta = (parsedData) => {
          const visibleText = extractVisibleTextFromChunkData(parsedData);
          if (visibleText) {
            collectedContentThisTurn += visibleText;
            message.content += visibleText;
          }
        };

        const endWithParsedStreamError = (parsedData) => {
          const upstreamErrorMessage = formatUpstreamStreamError(parsedData.error);
          console.error(`[VCP Stream Loop] Upstream emitted stream error chunk: ${upstreamErrorMessage}`);

          const errorContent = `[UPSTREAM_ERROR] ${upstreamErrorMessage}`;
          collectedContentThisTurn += errorContent;
          message.content += errorContent;
          streamAborted = true;

          if (!res.writableEnded && !res.destroyed) {
            try {
              const errorPayload = {
                id: `chatcmpl-VCP-stream-error-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: originalBody.model || 'unknown',
                choices: [{ index: 0, delta: { content: errorContent }, finish_reason: 'stop' }],
              };
              res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
              res.write('data: [DONE]\n\n', () => {
                try { res.end(); } catch (e) { }
              });
            } catch (e) {
              console.error('[VCP Stream Loop] Failed to stream parsed upstream error:', e.message);
              try { res.end(); } catch (endError) { }
            }
          }

          if (aiResponse.body && !aiResponse.body.destroyed) aiResponse.body.destroy();
          if (keepAliveTimer) clearInterval(keepAliveTimer);
          if (chunkIdleTimer) clearTimeout(chunkIdleTimer);
          if (abortController?.signal) abortController.signal.removeEventListener('abort', abortHandler);
          resolve({ content: collectedContentThisTurn, raw: rawResponseDataThisTurn, message: message });
        };
        // 🌟 核心修复：注入 SSE 幽灵心跳保活，防止上游卡顿时浏览器假死
        keepAliveTimer = setInterval(() => {
          if (!res.writableEnded && !res.destroyed) {
            try {
              res.write(': vcp-keepalive\n\n');
            } catch (e) {
              // Ignore errors
            }
          }
        }, 5000); // 5秒发一次心跳

        // 🌟 新增：chunk 级空闲超时保护
        // 如果连续 CHUNK_IDLE_TIMEOUT 毫秒未收到任何上游 data chunk，
        // 则判定上游流已冻结，主动中止并 resolve，防止无限挂起
        const resetChunkIdleTimer = () => {
          if (chunkIdleTimer) clearTimeout(chunkIdleTimer);
          chunkIdleTimer = setTimeout(() => {
            if (streamAborted) return;
            console.warn(`[Stream IdleTimeout] No upstream chunk received for ${CHUNK_IDLE_TIMEOUT / 1000}s. Assuming stream stalled. Forcing end.`);
            streamAborted = true;
            // 通知前端这次流异常结束
            if (!res.writableEnded && !res.destroyed) {
              try {
                const stallPayload = {
                  id: `chatcmpl-VCP-stall-${Date.now()}`,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: originalBody.model || 'unknown',
                  choices: [{ index: 0, delta: { content: '\n[上游响应超时，流已中断]' }, finish_reason: 'stop' }],
                };
                res.write(`data: ${JSON.stringify(stallPayload)}\n\n`);
                res.write('data: [DONE]\n\n');
              } catch (e) { /* ignore */ }
            }
            if (aiResponse.body && !aiResponse.body.destroyed) {
              aiResponse.body.destroy();
            }
            if (keepAliveTimer) clearInterval(keepAliveTimer);
            if (abortController?.signal) abortController.signal.removeEventListener('abort', abortHandler);
            resolve({ content: collectedContentThisTurn, raw: rawResponseDataThisTurn, message: message });
          }, CHUNK_IDLE_TIMEOUT);
        };
        resetChunkIdleTimer(); // 启动首次空闲计时

        const abortHandler = () => {
          streamAborted = true;
          if (DEBUG_MODE) console.log('[Stream Abort] Abort signal received, stopping stream processing.');
          if (abortController?.signal) abortController.signal.removeEventListener('abort', abortHandler);
          if (aiResponse.body && !aiResponse.body.destroyed) aiResponse.body.destroy();
          resolve({ content: collectedContentThisTurn, raw: rawResponseDataThisTurn, message: message });
        };

        if (abortController?.signal) {
          abortController.signal.addEventListener('abort', abortHandler);
        }

        aiResponse.body.on('data', chunk => {
          if (streamAborted) return;
          resetChunkIdleTimer(); // 每收到一个 chunk 就重置空闲计时器

          const chunkString = decoder.write(chunk);
          rawResponseDataThisTurn += chunkString;
          sseLineBuffer += chunkString;

          // 按行处理：既保证了转发的实时性，又解决了 [DONE] 跨包截断的问题
          // 使用更健壮的正则拆分，处理 \r\n, \n, \r (SSE 规范允许这三种换行符)
          let lines = sseLineBuffer.split(/\r\n|\r|\n/);
          sseLineBuffer = lines.pop(); // 最后一项可能是截断的，留到下一轮

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith('data: ')) {
              const jsonData = trimmedLine.substring(6).trim();
              if (jsonData && jsonData !== '[DONE]') {
                try {
                  const parsedData = JSON.parse(jsonData);
                  if (parsedData?.error) {
                    endWithParsedStreamError(parsedData);
                    return;
                  }
                } catch (e) { }
              }
            }

            // 1. 转发逻辑：只要不是 [DONE] 就立即转发
            if (!res.writableEnded && !res.destroyed) {
              // 必须保留空行，因为 SSE 依靠空行 (\n\n) 来分隔消息块
              // 如果丢失空行，多个 data: 块会被合并，导致前端解析 JSON 失败
              if (trimmedLine !== 'data: [DONE]' && trimmedLine !== 'data:[DONE]') {
                try {
                  // 统一使用 \n 作为换行符转发，确保前端解析正常
                  res.write(line + '\n');
                } catch (writeError) {
                  streamAborted = true;
                }
              }
            }

            // 2. 后台解析逻辑：收集内容用于 VCP 循环
            if (trimmedLine.startsWith('data: ')) {
              const jsonData = trimmedLine.substring(6).trim();
              if (jsonData && jsonData !== '[DONE]') {
                try {
                  const parsedData = JSON.parse(jsonData);
                  if (parsedData?.error) {
                    endWithParsedStreamError(parsedData);
                    return;
                  }
                  appendDelta(parsedData);
                } catch (e) { }
              }
            }
          }
        });

        aiResponse.body.on('end', () => {
          if (keepAliveTimer) clearInterval(keepAliveTimer);
          if (chunkIdleTimer) clearTimeout(chunkIdleTimer);
          const remainingString = decoder.end();
          if (remainingString) {
            rawResponseDataThisTurn += remainingString;
            sseLineBuffer += remainingString;
          }

          // 处理最后剩余的 buffer 并转发
          if (sseLineBuffer.length > 0) {
            const trimmedLine = sseLineBuffer.trim();
            if (trimmedLine.startsWith('data: ')) {
              const jsonData = trimmedLine.substring(6).trim();
              if (jsonData && jsonData !== '[DONE]') {
                try {
                  const parsedData = JSON.parse(jsonData);
                  if (parsedData?.error) {
                    endWithParsedStreamError(parsedData);
                    return;
                  }
                } catch (e) { }
              }
            }
            if (!res.writableEnded && !res.destroyed && trimmedLine !== 'data: [DONE]' && trimmedLine !== 'data:[DONE]') {
              try {
                res.write(sseLineBuffer + '\n');
              } catch (e) { }
            }

            if (trimmedLine.startsWith('data: ')) {
              const jsonData = trimmedLine.substring(6).trim();
              if (jsonData && jsonData !== '[DONE]') {
                try {
                  const parsedData = JSON.parse(jsonData);
                  if (parsedData?.error) {
                    endWithParsedStreamError(parsedData);
                    return;
                  }
                  appendDelta(parsedData);
                } catch (e) { }
              }
            }
          }

          if (abortController?.signal) abortController.signal.removeEventListener('abort', abortHandler);
          resolve({ content: collectedContentThisTurn, raw: rawResponseDataThisTurn, message: message });
        });

        aiResponse.body.on('error', streamError => {
          if (keepAliveTimer) clearInterval(keepAliveTimer);
          if (chunkIdleTimer) clearTimeout(chunkIdleTimer);
          if (abortController?.signal) abortController.signal.removeEventListener('abort', abortHandler);
          if (streamAborted || streamError.name === 'AbortError' || streamError.type === 'aborted') {
            resolve({ content: collectedContentThisTurn, raw: rawResponseDataThisTurn, message: message });
            return;
          }
          console.error('Error reading AI response stream:', streamError);
          if (!res.writableEnded) {
            try {
              res.write(`data: ${JSON.stringify({ error: 'STREAM_READ_ERROR', message: streamError.message })}\n\n`);
              res.end();
            } catch (e) { }
          }
          reject(streamError);
        });
      });
    };

    // --- 初始 AI 调用 ---
    if (DEBUG_MODE) console.log('[VCP Stream Loop] Processing initial AI call.');
    let initialAIResponseData = await processAIResponseStreamHelper(firstAiAPIResponse, true);
    currentAIContentForLoop = initialAIResponseData.content;
    currentAIRawDataForDiary = initialAIResponseData.raw;
    if (writeChatLog) chatLogs.push({ request: originalBody, response: initialAIResponseData.message });
    handleDiaryFromAIResponse(currentAIRawDataForDiary).catch(e =>
      console.error('[VCP Stream Loop] Error in initial diary handling:', e),
    );

    // --- VCP 循环 ---
    while (recursionDepth < maxRecursion) {
      // 检查中止信号
      if (abortController && abortController.signal.aborted) {
        if (DEBUG_MODE) console.log('[VCP Stream Loop] Abort detected, exiting loop.');
        break;
      }

      let assistantMessages = [{ role: 'assistant', content: currentAIContentForLoop }];
      if (enableRoleDivider && enableRoleDividerInLoop) {
        assistantMessages = roleDivider.process(assistantMessages, {
          ignoreList: roleDividerIgnoreList,
          switches: roleDividerSwitches,
          scanSwitches: roleDividerScanSwitches,
          removeDisabledTags: roleDividerRemoveDisabledTags,
          skipCount: 0
        });
      }
      currentMessagesForLoop.push(...assistantMessages);

      const toolCalls = ToolCallParser.parse(currentAIContentForLoop);
      if (toolCalls.length === 0) {
        if (DEBUG_MODE) console.log('[VCP Stream Loop] No tool calls found. Exiting loop.');
        if (!res.writableEnded) {
          const finalChunkPayload = {
            id: `chatcmpl-VCP-final-stop-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: originalBody.model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          };
          try {
            res.write(`data: ${JSON.stringify(finalChunkPayload)}\n\n`);
            res.write('data: [DONE]\n\n', () => res.end());
          } catch (writeError) {
            console.error('[VCP Stream Loop] Failed to write final chunk:', writeError.message);
            if (!res.writableEnded && !res.destroyed) try { res.end(); } catch (e) { }
          }
        }
        break;
      }

      const { normal: normalCalls, archery: archeryCalls } = ToolCallParser.separate(toolCalls);
      const archeryErrorContents = [];

      // 执行 Archery 调用
      const archeryLogs = await Promise.all(archeryCalls.map(async toolCall => {
        try {
          const result = await toolExecutor.execute(toolCall, clientIp, currentMessagesForLoop);
          const isError = !result.success || (result.raw && this.context.isToolResultError(result.raw));

          if (isError) {
            archeryErrorContents.push({
              type: 'text',
              text: `[异步工具 "${toolCall.name}" 返回了错误，请注意]:\n${result.content[0].text}`
            });
          }

          const forceThisOne = !shouldShowVCP && toolCall.markHistory;
          if ((shouldShowVCP || forceThisOne) && !res.writableEnded && (isError || forceThisOne)) {
            vcpInfoHandler.streamVcpInfo(res, originalBody.model, result.success ? 'success' : 'error', toolCall.name, result.raw || result.error, abortController);
          }
          return { tool: toolCall, result: result.content };
        } catch (e) {
          console.error(`[VCP Stream Loop Archery Error] ${toolCall.name}:`, e);
          return { tool: toolCall, result: [{ type: 'text', text: String(e.message) }] };
        }
      }));

      // 处理纯 Archery 且有错误的情况
      if (normalCalls.length === 0 && archeryErrorContents.length > 0) {
        const errorPayload = `<!-- VCP_TOOL_PAYLOAD -->\n${JSON.stringify(archeryErrorContents)}`;
        currentMessagesForLoop.push({ role: 'user', content: errorPayload });

        if (!res.writableEnded && !res.destroyed) {
          try {
            res.write(`data: ${JSON.stringify({
              id: `chatcmpl-VCP-separator-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: originalBody.model,
              choices: [{ index: 0, delta: { content: '\n' }, finish_reason: null }],
            })}\n\n`);
          } catch (e) { }
        }

        const nextAiAPIResponse = await fetchWithRetry(
          `${apiUrl}/v1/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              Accept: 'text/event-stream',
            },
            body: JSON.stringify({ ...originalBody, messages: currentMessagesForLoop, stream: true }),
            signal: abortController.signal,
          },
          { retries: apiRetries, delay: apiRetryDelay, debugMode: DEBUG_MODE }
        );

        if (nextAiAPIResponse.ok) {
          let nextAIResponseData = await processAIResponseStreamHelper(nextAiAPIResponse, false);
          currentAIContentForLoop = nextAIResponseData.content;
          if (writeChatLog) {
            chatLogs.push({
              request: { messages: currentMessagesForLoop },
              toolCalls: archeryLogs,
              response: nextAIResponseData.message,
            });
          }
          recursionDepth++;
          continue;
        }
        await streamUpstreamErrorAndEnd(nextAiAPIResponse, 'archery_error_followup', currentMessagesForLoop);
        return;
      }

      if (normalCalls.length === 0) {
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.write(`data: ${JSON.stringify({
              id: `chatcmpl-VCP-final-stop-${Date.now()}`,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`);
            res.write('data: [DONE]\n\n', () => {
              try { res.end(); } catch (e) { }
            });
          } catch (e) { }
        }
        break;
      }

      // 执行普通调用
      const toolResults = await toolExecutor.executeAll(normalCalls, clientIp, currentMessagesForLoop);
      const vcpAttachments = collectAttachmentsFromToolResults(toolResults);
      if (vcpAttachments.length > 0 && !res.writableEnded && !res.destroyed) {
        try {
          res.write(`data: ${JSON.stringify(buildAttachmentChunk({
            model: originalBody.model,
            attachments: vcpAttachments
          }))}\n\n`);
        } catch (attachmentWriteError) {
          console.error('[VCP Stream Loop] Failed to stream attachment chunk:', attachmentWriteError.message);
        }
      }
      const combinedToolResultsForAI = toolResults.map(r => r.content).flat();
      if (archeryErrorContents.length > 0) combinedToolResultsForAI.push(...archeryErrorContents);

      const normalCallLogs = (() => {
        let logs = [];
        if (writeChatLog) {
          for (let i = 0; i < normalCalls.length; i++) {
            logs.push({ tool: normalCalls[i], result: toolResults[i]?.content });
          }
        }
        return logs;
      })();

      // VCP 信息展示 - 批量包裹为单个 USER 角色
      let hasStartedUserBlock = false;
      for (let i = 0; i < normalCalls.length; i++) {
        const toolCall = normalCalls[i];
        const result = toolResults[i];
        const forceThisOne = !shouldShowVCP && toolCall.markHistory;

        if ((shouldShowVCP || forceThisOne) && !res.writableEnded && !res.destroyed) {
          if (!hasStartedUserBlock && enableRoleDivider) {
             try {
                // start the user block
                res.write(`data: ${JSON.stringify({
                  id: `chatcmpl-vcp-start-${Date.now()}`,
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: { content: "\n<<<[ROLE_DIVIDE_USER]>>>\n" }, finish_reason: null }]
                })}\n\n`);
                hasStartedUserBlock = true;
             } catch (e) {}
          }
          vcpInfoHandler.streamVcpInfo(res, originalBody.model, toolCall.name, result.success ? 'success' : 'error', result.raw || result.error, abortController);
        }
      }
      
      if (hasStartedUserBlock && !res.writableEnded && !res.destroyed && enableRoleDivider) {
         try {
            // close the user block
            res.write(`data: ${JSON.stringify({
              id: `chatcmpl-vcp-end-${Date.now()}`,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content: "\n<<<[END_ROLE_DIVIDE_USER]>>>\n" }, finish_reason: null }]
            })}\n\n`);
         } catch(e) {}
      }

      // RAG 刷新
      const toolResultsTextForRAG = JSON.stringify(combinedToolResultsForAI, (k, v) =>
        (k === 'url' || k === 'image_url') && typeof v === 'string' && v.startsWith('data:') ? "[Omitted]" : v
      );

      if (RAGMemoRefresh) {
        currentMessagesForLoop = await _refreshRagBlocksIfNeeded(currentMessagesForLoop, {
          lastAiMessage: currentAIContentForLoop,
          toolResultsText: toolResultsTextForRAG
        }, pluginManager, DEBUG_MODE);
      }

      const hasImage = combinedToolResultsForAI.some(item => item.type === 'image_url');
      const finalToolPayloadForAI = hasImage
        ? [{ type: 'text', text: `<!-- VCP_TOOL_PAYLOAD -->\nResults:` }, ...combinedToolResultsForAI]
        : `<!-- VCP_TOOL_PAYLOAD -->\n${toolResultsTextForRAG}`;

      currentMessagesForLoop.push({ role: 'user', content: finalToolPayloadForAI });

      if (!res.writableEnded && !res.destroyed) {
        try {
          res.write(`data: ${JSON.stringify({
            id: `chatcmpl-VCP-separator-${Date.now()}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: '\n' }, finish_reason: null }],
          })}\n\n`);
        } catch (e) { }
      }

      const nextAiAPIResponse = await fetchWithRetry(
        `${apiUrl}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({ ...originalBody, messages: currentMessagesForLoop, stream: true }),
          signal: abortController.signal,
        },
        { retries: apiRetries, delay: apiRetryDelay, debugMode: DEBUG_MODE }
      );

      if (!nextAiAPIResponse.ok) {
        await streamUpstreamErrorAndEnd(nextAiAPIResponse, 'tool_result_followup', currentMessagesForLoop);
        return;
      }

      let nextAIResponseData = await processAIResponseStreamHelper(nextAiAPIResponse, false);
      currentAIContentForLoop = nextAIResponseData.content;
      if (writeChatLog) {
        chatLogs.push({
          request: { messages: currentMessagesForLoop },
          toolCalls: [ ...archeryLogs, ...normalCallLogs ],
          response: nextAIResponseData.message,
        });
      }

      // 记录日志
      handleDiaryFromAIResponse(nextAIResponseData.raw).catch(e =>
        console.error(`[VCP Stream Loop] Error in diary handling for depth ${recursionDepth}:`, e),
      );

      recursionDepth++;
    } // toolcall loop end

    if (writeChatLog) writeChatLog(originalBody, chatLogs);

    if (recursionDepth >= maxRecursion && !res.writableEnded && !res.destroyed) {
      try {
        res.write(`data: ${JSON.stringify({
          id: `chatcmpl-VCP-final-length-${Date.now()}`,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
        })}\n\n`);
        res.write('data: [DONE]\n\n', () => {
          try { res.end(); } catch (e) { }
        });
      } catch (e) { }
    }
  }
}

module.exports = StreamHandler;
