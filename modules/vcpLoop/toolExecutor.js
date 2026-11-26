// modules/vcpLoop/toolExecutor.js
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { cosineSimilarity } = require('../../EmbeddingUtils');
const { findLastRealUserMessage } = require('../messageProcessor');
const toolCallRecordStore = require('../toolCallRecordStore');
const jevRiverReranker = require('../jevRiverReranker'); // river semantic:N 的级联第二阶段
const jevToolCallExp = require('../jevToolCallExp');
const { NATIVE_CALL_ID } = require('../nativeToolLoop');

const VCP_TIMED_CONTACTS_DIR = path.join(__dirname, '..', '..', 'VCPTimedContacts');
const JEV_PLANNING_ERROR = Symbol('jevPlanningError');

/**
 * 提取消息的纯文本字符串
 */
function getMessageTextContent(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n');
  }
  return '';
}

/**
 * 将多模态消息对象规范化为纯文本消息对象（保留 role 等元数据）
 * 复用 getMessageTextContent 提取文本
 */
function extractTextFromMessage(msg) {
  if (typeof msg.content === 'string') return msg;
  if (Array.isArray(msg.content)) {
    return { ...msg, content: getMessageTextContent(msg) };
  }
  return msg;
}

function projectRiverSpeaker(message) {
  const name = typeof message?.name === 'string' ? message.name.trim() : '';
  return name ? { name } : {};
}
class ToolExecutor {
  constructor(options) {
    this.pluginManager = options.pluginManager;
    this.webSocketServer = options.webSocketServer;
    this.debugMode = options.debugMode;
    this.vcpToolCode = options.vcpToolCode;
    this.getRealAuthCode = options.getRealAuthCode;
  }

  /**
   * 构建 VRef 上下文向量 — 将当前对话上下文压缩为一个加权平均向量，
   * 用于后续在知识库中进行语义检索。
   *
   * 设计要点：
   * - 仅使用 RAGDiaryPlugin 已缓存的向量（_getEmbeddingFromCacheOnly），
   *   绝不触发新的 Embedding API 调用，保证 vref 是零额外成本的旁路操作。
   * - 权重分配复用 RAG 主搜索权重（默认 user:0.7 / ai:0.3），
   *   确保 vref 检索方向与 RAG 检索方向一致。
   *
   * @param {Array} contextMessages - 当前对话的完整消息数组
   * @returns {Promise<Float32Array|null>} 加权上下文向量，或 null（缓存未命中/不可用时）
   */
  async _buildVRefContextVector(contextMessages = []) {
    // 依赖 RAGDiaryPlugin 的三个内部方法：清洗、缓存查询、加权平均
    const ragPlugin = this.pluginManager?.messagePreprocessors?.get('RAGDiaryPlugin');
    if (
      !ragPlugin ||
      typeof ragPlugin.sanitizeForEmbedding !== 'function' ||
      typeof ragPlugin._getEmbeddingFromCacheOnly !== 'function' ||
      typeof ragPlugin._getWeightedAverageVector !== 'function'
    ) {
      console.warn('[VRef] RAGDiaryPlugin 不可用，跳过 vref 向量构建。');
      return null;
    }

    const { index: lastUserIndex, sanitizedContent: userContent } = findLastRealUserMessage(contextMessages, {
      sanitize: ragPlugin.sanitizeForEmbedding.bind(ragPlugin)
    });
    if (lastUserIndex === -1) return null;

    // 向前搜索最近一条 AI 回复，作为上下文的另一半
    let rawAiContent = '';
    for (let i = lastUserIndex - 1; i >= 0; i--) {
      if (contextMessages[i].role === 'assistant') {
        rawAiContent = getMessageTextContent(contextMessages[i]);
        break;
      }
    }

    // 清洗文本（去除 RAG 块、系统标记等噪声）

    const aiContent = rawAiContent
      ? ragPlugin.sanitizeForEmbedding(rawAiContent, 'assistant')
      : '';

    // 仅从缓存获取向量 — 如果本轮 RAG 已执行过，这些向量必然已在缓存中
    const userVector = userContent
      ? ragPlugin._getEmbeddingFromCacheOnly(userContent, 'user')
      : null;
    const aiVector = aiContent
      ? ragPlugin._getEmbeddingFromCacheOnly(aiContent, 'assistant')
      : null;

    if (!userVector && !aiVector) {
      console.warn('[VRef] 上下文向量未命中缓存，为避免额外 API 调用，跳过 vref。');
      return null;
    }

    // 复用 RAG 主搜索的 user/ai 权重配比（默认 0.7/0.3）
    const mainWeights = ragPlugin.ragParams?.RAGDiaryPlugin?.mainSearchWeights || [0.7, 0.3];
    return ragPlugin._getWeightedAverageVector([userVector, aiVector], mainWeights);
  }

  /**
   * 解析 vref 参数，返回与当前上下文语义最相关的 N 个日记文件 URL。
   *
   * 算法流程：
   * 1. 构建上下文向量（复用 RAG 缓存，零额外 API 调用）
   * 2. 在所有知识库分区（diary_name）中并行检索 Top-N
   * 3. 按文件路径去重（同一文件多个 chunk 只保留最高分）
   * 4. 全局排序取 Top-N，转换为 file:// URL 供插件读取
   *
   * @param {string} vrefValue - vref 参数值，应为正整数字符串（如 "3"、"5"），
   *                             表示返回的最大文件数。解析失败时默认为 3。
   * @param {Array} contextMessages - 当前对话的完整消息数组
   * @returns {Promise<string[]>} file:// URL 数组（长度 ≤ N）
   */
  async _resolveVRefFiles(vrefValue, contextMessages = []) {
    const kbManager = this.pluginManager?.vectorDBManager;
    if (
      !kbManager
      || typeof kbManager.listDistinctDiaries !== 'function'
      || typeof kbManager.search !== 'function'
    ) {
      console.warn('[VRef] VectorDBManager 原生知识库接口不可用，跳过 vref。');
      return [];
    }

    // Step 1: 构建上下文向量
    const contextVector = await this._buildVRefContextVector(contextMessages);
    if (!contextVector) return [];

    // 从 AI 传入的 vref 值解析返回数量（如 vref:「始」5「末」→ n=5）
    const parsedN = parseInt(vrefValue, 10);
    const n = Number.isFinite(parsedN) && parsedN > 0 ? parsedN : 3;

    // Step 2: 通过 Rust 高层接口获取所有知识库分区名，在每个分区中并行检索。
    const diaryNames = await kbManager.listDistinctDiaries();
    if (!Array.isArray(diaryNames) || diaryNames.length === 0) {
      return [];
    }

    const resultGroups = await Promise.all(
      diaryNames.map(diaryName => kbManager.search(diaryName, contextVector, n))
    );

    // Step 3: 按文件路径去重 — 同一文件可能有多个 chunk 命中，只保留最高分
    const bestByFile = new Map();
    for (const result of resultGroups.flat()) {
      const relativePath = result?.fullPath || result?.sourceFile;
      if (!relativePath) continue;

      const previous = bestByFile.get(relativePath);
      if (!previous || (result.score ?? -Infinity) > (previous.score ?? -Infinity)) {
        bestByFile.set(relativePath, result);
      }
    }

    const dailyNoteRoot = kbManager.config?.rootPath || path.resolve(process.cwd(), 'dailynote');

    // Step 4: 全局排序取 Top-N，转换为 file:// URL
    return Array.from(bestByFile.values())
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, n)
      .map(result => {
        const filePath = result.fullPath || result.sourceFile;
        const absolutePath = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(dailyNoteRoot, filePath);
        return pathToFileURL(absolutePath).href;
      });
  }

  // Expand before the loop splits normal/archery calls, so each real call
  // reaches the same executor and receipt pipeline as a direct VCP request.
  async expandCalls(toolCalls) {
    if (!toolCalls.some(call => jevToolCallExp.isVirtualToolName(call.name))) return toolCalls;

    const groups = await Promise.all(toolCalls.map(async call => {
      if (!jevToolCallExp.isVirtualToolName(call.name)) return [call];
      try {
        const planned = await jevToolCallExp.plan(call.args?.expression, call);
        if (planned.length > 0 && call[NATIVE_CALL_ID]) {
          return planned.map(child => ({ ...child, [NATIVE_CALL_ID]: call[NATIVE_CALL_ID] }));
        }
        return planned.length > 0 ? planned : [
          { ...call, [JEV_PLANNING_ERROR]: 'JEV 没有生成可执行的真实工具调用。' }
        ];
      } catch (error) {
        return [{ ...call, [JEV_PLANNING_ERROR]: `JEV 规划错误: ${error.message}` }];
      }
    }));
    return groups.flat();
  }

  /**
   * 执行单个工具调用
   * @returns {Promise<{success: boolean, content: Array, contentForAI?: Array, error?: string, raw?: any}>}
   */
  async execute(toolCall, clientIp, contextMessages = []) {
    const { name, args, river, vref, archeryNoReply } = toolCall;
    if (toolCall[JEV_PLANNING_ERROR]) {
      return this._createErrorResult(name, toolCall[JEV_PLANNING_ERROR]);
    }
    if (jevToolCallExp.isVirtualToolName(name)) {
      return this._createErrorResult(name, 'JEV 虚拟调用必须先由工具循环展开。');
    }

    // === river 上下文注入 ===
    // river 协议允许 AI 在工具调用时携带对话上下文，支持四种模式：
    //   full     — 原始多模态消息（含图片等），完整深拷贝
    //   text     — 多模态转纯文本，减少传输体积
    //   last:N   — 仅取最后 N 条消息（纯文本）
    //   semantic:N — 语义折叠，用工具参数作为 query 检索最相关的 N 条消息
    if (this.debugMode) console.log(`[ToolExecutor] Processing tool: ${name}, river mode: ${river}`);
    if (name === 'TopicSponsor') {
      // river_context is injected by the executor, not supplied by the caller.
      delete args.river_context;
      if (args.command === 'ReplyToTopic' && river != null) {
        const count = /^last:([1-9]\d*)$/.exec(river)?.[1];
        const n = Number.isSafeInteger(Number(count)) ? Number(count) : 5;
        args.river_context = contextMessages.slice(-n).flatMap(message => {
          if (message?.role !== 'user' && message?.role !== 'assistant') return [];
          const content = getMessageTextContent(message)
            .replace(/data:[^,\s"'<>]*;base64,[A-Za-z0-9+/_=-]*/gi, '');
          return [{ role: message.role, content, ...projectRiverSpeaker(message) }];
        });
      }
    } else if (river === 'full') {
      args.river_context = JSON.parse(JSON.stringify(contextMessages));
    } else if (river === 'text') {
      args.river_context = contextMessages.map(msg => extractTextFromMessage(msg));
    }
    // === last:N 模式 — 取最后 N 条消息（纯文本） ===
    else if (river && river.startsWith('last:')) {
      const n = parseInt(river.split(':')[1]) || 10;
      const textOnly = contextMessages.map(msg => extractTextFromMessage(msg));
      args.river_context = textOnly.slice(-n);
    }
    // === semantic:N 模式 — 语义折叠取 Top-N 最相关消息 ===
    else if (river && river.startsWith('semantic:')) {
      const n = parseInt(river.split(':')[1]) || 5;
      
      // 1. 构建查询文本：用工具调用的参数拼接
      const queryParts = [];
      for (const [key, value] of Object.entries(args)) {
        if (key === 'river_context') continue;
        if (typeof value === 'string' && value.length > 0) {
          queryParts.push(value);
        }
      }
      const queryText = queryParts.join(' ').slice(0, 2000);
      
      // 2. 提取每条消息的纯文本
      const textMessages = contextMessages.map((msg, idx) => ({
        index: idx,
        role: msg.role,
        text: getMessageTextContent(msg),
        original: msg
      })).filter(m => m.text.length > 10);
      
      // 3. 尝试语义检索，失败则优雅回退到 last:N（保证工具调用不会因向量化失败而中断）
      try {
        const ragPlugin = this.pluginManager?.messagePreprocessors?.get('RAGDiaryPlugin');
        if (typeof ragPlugin?.getSingleEmbeddingCached !== 'function' ||
            typeof ragPlugin?.sanitizeForEmbedding !== 'function') {
          throw new Error('Shared context embedding service unavailable');
        }

        const queryVec = await ragPlugin.getSingleEmbeddingCached(queryText.slice(0, 1000));
        if (!queryVec) throw new Error('Query embedding returned null');

        // Bound concurrent cache misses for long histories; each block still shares RAG single-flight.
        const messageVectors = new Array(textMessages.length);
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(8, textMessages.length) }, async () => {
          while (cursor < textMessages.length) {
            const i = cursor++;
            const { text, role } = textMessages[i];
            const contextRole = role === 'user' || role === 'assistant' ? role : 'tool';
            messageVectors[i] = await ragPlugin.getSingleEmbeddingCached(
              ragPlugin.sanitizeForEmbedding(text, role), { contextRole }
            );
          }
        }));
        
        // 4. 计算余弦相似度并排序
        const scored = textMessages.map((m, i) => ({
          ...m,
          score: messageVectors[i] ? cosineSimilarity(queryVec, messageVectors[i]) : 0
        }));
        
        scored.sort((a, b) => b.score - a.score);
        
        // 5. 取 Top-N，按原始顺序排列
        // 若开启 JevRiverRerank，则 embedding 只负责"别漏"（出 Top-K），
        // 由 Jev 在 K 内重排出 N 条（负责"别滥"）；任何失败都保留 embedding 的 Top-N。
        let topN = scored.slice(0, n);
        if (jevRiverReranker.isEnabled()) {
          try {
            const rerank = await jevRiverReranker.rerankTopN({
              queryText,
              items: scored,
              n,
              debug: this.debugMode
            });
            if (rerank.applied && Array.isArray(rerank.selected) && rerank.selected.length > 0) {
              topN = rerank.selected;
            } else if (this.debugMode && rerank && !rerank.applied) {
              console.log(`[River] Jev 重排未生效(${rerank.reason})，保留 embedding 的 Top-${n}`);
            }
          } catch (e) {
            // 绝不能让重排异常冒泡到外层 catch——那会连带丢掉 embedding 结果、退回 last:N
            if (this.debugMode) console.log(`[River] Jev 重排异常，保留 embedding 结果: ${e && e.message}`);
          }
        }
        topN.sort((a, b) => a.index - b.index);
        
        args.river_context = topN.map(m => ({
          role: m.role,
          content: m.text,
          ...projectRiverSpeaker(m.original),
          _river_score: m.score,
          _river_index: m.index
        }));
        
        if (this.debugMode) {
          console.log(`[ToolExecutor] Semantic river: selected ${topN.length} messages from ${textMessages.length} candidates (via ${ragPlugin ? 'RAGDiaryPlugin cache' : 'EmbeddingUtils'})`);
        }
        
      } catch (err) {
        console.warn(`[River] Semantic mode failed, falling back to last:${n}:`, err.message);
        // 回退到 last:N
        const textOnly = contextMessages.map(msg => extractTextFromMessage(msg));
        args.river_context = textOnly.slice(-n);
      }
    }
    if (this.debugMode && args.river_context) {
      console.log(`[ToolExecutor] river_context injected: ${args.river_context.length} messages`);
    }

    // === vref 虚拟引用解析 ===
    // vref 允许 AI 在工具调用时自动附加语义相关的知识库文件引用，
    // 插件通过 args.vref_files（file:// URL 数组）获取这些引用。
    if (vref) {
      try {
        args.vref_files = await this._resolveVRefFiles(vref, contextMessages);
        if (this.debugMode) {
          console.log(`[VRef] Resolved ${args.vref_files.length} references for vref:${vref}`);
        }
      } catch (err) {
        args.vref_files = [];
        console.warn('[VRef] Failed to resolve references:', err.message);
      }
    }

    const recordHandle = toolCallRecordStore.beginRecord({
      toolName: name,
      args,
      requestIp: clientIp,
      sourceNode: 'post'
    });

    // 通用未来任务拦截：
    // 任意工具只要携带 timely_contact，就先写入 VCPTimedContacts 由任务调度器到点执行。
    // 到点执行时由 TaskScheduler 注入 __vcp_timed_call 标准元信息；
    // 插件可基于该字段判断原始发起时间、计划触发时间与实际触发时间。
    if (args && Object.prototype.hasOwnProperty.call(args, 'timely_contact')) {
      const scheduledResult = await this._scheduleTimedToolCall(toolCall);
      toolCallRecordStore.finishRecord(recordHandle, {
        success: scheduledResult.success,
        result: scheduledResult.raw || scheduledResult.content,
        error: scheduledResult.success ? null : scheduledResult.error
      });
      return this._attachRecordIdToResult(scheduledResult, recordHandle);
    }

    // 验证码校验
    if (this.vcpToolCode) {
      const authResult = await this._verifyAuth(args);
      if (!authResult.valid) {
        const errorResult = this._createErrorResult(name, authResult.message);
        toolCallRecordStore.finishRecord(recordHandle, {
          success: false,
          result: errorResult.content,
          error: authResult.message
        });
        return this._attachRecordIdToResult(errorResult, recordHandle);
      }
    }

    // 检查插件是否存在
    if (!this.pluginManager.getPlugin(name)) {
      const message = `未找到名为 "${name}" 的插件`;
      const errorResult = this._createErrorResult(name, message);
      toolCallRecordStore.finishRecord(recordHandle, {
        success: false,
        result: errorResult.content,
        error: message
      });
      return this._attachRecordIdToResult(errorResult, recordHandle);
    }

    // 执行插件
    try {
      if (this.debugMode) console.log(`[ToolExecutor] Calling processToolCall for ${name} with args keys: ${Object.keys(args).join(', ')}`);
      const result = await this.pluginManager.processToolCall(name, args, clientIp, 'post', {
        archeryNoReply: !!archeryNoReply,
        toolCallRecordHandle: recordHandle
      });
      const processedResult = this._processResult(name, result);
      // 与 _processResult 的 success 判定保持一致：
      // 插件若显式返回 { success: false }，记录必须落为失败，不能硬编码成功。
      toolCallRecordStore.finishRecord(recordHandle, {
        success: processedResult.success,
        result,
        error: processedResult.error || null
      });
      return this._attachRecordIdToResult(processedResult, recordHandle);
    } catch (error) {
      const errorResult = this._createErrorResult(name, `执行错误: ${error.message}`);
      toolCallRecordStore.finishRecord(recordHandle, {
        success: false,
        result: errorResult.content,
        error
      });
      return this._attachRecordIdToResult(errorResult, recordHandle);
    }
  }

  /**
   * 批量执行工具调用
   */
  async executeAll(toolCalls, clientIp, contextMessages = []) {
    return Promise.all(
      toolCalls.map(tc => this.execute(tc, clientIp, contextMessages))
    );
  }

  _attachRecordIdToResult(result, recordHandle) {
    if (!recordHandle || !recordHandle.id || !result || typeof result !== 'object') {
      return result;
    }
    result.recordId = recordHandle.id;
    if (result.raw && typeof result.raw === 'object' && !result.raw.tool_call_record_id) {
      result.raw.tool_call_record_id = recordHandle.id;
    }
    return result;
  }

  _processResult(toolName, result) {
    const formatted = this._formatResult(result);
    
    // WebSocket广播：即使是 archery no-reply 静默结果，也保留 VCPLog 可见性。
    this._broadcast(toolName, 'success', formatted.text);

    // archery no-reply 的“静默”只表示不回灌给 AI / 不触发二次 loop；
    // 用户侧仍应通过 VCPInfo WS 看到工具已被接收，后续真实进度由插件自己的 VCPLog/VCPInfo 继续推送。
    if (result && typeof result === 'object' && result.__vcpArcheryNoReplySilent) {
      try {
        const vcpLogFunctions = this.pluginManager?.getVCPLogFunctions?.();
        if (vcpLogFunctions && typeof vcpLogFunctions.pushVcpInfo === 'function') {
          vcpLogFunctions.pushVcpInfo({
            type: 'TOOL_NO_REPLY_ACCEPTED',
            toolName,
            status: 'success',
            noReply: true,
            message: result.message || `Async no-reply tool "${toolName}" accepted silently.`,
            timestamp: new Date().toISOString()
          });
        }
      } catch (broadcastError) {
        if (this.debugMode) {
          console.warn(`[ToolExecutor] Failed to broadcast no-reply VCPInfo for ${toolName}: ${broadcastError.message}`);
        }
      }
    }
    
    // 内层显式声明 success:false 时必须透传：审核带用户反馈的拒绝依赖该标志，
    // 否则 archery 循环的 isError 判定会把反馈当作成功结果静默丢弃。
    const innerFailed = !!(result && typeof result === 'object' && result.success === false);

    return {
      success: !innerFailed,
      error: innerFailed ? (result.error || formatted.text) : undefined,
      content: formatted.content,
      ...(formatted.contentForAI ? { contentForAI: formatted.contentForAI } : {}),
      approvalFeedbackContent: result?.__vcpApprovalFeedback
        ? [{ type: 'text', text: `【用户审核留言：已允许工具 "${toolName}" 调用】\n${result.__vcpApprovalFeedback}` }]
        : [],
      raw: result
    };
  }

  _formatResult(result) {
    if (result === undefined || result === null) {
      return { text: '(无返回内容)', content: [{ type: 'text', text: '(无返回内容)' }] };
    }

    const feedback = typeof result?.__vcpApprovalFeedback === 'string'
      ? result.__vcpApprovalFeedback.trim()
      : '';
    const suffix = feedback ? `\n\n【用户审核留言：已允许本次工具调用】\n${feedback}` : '';

    // 标准多模态回执只修改最后一个 text 块，绝不字符串化或改写图片等非文本块。
    if (typeof result === 'object') {
      const richContent = Array.isArray(result) ? result : (result.data?.content || result.content);
      if (Array.isArray(richContent)) {
        let content = richContent;
        if (suffix) {
          content = richContent.slice();
          const lastTextIndex = content.findLastIndex(part => part?.type === 'text' && typeof part.text === 'string');
          if (lastTextIndex >= 0) {
            content[lastTextIndex] = { ...content[lastTextIndex], text: content[lastTextIndex].text + suffix };
          } else {
            content.push({ type: 'text', text: suffix.trimStart() });
          }
        }
        const textPart = content.find(p => p?.type === 'text');
        return {
          text: textPart?.text || '[Rich Content]',
          content
        };
      }
    }

    // 内部审核元信息不作为业务字段重复展示，旧回执统一在文本尾部附加留言。
    let displayResult = result;
    if (feedback && typeof result === 'object') {
      const { __vcpApprovalFeedback, ...businessResult } = result;
      displayResult = businessResult;
    }
    const text = (typeof displayResult === 'object'
      ? JSON.stringify(displayResult, null, 2)
      : String(displayResult)) + suffix;
    // The plugin bridge wraps a scalar result with these metadata fields. For the model
    // only, expose its body directly. Do not parse JSON embedded in existing text parts
    // or strip fields from a business object that merely happens to use the same key.
    const scalarOutput = typeof displayResult === 'object' &&
      Object.hasOwn(displayResult, 'original_plugin_output') &&
      typeof displayResult.original_plugin_output === 'string' &&
      Object.keys(displayResult).every(key =>
        ['original_plugin_output', 'MaidName', 'timestamp', 'tool_call_record_id'].includes(key));
    return {
      text,
      content: [{ type: 'text', text }],
      ...(scalarOutput ? {
        contentForAI: [{ type: 'text', text: displayResult.original_plugin_output + suffix }]
      } : {})
    };
  }

  _createErrorResult(toolName, message) {
    this._broadcast(toolName, 'error', message);

    // 上层抛出的业务错误通常是 JSON 字符串（plugin_error / error_type / user_feedback…）。
    // 直接把转义串喂给 AI 会变成噪声，这里解出可读文本，并保留结构化原文到 raw。
    //
    // 注意：真实调用链里 ToolExecutor 的 catch 会给 error.message 套上 `执行错误: ` 前缀，
    // 若直接对 message 做 startsWith('{') 判断将恒为 false，JSON 解析分支永不生效。
    // 因此先剥掉已知的包装前缀，再对剩余部分尝试解析。
    const rawMessage = typeof message === 'string' ? message : String(message);
    const jsonCandidate = rawMessage.replace(/^执行错误:\s*/, '');
    let displayText = rawMessage;
    let parsedPayload = null;
    if (jsonCandidate.trim().startsWith('{')) {
      try {
        parsedPayload = JSON.parse(jsonCandidate);
        const readableParts = [];
        if (parsedPayload.plugin_error) readableParts.push(parsedPayload.plugin_error);
        if (parsedPayload.user_feedback && !String(parsedPayload.plugin_error || '').includes(parsedPayload.user_feedback)) {
          readableParts.push('用户反馈: ' + parsedPayload.user_feedback);
        }
        if (readableParts.length > 0) displayText = readableParts.join('\n');
        if (parsedPayload.__vcpApprovalFeedback) {
          displayText += `\n\n【用户审核留言：已允许工具 "${toolName}" 调用】\n${parsedPayload.__vcpApprovalFeedback}`;
        }
      } catch (_parseError) {
        // 不是合法 JSON，保持原字符串。
      }
    }

    return {
      success: false,
      error: message,
      content: [{ type: 'text', text: `[错误] ${displayText}` }],
      ...(parsedPayload ? { raw: parsedPayload } : {})
    };
  }

  _broadcast(toolName, status, content) {
    this.webSocketServer.broadcast({
      type: 'vcp_log',
      data: { tool_name: toolName, status, content }
    }, 'VCPLog');
  }

  async _scheduleTimedToolCall(toolCall) {
    const { name, args } = toolCall;
    const timelyContact = args?.timely_contact;
    const targetDate = this._parseAndValidateTimedContact(timelyContact);
    if (!targetDate) {
      return this._createErrorResult(name, `无效的 'timely_contact' 时间格式: '${timelyContact}'。请使用 YYYY-MM-DD-HH:mm 格式，或可被 Date 解析的未来时间。`);
    }
    if (targetDate === 'past') {
      return this._createErrorResult(name, `无效的 'timely_contact' 时间: '${timelyContact}'。不能设置为过去或当前时间。`);
    }

    if (!this.pluginManager.getPlugin(name)) {
      return this._createErrorResult(name, `未找到名为 "${name}" 的插件`);
    }

    const scheduledArgs = JSON.parse(JSON.stringify(args || {}));
    const requestedAt = this._formatToLocalDateTimeWithOffset(new Date());

    const taskId = `task-${targetDate.getTime()}-${crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')}`;
    const taskData = {
      taskId,
      createdAt: requestedAt,
      scheduledLocalTime: this._formatToLocalDateTimeWithOffset(targetDate),
      tool_call: {
        tool_name: name,
        arguments: scheduledArgs
      },
      requestor: `ToolExecutor: ${name}`
    };

    try {
      await fs.mkdir(VCP_TIMED_CONTACTS_DIR, { recursive: true });
      const taskFilePath = path.join(VCP_TIMED_CONTACTS_DIR, `${taskId}.json`);
      await fs.writeFile(taskFilePath, JSON.stringify(taskData, null, 2), 'utf-8');

      const receipt = `任务已成功调度。\n工具: ${name}\n任务ID: ${taskId}\n发起时间: ${requestedAt}\n计划时间: ${taskData.scheduledLocalTime}\n到点执行时系统会注入 __vcp_timed_call 标准元信息。`;
      this._broadcast(name, 'success', receipt);
      return {
        success: true,
        content: [{ type: 'text', text: receipt }],
        raw: {
          status: 'success',
          scheduled: true,
          taskId,
          tool_name: name,
          requestedAt,
          scheduledTime: taskData.scheduledLocalTime
        }
      };
    } catch (error) {
      return this._createErrorResult(name, `创建定时任务失败: ${error.message}`);
    }
  }

  _parseAndValidateTimedContact(value) {
    if (!value) return null;

    const raw = String(value).trim();
    const standardized = raw.replace(/[\/\.]/g, '-');
    const compactMatch = standardized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})-(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);

    let date;
    if (compactMatch) {
      const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw] = compactMatch;
      const year = Number(yearRaw);
      const month = Number(monthRaw);
      const day = Number(dayRaw);
      const hour = Number(hourRaw);
      const minute = Number(minuteRaw);
      const second = secondRaw === undefined ? 0 : Number(secondRaw);

      date = new Date(year, month - 1, day, hour, minute, second);
      if (
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day ||
        date.getHours() !== hour ||
        date.getMinutes() !== minute ||
        date.getSeconds() !== second
      ) {
        return null;
      }
    } else {
      date = new Date(raw);
      if (Number.isNaN(date.getTime())) return null;
    }

    if (date.getTime() <= Date.now()) return 'past';
    return date;
  }

  _formatToLocalDateTimeWithOffset(date) {
    const pad = (value, length = 2) => String(value).padStart(length, '0');
    const timezoneOffsetMinutes = date.getTimezoneOffset();
    const offsetSign = timezoneOffsetMinutes > 0 ? '-' : '+';
    const offsetHours = pad(Math.floor(Math.abs(timezoneOffsetMinutes) / 60));
    const offsetMinutes = pad(Math.abs(timezoneOffsetMinutes) % 60);

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offsetSign}${offsetHours}:${offsetMinutes}`;
  }

  async _verifyAuth(args) {
    const realCode = await this.getRealAuthCode(this.debugMode);
    const provided = args.tool_password;
    delete args.tool_password;

    if (!realCode || provided !== realCode) {
      return { valid: false, message: 'tool_password 验证失败' };
    }
    return { valid: true };
  }
}

module.exports = ToolExecutor;
