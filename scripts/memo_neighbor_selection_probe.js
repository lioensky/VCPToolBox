'use strict';

// Isolated mathematical probe, NOT the Rust runtime or a retrieval-quality benchmark.
// Run: node scripts/memo_neighbor_selection_probe.js
// Machine-readable output: node scripts/memo_neighbor_selection_probe.js --json
// No database, native addon, production config changes, or third-party dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rag_params.json'), 'utf8'))
    .KnowledgeBaseManager.spikeRouting;
const defaults = {
    maxNeighborsPerNode: routing.maxNeighborsPerNode ?? 20,
    baseDecay: routing.baseDecay ?? 0.25,
    wormholeDecay: routing.wormholeDecay ?? 0.7,
    tensionThreshold: routing.tensionThreshold ?? 1,
    minimumInjectedCurrent: routing.minimumInjectedCurrent ?? 0.01,
    firingThreshold: routing.firingThreshold ?? 0.1,
    returnFlowFactor: routing.v91ReturnFlowFactor ?? 0.15
};

const positive = value => Number.isFinite(value) ? Math.max(0, value) : 0;
const rawOrder = (a, b) => b.conductance - a.conductance || a.targetId - b.targetId;
const effectiveOrder = (a, b) => b.effective - a.effective || rawOrder(a, b);

function evaluate(edges, mode, slots, overrides = {}) {
    assert(['rawConductance', 'effectiveConductance'].includes(mode));
    const config = { ...defaults, energy: 1, previousId: null, ...overrides };
    // Match current Rust's K=0 -> 1 behavior, not a proposed new zero convention.
    const k = Math.max(1, config.maxNeighborsPerNode);
    const row = edges.map(edge => {
        const conductance = positive(edge.conductance);
        // NativeArtifact has no edge_tension array. Preserve current runtime formula.
        const wormhole = !!edge.wormhole
            || conductance * (edge.anchorGain ?? 1) >= config.tensionThreshold;
        const effective = conductance * (wormhole ? config.wormholeDecay : config.baseDecay);
        const unpenalized = config.energy * effective;
        const injected = unpenalized
            * (edge.targetId === config.previousId ? config.returnFlowFactor : 1);
        return { ...edge, conductance, wormhole, effective, unpenalized, injected };
    }).filter(edge => edge.conductance > 0).sort(rawOrder);
    const rawIds = new Set(row.slice(0, k).map(edge => edge.targetId));
    const ranked = [...row].sort(mode === 'rawConductance' ? rawOrder : effectiveOrder);
    // Experimental orthogonal policy: reserve within K, never append beyond K.
    // raw + slots=0 is the exact old selection; raw + slots>0 is NOT old behavior.
    const reserved = row.filter(edge => edge.wormhole
        && edge.unpenalized >= config.minimumInjectedCurrent)
        .sort(effectiveOrder).slice(0, Math.min(slots, k));
    const reservedIds = new Set(reserved.map(edge => edge.targetId));
    const selected = [...reserved, ...ranked.filter(edge => !reservedIds.has(edge.targetId))]
        .slice(0, k);
    const fired = selected.filter(edge => edge.injected >= config.minimumInjectedCurrent);
    const promoted = fired.filter(edge => edge.wormhole && !rawIds.has(edge.targetId));
    return {
        selectedIds: selected.map(edge => edge.targetId),
        firedIds: fired.map(edge => edge.targetId),
        selected: selected.length,
        fired: fired.length,
        wormholesFired: fired.filter(edge => edge.wormhole).length,
        promoted: promoted.length,
        onwardEligibleStates: fired.filter(edge => edge.injected >= config.firingThreshold).length,
        injectedMass: fired.reduce((sum, edge) => sum + edge.injected, 0),
        reservedButRejected: reserved.filter(edge => edge.injected < config.minimumInjectedCurrent).length
    };
}

function fixture(normalWeight = 0.05, wormholeWeight = 0.04) {
    // Exactly 25 outgoing edges: 20 normal, one wormhole, four weaker normal.
    return [
        ...Array.from({ length: 20 }, (_, i) => ({ targetId: i + 1, conductance: normalWeight })),
        { targetId: 21, conductance: wormholeWeight, wormhole: true },
        ...Array.from({ length: 4 }, (_, i) => ({ targetId: i + 22, conductance: 0.001 }))
    ];
}

const modes = ['rawConductance', 'effectiveConductance'];
const results = [];
function compare(name, edges, overrides = {}) {
    const runs = {};
    for (const mode of modes) {
        for (const slots of [0, 2]) {
            const value = evaluate(edges, mode, slots, overrides);
            runs[`${mode}/${slots}`] = value;
            results.push({
                scenario: name, mode, slots,
                selected: value.selected, fired: value.fired,
                wormholes: value.wormholesFired, promoted: value.promoted,
                onward: value.onwardEligibleStates,
                injectedMass: Number(value.injectedMass.toFixed(6)),
                reservedButRejected: value.reservedButRejected
            });
        }
    }
    return runs;
}

// Freeze the task's numeric example regardless of local tuning.
const acceptance = {
    maxNeighborsPerNode: 20, baseDecay: 0.25, wormholeDecay: 0.70,
    tensionThreshold: 1, minimumInjectedCurrent: 0.01, firingThreshold: 0.10
};
const canonical = compare('task-example', fixture(), acceptance);
assert(!canonical['rawConductance/0'].selectedIds.includes(21));
assert(canonical['effectiveConductance/0'].firedIds.includes(21));
assert.equal(canonical['effectiveConductance/0'].promoted, 1);
assert.equal(canonical['effectiveConductance/0'].onwardEligibleStates, 0);
assert(canonical['rawConductance/2'].firedIds.includes(21));
assert.equal(canonical['effectiveConductance/0'].injectedMass.toFixed(4), '0.2655');
assert.equal(canonical['rawConductance/0'].injectedMass.toFixed(4), '0.2500');

// Strong normal edges: reservation now has a measurable current/opportunity cost.
const strong = compare('strong-normal-edges', fixture(0.2), acceptance);
assert.equal(strong['effectiveConductance/0'].wormholesFired, 0);
assert.equal(strong['effectiveConductance/2'].wormholesFired, 1);
assert(strong['effectiveConductance/2'].injectedMass < strong['effectiveConductance/0'].injectedMass);

// Below injection threshold: reserving such wormholes must not displace normal edges.
const weak = compare('subthreshold-wormhole', fixture(0.05, 0.01), acceptance);
assert.equal(weak['effectiveConductance/2'].wormholesFired, 0);
assert.equal(weak['effectiveConductance/2'].selected, 20);

// Proposed reservation uses UNPENALIZED current; immediate return can waste the slot.
const returning = compare('immediate-return', fixture(), {
    ...acceptance, previousId: 21, returnFlowFactor: 0.15
});
assert.equal(returning['effectiveConductance/2'].reservedButRejected, 1);
assert.equal(returning['effectiveConductance/2'].wormholesFired, 0);

// Request-specific tension is independent of the explicit immutable wormhole flag.
const tension = compare('dynamic-tension', [
    ...fixture().filter(edge => edge.targetId !== 21),
    { targetId: 21, conductance: 0.04, anchorGain: 30 }
], acceptance);
assert.equal(tension['effectiveConductance/0'].promoted, 1);

// Tie resolution must be effective desc, conductance desc, target ID asc.
const tied = evaluate([
    { targetId: 3, conductance: 0.04, wormhole: true },
    { targetId: 2, conductance: 0.04, wormhole: true },
    { targetId: 1, conductance: 0.112 }
], 'effectiveConductance', 0, { ...acceptance, maxNeighborsPerNode: 3 });
assert.deepEqual(tied.selectedIds, [1, 2, 3]);
const oversized = evaluate(fixture(), 'effectiveConductance', 100, acceptance);
assert.equal(oversized.selected, 20);
assert.equal(new Set(oversized.selectedIds).size, 20);

// Confluence counterexample: A -> C and B -> C remain separate (previous,node)
// states. At C -> D both enter the same (C,D) state, losing one scalar seedId.
// This diagnoses lineage loss only; it does not simulate multi-hop propagation.
const atC = [
    { previous: 'A', node: 'C', seedId: 'A', seedIds: new Set(['A']) },
    { previous: 'B', node: 'C', seedId: 'B', seedIds: new Set(['B']) }
];
const atD = new Map();
for (const state of atC) {
    const key = `${state.node},D`;
    if (!atD.has(key)) atD.set(key, { seedId: state.seedId, seedIds: new Set() });
    for (const seed of state.seedIds) atD.get(key).seedIds.add(seed);
}
const confluence = {
    graph: 'A -> C <- B; C -> D',
    scalarSeedCountAtD: new Set([...atD.values()].map(state => state.seedId)).size,
    actualSeedCountAtD: new Set([...atD.values()].flatMap(state => [...state.seedIds])).size,
    note: 'Node energy sums across previous-node states, but firing checks each state separately.'
};
assert.equal(confluence.scalarSeedCountAtD, 1);
assert.equal(confluence.actualSeedCountAtD, 2);

compare('local-config-example', fixture());
const report = {
    scope: 'Synthetic mathematical selection probe; NOT native parity, Rust performance, or retrieval quality.',
    reservationPolicy: 'Orthogonal within-K quota. Exact legacy baseline = rawConductance + 0 slots.',
    configuration: defaults,
    results,
    confluence,
    conclusions: [
        'Canonical wormhole gets 0.028 current, but cannot refire at threshold 0.10 with energy=1.',
        'Effective ranking alone rescues the canonical edge; reservation is not needed in that case.',
        'Reservation can lower total injected current when normal edges are stronger.',
        'Unpenalized reservation can spend a slot on an immediate return that fails injection.',
        'Scalar seedId cannot measure downstream multi-seed confluence after state merging.',
        'Reusing neighbor scratch removes neighbor-list allocations only, not all hot-loop allocations.',
        'Synthetic rescue counts do not demonstrate semantic relevance or end-to-end retrieval gains.'
    ],
    assertions: 'passed'
};
if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
} else {
    console.log(report.scope);
    console.log(report.reservationPolicy);
    console.table(results);
    console.log('Confluence:', confluence);
    for (const conclusion of report.conclusions) console.log(`- ${conclusion}`);
    console.log('All probe assertions passed.');
}