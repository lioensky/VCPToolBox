'use strict';

const crypto = require('node:crypto');

const UINT63_MAX = 9223372036854775807n;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const READ_VIEW_STATES = new Set(['ACQUIRING','ACTIVE','CANCEL_REQUESTED','QUIESCING','RELEASED']);

const FAILURE = Object.freeze({
  INVALID_VECTOR_ID: 'VECTOR_ID_INVALID',
  INVALID_TRANSITION: 'INVALID_MVCC_TRANSITION',
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

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256Text(text) {
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

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
  return ids.map((id, index) => {
    parseVectorId(id, `${name}[${index}]`);
    return id;
  });
}

function edgeExists(registry, domain, from, to) {
  const transitions = registry.transitions?.[domain] || [];
  return transitions.some(pair => pair[0] === from && pair[1] === to);
}

function validateTransition(registry, domain, from, to, evidence = {}) {
  if (!edgeExists(registry, domain, from, to)) {
    return { ok: false, code: FAILURE.INVALID_TRANSITION };
  }

  if (domain !== 'read_view_state') return { ok: true };

  const key = `${from}->${to}`;
  switch (key) {
    case 'ACQUIRING->RELEASED':
      return evidence.acquisition_failed === true &&
        evidence.provisional_pins_released === true &&
        evidence.active_read_view_published === false
        ? { ok: true }
        : { ok: false, code: FAILURE.READ_VIEW_INVALID };
    case 'ACTIVE->QUIESCING':
      return evidence.worker_completed === true || evidence.cancellation_requested === true
        ? { ok: true }
        : { ok: false, code: FAILURE.READ_VIEW_INVALID };
    case 'CANCEL_REQUESTED->QUIESCING':
      return evidence.worker_acknowledged_cancellation === true
        ? { ok: true }
        : { ok: false, code: FAILURE.READ_VIEW_INVALID };
    case 'QUIESCING->RELEASED':
      return evidence.worker_quiescent === true && evidence.pins_released === true
        ? { ok: true }
        : { ok: false, code: FAILURE.READER_PIN };
    default:
      return { ok: true };
  }
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
  } catch (_) {
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

function validateReadView(view) {
  if (!view || !READ_VIEW_STATES.has(view.state)) {
    return { ok: false, code: FAILURE.READ_VIEW_INVALID };
  }
  try { parseSequence(view.visibility_seq, 'read_view.visibility_seq'); }
  catch (_) { return { ok: false, code: FAILURE.READ_VIEW_INVALID }; }

  if (view.state === 'RELEASED') {
    return view.worker_quiescent === true && view.pins_released === true
      ? { ok: true }
      : { ok: false, code: FAILURE.READER_PIN };
  }
  if (view.pins_released === true) return { ok: false, code: FAILURE.READER_PIN };
  return { ok: true };
}

function deriveGcCertificate(retiredVector, readViews = []) {
  try {
    parseVectorId(retiredVector?.vector_id);
    if (retiredVector?.state !== 'RETIRED') return { certified: false, code: FAILURE.UNSAFE_GC };
    if (retiredVector?.is_current !== false || retiredVector?.retirement_durable !== true) {
      return { certified: false, code: FAILURE.UNSAFE_GC };
    }
    const retiredSeq = parseSequence(retiredVector.retired_visibility_seq, 'retired_visibility_seq');

    for (const view of readViews) {
      const validity = validateReadView(view);
      if (!validity.ok) return { certified: false, code: validity.code };
      if (view.state === 'RELEASED') continue;
      if (parseSequence(view.visibility_seq, 'read_view.visibility_seq') < retiredSeq) {
        return { certified: false };
      }
    }

    const certificate = {
      certificate_version: 1,
      source_state: 'RETIRED',
      vector_id: retiredVector.vector_id,
      retired_visibility_seq: retiredVector.retired_visibility_seq,
      retirement_durable: true,
      reader_cut_verified: true
    };
    certificate.proof_digest = sha256Text(JSON.stringify(certificate));
    return { certified: true, certificate };
  } catch (_) {
    return { certified: false, code: FAILURE.UNSAFE_GC };
  }
}

function validateGcEligibleTransition(retiredVector, postGcVector, certificate) {
  if (!certificate || certificate.source_state !== 'RETIRED') return false;
  if (retiredVector?.state !== 'RETIRED' || postGcVector?.state !== 'GC_ELIGIBLE') return false;
  if (retiredVector.vector_id !== postGcVector.vector_id || certificate.vector_id !== postGcVector.vector_id) return false;
  if (retiredVector.retired_visibility_seq !== postGcVector.retired_visibility_seq ||
      certificate.retired_visibility_seq !== postGcVector.retired_visibility_seq) return false;
  const body = {
    certificate_version: certificate.certificate_version,
    source_state: certificate.source_state,
    vector_id: certificate.vector_id,
    retired_visibility_seq: certificate.retired_visibility_seq,
    retirement_durable: certificate.retirement_durable,
    reader_cut_verified: certificate.reader_cut_verified
  };
  return certificate.proof_digest === sha256Text(JSON.stringify(body));
}

function compactionMustCopy(input) {
  if (input?.vector?.state !== 'GC_ELIGIBLE') return true;
  const proof = deriveGcCertificate(input.retired_vector, input.read_views || []);
  if (!proof.certified) return true;
  return !validateGcEligibleTransition(input.retired_vector, input.vector, proof.certificate);
}

function canGcLogicalVector(retiredVector, readViews) {
  const proof = deriveGcCertificate(retiredVector, readViews);
  if (proof.certified) return { can_gc: true, certificate: proof.certificate };
  return proof.code ? { can_gc: false, code: proof.code } : { can_gc: false };
}

function validateCompactionPublish(inputManifestEpoch, currentManifestEpoch) {
  try {
    return parseSequence(inputManifestEpoch, 'input_manifest_epoch') ===
      parseSequence(currentManifestEpoch, 'current_manifest_epoch')
      ? { ok: true }
      : { ok: false, code: FAILURE.STALE_COMPACTION };
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

function validateManifestSnapshot(snapshot) {
  try {
    parseSequence(snapshot?.manifest_epoch, 'manifest_epoch');
    if (!Array.isArray(snapshot?.segment_ids)) throw new Error('segment_ids');
    if (typeof snapshot?.embedding_fingerprint !== 'string' || !snapshot.embedding_fingerprint) throw new Error('fingerprint');
    return true;
  } catch (_) {
    return false;
  }
}

function validateArtifactReceipt(receipt) {
  return !!receipt &&
    typeof receipt.segment_id === 'string' &&
    /^[a-f0-9]{64}$/.test(receipt.artifact_digest || '') &&
    receipt.artifact_exists === true &&
    receipt.artifact_verified === true &&
    receipt.final_name_durable === true;
}

function validateManifestSegments(manifestSnapshot, segmentRecords, artifactReceipts) {
  if (!validateManifestSnapshot(manifestSnapshot)) {
    return { ok: false, code: FAILURE.SEGMENT_DURABILITY };
  }
  const records = new Map((segmentRecords || []).map(x => [x.segment_id, x]));
  const receipts = new Map((artifactReceipts || []).map(x => [x.segment_id, x]));
  const missing = [];
  const unproven = [];

  for (const id of manifestSnapshot.segment_ids) {
    const record = records.get(id);
    if (!record) {
      missing.push(id);
      continue;
    }
    const receipt = receipts.get(id);
    const recordValid =
      record.state === 'PUBLISHED' &&
      /^[a-f0-9]{64}$/.test(record.artifact_digest || '') &&
      record.embedding_fingerprint === manifestSnapshot.embedding_fingerprint &&
      Array.isArray(record.vector_ids);
    const receiptValid =
      validateArtifactReceipt(receipt) &&
      receipt.artifact_digest === record.artifact_digest;
    if (!recordValid || !receiptValid) unproven.push(id);
  }

  if (missing.length) return { ok: false, code: FAILURE.MANIFEST_SEGMENT_MISSING, missing_segment_ids: missing };
  if (unproven.length) return { ok: false, code: FAILURE.SEGMENT_DURABILITY, unproven_segment_ids: unproven };
  return { ok: true };
}

function deriveDurableVectorCoverage(vector, manifestSnapshot, segmentRecords, artifactReceipts) {
  try { parseVectorId(vector?.vector_id); } catch (_) { return false; }
  const manifestCheck = validateManifestSegments(manifestSnapshot, segmentRecords, artifactReceipts);
  if (!manifestCheck.ok) return false;

  const byId = new Map((segmentRecords || []).map(x => [x.segment_id, x]));
  return manifestSnapshot.segment_ids.some(id => {
    const record = byId.get(id);
    return record &&
      record.embedding_fingerprint === vector.embedding_fingerprint &&
      record.vector_ids.includes(vector.vector_id);
  });
}

function validateRecoveryCoverage(vector, manifestSnapshot, segmentRecords = [], artifactReceipts = [], recoveryMaterial = null) {
  try { parseVectorId(vector?.vector_id); }
  catch (_) { return { ok: false, code: FAILURE.INVALID_VECTOR_ID }; }

  if (deriveDurableVectorCoverage(vector, manifestSnapshot, segmentRecords, artifactReceipts)) {
    return { ok: true };
  }

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
      case 'G0-XINV-010': {
        if (input.drop !== true) { pass = true; break; }
        const proof = deriveGcCertificate(input.retired_vector, input.read_views || []);
        pass = proof.certified &&
          validateGcEligibleTransition(input.retired_vector, input.post_gc_vector, proof.certificate);
        break;
      }
      case 'G0-XINV-011':
        pass = validateManifestSegments(input.manifest_snapshot, input.segment_records, input.artifact_receipts).ok;
        break;
      case 'G0-XINV-012':
        pass = validateRecoveryCoverage(
          input.vector, input.manifest_snapshot, input.segment_records,
          input.artifact_receipts, input.recovery_material
        ).ok;
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
        pass = new Set(ids).size === input.expected_unique;
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
      return { copy: compactionMustCopy({
        vector: vector.post_gc_vector || vector.vector,
        retired_vector: vector.retired_vector,
        read_views: vector.read_views
      }) };
    case 'compaction_publish':
      return validateCompactionPublish(vector.input_manifest_epoch, vector.current_manifest_epoch);
    case 'source_observation':
      return evaluateSourceObservation(vector);
    case 'recovery_coverage':
      return validateRecoveryCoverage(
        vector.vector, vector.manifest_snapshot, vector.segment_records,
        vector.artifact_receipts, vector.recovery_material
      );
    case 'manifest_segments':
      return validateManifestSegments(vector.manifest_snapshot, vector.segment_records, vector.artifact_receipts);
    case 'logical_gc': {
      const result = canGcLogicalVector(vector.vector, vector.read_views);
      return result.can_gc ? { can_gc: true } :
        (result.code ? { can_gc:false, code:result.code } : { can_gc:false });
    }
    case 'runtime_takeover':
      return { can_takeover: canTakeoverServingOwnership(vector.old_runtime) };
    default:
      throw new Error(`Unknown fixture kind: ${vector.kind}`);
  }
}

function exactSetEquals(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
  const a = new Set(actual);
  return a.size === actual.length && expected.every(item => a.has(item));
}

function verifyCoverage(authorityLock, registry, failureRegistry, finalFixtures, invariantFixtures) {
  const failureCodes = failureRegistry.codes.map(item => item.code);
  const finalIds = finalFixtures.vectors.map(item => item.id);
  const invariantFixtureIds = invariantFixtures.vectors.map(item => item.id);
  const registryInvariantIds = registry.invariants.map(item => item.id);
  const coveredInvariants = [];

  for (const invariantId of authorityLock.required_invariant_ids) {
    const rows = invariantFixtures.vectors.filter(item => item.invariant_id === invariantId);
    const polarities = new Set(rows.map(item => item.polarity));
    if (rows.length === 2 && polarities.has('positive') && polarities.has('negative')) {
      coveredInvariants.push(invariantId);
    }
  }

  return {
    ok:
      registry.contract_version === authorityLock.contract_version &&
      failureRegistry.contract_version === authorityLock.contract_version &&
      finalFixtures.contract_version === authorityLock.contract_version &&
      invariantFixtures.contract_version === authorityLock.contract_version &&
      JSON.stringify(registry.enums) === JSON.stringify(authorityLock.critical_enums) &&
      exactSetEquals(registryInvariantIds, authorityLock.required_invariant_ids) &&
      exactSetEquals(failureCodes, authorityLock.required_failure_codes) &&
      exactSetEquals(finalIds, authorityLock.required_final_fixture_ids) &&
      exactSetEquals(invariantFixtureIds, authorityLock.required_invariant_fixture_ids) &&
      exactSetEquals(coveredInvariants, authorityLock.required_invariant_ids),
    covered_invariants: coveredInvariants
  };
}

module.exports = {
  UINT63_MAX,
  FAILURE,
  sha256Bytes,
  sha256Text,
  parseSequence,
  parseVectorId,
  validateVectorIdList,
  validateTransition,
  validatePhysicalCoverage,
  validateFlushHandoff,
  validateReadView,
  deriveGcCertificate,
  validateGcEligibleTransition,
  compactionMustCopy,
  canGcLogicalVector,
  validateCompactionPublish,
  evaluateSourceObservation,
  validateManifestSnapshot,
  validateArtifactReceipt,
  validateManifestSegments,
  deriveDurableVectorCoverage,
  validateRecoveryCoverage,
  canTakeoverServingOwnership,
  evaluateInvariant,
  evaluateFixture,
  exactSetEquals,
  verifyCoverage
};
