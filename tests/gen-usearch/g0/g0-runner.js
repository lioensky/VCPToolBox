'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const Ajv2020 = require('ajv/dist/2020').default;
const verifier = require('./g0-verifier');

function readText(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function loadJson(root, rel) {
  return JSON.parse(readText(root, rel));
}

function compile(schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(schema);
}

function runG0Acceptance(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('runG0Acceptance requires a repository root path string');
  }

  const authorityLockPath = 'contracts/gen-usearch/g0/g0-authority-lock.json';
  const authorityLock = loadJson(root, authorityLockPath);
  const registry = loadJson(root, 'contracts/gen-usearch/g0/g0-contracts-r3.1.json');
  const failureRegistry = loadJson(root, 'contracts/gen-usearch/g0/failure-codes.json');
  const finalFixtures = loadJson(root, 'tests/gen-usearch/g0/fixtures/final-race-vectors.json');
  const invariantFixtures = loadJson(root, 'tests/gen-usearch/g0/fixtures/invariant-vectors.json');

  const schemaSpecs = [
    ['authority_lock', authorityLock, loadJson(root, 'contracts/gen-usearch/g0/g0-authority-lock.schema.json')],
    ['registry', registry, loadJson(root, 'contracts/gen-usearch/g0/g0-contracts.schema.json')],
    ['failure_codes', failureRegistry, loadJson(root, 'contracts/gen-usearch/g0/failure-codes.schema.json')],
    ['final_fixtures', finalFixtures, loadJson(root, 'tests/gen-usearch/g0/fixtures/final-race-vectors.schema.json')],
    ['invariant_fixtures', invariantFixtures, loadJson(root, 'tests/gen-usearch/g0/fixtures/invariant-vectors.schema.json')]
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
    authorityLock, registry, failureRegistry, finalFixtures, invariantFixtures
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
    if (result !== 'PASS') unresolved.push({ severity:'P0_CORRECTNESS', code:`SCHEMA_${name.toUpperCase()}_FAILED` });
  }
  if (!coverage.ok) unresolved.push({ severity:'P0_CORRECTNESS', code:'AUTHORITY_COVERAGE_MISMATCH' });

  for (const invariant of registry.invariants) {
    const rows = invariantExecutions.filter(row => row.invariant_id === invariant.id);
    if (rows.length !== 2 || rows.some(row => row.matched_expected !== true)) {
      unresolved.push({ severity: invariant.severity, code: invariant.failure_code });
    }
  }
  for (const [group, result] of Object.entries(finalChecks)) {
    if (result !== 'PASS') unresolved.push({ severity:'P0_CORRECTNESS', code:`${group}_FAILED` });
  }

  const unresolvedP0 = unresolved.filter(item => item.severity === 'P0_CORRECTNESS').length;
  const unresolvedP1 = unresolved.filter(item => item.severity === 'P1_ARCHITECTURE').length;

  const headSha = execFileSync('git', ['rev-parse','HEAD'], { cwd: root, encoding:'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(headSha)) throw new Error('git HEAD is not a full SHA');

  const artifactDigests = {};
  for (const rel of authorityLock.required_artifact_paths) {
    artifactDigests[rel] = verifier.sha256Text(readText(root, rel));
  }
  const authorityLockDigest = artifactDigests[authorityLockPath];

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
    gate: 'G0',
    contract_version: authorityLock.contract_version,
    authority_lock_digest: authorityLockDigest,
    head_sha: headSha,
    status,
    contracts,
    final_checks: finalChecks,
    schema_checks: schemaChecks,
    coverage: {
      required_invariants: authorityLock.required_invariant_ids,
      covered_invariants: coverage.covered_invariants,
      required_failure_codes: authorityLock.required_failure_codes,
      present_failure_codes: failureRegistry.codes.map(item => item.code),
      required_final_fixtures: authorityLock.required_final_fixture_ids,
      executed_final_fixtures: finalExecutions.map(item => item.id),
      required_invariant_fixtures: authorityLock.required_invariant_fixture_ids,
      executed_invariant_fixtures: invariantExecutions.map(item => item.id)
    },
    unresolved_p0: unresolvedP0,
    unresolved_p1: unresolvedP1,
    artifact_digests: artifactDigests,
    evidence: [
      `exact-head:${headSha}`,
      `authority-lock:${authorityLockDigest}`,
      `final-fixtures:${finalExecutions.length}`,
      `invariant-fixtures:${invariantExecutions.length}`,
      'schema-validation:ajv-2020'
    ]
  };

  const acceptanceSchema = loadJson(root, 'contracts/gen-usearch/g0/g0-acceptance.schema.json');
  const validateAcceptance = compile(acceptanceSchema);
  if (!validateAcceptance(manifest)) {
    const error = new Error('generated G0 acceptance manifest failed its schema');
    error.validation_errors = validateAcceptance.errors;
    throw error;
  }

  return manifest;
}

if (require.main === module) {
  const root = path.resolve(__dirname, '../../..');
  const manifest = runG0Acceptance(root);
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
  process.exitCode = manifest.status === 'PASS' ? 0 : 1;
}

module.exports = { runG0Acceptance };
