'use strict';

const crypto = require('node:crypto');

const OP_KINDS = new Set([
    'SAME', 'MODIFY', 'MOVE', 'INSERT',
    'DELETE', 'SPLIT', 'MERGE', 'AMBIGUOUS'
]);

function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function requireString(value, label, options = {}) {
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string`);
    }
    const normalized = options.trim === false ? value : value.trim();
    if (!normalized) throw new TypeError(`${label} must not be empty`);
    return normalized;
}

function requireSlotIndex(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${label} must be a non-negative safe integer`);
    }
    return value;
}

function requireSha256(value, label) {
    const normalized = requireString(value, label).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalized)) {
        throw new TypeError(`${label} must be a 64-character SHA-256 hex digest`);
    }
    return normalized;
}

function serializeChunkContent(content) {
    if (typeof content !== 'string') {
        throw new TypeError('chunk content must be a string');
    }
    return Buffer.from(content, 'utf8');
}

function hashExactChunkContent(content) {
    return crypto.createHash('sha256')
        .update(serializeChunkContent(content))
        .digest('hex');
}

function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashCanonical(value) {
    return crypto.createHash('sha256')
        .update(Buffer.from(stableStringify(value), 'utf8'))
        .digest('hex');
}

function normalizeContentHash(chunk, label) {
    const hasContent = Object.prototype.hasOwnProperty.call(chunk, 'content');
    const hasHash = Object.prototype.hasOwnProperty.call(chunk, 'contentHash');
    if (!hasContent && !hasHash) {
        throw new TypeError(`${label} requires content or contentHash`);
    }
    const computed = hasContent ? hashExactChunkContent(chunk.content) : null;
    if (!hasHash) return computed;
    const provided = requireSha256(chunk.contentHash, `${label}.contentHash`);
    if (computed !== null && computed !== provided) {
        throw codedError(
            'CHUNK_HASH_CONTRACT_MISMATCH',
            `${label} contentHash does not match exact UTF-8 content bytes`
        );
    }
    return provided;
}

function normalizePreviousChunks(chunks) {
    if (!Array.isArray(chunks)) throw new TypeError('previousChunks must be an array');
    const seenIds = new Set();
    const seenSlots = new Set();
    const rows = chunks.map((chunk, index) => {
        if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
            throw new TypeError(`previousChunks[${index}] must be an object`);
        }
        const chunkId = requireString(chunk.chunkId, `previousChunks[${index}].chunkId`);
        if (seenIds.has(chunkId)) {
            throw codedError('CHUNK_IDENTITY_AMBIGUOUS', `Duplicate previous chunkId: ${chunkId}`);
        }
        seenIds.add(chunkId);
        const slotIndex = requireSlotIndex(
            chunk.slotIndex,
            `previousChunks[${index}].slotIndex`
        );
        if (seenSlots.has(slotIndex)) {
            throw codedError('CHUNK_IDENTITY_AMBIGUOUS', `Duplicate previous slotIndex: ${slotIndex}`);
        }
        seenSlots.add(slotIndex);
        return {
            chunkId,
            slotIndex,
            contentHash: normalizeContentHash(chunk, `previousChunks[${index}]`)
        };
    }).sort((left, right) => left.slotIndex - right.slotIndex);
    rows.forEach((row, position) => { row.position = position; });
    return rows;
}

function normalizeNextChunks(chunks) {
    if (!Array.isArray(chunks)) throw new TypeError('nextChunks must be an array');
    const seenSlots = new Set();
    const rows = chunks.map((chunk, index) => {
        if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
            throw new TypeError(`nextChunks[${index}] must be an object`);
        }
        if (!Object.prototype.hasOwnProperty.call(chunk, 'content')) {
            throw codedError(
                'CHUNK_HASH_CONTRACT_MISMATCH',
                `nextChunks[${index}] must include exact source content`
            );
        }
        const slotIndex = chunk.slotIndex == null
            ? index
            : requireSlotIndex(chunk.slotIndex, `nextChunks[${index}].slotIndex`);
        if (seenSlots.has(slotIndex)) {
            throw codedError('CHUNK_IDENTITY_AMBIGUOUS', `Duplicate next slotIndex: ${slotIndex}`);
        }
        seenSlots.add(slotIndex);
        return {
            slotIndex,
            contentHash: normalizeContentHash(chunk, `nextChunks[${index}]`)
        };
    }).sort((left, right) => left.slotIndex - right.slotIndex);
    rows.forEach((row, position) => { row.position = position; });
    return rows;
}

function deriveInsertedChunkId(docId, targetRevision, slotIndex, contentHash) {
    const digest = hashCanonical({
        namespace: 'gen-usearch-chunk-v1',
        docId: requireString(docId, 'docId'),
        targetRevision: requireString(targetRevision, 'targetRevision', { trim: false }),
        slotIndex: requireSlotIndex(slotIndex, 'slotIndex'),
        contentHash: requireSha256(contentHash, 'contentHash')
    });
    return `guc_${digest.slice(0, 40)}`;
}

function groupByHash(rows) {
    const map = new Map();
    for (const row of rows) {
        if (!map.has(row.contentHash)) map.set(row.contentHash, []);
        map.get(row.contentHash).push(row);
    }
    return map;
}

function makeNewChunk(docId, targetRevision, row) {
    return {
        chunkId: deriveInsertedChunkId(
            docId,
            targetRevision,
            row.slotIndex,
            row.contentHash
        ),
        toSlot: row.slotIndex,
        contentHash: row.contentHash
    };
}

function operationOrderKey(operation) {
    if (Number.isSafeInteger(operation.toSlot)) return [operation.toSlot, 0, operation.kind];
    if (Array.isArray(operation.newChunks) && operation.newChunks.length > 0) {
        return [operation.newChunks[0].toSlot, 1, operation.kind];
    }
    if (Array.isArray(operation.nextSlots) && operation.nextSlots.length > 0) {
        return [operation.nextSlots[0], 2, operation.kind];
    }
    if (Number.isSafeInteger(operation.fromSlot)) return [operation.fromSlot, 3, operation.kind];
    if (Array.isArray(operation.fromSlots) && operation.fromSlots.length > 0) {
        return [operation.fromSlots[0], 4, operation.kind];
    }
    return [Number.MAX_SAFE_INTEGER, 9, operation.kind];
}

function compareOperations(left, right) {
    const a = operationOrderKey(left);
    const b = operationOrderKey(right);
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] < b[index]) return -1;
        if (a[index] > b[index]) return 1;
    }
    const aText = stableStringify(left);
    const bText = stableStringify(right);
    return aText < bText ? -1 : (aText > bText ? 1 : 0);
}

function assertExactKeys(value, expectedKeys, label) {
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw codedError(
            'RECONCILER_AUTHORITY_VIOLATION',
            `${label} fields must be exactly: ${expected.join(', ')}`
        );
    }
}

function validateNewChunk(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    assertExactKeys(value, ['chunkId', 'toSlot', 'contentHash'], label);
    requireString(value.chunkId, `${label}.chunkId`);
    requireSlotIndex(value.toSlot, `${label}.toSlot`);
    requireSha256(value.contentHash, `${label}.contentHash`);
}

function validateStringArray(value, label) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new TypeError(`${label} must be a non-empty array`);
    }
    const normalized = value.map((item, index) => requireString(item, `${label}[${index}]`));
    if (new Set(normalized).size !== normalized.length) {
        throw codedError('CHUNK_IDENTITY_AMBIGUOUS', `${label} contains duplicates`);
    }
    return normalized;
}

function validateSlotArray(value, label) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new TypeError(`${label} must be a non-empty array`);
    }
    const normalized = value.map((item, index) => requireSlotIndex(item, `${label}[${index}]`));
    if (new Set(normalized).size !== normalized.length) {
        throw codedError('CHUNK_IDENTITY_AMBIGUOUS', `${label} contains duplicates`);
    }
    return normalized;
}

function validateOperationShape(operation, index) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
        throw new TypeError(`operations[${index}] must be an object`);
    }
    if (!OP_KINDS.has(operation.kind)) {
        throw codedError('RECONCILER_AUTHORITY_VIOLATION', `Unknown reconciliation kind: ${operation.kind}`);
    }
    const label = `operations[${index}]`;

    if (operation.kind === 'SAME' || operation.kind === 'MOVE') {
        assertExactKeys(operation, ['kind', 'chunkId', 'fromSlot', 'toSlot', 'contentHash'], label);
        requireString(operation.chunkId, `${label}.chunkId`);
        requireSlotIndex(operation.fromSlot, `${label}.fromSlot`);
        requireSlotIndex(operation.toSlot, `${label}.toSlot`);
        requireSha256(operation.contentHash, `${label}.contentHash`);
        if (operation.kind === 'SAME' && operation.fromSlot !== operation.toSlot) {
            throw codedError('RECONCILER_AUTHORITY_VIOLATION', `${label} SAME must not move slots`);
        }
        if (operation.kind === 'MOVE' && operation.fromSlot === operation.toSlot) {
            throw codedError('RECONCILER_AUTHORITY_VIOLATION', `${label} MOVE must change slots`);
        }
        return;
    }
    if (operation.kind === 'MODIFY') {
        assertExactKeys(operation, ['kind', 'chunkId', 'fromSlot', 'toSlot', 'fromContentHash', 'toContentHash'], label);
        requireString(operation.chunkId, `${label}.chunkId`);
        requireSlotIndex(operation.fromSlot, `${label}.fromSlot`);
        requireSlotIndex(operation.toSlot, `${label}.toSlot`);
        requireSha256(operation.fromContentHash, `${label}.fromContentHash`);
        requireSha256(operation.toContentHash, `${label}.toContentHash`);
        if (operation.fromContentHash === operation.toContentHash) {
            throw codedError('RECONCILER_AUTHORITY_VIOLATION', `${label} MODIFY must change exact content`);
        }
        return;
    }
    if (operation.kind === 'INSERT') {
        assertExactKeys(operation, ['kind', 'chunkId', 'toSlot', 'contentHash'], label);
        requireString(operation.chunkId, `${label}.chunkId`);
        requireSlotIndex(operation.toSlot, `${label}.toSlot`);
        requireSha256(operation.contentHash, `${label}.contentHash`);
        return;
    }
    if (operation.kind === 'DELETE') {
        assertExactKeys(operation, ['kind', 'chunkId', 'fromSlot', 'contentHash'], label);
        requireString(operation.chunkId, `${label}.chunkId`);
        requireSlotIndex(operation.fromSlot, `${label}.fromSlot`);
        requireSha256(operation.contentHash, `${label}.contentHash`);
        return;
    }
    if (operation.kind === 'SPLIT' || operation.kind === 'MERGE') {
        assertExactKeys(operation, ['kind', 'oldChunkIds', 'fromSlots', 'newChunks'], label);
        const oldChunkIds = validateStringArray(operation.oldChunkIds, `${label}.oldChunkIds`);
        const fromSlots = validateSlotArray(operation.fromSlots, `${label}.fromSlots`);
        if (oldChunkIds.length !== fromSlots.length) {
            throw codedError('RECONCILER_AUTHORITY_VIOLATION', `${label} old identity and slot arity diverged`);
        }
        if (!Array.isArray(operation.newChunks) || operation.newChunks.length === 0) {
            throw new TypeError(`${label}.newChunks must be a non-empty array`);
        }
        operation.newChunks.forEach((row, childIndex) => validateNewChunk(row, `${label}.newChunks[${childIndex}]`));
        if (operation.kind === 'SPLIT' && !(oldChunkIds.length === 1 && operation.newChunks.length > 1)) {
            throw codedError('RECONCILER_AUTHORITY_VIOLATION', `${label} has invalid SPLIT arity`);
        }
        if (operation.kind === 'MERGE' && !(oldChunkIds.length > 1 && operation.newChunks.length === 1)) {
            throw codedError('RECONCILER_AUTHORITY_VIOLATION', `${label} has invalid MERGE arity`);
        }
        return;
    }

    const allowed = new Set(['kind', 'reason', 'oldChunkIds', 'nextSlots', 'contentHash']);
    for (const key of Object.keys(operation)) {
        if (!allowed.has(key)) {
            throw codedError('RECONCILER_AUTHORITY_VIOLATION', `${label} contains non-identity field: ${key}`);
        }
    }
    for (const required of ['kind', 'reason', 'oldChunkIds', 'nextSlots']) {
        if (!Object.prototype.hasOwnProperty.call(operation, required)) {
            throw codedError('RECONCILER_AUTHORITY_VIOLATION', `${label} is missing ${required}`);
        }
    }
    requireString(operation.reason, `${label}.reason`);
    if (!Array.isArray(operation.oldChunkIds) || !Array.isArray(operation.nextSlots)) {
        throw new TypeError(`${label} ambiguous identity sets must be arrays`);
    }
    operation.oldChunkIds.forEach((item, itemIndex) => requireString(item, `${label}.oldChunkIds[${itemIndex}]`));
    operation.nextSlots.forEach((item, itemIndex) => requireSlotIndex(item, `${label}.nextSlots[${itemIndex}]`));
    if (operation.oldChunkIds.length + operation.nextSlots.length === 0) {
        throw codedError('RECONCILER_AUTHORITY_VIOLATION', `${label} ambiguity set must not be empty`);
    }
    if (operation.contentHash !== undefined) requireSha256(operation.contentHash, `${label}.contentHash`);
}
function validatePlanIdentitySets(operations) {
    const seenOld = new Set();
    const seenTargetSlots = new Set();
    const seenResultIds = new Set();

    const claim = (set, value, label) => {
        if (set.has(value)) {
            throw codedError('CHUNK_IDENTITY_AMBIGUOUS', `Reconciliation plan repeats ${label}: ${value}`);
        }
        set.add(value);
    };

    for (const operation of operations) {
        if (['SAME', 'MOVE', 'MODIFY', 'DELETE'].includes(operation.kind)) {
            claim(seenOld, operation.chunkId, 'old chunk identity');
        }
        if (operation.kind === 'SPLIT' || operation.kind === 'MERGE') {
            operation.oldChunkIds.forEach(id => claim(seenOld, id, 'old chunk identity'));
        }
        if (operation.kind === 'AMBIGUOUS') {
            operation.oldChunkIds.forEach(id => claim(seenOld, id, 'old chunk identity'));
        }

        if (['SAME', 'MOVE', 'MODIFY', 'INSERT'].includes(operation.kind)) {
            claim(seenTargetSlots, operation.toSlot, 'target slot');
        }
        if (operation.kind === 'SPLIT' || operation.kind === 'MERGE') {
            operation.newChunks.forEach(row => claim(seenTargetSlots, row.toSlot, 'target slot'));
        }
        if (operation.kind === 'AMBIGUOUS') {
            operation.nextSlots.forEach(slot => claim(seenTargetSlots, slot, 'target slot'));
        }

        if (['SAME', 'MOVE', 'MODIFY', 'INSERT'].includes(operation.kind)) {
            claim(seenResultIds, operation.chunkId, 'result chunk identity');
        }
        if (operation.kind === 'SPLIT' || operation.kind === 'MERGE') {
            operation.newChunks.forEach(row => claim(seenResultIds, row.chunkId, 'result chunk identity'));
        }
    }
}

function assertIdentityOnlyPlan(plan) {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
        throw new TypeError('plan must be an object');
    }
    assertExactKeys(plan, [
        'planVersion', 'identityOnly', 'docId', 'observedSourceDigest',
        'observedSourceRevision', 'targetRevision', 'operations', 'summary',
        'planDigest', 'planId'
    ], 'plan');
    if (plan.planVersion !== 1 || plan.identityOnly !== true) {
        throw codedError(
            'RECONCILER_AUTHORITY_VIOLATION',
            'Reconciliation plan must be identity-only version 1'
        );
    }
    requireString(plan.docId, 'plan.docId');
    requireString(plan.observedSourceDigest, 'plan.observedSourceDigest');
    requireString(plan.observedSourceRevision, 'plan.observedSourceRevision', { trim: false });
    requireString(plan.targetRevision, 'plan.targetRevision', { trim: false });
    if (plan.observedSourceRevision !== plan.targetRevision) {
        throw codedError(
            'SOURCE_OBSERVATION_INVALID',
            'Observed source revision and reconciliation target revision must be identical'
        );
    }
    requireSha256(plan.planDigest, 'plan.planDigest');
    requireString(plan.planId, 'plan.planId');
    if (!Array.isArray(plan.operations)) throw new TypeError('plan.operations must be an array');
    plan.operations.forEach(validateOperationShape);
    validatePlanIdentitySets(plan.operations);

    if (!plan.summary || typeof plan.summary !== 'object' || Array.isArray(plan.summary)) {
        throw new TypeError('plan.summary must be an object');
    }
    assertExactKeys(plan.summary, [...OP_KINDS], 'plan.summary');
    const expectedSummary = Object.fromEntries([...OP_KINDS].map(kind => [kind, 0]));
    for (const operation of plan.operations) expectedSummary[operation.kind] += 1;
    for (const kind of OP_KINDS) {
        if (!Number.isSafeInteger(plan.summary[kind]) || plan.summary[kind] < 0 || plan.summary[kind] !== expectedSummary[kind]) {
            throw codedError('SOURCE_OBSERVATION_INVALID', `plan.summary.${kind} does not match operations`);
        }
    }

    const body = {
        planVersion: plan.planVersion,
        identityOnly: plan.identityOnly,
        docId: plan.docId,
        observedSourceDigest: plan.observedSourceDigest,
        observedSourceRevision: plan.observedSourceRevision,
        targetRevision: plan.targetRevision,
        operations: plan.operations,
        summary: plan.summary
    };
    const expectedDigest = hashCanonical(body);
    if (expectedDigest !== plan.planDigest || plan.planId !== `g1r_${expectedDigest.slice(0, 40)}`) {
        throw codedError(
            'SOURCE_OBSERVATION_INVALID',
            'Reconciliation plan digest or planId does not match canonical plan bytes'
        );
    }
    return plan;
}
function reconcileDocumentChunks(options = {}) {
    const docId = requireString(options.docId, 'docId');
    const observedSourceDigest = requireString(
        options.observedSourceDigest,
        'observedSourceDigest'
    );
    const observedSourceRevision = requireString(
        options.observedSourceRevision,
        'observedSourceRevision',
        { trim: false }
    );
    const targetRevision = requireString(
        options.targetRevision,
        'targetRevision',
        { trim: false }
    );
    const previous = normalizePreviousChunks(options.previousChunks || []);
    const next = normalizeNextChunks(options.nextChunks || []);

    const previousByHash = groupByHash(previous);
    const nextByHash = groupByHash(next);
    const matchedPrevious = new Set();
    const matchedNext = new Set();
    const ambiguousPrevious = new Set();
    const ambiguousNext = new Set();
    const exactPairs = [];
    const operations = [];

    const hashes = [...new Set([
        ...previousByHash.keys(),
        ...nextByHash.keys()
    ])].sort();

    for (const hash of hashes) {
        const oldRows = previousByHash.get(hash) || [];
        const newRows = nextByHash.get(hash) || [];
        if (oldRows.length === 1 && newRows.length === 1) {
            const oldRow = oldRows[0];
            const newRow = newRows[0];
            matchedPrevious.add(oldRow.position);
            matchedNext.add(newRow.position);
            exactPairs.push({ oldRow, newRow });
            operations.push({
                kind: oldRow.slotIndex === newRow.slotIndex ? 'SAME' : 'MOVE',
                chunkId: oldRow.chunkId,
                fromSlot: oldRow.slotIndex,
                toSlot: newRow.slotIndex,
                contentHash: hash
            });
            continue;
        }
        if (oldRows.length > 0 && newRows.length > 0 && (oldRows.length > 1 || newRows.length > 1)) {
            oldRows.forEach(row => ambiguousPrevious.add(row.position));
            newRows.forEach(row => ambiguousNext.add(row.position));
            operations.push({
                kind: 'AMBIGUOUS',
                reason: 'DUPLICATE_EXACT_CONTENT',
                oldChunkIds: oldRows.map(row => row.chunkId),
                nextSlots: newRows.map(row => row.slotIndex),
                contentHash: hash
            });
        }
    }

    const monotonicPairs = [...exactPairs].sort(
        (left, right) => left.newRow.position - right.newRow.position
    );
    let monotonic = true;
    for (let index = 1; index < monotonicPairs.length; index += 1) {
        if (monotonicPairs[index - 1].oldRow.position >= monotonicPairs[index].oldRow.position) {
            monotonic = false;
            break;
        }
    }

    const consumedPrevious = new Set([...matchedPrevious, ...ambiguousPrevious]);
    const consumedNext = new Set([...matchedNext, ...ambiguousNext]);

    const emitInterval = (oldRows, newRows) => {
        if (oldRows.length === 0 && newRows.length === 0) return;
        oldRows.forEach(row => consumedPrevious.add(row.position));
        newRows.forEach(row => consumedNext.add(row.position));

        if (oldRows.length === 1 && newRows.length === 1) {
            operations.push({
                kind: 'MODIFY',
                chunkId: oldRows[0].chunkId,
                fromSlot: oldRows[0].slotIndex,
                toSlot: newRows[0].slotIndex,
                fromContentHash: oldRows[0].contentHash,
                toContentHash: newRows[0].contentHash
            });
            return;
        }
        if (oldRows.length === 0) {
            for (const row of newRows) {
                operations.push({
                    kind: 'INSERT',
                    ...makeNewChunk(docId, targetRevision, row)
                });
            }
            return;
        }
        if (newRows.length === 0) {
            for (const row of oldRows) {
                operations.push({
                    kind: 'DELETE',
                    chunkId: row.chunkId,
                    fromSlot: row.slotIndex,
                    contentHash: row.contentHash
                });
            }
            return;
        }
        if (oldRows.length === 1 && newRows.length > 1) {
            operations.push({
                kind: 'SPLIT',
                oldChunkIds: [oldRows[0].chunkId],
                fromSlots: [oldRows[0].slotIndex],
                newChunks: newRows.map(row => makeNewChunk(docId, targetRevision, row))
            });
            return;
        }
        if (oldRows.length > 1 && newRows.length === 1) {
            operations.push({
                kind: 'MERGE',
                oldChunkIds: oldRows.map(row => row.chunkId),
                fromSlots: oldRows.map(row => row.slotIndex),
                newChunks: [makeNewChunk(docId, targetRevision, newRows[0])]
            });
            return;
        }
        operations.push({
            kind: 'AMBIGUOUS',
            reason: 'MANY_TO_MANY_UNMATCHED_INTERVAL',
            oldChunkIds: oldRows.map(row => row.chunkId),
            nextSlots: newRows.map(row => row.slotIndex)
        });
    };

    if (monotonic) {
        const anchors = [
            { oldPosition: -1, newPosition: -1 },
            ...monotonicPairs.map(pair => ({
                oldPosition: pair.oldRow.position,
                newPosition: pair.newRow.position
            })),
            { oldPosition: previous.length, newPosition: next.length }
        ];
        for (let index = 1; index < anchors.length; index += 1) {
            const left = anchors[index - 1];
            const right = anchors[index];
            const oldRows = previous.filter(row =>
                row.position > left.oldPosition &&
                row.position < right.oldPosition &&
                !consumedPrevious.has(row.position)
            );
            const newRows = next.filter(row =>
                row.position > left.newPosition &&
                row.position < right.newPosition &&
                !consumedNext.has(row.position)
            );
            emitInterval(oldRows, newRows);
        }
    } else {
        const oldRows = previous.filter(row => !consumedPrevious.has(row.position));
        const newRows = next.filter(row => !consumedNext.has(row.position));
        if (oldRows.length > 0 || newRows.length > 0) {
            oldRows.forEach(row => consumedPrevious.add(row.position));
            newRows.forEach(row => consumedNext.add(row.position));
            operations.push({
                kind: 'AMBIGUOUS',
                reason: 'NON_MONOTONIC_EXACT_ANCHORS',
                oldChunkIds: oldRows.map(row => row.chunkId),
                nextSlots: newRows.map(row => row.slotIndex)
            });
        }
    }

    const leftoverOld = previous.filter(row => !consumedPrevious.has(row.position));
    const leftoverNew = next.filter(row => !consumedNext.has(row.position));
    if (leftoverOld.length > 0 || leftoverNew.length > 0) {
        operations.push({
            kind: 'AMBIGUOUS',
            reason: 'UNRESOLVED_RECONCILIATION_REMAINDER',
            oldChunkIds: leftoverOld.map(row => row.chunkId),
            nextSlots: leftoverNew.map(row => row.slotIndex)
        });
    }

    operations.sort(compareOperations);
    const summary = Object.fromEntries([...OP_KINDS].map(kind => [kind, 0]));
    for (const operation of operations) summary[operation.kind] += 1;

    const body = {
        planVersion: 1,
        identityOnly: true,
        docId,
        observedSourceDigest,
        observedSourceRevision,
        targetRevision,
        operations,
        summary
    };
    const planDigest = hashCanonical(body);
    const plan = {
        ...body,
        planDigest,
        planId: `g1r_${planDigest.slice(0, 40)}`
    };
    return assertIdentityOnlyPlan(plan);
}

module.exports = {
    OP_KINDS,
    serializeChunkContent,
    hashExactChunkContent,
    stableStringify,
    hashCanonical,
    deriveInsertedChunkId,
    assertIdentityOnlyPlan,
    reconcileDocumentChunks
};
