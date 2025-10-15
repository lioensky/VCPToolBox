// modules/chatCompletionHandler.js
const messageProcessor = require('./messageProcessor.js');
const vcpInfoHandler = require('../vcpInfoHandler.js');

// A helper function to handle fetch with retries for specific status codes
async function fetchWithRetry(url, options, retries = 3, delay = 1000, debugMode = false) {
  const { default: fetch } = await import('node-fetch');
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 500 || response.status === 503) {
        if (debugMode) {
          console.warn(
            `[Fetch Retry] Received status ${response.status}. Retrying in ${delay}ms... (${i + 1}/${retries})`,
          );
        }
        await new Promise(resolve => setTimeout(resolve, delay * (i + 1))); // Increase delay for subsequent retries
        continue; // Try again
      }
      return response; // Success or non-retriable error
    } catch (error) {
      // If the request was aborted, don't retry, just rethrow the error immediately.
      if (error.name === 'AbortError') {
        if (debugMode) console.log('[Fetch Retry] Request was aborted. No retries will be attempted.');
        throw error;
      }
      if (i === retries - 1) {
        console.error(`[Fetch Retry] All retries failed. Last error: ${error.message}`);
        throw error; // Rethrow the last error after all retries fail
      }
      if (debugMode) {
        console.warn(
          `[Fetch Retry] Fetch failed with error: ${error.message}. Retrying in ${delay}ms... (${i + 1}/${retries})`,
        );
      }
      await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
    }
  }
  throw new Error('Fetch failed after all retries.');
}
class ChatCompletionHandler {
  constructor(config) {
    this.config = config;
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
      maxVCPLoopStream,
      maxVCPLoopNonStream,
      apiRetries,
      apiRetryDelay,
    } = this.config;

    const shouldShowVCP = SHOW_VCP_OUTPUT || forceShowVCP;

    let clientIp = req.ip;
    if (clientIp && clientIp.substr(0, 7) === '::ffff:') {
      clientIp = clientIp.substr(7);
    }

    const id = req.body.requestId || req.body.messageId;
    const abortController = new AbortController();

    if (id) {
      activeRequests.set(id, { req, res, abortController, timestamp: Date.now() });
    }

    try {
      let originalBody = req.body;

      if (originalBody.model) {
        const originalModel = originalBody.model;
        const redirectedModel = modelRedirectHandler.redirectModelForBackend(originalModel);
        if (redirectedModel !== originalModel) {
          originalBody = { ...originalBody, model: redirectedModel };
          console.log(`[ModelRedirect] 客户端请求模型 '${originalModel}' 已重定向为后端模型 '${redirectedModel}'`);
        }
      }

      await writeDebugLog('LogInput', originalBody);

      let shouldProcessMedia = true;
      if (originalBody.messages && Array.isArray(originalBody.messages)) {
        for (const msg of originalBody.messages) {
          let foundPlaceholderInMsg = false;
          if (msg.role === 'user' || msg.role === 'system') {
            if (typeof msg.content === 'string' && msg.content.includes('{{ShowBase64}}')) {
              foundPlaceholderInMsg = true;
              msg.content = msg.content.replace(/\{\{ShowBase64\}\}/g, '');
            } else if (Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part.type === 'text' && typeof part.text === 'string' && part.text.includes('{{ShowBase64}}')) {
                  foundPlaceholderInMsg = true;
                  part.text = part.text.replace(/\{\{ShowBase64\}\}/g, '');
                }
              }
            }
          }
          if (foundPlaceholderInMsg) {
            shouldProcessMedia = false;
            if (DEBUG_MODE) console.log('[Server] Media processing disabled by {{ShowBase64}} placeholder.');
            break;
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

      // 经过改造后，processedMessages 已经是最终版本，无需再调用 replaceOtherVariables
      originalBody.messages = processedMessages;
      await writeDebugLog('LogOutputAfterProcessing', originalBody);

      const isOriginalRequestStreaming = originalBody.stream === true;
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
        apiRetries,
        apiRetryDelay,
        DEBUG_MODE,
      );

      const isUpstreamStreaming =
        willStreamResponse && firstAiAPIResponse.headers.get('content-type')?.includes('text/event-stream');

      if (!res.headersSent) {
        res.status(firstAiAPIResponse.status);
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

      let firstResponseRawDataForClientAndDiary = ''; // Used for non-streaming and initial diary

      if (isUpstreamStreaming) {
        let currentMessagesForLoop = originalBody.messages ? JSON.parse(JSON.stringify(originalBody.messages)) : [];
        let recursionDepth = 0;
        const maxRecursion = maxVCPLoopStream || 5;
        let currentAIContentForLoop = '';
        let currentAIRawDataForDiary = '';

        // Helper function to process an AI response stream
        async function processAIResponseStreamHelper(aiResponse, isInitialCall) {
          return new Promise((resolve, reject) => {
            let sseBuffer = ''; // Buffer for incomplete SSE lines
            let collectedContentThisTurn = ''; // Collects textual content from delta
            let rawResponseDataThisTurn = ''; // Collects all raw chunks for diary

            let sseLineBuffer = ''; // Buffer for incomplete SSE lines

            aiResponse.body.on('data', chunk => {
              const chunkString = chunk.toString('utf-8');
              rawResponseDataThisTurn += chunkString;
              sseLineBuffer += chunkString;

              let lines = sseLineBuffer.split('\n');
              // Keep the last part in buffer if it's not a complete line
              sseLineBuffer = lines.pop();

              const filteredLines = [];
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const jsonData = line.substring(5).trim();
                  if (jsonData && jsonData !== '[DONE]') {
                    try {
                      const parsedData = JSON.parse(jsonData);
                      const content = parsedData.choices?.[0]?.delta?.content;
                      // Filtering logic for thinking/reasoning content has been removed.
                    } catch (e) {
                      // Not a JSON we care about, pass through
                    }
                  }
                }
                filteredLines.push(line);
              }

              if (filteredLines.length > 0) {
                const filteredChunkString = filteredLines.join('\n') + '\n'; // Re-add newline for valid SSE stream
                const modifiedChunk = Buffer.from(filteredChunkString, 'utf-8');
                processChunk(modifiedChunk);
              }
            });

            // Process any remaining data in the buffer on stream end
            aiResponse.body.on('end', () => {
              if (sseLineBuffer.trim()) {
                const modifiedChunk = Buffer.from(sseLineBuffer, 'utf-8');
                processChunk(modifiedChunk);
              }
              // Signal end of processing for this stream helper
              finalizeStream();
            });

            function processChunk(chunk) {
              const chunkString = chunk.toString('utf-8');
              const linesInChunk = chunkString.split('\n');
              let containsDoneMarker = false;
              const forwardLines = [];

              for (const line of linesInChunk) {
                if (line.startsWith('data: ')) {
                  const jsonData = line.substring(5).trim();
                  if (jsonData === '[DONE]') {
                    containsDoneMarker = true;
                    continue; // Skip forwarding explicit DONE markers; server will emit its own.
                  }
                }
                forwardLines.push(line);
              }

              let chunkToWrite = forwardLines.join('\n');
              const originalEndsWithDoubleNewline = chunkString.endsWith('\n\n');
              const originalEndsWithSingleNewline = !originalEndsWithDoubleNewline && chunkString.endsWith('\n');

              if (chunkToWrite.length > 0) {
                if (originalEndsWithDoubleNewline && !chunkToWrite.endsWith('\n\n')) {
                  if (chunkToWrite.endsWith('\n')) {
                    chunkToWrite += '\n';
                  } else {
                    chunkToWrite += '\n\n';
                  }
                } else if (originalEndsWithSingleNewline && !chunkToWrite.endsWith('\n')) {
                  chunkToWrite += '\n';
                }
              }

              if (!res.writableEnded && chunkToWrite.trim().length > 0) {
                res.write(chunkToWrite);
              }

              if (containsDoneMarker) {
                // DONE markers should not contribute content but must still trigger finalization logic downstream.
                // No immediate action required here because finalizeStream will handle the resolver and the
                // outer loop will emit its own terminal chunk/[DONE].
              }

              // SSE parsing for content collection
              sseBuffer += chunkString;
              let lines = sseBuffer.split('\n');
              sseBuffer = lines.pop(); // Keep incomplete line for the next 'data' event or 'end'

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const jsonData = line.substring(5).trim();
                  if (jsonData !== '[DONE]' && jsonData) {
                    // Ensure jsonData is not empty and not "[DONE]"
                    try {
                      const parsedData = JSON.parse(jsonData);
                      collectedContentThisTurn += parsedData.choices?.[0]?.delta?.content || '';
                    } catch (e) {
                      /* ignore parse error for intermediate chunks */
                    }
                  }
                }
              }
            }

            function finalizeStream() {
              // Process remaining sseBuffer for content
              if (sseBuffer.trim().length > 0) {
                const finalLines = sseBuffer.split('\n');
                for (const line of finalLines) {
                  const trimmedLine = line.trim();
                  if (trimmedLine.startsWith('data: ')) {
                    const jsonData = trimmedLine.substring(5).trim();
                    if (jsonData !== '[DONE]' && jsonData) {
                      // Ensure jsonData is not empty and not "[DONE]"
                      try {
                        const parsedData = JSON.parse(jsonData);
                        const content = parsedData.choices?.[0]?.delta?.content;
                        // Filtering logic for thinking/reasoning content has been removed.

                        // All content is now collected.
                        collectedContentThisTurn += content || '';
                      } catch (e) {
                        /* ignore */
                      }
                    }
                  }
                }
              }
              resolve({ content: collectedContentThisTurn, raw: rawResponseDataThisTurn });
            }
            aiResponse.body.on('error', streamError => {
              console.error('Error reading AI response stream in loop:', streamError);
              if (!res.writableEnded) {
                // Try to send an error message before closing if possible
                try {
                  res.write(
                    `data: ${JSON.stringify({ error: 'STREAM_READ_ERROR', message: streamError.message })}\n\n`,
                  );
                } catch (e) {
                  /* ignore if write fails */
                }
                res.end();
              }
              reject(streamError);
            });
          });
        }

        // --- Initial AI Call ---
        if (DEBUG_MODE) console.log('[VCP Stream Loop] Processing initial AI call.');
        let initialAIResponseData = await processAIResponseStreamHelper(firstAiAPIResponse, true);
        currentAIContentForLoop = initialAIResponseData.content;
        currentAIRawDataForDiary = initialAIResponseData.raw;
        handleDiaryFromAIResponse(currentAIRawDataForDiary).catch(e =>
          console.error('[VCP Stream Loop] Error in initial diary handling:', e),
        );
        if (DEBUG_MODE)
          console.log('[VCP Stream Loop] Initial AI content (first 200):', currentAIContentForLoop.substring(0, 200));

        // --- VCP Loop ---
        while (recursionDepth < maxRecursion) {
          currentMessagesForLoop.push({ role: 'assistant', content: currentAIContentForLoop });

          const toolRequestStartMarker = '<<<[TOOL_REQUEST]>>>';
          const toolRequestEndMarker = '<<<[END_TOOL_REQUEST]>>>';
          let toolCallsInThisAIResponse = [];
          let searchOffset = 0;

          while (searchOffset < currentAIContentForLoop.length) {
            const startIndex = currentAIContentForLoop.indexOf(toolRequestStartMarker, searchOffset);
            if (startIndex === -1) break;

            const endIndex = currentAIContentForLoop.indexOf(
              toolRequestEndMarker,
              startIndex + toolRequestStartMarker.length,
            );
            if (endIndex === -1) {
              if (DEBUG_MODE)
                console.warn('[VCP Stream Loop] Found TOOL_REQUEST_START but no END marker after offset', searchOffset);
              searchOffset = startIndex + toolRequestStartMarker.length;
              continue;
            }

            const requestBlockContent = currentAIContentForLoop
              .substring(startIndex + toolRequestStartMarker.length, endIndex)
              .trim();
            let parsedToolArgs = {};
            let requestedToolName = null;
            let isArchery = false;
            const paramRegex = /([\w_]+)\s*:\s*「始」([\s\S]*?)「末」\s*(?:,)?/g;
            let regexMatch;
            while ((regexMatch = paramRegex.exec(requestBlockContent)) !== null) {
              const key = regexMatch[1];
              const value = regexMatch[2].trim();
              if (key === 'tool_name') requestedToolName = value;
              else if (key === 'archery') isArchery = value === 'true' || value === 'no_reply';
              else parsedToolArgs[key] = value;
            }

            if (requestedToolName) {
              toolCallsInThisAIResponse.push({ name: requestedToolName, args: parsedToolArgs, archery: isArchery });
              if (DEBUG_MODE)
                console.log(
                  `[VCP Stream Loop] Parsed tool request: ${requestedToolName}`,
                  parsedToolArgs,
                  `Archery: ${isArchery}`,
                );
            } else {
              if (DEBUG_MODE)
                console.warn(
                  '[VCP Stream Loop] Parsed a tool request block but no tool_name found:',
                  requestBlockContent.substring(0, 100),
                );
            }
            searchOffset = endIndex + toolRequestEndMarker.length;
          }

          if (toolCallsInThisAIResponse.length === 0) {
            if (DEBUG_MODE)
              console.log(
                '[VCP Stream Loop] No tool calls found in AI response. Sending final signals and exiting loop.',
              );
            if (!res.writableEnded) {
              // Construct and send the final chunk with finish_reason 'stop'
              const finalChunkPayload = {
                id: `chatcmpl-VCP-final-stop-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: originalBody.model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: 'stop',
                  },
                ],
              };
              res.write(`data: ${JSON.stringify(finalChunkPayload)}\n\n`);
              res.write('data: [DONE]\n\n', () => {
                res.end();
              });
            }
            break;
          }
          if (DEBUG_MODE)
            console.log(
              `[VCP Stream Loop] Found ${toolCallsInThisAIResponse.length} tool calls. Iteration ${
                recursionDepth + 1
              }.`,
            );

          const archeryCalls = toolCallsInThisAIResponse.filter(tc => tc.archery);
          const normalCalls = toolCallsInThisAIResponse.filter(tc => !tc.archery);

          // Execute archery calls without waiting for results to be sent back to the AI
          archeryCalls.forEach(toolCall => {
            if (DEBUG_MODE)
              console.log(
                `[VCP Stream Loop] Executing ARCHERY tool call (no reply): ${toolCall.name} with args:`,
                toolCall.args,
              );
            // Fire-and-forget execution, but handle logging and notifications in then/catch
            pluginManager
              .processToolCall(toolCall.name, toolCall.args, clientIp)
              .then(async pluginResult => {
                await writeDebugLog(`VCP-Stream-Archery-Result-${toolCall.name}`, {
                  args: toolCall.args,
                  result: pluginResult,
                });
                const toolResultText =
                  pluginResult !== undefined && pluginResult !== null
                    ? typeof pluginResult === 'object'
                      ? JSON.stringify(pluginResult, null, 2)
                      : String(pluginResult)
                    : `插件 ${toolCall.name} 执行完毕，但没有返回明确内容。`;
                webSocketServer.broadcast(
                  {
                    type: 'vcp_log',
                    data: {
                      tool_name: toolCall.name,
                      status: 'success',
                      content: toolResultText,
                      source: 'stream_loop_archery',
                    },
                  },
                  'VCPLog',
                );
                const pluginManifestForStream = pluginManager.getPlugin(toolCall.name);
                if (
                  pluginManifestForStream &&
                  pluginManifestForStream.webSocketPush &&
                  pluginManifestForStream.webSocketPush.enabled
                ) {
                  const wsPushMessageStream = {
                    type: pluginManifestForStream.webSocketPush.messageType || `vcp_tool_result_${toolCall.name}`,
                    data: pluginResult,
                  };
                  webSocketServer.broadcast(
                    wsPushMessageStream,
                    pluginManifestForStream.webSocketPush.targetClientType || null,
                  );
                }
                if (shouldShowVCP && !res.writableEnded) {
                  vcpInfoHandler.streamVcpInfo(res, originalBody.model, toolCall.name, 'success', pluginResult);
                }
              })
              .catch(pluginError => {
                console.error(
                  `[VCP Stream Loop ARCHERY EXECUTION ERROR] Error executing plugin ${toolCall.name}:`,
                  pluginError.message,
                );
                const toolResultText = `执行插件 ${toolCall.name} 时发生错误：${pluginError.message || '未知错误'}`;
                webSocketServer.broadcast(
                  {
                    type: 'vcp_log',
                    data: {
                      tool_name: toolCall.name,
                      status: 'error',
                      content: toolResultText,
                      source: 'stream_loop_archery_error',
                    },
                  },
                  'VCPLog',
                );
                if (shouldShowVCP && !res.writableEnded) {
                  vcpInfoHandler.streamVcpInfo(res, originalBody.model, toolCall.name, 'error', toolResultText);
                }
              });
          });

          // If there are no normal calls to wait for, the AI's turn is over.
          if (normalCalls.length === 0) {
            if (DEBUG_MODE)
              console.log('[VCP Stream Loop] Only archery calls were found. Sending final signals and exiting loop.');
            if (!res.writableEnded) {
              const finalChunkPayload = {
                id: `chatcmpl-VCP-final-stop-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: originalBody.model,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              };
              res.write(`data: ${JSON.stringify(finalChunkPayload)}\n\n`);
              res.write('data: [DONE]\n\n', () => {
                res.end();
              });
            }
            break; // Exit the VCP loop
          }

          // Process normal (non-archery) calls and wait for their results to send back to the AI
          const toolExecutionPromises = normalCalls.map(async toolCall => {
            let toolResultText; // For logs and simple text display
            let toolResultContentForAI; // For the next AI call (can be rich content)

            if (pluginManager.getPlugin(toolCall.name)) {
              try {
                if (DEBUG_MODE)
                  console.log(`[VCP Stream Loop] Executing tool: ${toolCall.name} with args:`, toolCall.args);
                const pluginResult = await pluginManager.processToolCall(toolCall.name, toolCall.args, clientIp);
                await writeDebugLog(`VCP-Stream-Result-${toolCall.name}`, {
                  args: toolCall.args,
                  result: pluginResult,
                });

                toolResultText =
                  pluginResult !== undefined && pluginResult !== null
                    ? typeof pluginResult === 'object'
                      ? JSON.stringify(pluginResult, null, 2)
                      : String(pluginResult)
                    : `插件 ${toolCall.name} 执行完毕，但没有返回明确内容。`;

                let richContentPayload = null;
                if (typeof pluginResult === 'object' && pluginResult) {
                  if (pluginResult.data && Array.isArray(pluginResult.data.content)) {
                    richContentPayload = pluginResult.data.content;
                  } else if (Array.isArray(pluginResult.content)) {
                    richContentPayload = pluginResult.content;
                  }
                }

                if (richContentPayload) {
                  toolResultContentForAI = richContentPayload;
                  const textPart = richContentPayload.find(p => p.type === 'text');
                  toolResultText = textPart
                    ? textPart.text
                    : `[Rich Content with types: ${richContentPayload.map(p => p.type).join(', ')}]`;
                } else {
                  toolResultContentForAI = [
                    { type: 'text', text: `来自工具 "${toolCall.name}" 的结果:\n${toolResultText}` },
                  ];
                }

                webSocketServer.broadcast(
                  {
                    type: 'vcp_log',
                    data: {
                      tool_name: toolCall.name,
                      status: 'success',
                      content: toolResultText,
                      source: 'stream_loop',
                    },
                  },
                  'VCPLog',
                );

                const pluginManifestForStream = pluginManager.getPlugin(toolCall.name);
                if (
                  pluginManifestForStream &&
                  pluginManifestForStream.webSocketPush &&
                  pluginManifestForStream.webSocketPush.enabled
                ) {
                  const wsPushMessageStream = {
                    type: pluginManifestForStream.webSocketPush.messageType || `vcp_tool_result_${toolCall.name}`,
                    data: pluginResult,
                  };
                  webSocketServer.broadcast(
                    wsPushMessageStream,
                    pluginManifestForStream.webSocketPush.targetClientType || null,
                  );
                  if (DEBUG_MODE)
                    console.log(`[VCP Stream Loop] WebSocket push for ${toolCall.name} (success) processed.`);
                }

                if (shouldShowVCP && !res.writableEnded) {
                  vcpInfoHandler.streamVcpInfo(res, originalBody.model, toolCall.name, 'success', pluginResult);
                }
              } catch (pluginError) {
                console.error(
                  `[VCP Stream Loop EXECUTION ERROR] Error executing plugin ${toolCall.name}:`,
                  pluginError.message,
                );
                toolResultText = `执行插件 ${toolCall.name} 时发生错误：${pluginError.message || '未知错误'}`;
                toolResultContentForAI = [
                  { type: 'text', text: `来自工具 "${toolCall.name}" 的结果:\n${toolResultText}` },
                ];
                webSocketServer.broadcast(
                  {
                    type: 'vcp_log',
                    data: {
                      tool_name: toolCall.name,
                      status: 'error',
                      content: toolResultText,
                      source: 'stream_loop_error',
                    },
                  },
                  'VCPLog',
                );
                if (shouldShowVCP && !res.writableEnded) {
                  vcpInfoHandler.streamVcpInfo(res, originalBody.model, toolCall.name, 'error', toolResultText);
                }
              }
            } else {
              toolResultText = `错误：未找到名为 "${toolCall.name}" 的插件。`;
              toolResultContentForAI = [{ type: 'text', text: toolResultText }];
              if (DEBUG_MODE) console.warn(`[VCP Stream Loop] ${toolResultText}`);
              webSocketServer.broadcast(
                {
                  type: 'vcp_log',
                  data: {
                    tool_name: toolCall.name,
                    status: 'error',
                    content: toolResultText,
                    source: 'stream_loop_not_found',
                  },
                },
                'VCPLog',
              );
              if (shouldShowVCP && !res.writableEnded) {
                vcpInfoHandler.streamVcpInfo(res, originalBody.model, toolCall.name, 'error', toolResultText);
              }
            }
            return toolResultContentForAI;
          });

          const toolResults = await Promise.all(toolExecutionPromises);
          const combinedToolResultsForAI = toolResults.flat(); // Flatten the array of content arrays
          await writeDebugLog('LogToolResultForAI-Stream', { role: 'user', content: combinedToolResultsForAI });
          currentMessagesForLoop.push({ role: 'user', content: combinedToolResultsForAI });
          if (DEBUG_MODE)
            console.log(
              '[VCP Stream Loop] Combined tool results for next AI call (first 200):',
              JSON.stringify(combinedToolResultsForAI).substring(0, 200),
            );

          // --- Make next AI call (stream: true) ---
          if (!res.writableEnded) {
            res.write('\n'); // 在下一个AI响应开始前，向客户端发送一个换行符
          }
          if (DEBUG_MODE) console.log('[VCP Stream Loop] Fetching next AI response.');
          const nextAiAPIResponse = await fetchWithRetry(
            `${apiUrl}/v1/chat/completions`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                ...(req.headers['user-agent'] && { 'User-Agent': req.headers['user-agent'] }),
                Accept: 'text/event-stream', // Ensure streaming for subsequent calls
              },
              body: JSON.stringify({ ...originalBody, messages: currentMessagesForLoop, stream: true }),
              signal: abortController.signal, // 传递中止信号
            },
            apiRetries,
            apiRetryDelay,
            DEBUG_MODE,
          );

          if (!nextAiAPIResponse.ok) {
            const errorBodyText = await nextAiAPIResponse.text();
            console.error(`[VCP Stream Loop] AI call in loop failed (${nextAiAPIResponse.status}): ${errorBodyText}`);
            if (!res.writableEnded) {
              try {
                res.write(
                  `data: ${JSON.stringify({
                    error: 'AI_CALL_FAILED_IN_LOOP',
                    status: nextAiAPIResponse.status,
                    message: errorBodyText,
                  })}\n\n`,
                );
              } catch (e) {
                /* ignore */
              }
            }
            break;
          }

          // Process the stream from the next AI call
          let nextAIResponseData = await processAIResponseStreamHelper(nextAiAPIResponse, false);
          currentAIContentForLoop = nextAIResponseData.content;
          currentAIRawDataForDiary = nextAIResponseData.raw;
          handleDiaryFromAIResponse(currentAIRawDataForDiary).catch(e =>
            console.error(`[VCP Stream Loop] Error in diary handling for depth ${recursionDepth}:`, e),
          );
          if (DEBUG_MODE)
            console.log('[VCP Stream Loop] Next AI content (first 200):', currentAIContentForLoop.substring(0, 200));

          recursionDepth++;
        }

        // After loop, check if max recursion was hit and response is still open
        if (recursionDepth >= maxRecursion && !res.writableEnded) {
          if (DEBUG_MODE) console.log('[VCP Stream Loop] Max recursion reached. Sending final signals.');
          // Construct and send the final chunk with finish_reason 'length'
          const finalChunkPayload = {
            id: `chatcmpl-VCP-final-length-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: originalBody.model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: 'length',
              },
            ],
          };
          res.write(`data: ${JSON.stringify(finalChunkPayload)}\n\n`);
          res.write('data: [DONE]\n\n', () => {
            res.end();
          });
        }
      } else {
        // Non-streaming (originalBody.stream === false)
        const firstArrayBuffer = await firstAiAPIResponse.arrayBuffer();
        const responseBuffer = Buffer.from(firstArrayBuffer);
        const aiResponseText = responseBuffer.toString('utf-8');
        // firstResponseRawDataForClientAndDiary is used by the non-streaming logic later
        firstResponseRawDataForClientAndDiary = aiResponseText;

        let fullContentFromAI = ''; // This will be populated by the non-streaming logic
        try {
          const parsedJson = JSON.parse(aiResponseText);
          fullContentFromAI = parsedJson.choices?.[0]?.message?.content || '';
        } catch (e) {
          if (DEBUG_MODE)
            console.warn(
              '[PluginCall] First AI response (non-stream) not valid JSON. Raw:',
              aiResponseText.substring(0, 200),
            );
          fullContentFromAI = aiResponseText; // Use raw text if not JSON
        }

        // --- Non-streaming VCP Loop ---
        let recursionDepth = 0;
        const maxRecursion = maxVCPLoopNonStream || 5;
        let conversationHistoryForClient = []; // To build the final response for client
        let currentAIContentForLoop = fullContentFromAI; // Start with the first AI's response content
        let currentMessagesForNonStreamLoop = originalBody.messages
          ? JSON.parse(JSON.stringify(originalBody.messages))
          : [];
        // `firstResponseRawDataForClientAndDiary` holds the raw first AI response for diary purposes.
        // Subsequent raw AI responses in the non-stream loop will also need diary handling.
        let accumulatedRawResponseDataForDiary = firstResponseRawDataForClientAndDiary;

        do {
          let anyToolProcessedInCurrentIteration = false; // Reset for each iteration of the outer AI-Tool-AI loop
          // Add the *current* AI content to the client history *before* processing it for tools
          // Add the *current* AI content to the client history *before* processing it for tools
          conversationHistoryForClient.push(currentAIContentForLoop);

          const toolRequestStartMarker = '<<<[TOOL_REQUEST]>>>';
          const toolRequestEndMarker = '<<<[END_TOOL_REQUEST]>>>';
          let toolCallsInThisAIResponse = []; // Stores {name, args} for each tool call found in currentAIContentForLoop

          let searchOffset = 0;
          while (searchOffset < currentAIContentForLoop.length) {
            const startIndex = currentAIContentForLoop.indexOf(toolRequestStartMarker, searchOffset);
            if (startIndex === -1) break; // No more start markers

            const endIndex = currentAIContentForLoop.indexOf(
              toolRequestEndMarker,
              startIndex + toolRequestStartMarker.length,
            );
            if (endIndex === -1) {
              if (DEBUG_MODE)
                console.warn('[Multi-Tool] Found TOOL_REQUEST_START but no END marker after offset', searchOffset);
              searchOffset = startIndex + toolRequestStartMarker.length; // Skip malformed start
              continue;
            }

            const requestBlockContent = currentAIContentForLoop
              .substring(startIndex + toolRequestStartMarker.length, endIndex)
              .trim();
            let parsedToolArgs = {};
            let requestedToolName = null;
            let isArchery = false;
            const paramRegex = /([\w_]+)\s*:\s*「始」([\s\S]*?)「末」\s*(?:,)?/g;
            let regexMatch;
            while ((regexMatch = paramRegex.exec(requestBlockContent)) !== null) {
              const key = regexMatch[1];
              const value = regexMatch[2].trim();
              if (key === 'tool_name') requestedToolName = value;
              else if (key === 'archery') isArchery = value === 'true' || value === 'no_reply';
              else parsedToolArgs[key] = value;
            }

            if (requestedToolName) {
              toolCallsInThisAIResponse.push({ name: requestedToolName, args: parsedToolArgs, archery: isArchery });
            } else {
              if (DEBUG_MODE)
                console.warn('[Multi-Tool] Parsed a tool request block but no tool_name found:', requestBlockContent);
            }
            searchOffset = endIndex + toolRequestEndMarker.length; // Move past the processed block
          }

          if (toolCallsInThisAIResponse.length > 0) {
            anyToolProcessedInCurrentIteration = true; // At least one tool request was found in the AI's response
            const archeryCalls = toolCallsInThisAIResponse.filter(tc => tc.archery);
            const normalCalls = toolCallsInThisAIResponse.filter(tc => !tc.archery);

            // Execute archery calls without waiting for results to be sent back to the AI
            archeryCalls.forEach(toolCall => {
              if (DEBUG_MODE)
                console.log(
                  `[Multi-Tool] Executing ARCHERY tool call (no reply): ${toolCall.name} with args:`,
                  toolCall.args,
                );
              // Fire-and-forget execution, but handle logging and notifications in then/catch
              pluginManager
                .processToolCall(toolCall.name, toolCall.args, clientIp)
                .then(async pluginResult => {
                  await writeDebugLog(`VCP-NonStream-Archery-Result-${toolCall.name}`, {
                    args: toolCall.args,
                    result: pluginResult,
                  });
                  const toolResultText =
                    pluginResult !== undefined && pluginResult !== null
                      ? typeof pluginResult === 'object'
                        ? JSON.stringify(pluginResult, null, 2)
                        : String(pluginResult)
                      : `插件 ${toolCall.name} 执行完毕，但没有返回明确内容。`;
                  webSocketServer.broadcast(
                    {
                      type: 'vcp_log',
                      data: {
                        tool_name: toolCall.name,
                        status: 'success',
                        content: toolResultText,
                        source: 'non_stream_loop_archery',
                      },
                    },
                    'VCPLog',
                  );
                  const pluginManifestNonStream = pluginManager.getPlugin(toolCall.name);
                  if (
                    pluginManifestNonStream &&
                    pluginManifestNonStream.webSocketPush &&
                    pluginManifestNonStream.webSocketPush.enabled
                  ) {
                    const wsPushMessageNonStream = {
                      type: pluginManifestNonStream.webSocketPush.messageType || `vcp_tool_result_${toolCall.name}`,
                      data: pluginResult,
                    };
                    webSocketServer.broadcast(
                      wsPushMessageNonStream,
                      pluginManifestNonStream.webSocketPush.targetClientType || null,
                    );
                  }
                  if (shouldShowVCP) {
                    const vcpText = vcpInfoHandler.streamVcpInfo(
                      null,
                      originalBody.model,
                      toolCall.name,
                      'success',
                      pluginResult,
                    );
                    if (vcpText) conversationHistoryForClient.push(vcpText);
                  }
                })
                .catch(pluginError => {
                  console.error(
                    `[Multi-Tool ARCHERY EXECUTION ERROR] Error executing plugin ${toolCall.name}:`,
                    pluginError.message,
                  );
                  const toolResultText = `执行插件 ${toolCall.name} 时发生错误：${pluginError.message || '未知错误'}`;
                  webSocketServer.broadcast(
                    {
                      type: 'vcp_log',
                      data: {
                        tool_name: toolCall.name,
                        status: 'error',
                        content: toolResultText,
                        source: 'non_stream_loop_archery_error',
                      },
                    },
                    'VCPLog',
                  );
                  if (shouldShowVCP) {
                    const vcpText = vcpInfoHandler.streamVcpInfo(
                      null,
                      originalBody.model,
                      toolCall.name,
                      'error',
                      toolResultText,
                    );
                    if (vcpText) conversationHistoryForClient.push(vcpText);
                  }
                });
            });

            // If there are no normal calls to wait for, the AI's turn is over.
            if (normalCalls.length === 0) {
              if (DEBUG_MODE) console.log('[Multi-Tool] Only archery calls were found. Exiting loop.');
              break; // Exit the do-while loop
            }

            // Add the AI's full response (that contained the tool requests) to the messages for the next AI call
            currentMessagesForNonStreamLoop.push({ role: 'assistant', content: currentAIContentForLoop });

            // Process normal (non-archery) calls and wait for their results to send back to the AI
            const toolExecutionPromises = normalCalls.map(async toolCall => {
              let toolResultText;
              let toolResultContentForAI;

              if (pluginManager.getPlugin(toolCall.name)) {
                try {
                  if (DEBUG_MODE)
                    console.log(`[Multi-Tool] Executing tool: ${toolCall.name} with args:`, toolCall.args);
                  const pluginResult = await pluginManager.processToolCall(toolCall.name, toolCall.args, clientIp);
                  await writeDebugLog(`VCP-NonStream-Result-${toolCall.name}`, {
                    args: toolCall.args,
                    result: pluginResult,
                  });

                  toolResultText =
                    pluginResult !== undefined && pluginResult !== null
                      ? typeof pluginResult === 'object'
                        ? JSON.stringify(pluginResult, null, 2)
                        : String(pluginResult)
                      : `插件 ${toolCall.name} 执行完毕，但没有返回明确内容。`;

                  let richContentPayload = null;
                  if (typeof pluginResult === 'object' && pluginResult) {
                    if (pluginResult.data && Array.isArray(pluginResult.data.content)) {
                      richContentPayload = pluginResult.data.content;
                    } else if (Array.isArray(pluginResult.content)) {
                      richContentPayload = pluginResult.content;
                    }
                  }

                  if (richContentPayload) {
                    toolResultContentForAI = richContentPayload;
                    const textPart = richContentPayload.find(p => p.type === 'text');
                    toolResultText = textPart
                      ? textPart.text
                      : `[Rich Content with types: ${richContentPayload.map(p => p.type).join(', ')}]`;
                  } else {
                    toolResultContentForAI = [
                      { type: 'text', text: `来自工具 "${toolCall.name}" 的结果:\n${toolResultText}` },
                    ];
                  }

                  webSocketServer.broadcast(
                    {
                      type: 'vcp_log',
                      data: {
                        tool_name: toolCall.name,
                        status: 'success',
                        content: toolResultText,
                        source: 'non_stream_loop',
                      },
                    },
                    'VCPLog',
                  );

                  const pluginManifestNonStream = pluginManager.getPlugin(toolCall.name);
                  if (
                    pluginManifestNonStream &&
                    pluginManifestNonStream.webSocketPush &&
                    pluginManifestNonStream.webSocketPush.enabled
                  ) {
                    const wsPushMessageNonStream = {
                      type: pluginManifestNonStream.webSocketPush.messageType || `vcp_tool_result_${toolCall.name}`,
                      data: pluginResult,
                    };
                    webSocketServer.broadcast(
                      wsPushMessageNonStream,
                      pluginManifestNonStream.webSocketPush.targetClientType || null,
                    );
                    if (DEBUG_MODE)
                      console.log(`[Multi-Tool] WebSocket push for ${toolCall.name} (success) processed.`);
                  }

                  if (shouldShowVCP) {
                    const vcpText = vcpInfoHandler.streamVcpInfo(
                      null,
                      originalBody.model,
                      toolCall.name,
                      'success',
                      pluginResult,
                    );
                    if (vcpText) conversationHistoryForClient.push(vcpText);
                  }
                } catch (pluginError) {
                  console.error(
                    `[Multi-Tool EXECUTION ERROR] Error executing plugin ${toolCall.name}:`,
                    pluginError.message,
                  );
                  toolResultText = `执行插件 ${toolCall.name} 时发生错误：${pluginError.message || '未知错误'}`;
                  toolResultContentForAI = [
                    { type: 'text', text: `来自工具 "${toolCall.name}" 的结果:\n${toolResultText}` },
                  ];
                  webSocketServer.broadcast(
                    {
                      type: 'vcp_log',
                      data: {
                        tool_name: toolCall.name,
                        status: 'error',
                        content: toolResultText,
                        source: 'non_stream_loop_error',
                      },
                    },
                    'VCPLog',
                  );
                  if (shouldShowVCP) {
                    const vcpText = vcpInfoHandler.streamVcpInfo(
                      null,
                      originalBody.model,
                      toolCall.name,
                      'error',
                      toolResultText,
                    );
                    if (vcpText) conversationHistoryForClient.push(vcpText);
                  }
                }
              } else {
                toolResultText = `错误：未找到名为 "${toolCall.name}" 的插件。`;
                toolResultContentForAI = [{ type: 'text', text: toolResultText }];
                if (DEBUG_MODE) console.warn(`[Multi-Tool] ${toolResultText}`);
                webSocketServer.broadcast(
                  {
                    type: 'vcp_log',
                    data: {
                      tool_name: toolCall.name,
                      status: 'error',
                      content: toolResultText,
                      source: 'non_stream_loop_not_found',
                    },
                  },
                  'VCPLog',
                );
                if (shouldShowVCP) {
                  const vcpText = vcpInfoHandler.streamVcpInfo(
                    null,
                    originalBody.model,
                    toolCall.name,
                    'error',
                    toolResultText,
                  );
                  if (vcpText) conversationHistoryForClient.push(vcpText);
                }
              }
              return toolResultContentForAI;
            });

            // Wait for all tool executions to complete
            const toolResults = await Promise.all(toolExecutionPromises);

            const combinedToolResultsForAI = toolResults.flat(); // Flatten the array of content arrays
            await writeDebugLog('LogToolResultForAI-NonStream', { role: 'user', content: combinedToolResultsForAI });
            currentMessagesForNonStreamLoop.push({ role: 'user', content: combinedToolResultsForAI });

            // Fetch the next AI response
            if (DEBUG_MODE) console.log('[Multi-Tool] Fetching next AI response after processing tools.');
            const recursionAiResponse = await fetchWithRetry(
              `${apiUrl}/v1/chat/completions`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${apiKey}`,
                  ...(req.headers['user-agent'] && { 'User-Agent': req.headers['user-agent'] }),
                  Accept: 'application/json',
                },
                body: JSON.stringify({ ...originalBody, messages: currentMessagesForNonStreamLoop, stream: false }),
                signal: abortController.signal, // 传递中止信号
              },
              apiRetries,
              apiRetryDelay,
              DEBUG_MODE,
            );

            if (!recursionAiResponse.ok) {
              const errorBodyText = await recursionAiResponse.text();
              console.error(`[Multi-Tool] AI call in loop failed (${recursionAiResponse.status}): ${errorBodyText}`);
              if (SHOW_VCP_OUTPUT) {
                conversationHistoryForClient.push({
                  type: 'vcp',
                  content: `AI call failed with status ${recursionAiResponse.status}: ${errorBodyText}`,
                });
              }
              // Break the loop on AI error
              break;
            }

            const recursionArrayBuffer = await recursionAiResponse.arrayBuffer();
            const recursionBuffer = Buffer.from(recursionArrayBuffer);
            const recursionText = recursionBuffer.toString('utf-8');
            // Consider appending recursionText to rawResponseDataForDiary if needed for multi-tool turn

            try {
              const recursionJson = JSON.parse(recursionText);
              currentAIContentForLoop = '\n' + (recursionJson.choices?.[0]?.message?.content || '');
            } catch (e) {
              currentAIContentForLoop = '\n' + recursionText;
            }
          } else {
            // No tool calls found in the currentAIContentForLoop, so this is the final AI response.
            anyToolProcessedInCurrentIteration = false;
          }

          // Exit the outer loop if no tools were processed in this iteration
          if (!anyToolProcessedInCurrentIteration) break;
          recursionDepth++;
        } while (recursionDepth < maxRecursion);

        // --- Finalize Non-Streaming Response ---
        const finalContentForClient = conversationHistoryForClient.join('');

        let finalJsonResponse;
        try {
          // Try to reuse the structure of the *first* AI response
          finalJsonResponse = JSON.parse(aiResponseText);
          if (
            !finalJsonResponse.choices ||
            !Array.isArray(finalJsonResponse.choices) ||
            finalJsonResponse.choices.length === 0
          ) {
            finalJsonResponse.choices = [{ message: {} }];
          }
          if (!finalJsonResponse.choices[0].message) {
            finalJsonResponse.choices[0].message = {};
          }
          // Overwrite the content with the full conversation history
          finalJsonResponse.choices[0].message.content = finalContentForClient;
          // Optionally update finish_reason if needed, e.g., if maxRecursion was hit
          if (recursionDepth >= maxRecursion) {
            finalJsonResponse.choices[0].finish_reason = 'length'; // Or 'tool_calls' if appropriate
          } else {
            finalJsonResponse.choices[0].finish_reason = 'stop'; // Assume normal stop if loop finished early
          }
        } catch (e) {
          // Fallback if the first response wasn't valid JSON
          finalJsonResponse = {
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: finalContentForClient },
                finish_reason: recursionDepth >= maxRecursion ? 'length' : 'stop',
              },
            ],
          };
        }

        if (!res.writableEnded) {
          res.send(Buffer.from(JSON.stringify(finalJsonResponse)));
        }
        // Handle diary for the *first* AI response in non-streaming mode
        await handleDiaryFromAIResponse(firstResponseRawDataForClientAndDiary);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log(`[Abort] Request ${id} was aborted by the user.`);
        if (!res.headersSent) {
          res.status(200).json({
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '请求已中止' },
                finish_reason: 'stop',
              },
            ],
          });
        } else if (!res.writableEnded) {
          res.write('data: [DONE]\n\n', () => {
            res.end();
          });
        }
        return;
      }
      // Only log full stack trace for non-abort errors
      console.error('处理请求或转发时出错:', error.message, error.stack);

      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
      } else if (!res.writableEnded) {
        console.error(
          '[STREAM ERROR] Headers already sent. Cannot send JSON error. Ending stream if not already ended.',
        );
        res.end();
      }
    } finally {
      if (id) {
        activeRequests.delete(id);
      }
    }
  }
}

module.exports = ChatCompletionHandler;
