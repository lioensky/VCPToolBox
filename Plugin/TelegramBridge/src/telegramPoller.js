'use strict';

const { ALLOWED_UPDATES, TelegramApiError } = require('./telegramClient');

const UPDATE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ALLOWED_UPDATE_SET = new Set(ALLOWED_UPDATES);
const POSSIBLE_GAP_MS = 24 * 60 * 60 * 1000;
const NETWORK_GRACE_MS = 10_000; // Matches the Telegram client's default long-poll grace.
const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;
const SAFE_ERROR_CODES = new Set([
  'TELEGRAM_ABORTED', 'TELEGRAM_AUTH', 'TELEGRAM_FORBIDDEN', 'TELEGRAM_BAD_REQUEST',
  'TELEGRAM_CONFLICT', 'TELEGRAM_RATE_LIMIT', 'TELEGRAM_SERVER', 'TELEGRAM_NETWORK',
  'TELEGRAM_TIMEOUT', 'TELEGRAM_INVALID_REQUEST', 'TELEGRAM_INVALID_RESPONSE',
  'TELEGRAM_RESPONSE_TOO_LARGE', 'TELEGRAM_REDIRECT_REJECTED', 'TELEGRAM_CONFIG_INVALID',
  'TELEGRAM_POLLER_INPUT_INVALID', 'TELEGRAM_POLLER_CONFIG_INVALID',
  'TELEGRAM_POLLER_CLOCK_INVALID', 'TELEGRAM_POLLER_RANDOM_INVALID',
  'TELEGRAM_UPDATE_INVALID', 'TELEGRAM_UPDATES_INVALID', 'TELEGRAM_LEDGER_INVALID',
  'TELEGRAM_BOT_IDENTITY_INVALID', 'TELEGRAM_WEBHOOK_INFO_INVALID', 'TELEGRAM_WEBHOOK_ACTIVE',
  'TELEGRAM_POLLER_UNAVAILABLE', 'TELEGRAM_POLLER_STOPPING', 'TELEGRAM_POLLER_ACTIVE',
  'TELEGRAM_POLL_IN_PROGRESS', 'TELEGRAM_POLLER_FAILED', 'TELEGRAM_DISPATCH_TIMEOUT',
  'LEDGER_READ_FAILED', 'LEDGER_WRITE_FAILED', 'LEDGER_INPUT_INVALID', 'LEDGER_CLOCK_INVALID',
  'UPDATE_ID_INVALID', 'UPDATE_ID_COLLISION', 'UPDATE_PAYLOAD_INVALID', 'OFFSET_INVALID',
]);

class TelegramPollerError extends Error {
  constructor(code) {
    super('Telegram poller operation failed.');
    Object.defineProperty(this, 'name', { value: 'TelegramPollerError' });
    this.code = code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, TelegramPollerError);
  }
}

function fail(code) {
  throw new TelegramPollerError(code);
}

function safeErrorCode(error) {
  try {
    const code = error?.code;
    if (SAFE_ERROR_CODES.has(code)) return code;
  } catch { /* untrusted error metadata */ }
  return 'TELEGRAM_POLLER_FAILED';
}

function snapshotControlSignal(controlOptions) {
  if (
    controlOptions === null
    || typeof controlOptions !== 'object'
    || Array.isArray(controlOptions)
  ) {
    fail('TELEGRAM_POLLER_INPUT_INVALID');
  }
  let signal;
  try {
    signal = controlOptions.signal;
  } catch {
    fail('TELEGRAM_POLLER_INPUT_INVALID');
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    fail('TELEGRAM_POLLER_INPUT_INVALID');
  }
  return signal;
}

function validateClock(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) fail('TELEGRAM_POLLER_CLOCK_INVALID');
  return value;
}

function randomFraction(random) {
  const value = random();
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
    fail('TELEGRAM_POLLER_RANDOM_INVALID');
  }
  return value;
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TelegramApiError('TELEGRAM_ABORTED'));
      return;
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new TelegramApiError('TELEGRAM_ABORTED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function waitWithAbort(sleep, ms, signal) {
  if (signal?.aborted) return Promise.reject(new TelegramApiError('TELEGRAM_ABORTED'));
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(new TelegramApiError('TELEGRAM_ABORTED'));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([
    Promise.resolve().then(() => sleep(ms, signal)),
    aborted,
  ]).finally(() => signal?.removeEventListener('abort', onAbort));
}

function snapshotUpdate(rawUpdate) {
  try {
    const serialized = JSON.stringify(rawUpdate);
    if (typeof serialized !== 'string') fail('TELEGRAM_UPDATE_INVALID');
    const update = JSON.parse(serialized);
    if (update === null || typeof update !== 'object' || Array.isArray(update)) {
      fail('TELEGRAM_UPDATE_INVALID');
    }
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 1) {
      fail('TELEGRAM_UPDATE_INVALID');
    }
    const kinds = Object.keys(update).filter((key) => key !== 'update_id');
    const updateType = kinds.length === 1 && UPDATE_TYPE_PATTERN.test(kinds[0])
      ? kinds[0]
      : 'unsupported';
    return Object.freeze({
      updateId: String(update.update_id),
      updateType,
      payload: update,
      rejectErrorCode: ALLOWED_UPDATE_SET.has(updateType) ? null : 'UNSUPPORTED_UPDATE_TYPE',
    });
  } catch (error) {
    if (error instanceof TelegramPollerError) throw error;
    fail('TELEGRAM_UPDATE_INVALID');
  }
}

function createTelegramPoller(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('TELEGRAM_POLLER_CONFIG_INVALID');
  }
  const {
    client,
    ledger,
    timeoutSec,
    limit,
    sleep = defaultSleep,
    random = Math.random,
    clock = Date.now,
    onBatch = null,
  } = options;
  let dispatchTimeoutMs;
  let onStateChange;
  try {
    dispatchTimeoutMs = options.dispatchTimeoutMs;
    onStateChange = options.onStateChange;
  } catch {
    fail('TELEGRAM_POLLER_CONFIG_INVALID');
  }
  if (dispatchTimeoutMs === undefined) dispatchTimeoutMs = DEFAULT_DISPATCH_TIMEOUT_MS;
  if (onStateChange === undefined) onStateChange = null;
  if (
    !client || typeof client.getMe !== 'function'
    || typeof client.getWebhookInfo !== 'function'
    || typeof client.getUpdates !== 'function'
    || !ledger || typeof ledger.getNextOffset !== 'function'
    || typeof ledger.acceptBatch !== 'function'
    || typeof ledger.getPollerState !== 'function'
    || typeof ledger.recordPollerSuccess !== 'function'
    || typeof ledger.recordDuplicatePoller !== 'function'
    || !Number.isSafeInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 50
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || typeof sleep !== 'function' || typeof random !== 'function' || typeof clock !== 'function'
    || (onBatch !== null && typeof onBatch !== 'function')
    || !Number.isSafeInteger(dispatchTimeoutMs) || dispatchTimeoutMs < 1 || dispatchTimeoutMs > 2_147_483_647
    || (onStateChange !== null && typeof onStateChange !== 'function')
  ) {
    fail('TELEGRAM_POLLER_CONFIG_INVALID');
  }

  let state = 'idle';
  let active = false;
  let probed = false;
  let probePromise = null;
  let probeController = null;
  let loopPromise = null;
  let runPromise = null;
  let pollPromise = null;
  // This tracks the actual callback, which can outlive our bounded wait.
  let dispatchPromise = null;
  let controller = null;
  let runController = null;
  let stoppingPromise = null;
  let stopRequested = false;
  let failureCount = 0;
  let lastErrorCode = null;
  let lastSuccessAt = null;
  let backoffMs = 0;
  let phase = 'idle';
  let phaseStartedAt = validateClock(clock);
  let lastProgressAt = null;
  let nextRetryAt = null;
  let latestBatchReceiptLagMs = null;
  let maxBatchReceiptLagMs = null;
  let hasPollSuccess = false;

  function setPhase(value, at = validateClock(clock)) {
    phase = value;
    phaseStartedAt = at;
  }

  function setTerminalPhase(value) {
    let at = phaseStartedAt;
    try { at = validateClock(clock); } catch { /* shutdown must survive a failed clock */ }
    setPhase(value, at);
  }

  function notifyStateChange() {
    if (onStateChange === null) return;
    try {
      // Diagnostics never participate in the intake/dispatch lifecycle.
      Promise.resolve(onStateChange(Object.freeze(snapshot()))).catch(() => {});
    } catch { /* diagnostic exceptions must not affect polling */ }
  }

  function throwIfAborted(signal) {
    if (stopRequested || signal?.aborted) throw new TelegramApiError('TELEGRAM_ABORTED');
  }

  function requireSynchronous(value) {
    if (value && typeof value.then === 'function') {
      Promise.resolve(value).catch(() => {});
      fail('TELEGRAM_LEDGER_INVALID');
    }
    return value;
  }

  const persistedPollerState = requireSynchronous(ledger.getPollerState());
  if (
    persistedPollerState === null
    || typeof persistedPollerState !== 'object'
    || Array.isArray(persistedPollerState)
  ) {
    fail('TELEGRAM_LEDGER_INVALID');
  }
  if (persistedPollerState.lastSuccessAt !== null) {
    if (!Number.isSafeInteger(persistedPollerState.lastSuccessAt) || persistedPollerState.lastSuccessAt < 0) {
      fail('TELEGRAM_LEDGER_INVALID');
    }
    lastSuccessAt = persistedPollerState.lastSuccessAt;
    lastProgressAt = lastSuccessAt;
  }
  if (persistedPollerState.duplicatePollerAt !== null) {
    if (
      !Number.isSafeInteger(persistedPollerState.duplicatePollerAt)
      || persistedPollerState.duplicatePollerAt < 0
    ) {
      fail('TELEGRAM_LEDGER_INVALID');
    }
    state = 'duplicate_poller';
    setPhase('duplicate_poller');
    lastErrorCode = 'TELEGRAM_CONFLICT';
  }

  function setFatal(error) {
    const wasFatal = state === 'fatal';
    state = 'fatal';
    active = false;
    nextRetryAt = null;
    lastErrorCode = safeErrorCode(error);
    setTerminalPhase('fatal');
    if (!wasFatal) notifyStateChange();
  }

  function probe(controlOptions = {}) {
    if (state === 'duplicate_poller' || state === 'fatal') {
      return Promise.reject(new TelegramPollerError('TELEGRAM_POLLER_UNAVAILABLE'));
    }
    if (stoppingPromise) {
      const rejected = Promise.reject(new TelegramPollerError('TELEGRAM_POLLER_STOPPING'));
      rejected.catch(() => {});
      return rejected;
    }
    let externalSignal;
    try {
      externalSignal = snapshotControlSignal(controlOptions);
    } catch (error) {
      const rejected = Promise.reject(error);
      rejected.catch(() => {});
      return rejected;
    }
    if (stoppingPromise) {
      const rejected = Promise.reject(new TelegramPollerError('TELEGRAM_POLLER_STOPPING'));
      rejected.catch(() => {});
      return rejected;
    }
    if (probed) return Promise.resolve(true);
    if (probePromise) return probePromise;
    const currentController = new AbortController();
    const forwardExternalAbort = () => currentController.abort('external');
    if (externalSignal?.aborted) forwardExternalAbort();
    else externalSignal?.addEventListener('abort', forwardExternalAbort, { once: true });
    probeController = currentController;
    state = 'probing';
    setPhase('probing');
    let current;
    current = (async () => {
      try {
        if (currentController.signal.aborted) throw new TelegramApiError('TELEGRAM_ABORTED');
        const identity = await client.getMe({ signal: currentController.signal });
        if (currentController.signal.aborted) throw new TelegramApiError('TELEGRAM_ABORTED');
        lastProgressAt = validateClock(clock);
        if (
          identity === null || typeof identity !== 'object' || Array.isArray(identity)
          || identity.is_bot !== true
        ) {
          fail('TELEGRAM_BOT_IDENTITY_INVALID');
        }
        const webhook = await client.getWebhookInfo({ signal: currentController.signal });
        if (currentController.signal.aborted) throw new TelegramApiError('TELEGRAM_ABORTED');
        lastProgressAt = validateClock(clock);
        if (
          webhook === null || typeof webhook !== 'object' || Array.isArray(webhook)
          || typeof webhook.url !== 'string'
        ) {
          fail('TELEGRAM_WEBHOOK_INFO_INVALID');
        }
        if (webhook.url !== '') fail('TELEGRAM_WEBHOOK_ACTIVE');
        probed = true;
        state = 'ready';
        setPhase('ready');
        lastErrorCode = null;
        return true;
      } catch (error) {
        if (currentController.signal.aborted && error?.code === 'TELEGRAM_ABORTED') {
          state = stopRequested ? 'stopping' : 'idle';
          setPhase(state);
        } else {
          setFatal(error);
        }
        throw error;
      } finally {
        externalSignal?.removeEventListener('abort', forwardExternalAbort);
        if (probeController === currentController) probeController = null;
        if (probePromise === current) probePromise = null;
      }
    })();
    probePromise = current;
    current.catch(() => {});
    return current;
  }

  function recordReceiptLag(prepared, receivedAt) {
    latestBatchReceiptLagMs = null;
    for (const item of prepared) {
      // Nested callback messages may be old/inaccessible and are not receipts.
      const date = item.updateType === 'message' ? item.payload.message?.date : undefined;
      if (!Number.isSafeInteger(date) || date <= 0 || !Number.isSafeInteger(date * 1000)) continue;
      const lag = Math.max(0, receivedAt - (date * 1000));
      latestBatchReceiptLagMs = Math.max(latestBatchReceiptLagMs ?? 0, lag);
      maxBatchReceiptLagMs = Math.max(maxBatchReceiptLagMs ?? 0, lag);
    }
  }

  async function dispatchBatch(prepared, signal) {
    throwIfAborted(signal);
    const dispatchController = new AbortController();
    let timer;
    let onAbort;
    const interrupted = new Promise((_resolve, reject) => {
      onAbort = () => {
        reject(new TelegramApiError('TELEGRAM_ABORTED'));
        dispatchController.abort('shutdown');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        // Reject the wait first so cooperative abort rejection cannot mask timeout.
        reject(new TelegramPollerError('TELEGRAM_DISPATCH_TIMEOUT'));
        dispatchController.abort('timeout');
      }, dispatchTimeoutMs);
    });
    const pending = Promise.resolve().then(() => {
      throwIfAborted(signal);
      return onBatch(Object.freeze(prepared), Object.freeze({ signal: dispatchController.signal }));
    });
    dispatchPromise = pending;
    const release = () => { if (dispatchPromise === pending) dispatchPromise = null; };
    // Consume late rejection; never replay, resume, or alter terminal diagnostics here.
    pending.then(release, release);
    try {
      setPhase('dispatching');
      notifyStateChange();
      await Promise.race([pending, interrupted]);
      throwIfAborted(signal);
    } catch (error) {
      if (safeErrorCode(error) === 'TELEGRAM_ABORTED' && (stopRequested || signal.aborted)) {
        setPhase(stopRequested ? 'stopping' : 'ready');
        notifyStateChange();
      } else {
        setFatal(error);
      }
      throw new TelegramPollerError(safeErrorCode(error));
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async function pollOnce(signal) {
    throwIfAborted(signal);
    setPhase('polling');
    const nextOffset = requireSynchronous(ledger.getNextOffset());
    const params = {
      limit,
      timeout: timeoutSec,
      allowedUpdates: [...ALLOWED_UPDATES],
      signal,
    };
    if (nextOffset !== null && nextOffset !== undefined) params.offset = nextOffset;
    throwIfAborted(signal);
    const updates = await client.getUpdates(params);
    const receivedAt = validateClock(clock);
    if (!Array.isArray(updates)) fail('TELEGRAM_UPDATES_INVALID');
    const prepared = updates.map(snapshotUpdate);
    recordReceiptLag(prepared, receivedAt);
    lastProgressAt = receivedAt;
    setPhase('persisting', receivedAt);
    const persisted = requireSynchronous(ledger.acceptBatch(prepared));
    lastProgressAt = validateClock(clock);
    // Even a late response is durable, but shutdown cannot admit new dispatch.
    throwIfAborted(signal);
    const dispatched = onBatch !== null && prepared.length > 0;
    if (dispatched) await dispatchBatch(prepared, signal);
    throwIfAborted(signal);
    const successAt = validateClock(clock);
    throwIfAborted(signal);
    requireSynchronous(ledger.recordPollerSuccess(successAt));
    lastSuccessAt = successAt;
    lastProgressAt = successAt;
    const reportSuccess = !hasPollSuccess || failureCount > 0 || dispatched;
    hasPollSuccess = true;
    failureCount = 0;
    backoffMs = 0;
    nextRetryAt = null;
    lastErrorCode = null;
    setPhase('ready', successAt);
    if (reportSuccess) notifyStateChange();
    return persisted;
  }

  function pollExclusively(signal) {
    if (pollPromise || dispatchPromise) return Promise.reject(new TelegramPollerError('TELEGRAM_POLL_IN_PROGRESS'));
    let current;
    current = (async () => {
      try {
        return await pollOnce(signal);
      } finally {
        if (pollPromise === current) pollPromise = null;
      }
    })();
    pollPromise = current;
    current.catch(() => {});
    return current;
  }

  function runOnce(controlOptions = {}) {
    try {
      const externalSignal = snapshotControlSignal(controlOptions);
      if (state === 'duplicate_poller' || state === 'fatal') {
        fail('TELEGRAM_POLLER_UNAVAILABLE');
      }
      if (stoppingPromise) fail('TELEGRAM_POLLER_STOPPING');
      if (loopPromise) fail('TELEGRAM_POLLER_ACTIVE');
      if (runPromise || dispatchPromise) fail('TELEGRAM_POLL_IN_PROGRESS');

      stopRequested = false;
      const currentController = new AbortController();
      const forwardExternalAbort = () => currentController.abort('external');
      if (externalSignal?.aborted) forwardExternalAbort();
      else externalSignal?.addEventListener('abort', forwardExternalAbort, { once: true });
      runController = currentController;

      let current;
      current = (async () => {
        try {
          if (currentController.signal.aborted) throw new TelegramApiError('TELEGRAM_ABORTED');
          await probe({ signal: currentController.signal });
          if (currentController.signal.aborted) throw new TelegramApiError('TELEGRAM_ABORTED');
          return await pollExclusively(currentController.signal);
        } finally {
          externalSignal?.removeEventListener('abort', forwardExternalAbort);
          if (runController === currentController) runController = null;
          if (runPromise === current) runPromise = null;
        }
      })();
      runPromise = current;
      current.catch(() => {});
      return current;
    } catch (error) {
      const rejected = Promise.reject(error);
      rejected.catch(() => {});
      return rejected;
    }
  }

  function retryDelay(error) {
    if (error?.code === 'TELEGRAM_RATE_LIMIT') {
      if (!Number.isSafeInteger(error.retryAfterSec) || error.retryAfterSec < 0) {
        return null;
      }
      failureCount += 1;
      return (error.retryAfterSec * 1000) + Math.floor(randomFraction(random) * 1000);
    }
    if (
      error?.code === 'TELEGRAM_NETWORK'
      || error?.code === 'TELEGRAM_TIMEOUT'
      || error?.code === 'TELEGRAM_SERVER'
    ) {
      failureCount += 1;
      const base = Math.min(30_000, 1000 * (2 ** Math.min(failureCount - 1, 10)));
      return Math.min(30_000, base + Math.floor(randomFraction(random) * Math.min(1000, base / 4)));
    }
    return null;
  }

  function start() {
    if (stoppingPromise) {
      const rejected = Promise.reject(new TelegramPollerError('TELEGRAM_POLLER_STOPPING'));
      rejected.catch(() => {});
      return rejected;
    }
    if (loopPromise) return loopPromise;
    if (state === 'duplicate_poller' || state === 'fatal') return Promise.resolve();
    if (runPromise || pollPromise || dispatchPromise) {
      const rejected = Promise.reject(new TelegramPollerError('TELEGRAM_POLL_IN_PROGRESS'));
      rejected.catch(() => {});
      return rejected;
    }
    stopRequested = false;
    hasPollSuccess = false;
    controller = new AbortController();
    const current = (async () => {
      active = true;
      try {
        await probe({ signal: controller.signal });
        if (stopRequested) return;
        state = 'running';
        while (!stopRequested) {
          try {
            await pollExclusively(controller.signal);
            if (!stopRequested) state = 'running';
          } catch (error) {
            if (stopRequested && (error?.code === 'TELEGRAM_ABORTED' || controller.signal.aborted)) {
              break;
            }
            if (state === 'fatal') break;
            lastErrorCode = safeErrorCode(error);
            if (error?.code === 'TELEGRAM_CONFLICT' && error.conflictKind === 'duplicate_poller') {
              try {
                requireSynchronous(ledger.recordDuplicatePoller(validateClock(clock)));
                state = 'duplicate_poller';
                setPhase('duplicate_poller');
                notifyStateChange();
              } catch (persistError) {
                setFatal(persistError);
              }
              break;
            }
            const delay = retryDelay(error);
            if (delay === null) {
              setFatal(error);
              break;
            }
            backoffMs = delay;
            state = 'backoff';
            setPhase('backoff');
            nextRetryAt = phaseStartedAt + delay;
            notifyStateChange();
            try {
              await waitWithAbort(sleep, delay, controller.signal);
              nextRetryAt = null;
              if (!stopRequested) {
                state = 'running';
                setPhase('polling');
                notifyStateChange();
              }
            } catch (sleepError) {
              if (!stopRequested && sleepError?.code !== 'TELEGRAM_ABORTED') {
                setFatal(sleepError);
              }
              break;
            }
          }
        }
      } catch (error) {
        if (!stopRequested) setFatal(error);
      } finally {
        active = false;
        controller = null;
        nextRetryAt = null;
        if (stopRequested && state !== 'duplicate_poller' && state !== 'fatal') {
          state = 'stopped';
          setTerminalPhase('stopped');
        }
        if (loopPromise === current) loopPromise = null;
      }
    })();
    loopPromise = current;
    current.catch(() => {});
    return current;
  }

  function stop() {
    if (stoppingPromise) return stoppingPromise;
    stopRequested = true;
    nextRetryAt = null;
    if (state !== 'duplicate_poller' && state !== 'fatal') {
      state = 'stopping';
      setTerminalPhase('stopping');
    }
    let resolveBarrier;
    const barrier = new Promise((resolve) => { resolveBarrier = resolve; });
    stoppingPromise = barrier;
    const pending = [probePromise, loopPromise, runPromise].filter(Boolean);
    probeController?.abort('shutdown');
    controller?.abort('shutdown');
    runController?.abort('shutdown');
    Promise.allSettled(pending).then(() => {
      if (state !== 'duplicate_poller' && state !== 'fatal') {
        state = 'stopped';
        setTerminalPhase('stopped');
      }
      if (stoppingPromise === barrier) stoppingPromise = null;
      resolveBarrier();
    });
    barrier.catch(() => {});
    return barrier;
  }

  function snapshot() {
    const now = validateClock(clock);
    const pollBudgetMs = (timeoutSec * 1000) + NETWORK_GRACE_MS;
    const staleAfterMs = phase === 'dispatching' ? dispatchTimeoutMs
      : phase === 'polling' || phase === 'probing' ? pollBudgetMs
        : phase === 'backoff' ? backoffMs : pollBudgetMs + dispatchTimeoutMs;
    const freshnessAt = ['polling', 'probing', 'persisting', 'dispatching', 'backoff'].includes(phase)
      ? phaseStartedAt : (lastProgressAt ?? phaseStartedAt);
    return {
      state,
      active,
      probed,
      failureCount,
      lastErrorCode,
      lastSuccessAt,
      backoffMs,
      possibleGap: lastSuccessAt !== null && now - lastSuccessAt > POSSIBLE_GAP_MS,
      phase,
      phaseStartedAt,
      lastProgressAt,
      nextRetryAt,
      latestBatchReceiptLagMs,
      maxBatchReceiptLagMs,
      stale: nextRetryAt !== null ? now > nextRetryAt : now - freshnessAt > staleAfterMs,
      staleAfterMs,
    };
  }

  return Object.freeze({ probe, runOnce, snapshot, start, stop });
}

module.exports = {
  TelegramPollerError,
  createTelegramPoller,
};
