const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const TopicOutbox = require('../Plugin/TopicOutbox/TopicOutbox.js');

class FakePluginManager extends EventEmitter {
  constructor() {
    super();
    this.online = false;
    this.calls = [];
    this.failuresRemaining = 0;
  }

  getPlugin(name) {
    if (name === 'TopicSponsor' && this.online) {
      return { name: 'TopicSponsor', isDistributed: true, serverId: 'fake-vchat' };
    }
    return null;
  }

  async processToolCall(toolName, args) {
    this.calls.push({ toolName, args });

    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('simulated delivery failure');
    }

    if (args.command === 'CreateTopic') {
      return {
        status: 'success',
        result: {
          topic_id: `topic_${this.calls.length}`,
          topic_name: args.topic_name,
          agent_name: args.maid
        }
      };
    }

    if (args.command === 'ReplyToTopic') {
      return {
        status: 'success',
        result: {
          topic_id: args.topic_id,
          message_id: `msg_${this.calls.length}`,
          sender: args.sender_name
        }
      };
    }

    throw new Error(`unexpected command: ${args.command}`);
  }
}

test.afterEach(async () => {
  await TopicOutbox.shutdown();
});

test('offline CreateTopicRequest is persisted, idempotent, and rejects conflicting payloads', async () => {
  const { storePath, pluginManager } = await setupTopicOutbox();

  const first = await TopicOutbox.processToolCall({
    command: 'CreateTopicRequest',
    topicRequestId: 'memo-dream-test-001',
    maid: '记忆大师',
    topic_name: '待审批：测试',
    initial_message: '审批摘要',
    metadata: { source: 'test' }
  });

  assert.equal(first.status, 'success');
  assert.equal(first.idempotent, false);
  assert.equal(first.topicRequest.status, 'pending');
  assert.equal(pluginManager.calls.length, 0);

  const duplicate = await TopicOutbox.processToolCall({
    command: 'CreateTopicRequest',
    topicRequestId: 'memo-dream-test-001',
    maid: '记忆大师',
    topic_name: '待审批：测试',
    initial_message: '审批摘要'
  });

  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.topicRequest.status, 'pending');

  await assert.rejects(
    () => TopicOutbox.processToolCall({
      command: 'CreateTopicRequest',
      topicRequestId: 'memo-dream-test-001',
      maid: '记忆大师',
      topic_name: '冲突标题',
      initial_message: '审批摘要'
    }),
    /topicRequestId conflict/
  );

  const raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
  assert.equal(raw.requests.length, 1);
});

test('CancelTopicRequest cancels a not-yet-delivered request', async () => {
  await setupTopicOutbox();

  await TopicOutbox.processToolCall({
    command: 'ReplyToTopicRequest',
    topicRequestId: 'memo-dream-test-reply-001',
    maid: '记忆大师',
    topic_id: 'topic_existing',
    message: '状态更新',
    sender_name: '记忆大师'
  });

  const cancelled = await TopicOutbox.processToolCall({
    command: 'CancelTopicRequest',
    topicRequestId: 'memo-dream-test-reply-001'
  });

  assert.equal(cancelled.topicRequest.status, 'cancelled');

  const list = await TopicOutbox.processToolCall({
    command: 'ListTopicRequests',
    status: 'cancelled'
  });
  assert.equal(list.count, 1);
});

test('distributed_register drains pending create and reply requests through TopicSponsor', async () => {
  const { pluginManager } = await setupTopicOutbox();

  await TopicOutbox.processToolCall({
    command: 'CreateTopicRequest',
    topicRequestId: 'memo-dream-test-create-drain',
    maid: '记忆大师',
    topic_name: '待审批：自动投递',
    initial_message: '审批摘要'
  });

  await TopicOutbox.processToolCall({
    command: 'ReplyToTopicRequest',
    topicRequestId: 'memo-dream-test-reply-drain',
    maid: '记忆大师',
    topic_id: 'topic_existing',
    message: '审批状态更新',
    sender_name: '记忆大师'
  });

  pluginManager.online = true;
  pluginManager.emit('tools_changed', { reason: 'distributed_register' });

  await waitFor(async () => {
    const delivered = await TopicOutbox.processToolCall({
      command: 'ListTopicRequests',
      status: 'delivered',
      limit: 10
    });
    return delivered.count === 2;
  });

  assert.equal(pluginManager.calls.length, 2);
  assert.deepEqual(pluginManager.calls.map(call => call.args.command), ['CreateTopic', 'ReplyToTopic']);

  const delivered = await TopicOutbox.processToolCall({
    command: 'ListTopicRequests',
    status: 'delivered',
    limit: 10
  });
  assert.ok(delivered.requests.every(item => item.delivery && item.delivery.targetTool === 'TopicSponsor'));
});

test('delivery failures are recorded and stop retrying after maxAttempts', async () => {
  const { pluginManager } = await setupTopicOutbox({
    TOPIC_OUTBOX_ENABLE_IMMEDIATE_DELIVERY: false,
    TOPIC_OUTBOX_MAX_DELIVERY_ATTEMPTS: 2
  });
  pluginManager.online = true;
  pluginManager.failuresRemaining = 5;

  await TopicOutbox.processToolCall({
    command: 'CreateTopicRequest',
    topicRequestId: 'memo-dream-test-fail',
    maid: '记忆大师',
    topic_name: '待审批：失败重试',
    initial_message: '审批摘要'
  });

  await TopicOutbox.drainPending({ reason: 'test-failure-1' });
  await TopicOutbox.drainPending({ reason: 'test-failure-2' });
  await TopicOutbox.drainPending({ reason: 'test-failure-3' });

  const failed = await TopicOutbox.processToolCall({
    command: 'ListTopicRequests',
    status: 'failed'
  });

  assert.equal(failed.count, 1);
  assert.equal(failed.requests[0].attempts, 2);
  assert.match(failed.requests[0].lastError, /simulated delivery failure/);
  assert.equal(pluginManager.calls.length, 2);
});

test('expired requests are not delivered', async () => {
  const { pluginManager } = await setupTopicOutbox({
    TOPIC_OUTBOX_ENABLE_IMMEDIATE_DELIVERY: false
  });
  pluginManager.online = true;

  await TopicOutbox.processToolCall({
    command: 'CreateTopicRequest',
    topicRequestId: 'memo-dream-test-expired',
    maid: '记忆大师',
    topic_name: '待审批：已过期',
    initial_message: '审批摘要',
    expires_at: '2000-01-01T00:00:00Z'
  });

  await TopicOutbox.drainPending({ reason: 'test-expired' });

  const expired = await TopicOutbox.processToolCall({
    command: 'ListTopicRequests',
    status: 'expired'
  });

  assert.equal(expired.count, 1);
  assert.equal(pluginManager.calls.length, 0);
});

test('expired delivery locks are recovered and retried', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'topic-outbox-test-'));
  const storePath = path.join(tempDir, 'topic_requests.json');
  const pluginManager = new FakePluginManager();
  pluginManager.online = true;

  await fs.writeFile(storePath, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    requests: [
      {
        topicRequestId: 'memo-dream-test-stale-lock',
        operation: 'CreateTopic',
        targetTool: 'TopicSponsor',
        status: 'delivering',
        maid: '记忆大师',
        priority: 'normal',
        expires_at: '2999-01-01T00:00:00.000Z',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
        attempts: 1,
        maxAttempts: 3,
        lastAttemptAt: '2026-05-01T00:00:00.000Z',
        lastError: null,
        lockUntil: '2000-01-01T00:00:00.000Z',
        metadata: {},
        payload: {
          topic_name: '待审批：锁恢复',
          initial_message: '审批摘要'
        },
        delivery: null
      }
    ]
  }, null, 2), 'utf8');

  await TopicOutbox.initialize({
    TOPIC_OUTBOX_STORE_PATH: storePath,
    TOPIC_OUTBOX_ENABLE_IMMEDIATE_DELIVERY: false
  }, { pluginManager });

  await TopicOutbox.drainPending({ reason: 'test-stale-lock' });

  const delivered = await TopicOutbox.processToolCall({
    command: 'ListTopicRequests',
    status: 'delivered'
  });

  assert.equal(delivered.count, 1);
  assert.equal(delivered.requests[0].attempts, 2);
  assert.equal(pluginManager.calls.length, 1);
});

async function setupTopicOutbox(extraConfig = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'topic-outbox-test-'));
  const storePath = path.join(tempDir, 'topic_requests.json');
  const pluginManager = new FakePluginManager();

  await TopicOutbox.initialize({
    TOPIC_OUTBOX_STORE_PATH: storePath,
    TOPIC_OUTBOX_ENABLE_IMMEDIATE_DELIVERY: false,
    ...extraConfig
  }, { pluginManager });

  return { tempDir, storePath, pluginManager };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Timed out waiting for condition.');
}
