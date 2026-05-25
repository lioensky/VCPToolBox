'use strict';

const DEFAULT_TOOL_APPROVAL_CONFIG = Object.freeze({
    enabled: false,
    timeoutMinutes: 5,
    approveAll: false,
    approvalList: [],
    debugMode: false,
    fuzzyToolMatching: false
});

const SUPPORTED_TOOL_APPROVAL_KEYS = Object.freeze([
    'enabled',
    'approveAll',
    'debugMode',
    'fuzzyToolMatching',
    'timeoutMinutes',
    'timeout',
    'approvalList',
    'toolList'
]);

function cloneDefaultConfig() {
    return {
        enabled: DEFAULT_TOOL_APPROVAL_CONFIG.enabled,
        timeoutMinutes: DEFAULT_TOOL_APPROVAL_CONFIG.timeoutMinutes,
        approveAll: DEFAULT_TOOL_APPROVAL_CONFIG.approveAll,
        approvalList: [...DEFAULT_TOOL_APPROVAL_CONFIG.approvalList],
        debugMode: DEFAULT_TOOL_APPROVAL_CONFIG.debugMode,
        fuzzyToolMatching: DEFAULT_TOOL_APPROVAL_CONFIG.fuzzyToolMatching
    };
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRuleList(list) {
    if (!Array.isArray(list)) {
        return [];
    }

    return list
        .filter((entry) => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function normalizeToolApprovalConfig(rawConfig = {}) {
    const normalized = cloneDefaultConfig();

    if (!isPlainObject(rawConfig)) {
        return normalized;
    }

    if (typeof rawConfig.enabled === 'boolean') {
        normalized.enabled = rawConfig.enabled;
    }

    if (typeof rawConfig.approveAll === 'boolean') {
        normalized.approveAll = rawConfig.approveAll;
    }

    if (typeof rawConfig.debugMode === 'boolean') {
        normalized.debugMode = rawConfig.debugMode;
    }

    if (typeof rawConfig.fuzzyToolMatching === 'boolean') {
        normalized.fuzzyToolMatching = rawConfig.fuzzyToolMatching;
    }

    const timeoutCandidate = rawConfig.timeoutMinutes ?? rawConfig.timeout;
    if (Number.isFinite(timeoutCandidate) && timeoutCandidate > 0) {
        normalized.timeoutMinutes = Math.max(1, Math.floor(timeoutCandidate));
    }

    normalized.approvalList = normalizeRuleList(
        rawConfig.approvalList ?? rawConfig.toolList
    );

    return normalized;
}

function validateToolApprovalConfig(rawConfig) {
    const errors = [];

    if (!isPlainObject(rawConfig)) {
        return {
            valid: false,
            errors: ['config must be an object']
        };
    }

    const keys = Object.keys(rawConfig);
    const unknownKeys = keys.filter((key) => !SUPPORTED_TOOL_APPROVAL_KEYS.includes(key));
    if (unknownKeys.length > 0) {
        errors.push(`unknown config keys: ${unknownKeys.join(', ')}`);
    }

    const hasSupportedKey = keys.some((key) => SUPPORTED_TOOL_APPROVAL_KEYS.includes(key));
    if (!hasSupportedKey) {
        errors.push('config must include at least one supported field');
    }

    if (
        Object.prototype.hasOwnProperty.call(rawConfig, 'enabled') &&
        typeof rawConfig.enabled !== 'boolean'
    ) {
        errors.push('enabled must be a boolean');
    }

    if (
        Object.prototype.hasOwnProperty.call(rawConfig, 'approveAll') &&
        typeof rawConfig.approveAll !== 'boolean'
    ) {
        errors.push('approveAll must be a boolean');
    }

    if (
        Object.prototype.hasOwnProperty.call(rawConfig, 'debugMode') &&
        typeof rawConfig.debugMode !== 'boolean'
    ) {
        errors.push('debugMode must be a boolean');
    }

    if (
        Object.prototype.hasOwnProperty.call(rawConfig, 'fuzzyToolMatching') &&
        typeof rawConfig.fuzzyToolMatching !== 'boolean'
    ) {
        errors.push('fuzzyToolMatching must be a boolean');
    }

    const timeoutKey = Object.prototype.hasOwnProperty.call(rawConfig, 'timeoutMinutes')
        ? 'timeoutMinutes'
        : (Object.prototype.hasOwnProperty.call(rawConfig, 'timeout') ? 'timeout' : null);
    if (timeoutKey) {
        const timeoutValue = rawConfig[timeoutKey];
        if (!Number.isFinite(timeoutValue) || timeoutValue <= 0) {
            errors.push(`${timeoutKey} must be a positive number`);
        }
    }

    const approvalListKey = Object.prototype.hasOwnProperty.call(rawConfig, 'approvalList')
        ? 'approvalList'
        : (Object.prototype.hasOwnProperty.call(rawConfig, 'toolList') ? 'toolList' : null);
    if (approvalListKey) {
        const listValue = rawConfig[approvalListKey];
        if (!Array.isArray(listValue)) {
            errors.push(`${approvalListKey} must be an array of non-empty strings`);
        } else {
            const invalidEntry = listValue.find((entry) => (
                typeof entry !== 'string' || !entry.trim()
            ));
            if (typeof invalidEntry !== 'undefined') {
                errors.push(`${approvalListKey} must contain only non-empty strings`);
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

module.exports = {
    DEFAULT_TOOL_APPROVAL_CONFIG,
    SUPPORTED_TOOL_APPROVAL_KEYS,
    normalizeToolApprovalConfig,
    validateToolApprovalConfig
};
