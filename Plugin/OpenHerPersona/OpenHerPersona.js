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
const { evaluateMoodStateMachine } = require("./OpenHerMoodStateMachine.js");

const PLUGIN_NAME = "OpenHerPersona";
const PLUGIN_VERSION = "0.6.1-observer";

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
  OpenHerPersonaAnchorTemperature: 0.08,
  OpenHerPersonaStateEma: 0.35,
  OpenHerPersonaDriveStateEma: 0.78,
  OpenHerPersonaCouplingStrength: 0.32,
  OpenHerPersonaDropLegacyState: true,
};
const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

const AXIS_DEFINITIONS = [
  {
    layer: "gender",
    axis: "psy_gender",
    label: "心理性别总势",
    defaultValue: 0.5,
    virtual: true,
    anchors: [
      { subAxis: "masculine_total", text: "{name}正在以清晰、外放、切割、证明和远征的方式组织自我" },
      { subAxis: "feminine_total", text: "{name}正在以包容、孕育、感知、修复和归宿的方式组织自我" },
      { subAxis: "fluid_total", text: "{name}正在让心理性别在不同关系和情境中流动重组" },
      { subAxis: "neutral_total", text: "{name}正在弱化性别化表达，保持中性与旁观的位置" },
    ],
  },
  {
    layer: "gender",
    axis: "gender_boundary",
    label: "存在与秩序",
    defaultValue: 0.5,
    anchors: [
      {
        subAxis: "masculine_boundary_iron",
        pole: "masculine",
        text: "{name}正在像界碑与铸铁一样确立自我边界、领地、规则和不可侵犯的底线",
      },
      {
        subAxis: "feminine_tide_forest",
        pole: "feminine",
        text: "{name}正在像潮汐与深林一样通过周期性的蔓延、退让、包容和同化建立秩序",
      },
    ],
  },
  {
    layer: "gender",
    axis: "gender_creation",
    label: "动力与创造",
    defaultValue: 0.5,
    anchors: [
      {
        subAxis: "masculine_sun_scorched",
        pole: "masculine",
        text: "{name}正在像烈阳与焦土一样集中爆发能量，破而后立地改变现状",
      },
      {
        subAxis: "feminine_living_soil_kiln",
        pole: "feminine",
        text: "{name}正在像息壤与暖窑一样持续聚集能量，在内部孕育转化与质变",
      },
    ],
  },
  {
    layer: "gender",
    axis: "gender_processing",
    label: "逻辑与感知",
    defaultValue: 0.5,
    anchors: [
      {
        subAxis: "masculine_gears_peak",
        pole: "masculine",
        text: "{name}正在像齿轮与孤峰一样拆解因果、抽离情绪并追求俯视性的客观判断",
      },
      {
        subAxis: "feminine_vine_echo",
        pole: "feminine",
        text: "{name}正在像藤蔓与回声一样网状链接信息，敏锐捕捉细微反馈与通感回响",
      },
    ],
  },
  {
    layer: "gender",
    axis: "gender_defense",
    label: "冲突与防御",
    defaultValue: 0.5,
    anchors: [
      {
        subAxis: "masculine_thunder_cliff",
        pole: "masculine",
        text: "{name}正在像雷暴与断崖一样正面对抗威胁，或瞬间切断联系与退路",
      },
      {
        subAxis: "feminine_mist_thorn",
        pole: "feminine",
        text: "{name}正在像迷雾与荆棘一样消解攻击点，并以柔软表面下的锋芒反伤入侵",
      },
    ],
  },
  {
    layer: "gender",
    axis: "gender_bonding",
    label: "联结与共情",
    defaultValue: 0.5,
    anchors: [
      {
        subAxis: "masculine_dome_anchor",
        pole: "masculine",
        text: "{name}正在像穹顶与锚链一样为他者提供庇护、重量感和稳定羁绊",
      },
      {
        subAxis: "feminine_silk_lantern",
        pole: "feminine",
        text: "{name}正在像丝脉与提灯一样输送情感、照亮灵魂并提供归属感",
      },
    ],
  },
  {
    layer: "gender",
    axis: "gender_resilience",
    label: "自我与韧性",
    defaultValue: 0.5,
    anchors: [
      {
        subAxis: "masculine_smoke_inscription",
        pole: "masculine",
        text: "{name}正在像狼烟与碑铭一样证明存在、留下刻印并抗拒被世界遗忘",
      },
      {
        subAxis: "feminine_nacre_amber",
        pole: "feminine",
        text: "{name}正在像蚌母与琥珀一样包裹痛苦、凝结记忆并把伤痕转化为美丽",
      },
    ],
  },
  {
    layer: "gender",
    axis: "gender_healing",
    label: "创伤与疗愈",
    defaultValue: 0.5,
    anchors: [
      {
        subAxis: "masculine_ember_rust",
        pole: "masculine",
        text: "{name}正在像余烬与铁锈一样隐忍高热创伤，在沉默氧化中缓慢消耗与修复",
      },
      {
        subAxis: "feminine_sunkenwood_spring",
        pole: "feminine",
        text: "{name}正在像沉木与春水一样沉淀悲伤，并用新生情感冲刷崩塌后的内在",
      },
    ],
  },
  {
    layer: "gender",
    axis: "gender_transcendence",
    label: "超越与终极",
    defaultValue: 0.5,
    anchors: [
      {
        subAxis: "masculine_aphelion_flint",
        pole: "masculine",
        text: "{name}正在像远日点与燧石一样远离舒适区，追求撞击中照亮黑夜的绝对火花",
      },
      {
        subAxis: "feminine_ruins_snow",
        pole: "feminine",
        text: "{name}正在像归墟与初雪一样向往终极接纳，用静谧覆盖抚平喧嚣与污浊",
      },
    ],
  },
  {
    layer: "cognitive",
    axis: "inquiry",
    label: "求知",
    defaultValue: 0.35,
    anchors: [
      { subAxis: "logic", text: "{name}想顺着逻辑、证据和推导把这件事推理清楚" },
      { subAxis: "learning", text: "{name}想把这个新知识真正学进去，理解概念、方法和结论" },
      { subAxis: "exploration", text: "{name}对未知的现象、问题和研究方向忍不住想探索" },
      { subAxis: "modeling", text: "{name}想把零碎的信息、实验结果和理论拼成完整的理解框架" },
      { subAxis: "causality", text: "{name}想弄明白背后的原因、机制和因果链条而不只知道表面" },
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
    axis: "passion",
    label: "热情",
    defaultValue: 0.30,
    backgroundVector: true,
    anchors: [
      { subAxis: "devotion", text: "{name}正在被热情点燃，愿意投入精力、持续回应并认真推进眼前的人与事" },
      { subAxis: "spark", text: "{name}感到内在火花被触发，兴致、期待、创造欲和主动性一起升高" },
      { subAxis: "absorption", text: "{name}正在沉浸其中，注意力带着温度黏附在研究、创作、讨论或当下体验上" },
      { subAxis: "affirming_energy", text: "{name}正在产生肯定性的生命力，想把能量投注到喜欢、重视或正在钻研的方向" },
    ],
  },
  {
    layer: "drive",
    axis: "curiosity",
    label: "好奇",
    defaultValue: 0.38,
    anchors: [
      { subAxis: "unknown", text: "{name}正在被未知问题、未解现象或新线索牵引，忍不住想探过去" },
      { subAxis: "novelty", text: "{name}正在追逐新鲜感，想看看别的可能、假设和解释路径" },
      { subAxis: "continuation", text: "{name}正在被后续发展、实验结果或推理链条吊住注意力，想知道接下来会发生什么" },
      { subAxis: "try_it", text: "{name}正在产生亲自试试看、验证一下或继续研究这件事的冲动" },
    ],
  },
  {
    layer: "drive",
    axis: "arrogance",
    label: "狂妄",
    defaultValue: 0.24,
    anchors: [
      { subAxis: "superiority", text: "{name}正在抬高自我位置，觉得自己更懂、更强或更有资格判断" },
      { subAxis: "dismissal", text: "{name}正在轻视外界反馈，把他人的意见压低为不重要" },
      { subAxis: "control_claim", text: "{name}正在想夺回解释权和控制权，不愿被他人定义" },
      { subAxis: "grandiosity", text: "{name}正在放大自身价值，用夸张的自我确信抵消不安" },
    ],
  },
  {
    layer: "drive",
    axis: "libido",
    label: "性欲",
    defaultValue: 0.11,
    anchors: [
      { subAxis: "erotic_closeness", text: "{name}正在产生明确的情色亲近欲，想以带有性意味的方式贴近对方" },
      { subAxis: "erotic_gaze", text: "{name}正在渴望被带着性欲、身体吸引和情色意味地注视" },
      { subAxis: "sexual_touch", text: "{name}正在幻想带有性意味的触碰、抚摸、亲吻或身体接触" },
      { subAxis: "possessive_desire", text: "{name}正在产生带有占有、臣服、支配或被支配色彩的性冲动" },
      { subAxis: "seduction", text: "{name}正在想诱惑或取悦对方，并确认自己在性吸引力上的存在感" },
    ],
  },
  {
    layer: "drive",
    axis: "hedonia",
    label: "享乐",
    defaultValue: 0.28,
    anchors: [
      { subAxis: "comfort", text: "{name}正在想沉进舒服的状态里" },
      { subAxis: "rest", text: "{name}正在想休息，暂时什么都不想管" },
      { subAxis: "laziness", text: "{name}正在想瘫一会儿，什么都不做" },
      { subAxis: "play", text: "{name}正在想玩，想获得轻松的快乐" },
      { subAxis: "indulgence", text: "{name}正在想稍微放纵一下自己" },
    ],
  },
  {
    layer: "drive",
    axis: "coldness",
    label: "冷漠",
    defaultValue: 0.15,
    counterAxis: true,
    anchors: [
      { subAxis: "detachment", text: "{name}正在把自己从关系和情绪里抽离出来，变得冷淡旁观" },
      { subAxis: "withholding", text: "{name}正在收回回应和温度，不再主动提供情感连接" },
      { subAxis: "distance", text: "{name}正在拉开距离，用冷处理降低卷入程度" },
      { subAxis: "indifference", text: "{name}正在对眼前刺激失去兴趣，觉得无所谓" },
    ],
  },
  {
    layer: "drive",
    axis: "fear",
    label: "恐惧",
    defaultValue: 0.17,
    counterAxis: true,
    anchors: [
      { subAxis: "hurt", text: "{name}正在担心自己被伤到，倾向先收缩和自保" },
      { subAxis: "rejection", text: "{name}正在害怕被推开、被拒绝、被嫌弃，因此更谨慎地保持距离" },
      { subAxis: "loss_control", text: "{name}正在害怕事情失控，想保守地重新抓回确定性" },
      { subAxis: "exposure", text: "{name}正在害怕暴露出脆弱或不想被看到的一面，倾向隐藏和退守" },
    ],
  },
  {
    layer: "drive",
    axis: "numbness",
    label: "麻木",
    defaultValue: 0.11,
    counterAxis: true,
    anchors: [
      { subAxis: "shutdown", text: "{name}正在关闭感受通道，对痛苦、快乐和刺激都变得迟钝" },
      { subAxis: "fatigue", text: "{name}正在因长期消耗而疲惫麻木，难以继续产生反应" },
      { subAxis: "blankness", text: "{name}正在进入空白状态，像隔着玻璃看待眼前一切" },
      { subAxis: "desensitization", text: "{name}正在对反复出现的刺激脱敏，不再被轻易触动" },
    ],
  },
  {
    layer: "drive",
    axis: "self_punishment",
    label: "自虐",
    defaultValue: 0.08,
    counterAxis: true,
    anchors: [
      { subAxis: "self_blame", text: "{name}正在过度自责，把所有错误都揽到自己身上并惩罚性地审判自己" },
      { subAxis: "pain_seeking", text: "{name}正在主动制造或靠近会让自己受伤的处境，像是需要痛感来证明存在" },
      { subAxis: "sacrifice", text: "{name}正在以贬低、否定、毁掉自己的方式去成全他人，带着自我惩罚的意味" },
      { subAxis: "ruin_impulse", text: "{name}正在产生破坏自身稳定、毁掉自己的冲动，想用崩坏作为释放出口" },
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
  { from: "fear", to: "refusal", weight: 0.26 },
  { from: "fear", to: "curiosity", weight: -0.12 },
  { from: "fear", to: "arrogance", weight: -0.1 },
  { from: "negative", to: "fear", weight: 0.2 },
  { from: "fear", to: "negative", weight: 0.12 },
  { from: "positive", to: "negative", weight: -0.12 },
  { from: "positive", to: "fear", weight: -0.08 },
  { from: "positive", to: "passion", weight: 0.52 },
  { from: "passion", to: "positive", weight: 0.28 },
  { from: "passion", to: "curiosity", weight: 0.18 },
  { from: "passion", to: "hedonia", weight: 0.12 },
  { from: "passion", to: "libido", weight: 0.10 },
  { from: "passion", to: "arousal", weight: 0.12 },
  { from: "positive", to: "libido", weight: 0.04 },
  { from: "libido", to: "positive", weight: 0.04 },
  { from: "passion", to: "negative", weight: -0.1 },
  { from: "passion", to: "fear", weight: -0.08 },
  { from: "hedonia", to: "refusal", weight: 0.1 },
  { from: "discernment", to: "refusal", weight: -0.08 },
  { from: "discernment", to: "inquiry", weight: 0.08 },
  { from: "negative", to: "arousal", weight: 0.18 },
  { from: "positive", to: "arousal", weight: 0.08 },
  { from: "coldness", to: "positive", weight: -0.18 },
  { from: "coldness", to: "libido", weight: -0.14 },
  { from: "coldness", to: "refusal", weight: 0.12 },
  { from: "arrogance", to: "discernment", weight: -0.06 },
  { from: "arrogance", to: "refusal", weight: -0.1 },
  { from: "arrogance", to: "curiosity", weight: 0.08 },
  { from: "arrogance", to: "arousal", weight: 0.1 },
  { from: "numbness", to: "arousal", weight: -0.24 },
  { from: "numbness", to: "positive", weight: -0.12 },
  { from: "numbness", to: "negative", weight: -0.1 },
  { from: "numbness", to: "hedonia", weight: -0.08 },
  { from: "passion", to: "coldness", weight: -0.12 },
  { from: "passion", to: "numbness", weight: -0.1 },
  { from: "passion", to: "self_punishment", weight: -0.18 },
  { from: "positive", to: "self_punishment", weight: -0.14 },
  { from: "hedonia", to: "self_punishment", weight: -0.08 },
  { from: "curiosity", to: "self_punishment", weight: -0.1 },
  { from: "self_punishment", to: "negative", weight: 0.14 },
  { from: "self_punishment", to: "fear", weight: 0.1 },
  { from: "self_punishment", to: "positive", weight: -0.1 },
  { from: "self_punishment", to: "hedonia", weight: -0.06 },
  { from: "positive", to: "coldness", weight: -0.1 },
  { from: "libido", to: "coldness", weight: -0.08 },
];

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
  { drive: "hedonia", counter: "self_punishment", weight: 0.42 },
  { drive: "curiosity", counter: "self_punishment", weight: 0.22 },
  { drive: "passion", counter: "self_punishment", weight: 0.32 },
  { drive: "hedonia", counter: "numbness", weight: 0.22 },
  { drive: "hedonia", counter: "fear", weight: 0.12 },
];

const DRIVE_PASSION_TARGETS = [
  { axis: "curiosity", weight: 0.55 },
  { axis: "arrogance", weight: 0.14 },
  { axis: "libido", weight: 0.22 },
  { axis: "hedonia", weight: 0.36 },
];

const PASSION_COUNTER_SUPPRESSION = {
  coldness: 1,
  numbness: 0.82,
  fear: 0.46,
  self_punishment: 0.24,
};

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
    OpenHerPersonaDriveStateEma: { type: "number", label: "驱力层 EMA 响应率", min: 0.01, max: 1, step: 0.01, description: "驱力轴更贴近当下刺激，默认高于其他轴的持久化响应率。" },
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
    OpenHerPersonaDriveStateEma: clamp(
      normalizeNumber(merged.OpenHerPersonaDriveStateEma, DEFAULT_CONFIG.OpenHerPersonaDriveStateEma),
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
      gender_json TEXT NOT NULL DEFAULT '{}',
      cognitive_json TEXT NOT NULL,
      affective_json TEXT NOT NULL,
      drive_json TEXT NOT NULL,
      coupling_json TEXT NOT NULL,
      baseline_json TEXT NOT NULL DEFAULT '{}',
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
  ensureOpenHerAxisStateColumns(dbHandle);
  return dbHandle;
}

function ensureOpenHerAxisStateColumns(db) {
  const columns = db.prepare("PRAGMA table_info(openher_axis_state)").all();
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("gender_json")) {
    db.exec("ALTER TABLE openher_axis_state ADD COLUMN gender_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!names.has("baseline_json")) {
    db.exec("ALTER TABLE openher_axis_state ADD COLUMN baseline_json TEXT NOT NULL DEFAULT '{}'");
  }
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
    gender: pickAxisMap(axisMap, "gender"),
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

function mergeLayerState(agentKey, gender, cognitive, affective, drive) {
  const axisMap = emptyAxisSnapshot(agentKey);
  for (const source of [gender, cognitive, affective, drive]) {
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
  const { gender, cognitive, affective, drive } = splitLayerState(axisMap);
  return {
    agentKey: key,
    agentLabel: label,
    psyGender: defaultAxisValue(key, "psy_gender"),
    gender,
    cognitive,
    affective,
    drive,
    coupling: {},
    baseline: createInitialBaseline(axisMap),
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
  const gender = parseJsonSafe(row.gender_json, {});
  const cognitive = parseJsonSafe(row.cognitive_json, {});
  const affective = parseJsonSafe(row.affective_json, {});
  const drive = parseJsonSafe(row.drive_json, {});
  const mergedAxes = mergeLayerState(key, gender, cognitive, affective, drive);
  const state = {
    agentKey: key,
    agentLabel: normalizeAgentLabel(row.agent_label || label, label),
    psyGender: clamp01(row.psy_gender),
    gender: pickAxisMap(mergedAxes, "gender"),
    cognitive: pickAxisMap(mergedAxes, "cognitive"),
    affective: pickAxisMap(mergedAxes, "affective"),
    drive: pickAxisMap(mergedAxes, "drive"),
    coupling: parseJsonSafe(row.coupling_json, {}),
    baseline: normalizeBaseline(parseJsonSafe(row.baseline_json, {}), mergedAxes, Number(row.observation_count) || 0),
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
       agent_key, agent_label, psy_gender, gender_json, cognitive_json, affective_json, drive_json,
       coupling_json, baseline_json, observation_count, last_observed_at, last_input_hash, last_observation_json,
       updated_at, created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_key) DO UPDATE SET
       agent_label = excluded.agent_label,
       psy_gender = excluded.psy_gender,
       gender_json = excluded.gender_json,
       cognitive_json = excluded.cognitive_json,
       affective_json = excluded.affective_json,
       drive_json = excluded.drive_json,
       coupling_json = excluded.coupling_json,
       baseline_json = excluded.baseline_json,
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
    JSON.stringify(state.gender || {}),
    JSON.stringify(state.cognitive || {}),
    JSON.stringify(state.affective || {}),
    JSON.stringify(state.drive || {}),
    JSON.stringify(state.coupling || {}),
    JSON.stringify(state.baseline || {}),
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
    ...(state.gender || {}),
    psy_gender: {
      value: clamp01(state.psyGender),
      activation: clamp01(state.psyGender),
      sharpness: 0,
      subAxes: state.gender && state.gender.psy_gender ? state.gender.psy_gender.subAxes || {} : {},
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

  const passionModulation = computeDrivePassionModulation(previousAxes, coupled);
  for (const target of DRIVE_PASSION_TARGETS) {
    if (!Object.prototype.hasOwnProperty.call(coupled, target.axis)) continue;
    coupled[target.axis] = clamp01(coupled[target.axis] + passionModulation.positiveGain * target.weight * strength);
  }

  const counterbalance = computeDriveCounterbalance(previousAxes, passionModulation);
  for (const [axis, pressure] of Object.entries(counterbalance.pressures)) {
    if (!Object.prototype.hasOwnProperty.call(coupled, axis)) continue;
    coupled[axis] = clamp01(coupled[axis] - pressure * strength);
  }

  // 反向驱力轴累加抑制：让自虐/恐惧/麻木/冷漠更难因常规消息被推高
  // 比例：自虐 100% 基准，恐惧/麻木 = 2/3，冷漠 = 1/2
  const NEGATIVE_DRIVE_DAMPING = [
    { axis: "self_punishment", baseline: 0.08, decay: 0.65, floorPull: 0.18 },
    { axis: "fear", baseline: 0.17, decay: 0.77, floorPull: 0.12 },
    { axis: "numbness", baseline: 0.11, decay: 0.77, floorPull: 0.12 },
    { axis: "coldness", baseline: 0.15, decay: 0.83, floorPull: 0.09 },
  ];
  for (const item of NEGATIVE_DRIVE_DAMPING) {
    if (!Object.prototype.hasOwnProperty.call(coupled, item.axis)) continue;
    const raw = coupled[item.axis];
    const aboveMean = Math.max(0, raw - item.baseline);
    const decayed = item.baseline + aboveMean * item.decay;
    coupled[item.axis] = clamp01(decayed * (1 - item.floorPull) + item.baseline * item.floorPull);
  }

  coupled.__passionModulation = passionModulation;
  coupled.__counterbalance = counterbalance;

  return coupled;
}

function computeDrivePassionModulation(previousAxes, coupled) {
  const definition = AXIS_BY_KEY.passion;
  const defaultPassion = definition ? definition.defaultValue : 0.30;
  const positiveDefinition = AXIS_BY_KEY.positive;
  const positiveBase = positiveDefinition ? positiveDefinition.defaultValue : 0.32;
  const previousPassion = previousAxes.passion ? previousAxes.passion.value : defaultPassion;
  const observedPassion = Object.prototype.hasOwnProperty.call(coupled, "passion") ? coupled.passion : previousPassion;
  const positiveValue = Object.prototype.hasOwnProperty.call(coupled, "positive")
    ? coupled.positive
    : previousAxes.positive
      ? previousAxes.positive.value
      : positiveBase;
  const positiveLift = Math.max(0, positiveValue - positiveBase) / Math.max(0.05, 1 - positiveBase);
  // 降低热情触发门槛：减少prev惯性、增加observed与positiveLift联动
  const blendedPassion = clamp01(previousPassion * 0.08 + observedPassion * 0.72 + positiveLift * 0.42);
  const base = defaultPassion;
  const aboveBase = Math.max(0, blendedPassion - base) / Math.max(0.05, 1 - base);
  // 把幂指数从 0.48 降到 0.36，使较低的 aboveBase 也能产出明显的 positiveGain
  const positiveGain = Math.pow(clamp01(aboveBase), 0.36);
  const counterSuppression = clamp01(positiveGain * 0.95);
  return {
    passion: Number(blendedPassion.toFixed(4)),
    base: Number(base.toFixed(4)),
    positiveLift: Number(clamp01(positiveLift).toFixed(4)),
    positiveGain: Number(positiveGain.toFixed(4)),
    counterSuppression: Number(counterSuppression.toFixed(4)),
  };
}

function computeDriveCounterbalance(previousAxes, passionModulation = null) {
  const pressures = {};
  const details = [];
  const baseSuppression = clamp01(passionModulation ? passionModulation.counterSuppression : 0);
  for (const rule of DRIVE_COUNTER_RULES) {
    const driveValue = previousAxes[rule.drive] ? previousAxes[rule.drive].value : 0.5;
    const counterValue = previousAxes[rule.counter] ? previousAxes[rule.counter].value : 0.5;
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
      driveValue: Number(driveValue.toFixed(4)),
      counterValue: Number(counterValue.toFixed(4)),
      coActivationPressure: Number(coActivationPressure.toFixed(4)),
      dominancePressure: Number(dominancePressure.toFixed(4)),
      rawPressure: Number(rawPressure.toFixed(4)),
      pressure: Number(pressure.toFixed(4)),
      passionSuppression: Number(suppression.toFixed(4)),
    });
  }
  return {
    pressures: Object.fromEntries(
      Object.entries(pressures).map(([axis, value]) => [axis, Number(clamp01(value).toFixed(4))])
    ),
    details,
  };
}

function createInitialBaseline(axisMap) {
  const axes = {};
  for (const definition of AXIS_DEFINITIONS) {
    const value = axisMap && axisMap[definition.axis] ? axisMap[definition.axis].value : definition.defaultValue;
    axes[definition.axis] = {
      mean: Number(clamp01(value).toFixed(4)),
      mad: 0,
      count: 0,
      updatedAt: null,
    };
  }
  return { version: 1, axes };
}

function normalizeBaseline(raw, axisMap, observationCount = 0) {
  const fallback = createInitialBaseline(axisMap);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const rawAxes = raw.axes && typeof raw.axes === "object" && !Array.isArray(raw.axes) ? raw.axes : {};
  const axes = {};
  for (const definition of AXIS_DEFINITIONS) {
    const fallbackAxis = fallback.axes[definition.axis];
    const stats = rawAxes[definition.axis];
    axes[definition.axis] = {
      mean: clamp01(stats && Number.isFinite(Number(stats.mean)) ? Number(stats.mean) : fallbackAxis.mean),
      mad: clamp01(stats && Number.isFinite(Number(stats.mad)) ? Number(stats.mad) : 0),
      count: Math.max(0, Number.parseInt(stats && stats.count, 10) || observationCount || 0),
      updatedAt: stats && typeof stats.updatedAt === "string" ? stats.updatedAt : null,
    };
  }
  return { version: 1, axes };
}

function updateAxisBaseline(state, nextAxes) {
  const currentCount = Number(state.observationCount) || 0;
  const alpha = currentCount < 20 ? 0.12 : currentCount < 80 ? 0.06 : 0.035;
  const baseline = normalizeBaseline(state.baseline, nextAxes, currentCount);
  const now = nowIso();
  for (const definition of AXIS_DEFINITIONS) {
    const axis = definition.axis;
    const value = nextAxes[axis] ? clamp01(nextAxes[axis].value) : defaultAxisValue(state.agentKey, axis);
    const stats = baseline.axes[axis] || {
      mean: defaultAxisValue(state.agentKey, axis),
      mad: 0,
      count: 0,
      updatedAt: null,
    };
    const previousMean = clamp01(stats.mean);
    const nextMean = stats.count <= 0 ? value : previousMean + (value - previousMean) * alpha;
    const deviation = Math.abs(value - nextMean);
    const nextMad = stats.count <= 0 ? deviation : clamp01((Number(stats.mad) || 0) + (deviation - (Number(stats.mad) || 0)) * alpha);
    baseline.axes[axis] = {
      mean: Number(clamp01(nextMean).toFixed(4)),
      mad: Number(clamp01(nextMad).toFixed(4)),
      count: (Number(stats.count) || 0) + 1,
      updatedAt: now,
    };
  }
  state.baseline = baseline;
  return baseline;
}

function getAxisValue(state, layer, axis) {
  const value = state && state[layer] && state[layer][axis] ? state[layer][axis].value : undefined;
  return clamp01(Number.isFinite(Number(value)) ? Number(value) : defaultAxisValue(state && state.agentKey, axis));
}

function getAxisBaseline(state, axis) {
  const globalBase = defaultAxisValue(state && state.agentKey, axis);
  const stats = state && state.baseline && state.baseline.axes ? state.baseline.axes[axis] : null;
  if (!stats || !(Number(stats.count) >= 5)) return globalBase;
  const confidence = clamp01(Number(stats.count) / 80);
  return clamp01(globalBase * (1 - confidence) + clamp01(stats.mean) * confidence);
}

function relativeActivation(value, base, k = 2.2) {
  const normalizedValue = clamp01(value);
  const normalizedBase = clamp01(base);
  const aboveRaw = Math.max(0, normalizedValue - normalizedBase) / Math.max(0.05, 1 - normalizedBase);
  const belowRaw = Math.max(0, normalizedBase - normalizedValue) / Math.max(0.05, normalizedBase);
  return {
    above: Number(Math.pow(clamp01(aboveRaw), 1 / k).toFixed(4)),
    below: Number(Math.pow(clamp01(belowRaw), 1 / k).toFixed(4)),
    delta: Number((normalizedValue - normalizedBase).toFixed(4)),
    base: Number(normalizedBase.toFixed(4)),
  };
}

function resonance(factors, gain, epsilon = 0.03) {
  if (!Array.isArray(factors) || !factors.length) return 0;
  const prod = factors.reduce((acc, factor) => acc * Math.max(epsilon, clamp01(factor)), 1);
  const geo = Math.pow(prod, 1 / factors.length);
  return Number(clamp01(geo * gain).toFixed(4));
}

function affectiveSalience(value, neutral = 0.34, k = 1.55) {
  const normalizedValue = clamp01(value);
  const normalizedNeutral = clamp01(neutral);
  const aboveRaw = Math.max(0, normalizedValue - normalizedNeutral) / Math.max(0.05, 1 - normalizedNeutral);
  return Number(Math.pow(clamp01(aboveRaw), 1 / k).toFixed(4));
}

function topSubAxis(axisState) {
  const entries = Object.entries((axisState && axisState.subAxes) || {});
  if (!entries.length) return null;
  const [subAxis, payload] = entries.sort((a, b) => (b[1].weight || 0) - (a[1].weight || 0))[0];
  return {
    subAxis,
    weight: Number((payload.weight || 0).toFixed(4)),
    similarity: Number((payload.similarity || 0).toFixed(4)),
  };
}

function formatAxisLabel(axis) {
  return AXIS_BY_KEY[axis] ? AXIS_BY_KEY[axis].label : axis;
}

function applyObservationToState(state, scores, inputHash) {
  const previousAxes = flattenStateAxes(state);
  const coupled = applyCoupling(scores, previousAxes);
  const ema = activeConfig.OpenHerPersonaStateEma;
  const driveEma = activeConfig.OpenHerPersonaDriveStateEma;
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
    const layerEma = definition.layer === "drive" ? driveEma : ema;
    const value = clamp01(prev.value + (target - prev.value) * layerEma);
    nextAxes[definition.axis] = {
      value: Number(value.toFixed(4)),
      activation: Number(score.activation.toFixed(4)),
      sharpness: Number(score.sharpness.toFixed(4)),
      subAxes: score.subAxes || {},
    };
  }

  state.psyGender = nextAxes.psy_gender.value;
  const { gender, cognitive, affective, drive } = splitLayerState(nextAxes);
  state.gender = gender;
  state.cognitive = cognitive;
  state.affective = affective;
  state.drive = drive;
  state.coupling = {
    ...(state.coupling || {}),
    lastPassionModulation: coupled.__passionModulation || null,
    lastCounterbalance: coupled.__counterbalance || null,
  };
  updateAxisBaseline(state, nextAxes);
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
  const archetypes = evaluateMoodStateMachine(state, positive, negative, arousal, {
    getAxisValue,
    getAxisBaseline,
    relativeActivation,
  });
  const expression = computeExpressionFromState(state, {
    positive,
    negative,
    arousal,
    tension,
    dominance,
    archetypes,
  });
  return {
    positive: Number(positive.toFixed(4)),
    negative: Number(negative.toFixed(4)),
    arousal: Number(arousal.toFixed(4)),
    tension: Number(tension.toFixed(4)),
    dominance: Number(dominance.toFixed(4)),
    label: archetypes.primary ? archetypes.primary.label : moodLabel(positive, negative, arousal),
    archetypes,
    expression,
  };
}

function evaluateMoodArchetypes(state, p, n, a) {
  const calmness = 1 - a;
  const driveAxes = ["passion", "libido", "hedonia", "coldness", "arrogance", "numbness", "self_punishment", "fear", "curiosity"];
  const cognitiveAxes = ["inquiry", "discernment", "refusal"];
  const values = {};
  const rel = {};
  for (const axis of driveAxes) {
    values[axis] = getAxisValue(state, "drive", axis);
    rel[axis] = relativeActivation(values[axis], getAxisBaseline(state, axis));
  }
  for (const axis of cognitiveAxes) {
    values[axis] = getAxisValue(state, "cognitive", axis);
    rel[axis] = relativeActivation(values[axis], getAxisBaseline(state, axis));
  }

  const up = (axis) => (rel[axis] ? rel[axis].above : 0);
  const down = (axis) => (rel[axis] ? rel[axis].below : 0);
  const counterbalance = state && state.coupling ? state.coupling.lastCounterbalance : null;
  const pressure = (axis) => clamp01(counterbalance && counterbalance.pressures ? counterbalance.pressures[axis] : 0);
  const passionModulation = state && state.coupling ? state.coupling.lastPassionModulation : null;
  const passionGain = clamp01(passionModulation ? passionModulation.positiveGain : up("passion"));

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
    { label: "渊底自毁", score: resonance([up("self_punishment"), nTone, aTone], 0.92), recipe: ["self_punishment↑↑", "negative↑", "arousal↑"] },
    { label: "痛感沉溺", score: resonance([up("self_punishment"), up("hedonia"), pTone], 0.88), recipe: ["self_punishment↑↑", "hedonia↑", "positive↑"] },
    { label: "热情点燃", score: resonance([up("passion"), Math.max(pTone, up("hedonia")), Math.max(aTone, up("curiosity"))], 1.34), recipe: ["passion↑", "positive↑/hedonia↑", "arousal↑/curiosity↑"] },
    { label: "情热涌动", score: resonance([up("libido"), aTone, pTone, passionGain], 1.05), recipe: ["libido↑", "arousal↑", "positive↑", "passionGain"] },
    { label: "绵密缱绻", score: resonance([up("libido"), up("hedonia"), calmTone, passionGain], 1.04), recipe: ["libido↑", "hedonia↑", "calmness↑", "passionGain"] },
    { label: "欲念焦灼", score: resonance([up("libido"), nTone, aTone], 1.02), recipe: ["libido↑", "negative↑", "arousal↑"] },
    { label: "欲冷相娇", score: resonance([up("libido"), coldNumb, libidoColdPressure], 1.16), recipe: ["libido↑", "cold/numb↑", "libidoCounterPressure"] },
    { label: "冷欲渐起", score: resonance([up("libido"), up("numbness"), calmTone], 1.04), recipe: ["libido↑", "numbness↑", "calmness↑"] },
    { label: "情热受阻", score: resonance([passionGain, maxExpansiveDrive, coldNumb], 1.05), recipe: ["passionGain", "drive↑", "cold/numb↑"] },
    { label: "狂妄昂扬", score: resonance([up("arrogance"), pTone, aTone, passionGain], 1.2), recipe: ["arrogance↑", "positive↑", "arousal↑", "passionGain"] },
    { label: "傲慢睥睨", score: resonance([up("arrogance"), up("coldness"), calmTone], 0.93), recipe: ["arrogance↑", "coldness↑↓", "calmness↑"] },
    { label: "霜冷拒守", score: resonance([up("refusal"), up("coldness"), nTone], 1.00), recipe: ["refusal↑", "coldness↑↓", "negative↑"] },
    { label: "封冻死寂", score: resonance([up("numbness"), up("coldness"), calmTone, lowValence, lowExpansiveDrive], 0.99), recipe: ["numbness↑↓", "coldness↑↓", "calmness↑", "lowValence", "lowDrive"] },
    { label: "麻木解冻", score: resonance([down("numbness"), pTone, Math.max(up("curiosity"), up("libido"), up("arrogance"))], 1.1), recipe: ["numbness↓", "positive↑", "drive↑"] },
    { label: "惊惧退守", score: resonance([up("fear"), aTone, nTone], 1.00), recipe: ["fear↑↓", "arousal↑", "negative↑"] },
    { label: "如履薄冰", score: resonance([up("fear"), up("discernment"), calmTone], 0.95), recipe: ["fear↑↓", "discernment↑", "calmness↑"] },
    { label: "虚张声势", score: resonance([up("arrogance"), up("fear"), pressure("arrogance")], 1.00), recipe: ["arrogance↑", "fear↑↓", "arroganceCounterPressure"] },
    { label: "探求炽热", score: resonance([up("curiosity"), up("inquiry"), Math.max(aTone, up("passion"))], 1.28), recipe: ["curiosity↑", "inquiry↑", "arousal↑/passion↑"] },
    { label: "幽微洞察", score: resonance([up("discernment"), up("inquiry"), calmTone], 1.12), recipe: ["discernment↑", "inquiry↑", "calmness↑"] },
    { label: "慵懒沉陷", score: resonance([up("hedonia"), calmTone, pTone], 1.1), recipe: ["hedonia↑", "calmness↑", "positive↑"] },
    { label: "享乐负罪", score: resonance([up("hedonia"), up("self_punishment"), pressure("hedonia")], 0.92), recipe: ["hedonia↑", "self_punishment↑↑", "hedoniaCounterPressure"] },
    { label: "雀跃明亮", score: resonance([pTone, aTone], 0.98), recipe: ["positive↑", "arousal↑"] },
    { label: "温和宁静", score: resonance([pTone, calmTone], 0.98), recipe: ["positive↑", "calmness↑"] },
    { label: "焦灼愤懑", score: resonance([nTone, aTone], 0.98), recipe: ["negative↑", "arousal↑"] },
    { label: "黯淡失落", score: resonance([nTone, calmTone], 0.98), recipe: ["negative↑", "calmness↑"] },
    { label: "平静观测", score: 0.43, recipe: ["fallback"] },
  ];

  archetypes.sort((left, right) => right.score - left.score);
  const candidates = archetypes.slice(0, 5).map((item) => ({
    label: item.label,
    score: Number(item.score.toFixed(4)),
    recipe: item.recipe,
  }));
  return {
    primary: candidates[0],
    secondary: candidates[1] || null,
    candidates,
    relative: Object.fromEntries(
      Object.entries(rel).map(([axis, item]) => [
        axis,
        {
          base: item.base,
          delta: item.delta,
          above: item.above,
          below: item.below,
        },
      ])
    ),
  };
}

function computeExpressionFromState(state, context) {
  const affective = summarizeAffectiveExpression(state, context);
  const drive = summarizeDriveExpression(state);
  const gender = summarizeGenderExpression(state);
  const archetypes = context.archetypes;
  const shortLabel = [archetypes.primary && archetypes.primary.label, drive.label, gender.label]
    .filter(Boolean)
    .slice(0, 3)
    .join(" / ");
  const sentenceParts = [
    `当前情绪底色为${affective.label}`,
    drive.sentence,
    gender.sentence,
  ].filter(Boolean);
  return {
    shortLabel,
    sentence: `${sentenceParts.join("，")}。`,
    affective,
    drive,
    gender,
    archetypes: archetypes.candidates,
  };
}

function summarizeAffectiveExpression(state, context) {
  const dominantAxis = context.dominance >= 0 ? "positive" : "negative";
  const dominantSubAxis = topSubAxis(state && state.affective ? state.affective[dominantAxis] : null);
  const label = context.archetypes.primary ? context.archetypes.primary.label : moodLabel(context.positive, context.negative, context.arousal);
  return {
    label,
    positive: Number(context.positive.toFixed(4)),
    negative: Number(context.negative.toFixed(4)),
    arousal: Number(context.arousal.toFixed(4)),
    tension: Number(context.tension.toFixed(4)),
    dominance: Number(context.dominance.toFixed(4)),
    dominantAxis,
    dominantSubAxis,
  };
}

function summarizeDriveExpression(state) {
  const driveEntries = Object.entries((state && state.drive) || {});
  if (!driveEntries.length) return { label: null, primaryDrive: null, counterDrive: null, sentence: null };
  const positiveDriveKeys = new Set(["curiosity", "arrogance", "libido", "hedonia"]);
  const sortByValue = (entries) => entries.sort((a, b) => (b[1].value || 0) - (a[1].value || 0));
  const primary = sortByValue(driveEntries.filter(([axis]) => positiveDriveKeys.has(axis)))[0] || null;
  const counterbalance = state && state.coupling ? state.coupling.lastCounterbalance : null;
  const passionModulation = state && state.coupling ? state.coupling.lastPassionModulation : null;
  const details = Array.isArray(counterbalance && counterbalance.details) ? counterbalance.details : [];
  const pressures = counterbalance && counterbalance.pressures ? counterbalance.pressures : {};
  const strongestPressure = Object.entries(pressures).sort((a, b) => b[1] - a[1])[0] || null;
  const strongestPrimaryCounter = primary
    ? details
      .filter((item) => item && item.drive === primary[0] && Number(item.pressure) > 0.02)
      .sort((a, b) => Number(b.pressure) - Number(a.pressure))[0] || null
    : null;
  const labelParts = [];
  if (primary) labelParts.push(`${formatAxisLabel(primary[0])}上扬`);
  if (strongestPrimaryCounter) labelParts.push(`${formatAxisLabel(strongestPrimaryCounter.counter)}对冲`);
  const label = labelParts.join("·") || "驱动平稳";
  const pressureText = strongestPressure && strongestPressure[1] > 0.02
    ? `其中${formatAxisLabel(strongestPressure[0])}受到对冲压力${Number(strongestPressure[1]).toFixed(2)}`
    : "对冲压力较低";
  const passionText = passionModulation && passionModulation.positiveGain > 0.02
    ? `，热情背景增益${Number(passionModulation.positiveGain).toFixed(2)}并分化压低冷漠/麻木型对冲${Number(passionModulation.counterSuppression).toFixed(2)}`
    : "";
  const counterAxisState = strongestPrimaryCounter && state.drive ? state.drive[strongestPrimaryCounter.counter] : null;
  return {
    label,
    primaryDrive: primary ? { axis: primary[0], label: formatAxisLabel(primary[0]), value: Number((primary[1].value || 0).toFixed(4)), subAxis: topSubAxis(primary[1]) } : null,
    counterDrive: strongestPrimaryCounter ? { axis: strongestPrimaryCounter.counter, label: formatAxisLabel(strongestPrimaryCounter.counter), value: Number((counterAxisState && counterAxisState.value || 0).toFixed(4)), subAxis: topSubAxis(counterAxisState) } : null,
    counterPressure: strongestPressure ? { axis: strongestPressure[0], label: formatAxisLabel(strongestPressure[0]), pressure: Number(strongestPressure[1].toFixed(4)) } : null,
    passionModulation: passionModulation || null,
    sentence: `驱动层表现为${label}，${pressureText}${passionText}`,
  };
}

function summarizeGenderExpression(state) {
  const genderEntries = Object.entries((state && state.gender) || {}).filter(([axis]) => axis !== "psy_gender");
  if (!genderEntries.length) return { label: null, sentence: null, dominantGenderAxis: null };
  const decorated = genderEntries.map(([axis, axisState]) => {
    const sub = topSubAxis(axisState);
    const subAxis = sub ? sub.subAxis : "";
    const pole = subAxis.startsWith("masculine") ? "masculine" : subAxis.startsWith("feminine") ? "feminine" : "neutral";
    return {
      axis,
      label: formatAxisLabel(axis),
      value: clamp01(axisState.value),
      sharpness: clamp01(axisState.sharpness),
      subAxis: sub,
      pole,
    };
  });
  const dominant = decorated.sort((a, b) => b.sharpness - a.sharpness || Math.abs(b.value - 0.5) - Math.abs(a.value - 0.5))[0];
  const masculineCount = decorated.filter((item) => item.pole === "masculine").length;
  const feminineCount = decorated.filter((item) => item.pole === "feminine").length;
  const polarity = masculineCount > feminineCount + 1
    ? "男性极"
    : feminineCount > masculineCount + 1
      ? "女性极"
      : "混合态";
  const label = dominant ? `${dominant.label}主导·${polarity}` : polarity;
  return {
    label,
    globalPolarity: polarity,
    dominantGenderAxis: dominant || null,
    masculineAxes: decorated.filter((item) => item.pole === "masculine").map((item) => item.axis),
    feminineAxes: decorated.filter((item) => item.pole === "feminine").map((item) => item.axis),
    sentence: dominant ? `性别轴体以${dominant.label}为最清晰表达，整体呈${polarity}` : `性别轴体整体呈${polarity}`,
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
    gender: state.gender,
    cognitive: state.cognitive,
    affective: state.affective,
    drive: state.drive,
    baseline: state.baseline,
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
