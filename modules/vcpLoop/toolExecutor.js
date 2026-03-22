// modules/vcpLoop/toolExecutor.js
const path = require('path');
const { pathToFileURL } = require('url');
const { getEmbeddingsBatch, cosineSimilarity } = require('../../EmbeddingUtils');

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

    // 定位最后一条"真实"用户消息（排除工具回包和系统注入）
    const lastUserIndex = contextMessages.findLastIndex(msg => {
      if (msg.role !== 'user') return false;
      const content = getMessageTextContent(msg);
      return !content.startsWith('<!-- VCP_TOOL_PAYLOAD -->') &&
        !content.startsWith('[系统提示:]') &&
        !content.startsWith('[系统邀请指令:]');
    });

    if (lastUserIndex === -1) {
      console.warn('[VRef] 未找到可用的 user 消息，跳过 vref。');
      return null;
    }

    const rawUserContent = getMessageTextContent(contextMessages[lastUserIndex]);

    // 向前搜索最近一条 AI 回复，作为上下文的另一半
    let rawAiContent = '';
    for (let i = lastUserIndex - 1; i >= 0; i--) {
      if (contextMessages[i].role === 'assistant') {
        rawAiContent = getMessageTextContent(contextMessages[i]);
        break;
      }
    }

    // 清洗文本（去除 RAG 块、系统标记等噪声）
    const userContent = ragPlugin.sanitizeForEmbedding(rawUserContent, 'user');
    const aiContent = rawAiContent
      ? ragPlugin.sanitizeForEmbedding(rawAiContent, 'assistant')
      : '';

    // 仅从缓存获取向量 — 如果本轮 RAG 已执行过，这些向量必然已在缓存中
    const userVector = userContent
      ? ragPlugin._getEmbeddingFromCacheOnly(userContent)
      : null;
    const aiVector = aiContent
      ? ragPlugin._getEmbeddingFromCacheOnly(aiContent)
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
    if (!kbManager || !kbManager.db) {
      console.warn('[VRef] VectorDBManager 不可用，跳过 vref。');
      return [];
    }

    // Step 1: 构建上下文向量
    const contextVector = await this._buildVRefContextVector(contextMessages);
    if (!contextVector) return [];

    // 从 AI 传入的 vref 值解析返回数量（如 vref:「始」5「末」→ n=5）
    const parsedN = parseInt(vrefValue, 10);
    const n = Number.isFinite(parsedN) && parsedN > 0 ? parsedN : 3;

    // Step 2: 获取所有知识库分区名，在每个分区中并行检索
    const diaryRows = kbManager.db.prepare('SELECT DISTINCT diary_name FROM files').all();
    if (!Array.isArray(diaryRows) || diaryRows.length === 0) {
      return [];
    }

    const resultGroups = await Promise.all(
      diaryRows.map(({ diary_name }) => kbManager.search(diary_name, contextVector, n))
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

  /**
   * 执行单个工具调用
   * @returns {Promise<{success: boolean, content: Array, error?: string, raw?: any}>}
   */
  async execute(toolCall, clientIp, contextMessages = []) {
    const { name, args, river, vref } = toolCall;

    // === river 上下文注入 ===
    // river 协议允许 AI 在工具调用时携带对话上下文，支持四种模式：
    //   full     — 原始多模态消息（含图片等），完整深拷贝
    //   text     — 多模态转纯文本，减少传输体积
    //   last:N   — 仅取最后 N 条消息（纯文本）
    //   semantic:N — 语义折叠，用工具参数作为 query 检索最相关的 N 条消息
    if (this.debugMode) console.log(`[ToolExecutor] Processing tool: ${name}, river mode: ${river}`);
    if (river === 'full') {
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
        // 优先走 RAGDiaryPlugin 缓存通道：本轮对话的消息向量大概率已被 RAG 流程缓存，
        // 复用缓存可避免重复 API 调用。仅当 ragPlugin 不可用时回退到 EmbeddingUtils 独立通道。
        const ragPlugin = this.pluginManager?.messagePreprocessors?.get('RAGDiaryPlugin');
        
        let queryVec = null;
        let messageVectors = [];
        
        if (ragPlugin && typeof ragPlugin.getBatchEmbeddingsCached === 'function') {
          // 走 RAGDiaryPlugin 缓存通道：逐条查缓存，未命中的批量发 API
          const allTexts = [
            queryText.slice(0, 1000),
            ...textMessages.map(m => m.text.slice(0, 1000))
          ];
          const allVectors = await ragPlugin.getBatchEmbeddingsCached(allTexts);
          queryVec = allVectors[0];
          messageVectors = allVectors.slice(1);
        } else {
          // 回退：ragPlugin 不可用时，走 EmbeddingUtils 独立通道
          const embeddingConfig = {
            apiKey: process.env.API_KEY,
            apiUrl: process.env.API_URL,
            model: process.env.WhitelistEmbeddingModel || 'google/gemini-embedding-001'
          };
          const allTexts = [
            queryText.slice(0, 1000),
            ...textMessages.map(m => m.text.slice(0, 1000))
          ];
          const allVectors = await getEmbeddingsBatch(allTexts, embeddingConfig);
          queryVec = allVectors[0];
          messageVectors = allVectors.slice(1);
        }
        
        if (!queryVec) {
          throw new Error('Query embedding returned null');
        }
        
        // 4. 计算余弦相似度并排序
        const scored = textMessages.map((m, i) => ({
          ...m,
          score: messageVectors[i] ? cosineSimilarity(queryVec, messageVectors[i]) : 0
        }));
        
        scored.sort((a, b) => b.score - a.score);
        
        // 5. 取 Top-N，按原始顺序排列
        const topN = scored.slice(0, n);
        topN.sort((a, b) => a.index - b.index);
        
        args.river_context = topN.map(m => ({
          role: m.role,
          content: m.text,
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

    // 验证码校验
    if (this.vcpToolCode) {
      const authResult = await this._verifyAuth(args);
      if (!authResult.valid) {
        return this._createErrorResult(name, authResult.message);
      }
    }

    // 检查插件是否存在
    if (!this.pluginManager.getPlugin(name)) {
      return this._createErrorResult(name, `未找到名为 "${name}" 的插件`);
    }

    // 执行插件
    try {
      if (this.debugMode) console.log(`[ToolExecutor] Calling processToolCall for ${name} with args keys: ${Object.keys(args).join(', ')}`);
      const result = await this.pluginManager.processToolCall(name, args, clientIp);
      return this._processResult(name, result);
    } catch (error) {
      return this._createErrorResult(name, `执行错误: ${error.message}`);
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

  _processResult(toolName, result) {
    const formatted = this._formatResult(result);
    
    // WebSocket广播
    this._broadcast(toolName, 'success', formatted.text);
    
    return {
      success: true,
      content: formatted.content,
      raw: result
    };
  }

  _formatResult(result) {
    if (result === undefined || result === null) {
      return { text: '(无返回内容)', content: [{ type: 'text', text: '(无返回内容)' }] };
    }

    // 检查是否为富内容格式
    if (typeof result === 'object') {
      const richContent = result.data?.content || result.content;
      if (Array.isArray(richContent)) {
        const textPart = richContent.find(p => p.type === 'text');
        return {
          text: textPart?.text || '[Rich Content]',
          content: richContent
        };
      }
    }

    const text = typeof result === 'object' 
      ? JSON.stringify(result, null, 2) 
      : String(result);
    
    return {
      text,
      content: [{ type: 'text', text }]
    };
  }

  _createErrorResult(toolName, message) {
    this._broadcast(toolName, 'error', message);
    return {
      success: false,
      error: message,
      content: [{ type: 'text', text: `[错误] ${message}` }]
    };
  }

  _broadcast(toolName, status, content) {
    this.webSocketServer.broadcast({
      type: 'vcp_log',
      data: { tool_name: toolName, status, content }
    }, 'VCPLog');
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
