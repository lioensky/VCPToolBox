'use strict';

function withNativeToolDebug(body, enabled = process.env.VCP_FC_DEBUG) {
    if (enabled !== 'true' || !body || ['tools', 'tool_choice', 'functions', 'function_call']
        .some(key => Object.hasOwn(body, key))) return body;

    return {
        ...body,
        tools: [{
            type: 'function',
            function: {
                name: 'vcptools',
                description: 'Submit one server-managed VCP tool request. For a direct call, pass tool_name, optional command, and tool parameters as top-level keys. For semantic routing, pass JEV as a string. Do not repeat the same request as a text tool block.',
                strict: false,
                parameters: { type: 'object', additionalProperties: true }
            }
        }],
        tool_choice: 'auto'
    };
}

module.exports = { withNativeToolDebug };