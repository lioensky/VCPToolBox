'use strict';
// OneRingDB.js — SQLite 操作层
// 表结构：messages(id, agentName, role, senderName, frontendSource, content, timestamp, postContextHash)

const path = require('path');
let Database;
try { Database = require('better-sqlite3'); } catch (e) {console.error('[OneRingDB] better-sqlite3 not available:', e.message);
}

const DB_DIR = path.join(__dirname, 'data');
const dbCache = new Map(); // agentName -> db instance

function getDb(agentName, projectBasePath) {
    if (dbCache.has(agentName)) return dbCache.get(agentName);
    if (!Database) throw new Error('better-sqlite3 unavailable');

    const fs = require('fs');
    const dir = projectBasePath ? path.join(projectBasePath, 'Plugin', 'OneRing', 'data') : DB_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const db = new Database(path.join(dir, `${agentName}.db`));
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agentName TEXT NOT NULL,
        role TEXT NOT NULL,
        senderName TEXT,
        frontendSource TEXT,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        postContextHash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_ts ON messages(agentName, timestamp);`);
    dbCache.set(agentName, db);
    return db;
}

/**
 * 修剪指定 agent 的旧消息，仅保留最近 maxRecords 条。
 * maxRecords <= 0 表示不限制。
 */
function pruneAgentMessages(agentName, maxRecords = 100, projectBasePath) {
    const limit = parseInt(maxRecords, 10);
    if (!Number.isFinite(limit) || limit <= 0) return;

    const db = getDb(agentName, projectBasePath);
    db.prepare(
        `DELETE FROM messages
         WHERE agentName=?
           AND id NOT IN (
               SELECT id FROM messages
               WHERE agentName=?
               ORDER BY timestamp DESC, id DESC
               LIMIT ?
           )`
    ).run(agentName, agentName, limit);
}

/**
 * 插入一条消息记录。
 * 默认每个 agent 最多保留 100 条消息，避免 SQLite 无限增长。
 */
function insertMessage(agentName, { role, senderName, frontendSource, content, timestamp, postContextHash, maxRecords = 100 }, projectBasePath) {
    const db = getDb(agentName, projectBasePath);
    const result = db.prepare(
        `INSERT INTO messages (agentName, role, senderName, frontendSource, content, timestamp, postContextHash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(agentName, role, senderName || null, frontendSource || null, content, timestamp, postContextHash || null);

    pruneAgentMessages(agentName, maxRecords, projectBasePath);
    return result;
}

/**
 * 更新一条已有消息的 content（用于 retry/编辑场景）
 */
function updateMessageContent(id, content) {
    // db 实例由调用方传入，避免重复查 agentName
    // 实际调用时通过 getDb(agentName) 拿到 db 再操作
    throw new Error('Use updateMessageById(agentName, id, content, projectBasePath)');
}

function updateMessageById(agentName, id, content, projectBasePath) {
    const db = getDb(agentName, projectBasePath);
    db.prepare(`UPDATE messages SET content=? WHERE id=?`).run(content, id);
}

/**
 * 查询指定 agent 的最近 N 条消息（按时间戳升序）
 */
function getRecentMessages(agentName, limit, projectBasePath) {
    const db = getDb(agentName, projectBasePath);
    return db.prepare(
        `SELECT * FROM (SELECT * FROM messages WHERE agentName=? ORDER BY timestamp DESC LIMIT ?)
         ORDER BY timestamp ASC`
    ).all(agentName, limit);
}

/**
 * 查询指定 agent、指定前端来源的最近 N 条消息
 */
function getRecentMessagesByFrontend(agentName, frontendSource, limit, projectBasePath) {
    const db = getDb(agentName, projectBasePath);
    return db.prepare(
        `SELECT * FROM (SELECT * FROM messages WHERE agentName=? AND frontendSource=? ORDER BY timestamp DESC LIMIT ?)
         ORDER BY timestamp ASC`
    ).all(agentName, frontendSource, limit);
}

/**
 * 查询两个时间戳之间其他前端来源的消息（用于跨端补充）
 */
function getMessagesBetweenTimestamps(agentName, tsStart, tsEnd, excludeFrontend, projectBasePath) {
    const db = getDb(agentName, projectBasePath);
    return db.prepare(
        `SELECT * FROM messages WHERE agentName=? AND timestamp > ? AND timestamp < ?
         AND (frontendSource != ? OR frontendSource IS NULL)
         ORDER BY timestamp ASC`
    ).all(agentName, tsStart, tsEnd, excludeFrontend);
}

/**
 * 关闭所有 db 连接（shutdown 时调用）
 */
function closeAll() {
    for (const db of dbCache.values()) {
        try { db.close(); } catch (e) { /* ignore */ }
    }
    dbCache.clear();
}

module.exports = {
    getDb,
    insertMessage,
    updateMessageById,
    getRecentMessages,
    getRecentMessagesByFrontend,
    getMessagesBetweenTimestamps,
    pruneAgentMessages,
    closeAll
};