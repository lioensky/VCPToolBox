'use strict';

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const PROVIDER_DEFAULTS = Object.freeze({
    typesafe: Object.freeze({
        url: 'https://api.typesafe.ai/v1/systemone',
        model: 'jev-latest'
    }),
    openrouter: Object.freeze({
        url: 'https://openrouter.ai/api/alpha/decisions',
        model: '~typesafe/jev-latest'
    })
});

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 529]);
const QUESTION_TYPES = new Set(['noul', 'choice', 'score']);

function parsePositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
}

function parseNonNegativeInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Math.min(parsed, max);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseApiKeys(value) {
    const seen = new Set();
    return String(value || '')
        .split(/[,，|]/)
        .map(key => key.trim())
        .filter(key => {
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

class JevClientError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'JevClientError';
        this.code = options.code || 'JEV_REQUEST_FAILED';
        this.status = options.status ?? null;
        this.retryable = options.retryable === true;
        this.provider = options.provider || null;
        this.cause = options.cause;
    }
}

class JevClient {
    constructor(options = {}) {
        this.options = { ...options };
        this.proxyAgents = new Map();
        this.apiKeyCursor = 0;
    }

    _resolveConfig(overrides = {}) {
        const provider = String(
            overrides.provider
            || this.options.provider
            || process.env.JEV_PROVIDER
            || 'typesafe'
        ).trim().toLowerCase();
        const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.typesafe;
        const url = String(
            overrides.url
            || this.options.url
            || process.env.JEV_API_URL
            || defaults.url
        ).trim();
        const apiKeys = parseApiKeys(
            overrides.apiKey
            || this.options.apiKey
            || process.env.JEV_API_KEY
            || ''
        );
        const model = String(
            overrides.model
            || this.options.model
            || process.env.JEV_MODEL
            || defaults.model
        ).trim();
        const timeoutMs = parsePositiveInteger(
            overrides.timeoutMs
            ?? this.options.timeoutMs
            ?? process.env.JEV_TIMEOUT_MS,
            30000,
            300000
        );
        const maxRetries = parseNonNegativeInteger(
            overrides.maxRetries
            ?? this.options.maxRetries
            ?? process.env.JEV_MAX_RETRIES,
            2,
            10
        );
        const retryBaseDelayMs = parsePositiveInteger(
            overrides.retryBaseDelayMs
            ?? this.options.retryBaseDelayMs
            ?? process.env.JEV_RETRY_BASE_DELAY_MS,
            500,
            30000
        );

        const proxyUrl = String(
            overrides.proxyUrl
            || this.options.proxyUrl
            || process.env.JEV_PROXY_URL
            || ''
        ).trim();

        return {
            provider,
            url,
            apiKeys,
            model,
            timeoutMs,
            maxRetries,
            retryBaseDelayMs,
            proxyUrl,
            referer: String(
                overrides.referer
                || this.options.referer
                || process.env.JEV_HTTP_REFERER
                || ''
            ).trim(),
            title: String(
                overrides.title
                || this.options.title
                || process.env.JEV_APP_TITLE
                || 'VCPToolBox'
            ).trim()
        };
    }

    _takeNextApiKey(apiKeys) {
        if (!Array.isArray(apiKeys) || apiKeys.length === 0) return '';
        const index = this.apiKeyCursor % apiKeys.length;
        this.apiKeyCursor = (index + 1) % apiKeys.length;
        return apiKeys[index];
    }

    _validateState(state) {
        if (state === undefined || state === null) {
            throw new JevClientError('Jev state 不能为空。', {
                code: 'JEV_INVALID_STATE'
            });
        }
        if (
            typeof state !== 'string'
            && typeof state !== 'object'
        ) {
            throw new JevClientError('Jev state 必须是字符串、对象或数组。', {
                code: 'JEV_INVALID_STATE'
            });
        }
    }

    _validateQuestions(questions) {
        if (
            !questions
            || typeof questions !== 'object'
            || Array.isArray(questions)
            || Object.keys(questions).length === 0
        ) {
            throw new JevClientError('Jev questions 必须是非空对象。', {
                code: 'JEV_INVALID_QUESTIONS'
            });
        }

        for (const [key, question] of Object.entries(questions)) {
            if (
                !question
                || typeof question !== 'object'
                || Array.isArray(question)
            ) {
                throw new JevClientError(`Jev 问题 "${key}" 必须是对象。`, {
                    code: 'JEV_INVALID_QUESTION'
                });
            }

            const type = String(question.type || '').toLowerCase();
            if (!QUESTION_TYPES.has(type)) {
                throw new JevClientError(
                    `Jev 问题 "${key}" 的 type 必须是 noul、choice 或 score。`,
                    { code: 'JEV_INVALID_QUESTION_TYPE' }
                );
            }
            if (
                typeof question.instructions !== 'string'
                || !question.instructions.trim()
            ) {
                throw new JevClientError(
                    `Jev 问题 "${key}" 缺少非空 instructions。`,
                    { code: 'JEV_INVALID_INSTRUCTIONS' }
                );
            }

            if (type === 'choice') {
                const criteria = question.criteria;
                const optionCount = criteria
                    && typeof criteria === 'object'
                    && !Array.isArray(criteria)
                    ? Object.keys(criteria).length
                    : 0;
                if (optionCount < 2 || optionCount > 255) {
                    throw new JevClientError(
                        `Jev Choice 问题 "${key}" 必须包含 2~255 个 criteria 选项。`,
                        { code: 'JEV_INVALID_CHOICE_CRITERIA' }
                    );
                }
            }

            if (
                type === 'score'
                && (
                    !Array.isArray(question.criteria)
                    || question.criteria.length < 2
                )
            ) {
                throw new JevClientError(
                    `Jev Score 问题 "${key}" 至少需要 2 个有序 criteria 等级。`,
                    { code: 'JEV_INVALID_SCORE_CRITERIA' }
                );
            }
        }
    }

    _getProxyAgent(proxyUrl) {
        if (!proxyUrl) return null;
        if (this.proxyAgents.has(proxyUrl)) {
            return this.proxyAgents.get(proxyUrl);
        }

        let parsedProxyUrl;
        try {
            parsedProxyUrl = new URL(proxyUrl);
        } catch (error) {
            throw new JevClientError(
                'JEV_PROXY_URL 不是有效 URL，请使用例如 http://127.0.0.1:7890。',
                {
                    code: 'JEV_INVALID_PROXY_URL',
                    cause: error
                }
            );
        }
        if (!['http:', 'https:'].includes(parsedProxyUrl.protocol)) {
            throw new JevClientError(
                'JEV_PROXY_URL 仅支持 http:// 或 https:// 代理。',
                { code: 'JEV_UNSUPPORTED_PROXY_PROTOCOL' }
            );
        }

        try {
            const agent = new HttpsProxyAgent(proxyUrl);
            this.proxyAgents.set(proxyUrl, agent);
            return agent;
        } catch (error) {
            throw new JevClientError(
                `无法创建 Jev HTTPS 代理 Agent: ${error.message}`,
                {
                    code: 'JEV_PROXY_AGENT_ERROR',
                    cause: error
                }
            );
        }
    }

    _buildHeaders(config, extraHeaders = {}) {
        const headers = {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json'
        };
        if (config.provider === 'openrouter') {
            if (config.referer) headers['HTTP-Referer'] = config.referer;
            if (config.title) headers['X-OpenRouter-Title'] = config.title;
        }
        return { ...headers, ...extraHeaders };
    }

    _createRequestError(error, config) {
        const status = error?.response?.status ?? null;
        const responseData = error?.response?.data;
        const responseSummary = typeof responseData === 'string'
            ? responseData.substring(0, 1000)
            : responseData
                ? JSON.stringify(responseData).substring(0, 1000)
                : '';
        const retryable = RETRYABLE_STATUS_CODES.has(status)
            || error?.code === 'ECONNABORTED'
            || error?.code === 'ETIMEDOUT'
            || (!error?.response && !!error?.request);

        let message = `Jev 请求失败`;
        if (status) message += ` (HTTP ${status})`;
        if (responseSummary) message += `: ${responseSummary}`;
        else if (error?.message) message += `: ${error.message}`;

        return new JevClientError(message, {
            code: status ? `JEV_HTTP_${status}` : 'JEV_NETWORK_ERROR',
            status,
            retryable,
            provider: config.provider,
            cause: error
        });
    }

    isConfigured(overrides = {}) {
        const config = this._resolveConfig(overrides);
        return Boolean(config.url && config.apiKeys.length > 0 && config.model);
    }

    getStatus(overrides = {}) {
        const config = this._resolveConfig(overrides);
        return Object.freeze({
            configured: Boolean(config.url && config.apiKeys.length > 0 && config.model),
            provider: config.provider,
            url: config.url,
            model: config.model,
            apiKeyCount: config.apiKeys.length,
            timeoutMs: config.timeoutMs,
            maxRetries: config.maxRetries,
            proxyEnabled: Boolean(config.proxyUrl)
        });
    }

    async decide(state, questions, options = {}) {
        this._validateState(state);
        this._validateQuestions(questions);

        const config = this._resolveConfig(options);
        if (!config.url || config.apiKeys.length === 0 || !config.model) {
            throw new JevClientError(
                'Jev 尚未配置，请设置 JEV_API_KEY，并按需设置 JEV_PROVIDER、JEV_API_URL 与 JEV_MODEL。',
                {
                    code: 'JEV_NOT_CONFIGURED',
                    provider: config.provider
                }
            );
        }

        // 每次调用只领取一个 Key；该调用的全部重试沿用同一 Key，
        // 避免一次逻辑请求占用多个轮询槽位。
        const requestConfig = {
            ...config,
            apiKey: this._takeNextApiKey(config.apiKeys)
        };
        const body = {
            model: config.model,
            state,
            questions
        };
        const headers = this._buildHeaders(requestConfig, options.headers);
        const proxyAgent = this._getProxyAgent(requestConfig.proxyUrl);
        let lastError = null;

        for (let attempt = 0; attempt <= requestConfig.maxRetries; attempt++) {
            try {
                const response = await axios.post(requestConfig.url, body, {
                    headers,
                    timeout: requestConfig.timeoutMs,
                    maxRedirects: 0,
                    signal: options.signal,
                    ...(proxyAgent ? {
                        httpsAgent: proxyAgent,
                        // 禁止 Axios 再读取环境代理或执行二次代理解析。
                        proxy: false
                    } : {})
                });
                if (
                    !response.data
                    || typeof response.data !== 'object'
                    || !response.data.answers
                    || typeof response.data.answers !== 'object'
                ) {
                    throw new JevClientError('Jev 返回了无效响应：缺少 answers 对象。', {
                        code: 'JEV_INVALID_RESPONSE',
                        provider: requestConfig.provider
                    });
                }
                return response.data;
            } catch (error) {
                lastError = error instanceof JevClientError
                    ? error
                    : this._createRequestError(error, requestConfig);
                if (
                    !lastError.retryable
                    || attempt >= requestConfig.maxRetries
                    || options.signal?.aborted
                ) {
                    throw lastError;
                }

                const retryAfterSeconds = Number.parseFloat(
                    error?.response?.headers?.['retry-after']
                );
                const retryDelayMs = Number.isFinite(retryAfterSeconds)
                    ? Math.max(0, retryAfterSeconds * 1000)
                    : requestConfig.retryBaseDelayMs * (2 ** attempt);
                await sleep(retryDelayMs);
            }
        }

        throw lastError || new JevClientError('Jev 请求失败。', {
            provider: requestConfig.provider
        });
    }
}

const jevClient = new JevClient();

module.exports = jevClient;
module.exports.JevClient = JevClient;
module.exports.JevClientError = JevClientError;