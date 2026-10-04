'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Ajv2020 = require('ajv/dist/2020').default;

const verifier = require('./g0-verifier');
const root = path.resolve(__dirname, '../../..');

function load(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}
function text(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function compile(schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(schema);
}

const registry = load('contracts/gen-usearch/g0/g0-contracts-r3.1.json');
const failureRegistry = load('contracts/gen-usearch/g0/failure-codes.json');
const registrySchema = load('contracts/gen-usearch/g0/g0-contracts.schema.json');
const failureSchema = load('contracts/gen-usearch/g0/failure-codes.schema.json');
const acceptanceSchema = load('contracts/gen-usearch/g0/g0-acceptance.schema.json');
const finalFixtures = load('tests/gen-usearch/g0/fixtures/final-race-vectors.json');
const finalFixtureSchema = load('tests/gen-usearch/g0/fixtures/final-race-vectors.schema.json');
const invariantFixtures = load('tests/gen-usearch/g0/fixtures/invariant-vectors.json');
const invariantFixtureSchema = load('tests/gen-usearch/g0/fixtures/invariant-vectors.schema.json');

const validateRegistry = compile(registrySchema);
const validateFailures = compile(failureSchema);
const validateFinalFixtures = compile(finalFixtureSchema);
const validateInvariantFixtures = compile(invariantFixtureSchema);
const validateAcceptance = compile(acceptanceSchema);

test('strict JSON schemas validate exact artifacts', () => {
  assert.equal(validateRegistry(registry), true, JSON.stringify(validateRegistry.errors));
  assert.equal(validateFailures(failureRegistry), true, JSON.stringify(validateFailures.errors));
  assert.equal(validateFinalFixtures(finalFixtures), true, JSON.stringify(validateFinalFixtures.errors));
  assert.equal(validateInvariantFixtures(invariantFixtures), true, JSON.stringify(validateInvariantFixtures.errors));
});

test('schemas reject weakened or vacuous contract artifacts', () => {
  const weakRegistry = clone(registry);
  weakRegistry.clocks.visibility_seq = null;
  assert.equal(validateRegistry(weakRegistry), false);

  const emptyFailures = clone(failureRegistry);
  emptyFailures.codes = [];
  assert.equal(validateFailures(emptyFailures), false);

  const emptyFinal = clone(finalFixtures);
  emptyFinal.vectors = [];
  assert.equal(validateFinalFixtures(emptyFinal), false);

  const emptyInvariant = clone(invariantFixtures);
  emptyInvariant.vectors = [];
  assert.equal(validateInvariantFixtures(emptyInvariant), false);
});

test('all contract artifacts are version-bound', () => {
  const versions = [
    registry.contract_version,
    failureRegistry.contract_version,
    finalFixtures.contract_version,
    invariantFixtures.contract_version
  ];
  assert.equal(new Set(versions).size, 1);
});

test('required failure, invariant and fixture sets are exact and non-vacuous', () => {
  const coverage = verifier.verifyCoverage(registry, failureRegistry, finalFixtures, invariantFixtures);
  assert.equal(coverage.ok, true);
  assert.ok(registry.acceptance.required_failure_codes.length > 0);
  assert.ok(registry.acceptance.required_invariant_ids.length > 0);
  assert.ok(registry.acceptance.required_final_fixture_ids.length > 0);
  assert.ok(registry.acceptance.required_invariant_fixture_ids.length > 0);

  for (const invariantId of registry.acceptance.required_invariant_ids) {
    const rows = invariantFixtures.vectors.filter(row => row.invariant_id === invariantId);
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map(row => row.polarity)), new Set(['positive','negative']));
  }
});

test('failure codes are unique, complete and contract-bound', () => {
  const codes = failureRegistry.codes.map(item => item.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.deepEqual(codes, registry.acceptance.required_failure_codes);
  for (const item of failureRegistry.codes) {
    assert.ok(['P0_CORRECTNESS','P1_ARCHITECTURE','P2_IMPLEMENTATION'].includes(item.severity));
    assert.match(item.contract, /^C[1-8]$/);
  }
  for (const invariant of registry.invariants) {
    assert.ok(codes.includes(invariant.failure_code));
  }
});

test('state tables close acquisition abort and forbid ACTIVE to RELEASED shortcut', () => {
  assert.equal(verifier.isAllowedTransition(registry, 'read_view_state', 'ACQUIRING', 'RELEASED'), true);
  assert.equal(verifier.isAllowedTransition(registry, 'read_view_state', 'ACTIVE', 'QUIESCING'), true);
  assert.equal(verifier.isAllowedTransition(registry, 'read_view_state', 'ACTIVE', 'RELEASED'), false);
  assert.equal(verifier.isAllowedTransition(registry, 'chunk_version_state', 'RETIRED', 'ACTIVE'), false);
  assert.equal(verifier.isAllowedTransition(registry, 'engine_mode', 'LEGACY', 'GENERATIONAL_ACTIVE'), false);
});

const finalExecutions = [];
test('all frozen FINAL race/crash fixtures produce exact deterministic verdicts', async t => {
  for (const vector of finalFixtures.vectors) {
    await t.test(vector.id, () => {
      const actual = verifier.evaluateFixture(vector);
      const matched = (() => {
        try { assert.deepEqual(actual, vector.expected); return true; } catch (_) { return false; }
      })();
      finalExecutions.push({ id: vector.id, group: vector.group, matched_expected: matched });
      assert.deepEqual(actual, vector.expected);
    });
  }
});

const invariantExecutions = [];
test('every frozen invariant has executable positive and negative evidence', async t => {
  for (const vector of invariantFixtures.vectors) {
    await t.test(vector.id, () => {
      const actual = verifier.evaluateInvariant(registry, vector.invariant_id, vector.input);
      const matched = (() => {
        try { assert.deepEqual(actual, vector.expected); return true; } catch (_) { return false; }
      })();
      invariantExecutions.push({ id: vector.id, invariant_id: vector.invariant_id, polarity: vector.polarity, matched_expected: matched });
      assert.deepEqual(actual, vector.expected);
    });
  }
});

test('64-bit vector identities remain distinct beyond Number.MAX_SAFE_INTEGER', () => {
  const a = verifier.parseVectorId('9007199254740992');
  const b = verifier.parseVectorId('9007199254740993');
  assert.notEqual(a, b);
  assert.equal(verifier.validatePhysicalCoverage({
    visibility_seq:'1',
    current_vector_ids:['9007199254740993'],
    physical_vector_ids:['9007199254740992']
  }).ok, false);
  assert.throws(() => verifier.parseVectorId('01'));
  assert.throws(() => verifier.parseVectorId('9223372036854775808'));
});

test('GC fails closed for malformed or unproven readers and retirement state', () => {
  const vector = { vector_id:'10', state:'GC_ELIGIBLE', is_current:false, retired_visibility_seq:'101', retirement_durable:true };

  assert.deepEqual(
    verifier.canGcLogicalVector(vector, [{state:'ACTIVE',worker_quiescent:false,pins_released:false}]),
    {can_gc:false,code:'QUERY_READ_VIEW_INVALID'}
  );

  assert.deepEqual(
    verifier.canGcLogicalVector(vector, [{state:'BOGUS',visibility_seq:'999',worker_quiescent:false,pins_released:false}]),
    {can_gc:false,code:'QUERY_READ_VIEW_INVALID'}
  );

  assert.equal(verifier.canGcLogicalVector(
    {...vector,retirement_durable:false}, []
  ).can_gc, false);
});

test('recovery and manifest durability are derived from records, not caller booleans', () => {
  const vector = { vector_id:'10', state:'ACTIVE', in_volatile_memtable:false, embedding_fingerprint:'e1' };
  const selfAsserted = [{
    segment_id:'S10',
    state:'PUBLISHED',
    artifact_exists:true,
    artifact_verified:true,
    final_name_durable:true
  }];
  assert.deepEqual(
    verifier.validateRecoveryCoverage(vector, selfAsserted, null),
    {ok:false,code:'VECTOR_RECOVERY_MATERIAL_MISSING'}
  );

  assert.deepEqual(
    verifier.validateManifestSegments(['S10'], [{
      segment_id:'S10',
      state:'PUBLISHED',
      artifact_exists:true,
      artifact_verified:false,
      final_name_durable:true
    }]),
    {ok:false,code:'SEGMENT_DURABILITY_UNPROVEN',unproven_segment_ids:['S10']}
  );
});

test('acceptance is derived from executed evidence and schema-validates', () => {
  assert.equal(finalExecutions.length, finalFixtures.vectors.length);
  assert.equal(invariantExecutions.length, invariantFixtures.vectors.length);

  const artifactPaths = [
    'contracts/gen-usearch/g0/g0-contracts-r3.1.json',
    'contracts/gen-usearch/g0/failure-codes.json',
    'contracts/gen-usearch/g0/g0-contracts.schema.json',
    'contracts/gen-usearch/g0/failure-codes.schema.json',
    'contracts/gen-usearch/g0/g0-acceptance.schema.json',
    'tests/gen-usearch/g0/fixtures/final-race-vectors.json',
    'tests/gen-usearch/g0/fixtures/final-race-vectors.schema.json',
    'tests/gen-usearch/g0/fixtures/invariant-vectors.json',
    'tests/gen-usearch/g0/fixtures/invariant-vectors.schema.json',
    'tests/gen-usearch/g0/g0-verifier.js'
  ];
  const artifactDigests = Object.fromEntries(artifactPaths.map(rel => [rel, verifier.sha256Text(text(rel))]));
  const headSha = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();

  const manifest = verifier.deriveAcceptance({
    registry,
    failureRegistry,
    finalFixtures,
    invariantFixtures,
    schemaChecks:{registry:'PASS',failure_codes:'PASS',final_fixtures:'PASS',invariant_fixtures:'PASS'},
    finalExecutions,
    invariantExecutions,
    headSha,
    artifactDigests
  });

  assert.equal(manifest.status, 'PASS');
  assert.equal(verifier.validateAcceptanceConsistency(manifest, registry).ok, true);
  assert.equal(validateAcceptance(manifest), true, JSON.stringify(validateAcceptance.errors));

  const falsePass = clone(manifest);
  falsePass.contracts.C4 = 'FAIL';
  falsePass.unresolved_p0 = 9;
  assert.equal(validateAcceptance(falsePass), false);
  assert.deepEqual(verifier.validateAcceptanceConsistency(falsePass, registry), {ok:false,code:'FALSE_PASS_ACCEPTANCE'});

  const brokenEvidence = clone(finalExecutions);
  brokenEvidence[0].matched_expected = false;
  const derivedFailure = verifier.deriveAcceptance({
    registry,
    failureRegistry,
    finalFixtures,
    invariantFixtures,
    schemaChecks:{registry:'PASS',failure_codes:'PASS',final_fixtures:'PASS',invariant_fixtures:'PASS'},
    finalExecutions:brokenEvidence,
    invariantExecutions,
    headSha,
    artifactDigests
  });
  assert.equal(derivedFailure.status, 'FAIL');
  assert.ok(derivedFailure.unresolved_p0 > 0);
});
