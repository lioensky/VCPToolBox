const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const pluginPath = path.join(repoRoot, 'Plugin', 'OpenHerPersona', 'OpenHerPersona.js');
const statePath = path.join(repoRoot, 'Plugin', 'OpenHerPersona', 'state', 'openher-persona-state.json');
const stateDbPath = path.join(repoRoot, 'Plugin', 'OpenHerPersona', 'state', 'openher-persona-state.sqlite');
const orderPath = path.join(repoRoot, 'preprocessor_order.json');
const Database = require('better-sqlite3');

function dbSidecarPaths(dbPath) {
  return [dbPath, `${dbPath}-shm`, `${dbPath}-wal`];
}

function backupFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

function restoreFile(filePath, content) {
  if (content === null) {
    try {
      fs.unlinkSync(filePath);
    } catch (_) {
      // file may not exist
    }
    return;
  }
  fs.writeFileSync(filePath, content);
}

function readStoreFromDb() {
  if (!fs.existsSync(stateDbPath)) return null;
  const db = new Database(stateDbPath, { readonly: true });
  try {
    const metaRows = db.prepare('SELECT key, value FROM openher_persona_meta').all();
    const meta = Object.fromEntries(metaRows.map((row) => [row.key, row.value]));
    const rows = db.prepare('SELECT agent_key, state_json FROM openher_persona_agents ORDER BY agent_key ASC').all();
    if (!rows.length) return null;
    const agents = {};
    for (const row of rows) {
      agents[row.agent_key] = JSON.parse(row.state_json);
    }
    const activeAgentKey = meta.activeAgentKey && agents[meta.activeAgentKey]
      ? meta.activeAgentKey
      : Object.keys(agents)[0];
    return {
      schemaVersion: Number(meta.schemaVersion) || 3,
      plugin: meta.plugin || 'OpenHerPersona',
      pluginVersion: meta.pluginVersion || '0.5.1',
      updatedAt: meta.updatedAt || null,
      createdAt: meta.createdAt || null,
      activeAgentKey,
      agents,
    };
  } finally {
    db.close();
  }
}

function writeStoreToDb(store) {
  const db = new Database(stateDbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS openher_persona_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS openher_persona_agents (
        agent_key TEXT PRIMARY KEY,
        agent_label TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const writeMeta = db.prepare(
      'INSERT INTO openher_persona_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    const upsertAgent = db.prepare(
      `INSERT INTO openher_persona_agents (agent_key, agent_label, state_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_key) DO UPDATE SET
         agent_label = excluded.agent_label,
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`
    );
    const transaction = db.transaction(() => {
      writeMeta.run('schemaVersion', String(store.schemaVersion || 3));
      writeMeta.run('plugin', store.plugin || 'OpenHerPersona');
      writeMeta.run('pluginVersion', store.pluginVersion || '0.5.1');
      writeMeta.run('createdAt', store.createdAt || new Date(0).toISOString());
      writeMeta.run('updatedAt', store.updatedAt || new Date().toISOString());
      writeMeta.run('activeAgentKey', store.activeAgentKey);
      for (const [agentKey, agentState] of Object.entries(store.agents || {})) {
        upsertAgent.run(
          agentKey,
          agentState.agentLabel || agentState.agentName || agentKey,
          JSON.stringify(agentState),
          agentState.createdAt || store.createdAt || new Date(0).toISOString(),
          agentState.updatedAt || store.updatedAt || new Date().toISOString()
        );
      }
    });
    transaction();
  } finally {
    db.close();
  }
}

function readStore() {
  const dbStore = readStoreFromDb();
  if (dbStore) return dbStore;
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function readActiveState() {
  const store = readStore();
  if (!store.agents) return store;
  return store.agents[store.activeAgentKey];
}

function readAgentState(agentKey) {
  const store = readStore();
  return store.agents && store.agents[agentKey];
}

function freshPlugin(config = {}, dependencies = {}) {
  delete require.cache[require.resolve(pluginPath)];
  const plugin = require(pluginPath);
  plugin.initialize({
    OpenHerPersonaEnabled: true,
    OpenHerPersonaHintEnabled: true,
    DebugMode: false,
    ...config,
  }, dependencies);
  return plugin;
}

async function withRestoredState(fn) {
  const originalState = backupFile(statePath);
  const originalDbFiles = Object.fromEntries(dbSidecarPaths(stateDbPath).map((filePath) => [filePath, backupFile(filePath)]));
  try {
    await fn();
  } finally {
    restoreFile(statePath, originalState);
    for (const [filePath, content] of Object.entries(originalDbFiles)) {
      restoreFile(filePath, content);
    }
  }
}

async function withFixedRandom(fn) {
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  try {
    await fn();
  } finally {
    Math.random = originalRandom;
  }
}

function assertBoundedState(state) {
  for (const value of Object.values(state.frustration)) {
    assert(value >= 0 && value <= 5, `frustration out of range: ${value}`);
  }
  for (const value of Object.values(state.signals)) {
    assert(value >= 0 && value <= 1, `signal out of range: ${value}`);
  }
  assert(state.expression, 'missing expression state');
  assert(state.expression.intensity >= 0 && state.expression.intensity <= 1, 'expression intensity out of range');
  assert(Array.isArray(state.genome?.recurrentState), 'missing genome recurrent state');
  assert.equal(state.genome.recurrentState.length, 4);
  for (const value of state.genome.recurrentState) {
    assert(value >= -1 && value <= 1, `recurrent state out of range: ${value}`);
  }
  for (const value of Object.values(state.genome.lastContext)) {
    assert(value >= 0 && value <= 1, `context out of range: ${value}`);
  }
}

test('OpenHerPersona injects hidden persona hint into system while preserving OneRing trigger', async () => {
  await withRestoredState(async () => {
    const plugin = freshPlugin();
    await plugin.processToolCall({ command: 'reset' });

    const processed = await plugin.processMessages([
      { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
      { role: 'user', content: '短句，试试。' },
    ]);

    assert.equal(processed[0].role, 'system');
    assert.match(processed[0].content, /\[\[OneRing::Nova::VCPChat\]\]/);
    assert.match(processed[0].content, /<!--persona_state_hint/);
    assert.match(processed[0].content, /persona_delta 回填指令/);
    assert.match(processed[0].content, /frustration_delta/);
    assert.match(processed[0].content, /signal_delta/);
    assert.match(processed[0].content, /persona_expression 回填指令/);
    assert.match(processed[0].content, /表达倾向/);
    assert.match(processed[0].content, /当前人格信号/);
    assert(!processed.some((message) => message.role === 'user' && String(message.content).includes('persona_state_hint')));

    const state = readActiveState();
    assert.equal(state.agentKey, 'Nova');
    assert(state.turnCount >= 1);
    assertBoundedState(state);
  });
});

test('OpenHerPersona resolves agent identity from the latest OneRing marker in system blocks', async () => {
  await withRestoredState(async () => {
    const plugin = freshPlugin();
    await plugin.processToolCall({ command: 'reset' });

    await plugin.processMessages([
      {
        role: 'system',
        content: [
          '记忆召回旧块：[[OneRing::MemoryGhost::VCPChat]]',
          '已被前置预处理器替换掉的其他占位符内容',
          '[[OneRing::Nova::VCPChat]]',
          '后续还有别的工具调用指南，不应影响 OneRing 身份识别。',
        ].join('\n'),
      },
      { role: 'system', content: '后续工具指南：这里没有 OneRing 身份标记。' },
      { role: 'user', content: '验证 system 块内部的最后一个 OneRing 身份识别。' },
    ]);

    const state = readActiveState();
    assert.equal(state.agentKey, 'Nova');
    assert(!readAgentState('MemoryGhost'), 'older memory-like OneRing marker must not override the latest marker in system prompt');
  });
});

test('OpenHerPersona applies assistant persona_delta once, keeps signal_delta after metabolism, and dedupes repeats', async () => {
  await withRestoredState(async () => {
    await withFixedRandom(async () => {
      const plugin = freshPlugin();
      await plugin.processToolCall({ command: 'reset' });

      const baseMessages = [
        { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
        { role: 'user', content: '应用 delta。' },
        {
          role: 'assistant',
          content: '隐藏回填。<!--persona_delta:{"frustration_delta":{"connection":0.5,"safety":0.2},"reason":"unit-base"}-->',
        },
      ];

      await plugin.processMessages(baseMessages);
      const withoutSignalDelta = readActiveState();

      await plugin.processToolCall({ command: 'reset' });
      const before = readActiveState();
      const messages = [
        { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
        { role: 'user', content: '应用 delta。' },
        {
          role: 'assistant',
          content: '隐藏回填。<!--persona_delta:{"frustration_delta":{"connection":0.5,"safety":0.2},"signal_delta":{"warmth":0.18,"vulnerability":0.18},"reason":"unit"}-->',
        },
      ];

      await plugin.processMessages(messages);
      const afterDelta = readActiveState();
      assert(afterDelta.frustration.connection > before.frustration.connection);
      assert(afterDelta.frustration.safety > before.frustration.safety);
      assert(afterDelta.driveBaseline.connection >= before.driveBaseline.connection);
      assert(afterDelta.signals.warmth >= Math.min(1, withoutSignalDelta.signals.warmth + 0.17));
      assert(afterDelta.signals.vulnerability >= Math.min(1, withoutSignalDelta.signals.vulnerability + 0.17));
      assert.equal(afterDelta.lastAppliedPersonaDelta.signal_delta.warmth, 0.18);
      assert.equal(afterDelta.lastAppliedPersonaDelta.signal_delta.vulnerability, 0.18);
      assert.equal(afterDelta.audit.at(-1).type, 'persona_delta');
      assert.equal(afterDelta.audit.at(-1).signal_delta.warmth, 0.18);
      const status = await plugin.processToolCall({ command: 'status' });
      assert.equal(status.state.lastAppliedPersonaDelta.signal_delta.warmth, 0.18);
      assert.equal(status.state.lastChange.frustration.connection, afterDelta.trends.frustration.connection);
      assert.equal(status.state.lastChange.signals.warmth, afterDelta.trends.signals.warmth);
      assert(status.state.lastChange.frustration.connection > 0);
      assert(status.state.lastChange.signals.warmth > 0);

      await plugin.processMessages(messages);
      const afterRepeat = readActiveState();
      assert.equal(afterRepeat.frustration.connection, afterDelta.frustration.connection);
      assert.equal(afterRepeat.frustration.safety, afterDelta.frustration.safety);
      assert.equal(afterRepeat.signals.warmth, afterDelta.signals.warmth);
      assert.equal(afterRepeat.signals.vulnerability, afterDelta.signals.vulnerability);
      assertBoundedState(afterRepeat);
    });
  });
});

test('OpenHerPersona records assistant persona_expression once and dedupes repeats', async () => {
  await withRestoredState(async () => {
    const plugin = freshPlugin();
    await plugin.processToolCall({ command: 'reset' });

    const messages = [
      { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
      { role: 'user', content: '记录表达方式。' },
      {
        role: 'assistant',
        content: '表达记录。<!--persona_expression:{"mode":"voice_like","pace":"short","intensity":0.72,"reason":"unit"}-->',
      },
    ];

    await plugin.processMessages(messages);
    const afterExpression = readActiveState();
    assert.equal(afterExpression.expression.modelChoice.mode, 'voice_like');
    assert.equal(afterExpression.expression.modelChoice.pace, 'short');
    assert.equal(afterExpression.appliedExpressionIds.length, 1);

    await plugin.processMessages(messages);
    const afterRepeat = readActiveState();
    assert.equal(afterRepeat.appliedExpressionIds.length, afterExpression.appliedExpressionIds.length);
    assert.equal(afterRepeat.expression.modelChoice.mode, 'voice_like');
    assertBoundedState(afterRepeat);
  });
});

test('OpenHerPersona disabled mode returns original messages without injection', async () => {
  await withRestoredState(async () => {
    const plugin = freshPlugin({ OpenHerPersonaEnabled: false });
    const messages = [{ role: 'user', content: 'disabled smoke' }];
    const processed = await plugin.processMessages(messages);
    assert.equal(processed, messages);
  });
});

test('OpenHerPersona ignores VCP pseudo user blocks when detecting new turns', async () => {
  await withRestoredState(async () => {
    const plugin = freshPlugin();
    await plugin.processToolCall({ command: 'reset' });

    await plugin.processMessages([
      { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
      { role: 'user', content: '真人用户消息。' },
    ]);
    const afterRealUser = readActiveState();

    await plugin.processMessages([
      { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
      { role: 'user', content: '真人用户消息。' },
      { role: 'assistant', content: '上一轮回复。' },
      { role: 'user', content: '[系统提示:][OneRing通知:上一条消息由Nova于2026-06-10 12:00:00发送于VCPChat]' },
    ]);
    const afterPseudoUser = readActiveState();

    assert.equal(afterPseudoUser.turnCount, afterRealUser.turnCount);
    assert.equal(afterPseudoUser.lastTurnFingerprint, afterRealUser.lastTurnFingerprint);
  });
});

test('OpenHerPersona keeps separate state buckets per agent and tool calls target the selected agent', async () => {
  await withRestoredState(async () => {
    const plugin = freshPlugin();

    await plugin.processMessages([
      { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
      { role: 'user', content: 'Nova 的第一轮。' },
    ], {
      vcpchatExtensions: {
        openHerPersonaAgent: { agentId: 'nova-id', agentName: 'Nova' },
      },
    });
    const novaAfterFirst = readAgentState('nova-id');

    await plugin.processMessages([
      { role: 'system', content: '[[OneRing::Kira::VCPChat]]\nbase system' },
      { role: 'user', content: 'Kira 的第一轮。' },
    ], {
      vcpchatExtensions: {
        openHerPersonaAgent: { agentId: 'kira-id', agentName: 'Kira' },
      },
    });

    let store = readStore();
    assert(store.agents['nova-id'], 'missing Nova state');
    assert(store.agents['kira-id'], 'missing Kira state');
    assert.equal(store.agents['nova-id'].agentLabel, 'Nova');
    assert.equal(store.agents['kira-id'].agentLabel, 'Kira');
    assert.equal(store.agents['nova-id'].turnCount, novaAfterFirst.turnCount);
    assert.equal(store.agents['kira-id'].turnCount, 1);

    const novaStatus = await plugin.processToolCall({ command: 'status', agentId: 'nova-id', agentName: 'Nova' });
    assert.equal(novaStatus.agent.agentKey, 'nova-id');
    assert.equal(novaStatus.state.turnCount, novaAfterFirst.turnCount);

    await plugin.processToolCall({ command: 'reset', agentId: 'kira-id', agentName: 'Kira' });
    store = readStore();
    assert.equal(store.agents['kira-id'].turnCount, 0);
    assert.equal(store.agents['nova-id'].turnCount, novaAfterFirst.turnCount);
    assertBoundedState(store.agents['nova-id']);
    assertBoundedState(store.agents['kira-id']);
  });
});

test('OpenHerPersona derives stable but distinct initial profiles for different agents', async () => {
  await withRestoredState(async () => {
    const plugin = freshPlugin();

    await plugin.processToolCall({ command: 'reset', agentId: 'nova-id', agentName: 'Nova' });
    const firstNova = readAgentState('nova-id');

    await plugin.processToolCall({ command: 'reset', agentId: 'kira-id', agentName: 'Kira' });
    const kira = readAgentState('kira-id');

    await plugin.processToolCall({ command: 'reset', agentId: 'nova-id', agentName: 'Nova' });
    const secondNova = readAgentState('nova-id');

    assert.notDeepEqual(firstNova.driveBaseline, kira.driveBaseline);
    assert.notDeepEqual(firstNova.signals, kira.signals);
    assert.deepEqual(secondNova.driveBaseline, firstNova.driveBaseline);
    assert.deepEqual(secondNova.signals, firstNova.signals);
    assertBoundedState(firstNova);
    assertBoundedState(kira);
  });
});

test('OpenHerPersona tick status exposes the latest metric change values', async () => {
  await withRestoredState(async () => {
    const plugin = freshPlugin();
    await plugin.processToolCall({ command: 'reset', agentId: 'nova-id', agentName: 'Nova' });

    const store = readStore();
    store.agents['nova-id'].lastTickAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeStoreToDb(store);

    const reloadedPlugin = freshPlugin();
    const tickStatus = await reloadedPlugin.processToolCall({ command: 'tick', agentId: 'nova-id', agentName: 'Nova' });

    assert(tickStatus.tick.state.lastChange.frustration.connection > 0);
    assert(tickStatus.tick.state.lastChange.frustration.novelty > 0);
    assert.equal(
      tickStatus.tick.state.lastChange.frustration.connection,
      tickStatus.tick.state.trends.frustration.connection
    );
    assert.equal(
      tickStatus.tick.state.lastChange.signals.warmth,
      tickStatus.tick.state.trends.signals.warmth
    );
    assertBoundedState(readAgentState('nova-id'));
  });
});

test('OpenHerPersona persists agent buckets into SQLite rows and migrates legacy JSON store', async () => {
  await withRestoredState(async () => {
    for (const filePath of dbSidecarPaths(stateDbPath)) {
      restoreFile(filePath, null);
    }
    restoreFile(statePath, null);

    const plugin = freshPlugin();
    await plugin.processMessages([
      { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
      { role: 'user', content: 'SQLite Nova 第一轮。' },
    ]);
    await plugin.processMessages([
      { role: 'system', content: '[[OneRing::Kira::VCPChat]]\nbase system' },
      { role: 'user', content: 'SQLite Kira 第一轮。' },
    ]);

    assert(fs.existsSync(stateDbPath), 'SQLite state database should be created');
    const dbStore = readStoreFromDb();
    assert(dbStore.agents.Nova, 'missing Nova SQLite row');
    assert(dbStore.agents.Kira, 'missing Kira SQLite row');
    assert(!dbStore.agents.__default__, 'default bucket should not be persisted to SQLite');
    assert.equal(dbStore.agents.Nova.agentKey, 'Nova');
    assert.equal(dbStore.agents.Kira.agentKey, 'Kira');

    for (const filePath of dbSidecarPaths(stateDbPath)) {
      restoreFile(filePath, null);
    }
    const legacyStore = {
      schemaVersion: 3,
      plugin: 'OpenHerPersona',
      pluginVersion: '0.5.1',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      activeAgentKey: 'Nova',
      agents: {
        Nova: dbStore.agents.Nova,
        Kira: dbStore.agents.Kira,
      },
    };
    fs.writeFileSync(statePath, JSON.stringify(legacyStore, null, 2), 'utf8');

    const migratedPlugin = freshPlugin();
    const status = await migratedPlugin.processToolCall({ command: 'status', agentId: 'Kira', agentName: 'Kira' });
    assert.equal(status.agent.agentKey, 'Kira');

    const migratedStore = readStoreFromDb();
    assert(migratedStore.agents.Nova, 'legacy Nova should migrate to SQLite');
    assert(migratedStore.agents.Kira, 'legacy Kira should migrate to SQLite');
    assert(!migratedStore.agents.__default__, 'legacy migration must not create default SQLite row');
  });
});

test('OpenHerPersona migrates legacy flat state into the first real agent bucket', async () => {
  await withRestoredState(async () => {
    const legacyState = {
      version: 2,
      plugin: 'OpenHerPersona',
      pluginVersion: '0.2.0',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      driveBaseline: {
        connection: 0.7,
        novelty: 0.5,
        expression: 0.5,
        safety: 0.5,
        play: 0.5,
      },
      frustration: {
        connection: 2.4,
        novelty: 0.4,
        expression: 0.3,
        safety: 0.2,
        play: 0.1,
      },
      signals: {
        directness: 0.5,
        vulnerability: 0.4,
        playfulness: 0.3,
        initiative: 0.6,
        depth: 0.7,
        warmth: 0.8,
        defiance: 0.2,
        curiosity: 0.65,
      },
      cooldown: { minutes: 90, lastImpulseAt: null },
      lastTurnFingerprint: null,
      turnCount: 7,
      appliedDeltaIds: [],
      appliedExpressionIds: [],
      genome: {
        recurrentState: [0.1, 0.2, 0.3, 0.4],
        lastContext: {
          affection: 0.6,
          engagement: 0.5,
          novelty: 0.4,
          constraint: 0.2,
          depth: 0.7,
          playfulness: 0.3,
          frustrationRelief: 0.1,
          silence: 0,
        },
      },
      expression: {
        mode: 'balanced',
        label: '平衡表达',
        pace: 'balanced',
        intensity: 0.4,
        emoji: false,
        silence: false,
        reason: 'legacy',
        modelChoice: null,
        updatedAt: null,
      },
      trends: {
        frustration: {
          connection: 0,
          novelty: 0,
          expression: 0,
          safety: 0,
          play: 0,
        },
        signals: {
          directness: 0,
          vulnerability: 0,
          playfulness: 0,
          initiative: 0,
          depth: 0,
          warmth: 0,
          defiance: 0,
          curiosity: 0,
        },
      },
      audit: [],
    };
    fs.writeFileSync(statePath, JSON.stringify(legacyState, null, 2), 'utf8');

    const plugin = freshPlugin();
    await plugin.processMessages([
      { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
      { role: 'user', content: '迁移后第一轮。' },
    ]);

    const store = readStore();
    assert.equal(store.schemaVersion, 3);
    assert.equal(store.activeAgentKey, 'Nova');
    assert(!store.agents.__default__, 'legacy default bucket should be consumed');
    assert(store.agents.Nova, 'missing migrated Nova bucket');
    assert(store.agents.Nova.turnCount >= 8);
    // Homeostatic metabolism: a real interaction relieves connection frustration
    // instead of inflating it, so the migrated value should ease but stay positive.
    assert(store.agents.Nova.frustration.connection > 0);
    assert(store.agents.Nova.frustration.connection <= legacyState.frustration.connection);
    assert.equal(store.agents.Nova.agentLabel, 'Nova');
    assertBoundedState(store.agents.Nova);
  });
});

test('OpenHerPersona stays directly after RAGDiaryPlugin and before OneRing', () => {
  const order = JSON.parse(fs.readFileSync(orderPath, 'utf8'));
  const ragIndex = order.indexOf('RAGDiaryPlugin');
  assert(ragIndex >= 0);
  assert.equal(order[ragIndex + 1], 'OpenHerPersona');
  assert.equal(order[ragIndex + 2], 'OneRing');
});

test('OpenHerPersona homeostasis keeps connection frustration from saturating over many turns', async () => {
  await withRestoredState(async () => {
    await withFixedRandom(async () => {
      const plugin = freshPlugin();
      await plugin.processToolCall({ command: 'reset' });

      for (let turn = 0; turn < 30; turn += 1) {
        await plugin.processMessages([
          { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
          { role: 'user', content: `第 ${turn} 轮普通消息，继续聊聊今天的进展。` },
        ]);
      }

      const state = readActiveState();
      assert(state.turnCount >= 30);
      assert(state.frustration.connection < 4, `connection saturated: ${state.frustration.connection}`);
      assert(
        state.frustration.connection > 0.3,
        `connection collapsed to floor: ${state.frustration.connection}`
      );
      assertBoundedState(state);
    });
  });
});

test('OpenHerPersona silence gap rekindles connection longing', async () => {
  await withRestoredState(async () => {
    await withFixedRandom(async () => {
      const plugin = freshPlugin();
      await plugin.processToolCall({ command: 'reset' });

      await plugin.processMessages([
        { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
        { role: 'user', content: '先正常聊一轮。' },
      ]);
      const activeConnection = readActiveState().frustration.connection;

      const store = readStore();
      const active = store.agents[store.activeAgentKey];
      active.lastActiveAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      writeStoreToDb(store);

      const reloadedPlugin = freshPlugin();
      await reloadedPlugin.processMessages([
        { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
        { role: 'user', content: '隔了一天才回来找你。' },
      ]);
      const afterGap = readActiveState();
      assert(
        afterGap.frustration.connection > Math.max(1.2, activeConnection),
        `24h silence should rekindle connection: ${afterGap.frustration.connection}`
      );
      assertBoundedState(afterGap);
    });
  });
});

test('OpenHerPersona persists signal_delta influence through later metabolism via signal bias', async () => {
  await withRestoredState(async () => {
    await withFixedRandom(async () => {
      const plugin = freshPlugin();
      await plugin.processToolCall({ command: 'reset' });

      await plugin.processMessages([
        { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
        { role: 'user', content: '先聊一轮。' },
        {
          role: 'assistant',
          content: '回填。<!--persona_delta:{"signal_delta":{"warmth":0.18},"reason":"bias-unit"}-->',
        },
      ]);
      const afterDelta = readActiveState();
      assert(afterDelta.signalBias.warmth > 0, 'signal bias should absorb the delta');

      await plugin.processMessages([
        { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
        { role: 'user', content: '再聊一轮新的话题。' },
      ]);
      const afterNextTurn = readActiveState();
      assert(afterNextTurn.signalBias.warmth > 0, 'signal bias should survive the next metabolism turn');
      assertBoundedState(afterNextTurn);
    });
  });
});

test('OpenHerPersona keeps distinct personalities for different agents after identical interactions', async () => {
  await withRestoredState(async () => {
    await withFixedRandom(async () => {
      const plugin = freshPlugin();
      const sharedTurn = '同一句问候，看看你们各自的反应。';

      await plugin.processToolCall({ command: 'reset', agentId: 'nova-id', agentName: 'Nova' });
      await plugin.processMessages([
        { role: 'system', content: 'base system' },
        { role: 'user', content: sharedTurn },
      ], { vcpchatExtensions: { openHerPersonaAgent: { agentId: 'nova-id', agentName: 'Nova' } } });

      await plugin.processToolCall({ command: 'reset', agentId: 'kira-id', agentName: 'Kira' });
      await plugin.processMessages([
        { role: 'system', content: 'base system' },
        { role: 'user', content: sharedTurn },
      ], { vcpchatExtensions: { openHerPersonaAgent: { agentId: 'kira-id', agentName: 'Kira' } } });

      const nova = readAgentState('nova-id');
      const kira = readAgentState('kira-id');
      const divergence = Object.keys(nova.signals).reduce(
        (sum, key) => sum + Math.abs(nova.signals[key] - kira.signals[key]),
        0
      );
      assert(divergence > 0.1, `agents converged after metabolism: divergence=${divergence}`);
      assert.notDeepEqual(nova.temperament, kira.temperament);
      assertBoundedState(nova);
      assertBoundedState(kira);
    });
  });
});

test('OpenHerPersona persona_delta impact tiers unlock larger one-shot changes with guardrails', async () => {
  await withRestoredState(async () => {
    await withFixedRandom(async () => {
      const plugin = freshPlugin();

      // Default (minor) clamps a large delta to +-0.8.
      await plugin.processToolCall({ command: 'reset' });
      await plugin.processMessages([
        { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
        { role: 'user', content: '触发回填一。' },
        { role: 'assistant', content: '<!--persona_delta:{"frustration_delta":{"connection":2.5},"reason":"unit"}-->' },
      ]);
      const minorState = readActiveState();
      assert(minorState.frustration.connection <= 0.95, `minor not clamped: ${minorState.frustration.connection}`);

      // major allows frustration_set jumps and stamps the cooldown.
      await plugin.processToolCall({ command: 'reset' });
      await plugin.processMessages([
        { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
        { role: 'user', content: '触发回填二。' },
        {
          role: 'assistant',
          content: '<!--persona_delta:{"impact":"major","frustration_set":{"connection":4.2},"signal_delta":{"warmth":-0.5},"reason":"被狠狠伤到了"}-->',
        },
      ]);
      const majorState = readActiveState();
      assert.equal(majorState.frustration.connection, 4.2);
      assert(majorState.lastMajorImpactAt, 'major impact timestamp missing');
      assert.equal(majorState.audit.at(-1).impact, 'major');
      assert(majorState.signalBias.warmth < 0, 'major signal correction should fold into bias');

      // A second major inside the cooldown window downgrades to moderate:
      // frustration_set is ignored and the delta is clamped to +-1.5.
      await plugin.processMessages([
        { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
        { role: 'user', content: '触发回填三。' },
        {
          role: 'assistant',
          content: '<!--persona_delta:{"impact":"major","frustration_set":{"connection":0},"frustration_delta":{"connection":-2.8},"reason":"again"}-->',
        },
      ]);
      const cooledState = readActiveState();
      assert.equal(cooledState.audit.at(-1).impact, 'moderate');
      assert.equal(cooledState.audit.at(-1).downgradedFrom, 'major');
      assert(
        cooledState.frustration.connection > 1.5 && cooledState.frustration.connection < 3,
        `cooldown downgrade not enforced: ${cooledState.frustration.connection}`
      );

      // major without a reason also downgrades, so the set is ignored.
      await plugin.processToolCall({ command: 'reset' });
      await plugin.processMessages([
        { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
        { role: 'user', content: '触发回填四。' },
        { role: 'assistant', content: '<!--persona_delta:{"impact":"major","frustration_set":{"connection":5}}-->' },
      ]);
      const noReasonState = readActiveState();
      assert.equal(noReasonState.audit.at(-1).downgradedFrom, 'major');
      assert(noReasonState.frustration.connection < 1, `reasonless major applied: ${noReasonState.frustration.connection}`);

      assertBoundedState(readActiveState());
    });
  });
});

test('OpenHerPersona seeds distinct metabolic constitutions and sensitizes them on impact events', async () => {
  await withRestoredState(async () => {
    await withFixedRandom(async () => {
      const plugin = freshPlugin();

      await plugin.processToolCall({ command: 'reset', agentId: 'nova-id', agentName: 'Nova' });
      await plugin.processToolCall({ command: 'reset', agentId: 'kira-id', agentName: 'Kira' });
      const nova = readAgentState('nova-id');
      const kira = readAgentState('kira-id');
      assert.notDeepEqual(nova.metabolism.growthGain, kira.metabolism.growthGain, 'constitutions should differ');

      const beforeGain = nova.metabolism.growthGain.connection;
      await plugin.processMessages([
        { role: 'system', content: 'base system' },
        { role: 'user', content: '触发敏化。' },
        {
          role: 'assistant',
          content: '<!--persona_delta:{"impact":"major","frustration_delta":{"connection":2.0},"reason":"sensitize-unit"}-->',
        },
      ], { vcpchatExtensions: { openHerPersonaAgent: { agentId: 'nova-id', agentName: 'Nova' } } });
      const afterGain = readAgentState('nova-id').metabolism.growthGain.connection;
      assert(afterGain > beforeGain, `major distress should sensitize growth: ${beforeGain} -> ${afterGain}`);
      assert(afterGain <= 1.5, 'metabolic gain must stay bounded');
    });
  });
});

test('OpenHerPersona phase transition erupts under accumulated pressure then cools and regrounds', async () => {
  await withRestoredState(async () => {
    await withFixedRandom(async () => {
      const plugin = freshPlugin();
      await plugin.processToolCall({ command: 'reset' });

      let eruptionHint = null;
      for (let turn = 0; turn < 8 && !eruptionHint; turn += 1) {
        const processed = await plugin.processMessages([
          { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
          { role: 'user', content: `你又搞错了，报错了，停下别这样，第 ${turn} 次失败。` },
          {
            role: 'assistant',
            content: `<!--persona_delta:{"impact":"moderate","frustration_delta":{"safety":1.2,"connection":1.2},"reason":"被否定 ${turn}"}-->`,
          },
        ]);
        if (readActiveState().phase.name === 'eruption') {
          eruptionHint = processed[0].content;
        }
      }

      assert(eruptionHint, 'pressure never crossed the eruption threshold within 8 turns');
      assert.match(eruptionHint, /相变状态：爆发/);
      const erupted = readActiveState();
      assert(erupted.signals.defiance >= 0.8, `eruption should spike defiance: ${erupted.signals.defiance}`);
      assert(erupted.signals.warmth <= 0.3, `eruption should suppress warmth: ${erupted.signals.warmth}`);
      assert(erupted.phase.lastEruptionAt, 'eruption timestamp missing');

      await plugin.processMessages([
        { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
        { role: 'user', content: '怎么突然这么大火气……' },
      ]);
      const cooling = readActiveState();
      assert.equal(cooling.phase.name, 'cooling');
      assert(cooling.signals.warmth <= 0.45, 'cooling keeps warmth subdued');

      await plugin.processMessages([
        { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
        { role: 'user', content: '抱抱你，我很喜欢你，想你了，温柔点好不好。' },
      ]);
      const grounded = readActiveState();
      assert.equal(grounded.phase.name, 'grounded', 'sincere affection should end cooling early');
      assertBoundedState(grounded);
    });
  });
});

test('OpenHerPersona burst mode follows expression state and strict client gating', async () => {
  await withRestoredState(async () => {
    await withFixedRandom(async () => {
      const plugin = freshPlugin();
      const affectionateTurn = '想你了，抱抱我吧，今晚陪我聊聊天好不好。';
      const vcpchatConfig = { vcpchatExtensions: { openHerPersonaAgent: { agentId: 'nova-id', agentName: 'Nova' } } };

      // VCPChat 来源（vcpchatExtensions）+ 亲昵语境 → 下发分条指令
      await plugin.processToolCall({ command: 'reset', agentId: 'nova-id', agentName: 'Nova' });
      const viaVcpchat = await plugin.processMessages([
        { role: 'system', content: 'base system' },
        { role: 'user', content: affectionateTurn },
      ], vcpchatConfig);
      assert.match(viaVcpchat[0].content, /聊天分条模式/);
      assert.match(viaVcpchat[0].content, /HTML 表达模式/);
      assert.equal(readAgentState('nova-id').expression.burst, true);

      // 同样的亲昵语境但来源不明 → 默认拒绝
      await plugin.processToolCall({ command: 'reset' });
      const unknownClient = await plugin.processMessages([
        { role: 'system', content: 'base system' },
        { role: 'user', content: affectionateTurn },
      ]);
      assert.doesNotMatch(unknownClient[0].content, /聊天分条模式/, 'unknown clients must not receive markers');
      assert.doesNotMatch(unknownClient[0].content, /HTML 表达模式/, 'unknown clients must not receive HTML hint');

      // OneRing 标识为 VCPChat → 允许
      const viaOneRingVcpchat = await plugin.processMessages([
        { role: 'system', content: '[[OneRing::Ring::VCPChat]]\nbase system' },
        { role: 'user', content: affectionateTurn },
      ]);
      assert.match(viaOneRingVcpchat[0].content, /聊天分条模式/);

      // OneRing 标识为 QQ → 拒绝
      const viaQq = await plugin.processMessages([
        { role: 'system', content: '[[OneRing::Ring::VCPQQBot]]\nbase system' },
        { role: 'user', content: affectionateTurn },
      ]);
      assert.doesNotMatch(viaQq[0].content, /聊天分条模式/, 'QQ clients must not receive markers');

      // VCPChat 来源 + 技术语境 → auto 模式不下发
      await plugin.processToolCall({ command: 'reset', agentId: 'nova-id', agentName: 'Nova' });
      const technical = await plugin.processMessages([
        { role: 'system', content: 'base system' },
        { role: 'user', content: '帮我分析这段源码的算法实现、模块架构和测试函数，讲讲底层原理。' },
      ], vcpchatConfig);
      assert.doesNotMatch(technical[0].content, /聊天分条模式/);

      // always 模式：技术语境也下发（模型按指令自行豁免技术内容）
      const alwaysPlugin = freshPlugin({ OpenHerPersonaBurstMode: 'always' });
      await alwaysPlugin.processToolCall({ command: 'reset', agentId: 'nova-id', agentName: 'Nova' });
      const alwaysTechnical = await alwaysPlugin.processMessages([
        { role: 'system', content: 'base system' },
        { role: 'user', content: '帮我分析这段源码的算法实现、模块架构和测试函数，讲讲底层原理。' },
      ], vcpchatConfig);
      assert.match(alwaysTechnical[0].content, /聊天分条模式/);

      // HTML 提示可独立关闭，不影响分条提示
      const htmlOffPlugin = freshPlugin({ OpenHerPersonaHtmlHintEnabled: false });
      await htmlOffPlugin.processToolCall({ command: 'reset', agentId: 'nova-id', agentName: 'Nova' });
      const htmlOff = await htmlOffPlugin.processMessages([
        { role: 'system', content: 'base system' },
        { role: 'user', content: affectionateTurn },
      ], vcpchatConfig);
      assert.match(htmlOff[0].content, /聊天分条模式/);
      assert.doesNotMatch(htmlOff[0].content, /HTML 表达模式/);
    });
  });
});

const anchorCachePath = path.join(repoRoot, 'Plugin', 'OpenHerPersona', 'state', 'semantic-anchor-cache.sqlite');
const legacyAnchorCachePath = path.join(repoRoot, 'Plugin', 'OpenHerPersona', 'state', 'semantic-anchor-cache.json');

function removeAnchorCache() {
  for (const cachePath of [
    anchorCachePath,
    `${anchorCachePath}-shm`,
    `${anchorCachePath}-wal`,
    legacyAnchorCachePath,
  ]) {
    try {
      fs.unlinkSync(cachePath);
    } catch (_) {
      // cache may not exist
    }
  }
}

// Deterministic toy embedder: character-frequency vector. Identical texts get
// cosine 1.0, so a message equal to an anchor phrase maxes out that feature.
function charFrequencyEmbedder(texts) {
  return Promise.resolve(texts.map((text) => {
    const vector = new Array(96).fill(0);
    for (const char of String(text)) {
      vector[char.codePointAt(0) % 96] += 1;
    }
    return vector;
  }));
}

test('OpenHerPersona semantic context raises matching feature above the keyword heuristic', async () => {
  await withRestoredState(async () => {
    await withFixedRandom(async () => {
      try {
        const affectionMessage = '我好想你，想一直陪着你';

        const heuristicPlugin = freshPlugin({ OpenHerPersonaSemanticContext: false });
        await heuristicPlugin.processToolCall({ command: 'reset' });
        await heuristicPlugin.processMessages([
          { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
          { role: 'user', content: affectionMessage },
        ]);
        const heuristicAffection = readActiveState().genome.lastContext.affection;

        const semanticPlugin = freshPlugin(
          { OpenHerPersonaSemanticContext: true, OpenHerPersonaSemanticWeight: 0.5 },
          { embeddingProvider: charFrequencyEmbedder }
        );
        await semanticPlugin.processToolCall({ command: 'reset' });
        await semanticPlugin.processMessages([
          { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
          { role: 'user', content: affectionMessage },
        ]);
        const semanticState = readActiveState();
        const semanticAffection = semanticState.genome.lastContext.affection;

        assert(
          semanticAffection > heuristicAffection + 0.1,
          `semantic affection ${semanticAffection} should exceed heuristic ${heuristicAffection}`
        );
        assert(fs.existsSync(anchorCachePath), 'anchor vectors should be cached to SQLite on disk');
        assertBoundedState(semanticState);
      } finally {
        removeAnchorCache();
      }
    });
  });
});

test('OpenHerPersona falls back to the keyword heuristic when the embedding provider fails', async () => {
  await withRestoredState(async () => {
    await withFixedRandom(async () => {
      try {
        const failingProvider = () => Promise.reject(new Error('embedding service down'));
        const plugin = freshPlugin(
          { OpenHerPersonaSemanticContext: true },
          { embeddingProvider: failingProvider }
        );
        await plugin.processToolCall({ command: 'reset' });

        await plugin.processMessages([
          { role: 'system', content: '[[OneRing::Nova::VCPChat]]\nbase system' },
          { role: 'user', content: '嵌入挂了也要正常聊天。' },
        ]);
        const state = readActiveState();
        assert(state.turnCount >= 1);
        assertBoundedState(state);
      } finally {
        removeAnchorCache();
      }
    });
  });
});
