"use strict";

/**
 * OpenHerMoodStateMachine offline calibrator.
 *
 * Usage:
 *   node scripts/openher-mood-state-machine-calibrator.js
 *   node scripts/openher-mood-state-machine-calibrator.js --json
 */

const { evaluateMoodStateMachine } = require("../Plugin/OpenHerPersona/OpenHerMoodStateMachine.js");

const DEFAULTS = {
  inquiry: 0.35,
  discernment: 0.4,
  refusal: 0.28,
  positive: 0.32,
  negative: 0.22,
  arousal: 0.32,
  passion: 0.38,
  curiosity: 0.38,
  arrogance: 0.24,
  libido: 0.11,
  hedonia: 0.28,
  coldness: 0.16,
  fear: 0.18,
  numbness: 0.12,
  self_punishment: 0.1,
};

const DRIVE_AXES = [
  "passion",
  "libido",
  "hedonia",
  "coldness",
  "arrogance",
  "numbness",
  "self_punishment",
  "fear",
  "curiosity",
];

const COGNITIVE_AXES = ["inquiry", "discernment", "refusal"];

function clamp01(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

function round4(value) {
  return Number(clamp01(value).toFixed(4));
}

function relativeActivation(value, base, k = 2.2) {
  const normalizedValue = clamp01(value);
  const normalizedBase = clamp01(base);
  const aboveRaw = Math.max(0, normalizedValue - normalizedBase) / Math.max(0.05, 1 - normalizedBase);
  const belowRaw = Math.max(0, normalizedBase - normalizedValue) / Math.max(0.05, normalizedBase);
  return {
    above: round4(Math.pow(clamp01(aboveRaw), 1 / k)),
    below: round4(Math.pow(clamp01(belowRaw), 1 / k)),
    delta: Number((normalizedValue - normalizedBase).toFixed(4)),
    base: Number(normalizedBase.toFixed(4)),
  };
}

function makeState(valuesInput = {}, baselineInput = {}) {
  const values = { ...DEFAULTS, ...valuesInput };
  const baseline = { ...DEFAULTS, ...baselineInput };
  const state = {
    drive: {},
    cognitive: {},
    affective: {
      positive: { value: clamp01(values.positive) },
      negative: { value: clamp01(values.negative) },
      arousal: { value: clamp01(values.arousal) },
    },
    coupling: {
      lastPassionModulation: {
        positiveGain: relativeActivation(values.passion, baseline.passion).above,
      },
    },
    lastObservation: null,
  };
  for (const axis of DRIVE_AXES) state.drive[axis] = { value: clamp01(values[axis]) };
  for (const axis of COGNITIVE_AXES) state.cognitive[axis] = { value: clamp01(values[axis]) };
  return { state, values, baseline };
}

function evaluateScenario(name, valuesInput = {}, baselineInput = {}) {
  const { state, values, baseline } = makeState(valuesInput, baselineInput);
  const result = evaluateMoodStateMachine(state, values.positive, values.negative, values.arousal, {
    getAxisValue: (targetState, layer, axis) => clamp01(targetState[layer] && targetState[layer][axis] ? targetState[layer][axis].value : DEFAULTS[axis]),
    getAxisBaseline: (targetState, axis) => clamp01(baseline[axis] ?? DEFAULTS[axis]),
    relativeActivation,
  });
  return { name, values, baseline, result };
}

function buildScenarios() {
  const scenarios = [
    evaluateScenario("默认状态"),
    evaluateScenario("全轴中值", Object.fromEntries(Object.keys(DEFAULTS).map((axis) => [axis, 0.5]))),
    evaluateScenario("明亮高唤醒", { positive: 0.82, negative: 0.16, arousal: 0.82, passion: 0.72 }),
    evaluateScenario("温暖低唤醒", { positive: 0.82, negative: 0.12, arousal: 0.18, hedonia: 0.62, passion: 0.58 }),
    evaluateScenario("负性焦灼", { positive: 0.14, negative: 0.82, arousal: 0.82, fear: 0.72, refusal: 0.58 }),
    evaluateScenario("低落下沉", { positive: 0.16, negative: 0.78, arousal: 0.18, numbness: 0.58 }),
    evaluateScenario("情热流动", { libido: 0.82, passion: 0.78, positive: 0.78, arousal: 0.72, coldness: 0.12, numbness: 0.12 }),
    evaluateScenario("绵软亲昵", { libido: 0.78, hedonia: 0.76, positive: 0.72, arousal: 0.2, coldness: 0.1, numbness: 0.12 }),
    evaluateScenario("欲念焦灼", { libido: 0.82, negative: 0.76, arousal: 0.82, fear: 0.72, positive: 0.22 }),
    evaluateScenario("冷感欲张", { libido: 0.82, coldness: 0.78, numbness: 0.22, positive: 0.55, negative: 0.56, arousal: 0.66, refusal: 0.56 }),
    evaluateScenario("冷欲浮起", { libido: 0.82, coldness: 0.62, numbness: 0.78, positive: 0.42, negative: 0.24, arousal: 0.18 }),
    evaluateScenario("情热受阻", { libido: 0.78, passion: 0.76, coldness: 0.72, fear: 0.68, numbness: 0.36, positive: 0.62, negative: 0.52, arousal: 0.58 }),
    evaluateScenario("封冻结壳", { coldness: 0.82, numbness: 0.84, positive: 0.12, negative: 0.16, arousal: 0.12, curiosity: 0.08, libido: 0.08, hedonia: 0.08, arrogance: 0.08 }),
    evaluateScenario("探求炽热", { curiosity: 0.82, inquiry: 0.82, passion: 0.72, positive: 0.58, arousal: 0.7 }),
    evaluateScenario("幽微洞察", { inquiry: 0.82, discernment: 0.82, arousal: 0.18, curiosity: 0.56 }),
    evaluateScenario("昂扬自恃", { arrogance: 0.82, positive: 0.78, arousal: 0.72, passion: 0.68 }),
    evaluateScenario("渊底自毁", { self_punishment: 0.84, negative: 0.82, arousal: 0.76, fear: 0.68 }),
  ];

  const pna = [0.2, 0.5, 0.8];
  for (const positive of pna) {
    for (const negative of pna) {
      for (const arousal of pna) {
        scenarios.push(evaluateScenario(`PNA网格 p=${positive} n=${negative} a=${arousal}`, { positive, negative, arousal }));
      }
    }
  }

  const eroticLevels = [0.15, 0.45, 0.75];
  for (const libido of eroticLevels) {
    for (const coldness of eroticLevels) {
      for (const numbness of eroticLevels) {
        scenarios.push(evaluateScenario(
          `Erotic网格 l=${libido} c=${coldness} nb=${numbness}`,
          { libido, coldness, numbness, positive: 0.52, negative: 0.44, arousal: 0.52 }
        ));
      }
    }
  }

  return scenarios;
}

function summarize(scenarios) {
  const primaryCounts = new Map();
  const familyCounts = new Map();
  const scoreTotals = new Map();
  const labels = new Set();
  for (const scenario of scenarios) {
    const primary = scenario.result.primary;
    if (!primary) continue;
    labels.add(primary.label);
    primaryCounts.set(primary.label, (primaryCounts.get(primary.label) || 0) + 1);
    familyCounts.set(primary.family, (familyCounts.get(primary.family) || 0) + 1);
    scoreTotals.set(primary.label, (scoreTotals.get(primary.label) || 0) + primary.score);
    for (const candidate of scenario.result.candidates || []) labels.add(candidate.label);
  }

  const primaryRows = [...primaryCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([label, count]) => ({
      label,
      count,
      rate: Number((count / scenarios.length).toFixed(4)),
      avgScore: Number(((scoreTotals.get(label) || 0) / count).toFixed(4)),
    }));

  const familyRows = [...familyCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([family, count]) => ({ family, count, rate: Number((count / scenarios.length).toFixed(4)) }));

  const deadLabels = [...labels].filter((label) => !primaryCounts.has(label)).sort();

  return {
    scenarioCount: scenarios.length,
    primaryRows,
    familyRows,
    deadLabels,
  };
}

function printScenario(scenario) {
  const primary = scenario.result.primary;
  const secondary = scenario.result.secondary;
  console.log(`\n=== ${scenario.name} ===`);
  console.log(`primary=${primary ? `${primary.label}/${primary.family} score=${primary.score} confidence=${primary.confidence}` : "none"}`);
  console.log(`secondary=${secondary ? `${secondary.label}/${secondary.family} score=${secondary.score}` : "none"}`);
  console.table((scenario.result.candidates || []).map((candidate, index) => ({
    rank: index + 1,
    label: candidate.label,
    family: candidate.family,
    score: candidate.score,
    confidence: candidate.confidence,
    recipe: candidate.recipe.join(" + "),
  })));
}

function main() {
  const scenarios = buildScenarios();
  const summary = summarize(scenarios);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ summary, scenarios }, null, 2));
    return;
  }
  for (const scenario of scenarios) printScenario(scenario);
  console.log("\n=== Primary标签分布 ===");
  console.table(summary.primaryRows);
  console.log("\n=== Primary状态族分布 ===");
  console.table(summary.familyRows);
  console.log("\n=== 候选出现但从未成为Primary的标签 ===");
  console.table(summary.deadLabels.map((label) => ({ label })));
}

main();