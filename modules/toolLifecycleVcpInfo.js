const crypto = require('crypto');

const SUPPORTED_PHASES = new Set(['start', 'success', 'error', 'timeout']);
const DEFAULT_EVENT_TYPE = 'TOOL_LIFECYCLE';

function getCaseInsensitiveValue(object, key) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) {
        return undefined;
    }

    if (Object.prototype.hasOwnProperty.call(object, key)) {
        return object[key];
    }

    const normalizedKey = String(key).toLowerCase();
    for (const [candidateKey, value] of Object.entries(object)) {
        if (candidateKey.toLowerCase() === normalizedKey) {
            return value;
        }
    }

    return undefined;
}
function getSingleTemplateValue(expression, context) {
    const normalizedExpression = String(expression || '').trim();
    if (!normalizedExpression) return '';

    if (normalizedExpression.startsWith('args.')) {
        return getCaseInsensitiveValue(context.args, normalizedExpression.slice(5));
    }

    if (normalizedExpression.startsWith('plugin.')) {
        return getCaseInsensitiveValue(context.plugin, normalizedExpression.slice(7));
    }

    if (normalizedExpression.startsWith('pluginConfig.')) {
        return getCaseInsensitiveValue(context.pluginConfig, normalizedExpression.slice(13));
    }

    if (normalizedExpression.startsWith('result.')) {
        return getCaseInsensitiveValue(context.result, normalizedExpression.slice(7));
    }

    if (normalizedExpression.startsWith('error.')) {
        return getCaseInsensitiveValue(context.error, normalizedExpression.slice(6));
    }

    return getCaseInsensitiveValue(context, normalizedExpression);
}

function getTemplateValue(expression, context) {
    const candidates = String(expression || '')
        .split('|')
        .map(item => item.trim())
        .filter(Boolean);

    for (const candidate of candidates) {
        const value = getSingleTemplateValue(candidate, context);
        if (value !== undefined && value !== null && value !== '') {
            return value;
        }
    }

    return '';
}

function renderTemplate(template, context) {
    if (typeof template !== 'string') return template;

    return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, expression) => {
        const value = getTemplateValue(expression, context);
        if (value === undefined || value === null) return '';
        if (typeof value === 'object') {
            try {
                return JSON.stringify(value);
            } catch (_) {
                return String(value);
            }
        }
        return String(value);
    });
}

function renderValue(value, context, depth = 0) {
    if (depth > 8) return null;
    if (typeof value === 'string') return renderTemplate(value, context);
    if (Array.isArray(value)) {
        return value.map(item => renderValue(item, context, depth + 1));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
                key,
                renderValue(item, context, depth + 1)
            ])
        );
    }
    return value;
}

function createInvocationId(pluginName) {
    const randomPart = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString('hex');
    return `tool-${String(pluginName || 'unknown')}-${Date.now()}-${randomPart}`;
}

function normalizeError(error) {
    if (!error) return null;
    return {
        name: error.name || 'Error',
        code: error.code || null,
        message: error.message || String(error)
    };
}

function isTimeoutError(error) {
    const code = String(error?.code || '').toUpperCase();
    if (code.includes('TIMEOUT')) return true;

    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('timed out') ||
        message.includes('timeout') ||
        message.includes('超时') ||
        message.includes('timed out or was killed');
}

class ToolLifecycleVcpInfo {
    constructor(options = {}) {
        this.pushVcpInfo = typeof options.pushVcpInfo === 'function'
            ? options.pushVcpInfo
            : () => {};
        this.debugMode = options.debugMode === true;
    }

    setPushVcpInfo(pushVcpInfo) {
        this.pushVcpInfo = typeof pushVcpInfo === 'function'
            ? pushVcpInfo
            : () => {};
    }

    createContext(plugin, args = {}, metadata = {}) {
        const now = Date.now();
        return {
            invocationId: createInvocationId(plugin?.name),
            plugin,
            pluginConfig: metadata.pluginConfig || {},
            args,
            requestIp: metadata.requestIp || null,
            sourceNode: metadata.sourceNode || null,
            startedAtMs: now,
            startedAt: new Date(now).toISOString()
        };
    }

    emit(context, requestedPhase, details = {}) {
        if (!context?.plugin || !SUPPORTED_PHASES.has(requestedPhase)) {
            return false;
        }

        const lifecycleConfig = context.plugin.vcpInfoLifecycle;
        if (!lifecycleConfig || lifecycleConfig.enabled === false) {
            return false;
        }

        // Manifest 负责注册能力，插件 config.env 负责让最终用户开关它。
        // 配置键未设置时，由 enabledByDefault 决定；避免 configSchema 的
        // 描述性 default 字段被误认为运行时已经自动注入。
        if (lifecycleConfig.enabledConfigKey) {
            const configuredValue = getCaseInsensitiveValue(
                context.pluginConfig,
                lifecycleConfig.enabledConfigKey
            );
            const enabled = configuredValue === undefined
                ? lifecycleConfig.enabledByDefault === true
                : configuredValue === true || String(configuredValue).toLowerCase() === 'true';
            if (!enabled) return false;
        }

        let phase = requestedPhase;
        if (requestedPhase === 'error' && isTimeoutError(details.error)) {
            phase = 'timeout';
        }

        const eventConfig = lifecycleConfig[phase];
        if (!eventConfig || eventConfig.enabled === false) {
            return false;
        }

        const now = Date.now();
        const normalizedError = normalizeError(details.error);
        const templateContext = {
            invocationId: context.invocationId,
            phase,
            plugin: context.plugin,
            pluginConfig: context.pluginConfig,
            args: context.args,
            result: details.result,
            error: normalizedError,
            requestIp: context.requestIp,
            sourceNode: context.sourceNode,
            startedAt: context.startedAt,
            timestamp: new Date(now).toISOString(),
            durationMs: now - context.startedAtMs,
            elapsedMs: now - context.startedAtMs
        };

        const payload = {
            type: eventConfig.type || lifecycleConfig.type || DEFAULT_EVENT_TYPE,
            source: context.plugin.name,
            toolName: context.plugin.name,
            pluginDisplayName: context.plugin.displayName || context.plugin.name,
            invocationId: context.invocationId,
            phase,
            status: phase === 'success'
                ? 'success'
                : (phase === 'start' ? 'running' : 'error'),
            message: renderTemplate(eventConfig.message || '', templateContext),
            startedAt: context.startedAt,
            timestamp: templateContext.timestamp,
            elapsedMs: templateContext.elapsedMs,
            ...(eventConfig.data && typeof eventConfig.data === 'object'
                ? renderValue(eventConfig.data, templateContext)
                : {})
        };

        if (normalizedError && eventConfig.includeError === true) {
            payload.error = normalizedError;
        }

        try {
            this.pushVcpInfo(payload);
            return true;
        } catch (error) {
            console.error(
                `[ToolLifecycleVcpInfo] Failed to broadcast ${context.plugin.name}/${phase}: ${error.message}`
            );
            return false;
        }
    }
}

module.exports = {
    ToolLifecycleVcpInfo,
    renderTemplate,
    isTimeoutError
};