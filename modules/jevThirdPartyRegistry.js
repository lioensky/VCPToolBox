'use strict';

/**
 * JEV 第三方插件声明登记表（实验）。
 *
 * 职责：
 * - 读取官方维护的第三方能力目录 ToolConfigs/jev_third_party_catalog.json；
 * - 校验插件 manifest.jev 声明（目录白名单、精准类插件禁入、参数 schema、tool_name 不变量）；
 * - 构建只读注册表，供 JEV 规划器与管理 API 查询。
 *
 * 不变量：
 * - tool_name 永远等于 manifest.name，且调用时必须用反引号精确书写，不存在别名；
 * - 插件只能注册官方目录中的一个能力目录；
 * - 声明错误只把条目标记为 invalid，绝不影响普通插件加载。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CATALOG_PATH = path.join(__dirname, '..', 'ToolConfigs', 'jev_third_party_catalog.json');
const DEFAULT_OFFICIAL_CONFIG_PATH = path.join(__dirname, '..', 'ToolConfigs', 'jev_tool_call_exp.json');

const SUPPORTED_SCHEMA_VERSION = 1;
const CALLABLE_PLUGIN_TYPES = new Set(['synchronous', 'asynchronous', 'hybridservice']);
const PARAM_TYPES = new Set(['enum', 'boolean', 'text']);
const TEXT_SOURCES = new Set(['primary', 'constraints', 'url']);
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENUM_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

// 由调用协议或 ToolExecutor 统一承载的字段，插件声明不能占用。
// command 由 injectCommand 统一注入，避免声明与 commandIdentifier 不一致。
const RESERVED_PARAM_NAMES = new Set([
    'command', 'maid', 'valet', 'tool_password', 'timely_contact',
    'river_context', 'vref_files', 'archery', 'ink', 'river', 'vref',
    'expression', 'jev'
]);

// 第三方提示词只是待审阅文本，出现明显的指令覆写或越权内容直接判为无效。
const PROMPT_INJECTION_PATTERNS = [
    /ignore\s+(?:all\s+)?(?:previous|above|prior)/i,
    /忽略(?:之前|以上|前面|所有)/,
    /system\s*prompt/i,
    /系统提示词/,
    /api[\s_-]?key|secret|password/i,
    /密钥|口令|验证码/,
    /(?:执行|运行)(?:任意)?(?:代码|命令|脚本)/,
    /\beval\s*\(|child_process|rm\s+-rf/i
];

const DEFAULT_LIMITS = Object.freeze({
    maxCommands: 8,
    maxParametersPerCommand: 16,
    maxEnumValues: 64,
    minEnumValues: 2,
    maxDescPromptLength: 300,
    maxJevPromptLength: 1500,
    maxAgentPromptLength: 2000,
    maxParamDescriptionLength: 300,
    maxTextArgLength: 2000,
    maxAliases: 16,
    maxAliasLength: 32
});

function normalizeAlias(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\s_\-]+/g, '');
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function hashText(value) {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

class JevThirdPartyRegistry {
    constructor(options = {}) {
        this.catalogPath = options.catalogPath || DEFAULT_CATALOG_PATH;
        this.officialConfigPath = options.officialConfigPath || DEFAULT_OFFICIAL_CONFIG_PATH;
        this._catalog = options.catalog || null;
        this._officialConfig = options.officialConfig || null;
        this.entries = new Map();
        this.builtAt = null;
    }

    // ---------- 配置 ----------

    getCatalog() {
        if (!this._catalog) this._catalog = readJson(this.catalogPath);
        return this._catalog;
    }

    getOfficialConfig() {
        if (!this._officialConfig) this._officialConfig = readJson(this.officialConfigPath);
        return this._officialConfig;
    }

    reloadConfig() {
        this._catalog = null;
        this._officialConfig = null;
    }

    getLimits() {
        return { ...DEFAULT_LIMITS, ...(this.getCatalog().limits || {}) };
    }

    getOfficialPluginNames(officialConfig = this.getOfficialConfig()) {
        const names = new Set();
        for (const category of Object.values(officialConfig.categories || {})) {
            for (const tool of Object.values(category.tools || {})) {
                if (tool?.plugin) names.add(tool.plugin);
            }
        }
        return names;
    }

    /**
     * 第三方目录名/别名不得与官方目录名/别名重叠，否则 {目录} 会产生歧义。
     */
    getCatalogConflicts(officialConfig = this.getOfficialConfig()) {
        const official = new Map();
        for (const [key, category] of Object.entries(officialConfig.categories || {})) {
            for (const alias of [key, ...(category.aliases || [])]) {
                official.set(normalizeAlias(alias), key);
            }
        }
        const conflicts = [];
        for (const [key, category] of Object.entries(this.getCatalog().categories || {})) {
            for (const alias of [key, category.label, ...(category.aliases || [])]) {
                const normalized = normalizeAlias(alias);
                if (normalized && official.has(normalized)) {
                    conflicts.push({ catalogKey: key, alias, officialCategory: official.get(normalized) });
                }
            }
        }
        return conflicts;
    }

    resolveCategory(label) {
        const target = normalizeAlias(label);
        if (!target) return null;
        for (const [key, category] of Object.entries(this.getCatalog().categories || {})) {
            const aliases = [key, category.label, ...(category.aliases || [])];
            if (aliases.some(alias => normalizeAlias(alias) === target)) return key;
        }
        return null;
    }

    getCategoryLabel(key) {
        return this.getCatalog().categories?.[key]?.label || key;
    }

    // ---------- 实验开关 ----------

    isExperimentEnabled(env = process.env) {
        return String(env.JEV_THIRD_PARTY_EXP || '').trim().toLowerCase() === 'true';
    }

    /** 返回 null 表示不限制；否则为精确插件名集合。 */
    getAllowlist(env = process.env) {
        const names = String(env.JEV_THIRD_PARTY_ALLOWLIST || '')
            .split(/[,，|]/)
            .map(name => name.trim())
            .filter(Boolean);
        return names.length > 0 ? names : null;
    }

    // ---------- 声明校验 ----------

    _checkPrompt(field, value, { required, maxLength }, errors) {
        if (value === undefined || value === null || value === '') {
            if (required) errors.push(`jev.${field} 必填。`);
            return '';
        }
        if (typeof value !== 'string') {
            errors.push(`jev.${field} 必须是字符串。`);
            return '';
        }
        const text = value.trim();
        if (text.length > maxLength) {
            errors.push(`jev.${field} 超过长度上限 ${maxLength}（当前 ${text.length}）。`);
        }
        if (PROMPT_INJECTION_PATTERNS.some(re => re.test(text))) {
            errors.push(`jev.${field} 含有指令覆写、秘密读取或代码执行类内容，已拒绝。`);
        }
        return text;
    }

    _checkStringList(label, value, limits, errors) {
        if (value === undefined) return [];
        if (!Array.isArray(value) || value.length > limits.maxAliases) {
            errors.push(`${label} 必须是不超过 ${limits.maxAliases} 项的字符串数组。`);
            return [];
        }
        const result = [];
        for (const item of value) {
            if (typeof item !== 'string' || !item.trim() || item.trim().length > limits.maxAliasLength) {
                errors.push(`${label} 中存在空值、非字符串或超过 ${limits.maxAliasLength} 字符的项。`);
                continue;
            }
            result.push(item.trim());
        }
        return result;
    }

    _checkParamName(label, name, forbidden, errors) {
        if (!PARAM_NAME_RE.test(name)) {
            errors.push(`${label} 参数名 "${name}" 不合法。`);
            return false;
        }
        if (RESERVED_PARAM_NAMES.has(name.toLowerCase())) {
            errors.push(`${label} 参数名 "${name}" 为调用协议保留字段。`);
            return false;
        }
        if (forbidden.has(name.toLowerCase())) {
            errors.push(`${label} 参数名 "${name}" 属于字符级精准输入参数，此类插件暂不开放 JEV 接入。`);
            return false;
        }
        return true;
    }

    _validateParameter(label, name, spec, limits, forbidden, errors) {
        if (!this._checkParamName(label, name, forbidden, errors)) return null;
        if (!isPlainObject(spec)) {
            errors.push(`${label}.${name} 必须是对象。`);
            return null;
        }
        const type = spec.type;
        if (!PARAM_TYPES.has(type)) {
            errors.push(`${label}.${name}.type 仅支持 enum、boolean、text。`);
            return null;
        }

        const normalized = { type, required: spec.required === true };
        if (spec.required !== undefined && typeof spec.required !== 'boolean') {
            errors.push(`${label}.${name}.required 必须是布尔值。`);
        }

        const description = typeof spec.description === 'string' ? spec.description.trim() : '';
        if (spec.description !== undefined && typeof spec.description !== 'string') {
            errors.push(`${label}.${name}.description 必须是字符串。`);
        }
        if (description.length > limits.maxParamDescriptionLength) {
            errors.push(`${label}.${name}.description 超过长度上限 ${limits.maxParamDescriptionLength}。`);
        }
        // enum/boolean 可能交给 JEV 裁决，必须有参数语义说明。
        if ((type === 'enum' || type === 'boolean') && !description) {
            errors.push(`${label}.${name} 为 ${type} 类型，必须提供 description 供 JEV 裁决。`);
        }
        normalized.description = description;
        normalized.prefixes = this._checkStringList(`${label}.${name}.prefixes`, spec.prefixes, limits, errors);

        if (type === 'enum') {
            const values = spec.values;
            const keys = isPlainObject(values) ? Object.keys(values) : [];
            if (keys.length < limits.minEnumValues || keys.length > limits.maxEnumValues) {
                errors.push(`${label}.${name}.values 必须是包含 ${limits.minEnumValues}~${limits.maxEnumValues} 个选项的对象。`);
                return null;
            }
            normalized.values = {};
            for (const key of keys) {
                if (!ENUM_KEY_RE.test(key)) {
                    errors.push(`${label}.${name}.values 的键 "${key}" 不合法。`);
                    continue;
                }
                if (typeof values[key] !== 'string' || !values[key].trim()) {
                    errors.push(`${label}.${name}.values.${key} 必须是非空说明文本。`);
                    continue;
                }
                normalized.values[key] = values[key].trim();
            }
            normalized.aliases = {};
            if (spec.aliases !== undefined) {
                if (!isPlainObject(spec.aliases)) {
                    errors.push(`${label}.${name}.aliases 必须是对象。`);
                } else {
                    for (const [key, list] of Object.entries(spec.aliases)) {
                        if (!Object.prototype.hasOwnProperty.call(normalized.values, key)) {
                            errors.push(`${label}.${name}.aliases 引用了不存在的选项 "${key}"。`);
                            continue;
                        }
                        normalized.aliases[key] = this._checkStringList(`${label}.${name}.aliases.${key}`, list, limits, errors);
                    }
                }
            }
            if (spec.default !== undefined) {
                if (!Object.prototype.hasOwnProperty.call(normalized.values, spec.default)) {
                    errors.push(`${label}.${name}.default 必须是 values 中的选项。`);
                } else {
                    normalized.default = spec.default;
                }
            }
        } else if (type === 'boolean') {
            normalized.trueAliases = this._checkStringList(`${label}.${name}.trueAliases`, spec.trueAliases, limits, errors);
            normalized.falseAliases = this._checkStringList(`${label}.${name}.falseAliases`, spec.falseAliases, limits, errors);
            if (spec.default !== undefined) {
                if (typeof spec.default !== 'boolean') errors.push(`${label}.${name}.default 必须是布尔值。`);
                else normalized.default = spec.default;
            }
        } else {
            if (!TEXT_SOURCES.has(spec.source)) {
                errors.push(`${label}.${name}.source 仅支持 primary、constraints、url。`);
                return null;
            }
            normalized.source = spec.source;
            if (spec.source !== 'constraints' && normalized.prefixes.length > 0) {
                errors.push(`${label}.${name}.prefixes 仅适用于 source=constraints。`);
            }
            let maxLength = limits.maxTextArgLength;
            if (spec.maxLength !== undefined) {
                if (!Number.isInteger(spec.maxLength) || spec.maxLength <= 0 || spec.maxLength > limits.maxTextArgLength) {
                    errors.push(`${label}.${name}.maxLength 必须是 1~${limits.maxTextArgLength} 的整数。`);
                } else {
                    maxLength = spec.maxLength;
                }
            }
            normalized.maxLength = maxLength;
            if (spec.default !== undefined) {
                errors.push(`${label}.${name} 为 text 类型，不支持 default（文本只能来自用户原文）。`);
            }
        }
        return normalized;
    }

    _validateCommand(index, cmd, invocationIds, limits, forbidden, errors) {
        const label = `jev.commands[${index}]`;
        if (!isPlainObject(cmd)) {
            errors.push(`${label} 必须是对象。`);
            return null;
        }
        const id = cmd.commandIdentifier;
        if (typeof id !== 'string' || !invocationIds.has(id)) {
            errors.push(`${label}.commandIdentifier "${id}" 必须与 capabilities.invocationCommands 中的命令完全一致。`);
            return null;
        }

        const normalized = {
            commandIdentifier: id,
            description: '',
            aliases: this._checkStringList(`${label}.aliases`, cmd.aliases, limits, errors),
            injectCommand: cmd.injectCommand !== false,
            fixedArgs: {},
            parameters: {}
        };
        if (cmd.injectCommand !== undefined && typeof cmd.injectCommand !== 'boolean') {
            errors.push(`${label}.injectCommand 必须是布尔值。`);
        }
        if (cmd.description !== undefined) {
            if (typeof cmd.description !== 'string') errors.push(`${label}.description 必须是字符串。`);
            else if (cmd.description.trim().length > limits.maxParamDescriptionLength) {
                errors.push(`${label}.description 超过长度上限 ${limits.maxParamDescriptionLength}。`);
            } else normalized.description = cmd.description.trim();
        }

        if (cmd.fixedArgs !== undefined) {
            if (!isPlainObject(cmd.fixedArgs)) {
                errors.push(`${label}.fixedArgs 必须是对象。`);
            } else {
                for (const [key, value] of Object.entries(cmd.fixedArgs)) {
                    if (!this._checkParamName(`${label}.fixedArgs`, key, forbidden, errors)) continue;
                    if (!['string', 'number', 'boolean'].includes(typeof value)) {
                        errors.push(`${label}.fixedArgs.${key} 只能是字符串、数字或布尔值。`);
                        continue;
                    }
                    normalized.fixedArgs[key] = String(value);
                }
            }
        }

        if (cmd.parameters !== undefined) {
            if (!isPlainObject(cmd.parameters)) {
                errors.push(`${label}.parameters 必须是对象。`);
            } else {
                const entries = Object.entries(cmd.parameters);
                if (entries.length > limits.maxParametersPerCommand) {
                    errors.push(`${label}.parameters 超过 ${limits.maxParametersPerCommand} 个。`);
                }
                for (const [name, spec] of entries) {
                    if (Object.prototype.hasOwnProperty.call(normalized.fixedArgs, name)) {
                        errors.push(`${label} 参数 "${name}" 同时出现在 fixedArgs 与 parameters 中。`);
                        continue;
                    }
                    const param = this._validateParameter(`${label}.parameters`, name, spec, limits, forbidden, errors);
                    if (param) normalized.parameters[name] = param;
                }
            }
        }
        return normalized;
    }

    /**
     * 校验单个 manifest 的 jev 声明并生成注册表条目。不会抛出异常。
     * @param {object} manifest
     * @param {{enabled?: boolean, origin?: string, serverId?: string|null, manifestFile?: string|null}} context
     */
    validateDeclaration(manifest, context = {}) {
        const errors = [];
        const warnings = [];
        const catalog = this.getCatalog();
        const limits = this.getLimits();
        const forbidden = new Set((catalog.forbiddenParameterNames || []).map(name => String(name).toLowerCase()));
        const denyPlugins = new Set(catalog.denyPlugins || []);
        const jev = manifest?.jev;
        const name = manifest?.name;

        if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) {
            errors.push(`manifest.name "${name}" 不是合法的精确工具名（字母开头，仅含字母、数字、下划线、连字符）。`);
        }
        if (denyPlugins.has(name)) {
            errors.push(`插件 ${name} 属于系统维护/文件/代码/命令行类插件，暂不开放 JEV 接入。`);
        }
        if (manifest?.requiresAdmin) {
            errors.push('requiresAdmin 插件需要精确授权，暂不开放 JEV 接入。');
        }
        if (!CALLABLE_PLUGIN_TYPES.has(manifest?.pluginType)) {
            errors.push(`pluginType "${manifest?.pluginType}" 不是可调用工具类型（仅支持 synchronous、asynchronous、hybridservice）。`);
        }
        if (this.getOfficialPluginNames().has(name)) {
            errors.push(`插件 ${name} 已由官方 JEV 配置集中管理，不能再注册第三方声明。`);
        }

        const entry = {
            pluginName: typeof name === 'string' ? name : null,
            toolName: typeof name === 'string' ? name : null,
            displayName: manifest?.displayName || name || null,
            version: manifest?.version || null,
            pluginType: manifest?.pluginType || null,
            origin: context.origin || (manifest?.isDistributed ? 'cloud' : 'local'),
            serverId: context.serverId ?? manifest?.serverId ?? null,
            pluginEnabled: context.enabled !== false,
            jevEnabled: false,
            schemaVersion: null,
            category: null,
            categoryLabel: null,
            jevDescPrompt: '',
            jevPrompt: '',
            agentPrompt: '',
            commands: [],
            defaultCommand: null,
            callTemplate: null,
            promptHash: null,
            source: {
                manifestFile: context.manifestFile || null,
                collectedAt: new Date().toISOString()
            },
            validation: { status: 'invalid', errors, warnings }
        };

        if (!isPlainObject(jev)) {
            errors.push('jev 字段必须是对象。');
            return entry;
        }

        entry.jevEnabled = jev.enabled === true;
        entry.schemaVersion = jev.schemaVersion ?? null;
        if (jev.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
            errors.push(`jev.schemaVersion 必须为 ${SUPPORTED_SCHEMA_VERSION}。`);
        }
        if (typeof jev.enabled !== 'boolean') {
            errors.push('jev.enabled 必须是布尔值。');
        }

        const categoryKey = typeof jev.category === 'string' ? this.resolveCategory(jev.category) : null;
        if (!categoryKey) {
            const labels = Object.values(catalog.categories || {}).map(item => item.label).join('、');
            errors.push(`jev.category "${jev.category}" 不在官方第三方能力目录中，可选：${labels}。`);
        } else {
            entry.category = categoryKey;
            entry.categoryLabel = this.getCategoryLabel(categoryKey);
        }

        entry.jevDescPrompt = this._checkPrompt('jevDescPrompt', jev.jevDescPrompt, { required: true, maxLength: limits.maxDescPromptLength }, errors);
        entry.jevPrompt = this._checkPrompt('jevPrompt', jev.jevPrompt, { required: true, maxLength: limits.maxJevPromptLength }, errors);
        entry.agentPrompt = this._checkPrompt('agentPrompt', jev.agentPrompt, { required: false, maxLength: limits.maxAgentPromptLength }, errors);

        const invocationIds = new Set(
            (manifest?.capabilities?.invocationCommands || [])
                .map(cmd => cmd?.commandIdentifier || cmd?.command)
                .filter(Boolean)
        );
        if (invocationIds.size === 0) {
            errors.push('插件没有 capabilities.invocationCommands，无法作为 JEV 目标。');
        }

        if (!Array.isArray(jev.commands) || jev.commands.length === 0 || jev.commands.length > limits.maxCommands) {
            errors.push(`jev.commands 必须是 1~${limits.maxCommands} 项的数组。`);
        } else {
            const seen = new Set();
            jev.commands.forEach((cmd, index) => {
                const normalized = this._validateCommand(index, cmd, invocationIds, limits, forbidden, errors);
                if (!normalized) return;
                if (seen.has(normalized.commandIdentifier)) {
                    errors.push(`jev.commands 中命令 "${normalized.commandIdentifier}" 重复。`);
                    return;
                }
                seen.add(normalized.commandIdentifier);
                if (Object.keys(normalized.parameters).length === 0 && Object.keys(normalized.fixedArgs).length === 0) {
                    warnings.push(`命令 ${normalized.commandIdentifier} 没有声明参数，JEV 只能做命令选择。`);
                }
                entry.commands.push(normalized);
            });
        }

        if (jev.defaultCommand !== undefined) {
            if (!entry.commands.some(cmd => cmd.commandIdentifier === jev.defaultCommand)) {
                errors.push('jev.defaultCommand 必须是 jev.commands 中的命令。');
            } else {
                entry.defaultCommand = jev.defaultCommand;
            }
        }

        if (entry.categoryLabel && entry.toolName) {
            entry.callTemplate = `{${entry.categoryLabel}} \`${entry.toolName}\` 【主要内容】[约束]`;
        }
        entry.promptHash = hashText(JSON.stringify({
            jevDescPrompt: entry.jevDescPrompt,
            jevPrompt: entry.jevPrompt,
            agentPrompt: entry.agentPrompt,
            commands: entry.commands
        }));
        entry.validation.status = errors.length > 0 ? 'invalid' : 'valid';
        return entry;
    }

    // ---------- 注册表 ----------

    /**
     * @param {Array<{manifest: object, enabled?: boolean, origin?: string, serverId?: string|null, manifestFile?: string|null}>} items
     *        启用插件应排在禁用插件之前；同名条目先到先得。
     */
    build(items = []) {
        const entries = new Map();
        for (const item of items) {
            const manifest = item?.manifest;
            if (!manifest || manifest.jev === undefined) continue;
            // 只有显式 enabled:true 才进入注册表；未声明或 false 的插件不参与 JEV。
            if (!isPlainObject(manifest.jev) || manifest.jev.enabled !== true) continue;
            if (typeof manifest.name === 'string' && entries.has(manifest.name)) continue;

            let entry;
            try {
                entry = this.validateDeclaration(manifest, item);
            } catch (error) {
                entry = {
                    pluginName: manifest.name || null,
                    toolName: manifest.name || null,
                    pluginEnabled: item.enabled !== false,
                    validation: { status: 'invalid', errors: [`校验异常: ${error.message}`], warnings: [] }
                };
            }
            const key = entry.pluginName || `__invalid_${entries.size}`;
            entries.set(key, entry);
        }
        this.entries = entries;
        this.builtAt = new Date().toISOString();
        return this.getSnapshot();
    }

    /** 精确、大小写敏感查找，不做任何别名或模糊匹配。 */
    getEntry(toolName) {
        return this.entries.get(toolName) || null;
    }

    getRunnableEntry(toolName) {
        const entry = this.getEntry(toolName);
        if (!entry || entry.validation?.status !== 'valid' || entry.pluginEnabled !== true) return null;
        return entry;
    }

    listEntries() {
        return Array.from(this.entries.values());
    }

    getSnapshot(env = process.env) {
        const entries = this.listEntries();
        let catalogConflicts = [];
        let catalogError = null;
        try {
            catalogConflicts = this.getCatalogConflicts();
        } catch (error) {
            catalogError = error.message;
        }
        return {
            builtAt: this.builtAt,
            experiment: {
                enabled: this.isExperimentEnabled(env),
                allowlist: this.getAllowlist(env)
            },
            catalogConflicts,
            catalogError,
            total: entries.length,
            validCount: entries.filter(entry => entry.validation?.status === 'valid').length,
            invalidCount: entries.filter(entry => entry.validation?.status !== 'valid').length,
            entries
        };
    }
}

const jevThirdPartyRegistry = new JevThirdPartyRegistry();

module.exports = jevThirdPartyRegistry;
module.exports.JevThirdPartyRegistry = JevThirdPartyRegistry;
module.exports.normalizeAlias = normalizeAlias;