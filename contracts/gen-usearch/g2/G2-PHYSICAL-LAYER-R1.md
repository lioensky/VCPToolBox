# Gen-USearch G2 Physical Layer Contract R1

Status: **PASS**

G2 authorizes the first production physical layer behind the frozen G0 contract and the G1 durable metadata/MVCC foundation.

## In scope

G2 may implement only:

- a runtime-local Gen0 MemTable backed by the signed-int64-safe Vexus key64 ABI;
- canonical runtime/generation source identity for Gen0;
- the sole production writer for `gen_usearch_vector_coverage` MEMTABLE facts;
- runtime bootstrap cleanup of stale MEMTABLE coverage before any new physical admission;
- startup rehydration of durable ACTIVE current vectors from exact recovery bytes into one fingerprint-bound Gen0 MemTable, followed by atomic MEMTABLE coverage publication;
- fail-closed staging order: metadata VECTOR_STAGED -> physical MemTable acceptance -> durable QUERY_VISIBLE coverage;
- safe rollback/hiding when physical admission or coverage publication fails;
- explicit sealing of an ACTIVE MemTable into `SEALED_QUERY_VISIBLE`;
- tests proving G1 `publishCurrentHead()` cannot succeed before authoritative G2 physical coverage exists.

## Authority rules

1. **Physical presence does not create logical visibility.**
   G2 may create `QUERY_VISIBLE` physical coverage, but only G1 MVCC may make a vector the current logical head.

2. **MEMTABLE coverage is volatile-runtime authority.**
   A new runtime must delete all pre-existing `source_kind='MEMTABLE'` coverage before admitting any new MemTable fact. No caller may bypass this bootstrap gate.

3. **Coverage follows physical acceptance.**
   A `QUERY_VISIBLE` MEMTABLE coverage row may be committed only after the exact signed-int64 vector key has been accepted by the bound MemTable.

4. **Coverage writer is the sole G2 physical mutation authority.**
   G2 production code outside `genUSearchPhysicalCoverageWriter.js` must not mutate `gen_usearch_vector_coverage`. Bound MemTable add/remove/seal operations require a private writer capability and cannot be performed directly by callers.

5. **Removal hides authority before removing bytes.**
   For non-current/non-ACTIVE vectors, G2 must durably remove the coverage fact before deleting the vector from the volatile MemTable. A crash may leave extra physical bytes, never false logical coverage.

6. **Crash durability and autocommit are mandatory.**
   Coverage publication, hide/removal, batch publication, and bootstrap cleanup require SQLite WAL plus FULL/EXTRA synchronous durability and must start from SQLite autocommit state. An ambient outer transaction is rejected before any native MemTable mutation or durable coverage mutation can occur.

7. **Generation identity is explicit.**
   Each MemTable has one immutable `source_id = gen0:<runtime-id>:<generation>` and one state machine:
   `ACTIVE -> SEALED_QUERY_VISIBLE`.
   G2 does not authorize later flush/segment states.

8. **Embedding spaces never mix.**
   Each MemTable has one immutable embedding fingerprint. A staged vector may enter that MemTable only when its durable metadata fingerprint matches exactly, even when dimensions are equal.

9. **Only one ACTIVE generation may receive writes per physical writer.**
   A later Gen0 generation may begin admission only after the previously bound ACTIVE MemTable has transitioned to `SEALED_QUERY_VISIBLE`.

10. **Source identity is one-to-one.**
    A writer may create each `gen0:<runtime-id>:<generation>` source identity at most once. Detached or duplicate MemTables cannot manufacture or mutate authoritative coverage.

11. **One database has one live G2 physical writer in-process.**
    A second writer for the same underlying SQLite database file is rejected even when opened through a different connection or filesystem alias. File identity uses device/inode when available and canonical path only as fallback, so symlink/hard-link aliases cannot split authority.

12. **Startup recovery is all-or-nothing for authority.**
    Current heads may be rehydrated only when every row is ACTIVE, retains exact recovery bytes, is in RECOVERY_REQUIRED or SEGMENT_COVERED, and matches the target MemTable embedding fingerprint. SEGMENT_COVERED current vectors are rehydrated into the new Gen0 together with newer RECOVERY_REQUIRED current vectors so a prior flush cannot block recovery of later writes. Mixed fingerprints, released/missing bytes, or unsupported recovery states fail before coverage publication. Coverage is batch-published only after every physical add has exact native membership proof.

13. **Native membership, not JavaScript bookkeeping, proves physical acceptance.**
    A Gen0 add/remove is authoritative only when the native key64 revision advances exactly once and exact `containsKey64()` confirms the expected post-state. JS-side sets alone cannot manufacture coverage.

14. **SQLite mutation success is proven by postcondition inside the same transaction.**
    Bootstrap cleanup must verify zero remaining MEMTABLE coverage, publication must read back `QUERY_VISIBLE`, batch publication must verify every row, and hide must verify the authoritative coverage row is absent before any physical delete proceeds. Silent trigger ignore/rewrite is fail-closed.

15. **Physical engine identity is native-bound.**
    A Gen0 MemTable may publish authority only when its backing object is an authentic `rust-vexus-lite.VexusIndex` native instance. Arbitrary JavaScript classes cannot impersonate the physical index even if they forge revision or membership responses.

## Explicitly deferred beyond G2

G2 does **not** authorize:

- immutable segment build/finalize/publish;
- authoritative manifest publication or manifest epoch mutation by the physical layer;
- QueryReadView acquisition/pinning;
- production search/retrieval or current-head filtering;
- recovery release / GC;
- compaction;
- runtime serving ownership/cutover;
- wiring Gen-USearch into `KnowledgeBaseManager`, `searchService`, ingestion, or serving paths;
- `GENERATIONAL_SHADOW` or `GENERATIONAL_ACTIVE` activation.

## G2 acceptance

G2 may pass only when:

- exact-head G1 regression remains green;
- exact-head G2 CI is green;
- MemTable lifecycle and signed-int64 identity tests pass;
- stale volatile coverage is purged before admission;
- coverage cannot be forged for a vector absent from the bound MemTable;
- coverage cannot be admitted for an unknown or non-staged vector version;
- physical admission failure leaves no QUERY_VISIBLE coverage;
- ambient SQLite transactions cannot wrap G2 physical mutation so database rollback cannot resurrect coverage after irreversible native removal;
- startup recovery restores mixed RECOVERY_REQUIRED and SEGMENT_COVERED ACTIVE current vectors into the new Gen0 and batch-publishes MEMTABLE coverage, or fails closed without new authoritative coverage;
- mixed embedding fingerprints cannot be recovered into one Gen0 MemTable;
- two connections to the same database file cannot obtain concurrent G2 writer authority;
- native revision changes without exact key membership cannot manufacture coverage;
- silent SQLite ignore/rewrite of bootstrap, publication, batch publication, or hide operations cannot produce a successful authority transition;
- arbitrary JavaScript index implementations cannot impersonate the native Vexus physical source;
- durable coverage publication enables the existing G1 MVCC CAS path;
- removal order cannot leave a false coverage fact;
- G2 stage-boundary tests prove segment/manifest/query/GC/cutover remain unwired;
- independent adversarial review has unresolved P0 = 0 and P1 = 0.

G2 PASS does not authorize G3, upstream merge, Ready-for-Review, or engine activation.

## Independent review closure

Exact-head reviewed implementation: `6284334e635687dcff51a3b6d2df4914adde0949`.

Closed findings:

- duplicate G2 writer authority could be acquired through separate SQLite connections to the same database file; authority is now bound to underlying file identity and rejects symlink/hard-link aliases;
- JavaScript bookkeeping and native revision alone could falsely attest physical presence; authoritative add/remove now requires exact native `containsKey64()` post-state and an authentic `rust-vexus-lite.VexusIndex` instance;
- startup ACTIVE-current recovery existed outside the frozen G2 contract and lacked acceptance coverage; it is now explicitly in scope and tested for complete recovery, incomplete recovery fail-closed, mixed-fingerprint rejection before mutation, and restart recovery after a prior segment publication without blocking later unflushed current vectors;
- bootstrap, single publication, batch recovery publication, and hide trusted SQLite statement success without verifying authority postconditions; all four now read back their required post-state inside the same transaction and fail closed on silent trigger ignore/rewrite;
- post-Ready-for-Review hardening found that an ambient outer SQLite transaction could roll back QUERY_VISIBLE coverage after native bytes had already been removed; every G2 physical mutation now rejects ambient transactions before touching native or durable physical authority;
- writer identity based on connection/path could be split by hard-link aliases; device/inode identity is now authoritative when available;
- failed writer construction, forged source identities, removal metadata checks, embedding fingerprint isolation, active-generation handoff, and writer-only MemTable mutation authority are covered by exact G2 regressions.

Final G2 independent review:

```text
unresolved P0 = 0
unresolved P1 = 0
G2 = PASS
G3 = NOT AUTHORIZED
```


## Ready-for-Review Remediation 2

Reviewed implementation head: `8fef6d31d4ed8ac71a6d625562c8e079997252c0`.

A second independent review found that G2 physical mutation could still begin under an ambient better-sqlite3 transaction. In particular, a later outer rollback could resurrect `QUERY_VISIBLE` coverage after native bytes had already been removed.

Closure:

- G2 writer construction now requires SQLite autocommit state before in-process writer authority can be claimed;
- `createMemTable()`, `sealMemTable()`, `admitVector()`, `recoverCurrentVectors()`, and `hideAndRemoveVector()` reject ambient transactions before runtime/native mutation;
- `_criticalWrite()` independently rechecks autocommit before durable physical authority mutation;
- regression proves ambient hide/remove cannot produce DB/native split-brain;
- regression proves ambient admission cannot touch native bytes;
- regression proves failed ambient writer construction does not poison later valid writer construction.

Exact-head evidence:

```text
G1 Production       37312732718  SUCCESS
G2 Physical Layer   37312659683  SUCCESS

G2 physical acceptance = 31/31
G2 stage boundary      = 6/6
```

This remediation does not authorize runtime cutover, engine activation, Ready-for-Review merge, or upstream merge.


## Clean-Room Remediation 3 Authority Amendments

G2 physical-writer exclusivity is now **cross-process durable authority**, not merely an in-process registry:

- one SQLite database/runtime fence may have only one `gen_usearch_runtime_process_lease`;
- the lease is keyed by exact `owner_id + runtime_fence + process_token`;
- a second OS process at the same fence cannot construct authoritative G2 writer state or purge MEMTABLE coverage;
- a replacement process may claim the lease only after authoritative `runtime_fence` rollover;
- every bootstrap/coverage mutation rechecks the durable process lease and current runtime ownership/fence inside the authoritative path;
- process-local WeakMap/Map guards remain optimization/integrity checks only and cannot override durable fencing;
- an old writer becomes fail-closed after fence rollover.

Crash takeover proof and the act of advancing runtime ownership/fence remain outside G2; G2 only consumes the resulting fenced authority. This does not authorize runtime cutover or engine activation.


## Clean-Room Remediation 4

A fresh clean-room review of implementation head `3e89a943c43e8e6544cc10e91cc5ff11f83f57df` found one remaining G2 owner-validation bypass.

Closure:

- `serving_state = IDLE` no longer disables owner validation when `owner_id` is explicitly populated;
- an IDLE row may be consumed without an owner match only when `owner_id IS NULL`, preserving unowned pre-serving bootstrap without allowing runtime B to impersonate runtime A;
- an explicitly owned IDLE row requires the exact same `runtimeId`;
- exact runtime-fence and durable process-token checks remain mandatory after construction;
- a new regression proves an IDLE row owned by runtime A cannot be claimed by runtime B and creates no process lease.

This remains consumption of existing runtime authority. G2 still does not acquire runtime ownership, advance a fence, perform cutover, or activate the generational engine.
