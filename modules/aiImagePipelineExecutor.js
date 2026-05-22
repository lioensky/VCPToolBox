'use strict';

/**
 * AI Image Pipeline Executor V2 — 最小 dry-run 包装层
 *
 * 设计原则（来自 DGP Phase 4A 施工手册）：
 * - 默认 dryRun，不真实生成图片
 * - 不调用外部 API、PluginManager、process.env
 * - 只编排 StateManager → SafetyGate → AuditLogger
 * - auditFilePath 必须由 options.auditFilePath 显式传入
 * - 即使 dryRun=false，本阶段也只返回 pending_execution_not_implemented
 */

const {
  PHASE,
  createInitialPipelineState,
  transitionPipelineState,
} = require('./pipelineStateManager');

const {
  evaluatePipelineSafety,
  SAFETY_ACTION,
} = require('./pipelineSafetyGate');

const {
  createAuditEvent,
  appendAuditEvent,
} = require('./pipelineAuditLogger');

// ── helpers ──────────────────────────────────────────────────────────────

function createPipelineId() {
  return `pipeline_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createTaskId() {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── 输入规范化 ───────────────────────────────────────────────────────────

/**
 * 规范化 pipeline 输入，填充缺失的 ID 和默认值。
 *
 * @param {object} input
 * @returns {{ pipelineId: string, taskId: string, plan: object, requestFlags: object, context: object }}
 */
function normalizePipelineInput(input = {}) {
  return {
    pipelineId: input.pipelineId || createPipelineId(),
    taskId: input.taskId || input.pipelineId || createTaskId(),
    plan: input.plan || {},
    requestFlags: input.requestFlags || {},
    context: input.context || {},
  };
}

// ── 执行编排 ─────────────────────────────────────────────────────────────

/**
 * Phase 4A 最小执行包装：
 * StateManager → SafetyGate → AuditLogger → dry-run result
 *
 * @param {object} input      - 流水线输入
 * @param {object} options    - 执行选项
 * @param {boolean} [options.dryRun=true]        - 默认 true
 * @param {string} [options.auditFilePath]       - 审计日志路径（必填以记录审计）
 * @returns {Promise<object>} 结构化执行结果
 */
async function executeAiImagePipelineV2(input = {}, options = {}) {
  const normalizedInput = normalizePipelineInput(input);
  const dryRun = options.dryRun !== false;

  // 1. 创建初始状态
  let state = createInitialPipelineState({
    pipelineId: normalizedInput.pipelineId,
    taskId: normalizedInput.taskId,
    dryRun,
    context: normalizedInput.context,
  });

  // 2. 推进到 preflight 阶段
  const preflightTransition = transitionPipelineState(
    state,
    PHASE.PREFLIGHT,
    'phase4a_preflight',
  );

  if (preflightTransition.ok) {
    state = preflightTransition.state;
  }

  // 3. 安全门禁评估
  const safety = evaluatePipelineSafety({
    state,
    plan: normalizedInput.plan,
    requestFlags: normalizedInput.requestFlags,
  });

  // 4. 审计记录
  const auditEvent = createAuditEvent({
    pipelineId: state.pipelineId,
    taskId: state.taskId,
    phase: state.phase,
    action: 'safety_evaluated',
    level: safety.level || 'info',
    message: safety.action || 'unknown',
    payload: {
      dryRun,
      safety,
    },
  });

  const audit = await appendAuditEvent(auditEvent, {
    auditFilePath: options.auditFilePath,
  });

  // 5. 安全门禁拦截 — 仅 ABORT / STEP_BACK 终止
  // DRY_RUN_ONLY / REQUIRE_APPROVAL 在 dry-run 模式下继续（门禁已将风险降级）
  if (
    safety.action === SAFETY_ACTION.ABORT ||
    safety.action === SAFETY_ACTION.STEP_BACK
  ) {
    return {
      ok: false,
      status: safety.action === SAFETY_ACTION.STEP_BACK ? 'step_back' : 'blocked',
      mode: 'dry_run',
      state,
      safety,
      audit,
      error: 'pipeline_blocked_by_safety_gate',
    };
  }

  // 6. dry-run 返回
  if (dryRun) {
    return {
      ok: true,
      status: 'dry_run',
      mode: 'dry_run',
      state,
      safety,
      audit,
      output: {
        message: 'AI image pipeline dry-run completed',
      },
    };
  }

  // 7. dryRun=false 路径
  // 7a. 安全门禁 ALLOW + pluginManager 已注入 → 进入 adapter
  if (safety.action === SAFETY_ACTION.ALLOW) {
    const pluginManager = options.pluginManager;

    if (!pluginManager || typeof pluginManager.processToolCall !== 'function') {
      return {
        ok: false,
        status: 'plugin_manager_not_provided',
        mode: 'dry_run',
        state,
        safety,
        audit,
        error: 'plugin_manager_required_for_real_execution',
      };
    }

    // 7a-ii. allowlist 准入：只允许已认证的插件真实执行
    const REAL_EXECUTION_PLUGIN_ALLOWLIST = new Set([
      'DoubaoGen',
    ]);

    const steps = Array.isArray(normalizedInput.plan && normalizedInput.plan.steps)
      ? normalizedInput.plan.steps
      : [];

    const disallowedPlugin = steps.find((step) => {
      return step && step.plugin && !REAL_EXECUTION_PLUGIN_ALLOWLIST.has(step.plugin);
    });

    if (disallowedPlugin) {
      const blockAuditEvent = createAuditEvent({
        pipelineId: state.pipelineId,
        taskId: state.taskId,
        phase: state.phase,
        action: 'execution_blocked_by_allowlist',
        level: 'warn',
        message: `plugin_not_allowed:${disallowedPlugin.plugin}`,
        payload: {
          plugin: disallowedPlugin.plugin,
        },
      });

      const blockAudit = await appendAuditEvent(blockAuditEvent, {
        auditFilePath: options.auditFilePath,
      });

      return {
        ok: false,
        status: 'plugin_not_in_allowlist',
        mode: 'dry_run',
        state,
        safety,
        audit: blockAudit,
        error: `plugin_not_allowed:${disallowedPlugin.plugin}`,
      };
    }

    // 7a-iii. 注入 adapter 执行真实 plan
    const { executeImagePlan } = require('./aiImageExecutionAdapter');

    const execResult = await executeImagePlan(normalizedInput.plan, {
      pluginManager,
    });

    // 7a-iv. 审计
    const execAuditEvent = createAuditEvent({
      pipelineId: state.pipelineId,
      taskId: state.taskId,
      phase: state.phase,
      action: execResult.ok ? 'execution_completed' : 'execution_failed',
      level: execResult.ok ? 'info' : 'error',
      message: execResult.ok
        ? `completed: ${execResult.images.length} images`
        : `failed: ${execResult.errors.join('; ')}`,
      payload: {
        images: execResult.images.map((img) => ({
          plugin: img.plugin,
          path: img.path,
        })),
        errors: execResult.errors,
      },
    });

    await appendAuditEvent(execAuditEvent, {
      auditFilePath: options.auditFilePath,
    });

    return {
      ok: execResult.ok,
      status: execResult.ok ? 'completed' : 'partial',
      mode: 'real_execution',
      state,
      safety,
      audit,
      images: execResult.images,
      errors: execResult.errors,
    };
  }

  // 7b. safety 不是 ALLOW（DRY_RUN_ONLY / REQUIRE_APPROVAL）→ 仍不可执行
  return {
    ok: false,
    status: 'pending_execution_not_implemented',
    mode: 'dry_run',
    state,
    safety,
    audit,
    error: 'real_execution_not_implemented_in_phase_4a',
  };
}

// ── 导出 ─────────────────────────────────────────────────────────────────
module.exports = {
  executeAiImagePipelineV2,
  normalizePipelineInput,
};
