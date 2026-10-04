'use strict';

const FAILURE = Object.freeze({
  PHYSICAL_GAP: 'QUERY_READ_VIEW_PHYSICAL_GAP',
  STALE_COMPACTION: 'COMPACTION_PUBLICATION_STALE',
  SOURCE_DIVERGENCE: 'SOURCE_DIVERGENCE_DETECTED',
  RECOVERY_MISSING: 'VECTOR_RECOVERY_MATERIAL_MISSING',
  MANIFEST_SEGMENT_MISSING: 'MANIFEST_SEGMENT_MISSING'
});

function assertIntegerSequence(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function isAllowedTransition(registry, domain, from, to) {
  const transitions = registry.transitions?.[domain] || [];
  return transitions.some(pair => pair[0] === from && pair[1] === to);
}

function validatePhysicalCoverage(readView) {
  assertIntegerSequence(readView.visibility_seq, 'visibility_seq');
  const physical = new Set(readView.physical_vector_ids || []);
  const missing = (readView.current_vector_ids || []).filter(id => !physical.has(id));
  return missing.length === 0
    ? { ok: true }
    : { ok: false, code: FAILURE.PHYSICAL_GAP, missing_vector_ids: missing };
}

function flattenSources(sources) {
  const ids = [];
  for (const group of [sources?.memtables || {}, sources?.segments || {}]) {
    for (const values of Object.values(group)) ids.push(...values);
  }
  return [...new Set(ids)];
}

function validateFlushHandoff(currentVectorIds, sources) {
  return validatePhysicalCoverage({
    visibility_seq: 0,
    current_vector_ids: currentVectorIds,
    physical_vector_ids: flattenSources(sources)
  });
}

function compactionMustCopy(vector) {
  return !(vector?.state === 'GC_ELIGIBLE' && vector?.gc_eligible === true);
}

function validateCompactionPublish(inputManifestEpoch, currentManifestEpoch) {
  assertIntegerSequence(inputManifestEpoch, 'input_manifest_epoch');
  assertIntegerSequence(currentManifestEpoch, 'current_manifest_epoch');
  return inputManifestEpoch === currentManifestEpoch
    ? { ok: true }
    : { ok: false, code: FAILURE.STALE_COMPACTION };
}

function evaluateSourceObservation({ current_digest, observed_digest, reconciliation_state }) {
  if (current_digest !== observed_digest) {
    return { ok: true, needs_reconciliation: true, code: FAILURE.SOURCE_DIVERGENCE };
  }
  return {
    ok: true,
    needs_reconciliation: reconciliation_state !== 'COMPLETE'
  };
}

function validateRecoveryCoverage(vector) {
  if (vector?.durable_segment_coverage === true) return { ok: true };
  if (
    vector?.in_volatile_memtable === true &&
    ['VECTOR_STAGED', 'ACTIVE'].includes(vector?.state) &&
    vector?.has_exact_recovery_material === true &&
    vector?.recovery_state !== 'RECOVERY_RELEASED'
  ) {
    return { ok: true };
  }
  if (['VECTOR_STAGED', 'ACTIVE'].includes(vector?.state)) {
    return { ok: false, code: FAILURE.RECOVERY_MISSING };
  }
  return { ok: true };
}

function validateManifestSegments(manifestSegmentIds, durableSegmentIds) {
  const durable = new Set(durableSegmentIds || []);
  const missing = (manifestSegmentIds || []).filter(id => !durable.has(id));
  return missing.length === 0
    ? { ok: true }
    : { ok: false, code: FAILURE.MANIFEST_SEGMENT_MISSING, missing_segment_ids: missing };
}

function canGcLogicalVector(vector, readViews) {
  if (!['RETIRED', 'GC_ELIGIBLE'].includes(vector?.state)) return false;
  if (!Number.isSafeInteger(vector?.retired_visibility_seq)) return false;
  for (const view of readViews || []) {
    if (view.state === 'RELEASED') continue;
    if (Number.isSafeInteger(view.visibility_seq) && view.visibility_seq < vector.retired_visibility_seq) {
      return false;
    }
  }
  return true;
}

function canTakeoverServingOwnership(oldRuntime) {
  return oldRuntime?.may_execute === false &&
    oldRuntime?.quiescent === true &&
    oldRuntime?.serving === false;
}

function evaluateFixture(vector) {
  switch (vector.kind) {
    case 'physical_coverage':
      return validatePhysicalCoverage(vector.read_view);
    case 'flush_handoff':
      return validateFlushHandoff(vector.current_vector_ids, vector.sources);
    case 'compaction_copy':
      return { copy: compactionMustCopy(vector.vector) };
    case 'compaction_publish':
      return validateCompactionPublish(vector.input_manifest_epoch, vector.current_manifest_epoch);
    case 'source_observation':
      return evaluateSourceObservation(vector);
    case 'recovery_coverage':
      return validateRecoveryCoverage(vector.vector);
    case 'manifest_segments':
      return validateManifestSegments(vector.manifest_segment_ids, vector.durable_segment_ids);
    case 'logical_gc':
      return { can_gc: canGcLogicalVector(vector.vector, vector.read_views) };
    case 'runtime_takeover':
      return { can_takeover: canTakeoverServingOwnership(vector.old_runtime) };
    default:
      throw new Error(`Unknown fixture kind: ${vector.kind}`);
  }
}

function computeAcceptance({ contractStatuses, finalChecks, unresolvedP0, unresolvedP1 }) {
  const contractsPass = ['C1','C2','C3','C4','C5','C6','C7','C8']
    .every(id => contractStatuses[id] === 'PASS');
  const finalsPass = ['FINAL-01','FINAL-02','FINAL-03','FINAL-04','FINAL-05']
    .every(id => finalChecks[id] === 'PASS');
  return contractsPass && finalsPass && unresolvedP0 === 0 && unresolvedP1 === 0
    ? 'PASS'
    : 'FAIL';
}

module.exports = {
  FAILURE,
  isAllowedTransition,
  validatePhysicalCoverage,
  validateFlushHandoff,
  compactionMustCopy,
  validateCompactionPublish,
  evaluateSourceObservation,
  validateRecoveryCoverage,
  validateManifestSegments,
  canGcLogicalVector,
  canTakeoverServingOwnership,
  evaluateFixture,
  computeAcceptance
};
