'use strict';

if (process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE === undefined) {
  process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = 'true';
}

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  calculateFingerprint
} = require('../modules/vcpProtocolResilience/spans');

const {
  isEffectiveRoleName,
  checkBlacklistConflict,
  SYSTEM_RESERVED_ROLES,
  _setStaticAgentMapCandidatesForTest
} = require('../modules/vcpProtocolResilience/blacklist');

const {
  assembleInTurnGuidance,
  assembleHistoricalPill,
  assemblePermanentPill,
  loadStaticBasePrompt,
  loadAndCompileStaticBase,
  DYNAMIC_ERROR_MAP,
  SPECIALIZED_REMINDERS_MAP,
  PILL_HEADER_TAG,
  PILL_CLOSING_TAG,
  FALLBACK_STATIC_PROMPT
} = require('../modules/vcpProtocolResilience/guidanceAssembler');

// ==========================================
// Test Suite 1: spans.js
// ==========================================
test('spans.js: calculateFingerprint strictly matches SHA1 formula', () => {
  const text = '  \n<<<[TOOL_REQUEST]>>>\nmaid:「始」Nova「末」\n<<<[END_TOOL_REQUEST]>>>  ';
  const rawSlice = text.slice(4, 58);
  const expectedHash = crypto.createHash('sha1').update(rawSlice.trim()).digest('hex').slice(0, 8);
  const result = calculateFingerprint(text, 4, 58);

  assert.equal(result.length, 8);
  assert.equal(result, expectedHash);

  // Trimming invariance
  assert.equal(
    calculateFingerprint('   foobar   ', 0, 12),
    calculateFingerprint('foobar', 0, 6)
  );

  // Defensive handling
  assert.equal(typeof calculateFingerprint(null), 'string');
  assert.equal(typeof calculateFingerprint(undefined), 'string');
  assert.equal(typeof calculateFingerprint('abc', 10, 2), 'string'); // inverted bounds
  assert.equal(typeof calculateFingerprint(12345, 0, 3), 'string');
});

// ==========================================
// Test Suite 2: blacklist.js
// ==========================================
test('blacklist.js: isEffectiveRoleName validates dynamic agent roles and system reserved words', () => {
  const mockAgentManager = {
    isAgent(name) {
      return name.toLowerCase() === 'nova' || name.toLowerCase() === 'aria';
    },
    agentMap: new Map([
      ['Nova', 'Nova.txt'],
      ['Aria', 'Aria.txt']
    ])
  };

  // Dynamic roles
  assert.equal(isEffectiveRoleName('Nova', mockAgentManager), true);
  assert.equal(isEffectiveRoleName('nova', mockAgentManager), true);
  assert.equal(isEffectiveRoleName('Aria', mockAgentManager), true);
  assert.equal(isEffectiveRoleName('UnknownRole', mockAgentManager), false);

  // System reserved words
  for (const reserved of SYSTEM_RESERVED_ROLES) {
    assert.equal(isEffectiveRoleName(reserved, mockAgentManager), true);
    assert.equal(isEffectiveRoleName(reserved.toUpperCase(), mockAgentManager), true);
  }

  // Real tools should NOT be role names
  assert.equal(isEffectiveRoleName('LinuxShellExecutor', mockAgentManager), false);
  assert.equal(isEffectiveRoleName('PTYShellExecutor', mockAgentManager), false);
  assert.equal(isEffectiveRoleName('WriteEscapedFile', mockAgentManager), false);

  // Defensive
  assert.equal(isEffectiveRoleName('', mockAgentManager), false);
  assert.equal(isEffectiveRoleName(null, mockAgentManager), false);
  assert.equal(isEffectiveRoleName(undefined, mockAgentManager), false);
});

function withTempStaticAgentMap(mapObj, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-agent-map-'));
  const tmpFile = path.join(tmpDir, 'agent_map.json');
  fs.writeFileSync(tmpFile, JSON.stringify(mapObj), 'utf-8');
  _setStaticAgentMapCandidatesForTest([tmpFile]);
  try {
    return fn();
  } finally {
    _setStaticAgentMapCandidatesForTest(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('blacklist.js [P2-1 Regression]: isEffectiveRoleName falls back to static agent_map.json when agentManager.agentMap is empty (size 0)', () => {
  withTempStaticAgentMap({ Nova: 'Nova.txt' }, () => {
    const emptyAgentManager = {
      isAgent() { return false; },
      agentMap: new Map() // size 0
    };

    // Falls back to static agent_map.json fixture which defines Nova
    assert.equal(isEffectiveRoleName('Nova', emptyAgentManager), true);
    assert.equal(isEffectiveRoleName('nova', emptyAgentManager), true);
    assert.equal(isEffectiveRoleName('maid', emptyAgentManager), true);
    assert.equal(isEffectiveRoleName('NonExistentAgent999', emptyAgentManager), false);
  });
});

test('blacklist.js: isEffectiveRoleName falls back to static agent_map.json when agentManager not provided', () => {
  withTempStaticAgentMap({ Nova: 'Nova.txt' }, () => {
    assert.equal(isEffectiveRoleName('Nova'), true);
    assert.equal(isEffectiveRoleName('nova'), true);
    assert.equal(isEffectiveRoleName('maid'), true);
    assert.equal(isEffectiveRoleName('assistant'), true);
    assert.equal(isEffectiveRoleName('NonExistentAgent999'), false);
  });
});

test('blacklist.js: checkBlacklistConflict Scenario A (plugin in maid & missing tool_name)', () => {
  const mockPluginManager = {
    getPlugin(name) {
      if (name === 'LinuxShellExecutor' || name === 'PTYShellExecutor') {
        return { name };
      }
      return null;
    }
  };

  const conflictA = checkBlacklistConflict('', 'maid', 'LinuxShellExecutor', {
    pluginManager: mockPluginManager
  });

  assert.ok(conflictA);
  assert.equal(conflictA.conflict, true);
  assert.equal(conflictA.errorCode, 'MISSING_TOOL_NAME');
  assert.equal(conflictA.detectedPluginInMaid, 'LinuxShellExecutor');
  assert.equal(conflictA.isProtocolError, true);
  assert.equal(conflictA.errorDetail.includes('误填入了 maid 署名字段'), true);
});

test('blacklist.js: checkBlacklistConflict Scenario B (tool_name present but plugin in maid)', () => {
  const mockPluginManager = {
    getPlugin(name) {
      if (name === 'LinuxShellExecutor' || name === 'PTYShellExecutor') {
        return { name };
      }
      return null;
    }
  };

  const conflictB = checkBlacklistConflict('LinuxShellExecutor', 'valet', 'PTYShellExecutor', {
    pluginManager: mockPluginManager
  });

  assert.ok(conflictB);
  assert.equal(conflictB.conflict, true);
  assert.equal(conflictB.errorCode, 'INVALID_TOOL_NAME');
  assert.equal(conflictB.pluginInMaid, 'PTYShellExecutor');
  assert.equal(conflictB.isProtocolError, true);
  assert.equal(conflictB.errorDetail.includes('误填入了 valet 署名字段'), true);
});

test('blacklist.js: checkBlacklistConflict intercepts effective role names in tool_name', () => {
  const mockAgentManager = {
    isAgent(name) { return name === 'Nova'; }
  };

  // Active role name in tool_name
  const conflictRole = checkBlacklistConflict('Nova', 'maid', 'Nova', {
    agentManager: mockAgentManager
  });
  assert.ok(conflictRole);
  assert.equal(conflictRole.conflict, true);
  assert.equal(conflictRole.errorCode, 'INVALID_TOOL_NAME');
  assert.equal(conflictRole.roleNameInTool, 'Nova');
  assert.equal(conflictRole.isProtocolError, true);

  // System reserved word in tool_name
  const conflictReserved = checkBlacklistConflict('maid', 'maid', 'Nova', {});
  assert.ok(conflictReserved);
  assert.equal(conflictReserved.conflict, true);
  assert.equal(conflictReserved.errorCode, 'INVALID_TOOL_NAME');
  assert.equal(conflictReserved.roleNameInTool, 'maid');
});

test('blacklist.js: checkBlacklistConflict permits 100% legal calls with zero false-positives', () => {
  const mockPluginManager = {
    getPlugin(name) {
      return name === 'LinuxShellExecutor' ? { name } : null;
    }
  };
  const mockAgentManager = {
    isAgent(name) { return name === 'Nova'; }
  };

  const legalCall = checkBlacklistConflict('LinuxShellExecutor', 'maid', 'Nova', {
    pluginManager: mockPluginManager,
    agentManager: mockAgentManager
  });

  assert.equal(legalCall, null);
});

// ==========================================
// Test Suite 3: guidanceAssembler.js
// ==========================================
test('guidanceAssembler.js: loadStaticBasePrompt loads prompt with 2 source viewers', () => {
  const { fullBase, cleanBody } = loadStaticBasePrompt();

  assert.equal(fullBase.startsWith(PILL_HEADER_TAG), true);
  assert.equal(fullBase.endsWith(PILL_CLOSING_TAG), true);

  // Clean body stripped of outer tags
  assert.equal(cleanBody.includes(PILL_HEADER_TAG), false);
  assert.equal(cleanBody.includes(PILL_CLOSING_TAG), false);

  // Must retain both source viewer plugins as exploration templates
  assert.equal(cleanBody.includes('PluginSourceViewer'), true);
  assert.equal(cleanBody.includes('ServerPluginSourceViewer'), true);
  assert.equal(cleanBody.includes('CodeSearcher'), true);
  assert.equal(cleanBody.includes('LinuxShellExecutor'), true);

  // Aliases
  assert.deepEqual(loadAndCompileStaticBase(), { fullBase, cleanBody });
});

test('guidanceAssembler.js [P2-3 Regression]: loadStaticBasePrompt strips historic pill tags without "工具调用"', () => {
  const historicPrompt = [
    '[系统提示:] 【VCP协议规范】',
    '### 一、标准骨架模板',
    'some body content here',
    '【/VCP协议规范】'
  ].join('\n');

  const { cleanBody } = loadStaticBasePrompt(historicPrompt);
  assert.equal(cleanBody.includes('【VCP协议规范】'), false);
  assert.equal(cleanBody.includes('【/VCP协议规范】'), false);
  assert.equal(cleanBody.includes('some body content here'), true);
});

test('guidanceAssembler.js: assembleInTurnGuidance builds compliant sandwich structure', () => {
  const toolCall = {
    errorCode: 'MISSING_TOOL_NAME',
    detectedPluginInMaid: 'LinuxShellExecutor',
    blockFingerprint: 'ab12cd34'
  };

  const result = assembleInTurnGuidance(toolCall);

  assert.equal(result.success, false);
  assert.equal(result.isFormatGuidance, true);
  assert.equal(result.isProtocolError, true);
  assert.equal(typeof result.raw, 'string');
  assert.equal(result.content[0].text, result.raw);

  const raw = result.raw;

  // Outer brackets
  assert.equal(raw.startsWith('[[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=ab12cd34]]'), true);
  assert.equal(raw.endsWith('[[/VCP协议纠偏指导]]'), true);

  // Must NOT contain [系统提示:] in in-turn guidance
  assert.equal(raw.includes('[系统提示:]'), false);

  // Head Alert
  assert.equal(raw.includes('⚠️ 检测到你将目标插件名「LinuxShellExecutor」误填入了署名字段'), true);

  // Static Body
  assert.equal(raw.includes('### 一、标准骨架模板'), true);
  assert.equal(raw.includes('PluginSourceViewer'), true);
  assert.equal(raw.includes('ServerPluginSourceViewer'), true);

  // Tail Action
  assert.equal(raw.includes('👉 立即纠偏动作：请将插件名移至 tool_name:「始」LinuxShellExecutor「末」'), true);
});

test('guidanceAssembler.js: assembleInTurnGuidance handles actionAdvice override and different error codes', () => {
  const customCall = {
    errorCode: 'INVALID_TOOL_NAME',
    roleNameInTool: 'Nova',
    blockFingerprint: 'deadbeef',
    actionAdvice: '👉 特别指导：请勿使用 Nova 作为工具名！'
  };

  const res = assembleInTurnGuidance(customCall);
  assert.equal(res.raw.includes('code=INVALID_TOOL_NAME block=deadbeef'), true);
  assert.equal(res.raw.includes('⚠️ 检测到你将角色名「Nova」误填入了 tool_name'), true);
  assert.equal(res.raw.includes('👉 特别指导：请勿使用 Nova 作为工具名！'), true);
});

test('guidanceAssembler.js [P2-2 Regression]: assembleHistoricalPill correctly injects EMPTY_OR_MALFORMED_FIELDS warning', () => {
  const pillWithEmptyErr = assembleHistoricalPill({
    historicalErrors: ['EMPTY_OR_MALFORMED_FIELDS']
  });

  assert.equal(pillWithEmptyErr.includes('### 四、本会话防错专项警示'), true);
  assert.equal(pillWithEmptyErr.includes('【必须包含有效参数】'), true);
  assert.equal(pillWithEmptyErr.includes('严禁输出空块'), true);
});

test('guidanceAssembler.js: assembleHistoricalPill accumulates specialized warnings before closing tag', () => {
  const pillWithoutErrors = assembleHistoricalPill();
  assert.equal(pillWithoutErrors.startsWith(PILL_HEADER_TAG), true);
  assert.equal(pillWithoutErrors.endsWith(PILL_CLOSING_TAG), true);
  assert.equal(pillWithoutErrors.includes('### 四、本会话防错专项警示'), false);

  // With historical errors
  const pillWithErrors = assembleHistoricalPill({
    historicalErrors: [
      'MISSING_TOOL_NAME',
      { subType: 'BLACKLIST_SCENARIO_A', detectedPluginInMaid: 'LinuxShellExecutor' },
      { subType: 'ROLE_IN_TOOL_NAME', roleNameInTool: 'Nova' },
      'MISSING_TOOL_NAME' // duplicate to test deduplication
    ],
    floorNote: '【特别注意】本轮对话处于高敏感环境'
  });

  assert.equal(pillWithErrors.startsWith(PILL_HEADER_TAG), true);
  assert.equal(pillWithErrors.endsWith(PILL_CLOSING_TAG), true);
  assert.equal(pillWithErrors.includes('### 四、本会话防错专项警示'), true);
  assert.equal(pillWithErrors.includes('【必须指定工具】'), true);
  assert.equal(pillWithErrors.includes('【严禁署名错位】'), true);
  assert.equal(pillWithErrors.includes('【严禁工具名错位】'), true);
  assert.equal(pillWithErrors.includes('【特别注意】本轮对话处于高敏感环境'), true);

  // Must retain PluginSourceViewer
  assert.equal(pillWithErrors.includes('PluginSourceViewer'), true);
  assert.equal(pillWithErrors.includes('ServerPluginSourceViewer'), true);

  // Alias verification
  assert.equal(typeof assemblePermanentPill, 'function');
});
