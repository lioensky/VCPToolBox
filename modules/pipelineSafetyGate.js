'use strict';

/**
 * PipelineSafetyGate — AI Image Pipeline 风险门禁
 *
 * 设计原则（来自 DGP 补习手册）：
 * - 返回结构化 decision，不 throw
 * - 风险等级 4 级 + 动作等级 5 级
 * - 可单测，不依赖 PluginManager / IO
 * - 调用方自己决定如何处理 decision（executor / route / orchestrator 都读懂它）
 */

// ── 风险等级 ─────────────────────────────────────────────────────────
const RISK_LEVEL = Object.freeze({
  LOW:      'low',
  MEDIUM:   'medium',
  HIGH:     'high',
  CRITICAL: 'critical',
});

// ── 动作等级 ─────────────────────────────────────────────────────────
const SAFETY_ACTION = Object.freeze({
  ALLOW:             'allow',              // 放行
  DRY_RUN_ONLY:      'dry_run_only',       // 仅 dry-run
  REQUIRE_APPROVAL:  'require_approval',   // 需要人工审批
  STEP_BACK:         'step_back',          // 回退，需要人工介入
  ABORT:             'abort',              // 中止
});

// ── helpers ──────────────────────────────────────────────────────────
function nowIso() {
  return new Date().toISOString();
}

// ── 已知外部图像生成插件（小写）──────────────────────────────────────
// 对应 Pipeline plan 中 step.plugin 字段，用于风险分类。
const EXTERNAL_IMAGE_PLUGINS = new Set([
  'doubaogen',
  'dmxdoubaogen',
  'geminiimagegen',
  'nanobananagen2',
  'nanobananagenor',
  'fluxgen',
  'comfyuigen',
  'comfycloudgen',
  'qwenimagegen',
  'webuigen',
  'novelaigen',
  'zimagegen',
  'zimagegen2',
  'zimageturbogen',
]);

// ── 门禁主函数 ───────────────────────────────────────────────────────

/**
 * 评估流水线安全风险，返回结构化 decision。
 *
 * @param {object} input
 * @param {object} input.state            - PipelineState（来自 stateManager）
 * @param {object} [input.plan]           - Orchestrator plan 快照（可选）
 * @param {object} [input.requestFlags]   - 请求级标记，如 { execute_pipeline, confirm_external_effects }
 * @returns {SafetyDecision}
 *
 * SafetyDecision 结构：
 * {
 *   decisionId: string,
 *   allowed: boolean,
 *   level: 'low' | 'medium' | 'high' | 'critical',
 *   action: 'allow' | 'dry_run_only' | 'require_approval' | 'step_back' | 'abort',
 *   reasons: string[],
 *   requiredApprovals: string[],
 *   writeAllowed: boolean,
 *   evaluatedAt: string,
 * }
 */
function evaluatePipelineSafety(input = {}) {
  const state = input.state || {};
  const plan = input.plan || {};
  const flags = input.requestFlags || {};
  const reasons = [];
  const requiredApprovals = [];

  // ── 1. 环境变量门禁 ────────────────────────────────────────────
  const envAllow = String(process.env.AIGENT_PIPELINE_ALLOW_EXECUTION || 'false').toLowerCase();
  const envEnabled = envAllow === 'true' || envAllow === '1';

  if (!envEnabled) {
    reasons.push('env:AIGENT_PIPELINE_ALLOW_EXECUTION 未设为 true');
  }

  // ── 2. 请求标记门禁 ────────────────────────────────────────────
  if (flags.execute_pipeline !== true) {
    reasons.push('request:execute_pipeline 未设为 true');
  }
  if (flags.confirm_external_effects !== true) {
    reasons.push('request:confirm_external_effects 未设为 true');
  }

  // ── 3. 检查 plan 中的步骤 ─────────────────────────────────────
  const steps = plan.steps || state.planSnapshot?.steps || [];
  const hasWriteSteps = steps.some((s) => {
    const cmd = (s.command || '').toLowerCase();
    return cmd.includes('execute') || cmd.includes('generate') || cmd.includes('train');
  });
  const hasExternalCalls = steps.some((s) => {
    const agent = String(s.agent || '').toLowerCase();
    const plugin = String(s.plugin || '').toLowerCase();
    return (
      agent.includes('comfyui') ||
      agent.includes('cloudgen') ||
      EXTERNAL_IMAGE_PLUGINS.has(plugin)
    );
  });

  if (hasExternalCalls) {
    reasons.push('plan:包含外部服务调用');
    requiredApprovals.push('external_service');
  }

  // ── 4. 状态本身的风险 ──────────────────────────────────────────
  const inRecovery = state.phase === 'recovery';
  const hasRecentErrors = (state.errors || []).length >= 3;

  if (inRecovery) {
    reasons.push('state:当前处于 recovery 阶段');
    requiredApprovals.push('recovery_resume');
  }
  if (hasRecentErrors) {
    reasons.push('state:累积错误数 >= 3');
  }

  // ── 5. 判定风险等级和动作（优先级从高到低）─────────────────────
  let level = RISK_LEVEL.LOW;
  let action = SAFETY_ACTION.ALLOW;

  // 5a. CRITICAL: 所有门禁关闭 + 包含写/外部步骤 → abort
  if (!envEnabled && !flags.execute_pipeline && !flags.confirm_external_effects
      && (hasWriteSteps || hasExternalCalls)) {
    action = SAFETY_ACTION.ABORT;
    level = RISK_LEVEL.CRITICAL;
    reasons.push('safety:所有门禁均未通过 + 包含写/外部操作');
  }
  // 5b. CRITICAL: 累积错误 >= 3 → step_back
  else if (hasRecentErrors) {
    action = SAFETY_ACTION.STEP_BACK;
    level = RISK_LEVEL.CRITICAL;
  }
  // 5c. HIGH: 请求标记缺失 + 有外部调用 → step_back
  else if (!flags.execute_pipeline && hasExternalCalls) {
    action = SAFETY_ACTION.STEP_BACK;
    level = RISK_LEVEL.HIGH;
  }
  // 5d. HIGH: 处于 recovery → require_approval
  else if (inRecovery) {
    action = SAFETY_ACTION.REQUIRE_APPROVAL;
    level = RISK_LEVEL.HIGH;
  }
  // 5e. MEDIUM: env 开了但请求标记缺失 → dry_run_only
  else if (envEnabled && (!flags.execute_pipeline || !flags.confirm_external_effects)) {
    action = SAFETY_ACTION.DRY_RUN_ONLY;
    level = RISK_LEVEL.MEDIUM;
  }
  // 5f. MEDIUM: 环境变量未开 → dry_run_only
  else if (!envEnabled) {
    action = SAFETY_ACTION.DRY_RUN_ONLY;
    level = RISK_LEVEL.MEDIUM;
  }
  // 5g. LOW: 全部门禁通过（含外部调用已登记到 reasons/requiredApprovals）→ allow
  else if (envEnabled && flags.execute_pipeline && flags.confirm_external_effects) {
    action = SAFETY_ACTION.ALLOW;
    level = RISK_LEVEL.LOW;
  }
  // 5h. MEDIUM: reasons 非空但未被 5a-5g 处理 → dry_run_only (兜底保护)
  else if (reasons.length > 0) {
    action = SAFETY_ACTION.DRY_RUN_ONLY;
    level = RISK_LEVEL.MEDIUM;
    reasons.push('safety:unhandled_safety_reason_fallback');
    requiredApprovals.push('safety_fallback_review');
  }
  // 5i. LOW: 完全无问题 → allow

  return {
    decisionId: `safety-${nowIso()}-${Math.random().toString(36).slice(2, 6)}`,
    allowed: action === SAFETY_ACTION.ALLOW,
    level,
    action,
    reasons,
    requiredApprovals,
    writeAllowed: action === SAFETY_ACTION.ALLOW,
    evaluatedAt: nowIso(),
  };
}

// ── 查询辅助 ─────────────────────────────────────────────────────────

/** 是否允许写操作 */
function isWriteAllowed(decision) {
  return decision.writeAllowed === true && decision.allowed === true;
}

/** 是否需要人工审批 */
function requiresApproval(decision) {
  return decision.action === SAFETY_ACTION.REQUIRE_APPROVAL
      || decision.action === SAFETY_ACTION.STEP_BACK
      || decision.action === SAFETY_ACTION.ABORT;
}

/** 是否应该中止 */
function shouldAbort(decision) {
  return decision.action === SAFETY_ACTION.ABORT;
}

// ── 导出 ─────────────────────────────────────────────────────────────
module.exports = {
  RISK_LEVEL,
  SAFETY_ACTION,
  evaluatePipelineSafety,
  isWriteAllowed,
  requiresApproval,
  shouldAbort,
};
