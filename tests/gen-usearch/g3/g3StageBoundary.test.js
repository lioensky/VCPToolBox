'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('G3 boundary is frozen around immutable segment + manifest authority', () => {
    const contract = read('contracts/gen-usearch/g3/G3-IMMUTABLE-SEGMENT-MANIFEST-R1.md');
    assert.match(
        contract,
        /Status: \*\*PASS\*\*/
    );
    for (const phrase of [
        'immutable native Vexus segment',
        'manifest publication by compare-and-swap',
        'SEGMENT `QUERY_VISIBLE` coverage',
        'MEMTABLE coverage remains',
        'QueryReadView',
        'compaction',
        'GENERATIONAL_ACTIVE',
        'Segment dimension is native artifact authority',
        'G4 = NOT AUTHORIZED'
    ]) {
        assert.ok(contract.includes(phrase), phrase);
    }
});

test('runtime segment/manifest mutation stays with G3 publisher; schema migration is bounded to legacy segment repair', () => {
    const modulesDir = path.join(root, 'modules/knowledgeBase');
    const candidates = fs.readdirSync(modulesDir)
        .filter(name => name.endsWith('.js'))
        .map(name => `modules/knowledgeBase/${name}`);

    const segmentMutation = /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?gen_usearch_segments/i;
    const manifestMemberMutation = /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?gen_usearch_manifest_segments/i;

    for (const rel of candidates) {
        const source = read(rel);
        if (rel === 'modules/knowledgeBase/genUSearchSegmentPublisher.js') {
            assert.match(source, segmentMutation);
            assert.match(source, manifestMemberMutation);
        } else if (rel === 'modules/knowledgeBase/schemaManager.js') {
            assert.match(source, /migrateLegacyGenUSearchSegments/);
            assert.match(source, segmentMutation);
            assert.doesNotMatch(source, manifestMemberMutation, rel);
        } else {
            assert.doesNotMatch(source, segmentMutation, rel);
            assert.doesNotMatch(source, manifestMemberMutation, rel);
        }
    }
});


test('legacy segment schema migration cannot rewind manifest authority or reclaim published topology', () => {
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

test('G3 remains unwired from existing ingestion, search and serving paths', () => {
    const forbidden = /GenUSearchSegmentPublisher/;
    for (const rel of [
        'KnowledgeBaseManager.js',
        'modules/knowledgeBase/indexRepository.js',
        'modules/knowledgeBase/searchService.js',
        'modules/knowledgeBase/fileWatcher.js'
    ]) {
        assert.doesNotMatch(read(rel), forbidden, rel);
    }
});

test('G3 publisher does not implement query, GC, compaction or cutover authority', () => {
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

test('G3 workflow covers G1/G2 regressions, G3 contract, publisher and tests', () => {
    const workflow = read('.github/workflows/gen-usearch-g3.yml');
    for (const required of [
        'contracts/gen-usearch/g3/**',
        'contracts/gen-usearch/g2/**',
        'modules/knowledgeBase/genUSearchSegmentPublisher.js',
        'modules/knowledgeBase/genUSearchMemTable.js',
        'modules/knowledgeBase/genUSearchReadPins.js',
        'modules/knowledgeBase/genUSearchPhysicalCoverageWriter.js',
        'modules/knowledgeBase/genUSearchMetadataStore.js',
        'rust-vexus-lite/src/lib.rs',
        'tests/gen-usearch/g1/**',
        'tests/gen-usearch/g2/**',
        'tests/gen-usearch/g3/**',
        'tests/tagIndexGenerationalBaseline.test.js'
    ]) {
        assert.ok(workflow.includes(required), required);
    }
    assert.ok(workflow.includes('workflow_dispatch:'));
    assert.ok(workflow.includes('g3-windows-durability:'));
    assert.ok(workflow.includes('runs-on: windows-latest'));
    assert.ok(
        workflow.includes(
            'cargo check --locked --manifest-path rust-vexus-lite/Cargo.toml'
        )
    );
});

test('Windows native segment publication is write-through before SQLite can trust it', () => {
    const cargo = read('rust-vexus-lite/Cargo.toml');
    const rust = read('rust-vexus-lite/src/lib.rs');

    assert.match(
        cargo,
        /\[target\.'cfg\(windows\)'\.dependencies\][\s\S]*windows-sys/
    );
    for (const required of [
        'MOVEFILE_REPLACE_EXISTING',
        'MOVEFILE_WRITE_THROUGH',
        'replace_windows_file_write_through',
        'sync_index_file(target)'
    ]) {
        assert.ok(rust.includes(required), required);
    }
});
