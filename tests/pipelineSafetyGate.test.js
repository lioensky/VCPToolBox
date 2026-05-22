'use strict';

/**
 * pipelineSafetyGate 最小烟测
 * 验证 Finding 2 修复：step.plugin 能触发 external service 风险识别
 */

const {
  evaluatePipelineSafety,
  SAFETY_ACTION,
} = require('../modules/pipelineSafetyGate');

let passed = 0;
let failed = 0;

function assert(description, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${description}`);
    console.error(`  ${e.message}`);
  }
}

// ── 测试 1：plugin-only plan (DoubaoGen) + 全部门禁通过 → ALLOW ──
assert('plugin-only DoubaoGen with all gates open → ALLOW', () => {
  process.env.AIGENT_PIPELINE_ALLOW_EXECUTION = 'true';

  const decision = evaluatePipelineSafety({
    state: {},
    plan: {
      steps: [
        { type: 'generate_image', plugin: 'DoubaoGen', prompt: 'a red apple' },
      ],
    },
    requestFlags: {
      execute_pipeline: true,
      confirm_external_effects: true,
    },
  });

  if (decision.action !== SAFETY_ACTION.ALLOW) {
    throw new Error(`expected ALLOW, got ${decision.action}`);
  }
  if (!decision.allowed) {
    throw new Error('expected allowed=true');
  }
});

// ── 测试 2：reasons 包含 external_service ──
assert('plugin-only DoubaoGen → reasons includes external_service', () => {
  process.env.AIGENT_PIPELINE_ALLOW_EXECUTION = 'true';

  const decision = evaluatePipelineSafety({
    state: {},
    plan: {
      steps: [
        { type: 'generate_image', plugin: 'DoubaoGen', prompt: 'a red apple' },
      ],
    },
    requestFlags: {
      execute_pipeline: true,
      confirm_external_effects: true,
    },
  });

  if (!decision.reasons.includes('plan:包含外部服务调用')) {
    throw new Error(`reasons missing external marker: ${JSON.stringify(decision.reasons)}`);
  }
  if (!decision.requiredApprovals.includes('external_service')) {
    throw new Error(`requiredApprovals missing external_service: ${JSON.stringify(decision.requiredApprovals)}`);
  }
});

// ── 测试 3：plugin-only plan 无 requestFlags → STEP_BACK ──
assert('plugin-only DoubaoGen with no flags → STEP_BACK', () => {
  process.env.AIGENT_PIPELINE_ALLOW_EXECUTION = 'true';

  const decision = evaluatePipelineSafety({
    state: {},
    plan: {
      steps: [
        { type: 'generate_image', plugin: 'DoubaoGen', prompt: 'a red apple' },
      ],
    },
    requestFlags: {},
  });

  if (decision.action !== SAFETY_ACTION.STEP_BACK) {
    throw new Error(`expected STEP_BACK, got ${decision.action}`);
  }
});

// ── 测试 4：env 未开 + 无 requestFlags + 含外部插件 → ABORT ──
assert('plugin-only DoubaoGen with env disabled + no flags → ABORT', () => {
  delete process.env.AIGENT_PIPELINE_ALLOW_EXECUTION;

  const decision = evaluatePipelineSafety({
    state: {},
    plan: {
      steps: [
        { type: 'generate_image', plugin: 'DoubaoGen', prompt: 'a red apple' },
      ],
    },
    requestFlags: {},
  });

  if (decision.action !== SAFETY_ACTION.ABORT) {
    throw new Error(`expected ABORT, got ${decision.action}`);
  }
  if (!decision.reasons.includes('plan:包含外部服务调用')) {
    throw new Error('should still flag external service');
  }
});

// ── 测试 5：agent-based 旧格式仍可用 ──
assert('agent-based plan still works', () => {
  process.env.AIGENT_PIPELINE_ALLOW_EXECUTION = 'true';

  const decision = evaluatePipelineSafety({
    state: {},
    plan: {
      steps: [
        { type: 'generate', agent: 'ComfyUI', prompt: 'test' },
      ],
    },
    requestFlags: {
      execute_pipeline: true,
      confirm_external_effects: true,
    },
  });

  if (!decision.reasons.includes('plan:包含外部服务调用')) {
    throw new Error('agent-based external detection broken');
  }
});

// ── 测试 6：空 step 不含 agent 也不含 plugin → 无 external ──
assert('step with no agent and no plugin → no external', () => {
  process.env.AIGENT_PIPELINE_ALLOW_EXECUTION = 'true';

  const decision = evaluatePipelineSafety({
    state: {},
    plan: {
      steps: [
        { type: 'transform' },
      ],
    },
    requestFlags: {
      execute_pipeline: true,
      confirm_external_effects: true,
    },
  });

  if (decision.reasons.includes('plan:包含外部服务调用')) {
    throw new Error('should not flag transform step as external');
  }
});

// ── 清理 ──
delete process.env.AIGENT_PIPELINE_ALLOW_EXECUTION;

// ── 结果 ──
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
