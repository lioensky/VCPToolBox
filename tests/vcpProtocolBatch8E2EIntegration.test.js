'use strict';

if (process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE === undefined) {
  process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = 'true';
}

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const protocolResilience = require('../modules/vcpProtocolResilience');
const {
  cleanseHistory,
  stripResilienceMarkers,
  extractHistoricalErrorBlocks,
  extractTopLevelPillEnvelope,
  foldWithPillIfPresent,
  copyArrayMetadata,
  calculateFingerprint
} = protocolResilience;

const ContextFoldingV2 = require('../Plugin/ContextFoldingV2/ContextFoldingV2');
const TextSanitizer = require('../Plugin/RAGDiaryPlugin/TextSanitizer');
const FoldingStore = require('../Plugin/RAGDiaryPlugin/FoldingStore');
const ContextVectorManager = require('../Plugin/RAGDiaryPlugin/ContextVectorManager');
const RAGDiaryPlugin = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
const OneRingMemo = require('../Plugin/OneRing/OneRingMemo');
const roleDivider = require('../modules/roleDivider');

// =========================================================================
// 辅助工具与 Mock 工厂
// =========================================================================

function createErrorReceipt(badBlockText, code = 'MISSING_TOOL_NAME', options = {}) {
  const errMap = extractHistoricalErrorBlocks(badBlockText, {
    protectRoleDivider: true,
    isHistoryExtraction: true,
    includeClosedBlockCandidates: true,
    finishReason: 'stop',
    sawDone: true
  });
  const fps = Array.from(errMap.keys());
  const fp = fps[0] || calculateFingerprint(badBlockText);

  const timestamp = options.timestamp || '2026-11-23T12:00:00.000+08:00';
  const toolName = options.toolName || 'VCP工具调用';
  const summaryLine = options.summaryLine || `${toolName} 格式错误（未执行）。`;

  return [
    '<<<[ROLE_DIVIDE_USER]>>>',
    `<<<[VCP_TOOL_BATCH_START:${timestamp}]>>>`,
    '[[VCP调用结果信息汇总:',
    `- 工具名称: ${toolName}`,
    '- 执行状态: ❌ ERROR',
    `- 返回内容: [[VCP协议纠偏指导: code=${code} block=${fp}]]`,
    '请修正参数并重试！',
    '[[/VCP协议纠偏指导]]',
    'VCP调用结果结束]]',
    '[本轮工具调用摘要:]',
    summaryLine,
    '[本轮工具调用摘要结束]',
    `<<<[VCP_TOOL_BATCH_END:${timestamp}]>>>`,
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');
}

function createResidentPill(warnings = []) {
  const defaultWarning = '⚠️ 【工具名错位拦截】严禁将工具名称作为字段 Key，必须使用 tool_name:「始」工具名「末」。';
  const warningList = warnings.length > 0 ? warnings : [defaultWarning];
  return [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '[系统提示:] 【VCP 工具调用协议规范】',
    '你上一轮尝试调用的工具格式有误，系统已拦截并提供格式指导。',
    '为保证后续工具正常执行，请牢记以下铁律：',
    '一、标准块边界：<<<[TOOL_REQUEST]>>> ... <<<[END_TOOL_REQUEST]>>>',
    '二、定界符规范：必须使用中文定界符 「始 ... 末」',
    '三、字段顺序：tool_name -> maid -> 其他参数',
    '四、防错警示（根据近期错因生成）：',
    ...warningList.map(w => `- ${w}`),
    '【/VCP 工具调用协议规范】',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');
}

// =========================================================================
// 维度 1：【极高危 P0】preprocessor_order.json 与 chatCompletionHandler 管线时序、回退防漏挂与元数据保全
// =========================================================================

test('D1-1: preprocessor_order.json 严格物理顺位：$ToolProtocolHistoryCleanse 紧跟 OneRing 并先于 ContextFoldingV2', () => {
  const orderPath = path.join(__dirname, '..', 'preprocessor_order.json');
  const order = JSON.parse(fs.readFileSync(orderPath, 'utf8'));

  const oneRingIdx = order.indexOf('OneRing');
  const cleanseIdx = order.indexOf('$ToolProtocolHistoryCleanse');
  const foldingIdx = order.indexOf('ContextFoldingV2');

  assert.ok(oneRingIdx !== -1, 'preprocessor_order.json 必须包含 OneRing');
  assert.ok(cleanseIdx !== -1, 'preprocessor_order.json 必须包含 $ToolProtocolHistoryCleanse');
  assert.ok(foldingIdx !== -1, 'preprocessor_order.json 必须包含 ContextFoldingV2');

  assert.equal(cleanseIdx, oneRingIdx + 1, '$ToolProtocolHistoryCleanse 必须严格位于 OneRing 紧随其后的位置');
  assert.equal(cleanseIdx, foldingIdx - 1, '$ToolProtocolHistoryCleanse 必须严格位于 ContextFoldingV2 正前方的绝对顺位');
});

test('D1-2: chatCompletionHandler 虚拟阶段动态回退防漏挂保底机制', () => {
  // 模拟运行环境中 preprocessorOrder 缺失 $ToolProtocolHistoryCleanse 的三种边缘场景
  const TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE = '$ToolProtocolHistoryCleanse';

  // 场景 A: 包含 OneRing 与 ContextFoldingV2，但遗漏虚拟阶段
  {
    const rawPipeline = ['RAGDiaryPlugin', 'OneRing', 'ContextFoldingV2'];
    let ordered = [...rawPipeline];
    if (!ordered.includes(TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE)) {
      const oneRingIdx = ordered.indexOf('OneRing');
      if (oneRingIdx !== -1) {
        ordered.splice(oneRingIdx + 1, 0, TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
      } else {
        const foldingIdx = ordered.indexOf('ContextFoldingV2');
        if (foldingIdx !== -1) {
          ordered.splice(foldingIdx, 0, TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
        } else {
          ordered.push(TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
        }
      }
    }
    assert.deepEqual(ordered, ['RAGDiaryPlugin', 'OneRing', '$ToolProtocolHistoryCleanse', 'ContextFoldingV2']);
  }

  // 场景 B: 遗漏 OneRing 但包含 ContextFoldingV2
  {
    const rawPipeline = ['RAGDiaryPlugin', 'ContextFoldingV2'];
    let ordered = [...rawPipeline];
    if (!ordered.includes(TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE)) {
      const oneRingIdx = ordered.indexOf('OneRing');
      if (oneRingIdx !== -1) {
        ordered.splice(oneRingIdx + 1, 0, TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
      } else {
        const foldingIdx = ordered.indexOf('ContextFoldingV2');
        if (foldingIdx !== -1) {
          ordered.splice(foldingIdx, 0, TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
        } else {
          ordered.push(TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
        }
      }
    }
    assert.deepEqual(ordered, ['RAGDiaryPlugin', '$ToolProtocolHistoryCleanse', 'ContextFoldingV2']);
  }

  // 场景 C: 两者皆无（极端最小管线）
  {
    const rawPipeline = ['RAGDiaryPlugin'];
    let ordered = [...rawPipeline];
    if (!ordered.includes(TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE)) {
      const oneRingIdx = ordered.indexOf('OneRing');
      if (oneRingIdx !== -1) {
        ordered.splice(oneRingIdx + 1, 0, TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
      } else {
        const foldingIdx = ordered.indexOf('ContextFoldingV2');
        if (foldingIdx !== -1) {
          ordered.splice(foldingIdx, 0, TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
        } else {
          ordered.push(TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
        }
      }
    }
    assert.deepEqual(ordered, ['RAGDiaryPlugin', '$ToolProtocolHistoryCleanse']);
  }

  // 场景 D: 用户误操作将 $ToolProtocolHistoryCleanse 拖拽至 OneRing 前方，自动纠正错位
  {
    const rawPipeline = ['$ToolProtocolHistoryCleanse', 'RAGDiaryPlugin', 'OneRing', 'ContextFoldingV2'];
    let ordered = [...rawPipeline];
    if (!ordered.includes(TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE)) {
      const oneRingIdx = ordered.indexOf('OneRing');
      if (oneRingIdx !== -1) {
        ordered.splice(oneRingIdx + 1, 0, TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
      } else {
        const foldingIdx = ordered.indexOf('ContextFoldingV2');
        if (foldingIdx !== -1) {
          ordered.splice(foldingIdx, 0, TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
        } else {
          ordered.push(TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
        }
      }
    }
    const oneRingIdx = ordered.indexOf('OneRing');
    const foldingIdx = ordered.indexOf('ContextFoldingV2');
    const cleanseIdx = ordered.indexOf(TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
    if (cleanseIdx !== -1) {
      let isMisplaced = false;
      if (oneRingIdx !== -1 && cleanseIdx < oneRingIdx) isMisplaced = true;
      if (foldingIdx !== -1 && cleanseIdx > foldingIdx) isMisplaced = true;
      if (isMisplaced) {
        ordered.splice(cleanseIdx, 1);
        const newOneRingIdx = ordered.indexOf('OneRing');
        if (newOneRingIdx !== -1) {
          ordered.splice(newOneRingIdx + 1, 0, TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
        } else {
          const newFoldingIdx = ordered.indexOf('ContextFoldingV2');
          if (newFoldingIdx !== -1) {
            ordered.splice(newFoldingIdx, 0, TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
          } else {
            ordered.push(TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
          }
        }
      }
    }
    assert.deepEqual(ordered, ['RAGDiaryPlugin', 'OneRing', '$ToolProtocolHistoryCleanse', 'ContextFoldingV2']);
  }

  // 场景 E: 用户误操作将 $ToolProtocolHistoryCleanse 拖拽至 ContextFoldingV2 后方，双向错位检测自愈重插至 OneRing 之后
  {
    const rawPipeline = ['RAGDiaryPlugin', 'OneRing', 'ContextFoldingV2', '$ToolProtocolHistoryCleanse'];
    let ordered = [...rawPipeline];
    if (!ordered.includes(TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE)) {
      const oneRingIdx = ordered.indexOf('OneRing');
      if (oneRingIdx !== -1) {
        ordered.splice(oneRingIdx + 1, 0, TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
      } else {
        const foldingIdx = ordered.indexOf('ContextFoldingV2');
        if (foldingIdx !== -1) {
          ordered.splice(foldingIdx, 0, TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
        } else {
          ordered.push(TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
        }
      }
    }
    const oneRingIdx = ordered.indexOf('OneRing');
    const foldingIdx = ordered.indexOf('ContextFoldingV2');
    const cleanseIdx = ordered.indexOf(TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
    if (cleanseIdx !== -1) {
      let isMisplaced = false;
      if (oneRingIdx !== -1 && cleanseIdx < oneRingIdx) isMisplaced = true;
      if (foldingIdx !== -1 && cleanseIdx > foldingIdx) isMisplaced = true;
      if (isMisplaced) {
        ordered.splice(cleanseIdx, 1);
        const newOneRingIdx = ordered.indexOf('OneRing');
        if (newOneRingIdx !== -1) {
          ordered.splice(newOneRingIdx + 1, 0, TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
        } else {
          const newFoldingIdx = ordered.indexOf('ContextFoldingV2');
          if (newFoldingIdx !== -1) {
            ordered.splice(newFoldingIdx, 0, TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
          } else {
            ordered.push(TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
          }
        }
      }
    }
    assert.deepEqual(ordered, ['RAGDiaryPlugin', 'OneRing', '$ToolProtocolHistoryCleanse', 'ContextFoldingV2'], '向后错位必须自愈至 OneRing 之后');
  }

  // 场景 F: 无 OneRing 且用户误操作将 $ToolProtocolHistoryCleanse 拖拽至 ContextFoldingV2 后方，自愈重插至 ContextFoldingV2 之前
  {
    const rawPipeline = ['RAGDiaryPlugin', 'ContextFoldingV2', '$ToolProtocolHistoryCleanse'];
    let ordered = [...rawPipeline];
    if (!ordered.includes(TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE)) {
      const oneRingIdx = ordered.indexOf('OneRing');
      if (oneRingIdx !== -1) {
        ordered.splice(oneRingIdx + 1, 0, TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
      } else {
        const foldingIdx = ordered.indexOf('ContextFoldingV2');
        if (foldingIdx !== -1) {
          ordered.splice(foldingIdx, 0, TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
        } else {
          ordered.push(TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
        }
      }
    }
    const oneRingIdx = ordered.indexOf('OneRing');
    const foldingIdx = ordered.indexOf('ContextFoldingV2');
    const cleanseIdx = ordered.indexOf(TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
    if (cleanseIdx !== -1) {
      let isMisplaced = false;
      if (oneRingIdx !== -1 && cleanseIdx < oneRingIdx) isMisplaced = true;
      if (foldingIdx !== -1 && cleanseIdx > foldingIdx) isMisplaced = true;
      if (isMisplaced) {
        ordered.splice(cleanseIdx, 1);
        const newOneRingIdx = ordered.indexOf('OneRing');
        if (newOneRingIdx !== -1) {
          ordered.splice(newOneRingIdx + 1, 0, TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
        } else {
          const newFoldingIdx = ordered.indexOf('ContextFoldingV2');
          if (newFoldingIdx !== -1) {
            ordered.splice(newFoldingIdx, 0, TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
          } else {
            ordered.push(TOOL_PROTOCOL_HISTORY_CLEANSE_STAGE);
          }
        }
      }
    }
    assert.deepEqual(ordered, ['RAGDiaryPlugin', '$ToolProtocolHistoryCleanse', 'ContextFoldingV2'], '无 OneRing 时向后错位必须自愈至 ContextFoldingV2 之前');
  }
});

test('D1-4: Plugin.js 注册 $ToolProtocolHistoryCleanse 虚拟阶段与 getPreprocessorOrder 元数据展示', () => {
  const pluginManager = require('../Plugin');
  pluginManager.preprocessorOrder = [
    'OneRing',
    '$ToolProtocolHistoryCleanse',
    'ContextFoldingV2'
  ];
  const orderList = pluginManager.getPreprocessorOrder();
  const cleanseStage = orderList.find(item => item.name === '$ToolProtocolHistoryCleanse');
  assert.ok(cleanseStage, '$ToolProtocolHistoryCleanse 必须在 getPreprocessorOrder 中被识别');
  assert.equal(cleanseStage.kind, 'stage');
  assert.equal(cleanseStage.displayName, 'VCP工具协议轮间历史清洗与药丸装载');
  assert.ok(cleanseStage.description.includes('OneRing'));
});

test('D1-3: copyArrayMetadata 的 Reflect.ownKeys 升级与 Symbol / __oneRingMeta 元数据无损保全', () => {
  const source = [
    { role: 'user', content: '测试问题' },
    { role: 'assistant', content: '测试回答' }
  ];

  const testSymbol = Symbol('turnMetadata');
  source.__oneRingMeta = { snapshotId: 'snap-888', agentName: 'Nova' };
  source[testSymbol] = { phase: 'batch8_final' };

  const target = [
    { role: 'user', content: '测试问题' },
    { role: 'assistant', content: '测试回答' }
  ];

  copyArrayMetadata(source, target);

  assert.deepEqual(target.__oneRingMeta, { snapshotId: 'snap-888', agentName: 'Nova' }, '__oneRingMeta 必须完整保留');
  assert.deepEqual(target[testSymbol], { phase: 'batch8_final' }, 'Symbol 属性必须通过 Reflect.ownKeys 完整保留');
  assert.equal(target.length, 2, '数组 length 属性不受影响');
});

// =========================================================================
// 维度 2：【极高危 P0】ContextFoldingV2._sanitizeOneRingMarkers 尾锚正则与药丸顺序冲突（三态哈希 100% 恒等）
// =========================================================================

test('D2-1: 同一楼层在 State 0（未洗原件态）、State 1（活药态）、State 2（退药态）下哈希与净文本 100% 逐字节恒等', () => {
  const badBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const receipt = createErrorReceipt(badBlock, 'MISSING_TOOL_NAME');
  const pill = createResidentPill();

  const prose = '助手回答正文：这是详细的解答文本，提供了完整的操作指南。';
  const oneRingTail = '\n[OneRing通知:2026-11-23 12:00:00 @web]';

  // State 0: 第 5 步 RAGDiaryPlugin._syncContextToFoldingStore 处理的未洗原始文本
  const state0 = [prose, badBlock].join('\n') + oneRingTail + '\n' + receipt;

  // State 1: 第 10 步 ContextFoldingV2 消费的 $ToolProtocolHistoryCleanse 变药后活药态文本
  const state1 = prose + oneRingTail + '\n' + pill;

  // State 2: 第 10 步 ContextFoldingV2 消费的后续轮次退药态文本
  const state2 = prose + oneRingTail;

  const s0 = TextSanitizer.sanitizeForEmbedding(ContextFoldingV2._sanitizeOneRingMarkers(state0), 'assistant');
  const s1 = TextSanitizer.sanitizeForEmbedding(ContextFoldingV2._sanitizeOneRingMarkers(state1), 'assistant');
  const s2 = TextSanitizer.sanitizeForEmbedding(ContextFoldingV2._sanitizeOneRingMarkers(state2), 'assistant');

  assert.equal(s0, s1, 'State 0 与 State 1 净化后纯文本必须逐字节一致');
  assert.equal(s1, s2, 'State 1 与 State 2 净化后纯文本必须逐字节一致');
  assert.equal(s0, prose, '净化后文本必须彻底剥离坏块、回执、药丸及 OneRing 尾标，仅留正文');

  const h0 = FoldingStore.hashContent(s0);
  const h1 = FoldingStore.hashContent(s1);
  const h2 = FoldingStore.hashContent(s2);

  assert.equal(h0, h1, 'State 0 与 State 1 的 FoldingStore.hashContent 必须 100% 恒等');
  assert.equal(h1, h2, 'State 1 与 State 2 的 FoldingStore.hashContent 必须 100% 恒等');
});

test('D2-2: ContextFoldingV2._sanitizeOneRingMarkers 严密收敛：正文提及 [OneRing通知: 示例...] 不被尾标正则贪婪误吞', () => {
  const proseWithExample = '正文讨论了 [OneRing通知: 2026-11-23 这是正文示例并非尾标] 相关机制，请确认。';
  const realTail = '\n[OneRing通知:2026-11-23 12:00:00 @web]';
  const compoundText = proseWithExample + realTail;

  const sanitized = ContextFoldingV2._sanitizeOneRingMarkers(compoundText);
  assert.equal(sanitized, proseWithExample, '真实尾标必须被剥离，而正文中内嵌的 OneRing 示例与后续正文必须 100% 完整保留');

  // 验证连续多个尾标的场景
  const multiTail = proseWithExample + '\n[OneRing通知:2026-11-23 12:00:00 @web]\n[OneRing通知:2026-11-23 12:05:00 @tool]';
  const sanitizedMulti = ContextFoldingV2._sanitizeOneRingMarkers(multiTail);
  assert.equal(sanitizedMulti, proseWithExample, '连续多个 OneRing 尾标必须全部被正确剥离');
});

// =========================================================================
// 维度 3：【极高危 P0】ContextFoldingV2 多模态含图含药折叠、残缺药丸跳过折叠与异步摘要输入净化
// =========================================================================

test('D3-1: 多模态含图含药楼层折叠写回（药丸追加在末尾，严禁置于图片前方导致切分为 3 条消息）', () => {
  const pill = createResidentPill();
  const summaryText = '[VCP上下文语义折叠-本层摘要: 这是一个包含图表的历史分析摘要]';

  const multimodalContent = [
    { type: 'text', text: '这是前置文本说明' },
    { type: 'image_url', image_url: { url: 'https://example.com/chart.png' }, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: pill }
  ];

  const foldedContent = foldWithPillIfPresent(multimodalContent, summaryText);

  assert.ok(Array.isArray(foldedContent), '折叠结果必须保持多模态数组格式');
  assert.equal(foldedContent[0].type, 'text');
  assert.equal(foldedContent[0].text, summaryText, '第 0 个分片必须替换为折叠摘要');

  assert.equal(foldedContent[1].type, 'image_url', '第 1 个分片必须完整保留图片分片');
  assert.deepEqual(foldedContent[1].cache_control, { type: 'ephemeral' }, 'cache_control 元数据必须无损保留');

  assert.equal(foldedContent[2].type, 'text');
  assert.ok(foldedContent[2].text.includes('【VCP 工具调用协议规范】'), '药丸必须位于数组末尾分片');

  // 角色切分测试：验证 roleDivider.process 将其严格切分为 2 条消息（1 assistant, 1 user）
  const messages = [{ role: 'assistant', content: foldedContent }];
  const divided = roleDivider.process(messages);

  assert.equal(divided.length, 2, '切分后消息数量必须严格为 2，严禁切成 3 条碎消息');
  assert.equal(divided[0].role, 'assistant', '第 1 条消息必须为 assistant 角色');
  assert.equal(divided[1].role, 'user', '第 2 条消息必须为 user 角色（常驻药丸）');

  assert.ok(Array.isArray(divided[0].content), 'assistant 内容保持多模态数组');
  assert.equal(divided[0].content[0].text, summaryText);
  assert.equal(divided[0].content[1].type, 'image_url');
  assert.ok(divided[1].content.includes('【VCP 工具调用协议规范】'), 'user 消息承载常驻药丸');
});

test('D3-2: 残缺药丸界定符触发 P6 失败安全，extractTopLevelPillEnvelope 指示 shouldSkipFolding=true', () => {
  // 包含 <<<[ROLE_DIVIDE_USER]>>> 但缺失闭合标记的残缺药丸
  const malformedPillContent = [
    '这是助手的正文内容',
    '<<<[ROLE_DIVIDE_USER]>>>',
    '[系统提示:] 【VCP 工具调用协议规范】',
    '残缺药丸正文未闭合'
  ].join('\n');

  const check = extractTopLevelPillEnvelope(malformedPillContent);
  assert.equal(check.shouldSkipFolding, true, '残缺药丸必须返回 shouldSkipFolding: true 以跳过折叠');
});

test('D3-3: 异步摘要输入净化：_generateSummary 传给摘要大模型的输入 100% 不含药丸与 OneRing 尾标', () => {
  const pill = createResidentPill();
  const inputWithPillAndOneRing = [
    '助手详细回复了用户的代码架构设计。',
    '[OneRing通知:2026-11-23 12:00:00 @web]',
    pill
  ].join('\n');

  let sanitized = stripResilienceMarkers(inputWithPillAndOneRing);
  sanitized = ContextFoldingV2._sanitizeOneRingMarkers(sanitized);

  assert.equal(sanitized.trim(), '助手详细回复了用户的代码架构设计。');
  assert.ok(!sanitized.includes('【VCP 工具调用协议规范】'));
  assert.ok(!sanitized.includes('OneRing通知'));
  assert.ok(!sanitized.includes('ROLE_DIVIDE_USER'));
});

// =========================================================================
// 维度 4：RAGDiaryPlugin 四点三路向量净化入口全覆盖审计
// =========================================================================

test('D4-1: TextSanitizer.sanitizeForEmbedding 优先调用 stripResilienceMarkers 剥离药丸与 HTML', () => {
  const pill = createResidentPill();
  const htmlWithPill = `<p>用户业务正文内容</p>\n${pill}`;

  const clean = TextSanitizer.sanitizeForEmbedding(htmlWithPill, 'assistant');
  assert.equal(clean, '用户业务正文内容');
  assert.ok(!clean.includes('【VCP 工具调用协议规范】'));
});

test('D4-2: ContextVectorManager._normalize 幂等调用 stripResilienceMarkers', () => {
  const mockPlugin = {
    _stripHtml: t => t.replace(/<[^>]+>/g, ''),
    _stripEmoji: t => t,
    _stripToolMarkers: t => t
  };
  const cvm = new ContextVectorManager(mockPlugin);

  const pill = createResidentPill();
  const rawText = `核心上下文记忆文本\n${pill}`;
  const normalized = cvm._normalize(rawText);

  assert.equal(normalized, '核心上下文记忆文本');
  assert.ok(!normalized.includes('vcp 工具调用协议规范'));
});

test('D4-3: refreshRagBlock 混合批次防御：协议错误指导不污染 toolVector', () => {
  const badBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const receipt = createErrorReceipt(badBlock, 'MISSING_TOOL_NAME');
  const validToolResult = JSON.stringify({ status: 'success', data: '用户查询结果' });

  // 模拟混合批次在 refreshRagBlock 中拼接出的 toolContentForVector
  const mixedToolContent = `${validToolResult}\n${receipt}`;

  const sanitized = stripResilienceMarkers(mixedToolContent);
  assert.ok(sanitized.includes(validToolResult), '合法工具输出必须保留');
  assert.ok(!sanitized.includes('[[VCP协议纠偏指导:'), '纠偏指导必须被完全剥除');
  assert.ok(!sanitized.includes('ROLE_DIVIDE_USER'), '回执外壳必须被完全剥除');
});

test('D4-4: _extractContextDiaryPrefixes 拦截未执行的坏 DailyNote 块前缀提取', () => {
  const badDailyNoteBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'tool_name:「始」DailyNote「末」,',
    'Content:「始」2026-11-23 坏日记内容，不应该被提取进前缀「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const receipt = createErrorReceipt(badDailyNoteBlock, 'INVALID_TOOL_NAME');

  const messages = [
    { role: 'user', content: '写日记' },
    { role: 'assistant', content: `正在保存日记：\n${badDailyNoteBlock}\n${receipt}` }
  ];

  const prefixes = RAGDiaryPlugin._extractContextDiaryPrefixes(messages);
  assert.equal(prefixes.size, 0, '未执行的坏 DailyNote 块的前缀绝对不能被提取进 prefixes 集合');
});

// =========================================================================
// 维度 5：【极高危 P0】OneRingMemo.js 数据库初稿无凭条净化与保护 IV-4 / V-TIER2 正常长文散文
// =========================================================================

test('D5-1: OneRingMemo.formatTimelineRows 清洗形态 A（带回执或药丸的入库历史）', () => {
  const badBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const receipt = createErrorReceipt(badBlock, 'MISSING_TOOL_NAME');

  const rows = [
    {
      timestamp: '2026-11-23 12:00:00',
      role: 'assistant',
      senderName: 'Nova',
      frontendSource: 'web',
      content: `前置业务答复文本。\n${badBlock}\n${receipt}`
    }
  ];

  const formatted = OneRingMemo.formatTimelineRows(rows, 'Nova');
  assert.ok(formatted.includes('前置业务答复文本。'), '正文答复必须保留');
  assert.ok(!formatted.includes(badBlock), '坏工具块必须被擦除');
  assert.ok(!formatted.includes('ROLE_DIVIDE_USER'), '回执凭条必须被擦除');
});

test('D5-2: OneRingMemo.formatTimelineRows 清洗形态 B（第 T 轮初稿刚入库无凭条的高确定性坏块）', () => {
  const malformedBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'LinuxShellExecutor:「始」ls -la「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const rows = [
    {
      timestamp: '2026-11-23 12:05:00',
      role: 'assistant',
      senderName: 'Nova',
      frontendSource: 'web',
      content: `系统初始化检查：\n${malformedBlock}\n请根据上述输出确认。`
    }
  ];

  const formatted = OneRingMemo.formatTimelineRows(rows, 'Nova');
  assert.ok(formatted.includes('系统初始化检查：'), '前置说明必须保留');
  assert.ok(formatted.includes('请根据上述输出确认。'), '后置说明必须保留');
  assert.ok(!formatted.includes(malformedBlock), '形态 B 确定性语法坏块必须被同步剔除');
});

test('D5-3: 【铁律保护】OneRingMemo.formatTimelineRows 绝对不误删 IV-4 与 V-TIER2 正常技术散文长文', () => {
  // 构造一段 >500 字的技术解答长文，其中包含类似伪代码或冒号结构（易触发 IV-4 或 V-TIER2 候选）
  const longTutorialProse = [
    '下面是关于 Linux 权限配置的详细技术教程：',
    '1. 权限概述：Linux 文件权限分为读 (r)、写 (w)、执行 (x) 三种基本权限。',
    '2. 关键指令说明：',
    'chmod: 修改文件模式与访问权限。例如：chmod 755 /var/www/html 可以为所有者赋予全部权限，为其他用户赋予读与执行权限。',
    'chown: 修改文件所有者与所属用户组。例如：chown -R www-data:www-data /var/www 可以递归修改目录归属。',
    '3. 配置文件语法示例：',
    '配置项语法格式如下：',
    'server_name: 「始」example.com「末」;',
    'listen_port: 8080;',
    'root_directory: /var/www/html;',
    '4. 常见排错建议与安全防护考量：',
    '务必检查防火墙设置 (ufw allow 8080) 以及 SELinux 状态。确保服务进程不会以 root 权限非必要运行。',
    '以上为完整的部署与排错参考，请按需执行。'
  ].join('\n');

  const rows = [
    {
      timestamp: '2026-11-23 12:10:00',
      role: 'assistant',
      senderName: 'Nova',
      frontendSource: 'web',
      content: longTutorialProse
    }
  ];

  const formatted = OneRingMemo.formatTimelineRows(rows, 'Nova');

  assert.ok(formatted.includes('下面是关于 Linux 权限配置的详细技术教程：'), '教程头部必须完整保留');
  assert.ok(formatted.includes('chmod 755 /var/www/html'), '教程正文命令必须完整保留');
  assert.ok(formatted.includes('server_name: 「始」example.com「末」;'), '正文定界符示例必须完整保留');
  assert.ok(formatted.includes('以上为完整的部署与排错参考，请按需执行。'), '教程尾部必须完整保留');
  assert.equal(formatted.includes(longTutorialProse), true, '整篇长文散文必须 100% 完整保留，零字节误删！');
});

test('D5-4: OneRingMemo.formatTimelineRows 不修改原始 SQLite row 对象', () => {
  const badBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const originalContent = `正文\n${badBlock}`;
  const row = {
    timestamp: '2026-11-23 12:00:00',
    role: 'assistant',
    senderName: 'Nova',
    frontendSource: 'web',
    content: originalContent
  };

  OneRingMemo.formatTimelineRows([row], 'Nova');

  assert.equal(row.content, originalContent, '原始 row 对象的 content 属性绝不允许被原地修改');
});

test('D5-5: OneRingMemo.formatTimelineRows 绝对保留 assistant 的合法标准闭合工具调用（如 PluginSourceViewer / LinuxShellExecutor）', () => {
  const legalToolBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」PluginSourceViewer「末」,',
    'targettool:「始」LinuxShellExecutor「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const rows = [
    {
      timestamp: '2026-11-23 12:15:00',
      role: 'assistant',
      senderName: 'Nova',
      frontendSource: 'web',
      content: `我来为您查询插件源码：\n${legalToolBlock}\n已成功发起查询。`
    }
  ];

  const formatted = OneRingMemo.formatTimelineRows(rows, 'Nova');
  assert.ok(formatted.includes('我来为您查询插件源码：'), '前置说明必须保留');
  assert.ok(formatted.includes(legalToolBlock), '合法标准闭合工具调用必须 100% 完整保留，绝对不得误杀！');
  assert.ok(formatted.includes('已成功发起查询。'), '后置说明必须保留');
});

test('D5-6: OneRingMemo.formatTimelineRows 绝对不篡改 user 角色发言中提及的未闭合工具语法与残缺块', () => {
  const userSyntaxQuery = [
    '你好，我在使用工具调用时遇到了格式问题：',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」',
    '请问这里是不是少写了 END_TOOL_REQUEST 闭合标记？'
  ].join('\n');

  const rows = [
    {
      timestamp: '2026-11-23 12:20:00',
      role: 'user',
      senderName: '用户',
      frontendSource: 'web',
      content: userSyntaxQuery
    }
  ];

  const formatted = OneRingMemo.formatTimelineRows(rows, 'Nova');
  assert.ok(formatted.includes(userSyntaxQuery), '用户的发言内容必须 100% 原样保留，绝对不允许被当成坏块擦除！');
});

// =========================================================================
// 维度 6：跨轮次全链路闭环端到端总联调（Turn T -> T+1 -> T+2）
// =========================================================================

test('D6-1: Turn T -> T+1 -> T+2 全链路跨轮次状态机闭环与退药态哈希恒定实测', () => {
  // --- Turn T: 轮内发生协议错误并生成回执 ---
  const badBlockT = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const receiptT = createErrorReceipt(badBlockT, 'MISSING_TOOL_NAME', { timestamp: '2026-11-23T12:00:00.000+08:00' });
  const proseT = '第一轮助手正文：正在帮您查询。';

  const turnT_AssistantContent = `${proseT}\n${badBlockT}\n${receiptT}`;

  // --- Turn T+1: 客户端发回历史，经 $ToolProtocolHistoryCleanse 变药 ---
  const historyT1 = [
    { role: 'user', content: '请帮我查询' },
    { role: 'assistant', content: turnT_AssistantContent },
    { role: 'user', content: '继续执行' }
  ];

  const mockAgentManager = {
    isAgent: (name) => /^nova$/i.test(String(name || '').trim()),
    agentMap: new Map([['Nova', 'Nova.txt']])
  };
  const cleansedT1 = cleanseHistory(historyT1, { enableRoleDivider: true, agentManager: mockAgentManager });
  const assistantT1 = cleansedT1[1].content;

  assert.ok(assistantT1.includes(proseT), 'Turn T 前置散文保留');
  assert.ok(!assistantT1.includes(badBlockT), 'Turn T 坏工具块彻底擦除');
  assert.ok(assistantT1.includes('【VCP 工具调用协议规范】'), 'Turn T 成功挂载唯一常驻系统药丸');

  // 验证在 ContextFoldingV2 下对 Turn T 楼层的折叠保留药丸
  const foldedAssistantT1 = foldWithPillIfPresent(assistantT1, '[VCP上下文语义折叠-本层摘要: 第一轮摘要]');
  const dividedT1 = roleDivider.process([{ role: 'assistant', content: foldedAssistantT1 }]);
  assert.equal(dividedT1.length, 2, '切分为 assistant(摘要) + user(药丸)');

  // --- Turn T+2: 第二轮助手发生新类型错误，触发单药动态累加与旧药拔除（退药态） ---
  const badBlockT2 = [
    '<<<[TOOL_REQUEST]>>>',
    'tool_name:「始」Nova「末」,',
    'command:「始」ls「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const receiptT2 = createErrorReceipt(badBlockT2, 'ROLE_IN_TOOL_NAME', { timestamp: '2026-11-23T12:05:00.000+08:00' });
  const proseT2 = '第二轮助手正文：重新尝试。';

  const historyT2 = [
    cleansedT1[0],
    cleansedT1[1], // 包含 Turn T 的旧药丸
    cleansedT1[2],
    { role: 'assistant', content: `${proseT2}\n${badBlockT2}\n${receiptT2}` },
    { role: 'user', content: '还是报错了' }
  ];

  const cleansedT2 = cleanseHistory(historyT2, { enableRoleDivider: true, agentManager: mockAgentManager });

  // 验证 Turn T 旧楼层：旧药丸被彻底拔除（进入退药态 State 2）
  const oldFloorT2 = cleansedT2[1].content;
  assert.ok(oldFloorT2.includes(proseT), '旧楼层正文保留');
  assert.ok(!oldFloorT2.includes('【VCP 工具调用协议规范】'), '旧楼层药丸必须被彻底拔除，保证全历史单药收敛');

  // 验证 Turn T+2 新楼层：挂载同时包含新旧双重警示的新药丸
  const newFloorT2 = cleansedT2[3].content;
  assert.ok(newFloorT2.includes(proseT2), '新楼层正文保留');
  assert.ok(!newFloorT2.includes(badBlockT2), '新楼层坏块擦除');
  assert.ok(newFloorT2.includes('【VCP 工具调用协议规范】'), '新楼层挂载新药丸');
  assert.ok(newFloorT2.includes('tool_name'), '新药丸累加了缺失 tool_name 警示');
  assert.ok(newFloorT2.includes('严禁填写角色名') || newFloorT2.includes('工具名错位') || newFloorT2.includes('ROLE_IN_TOOL_NAME'), '新药丸累加了角色名错填入工具名警示');

  // 验证 Turn T 楼层在退药态下的哈希稳定性
  const sOld = TextSanitizer.sanitizeForEmbedding(ContextFoldingV2._sanitizeOneRingMarkers(oldFloorT2), 'assistant');
  const hOld = FoldingStore.hashContent(sOld);

  const sInitial = TextSanitizer.sanitizeForEmbedding(ContextFoldingV2._sanitizeOneRingMarkers(turnT_AssistantContent), 'assistant');
  const hInitial = FoldingStore.hashContent(sInitial);

  assert.equal(hOld, hInitial, 'Turn T 楼层在 State 0、State 1 与 State 2 下哈希必须 100% 保持绝对恒定');
});

// =========================================================================
// 维度 7：总开关 ENABLED=false 全链路平滑旁路与异常容灾
// =========================================================================

test('D7-1: ENABLE_TOOL_PROTOCOL_RESILIENCE=false 时全链路平滑旁路', () => {
  const oldEnv = process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
  process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = 'false';

  try {
    const rawBad = '正文\n<<<[TOOL_REQUEST]>>>\nmaid:「始」Nova「末」\n<<<[END_TOOL_REQUEST]>>>';
    const messages = [{ role: 'assistant', content: rawBad }];

    const cleansed = cleanseHistory(messages);
    assert.deepEqual(cleansed, messages, '开关关闭时 cleanseHistory 必须原样直通');

    const stripped = stripResilienceMarkers(rawBad);
    assert.equal(stripped, rawBad, '开关关闭时 stripResilienceMarkers 必须原样直通');
  } finally {
    if (oldEnv !== undefined) {
      process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = oldEnv;
    } else {
      delete process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
    }
  }
});

test('D7-2: 默认关闭（unset 与 false）时所有生态协同模块保持上游原语义，零副作用/零哈希偏移', async () => {
  const OneRingFuzzy = require('../Plugin/OneRing/OneRingFuzzy');
  const DirectDiaryTextProcessor = require('../Plugin/RAGDiaryPlugin/DirectDiaryTextProcessor');
  const TDBPlaceholderProcessor = require('../Plugin/RAGDiaryPlugin/TDBPlaceholderProcessor');
  const AgentAssistant = require('../Plugin/AgentAssistant/AgentAssistant');
  const AgentDream = require('../Plugin/AgentDream/AgentDream');
  const { scoreMessages } = require('../modules/jevContextPruner');

  const oldEnv = process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
  const oldAlias = process.env.VCP_PROTOCOL_RESILIENCE_ENABLED;
  const processor = new DirectDiaryTextProcessor({ log: () => {}, warn: () => {}, error: () => {} });
  const tdb = new TDBPlaceholderProcessor({});

  try {
    for (const mode of [undefined, 'false']) {
      if (mode === undefined) {
        delete process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
        delete process.env.VCP_PROTOCOL_RESILIENCE_ENABLED;
      } else {
        process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = mode;
        delete process.env.VCP_PROTOCOL_RESILIENCE_ENABLED;
      }

      // 1. OneRingFuzzy.normalize 关闭态不剥离 <think> 与角色分割工具回执块，保障存量 SQLite snapshot 哈希一致
      const oneRingSample = '<think>\n内部思考\n</think>\n正文<<<[ROLE_DIVIDE_USER]>>>[[VCP调用结果信息汇总:ok]]<<<[END_ROLE_DIVIDE_USER]>>>';
      const norm = OneRingFuzzy.normalize(oneRingSample);
      assert.ok(norm.includes('<think>'), 'mode=' + mode + ': OneRingFuzzy 关闭态不得剥离 <think>');
      assert.ok(norm.includes('ROLE_DIVIDE_USER'), 'mode=' + mode + ': OneRingFuzzy 关闭态不得剥离角色分割块');

      // 2. OneRingMemo.formatTimelineRows 关闭态原样直通
      const memoRows = [{ role: 'assistant', senderName: 'Nova', timestamp: '2026-11-26', content: '<think>\n思考\n</think>\n正文' }];
      const memoOut = OneRingMemo.formatTimelineRows(memoRows, 'Nova');
      assert.ok(memoOut.includes('<think>'), 'mode=' + mode + ': OneRingMemo 关闭态不得剥离 <think>');

      // 3. TextSanitizer.sanitizeForEmbedding 关闭态不剥离 <think>，且不启用模糊 << / {始} 扩展
      const embIn = '<think>\n思考\n</think>\n正文 {始}测试{末}';
      const embOut = TextSanitizer.sanitizeForEmbedding(embIn, 'assistant');
      assert.ok(embOut.includes('思考'), 'mode=' + mode + ': TextSanitizer 关闭态不得剥离思维链内容');
      assert.ok(embOut.includes('{始}测试{末}'), 'mode=' + mode + ': TextSanitizer 关闭态不得扩展剥离花括号定界符');

      // 4. DirectDiaryTextProcessor & TDBPlaceholderProcessor 关闭态不剥离 <think> 且不扩展剥离花括号定界符
      const bm25In = '<think>\n思考关键词\n</think>\n正文 {始}花括号内容{末}';
      const bm25Direct = processor.sanitizeUserInputForBM25(bm25In);
      const bm25Tdb = tdb._normalizeBM25QueryInput(bm25In);
      assert.ok(bm25Direct.includes('思考关键词'), 'mode=' + mode + ': DirectDiaryTextProcessor 关闭态不得剥离 <think>');
      assert.ok(bm25Direct.includes('{始}花括号内容{末}'), 'mode=' + mode + ': DirectDiaryTextProcessor 关闭态不得扩展剥离 {始}...{末}');
      assert.ok(bm25Tdb.includes('思考关键词'), 'mode=' + mode + ': TDBPlaceholderProcessor 关闭态不得剥离 <think>');
      assert.ok(bm25Tdb.includes('{始}花括号内容{末}'), 'mode=' + mode + ': TDBPlaceholderProcessor 关闭态不得扩展剥离 {始}...{末}');

      // 5. AgentAssistant & AgentDream 关闭态仅剥离原版 [--- VCP元思考链 ---]，不强行剥离未配置的 <think>
      const thinkSample = '<think>\n保留原样\n</think>\n[--- VCP元思考链:t ---]\n原版思考\n[--- 元思考链结束 ---]\n真实答复';
      const aaOut = AgentAssistant._removeVCPThinkingChain(thinkSample, 'unknown-model');
      const adOut = AgentDream._removeVCPThinkingChain(thinkSample);
      assert.ok(aaOut.includes('<think>'), 'mode=' + mode + ': AgentAssistant 关闭态不得强行剥离未配置的 <think>');
      assert.ok(!aaOut.includes('原版思考'), 'mode=' + mode + ': AgentAssistant 关闭态仍须剥离原版 VCP 元思考链');
      assert.ok(adOut.includes('<think>'), 'mode=' + mode + ': AgentDream 关闭态不得强行剥离 <think>');
      assert.ok(!adOut.includes('原版思考'), 'mode=' + mode + ': AgentDream 关闭态仍须剥离原版 VCP 元思考链');

      // 6. jevContextPruner.scoreMessages 关闭态不剥离 <think>
      const oldJevPrune = process.env.JevContextPrune;
      process.env.JevContextPrune = 'true';
      try {
        let capturedState = null;
        const fakeJev = {
          isConfigured: () => true,
          decide: async (state) => {
            capturedState = state;
            return { answers: { m_0: { answer: 'yes', confidence: 0.9 } } };
          }
        };
        await scoreMessages({
          client: fakeJev,
          messages: [{ role: 'assistant', content: '<think>\n剪枝思考\n</think>\n答复正文' }],
          indices: [0],
          currentRequest: '测试目标'
        });
        assert.ok(capturedState && capturedState.messages[0].text.includes('<think>'), 'mode=' + mode + ': jevContextPruner 关闭态不得剥离 <think>');
      } finally {
        if (oldJevPrune !== undefined) process.env.JevContextPrune = oldJevPrune;
        else delete process.env.JevContextPrune;
      }
    }
  } finally {
    if (oldEnv !== undefined) process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = oldEnv;
    else delete process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
    if (oldAlias !== undefined) process.env.VCP_PROTOCOL_RESILIENCE_ENABLED = oldAlias;
    else delete process.env.VCP_PROTOCOL_RESILIENCE_ENABLED;
  }
});

test('D7-3: 关闭态（unset 与 false）全模块零漏门控回归（#1~#8）', async () => {
  const http = require('node:http');
  const os = require('node:os');
  const AgentAssistant = require('../Plugin/AgentAssistant/AgentAssistant');
  const TDBPlaceholderProcessor = require('../Plugin/RAGDiaryPlugin/TDBPlaceholderProcessor');
  const VCPTimeLine = require('../Plugin/VCPTimeLine/VCPTimeLine');
  const pluginManager = require('../Plugin');
  const guidanceAssembler = require('../modules/vcpProtocolResilience/guidanceAssembler');

  // #8: FALLBACK_STATIC_PROMPT 与 VCP_STATIC_PILL_PROMPT.md 一致
  assert.ok(guidanceAssembler.FALLBACK_STATIC_PROMPT.includes('targettool:「始」CodeSearcher「末」'));
  assert.ok(!guidanceAssembler.FALLBACK_STATIC_PROMPT.includes('PTYShellExecutor'));

  const oldEnv = process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
  const oldAlias = process.env.VCP_PROTOCOL_RESILIENCE_ENABLED;
  const oldReasoningEnv = process.env.REASONING_TO_CONTENT_TAG;
  const oldApiUrl = process.env.API_URL;
  const oldApiKey = process.env.API_Key;

  // Ephemeral mock OpenAI server to inspect systemPrompt & _generateSummary payloads
  const capturedBodies = [];
  let serverResponseText = '[VCP上下文语义折叠-本层摘要: 测试摘要]';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try {
        capturedBodies.push(JSON.parse(raw));
      } catch (_) {
        capturedBodies.push(raw);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: serverResponseText } }]
      }));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const oldTimelineRuntime = { ...VCPTimeLine.runtimeConfig };
  const oldTimelineModel = VCPTimeLine.config.model;
  const oldPreOrder = [...pluginManager.preprocessorOrder];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-d73-'));
  const oldOrderFile = path.join(tempDir, 'old_preprocessor_order.json');
  const existingOrderFile = path.join(tempDir, 'with_cleanse_order.json');
  fs.writeFileSync(oldOrderFile, JSON.stringify(['OneRing', 'ContextFoldingV2']), 'utf8');
  fs.writeFileSync(existingOrderFile, JSON.stringify(['$StaticPlaceholderInjection', 'OneRing', '$ToolProtocolHistoryCleanse', 'ContextFoldingV2']), 'utf8');

  try {
    VCPTimeLine.runtimeConfig = { PORT: port, Key: 'test-key' };
    VCPTimeLine.config.model = 'test-model';
    OneRingMemo.configure({ runtimeConfig: { PORT: port, Key: 'test-key' } });
    process.env.API_URL = `http://127.0.0.1:${port}`;
    process.env.API_Key = 'test-key';

    const tdb = new TDBPlaceholderProcessor({});

    for (const mode of [undefined, 'false']) {
      if (mode === undefined) {
        delete process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
        delete process.env.VCP_PROTOCOL_RESILIENCE_ENABLED;
      } else {
        process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = mode;
        delete process.env.VCP_PROTOCOL_RESILIENCE_ENABLED;
      }

      // #1a: AgentAssistant.initialize 在关闭态走严格白名单，绝不把未校验环境变量喂进 new RegExp
      process.env.REASONING_TO_CONTENT_TAG = '[broken(regex';
      AgentAssistant.initialize({
        PORT: port,
        Key: 'test-key',
        ReasoningToContentEnabled: 'true',
        ReasoningToContentModel: 'test-model'
      }, {});
      const aaStripped = AgentAssistant._removeVCPThinkingChain(
        '<think>hidden</think>\n<[broken(regex>keep</[broken(regex>\nvisible',
        'test-model'
      );
      assert.ok(!aaStripped.includes('hidden'), `mode=${mode}: 白名单 <think> 应被剥离`);
      assert.ok(aaStripped.includes('<[broken(regex>keep'), `mode=${mode}: 未校验环境变量不得生效或崩溃`);

      // #1b: AgentAssistant.executeDelegation 关闭态空回复不插入自定义占位文案
      assert.equal(AgentAssistant._buildDelegationHistoryContent(''), '', `mode=${mode}: 关闭态空回复保持原样`);

      // #2: RAGDiaryPlugin._extractContextDiaryPrefixes 关闭态严格等价 upstream/main
      const prefixes = RAGDiaryPlugin._extractContextDiaryPrefixes([
        {
          role: 'assistant',
          content: '<<<[TOOL_REQUEST]>>>\ntool_name:「始」DailyNote「末」,Content:「始」正常上游日记内容第一条「末」<<<[END_TOOL_REQUEST]>>>'
        },
        {
          role: 'assistant',
          content: '<<<[tool_request]>>>\ntool_name:「始」DailyNote「末」,Content:「始」小写标签在关闭态不提取「末」<<<[end_tool_request]>>>'
        },
        {
          role: 'assistant',
          content: '<<<[TOOL_REQUEST]>>>\ntool_name:「始」DailyNote「末」,Content:{始}花括号在关闭态不提取{末}<<<[END_TOOL_REQUEST]>>>'
        }
      ]);
      assert.ok(prefixes.has('正常上游日记内容第一条'), `mode=${mode}: 正常上游格式必须提取`);
      assert.ok(!prefixes.has('小写标签在关闭态不提取'), `mode=${mode}: 关闭态不得提取小写 tool_request`);
      assert.ok(!prefixes.has('花括号在关闭态不提取'), `mode=${mode}: 关闭态不得提取花括号定界符`);

      // #3: OneRingMemo.callSummaryModel 关闭态原样传 systemPrompt，不注入 [[VCPToolUse=Forbidden]]
      capturedBodies.length = 0;
      serverResponseText = '摘要文本 [[VCP协议纠偏指导: code=X]]';
      const memoOut = await OneRingMemo._callSummaryModel('test-model', 'ORIG_MEMO_SYS', 'USER_IN', { maxOutputTokens: 200 });
      assert.equal(capturedBodies[0].messages[0].content, 'ORIG_MEMO_SYS', `mode=${mode}: OneRingMemo 关闭态不得拼接 Forbidden`);
      assert.ok(memoOut.includes('[[VCP协议纠偏指导:'), `mode=${mode}: OneRingMemo 关闭态不得剥离响应`);

      // #4: VCPTimeLine.callModel 关闭态原样传 systemPrompt 且不剥离输出
      capturedBodies.length = 0;
      serverResponseText = '时间线文本 [[VCP协议纠偏指导: code=Y]]';
      const tlOut = await VCPTimeLine.callModel('ORIG_TL_SYS', 'TL_USER_IN', 200);
      assert.equal(capturedBodies[0].messages[0].content, 'ORIG_TL_SYS', `mode=${mode}: VCPTimeLine 关闭态不得拼接 Forbidden`);
      assert.ok(tlOut.includes('[[VCP协议纠偏指导:'), `mode=${mode}: VCPTimeLine 关闭态不得剥离响应`);

      // #5a: ContextFoldingV2._sanitizeOneRingMarkers 关闭态使用上游 ORIG_ONERING_TAIL_REGEX，哈希零漂移
      const foldSample = '正文\n[OneRing通知:2026-11-26 12:00:00 @web]';
      const foldSanitized = ContextFoldingV2._sanitizeOneRingMarkers(foldSample);
      assert.equal(foldSanitized, '正文', `mode=${mode}: 关闭态单条尾标正常剥离`);
      assert.equal(
        FoldingStore.hashContent(foldSanitized),
        FoldingStore.hashContent('正文'),
        `mode=${mode}: 关闭态 FoldingStore 哈希 100% 不漂移`
      );
      const foldWithMarker = '正文 [[VCP协议纠偏指导: code=Z]]\n[OneRing通知:2026-11-26 12:00:00 @web]';
      assert.ok(
        ContextFoldingV2._sanitizeOneRingMarkers(foldWithMarker).includes('[[VCP协议纠偏指导:'),
        `mode=${mode}: 关闭态不得调用 stripResilienceMarkers`
      );

      // #5b: ContextFoldingV2._generateSummary 关闭态不清洗 OneRing/纠偏标记，原样传给摘要模型
      capturedBodies.length = 0;
      serverResponseText = '[VCP上下文语义折叠-本层摘要: 原样摘要]';
      await ContextFoldingV2._generateSummary(foldSample);
      assert.ok(
        capturedBodies[0].messages[1].content.includes('[OneRing通知:2026-11-26 12:00:00 @web]'),
        `mode=${mode}: _generateSummary 关闭态不得剥离 OneRing 尾标`
      );

      // #6: TDBPlaceholderProcessor._normalizeBM25QueryInput 关闭态精确还原上游两条正则
      const bm25Raw = '前 <<<[TOOL_REQUEST_ESCAPE]>>>a:「始ESCAPE」保留ESCAPE「末ESCAPE」<<<[END_TOOL_REQUEST_ESCAPE]>>> <<<[TOOL_REQUEST]>>>x:「始」剔除原版「末」<<<[END_TOOL_REQUEST]>>> 后';
      const bm25Out = tdb._normalizeBM25QueryInput(bm25Raw);
      assert.ok(!bm25Out.includes('剔除原版'), `mode=${mode}: 关闭态应剔除原版 <<<[TOOL_REQUEST]>>> 与 「始」...「末」`);
      assert.ok(bm25Out.includes('保留ESCAPE'), `mode=${mode}: 关闭态不得混入 ESCAPE 正则`);

      // #7: Plugin.js 关闭态加载默认或老用户 preprocessor_order.json 均不得把 $ToolProtocolHistoryCleanse 写入 finalOrder 或 getPreprocessorOrder()
      const discovered = new Map([['OneRing', {}], ['ContextFoldingV2', {}]]);
      const resolvedOld = await pluginManager._resolvePreprocessorOrder(discovered, oldOrderFile);
      assert.ok(
        !resolvedOld.includes('$ToolProtocolHistoryCleanse'),
        `mode=${mode}: 关闭态加载老用户列表不得自动塞入 $ToolProtocolHistoryCleanse`
      );
      const resolvedExisting = await pluginManager._resolvePreprocessorOrder(discovered, existingOrderFile);
      assert.ok(
        !resolvedExisting.includes('$ToolProtocolHistoryCleanse'),
        `mode=${mode}: 关闭态加载含预置项的列表必须宽容跳过且不得放入 finalOrder`
      );
      const resolvedDefault = await pluginManager._resolvePreprocessorOrder(discovered);
      assert.ok(
        !resolvedDefault.includes('$ToolProtocolHistoryCleanse'),
        `mode=${mode}: 关闭态加载默认 preprocessor_order.json 不得包含 $ToolProtocolHistoryCleanse`
      );
      pluginManager.preprocessorOrder = ['$StaticPlaceholderInjection', 'OneRing', '$ToolProtocolHistoryCleanse', 'ContextFoldingV2'];
      assert.ok(
        !pluginManager.getPreprocessorOrder().some(item => item.name === '$ToolProtocolHistoryCleanse'),
        `mode=${mode}: 关闭态 getPreprocessorOrder 不得暴露 $ToolProtocolHistoryCleanse`
      );

      // #9: TextSanitizer.stripToolMarkers 关闭态与 upstream/main 100% 字节语义一致
      assert.equal(TextSanitizer.stripToolMarkers('「你好」'), '你好', `mode=${mode}: 关闭态须剥离中文引号`);
      assert.equal(
        TextSanitizer.stripToolMarkers('<<<[TOOL_REQUEST]>>>\nContent:「始」a「末」\nDetail:「始」正常正文「末」\n<<<[END_TOOL_REQUEST]>>>'),
        '正常正文',
        `mode=${mode}: 关闭态单字符参数 a (length<=1) 须遵循上游原版过滤规则`
      );
      assert.equal(
        TextSanitizer.stripToolMarkers('<<<[TOOL_REQUEST]>>>\nTag:「始」update_log「末」\n<<<[END_TOOL_REQUEST]>>>'),
        '',
        `mode=${mode}: 关闭态黑名单子串 includes('update') 须遵循上游原版过滤规则`
      );
    }

    // 验证开启态行为（#3, #4, #5, #7）
    process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = 'true';
    capturedBodies.length = 0;
    serverResponseText = '正文 [[VCP协议纠偏指导: code=X]]';
    await OneRingMemo._callSummaryModel('test-model', 'ORIG_MEMO_SYS', 'USER_IN', { maxOutputTokens: 200 });
    assert.ok(capturedBodies[0].messages[0].content.startsWith('[[VCPToolUse=Forbidden]]\n'));

    capturedBodies.length = 0;
    await VCPTimeLine.callModel('ORIG_TL_SYS', 'TL_USER_IN', 200);
    assert.ok(capturedBodies[0].messages[0].content.startsWith('[[VCPToolUse=Forbidden]]\n'));

    const discoveredOn = new Map([['OneRing', {}], ['ContextFoldingV2', {}]]);
    const resolvedOn = await pluginManager._resolvePreprocessorOrder(discoveredOn, oldOrderFile);
    assert.ok(resolvedOn.includes('$ToolProtocolHistoryCleanse'), '开启态必须自动补位注册 $ToolProtocolHistoryCleanse');
    assert.equal(AgentAssistant._buildDelegationHistoryContent(''), '[AgentAssistant] 目标 Agent 本轮未输出有效正文。');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
    VCPTimeLine.runtimeConfig = oldTimelineRuntime;
    VCPTimeLine.config.model = oldTimelineModel;
    pluginManager.preprocessorOrder = oldPreOrder;
    if (oldEnv !== undefined) process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = oldEnv;
    else delete process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
    if (oldAlias !== undefined) process.env.VCP_PROTOCOL_RESILIENCE_ENABLED = oldAlias;
    else delete process.env.VCP_PROTOCOL_RESILIENCE_ENABLED;
    if (oldReasoningEnv !== undefined) process.env.REASONING_TO_CONTENT_TAG = oldReasoningEnv;
    else delete process.env.REASONING_TO_CONTENT_TAG;
    if (oldApiUrl !== undefined) process.env.API_URL = oldApiUrl;
    else delete process.env.API_URL;
    if (oldApiKey !== undefined) process.env.API_Key = oldApiKey;
    else delete process.env.API_Key;
  }
});

test.after(() => {
  try {
    const pluginManager = require('../Plugin');
    pluginManager.toolApprovalManager?.shutdown();
  } catch (_) {}
});
