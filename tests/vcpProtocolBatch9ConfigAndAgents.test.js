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
  isResilienceEnabled,
  isSmallModelArbitrationEnabled,
  _resetRoleDividerWarnFlag,
  loadStaticBasePrompt,
  stripResilienceMarkers
} = protocolResilience;

// =========================================================================
// 1. isResilienceEnabled & RoleDivider 安全失活守卫
// =========================================================================
test('B9-1: isResilienceEnabled 基本开关与 options.enabled 覆盖', () => {
  const oldEnv = process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
  try {
    delete process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
    assert.equal(isResilienceEnabled(), false, '未配置时默认安全关闭（opt-in）');
    process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = '';
    assert.equal(isResilienceEnabled(), false, '留空时默认安全关闭');
    for (const on of ['true', '1', 'yes', 'on', ' TRUE ']) {
      process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = on;
      assert.equal(isResilienceEnabled(), true, `ENABLE_TOOL_PROTOCOL_RESILIENCE=${on} 时开启`);
    }
    delete process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
    assert.equal(isResilienceEnabled({ enabled: false }), false, 'options.enabled: false 显式关闭');
    assert.equal(isResilienceEnabled({ enabled: true }), true, 'options.enabled: true 显式开启');
    assert.equal(isResilienceEnabled({ enabled: 'true' }), true, 'options.enabled: "true" 显式开启');
    assert.equal(isResilienceEnabled({ enabled: 'on' }), true, 'options.enabled: "on" 显式开启');
    assert.equal(isResilienceEnabled({ enabled: '0' }), false, 'options.enabled: "0" 显式关闭');
    assert.equal(isResilienceEnabled({ enabled: '1' }), true, 'options.enabled: "1" 显式开启');

    for (const off of ['false', '0', 'no', 'off', ' FALSE ']) {
      process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = off;
      assert.equal(isResilienceEnabled(), false, `ENABLE_TOOL_PROTOCOL_RESILIENCE=${off} 时关闭`);
      assert.equal(isResilienceEnabled({ enabled: true }), true, `options.enabled: true 覆盖环境变量 ${off}`);
    }
  } finally {
    if (oldEnv !== undefined) process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = oldEnv;
    else delete process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
  }
});

test('B9-2: RoleDivider 假值配置触发安全失活并输出一次性 warning 告警', () => {
  const rdKeys = ['EnableRoleDivider', 'RoleDividerUser', 'RoleDividerScanAssistant'];
  const oldEnvs = {};
  for (const k of rdKeys) oldEnvs[k] = process.env[k];
  const oldResilience = process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
  process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = 'true';

  let warnOutput = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnOutput.push(args.join(' '));
  };

  try {
    for (const key of rdKeys) {
      for (const k of rdKeys) delete process.env[k];
      _resetRoleDividerWarnFlag();
      warnOutput = [];

      process.env[key] = 'false';
      assert.equal(isResilienceEnabled(), false, `${key}=false 必须安全失活`);
      assert.equal(warnOutput.length, 1, '必须打印一次 warning 告警');
      assert.ok(warnOutput[0].includes('RoleDivider switch'), '告警中必须包含 RoleDivider switch 提示');

      // 第二次调用不应重复告警
      assert.equal(isResilienceEnabled(), false);
      assert.equal(warnOutput.length, 1, '多次调用必须保持一次性告警（不刷屏）');
    }
  } finally {
    console.warn = originalWarn;
    for (const k of rdKeys) {
      if (oldEnvs[k] !== undefined) process.env[k] = oldEnvs[k];
      else delete process.env[k];
    }
    if (oldResilience !== undefined) process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = oldResilience;
    else delete process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
    _resetRoleDividerWarnFlag();
  }
});

// =========================================================================
// 2. isSmallModelArbitrationEnabled V2 兼容存根恒返回 false
// =========================================================================
test('B9-3: V2 isSmallModelArbitrationEnabled 恒返回 false', () => {
  assert.equal(isSmallModelArbitrationEnabled(), false);
  assert.equal(isSmallModelArbitrationEnabled({ enableSmallModel: true }), false);
});

// =========================================================================
// 4. loadStaticBasePrompt 提示词外层标签自愈保底
// =========================================================================
test('B9-6: loadStaticBasePrompt 首尾标签自愈保底', () => {
  // 用户编辑自定义提示词时不小心删除了首尾标签
  const nakedPrompt = `
### 一、标准骨架模板
<<<[TOOL_REQUEST]>>>
maid:「始」Nova「末」,
tool_name:「始」LinuxShellExecutor「末」
<<<[END_TOOL_REQUEST]>>>
  `.trim();

  const res = loadStaticBasePrompt(nakedPrompt);
  assert.ok(res.fullBase.startsWith('[系统提示:] 【VCP 工具调用协议规范】'), '必须自动补全首部标签');
  assert.ok(res.fullBase.endsWith('【/VCP 工具调用协议规范】'), '必须自动补全尾部标签');
  assert.ok(res.cleanBody.includes('LinuxShellExecutor'), '正文保留完整');

  // 用户自定义提示词包含【VCP 工具调用协议规范】但无[系统提示:]，绝不重复包裹造成双重头标
  const userPromptWithChineseHeader = `
【VCP 工具调用协议规范】
### 一、标准骨架模板
<<<[TOOL_REQUEST]>>>
maid:「始」Nova「末」,
tool_name:「始」LinuxShellExecutor「末」
<<<[END_TOOL_REQUEST]>>>
【/VCP 工具调用协议规范】
  `.trim();
  const res2 = loadStaticBasePrompt(userPromptWithChineseHeader);
  assert.ok(!res2.cleanBody.includes('【VCP 工具调用协议规范】'), 'cleanBody 中已彻底剥离头部');
  const matchCount = (res2.fullBase.match(/【VCP 工具调用协议规范】/g) || []).length;
  assert.equal(matchCount, 1, '绝不重复包裹双重头标');
});

// =========================================================================
// 5. AgentAssistant & AgentDream 思考链剥离掩码保护与内留外吐
// =========================================================================
test('B9-7: AgentAssistant removeVCPThinkingChain 思考链剥离不破坏工具块与代码块内部字面量', () => {
  const aaPath = path.resolve(__dirname, '../Plugin/AgentAssistant/AgentAssistant.js');
  const adPath = path.resolve(__dirname, '../Plugin/AgentDream/AgentDream.js');
  const aaContent = fs.readFileSync(aaPath, 'utf8');
  const adContent = fs.readFileSync(adPath, 'utf8');

  // 1. 验证生产文件源码中的正则没有双反斜杠转义错误（字面量转义只需单反斜杠）
  assert.ok(!aaContent.includes('<<<\\\\[TOOL_REQUEST'), 'AgentAssistant.js 生产代码绝不能包含双反斜杠字面量错误');
  assert.ok(!adContent.includes('<<<\\\\[TOOL_REQUEST'), 'AgentDream.js 生产代码绝不能包含双反斜杠字面量错误');
  const tmPath = path.resolve(__dirname, '../modules/vcpProtocolResilience/thinkingMask.js');
  const tmContent = fs.readFileSync(tmPath, 'utf8');
  assert.ok(!tmContent.includes('<<<\\\\[TOOL_REQUEST'), 'thinkingMask.js 绝不能包含双反斜杠字面量错误');
  assert.ok(aaContent.includes('thinkingMask') || aaContent.includes('maskProtectedRegionsForThinking'), 'AgentAssistant.js 必须接入 thinkingMask 安全掩码模块');
  assert.ok(adContent.includes('thinkingMask') || adContent.includes('maskProtectedRegionsForDreamThinking'), 'AgentDream.js 必须接入 thinkingMask 安全掩码模块');

  // 2. 直接验证生产代码使用的单反斜杠掩码正则对 <<<[TOOL_REQUEST]>>> 与 <<<[TOOL_REQUEST_ESCAPE]>>> 的真实匹配
  const toolMaskRegex = /<<<\[TOOL_REQUEST(?:_ESCAPE)?\]>>>(?:(?!<<<\[TOOL_REQUEST)[\s\S])*?<<<\[END_TOOL_REQUEST(?:_ESCAPE)?\]>>>/g;
  const normalBlock = '<<<[TOOL_REQUEST]>>>\nmaid:「始」Nova「末」\n<<<[END_TOOL_REQUEST]>>>';
  const escapeBlock = '<<<[TOOL_REQUEST_ESCAPE]>>>\nmaid:「始」Nova「末」\n<<<[END_TOOL_REQUEST_ESCAPE]>>>';
  assert.ok(toolMaskRegex.test(normalBlock), '掩码正则必须精确匹配标准工具请求块 <<<[TOOL_REQUEST]>>>');
  toolMaskRegex.lastIndex = 0;
  assert.ok(toolMaskRegex.test(escapeBlock), '掩码正则必须精确匹配转义工具请求块 <<<[TOOL_REQUEST_ESCAPE]>>>');

  // 构造包含工具块内部 <think>、转义工具块内部 <think> 与代码围栏内部 <think> 的复杂混合响应
  const mockAIResponse = [
    '[--- VCP元思考链 ---]',
    '顶层真实思考链内容...',
    '[--- 元思考链结束 ---]',
    '<think>',
    '通用思考标签内容',
    '</think>',
    '用户你好，以下是为你编写的示例：',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」DailyNote「末」,',
    'Content:「始」包含思考示例的代码：',
    '<think>',
    '工具参数内部包含的字面量',
    '</think>',
    '[--- VCP元思考链: "test" ---]',
    '工具参数内部元思考链字面量',
    '[--- 元思考链结束 ---]',
    '「末」',
    '<<<[END_TOOL_REQUEST]>>>',
    '<<<[TOOL_REQUEST_ESCAPE]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」DailyNote「末」,',
    'Content:「始」转义工具参数包含的思考：',
    '<think>',
    '转义工具参数内部字面量',
    '</think>',
    '「末」',
    '<<<[END_TOOL_REQUEST_ESCAPE]>>>',
    '```markdown',
    '<think>',
    '代码围栏内部思考',
    '</think>',
    '```',
    '操作完成。'
  ].join('\n');

  // 测试 removeVCPThinkingChain 是否保留工具块与代码围栏
  // 通过直接调用 AgentAssistant 中暴露或测试逻辑
  const stripThinkingTest = (text) => {
    // 模拟 AgentAssistant.js 内置的掩码与剥离逻辑（严格与生产代码中的单反斜杠正则保持一致）
    const masks = [];
    const pushMask = (chunk) => {
      const token = '__VCP_MASK_PROTECTED_' + masks.length + '__';
      masks.push({ token, content: chunk });
      return token;
    };
    let masked = text.replace(/<<<\[TOOL_REQUEST(?:_ESCAPE)?\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST(?:_ESCAPE)?\]>>>/g, pushMask);
    masked = masked.replace(/\[\[VCP调用结果信息汇总:[\s\S]*?VCP调用结果结束\]\]/g, pushMask);
    masked = masked.replace(/(^|\n)([ \t]*)(`{3,}|~{3,})[^\n]*\r?\n[\s\S]*?\r?\n\2\3(?=\r?\n|$)/g, (match, prefix) => {
      return prefix + pushMask(match.slice(prefix.length));
    });

    let cleaned = masked.replace(/^[ \t]*\[--- VCP元思考链(?:[^\r\n]*?)?\s*---\][ \t]*\r?\n[\s\S]*?^[ \t]*\[--- 元思考链结束 ---\][ \t]*(?:\r?\n|$)/gm, '');
    cleaned = cleaned.replace(/^[ \t]*<(?:think(?:ing)?|thought(?:s)?)[^>]*>[ \t]*\r?\n[\s\S]*?^[ \t]*<\/(?:think(?:ing)?|thought(?:s)?)[^>]*>[ \t]*(?:\r?\n|$)/gim, '');

    for (let i = masks.length - 1; i >= 0; i--) {
      cleaned = cleaned.split(masks[i].token).join(masks[i].content);
    }
    return cleaned.replace(/\n{3,}/g, '\n\n').trim();
  };

  const cleaned = stripThinkingTest(mockAIResponse);
  assert.ok(!cleaned.includes('顶层真实思考链内容'), '顶层思维链必须剥除');
  assert.ok(!cleaned.includes('通用思考标签内容'), '顶层 think 标签必须剥除');
  assert.ok(cleaned.includes('工具参数内部包含的字面量'), '工具参数内的 think 字面量必须 100% 保留');
  assert.ok(cleaned.includes('转义工具参数内部字面量'), '转义工具参数内的 think 字面量必须 100% 保留');
  assert.ok(cleaned.includes('代码围栏内部思考'), '代码围栏内的 think 字面量必须 100% 保留');

  // 验证 VULN-B9-01: 紧邻代码块的思考链必须彻底剥除，且代码块不受损
  const adjacentTestInput = [
    '<think>',
    '紧邻代码块的深层思考',
    '</think>',
    '```javascript',
    'console.log("hello world");',
    '```',
    '正文结束。'
  ].join('\n');

  const adjacentCleaned = stripThinkingTest(adjacentTestInput);
  assert.ok(!adjacentCleaned.includes('紧邻代码块的深层思考'), 'stripThinkingTest 紧邻代码块的思考链必须被彻底剥除');
  assert.ok(!adjacentCleaned.includes('<think>'), 'stripThinkingTest 思考标签必须彻底剥除');
  assert.ok(adjacentCleaned.includes('console.log("hello world");'), '代码围栏本体内容不受损');

  // 实测 AgentAssistant 与 AgentDream 生产函数
  const AgentAssistant = require('../Plugin/AgentAssistant/AgentAssistant');
  const AgentDream = require('../Plugin/AgentDream/AgentDream');
  if (typeof AgentAssistant._removeVCPThinkingChain === 'function') {
    const aaCleaned = AgentAssistant._removeVCPThinkingChain(adjacentTestInput);
    assert.ok(!aaCleaned.includes('紧邻代码块的深层思考'), 'AgentAssistant 紧邻代码块思考链必须彻底剥除');
    assert.ok(aaCleaned.includes('console.log("hello world");'), 'AgentAssistant 代码围栏必须保留');
  }
  if (typeof AgentDream._removeVCPThinkingChain === 'function') {
    const adCleaned = AgentDream._removeVCPThinkingChain(adjacentTestInput);
    assert.ok(!adCleaned.includes('紧邻代码块的深层思考'), 'AgentDream 紧邻代码块思考链必须彻底剥除');
    assert.ok(adCleaned.includes('console.log("hello world");'), 'AgentDream 代码围栏必须保留');
  }

  // 验证 VULN-B9-02: reasoning 标签 completeBlockPattern 与 danglingBlockPattern 能正常匹配非空内容
  const tagName = 'reasoning';
  const completeBlockPattern = new RegExp(`<${tagName}>[\\s\\S]*?<\\/${tagName}>\\s*`, 'gi');
  assert.ok(completeBlockPattern.test('<reasoning>deep thoughts</reasoning>'), 'completeBlockPattern 必须匹配包含内容的标签');
  const danglingBlockPattern = new RegExp(`<${tagName}>[\\s\\S]*$`, 'gi');
  assert.ok(danglingBlockPattern.test('<reasoning>unclosed reasoning'), 'danglingBlockPattern 必须匹配悬挂标签');
});

test('B9-8: 内留凭条存 history、外吐净文防泄漏双轨验证', () => {
  // 模拟经过 NonStreamHandler 自愈后的子 Agent 回复
  const rawTurnResponse = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'LinuxShellExecutor:「始」cat /etc/hosts「末」',
    '<<<[END_TOOL_REQUEST]>>>',
    '<<<[ROLE_DIVIDE_USER]>>>',
    '[[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=0f03ddb2]]',
    '⚠️ 检测到你将目标插件名误填入了键名...',
    '[[/VCP协议纠偏指导]]',
    '<<<[END_ROLE_DIVIDE_USER]>>>',
    '执行命令结果如下：127.0.0.1 localhost'
  ].join('\n');

  // 对内存入 history：保留凭条
  const internalHistoryContent = rawTurnResponse;
  assert.ok(internalHistoryContent.includes('[[VCP协议纠偏指导: code=MISSING_TOOL_NAME'), '子 Agent 自身 history 必须保留凭条供下一轮变药');

  // 对外吐给父 Agent / UI 广播：调用 stripResilienceMarkers 彻底剥净
  const externalOutput = stripResilienceMarkers(rawTurnResponse);
  assert.ok(!externalOutput.includes('<<<[TOOL_REQUEST]>>>'), '对外输出严禁泄露坏工具块残骸');
  assert.ok(!externalOutput.includes('[[VCP协议纠偏指导'), '对外输出严禁泄露纠偏回执');
  assert.ok(!externalOutput.includes('<<<[ROLE_DIVIDE_USER]>>>'), '对外输出严禁泄露角色分割标');
  assert.ok(externalOutput.includes('执行命令结果如下：127.0.0.1 localhost'), '对外输出必须保留真实解答正文');
});

// =========================================================================
// 6. fuzzyToolMatching 自动联动验证
// =========================================================================
test('B9-9: fuzzyToolMatching 未指定时自动读取 toolMarkerFuzzyMatcher.isEnabled()', async () => {
  const toolMarkerFuzzyMatcher = require('../modules/vcpLoop/toolMarkerFuzzyMatcher');
  const originalState = toolMarkerFuzzyMatcher.isEnabled();

  try {
    toolMarkerFuzzyMatcher.configure({ enabled: true });
    assert.equal(toolMarkerFuzzyMatcher.isEnabled(), true);

    // 在开启模糊匹配时，{始}...{末} 格式的工具块能够被识别
    const fuzzyContent = [
      '<<<[TOOL_REQUEST]>>>',
      'maid:{始}Nova{末},',
      'tool_name:{始}LinuxShellExecutor{末},',
      'command:{始}pwd{末}',
      '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');

    const result = await protocolResilience.reconcileTurnToolCalls(fuzzyContent, [], {
      ToolCallParser: require('../modules/vcpLoop/toolCallParser')
    });
    // 模糊匹配开启时应成功解析为合法调用
    assert.equal(result.protocolErrors.length, 0, '模糊匹配开启时合规放行');

    // 关闭模糊匹配
    toolMarkerFuzzyMatcher.configure({ enabled: false });
    assert.equal(toolMarkerFuzzyMatcher.isEnabled(), false);
  } finally {
    toolMarkerFuzzyMatcher.configure({ enabled: originalState });
  }
});

test('B9-10: assembleHistoricalPill 全角方括号尾标定位与药丸包裹完整性 (VULN-B9-03)', () => {
  const guidanceAssembler = require('../modules/vcpProtocolResilience/guidanceAssembler');
  const fullBase = [
    '［系统提示:］ ［VCP 工具调用协议规范］',
    '这是使用全角方括号书写的规范说明正文',
    '［/VCP 工具调用协议规范］'
  ].join('\n');

  const result = guidanceAssembler.assembleHistoricalPill({
    customStaticPrompt: fullBase,
    historicalErrors: ['- 错误使用工具名'],
    floorNote: '严禁臆造工具'
  });

  assert.ok(result.includes('### 四、本会话防错专项警示'), '必须生成专项警示章节');
  assert.ok(result.includes('- 错误使用工具名'), '必须包含具体错误行');
  assert.ok(result.includes('- 严禁臆造工具'), '必须包含兜底提醒');
  assert.ok(result.endsWith('【/VCP 工具调用协议规范】') || result.endsWith('［/VCP 工具调用协议规范］'), '必须以规范或全角闭合标结尾，警示内容包裹在药丸内部');
  const warningIdx = result.indexOf('### 四、本会话防错专项警示');
  const closeTagIdx = Math.max(result.lastIndexOf('【/VCP 工具调用协议规范】'), result.lastIndexOf('［/VCP 工具调用协议规范］'));
  assert.ok(warningIdx < closeTagIdx, '专项警示必须在闭标之前');
});

test('B9-12: AgentAssistant and AgentDream _removeVCPThinkingChain 剥离 antthinking 标签并使用随机 Nonce (SUGG-B9-02 & VULN-B9-02)', () => {
  const AgentAssistant = require('../Plugin/AgentAssistant/AgentAssistant');
  const AgentDream = require('../Plugin/AgentDream/AgentDream');

  const antthinkingInput = [
    'User mentions __VCP_MASK_PROTECTED_0__ literally.',
    '<antthinking>',
    'inner antthinking content',
    '</antthinking>',
    '```python',
    'print("hello")',
    '```',
    'Normal output with __VCP_MASK_PROTECTED_0__ intact.'
  ].join('\n');

  if (typeof AgentAssistant._removeVCPThinkingChain === 'function') {
    const aaCleaned = AgentAssistant._removeVCPThinkingChain(antthinkingInput);
    assert.ok(!aaCleaned.includes('<antthinking>'), 'AgentAssistant 必须剥除 <antthinking>');
    assert.ok(!aaCleaned.includes('inner antthinking content'), 'AgentAssistant 必须剥除 antthinking 内容');
    assert.ok(aaCleaned.includes('```python\nprint("hello")\n```'), 'AgentAssistant 代码围栏必须保留');
    assert.ok(aaCleaned.includes('__VCP_MASK_PROTECTED_0__'), 'AgentAssistant 不受字面量掩码 token 干扰');
    assert.equal((aaCleaned.match(/__VCP_MASK_PROTECTED_0__/g) || []).length, 2);
  }

  if (typeof AgentDream._removeVCPThinkingChain === 'function') {
    const adCleaned = AgentDream._removeVCPThinkingChain(antthinkingInput);
    assert.ok(!adCleaned.includes('<antthinking>'), 'AgentDream 必须剥除 <antthinking>');
    assert.ok(!adCleaned.includes('inner antthinking content'), 'AgentDream 必须剥除 antthinking 内容');
    assert.ok(adCleaned.includes('```python\nprint("hello")\n```'), 'AgentDream 代码围栏必须保留');
    assert.ok(adCleaned.includes('__VCP_MASK_PROTECTED_0__'), 'AgentDream 不受字面量掩码 token 干扰');
    assert.equal((adCleaned.match(/__VCP_MASK_PROTECTED_0__/g) || []).length, 2);
  }
});

test('B9-13: AgentAssistant 与 AgentDream 剥离中途截断未闭合的残缺元思考链 (P2)', () => {
  const AgentAssistant = require('../Plugin/AgentAssistant/AgentAssistant');
  const AgentDream = require('../Plugin/AgentDream/AgentDream');

  const truncatedInputs = [
    '正常回复前文。\n[--- VCP元思考链: 正在分析用户意图并在中途截断\n后续文本输出流被切断',
    '正常前置文本。\n   [--- VCP元思考链 没闭合中括号与破折号...',
    '[--- VCP元思考链: 刚起步就截断'
  ];

  for (const input of truncatedInputs) {
    if (typeof AgentAssistant._removeVCPThinkingChain === 'function') {
      const aaCleaned = AgentAssistant._removeVCPThinkingChain(input);
      assert.ok(!aaCleaned.includes('[--- VCP元思考链'), 'AgentAssistant 必须剥离未闭合截断的元思考链');
      assert.ok(!aaCleaned.includes('正在分析用户意图'), 'AgentAssistant 不应残留截断的元思考内容');
      if (input.includes('正常')) {
        assert.ok(aaCleaned.startsWith('正常'), '正文前文必须完整保留');
      }
    }

    if (typeof AgentDream._removeVCPThinkingChain === 'function') {
      const adCleaned = AgentDream._removeVCPThinkingChain(input);
      assert.ok(!adCleaned.includes('[--- VCP元思考链'), 'AgentDream 必须剥离未闭合截断的元思考链');
      assert.ok(!adCleaned.includes('正在分析用户意图'), 'AgentDream 不应残留截断的元思考内容');
      if (input.includes('正常')) {
        assert.ok(adCleaned.startsWith('正常'), '正文前文必须完整保留');
      }
    }
  }

  // 确保受保护区域（如工具调用块、代码围栏）内的字面量不被误剥离
  const protectedWithTruncated = [
    '```markdown',
    '[--- VCP元思考链: 代码块内部字面量应保留',
    '```',
    '外部结尾前文',
    '[--- VCP元思考链: 顶层未闭合的思考链被剥除'
  ].join('\n');

  if (typeof AgentAssistant._removeVCPThinkingChain === 'function') {
    const aaCleaned = AgentAssistant._removeVCPThinkingChain(protectedWithTruncated);
    assert.ok(aaCleaned.includes('[--- VCP元思考链: 代码块内部字面量应保留'), '代码围栏内的字面量不应被误剥离');
    assert.ok(!aaCleaned.includes('顶层未闭合的思考链被剥除'), '顶层未闭合截断思考链必须被剥离');
  }

  if (typeof AgentDream._removeVCPThinkingChain === 'function') {
    const adCleaned = AgentDream._removeVCPThinkingChain(protectedWithTruncated);
    assert.ok(adCleaned.includes('[--- VCP元思考链: 代码块内部字面量应保留'), '代码围栏内的字面量不应被误剥离');
    assert.ok(!adCleaned.includes('顶层未闭合的思考链被剥除'), '顶层未闭合截断思考链必须被剥离');
  }
});

test('B9-18: cleanseHistory 与 isResilienceEnabled 对 options.enabled 字符串 "0" 与 "1" 判定 (VULN-B9-01)', () => {
  const historyCleanse = require('../modules/vcpProtocolResilience/historyCleanse');
  const oldEnv = process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
  try {
    process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = 'true';
    assert.equal(historyCleanse.isResilienceEnabled({ enabled: '0' }), false, 'historyCleanse: enabled: "0" 必须返回 false');
    assert.equal(protocolResilience.isResilienceEnabled({ enabled: '0' }), false, 'protocolResilience: enabled: "0" 必须返回 false');

    const badBlock = [
      '<<<[TOOL_REQUEST]>>>',
      'maid:「始」Nova「末」',
      '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');
    const errMap = protocolResilience.extractHistoricalErrorBlocks(badBlock, {
      protectRoleDivider: true,
      isHistoryExtraction: true,
      includeClosedBlockCandidates: true,
      finishReason: 'stop',
      sawDone: true
    });
    const fp = Array.from(errMap.keys())[0] || '3fa9c2e1';
    const receipt = [
      '<<<[ROLE_DIVIDE_USER]>>>',
      '<<<[VCP_TOOL_BATCH_START:2026-11-22T02:00:00.000+08:00]>>>',
      '[[VCP调用结果信息汇总:',
      '- 工具名称: VCP工具调用',
      '- 执行状态: ❌ ERROR',
      `- 返回内容: [[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=${fp}]]`,
      '请修正参数并重试！',
      '[[/VCP协议纠偏指导]]',
      'VCP调用结果结束]]',
      '[本轮工具调用摘要:]',
      'VCP工具调用 格式错误（未执行）。',
      '[本轮工具调用摘要结束]',
      '<<<[VCP_TOOL_BATCH_END:2026-11-22T02:00:00.000+08:00]>>>',
      '<<<[END_ROLE_DIVIDE_USER]>>>'
    ].join('\n');

    const messages = [
      { role: 'user', content: 'U1' },
      { role: 'assistant', content: ['Prose', badBlock, receipt].join('\n') },
      { role: 'user', content: 'U2' }
    ];

    // 当 options.enabled 为 "0" 时，即使环境变量为 true，也不执行清洗，原样返回引用
    const uncleaned = historyCleanse.cleanseHistory(messages, { enabled: '0' });
    assert.equal(uncleaned, messages, 'enabled: "0" 时必须原样直通返回');

    process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = 'false';
    assert.equal(historyCleanse.isResilienceEnabled({ enabled: '1' }), true, 'historyCleanse: enabled: "1" 必须返回 true');
    assert.equal(protocolResilience.isResilienceEnabled({ enabled: '1' }), true, 'protocolResilience: enabled: "1" 必须返回 true');

    // 当 options.enabled 为 "1" 时，即使环境变量为 false，也强制执行清洗
    const cleaned = historyCleanse.cleanseHistory(messages, { enabled: '1' });
    assert.notEqual(cleaned, messages, 'enabled: "1" 时必须执行清洗');
    assert.ok(!cleaned[1].content.includes(badBlock), 'badBlock 必须被清洗');
    assert.ok(!cleaned[1].content.includes('[[VCP协议纠偏指导:'), '指导回执必须被清洗');
  } finally {
    if (oldEnv !== undefined) process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = oldEnv;
    else delete process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
  }
});

test('B9-19: AgentAssistant 与 AgentDream 剥离未闭合常规截断思考链 (VULN-B9-02)', () => {
  const AgentAssistant = require('../Plugin/AgentAssistant/AgentAssistant');
  const AgentDream = require('../Plugin/AgentDream/AgentDream');

  const unclosedThink = [
    '正文开始。',
    '<think>',
    '正在推导分析并在中途截断无闭合标签...'
  ].join('\n');

  if (typeof AgentAssistant._removeVCPThinkingChain === 'function') {
    const aaCleaned = AgentAssistant._removeVCPThinkingChain(unclosedThink);
    assert.ok(!aaCleaned.includes('<think>'), 'AgentAssistant 必须剥除未闭合 <think>');
    assert.ok(!aaCleaned.includes('正在推导分析并在中途截断'), 'AgentAssistant 必须剥除截断思考内容');
    assert.ok(aaCleaned.includes('正文开始。'), 'AgentAssistant 前文必须保留');
  }

  if (typeof AgentDream._removeVCPThinkingChain === 'function') {
    const adCleaned = AgentDream._removeVCPThinkingChain(unclosedThink);
    assert.ok(!adCleaned.includes('<think>'), 'AgentDream 必须剥除未闭合 <think>');
    assert.ok(!adCleaned.includes('正在推导分析并在中途截断'), 'AgentDream 必须剥除截断思考内容');
    assert.ok(adCleaned.includes('正文开始。'), 'AgentDream 前文必须保留');
  }

  // 测试 <antthinking> 未闭合截断
  const unclosedAnt = '前置说明\n<antthinking>\n未闭合的深度思考...';
  if (typeof AgentAssistant._removeVCPThinkingChain === 'function') {
    const aaAnt = AgentAssistant._removeVCPThinkingChain(unclosedAnt);
    assert.ok(!aaAnt.includes('<antthinking>'), 'AgentAssistant 必须剥除未闭合 <antthinking>');
    assert.ok(!aaAnt.includes('未闭合的深度思考'), 'AgentAssistant 必须剥除截断思考内容');
    assert.ok(aaAnt.includes('前置说明'), 'AgentAssistant 前文必须保留');
  }
  if (typeof AgentDream._removeVCPThinkingChain === 'function') {
    const adAnt = AgentDream._removeVCPThinkingChain(unclosedAnt);
    assert.ok(!adAnt.includes('<antthinking>'), 'AgentDream 必须剥除未闭合 <antthinking>');
    assert.ok(!adAnt.includes('未闭合的深度思考'), 'AgentDream 必须剥除截断思考内容');
    assert.ok(adAnt.includes('前置说明'), 'AgentDream 前文必须保留');
  }
});

test('B9-20: 代码围栏内连续空行在思考链剥离与解掩码时100%完整保留 (VULN-B9-03)', () => {
  const AgentAssistant = require('../Plugin/AgentAssistant/AgentAssistant');
  const AgentDream = require('../Plugin/AgentDream/AgentDream');

  // 代码块内部包含 4 个连续换行（即 3 个空行）
  const codeFenceWithNewlines = [
    '正文消息前言',
    '<think>',
    '已闭合的思考链',
    '</think>',
    '```python',
    'class Foo:',
    '    pass',
    '',
    '',
    '',
    'def bar():',
    '    pass',
    '```',
    '',
    '',
    '',
    '',
    '正文结尾。'
  ].join('\n');

  if (typeof AgentAssistant._removeVCPThinkingChain === 'function') {
    const aaCleaned = AgentAssistant._removeVCPThinkingChain(codeFenceWithNewlines);
    assert.ok(!aaCleaned.includes('<think>'), 'AgentAssistant 思考标签剥离');
    assert.ok(aaCleaned.includes('class Foo:\n    pass\n\n\n\ndef bar():'), 'AgentAssistant 代码围栏内 4 个连续换行必须 100% 完整保留');
    // 外层正文的连续多空行应被规范化为 2 个换行
    assert.ok(!aaCleaned.includes('\n\n\n\n正文结尾'), '正文区连续多空行应被压缩');
    assert.ok(aaCleaned.includes('正文结尾。'), '正文结尾保留');
  }

  if (typeof AgentDream._removeVCPThinkingChain === 'function') {
    const adCleaned = AgentDream._removeVCPThinkingChain(codeFenceWithNewlines);
    assert.ok(!adCleaned.includes('<think>'), 'AgentDream 思考标签剥离');
    assert.ok(adCleaned.includes('class Foo:\n    pass\n\n\n\ndef bar():'), 'AgentDream 代码围栏内 4 个连续换行必须 100% 完整保留');
    assert.ok(!adCleaned.includes('\n\n\n\n正文结尾'), '正文区连续多空行应被压缩');
    assert.ok(adCleaned.includes('正文结尾。'), '正文结尾保留');
  }
});

test('B9-21: guidanceAssembler 导出 _clearPromptCache 并重置静态缓存 (SUGG-B9-01)', () => {
  const guidanceAssembler = require('../modules/vcpProtocolResilience/guidanceAssembler');

  assert.equal(typeof guidanceAssembler._clearPromptCache, 'function', 'guidanceAssembler 必须导出 _clearPromptCache');

  guidanceAssembler.loadStaticBasePrompt();
  guidanceAssembler._clearPromptCache();
  const reloaded = guidanceAssembler.loadStaticBasePrompt();
  assert.ok(reloaded && reloaded.fullBase, '缓存清理后可重新加载静态提示词');
});


test('B9-22: AgentAssistant 与 AgentDream 思考链闭标同行散文保留、否定预查与 CRLF 兼容 (Remediation R14)', () => {
  const AgentAssistant = require('../Plugin/AgentAssistant/AgentAssistant');
  const AgentDream = require('../Plugin/AgentDream/AgentDream');

  // 1. 常规 <think> 闭标同行跟答案
  const convInline = [
    '<think>',
    '推导过程：1+1=2',
    '</think> 最终答案是 42。'
  ].join('\n');

  if (typeof AgentAssistant._removeVCPThinkingChain === 'function') {
    const aaCleaned = AgentAssistant._removeVCPThinkingChain(convInline);
    assert.equal(aaCleaned, '最终答案是 42。', 'AgentAssistant 必须保留闭标同行的答案文本');
  }
  if (typeof AgentDream._removeVCPThinkingChain === 'function') {
    const adCleaned = AgentDream._removeVCPThinkingChain(convInline);
    assert.equal(adCleaned, '最终答案是 42。', 'AgentDream 必须保留闭标同行的答案文本');
  }

  // 2. VCP 元思考链闭标同行跟答案
  const vcpInline = [
    '[--- VCP元思考链 (Auto模式) ---]',
    '系统内部决策逻辑',
    '[--- 元思考链结束 ---] 操作已成功完成。'
  ].join('\n');

  if (typeof AgentAssistant._removeVCPThinkingChain === 'function') {
    const aaVcp = AgentAssistant._removeVCPThinkingChain(vcpInline);
    assert.equal(aaVcp, '操作已成功完成。', 'AgentAssistant 必须保留 VCP 闭标同行答案');
  }
  if (typeof AgentDream._removeVCPThinkingChain === 'function') {
    const adVcp = AgentDream._removeVCPThinkingChain(vcpInline);
    assert.equal(adVcp, '操作已成功完成。', 'AgentDream 必须保留 VCP 闭标同行答案');
  }

  // 3. 单行闭合思考标签不吃尾（否定预查防误杀）
  const singleLineProse = '<think>单行标签解释</think> 正常散文内容必须保留。';
  if (typeof AgentAssistant._removeVCPThinkingChain === 'function') {
    const aaSingle = AgentAssistant._removeVCPThinkingChain(singleLineProse);
    assert.ok(aaSingle.includes('正常散文内容必须保留。'), 'AgentAssistant 单行思考标签不吃尾');
  }
  if (typeof AgentDream._removeVCPThinkingChain === 'function') {
    const adSingle = AgentDream._removeVCPThinkingChain(singleLineProse);
    assert.ok(adSingle.includes('正常散文内容必须保留。'), 'AgentDream 单行思考标签不吃尾');
  }

  // 4. CRLF 换行环境下未闭合截断不残留孤立 \r (0x0D)
  const crlfConvDangling = '前置第一行\r\n前置第二行\r\n<think>\r\n未闭合截断内容';
  if (typeof AgentAssistant._removeVCPThinkingChain === 'function') {
    const aaCrlf = AgentAssistant._removeVCPThinkingChain(crlfConvDangling);
    assert.equal(aaCrlf, '前置第一行\r\n前置第二行', 'AgentAssistant CRLF 换行完整保留');
    assert.ok(!aaCrlf.endsWith('\r'), 'AgentAssistant 上一行行尾绝不残留孤立 \r');
  }
  if (typeof AgentDream._removeVCPThinkingChain === 'function') {
    const adCrlf = AgentDream._removeVCPThinkingChain(crlfConvDangling);
    assert.equal(adCrlf, '前置第一行\r\n前置第二行', 'AgentDream CRLF 换行完整保留');
    assert.ok(!adCrlf.endsWith('\r'), 'AgentDream 上一行行尾绝不残留孤立 \r');
  }

  const crlfVcpDangling = 'VCP前置说明\r\n[--- VCP元思考链 ---\r\n未闭合思考';
  if (typeof AgentAssistant._removeVCPThinkingChain === 'function') {
    const aaVcpCrlf = AgentAssistant._removeVCPThinkingChain(crlfVcpDangling);
    assert.equal(aaVcpCrlf, 'VCP前置说明', 'AgentAssistant VCP截断剥离正常');
    assert.ok(!aaVcpCrlf.endsWith('\r'), 'AgentAssistant VCP截断上一行行尾绝不残留孤立 \r');
  }
  if (typeof AgentDream._removeVCPThinkingChain === 'function') {
    const adVcpCrlf = AgentDream._removeVCPThinkingChain(crlfVcpDangling);
    assert.equal(adVcpCrlf, 'VCP前置说明', 'AgentDream VCP截断剥离正常');
    assert.ok(!adVcpCrlf.endsWith('\r'), 'AgentDream VCP截断上一行行尾绝不残留孤立 \r');
  }
});
