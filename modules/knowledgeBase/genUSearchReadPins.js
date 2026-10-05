'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MEMTABLE_PINS = new WeakMap();
const MEMTABLE_DATABASE_AUTHORITY = new WeakMap();
const MEMORY_DATABASE_AUTHORITY = new WeakMap();
const SEGMENT_PINS = new Map();
let nextMemoryDatabaseIdentity = 1;

function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function databaseAuthority(db) {
    if (!db || typeof db !== 'object') {
        throw new TypeError('database authority requires a database connection');
    }
    const name = String(db.name || '').trim();
    if (!name || name === ':memory:' || name.startsWith('file::memory:')) {
        let identity = MEMORY_DATABASE_AUTHORITY.get(db);
        if (!identity) {
            identity = 'memory-connection:' + nextMemoryDatabaseIdentity++;
            MEMORY_DATABASE_AUTHORITY.set(db, identity);
        }
        return identity;
    }

    const absolute = path.resolve(name);
    try {
        const stat = fs.statSync(absolute, { bigint: true });
        if (stat.isFile() && stat.ino !== 0n) {
            return 'inode:' + stat.dev.toString() + ':' + stat.ino.toString();
        }
    } catch (_) {
        // Canonical-path fallback below.
    }
    try {
        const real = fs.realpathSync.native
            ? fs.realpathSync.native(absolute)
            : fs.realpathSync(absolute);
        return 'path:' + real;
    } catch (_) {
        return 'path:' + absolute;
    }
}

function bindMemtableDatabase(memtable, db) {
    if (!memtable || (typeof memtable !== 'object' && typeof memtable !== 'function')) {
        throw new TypeError('MemTable database authority requires a MemTable object');
    }
    const identity = databaseAuthority(db);
    const existing = MEMTABLE_DATABASE_AUTHORITY.get(memtable);
    if (existing && existing !== identity) {
        throw codedError(
            'MEMTABLE_DATABASE_AUTHORITY_CONFLICT',
            'MemTable is already bound to a different SQLite authority'
        );
    }
    MEMTABLE_DATABASE_AUTHORITY.set(memtable, identity);
    return identity;
}

function assertMemtableDatabase(memtable, db) {
    const expected = databaseAuthority(db);
    const actual = MEMTABLE_DATABASE_AUTHORITY.get(memtable);
    if (!actual || actual !== expected) {
        throw codedError(
            'QUERY_READ_VIEW_INVALID',
            'MemTable does not belong to the QueryReadView SQLite authority'
        );
    }
    return true;
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
    bindMemtableDatabase,
    assertMemtableDatabase,
    pinMemtable,
    unpinMemtable,
    memtablePinCount,
    assertMemtableRemovalAllowed,
    pinSegment,
    unpinSegment,
    segmentPinCount
});
