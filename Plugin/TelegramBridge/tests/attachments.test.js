'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  AttachmentBridgeError,
  createAttachmentBridge,
  createMediaGroupCollector,
  hashScopeKey,
  selectMessageAttachments,
} = require('../src/attachmentBridge');
const { createSessionStore } = require('../src/sessionStore');

function assertAttachmentError(error, code, forbidden = []) {
  assert.equal(error instanceof AttachmentBridgeError, true);
  assert.equal(error.code, code);
  assert.deepEqual(Object.keys(error), ['code']);
  const serialized = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
  for (const value of forbidden) assert.equal(serialized.includes(value), false);
  return true;
}

function pngBytes(extra = 0) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(extra, 0x61),
  ]);
}

function fixture(t, overrides = {}) {
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-attachment-'));
  const stateDir = path.join(pluginRoot, 'state');
  const outputRoot = path.join(pluginRoot, 'output');
  fs.mkdirSync(outputRoot, { recursive: true });
  const session = createSessionStore({
    pluginRoot, stateDir, defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40, historyMaxBytes: 262144,
  });
  session.open();
  const scope = session.getOrCreateScope({ chatId: '42', threadId: '0' });
  const db = new Database(path.join(stateDir, 'telegram.sqlite3'));
  db.pragma('foreign_keys = ON');
  const calls = { getFile: [], sendDocument: [] };
  const bytesByPath = overrides.bytesByPath ?? new Map([
    ['documents/file.png', pngBytes(4)],
  ]);
  const telegramClient = {
    async getFile(fileId) {
      calls.getFile.push(fileId);
      if (overrides.getFileError) throw overrides.getFileError;
      return { file_id: fileId, file_path: overrides.filePath ?? 'documents/file.png' };
    },
    async sendDocument(params, blob, filename) {
      calls.sendDocument.push({ params, blob, filename });
      return { message_id: '500' };
    },
  };
  const downloadStream = overrides.downloadStream ?? (async function* download(filePath) {
    const bytes = bytesByPath.get(filePath);
    if (!bytes) throw new Error('download-url-token-secret');
    yield bytes.subarray(0, Math.ceil(bytes.length / 2));
    yield bytes.subarray(Math.ceil(bytes.length / 2));
  });
  const bridge = createAttachmentBridge({
    stateDir,
    database: db,
    telegramClient,
    downloadStream,
    maxInboundBytes: overrides.maxInboundBytes ?? 19 * 1024 * 1024,
    maxOutboundBytes: overrides.maxOutboundBytes ?? 45 * 1024 * 1024,
    allowedOutputRoots: overrides.allowedOutputRoots ?? [outputRoot],
    clock: (() => { let now = 1000; return () => now++; })(),
    randomUUID: (() => { let value = 0; return () => `attachment-${++value}`; })(),
  });
  t.after(() => {
    db.close();
    session.close();
    fs.rmSync(pluginRoot, { recursive: true, force: true });
  });
  return { bridge, calls, db, outputRoot, pluginRoot, scope, stateDir };
}

test('photo selection chooses the largest useful Telegram size and normalizes supported media descriptors', () => {
  const descriptors = selectMessageAttachments({
    photo: [
      { file_id: 'small', file_unique_id: 'u1', file_size: 100, width: 10, height: 10 },
      { file_id: 'large', file_unique_id: 'u2', file_size: 1000, width: 100, height: 100 },
    ],
    document: {
      file_id: 'doc', file_unique_id: 'ud', file_size: 20,
      file_name: 'report.txt', mime_type: 'text/plain',
    },
    voice: { file_id: 'voice', file_unique_id: 'uv', file_size: 30, mime_type: 'audio/ogg' },
    animation: { file_id: 'gif', file_unique_id: 'ug', file_size: 40, mime_type: 'image/gif' },
  });
  assert.deepEqual(descriptors.map((item) => item.fileId), ['large', 'doc', 'voice', 'gif']);
  assert.equal(descriptors[0].kind, 'photo');
  assert.equal(descriptors[1].fileName, 'report.txt');
});

test('declared and actual byte limits fail before persistence and respect the Telegram 20MB ceiling', async (t) => {
  assert.throws(
    () => createAttachmentBridge({
      stateDir: path.join(os.tmpdir(), 'x'), database: {}, telegramClient: {},
      downloadStream: async function* empty() {}, maxInboundBytes: 20_000_001,
      maxOutboundBytes: 1, allowedOutputRoots: [os.tmpdir()],
    }),
    (error) => assertAttachmentError(error, 'ATTACHMENT_CONFIG_INVALID'),
  );

  const declared = fixture(t, { maxInboundBytes: 10 });
  await assert.rejects(
    declared.bridge.ingestAttachment({
      scopeKey: declared.scope.key,
      descriptor: {
        kind: 'document', fileId: 'f', fileUniqueId: 'u', declaredSize: 11,
        fileName: 'x.png', mime: 'image/png',
      },
    }),
    (error) => assertAttachmentError(error, 'ATTACHMENT_DECLARED_TOO_LARGE'),
  );
  assert.equal(declared.calls.getFile.length, 0);

  const actual = fixture(t, {
    maxInboundBytes: 10,
    downloadStream: async function* oversized() { yield pngBytes(20); },
  });
  await assert.rejects(
    actual.bridge.ingestAttachment({
      scopeKey: actual.scope.key,
      descriptor: {
        kind: 'document', fileId: 'f', fileUniqueId: 'u', declaredSize: 8,
        fileName: 'x.png', mime: 'image/png',
      },
    }),
    (error) => assertAttachmentError(error, 'ATTACHMENT_STREAM_TOO_LARGE'),
  );
  assert.equal(actual.db.prepare('SELECT COUNT(*) AS count FROM attachments').get().count, 0);
});

test('ingestion sanitizes names, streams SHA-256 under a hashed scope and persists metadata', async (t) => {
  const { bridge, db, scope, stateDir } = fixture(t);
  const result = await bridge.ingestAttachment({
    scopeKey: scope.key,
    requestId: null,
    telegramMessageId: '77',
    descriptor: {
      kind: 'document', fileId: 'file-id', fileUniqueId: 'unique-id',
      declaredSize: 12, fileName: '..\\..\\evil\u202Egnp.exe', mime: 'image/png',
    },
  });
  assert.equal(result.attachmentId, 'attachment-1');
  assert.equal(result.scopeHash, hashScopeKey(scope.key));
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.size, 12);
  assert.equal(result.mime, 'image/png');
  assert.equal(path.relative(stateDir, result.absolutePath).startsWith('..'), false);
  assert.equal(result.absolutePath.includes('evil\u202E'), false);
  assert.equal(path.basename(result.absolutePath).startsWith('attachment-1-'), true);
  assert.deepEqual(fs.readFileSync(result.absolutePath), pngBytes(4));

  const row = db.prepare(`
    SELECT attachment_id, scope_key, telegram_file_id, telegram_file_unique_id,
      relative_path, mime, size, sha256, status FROM attachments
  `).get();
  assert.equal(row.attachment_id, 'attachment-1');
  assert.equal(row.scope_key, scope.key);
  assert.equal(row.telegram_file_id, 'file-id');
  assert.equal(row.status, 'ready');
  assert.equal(row.relative_path.includes('telegram:42'), false);
});

test('MIME mismatch and download/redirect failures remove partial files and sanitize errors', async (t) => {
  const mismatch = fixture(t, {
    bytesByPath: new Map([['documents/file.png', Buffer.from('%PDF-secret')]]),
  });
  await assert.rejects(
    mismatch.bridge.ingestAttachment({
      scopeKey: mismatch.scope.key,
      descriptor: {
        kind: 'document', fileId: 'f', fileUniqueId: 'u', declaredSize: 11,
        fileName: 'x.png', mime: 'image/png',
      },
    }),
    (error) => assertAttachmentError(error, 'ATTACHMENT_MIME_MISMATCH'),
  );

  const disguised = fixture(t, {
    bytesByPath: new Map([['documents/file.png', Buffer.from('MZ executable')]]),
  });
  await assert.rejects(
    disguised.bridge.ingestAttachment({
      scopeKey: disguised.scope.key,
      descriptor: {
        kind: 'document', fileId: 'f', fileUniqueId: 'u', declaredSize: 13,
        fileName: 'fake.png', mime: 'image/png',
      },
    }),
    (error) => assertAttachmentError(error, 'ATTACHMENT_MIME_MISMATCH'),
  );

  const redirectSecret = 'https://api.telegram.org/file/botSECRET/path';
  const failed = fixture(t, {
    downloadStream: async function* broken() { throw new Error(redirectSecret); },
  });
  await assert.rejects(
    failed.bridge.ingestAttachment({
      scopeKey: failed.scope.key,
      descriptor: {
        kind: 'document', fileId: 'f', fileUniqueId: 'u', declaredSize: 1,
        fileName: 'x.bin', mime: 'application/octet-stream',
      },
    }),
    (error) => assertAttachmentError(error, 'ATTACHMENT_DOWNLOAD_FAILED', [redirectSecret]),
  );
  assert.equal(failed.db.prepare('SELECT COUNT(*) AS count FROM attachments').get().count, 0);
});

test('physical inbox symlink escape is rejected without writing outside state', async (t) => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-escape-target-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const item = fixture(t);
  const scopeDir = path.join(item.stateDir, 'inbox', hashScopeKey(item.scope.key));
  fs.mkdirSync(path.dirname(scopeDir), { recursive: true });
  try {
    fs.symlinkSync(target, scopeDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`directory links unavailable: ${error.code}`);
    return;
  }
  await assert.rejects(
    item.bridge.ingestAttachment({
      scopeKey: item.scope.key,
      descriptor: {
        kind: 'document', fileId: 'f', fileUniqueId: 'u', declaredSize: 12,
        fileName: 'x.png', mime: 'image/png',
      },
    }),
    (error) => assertAttachmentError(error, 'ATTACHMENT_PATH_UNSAFE'),
  );
  assert.deepEqual(fs.readdirSync(target), []);
});

test('outbound upload accepts only regular files in allowed roots and rejects secrets, links and oversize', async (t) => {
  const item = fixture(t, { maxOutboundBytes: 16 });
  const allowed = path.join(item.outputRoot, 'result.txt');
  fs.writeFileSync(allowed, 'result');
  const sent = await item.bridge.uploadResult({
    chatId: '42', threadId: '0', filePath: allowed, caption: 'done',
  });
  assert.deepEqual(sent, { messageId: '500', fileName: 'result.txt', size: 6 });
  assert.equal(item.calls.sendDocument.length, 1);

  const outside = path.join(item.pluginRoot, 'outside.txt');
  fs.writeFileSync(outside, 'outside');
  await assert.rejects(
    item.bridge.uploadResult({ chatId: '42', threadId: '0', filePath: outside }),
    (error) => assertAttachmentError(error, 'ATTACHMENT_OUTPUT_ROOT_DENIED'),
  );
  const secret = path.join(item.outputRoot, 'config.env');
  fs.writeFileSync(secret, 'SECRET=x');
  await assert.rejects(
    item.bridge.uploadResult({ chatId: '42', threadId: '0', filePath: secret }),
    (error) => assertAttachmentError(error, 'ATTACHMENT_OUTPUT_SECRET_DENIED'),
  );
  const large = path.join(item.outputRoot, 'large.bin');
  fs.writeFileSync(large, Buffer.alloc(17));
  await assert.rejects(
    item.bridge.uploadResult({ chatId: '42', threadId: '0', filePath: large }),
    (error) => assertAttachmentError(error, 'ATTACHMENT_OUTPUT_TOO_LARGE'),
  );
  const link = path.join(item.outputRoot, 'link.txt');
  try {
    fs.symlinkSync(outside, link, 'file');
    await assert.rejects(
      item.bridge.uploadResult({ chatId: '42', threadId: '0', filePath: link }),
      (error) => assertAttachmentError(error, 'ATTACHMENT_OUTPUT_LINK_DENIED'),
    );
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
  }
});

test('media groups are ordered, bounded and submitted exactly once', async () => {
  const submissions = [];
  let now = 0;
  const sleeps = [];
  const collector = createMediaGroupCollector({
    maxItems: 3,
    settleMs: 50,
    clock: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      await new Promise((resolve) => setImmediate(resolve));
      now += ms;
    },
    onAlbum: async (messages) => { submissions.push(messages); return 'submitted'; },
  });
  const first = collector.add({ message_id: 3, media_group_id: 'group-1', photo: [{}] });
  const second = collector.add({ message_id: 1, media_group_id: 'group-1', photo: [{}] });
  const third = collector.add({ message_id: 2, media_group_id: 'group-1', photo: [{}] });
  assert.equal(await first, 'submitted');
  assert.equal(await second, 'submitted');
  assert.equal(await third, 'submitted');
  assert.equal(submissions.length, 1);
  assert.deepEqual(submissions[0].map((message) => message.message_id), [1, 2, 3]);
  assert.deepEqual(sleeps, [50]);
  assert.deepEqual(collector.snapshot(), { pendingGroups: 0, completedGroups: 1 });

  const overflow = [4, 5, 6].map((messageId) => collector.add({
    message_id: messageId, media_group_id: 'group-2', photo: [{}],
  }));
  await assert.rejects(
    collector.add({ message_id: 7, media_group_id: 'group-2', photo: [{}] }),
    (error) => assertAttachmentError(error, 'ATTACHMENT_ALBUM_LIMIT'),
  );
  await Promise.all(overflow);
});
