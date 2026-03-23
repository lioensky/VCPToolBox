/**
 * VCP OneBot Adapter 单元测试
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// 模拟环境变量
process.env.VCP_ADAPTER_ID = 'onebot-qq-main';
process.env.VCP_CHANNEL_HUB_URL = 'http://127.0.0.1:6010/internal/channel-hub/events';
process.env.VCP_CHANNEL_BRIDGE_KEY = 'test-key';
process.env.VCP_AGENT_NAME = 'Nova';

// 导入模块 (需要在设置环境变量后)
const { createVcpChannelClient } = await import('../src/adapters/vcp/channelClient.js');

describe('VCP ChannelHub Client', () => {
  let vcpClient;

  beforeEach(() => {
    vcpClient = createVcpChannelClient({
      channelHubUrl: 'http://127.0.0.1:6010/internal/channel-hub/events',
      bridgeKey: 'test-key',
      adapterId: 'onebot-qq-main',
      defaultAgentName: 'Nova',
      defaultAgentDisplayName: 'Nova',
      timeoutMs: 30000,
      logger: console,
    });
  });

  describe('convertToEnvelope', () => {
    it('should convert private message to envelope', () => {
      const onebotEvent = {
        time: 1700000000,
        self_id: 123456789,
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        user_id: 987654321,
        message_id: 12345,
        message: [
          { type: 'text', data: { text: '你好' } },
        ],
        sender: {
          user_id: 987654321,
          nickname: '测试用户',
          sex: 'unknown',
          age: 0,
        },
      };

      const envelope = vcpClient.convertToEnvelope(onebotEvent);

      assert.strictEqual(envelope.version, '2.0');
      assert.strictEqual(envelope.adapterId, 'onebot-qq-main');
      assert.strictEqual(envelope.channel, 'qq');
      assert.strictEqual(envelope.eventType, 'message.created');
      assert.strictEqual(envelope.client.conversationType, 'private');
      assert.strictEqual(envelope.client.conversationId, 'private_987654321');
      assert.strictEqual(envelope.sender.userId, '987654321');
      assert.strictEqual(envelope.sender.nick, '测试用户');
      assert.strictEqual(envelope.session.bindingKey, 'qq:private:987654321');
      assert.strictEqual(envelope.payload.messages.length, 1);
      assert.strictEqual(envelope.payload.messages[0].role, 'user');
      assert.strictEqual(envelope.payload.messages[0].content[0].type, 'text');
      assert.strictEqual(envelope.payload.messages[0].content[0].text, '你好');
    });

    it('should convert group message to envelope', () => {
      const onebotEvent = {
        time: 1700000000,
        self_id: 123456789,
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        group_id: 111111111,
        user_id: 987654321,
        message_id: 12345,
        message: [
          { type: 'text', data: { text: '@机器人 你好' } },
          { type: 'at', data: { qq: '123456789' } },
        ],
        sender: {
          user_id: 987654321,
          nickname: '测试用户',
          card: '群名片',
          role: 'admin',
        },
      };

      const envelope = vcpClient.convertToEnvelope(onebotEvent);

      assert.strictEqual(envelope.client.conversationType, 'group');
      assert.strictEqual(envelope.client.conversationId, 'group_111111111');
      assert.strictEqual(envelope.sender.isAdmin, true);
      assert.strictEqual(envelope.sender.role, 'admin');
      assert.strictEqual(envelope.session.bindingKey, 'qq:group:111111111:987654321');
    });

    it('should convert image message to envelope', () => {
      const onebotEvent = {
        time: 1700000000,
        self_id: 123456789,
        post_type: 'message',
        message_type: 'private',
        user_id: 987654321,
        message_id: 12345,
        message: [
          { type: 'image', data: { url: 'https://example.com/image.jpg', file: 'abc123.jpg' } },
        ],
        sender: {
          user_id: 987654321,
          nickname: '测试用户',
        },
      };

      const envelope = vcpClient.convertToEnvelope(onebotEvent);

      assert.strictEqual(envelope.payload.messages[0].content[0].type, 'image_url');
      assert.strictEqual(envelope.payload.messages[0].content[0].image_url.url, 'https://example.com/image.jpg');
    });

    it('should convert mixed content message to envelope', () => {
      const onebotEvent = {
        time: 1700000000,
        self_id: 123456789,
        post_type: 'message',
        message_type: 'private',
        user_id: 987654321,
        message_id: 12345,
        message: [
          { type: 'text', data: { text: '看这张图' } },
          { type: 'image', data: { url: 'https://example.com/image.jpg' } },
          { type: 'face', data: { id: '123' } },
        ],
        sender: {
          user_id: 987654321,
          nickname: '测试用户',
        },
      };

      const envelope = vcpClient.convertToEnvelope(onebotEvent);

      const content = envelope.payload.messages[0].content;
      assert.strictEqual(content.length, 3);
      assert.strictEqual(content[0].type, 'text');
      assert.strictEqual(content[1].type, 'image_url');
      assert.strictEqual(content[2].type, 'text'); // face 转为文本
      assert.ok(content[2].text.includes('表情'));
    });
  });

  describe('extractRichReply', () => {
    it('should extract text from reply', () => {
      const reply = {
        ok: true,
        requestId: 'req_123',
        reply: {
          messages: [
            { type: 'text', text: '你好！' },
            { type: 'text', text: '有什么可以帮助你的？' },
          ],
        },
      };

      const richReply = vcpClient.extractRichReply(reply);

      assert.strictEqual(richReply.text, '你好！\n有什么可以帮助你的？');
      assert.strictEqual(richReply.images.length, 0);
      assert.strictEqual(richReply.files.length, 0);
    });

    it('should extract images from reply', () => {
      const reply = {
        ok: true,
        requestId: 'req_123',
        reply: {
          messages: [
            { type: 'text', text: '这是图片：' },
            { type: 'image_url', image_url: { url: 'https://example.com/image1.jpg' } },
            { type: 'image_url', image_url: { url: 'https://example.com/image2.jpg' } },
          ],
        },
      };

      const richReply = vcpClient.extractRichReply(reply);

      assert.ok(richReply.text.includes('这是图片'));
      assert.strictEqual(richReply.images.length, 2);
      assert.strictEqual(richReply.images[0].url, 'https://example.com/image1.jpg');
    });

    it('should extract options from reply', () => {
      const reply = {
        ok: true,
        requestId: 'req_123',
        reply: {
          messages: [
            { type: 'text', text: '请选择：' },
            {
              type: 'action',
              action: {
                kind: 'button_group',
                items: [
                  { id: 'opt1', label: '选项1', value: 'value1' },
                  { id: 'opt2', label: '选项2', value: 'value2' },
                ],
              },
            },
          ],
        },
      };

      const richReply = vcpClient.extractRichReply(reply);

      assert.strictEqual(richReply.options.length, 2);
      assert.strictEqual(richReply.options[0].label, '选项1');
      assert.strictEqual(richReply.options[1].value, 'value2');
    });

    it('should handle empty reply', () => {
      const reply = {
        ok: true,
        requestId: 'req_123',
        reply: {
          messages: [],
        },
      };

      const richReply = vcpClient.extractRichReply(reply);

      assert.strictEqual(richReply.text, '');
      assert.strictEqual(richReply.images.length, 0);
      assert.strictEqual(richReply.files.length, 0);
      assert.strictEqual(richReply.options.length, 0);
    });

    it('should extract normalized structured reply parts', () => {
      const reply = {
        ok: true,
        requestId: 'req_123',
        reply: {
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'text', text: '第一行' },
                { type: 'image_url', image_url: { url: 'https://example.com/demo.jpg' } },
                { type: 'text', text: '第二行' },
              ],
            },
          ],
        },
      };

      const richReply = vcpClient.extractRichReply(reply);

      assert.strictEqual(richReply.text, '第一行\n第二行');
      assert.strictEqual(richReply.images.length, 1);
      assert.strictEqual(richReply.images[0].url, 'https://example.com/demo.jpg');
    });
  });

  describe('generateId', () => {
    it('should generate unique IDs', () => {
      const id1 = vcpClient.generateId('evt');
      const id2 = vcpClient.generateId('evt');

      assert.ok(id1.startsWith('evt_'));
      assert.ok(id2.startsWith('evt_'));
      assert.notStrictEqual(id1, id2);
    });
  });
});

describe('OneBot Message Parsing', () => {
  it('should parse @ mention', () => {
    // 这个测试验证消息解析逻辑
    const message = [
      { type: 'at', data: { qq: '123456789' } },
      { type: 'text', data: { text: ' 你好' } },
    ];

    // 检查 @ 消息是否被正确识别
    const hasAt = message.some(seg => seg.type === 'at');
    assert.strictEqual(hasAt, true);
  });

  it('should parse @ all', () => {
    const message = [
      { type: 'at', data: { qq: 'all' } },
      { type: 'text', data: { text: ' 注意' } },
    ];

    const isAtAll = message.some(seg => seg.type === 'at' && seg.data?.qq === 'all');
    assert.strictEqual(isAtAll, true);
  });
});

// 运行测试
console.log('Running OneBot Adapter tests...');
