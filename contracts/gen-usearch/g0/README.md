# Gen-USearch G0 machine contracts

Status: **G0-F2R1 candidate, not G0 frozen**.

This directory contains the executable machine form of the Gen-USearch G0 R3.1 architecture contract. It intentionally does not implement the production USearch engine.

## What the gate now proves

The gate validates the contract artifacts with JSON Schema Draft 2020-12 using pinned Ajv, executes every required invariant with both positive and negative fixtures, runs the FINAL-01..FINAL-05 deterministic race/crash vectors, rejects vacuous fixture/failure/invariant sets, preserves 63-bit vector identity with decimal-string + BigInt semantics, derives GC and recovery decisions from underlying records rather than caller booleans, and derives the acceptance verdict from executed evidence.

A G0 PASS cannot be caller-asserted. The generated acceptance manifest may say PASS only when:

- C1-C8 are all PASS;
- FINAL-01..FINAL-05 are all PASS;
- all required schemas validate;
- required invariant/failure/fixture coverage is exact;
- unresolved P0 = 0;
- unresolved P1 = 0;
- evidence and artifact digests are present.

## Local verification

```bash
npm install --prefix tests/gen-usearch/g0 --ignore-scripts --no-audit --no-fund
node --test tests/gen-usearch/g0/g0-contracts.test.js
```

The result vocabulary remains exactly `PASS / FAIL / BLOCKED`. Passing this suite proves the G0 machine contract is executable and internally enforced. It does **not** by itself freeze G0 or authorize G1 production implementation.
