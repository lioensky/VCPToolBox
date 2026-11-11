'use strict';

function createHandoffGate(signal, { timeoutMs = 2000 } = {}) {
    let revision = 0;
    let last = null;
    let ready = false;
    let closed = false;
    const waiters = new Set();
    const wake = () => { for (const resolve of [...waiters]) resolve(); };
    const stopped = () => closed || signal?.aborted;
    const abortError = () => Object.assign(new Error('Request stopped during handoff'), { name: 'AbortError' });
    const onAbort = () => { closed = true; ready = false; wake(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    return {
        control({ action, handoffId, revision: next }) {
            if (!['prepare_handoff', 'cancel_handoff'].includes(action)) {
                return { success: false, code: 'INVALID_ACTION' };
            }
            if (typeof handoffId !== 'string' || !handoffId || handoffId.length > 128
                || !Number.isSafeInteger(next) || next < 1) {
                return { success: false, code: 'INVALID_HANDOFF' };
            }
            if (stopped()) return { success: false, code: 'REQUEST_STOPPED' };
            if (next < revision) return { success: false, code: 'STALE_REVISION' };
            if (next === revision) {
                return last?.action === action && last?.handoffId === handoffId
                    ? { success: true, duplicate: true }
                    : { success: false, code: 'REVISION_CONFLICT' };
            }
            if (action === 'cancel_handoff' && last && last.handoffId !== handoffId) {
                return { success: false, code: 'STALE_HANDOFF' };
            }
            revision = next;
            last = { action, handoffId };
            ready = action === 'prepare_handoff';
            wake();
            return { success: true, state: ready ? 'armed' : 'cancelled', revision };
        },
        // Caller must recheck AbortSignal immediately before synchronous fetch dispatch.
        isReady() { return ready && !stopped(); },
        async wait() {
            if (stopped()) throw abortError();
            if (!ready) return;
            const deadline = Date.now() + timeoutMs;
            while (ready && !stopped()) {
                const remaining = deadline - Date.now();
                if (remaining <= 0) break;
                await new Promise(resolve => {
                    let timer;
                    const done = () => {
                        clearTimeout(timer);
                        waiters.delete(done);
                        resolve();
                    };
                    waiters.add(done);
                    timer = setTimeout(done, remaining);
                });
            }
            if (stopped()) throw abortError();
            // Timeout is fail-open: do not hold a request forever if the client
            // disappears without closing its transport. The lease is one-shot.
            ready = false;
        },
        dispose() {
            closed = true;
            ready = false;
            signal?.removeEventListener('abort', onAbort);
            wake();
        },
    };
}

module.exports = { createHandoffGate };