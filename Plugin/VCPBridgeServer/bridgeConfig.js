const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const CONFIG_FILE_NAME = 'bridge-config.json';
const PLUGIN_DIR = __dirname;
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(PLUGIN_DIR, CONFIG_FILE_NAME);
const PROFILES_DIR = path.join(PLUGIN_DIR, 'profiles');

const DEFAULT_BRIDGE_CONFIG = Object.freeze({
    port: 3100,
    upstreamUrl: '',
    upstreamKey: '',
    upstreamType: 'chat',
    defaultModel: 'gpt-4.1-mini',
    systemPrompt: '',
    hijackMode: 'off',
    modelMap: {},
    debugMode: false,
    defaultProfile: ''
});

const DESCRIPTION = Object.freeze({
    port: 'Bridge Server 监听端口（独立于主服务器）。端口修改需要重启插件/主服务后生效。',
    upstreamUrl: '上游 API 地址。留空时自动指向本机 VCP 主服务器。',
    upstreamKey: '上游 API Key。留空时使用主服务 Key 或透传下游 Authorization Bearer。',
    upstreamType: '上游 API 类型：chat / anthropic / gemini。',
    defaultModel: '默认模型名。下游请求未指定 model 时使用。',
    systemPrompt: '注入的 System Prompt（全局兜底）。支持填写插件目录下的 .txt 文件名。当无 Profile 匹配时使用此值。',
    hijackMode: '劫持模式（全局兜底）：off / replace / prepend / append / merge。当无 Profile 匹配时使用此值。',
    modelMap: '模型名映射对象，例如 {"gpt-4":"gemini-2.5-pro"}。',
    debugMode: '是否输出桥接代理调试日志。',
    defaultProfile: '默认 Profile 名称。请求未指定 Profile 时自动使用此 Profile（留空则使用全局 systemPrompt/hijackMode）。'
});

// ============================================================
// 基础类型归一化工具
// ============================================================

function normalizeApiType(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'anthropic' || normalized === 'claude') return 'anthropic';
    if (normalized === 'gemini' || normalized === 'google') return 'gemini';
    return 'chat';
}

function normalizeHijackMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (['replace', 'prepend', 'append', 'merge', 'off'].includes(normalized)) {
        return normalized;
    }
    return 'off';
}

function normalizeBoolean(value, defaultValue = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    }
    return defaultValue;
}

function normalizePort(value, defaultValue = DEFAULT_BRIDGE_CONFIG.port) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) return parsed;
    return defaultValue;
}

function parseModelMap(raw) {
    if (!raw) return {};
    if (typeof raw === 'object' && !Array.isArray(raw)) {
        return Object.entries(raw).reduce((acc, [alias, target]) => {
            const cleanAlias = String(alias || '').trim();
            const cleanTarget = String(target || '').trim();
            if (cleanAlias && cleanTarget) acc[cleanAlias] = cleanTarget;
            return acc;
        }, {});
    }
    return String(raw).split(',').reduce((acc, pair) => {
        const idx = pair.indexOf(':');
        if (idx > 0) {
            const alias = pair.slice(0, idx).trim();
            const target = pair.slice(idx + 1).trim();
            if (alias && target) acc[alias] = target;
        }
        return acc;
    }, {});
}

function formatModelMap(modelMap) {
    return Object.entries(parseModelMap(modelMap))
        .map(([alias, target]) => `${alias}:${target}`)
        .join(',');
}

// ============================================================
// 环境变量读取
// ============================================================

function readEnvFileIfExists(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return dotenv.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.warn(`[VCPBridgeConfig] Failed to parse env file ${filePath}:`, error.message);
        return null;
    }
}

function selectEnvSource() {
    const pluginEnvPath = path.join(PLUGIN_DIR, 'config.env');
    const pluginExamplePath = path.join(PLUGIN_DIR, 'config.env.example');
    return readEnvFileIfExists(pluginEnvPath) || readEnvFileIfExists(pluginExamplePath) || {};
}

// ============================================================
// 全局配置管理
// ============================================================

function normalizeBridgeConfig(raw = {}, fallbackEnv = {}) {
    const mainServerPort = raw.mainServerPort || fallbackEnv.PORT || process.env.PORT || 6005;
    const defaultUpstream = `http://127.0.0.1:${mainServerPort}`;
    const rawUpstreamUrl = raw.upstreamUrl ?? raw.BRIDGE_UPSTREAM_URL ?? fallbackEnv.BRIDGE_UPSTREAM_URL ?? '';

    return {
        port: normalizePort(raw.port ?? raw.BRIDGE_PORT ?? fallbackEnv.BRIDGE_PORT),
        upstreamUrl: String(rawUpstreamUrl || defaultUpstream).trim().replace(/\/+$/, ''),
        upstreamKey: String(raw.upstreamKey ?? raw.BRIDGE_UPSTREAM_KEY ?? fallbackEnv.BRIDGE_UPSTREAM_KEY ?? fallbackEnv.Key ?? process.env.Key ?? ''),
        upstreamType: normalizeApiType(raw.upstreamType ?? raw.BRIDGE_UPSTREAM_TYPE ?? fallbackEnv.BRIDGE_UPSTREAM_TYPE),
        defaultModel: String(raw.defaultModel ?? raw.BRIDGE_MODEL ?? fallbackEnv.BRIDGE_MODEL ?? DEFAULT_BRIDGE_CONFIG.defaultModel).trim() || DEFAULT_BRIDGE_CONFIG.defaultModel,
        systemPrompt: String(raw.systemPrompt ?? raw.BRIDGE_SYSTEM_PROMPT ?? fallbackEnv.BRIDGE_SYSTEM_PROMPT ?? ''),
        hijackMode: normalizeHijackMode(raw.hijackMode ?? raw.BRIDGE_HIJACK_MODE ?? fallbackEnv.BRIDGE_HIJACK_MODE),
        modelMap: parseModelMap(raw.modelMap ?? raw.BRIDGE_MODEL_MAP ?? fallbackEnv.BRIDGE_MODEL_MAP),
        debugMode: normalizeBoolean(raw.debugMode ?? raw.DebugMode ?? fallbackEnv.DebugMode, DEFAULT_BRIDGE_CONFIG.debugMode),
        defaultProfile: String(raw.defaultProfile ?? '').trim()
    };
}

function buildConfigFromEnv(env = {}) {
    return normalizeBridgeConfig({
        BRIDGE_PORT: env.BRIDGE_PORT,
        BRIDGE_UPSTREAM_URL: env.BRIDGE_UPSTREAM_URL,
        BRIDGE_UPSTREAM_KEY: env.BRIDGE_UPSTREAM_KEY,
        BRIDGE_UPSTREAM_TYPE: env.BRIDGE_UPSTREAM_TYPE,
        BRIDGE_MODEL: env.BRIDGE_MODEL,
        BRIDGE_SYSTEM_PROMPT: env.BRIDGE_SYSTEM_PROMPT,
        BRIDGE_HIJACK_MODE: env.BRIDGE_HIJACK_MODE,
        BRIDGE_MODEL_MAP: env.BRIDGE_MODEL_MAP,
        DebugMode: env.DebugMode
    }, env);
}

function readJsonConfig() {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return normalizeBridgeConfig(parsed);
}

function writeJsonConfig(config) {
    const payload = {
        ...normalizeBridgeConfig(config),
        description: DESCRIPTION
    };
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return payload;
}

function migrateBridgeConfig() {
    if (fs.existsSync(CONFIG_PATH)) {
        return readJsonConfig();
    }

    const env = selectEnvSource();
    const config = buildConfigFromEnv(env);
    writeJsonConfig(config);
    console.log(`[VCPBridgeConfig] Created ${path.relative(PROJECT_ROOT, CONFIG_PATH)} from ${Object.keys(env).length ? 'env/example' : 'defaults'}.`);
    return config;
}

function readBridgeConfig() {
    return migrateBridgeConfig();
}

function saveBridgeConfig(config) {
    return writeJsonConfig(config);
}

function toEnvCompatConfig(config) {
    const normalized = normalizeBridgeConfig(config);
    return {
        BRIDGE_PORT: normalized.port,
        BRIDGE_UPSTREAM_URL: normalized.upstreamUrl,
        BRIDGE_UPSTREAM_KEY: normalized.upstreamKey,
        BRIDGE_UPSTREAM_TYPE: normalized.upstreamType,
        BRIDGE_MODEL: normalized.defaultModel,
        BRIDGE_SYSTEM_PROMPT: normalized.systemPrompt,
        BRIDGE_HIJACK_MODE: normalized.hijackMode,
        BRIDGE_MODEL_MAP: formatModelMap(normalized.modelMap),
        DebugMode: normalized.debugMode
    };
}

// ============================================================
// Profile 管理
// ============================================================

/**
 * 确保 profiles 目录存在
 */
function ensureProfilesDir() {
    if (!fs.existsSync(PROFILES_DIR)) {
        fs.mkdirSync(PROFILES_DIR, { recursive: true });
    }
}

/**
 * 对 profile 数据进行归一化和验证
 * @param {string} name - Profile 文件名（不含扩展名）
 * @param {object} raw - 原始 profile 数据
 * @returns {object} 归一化后的 profile 对象
 */
function normalizeProfile(name, raw = {}) {
    return {
        name: String(name || raw.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''),
        displayName: String(raw.displayName || raw.name || name || '').trim(),
        systemPrompt: String(raw.systemPrompt || '').trim(),
        hijackMode: normalizeHijackMode(raw.hijackMode),
        modelOverride: String(raw.modelOverride || '').trim(),
        description: String(raw.description || '').trim()
    };
}

/**
 * 验证 profile name 是否合法（防路径穿越）
 * @param {string} name
 * @returns {boolean}
 */
function isValidProfileName(name) {
    if (!name || typeof name !== 'string') return false;
    const cleaned = name.trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(cleaned);
}

/**
 * 判断指定 profile 是否存在
 * @param {string} name
 * @returns {boolean}
 */
function profileExists(name) {
    if (!isValidProfileName(name)) return false;
    return fs.existsSync(path.join(PROFILES_DIR, `${name}.json`));
}

/**
 * 列出所有 profile
 * @returns {Array<object>} profile 对象数组
 */
function listProfiles() {
    ensureProfilesDir();
    try {
        return fs.readdirSync(PROFILES_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                try {
                    const filePath = path.join(PROFILES_DIR, f);
                    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    const name = f.replace(/\.json$/, '');
                    return normalizeProfile(name, parsed);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
    } catch {
        return [];
    }
}

/**
 * 读取单个 profile
 * @param {string} name - Profile 名称
 * @returns {object|null} profile 对象或 null
 */
function readProfile(name) {
    if (!isValidProfileName(name)) return null;
    const filePath = path.join(PROFILES_DIR, `${name}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return normalizeProfile(name, parsed);
    } catch {
        return null;
    }
}

/**
 * 保存/创建 profile
 * @param {string} name - Profile 名称
 * @param {object} data - Profile 数据
 * @returns {object} 归一化后的 profile
 */
function saveProfile(name, data = {}) {
    if (!isValidProfileName(name)) {
        throw new Error(`Invalid profile name: "${name}". Only lowercase letters, digits, hyphens and underscores allowed (1-64 chars).`);
    }
    ensureProfilesDir();
    const normalized = normalizeProfile(name, data);
    const filePath = path.join(PROFILES_DIR, `${name}.json`);
    fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    return normalized;
}

/**
 * 删除 profile
 * @param {string} name - Profile 名称
 * @returns {boolean} 是否成功删除
 */
function deleteProfile(name) {
    if (!isValidProfileName(name)) return false;
    const filePath = path.join(PROFILES_DIR, `${name}.json`);
    if (!fs.existsSync(filePath)) return false;
    try {
        fs.unlinkSync(filePath);
        return true;
    } catch {
        return false;
    }
}

// ============================================================
// 导出
// ============================================================

module.exports = {
    // 路径常量
    CONFIG_PATH,
    CONFIG_FILE_NAME,
    PROFILES_DIR,
    DESCRIPTION,

    // 全局配置管理
    normalizeBridgeConfig,
    migrateBridgeConfig,
    readBridgeConfig,
    saveBridgeConfig,
    toEnvCompatConfig,
    parseModelMap,

    // Profile 管理
    normalizeProfile,
    isValidProfileName,
    profileExists,
    listProfiles,
    readProfile,
    saveProfile,
    deleteProfile
};