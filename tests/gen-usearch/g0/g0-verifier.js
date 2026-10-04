'use strict';

const crypto = require('node:crypto');

const UINT63_MAX = 9223372036854775807n;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const READ_VIEW_STATES = new Set(['ACQUIRING','ACTIVE','CANCEL_REQUESTED','QUIESCING','RELEASED']);

const FAILURE = Object.freeze({
  INVALID_VECTOR_ID: 'VECTOR_ID_INVALID',
  PHYSICAL_GAP: 'QUERY_READ_VIEW_PHYSICAL_GAP',
  READ_VIEW_INVALID: 'QUERY_READ_VIEW_INVALID',
  READER_PIN: 'READER_PIN_VIOLATION',
  STALE_COMPACTION: 'COMPACTION_PUBLICATION_STALE',
  SOURCE_DIVERGENCE: 'SOURCE_DIVERGENCE_DETECTED',
  SOURCE_OBSERVATION_INVALID: 'SOURCE_OBSERVATION_INVALID',
  RECOVERY_MISSING: 'VECTOR_RECOVERY_MATERIAL_MISSING',
  MANIFEST_SEGMENT_MISSING: 'MANIFEST_SEGMENT_MISSING',
  SEGMENT_DURABILITY: 'SEGMENT_DURABILITY_UNPROVEN',
  UNSAFE_GC: 'UNSAFE_GC_ATTEMPT'
});

function parseCanonicalDecimal(value, { min = 0n, max = null, name = 'value' } = {}) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new Error(`${name} must be a canonical decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed < min || (max !== null && parsed > max)) {
    throw new Error(`${name} is outside the admitted range`);
  }
  return parsed;
}

function parseSequence(value, name = 'sequence') {
  return parseCanonicalDecimal(value, { min: 0n, name });
}

function parseVectorId(value, name = 'vector_id') {
  return parseCanonicalDecimal(value, { min: 1n, max: UINT63_MAX, name });
}

function validateVectorIdList(ids, name = 'vector_ids') {
  if (!Array.isArray(ids)) throw new Error(`${name} must be an array`);
  const canonical = ids.map((id, index) => {
    parseVectorId(id, `${name}[${index}]`);
    return id;
  });
  return canonical;
}

function isAllowedTransition(registry, domain, from, to) {
  const transitions = registry.transitions?.[domain] || [];
  return transitions.some(pair => pair[0] === from && pair[1] === to);
}

function validatePhysicalCoverage(readView) {
  try {
    parseSequence(readView?.visibility_seq, 'visibility_seq');
    const current = validateVectorIdList(readView?.current_vector_ids || [], 'current_vector_ids');
    const physical = new Set(validateVectorIdList(readView?.physical_vector_ids || [], 'physical_vector_ids'));
    const missing = current.filter(id => !physical.has(id));
    return missing.length === 0
      ? { ok: true }
      : { ok: false, code: FAILURE.PHYSICAL_GAP, missing_vector_ids: missing };
  } catch (error) {
    return { ok: false, code: FAILURE.READ_VIEW_INVALID };
  }
}

function flattenSources(sources) {
  const ids = [];
  for (const group of [sources?.memtables || {}, sources?.segments || {}]) {
    for (const values of Object.values(group)) {
      if (!Array.isArray(values)) throw new Error('physical source values must be arrays');
      ids.push(...values);
    }
  }
  return [...new Set(ids)];
}

function validateFlushHandoff(currentVectorIds, sources) {
  return validatePhysicalCoverage({
    visibility_seq: '0',
    current_vector_ids: currentVectorIds,
    physical_vector_ids: flattenSources(sources)
  });
}

function validateReleasedReadView(view) {
  if (!view || !READ_VIEW_STATES.has(view.state)) return { ok: false, code: FAILURE.READ_VIEW_INVALID };
  if (view.state === 'RELEASED') {
    if (view.worker_quiescent !== true || view.pins_released !== true) {
      return { ok: false, code: FAILURE.READER_PIN };
    }
    try { parseSequence(view.visibility_seq, 'read_view.visibility_seq'); }
    catch (_) { return { ok: false, code: FAILURE.READ_VIEW_INVALID }; }
    return { ok: true };
  }
  if (view.pins_released === true) return { ok: false, code: FAILURE.READER_PIN };
  try { parseSequence(view.visibility_seq, 'read_view.visibility_seq'); }
  catch (_) { return { ok: false, code: FAILURE.READ_VIEW_INVALID }; }
  return { ok: true };
}

function deriveGcCertificate(vector, readViews = []) {
  try {
    parseVectorId(vector?.vector_id);
    if (vector?.state !== 'GC_ELIGIBLE') return { certified: false, code: FAILURE.UNSAFE_GC };
    if (vector?.is_current !== false || vector?.retirement_durable !== true) {
      return { certified: false, code: FAILURE.UNSAFE_GC };
    }
    const retired = parseSequence(vector?.retired_visibility_seq, 'retired_visibility_seq');
    for (const view of readViews) {
      const validity = validateReleasedReadView(view);
      if (!validity.ok) return { certified: false, code: validity.code };
      if (view.state === 'RELEASED') continue;
      const visible = parseSequence(view.visibility_seq, 'read_view.visibility_seq');
      if (visible < retired) return { certified: false };
    }
    return { certified: true };
  } catch (_) {
    return { certified: false, code: FAILURE.UNSAFE_GC };
  }
}

function compactionMustCopy(vector, readViews = []) {
  return !deriveGcCertificate(vector, readViews).certified;
}

function validateCompactionPublish(inputManifestEpoch, currentManifestEpoch) {
  try {
    const input = parseSequence(inputManifestEpoch, 'input_manifest_epoch');
    const current = parseSequence(currentManifestEpoch, 'current_manifest_epoch');
    return input === current ? { ok: true } : { ok: false, code: FAILURE.STALE_COMPACTION };
  } catch (_) {
    return { ok: false, code: FAILURE.STALE_COMPACTION };
  }
}

function evaluateSourceObservation(input) {
  if (input.current_digest !== input.observed_digest) {
    return { ok: true, needs_reconciliation: true, code: FAILURE.SOURCE_DIVERGENCE };
  }
  if (input.reconciliation_state !== 'COMPLETE') {
    if (
      input.durable_reconciliation_intent !== true ||
      input.reconcile_target_revision !== input.observed_source_revision
    ) {
      return { ok: false, code: FAILURE.SOURCE_OBSERVATION_INVALID };
    }
    return { ok: true, needs_reconciliation: true };
  }
  return { ok: true, needs_reconciliation: false };
}

function segmentIsDurable(segment) {
  return !!segment &&
    ['FINALIZED_DURABLE','PUBLISHED'].includes(segment.state) &&
    segment.artifact_exists === true &&
    segment.artifact_verified === true &&
    segment.final_name_durable === true;
}

function validateManifestSegments(manifestSegmentIds, segments) {
  const byId = new Map((segments || []).map(segment => [segment.segment_id, segment]));
  const missing = [];
  const unproven = [];
  for (const id of manifestSegmentIds || []) {
    const segment = byId.get(id);
    if (!segment) missing.push(id);
    else if (!segmentIsDurable(segment)) unproven.push(id);
  }
  if (missing.length) return { ok: false, code: FAILURE.MANIFEST_SEGMENT_MISSING, missing_segment_ids: missing };
  if (unproven.length) return { ok: false, code: FAILURE.SEGMENT_DURABILITY, unproven_segment_ids: unproven };
  return { ok: true };
}

function deriveDurableVectorCoverage(vector, segments) {
  try { parseVectorId(vector?.vector_id); } catch (_) { return false; }
  return (segments || []).some(segment =>
    segmentIsDurable(segment) &&
    segment.state === 'PUBLISHED' &&
    segment.manifest_referenced === true &&
    Array.isArray(segment.vector_ids) &&
    segment.vector_ids.includes(vector.vector_id) &&
    segment.embedding_fingerprint === vector.embedding_fingerprint
  );
}

function validateRecoveryCoverage(vector, segments = [], recoveryMaterial = null) {
  try { parseVectorId(vector?.vector_id); } catch (_) { return { ok: false, code: FAILURE.INVALID_VECTOR_ID }; }
  if (deriveDurableVectorCoverage(vector, segments)) return { ok: true };

  if (['VECTOR_STAGED','ACTIVE'].includes(vector?.state) && vector?.in_volatile_memtable === true) {
    const validRecovery = recoveryMaterial &&
      recoveryMaterial.vector_id === vector.vector_id &&
      recoveryMaterial.embedding_fingerprint === vector.embedding_fingerprint &&
      recoveryMaterial.exact_vector_bytes === true &&
      recoveryMaterial.state !== 'RECOVERY_RELEASED';
    return validRecovery ? { ok: true } : { ok: false, code: FAILURE.RECOVERY_MISSING };
  }
  if (['VECTOR_STAGED','ACTIVE'].includes(vector?.state)) {
    return { ok: false, code: FAILURE.RECOVERY_MISSING };
  }
  return { ok: true };
}

function canGcLogicalVector(vector, readViews) {
  const certificate = deriveGcCertificate(vector, readViews);
  if (certificate.certified) return { can_gc: true };
  return certificate.code ? { can_gc: false, code: certificate.code } : { can_gc: false };
}

function canTakeoverServingOwnership(oldRuntime) {
  return oldRuntime?.may_execute === false &&
    oldRuntime?.quiescent === true &&
    oldRuntime?.serving === false;
}

function evaluateInvariant(registry, invariantId, input) {
  const meta = registry.invariants.find(item => item.id === invariantId);
  if (!meta) throw new Error(`Unknown invariant: ${invariantId}`);
  let pass = false;

  try {
    switch (invariantId) {
      case 'G0-XINV-001':
        pass = !input.uri_changed || input.before_doc_id === input.after_doc_id;
        break;
      case 'G0-XINV-002':
        pass = !input.slot_changed || input.before_chunk_id === input.after_chunk_id;
        break;
      case 'G0-XINV-003':
        pass = !input.current_head_changed || (input.via_sqlite_cas === true && input.durable_commit_confirmed === true);
        break;
      case 'G0-XINV-004':
        pass = !input.logical_visibility_changed || parseSequence(input.after) > parseSequence(input.before);
        break;
      case 'G0-XINV-005':
        pass = !input.physical_topology_changed || parseSequence(input.after) > parseSequence(input.before);
        break;
      case 'G0-XINV-006': {
        const l=input.logical_only, p=input.physical_only;
        pass =
          parseSequence(l.vis_after) > parseSequence(l.vis_before) &&
          parseSequence(l.epoch_after) === parseSequence(l.epoch_before) &&
          parseSequence(p.vis_after) === parseSequence(p.vis_before) &&
          parseSequence(p.epoch_after) > parseSequence(p.epoch_before);
        break;
      }
      case 'G0-XINV-007':
        pass = validatePhysicalCoverage(input).ok;
        break;
      case 'G0-XINV-008':
        pass = validateFlushHandoff(input.current_vector_ids, input.sources).ok;
        break;
      case 'G0-XINV-009':
        pass = !(input.snapshot_current === true && input.global_tombstone === true && input.discarded === true);
        break;
      case 'G0-XINV-010':
        pass = input.drop !== true || deriveGcCertificate(input.vector, input.read_views).certified;
        break;
      case 'G0-XINV-011':
        pass = validateManifestSegments(input.manifest_segment_ids, input.segments).ok;
        break;
      case 'G0-XINV-012':
        pass = validateRecoveryCoverage(input.vector, input.segments, input.recovery_material).ok;
        break;
      case 'G0-XINV-013':
        pass = !input.observed || (
          input.durable_reconciliation_intent === true &&
          input.reconcile_target_revision === input.observed_source_revision
        );
        break;
      case 'G0-XINV-014':
        pass = input.state !== 'RELEASED' || (input.worker_quiescent === true && input.pins_released === true);
        break;
      case 'G0-XINV-015':
        pass = !input.new_owner_started || canTakeoverServingOwnership(input.old_runtime);
        break;
      case 'G0-XINV-016':
        pass = !input.acquisition_failed || (
          input.provisional_pins_released === true &&
          input.active_read_view_published === false
        );
        break;
      case 'G0-XINV-017':
        pass = !input.shadow_failed || (
          input.canonical_write_success === true &&
          input.legacy_lifecycle_mutated === false
        );
        break;
      case 'G0-XINV-018':
        pass = !(input.mode === 'GENERATIONAL_ACTIVE' && input.engine_failed === true && input.legacy_fallback_used === true);
        break;
      case 'G0-XINV-019': {
        const ids = validateVectorIdList(input.vector_ids);
        const unique = new Set(ids);
        pass = unique.size === input.expected_unique;
        break;
      }
      default:
        throw new Error(`Unhandled invariant: ${invariantId}`);
    }
  } catch (_) {
    pass = false;
  }

  return pass ? { pass: true } : { pass: false, code: meta.failure_code };
}

function evaluateFixture(vector) {
  switch (vector.kind) {
    case 'physical_coverage':
      return validatePhysicalCoverage(vector.read_view);
    case 'flush_handoff':
      return validateFlushHandoff(vector.current_vector_ids, vector.sources);
    case 'compaction_copy':
      return { copy: compactionMustCopy(vector.vector, vector.read_views) };
    case 'compaction_publish':
      return validateCompactionPublish(vector.input_manifest_epoch, vector.current_manifest_epoch);
    case 'source_observation':
      return evaluateSourceObservation(vector);
    case 'recovery_coverage':
      return validateRecoveryCoverage(vector.vector, vector.segments, vector.recovery_material);
    case 'manifest_segments':
      return validateManifestSegments(vector.manifest_segment_ids, vector.segments);
    case 'logical_gc':
      return canGcLogicalVector(vector.vector, vector.read_views);
    case 'runtime_takeover':
      return { can_takeover: canTakeoverServingOwnership(vector.old_runtime) };
    default:
      throw new Error(`Unknown fixture kind: ${vector.kind}`);
  }
}

function exactSetEquals(actual, expected) {
  if (actual.length !== expected.length) return false;
  const a = new Set(actual);
  return a.size === actual.length && expected.every(item => a.has(item));
}

function verifyCoverage(registry, failureRegistry, finalFixtures, invariantFixtures) {
  const required = registry.acceptance;
  const failureCodes = failureRegistry.codes.map(item => item.code);
  const finalIds = finalFixtures.vectors.map(item => item.id);
  const invariantIds = invariantFixtures.vectors.map(item => item.id);
  const coveredInvariants = [];
  for (const invariantId of required.required_invariant_ids) {
    const rows = invariantFixtures.vectors.filter(item => item.invariant_id === invariantId);
    const polarities = new Set(rows.map(item => item.polarity));
    if (rows.length === 2 && polarities.has('positive') && polarities.has('negative')) coveredInvariants.push(invariantId);
  }
  return {
    ok:
      exactSetEquals(failureCodes, required.required_failure_codes) &&
      exactSetEquals(finalIds, required.required_final_fixture_ids) &&
      exactSetEquals(invariantIds, required.required_invariant_fixture_ids) &&
      exactSetEquals(coveredInvariants, required.required_invariant_ids),
    covered_invariants: coveredInvariants
  };
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function deriveAcceptance({
  registry,
  failureRegistry,
  finalFixtures,
  invariantFixtures,
  schemaChecks,
  finalExecutions,
  invariantExecutions,
  headSha,
  artifactDigests
}) {
  const coverageCheck = verifyCoverage(registry, failureRegistry, finalFixtures, invariantFixtures);
  const contracts = {};
  for (const contractId of registry.acceptance.required_contract_ids) {
    const required = registry.invariants.filter(item => item.contract === contractId).map(item => item.id);
    const ok = required.length > 0 && required.every(id => {
      const rows = invariantExecutions.filter(row => row.invariant_id === id);
      return rows.length === 2 && rows.every(row => row.matched_expected === true);
    });
    contracts[contractId] = ok ? 'PASS' : 'FAIL';
  }

  const finalChecks = {};
  for (const group of registry.acceptance.required_final_checks) {
    const rows = finalExecutions.filter(row => row.group === group);
    finalChecks[group] = rows.length > 0 && rows.every(row => row.matched_expected === true) ? 'PASS' : 'FAIL';
  }

  const schemaPass = Object.values(schemaChecks).every(value => value === 'PASS');
  const unresolved = [];
  if (!schemaPass) unresolved.push({ severity: 'P0_CORRECTNESS', code: 'SCHEMA_VALIDATION_FAILED' });
  if (!coverageCheck.ok) unresolved.push({ severity: 'P0_CORRECTNESS', code: 'COVERAGE_INCOMPLETE' });
  if (Object.values(contracts).some(value => value !== 'PASS')) unresolved.push({ severity: 'P0_CORRECTNESS', code: 'CONTRACT_EXECUTION_FAILED' });
  if (Object.values(finalChecks).some(value => value !== 'PASS')) unresolved.push({ severity: 'P0_CORRECTNESS', code: 'FINAL_CHECK_FAILED' });

  const unresolvedP0 = unresolved.filter(item => item.severity === 'P0_CORRECTNESS').length;
  const unresolvedP1 = unresolved.filter(item => item.severity === 'P1_ARCHITECTURE').length;
  const status = unresolvedP0 === 0 && unresolvedP1 === 0 ? 'PASS' : 'FAIL';

  return {
    gate: 'G0',
    contract_version: registry.contract_version,
    head_sha: headSha,
    status,
    contracts,
    final_checks: finalChecks,
    schema_checks: schemaChecks,
    coverage: {
      required_invariants: registry.acceptance.required_invariant_ids,
      covered_invariants: coverageCheck.covered_invariants,
      required_failure_codes: registry.acceptance.required_failure_codes,
      present_failure_codes: failureRegistry.codes.map(item => item.code),
      required_final_fixtures: registry.acceptance.required_final_fixture_ids,
      executed_final_fixtures: finalExecutions.map(item => item.id),
      required_invariant_fixtures: registry.acceptance.required_invariant_fixture_ids,
      executed_invariant_fixtures: invariantExecutions.map(item => item.id)
    },
    unresolved_p0: unresolvedP0,
    unresolved_p1: unresolvedP1,
    artifact_digests: artifactDigests,
    evidence: [
      `exact-head:${headSha}`,
      `final-fixtures:${finalExecutions.length}`,
      `invariant-fixtures:${invariantExecutions.length}`,
      'schema-validation:ajv-2020'
    ]
  };
}

function validateAcceptanceConsistency(manifest, registry) {
  if (manifest.status !== 'PASS') return { ok: true };
  const contracts = registry.acceptance.required_contract_ids.every(id => manifest.contracts?.[id] === 'PASS');
  const finals = registry.acceptance.required_final_checks.every(id => manifest.final_checks?.[id] === 'PASS');
  const schemas = Object.values(manifest.schema_checks || {}).every(value => value === 'PASS');
  const zero = manifest.unresolved_p0 === 0 && manifest.unresolved_p1 === 0;
  const evidence = Array.isArray(manifest.evidence) && manifest.evidence.length > 0;
  return contracts && finals && schemas && zero && evidence
    ? { ok: true }
    : { ok: false, code: 'FALSE_PASS_ACCEPTANCE' };
}

module.exports = {
  UINT63_MAX,
  FAILURE,
  parseSequence,
  parseVectorId,
  validateVectorIdList,
  isAllowedTransition,
  validatePhysicalCoverage,
  validateFlushHandoff,
  validateReleasedReadView,
  deriveGcCertificate,
  compactionMustCopy,
  validateCompactionPublish,
  evaluateSourceObservation,
  validateManifestSegments,
  deriveDurableVectorCoverage,
  validateRecoveryCoverage,
  canGcLogicalVector,
  canTakeoverServingOwnership,
  evaluateInvariant,
  evaluateFixture,
  exactSetEquals,
  verifyCoverage,
  sha256Text,
  deriveAcceptance,
  validateAcceptanceConsistency
};
