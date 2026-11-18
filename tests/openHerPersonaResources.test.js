const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const Database = require("better-sqlite3");
const resources = require("../Plugin/OpenHerPersona/ObserverResources.js");

const pluginPath = path.resolve(__dirname, "../Plugin/OpenHerPersona/OpenHerPersona.js");

function fixture(config = {}, provider = async (texts) => texts.map(() => [0.2, 0.4, 0.6]), bridge = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openher-resources-"));
  const realRequire = createRequire(pluginPath);
  const localRequire = (name) => {
    if (name === "../../modules/messageProcessor.js") {
      return { isBetaSystemUserText: () => false, isSystemNotificationText: () => false };
    }
    if (name === "../../EmbeddingUtils.js") {
      return { getEmbeddingsBatch: provider, cosineSimilarity: (a, b) => {
        let dot = 0, aa = 0, bb = 0;
        for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
        return dot / (Math.sqrt(aa * bb) + 1e-8);
      } };
    }
    if (name === "chokidar") return { watch: () => ({ on() { return this; }, close() {} }) };
    return realRequire(name);
  };
  const source = fs.readFileSync(pluginPath, "utf8")
    .replace('const STATE_DIR = path.join(__dirname, "state");', `const STATE_DIR = ${JSON.stringify(directory)};`);
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports,__dirname){${source}\n})`, { filename: pluginPath })(
    localRequire, module, module.exports, path.dirname(pluginPath));
  const plugin = module.exports;
  plugin.initialize({
    OpenHerPersonaAsyncObservation: false,
    OpenHerPersonaDropLegacyState: false,
    ...config,
  }, { embeddingProvider: provider, contextBridge: bridge });
  const handles = [];
  return {
    plugin, directory,
    db: () => {
      const db = new Database(path.join(directory, "openher-axis-state.sqlite"));
      handles.push(db);
      return db;
    },
    close() {
      for (const db of handles) if (db.open) db.close();
      plugin.shutdown();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function messages(agent, turn) {
  return [
    { role: "system", content: `[[OneRing::${agent}::VCPChat]]` },
    { role: "assistant", content: `表达 ${turn}` },
    { role: "user", content: "继续" },
  ];
}

test("float32 encoding validates input and preserves cosine precision", () => {
  const vector = [0.123456789, -0.55, 0.9];
  const encoded = resources.encodeVector(vector);
  assert.equal(encoded.length, 12);
  const decoded = resources.decodeVector(encoded);
  vector.forEach((value, index) => assert(Math.abs(decoded[index] - value) < 1e-7));
  assert.equal(resources.decodeVector(Buffer.alloc(3)), null);
  assert.throws(() => resources.encodeVector([NaN]));
});

test("legacy database upgrades in place with a consistent backup and bounded resumable conversion", async () => {
  const f = fixture();
  try {
    await f.plugin.processToolCall({ command: "reset", agent: "one" });
    await f.plugin.processToolCall({ command: "reset", agent: "two" });
    const db = f.db();
    db.exec("ALTER TABLE openher_axis_anchors DROP COLUMN vector_blob");
    const insert = db.prepare(`INSERT INTO openher_axis_anchors
      VALUES (?, 'drive', 'test', 'test', 'text', ?, ?, '2026')`);
    const model = String(process.env.EmbeddingModelSig || process.env.WhitelistEmbeddingModel || "unknown");
    insert.run("one", "[0.1,0.2,0.3]", model);
    insert.run("two", "[0.4,0.5,0.6]", model);
    const databasePath = path.join(f.directory, "openher-axis-state.sqlite");
    resources.upgradeAnchorStorage(db, databasePath);
    const backup = new Database(`${databasePath}.pre-f32.bak`, { readonly: true });
    assert.equal(backup.prepare("SELECT count(*) AS n FROM openher_axis_anchors").get().n, 2);
    backup.close();
    const config = resources.resourceDefaults();
    config.OpenHerPersonaMaintenanceBatchSize = 1;
    const definitions = [{ layer: "drive", axis: "test", anchors: [{ subAxis: "test", text: "text" }] }];
    resources.maintainDatabase(db, config, definitions);
    assert.equal(db.prepare("SELECT count(*) AS n FROM openher_axis_anchors WHERE vector_blob IS NOT NULL").get().n, 1);
    resources.maintainDatabase(db, config, definitions);
    assert.equal(db.prepare("SELECT count(*) AS n FROM openher_axis_anchors WHERE vector_blob IS NOT NULL").get().n, 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM openher_axis_state").get().n, 2);
    db.close();
  } finally { f.close(); }
});

test("continuous observations retain bounded cache and release empty queues", async () => {
  const f = fixture({ OpenHerPersonaMessageCacheMaxBytes: 24 });
  try {
    for (let turn = 0; turn < 100; turn++) await f.plugin.processMessages(messages("steady", turn));
    const status = await f.plugin.processToolCall({ command: "status", agent: "steady" });
    assert.equal(status.state.observationCount, 100);
    assert.equal(status.resources.pending, 0);
    assert.equal(status.resources.running, 0);
    assert.equal(status.resources.trackedQueues, 0);
    assert(status.resources.messageCacheBytes <= 24);
    const db = f.db();
    const rows = db.prepare("SELECT vector_json, length(vector_blob) AS bytes FROM openher_axis_anchors").all();
    assert(rows.length > 32);
    assert(rows.every((row) => row.vector_json === "[]" && row.bytes === 12));
    assert.equal(db.prepare("SELECT count(*) AS n FROM openher_axis_state").get().n, 1);
    db.close();
  } finally { f.close(); }
});

test("hung embedding calls remain bounded after observation timeout", async () => {
  let calls = 0;
  let release;
  const request = new Promise((resolve) => { release = resolve; });
  const f = fixture({
    OpenHerPersonaGlobalConcurrency: 1,
    OpenHerPersonaEmbeddingTimeoutMs: 200,
  }, () => { calls++; return request; });
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    await f.plugin.processMessages(messages("hung", 0));
    for (let turn = 1; turn < 20; turn++) await f.plugin.processMessages(messages("hung", turn));
    const status = await f.plugin.processToolCall({ command: "status" });
    assert.equal(calls, 1);
    assert.equal(status.resources.pendingEmbeddingRequests, 1);
    assert.equal(status.resources.trackedQueues, 0);
    release([[0.2, 0.4, 0.6]]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await f.plugin.processToolCall({ command: "status" })).resources.pendingEmbeddingRequests, 0);
  } finally { clearTimeout(keepAlive); release(null); f.close(); }
});

test("audit cleanup preserves current state and enforces per-agent retention", async () => {
  const f = fixture();
  try {
    await f.plugin.processMessages(messages("audit", 0));
    const db = f.db();
    const insert = db.prepare("INSERT INTO openher_axis_audit VALUES ('audit', ?, 'observe', '{}')");
    for (let index = 0; index < 20; index++) insert.run(`2099-01-01T00:00:00.000Z-${index}`);
    insert.run("2000-01-01");
    const config = { ...resources.resourceDefaults(), OpenHerPersonaAuditMaxRowsPerAgent: 3 };
    for (let index = 0; index < 4; index++) resources.maintainDatabase(db, config, []);
    assert(db.prepare("SELECT count(*) AS n FROM openher_axis_audit").get().n <= 3);
    assert.equal(db.prepare("SELECT observation_count FROM openher_axis_state WHERE agent_key = 'audit'").get().observation_count, 1);
    db.close();
  } finally { f.close(); }
});

test("shared embeddings are consumed without a second local cache", async () => {
  const bridge = { sanitize: (text) => text, getEmbeddingFromCache: () => new Float32Array([0.2, 0.4, 0.6]) };
  const f = fixture({}, async (texts) => texts.map(() => new Float32Array([0.2, 0.4, 0.6])), bridge);
  try {
    for (let turn = 0; turn < 20; turn++) await f.plugin.processMessages(messages("shared", turn));
    const status = await f.plugin.processToolCall({ command: "status", agent: "shared" });
    assert.equal(status.state.observationCount, 20);
    assert.equal(status.resources.messageCacheBytes, 0);
    assert.equal(status.resources.messageCacheEntries, 0);
    assert.equal(status.resources.messageCacheMode, "shared-only");
  } finally { f.close(); }
});

test("slow requests obey queue bounds, deduplicate, and cannot resurrect deleted agents", async () => {
  let release;
  const f = fixture({
    OpenHerPersonaAsyncObservation: true,
    OpenHerPersonaGlobalConcurrency: 1,
    OpenHerPersonaGlobalQueueMaxSize: 3,
    OpenHerPersonaQueueMaxBytes: 8192,
  }, () => new Promise((resolve) => { release = resolve; }));
  try {
    await f.plugin.processMessages(messages("deleted", 0));
    await f.plugin.processMessages(messages("deleted", 0));
    for (let index = 0; index < 40; index++) {
      await f.plugin.processMessages(messages(`agent-${index}`, "x".repeat(4000)));
    }
    let status = await f.plugin.processToolCall({ command: "status" });
    assert.equal(status.resources.running, 1);
    assert(status.resources.pending <= 3);
    assert(status.resources.pendingTextBytes <= 8192);
    assert.equal(status.resources.deduplicated, 1);
    assert(status.resources.dropped > 0);
    await f.plugin.processToolCall({ command: "delete", agent: "deleted" });
    f.plugin.shutdown();
    release([[0.2, 0.4, 0.6]]);
    await new Promise((resolve) => setImmediate(resolve));
    const db = f.db();
    assert.equal(db.prepare("SELECT count(*) AS n FROM openher_axis_state WHERE agent_key = 'deleted'").get().n, 0);
    status = await f.plugin.processToolCall({ command: "status" });
    assert.equal(status.resources.pending, 0);
    assert.equal(status.resources.trackedQueues, 0);
    assert.equal(status.resources.pendingEmbeddingRequests, 0);
  } finally { if (release) release(null); f.close(); }
});