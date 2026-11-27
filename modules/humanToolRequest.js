'use strict';

const ToolCallParser = require('./vcpLoop/toolCallParser.js');

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const readName = value => typeof value === 'string' ? value.trim() : '';

function normalizeJsonToolCall(body) {
    let call = body;
    if (has(body, 'tool_calls')) {
        if (['function', 'name', 'arguments', 'function_call'].some(key => has(body, key)) ||
            !Array.isArray(body.tool_calls) || body.tool_calls.length !== 1) {
            return { error: 'Expected exactly one unambiguous tool call in tool_calls.' };
        }
        [call] = body.tool_calls;
    }

    if (!isObject(call) || ['tool_calls', 'function_call'].some(key => has(call, key))) {
        return { error: 'Expected a single JSON function call object.' };
    }

    const nested = has(call, 'function');
    const fn = nested ? call.function : call;
    const expectedType = nested ? 'function' : 'function_call';
    if (!isObject(fn) || (has(call, 'type') && call.type !== expectedType) ||
        (nested && (has(call, 'name') || has(call, 'arguments')))) {
        return { error: 'Invalid or ambiguous JSON function call.' };
    }

    const name = readName(fn.name);
    if (!name) return { error: 'Function name must be a non-empty string.' };

    let args = fn.arguments;
    if (typeof args === 'string') {
        try {
            args = JSON.parse(args);
        } catch {
            return { error: 'Function arguments must contain valid JSON.' };
        }
    }
    if (!isObject(args)) return { error: 'Function arguments must be a JSON object.' };

    const { tool_name: target, ...pluginArgs } = args;
    if (name === 'vcptools') {
        const targetName = readName(target);
        if (!targetName) return { error: 'vcptools requires a non-empty arguments.tool_name.' };
        return { name: targetName, args: pluginArgs };
    }
    if (has(args, 'tool_name') && readName(target) !== name) {
        return { error: 'Function name conflicts with arguments.tool_name.' };
    }
    return { name, args: pluginArgs };
}

function normalizeHumanToolRequest(body, isJson) {
    if (isJson) {
        if (!isObject(body)) return { error: 'Request body must be a JSON function call object.' };
        return normalizeJsonToolCall(body);
    }
    if (typeof body !== 'string' || !body.trim()) {
        return { error: 'Request body must be non-empty plain text or an application/json function call.' };
    }

    const block = ToolCallParser.extractNextToolBlock(body);
    if (!block) return { error: 'Malformed request: Missing TOOL_REQUEST markers.' };

    const call = ToolCallParser.parseBlock(block.blockContent);
    if (!call?.name) return { error: 'Malformed request: tool_name not found within the request block.' };
    return { name: call.name, args: call.args || {} };
}

module.exports = { normalizeHumanToolRequest };