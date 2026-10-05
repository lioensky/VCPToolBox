# Gen-USearch Architecture

Gen-USearch is the generational vector-index foundation for MemoChunk / RiverMemo. It is designed to add durable identity, crash-safe physical publication, coherent query snapshots, and GC safety without silently changing the existing user-facing KnowledgeBase serving path.

## Authority model

Gen-USearch separates authority by concern:

- **Canonical source** is the content authority.
- **SQLite metadata** is the stable identity and lifecycle authority.
- **SQLite manifest state** is the physical segment-topology authority.
- **QueryReadView metadata snapshot** is the logical query authority for a single read.
- **Pinned Gen0 MemTables and immutable segments** are physical candidate sources.
- Tombstone caches and other accelerators are derived state only.

Physical presence never creates logical visibility. A vector is returnable only when the captured metadata snapshot says that exact vector is the ACTIVE current head for its chunk.

## Independent clocks

Two monotonic clocks are intentionally independent:

- `visibility_seq` orders logical visibility mutations.
- `manifest_epoch` orders physical topology publication.

A logical head change advances visibility without requiring a topology change. A segment publication advances manifest topology without redefining logical current heads.

## Stable identity

Documents, chunks, and vectors have durable identities:

- moving a document URI does not change `doc_id`;
- moving a chunk slot does not by itself change `chunk_id`;
- `vector_id` is a canonical signed-int64 identity and is never represented through lossy JavaScript number semantics;
- the durable vector allocator is monotonic and does not reuse allocated IDs.

## Source reconciliation

Reconciliation is identity planning, not lifecycle mutation.

Indexing accepts only a committed, byte-stable, complete source view. Production admission uses the source provider's `withCommittedSourceView()` boundary so planning and durable reconciliation admission occur while the exact committed source view remains valid.

A source observation and its durable reconciliation intent are committed together. A missing source observation is not interpreted as a delete.

## MVCC lifecycle

Chunk-version lifecycle authority lives in SQLite.

The normal lifecycle is:

```text
PREPARED
  -> EMBEDDING
  -> VECTOR_STAGED
  -> ACTIVE
  -> RETIRED
  -> GC_ELIGIBLE
```

Early states may become `ABORTED`.

Current-head publication uses SQLite compare-and-swap semantics. Logical visibility changes advance `visibility_seq`. VECTOR_STAGED authority is not enough to become current: physical QUERY_VISIBLE coverage must already exist.

Critical authority writes require SQLite WAL plus synchronous FULL/EXTRA and reject ambient SQLite transactions when a nested savepoint could acknowledge authority before an outer transaction commits.

## Recovery material

Exact recovery bytes are retained for staged/current vectors until durable immutable-segment authority permits bounded release.

Important recovery states are:

```text
RECOVERY_REQUIRED
  -> SEGMENT_COVERED
  -> RECOVERY_RECLAIMABLE
  -> RECOVERY_RELEASED
```

RECOVERY_RELEASED requires the recovery blob to be cleared while retaining the covered segment identity as audit authority.

## Gen0 MemTable physical layer

Gen0 is a runtime-local native Vexus MemTable using signed-int64 key APIs.

Each MemTable has:

- one immutable source identity `gen0:<runtime-id>:<generation>`;
- one embedding fingerprint;
- one lifecycle: `ACTIVE -> SEALED_QUERY_VISIBLE`.

Physical coverage ordering is fail-closed:

```text
durable VECTOR_STAGED metadata
  -> native MemTable acceptance
  -> durable MEMTABLE QUERY_VISIBLE coverage
  -> optional logical current-head publication
```

Coverage is authoritative only after exact native membership has been proved.

Before physical removal, durable MEMTABLE coverage is hidden first. A crash may leave extra physical bytes, but must not leave false authoritative coverage.

### Writer ownership

The physical writer consumes existing runtime owner/fence authority and additionally holds a durable process lease. The lease binds exact:

- `owner_id`;
- `runtime_fence`;
- `process_token`.

A second process at the same fence cannot become an authoritative physical writer. Fence rollover invalidates the old writer. Gen-USearch does not itself authorize runtime takeover or fence advancement.

## Immutable segments and manifest publication

A sealed Gen0 generation may be rebuilt into an immutable native Vexus segment from exact durable recovery bytes.

Publication rules:

1. The sealed MemTable defines the physical candidate set.
2. Authoritative lifecycle state may exclude durable ABORTED members and narrowly proven already-covered released retired members.
3. One segment contains one embedding fingerprint.
4. Final artifact path is derived from segment identity under one explicit, pre-provisioned, non-symlink `segmentRoot`.
5. Artifact bytes are made durable before SQLite may publish topology authority.
6. SHA-256, native reload, dimension, count, exact key membership, and exact SEGMENT coverage are verified.
7. Manifest publication compares against the captured `manifest_epoch`.
8. One successful topology publication advances `manifest_epoch` exactly once.
9. The new manifest is the exact previous published segment set plus the newly published segment.
10. PUBLISHED state, manifest membership, SEGMENT QUERY_VISIBLE coverage, and recovery SEGMENT_COVERED transitions commit atomically.

MEMTABLE coverage remains during publication so flush handoff allows overlap but never a physical coverage gap.

On Windows, final segment replacement uses write-through semantics before SQLite can trust the artifact.

## QueryReadView

A QueryReadView captures one coherent logical/physical cut:

- `read_view_id`;
- `visibility_seq`;
- metadata snapshot;
- manifest snapshot;
- MemTable generation set;
- runtime owner/fence;
- `created_at`;
- bounded `deadline`.

Logical metadata, manifest topology, query-visible coverage, and runtime fence are captured from one SQLite snapshot.

### Physical pinning

Acquisition is all-or-nothing.

MemTables and manifest segments are provisionally pinned before a usable view is returned. Any validation failure releases provisional pins and returns no view.

Reader lifetime has two layers:

- durable `gen_usearch_read_view_leases` rows provide cross-process reader authority;
- process-local pin leases prevent physical removal inside the active process.

Cancellation is monotonic. Deadline expiry requests cancellation but never releases pins. `QUIESCING` admits no new query work. Pins release only after explicit worker quiescence.

### Retrieval

Candidates may come only from pinned sources captured by the QueryReadView.

- SEGMENT candidates come from PUBLISHED current-manifest members.
- MEMTABLE candidates come only from the captured QUERY_VISIBLE source/vector relation.
- MEMTABLE/SEGMENT overlap is legal and deduplicated by vector identity.
- stale/retired physical hits are filtered against the metadata snapshot.
- final response validation rechecks the current runtime fence and the read-view deadline.

## GC and recovery release

Gen-USearch currently authorizes logical GC eligibility and bounded recovery-material release, not physical compaction.

A RETIRED version may become GC_ELIGIBLE only when:

- it is no longer the current chunk head;
- its retirement visibility sequence is durable;
- no unreleased older QueryReadView can still observe it;
- recovery material has already reached RECOVERY_RELEASED.

ACTIVE, CANCEL_REQUESTED, and QUIESCING reader leases can block GC. Cancellation alone is never equivalent to release.

Recovery release requires re-proving the current durable segment:

- current manifest membership;
- PUBLISHED state;
- publisher-owned canonical path;
- SHA-256 digest;
- native dimension/count;
- exact SEGMENT coverage set;
- exact key membership;
- matching embedding fingerprint.

Certification and release are separate crash-durable transitions.

## Schema compatibility

Schema initialization is additive for current upstream databases.

Legacy Gen-USearch development schemas are handled explicitly:

- legacy reconciliation plans that cannot satisfy current base-identity invariants are invalidated/reset rather than silently trusted;
- legacy segment rows are repaired only when their topology can be proven safe;
- migration must not rewind authoritative manifest epochs or delete published manifest membership as a shortcut.

## Native ABI and packaged binaries

Gen-USearch depends on signed-int64 native Vexus methods including:

- `addKey64`;
- `addBatchKey64`;
- `containsKey64`;
- `searchKey64`;
- `removeKey64`;
- `applyChunkDeltaKey64`.

The repository tracks platform-specific native artifacts. CI verifies the committed artifact on Linux x64/arm64 (glibc and musl), macOS arm64, and Windows x64 without rebuilding it first. This prevents source-correct but package-stale releases.

## Current integration boundary

This change intentionally does not wire Gen-USearch into the existing user-facing serving path.

Out of scope:

- production wiring into existing `KnowledgeBaseManager`, ingestion, or current `searchService`;
- `GENERATIONAL_SHADOW` or `GENERATIONAL_ACTIVE` cutover;
- runtime ownership acquisition, transfer, or crash takeover orchestration;
- physical MemTable reclamation;
- segment compaction;
- segment retirement/reclamation;
- deletion of immutable segment artifacts.

Those operations require a separate integration/operational decision rather than being implied by the existence of the Gen-USearch primitives.
