# Gen-USearch G5 GC Safety + Recovery Release Contract R1

Status: **PASS**

G5 authorizes machine-certified logical GC eligibility and bounded recovery-material release on top of G4 QueryReadView safety. It does not authorize physical compaction, segment retirement/reclamation, MemTable reclamation, runtime cutover, or engine activation.

## In scope

G5 may implement only:

- a read-only global safety snapshot of live QueryReadViews for the same SQLite authority;
- explicit QueryReadView QUIESCING lifecycle needed by FINAL-05 GC safety;
- RETIRED -> GC_ELIGIBLE certification only when no unreleased older QueryReadView can still observe the retired version;
- SEGMENT_COVERED -> RECOVERY_RECLAIMABLE certification only for a non-current RETIRED vector whose covered segment is still a verified current manifest member;
- RECOVERY_RECLAIMABLE -> RECOVERY_RELEASED only after re-proving the durable segment artifact and exact vector membership;
- clearing released recovery vector_blob bytes in the same crash-durable SQLite transaction that records RECOVERY_RELEASED;
- exact postcondition checks for every G5 state transition;
- machine-readable evidence needed by the later compaction/reclaim gate.

## Authority rules

1. **GC eligibility is logical authority only.**
   G5 may mark a RETIRED version GC_ELIGIBLE. It may not delete vector bytes, remove SEGMENT coverage, rewrite immutable segment artifacts, or publish a compaction manifest.

2. **Old live readers block GC.**
   A live ACTIVE, CANCEL_REQUESTED, or QUIESCING QueryReadView whose visibility_seq is older than the vector's retired_visibility_seq blocks RETIRED -> GC_ELIGIBLE.

3. **Cancelled is not released.**
   Cancellation alone never permits GC. A reader stops blocking only after worker quiescence, pin release, and RELEASED lifecycle completion.

4. **Newer readers do not pin retired logical history.**
   A live view with visibility_seq >= retired_visibility_seq does not block that retired version's logical GC certification.

5. **Malformed reader authority fails closed.**
   Missing/invalid visibility sequence, impossible live lifecycle, or a live record claiming pins already released fails QUERY_READ_VIEW_INVALID rather than permitting GC.

6. **GC requires exact retired authority.**
   The target version must be RETIRED, have retired_visibility_seq, have a vector_id, and no longer be the current chunk head. The current head itself must re-resolve to an ACTIVE version owned by that exact chunk; missing or cross-chunk current-head authority fails closed. RECOVERY_RELEASED material state is required before becoming GC_ELIGIBLE.

7. **Recovery release is RETIRED-only in G5.**
   G5 does not release recovery bytes for the ACTIVE current head. This preserves G2 startup-recovery authority until a later runtime/cutover gate explicitly replaces that dependency.

8. **Durable segment coverage must be re-proven.**
   Recovery may advance only when covered_segment_id identifies a current-manifest PUBLISHED segment whose publisher-owned path, SHA-256 digest, native dimension/count, exact SEGMENT coverage set, and native containsKey64 membership all verify.

9. **Embedding authority is exact.**
   The chunk version, recovery row, and durable segment must have the same non-empty embedding fingerprint.

10. **Recovery certification and release are separate transitions, and release must not remain a future flush dependency.**
    SEGMENT_COVERED -> RECOVERY_RECLAIMABLE and RECOVERY_RECLAIMABLE -> RECOVERY_RELEASED are distinct crash-durable transitions. Release re-verifies durable segment authority rather than trusting the earlier certification. After release, G3 may exclude that RETIRED/GC_ELIGIBLE vector from a later sealed-generation flush only by re-proving the same covered segment remains a current authoritative manifest member and still contains the exact vector.

11. **Released recovery bytes are actually gone.**
    RECOVERY_RELEASED requires vector_blob IS NULL and the original covered_segment_id remains bound as audit evidence.

12. **Runtime ownership is verified, not acquired.**
    G5 captures the current SERVING owner and runtime_fence at construction and every authority transition must still match both exactly. Fence rollover invalidates the old coordinator. G5 cannot acquire, transfer, preempt, or take over runtime ownership.

13. **G5 authority reads require SQLite autocommit.**
    Certification/release calls reject ambient transactions so uncommitted or stale outer snapshots cannot manufacture GC/recovery authority.

14. **Crash durability is mandatory.**
    G5 state transitions require SQLite WAL plus synchronous FULL/EXTRA and acknowledge only after the synchronous transaction returns.

15. **ReadView GC registry is database-file scoped inside the serving runtime.**
    Live views are matched by underlying SQLite file identity, including device/inode identity when available, so a second connection or path alias inside the same serving runtime cannot hide a blocking reader. Cross-process crash takeover is not authorized by G5; replacement-runtime activation remains blocked until a later runtime-ownership gate can prove the old runtime cannot execute.

## Explicitly deferred beyond G5

G5 does **not** authorize:

- dropping GC_ELIGIBLE vectors from immutable segments;
- segment compaction;
- compaction snapshot/cut publication;
- sealed MemTable retirement or physical reclaim;
- SEGMENT retirement/reclamation;
- deletion of immutable segment artifacts;
- runtime ownership acquisition/transfer/takeover;
- wiring Gen-USearch into KnowledgeBaseManager, ingestion, existing searchService, or user-facing serving paths;
- GENERATIONAL_SHADOW or GENERATIONAL_ACTIVE;
- upstream merge or Ready-for-Review.

## G5 acceptance

G5 may pass only when:

- exact-head G1/G2/G3/G4 regressions remain green;
- exact-head G5 CI is green;
- ACTIVE older QueryReadView blocks GC;
- CANCEL_REQUESTED older QueryReadView blocks GC;
- QUIESCING older QueryReadView blocks GC;
- RELEASED older QueryReadView permits GC;
- live views at or newer than retired_visibility_seq do not block that retired version;
- current/ACTIVE, missing-current-head, or cross-chunk current-head authority cannot become GC_ELIGIBLE;
- recovery that is not SEGMENT_COVERED cannot become RECOVERY_RECLAIMABLE;
- ACTIVE current recovery bytes cannot be released by G5;
- missing manifest membership, corrupt artifact, digest mismatch, dimension/count mismatch, coverage mismatch, missing key, or fingerprint mismatch blocks recovery release;
- RECOVERY_RECLAIMABLE release re-verifies the durable segment rather than trusting prior certification;
- RECOVERY_RELEASED has vector_blob=NULL and keeps covered_segment_id audit evidence;
- a released RETIRED/GC_ELIGIBLE vector restored into an unflushed Gen0 no longer blocks later generation publication when its current durable segment authority remains valid;
- stale runtime-fence coordinators and ambient SQLite transactions are rejected;
- silent trigger rewrite of recovery release or GC eligibility is caught by transaction postconditions and rolled back;
- WAL + FULL/EXTRA is required;
- G5 stage-boundary tests prove compaction/reclaim/cutover remain unwired;
- independent adversarial review has unresolved P0 = 0 and P1 = 0.

G5 PASS does not authorize Final Upstream Acceptance, Ready-for-Review, upstream merge, physical compaction/reclaim, cutover, or engine activation.

## Independent review closure

Exact-head reviewed implementation: `b0713cdea19e8fefb7e261e4877f74f351d950c3`.

Closed adversarial findings:

- stale runtime-fence coordinators could otherwise retain write authority after a runtime incarnation change; G5 now captures the SERVING fence at construction and rejects every transition after fence rollover;
- a corrupted `current_version_id` could otherwise point at an ACTIVE version belonging to another chunk and make a RETIRED target look safely non-current; recovery and GC now re-resolve and require the current version to be ACTIVE and owned by the exact target chunk;
- an already-present or forged `GC_ELIGIBLE` label could otherwise bypass live-reader revalidation; idempotent GC now re-runs reader-lifetime safety before returning success;
- silent SQLite trigger rewrites of recovery release or GC eligibility are detected by in-transaction postconditions and roll back;
- recovery release re-proves the immutable segment path, SHA-256 digest, native dimension/count, exact SEGMENT coverage set, exact key membership, embedding fingerprint, and current-manifest membership; G3 later re-proves the same current durable authority before excluding a released RETIRED/GC_ELIGIBLE member from a new flush dependency;
- ACTIVE/CANCEL_REQUESTED/QUIESCING older QueryReadViews block GC while RELEASED views do not; reader safety remains scoped to the current serving runtime, and cross-process crash takeover stays outside G5 authority;
- G5 remains isolated from physical compaction/reclaim, runtime takeover/cutover, existing KnowledgeBase ingestion/search paths, and engine activation;
- the project stage map remains G0 through G5 only. No additional numbered gate is introduced.

Exact-head GitHub evidence for the reviewed implementation:

```text
G5 exact-head run 37303226645 = SUCCESS
G4 same-head run 37303226562 = SUCCESS

G5 GC/recovery acceptance = 16/16
G5 authority boundary     = 5/5

unresolved P0 = 0
unresolved P1 = 0
```

Final G5 decision:

```text
G0 = FROZEN
G1 = PASS
G2 = PASS
G3 = PASS
G4 = PASS
G5 = PASS

FINAL_UPSTREAM_ACCEPTANCE = NOT AUTHORIZED
PR_485_READY_FOR_REVIEW   = NOT AUTHORIZED
UPSTREAM_MERGE            = NOT AUTHORIZED
```

G5 PASS closes the last internal implementation gate. It does not by itself authorize the separate final upstream acceptance, Ready-for-Review transition, or merge.


## Ready-for-Review Remediation 2

Reviewed implementation head: `8fef6d31d4ed8ac71a6d625562c8e079997252c0`.

The second independent review found a cross-stage dependency between G5 recovery release and a later G3 flush: a RETIRED vector restored into a new Gen0 could have its recovery bytes released before that generation was sealed, making the later flush depend on bytes that no longer existed.

The closure keeps G5 release semantics narrow while making the G3 consumer dependency explicit:

- G5 still releases bytes only after exact current-manifest durable segment proof;
- released recovery retains `covered_segment_id` as audit authority;
- G3 may omit that RETIRED/GC_ELIGIBLE member from a later flush only after independently re-proving the same covered segment remains in the current authoritative manifest and still contains the exact vector;
- if that durable authority is missing/corrupt/stale, the later flush fails closed instead of silently dropping the vector.

Exact-head evidence:

```text
G5 GC Recovery  37312659656  SUCCESS

G5 GC/recovery acceptance = 16/16
G5 stage boundary         = 5/5
```

Final Upstream Acceptance remains **NOT STARTED**. Upstream merge remains **NOT AUTHORIZED**.
