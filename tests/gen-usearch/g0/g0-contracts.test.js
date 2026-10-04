'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const verifier = require('./g0-verifier');

const root = path.resolve(__dirname, '../../..');
const registry = JSON.parse(fs.readFileSync(
  path.join(root, 'contracts/gen-usearch/g0/g0-contracts-r3.1.json'), 'utf8'
));
const failureRegistry = JSON.parse(fs.readFileSync(
  path.join(root, 'contracts/gen-usearch/g0/failure-codes.json'), 'utf8'
));
const fixtures = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/final-race-vectors.json'), 'utf8'
));

test('G0 machine registry freezes independent logical and physical clocks', () => {
  assert.equal(registry.clocks.visibility_seq.monotonic, true);
  assert.equal(registry.clocks.manifest_epoch.monotonic, true);
  assert.ok(registry.clocks.visibility_seq.independent_from.includes('manifest_epoch'));
  assert.ok(registry.clocks.manifest_epoch.independent_from.includes('visibility_seq'));
});

test('chunk version state machine permits only frozen transitions', () => {
  assert.equal(verifier.isAllowedTransition(registry, 'chunk_version_state', 'VECTOR_STAGED', 'ACTIVE'), true);
  assert.equal(verifier.isAllowedTransition(registry, 'chunk_version_state', 'ACTIVE', 'RETIRED'), true);
  assert.equal(verifier.isAllowedTransition(registry, 'chunk_version_state', 'RETIRED', 'ACTIVE'), false);
  assert.equal(verifier.isAllowedTransition(registry, 'chunk_version_state', 'ABORTED', 'ACTIVE'), false);
});

test('engine mode forbids LEGACY to ACTIVE bypass', () => {
  assert.equal(verifier.isAllowedTransition(registry, 'engine_mode', 'LEGACY', 'GENERATIONAL_SHADOW'), true);
  assert.equal(verifier.isAllowedTransition(registry, 'engine_mode', 'GENERATIONAL_SHADOW', 'GENERATIONAL_ACTIVE'), true);
  assert.equal(verifier.isAllowedTransition(registry, 'engine_mode', 'LEGACY', 'GENERATIONAL_ACTIVE'), false);
});

test('failure codes are unique and severity-classified', () => {
  const codes = failureRegistry.codes.map(item => item.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const item of failureRegistry.codes) {
    assert.ok(['P0_CORRECTNESS','P1_ARCHITECTURE','P2_IMPLEMENTATION'].includes(item.severity));
    assert.match(item.contract, /^C[1-8]$/);
  }
});

test('all frozen race and crash vectors produce exact deterministic verdicts', async t => {
  for (const vector of fixtures.vectors) {
    await t.test(vector.id, () => {
      const actual = verifier.evaluateFixture(vector);
      assert.deepEqual(actual, vector.expected);
    });
  }
});

test('acceptance cannot pass while any P0/P1 remains', () => {
  const contractStatuses = Object.fromEntries(['C1','C2','C3','C4','C5','C6','C7','C8'].map(id => [id,'PASS']));
  const finalChecks = Object.fromEntries(['FINAL-01','FINAL-02','FINAL-03','FINAL-04','FINAL-05'].map(id => [id,'PASS']));
  assert.equal(verifier.computeAcceptance({contractStatuses, finalChecks, unresolvedP0:0, unresolvedP1:0}), 'PASS');
  assert.equal(verifier.computeAcceptance({contractStatuses, finalChecks, unresolvedP0:1, unresolvedP1:0}), 'FAIL');
  assert.equal(verifier.computeAcceptance({contractStatuses, finalChecks, unresolvedP0:0, unresolvedP1:1}), 'FAIL');
});

test('read-view release semantics keep CANCEL_REQUESTED and QUIESCING readers GC-visible', () => {
  const vector = {state:'RETIRED', retired_visibility_seq:101};
  assert.equal(verifier.canGcLogicalVector(vector, [{state:'CANCEL_REQUESTED',visibility_seq:100}]), false);
  assert.equal(verifier.canGcLogicalVector(vector, [{state:'QUIESCING',visibility_seq:100}]), false);
  assert.equal(verifier.canGcLogicalVector(vector, [{state:'RELEASED',visibility_seq:100}]), true);
});
