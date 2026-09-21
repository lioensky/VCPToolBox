const assert = require('node:assert/strict');
const test = require('node:test');

const pluginManager = require('../Plugin');

test.after(() => {
  pluginManager.toolApprovalManager?.shutdown?.();
});
test('PluginManager exposes frozen Host Integration v1 capability metadata', () => {
  const capabilities = pluginManager.getIntegrationCapabilities();

  assert.deepEqual(capabilities, {
    hostIntegrationVersion: 1,
    approvalCorrelationVersion: 1,
    asyncCorrelationVersion: 1,
    approvalResponseMethod: 'handleApprovalResponse'
  });
  assert.equal(Object.isFrozen(capabilities), true);
  assert.equal(JSON.stringify(capabilities).includes('secret'), false);
  assert.equal(JSON.stringify(capabilities).includes('token'), false);
  assert.equal(JSON.stringify(capabilities).includes('key'), false);
});
