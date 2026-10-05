'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const g4ProductionFiles = [
    'modules/knowledgeBase/genUSearchReadPins.js',
    'modules/knowledgeBase/genUSearchQueryReadView.js',
    'modules/knowledgeBase/genUSearchRetrievalService.js'
];

test('G4 boundary is frozen around QueryReadView and isolated retrieval', () => {
    const contract = read('contracts/gen-usearch/g4/G4-QUERY-READ-VIEW-R1.md');
    assert.match(
        contract,
        /Status: \*\*BOUNDARY_FROZEN \/ IMPLEMENTATION_ACTIVE\*\*/
    );
    for (const phrase of [
        'QueryReadView',
        'provisional pinning',
        'snapshot-current-head filtering',
        'runtime fence',
        'worker quiescence',
        'compaction',
        'GENERATIONAL_ACTIVE'
    ]) {
        assert.ok(contract.includes(phrase), phrase);
    }
});

test('G4 modules are read-only with respect to durable Gen-USearch authority', () => {
    const combined = g4ProductionFiles.map(read).join('\n');
    for (const forbidden of [
        /INSERT\s+INTO\s+gen_usearch_/i,
        /UPDATE\s+gen_usearch_/i,
        /DELETE\s+FROM\s+gen_usearch_/i
    ]) {
        assert.doesNotMatch(combined, forbidden);
    }
});

test('G4 remains unwired from existing ingestion, search and serving paths', () => {
    const forbidden = /GenUSearchQueryReadViewCoordinator|GenUSearchRetrievalService/;
    for (const rel of [
        'KnowledgeBaseManager.js',
        'modules/knowledgeBase/indexRepository.js',
        'modules/knowledgeBase/searchService.js',
        'modules/knowledgeBase/fileWatcher.js'
    ]) {
        assert.doesNotMatch(read(rel), forbidden, rel);
    }
});

test('G4 production modules do not implement GC, compaction, reclaim, ownership mutation or cutover', () => {
    const combined = g4ProductionFiles.map(read).join('\n');
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

test('G4 workflow covers prior regressions, G4 contract, query modules and tests', () => {
    const workflow = read('.github/workflows/gen-usearch-g4.yml');
    for (const required of [
        'contracts/gen-usearch/g4/**',
        'contracts/gen-usearch/g3/**',
        'modules/knowledgeBase/genUSearchQueryReadView.js',
        'modules/knowledgeBase/genUSearchRetrievalService.js',
        'modules/knowledgeBase/genUSearchSegmentPublisher.js',
        'modules/knowledgeBase/genUSearchReadPins.js',
        'modules/knowledgeBase/genUSearchMemTable.js',
        'tests/gen-usearch/g1/**',
        'tests/gen-usearch/g2/**',
        'tests/gen-usearch/g3/**',
        'tests/gen-usearch/g4/**',
        'tests/tagIndexGenerationalBaseline.test.js'
    ]) {
        assert.ok(workflow.includes(required), required);
    }
    assert.ok(workflow.includes('workflow_dispatch:'));
});
