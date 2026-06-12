// modules/handlers/nonStreamHandler.js
const vcpInfoHandler = require('../../vcpInfoHandler.js');
const roleDivider = require('../roleDivider.js');

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

    const firstArrayBuffer = await firstAiAPIResponse.arrayBuffer();
    const responseBuffer = Buffer.from(firstArrayBuffer);
    const aiResponseText = responseBuffer.toString('utf-8');
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
    const extractedMessage = (rawResponseText) => {
      try {
        const parsedJson = JSON.parse(rawResponseText);
        return parsedJson.choices?.[0]?.message;
      } catch (e) {
        return null;
      }
    };
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

          const recursionAiResponse = await fetchWithRetry(
            `${apiUrl}/v1/chat/completions`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
              body: JSON.stringify({ ...originalBody, messages: currentMessagesForNonStreamLoop, stream: false }),
              signal: abortController.signal,
            },
            { retries: apiRetries, delay: apiRetryDelay, debugMode: DEBUG_MODE, modelFallbackCandidates: semanticModelFallbackCandidates }
          );

          if (recursionAiResponse.ok) {
            const recursionArrayBuffer = await recursionAiResponse.arrayBuffer();
            const recursionBuffer = Buffer.from(recursionArrayBuffer);
            const recursionText = recursionBuffer.toString('utf-8');
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
          const statusText = isError ? '调用失败' : '调用成功';
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
          conversationHistoryForClient.push(`\n[系统提示:] 本轮工具调用状态：${toolStatusSummaryItems.join('；')}。\n`);
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

        const recursionAiResponse = await fetchWithRetry(
          `${apiUrl}/v1/chat/completions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ ...originalBody, messages: currentMessagesForNonStreamLoop, stream: false }),
            signal: abortController.signal,
          },
          { retries: apiRetries, delay: apiRetryDelay, debugMode: DEBUG_MODE, modelFallbackCandidates: semanticModelFallbackCandidates }
        );

        if (!recursionAiResponse.ok) break;

        const recursionArrayBuffer = await recursionAiResponse.arrayBuffer();
        const recursionBuffer = Buffer.from(recursionArrayBuffer);
        const recursionText = recursionBuffer.toString('utf-8');
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