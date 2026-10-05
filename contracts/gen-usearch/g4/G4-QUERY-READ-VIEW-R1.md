# Gen-USearch G4 QueryReadView + Retrieval Contract R1

Status: **BOUNDARY_FROZEN / IMPLEMENTATION_ACTIVE**

G4 authorizes coherent read snapshots and isolated production retrieval on top of G1 logical MVCC, G2 Gen0 physical authority, and G3 immutable manifest authority. G4 does not authorize GC, compaction, reclaim, serving cutover, or engine-mode activation.

## In scope

G4 may implement only:

- coherent QueryReadView acquisition containing read_view_id, visibility_seq, metadata_snapshot, manifest_snapshot, memtable_generation_set, runtime_fence, created_at, and deadline;
- a single SQLite read transaction for logical metadata, manifest topology, coverage, and runtime-fence snapshot;
- provisional pinning of G2 MemTables and G3 manifest segments before a QueryReadView becomes usable;
- all-or-nothing acquisition with complete provisional-pin cleanup on failure;
- bounded deadlines where expiry requests cancellation but never releases pins;
- pin release only after explicit worker quiescence;
- isolated ANN retrieval over pinned immutable segments plus exact L2 scoring of snapshot-current MemTable vectors from exact durable recovery bytes;
- snapshot-current-head filtering using QueryReadView metadata authority;
- physical vector-ID deduplication across MEMTABLE/SEGMENT overlap;
- final runtime-fence validation immediately before returning a query response;
- read-only pin introspection needed by later GC/reclaim gates.

## Authority rules

1. One QueryReadView is one coherent logical/physical cut. Metadata, visibility_seq, manifest epoch/set, query-visible coverage, and runtime fence are captured in one SQLite read transaction.
2. Metadata snapshot is logical query authority. A physical vector is returnable only when the captured metadata snapshot says that exact vector is the ACTIVE current head for its chunk.
3. Pinned sources are physical candidate authority. MEMTABLE candidates must come from pinned G2 generations. SEGMENT candidates must come from pinned G3 PUBLISHED manifest members.
4. Every snapshot-current vector must have at least one captured QUERY_VISIBLE coverage row whose pinned source proves physical presence.
5. MEMTABLE/SEGMENT overlap is legal; retrieval deduplicates by canonical signed-int64 vector ID before ranking.
6. Physical presence never creates logical visibility. Stale/retired ANN hits are discarded.
7. Acquisition is all-or-nothing. Any validation failure cleans every provisional pin and returns no usable view.
8. Provisional pins participate in safety from the moment acquisition begins.
9. Deadline expiry requests cancellation but never releases pins.
10. Pins release only after explicit worker quiescence; early release fails READER_PIN_VIOLATION.
11. Runtime fence is checked at acquisition and again immediately before response.
12. G4 never acquires/transfers runtime ownership; it only verifies an existing SERVING owner/fence.
13. Every manifest artifact is re-proven on acquisition: PUBLISHED state, publisher-root path, SHA-256, native dimension/count, exact SEGMENT coverage, and exact native membership.
14. One retrieval uses one embedding fingerprint and one query dimension.
15. MemTable retrieval uses frozen exact recovery bytes captured for snapshot-current vectors while the G2 MemTable remains pinned as physical-existence authority.
16. QueryReadView public snapshot fields are immutable after acquisition; only lifecycle state may advance.

## Explicitly deferred beyond G4

G4 does not authorize:

- sealed MemTable retirement/reclaim;
- recovery-material release;
- vector GC;
- segment retirement/reclamation;
- compaction;
- runtime ownership acquisition/transfer/takeover;
- wiring into KnowledgeBaseManager, ingestion, existing searchService, or user-facing serving paths;
- GENERATIONAL_SHADOW or GENERATIONAL_ACTIVE;
- upstream merge or Ready-for-Review.

## G4 acceptance

G4 may pass only when:

- exact-head G1/G2/G3 regressions remain green;
- exact-head G4 CI is green;
- required QueryReadView fields are complete and immutable;
- coherent SQLite snapshot rejects sequence/manifest/fence divergence;
- current vectors without pinned physical coverage fail QUERY_READ_VIEW_PHYSICAL_GAP;
- failed acquisition cleans all provisional pins;
- expiry requests cancellation without releasing pins;
- release before worker quiescence fails;
- post-quiescence release drops every pin exactly once;
- retrieval filters by snapshot-current metadata and deduplicates MEMTABLE/SEGMENT overlap;
- stale runtime fence blocks response;
- artifact digest/dimension/count/membership corruption blocks acquisition;
- embedding/query-dimension mismatch fails closed;
- stage-boundary tests prove GC/compaction/reclaim/cutover remain unwired;
- independent adversarial review has unresolved P0 = 0 and P1 = 0.

G4 PASS does not authorize G5, upstream merge, Ready-for-Review, GC, compaction, reclaim, cutover, or engine activation.
