'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const Ajv2020 = require('ajv/dist/2020').default;
const verifier = require('./g0-verifier');

const AUTHORITY_LOCK_PATH = 'contracts/gen-usearch/g0/g0-authority-lock.json';
const AUTHORITY_LOCK_SCHEMA_PATH = 'contracts/gen-usearch/g0/g0-authority-lock.schema.json';
const MAX_GIT_BLOB = 16 * 1024 * 1024;

function git(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    maxBuffer: MAX_GIT_BLOB,
    ...options
  });
}

function repositoryTopLevel(root) {
  const realRoot = fs.realpathSync(root);
  const top = String(git(root, ['rev-parse','--show-toplevel'], { encoding:'utf8' })).trim();
  const realTop = fs.realpathSync(top);
  if (realRoot !== realTop) {
    throw new Error(`G0_ROOT_NOT_REPOSITORY_TOPLEVEL: root=${realRoot} top=${realTop}`);
  }
  return realTop;
}

function gitHead(root) {
  const head = String(git(root, ['rev-parse','HEAD'], { encoding:'utf8' })).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('G0_HEAD_INVALID');
  return head;
}

function gitShowBuffer(root, head, rel) {
  return git(root, ['show', `${head}:${rel}`], { encoding:null });
}

function readWorktreeBuffer(root, rel) {
  const full = path.join(root, rel);
  const stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`G0_ARTIFACT_NOT_REGULAR_FILE: ${rel}`);
  }
  return fs.readFileSync(full);
}

function parseJsonBuffer(buffer, rel) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`G0_JSON_INVALID: ${rel}: ${error.message}`);
  }
}

function expectedAuthorityLockDigestFromEnvironment() {
  const expected = process.env.G0_AUTHORITY_LOCK_SHA256;
  if (!/^[a-f0-9]{64}$/.test(expected || '')) {
    throw new Error('G0_AUTHORITY_LOCK_PIN_MISSING_OR_INVALID');
  }
  return expected;
}

function assertLockedPathsClean(root, paths) {
  const output = String(git(root, [
    'status','--porcelain=v1','--untracked-files=all','--',...paths
  ], { encoding:'utf8' }));
  if (output.trim() !== '') {
    throw new Error(`G0_LOCKED_WORKTREE_DIRTY:\n${output.trim()}`);
  }
}

function captureRepositorySnapshot(root) {
  const repoRoot = repositoryTopLevel(root);
  const head = gitHead(repoRoot);

  const lockHeadBytes = gitShowBuffer(repoRoot, head, AUTHORITY_LOCK_PATH);
  const lockWorkBytes = readWorktreeBuffer(repoRoot, AUTHORITY_LOCK_PATH);
  if (!lockHeadBytes.equals(lockWorkBytes)) {
    throw new Error('G0_AUTHORITY_LOCK_NOT_HEAD_BYTES');
  }

  const lockDigest = verifier.sha256Bytes(lockHeadBytes);
  const expectedLockDigest = expectedAuthorityLockDigestFromEnvironment();
  if (lockDigest !== expectedLockDigest) {
    throw new Error(`G0_AUTHORITY_LOCK_PIN_MISMATCH: expected=${expectedLockDigest} actual=${lockDigest}`);
  }

  const authorityLock = parseJsonBuffer(lockHeadBytes, AUTHORITY_LOCK_PATH);
  if (!Array.isArray(authorityLock.required_artifact_paths) || authorityLock.required_artifact_paths.length === 0) {
    throw new Error('G0_AUTHORITY_LOCK_ARTIFACT_SET_INVALID');
  }
  if (!authorityLock.sealed_artifact_sha256 || typeof authorityLock.sealed_artifact_sha256 !== 'object') {
    throw new Error('G0_AUTHORITY_LOCK_SEAL_MAP_MISSING');
  }

  const snapshotBuffers = new Map();
  const artifactDigests = {};
  for (const rel of authorityLock.required_artifact_paths) {
    const headBytes = gitShowBuffer(repoRoot, head, rel);
    const workBytes = readWorktreeBuffer(repoRoot, rel);
    if (!headBytes.equals(workBytes)) {
      throw new Error(`G0_ARTIFACT_NOT_HEAD_BYTES: ${rel}`);
    }
    snapshotBuffers.set(rel, headBytes);
    artifactDigests[rel] = verifier.sha256Bytes(headBytes);
  }

  const expectedSeals = authorityLock.sealed_artifact_sha256;
  const expectedSealPaths = Object.keys(expectedSeals);
  if (expectedSealPaths.length === 0) throw new Error('G0_AUTHORITY_LOCK_SEAL_MAP_EMPTY');
  const declaredSealPaths = authorityLock.sealed_artifact_paths || [];
  if (!verifier.exactSetEquals(expectedSealPaths, declaredSealPaths)) {
    throw new Error('G0_AUTHORITY_LOCK_SEAL_SET_MISMATCH');
  }
  for (const rel of expectedSealPaths) {
    if (!snapshotBuffers.has(rel)) throw new Error(`G0_SEALED_ARTIFACT_NOT_LOCKED: ${rel}`);
    if (artifactDigests[rel] !== expectedSeals[rel]) {
      throw new Error(`G0_SEALED_ARTIFACT_DIGEST_MISMATCH: ${rel}`);
    }
  }

  assertLockedPathsClean(repoRoot, authorityLock.required_artifact_paths);

  return {
    repoRoot,
    head,
    authorityLock,
    authorityLockDigest: lockDigest,
    snapshotBuffers,
    artifactDigests
  };
}

function verifySnapshotStillCurrent(snapshot) {
  if (gitHead(snapshot.repoRoot) !== snapshot.head) {
    throw new Error('G0_HEAD_CHANGED_DURING_ACCEPTANCE');
  }
  for (const [rel, initialBytes] of snapshot.snapshotBuffers.entries()) {
    const current = readWorktreeBuffer(snapshot.repoRoot, rel);
    if (!current.equals(initialBytes)) {
      throw new Error(`G0_ARTIFACT_CHANGED_DURING_ACCEPTANCE: ${rel}`);
    }
  }
  assertLockedPathsClean(snapshot.repoRoot, snapshot.authorityLock.required_artifact_paths);
}

function loadSnapshotJson(snapshot, rel) {
  const buffer = snapshot.snapshotBuffers.get(rel);
  if (!buffer) throw new Error(`G0_ARTIFACT_NOT_IN_SNAPSHOT: ${rel}`);
  return parseJsonBuffer(buffer, rel);
}

function compile(schema) {
  return new Ajv2020({ allErrors:true, strict:true }).compile(schema);
}

function runG0Acceptance(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('runG0Acceptance requires a repository root path string');
  }

  const snapshot = captureRepositorySnapshot(root);
  const authorityLock = snapshot.authorityLock;
  const architecture = loadSnapshotJson(snapshot, 'contracts/gen-usearch/g0/G0-ARCHITECTURE-R3.1.machine.json');
  const traceability = loadSnapshotJson(snapshot, 'contracts/gen-usearch/g0/G0-TRACEABILITY-R3.1.json');
  const registry = loadSnapshotJson(snapshot, 'contracts/gen-usearch/g0/g0-contracts-r3.1.json');
  const failureRegistry = loadSnapshotJson(snapshot, 'contracts/gen-usearch/g0/failure-codes.json');
  const finalFixtures = loadSnapshotJson(snapshot, 'tests/gen-usearch/g0/fixtures/final-race-vectors.json');
  const invariantFixtures = loadSnapshotJson(snapshot, 'tests/gen-usearch/g0/fixtures/invariant-vectors.json');

  const schemaSpecs = [
    ['authority_lock', authorityLock, loadSnapshotJson(snapshot, AUTHORITY_LOCK_SCHEMA_PATH)],
    ['architecture', architecture, loadSnapshotJson(snapshot, 'contracts/gen-usearch/g0/G0-ARCHITECTURE-R3.1.schema.json')],
    ['traceability', traceability, loadSnapshotJson(snapshot, 'contracts/gen-usearch/g0/G0-TRACEABILITY-R3.1.schema.json')],
    ['registry', registry, loadSnapshotJson(snapshot, 'contracts/gen-usearch/g0/g0-contracts.schema.json')],
    ['failure_codes', failureRegistry, loadSnapshotJson(snapshot, 'contracts/gen-usearch/g0/failure-codes.schema.json')],
    ['final_fixtures', finalFixtures, loadSnapshotJson(snapshot, 'tests/gen-usearch/g0/fixtures/final-race-vectors.schema.json')],
    ['invariant_fixtures', invariantFixtures, loadSnapshotJson(snapshot, 'tests/gen-usearch/g0/fixtures/invariant-vectors.schema.json')]
  ];

  const schemaChecks = {};
  for (const [name, artifact, schema] of schemaSpecs) {
    const validate = compile(schema);
    schemaChecks[name] = validate(artifact) ? 'PASS' : 'FAIL';
  }

  const finalExecutions = finalFixtures.vectors.map(vector => {
    const actual = verifier.evaluateFixture(vector);
    return {
      id: vector.id,
      group: vector.group,
      matched_expected: isDeepStrictEqual(actual, vector.expected)
    };
  });

  const invariantExecutions = invariantFixtures.vectors.map(vector => {
    const actual = verifier.evaluateInvariant(registry, vector.invariant_id, vector.input);
    return {
      id: vector.id,
      invariant_id: vector.invariant_id,
      polarity: vector.polarity,
      matched_expected: isDeepStrictEqual(actual, vector.expected)
    };
  });

  const coverage = verifier.verifyCoverage(
    authorityLock, architecture, traceability, registry, failureRegistry, finalFixtures, invariantFixtures
  );

  const contracts = {};
  for (const contractId of authorityLock.required_contract_ids) {
    const invariantIds = registry.invariants
      .filter(item => item.contract === contractId)
      .map(item => item.id);
    const pass = invariantIds.length > 0 && invariantIds.every(invariantId => {
      const rows = invariantExecutions.filter(row => row.invariant_id === invariantId);
      return rows.length === 2 && rows.every(row => row.matched_expected === true);
    });
    contracts[contractId] = pass ? 'PASS' : 'FAIL';
  }

  const finalChecks = {};
  for (const group of authorityLock.required_final_checks) {
    const rows = finalExecutions.filter(row => row.group === group);
    finalChecks[group] = rows.length > 0 && rows.every(row => row.matched_expected === true)
      ? 'PASS'
      : 'FAIL';
  }

  const unresolved = [];
  for (const [name, result] of Object.entries(schemaChecks)) {
    if (result !== 'PASS') unresolved.push({severity:'P0_CORRECTNESS',code:`SCHEMA_${name.toUpperCase()}_FAILED`});
  }
  if (!coverage.ok) unresolved.push({severity:'P0_CORRECTNESS',code:'AUTHORITY_COVERAGE_MISMATCH'});

  for (const invariant of registry.invariants) {
    const rows = invariantExecutions.filter(row => row.invariant_id === invariant.id);
    if (rows.length !== 2 || rows.some(row => row.matched_expected !== true)) {
      unresolved.push({severity:invariant.severity,code:invariant.failure_code});
    }
  }
  for (const [group, result] of Object.entries(finalChecks)) {
    if (result !== 'PASS') unresolved.push({severity:'P0_CORRECTNESS',code:`${group}_FAILED`});
  }

  const unresolvedP0 = unresolved.filter(item => item.severity === 'P0_CORRECTNESS').length;
  const unresolvedP1 = unresolved.filter(item => item.severity === 'P1_ARCHITECTURE').length;

  const status =
    unresolvedP0 === 0 &&
    unresolvedP1 === 0 &&
    Object.values(schemaChecks).every(value => value === 'PASS') &&
    Object.values(contracts).every(value => value === 'PASS') &&
    Object.values(finalChecks).every(value => value === 'PASS') &&
    coverage.ok
      ? 'PASS'
      : 'FAIL';

  const manifest = {
    gate:'G0',
    contract_version:authorityLock.contract_version,
    authority_lock_digest:snapshot.authorityLockDigest,
    head_sha:snapshot.head,
    status,
    contracts,
    final_checks:finalChecks,
    schema_checks:schemaChecks,
    coverage:{
      required_architecture_requirements:authorityLock.required_architecture_requirement_ids,
      covered_architecture_requirements:coverage.covered_architecture_requirements,
      required_invariants:authorityLock.required_invariant_ids,
      covered_invariants:coverage.covered_invariants,
      required_failure_codes:authorityLock.required_failure_codes,
      present_failure_codes:failureRegistry.codes.map(item => item.code),
      required_final_fixtures:authorityLock.required_final_fixture_ids,
      executed_final_fixtures:finalExecutions.map(item => item.id),
      required_invariant_fixtures:authorityLock.required_invariant_fixture_ids,
      executed_invariant_fixtures:invariantExecutions.map(item => item.id)
    },
    unresolved_p0:unresolvedP0,
    unresolved_p1:unresolvedP1,
    artifact_digests:snapshot.artifactDigests,
    evidence:[
      `exact-head:${snapshot.head}`,
      `authority-lock:${snapshot.authorityLockDigest}`,
      `final-fixtures:${finalExecutions.length}`,
      `invariant-fixtures:${invariantExecutions.length}`,
      'schema-validation:ajv-2020',
      'artifact-binding:git-head-byte-exact'
    ]
  };

  const acceptanceSchema = loadSnapshotJson(snapshot, 'contracts/gen-usearch/g0/g0-acceptance.schema.json');
  const validateAcceptance = compile(acceptanceSchema);
  if (!validateAcceptance(manifest)) {
    const error = new Error('generated G0 acceptance manifest failed its schema');
    error.validation_errors = validateAcceptance.errors;
    throw error;
  }

  verifySnapshotStillCurrent(snapshot);
  return manifest;
}

if (require.main === module) {
  const root = path.resolve(__dirname, '../../..');
  const manifest = runG0Acceptance(root);
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
  process.exitCode = manifest.status === 'PASS' ? 0 : 1;
}

module.exports = {
  AUTHORITY_LOCK_PATH,
  repositoryTopLevel,
  captureRepositorySnapshot,
  runG0Acceptance
};
