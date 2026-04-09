const VALID_MODES = new Set(['grounding', 'grok', 'tavily']);

function normalizeMode(mode) {
    return typeof mode === 'string' ? mode.trim().toLowerCase() : '';
}

function resolveSearchMode(requestMode, defaultMode) {
    const explicitMode = normalizeMode(requestMode);
    if (VALID_MODES.has(explicitMode)) {
        return explicitMode;
    }

    const configuredMode = normalizeMode(defaultMode);
    if (VALID_MODES.has(configuredMode)) {
        return configuredMode;
    }

    return 'tavily';
}

function buildTavilyClientOptions(apiKey, apiBaseURL) {
    const options = { apiKey };
    if (typeof apiBaseURL === 'string' && apiBaseURL.trim()) {
        options.apiBaseURL = apiBaseURL.trim();
    }
    return options;
}

function resolveTavilySearchUrl(apiBaseURL) {
    const normalized = typeof apiBaseURL === 'string' ? apiBaseURL.trim().replace(/\/+$/, '') : '';
    if (!normalized) {
        return 'https://api.tavily.com/search';
    }
    if (normalized.toLowerCase().endsWith('/search')) {
        return normalized;
    }
    return `${normalized}/search`;
}

function resolveTavilyKey(pluginEnv = {}, rootEnv = {}) {
    const pluginKey = typeof pluginEnv.TavilyKey === 'string' ? pluginEnv.TavilyKey.trim() : '';
    if (pluginKey) {
        return pluginKey;
    }

    const rootKey = typeof rootEnv.TavilyKey === 'string' ? rootEnv.TavilyKey.trim() : '';
    return rootKey;
}

module.exports = {
    resolveSearchMode,
    buildTavilyClientOptions,
    resolveTavilySearchUrl,
    resolveTavilyKey
};
