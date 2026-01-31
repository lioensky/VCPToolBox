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
      fetchWithRetry
    } = this.context;

    const shouldShowVCP = SHOW_VCP_OUTPUT || this.context.forceShowVCP;

    const firstArrayBuffer = await firstAiAPIResponse.arrayBuffer();
    const responseBuffer = Buffer.from(firstArrayBuffer);
    const aiResponseText = responseBuffer.toString('utf-8');
    let firstResponseRawDataForClientAndDiary = aiResponseText;

    let fullContentFromAI = '';
    try {
      const parsedJson = JSON.parse(aiResponseText);
      const message = parsedJson.choices?.[0]?.message;
      if (message) {
        // 同时收集推理内容和普通内容
        fullContentFromAI = (message.reasoning_content || '') + (message.content || '');
      } else {
        fullContentFromAI = '';
      }
    } catch (e) {
      fullContentFromAI = aiResponseText;
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

      const toolCalls = ToolCallParser.parse(currentAIContentForLoop);

      if (toolCalls.length > 0) {
        anyToolProcessedInCurrentIteration = true;
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
              const forceThisOne = !shouldShowVCP && toolCall.markHistory;
              if ((shouldShowVCP || forceThisOne) && (isError || forceThisOne)) {
                const vcpText = vcpInfoHandler.streamVcpInfo(null, originalBody.model, toolCall.name, result.success ? 'success' : 'error', result.raw || result.error, abortController);
                if (vcpText) conversationHistoryForClient.push(vcpText);
              }
            }
          } catch (e) {
            console.error(`[NonStream Archery Error] ${toolCall.name}:`, e);
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
            { retries: apiRetries, delay: apiRetryDelay, debugMode: DEBUG_MODE }
          );
          
          if (recursionAiResponse.ok) {
            const recursionArrayBuffer = await recursionAiResponse.arrayBuffer();
            const recursionBuffer = Buffer.from(recursionArrayBuffer);
            const recursionText = recursionBuffer.toString('utf-8');
            try {
              const recursionJson = JSON.parse(recursionText);
              currentAIContentForLoop = '\n' + (recursionJson.choices?.[0]?.message?.content || '');
            } catch (e) {
              currentAIContentForLoop = '\n' + recursionText;
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

        const toolResults = await toolExecutor.executeAll(normalCalls, clientIp);
        const combinedToolResultsForAI = toolResults.map(r => r.content).flat();
        if (archeryErrorContents.length > 0) combinedToolResultsForAI.push(...archeryErrorContents);

        // VCP 信息展示
        for (let i = 0; i < normalCalls.length; i++) {
          const toolCall = normalCalls[i];
          const result = toolResults[i];
          const forceThisOne = !shouldShowVCP && toolCall.markHistory;
          
          if (shouldShowVCP || forceThisOne) {
            const vcpText = vcpInfoHandler.streamVcpInfo(null, originalBody.model, toolCall.name, result.success ? 'success' : 'error', result.raw || result.error, abortController);
            if (vcpText) conversationHistoryForClient.push(vcpText);
          }
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
          { retries: apiRetries, delay: apiRetryDelay, debugMode: DEBUG_MODE }
        );

        if (!recursionAiResponse.ok) break;

        const recursionArrayBuffer = await recursionAiResponse.arrayBuffer();
        const recursionBuffer = Buffer.from(recursionArrayBuffer);
        const recursionText = recursionBuffer.toString('utf-8');
        try {
          const recursionJson = JSON.parse(recursionText);
          currentAIContentForLoop = '\n' + (recursionJson.choices?.[0]?.message?.content || '');
        } catch (e) {
          currentAIContentForLoop = '\n' + recursionText;
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

    if (!res.writableEnded && !res.destroyed) {
      res.send(Buffer.from(JSON.stringify(finalJsonResponse)));
    }
    await handleDiaryFromAIResponse(firstResponseRawDataForClientAndDiary);
  }
}

module.exports = NonStreamHandler;