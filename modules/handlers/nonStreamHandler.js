// modules/handlers/nonStreamHandler.js
const vcpInfoHandler = require('../../vcpInfoHandler.js');
const contextBudget = require('../contextBudget.js');
const finalContextStore = require('../finalContextStore.js');
const roleDivider = require('../roleDivider.js');
const { formatToolResultBatch, projectToolBatchForUpstream, buildToolPayloadMessage } = require('../toolResultBatch.js');
const { NATIVE_CALL_ID, entriesOf, admitNativeCalls, rejectionNotice, buildNativeToolMessages } = require('../nativeToolLoop');

const {
  buildClientVisibleContent,
  removeReasoningFields,
  normalizeReasoningTag,
  shouldConvertReasoningForModel
} = require('../reasoningContentAdapter.js');

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
    'thought',
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

function hasNativeToolCallPayload(message) {
  return (
    (message?.tool_calls != null && (Array.isArray(message.tool_calls) ? message.tool_calls.length > 0 : typeof message.tool_calls === 'object')) ||
    Boolean(message?.function_call && typeof message.function_call === 'object')
  );
}

function isCompleteNonStreamResponse(readResult) {
  const { parsedJson, message, choice } = parseNonStreamResponse(readResult.text);
  if (!readResult.response.ok || readResult.semanticRetryExhausted || !parsedJson || parsedJson.error || !message) {
    return false;
  }
  if (hasNativeToolCallPayload(message) &&
      ['tool_calls', 'function_call', 'stop'].includes(choice?.finish_reason)) {
    return true;
  }
  return hasVisibleContent(message.content) && choice?.finish_reason === 'stop';
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
  label = 'non_stream',
  timelineTrace
}) {
  const maxAttempts = Math.max(Number.isFinite(Number(retries)) && Number(retries) > 0 ? Math.floor(Number(retries)) : 1, 1);
  let response = initialResponse;
  let responseText = '';
  let lastReasoningOnlyText = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!response) {
      response = await fetchResponse(attempt);
    }

    const upstreamAttempt = timelineTrace?.responses.get(response);
    timelineTrace?.emit('upstream_body_read_started', { attempt: upstreamAttempt });
    let arrayBuffer;
    try {
      arrayBuffer = await response.arrayBuffer();
      timelineTrace?.emit('upstream_body_read_finished', { attempt: upstreamAttempt });
    } catch (error) {
      const code = error?.code;
      const errorCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
      timelineTrace?.emit('upstream_body_read_failed', { attempt: upstreamAttempt, errorCode });
      throw error;
    }
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
      touchRequestActivity,
      toolExecutor,
      ToolCallParser,
      abortController,
      originalBody,
      clientIp,
      _refreshRagBlocksIfNeeded,
      fetchWithRetry,
      budgetGuard,
      timelineTrace,
      vcpToolUseForbidden,
      apiConnectionTimeoutMs,
      semanticModelFallbackCandidates,
      oneRingResponseMeta,
      shouldProcessMedia,
      shouldProcessMediaPlus,
      isTextOnlyForceTranslateModel,
      requestPreprocessorConfig,
      reasoningToContentEnabled: reasoningToContentGloballyEnabled,
      reasoningToContentTag,
      reasoningToContentModels
    } = this.context;

    const shouldShowVCP = SHOW_VCP_OUTPUT || this.context.forceShowVCP;
    const reasoningToContentEnabled = shouldConvertReasoningForModel(
      originalBody.model,
      reasoningToContentGloballyEnabled,
      reasoningToContentModels
    );
    const reasoningTag = normalizeReasoningTag(reasoningToContentTag);

    const containsImageUrlPart = (content) => Array.isArray(content) &&
      content.some(part => part?.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string');

    const maybeTranslateToolPayloadMedia = async (content) => {
      if (!containsImageUrlPart(content)) return content;

      const shouldTranslateToolMedia = shouldProcessMedia || isTextOnlyForceTranslateModel;
      if (!shouldTranslateToolMedia) return content;

      const processorName = pluginManager.messagePreprocessors.has('MultiModalProcessor')
        ? 'MultiModalProcessor'
        : 'ImageProcessor';
      if (!pluginManager.messagePreprocessors.has(processorName)) {
        if (DEBUG_MODE) console.warn(`[VCP NonStream Loop] Tool payload contains image_url, but ${processorName} is unavailable. Forwarding original payload.`);
        return content;
      }

      const originalImageParts = content.filter(part => part?.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string');
      const payloadMessage = { role: 'user', content: JSON.parse(JSON.stringify(content)) };

      if (DEBUG_MODE) {
        console.log(`[VCP NonStream Loop] Translating tool-returned image_url content via ${processorName}. textOnly=${!!isTextOnlyForceTranslateModel}, plus=${!!shouldProcessMediaPlus}`);
      }

      let translatedMessages;
      try {
        translatedMessages = await pluginManager.executeMessagePreprocessor(
          processorName,
          [payloadMessage],
          requestPreprocessorConfig || {}
        );
      } catch (pluginError) {
        console.error(`[VCP NonStream Loop] Error translating tool-returned media via ${processorName}:`, pluginError);
        return content;
      }

      const translatedContent = translatedMessages?.[0]?.content;
      if (!Array.isArray(translatedContent)) return content;

      if (shouldProcessMediaPlus && !isTextOnlyForceTranslateModel) {
        const translatedWithoutImages = translatedContent.filter(part => part?.type !== 'image_url');
        return [
          ...translatedWithoutImages,
          ...JSON.parse(JSON.stringify(originalImageParts))
        ];
      }

      return translatedContent;
    };

    const fetchNonStreamCompletion = (body, label) => fetchWithRetry(
      `${apiUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(projectToolBatchForUpstream(body)),
        signal: abortController.signal,
      },
      { retries: apiRetries, delay: apiRetryDelay, debugMode: DEBUG_MODE, connectionTimeout: apiConnectionTimeoutMs, modelFallbackCandidates: semanticModelFallbackCandidates, timelineTrace }
    );

    const firstReadResult = await readNonStreamResponseWithSemanticRetry({
      initialResponse: firstAiAPIResponse,
      fetchResponse: () => fetchNonStreamCompletion(originalBody, 'initial'),
      retries: apiRetries,
      delay: apiRetryDelay,
      debugMode: DEBUG_MODE,
      label: 'initial',
      timelineTrace
    });
    firstAiAPIResponse = firstReadResult.response;
    const aiResponseText = firstReadResult.text;
    const noteUpstreamUsage = (responseText, isInitial = false) => {
      try {
        const usage = JSON.parse(responseText)?.usage;
        if (isInitial) finalContextStore.recordUpstreamUsage(originalBody.requestId || originalBody.messageId, usage);
        budgetGuard?.noteUsage(usage, isInitial ? firstAiAPIResponse?.vcpAttemptModel : undefined);
      } catch (_) { /* 非 JSON 响应没有 usage，面板保留本地估算 */ }
    };
    noteUpstreamUsage(aiResponseText, true);

    /**
     * 工具循环每次再发上游之前的预算检查。超预算时先压缩本轮之前的工具结果，
     * 仍然超则返回说明文字（调用方把它交给客户端并退出循环）；可以发送时返回 null。
     */
    const checkLoopBudget = (messages) => {
      if (!budgetGuard?.active) return null;
      const build = () => projectToolBatchForUpstream({ ...originalBody, messages, stream: false });
      let body = build();
      let check = budgetGuard.check(body, 'tool_loop', { silent: budgetGuard.enforcing });
      if (check.over && budgetGuard.enforcing) {
        let roundStartIndex = messages.length;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.role === 'assistant') { roundStartIndex = i; break; }
        }
        const slimmed = contextBudget.slimToFit(messages, roundStartIndex, () => budgetGuard.check(build(), 'tool_loop', { silent: true }).over);
        if (slimmed > 0) {
          body = build();
          const before = check.estimated;
          check = budgetGuard.check(body, 'tool_loop', { silent: true });
          console.warn(`[ContextBudget] 工具循环超预算，已压缩 ${slimmed} 条较早的工具结果: ${before} -> ${check.estimated} / ${check.limit}`);
        }
      }
      if (check.over && budgetGuard.enforcing) {
        console.warn(`[ContextBudget] 工具循环已停止: estimated=${check.estimated} limit=${check.limit}`);
        return `\n\n> [!WARNING]\n> ${contextBudget.exceededMessage(check, 'tool_loop', budgetGuard.breakdown(body))}\n`;
      }
      budgetGuard.noteRequest(body);
      return null;
    };
    let chatLogs = [];
    let oneRingAssistantTurnParts = [];
    let validUpstreamTurns = isCompleteNonStreamResponse(firstReadResult);
    let completed = false;

    let fullContentFromAI = '';
    let currentAIContentForClient = '';
    const extractedResponse = (rawResponseText) => parseNonStreamResponse(rawResponseText);
    const extractVisibleContent = (message, fallbackText = '') => {
      if (!message) return fallbackText;
      // OneRing 入库和 VCP 循环始终只使用正文 content。
      return message.content || '';
    };
    const extractClientContent = (message, fallbackText = '', choice = null) => {
      if (!message) return fallbackText;
      return buildClientVisibleContent(
        message,
        reasoningToContentEnabled,
        reasoningTag,
        choice,
        choice?.delta
      );
    };

    const initParsedResponse = extractedResponse(aiResponseText);
    const initMessage = initParsedResponse.message;
    if (initMessage) {
      fullContentFromAI = extractVisibleContent(initMessage);
      currentAIContentForClient = extractClientContent(initMessage, '', initParsedResponse.choice);
    } else {
      fullContentFromAI = aiResponseText;
      currentAIContentForClient = aiResponseText;
    }
    if (writeChatLog) chatLogs.push({ request: originalBody, response: initMessage || fullContentFromAI});
    if (fullContentFromAI && fullContentFromAI.trim()) {
      oneRingAssistantTurnParts.push(fullContentFromAI);
    }

    let recursionDepth = 0;
    const maxRecursion = maxVCPLoopNonStream || 5;
    let conversationHistoryForClient = [];
    let currentAIContentForLoop = fullContentFromAI;
    let currentParsedResponse = initParsedResponse;
    let nativeTerminalResponse = null;
    let currentMessagesForNonStreamLoop = originalBody.messages ? JSON.parse(JSON.stringify(originalBody.messages)) : [];

    do {
      // 检查中止信号并刷新非流式多轮工具循环活性时间戳
      if (abortController && abortController.signal.aborted) {
        if (DEBUG_MODE) console.log('[VCP NonStream Loop] Abort detected, exiting loop.');
        break;
      }
      touchRequestActivity?.();

      let anyToolProcessedInCurrentIteration = false;
      conversationHistoryForClient.push(currentAIContentForClient);

      const nativeMessage = currentParsedResponse.message;
      let nativeCalls = null;
      let ownedCalls = null;
      if (validUpstreamTurns && hasNativeToolCallPayload(nativeMessage)) {
        if (!this.context.ownsNativeVcpTools) {
          nativeTerminalResponse = currentParsedResponse.parsedJson;
          completed = true;
          break;
        }
        const batch = admitNativeCalls(entriesOf(nativeMessage), name => !!pluginManager?.getPlugin?.(name));
        const notice = rejectionNotice(batch, originalBody);
        if (notice) conversationHistoryForClient.push(notice);
        if (!vcpToolUseForbidden && batch.calls.length) {
          nativeCalls = batch.calls;
          ownedCalls = batch.normalized;
        } else if (vcpToolUseForbidden || !ToolCallParser.endsWithCompleteToolRequest?.(currentAIContentForLoop)) {
          completed = false;
          break;
        }
      }
      const toolCalls = vcpToolUseForbidden ? [] : ownedCalls ?? ToolCallParser.parse(currentAIContentForLoop);
      const makeAssistantMessage = () => {
        if (!ownedCalls) return { role: 'assistant', content: currentAIContentForLoop };
        const { content, reasoning_content, reasoning_details } = nativeMessage;
        return {
          role: 'assistant',
          content: content ?? null,
          tool_calls: nativeCalls,
          ...(reasoning_content != null ? { reasoning_content } : {}),
          ...(reasoning_details != null ? { reasoning_details } : {})
        };
      };

      if (toolCalls.length > 0) {
        const expandedCalls = await (toolExecutor.expandCalls?.(toolCalls) ?? toolCalls);
        if (abortController?.signal.aborted || res.destroyed || res.writableEnded) break;
        anyToolProcessedInCurrentIteration = true;
        const { normal: normalCalls, archery: archeryCalls } = ToolCallParser.separate(expandedCalls);
        const archeryReceiptGroups = [];
        const archeryStatusSummaryItems = [];
        const visibleToolResults = [];

        // 执行 Archery 调用
        const archeryLogs = await Promise.all(archeryCalls.map(async (toolCall, index) => {
          try {
            const result = await toolExecutor.execute(toolCall, clientIp, currentMessagesForNonStreamLoop);
            const isError = !result.success || (result.raw && this.context.isToolResultError(result.raw));

            if (isError) {
              archeryStatusSummaryItems.push(`${toolCall.name} 调用失败${result.recordId ? ` (记录ID: ${result.recordId})` : ''}`);
              archeryReceiptGroups[index] = { name: toolCall.name, callId: toolCall[NATIVE_CALL_ID], parts: [{
                type: 'text',
                text: `[异步工具 "${toolCall.name}" 返回了错误，请注意]:\n${result.content[0].text}`
              }] };
              const forceThisOne = !shouldShowVCP && toolCall.markHistory;
              if ((shouldShowVCP || forceThisOne) && (isError || forceThisOne)) {
                const vcpText = vcpInfoHandler.streamVcpInfo(null, originalBody.model, toolCall.name, result.success ? 'success' : 'error', result.raw || result.error, abortController);
                if (vcpText) visibleToolResults.push(vcpText);
              }
            } else if (result.approvalFeedbackContent?.length) {
              // 用户明确输入的审核留言优先于 archery 静默；业务成功状态保持不变。
              archeryReceiptGroups[index] = { name: toolCall.name, callId: toolCall[NATIVE_CALL_ID], parts: result.approvalFeedbackContent };
            }
            return { tool: toolCall, result: result.content };
          } catch (e) {
            console.error(`[NonStream Archery Error] ${toolCall.name}:`, e);
            return { tool: toolCall, result: [{ type: 'text', text: String(e.message) }] };
          }
        }));
        const archeryGroups = archeryReceiptGroups.filter(Boolean);
        const archeryErrorContents = archeryGroups.flatMap(group => group.parts);

        // 处理纯 Archery 的错误或用户审核留言。
        if (normalCalls.length === 0 && archeryErrorContents.length > 0) {
          let assistantMessages = [makeAssistantMessage()];
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

          if (ownedCalls) currentMessagesForNonStreamLoop.push(...buildNativeToolMessages(nativeCalls, archeryGroups));
          else currentMessagesForNonStreamLoop.push(await buildToolPayloadMessage(archeryGroups));

          if (archeryStatusSummaryItems.length > 0) {
            visibleToolResults.push(`\n[本轮工具调用摘要:]\n${archeryStatusSummaryItems.join('；')}。\n[本轮工具调用摘要结束]\n`);
          }
          conversationHistoryForClient.push(formatToolResultBatch(visibleToolResults, enableRoleDivider));

          const archeryBudgetNotice = checkLoopBudget(currentMessagesForNonStreamLoop);
          if (archeryBudgetNotice) {
            conversationHistoryForClient.push(archeryBudgetNotice);
            break;
          }
          const recursionBody = { ...originalBody, messages: currentMessagesForNonStreamLoop, stream: false };
          const recursionReadResult = await readNonStreamResponseWithSemanticRetry({
            fetchResponse: () => fetchNonStreamCompletion(recursionBody, `archery_error_depth_${recursionDepth}`),
            retries: apiRetries,
            delay: apiRetryDelay,
            debugMode: DEBUG_MODE,
            label: `archery_error_depth_${recursionDepth}`,
            timelineTrace
          });
          const recursionAiResponse = recursionReadResult.response;

          if (recursionAiResponse.ok) {
            validUpstreamTurns = validUpstreamTurns && isCompleteNonStreamResponse(recursionReadResult);
            const recursionText = recursionReadResult.text;
            noteUpstreamUsage(recursionText);
            const recursionParsedResponse = extractedResponse(recursionText);
            currentParsedResponse = recursionParsedResponse;
            const recursionMessage = recursionParsedResponse.message;
            if (recursionMessage) {
              currentAIContentForLoop = '\n' + extractVisibleContent(recursionMessage);
              currentAIContentForClient = '\n' + extractClientContent(recursionMessage, '', recursionParsedResponse.choice);
            } else {
              currentAIContentForLoop = '\n' + recursionText;
              currentAIContentForClient = '\n' + recursionText;
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
            recursionDepth++;
            continue;
          }
          break; // 后续上游失败，不提交交互时间。
        }

        if (normalCalls.length === 0) {
          conversationHistoryForClient.push(formatToolResultBatch(visibleToolResults, enableRoleDivider));
          completed = validUpstreamTurns && archeryErrorContents.length === 0;
          break;
        }

        // 执行普通调用
        let assistantMessages = [makeAssistantMessage()];
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

        const nonStreamActivityTimer = setInterval(() => {
          touchRequestActivity?.();
        }, 5000);
        nonStreamActivityTimer.unref?.();
        let toolResults;
        try {
          toolResults = await toolExecutor.executeAll(normalCalls, clientIp, currentMessagesForNonStreamLoop);
        } finally {
          clearInterval(nonStreamActivityTimer);
          touchRequestActivity?.();
        }
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
        const toolStatusSummaryItems = [...archeryStatusSummaryItems];
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
          toolStatusSummaryItems.push(`${toolCall.name} ${statusText}${result?.recordId ? ` (记录ID: ${result.recordId})` : ''}`);

          if (shouldShowVCP || forceThisOne) {
            const vcpText = vcpInfoHandler.streamVcpInfo(null, originalBody.model, toolCall.name, result.success ? 'success' : 'error', result.raw || result.error, abortController);
            if (vcpText) visibleToolResults.push(vcpText);
          }
        }

        if (toolStatusSummaryItems.length > 0) {
          visibleToolResults.push(`\n[本轮工具调用摘要:]\n${toolStatusSummaryItems.join('；')}。\n[本轮工具调用摘要结束]\n`);
        }
        conversationHistoryForClient.push(formatToolResultBatch(visibleToolResults, enableRoleDivider));

        // RAG 保留原表示，与发给模型的内容块分开。
        if (RAGMemoRefresh) {
          const toolResultsTextForRAG = JSON.stringify([
            ...toolResults.flatMap(result => result.content), ...archeryErrorContents
          ], (k, v) =>
            (k === 'url' || k === 'image_url') && typeof v === 'string' && v.startsWith('data:') ? "[Omitted]" : v
          );
          currentMessagesForNonStreamLoop = await _refreshRagBlocksIfNeeded(currentMessagesForNonStreamLoop, {
            lastAiMessage: currentAIContentForLoop,
            toolResultsText: toolResultsTextForRAG
          }, pluginManager, DEBUG_MODE);
        }

        const modelResultGroups = [
          ...toolResults.map((result, index) => ({
            name: normalCalls[index]?.name,
            callId: normalCalls[index]?.[NATIVE_CALL_ID],
            parts: result.contentForAI ?? result.content
          })),
          ...archeryGroups
        ];
        if (ownedCalls) currentMessagesForNonStreamLoop.push(...buildNativeToolMessages(nativeCalls, modelResultGroups));
        else currentMessagesForNonStreamLoop.push(await buildToolPayloadMessage(modelResultGroups, maybeTranslateToolPayloadMedia));

        const loopBudgetNotice = checkLoopBudget(currentMessagesForNonStreamLoop);
        if (loopBudgetNotice) {
          conversationHistoryForClient.push(loopBudgetNotice);
          break;
        }
        const recursionBody = { ...originalBody, messages: currentMessagesForNonStreamLoop, stream: false };
        const recursionReadResult = await readNonStreamResponseWithSemanticRetry({
          fetchResponse: () => fetchNonStreamCompletion(recursionBody, `tool_loop_depth_${recursionDepth}`),
          retries: apiRetries,
          delay: apiRetryDelay,
          debugMode: DEBUG_MODE,
          label: `tool_loop_depth_${recursionDepth}`,
          timelineTrace
        });
        const recursionAiResponse = recursionReadResult.response;

        if (!recursionAiResponse.ok) break;

        validUpstreamTurns = validUpstreamTurns && isCompleteNonStreamResponse(recursionReadResult);
        const recursionText = recursionReadResult.text;
        noteUpstreamUsage(recursionText);
        const recursionParsedResponse = extractedResponse(recursionText);
        currentParsedResponse = recursionParsedResponse;
        const recursionMessage = recursionParsedResponse.message;
        if (recursionMessage) {
          currentAIContentForLoop = '\n' + extractVisibleContent(recursionMessage);
          currentAIContentForClient = '\n' + extractClientContent(recursionMessage, '', recursionParsedResponse.choice);
        } else {
          currentAIContentForLoop = '\n' + recursionText;
          currentAIContentForClient = '\n' + recursionText;
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

      } else {
        anyToolProcessedInCurrentIteration = false;
        completed = validUpstreamTurns;
      }

      if (!anyToolProcessedInCurrentIteration) break;
      recursionDepth++;
    } while (recursionDepth < maxRecursion && !(abortController && abortController.signal.aborted));

    const finalContentForClient = conversationHistoryForClient.join('');
    let finalJsonResponse;
    try {
      finalJsonResponse = nativeTerminalResponse || JSON.parse(aiResponseText);

      const choice0 = finalJsonResponse.choices?.[0];
      const msg0 = choice0?.message;
      const preserveNativeToolTurn = nativeTerminalResponse !== null;

      if (!msg0) {
        finalJsonResponse.choices = [{ message: { content: finalContentForClient } }];
        finalJsonResponse.choices[0].finish_reason = recursionDepth >= maxRecursion ? 'length' : 'stop';
      } else {
        if (!preserveNativeToolTurn) {
          delete msg0.tool_calls;
          delete msg0.function_call;
        }
        if (!preserveNativeToolTurn || finalContentForClient.trim().length > 0 || msg0.content !== null) {
          msg0.content = finalContentForClient;
        }
        if (reasoningToContentEnabled) {
          removeReasoningFields(msg0);
          removeReasoningFields(choice0);
        }
        if (recursionDepth >= maxRecursion) {
          choice0.finish_reason = 'length';
        } else if (preserveNativeToolTurn && ['tool_calls', 'function_call'].includes(choice0.finish_reason)) {
          // Keep native tool termination reason intact for downstream tool-calling clients.
        } else if (preserveNativeToolTurn) {
          choice0.finish_reason = msg0.function_call && !msg0.tool_calls ? 'function_call' : 'tool_calls';
        } else {
          choice0.finish_reason = 'stop';
        }
      }
    } catch (e) {
      finalJsonResponse = {
        choices: [{ index: 0, message: { role: 'assistant', content: finalContentForClient }, finish_reason: recursionDepth >= maxRecursion ? 'length' : 'stop' }]
      };
    }

    if (writeChatLog) writeChatLog(originalBody, chatLogs);
    // OneRing 由主流程在整轮完成且响应发送完成后提交。
    if (!res.writableEnded && !res.destroyed) {
      res.send(Buffer.from(JSON.stringify(finalJsonResponse)));
    }
    return {
      completed: completed && !abortController?.signal.aborted && !res.destroyed,
      aiText: oneRingAssistantTurnParts.join('\n')
    };
  }
}

module.exports = NonStreamHandler;