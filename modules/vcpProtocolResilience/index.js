'use strict';

/**
 * modules/vcpProtocolResilience/index.js
 * 模块入口门控、环境变量解析、统一对外暴露 API
 */
const spans = require('./spans');
const blacklist = require('./blacklist');
const guidanceAssembler = require('./guidanceAssembler');
const classifier = require('./classifier');
const protocolLexer = require('./protocolLexer');
const scanner = require('./scanner');
const diagnoser = require('./diagnoser');
const historyCleanse = require('./historyCleanse');
const foldingHelper = require('./foldingHelper');
const thinkingMask = require('./thinkingMask');
const streamToolBuffer = require('./streamToolBuffer');
const { isResilienceEnabled, _resetRoleDividerWarnFlag } = spans;

/**
 * 兼容存根：V2 架构已彻底移除异步小模型仲裁，恒返回 false
 * @returns {boolean}
 */
function isSmallModelArbitrationEnabled() {
  return false;
}

/**
 * 带门控的 reconcileTurnToolCalls 包装器
 * 当 ENABLED 为 false 时，直接原样返回 { toolCalls: rawToolCalls || [], protocolErrors: [] }
 */
async function reconcileTurnToolCalls(content, rawToolCalls, options = {}) {
  if (!isResilienceEnabled(options)) {
    return {
      toolCalls: Array.isArray(rawToolCalls) ? rawToolCalls : [],
      protocolErrors: []
    };
  }
  return diagnoser.reconcileTurnToolCalls(content, rawToolCalls, options);
}

/**
 * 带门控的 extractHistoricalErrorBlocks 包装器
 * 当 ENABLED 为 false 时，直接返回空 Map
 */
function extractHistoricalErrorBlocks(originalText, options = {}) {
  if (!isResilienceEnabled(options)) {
    return new Map();
  }
  return diagnoser.extractHistoricalErrorBlocks(originalText, options);
}

/**
 * 带门控的 cleanseHistory 包装器
 * 当 ENABLED 为 false 时，直接原样返回 messages
 */
function cleanseHistory(messages, options = {}) {
  if (!isResilienceEnabled(options)) {
    return messages;
  }
  return historyCleanse.cleanseHistory(messages, options);
}

/**
 * 带门控的 stripErrorBlocksAndReceiptsFromText 包装器
 * 当 ENABLED 为 false 时，直接原样返回 text
 */
function stripErrorBlocksAndReceiptsFromText(text, options = {}) {
  if (!isResilienceEnabled(options)) {
    return text || '';
  }
  return historyCleanse.stripErrorBlocksAndReceiptsFromText(text, options);
}

/**
 * 带门控的 stripResilienceMarkers 包装器
 * 当 ENABLED 为 false 时，直接原样返回 text
 */
function stripResilienceMarkers(text, options = {}) {
  if (!isResilienceEnabled(options)) {
    return text === undefined || text === null ? '' : text;
  }
  return foldingHelper.stripResilienceMarkers(text, options);
}

/**
 * 带门控的 isProtocolGuidancePill 包装器
 * 当 ENABLED 为 false 时，直接返回 false
 */
function isProtocolGuidancePill(content, options = {}) {
  if (!isResilienceEnabled(options)) {
    return false;
  }
  return foldingHelper.isProtocolGuidancePill(content, options);
}

/**
 * 带门控的 extractTopLevelPillEnvelope 包装器
 * 当 ENABLED 为 false 时，直接返回默认未找到对象
 */
function extractTopLevelPillEnvelope(content, options = {}) {
  if (!isResilienceEnabled(options)) {
    return {
      hasPill: false,
      pillText: null,
      envelope: null,
      hasMalformedPill: false,
      shouldSkipFolding: false,
      isMixedBatch: false,
      targetPartIndex: -1
    };
  }
  return foldingHelper.extractTopLevelPillEnvelope(content, options);
}

/**
 * 带门控的 foldWithPillIfPresent 包装器
 * 当 ENABLED 为 false 时，退化为普通无药折叠（严格保持容器类型与元数据契约）
 */
function foldWithPillIfPresent(content, summaryOrFoldFn, options = {}) {
  return foldingHelper.foldWithPillIfPresent(content, summaryOrFoldFn, options);
}

/**
 * 清理提示词缓存
 */
function clearAllPromptCaches() {
  if (typeof guidanceAssembler._clearPromptCache === 'function') {
    guidanceAssembler._clearPromptCache();
  }
}

const exportedModule = {
  ...spans,
  ...blacklist,
  ...guidanceAssembler,
  ...classifier,
  ...protocolLexer,
  ...scanner,
  ...historyCleanse,
  ...foldingHelper,
  ...thinkingMask,
  ...streamToolBuffer,
  isResilienceEnabled,
  isSmallModelArbitrationEnabled,
  _resetRoleDividerWarnFlag,
  reconcileTurnToolCalls,
  extractHistoricalErrorBlocks,
  cleanseHistory,
  stripErrorBlocksAndReceiptsFromText,
  stripResilienceMarkers,
  isProtocolGuidancePill,
  extractTopLevelPillEnvelope,
  foldWithPillIfPresent,
  createGuidanceResult: guidanceAssembler.assembleInTurnGuidance,
  _clearPromptCache: clearAllPromptCaches,
  clearAllPromptCaches
};

Object.defineProperty(exportedModule, 'ENABLED', {
  enumerable: true,
  get() {
    return isResilienceEnabled();
  }
});

module.exports = exportedModule;
