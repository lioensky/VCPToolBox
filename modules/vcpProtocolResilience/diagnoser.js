'use strict';

/**
 * modules/vcpProtocolResilience/diagnoser.js
 * 负责纯同步轮内统一协调对账（逐块调原生 parseBlock）、轮间历史闭合坏块提取
 */
const { scanContentBlocksSync } = require('./scanner');
const { calculateFingerprint, resolveFuzzyMatching } = require('./spans');
const { checkBlacklistConflict } = require('./blacklist');

/**
 * 轮内工具调用统一协调与诊断入口（内部纯同步 0ms，保留 async 签名兼容调用方）
 * @param {string} content AI 当轮回复正文
 * @param {Array<object>} rawToolCalls 原生 ToolCallParser.parse(content) 初始解析结果
 * @param {object} [options={}] 运行期环境与状态
 * @returns {Promise<{ toolCalls: Array<object>, protocolErrors: Array<object> }>}
 */
async function reconcileTurnToolCalls(content, rawToolCalls, options = {}) {
  options = {
    ...options,
    fuzzyToolMatching: resolveFuzzyMatching(options)
  };
  const safeRaw = Array.isArray(rawToolCalls) ? rawToolCalls : [];

  const isAborted = Boolean(
    options.abortController?.signal?.aborted ||
    options.abortSignal?.aborted ||
    options.streamAborted
  );
  if (isAborted || !content || typeof content !== 'string' || !content.trim()) {
    return {
      toolCalls: safeRaw,
      protocolErrors: []
    };
  }

  // 1. 纯同步扫描闭合块与类别 III 错误
  const scanResult = scanContentBlocksSync(content, options);
  const protocolErrors = scanResult.protocolErrors.map(err => ({
    name: 'VCP工具调用',
    args: {},
    archery: false,
    archeryNoReply: false,
    markHistory: false,
    ...err,
    isProtocolError: true
  }));

  // 2. 分支 A：Mock 降级分支（未注入 ToolCallParser.parseBlock）
  if (!options.ToolCallParser || typeof options.ToolCallParser.parseBlock !== 'function') {
    return {
      toolCalls: safeRaw,
      protocolErrors
    };
  }

  // 3. 分支 B：确定性精准对账分支（逐块调用原生 parseBlock）
  const toolCalls = [];

  for (const block of scanResult.blocks) {
    if (block.type !== 'CLOSED' || block.isProtocolError) {
      continue;
    }

    let blockBody = block.rawText.trim();
    if (options.fuzzyToolMatching) {
      blockBody = blockBody
        .replace(/^<{2,4}\[TOOL_REQUEST\]>{2,4}/i, '')
        .replace(/<{2,4}\[END_TOOL_REQUEST\]>{2,4}$/i, '')
        .trim();
    } else {
      const START_MARKER = '<<<[TOOL_REQUEST]>>>';
      const END_MARKER = '<<<[END_TOOL_REQUEST]>>>';
      const sIdx = blockBody.indexOf(START_MARKER);
      if (sIdx !== -1) blockBody = blockBody.slice(sIdx + START_MARKER.length);
      const eIdx = blockBody.lastIndexOf(END_MARKER);
      if (eIdx !== -1) blockBody = blockBody.slice(0, eIdx);
      blockBody = blockBody.trim();
    }

    const parsed = options.ToolCallParser.parseBlock(blockBody);
    if (!parsed) {
      protocolErrors.push({
        name: 'VCP工具调用',
        args: {},
        archery: false,
        archeryNoReply: false,
        markHistory: false,
        isProtocolError: true,
        errorCode: 'MALFORMED_BLOCK_SYNTAX',
        subType: 'NATIVE_PARSE_FAILED',
        errorDetail: '原生解析器无法解析该工具块参数，已被安全拦截！',
        blockFingerprint: calculateFingerprint(block.rawText, 0, block.rawText.length),
        startIndex: block.start,
        endIndex: block.end,
        detectedPluginInMaid: null,
        pluginInMaid: null,
        roleNameInTool: null,
        isDuplicateConflict: false
      });
      continue;
    }

    // 黑名单错位二次防御校验（场景 B & 角色名入 tool_name）
    const toolName = parsed.name || '';
    const isRawValet = /(?:^|\n)[ \t]*valet[ \t]*:[ \t]*(?:「始|\{始)/i.test(blockBody);
    const maidKey = isRawValet ? 'valet' : 'maid';
    const maidVal = isRawValet ? (parsed.args?.valet || '') : (parsed.args?.maid || parsed.args?.valet || '');

    const conflict = checkBlacklistConflict(toolName, maidKey, maidVal, options);
    if (conflict && (conflict.subType === 'BLACKLIST_SCENARIO_B' || conflict.subType === 'ROLE_IN_TOOL_NAME')) {
      protocolErrors.push({
        name: 'VCP工具调用',
        args: {},
        archery: false,
        archeryNoReply: false,
        markHistory: false,
        isProtocolError: true,
        errorCode: conflict.errorCode,
        errorDetail: conflict.errorDetail,
        blockFingerprint: calculateFingerprint(block.rawText, 0, block.rawText.length),
        startIndex: block.start,
        endIndex: block.end,
        subType: conflict.subType,
        detectedPluginInMaid: conflict.detectedPluginInMaid || null,
        pluginInMaid: conflict.pluginInMaid || null,
        roleNameInTool: conflict.roleNameInTool || null,
        isDuplicateConflict: false
      });
      continue;
    }

    toolCalls.push(parsed);
  }

  return {
    toolCalls,
    protocolErrors
  };
}

/**
 * 历史原文坏块精确坐标反查接口（纯同步确定性函数）
 * @param {string} originalText 历史消息原文
 * @param {object} [options={}] 可选配置覆盖项
 * @returns {Map<string, Array<{ start: number, end: number, errorCode: string }>>}
 */
function extractHistoricalErrorBlocks(originalText, options = {}) {
  options = { ...options, fuzzyToolMatching: resolveFuzzyMatching(options) };
  const result = new Map();

  if (!originalText || typeof originalText !== 'string') {
    return result;
  }

  const runOptions = {
    protectRoleDivider: true,
    isHistoryExtraction: true,
    includeClosedBlockCandidates: true,
    allowHeadlessThinkReset: false,
    ...options
  };

  const scanResult = scanContentBlocksSync(originalText, runOptions);

  const seenByFp = new Map();
  function addSpan(fp, item) {
    if (!fp) return;
    let list = result.get(fp);
    let seen = seenByFp.get(fp);
    if (!list) {
      list = [];
      seen = new Set();
      result.set(fp, list);
      seenByFp.set(fp, seen);
    }
    const key = item.start + ':' + item.end;
    if (!seen.has(key)) {
      seen.add(key);
      list.push(item);
    }
  }

  for (const err of scanResult.protocolErrors) {
    addSpan(err.blockFingerprint, {
      start: err.startIndex,
      end: err.endIndex,
      errorCode: err.errorCode,
      subType: err.subType || null,
      detectedPluginInMaid: err.detectedPluginInMaid || null,
      pluginInMaid: err.pluginInMaid || null,
      roleNameInTool: err.roleNameInTool || null,
      isDuplicateConflict: Boolean(err.isDuplicateConflict)
    });
  }

  if (runOptions.includeClosedBlockCandidates && Array.isArray(scanResult.blocks)) {
    for (const blk of scanResult.blocks) {
      if (typeof blk.start === 'number' && typeof blk.end === 'number') {
        const fp = calculateFingerprint(originalText, blk.start, blk.end);
        addSpan(fp, {
          start: blk.start,
          end: blk.end,
          errorCode: blk.errorCode || 'MALFORMED_BLOCK_SYNTAX',
          subType: blk.subType || 'CLOSED_BLOCK_CANDIDATE',
          detectedPluginInMaid: blk.detectedPluginInMaid || null,
          pluginInMaid: blk.pluginInMaid || null,
          roleNameInTool: blk.roleNameInTool || null,
          isDuplicateConflict: Boolean(blk.isDuplicateConflict),
          isClosedCandidate: true
        });
      }
    }
  }

  return result;
}

module.exports = {
  reconcileTurnToolCalls,
  extractHistoricalErrorBlocks
};
