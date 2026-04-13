const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createMemoStore } = require('../memoStore');
const memoFormat = require('../memoFormat');

test('getById preserves createdAt from filename and uses mtime as updatedAt', async () => {
  const tempRootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-inbox-time-fields-'));
  const memoRootPath = path.join(tempRootPath, 'memos');
  const memoTrashPath = path.join(tempRootPath, 'trash');
  const memoImageRootPath = path.join(tempRootPath, 'images');
  const createdAt = '2026-04-12T10:00:00.000Z';
  const updatedAt = '2026-04-13T02:03:00.000Z';
  const memoId = 'memo_abcd1234';
  const filename = memoFormat.buildMemoFileName({ createdAt, memoId });
  const filePath = path.join(memoRootPath, filename);

  await fs.mkdir(memoRootPath, { recursive: true });
  await fs.mkdir(memoTrashPath, { recursive: true });
  await fs.mkdir(memoImageRootPath, { recursive: true });

  const rawMemo = memoFormat.formatMemoContent({
    createdAt,
    maidName: 'tester',
    content: 'time fields memo',
    metadata: { memoId, source: 'api' },
    tags: [],
  });

  await fs.writeFile(filePath, rawMemo, 'utf8');
  await fs.utimes(filePath, new Date(updatedAt), new Date(updatedAt));

  const store = createMemoStore({
    runtimeContext: {
      memoRootPath,
      memoTrashPath,
      memoImageRootPath,
      memoImageSubdir: 'memo-inbox',
      pluginManager: {
        processToolCall() {
          throw new Error('not implemented');
        },
      },
    },
    memoFormat,
  });

  try {
    const memo = await store.getById(memoId);
    const createdAtDate = new Date(memo.createdAt);

    assert.equal(createdAtDate.getFullYear(), 2026);
    assert.equal(createdAtDate.getMonth(), 3);
    assert.equal(createdAtDate.getDate(), 12);
    assert.equal(createdAtDate.getHours(), 10);
    assert.equal(createdAtDate.getMinutes(), 0);
    assert.equal(createdAtDate.getSeconds(), 0);
    assert.equal(memo.updatedAt, updatedAt);
  } finally {
    await fs.rm(tempRootPath, { recursive: true, force: true });
  }
});

test('getById keeps filename timestamp as local wall-clock time instead of shifting by timezone', async () => {
  const tempRootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-inbox-timezone-'));
  const memoRootPath = path.join(tempRootPath, 'memos');
  const memoTrashPath = path.join(tempRootPath, 'trash');
  const memoImageRootPath = path.join(tempRootPath, 'images');
  const memoId = 'memo_timezone01';
  const filename = '2026-04-13-10_36_33-memo_timezone01.txt';
  const filePath = path.join(memoRootPath, filename);

  await fs.mkdir(memoRootPath, { recursive: true });
  await fs.mkdir(memoTrashPath, { recursive: true });
  await fs.mkdir(memoImageRootPath, { recursive: true });

  await fs.writeFile(
    filePath,
    ['[2026-04-13] - MemoInbox', 'timezone memo', `Meta: memoId=${memoId}, source=api`].join('\n'),
    'utf8'
  );

  const store = createMemoStore({
    runtimeContext: {
      memoRootPath,
      memoTrashPath,
      memoImageRootPath,
      memoImageSubdir: 'memo-inbox',
      pluginManager: {
        processToolCall() {
          throw new Error('not implemented');
        },
      },
    },
    memoFormat,
  });

  try {
    const memo = await store.getById(memoId);
    const createdAtDate = new Date(memo.createdAt);

    assert.equal(createdAtDate.getFullYear(), 2026);
    assert.equal(createdAtDate.getMonth(), 3);
    assert.equal(createdAtDate.getDate(), 13);
    assert.equal(createdAtDate.getHours(), 10);
    assert.equal(createdAtDate.getMinutes(), 36);
    assert.equal(createdAtDate.getSeconds(), 33);
  } finally {
    await fs.rm(tempRootPath, { recursive: true, force: true });
  }
});
