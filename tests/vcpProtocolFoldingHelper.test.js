'use strict';

if (process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE === undefined) {
  process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = 'true';
}

/**
 * tests/vcpProtocolFoldingHelper.test.js
 * 
 * Batch 5: 04_细则 折叠保留与向量净化模块专项与对抗测试套件
 * 
 * 覆盖矩阵：
 * - F1: 三态逐字节恒等与零 1 字节哈希抖动（纯错误批次）
 * - F2: 三态逐字节恒等与零 1 字节哈希抖动（混合批次）
 * - F3: 全错无散文楼层占位符统一剥离与零向量污染
 * - F4: P6 失败安全兜底剥离（指纹失配 / 孤立凭条防提示词示例泄漏）
 * - F5: 顶层药丸识别与 [[VCP调用结果信息汇总:...]] 嵌套自指防投毒
 * - F6: 混合批次折叠严禁夹带同批 50KB 业务工具大日志
 * - F7: 残缺药丸界定符的 P6 失败安全（跳过不折叠，原样直通）
 * - F8: 多模态 content 数组、cache_control 与 Reflect.ownKeys 元数据无损继承
 * - F9: 与 modules/roleDivider.js 真实端到端切分联动验证
 * - F10: 全半角/变体正则兼容与总开关 isResilienceEnabled=false 安全直通
 * - F11: 【BUG-01】findVcpInfoRanges 行首换行/空格边界校验与代码字面量防自指投毒
 * - F12: 【BUG-02】stripResilienceMarkers 坚决保护 ReadFile 等正常工具返回文档与散文中的协议规范
 * - F13: 【BUG-03】foldWithPillIfPresent 多模态非首分片 cache_control 无损继承
 * - F14: 【BUG-04】stripResilienceMarkers 彻底清除 P6 兜底后的掏空错误块与空批次外壳
 * - F15: 【BUG-05】extractTopLevelPillEnvelope 2开1闭等多开少闭截断场景 P6 失败安全
 * - F16: 【BUG-06】全角标点前缀【系统提示：】兼容与 CRLF 换行收敛
 * - F17: 【BUG-07】index.js 统一门控 isResilienceEnabled(options) 与 options.enabled 透传
 * - F18: 【BUG-08】foldWithPillIfPresent 顶层对象分支优先判定与免重复推演
 * - F19: 【BUG-R2-01】TextSanitizer.sanitizeForEmbedding 与 stripResilienceMarkers 真实打通与向量净化
 * - F20: 【BUG-R2-02】findVcpInfoRanges 行首边界校验与未闭合坏块严禁拉伸至 text.length
 * - F21: 【BUG-R2-03】extractTopLevelPillEnvelope isOverlappingInfo 双端区间重叠判断杜绝 50KB 业务大日志打包成药丸
 * - F22: 【BUG-R2-04】真实生产摘要格式兼容（空摘要外壳清除与具体插件名错误项剔除）
 * - F23: 【BUG-R2-05】EMPTY_ERROR_INFO_REGEX 通用元数据属性键值匹配与空错误块剥离
 * - F24: 【BUG-R2-06】extractTopLevelPillEnvelope 事件栈/位置序判定（先闭后开倒置残缺与孤立闭标触发 P6 失败安全）
 * - F25: 【BUG-R2-07】modules/vcpProtocolResilience/index.js 统一门控包装器导出顺序防覆盖验证
 * - F26: 【BUG-R2-08】stripResilienceMarkers 顶层消息对象 { role, content } 解包与重装支持
 * - F27: 【BUG-R3-01】紧凑单换行（\n）排版下状态 0 vs 状态 1 vs 状态 2 在真实 TextSanitizer 下三态逐字节恒等与 SHA-256 零抖动
 * - F28: 【BUG-R3-02】options.enabled = false 时 foldWithPillIfPresent 保持消息对象与多模态数组容器类型绝对不变
 * - F29: 【BUG-R3-03】自嵌套药丸（2开2闭内嵌）精准拦截为残损并触发 P6 失败安全跳过折叠
 * - F30: 【BUG-R4-01】foldWithPillIfPresent 容灾测试（foldFn 返回 undefined、null 时不抛异常且正常拼接药丸）
 * - F31: 【BUG-R4-02】消息对象 content === '' 空文本结构保持测试
 * - F32: 【BUG-R4-03】extractTopLevelPillEnvelope 多外壳时序对抗（Valid 在前、Malformed 在后，100% 触发 P6 失败安全 shouldSkipFolding: true）
 * - F33: 【BUG-R4-04】ROLE_DIVIDE_USER 自身截断未闭合且含药丸开标时触发 P6 失败安全 shouldSkipFolding: true
 * - F34: 【BUG-R5-01】倒置闭标前置时未闭合外壳截断校验依然触发 P6 失败安全（shouldSkipFolding: true）
 * - F35: 【BUG-R5-02】未闭合外壳内包含残损闭标时触发 P6 失败安全
 * - F36: 【BUG-R5-03】EMPTY_BATCH_ENVELOPE_REGEX 与 EMPTY_ROLE_DIVIDE_REGEX 单换行对称性与 TextSanitizer SHA-256 零分裂
 * - F37: 【BUG-R5-04】全角中括号 ［...］ 药丸识别、剥离与 P6 失败安全全覆盖
 * - F38: 【BUG-R6-01】前置未闭合外壳吞噬校验与 P6 失败安全（防业务内容折叠抹除）
 * - F39: 【BUG-R6-02】含药外壳未闭合且后随封闭外壳时 100% 触发 P6 失败安全
 * - F40: 【BUG-R6-03】多模态数组后置图片分片时与 roleDivider.process 端到端切分严格保持 2 条消息契约 [assistant, user]
 * - F41: 【BUG-R7-01】正常工具输出包含协议规范文档时防误报、防篡改与三态逐字节恒等
 * - F42: 【BUG-R7-02】EMPTY_ERROR_INFO_REGEX 多空行容错与掏空错误块彻底剥离
 * - F43: 【BUG-R7-03】foldWithPillIfPresent 回调异常捕获与 P6 失败安全
 * - F44: 【BUG-R7-02-B】EMPTY_ERROR_INFO_REGEX 严禁误伤单行真实业务工具报错
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const resilienceModule = require('../modules/vcpProtocolResilience');
const {
  stripResilienceMarkers,
  isProtocolGuidancePill,
  extractTopLevelPillEnvelope,
  foldWithPillIfPresent,
  cleanseHistory,
  stripErrorBlocksAndReceiptsFromText,
  extractHistoricalErrorBlocks,
  isResilienceEnabled,
  hasSystemPillInText
} = resilienceModule;

const guidanceAssembler = require('../modules/vcpProtocolResilience/guidanceAssembler');
const roleDivider = require('../modules/roleDivider');

/**
 * 辅助构建带指纹的错误块与回执测试夹具
 */
function createErrorFixture(badBlockText, code = 'MISSING_TOOL_NAME', options = {}) {
  const errMap = extractHistoricalErrorBlocks(badBlockText, {
    protectRoleDivider: true,
    isHistoryExtraction: true,
    includeClosedBlockCandidates: true,
    finishReason: 'stop',
    sawDone: true
  });
  const fps = Array.from(errMap.keys());
  const fp = fps[0] || '3fa9c2e1';

  const timestamp = options.timestamp || '2026-11-22T04:00:00.000+08:00';
  const toolName = options.toolName || 'VCP工具调用';
  const summaryLine = options.summaryLine || `${toolName} 格式错误（未执行）。`;

  const receipt = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    `<<<[VCP_TOOL_BATCH_START:${timestamp}]>>>`,
    '[[VCP调用结果信息汇总:',
    `- 工具名称: ${toolName}`,
    '- 执行状态: ❌ ERROR',
    `- 返回内容: [[VCP协议纠偏指导: code=${code} block=${fp}]]`,
    '请修正参数并重试！',
    '[[/VCP协议纠偏指导]]',
    'VCP调用结果结束]]',
    '<<<[VCP_TOOL_BATCH_SUMMARY]>>>',
    `- ${summaryLine}`,
    '<<<[END_VCP_TOOL_BATCH_SUMMARY]>>>',
    `<<<[VCP_TOOL_BATCH_END:${timestamp}]>>>`,
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  return { fp, receipt, code, timestamp, toolName };
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// =========================================================================
// F1: 三态逐字节恒等与零 1 字节哈希抖动（纯错误批次）
// =========================================================================

test('F1: 三态逐字节恒等与零 1 字节哈希抖动（纯错误批次）', () => {
  const badBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const fix = createErrorFixture(badBlock, 'MISSING_TOOL_NAME');

  const baseline = 'Prose before\n\nProse after';
  const state0 = 'Prose before\n\n' + badBlock + '\n' + fix.receipt + '\n\nProse after';

  // 状态 1：活药态（经过 cleanseHistory 清洗变药）
  const msgs1 = [
    { role: 'user', content: 'Turn 1 User' },
    { role: 'assistant', content: state0 },
    { role: 'user', content: 'Turn 2 User Active' }
  ];
  const state1 = cleanseHistory(msgs1)[1].content;
  assert.ok(state1.includes('【VCP 工具调用协议规范】'), '状态 1 挂载了活药');

  // 状态 2：退药态（后续轮次发生新错误，当前楼层药丸被彻底拔除）
  const badBlock2 = '<<<[TOOL_REQUEST]>>>\nmaid:「始」Nova2「末」\n<<<[END_TOOL_REQUEST]>>>';
  const fix2 = createErrorFixture(badBlock2, 'MISSING_TOOL_NAME', { timestamp: '2026-11-22T04:05:00.000+08:00' });
  const msgs2 = [
    { role: 'user', content: 'Turn 1 User' },
    { role: 'assistant', content: state0 },
    { role: 'user', content: 'Turn 2 User' },
    { role: 'assistant', content: 'Prose 2\n' + badBlock2 + '\n' + fix2.receipt },
    { role: 'user', content: 'Turn 3 User Active' }
  ];
  const state2 = cleanseHistory(msgs2)[1].content;
  assert.ok(!state2.includes('【VCP 工具调用协议规范】'), '状态 2 旧药已被拔除');

  // 核心断言：状态 0、状态 1、状态 2 经 stripResilienceMarkers 后必须 100% 逐字节恒等！
  const stripped0 = stripResilienceMarkers(state0);
  const stripped1 = stripResilienceMarkers(state1);
  const stripped2 = stripResilienceMarkers(state2);

  assert.equal(stripped0, baseline, '状态 0 净化后与基准态逐字节恒等');
  assert.equal(stripped1, baseline, '状态 1 净化后与基准态逐字节恒等');
  assert.equal(stripped2, baseline, '状态 2 净化后与基准态逐字节恒等');

  // SHA-256 绝对一致
  assert.equal(sha256(stripped0), sha256(stripped1), '状态 0 与状态 1 SHA-256 绝对一致');
  assert.equal(sha256(stripped1), sha256(stripped2), '状态 1 与状态 2 SHA-256 绝对一致');
});

// =========================================================================
// F2: 三态逐字节恒等与零 1 字节哈希抖动（混合批次）
// =========================================================================

test('F2: 三态逐字节恒等与零 1 字节哈希抖动（混合批次：BadTool 报错 + GoodTool 成功）', () => {
  const badBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const fix = createErrorFixture(badBlock, 'MISSING_TOOL_NAME');

  const mixedBatchReceipt = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '<<<[VCP_TOOL_BATCH_START:2026-11-22T04:00:00.000+08:00]>>>',
    '[[VCP调用结果信息汇总:',
    '- 工具名称: BadTool',
    '- 执行状态: ❌ ERROR',
    `- 返回内容: [[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=${fix.fp}]]`,
    '请修正参数并重试！',
    '[[/VCP协议纠偏指导]]',
    'VCP调用结果结束]]',
    '[[VCP调用结果信息汇总:',
    '- 工具名称: GoodTool',
    '- 执行状态: ✅ SUCCESS',
    '- 返回内容: File content from good tool',
    'VCP调用结果结束]]',
    '<<<[VCP_TOOL_BATCH_SUMMARY]>>>',
    '- BadTool 格式错误（未执行）。',
    '- GoodTool 执行成功。',
    '<<<[END_VCP_TOOL_BATCH_SUMMARY]>>>',
    '<<<[VCP_TOOL_BATCH_END:2026-11-22T04:00:00.000+08:00]>>>',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  const state0 = 'Prose before\n\n' + badBlock + '\n' + mixedBatchReceipt + '\n\nProse after';

  // 状态 1：活药态
  const msgs1 = [
    { role: 'user', content: 'Turn 1 User' },
    { role: 'assistant', content: state0 },
    { role: 'user', content: 'Turn 2 User Active' }
  ];
  const state1 = cleanseHistory(msgs1)[1].content;
  assert.ok(state1.includes('【VCP 工具调用协议规范】'), '状态 1 挂载了活药');

  // 状态 2：退药态
  const badBlock2 = '<<<[TOOL_REQUEST]>>>\nmaid:「始」Nova2「末」\n<<<[END_TOOL_REQUEST]>>>';
  const fix2 = createErrorFixture(badBlock2, 'MISSING_TOOL_NAME', { timestamp: '2026-11-22T04:05:00.000+08:00' });
  const msgs2 = [
    { role: 'user', content: 'Turn 1 User' },
    { role: 'assistant', content: state0 },
    { role: 'user', content: 'Turn 2 User' },
    { role: 'assistant', content: 'Prose 2\n' + badBlock2 + '\n' + fix2.receipt },
    { role: 'user', content: 'Turn 3 User Active' }
  ];
  const state2 = cleanseHistory(msgs2)[1].content;
  assert.ok(!state2.includes('【VCP 工具调用协议规范】'), '状态 2 旧药被拔除');

  const stripped0 = stripResilienceMarkers(state0);
  const stripped1 = stripResilienceMarkers(state1);
  const stripped2 = stripResilienceMarkers(state2);

  assert.equal(stripped0, stripped2, '状态 0 与状态 2 逐字节恒等');
  assert.equal(stripped1, stripped2, '状态 1 与状态 2 逐字节恒等（零 1 字节换行抖动）');
  assert.equal(sha256(stripped0), sha256(stripped1), '混合批次三态 SHA-256 绝对一致');

  // 验证 GoodTool 成功输出完整保留且格式完整
  assert.ok(stripped1.includes('File content from good tool'), 'GoodTool 成功输出完整保留');
  assert.ok(stripped1.includes('<<<[VCP_TOOL_BATCH_START:2026-11-22T04:00:00.000+08:00]>>>'), '批次起标保留');
  assert.ok(stripped1.includes('<<<[VCP_TOOL_BATCH_END:2026-11-22T04:00:00.000+08:00]>>>'), '批次终标保留');
});

// =========================================================================
// F3: 全错无散文楼层占位符统一剥离与零向量污染
// =========================================================================

test('F3: 全错无散文楼层占位符统一剥离与零向量污染', () => {
  const badBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const fix = createErrorFixture(badBlock, 'MISSING_TOOL_NAME');

  const state0 = badBlock + '\n' + fix.receipt;

  const msgs1 = [
    { role: 'user', content: 'User 1' },
    { role: 'assistant', content: state0 },
    { role: 'user', content: 'User 2 Active' }
  ];
  const state1 = cleanseHistory(msgs1)[1].content;
  assert.ok(state1.includes('(上轮未执行的异常工具调用已略去)'), '状态 1 填入当前置空占位符');

  const msgs2 = [
    { role: 'user', content: 'User 1' },
    { role: 'assistant', content: state0 },
    { role: 'user', content: 'User 2' },
    { role: 'assistant', content: 'Prose 2\n' + badBlock + '\n' + fix.receipt },
    { role: 'user', content: 'User 3 Active' }
  ];
  const state2 = cleanseHistory(msgs2)[1].content;
  assert.ok(state2.includes('(上轮未执行的异常工具调用已略去)'), '状态 2 填入当前置空占位符');

  // 历史占位符形态测试
  const historicalLegacy = '[工具调用纠偏已归档]\n\n<<<[ROLE_DIVIDE_USER]>>>\n[系统提示:] 【VCP 工具调用协议规范】...\n【/VCP 工具调用协议规范】\n<<<[END_ROLE_DIVIDE_USER]>>>';

  const stripped0 = stripResilienceMarkers(state0);
  const stripped1 = stripResilienceMarkers(state1);
  const stripped2 = stripResilienceMarkers(state2);
  const strippedLegacy = stripResilienceMarkers(historicalLegacy);

  assert.equal(stripped0, '', '状态 0 净化后为空字符串');
  assert.equal(stripped1, '', '状态 1 净化后为空字符串');
  assert.equal(stripped2, '', '状态 2 净化后为空字符串');
  assert.equal(strippedLegacy, '', '历史占位符净化后为空字符串');
});

// =========================================================================
// F4: P6 失败安全兜底剥离（指纹失配 / 孤立凭条防提示词示例泄漏）
// =========================================================================

test('F4: P6 失败安全兜底剥离（指纹失配 / 孤立凭条防提示词示例泄漏）', () => {
  // 构造孤立纠偏凭条（指纹为 deadbeef，正文中无对应坏块）
  const orphanReceipt = [
    'Some user assistance prose before.',
    '[[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=deadbeef]]',
    '请规范填写参数：',
    '```vcp',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」你的署名「末」,',
    'tool_name:「始」<目标工具名>「末」',
    '<<<[END_TOOL_REQUEST]>>>',
    '```',
    '[[/VCP协议纠偏指导]]',
    'Some user assistance prose after.'
  ].join('\n');

  const stripped = stripResilienceMarkers(orphanReceipt);

  // 1. 纠偏指导及其内部的示例代码必须被彻底剥除
  assert.ok(!stripped.includes('[[VCP协议纠偏指导:'), '纠偏指导开标已剥离');
  assert.ok(!stripped.includes('[[/VCP协议纠偏指导]]'), '纠偏指导闭标已剥离');
  assert.ok(!stripped.includes('<目标工具名>'), '静态示例占位符绝不泄漏给向量库');
  assert.ok(!stripped.includes('<<<[TOOL_REQUEST]>>>'), '示例工具请求块绝不泄漏');

  // 2. 正常散文必须完整保留
  assert.ok(stripped.includes('Some user assistance prose before.'), '前置散文保留');
  assert.ok(stripped.includes('Some user assistance prose after.'), '后置散文保留');
});

// =========================================================================
// F5: 顶层药丸识别与 [[VCP调用结果信息汇总:...]] 嵌套自指防投毒
// =========================================================================

test('F5: 顶层药丸识别与 [[VCP调用结果信息汇总:...]] 嵌套自指防投毒', () => {
  const mockPill = guidanceAssembler.assembleHistoricalPill({ historicalErrors: [] });

  // 场景 1：AI 执行 SourceReader 查阅系统文档，文档内容包含规范药丸字面量
  const toolResultReadingDoc = [
    '我为您查阅了 VCP 规范文档：',
    '<<<[ROLE_DIVIDE_USER]>>>',
    '<<<[VCP_TOOL_BATCH_START:2026-11-22T04:00:00.000+08:00]>>>',
    '[[VCP调用结果信息汇总:',
    '- 工具名称: SourceReader',
    '- 执行状态: ✅ SUCCESS',
    `- 返回内容: 文档正文如下：\n${mockPill}\n以上为规范全文。`,
    'VCP调用结果结束]]',
    '<<<[VCP_TOOL_BATCH_END:2026-11-22T04:00:00.000+08:00]>>>',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  // 自指防御断言：嵌套在 VCP调用结果信息汇总 内的内容绝不被判定为系统药丸！
  assert.equal(isProtocolGuidancePill(toolResultReadingDoc), false, '读文档中的药丸字面量绝不被误判为系统药丸');
  const extractedDoc = extractTopLevelPillEnvelope(toolResultReadingDoc);
  assert.equal(extractedDoc.hasPill, false, 'extractTopLevelPillEnvelope 未命中药丸');

  // 折叠时正常执行普通折叠，绝不把文档内容当作系统药丸抽出来拼在摘要后面
  const foldedDoc = foldWithPillIfPresent(toolResultReadingDoc, '已完成文档查阅。');
  assert.equal(foldedDoc, '已完成文档查阅。', '普通折叠纯净输出');

  // 场景 2：真正位于顶层的系统药丸
  const realPillContent = [
    'Prose content',
    '<<<[ROLE_DIVIDE_USER]>>>',
    mockPill,
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  assert.equal(isProtocolGuidancePill(realPillContent), true, '顶层药丸成功识别');
  const extractedReal = extractTopLevelPillEnvelope(realPillContent);
  assert.equal(extractedReal.hasPill, true, '成功提取顶层药丸');
  assert.ok(extractedReal.pillText.includes('【VCP 工具调用协议规范】'), '药丸内容完整');
});

// =========================================================================
// F6: 混合批次折叠严禁夹带同批 50KB 业务工具大日志
// =========================================================================

test('F6: 混合批次折叠严禁夹带同批 50KB 业务工具大日志', () => {
  const mockPill = guidanceAssembler.assembleHistoricalPill({ historicalErrors: [] });
  const hugeBusinessLog = 'A'.repeat(50000); // 50KB 业务大日志

  // 混合批次楼层：成功工具输出 50KB 日志 + 末尾挂载系统活药
  const mixedFloorContent = [
    '我为您执行了日志拉取任务：',
    '<<<[ROLE_DIVIDE_USER]>>>',
    '<<<[VCP_TOOL_BATCH_START:2026-11-22T04:00:00.000+08:00]>>>',
    '[[VCP调用结果信息汇总:',
    '- 工具名称: LogFetcher',
    '- 执行状态: ✅ SUCCESS',
    `- 返回内容: ${hugeBusinessLog}`,
    'VCP调用结果结束]]',
    '<<<[VCP_TOOL_BATCH_SUMMARY]>>>',
    '- LogFetcher 执行成功。',
    '<<<[END_VCP_TOOL_BATCH_SUMMARY]>>>',
    '',
    mockPill,
    '<<<[VCP_TOOL_BATCH_END:2026-11-22T04:00:00.000+08:00]>>>',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  // 验证药丸检测
  assert.equal(isProtocolGuidancePill(mixedFloorContent), true, '混合批次顶层药丸被成功识别');

  const summaryText = '[VCP上下文语义折叠-本层摘要: 助手成功获取了 50KB 服务运行日志。]';
  const folded = foldWithPillIfPresent(mixedFloorContent, summaryText);

  // 核心雷区 4 验证：
  // 1. 摘要必须完整保留
  assert.ok(folded.startsWith(summaryText), '摘要位于最前');

  // 2. 50KB 业务大日志必须被彻底丢弃！
  assert.ok(!folded.includes(hugeBusinessLog), '50KB 业务大日志被彻底丢弃，严禁带出！');
  assert.ok(!folded.includes('LogFetcher'), '工具结果汇总块被丢弃');
  assert.ok(!folded.includes('<<<[VCP_TOOL_BATCH_START:'), '批次起标被丢弃');
  assert.ok(!folded.includes('<<<[VCP_TOOL_BATCH_END:'), '批次终标被丢弃');

  // 3. 药丸必须被单独、纯净地包裹在 <<<[ROLE_DIVIDE_USER]>>> 中
  assert.ok(folded.includes('<<<[ROLE_DIVIDE_USER]>>>\n[系统提示:] 【VCP 工具调用协议规范】'), '药丸独立纯净包裹');
  assert.ok(folded.includes('【/VCP 工具调用协议规范】\n<<<[END_ROLE_DIVIDE_USER]>>>'), '药丸外壳严格闭合');
});

// =========================================================================
// F7: 残缺药丸界定符的 P6 失败安全（跳过不折叠，原样直通）
// =========================================================================

test('F7: 残缺药丸界定符的 P6 失败安全（跳过不折叠，原样直通）', () => {
  // 构造残缺药丸（有开标签，但无闭合尾标，如被外部截断）
  const malformedPillContent = [
    'Prose explanation',
    '<<<[ROLE_DIVIDE_USER]>>>',
    '[系统提示:] 【VCP 工具调用协议规范】',
    '这是一段因故中断的半截残缺药丸……',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  // 1. extractTopLevelPillEnvelope 必须捕获残缺并标记 shouldSkipFolding
  const extracted = extractTopLevelPillEnvelope(malformedPillContent);
  assert.equal(extracted.hasPill, false, '残缺药丸不视为有效药丸');
  assert.equal(extracted.hasMalformedPill, true, '标记为残缺药丸');
  assert.equal(extracted.shouldSkipFolding, true, '指示跳过折叠');

  // 2. isProtocolGuidancePill 必须返回 false
  assert.equal(isProtocolGuidancePill(malformedPillContent), false, '残缺药丸返回 false');

  // 3. foldWithPillIfPresent 必须触发 P6 失败安全，100% 原样返回原 content，绝不丢弃原文！
  const foldFnCalled = false;
  const result = foldWithPillIfPresent(malformedPillContent, () => {
    throw new Error('P6 失败安全下绝对不可调用 foldFn！');
  });

  assert.equal(result, malformedPillContent, 'P6 失败安全保障原内容 100% 完好直通返回');
});

// =========================================================================
// F8: 多模态 content 数组、cache_control 与 Reflect.ownKeys 元数据无损继承
// =========================================================================

test('F8: 多模态 content 数组、cache_control 与 Reflect.ownKeys 元数据无损继承', () => {
  const mockPill = guidanceAssembler.assembleHistoricalPill({ historicalErrors: [] });
  const pillTextEnvelope = `<<<[ROLE_DIVIDE_USER]>>>\n${mockPill}\n<<<[END_ROLE_DIVIDE_USER]>>>`;

  // 构造真实多模态 content 数组
  const multiModalContent = [
    { type: 'image_url', image_url: { url: 'https://example.com/screenshot.png' } },
    {
      type: 'text',
      text: 'Here is analysis prose.\n' + pillTextEnvelope,
      cache_control: { type: 'ephemeral' },
      customField: 999
    }
  ];

  // 附加非枚举元数据与 Symbol
  multiModalContent.__oneRingMeta = { sessionHash: 'one_ring_12345' };
  const customSymbol = Symbol('vcpTestSymbol');
  multiModalContent[customSymbol] = 'symbolSecret';

  // 1. 验证 isProtocolGuidancePill 对多模态数组的兼容识别
  assert.equal(isProtocolGuidancePill(multiModalContent), true, '多模态数组药丸成功识别');

  // 2. 执行折叠（支持函数回调形式）
  const folded = foldWithPillIfPresent(multiModalContent, (cleanText) => {
    assert.ok(!cleanText.includes('【VCP 工具调用协议规范】'), '传入折叠回调的文本已被 stripResilienceMarkers 彻底净化');
    return `[VCP上下文语义折叠-本层摘要: 助手分析了图片。]`;
  });

  // 3. 验证返回结构依然为数组
  assert.ok(Array.isArray(folded), '折叠结果保持为多模态数组');
  assert.equal(folded.length, 3, '数组分片数量为 3（图片 + 摘要文本 + 独立药丸分片）');

  // 4. 验证图片分片保持完好
  assert.deepEqual(folded[0], multiModalContent[0], '非文本媒体分片 100% 保持完好');

  // 5. 验证文本分片成功植入折叠摘要，且 cache_control 完好继承
  assert.equal(folded[1].type, 'text');
  assert.ok(folded[1].text.includes('[VCP上下文语义折叠-本层摘要: 助手分析了图片。]'), '包含摘要正文');
  assert.deepEqual(folded[1].cache_control, { type: 'ephemeral' }, 'cache_control 完好继承');
  assert.equal(folded[1].customField, 999, '自定义字段完好继承');

  // 末尾独立分片包含纯净药丸
  assert.equal(folded[2].type, 'text');
  assert.ok(folded[2].text.includes('<<<[ROLE_DIVIDE_USER]>>>\n[系统提示:] 【VCP 工具调用协议规范】'), '末尾独立分片包含纯净药丸');

  // 6. 验证数组自身属性（__oneRingMeta 与 Symbol）无损继承
  assert.deepEqual(folded.__oneRingMeta, { sessionHash: 'one_ring_12345' }, '__oneRingMeta 无损继承');
  assert.equal(folded[customSymbol], 'symbolSecret', 'Symbol 属性无损继承');
});

// =========================================================================
// F9: 与 modules/roleDivider.js 真实端到端切分联动验证
// =========================================================================

test('F9: 与 modules/roleDivider.js 真实端到端切分联动验证', () => {
  const mockPill = guidanceAssembler.assembleHistoricalPill({ historicalErrors: [] });
  const rawContent = `分析完成。\n<<<[ROLE_DIVIDE_USER]>>>\n${mockPill}\n<<<[END_ROLE_DIVIDE_USER]>>>`;

  const summary = '[VCP上下文语义折叠-本层摘要: 助手协助完成了代码审计与异常修复。]';
  const folded = foldWithPillIfPresent(rawContent, summary);

  // 模拟待发送的消息对象（依然为 assistant）
  const foldedAssistantMsg = {
    role: 'assistant',
    content: folded
  };

  // 送入真实的 roleDivider.process([msg]) 执行切分
  const splitMessages = roleDivider.process([foldedAssistantMsg]);

  // 核心契约验证：必须严格切分为 2 条消息！
  assert.equal(splitMessages.length, 2, '必须严格切分为 2 条消息');

  // 1. 第一条消息：角色必须为 assistant，内容为纯净的折叠摘要（绝无 ROLE_DIVIDE_USER 残留）
  assert.equal(splitMessages[0].role, 'assistant');
  assert.equal(splitMessages[0].content.trim(), summary);
  assert.ok(!splitMessages[0].content.includes('<<<[ROLE_DIVIDE_USER]>>>'), '摘要消息绝无开标残留');
  assert.ok(!splitMessages[0].content.includes('<<<[END_ROLE_DIVIDE_USER]>>>'), '摘要消息绝无闭标残留');

  // 2. 第二条消息：角色必须为 user，内容为纯净药丸（绝无 ROLE_DIVIDE_USER 标签）
  assert.equal(splitMessages[1].role, 'user');
  assert.ok(splitMessages[1].content.includes('[系统提示:] 【VCP 工具调用协议规范】'), 'user 消息包含系统提示药丸');
  assert.ok(splitMessages[1].content.includes('【/VCP 工具调用协议规范】'), 'user 消息包含药丸尾标');
  assert.ok(!splitMessages[1].content.includes('<<<[ROLE_DIVIDE_USER]>>>'), '药丸消息绝无开标残留');
  assert.ok(!splitMessages[1].content.includes('<<<[END_ROLE_DIVIDE_USER]>>>'), '药丸消息绝无闭标残留');
});

// =========================================================================
// F10: 全半角/变体正则兼容与总开关 isResilienceEnabled=false 安全直通
// =========================================================================

test('F10: 全半角/变体正则兼容与总开关 isResilienceEnabled=false 安全直通', () => {
  // 1. 变体标签识别测试（半角括号、斜杠变体、不含“工具调用”四字）
  const variantPill = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '[系统提示:] [VCP协议规范]',
    '标准协议内容……',
    '[/VCP协议规范]',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  assert.equal(isProtocolGuidancePill(variantPill), true, '半角括号及变体协议药丸成功识别');
  const strippedVariant = stripResilienceMarkers(variantPill);
  assert.equal(strippedVariant, '', '变体药丸被完整剥除');

  // 2. 总开关环境变量关闭测试
  const oldVcpEnv = process.env.VCP_PROTOCOL_RESILIENCE_ENABLED;
  try {
    process.env.VCP_PROTOCOL_RESILIENCE_ENABLED = 'false';
    assert.equal(isResilienceEnabled(), false, '门控关闭');

    const textWithPill = 'Prose\n' + variantPill;
    assert.equal(stripResilienceMarkers(textWithPill), textWithPill, '门控关闭时 stripResilienceMarkers 原样直通');
    assert.equal(isProtocolGuidancePill(textWithPill), false, '门控关闭时 isProtocolGuidancePill 返回 false');
    assert.equal(extractTopLevelPillEnvelope(textWithPill).hasPill, false, '门控关闭时 extractTopLevelPillEnvelope 返回 false');

    const foldedWhenDisabled = foldWithPillIfPresent(textWithPill, 'Summary');
    assert.equal(foldedWhenDisabled, 'Summary', '门控关闭时退化为普通折叠');
  } finally {
    if (oldVcpEnv !== undefined) process.env.VCP_PROTOCOL_RESILIENCE_ENABLED = oldVcpEnv;
    else delete process.env.VCP_PROTOCOL_RESILIENCE_ENABLED;
  }
});

// =========================================================================
// F11: 【BUG-01】findVcpInfoRanges 行首换行/空格边界校验与代码字面量防自指投毒
// =========================================================================

test('F11: 【BUG-01】findVcpInfoRanges 行首换行/空格边界校验与代码字面量防自指投毒', () => {
  const { findVcpInfoRanges } = resilienceModule;

  // 构造带有代码行内字面量 "VCP调用结果结束]]" 的日志块，真实闭标在后续行
  const poisonedText = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '[[VCP调用结果信息汇总:',
    '- 工具名称: SourceReader',
    '- 执行状态: ✅ SUCCESS',
    '- 返回内容:',
    '  function example() {',
    '    const dummy = "VCP调用结果结束]]"; // 行内代码字面量，非行首闭标',
    '    return dummy;',
    '  }',
    '  [系统提示:] 【VCP 工具调用协议规范】自指文档正文【/VCP 工具调用协议规范】',
    'VCP调用结果结束]]',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  // 1. 验证 findVcpInfoRanges 不会被行内代码字面量提前截断
  const ranges = findVcpInfoRanges(poisonedText);
  assert.equal(ranges.length, 1, '仅识别为单个完整的保护区');
  assert.ok(ranges[0].text.endsWith('VCP调用结果结束]]'), '保护区延伸至真实行尾闭标');
  assert.ok(ranges[0].text.includes('const dummy = "VCP调用结果结束]]";'), '内嵌字面量被完整包含在保护区内部');

  // 2. 验证内部由于在保护区内，绝不被误判为顶层系统药丸
  assert.equal(isProtocolGuidancePill(poisonedText), false, '保护区内的伪药丸绝不被误判为顶层系统药丸');

  // 3. 验证行首仅带缩进（空格/制表符）的合法闭标正常生效
  const indentedCloseText = [
    '[[VCP调用结果信息汇总:',
    '- 工具名称: TestTool',
    '  VCP调用结果结束]]'
  ].join('\n');
  const indentedRanges = findVcpInfoRanges(indentedCloseText);
  assert.equal(indentedRanges.length, 1, '行首带空格缩进的闭标正常闭合');
});

// =========================================================================
// F12: 【BUG-02】stripResilienceMarkers 坚决保护 ReadFile 等正常工具返回文档与散文中的协议规范
// =========================================================================

test('F12: 【BUG-02】stripResilienceMarkers 坚决保护 ReadFile 等正常工具返回文档与散文中的协议规范', () => {
  const pillDoc = [
    '[系统提示:] 【VCP 工具调用协议规范】',
    '标准协议格式说明正文，绝对不能被误删！',
    '【/VCP 工具调用协议规范】'
  ].join('\n');

  // 场景 A: 正常工具 ReadFile 返回了协议规范文档
  const readFileText = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '<<<[VCP_TOOL_BATCH_START:2026-11-22T04:00:00.000+08:00]>>>',
    '[[VCP调用结果信息汇总:',
    '- 工具名称: ReadFile',
    '- 执行状态: ✅ SUCCESS',
    '- 返回内容:',
    pillDoc,
    'VCP调用结果结束]]',
    '<<<[VCP_TOOL_BATCH_END:2026-11-22T04:00:00.000+08:00]>>>',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  // 场景 B: 外层散文（不在 ROLE_DIVIDE_USER 内）中讨论并包含了规范示例
  const proseWithDoc = `以下是文档说明：\n${pillDoc}\n请仔细阅读。`;

  // 场景 C: 顶层真正的系统药丸
  const truePillText = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    pillDoc,
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  // 执行净化
  const strippedReadFile = stripResilienceMarkers(readFileText);
  const strippedProse = stripResilienceMarkers(proseWithDoc);
  const strippedTruePill = stripResilienceMarkers(truePillText);

  // 断言保护与精准剥除
  assert.ok(strippedReadFile.includes(pillDoc), 'ReadFile 保护区内的协议文档 100% 完好无损');
  assert.equal(strippedProse, proseWithDoc, '外层散文中的协议文档 100% 完好无损');
  assert.equal(strippedTruePill, '', '只有顶层 ROLE_DIVIDE_USER 内的系统药丸被精准剥除');
});

// =========================================================================
// F13: 【BUG-03】foldWithPillIfPresent 多模态非首分片 cache_control 无损继承
// =========================================================================

test('F13: 【BUG-03】foldWithPillIfPresent 多模态非首分片 cache_control 无损继承', () => {
  const mockPill = guidanceAssembler.assembleHistoricalPill({ historicalErrors: [] });
  const pillTextEnvelope = `<<<[ROLE_DIVIDE_USER]>>>\n${mockPill}\n<<<[END_ROLE_DIVIDE_USER]>>>`;

  // 构造多模态数组：第 1 个分片为图片，第 2 个文本分片无 cache_control，第 3 个文本分片携带 cache_control 与药丸
  const multiModalContent = [
    { type: 'image_url', image_url: { url: 'https://example.com/figure.png' } },
    { type: 'text', text: 'First plain text without cache control.' },
    {
      type: 'text',
      text: 'Second text containing pill:\n' + pillTextEnvelope,
      cache_control: { type: 'ephemeral' }
    }
  ];

  const folded = foldWithPillIfPresent(multiModalContent, 'Summary: Image and text processed.');

  assert.ok(Array.isArray(folded), '返回依然为多模态数组');
  assert.equal(folded.length, 3, '文本分片收敛为摘要并在末尾追加独立药丸分片，总分片数为 3（图片 + 摘要 + 药丸）');
  assert.deepEqual(folded[0], multiModalContent[0], '图片分片 100% 完好保留');

  // 核心断言：首个文本分片完整继承了后续文本分片的 cache_control！
  assert.equal(folded[1].type, 'text');
  assert.deepEqual(folded[1].cache_control, { type: 'ephemeral' }, '非首文本分片的 cache_control 成功继承');
  assert.ok(folded[1].text.includes('Summary: Image and text processed.'), '文本分片包含摘要');

  assert.equal(folded[2].type, 'text');
  assert.ok(folded[2].text.includes('<<<[ROLE_DIVIDE_USER]>>>\n[系统提示:] 【VCP 工具调用协议规范】'), '末尾独立分片包含纯净药丸');
});

// =========================================================================
// F14: 【BUG-04】stripResilienceMarkers 彻底清除 P6 兜底后的掏空错误块与空批次外壳
// =========================================================================

test('F14: 【BUG-04】stripResilienceMarkers 彻底清除 P6 兜底后的掏空错误块与空批次外壳', () => {
  // 构造 P6 触发场景：孤立指纹 deadbeef，正文中无对应 badBlock
  const p6ErrorBatch = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '<<<[VCP_TOOL_BATCH_START:2026-11-22T04:00:00.000+08:00]>>>',
    '[[VCP调用结果信息汇总:',
    '- 工具名称: VCP工具调用',
    '- 执行状态: ❌ ERROR',
    '- 返回内容: [[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=deadbeef]]',
    '请规范填写参数：',
    '```vcp',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」你的署名「末」,',
    'tool_name:「始」<目标工具名>「末」',
    '<<<[END_TOOL_REQUEST]>>>',
    '```',
    '[[/VCP协议纠偏指导]]',
    'VCP调用结果结束]]',
    '<<<[VCP_TOOL_BATCH_SUMMARY]>>>',
    '- VCP工具调用 格式错误（未执行）。',
    '<<<[END_VCP_TOOL_BATCH_SUMMARY]>>>',
    '<<<[VCP_TOOL_BATCH_END:2026-11-22T04:00:00.000+08:00]>>>',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  const stripped = stripResilienceMarkers(p6ErrorBatch);

  // 核心断言：全空批次必须被 EMPTY_BATCH_ENVELOPE_REGEX 干净清除为纯空文本！
  assert.equal(stripped, '', 'P6 兜底后的空错误批次壳被彻底干净清除');
  assert.ok(!stripped.includes('<<<[ROLE_DIVIDE_USER]>>>'), '无外壳开标残留');
  assert.ok(!stripped.includes('<<<[END_ROLE_DIVIDE_USER]>>>'), '无外壳闭标残留');
  assert.ok(!stripped.includes('<<<[VCP_TOOL_BATCH_START'), '无批次开标残留');
  assert.ok(!stripped.includes('❌ ERROR'), '无错误状态残留');

  // 若批次前后有合法散文，散文被完整保留且无批次残留
  const withProse = `Prose before.\n\n${p6ErrorBatch}\n\nProse after.`;
  const strippedWithProse = stripResilienceMarkers(withProse);
  assert.equal(strippedWithProse, 'Prose before.\n\nProse after.', '前后散文完整保留且空批次壳完全抹除');
});

// =========================================================================
// F15: 【BUG-05】extractTopLevelPillEnvelope 2开1闭等多开少闭截断场景 P6 失败安全
// =========================================================================

test('F15: 【BUG-05】extractTopLevelPillEnvelope 2开1闭等多开少闭截断场景 P6 失败安全', () => {
  // 构造 2 开 1 闭残损截断药丸
  const truncatedPillContent = [
    'Prose analysis.',
    '<<<[ROLE_DIVIDE_USER]>>>',
    '[系统提示:] 【VCP 工具调用协议规范】',
    '第一段协议内容……',
    '【VCP 工具调用协议规范】',
    '第二段残缺嵌套开标……',
    '【/VCP 工具调用协议规范】',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  // 1. extractTopLevelPillEnvelope 必须精准识别多开少闭并触发 P6 失败安全
  const pillInfo = extractTopLevelPillEnvelope(truncatedPillContent);
  assert.equal(pillInfo.hasMalformedPill, true, '识别为残缺药丸');
  assert.equal(pillInfo.shouldSkipFolding, true, '标记为跳过折叠');
  assert.equal(pillInfo.hasPill, false, 'hasPill 标记为 false');

  // 2. isProtocolGuidancePill 返回 false
  assert.equal(isProtocolGuidancePill(truncatedPillContent), false, 'isProtocolGuidancePill 返回 false');

  // 3. foldWithPillIfPresent 触发 P6 失败安全，原样直通返回原 content，跳过折叠
  const folded = foldWithPillIfPresent(truncatedPillContent, 'Folded Summary');
  assert.equal(folded, truncatedPillContent, '残损药丸原样直通返回，跳过折叠');
});

// =========================================================================
// F16: 【BUG-06】全角标点前缀【系统提示：】兼容与 CRLF 换行收敛
// =========================================================================

test('F16: 【BUG-06】全角标点前缀【系统提示：】兼容与 CRLF 换行收敛', () => {
  // 1. 全角标点前缀 【系统提示：】 识别与剥离
  const fullWidthPill = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '【系统提示：】 【VCP 工具调用协议规范】',
    '全角标点格式规范正文……',
    '【/VCP 工具调用协议规范】',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  assert.equal(isProtocolGuidancePill(fullWidthPill), true, '全角标点【系统提示：】药丸成功识别');
  const strippedFullWidth = stripResilienceMarkers(fullWidthPill);
  assert.equal(strippedFullWidth, '', '全角标点药丸被完整剥除');

  // 2. 半角冒号全角中括号变体 【系统提示:]
  const mixedPill = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '【系统提示:] 【VCP 工具调用协议规范】',
    '变体规范正文……',
    '【/VCP 工具调用协议规范】',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');
  assert.equal(isProtocolGuidancePill(mixedPill), true, '变体前缀药丸成功识别');

  // 3. CRLF 换行收敛测试
  const crlfText = 'Prose line 1\r\n\r\n\r\n\r\n\r\n<<<[VCP_TOOL_BATCH_END:2026-11-22]>>>';
  const strippedCrlf = stripResilienceMarkers(crlfText);
  assert.ok(!strippedCrlf.includes('\r\n\r\n\r\n'), 'CRLF 多余换行被收敛');
  assert.ok(strippedCrlf.includes('\r\n<<<[VCP_TOOL_BATCH_END:2026-11-22]>>>'), 'BATCH_END 前方紧密收敛单一换行');
});

// =========================================================================
// F17: 【BUG-07】index.js 统一门控 isResilienceEnabled(options) 与 options.enabled 透传
// =========================================================================

test('F17: 【BUG-07】index.js 统一门控 isResilienceEnabled(options) 与 options.enabled 透传', async () => {
  const mockPill = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '[系统提示:] 【VCP 工具调用协议规范】',
    '标准协议规范正文',
    '【/VCP 工具调用协议规范】',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  const textWithPill = `Prose before.\n${mockPill}\nProse after.`;
  const disabledOpt = { enabled: false };

  // 1. isResilienceEnabled 支持 options.enabled === false 门控
  assert.equal(resilienceModule.isResilienceEnabled(disabledOpt), false, 'options.enabled=false 正确判定为门控关闭');
  assert.equal(resilienceModule.isResilienceEnabled({ enabled: true }), true, 'options.enabled=true 正确判定为门控开启');
  assert.equal(resilienceModule.isResilienceEnabled({}), true, '空 options 默认开启');

  // 2. 验证 index.js 导出的包装函数均透传 options 且生效关闭逻辑
  assert.equal(resilienceModule.stripResilienceMarkers(textWithPill, disabledOpt), textWithPill, '门控关闭时 stripResilienceMarkers 原样直通');
  assert.equal(resilienceModule.isProtocolGuidancePill(textWithPill, disabledOpt), false, '门控关闭时 isProtocolGuidancePill 返回 false');
  assert.equal(resilienceModule.extractTopLevelPillEnvelope(textWithPill, disabledOpt).hasPill, false, '门控关闭时 extractTopLevelPillEnvelope 返回 false');

  const foldedDisabled = resilienceModule.foldWithPillIfPresent(textWithPill, 'Plain Summary', disabledOpt);
  assert.equal(foldedDisabled, 'Plain Summary', '门控关闭时 foldWithPillIfPresent 退化为普通无药折叠');

  // 3. 验证 extractHistoricalErrorBlocks / cleanseHistory / reconcileTurnToolCalls 透传门控
  const badBlock = '<<<[TOOL_REQUEST]>>>\nmaid:「始」Nova「末」\n<<<[END_TOOL_REQUEST]>>>';
  assert.equal(resilienceModule.extractHistoricalErrorBlocks(badBlock, disabledOpt).size, 0, '门控关闭时 extractHistoricalErrorBlocks 返回空 Map');

  const msgs = [{ role: 'assistant', content: badBlock }];
  assert.equal(resilienceModule.cleanseHistory(msgs, disabledOpt), msgs, '门控关闭时 cleanseHistory 原样直通');

  const reconciled = await resilienceModule.reconcileTurnToolCalls(badBlock, [{ name: 'test' }], disabledOpt);
  assert.equal(reconciled.protocolErrors.length, 0, '门控关闭时 reconcileTurnToolCalls 原样直通');
});

// =========================================================================
// F18: 【BUG-08】foldWithPillIfPresent 顶层对象分支优先判定与免重复推演
// =========================================================================

test('F18: 【BUG-08】foldWithPillIfPresent 顶层对象分支优先判定与免重复推演', () => {
  const mockPill = guidanceAssembler.assembleHistoricalPill({ historicalErrors: [] });
  const rawPillText = `分析完成。\n<<<[ROLE_DIVIDE_USER]>>>\n${mockPill}\n<<<[END_ROLE_DIVIDE_USER]>>>`;

  // 构造带有 .content 属性的消息对象
  const wrappedMessage = {
    role: 'assistant',
    content: rawPillText,
    id: 'msg-audit-999',
    timestamp: 1795329000
  };

  // 使用计次回调验证函数未被重复调用两次
  let summaryCallCount = 0;
  const summaryFn = (cleanText) => {
    summaryCallCount++;
    assert.ok(!cleanText.includes('【VCP 工具调用协议规范】'), '传入折叠回调的文本已被净化');
    return '[VCP上下文语义折叠-本层摘要: 助手完成了审计。]';
  };

  const folded = foldWithPillIfPresent(wrappedMessage, summaryFn);

  // 核心断言 1：summaryFn 仅被调用 1 次，杜绝顶层与内层重复推演！
  assert.equal(summaryCallCount, 1, '摘要计算函数仅被执行 1 次，无重复推演');

  // 核心断言 2：返回对象结构完好，元数据保留，且 content 被成功折叠为摘要 + 药丸
  assert.equal(typeof folded, 'object');
  assert.equal(folded.role, 'assistant');
  assert.equal(folded.id, 'msg-audit-999');
  assert.equal(folded.timestamp, 1795329000);
  assert.ok(folded.content.includes('[VCP上下文语义折叠-本层摘要: 助手完成了审计。]'), '内层 content 包含摘要');
  assert.ok(folded.content.includes('<<<[ROLE_DIVIDE_USER]>>>\n[系统提示:] 【VCP 工具调用协议规范】'), '内层 content 包含纯净药丸');
});


// =========================================================================
// F19: 【BUG-R2-01】TextSanitizer.sanitizeForEmbedding 与 stripResilienceMarkers 真实打通与向量净化
// =========================================================================

test('F19: 【BUG-R2-01】TextSanitizer.sanitizeForEmbedding 与 stripResilienceMarkers 真实打通与向量净化', () => {
  const TextSanitizer = require('../Plugin/RAGDiaryPlugin/TextSanitizer');

  // 1. 测试 assistant 角色：包含常驻系统药丸的内容送入 sanitizeForEmbedding
  const mockPill = guidanceAssembler.assembleHistoricalPill({ historicalErrors: [] });
  const rawPillText = `业务散文分析结论。\n<<<[ROLE_DIVIDE_USER]>>>\n${mockPill}\n<<<[END_ROLE_DIVIDE_USER]>>>\n后续工作指示。`;

  const sanitizedAssistant = TextSanitizer.sanitizeForEmbedding(rawPillText, 'assistant');
  assert.ok(!sanitizedAssistant.includes('【VCP 工具调用协议规范】'), 'TextSanitizer 彻底剔除常驻系统药丸');
  assert.ok(!sanitizedAssistant.includes('<<<[ROLE_DIVIDE_USER]>>>'), 'TextSanitizer 剔除药丸外壳');
  assert.ok(sanitizedAssistant.includes('业务散文分析结论'), '保留前置业务散文');
  assert.ok(sanitizedAssistant.includes('后续工作指示'), '保留后置业务指示');

  // 2. 测试 user 角色：包含纠偏指导与空批次外壳的内容送入 sanitizeForEmbedding
  const errorContent = `前置内容。\n[[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=deadbeef]]\n纠偏说明\n[[/VCP协议纠偏指导]]\n[本轮工具调用摘要:]\n[本轮工具调用摘要结束]\n后置内容。`;
  const sanitizedUser = TextSanitizer.sanitizeForEmbedding(errorContent, 'user');
  assert.ok(!sanitizedUser.includes('VCP协议纠偏指导'), 'TextSanitizer 彻底剔除协议纠偏指导');
  assert.ok(!sanitizedUser.includes('本轮工具调用摘要'), 'TextSanitizer 剔除空摘要外壳');
  assert.ok(sanitizedUser.includes('前置内容'), '保留正文内容');
  assert.ok(sanitizedUser.includes('后置内容'), '保留后置内容');

  // 3. LRU 缓存一致性与零抖动幂等性
  const cachedSecondCall = TextSanitizer.sanitizeForEmbedding(rawPillText, 'assistant');
  assert.equal(cachedSecondCall, sanitizedAssistant, '重复调用返回严格一致的缓存结果');
});

// =========================================================================
// F20: 【BUG-R2-02】findVcpInfoRanges 行首边界校验与未闭合坏块严禁拉伸至 text.length
// =========================================================================

test('F20: 【BUG-R2-02】findVcpInfoRanges 行首边界校验与未闭合坏块严禁拉伸至 text.length', () => {
  const { findVcpInfoRanges: localFindVcpInfoRanges } = require('../modules/vcpProtocolResilience/historyCleanse');

  // 1. 代码字面量中的 [[VCP调用结果信息汇总: 不递增 depth，不误判为独立信息汇总块
  const textWithCode = [
    'let str = "[[VCP调用结果信息汇总:";',
    '[[VCP调用结果信息汇总:',
    '- 工具名称: TestTool',
    '- 执行状态: ✅ SUCCESS',
    '- 返回内容: ok',
    'VCP调用结果结束]]'
  ].join('\n');
  const ranges = localFindVcpInfoRanges(textWithCode);
  assert.equal(ranges.length, 1, '仅识别真正的独立行首汇总块，忽略代码字面量');
  assert.ok(ranges[0].text.includes('TestTool'), '匹配到正确的工具汇总块');

  // 2. 未闭合坏块（depth !== 0）绝对严禁将区间拉伸到 text.length 推入 ranges
  const unclosedText = [
    '[[VCP调用结果信息汇总:',
    '- 工具名称: BadTool',
    '- 执行状态: ❌ ERROR',
    '- 返回内容: 50KB 未闭合坏块内容……',
    '这里没有结束标签，一直延续到文本末尾……'
  ].join('\n');
  const unclosedRanges = localFindVcpInfoRanges(unclosedText);
  assert.equal(unclosedRanges.length, 0, '未闭合坏块深度 depth !== 0 绝对严禁拉伸至 text.length 推入 ranges 作为合法保护区！');

  // 3. 未闭合坏块后续若跟有合法闭合块，合法闭合块可正常识别
  const mixedText = [
    '[[VCP调用结果信息汇总:',
    '- 坏块未闭合',
    '',
    '[[VCP调用结果信息汇总:',
    '- 工具名称: ValidTool',
    '- 执行状态: ✅ SUCCESS',
    '- 返回内容: valid result',
    'VCP调用结果结束]]'
  ].join('\n');
  const mixedRanges = localFindVcpInfoRanges(mixedText);
  assert.equal(mixedRanges.length, 1, '未闭合坏块不入 ranges，后续合法块正确识别');
  assert.ok(mixedRanges[0].text.includes('ValidTool'), '识别出有效的 ValidTool');
});

// =========================================================================
// F21: 【BUG-R2-03】extractTopLevelPillEnvelope isOverlappingInfo 双端区间重叠判断杜绝 50KB 业务大日志打包成药丸
// =========================================================================

test('F21: 【BUG-R2-03】extractTopLevelPillEnvelope isOverlappingInfo 双端区间重叠判断杜绝 50KB 业务大日志打包成药丸', () => {
  const bigLog = 'A'.repeat(50000);
  const maliciousEnvelope = [
    'Prose header.',
    '<<<[ROLE_DIVIDE_USER]>>>',
    '【VCP 工具调用协议规范】',
    '[[VCP调用结果信息汇总:',
    '- 工具名称: HugeFileTool',
    '- 执行状态: ✅ SUCCESS',
    `- 返回内容: ${bigLog}`,
    'VCP调用结果结束]]',
    '【/VCP 工具调用协议规范】',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  // 1. extractTopLevelPillEnvelope 必须判定该伪药丸跨越了 innerInfoRanges，拒绝提取
  const pillInfo = extractTopLevelPillEnvelope(maliciousEnvelope);
  assert.equal(pillInfo.hasPill, false, '跨越 50KB 业务日志的伪药丸被双端重叠检测拦截，hasPill 为 false');
  assert.equal(pillInfo.hasMalformedPill, true, '标记为残缺/异常药丸');
  assert.equal(pillInfo.shouldSkipFolding, true, '标记为跳过折叠，触发 P6 失败安全');

  // 2. foldWithPillIfPresent 严禁将 50KB 业务大日志打包成药丸！原样直通返回
  const folded = foldWithPillIfPresent(maliciousEnvelope, 'Summary');
  assert.equal(folded, maliciousEnvelope, 'P6 失败安全：原样直通返回，严禁将 50KB 业务大日志打包为系统药丸！');
});

// =========================================================================
// F22: 【BUG-R2-04】真实生产摘要格式兼容（空摘要外壳清除与具体插件名错误项剔除）
// =========================================================================

test('F22: 【BUG-R2-04】真实生产摘要格式兼容（空摘要外壳清除与具体插件名错误项剔除）', () => {
  // 1. 真实生产 [本轮工具调用摘要:]\s*(\r?\n)?\s*\[本轮工具调用摘要结束\] 匹配与清除
  const prodSummary1 = `业务内容 1。\n[本轮工具调用摘要:]\n[本轮工具调用摘要结束]\n业务内容 2。`;
  const strippedSummary1 = stripResilienceMarkers(prodSummary1);
  assert.equal(strippedSummary1, '业务内容 1。\n业务内容 2。', '真实生产空摘要外壳被完整清除');
  assert.ok(!strippedSummary1.includes('本轮工具调用摘要'), '彻底清除摘要标记');

  const prodSummaryCrlf = `业务内容 A。\r\n[本轮工具调用摘要:]\r\n[本轮工具调用摘要结束]\r\n业务内容 B。`;
  const strippedSummaryCrlf = stripResilienceMarkers(prodSummaryCrlf);
  assert.ok(!strippedSummaryCrlf.includes('本轮工具调用摘要'), 'CRLF 空摘要外壳清除');

  // 2. SUMMARY_ERROR_ITEM_REGEX 放宽工具名称，兼容 BadTool / 中文分号 / 有无列表标号
  const mixedSemicolonItems = [
    '[本轮工具调用摘要:]',
    'LinuxShellExecutor 调用成功；BadTool 格式错误（未执行）。',
    '[本轮工具调用摘要结束]'
  ].join('\n');
  const strippedSemicolon = stripResilienceMarkers(mixedSemicolonItems);
  assert.ok(!strippedSemicolon.includes('BadTool'), '剔除中文分号连接的具体插件名错误项');
  assert.ok(strippedSemicolon.includes('LinuxShellExecutor 调用成功'), '保留同批成功摘要');

  const listItems = [
    '- BadTool 格式错误（未执行）。',
    '- [x] CustomAnalyzer -> 格式错误（未执行）',
    '- GoodTool 运行正常。'
  ].join('\n');
  const strippedList = stripResilienceMarkers(listItems);
  assert.ok(!strippedList.includes('BadTool'), '剔除列表格式 BadTool');
  assert.ok(!strippedList.includes('CustomAnalyzer'), '剔除列表格式 CustomAnalyzer');
  assert.ok(strippedList.includes('GoodTool 运行正常'), '保留正常工具行');
});

// =========================================================================
// F23: 【BUG-R2-05】EMPTY_ERROR_INFO_REGEX 通用元数据属性键值匹配与空错误块剥离
// =========================================================================

test('F23: 【BUG-R2-05】EMPTY_ERROR_INFO_REGEX 通用元数据属性键值匹配与空错误块剥离', () => {
  const customErrorInfo = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '[[VCP调用结果信息汇总:',
    '- 自定义插件名: AdvancedSearchPlugin',
    '- 追踪ID: req-uuid-8888',
    '- 执行状态: ❌ ERROR',
    '- 额外标签: vcp-resilience-tier2',
    '- 调用耗时: 154ms',
    '- 返回内容: ',
    'VCP调用结果结束]]',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  const stripped = stripResilienceMarkers(customErrorInfo);
  assert.equal(stripped, '', '通用键值匹配放宽元数据白名单后，任意自定义属性的空错误块均被彻底剥离');
});

// =========================================================================
// F24: 【BUG-R2-06】extractTopLevelPillEnvelope 事件栈/位置序判定（先闭后开倒置残缺与孤立闭标触发 P6 失败安全）
// =========================================================================

test('F24: 【BUG-R2-06】extractTopLevelPillEnvelope 事件栈/位置序判定（先闭后开倒置残缺与孤立闭标触发 P6 失败安全）', () => {
  // 1. 遇到先闭后开（倒置残缺）
  const invertedPill = [
    'Prose start.',
    '<<<[ROLE_DIVIDE_USER]>>>',
    '【/VCP 工具调用协议规范】',
    '倒置的残缺正文……',
    '【VCP 工具调用协议规范】',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  const invertedInfo = extractTopLevelPillEnvelope(invertedPill);
  assert.equal(invertedInfo.hasMalformedPill, true, '先闭后开被事件栈精准识别为残缺');
  assert.equal(invertedInfo.shouldSkipFolding, true, '标记为跳过折叠');
  assert.equal(invertedInfo.hasPill, false, 'hasPill 必须为 false');
  assert.equal(isProtocolGuidancePill(invertedPill), false, 'isProtocolGuidancePill 返回 false');
  assert.equal(foldWithPillIfPresent(invertedPill, 'Summary'), invertedPill, '倒置药丸触发 P6 失败安全，原样直通');

  // 2. 孤立闭标
  const orphanedClose = [
    'Prose start.',
    '<<<[ROLE_DIVIDE_USER]>>>',
    '【/VCP 工具调用协议规范】',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');
  const orphanedInfo = extractTopLevelPillEnvelope(orphanedClose);
  assert.equal(orphanedInfo.hasMalformedPill, true, '孤立闭标被事件栈识别为残缺');
  assert.equal(orphanedInfo.shouldSkipFolding, true, '标记为跳过折叠');
  assert.equal(foldWithPillIfPresent(orphanedClose, 'Summary'), orphanedClose, '孤立闭标原样直通');
});

// =========================================================================
// F25: 【BUG-R2-07】modules/vcpProtocolResilience/index.js 统一门控包装器导出顺序防覆盖验证
// =========================================================================

test('F25: 【BUG-R2-07】modules/vcpProtocolResilience/index.js 统一门控包装器导出顺序防覆盖验证', async () => {
  const resilience = require('../modules/vcpProtocolResilience');
  const optDisabled = { enabled: false };

  // 1. stripResilienceMarkers
  const pillStr = '<<<[ROLE_DIVIDE_USER]>>>\n【VCP 工具调用协议规范】\ntest\n【/VCP 工具调用协议规范】\n<<<[END_ROLE_DIVIDE_USER]>>>';
  assert.equal(resilience.stripResilienceMarkers(pillStr, optDisabled), pillStr, 'index.js 导出的 stripResilienceMarkers 成功响应 enabled:false');

  // 2. isProtocolGuidancePill
  assert.equal(resilience.isProtocolGuidancePill(pillStr, optDisabled), false, 'index.js 导出的 isProtocolGuidancePill 成功响应 enabled:false');

  // 3. extractTopLevelPillEnvelope
  assert.equal(resilience.extractTopLevelPillEnvelope(pillStr, optDisabled).hasPill, false, 'index.js 导出的 extractTopLevelPillEnvelope 成功响应 enabled:false');

  // 4. foldWithPillIfPresent
  assert.equal(resilience.foldWithPillIfPresent(pillStr, 'Summary', optDisabled), 'Summary', 'index.js 导出的 foldWithPillIfPresent 成功响应 enabled:false');

  // 5. cleanseHistory
  const msgs = [{ role: 'assistant', content: '<<<[TOOL_REQUEST]>>>\nmaid:「始」X「末」\n<<<[END_TOOL_REQUEST]>>>' }];
  assert.equal(resilience.cleanseHistory(msgs, optDisabled), msgs, 'index.js 导出的 cleanseHistory 成功响应 enabled:false');

  // 6. stripErrorBlocksAndReceiptsFromText
  assert.equal(resilience.stripErrorBlocksAndReceiptsFromText(pillStr, optDisabled), pillStr, 'index.js 导出的 stripErrorBlocksAndReceiptsFromText 成功响应 enabled:false');

  // 7. extractHistoricalErrorBlocks
  assert.equal(resilience.extractHistoricalErrorBlocks(pillStr, optDisabled).size, 0, 'index.js 导出的 extractHistoricalErrorBlocks 成功响应 enabled:false');

  // 8. reconcileTurnToolCalls
  const reconciled = await resilience.reconcileTurnToolCalls('text', [{ name: 'test' }], optDisabled);
  assert.equal(reconciled.protocolErrors.length, 0, 'index.js 导出的 reconcileTurnToolCalls 成功响应 enabled:false');
});

// =========================================================================
// F26: 【BUG-R2-08】stripResilienceMarkers 顶层消息对象 { role, content } 解包与重装支持
// =========================================================================

test('F26: 【BUG-R2-08】stripResilienceMarkers 顶层消息对象 { role, content } 解包与重装支持', () => {
  const mockPill = guidanceAssembler.assembleHistoricalPill({ historicalErrors: [] });

  // 1. 普通文本 content 的消息对象
  const msgObj = {
    role: 'assistant',
    content: `分析结论。\n<<<[ROLE_DIVIDE_USER]>>>\n${mockPill}\n<<<[END_ROLE_DIVIDE_USER]>>>`,
    id: 'msg-object-test-1',
    timestamp: 1795330000,
    meta: { flag: true }
  };

  const strippedObj = stripResilienceMarkers(msgObj);
  assert.equal(typeof strippedObj, 'object', '返回消息对象');
  assert.equal(strippedObj.role, 'assistant');
  assert.equal(strippedObj.id, 'msg-object-test-1');
  assert.equal(strippedObj.timestamp, 1795330000);
  assert.deepEqual(strippedObj.meta, { flag: true });
  assert.equal(strippedObj.content, '分析结论。', 'content 属性中的药丸被彻底剥离');

  // 2. 多模态 content 数组的消息对象
  const multimodalMsgObj = {
    role: 'assistant',
    content: [
      { type: 'text', text: `散文段落。\n<<<[ROLE_DIVIDE_USER]>>>\n${mockPill}\n<<<[END_ROLE_DIVIDE_USER]>>>` },
      { type: 'image_url', image_url: { url: 'https://example.com/test.png' } }
    ],
    id: 'msg-object-multimodal'
  };

  const strippedMultimodal = stripResilienceMarkers(multimodalMsgObj);
  assert.equal(typeof strippedMultimodal, 'object');
  assert.equal(strippedMultimodal.id, 'msg-object-multimodal');
  assert.ok(Array.isArray(strippedMultimodal.content));
  assert.equal(strippedMultimodal.content[0].text, '散文段落。', '多模态文本分片中的药丸被净化');
  assert.deepEqual(strippedMultimodal.content[1], multimodalMsgObj.content[1], '多模态非文本分片完好无损');
});

// =========================================================================
// F27: 【BUG-R3-01】紧凑单换行（\n）排版下状态 0 vs 状态 1 vs 状态 2 在真实 TextSanitizer 下三态逐字节恒等与 SHA-256 零抖动
// =========================================================================

test('F27: 【BUG-R3-01】紧凑单换行（\\n）排版下状态 0 vs 状态 1 vs 状态 2 在真实 TextSanitizer 下三态逐字节恒等与 SHA-256 零抖动', () => {
  const TextSanitizer = require('../Plugin/RAGDiaryPlugin/TextSanitizer');

  const badBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const fix = createErrorFixture(badBlock, 'MISSING_TOOL_NAME');

  // 1. 紧凑单换行（\n）排版基准
  // 散文与坏块/凭条之间仅有单一换行符 \n，测试 EMPTY_ROLE_DIVIDE_REGEX 绝不贪婪吞噬散文间换行
  const state0 = 'Prose before\n' + badBlock + '\n' + fix.receipt + '\nProse after';

  // 状态 1：活药态（清洗变药）
  const msgs1 = [
    { role: 'user', content: 'Turn 1 User' },
    { role: 'assistant', content: state0 },
    { role: 'user', content: 'Turn 2 User Active' }
  ];
  const state1 = cleanseHistory(msgs1)[1].content;
  assert.ok(state1.includes('【VCP 工具调用协议规范】'), '状态 1 挂载了活药');

  // 状态 2：退药态（后续轮次发生新错误，旧药彻底拔除）
  const badBlock2 = '<<<[TOOL_REQUEST]>>>\nmaid:「始」Nova2「末」\n<<<[END_TOOL_REQUEST]>>>';
  const fix2 = createErrorFixture(badBlock2, 'MISSING_TOOL_NAME', { timestamp: '2026-11-22T04:05:00.000+08:00' });
  const msgs2 = [
    { role: 'user', content: 'Turn 1 User' },
    { role: 'assistant', content: state0 },
    { role: 'user', content: 'Turn 2 User' },
    { role: 'assistant', content: 'Prose 2\n' + badBlock2 + '\n' + fix2.receipt },
    { role: 'user', content: 'Turn 3 User Active' }
  ];
  const state2 = cleanseHistory(msgs2)[1].content;
  assert.ok(!state2.includes('【VCP 工具调用协议规范】'), '状态 2 旧药已被拔除');

  // 核心断言 1：stripResilienceMarkers 在单换行紧凑排版下三态 100% 逐字节恒等！
  const stripped0 = stripResilienceMarkers(state0);
  const stripped1 = stripResilienceMarkers(state1);
  const stripped2 = stripResilienceMarkers(state2);

  assert.equal(stripped0, stripped1, '单换行排版下状态 0 与状态 1 净化后逐字节恒等');
  assert.equal(stripped1, stripped2, '单换行排版下状态 1 与状态 2 净化后逐字节恒等');
  assert.equal(sha256(stripped0), sha256(stripped1), '状态 0 与状态 1 SHA-256 绝对一致');
  assert.equal(sha256(stripped1), sha256(stripped2), '状态 1 与状态 2 SHA-256 绝对一致');

  // 核心断言 2：真实 TextSanitizer.sanitizeForEmbedding 下三态 100% 逐字节恒等且 SHA-256 零分裂！
  const san0 = TextSanitizer.sanitizeForEmbedding(state0, 'assistant');
  const san1 = TextSanitizer.sanitizeForEmbedding(state1, 'assistant');
  const san2 = TextSanitizer.sanitizeForEmbedding(state2, 'assistant');

  assert.equal(san0, san1, 'TextSanitizer 输出状态 0 与状态 1 逐字节恒等');
  assert.equal(san1, san2, 'TextSanitizer 输出状态 1 与状态 2 逐字节恒等');
  assert.equal(sha256(san0), sha256(san1), 'TextSanitizer SHA-256 状态 0 与状态 1 零抖动');
  assert.equal(sha256(san1), sha256(san2), 'TextSanitizer SHA-256 状态 1 与状态 2 零抖动');

  assert.ok(!san0.includes('<<<[ROLE_DIVIDE_USER]>>>'), '剔除药丸外壳');
  assert.ok(!san0.includes('【VCP 工具调用协议规范】'), '剔除药丸正文');
  assert.ok(san0.includes('Prose before'), '保留前置散文');
  assert.ok(san0.includes('Prose after'), '保留后置散文');

  // 补充验证：CRLF 单换行排版下的对称收敛与三态恒等
  const state0_crlf = 'Prose before\r\n' + badBlock.replace(/\n/g, '\r\n') + '\r\n' + fix.receipt.replace(/\n/g, '\r\n') + '\r\nProse after';
  const stripped0_crlf = stripResilienceMarkers(state0_crlf);
  assert.ok(stripped0_crlf.includes('Prose before'), 'CRLF 排版保留前置散文');
  assert.ok(stripped0_crlf.includes('Prose after'), 'CRLF 排版保留后置散文');
  assert.ok(!stripped0_crlf.includes('<<<[ROLE_DIVIDE_USER]>>>'), 'CRLF 排版净化外壳');
});

// =========================================================================
// F28: 【BUG-R3-02】options.enabled = false 时 foldWithPillIfPresent 保持消息对象与多模态数组容器类型绝对不变
// =========================================================================

test('F28: 【BUG-R3-02】options.enabled = false 时 foldWithPillIfPresent 保持消息对象与多模态数组容器类型绝对不变', () => {
  const disabledOpt = { enabled: false };
  const mockPill = guidanceAssembler.assembleHistoricalPill({ historicalErrors: [] });
  const rawPillText = `业务散文分析结论。\n<<<[ROLE_DIVIDE_USER]>>>\n${mockPill}\n<<<[END_ROLE_DIVIDE_USER]>>>`;

  // 1. 消息对象 { role, content, id, timestamp, meta } 结构保持
  const msgObj = {
    role: 'assistant',
    content: rawPillText,
    id: 'msg-disabled-test-01',
    timestamp: 1795332000,
    meta: { priority: 'high', traceId: 'tr-abc-123' }
  };

  const foldedMsg = foldWithPillIfPresent(msgObj, '退化摘要正文', disabledOpt);
  assert.equal(typeof foldedMsg, 'object', '返回对象结构，严禁拍扁为 String');
  assert.equal(foldedMsg.role, 'assistant', '保持 role 属性');
  assert.equal(foldedMsg.id, 'msg-disabled-test-01', '保持 id 属性');
  assert.equal(foldedMsg.timestamp, 1795332000, '保持 timestamp 属性');
  assert.deepEqual(foldedMsg.meta, { priority: 'high', traceId: 'tr-abc-123' }, '保持 meta 原数据');
  assert.equal(foldedMsg.content, '退化摘要正文', 'content 内容被正确更新为摘要');

  // 通过 index.js 导出的 resilienceModule.foldWithPillIfPresent 验证容器契约
  const foldedMsgViaIndex = resilienceModule.foldWithPillIfPresent(msgObj, '退化摘要正文', disabledOpt);
  assert.equal(typeof foldedMsgViaIndex, 'object', 'index.js 门控包装器保持对象结构');
  assert.equal(foldedMsgViaIndex.id, 'msg-disabled-test-01');
  assert.equal(foldedMsgViaIndex.content, '退化摘要正文');

  // 函数回调模式下的消息对象保持
  const foldedWithFn = foldWithPillIfPresent(msgObj, (cleanText) => `FnSummary: len=${cleanText.length}`, disabledOpt);
  assert.equal(typeof foldedWithFn, 'object', '回调模式保持对象结构');
  assert.ok(foldedWithFn.content.startsWith('FnSummary: len='), '回调函数计算结果更新到 content');

  // 2. 多模态 Array<{ type, text, cache_control }> 容器与元数据保持
  const multiModal = [
    { type: 'text', text: rawPillText, cache_control: { type: 'ephemeral' } },
    { type: 'image_url', image_url: { url: 'https://example.com/screenshot.png' } }
  ];
  const metaSymbol = Symbol('multiModalSymbol');
  multiModal[metaSymbol] = 'symbolValue';
  Object.defineProperty(multiModal, '__customTag', {
    value: 'persistedTag',
    enumerable: false,
    configurable: true
  });

  const foldedMultiModal = foldWithPillIfPresent(multiModal, '多模态退化摘要', disabledOpt);
  assert.ok(Array.isArray(foldedMultiModal), '保持多模态数组类型，严禁拍扁为 String');
  assert.equal(foldedMultiModal.length, 2, '保持分片数量');
  assert.equal(foldedMultiModal[0].type, 'text', '首分片为 text');
  assert.equal(foldedMultiModal[0].text, '多模态退化摘要', '文本分片更新为摘要');
  assert.deepEqual(foldedMultiModal[0].cache_control, { type: 'ephemeral' }, 'cache_control 无损继承');
  assert.deepEqual(foldedMultiModal[1], multiModal[1], '非文本分片（图片）完好无损');
  assert.equal(foldedMultiModal[metaSymbol], 'symbolValue', 'Symbol 属性无损继承');
  assert.equal(foldedMultiModal.__customTag, 'persistedTag', '不可枚举属性无损继承');

  // 验证 index.js 包装器对多模态数组的透传契约
  const foldedMultiModalViaIndex = resilienceModule.foldWithPillIfPresent(multiModal, '多模态退化摘要', disabledOpt);
  assert.ok(Array.isArray(foldedMultiModalViaIndex), 'index.js 包装器保持数组容器');
  assert.equal(foldedMultiModalViaIndex[0].text, '多模态退化摘要');
  assert.equal(foldedMultiModalViaIndex[metaSymbol], 'symbolValue');

  // 3. 消息对象包裹多模态数组的复合嵌套结构保持
  const complexMsg = {
    role: 'assistant',
    content: multiModal,
    id: 'complex-msg-99'
  };
  const foldedComplex = foldWithPillIfPresent(complexMsg, '复合退化摘要', disabledOpt);
  assert.equal(typeof foldedComplex, 'object', '复合结构外层为消息对象');
  assert.equal(foldedComplex.id, 'complex-msg-99');
  assert.ok(Array.isArray(foldedComplex.content), '复合结构内层 content 为多模态数组');
  assert.equal(foldedComplex.content[0].text, '复合退化摘要');
  assert.equal(foldedComplex.content[metaSymbol], 'symbolValue');

  // 4. 普通字符串 content 退化为 rawSummary
  assert.equal(foldWithPillIfPresent('纯文本内容', 'PlainSummary', disabledOpt), 'PlainSummary', '纯字符串返回 rawSummary');
});

// =========================================================================
// F29: 【BUG-R3-03】自嵌套药丸（2开2闭内嵌）精准拦截为残损并触发 P6 失败安全跳过折叠
// =========================================================================

test('F29: 【BUG-R3-03】自嵌套药丸（2开2闭内嵌）精准拦截为残损并触发 P6 失败安全跳过折叠', () => {
  // 构造 2开2闭自嵌套药丸（在未闭合的外层药丸内部，非法嵌套了内层药丸）
  const nestedPill = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '【VCP 工具调用协议规范】',
    '外层标准协议规范正文第 1 段。',
    '【VCP 工具调用协议规范】',
    '内层非法自嵌套或投毒药丸协议正文。',
    '【/VCP 工具调用协议规范】',
    '外层标准协议规范正文第 2 段。',
    '【/VCP 工具调用协议规范】',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  // 1. extractTopLevelPillEnvelope 精准识别自嵌套非平铺残损
  const envelopeInfo = extractTopLevelPillEnvelope(nestedPill);
  assert.equal(envelopeInfo.hasPill, false, '自嵌套药丸不能被识别为合法顶层药丸');
  assert.equal(envelopeInfo.hasMalformedPill, true, '自嵌套药丸必须标记为 hasMalformedPill=true');
  assert.equal(envelopeInfo.shouldSkipFolding, true, '自嵌套药丸必须触发 shouldSkipFolding=true');

  // 2. isProtocolGuidancePill 安全拦截
  assert.equal(isProtocolGuidancePill(nestedPill), false, '自嵌套药丸判定为 false');

  // 3. foldWithPillIfPresent 触发 P6 失败安全，100% 原样直通返回，跳过折叠
  const foldedResult = foldWithPillIfPresent(nestedPill, 'Should not fold this text');
  assert.equal(foldedResult, nestedPill, '自嵌套药丸触发 P6 失败安全，原样直通返回原 content');

  // 4. 包装在消息对象中的自嵌套药丸同样触发 P6 失败安全原样直通
  const nestedMsgObj = {
    role: 'assistant',
    content: nestedPill,
    id: 'nested-pill-msg-1'
  };
  const foldedMsgObj = foldWithPillIfPresent(nestedMsgObj, 'Should not fold');
  assert.deepEqual(foldedMsgObj, nestedMsgObj, '消息对象中的自嵌套药丸 100% 原样直通返回');

  // 5. 多模态分片中的自嵌套药丸同样原样直通
  const nestedMultiModal = [
    { type: 'text', text: nestedPill },
    { type: 'image_url', image_url: { url: 'https://example.com/test.png' } }
  ];
  const foldedMultiModal = foldWithPillIfPresent(nestedMultiModal, 'Should not fold');
  assert.deepEqual(foldedMultiModal, nestedMultiModal, '多模态数组中的自嵌套药丸 100% 原样直通返回');
});


// =========================================================================
// F30: 【BUG-R4-01】foldWithPillIfPresent 容灾测试（foldFn 返回 undefined、null 时不抛异常且正常拼接药丸）
// =========================================================================

test('F30: 【BUG-R4-01】foldWithPillIfPresent 容灾测试（foldFn 返回 undefined、null 时不抛异常且正常拼接药丸）', () => {
  const guidanceAssembler = require('../modules/vcpProtocolResilience/guidanceAssembler');
  const mockPill = guidanceAssembler.assembleHistoricalPill({ historicalErrors: [] });
  const validPillFloor = [
    'Prose content before pill',
    '<<<[ROLE_DIVIDE_USER]>>>',
    mockPill,
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  // 1. foldFn 返回 undefined 时不抛出 TypeError，且正常拼接药丸
  assert.doesNotThrow(() => {
    const foldedUndef = foldWithPillIfPresent(validPillFloor, () => undefined);
    assert.equal(typeof foldedUndef, 'string', '返回值必须为 string');
    assert.ok(foldedUndef.includes(mockPill), '必须正常拼接纯净药丸');
    assert.ok(foldedUndef.includes('<<<[ROLE_DIVIDE_USER]>>>'), '药丸外壳必须存在');
    assert.ok(foldedUndef.includes('<<<[END_ROLE_DIVIDE_USER]>>>'), '药丸外壳必须闭合');
  }, 'foldFn 返回 undefined 时绝不抛出 TypeError 崩溃');

  // 2. foldFn 返回 null 时不抛出 TypeError，且正常拼接药丸
  assert.doesNotThrow(() => {
    const foldedNull = foldWithPillIfPresent(validPillFloor, () => null);
    assert.equal(typeof foldedNull, 'string', '返回值必须为 string');
    assert.ok(foldedNull.includes(mockPill), '必须正常拼接纯净药丸');
    assert.ok(foldedNull.includes('<<<[ROLE_DIVIDE_USER]>>>'), '药丸外壳必须存在');
  }, 'foldFn 返回 null 时绝不抛出 TypeError 崩溃');

  // 3. 无药纯文本且 foldFn 返回 undefined 时，安全返回空字符串
  const plainText = 'Plain text without pill';
  const foldedPlain = foldWithPillIfPresent(plainText, () => undefined);
  assert.equal(foldedPlain, '', '无药纯文本 foldFn 返回 undefined 时安全退化为空字符串');

  // 4. 包装在消息对象中时，foldFn 返回 undefined 同样保持对象容器且拼接药丸
  const msgObj = { role: 'assistant', content: validPillFloor, id: 'f30-msg' };
  const foldedMsg = foldWithPillIfPresent(msgObj, () => undefined);
  assert.equal(typeof foldedMsg, 'object', '返回对象容器结构');
  assert.equal(foldedMsg.id, 'f30-msg');
  assert.ok(foldedMsg.content.includes(mockPill), '消息内容中拼接药丸');
});

// =========================================================================
// F31: 【BUG-R4-02】消息对象 content === '' 空文本结构保持测试
// =========================================================================

test('F31: 【BUG-R4-02】消息对象 content === \'\' 空文本结构保持测试', () => {
  const metaSymbol = Symbol('metaKey');
  const emptyMsg = {
    role: 'assistant',
    content: '',
    metaId: 'empty-msg-001',
    timestamp: 123456789,
    [metaSymbol]: 'symbolData'
  };

  // 1. foldWithPillIfPresent 针对 content === '' 维持消息对象容器与元数据，绝不退化拍扁为 String
  const folded = foldWithPillIfPresent(emptyMsg, '折叠空消息摘要');
  assert.equal(typeof folded, 'object', '必须保持消息对象结构，绝不退化拍扁为 String');
  assert.equal(folded.role, 'assistant', 'role 保持不变');
  assert.equal(folded.metaId, 'empty-msg-001', '自定义 metaId 元数据 100% 保持');
  assert.equal(folded.timestamp, 123456789, '时间戳元数据 100% 保持');
  assert.equal(folded[metaSymbol], 'symbolData', 'Symbol 元数据 100% 保持');
  assert.equal(folded.content, '折叠空消息摘要', 'content 被正确折叠替换');

  // 2. options.enabled = false 时同样必须维持消息对象容器
  const foldedDisabled = foldWithPillIfPresent(emptyMsg, '退化摘要', { enabled: false });
  assert.equal(typeof foldedDisabled, 'object', '门控关闭时同样必须保持消息对象结构');
  assert.equal(foldedDisabled.metaId, 'empty-msg-001');
  assert.equal(foldedDisabled.content, '退化摘要');
  assert.equal(foldedDisabled[metaSymbol], 'symbolData');

  // 3. stripResilienceMarkers 针对 content === '' 维持消息对象容器
  const stripped = stripResilienceMarkers(emptyMsg);
  assert.equal(typeof stripped, 'object', 'stripResilienceMarkers 保持空文本消息对象结构');
  assert.equal(stripped.metaId, 'empty-msg-001');
  assert.equal(stripped.content, '');
  assert.equal(stripped[metaSymbol], 'symbolData');

  // 4. extractTopLevelPillEnvelope 针对 content === '' 返回 safe default
  const pillInfo = extractTopLevelPillEnvelope(emptyMsg);
  assert.equal(pillInfo.hasPill, false, '空文本消息对象 hasPill 为 false');
  assert.equal(pillInfo.shouldSkipFolding, false, '空文本消息对象 shouldSkipFolding 为 false');
  assert.equal(pillInfo.hasMalformedPill, false, '空文本消息对象 hasMalformedPill 为 false');
});

// =========================================================================
// F32: 【BUG-R4-03】extractTopLevelPillEnvelope 多外壳时序对抗（Valid 在前、Malformed 在后，100% 触发 P6 失败安全 shouldSkipFolding: true）
// =========================================================================

test('F32: 【BUG-R4-03】extractTopLevelPillEnvelope 多外壳时序对抗（Valid 在前、Malformed 在后，100% 触发 P6 失败安全 shouldSkipFolding: true）', () => {
  const validPill = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '【VCP 工具调用协议规范】',
    '合法药丸规范正文第 1 段。',
    '【/VCP 工具调用协议规范】',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  const malformedPill = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '【VCP 工具调用协议规范】',
    '残损药丸只有开标没有闭标……',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  // 1. Valid 在前，Malformed 在后：严禁被外壳 1 短路绕过！
  const validFirstMalformedSecond = `${validPill}\n\n中间散文解释\n\n${malformedPill}`;

  const info1 = extractTopLevelPillEnvelope(validFirstMalformedSecond);
  assert.equal(info1.hasPill, false, '存在残损外壳时 hasPill 必须为 false');
  assert.equal(info1.hasMalformedPill, true, '识别为残损药丸');
  assert.equal(info1.shouldSkipFolding, true, '必须 100% 触发 P6 失败安全 shouldSkipFolding: true，杜绝被外壳 1 短路绕过！');

  assert.equal(isProtocolGuidancePill(validFirstMalformedSecond), false, 'isProtocolGuidancePill 必须返回 false');

  const folded1 = foldWithPillIfPresent(validFirstMalformedSecond, 'Should not fold summary');
  assert.equal(folded1, validFirstMalformedSecond, 'Valid 在前 Malformed 在后必须触发 P6 失败安全，100% 原样直通返回，跳过折叠');

  // 2. Malformed 在前，Valid 在后：同样严格触发 P6 失败安全
  const malformedFirstValidSecond = `${malformedPill}\n\n中间散文解释\n\n${validPill}`;

  const info2 = extractTopLevelPillEnvelope(malformedFirstValidSecond);
  assert.equal(info2.hasPill, false, 'Malformed 在前时 hasPill 同样为 false');
  assert.equal(info2.hasMalformedPill, true, 'Malformed 在前识别为残损药丸');
  assert.equal(info2.shouldSkipFolding, true, 'Malformed 在前 100% 触发 P6 失败安全 shouldSkipFolding: true');

  const folded2 = foldWithPillIfPresent(malformedFirstValidSecond, 'Should not fold summary');
  assert.equal(folded2, malformedFirstValidSecond, 'Malformed 在前 Valid 在后同样 100% 原样直通返回');
});

// =========================================================================
// F33: 【BUG-R4-04】ROLE_DIVIDE_USER 自身截断未闭合且含药丸开标时触发 P6 失败安全 shouldSkipFolding: true
// =========================================================================

test('F33: 【BUG-R4-04】ROLE_DIVIDE_USER 自身截断未闭合且含药丸开标时触发 P6 失败安全 shouldSkipFolding: true', () => {
  const historyCleanse = require('../modules/vcpProtocolResilience/historyCleanse');

  // 1. 构造由于流中断或 max_tokens 截断导致 <<<[ROLE_DIVIDE_USER]>>> 未闭合且含药丸开标的内容
  const truncatedStream = [
    '这是流式输出或 max_tokens 截断的回复：',
    '<<<[ROLE_DIVIDE_USER]>>>',
    '【VCP 工具调用协议规范】',
    '正文输出到一半被硬截断……'
  ].join('\n');

  // 验证前提：findRoleDivideUserEnvelopes 返回空数组（因为缺失 END_TAG）
  const envelopes = historyCleanse.findRoleDivideUserEnvelopes(truncatedStream);
  assert.equal(envelopes.length, 0, 'findRoleDivideUserEnvelopes 因外壳未闭合返回空数组');

  // 核心断言：extractTopLevelPillEnvelope 触发外壳截断校验，返回 shouldSkipFolding: true
  const infoTrunc = extractTopLevelPillEnvelope(truncatedStream);
  assert.equal(infoTrunc.hasMalformedPill, true, '外壳截断且含药丸开标必须识别为残损');
  assert.equal(infoTrunc.shouldSkipFolding, true, '外壳截断且含药丸开标必须触发 shouldSkipFolding: true');
  assert.equal(infoTrunc.hasPill, false, 'hasPill 必须为 false');

  assert.equal(isProtocolGuidancePill(truncatedStream), false, 'isProtocolGuidancePill 返回 false');

  // foldWithPillIfPresent 必须 100% 原样直通返回截断原文，绝不吞噬抹杀截断原文
  const foldedTrunc = foldWithPillIfPresent(truncatedStream, 'Should not fold this stream');
  assert.equal(foldedTrunc, truncatedStream, '触发 P6 失败安全，100% 原样直通返回截断原文，绝不吞噬抹杀！');

  // 2. 合法外壳后跟随未闭合截断外壳复合对抗
  const validPill = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '【VCP 工具调用协议规范】',
    '第一轮完整合法药丸。',
    '【/VCP 工具调用协议规范】',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  const validFollowedByTruncated = `${validPill}\n\n${truncatedStream}`;
  const infoValidPlusTrunc = extractTopLevelPillEnvelope(validFollowedByTruncated);
  assert.equal(infoValidPlusTrunc.shouldSkipFolding, true, '合法外壳后跟随未闭合截断外壳时同样触发 P6 失败安全');
  assert.equal(infoValidPlusTrunc.hasPill, false, '复合截断时 hasPill 为 false');
  assert.equal(foldWithPillIfPresent(validFollowedByTruncated, 'Should not fold'), validFollowedByTruncated, '复合截断原样直通');

  // 3. 不含药丸开标的普通未闭合外壳不应被误判为药丸残损
  const plainTruncated = [
    '普通对话截断：',
    '<<<[ROLE_DIVIDE_USER]>>>',
    '普通用户输入输出到一半被截断'
  ].join('\n');
  const infoPlain = extractTopLevelPillEnvelope(plainTruncated);
  assert.equal(infoPlain.hasMalformedPill, false, '不含药丸开标的普通外壳截断不标记为残损药丸');
});


// =========================================================================
// F34: 【BUG-R5-01】倒置闭标前置时未闭合外壳截断校验依然触发 P6 失败安全（shouldSkipFolding: true）
// =========================================================================

test('F34: 【BUG-R5-01】倒置闭标前置时未闭合外壳截断校验依然触发 P6 失败安全（shouldSkipFolding: true）', () => {
  const historyCleanse = require('../modules/vcpProtocolResilience/historyCleanse');

  // 1. 构造前置倒置/孤立 <<<[END_ROLE_DIVIDE_USER]>>>，后随未闭合且含药丸开标的 <<<[ROLE_DIVIDE_USER]>>>
  // 在修复前，openPositions.length === 1, closePositions.length === 1，
  // openPositions.length > closePositions.length 为 false，导致 Phase 1.1 截断巡检被彻底绕过！
  const invertedAndTruncated = [
    '<<<[END_ROLE_DIVIDE_USER]>>>',
    '历史残留的孤立倒置闭标',
    '<<<[ROLE_DIVIDE_USER]>>>',
    '【VCP 工具调用协议规范】',
    '这是流式输出或 max_tokens 截断的未闭合药丸内容……'
  ].join('\n');

  // 验证前提：findRoleDivideUserEnvelopes 返回空数组（因为闭标在前、开标在后，无法配对成封闭外壳）
  const envelopes = historyCleanse.findRoleDivideUserEnvelopes(invertedAndTruncated);
  assert.equal(envelopes.length, 0, '无法配对为封闭外壳，envelopes.length 必须为 0');

  // 核心断言：extractTopLevelPillEnvelope 基于 unclosedStarts 判定，100% 触发 P6 失败安全
  const info = extractTopLevelPillEnvelope(invertedAndTruncated);
  assert.equal(info.hasMalformedPill, true, '倒置闭标前置时的外壳截断必须识别为残损');
  assert.equal(info.shouldSkipFolding, true, '必须 100% 触发 P6 失败安全 shouldSkipFolding: true');
  assert.equal(info.hasPill, false, 'hasPill 必须为 false');

  assert.equal(isProtocolGuidancePill(invertedAndTruncated), false, 'isProtocolGuidancePill 必须返回 false');

  // foldWithPillIfPresent 必须 100% 原样直通返回，严禁吞噬截断原文
  const folded = foldWithPillIfPresent(invertedAndTruncated, 'Should not fold inverted truncated stream');
  assert.equal(folded, invertedAndTruncated, '必须 100% 原样直通返回，杜绝折叠吞噬！');

  // 2. 多个倒置闭标与截断外壳对抗场景
  const multiInverted = [
    '<<<[END_ROLE_DIVIDE_USER]>>>',
    '<<<[END_ROLE_DIVIDE_USER]>>>',
    '<<<[ROLE_DIVIDE_USER]>>>',
    '【VCP 工具调用协议规范】',
    '多闭单开硬截断'
  ].join('\n');
  const infoMulti = extractTopLevelPillEnvelope(multiInverted);
  assert.equal(infoMulti.shouldSkipFolding, true, '多闭单开硬截断依然 100% 触发 P6 失败安全');
  assert.equal(foldWithPillIfPresent(multiInverted, 'Fold text'), multiInverted, '多闭单开硬截断原样直通');
});

// =========================================================================
// F35: 【BUG-R5-02】未闭合外壳内包含残损闭标时触发 P6 失败安全
// =========================================================================

test('F35: 【BUG-R5-02】未闭合外壳内包含残损闭标时触发 P6 失败安全', () => {
  const historyCleanse = require('../modules/vcpProtocolResilience/historyCleanse');

  // 1. 构造未闭合外壳内仅出现孤立残损闭标（如 【/VCP 工具调用协议规范】 或 [／VCP 工具调用协议规范]）
  const truncatedWithClosingPill = [
    '这是未闭合外壳内包含孤立残损闭标的异常输出：',
    '<<<[ROLE_DIVIDE_USER]>>>',
    '部分正文回复内容……',
    '【/VCP 工具调用协议规范】',
    '输出截断，缺失外壳闭标'
  ].join('\n');

  // 验证前提：findRoleDivideUserEnvelopes 为 0
  const envelopes = historyCleanse.findRoleDivideUserEnvelopes(truncatedWithClosingPill);
  assert.equal(envelopes.length, 0, '未闭合外壳无法形成 envelope');

  // 核心断言：PILL_ANY_TAG_REGEX 扫描未闭合外壳，检测到孤立闭标，100% 触发 P6 失败安全
  const info = extractTopLevelPillEnvelope(truncatedWithClosingPill);
  assert.equal(info.hasMalformedPill, true, '未闭合外壳内包含孤立闭标必须识别为残损');
  assert.equal(info.shouldSkipFolding, true, '必须 100% 触发 P6 失败安全 shouldSkipFolding: true');
  assert.equal(info.hasPill, false, 'hasPill 必须为 false');

  assert.equal(isProtocolGuidancePill(truncatedWithClosingPill), false, 'isProtocolGuidancePill 必须返回 false');

  // foldWithPillIfPresent 必须 100% 原样直通返回
  const folded = foldWithPillIfPresent(truncatedWithClosingPill, 'Should not fold malformed closing tag');
  assert.equal(folded, truncatedWithClosingPill, '未闭合外壳含孤立闭标必须原样直通返回，严禁折叠吞噬');

  // 2. 变体闭标测试：[/VCP协议规范]、[／VCP 工具调用协议规范]
  const variantClosing = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '变体闭标截断',
    '[/VCP协议规范]'
  ].join('\n');
  const infoVariant = extractTopLevelPillEnvelope(variantClosing);
  assert.equal(infoVariant.shouldSkipFolding, true, '变体闭标在未闭合外壳内同样 100% 触发 P6 失败安全');
});

// =========================================================================
// F36: 【BUG-R5-03】EMPTY_BATCH_ENVELOPE_REGEX 与 EMPTY_ROLE_DIVIDE_REGEX 单换行对称性与 TextSanitizer SHA-256 零分裂
// =========================================================================

test('F36: 【BUG-R5-03】EMPTY_BATCH_ENVELOPE_REGEX 与 EMPTY_ROLE_DIVIDE_REGEX 单换行对称性与 TextSanitizer SHA-256 零分裂', () => {
  const TextSanitizer = require('../Plugin/RAGDiaryPlugin/TextSanitizer');

  const prefix = '第一段业务业务正文。';
  const suffix = '第二段业务业务正文。';

  // 单工具药丸拔除后留下的空外壳（紧凑单换行 \n 排版）
  const singlePillEmptyEnvelope = `${prefix}\n<<<[ROLE_DIVIDE_USER]>>>\n<<<[END_ROLE_DIVIDE_USER]>>>\n${suffix}`;

  // 批次错误擦除后留下的纯空批次外壳（紧凑单换行 \n 排版）
  const batchEmptyEnvelope = `${prefix}\n<<<[ROLE_DIVIDE_USER]>>>\n<<<[VCP_TOOL_BATCH_START:tool_call_001]>>>\n<<<[VCP_TOOL_BATCH_END:tool_call_001]>>>\n<<<[END_ROLE_DIVIDE_USER]>>>\n${suffix}`;

  // 2. stripResilienceMarkers 剥离结果逐字节恒等断言
  const strippedSingle = stripResilienceMarkers(singlePillEmptyEnvelope);
  const strippedBatch = stripResilienceMarkers(batchEmptyEnvelope);

  assert.equal(strippedSingle, strippedBatch, '单工具空外壳与批次空外壳剥离后必须逐字节恒等，杜绝换行吸收不对称');

  // 3. 真实 TextSanitizer.sanitizeForEmbedding 与 SHA-256 零分裂验证
  const sanitizedSingle = TextSanitizer.sanitizeForEmbedding(singlePillEmptyEnvelope);
  const sanitizedBatch = TextSanitizer.sanitizeForEmbedding(batchEmptyEnvelope);

  assert.equal(sanitizedSingle, sanitizedBatch, 'TextSanitizer 净化后结果必须逐字节恒等');

  const hashSingle = crypto.createHash('sha256').update(sanitizedSingle).digest('hex');
  const hashBatch = crypto.createHash('sha256').update(sanitizedBatch).digest('hex');

  assert.equal(hashSingle, hashBatch, '单外壳与批次空外壳经净化后的 SHA-256 哈希值必须 100% 一致，零 1 字节抖动');
});

// =========================================================================
// F37: 【BUG-R5-04】全角中括号 ［...］ 药丸识别、剥离与 P6 失败安全全覆盖
// =========================================================================

test('F37: 【BUG-R5-04】全角中括号 ［...］ 药丸识别、剥离与 P6 失败安全全覆盖', () => {
  const historyCleanse = require('../modules/vcpProtocolResilience/historyCleanse');

  // 1. 构造使用 Unicode 全角中括号［与］（\uFF3B 与 \uFF3D）包围的合法药丸
  const fullwidthPillContent = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '［系统提示：］［VCP 工具调用协议规范］',
    '### 一、强制调用格式',
    '每次必须使用规范工具格式。',
    '［／VCP 工具调用协议规范］',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  // 1.1 extractTopLevelPillEnvelope 正确识别全角药丸
  const info = extractTopLevelPillEnvelope(fullwidthPillContent);
  assert.equal(info.hasPill, true, '必须成功识别全角中括号［...］药丸');
  assert.equal(info.hasMalformedPill, false, '合法全角药丸不应标记为残损');
  assert.equal(info.shouldSkipFolding, false, '合法全角药丸 shouldSkipFolding 必须为 false');
  assert.match(info.pillText, /［系统提示：］［VCP 工具调用协议规范］/, 'pillText 完整包含全角开标');
  assert.match(info.pillText, /［／VCP 工具调用协议规范］/, 'pillText 完整包含全角闭标');

  // 1.2 isProtocolGuidancePill 支持全角中括号
  assert.equal(isProtocolGuidancePill(fullwidthPillContent), true, 'isProtocolGuidancePill 必须返回 true');

  // 1.3 stripResilienceMarkers 彻底剥离全角药丸并清除空外壳
  const stripped = stripResilienceMarkers(fullwidthPillContent);
  assert.equal(stripped, '', '全角中括号药丸必须被 100% 干净剥离，不留任何残渣');

  // 1.4 historyCleanse.js 中 PILL_TEST_REGEX 覆盖断言
  assert.equal(historyCleanse.hasSystemPillInText(fullwidthPillContent), true, 'historyCleanse hasSystemPillInText 必须识别全角药丸');

  // 2. 全角中括号残缺药丸（有开无闭）P6 失败安全断言
  const malformedFullwidth = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '［系统提示：］［VCP 工具调用协议规范］',
    '未闭合的全角协议规范……',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  const malformedInfo = extractTopLevelPillEnvelope(malformedFullwidth);
  assert.equal(malformedInfo.hasMalformedPill, true, '全角中括号残缺药丸必须识别为残损');
  assert.equal(malformedInfo.shouldSkipFolding, true, '全角残缺药丸必须触发 shouldSkipFolding: true');
  assert.equal(malformedInfo.hasPill, false, 'hasPill 必须为 false');

  const foldedMalformed = foldWithPillIfPresent(malformedFullwidth, 'Should not fold malformed');
  assert.equal(foldedMalformed, malformedFullwidth, '全角残缺药丸触发 P6 失败安全，100% 原样直通返回');

  // 3. 全角中括号在未闭合外壳内硬截断对抗
  const unclosedEnvelopeFullwidth = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '［VCP 工具调用协议规范］',
    '外壳与全角药丸双重截断'
  ].join('\n');
  const unclosedInfo = extractTopLevelPillEnvelope(unclosedEnvelopeFullwidth);
  assert.equal(unclosedInfo.shouldSkipFolding, true, '未闭合外壳中的全角药丸必须触发 shouldSkipFolding: true');
  assert.equal(foldWithPillIfPresent(unclosedEnvelopeFullwidth, 'No fold'), unclosedEnvelopeFullwidth, '双重截断原样直通');
});

// =========================================================================
// F38: 【BUG-R6-01】前置未闭合外壳吞噬校验与 P6 失败安全（防业务内容折叠抹除）
// =========================================================================

test('F38: 【BUG-R6-01】前置未闭合外壳吞噬校验与 P6 失败安全（防业务内容折叠抹除）', () => {
  // 场景：前置未闭合业务外壳，后随正常闭合的药丸外壳
  // 若无吞噬防御，findRoleDivideUserEnvelopes 会将前置未闭合 START_TAG 与后置 END_TAG 错误配对，
  // 形成超大 envelope 吞噬中间的第二个 START_TAG，导致 isInsideClosedEnv 误判为 true 穿透截断检查，
  // 进而导致未闭合的业务内容在折叠时被静默抹杀。
  const unclosedBusinessBeforePill = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '重要业务未完成数据：交易订单号 8848123456789，状态待确认……',
    '<<<[ROLE_DIVIDE_USER]>>>',
    '【VCP 工具调用协议规范】',
    '### 一、强制调用格式',
    '必须使用标准工具调用语法。',
    '【/VCP 工具调用协议规范】',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  // 1. extractTopLevelPillEnvelope 必须精确识别到外壳吞噬与不平衡，标记为残损并跳过折叠
  const info = extractTopLevelPillEnvelope(unclosedBusinessBeforePill);
  assert.equal(info.hasPill, false, '存在吞噬未闭合外壳时 hasPill 必须为 false');
  assert.equal(info.hasMalformedPill, true, '识别为残损药丸');
  assert.equal(info.shouldSkipFolding, true, '必须 100% 触发 P6 失败安全 shouldSkipFolding: true');

  // 2. isProtocolGuidancePill 必须返回 false
  assert.equal(isProtocolGuidancePill(unclosedBusinessBeforePill), false, '外壳吞噬状态下 isProtocolGuidancePill 必须返回 false');

  // 3. foldWithPillIfPresent 必须 100% 原样直通返回，严禁抹除前置未闭合业务数据
  const folded = foldWithPillIfPresent(unclosedBusinessBeforePill, 'Should not fold summary');
  assert.equal(folded, unclosedBusinessBeforePill, '必须触发 P6 失败安全，100% 原样直通返回，防业务内容被折叠抹除');
});

// =========================================================================
// F39: 【BUG-R6-02】含药外壳未闭合且后随封闭外壳时 100% 触发 P6 失败安全
// =========================================================================

test('F39: 【BUG-R6-02】含药外壳未闭合且后随封闭外壳时 100% 触发 P6 失败安全', () => {
  // 场景：前置含药外壳发生截断（缺失 END_TAG），后随一个封闭的独立外壳（如独立工具日志或业务外壳）
  // 两个 START_TAG，但只有一个 END_TAG。findRoleDivideUserEnvelopes 会跨越配对，
  // 必须通过 hasUnbalancedEnvelopes 与 hasSwallowedEnvelopes 100% 触发 P6 失败安全。
  const unclosedPillBeforeClosedEnvelope = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '【VCP 工具调用协议规范】',
    '药丸正文未闭合外壳……',
    '<<<[ROLE_DIVIDE_USER]>>>',
    '后置独立业务工具结果数据：用户账户余额 5000 元',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  // 1. extractTopLevelPillEnvelope 判定
  const info = extractTopLevelPillEnvelope(unclosedPillBeforeClosedEnvelope);
  assert.equal(info.hasPill, false, '含药外壳未闭合时 hasPill 必须为 false');
  assert.equal(info.hasMalformedPill, true, '标记为残损药丸');
  assert.equal(info.shouldSkipFolding, true, '必须 100% 触发 P6 失败安全 shouldSkipFolding: true');

  // 2. isProtocolGuidancePill 判定
  assert.equal(isProtocolGuidancePill(unclosedPillBeforeClosedEnvelope), false, 'isProtocolGuidancePill 返回 false');

  // 3. foldWithPillIfPresent 验证：绝不折叠，原样直通返回
  const folded = foldWithPillIfPresent(unclosedPillBeforeClosedEnvelope, 'Should not fold summary');
  assert.equal(folded, unclosedPillBeforeClosedEnvelope, '含药外壳截断后随封闭外壳必须 100% 原样直通返回');
});

// =========================================================================
// F40: 【BUG-R6-03】多模态数组后置图片分片时与 roleDivider.process 端到端切分严格保持 2 条消息契约 [assistant, user]
// =========================================================================

test('F40: 【BUG-R6-03】多模态数组后置图片分片时与 roleDivider.process 端到端切分严格保持 2 条消息契约 [assistant, user]', () => {
  const mockPill = guidanceAssembler.assembleHistoricalPill({ historicalErrors: [] });
  const pillTextEnvelope = `<<<[ROLE_DIVIDE_USER]>>>\n${mockPill}\n<<<[END_ROLE_DIVIDE_USER]>>>`;

  // 构造多模态数组：文本在首位（含药丸与散文），图片分片排在文本之后（后置媒体分片）
  const multiModalWithTrailingImage = [
    {
      type: 'text',
      text: '分析完成，以下为图表分析：\n' + pillTextEnvelope,
      cache_control: { type: 'ephemeral' }
    },
    {
      type: 'image_url',
      image_url: { url: 'https://example.com/chart.png' }
    }
  ];

  const summaryText = '[VCP上下文语义折叠-本层摘要: 助手对图表进行了综合分析。]';
  const folded = foldWithPillIfPresent(multiModalWithTrailingImage, summaryText);

  // 1. 验证折叠后的数组分片结构：
  // [0] 为摘要文本分片（仅含 foldedSummary，无 ROLE_DIVIDE_USER 壳，继承 cache_control）
  // [1] 为原始图片分片
  // [2] 为独立追加在末尾的纯净药丸外壳文本分片
  assert.ok(Array.isArray(folded), '返回结果为数组');
  assert.equal(folded.length, 3, '结构为 3 个分片（摘要 + 图片 + 独立药丸）');

  assert.equal(folded[0].type, 'text');
  assert.equal(folded[0].text, summaryText, '首分片仅填入折叠摘要');
  assert.deepEqual(folded[0].cache_control, { type: 'ephemeral' }, '首分片继承 cache_control');
  assert.ok(!folded[0].text.includes('<<<[ROLE_DIVIDE_USER]>>>'), '首分片严禁包含 ROLE_DIVIDE_USER');

  assert.equal(folded[1].type, 'image_url');
  assert.deepEqual(folded[1].image_url, { url: 'https://example.com/chart.png' }, '中间非文本分片原样保留');

  assert.equal(folded[2].type, 'text');
  assert.ok(folded[2].text.startsWith('<<<[ROLE_DIVIDE_USER]>>>'), '末尾独立分片为干净药丸外壳');
  assert.ok(folded[2].text.endsWith('<<<[END_ROLE_DIVIDE_USER]>>>'));
  assert.ok(folded[2].text.includes('【VCP 工具调用协议规范】'));

  // 2. 模拟下游发送消息，送入真实的 roleDivider.process 验证切分契约
  const assistantMsg = {
    role: 'assistant',
    content: folded
  };
  const splitMessages = roleDivider.process([assistantMsg]);

  // 核心断言：严格切分为 2 条消息 [assistant, user]，绝不切分为 3 条违规的 [assistant, user, assistant]！
  assert.equal(splitMessages.length, 2, '必须严格达成 2 条消息契约');

  // 第 1 条消息必须为 assistant，其 content 完整包含摘要文本与图片媒体
  assert.equal(splitMessages[0].role, 'assistant');
  assert.ok(Array.isArray(splitMessages[0].content), 'assistant content 为多模态数组');
  assert.equal(splitMessages[0].content.length, 2, 'assistant content 包含摘要与图片 2 个分片');
  assert.equal(splitMessages[0].content[0].type, 'text');
  assert.equal(splitMessages[0].content[0].text, summaryText);
  assert.equal(splitMessages[0].content[1].type, 'image_url');
  assert.deepEqual(splitMessages[0].content[1].image_url, { url: 'https://example.com/chart.png' });

  // 第 2 条消息必须为 user，包含纯净药丸文本（绝无 ROLE_DIVIDE_USER 外壳标签残留）
  assert.equal(splitMessages[1].role, 'user');
  assert.ok(splitMessages[1].content.includes('【VCP 工具调用协议规范】'), 'user 消息包含系统提示药丸');
  assert.ok(!splitMessages[1].content.includes('<<<[ROLE_DIVIDE_USER]>>>'), 'user 消息无开标残留');
  assert.ok(!splitMessages[1].content.includes('<<<[END_ROLE_DIVIDE_USER]>>>'), 'user 消息无闭标残留');
});



// =========================================================================
// F41: 【BUG-R7-01】正常工具输出包含协议规范文档时防误报、防篡改与三态逐字节恒等
// =========================================================================

test('F41: 【BUG-R7-01】正常工具输出包含协议规范文档时防误报、防篡改与三态逐字节恒等', () => {
  const TextSanitizer = require('../Plugin/RAGDiaryPlugin/TextSanitizer');

  const pillDoc = [
    '[系统提示:] 【VCP 工具调用协议规范】',
    '标准协议格式说明正文，包含各类协议细节与防错规范。',
    '【/VCP 工具调用协议规范】'
  ].join('\n');

  const readFileEnvelope = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '<<<[VCP_TOOL_BATCH_START:2026-11-22T05:00:00.000+08:00]>>>',
    '[[VCP调用结果信息汇总:',
    '- 工具名称: ReadFile',
    '- 执行状态: ✅ SUCCESS',
    '- 返回内容:',
    pillDoc,
    'VCP调用结果结束]]',
    '<<<[VCP_TOOL_BATCH_SUMMARY]>>>',
    '- ReadFile: 成功读取技术开发文档。',
    '<<<[END_VCP_TOOL_BATCH_SUMMARY]>>>',
    '<<<[VCP_TOOL_BATCH_END:2026-11-22T05:00:00.000+08:00]>>>',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  // 1. 验证 hasSystemPillInText 绝不发生假阳性误报
  assert.equal(hasSystemPillInText(readFileEnvelope), false, '正常工具保护区内的文档正文不被判定为系统药丸');

  // 2. 场景 A：Turn 1 纯文档读取，Turn 2 发生协议错误
  const badBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const fix = createErrorFixture(badBlock, 'MISSING_TOOL_NAME', { timestamp: '2026-11-22T05:05:00.000+08:00' });

  const turn1Content = `业务散文：已获取文档内容。\n${readFileEnvelope}\n业务分析完毕。`;
  const turn2Content = `业务散文开始。\n${badBlock}\n${fix.receipt}\n业务散文结束。`;

  // 状态 0：未洗原件态
  const msgsState0 = [
    { role: 'user', content: 'Turn 1 User: 请查看文档' },
    { role: 'assistant', content: turn1Content },
    { role: 'user', content: 'Turn 2 User: 执行工具' },
    { role: 'assistant', content: turn2Content },
    { role: 'user', content: 'Turn 3 User Active' }
  ];

  // 状态 1：单药态（cleanseHistory 清洗后）
  const cleansedMsgs = cleanseHistory(msgsState0);
  const turn1Cleansed = cleansedMsgs[1].content;
  const turn2Cleansed = cleansedMsgs[3].content;

  // 断言 Turn 1 文档正文 100% 完好无损，未被误设为活药层或篡改替换
  assert.ok(turn1Cleansed.includes(pillDoc), 'Turn 1 业务文档正文未被篡改');
  assert.equal(hasSystemPillInText(turn1Cleansed), false, 'Turn 1 清洗后依然不含系统药丸');
  assert.ok(turn2Cleansed.includes('【VCP 工具调用协议规范】'), 'Turn 2 错误层成功挂载唯一活药');

  // 状态 2：净化态 / 退药态（后续轮次新错误导致 Turn 2 药丸拔除）
  const badBlock2 = '<<<[TOOL_REQUEST]>>>\nmaid:「始」Nova2「末」\n<<<[END_TOOL_REQUEST]>>>';
  const fix2 = createErrorFixture(badBlock2, 'MISSING_TOOL_NAME', { timestamp: '2026-11-22T05:10:00.000+08:00' });
  const msgsState2 = [
    { role: 'user', content: 'Turn 1 User: 请查看文档' },
    { role: 'assistant', content: turn1Content },
    { role: 'user', content: 'Turn 2 User: 执行工具' },
    { role: 'assistant', content: turn2Content },
    { role: 'user', content: 'Turn 3 User: 再次执行' },
    { role: 'assistant', content: `散文\n${badBlock2}\n${fix2.receipt}` },
    { role: 'user', content: 'Turn 4 User Active' }
  ];
  const cleansedMsgs2 = cleanseHistory(msgsState2);
  const turn1State2 = cleansedMsgs2[1].content;

  assert.ok(turn1State2.includes(pillDoc), '状态 2 下 Turn 1 业务文档正文依然 100% 完好');

  // 3. 验证三态在 TextSanitizer 下逐字节恒等 san0 === san1 === san2
  const san0A = TextSanitizer.sanitizeForEmbedding(turn1Content, 'assistant');
  const san1A = TextSanitizer.sanitizeForEmbedding(turn1Cleansed, 'assistant');
  const san2A = TextSanitizer.sanitizeForEmbedding(turn1State2, 'assistant');

  assert.equal(san0A, san1A, '场景 A: 状态 0 与状态 1 经 TextSanitizer 净化后逐字节恒等');
  assert.equal(san1A, san2A, '场景 A: 状态 1 与状态 2 经 TextSanitizer 净化后逐字节恒等');
  assert.equal(sha256(san0A), sha256(san1A), '场景 A: 状态 0 与状态 1 SHA-256 哈希绝对一致');
  assert.equal(sha256(san1A), sha256(san2A), '场景 A: 状态 1 与状态 2 SHA-256 哈希绝对一致');

  // 4. 场景 B：混合批次内包含文档读取 + 格式错误（更严苛的 noPillMode 对抗测试）
  const mixedState0 = [
    '前言散文。',
    badBlock,
    '<<<[ROLE_DIVIDE_USER]>>>',
    '<<<[VCP_TOOL_BATCH_START:2026-11-22T05:20:00.000+08:00]>>>',
    '[[VCP调用结果信息汇总:',
    '- 工具名称: BadTool',
    '- 执行状态: ❌ ERROR',
    `- 返回内容: [[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=${fix.fp}]]`,
    '请修正参数！',
    '[[/VCP协议纠偏指导]]',
    'VCP调用结果结束]]',
    '[[VCP调用结果信息汇总:',
    '- 工具名称: ReadFile',
    '- 执行状态: ✅ SUCCESS',
    '- 返回内容:',
    pillDoc,
    'VCP调用结果结束]]',
    '<<<[VCP_TOOL_BATCH_SUMMARY]>>>',
    '- BadTool 格式错误（未执行）。',
    '- ReadFile: 成功读取。',
    '<<<[END_VCP_TOOL_BATCH_SUMMARY]>>>',
    '<<<[VCP_TOOL_BATCH_END:2026-11-22T05:20:00.000+08:00]>>>',
    '<<<[END_ROLE_DIVIDE_USER]>>>',
    '后语散文。'
  ].join('\n');

  const msgsMixed = [
    { role: 'user', content: 'Turn 1 Mixed' },
    { role: 'assistant', content: mixedState0 },
    { role: 'user', content: 'Turn 2 Active' }
  ];
  const mixedCleansed = cleanseHistory(msgsMixed);
  const mixedState1 = mixedCleansed[1].content;

  // 构造退药态
  const msgsMixedState2 = [
    { role: 'user', content: 'Turn 1 Mixed' },
    { role: 'assistant', content: mixedState0 },
    { role: 'user', content: 'Turn 2 User' },
    { role: 'assistant', content: `后续楼层\n${badBlock2}\n${fix2.receipt}` },
    { role: 'user', content: 'Turn 3 Active' }
  ];
  const mixedCleansed2 = cleanseHistory(msgsMixedState2);
  const mixedState2 = mixedCleansed2[1].content;

  // 验证混合批次清洗后文档正文完好
  assert.ok(mixedState1.includes(pillDoc), '混合批次状态 1 中业务文档正文完好');
  assert.ok(mixedState2.includes(pillDoc), '混合批次状态 2 中业务文档正文完好');

  // 验证混合批次三态在 TextSanitizer 下逐字节恒等
  const san0B = TextSanitizer.sanitizeForEmbedding(mixedState0, 'assistant');
  const san1B = TextSanitizer.sanitizeForEmbedding(mixedState1, 'assistant');
  const san2B = TextSanitizer.sanitizeForEmbedding(mixedState2, 'assistant');

  assert.equal(san0B, san1B, '场景 B (混合批次): 状态 0 与状态 1 经 TextSanitizer 净化后逐字节恒等');
  assert.equal(san1B, san2B, '场景 B (混合批次): 状态 1 与状态 2 经 TextSanitizer 净化后逐字节恒等');
  assert.equal(sha256(san0B), sha256(san1B), '场景 B (混合批次): 状态 0 与状态 1 SHA-256 绝对一致');
  assert.equal(sha256(san1B), sha256(san2B), '场景 B (混合批次): 状态 1 与状态 2 SHA-256 绝对一致');
});

// =========================================================================
// F42: 【BUG-R7-02】EMPTY_ERROR_INFO_REGEX 多空行容错与掏空错误块彻底剥离
// =========================================================================

test('F42: 【BUG-R7-02】EMPTY_ERROR_INFO_REGEX 多空行容错与掏空错误块彻底剥离', () => {
  const emptyBlock = [
    '[[VCP调用结果信息汇总:',
    '- 工具调用ID: call_error_123',
    '- 工具名称: MalformedTool',
    '- 执行状态: ❌ ERROR',
    '- 返回内容:',
    '',
    '',
    '',
    'VCP调用结果结束]]'
  ].join('\n');

  // 1. 独立纯掏空错误块剥离测试
  const strippedPure = stripResilienceMarkers(emptyBlock);
  assert.equal(strippedPure, '', '纯掏空错误块连同多余空行被彻底清除为空字符串');

  // 2. 嵌入在前后段落散文中的掏空错误块剥离测试
  const withProse = `业务前言散文。\n\n${emptyBlock}\n\n业务后置散文。`;
  const stripped = stripResilienceMarkers(withProse);

  // 核心断言：掏空错误块连同多余空行被彻底剥离，绝不残留 ❌ ERROR
  assert.ok(!stripped.includes('❌ ERROR'), '执行状态 ❌ ERROR 被彻底剥离');
  assert.ok(!stripped.includes('[[VCP调用结果信息汇总:'), '汇总块开标被彻底剥离');
  assert.ok(!stripped.includes('VCP调用结果结束]]'), '汇总块闭标被彻底剥离');
  assert.equal(stripped, '业务前言散文。\n\n业务后置散文。', '多余空行被优雅收敛，前后散文完好保留');
});

// =========================================================================
// F43: 【BUG-R7-03】foldWithPillIfPresent 回调异常捕获与 P6 失败安全
// =========================================================================

test('F43: 【BUG-R7-03】foldWithPillIfPresent 回调异常捕获与 P6 失败安全', () => {
  const mockPill = guidanceAssembler.assembleHistoricalPill({ historicalErrors: [] });
  const rawPillText = `分析完毕。\n<<<[ROLE_DIVIDE_USER]>>>\n${mockPill}\n<<<[END_ROLE_DIVIDE_USER]>>>`;

  // 1. 构造一个在调用时主动抛出严重异常的 foldFn 回调
  const explosiveFoldFn = () => {
    throw new Error('AI Model Out Of Memory');
  };

  // 2. 在默认门控开启状态下调用 foldWithPillIfPresent
  assert.doesNotThrow(() => {
    const folded = foldWithPillIfPresent(rawPillText, explosiveFoldFn);
    // 验证安全兜底：不崩溃，且由于包含药丸，兜底保留干净的药丸外壳
    assert.ok(typeof folded === 'string');
    assert.ok(folded.includes('<<<[ROLE_DIVIDE_USER]>>>'));
    assert.ok(folded.includes('【VCP 工具调用协议规范】'));
    assert.ok(folded.includes('<<<[END_ROLE_DIVIDE_USER]>>>'));
  }, 'summaryOrFoldFn 抛出异常时 foldWithPillIfPresent 安全兜底不崩溃');

  // 3. 验证 options.enabled = false 门控关闭时同样安全兜底不崩溃
  assert.doesNotThrow(() => {
    const foldedDisabled = foldWithPillIfPresent('普通文本内容', explosiveFoldFn, { enabled: false });
    assert.equal(foldedDisabled, '', '门控关闭且回调异常时安全兜底返回空字符串');
  }, '门控关闭时回调异常同样安全兜底');

  // 4. 验证多模态消息对象包裹场景下同样安全容灾
  const wrappedMsg = {
    role: 'assistant',
    content: rawPillText
  };
  assert.doesNotThrow(() => {
    const foldedMsg = foldWithPillIfPresent(wrappedMsg, explosiveFoldFn);
    assert.equal(typeof foldedMsg, 'object');
    assert.equal(foldedMsg.role, 'assistant');
    assert.ok(foldedMsg.content.includes('<<<[ROLE_DIVIDE_USER]>>>'));
  }, '消息对象包裹场景下回调异常同样安全容灾');
});


// =========================================================================
// F44: 【BUG-R7-02-B】EMPTY_ERROR_INFO_REGEX 严禁误伤单行真实业务工具报错
// =========================================================================

test('F44: 【BUG-R7-02-B】EMPTY_ERROR_INFO_REGEX 严禁误伤单行真实业务工具报错', () => {
  const normalSingleLineError = [
    '[[VCP调用结果信息汇总:',
    '- 工具名称: NormalTool',
    '- 执行状态: ❌ ERROR',
    '- 返回内容: Permission denied: /etc/shadow',
    'VCP调用结果结束]]'
  ].join('\n');

  const stripped = stripResilienceMarkers(normalSingleLineError);
  assert.ok(stripped.includes('Permission denied: /etc/shadow'), '单行业务真实报错被完整保留');
  assert.ok(stripped.includes('NormalTool'), '工具名称元数据完好保留');
});

// =========================================================================
// F45: 【Auto-R6 P1-2】ReadFile 含未闭字面药丸标题时等长空白掩码根除跨界桥接吞噬真实药丸
// =========================================================================

test('F45: 【Auto-R6 P1-2】ReadFile 含字面【VCP 工具调用协议规范】混合批次正常提取折叠与三态逐字节恒等', () => {
  const literalDocLine = '规范说明示例：【VCP 工具调用协议规范】注意此处无闭合尾标。';
  const badBlock = '<<<[TOOL_REQUEST]>>>\nmaid:「始」Nova「末」\n<<<[END_TOOL_REQUEST]>>>';
  const errMap = resilienceModule.extractHistoricalErrorBlocks(badBlock);
  const fp = Array.from(errMap.keys())[0];
  const realPill = guidanceAssembler.assembleHistoricalPill({ historicalErrors: ['MISSING_TOOL_NAME'] });

  const makeMixedEnvelope = (innerMiddle) => [
    '业务分析前置说明。',
    '<<<[ROLE_DIVIDE_USER]>>>',
    '<<<[VCP_TOOL_BATCH_START:2026-11-24T04:00:00.000+08:00]>>>',
    '[[VCP调用结果信息汇总:',
    '- 工具名称: ReadFile',
    '- 执行状态: ✅ SUCCESS',
    `- 返回内容:\n${literalDocLine}`,
    'VCP调用结果结束]]',
    ...innerMiddle,
    '<<<[VCP_TOOL_BATCH_END:2026-11-24T04:00:00.000+08:00]>>>',
    '<<<[END_ROLE_DIVIDE_USER]>>>',
    '业务分析后置说明。'
  ].join('\n');

  // 状态 0（未洗原件态：坏块 + 纠偏回执 + ReadFile 字面标题）
  const state0 = `${badBlock}\n` + makeMixedEnvelope([
    '[[VCP调用结果信息汇总:',
    '- 工具名称: VCP工具调用',
    '- 执行状态: ❌ ERROR',
    `- 返回内容: [[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=${fp}]]`,
    '[[/VCP协议纠偏指导]]',
    'VCP调用结果结束]]'
  ]);

  // 状态 1（活药态：ReadFile 字面标题 + 真实药丸紧跟其后）
  const cleansed1 = resilienceModule.cleanseHistory([
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: state0 },
    { role: 'user', content: 'Q2' }
  ]);
  const state1 = cleansed1[1].content;

  // 状态 2（退药态：后续新错剥除了 Turn 1 的真实药丸，保留 ReadFile 字面标题）
  const newerBad = '<<<[TOOL_REQUEST]>>>\nmaid:「始」Nova2「末」\n<<<[END_TOOL_REQUEST]>>>';
  const newerFp = Array.from(resilienceModule.extractHistoricalErrorBlocks(newerBad).keys())[0];
  const cleansed2 = resilienceModule.cleanseHistory([
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: state0 },
    { role: 'user', content: 'Q2' },
    { role: 'assistant', content: `${newerBad}\n<<<[ROLE_DIVIDE_USER]>>>\n[[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=${newerFp}]]\n<<<[END_ROLE_DIVIDE_USER]>>>` },
    { role: 'user', content: 'Q3' }
  ]);
  const state2 = cleansed2[1].content;

  // 1. 状态 1 下 extractTopLevelPillEnvelope 精准提取真实药丸，绝不因跨界桥接误判残缺跳过折叠
  const envInfo = extractTopLevelPillEnvelope(state1);
  assert.equal(envInfo.hasPill, true, '混合批次内真实药丸必须被准确识别');
  assert.equal(envInfo.hasMalformedPill, false, '不得误判为残缺药丸');
  assert.equal(envInfo.shouldSkipFolding, false, '不得触发 P6 跳过折叠');
  assert.ok(!envInfo.pillText.includes(literalDocLine), '提取出的纯净药丸绝不能夹带 ReadFile 内容');
  assert.ok(envInfo.pillText.includes('【/VCP 工具调用协议规范】'));

  // 2. foldWithPillIfPresent 正常折叠并保留纯净药丸
  const folded = foldWithPillIfPresent(state1, '[VCP上下文语义折叠-本层摘要: 读取了规范说明并处理异常。]');
  assert.ok(folded.includes('[VCP上下文语义折叠-本层摘要: 读取了规范说明并处理异常。]'));
  assert.ok(folded.includes('<<<[ROLE_DIVIDE_USER]>>>\n[系统提示:] 【VCP 工具调用协议规范】'));
  assert.ok(!folded.includes(literalDocLine), '折叠后的新药丸外壳不夹带同批 ReadFile 工具输出');

  // 3. 三态 stripResilienceMarkers 逐字节恒等，且完整保留 ReadFile 内的字面标题
  const s0 = stripResilienceMarkers(state0);
  const s1 = stripResilienceMarkers(state1);
  const s2 = stripResilienceMarkers(state2);
  assert.equal(s0, s1, '状态 0 与状态 1 经 stripResilienceMarkers 后必须逐字节恒等');
  assert.equal(s1, s2, '状态 1 与状态 2 经 stripResilienceMarkers 后必须逐字节恒等');
  assert.ok(s1.includes(literalDocLine), 'ReadFile 返回的字面【VCP 工具调用协议规范】必须 100% 完好保留');
  assert.ok(!s1.includes(realPill), '真实系统药丸已被干净剥除');
});
