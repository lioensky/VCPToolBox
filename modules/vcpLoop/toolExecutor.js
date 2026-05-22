// modules/vcpLoop/toolExecutor.js
const path = require('path');
const { pathToFileURL } = require('url');
const { getEmbeddingsBatch, cosineSimilarity } = require('../../EmbeddingUtils');
const { normalizeExecutionContext } = require('../toolExecutionContext');

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

  async _buildVRefContextVector(contextMessages = []) {
    const ragPlugin = this.pluginManager?.messagePreprocessors?.get('RAGDiaryPlugin');
    if (
      !ragPlugin ||
      typeof ragPlugin.sanitizeForEmbedding !== 'function' ||
      typeof ragPlugin._getEmbeddingFromCacheOnly !== 'function' ||
      typeof ragPlugin._getWeightedAverageVector !== 'function'
    ) {
      console.warn('[VRef] RAGDiaryPlugin unavailable, skip vref context vector build.');
      return null;
    }

    const lastUserIndex = contextMessages.findLastIndex(msg => {
      if (msg.role !== 'user') return false;
      const content = getMessageTextContent(msg);
      return !content.startsWith('<!-- VCP_TOOL_PAYLOAD -->') &&
        !content.startsWith('[系统提示:]') &&
        !content.startsWith('[系统邀请指令]');
    });

    if (lastUserIndex === -1) {
      console.warn('[VRef] No usable user message found, skip vref.');
      return null;
    }

    const rawUserContent = getMessageTextContent(contextMessages[lastUserIndex]);

    let rawAiContent = '';
    for (let i = lastUserIndex - 1; i >= 0; i--) {
      if (contextMessages[i].role === 'assistant') {
        rawAiContent = getMessageTextContent(contextMessages[i]);
        break;
      }
    }

    const userContent = ragPlugin.sanitizeForEmbedding(rawUserContent, 'user');
    const aiContent = rawAiContent
      ? ragPlugin.sanitizeForEmbedding(rawAiContent, 'assistant')
      : '';

    const userVector = userContent
      ? ragPlugin._getEmbeddingFromCacheOnly(userContent)
      : null;
    const aiVector = aiContent
      ? ragPlugin._getEmbeddingFromCacheOnly(aiContent)
      : null;

    if (!userVector && !aiVector) {
      console.warn('[VRef] Context vector missed cache, skip vref to avoid extra embedding calls.');
      return null;
    }

    const mainWeights = ragPlugin.ragParams?.RAGDiaryPlugin?.mainSearchWeights || [0.7, 0.3];
    return ragPlugin._getWeightedAverageVector([userVector, aiVector], mainWeights);
  }

  async _resolveVRefFiles(vrefValue, contextMessages = []) {
    const kbManager = this.pluginManager?.vectorDBManager;
    if (!kbManager || !kbManager.db) {
      console.warn('[VRef] VectorDBManager unavailable, skip vref.');
      return [];
    }

    const contextVector = await this._buildVRefContextVector(contextMessages);
    if (!contextVector) return [];

    const parsedN = parseInt(vrefValue, 10);
    const n = Number.isFinite(parsedN) && parsedN > 0 ? parsedN : 3;

    const diaryRows = kbManager.db.prepare('SELECT DISTINCT diary_name FROM files').all();
    if (!Array.isArray(diaryRows) || diaryRows.length === 0) {
      return [];
    }

    const resultGroups = await Promise.all(
      diaryRows.map(({ diary_name }) => kbManager.search(diary_name, contextVector, n))
    );

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

  async execute(toolCall, clientIp, contextMessages = [], executionContext = null) {
    const { name, args, river, vref } = toolCall;

    if (this.debugMode) console.log(`[ToolExecutor] Processing tool: ${name}, river mode: ${river}`);
    if (river === 'full') {
      args.river_context = JSON.parse(JSON.stringify(contextMessages));
    } else if (river === 'text') {
      args.river_context = contextMessages.map(msg => extractTextFromMessage(msg));
    } else if (river && river.startsWith('last:')) {
      const n = parseInt(river.split(':')[1]) || 10;
      const textOnly = contextMessages.map(msg => extractTextFromMessage(msg));
      args.river_context = textOnly.slice(-n);
    } else if (river && river.startsWith('semantic:')) {
      const n = parseInt(river.split(':')[1]) || 5;

      const queryParts = [];
      for (const [key, value] of Object.entries(args)) {
        if (key === 'river_context') continue;
        if (typeof value === 'string' && value.length > 0) {
          queryParts.push(value);
        }
      }
      const queryText = queryParts.join(' ').slice(0, 2000);

      const textMessages = contextMessages.map((msg, idx) => ({
        index: idx,
        role: msg.role,
        text: getMessageTextContent(msg),
        original: msg
      })).filter(m => m.text.length > 10);

      try {
        const ragPlugin = this.pluginManager?.messagePreprocessors?.get('RAGDiaryPlugin');

        let queryVec = null;
        let messageVectors = [];

        if (ragPlugin && typeof ragPlugin.getBatchEmbeddingsCached === 'function') {
          const allTexts = [
            queryText.slice(0, 1000),
            ...textMessages.map(m => m.text.slice(0, 1000))
          ];
          const allVectors = await ragPlugin.getBatchEmbeddingsCached(allTexts);
          queryVec = allVectors[0];
          messageVectors = allVectors.slice(1);
        } else {
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

        const scored = textMessages.map((m, i) => ({
          ...m,
          score: messageVectors[i] ? cosineSimilarity(queryVec, messageVectors[i]) : 0
        }));

        scored.sort((a, b) => b.score - a.score);

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
        const textOnly = contextMessages.map(msg => extractTextFromMessage(msg));
        args.river_context = textOnly.slice(-n);
      }
    }
    if (this.debugMode && args.river_context) {
      console.log(`[ToolExecutor] river_context injected: ${args.river_context.length} messages`);
    }

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

    if (this.vcpToolCode) {
      const authResult = await this._verifyAuth(args);
      if (!authResult.valid) {
        return this._createErrorResult(name, authResult.message);
      }
    }

    const policyResult = this._enforceCodexMemoryPolicy(name, args, executionContext);
    if (!policyResult.allowed) {
      return this._createErrorResult(name, policyResult.message);
    }

    if (!this.pluginManager.getPlugin(name)) {
      return this._createErrorResult(name, `未找到名为 "${name}" 的插件`);
    }

    try {
      if (this.debugMode) console.log(`[ToolExecutor] Calling processToolCall for ${name} with args keys: ${Object.keys(args).join(', ')}`);
      const result = await this.pluginManager.processToolCall(name, args, clientIp, this._normalizeExecutionContext(executionContext));
      return this._processResult(name, result);
    } catch (error) {
      return this._createErrorResult(name, `执行错误: ${error.message}`);
    }
  }

  async executeAll(toolCalls, clientIp, contextMessages = [], executionContext = null) {
    return Promise.all(
      toolCalls.map(tc => this.execute(tc, clientIp, contextMessages, executionContext))
    );
  }

  _normalizeExecutionContext(executionContext) {
    return normalizeExecutionContext(executionContext);
  }

  _getPrimaryMaidArg(args = {}) {
    const candidates = [args.maid, args.maidName, args.agent_name];
    return candidates.find(value => typeof value === 'string' && value.trim())?.trim() || '';
  }

  _isDreamJournalWrite(toolName, args = {}) {
    if (toolName !== 'DailyNote' && toolName !== 'DailyNoteWrite') {
      return false;
    }

    return /^\[[^\]]+\u7684\u68A6\]/u.test(this._getPrimaryMaidArg(args));
  }

  _enforceCodexMemoryPolicy(toolName, args = {}, executionContext = null) {
    const context = this._normalizeExecutionContext(executionContext);
    if (context.agentAlias !== 'Codex') {
      return { allowed: true };
    }

    if (toolName !== 'DailyNote' && toolName !== 'DailyNoteWrite') {
      return { allowed: true };
    }

    if (this._isDreamJournalWrite(toolName, args)) {
      return { allowed: true };
    }

    return {
      allowed: false,
      message: 'Codex ordinary memory writes must go through CodexMemoryBridge.record.'
    };
  }

  _processResult(toolName, result) {
    const formatted = this._formatResult(result);

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
