'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const guard = require('../scripts/guard-server-stopped');

for (const name of [
    'repair_database.js',
    'rebuild_vector_indexes.js',
    'rebuild_tag_index_custom.js',
    'diary-semantic-classifier.js'
]) {
    test(`${name} rejects legacy writes before loading database dependencies`, () => {
        const source = fs.readFileSync(path.join(__dirname, '../scripts', name), 'utf8');
        new vm.Script(source, { filename: name });
        const required = [];
        assert.throws(() => vm.runInNewContext(source, {
            process: { argv: ['node', name] },
            require(id) {
                required.push(id);
                assert.equal(id, './guard-server-stopped');
                return guard;
            }
        }), /KBM_LEGACY_WRITE_DISABLED/);
        assert.deepEqual(required, ['./guard-server-stopped']);
    });
}

test('missing Tag synchronization opens its database read-only', () => {
    const source = fs.readFileSync(path.join(__dirname, '../scripts/sync_missing_tags.js'), 'utf8');
    assert.match(source, /new Database\(dbPath, \{ readonly: true, fileMustExist: true \}\)/);
});