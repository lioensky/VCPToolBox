"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  replaceFirstPlaceholder,
  replaceOtherVariables,
  injectStaticPluginPlaceholders,
  injectStaticPluginPlaceholdersInMessages
} = require("../modules/messageProcessor.js");

test("replaceFirstPlaceholder 仅替换首次出现的占位符，且对包含 $ 符号的内容安全", () => {
  const text = "A {{VCPTest}} B {{VCPTest}} C";
  const replacement = "$100 Special $& Value";
  const result = replaceFirstPlaceholder(text, "{{VCPTest}}", replacement);
  assert.equal(result, "A $100 Special $& Value B  C");
});

test("单个工具占位符 {{VCP<toolname>}} 在单条系统消息中出现多次时仅展开一次", async () => {
  const mockDescriptions = new Map([
    ["VCPPowerShellExecutor", "PowerShell 执行器指令说明"]
  ]);

  const mockPluginManager = {
    getIndividualPluginDescriptions: () => mockDescriptions,
    getAllPlaceholderValues: () => new Map(),
    getResolvedPluginConfigValue: () => undefined
  };

  const context = {
    pluginManager: mockPluginManager,
    expandedVcpTools: new Set(),
    DEBUG_MODE: false
  };

  const text = "工具列表：\n{{VCPPowerShellExecutor}}\n重复引用：\n{{VCPPowerShellExecutor}}";
  const processed = await replaceOtherVariables(text, "mock-model", "system", context);

  // 验证内容只出现了一次
  const matches = processed.match(/PowerShell 执行器指令说明/g);
  assert.equal(matches?.length, 1);
  assert.equal(processed.includes("{{VCPPowerShellExecutor}}"), false);
  assert.equal(context.expandedVcpTools.has("VCPPowerShellExecutor"), true);
});

test("单个工具占位符 {{VCP<toolname>}} 跨消息时仅展开首次，后续消息清空占位符", async () => {
  const mockDescriptions = new Map([
    ["VCPEchoPlugin", "Echo 工具说明"]
  ]);

  const mockPluginManager = {
    getIndividualPluginDescriptions: () => mockDescriptions,
    getAllPlaceholderValues: () => new Map(),
    getResolvedPluginConfigValue: () => undefined
  };

  const context = {
    pluginManager: mockPluginManager,
    expandedVcpTools: new Set(),
    DEBUG_MODE: false
  };

  const msg1 = "消息1：{{VCPEchoPlugin}}";
  const res1 = await replaceOtherVariables(msg1, "mock-model", "system", context);
  assert.equal(res1, "消息1：Echo 工具说明");
  assert.equal(context.expandedVcpTools.has("VCPEchoPlugin"), true);

  const msg2 = "消息2：{{VCPEchoPlugin}}";
  const res2 = await replaceOtherVariables(msg2, "mock-model", "system", context);
  assert.equal(res2, "消息2：");
  assert.equal(res2.includes("Echo 工具说明"), false);
});

test("全局工具占位符 {{VCPAllTools}} 在同一消息中多次出现仅展开一次", async () => {
  const mockDescriptions = new Map([
    ["VCPA", "Tool A Description"],
    ["VCPB", "Tool B Description"]
  ]);

  const mockPluginManager = {
    getIndividualPluginDescriptions: () => mockDescriptions,
    getAllPlaceholderValues: () => new Map(),
    getResolvedPluginConfigValue: () => undefined
  };

  const context = {
    pluginManager: mockPluginManager,
    expandedGlobalPlaceholders: new Set(),
    DEBUG_MODE: false
  };

  const text = "全部工具：\n{{VCPAllTools}}\n又来一遍：\n{{VCPAllTools}}";
  const processed = await replaceOtherVariables(text, "mock-model", "system", context);

  const matches = processed.match(/Tool A Description/g);
  assert.equal(matches?.length, 1);
  assert.equal(processed.includes("{{VCPAllTools}}"), false);
  assert.equal(context.expandedGlobalPlaceholders.has("VCPAllTools"), true);
});

test("静态插件占位符在单条消息与跨消息均仅展开一次", async () => {
  const mockStaticValues = new Map([
    ["VCPChromePageInfo", { value: "网页标题：测试页面", serverId: "local" }]
  ]);

  const mockPluginManager = {
    getAllPlaceholderValues: () => mockStaticValues
  };

  const context = {
    pluginManager: mockPluginManager,
    expandedStaticPlaceholders: new Set(),
    DEBUG_MODE: false
  };

  const singleMsgText = "页面内容：{{VCPChromePageInfo}}，重复：{{VCPChromePageInfo}}";
  const singleResult = await injectStaticPluginPlaceholders(singleMsgText, context);

  const matches = singleResult.match(/网页标题：测试页面/g);
  assert.equal(matches?.length, 1);
  assert.equal(singleResult.includes("{{VCPChromePageInfo}}"), false);
  assert.equal(context.expandedStaticPlaceholders.has("VCPChromePageInfo"), true);

  // 跨消息测试
  const nextMsgText = "后续消息又包含：{{VCPChromePageInfo}}";
  const nextResult = await injectStaticPluginPlaceholders(nextMsgText, context);
  assert.equal(nextResult, "后续消息又包含：");
  assert.equal(nextResult.includes("网页标题：测试页面"), false);
});

test("普通行内变量（如时间、端口）不被去重拦截，保持全部替换", async () => {
  process.env.PORT = "6005";
  const mockPluginManager = {
    getIndividualPluginDescriptions: () => new Map(),
    getAllPlaceholderValues: () => new Map(),
    getResolvedPluginConfigValue: () => undefined
  };

  const context = {
    pluginManager: mockPluginManager,
    DEBUG_MODE: false
  };

  const text = "端口1: {{Port}}，端口2: {{Port}}";
  const processed = await replaceOtherVariables(text, "mock-model", "system", context);

  assert.equal(processed, "端口1: 6005，端口2: 6005");
});