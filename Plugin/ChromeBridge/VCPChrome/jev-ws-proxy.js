(function init(globalScope) {
    'use strict';

    function createJevWsProxy(getSocket) {
        const pending = new Map();
        function clear(socket) {
            for (const [id, request] of pending) {
                if (request.socket !== socket) continue;
                clearTimeout(request.timer);
                pending.delete(id);
                request.reject(new Error('JEV_TRANSPORT_CLOSED'));
            }
        }
        return Object.freeze({
            decide(state, questions, options = {}) {
                const socket = getSocket();
                if (!socket || socket.readyState !== 1) {
                    return Promise.reject(new Error('JEV_TRANSPORT_UNAVAILABLE'));
                }
                if (pending.size >= 8) return Promise.reject(new Error('JEV_TRANSPORT_BUSY'));
                let parsed;
                try { parsed = JSON.parse(state); }
                catch { return Promise.reject(new Error('INVALID_ENTITY_STATE')); }
                // Send only entity summaries, never arbitrary questions or action input values.
                let pageUrl = '';
                try {
                    const url = new URL(parsed.pageUrl);
                    if (['http:', 'https:'].includes(url.protocol)) pageUrl = url.origin + url.pathname;
                } catch {}
                const safeState = {
                    command: parsed.command,
                    target: String(parsed.target || '').slice(0, 2048),
                    pageUrl: pageUrl.slice(0, 2048),
                    candidates: (parsed.candidates || []).slice(0, 8).map(candidate =>
                        Object.fromEntries(['handleId', 'tagName', 'role', 'label', 'text',
                            'placeholder', 'containerKind', 'viewportZone'].map(key =>
                            [key, String(candidate[key] || '').slice(0, key === 'handleId' ? 256 : 160)])))
                };
                const requestId = globalScope.crypto.randomUUID();
                const timeoutMs = Math.min(3500, Math.max(100, Number(options.timeoutMs) || 3500));
                return new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                        pending.delete(requestId);
                        reject(new Error('JEV_TRANSPORT_TIMEOUT'));
                    }, timeoutMs);
                    pending.set(requestId, { socket, resolve, reject, timer });
                    try {
                        socket.send(JSON.stringify({
                            type: 'jev_entity_request',
                            data: { requestId, state: safeState, timeoutMs: Math.max(100, timeoutMs - 250) }
                        }));
                    } catch (error) {
                        clearTimeout(timer);
                        pending.delete(requestId);
                        reject(error);
                    }
                });
            },
            handleMessage(socket, message) {
                if (message?.type !== 'jev_entity_result') return false;
                const request = pending.get(message.data?.requestId);
                if (!request || request.socket !== socket) return true;
                pending.delete(message.data.requestId);
                clearTimeout(request.timer);
                if (message.data.status === 'success') request.resolve({ answers: message.data.answers });
                else request.reject(new Error('JEV_ENTITY_UNAVAILABLE'));
                return true;
            },
            clear
        });
    }

    const api = Object.freeze({ createJevWsProxy });
    if (typeof module === 'object' && module.exports) module.exports = api;
    globalScope.VCPChromeJevWsProxy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);