'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const existingServingFiles = [
    'KnowledgeBaseManager.js',
    'modules/knowledgeBase/indexRepository.js',
    'modules/knowledgeBase/searchService.js',
    'modules/knowledgeBase/fileWatcher.js'
];

test('Gen-USearch remains isolated from the existing user-facing serving path', () => {
    const forbidden = /GenUSearch(?:MetadataStore|ReconciliationService|MemTable|PhysicalCoverageWriter|SegmentPublisher|QueryReadViewCoordinator|RetrievalService|GcCoordinator)/;
    for (const rel of existingServingFiles) {
        assert.doesNotMatch(read(rel), forbidden, rel);
    }
});

test('logical metadata code cannot manufacture physical coverage or activate cutover', () => {
    for (const rel of [
        'modules/knowledgeBase/genUSearchMetadataStore.js',
        'modules/knowledgeBase/genUSearchReconciler.js',
        'modules/knowledgeBase/genUSearchReconciliationService.js'
    ]) {
        const source = read(rel);
        assert.doesNotMatch(
            source,
            /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?gen_usearch_vector_coverage/i,
            rel
        );
        assert.doesNotMatch(source, /GENERATIONAL_ACTIVE/, rel);
    }
});

test('physical coverage mutation is partitioned between MemTable and segment authorities', () => {
    const modulesDir = path.join(root, 'modules/knowledgeBase');
    const mutation = /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?gen_usearch_vector_coverage/i;
    for (const name of fs.readdirSync(modulesDir).filter(name => name.endsWith('.js'))) {
        const rel = `modules/knowledgeBase/${name}`;
        const source = read(rel);
        if (name === 'genUSearchPhysicalCoverageWriter.js') {
            assert.match(source, mutation);
            assert.match(source, /'MEMTABLE'/);
            assert.doesNotMatch(source, /VALUES\s*\([^)]*'SEGMENT'/s);
        } else if (name === 'genUSearchSegmentPublisher.js') {
            assert.match(source, mutation);
            assert.match(source, /'SEGMENT'/);
            assert.doesNotMatch(source, /VALUES\s*\([^)]*'MEMTABLE'/s);
        } else {
            assert.doesNotMatch(source, mutation, rel);
        }
    }
});

test('Gen0 MemTable authority is bound to authentic native key64 membership', () => {
    const source = read('modules/knowledgeBase/genUSearchMemTable.js');
    assert.match(source, /require\('\.\.\/\.\.\/rust-vexus-lite'\)/);
    assert.match(source, /instanceof NativeVexusIndex/);
    assert.match(source, /containsKey64/);
    assert.match(source, /PHYSICAL_COVERAGE_MISSING/);
});

test('segment and manifest runtime mutation stays with the segment publisher', () => {
    const modulesDir = path.join(root, 'modules/knowledgeBase');
    const segmentMutation = /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?gen_usearch_segments/i;
    const manifestMutation = /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?gen_usearch_manifest_segments/i;
    for (const name of fs.readdirSync(modulesDir).filter(name => name.endsWith('.js'))) {
        const rel = `modules/knowledgeBase/${name}`;
        const source = read(rel);
        if (name === 'genUSearchSegmentPublisher.js') {
            assert.match(source, segmentMutation);
            assert.match(source, manifestMutation);
        } else if (name === 'schemaManager.js') {
            assert.match(source, /migrateLegacyGenUSearchSegments/);
            assert.match(source, segmentMutation);
            assert.doesNotMatch(source, manifestMutation, rel);
        } else {
            assert.doesNotMatch(source, segmentMutation, rel);
            assert.doesNotMatch(source, manifestMutation, rel);
        }
    }
});

test('legacy segment migration cannot rewind manifest authority', () => {
    const source = read('modules/knowledgeBase/schemaManager.js');
    const start = source.indexOf('function migrateLegacyGenUSearchSegments');
    const end = source.indexOf('function addColumnIfMissing', start);
    assert.ok(start >= 0 && end > start);
    const migration = source.slice(start, end);
    for (const required of [
        'manifestRefs === 0',
        'recoveryRefs === 0',
        "['BUILDING', 'FINALIZED_DURABLE'].includes(segment.state)",
        'backfilled',
        'manifest epochs preserved'
    ]) {
        assert.ok(migration.includes(required), required);
    }
    assert.doesNotMatch(migration, /UPDATE\s+gen_usearch_manifest_state/i);
    assert.doesNotMatch(migration, /UPDATE\s+gen_usearch_sequences/i);
    assert.doesNotMatch(migration, /DELETE\s+FROM\s+gen_usearch_manifest_segments/i);
});

test('segment publisher cannot acquire query, GC, compaction, or cutover authority', () => {
    const source = read('modules/knowledgeBase/genUSearchSegmentPublisher.js');
    for (const forbidden of [
        /QueryReadView/,
        /searchKey64\s*\(/,
        /UPDATE\s+gen_usearch_chunk_versions[\s\S]*GC_ELIGIBLE/i,
        /RECLAIMABLE.*DELETE/i,
        /gen_usearch_runtime_ownership/,
        /GENERATIONAL_SHADOW/,
        /GENERATIONAL_ACTIVE/,
        /publishCompaction\s*\(/,
        /compactSegments\s*\(/
    ]) {
        assert.doesNotMatch(source, forbidden);
    }
});

test('Windows segment publication is write-through before SQLite trusts it', () => {
    const cargo = read('rust-vexus-lite/Cargo.toml');
    const rust = read('rust-vexus-lite/src/lib.rs');
    assert.match(cargo, /\[target\.'cfg\(windows\)'\.dependencies\][\s\S]*windows-sys/);
    for (const required of [
        'MOVEFILE_REPLACE_EXISTING',
        'MOVEFILE_WRITE_THROUGH',
        'replace_windows_file_write_through',
        'sync_index_file(target)'
    ]) {
        assert.ok(rust.includes(required), required);
    }
});

test('QueryReadView durable mutation is limited to read-view lease lifecycle', () => {
    for (const rel of [
        'modules/knowledgeBase/genUSearchReadPins.js',
        'modules/knowledgeBase/genUSearchRetrievalService.js'
    ]) {
        assert.doesNotMatch(
            read(rel),
            /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+gen_usearch_/i,
            rel
        );
    }
    const source = read('modules/knowledgeBase/genUSearchQueryReadView.js');
    const tables = [...source.matchAll(
        /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(gen_usearch_[a-z0-9_]+)/ig
    )].map(match => match[1]);
    assert.ok(tables.length >= 2);
    assert.deepEqual([...new Set(tables)], ['gen_usearch_read_view_leases']);
});

test('query modules cannot perform GC, compaction, reclaim, ownership mutation, or cutover', () => {
    const combined = [
        'modules/knowledgeBase/genUSearchReadPins.js',
        'modules/knowledgeBase/genUSearchQueryReadView.js',
        'modules/knowledgeBase/genUSearchRetrievalService.js'
    ].map(read).join('\n');
    for (const forbidden of [
        /GC_ELIGIBLE/,
        /RECOVERY_RELEASED/,
        /RECLAIMABLE.*DELETE/i,
        /compactSegments\s*\(/,
        /publishCompaction\s*\(/,
        /GENERATIONAL_SHADOW/,
        /GENERATIONAL_ACTIVE/,
        /SET\s+owner_id/i,
        /serving_state\s*=\s*['"]DRAINING['"]/i
    ]) {
        assert.doesNotMatch(combined, forbidden);
    }
});

test('GC coordinator cannot mutate physical topology or runtime ownership', () => {
    const source = read('modules/knowledgeBase/genUSearchGcCoordinator.js');
    for (const forbidden of [
        /DELETE\s+FROM\s+gen_usearch_vector_coverage/i,
        /INSERT\s+INTO\s+gen_usearch_vector_coverage/i,
        /UPDATE\s+gen_usearch_segments/i,
        /INSERT\s+INTO\s+gen_usearch_manifest_segments/i,
        /DELETE\s+FROM\s+gen_usearch_manifest_segments/i,
        /removeKey64\s*\(/,
        /unlinkSync\s*\(/,
        /SET\s+owner_id/i,
        /GENERATIONAL_SHADOW/,
        /GENERATIONAL_ACTIVE/
    ]) {
        assert.doesNotMatch(source, forbidden);
    }
});
