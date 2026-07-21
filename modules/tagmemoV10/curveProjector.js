'use strict';

function queryByChunks(db, sqlPrefix, values, sqlSuffix = '', chunkSize = 500) {
    if (!Array.isArray(values) || values.length === 0) return [];
    const output = [];
    for (let offset = 0; offset < values.length; offset += chunkSize) {
        const batch = values.slice(offset, offset + chunkSize);
        const placeholders = batch.map(() => '?').join(',');
        output.push(...db.prepare(
            `${sqlPrefix} IN (${placeholders})${sqlSuffix}`
        ).all(...batch));
    }
    return output;
}

function decodeVector(blob, dimension) {
    if (!blob || !Number.isFinite(dimension) || dimension <= 0) return null;
    if (blob instanceof Float32Array) {
        return blob.length === dimension
            ? Object.freeze(Array.from(blob))
            : null;
    }
    if (blob.length !== dimension * Float32Array.BYTES_PER_ELEMENT) return null;
    const aligned = blob.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0
        ? blob
        : Buffer.from(blob);
    return Object.freeze(Array.from(
        new Float32Array(aligned.buffer, aligned.byteOffset, dimension)
    ));
}

function projectCandidateCurves(db, candidates, options = {}) {
    if (!db?.prepare) throw new TypeError('projectCandidateCurves requires a database');
    const dimension = Math.max(1, Math.floor(Number(options.dimension) || 0));
    const ids = [...new Set((Array.isArray(candidates) ? candidates : [])
        .map(candidate => Number(candidate.id ?? candidate.chunkId ?? candidate.label))
        .filter(Number.isFinite))];
    if (ids.length === 0) {
        return Object.freeze({
            schema: 'tagmemo-v10-alpha-curves-v1',
            curves: Object.freeze([]),
            diagnostics: Object.freeze({
                requested: 0,
                projected: 0,
                missingChunks: 0,
                missingCurves: 0
            })
        });
    }

    const chunkRows = queryByChunks(
        db,
        `SELECT c.id, c.file_id, c.content, c.vector,
                f.path, f.diary_name, f.updated_at
         FROM chunks c
         JOIN files f ON f.id = c.file_id
         WHERE c.id`,
        ids
    );
    const chunkById = new Map(chunkRows.map(row => [Number(row.id), row]));
    const fileIds = [...new Set(chunkRows.map(row => Number(row.file_id)).filter(Number.isFinite))];
    const fileTagRows = queryByChunks(
        db,
        `SELECT ft.file_id, ft.tag_id, ft.position, t.name, t.vector
         FROM file_tags ft
         JOIN tags t ON t.id = ft.tag_id
         WHERE ft.file_id`,
        fileIds,
        ' ORDER BY ft.file_id ASC, ft.position ASC, ft.tag_id ASC'
    );
    const tagsByFile = new Map();
    for (const row of fileTagRows) {
        const fileId = Number(row.file_id);
        if (!tagsByFile.has(fileId)) tagsByFile.set(fileId, []);
        tagsByFile.get(fileId).push(Object.freeze({
            id: Number(row.tag_id),
            name: String(row.name || ''),
            position: Math.max(0, Number(row.position) || 0),
            vector: decodeVector(row.vector, dimension)
        }));
    }

    const inputById = new Map(
        candidates.map(candidate => [
            Number(candidate.id ?? candidate.chunkId ?? candidate.label),
            candidate
        ])
    );
    const curves = [];
    let missingChunks = 0;
    let missingCurves = 0;

    for (const id of ids) {
        const row = chunkById.get(id);
        if (!row) {
            missingChunks++;
            continue;
        }
        const chain = tagsByFile.get(Number(row.file_id)) || [];
        if (chain.length === 0) missingCurves++;
        const candidate = inputById.get(id) || {};
        curves.push(Object.freeze({
            id,
            chunkId: id,
            fileId: Number(row.file_id),
            text: String(candidate.text ?? row.content ?? ''),
            path: String(row.path || ''),
            diaryName: String(row.diary_name || ''),
            updatedAt: Number(row.updated_at) || 0,
            chunkVector: decodeVector(row.vector, dimension),
            tagCurve: Object.freeze(chain),
            candidateSources: Object.freeze(
                Array.isArray(candidate.candidateSources)
                    ? candidate.candidateSources.map(source => Object.freeze({ ...source }))
                    : []
            ),
            candidateUnionScore: Number(candidate.candidateUnionScore) || 0,
            candidateUnionRank: Number(candidate.candidateUnionRank) || 0,
            queryScore: Number(candidate.queryScore ?? candidate.score ?? candidate.vectorScore) || 0,
            localFieldScore: Number(candidate.localFieldScore) || 0,
            transferFieldScore: Number(candidate.transferFieldScore) || 0,
            bm25Score: Number(candidate.bm25Score) || 0,
            anchorScore: Number(candidate.anchorScore) || 0
        }));
    }

    return Object.freeze({
        schema: 'tagmemo-v10-alpha-curves-v1',
        curves: Object.freeze(curves),
        diagnostics: Object.freeze({
            requested: ids.length,
            projected: curves.length,
            missingChunks,
            missingCurves,
            files: fileIds.length,
            tags: fileTagRows.length
        })
    });
}

module.exports = {
    queryByChunks,
    decodeVector,
    projectCandidateCurves
};