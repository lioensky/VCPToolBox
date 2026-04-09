const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'node-schedule') {
    return {};
  }
  if (request === 'dotenv') {
    return { config: () => ({}) };
  }
  if (request === 'express') {
    return () => ({});
  }
  if (request === 'chokidar') {
    return { watch: () => ({ on: () => {} }) };
  }
  if (request.endsWith('/FileFetcherServer.js') || request === './FileFetcherServer.js') {
    return {};
  }
  if (request.endsWith('/modules/captchaDecoder') || request === './modules/captchaDecoder') {
    return { getAuthCode: async () => null };
  }
  if (request.endsWith('/modules/toolApprovalManager') || request === './modules/toolApprovalManager') {
    return class ToolApprovalManager {
      shouldApprove() { return false; }
      getTimeoutMs() { return 0; }
    };
  }
  return originalLoad(request, parent, isMain);
};

const pluginManagerModule = require('../Plugin.js');
Module._load = originalLoad;

function createDistributedTool(overrides = {}) {
  return {
    name: 'DesktopRemote',
    displayName: 'DesktopRemote',
    pluginType: 'asynchronous',
    entryPoint: { command: 'node desktop-remote.js' },
    communication: { protocol: 'websocket' },
    ...overrides
  };
}

test('registerDistributedTools 会为相同 serverName 的分布式工具执行重绑定', () => {
  const manager = pluginManagerModule.__createTestInstance();
  let descriptionBuildCount = 0;
  manager.buildVCPDescription = () => {
    descriptionBuildCount += 1;
  };

  manager.registerDistributedTools('dist-old', 'stable-node', [createDistributedTool()]);
  const firstRegistration = manager.getPlugin('DesktopRemote');

  assert.equal(firstRegistration.serverId, 'dist-old');
  assert.equal(firstRegistration.serverName, 'stable-node');
  assert.equal(firstRegistration.displayName, '[云端] DesktopRemote');

  manager.registerDistributedTools('dist-new', 'stable-node', [createDistributedTool()]);
  const reboundRegistration = manager.getPlugin('DesktopRemote');

  assert.equal(reboundRegistration.serverId, 'dist-new');
  assert.equal(reboundRegistration.serverName, 'stable-node');
  assert.equal(reboundRegistration.displayName, '[云端] DesktopRemote');
  assert.equal(descriptionBuildCount, 2);
});

test('unregisterAllDistributedTools 不会误删已经重绑定到新 serverId 的工具', () => {
  const manager = pluginManagerModule.__createTestInstance();
  manager.buildVCPDescription = () => {};
  manager.clearDistributedStaticPlaceholders = () => {};

  manager.registerDistributedTools('dist-old', 'stable-node', [createDistributedTool()]);
  manager.registerDistributedTools('dist-new', 'stable-node', [createDistributedTool()]);

  manager.unregisterAllDistributedTools('dist-old');
  const registrationAfterOldDisconnect = manager.getPlugin('DesktopRemote');

  assert.ok(registrationAfterOldDisconnect);
  assert.equal(registrationAfterOldDisconnect.serverId, 'dist-new');

  manager.unregisterAllDistributedTools('dist-new');
  assert.equal(manager.getPlugin('DesktopRemote'), undefined);
});
