'use strict';

const { hashStable } = require('./immutable');

function edgeKey(sourceId, targetId) {
    return `${Number(sourceId)}:${Number(targetId)}`;
}

function createProvenanceViewFromSnapshot(snapshot = {}) {
    const rawEdges = Array.isArray(snapshot.edges) ? snapshot.edges : [];
    const compactEdges = new Map();
    const sourceIds = new Set();
    for (const entry of rawEdges) {
        const key = String(entry?.[0] || '');
        if (!/^-?\d+:-?\d+$/.test(key)) {
            throw new TypeError(`Invalid TagMemo provenance edge key: ${key}`);
        }
        const sourceId = Number(key.split(':')[0]);
        const contributions = Object.freeze(
            (Array.isArray(entry?.[1]) ? entry[1] : [])
                .map(item => Object.freeze({
                    fileId: Number(item?.[0]),
                    diaryName: String(item?.[1] || ''),
                    path: String(item?.[2] || ''),
                    mass: Number(item?.[3])
                }))
                .filter(item =>
                    Number.isFinite(item.fileId)
                    && Number.isFinite(item.mass)
                    && item.mass > 0
                )
        );
        compactEdges.set(key, contributions);
        sourceIds.add(sourceId);
    }

    const digestRows = [...compactEdges.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([key, contributions]) => [
            key,
            contributions.map(item => [
                item.fileId,
                item.diaryName,
                item.path,
                Number(item.mass.toFixed(12))
            ])
        ]);
    const generation = hashStable({
        schema: 'tagmemo-v10-alpha-provenance-v1',
        edges: digestRows
    }, 40);
    if (snapshot.generation && snapshot.generation !== generation) {
        throw new Error('TagMemo provenance snapshot checksum mismatch');
    }

    const createContextClassifier = (context = {}) => {
        const allowedFileIds = new Set(
            Array.isArray(context.allowedFileIds) ? context.allowedFileIds.map(Number) : []
        );
        const deniedFileIds = new Set(
            Array.isArray(context.deniedFileIds) ? context.deniedFileIds.map(Number) : []
        );
        const publicDiaryNames = new Set(
            Array.isArray(context.publicDiaryNames)
                ? context.publicDiaryNames.map(String)
                : []
        );
        const authorizedDiaryNames = new Set(
            Array.isArray(context.diaryNames) ? context.diaryNames.map(String) : []
        );
        const agentId = String(context.agentId || '').trim();

        return contributions => {
            const mass = {
                public: 0,
                agent_own: 0,
                authorized: 0,
                other_agent_public: 0,
                private_forbidden: 0,
                unknown: 0
            };
            for (const item of contributions) {
                if (deniedFileIds.has(item.fileId)) {
                    mass.private_forbidden += item.mass;
                } else if (allowedFileIds.has(item.fileId)) {
                    mass.authorized += item.mass;
                } else if (publicDiaryNames.has(item.diaryName)) {
                    mass.public += item.mass;
                } else if (agentId && item.diaryName.includes(agentId)) {
                    mass.agent_own += item.mass;
                } else if (authorizedDiaryNames.has(item.diaryName)) {
                    mass.authorized += item.mass;
                } else {
                    mass.unknown += item.mass;
                }
            }
            return mass;
        };
    };

    const classify = (contributions, context = {}) =>
        createContextClassifier(context)(contributions);

    return Object.freeze({
        schema: 'tagmemo-v10-alpha-provenance-v1',
        generation,
        edgeCount: compactEdges.size,
        sourceCount: sourceIds.size,
        getEdgeMass(sourceId, targetId, context = {}) {
            const contributions = compactEdges.get(edgeKey(sourceId, targetId));
            if (!contributions || contributions.length === 0) {
                return Object.freeze({ unknown: 1 });
            }
            return Object.freeze(classify(contributions, context));
        },
        createContextClassifier(context = {}) {
            const classifyForContext = createContextClassifier(context);
            return Object.freeze({
                getEdgeMass(sourceId, targetId) {
                    const contributions = compactEdges.get(edgeKey(sourceId, targetId));
                    if (!contributions || contributions.length === 0) {
                        return { unknown: 1 };
                    }
                    return classifyForContext(contributions);
                }
            });
        },
        inspectEdge(sourceId, targetId) {
            const contributions = compactEdges.get(edgeKey(sourceId, targetId))
                || Object.freeze([]);
            return Object.freeze({
                totalMass: contributions.reduce((sum, item) => sum + item.mass, 0),
                contributions,
                unknown: contributions.length === 0
            });
        },
        exportSnapshot() {
            return Object.freeze({
                schema: 'tagmemo-v10-alpha-provenance-snapshot-v1',
                generation,
                edges: Object.freeze(
                    digestRows.map(([key, contributions]) =>
                        Object.freeze([
                            key,
                            Object.freeze(
                                contributions.map(item =>
                                    Object.freeze(item.slice())
                                )
                            )
                        ])
                    )
                )
            });
        }
    });
}

function createEmptyProvenanceView(reason = null) {
    return Object.freeze({
        schema: 'tagmemo-v10-alpha-provenance-v1',
        generation: hashStable({ empty: true, reason }, 40),
        edgeCount: 0,
        sourceCount: 0,
        reason,
        getEdgeMass() {
            return Object.freeze({ unknown: 1 });
        },
        inspectEdge() {
            return Object.freeze({
                totalMass: 1,
                contributions: Object.freeze([]),
                unknown: true
            });
        }
    });
}

function buildProvenanceView(db, options = {}) {
    if (!db?.prepare) return createEmptyProvenanceView('database-unavailable');

    const maxTagsPerFile = Math.max(
        2,
        Math.floor(Number(options.maxTagsPerFile) || 100)
    );
    const direction = options.direction || {};
    const forwardGain = Math.max(0, Number(direction.forwardGain) || 1);
    const reverseGain = Math.max(0, Number(direction.reverseGain) || 0.35);
    const distanceDecay = Math.max(0, Number(direction.distanceDecay) || 0.08);
    const rows = db.prepare(`
        SELECT
            ft.file_id,
            ft.tag_id,
            ft.position,
            f.diary_name,
            f.path
        FROM file_tags ft
        JOIN files f ON f.id = ft.file_id
        ORDER BY ft.file_id, ft.position ASC, ft.tag_id ASC
    `).iterate();

    const edges = new Map();
    const sourceIds = new Set();
    let currentFileId = null;
    let currentMetadata = null;
    let tags = [];

    const addContribution = (sourceId, targetId, metadata, mass) => {
        if (!Number.isFinite(sourceId) || !Number.isFinite(targetId) || mass <= 0) return;
        const key = edgeKey(sourceId, targetId);
        if (!edges.has(key)) edges.set(key, []);
        edges.get(key).push(Object.freeze({
            fileId: metadata.fileId,
            diaryName: metadata.diaryName,
            path: metadata.path,
            mass
        }));
        sourceIds.add(sourceId);
    };

    const flush = () => {
        if (!currentMetadata || tags.length < 2 || tags.length > maxTagsPerFile) {
            tags = [];
            return;
        }

        const ordered = tags.slice().sort((left, right) =>
            (left.position - right.position) || (left.id - right.id)
        );
        for (let leftIndex = 0; leftIndex < ordered.length; leftIndex++) {
            for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex++) {
                const left = ordered[leftIndex];
                const right = ordered[rightIndex];
                if (left.id === right.id) continue;
                const delta = Math.max(1, right.position - left.position);
                const distanceFactor = Math.exp(-distanceDecay * Math.max(0, delta - 1));
                addContribution(
                    left.id,
                    right.id,
                    currentMetadata,
                    forwardGain * distanceFactor
                );
                addContribution(
                    right.id,
                    left.id,
                    currentMetadata,
                    reverseGain * distanceFactor
                );
            }
        }
        tags = [];
    };

    for (const row of rows) {
        const fileId = Number(row.file_id);
        if (currentFileId !== fileId) {
            flush();
            currentFileId = fileId;
            currentMetadata = Object.freeze({
                fileId,
                diaryName: String(row.diary_name || ''),
                path: String(row.path || '')
            });
        }
        const tagId = Number(row.tag_id);
        if (!Number.isFinite(tagId)) continue;
        tags.push({
            id: tagId,
            position: Math.max(0, Number(row.position) || 0)
        });
    }
    flush();

    const compactEdges = new Map();
    for (const [key, contributions] of edges.entries()) {
        const aggregated = new Map();
        for (const item of contributions) {
            const aggregateKey = `${item.fileId}\u0000${item.diaryName}\u0000${item.path}`;
            const previous = aggregated.get(aggregateKey);
            if (previous) {
                previous.mass += item.mass;
            } else {
                aggregated.set(aggregateKey, {
                    fileId: item.fileId,
                    diaryName: item.diaryName,
                    path: item.path,
                    mass: item.mass
                });
            }
        }
        compactEdges.set(
            key,
            Object.freeze(
                [...aggregated.values()]
                    .sort((left, right) =>
                        (left.fileId - right.fileId)
                        || left.diaryName.localeCompare(right.diaryName)
                    )
                    .map(item => Object.freeze({ ...item }))
            )
        );
    }

    return createProvenanceViewFromSnapshot({
        edges: [...compactEdges.entries()].map(([key, contributions]) => [
            key,
            contributions.map(item => [
                item.fileId,
                item.diaryName,
                item.path,
                Number(item.mass.toFixed(12))
            ])
        ])
    });
}

module.exports = {
    edgeKey,
    createEmptyProvenanceView,
    createProvenanceViewFromSnapshot,
    buildProvenanceView
};