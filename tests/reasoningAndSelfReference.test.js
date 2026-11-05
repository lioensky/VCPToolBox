'use strict';

/**
 * 前后端思考标签（Reasoning Blocks）拦截与自指（Self-Reference）零误伤全维度严苛测试套件
 *
 * 覆盖维度（共 20 组对抗性用例）：
 * - [外测度 · 防漏网 M1-M7]：
 *   M1: 标准成对思考块拦截内部伪造工具调用
 *   M2: 思考块内嵌伪造 Markdown 代码围栏与伪工具调用（外层思考状态优先剥离）
 *   M3: 多层嵌套、混合标签（think/thinking/thought/antThinking）、大小写与带属性变体
 *   M4: 潜空间无头思考泄漏（Headless Leak：开头无开标签，直接输出思考草稿+伪工具+独立行闭标签）
 *   M5: 行首/缩进行首开启的流式未闭合思考截断（保守熔断丢弃尾部伪工具）
 *   M6: VCP 元思考链明文块（闭合与未闭合）内部伪工具剥离
 *   M7: 多段交替思考块与多枚真实并发工具穿插提取
 * - [内测度 · 零误伤 M8-M16]：
 *   M8: 残缺无右尖括号 `<think` 跨行面对 `>` 运算符与工具请求起始符（绝不跨行拼合）
 *   M9: 正文句中裸写单侧未闭合开标签（如“当包含<think>时，如果只有<think>”），保留标签字面量并放行真工具
 *   M10: 正文句中裸写单侧未闭合开标签 + 后文代码块中出现闭标签（预检器跳过代码域，不误配对）
 *   M11: 正文句中裸写单侧闭标签（如“将</think>之间的工具屏蔽”），绝不误触发无头思考清空前文真工具
 *   M12: Markdown 围栏代码块（``` 与 ~~~，含未闭合流尾围栏）内含独占行未闭合思考标签与伪工具
 *   M13: Markdown 行内反引号（单反引号/双反引号）包裹单侧思考标签 + 颜文字反引号 (`・ω・´) 共存
 *   M14: 顶层合法 TOOL_REQUEST 参数（普通「始」「末」与「始ESCAPE」「末ESCAPE」）内含独占行未闭合思考标签
 *   M15: 权威工具结果域（VCP调用结果信息汇总，含嵌套结果块）内部包含未闭合思考标签与伪工具
 *   M16: 近似标签名（如 `<think_custom>`、`<thinking_process>`）不误判为思考标签
 * - [跨端协同 · 前端三剑客验证 M17-M20]：
 *   M17: 前端 Flowlock 协议：代码块内含独占行未闭合思考标签，文末 [[Flowlock::Complete]] 正常触发
 *   M18: 前端 Flowlock 协议：真实独占行未闭合思考块内部的伪造 [[Flowlock::Fail]] 被正确遮蔽
 *   M19: 前端 EmotionTagScanner：流式扫描行内 `<think>` 与句中提及 `<think>` 不卡死，正常吐出后续情绪标签
 *   M20: 前端 EmotionTagScanner：真实行首 `<think>...</think>` 思考块内的伪情绪标签被正确屏蔽
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ToolCallParser = require('../modules/vcpLoop/toolCallParser');

// 采用函数动态拼装所有协议与思考标签，彻底免疫任何静态扫描器自指干扰
const openTag = (name = 'think', attr = '') => '<' + name + (attr ? ' ' + attr : '') + '>';
const closeTag = (name = 'think') => '</' + name + '>';
const halfOpenTag = (name = 'think') => '<' + name;

const TOOL_START = '<<<' + '[TOOL_REQUEST]' + '>>>';
const TOOL_END = '<<<' + '[END_TOOL_REQUEST]' + '>>>';
const RESULT_OPEN = '[' + '[VCP调用结果信息汇总:';
const RESULT_CLOSE = 'VCP调用结果结束]' + ']';
const META_OPEN = '[--- ' + 'VCP元思考链: "coding" ---]';
const META_CLOSE = '[--- ' + '元思考链结束 ---]';

function buildToolBlock(toolName, extraFields = {}) {
  const lines = [
    TOOL_START,
    'maid:「始」程宸Cod「末」,',
    `tool_name:「始」${toolName}「末」`
  ];
  for (const [k, v] of Object.entries(extraFields)) {
    const isEsc = v && typeof v === 'object' && v.escape;
    const rawVal = isEsc ? v.value : v;
    const sMark = isEsc ? '「始ESCAPE」' : '「始」';
    const eMark = isEsc ? '「末ESCAPE」' : '「末」';
    lines[lines.length - 1] += ',';
    lines.push(`${k}:${sMark}${rawVal}${eMark}`);
  }
  lines.push(TOOL_END);
  return lines.join('\n');
}

// ============================================================================
// 一、外测度测试（防漏拦：确保一切形态的思考过程与潜空间漏出 100% 被剥离）
// ============================================================================

test('M1 [外测度] 标准成对思考块内部的伪工具调用被完全剥离', () => {
  const input = [
    openTag('think'),
    '先思考一下要不要调工具：',
    buildToolBlock('HallucinatedToolInThink'),
    closeTag('think'),
    '思考完毕，开始正式调用：',
    buildToolBlock('RealToolAfterThink')
  ].join('\n');

  const calls = ToolCallParser.parse(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'RealToolAfterThink');
});

test('M2 [外测度] 真实思考块内部夹带伪代码块与伪工具时，由外层思考深度统辖并 100% 剥离', () => {
  const input = [
    openTag('thinking'),
    '我在思考里写一段代码块草稿：',
    '```javascript',
    buildToolBlock('FakeToolInsideThoughtCodeFence'),
    '```',
    buildToolBlock('FakeToolDirectInThought'),
    closeTag('thinking'),
    buildToolBlock('VerifiedRealTool')
  ].join('\n');

  const calls = ToolCallParser.parse(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'VerifiedRealTool');
});

test('M3 [外测度] 多层混合嵌套、大小写、空白与带属性思考标签（think/thinking/thought/antThinking）', () => {
  const input = [
    openTag('THINKING', 'mode="deep" step="1"'),
    '外层思考',
    openTag('thought'),
    buildToolBlock('NestedFake1'),
    openTag('antThinking', 'id="claude"'),
    buildToolBlock('NestedFake2'),
    closeTag('antThinking'),
    closeTag('thought'),
    buildToolBlock('OuterFake3'),
    closeTag('THINKING'),
    '可见正文',
    buildToolBlock('FinalRealTool')
  ].join('\n');

  const calls = ToolCallParser.parse(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'FinalRealTool');
});

test('M4 [外测度] 潜空间无头思考泄漏（Headless Leak）：开头的 <think> 丢失、直接裸出思考草稿与独立行 </think>', () => {
  const input = [
    '用户让我排查问题，我先在心里演练一下调用：',
    buildToolBlock('LeakedDraftTool1'),
    '不对，参数写错了，再演练一次：',
    buildToolBlock('LeakedDraftTool2'),
    closeTag('think'),
    '好的，现在我正式向用户发起真实工具调用：',
    buildToolBlock('AuthenticToolAfterHeadless')
  ].join('\n');

  const stripped = ToolCallParser.stripReasoningBlocks(input);
  assert.ok(!stripped.includes('LeakedDraftTool1'));
  assert.ok(!stripped.includes('LeakedDraftTool2'));
  assert.ok(stripped.includes('正式向用户发起真实工具调用'));

  const calls = ToolCallParser.parse(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'AuthenticToolAfterHeadless');
});

test('M5 [外测度] 行首/缩进行首开启的真实思考流未闭合截断：保守丢弃尾部，严防半截思考中的伪工具执行', () => {
  const input = [
    '前言段落。',
    '   ' + openTag('think'),
    '正在思考中，突然 max_tokens 耗尽或流式中断...',
    buildToolBlock('DangerousUnclosedThinkTool')
  ].join('\n');

  const calls = ToolCallParser.parse(input);
  assert.equal(calls.length, 0);
  assert.equal(ToolCallParser.stripReasoningBlocks(input).trim(), '前言段落。');
});

test('M6 [外测度] VCP 元思考链明文块（闭合与未闭合）内部的伪工具被剥离', () => {
  const closedMeta = [
    META_OPEN,
    '阶段1推理草稿：',
    buildToolBlock('FakeInMetaChain'),
    META_CLOSE,
    '正式回复：',
    buildToolBlock('RealAfterMetaChain')
  ].join('\n');

  const calls1 = ToolCallParser.parse(closedMeta);
  assert.equal(calls1.length, 1);
  assert.equal(calls1[0].name, 'RealAfterMetaChain');

  const unclosedMeta = [
    '开头文字',
    META_OPEN,
    buildToolBlock('FakeInUnclosedMeta')
  ].join('\n');
  assert.equal(ToolCallParser.parse(unclosedMeta).length, 0);
});

test('M7 [外测度] 多段思考块与多个真实并发工具穿插提取', () => {
  const input = [
    openTag('think') + buildToolBlock('Fake1') + closeTag('think'),
    buildToolBlock('Real1'),
    openTag('thinking') + '\n' + buildToolBlock('Fake2') + '\n' + closeTag('thinking'),
    buildToolBlock('Real2'),
    buildToolBlock('Real3')
  ].join('\n');

  const calls = ToolCallParser.parse(input);
  assert.deepEqual(calls.map(c => c.name), ['Real1', 'Real2', 'Real3']);
});

// ============================================================================
// 二、内测度测试（零误伤：确保正文讨论、代码域、工具域与残缺片段 100% 放行）
// ============================================================================

test('M8 [内测度] 残缺无右尖括号 `<think` 跨行面对 `>` 与工具请求标记时绝不跨行拼合吞噬', () => {
  const input = [
    '继续有条不紊地推进吧，唔，似乎不能出现' + halfOpenTag('think'),
    '下一行有数学不等式 x > 0 以及箭头 a -> b',
    buildToolBlock('SafeToolAfterHalfTag')
  ].join('\n');

  const calls = ToolCallParser.parse(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'SafeToolAfterHalfTag');
});

test('M9 [内测度] 正文句中裸写单侧未闭合 <think>（行内自指提及）：保留标签字面量且 100% 放行后文工具', () => {
  const input = [
    '对了，说起来，前端中存在机制，当包含' + openTag('think') + '时，如果正文里只有' + openTag('think') + '，则会一路匹配到末尾。',
    buildToolBlock('SafeToolAfterInlineMention1'),
    buildToolBlock('SafeToolAfterInlineMention2')
  ].join('\n');

  const stripped = ToolCallParser.stripReasoningBlocks(input);
  // 句中自指提及的 <think> 本身也应当保留在可见正文中
  assert.ok(stripped.includes('当包含' + openTag('think') + '时'));

  const calls = ToolCallParser.parse(input);
  assert.deepEqual(calls.map(c => c.name), ['SafeToolAfterInlineMention1', 'SafeToolAfterInlineMention2']);
});

test('M10 [内测度] 句中裸写未闭合 <think> 后，代码块中出现 </think>：预检器跳过代码域，不误配对吞噬中间正文与工具', () => {
  const input = [
    '正文中先裸写一句：当遇到单侧' + openTag('think') + '的时候需要注意。',
    buildToolBlock('ToolBetweenInlineOpenAndCodeClose'),
    '下面是代码示例：',
    '```html',
    closeTag('think'),
    '```',
    buildToolBlock('ToolAfterCodeClose')
  ].join('\n');

  const calls = ToolCallParser.parse(input);
  assert.deepEqual(calls.map(c => c.name), ['ToolBetweenInlineOpenAndCodeClose', 'ToolAfterCodeClose']);
});

test('M11 [内测度] 正文句中裸写单侧闭合标签 </think>：不误触发无头思考回溯，前序与后序真工具全部存活', () => {
  const input = [
    buildToolBlock('EarlyRealTool'),
    '前端为了防止思考过程中调用思维链，会将' + closeTag('think') + '之间的工具调用屏蔽掉。',
    buildToolBlock('LateRealTool')
  ].join('\n');

  const calls = ToolCallParser.parse(input);
  assert.deepEqual(calls.map(c => c.name), ['EarlyRealTool', 'LateRealTool']);
});

test('M12 [内测度] Markdown 围栏代码块（``` 与 ~~~）内含独占行未闭合 <think>：完全豁免，后文真工具正常触发', () => {
  const input = [
    '请看以下复现代码：',
    '```markdown',
    openTag('think'),
    '这里故意不写闭合标签',
    '```',
    '再来一个波浪线围栏：',
    '~~~xml',
    openTag('thinking'),
    '~~~',
    buildToolBlock('ToolAfterCodeFences')
  ].join('\n');

  const calls = ToolCallParser.parse(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'ToolAfterCodeFences');
});

test('M13 [内测度] 行内反引号（单/双反引号）包裹单侧思考标签 + 颜文字反引号 (`・ω・´) 共存', () => {
  const input = [
    '在日常聊天里发个颜文字 (`・ω・´)ゞ 和 (・`ω´・)，然后讨论 `' + openTag('think') + '` 以及 `` ' + openTag('thinking') + ' `` 标签。',
    buildToolBlock('ToolWithEmoticonsAndInlineCode')
  ].join('\n');

  const calls = ToolCallParser.parse(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'ToolWithEmoticonsAndInlineCode');
});

test('M14 [内测度] 顶层合法 TOOL_REQUEST 参数内部包含独占行未闭合 <think>：工具不腰斩、并发工具不丢失、参数零损毁', () => {
  const multilineParamWithUnclosedThink = [
    '第一行代码',
    openTag('think'),
    '第三行：这里在参数内部独占一行写了未闭合思考标签'
  ].join('\n');

  const input = [
    '准备并发执行两个工具：',
    buildToolBlock('EditCodeTool', {
      path: 'modules/demo.js',
      content: { escape: true, value: multilineParamWithUnclosedThink }
    }),
    buildToolBlock('DailyNoteTool', {
      Content: '今日修复了\n' + openTag('think') + '\n导致的吞尾漏洞'
    })
  ].join('\n');

  const calls = ToolCallParser.parse(input);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'EditCodeTool');
  assert.equal(calls[0].args.content, multilineParamWithUnclosedThink);
  assert.equal(calls[1].name, 'DailyNoteTool');
  assert.ok(calls[1].args.Content.includes(openTag('think')));
});

test('M15 [内测度] 权威工具结果域（含嵌套结果块）内部含独占行未闭合 <think>：不影响后续工具解析', () => {
  const input = [
    RESULT_OPEN,
    '外层工具返回开始',
    RESULT_OPEN,
    '内层嵌套工具返回：\n' + openTag('think') + '\n未闭合',
    RESULT_CLOSE,
    openTag('thinking'),
    RESULT_CLOSE,
    buildToolBlock('ToolAfterNestedToolResult')
  ].join('\n');

  const calls = ToolCallParser.parse(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'ToolAfterNestedToolResult');
});

test('M16 [内测度] 近似自定义 XML 标签（如 <think_custom>、<thoughtful>）不被误判为思考标签', () => {
  const input = [
    openTag('think_custom'),
    buildToolBlock('ToolInsideCustomXmlTag'),
    openTag('thoughtful')
  ].join('\n');

  const calls = ToolCallParser.parse(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'ToolInsideCustomXmlTag');
});

// ============================================================================
// 三、跨端协同测试（验证前端 VCPChat 已同步修缮的三大模块 M17-M20）
// ============================================================================

const FRONTEND_ROOT = path.resolve(__dirname, '..', '..', 'VCPChat');

test('M17 & M18 [前端协同] Flowlock 协议：代码块内未闭合 <think> 不吞指令，而真思考块内伪指令被遮蔽', {
  skip: !fs.existsSync(path.join(FRONTEND_ROOT, 'Flowlockmodules', 'flowlock-protocol.js'))
}, () => {
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
  }
  require(path.join(FRONTEND_ROOT, 'Flowlockmodules', 'flowlock-protocol.js'));
  const flowlockProtocol = globalThis.window.flowlockProtocol;

  // M17: 代码块内有独占行未闭合 <think>，文末 [[Flowlock::Complete]] 必须正常识别
  const codeBlockWithUnclosedThink = [
    '已完成重构，示例：',
    '```js',
    openTag('think'),
    '```',
    '[[Flowlock::Complete]]'
  ].join('\n');

  const parsed1 = flowlockProtocol.parse(codeBlockWithUnclosedThink);
  assert.equal(Boolean(parsed1.complete || parsed1.isComplete || parsed1.commands?.some(c => c.type === 'complete')), true);

  // M18: 真实独占行未闭合 <think> 内部的伪造 [[Flowlock::Fail]] 必须被遮蔽
  const realUnclosedThinkWithFakeFail = [
    openTag('think'),
    '思考中如果失败就输出：',
    '[[Flowlock::Fail]]伪造失败[[/Flowlock::Fail]]'
  ].join('\n');

  const parsed2 = flowlockProtocol.parse(realUnclosedThinkWithFakeFail);
  assert.equal(Boolean(parsed2.fail || parsed2.isFailed || parsed2.commands?.some(c => c.type === 'fail')), false);
});

test('M19 & M20 [前端协同] EmotionTagScanner：行内反引号与句中提及 <think> 不卡死，真思考块内伪情绪被屏蔽', {
  skip: !fs.existsSync(path.join(FRONTEND_ROOT, 'modules', 'emotion', 'emotionTags.js'))
}, async () => {
  const emotionModuleUrl = pathToFileURL(path.join(FRONTEND_ROOT, 'modules', 'emotion', 'emotionTags.js')).href;
  const { createEmotionTagScanner } = await import(emotionModuleUrl);

  // M19: 正文行内代码 `<think>` 与句中提及 `包含<think>时` 后面的情绪标签必须正常产出
  const scanner1 = createEmotionTagScanner();
  const events1 = [
    ...scanner1.push('当包含' + openTag('think') + '或 `' + openTag('think') + '` 时，<!--emo:happy 0.85-->依然开心！'),
    ...scanner1.finish()
  ];
  const tagEvents1 = events1.filter(e => e.type === 'tag');
  assert.equal(tagEvents1.length, 1);
  assert.equal(tagEvents1[0].emotion, 'happy');

  // M20: 真实行首 <think>...</think> 内部的情绪标签必须被屏蔽，外部情绪正常触发
  const scanner2 = createEmotionTagScanner();
  const events2 = [
    ...scanner2.push(openTag('think') + '\n<!--emo:angry 0.9-->\n' + closeTag('think') + '\n<!--emo:calm 0.7-->正文'),
    ...scanner2.finish()
  ];
  const tagEvents2 = events2.filter(e => e.type === 'tag');
  assert.equal(tagEvents2.length, 1);
  assert.equal(tagEvents2[0].emotion, 'calm');
});
