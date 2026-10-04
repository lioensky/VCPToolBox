'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const Ajv2020 = require('ajv/dist/2020').default;

const verifier = require('./g0-verifier');
const { runG0Acceptance } = require('./g0-runner');
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
  return new Ajv2020({ allErrors:true, strict:true }).compile(schema);
}

const lock = load('contracts/gen-usearch/g0/g0-authority-lock.json');
const registry = load('contracts/gen-usearch/g0/g0-contracts-r3.1.json');
const failureRegistry = load('contracts/gen-usearch/g0/failure-codes.json');
const finalFixtures = load('tests/gen-usearch/g0/fixtures/final-race-vectors.json');
const invariantFixtures = load('tests/gen-usearch/g0/fixtures/invariant-vectors.json');

const schemaSpecs = [
  ['authority_lock', lock, load('contracts/gen-usearch/g0/g0-authority-lock.schema.json')],
  ['registry', registry, load('contracts/gen-usearch/g0/g0-contracts.schema.json')],
  ['failure_codes', failureRegistry, load('contracts/gen-usearch/g0/failure-codes.schema.json')],
  ['final_fixtures', finalFixtures, load('tests/gen-usearch/g0/fixtures/final-race-vectors.schema.json')],
  ['invariant_fixtures', invariantFixtures, load('tests/gen-usearch/g0/fixtures/invariant-vectors.schema.json')]
];

test('strict schemas validate the exact F2R2 authority surface', () => {
  for (const [name, artifact, schema] of schemaSpecs) {
    const validate = compile(schema);
    assert.equal(validate(artifact), true, `${name}: ${JSON.stringify(validate.errors)}`);
  }
});

test('authority lock, not registry, defines the required surface', () => {
  assert.equal(registry.acceptance.authority_lock_path, 'contracts/gen-usearch/g0/g0-authority-lock.json');
  assert.equal(registry.acceptance.required_invariant_ids, undefined);
  assert.ok(lock.required_invariant_ids.length > 0);
  assert.ok(lock.required_failure_codes.length > 0);
  assert.ok(lock.required_final_fixture_ids.length > 0);
  assert.ok(lock.required_invariant_fixture_ids.length > 0);
});

test('synchronized registry/schema/fixture weakening fails against unchanged authority lock', () => {
  const weakRegistry = clone(registry);
  const weakInvariantFixtures = clone(invariantFixtures);
  const drop = 'G0-XINV-018';
  weakRegistry.invariants = weakRegistry.invariants.filter(x => x.id !== drop);
  weakInvariantFixtures.vectors = weakInvariantFixtures.vectors.filter(x => x.invariant_id !== drop);

  const result = verifier.verifyCoverage(
    lock, weakRegistry, failureRegistry, finalFixtures, weakInvariantFixtures
  );
  assert.equal(result.ok, false);
});

test('required sets are exact and non-vacuous against authority lock', () => {
  const result = verifier.verifyCoverage(lock, registry, failureRegistry, finalFixtures, invariantFixtures);
  assert.equal(result.ok, true);
  assert.deepEqual(registry.enums, lock.critical_enums);
  assert.deepEqual(registry.invariants.map(x => x.id), lock.required_invariant_ids);
  assert.deepEqual(failureRegistry.codes.map(x => x.code), lock.required_failure_codes);
  assert.deepEqual(finalFixtures.vectors.map(x => x.id), lock.required_final_fixture_ids);
  assert.deepEqual(invariantFixtures.vectors.map(x => x.id), lock.required_invariant_fixture_ids);
});

test('read-view transition guards are executable, not decorative strings', () => {
  assert.deepEqual(
    verifier.validateTransition(registry,'read_view_state','QUIESCING','RELEASED',{
      worker_quiescent:false,pins_released:false
    }),
    {ok:false,code:'READER_PIN_VIOLATION'}
  );
  assert.deepEqual(
    verifier.validateTransition(registry,'read_view_state','QUIESCING','RELEASED',{
      worker_quiescent:true,pins_released:true
    }),
    {ok:true}
  );
  assert.equal(
    verifier.validateTransition(registry,'read_view_state','ACTIVE','RELEASED',{}).ok,
    false
  );
  assert.equal(
    verifier.validateTransition(registry,'read_view_state','ACQUIRING','RELEASED',{
      acquisition_failed:true,provisional_pins_released:true,active_read_view_published:false
    }).ok,
    true
  );
});

test('GC certificate is derived from RETIRED state before GC_ELIGIBLE transition', () => {
  const retired = {
    vector_id:'20',state:'RETIRED',is_current:false,
    retired_visibility_seq:'700',retirement_durable:true
  };
  const views = [{state:'RELEASED',visibility_seq:'650',worker_quiescent:true,pins_released:true}];
  const proof = verifier.deriveGcCertificate(retired, views);
  assert.equal(proof.certified, true);
  assert.equal(proof.certificate.source_state, 'RETIRED');

  const post = {vector_id:'20',state:'GC_ELIGIBLE',retired_visibility_seq:'700'};
  assert.equal(verifier.validateGcEligibleTransition(retired, post, proof.certificate), true);

  assert.equal(verifier.deriveGcCertificate({...retired,state:'GC_ELIGIBLE'}, views).certified, false);
  assert.equal(verifier.deriveGcCertificate({...retired,retirement_durable:false}, views).certified, false);
});

test('durable coverage is derived from ManifestSnapshot + SegmentRecord + ArtifactReceipt', () => {
  const vector = {vector_id:'20',state:'ACTIVE',in_volatile_memtable:false,embedding_fingerprint:'e1'};
  const manifest = {manifest_epoch:'50',segment_ids:['S1'],embedding_fingerprint:'e1'};
  const records = [{
    segment_id:'S1',state:'PUBLISHED',artifact_digest:'a'.repeat(64),
    embedding_fingerprint:'e1',vector_ids:['20']
  }];
  const receipts = [{
    segment_id:'S1',artifact_digest:'a'.repeat(64),
    artifact_exists:true,artifact_verified:true,final_name_durable:true
  }];

  assert.equal(verifier.deriveDurableVectorCoverage(vector,manifest,records,receipts), true);
  assert.equal(verifier.deriveDurableVectorCoverage(
    vector,{...manifest,segment_ids:[]},records,receipts
  ), false);
  assert.equal(verifier.deriveDurableVectorCoverage(
    vector,manifest,records,[{...receipts[0],artifact_digest:'b'.repeat(64)}]
  ), false);
  assert.equal(verifier.deriveDurableVectorCoverage(
    vector,manifest,records,[{...receipts[0],artifact_verified:false}]
  ), false);
});

test('all frozen FINAL fixtures execute exactly', async t => {
  for (const vector of finalFixtures.vectors) {
    await t.test(vector.id, () => {
      assert.deepEqual(verifier.evaluateFixture(vector), vector.expected);
    });
  }
});

test('all frozen invariants execute with positive and negative evidence', async t => {
  for (const vector of invariantFixtures.vectors) {
    await t.test(vector.id, () => {
      assert.deepEqual(
        verifier.evaluateInvariant(registry, vector.invariant_id, vector.input),
        vector.expected
      );
    });
  }
});

test('64-bit identities remain exact beyond Number.MAX_SAFE_INTEGER', () => {
  assert.notEqual(
    verifier.parseVectorId('9007199254740992'),
    verifier.parseVectorId('9007199254740993')
  );
  assert.throws(() => verifier.parseVectorId('01'));
  assert.throws(() => verifier.parseVectorId('9223372036854775808'));
});

test('canonical runner is the only acceptance entry and computes real HEAD and digests', () => {
  assert.throws(() => runG0Acceptance({root}), TypeError);
  const manifest = runG0Acceptance(root);
  const actualHead = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();

  assert.equal(manifest.status, 'PASS');
  assert.equal(manifest.head_sha, actualHead);
  assert.equal(
    manifest.authority_lock_digest,
    verifier.sha256Text(text('contracts/gen-usearch/g0/g0-authority-lock.json'))
  );

  assert.deepEqual(Object.keys(manifest.artifact_digests), lock.required_artifact_paths);
  for (const rel of lock.required_artifact_paths) {
    assert.equal(manifest.artifact_digests[rel], verifier.sha256Text(text(rel)));
  }
});

test('acceptance schema rejects a forged PASS after runner output', () => {
  const manifest = runG0Acceptance(root);
  const schema = load('contracts/gen-usearch/g0/g0-acceptance.schema.json');
  const validate = compile(schema);
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));

  const falsePass = clone(manifest);
  falsePass.contracts.C4 = 'FAIL';
  falsePass.unresolved_p0 = 9;
  assert.equal(validate(falsePass), false);

  const fakeDigest = clone(manifest);
  fakeDigest.artifact_digests['contracts/gen-usearch/g0/g0-verifier.js'] = '0'.repeat(64);
  assert.equal(validate(fakeDigest), true);
  assert.notEqual(
    fakeDigest.artifact_digests['contracts/gen-usearch/g0/g0-verifier.js'],
    verifier.sha256Text(text('tests/gen-usearch/g0/g0-verifier.js'))
  );
  // Schema checks format; authority comes from canonical runner recomputation above.
});

test('authority lock and every required artifact are included in the digest surface', () => {
  assert.ok(lock.required_artifact_paths.includes('contracts/gen-usearch/g0/g0-authority-lock.json'));
  assert.ok(lock.required_artifact_paths.includes('tests/gen-usearch/g0/g0-runner.js'));
  for (const rel of lock.required_artifact_paths) {
    assert.equal(fs.existsSync(path.join(root,rel)), true, rel);
  }
});
