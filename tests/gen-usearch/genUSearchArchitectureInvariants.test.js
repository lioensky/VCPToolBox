'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('schema keeps logical visibility and physical topology clocks independent', () => {
    const schema = read('modules/knowledgeBase/schemaManager.js');
    assert.match(schema, /name IN \('visibility_seq', 'manifest_epoch'\)/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS gen_usearch_manifest_state/);
    assert.match(schema, /manifest_epoch INTEGER NOT NULL/);
});

test('current-head publication remains SQLite-CAS and physical-coverage gated', () => {
    const source = read('modules/knowledgeBase/genUSearchMetadataStore.js');
    assert.match(source, /publishCurrentHead/);
    assert.match(source, /gen_usearch_vector_coverage/);
    assert.match(source, /QUERY_VISIBLE/);
    assert.match(source, /visibility_seq/);
    assert.match(source, /expectedCurrentVersionId/);
});

test('source admission requires a committed-source lease', () => {
    const source = read('modules/knowledgeBase/genUSearchReconciliationService.js');
    assert.match(source, /withCommittedSourceView/);
    assert.match(source, /#withCommittedSourceLease/);
    const method = source.slice(source.indexOf('async planAndAdmitCurrentSource'));
    assert.ok(method.indexOf('#withCommittedSourceLease') < method.indexOf('admitReconciliationPlan'));
});

test('runtime process and read-view authority are durable SQLite leases', () => {
    const schema = read('modules/knowledgeBase/schemaManager.js');
    assert.match(schema, /CREATE TABLE IF NOT EXISTS gen_usearch_runtime_process_lease/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS gen_usearch_read_view_leases/);
    const writer = read('modules/knowledgeBase/genUSearchPhysicalCoverageWriter.js');
    assert.match(writer, /process_token/);
    assert.match(writer, /runtime_fence/);
    assert.match(writer, /_assertProcessAuthority/);
});

test('QueryReadView cancellation is monotonic and deadline is rechecked after final fence read', () => {
    const source = read('modules/knowledgeBase/genUSearchQueryReadView.js');
    assert.match(
        source,
        /cancellation_requested = CASE[\s\S]*WHEN cancellation_requested = 1 OR \? = 1 THEN 1/
    );
    const start = source.indexOf('assertResponseFence(view)');
    const end = source.indexOf('collectPhysicalCandidates(', start);
    const method = source.slice(start, end);
    assert.ok(method.indexOf('const runtime = this._getRuntime.get()') >= 0);
    assert.ok(method.indexOf('this.assertUsable(view)', method.indexOf('const runtime = this._getRuntime.get()')) >= 0);
});

test('segment publication requires explicit pre-provisioned root and durable artifact verification', () => {
    const source = read('modules/knowledgeBase/genUSearchSegmentPublisher.js');
    assert.match(source, /explicit pre-provisioned segmentRoot/);
    assert.doesNotMatch(source, /mkdirSync\(segmentRoot/);
    assert.match(source, /sha256File/);
    assert.match(source, /containsKey64/);
    assert.match(source, /manifest_epoch/);
});

test('GC release depends on durable reader and segment authority instead of cancellation alone', () => {
    const source = read('modules/knowledgeBase/genUSearchGcCoordinator.js');
    assert.match(source, /gen_usearch_read_view_leases/);
    assert.match(source, /RECOVERY_RECLAIMABLE/);
    assert.match(source, /RECOVERY_RELEASED/);
    assert.match(source, /covered_segment_id/);
    assert.match(source, /worker_quiescent/);
    assert.match(source, /pins_released/);
});

test('signed-int64 key ABI exists in Rust and TypeScript surfaces', () => {
    const rust = read('rust-vexus-lite/src/lib.rs');
    const types = read('rust-vexus-lite/index.d.ts');
    for (const rustMethod of [
        'pub fn add_key64(',
        'pub fn add_batch_key64(',
        'pub fn search_key64(',
        'pub fn remove_key64(',
        'pub fn apply_chunk_delta_key64('
    ]) assert.ok(rust.includes(rustMethod), rustMethod);
    for (const tsMethod of [
        'addKey64(',
        'addBatchKey64(',
        'searchKey64(',
        'removeKey64(',
        'applyChunkDeltaKey64('
    ]) assert.ok(types.includes(tsMethod), tsMethod);
});
