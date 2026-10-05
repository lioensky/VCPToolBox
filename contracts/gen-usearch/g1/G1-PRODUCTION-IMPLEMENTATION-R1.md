# Gen-USearch G1 Production Implementation Contract R1

Status: **PASS**

G1 implements the durable production foundation required by the frozen G0 R3.1 architecture. It does not activate the generational search engine.

## In scope

- additive SQLite metadata schema for stable document/chunk/vector identity;
- durable signed-int64 vector allocator;
- independent `visibility_seq` and `manifest_epoch` counters;
- MVCC staging, physical-coverage admission gate, current-head CAS and retirement;
- exact recovery bytes for staged vectors;
- stable identity-only reconciliation derived from canonical committed source views;
- stale-plan, stale-source-revision and URI-race rejection;
- signed-int64-safe Vexus add/batch/search/remove/atomic-delta ABI;
- compatibility with upstream PR #486 Chunk generational baseline persistence;
- CI coverage for every G1 production surface and upstream baseline dependency.

## Deferred beyond G1

The following are deliberately **not** production-authorized by G1:

- a production writer for `gen_usearch_vector_coverage`;
- Gen0 MemTable coordination and ReadView pinning;
- immutable segment build/finalize/publish;
- authoritative manifest publication;
- query retrieval / current-head filtering;
- recovery release / GC execution;
- compaction;
- runtime serving ownership/cutover;
- `GENERATIONAL_ACTIVE` activation.

The `gen_usearch_vector_coverage` table is a reserved handoff surface. G1 tests seed it directly to test MVCC publication semantics; no G1 production module is authorized to manufacture physical-coverage facts. The production physical layer must own that admission in a later gate.

The MVCC lifecycle methods exposed by `GenUSearchMetadataStore` are also reserved handoff primitives during G1. G1 must not wire `GenUSearchMetadataStore`, `GenUSearchReconciliationService`, `stageVector()`, or `publishCurrentHead()` into the existing KnowledgeBase ingestion/search/serving path. That production wiring is a later-gate authority change and must explicitly update the stage boundary.

## G1 acceptance

G1 may pass only when:

- exact-head G1 CI is green;
- Rust key parser and built N-API ABI pass;
- metadata/MVCC tests pass;
- reconciliation tests pass;
- upstream #486 baseline compatibility regressions pass;
- G1 stage-boundary tests pass;
- independent adversarial review has unresolved P0 = 0 and P1 = 0.

G1 PASS does not authorize G2, upstream merge, or Ready-for-Review.

## Independent review closure

Exact-head reviewed implementation: `cab92b0b6957a1ab359c5a8ddbfbb4897ce42e24`.

Closed findings:

- key64 Chunk delta failure semantics were not fail-atomic; fixed with finite-vector preflight, affected-key rollback snapshot, and a no-mutation failure regression;
- crash durability could be disabled through an unused constructor option; the bypass was removed and WAL + FULL/EXTRA is now non-bypassable.

The apparent direct-current-head publication bypass was classified as a deferred-stage boundary rather than an active runtime defect: G1 exposes the low-level MVCC handoff primitive, but stage-boundary tests prohibit any existing KnowledgeBase ingestion/search/serving code from wiring it before G2 authority.

Final G1 independent review:

```text
unresolved P0 = 0
unresolved P1 = 0
G1 = PASS
G2 = NOT AUTHORIZED
```
