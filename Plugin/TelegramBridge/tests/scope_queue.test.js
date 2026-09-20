'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const { QueueError, createScopeQueue, orderingKeyFor } = require('../src/scopeQueue');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function assertQueueError(error, code) {
  assert.equal(error instanceof QueueError, true);
  assert.equal(error.code, code);
  assert.deepEqual(Object.keys(error), ['code']);
  return true;
}

test('ordering keys preserve large Telegram IDs and deliberately exclude Agent', () => {
  assert.equal(orderingKeyFor('-100900719925474099312345', '77'), 'telegram:-100900719925474099312345:77');
  assert.equal(orderingKeyFor('42'), 'telegram:42:0');
  assert.throws(() => orderingKeyFor('42', '0:ExampleAgent'), (error) => assertQueueError(error, 'QUEUE_INPUT_INVALID'));
});

test('same-key work is FIFO while different keys run concurrently within the global cap', async () => {
  const queue = createScopeQueue({ maxConcurrentScopes: 2, maxQueuedTotal: 10, maxQueuedPerScope: 5 });
  const gates = [deferred(), deferred(), deferred()];
  const events = [];
  const a1 = queue.enqueue({ requestId: 'a1', orderingKey: 'telegram:1:0', run: async () => {
    events.push('a1:start'); await gates[0].promise; events.push('a1:end'); return 'a1';
  } });
  const a2 = queue.enqueue({ requestId: 'a2', orderingKey: 'telegram:1:0', run: async () => {
    events.push('a2:start'); await gates[1].promise; events.push('a2:end'); return 'a2';
  } });
  const b1 = queue.enqueue({ requestId: 'b1', orderingKey: 'telegram:2:0', run: async () => {
    events.push('b1:start'); await gates[2].promise; events.push('b1:end'); return 'b1';
  } });

  await Promise.resolve();
  assert.deepEqual(events, ['a1:start', 'b1:start']);
  assert.equal(queue.snapshot().running, 2);
  gates[0].resolve();
  assert.equal(await a1.result, 'a1');
  await Promise.resolve();
  assert.equal(events.includes('a2:start'), true);
  gates[1].resolve(); gates[2].resolve();
  assert.deepEqual(await Promise.all([a2.result, b1.result]), ['a2', 'b1']);
  assert.deepEqual(queue.snapshot(), { draining: false, running: 0, queued: 0, total: 0, lanes: [] });
});

test('ready lanes are scheduled round-robin instead of letting one scope monopolize the queue', async () => {
  const queue = createScopeQueue({ maxConcurrentScopes: 1, maxQueuedTotal: 10, maxQueuedPerScope: 5 });
  const order = [];
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const tasks = [
    ['a1', 'telegram:1:0', 0],
    ['a2', 'telegram:1:0', 1],
    ['b1', 'telegram:2:0', 2],
    ['c1', 'telegram:3:0', 3],
  ].map(([requestId, orderingKey, gate]) => queue.enqueue({
    requestId,
    orderingKey,
    run: async () => { order.push(requestId); await gates[gate].promise; return requestId; },
  }));

  await Promise.resolve();
  for (const index of [0, 2, 3, 1]) {
    gates[index].resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
  await Promise.all(tasks.map((task) => task.result));
  assert.deepEqual(order, ['a1', 'b1', 'c1', 'a2']);
});

test('duplicate active requests and total or per-scope overflow fail synchronously', async () => {
  const queue = createScopeQueue({ maxConcurrentScopes: 1, maxQueuedTotal: 2, maxQueuedPerScope: 1 });
  const gate = deferred();
  const first = queue.enqueue({ requestId: 'one', orderingKey: 'telegram:1:0', run: () => gate.promise });
  assert.throws(
    () => queue.enqueue({ requestId: 'one', orderingKey: 'telegram:2:0', run: async () => {} }),
    (error) => assertQueueError(error, 'QUEUE_DUPLICATE'),
  );
  assert.throws(
    () => queue.enqueue({ requestId: 'two', orderingKey: 'telegram:1:0', run: async () => {} }),
    (error) => assertQueueError(error, 'QUEUE_LIMIT'),
  );
  const second = queue.enqueue({ requestId: 'two', orderingKey: 'telegram:2:0', run: async () => 'two' });
  assert.throws(
    () => queue.enqueue({ requestId: 'three', orderingKey: 'telegram:3:0', run: async () => {} }),
    (error) => assertQueueError(error, 'QUEUE_LIMIT'),
  );
  gate.resolve('one');
  assert.deepEqual(await Promise.all([first.result, second.result]), ['one', 'two']);
});

test('queued cancellation is isolated and running cancellation holds its slot until settlement', async () => {
  const queue = createScopeQueue({ maxConcurrentScopes: 1, maxQueuedTotal: 5, maxQueuedPerScope: 5 });
  const runningGate = deferred();
  let runningSignal;
  const running = queue.enqueue({ requestId: 'running', orderingKey: 'telegram:1:0', run: async ({ signal }) => {
    runningSignal = signal;
    return runningGate.promise;
  } });
  const queued = queue.enqueue({ requestId: 'queued', orderingKey: 'telegram:2:0', run: async () => 'never' });
  await Promise.resolve();

  assert.deepEqual(queue.cancel('queued', 'operator-stop'), { changed: true, state: 'queued' });
  await assert.rejects(queued.result, (error) => assertQueueError(error, 'QUEUE_CANCELLED'));
  assert.deepEqual(queue.cancel('running', 'operator-stop'), { changed: true, state: 'running' });
  assert.equal(runningSignal.aborted, true);
  assert.equal(queue.snapshot().running, 1);
  runningGate.resolve('settled');
  assert.equal(await running.result, 'settled');
  assert.equal(queue.snapshot().running, 0);
});

test('throw, rejection, and abort always release counters and lane capacity', async () => {
  const queue = createScopeQueue({ maxConcurrentScopes: 1, maxQueuedTotal: 1, maxQueuedPerScope: 1 });
  const failed = queue.enqueue({ requestId: 'failed', orderingKey: 'telegram:1:0', run: async () => {
    throw new Error('fixture failure');
  } });
  await assert.rejects(failed.result, /fixture failure/);
  assert.equal(queue.snapshot().total, 0);

  const aborted = queue.enqueue({ requestId: 'aborted', orderingKey: 'telegram:1:0', run: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  await Promise.resolve();
  queue.cancel('aborted');
  await assert.rejects(aborted.result, /aborted/);
  assert.equal(queue.snapshot().total, 0);
});

test('drain rejects new admission, releases queued tasks, and waits for running work only', async () => {
  const queue = createScopeQueue({ maxConcurrentScopes: 1, maxQueuedTotal: 5, maxQueuedPerScope: 5 });
  const gate = deferred();
  const running = queue.enqueue({ requestId: 'running', orderingKey: 'telegram:1:0', run: () => gate.promise });
  const queued = queue.enqueue({ requestId: 'queued', orderingKey: 'telegram:2:0', run: async () => 'never' });
  await Promise.resolve();
  const drained = queue.beginDrain();

  await assert.rejects(queued.result, (error) => assertQueueError(error, 'QUEUE_DRAINING'));
  assert.throws(
    () => queue.enqueue({ requestId: 'late', orderingKey: 'telegram:3:0', run: async () => {} }),
    (error) => assertQueueError(error, 'QUEUE_DRAINING'),
  );
  assert.equal(queue.snapshot().running, 1);
  gate.resolve('done');
  assert.equal(await running.result, 'done');
  await drained;
  assert.deepEqual(queue.snapshot(), { draining: true, running: 0, queued: 0, total: 0, lanes: [] });
});

test('hostile enqueue accessors are converted to stable queue errors', () => {
  const queue = createScopeQueue({ maxConcurrentScopes: 1, maxQueuedTotal: 1, maxQueuedPerScope: 1 });
  const hostile = {};
  Object.defineProperty(hostile, 'requestId', {
    enumerable: true,
    get() { throw new Error('QUEUE-GETTER-SECRET-778899'); },
  });
  assert.throws(
    () => queue.enqueue(hostile),
    (error) => assertQueueError(error, 'QUEUE_INPUT_INVALID'),
  );
});

test('enqueue rechecks draining after reentrant input getters before admitting work', () => {
  const queue = createScopeQueue({ maxConcurrentScopes: 1, maxQueuedTotal: 1, maxQueuedPerScope: 1 });
  const input = {
    orderingKey: 'telegram:1:0',
    run: async () => 'never',
  };
  Object.defineProperty(input, 'requestId', {
    enumerable: true,
    get() {
      void queue.beginDrain();
      return 'reentrant';
    },
  });

  assert.throws(
    () => queue.enqueue(input),
    (error) => assertQueueError(error, 'QUEUE_DRAINING'),
  );
  assert.deepEqual(queue.snapshot(), {
    draining: true,
    running: 0,
    queued: 0,
    total: 0,
    lanes: [],
  });
});

test('queued cancel and drain remain caller-visible without a strict unhandled-rejection window', () => {
  const modulePath = path.resolve(__dirname, '..', 'src', 'scopeQueue.js');
  const script = `
    'use strict';
    const { createScopeQueue } = require(${JSON.stringify(modulePath)});
    const immediate = () => new Promise((resolve) => setImmediate(resolve));
    const gate = () => {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      return { promise, release };
    };
    (async () => {
      const firstGate = gate();
      const firstQueue = createScopeQueue({
        maxConcurrentScopes: 1,
        maxQueuedTotal: 3,
        maxQueuedPerScope: 3,
      });
      const firstRunning = firstQueue.enqueue({
        requestId: 'cancel-running',
        orderingKey: 'telegram:1:0',
        run: () => firstGate.promise,
      });
      const cancelled = firstQueue.enqueue({
        requestId: 'cancel-queued',
        orderingKey: 'telegram:2:0',
        run: async () => 'never',
      });
      await Promise.resolve();
      firstQueue.cancel('cancel-queued');
      await immediate();
      try {
        await cancelled.result;
        process.exitCode = 21;
        return;
      } catch (error) {
        if (error.code !== 'QUEUE_CANCELLED') {
          process.exitCode = 22;
          return;
        }
      }
      firstGate.release('done');
      await firstRunning.result;

      const secondGate = gate();
      const secondQueue = createScopeQueue({
        maxConcurrentScopes: 1,
        maxQueuedTotal: 3,
        maxQueuedPerScope: 3,
      });
      const secondRunning = secondQueue.enqueue({
        requestId: 'drain-running',
        orderingKey: 'telegram:3:0',
        run: () => secondGate.promise,
      });
      const drainedTask = secondQueue.enqueue({
        requestId: 'drain-queued',
        orderingKey: 'telegram:4:0',
        run: async () => 'never',
      });
      await Promise.resolve();
      const drained = secondQueue.beginDrain();
      await immediate();
      try {
        await drainedTask.result;
        process.exitCode = 23;
        return;
      } catch (error) {
        if (error.code !== 'QUEUE_DRAINING') {
          process.exitCode = 24;
          return;
        }
      }
      secondGate.release('done');
      await secondRunning.result;
      await drained;
    })().catch(() => { process.exitCode = 25; });
  `;
  const child = spawnSync(process.execPath, [
    '--unhandled-rejections=strict',
    '-e',
    script,
  ], { encoding: 'utf8' });

  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.equal(child.signal, null);
});
