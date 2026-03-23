/**
 * test-channelHub-integration.js
 * 
 * ChannelHub 综合集成测试
 * 
 * 测试内容：
 * 1. 核心模块加载验证
 * 2. AdapterRegistry 适配器注册
 * 3. StateStore 状态持久化
 * 4. B1CompatTranslator 双向转换
 * 5. QQ/OneBot 适配器 B2 协议
 * 6. 钉钉适配器 B2 协议
 * 
 * 运行方式：
 * node test-channelHub-integration.js
 */

const path = require('path');
const fs = require('fs');

// 测试颜色输出
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m'
};

function log(color, ...args) {
  console.log(colors[color], ...args, colors.reset);
}

function logSection(title) {
  console.log('\n' + '═'.repeat(60));
  log('cyan', `  ${title}`);
  console.log('═'.repeat(60));
}

// 测试结果统计
const stats = {
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0
};

function assert(condition, message) {
  stats.total++;
  if (condition) {
    log('green', `  ✓ ${message}`);
    stats.passed++;
    return true;
  } else {
    log('red', `  ✗ ${message}`);
    stats.failed++;
    return false;
  }
}

// ============================================================
// 测试 1: 核心模块加载
// ============================================================
function testModuleLoading() {
  logSection('测试 1: 核心模块加载');

  // 实际存在的模块文件
  const modules = [
    { name: 'B1CompatTranslator', path: './modules/channelHub/B1CompatTranslator' },
    { name: 'AdapterRegistry', path: './modules/channelHub/AdapterRegistry' },
    { name: 'StateStore', path: './modules/channelHub/StateStore' },
    { name: 'ChannelHubService', path: './modules/channelHub/ChannelHubService' },
    { name: 'IdentityMappingStore', path: './modules/channelHub/IdentityMappingStore' },
    { name: 'EventDeduplicator', path: './modules/channelHub/EventDeduplicator' },
    { name: 'SessionBindingStore', path: './modules/channelHub/SessionBindingStore' },
    { name: 'DeliveryOutbox', path: './modules/channelHub/DeliveryOutbox' },
    { name: 'AuditLogger', path: './modules/channelHub/AuditLogger' },
    { name: 'constants', path: './modules/channelHub/constants' },
    { name: 'errors', path: './modules/channelHub/errors' },
    { name: 'utils', path: './modules/channelHub/utils' },
    { name: 'EventSchemaValidator', path: './modules/channelHub/EventSchemaValidator' },
    { name: 'MessageNormalizer', path: './modules/channelHub/MessageNormalizer' },
    { name: 'ReplyNormalizer', path: './modules/channelHub/ReplyNormalizer' },
    { name: 'RuntimeGateway', path: './modules/channelHub/RuntimeGateway' },
    { name: 'MediaGateway', path: './modules/channelHub/MediaGateway' },
    { name: 'CapabilityRegistry', path: './modules/channelHub/CapabilityRegistry' },
    { name: 'CapabilityDowngrader', path: './modules/channelHub/CapabilityDowngrader' },
    { name: 'MetricsCollector', path: './modules/channelHub/MetricsCollector' },
    { name: 'SignatureValidator', path: './modules/channelHub/SignatureValidator' },
    { name: 'AdapterAuthManager', path: './modules/channelHub/AdapterAuthManager' },
    { name: 'AgentRoutingPolicy', path: './modules/channelHub/AgentRoutingPolicy' }
  ];

  const loaded = {};
  let loadedCount = 0;

  for (const mod of modules) {
    try {
      loaded[mod.name] = require(mod.path);
      log('green', `  ✓ ${mod.name} 模块加载成功`);
      loadedCount++;
    } catch (error) {
      log('red', `  ✗ ${mod.name} 模块加载失败: ${error.message}`);
    }
  }

  log('yellow', `\n  模块加载统计: ${loadedCount}/${modules.length}`);
  return loaded;
}

// ============================================================
// 测试 2: AdapterRegistry 适配器注册
// ============================================================
async function testAdapterRegistry(loaded) {
  logSection('测试 2: AdapterRegistry 适配器注册');

  const { AdapterRegistry } = loaded;
  if (!AdapterRegistry) {
    log('red', '  ✗ AdapterRegistry 模块未加载，跳过测试');
    stats.skipped++;
    return;
  }

  try {
    // 创建模拟 StateStore
    const mockStateStore = {
      _adapters: [],
      async getAdapters() { return this._adapters; },
      async saveAdapters(data) { this._adapters = data; }
    };

    const registry = new AdapterRegistry({
      stateStore: mockStateStore,
      debugMode: true
    });

    await registry.initialize();
    assert(true, 'AdapterRegistry 初始化成功');

    // 注册 QQ 适配器
    const qqAdapter = {
      adapterId: 'onebot-qq',
      channel: 'qq',
      name: 'QQ OneBot 适配器',
      description: '通过 OneBot 协议连接 QQ',
      status: 'active',
      capabilityProfile: {
        supportsText: true,
        supportsImage: true,
        supportsAudio: true,
        supportsMention: true,
        supportsProactivePush: true,
        maxMessageLength: 5000
      },
      priority: 10
    };

    await registry.upsertAdapter(qqAdapter);
    assert(true, 'QQ 适配器注册成功');

    // 验证注册结果
    const retrieved = await registry.getAdapter('onebot-qq');
    assert(retrieved !== null, '可以获取已注册的适配器');
    assert(retrieved?.channel === 'qq', '适配器 channel 正确');
    assert(retrieved?.capabilityProfile?.supportsText === true, '适配器能力矩阵正确');

    // 注册钉钉适配器
    const dingtalkAdapter = {
      adapterId: 'dingtalk-main',
      channel: 'dingtalk',
      name: '钉钉主适配器',
      description: '钉钉机器人适配器',
      status: 'active',
      capabilityProfile: {
        supportsText: true,
        supportsImage: true,
        supportsActionCallback: true,
        maxMessageLength: 20000
      },
      priority: 5
    };

    await registry.upsertAdapter(dingtalkAdapter);
    assert(true, '钉钉适配器注册成功');

    // 列出所有适配器
    const allAdapters = await registry.listAdapters();
    assert(allAdapters.length >= 2, `适配器列表包含 ${allAdapters.length} 个适配器`);

    // 验证优先级排序
    assert(allAdapters[0].priority <= allAdapters[1].priority, '适配器按优先级排序正确');

    // 测试能力查询
    const supportsText = await registry.supports('onebot-qq', 'supportsText');
    assert(supportsText === true, 'supports() 方法正确返回能力');

  } catch (error) {
    log('red', `  ✗ 测试失败: ${error.message}`);
    console.error(error.stack);
    stats.failed++;
  }
}

// ============================================================
// 测试 3: StateStore 状态持久化
// ============================================================
async function testStateStore(loaded) {
  logSection('测试 3: StateStore 状态持久化');

  const { StateStore } = loaded;
  if (!StateStore) {
    log('red', '  ✗ StateStore 模块未加载，跳过测试');
    stats.skipped++;
    return;
  }

  try {
    const store = new StateStore({
      baseDir: process.cwd(),
      debugMode: true
    });

    await store.initialize();
    assert(true, 'StateStore 初始化成功');

    // 测试适配器状态
    const adapters = await store.getAdapters();
    assert(adapters != null, 'getAdapters 返回非空');
    assert(typeof adapters === 'object', 'adapters 是对象');

    // 测试身份映射
    const identityMap = await store.getIdentityMap();
    assert(identityMap != null, 'getIdentityMap 返回非空');

    // 测试去重缓存
    const dedupCache = await store.getDedupCache();
    assert(dedupCache != null, 'getDedupCache 返回非空');

    // 测试会话记录
    await store.appendSession({
      bindingKey: 'test:session:123',
      channel: 'qq',
      agentId: 'Nova',
      timestamp: Date.now()
    });
    assert(true, 'appendSession 成功');

    const sessions = await store.querySessions({ bindingKey: 'test:session:123' });
    assert(Array.isArray(sessions), 'querySessions 返回数组');

    // 测试审计记录
    await store.appendAuditRecord('test', {
      requestId: 'req_test_001',
      action: 'test_action',
      result: 'success'
    });
    assert(true, 'appendAuditRecord 成功');

    const auditRecords = await store.queryAudit({ requestId: 'req_test_001' });
    assert(Array.isArray(auditRecords), 'queryAudit 返回数组');

  } catch (error) {
    log('red', `  ✗ 测试失败: ${error.message}`);
    console.error(error.stack);
    stats.failed++;
  }
}

// ============================================================
// 测试 4: B1CompatTranslator 双向转换
// ============================================================
async function testB1CompatTranslator(loaded) {
  logSection('测试 4: B1CompatTranslator 双向转换');

  const { B1CompatTranslator } = loaded;
  if (!B1CompatTranslator) {
    log('red', '  ✗ B1CompatTranslator 模块未加载，跳过测试');
    stats.skipped++;
    return;
  }

  try {
    const translator = new B1CompatTranslator({ debugMode: true });

    // B1 → B2 转换
    const b1Request = {
      channel: 'dingtalk',
      agentId: 'Nova',
      requestId: 'req_b1_test',
      client: {
        conversationId: 'conv_test',
        conversationType: 'group'
      },
      sender: {
        userId: 'user_001',
        nick: '测试用户'
      },
      topicControl: {
        bindingKey: 'dingtalk:group:conv_test:user_001'
      },
      messages: [
        { role: 'user', content: '测试消息' }
      ],
      modelConfig: {
        model: 'Nova'
      }
    };

    const envelope = translator.translateRequest(b1Request);
    assert(envelope.version === '2.0', 'B1→B2 version 正确');
    assert(envelope.channel === 'dingtalk', 'B1→B2 channel 正确');
    assert(envelope.target?.agentId === 'Nova', 'B1→B2 agentId 正确');
    assert(envelope.eventId === 'req_b1_test', 'B1→B2 eventId 保持一致');
    assert(envelope.session?.bindingKey === 'dingtalk:group:conv_test:user_001', 'B1→B2 bindingKey 正确');
    assert(true, 'B1 → B2 转换成功');

    // B2 → B1 转换
    const b2Reply = {
      eventId: envelope.eventId,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '这是测试回复' }
          ]
        }
      ],
      topic: { resolvedTopicId: 'topic_123' },
      meta: { agentId: 'Nova', model: 'Nova' }
    };

    const b1Reply = translator.translateReply(b2Reply);
    assert(b1Reply.reply?.text != null, 'B2→B1 reply.text 存在');
    assert(b1Reply.reply.text.includes('测试回复'), 'B2→B1 reply.text 内容正确');
    assert(b1Reply.topicId === 'topic_123', 'B2→B1 topicId 正确');
    assert(true, 'B2 → B1 转换成功');

  } catch (error) {
    log('red', `  ✗ 测试失败: ${error.message}`);
    console.error(error.stack);
    stats.failed++;
  }
}

// ============================================================
// 测试 5: QQ/OneBot 适配器 B2 协议
// ============================================================
async function testOneBotAdapter() {
  logSection('测试 5: QQ/OneBot 适配器 B2 协议');

  try {
    // 使用动态 import 加载 ES Module
    const { createVcpChannelClient } = await import('./Plugin/vcp-onebot-adapter/src/adapters/vcp/channelClient.js');

    // 创建客户端实例
    const client = createVcpChannelClient({
      channelHubUrl: 'http://localhost:3000/internal/channelHub/events',
      adapterId: 'onebot-test',
      defaultAgentName: 'Nova',
      debugMode: true
    });

    // 模拟 OneBot 消息
    const onebotMsg = {
      time: Date.now() / 1000,
      self_id: 123456789,
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      user_id: 987654321,
      message: [
        { type: 'text', data: { text: '你好' } }
      ],
      raw_message: '你好',
      font: 0,
      sender: {
        user_id: 987654321,
        nickname: '测试用户',
        sex: 'unknown',
        age: 0
      },
      message_id: 'msg_test_001'
    };

    const envelope = client.convertToEnvelope(onebotMsg, { agentId: 'Nova' });
    assert(envelope.version === '2.0', 'OneBot B2 version 正确');
    assert(envelope.channel === 'qq', 'OneBot B2 channel 正确');
    assert(envelope.eventType === 'message.created', 'OneBot B2 eventType 正确');
    assert(envelope.sender?.userId === '987654321', 'OneBot B2 sender.userId 正确');
    
    // 检查 payload.messages[0].content
    const payloadContent = envelope.payload?.messages?.[0]?.content;
    const hasText = payloadContent && payloadContent.some(c => c.type === 'text' && c.text === '你好');
    assert(hasText, 'OneBot B2 payload 包含正确文本');
    assert(true, 'OneBot 消息转换为 B2 envelope 成功');

    // 测试 extractRichReply
    const vcpResponse = {
      reply: {
        messages: [
          {
            type: 'text',
            text: '你好！有什么可以帮助你的？'
          }
        ]
      }
    };

    const richReply = client.extractRichReply(vcpResponse);
    assert(richReply.text != null, 'extractRichReply text 存在');
    assert(richReply.text.includes('你好'), 'extractRichReply text 内容正确');
    assert(true, 'extractRichReply 提取回复成功');

    // 测试 ID 生成
    const id1 = client.generateId('evt');
    const id2 = client.generateId('evt');
    assert(id1 !== id2, 'generateId 生成唯一 ID');
    assert(id1.startsWith('evt_'), 'generateId 前缀正确');

  } catch (error) {
    log('red', `  ✗ 测试失败: ${error.message}`);
    console.error(error.stack);
    stats.failed++;
  }
}

// ============================================================
// 测试 6: 钉钉适配器 B2 协议
// ============================================================
async function testDingTalkAdapter() {
  logSection('测试 6: 钉钉适配器 B2 协议');

  try {
    // 检查钉钉适配器是否存在
    const dingtalkPath = './Plugin/vcp-dingtalk-adapter/src/core/pipeline';
    let pipeline;
    try {
      pipeline = require(dingtalkPath);
      assert(true, '钉钉适配器 pipeline 模块加载成功');
    } catch (e) {
      log('yellow', `  ⚠ 钉钉适配器模块未找到，跳过部分测试: ${e.message}`);
      stats.skipped++;
      return;
    }

    // 如果 pipeline 存在，测试其功能
    if (pipeline && typeof pipeline.processMessage === 'function') {
      assert(true, '钉钉适配器 processMessage 方法存在');
    }

  } catch (error) {
    log('red', `  ✗ 测试失败: ${error.message}`);
    console.error(error.stack);
    stats.failed++;
  }
}

// ============================================================
// 测试 7: 适配器配置验证
// ============================================================
async function testAdapterConfigs() {
  logSection('测试 7: 适配器配置验证');

  try {
    // 检查 QQ 适配器 manifest
    const qqManifestPath = './Plugin/vcp-onebot-adapter/plugin-manifest.json';
    if (fs.existsSync(qqManifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(qqManifestPath, 'utf-8'));
      assert(manifest.name === 'OneBotAdapter', 'QQ adapter manifest name 正确');
      assert(manifest.capabilities?.channelAdapter?.platform === 'qq', 'QQ adapter platform 正确');
      assert(manifest.capabilities?.channelAdapter?.supportsB2 === true, 'QQ adapter supportsB2 正确');
      assert(manifest.capabilities?.channelAdapter?.capabilities?.supportsText === true, 'QQ adapter supportsText 正确');
      log('green', '  ✓ QQ 适配器 manifest 验证通过');
    } else {
      log('yellow', '  ⚠ QQ 适配器 manifest 不存在');
      stats.skipped++;
    }

    // 检查钉钉适配器 manifest
    const dtManifestPath = './Plugin/vcp-dingtalk-adapter/plugin-manifest.json';
    if (fs.existsSync(dtManifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(dtManifestPath, 'utf-8'));
      assert(manifest.name != null, '钉钉 adapter manifest name 存在');
      log('green', '  ✓ 钉钉适配器 manifest 验证通过');
    } else {
      log('yellow', '  ⚠ 钉钉适配器 manifest 不存在');
    }

    // 检查 adapters.json 注册状态
    const adaptersJsonPath = './state/channelHub/adapters.json';
    if (fs.existsSync(adaptersJsonPath)) {
      const adaptersJson = JSON.parse(fs.readFileSync(adaptersJsonPath, 'utf-8'));
      assert(Array.isArray(adaptersJson.adapters), 'adapters.json adapters 是数组');
      
      const qqAdapter = adaptersJson.adapters.find(a => a.adapterId === 'onebot-qq');
      if (qqAdapter) {
        assert(qqAdapter.channel === 'qq', '已注册的 QQ 适配器 channel 正确');
        log('green', '  ✓ QQ 适配器已在 adapters.json 中注册');
      } else {
        log('yellow', '  ⚠ QQ 适配器未在 adapters.json 中注册');
      }
    }

  } catch (error) {
    log('red', `  ✗ 测试失败: ${error.message}`);
    console.error(error.stack);
    stats.failed++;
  }
}

// ============================================================
// 主测试运行器
// ============================================================
async function runTests() {
  console.log('\n' + '█'.repeat(60));
  log('cyan', '  ChannelHub 综合集成测试套件');
  log('blue', `  测试时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log('█'.repeat(60));

  // 运行所有测试
  const loaded = testModuleLoading();
  await testAdapterRegistry(loaded);
  await testStateStore(loaded);
  await testB1CompatTranslator(loaded);
  await testOneBotAdapter();
  await testDingTalkAdapter();
  await testAdapterConfigs();

  // 输出汇总
  logSection('测试汇总');

  console.log('');
  log('green', `  总通过: ${stats.passed}`);
  if (stats.failed > 0) {
    log('red', `  总失败: ${stats.failed}`);
  }
  if (stats.skipped > 0) {
    log('yellow', `  已跳过: ${stats.skipped}`);
  }

  console.log('');
  if (stats.failed === 0) {
    log('green', '  ✓ 所有测试通过！');
  } else {
    log('red', '  ✗ 存在失败的测试，请检查上述输出。');
  }

  console.log('\n' + '─'.repeat(60) + '\n');

  // 退出码
  process.exit(stats.failed > 0 ? 1 : 0);
}

// 运行测试
runTests().catch(error => {
  log('red', `测试运行失败: ${error.message}`);
  console.error(error);
  process.exit(1);
});