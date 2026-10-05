# Gen-USearch G4 QueryReadView + Retrieval Contract R1

Status: **PASS**

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
8. Provisional pins participate in safety from the moment acquisition begins. MemTables are pinned before their private physical snapshot is consumed; manifest segment pins are established inside the coherent SQLite read transaction before that transaction releases its snapshot.
9. Deadline expiry requests cancellation but never releases pins.
10. Pins release only after explicit worker quiescence; early release fails READER_PIN_VIOLATION.
11. Runtime fence is checked at acquisition and again immediately before response.
12. G4 never acquires/transfers runtime ownership; it only verifies an existing SERVING owner/fence.
13. Every manifest artifact is re-proven on acquisition: PUBLISHED state, publisher-root path, SHA-256, native dimension/count, exact SEGMENT coverage, and exact native membership.
14. One retrieval uses one embedding fingerprint and one query dimension.
15. MemTable retrieval uses frozen exact recovery bytes captured for snapshot-current vectors while the G2 MemTable remains pinned as physical-existence authority.
16. QueryReadView public snapshot fields are immutable after acquisition; only lifecycle state may advance.
17. Reader pins are enforceable physical safety authority. A G2 MemTable with any active or provisional QueryReadView pin cannot remove physical bytes; G2 removal fails READER_PIN_VIOLATION until the final reader reports worker quiescence and releases the pin.
18. Segment artifact identity is exact, not directory-local. A captured segment must resolve to the publisher-owned regular non-symlink path <segmentRoot>/<segment_id>.usearch; another file inside the same root cannot impersonate the segment even with identical bytes or digest.
19. Candidate source visibility is frozen at acquisition. A MEMTABLE candidate may contribute only when that exact MemTable source had captured QUERY_VISIBLE coverage for the vector. Hidden physical bytes cannot re-enter retrieval.
20. Acquisition deadlines apply during acquisition, not only after it. Deadline expiry at any validation stage fails QUERY_READ_VIEW_EXPIRED and releases all provisional pins without creating a usable view.
21. MemTable identity is database-bound. A caller cannot satisfy current-database MEMTABLE coverage by presenting a MemTable from another SQLite authority that happens to share the same runtime/generation source_id. G4 verifies the private writer-bound database identity before pinning.
22. Segment artifact verification is stable across native load. Exact publisher-owned path and SHA-256 are rechecked after Vexus load so a path/content substitution between preflight and load fails closed.
23. **Authority reads require SQLite autocommit state.** QueryReadView acquisition refuses any ambient SQLite transaction so an outer savepoint cannot export uncommitted metadata/coverage into a usable view. Final response-fence validation also refuses ambient transactions so a stale outer read snapshot cannot hide a newer committed runtime owner/fence.
24. **Current-head topology is complete and identity-bound.** Every non-null current_version_id is captured through LEFT JOIN authority and must resolve to an ACTIVE version owned by that exact chunk. Missing versions, missing document authority, or cross-chunk version substitution fail closed instead of disappearing from the metadata snapshot.
25. **Manifest membership is complete.** Every captured manifest member is preserved through LEFT JOIN authority. A manifest row whose segment metadata is missing must reach verification and fail RECOVERY_MANIFEST_INVALID; INNER JOIN omission cannot shrink the topology silently.
26. **Reader-pin release is capability-scoped.** Pin acquisition returns a private one-shot lease. No raw unpin API is exported, and a caller may release only leases it personally acquired. QueryReadView leases remain private until worker-quiescent release.
27. **MemTable database authority is G2-writer-private.** Only GenUSearchPhysicalCoverageWriter may bind a MemTable to a SQLite authority. G4 may verify this private binding but callers cannot self-bind a detached MemTable that happens to share runtime/generation/source_id.

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
- acquisition that expires mid-validation returns no view and cleans all provisional pins;
- expiry requests cancellation without releasing pins;
- active reader pins block G2 physical removal until worker quiescence;
- release before worker quiescence fails;
- post-quiescence release drops every pin exactly once;
- retrieval filters by snapshot-current metadata and deduplicates MEMTABLE/SEGMENT overlap;
- stale runtime fence blocks response;
- artifact digest/dimension/count/membership corruption blocks acquisition;
- artifact paths must match the exact publisher-owned segment identity and reject in-root aliases/symlinks;
- hidden MEMTABLE coverage cannot contribute candidates even when bytes remain physically present;
- a MemTable from another SQLite database cannot impersonate an identical runtime/generation source_id;
- acquisition from an ambient SQLite transaction is rejected before any provisional pin is created;
- final response-fence validation cannot run against an ambient stale SQLite read snapshot;
- a current head whose version is missing or belongs to another chunk fails closed instead of disappearing or being re-labeled;
- a manifest membership whose segment metadata is missing fails closed instead of disappearing from the snapshot;
- raw reader unpin capability is not exported and a lease cannot release another reader's pin;
- a detached MemTable cannot self-register database authority or impersonate a G2-writer-owned MemTable;
- artifact identity/digest are stable across native load, not only before it;
- embedding/query-dimension mismatch fails closed;
- stage-boundary tests prove GC/compaction/reclaim/cutover remain unwired;
- independent adversarial review has unresolved P0 = 0 and P1 = 0.

G4 PASS does not authorize G5, upstream merge, Ready-for-Review, GC, compaction, reclaim, cutover, or engine activation.

## Independent review closure

Exact-head reviewed implementation: `17dbf7a55dd9ac43182fbdafb94978f36c860b8f`.

Closed findings:

- QueryReadView acquisition could run inside an ambient SQLite transaction. Because better-sqlite3 nests `db.transaction()` as a savepoint, an uncommitted current head and QUERY_VISIBLE coverage could be captured into a view, the outer transaction could roll back, and the view could still return the never-committed vector. Acquisition now requires autocommit before any pin is created;
- final runtime-fence validation could run inside an ambient read transaction and observe a stale owner/fence after another connection committed a newer fence. Final fence validation now requires a fresh autocommit read;
- current-head snapshot used INNER JOIN semantics, allowing a missing current version to vanish from metadata. It now preserves every non-null head through LEFT JOIN authority and fails closed when version authority is missing;
- current-head identity did not prove that the referenced ACTIVE version belonged to the same chunk. Cross-chunk current-version substitution is now rejected explicitly;
- manifest acquisition used INNER JOIN semantics, allowing an existing manifest membership with missing segment metadata to disappear from `manifest_snapshot`. Manifest membership is now complete and missing segment metadata reaches verification and fails closed;
- reader pins exposed raw `unpinMemtable()` / `unpinSegment()`, allowing an unrelated caller to decrement a live QueryReadView pin, physically remove a retired vector, and leave the old view returning data whose physical source had been deleted. Pins are now private one-shot lease capabilities;
- MemTable database binding was publicly writable through ReadPins. A detached MemTable with an attacker-known mutation token, matching source_id, and copied vector could self-bind to the database and satisfy G4 physical authority. Database binding is now private to G2 PhysicalCoverageWriter, while G4 receives only a read-only verifier;
- cross-database MemTables sharing the same runtime/generation source_id remain rejected by writer-private database identity;
- provisional pins, acquisition deadlines, hidden MEMTABLE coverage, exact artifact identity, post-load artifact stability, runtime owner/fence checks, current-head filtering, and MEMTABLE/SEGMENT dedup all remain covered by adversarial regressions.

Final implementation evidence:

```text
G1 regression        = PASS
G2 regression        = PASS
G3 regression        = PASS
G4 exact-head gate   = PASS  (run 37300347530)

G4 adversarial tests = 24/24
G4 stage boundary    = 5/5

unresolved P0 = 0
unresolved P1 = 0
```

Final G4 decision:

```text
G4 = PASS
G5 = NOT AUTHORIZED
```

G4 PASS does not authorize G5 implementation, upstream merge, Ready-for-Review, GC, compaction, reclaim, runtime cutover, or engine activation.
