"use strict";

/**
 * OpenHerPersona archetype score calculator.
 *
 * Usage:
 *   node scripts/openher-persona-archetype-calculator.js
 *   node scripts/openher-persona-archetype-calculator.js --json
 *
 * This is intentionally standalone: it mirrors the mood-archetype formulas in
 * Plugin/OpenHerPersona/OpenHerPersona.js without requiring plugin internals.
 */

const DEFAULTS = {
  inquiry: 0.35,
  discernment: 0.4,
  refusal: 0.28,
  positive: 0.32,
  negative: 0.22,
  arousal: 0.32,
  passion: 0.34,
  curiosity: 0.34,
  arrogance: 0.24,
  libido: 0.18,
  hedonia: 0.28,
  coldness: 0.16,
  fear: 0.18,
  numbness: 0.12,
  self_punishment: 0.1,
};

const DRIVE_COUNTER_RULES = [
  { drive: "curiosity", counter: "numbness", weight: 0.35 },
  { drive: "curiosity", counter: "coldness", weight: 0.18 },
  { drive: "curiosity", counter: "fear", weight: 0.16 },
  { drive: "arrogance", counter: "fear", weight: 0.3 },
  { drive: "arrogance", counter: "numbness", weight: 0.14 },
  { drive: "libido", counter: "coldness", weight: 0.38 },
  { drive: "libido", counter: "numbness", weight: 0.18 },
  { drive: "libido", counter: "fear", weight: 0.14 },
  { drive: "libido", counter: "self_punishment", weight: 0.18 },
  { drive: "hedonia", counter: "self_punishment", weight: 0.3 },
  { drive: "hedonia", counter: "numbness", weight: 0.22 },
  { drive: "hedonia", counter: "fear", weight: 0.12 },
];

const PASSION_COUNTER_SUPPRESSION = {
  coldness: 1,
  numbness: 0.82,
  fear: 0.46,
  self_punishment: 0.24,
};

function clamp01(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

function relativeActivation(value, base, k = 2.2) {
  const normalizedValue = clamp01(value);
  const normalizedBase = clamp01(base);
  const aboveRaw = Math.max(0, normalizedValue - normalizedBase) / Math.max(0.05, 1 - normalizedBase);
  const belowRaw = Math.max(0, normalizedBase - normalizedValue) / Math.max(0.05, normalizedBase);
  return {
    above: round4(Math.pow(clamp01(aboveRaw), 1 / k)),
    below: round4(Math.pow(clamp01(belowRaw), 1 / k)),
    delta: round4(normalizedValue - normalizedBase),
    base: round4(normalizedBase),
  };
}

function resonance(factors, gain, epsilon = 0.03) {
  if (!Array.isArray(factors) || !factors.length) return 0;
  const prod = factors.reduce((acc, factor) => acc * Math.max(epsilon, clamp01(factor)), 1);
  const geo = Math.pow(prod, 1 / factors.length);
  return round4(clamp01(geo * gain));
}

function round4(value) {
  return Number(clamp01(value).toFixed(4));
}

function affectiveSalience(value, neutral = 0.34, k = 1.55) {
  const normalizedValue = clamp01(value);
  const normalizedNeutral = clamp01(neutral);
  const aboveRaw = Math.max(0, normalizedValue - normalizedNeutral) / Math.max(0.05, 1 - normalizedNeutral);
  return round4(Math.pow(clamp01(aboveRaw), 1 / k));
}

function computeDrivePassionModulation(values) {
  const defaultPassion = DEFAULTS.passion;
  const positiveBase = DEFAULTS.positive;
  const previousPassion = values.passion ?? defaultPassion;
  const observedPassion = values.passion ?? previousPassion;
  const positiveValue = values.positive ?? positiveBase;
  const positiveLift = Math.max(0, positiveValue - positiveBase) / Math.max(0.05, 1 - positiveBase);
  const blendedPassion = clamp01(previousPassion * 0.15 + observedPassion * 0.62 + positiveLift * 0.32);
  const aboveBase = Math.max(0, blendedPassion - defaultPassion) / Math.max(0.05, 1 - defaultPassion);
  const positiveGain = Math.pow(clamp01(aboveBase), 0.48);
  const counterSuppression = clamp01(positiveGain * 0.9);
  return {
    passion: round4(blendedPassion),
    base: round4(defaultPassion),
    positiveLift: round4(positiveLift),
    positiveGain: round4(positiveGain),
    counterSuppression: round4(counterSuppression),
  };
}

function computeDriveCounterbalance(values, passionModulation) {
  const pressures = {};
  const details = [];
  const baseSuppression = clamp01(passionModulation ? passionModulation.counterSuppression : 0);
  for (const rule of DRIVE_COUNTER_RULES) {
    const driveValue = values[rule.drive] ?? DEFAULTS[rule.drive] ?? 0.5;
    const counterValue = values[rule.counter] ?? DEFAULTS[rule.counter] ?? 0.5;
    const coActivationPressure = driveValue * counterValue * rule.weight * 0.45;
    const dominancePressure = Math.max(0, counterValue - driveValue) * rule.weight * 0.75;
    const rawPressure = coActivationPressure + dominancePressure;
    const counterSuppressionFactor = Object.prototype.hasOwnProperty.call(PASSION_COUNTER_SUPPRESSION, rule.counter)
      ? PASSION_COUNTER_SUPPRESSION[rule.counter]
      : 0.5;
    const suppression = clamp01(baseSuppression * counterSuppressionFactor);
    const pressure = rawPressure * (1 - suppression);
    pressures[rule.drive] = (pressures[rule.drive] || 0) + pressure;
    details.push({
      drive: rule.drive,
      counter: rule.counter,
      driveValue: round4(driveValue),
      counterValue: round4(counterValue),
      rawPressure: round4(rawPressure),
      pressure: round4(pressure),
      passionSuppression: round4(suppression),
    });
  }
  return {
    pressures: Object.fromEntries(Object.entries(pressures).map(([axis, value]) => [axis, round4(value)])),
    details,
  };
}

function evaluate(valuesInput, baselineInput = {}) {
  const values = { ...DEFAULTS, ...valuesInput };
  const baseline = { ...DEFAULTS, ...baselineInput };
  const p = clamp01(values.positive);
  const n = clamp01(values.negative);
  const a = clamp01(values.arousal);
  const calmness = 1 - a;
  const rel = {};
  for (const axis of [
    "passion",
    "libido",
    "hedonia",
    "coldness",
    "arrogance",
    "numbness",
    "self_punishment",
    "fear",
    "curiosity",
    "inquiry",
    "discernment",
    "refusal",
  ]) {
    rel[axis] = relativeActivation(values[axis], baseline[axis]);
  }

  const up = (axis) => (rel[axis] ? rel[axis].above : 0);
  const down = (axis) => (rel[axis] ? rel[axis].below : 0);
  const passionModulation = computeDrivePassionModulation(values);
  const counterbalance = computeDriveCounterbalance(values, passionModulation);
  const pressure = (axis) => clamp01(counterbalance.pressures[axis] || 0);
  const passionGain = clamp01(passionModulation.positiveGain || up("passion"));

  const maxExpansiveDrive = Math.max(up("curiosity"), up("libido"), up("hedonia"), up("arrogance"));
  const lowExpansiveDrive = 1 - maxExpansiveDrive;
  const lowValence = (1 - p) * (1 - n);
  const coldNumb = Math.max(up("coldness"), up("numbness"));
  const libidoColdPressure = Math.max(pressure("libido"), resonance([up("libido"), coldNumb], 1, 0));
  const pTone = affectiveSalience(p, 0.5);
  const nTone = affectiveSalience(n, 0.5);
  const aTone = affectiveSalience(a, 0.5);
  const calmTone = affectiveSalience(calmness, 0.72);

  const archetypes = [
    { label: "悲喜交欢", score: resonance([pTone, nTone, aTone], 1.12), recipe: ["positive↑", "negative↑", "arousal↑"] },
    { label: "渊底自毁", score: resonance([up("self_punishment"), nTone, aTone], 1.24), recipe: ["self_punishment↑", "negative↑", "arousal↑"] },
    { label: "痛感沉溺", score: resonance([up("self_punishment"), up("hedonia"), pTone], 1.18), recipe: ["self_punishment↑", "hedonia↑", "positive↑"] },
    { label: "热情点燃", score: resonance([up("passion"), Math.max(pTone, up("hedonia")), Math.max(aTone, up("curiosity"))], 1.28), recipe: ["passion↑", "positive↑/hedonia↑", "arousal↑/curiosity↑"] },
    { label: "情热涌动", score: resonance([up("libido"), aTone, pTone, passionGain], 1.2), recipe: ["libido↑", "arousal↑", "positive↑", "passionGain"] },
    { label: "绵密缱绻", score: resonance([up("libido"), up("hedonia"), calmTone, passionGain], 1.18), recipe: ["libido↑", "hedonia↑", "calmness↑", "passionGain"] },
    { label: "欲念焦灼", score: resonance([up("libido"), nTone, aTone], 1.15), recipe: ["libido↑", "negative↑", "arousal↑"] },
    { label: "欲冷相娇", score: resonance([up("libido"), coldNumb, libidoColdPressure], 1.3), recipe: ["libido↑", "cold/numb↑", "libidoCounterPressure"] },
    { label: "冷欲渐起", score: resonance([up("libido"), up("numbness"), calmTone], 1.2), recipe: ["libido↑", "numbness↑", "calmness↑"] },
    { label: "情热受阻", score: resonance([passionGain, maxExpansiveDrive, coldNumb], 1.18), recipe: ["passionGain", "drive↑", "cold/numb↑"] },
    { label: "狂妄昂扬", score: resonance([up("arrogance"), pTone, aTone, passionGain], 1.2), recipe: ["arrogance↑", "positive↑", "arousal↑", "passionGain"] },
    { label: "傲慢睥睨", score: resonance([up("arrogance"), up("coldness"), calmTone], 1.05), recipe: ["arrogance↑", "coldness↑", "calmness↑"] },
    { label: "霜冷拒守", score: resonance([up("refusal"), up("coldness"), nTone], 1.12), recipe: ["refusal↑", "coldness↑", "negative↑"] },
    { label: "封冻死寂", score: resonance([up("numbness"), up("coldness"), calmTone, lowValence, lowExpansiveDrive], 1.16), recipe: ["numbness↑", "coldness↑", "calmness↑", "lowValence", "lowDrive"] },
    { label: "麻木解冻", score: resonance([down("numbness"), pTone, Math.max(up("curiosity"), up("libido"), up("arrogance"))], 1.1), recipe: ["numbness↓", "positive↑", "drive↑"] },
    { label: "惊惧退守", score: resonance([up("fear"), aTone, nTone], 1.18), recipe: ["fear↑", "arousal↑", "negative↑"] },
    { label: "如履薄冰", score: resonance([up("fear"), up("discernment"), calmTone], 1.12), recipe: ["fear↑", "discernment↑", "calmness↑"] },
    { label: "虚张声势", score: resonance([up("arrogance"), up("fear"), pressure("arrogance")], 1.18), recipe: ["arrogance↑", "fear↑", "arroganceCounterPressure"] },
    { label: "探求炽热", score: resonance([up("curiosity"), up("inquiry"), aTone], 1.15), recipe: ["curiosity↑", "inquiry↑", "arousal↑"] },
    { label: "幽微洞察", score: resonance([up("discernment"), up("inquiry"), calmTone], 1.12), recipe: ["discernment↑", "inquiry↑", "calmness↑"] },
    { label: "慵懒沉陷", score: resonance([up("hedonia"), calmTone, pTone], 1.1), recipe: ["hedonia↑", "calmness↑", "positive↑"] },
    { label: "享乐负罪", score: resonance([up("hedonia"), up("self_punishment"), pressure("hedonia")], 1.18), recipe: ["hedonia↑", "self_punishment↑", "hedoniaCounterPressure"] },
    { label: "雀跃明亮", score: resonance([pTone, aTone], 0.98), recipe: ["positive↑", "arousal↑"] },
    { label: "温和宁静", score: resonance([pTone, calmTone], 0.98), recipe: ["positive↑", "calmness↑"] },
    { label: "焦灼愤懑", score: resonance([nTone, aTone], 0.98), recipe: ["negative↑", "arousal↑"] },
    { label: "黯淡失落", score: resonance([nTone, calmTone], 0.98), recipe: ["negative↑", "calmness↑"] },
    { label: "平静观测", score: 0.43, recipe: ["fallback"] },
  ].sort((left, right) => right.score - left.score);

  return {
    values,
    baseline,
    relative: rel,
    passionModulation,
    counterbalance,
    top: archetypes.slice(0, 8),
    all: archetypes,
  };
}

function scenario(name, values, baseline) {
  return { name, ...evaluate(values, baseline) };
}

function buildScenarios() {
  const allMid = Object.fromEntries(Object.keys(DEFAULTS).map((axis) => [axis, 0.5]));
  const lowMidHigh = [0.2, 0.5, 0.8];
  const scenarios = [
    scenario("默认状态 / 默认baseline", {}, {}),
    scenario("全轴0.5 / baseline0.5", allMid, allMid),
    scenario("全轴默认值 / baseline0.5", DEFAULTS, allMid),
    scenario("正负唤醒全中值 / 其他默认", { positive: 0.5, negative: 0.5, arousal: 0.5 }, {}),
    scenario("高正性高唤醒", { positive: 0.8, negative: 0.2, arousal: 0.8 }, {}),
    scenario("高负性高唤醒", { positive: 0.2, negative: 0.8, arousal: 0.8 }, {}),
    scenario("高正性低唤醒", { positive: 0.8, negative: 0.2, arousal: 0.2 }, {}),
    scenario("高负性低唤醒", { positive: 0.2, negative: 0.8, arousal: 0.2 }, {}),
    scenario("libido+cold+numb 同升", { libido: 0.8, coldness: 0.8, numbness: 0.8, positive: 0.45, negative: 0.45, arousal: 0.45 }, {}),
    scenario("passion+positive+curiosity 同升", { passion: 0.8, positive: 0.8, curiosity: 0.8, arousal: 0.7 }, {}),
    scenario("self_punishment+negative 同升", { self_punishment: 0.8, negative: 0.8, arousal: 0.75 }, {}),
    scenario("numbness+coldness 高，低效价低驱力", { numbness: 0.8, coldness: 0.8, positive: 0.15, negative: 0.15, arousal: 0.2, curiosity: 0.1, libido: 0.1, hedonia: 0.1, arrogance: 0.1 }, {}),
  ];

  for (const p of lowMidHigh) {
    for (const n of lowMidHigh) {
      for (const a of lowMidHigh) {
        scenarios.push(scenario(`PNA网格 p=${p} n=${n} a=${a}`, { positive: p, negative: n, arousal: a }, {}));
      }
    }
  }

  return scenarios;
}

function printScenario(item) {
  console.log(`\n=== ${item.name} ===`);
  console.log(`values: p=${item.values.positive} n=${item.values.negative} a=${item.values.arousal} passion=${item.values.passion} libido=${item.values.libido} hedonia=${item.values.hedonia} cold=${item.values.coldness} numb=${item.values.numbness}`);
  console.log(`passionGain=${item.passionModulation.positiveGain} counterSuppression=${item.passionModulation.counterSuppression}`);
  console.table(item.top.map((entry, index) => ({
    rank: index + 1,
    label: entry.label,
    score: entry.score,
    recipe: entry.recipe.join(" + "),
  })));
}

function printSummary(scenarios) {
  const primaryCounts = new Map();
  const overFallbackCounts = new Map();
  for (const item of scenarios) {
    const primary = item.top[0] && item.top[0].label;
    primaryCounts.set(primary, (primaryCounts.get(primary) || 0) + 1);
    for (const entry of item.all) {
      if (entry.label !== "平静观测" && entry.score > 0.43) {
        overFallbackCounts.set(entry.label, (overFallbackCounts.get(entry.label) || 0) + 1);
      }
    }
  }

  console.log("\n=== Primary标签分布 ===");
  console.table([...primaryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count })));

  console.log("\n=== 超过 fallback(0.43) 的频次 ===");
  console.table([...overFallbackCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count })));
}

function main() {
  const scenarios = buildScenarios();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(scenarios, null, 2));
    return;
  }
  for (const item of scenarios) printScenario(item);
  printSummary(scenarios);
}

main();