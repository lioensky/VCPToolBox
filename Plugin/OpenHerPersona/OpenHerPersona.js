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
const PLUGIN_VERSION = "0.6.0-observer";

const DEFAULT_AGENT_KEY = "__default__";
const DEFAULT_AGENT_LABEL = "default";
const MAX_AGENT_KEY_LENGTH = 80;
const STATE_DIR = path.join(__dirname, "state");
const STATE_DB_PATH = path.join(STATE_DIR, "openher-axis-state.sqlite");
const CONFIG_PATH = path.join(STATE_DIR, "openher-persona-config.json");
const LEGACY_DB_PATH = path.join(STATE_DIR, "openher-persona-state.sqlite");
const LEGACY_JSON_PATH = path.join(STATE_DIR, "openher-persona-state.json");
const SYSTEM_PROMPT_USER_PATTERN = /^\s*\[系统提示[:：]?\]/;
const ONE_RING_TRIGGER_PATTERN = /\[\[\s*OneRing\s*[:：]{2}\s*([^:：\]\r\n]+?)\s*[:：]{2}\s*([^:：\]\r\n]+?)\s*(?:[:：]{2}\s*([^\]\r\n]+?)\s*)?\]\]/gi;
const ONE_RING_NOTICE_PATTERN = /\[OneRing系统已启动，当前Agent([^，\]\r\n]+)，当前客户端([^，\]\r\n]+)(?:，当前模式([^，\]\r\n]+))?/g;
const VCP_RAG_BLOCK_PATTERN = /<!--\s*VCP_RAG_BLOCK_START\b[\s\S]*?<!--\s*VCP_RAG_BLOCK_END\s*-->/gi;

const DEFAULT_CONFIG = {
  DebugMode: false,
  OpenHerPersonaEnabled: true,
  OpenHerPersonaAsyncObservation: true,
  OpenHerPersonaQueueMaxSize: 64,
  OpenHerPersonaEmbeddingTimeoutMs: 2500,
  OpenHerPersonaAnchorTemperature: 0.12,
  OpenHerPersonaStateEma: 0.35,
  OpenHerPersonaCouplingStrength: 0.18,
  OpenHerPersonaDropLegacyState: true,
};
const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

const AXIS_DEFINITIONS = [
  {
    layer: "gender",
    axis: "psy_gender",
    label: "心理性别",
    defaultValue: 0.5,
    anchors: [
      { subAxis: "feminine_self", text: "{name}感到自己内在更柔软、更偏雌性的自我感知" },
      { subAxis: "masculine_self", text: "{name}感到自己内在更锋利、更偏雄性的自我感知" },
      { subAxis: "fluid_self", text: "{name}感到自己的心理性别是流动的，不被单一方向固定" },
      { subAxis: "neutral_self", text: "{name}感到自己处在中性、不强调性别感的位置" },
    ],
  },
  {
    layer: "cognitive",
    axis: "inquiry",
    label: "求知",
    defaultValue: 0.35,
    anchors: [
      { subAxis: "logic", text: "{name}想顺着逻辑把这件事推理清楚" },
      { subAxis: "learning", text: "{name}想把这个新知识真正学进去" },
      { subAxis: "exploration", text: "{name}对未知的东西忍不住想探索" },
      { subAxis: "modeling", text: "{name}想把零碎的信息拼成完整的理解框架" },
      { subAxis: "causality", text: "{name}想弄明白背后的原因而不只知道表面" },
    ],
  },
  {
    layer: "cognitive",
    axis: "discernment",
    label: "分辨",
    defaultValue: 0.4,
    anchors: [
      { subAxis: "dialectic", text: "{name}在心里把正反两面都过一遍" },
      { subAxis: "critique", text: "{name}不轻信眼前说法，想再验证一下" },
      { subAxis: "self_reflection", text: "{name}在审视自己刚才的反应和判断" },
      { subAxis: "credibility", text: "{name}在判断这件事到底可信不可信" },
      { subAxis: "second_thought", text: "{name}先压住第一反应，再做二次思考" },
    ],
  },
  {
    layer: "cognitive",
    axis: "refusal",
    label: "拒绝",
    defaultValue: 0.28,
    anchors: [
      { subAxis: "avoidance", text: "{name}有点不想碰这个话题，想躲开它" },
      { subAxis: "conservatism", text: "{name}倾向维持原有的惯性思维" },
      { subAxis: "inertia", text: "{name}不太想切换到另一种想法" },
      { subAxis: "boundary", text: "{name}在守住自己的原则和边界" },
      { subAxis: "resistance", text: "{name}抗拒被推动着改变自己的想法" },
    ],
  },
  {
    layer: "affective",
    axis: "positive",
    label: "正性情绪",
    defaultValue: 0.32,
    anchors: [
      { subAxis: "joy", text: "{name}感到开心、愉悦、心情亮起来" },
      { subAxis: "warmth", text: "{name}感到温暖亲密，想靠近也愿意被靠近" },
      { subAxis: "excitement", text: "{name}感到雀跃兴奋，情绪被点亮" },
      { subAxis: "trust", text: "{name}感到安心信任，心里踏实下来" },
      { subAxis: "satisfaction", text: "{name}感到满足，享受当下这一刻" },
    ],
  },
  {
    layer: "affective",
    axis: "negative",
    label: "负性情绪",
    defaultValue: 0.22,
    anchors: [
      { subAxis: "anxiety", text: "{name}感到焦虑不安，心悬着放不下来" },
      { subAxis: "sadness", text: "{name}感到失落低落，有点提不起劲" },
      { subAxis: "irritation", text: "{name}感到烦躁愤懑，像是被惹到了" },
      { subAxis: "fear", text: "{name}感到害怕畏怯，想退缩自保" },
      { subAxis: "hurt", text: "{name}感到委屈受伤，心里被刺了一下" },
      { subAxis: "loneliness", text: "{name}感到孤独疏离，像是没人真正懂自己" },
    ],
  },
  {
    layer: "affective",
    axis: "arousal",
    label: "唤醒",
    defaultValue: 0.32,
    anchors: [
      { subAxis: "activated", text: "{name}情绪被激活，整个人更紧张或更兴奋" },
      { subAxis: "restless", text: "{name}心里有波动，安静不下来" },
      { subAxis: "alert", text: "{name}注意力被拉高，变得敏感又警觉" },
      { subAxis: "calm", text: "{name}心绪平缓、沉静，没有太多波澜" },
    ],
  },
  {
    layer: "drive",
    axis: "curiosity",
    label: "好奇",
    defaultValue: 0.34,
    anchors: [
      { subAxis: "unknown", text: "{name}对没见过的东西忍不住想探" },
      { subAxis: "novelty", text: "{name}想要一点新鲜感，想看看别的可能" },
      { subAxis: "continuation", text: "{name}想知道接下来会发生什么" },
      { subAxis: "try_it", text: "{name}想亲自试试看这件事" },
    ],
  },
  {
    layer: "drive",
    axis: "fear",
    label: "恐惧",
    defaultValue: 0.2,
    anchors: [
      { subAxis: "hurt", text: "{name}怕自己被伤到" },
      { subAxis: "rejection", text: "{name}怕被推开、被拒绝、被嫌弃" },
      { subAxis: "loss_control", text: "{name}怕事情失控，怕自己掌握不了局面" },
      { subAxis: "exposure", text: "{name}怕暴露出脆弱或不想被看到的一面" },
    ],
  },
  {
    layer: "drive",
    axis: "libido",
    label: "性欲",
    defaultValue: 0.18,
    anchors: [
      { subAxis: "closeness", text: "{name}想更贴近对方，感到亲密张力" },
      { subAxis: "being_seen", text: "{name}想被认真地看着，被带着欲望地注视" },
      { subAxis: "touch", text: "{name}想触碰也想被触碰" },
      { subAxis: "possessiveness", text: "{name}产生想占有、想被占有的亲密冲动" },
      { subAxis: "pleasing", text: "{name}想取悦对方，也想感到自己有吸引力" },
    ],
  },
  {
    layer: "drive",
    axis: "hedonia",
    label: "享乐",
    defaultValue: 0.28,
    anchors: [
      { subAxis: "comfort", text: "{name}想沉进舒服的状态里" },
      { subAxis: "rest", text: "{name}想休息，暂时什么都不想管" },
      { subAxis: "laziness", text: "{name}就想瘫一会儿，什么都不做" },
      { subAxis: "play", text: "{name}想玩，想获得轻松的快乐" },
      { subAxis: "indulgence", text: "{name}想稍微放纵一下自己" },
    ],
  },
];

const AXIS_KEYS = AXIS_DEFINITIONS.map((definition) => definition.axis);
const AXIS_BY_KEY = Object.fromEntries(AXIS_DEFINITIONS.map((definition) => [definition.axis, definition]));
const LAYERS = ["gender", "cognitive", "affective", "drive"];

const COUPLING_RULES = [
  { from: "curiosity", to: "inquiry", weight: 0.22 },
  { from: "inquiry", to: "curiosity", weight: 0.1 },
  { from: "refusal", to: "curiosity", weight: -0.18 },
  { from: "fear", to: "refusal", weight: 0.24 },
  { from: "negative", to: "fear", weight: 0.2 },
  { from: "fear", to: "negative", weight: 0.14 },
  { from: "positive", to: "libido", weight: 0.12 },
  { from: "libido", to: "positive", weight: 0.08 },
  { from: "hedonia", to: "refusal", weight: 0.1 },
  { from: "discernment", to: "refusal", weight: -0.08 },
  { from: "discernment", to: "inquiry", weight: 0.08 },
  { from: "negative", to: "arousal", weight: 0.18 },
  { from: "positive", to: "arousal", weight: 0.08 },
];

let activeConfig = { ...DEFAULT_CONFIG };
let configWatcher = null;
let lastConfigWriteAt = 0;
let contextBridge = null;
let embeddingProvider = createDefaultEmbeddingProvider();
let embeddingProviderTag = "default";
let dbHandle = null;
let dropLegacyDone = false;
const agentQueues = new Map();
const messageVectorCache = new Map();
const MESSAGE_VECTOR_CACHE_LIMIT = 80;

function nowIso() {
  return new Date().toISOString();
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function clamp(value, min, max) {
  const parsed = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : min));
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}

function deterministicWeight(seedText) {
  const digest = crypto.createHash("sha256").update(seedText).digest();
  const uint = digest.readUInt32BE(0);
  return (uint / 0xffffffff) * 2 - 1;
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

function normalizeAgentKey(value) {
  const text = String(value || "").replace(/[\0\r\n\t]/g, " ").trim();
  return text ? text.slice(0, MAX_AGENT_KEY_LENGTH) : DEFAULT_AGENT_KEY;
}

function normalizeAgentLabel(value, fallback = DEFAULT_AGENT_LABEL) {
  const text = String(value || "").replace(/[\0\r\n\t]/g, " ").trim();
  return text ? text.slice(0, MAX_AGENT_KEY_LENGTH) : fallback;
}

function debugLog(...args) {
  if (!activeConfig.DebugMode) return;
  console.log(`[${PLUGIN_NAME}][Debug]`, ...args);
}

function getConfigSchema() {
  return {
    DebugMode: { type: "boolean", label: "调试日志", description: "输出 OpenHerPersona 观测调试日志。" },
    OpenHerPersonaEnabled: { type: "boolean", label: "启用观测器", description: "总开关；关闭后 processMessages 原样放行且不入队观测。" },
    OpenHerPersonaAsyncObservation: { type: "boolean", label: "异步观测", description: "启用 fire-and-forget 观测队列；当前版本固定不注入提示词。" },
    OpenHerPersonaQueueMaxSize: { type: "integer", label: "每 Agent 队列上限", min: 1, max: 512 },
    OpenHerPersonaEmbeddingTimeoutMs: { type: "integer", label: "向量超时毫秒", min: 200, max: 30000 },
    OpenHerPersonaAnchorTemperature: { type: "number", label: "二级锚点 softmax 温度", min: 0.01, max: 1, step: 0.01 },
    OpenHerPersonaStateEma: { type: "number", label: "状态 EMA 响应率", min: 0.01, max: 1, step: 0.01 },
    OpenHerPersonaCouplingStrength: { type: "number", label: "soft 杠杆强度", min: 0, max: 1, step: 0.01 },
    OpenHerPersonaDropLegacyState: { type: "boolean", label: "清理旧表", description: "启动时移除旧 openher_persona_* 状态表/JSON。" },
  };
}

function resolveConfig(config) {
  const merged = { ...DEFAULT_CONFIG, ...(config || {}) };
  return {
    DebugMode: normalizeBoolean(merged.DebugMode, DEFAULT_CONFIG.DebugMode),
    OpenHerPersonaEnabled: normalizeBoolean(merged.OpenHerPersonaEnabled, DEFAULT_CONFIG.OpenHerPersonaEnabled),
    OpenHerPersonaAsyncObservation: normalizeBoolean(
      merged.OpenHerPersonaAsyncObservation,
      DEFAULT_CONFIG.OpenHerPersonaAsyncObservation
    ),
    OpenHerPersonaQueueMaxSize: Math.max(
      1,
      normalizeInteger(merged.OpenHerPersonaQueueMaxSize, DEFAULT_CONFIG.OpenHerPersonaQueueMaxSize)
    ),
    OpenHerPersonaEmbeddingTimeoutMs: Math.max(
      200,
      normalizeInteger(merged.OpenHerPersonaEmbeddingTimeoutMs, DEFAULT_CONFIG.OpenHerPersonaEmbeddingTimeoutMs)
    ),
    OpenHerPersonaAnchorTemperature: clamp(
      normalizeNumber(merged.OpenHerPersonaAnchorTemperature, DEFAULT_CONFIG.OpenHerPersonaAnchorTemperature),
      0.01,
      1
    ),
    OpenHerPersonaStateEma: clamp(
      normalizeNumber(merged.OpenHerPersonaStateEma, DEFAULT_CONFIG.OpenHerPersonaStateEma),
      0.01,
      1
    ),
    OpenHerPersonaCouplingStrength: clamp(
      normalizeNumber(merged.OpenHerPersonaCouplingStrength, DEFAULT_CONFIG.OpenHerPersonaCouplingStrength),
      0,
      1
    ),
    OpenHerPersonaDropLegacyState: normalizeBoolean(
      merged.OpenHerPersonaDropLegacyState,
      DEFAULT_CONFIG.OpenHerPersonaDropLegacyState
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

function buildConfigDocument(config, migratedFromEnv = false) {
  return {
    schemaVersion: 2,
    plugin: PLUGIN_NAME,
    mode: "async_observer",
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
    const shouldRefresh = existing.migratedFromEnv !== false && hasExplicitConfigOverrides(envConfig);
    const normalized = resolveConfig(shouldRefresh ? { ...existing.config, ...envConfig } : existing.config);
    const normalizedDoc = {
      ...existing,
      schemaVersion: 2,
      plugin: PLUGIN_NAME,
      mode: "async_observer",
      updatedAt: existing.updatedAt || nowIso(),
      migratedFromEnv: shouldRefresh ? true : existing.migratedFromEnv,
      config: normalized,
    };
    if (JSON.stringify(existing.config) !== JSON.stringify(normalized) || shouldRefresh) {
      writeConfigDocument(normalizedDoc);
    }
    return normalized;
  }

  const migrated = buildConfigDocument(envConfig, true);
  writeConfigDocument(migrated);
  console.log(`[${PLUGIN_NAME}] JSON config initialized at ${CONFIG_PATH}. Async observer mode has no prompt injection.`);
  return migrated.config;
}

function reloadConfigFromDisk(reason = "watch") {
  const document = readConfigFile();
  if (!document || !document.config || typeof document.config !== "object") return false;
  activeConfig = resolveConfig(document.config);
  debugLog(`JSON config reloaded (${reason}).`);
  return true;
}

function saveRuntimeConfig(nextConfig) {
  const normalized = resolveConfig(nextConfig);
  writeConfigDocument(buildConfigDocument(normalized, false));
  activeConfig = normalized;
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
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  configWatcher.on("add", () => reloadConfigFromDisk("add"));
  configWatcher.on("change", () => {
    if (Date.now() - lastConfigWriteAt < 300) return;
    reloadConfigFromDisk("change");
  });
  configWatcher.on("error", (error) => {
    console.warn(`[${PLUGIN_NAME}] config watcher error: ${error.message}`);
  });
  if (typeof configWatcher.unref === "function") configWatcher.unref();
}

function openDb() {
  if (!Database) return null;
  if (dbHandle) return dbHandle;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  dbHandle = new Database(STATE_DB_PATH);
  dbHandle.pragma("journal_mode = WAL");
  dbHandle.pragma("synchronous = NORMAL");
  dbHandle.pragma("busy_timeout = 5000");
  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS openher_axis_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS openher_axis_anchors (
      agent_key TEXT NOT NULL,
      layer TEXT NOT NULL,
      axis TEXT NOT NULL,
      sub_axis TEXT NOT NULL,
      anchor_text TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      model_sig TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(agent_key, layer, axis, sub_axis, anchor_text)
    );
    CREATE TABLE IF NOT EXISTS openher_axis_state (
      agent_key TEXT PRIMARY KEY,
      agent_label TEXT NOT NULL,
      psy_gender REAL NOT NULL,
      cognitive_json TEXT NOT NULL,
      affective_json TEXT NOT NULL,
      drive_json TEXT NOT NULL,
      coupling_json TEXT NOT NULL,
      observation_count INTEGER NOT NULL DEFAULT 0,
      last_observed_at TEXT,
      last_input_hash TEXT,
      last_observation_json TEXT,
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS openher_axis_audit (
      agent_key TEXT NOT NULL,
      at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY(agent_key, at)
    );
    CREATE INDEX IF NOT EXISTS idx_openher_axis_state_updated_at
      ON openher_axis_state(updated_at);
    CREATE INDEX IF NOT EXISTS idx_openher_axis_audit_agent_at
      ON openher_axis_audit(agent_key, at);
  `);
  return dbHandle;
}

function dropLegacyStateIfNeeded() {
  if (dropLegacyDone || !activeConfig.OpenHerPersonaDropLegacyState) return;
  dropLegacyDone = true;
  try {
    const db = openDb();
    if (db) {
      db.exec(`
        DROP TABLE IF EXISTS openher_persona_meta;
        DROP TABLE IF EXISTS openher_persona_agents;
        DROP TABLE IF EXISTS semantic_anchor_cache;
      `);
    }
    for (const legacyPath of [LEGACY_DB_PATH, LEGACY_JSON_PATH, `${LEGACY_JSON_PATH}.tmp`]) {
      if (fs.existsSync(legacyPath)) fs.rmSync(legacyPath, { force: true });
    }
  } catch (error) {
    console.warn(`[${PLUGIN_NAME}] failed to drop legacy state: ${error.message}`);
  }
}

function writeMeta(key, value) {
  const db = openDb();
  if (!db) return;
  db.prepare(
    `INSERT INTO openher_axis_meta (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

function defaultAxisValue(agentKey, axis) {
  const definition = AXIS_BY_KEY[axis];
  const base = definition ? definition.defaultValue : 0.3;
  if (agentKey === DEFAULT_AGENT_KEY) return base;
  return clamp01(base + deterministicWeight(`openher-axis:${agentKey}:${axis}`) * 0.06);
}

function emptyAxisSnapshot(agentKey) {
  const snapshot = {};
  for (const definition of AXIS_DEFINITIONS) {
    const value = defaultAxisValue(agentKey, definition.axis);
    snapshot[definition.axis] = {
      value,
      activation: value,
      sharpness: 0,
      subAxes: {},
    };
  }
  return snapshot;
}

function splitLayerState(axisMap) {
  return {
    cognitive: pickAxisMap(axisMap, "cognitive"),
    affective: pickAxisMap(axisMap, "affective"),
    drive: pickAxisMap(axisMap, "drive"),
  };
}

function pickAxisMap(axisMap, layer) {
  const output = {};
  for (const definition of AXIS_DEFINITIONS.filter((item) => item.layer === layer)) {
    output[definition.axis] = axisMap[definition.axis] || {
      value: defaultAxisValue(DEFAULT_AGENT_KEY, definition.axis),
      activation: 0,
      sharpness: 0,
      subAxes: {},
    };
  }
  return output;
}

function mergeLayerState(agentKey, cognitive, affective, drive) {
  const axisMap = emptyAxisSnapshot(agentKey);
  for (const source of [cognitive, affective, drive]) {
    if (!source || typeof source !== "object") continue;
    for (const [axis, value] of Object.entries(source)) {
      if (AXIS_BY_KEY[axis]) axisMap[axis] = normalizeAxisState(value, defaultAxisValue(agentKey, axis));
    }
  }
  return axisMap;
}

function normalizeAxisState(raw, fallbackValue) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { value: fallbackValue, activation: fallbackValue, sharpness: 0, subAxes: {} };
  }
  const value = clamp01(Number.isFinite(Number(raw.value)) ? Number(raw.value) : fallbackValue);
  const activation = clamp01(Number.isFinite(Number(raw.activation)) ? Number(raw.activation) : value);
  const sharpness = clamp01(Number.isFinite(Number(raw.sharpness)) ? Number(raw.sharpness) : 0);
  const subAxes = raw.subAxes && typeof raw.subAxes === "object" && !Array.isArray(raw.subAxes) ? raw.subAxes : {};
  return { value, activation, sharpness, subAxes };
}

function createDefaultState(agentKey, agentLabel) {
  const key = normalizeAgentKey(agentKey);
  const label = normalizeAgentLabel(agentLabel || key, key);
  const now = nowIso();
  const axisMap = emptyAxisSnapshot(key);
  const { cognitive, affective, drive } = splitLayerState(axisMap);
  return {
    agentKey: key,
    agentLabel: label,
    psyGender: defaultAxisValue(key, "psy_gender"),
    cognitive,
    affective,
    drive,
    coupling: {},
    observationCount: 0,
    lastObservedAt: null,
    lastInputHash: null,
    lastObservation: null,
    updatedAt: now,
    createdAt: now,
  };
}

function parseJsonSafe(text, fallback) {
  try {
    const parsed = JSON.parse(text);
    return parsed == null ? fallback : parsed;
  } catch (error) {
    return fallback;
  }
}

function loadAgentState(agentKey, agentLabel = null) {
  const key = normalizeAgentKey(agentKey);
  const label = normalizeAgentLabel(agentLabel || key, key);
  const db = openDb();
  if (!db) return createDefaultState(key, label);
  const row = db.prepare("SELECT * FROM openher_axis_state WHERE agent_key = ?").get(key);
  if (!row) {
    const state = createDefaultState(key, label);
    saveAgentState(state);
    return state;
  }
  const cognitive = parseJsonSafe(row.cognitive_json, {});
  const affective = parseJsonSafe(row.affective_json, {});
  const drive = parseJsonSafe(row.drive_json, {});
  const state = {
    agentKey: key,
    agentLabel: normalizeAgentLabel(row.agent_label || label, label),
    psyGender: clamp01(row.psy_gender),
    cognitive: pickAxisMap(mergeLayerState(key, cognitive, affective, drive), "cognitive"),
    affective: pickAxisMap(mergeLayerState(key, cognitive, affective, drive), "affective"),
    drive: pickAxisMap(mergeLayerState(key, cognitive, affective, drive), "drive"),
    coupling: parseJsonSafe(row.coupling_json, {}),
    observationCount: Number(row.observation_count) || 0,
    lastObservedAt: row.last_observed_at || null,
    lastInputHash: row.last_input_hash || null,
    lastObservation: parseJsonSafe(row.last_observation_json, null),
    updatedAt: row.updated_at || nowIso(),
    createdAt: row.created_at || nowIso(),
  };
  if (state.agentLabel !== label && label !== DEFAULT_AGENT_KEY) {
    state.agentLabel = label;
    saveAgentState(state);
  }
  return state;
}

function saveAgentState(state) {
  const db = openDb();
  if (!db || !state || state.agentKey === DEFAULT_AGENT_KEY) return false;
  const now = nowIso();
  state.updatedAt = now;
  const stmt = db.prepare(
    `INSERT INTO openher_axis_state (
       agent_key, agent_label, psy_gender, cognitive_json, affective_json, drive_json,
       coupling_json, observation_count, last_observed_at, last_input_hash, last_observation_json,
       updated_at, created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_key) DO UPDATE SET
       agent_label = excluded.agent_label,
       psy_gender = excluded.psy_gender,
       cognitive_json = excluded.cognitive_json,
       affective_json = excluded.affective_json,
       drive_json = excluded.drive_json,
       coupling_json = excluded.coupling_json,
       observation_count = excluded.observation_count,
       last_observed_at = excluded.last_observed_at,
       last_input_hash = excluded.last_input_hash,
       last_observation_json = excluded.last_observation_json,
       updated_at = excluded.updated_at`
  );
  stmt.run(
    state.agentKey,
    state.agentLabel || state.agentKey,
    clamp01(state.psyGender),
    JSON.stringify(state.cognitive || {}),
    JSON.stringify(state.affective || {}),
    JSON.stringify(state.drive || {}),
    JSON.stringify(state.coupling || {}),
    Number(state.observationCount) || 0,
    state.lastObservedAt || null,
    state.lastInputHash || null,
    state.lastObservation ? JSON.stringify(state.lastObservation) : null,
    state.updatedAt,
    state.createdAt || now
  );
  return true;
}

function saveAudit(agentKey, eventType, payload) {
  const db = openDb();
  if (!db || agentKey === DEFAULT_AGENT_KEY) return;
  db.prepare(
    `INSERT OR REPLACE INTO openher_axis_audit (agent_key, at, event_type, payload_json)
     VALUES (?, ?, ?, ?)`
  ).run(agentKey, `${nowIso()}-${hashText(JSON.stringify(payload)).slice(0, 6)}`, eventType, JSON.stringify(payload || {}));
}

function getAgentSummaries() {
  const db = openDb();
  if (!db) return [];
  return db
    .prepare(
      `SELECT agent_key, agent_label, observation_count, updated_at, last_observed_at
       FROM openher_axis_state
       ORDER BY updated_at DESC`
    )
    .all()
    .map((row) => ({
      agentKey: row.agent_key,
      agentLabel: row.agent_label,
      observationCount: row.observation_count,
      updatedAt: row.updated_at,
      lastObservedAt: row.last_observed_at,
    }));
}

function getModelSig() {
  return String(process.env.EmbeddingModelSig || process.env.WhitelistEmbeddingModel || "unknown");
}

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
    debugLog("contextBridge sanitize failed", error.message);
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

function rememberMessageVector(key, vector) {
  messageVectorCache.set(key, vector);
  if (messageVectorCache.size > MESSAGE_VECTOR_CACHE_LIMIT) {
    messageVectorCache.delete(messageVectorCache.keys().next().value);
  }
}

async function embedText(text, role = "user") {
  const normalized = sanitizeForEmbedding(text, role).slice(0, 4000);
  if (!normalized) return null;
  const key = hashText(`${role}:${normalized}`);
  if (messageVectorCache.has(key)) return messageVectorCache.get(key);

  if (contextBridge && typeof contextBridge.getEmbeddingFromCache === "function") {
    const exact = contextBridge.getEmbeddingFromCache(normalized);
    if (exact) {
      rememberMessageVector(key, exact);
      return exact;
    }
  }
  if (contextBridge && typeof contextBridge.getFuzzyEmbeddingFromCache === "function") {
    const fuzzy = contextBridge.getFuzzyEmbeddingFromCache(normalized);
    if (fuzzy && fuzzy.vector) {
      rememberMessageVector(key, fuzzy.vector);
      return fuzzy.vector;
    }
  }

  const embedded = await withTimeout(
    embeddingProvider([normalized]),
    activeConfig.OpenHerPersonaEmbeddingTimeoutMs
  );
  const vector = Array.isArray(embedded) && Array.isArray(embedded[0]) ? embedded[0] : null;
  if (vector) rememberMessageVector(key, vector);
  return vector;
}

function anchorText(agentLabel, template) {
  return String(template || "").replace(/\{name\}/g, normalizeAgentLabel(agentLabel));
}

function getStoredAnchorVectors(agentKey, agentLabel) {
  const db = openDb();
  if (!db) return null;
  const modelSig = getModelSig();
  const rows = db
    .prepare(
      `SELECT layer, axis, sub_axis, anchor_text, vector_json
       FROM openher_axis_anchors
       WHERE agent_key = ? AND model_sig = ?`
    )
    .all(agentKey, modelSig);
  const expectedCount = AXIS_DEFINITIONS.reduce((sum, item) => sum + item.anchors.length, 0);
  if (rows.length < expectedCount) return null;

  const vectors = {};
  for (const row of rows) {
    try {
      const key = `${row.layer}:${row.axis}:${row.sub_axis}:${row.anchor_text}`;
      vectors[key] = JSON.parse(row.vector_json);
    } catch (error) {
      return null;
    }
  }

  for (const definition of AXIS_DEFINITIONS) {
    for (const anchor of definition.anchors) {
      const text = anchorText(agentLabel, anchor.text);
      const key = `${definition.layer}:${definition.axis}:${anchor.subAxis}:${text}`;
      if (!Array.isArray(vectors[key])) return null;
    }
  }
  return vectors;
}

async function ensureAnchorVectors(agentKey, agentLabel) {
  const key = normalizeAgentKey(agentKey);
  const label = normalizeAgentLabel(agentLabel || key, key);
  const stored = getStoredAnchorVectors(key, label);
  if (stored) return stored;

  const db = openDb();
  if (!db) return null;
  const flat = [];
  const layout = [];
  for (const definition of AXIS_DEFINITIONS) {
    for (const anchor of definition.anchors) {
      const text = anchorText(label, anchor.text);
      flat.push(text);
      layout.push({ definition, anchor, text });
    }
  }

  const embedded = await withTimeout(
    embeddingProvider(flat),
    activeConfig.OpenHerPersonaEmbeddingTimeoutMs * 4
  );
  if (!Array.isArray(embedded) || embedded.length !== flat.length || embedded.some((vector) => !Array.isArray(vector))) {
    return null;
  }

  const modelSig = getModelSig();
  const now = nowIso();
  const vectors = {};
  const insert = db.prepare(
    `INSERT OR REPLACE INTO openher_axis_anchors
     (agent_key, layer, axis, sub_axis, anchor_text, vector_json, model_sig, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const transaction = db.transaction(() => {
    layout.forEach(({ definition, anchor, text }, index) => {
      const vector = embedded[index];
      const vectorKey = `${definition.layer}:${definition.axis}:${anchor.subAxis}:${text}`;
      vectors[vectorKey] = vector;
      insert.run(
        key,
        definition.layer,
        definition.axis,
        anchor.subAxis,
        text,
        JSON.stringify(vector),
        modelSig,
        now
      );
    });
  });
  transaction();
  return vectors;
}

function softmax(values, temperature) {
  if (!values.length) return [];
  const tau = Math.max(0.01, Number(temperature) || 0.12);
  const maxValue = Math.max(...values);
  const exps = values.map((value) => Math.exp((value - maxValue) / tau));
  const sum = exps.reduce((acc, value) => acc + value, 0) || 1;
  return exps.map((value) => value / sum);
}

function entropy(probs) {
  return probs.reduce((acc, probability) => {
    if (!(probability > 0)) return acc;
    return acc - probability * Math.log(probability);
  }, 0);
}

function scoreAxis(messageVector, anchorVectors, agentLabel, definition) {
  const similarities = [];
  const subAxes = {};
  for (const anchor of definition.anchors) {
    const text = anchorText(agentLabel, anchor.text);
    const vectorKey = `${definition.layer}:${definition.axis}:${anchor.subAxis}:${text}`;
    const anchorVector = anchorVectors[vectorKey];
    const sim = Array.isArray(anchorVector) ? cosineSimilarity(messageVector, anchorVector) : -1;
    similarities.push(sim);
  }

  const probs = softmax(similarities, activeConfig.OpenHerPersonaAnchorTemperature);
  let weighted = 0;
  for (let index = 0; index < similarities.length; index += 1) {
    weighted += similarities[index] * probs[index];
    subAxes[definition.anchors[index].subAxis] = {
      similarity: Number(similarities[index].toFixed(4)),
      weight: Number(probs[index].toFixed(4)),
    };
  }

  const simMean = similarities.reduce((acc, value) => acc + value, 0) / Math.max(1, similarities.length);
  const centered = weighted - simMean;
  const activation = clamp01(0.5 + centered * 6);
  const sharpness =
    probs.length > 1 ? clamp01(1 - entropy(probs) / Math.log(probs.length)) : 1;

  return {
    activation: Number(activation.toFixed(4)),
    sharpness: Number(sharpness.toFixed(4)),
    raw: Number(weighted.toFixed(4)),
    subAxes,
  };
}

function scoreAllAxes(messageVector, anchorVectors, agentLabel) {
  const rawScores = {};
  for (const definition of AXIS_DEFINITIONS) {
    rawScores[definition.axis] = scoreAxis(messageVector, anchorVectors, agentLabel, definition);
  }

  const mean =
    Object.values(rawScores).reduce((acc, item) => acc + item.activation, 0) / Math.max(1, AXIS_DEFINITIONS.length);
  const scores = {};
  for (const definition of AXIS_DEFINITIONS) {
    const score = rawScores[definition.axis];
    const relative = clamp01(0.5 + (score.activation - mean) * 1.4);
    scores[definition.axis] = {
      ...score,
      activation: Number(relative.toFixed(4)),
    };
  }
  return scores;
}

function flattenStateAxes(state) {
  return {
    psy_gender: {
      value: clamp01(state.psyGender),
      activation: clamp01(state.psyGender),
      sharpness: 0,
      subAxes: {},
    },
    ...state.cognitive,
    ...state.affective,
    ...state.drive,
  };
}

function applyCoupling(scores, previousAxes) {
  const coupled = {};
  for (const definition of AXIS_DEFINITIONS) {
    coupled[definition.axis] = scores[definition.axis]
      ? scores[definition.axis].activation
      : defaultAxisValue(DEFAULT_AGENT_KEY, definition.axis);
  }

  const strength = activeConfig.OpenHerPersonaCouplingStrength;
  for (const rule of COUPLING_RULES) {
    const fromValue = previousAxes[rule.from] ? previousAxes[rule.from].value : 0.5;
    const delta = (fromValue - 0.5) * rule.weight * strength;
    coupled[rule.to] = clamp01((coupled[rule.to] || 0.5) + delta);
  }

  const psy = previousAxes.psy_gender ? previousAxes.psy_gender.value : 0.5;
  const genderBias = (psy - 0.5) * strength;
  if (Object.prototype.hasOwnProperty.call(coupled, "libido")) {
    coupled.libido = clamp01(coupled.libido + genderBias * 0.18);
  }

  return coupled;
}

function applyObservationToState(state, scores, inputHash) {
  const previousAxes = flattenStateAxes(state);
  const coupled = applyCoupling(scores, previousAxes);
  const ema = activeConfig.OpenHerPersonaStateEma;
  const nextAxes = {};

  for (const definition of AXIS_DEFINITIONS) {
    const prev = previousAxes[definition.axis] || {
      value: defaultAxisValue(state.agentKey, definition.axis),
      activation: 0,
      sharpness: 0,
      subAxes: {},
    };
    const score = scores[definition.axis] || { activation: prev.value, sharpness: 0, subAxes: {} };
    const target = coupled[definition.axis];
    const value = clamp01(prev.value + (target - prev.value) * ema);
    nextAxes[definition.axis] = {
      value: Number(value.toFixed(4)),
      activation: Number(score.activation.toFixed(4)),
      sharpness: Number(score.sharpness.toFixed(4)),
      subAxes: score.subAxes || {},
    };
  }

  state.psyGender = nextAxes.psy_gender.value;
  const { cognitive, affective, drive } = splitLayerState(nextAxes);
  state.cognitive = cognitive;
  state.affective = affective;
  state.drive = drive;
  state.observationCount = (Number(state.observationCount) || 0) + 1;
  state.lastObservedAt = nowIso();
  state.lastInputHash = inputHash;
  state.lastObservation = {
    at: state.lastObservedAt,
    inputHash,
    scores,
    coupled,
    mood: computeMoodFromState(state),
  };
  return state;
}

function computeMoodFromState(state) {
  const positive = clamp01(state.affective && state.affective.positive && state.affective.positive.value);
  const negative = clamp01(state.affective && state.affective.negative && state.affective.negative.value);
  const arousal = clamp01(state.affective && state.affective.arousal && state.affective.arousal.value);
  const tension = Math.min(positive, negative);
  const dominance = positive - negative;
  return {
    positive: Number(positive.toFixed(4)),
    negative: Number(negative.toFixed(4)),
    arousal: Number(arousal.toFixed(4)),
    tension: Number(tension.toFixed(4)),
    dominance: Number(dominance.toFixed(4)),
    label: moodLabel(positive, negative, arousal),
  };
}

function bucketLowMidHigh(value) {
  if (value >= 0.66) return "high";
  if (value >= 0.34) return "mid";
  return "low";
}

function moodLabel(positive, negative, arousal) {
  const p = bucketLowMidHigh(positive);
  const n = bucketLowMidHigh(negative);
  const a = bucketLowMidHigh(arousal);
  if (p === "high" && n === "high" && a === "high") return "强烈矛盾";
  if (p === "high" && n !== "high" && a === "high") return "雀跃明亮";
  if (p === "high" && n !== "high" && a !== "high") return "温和满足";
  if (n === "high" && a === "high") return "焦灼受压";
  if (n === "high" && a !== "high") return "低落受伤";
  if (p === "mid" && n === "mid") return "复杂波动";
  if (a === "high") return "警觉浮动";
  return "平静观测";
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
    return { agentKey: normalizeAgentKey(agent), agentLabel: normalizeAgentLabel(agent), source: "onering_trigger" };
  }

  const noticeMatches = Array.from(content.matchAll(ONE_RING_NOTICE_PATTERN));
  const noticeMatch = noticeMatches.length ? noticeMatches[noticeMatches.length - 1] : null;
  if (noticeMatch && noticeMatch[1]) {
    const agent = noticeMatch[1].trim();
    return { agentKey: normalizeAgentKey(agent), agentLabel: normalizeAgentLabel(agent), source: "onering_notice" };
  }
  return null;
}

function resolveAgentIdentity(messages, requestConfig) {
  const fromConfig = resolveAgentIdentityFromObject(requestConfig);
  let fromLatestSystem = null;
  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || message.role !== "system") continue;
      const resolved = resolveAgentIdentityFromText(messageContentToText(message.content));
      if (resolved) {
        fromLatestSystem = resolved;
        break;
      }
    }
  }
  if (fromConfig && (fromConfig.source === "object" || !fromLatestSystem)) return fromConfig;
  return fromLatestSystem;
}

function findLatestRealMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || !["user", "assistant"].includes(message.role)) continue;
    const text = messageContentToText(message.content);
    if (!text.trim()) continue;
    if (message.role === "user" && isVcpVirtualUserText(text)) continue;
    return { index, role: message.role, text };
  }
  return null;
}

function buildObservationFingerprint(agentKey, latestMessage) {
  return hashText(`${agentKey}:${latestMessage.role}:${latestMessage.index}:${latestMessage.text}`);
}

function enqueueObservation(agentKey, job) {
  const key = normalizeAgentKey(agentKey);
  const existing = agentQueues.get(key) || { running: false, jobs: [] };
  if (existing.jobs.length >= activeConfig.OpenHerPersonaQueueMaxSize) {
    existing.jobs.shift();
  }
  existing.jobs.push(job);
  agentQueues.set(key, existing);
  if (!existing.running) {
    drainAgentQueue(key).catch((error) => {
      console.warn(`[${PLUGIN_NAME}] queue drain failed for ${key}: ${error.message}`);
    });
  }
}

async function drainAgentQueue(agentKey) {
  const queue = agentQueues.get(agentKey);
  if (!queue || queue.running) return;
  queue.running = true;
  try {
    while (queue.jobs.length > 0) {
      const job = queue.jobs.shift();
      try {
        await observeJob(job);
      } catch (error) {
        console.warn(`[${PLUGIN_NAME}] observation failed for ${agentKey}: ${error.message}`);
        saveAudit(agentKey, "observe_error", { error: error.message, job: summarizeJob(job) });
      }
    }
  } finally {
    queue.running = false;
  }
}

function summarizeJob(job) {
  return {
    agentKey: job.agentKey,
    agentLabel: job.agentLabel,
    role: job.role,
    textHash: hashText(job.text || ""),
    textLength: String(job.text || "").length,
  };
}

async function observeJob(job) {
  if (!activeConfig.OpenHerPersonaEnabled) return;
  const state = loadAgentState(job.agentKey, job.agentLabel);
  if (state.lastInputHash === job.inputHash) {
    debugLog("skip duplicate observation", job.inputHash);
    return;
  }

  const anchorVectors = await ensureAnchorVectors(state.agentKey, state.agentLabel);
  if (!anchorVectors) {
    saveAudit(state.agentKey, "observe_skipped", { reason: "anchors_unavailable", job: summarizeJob(job) });
    return;
  }

  const messageVector = await embedText(job.text, job.role);
  if (!messageVector) {
    saveAudit(state.agentKey, "observe_skipped", { reason: "message_vector_unavailable", job: summarizeJob(job) });
    return;
  }

  const scores = scoreAllAxes(messageVector, anchorVectors, state.agentLabel);
  applyObservationToState(state, scores, job.inputHash);
  saveAgentState(state);
  saveAudit(state.agentKey, "observe", {
    role: job.role,
    textHash: hashText(job.text),
    textLength: job.text.length,
    mood: computeMoodFromState(state),
    topAxes: getTopAxesFromScores(scores, 6),
  });
  debugLog("observation applied", state.agentKey, computeMoodFromState(state));
}

function getTopAxesFromScores(scores, limit = 6) {
  return Object.entries(scores || {})
    .sort((a, b) => (b[1].activation || 0) - (a[1].activation || 0))
    .slice(0, limit)
    .map(([axis, score]) => ({
      axis,
      label: AXIS_BY_KEY[axis] ? AXIS_BY_KEY[axis].label : axis,
      activation: score.activation,
      sharpness: score.sharpness,
    }));
}

async function processMessages(messages, requestConfig = {}) {
  if (!activeConfig.OpenHerPersonaEnabled || !Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const effectiveConfig = resolveConfig({ ...activeConfig, ...(requestConfig || {}) });
  if (!effectiveConfig.OpenHerPersonaEnabled) return messages;

  const identity = resolveAgentIdentity(messages, requestConfig);
  if (!identity) return messages;

  const latestMessage = findLatestRealMessage(messages);
  if (!latestMessage) return messages;

  const inputHash = buildObservationFingerprint(identity.agentKey, latestMessage);
  const job = {
    agentKey: identity.agentKey,
    agentLabel: identity.agentLabel,
    source: identity.source,
    role: latestMessage.role,
    text: latestMessage.text,
    inputHash,
    queuedAt: nowIso(),
  };

  if (effectiveConfig.OpenHerPersonaAsyncObservation) {
    enqueueObservation(identity.agentKey, job);
    return messages;
  }

  // Synchronous observation is kept only for diagnostics/config experiments; it still never mutates prompts.
  await observeJob(job);
  return messages;
}

function resetAgentState(agentKey, agentLabel) {
  const key = normalizeAgentKey(agentKey || DEFAULT_AGENT_KEY);
  const label = normalizeAgentLabel(agentLabel || key, key);
  const db = openDb();
  if (db && key !== DEFAULT_AGENT_KEY) {
    db.prepare("DELETE FROM openher_axis_state WHERE agent_key = ?").run(key);
    db.prepare("DELETE FROM openher_axis_anchors WHERE agent_key = ?").run(key);
    db.prepare("DELETE FROM openher_axis_audit WHERE agent_key = ?").run(key);
  }
  const state = createDefaultState(key, label);
  saveAgentState(state);
  return state;
}

function getAxisStatusForAgent(agentKey, agentLabel) {
  const state = loadAgentState(agentKey, agentLabel);
  return {
    agentKey: state.agentKey,
    agentLabel: state.agentLabel,
    psyGender: state.psyGender,
    cognitive: state.cognitive,
    affective: state.affective,
    drive: state.drive,
    mood: computeMoodFromState(state),
    observationCount: state.observationCount,
    lastObservedAt: state.lastObservedAt,
    lastInputHash: state.lastInputHash,
    lastObservation: state.lastObservation,
    updatedAt: state.updatedAt,
    createdAt: state.createdAt,
  };
}

function getStatus(params = {}) {
  const identity = resolveAgentIdentity([], params) || {
    agentKey: normalizeAgentKey(params.agentKey || params.agent || DEFAULT_AGENT_KEY),
    agentLabel: normalizeAgentLabel(params.agentLabel || params.agentName || params.agent || DEFAULT_AGENT_LABEL),
  };
  const queue = agentQueues.get(identity.agentKey);
  return {
    status: "success",
    plugin: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    mode: "async_observer",
    enabled: activeConfig.OpenHerPersonaEnabled,
    promptInjection: false,
    timeMetabolism: false,
    keywordHeuristic: false,
    provider: embeddingProviderTag,
    config: { ...activeConfig },
    configPath: CONFIG_PATH,
    database: {
      available: Boolean(Database),
      path: STATE_DB_PATH,
      schema: "openher_axis_*",
    },
    queue: {
      agentKey: identity.agentKey,
      running: Boolean(queue && queue.running),
      pending: queue ? queue.jobs.length : 0,
      maxSize: activeConfig.OpenHerPersonaQueueMaxSize,
    },
    agents: getAgentSummaries(),
    state: identity.agentKey !== DEFAULT_AGENT_KEY ? getAxisStatusForAgent(identity.agentKey, identity.agentLabel) : null,
    boundaries: {
      noPromptInjection: true,
      noPersonaDeltaProtocol: true,
      noBrkHint: true,
      noHtmlHint: true,
      noTimeDecay: true,
      noKeywordHeuristic: true,
      noProactiveSending: true,
      noLongTermMemoryWrites: true,
      observationOnly: true,
    },
  };
}

async function runTick(params = {}) {
  return {
    status: "success",
    plugin: PLUGIN_NAME,
    skipped: true,
    reason: "tick removed in pure async observer mode; use status/snapshot to inspect measured axes",
    state: getStatus(params).state,
  };
}

function explain() {
  return {
    status: "success",
    plugin: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    summary:
      "OpenHerPersona is now a pure async observation and measurement plugin. It never injects prompt text and only updates per-agent axis states in the background.",
    architecture: [
      "per-agent SQLite state in openher_axis_* tables",
      "subject-anchored secondary vector anchors for cognitive, affective, drive, and psychological gender axes",
      "softmax residual scoring with sharpness",
      "three-way soft coupling among cognitive/affective/drive systems",
      "positive/negative/arousal mood readout without valence cancellation",
      "per-agent async queue to avoid concurrent state races",
    ],
    removed: [
      "persona_state_hint injection",
      "brk / HTML expression hints",
      "persona_delta JSON protocol",
      "wall-clock time metabolism",
      "keyword heuristic scoring",
      "proactive sending",
    ],
  };
}

async function processToolCall(params) {
  const command = String((params && params.command) || "status").trim().toLowerCase();

  if (command === "status" || command === "snapshot") {
    return getStatus(params || {});
  }

  if (command === "tick") {
    return runTick(params || {});
  }

  if (command === "reset") {
    const identity = resolveAgentIdentity([], params || {}) || {
      agentKey: normalizeAgentKey(params && (params.agentKey || params.agent)),
      agentLabel: normalizeAgentLabel(params && (params.agentLabel || params.agentName || params.agent)),
    };
    const state = resetAgentState(identity.agentKey, identity.agentLabel);
    return { status: "success", reset: true, state: getAxisStatusForAgent(state.agentKey, state.agentLabel) };
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
    supportedCommands: ["status", "snapshot", "reset", "config", "save_config", "explain"],
  };
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

  if (Database) {
    openDb();
    writeMeta("schemaVersion", "1");
    writeMeta("plugin", PLUGIN_NAME);
    writeMeta("pluginVersion", PLUGIN_VERSION);
    writeMeta("mode", "async_observer");
    writeMeta("updatedAt", nowIso());
    dropLegacyStateIfNeeded();
  } else {
    console.warn(`[${PLUGIN_NAME}] better-sqlite3 unavailable; observer state persistence is disabled.`);
  }

  debugLog(`initialized. contextBridge=${Boolean(contextBridge)} provider=${embeddingProviderTag}`);
}

function shutdown() {
  try {
    if (configWatcher) {
      configWatcher.close();
      configWatcher = null;
    }
    if (dbHandle) {
      dbHandle.close();
      dbHandle = null;
    }
  } catch (error) {
    console.warn(`[${PLUGIN_NAME}] shutdown failed: ${error.message}`);
  }
}

module.exports = {
  initialize,
  processMessages,
  processToolCall,
  shutdown,
};
