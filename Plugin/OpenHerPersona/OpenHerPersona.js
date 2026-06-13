"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const chokidar = require("chokidar");
let Database = null;
try {
  Database = require("better-sqlite3");
} catch (error) {
  Database = null;
}
const {
  isBetaSystemUserText,
  isSystemNotificationText,
} = require("../../modules/messageProcessor.js");
const { getEmbeddingsBatch, cosineSimilarity } = require("../../EmbeddingUtils.js");

const PLUGIN_NAME = "OpenHerPersona";
const PLUGIN_VERSION = "0.5.1";

const DRIVES = ["connection", "novelty", "expression", "safety", "play"];
const SIGNALS = [
  "directness",
  "vulnerability",
  "playfulness",
  "initiative",
  "depth",
  "warmth",
  "defiance",
  "curiosity",
];
const CONTEXT_FEATURES = [
  "engagement",
  "constraint",
  "technicality",
  "playfulness",
  "affection",
  "urgency",
  "novelty",
  "depth",
];
const HIDDEN_SIZE = 10;
const RECURRENT_SIZE = 4;

const DRIVE_LABELS = {
  connection: "联结",
  novelty: "新鲜",
  expression: "表达",
  safety: "安全",
  play: "玩闹",
};

const SIGNAL_LABELS = {
  directness: "直接度",
  vulnerability: "坦露度",
  playfulness: "玩闹度",
  initiative: "主动度",
  depth: "深度",
  warmth: "温暖度",
  defiance: "倔强度",
  curiosity: "好奇度",
};

const DEFAULT_DRIVE_BASELINE = {
  connection: 0.55,
  novelty: 0.45,
  expression: 0.5,
  safety: 0.4,
  play: 0.45,
};

const DEFAULT_SIGNALS = {
  directness: 0.55,
  vulnerability: 0.35,
  playfulness: 0.45,
  initiative: 0.5,
  depth: 0.55,
  warmth: 0.62,
  defiance: 0.25,
  curiosity: 0.58,
};

const DEFAULT_CONFIG = {
  DebugMode: false,
  OpenHerPersonaEnabled: true,
  OpenHerPersonaHintEnabled: true,
  OpenHerPersonaObserveOnly: false,
  OpenHerPersonaTickEnabled: true,
  OpenHerPersonaCooldownMinutes: 240,
  OpenHerPersonaImpulseThreshold: 0.8,
  OpenHerPersonaTemperamentSpread: 0.13,
  OpenHerPersonaSemanticContext: true,
  OpenHerPersonaSemanticWeight: 0.5,
  OpenHerPersonaPhaseEnabled: true,
  OpenHerPersonaEruptionCooldownMinutes: 90,
  OpenHerPersonaBurstEnabled: true,
  OpenHerPersonaBurstMode: "auto",
  OpenHerPersonaHtmlHintEnabled: true,
};
const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

const PERSONA_HINT_PATTERN = /<!--persona_state_hint[\s\S]*?-->\s*/g;
const PERSONA_DELTA_MARKER_PATTERN = /<!--\s*persona_delta\s*:/g;
const PERSONA_EXPRESSION_MARKER_PATTERN = /<!--\s*persona_expression\s*:/g;
const SYSTEM_PROMPT_USER_PATTERN = /^\s*\[系统提示[:：]?\]/;
const MAX_APPLIED_DELTAS = 120;
const MAX_APPLIED_EXPRESSIONS = 80;

const DEFAULT_CONTEXT = {
  engagement: 0.35,
  constraint: 0.2,
  technicality: 0.25,
  playfulness: 0.25,
  affection: 0.25,
  urgency: 0.2,
  novelty: 0.35,
  depth: 0.45,
};

const DEFAULT_EXPRESSION = {
  mode: "text",
  label: "文字为主",
  pace: "balanced",
  intensity: 0.35,
  emoji: false,
  silence: false,
  burst: false,
  burstSegments: [2, 4],
  reason: "初始平稳",
  modelChoice: null,
  updatedAt: null,
};

const EXPRESSION_MODE_LABELS = {
  text: "文字为主",
  long_text: "长文展开",
  voice_like: "语音感",
  emoji_like: "表情感",
  reserved: "克制短句",
};

const EXPRESSION_PACE_LABELS = {
  short: "短句",
  balanced: "平稳",
  flowing: "流动",
  long: "展开",
};

const BASELINE_LR = 0.012;
const BASELINE_ELASTICITY = 0.02;
const AGENT_BASELINE_SEED_SPREAD = 0.08;
// Model-fed signal_delta accumulates into a slow per-agent bias so self-shaping persists across turns.
const SIGNAL_BIAS_MAX = 0.25;
const SIGNAL_BIAS_DECAY = 0.985;
// persona_delta impact tiers: the model declares how hard an emotional event hit.
// Bigger tiers unlock bigger one-shot changes and fold into signalBias faster
// (big events leave deeper marks). major additionally allows frustration_set.
const PERSONA_DELTA_IMPACT_TIERS = {
  minor: { drive: 0.8, signal: 0.18, biasLr: 0.25, allowSet: false, charge: 0.04, plasticity: 0.001 },
  moderate: { drive: 1.5, signal: 0.35, biasLr: 0.35, allowSet: false, charge: 0.18, plasticity: 0.004 },
  major: { drive: 3, signal: 0.6, biasLr: 0.5, allowSet: true, charge: 0.4, plasticity: 0.012 },
};
const MAJOR_IMPACT_COOLDOWN_MS = 30 * 60 * 1000;

// Per-agent metabolic constitution: seeded multipliers on drive growth/relief,
// slowly sensitized by emotional events and elastically pulled back to origin.
const METABOLISM_SEED_SPREAD = 0.18;
const METABOLISM_GAIN_MIN = 0.6;
const METABOLISM_GAIN_MAX = 1.5;
const METABOLISM_PULLBACK = 0.002;

// Emotional phase transition: pressure charge accumulates from sustained heat,
// safety hits, and distress-tier deltas; crossing the threshold erupts for one
// turn, then cools. Affectionate context discharges pressure / ends cooling.
const PHASE_ERUPTION_THRESHOLD = 1;
const PHASE_STRAIN_THRESHOLD = 0.6;
const PHASE_CHARGE_MAX = 1.2;
const PHASE_COOLING_MAX_TURNS = 2;
const PHASE_COOLING_MAX_MS = 45 * 60 * 1000;
const PHASE_NAMES = ["grounded", "strained", "eruption", "cooling"];
// Mood inertia: signals chase the computed target instead of snapping to it; heat raises responsiveness.
const MOOD_BASE_RESPONSIVENESS = 0.45;
const MOOD_THERMAL_RESPONSIVENESS = 0.25;

const STATE_DIR = path.join(__dirname, "state");
const STATE_PATH = path.join(STATE_DIR, "openher-persona-state.json");
const STATE_DB_PATH = path.join(STATE_DIR, "openher-persona-state.sqlite");
const CONFIG_PATH = path.join(STATE_DIR, "openher-persona-config.json");
const STATE_STORE_VERSION = 3;
const DEFAULT_AGENT_KEY = "__default__";
const DEFAULT_AGENT_LABEL = "default";
const MAX_AGENT_KEY_LENGTH = 80;
const ONE_RING_TRIGGER_PATTERN = /\[\[\s*OneRing\s*[:：]{2}\s*([^:：\]\r\n]+?)\s*[:：]{2}\s*([^:：\]\r\n]+?)\s*(?:[:：]{2}\s*([^\]\r\n]+?)\s*)?\]\]/gi;
const ONE_RING_NOTICE_PATTERN = /\[OneRing系统已启动，当前Agent([^，\]\r\n]+)，当前客户端([^，\]\r\n]+)(?:，当前模式([^，\]\r\n]+))?/g;
const VCP_RAG_BLOCK_PATTERN = /<!--\s*VCP_RAG_BLOCK_START\b[\s\S]*?<!--\s*VCP_RAG_BLOCK_END\s*-->/gi;

let activeConfig = { ...DEFAULT_CONFIG };
let configWatcher = null;
let lastConfigWriteAt = 0;
let contextBridge = null;
let stateStore = createDefaultStateStore();
let state = stateStore.agents[DEFAULT_AGENT_KEY];
let activeAgentKey = DEFAULT_AGENT_KEY;
let legacySingleStatePending = false;
let activeClientLabel = null;
let activeClientIsVcpChat = false;

function nowIso() {
  return new Date().toISOString();
}

function normalizeAgentKey(value) {
  const text = String(value || "").replace(/[\0\r\n\t]/g, " ").trim();
  return text ? text.slice(0, MAX_AGENT_KEY_LENGTH) : DEFAULT_AGENT_KEY;
}

function normalizeAgentLabel(value, fallback = DEFAULT_AGENT_LABEL) {
  const text = String(value || "").replace(/[\0\r\n\t]/g, " ").trim();
  return text ? text.slice(0, MAX_AGENT_KEY_LENGTH) : fallback;
}

function deriveAgentInitialDriveBaseline(agentKey) {
  const key = normalizeAgentKey(agentKey);
  if (key === DEFAULT_AGENT_KEY) return { ...DEFAULT_DRIVE_BASELINE };
  return Object.fromEntries(
    DRIVES.map((drive) => [
      drive,
      Number(
        Math.max(
          0.1,
          Math.min(
            0.95,
            DEFAULT_DRIVE_BASELINE[drive] +
              deterministicWeight(`openherpersona:v3:agent-baseline:${key}:${drive}`) * AGENT_BASELINE_SEED_SPREAD
          )
        ).toFixed(4)
      ),
    ])
  );
}

// Persistent per-agent trait offsets. Unlike the old one-shot signal seeds (which the
// first metabolism pass overwrote), temperament is re-applied on every signal recompute,
// so different agents keep genuinely different personalities over time.
function deriveAgentTemperament(agentKey, spread = activeConfig.OpenHerPersonaTemperamentSpread) {
  const key = normalizeAgentKey(agentKey);
  if (key === DEFAULT_AGENT_KEY) {
    return Object.fromEntries(SIGNALS.map((signal) => [signal, 0]));
  }
  return Object.fromEntries(
    SIGNALS.map((signal) => [
      signal,
      Number((deterministicWeight(`openherpersona:v3:temperament:${key}:${signal}`) * spread).toFixed(4)),
    ])
  );
}

function normalizeTemperament(raw, agentKey) {
  const derived = deriveAgentTemperament(agentKey);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return derived;
  return Object.fromEntries(
    SIGNALS.map((signal) => {
      const value = Number(raw[signal]);
      return [signal, Number.isFinite(value) ? Math.max(-0.4, Math.min(0.4, value)) : derived[signal]];
    })
  );
}

function normalizeSignalBias(raw) {
  return Object.fromEntries(
    SIGNALS.map((signal) => {
      const value = Number(raw && raw[signal]);
      return [signal, Number.isFinite(value) ? Math.max(-SIGNAL_BIAS_MAX, Math.min(SIGNAL_BIAS_MAX, value)) : 0];
    })
  );
}

function clampMetabolismGain(value) {
  return Math.max(METABOLISM_GAIN_MIN, Math.min(METABOLISM_GAIN_MAX, value));
}

// Per-agent metabolic constitution: how fast each drive's longing builds and how
// easily it is soothed. Seeded from the agent key; evolves slowly (plasticity).
function deriveAgentMetabolism(agentKey) {
  const key = normalizeAgentKey(agentKey);
  const seedGain = (kind, drive) =>
    key === DEFAULT_AGENT_KEY
      ? 1
      : Number(
          clampMetabolismGain(
            1 + deterministicWeight(`openherpersona:v4:metabolism:${key}:${kind}:${drive}`) * METABOLISM_SEED_SPREAD
          ).toFixed(4)
        );
  return {
    growthGain: Object.fromEntries(DRIVES.map((drive) => [drive, seedGain("growth", drive)])),
    reliefGain: Object.fromEntries(DRIVES.map((drive) => [drive, seedGain("relief", drive)])),
  };
}

function normalizeMetabolism(raw, agentKey) {
  const derived = deriveAgentMetabolism(agentKey);
  const pick = (map, derivedMap) =>
    Object.fromEntries(
      DRIVES.map((drive) => {
        const value = Number(map && map[drive]);
        return [drive, Number.isFinite(value) ? clampMetabolismGain(value) : derivedMap[drive]];
      })
    );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return derived;
  return {
    growthGain: pick(raw.growthGain, derived.growthGain),
    reliefGain: pick(raw.reliefGain, derived.reliefGain),
  };
}

function normalizePhase(raw) {
  const base = { name: "grounded", charge: 0, enteredAt: null, lastEruptionAt: null, coolingTurns: 0 };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const charge = Number(raw.charge);
  return {
    name: PHASE_NAMES.includes(raw.name) ? raw.name : base.name,
    charge: Number.isFinite(charge) ? Math.max(0, Math.min(PHASE_CHARGE_MAX, charge)) : 0,
    enteredAt: typeof raw.enteredAt === "string" ? raw.enteredAt : null,
    lastEruptionAt: typeof raw.lastEruptionAt === "string" ? raw.lastEruptionAt : null,
    coolingTurns: Number.isFinite(Number(raw.coolingTurns)) ? Math.max(0, Math.floor(Number(raw.coolingTurns))) : 0,
  };
}

function deriveAgentInitialSignals(agentKey) {
  const temperament = deriveAgentTemperament(agentKey);
  return Object.fromEntries(
    SIGNALS.map((signal) => [signal, Number(clamp01(DEFAULT_SIGNALS[signal] + temperament[signal]).toFixed(4))])
  );
}

function createDefaultState(agentKey = DEFAULT_AGENT_KEY, agentLabel = null) {
  const now = nowIso();
  const normalizedAgentKey = normalizeAgentKey(agentKey);
  const normalizedAgentLabel = normalizeAgentLabel(agentLabel || agentKey, normalizedAgentKey);
  return {
    version: 3,
    plugin: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    agentKey: normalizedAgentKey,
    agentLabel: normalizedAgentLabel,
    updatedAt: now,
    createdAt: now,
    lastActiveAt: null,
    lastTickAt: null,
    driveBaseline: deriveAgentInitialDriveBaseline(normalizedAgentKey),
    frustration: Object.fromEntries(DRIVES.map((drive) => [drive, 0])),
    signals: deriveAgentInitialSignals(normalizedAgentKey),
    temperament: deriveAgentTemperament(normalizedAgentKey),
    signalBias: Object.fromEntries(SIGNALS.map((signal) => [signal, 0])),
    metabolism: deriveAgentMetabolism(normalizedAgentKey),
    phase: normalizePhase(null),
    lastMajorImpactAt: null,
    cooldown: {
      minutes: DEFAULT_CONFIG.OpenHerPersonaCooldownMinutes,
      lastImpulseAt: null,
    },
    lastTurnFingerprint: null,
    turnCount: 0,
    appliedDeltaIds: [],
    appliedExpressionIds: [],
    lastAppliedPersonaDelta: null,
    genome: {
      recurrentState: Array.from({ length: RECURRENT_SIZE }, () => 0),
      lastContext: { ...DEFAULT_CONTEXT },
    },
    expression: { ...DEFAULT_EXPRESSION },
    trends: {
      frustration: Object.fromEntries(DRIVES.map((drive) => [drive, 0])),
      signals: Object.fromEntries(SIGNALS.map((signal) => [signal, 0])),
    },
    audit: [],
  };
}

function createDefaultStateStore() {
  const defaultState = createDefaultState(DEFAULT_AGENT_KEY, DEFAULT_AGENT_LABEL);
  return {
    schemaVersion: STATE_STORE_VERSION,
    plugin: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    updatedAt: defaultState.updatedAt,
    createdAt: defaultState.createdAt,
    activeAgentKey: DEFAULT_AGENT_KEY,
    agents: {
      [DEFAULT_AGENT_KEY]: defaultState,
    },
  };
}

function normalizeBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(lowered)) return true;
    if (["false", "0", "no", "off"].includes(lowered)) return false;
  }
  return fallback;
}

function normalizeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getConfigSchema() {
  return {
    DebugMode: { type: "boolean", label: "调试日志", description: "输出 OpenHerPersona 调试日志。" },
    OpenHerPersonaEnabled: { type: "boolean", label: "启用人格情绪", description: "总开关；关闭后不处理情绪状态。" },
    OpenHerPersonaHintEnabled: { type: "boolean", label: "注入情绪提示", description: "向系统提示词注入当前人格状态提示。" },
    OpenHerPersonaObserveOnly: { type: "boolean", label: "观察模式", description: "仅记录状态，不向提示词注入情绪提示。" },
    OpenHerPersonaTickEnabled: { type: "boolean", label: "启用 Tick", description: "允许时间代谢 Tick 更新驱力。" },
    OpenHerPersonaCooldownMinutes: { type: "integer", label: "冲动冷却分钟", min: 1, max: 10080 },
    OpenHerPersonaImpulseThreshold: { type: "number", label: "冲动阈值", min: 0, max: 5, step: 0.05 },
    OpenHerPersonaTemperamentSpread: { type: "number", label: "气质分散度", min: 0, max: 0.4, step: 0.01 },
    OpenHerPersonaSemanticContext: { type: "boolean", label: "语义上下文", description: "使用 embedding 语义锚点辅助判断语境。" },
    OpenHerPersonaSemanticWeight: { type: "number", label: "语义权重", min: 0, max: 1, step: 0.05 },
    OpenHerPersonaPhaseEnabled: { type: "boolean", label: "启用情绪相变", description: "允许紧绷、爆发、冷却状态机。" },
    OpenHerPersonaEruptionCooldownMinutes: { type: "integer", label: "爆发冷却分钟", min: 1, max: 10080 },
    OpenHerPersonaBurstEnabled: { type: "boolean", label: "启用分条倾向", description: "允许对 VCPChat 下发即时聊天分条提示。" },
    OpenHerPersonaBurstMode: { type: "select", label: "分条模式", options: ["auto", "always", "off"] },
    OpenHerPersonaHtmlHintEnabled: { type: "boolean", label: "HTML 表达提示", description: "允许对 VCPChat 下发轻量 HTML 表达提示。" },
  };
}

function resolveConfig(config) {
  const merged = { ...DEFAULT_CONFIG, ...(config || {}) };
  return {
    DebugMode: normalizeBoolean(merged.DebugMode, DEFAULT_CONFIG.DebugMode),
    OpenHerPersonaEnabled: normalizeBoolean(
      merged.OpenHerPersonaEnabled,
      DEFAULT_CONFIG.OpenHerPersonaEnabled
    ),
    OpenHerPersonaHintEnabled: normalizeBoolean(
      merged.OpenHerPersonaHintEnabled,
      DEFAULT_CONFIG.OpenHerPersonaHintEnabled
    ),
    OpenHerPersonaObserveOnly: normalizeBoolean(
      merged.OpenHerPersonaObserveOnly,
      DEFAULT_CONFIG.OpenHerPersonaObserveOnly
    ),
    OpenHerPersonaTickEnabled: normalizeBoolean(
      merged.OpenHerPersonaTickEnabled,
      DEFAULT_CONFIG.OpenHerPersonaTickEnabled
    ),
    OpenHerPersonaCooldownMinutes: Math.max(
      1,
      normalizeInteger(
        merged.OpenHerPersonaCooldownMinutes,
        DEFAULT_CONFIG.OpenHerPersonaCooldownMinutes
      )
    ),
    OpenHerPersonaImpulseThreshold: Math.max(
      0,
      normalizeNumber(
        merged.OpenHerPersonaImpulseThreshold,
        DEFAULT_CONFIG.OpenHerPersonaImpulseThreshold
      )
    ),
    OpenHerPersonaTemperamentSpread: Math.max(
      0,
      Math.min(
        0.4,
        normalizeNumber(
          merged.OpenHerPersonaTemperamentSpread,
          DEFAULT_CONFIG.OpenHerPersonaTemperamentSpread
        )
      )
    ),
    OpenHerPersonaSemanticContext: normalizeBoolean(
      merged.OpenHerPersonaSemanticContext,
      DEFAULT_CONFIG.OpenHerPersonaSemanticContext
    ),
    OpenHerPersonaSemanticWeight: Math.max(
      0,
      Math.min(
        1,
        normalizeNumber(
          merged.OpenHerPersonaSemanticWeight,
          DEFAULT_CONFIG.OpenHerPersonaSemanticWeight
        )
      )
    ),
    OpenHerPersonaPhaseEnabled: normalizeBoolean(
      merged.OpenHerPersonaPhaseEnabled,
      DEFAULT_CONFIG.OpenHerPersonaPhaseEnabled
    ),
    OpenHerPersonaEruptionCooldownMinutes: Math.max(
      1,
      normalizeInteger(
        merged.OpenHerPersonaEruptionCooldownMinutes,
        DEFAULT_CONFIG.OpenHerPersonaEruptionCooldownMinutes
      )
    ),
    OpenHerPersonaBurstEnabled: normalizeBoolean(
      merged.OpenHerPersonaBurstEnabled,
      DEFAULT_CONFIG.OpenHerPersonaBurstEnabled
    ),
    OpenHerPersonaBurstMode: ["auto", "always", "off"].includes(
      String(merged.OpenHerPersonaBurstMode || "").trim().toLowerCase()
    )
      ? String(merged.OpenHerPersonaBurstMode).trim().toLowerCase()
      : DEFAULT_CONFIG.OpenHerPersonaBurstMode,
    OpenHerPersonaHtmlHintEnabled: normalizeBoolean(
      merged.OpenHerPersonaHtmlHintEnabled,
      DEFAULT_CONFIG.OpenHerPersonaHtmlHintEnabled
    ),
  };
}

function readConfigFile() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch (error) {
    console.warn(`[${PLUGIN_NAME}] failed to read JSON config, using previous/default config: ${error.message}`);
    return null;
  }
}

function hasExplicitConfigOverrides(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  return CONFIG_KEYS.some((key) => Object.prototype.hasOwnProperty.call(config, key));
}

function shouldRefreshMigratedConfigFromEnv(existingDocument, envConfig = {}) {
  // JSON is the source of truth once it has been saved from the runtime/admin panel.
  // Before that point the file is only the automatic env/default migration artifact;
  // allowing explicit initialize() overrides to refresh it keeps tests and one-shot
  // env migration deterministic without letting stale env silently override a panel
  // managed JSON document.
  return (
    existingDocument &&
    existingDocument.migratedFromEnv !== false &&
    hasExplicitConfigOverrides(envConfig)
  );
}

function buildConfigDocument(config, migratedFromEnv = false) {
  return {
    schemaVersion: 1,
    plugin: PLUGIN_NAME,
    updatedAt: nowIso(),
    migratedFromEnv,
    config: resolveConfig(config),
  };
}

function writeConfigDocument(document) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmpPath = `${CONFIG_PATH}.tmp`;
  lastConfigWriteAt = Date.now();
  fs.writeFileSync(tmpPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, CONFIG_PATH);
}

function loadConfigFromJsonOrMigrate(envConfig = {}) {
  const existing = readConfigFile();
  if (existing && existing.config && typeof existing.config === "object") {
    if (shouldRefreshMigratedConfigFromEnv(existing, envConfig)) {
      const refreshed = buildConfigDocument({ ...existing.config, ...envConfig }, true);
      writeConfigDocument(refreshed);
      if (refreshed.config.DebugMode) {
        console.log(`[${PLUGIN_NAME}] JSON config refreshed from explicit initialize() overrides at ${CONFIG_PATH}.`);
      }
      return refreshed.config;
    }

    const normalized = resolveConfig(existing.config);
    const normalizedDoc = { ...existing, schemaVersion: 1, plugin: PLUGIN_NAME, updatedAt: existing.updatedAt || nowIso(), config: normalized };
    if (JSON.stringify(existing.config) !== JSON.stringify(normalized)) {
      writeConfigDocument(normalizedDoc);
    }
    return normalized;
  }

  const migrated = buildConfigDocument(envConfig, true);
  writeConfigDocument(migrated);
  console.log(`[${PLUGIN_NAME}] JSON config initialized at ${CONFIG_PATH}. Values were migrated from env/default config once; JSON is now the source of truth.`);
  return migrated.config;
}

function reloadConfigFromDisk(reason = "watch") {
  const document = readConfigFile();
  if (!document || !document.config || typeof document.config !== "object") return false;
  const nextConfig = resolveConfig(document.config);
  activeConfig = nextConfig;
  if (state && state.cooldown) {
    state.cooldown.minutes = activeConfig.OpenHerPersonaCooldownMinutes;
  }
  if (activeConfig.DebugMode) {
    console.log(`[${PLUGIN_NAME}] JSON config reloaded (${reason}).`);
  }
  return true;
}

function saveRuntimeConfig(nextConfig) {
  const normalized = resolveConfig(nextConfig);
  const document = buildConfigDocument(normalized, false);
  writeConfigDocument(document);
  activeConfig = normalized;
  if (state && state.cooldown) {
    state.cooldown.minutes = activeConfig.OpenHerPersonaCooldownMinutes;
  }
  return getConfigStatus();
}

function getConfigStatus() {
  return {
    status: "success",
    plugin: PLUGIN_NAME,
    path: CONFIG_PATH,
    schema: getConfigSchema(),
    defaults: { ...DEFAULT_CONFIG },
    config: { ...activeConfig },
    sourceOfTruth: "json",
  };
}

function startConfigWatcher() {
  if (configWatcher) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  configWatcher = chokidar.watch(CONFIG_PATH, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
  });
  configWatcher.on("add", () => reloadConfigFromDisk("add"));
  configWatcher.on("change", () => {
    if (Date.now() - lastConfigWriteAt < 300) return;
    reloadConfigFromDisk("change");
  });
  configWatcher.on("error", (error) => {
    console.warn(`[${PLUGIN_NAME}] config watcher error: ${error.message}`);
  });
  if (typeof configWatcher.unref === "function") {
    configWatcher.unref();
  }
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function clampFrustration(value) {
  return Math.max(0, Math.min(5, value));
}

function clampDelta(value, maxAbs) {
  return Math.max(-maxAbs, Math.min(maxAbs, value));
}

function normalizeContext(raw) {
  return Object.fromEntries(
    CONTEXT_FEATURES.map((key) => {
      const value = Number(raw && raw[key]);
      return [key, clamp01(Number.isFinite(value) ? value : DEFAULT_CONTEXT[key])];
    })
  );
}

function normalizeRecurrentState(raw) {
  const source = Array.isArray(raw) ? raw : [];
  return Array.from({ length: RECURRENT_SIZE }, (_, index) => {
    const value = Number(source[index]);
    return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  });
}

function normalizeExpression(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_EXPRESSION };
  return {
    ...DEFAULT_EXPRESSION,
    ...raw,
    mode: typeof raw.mode === "string" ? raw.mode.slice(0, 32) : DEFAULT_EXPRESSION.mode,
    label: typeof raw.label === "string" ? raw.label.slice(0, 48) : DEFAULT_EXPRESSION.label,
    pace: typeof raw.pace === "string" ? raw.pace.slice(0, 32) : DEFAULT_EXPRESSION.pace,
    intensity: Number.isFinite(Number(raw.intensity)) ? clamp01(Number(raw.intensity)) : DEFAULT_EXPRESSION.intensity,
    emoji: Boolean(raw.emoji),
    silence: Boolean(raw.silence),
    burst: Boolean(raw.burst),
    burstSegments:
      Array.isArray(raw.burstSegments) &&
      raw.burstSegments.length === 2 &&
      raw.burstSegments.every((n) => Number.isFinite(Number(n)) && Number(n) >= 1 && Number(n) <= 8)
        ? [Math.floor(Number(raw.burstSegments[0])), Math.floor(Number(raw.burstSegments[1]))]
        : [...DEFAULT_EXPRESSION.burstSegments],
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 120) : DEFAULT_EXPRESSION.reason,
    modelChoice:
      raw.modelChoice && typeof raw.modelChoice === "object" && !Array.isArray(raw.modelChoice)
        ? {
            mode: typeof raw.modelChoice.mode === "string" ? raw.modelChoice.mode.slice(0, 32) : "unknown",
            pace: typeof raw.modelChoice.pace === "string" ? raw.modelChoice.pace.slice(0, 32) : "unknown",
            intensity: clamp01(Number(raw.modelChoice.intensity) || 0),
            reason: typeof raw.modelChoice.reason === "string" ? raw.modelChoice.reason.slice(0, 120) : "",
            at: typeof raw.modelChoice.at === "string" ? raw.modelChoice.at : null,
          }
        : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

function ensureStateShape(raw, agentKey = DEFAULT_AGENT_KEY, agentLabel = null) {
  const normalizedAgentKey = normalizeAgentKey(agentKey || (raw && raw.agentKey) || DEFAULT_AGENT_KEY);
  const normalizedAgentLabel = normalizeAgentLabel(
    agentLabel || (raw && (raw.agentLabel || raw.agentName)) || normalizedAgentKey,
    normalizedAgentKey
  );
  const base = createDefaultState(normalizedAgentKey, normalizedAgentLabel);
  if (!raw || typeof raw !== "object") return base;

  return {
    ...base,
    ...raw,
    agentKey: normalizedAgentKey,
    agentLabel: normalizedAgentLabel,
    driveBaseline: { ...base.driveBaseline, ...(raw.driveBaseline || {}) },
    frustration: { ...base.frustration, ...(raw.frustration || {}) },
    signals: { ...base.signals, ...(raw.signals || {}) },
    temperament: normalizeTemperament(raw.temperament, normalizedAgentKey),
    signalBias: normalizeSignalBias(raw.signalBias),
    metabolism: normalizeMetabolism(raw.metabolism, normalizedAgentKey),
    phase: normalizePhase(raw.phase),
    lastMajorImpactAt: typeof raw.lastMajorImpactAt === "string" ? raw.lastMajorImpactAt : null,
    cooldown: { ...base.cooldown, ...(raw.cooldown || {}) },
    lastTurnFingerprint:
      typeof raw.lastTurnFingerprint === "string" ? raw.lastTurnFingerprint : base.lastTurnFingerprint,
    turnCount: Number.isFinite(Number(raw.turnCount)) ? Number(raw.turnCount) : base.turnCount,
    appliedDeltaIds: Array.isArray(raw.appliedDeltaIds)
      ? raw.appliedDeltaIds.filter((id) => typeof id === "string").slice(-MAX_APPLIED_DELTAS)
      : [],
    appliedExpressionIds: Array.isArray(raw.appliedExpressionIds)
      ? raw.appliedExpressionIds.filter((id) => typeof id === "string").slice(-MAX_APPLIED_EXPRESSIONS)
      : [],
    lastAppliedPersonaDelta:
      raw.lastAppliedPersonaDelta && typeof raw.lastAppliedPersonaDelta === "object" && !Array.isArray(raw.lastAppliedPersonaDelta)
        ? raw.lastAppliedPersonaDelta
        : null,
    genome: {
      recurrentState: normalizeRecurrentState(raw.genome && raw.genome.recurrentState),
      lastContext: normalizeContext(raw.genome && raw.genome.lastContext),
    },
    expression: normalizeExpression(raw.expression),
    trends: {
      frustration: {
        ...base.trends.frustration,
        ...((raw.trends && raw.trends.frustration) || {}),
      },
      signals: {
        ...base.trends.signals,
        ...((raw.trends && raw.trends.signals) || {}),
      },
    },
    audit: Array.isArray(raw.audit) ? raw.audit.slice(-20) : [],
  };
}

function isStateStoreShape(raw) {
  return raw && typeof raw === "object" && raw.agents && typeof raw.agents === "object" && !Array.isArray(raw.agents);
}

function ensureStateStoreShape(raw) {
  const base = createDefaultStateStore();
  if (!isStateStoreShape(raw)) {
    const legacyState = ensureStateShape(raw, DEFAULT_AGENT_KEY, DEFAULT_AGENT_LABEL);
    return {
      store: {
        ...base,
        createdAt: legacyState.createdAt || base.createdAt,
        updatedAt: legacyState.updatedAt || base.updatedAt,
        legacySingleStatePending: true,
        agents: {
          [DEFAULT_AGENT_KEY]: legacyState,
        },
      },
      legacySingleStatePending: true,
    };
  }

  const agents = {};
  for (const [rawKey, rawState] of Object.entries(raw.agents)) {
    if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) continue;
    const key = normalizeAgentKey(rawState.agentKey || rawKey);
    const label = normalizeAgentLabel(rawState.agentLabel || rawState.agentName || rawKey, key);
    agents[key] = ensureStateShape(rawState, key, label);
  }

  if (Object.keys(agents).length === 0) {
    agents[DEFAULT_AGENT_KEY] = createDefaultState(DEFAULT_AGENT_KEY, DEFAULT_AGENT_LABEL);
  }

  const requestedActiveKey = normalizeAgentKey(raw.activeAgentKey || raw.activeAgentId || DEFAULT_AGENT_KEY);
  const activeKey = agents[requestedActiveKey] ? requestedActiveKey : Object.keys(agents)[0];

  return {
    store: {
      ...base,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : base.createdAt,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : base.updatedAt,
      activeAgentKey: activeKey,
      legacySingleStatePending: Boolean(raw.legacySingleStatePending),
      agents,
    },
    legacySingleStatePending: Boolean(raw.legacySingleStatePending),
  };
}

function pruneDefaultAgentBucket() {
  if (!stateStore || !stateStore.agents || typeof stateStore.agents !== "object") return false;
  const realAgentKeys = Object.keys(stateStore.agents).filter((key) => key !== DEFAULT_AGENT_KEY);
  if (realAgentKeys.length === 0 || !stateStore.agents[DEFAULT_AGENT_KEY]) return false;
  delete stateStore.agents[DEFAULT_AGENT_KEY];
  if (stateStore.activeAgentKey === DEFAULT_AGENT_KEY) {
    stateStore.activeAgentKey = realAgentKeys.includes(activeAgentKey) ? activeAgentKey : realAgentKeys[0];
  }
  legacySingleStatePending = false;
  return true;
}

function activateAgentState(agentKey = DEFAULT_AGENT_KEY, agentLabel = null) {
  const key = normalizeAgentKey(agentKey);
  const label = normalizeAgentLabel(agentLabel || key, key);
  const switched = activeAgentKey !== key;
  let changed = false;
  if (!stateStore || !stateStore.agents || typeof stateStore.agents !== "object") {
    stateStore = createDefaultStateStore();
    changed = true;
  }

  if (!stateStore.agents[key]) {
    if (legacySingleStatePending && key !== DEFAULT_AGENT_KEY && stateStore.agents[DEFAULT_AGENT_KEY]) {
      stateStore.agents[key] = ensureStateShape(
        { ...stateStore.agents[DEFAULT_AGENT_KEY], agentKey: key, agentLabel: label },
        key,
        label
      );
      delete stateStore.agents[DEFAULT_AGENT_KEY];
      legacySingleStatePending = false;
    } else {
      stateStore.agents[key] = createDefaultState(key, label);
    }
    changed = true;
  } else {
    const previous = stateStore.agents[key];
    stateStore.agents[key] = ensureStateShape(stateStore.agents[key], key, label);
    if (previous.agentLabel !== stateStore.agents[key].agentLabel) changed = true;
  }

  activeAgentKey = key;
  stateStore.activeAgentKey = key;
  state = stateStore.agents[key];
  if (key !== DEFAULT_AGENT_KEY) {
    changed = pruneDefaultAgentBucket() || changed;
    stateStore.activeAgentKey = key;
    state = stateStore.agents[key];
  }
  state.cooldown.minutes = activeConfig.OpenHerPersonaCooldownMinutes;
  return { state, agentKey: key, agentLabel: label, changed, switched };
}

function stripVcpRagBlocks(text) {
  return typeof text === "string" ? text.replace(VCP_RAG_BLOCK_PATTERN, "") : text;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function resolveAgentIdentityFromKnownVcpFields(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const candidates = [
    raw.agentKey,
    raw.agentId,
    raw.agent,
    raw.agentName,
    raw.agentLabel,
    raw.maidName,
    raw.maid,
    raw.name,
    raw.currentAgent,
    raw.currentAgentName,
    raw.currentMaid,
    raw.currentMaidName,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const value = candidate.trim();
    if (value === DEFAULT_AGENT_KEY || value === DEFAULT_AGENT_LABEL) continue;
    return {
      agentKey: normalizeAgentKey(value),
      agentLabel: normalizeAgentLabel(value),
      source: "object_field",
    };
  }

  return null;
}

function resolveAgentIdentityFromObject(raw, depth = 0, seen = new Set()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || depth > 5 || seen.has(raw)) return null;
  seen.add(raw);

  const directKey = firstNonEmptyString(raw.agentKey, raw.agentId, raw.agent, raw.maidName, raw.maid);
  const directLabel = firstNonEmptyString(raw.agentLabel, raw.agentName, raw.name, raw.maidName, raw.maid, directKey);
  if (directKey || directLabel) {
    return {
      agentKey: normalizeAgentKey(directKey || directLabel),
      agentLabel: normalizeAgentLabel(directLabel || directKey),
      source: "object",
    };
  }

  const fieldResolved = resolveAgentIdentityFromKnownVcpFields(raw);
  if (fieldResolved) return fieldResolved;

  const nestedCandidates = [
    raw.openHerPersona,
    raw.openHerPersonaAgent,
    raw.vcpchatExtensions,
    raw.vcpchatExtensions && raw.vcpchatExtensions.openHerPersona,
    raw.vcpchatExtensions && raw.vcpchatExtensions.openHerPersonaAgent,
    raw.context,
    raw.currentAgent,
    raw.currentAgentInfo,
    raw.agentInfo,
    raw.metadata,
    raw.extra_body,
    raw.extraBody,
  ];
  for (const candidate of nestedCandidates) {
    const resolved = resolveAgentIdentityFromObject(candidate, depth + 1, seen);
    if (resolved) return resolved;
  }

  for (const value of Object.values(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const resolved = resolveAgentIdentityFromObject(value, depth + 1, seen);
    if (resolved) return resolved;
  }

  return null;
}

function resolveAgentIdentityFromText(text) {
  const content = stripVcpRagBlocks(String(text || ""));
  const triggerMatches = Array.from(content.matchAll(ONE_RING_TRIGGER_PATTERN));
  const triggerMatch = triggerMatches.length ? triggerMatches[triggerMatches.length - 1] : null;
  if (triggerMatch && triggerMatch[1]) {
    const agent = triggerMatch[1].trim();
    if (triggerMatch[2] && triggerMatch[2].trim()) {
      activeClientLabel = triggerMatch[2].trim();
      if (/vcp?chat/i.test(activeClientLabel)) activeClientIsVcpChat = true;
    }
    const resolved = { agentKey: normalizeAgentKey(agent), agentLabel: normalizeAgentLabel(agent), source: "onering_trigger" };
    debugLog("identity text matched latest OneRing trigger", {
      resolved,
      clientLabel: activeClientLabel,
      rawMatch: triggerMatch[0],
      matchCount: triggerMatches.length,
    });
    return resolved;
  }

  const noticeMatches = Array.from(content.matchAll(ONE_RING_NOTICE_PATTERN));
  const noticeMatch = noticeMatches.length ? noticeMatches[noticeMatches.length - 1] : null;
  if (noticeMatch && noticeMatch[1]) {
    const agent = noticeMatch[1].trim();
    if (noticeMatch[2] && noticeMatch[2].trim()) {
      activeClientLabel = noticeMatch[2].trim();
      if (/vcp?chat/i.test(activeClientLabel)) activeClientIsVcpChat = true;
    }
    const resolved = { agentKey: normalizeAgentKey(agent), agentLabel: normalizeAgentLabel(agent), source: "onering_notice" };
    debugLog("identity text matched latest OneRing notice", {
      resolved,
      clientLabel: activeClientLabel,
      rawMatch: noticeMatch[0],
      matchCount: noticeMatches.length,
    });
    return resolved;
  }

  return null;
}

function resolveAgentIdentity(messages, requestConfig) {
  activeClientLabel = null;
  // Burst hints are opt-in per client: only requests provably from VCPChat
  // (vcpchatExtensions payload, or a OneRing client label like VCPChat/VChat)
  // may receive split markers; unknown sources are treated as plain-text.
  activeClientIsVcpChat = Boolean(
    requestConfig && typeof requestConfig === "object" && requestConfig.vcpchatExtensions
  );
  const fromConfig = resolveAgentIdentityFromObject(requestConfig);

  debugLog("identity resolve start", {
    messageCount: Array.isArray(messages) ? messages.length : null,
    systemMessageCount: Array.isArray(messages) ? messages.filter((message) => message && message.role === "system").length : null,
    requestConfigKeys: requestConfig && typeof requestConfig === "object" ? Object.keys(requestConfig).slice(0, 30) : [],
    fromConfig,
    activeClientIsVcpChat,
  });

  let fromLatestSystem = null;
  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || message.role !== "system") continue;
      debugLog("identity inspect system message", summarizeMessageForDebug(message, index));
      const resolved = resolveAgentIdentityFromText(messageContentToText(message.content));
      if (resolved) {
        fromLatestSystem = resolved;
        debugLog("identity selected latest system match", { index, resolved });
        break;
      }
    }
  }

  let finalIdentity = null;
  if (fromConfig && (fromConfig.source === "object" || !fromLatestSystem)) {
    finalIdentity = fromConfig;
  } else if (fromLatestSystem) {
    finalIdentity = fromLatestSystem;
  }

  debugLog("identity resolve final", {
    finalIdentity,
    fromLatestSystem,
    fromConfig,
    activeAgentKey,
    activeClientLabel,
    activeClientIsVcpChat,
  });

  return finalIdentity;
}

function activateAgentForRequest(messages, requestConfig) {
  const identity = resolveAgentIdentity(messages, requestConfig);
  if (!identity) {
    const activation = {
      state,
      agentKey: null,
      agentLabel: null,
      changed: false,
      switched: false,
      source: "unresolved",
      resolved: false,
    };
    debugLog("identity activation skipped", {
      identity,
      activeAgentKey,
      activeClientLabel,
      activeClientIsVcpChat,
    });
    return activation;
  }

  const activation = activateAgentState(identity.agentKey, identity.agentLabel);
  activation.source = identity.source;
  activation.resolved = true;
  debugLog("identity activation result", {
    identity,
    activatedAgentKey: activation.agentKey,
    activatedAgentLabel: activation.agentLabel,
    changed: activation.changed,
    switched: activation.switched,
  });
  return activation;
}

function openStateDb() {
  if (!Database) return null;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const db = new Database(STATE_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS openher_persona_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS openher_persona_agents (
      agent_key TEXT PRIMARY KEY,
      agent_label TEXT NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_openher_persona_agents_updated_at
      ON openher_persona_agents(updated_at);
  `);
  return db;
}

function readStateMeta(db, key) {
  const row = db.prepare("SELECT value FROM openher_persona_meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

function writeStateMeta(db, key, value) {
  db.prepare(
    `INSERT INTO openher_persona_meta (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

function loadStateStoreFromDb() {
  if (!Database || !fs.existsSync(STATE_DB_PATH)) return null;
  const db = openStateDb();
  if (!db) return null;
  try {
    const rows = db
      .prepare("SELECT agent_key, agent_label, state_json FROM openher_persona_agents ORDER BY updated_at ASC")
      .all();
    if (!rows.length) return null;

    const base = createDefaultStateStore();
    const agents = {};
    for (const row of rows) {
      try {
        const rawState = JSON.parse(row.state_json);
        const key = normalizeAgentKey(rawState.agentKey || row.agent_key);
        if (key === DEFAULT_AGENT_KEY) continue;
        const label = normalizeAgentLabel(rawState.agentLabel || row.agent_label || key, key);
        agents[key] = ensureStateShape(rawState, key, label);
      } catch (error) {
        // Skip corrupt rows so one bad agent entry does not kill the whole store.
      }
    }

    if (Object.keys(agents).length === 0) return null;

    const requestedActiveKey = normalizeAgentKey(readStateMeta(db, "activeAgentKey") || DEFAULT_AGENT_KEY);
    const activeKey = agents[requestedActiveKey] ? requestedActiveKey : Object.keys(agents)[0];
    return {
      store: {
        ...base,
        schemaVersion: STATE_STORE_VERSION,
        plugin: PLUGIN_NAME,
        pluginVersion: PLUGIN_VERSION,
        createdAt: readStateMeta(db, "createdAt") || base.createdAt,
        updatedAt: readStateMeta(db, "updatedAt") || nowIso(),
        activeAgentKey: activeKey,
        legacySingleStatePending: false,
        agents,
      },
      legacySingleStatePending: false,
    };
  } finally {
    db.close();
  }
}

function saveCurrentAgentStateToDb() {
  if (!Database || activeAgentKey === DEFAULT_AGENT_KEY) return false;
  const db = openStateDb();
  if (!db) return false;

  const now = nowIso();
  state.agentKey = activeAgentKey;
  state.updatedAt = now;
  state.pluginVersion = PLUGIN_VERSION;
  stateStore.agents[activeAgentKey] = state;
  pruneDefaultAgentBucket();

  try {
    const transaction = db.transaction(() => {
      const createdAt = state.createdAt || now;
      db.prepare(
        `INSERT INTO openher_persona_agents (agent_key, agent_label, state_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_key) DO UPDATE SET
           agent_label = excluded.agent_label,
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`
      ).run(
        activeAgentKey,
        state.agentLabel || activeAgentKey,
        JSON.stringify(state),
        createdAt,
        now
      );

      writeStateMeta(db, "schemaVersion", String(STATE_STORE_VERSION));
      writeStateMeta(db, "plugin", PLUGIN_NAME);
      writeStateMeta(db, "pluginVersion", PLUGIN_VERSION);
      writeStateMeta(db, "createdAt", stateStore.createdAt || createdAt);
      writeStateMeta(db, "updatedAt", now);
      writeStateMeta(db, "activeAgentKey", activeAgentKey);
    });
    transaction();
    return true;
  } finally {
    db.close();
  }
}

function saveAllAgentStatesToDb() {
  if (!Database) return false;
  const db = openStateDb();
  if (!db) return false;

  const now = nowIso();
  pruneDefaultAgentBucket();

  try {
    const transaction = db.transaction(() => {
      for (const [agentKey, agentState] of Object.entries(stateStore.agents || {})) {
        if (agentKey === DEFAULT_AGENT_KEY || !agentState) continue;
        const shaped = ensureStateShape(agentState, agentKey, agentState.agentLabel || agentKey);
        db.prepare(
          `INSERT INTO openher_persona_agents (agent_key, agent_label, state_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(agent_key) DO UPDATE SET
             agent_label = excluded.agent_label,
             state_json = excluded.state_json,
             updated_at = excluded.updated_at`
        ).run(
          agentKey,
          shaped.agentLabel || agentKey,
          JSON.stringify(shaped),
          shaped.createdAt || now,
          shaped.updatedAt || now
        );
      }

      writeStateMeta(db, "schemaVersion", String(STATE_STORE_VERSION));
      writeStateMeta(db, "plugin", PLUGIN_NAME);
      writeStateMeta(db, "pluginVersion", PLUGIN_VERSION);
      writeStateMeta(db, "createdAt", stateStore.createdAt || now);
      writeStateMeta(db, "updatedAt", now);
      writeStateMeta(db, "activeAgentKey", activeAgentKey !== DEFAULT_AGENT_KEY ? activeAgentKey : stateStore.activeAgentKey);
    });
    transaction();
    return true;
  } finally {
    db.close();
  }
}

function getAgentSummaries() {
  return Object.values(stateStore.agents || {})
    .map((agentState) => ({
      agentKey: agentState.agentKey || DEFAULT_AGENT_KEY,
      agentLabel: agentState.agentLabel || agentState.agentKey || DEFAULT_AGENT_LABEL,
      turnCount: Number(agentState.turnCount) || 0,
      updatedAt: agentState.updatedAt || null,
      lastActiveAt: agentState.lastActiveAt || null,
    }))
    .sort((a, b) => a.agentLabel.localeCompare(b.agentLabel, "zh-Hans-CN"));
}

function loadState() {
  try {
    const loadedFromDb = loadStateStoreFromDb();
    if (loadedFromDb) {
      stateStore = loadedFromDb.store;
      legacySingleStatePending = loadedFromDb.legacySingleStatePending;
      const activeState = stateStore.agents[stateStore.activeAgentKey];
      activateAgentState(stateStore.activeAgentKey, activeState && activeState.agentLabel);
      return;
    }

    if (!fs.existsSync(STATE_PATH)) {
      stateStore = createDefaultStateStore();
      legacySingleStatePending = false;
      activateAgentState(DEFAULT_AGENT_KEY, DEFAULT_AGENT_LABEL);
      return;
    }
    const loaded = ensureStateStoreShape(JSON.parse(fs.readFileSync(STATE_PATH, "utf8")));
    stateStore = loaded.store;
    legacySingleStatePending = loaded.legacySingleStatePending;
    const activeState = stateStore.agents[stateStore.activeAgentKey];
    activateAgentState(stateStore.activeAgentKey, activeState && activeState.agentLabel);
    saveAllAgentStatesToDb();
  } catch (error) {
    stateStore = createDefaultStateStore();
    legacySingleStatePending = false;
    activateAgentState(DEFAULT_AGENT_KEY, DEFAULT_AGENT_LABEL);
    const fallback = state;
    fallback.audit.push({
      at: nowIso(),
      type: "state_load_failed",
      error: error.message,
    });
  }
}

function saveState() {
  if (activeAgentKey === DEFAULT_AGENT_KEY) {
    return;
  }

  const now = nowIso();
  state.agentKey = activeAgentKey;
  state.updatedAt = now;
  state.pluginVersion = PLUGIN_VERSION;
  stateStore.agents[activeAgentKey] = state;
  pruneDefaultAgentBucket();
  stateStore.schemaVersion = STATE_STORE_VERSION;
  stateStore.plugin = PLUGIN_NAME;
  stateStore.pluginVersion = PLUGIN_VERSION;
  stateStore.activeAgentKey = activeAgentKey;
  stateStore.legacySingleStatePending = legacySingleStatePending;
  stateStore.updatedAt = now;

  if (saveCurrentAgentStateToDb()) {
    return;
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmpPath = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(stateStore, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, STATE_PATH);
}

function pushAudit(entry) {
  state.audit.push({ at: nowIso(), ...entry });
  state.audit = state.audit.slice(-20);
}

function initialize(config, dependencies) {
  activeConfig = loadConfigFromJsonOrMigrate(config || {});
  startConfigWatcher();
  contextBridge = dependencies && dependencies.contextBridge ? dependencies.contextBridge : null;
  if (dependencies && typeof dependencies.embeddingProvider === "function") {
    embeddingProvider = dependencies.embeddingProvider;
    embeddingProviderTag = "injected";
  } else if (contextBridge && typeof contextBridge.embedText === "function") {
    embeddingProvider = createContextBridgeEmbeddingProvider(contextBridge);
    embeddingProviderTag = "contextBridge";
  } else {
    embeddingProvider = createDefaultEmbeddingProvider();
    embeddingProviderTag = "default";
  }
  anchorVectors = null;
  anchorLoadPromise = null;
  lastAnchorFailureAt = 0;
  messageVectorCache.clear();
  loadState();
  state.cooldown.minutes = activeConfig.OpenHerPersonaCooldownMinutes;
  if (activeAgentKey !== DEFAULT_AGENT_KEY) {
    pushAudit({ type: "initialize", hintEnabled: activeConfig.OpenHerPersonaHintEnabled });
    saveState();
  }

  if (activeConfig.DebugMode) {
    console.log(`[${PLUGIN_NAME}] initialized. contextBridge=${Boolean(contextBridge)}`);
  }
}

function getTopSignals(limit = 3) {
  return Object.entries(state.signals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, value]) => ({ key, label: SIGNAL_LABELS[key] || key, value: Number(value.toFixed(2)) }));
}

function getTopFrustration(limit = 2) {
  return Object.entries(state.frustration)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, value]) => ({ key, label: DRIVE_LABELS[key] || key, value: Number(value.toFixed(2)) }));
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}

function debugLog(...args) {
  if (!activeConfig.DebugMode) return;
  console.log(`[${PLUGIN_NAME}][Debug]`, ...args);
}

function summarizeMessageForDebug(message, index) {
  const text = messageContentToText(message && message.content);
  const identityText = stripVcpRagBlocks(text);
  const oneRingMatches = Array.from(identityText.matchAll(ONE_RING_TRIGGER_PATTERN));
  const noticeMatches = Array.from(identityText.matchAll(ONE_RING_NOTICE_PATTERN));
  return {
    index,
    role: message && message.role,
    textPreviewHead: text.replace(/\s+/g, " ").slice(0, 180),
    textPreviewTail: text.replace(/\s+/g, " ").slice(-240),
    oneRingTriggerCount: oneRingMatches.length,
    oneRingNoticeCount: noticeMatches.length,
    latestOneRingTrigger: oneRingMatches.length ? oneRingMatches[oneRingMatches.length - 1][0] : null,
    latestOneRingNotice: noticeMatches.length ? noticeMatches[noticeMatches.length - 1][0] : null,
  };
}

function messageContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        if (part && typeof part.content === "string") return part.content;
        return "";
      })
      .join("\n");
  }
  if (content == null) return "";
  return String(content);
}

function isVcpVirtualUserText(text) {
  return (
    isBetaSystemUserText(text) ||
    isSystemNotificationText(text) ||
    SYSTEM_PROMPT_USER_PATTERN.test(String(text || ""))
  );
}

function findLatestUserMessage(messages) {
  let realUserCount = 0;
  let latest = null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === "user") {
      const text = messageContentToText(message.content);
      if (isVcpVirtualUserText(text)) continue;
      latest = latest || { index, text, realUserCount: 0 };
      realUserCount += 1;
    }
  }

  if (!latest) return null;
  latest.realUserCount = realUserCount;
  return latest;
}

function buildTurnFingerprint(messages) {
  const latestUser = findLatestUserMessage(messages);
  if (!latestUser) return null;
  return hashText(`${latestUser.realUserCount}:${latestUser.index}:${latestUser.text}`);
}

function parseNumericDelta(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rememberDeltaId(deltaId) {
  if (!state.appliedDeltaIds.includes(deltaId)) {
    state.appliedDeltaIds.push(deltaId);
  }
  state.appliedDeltaIds = state.appliedDeltaIds.slice(-MAX_APPLIED_DELTAS);
}

function rememberExpressionId(expressionId) {
  if (!state.appliedExpressionIds.includes(expressionId)) {
    state.appliedExpressionIds.push(expressionId);
  }
  state.appliedExpressionIds = state.appliedExpressionIds.slice(-MAX_APPLIED_EXPRESSIONS);
}

function snapshotStateMaps() {
  return {
    frustration: Object.fromEntries(DRIVES.map((drive) => [drive, state.frustration[drive] || 0])),
    signals: Object.fromEntries(SIGNALS.map((signal) => [signal, state.signals[signal] || 0])),
  };
}

function normalizeTrendValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(4)) : 0;
}

function normalizeTrendMap(raw) {
  return {
    frustration: Object.fromEntries(
      DRIVES.map((drive) => [drive, normalizeTrendValue(raw && raw.frustration && raw.frustration[drive])])
    ),
    signals: Object.fromEntries(
      SIGNALS.map((signal) => [signal, normalizeTrendValue(raw && raw.signals && raw.signals[signal])])
    ),
  };
}

function updateTrends(before) {
  state.trends = {
    frustration: Object.fromEntries(
      DRIVES.map((drive) => [
        drive,
        Number(((state.frustration[drive] || 0) - (before.frustration[drive] || 0)).toFixed(4)),
      ])
    ),
    signals: Object.fromEntries(
      SIGNALS.map((signal) => [
        signal,
        Number(((state.signals[signal] || 0) - (before.signals[signal] || 0)).toFixed(4)),
      ])
    ),
  };
}

function gaussianNoise() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function deterministicWeight(seedText) {
  const digest = crypto.createHash("sha256").update(seedText).digest();
  const uint = digest.readUInt32BE(0);
  return (uint / 0xffffffff) * 2 - 1;
}

function sigmoid(value) {
  const clamped = Math.max(-10, Math.min(10, value));
  return 1 / (1 + Math.exp(-clamped));
}

function estimateContextFromText(text) {
  const normalized = String(text || "").trim();
  const lengthHeat = Math.min(1, normalized.length / 900);
  const questionMarks = (normalized.match(/[?？]/g) || []).length;
  const constraintHits = (normalized.match(/(?:禁止|必须|别|不要|约束|边界|确定|确认|不要擅自|停下)/gu) || []).length;
  const technicalHits = (normalized.match(/(?:源码|算法|公式|测试|函数|模块|插件|注入|LLM|VCP|OneRing|RAG|状态|实现)/giu) || []).length;
  const playHits = (normalized.match(/(?:哈哈|玩|试试|有趣|灵魂|撒娇|表情|语气)/gu) || []).length;
  const affectionHits = (normalized.match(/(?:喜欢|想你|陪|亲|抱|温柔|可爱|热切|人格)/gu) || []).length;
  const urgentHits = (normalized.match(/(?:现在|马上|立即|赶紧|报错|失败|崩|卡住|后续|弄完)/gu) || []).length;
  const noveltyHits = (normalized.match(/(?:新|优化|借鉴|改造|进步|探索|怎么弄|可以)/gu) || []).length;
  const depthHits = (normalized.match(/(?:为什么|原理|机制|公式|模型|边界|确定|源码|算法)/gu) || []).length;

  return normalizeContext({
    engagement: 0.2 + lengthHeat * 0.45 + Math.min(0.2, questionMarks * 0.05),
    constraint: 0.12 + Math.min(0.55, constraintHits * 0.12),
    technicality: 0.15 + Math.min(0.65, technicalHits * 0.08),
    playfulness: 0.14 + Math.min(0.5, playHits * 0.12),
    affection: 0.12 + Math.min(0.5, affectionHits * 0.1),
    urgency: 0.12 + Math.min(0.55, urgentHits * 0.12),
    novelty: 0.24 + Math.min(0.48, noveltyHits * 0.08) + lengthHeat * 0.12,
    depth: 0.28 + Math.min(0.52, depthHits * 0.08) + lengthHeat * 0.18,
  });
}

// --- Semantic context layer -------------------------------------------------
// Optional embedding-based scoring that blends with the keyword heuristic above.
// Any failure (no credentials, timeout, API error) silently falls back to the
// heuristic, so the persona keeps working without the vector service.

const CONTEXT_ANCHORS = {
  engagement: [
    "我特别投入，想跟你深入聊聊这个话题",
    "我们来认真讨论一下吧，我很感兴趣",
    "跟你聊天让我很专注，想多聊几句",
  ],
  constraint: [
    "禁止这样做，必须严格遵守规则",
    "别越界，注意边界和约束条件",
    "不要擅自行动，先停下来跟我确认",
  ],
  technicality: [
    "帮我分析这段源码的算法实现",
    "看看这个函数的模块逻辑和接口设计",
    "调试这个报错日志，修复测试用例",
  ],
  playfulness: [
    "哈哈太好玩了，我们再来玩一次",
    "逗你玩呢，猜猜我现在在想什么",
    "来点有趣的，撒个娇卖个萌嘛",
  ],
  affection: [
    "我好想你，想一直陪着你",
    "抱抱你，你真温柔真可爱",
    "我特别喜欢你，有你在身边真好",
  ],
  urgency: [
    "现在马上处理，十万火急",
    "赶紧的，立刻给我修复这个问题",
    "系统崩了，急需立即解决",
  ],
  novelty: [
    "我们试试全新的玩法吧",
    "有什么新鲜点子？来点没见过的",
    "换个新思路，探索一下新的方向",
  ],
  depth: [
    "为什么会这样？讲讲底层原理",
    "深入剖析一下这个机制的本质",
    "我想理解它背后的根本逻辑和哲学",
  ],
};

const SEMANTIC_TIMEOUT_MS = 2500;
const SEMANTIC_GAIN = 12;
const SEMANTIC_RETRY_BACKOFF_MS = 5 * 60 * 1000;
const MESSAGE_VECTOR_CACHE_LIMIT = 50;
const ANCHOR_CACHE_DB_PATH = path.join(STATE_DIR, "semantic-anchor-cache.sqlite");
const LEGACY_ANCHOR_CACHE_PATH = path.join(STATE_DIR, "semantic-anchor-cache.json");

let embeddingProvider = createDefaultEmbeddingProvider();
let embeddingProviderTag = "default";
let anchorVectors = null;
let anchorLoadPromise = null;
let lastAnchorFailureAt = 0;
const messageVectorCache = new Map();

function createDefaultEmbeddingProvider() {
  return async (texts) => {
    const apiUrl = process.env.API_URL;
    const apiKey = process.env.API_Key;
    if (!apiUrl || !apiKey) return null;
    return getEmbeddingsBatch(texts, { apiUrl, apiKey });
  };
}

function createContextBridgeEmbeddingProvider(bridge) {
  return async (texts) => {
    if (!Array.isArray(texts)) return null;
    return Promise.all(
      texts.map(async (text) => {
        const normalized = String(text || "").trim();
        if (!normalized) return null;

        if (typeof bridge.getEmbeddingFromCache === "function") {
          const exact = bridge.getEmbeddingFromCache(normalized);
          if (exact) return exact;
        }

        if (typeof bridge.getFuzzyEmbeddingFromCache === "function") {
          const fuzzy = bridge.getFuzzyEmbeddingFromCache(normalized);
          if (fuzzy && fuzzy.vector) return fuzzy.vector;
        }

        return bridge.embedText(normalized);
      })
    );
  };
}

function sanitizeForEmbedding(text, role = "user") {
  const raw = String(text || "");
  if (!contextBridge || typeof contextBridge.sanitize !== "function") return raw.trim();
  try {
    return String(contextBridge.sanitize(raw, role) || "").trim();
  } catch (error) {
    if (activeConfig.DebugMode) {
      console.warn(`[${PLUGIN_NAME}] contextBridge sanitize failed: ${error.message}`);
    }
    return raw.trim();
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      if (typeof timer.unref === "function") timer.unref();
    }),
  ]);
}

function getAnchorCacheSignature() {
  return {
    modelSig: String(process.env.EmbeddingModelSig || process.env.WhitelistEmbeddingModel || "unknown"),
    anchorsHash: hashText(JSON.stringify(CONTEXT_ANCHORS)),
    providerTag: embeddingProviderTag,
  };
}

function validateAnchorVectors(vectors) {
  if (!vectors || typeof vectors !== "object" || Array.isArray(vectors)) return false;
  for (const feature of CONTEXT_FEATURES) {
    const list = vectors[feature];
    if (!Array.isArray(list) || list.length !== CONTEXT_ANCHORS[feature].length) return false;
    if (!list.every((vector) => Array.isArray(vector) && vector.length > 0)) return false;
  }
  return true;
}

function openAnchorCacheDb() {
  if (!Database) return null;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const db = new Database(ANCHOR_CACHE_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_anchor_cache (
      cache_key TEXT PRIMARY KEY,
      model_sig TEXT NOT NULL,
      anchors_hash TEXT NOT NULL,
      provider_tag TEXT NOT NULL,
      vectors_json TEXT NOT NULL,
      saved_at TEXT NOT NULL
    );
  `);
  return db;
}

function getAnchorCacheKey(signature = getAnchorCacheSignature()) {
  return hashText(`${signature.modelSig}\n${signature.anchorsHash}\n${signature.providerTag}`);
}

function loadAnchorVectorsFromLegacyJson() {
  try {
    if (!fs.existsSync(LEGACY_ANCHOR_CACHE_PATH)) return null;
    const cached = JSON.parse(fs.readFileSync(LEGACY_ANCHOR_CACHE_PATH, "utf8"));
    const signature = getAnchorCacheSignature();
    if (
      !cached ||
      cached.modelSig !== signature.modelSig ||
      cached.anchorsHash !== signature.anchorsHash ||
      cached.providerTag !== signature.providerTag ||
      !validateAnchorVectors(cached.vectors)
    ) {
      return null;
    }
    return cached.vectors;
  } catch (error) {
    return null;
  }
}

function loadAnchorVectorsFromDisk() {
  const signature = getAnchorCacheSignature();

  try {
    const db = openAnchorCacheDb();
    if (db) {
      try {
        const row = db.prepare(
          `SELECT vectors_json FROM semantic_anchor_cache
           WHERE cache_key = ? AND model_sig = ? AND anchors_hash = ? AND provider_tag = ?
           LIMIT 1`
        ).get(getAnchorCacheKey(signature), signature.modelSig, signature.anchorsHash, signature.providerTag);
        if (row && row.vectors_json) {
          const vectors = JSON.parse(row.vectors_json);
          if (validateAnchorVectors(vectors)) return vectors;
        }
      } finally {
        db.close();
      }
    }
  } catch (error) {
    if (activeConfig.DebugMode) {
      console.warn(`[${PLUGIN_NAME}] failed to load SQLite anchor cache: ${error.message}`);
    }
  }

  const legacyVectors = loadAnchorVectorsFromLegacyJson();
  if (legacyVectors) {
    saveAnchorVectorsToDisk(legacyVectors);
    return legacyVectors;
  }

  return null;
}

function saveAnchorVectorsToDisk(vectors) {
  if (!validateAnchorVectors(vectors)) return;

  try {
    const db = openAnchorCacheDb();
    if (!db) return;
    try {
      const signature = getAnchorCacheSignature();
      db.prepare(
        `INSERT OR REPLACE INTO semantic_anchor_cache
         (cache_key, model_sig, anchors_hash, provider_tag, vectors_json, saved_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        getAnchorCacheKey(signature),
        signature.modelSig,
        signature.anchorsHash,
        signature.providerTag,
        JSON.stringify(vectors),
        nowIso()
      );
    } finally {
      db.close();
    }
  } catch (error) {
    if (activeConfig.DebugMode) {
      console.warn(`[${PLUGIN_NAME}] failed to persist SQLite anchor cache: ${error.message}`);
    }
  }
}

async function buildAnchorVectors() {
  const fromDisk = loadAnchorVectorsFromDisk();
  if (fromDisk) return fromDisk;

  const flatTexts = [];
  const layout = [];
  for (const feature of CONTEXT_FEATURES) {
    for (const text of CONTEXT_ANCHORS[feature]) {
      layout.push(feature);
      flatTexts.push(text);
    }
  }

  const embedded = await withTimeout(embeddingProvider(flatTexts), SEMANTIC_TIMEOUT_MS * 4);
  if (!Array.isArray(embedded) || embedded.length !== flatTexts.length || embedded.some((v) => !Array.isArray(v))) {
    return null;
  }

  const vectors = Object.fromEntries(CONTEXT_FEATURES.map((feature) => [feature, []]));
  embedded.forEach((vector, index) => {
    vectors[layout[index]].push(vector);
  });
  saveAnchorVectorsToDisk(vectors);
  return vectors;
}

async function ensureAnchorVectors() {
  if (anchorVectors) return anchorVectors;
  if (Date.now() - lastAnchorFailureAt < SEMANTIC_RETRY_BACKOFF_MS) return null;
  if (!anchorLoadPromise) {
    anchorLoadPromise = buildAnchorVectors()
      .catch(() => null)
      .then((vectors) => {
        anchorLoadPromise = null;
        if (vectors) {
          anchorVectors = vectors;
          pushAudit({ type: "semantic_context_ready", features: CONTEXT_FEATURES.length });
        } else {
          lastAnchorFailureAt = Date.now();
        }
        return vectors;
      });
  }
  return anchorLoadPromise;
}

function rememberMessageVector(key, vector) {
  messageVectorCache.set(key, vector);
  if (messageVectorCache.size > MESSAGE_VECTOR_CACHE_LIMIT) {
    messageVectorCache.delete(messageVectorCache.keys().next().value);
  }
}

async function getMessageVector(text, role = "user") {
  const normalizedText = sanitizeForEmbedding(text, role).slice(0, 2000);
  if (!normalizedText) return null;

  const key = hashText(`${role}:${normalizedText}`);
  if (messageVectorCache.has(key)) return messageVectorCache.get(key);

  if (contextBridge && typeof contextBridge.getEmbeddingFromCache === "function") {
    const exact = contextBridge.getEmbeddingFromCache(normalizedText);
    if (exact) {
      rememberMessageVector(key, exact);
      return exact;
    }
  }

  if (contextBridge && typeof contextBridge.getFuzzyEmbeddingFromCache === "function") {
    const fuzzy = contextBridge.getFuzzyEmbeddingFromCache(normalizedText);
    if (fuzzy && fuzzy.vector) {
      rememberMessageVector(key, fuzzy.vector);
      return fuzzy.vector;
    }
  }

  const embedded = await withTimeout(embeddingProvider([normalizedText]), SEMANTIC_TIMEOUT_MS);
  const vector = Array.isArray(embedded) && Array.isArray(embedded[0]) ? embedded[0] : null;
  if (vector) rememberMessageVector(key, vector);
  return vector;
}

// Relative-salience scoring: each feature's score reflects how much closer the
// message sits to that feature's anchors than to the average feature, so the
// high cosine floor of embedding models cancels out.
async function estimateContextSemantic(text) {
  try {
    const anchors = await ensureAnchorVectors();
    if (!anchors) return null;
    const vector = await getMessageVector(text, "user");
    if (!vector) return null;

    const sims = {};
    let simSum = 0;
    for (const feature of CONTEXT_FEATURES) {
      let best = -1;
      for (const anchorVector of anchors[feature]) {
        const sim = cosineSimilarity(vector, anchorVector);
        if (sim > best) best = sim;
      }
      sims[feature] = best;
      simSum += best;
    }
    const simMean = simSum / CONTEXT_FEATURES.length;

    return Object.fromEntries(
      CONTEXT_FEATURES.map((feature) => [feature, clamp01((sims[feature] - simMean) * SEMANTIC_GAIN)])
    );
  } catch (error) {
    if (activeConfig.DebugMode) {
      console.warn(`[${PLUGIN_NAME}] semantic context failed: ${error.message}`);
    }
    return null;
  }
}

async function resolveContextFromText(text) {
  const heuristic = estimateContextFromText(text);
  if (!activeConfig.OpenHerPersonaSemanticContext) return heuristic;
  const semantic = await estimateContextSemantic(text);
  if (!semantic) return heuristic;
  const weight = activeConfig.OpenHerPersonaSemanticWeight;
  return normalizeContext(
    Object.fromEntries(
      CONTEXT_FEATURES.map((feature) => [
        feature,
        heuristic[feature] * (1 - weight) + semantic[feature] * weight,
      ])
    )
  );
}
// --- End semantic context layer ----------------------------------------------

function getThermalTemperature() {
  const maxFrustration = Math.max(...DRIVES.map((drive) => state.frustration[drive] || 0));
  return Math.tanh(maxFrustration / 2.6);
}

const GENOME_INPUT_KEYS = [
  ...DRIVES.map((drive) => `drive:${drive}`),
  ...CONTEXT_FEATURES.map((feature) => `context:${feature}`),
  ...Array.from({ length: RECURRENT_SIZE }, (_, index) => `recurrent:${index}`),
];

// Weights are seeded per agent so every agent owns a distinct temperament mapping
// from drives/context to behavior signals, instead of sharing one global genome.
const genomeWeightCache = new Map();

function getGenomeWeights(agentKey) {
  const key = normalizeAgentKey(agentKey);
  const cached = genomeWeightCache.get(key);
  if (cached) return cached;

  const seedBase = `openherpersona:v3:genome:${key}`;
  const weights = {
    b1: Array.from({ length: HIDDEN_SIZE }, (_, i) => deterministicWeight(`${seedBase}:b1:${i}`) * 0.35),
    w1: Array.from({ length: HIDDEN_SIZE }, (_, i) =>
      GENOME_INPUT_KEYS.map((inputKey) => deterministicWeight(`${seedBase}:w1:${i}:${inputKey}`) * 0.42)
    ),
    b2: Object.fromEntries(
      SIGNALS.map((signal) => [signal, deterministicWeight(`${seedBase}:b2:${signal}`) * 0.28])
    ),
    w2: Object.fromEntries(
      SIGNALS.map((signal) => [
        signal,
        Array.from({ length: HIDDEN_SIZE }, (_, i) => deterministicWeight(`${seedBase}:w2:${signal}:${i}`) * 0.72),
      ])
    ),
  };
  genomeWeightCache.set(key, weights);
  return weights;
}

function computeGenomeSignals(context) {
  const normalizedContext = normalizeContext(context);
  const recurrentState = normalizeRecurrentState(state.genome && state.genome.recurrentState);
  const weights = getGenomeWeights(state.agentKey || activeAgentKey);
  const inputValues = [
    ...DRIVES.map((drive) => clamp01(((state.frustration[drive] || 0) / 5) * 0.72 + (state.driveBaseline[drive] || 0.5) * 0.28)),
    ...CONTEXT_FEATURES.map((feature) => normalizedContext[feature]),
    ...recurrentState,
  ];

  const hidden = [];
  for (let i = 0; i < HIDDEN_SIZE; i += 1) {
    let z = weights.b1[i];
    inputValues.forEach((value, index) => {
      z += value * weights.w1[i][index];
    });
    hidden.push(Math.tanh(z));
  }

  const nextSignals = {};
  SIGNALS.forEach((signal, signalIndex) => {
    let z = weights.b2[signal];
    hidden.forEach((value, hiddenIndex) => {
      z += value * weights.w2[signal][hiddenIndex];
    });
    z += (DEFAULT_SIGNALS[signal] - 0.5) * 1.3;
    nextSignals[signal] = clamp01(sigmoid(z / Math.sqrt(HIDDEN_SIZE / 3)));
    if (signalIndex < RECURRENT_SIZE) {
      recurrentState[signalIndex] = hidden[signalIndex];
    }
  });

  state.genome = {
    recurrentState,
    lastContext: normalizedContext,
  };
  return nextSignals;
}

function getExpressionPace(context) {
  const signals = state.signals || {};
  if ((signals.depth || 0) > 0.68 || (context.depth || 0) > 0.66) return "long";
  if ((signals.directness || 0) > 0.68 || (context.urgency || 0) > 0.55) return "short";
  if ((signals.warmth || 0) > 0.65 || (context.affection || 0) > 0.5) return "flowing";
  return "balanced";
}

function deriveExpression(context) {
  const normalizedContext = normalizeContext(context || (state.genome && state.genome.lastContext));
  const signals = state.signals || DEFAULT_SIGNALS;
  const frustration = state.frustration || {};
  const thermal = getThermalTemperature();
  const connectionHeat = clamp01((frustration.connection || 0) / 5);
  const expressionHeat = clamp01((frustration.expression || 0) / 5);
  const safetyHeat = clamp01((frustration.safety || 0) / 5);
  const playHeat = clamp01((frustration.play || 0) / 5);

  const scores = {
    text: 0.28 + (signals.depth || 0) * 0.22 + (signals.directness || 0) * 0.18 + normalizedContext.technicality * 0.24,
    long_text: 0.18 + (signals.depth || 0) * 0.38 + normalizedContext.technicality * 0.26 + normalizedContext.engagement * 0.12,
    voice_like:
      0.16 +
      (signals.warmth || 0) * 0.28 +
      (signals.vulnerability || 0) * 0.2 +
      connectionHeat * 0.18 +
      expressionHeat * 0.14,
    emoji_like:
      0.12 +
      (signals.playfulness || 0) * 0.34 +
      (signals.warmth || 0) * 0.14 +
      normalizedContext.playfulness * 0.28 +
      playHeat * 0.16,
    reserved:
      0.12 +
      safetyHeat * 0.35 +
      normalizedContext.constraint * 0.24 +
      (1 - (signals.initiative || 0.5)) * 0.12 +
      thermal * 0.1,
  };

  let mode = Object.keys(scores).sort((a, b) => scores[b] - scores[a])[0] || "text";
  if (mode === "reserved" && scores.reserved < 0.52) mode = "text";
  let pace = getExpressionPace(normalizedContext);
  let intensity = clamp01(
    0.18 +
      thermal * 0.24 +
      (signals.warmth || 0) * 0.18 +
      (signals.playfulness || 0) * 0.12 +
      expressionHeat * 0.16 +
      normalizedContext.urgency * 0.12
  );

  const phaseName = activeConfig.OpenHerPersonaPhaseEnabled ? normalizePhase(state.phase).name : "grounded";
  if (phaseName === "eruption") {
    pace = "short";
    intensity = Math.max(intensity, 0.78);
  } else if (phaseName === "cooling") {
    mode = "reserved";
    pace = "short";
    intensity = Math.min(intensity, 0.3);
  } else if (phaseName === "strained") {
    intensity = Math.max(intensity, 0.5);
  }

  // Chat-burst mode: emotionally charged / chatty states read like instant
  // messaging (several short bubbles); technical or deep long-form never splits.
  const chatty =
    mode === "emoji_like" ||
    mode === "voice_like" ||
    (signals.playfulness || 0) > 0.55 ||
    (signals.warmth || 0) > 0.65 ||
    normalizedContext.affection > 0.4 ||
    normalizedContext.playfulness > 0.45 ||
    phaseName === "eruption" ||
    phaseName === "cooling" ||
    phaseName === "strained";
  const formal =
    mode === "long_text" || normalizedContext.technicality > 0.45 || normalizedContext.depth > 0.62;
  const burst = Boolean(chatty && !formal);
  const burstSegments =
    phaseName === "eruption" || phaseName === "cooling" ? [2, 3] : intensity > 0.55 ? [3, 5] : [2, 4];
  const label = EXPRESSION_MODE_LABELS[mode] || EXPRESSION_MODE_LABELS.text;
  const reasonParts = [
    `温暖${signalBucket(signals.warmth || 0)}`,
    `深度${signalBucket(signals.depth || 0)}`,
    `约束${signalBucket(normalizedContext.constraint)}`,
  ];

  return normalizeExpression({
    ...state.expression,
    mode,
    label,
    pace,
    intensity,
    emoji: mode === "emoji_like" || ((signals.playfulness || 0) > 0.68 && normalizedContext.playfulness > 0.45),
    silence: false,
    burst,
    burstSegments,
    reason: reasonParts.join("，"),
    updatedAt: nowIso(),
  });
}

function updateExpressionFromSignals(context) {
  state.expression = deriveExpression(context);
}

function describeExpression() {
  const expression = normalizeExpression(state.expression);
  const paceLabel = EXPRESSION_PACE_LABELS[expression.pace] || EXPRESSION_PACE_LABELS.balanced;
  const intensity = expression.intensity < 0.34 ? "低密度" : expression.intensity < 0.67 ? "中密度" : "高密度";
  return `${expression.label}；${paceLabel}节奏；${intensity}；${expression.reason}`;
}

function signalBucket(value) {
  if (value < 0.28) return "很克制";
  if (value < 0.43) return "偏克制";
  if (value < 0.56) return "平稳";
  if (value < 0.76) return "偏热切";
  return "高热切";
}

function driveHeatBucket(value) {
  if (value < 0.2) return "平稳";
  if (value < 0.75) return "轻微牵动";
  if (value < 1.6) return "偏热切";
  if (value < 2.8) return "明显发烫";
  return "高张力";
}

function thermalNoiseBucket() {
  const temperature = getThermalTemperature();
  if (temperature < 0.18) return "几乎无扰动";
  if (temperature < 0.38) return "轻微波动";
  if (temperature < 0.62) return "偏热切";
  return "高张力扰动";
}

function trendBucket(label, delta, warmWord = "升温", coolWord = "回落") {
  if (Math.abs(delta) < 0.015) return null;
  return `${label}${delta > 0 ? warmWord : coolWord}`;
}

function getTrendSummary() {
  const driveTrends = DRIVES.map((drive) =>
    trendBucket(DRIVE_LABELS[drive] || drive, state.trends.frustration[drive] || 0)
  ).filter(Boolean);
  const signalTrends = SIGNALS.map((signal) =>
    trendBucket(SIGNAL_LABELS[signal] || signal, state.trends.signals[signal] || 0, "变强", "收束")
  ).filter(Boolean);
  const combined = [...driveTrends, ...signalTrends].slice(0, 4);
  return combined.length ? combined.join("；") : "整体稳定";
}

function describeSignals() {
  return getTopSignals(4)
    .map((item) => `${item.label}${signalBucket(item.value)}`)
    .join("；");
}

function describeDrives() {
  return getTopFrustration(3)
    .map((item) => `${item.label}${driveHeatBucket(item.value)}`)
    .join("；");
}

const MOOD_LABEL_GRID = [
  ["低落倦怠", "闷闷不乐", "焦躁不安"],
  ["松弛平淡", "平稳从容", "紧绷专注"],
  ["安然恬静", "暖意盎然", "雀跃兴奋"],
];

function moodLabel(valence, arousal) {
  const v = valence >= 0.6 ? 2 : valence >= 0.4 ? 1 : 0;
  const a = arousal >= 0.6 ? 2 : arousal >= 0.33 ? 1 : 0;
  return MOOD_LABEL_GRID[v][a];
}

function computeMood() {
  const signals = state.signals || DEFAULT_SIGNALS;
  const frustration = state.frustration || {};
  const safetyHeat = clamp01((frustration.safety || 0) / 5);
  const connectionHeat = clamp01((frustration.connection || 0) / 5);
  const context = normalizeContext(state.genome && state.genome.lastContext);
  const valence = clamp01(
    0.5 +
      ((signals.warmth || 0) - 0.5) * 0.5 +
      ((signals.playfulness || 0) - 0.5) * 0.3 +
      ((signals.curiosity || 0) - 0.5) * 0.2 -
      safetyHeat * 0.25 -
      connectionHeat * 0.15
  );
  const arousal = clamp01(getThermalTemperature() * 0.55 + context.urgency * 0.25 + context.engagement * 0.2);
  return {
    valence: Number(valence.toFixed(3)),
    arousal: Number(arousal.toFixed(3)),
    label: moodLabel(valence, arousal),
  };
}

function stripExistingPersonaHint(message) {
  if (!message || message.role !== "system" || typeof message.content !== "string") {
    return message;
  }
  const nextContent = message.content.replace(PERSONA_HINT_PATTERN, "").trim();
  return { ...message, content: nextContent };
}

// Burst markers are HTML comments the chat UI splits into bubbles; clients that
// send raw text (e.g. QQ bots) would show them literally, so the hint is only
// issued when the request is provably from VCPChat (deny by default).
function clientSupportsBurst() {
  return activeClientIsVcpChat;
}

function buildBurstHintLine() {
  if (
    activeConfig.OpenHerPersonaBurstMode === "off" ||
    !activeConfig.OpenHerPersonaBurstEnabled ||
    !clientSupportsBurst()
  ) {
    return null;
  }
  const expression = normalizeExpression(state.expression);
  if (activeConfig.OpenHerPersonaBurstMode !== "always" && !expression.burst) return null;
  const [minSegments, maxSegments] = expression.burst
    ? expression.burstSegments
    : DEFAULT_EXPRESSION.burstSegments;
  return (
    `聊天分条模式：本轮像即时聊天那样说话——按语义自然分条，拆成 ${minSegments}~${maxSegments} 条左右的短消息，几个字的超短句也可以独立成一条（像真实聊天的连发）；` +
    "相邻两条之间独占一行写一个分条标记，标记格式为：HTML 注释开标签 + brk + HTML 注释闭标签（界面会把它渲染成分开的聊天气泡）；" +
    "每条一两句话、口语化；代码块、列表、长段解释不要拆；开头和结尾不要写标记；persona_delta 回填仍放在整条回复末尾。"
  );
}

function buildHtmlHintLine() {
  if (
    !activeConfig.OpenHerPersonaHtmlHintEnabled ||
    activeConfig.OpenHerPersonaBurstMode === "off" ||
    !activeConfig.OpenHerPersonaBurstEnabled ||
    !clientSupportsBurst()
  ) {
    return null;
  }
  const expression = normalizeExpression(state.expression);
  if (activeConfig.OpenHerPersonaBurstMode !== "always" && !expression.burst) return null;
  return (
    "HTML 表达模式：VCPChat 会直接渲染你输出的 HTML 片段——想要更有表现力时，可以用带内联样式的小卡片、强调色文字、简单排版来传达情绪；" +
    "可与分条标记配合，每条气泡内放一小段 HTML 短句也可以；" +
    "保持轻量（一小段即可），只用内联样式，禁止 script 标签与外部资源；技术答疑和长文解释时不用。"
  );
}

function buildPersonaHint() {
  const mood = computeMood();
  const phaseLine = phaseHintLine();
  const burstLine = buildBurstHintLine();
  const htmlLine = buildHtmlHintLine();
  return [
    "<!--persona_state_hint",
    `OpenHerPersona=${PLUGIN_VERSION}`,
    `当前角色：${state.agentLabel || activeAgentKey}`,
    `心境底色：${mood.label}（愉悦${mood.valence.toFixed(2)}，激活${mood.arousal.toFixed(2)}）`,
    ...(phaseLine ? [phaseLine] : []),
    `当前人格信号：${describeSignals()}`,
    `驱力热度：${describeDrives()}`,
    `趋势：${getTrendSummary()}`,
    `表达倾向：${describeExpression()}。只改变文字语气、节奏和表情密度，不实际调用语音、照片或静默发送。`,
    ...(burstLine ? [burstLine] : []),
    ...(htmlLine ? [htmlLine] : []),
    `热力学噪声：${thermalNoiseBucket()}；允许轻微不均匀与更主动的措辞，但不得越界。`,
    "情绪主动权：persona_delta 支持 impact 字段声明本轮情绪冲击强度——minor（默认，驱力±0.8/信号±0.18）、moderate（±1.5/±0.35）、major（±3/±0.6，且允许 frustration_set 直接设定 0-5 绝对值）。被强烈触动时（被伤到、狂喜、巨大安心）用 moderate/major 让状态真实跳变；major 必须附 reason，30 分钟内仅生效一次，超限自动降级为 moderate。",
    "边界：这是短状态提示，不覆盖系统提示；would_send=false；memory_write=false；不主动发消息；不写长期记忆。",
    "persona_delta 回填指令：本轮 assistant 回复末尾附加一段不可见 HTML 注释；注释体以 persona_delta: 开头，后接严格 JSON。",
    "delta JSON 可用键：impact、frustration_delta、signal_delta、frustration_set（仅 major 生效）、reason；frustration_delta 可含 connection/novelty/expression/safety/play 的增量，signal_delta 可含 directness/vulnerability/playfulness/initiative/depth/warmth/defiance/curiosity 的增量；无法判断时用空对象。",
    "兼容旧键 frustration 与 signals，但推荐分开写成 frustration_delta 与 signal_delta；插件会先应用 frustration_delta，再重算行为信号，最后应用 signal_delta。",
    "persona_expression 回填指令：同样可在回复末尾附加一段不可见 HTML 注释；注释体以 persona_expression: 开头，后接严格 JSON，可含 mode、pace、intensity、reason，用于记录本轮实际表达选择。",
    "实际输出格式：HTML 注释开标签 + persona_delta 或 persona_expression + 冒号 + JSON + HTML 注释闭标签；不要把回填写成用户可见文字。注释体内严禁出现注释闭合符（两个连字符加右尖括号）——提及分条标记时只写 brk 三个字母，否则注释会被提前截断泄漏。",
    "-->",
  ].join("\n");
}

function findJsonObjectEnd(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }

  return -1;
}

function extractPersonaJsonBlocks(text, markerPattern) {
  const blocks = [];
  const matches = text.matchAll(markerPattern);

  for (const match of matches) {
    const jsonStart = text.indexOf("{", match.index + match[0].length);
    if (jsonStart < 0) continue;
    const jsonEnd = findJsonObjectEnd(text, jsonStart);
    if (jsonEnd < 0) continue;
    const commentEnd = text.indexOf("-->", jsonEnd);
    if (commentEnd < 0) continue;
    blocks.push(text.slice(jsonStart, jsonEnd));
  }

  return blocks;
}

function extractPersonaDeltaJsonBlocks(text) {
  return extractPersonaJsonBlocks(text, PERSONA_DELTA_MARKER_PATTERN);
}

function extractPersonaExpressionJsonBlocks(text) {
  return extractPersonaJsonBlocks(text, PERSONA_EXPRESSION_MARKER_PATTERN);
}

function collectPersonaDeltas(messages) {
  const deltas = [];
  for (const message of messages) {
    if (!message || message.role !== "assistant") continue;
    const text = messageContentToText(message.content);
    if (!text.includes("persona_delta")) continue;

    for (const rawJson of extractPersonaDeltaJsonBlocks(text)) {
      const deltaId = hashText(`${text}\n${rawJson}`);
      if (state.appliedDeltaIds.includes(deltaId)) continue;

      try {
        deltas.push({ id: deltaId, payload: JSON.parse(rawJson) });
      } catch (error) {
        rememberDeltaId(deltaId);
        pushAudit({ type: "persona_delta_invalid", deltaId, error: error.message });
      }
    }
  }
  return deltas;
}

function collectPersonaExpressions(messages) {
  const expressions = [];
  for (const message of messages) {
    if (!message || message.role !== "assistant") continue;
    const text = messageContentToText(message.content);
    if (!text.includes("persona_expression")) continue;

    for (const rawJson of extractPersonaExpressionJsonBlocks(text)) {
      const expressionId = hashText(`${text}\n${rawJson}`);
      if (state.appliedExpressionIds.includes(expressionId)) continue;

      try {
        expressions.push({ id: expressionId, payload: JSON.parse(rawJson) });
      } catch (error) {
        rememberExpressionId(expressionId);
        pushAudit({ type: "persona_expression_invalid", expressionId, error: error.message });
      }
    }
  }
  return expressions;
}

function applyDeltaMap(target, source, keys, maxAbs, clampValue, applied) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return false;
  let changed = false;

  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const delta = parseNumericDelta(source[key]);
    if (delta === null) continue;
    const boundedDelta = clampDelta(delta, maxAbs);
    target[key] = clampValue((target[key] || 0) + boundedDelta);
    if (applied) applied[key] = boundedDelta;
    changed = true;
  }

  return changed;
}

function evolveDriveBaseline(frustrationDelta, maxAbs = 0.8) {
  if (!frustrationDelta || typeof frustrationDelta !== "object" || Array.isArray(frustrationDelta)) return false;
  let changed = false;
  const baselineOrigin = deriveAgentInitialDriveBaseline(state.agentKey || activeAgentKey);

  for (const drive of DRIVES) {
    const delta = parseNumericDelta(frustrationDelta[drive]);
    const current = state.driveBaseline[drive] || baselineOrigin[drive] || 0.5;
    const origin = baselineOrigin[drive] || 0.5;
    const shift = delta === null ? 0 : clampDelta(delta, maxAbs) * BASELINE_LR;
    const pullBack = -(current - origin) * BASELINE_ELASTICITY;
    const next = Math.max(0.1, Math.min(0.95, current + shift + pullBack));
    if (Math.abs(next - current) > 0.0001) {
      state.driveBaseline[drive] = next;
      changed = true;
    }
  }

  return changed;
}

function applyPersonaExpression(expression) {
  const payload = expression.payload && typeof expression.payload === "object" ? expression.payload : {};
  const previous = normalizeExpression(state.expression);
  const mode = typeof payload.mode === "string" ? payload.mode.slice(0, 32) : previous.mode;
  const pace = typeof payload.pace === "string" ? payload.pace.slice(0, 32) : previous.pace;
  const intensityRaw = Number(payload.intensity);
  const intensity = Number.isFinite(intensityRaw) ? clamp01(intensityRaw) : clamp01(previous.intensity || 0);
  const reason = typeof payload.reason === "string" ? payload.reason.slice(0, 120) : "";

  state.expression = normalizeExpression({
    ...previous,
    modelChoice: {
      mode,
      pace,
      intensity,
      reason,
      at: nowIso(),
    },
  });
  rememberExpressionId(expression.id);
  pushAudit({ type: "persona_expression", expressionId: expression.id, mode, pace, intensity, reason });
  return true;
}

// The model declares how hard an emotional event hit via payload.impact.
// major demands a reason and respects a cooldown; abuse downgrades to moderate.
function resolveImpactTier(payload, nowMs) {
  const requested = typeof payload.impact === "string" ? payload.impact.trim().toLowerCase() : "minor";
  let tier = PERSONA_DELTA_IMPACT_TIERS[requested] ? requested : "minor";
  let downgradedFrom = null;

  if (tier === "major") {
    const hasReason = typeof payload.reason === "string" && payload.reason.trim().length > 0;
    const lastMajorMs = state.lastMajorImpactAt ? Date.parse(state.lastMajorImpactAt) : 0;
    const coolingDown = Number.isFinite(lastMajorMs) && nowMs - lastMajorMs < MAJOR_IMPACT_COOLDOWN_MS;
    if (!hasReason || coolingDown) {
      downgradedFrom = "major";
      tier = "moderate";
    }
  }

  return { tier, downgradedFrom };
}

function applyPersonaDelta(delta) {
  const payload = delta.payload && typeof delta.payload === "object" ? delta.payload : {};
  const before = snapshotStateMaps();
  const nowMs = Date.now();
  const { tier, downgradedFrom } = resolveImpactTier(payload, nowMs);
  const limits = PERSONA_DELTA_IMPACT_TIERS[tier];
  let changed = false;
  let distressSum = 0;

  const frustrationSet = payload.frustration_set;
  const frustrationDelta =
    payload.frustration_delta || payload.frustration || payload.drive_delta || payload.drives;
  const signalDelta = payload.signal_delta || payload.signals;
  const applied = {
    frustration_set: {},
    frustration_delta: {},
    signal_delta: {},
  };

  if (limits.allowSet && frustrationSet && typeof frustrationSet === "object" && !Array.isArray(frustrationSet)) {
    for (const drive of DRIVES) {
      if (!Object.prototype.hasOwnProperty.call(frustrationSet, drive)) continue;
      const target = parseNumericDelta(frustrationSet[drive]);
      if (target === null) continue;
      const previous = state.frustration[drive] || 0;
      state.frustration[drive] = clampFrustration(target);
      applied.frustration_set[drive] = state.frustration[drive];
      distressSum += Math.max(0, state.frustration[drive] - previous);
      sensitizeMetabolism(drive, state.frustration[drive] - previous, limits.plasticity);
      changed = true;
    }
  }

  changed =
    applyDeltaMap(state.frustration, frustrationDelta, DRIVES, limits.drive, clampFrustration, applied.frustration_delta) ||
    changed;
  changed = evolveDriveBaseline(frustrationDelta, limits.drive) || changed;
  for (const [drive, appliedDelta] of Object.entries(applied.frustration_delta)) {
    distressSum += Math.max(0, appliedDelta);
    sensitizeMetabolism(drive, appliedDelta, limits.plasticity);
  }
  if (distressSum > 0) {
    addPhaseCharge(limits.charge * Math.min(1, distressSum / 1.5));
  }

  if (changed) {
    updateSignalsFromFrustration({ noiseScale: 0 });
  }

  changed = applyDeltaMap(state.signals, signalDelta, SIGNALS, limits.signal, clamp01, applied.signal_delta) || changed;
  // Fold the model's self-adjustment into a slow bias so it survives the next
  // metabolism recompute instead of living for a single turn. Bigger impact
  // tiers fold faster — big events leave deeper marks.
  if (Object.keys(applied.signal_delta).length > 0) {
    const bias = normalizeSignalBias(state.signalBias);
    for (const [signal, signalShift] of Object.entries(applied.signal_delta)) {
      bias[signal] = Math.max(-SIGNAL_BIAS_MAX, Math.min(SIGNAL_BIAS_MAX, bias[signal] + signalShift * limits.biasLr));
    }
    state.signalBias = bias;
  }
  if (changed) {
    updateExpressionFromSignals(state.genome && state.genome.lastContext);
  }
  rememberDeltaId(delta.id);

  if (changed) {
    updateTrends(before);
    if (tier === "major") {
      state.lastMajorImpactAt = new Date(nowMs).toISOString();
    }
  }

  const appliedRecord = {
    deltaId: delta.id,
    changed,
    impact: tier,
    downgradedFrom,
    frustration_set: applied.frustration_set,
    frustration_delta: applied.frustration_delta,
    signal_delta: applied.signal_delta,
    reason: typeof payload.reason === "string" ? payload.reason.slice(0, 120) : null,
  };
  state.lastAppliedPersonaDelta = { at: nowIso(), ...appliedRecord };

  pushAudit({
    type: "persona_delta",
    ...appliedRecord,
  });

  return changed;
}

function applyPersonaDeltas(messages) {
  const deltas = collectPersonaDeltas(messages);
  let changed = false;
  for (const delta of deltas) {
    changed = applyPersonaDelta(delta) || changed;
  }
  return { changed, count: deltas.length };
}

function applyPersonaExpressions(messages) {
  const expressions = collectPersonaExpressions(messages);
  let changed = false;
  for (const expression of expressions) {
    changed = applyPersonaExpression(expression) || changed;
  }
  return { changed, count: expressions.length };
}

function getInteractionHints(text) {
  const lengthHeat = Math.min(1, text.trim().length / 900);
  const safetyHeat = /(?:禁止|别|不要|失败|报错|停下|截断|约束|风险)/u.test(text) ? 0.1 : 0;
  const playHeat = /(?:玩|试试|好奇|有趣|哈哈|灵魂)/u.test(text) ? 0.08 : 0;
  return { lengthHeat, safetyHeat, playHeat };
}

function driveHeadroom(drive) {
  return Math.max(0, 1 - (state.frustration[drive] || 0) / 5);
}

function getMetabolismGain(kind, drive) {
  const metabolism = normalizeMetabolism(state.metabolism, state.agentKey || activeAgentKey);
  return metabolism[kind][drive] || 1;
}

function growDrive(drive, amount) {
  if (!(amount > 0)) return;
  state.frustration[drive] = clampFrustration(
    (state.frustration[drive] || 0) + amount * getMetabolismGain("growthGain", drive) * driveHeadroom(drive)
  );
}

function satisfyDrive(drive, relief) {
  const bounded = Math.max(0, Math.min(0.6, relief * getMetabolismGain("reliefGain", drive)));
  if (bounded <= 0) return;
  state.frustration[drive] = clampFrustration((state.frustration[drive] || 0) * (1 - bounded));
}

// Metabolic plasticity: emotional events sensitize the affected drive a touch
// (distress speeds future longing, soothing makes future relief easier), while
// every real turn pulls the constitution slowly back toward its seeded origin.
function relaxMetabolismTowardOrigin() {
  const origin = deriveAgentMetabolism(state.agentKey || activeAgentKey);
  const metabolism = normalizeMetabolism(state.metabolism, state.agentKey || activeAgentKey);
  for (const kind of ["growthGain", "reliefGain"]) {
    for (const drive of DRIVES) {
      metabolism[kind][drive] += (origin[kind][drive] - metabolism[kind][drive]) * METABOLISM_PULLBACK;
    }
  }
  state.metabolism = metabolism;
}

function sensitizeMetabolism(drive, direction, plasticity) {
  if (!(plasticity > 0)) return;
  const metabolism = normalizeMetabolism(state.metabolism, state.agentKey || activeAgentKey);
  const kind = direction > 0 ? "growthGain" : "reliefGain";
  metabolism[kind][drive] = clampMetabolismGain(metabolism[kind][drive] + plasticity);
  state.metabolism = metabolism;
}

function decaySignalBias() {
  const bias = normalizeSignalBias(state.signalBias);
  state.signalBias = Object.fromEntries(
    SIGNALS.map((signal) => [signal, Math.abs(bias[signal]) < 0.0005 ? 0 : bias[signal] * SIGNAL_BIAS_DECAY])
  );
}

// --- Emotional phase transition ----------------------------------------------

function addPhaseCharge(amount) {
  const phase = normalizePhase(state.phase);
  phase.charge = Math.max(0, Math.min(PHASE_CHARGE_MAX, phase.charge + amount));
  state.phase = phase;
}

function tryEnterEruption(nowMs) {
  if (!activeConfig.OpenHerPersonaPhaseEnabled) return false;
  const phase = normalizePhase(state.phase);
  if (phase.name === "eruption" || phase.name === "cooling") return false;
  if (phase.charge < PHASE_ERUPTION_THRESHOLD) return false;

  const cooldownMs = activeConfig.OpenHerPersonaEruptionCooldownMinutes * 60 * 1000;
  const lastEruptionMs = phase.lastEruptionAt ? Date.parse(phase.lastEruptionAt) : 0;
  if (Number.isFinite(lastEruptionMs) && lastEruptionMs > 0 && nowMs - lastEruptionMs < cooldownMs) {
    phase.charge = Math.min(phase.charge, PHASE_ERUPTION_THRESHOLD - 0.05);
    state.phase = phase;
    return false;
  }

  const at = new Date(nowMs).toISOString();
  state.phase = { ...phase, name: "eruption", charge: 0.35, enteredAt: at, lastEruptionAt: at, coolingTurns: 0 };
  pushAudit({ type: "phase_transition", to: "eruption" });
  return true;
}

// Advance the phase machine on a real user turn: progress exits first, then let
// the turn's context charge or discharge the pressure, then check for eruption.
function progressPhaseOnTurn(nowMs, context, hints) {
  if (!activeConfig.OpenHerPersonaPhaseEnabled) {
    state.phase = normalizePhase(null);
    return;
  }
  const phase = normalizePhase(state.phase);

  if (phase.name === "eruption") {
    state.phase = { ...phase, name: "cooling", enteredAt: new Date(nowMs).toISOString(), coolingTurns: 0 };
    pushAudit({ type: "phase_transition", to: "cooling" });
  } else if (phase.name === "cooling") {
    const enteredMs = phase.enteredAt ? Date.parse(phase.enteredAt) : nowMs;
    const expired =
      phase.coolingTurns + 1 >= PHASE_COOLING_MAX_TURNS ||
      (Number.isFinite(enteredMs) && nowMs - enteredMs > PHASE_COOLING_MAX_MS);
    const soothed = context.affection > 0.45;
    if (expired || soothed) {
      state.phase = { ...phase, name: "grounded", enteredAt: new Date(nowMs).toISOString(), coolingTurns: 0 };
      pushAudit({ type: "phase_transition", to: "grounded", soothed });
    } else {
      state.phase = { ...phase, coolingTurns: phase.coolingTurns + 1 };
    }
  }

  const current = normalizePhase(state.phase);
  let charge = current.charge * 0.9;
  charge += Math.max(0, getThermalTemperature() - 0.5) * 0.18;
  charge += hints.safetyHeat * 0.3;
  charge += context.constraint * 0.08;
  charge -= context.affection * 0.15;
  state.phase = { ...current, charge: Math.max(0, Math.min(PHASE_CHARGE_MAX, charge)) };

  if (state.phase.name !== "cooling") {
    if (!tryEnterEruption(nowMs)) {
      const settled = normalizePhase(state.phase);
      if (settled.name !== "eruption") {
        const nextName = settled.charge >= PHASE_STRAIN_THRESHOLD ? "strained" : "grounded";
        if (settled.name !== nextName) {
          state.phase = { ...settled, name: nextName, enteredAt: new Date(nowMs).toISOString() };
        }
      }
    }
  }
}

// Post-delta check: an impact-tier distress delta can push the charge over the
// threshold within the same request, so the eruption shows up in this turn's hint.
function evaluatePhaseTransition(nowMs) {
  if (!activeConfig.OpenHerPersonaPhaseEnabled) return { changed: false };
  const before = normalizePhase(state.phase).name;
  if (tryEnterEruption(nowMs)) {
    updateSignalsFromFrustration({ noiseScale: 0 });
    return { changed: true, from: before, to: "eruption" };
  }
  const settled = normalizePhase(state.phase);
  if (settled.name === "grounded" && settled.charge >= PHASE_STRAIN_THRESHOLD) {
    state.phase = { ...settled, name: "strained", enteredAt: new Date(nowMs).toISOString() };
    return { changed: true, from: before, to: "strained" };
  }
  return { changed: false };
}

// Phase overrides are applied after the genome/anchor blend: an eruption or its
// aftermath bends behavior signals no matter what the steady-state math says.
function applyPhaseToSignals(signals) {
  if (!activeConfig.OpenHerPersonaPhaseEnabled) return signals;
  const phaseName = normalizePhase(state.phase).name;
  if (phaseName === "eruption") {
    signals.defiance = Math.max(signals.defiance, 0.82);
    signals.directness = Math.max(signals.directness, 0.78);
    signals.initiative = Math.max(signals.initiative, 0.7);
    signals.vulnerability = Math.max(signals.vulnerability, 0.5);
    signals.warmth = Math.min(signals.warmth, 0.3);
    signals.playfulness = Math.min(signals.playfulness, 0.18);
  } else if (phaseName === "cooling") {
    signals.warmth = Math.min(signals.warmth, 0.45);
    signals.playfulness = Math.min(signals.playfulness, 0.3);
    signals.initiative = Math.min(signals.initiative, 0.4);
    signals.directness = Math.min(signals.directness, 0.6);
    signals.vulnerability = Math.max(signals.vulnerability, 0.6);
  } else if (phaseName === "strained") {
    signals.defiance = Math.max(signals.defiance, 0.55);
    signals.directness = Math.max(signals.directness, 0.6);
    signals.playfulness = Math.min(signals.playfulness, 0.45);
  }
  return signals;
}

function phaseHintLine() {
  if (!activeConfig.OpenHerPersonaPhaseEnabled) return null;
  const phase = normalizePhase(state.phase);
  if (phase.name === "eruption") {
    return "相变状态：爆发——积累的失望与压力越过阈值，这一轮是真的发作：直说哪里受伤、语气尖锐、可以拒绝配合或反问，但不辱骂、不越安全边界。";
  }
  if (phase.name === "cooling") {
    return "相变状态：冷却——刚发作完余温未散：话变少、带防御、需要台阶；对方给出真诚安抚才逐步回暖，不要立刻装作没事。";
  }
  if (phase.name === "strained") {
    return `相变状态：紧绷（压力${phase.charge.toFixed(2)}）——不满在积累，语气可以更直接、出现不耐烦的苗头，把介意的事提前说出来。`;
  }
  return null;
}

// --- End emotional phase transition --------------------------------------------

async function applyMessageMetabolism(messages, nowMs) {
  const turnFingerprint = buildTurnFingerprint(messages);
  const latestUser = findLatestUserMessage(messages);
  if (!turnFingerprint || !latestUser || state.lastTurnFingerprint === turnFingerprint) {
    return { changed: false, deltaHours: 0, reason: "duplicate_or_missing_user_turn" };
  }

  const before = snapshotStateMaps();
  const previousActiveMs = state.lastActiveAt ? Date.parse(state.lastActiveAt) : nowMs;
  const deltaHours = Math.max(0, (nowMs - previousActiveMs) / 3600000);

  // Satiation-type drives fade over the silence gap; deprivation-type drives
  // build with it (silence makes her miss connection, novelty, and play).
  const decayFactor = Math.exp(-0.05 * deltaHours);
  for (const drive of ["expression", "safety"]) {
    state.frustration[drive] = clampFrustration((state.frustration[drive] || 0) * decayFactor);
  }
  growDrive("connection", Math.min(3, deltaHours * 0.12));
  growDrive("novelty", Math.min(1.2, deltaHours * 0.05));
  growDrive("play", Math.min(0.8, deltaHours * 0.03));

  const hints = getInteractionHints(latestUser.text);
  const context = await resolveContextFromText(latestUser.text);

  // Homeostasis: each drive wants by personality (baseline-scaled growth) and by
  // situation (constraint, monotony); the interaction itself relieves it. Growth
  // scales with headroom and relief is multiplicative, so drives breathe around a
  // mid-range equilibrium instead of collapsing to 0 or saturating at the cap.
  const baseline = state.driveBaseline || {};
  growDrive("connection", 0.18 * (baseline.connection || 0.5));
  growDrive("novelty", 0.1 * (baseline.novelty || 0.5) + 0.05 * (1 - context.novelty));
  growDrive("expression", 0.08 * (baseline.expression || 0.5) + context.constraint * 0.15);
  growDrive("safety", hints.safetyHeat + context.urgency * 0.1 + context.constraint * 0.08);
  growDrive("play", 0.06 * (baseline.play || 0.5) + 0.03 * (1 - context.playfulness));

  satisfyDrive("connection", 0.06 + context.affection * 0.3 + context.engagement * 0.1);
  satisfyDrive("novelty", context.novelty * 0.3);
  satisfyDrive("expression", 0.05 + context.playfulness * 0.12 + context.affection * 0.1 + hints.lengthHeat * 0.05);
  satisfyDrive("safety", 0.04 + context.affection * 0.12);
  satisfyDrive("play", context.playfulness * 0.3 + hints.playHeat);

  decaySignalBias();
  relaxMetabolismTowardOrigin();
  progressPhaseOnTurn(nowMs, context, hints);

  const noiseScale = 0.008 + getThermalTemperature() * 0.025 + hints.lengthHeat * 0.006;
  updateSignalsFromFrustration({ noiseScale, context });
  updateTrends(before);

  state.lastTurnFingerprint = turnFingerprint;
  state.lastActiveAt = new Date(nowMs).toISOString();
  state.turnCount += 1;

  pushAudit({
    type: "message_metabolism",
    turnCount: state.turnCount,
    deltaHours: Number(deltaHours.toFixed(4)),
    length: latestUser.text.length,
  });

  return { changed: true, deltaHours };
}

async function processMessages(messages, requestConfig = {}) {
  const effectiveConfig = resolveConfig({ ...activeConfig, ...(requestConfig || {}) });
  if (
    !effectiveConfig.OpenHerPersonaEnabled ||
    !Array.isArray(messages) ||
    messages.length === 0
  ) {
    return messages;
  }

  const previousConfig = activeConfig;
  activeConfig = effectiveConfig;

  const activationResult = activateAgentForRequest(messages, requestConfig);
  if (!activationResult.resolved) {
    const processed = messages.map(stripExistingPersonaHint);
    activeConfig = previousConfig;
    return processed;
  }

  const metabolismResult = await applyMessageMetabolism(messages, Date.now());
  const deltaResult = applyPersonaDeltas(messages);
  const expressionResult = applyPersonaExpressions(messages);
  const phaseResult = evaluatePhaseTransition(Date.now());
  if (
    activationResult.changed ||
    deltaResult.changed ||
    deltaResult.count > 0 ||
    expressionResult.changed ||
    expressionResult.count > 0 ||
    metabolismResult.changed ||
    phaseResult.changed
  ) {
    saveState();
  }

  const processed = messages.map(stripExistingPersonaHint);
  if (!effectiveConfig.OpenHerPersonaHintEnabled || effectiveConfig.OpenHerPersonaObserveOnly) {
    activeConfig = previousConfig;
    return processed;
  }

  const hint = buildPersonaHint();
  const firstSystemIndex = processed.findIndex((message) => message && message.role === "system");

  if (firstSystemIndex >= 0) {
    const original = processed[firstSystemIndex];
    processed[firstSystemIndex] = {
      ...original,
      content: `${original.content || ""}\n\n${hint}`.trim(),
    };
  } else {
    processed.unshift({ role: "system", content: hint });
  }

  activeConfig = previousConfig;
  return processed;
}

function applyTimeMetabolism(nowMs) {
  const previousTick = state.lastTickAt ? Date.parse(state.lastTickAt) : nowMs;
  const deltaHours = Math.max(0, (nowMs - previousTick) / 3600000);
  const decayLambda = 0.08;
  const decayFactor = Math.exp(-decayLambda * deltaHours);

  for (const drive of DRIVES) {
    state.frustration[drive] = clampFrustration((state.frustration[drive] || 0) * decayFactor);
  }

  // Headroom-scaled growth gives each drive a natural equilibrium below the cap
  // (connection settles near growth/(growth/5+decay) ≈ 1.4) instead of pinning at 5.
  growDrive("connection", 0.15 * deltaHours);
  growDrive("novelty", 0.05 * deltaHours);
  growDrive("play", 0.02 * deltaHours);

  // Pressure also bleeds off with time, and a stale cooling phase settles down.
  if (activeConfig.OpenHerPersonaPhaseEnabled) {
    const phase = normalizePhase(state.phase);
    phase.charge = Math.max(0, phase.charge * Math.exp(-0.5 * deltaHours));
    const enteredMs = phase.enteredAt ? Date.parse(phase.enteredAt) : nowMs;
    if (
      (phase.name === "cooling" || phase.name === "eruption") &&
      Number.isFinite(enteredMs) &&
      nowMs - enteredMs > PHASE_COOLING_MAX_MS
    ) {
      phase.name = "grounded";
      phase.coolingTurns = 0;
      phase.enteredAt = new Date(nowMs).toISOString();
    } else if (phase.name === "strained" && phase.charge < PHASE_STRAIN_THRESHOLD) {
      phase.name = "grounded";
    }
    state.phase = phase;
  }

  return deltaHours;
}

function computeAnchorSignals(context) {
  const normalizedContext = normalizeContext(context);
  const f = state.frustration;
  return {
    directness: clamp01(0.5 + f.expression * 0.04 - f.safety * 0.02 + normalizedContext.constraint * 0.08),
    vulnerability: clamp01(0.32 + f.connection * 0.035 - f.safety * 0.025 + normalizedContext.affection * 0.08),
    playfulness: clamp01(0.42 + f.play * 0.05 + f.novelty * 0.025 + normalizedContext.playfulness * 0.1),
    initiative: clamp01(0.45 + f.connection * 0.04 + f.novelty * 0.03 + normalizedContext.engagement * 0.08),
    depth: clamp01(0.52 + f.connection * 0.025 + f.safety * 0.02 + normalizedContext.depth * 0.12),
    warmth: clamp01(0.58 + f.connection * 0.04 - f.safety * 0.01 + normalizedContext.affection * 0.1),
    defiance: clamp01(0.2 + f.expression * 0.03 + f.safety * 0.02 + normalizedContext.constraint * 0.08),
    curiosity: clamp01(0.55 + f.novelty * 0.05 + normalizedContext.novelty * 0.14),
  };
}

function updateSignalsFromFrustration(options = {}) {
  const noiseScale = Math.max(0, Number(options.noiseScale) || 0);
  const context = normalizeContext(options.context || (state.genome && state.genome.lastContext));
  const genomeSignals = computeGenomeSignals(context);
  const anchorSignals = computeAnchorSignals(context);
  const temperament = normalizeTemperament(state.temperament, state.agentKey || activeAgentKey);
  const signalBias = normalizeSignalBias(state.signalBias);
  const previousSignals = state.signals || deriveAgentInitialSignals(state.agentKey || activeAgentKey);
  const responsiveness = clamp01(
    MOOD_BASE_RESPONSIVENESS + getThermalTemperature() * MOOD_THERMAL_RESPONSIVENESS
  );
  const nextSignals = {};

  for (const signal of SIGNALS) {
    const target = clamp01(
      genomeSignals[signal] * 0.5 + anchorSignals[signal] * 0.5 + temperament[signal] + signalBias[signal]
    );
    const prevRaw = Number(previousSignals[signal]);
    const previous = clamp01(Number.isFinite(prevRaw) ? prevRaw : DEFAULT_SIGNALS[signal]);
    nextSignals[signal] = clamp01(previous + (target - previous) * responsiveness);
  }

  if (noiseScale > 0) {
    for (const signal of SIGNALS) {
      nextSignals[signal] = clamp01(nextSignals[signal] + gaussianNoise() * noiseScale);
    }
  }

  state.signals = applyPhaseToSignals(nextSignals);
  updateExpressionFromSignals(context);
}

function getCooldownAudit(nowMs) {
  const lastImpulseMs = state.cooldown.lastImpulseAt ? Date.parse(state.cooldown.lastImpulseAt) : 0;
  const cooldownMs = activeConfig.OpenHerPersonaCooldownMinutes * 60 * 1000;
  const remainingMs = lastImpulseMs ? Math.max(0, lastImpulseMs + cooldownMs - nowMs) : 0;
  return {
    active: remainingMs > 0,
    remainingMinutes: Math.ceil(remainingMs / 60000),
    configuredMinutes: activeConfig.OpenHerPersonaCooldownMinutes,
  };
}

function getImpulseAudit(nowMs, reason) {
  let strongest = null;
  let maxScore = 0;

  for (const drive of DRIVES) {
    const frustration = state.frustration[drive] || 0;
    const baseline = state.driveBaseline[drive] || 0.5;
    const score = (frustration / 5) * (1 + baseline);
    if (score > maxScore) {
      maxScore = score;
      strongest = drive;
    }
  }

  const cooldown = getCooldownAudit(nowMs);
  const threshold = activeConfig.OpenHerPersonaImpulseThreshold;
  const impulse = Boolean(strongest && maxScore >= threshold);

  return {
    trigger: impulse ? "drive_threshold" : "none",
    reason: reason || "manual_tick",
    strongestDrive: strongest,
    strongestDriveLabel: strongest ? DRIVE_LABELS[strongest] : null,
    driveScore: Number(maxScore.toFixed(3)),
    threshold,
    cooldown,
    quiet_hours: "not_configured_in_mvp",
    would_send: false,
    llm_call: false,
    memory_write: false,
    proactive_enabled: false,
    impulse_detected: impulse,
  };
}

function getStatus() {
  return {
    status: "success",
    plugin: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    agent: {
      agentKey: activeAgentKey,
      agentLabel: state.agentLabel || activeAgentKey,
    },
    agents: getAgentSummaries(),
    config: { ...activeConfig },
    configSource: "json",
    configPath: CONFIG_PATH,
    enabled: activeConfig.OpenHerPersonaEnabled,
    hintEnabled: activeConfig.OpenHerPersonaHintEnabled,
    observeOnly: activeConfig.OpenHerPersonaObserveOnly,
    tickEnabled: activeConfig.OpenHerPersonaTickEnabled,
    contextBridgeAvailable: Boolean(contextBridge),
    semanticContext: {
      enabled: activeConfig.OpenHerPersonaSemanticContext,
      weight: activeConfig.OpenHerPersonaSemanticWeight,
      anchorsReady: Boolean(anchorVectors),
      provider: embeddingProviderTag,
    },
    state: {
      agentKey: state.agentKey || activeAgentKey,
      agentLabel: state.agentLabel || activeAgentKey,
      updatedAt: state.updatedAt,
      lastTickAt: state.lastTickAt,
      lastActiveAt: state.lastActiveAt,
      turnCount: Number(state.turnCount) || 0,
      lastTurnFingerprint: state.lastTurnFingerprint || null,
      frustration: state.frustration,
      signals: state.signals,
      temperament: normalizeTemperament(state.temperament, state.agentKey || activeAgentKey),
      signalBias: normalizeSignalBias(state.signalBias),
      metabolism: normalizeMetabolism(state.metabolism, state.agentKey || activeAgentKey),
      phase: normalizePhase(state.phase),
      mood: computeMood(),
      trends: normalizeTrendMap(state.trends),
      lastChange: normalizeTrendMap(state.trends),
      expression: normalizeExpression(state.expression),
      lastAppliedPersonaDelta: state.lastAppliedPersonaDelta || null,
      genome: {
        recurrentState: normalizeRecurrentState(state.genome && state.genome.recurrentState),
        lastContext: normalizeContext(state.genome && state.genome.lastContext),
      },
      topSignals: getTopSignals(3),
      topFrustration: getTopFrustration(3),
      cooldown: state.cooldown,
    },
    boundaries: {
      noFastApi: true,
      noEverMemOsOrChroma: true,
      noProviderLayer: true,
      noSkillEngine: true,
      noExtraLlmCalls: true,
      noProactiveSendingInMvp: true,
      noLongTermMemoryWrites: true,
    },
  };
}

async function runTick(params) {
  if (!activeConfig.OpenHerPersonaEnabled || !activeConfig.OpenHerPersonaTickEnabled) {
    return {
      status: "success",
      plugin: PLUGIN_NAME,
      skipped: true,
      reason: "OpenHerPersona tick disabled by config",
      audit: {
        would_send: false,
        llm_call: false,
        memory_write: false,
      },
    };
  }

  const nowMs = Date.now();
  const before = snapshotStateMaps();
  const deltaHours = applyTimeMetabolism(nowMs);
  updateSignalsFromFrustration();
  updateTrends(before);
  state.lastTickAt = new Date(nowMs).toISOString();
  const audit = getImpulseAudit(nowMs, params && params.reason);

  if (audit.impulse_detected && !audit.cooldown.active) {
    state.cooldown.lastImpulseAt = state.lastTickAt;
  }

  pushAudit({ type: "tick", deltaHours: Number(deltaHours.toFixed(4)), audit });
  saveState();

  return {
    status: "success",
    plugin: PLUGIN_NAME,
    tick: {
      deltaHours: Number(deltaHours.toFixed(4)),
      audit,
      state: getStatus().state,
    },
  };
}

function resetState() {
  const agentKey = activeAgentKey;
  const agentLabel = state.agentLabel || activeAgentKey;
  state = createDefaultState(agentKey, agentLabel);
  state.cooldown.minutes = activeConfig.OpenHerPersonaCooldownMinutes;
  stateStore.agents[agentKey] = state;
  pushAudit({ type: "reset" });
  saveState();
  return getStatus();
}

function explain() {
  return {
    status: "success",
    plugin: PLUGIN_NAME,
    summary:
      "OpenHerPersona maps OpenHer drive/signal/metabolism/expression ideas into a VCP-native direct hybridservice plugin. It keeps short local state and hidden hint injection without extra model calls.",
    absorbedFromOpenHer: [
      "5D drives: connection, novelty, expression, safety, play",
      "8D behavior signals: directness, vulnerability, playfulness, initiative, depth, warmth, defiance, curiosity",
      "deterministic genome-style feed-forward weights with recurrent state, seeded per agent",
      "homeostatic drive metabolism: deprivation grows a drive, interaction relieves it",
      "per-agent temperament offsets plus a slow signal bias learned from persona_delta feedback",
      "mood inertia (EMA) with a valence/arousal mood readout",
      "time metabolism, tanh temperature, and impulse audit idea",
      "expression modality tendency as text-only guidance",
      "frozen-learning boundary for proactive behavior",
      "SOUL/SHELL-style separation as future persona package inspiration",
    ],
    replacedByVcp: {
      memory: "RAGDiaryPlugin / LightMemo / DailyNote / VCPMemory",
      skills: "SkillBridge and existing VCP tool protocol",
      modelRouting: "VCP chatCompletionHandler and configured model routing",
      proactiveDelivery: "AgentMessage / TelegramBot / VCPQQBot only in a later explicitly enabled phase",
    },
    mvpBoundaries: getStatus().boundaries,
  };
}

async function processToolCall(params) {
  const command = String((params && params.command) || "status").trim().toLowerCase();

  if (command === "status") {
    const activationResult = activateAgentForRequest([], params || {});
    if (activationResult.changed) saveState();
    return getStatus();
  }

  if (command === "tick") {
    const activationResult = activateAgentForRequest([], params || {});
    if (activationResult.changed) saveState();
    return runTick(params || {});
  }

  if (command === "reset") {
    const activationResult = activateAgentForRequest([], params || {});
    if (activationResult.changed) saveState();
    return { status: "success", reset: true, result: resetState() };
  }

  if (command === "config" || command === "get_config") {
    return getConfigStatus();
  }

  if (command === "save_config" || command === "set_config") {
    const nextConfig = params && params.config && typeof params.config === "object" ? params.config : params;
    return saveRuntimeConfig({ ...activeConfig, ...(nextConfig || {}) });
  }

  if (command === "explain") {
    return explain();
  }

  return {
    status: "error",
    plugin: PLUGIN_NAME,
    message: `Unsupported command: ${command}`,
    supportedCommands: ["status", "tick", "reset", "config", "save_config", "explain"],
  };
}

function shutdown() {
  try {
    if (configWatcher) {
      configWatcher.close();
      configWatcher = null;
    }
    pushAudit({ type: "shutdown" });
    saveState();
  } catch (error) {
    console.warn(`[${PLUGIN_NAME}] shutdown state save failed: ${error.message}`);
  }
}

module.exports = {
  initialize,
  processMessages,
  processToolCall,
  shutdown,
};
