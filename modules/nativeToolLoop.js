'use strict';

const NATIVE_CALL_ID = Symbol('vcpNativeCallId');

const { randomUUID } = require('node:crypto');
const record = value => value != null && typeof value === 'object' && !Array.isArray(value);
function entriesOf(payload) {
    if (payload?.tool_calls != null && payload.function_call != null) return [{ error: 'mixed_envelopes' }];
    if (payload?.function_call != null) return [{ index: 0, function: payload.function_call }];
    const value = payload?.tool_calls;
    return value == null ? [] : Array.isArray(value) ? value : [value];
}
function collectStreamToolCalls(frames) {
    const slots = new Map(), detached = [];
    for (const frame of frames) {
        const choice = JSON.parse(frame.slice(6).trim()).choices.find(c => (c.index ?? 0) === 0);
        for (const [position, part] of entriesOf(choice?.message ?? choice?.delta).entries()) {
            const index = part?.index ?? (choice?.message ? position : undefined);
            if (!Number.isSafeInteger(index) || index < 0) {
                detached.push({ error: part?.error || 'unbound_index' }); continue;
            }
            const slot = slots.get(index) ?? { function: {} };
            slots.set(index, slot);
            const fn = part?.function ?? part?.functionCall;
            if (!record(part) || (fn !== undefined && !record(fn))) { slot.error = 'invalid_fragment'; continue; }
            for (const key of ['type', 'id']) if (part[key] != null) {
                if (slot[key] !== undefined && slot[key] !== part[key]) slot.error = 'fragment_conflict';
                slot[key] = part[key];
            }
            for (const key of ['name', 'arguments']) {
                const value = key === 'arguments' ? fn?.arguments ?? fn?.args : fn?.name;
                if (value === undefined) continue;
                const old = slot.function[key];
                if (typeof value === 'string' && (old === undefined || typeof old === 'string')) slot.function[key] = (old ?? '') + value;
                else if (key === 'arguments' && old === undefined && record(value)) slot.function[key] = value;
                else slot.error = 'fragment_conflict';
            }
        }
    }
    return [...slots].sort(([a],[b]) => a-b).map(([,v]) => v).concat(detached);
}
function admitNativeCalls(input, knownTool = () => false) {
    const calls = [], normalized = [], rejected = [], used = new Set();
    const reserved = new Set(input.map(p => p?.id));
    for (const [i,p] of input.entries()) {
        const reject = reason => rejected.push(`${i}:${reason}`);
        if (!record(p) || p.error || (p.type != null && p.type !== 'function')) { reject(typeof p?.error === 'string' && ['fragment_conflict','unbound_index','mixed_envelopes','invalid_fragment'].includes(p.error) ? p.error : 'invalid_call'); continue; }
        const fn = p.function ?? p.functionCall;
        const raw = fn?.arguments ?? fn?.args;
        let args;
        try { args = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { reject('invalid_json'); continue; }
        if (!record(args)) { reject('expected_object'); continue; }
        let wire = typeof raw === 'string' ? raw : JSON.stringify(args);
        if (fn.name !== 'vcptools') {
            if (typeof fn.name !== 'string' || !knownTool(fn.name) || (args.tool_name !== undefined && args.tool_name !== fn.name) || Object.keys(args).some(k => k.toLowerCase() === 'jev')) { reject('unknown_or_conflicting_name'); continue; }
            wire = JSON.stringify({ ...args, tool_name: fn.name });
        }
        let id = p.id;
        if (typeof id !== 'string' || !id.trim() || used.has(id)) do { id = `call_${randomUUID()}`; } while (reserved.has(id) || used.has(id));
        const call = { ...(p.extra_content ? { extra_content: p.extra_content } : {}), id, type:'function', function:{ name:'vcptools', arguments:wire } };
        const item = normalizeNativeVcpCalls([call]);
        if (!item) { reject('invalid_target'); continue; }
        used.add(id); calls.push(call); normalized.push(item[0]);
    }
    return { calls, normalized, rejected };
}
function rejectionNotice(batch, body) {
    if (!batch.rejected.length && batch.calls.length) return '';
    const reasons = batch.rejected.slice(0, 12).join(', ') || 'empty_batch';
    console.warn('[NativeFC]', { requestId: body.requestId ?? body.messageId, model: body.model, accepted:batch.calls.length, rejected:batch.rejected.length, reasons });
    return `\n[VCP 原生 FC：可执行 ${batch.calls.length} 项；未执行项（序号从 0 起）：${reasons}]\n`;
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

module.exports = { NATIVE_CALL_ID, entriesOf, admitNativeCalls, rejectionNotice, collectStreamToolCalls, normalizeNativeVcpCalls, buildNativeToolMessages };