'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Ajv2020 = require('ajv/dist/2020').default;

const verifier = require('./g0-verifier');
const { runG0Acceptance, repositoryTopLevel } = require('./g0-runner');
const root = path.resolve(__dirname, '../../..');
const LOCK_PATH = 'contracts/gen-usearch/g0/g0-authority-lock.json';

function load(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}
function compile(schema) {
  return new Ajv2020({ allErrors:true, strict:true }).compile(schema);
}
function gitBytes(rel) {
  return execFileSync('git', ['show', `HEAD:${rel}`], { cwd:root, encoding:null, maxBuffer:16*1024*1024 });
}
function withAuthorityPin(fn) {
  const previous = process.env.G0_AUTHORITY_LOCK_SHA256;
  process.env.G0_AUTHORITY_LOCK_SHA256 = verifier.sha256Bytes(gitBytes(LOCK_PATH));
  try { return fn(); }
  finally {
    if (previous === undefined) delete process.env.G0_AUTHORITY_LOCK_SHA256;
    else process.env.G0_AUTHORITY_LOCK_SHA256 = previous;
  }
}

const lock = load(LOCK_PATH);
const architecture = load('contracts/gen-usearch/g0/G0-ARCHITECTURE-R3.1.machine.json');
const traceability = load('contracts/gen-usearch/g0/G0-TRACEABILITY-R3.1.json');
const registry = load('contracts/gen-usearch/g0/g0-contracts-r3.1.json');
const failureRegistry = load('contracts/gen-usearch/g0/failure-codes.json');
const finalFixtures = load('tests/gen-usearch/g0/fixtures/final-race-vectors.json');
const invariantFixtures = load('tests/gen-usearch/g0/fixtures/invariant-vectors.json');

const schemaSpecs = [
  ['authority_lock', lock, load('contracts/gen-usearch/g0/g0-authority-lock.schema.json')],
  ['architecture', architecture, load('contracts/gen-usearch/g0/G0-ARCHITECTURE-R3.1.schema.json')],
  ['traceability', traceability, load('contracts/gen-usearch/g0/G0-TRACEABILITY-R3.1.schema.json')],
  ['registry', registry, load('contracts/gen-usearch/g0/g0-contracts.schema.json')],
  ['failure_codes', failureRegistry, load('contracts/gen-usearch/g0/failure-codes.schema.json')],
  ['final_fixtures', finalFixtures, load('tests/gen-usearch/g0/fixtures/final-race-vectors.schema.json')],
  ['invariant_fixtures', invariantFixtures, load('tests/gen-usearch/g0/fixtures/invariant-vectors.schema.json')]
];

test('strict schemas validate exact F2R3 artifacts', () => {
  for (const [name, artifact, schema] of schemaSpecs) {
    const validate = compile(schema);
    assert.equal(validate(artifact), true, `${name}: ${JSON.stringify(validate.errors)}`);
  }
});

test('authority lock is externally pinned and seals every other locked artifact', () => {
  assert.deepEqual(lock.external_authority_pin, {
    kind:'github_actions_repository_variable',
    name:'G0_AUTHORITY_LOCK_SHA256',
    required:true
  });
  assert.equal(lock.sealed_artifact_paths.includes(LOCK_PATH), false);
  assert.equal(verifier.exactSetEquals(
    Object.keys(lock.sealed_artifact_sha256),
    lock.sealed_artifact_paths
  ), true);
  for (const rel of lock.sealed_artifact_paths) {
    assert.equal(lock.sealed_artifact_sha256[rel], verifier.sha256Bytes(gitBytes(rel)), rel);
  }
});

test('wrong external authority pin is rejected', () => {
  const previous = process.env.G0_AUTHORITY_LOCK_SHA256;
  process.env.G0_AUTHORITY_LOCK_SHA256 = '0'.repeat(64);
  try {
    assert.throws(
      () => runG0Acceptance(root),
      /G0_AUTHORITY_LOCK_PIN_MISMATCH/
    );
  } finally {
    if (previous === undefined) delete process.env.G0_AUTHORITY_LOCK_SHA256;
    else process.env.G0_AUTHORITY_LOCK_SHA256 = previous;
  }
});

test('nested fake roots are rejected even inside the same git repository', () => {
  assert.throws(
    () => repositoryTopLevel(path.join(root, 'tests')),
    /G0_ROOT_NOT_REPOSITORY_TOPLEVEL/
  );
});

test('dirty locked artifacts cannot claim the unchanged HEAD', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'g0-f2r3-worktree-'));
  fs.rmSync(temp, {recursive:true, force:true});
  execFileSync('git', ['worktree','add','--detach',temp,'HEAD'], {cwd:root,stdio:'ignore'});
  try {
    const target = path.join(temp, 'tests/gen-usearch/g0/fixtures/invariant-vectors.json');
    fs.appendFileSync(target, '\n');
    withAuthorityPin(() => {
      assert.throws(
        () => runG0Acceptance(temp),
        /G0_ARTIFACT_NOT_HEAD_BYTES|G0_LOCKED_WORKTREE_DIRTY/
      );
    });
  } finally {
    execFileSync('git', ['worktree','remove','--force',temp], {cwd:root,stdio:'ignore'});
  }
});

test('authority lock, not registry, defines required surface', () => {
  assert.equal(registry.acceptance.authority_lock_path, LOCK_PATH);
  assert.equal(registry.acceptance.required_invariant_ids, undefined);
  const result = verifier.verifyCoverage(lock, architecture, traceability, registry, failureRegistry, finalFixtures, invariantFixtures);
  assert.equal(result.ok, true);
});

test('architecture traceability is exact and amendments are fully covered', () => {
  assert.deepEqual(
    architecture.requirements.map(x => x.id),
    lock.required_architecture_requirement_ids
  );
  assert.deepEqual(
    traceability.rows.map(x => x.architecture_requirement_id),
    lock.required_architecture_requirement_ids
  );
  assert.deepEqual(architecture.amendments.map(x => x.id), lock.required_amendment_ids);
  assert.deepEqual(traceability.amendment_coverage.map(x => x.amendment_id), lock.required_amendment_ids);
  assert.equal(architecture.requirements.length, 31);
  assert.equal(registry.invariants.length, 31);
  assert.equal(invariantFixtures.vectors.length, 62);
  for (const amendment of architecture.amendments) {
    const row = traceability.amendment_coverage.find(x => x.amendment_id === amendment.id);
    assert.ok(row, amendment.id);
    assert.deepEqual(new Set(row.requirement_ids), new Set(amendment.implements_requirement_ids));
    assert.ok(row.requirement_ids.length > 0);
  }
});

test('synchronized registry/schema/fixture weakening fails while lock is unchanged', () => {
  const weakRegistry = JSON.parse(JSON.stringify(registry));
  const weakInvariantFixtures = JSON.parse(JSON.stringify(invariantFixtures));
  const drop = 'G0-XINV-018';
  weakRegistry.invariants = weakRegistry.invariants.filter(x => x.id !== drop);
  weakInvariantFixtures.vectors = weakInvariantFixtures.vectors.filter(x => x.invariant_id !== drop);
  assert.equal(
    verifier.verifyCoverage(lock, architecture, traceability, weakRegistry, failureRegistry, finalFixtures, weakInvariantFixtures).ok,
    false
  );
});

test('read-view transition guards execute', () => {
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
  assert.equal(verifier.validateTransition(registry,'read_view_state','ACTIVE','RELEASED',{}).ok, false);
});

test('allocator admits zero initial high-water and read-view expiry permits safe post-quiescence release', () => {
  assert.deepEqual(
    verifier.validateAllocatorHistory({
      durable_high_water_before:'0',
      allocated_ids:['1','2'],
      durable_high_water_after:'2',
      restart_next_id:'3'
    }),
    {ok:true}
  );
  assert.deepEqual(
    verifier.validateBoundedReadView({
      created_at_ms:'1000',
      deadline_ms:'2000',
      now_ms:'2500',
      state:'RELEASED',
      worker_quiescent:true,
      pins_released:true
    }),
    {ok:true}
  );
});

test('GC certificate starts at RETIRED and cannot self-certify from GC_ELIGIBLE', () => {
  const retired = {
    vector_id:'20',state:'RETIRED',is_current:false,
    retired_visibility_seq:'700',retirement_durable:true
  };
  const views = [{state:'RELEASED',visibility_seq:'650',worker_quiescent:true,pins_released:true}];
  const proof = verifier.deriveGcCertificate(retired, views);
  assert.equal(proof.certified, true);
  const post = {vector_id:'20',state:'GC_ELIGIBLE',retired_visibility_seq:'700'};
  assert.equal(verifier.validateGcEligibleTransition(retired, post, proof.certificate), true);
  assert.equal(verifier.deriveGcCertificate({...retired,state:'GC_ELIGIBLE'}, views).certified, false);
});

test('durable coverage requires manifest + segment record + artifact receipt agreement', () => {
  const vector = {vector_id:'20',state:'ACTIVE',in_volatile_memtable:false,embedding_fingerprint:'e1'};
  const manifest = {manifest_epoch:'50',segment_ids:['S1'],embedding_fingerprint:'e1'};
  const records = [{segment_id:'S1',state:'PUBLISHED',artifact_digest:'a'.repeat(64),embedding_fingerprint:'e1',vector_ids:['20']}];
  const receipts = [{segment_id:'S1',artifact_digest:'a'.repeat(64),artifact_exists:true,artifact_verified:true,final_name_durable:true}];
  assert.equal(verifier.deriveDurableVectorCoverage(vector,manifest,records,receipts), true);
  assert.equal(verifier.deriveDurableVectorCoverage(vector,{...manifest,segment_ids:[]},records,receipts), false);
  assert.equal(verifier.deriveDurableVectorCoverage(vector,manifest,records,[{...receipts[0],artifact_verified:false}]), false);
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
      assert.deepEqual(verifier.evaluateInvariant(registry, vector.invariant_id, vector.input), vector.expected);
    });
  }
});

test('64-bit vector identities remain byte-stable decimal identities', () => {
  assert.notEqual(verifier.parseVectorId('9007199254740992'), verifier.parseVectorId('9007199254740993'));
  assert.throws(() => verifier.parseVectorId('01'));
  assert.throws(() => verifier.parseVectorId('9223372036854775808'));
});

test('canonical runner binds PASS to exact clean HEAD bytes', () => {
  const manifest = withAuthorityPin(() => runG0Acceptance(root));
  const actualHead = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  assert.equal(manifest.status, 'PASS');
  assert.equal(manifest.head_sha, actualHead);
  assert.equal(manifest.unresolved_p0, 0);
  assert.equal(manifest.unresolved_p1, 0);
  assert.equal(manifest.authority_lock_digest, verifier.sha256Bytes(gitBytes(LOCK_PATH)));
  assert.deepEqual(Object.keys(manifest.artifact_digests), lock.required_artifact_paths);
  for (const rel of lock.required_artifact_paths) {
    assert.equal(manifest.artifact_digests[rel], verifier.sha256Bytes(gitBytes(rel)));
  }
  assert.ok(manifest.evidence.includes('artifact-binding:git-head-byte-exact'));
});

test('acceptance schema rejects direct false PASS fields', () => {
  const manifest = withAuthorityPin(() => runG0Acceptance(root));
  const validate = compile(load('contracts/gen-usearch/g0/g0-acceptance.schema.json'));
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  const forged = JSON.parse(JSON.stringify(manifest));
  forged.contracts.C4='FAIL';
  forged.unresolved_p0=1;
  assert.equal(validate(forged), false);
});

test('every locked artifact exists at HEAD and in worktree', () => {
  for (const rel of lock.required_artifact_paths) {
    assert.doesNotThrow(() => gitBytes(rel), rel);
    assert.equal(fs.existsSync(path.join(root, rel)), true, rel);
  }
});
