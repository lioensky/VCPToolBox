"use strict";

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

const DEFAULT_BASELINE = {
  inquiry: 0.35,
  discernment: 0.4,
  refusal: 0.28,
  positive: 0.32,
  negative: 0.22,
  arousal: 0.32,
  passion: 0.30,
  curiosity: 0.38,
  arrogance: 0.24,
  libido: 0.11,
  hedonia: 0.28,
  coldness: 0.16,
  fear: 0.18,
  numbness: 0.12,
  self_punishment: 0.08,
};

const FAMILY_DEFINITIONS = [
  {
    id: "affective_core",
    label: "情绪底色",
    gate: ["affectiveSignal"],
    states: [
      {
        id: "bright_surge",
        label: "明亮跃动",
        required: ["pTone", "aTone"],
        support: ["warmth"],
        against: ["nTone", "shutdown"],
        recipe: ["positive↑", "arousal↑", "warmth"],
      },
      {
        id: "gentle_quiet",
        label: "温和宁静",
        required: ["pTone", "calmTone"],
        support: ["warmth", "hedonicEase"],
        against: ["threat", "aTone"],
        recipe: ["positive↑", "calmness↑", "warmth"],
      },
      {
        id: "agitated_dark",
        label: "焦灼受压",
        required: ["nTone", "aTone"],
        support: ["threat"],
        against: ["pTone", "calmTone"],
        recipe: ["negative↑", "arousal↑", "threat"],
      },
      {
        id: "dim_sinking",
        label: "黯淡下沉",
        required: ["nTone", "calmTone"],
        support: ["shutdown"],
        against: ["pTone", "aTone"],
        recipe: ["negative↑", "calmness↑", "shutdown"],
      },
      {
        id: "mixed_tension",
        label: "矛盾拉扯",
        required: ["tension", "aTone"],
        support: ["pTone", "nTone"],
        against: ["calmTone"],
        recipe: ["positive↑", "negative↑", "arousal↑"],
      },
    ],
  },
  {
    id: "erotic",
    label: "亲密欲望",
    gate: ["eroticity"],
    states: [
      {
        id: "warm_erotic_flow",
        label: "情热流动",
        required: ["eroticity", "warmth"],
        support: ["aTone", "passionGain"],
        against: ["inhibition", "shutdown"],
        recipe: ["libido↑", "warmth↑", "arousal/passion"],
      },
      {
        id: "soft_closeness",
        label: "绵软亲昵",
        required: ["eroticity", "calmTone"],
        support: ["hedonicEase", "warmth"],
        against: ["threat", "coldnessUp"],
        recipe: ["libido↑", "calmness↑", "hedonia/warmth"],
      },
      {
        id: "anxious_desire",
        label: "欲念焦灼",
        required: ["eroticity", "threat", "aTone"],
        support: ["fearUp"],
        against: ["calmTone", "numbnessUp"],
        recipe: ["libido↑", "threat↑", "arousal↑"],
      },
      {
        id: "cold_tension",
        label: "冷感欲张",
        required: ["eroticity", "coldnessUp", "tension"],
        support: ["aTone", "refusalUp"],
        against: ["numbnessUp", "shutdown", "hedonicEase"],
        recipe: ["libido↑", "coldness↑", "tension↑", "numbness↓"],
      },
      {
        id: "numb_desire",
        label: "冷欲浮起",
        required: ["eroticity", "numbnessUp", "calmTone"],
        support: ["coldnessUp"],
        against: ["aTone", "threat"],
        recipe: ["libido↑", "numbness↑", "calmness↑"],
      },
      {
        id: "blocked_heat",
        label: "情热压抑",
        required: ["desirePressure", "inhibition"],
        support: ["passionGain", "warmth"],
        against: ["shutdown"],
        recipe: ["desire/drive↑", "inhibition↑", "blocked"],
      },
    ],
  },
  {
    id: "defensive",
    label: "防御退避",
    gate: ["defenseSignal"],
    states: [
      {
        id: "fear_retreat",
        label: "惊惧退守",
        required: ["fearUp", "threat", "aTone"],
        support: ["refusalUp"],
        against: ["pTone", "calmTone"],
        recipe: ["fear↑", "negative↑", "arousal↑"],
      },
      {
        id: "careful_ice",
        label: "如履薄冰",
        required: ["fearUp", "discernmentUp", "calmTone"],
        support: ["refusalUp"],
        against: ["aTone"],
        recipe: ["fear↑", "discernment↑", "calmness↑"],
      },
      {
        id: "cold_boundary",
        label: "霜冷拒守",
        required: ["refusalUp", "coldnessUp"],
        support: ["threat"],
        against: ["warmth", "eroticity"],
        recipe: ["refusal↑", "coldness↑", "boundary"],
      },
      {
        id: "frozen_shutdown",
        label: "封冻结壳",
        required: ["shutdown", "coldnessUp", "numbnessUp"],
        support: ["lowDrive", "calmTone"],
        against: ["warmth", "aTone", "eroticity"],
        recipe: ["shutdown↑", "coldness↑", "numbness↑"],
      },
      {
        id: "thawing",
        label: "冰封初释",
        required: ["numbnessDown", "reengagement"],
        support: ["pTone"],
        against: ["shutdown", "coldnessUp"],
        recipe: ["numbness↓", "drive/warmth↑"],
      },
    ],
  },
  {
    id: "motivation",
    label: "驱动探索",
    gate: ["motivationSignal"],
    states: [
      {
        id: "ignited_passion",
        label: "热情点燃",
        required: ["passionUp", "warmth"],
        support: ["aTone", "curiosityUp"],
        against: ["shutdown", "inhibition"],
        recipe: ["passion↑", "warmth↑", "drive↑"],
      },
      {
        id: "seeking_fire",
        label: "探求炽热",
        required: ["curiosityUp", "inquiryUp"],
        support: ["aTone", "passionUp"],
        against: ["refusalUp", "shutdown"],
        recipe: ["curiosity↑", "inquiry↑", "arousal/passion"],
      },
      {
        id: "quiet_insight",
        label: "幽微洞察",
        required: ["discernmentUp", "inquiryUp", "calmTone"],
        support: ["clarity"],
        against: ["aTone", "arroganceUp"],
        recipe: ["discernment↑", "inquiry↑", "calmness↑"],
      },
      {
        id: "lazy_sink",
        label: "慵懒沉陷",
        required: ["hedonicEase", "calmTone"],
        support: ["pTone"],
        against: ["inquiryUp", "aTone", "threat"],
        recipe: ["hedonia↑", "calmness↑", "low threat"],
      },
    ],
  },
  {
    id: "self_valuation",
    label: "自我估值",
    gate: ["selfSignal"],
    states: [
      {
        id: "exalted_pride",
        label: "昂扬自恃",
        required: ["arroganceUp", "pTone"],
        support: ["aTone", "passionGain"],
        against: ["fearUp", "discernmentUp"],
        recipe: ["arrogance↑", "positive↑", "confidence"],
      },
      {
        id: "cold_superiority",
        label: "冷傲旁观",
        required: ["arroganceUp", "coldnessUp"],
        support: ["calmTone"],
        against: ["warmth", "fearUp"],
        recipe: ["arrogance↑", "coldness↑", "calmness↑"],
      },
      {
        id: "bravado",
        label: "虚张声势",
        required: ["arroganceUp", "fearUp"],
        support: ["aTone"],
        against: ["calmTone", "discernmentUp"],
        recipe: ["arrogance↑", "fear↑", "compensation"],
      },
      {
        id: "self_ruin",
        label: "渊底自毁",
        required: ["selfPunishmentUp", "selfPunishmentUp", "threat", "nTone"],
        support: ["aTone", "fearUp"],
        against: ["pTone", "warmth", "hedonicEase", "passionUp"],
        recipe: ["self_punishment↑↑", "negative↑", "threat", "collapse"],
        weight: 0.7,
      },
      {
        id: "guilty_indulgence",
        label: "耽于逸乐",
        required: ["hedonicEase", "selfPunishmentUp", "selfPunishmentUp"],
        support: ["tension"],
        against: ["clarity", "calmTone", "warmth"],
        recipe: ["hedonia↑", "self_punishment↑↑", "tension"],
        weight: 0.75,
      },
    ],
  },
];

function clamp01(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

function round4(value) {
  return Number(clamp01(value).toFixed(4));
}

function geometricMean(values, epsilon = 0.02) {
  const safe = values.map((value) => Math.max(epsilon, clamp01(value)));
  const product = safe.reduce((acc, value) => acc * value, 1);
  return Math.pow(product, 1 / Math.max(1, safe.length));
}

function weightedMean(values) {
  if (!values.length) return 0.5;
  return values.reduce((acc, value) => acc + clamp01(value), 0) / values.length;
}

function defaultRelativeActivation(value, base, k = 2.2) {
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

function affectiveSalience(value, neutral = 0.5, k = 1.55) {
  const aboveRaw = Math.max(0, clamp01(value) - clamp01(neutral)) / Math.max(0.05, 1 - clamp01(neutral));
  return round4(Math.pow(clamp01(aboveRaw), 1 / k));
}

function readAxis(state, layer, axis, helpers) {
  if (helpers && typeof helpers.getAxisValue === "function") return clamp01(helpers.getAxisValue(state, layer, axis));
  const value = state && state[layer] && state[layer][axis] ? state[layer][axis].value : DEFAULT_BASELINE[axis];
  return clamp01(value);
}

function readBaseline(state, axis, helpers) {
  if (helpers && typeof helpers.getAxisBaseline === "function") return clamp01(helpers.getAxisBaseline(state, axis));
  return clamp01(DEFAULT_BASELINE[axis]);
}

function buildMoodFeatures(state, p, n, a, helpers = {}) {
  const values = { positive: clamp01(p), negative: clamp01(n), arousal: clamp01(a) };
  const rel = {};
  for (const axis of DRIVE_AXES) {
    values[axis] = readAxis(state, "drive", axis, helpers);
    const relative = helpers.relativeActivation || defaultRelativeActivation;
    rel[axis] = relative(values[axis], readBaseline(state, axis, helpers));
  }
  for (const axis of COGNITIVE_AXES) {
    values[axis] = readAxis(state, "cognitive", axis, helpers);
    const relative = helpers.relativeActivation || defaultRelativeActivation;
    rel[axis] = relative(values[axis], readBaseline(state, axis, helpers));
  }

  const up = (axis) => (rel[axis] ? rel[axis].above : 0);
  const down = (axis) => (rel[axis] ? rel[axis].below : 0);
  const calmness = 1 - values.arousal;
  const pTone = affectiveSalience(values.positive, 0.5);
  const nTone = affectiveSalience(values.negative, 0.5);
  const aTone = affectiveSalience(values.arousal, 0.5);
  const calmTone = affectiveSalience(calmness, 0.72);
  const passionModulation = state && state.coupling ? state.coupling.lastPassionModulation : null;
  const passionGain = clamp01(passionModulation ? passionModulation.positiveGain : up("passion"));
  const expansiveDrive = Math.max(up("curiosity"), up("libido"), up("hedonia"), up("arrogance"));
  const inhibition = Math.max(up("coldness") * 0.9, up("numbness"), up("fear") * 0.85, up("self_punishment") * 0.75);
  const warmth = round4(weightedMean([pTone, up("passion"), up("hedonia")]));
  const threat = round4(weightedMean([nTone, up("fear"), up("refusal")]));
  const clarity = round4(weightedMean([up("inquiry"), up("discernment")]));
  const shutdown = round4(geometricMean([up("numbness"), up("coldness"), calmTone, 1 - expansiveDrive], 0.01));
  const desirePressure = round4(weightedMean([up("libido"), inhibition, passionGain]));
  const reengagement = Math.max(up("curiosity"), up("passion"), up("libido"), warmth);

  const features = {
    pTone,
    nTone,
    aTone,
    calmTone,
    tension: round4(Math.min(values.positive, values.negative)),
    affectiveSignal: Math.max(pTone, nTone, aTone, calmTone),
    eroticity: up("libido"),
    passionUp: up("passion"),
    curiosityUp: up("curiosity"),
    hedonicEase: up("hedonia"),
    coldnessUp: up("coldness"),
    numbnessUp: up("numbness"),
    numbnessDown: down("numbness"),
    fearUp: up("fear"),
    selfPunishmentUp: up("self_punishment"),
    arroganceUp: up("arrogance"),
    inquiryUp: up("inquiry"),
    discernmentUp: up("discernment"),
    refusalUp: up("refusal"),
    passionGain,
    expansiveDrive,
    lowDrive: 1 - expansiveDrive,
    inhibition,
    warmth,
    threat,
    clarity,
    shutdown,
    desirePressure,
    defenseSignal: Math.max(threat, inhibition, up("refusal"), up("fear")),
    motivationSignal: Math.max(up("passion"), up("curiosity"), up("inquiry"), up("hedonia")),
    selfSignal: Math.max(up("arrogance"), up("self_punishment"), up("fear")),
    reengagement,
  };

  return { values, relative: rel, features: Object.fromEntries(Object.entries(features).map(([key, value]) => [key, round4(value)])) };
}

function scoreState(definition, features) {
  const required = definition.required.map((key) => features[key] || 0);
  const support = (definition.support || []).map((key) => features[key] || 0);
  const against = (definition.against || []).map((key) => features[key] || 0);
  const requiredScore = geometricMean(required, 0.015);
  const supportScore = support.length ? weightedMean(support) : 0.5;
  const penalty = 1 - Math.min(0.78, weightedMean(against) * 0.68);
  const complexity = Math.pow(Math.max(1, definition.required.length), 0.08);
  const stateWeight = Number.isFinite(Number(definition.weight)) ? clamp01(Number(definition.weight)) : 1;
  const score = round4(requiredScore * (0.72 + supportScore * 0.28) * penalty * complexity * stateWeight);
  return {
    stateId: definition.id,
    label: definition.label,
    score,
    recipe: definition.recipe,
    evidence: {
      required: Object.fromEntries(definition.required.map((key, index) => [key, round4(required[index])])),
      support: Object.fromEntries((definition.support || []).map((key, index) => [key, round4(support[index])])),
      against: Object.fromEntries((definition.against || []).map((key, index) => [key, round4(against[index])])),
      requiredScore: round4(requiredScore),
      supportScore: round4(supportScore),
      penalty: round4(penalty),
    },
  };
}

function scoreFamily(family, features) {
  const gateScore = geometricMean(family.gate.map((key) => features[key] || 0), 0.01);
  const states = family.states.map((state) => {
    const scored = scoreState(state, features);
    return { ...scored, family: family.id, familyLabel: family.label, score: round4(scored.score * gateScore) };
  }).sort((left, right) => right.score - left.score);
  return {
    family: family.id,
    label: family.label,
    gate: round4(gateScore),
    primary: states[0],
    states,
    activation: states[0] ? states[0].score : 0,
  };
}

function fallbackState(features) {
  const signalGaps = [
    1 - features.affectiveSignal,
    1 - features.motivationSignal,
    1 - features.defenseSignal,
    1 - features.eroticity,
    1 - features.selfSignal,
  ].map(clamp01);
  const minGap = Math.min(...signalGaps);
  const geoGap = geometricMean(signalGaps, 0.01);
  const stillness = clamp01(minGap * 0.58 + geoGap * 0.42);
  return {
    stateId: "calm_observation",
    label: "平静观测",
    family: "fallback",
    familyLabel: "基线",
    score: round4(stillness * 0.72),
    recipe: ["low global signal"],
    evidence: { stillness: round4(stillness), minGap: round4(minGap), geoGap: round4(geoGap) },
  };
}

function applyHysteresis(candidates, previous, margin = 0.045) {
  if (!previous || !previous.stateId || candidates.length < 2) return { candidates, transition: { changed: true, reason: "no_previous_state" } };
  const current = candidates[0];
  if (current.stateId === previous.stateId) return { candidates, transition: { changed: false, reason: "same_state" } };
  const previousCandidate = candidates.find((item) => item.stateId === previous.stateId);
  if (!previousCandidate) return { candidates, transition: { changed: true, reason: "previous_state_not_candidate" } };
  const sameFamily = current.family === previousCandidate.family;
  const requiredMargin = sameFamily ? margin : margin * 1.6;
  if (current.score - previousCandidate.score < requiredMargin && previousCandidate.score > 0.22) {
    const reordered = [previousCandidate, ...candidates.filter((item) => item.stateId !== previousCandidate.stateId)];
    return { candidates: reordered, transition: { changed: false, reason: "hysteresis_hold", requiredMargin: round4(requiredMargin) } };
  }
  return { candidates, transition: { changed: true, reason: "margin_exceeded", requiredMargin: round4(requiredMargin) } };
}

function evaluateMoodStateMachine(state, p, n, a, helpers = {}) {
  const featurePack = buildMoodFeatures(state, p, n, a, helpers);
  const families = FAMILY_DEFINITIONS.map((family) => scoreFamily(family, featurePack.features));
  const fallback = fallbackState(featurePack.features);
  const rawCandidates = [
    ...families.map((family) => family.primary).filter(Boolean),
    fallback,
  ].sort((left, right) => right.score - left.score);

  const previous = state && state.lastObservation && state.lastObservation.mood && state.lastObservation.mood.archetypes
    ? state.lastObservation.mood.archetypes.primary
    : null;
  const adjudicated = applyHysteresis(rawCandidates, previous);
  const candidates = adjudicated.candidates.slice(0, 5).map((item, index, list) => ({
    label: item.label,
    stateId: item.stateId,
    family: item.family,
    familyLabel: item.familyLabel,
    score: round4(item.score),
    confidence: round4(index === 0 ? item.score - ((list[1] && list[1].score) || 0) : 0),
    recipe: item.recipe,
    evidence: item.evidence,
  }));

  return {
    primary: candidates[0],
    secondary: candidates[1] || null,
    candidates,
    families: families.map((family) => ({
      family: family.family,
      label: family.label,
      gate: family.gate,
      activation: family.activation,
      primary: family.primary ? {
        stateId: family.primary.stateId,
        label: family.primary.label,
        score: family.primary.score,
      } : null,
    })),
    features: featurePack.features,
    values: featurePack.values,
    relative: Object.fromEntries(Object.entries(featurePack.relative).map(([axis, item]) => [
      axis,
      { base: item.base, delta: item.delta, above: item.above, below: item.below },
    ])),
    transition: adjudicated.transition,
  };
}

module.exports = {
  evaluateMoodStateMachine,
  buildMoodFeatures,
  scoreFamily,
  scoreState,
};