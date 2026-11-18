# RiverMemo RRF ranking/score contract

## Scope

Conditional wormhole RRF previously overwrote `ScoredWork.final_score` for the entire active batch.
Consequently `score` changed units depending on route activation. Absolute quality thresholds
could discard candidates whose original baseline quality was sufficient.

This patch changes only the destination of the existing fusion result:
- `ranking_score` carries the unchanged multi-route maximum RRF formula and Omega gate.
- Every path, including early returns, initializes `ranking_score` from `final_score`.
- The readout call site stably sorts by `ranking_score`, retaining baseline order for ties.
- `final_score` remains the candidate's own clipped baseline component sum.
- There is no extra wormhole quality bonus or score reassignment.

Output array order / rank is authoritative for retrieval order. `score` is not necessarily
monotonically decreasing. Explicit score-based postprocessors (including TimeDecay) may
override retrieval order according to their existing policy.

No MGS changes, dual-field diagnostics, gate changes, formula retuning or binary artifacts
are included in this PR.

## Executable input dataset

`rust-vexus-lite/tests/fixtures/rrf_score_contract.json` contains synthetic, non-private
candidate baselines and route flows. The Rust tests load it with `include_str!` and exercise
the production `fuse_rrf` function.

Coverage:
- active multi-route maximum (not sum), ordinary-edge flow reference;
- no-ordinary-edge fallback, zero-reference early return and empty candidates;
- baseline quality preserved bit-for-bit, including an eligible candidate below threshold;
- fusion order checked against independently computed legacy RRF keys;
- include_trace true/false at the fusion-function level;
- inactive stable baseline ties;
- existing event-order regression now checks the independent ranking key.

These are function-level contract tests, not a complete serialized API / plugin-chain matrix.

Run from repository root:

    cargo +stable test --manifest-path rust-vexus-lite/Cargo.toml --lib
    node --test tests/rrfOutputEvidence.test.js

## Real-corpus numeric output evidence

`rust-vexus-lite/tests/fixtures/rrf_real_output_evidence.json` is a white-list export of
85 prior mechanism cases in ABBA rounds. Candidate IDs are remapped within each case.
No diary text, source paths, raw embeddings, credentials or SQLite files are included.

`tests/rrfOutputEvidence.test.js` independently recomputes these recorded-output checks:
- all 85 paired result orders identical;
- 10 route-active cases (including repeated sources with different parameters);
- 960 candidate score records changed from the fusion key back to quality scores;
- baseline threshold >=0.5 retention: 4,839 -> 5,743, delta 904, reproduced in both rounds;
- modified output scores match clipped baseline components.

IMPORTANT: this is an output evidence dataset, NOT the original native replay inputs.
It cannot independently regenerate graph observations. The previous experiment used a
combined MGS/RRF/diagnostics build; it is not presented as an isolated RRF-only experiment.
The RRF-only source patch is tested separately with the executable synthetic input dataset.
No claims of improved relevance, recall, performance or TimeDecay correctness follow from
these records. The threshold calculation is offline filtering, not a plugin-chain replay.

For a private local run, the exporter can reproduce this file:

    node scripts/export_rrf_contract_evidence.js <private-ABBA-output-directory> <output.json>

The original private corpus is intentionally not published. Its 85 cases include 25
addressed wormhole probes, 25 highest-similarity co-file tag-pair probes, 20 synthetic
88/12 mixtures of real tag vectors, and 15 real-graph alpha variants. All are mechanism
probes, not independently labelled natural-language relevance judgments.