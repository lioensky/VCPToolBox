const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const CONFIG_FILE_NAME = 'bridge-config.json';
const PLUGIN_DIR = __dirname;
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(PLUGIN_DIR, CONFIG_FILE_NAME);

const DEFAULT_BRIDGE_CONFIG = Object.freeze({
    port: 3100,
    upstreamUrl: '',
    upstreamKey: '',
    upstreamType: 'chat',
    defaultModel: 'gpt-4.1-mini',
    systemPrompt: '',
    hijackMode: 'off',
    modelMap: {},
    debugMode: false
});

const DESCRIPTION = Object.freeze({
    port: 'Bridge Server 监听端口（独立于主服务器）。端口修改需要重启插件/主服务后生效。',
    upstreamUrl: '上游 API 地址。留空时自动指向本机 VCP 主服务器。',
    upstreamKey: '上游 API Key。留空时使用主服务 Key 或透传下游 Authorization Bearer。',
    upstreamType: '上游 API 类型：chat / anthropic / gemini。',
    defaultModel: '默认模型名。下游请求未指定 model 时使用。',
    systemPrompt: '注入的 System Prompt。支持填写插件目录下的 .txt 文件名。',
    hijackMode: '劫持模式：off / replace / prepend / append / merge。',
    modelMap: '模型名映射对象，例如 {"gpt-4":"gemini-2.5-pro"}。',
    debugMode: '是否输出桥接代理调试日志。'
});

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
        debugMode: normalizeBoolean(raw.debugMode ?? raw.DebugMode ?? fallbackEnv.DebugMode, DEFAULT_BRIDGE_CONFIG.debugMode)
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

module.exports = {
    CONFIG_PATH,
    CONFIG_FILE_NAME,
    DESCRIPTION,
    normalizeBridgeConfig,
    migrateBridgeConfig,
    readBridgeConfig,
    saveBridgeConfig,
    toEnvCompatConfig,
    parseModelMap
};