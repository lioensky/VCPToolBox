// modules/handlers/streamHandler.js
const { StringDecoder } = require('string_decoder');
const vcpInfoHandler = require('../../vcpInfoHandler.js');
const roleDivider = require('../roleDivider.js');

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

    // 辅助函数：处理 AI 响应流 (优化版：直通转发 + 后台解析)
    const processAIResponseStreamHelper = async (aiResponse, isInitialCall) => {
      return new Promise((resolve, reject) => {
        const decoder = new StringDecoder('utf8');
        let collectedContentThisTurn = '';
        let rawResponseDataThisTurn = '';
        let sseLineBuffer = '';
        let streamAborted = false;

        const abortHandler = () => {
          streamAborted = true;
          if (DEBUG_MODE) console.log('[Stream Abort] Abort signal received, stopping stream processing.');
          if (abortController?.signal) abortController.signal.removeEventListener('abort', abortHandler);
          if (aiResponse.body && !aiResponse.body.destroyed) aiResponse.body.destroy();
          resolve({ content: collectedContentThisTurn, raw: rawResponseDataThisTurn });
        };

        if (abortController?.signal) {
          abortController.signal.addEventListener('abort', abortHandler);
        }

        aiResponse.body.on('data', chunk => {
          if (streamAborted) return;
          
          const chunkString = decoder.write(chunk);
          rawResponseDataThisTurn += chunkString;
          sseLineBuffer += chunkString;

          // 按行处理：既保证了转发的实时性，又解决了 [DONE] 跨包截断的问题
          // 使用更健壮的正则拆分，处理 \r\n, \n, \r (SSE 规范允许这三种换行符)
          let lines = sseLineBuffer.split(/\r\n|\r|\n/);
          sseLineBuffer = lines.pop(); // 最后一项可能是截断的，留到下一轮

          for (const line of lines) {
            const trimmedLine = line.trim();
            
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
                  const delta = parsedData.choices?.[0]?.delta;
                  if (delta) {
                    if (delta.content) collectedContentThisTurn += delta.content;
                    if (delta.reasoning_content) collectedContentThisTurn += delta.reasoning_content;
                  }
                } catch (e) {}
              }
            }
          }
        });

        aiResponse.body.on('end', () => {
          const remainingString = decoder.end();
          if (remainingString) {
            rawResponseDataThisTurn += remainingString;
            sseLineBuffer += remainingString;
          }
          
          // 处理最后剩余的 buffer 并转发
          if (sseLineBuffer.length > 0) {
            const trimmedLine = sseLineBuffer.trim();
            if (!res.writableEnded && !res.destroyed && trimmedLine !== 'data: [DONE]' && trimmedLine !== 'data:[DONE]') {
              try {
                res.write(sseLineBuffer + '\n');
              } catch (e) {}
            }

            if (trimmedLine.startsWith('data: ')) {
              const jsonData = trimmedLine.substring(6).trim();
              if (jsonData && jsonData !== '[DONE]') {
                try {
                  const parsedData = JSON.parse(jsonData);
                  const delta = parsedData.choices?.[0]?.delta;
                  if (delta) {
                    if (delta.content) collectedContentThisTurn += delta.content;
                    if (delta.reasoning_content) collectedContentThisTurn += delta.reasoning_content;
                  }
                } catch (e) {}
              }
            }
          }

          if (abortController?.signal) abortController.signal.removeEventListener('abort', abortHandler);
          resolve({ content: collectedContentThisTurn, raw: rawResponseDataThisTurn });
        });

        aiResponse.body.on('error', streamError => {
          if (abortController?.signal) abortController.signal.removeEventListener('abort', abortHandler);
          if (streamAborted || streamError.name === 'AbortError' || streamError.type === 'aborted') {
            resolve({ content: collectedContentThisTurn, raw: rawResponseDataThisTurn });
            return;
          }
          console.error('Error reading AI response stream:', streamError);
          if (!res.writableEnded) {
            try {
              res.write(`data: ${JSON.stringify({ error: 'STREAM_READ_ERROR', message: streamError.message })}\n\n`);
              res.end();
            } catch (e) {}
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
            if (!res.writableEnded && !res.destroyed) try { res.end(); } catch (e) {}
          }
        }
        break;
      }

      const { normal: normalCalls, archery: archeryCalls } = ToolCallParser.separate(toolCalls);
      const archeryErrorContents = [];

      // 执行 Archery 调用
      await Promise.all(archeryCalls.map(async toolCall => {
        try {
          const result = await toolExecutor.execute(toolCall, clientIp);
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
        } catch (e) {
          console.error(`[VCP Stream Loop Archery Error] ${toolCall.name}:`, e);
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
          } catch (e) {}
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
          recursionDepth++;
          continue;
        }
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
              try { res.end(); } catch (e) {}
            });
          } catch (e) {}
        }
        break;
      }

      // 执行普通调用
      const toolResults = await toolExecutor.executeAll(normalCalls, clientIp);
      const combinedToolResultsForAI = toolResults.map(r => r.content).flat();
      if (archeryErrorContents.length > 0) combinedToolResultsForAI.push(...archeryErrorContents);

      // VCP 信息展示
      for (let i = 0; i < normalCalls.length; i++) {
        const toolCall = normalCalls[i];
        const result = toolResults[i];
        const forceThisOne = !shouldShowVCP && toolCall.markHistory;
        
        if ((shouldShowVCP || forceThisOne) && !res.writableEnded && !res.destroyed) {
          vcpInfoHandler.streamVcpInfo(res, originalBody.model, toolCall.name, result.success ? 'success' : 'error', result.raw || result.error, abortController);
        }
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
        } catch (e) {}
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

      if (!nextAiAPIResponse.ok) break;

      let nextAIResponseData = await processAIResponseStreamHelper(nextAiAPIResponse, false);
      currentAIContentForLoop = nextAIResponseData.content;
      
      // 记录日志
      handleDiaryFromAIResponse(nextAIResponseData.raw).catch(e =>
        console.error(`[VCP Stream Loop] Error in diary handling for depth ${recursionDepth}:`, e),
      );

      recursionDepth++;
    }

    if (recursionDepth >= maxRecursion && !res.writableEnded && !res.destroyed) {
      try {
        res.write(`data: ${JSON.stringify({
          id: `chatcmpl-VCP-final-length-${Date.now()}`,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
        })}\n\n`);
        res.write('data: [DONE]\n\n', () => {
          try { res.end(); } catch (e) {}
        });
      } catch (e) {}
    }
  }
}

module.exports = StreamHandler;