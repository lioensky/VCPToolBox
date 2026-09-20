'use strict';

const CHAT_ID_PATTERN = /^-?[1-9]\d*$/;
const THREAD_ID_PATTERN = /^(?:0|[1-9]\d*)$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ORDERING_KEY_PATTERN = /^telegram:-?[1-9]\d*:(?:0|[1-9]\d*)$/;

class QueueError extends Error {
  constructor(code) {
    super('Telegram scope queue operation failed.');
    Object.defineProperty(this, 'name', { value: 'QueueError' });
    this.code = code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, QueueError);
  }
}

function fail(code) {
  throw new QueueError(code);
}

function orderingKeyFor(chatId, threadId = '0') {
  if (
    typeof chatId !== 'string'
    || !CHAT_ID_PATTERN.test(chatId)
    || typeof threadId !== 'string'
    || !THREAD_ID_PATTERN.test(threadId)
  ) {
    fail('QUEUE_INPUT_INVALID');
  }
  return `telegram:${chatId}:${threadId}`;
}

function createScopeQueue(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('QUEUE_CONFIG_INVALID');
  }
  const { maxConcurrentScopes, maxQueuedTotal, maxQueuedPerScope } = options;
  if (
    !Number.isSafeInteger(maxConcurrentScopes) || maxConcurrentScopes < 1
    || !Number.isSafeInteger(maxQueuedTotal) || maxQueuedTotal < 1
    || !Number.isSafeInteger(maxQueuedPerScope) || maxQueuedPerScope < 1
    || maxQueuedPerScope > maxQueuedTotal
  ) {
    fail('QUEUE_CONFIG_INVALID');
  }

  const lanes = new Map();
  const active = new Map();
  const readyKeys = [];
  const drainWaiters = [];
  let runningCount = 0;
  let draining = false;
  let scheduled = false;

  function removeReadyKey(orderingKey) {
    let index;
    while ((index = readyKeys.indexOf(orderingKey)) !== -1) readyKeys.splice(index, 1);
  }

  function addReadyKey(orderingKey) {
    if (!readyKeys.includes(orderingKey)) readyKeys.push(orderingKey);
  }

  function resolveDrainWaiters() {
    if (!draining || runningCount !== 0) return;
    for (const resolve of drainWaiters.splice(0)) resolve();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      dispatch();
    });
  }

  async function execute(task, lane) {
    try {
      const value = await task.run({
        requestId: task.requestId,
        orderingKey: task.orderingKey,
        signal: task.controller.signal,
      });
      task.resolve(value);
    } catch (error) {
      task.reject(error);
    } finally {
      active.delete(task.requestId);
      runningCount -= 1;
      lane.running = null;
      if (lane.queue.length > 0 && !draining) {
        addReadyKey(task.orderingKey);
      } else if (lane.queue.length === 0) {
        lanes.delete(task.orderingKey);
      }
      resolveDrainWaiters();
      schedule();
    }
  }

  function dispatch() {
    if (draining) {
      resolveDrainWaiters();
      return;
    }
    while (runningCount < maxConcurrentScopes && readyKeys.length > 0) {
      const orderingKey = readyKeys.shift();
      const lane = lanes.get(orderingKey);
      if (!lane || lane.running !== null || lane.queue.length === 0) continue;
      const task = lane.queue.shift();
      task.state = 'running';
      lane.running = task;
      runningCount += 1;
      void execute(task, lane);
    }
  }

  function enqueue(input = {}) {
    if (draining) fail('QUEUE_DRAINING');
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      fail('QUEUE_INPUT_INVALID');
    }
    let requestId;
    let orderingKey;
    let run;
    try {
      requestId = input.requestId;
      orderingKey = input.orderingKey;
      run = input.run;
    } catch {
      fail('QUEUE_INPUT_INVALID');
    }
    if (
      typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)
      || typeof orderingKey !== 'string' || !ORDERING_KEY_PATTERN.test(orderingKey)
      || typeof run !== 'function'
    ) {
      fail('QUEUE_INPUT_INVALID');
    }
    if (active.has(requestId)) fail('QUEUE_DUPLICATE');
    let lane = lanes.get(orderingKey);
    const laneSize = lane ? lane.queue.length + (lane.running ? 1 : 0) : 0;
    if (active.size >= maxQueuedTotal || laneSize >= maxQueuedPerScope) fail('QUEUE_LIMIT');
    if (draining) fail('QUEUE_DRAINING');
    if (!lane) {
      lane = { queue: [], running: null };
      lanes.set(orderingKey, lane);
    }
    let resolve;
    let reject;
    const result = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    void result.catch(() => {});
    const task = {
      requestId,
      orderingKey,
      run,
      resolve,
      reject,
      result,
      state: 'queued',
      controller: new AbortController(),
    };
    active.set(requestId, task);
    lane.queue.push(task);
    if (lane.running === null) addReadyKey(orderingKey);
    schedule();
    return Object.freeze({ requestId, orderingKey, result });
  }

  function cancel(requestId, reason = 'cancelled') {
    if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
      fail('QUEUE_INPUT_INVALID');
    }
    const task = active.get(requestId);
    if (!task) return { changed: false, currentState: null };
    const lane = lanes.get(task.orderingKey);
    if (task.state === 'running') {
      if (task.controller.signal.aborted) return { changed: false, currentState: 'running' };
      task.controller.abort(reason);
      return { changed: true, state: 'running' };
    }
    const index = lane.queue.indexOf(task);
    if (index !== -1) lane.queue.splice(index, 1);
    active.delete(requestId);
    task.state = 'cancelled';
    task.reject(new QueueError('QUEUE_CANCELLED'));
    if (lane.queue.length === 0 && lane.running === null) {
      lanes.delete(task.orderingKey);
      removeReadyKey(task.orderingKey);
    }
    return { changed: true, state: 'queued' };
  }

  function beginDrain() {
    if (!draining) {
      draining = true;
      readyKeys.splice(0);
      for (const [orderingKey, lane] of lanes) {
        for (const task of lane.queue.splice(0)) {
          active.delete(task.requestId);
          task.state = 'drained';
          task.reject(new QueueError('QUEUE_DRAINING'));
        }
        if (lane.running === null) lanes.delete(orderingKey);
      }
    }
    if (runningCount === 0) return Promise.resolve();
    return new Promise((resolve) => drainWaiters.push(resolve));
  }

  function snapshot() {
    const laneSnapshots = [...lanes.entries()].map(([orderingKey, lane]) => ({
      orderingKey,
      runningRequestId: lane.running?.requestId ?? null,
      queuedRequestIds: lane.queue.map((task) => task.requestId),
    })).sort((left, right) => left.orderingKey.localeCompare(right.orderingKey));
    return {
      draining,
      running: runningCount,
      queued: active.size - runningCount,
      total: active.size,
      lanes: laneSnapshots,
    };
  }

  return Object.freeze({ beginDrain, cancel, enqueue, snapshot });
}

module.exports = {
  QueueError,
  createScopeQueue,
  orderingKeyFor,
};
