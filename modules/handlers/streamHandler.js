// modules/handlers/streamHandler.js
const { StringDecoder } = require('string_decoder');
const vcpInfoHandler = require('../../vcpInfoHandler.js');
const contextBudget = require('../contextBudget.js');
const finalContextStore = require('../finalContextStore.js');
const roleDivider = require('../roleDivider.js');
const { formatToolResultBatch, projectToolBatchForUpstream, buildToolPayloadMessage } = require('../toolResultBatch.js');
const { matchesNativeToolIsolation } = require('../nativeToolIsolation.js');
const {
  extractReasoningText,
  removeReasoningFields,
  normalizeReasoningTag,
  shouldConvertReasoningForModel
} = require('../reasoningContentAdapter.js');

async function streamUpstreamErrorAndEnd(res, nextAiAPIResponse, originalModel, label = 'Tool Loop') {
  let errorBodyText = '';
  try {
    errorBodyText = await nextAiAPIResponse.text();
  } catch (e) {
    errorBodyText = e.message || '';
  }
  const status = nextAiAPIResponse.status;
  console.error(`[StreamHandler Upstream Error] (${label}) Upstream returned status ${status}: ${errorBodyText}`);

  if (!res.writableEnded && !res.destroyed) {
    let readableError = errorBodyText;
    try {
      const parsed = JSON.parse(errorBodyText);
      if (parsed?.error?.message) {
        readableError = parsed.error.message;
      } else if (parsed?.message) {
        readableError = parsed.message;
      }
    } catch (_) {}

    const errorContent = `\n\n> [!WARNING]\n> **上游API错误 (HTTP ${status})**: ${readableError || nextAiAPIResponse.statusText || '未知错误'}\n`;
    try {
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-VCP-tool-upstream-error-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: originalModel || 'unknown',
        choices: [{ index: 0, delta: { content: errorContent }, finish_reason: 'stop' }],
      })}\n\n`);
      res.write('data: [DONE]\n\n', () => {
        try { res.end(); } catch (e) { }
      });
    } catch (writeErr) {
      console.error('[StreamHandler Upstream Error] Failed to write error to stream:', writeErr.message);
      try { res.end(); } catch (e) { }
    }
  }
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
      touchRequestActivity,
      toolExecutor,
      ToolCallParser,
      abortController,
      originalBody,
      clientIp,
      _refreshRagBlocksIfNeeded,
      fetchWithRetry,
      vcpToolUseForbidden,
      apiConnectionTimeoutMs,
      semanticModelFallbackCandidates,
      oneRingResponseMeta,
      budgetGuard,
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
    const id = originalBody.requestId || originalBody.messageId;

    const waitForHandoff = async () => {
      console.log(`[Handoff] WAITING: requestId=${id}. 工具回执已发送；因 ready 暂缓下一轮上游 AI 请求，等待 Interrupt 或 cancel（最多2秒），尚未向 AI 派发。`);
      try {
        await this.context.handoffGate.wait();
      } catch (error) {
        if (error.name === 'AbortError') {
          console.log(`[Handoff] STOPPED before dispatch: requestId=${id}. ready 等待期间收到中止信号，本轮工具结果未触发下一次上游 AI 请求。`);
        }
        throw error;
      }
      if (!abortController.signal.aborted && !res.writableEnded && !res.destroyed) {
        console.log(`[Handoff] RESUMING: requestId=${id}. 预约已取消或等待超时，恢复下一轮上游 AI 请求派发。`);
      }
    };

    let currentMessagesForLoop = originalBody.messages ? JSON.parse(JSON.stringify(originalBody.messages)) : [];
    let recursionDepth = 0;
    const maxRecursion = maxVCPLoopStream || 5;
    let currentAIContentForLoop = '';
    let chatLogs = [];
    let oneRingAssistantTurnParts = [];
    let validUpstreamTurns = true;
    let completed = false;
    let upstreamIdleTimedOut = false;

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
        if (DEBUG_MODE) console.warn(`[VCP Stream Loop] Tool payload contains image_url, but ${processorName} is unavailable. Forwarding original payload.`);
        return content;
      }

      const originalImageParts = content.filter(part => part?.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string');
      const payloadMessage = { role: 'user', content: JSON.parse(JSON.stringify(content)) };

      if (DEBUG_MODE) {
        console.log(`[VCP Stream Loop] Translating tool-returned image_url content via ${processorName}. textOnly=${!!isTextOnlyForceTranslateModel}, plus=${!!shouldProcessMediaPlus}`);
      }

      let translatedMessages;
      try {
        translatedMessages = await pluginManager.executeMessagePreprocessor(
          processorName,
          [payloadMessage],
          requestPreprocessorConfig || {}
        );
      } catch (pluginError) {
        console.error(`[VCP Stream Loop] Error translating tool-returned media via ${processorName}:`, pluginError);
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

    // 辅助函数：处理 AI 响应流 (优化版：直通转发 + 后台解析 + chunk 空闲超时保护)
    const readAIResponseStream = async (aiResponse, isInitialCall) => {
      return new Promise((resolve, reject) => {
        const decoder = new StringDecoder('utf8');
        let collectedContentThisTurn = '';
        let sseLineBuffer = '';
        let streamAborted = false;
        let keepAliveTimer = null;
        let chunkIdleTimer = null;
        let toolTailTimer = null;
        let streamSettled = false;
        const TOOL_TAIL_TIMEOUT_MS = 15000;
        const configuredIdleTimeout = Number(process.env.STREAM_CHUNK_IDLE_TIMEOUT_MS);
        const CHUNK_IDLE_TIMEOUT = Number.isFinite(configuredIdleTimeout) && configuredIdleTimeout > 0 ? configuredIdleTimeout : 90000; // 默认 90 秒（可通过 STREAM_CHUNK_IDLE_TIMEOUT_MS 配置）
        let message = { content: '', reasoning_content: '' };
        let clientReasoningBlockOpen = false;
        let clientReasoningEndsWithNewline = false;

        let finishReason = null;
        let nativeFinishReason = null;
        let malformedFunctionCall = false;
        let sawDone = false;
        let invalidPayload = false;
        let hasPayloadError = false;
        let upstreamEnded = false;
        let sawNativeToolCall = false;
        const shouldStripNativeTools = (payloadModel) =>
          matchesNativeToolIsolation(payloadModel || originalBody?.model);
        const result = () => {
          const firstSettle = !streamSettled;
          streamSettled = true;
          if (toolTailTimer) clearTimeout(toolTailTimer);
          if (firstSettle && !streamAborted && !sawNativeToolCall && collectedContentThisTurn.trim().length === 0) {
            console.warn(
              `[VCP Stream Empty] requestId=${id || 'unknown'} model=${originalBody?.model || 'unknown'} ` +
              `status=${aiResponse?.status ?? 'unknown'} finishReason=${finishReason || 'none'} ` +
              `nativeFinishReason=${nativeFinishReason || 'none'} sawDone=${sawDone} ` +
              `reasoningChars=${message.reasoning_content.length} invalidPayload=${invalidPayload} malformedFC=${malformedFunctionCall}`
            );
          }
          const hasNativeToolCompletion = sawNativeToolCall && (
            ['tool_calls', 'function_call', 'stop'].includes(finishReason) ||
            (!finishReason && sawDone)
          );
          return {
            content: collectedContentThisTurn, message, malformedFunctionCall,
            streamAborted, hasPayloadError, sawNativeToolCall, finishReason, nativeFinishReason,
            completed: !streamAborted && !invalidPayload && aiResponse.ok && (
              (collectedContentThisTurn.trim().length > 0 &&
                (finishReason === 'stop' || (!finishReason && sawDone))) ||
              hasNativeToolCompletion
            )
          };
        };
        const observePayload = (parsedData) => {
          // 首个上游调用的 usage 就是「最终上下文」快照那份请求体的真实计数。
          if (isInitialCall && parsedData?.usage) finalContextStore.recordUpstreamUsage(id, parsedData.usage);
          // 每一轮的真实用量都用来校准下一轮的预算估算。
          if (parsedData?.usage) budgetGuard?.noteUsage(parsedData.usage, aiResponse?.vcpAttemptModel);
          if (parsedData?.error) {
            invalidPayload = true;
            hasPayloadError = true;
          }
          const choice = parsedData?.choices?.[0];
          if ([choice?.native_finish_reason, choice?.finish_reason]
            .some(reason => typeof reason === 'string' && reason.toLowerCase() === 'malformed_function_call')) {
            malformedFunctionCall = true;
            invalidPayload = true;
          }
          if (!shouldStripNativeTools(parsedData?.model)) {
            const delta = choice?.delta;
            const msg = choice?.message;
            if (
              (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) ||
              delta?.function_call ||
              (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) ||
              msg?.function_call ||
              ['tool_calls', 'function_call'].includes(choice?.finish_reason)
            ) {
              sawNativeToolCall = true;
            }
          }
          const reason = parsedData?.choices?.[0]?.finish_reason;
          if (reason) finishReason = reason;
          const nativeReason = parsedData?.choices?.[0]?.native_finish_reason;
          if (nativeReason) nativeFinishReason = nativeReason;
        };

        const appendDelta = (delta) => {
          if (delta && delta.content) {
            collectedContentThisTurn += delta.content;
            message.content += delta.content;
          }

          const reasoningText = extractReasoningText(delta);
          if (reasoningText) {
            // 推理内容只保留在日志字段中，绝不混入 collectedContentThisTurn。
            // 客户端展示转换在独立副本上进行，避免进入 VCP Loop、OneRing 和日记。
            message.reasoning_content += reasoningText;
          }
          if (delta?.content || reasoningText) refreshToolTailTimer();
        };

        const transformParsedDataForClient = (parsedData) => {
          if (!parsedData || typeof parsedData !== 'object') return parsedData;

          const stripTools = shouldStripNativeTools(parsedData.model);
          if (!stripTools && !reasoningToContentEnabled) return parsedData;

          const transformed = JSON.parse(JSON.stringify(parsedData));
          if (stripTools) {
            for (const item of transformed.choices || []) {
              for (const payload of [item.delta, item.message]) {
                if (!payload || typeof payload !== 'object') continue;
                delete payload.tool_calls;
                delete payload.function_call;
              }
              // Strip hallucinated native FC only for models matched by NativeToolIsolationModels.
              for (const key of ['finish_reason', 'native_finish_reason']) {
                if (['tool_calls', 'function_call'].includes(item[key])) item[key] = null;
              }
            }
          }
          if (!reasoningToContentEnabled) return transformed;
          const choice = transformed.choices?.[0];
          const delta = choice?.delta;
          if (!delta || typeof delta !== 'object') return transformed;

          const reasoningText = extractReasoningText(delta);
          const visibleContent = typeof delta.content === 'string' ? delta.content : '';
          let clientContent = '';

          if (reasoningText) {
            if (!clientReasoningBlockOpen) {
              clientContent += `<${reasoningTag}>\n`;
              clientReasoningBlockOpen = true;
            }
            clientContent += reasoningText;
            clientReasoningEndsWithNewline = /(?:\r\n|\r|\n)$/.test(reasoningText);
          }

          // 正文与推理同 chunk 出现时，先规范闭合思考块，再输出正文。
          if (visibleContent && clientReasoningBlockOpen) {
            clientContent += `${clientReasoningEndsWithNewline ? '' : '\n'}</${reasoningTag}>\n`;
            clientReasoningBlockOpen = false;
            clientReasoningEndsWithNewline = false;
          }
          clientContent += visibleContent;

          // 上游明确结束但没有正文时，也必须规范补齐闭合标签。
          if (choice.finish_reason && clientReasoningBlockOpen) {
            clientContent += `${clientReasoningEndsWithNewline ? '' : '\n'}</${reasoningTag}>\n`;
            clientReasoningBlockOpen = false;
            clientReasoningEndsWithNewline = false;
          }

          removeReasoningFields(delta);
          if (clientContent) {
            delta.content = clientContent;
          } else if (Object.prototype.hasOwnProperty.call(delta, 'content')) {
            delete delta.content;
          }

          return transformed;
        };

        const writeClientReasoningCloseChunk = () => {
          if (!reasoningToContentEnabled || !clientReasoningBlockOpen || res.writableEnded || res.destroyed) {
            return;
          }

          const closePrefix = clientReasoningEndsWithNewline ? '' : '\n';
          clientReasoningBlockOpen = false;
          clientReasoningEndsWithNewline = false;
          const closePayload = {
            id: `chatcmpl-VCP-reasoning-close-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: originalBody.model || 'unknown',
            choices: [{
              index: 0,
              delta: { content: `${closePrefix}</${reasoningTag}>\n` },
              finish_reason: null
            }]
          };
          res.write(`data: ${JSON.stringify(closePayload)}\n\n`);
        };
        const canTakeToolTail = () =>
          !streamSettled && !streamAborted && !hasPayloadError && aiResponse.ok &&
          !vcpToolUseForbidden && !abortController?.signal.aborted &&
          !res.writableEnded && !res.destroyed &&
          (!finishReason || ['stop', 'tool_calls', 'function_call'].includes(finishReason) || malformedFunctionCall) &&
          !sseLineBuffer.trim() &&
          ToolCallParser.endsWithCompleteToolRequest?.(collectedContentThisTurn) === true;

        const takeToolTail = (reason) => {
          if (!canTakeToolTail()) return false;
          streamSettled = true;
          if (toolTailTimer) clearTimeout(toolTailTimer);
          if (chunkIdleTimer) clearTimeout(chunkIdleTimer);
          if (keepAliveTimer) clearInterval(keepAliveTimer);
          abortController?.signal.removeEventListener('abort', abortHandler);
          writeClientReasoningCloseChunk();
          console.warn(`[VCP Stream ToolTail] requestId=${id || 'unknown'} reason=${reason}；完整工具尾部接管，关闭旧上游流并继续 ToolLoop。`);
          aiResponse.body?.destroy();
          resolve({ ...result(), malformedFunctionCall: false, completed: true });
          return true;
        };

        const refreshToolTailTimer = () => {
          if (toolTailTimer) clearTimeout(toolTailTimer);
          toolTailTimer = null;
          if (!streamSettled && !vcpToolUseForbidden &&
              ToolCallParser.endsWithCompleteToolRequest?.(collectedContentThisTurn) === true) {
            toolTailTimer = setTimeout(() => takeToolTail('tool_tail_idle_15s'), TOOL_TAIL_TIMEOUT_MS);
          }
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
            if (streamSettled || streamAborted) return;
            if (takeToolTail('upstream_idle')) return;
            console.warn(`[Stream IdleTimeout] No upstream chunk received for ${CHUNK_IDLE_TIMEOUT / 1000}s. Assuming stream stalled. Forcing end.`);
            upstreamIdleTimedOut = true;
            streamAborted = true;
            const outcome = result();
            if (keepAliveTimer) clearInterval(keepAliveTimer);
            abortController?.signal.removeEventListener('abort', abortHandler);
            if (aiResponse.body && !aiResponse.body.destroyed) {
              aiResponse.body.destroy();
            }
            resolve(outcome);
          }, CHUNK_IDLE_TIMEOUT);
        };
        resetChunkIdleTimer(); // 启动首次空闲计时

        const abortHandler = () => {
          if (streamSettled) return;
          streamAborted = true;
          if (keepAliveTimer) clearInterval(keepAliveTimer);
          if (chunkIdleTimer) clearTimeout(chunkIdleTimer);
          if (DEBUG_MODE) console.log('[Stream Abort] Abort signal received, stopping stream processing.');
          if (abortController?.signal) abortController.signal.removeEventListener('abort', abortHandler);
          if (aiResponse.body && !aiResponse.body.destroyed) aiResponse.body.destroy();
          resolve(result());
        };

        if (abortController?.signal) {
          abortController.signal.addEventListener('abort', abortHandler);
          if (abortController.signal.aborted) abortHandler();
        }

        aiResponse.body.on('close', () => {
          if (streamSettled || upstreamEnded) return;
          if (takeToolTail('upstream_close')) return;
          streamAborted = true;
          if (keepAliveTimer) clearInterval(keepAliveTimer);
          if (chunkIdleTimer) clearTimeout(chunkIdleTimer);
          if (abortController?.signal) abortController.signal.removeEventListener('abort', abortHandler);
          resolve(result());
        });

        aiResponse.body.on('data', chunk => {
          if (streamSettled || streamAborted) return;
          resetChunkIdleTimer(); // 每收到一个 chunk 就重置空闲计时器
          touchRequestActivity?.();

          const chunkString = decoder.write(chunk);
          sseLineBuffer += chunkString;

          // 按行处理：既保证了转发的实时性，又解决了 [DONE] 跨包截断的问题
          // 使用更健壮的正则拆分，处理 \r\n, \n, \r (SSE 规范允许这三种换行符)
          let lines = sseLineBuffer.split(/\r\n|\r|\n/);
          sseLineBuffer = lines.pop(); // 最后一项可能是截断的，留到下一轮

          for (const line of lines) {
            const trimmedLine = line.trim();
            const isDoneLine = trimmedLine === 'data: [DONE]' || trimmedLine === 'data:[DONE]';
            if (isDoneLine) sawDone = true;
            let parsedData = null;

            if (trimmedLine.startsWith('data:')) {
              const jsonData = trimmedLine.substring(5).trim();
              if (jsonData && jsonData !== '[DONE]') {
                try {
                  parsedData = JSON.parse(jsonData);
                  observePayload(parsedData);
                  // 后台始终收集未经展示转换的原始 delta。
                  appendDelta(parsedData.choices?.[0]?.delta);
                } catch (e) { invalidPayload = true; hasPayloadError = true; }
              }
            }

            // Failed terminal payloads must not end the frontend listener before recovery.
            if (malformedFunctionCall) continue;
            // 转发时才将 reasoning 字段改写成标签化正文；内部处理仍使用原始 parsedData。
            if (!res.writableEnded && !res.destroyed) {
              try {
                if (isDoneLine) {
                  writeClientReasoningCloseChunk();
                } else if (parsedData) {
                  const transformedData = transformParsedDataForClient(parsedData);
                  res.write(`data: ${JSON.stringify(transformedData)}\n`);
                } else {
                  // 保留空行，因为 SSE 依靠空行分隔消息块。
                  res.write(line + '\n');
                }
              } catch (writeError) {
                streamAborted = true;
              }
            }
          }
        });

        aiResponse.body.on('end', () => {
          if (streamSettled) return;
          upstreamEnded = true;
          if (keepAliveTimer) clearInterval(keepAliveTimer);
          if (chunkIdleTimer) clearTimeout(chunkIdleTimer);
          const remainingString = decoder.end();
          if (remainingString) {
            sseLineBuffer += remainingString;
          }

          // 处理最后剩余的 buffer并转发
          if (sseLineBuffer.length > 0) {
            const trimmedLine = sseLineBuffer.trim();
            const isDoneLine = trimmedLine === 'data: [DONE]' || trimmedLine === 'data:[DONE]';
            if (isDoneLine) sawDone = true;
            let parsedData = null;

            if (trimmedLine.startsWith('data:')) {
              const jsonData = trimmedLine.substring(5).trim();
              if (jsonData && jsonData !== '[DONE]') {
                try {
                  parsedData = JSON.parse(jsonData);
                  observePayload(parsedData);
                  appendDelta(parsedData.choices?.[0]?.delta);
                } catch (e) { invalidPayload = true; hasPayloadError = true; }
              }
            }

            if (!res.writableEnded && !res.destroyed) {
              try {
                if (isDoneLine) {
                  writeClientReasoningCloseChunk();
                } else if (parsedData && !malformedFunctionCall) {
                  res.write(`data: ${JSON.stringify(transformParsedDataForClient(parsedData))}\n`);
                } else {
                  if (!malformedFunctionCall) res.write(sseLineBuffer + '\n');
                }
              } catch (e) { }
            }
          }

          sseLineBuffer = '';
          if (!finishReason && !sawDone && takeToolTail('upstream_end_without_terminal')) return;
          writeClientReasoningCloseChunk();
          if (abortController?.signal) abortController.signal.removeEventListener('abort', abortHandler);
          resolve(result());
        });

        aiResponse.body.on('error', streamError => {
          if (streamSettled) return;
          if (takeToolTail('upstream_error')) return;
          if (toolTailTimer) clearTimeout(toolTailTimer);
          if (keepAliveTimer) clearInterval(keepAliveTimer);
          if (chunkIdleTimer) clearTimeout(chunkIdleTimer);
          if (abortController?.signal) abortController.signal.removeEventListener('abort', abortHandler);
          if (streamAborted || streamError.name === 'AbortError' || streamError.type === 'aborted') {
            streamAborted = true;
            resolve(result());
            return;
          }
          console.error('Error reading AI response stream:', streamError);
          if (!res.writableEnded) {
            try {
              res.write(`data: ${JSON.stringify({ error: 'STREAM_READ_ERROR', message: streamError.message })}\n\n`);
              res.end();
            } catch (e) { }
          }
          streamSettled = true;
          reject(streamError);
        });
      });
    };

    // Only normal body content is eligible; never recover tools from reasoning or error diagnostics.
    const acceptMalformedToolTurn = (data) => {
      if (!data.malformedFunctionCall || data.streamAborted || data.hasPayloadError ||
          vcpToolUseForbidden || abortController?.signal.aborted || res.writableEnded || res.destroyed) return null;
      const calls = ToolCallParser.parse(data.content);
      if (calls.length === 0) return null;
      console.warn(`[VCP Stream Recovery] requestId=${id || 'unknown'} MALFORMED_FUNCTION_CALL，但正文含 ${calls.length} 个可解析 VCP 工具请求；保留正文交由 ToolLoop 执行，不重生成、不执行原生 FC。`);
      return { ...data, completed: true };
    };

    const noteLoopRequest = (body) => {
      budgetGuard?.noteRequest(body);
      return body;
    };

    /**
     * 工具循环每次再发上游之前的预算检查。返回要发送的请求体；返回 null 表示已超预算、
     * 已向客户端说明并结束响应，调用方应退出循环。
     * 超预算时先把本轮之前的工具结果压缩成摘要（当前轮不动），仍然超才停止。
     */
    const prepareLoopRequest = (roundStartIndex) => {
      const build = () => projectToolBatchForUpstream({ ...originalBody, messages: currentMessagesForLoop, stream: true });
      let body = build();
      if (!budgetGuard?.active) return body;
      let check = budgetGuard.check(body, 'tool_loop', { silent: budgetGuard.enforcing });
      if (check.over && budgetGuard.enforcing) {
        const slimmed = contextBudget.slimToFit(currentMessagesForLoop, roundStartIndex, () => budgetGuard.check(build(), 'tool_loop', { silent: true }).over);
        if (slimmed > 0) {
          body = build();
          const before = check.estimated;
          check = budgetGuard.check(body, 'tool_loop', { silent: true });
          console.warn(`[ContextBudget] 工具循环超预算，已压缩 ${slimmed} 条较早的工具结果: requestId=${id || 'none'} ${before} -> ${check.estimated} / ${check.limit}`);
        }
      }
      if (check.over && budgetGuard.enforcing) {
        console.warn(`[ContextBudget] 工具循环已停止: requestId=${id || 'none'} estimated=${check.estimated} limit=${check.limit}`);
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.write(`data: ${JSON.stringify({
              id: `chatcmpl-VCP-context-budget-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: originalBody.model || 'unknown',
              vcp_incomplete: true,
              vcp_context_budget: { stage: 'tool_loop', estimated: check.estimated, limit: check.limit },
              choices: [{ index: 0, delta: {
                content: `\n\n> [!WARNING]\n> ${contextBudget.exceededMessage(check, 'tool_loop', budgetGuard.breakdown(body))}\n`
              }, finish_reason: 'stop' }],
            })}\n\n`);
            res.write('data: [DONE]\n\n', () => {
              try { res.end(); } catch (e) { }
            });
          } catch (e) {
            try { res.end(); } catch (_) { }
          }
        }
        return null;
      }
      return noteLoopRequest(body);
    };

    // Semantic recovery is per upstream turn, separate from transport retries and tool execution.
    const processAIResponseStreamHelper = async (aiResponse, isInitialCall) => {
      let data = await readAIResponseStream(aiResponse, isInitialCall);
      if (data.streamAborted) return { ...data, content: '', completed: false };
      if (
        !data.malformedFunctionCall &&
        !data.hasPayloadError &&
        !data.sawNativeToolCall &&
        data.finishReason === 'content_filter' &&
        !data.content.trim() &&
        !data.message.reasoning_content &&
        matchesNativeToolIsolation(originalBody?.model)
      ) {
        console.warn(`[VCP Stream Recovery] requestId=${id || 'unknown'} hydrogen 上游返回空正文 content_filter，判定为上游映射的 MALFORMED_FUNCTION_CALL，将触发纠偏重发。`);
        data.malformedFunctionCall = true;
      }
      if (!data.malformedFunctionCall) return data;
      if (abortController?.signal.aborted || data.streamAborted || res.writableEnded || res.destroyed) return data;

      const accepted = acceptMalformedToolTurn(data);
      if (accepted) return accepted;

      // Never replay visible body; only complete parsed body tools can survive malformed FC.
      if (!data.content.trim() && !data.message.reasoning_content) {
        // Internal ToolLoop continuation only: reuse processed messages; never re-enter handle/preprocessors.
        currentMessagesForLoop.push({
          role: 'user',
          content: '[系统提示]你的上一个回复在思维链里输出了call导致报错，不要在思维链里输出call啦，正常回复用户的回复吧！'
        });
        const heartbeat = setInterval(() => {
          if (!res.writableEnded && !res.destroyed) {
            try { res.write(': vcp-recovery-keepalive\n\n'); } catch (_) {}
          }
        }, 5000);
        heartbeat.unref?.();
        let response;
        try {
          console.warn(`[VCP Stream Recovery] requestId=${id || 'unknown'} 上游 HTTP ${aiResponse.status} 返回 MALFORMED_FUNCTION_CALL；正在 ToolLoop 内追加 user 纠偏消息并直接补发上游（第 1/1 次，不经过预消息处理管线，不结束前端 SSE）。`);
          response = await fetchWithRetry(`${apiUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              Accept: 'text/event-stream'
            },
            body: JSON.stringify(noteLoopRequest(projectToolBatchForUpstream({
              ...originalBody, messages: currentMessagesForLoop, stream: true
            }))),
            signal: abortController.signal
          }, {
            retries: 1, delay: apiRetryDelay, debugMode: DEBUG_MODE,
            connectionTimeout: apiConnectionTimeoutMs
          });
        } finally {
          clearInterval(heartbeat);
        }
        if (abortController.signal.aborted || res.writableEnded || res.destroyed) {
          return { ...data, content: '', completed: false };
        }
        if (!response.ok) {
          await streamUpstreamErrorAndEnd(res, response, originalBody.model, 'Malformed FC Recovery');
          return { ...data, content: '', completed: false };
        }
        data = await readAIResponseStream(response, false);
        if (data.streamAborted) return { ...data, content: '', completed: false };
        if (!data.malformedFunctionCall) return data;
        const acceptedRecovery = acceptMalformedToolTurn(data);
        if (acceptedRecovery) return acceptedRecovery;
      }

      if (!abortController.signal.aborted && !res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({
          object: 'chat.completion.chunk', model: originalBody.model,
          choices: [{ index: 0, delta: {
            content: '\n[ERROR] 上游生成失败：MALFORMED_FUNCTION_CALL。恢复未成功或已有输出；本轮工具未执行。\n'
          }, finish_reason: null }]
        })}\n\n`);
      }
      // Let the outer handler own the single final stop/DONE; invalid tool text stays out of ToolLoop.
      return { ...data, content: '', completed: false };
    };

    // --- 初始 AI 调用 ---
    if (DEBUG_MODE) console.log('[VCP Stream Loop] Processing initial AI call.');
    let initialAIResponseData = await processAIResponseStreamHelper(firstAiAPIResponse, true);
    let lastAIResponseData = initialAIResponseData;
    let lastTurnSawNativeToolCall = Boolean(initialAIResponseData.sawNativeToolCall);
    let lastTurnFinishReason = initialAIResponseData.finishReason || null;
    validUpstreamTurns = initialAIResponseData.completed;
    currentAIContentForLoop = initialAIResponseData.content;
    if (writeChatLog) chatLogs.push({ request: originalBody, response: initialAIResponseData.message });
    if (currentAIContentForLoop && currentAIContentForLoop.trim()) {
      oneRingAssistantTurnParts.push(currentAIContentForLoop);
    }

    // --- VCP 循环 ---
    while (!upstreamIdleTimedOut && recursionDepth < maxRecursion) {
      // 检查中止信号
      if (abortController && abortController.signal.aborted) {
        if (DEBUG_MODE) console.log('[VCP Stream Loop] Abort detected, exiting loop.');
        break;
      }

      const roundStartIndex = currentMessagesForLoop.length;
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

      const toolCalls = vcpToolUseForbidden ? [] : ToolCallParser.parse(currentAIContentForLoop);
      if (toolCalls.length === 0) {
        if (DEBUG_MODE) console.log('[VCP Stream Loop] No tool calls found. Exiting loop.');
        if (!res.writableEnded) {
          try {
            if (
              !lastTurnSawNativeToolCall &&
              !lastAIResponseData?.streamAborted &&
              !lastAIResponseData?.malformedFunctionCall &&
              (!currentAIContentForLoop || !currentAIContentForLoop.trim())
            ) {
              const reasonParts = [];
              if (lastAIResponseData?.finishReason) reasonParts.push(`finish_reason=${lastAIResponseData.finishReason}`);
              if (lastAIResponseData?.nativeFinishReason) reasonParts.push(`native_finish_reason=${lastAIResponseData.nativeFinishReason}`);
              if (lastAIResponseData?.message?.reasoning_content?.length > 0) {
                reasonParts.push(`思考=${lastAIResponseData.message.reasoning_content.length}字`);
              }
              if (lastAIResponseData?.hasPayloadError) reasonParts.push('上游payload报错');
              const emptyReason = reasonParts.length > 0 ? reasonParts.join(', ') : '上游未返回任何正文';
              res.write(`data: ${JSON.stringify({
                id: `chatcmpl-VCP-empty-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: originalBody.model,
                choices: [{ index: 0, delta: { content: `\n[上游空回：${emptyReason}]\n` }, finish_reason: null }],
              })}\n\n`);
            }
            if (!lastTurnSawNativeToolCall) {
              const finalChunkPayload = {
                id: `chatcmpl-VCP-final-stop-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: originalBody.model,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              };
              res.write(`data: ${JSON.stringify(finalChunkPayload)}\n\n`);
            } else if (!['tool_calls', 'function_call'].includes(lastTurnFinishReason)) {
              const finalToolChunkPayload = {
                id: `chatcmpl-VCP-final-tool-calls-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: originalBody.model,
                choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
              };
              res.write(`data: ${JSON.stringify(finalToolChunkPayload)}\n\n`);
            }
            res.write('data: [DONE]\n\n', () => res.end());
          } catch (writeError) {
            console.error('[VCP Stream Loop] Failed to write final chunk:', writeError.message);
            if (!res.writableEnded && !res.destroyed) try { res.end(); } catch (e) { }
          }
        }
        completed = validUpstreamTurns;
        break;
      }

      const expandedCalls = await (toolExecutor.expandCalls?.(toolCalls) ?? toolCalls);
      if (abortController?.signal.aborted || res.destroyed || res.writableEnded) break;
      const { normal: normalCalls, archery: archeryCalls } = ToolCallParser.separate(expandedCalls);
      const archeryReceiptGroups = [];
      const archeryStatusSummaryItems = [];
      const visibleToolResults = [];
      const emitToolBatch = () => {
        if (res.writableEnded || res.destroyed || abortController?.signal.aborted) return;
        const content = formatToolResultBatch(visibleToolResults, enableRoleDivider);
        if (!content) return;
        res.write(`data: ${JSON.stringify({
          id: `chatcmpl-vcp-batch-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: originalBody.model,
          choices: [{ index: 0, delta: { content }, finish_reason: null }]
        })}\n\n`);
      };

      // 执行 Archery 调用
      const archeryLogs = await Promise.all(archeryCalls.map(async (toolCall, index) => {
        try {
          const result = await toolExecutor.execute(toolCall, clientIp, currentMessagesForLoop);
          const isError = !result.success || (result.raw && this.context.isToolResultError(result.raw));

          if (isError) {
            archeryStatusSummaryItems.push(`${toolCall.name} 调用失败${result.recordId ? ` (记录ID: ${result.recordId})` : ''}`);
            archeryReceiptGroups[index] = { name: toolCall.name, parts: [{
              type: 'text',
              text: `[异步工具 "${toolCall.name}" 返回了错误，请注意]:\n${result.content[0].text}`
            }] };
          } else if (result.approvalFeedbackContent?.length) {
            // 用户明确输入的审核留言优先于 archery 静默；只回灌留言，不回灌成功业务输出。
            archeryReceiptGroups[index] = { name: toolCall.name, parts: result.approvalFeedbackContent };
          }

          const forceThisOne = !shouldShowVCP && toolCall.markHistory;
          if ((shouldShowVCP || forceThisOne) && !res.writableEnded && (isError || forceThisOne)) {
            const text = vcpInfoHandler.streamVcpInfo(null, originalBody.model, toolCall.name, result.success ? 'success' : 'error', result.raw || result.error, abortController);
            if (text) visibleToolResults.push(text);
          }
          return { tool: toolCall, result: result.content };
        } catch (e) {
          console.error(`[VCP Stream Loop Archery Error] ${toolCall.name}:`, e);
          return { tool: toolCall, result: [{ type: 'text', text: String(e.message) }] };
        }
      }));
      const archeryGroups = archeryReceiptGroups.filter(Boolean);
      const archeryErrorContents = archeryGroups.flatMap(group => group.parts);

      // 处理纯 Archery 的错误或用户审核留言；成功留言不改变工具成功状态。
      if (normalCalls.length === 0 && archeryErrorContents.length > 0) {
        currentMessagesForLoop.push(await buildToolPayloadMessage(archeryGroups));

        if (!res.writableEnded && !res.destroyed) {
          try {
            if (archeryStatusSummaryItems.length > 0) {
              visibleToolResults.push(`\n[本轮工具调用摘要:]\n${archeryStatusSummaryItems.join('；')}。\n[本轮工具调用摘要结束]\n`);
            }
            emitToolBatch();
            res.write(`data: ${JSON.stringify({
              id: `chatcmpl-VCP-separator-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: originalBody.model,
              choices: [{ index: 0, delta: { content: '\n' }, finish_reason: null }],
            })}\n\n`);
          } catch (e) { }
        }

        if (this.context.handoffGate?.isReady()) await waitForHandoff();
        if (abortController.signal.aborted || res.writableEnded || res.destroyed) break;
        const archeryLoopBody = prepareLoopRequest(roundStartIndex);
        if (!archeryLoopBody) { completed = false; break; }
        const nextAiAPIResponse = await fetchWithRetry(
          `${apiUrl}/v1/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              Accept: 'text/event-stream',
            },
            body: JSON.stringify(archeryLoopBody),
            signal: abortController.signal,
          },
          { retries: apiRetries, delay: apiRetryDelay, debugMode: DEBUG_MODE, connectionTimeout: apiConnectionTimeoutMs, modelFallbackCandidates: semanticModelFallbackCandidates }
        );

        if (nextAiAPIResponse.ok) {
          let nextAIResponseData = await processAIResponseStreamHelper(nextAiAPIResponse, false);
          lastTurnSawNativeToolCall = Boolean(nextAIResponseData.sawNativeToolCall);
          lastTurnFinishReason = nextAIResponseData.finishReason || null;
          validUpstreamTurns = validUpstreamTurns && nextAIResponseData.completed;
          currentAIContentForLoop = nextAIResponseData.content;
          if (currentAIContentForLoop && currentAIContentForLoop.trim()) {
            oneRingAssistantTurnParts.push(currentAIContentForLoop);
          }
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
        if (!nextAiAPIResponse.ok) {
          await streamUpstreamErrorAndEnd(res, nextAiAPIResponse, originalBody?.model, 'Async Tool Loop');
          completed = false;
          break; // 异步工具错误后的上游失败，不得当作正常工具终结轮。
        }
      }

      if (normalCalls.length === 0) {
        emitToolBatch();
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
        completed = validUpstreamTurns && archeryErrorContents.length === 0;
        break;
      }

      // 执行普通调用（启动 SSE 保活心跳并刷新请求活性时间戳，防止长耗时工具/RAG刷新/下轮首字等待期间连接被误判为空闲）
      touchRequestActivity?.();
      const loopKeepAliveTimer = setInterval(() => {
        touchRequestActivity?.();
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.write(': vcp-tool-keepalive\n\n');
          } catch (e) { /* ignore */ }
        }
      }, 5000);
      loopKeepAliveTimer.unref?.();
      let toolResults;
      try {
        toolResults = await toolExecutor.executeAll(normalCalls, clientIp, currentMessagesForLoop);
      } catch (toolExecErr) {
        clearInterval(loopKeepAliveTimer);
        throw toolExecErr;
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

        if ((shouldShowVCP || forceThisOne) && !res.writableEnded && !res.destroyed) {
          const text = vcpInfoHandler.streamVcpInfo(null, originalBody.model, toolCall.name, result.success ? 'success' : 'error', result.raw || result.error, abortController);
          if (text) visibleToolResults.push(text);
        }
      }

      if (toolStatusSummaryItems.length > 0) {
        visibleToolResults.push(`\n[本轮工具调用摘要:]\n${toolStatusSummaryItems.join('；')}。\n[本轮工具调用摘要结束]\n`);
      }
      if (!res.writableEnded && !res.destroyed) {
        try { emitToolBatch(); } catch (e) {}
      }

      // RAG 保留原表示，与发给模型的内容块分开。
      if (RAGMemoRefresh) {
        const toolResultsTextForRAG = JSON.stringify([
          ...toolResults.flatMap(result => result.content), ...archeryErrorContents
        ], (k, v) =>
          (k === 'url' || k === 'image_url') && typeof v === 'string' && v.startsWith('data:') ? "[Omitted]" : v
        );
        currentMessagesForLoop = await _refreshRagBlocksIfNeeded(currentMessagesForLoop, {
          lastAiMessage: currentAIContentForLoop,
          toolResultsText: toolResultsTextForRAG
        }, pluginManager, DEBUG_MODE);
      }

      currentMessagesForLoop.push(await buildToolPayloadMessage([
        ...toolResults.map((result, index) => ({
          name: normalCalls[index]?.name,
          parts: result.contentForAI ?? result.content
        })),
        ...archeryGroups
      ], maybeTranslateToolPayloadMedia));

      if (!res.writableEnded && !res.destroyed) {
        try {
          res.write(`data: ${JSON.stringify({
            id: `chatcmpl-VCP-separator-${Date.now()}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: '\n' }, finish_reason: null }],
          })}\n\n`);
        } catch (e) { }
      }

      let nextAiAPIResponse;
      try {
        if (this.context.handoffGate?.isReady()) await waitForHandoff();
        if (abortController.signal.aborted || res.writableEnded || res.destroyed) break;
        const loopBody = prepareLoopRequest(roundStartIndex);
        if (!loopBody) { completed = false; break; }
        nextAiAPIResponse = await fetchWithRetry(
          `${apiUrl}/v1/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              Accept: 'text/event-stream',
            },
            body: JSON.stringify(loopBody),
            signal: abortController.signal,
          },
          { retries: apiRetries, delay: apiRetryDelay, debugMode: DEBUG_MODE, connectionTimeout: apiConnectionTimeoutMs, modelFallbackCandidates: semanticModelFallbackCandidates }
        );
      } finally {
        clearInterval(loopKeepAliveTimer);
      }

      if (!nextAiAPIResponse.ok) {
        await streamUpstreamErrorAndEnd(res, nextAiAPIResponse, originalBody?.model, 'Normal Tool Loop');
        completed = false;
        break;
      }

      let nextAIResponseData = await processAIResponseStreamHelper(nextAiAPIResponse, false);
      lastAIResponseData = nextAIResponseData;
      lastTurnSawNativeToolCall = Boolean(nextAIResponseData.sawNativeToolCall);
      lastTurnFinishReason = nextAIResponseData.finishReason || null;
      validUpstreamTurns = validUpstreamTurns && nextAIResponseData.completed;
      currentAIContentForLoop = nextAIResponseData.content;
      if (currentAIContentForLoop && currentAIContentForLoop.trim()) {
        oneRingAssistantTurnParts.push(currentAIContentForLoop);
      }
      if (writeChatLog) {
        chatLogs.push({
          request: { messages: currentMessagesForLoop },
          toolCalls: [ ...archeryLogs, ...normalCallLogs ],
          response: nextAIResponseData.message,
        });
      }

      recursionDepth++;
    } // toolcall loop end

    if (writeChatLog) writeChatLog(originalBody, chatLogs);
    // OneRing 由主流程在整轮完成且响应发送完成后提交。

    if (upstreamIdleTimedOut) {
      // 空闲超时与普通 stop / 轮数上限互斥；这里只写一次下游终态。
      if (!res.writableEnded && !res.destroyed) {
        try {
          const stallPayload = {
            id: `chatcmpl-VCP-stall-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: originalBody.model || 'unknown',
            vcp_incomplete: true,
            choices: [{ index: 0, delta: { content: '\n[上游响应超时，流已中断]' }, finish_reason: 'stop' }],
          };
          res.write(`data: ${JSON.stringify(stallPayload)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (writeError) {
          console.error('[Stream IdleTimeout] Failed to write final chunk:', writeError.message);
          if (!res.writableEnded && !res.destroyed) {
            try { res.end(); } catch { /* The failed response may no longer be writable. */ }
          }
        }
      }
    } else if (recursionDepth >= maxRecursion && !res.writableEnded && !res.destroyed) {
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
    return {
      completed: completed && !abortController?.signal.aborted && !res.destroyed,
      aiText: oneRingAssistantTurnParts.join('\n')
    };
  }
}

module.exports = StreamHandler;