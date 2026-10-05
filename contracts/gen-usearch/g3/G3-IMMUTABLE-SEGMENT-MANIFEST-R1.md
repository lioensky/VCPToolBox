# Gen-USearch G3 Immutable Segment + Manifest Contract R1

Status: **BOUNDARY_FROZEN / IMPLEMENTATION_ACTIVE**

G3 authorizes durable immutable segment construction and authoritative manifest publication on top of G2 Gen0 physical authority. It does not authorize query serving, GC, compaction, or cutover.

## In scope

G3 may implement only:

- consuming a G2 `SEALED_QUERY_VISIBLE` Gen0 MemTable as the flush source identity;
- rebuilding an immutable native Vexus segment from exact durable recovery bytes for every vector in that sealed generation;
- one immutable embedding fingerprint per segment;
- durable segment artifact publication using the native Vexus atomic save path;
- SHA-256 artifact digest plus native reload and exact `containsKey64()` verification before SQLite finalization;
- segment state transition `BUILDING -> FINALIZED_DURABLE -> PUBLISHED`;
- manifest publication by compare-and-swap against the captured `manifest_epoch`;
- manifest publication as exact previous published segment set plus the newly published segment;
- SEGMENT `QUERY_VISIBLE` coverage written only in the same durable transaction that publishes the manifest;
- recovery transition from `RECOVERY_REQUIRED` to `SEGMENT_COVERED` only for vectors proven present in the published durable segment;
- preserving MEMTABLE coverage during publication so flush handoff has overlap and never a physical-coverage gap;
- fail-closed cleanup/retry semantics for unpublished BUILDING / FINALIZED_DURABLE work.

## Authority rules

1. **Artifact bytes precede logical topology.**
   No manifest or SEGMENT coverage may reference a segment until its final artifact pathname is durable, SHA-256 verified, reloadable by the authentic native Vexus implementation, and contains every expected signed-int64 key.

2. **Recovery bytes are the build authority.**
   Segment construction uses exact durable `gen_usearch_vector_recovery.vector_blob` bytes, not caller-supplied vectors and not reconstructed ANN results.

3. **Embedding spaces never mix.**
   Every flushed vector must have recovery fingerprint equal to the sealed Gen0 MemTable fingerprint. A mixed or incomplete source fails before artifact publication.

4. **The sealed MemTable defines the flush set.**
   G3 must build exactly the vector IDs exposed by the bound `SEALED_QUERY_VISIBLE` Gen0 generation. Duplicate, absent, or foreign IDs are rejected.

5. **Manifest publication is CAS.**
   A flush captures one `manifest_epoch`. Publication succeeds only if both the authoritative sequence and `gen_usearch_manifest_state` still equal that captured epoch. Stale publication fails with no topology mutation.

6. **One topology mutation increments manifest_epoch exactly once.**
   Successful publication advances the sequence and manifest state from N to N+1 in the same SQLite transaction.

7. **Manifest is an exact set, not an append log.**
   Epoch N+1 records the exact prior published segment set plus the new segment. The prior epoch remains immutable evidence.

8. **Segment coverage and manifest are atomic.**
   SEGMENT `QUERY_VISIBLE` coverage rows and the segment's `PUBLISHED` state are committed in the same transaction as manifest epoch publication.

9. **Recovery becomes SEGMENT_COVERED only after publication.**
   No recovery row may claim durable segment coverage while the segment is merely BUILDING or FINALIZED_DURABLE.

10. **Flush overlap is mandatory.**
    G3 does not delete or retire MEMTABLE coverage when publishing a segment. Reclaiming a sealed MemTable is a later gate.

11. **Artifact path is publisher-owned.**
    Callers cannot choose arbitrary final artifact paths. G3 derives final names under one configured segment root from a validated segment identity.

12. **Crash durability is mandatory.**
    Critical SQLite publication requires WAL + FULL/EXTRA. Artifact durability uses the native Vexus atomic save/fsync path and an explicit post-save digest/reload verification.

13. **SQLite mutation success requires postcondition proof.**
    FINALIZED_DURABLE and PUBLISHED transitions, manifest CAS, coverage insertion, and recovery transition are read back inside their transactions. Silent trigger ignore/rewrite is fail-closed.

14. **G3 remains physically isolated from serving.**
    G3 production modules must not wire themselves into KnowledgeBaseManager, ingestion, searchService, QueryReadView, runtime ownership, or engine-mode activation.

15. **The flush snapshot is private-authority data.**
    G3 derives state and vector IDs from GenUSearchMemTable private fields plus authentic native membership. Caller-visible `state` or `listVectorIds()` views cannot redefine the sealed flush set.

16. **Segment identity is database-namespaced.**
    The immutable segment identity includes the underlying SQLite database file identity (device/inode when available, canonical path fallback) in addition to Gen0 source identity, embedding fingerprint, and vector IDs, preventing cross-database artifact namespace collisions.

17. **SEGMENT coverage is an exact set.**
    After publication, SEGMENT `QUERY_VISIBLE` coverage for the new segment must equal the immutable artifact vector-ID set exactly. Extra or missing coverage rolls back the entire manifest transaction.

18. **Recovery transition is an exact set.**
    Only vectors that entered publication in `RECOVERY_REQUIRED` may become newly covered by the new segment. Trigger-injected or missing `covered_segment_id` transitions fail closed.

19. **Prior manifest epochs are immutable evidence.**
    Publishing epoch N+1 must leave epoch N's exact segment set unchanged. Every member of N+1 is revalidated as `PUBLISHED` with a still-matching durable artifact digest before commit.

20. **Idempotent retry revalidates authority, not status alone.**
    Reusing a PUBLISHED segment requires re-verifying the full current manifest artifact set and exact SEGMENT coverage before returning success.

## Explicitly deferred beyond G3

G3 does **not** authorize:

- QueryReadView acquisition or pinning;
- production ANN retrieval/current-head filtering;
- retiring or reclaiming sealed MemTables;
- recovery release / GC;
- segment retirement/reclamation;
- compaction;
- runtime serving ownership/cutover;
- wiring Gen-USearch into KnowledgeBaseManager, file ingestion, searchService, or serving paths;
- `GENERATIONAL_SHADOW` or `GENERATIONAL_ACTIVE` activation.

## G3 acceptance

G3 may pass only when:

- exact-head G1 and G2 regressions remain green;
- exact-head G3 CI is green;
- segment artifact is built from exact recovery bytes only;
- final artifact digest is SHA-256 verified;
- authentic native reload verifies every expected key before FINALIZED_DURABLE;
- stale manifest CAS cannot publish;
- one successful publication advances `manifest_epoch` exactly once;
- manifest epoch N+1 equals prior segment set plus the new segment;
- SEGMENT coverage cannot exist without a PUBLISHED manifest member;
- recovery cannot become SEGMENT_COVERED before successful publication;
- MEMTABLE coverage remains after segment publication;
- publication failure leaves no false PUBLISHED state, manifest membership, SEGMENT coverage, or SEGMENT_COVERED recovery;
- forged public MemTable views cannot alter the private sealed flush set;
- different SQLite databases cannot collide on the same segment identity when sharing an artifact root;
- trigger-injected extra SEGMENT coverage or recovery transitions fail closed;
- publishing a new epoch cannot mutate prior manifest evidence or silently retire an existing manifest member;
- corruption of any artifact in the current manifest blocks publication of the next epoch;
- idempotent retry detects missing SEGMENT coverage or corrupt manifest artifacts;
- G3 stage-boundary tests prove query/GC/compaction/cutover remain unwired;
- independent adversarial review has unresolved P0 = 0 and P1 = 0.

G3 PASS does not authorize G4, upstream merge, Ready-for-Review, query serving, or engine activation.
