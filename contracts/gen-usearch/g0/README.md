# Gen-USearch G0 machine contracts

Status: **G0-F2 candidate, not G0 frozen**.

This directory contains the machine-readable form of the Gen-USearch G0 R3.1 architecture contract. It intentionally does not implement the production USearch engine.

## Contents

- `g0-contracts-r3.1.json`: canonical G0 machine contract registry.
- `failure-codes.json`: frozen failure-code registry.
- `g0-contracts.schema.json`: schema for the machine contract registry.
- `g0-acceptance.schema.json`: schema for the final G0 acceptance manifest.
- `../../../tests/gen-usearch/g0/fixtures/final-race-vectors.json`: deterministic race/crash fixtures.
- `../../../tests/gen-usearch/g0/g0-verifier.js`: reference G0 verifier.
- `../../../tests/gen-usearch/g0/g0-contracts.test.js`: machine gate tests.

## Local verification

```bash
node --test tests/gen-usearch/g0/g0-contracts.test.js
```

The verifier is dependency-free and uses Node's built-in test runner so the G0 contract gate does not depend on the production search stack.

## Gate semantics

A contract verdict is only one of:

- `PASS`
- `FAIL`
- `BLOCKED`

G0 cannot pass unless C1-C8, FINAL-01..FINAL-05, unresolved P0=0 and unresolved P1=0 all pass. Passing this test suite proves the frozen machine contract and deterministic fixtures are internally executable. It does **not** by itself freeze G0 or authorize G1 production implementation.
