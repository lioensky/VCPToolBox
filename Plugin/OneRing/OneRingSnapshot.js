'use strict';
// OneRingSnapshot.js — 同来源 post 快照与精确编辑更新模块
//
// 设计目标：
// 1. 每个 (agentName, frontendSource) 保存上一轮真实同端 post 的位置快照。
// 2. 下一轮同来源 post 到来时，先用完全一致的 role+hash 锚点对齐。
// 3. 对齐可靠时，位置相同但 hash 变化的块直接按旧快照 dbId 更新 messages.content。
// 4. UPDATE 绝不修改 timestamp，保证 OneRing 时间线稳定。

const crypto = require('crypto');
const db = require('./OneRingDB.js');
const fuzzy = require('./OneRingFuzzy.js');

const SNAPSHOT_TABLE = 'oneRingPostSnapshots';

function normalizeText(text) {
    return fuzzy.normalize(typeof text === 'string' ? text : '');
}

function contentHash(text) {
    return crypto.createHash('sha256').update(normalizeText(text)).digest('hex');
}

function nowIso() {
    return new Date().toISOString();
}

function ensureSchema(agentName, projectBasePath) {
    const conn = db.getDb(agentName, projectBasePath);
    conn.exec(`CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (
        agentName TEXT NOT NULL,
        frontendSource TEXT NOT NULL,
        postIndex INTEGER NOT NULL,
        dbId INTEGER,
        role TEXT NOT NULL,
        contentHash TEXT NOT NULL,
        contentPreview TEXT,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (agentName, frontendSource, postIndex)
    );
    CREATE INDEX IF NOT EXISTS idx_onering_snapshot_source
        ON ${SNAPSHOT_TABLE}(agentName, frontendSource, postIndex);`);
    return conn;
}

function loadSnapshot(agentName, frontendSource, projectBasePath) {
    const conn = ensureSchema(agentName, projectBasePath);
    return conn.prepare(
        `SELECT * FROM ${SNAPSHOT_TABLE}
         WHERE agentName=? AND frontendSource=?
         ORDER BY postIndex ASC`
    ).all(agentName, frontendSource);
}

function hasMessageId(agentName, dbId, projectBasePath) {
    if (!Number.isInteger(Number(dbId))) return false;
    const conn = db.getDb(agentName, projectBasePath);
    const row = conn.prepare(
        'SELECT id FROM messages WHERE agentName=? AND id=? LIMIT 1'
    ).get(agentName, dbId);
    return !!row;
}

function buildBlocksWithHash(blocks) {
    return (Array.isArray(blocks) ? blocks : [])
        .map((block, index) => ({
            ...block,
            postIndex: index,
            hash: contentHash(block.text),
            normalizedText: normalizeText(block.text)
        }))
        .filter(block => block.role && block.normalizedText);
}

/**
 * 在旧快照和当前 post 之间寻找最佳位置偏移。
 * offset 语义：oldIndex = currentIndex + offset。
 */
function findBestAlignment(snapshotRows, currentBlocks) {
    if (!Array.isArray(snapshotRows) || snapshotRows.length === 0 || currentBlocks.length === 0) {
        return {
            reliable: false,
            offset: 0,
            exactMatches: 0,
            roleMatches: 0,
            comparable: 0,
            reason: 'empty_snapshot_or_current'
        };
    }

    const oldLen = snapshotRows.length;
    const curLen = currentBlocks.length;
    let best = {
        offset: 0,
        score: -Infinity,
        exactMatches: 0,
        roleMatches: 0,
        comparable: 0
    };

    for (let offset = -curLen + 1; offset <= oldLen - 1; offset++) {
        let score = 0;
        let exactMatches = 0;
        let roleMatches = 0;
        let comparable = 0;

        for (let ci = 0; ci < curLen; ci++) {
            const old = snapshotRows[ci + offset];
            const cur = currentBlocks[ci];
            if (!old) continue;

            comparable++;
            if (old.role !== cur.role) {
                score -= 3;
                continue;
            }

            roleMatches++;
            score += 1;

            if (old.contentHash === cur.hash) {
                exactMatches++;
                score += 6;
            }
        }

        // 同分时偏向 offset=0；再偏向更靠后的旧窗口，适配尾部上下文推进。
        const tieBreaker = (offset === 0 ? 0.2 : 0) + offset * 0.0001;
        const finalScore = score + tieBreaker;
        if (finalScore > best.score) {
            best = { offset, score: finalScore, exactMatches, roleMatches, comparable };
        }
    }

    const minComparable = Math.min(oldLen, curLen);
    const exactRatio = minComparable > 0 ? best.exactMatches / minComparable : 0;
    const roleRatio = best.comparable > 0 ? best.roleMatches / best.comparable : 0;

    // 高置信条件：
    // - 至少两个完全一致锚点；或
    // - 绝大多数块完全一致；或
    // - 等长 retry/edit 场景下至少一个完全一致锚点且角色序列基本一致。
    const reliable = best.exactMatches >= 2
        || exactRatio >= 0.5
        || (oldLen === curLen && best.exactMatches >= 1 && roleRatio >= 0.8);

    return {
        reliable,
        offset: best.offset,
        exactMatches: best.exactMatches,
        roleMatches: best.roleMatches,
        comparable: best.comparable,
        exactRatio,
        roleRatio,
        reason: reliable ? 'aligned' : 'insufficient_exact_anchors'
    };
}

/**
 * 基于上一轮快照更新当前 post 中的编辑块。
 * 只执行 UPDATE messages SET content=? WHERE id=?，不修改 timestamp。
 */
function applySnapshotEdits(agentName, frontendSource, postBlocks, projectBasePath, options = {}) {
    const debug = !!options.debug;
    const snapshotRows = loadSnapshot(agentName, frontendSource, projectBasePath);
    const currentBlocks = buildBlocksWithHash(postBlocks);
    const alignment = findBestAlignment(snapshotRows, currentBlocks);

    const result = {
        reliable: alignment.reliable,
        reason: alignment.reason,
        offset: alignment.offset,
        exactMatches: alignment.exactMatches,
        roleMatches: alignment.roleMatches,
        comparable: alignment.comparable,
        editedCount: 0,
        skippedCount: 0,
        editedPostIndices: [],
        editedDbIds: []
    };

    if (!alignment.reliable) return result;

    const conn = db.getDb(agentName, projectBasePath);
    const updateStmt = conn.prepare('UPDATE messages SET content=? WHERE agentName=? AND id=?');
    const tx = conn.transaction((edits) => {
        for (const edit of edits) {
            updateStmt.run(edit.text, agentName, edit.dbId);
        }
    });

    const edits = [];

    for (const cur of currentBlocks) {
        const old = snapshotRows[cur.postIndex + alignment.offset];
        if (!old) continue;

        if (old.role !== cur.role) {
            result.skippedCount++;
            continue;
        }

        if (old.contentHash === cur.hash) continue;

        if (!old.dbId || !hasMessageId(agentName, old.dbId, projectBasePath)) {
            result.skippedCount++;
            continue;
        }

        edits.push({
            postIndex: cur.postIndex,
            dbId: old.dbId,
            text: cur.text
        });
    }

    if (edits.length > 0) {
        tx(edits);
        result.editedCount = edits.length;
        result.editedPostIndices = edits.map(edit => edit.postIndex);
        result.editedDbIds = edits.map(edit => edit.dbId);
    }

    if (debug && result.editedCount > 0) {
        console.log(`[OneRingSnapshot] Updated ${result.editedCount} edited blocks by snapshot for agent="${agentName}" frontend="${frontendSource}" dbIds=${result.editedDbIds.join(',')}`);
    }

    return result;
}

function findBestDbWindow(currentBlocks, dbRows) {
    if (currentBlocks.length === 0 || !Array.isArray(dbRows) || dbRows.length === 0) return 0;

    let bestStart = 0;
    let bestScore = -Infinity;
    const maxStart = Math.max(0, dbRows.length - 1);

    for (let start = 0; start <= maxStart; start++) {
        let score = 0;
        for (let i = 0; i < currentBlocks.length; i++) {
            const row = dbRows[start + i];
            const block = currentBlocks[i];
            if (!row) {
                score -= 1;
                continue;
            }
            if (row.role !== block.role) {
                score -= 3;
                continue;
            }
            score += 1;
            if (contentHash(row.content) === block.hash) score += 6;
        }
        if (score >= bestScore) {
            bestScore = score;
            bestStart = start;
        }
    }

    return bestStart;
}

/**
 * 用当前真实同端 post 覆盖保存最新快照。
 * 保存前从 messages 表中按 role+hash 顺序映射 dbId，避免靠 content 直接反查导致重复文本歧义。
 */
function saveSnapshotFromDb(agentName, frontendSource, postBlocks, projectBasePath, options = {}) {
    const debug = !!options.debug;
    const maxSnapshotBlocks = Number.isFinite(parseInt(options.maxSnapshotBlocks, 10))
        ? Math.max(1, parseInt(options.maxSnapshotBlocks, 10))
        : 20;
    const allCurrentBlocks = buildBlocksWithHash(postBlocks);
    // post 上下文快照只保留尾部窗口，避免快照表无限增长；默认 20 块。
    // postIndex 重新从 0 编号，下一轮同来源 post 通过 role+hash 锚点自动对齐。
    const currentBlocks = allCurrentBlocks.slice(-maxSnapshotBlocks).map((block, index) => ({
        ...block,
        postIndex: index
    }));
    const conn = ensureSchema(agentName, projectBasePath);

    if (currentBlocks.length === 0) {
        conn.prepare(`DELETE FROM ${SNAPSHOT_TABLE} WHERE agentName=? AND frontendSource=?`).run(agentName, frontendSource);
        return { savedCount: 0, mappedCount: 0 };
    }

    const dbRows = db.getRecentMessagesByFrontend(
        agentName,
        frontendSource,
        Math.max(currentBlocks.length * 3, maxSnapshotBlocks),
        projectBasePath
    );
    const start = findBestDbWindow(currentBlocks, dbRows);
    const usedIds = new Set();
    const now = nowIso();

    const rows = currentBlocks.map((block, index) => {
        let mapped = null;

        // 优先使用最佳窗口同位置精确匹配。
        const direct = dbRows[start + index];
        if (
            direct &&
            direct.role === block.role &&
            contentHash(direct.content) === block.hash &&
            !usedIds.has(direct.id)
        ) {
            mapped = direct;
        }

        // 兜底：从最佳窗口附近向后找未使用的 role+hash 精确匹配。
        if (!mapped) {
            mapped = dbRows.find(row =>
                row &&
                row.role === block.role &&
                contentHash(row.content) === block.hash &&
                !usedIds.has(row.id)
            ) || null;
        }

        if (mapped) usedIds.add(mapped.id);

        return {
            postIndex: index,
            dbId: mapped ? mapped.id : null,
            role: block.role,
            contentHash: block.hash,
            contentPreview: block.normalizedText.slice(0, 200),
            updatedAt: now
        };
    });

    const tx = conn.transaction((items) => {
        conn.prepare(`DELETE FROM ${SNAPSHOT_TABLE} WHERE agentName=? AND frontendSource=?`).run(agentName, frontendSource);
        const insert = conn.prepare(
            `INSERT INTO ${SNAPSHOT_TABLE}
             (agentName, frontendSource, postIndex, dbId, role, contentHash, contentPreview, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const item of items) {
            insert.run(
                agentName,
                frontendSource,
                item.postIndex,
                item.dbId,
                item.role,
                item.contentHash,
                item.contentPreview,
                item.updatedAt
            );
        }
    });

    tx(rows);

    const mappedCount = rows.filter(row => row.dbId).length;
    if (debug) {
        console.log(`[OneRingSnapshot] Saved snapshot agent="${agentName}" frontend="${frontendSource}" blocks=${rows.length} mapped=${mappedCount}`);
    }

    return { savedCount: rows.length, mappedCount };
}

module.exports = {
    contentHash,
    loadSnapshot,
    applySnapshotEdits,
    saveSnapshotFromDb
};