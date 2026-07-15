'use strict';

/**
 * 对 SQLite IN 查询进行分块，避免超过绑定参数数量限制。
 * sqlPrefix 必须以待匹配字段结尾，例如："... WHERE chunks.id"。
 *
 * @param {object} db better-sqlite3 连接
 * @param {string} sqlPrefix
 * @param {Array<unknown>} values
 * @param {string} [sqlSuffix='']
 * @param {number} [chunkSize=500]
 * @returns {Array<object>}
 */
function queryByChunks(db, sqlPrefix, values, sqlSuffix = '', chunkSize = 500) {
    if (!db || typeof db.prepare !== 'function') {
        throw new TypeError('queryByChunks requires a valid database connection');
    }
    if (!Array.isArray(values) || values.length === 0) return [];

    const safeChunkSize = Math.max(1, Math.floor(Number(chunkSize) || 500));
    const rows = [];

    for (let i = 0; i < values.length; i += safeChunkSize) {
        const batch = values.slice(i, i + safeChunkSize);
        const placeholders = batch.map(() => '?').join(',');
        rows.push(
            ...db.prepare(
                `${sqlPrefix} IN (${placeholders})${sqlSuffix}`
            ).all(...batch)
        );
    }

    return rows;
}

module.exports = {
    queryByChunks
};