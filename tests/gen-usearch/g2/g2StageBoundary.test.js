'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const g2ProductionFiles = [
    'modules/knowledgeBase/genUSearchMemTable.js',
    'modules/knowledgeBase/genUSearchPhysicalCoverageWriter.js'
];

test('G2 boundary is frozen and limits authority to Gen0 MEMTABLE coverage', () => {
    const contract = read('contracts/gen-usearch/g2/G2-PHYSICAL-LAYER-R1.md');
    assert.match(contract, /Status: \*\*PASS\*\*/);
    for (const phrase of [
        'Gen0 MemTable',
        'sole production writer',
        'runtime bootstrap cleanup',
        'immutable segment',
        'QueryReadView',
        'GENERATIONAL_ACTIVE',
        'G3 = NOT AUTHORIZED'
    ]) {
        assert.ok(contract.includes(phrase), phrase);
    }
});

test('only the G2 physical coverage writer mutates vector coverage in production code', () => {
    const modulesDir = path.join(root, 'modules/knowledgeBase');
    const candidates = fs.readdirSync(modulesDir)
        .filter(name => name.endsWith('.js'))
        .map(name => `modules/knowledgeBase/${name}`);

    const mutation = /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?gen_usearch_vector_coverage/i;
    for (const rel of candidates) {
        const source = read(rel);
        if (rel === 'modules/knowledgeBase/genUSearchPhysicalCoverageWriter.js') {
            assert.match(source, mutation);
        } else {
            assert.doesNotMatch(source, mutation, rel);
        }
    }
});

test('G2 remains unwired from existing ingestion, search and serving paths', () => {
    const forbidden = /GenUSearchMemTable|GenUSearchPhysicalCoverageWriter/;
    const candidates = [
        'KnowledgeBaseManager.js',
        'modules/knowledgeBase/indexRepository.js',
        'modules/knowledgeBase/searchService.js',
        'modules/knowledgeBase/fileWatcher.js'
    ];
    for (const rel of candidates) {
        assert.doesNotMatch(read(rel), forbidden, rel);
    }
});

test('G2 Gen0 authority is bound to authentic rust-vexus-lite native identity', () => {
    const memtable = read('modules/knowledgeBase/genUSearchMemTable.js');
    assert.match(memtable, /require\('\.\.\/\.\.\/rust-vexus-lite'\)/);
    assert.match(memtable, /instanceof NativeVexusIndex/);
    assert.match(memtable, /containsKey64/);
    assert.match(memtable, /PHYSICAL_COVERAGE_MISSING/);
});

test('G2 production modules do not implement deferred segment, manifest, GC or serving authority', () => {
    const combined = g2ProductionFiles.map(read).join('\n');
    for (const forbidden of [
        /source_kind\s*=\s*['"]SEGMENT['"]/i,
        /INSERT\s+INTO\s+gen_usearch_segments/i,
        /gen_usearch_manifest_segments/i,
        /GENERATIONAL_ACTIVE/,
        /searchKey64\s*\(/,
        /publishCurrentHead\s*\(/,
        /GC_ELIGIBLE/
    ]) {
        assert.doesNotMatch(combined, forbidden);
    }
});

test('G2 workflow covers contract, production modules and G1 regression', () => {
    const workflow = read('.github/workflows/gen-usearch-g2.yml');
    for (const required of [
        'contracts/gen-usearch/g2/**',
        'modules/knowledgeBase/genUSearchMemTable.js',
        'modules/knowledgeBase/genUSearchPhysicalCoverageWriter.js',
        'modules/knowledgeBase/genUSearchMetadataStore.js',
        'modules/knowledgeBase/schemaManager.js',
        'rust-vexus-lite/src/lib.rs',
        'tests/gen-usearch/g2/**',
        'tests/gen-usearch/g1/**'
    ]) {
        assert.ok(workflow.includes(required), required);
    }
    assert.ok(workflow.includes('workflow_dispatch:'));
});
