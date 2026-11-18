const DEFAULT_CONFIG = {
    enabled: false,
    mask: '[VCP_PRIVACY_REDACTED]',
    maxDepth: 20,
    preservePrefix: 4,
    preserveSuffix: 4,
    minSecretLength: 8,
    minHighEntropyLength: 32
};

const SENSITIVE_KEY_PATTERN = /(?:^|[_\-\s.])(?:api[_\-\s]?key|apikey|secret|token|access[_\-\s]?token|refresh[_\-\s]?token|auth[_\-\s]?token|bearer|password|passwd|pwd|credential|credentials|private[_\-\s]?key|client[_\-\s]?secret|webhook[_\-\s]?secret)(?:$|[_\-\s.])/i;

const ENV_ASSIGNMENT_PATTERN = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*)(["']?)([^\r\n]*?)(\2)(\s*(?:#.*)?$)/;
const DATA_BASE64_URI_PATTERN = /\bdata:[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*(?:;[A-Za-z0-9.+-]+=[A-Za-z0-9.+/_-]+)*;base64,[A-Za-z0-9+/=\r\n]+/gi;
const DATA_BASE64_URI_FULL_PATTERN = /^data:[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*(?:;[A-Za-z0-9.+-]+=[A-Za-z0-9.+/_-]+)*;base64,[A-Za-z0-9+/=\r\n]+$/i;

const HIGH_CONFIDENCE_TOKEN_PATTERNS = [
    /\bsk-[A-Za-z0-9_-]{24,}\b/g,
    /\bsk-proj-[A-Za-z0-9_-]{24,}\b/g,
    /\b(?:xoxb|xoxp|xoxa|xoxr)-[A-Za-z0-9-]{24,}\b/g,
    /\bghp_[A-Za-z0-9_]{30,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
    /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g
];

function normalizeConfig(config = {}) {
    const privacyConfig = config && typeof config === 'object'
        ? (config.privacyProtection || config.toolResultPrivacyProtection || config)
        : {};

    return {
        enabled: privacyConfig.enabled === true,
        mask: typeof privacyConfig.mask === 'string' && privacyConfig.mask
            ? privacyConfig.mask
            : DEFAULT_CONFIG.mask,
        maxDepth: Number.isFinite(Number(privacyConfig.maxDepth))
            ? Math.max(1, Math.min(100, Number(privacyConfig.maxDepth)))
            : DEFAULT_CONFIG.maxDepth,
        preservePrefix: Number.isFinite(Number(privacyConfig.preservePrefix))
            ? Math.max(0, Math.min(16, Number(privacyConfig.preservePrefix)))
            : DEFAULT_CONFIG.preservePrefix,
        preserveSuffix: Number.isFinite(Number(privacyConfig.preserveSuffix))
            ? Math.max(0, Math.min(16, Number(privacyConfig.preserveSuffix)))
            : DEFAULT_CONFIG.preserveSuffix,
        minSecretLength: Number.isFinite(Number(privacyConfig.minSecretLength))
            ? Math.max(4, Number(privacyConfig.minSecretLength))
            : DEFAULT_CONFIG.minSecretLength,
        minHighEntropyLength: Number.isFinite(Number(privacyConfig.minHighEntropyLength))
            ? Math.max(16, Number(privacyConfig.minHighEntropyLength))
            : DEFAULT_CONFIG.minHighEntropyLength
    };
}

function isSensitiveKey(key) {
    return typeof key === 'string' && SENSITIVE_KEY_PATTERN.test(key);
}

function isDataBase64Uri(value) {
    return typeof value === 'string' && DATA_BASE64_URI_FULL_PATTERN.test(value.trim());
}

function shouldMaskValue(value, config) {
    if (value === null || value === undefined) return false;
    const text = String(value);
    const trimmed = text.trim();

    if (trimmed.length < config.minSecretLength) return false;
    if (/^(?:true|false|null|undefined)$/i.test(trimmed)) return false;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return false;
    if (isDataBase64Uri(trimmed)) return false;

    return true;
}

function maskSecret(value, config) {
    const text = String(value);
    const quoteMatch = text.match(/^(\s*["']?)([\s\S]*?)(["']?\s*)$/);
    const prefix = quoteMatch ? quoteMatch[1] : '';
    const core = quoteMatch ? quoteMatch[2] : text;
    const suffix = quoteMatch ? quoteMatch[3] : '';

    if (!core || core.length <= config.preservePrefix + config.preserveSuffix + 4) {
        return `${prefix}${config.mask}${suffix}`;
    }

    const visiblePrefix = core.slice(0, config.preservePrefix);
    const visibleSuffix = core.slice(-config.preserveSuffix);
    return `${prefix}${visiblePrefix}${config.mask}${visibleSuffix}${suffix}`;
}

function maskHighConfidenceTokens(text, config) {
    let result = text;
    for (const pattern of HIGH_CONFIDENCE_TOKEN_PATTERNS) {
        result = result.replace(pattern, (match) => maskSecret(match, config));
    }
    return result;
}

function maskHighConfidenceTokensPreservingDataBase64(text, config) {
    DATA_BASE64_URI_PATTERN.lastIndex = 0;
    const preservedDataUris = [];
    const placeholderPrefix = `__VCP_DATA_BASE64_${Date.now()}_${Math.random().toString(36).slice(2)}_`;
    const protectedText = text.replace(DATA_BASE64_URI_PATTERN, (match) => {
        const index = preservedDataUris.push(match) - 1;
        return `${placeholderPrefix}${index}__`;
    });

    let result = maskHighConfidenceTokens(protectedText, config);
    for (let i = 0; i < preservedDataUris.length; i++) {
        result = result.split(`${placeholderPrefix}${i}__`).join(preservedDataUris[i]);
    }
    return result;
}

function maskEnvAssignmentLine(line, config) {
    const match = line.match(ENV_ASSIGNMENT_PATTERN);
    if (!match) return line;

    const [, left, quote, rawValue, closingQuote, trailing] = match;
    const key = left.split('=')[0].replace(/^\s*export\s+/i, '').trim();

    if (!isSensitiveKey(key) || !shouldMaskValue(rawValue, config)) {
        return line;
    }

    return `${left}${quote}${maskSecret(rawValue, config)}${closingQuote}${trailing}`;
}

function maskString(text, config) {
    if (typeof text !== 'string' || text.length === 0) {
        return text;
    }

    const lineMasked = text
        .split(/(\r?\n)/)
        .map(part => (part === '\n' || part === '\r\n') ? part : maskEnvAssignmentLine(part, config))
        .join('');

    return maskHighConfidenceTokensPreservingDataBase64(lineMasked, config);
}

function sanitizeValue(value, config, depth, seen, keyHint = '') {
    if (depth > config.maxDepth) {
        return value;
    }

    if (typeof value === 'string') {
        if (isSensitiveKey(keyHint) && shouldMaskValue(value, config)) {
            return maskSecret(value, config);
        }
        return maskString(value, config);
    }

    if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
        return value;
    }

    if (Buffer.isBuffer(value)) {
        return value;
    }

    if (Array.isArray(value)) {
        if (seen.has(value)) return value;
        seen.add(value);
        return value.map(item => sanitizeValue(item, config, depth + 1, seen));
    }

    if (typeof value === 'object') {
        if (seen.has(value)) return value;
        seen.add(value);

        const sanitized = {};
        for (const [key, child] of Object.entries(value)) {
            if (isSensitiveKey(key) && shouldMaskValue(child, config)) {
                sanitized[key] = maskSecret(child, config);
            } else {
                sanitized[key] = sanitizeValue(child, config, depth + 1, seen, key);
            }
        }
        return sanitized;
    }

    return value;
}

function sanitizeToolResult(result, rawConfig = {}) {
    const config = normalizeConfig(rawConfig);
    if (!config.enabled) {
        return result;
    }

    return sanitizeValue(result, config, 0, new WeakSet());
}

module.exports = {
    DEFAULT_CONFIG,
    sanitizeToolResult,
    normalizeConfig,
    isSensitiveKey,
    isDataBase64Uri,
    maskString
};