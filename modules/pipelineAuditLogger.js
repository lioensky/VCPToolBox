'use strict';

/**
 * PipelineAuditLogger — AI Image Pipeline 审计黑匣子
 *
 * 设计原则（来自 DGP Phase 3 施工手册）：
 * - 不自动决定日志路径，必须由调用者显式传入 auditFilePath
 * - 对敏感字段递归脱敏
 * - 写失败返回结构化错误，不 throw
 * - JSONL 格式，一行一个 event
 * - 仅依赖 fs/promises + path，不接 executor / route / server
 */

const fs = require('fs/promises');
const path = require('path');

// ── 脱敏 ────────────────────────────────────────────────────────────────

const REDACTED = '[REDACTED]';

const SENSITIVE_KEYS = new Set([
  'token',
  'apikey',
  'api_key',
  'apiKey',
  'secret',
  'authorization',
  'cookie',
  'password',
  'passwd',
  'accessToken',
  'refreshToken',
  'clientSecret',
]);

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(key) || SENSITIVE_KEYS.has(String(key).toLowerCase());
}

/**
 * 递归脱敏：对象、数组、嵌套结构一律深度遍历。
 * 基本类型直接返回。
 *
 * @param {*} payload
 * @returns {*} 脱敏后的 payload
 */
function sanitizeAuditPayload(payload) {
  if (Array.isArray(payload)) {
    return payload.map((item) => sanitizeAuditPayload(item));
  }

  if (payload && typeof payload === 'object') {
    const sanitized = {};

    for (const [key, value] of Object.entries(payload)) {
      if (isSensitiveKey(key)) {
        sanitized[key] = REDACTED;
      } else {
        sanitized[key] = sanitizeAuditPayload(value);
      }
    }

    return sanitized;
  }

  return payload;
}

// ── ID 生成 ─────────────────────────────────────────────────────────────

function createEventId(timestamp) {
  const suffix = Math.random().toString(36).slice(2, 10);
  const ts = String(timestamp).replace(/[^0-9]/g, '');
  return `audit_${ts}_${suffix}`;
}

// ── 事件创建 ────────────────────────────────────────────────────────────

/**
 * 创建一条审计事件。
 *
 * @param {object} input
 * @param {string} [input.eventId]        - 事件 ID，不提供则自动生成
 * @param {string} [input.pipelineId]     - 流水线 ID
 * @param {string} [input.taskId]         - 关联任务 ID
 * @param {string} [input.phase]          - 当前阶段
 * @param {string} [input.action]         - 触发动作
 * @param {string} [input.level]          - 日志级别 (debug/info/warn/error)
 * @param {string} [input.message]        - 描述文本
 * @param {object} [input.payload]        - 附带数据（会被脱敏）
 * @param {string} [input.timestamp]      - 时间戳，默认 now
 * @returns {AuditEvent}
 */
function createAuditEvent(input = {}) {
  const timestamp = input.timestamp || new Date().toISOString();
  const eventId = input.eventId || createEventId(timestamp);

  return {
    eventId,
    pipelineId: input.pipelineId || null,
    taskId: input.taskId || null,
    phase: input.phase || 'unknown',
    action: input.action || 'unknown',
    level: input.level || 'info',
    message: input.message || '',
    payload: sanitizeAuditPayload(input.payload || {}),
    timestamp,
  };
}

// ── 持久化 ──────────────────────────────────────────────────────────────

/**
 * 以 JSONL 格式追加一条审计事件到指定文件。
 * 路径必须由调用者通过 options.auditFilePath 显式传入。
 *
 * @param {AuditEvent} event        - 审计事件
 * @param {object} options
 * @param {string} options.auditFilePath  - 日志文件绝对路径（必填）
 * @returns {Promise<{ok: true, eventId: string, auditFilePath: string} |
 *                   {ok: false, eventId: string|null, error: string}>}
 */
async function appendAuditEvent(event, options = {}) {
  const eventId = event && event.eventId ? event.eventId : null;

  if (!options.auditFilePath) {
    return {
      ok: false,
      error: 'audit_file_path_required',
      eventId,
    };
  }

  try {
    const auditFilePath = options.auditFilePath;
    const auditDir = path.dirname(auditFilePath);

    await fs.mkdir(auditDir, { recursive: true });
    await fs.appendFile(
      auditFilePath,
      `${JSON.stringify(event)}\n`,
      'utf8',
    );

    return {
      ok: true,
      eventId: event.eventId,
      auditFilePath,
    };
  } catch (error) {
    return {
      ok: false,
      eventId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── Logger 工厂 ─────────────────────────────────────────────────────────

/**
 * 创建一个预绑定路径的 audit logger 实例。
 *
 * @param {object} options
 * @param {string} options.auditFilePath - 日志文件绝对路径
 * @returns {{ createEvent: Function, append: Function }}
 */
function createAuditLogger(options = {}) {
  return {
    createEvent(input = {}) {
      return createAuditEvent(input);
    },

    async append(event) {
      return appendAuditEvent(event, options);
    },
  };
}

// ── 导出 ─────────────────────────────────────────────────────────────────
module.exports = {
  REDACTED,
  SENSITIVE_KEYS,
  createAuditEvent,
  sanitizeAuditPayload,
  appendAuditEvent,
  createAuditLogger,
};
