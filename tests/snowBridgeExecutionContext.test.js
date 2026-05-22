const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const snowBridgePath = path.join(__dirname, '..', 'Plugin', 'SnowBridge', 'index.js');

test('SnowBridge tags bridged tool calls with snowbridge execution context', () => {
	const source = fs.readFileSync(snowBridgePath, 'utf8');
	const methodStart = source.indexOf('async handleExecuteTool(serverId, message, pluginManager)');
	assert.notEqual(methodStart, -1, 'handleExecuteTool should exist');

	const methodEnd = source.indexOf('\n\tasync processToolCall', methodStart);
	assert.notEqual(methodEnd, -1, 'handleExecuteTool should end before processToolCall');

	const methodSource = source.slice(methodStart, methodEnd);
	assert.match(methodSource, /pluginManager\.processToolCall\(\s*toolName,\s*toolArgs,\s*null,\s*\{\s*requestSource:\s*'snowbridge',\s*bridgeId:\s*serverId,\s*invocationId,?\s*\},?\s*\)/);
});
