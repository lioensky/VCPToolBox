'use strict';

const REQUEST_FIELDS = [
    'tools', 'tool_choice', 'functions', 'function_call', 'parallel_tool_calls',
    'toolChoice', 'toolConfig', 'tool_config'
];
const MESSAGE_FIELDS = ['tool_calls', 'function_call', 'functionCall', 'toolCalls'];

function matchesNativeToolIsolation(model, keywords = process.env.NativeToolIsolationModels ?? 'hydrogen') {
    if (typeof model !== 'string') return false;
    const name = model.toLowerCase();
    return String(keywords).split(/[,，]/)
        .map(word => word.trim().toLowerCase())
        .some(word => word.length > 0 && name.includes(word));
}

/**
 * Outbound projection only. Never inspect text/arguments or mutate stored history.
 * Native tool/function result roles are deliberately outside this field-only rule.
 */
function isolateNativeToolsForUpstream(body, keywords) {
    if (!body || typeof body !== 'object' || !matchesNativeToolIsolation(body.model, keywords)) {
        return body;
    }
    const projected = { ...body };
    for (const field of REQUEST_FIELDS) delete projected[field];
    if (Array.isArray(body.messages)) {
        projected.messages = body.messages.map(message => {
            if (!message || typeof message !== 'object' ||
                !MESSAGE_FIELDS.some(field => Object.hasOwn(message, field))) return message;
            const copy = { ...message };
            for (const field of MESSAGE_FIELDS) delete copy[field];
            return copy;
        });
    }
    return projected;
}

/** Apply after model fallback selection, starting from the original body on every attempt. */
function isolateNativeToolRequestOptions(options, keywords) {
    if (!options || typeof options.body !== 'string') return options;
    let body;
    try {
        body = JSON.parse(options.body);
    } catch {
        return options;
    }
    const projected = isolateNativeToolsForUpstream(body, keywords);
    return projected === body ? options : { ...options, body: JSON.stringify(projected) };
}

module.exports = {
    matchesNativeToolIsolation,
    isolateNativeToolsForUpstream,
    isolateNativeToolRequestOptions
};