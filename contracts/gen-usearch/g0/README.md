# Gen-USearch G0 machine contracts

Status: **G0-F2R3 candidate, machine gate hardened, G0 not yet frozen**.

This directory contains the executable machine form of the Gen-USearch G0 R3.1 architecture contract. It does not implement the production USearch engine.

## F2R3 authority model

The gate now has an external trust root and a sealed in-repository contract surface:

1. A repository-level GitHub variable `G0_AUTHORITY_LOCK_SHA256` pins the exact Authority Lock digest outside the PR branch.
2. `g0-authority-lock.json` freezes required contracts, invariants, failure codes, fixtures, critical enums, artifact paths, and SHA256 seals for every other locked artifact.
3. `g0-runner.js` only accepts the real repository top-level, requires every locked worktree file to be byte-identical to `HEAD:path`, verifies the external lock pin, verifies all sealed artifact hashes, executes schemas/fixtures/invariants, reads the real Git HEAD, and emits the acceptance manifest.
4. A separate `Gen-USearch G0 External Authority` workflow lives on the fork's `master` branch. It verifies the target SHA, external pin and sealed artifact hashes before executing any code from the PR branch, then publishes an independent commit status.

## Safety rules now enforced

- fake/nested repository roots are rejected;
- dirty locked artifacts cannot claim an unchanged HEAD;
- changing the Authority Lock requires an explicit external pin update;
- changing Runner, Verifier, schemas, fixtures, package lock, or target workflow requires updating their SHA256 seals in the Authority Lock;
- ReadView transition guards execute;
- GC certification starts from durable `RETIRED` state and precedes `GC_ELIGIBLE`;
- durable vector coverage is derived from `ManifestSnapshot + SegmentRecord + ArtifactReceipt`;
- signed-int64 vector IDs use canonical decimal strings and BigInt;
- acceptance PASS is generated from executed evidence, not caller-provided receipts.

## Local verification

```bash
export G0_AUTHORITY_LOCK_SHA256="<externally reviewed lock SHA256>"
npm ci --prefix tests/gen-usearch/g0 --ignore-scripts --no-audit --no-fund
node --test tests/gen-usearch/g0/g0-contracts.test.js
node tests/gen-usearch/g0/g0-runner.js
```

Passing these gates does **not** itself freeze G0 or authorize G1. After independent re-review reaches unresolved P0=0 and P1=0, the next gate is **G0 Final Review**.
