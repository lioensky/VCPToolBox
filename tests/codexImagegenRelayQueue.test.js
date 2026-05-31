const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  FIXED_ASSET_RETURN_DIR,
  PROTOCOL,
  CodexImagegenRelayError,
  createCodexImagegenRelayQueue,
} = require('../modules/codexImagegenRelayQueue');

async function createTempQueue(t, now = () => new Date('2026-05-31T10:00:00.000Z')) {
  const queueRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-codex-imagegen-relay-'));
  t.after(async () => {
    await fs.rm(queueRoot, { recursive: true, force: true });
  });
  const queue = createCodexImagegenRelayQueue({ queueRoot, now });
  await queue.initialize();
  return { queue, queueRoot };
}

async function writeStatusFile(queueRoot, status, requestId, payload) {
  const dirPath = path.join(queueRoot, status);
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(
    path.join(dirPath, `${requestId}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8'
  );
}

test('codex imagegen relay creates and lists pending requests in an injected queue root', async (t) => {
  const { queue, queueRoot } = await createTempQueue(t);

  const request = await queue.createRequest({
    request_id: 'img_test_001',
    prompt: 'A clean product photo of a glass cube',
    options: {
      size: 'auto',
      quality: 'high',
      output_format: 'png',
    },
  });

  assert.equal(request.protocol, PROTOCOL);
  assert.equal(request.request_id, 'img_test_001');
  assert.equal(request.status, 'pending');
  assert.equal(request.directory_status, 'pending');
  assert.equal(request.return.target_dir, FIXED_ASSET_RETURN_DIR);
  assert.deepEqual(request.options, {
    size: 'auto',
    quality: 'high',
    output_format: 'png',
  });

  const pendingPath = path.join(queueRoot, 'pending', 'img_test_001.json');
  assert.equal(JSON.parse(await fs.readFile(pendingPath, 'utf8')).status, 'pending');

  const requests = await queue.listRequests({ status: 'pending' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request_id, 'img_test_001');
});

test('codex imagegen relay rejects unsupported request fields and active idempotency conflicts', async (t) => {
  const { queue } = await createTempQueue(t);

  await queue.createRequest({
    request_id: 'img_test_002',
    idempotency_key: 'idem_test_002',
    prompt: 'first request',
  });

  await assert.rejects(
    () => queue.createRequest({
      request_id: 'img_test_003',
      idempotency_key: 'idem_test_002',
      prompt: 'duplicate idempotency key',
    }),
    (error) => error instanceof CodexImagegenRelayError
      && error.code === 'idempotency_conflict'
      && error.statusCode === 409
  );

  await assert.rejects(
    () => queue.createRequest({
      request_id: 'img_test_004',
      prompt: 'secret reject',
      token: 'do-not-store',
    }),
    (error) => error instanceof CodexImagegenRelayError
      && error.code === 'secret_like_field_rejected'
  );

  await assert.rejects(
    () => queue.createRequest({
      request_id: 'img_test_005',
      prompt: 'reference image reject',
      reference_images: [],
    }),
    (error) => error instanceof CodexImagegenRelayError
      && error.code === 'reference_images_disabled'
  );
});

test('codex imagegen relay rejects concurrent creates for the same request id without overwriting', async (t) => {
  const { queue, queueRoot } = await createTempQueue(t);

  let seen = 0;
  let releaseBarrier;
  const barrier = new Promise((resolve) => {
    releaseBarrier = resolve;
  });
  queue.findByIdempotencyKey = async () => {
    seen += 1;
    if (seen === 2) {
      releaseBarrier();
    }
    await barrier;
    return null;
  };

  const results = await Promise.allSettled([
    queue.createRequest({
      request_id: 'img_race_001',
      idempotency_key: 'idem_race_a',
      prompt: 'first payload wins or second payload wins, but never both',
    }),
    queue.createRequest({
      request_id: 'img_race_001',
      idempotency_key: 'idem_race_b',
      prompt: 'competing payload must not overwrite',
    }),
  ]);

  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof CodexImagegenRelayError);
  assert.equal(rejected[0].reason.code, 'request_id_conflict');
  assert.equal(rejected[0].reason.statusCode, 409);

  const persisted = JSON.parse(
    await fs.readFile(path.join(queueRoot, 'pending', 'img_race_001.json'), 'utf8')
  );
  assert.equal(persisted.prompt, fulfilled[0].value.prompt);

  const pendingEntries = await fs.readdir(path.join(queueRoot, 'pending'));
  assert.deepEqual(pendingEntries, ['img_race_001.json']);
});

test('codex imagegen relay serializes concurrent creates for the same idempotency key', async (t) => {
  const { queue, queueRoot } = await createTempQueue(t);

  const results = await Promise.allSettled([
    queue.createRequest({
      request_id: 'img_idem_race_001',
      idempotency_key: 'idem_race_shared',
      prompt: 'first idempotent payload',
    }),
    queue.createRequest({
      request_id: 'img_idem_race_002',
      idempotency_key: 'idem_race_shared',
      prompt: 'duplicate idempotent payload',
    }),
  ]);

  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof CodexImagegenRelayError);
  assert.equal(rejected[0].reason.code, 'idempotency_conflict');
  assert.equal(rejected[0].reason.statusCode, 409);

  const pendingEntries = await fs.readdir(path.join(queueRoot, 'pending'));
  assert.equal(pendingEntries.length, 1);
  const persisted = JSON.parse(
    await fs.readFile(path.join(queueRoot, 'pending', pendingEntries[0]), 'utf8')
  );
  assert.equal(persisted.idempotency_key, 'idem_race_shared');
});

test('codex imagegen relay rejects request id reuse across all status directories', async (t) => {
  const { queue, queueRoot } = await createTempQueue(t);
  await writeStatusFile(queueRoot, 'done', 'img_done_reuse_001', {
    protocol: PROTOCOL,
    request_id: 'img_done_reuse_001',
    created_at: '2026-05-31T09:00:00.000Z',
    status: 'done',
    mode: 'generate',
    prompt: 'already completed',
    attempt: 1,
    idempotency_key: 'idem_done_reuse_001',
  });

  await assert.rejects(
    () => queue.createRequest({
      request_id: 'img_done_reuse_001',
      idempotency_key: 'idem_done_reuse_002',
      prompt: 'must not reuse a done request id',
    }),
    (error) => error instanceof CodexImagegenRelayError
      && error.code === 'request_id_conflict'
      && error.statusCode === 409
      && error.details.status === 'done'
  );
});

test('codex imagegen relay cancels pending requests without touching claimed records', async (t) => {
  const { queue } = await createTempQueue(t);
  await queue.createRequest({
    request_id: 'img_cancel_001',
    prompt: 'cancel me',
  });

  const cancelled = await queue.cancelRequest('img_cancel_001', {
    reason: 'operator changed mind',
    cancelled_by: 'admin-root',
  });

  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancel_reason, 'operator changed mind');
  assert.equal(cancelled.cancelled_by, 'admin-root');
  await assert.rejects(
    () => queue.getRequest('img_missing'),
    (error) => error.code === 'request_not_found'
  );

  await assert.rejects(
    () => queue.cancelRequest('img_cancel_001'),
    (error) => error.code === 'invalid_request_state'
      && error.statusCode === 409
  );
});

test('codex imagegen relay retries failed requests into a new pending request', async (t) => {
  const { queue, queueRoot } = await createTempQueue(t);
  await writeStatusFile(queueRoot, 'failed', 'img_failed_001', {
    protocol: PROTOCOL,
    request_id: 'img_failed_001',
    created_at: '2026-05-31T09:00:00.000Z',
    status: 'failed',
    mode: 'generate',
    prompt: 'retry this image',
    options: { quality: 'high' },
    return: { preferred: 'file', target_dir: FIXED_ASSET_RETURN_DIR },
    attempt: 1,
    idempotency_key: 'idem_retry_001',
    error: {
      code: 'CODEX_IMAGEGEN_UNAVAILABLE',
      message: 'unavailable',
      retryable: true,
    },
  });

  const retry = await queue.retryRequest('img_failed_001');

  assert.equal(retry.status, 'pending');
  assert.equal(retry.parent_request_id, 'img_failed_001');
  assert.equal(retry.attempt, 2);
  assert.equal(retry.idempotency_key, 'idem_retry_001');
  assert.equal(retry.prompt, 'retry this image');
});

test('codex imagegen relay rejects retrying superseded failed parents', async (t) => {
  const { queue, queueRoot } = await createTempQueue(t);
  await writeStatusFile(queueRoot, 'failed', 'img_retry_parent_001', {
    protocol: PROTOCOL,
    request_id: 'img_retry_parent_001',
    created_at: '2026-05-31T09:00:00.000Z',
    status: 'failed',
    mode: 'generate',
    prompt: 'retry parent',
    attempt: 1,
    idempotency_key: 'idem_retry_chain_001',
  });
  await writeStatusFile(queueRoot, 'failed', 'img_retry_child_001', {
    protocol: PROTOCOL,
    request_id: 'img_retry_child_001',
    parent_request_id: 'img_retry_parent_001',
    created_at: '2026-05-31T09:05:00.000Z',
    status: 'failed',
    mode: 'generate',
    prompt: 'retry child',
    attempt: 2,
    idempotency_key: 'idem_retry_chain_001',
  });

  await assert.rejects(
    () => queue.retryRequest('img_retry_parent_001'),
    (error) => error instanceof CodexImagegenRelayError
      && error.code === 'retry_superseded'
      && error.statusCode === 409
      && error.details.request_id === 'img_retry_child_001'
  );

  const retry = await queue.retryRequest('img_retry_child_001');

  assert.equal(retry.status, 'pending');
  assert.equal(retry.parent_request_id, 'img_retry_child_001');
  assert.equal(retry.attempt, 3);
  assert.equal(retry.idempotency_key, 'idem_retry_chain_001');
});

test('codex imagegen relay serializes concurrent retries for the same failed request', async (t) => {
  const { queue, queueRoot } = await createTempQueue(t);
  await writeStatusFile(queueRoot, 'failed', 'img_retry_race_001', {
    protocol: PROTOCOL,
    request_id: 'img_retry_race_001',
    created_at: '2026-05-31T09:00:00.000Z',
    status: 'failed',
    mode: 'generate',
    prompt: 'retry race',
    attempt: 1,
    idempotency_key: 'idem_retry_race_001',
  });

  const originalAtomicWriteJson = queue.atomicWriteJson.bind(queue);
  let writeCount = 0;
  let releaseWrites;
  const writeBarrier = new Promise((resolve) => {
    releaseWrites = resolve;
  });
  queue.atomicWriteJson = async (...args) => {
    writeCount += 1;
    if (writeCount === 1) {
      setTimeout(releaseWrites, 25);
    } else {
      releaseWrites();
    }
    await writeBarrier;
    return originalAtomicWriteJson(...args);
  };

  const results = await Promise.allSettled([
    queue.retryRequest('img_retry_race_001'),
    queue.retryRequest('img_retry_race_001'),
  ]);

  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof CodexImagegenRelayError);
  assert.equal(rejected[0].reason.code, 'idempotency_conflict');
  assert.equal(rejected[0].reason.statusCode, 409);
  assert.equal(writeCount, 1);

  const pendingEntries = await fs.readdir(path.join(queueRoot, 'pending'));
  assert.equal(pendingEntries.length, 1);
  const retry = JSON.parse(
    await fs.readFile(path.join(queueRoot, 'pending', pendingEntries[0]), 'utf8')
  );
  assert.equal(retry.parent_request_id, 'img_retry_race_001');
  assert.equal(retry.idempotency_key, 'idem_retry_race_001');
});

test('codex imagegen relay counts retry attempts across the idempotency chain', async (t) => {
  const { queue, queueRoot } = await createTempQueue(t);
  await writeStatusFile(queueRoot, 'failed', 'img_retry_parent_002', {
    protocol: PROTOCOL,
    request_id: 'img_retry_parent_002',
    created_at: '2026-05-31T09:00:00.000Z',
    status: 'failed',
    mode: 'generate',
    prompt: 'retry parent at max',
    attempt: 1,
    idempotency_key: 'idem_retry_chain_002',
  });
  await writeStatusFile(queueRoot, 'failed', 'img_retry_child_002', {
    protocol: PROTOCOL,
    request_id: 'img_retry_child_002',
    parent_request_id: 'img_retry_parent_002',
    created_at: '2026-05-31T09:05:00.000Z',
    status: 'failed',
    mode: 'generate',
    prompt: 'retry child at max',
    attempt: 3,
    idempotency_key: 'idem_retry_chain_002',
  });

  await assert.rejects(
    () => queue.retryRequest('img_retry_child_002'),
    (error) => error instanceof CodexImagegenRelayError
      && error.code === 'max_attempts_exceeded'
      && error.statusCode === 409
  );
});

test('codex imagegen relay marks artifact_ready as done only for existing safe asset files', async (t) => {
  const { queue, queueRoot } = await createTempQueue(t);
  await writeStatusFile(queueRoot, 'artifact_ready', 'img_ready_001', {
    protocol: PROTOCOL,
    request_id: 'img_ready_001',
    created_at: '2026-05-31T09:00:00.000Z',
    status: 'artifact_ready',
    mode: 'generate',
    prompt: 'ready image',
    attempt: 1,
    idempotency_key: 'idem_ready_001',
    result: {
      generated_by: 'codex_builtin_image_gen',
      local_files: [],
      manual_save_required: true,
    },
  });

  await fs.mkdir(path.join(queueRoot, 'assets', 'nested'), { recursive: true });
  await fs.writeFile(path.join(queueRoot, 'assets', 'nested', 'img_ready_001.png'), 'png', 'utf8');

  const done = await queue.markSaved('img_ready_001', {
    local_files: [`${FIXED_ASSET_RETURN_DIR}/nested/img_ready_001.png`],
  });

  assert.equal(done.status, 'done');
  assert.equal(done.result.manual_save_required, false);
  assert.deepEqual(done.result.local_files, [
    `${FIXED_ASSET_RETURN_DIR}/nested/img_ready_001.png`,
  ]);
});

test('codex imagegen relay rejects path traversal, absolute paths, unsupported extensions, and symlink escapes', async (t) => {
  const { queue, queueRoot } = await createTempQueue(t);
  await fs.mkdir(path.join(queueRoot, 'assets'), { recursive: true });
  await fs.writeFile(path.join(queueRoot, 'assets', 'bad.txt'), 'text', 'utf8');

  await assert.rejects(
    () => queue.validateAssetFile('../escape.png'),
    (error) => error.code === 'unsafe_asset_path'
  );
  await assert.rejects(
    () => queue.validateAssetFile('A:\\outside\\image.png'),
    (error) => error.code === 'unsafe_asset_path'
  );
  await assert.rejects(
    () => queue.validateAssetFile('bad.txt'),
    (error) => error.code === 'unsupported_asset_extension'
  );

  const outside = path.join(queueRoot, '..', 'outside-image.png');
  await fs.writeFile(outside, 'png', 'utf8');
  const symlinkPath = path.join(queueRoot, 'assets', 'linked.png');
  try {
    await fs.symlink(outside, symlinkPath);
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      return;
    }
    throw error;
  }

  await assert.rejects(
    () => queue.validateAssetFile('linked.png'),
    (error) => error.code === 'unsafe_asset_symlink'
  );
});

test('codex imagegen relay fails only expired claimed requests', async (t) => {
  const { queue, queueRoot } = await createTempQueue(t, () => new Date('2026-05-31T10:00:00.000Z'));
  await writeStatusFile(queueRoot, 'claimed', 'img_claimed_001', {
    protocol: PROTOCOL,
    request_id: 'img_claimed_001',
    created_at: '2026-05-31T09:00:00.000Z',
    status: 'claimed',
    mode: 'generate',
    prompt: 'claimed image',
    attempt: 1,
    idempotency_key: 'idem_claimed_001',
    claimed_at: '2026-05-31T09:30:00.000Z',
    claim_expires_at: '2026-05-31T09:45:00.000Z',
  });
  await writeStatusFile(queueRoot, 'claimed', 'img_claimed_002', {
    protocol: PROTOCOL,
    request_id: 'img_claimed_002',
    created_at: '2026-05-31T09:00:00.000Z',
    status: 'claimed',
    mode: 'generate',
    prompt: 'fresh claimed image',
    attempt: 1,
    idempotency_key: 'idem_claimed_002',
    claimed_at: '2026-05-31T09:55:00.000Z',
    claim_expires_at: '2026-05-31T10:15:00.000Z',
  });

  const failed = await queue.failStaleClaim('img_claimed_001');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'STALE_CLAIM_EXPIRED');
  assert.equal(failed.error.retryable, true);

  await assert.rejects(
    () => queue.failStaleClaim('img_claimed_002'),
    (error) => error.code === 'claim_not_stale'
      && error.statusCode === 409
  );
});

