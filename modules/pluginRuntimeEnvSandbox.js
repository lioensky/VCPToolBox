'use strict';

const DEFAULT_EXTERNAL_RUNTIME_ENV_KEYS = new Set([
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'TEMP',
    'TMP',
    'TMPDIR',
    'SystemRoot',
    'windir',
    'ComSpec',
    'NO_COLOR',
    'CI'
]);

const EXTERNAL_RUNTIME_ADDITIONAL_ENV_KEYS = new Set([
    'PROJECT_BASE_PATH',
    'VCP_REQUEST_IP',
    'VCP_REQUEST_SOURCE',
    'VCP_AGENT_ALIAS',
    'VCP_AGENT_ID',
    'VCP_EXECUTION_CONTEXT',
    'SERVER_PORT',
    'PYTHONIOENCODING',
    'CALLBACK_BASE_URL',
    'CALLBACK_AUTH_SECRET',
    'PLUGIN_CALLBACK_URL',
    'PLUGIN_NAME_FOR_CALLBACK'
]);

const EXTERNAL_RUNTIME_SENSITIVE_ADDITIONAL_ENV_KEYS = new Set([
    'CALLBACK_AUTH_SECRET'
]);

const PLUGIN_RUNTIME_ENV_DENY_PATTERNS = [
    /admin.*pass/i,
    /password|passwd|pwd/i,
    /secret/i,
    /token/i,
    /api[_-]?key|apikey/i,
    /authorization|bearer/i,
    /cookie|session/i,
    /credential/i,
    /private[_-]?key/i,
    /github_token|gh_token/i,
    /openai|anthropic|gemini|google|azure|aws|s3|slack|discord|telegram|dingtalk|feishu|wecom/i,
    /decrypted[_-]?auth[_-]?code/i,
    /(^|[_-])key($|[_-])/i
];

function isPluginRuntimeEnvKeyDenied(key) {
    return PLUGIN_RUNTIME_ENV_DENY_PATTERNS.some(pattern => pattern.test(String(key || '')));
}

function copyStringValue(target, key, value) {
    if (value === undefined || value === null) return;
    target[key] = String(value);
}

function buildExternalPluginRuntimeEnv(baseEnv = {}, pluginConfig = {}, additionalEnv = {}) {
    const env = {};

    for (const key of DEFAULT_EXTERNAL_RUNTIME_ENV_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(baseEnv, key)) continue;
        if (isPluginRuntimeEnvKeyDenied(key)) continue;
        copyStringValue(env, key, baseEnv[key]);
    }

    for (const [key, value] of Object.entries(pluginConfig || {})) {
        if (isPluginRuntimeEnvKeyDenied(key)) continue;
        copyStringValue(env, key, value);
    }

    for (const [key, value] of Object.entries(additionalEnv || {})) {
        if (!EXTERNAL_RUNTIME_ADDITIONAL_ENV_KEYS.has(key)) continue;
        if (isPluginRuntimeEnvKeyDenied(key) && !EXTERNAL_RUNTIME_SENSITIVE_ADDITIONAL_ENV_KEYS.has(key)) continue;
        copyStringValue(env, key, value);
    }

    return env;
}

module.exports = {
    DEFAULT_EXTERNAL_RUNTIME_ENV_KEYS,
    EXTERNAL_RUNTIME_ADDITIONAL_ENV_KEYS,
    isPluginRuntimeEnvKeyDenied,
    buildExternalPluginRuntimeEnv
};
