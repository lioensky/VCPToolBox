"use strict";

const fs = require("fs");

const RESOURCE_SETTINGS = {
  OpenHerPersonaGlobalConcurrency: [2, 1, 16, "全局观测并发"],
  OpenHerPersonaGlobalQueueMaxSize: [128, 1, 4096, "全局待处理任务上限"],
  OpenHerPersonaQueueMaxBytes: [1048576, 8192, 16777216, "待处理任务文本字节预算"],
  OpenHerPersonaMessageCacheMaxBytes: [1048576, 0, 16777216, "消息向量缓存字节预算"],
  OpenHerPersonaMessageCacheTtlMs: [300000, 1000, 3600000, "消息向量缓存有效期毫秒"],
  OpenHerPersonaSqliteCacheKiB: [4096, 256, 65536, "SQLite 页缓存预算 KiB"],
  OpenHerPersonaAuditRetentionDays: [30, 1, 3650, "审计保留天数"],
  OpenHerPersonaAuditMaxRowsPerAgent: [1000, 0, 100000, "每 Agent 审计条数上限（0 为不记录）"],
  OpenHerPersonaMaintenanceIntervalMs: [60000, 1000, 3600000, "维护间隔毫秒"],
  OpenHerPersonaMaintenanceBatchSize: [100, 1, 1000, "每轮迁移/清理行数上限"],
};

function resourceDefaults() {
  return Object.fromEntries(Object.entries(RESOURCE_SETTINGS).map(([key, [value]]) => [key, value]));
}

function resourceSchema() {
  return Object.fromEntries(Object.entries(RESOURCE_SETTINGS).map(([key, [, min, max, label]]) =>
    [key, { type: "integer", min, max, label }]));
}

function resolveResources(config) {
  return Object.fromEntries(Object.entries(RESOURCE_SETTINGS).map(([key, [fallback, min, max]]) => {
    const value = Number(config[key]);
    return [key, Math.max(min, Math.min(max, Number.isFinite(value) ? Math.trunc(value) : fallback))];
  }));
}

function isVector(vector) {
  return (Array.isArray(vector) || vector instanceof Float32Array || vector instanceof Float64Array) &&
    vector.length > 0 && vector.length <= 65536 &&
    vector.every((value) => typeof value === "number" && Number.isFinite(value) && Number.isFinite(Math.fround(value)));
}

// Explicit little-endian encoding, independent of CPU alignment and endianness.
function encodeVector(vector) {
  if (!isVector(vector)) throw new Error("Invalid embedding vector");
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) buffer.writeFloatLE(vector[index], index * 4);
  return buffer;
}

function decodeVector(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length % 4 || buffer.length > 65536 * 4) return null;
  const vector = new Float32Array(buffer.length / 4);
  for (let index = 0; index < vector.length; index += 1) vector[index] = buffer.readFloatLE(index * 4);
  return isVector(vector) ? vector : null;
}

function applyDatabaseBudget(db, config) {
  db.pragma(`cache_size = -${config.OpenHerPersonaSqliteCacheKiB}`);
  db.pragma("mmap_size = 0");
  db.pragma("temp_store = FILE");
  db.pragma("wal_autocheckpoint = 256");
  db.pragma("journal_size_limit = 4194304");
}

function upgradeAnchorStorage(db, databasePath) {
  const columns = db.prepare("PRAGMA table_info(openher_axis_anchors)").all();
  if (columns.some((column) => column.name === "vector_blob")) return;
  // VACUUM INTO produces a consistent snapshot including committed WAL contents.
  // A partial backup is never published as a successful backup.
  if (db.prepare("SELECT 1 FROM openher_axis_anchors LIMIT 1").get()) {
    const backupPath = `${databasePath}.pre-f32.bak`;
    if (!fs.existsSync(backupPath)) {
      const temporaryPath = `${backupPath}.tmp`;
      fs.rmSync(temporaryPath, { force: true });
      db.prepare("VACUUM INTO ?").run(temporaryPath);
      fs.renameSync(temporaryPath, backupPath);
    }
  }
  db.exec("ALTER TABLE openher_axis_anchors ADD COLUMN vector_blob BLOB");
}

function migrateVectorBatch(db, limit) {
  // rowid cursor prevents a malformed legacy vector from starving later records.
  const cursorRow = db.prepare("SELECT value FROM openher_axis_meta WHERE key = 'f32MigrationCursor'").get();
  const cursor = Number(cursorRow && cursorRow.value) || 0;
  const rows = db.prepare(`SELECT rowid, vector_json FROM openher_axis_anchors
    WHERE rowid > ? AND vector_blob IS NULL ORDER BY rowid LIMIT ?`).all(cursor, limit);
  let migrated = 0;
  db.transaction(() => {
    const update = db.prepare("UPDATE openher_axis_anchors SET vector_blob = ?, vector_json = '[]' WHERE rowid = ?");
    for (const row of rows) {
      try {
        const vector = JSON.parse(row.vector_json);
        if (isVector(vector)) {
          update.run(encodeVector(vector), row.rowid);
          migrated += 1;
        }
      } catch (_) {
        // Preserve malformed legacy data; observation may regenerate its anchors.
      }
    }
    db.prepare(`INSERT INTO openher_axis_meta(key, value) VALUES ('f32MigrationCursor', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(String(rows.length ? rows[rows.length - 1].rowid : 0));
  })();
  return migrated;
}

function maintainDatabase(db, config, definitions) {
  const limit = config.OpenHerPersonaMaintenanceBatchSize;
  const result = { migrated: migrateVectorBatch(db, limit), auditDeleted: 0, anchorsDeleted: 0 };
  const cutoff = new Date(Date.now() - config.OpenHerPersonaAuditRetentionDays * 86400000).toISOString();
  result.auditDeleted = db.prepare(`DELETE FROM openher_axis_audit WHERE rowid IN (
    SELECT rowid FROM openher_axis_audit WHERE at < ? ORDER BY at LIMIT ?
  )`).run(cutoff, limit).changes;

  // Rotate across agents without materializing the whole agent list.
  const previous = db.prepare("SELECT value FROM openher_axis_meta WHERE key = 'maintenanceAgent'").get();
  const agent = db.prepare(`SELECT agent_key FROM (
    SELECT agent_key FROM openher_axis_state UNION SELECT agent_key FROM openher_axis_audit
    UNION SELECT agent_key FROM openher_axis_anchors
  ) WHERE agent_key > ? ORDER BY agent_key LIMIT 1`).get(previous ? previous.value : "");
  if (agent) {
    const key = agent.agent_key;
    const remaining = limit - result.auditDeleted;
    if (remaining > 0) {
      result.auditDeleted += db.prepare(`DELETE FROM openher_axis_audit WHERE rowid IN (
        SELECT rowid FROM openher_axis_audit WHERE agent_key = ? ORDER BY at DESC LIMIT ? OFFSET ?
      )`).run(key, remaining, config.OpenHerPersonaAuditMaxRowsPerAgent).changes;
    }
    const state = db.prepare("SELECT agent_label FROM openher_axis_state WHERE agent_key = ?").get(key);
    if (!state) {
      result.anchorsDeleted = db.prepare(`DELETE FROM openher_axis_anchors WHERE rowid IN (
        SELECT rowid FROM openher_axis_anchors WHERE agent_key = ? LIMIT ?
      )`).run(key, limit).changes;
    } else {
      // At most one bounded metadata page per tick, with a persistent scan cursor.
      const scan = db.prepare("SELECT value FROM openher_axis_meta WHERE key = 'anchorCleanupCursor'").get();
      const rows = db.prepare(`SELECT rowid, agent_key, layer, axis, sub_axis, anchor_text, model_sig
        FROM openher_axis_anchors WHERE rowid > ? ORDER BY rowid LIMIT ?`)
        .all(Number(scan && scan.value) || 0, limit);
      const remove = db.prepare("DELETE FROM openher_axis_anchors WHERE rowid = ?");
      for (const row of rows) {
        const owner = row.agent_key === key ? state :
          db.prepare("SELECT agent_label FROM openher_axis_state WHERE agent_key = ?").get(row.agent_key);
        const modelSig = String(process.env.EmbeddingModelSig || process.env.WhitelistEmbeddingModel || "unknown");
        const valid = owner && row.model_sig === modelSig && definitions.some((definition) =>
          definition.layer === row.layer && definition.axis === row.axis &&
          definition.anchors.some((anchor) => anchor.subAxis === row.sub_axis &&
            anchor.text.replace(/\{name\}/g, owner.agent_label) === row.anchor_text));
        if (!valid) result.anchorsDeleted += remove.run(row.rowid).changes;
      }
      db.prepare(`INSERT INTO openher_axis_meta(key, value) VALUES ('anchorCleanupCursor', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(String(rows.length ? rows[rows.length - 1].rowid : 0));
    }
  }
  db.prepare(`INSERT INTO openher_axis_meta(key, value) VALUES ('maintenanceAgent', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(agent ? agent.agent_key : "");
  db.pragma("wal_checkpoint(PASSIVE)");
  db.pragma("shrink_memory");
  return result;
}

module.exports = {
  RESOURCE_SETTINGS, resourceDefaults, resourceSchema, resolveResources,
  isVector, encodeVector, decodeVector, applyDatabaseBudget, upgradeAnchorStorage, maintainDatabase,
};