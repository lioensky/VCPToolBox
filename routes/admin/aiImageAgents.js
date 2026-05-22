'use strict';

/**
 * AI Image Agents Admin Route — Phase 5A
 *
 * 设计原则：
 * - 不自动挂载 — 必须由外部显式调用 createAiImageAgentsRouter(options)
 * - 不读取 process.env
 * - 默认 dry-run — /dry-run 永远 dryRun=true，/execute 严格门控
 * - 不真实执行 — 唯一调用 executeAiImagePipelineV2
 * - auditFilePath 必须从 options 显式传入
 */

const express = require('express');
const { executeAiImagePipelineV2 } = require('../../modules/aiImagePipelineExecutor');

// ── Router 工厂 ──────────────────────────────────────────────────────────

/**
 * 创建 AI Image Agents 管理路由。
 *
 * @param {object} options
 * @param {string} [options.auditFilePath] - 审计日志路径（传入 executor）
 * @returns {express.Router}
 */
function createAiImageAgentsRouter(options = {}) {
  const router = express.Router();

  router.post('/dry-run', async (req, res) => {
    const response = await handleAiImagePipelineRequest(req, {
      ...options,
      forceDryRun: true,
    });
    sendJson(res, response);
  });

  router.post('/execute', async (req, res) => {
    const response = await handleAiImagePipelineRequest(req, {
      ...options,
      forceDryRun: false,
    });
    sendJson(res, response);
  });

  return router;
}

// ── Handler ──────────────────────────────────────────────────────────────

/**
 * 处理 AI Image Pipeline 请求，返回结构化响应。
 * 可脱离 Express 独立 smoke test。
 *
 * @param {object} req       - Express req 或其 mock（需含 req.body）
 * @param {object} options
 * @param {boolean} [options.forceDryRun]    - 强制 dry-run
 * @param {string} [options.auditFilePath]   - 审计日志路径
 * @returns {Promise<object>} 结构化响应
 */
async function handleAiImagePipelineRequest(req, options = {}) {
  try {
    const body = req && req.body && typeof req.body === 'object'
      ? req.body
      : {};

    const routeInput = normalizeRouteInput(body);
    const dryRun = resolveDryRunMode(body, options);

    // 真实执行：仅当 dryRun=false 且 server 已注入 pluginManager 时
    const allowRealExecution = !dryRun && options.pluginManager;

    if (allowRealExecution) {
      // route 内部覆盖 requestFlags — 不信任前端自由传入
      routeInput.requestFlags = {
        execute_pipeline: true,
        confirm_external_effects: true,
        reason: body.requestFlags && body.requestFlags.reason,
        ticket: body.requestFlags && body.requestFlags.ticket,
      };
    }

    const executorOptions = {
      dryRun,
      auditFilePath: options.auditFilePath,
    };

    if (allowRealExecution) {
      executorOptions.pluginManager = options.pluginManager;
    }

    const result = await executeAiImagePipelineV2(routeInput, executorOptions);

    return {
      ok: result.ok === true,
      mode: result.mode || (dryRun ? 'dry_run' : 'requested_execute'),
      result,
    };
  } catch (error) {
    return {
      ok: false,
      error: 'ai_image_agents_route_failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── 输入处理 ─────────────────────────────────────────────────────────────

/**
 * 从请求 body 规范化 pipeline 输入。
 */
function normalizeRouteInput(body = {}) {
  return {
    pipelineId: body.pipelineId,
    taskId: body.taskId,
    plan: body.plan || {},
    requestFlags: body.requestFlags || {},
    context: {
      ...(body.context || {}),
      operator: body.operator || null,
    },
  };
}

/**
 * 判断本次请求是否允许 dryRun=false。
 *
 * /dry-run        → 永远 true
 * /execute        → body.dryRun !== false 时 true
 * /execute        → body.dryRun === false 但缺 confirm/operator → 强制 true
 * /execute        → body.dryRun === false + confirm=true + operator 存在 → false
 *
 * @param {object} body     - 请求 body
 * @param {object} options  - route options
 * @returns {boolean}
 */
function resolveDryRunMode(body = {}, options = {}) {
  if (options.forceDryRun === true) {
    return true;
  }

  if (body.dryRun !== false) {
    return true;
  }

  if (body.confirm !== true || !body.operator) {
    return true;
  }

  return false;
}

// ── 响应 ─────────────────────────────────────────────────────────────────

/**
 * 发送 JSON 响应。res 若无 json 方法则原样返回 payload（用于 smoke test）。
 */
function sendJson(res, payload) {
  if (!res || typeof res.json !== 'function') {
    return payload;
  }
  return res.json(payload);
}

// ── 导出 ─────────────────────────────────────────────────────────────────
module.exports = {
  createAiImageAgentsRouter,
  handleAiImagePipelineRequest,
  normalizeRouteInput,
  resolveDryRunMode,
  sendJson,
};
