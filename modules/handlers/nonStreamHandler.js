// modules/handlers/nonStreamHandler.js
const vcpInfoHandler = require('../../vcpInfoHandler.js');
const contextBudget = require('../contextBudget.js');
const finalContextStore = require('../finalContextStore.js');
const roleDivider = require('../roleDivider.js');
const { formatToolResultBatch, projectToolBatchForUpstream, buildToolPayloadMessage } = require('../toolResultBatch.js');
const { NATIVE_CALL_ID, normalizeNativeVcpCalls, buildNativeToolMessages } = require('../nativeToolLoop');
const protocolResilience = require('../vcpProtocolResilience');
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
    (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) ||
    Boolean(message?.function_call && typeof message.function_call === 'object')
  );
}

function isMalformedFunctionCallWithoutNativeTools(choice, message) {
  if (!(protocolResilience && protocolResilience.ENABLED)) return false;
  const fr = String(choice?.finish_reason || '').trim().toLowerCase();
  const nfr = String(choice?.native_finish_reason || '').trim().toLowerCase();
  return (fr === 'malformed_function_call' || nfr === 'malformed_function_call') && !hasNativeToolCallPayload(message);
}

function appendUnclosedMixedBatchNote(msg) {
  if (!msg) return msg;
  const note = protocolResilience.UNCLOSED_MIXED_BATCH_NOTE;
  if (Array.isArray(msg.content)) {
    return { ...msg, content: [...msg.content, { type: 'text', text: `\n\n${note}` }] };
  }
  if (typeof msg.content === 'string') {
    const footer = '\n<!-- VCP_TOOL_PAYLOAD_END -->';
    if (msg.content.endsWith(footer)) {
      return { ...msg, content: msg.content.slice(0, -footer.length) + `\n\n${note}` + footer };
    }
    return { ...msg, content: msg.content + `\n\n${note}` };
  }
  return msg;
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
    const id = originalBody?.requestId || originalBody?.messageId;
    const reasoningToContentEnabled = shouldConvertReasoningForModel(
      originalBody?.model,
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
    const isInitEligible = Boolean(
      firstReadResult.response?.ok &&
      !firstReadResult.semanticRetryExhausted &&
      initParsedResponse?.parsedJson &&
      !initParsedResponse.parsedJson.error &&
      initMessage &&
      hasVisibleContent(initMessage.content) &&
      !isMalformedFunctionCallWithoutNativeTools(initParsedResponse.choice, initMessage)
    );

    if (initMessage) {
      fullContentFromAI = extractVisibleContent(initMessage);
      currentAIContentForClient = extractClientContent(initMessage, '', initParsedResponse.choice);
    } else {
      fullContentFromAI = aiResponseText;
      currentAIContentForClient = aiResponseText;
    }
    if (writeChatLog) chatLogs.push({ request: originalBody, response: initMessage || fullContentFromAI});

    let recursionDepth = 0;
    const maxRecursion = maxVCPLoopNonStream || 5;
    const roleDividerAllowedForResilience =
      enableRoleDivider !== false &&
      roleDividerSwitches?.user !== false &&
      roleDividerScanSwitches?.assistant !== false;
    const fuzzyToolMatching = protocolResilience.resolveFuzzyMatching({
      ...(this.context?.fuzzyToolMatching !== undefined ? { fuzzyToolMatching: this.context.fuzzyToolMatching } : {})
    });
    let unclosedRetryCount = 0;
    let conversationHistoryForClient = [];
    let currentAIContentForLoop = fullContentFromAI;
    let currentParsedResponse = initParsedResponse;
    let nativeTerminalResponse = null;
    let currentMessagesForNonStreamLoop = originalBody?.messages ? JSON.parse(JSON.stringify(originalBody.messages)) : [];
    let currentMessage = initParsedResponse.message;
    let currentChoice = initParsedResponse.choice;
    let currentParsedJson = initParsedResponse.parsedJson;
    let activeBaseResponseText = aiResponseText;
    let currentTurnHasLeadingNewline = false;
    let isCurrentTurnEligible = isInitEligible;
    let hasPendingClientContent = true;
    let hasPendingOneRingPart = false;
    if (protocolResilience && protocolResilience.ENABLED) {
      hasPendingOneRingPart = Boolean(fullContentFromAI && fullContentFromAI.trim());
    } else if (fullContentFromAI && fullContentFromAI.trim()) {
      oneRingAssistantTurnParts.push(fullContentFromAI);
    }
    let hitMaxRecursionTruncation = false;

    const rebuildClientContentAfterStrip = (cleanContent) => {
      if (!currentMessage) return cleanContent;
      const clientPrefix = currentTurnHasLeadingNewline && cleanContent.startsWith('\n') ? '\n' : '';
      const cleanRawBody = clientPrefix ? cleanContent.slice(1) : cleanContent;
      return clientPrefix + extractClientContent({ ...currentMessage, content: cleanRawBody }, '', currentChoice);
    };

    do {
      // 检查中止信号并刷新非流式多轮工具循环活性时间戳
      if (abortController && abortController.signal.aborted) {
        if (DEBUG_MODE) console.log('[VCP NonStream Loop] Abort detected, exiting loop.');
        break;
      }
      touchRequestActivity?.();

      let anyToolProcessedInCurrentIteration = false;

      const nativeMessage = currentParsedResponse?.message || currentMessage;
      let nativeCalls = null;
      let ownedCalls = null;
      if (validUpstreamTurns && hasNativeToolCallPayload(nativeMessage)) {
        if (!this.context.ownsNativeVcpTools) {
          conversationHistoryForClient.push(currentAIContentForClient);
          hasPendingClientContent = false;
          if (hasPendingOneRingPart) {
            oneRingAssistantTurnParts.push(currentAIContentForLoop);
            hasPendingOneRingPart = false;
          }
          nativeTerminalResponse = currentParsedResponse.parsedJson;
          completed = true;
          break;
        }
        nativeCalls = nativeMessage.tool_calls;
        ownedCalls = !vcpToolUseForbidden && !nativeMessage.function_call && normalizeNativeVcpCalls(nativeCalls);
        if (!ownedCalls) {
          conversationHistoryForClient.push(currentAIContentForClient);
          hasPendingClientContent = false;
          conversationHistoryForClient.push('\n[VCP 原生工具调用格式无效，本批未执行。]\n');
          completed = false;
          break;
        }
      }

      const hasActiveNativeToolCalls = hasNativeToolCallPayload(nativeMessage);
      const canUseResilienceThisTurn =
        isCurrentTurnEligible &&
        !vcpToolUseForbidden &&
        !hasActiveNativeToolCalls &&
        roleDividerAllowedForResilience &&
        protocolResilience.ENABLED;

      let droppedUnclosedThisTurn = false;
      if (
        canUseResilienceThisTurn &&
        currentChoice?.finish_reason !== 'length' &&
        currentChoice?.native_finish_reason !== 'length'
      ) {
        const stripRes = protocolResilience.stripUnclosedToolBlocks(currentAIContentForLoop, { fuzzyToolMatching });
        if (stripRes.droppedUnclosedToolBlock) {
          droppedUnclosedThisTurn = true;
          currentAIContentForLoop = stripRes.cleanContent;
          currentAIContentForClient = rebuildClientContentAfterStrip(stripRes.cleanContent);
          hasPendingOneRingPart = Boolean(currentAIContentForLoop && currentAIContentForLoop.trim());
        }
      }

      const resilienceEnabled = Boolean(protocolResilience && protocolResilience.ENABLED);
      const rawToolCalls = vcpToolUseForbidden
        ? []
        : (ownedCalls ?? (((resilienceEnabled && !isCurrentTurnEligible) || hasActiveNativeToolCalls) ? [] : ToolCallParser.parse(currentAIContentForLoop)));
      let toolCalls = rawToolCalls;
      if (canUseResilienceThisTurn) {
        try {
          const reconciled = await protocolResilience.reconcileTurnToolCalls(currentAIContentForLoop, rawToolCalls, {
            ToolCallParser,
            isStreaming: false,
            finishReason: currentChoice?.finish_reason || 'stop',
            nativeFinishReason: currentChoice?.native_finish_reason || null,
            sawDone: Boolean(currentParsedJson && !currentParsedJson.error),
            abortSignal: abortController?.signal,
            fuzzyToolMatching,
            pluginManager,
            agentManager: this.context?.agentManager || pluginManager?.agentManager || require('../agentManager')
          });
          toolCalls = [...(reconciled.toolCalls || []), ...(reconciled.protocolErrors || [])];
        } catch (err) {
          (typeof logger !== 'undefined' ? logger : console).error(`[VCPProtocolResilience] requestId=${id || 'unknown'} 非流式轮内自愈协调异常，降级原生: ${err.message}`);
          toolCalls = rawToolCalls;
        }
      }

      if (
        droppedUnclosedThisTurn &&
        toolCalls.length === 0 &&
        unclosedRetryCount < protocolResilience.MAX_UNCLOSED_TOOL_RETRIES &&
        !(abortController && abortController.signal.aborted)
      ) {
        unclosedRetryCount += 1;
        const tempMessagesAdded = [];
        const lastNonStreamMsg = currentMessagesForNonStreamLoop[currentMessagesForNonStreamLoop.length - 1];
        if (lastNonStreamMsg && lastNonStreamMsg.role === 'user') {
          const tempPlaceholder = { role: 'assistant', content: '[工具调用格式未闭合，已拦截重试]' };
          currentMessagesForNonStreamLoop.push(tempPlaceholder);
          tempMessagesAdded.push(tempPlaceholder);
        }
        const tempRetryMsg = {
          role: 'user',
          content: protocolResilience.UNCLOSED_RETRY_PROMPT
        };
        currentMessagesForNonStreamLoop.push(tempRetryMsg);
        tempMessagesAdded.push(tempRetryMsg);
        const retryBody = { ...originalBody, messages: currentMessagesForNonStreamLoop, stream: false };
        let retryReadResult;
        try {
          retryReadResult = await readNonStreamResponseWithSemanticRetry({
            fetchResponse: () => fetchNonStreamCompletion(retryBody, `unclosed_retry_${unclosedRetryCount}`),
            retries: apiRetries,
            delay: apiRetryDelay,
            debugMode: DEBUG_MODE,
            label: `unclosed_retry_${unclosedRetryCount}`,
            timelineTrace
          });
        } finally {
          while (tempMessagesAdded.length > 0) {
            const expected = tempMessagesAdded.pop();
            if (currentMessagesForNonStreamLoop[currentMessagesForNonStreamLoop.length - 1] === expected) {
              currentMessagesForNonStreamLoop.pop();
            }
          }
        }
        const retryAiResponse = retryReadResult.response;
        if (!retryAiResponse.ok) {
          if (conversationHistoryForClient.length === 0 && !String(currentAIContentForClient || '').trim()) {
            if (!res.headersSent && !res.writableEnded && !res.destroyed) {
              const errStatus = Number.isInteger(retryAiResponse.status) ? retryAiResponse.status : 502;
              const errPayload = retryReadResult.text || JSON.stringify({ error: { message: 'Unclosed tool retry upstream error' } });
              if (typeof res.status === 'function') {
                res.status(errStatus).send(errPayload);
              } else {
                res.send(errPayload);
              }
            }
            if (writeChatLog) writeChatLog(originalBody, chatLogs);
            return { completed: false, aiText: '' };
          }
          validUpstreamTurns = false;
          break;
        }
        noteUpstreamUsage(retryReadResult.text);
        const retryParsedResponse = extractedResponse(retryReadResult.text);
        const retryMessage = retryParsedResponse.message;
        const retryHasNativeTools = hasNativeToolCallPayload(retryMessage);
        if (
          retryReadResult.semanticRetryExhausted ||
          !retryParsedResponse?.parsedJson ||
          Boolean(retryParsedResponse?.parsedJson?.error) ||
          !retryMessage ||
          (!hasVisibleContent(retryMessage.content) && !retryHasNativeTools)
        ) {
          validUpstreamTurns = false;
          break;
        }
        hasPendingOneRingPart = false;
        hasPendingClientContent = false;
        validUpstreamTurns = isCompleteNonStreamResponse(retryReadResult);
        if (recursionDepth === 0) {
          activeBaseResponseText = retryReadResult.text;
        }
        currentParsedResponse = retryParsedResponse;
        currentTurnHasLeadingNewline = recursionDepth > 0;
        const retryPrefix = currentTurnHasLeadingNewline ? '\n' : '';
        currentAIContentForLoop = retryPrefix + extractVisibleContent(retryMessage);
        currentAIContentForClient = retryPrefix + extractClientContent(retryMessage, '', retryParsedResponse.choice);
        currentMessage = retryMessage;
        currentChoice = retryParsedResponse.choice;
        currentParsedJson = retryParsedResponse.parsedJson;
        isCurrentTurnEligible = !isMalformedFunctionCallWithoutNativeTools(retryParsedResponse.choice, retryMessage);
        hasPendingClientContent = true;
        if (protocolResilience && protocolResilience.ENABLED) {
          hasPendingOneRingPart = Boolean(currentAIContentForLoop && currentAIContentForLoop.trim());
        } else {
          hasPendingOneRingPart = false;
          if (currentAIContentForLoop && currentAIContentForLoop.trim()) {
            oneRingAssistantTurnParts.push(currentAIContentForLoop);
          }
        }
        if (writeChatLog) {
          chatLogs.push({ request: currentMessagesForNonStreamLoop, response: retryMessage });
        }
        continue;
      }

      conversationHistoryForClient.push(currentAIContentForClient);
      hasPendingClientContent = false;
      if (hasPendingOneRingPart) {
        oneRingAssistantTurnParts.push(currentAIContentForLoop);
        hasPendingOneRingPart = false;
      }

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
            const isError = !result?.success || (result?.raw && (typeof this.context?.isToolResultError === 'function' ? this.context.isToolResultError(result.raw) : false));

            if (isError) {
              const statusText = result?.isFormatGuidance ? '格式错误（未执行）' : '调用失败';
              archeryStatusSummaryItems.push(`${toolCall.name} ${statusText}${result?.recordId ? ` (记录ID: ${result.recordId})` : ''}`);
              archeryReceiptGroups[index] = { name: toolCall.name, callId: toolCall[NATIVE_CALL_ID], parts: [{
                type: 'text',
                text: `[异步工具 "${toolCall.name}" 返回了错误，请注意]:\n${result.content[0].text}`
              }] };
              const forceThisOne = !shouldShowVCP && toolCall.markHistory;
              if ((shouldShowVCP || forceThisOne || result?.isFormatGuidance) && (isError || forceThisOne || result?.isFormatGuidance)) {
                const vcpText = vcpInfoHandler.streamVcpInfo(null, originalBody?.model || 'unknown', toolCall.name, result.success ? 'success' : 'error', result.raw || result.error, abortController);
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

          if (ownedCalls) {
            currentMessagesForNonStreamLoop.push(...buildNativeToolMessages(nativeCalls, archeryGroups));
          } else {
            const archeryPayloadMsg = await buildToolPayloadMessage(archeryGroups);
            currentMessagesForNonStreamLoop.push(droppedUnclosedThisTurn ? appendUnclosedMixedBatchNote(archeryPayloadMsg) : archeryPayloadMsg);
          }

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

            // 步骤 0A 硬门控：遇异常直接终止递归，绝不把报错 JSON 喂给下一轮解析
            if (
              protocolResilience && protocolResilience.ENABLED && (
                recursionReadResult.semanticRetryExhausted ||
                !recursionParsedResponse?.parsedJson ||
                Boolean(recursionParsedResponse?.parsedJson?.error) ||
                !recursionMessage ||
                (!hasVisibleContent(recursionMessage.content) && !hasNativeToolCallPayload(recursionMessage))
              )
            ) {
              validUpstreamTurns = false;
              break;
            }

            currentTurnHasLeadingNewline = true;
            if (recursionMessage) {
              currentAIContentForLoop = '\n' + extractVisibleContent(recursionMessage);
              currentAIContentForClient = '\n' + extractClientContent(recursionMessage, '', recursionParsedResponse.choice);
            } else {
              currentAIContentForLoop = '\n' + recursionText;
              currentAIContentForClient = '\n' + recursionText;
            }
            currentMessage = recursionMessage;
            currentChoice = recursionParsedResponse.choice;
            currentParsedJson = recursionParsedResponse.parsedJson;
            isCurrentTurnEligible = !isMalformedFunctionCallWithoutNativeTools(recursionParsedResponse.choice, recursionMessage);
            hasPendingClientContent = true;
            if (protocolResilience && protocolResilience.ENABLED) {
              hasPendingOneRingPart = Boolean(currentAIContentForLoop && currentAIContentForLoop.trim());
            } else {
              hasPendingOneRingPart = false;
              if (currentAIContentForLoop && currentAIContentForLoop.trim()) {
                oneRingAssistantTurnParts.push(currentAIContentForLoop);
              }
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
          validUpstreamTurns = false;
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
          const isError = !result?.success || (result?.raw && (typeof this.context?.isToolResultError === 'function' ? this.context.isToolResultError(result.raw) : false));
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
          const statusText = result?.isFormatGuidance ? '格式错误（未执行）' : (isRejected ? '调用拒绝' : (isTimeout ? '调用超时' : (isError ? '调用失败' : '调用成功')));
          toolStatusSummaryItems.push(`${toolCall.name} ${statusText}${result?.recordId ? ` (记录ID: ${result.recordId})` : ''}`);

          if (shouldShowVCP || forceThisOne || result?.isFormatGuidance) {
            const vcpText = vcpInfoHandler.streamVcpInfo(null, originalBody?.model || 'unknown', toolCall.name, result.success ? 'success' : 'error', result.raw || result.error, abortController);
            if (vcpText) visibleToolResults.push(vcpText);
          }
        }

        if (toolStatusSummaryItems.length > 0) {
          visibleToolResults.push(`\n[本轮工具调用摘要:]\n${toolStatusSummaryItems.join('；')}。\n[本轮工具调用摘要结束]\n`);
        }
        conversationHistoryForClient.push(formatToolResultBatch(visibleToolResults, enableRoleDivider));

        // RAG 保留原表示，与发给模型的内容块分开；纯格式纠偏批次跳过 RAG 刷新。
        const allGuidanceOnly = toolResults.length > 0 && toolResults.every(r => r?.isFormatGuidance === true) && archeryErrorContents.length === 0;
        if (RAGMemoRefresh && !allGuidanceOnly) {
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
        if (ownedCalls) {
          currentMessagesForNonStreamLoop.push(...buildNativeToolMessages(nativeCalls, modelResultGroups));
        } else {
          const toolPayloadMsg = await buildToolPayloadMessage(modelResultGroups, maybeTranslateToolPayloadMedia);
          currentMessagesForNonStreamLoop.push(droppedUnclosedThisTurn ? appendUnclosedMixedBatchNote(toolPayloadMsg) : toolPayloadMsg);
        }

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

        if (!recursionAiResponse.ok) {
          validUpstreamTurns = false;
          break;
        }

        validUpstreamTurns = validUpstreamTurns && isCompleteNonStreamResponse(recursionReadResult);
        const recursionText = recursionReadResult.text;
        noteUpstreamUsage(recursionText);
        const recursionParsedResponse = extractedResponse(recursionText);
        currentParsedResponse = recursionParsedResponse;
        const recursionMessage = recursionParsedResponse.message;

        // 步骤 0A 硬门控：遇异常直接终止递归，绝不把报错 JSON 喂给下一轮解析
        if (
          protocolResilience && protocolResilience.ENABLED && (
            recursionReadResult.semanticRetryExhausted ||
            !recursionParsedResponse?.parsedJson ||
            Boolean(recursionParsedResponse?.parsedJson?.error) ||
            !recursionMessage ||
            (!hasVisibleContent(recursionMessage.content) && !hasNativeToolCallPayload(recursionMessage))
          )
        ) {
          validUpstreamTurns = false;
          break;
        }

        currentTurnHasLeadingNewline = true;
        if (recursionMessage) {
          currentAIContentForLoop = '\n' + extractVisibleContent(recursionMessage);
          currentAIContentForClient = '\n' + extractClientContent(recursionMessage, '', recursionParsedResponse.choice);
        } else {
          currentAIContentForLoop = '\n' + recursionText;
          currentAIContentForClient = '\n' + recursionText;
        }
        currentMessage = recursionMessage;
        currentChoice = recursionParsedResponse.choice;
        currentParsedJson = recursionParsedResponse.parsedJson;
        isCurrentTurnEligible = !isMalformedFunctionCallWithoutNativeTools(recursionParsedResponse.choice, recursionMessage);
        hasPendingClientContent = true;
        if (protocolResilience && protocolResilience.ENABLED) {
          hasPendingOneRingPart = Boolean(currentAIContentForLoop && currentAIContentForLoop.trim());
        } else {
          hasPendingOneRingPart = false;
          if (currentAIContentForLoop && currentAIContentForLoop.trim()) {
            oneRingAssistantTurnParts.push(currentAIContentForLoop);
          }
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

    const postLoopResilienceEnabled = Boolean(protocolResilience && protocolResilience.ENABLED);
    if (postLoopResilienceEnabled && hasPendingClientContent && !(abortController && abortController.signal.aborted)) {
      const finalHasActiveNativeToolCalls = hasNativeToolCallPayload(currentMessage);
      if (
        isCurrentTurnEligible &&
        !vcpToolUseForbidden &&
        !finalHasActiveNativeToolCalls &&
        roleDividerAllowedForResilience &&
        protocolResilience.ENABLED &&
        currentChoice?.finish_reason !== 'length' &&
        currentChoice?.native_finish_reason !== 'length'
      ) {
        const finalStripRes = protocolResilience.stripUnclosedToolBlocks(currentAIContentForLoop, { fuzzyToolMatching });
        if (finalStripRes.droppedUnclosedToolBlock) {
          currentAIContentForLoop = finalStripRes.cleanContent;
          currentAIContentForClient = rebuildClientContentAfterStrip(finalStripRes.cleanContent);
          hasPendingOneRingPart = Boolean(currentAIContentForLoop && currentAIContentForLoop.trim());
        }
      }
      conversationHistoryForClient.push(currentAIContentForClient);
      hasPendingClientContent = false;
      if (hasPendingOneRingPart) {
        oneRingAssistantTurnParts.push(currentAIContentForLoop);
        hasPendingOneRingPart = false;
      }

      let finalHasPendingToolsOrErrors = finalHasActiveNativeToolCalls;

      const finalResilienceEnabled = Boolean(protocolResilience && protocolResilience.ENABLED);
      if (!finalHasActiveNativeToolCalls && (!finalResilienceEnabled || isCurrentTurnEligible) && !vcpToolUseForbidden) {
        const finalRawToolCalls = ToolCallParser.parse(currentAIContentForLoop);
        if (roleDividerAllowedForResilience && finalResilienceEnabled) {
          try {
            const finalReconciled = await protocolResilience.reconcileTurnToolCalls(currentAIContentForLoop, finalRawToolCalls, {
              ToolCallParser,
              isStreaming: false,
              finishReason: currentChoice?.finish_reason || 'stop',
              nativeFinishReason: currentChoice?.native_finish_reason || null,
              sawDone: Boolean(currentParsedJson && !currentParsedJson.error),
              abortSignal: abortController?.signal,
              fuzzyToolMatching,
              pluginManager,
              agentManager: this.context?.agentManager || pluginManager?.agentManager || require('../agentManager')
            });
            finalHasPendingToolsOrErrors =
              (finalReconciled.toolCalls?.length || 0) > 0 ||
              (finalReconciled.protocolErrors?.length || 0) > 0;
          } catch (_) {
            finalHasPendingToolsOrErrors = finalRawToolCalls.length > 0;
          }
        } else {
          finalHasPendingToolsOrErrors = finalRawToolCalls.length > 0;
        }
      }

      if (!finalHasPendingToolsOrErrors && (!finalResilienceEnabled || isCurrentTurnEligible)) {
        completed = validUpstreamTurns;
        hitMaxRecursionTruncation = false;
      } else {
        completed = false;
        hitMaxRecursionTruncation = true;
      }
    }

    const isMaxRecursionTruncated = postLoopResilienceEnabled
      ? hitMaxRecursionTruncation
      : (recursionDepth >= maxRecursion);
    const finalContentForClient = conversationHistoryForClient.join('');
    let finalJsonResponse;
    try {
      finalJsonResponse = nativeTerminalResponse || JSON.parse(activeBaseResponseText);
      const choice0 = finalJsonResponse.choices?.[0];
      const msg0 = choice0?.message;
      const preserveNativeToolTurn = nativeTerminalResponse !== null;

      if (!msg0) {
        finalJsonResponse.choices = [{ message: { content: finalContentForClient } }];
        finalJsonResponse.choices[0].finish_reason = isMaxRecursionTruncated ? 'length' : 'stop';
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
        if (isMaxRecursionTruncated) {
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
        choices: [{ index: 0, message: { role: 'assistant', content: finalContentForClient }, finish_reason: isMaxRecursionTruncated ? 'length' : 'stop' }]
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