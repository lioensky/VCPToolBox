/**
 * test-channelHub-b1.js
 * 
 * ChannelHub B1 兼容层端到端测试
 * 
 * 测试内容：
 * 1. B1CompatTranslator.translateRequest() - B1 → B2 转换
 * 2. B1CompatTranslator.translateReply() - B2 → B1 转换
 * 3. /internal/channelHub/b1/ingest 端点（需要服务器运行）
 * 
 * 运行方式：
 * node test-channelHub-b1.js
 */

const B1CompatTranslator = require('./modules/channelHub/B1CompatTranslator');

// 测试颜色输出
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

function log(color, ...args) {
  console.log(colors[color], ...args, colors.reset);
}

function logSection(title) {
  console.log('\n' + '='.repeat(60));
  log('blue', `  ${title}`);
  console.log('='.repeat(60));
}

// ============================================================
// 测试 1: B1 → B2 转换
// ============================================================
function testTranslateRequest() {
  logSection('测试 1: B1 → B2 转换 (translateRequest)');

  const translator = new B1CompatTranslator({ debugMode: true });

  // 模拟钉钉适配器发送的 B1 格式请求
  const b1Request = {
    channel: 'dingtalk',
    agentId: 'Nova',
    agentName: '诺宝',
    itemType: 'agent',
    itemId: 'Nova',
    requestId: `dt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    stream: false,

    client: {
      clientType: 'dingtalk',
      clientId: 'dingtalk',
      conversationId: 'conv_123456',
      conversationType: 'group',
      conversationTitle: '测试群聊',
      messageId: 'msg_789',
      timestamp: Date.now()
    },

    sender: {
      userId: 'user_001',
      nick: '测试用户',
      isAdmin: false,
      corpId: 'corp_abc'
    },

    topicControl: {
      bindingKey: 'dingtalk:group:conv_123456:user_001',
      currentTopicId: null,
      allowCreateTopic: true,
      allowSwitchTopic: true
    },

    messages: [
      {
        role: 'user',
        content: '你好，这是一条测试消息'
      }
    ],

    modelConfig: {
      model: 'Nova',
      stream: false
    },

    vcpConfig: {
      runtimeOverrides: {
        baseURL: 'https://api.example.com',
        apiKey: 'sk-test-key',
        model: 'Nova',
        vcpTimeoutMs: 90000
      }
    }
  };

  try {
    const envelope = translator.translateRequest(b1Request, {
      'x-channel-bridge-key': 'test-key'
    });

    // 验证转换结果
    const checks = [
      { name: 'version', expected: '2.0', actual: envelope.version },
      { name: 'eventId 存在', expected: true, actual: !!envelope.eventId },
      { name: 'adapterId', expected: 'b1-compat', actual: envelope.adapterId },
      { name: 'channel', expected: 'dingtalk', actual: envelope.channel },
      { name: 'eventType', expected: 'message.created', actual: envelope.eventType },
      { name: 'target.agentId', expected: 'Nova', actual: envelope.target?.agentId },
      { name: 'client.conversationId', expected: 'conv_123456', actual: envelope.client?.conversationId },
      { name: 'sender.userId', expected: 'user_001', actual: envelope.sender?.userId },
      { name: 'session.bindingKey', expected: 'dingtalk:group:conv_123456:user_001', actual: envelope.session?.bindingKey },
      { name: 'payload.messages.length', expected: 1, actual: envelope.payload?.messages?.length },
      { name: 'runtime.model', expected: 'Nova', actual: envelope.runtime?.model },
      { name: 'metadata.source', expected: 'b1-compat', actual: envelope.metadata?.source }
    ];

    let passed = 0;
    let failed = 0;

    for (const check of checks) {
      const success = check.actual === check.expected;
      if (success) {
        log('green', `  ✓ ${check.name}: ${JSON.stringify(check.actual)}`);
        passed++;
      } else {
        log('red', `  ✗ ${check.name}: 期望 ${JSON.stringify(check.expected)}, 实际 ${JSON.stringify(check.actual)}`);
        failed++;
      }
    }

    log('yellow', `\n  测试结果: ${passed} 通过, ${failed} 失败`);
    
    return { passed, failed, envelope };
  } catch (error) {
    log('red', `  ✗ 转换失败: ${error.message}`);
    console.error(error.stack);
    return { passed: 0, failed: 1, error: error.message };
  }
}

// ============================================================
// 测试 2: B2 → B1 转换
// ============================================================
function testTranslateReply() {
  logSection('测试 2: B2 → B1 转换 (translateReply)');

  const translator = new B1CompatTranslator({ debugMode: true });

  // 模拟 B2 格式的运行时回复
  const b2Reply = {
    eventId: 'evt_123',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '你好！我是诺宝，很高兴为你服务。' },
          { type: 'text', text: '有什么我可以帮助你的吗？' }
        ]
      }
    ],
    topic: {
      resolvedTopicId: 'topic_456'
    },
    meta: {
      agentId: 'Nova',
      model: 'Nova'
    }
  };

  try {
    const b1Reply = translator.translateReply(b2Reply);

    // 验证转换结果
    const checks = [
      { name: 'reply.text 存在', expected: true, actual: !!b1Reply.reply?.text },
      { name: 'reply.text 包含内容', expected: true, actual: b1Reply.reply?.text?.includes('诺宝') },
      { name: 'reply.content 存在', expected: true, actual: !!b1Reply.reply?.content },
      { name: 'topicId', expected: 'topic_456', actual: b1Reply.topicId },
      { name: 'meta.agentId', expected: 'Nova', actual: b1Reply.meta?.agentId }
    ];

    let passed = 0;
    let failed = 0;

    for (const check of checks) {
      const success = check.actual === check.expected;
      if (success) {
        log('green', `  ✓ ${check.name}: ${JSON.stringify(check.actual)}`);
        passed++;
      } else {
        log('red', `  ✗ ${check.name}: 期望 ${JSON.stringify(check.expected)}, 实际 ${JSON.stringify(check.actual)}`);
        failed++;
      }
    }

    log('yellow', `\n  测试结果: ${passed} 通过, ${failed} 失败`);
    log('blue', `\n  转换后的 B1 响应:`);
    console.log(JSON.stringify(b1Reply, null, 2));

    return { passed, failed, b1Reply };
  } catch (error) {
    log('red', `  ✗ 转换失败: ${error.message}`);
    console.error(error.stack);
    return { passed: 0, failed: 1, error: error.message };
  }
}

// ============================================================
// 测试 3: 完整转换流程
// ============================================================
function testFullRoundTrip() {
  logSection('测试 3: 完整转换流程 (B1 → B2 → B1)');

  const translator = new B1CompatTranslator({ debugMode: true });

  // 原始 B1 请求
  const originalB1 = {
    channel: 'dingtalk',
    agentId: 'Nova',
    requestId: 'req_test_001',
    client: {
      conversationId: 'conv_test',
      conversationType: 'single'
    },
    sender: {
      userId: 'user_test',
      nick: '测试者'
    },
    topicControl: {
      bindingKey: 'test:binding:key'
    },
    messages: [
      { role: 'user', content: '测试消息' }
    ],
    modelConfig: {
      model: 'Nova'
    }
  };

  try {
    // B1 → B2
    log('blue', '  步骤 1: B1 → B2');
    const envelope = translator.translateRequest(originalB1);
    log('green', `    ✓ 转换成功, eventId: ${envelope.eventId}`);

    // 模拟 B2 处理后的回复
    log('blue', '  步骤 2: 模拟 B2 处理');
    const b2Reply = {
      eventId: envelope.eventId,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '收到你的测试消息，处理完成。' }]
        }
      ],
      topic: { resolvedTopicId: 'topic_new' },
      meta: { agentId: 'Nova', model: 'Nova' }
    };
    log('green', '    ✓ B2 回复已生成');

    // B2 → B1
    log('blue', '  步骤 3: B2 → B1');
    const finalB1 = translator.translateReply(b2Reply);
    log('green', `    ✓ 转换成功, reply.text 长度: ${finalB1.reply.text.length}`);

    // 验证完整性
    const checks = [
      { name: 'requestId 保持一致', expected: originalB1.requestId, actual: envelope.requestId },
      { name: 'agentId 保持一致', expected: originalB1.agentId, actual: envelope.target.agentId },
      { name: '最终响应包含 reply.text', expected: true, actual: !!finalB1.reply?.text }
    ];

    let passed = 0;
    let failed = 0;

    for (const check of checks) {
      const success = check.actual === check.expected;
      if (success) {
        log('green', `  ✓ ${check.name}`);
        passed++;
      } else {
        log('red', `  ✗ ${check.name}`);
        failed++;
      }
    }

    log('yellow', `\n  完整流程测试: ${passed} 通过, ${failed} 失败`);
    return { passed, failed };
  } catch (error) {
    log('red', `  ✗ 流程失败: ${error.message}`);
    console.error(error.stack);
    return { passed: 0, failed: 1, error: error.message };
  }
}

// ============================================================
// 测试 4: HTTP 端点测试（可选，需要服务器运行）
// ============================================================
async function testHttpEndpoint() {
  logSection('测试 4: HTTP 端点测试 (需要服务器运行)');

  const serverUrl = process.env.TEST_SERVER_URL || 'http://localhost:3000';
  const endpoint = `${serverUrl}/internal/channelHub/b1/ingest`;

  log('blue', `  目标端点: ${endpoint}`);

  const testPayload = {
    channel: 'dingtalk',
    agentId: 'Nova',
    requestId: `test_${Date.now()}`,
    client: {
      conversationId: 'test_conv',
      conversationType: 'single'
    },
    sender: {
      userId: 'test_user',
      nick: '测试用户'
    },
    messages: [
      { role: 'user', content: 'HTTP 端点测试' }
    ]
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-channel-bridge-key': process.env.Key || 'test-key'
      },
      body: JSON.stringify(testPayload)
    });

    if (response.ok) {
      const result = await response.json();
      log('green', `  ✓ 端点响应成功: ${response.status}`);
      log('green', `  ✓ 响应内容: ${JSON.stringify(result).slice(0, 100)}...`);
      return { passed: 1, failed: 0 };
    } else {
      log('yellow', `  ⚠ 端点响应: ${response.status} ${response.statusText}`);
      log('yellow', `  提示: 请确保服务器正在运行且配置正确`);
      return { passed: 0, failed: 0, skipped: true };
    }
  } catch (error) {
    log('yellow', `  ⚠ 无法连接到服务器: ${error.message}`);
    log('yellow', `  提示: 请先启动 VCPToolBox 服务器，或设置 TEST_SERVER_URL 环境变量`);
    return { passed: 0, failed: 0, skipped: true };
  }
}

// ============================================================
// 主测试运行器
// ============================================================
async function runTests() {
  console.log('\n' + '█'.repeat(60));
  log('blue', '  ChannelHub B1 兼容层测试套件');
  console.log('█'.repeat(60));

  const results = {
    test1: testTranslateRequest(),
    test2: testTranslateReply(),
    test3: testFullRoundTrip(),
    test4: await testHttpEndpoint()
  };

  // 汇总结果
  logSection('测试汇总');

  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const [name, result] of Object.entries(results)) {
    totalPassed += result.passed || 0;
    totalFailed += result.failed || 0;
    if (result.skipped) totalSkipped++;
  }

  console.log('');
  log('green', `  总通过: ${totalPassed}`);
  if (totalFailed > 0) {
    log('red', `  总失败: ${totalFailed}`);
  }
  if (totalSkipped > 0) {
    log('yellow', `  已跳过: ${totalSkipped}`);
  }

  console.log('');
  if (totalFailed === 0) {
    log('green', '  ✓ 所有测试通过！');
  } else {
    log('red', '  ✗ 存在失败的测试，请检查上述输出。');
  }

  console.log('\n' + '─'.repeat(60) + '\n');

  // 退出码
  process.exit(totalFailed > 0 ? 1 : 0);
}

// 运行测试
runTests().catch(error => {
  log('red', `测试运行失败: ${error.message}`);
  console.error(error);
  process.exit(1);
});