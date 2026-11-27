'use strict';

/**
 * modules/vcpProtocolResilience/spans.js
 * 负责物理切片指纹计算、字段边界判定、模糊开关及门控判定（纯函数模块）
 */
const crypto = require('crypto');

const KNOWN_PARAM_KEYS = new Set([
  'maid', 'valet', 'tool_name', 'command', 'targettool', 'content', 'path',
  'query', 'input', 'args', 'archery', 'jev', 'ink', 'river', 'vref',
  'timely_contact', 'tool_password'
]);

/**
 * 严格计算指定文本切片的 SHA1 指纹（前 8 位 Hex）
 * @param {string} text - 输入文本
 * @param {number} [start=0] - 切片起始下标
 * @param {number} [end] - 切片结束下标（缺省为 text.length）
 * @returns {string} 8 位十六进制散列指纹
 */
function calculateFingerprint(text, start, end) {
  if (typeof text !== 'string') {
    text = text != null ? String(text) : '';
  }
  const len = text.length;
  let s = typeof start === 'number' && !isNaN(start) ? Math.floor(start) : 0;
  let e = typeof end === 'number' && !isNaN(end) ? Math.floor(end) : len;
  s = Math.max(0, Math.min(len, s));
  e = Math.max(0, Math.min(len, e));
  if (s > e) {
    const tmp = s;
    s = e;
    e = tmp;
  }
  const slice = text.slice(s, e);
  return crypto.createHash('sha1').update(slice.trim()).digest('hex').slice(0, 8);
}

/**
 * 判断当前切片行是否符合 VCP 参数字段特征
 * @param {string} remaining - 当前行开始的剩余文本
 * @returns {RegExpMatchArray|null}
 */
function matchFieldStart(remaining) {
  const m = remaining.match(/^[ \t]*([a-zA-Z0-9_-]+)[ \t]*([:=：])[ \t]*/);
  if (!m) return null;
  const key = m[1].toLowerCase();
  const afterSep = remaining.slice(m[0].length);

  if (/^[ \t\r\n]*(?:「始|\{始)/.test(afterSep)) return m;
  if (/^["']/.test(afterSep)) return m;
  if (KNOWN_PARAM_KEYS.has(key)) return m;
  return null;
}

/**
 * 解析并确定是否启用模糊工具标记匹配
 * @param {Object} [options]
 * @returns {boolean}
 */
function resolveFuzzyMatching(options) {
  if (options && options.fuzzyToolMatching !== undefined) {
    const val = options.fuzzyToolMatching;
    if (typeof val === 'string') {
      const lower = val.trim().toLowerCase();
      if (lower === 'false' || lower === '0' || lower === 'off' || lower === 'no') return false;
      if (lower === 'true' || lower === '1' || lower === 'on' || lower === 'yes') return true;
    }
    return Boolean(val);
  }
  try {
    const matcher = require('../vcpLoop/toolMarkerFuzzyMatcher');
    return Boolean(matcher?.isEnabled?.());
  } catch (_) {
    return false;
  }
}

let _hasWarnedRoleDivider = false;

function _resetRoleDividerWarnFlag() {
  _hasWarnedRoleDivider = false;
}

/**
 * 统一环境变量与 RoleDivider 强耦合开关门控判定（全局唯一实现）
 * @param {Object} [options]
 * @returns {boolean}
 */
function isResilienceEnabled(options = {}) {
  let explicitEnabled = null;
  if (options && options.enabled !== undefined) {
    const optVal = String(options.enabled).trim().toLowerCase();
    if (options.enabled === false || options.enabled === 0 || optVal === 'false' || optVal === '0' || optVal === 'off' || optVal === 'no') {
      return false;
    }
    if (options.enabled === true || options.enabled === 1 || optVal === 'true' || optVal === '1' || optVal === 'on' || optVal === 'yes') {
      explicitEnabled = true;
    }
  }

  if (explicitEnabled !== true) {
    const envKeys = ['ENABLE_TOOL_PROTOCOL_RESILIENCE', 'VCP_PROTOCOL_RESILIENCE_ENABLED'];
    let hasExplicitTrue = false;
    for (const key of envKeys) {
      if (process.env[key] !== undefined) {
        const val = String(process.env[key]).trim().toLowerCase();
        if (val === 'false' || val === '0' || val === 'no' || val === 'off') {
          return false;
        }
        if (val === 'true' || val === '1' || val === 'yes' || val === 'on') {
          hasExplicitTrue = true;
        }
      }
    }
    if (!hasExplicitTrue) {
      return false;
    }
  }

  const roleDividerKeys = ['EnableRoleDivider', 'RoleDividerUser', 'RoleDividerScanAssistant'];
  for (const key of roleDividerKeys) {
    if (process.env[key] !== undefined) {
      const val = String(process.env[key]).trim().toLowerCase();
      if (val === '' || val === 'false' || val === '0' || val === 'no' || val === 'off') {
        if (!_hasWarnedRoleDivider) {
          _hasWarnedRoleDivider = true;
          console.warn(`[VCPProtocolResilience] Warning: RoleDivider switch (${key}=${process.env[key]}) explicitly disabled, protocol resilience safely deactivated.`);
        }
        return false;
      }
    }
  }

  return true;
}

module.exports = {
  calculateFingerprint,
  matchFieldStart,
  resolveFuzzyMatching,
  isResilienceEnabled,
  _resetRoleDividerWarnFlag
};
