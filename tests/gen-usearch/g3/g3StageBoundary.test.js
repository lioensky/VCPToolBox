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

test('only the G3 segment publisher mutates segment and manifest membership in production code', () => {
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
        } else {
            assert.doesNotMatch(source, segmentMutation, rel);
            assert.doesNotMatch(source, manifestMemberMutation, rel);
        }
    }
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
});
