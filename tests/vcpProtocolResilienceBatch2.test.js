'use strict';

if (process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE === undefined) {
  process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = 'true';
}

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyClosedBlockError
} = require('../modules/vcpProtocolResilience/classifier');

const {
  scanContentBlocks,
  isStandaloneMarkerLine,
  findProtectionAreas
} = require('../modules/vcpProtocolResilience/scanner');

// ==========================================
// Test Suite 2: classifier.js (Priority 1 -> 2 -> 3)
// ==========================================
test('classifier.js: Priority 1 intercepts empty or malformed fields blocks', () => {
  const emptyBlock = '<<<[TOOL_REQUEST]>>>\n<<<[END_TOOL_REQUEST]>>>';
  const err1 = classifyClosedBlockError(emptyBlock);
  assert.ok(err1);
  assert.equal(err1.errorCode, 'EMPTY_OR_MALFORMED_FIELDS');

  const whitespaceBlock = '<<<[TOOL_REQUEST]>>>\n   \n\t  \n<<<[END_TOOL_REQUEST]>>>';
  const err2 = classifyClosedBlockError(whitespaceBlock);
  assert.ok(err2);
  assert.equal(err2.errorCode, 'EMPTY_OR_MALFORMED_FIELDS');
});

test('classifier.js: Priority 2 intercepts MALFORMED_BLOCK_SYNTAX (equal, colon, quotes, fuzzy)', () => {
  // Equal sign assignment
  const equalBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name="LinuxShellExecutor",',
    'command="ls"',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const errEq = classifyClosedBlockError(equalBlock);
  assert.ok(errEq);
  assert.equal(errEq.errorCode, 'MALFORMED_BLOCK_SYNTAX');
  assert.equal(errEq.subType, 'EQUAL_ASSIGNMENT');

  // Full-width colon
  const fullColonBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name：「始」LinuxShellExecutor「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const errFc = classifyClosedBlockError(fullColonBlock);
  assert.ok(errFc);
  assert.equal(errFc.errorCode, 'MALFORMED_BLOCK_SYNTAX');
  assert.equal(errFc.subType, 'FULL_WIDTH_COLON');

  // Normal quotes replacing delimiters
  const quoteBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name: "LinuxShellExecutor"',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const errQuote = classifyClosedBlockError(quoteBlock);
  assert.ok(errQuote);
  assert.equal(errQuote.errorCode, 'MALFORMED_BLOCK_SYNTAX');
  assert.equal(errQuote.subType, 'QUOTES_WITHOUT_DELIMITERS');

  // Fuzzy delimiters when fuzzyToolMatching is false
  const fuzzyBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:{始}Nova{末},',
    'tool_name:{始}LinuxShellExecutor{末}',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const errFuzzy = classifyClosedBlockError(fuzzyBlock, { fuzzyToolMatching: false });
  assert.ok(errFuzzy);
  assert.equal(errFuzzy.errorCode, 'MALFORMED_BLOCK_SYNTAX');
  assert.equal(errFuzzy.subType, 'FUZZY_DELIMITER_DISALLOWED');
});

test('classifier.js: Priority 2 duplicate key conflict vs stutter invariant', () => {
  // Conflicting values
  const conflictBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'tool_name:「始」PTYShellExecutor「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const errConflict = classifyClosedBlockError(conflictBlock);
  assert.ok(errConflict);
  assert.equal(errConflict.errorCode, 'MALFORMED_BLOCK_SYNTAX');
  assert.equal(errConflict.isDuplicateConflict, true);

  // Stutter invariant: identical repeated values silently pass
  const stutterBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'command:「始」ls「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const stutterRes = classifyClosedBlockError(stutterBlock);
  assert.equal(stutterRes, null); // completely passes!
});

test('classifier.js: Priority 2 intercepts UNCLOSED_FIELD and nested ESCAPE', () => {
  // Unclosed field
  const unclosedFieldBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor,', // missing 「末」
    'command:「始」ls「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const errUnclosed = classifyClosedBlockError(unclosedFieldBlock);
  assert.ok(errUnclosed);
  assert.equal(errUnclosed.errorCode, 'UNCLOSED_FIELD');

  // Nested ESCAPE >= 2
  const nestedEscapeBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」WriteEscapedFile「末」,',
    'content:「始ESCAPE」outer「始ESCAPE」nested「末ESCAPE」「末ESCAPE」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const errNested = classifyClosedBlockError(nestedEscapeBlock);
  assert.ok(errNested);
  assert.equal(errNested.errorCode, 'UNCLOSED_FIELD');
  assert.equal(errNested.subType, 'NESTED_ESCAPE');
});

test('classifier.js: Priority 2 intercepts INVALID_TOOL_NAME (casing, invalid chars, blacklist)', () => {
  // Control key casing mismatch
  const casingBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'Tool_Name:「始」LinuxShellExecutor「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const errCasing = classifyClosedBlockError(casingBlock);
  assert.ok(errCasing);
  assert.equal(errCasing.errorCode, 'INVALID_TOOL_NAME');
  assert.equal(errCasing.subType, 'KEY_CASING_MISMATCH');

  // Invalid key characters (hyphen)
  const hyphenBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool-name:「始」LinuxShellExecutor「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const errHyphen = classifyClosedBlockError(hyphenBlock);
  assert.ok(errHyphen);
  assert.equal(errHyphen.errorCode, 'INVALID_TOOL_NAME');
  assert.equal(errHyphen.subType, 'INVALID_KEY_CHARACTERS');

  // Role name in tool_name
  const mockAgentManager = { isAgent(n) { return n === 'Nova'; } };
  const roleInToolBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」Nova「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const errRole = classifyClosedBlockError(roleInToolBlock, { agentManager: mockAgentManager });
  assert.ok(errRole);
  assert.equal(errRole.errorCode, 'INVALID_TOOL_NAME');
  assert.equal(errRole.roleNameInTool, 'Nova');

  // Scenario B: tool_name filled but maid has plugin
  const mockPluginManager = { getPlugin(n) { return n === 'PTYShellExecutor' ? { name: n } : null; } };
  const scenarioBBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」PTYShellExecutor「末」,',
    'tool_name:「始」LinuxShellExecutor「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const errScenB = classifyClosedBlockError(scenarioBBlock, { pluginManager: mockPluginManager });
  assert.ok(errScenB);
  assert.equal(errScenB.errorCode, 'INVALID_TOOL_NAME');
  assert.equal(errScenB.pluginInMaid, 'PTYShellExecutor');
});

test('classifier.js: Priority 3 missing keys and preemption rules', () => {
  // Missing tool_name (and no JEV)
  const noToolBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'command:「始」ls「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const errNoTool = classifyClosedBlockError(noToolBlock);
  assert.ok(errNoTool);
  assert.equal(errNoTool.errorCode, 'MISSING_TOOL_NAME');

  // Missing maid/valet
  const noMaidBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'command:「始」ls「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const errNoMaid = classifyClosedBlockError(noMaidBlock);
  assert.ok(errNoMaid);
  assert.equal(errNoMaid.errorCode, 'MISSING_MAID');

  // Missing both tool_name and maid -> strictly preempts to MISSING_TOOL_NAME
  const noToolNoMaidBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'command:「始」ls「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const errBoth = classifyClosedBlockError(noToolNoMaidBlock);
  assert.ok(errBoth);
  assert.equal(errBoth.errorCode, 'MISSING_TOOL_NAME');

  // JEV exemption: JEV does not require tool_name, but requires maid
  const jevLegalBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'JEV:「始」请使用 {能力} 搜索【教程】「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const jevRes = classifyClosedBlockError(jevLegalBlock);
  assert.equal(jevRes, null); // Legal!
});

test('classifier.js: 100% legal standard calls pass with null', () => {
  const legalBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'command:「始」ls -la「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');
  const res = classifyClosedBlockError(legalBlock);
  assert.equal(res, null);
});

// ==========================================
// Test Suite 3: scanner.js (Tristate State Machine)
// ==========================================
test('scanner.js: isStandaloneMarkerLine strictly enforces line bounds and space rules', () => {
  const text = [
    '<<<[TOOL_REQUEST]>>>',       // 0: valid standalone (0 spaces)
    '   <<<[TOOL_REQUEST]>>>',     // 1: valid standalone (3 spaces)
    '    <<<[TOOL_REQUEST]>>>',    // 2: invalid (4 spaces)
    '\t<<<[TOOL_REQUEST]>>>',      // 3: invalid (tab)
    'echo "<<<[TOOL_REQUEST]>>>"'  // 4: invalid (inline)
  ].join('\n');

  const idx0 = text.indexOf('<<<[TOOL_REQUEST]>>>');
  assert.equal(isStandaloneMarkerLine(text, idx0, 20), true);

  const idx1 = text.indexOf('   <<<[TOOL_REQUEST]>>>') + 3;
  assert.equal(isStandaloneMarkerLine(text, idx1, 20), true);

  const idx2 = text.indexOf('    <<<[TOOL_REQUEST]>>>') + 4;
  assert.equal(isStandaloneMarkerLine(text, idx2, 20), false);

  const idx3 = text.indexOf('\t<<<[TOOL_REQUEST]>>>') + 1;
  assert.equal(isStandaloneMarkerLine(text, idx3, 20), false);

  const idx4 = text.indexOf('echo "') + 6;
  assert.equal(isStandaloneMarkerLine(text, idx4, 20), false);
});

test('scanner.js: Phase 0 shields markdown fences and HTML code blocks', async () => {
  const fencedText = [
    'Here is an example in a markdown code block:',
    '```vcp',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」',
    '<<<[END_TOOL_REQUEST]>>>',
    '```',
    'And normal text.'
  ].join('\n');

  const res = await scanContentBlocks(fencedText);
  // Code inside markdown fence is 100% shielded
  assert.equal(res.protocolErrors.length, 0);
  assert.equal(res.blocks.length, 0);
});

test('scanner.js: unclosed block 1 before closed block 2 does not swallow closed block 2', async () => {
  const continuousBlocks = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'command:「始」ls「末」',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」PTYShellExecutor「末」,',
    'command:「始」pwd「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const res = await scanContentBlocks(continuousBlocks);

  // V2: 未闭合块由流式缓冲截杀，同步扫描器不报 Category IV，同时保证块 2 独立放行
  assert.equal(res.protocolErrors.length, 0);
  assert.equal(res.blocks.length, 1);
  assert.equal(res.blocks[0].isClosed, true);
  assert.equal(res.blocks[0].rawText.includes('PTYShellExecutor'), true);
});

test('scanner.js: bare prose with field-like lines produces zero Category V false positives', async () => {
  const bareShortText = [
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'command:「始」ls「末」',
    '',
    'Quick check!'
  ].join('\n');

  const res = await scanContentBlocks(bareShortText);
  assert.equal(res.protocolErrors.length, 0);
  assert.equal(res.blocks.length, 0);
});

test('classifier.js [P1-1 Regression]: permits Shell script with equals and JSON parameters without false-positives', () => {
  // Shell script containing = and quotes inside 「始」...「末」
  const shellBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'command:「始」',
    'FOO=1',
    'BAR="test"',
    'echo $FOO $BAR',
    '「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const shellRes = classifyClosedBlockError(shellBlock);
  assert.equal(shellRes, null); // Must 100% pass!

  // JSON payload containing quotes, colons, and braces inside 「始」...「末」
  const jsonBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」CustomPlugin「末」,',
    'payload:「始」{"key": "value", "list": [1, 2, 3], "nested": {"a": "b"}}「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const jsonRes = classifyClosedBlockError(jsonBlock);
  assert.equal(jsonRes, null); // Must 100% pass!
});

test('scanner.js [P1-2 Regression]: handles 1~3 leading spaces on markers without falling into Category V', async () => {
  const indentedBlock = [
    '   <<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'command:「始」ls -la「末」',
    '   <<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const res = await scanContentBlocks(indentedBlock);
  assert.equal(res.protocolErrors.length, 0); // No error, not misdiagnosed as V-TIER1!
  assert.equal(res.blocks.length, 1);
  assert.equal(res.blocks[0].type, 'CLOSED');
  assert.equal(res.blocks[0].isClosed, true);
});

test('scanner.js [P1-3 Regression]: WriteEscapedFile single-layer ESCAPE shields inner tool markers from IV-1 Clean Cut', async () => {
  const writeEscapedBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」WriteEscapedFile「末」,',
    'path:「始」/tmp/sample.txt「末」,',
    'content:「始ESCAPE」',
    '// Embedded tool request example for documentation:',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'command:「始」ls「末」',
    '<<<[END_TOOL_REQUEST]>>>',
    '「末ESCAPE」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const res = await scanContentBlocks(writeEscapedBlock);
  assert.equal(res.protocolErrors.length, 0); // No IV-1 Clean Cut!
  assert.equal(res.blocks.length, 1);
  assert.equal(res.blocks[0].type, 'CLOSED');
  assert.equal(res.blocks[0].isClosed, true);
  assert.equal(res.blocks[0].rawText.includes('WriteEscapedFile'), true);
});

// ==========================================
// Test Suite 4: 对抗性与深度重构回归测试
// ==========================================
test('classifier.js [Adversarial]: permits parameter payload containing single 「始 delimiter without UNCLOSED_FIELD false positive', () => {
  const blockWithShi = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」LinuxShellExecutor「末」,',
    'command:「始」echo "从「始」至「终」"「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const err = classifyClosedBlockError(blockWithShi);
  assert.equal(err, null, '合法参数内含「始字绝不能被误判为 UNCLOSED_FIELD');
});
