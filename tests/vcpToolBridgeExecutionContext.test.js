const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const vcpToolBridgePath = path.join(__dirname, '..', 'Plugin', 'VCPToolBridge', 'index.js');

test('VCPToolBridge tags bridged tool calls with vcp-tool-bridge execution context', () => {
    const source = fs.readFileSync(vcpToolBridgePath, 'utf8');
    const methodStart = source.indexOf('async handleExecuteTool(serverId, message, pluginManager)');
    assert.notEqual(methodStart, -1, 'handleExecuteTool should exist');

    const methodEnd = source.indexOf('\n    async processToolCall(args)', methodStart);
    assert.notEqual(methodEnd, -1, 'handleExecuteTool should end before processToolCall');

    const methodSource = source.slice(methodStart, methodEnd);
    assert.match(methodSource, /pluginManager\.processToolCall\(\s*toolName,\s*toolArgs,\s*null,\s*\{\s*requestSource:\s*'vcp-tool-bridge',\s*bridgeId:\s*serverId,\s*invocationId:\s*requestId\s*\}\s*\)/);
});
