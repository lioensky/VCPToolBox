'use strict';

const MEMTABLE_PINS = new WeakMap();
const SEGMENT_PINS = new Map();

function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function pinMemtable(memtable) {
    if (!memtable || (typeof memtable !== 'object' && typeof memtable !== 'function')) {
        throw new TypeError('reader pin requires a MemTable object');
    }
    MEMTABLE_PINS.set(memtable, (MEMTABLE_PINS.get(memtable) || 0) + 1);
}

function unpinMemtable(memtable) {
    const current = MEMTABLE_PINS.get(memtable) || 0;
    if (current <= 0) {
        throw codedError('READER_PIN_VIOLATION', 'MemTable reader pin underflow');
    }
    if (current === 1) MEMTABLE_PINS.delete(memtable);
    else MEMTABLE_PINS.set(memtable, current - 1);
}

function memtablePinCount(memtable) {
    return MEMTABLE_PINS.get(memtable) || 0;
}

function assertMemtableRemovalAllowed(memtable) {
    if (memtablePinCount(memtable) > 0) {
        throw codedError(
            'READER_PIN_VIOLATION',
            'physical MemTable removal is blocked while a QueryReadView pin is active'
        );
    }
    return true;
}

function pinSegment(segmentId) {
    const id = String(segmentId || '');
    if (!id) throw new TypeError('segment reader pin requires segmentId');
    SEGMENT_PINS.set(id, (SEGMENT_PINS.get(id) || 0) + 1);
}

function unpinSegment(segmentId) {
    const id = String(segmentId || '');
    const current = SEGMENT_PINS.get(id) || 0;
    if (current <= 0) {
        throw codedError('READER_PIN_VIOLATION', 'segment reader pin underflow: ' + id);
    }
    if (current === 1) SEGMENT_PINS.delete(id);
    else SEGMENT_PINS.set(id, current - 1);
}

function segmentPinCount(segmentId) {
    return SEGMENT_PINS.get(String(segmentId || '')) || 0;
}

module.exports = Object.freeze({
    pinMemtable,
    unpinMemtable,
    memtablePinCount,
    assertMemtableRemovalAllowed,
    pinSegment,
    unpinSegment,
    segmentPinCount
});
