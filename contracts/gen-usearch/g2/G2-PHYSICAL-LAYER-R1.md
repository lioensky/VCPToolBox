# Gen-USearch G2 Physical Layer Contract R1

Status: **BOUNDARY_FROZEN / IMPLEMENTATION_ACTIVE**

G2 authorizes the first production physical layer behind the frozen G0 contract and the G1 durable metadata/MVCC foundation.

## In scope

G2 may implement only:

- a runtime-local Gen0 MemTable backed by the signed-int64-safe Vexus key64 ABI;
- canonical runtime/generation source identity for Gen0;
- the sole production writer for `gen_usearch_vector_coverage` MEMTABLE facts;
- runtime bootstrap cleanup of stale MEMTABLE coverage before any new physical admission;
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

4. **Coverage writer is the sole G2 writer.**
   G2 production code outside `genUSearchPhysicalCoverageWriter.js` must not mutate `gen_usearch_vector_coverage`.

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
- durable coverage publication enables the existing G1 MVCC CAS path;
- removal order cannot leave a false coverage fact;
- G2 stage-boundary tests prove segment/manifest/query/GC/cutover remain unwired;
- independent adversarial review has unresolved P0 = 0 and P1 = 0.

G2 PASS does not authorize G3, upstream merge, Ready-for-Review, or engine activation.
