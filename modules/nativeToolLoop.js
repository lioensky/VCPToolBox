'use strict';

const NATIVE_CALL_ID = Symbol('vcpNativeCallId');

/** Assemble the first candidate's calls from the already bounded SSE buffer. */
function collectStreamToolCalls(frames) {
    const calls = new Map();
    for (const frame of frames) {
        const choice = JSON.parse(frame.slice(6).trim()).choices.find(item => (item.index ?? 0) === 0);
        const payload = choice?.message ?? choice?.delta;
        if (payload?.function_call || (payload?.tool_calls != null && !Array.isArray(payload.tool_calls))) return null;
        for (const [position, part] of (payload?.tool_calls ?? []).entries()) {
            if (!part || typeof part !== 'object' || Array.isArray(part)) return null;
            const index = part.index ?? (choice.message ? position : -1);
            if (!Number.isSafeInteger(index) || index < 0) return null;
            const call = calls.get(index) ?? { id: '', type: '', function: { name: '', arguments: '' } };
            for (const key of ['id', 'type']) {
                if (part[key] === undefined) continue;
                if (typeof part[key] !== 'string' || (call[key] && call[key] !== part[key])) return null;
                call[key] = part[key];
            }
            for (const key of ['name', 'arguments']) {
                const value = part.function?.[key];
                if (value === undefined) continue;
                if (typeof value !== 'string') return null;
                call.function[key] += value;
            }
            calls.set(index, call);
        }
    }
    return [...calls].sort(([a], [b]) => a - b).map(([, call]) => call);
}

function normalizeNativeVcpCalls(calls) {
    if (!Array.isArray(calls) || calls.length === 0) return null;
    const ids = new Set();
    const normalized = [];
    for (const call of calls) {
        if (call?.type !== 'function' || call.function?.name !== 'vcptools' ||
            typeof call.id !== 'string' || !call.id || ids.has(call.id) ||
            typeof call.function.arguments !== 'string') return null;
        ids.add(call.id);

        let params;
        try { params = JSON.parse(call.function.arguments); } catch { return null; }
        if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
        const { tool_name, archery, ink, river, vref, ...args } = params;
        if (tool_name !== undefined && (typeof tool_name !== 'string' || !tool_name.trim())) return null;
        let name = tool_name?.trim();
        if (!name) {
            const key = Object.keys(args).find(key => key.toLowerCase() === 'jev');
            if (!key || typeof args[key] !== 'string' || !args[key].trim()) return null;
            name = 'JEV';
            args.expression = args[key].trim();
            delete args[key];
        }
        if (args.valet && !args.maid) args.maid = args.valet;
        if (typeof args.tool_password === 'number' && Number.isFinite(args.tool_password)) {
            args.tool_password = String(args.tool_password);
        }
        const archeryMode = typeof archery === 'string' ? archery.trim() : archery;
        const normalizedVref = typeof vref === 'number'
            ? (Number.isFinite(vref) && vref > 0 ? String(Math.floor(vref)) : null)
            : (typeof vref === 'string' ? (vref.trim() || null) : null);
        normalized.push({
            name, args, archery: archeryMode === true || archeryMode === 'true' || archeryMode === 'no_reply',
            archeryNoReply: archeryMode === 'no_reply', markHistory: typeof ink === 'string' && ink.trim() === 'mark_history',
            river: typeof river === 'string' ? river.trim() : null,
            vref: normalizedVref,
            [NATIVE_CALL_ID]: call.id
        });
    }
    return normalized;
}

function buildNativeToolMessages(calls, groups) {
    const byId = new Map(calls.map(call => [call.id, []]));
    for (const group of groups) {
        const parts = byId.get(group?.callId);
        if (!parts) continue;
        for (const part of group.parts ?? []) {
            if (part?.type === 'text' && typeof part.text === 'string') parts.push({ type: 'text', text: part.text });
            else if (part?.type === 'image_url') parts.push(part);
            else if (part?.type) parts.push({ type: 'text', text: `[Unsupported tool result part: ${part.type}]` });
        }
    }
    return calls.map(call => {
        const parts = byId.get(call.id);
        return {
            role: 'tool',
            tool_call_id: call.id,
            content: parts.some(part => part.type === 'image_url')
                ? parts
                : parts.map(part => part.text).join('\n\n') || '[No model-visible tool result.]'
        };
    });
}

module.exports = { NATIVE_CALL_ID, collectStreamToolCalls, normalizeNativeVcpCalls, buildNativeToolMessages };