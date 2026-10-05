# Gen-USearch G0 machine contracts

Status: **G0 FROZEN**.

This directory contains the complete executable G0 R3.1 architecture authority and its machine traceability closure. It still does **not** implement the production USearch engine.

## Frozen-surface candidate

G0 Final Review now evaluates one sealed authority surface:

- `G0-ARCHITECTURE-R3.1.md`: human-readable normative architecture.
- `G0-ARCHITECTURE-R3.1.machine.json`: machine authority for C1-C8, A01-A10, FINAL-01..05, and 31 normative requirements.
- `G0-TRACEABILITY-R3.1.json`: exact mapping from every architecture requirement to invariant, positive fixture, negative fixture, verifier selector, and failure code.
- `g0-contracts-r3.1.json`: 31 executable invariants and state contracts.
- `g0-authority-lock.json`: external-pin-protected required surface and SHA256 seals.

The current candidate has:

```text
Architecture requirements = 31
R3.1 amendments           = 10
Executable invariants     = 31
Invariant fixtures        = 62
FINAL race/crash fixtures = 23
Failure codes             = 76
Locked artifacts          = 22
```

## Final traceability additions

The final closure explicitly machine-tests:

- runtime fence revalidation before response;
- durable monotonic vector-ID allocation and never-reuse;
- recovery-material retention until durable immutable coverage;
- compaction dual-cut snapshot coherence;
- physical presence versus logical visibility;
- vector and logical-chunk candidate deduplication;
- bounded QueryReadView expiry/cancellation semantics;
- CommittedSourceView complete-only indexing;
- C1 reconciler identity-only authority;
- complete QueryReadView snapshot shape;
- crash-durable critical transaction family;
- missing source observation does not imply delete.

## Authority model

The repository variable `G0_AUTHORITY_LOCK_SHA256` pins the exact Authority Lock outside the PR branch. The lock seals every other required machine artifact. The canonical runner only accepts the real repository top-level, byte-compares locked files with `HEAD:path`, verifies the external pin and all seals, validates schemas and traceability, executes all fixtures/invariants, and emits the acceptance manifest.

A separate `Gen-USearch G0 External Authority` workflow on the fork's `master` branch independently validates the target exact SHA and publishes `gen-usearch/g0-external-authority` status.

## Local verification

```bash
export G0_AUTHORITY_LOCK_SHA256="<externally reviewed lock SHA256>"
npm ci --prefix tests/gen-usearch/g0 --ignore-scripts --no-audit --no-fund
node --test tests/gen-usearch/g0/g0-contracts.test.js
node tests/gen-usearch/g0/g0-runner.js
```

The final independent review passed with unresolved P0=0 and P1=0. **G0 is FROZEN. G1 remains separately unauthorized until explicitly started.**
