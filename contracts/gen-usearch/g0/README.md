# Gen-USearch G0 machine contracts

Status: **G0-F2R2 candidate, not G0 frozen**.

This directory contains the executable machine form of the Gen-USearch G0 R3.1 architecture contract. It intentionally does not implement the production USearch engine.

## F2R2 authority model

The G0 gate now has three distinct roles:

1. `g0-authority-lock.json` freezes the required contract surface independently from the mutable registry.
2. `g0-verifier.js` evaluates transitions, invariants, GC, recovery and physical coverage from evidence.
3. `g0-runner.js` is the canonical acceptance entrypoint. It reads the repository itself, runs schema validation, executes fixtures/invariants, reads the real Git HEAD, computes SHA256 for the locked artifact set, and generates the acceptance manifest.

Callers do not supply execution receipts, HEAD SHAs, artifact digests, or PASS status.

GC proof is derived from a durable `RETIRED` record plus reader state before transition to `GC_ELIGIBLE`. Durable vector coverage is derived from `ManifestSnapshot + SegmentRecord + ArtifactReceipt`, not from self-asserted booleans.

ReadView transition guards are executable. In particular, `QUIESCING → RELEASED` requires both worker quiescence and released pins.

## Local verification

```bash
npm ci --prefix tests/gen-usearch/g0 --ignore-scripts --no-audit --no-fund
node --test tests/gen-usearch/g0/g0-contracts.test.js
node tests/gen-usearch/g0/g0-runner.js
```

A green test suite is necessary but not sufficient. CI also runs the canonical runner and requires its generated manifest to be `PASS`.

Changing the Authority Lock changes the frozen required surface and therefore requires explicit G0 authority review. Passing this gate does **not** by itself freeze G0 or authorize G1.
