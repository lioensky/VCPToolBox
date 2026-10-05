# Gen-USearch G0 Architecture Authority R3.1

Status: **FROZEN**. This is the normative architecture authority for G0 Final Review.

## Authority planes

- Canonical source: content authority.
- SQLite: identity and lifecycle authority.
- SQLite manifest: physical topology authority.
- QueryReadView metadata snapshot: logical query authority.
- Pinned MemTables / immutable segments: physical candidate sources.
- Tombstone/cache state: derived and rebuildable only.

## Clocks

`visibility_seq` orders logical visibility mutations. `manifest_epoch` orders physical topology publication. They are monotonic and independent.

## QueryReadView

Every QueryReadView contains: `read_view_id`, `visibility_seq`, `metadata_snapshot`, `manifest_snapshot`, `memtable_generation_set`, `runtime_fence`, `created_at`, and `deadline`.

## R3.1 amendments

- **A01** source_observation_and_reconciliation_intent_commit_together_durably.
- **A02** index_only_committed_complete_source_view_and_missing_source_is_not_delete.
- **A03** critical_sqlite_transactions_are_crash_durable_before_ack.
- **A04** deadline_requests_cancellation_but_does_not_release_query_pins.
- **A05** query_pins_release_only_after_worker_quiescence.
- **A06** serving_ownership_is_exclusive_and_non_preemptive_in_r1.
- **A07** graceful_serving_transfer_requires_drain_before_release.
- **A08** crash_takeover_requires_proof_old_runtime_cannot_execute.
- **A09** read_view_acquisition_is_all_or_nothing_with_provisional_cleanup.
- **A10** provisional_acquisition_pins_participate_in_gc_safety.

## Normative requirements

- **G0-ARCH-001 / G0-XINV-001 / C2 / P0_CORRECTNESS**: doc_uri_change_does_not_change_doc_id.
- **G0-ARCH-002 / G0-XINV-002 / C1 / P0_CORRECTNESS**: slot_index_change_does_not_imply_chunk_id_change.
- **G0-ARCH-003 / G0-XINV-003 / C4 / P0_CORRECTNESS**: current_head_change_requires_mvcc_sqlite_cas.
- **G0-ARCH-004 / G0-XINV-004 / C4 / P0_CORRECTNESS**: logical_visibility_change_increments_visibility_seq.
- **G0-ARCH-005 / G0-XINV-005 / C6 / P0_CORRECTNESS**: physical_topology_change_increments_manifest_epoch.
- **G0-ARCH-006 / G0-XINV-006 / C6 / P0_CORRECTNESS**: visibility_seq_and_manifest_epoch_are_independent.
- **G0-ARCH-007 / G0-XINV-007 / C6 / P0_CORRECTNESS**: read_view_current_vectors_have_physical_coverage.
- **G0-ARCH-008 / G0-XINV-008 / C6 / P0_CORRECTNESS**: flush_handoff_allows_overlap_but_forbids_gap.
- **G0-ARCH-009 / G0-XINV-009 / C6 / P0_CORRECTNESS**: global_tombstone_cache_cannot_invalidate_snapshot_current_vector.
- **G0-ARCH-010 / G0-XINV-010 / C6 / P0_CORRECTNESS**: compaction_drops_only_machine_certified_gc_eligible_vectors.
- **G0-ARCH-011 / G0-XINV-011 / C5 / P0_CORRECTNESS**: manifest_references_only_verified_finalized_durable_segments.
- **G0-ARCH-012 / G0-XINV-012 / C4 / P0_CORRECTNESS**: volatile_current_vector_requires_exact_recovery_material.
- **G0-ARCH-013 / G0-XINV-013 / C2 / P0_CORRECTNESS**: source_observation_implies_durable_reconciliation_intent.
- **G0-ARCH-014 / G0-XINV-014 / C6 / P0_CORRECTNESS**: query_pins_release_only_after_worker_quiescence.
- **G0-ARCH-015 / G0-XINV-015 / C7 / P0_CORRECTNESS**: serving_ownership_is_exclusive_and_non_preemptive_in_r1.
- **G0-ARCH-016 / G0-XINV-016 / C6 / P1_ARCHITECTURE**: read_view_acquisition_is_all_or_nothing.
- **G0-ARCH-017 / G0-XINV-017 / C8 / P1_ARCHITECTURE**: shadow_failure_does_not_block_canonical_source_write.
- **G0-ARCH-018 / G0-XINV-018 / C8 / P1_ARCHITECTURE**: active_mode_does_not_silently_fallback_to_legacy.
- **G0-ARCH-019 / G0-XINV-019 / C3 / P0_CORRECTNESS**: vector_id_decimal_string_preserves_signed_int64_identity.
- **G0-ARCH-020 / G0-XINV-020 / C7 / P0_CORRECTNESS**: query_response_requires_current_runtime_fence.
- **G0-ARCH-021 / G0-XINV-021 / C3 / P0_CORRECTNESS**: vector_allocator_high_water_is_durable_monotonic_and_never_reuses.
- **G0-ARCH-022 / G0-XINV-022 / C7 / P0_CORRECTNESS**: recovery_material_releases_only_after_durable_segment_coverage.
- **G0-ARCH-023 / G0-XINV-023 / C6 / P0_CORRECTNESS**: compaction_snapshot_binds_manifest_epoch_visibility_seq_segment_set_and_gc_cut.
- **G0-ARCH-024 / G0-XINV-024 / C6 / P0_CORRECTNESS**: physical_presence_does_not_imply_logical_visibility.
- **G0-ARCH-025 / G0-XINV-025 / C6 / P0_CORRECTNESS**: multiple_physical_copies_dedup_to_one_logical_candidate.
- **G0-ARCH-026 / G0-XINV-026 / C6 / P1_ARCHITECTURE**: query_read_view_is_bounded_and_expiry_requests_cancellation_not_release.
- **G0-ARCH-027 / G0-XINV-027 / C2 / P1_ARCHITECTURE**: indexing_accepts_only_committed_complete_source_views.
- **G0-ARCH-028 / G0-XINV-028 / C1 / P1_ARCHITECTURE**: reconciler_is_identity_planning_only_and_cannot_mutate_lifecycle.
- **G0-ARCH-029 / G0-XINV-029 / C6 / P0_CORRECTNESS**: query_read_view_contains_coherent_metadata_manifest_memtable_and_fence_snapshot.
- **G0-ARCH-030 / G0-XINV-030 / C7 / P0_CORRECTNESS**: critical_transactions_are_crash_durable_before_ack_or_dependent_action.
- **G0-ARCH-031 / G0-XINV-031 / C2 / P0_CORRECTNESS**: missing_source_observation_does_not_imply_document_delete.

## Final race/crash checks

- FINAL-01 Query Acquisition × MVCC
- FINAL-02 MemTable Rotate × Flush
- FINAL-03 Compaction × Future Logical Publication
- FINAL-04 Crash Recovery
- FINAL-05 GC × Reader/Recovery Lifetime

Every normative requirement above must have exact machine traceability before G0 may be frozen.
