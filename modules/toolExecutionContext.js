'use strict';

function normalizeString(value) {
    return typeof value === 'string' && value.trim()
        ? value.trim()
        : null;
}

function appendOptionalString(target, source, key) {
    const normalized = normalizeString(source[key]);
    if (normalized) {
        target[key] = normalized;
    }
}

function normalizeExecutionContext(executionContext = null, options = {}) {
    const nullWhenMissing = options.nullWhenMissing === true;
    const defaultRequestSource = normalizeString(options.defaultRequestSource) || 'unknown';

    if (!executionContext || typeof executionContext !== 'object') {
        return nullWhenMissing
            ? null
            : {
                agentAlias: null,
                agentId: null,
                requestSource: defaultRequestSource
            };
    }

    const normalizedContext = {
        agentAlias: normalizeString(executionContext.agentAlias),
        agentId: normalizeString(executionContext.agentId),
        requestSource: normalizeString(executionContext.requestSource) || defaultRequestSource
    };

    appendOptionalString(normalizedContext, executionContext, 'operatorId');
    appendOptionalString(normalizedContext, executionContext, 'bridgeId');
    appendOptionalString(normalizedContext, executionContext, 'taskId');
    appendOptionalString(normalizedContext, executionContext, 'invocationId');

    return normalizedContext;
}

module.exports = {
    normalizeExecutionContext
};
