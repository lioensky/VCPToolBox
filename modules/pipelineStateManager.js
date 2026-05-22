'use strict';

/**
 * PipelineStateManager — AI Image Pipeline 状态机
 *
 * 设计原则（来自 DGP 补习手册）：
 * - 只能通过 transition 函数改变 phase
 * - 非法状态转换会被拒绝并返回错误
 * - 状态对象是不可变式更新（返回新对象）
 * - 不依赖 PluginManager / server.js / 任何 IO
 */

// ── 阶段枚举 ────────────────────────────────────────────────────────
const PHASE = Object.freeze({
  PLANNING:      'planning',
  PREFLIGHT:     'preflight',
  EXECUTION:     'execution',
  VERIFICATION:  'verification',
  RECOVERY:      'recovery',
  CLOSED:        'closed',
});

const ALL_PHASES = Object.values(PHASE);

// ── 合法状态转换表 ───────────────────────────────────────────────────
// 格式: fromPhase -> Set<toPhase>
const VALID_TRANSITIONS = Object.freeze({
  [PHASE.PLANNING]:     new Set([PHASE.PREFLIGHT, PHASE.EXECUTION, PHASE.CLOSED]),
  [PHASE.PREFLIGHT]:    new Set([PHASE.EXECUTION, PHASE.RECOVERY, PHASE.CLOSED]),
  [PHASE.EXECUTION]:    new Set([PHASE.VERIFICATION, PHASE.RECOVERY, PHASE.CLOSED]),
  [PHASE.VERIFICATION]: new Set([PHASE.RECOVERY, PHASE.CLOSED]),
  [PHASE.RECOVERY]:     new Set([PHASE.EXECUTION, PHASE.CLOSED]),
  [PHASE.CLOSED]:       new Set([]),
});

// ── 终态 ─────────────────────────────────────────────────────────────
const TERMINAL_PHASES = new Set([PHASE.CLOSED]);

// ── helpers ──────────────────────────────────────────────────────────
const nowIso = () => new Date().toISOString();
const shortId = () => `ps-${Math.random().toString(36).slice(2, 10)}`;

/**
 * 浅合并，确保 updatedAt 总是更新
 */
function touch(state) {
  return { ...state, updatedAt: nowIso() };
}

// ── 工厂函数 ─────────────────────────────────────────────────────────

/**
 * 创建初始 PipelineState。
 *
 * @param {object} input
 * @param {string} [input.pipelineId]     - 流水线 ID，不提供则自动生成
 * @param {string} [input.taskId]         - 关联的任务 ID（来自 Orchestrator plan）
 * @param {boolean} [input.dryRun]        - 默认 true
 * @param {string} [input.initialPhase]   - 默认 "planning"
 * @param {object} [input.context]        - 附加上下文（用户输入、模型选择等）
 * @param {object} [input.planSnapshot]   - Orchestrator 产出的完整 plan（可选存档）
 * @returns {PipelineState}
 */
function createInitialPipelineState(input = {}) {
  const now = nowIso();

  return {
    schemaVersion: 'pipeline-state.v1',
    pipelineId:    input.pipelineId || shortId(),
    taskId:        input.taskId || null,
    phase:         input.initialPhase || PHASE.PLANNING,
    dryRun:        input.dryRun !== false,
    createdAt:     now,
    updatedAt:     now,
    context:       input.context || {},
    planSnapshot:  input.planSnapshot || null,
    errors:        [],
    checkpoints:   [],
    transitions:   [{
      from: null,
      to: input.initialPhase || PHASE.PLANNING,
      reason: 'initial',
      at: now,
    }],
  };
}

// ── 状态转换 ─────────────────────────────────────────────────────────

/**
 * 执行一次合法的 phase 转换。
 * 非法转换返回 { ok: false, error: '...' }，不抛异常。
 *
 * @param {PipelineState} state    - 当前状态
 * @param {string} nextPhase       - 目标 phase
 * @param {string} reason          - 转换原因（会被记入 transitions 日志）
 * @returns {{ ok: true, state: PipelineState } | { ok: false, error: string }}
 */
function transitionPipelineState(state, nextPhase, reason = '') {
  // 验证 phase 值
  if (!ALL_PHASES.includes(nextPhase)) {
    return {
      ok: false,
      error: `unknown phase: "${nextPhase}". valid phases: ${ALL_PHASES.join(', ')}`,
    };
  }

  // 终态不能转换
  if (isTerminalPhase(state.phase)) {
    return {
      ok: false,
      error: `cannot transition from terminal phase "${state.phase}"`,
    };
  }

  // 检查合法性
  const allowed = VALID_TRANSITIONS[state.phase];
  if (!allowed || !allowed.has(nextPhase)) {
    return {
      ok: false,
      error: `invalid transition: "${state.phase}" -> "${nextPhase}". allowed: ${[...allowed].join(', ')}`,
    };
  }

  // 执行转换
  const transition = {
    from: state.phase,
    to: nextPhase,
    reason: reason || `transition to ${nextPhase}`,
    at: nowIso(),
  };

  const newState = touch({
    ...state,
    phase: nextPhase,
    transitions: [...state.transitions, transition],
  });

  // 进入 recovery 时自动把 dryRun 关掉（recovery 必须接触真实状态）
  if (nextPhase === PHASE.RECOVERY) {
    newState.dryRun = false;
  }

  return { ok: true, state: newState };
}

// ── 查询 ─────────────────────────────────────────────────────────────

/** 是否为终态 */
function isTerminalPhase(phase) {
  return TERMINAL_PHASES.has(phase);
}

/** 是否可以执行写操作（execution + 非 dryRun） */
function isWriteAllowed(state) {
  return state.phase === PHASE.EXECUTION && state.dryRun === false;
}

/** 是否需要人工介入 */
function requiresHumanIntervention(state) {
  return state.phase === PHASE.RECOVERY || state.phase === PHASE.PREFLIGHT;
}

// ── 错误 / 检查点操作 ────────────────────────────────────────────────

/**
 * 向状态追加一条错误记录（不改变 phase）。
 */
function recordError(state, error) {
  const entry = {
    errorId: shortId(),
    phase: state.phase,
    message: typeof error === 'string' ? error : (error.message || String(error)),
    detail: typeof error === 'object' ? error : null,
    at: nowIso(),
  };

  return touch({
    ...state,
    errors: [...state.errors, entry],
  });
}

/**
 * 向状态追加一条检查点记录。
 */
function recordCheckpoint(state, checkpoint) {
  const entry = {
    checkpointId: checkpoint.checkpointId || shortId(),
    phase: state.phase,
    label: checkpoint.label || '',
    data: checkpoint.data || null,
    at: nowIso(),
  };

  return touch({
    ...state,
    checkpoints: [...state.checkpoints, entry],
  });
}

// ── 导出 ─────────────────────────────────────────────────────────────
module.exports = {
  // 常量
  PHASE,
  VALID_TRANSITIONS,
  TERMINAL_PHASES,

  // 工厂
  createInitialPipelineState,

  // 状态转换
  transitionPipelineState,

  // 查询
  isTerminalPhase,
  isWriteAllowed,
  requiresHumanIntervention,

  // 操作
  recordError,
  recordCheckpoint,
};
