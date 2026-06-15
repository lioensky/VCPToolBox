// modules/handlers/nonStreamHandler.js
const vcpInfoHandler = require('../../vcpInfoHandler.js');
const roleDivider = require('../roleDivider.js');

function hasVisibleContent(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some(part => {
      if (typeof part === 'string') return part.trim().length > 0;
      if (part?.type === 'text' && typeof part.text === 'string') return part.text.trim().length > 0;
      return false;
    });
  }
  return content !== undefined && content !== null && String(content).trim().length > 0;
}

function hasReasoningOnlySignal(message, choice) {
  const reasoningKeys = [
    'reasoning_content',
    'reasoning',
    'reasoning_details',
    'thoughts',
    'thinking',
    'reasoning_text'
  ];

  const hasReasoningField = (obj) => obj && typeof obj === 'object' && reasoningKeys.some(key => hasVisibleContent(obj[key]));
  return hasReasoningField(message) || hasReasoningField(choice) || hasReasoningField(choice?.delta);
}

function hasToolOrRefusalPayload(message) {
  return (
    (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) ||
    (message?.function_call && typeof message.function_call === 'object') ||
    hasVisibleContent(message?.refusal)
  );
}

function parseNonStreamResponse(rawResponseText) {
  try {
    const parsedJson = JSON.parse(rawResponseText);
    return {
      parsedJson,
      message: parsedJson.choices?.[0]?.message || null,
      choice: parsedJson.choices?.[0] || null
    };
  } catch (e) {
    return { parsedJson: null, message: null, choice: null };
  }
}

function isReasoningOnlyNonStreamResponse(rawResponseText) {
  const { parsedJson, message, choice } = parseNonStreamResponse(rawResponseText);
  if (!parsedJson || !message || hasToolOrRefusalPayload(message)) return false;
  return !hasVisibleContent(message.content) && hasReasoningOnlySignal(message, choice);
}

async function readNonStreamResponseWithSemanticRetry({
  initialResponse = null,
  fetchResponse,
  retries = 3,
  delay = 1000,
  debugMode = false,
  label = 'non_stream'
}) {
  const maxAttempts = Math.max(Number.isFinite(Number(retries)) && Number(retries) > 0 ? Math.floor(Number(retries)) : 1, 1);
  let response = initialResponse;
  let responseText = '';
  let lastReasoningOnlyText = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!response) {
      response = await fetchResponse(attempt);
    }

    const arrayBuffer = await response.arrayBuffer();
    responseText = Buffer.from(arrayBuffer).toString('utf-8');

    if (!response.ok || !isReasoningOnlyNonStreamResponse(responseText)) {
      return {
        response,
        text: responseText,
        semanticRetryTriggered: attempt > 0,
        semanticRetryExhausted: false
      };
    }

    lastReasoningOnlyText = responseText;
    if (attempt >= maxAttempts - 1) {
      if (debugMode) {
        console.warn(`[NonStream Semantic Retry] ${label}: reasoning-only response detected, but semantic retries are exhausted. Returning last response.`);
      }
      return {
        response,
        text: lastReasoningOnlyText,
        semanticRetryTriggered: true,
        semanticRetryExhausted: true
      };
    }

    const currentDelay = delay * (attempt + 1);
    if (debugMode) {
      console.warn(`[NonStream Semantic Retry] ${label}: upstream returned reasoning-only response without visible content. Retrying in ${currentDelay}ms... (${attempt + 1}/${maxAttempts})`);
    }
    await new Promise(resolve => setTimeout(resolve, currentDelay));
    response = null;
  }

  return {
    response,
    text: responseText || lastReasoningOnlyText,
    semanticRetryTriggered: true,
    semanticRetryExhausted: true
  };
}

class NonStreamHandler {
  constructor(context) {
    this.context = context;
    this.config = context;
  }

  async handle(req, res, firstAiAPIResponse) {
    const {
      apiUrl,
      apiKey,
      pluginManager,
      writeDebugLog,
      writeChatLog,
      handleDiaryFromAIResponse,
      DEBUG_MODE,
      SHOW_VCP_OUTPUT,
      maxVCPLoopNonStream,
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
      fetchWithRetry,
      vcpToolUseForbidden,
      semanticModelFallbackCandidates,
      oneRingResponseMeta
    } = this.context;

    const shouldShowVCP = SHOW_VCP_OUTPUT || this.context.forceShowVCP;

    const fetchNonStreamCompletion = (body, label) => fetchWithRetry(
      `${apiUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: abortController.signal,
      },
      { retries: apiRetries, delay: apiRetryDelay, debugMode: DEBUG_MODE, modelFallbackCandidates: semanticModelFallbackCandidates }
    );

    const firstReadResult = await readNonStreamResponseWithSemanticRetry({
      initialResponse: firstAiAPIResponse,
      fetchResponse: () => fetchNonStreamCompletion(originalBody, 'initial'),
      retries: apiRetries,
      delay: apiRetryDelay,
      debugMode: DEBUG_MODE,
      label: 'initial'
    });
    firstAiAPIResponse = firstReadResult.response;
    const aiResponseText = firstReadResult.text;
    let firstResponseRawDataForClientAndDiary = aiResponseText;
    let chatLogs = [];
    let oneRingAssistantTurnParts = [];

    const recordOneRingAIResponse = (aiText, phaseLabel) => {
      const oneRingModule = pluginManager?.messagePreprocessors?.get?.('OneRing');
      if (!oneRingModule) return;

      const recordPromise = oneRingResponseMeta && typeof oneRingModule.recordAIResponseWithMeta === 'function'
        ? oneRingModule.recordAIResponseWithMeta(oneRingResponseMeta, aiText)
        : (typeof oneRingModule.recordAIResponseFromMessages === 'function'
          ? oneRingModule.recordAIResponseFromMessages(originalBody.messages, aiText)
          : null);

      if (recordPromise && typeof recordPromise.catch === 'function') {
        recordPromise.catch(e =>
          console.error(`[OneRing NonStream] Error recording AI response (${phaseLabel}):`, e),
        );
      }
    };

    let fullContentFromAI = '';
    const extractedMessage = (rawResponseText) => parseNonStreamResponse(rawResponseText).message;
    const extractVisibleContent = (message, fallbackText = '') => {
      if (!message) return fallbackText;
      // P0 安全修复：OneRing 入库和 VCP 循环只使用可见正文 content。
      // reasoning_content 只能作为调试/日志字段存在，不能进入持久化上下文。
      return message.content || '';
    };

    const initMessage = extractedMessage(aiResponseText);
    if (initMessage) {
      fullContentFromAI = extractVisibleContent(initMessage);
    } else {
      fullContentFromAI = aiResponseText;
    }
    if (writeChatLog) chatLogs.push({ request: originalBody, response: initMessage || fullContentFromAI});
    if (fullContentFromAI && fullContentFromAI.trim()) {
      oneRingAssistantTurnParts.push(fullContentFromAI);
    }

    let recursionDepth = 0;
    const maxRecursion = maxVCPLoopNonStream || 5;
    let conversationHistoryForClient = [];
    let currentAIContentForLoop = fullContentFromAI;
    let currentMessagesForNonStreamLoop = originalBody.messages ? JSON.parse(JSON.stringify(originalBody.messages)) : [];

    do {
      // 检查中止信号
      if (abortController && abortController.signal.aborted) {
        if (DEBUG_MODE) console.log('[VCP NonStream Loop] Abort detected, exiting loop.');
        break;
      }

      let anyToolProcessedInCurrentIteration = false;
      conversationHistoryForClient.push(currentAIContentForLoop);

      const toolCalls = vcpToolUseForbidden ? [] : ToolCallParser.parse(currentAIContentForLoop);

      if (toolCalls.length > 0) {
        anyToolProcessedInCurrentIteration = true;
        const { normal: normalCalls, archery: archeryCalls } = ToolCallParser.separate(toolCalls);
        const archeryErrorContents = [];

        // 执行 Archery 调用
        const archeryLogs = await Promise.all(archeryCalls.map(async toolCall => {
          try {
            const result = await toolExecutor.execute(toolCall, clientIp, currentMessagesForNonStreamLoop);
            const isError = !result.success || (result.raw && this.context.isToolResultError(result.raw));

            if (isError) {
              archeryErrorContents.push({
                type: 'text',
                text: `[异步工具 "${toolCall.name}" 返回了错误，请注意]:\n${result.content[0].text}`
              });
              const forceThisOne = !shouldShowVCP && toolCall.markHistory;
              if ((shouldShowVCP || forceThisOne) && (isError || forceThisOne)) {
                const vcpText = vcpInfoHandler.streamVcpInfo(null, originalBody.model, toolCall.name, result.success ? 'success' : 'error', result.raw || result.error, abortController);
                if (vcpText) conversationHistoryForClient.push(vcpText);
              }
            }
            return { tool: toolCall, result: result.content };
          } catch (e) {
            console.error(`[NonStream Archery Error] ${toolCall.name}:`, e);
            return { tool: toolCall, result: [{ type: 'text', text: String(e.message) }] };
          }
        }));

        // 处理纯 Archery 且有错误的情况
        if (normalCalls.length === 0 && archeryErrorContents.length > 0) {
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
          currentMessagesForNonStreamLoop.push(...assistantMessages);

          const errorPayload = `<!-- VCP_TOOL_PAYLOAD -->\n${JSON.stringify(archeryErrorContents)}`;
          currentMessagesForNonStreamLoop.push({ role: 'user', content: errorPayload });

          const recursionBody = { ...originalBody, messages: currentMessagesForNonStreamLoop, stream: false };
          const recursionReadResult = await readNonStreamResponseWithSemanticRetry({
            fetchResponse: () => fetchNonStreamCompletion(recursionBody, `archery_error_depth_${recursionDepth}`),
            retries: apiRetries,
            delay: apiRetryDelay,
            debugMode: DEBUG_MODE,
            label: `archery_error_depth_${recursionDepth}`
          });
          const recursionAiResponse = recursionReadResult.response;

          if (recursionAiResponse.ok) {
            const recursionText = recursionReadResult.text;
            const recursionMessage = extractedMessage(recursionText);
            if (recursionMessage) {
              currentAIContentForLoop = '\n' + extractVisibleContent(recursionMessage);
            } else {
              currentAIContentForLoop = '\n' + recursionText;
            }
            if (currentAIContentForLoop && currentAIContentForLoop.trim()) {
              oneRingAssistantTurnParts.push(currentAIContentForLoop);
            }
            if (writeChatLog) {
              chatLogs.push({
                request: currentMessagesForNonStreamLoop,
                toolCalls: archeryLogs,
                response: recursionMessage || recursionText,
              });
            }
            // 记录日志
            handleDiaryFromAIResponse(recursionText).catch(e =>
              console.error(`[VCP NonStream Loop] Error in diary handling for depth ${recursionDepth}:`, e),
            );

            recursionDepth++;
            continue;
          }
        }

        if (normalCalls.length === 0) break;

        // 执行普通调用
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
        currentMessagesForNonStreamLoop.push(...assistantMessages);

        const toolResults = await toolExecutor.executeAll(normalCalls, clientIp, currentMessagesForNonStreamLoop);
        const normalCallLogs = (() => {
          let logs = [];
          if (writeChatLog) {
            for (let i = 0; i < normalCalls.length; i++) {
              logs.push({ tool: normalCalls[i], result: toolResults[i]?.content });
            }
          }
          return logs;
        })();
        const combinedToolResultsForAI = toolResults.map(r => r.content).flat();
        if (archeryErrorContents.length > 0) combinedToolResultsForAI.push(...archeryErrorContents);

        // VCP 信息展示 - 批量包裹为单个 USER 角色
        let hasStartedUserBlock = false;
        const toolStatusSummaryItems = [];
        for (let i = 0; i < normalCalls.length; i++) {
          const toolCall = normalCalls[i];
          const result = toolResults[i];
          const forceThisOne = !shouldShowVCP && toolCall.markHistory;
          const isError = !result?.success || (result?.raw && this.context.isToolResultError(result.raw));
          const rawObject = result?.raw && typeof result.raw === 'object' ? result.raw : null;
          const errorText = isError ? [
            result?.error,
            result?.raw,
            ...(Array.isArray(result?.content) ? result.content.map(item => item?.text) : [])
          ].filter(Boolean).map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n') : '';

          // 摘要状态顺序：先由 isError/结构化 success 确定成败；只有失败时才进一步细分“拒绝”，最后再判超时。
          const isRejected = isError && (
            rawObject?.rejected_by_user === true ||
            rawObject?.error_type === 'approval_rejected' ||
            /manual\s*approval\s*was\s*rejected|rejected\s*by\s*user|approval\s*rejected|用户拒绝|人工审核.*拒绝/i.test(errorText)
          );
          const isTimeout = isError && !isRejected && /超时|timeout|timed\s*out|DIRECT_TOOL_TIMEOUT|TIMEOUT/i.test(errorText);
          const statusText = isRejected ? '调用拒绝' : (isTimeout ? '调用超时' : (isError ? '调用失败' : '调用成功'));
          toolStatusSummaryItems.push(`${toolCall.name} ${statusText}`);

          if (shouldShowVCP || forceThisOne) {
            const vcpText = vcpInfoHandler.streamVcpInfo(null, originalBody.model, toolCall.name, result.success ? 'success' : 'error', result.raw || result.error, abortController);
            if (vcpText) {
              if (!hasStartedUserBlock && enableRoleDivider) {
                conversationHistoryForClient.push('\n<<<[ROLE_DIVIDE_USER]>>>\n');
                hasStartedUserBlock = true;
              }
              conversationHistoryForClient.push(vcpText);
            }
          }
        }

        if (toolStatusSummaryItems.length > 0) {
          if (!hasStartedUserBlock && enableRoleDivider) {
            conversationHistoryForClient.push('\n<<<[ROLE_DIVIDE_USER]>>>\n');
            hasStartedUserBlock = true;
          }
          conversationHistoryForClient.push(`\n[本轮工具调用摘要:]\n${toolStatusSummaryItems.join('；')}。\n[本轮工具调用摘要结束]\n`);
        }
        
        if (hasStartedUserBlock && enableRoleDivider) {
           conversationHistoryForClient.push('\n<<<[END_ROLE_DIVIDE_USER]>>>\n');
        }

        const toolResultsTextForRAG = JSON.stringify(combinedToolResultsForAI, (k, v) =>
          (k === 'url' || k === 'image_url') && typeof v === 'string' && v.startsWith('data:') ? "[Omitted]" : v
        );

        if (RAGMemoRefresh) {
          currentMessagesForNonStreamLoop = await _refreshRagBlocksIfNeeded(currentMessagesForNonStreamLoop, {
            lastAiMessage: currentAIContentForLoop,
            toolResultsText: toolResultsTextForRAG
          }, pluginManager, DEBUG_MODE);
        }

        const hasImage = combinedToolResultsForAI.some(item => item.type === 'image_url');
        const finalToolPayloadForAI = hasImage
          ? [{ type: 'text', text: `<!-- VCP_TOOL_PAYLOAD -->\nResults:` }, ...combinedToolResultsForAI]
          : `<!-- VCP_TOOL_PAYLOAD -->\n${toolResultsTextForRAG}`;

        currentMessagesForNonStreamLoop.push({ role: 'user', content: finalToolPayloadForAI });

        const recursionBody = { ...originalBody, messages: currentMessagesForNonStreamLoop, stream: false };
        const recursionReadResult = await readNonStreamResponseWithSemanticRetry({
          fetchResponse: () => fetchNonStreamCompletion(recursionBody, `tool_loop_depth_${recursionDepth}`),
          retries: apiRetries,
          delay: apiRetryDelay,
          debugMode: DEBUG_MODE,
          label: `tool_loop_depth_${recursionDepth}`
        });
        const recursionAiResponse = recursionReadResult.response;

        if (!recursionAiResponse.ok) break;

        const recursionText = recursionReadResult.text;
        const recursionMessage = extractedMessage(recursionText);
        if (recursionMessage) {
          currentAIContentForLoop = '\n' + extractVisibleContent(recursionMessage);
        } else {
          currentAIContentForLoop = '\n' + recursionText;
        }
        if (currentAIContentForLoop && currentAIContentForLoop.trim()) {
          oneRingAssistantTurnParts.push(currentAIContentForLoop);
        }
        if (writeChatLog) {
          chatLogs.push({
            request: currentMessagesForNonStreamLoop,
            toolCalls: [ ...archeryLogs, ...normalCallLogs ],
            response: recursionMessage || recursionText,
          });
        }

        // 记录日志
        handleDiaryFromAIResponse(recursionText).catch(e =>
          console.error(`[VCP NonStream Loop] Error in diary handling for depth ${recursionDepth}:`, e),
        );
      } else {
        anyToolProcessedInCurrentIteration = false;
      }

      if (!anyToolProcessedInCurrentIteration) break;
      recursionDepth++;
    } while (recursionDepth < maxRecursion && !(abortController && abortController.signal.aborted));

    const finalContentForClient = conversationHistoryForClient.join('');
    let finalJsonResponse;
    try {
      finalJsonResponse = JSON.parse(aiResponseText);
      if (!finalJsonResponse.choices?.[0]?.message) {
        finalJsonResponse.choices = [{ message: { content: finalContentForClient } }];
      } else {
        finalJsonResponse.choices[0].message.content = finalContentForClient;
      }
      finalJsonResponse.choices[0].finish_reason = recursionDepth >= maxRecursion ? 'length' : 'stop';
    } catch (e) {
      finalJsonResponse = {
        choices: [{ index: 0, message: { role: 'assistant', content: finalContentForClient }, finish_reason: recursionDepth >= maxRecursion ? 'length' : 'stop' }]
      };
    }

    if (writeChatLog) writeChatLog(originalBody, chatLogs);
    recordOneRingAIResponse(oneRingAssistantTurnParts.join('\n'), 'final_turn');
    if (!res.writableEnded && !res.destroyed) {
      res.send(Buffer.from(JSON.stringify(finalJsonResponse)));
    }
    await handleDiaryFromAIResponse(firstResponseRawDataForClientAndDiary);
  }
}

module.exports = NonStreamHandler;