'use strict';

if (process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE === undefined) {
  process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = 'true';
}

const test = require('node:test');
const assert = require('node:assert/strict');

const resilienceModule = require('../modules/vcpProtocolResilience');
const {
  reconcileTurnToolCalls,
  extractHistoricalErrorBlocks,
  assembleInTurnGuidance,
  assembleHistoricalPill,
  calculateFingerprint
} = resilienceModule;

const ToolCallParser = require('../modules/vcpLoop/toolCallParser');

// =========================================================================
// Group 1｜基准合法调用与放行（类别 0 与类别 II）
// =========================================================================

test('Group 1: G1-1 纯文本闲聊与技术方案讨论 100% 放行', async () => {
  const content = '你好！请问有什么我可以帮您的？我们可以一起讨论系统架构。';
  const res = await reconcileTurnToolCalls(content, [], { ToolCallParser });
  assert.equal(res.toolCalls.length, 0);
  assert.equal(res.protocolErrors.length, 0);
});

test('Group 1: G1-2 Markdown 围栏代码块与 HTML 代码块内的假调用 100% 放行', async () => {
  const content = [
    '下面是一个标准的工具调用示例：',
    '```vcp',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'command:「始」ls -la「末」',
    '<<<[END_TOOL_REQUEST]>>>',
    '```',
    '以及 HTML 视图展示：',
    '<pre><code>',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」PTYShellExecutor「末」',
    '<<<[END_TOOL_REQUEST]>>>',
    '</code></pre>',
    '请按上述规范调用。'
  ].join('\n');

  const res = await reconcileTurnToolCalls(content, [], { ToolCallParser });
  assert.equal(res.toolCalls.length, 0); // 绝不把代码块里的示例抓去执行
  assert.equal(res.protocolErrors.length, 0);
});

test('Group 1: G1-3 思考域标签内部的假调用 100% 放行', async () => {
  const content = [
    '<think>',
    '我准备调用工具，草稿如下：',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」FakeTool「末」',
    '<<<[END_TOOL_REQUEST]>>>',
    '</think>',
    '好的，我来为您解答。'
  ].join('\n');

  const res = await reconcileTurnToolCalls(content, [], { ToolCallParser });
  assert.equal(res.toolCalls.length, 0);
  assert.equal(res.protocolErrors.length, 0);
});

test('Group 1: G1-4 标准闭合合法调用（单参数、多参数、JEV）放行给原生正常执行', async () => {
  // 标准 tool_name 调用
  const standardContent = [
    '好的，为您执行查询：',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'command:「始」uptime「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const res1 = await reconcileTurnToolCalls(standardContent, [], { ToolCallParser });
  assert.equal(res1.protocolErrors.length, 0);
  assert.equal(res1.toolCalls.length, 1);
  assert.equal(res1.toolCalls[0].name, 'LinuxShellExecutor');
  assert.equal(res1.toolCalls[0].args.command, 'uptime');
  assert.equal(res1.toolCalls[0].args.maid, 'Nova');

  // 标准 JEV 调度调用
  const jevContent = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'jev:「始」请使用 {终端执行} 中的 PTYShellExecutor，运行【htop】「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const res2 = await reconcileTurnToolCalls(jevContent, [], { ToolCallParser });
  assert.equal(res2.protocolErrors.length, 0);
  assert.equal(res2.toolCalls.length, 1);
  assert.equal(res2.toolCalls[0].name, 'JEV');
});

test('Group 1: G1-5 archery:「始」no_reply「末」 异步调用附带长正文放行', async () => {
  const content = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'command:「始」./long_running_job.sh「末」,',
    'archery:「始」no_reply「末」',
    '<<<[END_TOOL_REQUEST]>>>',
    '后台异步任务已顺利启动。以下是针对本次任务的详细说明与风险提示：',
    '1. 任务预计运行约两小时，中途请勿重启服务器。',
    '2. 运行日志将实时重定向至 /var/log/backup.log。',
    '如有任何疑问请随时唤醒我为您查询进度。'
  ].join('\n');

  const res = await reconcileTurnToolCalls(content, [], { ToolCallParser });
  assert.equal(res.protocolErrors.length, 0);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, 'LinuxShellExecutor');
  assert.equal(res.toolCalls[0].archeryNoReply, true);
});

// =========================================================================
// Group 2｜类别 III 外框闭合但框内损坏（纯代码 0ms 拦截）
// =========================================================================

test('Group 2: G2-1 缺失 tool_name 且无 JEV 拦截为 MISSING_TOOL_NAME', async () => {
  const content = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'command:「始」ls「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const res = await reconcileTurnToolCalls(content, [], { ToolCallParser });
  assert.equal(res.toolCalls.length, 0);
  assert.equal(res.protocolErrors.length, 1);
  assert.equal(res.protocolErrors[0].errorCode, 'MISSING_TOOL_NAME');
  assert.equal(res.protocolErrors[0].isProtocolError, true);
});

test('Group 2: G2-2 控制键大小写拼错与非法字符拦截为 INVALID_TOOL_NAME', async () => {
  // 控制键大小写
  const casingContent = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'Tool_Name:「始」LinuxShellExecutor「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const res1 = await reconcileTurnToolCalls(casingContent, [], { ToolCallParser });
  assert.equal(res1.toolCalls.length, 0);
  assert.equal(res1.protocolErrors.length, 1);
  assert.equal(res1.protocolErrors[0].errorCode, 'INVALID_TOOL_NAME');
  assert.equal(res1.protocolErrors[0].subType, 'KEY_CASING_MISMATCH');

  // 非法键名（中划线）
  const hyphenContent = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool-name:「始」LinuxShellExecutor「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const res2 = await reconcileTurnToolCalls(hyphenContent, [], { ToolCallParser });
  assert.equal(res2.toolCalls.length, 0);
  assert.equal(res2.protocolErrors.length, 1);
  assert.equal(res2.protocolErrors[0].errorCode, 'INVALID_TOOL_NAME');
  assert.equal(res2.protocolErrors[0].subType, 'INVALID_KEY_CHARACTERS');

  // 中文错键名（伪键）
  const chineseKeyContent = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    '工具名:「始」LinuxShellExecutor「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const res3 = await reconcileTurnToolCalls(chineseKeyContent, [], { ToolCallParser });
  assert.equal(res3.toolCalls.length, 0);
  assert.equal(res3.protocolErrors.length, 1);
  assert.equal(res3.protocolErrors[0].errorCode, 'INVALID_TOOL_NAME');
});

test('Group 2: G2-3 字段漏「末」或游离定界符拦截为 UNCLOSED_FIELD', async () => {
  const content = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor,', // 漏「末」
    'command:「始」ls「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const res = await reconcileTurnToolCalls(content, [], { ToolCallParser });
  assert.equal(res.toolCalls.length, 0);
  assert.equal(res.protocolErrors.length, 1);
  assert.equal(res.protocolErrors[0].errorCode, 'UNCLOSED_FIELD');
});

test('Group 2: G2-4 等号赋值、全角冒号与普通引号拦截为 MALFORMED_BLOCK_SYNTAX', async () => {
  // 等号赋值
  const eqContent = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name="LinuxShellExecutor"',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const resEq = await reconcileTurnToolCalls(eqContent, [], { ToolCallParser });
  assert.equal(resEq.toolCalls.length, 0);
  assert.equal(resEq.protocolErrors[0].errorCode, 'MALFORMED_BLOCK_SYNTAX');
  assert.equal(resEq.protocolErrors[0].subType, 'EQUAL_ASSIGNMENT');

  // 全角冒号
  const colonContent = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name：「始」LinuxShellExecutor「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const resColon = await reconcileTurnToolCalls(colonContent, [], { ToolCallParser });
  assert.equal(resColon.toolCalls.length, 0);
  assert.equal(resColon.protocolErrors[0].errorCode, 'MALFORMED_BLOCK_SYNTAX');
  assert.equal(resColon.protocolErrors[0].subType, 'FULL_WIDTH_COLON');

  // 普通引号
  const quoteContent = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name: "LinuxShellExecutor"',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const resQuote = await reconcileTurnToolCalls(quoteContent, [], { ToolCallParser });
  assert.equal(resQuote.toolCalls.length, 0);
  assert.equal(resQuote.protocolErrors[0].errorCode, 'MALFORMED_BLOCK_SYNTAX');
  assert.equal(resQuote.protocolErrors[0].subType, 'QUOTES_WITHOUT_DELIMITERS');
});

test('Group 2: G2-5 同块内重复键冲突拦截与口吃复述放行不变量', async () => {
  // 冲突取值 -> 拦截
  const conflictContent = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'tool_name:「始」PTYShellExecutor「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const resConflict = await reconcileTurnToolCalls(conflictContent, [], { ToolCallParser });
  assert.equal(resConflict.toolCalls.length, 0);
  assert.equal(resConflict.protocolErrors.length, 1);
  assert.equal(resConflict.protocolErrors[0].errorCode, 'MALFORMED_BLOCK_SYNTAX');
  assert.equal(resConflict.protocolErrors[0].isDuplicateConflict, true);

  // 口吃复述一致取值 -> 静默去重放行
  const stutterContent = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'command:「始」ls「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const resStutter = await reconcileTurnToolCalls(stutterContent, [], { ToolCallParser });
  assert.equal(resStutter.protocolErrors.length, 0);
  assert.equal(resStutter.toolCalls.length, 1);
  assert.equal(resStutter.toolCalls[0].name, 'LinuxShellExecutor');
});

// =========================================================================
// Group 3｜黑名单错位反查前置拦截
// =========================================================================

test('Group 3: G3-1~G3-4 黑名单场景 A/B 与生效角色名拦截', async () => {
  const mockPluginManager = {
    getPlugin(name) {
      if (name === 'LinuxShellExecutor' || name === 'PTYShellExecutor') {
        return { name };
      }
      return null;
    }
  };

  const mockAgentManager = {
    isAgent(name) {
      return name === 'Nova' || name === 'ValetMan';
    }
  };

  // G3-1 场景 A：已知插件名误填进 maid 且缺 tool_name -> MISSING_TOOL_NAME
  const scenarioAContent = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」LinuxShellExecutor「末」,',
    'command:「始」ls「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const resA = await reconcileTurnToolCalls(scenarioAContent, [], {
    ToolCallParser,
    pluginManager: mockPluginManager
  });
  assert.equal(resA.toolCalls.length, 0);
  assert.equal(resA.protocolErrors.length, 1);
  assert.equal(resA.protocolErrors[0].errorCode, 'MISSING_TOOL_NAME');
  assert.equal(resA.protocolErrors[0].subType, 'BLACKLIST_SCENARIO_A');

  // G3-2 场景 B：已填 tool_name 但 maid 误填已知插件名 -> INVALID_TOOL_NAME
  const scenarioBContent = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」PTYShellExecutor「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'command:「始」ls「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const resB = await reconcileTurnToolCalls(scenarioBContent, [], {
    ToolCallParser,
    pluginManager: mockPluginManager
  });
  assert.equal(resB.toolCalls.length, 0);
  assert.equal(resB.protocolErrors.length, 1);
  assert.equal(resB.protocolErrors[0].errorCode, 'INVALID_TOOL_NAME');
  assert.equal(resB.protocolErrors[0].subType, 'BLACKLIST_SCENARIO_B');

  // G3-3 生效角色名填入 tool_name -> INVALID_TOOL_NAME
  const roleInToolContent = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」Nova「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const resRole = await reconcileTurnToolCalls(roleInToolContent, [], {
    ToolCallParser,
    agentManager: mockAgentManager
  });
  assert.equal(resRole.toolCalls.length, 0);
  assert.equal(resRole.protocolErrors.length, 1);
  assert.equal(resRole.protocolErrors[0].errorCode, 'INVALID_TOOL_NAME');
  assert.equal(resRole.protocolErrors[0].subType, 'ROLE_IN_TOOL_NAME');

  // G3-4 真实插件执行率严格为 0.000%
  assert.equal(resRole.protocolErrors[0].isProtocolError, true);
  assert.equal(resRole.toolCalls.length, 0);
});

// =========================================================================
// Group 4｜单双层 ESCAPE 与穿透护栏
// =========================================================================

test('Group 4: G4-1 单层 ESCAPE 包含内嵌工具标记 100% 放行', async () => {
  const content = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」WriteEscapedFile「末」,',
    'path:「始」/tmp/doc.txt「末」,',
    'content:「始ESCAPE」',
    'Here is an example tool request:',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」',
    '<<<[END_TOOL_REQUEST]>>>',
    '「末ESCAPE」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const res = await reconcileTurnToolCalls(content, [], { ToolCallParser });
  assert.equal(res.protocolErrors.length, 0);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, 'WriteEscapedFile');
});

test('Group 4: G4-2 嵌套 >=2 层 ESCAPE 拦截为 NESTED_ESCAPE', async () => {
  const content = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」WriteEscapedFile「末」,',
    'content:「始ESCAPE」outer「始ESCAPE」nested「末ESCAPE」「末ESCAPE」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const res = await reconcileTurnToolCalls(content, [], { ToolCallParser });
  assert.equal(res.toolCalls.length, 0);
  assert.equal(res.protocolErrors.length, 1);
  assert.equal(res.protocolErrors[0].errorCode, 'UNCLOSED_FIELD');
  assert.equal(res.protocolErrors[0].subType, 'NESTED_ESCAPE');
});

// =========================================================================
// Group 5｜V2 架构：未闭块与裸调不触发 Category IV/V 误判，闭合块独立放行
// =========================================================================

test('Group 5: G5-1 未闭合块后的闭合合法块独立解析放行，无 Category IV 误报', async () => {
  const content = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'command:「始」df -h「末」',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」PTYShellExecutor「末」,',
    'command:「始」uptime「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const res = await reconcileTurnToolCalls(content, [], { ToolCallParser });
  assert.equal(res.protocolErrors.length, 0);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, 'PTYShellExecutor');
});

test('Group 5: G5-2 散文裸字段与第三方 XML 标签 0ms 放行，不触发小模型仲裁', async () => {
  const content = [
    '我来帮您查看说明：',
    'maid:「始」Nova「末」',
    'tool_name:「始」LinuxShellExecutor「末」',
    '<tool_call>{"name": "fetch"}</tool_call>'
  ].join('\n');

  const res = await reconcileTurnToolCalls(content, [], { ToolCallParser });
  assert.equal(res.toolCalls.length, 0);
  assert.equal(res.protocolErrors.length, 0);
});

// =========================================================================
// Group 7｜提示词三明治回执、轮间指纹与门控对账
// =========================================================================

test('Group 7: G7-1 轮内实时纠偏回执组装三明治结构校验', () => {
  const fakeError = {
    errorCode: 'MISSING_TOOL_NAME',
    errorDetail: '缺少核心字段 tool_name！',
    blockFingerprint: '1234abcd',
    startIndex: 0,
    endIndex: 50
  };

  const guidance = assembleInTurnGuidance(fakeError);
  assert.equal(guidance.isFormatGuidance, true);
  assert.equal(guidance.raw.includes('[[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=1234abcd]]'), true);
  assert.equal(guidance.raw.includes('[[/VCP协议纠偏指导]]'), true);
  assert.equal(guidance.raw.includes('PluginSourceViewer'), true);
  assert.equal(guidance.raw.includes('[系统提示:]'), false); // 绝不包含 [系统提示:]
});

test('Group 7: G7-2 轮间历史常驻药丸组装与动态专项警示累加', () => {
  const pill = assembleHistoricalPill({
    historicalErrors: ['MISSING_TOOL_NAME', 'MISSING_MAID', 'MAID_IS_PLUGIN']
  });

  assert.equal(pill.includes('[系统提示:] 【VCP 工具调用协议规范】'), true);
  assert.equal(pill.includes('【/VCP 工具调用协议规范】'), true);
  assert.equal(pill.includes('### 四、本会话防错专项警示'), true);
  assert.equal(pill.includes('【必须指定工具】'), true);
  assert.equal(pill.includes('【必须签署角色】'), true);
  assert.equal(pill.includes('【严禁署名错位】'), true);
});

test('Group 7: G7-3 历史原文提取 extractHistoricalErrorBlocks 纯同步执行与闭合坏块指纹入库', () => {
  const badClosedBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'command:「始」uptime「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const originalText = `这是历史消息中的闭合坏块：\n${badClosedBlock}`;

  // 纯同步调用，严禁 await
  const errMap = extractHistoricalErrorBlocks(originalText);
  assert.ok(errMap instanceof Map);
  assert.ok(errMap.size >= 1);

  const expectedFp = calculateFingerprint(badClosedBlock);
  assert.equal(errMap.has(expectedFp), true);
  assert.equal(errMap.get(expectedFp)[0].errorCode, 'MISSING_TOOL_NAME');
});

test('Group 7: G7-4 环境变量门控 ENABLED 关闭时直通旁路', async () => {
  const content = '<<<[TOOL_REQUEST]>>>\nmaid:「始」Nova「末」\n<<<[END_TOOL_REQUEST]>>>'; // 坏块（缺 tool_name）
  const rawCalls = [{ name: 'Dummy', args: {} }];

  process.env.VCP_PROTOCOL_RESILIENCE_ENABLED = 'false';
  assert.equal(resilienceModule.ENABLED, false);

  const res = await reconcileTurnToolCalls(content, rawCalls, { ToolCallParser });
  assert.equal(res.toolCalls, rawCalls); // 原样直通返回
  assert.equal(res.protocolErrors.length, 0);

  const map = extractHistoricalErrorBlocks(content);
  assert.equal(map.size, 0); // 返回空 Map

  // 恢复门控
  delete process.env.VCP_PROTOCOL_RESILIENCE_ENABLED;
  assert.equal(resilienceModule.ENABLED, true);
});

test('Group 7: G7-5 Mock 降级分支（未注入 ToolCallParser 时绝对不改动 rawToolCalls）', async () => {
  const content = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'command:「始」ls「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const rawToolCalls = [{ name: 'NativeParsed', args: { command: 'ls' } }];

  // 不传 ToolCallParser
  const res = await reconcileTurnToolCalls(content, rawToolCalls, {});
  assert.equal(res.toolCalls, rawToolCalls); // 绝不删改 rawToolCalls
});

test('Group 7: G7-6 步骤 0A 用户中止或流中断时直退不产生 protocolErrors', async () => {
  const content = '<<<[TOOL_REQUEST]>>>\nmaid:「始」Nova「末」\n<<<[END_TOOL_REQUEST]>>>'; // 坏块（缺 tool_name）
  const rawCalls = [{ name: 'Dummy', args: {} }];

  // 1. streamAborted 直退
  const res1 = await reconcileTurnToolCalls(content, rawCalls, { ToolCallParser, streamAborted: true });
  assert.equal(res1.toolCalls, rawCalls);
  assert.equal(res1.protocolErrors.length, 0);

  // 2. abortSignal.aborted 直退
  const controller = new AbortController();
  controller.abort();
  const res2 = await reconcileTurnToolCalls(content, rawCalls, { ToolCallParser, abortSignal: controller.signal });
  assert.equal(res2.toolCalls, rawCalls);
  assert.equal(res2.protocolErrors.length, 0);

  // 3. 空白内容直退
  const res3 = await reconcileTurnToolCalls('   \n  ', rawCalls, { ToolCallParser });
  assert.equal(res3.toolCalls, rawCalls);
  assert.equal(res3.protocolErrors.length, 0);
});

test('Group 7: G7-7 步骤 0B 外部截断信号 finishReason=length 时文末未闭合残片启发式免责', async () => {
  // 前半段是一个完整合法的工具调用，后半段是文末截断的残片
  const content = [
    '好的，正在为您执行：',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'command:「始」echo hello「末」',
    '<<<[END_TOOL_REQUEST]>>>',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'command:「始」cat very_long_file' // 截断撞墙，无闭合
  ].join('\n');

  // 当带有 length 截断信号时，末尾残片被免责放行，前半段完整合法块正常解析执行，0 协议错误
  const res = await reconcileTurnToolCalls(content, [], {
    ToolCallParser,
    finishReason: 'length'
  });

  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, 'LinuxShellExecutor');
  assert.equal(res.protocolErrors.length, 0); // 末尾未闭合残片不报错、不留药丸
});

test('Group 7: G7-8 extractHistoricalErrorBlocks 对相同物理区间 [start, end] 去重', () => {
  const content = '<<<[TOOL_REQUEST]>>>\nmaid:「始」Nova「末」\n<<<[END_TOOL_REQUEST]>>>';
  const map = extractHistoricalErrorBlocks(content);
  for (const [fp, spans] of map.entries()) {
    const keys = spans.map(s => `${s.start}-${s.end}`);
    const set = new Set(keys);
    assert.equal(keys.length, set.size, '区间不能重复入库');
  }
});

test('Group 7: G7-9 ProtocolError 统一具备虚拟工具调用外壳字段', async () => {
  const content = '<<<[TOOL_REQUEST]>>>\nmaid:「始」Nova「末」\n<<<[END_TOOL_REQUEST]>>>'; // 坏块
  const res = await reconcileTurnToolCalls(content, [], { ToolCallParser });
  assert.equal(res.protocolErrors.length, 1);
  const err = res.protocolErrors[0];
  assert.equal(err.name, 'VCP工具调用');
  assert.deepEqual(err.args, {});
  assert.equal(err.archery, false);
  assert.equal(err.archeryNoReply, false);
  assert.equal(err.markHistory, false);
  assert.equal(err.isProtocolError, true);
});
