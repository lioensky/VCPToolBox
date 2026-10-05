'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('G5 boundary is frozen around logical GC and recovery release only', () => {
    const contract = read('contracts/gen-usearch/g5/G5-GC-RECOVERY-R1.md');
    assert.match(
        contract,
        /Status: \*\*PASS\*\*/
    );
    for (const phrase of [
        'GC_ELIGIBLE',
        'RECOVERY_RECLAIMABLE',
        'RECOVERY_RELEASED',
        'Cancelled is not released',
        'current SERVING owner',
        'compaction',
        'MemTable reclamation',
        'FINAL_UPSTREAM_ACCEPTANCE = NOT AUTHORIZED'
    ]) {
        assert.ok(contract.includes(phrase), phrase);
    }
});

test('G5 GC coordinator does not mutate physical coverage, manifest topology, artifacts or runtime ownership', () => {
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

test('G5 remains unwired from existing ingestion, search and user-facing serving paths', () => {
    const forbidden = /GenUSearchGcCoordinator/;
    for (const rel of [
        'KnowledgeBaseManager.js',
        'modules/knowledgeBase/indexRepository.js',
        'modules/knowledgeBase/searchService.js',
        'modules/knowledgeBase/fileWatcher.js',
        'modules/knowledgeBase/genUSearchRetrievalService.js'
    ]) {
        assert.doesNotMatch(read(rel), forbidden, rel);
    }
});

test('G5 QueryReadView durable mutation is limited to cross-process reader leases', () => {
    const source = read('modules/knowledgeBase/genUSearchQueryReadView.js');
    const mutatedTables = [
        ...source.matchAll(
            /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(gen_usearch_[a-z0-9_]+)/ig
        )
    ].map(match => match[1]);
    assert.ok(mutatedTables.length >= 2);
    assert.deepEqual(
        [...new Set(mutatedTables)],
        ['gen_usearch_read_view_leases']
    );
    for (const required of [
        'LIVE_GC_VIEWS',
        'beginQuiescing',
        'snapshotGcSafety',
        'gen_usearch_read_view_leases',
        'worker_quiescent',
        'pins_released'
    ]) {
        assert.ok(source.includes(required), required);
    }
});

test('G5 workflow covers prior regressions, G5 contract, coordinator and tests', () => {
    const workflow = read('.github/workflows/gen-usearch-g5.yml');
    for (const required of [
        'contracts/gen-usearch/g5/**',
        'contracts/gen-usearch/g4/**',
        'modules/knowledgeBase/genUSearchGcCoordinator.js',
        'modules/knowledgeBase/genUSearchQueryReadView.js',
        'modules/knowledgeBase/genUSearchSegmentPublisher.js',
        'tests/gen-usearch/g1/**',
        'tests/gen-usearch/g2/**',
        'tests/gen-usearch/g3/**',
        'tests/gen-usearch/g4/**',
        'tests/gen-usearch/g5/**',
        'tests/tagIndexGenerationalBaseline.test.js'
    ]) {
        assert.ok(workflow.includes(required), required);
    }
    assert.ok(workflow.includes('workflow_dispatch:'));
});
