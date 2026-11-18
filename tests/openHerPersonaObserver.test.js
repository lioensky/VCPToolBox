const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const pluginPath = path.resolve(__dirname, '..', 'Plugin', 'OpenHerPersona', 'OpenHerPersona.js');

function deterministicVector(text, dimensions = 16) {
  const vector = new Array(dimensions).fill(0);
  for (const char of String(text || '')) {
    vector[char.codePointAt(0) % dimensions] += 1;
  }
  return vector;
}

function createContextBridge() {
  const cache = new Map();
  const calls = {
    sanitize: [],
    exactLookups: [],
    embedBatch: [],
    embedText: [],
  };

  const sanitize = (content, role) => {
    calls.sanitize.push({ content, role });
    return String(content || '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  };

  return {
    calls,
    cache,
    bridge: {
      sanitize,
      getEmbeddingFromCache(text) {
        calls.exactLookups.push(text);
        return cache.get(text) || null;
      },
      getFuzzyEmbeddingFromCache() {
        return null;
      },
      async embedBatch(texts) {
        calls.embedBatch.push([...texts]);
        const vectors = texts.map((text) => deterministicVector(text));
        texts.forEach((text, index) => cache.set(text, vectors[index]));
        return vectors;
      },
      async embedText(text) {
        calls.embedText.push(text);
        const vector = deterministicVector(text);
        cache.set(text, vector);
        return vector;
      },
    },
  };
}

function freshPlugin(contextBridge) {
  delete require.cache[require.resolve(pluginPath)];
  const plugin = require(pluginPath);
  plugin.initialize(
    {
      OpenHerPersonaEnabled: true,
      OpenHerPersonaAsyncObservation: false,
      DebugMode: false,
    },
    { contextBridge },
  );
  return plugin;
}

async function waitForObservationCount(plugin, agentKey, expected, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await plugin.processToolCall({
      command: 'status',
      agentKey,
      agentName: agentKey,
    });
    if ((status.state?.observationCount || 0) >= expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return plugin.processToolCall({
    command: 'status',
    agentKey,
    agentName: agentKey,
  });
}

test('OpenHerPersona observes sanitized historical assistant expressions without user subject mismatch or request flood', async () => {
  const { bridge, cache, calls } = createContextBridge();
  const plugin = freshPlugin(bridge);
  const agentKey = `ObserverRegression-${process.pid}-${Date.now()}`;

  try {
    await plugin.processToolCall({
      command: 'reset',
      agentKey,
      agentName: agentKey,
    });

    const userOnlyMessages = [
      { role: 'system', content: `[[OneRing::${agentKey}::VCPChat]]\nbase system` },
      { role: 'user', content: '我今天特别开心。' },
    ];

    await plugin.processMessages(userOnlyMessages);
    let status = await plugin.processToolCall({
      command: 'status',
      agentKey,
      agentName: agentKey,
    });

    assert.equal(
      status.state.observationCount,
      0,
      'a current user stimulus must not be projected directly onto Agent-subject psychological axes',
    );

    const rawAssistant = '<div>我听到这个消息后非常悲伤，心里像被刺了一下。</div>';
    const sanitizedAssistant = '我听到这个消息后非常悲伤，心里像被刺了一下。';
    cache.set(sanitizedAssistant, deterministicVector(sanitizedAssistant));

    const nextTurnMessages = [
      { role: 'system', content: `[[OneRing::${agentKey}::VCPChat]]\nbase system` },
      { role: 'user', content: '重要人物已经去世。' },
      { role: 'assistant', content: rawAssistant },
      { role: 'user', content: '你现在还好吗？' },
    ];

    await plugin.processMessages(nextTurnMessages);
    status = await waitForObservationCount(plugin, agentKey, 1);

    assert.equal(status.state.observationCount, 1);
    assert.equal(status.state.lastObservation.role, 'assistant');
    assert.equal(status.state.lastObservation.observationType, 'expression');
    assert.equal(status.state.lastObservation.phase, 'next_request_history');
    assert.equal(status.state.lastObservation.semanticSubject, 'assistant_expression');
    assert.equal(
      status.state.lastObservation.stateSemantics,
      'internal_state_inferred_from_expression',
    );

    assert(
      calls.sanitize.some(
        (call) => call.role === 'assistant' && call.content === rawAssistant,
      ),
      'the original downstream message must be passed through the shared RAG sanitizer',
    );
    assert(
      calls.exactLookups.includes(sanitizedAssistant),
      'the exact cache lookup must use the shared sanitized assistant text',
    );
    assert(
      !calls.exactLookups.includes(rawAssistant),
      'the raw downstream assistant text must not be used as the embedding cache key',
    );

    assert.equal(
      calls.embedBatch.length,
      1,
      'all missing semantic anchors must be initialized through one ContextBridge batch call',
    );
    assert(
      calls.embedBatch[0].length > 32,
      'the regression fixture must cover the former large anchor initialization fan-out',
    );
    assert.equal(
      calls.embedText.length,
      0,
      'batch-capable ContextBridge must not receive per-anchor single-text requests',
    );

    await plugin.processMessages(nextTurnMessages);
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await plugin.processToolCall({
      command: 'status',
      agentKey,
      agentName: agentKey,
    });
    assert.equal(
      status.state.observationCount,
      1,
      'the same assistant expression must only be accumulated once even when message indexes shift or a request is retried',
    );
  } finally {
    await plugin.processToolCall({ command: 'delete', agentKey });
    plugin.shutdown();
  }
});