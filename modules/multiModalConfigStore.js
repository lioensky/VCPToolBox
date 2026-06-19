// modules/multiModalConfigStore.js
//
// 多模态配置 JSON 真相源
// ----------------------------------------------------------------
// 优先级：multimodal-config.json > config.env (process.env)
//
// 设计目标：
// 1. JSON 优先：服务器启动时读取 multimodal-config.json，若不存在则用 config.env 中的值生成默认 JSON。
// 2. 热更新：通过 chokidar 监听 JSON 文件变化，写入会立即触发内存刷新；插件下次执行时即可拿到最新值。
// 3. 兼容旧逻辑：image-processor.js / reidentify_image.js / MULTIMODAL_FORCE_TRANSLATE_MODELS
//    全部通过 getConfig() 取值，再退回 process.env 兜底。
//
// 字段语义（与 config.env [多模态配置] 区段一一对应）：
//   - MultiModalModel:                    多模态识别模型名
//   - MultiModalPrompt:                   多模态识别系统提示词
//   - MediaInsertPrompt:                  多模态信息插入提示词
//   - MultiModalModelOutputMaxTokens:     多模态最大输出 token
//   - MultiModalModelContent:             多模态最大上下文 token（保留字段，目前仅展示）
//   - MultiModalModelThinkingBudget:      Gemini Thinking Budget（>0 启用）
//   - MultiModalModelAsynchronousLimit:   多模态异步并发上限（>=1）
//   - MultiModalForceTranslateModels:     纯文本模型 tag 列表（数组，不区分大小写）

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'multimodal-config.json');

const FIELD_DEFAULTS = Object.freeze({
    MultiModalModel: '',
    MultiModalPrompt: '',
    MediaInsertPrompt: '服务器已处理多模态数据，VCP系统已自动提取多模态数据信息，信息元如下——',
    MultiModalModelOutputMaxTokens: 50000,
    MultiModalModelContent: 250000,
    MultiModalModelThinkingBudget: 0,
    MultiModalModelAsynchronousLimit: 1,
    MultiModalForceTranslateModels: []
});

const INTEGER_FIELDS = new Set([
    'MultiModalModelOutputMaxTokens',
    'MultiModalModelContent',
    'MultiModalModelThinkingBudget',
    'MultiModalModelAsynchronousLimit'
]);

const STRING_FIELDS = new Set([
    'MultiModalModel',
    'MultiModalPrompt',
    'MediaInsertPrompt'
]);

const ARRAY_FIELDS = new Set(['MultiModalForceTranslateModels']);

let memoryConfig = { ...FIELD_DEFAULTS };
let watcher = null;
let watcherInitialized = false;
let lastLoadError = null;

const subscribers = new Set();

function parseIntegerSafe(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeForceTranslateArray(raw) {
    if (Array.isArray(raw)) {
        return raw
            .map(item => String(item || '').trim().toLowerCase())
            .filter(item => item !== '');
    }
    if (typeof raw === 'string') {
        return raw.split(',')
            .map(item => item.trim().toLowerCase())
            .filter(item => item !== '');
    }
    return [];
}

function readEnvDefaults() {
    return {
        MultiModalModel: process.env.MultiModalModel || FIELD_DEFAULTS.MultiModalModel,
        MultiModalPrompt: process.env.MultiModalPrompt || FIELD_DEFAULTS.MultiModalPrompt,
        MediaInsertPrompt: process.env.MediaInsertPrompt || FIELD_DEFAULTS.MediaInsertPrompt,
        MultiModalModelOutputMaxTokens: parseIntegerSafe(process.env.MultiModalModelOutputMaxTokens, FIELD_DEFAULTS.MultiModalModelOutputMaxTokens),
        MultiModalModelContent: parseIntegerSafe(process.env.MultiModalModelContent, FIELD_DEFAULTS.MultiModalModelContent),
        MultiModalModelThinkingBudget: parseIntegerSafe(process.env.MultiModalModelThinkingBudget, FIELD_DEFAULTS.MultiModalModelThinkingBudget),
        MultiModalModelAsynchronousLimit: Math.max(1, parseIntegerSafe(process.env.MultiModalModelAsynchronousLimit, FIELD_DEFAULTS.MultiModalModelAsynchronousLimit)),
        MultiModalForceTranslateModels: normalizeForceTranslateArray(process.env.MultiModalForceTranslateModels)
    };
}

function normalizeConfig(raw, envDefaults) {
    const fallback = envDefaults || readEnvDefaults();
    const next = { ...FIELD_DEFAULTS, ...fallback };
    if (!raw || typeof raw !== 'object') return next;

    for (const key of Object.keys(FIELD_DEFAULTS)) {
        if (!(key in raw)) continue;
        const value = raw[key];
        if (STRING_FIELDS.has(key)) {
            if (typeof value === 'string') {
                next[key] = value;
            } else if (value === null || value === undefined) {
                next[key] = '';
            }
        } else if (INTEGER_FIELDS.has(key)) {
            const parsed = parseIntegerSafe(value, next[key]);
            if (key === 'MultiModalModelAsynchronousLimit') {
                next[key] = Math.max(1, parsed);
            } else {
                next[key] = parsed;
            }
        } else if (ARRAY_FIELDS.has(key)) {
            next[key] = normalizeForceTranslateArray(value);
        }
    }
    return next;
}

function notifySubscribers(reason) {
    for (const fn of subscribers) {
        try {
            fn({ ...memoryConfig }, reason);
        } catch (error) {
            console.error('[MultiModalConfigStore] subscriber error:', error);
        }
    }
}

function writeConfigFileSync(config) {
    const payload = { ...FIELD_DEFAULTS, ...config };
    const json = JSON.stringify({
        ...payload,
        __description: {
            MultiModalModel: '多模态识别模型 ID（如 gemini-2.5-flash）',
            MultiModalPrompt: '多模态识别系统提示词，发送给多模态模型用于结构化转译',
            MediaInsertPrompt: '识别完成后插入到 user 文本块的引导语',
            MultiModalModelOutputMaxTokens: '多模态识别 max_tokens，默认 50000',
            MultiModalModelContent: '多模态最大上下文 token，仅作展示参考',
            MultiModalModelThinkingBudget: 'Gemini thinking_budget，>0 启用 thinking',
            MultiModalModelAsynchronousLimit: '多模态异步并发上限，最小 1',
            MultiModalForceTranslateModels: '纯文本模型 Tag 数组（小写匹配），命中即强制把多模态翻译为文本'
        }
    }, null, 2);
    fs.writeFileSync(CONFIG_PATH, `${json}\n`, 'utf8');
}

function loadFromFileSync() {
    const envDefaults = readEnvDefaults();
    let raw = null;
    if (fs.existsSync(CONFIG_PATH)) {
        try {
            const content = fs.readFileSync(CONFIG_PATH, 'utf8');
            raw = JSON.parse(content);
            lastLoadError = null;
        } catch (error) {
            lastLoadError = error;
            console.error('[MultiModalConfigStore] Failed to parse multimodal-config.json, fall back to env defaults:', error.message);
            raw = null;
        }
    }
    memoryConfig = normalizeConfig(raw, envDefaults);
    return memoryConfig;
}

function ensureFileExistsSync() {
    if (fs.existsSync(CONFIG_PATH)) return;
    try {
        const envDefaults = readEnvDefaults();
        writeConfigFileSync(envDefaults);
        console.log('[MultiModalConfigStore] multimodal-config.json 不存在，已基于 config.env 自动生成。');
    } catch (error) {
        console.error('[MultiModalConfigStore] Failed to create multimodal-config.json:', error);
    }
}

function startWatcher() {
    if (watcherInitialized) return;
    watcherInitialized = true;
    try {
        const chokidar = require('chokidar');
        watcher = chokidar.watch(CONFIG_PATH, {
            ignoreInitial: true,
            awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
        });
        const reload = (reason) => {
            try {
                loadFromFileSync();
                notifySubscribers(reason);
                console.log(`[MultiModalConfigStore] 配置已热加载 (${reason})。`);
            } catch (error) {
                console.error('[MultiModalConfigStore] 热加载失败:', error);
            }
        };
        watcher.on('add', () => reload('add'));
        watcher.on('change', () => reload('change'));
        watcher.on('unlink', () => {
            ensureFileExistsSync();
            reload('unlink-recreate');
        });
        watcher.on('error', error => console.error('[MultiModalConfigStore] watcher error:', error));
    } catch (error) {
        console.error('[MultiModalConfigStore] Failed to init chokidar watcher:', error);
    }
}

function init() {
    ensureFileExistsSync();
    loadFromFileSync();
    startWatcher();
    return memoryConfig;
}

function getConfig() {
    return { ...memoryConfig };
}

function getValue(key) {
    return memoryConfig[key];
}

function getForceTranslateModels() {
    return Array.isArray(memoryConfig.MultiModalForceTranslateModels)
        ? [...memoryConfig.MultiModalForceTranslateModels]
        : [];
}

function saveConfig(partial) {
    if (!partial || typeof partial !== 'object') {
        throw new Error('saveConfig requires an object payload.');
    }
    const envDefaults = readEnvDefaults();
    // 合并：以现有内存配置为底，patch 进新值
    const merged = normalizeConfig({ ...memoryConfig, ...partial }, envDefaults);
    writeConfigFileSync(merged);
    memoryConfig = merged;
    notifySubscribers('save');
    return { ...memoryConfig };
}

function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    subscribers.add(fn);
    return () => subscribers.delete(fn);
}

function getStatus() {
    return {
        path: CONFIG_PATH,
        loaded: true,
        lastLoadError: lastLoadError ? lastLoadError.message : null,
        watcherActive: !!watcher
    };
}

module.exports = {
    init,
    getConfig,
    getValue,
    getForceTranslateModels,
    saveConfig,
    subscribe,
    getStatus,
    CONFIG_PATH,
    FIELD_DEFAULTS
};