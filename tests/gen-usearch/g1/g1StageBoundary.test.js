'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const g1ProductionFiles = [
    'modules/knowledgeBase/genUSearchMetadataStore.js',
    'modules/knowledgeBase/genUSearchReconciler.js',
    'modules/knowledgeBase/genUSearchReconciliationService.js'
];

test('G1 does not manufacture physical coverage facts or activate the engine', () => {
    for (const rel of g1ProductionFiles) {
        const source = read(rel);
        assert.doesNotMatch(
            source,
            /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?gen_usearch_vector_coverage/i,
            rel
        );
        assert.doesNotMatch(source, /GENERATIONAL_ACTIVE/, rel);
    }
});

test('G1 lifecycle primitives remain unwired from existing production serving paths', () => {
    const forbidden = /GenUSearchMetadataStore|GenUSearchReconciliationService|\.stageVector\s*\(|\.publishCurrentHead\s*\(/;
    const candidates = [
        'KnowledgeBaseManager.js',
        ...fs.readdirSync(path.join(root, 'modules/knowledgeBase'))
            .filter(name => name.endsWith('.js'))
            .map(name => `modules/knowledgeBase/${name}`)
            .filter(rel => !g1ProductionFiles.includes(rel))
    ];
    for (const rel of candidates) {
        assert.doesNotMatch(read(rel), forbidden, rel);
    }
});

test('signed-int64-safe Vexus ABI covers add, batch, search, remove and atomic delta', () => {
    const rust = read('rust-vexus-lite/src/lib.rs');
    const types = read('rust-vexus-lite/index.d.ts');
    for (const rustMethod of [
        'pub fn add_key64(',
        'pub fn add_batch_key64(',
        'pub fn search_key64(',
        'pub fn remove_key64(',
        'pub fn apply_chunk_delta_key64('
    ]) {
        assert.ok(rust.includes(rustMethod), rustMethod);
    }
    for (const tsMethod of [
        'addKey64(',
        'addBatchKey64(',
        'searchKey64(',
        'removeKey64(',
        'applyChunkDeltaKey64('
    ]) {
        assert.ok(types.includes(tsMethod), tsMethod);
    }
});

test('G1 workflow covers every production surface and upstream baseline dependency', () => {
    const workflow = read('.github/workflows/gen-usearch-g1.yml');
    const required = [
        'contracts/gen-usearch/g1/**',
        'KnowledgeBaseManager.js',
        'config.env.example',
        'modules/knowledgeBase/indexRepository.js',
        'modules/knowledgeBase/schemaManager.js',
        'modules/knowledgeBase/genUSearchMetadataStore.js',
        'modules/knowledgeBase/genUSearchReconciler.js',
        'modules/knowledgeBase/genUSearchReconciliationService.js',
        'rust-vexus-lite/Cargo.lock',
        'rust-vexus-lite/Cargo.toml',
        'rust-vexus-lite/index.d.ts',
        'rust-vexus-lite/src/lib.rs',
        'tests/gen-usearch/g1/**',
        'tests/tagIndexGenerationalBaseline.test.js'
    ];
    for (const rel of required) {
        assert.ok(workflow.includes(rel), rel);
    }
    assert.ok(workflow.includes('actions/checkout@11d5960a326750d5838078e36cf38b85af677262'));
    assert.ok(workflow.includes('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'));
});

test('G1 contract explicitly defers physical serving and cutover to later gates', () => {
    const contract = read('contracts/gen-usearch/g1/G1-PRODUCTION-IMPLEMENTATION-R1.md');
    assert.match(contract, /Status: \*\*FINAL_REVIEW_CANDIDATE\*\*/);
    for (const phrase of [
        'production writer for \`gen_usearch_vector_coverage\`',
        'Gen0 MemTable coordination',
        'immutable segment',
        'compaction',
        '\`GENERATIONAL_ACTIVE\` activation'
    ]) {
        assert.ok(contract.includes(phrase), phrase);
    }
});
