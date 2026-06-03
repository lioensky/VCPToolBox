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
const { getClientIp } = require('../../modules/toolExecution');

const SERUM_BOTTLE_SECRETLESS_MODE = 'serum_bottle_secretless_internal_execute';
const SERUM_BOTTLE_SECRETLESS_ALLOWED_PLUGIN = 'DoubaoGen';
const SERUM_BOTTLE_SECRETLESS_ROUTE_IDS = Object.freeze(new Set([
  'serum_bottle_vcptoolbox_route_owner_runtime',
  'serum_bottle_secretless_option_a',
  'secretless_serum_option_a',
]));
const SERUM_BOTTLE_SECRETLESS_FORBIDDEN_PAYLOAD_KEYS = Object.freeze(new Set([
  'adminusername',
  'adminpassword',
  'basicauthheader',
  'authorizationheader',
  'authorization',
  'basicauth',
  'auth',
  'bearertoken',
  'token',
  'secretenvvarvalue',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'password',
  'cookie',
  'headers',
]));

const AUTHORIZED_DOUBAO_PROJECT_BASE_PATH_OVERRIDES = Object.freeze({
  'AUTH-DRAFT-NATIVE-DOUBAO-SEEDREAM5-RETRY-20260526-003':
    'A:\\agent-image-lab\\agent-image-lab-v0.2\\runs\\real_generation\\v0_6_73_real_vcp_agent_generation_retry_003',
  'AUTH-DRAFT-NATIVE-DOUBAO-SEEDREAM5-RETRY-20260526-004':
    'A:\\agent-image-lab\\agent-image-lab-v0.2\\runs\\real_generation\\v0_6_73_real_vcp_agent_generation_retry_004',
  'AUTH-DRAFT-NATIVE-DOUBAO-SEEDREAM5-RETRY-20260526-005':
    'A:\\agent-image-lab\\agent-image-lab-v0.2\\runs\\real_generation\\v0_6_73_real_vcp_agent_generation_retry_005',
  'AUTH-DRAFT-NATIVE-DOUBAO-SEEDREAM5-RETRY-20260526-006':
    'A:\\agent-image-lab\\agent-image-lab-v0.2\\runs\\real_generation\\v0_6_73_real_vcp_agent_generation_retry_006',
  'AUTH-DRAFT-NATIVE-DOUBAO-SEEDREAM5-RETRY-20260527-007':
    'A:\\agent-image-lab\\agent-image-lab-v0.2\\runs\\real_generation\\v0_6_73_real_vcp_agent_generation_retry_007',
  'AUTH-DRAFT-NATIVE-DOUBAO-RUNTIME-TO-REVIEW-V1-20260529-001':
    'A:\\agent-image-lab\\agent-image-lab-v0.2\\runs\\real_generation\\runtime_to_review_v1_guarded_live_probe',
});

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

  if (options.enableSerumBottleSecretlessInternalRoute === true) {
    router.post('/execute/serum-bottle-secretless', async (req, res) => {
      const response = await handleSerumBottleSecretlessExecutionRequest(req, options);
      sendJson(res, response);
    });
  }

  return router;
}

function createSerumBottleSecretlessInternalRouter(options = {}) {
  const router = express.Router();

  router.post('/execute/serum-bottle-secretless', async (req, res) => {
    const response = await handleSerumBottleSecretlessExecutionRequest(req, options);
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
    const body = getRequestBody(req);

    const routeInput = normalizeRouteInput(body);
    const executionContext = buildAiImageExecutionContext(req, routeInput);
    const dryRun = resolveDryRunMode(body, options, executionContext);
    const requestIp = getClientIp(req);

    const hasPluginManager = Boolean(
      options.pluginManager &&
      typeof options.pluginManager.processToolCall === 'function'
    );
    const hasNativeDoubaoSecretlessRuntimeDelegate =
      typeof options.nativeDoubaoSecretlessRuntimeDelegate === 'function';
    const requireNativeDoubaoSecretlessRuntimeDelegate =
      options.requireNativeDoubaoSecretlessRuntimeDelegate === true;

    // 真实执行：仅当 dryRun=false、server 已注入 pluginManager，且要求的
    // Native Doubao secretless delegate 可调用时才放行。
    const allowRealExecution = (
      !dryRun &&
      hasPluginManager &&
      (
        !requireNativeDoubaoSecretlessRuntimeDelegate ||
        hasNativeDoubaoSecretlessRuntimeDelegate
      )
    );

    if (allowRealExecution) {
      const pluginLoad = await ensureRequiredPluginsRegistered(routeInput, options.pluginManager);
      if (pluginLoad.ok !== true) {
        return {
          ok: false,
          mode: 'requested_execute',
          result: {
            ok: false,
            status: 'plugin_not_registered',
            mode: 'requested_execute',
            errors: pluginLoad.errors,
            missingPlugins: pluginLoad.missingPlugins,
            pluginLoadAttempted: pluginLoad.loadAttempted,
          },
        };
      }

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
      requestIp,
      executionContext: {
        ...executionContext,
      },
    };

    if (allowRealExecution) {
      const projectBasePathOverride = resolveAuthorizedDoubaoProjectBasePathOverride(routeInput);
      if (projectBasePathOverride.ok !== true) {
        return {
          ok: false,
          mode: 'requested_execute',
          result: {
            ok: false,
            status: 'project_base_path_override_not_authorized',
            mode: 'requested_execute',
            error: projectBasePathOverride.error,
          },
        };
      }

      if (projectBasePathOverride.path) {
        executorOptions.executionContext.doubaoProjectBasePathOverride = projectBasePathOverride.path;
      }

      executorOptions.pluginManager = hasNativeDoubaoSecretlessRuntimeDelegate
        ? createNativeDoubaoDelegatePluginManagerFacade({
            pluginManager: options.pluginManager,
            nativeDoubaoSecretlessRuntimeDelegate: options.nativeDoubaoSecretlessRuntimeDelegate,
          })
        : options.pluginManager;
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

async function handleSerumBottleSecretlessExecutionRequest(req, options = {}) {
  try {
    const body = getRequestBody(req);
    const routeInput = normalizeRouteInput(body);
    const gate = validateSerumBottleSecretlessExecutionRequest(body, routeInput, options);

    if (gate.ok !== true) {
      return createSerumBottleSecretlessFailure(gate.status, gate.detail);
    }

    let authorizationResult;
    try {
      authorizationResult = await options.authorizeSerumBottleSecretlessExecution({
        mode: SERUM_BOTTLE_SECRETLESS_MODE,
        routeId: gate.routeId,
        taskId: routeInput.taskId || null,
        pipelineId: routeInput.pipelineId || null,
        receiptRef: gate.receiptRef,
        artifactRecordRef: gate.artifactRecordRef,
        nonSecretPayloadHash: gate.nonSecretPayloadHash,
        budget: gate.budget,
        requestIp: getClientIp(req),
      });
    } catch (error) {
      return createSerumBottleSecretlessFailure(
        'serum_bottle_secretless_internal_authorization_failed_closed',
        { authorizationError: error instanceof Error ? error.name : 'unknown_error' }
      );
    }

    const authorization = normalizeSerumBottleSecretlessAuthorizationResult(authorizationResult);
    if (authorization.ok !== true) {
      return createSerumBottleSecretlessFailure('serum_bottle_secretless_internal_authorization_denied');
    }

    const delegatedRequest = {
      ...(req || {}),
      adminAuthUser: authorization.operatorId,
      body: {
        ...body,
        dryRun: false,
        confirm: true,
        context: {
          ...(body.context && typeof body.context === 'object' ? body.context : {}),
          operator: null,
          routeId: gate.routeId,
          serumBottleSecretless: true,
          serumBottleSecretlessAuthorizationId: authorization.publicReceipt.authorizationId,
        },
      },
    };

    const response = await handleAiImagePipelineRequest(delegatedRequest, {
      ...options,
      forceDryRun: false,
      requireNativeDoubaoSecretlessRuntimeDelegate: true,
    });

    if (response && response.result && typeof response.result === 'object') {
      response.result.serumBottleSecretlessAuthorization = authorization.publicReceipt;
    }

    return response;
  } catch (error) {
    return createSerumBottleSecretlessFailure(
      'serum_bottle_secretless_route_failed',
      { routeError: error instanceof Error ? error.name : 'unknown_error' }
    );
  }
}

function getRequestBody(req) {
  return req && req.body && typeof req.body === 'object'
    ? req.body
    : {};
}

function validateSerumBottleSecretlessExecutionRequest(body, routeInput, options) {
  const forbiddenPayloadKeys = collectForbiddenSecretPayloadKeys(body);
  if (forbiddenPayloadKeys.length > 0) {
    return {
      ok: false,
      status: 'serum_bottle_secretless_payload_contains_forbidden_secret_key',
      detail: { forbiddenPayloadKeys },
    };
  }

  const routeId = readFirstString(
    body.routeId,
    body.route_id,
    body.context && body.context.routeId,
    body.context && body.context.route_id
  );
  if (!SERUM_BOTTLE_SECRETLESS_ROUTE_IDS.has(routeId)) {
    return {
      ok: false,
      status: 'serum_bottle_secretless_route_scope_not_authorized',
      detail: { routeId: routeId || null },
    };
  }

  const budget = resolveSerumBottleSecretlessBudget(body);
  if (
    budget.maxProviderCalls !== 1 ||
    budget.maxPluginCalls !== 1 ||
    budget.maxApiCalls !== 1 ||
    budget.maxImages !== 1 ||
    budget.retryAllowed !== false
  ) {
    return {
      ok: false,
      status: 'serum_bottle_secretless_budget_not_exact',
      detail: { budget },
    };
  }

  const pluginSteps = collectPluginSteps(routeInput);
  if (
    pluginSteps.length !== 1 ||
    pluginSteps[0] !== SERUM_BOTTLE_SECRETLESS_ALLOWED_PLUGIN
  ) {
    return {
      ok: false,
      status: 'serum_bottle_secretless_plugin_scope_not_authorized',
      detail: { requiredPlugins: pluginSteps },
    };
  }

  if (!options.pluginManager || typeof options.pluginManager.processToolCall !== 'function') {
    return { ok: false, status: 'serum_bottle_secretless_plugin_manager_missing' };
  }

  if (typeof options.nativeDoubaoSecretlessRuntimeDelegate !== 'function') {
    return { ok: false, status: 'serum_bottle_secretless_native_delegate_missing' };
  }

  if (typeof options.authorizeSerumBottleSecretlessExecution !== 'function') {
    return { ok: false, status: 'serum_bottle_secretless_internal_authorizer_missing' };
  }

  return {
    ok: true,
    routeId,
    budget,
    receiptRef: readFirstString(body.receiptRef, body.receipt_ref, body.context && body.context.receiptRef, body.context && body.context.receipt_ref),
    artifactRecordRef: readFirstString(
      body.artifactRecordRef,
      body.artifact_record_ref,
      body.context && body.context.artifactRecordRef,
      body.context && body.context.artifact_record_ref
    ),
    nonSecretPayloadHash: readFirstString(
      body.nonSecretPayloadHash,
      body.non_secret_payload_hash,
      body.context && body.context.nonSecretPayloadHash,
      body.context && body.context.non_secret_payload_hash
    ),
  };
}

function resolveSerumBottleSecretlessBudget(body = {}) {
  const context = body.context && typeof body.context === 'object'
    ? body.context
    : {};
  const sources = [
    body,
    body.budget,
    body.executionBudget,
    body.execution_budget,
    context,
    context.budget,
    context.executionBudget,
    context.execution_budget,
  ].filter((source) => source && typeof source === 'object');

  return {
    maxProviderCalls: readNumericBudget(sources, 'maxProviderCalls', 'max_provider_calls'),
    maxPluginCalls: readNumericBudget(sources, 'maxPluginCalls', 'max_plugin_calls'),
    maxApiCalls: readNumericBudget(sources, 'maxApiCalls', 'max_api_calls'),
    maxImages: readNumericBudget(sources, 'maxImages', 'max_images'),
    retryAllowed: readBooleanBudget(sources, 'retryAllowed', 'retry_allowed'),
  };
}

function readNumericBudget(sources, camelKey, snakeKey) {
  const value = readFirstDefinedFromSources(sources, camelKey, snakeKey);
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBooleanBudget(sources, camelKey, snakeKey) {
  const value = readFirstDefinedFromSources(sources, camelKey, snakeKey);
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return null;
}

function readFirstDefinedFromSources(sources, camelKey, snakeKey) {
  for (const source of sources) {
    if (Object.prototype.hasOwnProperty.call(source, camelKey)) {
      return source[camelKey];
    }
    if (Object.prototype.hasOwnProperty.call(source, snakeKey)) {
      return source[snakeKey];
    }
  }
  return undefined;
}

function readFirstString(...values) {
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function normalizePayloadKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function collectForbiddenSecretPayloadKeys(value, path = 'body', result = []) {
  if (!value || typeof value !== 'object') {
    return result;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbiddenSecretPayloadKeys(item, `${path}[${index}]`, result));
    return result;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const keyPath = `${path}.${key}`;
    if (SERUM_BOTTLE_SECRETLESS_FORBIDDEN_PAYLOAD_KEYS.has(normalizePayloadKey(key))) {
      result.push(keyPath);
    }
    collectForbiddenSecretPayloadKeys(nestedValue, keyPath, result);
  }

  return result;
}

function normalizeSerumBottleSecretlessAuthorizationResult(result) {
  if (!result || result.ok !== true) {
    return { ok: false };
  }

  const authorizationId = readFirstString(
    result.authorizationId,
    result.authorization_id,
    result.executionAuthorizationId,
    result.execution_authorization_id
  );
  if (!authorizationId) {
    return { ok: false };
  }

  return {
    ok: true,
    operatorId: readFirstString(result.operatorId, result.operator_id) || 'serum-bottle-secretless-internal',
    publicReceipt: {
      authorizationId,
      receiptId: readFirstString(result.receiptId, result.receipt_id),
    },
  };
}

function createSerumBottleSecretlessFailure(status, detail = {}) {
  return {
    ok: false,
    mode: SERUM_BOTTLE_SECRETLESS_MODE,
    result: {
      ok: false,
      status,
      mode: SERUM_BOTTLE_SECRETLESS_MODE,
      provider_contact_performed: false,
      plugin_call_performed: false,
      api_call_performed: false,
      image_generation_performed: false,
      output_write_performed: false,
      secret_value_read_performed: false,
      authorization_header_constructed: false,
      ...detail,
    },
  };
}

function normalizePathForComparison(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\//g, '\\').replace(/\\+$/, '')
    : '';
}

function resolveAuthorizedDoubaoProjectBasePathOverride(routeInput = {}) {
  const context = routeInput.context && typeof routeInput.context === 'object'
    ? routeInput.context
    : {};
  const requested = context.doubaoProjectBasePathOverride;
  if (requested === undefined || requested === null || requested === '') {
    return { ok: true, path: null };
  }

  const authorizedPath = AUTHORIZED_DOUBAO_PROJECT_BASE_PATH_OVERRIDES[routeInput.taskId];
  if (!authorizedPath) {
    return { ok: false, path: null, error: 'doubao_project_base_path_override_task_not_authorized' };
  }

  const expected = normalizePathForComparison(authorizedPath);
  const actual = normalizePathForComparison(requested);
  if (actual !== expected) {
    return { ok: false, path: null, error: 'doubao_project_base_path_override_path_not_authorized' };
  }

  return { ok: true, path: authorizedPath };
}

function collectRequiredPlugins(routeInput = {}) {
  return Array.from(new Set(collectPluginSteps(routeInput)));
}

function collectPluginSteps(routeInput = {}) {
  const steps = Array.isArray(routeInput.plan && routeInput.plan.steps)
    ? routeInput.plan.steps
    : [];
  const plugins = [];

  for (const step of steps) {
    if (step && typeof step.plugin === 'string' && step.plugin.trim()) {
      plugins.push(step.plugin.trim());
    }
  }

  return plugins;
}

async function ensureRequiredPluginsRegistered(routeInput, pluginManager) {
  const requiredPlugins = collectRequiredPlugins(routeInput);
  if (requiredPlugins.length === 0) {
    return { ok: true, loadAttempted: false, missingPlugins: [] };
  }

  if (!pluginManager || typeof pluginManager.getPlugin !== 'function') {
    return { ok: true, loadAttempted: false, missingPlugins: [] };
  }

  let missingPlugins = requiredPlugins.filter((name) => !pluginManager.getPlugin(name));
  if (missingPlugins.length === 0) {
    return { ok: true, loadAttempted: false, missingPlugins: [] };
  }

  if (typeof pluginManager.loadPlugins !== 'function') {
    return {
      ok: false,
      loadAttempted: false,
      missingPlugins,
      errors: missingPlugins.map((name) => `plugin_not_registered:${name}`),
    };
  }

  await pluginManager.loadPlugins();
  missingPlugins = requiredPlugins.filter((name) => !pluginManager.getPlugin(name));
  return {
    ok: missingPlugins.length === 0,
    loadAttempted: true,
    missingPlugins,
    errors: missingPlugins.map((name) => `plugin_not_registered_after_load:${name}`),
  };
}

function createNativeDoubaoDelegatePluginManagerFacade(options = {}) {
  const pluginManager = options.pluginManager || null;
  const nativeDoubaoSecretlessRuntimeDelegate =
    options.nativeDoubaoSecretlessRuntimeDelegate;

  return {
    async processToolCall(toolName, toolArgs, requestIp, executionContext) {
      if (toolName !== 'DoubaoGen') {
        throw new Error(`native_doubao_delegate_tool_not_allowed:${toolName || '<empty>'}`);
      }

      if (typeof nativeDoubaoSecretlessRuntimeDelegate !== 'function') {
        throw new Error('native_doubao_secretless_runtime_delegate_not_callable');
      }

      const delegateResult = await nativeDoubaoSecretlessRuntimeDelegate({
        toolName,
        toolArgs,
        requestIp,
        executionContext,
      });

      if (!delegateResult || delegateResult.ok !== true) {
        const blocker = delegateResult && (delegateResult.blocker || delegateResult.error);
        throw new Error(blocker || 'native_doubao_secretless_runtime_delegate_failed_closed');
      }

      return delegateResult.result;
    },
    getPlugin(name) {
      return pluginManager && typeof pluginManager.getPlugin === 'function'
        ? pluginManager.getPlugin(name)
        : null;
    },
  };
}

// ── 输入处理 ─────────────────────────────────────────────────────────────

/**
 * 从请求 body 规范化 pipeline 输入。
 */
function normalizeRouteInput(body = {}) {
  return {
    pipelineId: body.pipelineId || body.pipeline_id,
    taskId: body.taskId || body.task_id,
    plan: body.plan || {},
    requestFlags: body.requestFlags || {},
    context: {
      ...(body.context || {}),
      operator: body.operator || null,
    },
  };
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
}

function buildAiImageExecutionContext(req, routeInput = {}) {
  const trustedOperatorId = normalizeOptionalString(req && req.adminAuthUser);
  const fallbackOperatorId = normalizeOptionalString(
    routeInput &&
    routeInput.context &&
    routeInput.context.operator
  );

  const executionContext = {
    requestSource: 'ai-image-pipeline',
  };

  const operatorId = trustedOperatorId || fallbackOperatorId;
  if (operatorId) {
    executionContext.operatorId = operatorId;
  }

  const taskId = normalizeOptionalString(routeInput && routeInput.taskId);
  if (taskId) {
    executionContext.taskId = taskId;
  }

  const invocationId = normalizeOptionalString(routeInput && routeInput.pipelineId);
  if (invocationId) {
    executionContext.invocationId = invocationId;
  }

  const routeContext = routeInput && routeInput.context && typeof routeInput.context === 'object'
    ? routeInput.context
    : {};
  const routeId = readFirstString(routeContext.routeId, routeContext.route_id);
  if (routeId) {
    executionContext.routeId = routeId;
  }

  if (routeContext.serumBottleSecretless === true) {
    executionContext.serumBottleSecretless = true;
  }

  const serumBottleSecretlessAuthorizationId = normalizeOptionalString(
    routeContext.serumBottleSecretlessAuthorizationId
  );
  if (serumBottleSecretlessAuthorizationId) {
    executionContext.serumBottleSecretlessAuthorizationId = serumBottleSecretlessAuthorizationId;
  }

  return executionContext;
}

/**
 * 判断本次请求是否允许 dryRun=false。
 *
 * /dry-run        → 永远 true
 * /execute        → body.dryRun !== false 时 true
 * /execute        → body.dryRun === false 但缺 confirm/可信 operator → 强制 true
 * /execute        → body.dryRun === false + confirm=true + 存在可信 operatorId → false
 *
 * @param {object} body     - 请求 body
 * @param {object} options  - route options
 * @param {object} [executionContext] - 已解析的执行上下文
 * @returns {boolean}
 */
function resolveDryRunMode(body = {}, options = {}, executionContext = null) {
  if (options.forceDryRun === true) {
    return true;
  }

  if (body.dryRun !== false) {
    return true;
  }

  if (
    body.confirm !== true ||
    !executionContext ||
    typeof executionContext.operatorId !== 'string' ||
    !executionContext.operatorId.trim()
  ) {
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
  createSerumBottleSecretlessInternalRouter,
  handleAiImagePipelineRequest,
  handleSerumBottleSecretlessExecutionRequest,
  createNativeDoubaoDelegatePluginManagerFacade,
  resolveAuthorizedDoubaoProjectBasePathOverride,
  validateSerumBottleSecretlessExecutionRequest,
  collectRequiredPlugins,
  ensureRequiredPluginsRegistered,
  normalizeRouteInput,
  buildAiImageExecutionContext,
  resolveDryRunMode,
  sendJson,
};
