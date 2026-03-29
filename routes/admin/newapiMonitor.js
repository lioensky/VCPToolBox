const express = require('express');
const axios = require('axios');

const DEFAULT_LOOKBACK_SECONDS = 24 * 60 * 60;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_LOG_PAGES = 200;
const CONSUME_LOG_TYPE = 2;

function safeNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeUnixTimestamp(value, fallback = 0) {
    const parsed = safeNumber(value, fallback);
    if (parsed > 100000000000) {
        return Math.floor(parsed / 1000);
    }
    return Math.floor(parsed);
}

function normalizeBaseUrl(baseUrl) {
    if (typeof baseUrl !== 'string') {
        return '';
    }
    return baseUrl.trim().replace(/\/+$/, '');
}

function buildError(message, status = 500) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function getModelNameFromQuery(query) {
    const value = query.model_name ?? query.model ?? '';
    return typeof value === 'string' ? value.trim() : '';
}

function getTimeRangeFromQuery(query) {
    const now = Math.floor(Date.now() / 1000);
    const startValue = query.start_timestamp;
    const endValue = query.end_timestamp;

    let endTimestamp = endValue ? normalizeUnixTimestamp(endValue, now) : now;
    let startTimestamp = startValue
        ? normalizeUnixTimestamp(startValue, endTimestamp - DEFAULT_LOOKBACK_SECONDS)
        : endTimestamp - DEFAULT_LOOKBACK_SECONDS;

    if (!(endTimestamp > 0)) {
        endTimestamp = now;
    }
    if (startTimestamp < 0) {
        startTimestamp = 0;
    }
    if (startTimestamp > endTimestamp) {
        throw buildError('start_timestamp 不能大于 end_timestamp。', 400);
    }

    return { startTimestamp, endTimestamp };
}

function normalizeQuotaItem(item = {}) {
    return {
        model_name: typeof item.model_name === 'string' ? item.model_name : '',
        created_at: normalizeUnixTimestamp(item.created_at, 0),
        requests: safeNumber(item.count, 0),
        token_used: safeNumber(item.token_used, 0),
        quota: safeNumber(item.quota, 0)
    };
}

function normalizeLogItem(item = {}) {
    return {
        created_at: normalizeUnixTimestamp(item.created_at, 0),
        model_name: typeof item.model_name === 'string' ? item.model_name : '',
        prompt_tokens: safeNumber(item.prompt_tokens, 0),
        completion_tokens: safeNumber(item.completion_tokens, 0),
        quota: safeNumber(item.quota, 0)
    };
}

function toHourTimestamp(unixSeconds) {
    const value = normalizeUnixTimestamp(unixSeconds, 0);
    return value - (value % 3600);
}

function sortByCreatedAtAsc(a, b) {
    return a.created_at - b.created_at;
}

function sortModelItems(items) {
    return items.sort((a, b) => {
        if (b.requests !== a.requests) {
            return b.requests - a.requests;
        }
        if (b.token_used !== a.token_used) {
            return b.token_used - a.token_used;
        }
        if (b.quota !== a.quota) {
            return b.quota - a.quota;
        }
        return a.model_name.localeCompare(b.model_name);
    });
}

class NewApiMonitorClient {
    constructor({ baseUrl, accessToken, timeoutMs, debugMode, apiUserId }) {
        this.baseUrl = normalizeBaseUrl(baseUrl);
        this.accessToken = typeof accessToken === 'string' ? accessToken.trim() : '';
        this.timeoutMs = safeNumber(timeoutMs, DEFAULT_TIMEOUT_MS);
        this.debugMode = Boolean(debugMode);
        this.apiUserId = typeof apiUserId === 'string' ? apiUserId.trim() : '';
    }

    get isConfigured() {
        return Boolean(this.baseUrl) && Boolean(this.accessToken) && Boolean(this.apiUserId);
    }

    debugLog(...args) {
        if (this.debugMode) {
            console.log('[NewApiMonitor]', ...args);
        }
    }

    buildAuthHeaders() {
        return {
            'Authorization': this.accessToken,
            'New-Api-User': this.apiUserId
        };
    }

    async request(path, { method = 'GET', params = {} } = {}) {
        if (!this.isConfigured) {
            throw buildError('NewAPI 监控未配置。请设置 NEWAPI_MONITOR_BASE_URL、NEWAPI_MONITOR_ACCESS_TOKEN 和 NEWAPI_MONITOR_API_USER_ID。', 503);
        }

        this.debugLog('Request:', method, path);

        const response = await axios({
            url: `${this.baseUrl}${path}`,
            method,
            params,
            timeout: this.timeoutMs,
            headers: this.buildAuthHeaders(),
            validateStatus: () => true
        });

        const responseBody = response.data || {};
        const responseMessage = typeof responseBody.message === 'string' ? responseBody.message : '';

        if (response.status >= 400) {
            throw buildError(`请求 NewAPI 失败（${response.status}）：${responseMessage || response.statusText || path}`, 502);
        }
        if (responseBody.success === false) {
            throw buildError(`NewAPI 返回失败：${responseMessage || path}`, 502);
        }

        return responseBody;
    }

    async getQuotaData(startTimestamp, endTimestamp) {
        return this.request('/api/data/', {
            params: {
                start_timestamp: startTimestamp,
                end_timestamp: endTimestamp
            }
        });
    }

    async getLogStat(startTimestamp, endTimestamp, modelName) {
        const params = {
            type: CONSUME_LOG_TYPE,
            start_timestamp: startTimestamp,
            end_timestamp: endTimestamp
        };
        if (modelName) {
            params.model_name = modelName;
        }

        return this.request('/api/log/stat', { params });
    }

    async getConsumeLogs(startTimestamp, endTimestamp, modelName, page) {
        const params = {
            type: CONSUME_LOG_TYPE,
            start_timestamp: startTimestamp,
            end_timestamp: endTimestamp,
            p: page,
            page_size: 100
        };
        if (modelName) {
            params.model_name = modelName;
        }

        return this.request('/api/log/', { params });
    }
}

function createMonitorClient(debugMode) {
    return new NewApiMonitorClient({
        baseUrl: process.env.NEWAPI_MONITOR_BASE_URL,
        accessToken: process.env.NEWAPI_MONITOR_ACCESS_TOKEN,
        timeoutMs: process.env.NEWAPI_MONITOR_TIMEOUT_MS,
        debugMode,
        apiUserId: process.env.NEWAPI_MONITOR_API_USER_ID
    });
}

async function fetchAllConsumeLogs(client, { startTimestamp, endTimestamp, modelName }) {
    const logItems = [];

    for (let page = 1; ; page += 1) {
        if (page > MAX_LOG_PAGES) {
            break;
        }

        const responseBody = await client.getConsumeLogs(startTimestamp, endTimestamp, modelName, page);
        const pageInfo = responseBody && responseBody.data ? responseBody.data : {};
        const currentItems = Array.isArray(pageInfo.items) ? pageInfo.items.map(normalizeLogItem) : [];
        const total = safeNumber(pageInfo.total, 0);

        logItems.push(...currentItems);

        if (currentItems.length === 0) {
            break;
        }
        if (!(currentItems.length >= 100)) {
            break;
        }
        if (total > 0 && logItems.length >= total) {
            break;
        }
    }

    return logItems;
}

async function fetchUsageDataset(client, { startTimestamp, endTimestamp, modelName }) {
    const quotaResponseBody = await client.getQuotaData(startTimestamp, endTimestamp);
    const quotaItems = Array.isArray(quotaResponseBody && quotaResponseBody.data)
        ? quotaResponseBody.data.map(normalizeQuotaItem)
        : [];

    if (quotaItems.length > 0) {
        return {
            source: 'quota_data',
            quotaItems,
            logItems: []
        };
    }

    const logItems = await fetchAllConsumeLogs(client, { startTimestamp, endTimestamp, modelName });
    return {
        source: 'consume_logs',
        quotaItems: [],
        logItems
    };
}

function buildTrendItemsFromQuotaData(quotaItems, modelName) {
    const trendMap = new Map();

    for (const quotaItem of quotaItems) {
        if (modelName && quotaItem.model_name !== modelName) {
            continue;
        }

        const key = quotaItem.created_at;
        if (!trendMap.has(key)) {
            trendMap.set(key, {
                created_at: key,
                requests: 0,
                token_used: 0,
                quota: 0
            });
        }

        const bucket = trendMap.get(key);
        bucket.requests += quotaItem.requests;
        bucket.token_used += quotaItem.token_used;
        bucket.quota += quotaItem.quota;
    }

    return Array.from(trendMap.values()).sort(sortByCreatedAtAsc);
}

function buildTrendItemsFromLogs(logItems) {
    const trendMap = new Map();

    for (const logItem of logItems) {
        const key = toHourTimestamp(logItem.created_at);
        if (!trendMap.has(key)) {
            trendMap.set(key, {
                created_at: key,
                requests: 0,
                token_used: 0,
                quota: 0
            });
        }

        const bucket = trendMap.get(key);
        bucket.requests += 1;
        bucket.token_used += logItem.prompt_tokens + logItem.completion_tokens;
        bucket.quota += logItem.quota;
    }

    return Array.from(trendMap.values()).sort(sortByCreatedAtAsc);
}

function buildModelItemsFromQuotaData(quotaItems) {
    const modelMap = new Map();

    for (const quotaItem of quotaItems) {
        const modelName = quotaItem.model_name || '(unknown)';
        if (!modelMap.has(modelName)) {
            modelMap.set(modelName, {
                model_name: modelName,
                requests: 0,
                token_used: 0,
                quota: 0
            });
        }

        const bucket = modelMap.get(modelName);
        bucket.requests += quotaItem.requests;
        bucket.token_used += quotaItem.token_used;
        bucket.quota += quotaItem.quota;
    }

    return sortModelItems(Array.from(modelMap.values()));
}

function buildModelItemsFromLogs(logItems) {
    const modelMap = new Map();

    for (const logItem of logItems) {
        const modelName = logItem.model_name || '(unknown)';
        if (!modelMap.has(modelName)) {
            modelMap.set(modelName, {
                model_name: modelName,
                requests: 0,
                token_used: 0,
                quota: 0
            });
        }

        const bucket = modelMap.get(modelName);
        bucket.requests += 1;
        bucket.token_used += logItem.prompt_tokens + logItem.completion_tokens;
        bucket.quota += logItem.quota;
    }

    return sortModelItems(Array.from(modelMap.values()));
}

function buildSummaryPayload(trendItems, realtimeStatBody) {
    const totals = trendItems.reduce((accumulator, item) => {
        accumulator.total_requests += item.requests;
        accumulator.total_tokens += item.token_used;
        accumulator.total_quota += item.quota;
        return accumulator;
    }, {
        total_requests: 0,
        total_tokens: 0,
        total_quota: 0
    });

    const realtimeData = realtimeStatBody && realtimeStatBody.data ? realtimeStatBody.data : {};
    return {
        ...totals,
        current_rpm: safeNumber(realtimeData.rpm, 0),
        current_tpm: safeNumber(realtimeData.tpm, 0)
    };
}

function handleRouteError(routeName, error, res) {
    const status = safeNumber(error && error.status, 500);
    const message = error && error.message ? error.message : 'Unknown error';
    console.error(`[NewApiMonitor] ${routeName} failed:`, error);
    res.status(status).json({
        success: false,
        error: message
    });
}

module.exports = function newApiMonitorRoutes(options) {
    const router = express.Router();
    const debugMode = Boolean(options && options.DEBUG_MODE);

    router.get('/newapi-monitor/summary', async (req, res) => {
        try {
            const { startTimestamp, endTimestamp } = getTimeRangeFromQuery(req.query);
            const modelName = getModelNameFromQuery(req.query);
            const client = createMonitorClient(debugMode);
            const usageDataset = await fetchUsageDataset(client, { startTimestamp, endTimestamp, modelName });
            const trendItems = usageDataset.source === 'quota_data'
                ? buildTrendItemsFromQuotaData(usageDataset.quotaItems, modelName)
                : buildTrendItemsFromLogs(usageDataset.logItems);
            const realtimeStatBody = await client.getLogStat(startTimestamp, endTimestamp, modelName);
            const summary = buildSummaryPayload(trendItems, realtimeStatBody);

            res.json({
                success: true,
                data: {
                    source: usageDataset.source,
                    start_timestamp: startTimestamp,
                    end_timestamp: endTimestamp,
                    model_name: modelName || null,
                    ...summary
                }
            });
        } catch (error) {
            handleRouteError('summary', error, res);
        }
    });

    router.get('/newapi-monitor/trend', async (req, res) => {
        try {
            const { startTimestamp, endTimestamp } = getTimeRangeFromQuery(req.query);
            const modelName = getModelNameFromQuery(req.query);
            const client = createMonitorClient(debugMode);
            const usageDataset = await fetchUsageDataset(client, { startTimestamp, endTimestamp, modelName });
            const items = usageDataset.source === 'quota_data'
                ? buildTrendItemsFromQuotaData(usageDataset.quotaItems, modelName)
                : buildTrendItemsFromLogs(usageDataset.logItems);

            res.json({
                success: true,
                data: {
                    source: usageDataset.source,
                    start_timestamp: startTimestamp,
                    end_timestamp: endTimestamp,
                    model_name: modelName || null,
                    items
                }
            });
        } catch (error) {
            handleRouteError('trend', error, res);
        }
    });

    router.get('/newapi-monitor/models', async (req, res) => {
        try {
            const { startTimestamp, endTimestamp } = getTimeRangeFromQuery(req.query);
            const client = createMonitorClient(debugMode);
            const usageDataset = await fetchUsageDataset(client, { startTimestamp, endTimestamp, modelName: '' });
            const items = usageDataset.source === 'quota_data'
                ? buildModelItemsFromQuotaData(usageDataset.quotaItems)
                : buildModelItemsFromLogs(usageDataset.logItems);

            res.json({
                success: true,
                data: {
                    source: usageDataset.source,
                    start_timestamp: startTimestamp,
                    end_timestamp: endTimestamp,
                    items
                }
            });
        } catch (error) {
            handleRouteError('models', error, res);
        }
    });

    return router;
};