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

6. **Crash durability is mandatory.**
   Coverage publication and bootstrap cleanup require SQLite WAL plus FULL/EXTRA synchronous durability.

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
    Current heads may be rehydrated only when every row is ACTIVE, has exact RECOVERY_REQUIRED bytes, and matches the target MemTable embedding fingerprint. Mixed or incomplete recovery input fails before coverage publication. Coverage is batch-published only after every physical add has exact native membership proof.

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
- startup recovery either restores every eligible current vector and batch-publishes coverage or fails closed without new authoritative coverage;
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
- startup ACTIVE-current recovery existed outside the frozen G2 contract and lacked acceptance coverage; it is now explicitly in scope and tested for complete recovery, incomplete recovery fail-closed, and mixed-fingerprint rejection before mutation;
- bootstrap, single publication, batch recovery publication, and hide trusted SQLite statement success without verifying authority postconditions; all four now read back their required post-state inside the same transaction and fail closed on silent trigger ignore/rewrite;
- writer identity based on connection/path could be split by hard-link aliases; device/inode identity is now authoritative when available;
- failed writer construction, forged source identities, removal metadata checks, embedding fingerprint isolation, active-generation handoff, and writer-only MemTable mutation authority are covered by exact G2 regressions.

Final G2 independent review:

```text
unresolved P0 = 0
unresolved P1 = 0
G2 = PASS
G3 = NOT AUTHORIZED
```
